import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { GateRunReport } from "./gate-output.js";
import {
  FLAKY_TEST_COLUMN,
  FLAKY_TEST_LABEL,
  MAX_NEW_FLAKY_TICKETS_PER_RUN,
  buildFlakyTestIssue,
  findFlakyTicket,
  flakyMarker,
  recordFlakyTests,
  shortTestName,
  buildFlakyRecurrenceComment,
  type FlakyRunContext,
  type FlakyTicketClient,
  type VerifierGateFlakyContext,
} from "./flaky-tickets.js";

const NAME = "de.pyryco.mobile.e2e.InteractiveStreamE2ETest#interactiveTurn_stopRunningTurn_showsInterruptedThenRepliesAgain";

function ctx(): FlakyRunContext {
  return {
    gatedIssue: 1016,
    at: "2026-09-24T19:05:00.000Z",
    report: {
      branchName: "feature/1016",
      headSha: "c51aea6481".padEnd(40, "0"),
      baseRef: "origin/main",
      baseSha: "31234eccda".padEnd(40, "0"),
      outputPath: "/logs/gate.log",
      rerunOutputPath: "/logs/rerun.log",
    } as GateRunReport,
  };
}

class FakeClient implements FlakyTicketClient {
  open: { number: number; body: string }[] = [];
  created: { title: string; body: string; labels: string[] }[] = [];
  comments: { issue: number; body: string }[] = [];
  statuses: { itemId: string; status: string }[] = [];
  listError: Error | null = null;
  createError: Error | null = null;
  next = 3000;

  async listOpenIssuesWithLabel(label: string) {
    assert.equal(label, FLAKY_TEST_LABEL);
    if (this.listError) throw this.listError;
    return [...this.open];
  }
  async createIssue(title: string, body: string, labels: string[] = []) {
    if (this.createError) throw this.createError;
    this.created.push({ title, body, labels });
    const number = this.next++;
    return { number, nodeId: `node-${number}`, url: `https://x/${number}` };
  }
  async addItemToProject(nodeId: string) { return `item-${nodeId}`; }
  async updateItemStatus(itemId: string, status: string) { this.statuses.push({ itemId, status }); }
  async addComment(issue: number, body: string) { this.comments.push({ issue, body }); }
}

