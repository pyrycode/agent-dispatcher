// The claim service's tracker write (FleetStore.flakyTrack): an occurrence
// comment or a reopen into Backlog on a failure ticket the pipeline filed,
// usually another computer's.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { FleetStore, type StartRequest } from "./fleet-store.js";
import { FleetClient, JsonClient, serveFleet } from "./fleet-http.js";
import { workflowClient } from "./workflow-client.js";
import { ServiceError } from "./fleet-http.js";
import { flakyMarker } from "./flaky-tickets.js";
import { inheritedMarker } from "./inherited-tickets.js";
import type { WorkflowItem, WorkflowProject } from "./workflow-store.js";

const PROJECT = "org/desktop";
const NAME = "chat-history-recording.spec.ts › receipt saturation still saves a repeated page";
const config: WorkflowProject = {
  project: PROJECT, projectId: "P", statusFieldId: "S",
  options: { Inbox: "inbox", Backlog: "backlog", "In Development": "dev", "In Code Review": "review", Done: "done" },
};
const ticket = (n: number, over: Partial<WorkflowItem> = {}): WorkflowItem => ({
  id: `P${n}`, issueId: `I${n}`, issueNumber: n, title: `ticket ${n}`, body: "", url: `https://github.com/${PROJECT}/issues/${n}`,
  status: "In Development", labels: [], blockedBy: [], parentNumber: null, grandparentNumber: null, state: "OPEN", revision: 1, position: n,
  ...over,
});
const run = (id: string, machine: string, n: number, role = "builder"): StartRequest => ({
  workflowVersion: 1, id, machine, session: `s-${machine}`, project: PROJECT, ticket: `${PROJECT}#${n}`, role, resource: "light", locks: [],
});

/** #1978 is a closed flaky ticket build-hp-1 fixed, so it still holds the claim; Fractal's verifier runs on #2001. */
function fixture() {
  const store = new FleetStore(":memory:", { "build-hp-1": { heavyLimit: 2, combinedLimit: 3 }, "build-fractal-2": { heavyLimit: 2, combinedLimit: 3 } });
  store.workflow.import(config, [
    ticket(1978, { body: `context\n${flakyMarker(NAME)}`, labels: ["bug", "flaky-test", "priority:low"] }),
    ticket(1947, { body: `context\n${inheritedMarker(NAME)}`, labels: ["bug", "priority:low"], state: "CLOSED", status: "Done" }),
    ticket(1990, { body: "a person's own bug, naming the test in prose only", labels: ["bug", "flaky-test"], state: "CLOSED", status: "Done" }),
    ticket(2001, { status: "In Code Review" }),
  ]);
  assert.equal(store.start(run("fix", "build-hp-1", 1978)).ok, true);
  store.finish("build-hp-1", "s-build-hp-1", "fix");
  store.workflow.change(`${PROJECT}#1978`, { state: "CLOSED", status: "Done", addLabels: ["merged", "done:verifier", "claim:build-hp-1"] }, "test", "close-1978");
  assert.equal(store.start(run("verify", "build-fractal-2", 2001, "verifier")).ok, true);
  return store;
}
const body = (over: Record<string, unknown> = {}) => ({
  ticket: `${PROJECT}#1978`, kind: "flaky", tests: [NAME], comment: "## Flaked again after this ticket closed", reopen: true,
  commandId: "cmd-1", runId: "verify", ...over,
});

test("reopens another computer's closed flaky ticket into Backlog, drops its stale labels and releases its claim", () => {
  const store = fixture();
  try {
    const result = store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT, body());
    assert.deepEqual({ state: result.state, status: result.status }, { state: "OPEN", status: "Backlog" });
    const item = store.workflow.get(`${PROJECT}#1978`);
    assert.deepEqual(item.labels.sort(), ["bug", "claim:build-hp-1", "flaky-test", "priority:low"], "the claim label is display, which the publisher then drops");
    assert.equal(store.snapshot().claims.find((c) => c.ticket === `${PROJECT}#1978`), undefined, "new work: the next free computer takes it");
    assert.deepEqual(store.workflow.unpublishedComments(`${PROJECT}#1978`).map((c: any) => c.body), ["## Flaked again after this ticket closed"]);
    assert.deepEqual(store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT, body()), result, "a retry answers as before");
    assert.equal(store.workflow.unpublishedComments(`${PROJECT}#1978`).length, 1, "and adds no second comment");
    assert.throws(() => store.workflowChange("build-hp-1", "s-build-hp-1", undefined, `${PROJECT}#2001`, { addLabels: ["x"] }, "other"),
      /belongs to another machine/, "ordinary writes still need ownership");
  } finally { store.close(); }
});

