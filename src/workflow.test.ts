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
