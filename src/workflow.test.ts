import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore, type StartRequest } from "./fleet-store.js";
import { WorkflowPublisher } from "./workflow-publisher.js";
import { WorkflowGitHub } from "./workflow-github.js";
import { GitHubBroker } from "./github-broker.js";
import { workflowClient } from "./workflow-client.js";
import { JsonClient, serveFleet } from "./fleet-http.js";
import { decideReworkRoutes, decideAutoAdvance } from "./pipeline-decisions.js";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowItem, WorkflowProject } from "./workflow-store.js";

const config: WorkflowProject = {
  project: "org/mobile",
  projectId: "P",
  statusFieldId: "S",
  options: {
    Inbox: "inbox",
    "In Development": "dev",
    "In Code Review": "review",
    Done: "done",
    Halted: "halt",
  },
};
const item = (n = 1947): WorkflowItem => ({
  id: `P${n}`,
  issueId: `I${n}`,
  issueNumber: n,
  title: "Context reset",
  body: "Fix stale context",
  url: `https://github.com/org/mobile/issues/${n}`,
  status: "In Development",
  labels: [],
  blockedBy: [],
  parentNumber: null,
  grandparentNumber: null,
  state: "OPEN",
  revision: 1,
  position: 0,
});
const run = (id = "builder"): StartRequest => ({
  workflowVersion: 1,
  id,
  machine: "mac",
  session: "s",
  project: config.project,
  ticket: "org/mobile#1947",
  role: id,
  resource: "light",
  locks: [],
});
function remoteMetadata(i: WorkflowItem) {
  return {
    id: i.issueId,
    number: i.issueNumber,
    title: i.title,
    body: i.body,
    url: i.url,
    state: i.state,
    labels: {
      nodes: i.labels.map((name) => ({ name })),
      pageInfo: { hasNextPage: false },
    },
    blockedBy: { nodes: i.blockedBy, pageInfo: { hasNextPage: false } },
    projectItems: {
      nodes: [
        {
          id: i.id,
          project: { id: "P" },
          fieldValueByName: { name: i.status },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "workflow-test-")),
    path = join(dir, "state.sqlite");
  const store = new FleetStore(path, {
    mac: { heavyLimit: 2, combinedLimit: 2 },
    hp: { heavyLimit: 2, combinedLimit: 2 },
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path };
}
for (const label of ["held:unreviewed-capture", "held:operator"]) {
  for (const role of ["builder", "verifier"]) {
    test(`authoritative ${label} blocks ${role}, permits inspection, and resumes only after protected release`, t => {
      const {store}=fixture(t);
      store.workflow.import(config,[{...item(),status:role==="builder"?"In Development":"In Code Review",labels:[label]}]);
      assert.deepEqual(store.start({...run(role),id:"held-request"}),{ok:false,reason:"locked"});
      assert.equal(store.start({...run("recovery"),resource:"heavy",id:"inspection"}).ok,true,"read-only recovery remains admitted");
      store.finish("mac","s","inspection");
      const current=store.workflow.get("org/mobile#1947");
      store.workflowOperator("org/mobile#1947",{removeLabels:[label]},"reviewed-release",current.revision);
      assert.equal(store.start({...run(role),id:"after-release"}).ok,true);
    });
  }
}

test("protected operator release retires only its obsolete recovery hold", t => {
  const { store } = fixture(t);
  const held = { ...item(), labels: ["needs-human:manual-takeover", "orchestrator:escalated"] };
  const other = { ...item(1948), labels: ["needs-human:decision"] };
  store.workflow.import(config, [held, other]);
  const observe = (i: WorkflowItem) => ({ ticket: `${config.project}#${i.issueNumber}`, status: i.status,
    labels: i.labels, blocked: false });
  store.recoveryReport("mac", config.project, [observe(held), observe(other)]);
  const incident = store.recovery.list().find(i => i.ticket === "org/mobile#1947")!;
  const unrelated = store.recovery.list().find(i => i.ticket === "org/mobile#1948")!;
  assert.equal(incident.reason, "Explicit operator hold");
  assert.equal(incident.current, true);

  const change = { status: "In Code Review", addLabels: ["done:builder"],
    removeLabels: ["needs-human:manual-takeover", "orchestrator:escalated"] };
  const released = store.workflowOperator("org/mobile#1947", change, "manual-release", held.revision);
  const history = store.recovery.list().find(i => i.id === incident.id)!;
  assert.equal(history.current, false, "the released hold must not be projected back onto the ticket");
  assert.equal(history.state, "resolved");
  assert.equal(history.reason, incident.reason, "retain the original hold evidence");
  assert.deepEqual(store.recovery.list().find(i => i.id === unrelated.id), unrelated);
  assert.deepEqual(store.recovery.escalatedTickets(), ["org/mobile#1948"]);
  assert.equal(store.start(run("verifier")).ok, true, "normal independent review remains required");
  store.finish("mac", "s", "verifier");

  const heldAgain = store.workflowOperator("org/mobile#1947", { addLabels: ["needs-human:decision"] },
    "new-human-hold", store.workflow.get("org/mobile#1947").revision);
  store.recoveryReport("mac", config.project, [observe(heldAgain), observe(other)]);
  const newIncident = store.recovery.list().find(i => i.ticket === "org/mobile#1947" && i.current)!;
  store.workflowOperator("org/mobile#1947", change, "manual-release", held.revision);
  assert.deepEqual(store.recovery.list().find(i => i.id === newIncident.id), newIncident,
    "replaying the old release must not clear a later human hold");
});

test("operator hold release preserves remaining blockers and rejects stale revisions", t => {
  for (const remaining of ["needs-human:decision", "error:builder:permission_denied", "error:builder", "halted", "dependency"]) {
    const { store } = fixture(t);
    const held = { ...item(), status: remaining === "halted" ? "Halted" : "In Code Review",
      labels: ["needs-human:manual-takeover", ...(!["halted", "dependency"].includes(remaining) ? [remaining] : [])],
      blockedBy: remaining === "dependency" ? [{ number: 1948, state: "OPEN" as const }] : [] };
    store.workflow.import(config, [held]);
    store.recoveryReport("mac", config.project, [{ ticket: "org/mobile#1947", status: held.status,
      labels: held.labels, blocked: remaining === "dependency" }]);
    const incident = store.recovery.list()[0];
    assert.throws(() => store.workflowOperator("org/mobile#1947", { removeLabels: ["needs-human:manual-takeover"] },
      `stale-${remaining}`, 0), /Workflow changed/);
    assert.deepEqual(store.recovery.list()[0], incident, "a rejected release changes no recovery evidence");
    store.workflowOperator("org/mobile#1947", { removeLabels: ["needs-human:manual-takeover"] },
      `release-${remaining}`, held.revision);
    assert.deepEqual(store.recovery.list()[0], incident, `preserve unresolved ${remaining}`);
    assert.equal(store.start(run("verifier")).ok, false);
  }
});

test("protected release reconciles a hold retained by an older workflow command", t => {
  const { store } = fixture(t);
  const held = { ...item(), status: "In Code Review", labels: ["needs-human:manual-takeover"] };
  store.workflow.import(config, [held]);
  store.recoveryReport("mac", config.project, [{ ticket: "org/mobile#1947", status: held.status,
    labels: held.labels, blocked: false }]);
  const incident = store.recovery.list()[0];
  // Reproduce the durable state left by the old operator path: the label is
  // already absent, but the separate recovery marker is still current.
  const legacy = store.workflow.change("org/mobile#1947", { labels: [] }, "operator", "legacy-release", 1);
  assert.equal(store.recovery.list()[0].current, true);
  store.workflowOperator("org/mobile#1947", { removeLabels: ["needs-human:manual-takeover"] },
    "confirmed-release", legacy.revision);
  assert.equal(store.recovery.list().find(i => i.id === incident.id)!.current, false);
});

test("full-label protected release preserves a human recovery decision", t => {
  const { store } = fixture(t);
  const failed = { ...item(), labels: ["error:builder"] };
  store.workflow.import(config, [failed]);
  const [incident] = store.recoveryReport("mac", config.project, [{ ticket: "org/mobile#1947",
    status: failed.status, labels: failed.labels, blocked: false }]);
  store.recovery.begin(incident.id, "assessment");
  store.recovery.decide(incident.id, "assessment", { action: "escalate", category: "human",
    reason: "A separate approval refusal remains unresolved" });
  const held = store.workflowOperator("org/mobile#1947", { labels: ["needs-human:manual-takeover"] },
    "manual-custody", failed.revision);
  const assessed = store.recovery.list().find(i => i.id === incident.id)!;
  store.workflowOperator("org/mobile#1947", { labels: [] }, "release-labels", held.revision);
  assert.deepEqual(store.recovery.list().find(i => i.id === incident.id), assessed);
});

test("1947 completes and routes for rework while GitHub is unavailable", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  assert.equal(store.start(run()).ok, true);
  store.workflowChange(
    "mac",
    "s",
    "builder",
    "org/mobile#1947",
    { addLabels: ["wip:builder", "done:builder"] },
    "built",
  );
  store.finish("mac", "s", "builder");
  const beforeReview = store.workflow.get("org/mobile#1947");
  assert(!beforeReview.labels.includes("wip:builder"));
  const advance = decideAutoAdvance(
    [
      {
        from: "In Development",
        readyLabel: "done:builder",
        to: "In Code Review",
      },
    ],
    new Set(),
    new Map([["In Development", [beforeReview]]]),
    1,
    2,
  );
  assert.equal(advance.advances[0].toColumn, "In Code Review");
  store.workflowChange(
    "mac",
    "s",
    undefined,
    "org/mobile#1947",
    { status: "In Code Review" },
    "review-stage",
  );
  assert.equal(store.start(run("verifier")).ok, true);
  store.workflowChange(
    "mac",
    "s",
    "verifier",
    "org/mobile#1947",
    { addLabels: ["wip:verifier", "needs-rework:builder"] },
    "failed-review",
  );
  store.finish("mac", "s", "verifier");
  const routes = decideReworkRoutes(
    new Map([["builder", "In Development"]]),
    new Map([["In Code Review", [store.workflow.get("org/mobile#1947")]]]),
  );
  assert.equal(routes[0].toColumn, "In Development");
  const github = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async () => new Response("unavailable", { status: 503 }),
  });
  await assert.rejects(new WorkflowPublisher(store, github).tick());
  assert.equal(store.workflow.get("org/mobile#1947").status, "In Code Review");
  assert(store.workflow.pending().length > 0);
  assert.equal(store.snapshot().runs.length, 0);
});
test("adopted workflow ignores manual GitHub state and survives a database restart", (t) => {
  const { store, path } = fixture(t);
  store.workflow.import(config, [
    { ...item(), labels: ["needs-human:decision"], status: "Halted" },
  ]);
  store.workflow.observe(config.project, [
    {
      ...item(),
      labels: [],
      title: "Changed description title",
      status: "Done",
      state: "CLOSED",
    },
  ]);
  const reopened = new FleetStore(path, {
    mac: { heavyLimit: 2, combinedLimit: 2 },
  });
  t.after(() => reopened.close());
  const saved = reopened.workflow.get("org/mobile#1947");
  assert.equal(saved.status, "Halted");
  assert.equal(saved.state, "OPEN");
  assert.deepEqual(saved.labels, ["needs-human:decision"]);
  assert.equal(saved.title, "Changed description title");
  assert.throws(
    () => reopened.workflow.import(config, [item()]),
    /already imported/,
  );
});
test("commands are replay safe and a late publication cannot acknowledge newer state", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  const changed = store.workflowOperator(
    "org/mobile#1947",
    { status: "Halted" },
    "pause",
    1,
  );
  assert.deepEqual(
    store.workflowOperator("org/mobile#1947", { status: "Halted" }, "pause", 1),
    changed,
  );
  assert.throws(
    () =>
      store.workflowOperator("org/mobile#1947", { status: "Done" }, "stale", 1),
    /changed/,
  );
  store.workflow.published("org/mobile#1947", 1);
  assert.equal(store.workflow.pending()[0].item.revision, 2);
});
test("active and foreign workers cannot be overwritten; old completion cannot clear a new run", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  store.start(run());
  assert.throws(
    () =>
      store.workflowOperator("org/mobile#1947", { status: "Done" }, "bad", 1),
    /active reservation/,
  );
  assert.throws(() =>
    store.workflowChange(
      "hp",
      "s",
      "builder",
      "org/mobile#1947",
      { status: "Done" },
      "foreign",
    ),
  );
  store.finish("mac", "s", "builder");
  store.start({ ...run(), id: "new" });
  store.workflowChange(
    "mac",
    "s",
    "new",
    "org/mobile#1947",
    { addLabels: ["wip:builder"] },
    "running",
  );
  store.finish("mac", "s", "builder");
  assert(store.workflow.get("org/mobile#1947").labels.includes("wip:builder"));
});
test("project import is refused while a run is reserved", (t) => {
  const { store } = fixture(t);
  store.start(run());
  assert.throws(() => store.workflow.import(config, [item()]), /Drain/);
  assert(!store.workflow.enabled(config.project));
});
test("old dispatchers cannot obtain new reservations after authority migration", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  const { workflowVersion, ...old } = run();
  assert.deepEqual(store.start(old), { ok: false, reason: "locked" });
});
test("dependency release reads the database while the GitHub display remains open", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [
    { ...item(), blockedBy: [{ number: 2, state: "OPEN" }] },
    item(2),
  ]);
  assert.deepEqual(store.start(run()), { ok: false, reason: "locked" });
  store.workflowOperator(
    "org/mobile#2",
    { state: "CLOSED", status: "Done" },
    "close-blocker",
    1,
  );
  assert.equal(
    store.workflow.get("org/mobile#1947").blockedBy[0].state,
    "CLOSED",
  );
  assert.equal(store.start(run()).ok, true);
});
test("a late worker mutation is refused even between runs", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  store.start(run());
  store.finish("mac", "s", "builder");
  assert.throws(
    () =>
      store.workflowChange(
        "mac",
        "s",
        "builder",
        "org/mobile#1947",
        { status: "Done" },
        "late",
      ),
    /finished/,
  );
});
test("partial GitHub publication retains pending state and a retry converges", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  let fail = true,
    writes = 0;
  const github = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async (input, init) => {
      const path = String(input),
        body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.includes("/labels")) return new Response("[]");
      if (body.query?.startsWith("mutation {")) {
        writes++;
        return new Response(
          JSON.stringify(
            fail
              ? {
                  data: { i0: { issue: { id: "I1947" } } },
                  errors: [{ message: "status unavailable" }],
                }
              : {
                  data: {
                    i0: { issue: { id: "I1947" } },
                    s0: { projectV2Item: { id: "P1947" } },
                  },
                },
          ),
        );
      }
      if (body.query?.startsWith("query($ids:"))
        return new Response(
          JSON.stringify({ data: { nodes: [remoteMetadata(item())] } }),
        );
      if (body.query?.startsWith("query($id:ID!)"))
        return new Response(
          JSON.stringify({
            data: {
              node: {
                blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          }),
        );
      if (body.query?.includes("repository"))
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                issues: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          }),
        );
      throw new Error("Unexpected GitHub request");
    },
  });
  const publisher = new WorkflowPublisher(store, github);
  await assert.rejects(publisher.tick(), /incomplete/);
  assert.equal(store.workflow.pending().length, 1);
  fail = false;
  await publisher.tick();
  assert.equal(store.workflow.pending().length, 0);
  assert.equal(writes, 2);
});
test("a newer database update during publication stays queued", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  const github = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (String(input).includes("/labels")) return new Response("[]");
      if (body.query?.startsWith("mutation {")) {
        store.workflowOperator(
          "org/mobile#1947",
          { status: "Halted" },
          "pause-during-publish",
          1,
        );
        return new Response(
          JSON.stringify({
            data: {
              i0: { issue: { id: "I1947" } },
              s0: { projectV2Item: { id: "P1947" } },
            },
          }),
        );
      }
      if (body.query?.startsWith("query($ids:"))
        return new Response(
          JSON.stringify({ data: { nodes: [remoteMetadata(item())] } }),
        );
      if (body.query?.startsWith("query($id:ID!)"))
        return new Response(
          JSON.stringify({
            data: {
              node: {
                blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          }),
        );
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              issues: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        }),
      );
    },
  });
  await new WorkflowPublisher(store, github).tick();
  assert.equal(store.workflow.pending()[0].item.status, "Halted");
});
test("existing agent GraphQL labels write to the database without writing GitHub", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  store.start(run());
  const requests: string[] = [];
  const github = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async (input, init) => {
      requests.push(String(init?.method));
      return new Response(
        JSON.stringify([{ id: 1, node_id: "L", name: "needs-rework:builder" }]),
      );
    },
  });
  const bridge = new WorkflowGitHub(store, github);
  const request = {
    method: "POST",
    path: "/graphql",
    body: JSON.stringify({
      query:
        "mutation($input:AddLabelsToLabelableInput!){a:addLabelsToLabelable(input:$input){labelable{id}}}",
      variables: { input: { labelableId: "I1947", labelIds: ["L"] } },
    }),
  };
  await bridge.request("org/mobile", request, {
    machine: "mac",
    session: "s",
    runId: "builder",
  });
  assert.deepEqual(store.workflow.get("org/mobile#1947").labels, [
    "needs-rework:builder",
  ]);
  assert.deepEqual(requests, ["GET"]);
  await assert.rejects(bridge.request("org/mobile", request), /owning run/);
});
test("dispatcher reads and changes workflow through the central API with no GitHub dependency", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  store.start(run());
  const server = await serveFleet(store, { mac: "machine" }, "operator", 0);
  t.after(() => server.close());
  const port = (server.address() as any).port,
    connection = new JsonClient(`http://127.0.0.1:${port}`, "machine");
  const base = {
    getAllProjectItems: async (): Promise<WorkflowItem[]> => {
      throw new Error("GitHub must not be read");
    },
    addLabel: async (_n: number, _label: string): Promise<void> => {
      throw new Error("GitHub must not be written");
    },
  };
  const client = workflowClient(
    base,
    connection,
    config.project,
    () => true,
    () => ({ session: "s", runId: "builder" }),
  );
  await client.addLabel(1947, "done:builder");
  assert.deepEqual((await client.getAllProjectItems())[0].labels, [
    "done:builder",
  ]);
});
test("a PR comment bypasses the workflow store; the store still refuses a PR as a ticket (#2148 / PR #2150)", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item(), item(2148)]);
  assert.equal(store.start(run()).ok, true);
  const server = await serveFleet(store, { mac: "machine" }, "operator", 0);
  t.after(() => server.close());
  const connection = new JsonClient(`http://127.0.0.1:${(server.address() as any).port}`, "machine");
  const posted: Array<[number, number, string]> = [];
  const client = workflowClient(
    {
      addComment: async (_n: number, _body: string): Promise<void> => {
        throw new Error("GitHub must not be written for a ticket comment");
      },
      addPullRequestComment: async (n: number, pr: number, body: string): Promise<void> => {
        posted.push([n, pr, body]);
      },
    },
    connection,
    config.project,
    () => true,
    () => ({ session: "s", runId: "builder" }),
  );
  await assert.rejects(client.addComment(2150, "verdict"), /Unknown workflow ticket/);
  await client.addPullRequestComment(2148, 2150, "verdict");
  assert.deepEqual(posted, [[2148, 2150, "verdict"]]);
  assert.equal(store.workflow.comments("org/mobile#2148").length, 0, "nothing queued on the ticket");
  assert.equal(store.workflow.pendingComments().length, 0);
});
test("PR comment ownership refuses a finished run but lets the claim holder's sweep through (#2148 / PR #2150)", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  assert.equal(store.start(run()).ok, true);
  const server = await serveFleet(store, { mac: "machine" }, "operator", 0);
  t.after(() => server.close());
  const connection = new JsonClient(`http://127.0.0.1:${(server.address() as any).port}`, "machine");
  const check = (runId?: string) =>
    connection.call("/workflow/authorize", { project: config.project, session: "s", ticket: "org/mobile#1947", runId });
  // While the run is admitted, its own error path may post.
  assert.deepEqual(await check("builder"), { ok: true });
  store.finish("mac", "s", "builder");
  // Plain /authorize still answers with the machine's claim for the
  // finished run's id; the workflow check does not.
  await connection.call("/authorize", { session: "s", ticket: "org/mobile#1947", runId: "builder" });
  await assert.rejects(check("builder"), /finished or lost ownership/);
  // The pending-verdict sweep has no admitted run: the claim decides.
  assert.deepEqual(await check(), { ok: true });
  // Another session on the same machine cannot borrow the finished run's id.
  await assert.rejects(
    connection.call("/workflow/authorize", { project: config.project, session: "other", ticket: "org/mobile#1947", runId: "builder" }),
    /finished or lost ownership/,
  );
});
test("a finished worker cannot enqueue a late result comment", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  store.start(run());
  store.finish("mac", "s", "builder");
  assert.throws(
    () =>
      store.workflowComment(
        "mac",
        "s",
        "builder",
        "org/mobile#1947",
        "stale verdict",
        "late-comment",
      ),
    /finished/,
  );
  assert.equal(store.workflow.comments("org/mobile#1947").length, 0);
});
test("a recreated board item is republished even when an old write finishes late", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  store.workflow.observe(config.project, [{ ...item(), id: "replacement" }]);
  store.workflow.published("org/mobile#1947", 1);
  assert.equal(store.workflow.pending()[0].item.id, "replacement");
  assert.equal(store.workflow.pending()[0].item.revision, 2);
});
test("cross-project blockers with the same number retain their own authoritative state", async (t) => {
  const { store } = fixture(t);
  const foreign = { ...config, project: "org/core", projectId: "CORE" };
  store.workflow.import(foreign, [
    {
      ...item(2),
      id: "CP2",
      issueId: "CI2",
      url: "https://github.com/org/core/issues/2",
      state: "CLOSED",
    },
  ]);
  store.workflow.import(config, [
    item(2),
    {
      ...item(),
      blockedBy: [
        {
          number: 2,
          state: "OPEN",
          url: "https://github.com/org/core/issues/2",
        },
      ],
    },
  ]);
  const server = await serveFleet(store, { mac: "machine" }, "operator", 0);
  t.after(() => server.close());
  const connection = new JsonClient(
    `http://127.0.0.1:${(server.address() as any).port}`,
    "machine",
  );
  const client = workflowClient(
    {
      getOpenBlockers: async (_n: number): Promise<number[]> => {
        throw new Error("GitHub read");
      },
    },
    connection,
    config.project,
    () => true,
    () => ({ session: "s" }),
  );
  assert.deepEqual(await client.getOpenBlockers(1947), []);
});
test("GitHub reads overlay each blocker state without copying the parent state", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [
    { ...item(), blockedBy: [{ number: 2, state: "OPEN", url: item(2).url }] },
    { ...item(2), state: "CLOSED" },
  ]);
  const upstream = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async (input) =>
      new Response(
        String(input).includes("/labels")
          ? "[]"
          : JSON.stringify({
              data: {
                repository: {
                  issue: {
                    id: "I1947",
                    state: "OPEN",
                    blockedBy: {
                      nodes: [
                        {
                          id: "I2",
                          number: 2,
                          state: "OPEN",
                          url: item(2).url,
                        },
                      ],
                    },
                  },
                },
              },
            }),
      ),
  });
  const bridge = new WorkflowGitHub(store, upstream);
  const result = await bridge.request(config.project, {
    method: "POST",
    path: "/graphql",
    body: JSON.stringify({
      query:
        'query{repository(owner:"org",name:"mobile"){issue(number:1947){id state blockedBy(first:100){nodes{id number state url}}}}}',
    }),
  });
  assert.equal(
    JSON.parse(result.body).data.repository.issue.blockedBy.nodes[0].state,
    "CLOSED",
  );
});
test("REST workflow labels can commit during a GitHub outage", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  store.start(run());
  const upstream = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async () => {
      throw new Error("GitHub offline");
    },
  });
  const result = await new WorkflowGitHub(store, upstream).request(
    config.project,
    {
      method: "POST",
      path: "/repos/org/mobile/issues/1947/labels",
      body: JSON.stringify({ labels: ["done:builder"] }),
    },
    { machine: "mac", session: "s", runId: "builder" },
  );
  assert.equal(result.status, 200);
  assert(store.workflow.get("org/mobile#1947").labels.includes("done:builder"));
});
test("central migration preparation lets existing work finish and blocks new admission until activation", (t) => {
  const { store } = fixture(t);
  assert.equal(store.start(run()).ok, true);
  store.workflow.prepare(config.project);
  assert.deepEqual(
    store.start({ ...run("verifier"), ticket: "org/mobile#2" }),
    { ok: false, reason: "locked" },
  );
  assert.throws(() => store.workflow.import(config, [item()]), /Drain/);
  store.finish("mac", "s", "builder");
  store.workflow.import(config, [item()]);
  assert.deepEqual(store.start({ ...run(), id: "next" }), {
    ok: false,
    reason: "locked",
  });
  assert.throws(
    () => store.workflow.cancelPreparation(config.project),
    /cannot revert/,
  );
  store.workflow.activate(config.project);
  assert.equal(store.start({ ...run(), id: "next" }).ok, true);
});
test("migration exports closed family history instead of resetting its counters", async (t) => {
  const { GitHubProjectClient } = await import("./github.js");
  const { store } = fixture(t),
    source = new GitHubProjectClient({
      owner: "org",
      repo: "mobile",
      ownerType: "organization",
      projectNumber: 1,
      token: "test",
    });
  source.initializeFromWorkflow(config);
  const closed = { ...item(), state: "CLOSED" as const };
  (source as any).fetchOpenIssueItems = async () => [];
  (source as any).getAllItems = async () => [closed];
  (source as any).gql = async () => ({
    nodes: [
      {
        ...closed,
        id: closed.issueId,
        number: closed.issueNumber,
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    ],
  });
  (source as any).fetchIssueCommentsPage = async () => ({
    comments: [
      {
        node_id: "closed-history",
        body: "retained family dispatch receipt",
        created_at: "2026-10-12T12:00:00Z",
      },
    ],
    lastPage: 1,
  });
  const snapshot = await source.workflowExport();
  store.workflow.import(
    snapshot.config,
    snapshot.items as WorkflowItem[],
    snapshot.comments,
  );
  assert.equal(
    store.workflow.comments("org/mobile#1947")[0].body,
    "retained family dispatch receipt",
  );
});
test("existing board-after helper changes authoritative order", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item(), item(2), item(3)]);
  store.start(run());
  const upstream = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async () => {
      throw new Error("Display must not be written inline");
    },
  });
  await new WorkflowGitHub(store, upstream).request(
    config.project,
    {
      method: "POST",
      path: "/graphql",
      body: JSON.stringify({
        query:
          "mutation($input:UpdateProjectV2ItemPositionInput!){updateProjectV2ItemPosition(input:$input){items{nodes{id}}}}",
        variables: {
          input: { projectId: "P", itemId: "P1947", afterId: "P2" },
        },
      }),
    },
    { machine: "mac", session: "s", runId: "builder" },
  );
  assert.deepEqual(
    store.workflow.list(config.project).map((i) => i.issueNumber),
    [2, 1947, 3],
  );
});
test("publication and discovery wait until a prepared migration is activated", async (t) => {
  const { store } = fixture(t);
  store.workflow.prepare(config.project);
  store.workflow.import(config, [item()]);
  let calls = 0;
  const github = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async () => {
      calls++;
      throw new Error("Migration is held");
    },
  });
  await new WorkflowPublisher(store, github).tick();
  assert.equal(calls, 0);
  assert.equal(store.workflow.pending().length, 1);
});
test("discovery does not re-adopt archived closed board items", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, []);
  const issue = {
    id: "I2",
    number: 2,
    title: "Archived work",
    body: "",
    url: item(2).url,
    state: "CLOSED",
    labels: {
      nodes: [{ name: "done:builder" }],
      pageInfo: { hasNextPage: false },
    },
    blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
    projectItems: {
      nodes: [
        { id: "P2", project: { id: "P" }, fieldValueByName: { name: "Done" } },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
  const github = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async () =>
      new Response(
        JSON.stringify({
          data: {
            repository: {
              issues: { nodes: [issue], pageInfo: { hasNextPage: false } },
            },
          },
        }),
      ),
  });
  await new WorkflowPublisher(store, github).refresh(config);
  assert.equal(store.workflow.list(config.project).length, 0);
});
test("GitHub read overlays do not scan ticket JSON for objects without an identity", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item()]);
  const db = (store.workflow as any).db,
    original = db.prepare;
  let calls = 0;
  db.prepare = function (...args: any[]) {
    calls++;
    return original.apply(this, args);
  };
  assert.equal(store.workflow.find(""), undefined);
  assert.equal(calls, 0);
  db.prepare = original;
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM workflow_tickets WHERE json_extract(item,'$.id')=? OR json_extract(item,'$.issueId')=?",
    )
    .all("P1947", "I1947");
  assert(
    !plan.some((row: any) => row.detail.includes("SCAN workflow_tickets")),
  );
});

