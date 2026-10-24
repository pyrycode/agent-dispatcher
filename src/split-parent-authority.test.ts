// A refiner that splits a ticket keeps write authority over the children it
// creates until it finishes, and a refused workflow write reaches the agent's
// gh as a 409 refusal with its reason instead of a generic 503.
//
// Core #3361 (2026-10-15): the parent refiner ran on pyrybox 01:28:44 to
// 01:39:30 UTC. Its children were admitted during that run: #3428 and #3429
// refiners on build-fractal-2 (01:33:56, 01:35:51), #3430 refiner on pyrybox
// (01:34:28), #3428 builder on pyrybox (01:39:18). The parent's later writes
// to #3430 (priority and security labels, board order) were refused by
// FleetStore.authorize and the bridge reported them as HTTP 503.
// Core #3247 (2026-10-13): child #3315's refiner started at 04:02 during the
// parent's run, with the same result and fifteen dispatcher repairs after it.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";
import { CREATOR_HOLD_MS, FleetStore, type StartRequest } from "./fleet-store.js";
import { WorkflowGitHub } from "./workflow-github.js";
import { GitHubBroker } from "./github-broker.js";
import { FleetClient, JsonClient, ServiceError, ownershipRefusal, serveFleet } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { runGitHubBridge, serveGitHubBridge } from "./github-bridge.js";
import { transientPollFailure } from "./poll-failure.js";
import type { WorkflowItem, WorkflowProject } from "./workflow-store.js";

const project = "org/core";
const config: WorkflowProject = {
  project, projectId: "P", statusFieldId: "S",
  options: { Inbox: "inbox", Backlog: "backlog", "In Development": "dev", "In Code Review": "review", Done: "done" },
};
const item = (n: number, status = "Backlog"): WorkflowItem => ({
  id: `P${n}`, issueId: `I${n}`, issueNumber: n, title: `Ticket ${n}`, body: "", url: `https://github.com/${project}/issues/${n}`,
  status, labels: [], blockedBy: [], parentNumber: null, grandparentNumber: null, state: "OPEN", revision: 1, position: 0,
});
const start = (machine: string, n: number, role: string, id = `${role}-${n}-${machine}`): StartRequest => ({
  workflowVersion: 1, id, machine, session: "s", project, ticket: `${project}#${n}`, role, resource: "heavy", locks: [],
});
/** GitHub's node read for a new child, as adoptIssue asks for it. */
function node(n: number, parent: number) {
  const i = item(n);
  return {
    id: i.issueId, number: n, title: i.title, body: i.body, url: i.url, state: "OPEN", repository: { nameWithOwner: project },
    labels: { nodes: [], pageInfo: { hasNextPage: false } }, blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
    parent: { number: parent, parent: null }, subIssuesSummary: { total: 0, completed: 0 },
    projectItems: { nodes: [{ id: i.id, project: { id: "P" }, fieldValueByName: { name: "Backlog" } }], pageInfo: { hasNextPage: false } },
  };
}
/** A GitHub that creates issues by REST or GraphQL and answers adoption reads. */
function fakeGitHub(parent: number) {
  let next = 0;
  const creations: number[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === `/repos/${project}/issues` && init?.method === "POST") {
      const n = creations[next++]!;
      return Response.json({ number: n, node_id: `I${n}` }, { status: 201 });
    }
    if (url.pathname === `/repos/${project}/labels`) return Response.json([{ id: 1, node_id: "L1", name: "priority:low" }, { id: 2, node_id: "L2", name: "security-sensitive" }]);
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body));
      if (/createIssue/.test(body.query)) {
        const n = creations[next++]!;
        return Response.json({ data: { createIssue: { issue: { id: `I${n}`, url: item(n).url } } } });
      }
      if (/node\(id:\$id\)/.test(body.query)) return Response.json({ data: { node: node(Number(String(body.variables.id).slice(1)), parent) } });
    }
    throw new Error(`Unexpected GitHub request ${init?.method} ${url.pathname}`);
  };
  return { fetcher, creations };
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "split-parent-"));
  const store = new FleetStore(join(dir, "claims.sqlite"), {
    pyrybox: { heavyLimit: 4, combinedLimit: 4 }, fractal: { heavyLimit: 4, combinedLimit: 4 }, hp: { heavyLimit: 4, combinedLimit: 4 },
  });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}
