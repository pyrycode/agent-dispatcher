import {guardPinnedPublication} from './verifier-handoff-publication.js';
import { renderRecoverySlice } from "./recovery-split.js";
import { planningSplitRequest, type PlanningActor } from './planning-split.js';
import { requiredRepairDeclaration, type RepairActor } from './required-repair-children.js';
import type { EvidenceStore } from "./evidence-store.js";
import {
  parse,
  print,
  Kind,
  valueFromASTUntyped,
  type FieldNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type OperationDefinitionNode,
} from "graphql";
import { randomUUID } from "node:crypto";
import { OwnershipRefusal, type FleetStore } from "./fleet-store.js";
import type {
  GitHubBroker,
  GitHubRequest,
  GitHubResponse,
} from "./github-broker.js";
import type {
  WorkflowItem,
  WorkflowChange,
  WorkflowProject,
  FiledTicket,
} from "./workflow-store.js";

type Actor = { machine: string; session: string; runId?: string };
type FilingRequest = {
  commandId: string;
  title: string;
  body: string;
  labels: string[];
  workflow: { stage: string; labels: string[]; blockedBy: number[] };
};
// The prefixes discovery strips from a new issue. They are workflow state, not content.
const WORKFLOW_LABEL = /^(wip:|done:|error:|needs-rework:|claim:|orchestrator:)/;
const response = (value: unknown): GitHubResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

// Interfaces each synthetic object type implements, for fragment type conditions.
const IMPLEMENTS: Record<string, readonly string[]> = {
  Issue: ["Node", "Labelable", "Closable", "Assignable", "Comment", "Deletable", "Lockable", "Reactable", "RepositoryNode", "Subscribable", "SubscribableThread", "UniformResourceLocatable", "Updatable", "UpdatableComment", "ProjectV2Owner"],
  IssueComment: ["Node", "Comment", "Deletable", "Minimizable", "Reactable", "RepositoryNode", "Updatable", "UpdatableComment", "UniformResourceLocatable"],
  ProjectV2Item: ["Node"],
};
function collectFields(
  value: Record<string, unknown>,
  set: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  fields = new Map<string, FieldNode[]>(),
): Map<string, FieldNode[]> {
  const applies = (type?: string) => {
    const actual = value.__typename;
    return !type || typeof actual !== "string" || actual === type || (IMPLEMENTS[actual] ?? []).includes(type);
  };
  for (const selection of set.selections) {
    if (selection.kind === Kind.FIELD) {
      const key = selection.alias?.value ?? selection.name.value;
      fields.set(key, [...(fields.get(key) ?? []), selection]);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      if (applies(selection.typeCondition?.name.value))
        collectFields(value, selection.selectionSet, fragments, fields);
    } else {
      const fragment = fragments.get(selection.name.value);
      if (fragment && applies(fragment.typeCondition.name.value))
        collectFields(value, fragment.selectionSet, fragments, fields);
    }
  }
  return fields;
}
/**
 * Return only what the caller selected, as GitHub would. gh decodes GraphQL
 * strictly: one unrequested field fails the command after the write was saved.
 */
export function selectResponse(
  value: unknown,
  set: SelectionSetNode | undefined,
  fragments: ReadonlyMap<string, FragmentDefinitionNode> = new Map(),
): unknown {
  if (value === undefined || value === null) return null;
  if (!set) return value;
  if (Array.isArray(value)) return value.map((v) => selectResponse(v, set, fragments));
  if (typeof value !== "object") return null;
  const object = value as Record<string, unknown>,
    output: Record<string, unknown> = {};
  for (const [key, nodes] of collectFields(object, set, fragments)) {
    const name = nodes[0].name.value,
      selections = nodes.flatMap((n) => n.selectionSet?.selections ?? []);
    output[key] = selectResponse(
      name === "__typename" ? (object.__typename ?? null) : object[name],
      selections.length ? { kind: Kind.SELECTION_SET, selections } : undefined,
      fragments,
    );
  }
  return output;
}
const payloadType = (field: string) =>
  field[0].toUpperCase() + field.slice(1) + "Payload";

