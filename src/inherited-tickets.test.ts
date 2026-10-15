import { test } from "node:test";
import assert from "node:assert/strict";
import { recordInheritedTests, inheritedMarker, type InheritedTicketClient } from "./inherited-tickets.js";
import { failureTicketLabels, type ClosedTracker, type FlakyRunContext, type TrackerRef } from "./flaky-tickets.js";
import { decideInheritedAdvance } from "./pipeline-decisions.js";
import { parseGateOutput } from "./gate-output.js";
import { inheritedAdvanceEnabled } from "./dispatch.js";

const name = "p.C#permissionAnswer";
const ctx = { gatedIssue: 1397, at: "2026-10-01T18:00:00Z", report: {
  branchName: "feature/1397", headSha: "a".repeat(40), baseRef: "origin/main", baseSha: "b".repeat(40),
  outputPath: "/logs/live.log", baselineOutputPath: "/logs/base.log",
} } as FlakyRunContext;
class Client implements InheritedTicketClient {
  open: { number: number; nodeId: string; title?: string; body: string }[] = [];
  created: { number: number; nodeId: string; body: string; title: string }[] = [];
  statuses = new Map<number, string>();
  linked: number[] = [];
  positions: string[] = [];
  comments: { issue: number; body: string }[] = [];
  fail: "list" | "create" | "board" | "link" | null = null;
  async listOpenIssuesWithLabel(label: string) {
    assert.equal(label, "bug");
    if (this.fail === "list") throw Error("list failed");
    return this.open;
  }
  async createIssue(title: string, body: string, labels: string[] = []) {
    assert.deepEqual(labels, failureTicketLabels(["bug", "priority:low"]));
    assert.deepEqual(labels.slice(0, 2), ["bug", "priority:low"]);
    assert.match(labels[2], /^requires:(linux|macos)$/, "the system it was seen on");
    if (this.fail === "create") throw Error("create failed");
    const issue = { number: 1500 + this.created.length, nodeId: `node-${1500 + this.created.length}`, title, body };
    this.created.push(issue); this.open.push(issue);
    return { ...issue, url: "https://example.com" };
  }
  async addItemToProject(nodeId: string) {
    if (this.fail === "board") throw Error("board failed");
    return nodeId;
  }
  async getItemStatus(number: number) { return this.statuses.get(number) ?? null; }
  async updateItemStatus(item: string, status: string) { this.statuses.set(Number(item.slice(5)), status); }
  async addComment(issue: number, body: string) { this.comments.push({ issue, body }); }
  async moveItemToTop(item: string) { this.positions.push(item); }
  async addBlocker(parent: number, blocker: number) {
    assert.equal(parent, 1397);
    if (this.fail === "link") throw Error("link failed");
    this.linked.push(blocker);
  }
}

test("confirmed shared failure gets a runnable fix ticket with baseline evidence and a blocker", async () => {
  const client = new Client();
  const result = await recordInheritedTests(client, [name, name], ctx);
  assert.deepEqual(result, { blockers: [{ name, issue: 1500 }], untracked: [], owned: [] });
  assert.equal(client.created.length, 1);
  assert.equal(client.created[0].title, "fix shared live failure: permissionAnswer");
  assert.equal(client.statuses.get(1500), "Backlog");
  assert.match(client.created[0].body, /\/logs\/base.log/);
  assert.match(client.created[0].body, /bbbbbbbbbb/);
  assert.ok(client.created[0].body.includes(inheritedMarker(name)));
  assert.deepEqual(client.linked, [1500]);
});
test("later parents reuse the fix ticket and preserve its current progress", async () => {
  const client = new Client();
  client.open.push({ number: 1480, nodeId: "node-1480", body: inheritedMarker(name) });
  client.statuses.set(1480, "In Development");
  const result = await recordInheritedTests(client, [name], ctx);
  assert.deepEqual(result.blockers, [{ name, issue: 1480 }]);
  assert.equal(client.created.length, 0);
  assert.equal(client.statuses.get(1480), "In Development");
});
test("a hand-filed bug naming the exact qualified test is reused, but the parent is excluded", async () => {
  const client = new Client();
  client.open.push({ number: 1397, nodeId: "node-1397", body: `Repair \`${name}\`` },
    { number: 1481, nodeId: "node-1481", body: `Failing test: \`${name}Extra\`` },
    { number: 1482, nodeId: "node-1482", body: `Failing test: \`${name}\`` });
  const result = await recordInheritedTests(client, [name], ctx);
  assert.deepEqual(result.blockers, [{ name, issue: 1482 }]);
  assert.equal(client.created.length, 0);
});
test("a partial board write retries on the existing issue rather than duplicating it", async () => {
  const client = new Client(); client.fail = "board";
  assert.deepEqual((await recordInheritedTests(client, [name], ctx)).untracked, [name]);
  assert.deepEqual(client.linked, []);
  client.fail = null;
  assert.deepEqual((await recordInheritedTests(client, [name], ctx)).blockers, [{ name, issue: 1500 }]);
  assert.equal(client.created.length, 1);
});
test("failed listing creates nothing; failed linking never reports a confirmed blocker", async () => {
  const client = new Client(); client.fail = "list";
  assert.deepEqual((await recordInheritedTests(client, [name], ctx)).untracked, [name]);
  assert.equal(client.created.length, 0);
  client.fail = "link";
  assert.deepEqual((await recordInheritedTests(client, [name], ctx)).blockers, []);
});