const close = (server: Server) => new Promise<void>(r => server.close(() => r()));
function gh(socket: string, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpRequest({ socketPath: socket, path, method, headers: { Host: "api.github.com", "Content-Type": "application/json" } }, res => {
      let text = ""; res.on("data", c => { text += c; });
      res.on("end", () => { let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* raw */ } resolve({ status: res.statusCode!, body: parsed }); });
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
/** Central claim service, one machine manager per computer, and a per-run bridge, as in production. */
async function stack(t: TestContext, store: FleetStore, fetcher: typeof fetch, dir: string) {
  const broker = new GitHubBroker({ token: "central", projects: [project], fetcher });
  const tokens = { pyrybox: "pyrybox-secret", fractal: "fractal-secret", hp: "hp-secret" };
  const fleet = await serveFleet(store, tokens, "operator", 0, "127.0.0.1", broker);
  const address = fleet.address(); assert.ok(address && typeof address !== "string");
  const servers: Server[] = [fleet];
  const managers: Record<string, string> = {};
  for (const [machine, token] of Object.entries(tokens)) {
    const manager = new MachineManager({ machine, heavyLimit: 4, combinedLimit: 4, projects: [project] }, new FleetClient(`http://127.0.0.1:${address.port}`, token));
    managers[machine] = join(dir, `${machine}.sock`);
    servers.unshift(await serveManager(manager, { [project]: `${machine}-core` }, `${machine}-op`, managers[machine]));
  }
  t.after(async () => { for (const server of servers) await close(server); });
  /** The gh socket of one admitted run, carrying that run's identity. */
  const bridge = async (machine: string, runId: string) => {
    const socket = join(dir, `${machine}-${runId}.sock`);
    const server = await runGitHubBridge({ socket, url: `unix://${managers[machine]}`, token: `${machine}-core`, actor: { session: "s", runId } });
    t.after(() => close(server));
    return socket;
  };
  return { bridge, manager: (machine: string) => new JsonClient(`unix://${managers[machine]}`, `${machine}-core`) };
}

for (const role of ["refiner", "builder"]) test(`Core #3361: ${role} split children wait while later parent writes land`, async t => {
  const { store } = fixture(t);
  store.workflow.import(config, [item(3361, role === "builder" ? "In Development" : "Backlog"), item(3500)]);
  const parent = start("pyrybox", 3361, role);
  assert.equal(store.start(parent).ok, true);
  const github = fakeGitHub(3361);
  github.creations.push(3428, 3429, 3430, 3431);
  const workflow = new WorkflowGitHub(store, new GitHubBroker({ token: "central", projects: [project], fetcher: github.fetcher }));
  const actor = { machine: "pyrybox", session: "s", runId: parent.id };
  // gh issue create's mutation, trimmed to its shape.
  for (let i = 0; i < 4; i++) {
    const created = await workflow.request(project, { method: "POST", path: "/graphql", body: JSON.stringify({
      query: "mutation IssueCreate($input:CreateIssueInput!){createIssue(input:$input){issue{id,url}}}",
      variables: { input: { repositoryId: "R", title: `child ${i}` } },
    }) }, actor);
    assert.equal(created.status, 200);
  }
  // A new issue arrives in Inbox; the refiner places each child in Backlog.
  for (const n of [3428, 3429, 3430, 3431])
    store.workflowChange("pyrybox", "s", parent.id, `${project}#${n}`, { status: "Backlog" }, `backlog-${n}`);
  assert.equal(store.workflow.get(`${project}#3428`).parentNumber, 3361);
  // Control: a Backlog ticket the run did not create is admitted meanwhile.
  assert.equal(store.start(start("fractal", 3500, "refiner")).ok, true);
  // What happened at 01:33 to 01:39: each child admitted while the parent ran.
  assert.deepEqual(store.start(start("fractal", 3428, "refiner")), { ok: false, reason: "locked" });
  assert.deepEqual(store.start(start("fractal", 3429, "refiner")), { ok: false, reason: "locked" });
  assert.deepEqual(store.start(start("pyrybox", 3430, "refiner")), { ok: false, reason: "locked" });
  // Advanced by the pipeline during the parent run; the builder still waits.
  store.workflowOperator(`${project}#3428`, { status: "In Development" }, "advance", store.workflow.get(`${project}#3428`).revision);
  assert.deepEqual(store.start(start("pyrybox", 3428, "builder")), { ok: false, reason: "locked" });
  assert.deepEqual(store.snapshot().runs.map(r => r.ticket).sort(), [`${project}#3361`, `${project}#3500`]);
  // The writes that were refused on #3430: labels and board order.
  await workflow.request(project, { method: "POST", path: `/repos/${project}/issues/3430/labels`, body: JSON.stringify({ labels: ["priority:low", "security-sensitive"] }) }, actor);
  store.workflowChange("pyrybox", "s", parent.id, `${project}#3430`, { afterItemId: "P3429" }, "board-after-3430");
  store.workflowChange("pyrybox", "s", parent.id, `${project}#3431`, { afterItemId: "P3430" }, "board-after-3431");
  assert.deepEqual(store.workflow.get(`${project}#3430`).labels, ["priority:low", "security-sensitive"]);
  // Finishing alone must not release a split that never closed its parent.
  store.finish("pyrybox", "s", parent.id);
  assert.deepEqual(store.start(start("fractal", 3429, "refiner")), { ok: false, reason: "locked" });
  store.workflowOperator(`${project}#3361`, { state: 'CLOSED', status: 'Done' }, 'replace-parent', store.workflow.get(`${project}#3361`).revision);
  assert.equal(store.start(start("fractal", 3429, "refiner")).ok, true);
  assert.equal(store.start(start("pyrybox", 3428, "builder")).ok, true);
  assert.throws(() => store.workflowChange("pyrybox", "s", parent.id, `${project}#3430`, { addLabels: ["late"] }, "late"), /finished or lost ownership/);
});

test("Core #3247: a child created through the bridge is held, and a refused write reaches gh as a 409 refusal", async t => {
  const { store, dir } = fixture(t);
  // #3316 predates the parent run (imported, no creator), so it shows the
  // refusal itself. #3315 is created by the parent run through gh.
  store.workflow.import(config, [item(3247), item(3316)]);
  const github = fakeGitHub(3247);
  github.creations.push(3315);
  const { bridge } = await stack(t, store, github.fetcher, dir);
  const parent = start("pyrybox", 3247, "refiner");
  assert.equal(store.start(parent).ok, true);
  const socket = await bridge("pyrybox", parent.id);
  const created = await gh(socket, "POST", `/repos/${project}/issues`, { title: "child" });
  assert.equal(created.status, 201);
  assert.equal(store.workflow.get(`${project}#3315`).parentNumber, 3247);
  store.workflowChange("pyrybox", "s", parent.id, `${project}#3315`, { status: "Backlog" }, "backlog-3315");
  // 04:02 on 2026-10-13: #3315's refiner started elsewhere during the parent run.
  assert.deepEqual(store.start(start("hp", 3315, "refiner")), { ok: false, reason: "locked" });
  const labelled = await gh(socket, "POST", `/repos/${project}/issues/3315/labels`, { labels: ["priority:low"] });
  assert.equal(labelled.status, 200);
  assert.deepEqual(store.workflow.get(`${project}#3315`).labels, ["priority:low"]);
  // Every other ownership protection is unchanged: a ticket the parent did not
  // create, running on another computer, refuses the parent's write. gh sees
  // the refusal and its reason, not "Shared GitHub unavailable".
  assert.equal(store.start(start("hp", 3316, "refiner")).ok, true);
  const refused = await gh(socket, "POST", `/repos/${project}/issues/3316/labels`, { labels: ["priority:low"] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.refused, "ownership");
  assert.match(refused.body.message, /^Workflow write refused: Ticket is running on another machine$/);
  assert.deepEqual(store.workflow.get(`${project}#3316`).labels, []);
  // Same for the GraphQL mutation gh issue edit --add-label sends.
  const graphql = await gh(socket, "POST", "/graphql", {
    query: "mutation($input:AddLabelsToLabelableInput!){addLabelsToLabelable(input:$input){labelable{id}}}",
    variables: { input: { labelableId: "I3316", labelIds: ["L1"] } },
  });
  assert.equal(graphql.status, 409);
  assert.match(graphql.body.message, /Ticket is running on another machine/);
  // Same computer, another run: the other refusal reason, also reported.
  store.finish("hp", "s", "refiner-3316-hp");
  assert.equal(store.start(start("pyrybox", 3316, "refiner", "sibling")).ok, true);
  const active = await gh(socket, "POST", `/repos/${project}/issues/3316/labels`, { labels: ["priority:low"] });
  assert.equal(active.status, 409);
  assert.match(active.body.message, /Ticket has an active run/);
  // After the parent finishes, its own grant is refused as finished.
  store.finish("pyrybox", "s", parent.id);
  assert.deepEqual(store.start(start("hp", 3315, "refiner")), { ok: false, reason: "locked" });
  store.workflowOperator(`${project}#3247`, { state: 'CLOSED', status: 'Done' }, 'replace-parent', store.workflow.get(`${project}#3247`).revision);
  assert.equal(store.start(start("hp", 3315, "refiner")).ok, true);
  const late = await gh(socket, "POST", `/repos/${project}/issues/3315/labels`, { labels: ["late"] });
  assert.equal(late.status, 409);
  assert.match(late.body.message, /finished or lost ownership/);
});

test("only the claim service's marked refusal becomes a refusal; outages, the catch-all and GitHub statuses keep their meaning", async t => {
  const { store, dir } = fixture(t);
  store.workflow.import(config, [item(3247)]);
  let upstream: () => Promise<Response> = async () => { throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }); };
  const { bridge, manager } = await stack(t, store, async () => upstream(), dir);
  const run = start("pyrybox", 3247, "refiner");
  store.start(run);
  const socket = await bridge("pyrybox", run.id);
  // A broker transport failure reaches the claim service's catch-all 409, unmarked: still 503.
  assert.equal((await gh(socket, "GET", `/repos/${project}/pulls/1`)).status, 503);
  // GitHub's own statuses pass through with their headers and are never marked.
  const quota = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000", "content-type": "application/json" };
  // The exhausted quota last: the broker then holds further reads.
  for (const [status, headers] of [[401, {}], [409, {}], [403, quota]] as const) {
    upstream = async () => new Response(JSON.stringify({ message: `GitHub ${status}` }), { status, headers });
    const answer = await gh(socket, "GET", `/repos/${project}/pulls/${status}`);
    assert.equal(answer.status, status);
    assert.equal(answer.body.message, `GitHub ${status}`);
    assert.equal(answer.body.refused, undefined);
  }
  // The manager relays the refusal unwrapped, and the poll classifier still
  // treats it as a lost authority (fatal), as it did before.
  const refusal = await manager("hp").call("/workflow/change", { project, session: "s", runId: "none", ticket: `${project}#3247`, change: { addLabels: ["x"] }, commandId: "c" })
    .then(() => assert.fail("refused"), (e: unknown) => e);
  assert.ok(refusal instanceof ServiceError);
  assert.equal(refusal.status, 409);
  assert.deepEqual(refusal.body, { error: "Workflow run has finished or lost ownership", refused: "ownership" });
  assert.equal(refusal.message, 'Service 409: {"error":"Workflow run has finished or lost ownership","refused":"ownership"}');
  assert.equal(transientPollFailure(refusal), null);
  // An unmarked 409 from an older claim service, or a forged marker in the
  // text of another error, stays the generic 503.
  for (const error of [
    new ServiceError(409, { error: "Ticket has an active run" }, ""),
    new ServiceError(409, { error: 'Service 409: {"error":"x","refused":"ownership"}' }, ""),
    new ServiceError(503, { error: "x", refused: "ownership" }, ""),
    new Error('Service 409: {"error":"x","refused":"ownership"}'),
  ]) {
    assert.equal(ownershipRefusal(error), undefined);
    const fake = join(dir, `fake-${Math.random()}.sock`);
    const server = await serveGitHubBridge(fake, async () => { throw error; });
    assert.equal((await gh(fake, "GET", "/")).status, 503);
    await close(server);
  }
});

test("the hold is bounded by the stale-reservation age, so a vanished creator cannot hold its children for ever", t => {
  const dir = mkdtempSync(join(tmpdir(), "split-parent-"));
  let now = 1_000_000;
  const store = new FleetStore(join(dir, "claims.sqlite"), { pyrybox: { heavyLimit: 2, combinedLimit: 2 }, hp: { heavyLimit: 2, combinedLimit: 2 } }, { now: () => now });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.workflow.import(config, [item(3247), item(3315)]);
  const parent = start("pyrybox", 3247, "refiner");
  assert.equal(store.start(parent).ok, true);
  // Only the run's own computer and session can record it.
  store.recordTicketCreator("hp", "s", parent.id, "I3315");
  assert.equal(store.start(start("hp", 3315, "refiner", "early")).ok, true);
  store.finish("hp", "s", "early");
  store.recordTicketCreator("pyrybox", "s", parent.id, "I3315");
  assert.deepEqual(store.start(start("hp", 3315, "refiner", "held")), { ok: false, reason: "locked" });
  now += CREATOR_HOLD_MS - 1;
  assert.deepEqual(store.start(start("hp", 3315, "refiner", "still")), { ok: false, reason: "locked" });
  now += 1;
  assert.equal(store.start(start("hp", 3315, "refiner", "released")).ok, true);
});

const mobile = "org/mobile";
function dependent(n: number, blockers = [3533]): WorkflowItem {
  return { ...item(n), id: `M${n}`, issueId: `MI${n}`, url: `https://github.com/${mobile}/issues/${n}`,
    blockedBy: blockers.map(number => ({ number, state: "OPEN", url: item(number).url })) };
}
function splitTransfer(store: FleetStore) {
  store.workflow.import(config, [item(3533), { ...item(3538, "Done"), state: "CLOSED", parentNumber: 3533 }, item(9999)]);
  store.workflow.import({ ...config, project: mobile, projectId: "MP" }, [dependent(2205, [3533, 9999]), dependent(2206, [])]);
  const run = start("pyrybox", 3533, "refiner");
  assert.equal(store.start(run).ok, true);
  return run;
}
const dependency = (child = "I3538", target = "MI2205", operation = "addBlockedBy") => ({
  query: `mutation($input:${operation === "addBlockedBy" ? "Add" : "Remove"}BlockedByInput!){${operation}(input:$input){issue{id repository{nameWithOwner}} blockingIssue{id}}}`,
  variables: { input: { issueId: target, blockingIssueId: child } },
});
const comment = (subjectId = "MI2205") => ({
  query: "mutation($input:AddCommentInput!){addComment(input:$input){commentEdge{node{id body}}}}",
  variables: { input: { subjectId, body: "The split child now carries this prerequisite. The original parent edge is retained." } },
});

test("Core #3533: an active parent refiner transfers existing foreign dependents to its child, without taking ownership", async t => {
  const { store, dir } = fixture(t);
  const run = splitTransfer(store);
  // A completed builder's foreign claim must remain intact while a narrowly
  // scoped dependency handoff updates its idle dependent.
  const originalBlockers = store.workflow.get(`${mobile}#2205`).blockedBy;
  store.workflowOperator(`${mobile}#2205`, { status: "In Development", blockedBy: [] }, "dev", store.workflow.get(`${mobile}#2205`).revision);
  const owner = { ...start("hp", 2205, "builder"), project: mobile, ticket: `${mobile}#2205` };
  assert.equal(store.start(owner).ok, true);
  store.finish("hp", "s", owner.id);
  store.workflowOperator(`${mobile}#2205`, { status: "Backlog", blockedBy: originalBlockers, addLabels: ["needs-human:decision"] }, "backlog", store.workflow.get(`${mobile}#2205`).revision);
  const before = store.workflow.get(`${mobile}#2205`);
  const claims = store.snapshot().claims;
  const { bridge } = await stack(t, store, async () => { throw new Error("No upstream mutation allowed"); }, dir);
  const socket = await bridge("pyrybox", run.id);
  const early = await gh(socket, "POST", "/graphql", comment());
  assert.equal(early.status, 409);
  const updated = await gh(socket, "POST", "/graphql", dependency());
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.data.addBlockedBy.issue, { id: "MI2205", repository: { nameWithOwner: mobile } });
  // Retry is harmless, including when the child has already completed.
  assert.equal((await gh(socket, "POST", "/graphql", dependency())).status, 200);
  const after = store.workflow.get(`${mobile}#2205`);
  assert.deepEqual(after.blockedBy.map(b => b.url), [item(3533).url, item(9999).url, item(3538).url]);
  for (const key of ["labels", "status", "state", "position"] as const) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(store.snapshot().claims, claims);
  assert.equal((await gh(socket, "POST", "/graphql", comment())).status, 200);
  assert.equal((await gh(socket, "POST", `/repos/${mobile}/issues/2205/comments`, { body: "Split prerequisite handoff confirmed." })).status, 200);
  assert.equal(store.workflow.comments(`${mobile}#2205`).length, 2);
  store.finish("pyrybox", "s", run.id);
  const late = await gh(socket, "POST", "/graphql", dependency());
  assert.equal(late.status, 409);
  assert.equal(late.body.refused, "ownership");
});