test("an occurrence comment on an open tracker, and a shared-failure tracker reopened at the top", () => {
  const store = fixture();
  try {
    store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT, body());
    store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT, body({ reopen: false, comment: "## Flaked again", commandId: "cmd-2" }));
    assert.equal(store.workflow.unpublishedComments(`${PROJECT}#1978`).length, 2);
    const inherited = store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT,
      body({ ticket: `${PROJECT}#1947`, kind: "inherited", top: true, commandId: "cmd-3" }));
    assert.equal(inherited.status, "Backlog");
    const positions = store.workflow.list(PROJECT).map((i) => i.issueNumber);
    assert.equal(positions[0], 1947, "at the top");
  } finally { store.close(); }
});

test("refuses anything but a pipeline tracker for these tests, written by an active run", () => {
  const store = fixture();
  const write = (over: Record<string, unknown>, machine = "build-fractal-2", session = "s-build-fractal-2") =>
    () => store.flakyTrack(machine, session, PROJECT, body(over));
  try {
    assert.throws(write({ runId: undefined }), /require an admitted run/);
    assert.throws(write({ runId: "fix" }), /finished or lost ownership/, "a finished run");
    assert.throws(write({}, "build-fractal-2", "other-session"), /finished or lost ownership/);
    assert.throws(write({ tests: ["other.spec.ts › something else"] }), /Not a tracker the pipeline filed/);
    assert.throws(write({ ticket: `${PROJECT}#1990` }), /Not a tracker the pipeline filed/, "no marker line");
    assert.throws(write({ ticket: `${PROJECT}#1947` }), /Not a tracker the pipeline filed/, "a shared-failure ticket is not a flaky one");
    assert.throws(write({ ticket: `org/other#1978` }), /Invalid tracker ticket/);
    assert.throws(write({ comment: "" }), /Invalid tracker comment/);
    assert.throws(write({ reopen: false }), /Tracker is closed/);
    store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT, body());
    assert.throws(write({ commandId: "cmd-9" }), /already open/);
    store.workflow.change(`${PROJECT}#1978`, { status: "In Development" }, "test", "develop-1978");
    const again = store.start(run("again", "build-hp-1", 1978)); assert.equal(again.ok, true, JSON.stringify(again));
    assert.throws(write({ reopen: false, commandId: "cmd-10" }), /Ticket has an active run/);
    assert.throws(() => store.flakyTrack("build-fractal-2", "s-build-fractal-2", "org/unadopted", body({ ticket: "org/unadopted#1" })), /Workflow not enabled/);
  } finally { store.close(); }
});

test("the tracker's own run may comment on it, and a reopen drops a needs-human hold", () => {
  const store = fixture();
  try {
    store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT, body());
    store.workflow.change(`${PROJECT}#1978`, { status: "In Development" }, "test", "develop");
    assert.equal(store.start(run("own", "build-fractal-2", 1978)).ok, true);
    store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT, body({ reopen: false, runId: "own", commandId: "own-comment" }));
    assert.throws(() => store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT, body({ reopen: false, commandId: "other-run" })), /Ticket has an active run/,
      "another run is still refused");

    store.workflow.change(`${PROJECT}#1947`, { addLabels: ["needs-human:triage", "done:builder"] }, "test", "hold-1947");
    store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT, body({ ticket: `${PROJECT}#1947`, kind: "inherited", commandId: "c-1947" }));
    assert.deepEqual(store.workflow.get(`${PROJECT}#1947`).labels.sort(), ["bug", "priority:low"]);

  } finally { store.close(); }
});

test("a reopen outside the window is refused when the close is recorded", () => {
  const store = fixture();
  try {
    (store as any).db.prepare("UPDATE workflow_events SET at=? WHERE ticket=?").run(Date.now() - 31 * 24 * 60 * 60 * 1000, `${PROJECT}#1978`);
    assert.throws(() => store.flakyTrack("build-fractal-2", "s-build-fractal-2", PROJECT, body()), /outside the reopen window/);
  } finally { store.close(); }
});