describe("flaky-test tickets", () => {
  test("files a Backlog ticket for a first-seen flake, labelled and findable by its marker", async () => {
    const client = new FakeClient();

    const result = await recordFlakyTests(client, [NAME], ctx());

    assert.deepEqual(result, { filed: [{ name: NAME, issue: 3000 }], commented: [], untracked: [] });
    assert.equal(client.created[0].title, "flaky live test: interactiveTurn_stopRunningTurn_showsInterruptedThenRepliesAgain");
    assert.deepEqual(client.created[0].labels, ["bug", FLAKY_TEST_LABEL]);
    assert.match(client.created[0].body, /Gate run for #1016/);
    assert.equal(findFlakyTicket([{ number: 3000, body: client.created[0].body }], NAME), 3000);
    assert.deepEqual(client.statuses, [{ itemId: "item-node-3000", status: FLAKY_TEST_COLUMN }]);
  });

  test("a later flake comments on the open ticket instead of filing a duplicate", async () => {
    const client = new FakeClient();
    client.open.push({ number: 1036, body: `text\n${flakyMarker(NAME)}\n` });

    const result = await recordFlakyTests(client, [NAME, NAME], ctx());

    assert.deepEqual(result.commented, [{ name: NAME, issue: 1036 }]);
    assert.equal(client.created.length, 0);
    assert.equal(client.comments.length, 1, "a name repeated in one run is recorded once");
    assert.match(client.comments[0].body, /Flaked again/);
  });

  test("matches the whole marker line, so one test cannot claim another's ticket", () => {
    const issues = [{ number: 1, body: flakyMarker("p.C#test_ab") }];
    assert.equal(findFlakyTicket(issues, "p.C#test_a"), null);
    assert.equal(findFlakyTicket(issues, "p.C#test_ab"), 1);
  });

  test("files at most the cap of new tickets per run and names the rest untracked", async () => {
    const client = new FakeClient();
    const names = Array.from({ length: MAX_NEW_FLAKY_TICKETS_PER_RUN + 2 }, (_, i) => `p.C#t${i}`);

    const result = await recordFlakyTests(client, names, ctx());

    assert.equal(result.filed.length, MAX_NEW_FLAKY_TICKETS_PER_RUN);
    assert.deepEqual(result.untracked, names.slice(MAX_NEW_FLAKY_TICKETS_PER_RUN));
  });

  test("writes nothing when the open tickets cannot be listed, since every flake would look new", async () => {
    const client = new FakeClient();
    client.listError = new Error("REST 502");

    const result = await recordFlakyTests(client, [NAME], ctx());

    assert.deepEqual(result.untracked, [NAME]);
    assert.equal(client.created.length, 0);
    assert.equal(client.comments.length, 0);
  });

  test("never throws when filing fails", async () => {
    const client = new FakeClient();
    client.createError = new Error("REST 500");

    const result = await recordFlakyTests(client, [NAME], ctx());

    assert.deepEqual(result, { filed: [], commented: [], untracked: [NAME] });
  });

  test("short names read as the method or the Go test", () => {
    assert.equal(shortTestName("p.C#method"), "method");
    assert.equal(shortTestName("github.com/o/r/internal/e2e.TestLive/sub"), "TestLive/sub");
    assert.equal(shortTestName("bare"), "bare");
  });

  test("a ticket filed from a verifier gate names the gate command and its log, not a real-claude report", async () => {
    const gate = "python3 scripts/android-test-gate.py ui";
    const gateCtx: VerifierGateFlakyContext = {
      gatedIssue: 1760,
      at: "2026-10-05T09:00:00.000Z",
      verifierGate: {
        gate,
        commit: "d4e5f6a7b8".padEnd(40, "0"),
        outputPath: "/logs/verifier-gate_#1760_2.log",
        rerunOutputPath: "/logs/verifier-gate-rerun_#1760.log",
      },
    };
    const client = new FakeClient();

    const result = await recordFlakyTests(client, [NAME], gateCtx);

    assert.deepEqual(result.filed, [{ name: NAME, issue: 3000 }]);
    const { title, body } = client.created[0];
    assert.equal(title, "flaky test: interactiveTurn_stopRunningTurn_showsInterruptedThenRepliesAgain");
    assert.ok(body.includes(`Verifier gate run for #1760 at 2026-10-05T09:00:00.000Z`));
    assert.ok(body.includes(`\`${gate}\` on merged commit \`d4e5f6a7b8\``));
    assert.ok(body.includes("`/logs/verifier-gate_#1760_2.log`, re-run output: `/logs/verifier-gate-rerun_#1760.log`"));
    assert.ok(!/real-claude|live gate|Branch `/.test(body), "no real-claude wording or report fields");
    assert.equal(findFlakyTicket([{ number: 3000, body }], NAME), 3000, "the same per-test marker, so both gates share one ticket");

    const comment = buildFlakyRecurrenceComment(NAME, gateCtx);
    assert.ok(comment.includes(`\`${gate}\``));
    assert.ok(comment.includes("/logs/verifier-gate_#1760_2.log"));
  });

  test("a real-claude ticket keeps its wording", () => {
    const { title, body } = buildFlakyTestIssue(NAME, ctx());
    assert.match(title, /^flaky live test: /);
    assert.match(body, /The real-claude gate saw this test fail/);
    assert.ok(body.includes("- Branch `feature/1016` at `c51aea6481`, merged with `origin/main` at `31234eccda`"));
  });

  test("the ticket body stays within the refiner's shape", () => {
    const { body } = buildFlakyTestIssue(NAME, ctx());
    for (const heading of ["## User Story", "## Context", "## Acceptance Criteria"]) assert.ok(body.includes(heading));
    assert.ok(body.length < 8000);
  });
});