test("split transfer refuses unrelated edges, broad edits, and active foreign workers", async t => {
  const { store, dir } = fixture(t);
  const run = splitTransfer(store);
  const { bridge } = await stack(t, store, async () => { throw new Error("No upstream mutation allowed"); }, dir);
  const socket = await bridge("pyrybox", run.id);
  const before = store.workflow.get(`${mobile}#2205`);
  assert.throws(() => store.workflowSplitDependency("pyrybox", "stale-session", run.id, project, `${mobile}#2205`, `${project}#3538`), /active planning run/);
  const refused = [
    dependency("I9999"), dependency("I3538", "MI2206"), dependency("I3533"), dependency("I3538", "MI2205", "removeBlockedBy"),
    { query: 'mutation{closeIssue(input:{issueId:"MI2205"}){issue{id}}}' },
    { query: 'mutation{updateIssue(input:{id:"MI2205",state:OPEN}){issue{id}}}' },
    comment("MI2206"),
    { query: 'mutation{addLabelsToLabelable(input:{labelableId:"MI2205",labelIds:["L1"]}){labelable{id}}}' },
    { query: 'mutation{updateProjectV2ItemFieldValue(input:{projectId:"P",itemId:"M2205",fieldId:"S",value:{singleSelectOptionId:"dev"}}){projectV2Item{id}}}' },
  ];
  for (const request of refused) {
    const result = await gh(socket, "POST", "/graphql", request);
    assert.equal(result.status, 409, JSON.stringify(request));
    assert.equal(result.body.refused, "ownership");
    assert.deepEqual(store.workflow.get(`${mobile}#2205`), before);
  }
  const worker = { ...start("hp", 2205, "deployment-check"), project: mobile, ticket: `${mobile}#2205` };
  assert.equal(store.start(worker).ok, true);
  const active = await gh(socket, "POST", "/graphql", dependency());
  assert.equal(active.status, 409);
  assert.match(active.body.message, /active run/);
  assert.deepEqual(store.workflow.get(`${mobile}#2205`), before);
  store.finish("hp", "s", worker.id);
  assert.equal((await gh(socket, "POST", "/graphql", dependency())).status, 200);
  const other = await bridge("hp", run.id);
  assert.equal((await gh(other, "POST", "/graphql", dependency())).status, 409);
  const wrongRole = start("pyrybox", 9999, "builder");
  store.workflowOperator(`${project}#9999`, { status: "In Development" }, "builder-dev", store.workflow.get(`${project}#9999`).revision);
  assert.equal(store.start(wrongRole).ok, true);
  assert.equal((await gh(await bridge("pyrybox", wrongRole.id), "POST", "/graphql", dependency())).status, 409);
});