test("a reused issue in Inbox becomes runnable instead of leaving its parent waiting for triage", async () => {
  const client = new Client();
  client.open.push({ number: 1480, nodeId: "node-1480", body: inheritedMarker(name) });
  client.statuses.set(1480, "Inbox");
  await recordInheritedTests(client, [name], ctx);
  assert.equal(client.statuses.get(1480), "Backlog");
});

test("the fix ticket's own inherited failure stays its responsibility instead of creating a child loop", async () => {
  const client = new Client();
  client.open.push({ number: 1397, nodeId: "node-1397", body: inheritedMarker(name) });
  const result = await recordInheritedTests(client, [name], ctx);
  assert.deepEqual(result.owned, [name]);
  assert.deepEqual(result.blockers, []);
  assert.equal(client.created.length, 0);
  assert.deepEqual(client.linked, []);
});

test("reuses the existing verifier tracker with a method-only title", async () => {
  const client = new Client();
  client.open.push({ number: 1480, nodeId: "node-1480", title: "permissionAnswerExtra: pre-existing failure", body: "old report" },
    { number: 1481, nodeId: "node-1481", title: "permissionAnswer: pre-existing failure unmasked", body: "old report" });
  const result = await recordInheritedTests(client, [name], ctx);
  assert.deepEqual(result.blockers, [{ name, issue: 1481 }]);
  assert.equal(client.created.length, 0);
});

test("multiple existing trackers reuse the oldest canonical ticket", async () => {
  const client = new Client();
  client.open.push({ number: 1482, nodeId: "node-1482", body: inheritedMarker(name) },
    { number: 1480, nodeId: "node-1480", body: inheritedMarker(name) });
  assert.deepEqual((await recordInheritedTests(client, [name], ctx)).blockers, [{ name, issue: 1480 }]);
  assert.equal(client.created.length, 0);
});

test("shared fix tickets in Backlog are promoted to its top; active fixes keep their position", async () => {
  const client = new Client();
  await recordInheritedTests(client, [name], ctx);
  assert.deepEqual(client.positions, ["node-1500"]);
  client.positions = [];
  await recordInheritedTests(client, [name], ctx);
  assert.deepEqual(client.positions, ["node-1500"], "an existing Backlog fix is promoted too");
  client.statuses.set(1500, "In Development"); client.positions = [];
  await recordInheritedTests(client, [name], ctx);
  assert.deepEqual(client.positions, []);
});

const [a, b, c] = ["p.C#questionAnswer", "p.C#markdownLink", "p.C#attentionDot"];

