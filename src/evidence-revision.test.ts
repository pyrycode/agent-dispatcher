import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueEvidence, type EvidenceComment } from "./evidence-revision.js";
import { FleetStore } from "./fleet-store.js";
import { GitHubBroker } from "./github-broker.js";
import { WorkflowPublisher } from "./workflow-publisher.js";
import type { WorkflowItem, WorkflowProject } from "./workflow-store.js";

// The revision before this change, copied from the publisher, so a ticket
// whose comments did not move keeps its revision across the upgrade.
const legacy = (body: string, comments: EvidenceComment[]) => createHash("sha256").update(JSON.stringify([body,
  comments.filter(c => !/^(<!-- (?:fleet-recovery|family-dispatch|stranded-wip|auto-retry|pyry-repair-start)|## Orchestrator recovery)/.test(c.body ?? ""))
    .map(c => [c.id, c.updatedAt])])).digest("hex");
const human = (n: number, at = `2026-10-12T15:${String(n).padStart(2, "0")}:00Z`): EvidenceComment => ({ id: `H${n}`, updatedAt: at, body: `Returning #3268 to Inbox, note ${n}` });
const recovery = (n: number): EvidenceComment => ({ id: `R${n}`, updatedAt: `2026-10-14T0${n}:00:00Z`, body: `<!-- fleet-recovery:${n} -->\n## Orchestrator recovery\n\nAction: escalate` });
/** The latest-eight read the publisher makes. */
const lastEight = (all: EvidenceComment[]) => all.slice(-8);

test("with nothing recorded yet the revision is the legacy one, so the upgrade itself moves nothing", () => {
  const comments = [human(1), recovery(1), human(2)];
  assert.equal(issueEvidence("body", comments).revision, legacy("body", comments));
  const before = { revision: legacy("body", comments), body: "body" };
  assert.equal(issueEvidence("body", comments, before).revision, before.revision);
});

test("#3268 shape: recovery reports pushing older comments out of the read do not move the revision", () => {
  // Three human comments and five recovery reports fill the read; each new
  // report pushes one older comment out of view.
  let all = [human(1), human(2), human(3), recovery(1), recovery(2), recovery(3), recovery(4), recovery(5)];
  let previous = { ...issueEvidence("body", lastEight(all)), body: "body" };
  const first = previous.revision;
  for (let n = 6; n <= 9; n++) {
    all = [...all, recovery(n)];
    const window = lastEight(all);
    assert.notEqual(legacy("body", window), first, "the legacy revision moved on every report");
    const next = issueEvidence("body", window, previous);
    assert.equal(next.revision, first, `report ${n} is not new evidence`);
    previous = { ...next, body: "body" };
  }
});

test("a new or edited comment, or an edited body, is new evidence", () => {
  const comments = [human(1), recovery(1)];
  const previous = { ...issueEvidence("body", comments), body: "body" };
  const added = issueEvidence("body", [...comments, human(2)], previous);
  assert.notEqual(added.revision, previous.revision);
  assert.equal(added.revision, legacy("body", [...comments, human(2)]));
  assert.notEqual(issueEvidence("body", [human(1, "2026-10-14T12:00:00Z"), recovery(1)], previous).revision, previous.revision);
  assert.notEqual(issueEvidence("new body", comments, previous).revision, previous.revision);
});

test("an automatic-retry status note alone is not new evidence; its labels carry that change", () => {
  const comments = [human(1)];
  const previous = { ...issueEvidence("body", comments), body: "body" };
  const note = { id: "N1", updatedAt: "2026-10-14T14:16:00Z", body: "<!-- pyry-auto-retry -->\n## ♻️ Auto-retry scheduled" };
  assert.equal(issueEvidence("body", [...comments, note], previous).revision, previous.revision);
});

const config: WorkflowProject = { project: "org/core", projectId: "P", statusFieldId: "S", options: { Inbox: "inbox", Backlog: "backlog", Done: "done" } };
const item: WorkflowItem = { id: "P3268", issueId: "I3268", issueNumber: 3268, title: "Confine capture note writes", body: "body",
  url: "https://github.com/org/core/issues/3268", status: "Inbox", labels: [], blockedBy: [], parentNumber: null, grandparentNumber: null,
  state: "OPEN", revision: 1, position: 0 };

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "evidence-revision-"));
  const store = new FleetStore(join(dir, "state.sqlite"), { mac: { heavyLimit: 1, combinedLimit: 1 } });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test("the publisher keeps the ticket's revision and evidence through a comment-window shift and records a real comment", async t => {
  const store = fixture(t);
  store.workflow.import(config, [item]);
  let comments = [human(1), human(2), human(3), recovery(1), recovery(2), recovery(3), recovery(4), recovery(5)];
  const github = new GitHubBroker({ token: "test", projects: [config.project], fetcher: async (_input, init) => {
    const query: string = JSON.parse(String(init?.body ?? "{}")).query ?? "";
    if (query.startsWith("query($ids:")) return Response.json({ data: { nodes: [{
      id: item.issueId, number: item.issueNumber, title: item.title, body: item.body, url: item.url, state: "OPEN",
      comments: { nodes: lastEight(comments) },
      labels: { nodes: [], pageInfo: { hasNextPage: false } }, blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
      projectItems: { nodes: [{ id: item.id, project: { id: "P" }, fieldValueByName: { name: "Inbox" } }], pageInfo: { hasNextPage: false } },
    }] } });
    if (query.includes("repository")) return Response.json({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } });
    throw new Error("Unexpected request: " + query);
  } });
  const publisher = new WorkflowPublisher(store, github);
  await publisher.refresh(config);
  const first = store.workflow.get("org/core#3268");
  assert.equal(first.evidenceRevision, legacy("body", lastEight(comments)));
  for (let n = 6; n <= 8; n++) {
    comments = [...comments, recovery(n)];
    await publisher.refresh(config);
    const now = store.workflow.get("org/core#3268");
    assert.equal(now.evidenceRevision, first.evidenceRevision);
    assert.equal(now.revision, first.revision, "bookkeeping never bumps the ticket's revision");
  }
  comments = [...comments, human(9, "2026-10-14T13:00:00Z")];
  await publisher.refresh(config);
  assert.notEqual(store.workflow.get("org/core#3268").evidenceRevision, first.evidenceRevision);
});