test("archived cards do not stall publication and restored cards regain their column", async (t) => {
  const { store } = fixture(t);
  const closed = { ...item(), state: "CLOSED" as const, status: "Done", positioned: true };
  store.workflow.import(config, [closed, item(2)]);
  let archived = true, positions = 0;
  const mutations: string[] = [];
  const github = new GitHubBroker({
    token: "test", projects: [config.project],
    fetcher: async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const query: string = body.query ?? "";
      if (String(input).includes("/labels")) return new Response("[]");
      if (query.startsWith("mutation {")) {
        mutations.push(query);
        if (archived && query.includes("s0:"))
          return Response.json({ errors: [{ message: "The item is archived and cannot be updated" }] });
        const data: Record<string, unknown> = {};
        for (const [n, i] of store.workflow.pending(10, config.project).entries()) {
          data[`i${n}`] = { issue: { id: i.item.issueId } };
          if (query.includes(`s${n}:`)) data[`s${n}`] = { projectV2Item: { id: i.item.id } };
        }
        return Response.json({ data });
      }
      if (query.startsWith("mutation($input:")) {
        assert.equal(archived, false);
        positions++;
        return Response.json({ data: { updateProjectV2ItemPosition: { items: { nodes: [] } } } });
      }
      if (query.startsWith("query($ids:")) {
        assert.match(query, /isArchived/);
        const old = remoteMetadata({ ...closed, status: archived ? "Inbox" : "Done" });
        Object.assign(old.projectItems.nodes[0], { isArchived: archived });
        return Response.json({ data: { nodes: [old, remoteMetadata(item(2))] } });
      }
      if (query.startsWith("query($id:ID!)"))
        return Response.json({ data: { node: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      if (query.includes("repository"))
        return Response.json({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      throw new Error("Unexpected request: " + query);
    },
  });
  const publisher = new WorkflowPublisher(store, github);
  await assert.rejects(publisher.tick(), /incomplete/);
  assert.equal(store.workflow.get("org/mobile#1947").archived, true);
  assert.equal(store.workflow.get("org/mobile#1947").status, "Done");
  await publisher.tick();
  assert.equal(store.workflow.pending().length, 0);
  assert.doesNotMatch(mutations[1], /s0:/);
  assert.match(mutations[1], /i0:/);
  assert.match(mutations[1], /s1:/);
  assert.equal(positions, 0);
  await publisher.refresh(config);
  assert.equal(store.workflow.pending().length, 0, "archived column mismatch must not queue forever");
  archived = false;
  await publisher.refresh(config);
  await publisher.tick();
  assert.match(mutations.at(-1)!, /s0:/);
  assert.equal(positions, 1);
  assert.equal(store.workflow.pending().length, 0);
});
test("bridge mutation responses carry only the fields the caller selected", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item(), item(2)]);
  store.start(run());
  const github = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async (input) => {
      if (String(input).includes("/labels"))
        return Response.json([{ id: 1, node_id: "L", name: "done:refiner" }]);
      throw new Error("Display must not be written inline");
    },
  });
  const bridge = new WorkflowGitHub(store, github);
  const actor = { machine: "mac", session: "s", runId: "builder" };
  const send = async (query: string, input: Record<string, unknown>) =>
    JSON.parse(
      (
        await bridge.request(
          config.project,
          { method: "POST", path: "/graphql", body: JSON.stringify({ query, variables: { input } }) },
          actor,
        )
      ).body,
    ).data;
  // The documents gh 2.88 sends for these commands, trimmed to their shape.
  assert.deepEqual(
    await send(
      "mutation UpdateItemValues($input:UpdateProjectV2ItemFieldValueInput!){updateProjectV2ItemFieldValue(input:$input){projectV2Item{content{__typename,... on DraftIssue{id,body,title},... on PullRequest{body,title,number,url,repository{nameWithOwner}},... on Issue{body,title,number,url,repository{nameWithOwner}}},id,fieldValues(first: 100){nodes{__typename}}}}}",
      { projectId: "P", itemId: "P1947", fieldId: "S", value: { singleSelectOptionId: "review" } },
    ),
    {
      updateProjectV2ItemFieldValue: {
        projectV2Item: {
          content: {
            __typename: "Issue",
            body: "Fix stale context",
            title: "Context reset",
            number: 1947,
            url: "https://github.com/org/mobile/issues/1947",
            repository: { nameWithOwner: "org/mobile" },
          },
          id: "P1947",
          fieldValues: null,
        },
      },
    },
  );
  assert.deepEqual(
    await send("mutation AddLabels($input:AddLabelsToLabelableInput!){addLabelsToLabelable(input:$input){__typename}}", { labelableId: "I1947", labelIds: ["L"] }),
    { addLabelsToLabelable: { __typename: "AddLabelsToLabelablePayload" } },
  );
  assert.deepEqual(
    await send("mutation CommentCreate($input:AddCommentInput!){addComment(input: $input){commentEdge{node{url}}}}", { subjectId: "I1947", body: "Split" }),
    { addComment: { commentEdge: { node: { url: "https://github.com/org/mobile/issues/1947" } } } },
  );
  assert.deepEqual(
    await send("mutation($input:UpdateProjectV2ItemPositionInput!){updateProjectV2ItemPosition(input:$input){clientMutationId}}", { projectId: "P", itemId: "P1947", afterId: "P2" }),
    { updateProjectV2ItemPosition: { clientMutationId: null } },
  );
  assert.deepEqual(
    await send("mutation($input:AddBlockedByInput!){addBlockedBy(input:$input){issue{number} blockingIssue{number url}}}", { issueId: "I1947", blockingIssueId: "I2" }),
    { addBlockedBy: { issue: { number: 1947 }, blockingIssue: { number: 2, url: "https://github.com/org/mobile/issues/2" } } },
  );
  assert.deepEqual(
    await send("mutation($input:UpdateProjectV2ItemPositionInput!){updateProjectV2ItemPosition(input:$input){items(first:1){nodes{id type}}}}", { projectId: "P", itemId: "P1947", afterId: "P2" }),
    { updateProjectV2ItemPosition: { items: { nodes: [{ id: "P1947", type: "ISSUE" }] } } },
  );
  assert.deepEqual(
    await send("mutation IssueClose($input:CloseIssueInput!){c:closeIssue(input: $input){issue{id ...on Labelable{labels(first:5){nodes{name}}}}}}", { issueId: "I1947", stateReason: "COMPLETED" }),
    { c: { issue: { id: "I1947", labels: { nodes: [{ name: "done:refiner" }] } } } },
  );
  const saved = store.workflow.get("org/mobile#1947");
  assert.equal(saved.status, "In Code Review");
  assert.equal(saved.state, "CLOSED");
  assert.deepEqual(saved.labels, ["done:refiner"]);
  assert.deepEqual(saved.blockedBy.map((b) => b.number), [2]);
  assert.equal(store.workflow.pendingComments().length, 1);
});