test("failures new in one run share one fix ticket that names and marks each test", async () => {
  const client = new Client();
  const result = await recordInheritedTests(client, [a, b, c], ctx);
  assert.equal(client.created.length, 1);
  assert.equal(client.created[0].title, "fix shared live failures: 3 tests fail on main");
  for (const n of [a, b, c]) {
    assert.ok(client.created[0].body.includes(`- \`${n}\``));
    assert.ok(client.created[0].body.split("\n").includes(inheritedMarker(n)));
  }
  assert.match(client.created[0].body, /\/logs\/base.log/);
  assert.equal(client.statuses.get(1500), "Backlog");
  assert.deepEqual(client.positions, ["node-1500"]);
  assert.deepEqual(client.linked, [1500]);
  assert.deepEqual(result, { blockers: [a, b, c].map(n => ({ name: n, issue: 1500 })), untracked: [], owned: [] });
});

test("grouped failures seen again comment once on their ticket and file nothing", async () => {
  const client = new Client();
  await recordInheritedTests(client, [a, b, c], ctx);
  client.linked = [];
  const result = await recordInheritedTests(client, [c, a], ctx);
  assert.equal(client.created.length, 1);
  assert.deepEqual(client.comments.map(x => x.issue), [1500]);
  assert.match(client.comments[0].body, /These 2 tests failed/);
  assert.deepEqual(client.linked, [1500]);
  assert.deepEqual(result.blockers, [{ name: c, issue: 1500 }, { name: a, issue: 1500 }]);
});

test("tracked failures keep their own tickets and only the untracked ones are grouped", async () => {
  const client = new Client();
  client.open.push({ number: 1480, nodeId: "node-1480", body: inheritedMarker(a) });
  const result = await recordInheritedTests(client, [a, b, c], ctx);
  assert.equal(client.created.length, 1);
  assert.equal(client.created[0].title, "fix shared live failures: 2 tests fail on main");
  assert.ok(!client.created[0].body.includes(inheritedMarker(a)));
  assert.deepEqual(client.comments.map(x => x.issue), [1480]);
  assert.deepEqual(client.linked, [1480, 1500]);
  assert.deepEqual(result.blockers, [{ name: a, issue: 1480 }, { name: b, issue: 1500 }, { name: c, issue: 1500 }]);
});

test("a failed grouped filing leaves every new test untracked and links nothing", async () => {
  const client = new Client(); client.fail = "create";
  const result = await recordInheritedTests(client, [a, b], ctx);
  assert.deepEqual(result, { blockers: [], untracked: [a, b], owned: [] });
  assert.deepEqual(client.linked, []);
});

// --------- Advance mode (2026-10-14) ---------

test("advance mode reuses an exactly-naming tracker, comments, and adds no blocker", async () => {
  const client = new Client();
  client.open.push({ number: 1480, nodeId: "node-1480", title: "repair it", body: `fails: \`${name}\`` });
  const result = await recordInheritedTests(client, [name], ctx, { advance: true });
  assert.deepEqual(result, { blockers: [], untracked: [], owned: [], tracked: [{ name, issue: 1480 }] });
  assert.deepEqual(client.linked, []);
  assert.equal(client.comments.length, 1);
  assert.equal(client.created.length, 0);
});
test("advance mode prefers a ticket naming the full test over an older loose title match", async () => {
  const client = new Client();
  client.open.push({ number: 1400, nodeId: "node-1400", title: "flaky permissionAnswer elsewhere", body: "other package" });
  client.open.push({ number: 1480, nodeId: "node-1480", body: `\`${name}\`` });
  const result = await recordInheritedTests(client, [name], ctx, { advance: true });
  assert.deepEqual(result.tracked, [{ name, issue: 1480 }]);
});
test("advance mode files a tracker with the marker when none exists, without a blocker", async () => {
  const client = new Client();
  const result = await recordInheritedTests(client, [name], ctx, { advance: true });
  assert.deepEqual(result.tracked, [{ name, issue: 1500 }]);
  assert.ok(client.created[0].body.includes(inheritedMarker(name)));
  assert.equal(client.statuses.get(1500), "Backlog");
  assert.deepEqual(client.linked, []);
});
test("advance mode falls back to blockers when filing fails, and never reports a tracker", async () => {
  const client = new Client();
  client.fail = "create";
  const result = await recordInheritedTests(client, [name], ctx, { advance: true });
  assert.equal(result.tracked, undefined);
  assert.deepEqual(result.untracked, [name]);
  assert.match(result.fallbackReason!, /no confirmed tracking ticket/);
});
test("advance mode falls back to a blocker when the board write for the tracker fails", async () => {
  const client = new Client();
  client.open.push({ number: 1480, nodeId: "node-1480", body: inheritedMarker(name) });
  client.fail = "board";
  const result = await recordInheritedTests(client, [name], ctx, { advance: true });
  assert.equal(result.tracked, undefined);
  assert.deepEqual(result.untracked, [name]);
  assert.deepEqual(client.linked, []);
});
test("advance mode falls back to blockers for a loose title match, and files no duplicate", async () => {
  const client = new Client();
  client.open.push({ number: 1400, nodeId: "node-1400", title: "flaky permissionAnswer", body: "seen in CI" });
  const result = await recordInheritedTests(client, [name], ctx, { advance: true });
  assert.equal(result.tracked, undefined);
  assert.deepEqual(result.blockers, [{ name, issue: 1400 }]);
  assert.equal(client.created.length, 0);
  assert.match(result.fallbackReason!, /only by its method name/);
});
test("advance mode on a ticket that owns one of the fixes falls back, so the owner repairs it", async () => {
  const client = new Client();
  const other = "p.C#other";
  client.open.push({ number: 1397, nodeId: "node-1397", body: inheritedMarker(name) });
  client.open.push({ number: 1480, nodeId: "node-1480", body: inheritedMarker(other) });
  const result = await recordInheritedTests(client, [name, other], ctx, { advance: true });
  assert.equal(result.tracked, undefined);
  assert.deepEqual(result.owned, [name]);
  assert.match(result.fallbackReason!, /owns the fix/);
});