/** Compatibility at the existing GitHub bridge. Workflow writes commit only to SQLite. */
export class WorkflowGitHub {
  private catalog = new Map<
    string,
    Array<{ id: number; node_id: string; name: string }>
  >();
  constructor(
    private readonly store: FleetStore,
    private readonly upstream: GitHubBroker,
  ) {}
  async labels(project: string, refresh = false) {
    if (!refresh && this.catalog.has(project))
      return this.catalog.get(project)!;
    const all: Array<{ id: number; node_id: string; name: string }> = [];
    for (let page = 1; ; page++) {
      const result = await this.upstream.request(project, {
        method: "GET",
        path: `/repos/${project}/labels?per_page=100&page=${page}`,
        fresh: refresh,
      });
      if (result.status !== 200)
        throw new Error("Cannot resolve workflow label names");
      const rows = JSON.parse(result.body);
      if (!Array.isArray(rows)) throw new Error("Invalid label catalogue");
      all.push(...rows);
      if (rows.length < 100) break;
    }
    this.catalog.set(project, all);
    return all;
  }
  private async names(project: string, ids: string[]) {
    if (!Array.isArray(ids)) throw new Error("Label IDs required");
    let labels = await this.labels(project);
    if (ids.some((id) => !labels.some((l) => l.node_id === id)))
      labels = await this.labels(project, true);
    return ids.map((id) => {
      const l = labels.find((l) => l.node_id === id);
      if (!l) throw new Error("Unknown label ID");
      return l.name;
    });
  }
  private mutate(
    project: string,
    ticket: string,
    change: WorkflowChange,
    actor?: Actor,
  ) {
    if (ticket.split("#")[0] !== project || !actor)
      throw new OwnershipRefusal("Workflow changes require the owning run identity");
    return this.store.workflowChange(
      actor.machine,
      actor.session,
      actor.runId,
      ticket,
      change,
      randomUUID(),
    );
  }
  /**
   * A ticket a run creates, such as a refiner's split child, is not admitted
   * until that run finishes. Recorded before adoption, so a failed board
   * registration cannot release the hold early.
   */
  private recordCreator(actor: Actor | undefined, issueId: unknown) {
    if (actor && typeof issueId === "string")
      this.store.recordTicketCreator(
        actor.machine,
        actor.session,
        actor.runId,
        issueId,
      );
  }
  private node(
    item: WorkflowItem,
    labels: Array<{ node_id: string; name: string }>,
  ) {
    return {
      id: item.issueId,
      number: item.issueNumber,
      title: item.title,
      body: item.body,
      url: item.url,
      state: item.state,
      labels: {
        nodes: item.labels.map((name) => ({
          id: labels.find((l) => l.name === name)?.node_id,
          name,
        })),
        totalCount: item.labels.length,
        pageInfo: { hasNextPage: false },
      },
    };
  }
  async request(
    project: string,
    request: GitHubRequest,
    actor?: Actor,
  ): Promise<GitHubResponse> {
    const repairs = request.path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/required-repairs$/);
    if (repairs) {
      if (!this.store.workflow.enabled(project) || repairs[1] !== project || !actor?.runId)
        throw new OwnershipRefusal('Required repairs require this project authority and an admitted planning run');
      if (!['GET', 'POST'].includes(request.method)) throw new OwnershipRefusal('Required repairs support inspection and declaration');
      return response(await this.requiredRepairs(actor as PlanningActor, `${project}#${repairs[2]}`,
        request.method === 'POST' ? JSON.parse(request.body ?? '{}') : undefined));
    }
    const split = request.path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/split$/);
    if (split && (!this.store.workflow.enabled(project) || split[1] !== project))
      throw new OwnershipRefusal('Split finalization requires this project\'s workflow authority');
    if (!this.store.workflow.enabled(project))
      return this.upstream.request(project, request);
    const path = request.path.split("?")[0],
      body = JSON.parse(request.body ?? "{}");
    const mutating=request.method!=='GET' && (path!=='/graphql' || /\bmutation\b/.test(String(body.query??'')));
    if(mutating && actor?.runId) {
      const run=this.store.snapshot().runs.find(r=>r.id===actor.runId && r.machine===actor.machine && r.session===actor.session);
      if(run)await guardPinnedPublication(this.store,this.upstream,run.ticket);
    }
    if (split) {
      if (!actor?.runId) throw new OwnershipRefusal('Split requires an admitted planning run');
      const planner = actor as PlanningActor, ticket = `${project}#${split[2]}`;
      if (request.method === 'POST') {
        const input = planningSplitRequest(body), saved = this.store.planningSplits.result(planner, ticket, input);
        if (saved) return response(saved);
        await this.refreshPlanningSplit(planner, ticket);
        return response(this.store.finalizePlanningSplit(planner, ticket, input));
      }
      if (request.method !== 'GET') throw new Error('Split supports only inspection and finalization');
      await this.refreshPlanningSplit(planner, ticket);
      const inventory = this.store.planningSplits.inspect(ticket);
      return response({ revision: inventory.parent.revision,
        children: inventory.children.map(c => ({ number: c.issueNumber, revision: c.revision, dependsOn: [] })),
        dependents: inventory.dependents.map(d => ({ ticket: d.ticket, revision: d.item.revision, children: [] })) });
    }
    const match = path.match(
      /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/(labels|comments)(?:\/(.*))?)?$/,
    );
    if (
      request.method === "GET" &&
      match &&
      match[1] !== project &&
      this.store.workflow.enabled(match[1])
    )
      return this.request(match[1], request);
    if (match && match[1] !== project && match[3] === "comments" && request.method === "POST" && this.store.workflow.enabled(match[1])) {
      if (!actor) throw new OwnershipRefusal("Split handoff comment requires a run");
      const ticket = `${match[1]}#${match[2]}`, id = randomUUID();
      this.store.workflowSplitComment(actor.machine, actor.session, actor.runId, project, ticket, body.body, id);
      return response({ id, node_id: id, body: body.body, html_url: this.store.workflow.get(ticket).url, created_at: new Date().toISOString() });
    }
    if (match && match[1] === project) {
      const ticket = `${project}#${match[2]}`;
      let item = this.store.workflow
        .list(project)
        .find((i) => i.issueNumber === Number(match[2]));
      if (!item) {
        const remote = JSON.parse(
          (
            await this.checked(project, {
              method: "GET",
              path: `/repos/${project}/issues/${match[2]}`,
            })
          ).body,
        );
        if (remote.pull_request) return this.upstream.request(project, request);
        await this.adoptIssue(project, remote.node_id);
        item = this.store.workflow.get(ticket);
      }
      if (match[3] === "labels") {
        if (request.method === "POST")
          this.mutate(
            project,
            ticket,
            { addLabels: Array.isArray(body) ? body : body.labels },
            actor,
          );
        else if (request.method === "PUT")
          this.mutate(
            project,
            ticket,
            { labels: Array.isArray(body) ? body : body.labels },
            actor,
          );
        else if (request.method === "DELETE")
          this.mutate(
            project,
            ticket,
            {
              removeLabels: match[4]
                ? [decodeURIComponent(match[4])]
                : item.labels,
            },
            actor,
          );
        else if (request.method !== "GET")
          throw new Error("Unsupported workflow label operation");
        const labels =
          request.method === "GET"
            ? await this.labels(project)
            : (this.catalog.get(project) ?? []);
        return response(
          this.store.workflow
            .get(ticket)
            .labels.map(
              (name) => labels.find((l) => l.name === name) ?? { name },
            ),
        );
      }
      if (match[3] === "comments" && request.method === "POST") {
        if (!actor) throw new Error("Workflow comment requires a run");
        const id = randomUUID();
        this.store.workflowComment(
          actor.machine,
          actor.session,
          actor.runId,
          ticket,
          body.body,
          id,
        );
        return response({
          id,
          node_id: id,
          body: body.body,
          html_url: item.url,
          created_at: new Date().toISOString(),
        });
      }
      if (match[3] === "comments" && request.method === "GET") {
        const result = await this.checked(project, request),
          rows = JSON.parse(result.body);
        if (!result.headers.link?.includes('rel="next"'))
          for (const c of this.store.workflow.unpublishedComments(ticket))
            if (
              !rows.some((r: any) =>
                r.body?.includes(`<!-- orchestrator-comment:${c.id} -->`),
              )
            )
              rows.push(c);
        return { ...result, body: JSON.stringify(rows) };
      }
      if (!match[3] && request.method === "GET") {
        const result = await this.checked(project, request),
          value = JSON.parse(result.body);
        return response({
          ...value,
          state: item.state.toLowerCase(),
          labels: item.labels.map((name) => ({ name })),
        });
      }
      if (
        !match[3] &&
        request.method === "PATCH" &&
        body.labels === undefined &&
        body.state === undefined
      ) {
        const result = await this.checked(project, request);
        await this.adoptIssue(project, item.issueId);
        return result;
      }
      if (
        !match[3] &&
        request.method === "PATCH" &&
        (body.labels !== undefined || body.state !== undefined)
      ) {
        const { labels, state, ...content } = body;
        if (Object.keys(content).length)
          await this.checked(project, {
            ...request,
            body: JSON.stringify(content),
          });
        this.mutate(
          project,
          ticket,
          {
            ...(labels ? { labels } : {}),
            ...(state
              ? { state: String(state).toUpperCase() as "OPEN" | "CLOSED" }
              : {}),
          },
          actor,
        );
        const current = this.store.workflow.get(ticket);
        return response({
          number: current.issueNumber,
          node_id: current.issueId,
          title: current.title,
          body: current.body,
          html_url: current.url,
          state: current.state.toLowerCase(),
          labels: current.labels.map((name) => ({ name })),
        });
      }
    }
    if (path !== "/graphql") {
      const result = await this.upstream.request(project, request);
      if (
        request.method === "POST" &&
        path === `/repos/${project}/issues` &&
        result.status === 201
      ) {
        const id = JSON.parse(result.body).node_id;
        this.recordCreator(actor, id);
        await this.adoptIssue(project, id);
      }
      return result;
    }
    const doc = parse(body.query),
      operations = doc.definitions.filter(
        (d) => d.kind === Kind.OPERATION_DEFINITION,
      ) as OperationDefinitionNode[];
    const operation = body.operationName
      ? operations.find((o) => o.name?.value === body.operationName)
      : operations.length === 1
        ? operations[0]
        : undefined;
    if (!operation) throw new Error("Select one GraphQL operation");
    const variables = body.variables ?? {};
    if (operation.operation !== "mutation") {
      const result = await this.upstream.request(project, request);
      if (result.status !== 200) return result;
      const payload = JSON.parse(result.body),
        labels = await this.labels(project);
      this.overlay(
        payload.data,
        operation.selectionSet,
        variables,
        project,
        labels,
        doc.definitions,
      );
      return { ...result, body: JSON.stringify(payload) };
    }
    const output: Record<string, unknown> = {},
      fragments = new Map(
        doc.definitions
          .filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
          .map((d) => [d.name.value, d] as const),
      );
    for (const selection of operation.selectionSet.selections) {
      if (selection.kind !== Kind.FIELD)
        throw new Error(
          "Mutation fragments are not supported by the workflow bridge",
        );
      const field = selection.name.value,
        key = selection.alias?.value ?? field;
      const input: any =
        valueFromASTUntyped(
          selection.arguments?.find((a) => a.name.value === "input")?.value!,
          variables,
        ) ?? {};
      let found = this.store.workflow.find(
        input.labelableId ??
          input.issueId ??
          input.id ??
          input.itemId ??
          input.subjectId ??
          "",
      );
      if (found && found.ticket.split("#")[0] !== project &&
        ["addLabelsToLabelable", "removeLabelsFromLabelable", "updateIssue", "closeIssue", "reopenIssue", "updateProjectV2ItemFieldValue", "updateProjectV2ItemPosition", "removeBlockedBy"].includes(field))
        throw new OwnershipRefusal("Foreign workflow changes are limited to split dependency handoffs");
      let pullRequestLabel = false;
      if (
        !found &&
        ["addLabelsToLabelable", "removeLabelsFromLabelable"].includes(field)
      ) {
        const result = JSON.parse(
          (
            await this.checked(project, {
              method: "POST",
              path: "/graphql",
              body: JSON.stringify({
                query:
                  "query($id:ID!){node(id:$id){__typename ... on Issue{id repository{nameWithOwner}}}}",
                variables: { id: input.labelableId },
              }),
            })
          ).body,
        );
        const node = result.data?.node;
        if (node?.__typename === "PullRequest") pullRequestLabel = true;
        else if (
          node?.__typename === "Issue" &&
          node.repository.nameWithOwner === project
        ) {
          await this.adoptIssue(project, node.id);
          found = this.store.workflow.find(node.id);
        }
      }
      let change: WorkflowChange | undefined;
      let blockingIssue: Record<string, unknown> | undefined;
      if (
        !pullRequestLabel &&
        ["addLabelsToLabelable", "removeLabelsFromLabelable"].includes(field)
      )
        change = {
          [field === "addLabelsToLabelable" ? "addLabels" : "removeLabels"]:
            await this.names(project, input.labelIds),
        };
      if (
        field === "updateIssue" &&
        (input.labelIds !== undefined || input.state !== undefined)
      ) {
        change = {
          ...(input.labelIds !== undefined
            ? { labels: await this.names(project, input.labelIds) }
            : {}),
          ...(input.state ? { state: input.state } : {}),
        };
        const { id, labelIds, state, clientMutationId, ...other } = input;
        if (Object.keys(other).length) {
          if (!found || !actor)
            throw new Error("Workflow edit requires an admitted owner");
          this.store.authorizeWorkflow(
            actor.machine,
            actor.session,
            found.ticket,
            actor.runId,
          );
          const result = JSON.parse(
            (
              await this.checked(project, {
                method: "POST",
                path: "/graphql",
                body: JSON.stringify({
                  query:
                    "mutation($input:UpdateIssueInput!){updateIssue(input:$input){issue{id}}}",
                  variables: { input: { id, ...other } },
                }),
              })
            ).body,
          );
          if (result.errors?.length)
            throw new Error("Issue content edit failed");
          await this.adoptIssue(project, id);
        }
      }
      if (field === "closeIssue" || field === "reopenIssue")
        change = { state: field === "closeIssue" ? "CLOSED" : "OPEN" };
      if (field === "updateProjectV2ItemFieldValue") {
        const config = this.store.workflow.config(project)!;
        if (
          input.projectId === config.projectId &&
          input.fieldId === config.statusFieldId
        ) {
          const status = Object.keys(config.options).find(
            (name) =>
              config.options[name] === input.value?.singleSelectOptionId,
          );
          if (!status) throw new Error("Unknown workflow stage option");
          change = { status };
        }
      }
      if (
        field === "updateProjectV2ItemPosition" &&
        input.projectId === this.store.workflow.config(project)!.projectId
      ) {
        change = input.afterId ? { afterItemId: input.afterId } : { top: true };
      }
      if (field === "addBlockedBy" || field === "removeBlockedBy") {
        const blocker = this.store.workflow.find(input.blockingIssueId);
        if (!found || !blocker)
          throw new Error("Both dependency tickets must be imported");
        const blockerProject = blocker.ticket.split("#")[0];
        blockingIssue = {
          __typename: "Issue",
          ...this.node(blocker.item, this.catalog.get(blockerProject) ?? []),
          repository: { nameWithOwner: blockerProject },
        };
        change = {
          blockedBy: found.item.blockedBy.filter((b) =>
            b.url
              ? b.url !== blocker.item.url
              : b.number !== blocker.item.issueNumber ||
                blocker.ticket.split("#")[0] !== project,
          ),
        };
        if (field === "addBlockedBy")
          change.blockedBy!.push({
            number: blocker.item.issueNumber,
            state: blocker.item.state,
            url: blocker.item.url,
          });
      }
      if (change) {
        if (!found)
          throw new Error("Import the ticket before changing its workflow");
        const item = field === "addBlockedBy" && found.ticket.split("#")[0] !== project && actor
          ? this.store.workflowSplitDependency(actor.machine, actor.session, actor.runId, project, found.ticket, this.store.workflow.find(input.blockingIssueId)!.ticket)
          : this.mutate(project, found.ticket, change, actor),
          targetProject = found.ticket.split("#")[0],
          node = {
            __typename: "Issue",
            ...this.node(item, this.catalog.get(targetProject) ?? []),
            repository: { nameWithOwner: targetProject },
          },
          card = { __typename: "ProjectV2Item", id: item.id, type: "ISSUE", content: node };
        output[key] = selectResponse(
          {
            __typename: payloadType(field),
            clientMutationId: input.clientMutationId ?? null,
            issue: node,
            labelable: node,
            blockingIssue: blockingIssue ?? null,
            projectV2Item: card,
            items: { nodes: [card] },
          },
          selection.selectionSet,
          fragments,
        );
      } else if (field === "addComment" && found) {
        if (!actor) throw new Error("Workflow comment requires a run");
        const id = randomUUID();
        if (found.ticket.split("#")[0] !== project)
          this.store.workflowSplitComment(actor.machine, actor.session, actor.runId, project, found.ticket, input.body, id);
        else
          this.store.workflowComment(actor.machine, actor.session, actor.runId, found.ticket, input.body, id);
        output[key] = selectResponse(
          {
            __typename: payloadType(field),
            clientMutationId: input.clientMutationId ?? null,
            commentEdge: {
              node: {
                __typename: "IssueComment",
                id,
                body: input.body,
                url: found.item.url,
              },
            },
          },
          selection.selectionSet,
          fragments,
        );
      } else {
        const single = {
          ...operation,
          selectionSet: { ...operation.selectionSet, selections: [selection] },
        };
        // Keep only variables used by this root field.
        const declarations = (single.variableDefinitions ?? []).filter((v) =>
          new RegExp("\\$" + v.variable.name.value + "\\b").test(
            print(selection),
          ),
        );
        const query = print({
          ...doc,
          definitions: [
            { ...single, variableDefinitions: declarations },
            ...doc.definitions.filter(
              (d) => d.kind === Kind.FRAGMENT_DEFINITION,
            ),
          ],
        });
        const result = await this.checked(project, {
          ...request,
          body: JSON.stringify({ ...body, query }),
        });
        const payload = JSON.parse(result.body);
        if (payload.errors?.length) return result;
        output[key] = payload.data?.[key];
        if (
          (field === "createIssue" || field === "updateIssue") &&
          payload.data?.[key]?.issue?.id
        ) {
          if (field === "createIssue")
            this.recordCreator(actor, payload.data[key].issue.id);
          await this.adoptIssue(project, payload.data[key].issue.id);
        }
        if (
          field === "addProjectV2ItemById" &&
          input.projectId === this.store.workflow.config(project)!.projectId
        )
          await this.adoptIssue(project, input.contentId);
        // Observe the link before the creator can end. Otherwise a new child
        // could be admitted with stale null parentage after its short hold ends.
        if (['addSubIssue', 'removeSubIssue'].includes(field) &&
            this.store.workflow.find(input.subIssueId)?.ticket.startsWith(`${project}#`))
          await this.adoptIssue(project, input.subIssueId, true);
      }
    }
    return response({ data: output });
  }
  /**
   * Files a ticket for an operator: creates the issue, registers it like the
   * bridge does and applies the intended workflow. Safe to retry with the same
   * commandId. The hidden marker in the body finds an issue whose creation
   * answer was lost, so a retry never creates a second one.
   */
  file(project: string, input: unknown): Promise<FiledTicket> {
    const request = this.filingRequest(project, input);
    const key = JSON.stringify(request);
    const running = this.filings.get(request.commandId);
    if (running) {
      if (running.key !== key) throw new Error("Workflow command identity reused");
      return running.work;
    }
    const work = this.fileOnce(project, request, key).finally(() =>
      this.filings.delete(request.commandId),
    );
    this.filings.set(request.commandId, { key, work });
    return work;
  }
  /** Also used by the protected operator route for a finished creator. */
  async requiredRepairs(actor: RepairActor, ticket: string, input?: unknown) {
    const project = ticket.split('#')[0];
    if (!/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(ticket) || !this.store.workflow.enabled(project))
      throw new OwnershipRefusal('Required repairs require imported workflow authority');
    const request = input === undefined ? undefined : requiredRepairDeclaration(input);
    if (request) {
      const saved = this.store.requiredRepairChildren.saved(actor, ticket, request);
      if (saved) return saved;
    }
    if (request && actor !== 'operator') {
      this.store.planningSplits.authorize(actor, ticket);
      await guardPinnedPublication(this.store, this.upstream, ticket);
    }
    await this.refreshPlanningSplit(actor, ticket);
    return request ? this.store.declareRequiredRepairChildren(actor, ticket, request) : this.store.requiredRepairChildren.inspect(ticket);
  }
  /** Require fresh, complete GitHub family links before the single workflow commit. */
  private async refreshPlanningSplit(actor: RepairActor, ticket: string) {
    if (actor !== 'operator') this.store.planningSplits.authorize(actor, ticket);
    const project = ticket.split('#')[0], source = this.store.workflow.get(ticket);
    await this.adoptIssue(project, source.issueId, true);
    const payload = JSON.parse((await this.checked(project, { method: 'POST', path: '/graphql', fresh: true,
      body: JSON.stringify({ query: 'query($id:ID!){node(id:$id){... on Issue{id subIssues(first:100){nodes{id number} pageInfo{hasNextPage}} blocking(first:100){nodes{id number state repository{nameWithOwner}} pageInfo{hasNextPage}}}}}',
        variables: { id: source.issueId } }) })).body);
    const family = payload.data?.node;
    if (payload.errors?.length || family?.id !== source.issueId || !Array.isArray(family.subIssues?.nodes)
        || !Array.isArray(family.blocking?.nodes) || family.subIssues.pageInfo?.hasNextPage !== false || family.blocking.pageInfo?.hasNextPage !== false)
      throw new OwnershipRefusal('Cannot finalize an incomplete split family or dependent inventory');
    for (const child of family.subIssues.nodes) await this.adoptIssue(project, child.id, true);
    for (const dependent of family.blocking.nodes.filter((d: any) => d.state === 'OPEN')) {
      const targetProject = dependent.repository?.nameWithOwner;
      if (!this.store.workflow.enabled(targetProject)) throw new OwnershipRefusal('Split dependent must have imported workflow authority');
      await this.adoptIssue(targetProject, dependent.id, true);
    }
    const actual = this.store.planningSplits.inspect(ticket).children.map(c => c.issueNumber).sort();
    const linked = family.subIssues.nodes.map((c: any) => c.number).sort();
    if (JSON.stringify(actual) !== JSON.stringify(linked)) throw new OwnershipRefusal('Split child links changed; inspect the complete family again');
  }
  /** One durable split, including safe continuation after an HTTP or process failure. */
  async recoverySplit(id: string, evidence: EvidenceStore, actor?: {machine:string;session:string;runId:string}) {
    const running = this.recoverySplits.get(id);
    if (running) { this.store.checkRecoverySplit(id,actor); return running; }
    const work = this.recoverySplitOnce(id,evidence,actor).finally(() => this.recoverySplits.delete(id));
    this.recoverySplits.set(id,work);
    return work;
  }
  private recoverySplits = new Map<string,Promise<unknown>>();
  private async recoverySplitOnce(id: string, evidence: EvidenceStore, actor?: {machine:string;session:string;runId:string}) {
    const incident = this.store.recovery.incident(id);
    if (incident.decision?.action !== 'split' || !incident.decision.split) throw new Error('A retained recovery split decision is required');
    const saved = this.store.splits.get(id);
    if (saved?.state === 'complete') return this.store.prepareRecoverySplit(id,actor);
    for (const reference of incident.decision.split.evidence) {
      const bundle = evidence.list(incident.ticket,reference.runId).find(b => b.digest === reference.digest);
      const owner = this.store.runOwner(reference.runId);
      const role = (name:string) => ['builder','developer'].includes(name) ? 'builder' : ['verifier','code-review'].includes(name) ? 'verifier' : name;
      if (!bundle || !owner || owner.ticket !== incident.ticket || role(owner.role) !== reference.role || role(bundle.meta.role) !== reference.role
        || !bundle.totalBytes || !reference.inspectedPaths.every(path => bundle.manifest.files.some(f => f.path === path && f.bytes > 0 && !/^(?:run\.json|pointers\.json|SHA256SUMS)$|metadata|run-meta|manifest|result\.json/i.test(f.path))))
        throw new Error('Split evidence must name substantive retained builder, verifier and recovery bundles from this ticket');
      for (const path of reference.inspectedPaths) {
        if (!/\.(?:log|tail|txt|json|xml|md)$/.test(path)) throw new Error('Split evidence must cite readable retained text, reviews or test reports');
        const file = bundle.manifest.files.find(f=>f.path===path)!;
        evidence.read(incident.ticket,reference.runId,reference.digest,path,file.chunks.length-1);
      }
    }
    // Render every complete request before admission or creation. An oversized later child cannot strand an earlier one.
    const source = this.store.workflow.get(incident.ticket), sourceProject = incident.ticket.split('#')[0];
    for (const slice of incident.decision.split.children) this.filingRequest(sourceProject,{
      commandId:`recovery-split:${id}:${slice.key}`,title:slice.title,body:renderRecoverySlice(incident.decision.split,source.issueNumber,slice),labels:[],workflow:{stage:'Inbox',blockedBy:[source.issueNumber]},
    });
    const record = this.store.prepareRecoverySplit(id,actor);
    const project = record.ticket.split('#')[0], parent = this.store.workflow.get(record.ticket);
    evidence.pinTicket(record.ticket,`Recovery split ${id} retains all original failed evidence`);
    for (const slice of record.plan.children) {
      this.store.checkRecoverySplit(id,actor);
      let childTicket = this.store.splits.get(id)!.children[slice.key];
      if (!childTicket) {
        const labels = parent.labels.filter(l => !/^(wip:|done:|error:|error-retry-count:|rework-count:|needs-rework:|claim:|orchestrator:|needs-human:)/.test(l));
        const child = await this.file(project,{
          commandId:`recovery-split:${id}:${slice.key}`,title:slice.title,
          body:renderRecoverySlice(record.plan,parent.issueNumber,slice),
          labels,workflow:{stage:'Inbox',labels:[],blockedBy:[parent.issueNumber]},
        });
        childTicket = child.ticket;
        this.store.recordRecoveryChild(id,slice.key,childTicket);
      }
      this.store.checkRecoverySplit(id,actor);
      // addSubIssue is idempotent only after reading parentage. A lost reply is read before retry.
      const child = this.store.workflow.get(childTicket);
      await this.adoptIssue(project,child.issueId);
      const linked = this.store.workflow.get(childTicket);
      if (linked.parentNumber !== parent.issueNumber) {
        if (linked.parentNumber) throw new Error('Recovery child belongs to another parent');
        await this.checked(project,{method:'POST',path:'/graphql',body:JSON.stringify({query:'mutation($parent:ID!,$child:ID!){addSubIssue(input:{issueId:$parent,subIssueId:$child}){issue{id}}}',variables:{parent:parent.issueId,child:child.issueId}})});
      }
    }
    this.store.checkRecoverySplit(id,actor);
    return this.store.completeRecoverySplit(id,actor);
  }
  private filings = new Map<string, { key: string; work: Promise<FiledTicket> }>();
  private filingRequest(project: string, input: any): FilingRequest {
    const config = this.store.workflow.config(project);
    if (!config) throw new Error("Workflow not enabled for this project");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid filing request");
    const { commandId, title, body, labels = [], workflow = {} } = input;
    if (Object.keys(input).some((k) => !["project", "commandId", "title", "body", "labels", "workflow"].includes(k)))
      throw new Error("Unknown filing request field");
    if (typeof commandId !== "string" || !commandId || commandId.length > 200)
      throw new Error("Filing requires a commandId of at most 200 characters");
    if (typeof title !== "string" || !title.trim() || title.length > 256)
      throw new Error("Filing requires a title of at most 256 characters");
    if (typeof body !== "string" || body.length > 60_000)
      throw new Error("Filing requires a body of at most 60000 characters");
    const names = (value: unknown, what: string) => {
      if (!Array.isArray(value) || value.some((l) => typeof l !== "string" || !l || l.length > 100))
        throw new Error(`Invalid ${what}`);
      return [...new Set(value as string[])];
    };
    const content = names(labels, "labels");
    if (content.some((l) => WORKFLOW_LABEL.test(l)))
      throw new Error("Workflow labels belong in workflow.labels");
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow) ||
      Object.keys(workflow).some((k) => !["stage", "labels", "blockedBy"].includes(k)))
      throw new Error("Invalid filing workflow");
    const stage = workflow.stage ?? "Inbox";
    if (typeof stage !== "string" || !Object.hasOwn(config.options, stage))
      throw new Error("Unknown workflow stage");
    const blockedBy = workflow.blockedBy ?? [];
    if (!Array.isArray(blockedBy) || blockedBy.some((n) => !Number.isSafeInteger(n) || n < 1) ||
      new Set(blockedBy).size !== blockedBy.length)
      throw new Error("Blockers must be distinct ticket numbers");
    const known = new Set(this.store.workflow.list(project).map((i) => i.issueNumber));
    const missing = blockedBy.filter((n: number) => !known.has(n));
    if (missing.length)
      throw new Error(`Blockers are not tickets in ${project}: ${missing.join(", ")}`);
    return {
      commandId, title, body, labels: content,
      workflow: { stage, labels: names(workflow.labels ?? [], "workflow labels"), blockedBy },
    };
  }
  private async fileOnce(project: string, request: FilingRequest, key: string): Promise<FiledTicket> {
    const filing = this.store.workflow.beginFiling(request.commandId, project, key);
    if (filing.result) return filing.result;
    const marker = `<!-- orchestrator-filing:${request.commandId} -->`;
    let issueId =
      filing.issueId ?? (filing.fresh ? undefined : await this.findFiled(project, marker, filing.startedAt));
    if (!issueId) {
      const created = await this.checked(project, {
        method: "POST",
        path: `/repos/${project}/issues`,
        body: JSON.stringify({
          title: request.title,
          body: `${request.body}\n\n${marker}`,
          ...(request.labels.length ? { labels: request.labels } : {}),
        }),
      });
      issueId = JSON.parse(created.body).node_id;
      if (typeof issueId !== "string" || !issueId)
        throw new Error("GitHub did not return the new issue identity");
    }
    this.store.workflow.filingCreated(request.commandId, issueId);
    await this.adoptIssue(project, issueId);
    const ticket = this.store.workflow.find(issueId)!.ticket;
    const items = this.store.workflow.list(project);
    return this.store.workflowFile(request.commandId, ticket, {
      status: request.workflow.stage,
      addLabels: request.workflow.labels,
      blockedBy: request.workflow.blockedBy.map((n) => {
        const blocker = items.find((i) => i.issueNumber === n);
        if (!blocker) throw new Error(`Blocker ${project}#${n} is no longer a ticket`);
        return { number: n, state: blocker.state, url: blocker.url };
      }),
    });
  }
  /** Newest issues first, back to shortly before the first attempt started. */
  private async findFiled(project: string, marker: string, startedAt: number) {
    for (let page = 1; page <= 10; page++) {
      const rows = JSON.parse(
        (
          await this.checked(project, {
            method: "GET",
            path: `/repos/${project}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
            fresh: true,
          })
        ).body,
      );
      if (!Array.isArray(rows)) throw new Error("Invalid issue list");
      const hit = rows.find((r: any) => !r.pull_request && r.body?.includes(marker));
      if (hit) return String(hit.node_id);
      const oldest = Date.parse(rows.at(-1)?.created_at ?? "");
      if (rows.length < 100 || oldest < startedAt - 600_000) return undefined;
    }
    throw new Error("Cannot confirm whether an earlier attempt created the issue");
  }
  async adoptIssue(project: string, id: string, contentOnly = false): Promise<void> {
    if (!id)
      throw new Error("Issue identity required for workflow registration");
    const config = this.store.workflow.config(project)!;
    const query =
      'query($id:ID!){node(id:$id){... on Issue{id number title body url state repository{nameWithOwner} labels(first:100){nodes{name} pageInfo{hasNextPage}} blockedBy(first:100){nodes{number state url} pageInfo{hasNextPage}} parent{number parent{number}} subIssuesSummary{total completed} projectItems(first:100){nodes{id project{id} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}} pageInfo{hasNextPage}}}}}';
    const payload = JSON.parse(
      (
        await this.checked(project, {
          method: "POST",
          path: "/graphql",
          body: JSON.stringify({ query, variables: { id } }),
          fresh: true,
        })
      ).body,
    );
    const issue = payload.data?.node;
    if (
      payload.errors?.length ||
      !issue ||
      issue.repository?.nameWithOwner !== project ||
      issue.labels.pageInfo.hasNextPage ||
      issue.blockedBy.pageInfo.hasNextPage ||
      issue.projectItems.pageInfo.hasNextPage
    )
      throw new Error("Cannot import incomplete issue metadata");
    let board = issue.projectItems.nodes.find(
      (p: any) => p.project.id === config.projectId,
    );
    if (!board) {
      const added = JSON.parse(
        (
          await this.checked(project, {
            method: "POST",
            path: "/graphql",
            body: JSON.stringify({
              query:
                "mutation($project:ID!,$issue:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$issue}){item{id}}}",
              variables: { project: config.projectId, issue: id },
            }),
          })
        ).body,
      );
      if (added.errors?.length || !added.data?.addProjectV2ItemById?.item?.id)
        throw new Error("Could not register workflow board item");
      board = { id: added.data.addProjectV2ItemById.item.id };
    }
    const observed: WorkflowItem = {
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
        revision: 1,
        position: 0,
      };
    // Split revision fences describe authority and family content. An unchanged,
    // lagging GitHub display must not invalidate every inspection/finalize pair.
    const current = this.store.workflow.find(issue.id)?.item;
    const contentFields = ['id', 'issueId', 'title', 'body', 'url', 'parentNumber', 'grandparentNumber', 'subIssues'] as const;
    if (contentOnly && current && contentFields.every(k => JSON.stringify(current[k]) === JSON.stringify(observed[k]))) return;
    this.store.workflow.observe(project, [observed]);
  }
  private async checked(project: string, request: GitHubRequest) {
    const r = await this.upstream.request(project, request);
    if (r.status < 200 || r.status >= 300)
      throw new Error(`GitHub unavailable: ${r.status}`);
    return r;
  }
  private overlay(
    data: any,
    set: SelectionSetNode,
    variables: any,
    project: string,
    labels: Array<{ node_id: string; name: string }>,
    definitions: readonly any[],
    context?: WorkflowItem,
  ): void {
    if (!data || typeof data !== "object") return;
    if (Array.isArray(data)) {
      for (const value of data)
        this.overlay(
          value,
          set,
          variables,
          project,
          labels,
          definitions,
          context,
        );
      return;
    }
    context = this.store.workflow.find(data.id ?? "")?.item ?? context;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const f = definitions.find(
          (d) =>
            d.kind === Kind.FRAGMENT_DEFINITION &&
            d.name.value === selection.name.value,
        );
        if (f)
          this.overlay(
            data,
            f.selectionSet,
            variables,
            project,
            labels,
            definitions,
            context,
          );
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        this.overlay(
          data,
          selection.selectionSet,
          variables,
          project,
          labels,
          definitions,
          context,
        );
        continue;
      }
      const key = selection.alias?.value ?? selection.name.value,
        name = selection.name.value;
      let child: WorkflowItem | undefined,
        childProject = project;
      if (name === "node") {
        const argument = selection.arguments?.find(
          (a) => a.name.value === "id",
        );
        if (argument)
          child = this.store.workflow.find(
            String(valueFromASTUntyped(argument.value, variables)),
          )?.item;
      }
      if (name === "repository") {
        const values = Object.fromEntries(
          (selection.arguments ?? []).map((a) => [
            a.name.value,
            valueFromASTUntyped(a.value, variables),
          ]),
        );
        if (values.owner && values.name)
          childProject = `${values.owner}/${values.name}`;
      }
      if (name === "issue") {
        const argument = selection.arguments?.find(
          (a) => a.name.value === "number",
        );
        const n = argument
          ? valueFromASTUntyped(argument.value, variables)
          : data[key]?.number;
        child = this.store.workflow
          .list(project)
          .find((i) => i.issueNumber === n);
      }
      if (context && name === "labels")
        data[key] = this.node(context, labels).labels;
      if (context && name === "state") data[key] = context.state;
      if (context && name === "comments") {
        const remote = data[key];
        if (remote && !remote.pageInfo?.hasNextPage) {
          const nodes =
            remote.nodes ?? remote.edges?.map((e: any) => e.node) ?? [];
          const pending = this.store.workflow
            .unpublishedComments(`${project}#${context.issueNumber}`)
            .filter(
              (c) =>
                !nodes.some((n: any) =>
                  n.body?.includes(`<!-- orchestrator-comment:${c.id} -->`),
                ),
            )
            .map((c) => ({
              id: c.id,
              body: c.body,
              createdAt: c.created_at,
              author: null,
              url: context!.url,
            }));
          if (remote.nodes) remote.nodes.push(...pending);
          if (remote.edges)
            remote.edges.push(...pending.map((node) => ({ node })));
          if (typeof remote.totalCount === "number")
            remote.totalCount += pending.length;
        }
      }
      if (context && name === "blockedBy") {
        const nodes = context.blockedBy.map((b) => ({
          number: b.number,
          state: b.state,
          url: b.url,
          id: this.store.workflow
            .list(project)
            .find((i) => i.issueNumber === b.number)?.issueId,
        }));
        data[key] = {
          nodes,
          edges: nodes.map((node) => ({ node })),
          totalCount: nodes.length,
          pageInfo: { hasNextPage: false },
        };
      }
      if (context && data.id === context.id && name === "fieldValueByName") {
        const argument = selection.arguments?.find(
          (a) => a.name.value === "name",
        );
        if (
          argument &&
          valueFromASTUntyped(argument.value, variables) === "Status"
        )
          data[key] = { name: context.status };
      }
      if (selection.selectionSet)
        this.overlay(
          data[key],
          selection.selectionSet,
          variables,
          childProject,
          labels,
          definitions,
          child,
        );
    }
  }
}
