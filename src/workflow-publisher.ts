import { createHash } from "node:crypto";
import type { FleetStore } from "./fleet-store.js";
import type { GitHubBroker, GitHubRequest } from "./github-broker.js";
import type { WorkflowProject, WorkflowItem } from "./workflow-store.js";
import { WorkflowGitHub } from "./workflow-github.js";

type GraphQLError = { message?: string; path?: Array<string | number> };

/** Error text for a GraphQL response, naming the failing alias or field when GitHub reports one. */
export function graphqlErrorText(errors: GraphQLError[]): string {
  const text = errors
    .map(
      (e) =>
        (e.path?.length ? `${e.path.join(".")}: ` : "") +
        String(e.message ?? "unknown error"),
    )
    .join("; ");
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

const RETRY_BASE_MS = 30_000,
  RETRY_MAX_MS = 15 * 60_000;

/** One publisher per authority. Failed/uncertain writes leave the database revision pending. */
export class WorkflowPublisher {
  private running: Promise<void> | undefined;
  private refreshed = 0;
  private readonly compatibility: WorkflowGitHub;
  /** Tickets whose display write failed. They stay pending and wait so they cannot hold the queue. */
  private readonly retry = new Map<
    string,
    { revision: number; attempts: number; until: number }
  >();
  private readonly now: () => number;
  constructor(
    private readonly store: FleetStore,
    private readonly github: GitHubBroker,
    options: { now?: () => number } = {},
  ) {
    this.compatibility = new WorkflowGitHub(store, github);
    this.now = options.now ?? Date.now;
  }
  /** Tickets currently waiting after a failed display write, for status and tests. */
  retrying(): Array<{
    ticket: string;
    revision: number;
    attempts: number;
    until: number;
  }> {
    return [...this.retry].map(([ticket, r]) => ({ ticket, ...r }));
  }
  tick(): Promise<void> {
    return (this.running ??= this.publish().finally(() => {
      this.running = undefined;
    }));
  }
  private async call(project: string, request: GitHubRequest): Promise<any> {
    const result = await this.github.request(project, request);
    if (result.status < 200 || result.status >= 300)
      throw new Error(
        `Workflow display update deferred: GitHub ${result.status}`,
      );
    const payload = JSON.parse(result.body || "null");
    if (payload?.errors?.length)
      throw new Error(
        `Workflow display update incomplete: ${graphqlErrorText(payload.errors)}`,
      );
    return payload;
  }
  private async gql(project: string, query: string, variables: unknown) {
    return this.call(project, {
      method: "POST",
      path: "/graphql",
      body: JSON.stringify({ query, variables }),
      fresh: true,
    });
  }
  /** Like gql, but returns a response carrying GraphQL errors so each alias can be judged on its own. */
  private async gqlPartial(project: string, query: string): Promise<any> {
    const result = await this.github.request(project, {
      method: "POST",
      path: "/graphql",
      body: JSON.stringify({ query, variables: {} }),
      fresh: true,
    });
    if (result.status < 200 || result.status >= 300)
      throw new Error(
        `Workflow display update deferred: GitHub ${result.status}`,
      );
    return JSON.parse(result.body || "null") ?? {};
  }
  private waiting(ticket: string, revision: number): boolean {
    const r = this.retry.get(ticket);
    if (!r) return false;
    // A newer database revision may already resolve the failure, so it is tried at once.
    if (r.revision !== revision) return false;
    return this.now() < r.until;
  }
  private failed(ticket: string, revision: number, error: unknown): Error {
    const previous = this.retry.get(ticket),
      attempts = (previous?.attempts ?? 0) + 1,
      delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
    this.retry.set(ticket, { revision, attempts, until: this.now() + delay });
    const message = error instanceof Error ? error.message : String(error);
    return new Error(
      `Workflow display update failed for ${ticket} revision ${revision} (attempt ${attempts}, retry in ${Math.round(delay / 1000)}s): ${message}`,
    );
  }
  private async publish(): Promise<void> {
    const configs = this.store.workflow
      .projects()
      .filter((config) => !this.store.workflow.preparing(config.project));
    if (!configs.length) return;
    const errors: unknown[] = [];
    // Rebuild these display facts from existing authority records.
    const state = this.store.snapshot(),
      escalated = new Set(this.store.recovery.escalatedTickets());
    for (const config of configs)
      for (const item of this.store.workflow.list(config.project)) {
        const ticket = `${config.project}#${item.issueNumber}`,
          claim = state.claims.find((c) => c.ticket === ticket);
        const wanted = [
          ...(claim ? [`claim:${claim.machine}`] : []),
          ...(escalated.has(ticket) ? ["orchestrator:escalated"] : []),
        ];
        const actual = item.labels.filter(
          (l) => l.startsWith("claim:") || l === "orchestrator:escalated",
        );
        if (JSON.stringify(actual.sort()) !== JSON.stringify(wanted.sort()))
          this.store.workflow.change(
            ticket,
            { removeLabels: actual, addLabels: wanted },
            "authority",
            `claims:${ticket}:${item.revision}`,
          );
      }
    for (const config of configs) {
      if (this.store.workflow.preparing(config.project)) continue;
      try {
        await this.publishProject(config, errors);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const comment of this.store.workflow.pendingComments()) {
      if (this.store.workflow.preparing(comment.ticket.split("#")[0])) continue;
      try {
        const [project, number] = comment.ticket.split("#"),
          marker = `<!-- orchestrator-comment:${comment.id} -->`;
        // Resolve an uncertain previous POST before retrying. Search all pages, not just the first.
        let exists = false;
        for (let page = 1; ; page++) {
          const comments = await this.call(project, {
            method: "GET",
            path: `/repos/${project}/issues/${number}/comments?per_page=100&page=${page}`,
            fresh: true,
          });
          if (comments.some((c: any) => c.body?.includes(marker))) {
            exists = true;
            break;
          }
          if (comments.length < 100) break;
          if (page >= 100)
            throw new Error("Cannot establish comment publication history");
        }
        if (!exists)
          await this.call(project, {
            method: "POST",
            path: `/repos/${project}/issues/${number}/comments`,
            body: JSON.stringify({ body: comment.body + "\n\n" + marker }),
          });
        this.store.workflow.commentPublished(comment.id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.now() - this.refreshed > 300_000) {
      let complete = true;
      for (const config of configs)
        try {
          await this.refresh(config);
        } catch (error) {
          errors.push(error);
          complete = false;
        }
      if (complete) this.refreshed = this.now();
    }
    if (errors.length) {
      const messages = [
        ...new Set(
          errors.map((e) => (e instanceof Error ? e.message : String(e))),
        ),
      ];
      throw new Error(messages.join("\n"));
    }
  }
  /** Publish up to ten pending tickets. Each ticket is acknowledged or retried on its own. */
  private async publishProject(
    config: WorkflowProject,
    errors: unknown[],
  ): Promise<void> {
    const project = config.project;
    // Read past waiting tickets so they cannot fill the batch and starve the rest.
    const held = [...this.retry.keys()].filter((t) =>
      t.startsWith(`${project}#`),
    ).length;
    const pending = this.store.workflow
      .pending(10 + held, project)
      .filter(({ ticket, item }) => !this.waiting(ticket, item.revision))
      .slice(0, 10);
    if (!pending.length) return;
    let labels = await this.compatibility.labels(project, true);
    for (const name of new Set(pending.flatMap((p) => p.item.labels)))
      if (!labels.some((l) => l.name === name)) {
        await this.call(project, {
          method: "POST",
          path: `/repos/${project}/labels`,
          body: JSON.stringify({ name, color: "ededed" }),
        });
        labels = await this.compatibility.labels(project, true);
      }
    const mutations = pending.flatMap(({ item }, i) => [
      `i${i}:updateIssue(input:{id:${JSON.stringify(item.issueId)},state:${item.state},labelIds:${JSON.stringify(item.labels.map((n) => labels.find((l) => l.name === n)!.node_id))}}){issue{id}}`,
      ...(!item.archived
        ? [
            `s${i}:updateProjectV2ItemFieldValue(input:{projectId:${JSON.stringify(config.projectId)},itemId:${JSON.stringify(item.id)},fieldId:${JSON.stringify(config.statusFieldId)},value:{singleSelectOptionId:${JSON.stringify(config.options[item.status])}}}){projectV2Item{id}}`,
          ]
        : []),
    ]);
    // GitHub runs each aliased mutation on its own. Setting the same desired values again is safe.
    const result = await this.gqlPartial(
      project,
      `mutation {${mutations.join("\n")}}`,
    );
    const responseErrors: GraphQLError[] = result.errors ?? [];
    const alias = (e: GraphQLError) =>
      /^[is](\d+)$/.exec(String(e.path?.[0] ?? ""))?.[1];
    // An error GitHub does not tie to one alias may concern any ticket, so the whole batch waits.
    const unattributed = responseErrors.filter((e) => alias(e) === undefined);
    if (unattributed.length)
      throw new Error(
        `Workflow display update incomplete: ${graphqlErrorText(unattributed)}`,
      );
    for (const [index, { ticket, item }] of pending.entries()) {
      try {
        const own = responseErrors.filter((e) => alias(e) === String(index));
        if (own.length)
          throw new Error(
            `Workflow display update incomplete: ${graphqlErrorText(own)}`,
          );
        if (
          result.data?.[`i${index}`]?.issue?.id !== item.issueId ||
          (!item.archived &&
            result.data?.[`s${index}`]?.projectV2Item?.id !== item.id)
        )
          throw new Error("Workflow display acknowledgement missing");
        if (!item.archived && (item.positioned || item.position < 0)) {
          const ordered = this.store.workflow.list(project),
            position = ordered.findIndex((i) => i.id === item.id);
          await this.gql(
            project,
            "mutation($input:UpdateProjectV2ItemPositionInput!){updateProjectV2ItemPosition(input:$input){items(first:1){nodes{id}}}}",
            {
              input: {
                projectId: config.projectId,
                itemId: item.id,
                afterId: position > 0 ? ordered[position - 1].id : null,
              },
            },
          );
        }
        await this.publishBlockers(config, item);
        this.store.workflow.published(ticket, item.revision);
        this.retry.delete(ticket);
      } catch (error) {
        errors.push(this.failed(ticket, item.revision, error));
      }
    }
  }
  private async publishBlockers(config: WorkflowProject, item: WorkflowItem) {
    const result = await this.gql(
      config.project,
      "query($id:ID!){node(id:$id){... on Issue{blockedBy(first:100){nodes{id number url} pageInfo{hasNextPage}}}}}",
      { id: item.issueId },
    );
    const blockers = result.data?.node?.blockedBy;
    if (!blockers || blockers.pageInfo.hasNextPage)
      throw new Error("Incomplete dependency display read");
    const desired = await Promise.all(
      item.blockedBy.map(async (b) => {
        const project =
          b.url?.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] ??
          config.project;
        const known = this.store.workflow
          .list(project)
          .find((i) => i.issueNumber === b.number);
        if (known) return known;
        const [owner, repo] = project.split("/");
        const result = await this.gql(
          config.project,
          "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){id}}}",
          { owner, repo, number: b.number },
        );
        if (!result.data?.repository?.issue?.id)
          throw new Error("Dependency identity unavailable");
        return { issueId: result.data.repository.issue.id };
      }),
    );
    for (const b of blockers.nodes)
      if (!desired.some((d) => d.issueId === b.id))
        await this.gql(
          config.project,
          "mutation($issue:ID!,$blocker:ID!){removeBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{id}}}",
          { issue: item.issueId, blocker: b.id },
        );
    for (const b of desired)
      if (!blockers.nodes.some((n: any) => n.id === b.issueId))
        await this.addBlocker(config, item, b);
  }
  private async addBlocker(
    config: WorkflowProject,
    item: WorkflowItem,
    blocker: {
      issueId: string;
      url?: string;
      blockedBy?: WorkflowItem["blockedBy"];
    },
  ): Promise<void> {
    const repo = (u: string | undefined, fallback: string) =>
      u?.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] ?? fallback;
    const add = () =>
      this.gql(
        config.project,
        "mutation($issue:ID!,$blocker:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{id}}}",
        { issue: item.issueId, blocker: blocker.issueId },
      );
    try {
      await add();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Another writer linked it between the read and this write. The display already matches.
      if (/has already been taken/i.test(message)) return;
      if (!/would create a cycle/i.test(message)) throw error;
      // GitHub still shows the reverse link. Remove it only when the blocker's own
      // database record does not want it, then add the wanted direction. A blocker
      // outside the database is not ours to change.
      const blockerProject = repo(blocker.url, config.project);
      const reverseWanted =
        !blocker.blockedBy ||
        blocker.blockedBy.some(
          (b) =>
            b.number === item.issueNumber &&
            repo(b.url, blockerProject) === config.project,
        );
      if (reverseWanted)
        throw new Error(
          `Dependency cycle: ${config.project}#${item.issueNumber} and its blocker are recorded as blocking each other (${message})`,
        );
      await this.gql(
        config.project,
        "mutation($issue:ID!,$blocker:ID!){removeBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{id}}}",
        { issue: blocker.issueId, blocker: item.issueId },
      );
      await add();
    }
  }
  /** Read content and discover issues. Existing workflow fields are only compared, never adopted. */
  async refresh(config: WorkflowProject): Promise<void> {
    if (this.store.workflow.preparing(config.project)) return;
    const fields = `id number title body url state comments(last:8){nodes{id updatedAt body}} parent{number parent{number}} subIssuesSummary{total completed} blockedBy(first:100){nodes{number state url} pageInfo{hasNextPage}} labels(first:100){nodes{name} pageInfo{hasNextPage}} projectItems(first:100){nodes{id isArchived project{id} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}} pageInfo{hasNextPage}}`;
    const known = this.store.workflow.list(config.project);
    // Read known tickets by identity, including any a person closed in GitHub.
    for (let start = 0; start < known.length; start += 50) {
      if (this.store.workflow.preparing(config.project)) return;
      const ids = known.slice(start, start + 50).map((i) => i.issueId);
      const result = await this.gql(
        config.project,
        `query($ids:[ID!]!){nodes(ids:$ids){... on Issue{${fields}}}}`,
        { ids },
      );
      const nodes = result.data?.nodes;
      if (
        !nodes ||
        nodes.length !== ids.length ||
        nodes.some((n: any) => !n?.id)
      )
        throw new Error("Incomplete known-ticket content read");
      await this.observeIssues(config, nodes);
    }
    // Discovery only scans open issues, never the repository's full archive.
    const [owner, repo] = config.project.split("/");
    let cursor: string | null = null;
    do {
      if (this.store.workflow.preparing(config.project)) return;
      const result = await this.gql(
        config.project,
        `query($owner:String!,$repo:String!,$cursor:String){repository(owner:$owner,name:$repo){issues(states:OPEN,first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${fields}}pageInfo{hasNextPage endCursor}}}}`,
        { owner, repo, cursor },
      );
      const connection = result.data?.repository?.issues;
      if (!connection) throw new Error("Incomplete workflow source read");
      await this.observeIssues(
        config,
        connection.nodes.filter((i: any) => !this.store.workflow.find(i.id)),
      );
      cursor = connection.pageInfo.hasNextPage
        ? connection.pageInfo.endCursor
        : null;
    } while (cursor);
  }
  private async observeIssues(
    config: WorkflowProject,
    issues: any[],
  ): Promise<void> {
    const observations: WorkflowItem[] = [];
    for (const issue of issues) {
      if (
        issue.labels.pageInfo.hasNextPage ||
        issue.projectItems.pageInfo.hasNextPage ||
        issue.blockedBy.pageInfo.hasNextPage
      )
        throw new Error("Incomplete issue metadata");
      let board = issue.projectItems.nodes.find(
        (p: any) => p.project.id === config.projectId,
      );
      const known = this.store.workflow.find(issue.id);
      if (!known && issue.state === "CLOSED") continue;
      if (!board) {
        const added = await this.gql(
          config.project,
          "mutation($project:ID!,$issue:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$issue}){item{id}}}",
          { project: config.projectId, issue: issue.id },
        );
        board = { id: added.data.addProjectV2ItemById.item.id };
      }
      const evidenceRevision = createHash("sha256")
        .update(
          JSON.stringify([
            issue.body,
            (issue.comments?.nodes ?? [])
              .filter(
                (c: any) =>
                  !/^(<!-- (?:fleet-recovery|family-dispatch|stranded-wip|auto-retry)|## Orchestrator recovery)/.test(
                    c.body ?? "",
                  ),
              )
              .map((c: any) => [c.id, c.updatedAt]),
          ]),
        )
        .digest("hex");
      observations.push({
        ...known?.item,
        evidenceRevision,
        id: board.id,
        archived: board.isArchived === true ? true : undefined,
        issueId: issue.id,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        url: issue.url,
        state: issue.state,
        status: board.fieldValueByName?.name ?? "Inbox",
        labels: issue.labels.nodes.map((l: any) => l.name),
        blockedBy: issue.blockedBy.nodes,
        parentNumber: issue.parent?.number ?? null,
        grandparentNumber: issue.parent?.parent?.number ?? null,
        subIssues: issue.subIssuesSummary,
        position: 0,
        revision: 1,
      });
    }
    this.store.workflow.observe(config.project, observations);
  }
}