// The pure half of the decision: what must hold before any tracker is looked at.
const pass = (n: string) => n;
function goTally(overrides: Record<string, unknown> = {}) {
  return { completeParse: true, executed: 10, failed: 1, skipped: 0, packageFailed: true, packageFailures: ["pkg"],
    recognizedLines: 1, failedNames: ["pkg.TestShared"], passedNames: Array.from({ length: 9 }, (_, i) => pass(`pkg.TestOk${i}`)),
    skippedTests: [], timedOutTests: [], ...overrides };
}
const inheritedRun = {
  enabled: true,
  adjusted: { verdict: "inherited-failure" as const, introduced: [], preExisting: ["pkg.TestShared"], flaky: [] },
  raw: { verdict: "fail" as const },
  format: "go-json" as const,
  rerunFailures: ["pkg.TestShared"],
  baselineFailures: ["pkg.TestShared"],
  requiredTests: [],
};
test("an inherited Go failure whose package failure it explains is eligible", () => {
  assert.deepEqual(decideInheritedAdvance({ ...inheritedRun, tally: goTally() }), { eligible: true, inherited: ["pkg.TestShared"] });
});
test("a package failing with no failing test of its own is not explained by another package's failure", () => {
  const d = decideInheritedAdvance({ ...inheritedRun, tally: goTally({ packageFailures: ["pkg", "other"] }) });
  assert.equal(d.eligible, false);
  assert.match((d as any).reason, /package other failed/);
});
test("a suite-level failure outside Go is never explained", () => {
  const d = decideInheritedAdvance({ ...inheritedRun, format: "playwright-json", tally: goTally({ packageFailures: ["playwright (global errors)"] }) });
  assert.equal(d.eligible, false);
});
test("a required Go parent whose subtest is the inherited failure is not eligible", () => {
  const d = decideInheritedAdvance({ ...inheritedRun, requiredTests: ["TestShared"],
    tally: goTally({ failedNames: ["pkg.TestShared/case"] }),
    adjusted: { ...inheritedRun.adjusted, preExisting: ["pkg.TestShared/case"] },
    rerunFailures: ["pkg.TestShared/case"], baselineFailures: ["pkg.TestShared/case"] });
  assert.equal(d.eligible, false);
  assert.match((d as any).reason, /required live test TestShared/);
});
test("eligibility needs the switch on, the re-run, the base run and no hang", () => {
  for (const change of [
    { enabled: false }, { rerunFailures: null }, { baselineFailures: null },
    { tally: goTally({ timedOutTests: ["pkg.TestShared"] }) },
    { raw: { verdict: "fail" as const, missingLiveAcceptance: "required live test X has no passing attempt" } },
    { adjusted: { ...inheritedRun.adjusted, verdict: "fail" as const } },
  ]) {
    assert.equal(decideInheritedAdvance({ ...inheritedRun, tally: goTally(), ...change } as any).eligible, false, JSON.stringify(change));
  }
});
test("the advance switch is on unless the fork turns it off", () => {
  assert.equal(inheritedAdvanceEnabled({}), true);
  assert.equal(inheritedAdvanceEnabled({ PYRY_REAL_CLAUDE_GATE_INHERITED_ADVANCE: "1" }), true);
  for (const off of ["0", "false", "OFF", " no "]) {
    assert.equal(inheritedAdvanceEnabled({ PYRY_REAL_CLAUDE_GATE_INHERITED_ADVANCE: off }), false, off);
  }
});