test("Desktop #2191: a refused optional foreign label leaves the worker authorised to finish its own ticket", async t => {
  const { store, dir } = fixture(t);
  store.workflow.import(config, [item(2191, 'In Development'), item(2205, 'In Development')]);
  const own = start('pyrybox', 2191, 'builder');
  const foreign = start('hp', 2205, 'builder');
  assert.equal(store.start(own).ok, true);
  assert.equal(store.start(foreign).ok, true);
  const { bridge } = await stack(t, store, fakeGitHub(0).fetcher, dir);
  const socket = await bridge('pyrybox', own.id);
  const before = structuredClone(store.workflow.get(foreign.ticket));
  const claims = store.snapshot().claims;
  const refused = await gh(socket, 'POST', `/repos/${project}/issues/2205/labels`, { labels: ['bug'] });
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /another machine/);
  assert.deepEqual(store.workflow.get(foreign.ticket), before);
  assert.deepEqual(store.snapshot().claims, claims);
  const accepted = await gh(socket, 'POST', `/repos/${project}/issues/2191/labels`, { labels: ['bug'] });
  assert.equal(accepted.status, 200);
  assert.ok(store.workflow.get(own.ticket).labels.includes('bug'));

  // Both runners see an ordinary tool error, not an approval rejection.
  const { CodexStreamAdapter, CODEX_ROLE_GUIDANCE } = await import('./agent-runner.js');
  const { advancePermissionDenialState, initPermissionDenialState } = await import('./agent-runtime.js');
  let claude = initPermissionDenialState();
  for (const result of [refused, accepted]) {
    const advanced = advancePermissionDenialState(claude, { type: 'user', message: { content: [
      { type: 'tool_result', is_error: result.status !== 200, content: JSON.stringify(result.body) },
    ] } });
    assert.equal(advanced.action, 'none');
    claude = advanced.state;
  }
  assert.equal(claude.hadPermissionDenial, false);
  const codex = new CodexStreamAdapter();
  codex.accept({ type: 'item.completed', item: { type: 'command_execution', status: 'failed', exit_code: 1, aggregated_output: JSON.stringify(refused.body) } });
  codex.accept({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'completed', summary: 'Skipped foreign label; own work completed.' }) } });
  codex.accept({ type: 'turn.completed' });
  assert.equal(codex.finish(0, false, 1).isError, false);
  assert.match(CODEX_ROLE_GUIDANCE, /optional workflow action/);

  // A real safety denial remains sticky even after a later success claim.
  const denial = advancePermissionDenialState(claude, { type: 'user', message: { content: [
    { type: 'tool_result', is_error: true, content: 'Permission to use Bash has been denied.' },
  ] } });
  assert.equal(denial.state.hadPermissionDenial, true);
  codex.accept({ type: 'item.completed', item: { type: 'command_execution', status: 'declined', aggregated_output: 'This action was rejected due to unacceptable risk.' } });
  assert.equal(codex.finish(0, false, 1).hadPermissionDenial, true);
  assert.equal(codex.finish(0, false, 1).isError, true);

  // Operator recovery invalidating the own claim makes the old worker's next write fail.
  const ownClaim = store.snapshot().claims.find(c => c.ticket === own.ticket)!;
  store.free(own.ticket, ownClaim.generation, true);
  const stopped = structuredClone(store.workflow.get(own.ticket));
  const late = await gh(socket, 'POST', `/repos/${project}/issues/2191/labels`, { labels: ['late'] });
  assert.equal(late.status, 409);
  assert.match(late.body.message, /finished or lost ownership|not owned|ownership/i);
  const lost = new CodexStreamAdapter();
  lost.accept({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'blocked', summary: 'Lost authority over assigned ticket.' }) } });
  lost.accept({ type: 'turn.completed' });
  assert.equal(lost.finish(0, false, 1).isError, true);
  assert.deepEqual(store.workflow.get(own.ticket), stopped);
  assert.deepEqual(store.workflow.get(foreign.ticket), before);
});
