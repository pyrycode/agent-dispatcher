import { test } from "node:test";
import assert from "node:assert/strict";
import { ManagedDispatch, resourceClasses } from "./managed-dispatch.js";

test("resource classification rejects typos instead of treating them as light", () => {
  assert.deepEqual(resourceClasses(undefined), {});
  assert.deepEqual(resourceClasses('{"refiner":"light","builder":"heavy"}'), { refiner: "light", builder: "heavy" });
  assert.throws(() => resourceClasses('{"builder":"hevy"}'));
});
test("partial manager configuration never falls back to independent dispatch", () => {
  assert.equal(ManagedDispatch.fromEnv({}), null);
  assert.throws(() => ManagedDispatch.fromEnv({ PYRY_MANAGER_URL: "http://localhost:1" }));
  assert.throws(() => ManagedDispatch.fromEnv({ PYRY_MANAGED: "1" }));
});
test("managed client preserves synchronous helpers and rejects unseen item writes", async () => {
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test" });
  const base = { getRateLimit: () => ({ remaining: 42 }), updateItemStatus: async () => {}, clearItemsCache: () => {} };
  const client = managed.client(base);
  assert.deepEqual(client.getRateLimit(), { remaining: 42 });
  assert.equal(client.clearItemsCache(), undefined);
  await assert.rejects(client.updateItemStatus(), /outside the managed snapshot/);
});

test("ungranted offers follow updated ticket order without changing identity", () => {
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test" });
  const first = managed.offer(1, "builder", "heavy", [], 4);
  const next = managed.offer(1, "builder", "heavy", [], 0);
  assert.equal(first.offer.key, next.offer.key);
  assert.equal(next.offer.order, 0);
});

test("build agents default to medium and refinement to light, with explicit overrides", () => {
  const env = { PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test" };
  const managed = new ManagedDispatch("org/core", env);
  const item = { issueNumber: 1, labels: [] } as any;
  for (const [name, resource] of [["builder", "medium"], ["developer", "medium"], ["refiner", "light"], ["po", "light"], ["verifier", "heavy"], ["documentation", "light"], ["unknown", "heavy"]]) {
    assert.equal(managed.agentOffer({ name } as any, item, 0).offer.resource, resource, name);
  }
  const override = new ManagedDispatch("org/core", { ...env, PYRY_RESOURCE_CLASSES: '{"builder":"heavy","documentation":"medium"}' });
  assert.equal(override.agentOffer({ name: "builder" } as any, item, 0).offer.resource, "heavy");
  assert.equal(override.agentOffer({ name: "documentation" } as any, item, 0).offer.resource, "medium");
});


test("documentation is light but retains its board-wide serial restriction", () => {
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test" });
  const offer = managed.agentOffer({ name: "documentation", serial: true } as any, { issueNumber: 42, labels: [] } as any, 0).offer;
  assert.equal(offer.resource, "light");
  assert.equal(offer.roleLimit, 1);
  assert.deepEqual(offer.locks, ["org/core:role:documentation"]);
});


test("repair priority follows labels across builder, verification and live-gate offers", () => {
  const managed = new ManagedDispatch("org/core", {PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test"});
  const ticket = {issueNumber: 1, labels: ["orchestrator:fixing"]} as any;
  managed.setRecoveryTickets([ticket]);
  const gate = managed.offer(1, "real-claude-gate", "heavy");
  assert.equal(gate.offer.recovery, true);
  assert.equal(managed.agentOffer({name: "builder"} as any, ticket, 10).offer.recovery, true);
  assert.equal(managed.agentOffer({name: "verifier"} as any, ticket, 10).offer.recovery, true);
  managed.setRecoveryTickets([{...ticket, labels: []}]);
  assert.equal(gate.offer.recovery, false);
});

// Mobile #2148 / PR #2150, 2026-10-14: a saved verdict for a PR went to the
// workflow store as a ticket comment and was refused as an unknown ticket.
function prCommentClient(refuse?: string) {
  const managed = new ManagedDispatch("org/mobile", { PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test" });
  const calls: Array<{ path: string; ticket?: string; project?: string }> = [];
  (managed as any).connection = { call: async (path: string, body: any) => {
    calls.push({ path, ticket: body?.ticket, project: body?.project });
    if (refuse && path === "/workflow/authorize") throw new Error(refuse);
    return {};
  } };
  (managed as any).state = { ...(managed as any).state, workflowProjects: ["org/mobile"], claims: [], runs: [] };
  const posted: Array<[number, number, string]> = [];
  const base = {
    addComment: async (_n: number, _body: string): Promise<void> => { throw new Error("ticket comments must go to the store"); },
    addPullRequestComment: async (n: number, pr: number, body: string): Promise<void> => { posted.push([n, pr, body]); },
  };
  return { client: managed.client(base), calls, posted };
}

test("a PR comment is authorized like a workflow write on its ticket and goes to GitHub, not the store", async () => {
  const { client, calls, posted } = prCommentClient();
  await client.addPullRequestComment(2148, 2150, "## Verifier Review: #2148");
  assert.deepEqual(posted, [[2148, 2150, "## Verifier Review: #2148"]]);
  assert.deepEqual(calls, [{ path: "/workflow/authorize", ticket: "org/mobile#2148", project: "org/mobile" }],
    "the run-aware check on the ticket, and nothing reaches /workflow/comment");
  calls.length = 0;
  await client.addComment(2148, "ticket note");
  assert.deepEqual(calls.map(c => [c.path, c.ticket]), [["/authorize", "org/mobile#2148"], ["/workflow/comment", "org/mobile#2148"]], "ticket comments still go to the store");
});

test("a PR comment from a finished run is refused before anything reaches GitHub", async () => {
  const { client, posted } = prCommentClient("Service 409: Workflow run has finished or lost ownership");
  await assert.rejects(client.addPullRequestComment(2148, 2150, "late verdict"), /finished or lost ownership/);
  assert.deepEqual(posted, []);
});
