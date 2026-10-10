import { test } from "node:test";
import assert from "node:assert/strict";
import { recordInheritedTests, inheritedMarker, type InheritedTicketClient } from "./inherited-tickets.js";
import type { FlakyRunContext } from "./flaky-tickets.js";

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
    assert.deepEqual(labels, ["bug", "priority:low"]);
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