const PRIORITY = "orchestrator:recovery-priority",
  LEGACY = "orchestrator:fixing",
  REPAIRING = "wip:repair",
  LEGACY_REPAIRING = "orchestrator:repairing";
const events = (path: string, ticket: string) => {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare("SELECT actor,change FROM workflow_events WHERE ticket=? ORDER BY id")
      .all(ticket)
      .map((e) => ({ actor: String(e.actor), change: String(e.change) }));
  } finally {
    db.close();
  }
};
test("the saved fixing label migrates once at central start, keeps the old name for old dispatchers and records history", (t) => {
  const { store, path } = fixture(t);
  store.workflow.import(config, [
    { ...item(1947), labels: [LEGACY, "rework-count:2"] },
    { ...item(1948), labels: [LEGACY, PRIORITY] },
    { ...item(1949), labels: ["priority:high"] },
  ]);
  const open = () => {
    const s = new FleetStore(path, { mac: { heavyLimit: 2, combinedLimit: 2 } });
    t.after(() => s.close());
    return s;
  };
  const started = open();
  assert.deepEqual(started.workflow.get("org/mobile#1947").labels, [LEGACY, "rework-count:2", PRIORITY]);
  assert.equal(started.workflow.get("org/mobile#1947").revision, 2);
  assert.equal(started.workflow.get("org/mobile#1948").revision, 1, "an already migrated ticket is not touched");
  assert.equal(started.workflow.get("org/mobile#1949").revision, 1);
  assert.deepEqual(events(path, "org/mobile#1947"), [
    { actor: "migration:recovery-priority", change: JSON.stringify({ addLabels: [PRIORITY], removeLabels: [] }) },
  ]);
  // A second start and an explicit run change nothing.
  const restarted = open();
  assert.equal(restarted.workflow.migrateRecoveryPriority(), 0);
  assert.equal(restarted.workflow.get("org/mobile#1947").revision, 2);
  assert.equal(events(path, "org/mobile#1947").length, 1);
  // The later retirement removes the old name, also exactly once.
  assert.equal(restarted.workflow.migrateRecoveryPriority(true), 2);
  assert.equal(restarted.workflow.migrateRecoveryPriority(true), 0);
  assert.deepEqual(restarted.workflow.get("org/mobile#1947").labels, ["rework-count:2", PRIORITY]);
  assert.deepEqual(restarted.workflow.get("org/mobile#1948").labels, [PRIORITY]);
});
test("the saved orchestrator:repairing marker becomes wip:repair once at central start and is recorded", (t) => {
  const { store, path } = fixture(t);
  store.workflow.import(config, [
    { ...item(1947), labels: [PRIORITY, LEGACY, LEGACY_REPAIRING, "wip:builder"] },
    { ...item(1948), labels: [PRIORITY, REPAIRING] },
    { ...item(1949), labels: [LEGACY_REPAIRING, REPAIRING] },
    { ...item(1950), labels: ["priority:high"] },
  ]);
  const open = () => {
    const s = new FleetStore(path, { mac: { heavyLimit: 2, combinedLimit: 2 } });
    t.after(() => s.close());
    return s;
  };
  const started = open();
  assert.deepEqual(started.workflow.get("org/mobile#1947").labels, [PRIORITY, LEGACY, "wip:builder", REPAIRING]);
  assert.deepEqual(started.workflow.get("org/mobile#1948").labels, [PRIORITY, REPAIRING], "already migrated");
  assert.equal(started.workflow.get("org/mobile#1948").revision, 1);
  assert.deepEqual(started.workflow.get("org/mobile#1949").labels, [REPAIRING], "a ticket with both names keeps one");
  assert.equal(started.workflow.get("org/mobile#1950").revision, 1);
  assert.deepEqual(events(path, "org/mobile#1947"), [
    { actor: "migration:wip-repair", change: JSON.stringify({ addLabels: [REPAIRING], removeLabels: [LEGACY_REPAIRING] }) },
  ]);
  const restarted = open();
  assert.equal(restarted.workflow.migrateRepairing(), 0, "a converged store changes nothing");
  assert.equal(events(path, "org/mobile#1947").length, 1);
});
test("wip:repair does not lock the repair run out of admission, and any other wip label still does", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [{ ...item(1947), status: "In Development", labels: [PRIORITY, REPAIRING] }]);
  const ticket = "org/mobile#1947";
  store.workflow.change(ticket, { addLabels: ["wip:verifier"] }, "mac:s", "other-wip");
  assert.deepEqual(store.start({ ...run("blocked"), role: "builder", ticket }), { ok: false, reason: "locked" });
  store.workflow.change(ticket, { removeLabels: ["wip:verifier"] }, "mac:s", "other-wip-gone");
  assert.equal(store.start({ ...run("repair"), role: "builder", ticket }).ok, true, "the assigned run starts while the marker waits");
});
test("the repairing marker lasts from the handback until the assigned run ends, including an interrupted run", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item(1947), item(1950)]);
  const handback = (ticket: string) =>
    store.workflow.change(ticket, { addLabels: [PRIORITY, LEGACY, REPAIRING] }, "mac:s", `handback:${ticket}`);
  const labels = (ticket: string) => store.workflow.get(ticket).labels;

  // Normal run: waits for admission, runs, finishes.
  handback("org/mobile#1950");
  assert.deepEqual(store.workflow.settleRepairing(config.project), [], "waiting for its run keeps the marker");
  store.start({ ...run("normal"), role: "builder", ticket: "org/mobile#1950" });
  store.workflowChange("mac", "s", "normal", "org/mobile#1950", { addLabels: ["wip:builder"] }, "claim-1950");
  assert.deepEqual(store.workflow.settleRepairing(config.project), [], "a running repair keeps the marker");
  store.finish("mac", "s", "normal");
  assert.deepEqual(store.workflow.settleRepairing(config.project), ["org/mobile#1950"]);
  assert.deepEqual(labels("org/mobile#1950"), [PRIORITY, LEGACY], "recovery priority continues through later stages");

  // Interrupted run: the worker dies holding its reservation and its running label.
  handback("org/mobile#1947");
  store.start({ ...run("crashed"), role: "builder" });
  store.workflowChange("mac", "s", "crashed", "org/mobile#1947", { addLabels: ["wip:builder"] }, "claim-1947");
  assert.deepEqual(store.workflow.settleRepairing(config.project), [], "an uncertain worker still holds its run");
  store.free("org/mobile#1947", store.snapshot().claims.find((c) => c.ticket === "org/mobile#1947")!.generation, true);
  assert.deepEqual(store.workflow.settleRepairing(config.project), ["org/mobile#1947"]);
  assert.deepEqual(labels("org/mobile#1947"), [PRIORITY, LEGACY, "wip:builder"]);
  assert.deepEqual(store.workflow.settleRepairing(config.project), [], "settling is idempotent");

  // A later handback starts a new repair, and earlier runs do not end it.
  store.workflow.change("org/mobile#1947", { removeLabels: ["wip:builder"] }, "mac:s", "sweep");
  store.workflow.change("org/mobile#1947", { addLabels: [REPAIRING] }, "mac:s", "second-handback");
  assert.deepEqual(store.workflow.settleRepairing(config.project), []);
  assert.ok(labels("org/mobile#1947").includes(REPAIRING));
});
test("a legacy marker migrated while its run is live still settles when the run ends, under the new name", (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [item(1947)]);
  const ticket = "org/mobile#1947";
  store.workflow.change(ticket, { addLabels: [PRIORITY, LEGACY, LEGACY_REPAIRING] }, "mac:s", "old-handback");
  store.start({ ...run("legacy"), role: "builder", ticket });
  store.workflowChange("mac", "s", "legacy", ticket, { addLabels: ["wip:builder"] }, "claim-legacy");
  assert.equal(store.workflow.migrateRepairing(), 1, "central restart while the run is live");
  assert.ok(store.workflow.get(ticket).labels.includes(REPAIRING));
  assert.deepEqual(store.workflow.settleRepairing(config.project), [], "still running");
  store.finish("mac", "s", "legacy");
  assert.deepEqual(store.workflow.settleRepairing(config.project), [ticket], "the migration is not a new assignment");
  assert.ok(!store.workflow.get(ticket).labels.includes(REPAIRING));
  // A leftover old name from an older dispatcher settles too.
  store.workflow.change(ticket, { addLabels: [LEGACY_REPAIRING] }, "mac:s", "old-handback-2");
  store.start({ ...run("legacy2"), role: "builder", ticket });
  store.workflowChange("mac", "s", "legacy2", ticket, { addLabels: ["wip:builder"] }, "claim-legacy2");
  store.finish("mac", "s", "legacy2");
  assert.deepEqual(store.workflow.settleRepairing(config.project), [ticket]);
  assert.ok(!store.workflow.get(ticket).labels.includes(LEGACY_REPAIRING));
});
test("the publisher settles repair markers and creates the recovery labels with their colour and description", async (t) => {
  const { store } = fixture(t);
  store.workflow.import(config, [{ ...item(), labels: [PRIORITY, LEGACY, REPAIRING] }]);
  store.workflow.change("org/mobile#1947", { addLabels: [REPAIRING] }, "mac:s", "handback");
  store.workflow.change("org/mobile#1947", { addLabels: ["wip:builder"] }, "mac:s", "claim");
  store.workflow.change("org/mobile#1947", { removeLabels: ["wip:builder"] }, "mac:s", "release");
  const catalog: Array<{ id: number; node_id: string; name: string }> = [],
    created: Array<Record<string, string>> = [];
  const github = new GitHubBroker({
    token: "test",
    projects: ["org/mobile"],
    fetcher: async (input, init) => {
      const path = String(input),
        body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.includes("/labels") && init?.method === "POST") {
        created.push(body);
        catalog.push({ id: catalog.length + 1, node_id: `L${catalog.length + 1}`, name: body.name });
        return new Response(JSON.stringify(catalog.at(-1)), { status: 201 });
      }
      if (path.includes("/labels")) return new Response(JSON.stringify(catalog));
      if (body.query?.startsWith("mutation {"))
        return new Response(
          JSON.stringify({ data: { i0: { issue: { id: "I1947" } }, s0: { projectV2Item: { id: "P1947" } } } }),
        );
      if (body.query?.startsWith("query($ids:"))
        return new Response(JSON.stringify({ data: { nodes: [remoteMetadata(store.workflow.get("org/mobile#1947"))] } }));
      if (body.query?.startsWith("query($id:ID!)"))
        return new Response(
          JSON.stringify({ data: { node: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } } } }),
        );
      if (body.query?.includes("repository"))
        return new Response(
          JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } }),
        );
      throw new Error("Unexpected GitHub request");
    },
  });
  await new WorkflowPublisher(store, github).tick();
  assert.deepEqual(store.workflow.get("org/mobile#1947").labels, [PRIORITY, LEGACY]);
  assert.deepEqual(created, [
    {
      name: PRIORITY,
      color: "0B6E65",
      description: "Orchestrator repair assigned. Its stages get recovery priority until Done, a hold or a new error.",
    },
    { name: LEGACY, color: "0B6E65" },
  ]);
});

