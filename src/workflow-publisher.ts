import { createHash } from "node:crypto";
import type { FleetStore } from "./fleet-store.js";
import type { GitHubBroker, GitHubRequest } from "./github-broker.js";
import type { WorkflowProject, WorkflowItem } from "./workflow-store.js";
import { WorkflowGitHub } from "./workflow-github.js";

/** One publisher per authority. Failed/uncertain writes leave the database revision pending. */
export class WorkflowPublisher {
  private running: Promise<void> | undefined;
  private refreshed = 0;
  private readonly compatibility: WorkflowGitHub;
  constructor(
    private readonly store: FleetStore,
    private readonly github: GitHubBroker,
  ) {
    this.compatibility = new WorkflowGitHub(store, github);
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
      throw new Error("Workflow display update incomplete");
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
  private async publish(): Promise<void> {
    const configs = this.store.workflow.projects();
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
      try {
        const pending = this.store.workflow.pending(10, config.project);
        if (!pending.length) continue;
        let labels = await this.compatibility.labels(config.project, true);
        for (const name of new Set(pending.flatMap((p) => p.item.labels)))
          if (!labels.some((l) => l.name === name)) {
            await this.call(config.project, {
              method: "POST",
              path: `/repos/${config.project}/labels`,
              body: JSON.stringify({ name, color: "ededed" }),
            });
            labels = await this.compatibility.labels(config.project, true);
          }
        const mutations = pending.flatMap(({ item }, i) => [
          `i${i}:updateIssue(input:{id:${JSON.stringify(item.issueId)},state:${item.state},labelIds:${JSON.stringify(item.labels.map((n) => labels.find((l) => l.name === n)!.node_id))}}){issue{id}}`,
          `s${i}:updateProjectV2ItemFieldValue(input:{projectId:${JSON.stringify(config.projectId)},itemId:${JSON.stringify(item.id)},fieldId:${JSON.stringify(config.statusFieldId)},value:{singleSelectOptionId:${JSON.stringify(config.options[item.status])}}}){projectV2Item{id}}`,
        ]);
        // A partial GraphQL response acknowledges nothing. Setting the same desired values again is safe.
        const result = await this.gql(
          config.project,
          `mutation {${mutations.join("\n")}}`,
          {},
        );
        for (const [index, { ticket, item }] of pending.entries()) {
          if (
            result.data?.[`i${index}`]?.issue?.id !== item.issueId ||
            result.data?.[`s${index}`]?.projectV2Item?.id !== item.id
          )
            throw new Error("Workflow display acknowledgement missing");
          if (item.positioned || item.position < 0) {
            const ordered = this.store.workflow.list(config.project),
              position = ordered.findIndex((i) => i.id === item.id);
            await this.gql(
              config.project,
              "mutation($input:UpdateProjectV2ItemPositionInput!){updateProjectV2ItemPosition(input:$input){items{nodes{id}}}}",
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
        }
      } catch (error) {
        errors.push(error);
      }
    }
    for (const comment of this.store.workflow.pendingComments()) {
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
    if (Date.now() - this.refreshed > 300_000) {
      let complete = true;
      for (const config of configs)
        try {
          await this.refresh(config);
        } catch (error) {
          errors.push(error);
          complete = false;
        }
      if (complete) this.refreshed = Date.now();
    }
    if (errors.length) throw errors[0];
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
        await this.gql(
          config.project,
          "mutation($issue:ID!,$blocker:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{id}}}",
          { issue: item.issueId, blocker: b.issueId },
        );
  }
  /** Read content and discover issues. Existing workflow fields are only compared, never adopted. */
  async refresh(config: WorkflowProject): Promise<void> {
    const [owner, repo] = config.project.split("/");
    let cursor: string | null = null;
    do {
      const result = await this.gql(
        config.project,
        `query($owner:String!,$repo:String!,$cursor:String){repository(owner:$owner,name:$repo){issues(first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{id number title body url state comments(last:8){nodes{id updatedAt body}} parent{number parent{number}} subIssuesSummary{total completed} blockedBy(first:100){nodes{number state url} pageInfo{hasNextPage}} labels(first:100){nodes{name} pageInfo{hasNextPage}} projectItems(first:100){nodes{id project{id} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}} pageInfo{hasNextPage}}}pageInfo{hasNextPage endCursor}}}}`,
        { owner, repo, cursor },
      );
      const connection = result.data?.repository?.issues;
      if (!connection) throw new Error("Incomplete workflow source read");
      const observations: WorkflowItem[] = [];
      for (const issue of connection.nodes) {
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
        if (!board && !known && issue.state === "CLOSED") continue;
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
      cursor = connection.pageInfo.hasNextPage
        ? connection.pageInfo.endCursor
        : null;
    } while (cursor);
  }
}