// --------- Review fixes (PR #242) ---------

test("a Go panic hides the tests after it, so an inherited panicking test never advances", () => {
  // TestA panics on main and on the branch; the binary stops, so a TestZ the
  // branch broke never runs on either tree.
  const raw = [
    { Action: "run", Package: "pkg", Test: "TestA" },
    { Action: "output", Package: "pkg", Test: "TestA", Output: "panic: runtime error: index out of range [3] with length 1\n" },
    { Action: "fail", Package: "pkg", Test: "TestA" },
    { Action: "output", Package: "pkg", Output: "FAIL\tpkg\t0.1s\n" },
    { Action: "fail", Package: "pkg" },
  ].map(e => JSON.stringify(e)).join("\n");
  const t = parseGateOutput(raw, "go-json");
  assert.equal(t.abnormalExit, true);
  const d = decideInheritedAdvance({ ...inheritedRun, tally: t,
    adjusted: { ...inheritedRun.adjusted, preExisting: ["pkg.TestA"] }, rerunFailures: ["pkg.TestA"], baselineFailures: ["pkg.TestA"] });
  assert.equal(d.eligible, false);
  assert.match((d as any).reason, /panic or a data race/);
});
test("the test binary's own deadline panic is not an abnormal exit", () => {
  const raw = [
    { Action: "run", Package: "pkg", Test: "TestA" },
    { Action: "output", Package: "pkg", Test: "TestA", Output: "panic: test timed out after 5m0s\n" },
  ].map(e => JSON.stringify(e)).join("\n");
  assert.notEqual(parseGateOutput(raw, "go-json").abnormalExit, true);
});
test("a data race reported against a package never advances", () => {
  const d = decideInheritedAdvance({ ...inheritedRun, tally: goTally({ abnormalExit: true }) });
  assert.equal(d.eligible, false);
});
test("a sibling package's test does not explain a failing package", () => {
  const d = decideInheritedAdvance({ ...inheritedRun,
    tally: goTally({ failedNames: ["example.com/foo.v2.TestB"], packageFailures: ["example.com/foo", "example.com/foo.v2"] }),
    adjusted: { ...inheritedRun.adjusted, preExisting: ["example.com/foo.v2.TestB"] },
    rerunFailures: ["example.com/foo.v2.TestB"], baselineFailures: ["example.com/foo.v2.TestB"] });
  assert.equal(d.eligible, false);
  assert.match((d as any).reason, /package example.com\/foo failed/);
});
test("a title naming a longer test is not an exact tracker", async () => {
  const client = new Client();
  client.open.push({ number: 1400, nodeId: "node-1400", title: `fix ${name}Baz on main`, body: "other test" });
  const result = await recordInheritedTests(client, [name], ctx, { advance: true });
  assert.notEqual(result.tracked?.[0]?.issue, 1400);
  client.open.push({ number: 1401, nodeId: "node-1401", title: `fix ${name} on main`, body: "the test" });
  const exact = await recordInheritedTests(new Client(), [name], ctx, { advance: true });
  assert.deepEqual(exact.tracked, [{ name, issue: 1500 }], "with no exact tracker one is filed");
  const c2 = new Client();
  c2.open.push({ number: 1401, nodeId: "node-1401", title: `fix ${name} on main`, body: "the test" });
  assert.deepEqual((await recordInheritedTests(c2, [name], ctx, { advance: true })).tracked, [{ name, issue: 1401 }]);
});
test("a gated ticket naming the inherited test itself parks, even without the bug label or marker", async () => {
  const client = new Client();
  client.open.push({ number: 1480, nodeId: "node-1480", body: inheritedMarker(name) });
  const result = await recordInheritedTests(client, [name], { ...ctx, gatedBody: `Repair \`${name}\` so it passes.` }, { advance: true });
  assert.equal(result.tracked, undefined);
  assert.match(result.fallbackReason!, /names p.C#permissionAnswer itself/);
  assert.deepEqual(client.linked, [1480]);
});
test("a title ending the test name with a full stop still names it exactly", async () => {
  const client = new Client();
  client.open.push({ number: 1402, nodeId: "node-1402", title: `Broken on main: ${name}.`, body: "seen" });
  assert.deepEqual((await recordInheritedTests(client, [name], ctx, { advance: true })).tracked, [{ name, issue: 1402 }]);
  assert.equal(client.created.length, 0);
});

// 2026-10-15: a shared failure whose fix ticket closed recently reopens that
// ticket instead of filing a new one.
const T0 = Date.parse("2026-10-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
class ReopeningClient extends Client {
  closed: ClosedTracker[] = [];
  reopened: { issue: number; comment: string; ref: TrackerRef }[] = [];
  reopenError: Error | null = null;
  async listRecentlyClosedIssuesWithLabel(label: string, since: Date) {
    assert.equal(label, "bug");
    return this.closed.filter(c => Date.parse(c.closedAt) >= since.getTime());
  }
  async reopenTracker(issue: ClosedTracker, comment: string, ref: TrackerRef) {
    if (this.reopenError) throw this.reopenError;
    this.reopened.push({ issue: issue.number, comment, ref });
  }
}
const closedFix = (number: number, daysAgo: number): ClosedTracker => ({
  number, nodeId: `node-${number}`, title: "fix shared live failure: permissionAnswer", body: `ctx\n${inheritedMarker(name)}`,
  labels: ["bug", "priority:low", "merged"], closedAt: new Date(T0 - daysAgo * DAY).toISOString(),
});

test("a shared failure whose fix ticket closed in the last 30 days reopens it at the top of Backlog and waits on it", async () => {
  const client = new ReopeningClient();
  client.closed.push(closedFix(1947, 2));
  const result = await recordInheritedTests(client, [name], ctx, {}, process.platform, () => T0);
  assert.equal(client.created.length, 0, "no new ticket");
  assert.deepEqual(client.reopened.map(r => [r.issue, r.ref]), [[1947, { kind: "inherited", tests: [name], top: true }]]);
  assert.match(client.reopened[0].comment, /## Shared failure back after this ticket closed/);
  assert.match(client.reopened[0].comment, /\/logs\/base.log/);
  assert.deepEqual(result.blockers, [{ name, issue: 1947 }]);
  assert.deepEqual(client.linked, [1947]);
  assert.deepEqual(client.positions, [], "the reopen already placed it");
});
test("a fix ticket closed more than 30 days ago stays closed and a new one is filed", async () => {
  const client = new ReopeningClient();
  client.closed.push(closedFix(1700, 31));
  const result = await recordInheritedTests(client, [name], ctx, {}, process.platform, () => T0);
  assert.equal(client.reopened.length, 0);
  assert.deepEqual(result.blockers, [{ name, issue: 1500 }]);
});
test("a reopen that fails files a new ticket, because the gated ticket waits on one", async t => {
  const client = new ReopeningClient();
  client.closed.push(closedFix(1947, 2));
  client.reopenError = new Error("Service 409: Ticket has an active run");
  t.mock.method(console, "warn", () => {});
  const result = await recordInheritedTests(client, [name], ctx, {}, process.platform, () => T0);
  assert.deepEqual(result.blockers, [{ name, issue: 1500 }]);
});
test("in advance mode a reopened tracker counts as a confirmed tracker", async () => {
  const client = new ReopeningClient();
  client.closed.push(closedFix(1947, 2));
  const result = await recordInheritedTests(client, [name], ctx, { advance: true }, process.platform, () => T0);
  assert.deepEqual(result.tracked, [{ name, issue: 1947 }]);
  assert.deepEqual(client.linked, []);
});