// Read the persisted rows, including publication state and command receipts.
function dependencyState(path: string) {
  const db = new DatabaseSync(path);
  try {
    return ["workflow_tickets", "workflow_events", "workflow_commands"].map(table =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  } finally { db.close(); }
}
const dependency = (number: number, project = config.project) =>
  ({ number, state: "OPEN" as const, url: `https://github.com/${project}/issues/${number}` });

test("new workflow dependency cycles reject the 3602/3603 aggregate loop atomically", t => {
  const { store, path } = fixture(t), ticket = "org/mobile#3603";
  store.workflow.import(config, [
    { ...item(3602), blockedBy: [dependency(3603), dependency(3604)] }, item(3603), item(3604),
  ]);
  const before = dependencyState(path);
  for (const blocker of [3602, 3603]) {
    assert.throws(() => store.workflowOperator(ticket, {
      blockedBy: [dependency(blocker)], status: "Halted", addLabels: ["error:real-claude-gate"], top: true,
    }, "reject-" + blocker, 1), /cycle/);
    assert.deepEqual(dependencyState(path), before, "rejection must retain rows, revisions, publication, events and receipts");
  }
  const valid = store.workflowOperator(ticket, { blockedBy: [dependency(3604)] }, "reject-3602", 1);
  assert.equal(valid.revision, 2, "a rejected command did not retain a receipt");
  assert.deepEqual(valid.blockedBy, [dependency(3604)]);
  assert.equal(events(path, ticket).length, 1);
  assert.deepEqual(store.workflowOperator(ticket, { blockedBy: [dependency(3604)] }, "reject-3602", 1), valid);
});

test("new workflow dependency cycles use known cross-repository paths and closed structural edges", t => {
  const { store } = fixture(t), foreign = "org/core";
  store.workflow.import(config, [item(3603), { ...item(3604), blockedBy: [dependency(3603, foreign)] }]);
  store.workflow.import({ ...config, project: foreign }, [{ ...item(3603), url: `https://github.com/${foreign}/issues/3603`,
    state: "CLOSED", blockedBy: [dependency(3603)] }]);
  assert.throws(() => store.workflowOperator("org/mobile#3603", { blockedBy: [dependency(3604)] }, "long-cycle", 1), /cycle/);
  // The same number in another repository is a different endpoint. An unknown
  // endpoint ends the known path, rather than becoming a fabricated self edge.
  const independent = store.workflowOperator("org/mobile#3603", { blockedBy: [dependency(3603, "org/unknown")] }, "unknown", 1);
  assert.equal(independent.blockedBy[0].url, "https://github.com/org/unknown/issues/3603");
});

test("new workflow dependency cycles preserve legacy updates, removals and exact receipts", t => {
  const { store } = fixture(t), ticket = "org/mobile#3603";
  store.workflow.import(config, [{ ...item(3602), blockedBy: [dependency(3603)] },
    { ...item(3603), blockedBy: [dependency(3602), dependency(3603)] }, item(3604)]);
  const changed = store.workflowOperator(ticket, { addLabels: ["error:real-claude-gate"] }, "legacy-label", 1);
  assert.equal(changed.revision, 2);
  const unchanged = store.workflowOperator(ticket, { blockedBy: changed.blockedBy }, "legacy-edges", 2);
  // A visited set terminates a known legacy loop unrelated to this new source.
  assert.equal(store.workflowOperator("org/mobile#3604", { blockedBy: [dependency(3602)] }, "valid-legacy-path", 1).revision, 2);
  const removed = store.workflowOperator(ticket, { blockedBy: [] }, "remove-legacy", unchanged.revision);
  assert.deepEqual(removed.blockedBy, []);
  assert.deepEqual(store.workflowOperator(ticket, { blockedBy: changed.blockedBy }, "legacy-edges", 2), unchanged);
});
