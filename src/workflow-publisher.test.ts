import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "./fleet-store.js";
import { GitHubBroker } from "./github-broker.js";
import { WorkflowPublisher, graphqlErrorText } from "./workflow-publisher.js";
import type { WorkflowItem, WorkflowProject } from "./workflow-store.js";

const config: WorkflowProject = {
  project: "org/relay",
  projectId: "P",
  statusFieldId: "S",
  options: { Inbox: "inbox", Backlog: "backlog", Done: "done" },
};
const url = (n: number) => `https://github.com/org/relay/issues/${n}`;
const item = (n: number, extra: Partial<WorkflowItem> = {}): WorkflowItem => ({
  id: `P${n}`,
  issueId: `I${n}`,
  issueNumber: n,
  title: `Ticket ${n}`,
  body: "",
  url: url(n),
  status: "Backlog",
  labels: [],
  blockedBy: [],
  parentNumber: null,
  grandparentNumber: null,
  state: "OPEN",
  revision: 1,
  position: n,
  ...extra,
});
const blocked = (...ns: number[]) =>
  ns.map((n) => ({ number: n, state: "OPEN" as const, url: url(n) }));

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "workflow-publisher-test-"));
  const store = new FleetStore(join(dir, "state.sqlite"), {
    mac: { heavyLimit: 2, combinedLimit: 2 },
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

/** A GitHub stand-in that enforces the GraphQL and dependency rules the publisher met in production. */
function fakeGitHub(
  store: FleetStore,
  options: {
    edges?: Record<string, string[]>;
    failAdd?: Set<string>;
    failAlias?: Set<string>;
    /** Answer requests whose query contains this text with an HTTP status instead. */
    unavailable?: { match: string; status: number };
    /** Answer addBlockedBy with "already been taken" without linking. */
    falselyTaken?: boolean;
  } = {},
) {
  const edges = new Map<string, Set<string>>(
    Object.entries(options.edges ?? {}).map(([k, v]) => [k, new Set(v)]),
  );
  const blockersOf = (id: string) => {
    if (!edges.has(id)) edges.set(id, new Set());
    return edges.get(id)!;
  };
  const calls: string[] = [];
  const validation = (field: string, message: string) =>
    Response.json({
      data: { [field]: null },
      errors: [{ type: "VALIDATION", path: [field], message }],
    });
  const github = new GitHubBroker({
    token: "test",
    projects: [config.project],
    fetcher: async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const query: string = body.query ?? "",
        v = body.variables ?? {};
      if (String(input).includes("/labels")) return new Response("[]");
      if (options.unavailable && query.includes(options.unavailable.match)) {
        calls.push(`unavailable ${options.unavailable.status}`);
        return new Response("unavailable", {
          status: options.unavailable.status,
          headers:
            options.unavailable.status === 429 ? { "retry-after": "60" } : {},
        });
      }
      if (query.startsWith("mutation {")) {
        const data: Record<string, unknown> = {},
          errors: unknown[] = [];
        for (const m of query.matchAll(
          /i(\d+):updateIssue\(input:\{id:"([^"]+)"/g,
        )) {
          calls.push(`issue ${m[2]}`);
          if (options.failAlias?.has(`i${m[1]}`)) {
            data[`i${m[1]}`] = null;
            errors.push({
              path: [`i${m[1]}`],
              message: "Could not resolve to a node",
            });
          } else data[`i${m[1]}`] = { issue: { id: m[2] } };
        }
        for (const m of query.matchAll(
          /s(\d+):updateProjectV2ItemFieldValue\(input:\{projectId:"[^"]+",itemId:"([^"]+)"/g,
        )) {
          if (options.failAlias?.has(`s${m[1]}`)) {
            data[`s${m[1]}`] = null;
            errors.push({
              path: [`s${m[1]}`],
              message: "The item is archived and cannot be updated",
            });
          } else data[`s${m[1]}`] = { projectV2Item: { id: m[2] } };
        }
        return Response.json(errors.length ? { data, errors } : { data });
      }
      if (query.includes("updateProjectV2ItemPosition")) {
        calls.push(`position ${v.input.itemId}`);
        calls.push(`after ${v.input.itemId} ${v.input.afterId ?? "top"}`);
        if (
          v.input.afterId &&
          store.workflow.find(v.input.afterId)?.item.archived
        )
          return validation(
            "updateProjectV2ItemPosition",
            "The item is archived and cannot be used as a position anchor",
          );
        if (!/items\((first|last):/.test(query))
          return Response.json({
            data: { updateProjectV2ItemPosition: { items: null } },
            errors: [
              {
                type: "MISSING_PAGINATION_BOUNDARIES",
                path: ["updateProjectV2ItemPosition", "items"],
                message:
                  "You must provide a `first` or `last` value to properly paginate the `items` connection.",
              },
            ],
          });
        return Response.json({
          data: { updateProjectV2ItemPosition: { items: { nodes: [] } } },
        });
      }
      if (query.includes("removeBlockedBy")) {
        calls.push(`remove ${v.issue}<-${v.blocker}`);
        blockersOf(v.issue).delete(v.blocker);
        return Response.json({
          data: { removeBlockedBy: { issue: { id: v.issue } } },
        });
      }
      if (query.includes("addBlockedBy")) {
        calls.push(`add ${v.issue}<-${v.blocker}`);
        if (options.failAdd?.has(v.issue))
          return validation(
            "addBlockedBy",
            "Resource not accessible by integration",
          );
        if (options.falselyTaken || blockersOf(v.issue).has(v.blocker))
          return validation(
            "addBlockedBy",
            "An error occurred while adding the blocking issue to the issue. Validation failed: Target issue has already been taken",
          );
        if (blockersOf(v.blocker).has(v.issue))
          return validation(
            "addBlockedBy",
            "An error occurred while adding the blocking issue to the issue. Validation failed: this dependency would create a cycle where the target is already blocked by the source",
          );
        blockersOf(v.issue).add(v.blocker);
        return Response.json({
          data: { addBlockedBy: { issue: { id: v.issue } } },
        });
      }
      if (query.startsWith("query($id:ID!)"))
        return Response.json({
          data: {
            node: {
              blockedBy: {
                nodes: [...blockersOf(v.id)].map((id) => ({
                  id,
                  number: Number(id.slice(1)),
                  url: url(Number(id.slice(1))),
                })),
                pageInfo: { hasNextPage: false },
              },
            },
          },
        });
      if (query.startsWith("query($ids:"))
        return Response.json({
          data: {
            nodes: v.ids.map((id: string) => {
              const i = store.workflow.find(id)!.item;
              return {
                id: i.issueId,
                number: i.issueNumber,
                title: i.title,
                body: i.body,
                url: i.url,
                state: i.state,
                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
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
            }),
          },
        });
      if (query.includes("repository"))
        return Response.json({
          data: {
            repository: {
              issues: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        });
      throw new Error("Unexpected GitHub request: " + query);
    },
  });
  return { github, edges, calls };
}

const pendingTickets = (store: FleetStore) =>
  store.workflow
    .pending(100)
    .map((p) => p.ticket)
    .sort();

test("GraphQL error text names the failing alias", () => {
  assert.equal(
    graphqlErrorText([
      { path: ["i3"], message: "Could not resolve" },
      { message: "Something else" },
    ]),
    "i3: Could not resolve; Something else",
  );
});

test("a repositioned ticket publishes with a bounded items page", async (t) => {
  const store = fixture(t);
  store.workflow.import(config, [item(1, { positioned: true }), item(2)]);
  const { github, calls } = fakeGitHub(store);
  await new WorkflowPublisher(store, github, { now: () => 1000 }).tick();
  assert.deepEqual(pendingTickets(store), []);
  assert.ok(calls.includes("position P1"));
});

test("archived neighbours do not hide a repositioned ticket's blockers", async (t) => {
  const store = fixture(t);
  store.workflow.import(config, [
    item(1),
    item(2, { archived: true }),
    item(3, { archived: true }),
    item(4, { positioned: true, blockedBy: blocked(5) }),
    item(5),
  ]);
  const { github, calls, edges } = fakeGitHub(store);
  await new WorkflowPublisher(store, github, { now: () => 1000 }).tick();
  assert.ok(calls.includes("after P4 P1"));
  assert.deepEqual([...edges.get("I4")!], ["I5"]);
  assert.deepEqual(pendingTickets(store), []);
  assert.equal(store.workflow.get("org/relay#2").archived, true);
  assert.equal(store.workflow.get("org/relay#3").archived, true);
});

test("a repositioned ticket uses the top when all preceding cards are archived", async (t) => {
  const store = fixture(t);
  store.workflow.import(config, [
    item(1, { archived: true }),
    item(2, { archived: true }),
    item(3, { positioned: true, blockedBy: blocked(4) }),
    item(4),
  ]);
  const { github, calls, edges } = fakeGitHub(store);
  await new WorkflowPublisher(store, github, { now: () => 1000 }).tick();
  assert.ok(calls.includes("after P3 top"));
  assert.deepEqual([...edges.get("I3")!], ["I4"]);
  assert.deepEqual(pendingTickets(store), []);
});

test("one failing ticket does not hold the rest of the batch and waits with backoff", async (t) => {
  const store = fixture(t);
  store.workflow.import(config, [
    item(1, { blockedBy: blocked(9) }),
    item(2),
    item(3),
    item(9),
  ]);
  let now = 1000;
  const { github, calls } = fakeGitHub(store, { failAdd: new Set(["I1"]) });
  const seen = (): string[] => calls;
  const publisher = new WorkflowPublisher(store, github, { now: () => now });
  await assert.rejects(
    publisher.tick(),
    /org\/relay#1 revision 1 \(attempt 1, retry in 30s\): Workflow display update incomplete: addBlockedBy: Resource not accessible by integration/,
  );
  assert.deepEqual(pendingTickets(store), ["org/relay#1"]);
  assert.deepEqual(
    publisher.retrying().map((r) => [r.ticket, r.attempts]),
    [["org/relay#1", 1]],
  );
  // Inside the backoff the failing ticket is not retried.
  calls.length = 0;
  now += 10_000;
  await publisher.tick();
  assert.deepEqual(calls, []);
  // After the backoff it is retried, and a second failure doubles the wait.
  now += 30_000;
  await assert.rejects(publisher.tick(), /attempt 2, retry in 60s/);
  assert.ok(seen().includes("add I1<-I9"));
});

test("a waiting ticket cannot starve tickets beyond the first ten", async (t) => {
  const store = fixture(t);
  const items = [
    item(1, { blockedBy: blocked(50) }),
    ...Array.from({ length: 10 }, (_, i) => item(i + 2)),
    item(50),
  ];
  store.workflow.import(config, items);
  const now = 1000;
  const { github } = fakeGitHub(store, { failAdd: new Set(["I1"]) });
  const publisher = new WorkflowPublisher(store, github, { now: () => now });
  await assert.rejects(publisher.tick());
  assert.equal(pendingTickets(store).length, 3);
  await publisher.tick();
  assert.deepEqual(pendingTickets(store), ["org/relay#1"]);
});

test("an error on one alias of the batch only holds that ticket", async (t) => {
  const store = fixture(t);
  store.workflow.import(config, [item(1), item(2), item(3)]);
  const { github } = fakeGitHub(store, { failAlias: new Set(["s1"]) });
  const publisher = new WorkflowPublisher(store, github, { now: () => 1000 });
  await assert.rejects(
    publisher.tick(),
    /org\/relay#2 .*s1: The item is archived/,
  );
  assert.deepEqual(pendingTickets(store), ["org/relay#2"]);
});

test("a reverse dependency the blocker no longer records is replaced by the wanted one", async (t) => {
  const store = fixture(t);
  // The database wants 167 blocked by 206. GitHub still shows the old link, 206 blocked by 167.
  store.workflow.import(config, [
    item(167, { blockedBy: blocked(206) }),
    item(206, { state: "CLOSED", status: "Done" }),
  ]);
  const { github, edges, calls } = fakeGitHub(store, {
    edges: { I206: ["I167"] },
  });
  await new WorkflowPublisher(store, github, { now: () => 1000 }).tick();
  assert.deepEqual(pendingTickets(store), []);
  assert.deepEqual([...edges.get("I167")!], ["I206"]);
  assert.deepEqual([...edges.get("I206")!], []);
  assert.deepEqual(
    calls.filter((c) => c.startsWith("add") || c.startsWith("remove")),
    ["add I167<-I206", "remove I206<-I167", "add I167<-I206"],
  );
});

test("a cycle the database itself records is reported without touching GitHub links", async (t) => {
  const store = fixture(t);
  store.workflow.import(config, [
    item(1, { blockedBy: blocked(2) }),
    item(2, { blockedBy: blocked(1) }),
    item(3),
  ]);
  const { github, edges } = fakeGitHub(store, { edges: { I2: ["I1"] } });
  await assert.rejects(
    new WorkflowPublisher(store, github, { now: () => 1000 }).tick(),
    /org\/relay#1 .*Dependency cycle/,
  );
  assert.deepEqual(pendingTickets(store), ["org/relay#1"]);
  assert.deepEqual([...edges.get("I2")!], ["I1"]);
});

test("a link another writer added first is accepted", async (t) => {
  const store = fixture(t);
  store.workflow.import(config, [item(1, { blockedBy: blocked(2) }), item(2)]);
  const { github, edges } = fakeGitHub(store);
  // Simulate a concurrent writer: the read sees no link, the add finds it present.
  let raced = false;
  const original = github.request.bind(github);
  github.request = async (project, request) => {
    const body = request.body ? JSON.parse(String(request.body)) : {};
    if (!raced && String(body.query ?? "").includes("addBlockedBy")) {
      raced = true;
      edges.get("I1")!.add("I2");
    }
    return original(project, request);
  };
  await new WorkflowPublisher(store, github, { now: () => 1000 }).tick();
  assert.deepEqual(pendingTickets(store), []);
});

for (const status of [502, 504, 429])
  test(`a GitHub ${status} on a per-ticket call holds the project's pass instead of each ticket`, async (t) => {
    const store = fixture(t);
    store.workflow.import(config, [
      item(1, { positioned: true }),
      item(2, { positioned: true }),
      item(3, { positioned: true }),
    ]);
    const { github, calls } = fakeGitHub(store, {
      unavailable: { match: "updateProjectV2ItemPosition", status },
    });
    const publisher = new WorkflowPublisher(store, github, { now: () => 1000 });
    await assert.rejects(publisher.tick(), {
      message: `Workflow display update deferred: GitHub ${status}`,
    });
    assert.equal(calls.filter((c) => c.startsWith("unavailable")).length, 1);
    assert.deepEqual(publisher.retrying(), []);
    assert.equal(pendingTickets(store).length, 3);
  });

test("an already-linked answer is only accepted when a re-read shows the link", async (t) => {
  const store = fixture(t);
  store.workflow.import(config, [item(1, { blockedBy: blocked(2) }), item(2)]);
  const { github, calls } = fakeGitHub(store, { falselyTaken: true });
  const publisher = new WorkflowPublisher(store, github, { now: () => 1000 });
  await assert.rejects(
    publisher.tick(),
    /org\/relay#1 .*has already been taken/,
  );
  assert.deepEqual(pendingTickets(store), ["org/relay#1"]);
  assert.ok(calls.includes("add I1<-I2"));
});
