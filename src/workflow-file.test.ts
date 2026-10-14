import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "./fleet-store.js";
import { GitHubBroker } from "./github-broker.js";
import { WorkflowGitHub } from "./workflow-github.js";
import { JsonClient, serveFleet } from "./fleet-http.js";
import type { WorkflowItem, WorkflowProject } from "./workflow-store.js";

const config: WorkflowProject = {
  project: "org/mobile",
  projectId: "P",
  statusFieldId: "S",
  options: { Inbox: "inbox", Backlog: "backlog", "In Development": "dev", Done: "done" },
};
const item = (n: number): WorkflowItem => ({
  id: `P${n}`,
  issueId: `I${n}`,
  issueNumber: n,
  title: `Ticket ${n}`,
  body: "",
  url: `https://github.com/org/mobile/issues/${n}`,
  status: "Backlog",
  labels: [],
  blockedBy: [],
  parentNumber: null,
  grandparentNumber: null,
  state: "OPEN",
  revision: 1,
  position: 0,
});

/** Enough of GitHub to create, list, describe and place an issue. */
function fakeGitHub() {
  type Issue = { number: number; node_id: string; title: string; body: string; labels: string[]; html_url: string; created_at: string; board?: string };
  const issues: Issue[] = [];
  const calls: string[] = [];
  const faults = { loseCreateAnswer: 0, failBoard: 0 };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "POST" && url.pathname === "/repos/org/mobile/issues") {
      calls.push("create");
      const n = 3000 + issues.length;
      const issue: Issue = { number: n, node_id: `I${n}`, title: body.title, body: body.body, labels: body.labels ?? [], html_url: `https://github.com/org/mobile/issues/${n}`, created_at: new Date().toISOString() };
      issues.push(issue);
      if (faults.loseCreateAnswer-- > 0) return new Response("bad gateway", { status: 502 });
      return Response.json({ ...issue, labels: issue.labels.map((name) => ({ name })) }, { status: 201 });
    }
    if (method === "GET" && url.pathname === "/repos/org/mobile/issues") {
      calls.push("list");
      return Response.json([...issues].reverse().map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })) })));
    }
    if (url.pathname === "/graphql") {
      if (body.query.includes("addProjectV2ItemById")) {
        calls.push("board");
        if (faults.failBoard-- > 0) return new Response("unavailable", { status: 503 });
        const issue = issues.find((i) => i.node_id === body.variables.issue)!;
        issue.board = `PVTI_${issue.number}`;
        return Response.json({ data: { addProjectV2ItemById: { item: { id: issue.board } } } });
      }
      calls.push("describe");
      const i = issues.find((i) => i.node_id === body.variables.id);
      return Response.json({ data: { node: i && {
        id: i.node_id, number: i.number, title: i.title, body: i.body, url: i.html_url, state: "OPEN",
        repository: { nameWithOwner: "org/mobile" },
        labels: { nodes: i.labels.map((name) => ({ name })), pageInfo: { hasNextPage: false } },
        blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
        parent: null, subIssuesSummary: { total: 0, completed: 0 },
        projectItems: { nodes: i.board ? [{ id: i.board, project: { id: "P" }, fieldValueByName: { name: "Inbox" } }] : [], pageInfo: { hasNextPage: false } },
      } } });
    }
    throw new Error(`Unexpected GitHub call ${method} ${url.pathname}`);
  };
  return { issues, calls, faults, fetcher: fetcher as typeof fetch };
}
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "workflow-file-test-"));
  const store = new FleetStore(join(dir, "state.sqlite"), { mac: { heavyLimit: 2, combinedLimit: 2 } });
  store.workflow.import(config, [item(1947), item(1948)]);
  const github = fakeGitHub();
  const broker = new GitHubBroker({ token: "test", projects: ["org/mobile", "org/other"], fetcher: github.fetcher });
  const server = await serveFleet(store, { mac: "machine" }, "operator", 0, "127.0.0.1", broker);
  t.after(() => {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  return { store, github, operator: new JsonClient(url, "operator"), machine: new JsonClient(url, "machine"), bridge: new WorkflowGitHub(store, broker) };
}
const request = (extra: Record<string, unknown> = {}) => ({
  project: "org/mobile",
  commandId: "file-1",
  title: "Show the relay state",
  body: "The phone hides the relay state.",
  labels: ["enhancement"],
  workflow: { stage: "Backlog", labels: ["priority:high", "done:refiner"], blockedBy: [1947] },
  ...extra,
});

test("one operator call creates, registers and applies the intended workflow", async (t) => {
  const { store, github, operator } = await fixture(t);
  const result: any = await operator.call("/workflow/file", request());
  assert.equal(result.ticket, "org/mobile#3000");
  assert.equal(result.issueNumber, 3000);
  assert.equal(result.url, "https://github.com/org/mobile/issues/3000");
  assert.deepEqual(github.calls, ["create", "describe", "board"]);
  const created = github.issues[0];
  assert.deepEqual(created.labels, ["enhancement"]);
  assert.match(created.body, /^The phone hides the relay state\.\n\n<!-- orchestrator-filing:file-1 -->$/);
  const saved = store.workflow.get("org/mobile#3000");
  assert.equal(saved.id, "PVTI_3000");
  assert.equal(saved.status, "Backlog");
  assert.deepEqual(saved.labels, ["enhancement", "priority:high", "done:refiner"]);
  assert.deepEqual(saved.blockedBy, [{ number: 1947, state: "OPEN", url: "https://github.com/org/mobile/issues/1947" }]);
  assert.equal(result.revision, saved.revision);
  assert.deepEqual(result.item.labels, saved.labels);
  // The display follows through the normal publisher.
  assert(store.workflow.pending(10, "org/mobile").some((p) => p.ticket === "org/mobile#3000"));
});

test("Inbox is the default stage and the workflow block is optional", async (t) => {
  const { store, operator } = await fixture(t);
  const { workflow, labels, ...plain } = request();
  await operator.call("/workflow/file", plain);
  const saved = store.workflow.get("org/mobile#3000");
  assert.equal(saved.status, "Inbox");
  assert.deepEqual(saved.labels, []);
});

test("an exact retry returns the first result without a second issue", async (t) => {
  const { github, operator } = await fixture(t);
  const [a, b] = await Promise.all([operator.call("/workflow/file", request()), operator.call("/workflow/file", request())]);
  const c = await operator.call("/workflow/file", request());
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(github.calls.filter((c) => c === "create").length, 1);
  await assert.rejects(operator.call("/workflow/file", request({ title: "Another" })), /identity reused/);
  assert.equal(github.issues.length, 1);
});

test("a retry after registration failed reuses the created issue", async (t) => {
  const { store, github, operator } = await fixture(t);
  github.faults.failBoard = 1;
  await assert.rejects(operator.call("/workflow/file", request()), /GitHub unavailable: 503/);
  assert.equal(github.issues.length, 1);
  assert.throws(() => store.workflow.get("org/mobile#3000"), /Unknown workflow ticket/);
  const result: any = await operator.call("/workflow/file", request());
  assert.equal(result.issueNumber, 3000);
  assert.equal(github.calls.filter((c) => c === "create").length, 1);
  assert.equal(store.workflow.get("org/mobile#3000").status, "Backlog");
});

test("a retry after the creation answer was lost finds the issue by its marker", async (t) => {
  const { store, github, operator } = await fixture(t);
  github.faults.loseCreateAnswer = 1;
  await assert.rejects(operator.call("/workflow/file", request()), /GitHub unavailable: 502/);
  assert.equal(github.issues.length, 1);
  const result: any = await operator.call("/workflow/file", request());
  assert.equal(result.issueNumber, 3000);
  assert.equal(github.issues.length, 1);
  assert.deepEqual(github.calls, ["create", "list", "describe", "board"]);
  assert.equal(store.workflow.get("org/mobile#3000").status, "Backlog");
});

test("a retry after discovery adopted the issue still applies the intended state once", async (t) => {
  const { store, github, operator, bridge } = await fixture(t);
  github.faults.failBoard = 1;
  await assert.rejects(operator.call("/workflow/file", request()));
  // The five minute scan registers the issue in Inbox before the retry.
  await bridge.adoptIssue("org/mobile", "I3000");
  assert.equal(store.workflow.get("org/mobile#3000").status, "Inbox");
  const result: any = await operator.call("/workflow/file", request());
  assert.equal(result.item.status, "Backlog");
  assert.equal(github.issues.length, 1);
});

test("blockers must be distinct tickets already in the project, checked before GitHub", async (t) => {
  const { github, operator } = await fixture(t);
  await assert.rejects(operator.call("/workflow/file", request({ workflow: { blockedBy: [9999] } })), /not tickets in org\/mobile: 9999/);
  await assert.rejects(operator.call("/workflow/file", request({ workflow: { blockedBy: [1947, 1947] } })), /distinct/);
  await assert.rejects(operator.call("/workflow/file", request({ workflow: { blockedBy: ["org/mobile#1947"] } })), /distinct ticket numbers/);
  assert.deepEqual(github.calls, []);
});

test("unknown projects and bad input are refused before GitHub", async (t) => {
  const { github, operator, machine } = await fixture(t);
  await assert.rejects(operator.call("/workflow/file", request({ project: "org/other" })), /not enabled/);
  await assert.rejects(operator.call("/workflow/file", request({ project: "not a repo" })), /project required/);
  await assert.rejects(operator.call("/workflow/file", request({ commandId: "" })), /commandId/);
  await assert.rejects(operator.call("/workflow/file", request({ title: " " })), /title/);
  await assert.rejects(operator.call("/workflow/file", request({ body: 7 })), /body/);
  await assert.rejects(operator.call("/workflow/file", request({ status: "Backlog" })), /Unknown filing request field/);
  await assert.rejects(operator.call("/workflow/file", request({ workflow: { stage: "Shipped" } })), /Unknown workflow stage/);
  await assert.rejects(operator.call("/workflow/file", request({ workflow: { top: true } })), /Invalid filing workflow/);
  await assert.rejects(operator.call("/workflow/file", request({ labels: ["done:refiner"] })), /belong in workflow.labels/);
  await assert.rejects(operator.call("/workflow/file", request({ workflow: { labels: [""] } })), /Invalid workflow labels/);
  await assert.rejects(machine.call("/workflow/file", request()), /Operator credential required/);
  assert.deepEqual(github.calls, []);
});

test("operator read and change behave as before next to filing", async (t) => {
  const { store, operator, machine } = await fixture(t);
  await operator.call("/workflow/file", request());
  const read: any = await operator.call("/workflow/read", { project: "org/mobile" });
  assert.deepEqual(read.items.map((i: WorkflowItem) => i.issueNumber), [1947, 1948, 3000]);
  const filed = read.items.find((i: WorkflowItem) => i.issueNumber === 3000);
  const change = { commandId: "move", ticket: "org/mobile#3000", revision: filed.revision, change: { status: "In Development", removeLabels: ["priority:high"] } };
  await assert.rejects(machine.call("/workflow/operator", { project: "org/mobile", ...change }), /Operator credential required/);
  const changed: any = await operator.call("/workflow/operator", { project: "org/mobile", ...change });
  assert.equal(changed.status, "In Development");
  assert.deepEqual(changed.labels, ["enhancement", "done:refiner"]);
  await assert.rejects(operator.call("/workflow/operator", { project: "org/mobile", ...change, commandId: "stale" }), /read again/);
  assert.equal(store.workflow.get("org/mobile#3000").status, "In Development");
  // A completed filing still answers with its original result.
  const replay: any = await operator.call("/workflow/file", request());
  assert.equal(replay.item.status, "Backlog");
});
