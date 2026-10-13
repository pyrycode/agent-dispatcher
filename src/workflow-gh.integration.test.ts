import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FleetStore } from "./fleet-store.js";
import { GitHubBroker } from "./github-broker.js";
import { serveGitHubBridge } from "./github-bridge.js";
import { WorkflowGitHub } from "./workflow-github.js";
import type { WorkflowItem, WorkflowProject } from "./workflow-store.js";

const run = promisify(execFile);
const gh = (() => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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
  body: "Body",
  url: `https://github.com/org/mobile/issues/${n}`,
  status: "Inbox",
  labels: [],
  blockedBy: [],
  parentNumber: null,
  grandparentNumber: null,
  state: "OPEN",
  revision: 1,
  position: n,
});
const issue = (i: WorkflowItem) => ({
  __typename: "Issue",
  id: i.issueId,
  number: i.issueNumber,
  title: i.title,
  body: i.body,
  url: i.url,
  state: i.state,
  labels: { nodes: [], totalCount: 0 },
});

// The real gh CLI decodes GraphQL strictly. Each command here wrote the
// database and then failed on the bridge's response before the fix (2026-10-13,
// Mobile #1984's split).
test("real gh workflow commands succeed through the bridge and write only the database", { skip: !gh && "gh is not installed" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-gh-"));
  const store = new FleetStore(join(dir, "state.sqlite"), { mac: { heavyLimit: 2, combinedLimit: 2 } });
  store.workflow.import(config, [{ ...item(1984), status: "Backlog" }, item(2148), item(2149)]);
  // The refiner owns the parent. Its run grant covers the new children.
  store.start({ workflowVersion: 1, id: "refiner", machine: "mac", session: "s", project: config.project, ticket: "org/mobile#1984", role: "refiner", resource: "light", locks: [] });
  const writes: string[] = [];
  const upstream = new GitHubBroker({
    token: "test",
    projects: [config.project],
    fetcher: async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const query: string = body.query ?? "";
      if (String(input).includes("/labels"))
        return Response.json([{ id: 1, node_id: "L1", name: "done:refiner" }]);
      if (/^\s*mutation/.test(query)) {
        writes.push(query);
        return Response.json({ errors: [{ message: "Workflow display must not be written by an agent" }] });
      }
      if (query.includes("RepositoryLabelList"))
        return Response.json({ data: { repository: { labels: { nodes: [{ id: "L1", name: "done:refiner" }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      if (query.includes("IssueByNumber")) {
        const found = store.workflow.get(`org/mobile#${body.variables.number}`);
        return Response.json({ data: { repository: { hasIssuesEnabled: true, issue: issue(found) } } });
      }
      throw new Error("Unexpected upstream request: " + String(input) + " " + query.slice(0, 200));
    },
  });
  const bridge = new WorkflowGitHub(store, upstream);
  const socket = join(dir, "api.sock");
  const server = await serveGitHubBridge(socket, (request) =>
    bridge.request(config.project, request, { machine: "mac", session: "s", runId: "refiner" }),
  );
  t.after(() => {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const configDir = join(dir, "gh");
  execFileSync("mkdir", ["-p", configDir]);
  writeFileSync(join(configDir, "config.yml"), `http_unix_socket: ${JSON.stringify(socket)}\n`);
  const env = { PATH: process.env.PATH, HOME: dir, GH_CONFIG_DIR: configDir, GH_TOKEN: "test", GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  const ghRun = (...args: string[]) => run("gh", args, { env, timeout: 30_000 });

  // pipeline-action board-status
  await ghRun("project", "item-edit", "--project-id", "P", "--id", "P2148", "--field-id", "S", "--single-select-option-id", "backlog");
  // pipeline-action board-after, and add-blocker, select only clientMutationId
  await ghRun("api", "graphql", "-f", "query=mutation($input:UpdateProjectV2ItemPositionInput!){updateProjectV2ItemPosition(input:$input){clientMutationId}}", "-f", "input[projectId]=P", "-f", "input[itemId]=P2148", "-f", "input[afterId]=P1984");
  await ghRun("api", "graphql", "-f", "query=mutation($input:AddBlockedByInput!){addBlockedBy(input:$input){clientMutationId}}", "-f", "input[issueId]=I2149", "-f", "input[blockingIssueId]=I2148");
  // issue-action add-label, pipeline-action issue-comment, and a split parent close
  await ghRun("issue", "edit", "2148", "--repo", "github.com/org/mobile", "--add-label", "done:refiner");
  await ghRun("issue", "comment", "2148", "--repo", "github.com/org/mobile", "--body", "Split from #1984.");
  await ghRun("issue", "close", "2148", "--repo", "github.com/org/mobile", "--reason", "completed");

  const child = store.workflow.get("org/mobile#2148");
  assert.equal(child.status, "Backlog");
  assert.deepEqual(child.labels, ["done:refiner"]);
  assert.equal(child.state, "CLOSED");
  assert.deepEqual(
    store.workflow.list(config.project).map((i) => i.issueNumber),
    [1984, 2148, 2149],
  );
  assert.deepEqual(store.workflow.get("org/mobile#2149").blockedBy.map((b) => b.number), [2148]);
  assert.equal(store.workflow.pendingComments().length, 1);
  assert.deepEqual(writes, []);
});