async function served(t: TestContext) {
  const store = fixture();
  const server = await serveFleet(store, { "build-hp-1": "hp-token", "build-fractal-2": "fractal-token" }, "admin-token", 0);
  t.after(async () => { await new Promise<void>((r) => server.close(() => r())); store.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { store, url: `http://127.0.0.1:${address.port}` };
}

test("over HTTP, a refused ownership keeps its marker, and the dispatcher's client reopens through it", async (t) => {
  const { store, url } = await served(t);
  const fractal = new FleetClient(url, "fractal-token");
  await assert.rejects(fractal.call("/flaky/track", { ...body({ runId: undefined }), project: PROJECT, session: "s-build-fractal-2" }),
    (e: unknown) => e instanceof ServiceError && e.status === 409 && (e.body as any).refused === "ownership");
  await assert.rejects(new FleetClient(url, "admin-token").call("/flaky/track", { ...body(), project: PROJECT }), /403/);

  // The workflow client the dispatcher wraps its GitHub client in, as on an adopted board.
  const base = { addComment: async () => { throw new Error("not on an adopted board"); } };
  const client = workflowClient(base as any, fractal as unknown as JsonClient, PROJECT, () => true, () => ({ session: "s-build-fractal-2", runId: "verify" }));
  await (client as any).reopenTracker({ number: 1978 }, "## Flaked again after this ticket closed", { kind: "flaky", tests: [NAME] });
  assert.equal(store.workflow.get(`${PROJECT}#1978`).state, "OPEN");
  await (client as any).commentOnTracker(1978, "## Flaked again", { kind: "flaky", tests: [NAME] });
  assert.equal(store.workflow.unpublishedComments(`${PROJECT}#1978`).length, 2);
});

test("on an adopted board the closed list trusts the store's state over GitHub's display", async () => {
  const items = [
    { ...ticket(1861, { body: flakyMarker(NAME), labels: ["flaky-test"] }), state: "OPEN" as const },
    { ...ticket(1978, { body: flakyMarker(NAME), labels: ["flaky-test"] }), state: "CLOSED" as const },
    { ...ticket(1700, { body: flakyMarker(NAME), labels: ["flaky-test"] }), state: "CLOSED" as const },
  ];
  const connection = { call: async (path: string) => { assert.equal(path, "/workflow/read"); return { items }; } };
  const base = {
    // GitHub still shows 1861 closed (reopened in the store) and 1978 open (closed in the store, not yet published).
    listRecentlyClosedIssuesWithLabel: async () => [{ number: 1861, body: "", closedAt: "2026-10-09T09:33:44Z" }],
    listOpenIssuesWithLabel: async () => [{ number: 1978, body: "" }],
  };
  const client = workflowClient(base as any, connection as unknown as JsonClient, PROJECT, () => true, () => ({ session: "s" }));
  const closed = await (client as any).listRecentlyClosedIssuesWithLabel("flaky-test", new Date(0));
  assert.deepEqual(closed.map((c: any) => c.number), [1978], "1861 is open in the store; 1700 closed long ago, GitHub agrees");
});

test("a claim service from before the route: the occurrence comment falls back, a reopen does not", async () => {
  const calls: string[] = [];
  const connection = {
    call: async (path: string) => {
      calls.push(path);
      if (path === "/flaky/track") throw new ServiceError(404, { error: "Unknown operation" }, "{}");
      return { ok: true };
    },
  };
  const client = workflowClient({} as any, connection as unknown as JsonClient, PROJECT, () => true, () => ({ session: "s", runId: "r" }));
  await (client as any).commentOnTracker(1978, "## Flaked again", { kind: "flaky", tests: [NAME] });
  assert.deepEqual(calls, ["/flaky/track", "/workflow/comment"]);
  await assert.rejects((client as any).reopenTracker({ number: 1978 }, "x", { kind: "flaky", tests: [NAME] }), /Service 404/);
  const legacy = workflowClient({} as any, connection as unknown as JsonClient, PROJECT, () => false, () => ({ session: "s" }));
  assert.equal((legacy as any).reopenTracker, undefined, "an unadopted board has no tracker write, so GitHub's steps are used");
});
