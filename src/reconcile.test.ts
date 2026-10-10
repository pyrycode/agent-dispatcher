// Integration tests for cycle reconciliation (`runAutoAdvance`,
// `runReworkRouting`).
//
// Why these tests exist: lib.test.ts covers the pure decision functions
// (`decideAutoAdvance`, `decideReworkRoutes`); these tests cover the
// I/O wrappers themselves — specifically the cache-invalidation
// invariant that keeps the dispatcher's finish-first priority intact.
//
// The 2026-05-03 09:33 incident (PO dispatched on Backlog #132 instead
// of code-review on the just-advanced #127 in In Code Review) was a
// missing `clearItemsCache()` after `runAutoAdvance` mutated. This test
// suite locks in the fix.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  runAutoAdvance,
  runRealClaudeGate,
  runRealClaudeGateExecution,
  runReworkRouting,
  STALE_BASE_REFRESH_MARKER,
  STALE_BASE_REFRESH_MAX,
  type ReconcileClient,
  type StaleBaseRefresh,
} from "./reconcile.js";
import { readFileSync } from "node:fs";
import type { GateRunReport, GateTally } from "./gate-output.js";
import type { ProjectItem } from "./types.js";
import { resetActiveStageSetForTests } from "./stage-sets.js";
import { REAL_CLAUDE_GATE_RUNNING_LABEL } from "./pipeline-decisions.js";

/**
 * Minimal in-memory ReconcileClient. Records every call to
 * `clearItemsCache` and applies mutations against the items array so
 * subsequent `getItemsByStatus` calls see fresh state.
 *
 * Not modeling the real per-cycle cache here on purpose — these tests
 * assert the BEHAVIOR (cache invalidation is requested when mutations
 * happen) rather than retest the cache implementation. github.ts owns
 * the cache; this file owns the rule that asks for invalidation.
 */
class MockClient implements ReconcileClient {
  items: ProjectItem[];
  clearItemsCacheCalls = 0;
  updateItemStatusCalls: { itemId: string; newStatus: string }[] = [];
  addLabelCalls: { issueNumber: number; label: string }[] = [];
  removeLabelCalls: { issueNumber: number; label: string }[] = [];

  constructor(items: ProjectItem[]) {
    this.items = items;
  }

  async getOpenBlockers(issueNumber: number): Promise<number[]> {
    return (this.items.find(i => i.issueNumber === issueNumber)?.blockedBy ?? []).filter(b => b.state === "OPEN").map(b => b.number);
  }

  async getItemsByStatus(status: string): Promise<ProjectItem[]> {
    return this.items.filter(i => i.status === status);
  }

  async updateItemStatus(itemId: string, newStatus: string): Promise<void> {
    this.updateItemStatusCalls.push({ itemId, newStatus });
    const item = this.items.find(i => i.id === itemId);
    if (item) item.status = newStatus;
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    this.removeLabelCalls.push({ issueNumber, label });
    const item = this.items.find(i => i.issueNumber === issueNumber);
    if (item) item.labels = item.labels.filter(l => l !== label);
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    this.addLabelCalls.push({ issueNumber, label });
    const item = this.items.find(i => i.issueNumber === issueNumber);
    if (item && !item.labels.includes(label)) item.labels.push(label);
  }

  addCommentCalls: { issueNumber: number; body: string }[] = [];
  async addComment(issueNumber: number, body: string): Promise<void> {
    this.addCommentCalls.push({ issueNumber, body });
  }

  /**
   * Fresh label read. Defaults to whatever the board snapshot holds, which
   * is the common case; a test that needs the snapshot and the truth to
   * DIVERGE — the label-truncation hazard the fresh read exists for —
   * overrides this map.
   */
  freshLabels = new Map<number, string[]>();
  getIssueLabelsCalls: number[] = [];
  getIssueLabelsError: Error | null = null;
  async getIssueLabels(issueNumber: number): Promise<string[]> {
    this.getIssueLabelsCalls.push(issueNumber);
    if (this.getIssueLabelsError) throw this.getIssueLabelsError;
    const override = this.freshLabels.get(issueNumber);
    if (override) return [...override];
    return [...(this.items.find(i => i.issueNumber === issueNumber)?.labels ?? [])];
  }

  /**
   * Marker comments already on the issue before the test, per issue, plus
   * every comment posted through this client that carries the marker.
   */
  priorMarkerComments = new Map<number, number>();
  countMarkerCommentsError: Error | null = null;
  async countMarkerComments(issueNumber: number, marker: string): Promise<number> {
    if (this.countMarkerCommentsError) throw this.countMarkerCommentsError;
    const posted = this.addCommentCalls.filter(c => c.issueNumber === issueNumber && c.body.includes(marker)).length;
    return (this.priorMarkerComments.get(issueNumber) ?? 0) + posted;
  }

  clearItemsCache(): void {
    this.clearItemsCacheCalls++;
  }
}

function makeItem(overrides: Partial<ProjectItem>): ProjectItem {
  return {
    id: overrides.id ?? "item-x",
    issueId: overrides.issueId ?? "node-x",
    issueNumber: overrides.issueNumber ?? 1,
    title: overrides.title ?? "test",
    body: overrides.body ?? "",
    status: overrides.status ?? "Backlog",
    labels: overrides.labels ?? [],
    url: overrides.url ?? "https://example.com",
    blockedBy: overrides.blockedBy ?? [],
    parentNumber: overrides.parentNumber ?? null,
    grandparentNumber: overrides.grandparentNumber ?? null,
  };
}

describe("runAutoAdvance — cache invalidation", () => {
  test("clears items cache when an advance is applied (the 2026-05-03 #127 bug)", async () => {
    // Reproduces the exact shape that misfired in production: a ticket
    // in In Development with `done:developer` should auto-advance to
    // In QA AND signal cache invalidation so the per-agent
    // loop in the same cycle sees the new placement.
    // (Post-2026-05-22: developer → QA → code-review; the cache-invalidation
    // semantic is identical, just one column over.)
    const item = makeItem({
      id: "item-127",
      issueNumber: 127,
      status: "In Development",
      labels: ["done:developer", "size:xs"],
    });
    const client = new MockClient([item]);

    await runAutoAdvance(client, 1, 0);

    // Sanity: the advance happened.
    assert.equal(client.updateItemStatusCalls.length, 1, "expected one updateItemStatus call");
    assert.equal(client.updateItemStatusCalls[0]?.itemId, "item-127");
    assert.equal(client.updateItemStatusCalls[0]?.newStatus, "In QA");

    // The bug: cache wasn't invalidated. The fix: invalidate after any advance.
    assert.equal(
      client.clearItemsCacheCalls,
      1,
      "expected clearItemsCache to be called once after advancing #127 — without this, " +
        "the per-agent for-loop in the same cycle reads a stale snapshot and skips In QA",
    );
  });

  test("does NOT clear cache when no advance is applied", async () => {
    // Empty pipeline → nothing to advance → no cache churn.
    const client = new MockClient([]);

    await runAutoAdvance(client, 1, 0);

    assert.equal(client.updateItemStatusCalls.length, 0);
    assert.equal(
      client.clearItemsCacheCalls,
      0,
      "no-op cycles must not pay an extra GraphQL fetch on the next read",
    );
  });

  test("clears cache for Backlog → In Architecture advance when nothing in flight", async () => {
    // The other path that mutates: Backlog ticket with `done:po` and
    // an empty mid-pipeline. decideAutoAdvance moves it to In Architecture.
    const item = makeItem({
      id: "item-200",
      issueNumber: 200,
      status: "Backlog",
      labels: ["done:po", "size:s"],
    });
    const client = new MockClient([item]);

    await runAutoAdvance(client, 1, 0);

    assert.equal(client.updateItemStatusCalls.length, 1);
    assert.equal(client.updateItemStatusCalls[0]?.newStatus, "In Architecture");
    assert.equal(client.clearItemsCacheCalls, 1);
  });

  test("blocked mid-pipeline ticket does NOT hold a capacity seat (the #10 deadlock fix)", async () => {
    // The 2026-05-16 deadlock shape: #383 sits in "In Development"
    // blocked-by #409 (still open). #409 sits in Backlog with
    // `done:po`, ready to advance into the pipeline. Pre-fix, #383
    // consumed the only seat (PYRY_MAX_CONCURRENT=1) and #409 stayed
    // in Backlog forever — mutual deadlock: #383 needs #409 to close,
    // #409 needs the seat #383 holds.
    //
    // Post-fix: countPipelineInFlight excludes the blocked #383, so
    // capacity = max(0, 1 - 0) = 1, and #409 advances out of Backlog.
    const blocked = makeItem({
      id: "item-383",
      issueNumber: 383,
      status: "In Development",
      labels: ["size:s"],
      blockedBy: [{ number: 409, state: "OPEN" }],
    });
    const blockingBacklog = makeItem({
      id: "item-409",
      issueNumber: 409,
      status: "Backlog",
      labels: ["done:po", "size:xs"],
    });
    const client = new MockClient([blocked, blockingBacklog]);

    await runAutoAdvance(client, 1, 0);

    // #409 advances into the pipeline. #383 stays parked (its `blockedBy`
    // hasn't cleared yet; only #409 closing would clear it).
    assert.equal(
      client.updateItemStatusCalls.length, 1,
      "exactly one advance — #409 out of Backlog (without the fix this would be 0)",
    );
    assert.equal(client.updateItemStatusCalls[0]?.itemId, "item-409");
    assert.equal(client.updateItemStatusCalls[0]?.newStatus, "In Architecture");
    // #383 was NOT moved (still blocked).
    assert.ok(
      !client.updateItemStatusCalls.some(c => c.itemId === "item-383"),
      "blocked ticket stays where it is — clearing the blocker is the operator's job",
    );
  });

  test("CLOSED blockers don't free the seat — only OPEN blockers parked the ticket in the first place", async () => {
    // Counter-test: when a mid-pipeline ticket has only CLOSED blockers
    // (e.g. the blocker closed and the ticket is back in active flow),
    // it counts toward capacity normally. Verifies the fix's exclusion
    // is keyed on OPEN, not on the mere presence of a blockedBy entry.
    const midActive = makeItem({
      id: "item-100",
      issueNumber: 100,
      status: "In Development",
      labels: ["size:s"],
      blockedBy: [{ number: 50, state: "CLOSED" }],  // blocker already closed
    });
    const backlog = makeItem({
      id: "item-101",
      issueNumber: 101,
      status: "Backlog",
      labels: ["done:po", "size:s"],
    });
    const client = new MockClient([midActive, backlog]);

    await runAutoAdvance(client, 1, 0);

    // #100 counts as in-flight (its blocker is closed → it's progressing).
    // Capacity = max(0, 1 - 1) = 0 → #101 stays in Backlog.
    assert.equal(
      client.updateItemStatusCalls.length, 0,
      "active mid-pipeline ticket (no OPEN blockers) consumes capacity — Backlog stays held",
    );
  });
});

describe("runAutoAdvance — the Backlog budget counts free seats", () => {
  test("a ticket queued behind the busy verifier holds no seat (Mobile, 2026-09-22)", async () => {
    // The board that refined Mobile's whole Backlog: cap 3, the verifier on
    // #802, documentation on #807, and #803 waiting its turn for the
    // one-at-a-time verifier. Three tickets past Backlog, two runs. The old
    // count read three and held Backlog shut while the free seat went to
    // the refiner.
    await withStageSet("builder", async () => {
      const client = new MockClient([
        makeItem({ id: "item-802", issueNumber: 802, status: "In Code Review", labels: ["done:builder", "wip:verifier"] }),
        makeItem({ id: "item-803", issueNumber: 803, status: "In Code Review", labels: ["done:builder"] }),
        makeItem({ id: "item-807", issueNumber: 807, status: "In Documentation", labels: ["done:verifier", "wip:documentation"] }),
        makeItem({ id: "item-798", issueNumber: 798, status: "Backlog", labels: ["done:refiner"] }),
        makeItem({ id: "item-804", issueNumber: 804, status: "Backlog", labels: ["done:refiner"] }),
      ]);

      await runAutoAdvance(client, 3, 2);

      assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-798", newStatus: "In Development" }]);
    });
  });

  test("a ticket past Backlog that would start now takes the free seat", async () => {
    await withStageSet("builder", async () => {
      const client = new MockClient([
        makeItem({ id: "item-900", issueNumber: 900, status: "In Development", labels: [] }),
        makeItem({ id: "item-901", issueNumber: 901, status: "Backlog", labels: ["done:refiner"] }),
      ]);

      await runAutoAdvance(client, 3, 2);

      assert.equal(client.updateItemStatusCalls.length, 0);
    });
  });

  test("ready high-priority Backlog beats unmarked waiting Development", async () => {
    await withStageSet("builder", async () => {
      const client = new MockClient([
        makeItem({ id: "item-900", issueNumber: 900, status: "In Development", labels: [] }),
        makeItem({ id: "item-901", issueNumber: 901, status: "Backlog", labels: ["done:refiner", "priority:high"] }),
      ]);
      await runAutoAdvance(client, 1, 0);
      assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-901", newStatus: "In Development" }]);
    });
  });

  test("unmarked ready Backlog beats low-priority waiting Development", async () => {
    await withStageSet("builder", async () => {
      const client = new MockClient([
        makeItem({ id: "item-900", issueNumber: 900, status: "In Development", labels: ["priority:low"] }),
        makeItem({ id: "item-901", issueNumber: 901, status: "Backlog", labels: ["done:refiner"] }),
      ]);
      await runAutoAdvance(client, 1, 0);
      assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-901", newStatus: "In Development" }]);
    });
  });

  test("equal-priority waiting work past Backlog keeps the free seat", async () => {
    await withStageSet("builder", async () => {
      const client = new MockClient([
        makeItem({ id: "item-900", issueNumber: 900, status: "In Development", labels: ["priority:high"] }),
        makeItem({ id: "item-901", issueNumber: 901, status: "Backlog", labels: ["done:refiner", "priority:high"] }),
      ]);
      await runAutoAdvance(client, 1, 0);
      assert.deepEqual(client.updateItemStatusCalls, []);
    });
  });

  test("ready high-priority Backlog never takes a running agent's seat", async () => {
    await withStageSet("builder", async () => {
      const client = new MockClient([
        makeItem({ id: "item-900", issueNumber: 900, status: "In Development", labels: ["wip:builder"] }),
        makeItem({ id: "item-901", issueNumber: 901, status: "Backlog", labels: ["done:refiner", "priority:high"] }),
      ]);
      await runAutoAdvance(client, 1, 1);
      assert.deepEqual(client.updateItemStatusCalls, []);
    });
  });

  test("refiner runs hold seats like any other run", async () => {
    await withStageSet("builder", async () => {
      const client = new MockClient([
        makeItem({ id: "item-901", issueNumber: 901, status: "Backlog", labels: ["done:refiner"] }),
      ]);

      await runAutoAdvance(client, 3, 3);
      assert.equal(client.updateItemStatusCalls.length, 0);

      await runAutoAdvance(client, 3, 2);
      assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-901", newStatus: "In Development" }]);
    });
  });
});

describe("runReworkRouting — cache invalidation", () => {
  test("clears cache after stripping a needs-rework label (same-column case)", async () => {
    // The 2026-05-03 incident's other half: pre-cycle reworkRouting
    // stripped `needs-rework:po` from #132 in Backlog, but the cache
    // still showed the label until next cycle. Per-agent loop saw the
    // stale label and skipped PO in this cycle (or, more dangerously,
    // saw a clean cache and dispatched on a ticket that had a stale
    // need-rework still queued — depending on ordering).
    //
    // After the fix: any successful rework route invalidates the cache
    // so subsequent sub-steps see the post-strip / post-bump state.
    const item = makeItem({
      id: "item-132",
      issueNumber: 132,
      status: "Backlog",
      labels: ["needs-rework:po", "size:s"],
    });
    const client = new MockClient([item]);

    await runReworkRouting(client);

    // The route stripped the label and bumped the counter. A rework sent
    // to anyone but the code owner counts on rework-other (#122).
    assert.ok(
      client.removeLabelCalls.some(c => c.issueNumber === 132 && c.label === "needs-rework:po"),
      "expected needs-rework:po to be stripped",
    );
    assert.ok(
      client.addLabelCalls.some(c => c.issueNumber === 132 && c.label === "rework-other:1"),
      "expected rework-other:1 to be added",
    );

    // The fix: cache invalidated.
    assert.equal(
      client.clearItemsCacheCalls,
      1,
      "expected clearItemsCache after a successful rework route",
    );
  });

  test("clears cache after a cross-column rework route", async () => {
    // Architect column ticket gets `needs-rework:developer` → routed
    // back to In Development. Both the column move and the label strip
    // are cache-invisible without invalidation.
    const item = makeItem({
      id: "item-300",
      issueNumber: 300,
      status: "In Architecture",
      labels: ["needs-rework:developer", "done:architect", "size:m"],
    });
    const client = new MockClient([item]);

    await runReworkRouting(client);

    assert.equal(client.updateItemStatusCalls.length, 1);
    assert.equal(client.updateItemStatusCalls[0]?.newStatus, "In Development");
    assert.equal(client.clearItemsCacheCalls, 1);
  });

  test("does NOT clear cache when there is nothing to route", async () => {
    const client = new MockClient([]);

    await runReworkRouting(client);

    assert.equal(client.updateItemStatusCalls.length, 0);
    assert.equal(client.clearItemsCacheCalls, 0);
  });

  test("a rework label naming an agent the set lacks parks the ticket once, with a comment", async () => {
    // pyrycode #2089, 2026-09-06: `needs-rework:po` on the builder set. The
    // label routed nowhere, stayed on, and the verifier that applied it was
    // simply re-dispatched next cycle.
    const item = makeItem({
      id: "item-2089",
      issueNumber: 2089,
      status: "In Code Review",
      labels: ["needs-rework:nobody", "size:s"],
    });
    const client = new MockClient([item]);

    await runReworkRouting(client);

    assert.deepEqual(client.updateItemStatusCalls, [], "nothing to move it to");
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 2089, label: "error:rework-target" }]);
    assert.match(client.addCommentCalls[0]?.body ?? "", /needs-rework:nobody/);
    assert.equal(client.clearItemsCacheCalls, 1);

    // Next cycle: already parked, so nothing more is written.
    await runReworkRouting(client);
    assert.equal(client.addLabelCalls.length, 1);
    assert.equal(client.addCommentCalls.length, 1);
  });

  test("a refinement bail on a blocked ticket waits in place, uncounted, even at the loop threshold", async () => {
    // pyrycode-mobile #808, 2026-09-23: two file-overlap bails had already
    // walked it to rework-count:2. At the threshold a real rework would halt.
    await withStageSet("builder", async () => {
      const item = makeItem({
        id: "item-808",
        issueNumber: 808,
        status: "In Development",
        labels: ["needs-rework:refiner", "done:refiner", "rework-count:3"],
        blockedBy: [{ number: 804, state: "OPEN" }],
      });
      const client = new MockClient([item]);

      await runReworkRouting(client);

      assert.deepEqual(client.updateItemStatusCalls, [], "stays in In Development");
      assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 808, label: "needs-rework:refiner" }]);
      assert.deepEqual(client.addLabelCalls, [], "no counter bump, no error:rework-loop");
      assert.match(client.addCommentCalls[0]?.body ?? "", /Waiting on #804/);
      assert.deepEqual(item.labels, ["done:refiner", "rework-count:3"]);
      assert.equal(client.clearItemsCacheCalls, 1);

      // Next cycle: the trigger is gone, so nothing more is written.
      await runReworkRouting(client);
      assert.equal(client.addCommentCalls.length, 1);
    });
  });

  test("a merge handoff moves the ticket to the owner without counting, even at the loop threshold", async () => {
    // pyrycode-mobile #808, 2026-09-23: documentation's merge of main hit
    // #805's line and sent the ticket back to the builder (merge-handoff.ts).
    await withStageSet("builder", async () => {
      const item = makeItem({
        id: "item-808",
        issueNumber: 808,
        status: "In Documentation",
        labels: ["done:verifier", "rework-count:3", "merge-handoff", "needs-rework:builder"],
      });
      const client = new MockClient([item]);

      await runReworkRouting(client);

      assert.deepEqual(client.updateItemStatusCalls.map(c => c.newStatus), ["In Development"]);
      assert.deepEqual(client.addLabelCalls, [], "no counter bump, no error:rework-loop");
      assert.deepEqual(item.labels, ["rework-count:3"], "trigger, marker and done:verifier stripped; counter untouched");
      assert.equal(client.clearItemsCacheCalls, 1);
    });
  });

  test("the same rework without the marker still counts", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({
        id: "item-809",
        issueNumber: 809,
        status: "In Code Review",
        labels: ["done:verifier", "rework-count:1", "needs-rework:builder"],
      });
      const client = new MockClient([item]);

      await runReworkRouting(client);

      assert.deepEqual(client.addLabelCalls, [{ issueNumber: 809, label: "rework-count:2" }]);
    });
  });
});

// agent-dispatcher#122, 2026-10-05: the breaker counted every rework route
// alike and parked at 3. Mobile #1782 was parked mid-progress (four verifier
// rounds, different defects each time, passed on the next round once
// restarted), and #1735 reached the limit on documentation asking the
// verifier for evidence. Now only builder reworks count; a verifier finding
// repeated across two FAIL verdicts parks at once; a hard cap backs it up.
describe("runReworkRouting — builder rework breaker (#122)", () => {
  const row = "[MUST FIX] `app/src/ui/ChannelListScreen.kt` → `ChannelRow`: hardcoded colour";
  const failVerdict = (...findings: string[]) =>
    `## Verifier Review: #1782\n\n**Decision: FAIL**\n**Gates:** green\n\n### Findings\n` +
    findings.map(f => `- ${f}`).join("\n") + "\n\n### Summary\nFix the findings.";
  const finding = (round: number) => `[MUST FIX] \`app/src/ui/Screen${round}.kt\` → \`Defect${round}\`: round ${round}`;

  /** A PR whose comments are the given verdict bodies, an hour apart. */
  const prJson = (bodies: string[]) => JSON.stringify({
    reviews: [],
    comments: bodies.map((body, i) => ({ createdAt: new Date(Date.UTC(2026, 9, 4, i)).toISOString(), body })),
  });

  /** Put the ticket in `status` with `trigger` and run one routing pass. */
  async function route(client: MockClient, item: ProjectItem, status: string, trigger: string, options = {}) {
    item.status = status;
    item.labels.push(trigger);
    await runReworkRouting(client, options);
  }

  test("three verifier reworks and two builder reworks leave the ticket unparked at rework-count:2", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({ id: "item-1735", issueNumber: 1735, labels: ["size:m"] });
      const client = new MockClient([item]);
      let reads = 0;
      const options = { readPrVerdicts: async () => { reads++; return prJson([failVerdict(finding(reads))]); } };

      await route(client, item, "In Documentation", "needs-rework:verifier", options);
      await route(client, item, "In Code Review", "needs-rework:builder", options);
      await route(client, item, "In Documentation", "needs-rework:verifier", options);
      await route(client, item, "In Code Review", "needs-rework:builder", options);
      await route(client, item, "In Documentation", "needs-rework:verifier", options);

      assert.deepEqual(item.labels.sort(), ["rework-count:2", "rework-other:3", "size:m"]);
      assert.equal(item.status, "In Code Review", "the last route went through");
      assert.equal(client.addCommentCalls.length, 0, "no rework-loop comment");
      assert.equal(reads, 2, "verdicts are read only on the verifier's routes to the builder");
    });
  });

  test("two consecutive FAIL verdicts sharing a MUST FIX key park on the second route and name the key", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({ id: "item-1655", issueNumber: 1655, labels: [] });
      const client = new MockClient([item]);
      const verdicts = [failVerdict(row)];
      const options = { readPrVerdicts: async () => prJson(verdicts) };

      await route(client, item, "In Code Review", "needs-rework:builder", options);
      assert.equal(item.status, "In Development", "one FAIL has nothing to repeat");
      assert.ok(item.labels.includes("rework-count:1"));

      verdicts.push(failVerdict(row, finding(2)));
      await route(client, item, "In Code Review", "needs-rework:builder", options);

      assert.equal(item.status, "In Code Review", "parked where it stands");
      assert.ok(item.labels.includes("error:rework-loop"));
      assert.ok(item.labels.includes("rework-count:1"), "the parked route counts nothing");
      const comment = client.addCommentCalls.at(-1)?.body ?? "";
      assert.match(comment, /Rework loop detected/);
      assert.match(comment, /repeated finding/i);
      assert.ok(comment.includes("app/src/ui/ChannelListScreen.kt → ChannelRow"), comment);

      // Next cycle the trigger is still there: already parked, nothing more is written.
      const comments = client.addCommentCalls.length;
      await runReworkRouting(client, options);
      assert.equal(client.addCommentCalls.length, comments);
    });
  });

  test("the #1782 shape: builder reworks with disjoint findings keep routing until one would pass the hard cap", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({ id: "item-1782", issueNumber: 1782, labels: [] });
      const client = new MockClient([item]);
      const verdicts: string[] = [];
      const options = { readPrVerdicts: async () => prJson(verdicts) };

      for (let round = 1; round <= 4; round++) {
        verdicts.push(failVerdict(finding(round)));
        await route(client, item, "In Code Review", "needs-rework:builder", options);
        assert.equal(item.status, "In Development", `round ${round} routes`);
        assert.ok(item.labels.includes(`rework-count:${round}`));
      }
      assert.ok(!item.labels.includes("error:rework-loop"), "four rounds of progress do not park");

      for (let round = 5; round <= 6; round++) {
        verdicts.push(failVerdict(finding(round)));
        await route(client, item, "In Code Review", "needs-rework:builder", options);
      }
      assert.ok(item.labels.includes("rework-count:6"));
      assert.ok(!item.labels.includes("error:rework-loop"), "the sixth rework is still within the cap");

      verdicts.push(failVerdict(finding(7)));
      await route(client, item, "In Code Review", "needs-rework:builder", options);
      assert.equal(item.status, "In Code Review");
      assert.ok(item.labels.includes("error:rework-loop"), "the route that passes the cap parks");
      const comment = client.addCommentCalls.at(-1)?.body ?? "";
      assert.match(comment, /hard cap/i);
      assert.match(comment, /6/);
      assert.doesNotMatch(comment, /repeated finding/i);
    });
  });

  test("FAIL verdicts with no parseable keys fall back to the count rule", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({ id: "item-50", issueNumber: 50, labels: ["rework-count:1"] });
      const client = new MockClient([item]);
      const keyless = [failVerdict("[MUST FIX] the suite is red"), failVerdict("[MUST FIX] the suite is red")];
      const options = { hardCap: 2, readPrVerdicts: async () => prJson(keyless) };

      await route(client, item, "In Code Review", "needs-rework:builder", options);
      assert.equal(item.status, "In Development", "no keys, no repeat: the count rule lets it through");
      assert.ok(item.labels.includes("rework-count:2"));

      await route(client, item, "In Code Review", "needs-rework:builder", options);
      assert.ok(item.labels.includes("error:rework-loop"), "a configured cap is honoured");
      assert.match(client.addCommentCalls.at(-1)?.body ?? "", /hard cap/i);
    });
  });

  test("a verdict read that fails, or finds no PR, is never a repeat", async () => {
    await withStageSet("builder", async () => {
      const failing = makeItem({ id: "item-51", issueNumber: 51, labels: [] });
      const client = new MockClient([failing]);
      const throwing = { readPrVerdicts: async (): Promise<string | null> => { throw new Error("gh: HTTP 502"); } };

      await route(client, failing, "In Code Review", "needs-rework:builder", throwing);
      assert.equal(failing.status, "In Development");
      assert.ok(failing.labels.includes("rework-count:1"));

      failing.labels = ["rework-count:6"];
      await route(client, failing, "In Code Review", "needs-rework:builder", throwing);
      assert.ok(failing.labels.includes("error:rework-loop"), "the count rule still applies");
      assert.match(client.addCommentCalls.at(-1)?.body ?? "", /hard cap/i);

      const noPr = makeItem({ id: "item-52", issueNumber: 52, labels: [] });
      client.items.push(noPr);
      await route(client, noPr, "In Code Review", "needs-rework:builder", { readPrVerdicts: async () => null });
      assert.equal(noPr.status, "In Development");
      assert.ok(noPr.labels.includes("rework-count:1"));
    });
  });
});

describe("runRealClaudeGate — parks gated tickets in Inbox", () => {
  test("routes a reviewed needs-real-claude ticket to Inbox and clears cache", async () => {
    const item = makeItem({
      id: "item-1168",
      issueNumber: 1168,
      status: "In Code Review",
      labels: ["done:code-review", "size:s", "needs-real-claude"],
    });
    const client = new MockClient([item]);

    await runRealClaudeGate(client);

    assert.equal(client.updateItemStatusCalls.length, 1);
    assert.equal(client.updateItemStatusCalls[0]?.itemId, "item-1168");
    assert.equal(client.updateItemStatusCalls[0]?.newStatus, "Inbox");
    assert.equal(item.status, "Inbox");
    assert.equal(client.clearItemsCacheCalls, 1);
  });

  test("leaves an un-reviewed or unlabelled ticket in place (no mutation, no cache clear)", async () => {
    const unreviewed = makeItem({ id: "a", issueNumber: 1, status: "In Code Review", labels: ["needs-real-claude"] });
    const unlabelled = makeItem({ id: "b", issueNumber: 2, status: "In Code Review", labels: ["done:code-review"] });
    const client = new MockClient([unreviewed, unlabelled]);

    await runRealClaudeGate(client);

    assert.equal(client.updateItemStatusCalls.length, 0);
    assert.equal(client.clearItemsCacheCalls, 0);
  });
});

// --------- Dispatcher-executed real-claude gate ---------

/** Build a tally with only the fields a test cares about. */
function tally(overrides: Partial<GateTally> = {}): GateTally {
  return {
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    failedNames: [],
    passedNames: [],
    timedOutTests: [],
    skipReasons: [],
    packageFailed: false,
    packageFailures: [],
    recognizedLines: 1,
    ...overrides,
  };
}

function report(overrides: Partial<GateRunReport> = {}): GateRunReport {
  return {
    runError: null,
    timedOut: false,
    exitCode: 0,
    tally: tally({ executed: 176, passed: 176, skipped: 14 }),
    command: "go test -tags e2e_realclaude -json ./...",
    branchName: "feature/1382",
    baseRef: "origin/main",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    commitsBehind: 29,
    durationMs: 308_022,
    outputPath: "/logs/gate.log",
    outputBytes: 2_100_000,
    baselineFailures: null,
    baselineSkipReason: "no named test failures to compare",
    baselineOutputPath: null,
    rerunFailures: null,
    rerunSkipReason: "no named test failures to re-run",
    rerunOutputPath: null,
    ...overrides,
  };
}

/** A parked, fully eligible gate candidate. */
function parkedItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return makeItem({
    id: "item-1382",
    issueNumber: 1382,
    status: "Inbox",
    labels: ["done:code-review", "needs-real-claude", "size:m"],
    ...overrides,
  });
}

describe("runRealClaudeGateExecution — the off switch", () => {
  test("a null runner touches nothing at all", async () => {
    // The whole feature ships disabled. This is the property that lets it
    // land on a live dispatcher: with no command configured, the step must
    // not read the board, mutate it, or clear the cache.
    const client = new MockClient([parkedItem()]);

    await runRealClaudeGateExecution(client, null, 150, async () => {});

    assert.equal(client.updateItemStatusCalls.length, 0);
    assert.equal(client.addLabelCalls.length, 0);
    assert.equal(client.addCommentCalls.length, 0);
    assert.equal(client.clearItemsCacheCalls, 0);
    assert.equal(client.getIssueLabelsCalls.length, 0);
  });
});

describe("runRealClaudeGateExecution — selection", () => {
  test("runs exactly ONE gate even when two tickets are eligible", async () => {
    // A gate is minutes of blocking wall clock. Two per cycle would stall
    // ticket selection for the sum of both, so the step takes the first in
    // board order and leaves the rest for later cycles.
    const first = parkedItem({ id: "item-1382", issueNumber: 1382 });
    const second = parkedItem({ id: "item-1381", issueNumber: 1381 });
    const client = new MockClient([first, second]);
    const ran: number[] = [];

    await runRealClaudeGateExecution(
      client,
      async ({ issueNumber }) => { ran.push(issueNumber); return report(); },
      150,
      async () => {},
    );

    assert.deepEqual(ran, [1382], "expected exactly one gate run, on the first ticket in board order");
  });

  test("shows the running label only while the live suite is executing", async () => {
    const item = parkedItem();
    const client = new MockClient([item]);
    await runRealClaudeGateExecution(client, async () => {
      assert.ok(item.labels.includes(REAL_CLAUDE_GATE_RUNNING_LABEL));
      assert.equal(item.status, "Inbox");
      return report();
    }, 150, async () => {});
    assert.ok(!item.labels.includes(REAL_CLAUDE_GATE_RUNNING_LABEL));
  });

  test("does not start the suite when its running label cannot be written", async () => {
    const client = new MockClient([parkedItem()]);
    client.addLabel = async () => { throw new Error("GitHub unavailable"); };
    let ran = false;
    await runRealClaudeGateExecution(client, async () => { ran = true; return report(); }, 150, async () => {});
    assert.equal(ran, false);
    assert.equal(client.addCommentCalls.length, 0);
  });

  test("waits for stale running labels to be cleared before retrying", async () => {
    const client = new MockClient([parkedItem({ labels: ["done:code-review", "needs-real-claude", REAL_CLAUDE_GATE_RUNNING_LABEL] })]);
    let ran = false;
    await runRealClaudeGateExecution(client, async () => { ran = true; return report(); }, 150, async () => {});
    assert.equal(ran, false);
  });

  test("skips a ticket the FRESH label read disqualifies", async () => {
    // The board snapshot asks GitHub for `labels(first: 10)`, and a ticket
    // this far down the pipeline can carry ten already — so the snapshot can
    // be missing the error label that should stop the run. The fresh read is
    // the only thing standing between that and a pointless 5-minute suite.
    const item = parkedItem();
    const client = new MockClient([item]);
    client.freshLabels.set(1382, [...item.labels, "error:developer"]);
    let ranCount = 0;

    await runRealClaudeGateExecution(
      client,
      async () => { ranCount++; return report(); },
      150,
      async () => {},
    );

    assert.equal(ranCount, 0, "a ticket carrying error:* must not be gated");
    assert.equal(client.updateItemStatusCalls.length, 0);
  });

  test("does not run when the fresh label read fails", async () => {
    // No fresh read means no confirmed eligibility. Falling back to the
    // possibly-truncated snapshot is exactly the guess this guard exists
    // to prevent.
    const client = new MockClient([parkedItem()]);
    client.getIssueLabelsError = new Error("REST 502");
    let ranCount = 0;

    await runRealClaudeGateExecution(client, async () => { ranCount++; return report(); }, 150, async () => {});

    assert.equal(ranCount, 0);
    assert.equal(client.clearItemsCacheCalls, 0);
  });

  test("ignores a ticket that is merely parked without a finished review", async () => {
    const noReview = parkedItem({ id: "a", issueNumber: 1, labels: ["needs-real-claude"] });
    const noLabel = parkedItem({ id: "b", issueNumber: 2, labels: ["done:code-review"] });
    const client = new MockClient([noReview, noLabel]);
    let ranCount = 0;

    await runRealClaudeGateExecution(client, async () => { ranCount++; return report(); }, 150, async () => {});

    assert.equal(ranCount, 0);
  });
});

describe("runRealClaudeGateExecution — never beside an agent run", () => {
  test("holds a confirmed candidate while runs are in flight", async () => {
    // mobile #993: a builder's device tests on the same managed device
    // stretched the gate past its pairing-code window and failed the branch.
    const client = new MockClient([parkedItem()]);
    let ranCount = 0;

    const held = await runRealClaudeGateExecution(
      client, async () => { ranCount++; return report(); }, 150, async () => {}, 1,
    );

    assert.equal(held, true);
    assert.equal(ranCount, 0, "the suite must not start beside an in-flight run");
    assert.equal(client.updateItemStatusCalls.length, 0);
    assert.equal(client.addCommentCalls.length, 0);
  });

  test("runs once nothing is in flight", async () => {
    const client = new MockClient([parkedItem()]);
    let ranCount = 0;

    const held = await runRealClaudeGateExecution(
      client, async () => { ranCount++; return report(); }, 150, async () => {}, 0,
    );

    assert.equal(held, false);
    assert.equal(ranCount, 1);
  });

  test("does not hold dispatch for a candidate the fresh read disqualifies", async () => {
    const item = parkedItem();
    const client = new MockClient([item]);
    client.freshLabels.set(1382, [...item.labels, "error:developer"]);

    const held = await runRealClaudeGateExecution(client, async () => report(), 150, async () => {}, 2);

    assert.equal(held, false);
  });

  test("does not hold with no candidate", async () => {
    const client = new MockClient([]);

    assert.equal(await runRealClaudeGateExecution(client, async () => report(), 150, async () => {}, 2), false);
  });
});

describe("runRealClaudeGateExecution — in the background", () => {
  test("marks the ticket, hands the run over, and returns before the suite runs", async () => {
    const client = new MockClient([parkedItem()]);
    let ranCount = 0;
    let handed: { issue: number; work: () => Promise<void> } | null = null;

    const started = await runRealClaudeGateExecution(
      client, async () => { ranCount++; return report(); }, 150, async () => {}, 0, undefined,
      (issue, work) => { handed = { issue, work }; },
    );

    assert.equal(started, true, "a started background run holds verifiers like a wait does");
    assert.equal(ranCount, 0, "the suite runs only when the caller starts the handed work");
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
    assert.equal(handed!.issue, 1382);

    await handed!.work();
    assert.equal(ranCount, 1);
    assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-1382", newStatus: "In Documentation" }]);
    assert.ok(client.removeLabelCalls.some(c => c.label === REAL_CLAUDE_GATE_RUNNING_LABEL));
  });

  test("waits for conflicting runs without handing anything over", async () => {
    const client = new MockClient([parkedItem()]);
    let handedCount = 0;

    const held = await runRealClaudeGateExecution(
      client, async () => report(), 150, async () => {}, 1, undefined, () => { handedCount++; },
    );

    assert.equal(held, true);
    assert.equal(handedCount, 0);
    assert.equal(client.addLabelCalls.length, 0, "a waiting gate does not mark the ticket as running");
  });

  test("handed work never rejects, even when the runner throws", async () => {
    const client = new MockClient([parkedItem()]);
    let handed: (() => Promise<void>) | null = null;

    await runRealClaudeGateExecution(
      client, async () => { throw new Error("boom"); }, 150, async () => {}, 0, undefined,
      (_issue, work) => { handed = work; },
    );

    await handed!();
    assert.ok(client.addLabelCalls.some(c => c.label === "error:real-claude-gate"), "a thrown runner still parks");
    assert.ok(client.removeLabelCalls.some(c => c.label === REAL_CLAUDE_GATE_RUNNING_LABEL));
  });
});

describe("runRealClaudeGateExecution — outcomes", () => {
  test("pass advances the ticket and clears the gate label", async () => {
    const item = parkedItem();
    const client = new MockClient([item]);

    await runRealClaudeGateExecution(client, async () => report(), 150, async () => {});

    assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-1382", newStatus: "In Documentation" }]);
    assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 1382, label: "needs-real-claude" }, { issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
    assert.equal(item.status, "In Documentation");
  });

  test("failure routes to the developer and KEEPS needs-real-claude", async () => {
    // Dropping the label would let the fix walk to Done having proved
    // nothing. Keeping it forces a re-gate after the rework.
    const item = parkedItem();
    const client = new MockClient([item]);
    const failing = report({
      exitCode: 1,
      tally: tally({ executed: 176, passed: 175, failed: 1, failedNames: ["pkg.TestThing"], packageFailed: true }),
    });

    await runRealClaudeGateExecution(client, async () => failing, 150, async () => {});

    assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-1382", newStatus: "In Development" }]);
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }, { issueNumber: 1382, label: "needs-rework:developer" }]);
    assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
    assert.ok(item.labels.includes("needs-real-claude"));
  });

  test("inherited live failure waits at the retry limit, then re-gates after its fix closes", async () => {
    await withStageSet("builder", async () => {
      const item = parkedItem({ issueNumber: 1397, labels: ["done:verifier", "needs-real-claude", "rework-count:3"] });
      const client = new MockClient([item]);
      const inherited = report({ exitCode: 1,
        tally: tally({ executed: 176, passed: 175, failed: 1, failedNames: ["pkg.TestThing"] }),
        baselineFailures: ["pkg.TestThing"], baselineOutputPath: "/logs/base.log" });
      let filed = 0;
      await runRealClaudeGateExecution(client, async () => inherited, 150, async () => {}, 0, undefined, undefined,
        async (names, ctx) => {
          assert.deepEqual(names, ["pkg.TestThing"]);
          assert.equal(ctx.gatedIssue, 1397);
          assert.equal(ctx.report.baselineOutputPath, "/logs/base.log");
          filed++;
          item.blockedBy = [{ number: 1500, state: "OPEN" }];
          return { blockers: [{ name: "pkg.TestThing", issue: 1500 }], untracked: [] };
        });
      await runReworkRouting(client);
      assert.equal(filed, 1);
      assert.equal(item.status, "Inbox");
      assert.deepEqual(item.labels.sort(), ["done:verifier", "needs-real-claude", "rework-count:3"].sort());
      assert.match(client.addCommentCalls[0].body, /#1500/);
      let ran = false;
      await runRealClaudeGateExecution(client, async () => { ran = true; return report(); }, 150, async () => {});
      assert.equal(ran, false, "open fix blocks another expensive run");
      item.blockedBy[0].state = "CLOSED";
      await runRealClaudeGateExecution(client, async () => { ran = true; return report(); }, 150, async () => {});
      assert.equal(ran, true);
      assert.equal(item.status, "In Documentation");
      assert.ok(!item.labels.includes("needs-real-claude"));
      assert.ok(item.labels.includes("rework-count:3"));
    });
  });

  test("failed shared-ticket filing parks for recovery without spending rework", async () => {
    const item = parkedItem({ labels: ["done:code-review", "needs-real-claude", "rework-count:3"] });
    const client = new MockClient([item]);
    const inherited = report({ exitCode: 1,
      tally: tally({ executed: 176, passed: 175, failed: 1, failedNames: ["pkg.TestThing"] }),
      baselineFailures: ["pkg.TestThing"] });
    await runRealClaudeGateExecution(client, async () => inherited, 150, async () => {}, 0, undefined, undefined,
      async () => { throw new Error("GitHub unavailable"); });
    await runReworkRouting(client);
    assert.equal(item.status, "Inbox");
    assert.ok(item.labels.includes("error:real-claude-gate"));
    assert.ok(item.labels.includes("rework-count:3"));
    assert.ok(!item.labels.some(l => l.startsWith("needs-rework:")));
    assert.match(client.addCommentCalls[0].body, /could not.*blocker/i);
  });

  test("mixed failures get separate shared tickets while the branch regression still routes to its builder", async () => {
    const item = parkedItem(); const client = new MockClient([item]);
    const mixed = report({ exitCode: 1,
      tally: tally({ executed: 176, passed: 174, failed: 2, failedNames: ["pkg.Shared", "pkg.Regression"] }),
      baselineFailures: ["pkg.Shared"] });
    let tracked: readonly string[] = [];
    await runRealClaudeGateExecution(client, async () => mixed, 150, async () => {}, 0, undefined, undefined,
      async names => { tracked = names; return { blockers: [{ name: "pkg.Shared", issue: 1500 }], untracked: [] }; });
    assert.deepEqual(tracked, ["pkg.Shared"]);
    assert.equal(item.status, "In Development");
    assert.ok(item.labels.includes("needs-rework:developer"));
    assert.match(client.addCommentCalls[0].body, /#1500/);
  });

  test("a fix ticket that still fails its own named test returns to its builder", async () => {
    const item = parkedItem(); const client = new MockClient([item]);
    const inherited = report({ exitCode: 1,
      tally: tally({ executed: 176, passed: 175, failed: 1, failedNames: ["pkg.Shared"] }),
      baselineFailures: ["pkg.Shared"] });
    await runRealClaudeGateExecution(client, async () => inherited, 150, async () => {}, 0, undefined, undefined,
      async () => ({ blockers: [], untracked: [], owned: ["pkg.Shared"] }));
    assert.equal(item.status, "In Development");
    assert.ok(item.labels.includes("needs-rework:developer"));
    assert.match(client.addCommentCalls[0].body, /already owns the fix/);
  });

  test("fresh blockers added after the board snapshot prevent another live run", async () => {
    const client = new MockClient([parkedItem()]);
    client.getOpenBlockers = async () => [1500];
    let ran = false;
    await runRealClaudeGateExecution(client, async () => { ran = true; return report(); }, 150, async () => {});
    assert.equal(ran, false);
    client.getOpenBlockers = async () => { throw Error("GitHub unavailable"); };
    await runRealClaudeGateExecution(client, async () => { ran = true; return report(); }, 150, async () => {});
    assert.equal(ran, false);
  });

  test("a failure that passed on the same-tree re-run advances like a pass and pings a human", async () => {
    // pyrycode #2089, 2026-09-06: one flaky liveness test, green on re-run,
    // must not cost the ticket a rework lap. The ping is about the suite.
    const item = parkedItem();
    const client = new MockClient([item]);
    const notifications: string[] = [];
    const flaky = report({
      exitCode: 1,
      tally: tally({ executed: 176, passed: 175, failed: 1, failedNames: ["pkg.TestLiveness"], packageFailed: true }),
      rerunFailures: [],
      rerunSkipReason: null,
      rerunOutputPath: "/logs/rerun.log",
    });

    await runRealClaudeGateExecution(client, async () => flaky, 150, async (m) => { notifications.push(m); });

    assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-1382", newStatus: "In Documentation" }]);
    assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 1382, label: "needs-real-claude" }, { issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }], "no rework label, no error label");
    assert.equal(notifications.length, 1, "the flake gets a human's attention");
    assert.match(notifications[0], /TestLiveness/);
    assert.match(client.addCommentCalls[0]?.body ?? "", /passed when re-run on the same merged tree/);
  });

  test("hands the flaky tests to the filer after the ticket's own writes, and names the ticket in the ping", async () => {
    // pyrycode-mobile, 2026-09-24: with the re-run letting tickets through,
    // nothing filed the flakes, and the silent second-client bug went a day
    // untracked. The filer runs last so it can never hold up the verdict.
    const item = parkedItem();
    const client = new MockClient([item]);
    const notifications: string[] = [];
    const calls: { flaky: readonly string[]; gatedIssue: number; movedFirst: boolean }[] = [];
    const flaky = report({
      exitCode: 1,
      tally: tally({ executed: 176, passed: 175, failed: 1, failedNames: ["pkg.TestLiveness"], packageFailed: true }),
      rerunFailures: [],
      rerunSkipReason: null,
      rerunOutputPath: "/logs/rerun.log",
    });

    await runRealClaudeGateExecution(
      client,
      async () => flaky,
      150,
      async (m) => { notifications.push(m); },
      0,
      async (names, ctx) => {
        calls.push({ flaky: names, gatedIssue: ctx.gatedIssue, movedFirst: client.updateItemStatusCalls.length === 1 });
        return { filed: [{ name: names[0], issue: 2600 }], commented: [], untracked: [] };
      },
    );

    assert.deepEqual(calls, [{ flaky: ["pkg.TestLiveness"], gatedIssue: 1382, movedFirst: true }]);
    assert.match(notifications[0], /Tracked on #2600/);
  });

  test("does not call the filer when nothing was flaky", async () => {
    const client = new MockClient([parkedItem()]);
    let called = 0;

    await runRealClaudeGateExecution(client, async () => report(), 150, async () => {}, 0, async () => {
      called++;
      return { filed: [], commented: [], untracked: [] };
    });

    assert.equal(called, 0);
  });

  test("an all-skip suite with exit 0 parks loudly instead of advancing", async () => {
    // The 2026-07-22 shape, end to end: every test skipped, exit 0. This is
    // the single most important assertion in the file. If it ever goes
    // green-by-advancing, the gate has become the bug it was built to stop.
    const item = parkedItem();
    const client = new MockClient([item]);
    const notifications: string[] = [];
    const allSkipped = report({
      exitCode: 0,
      tally: tally({ executed: 0, passed: 0, skipped: 190, skipReasons: ["pkg.TestX: CLAUDE_CODE_OAUTH_TOKEN not set"] }),
    });

    await runRealClaudeGateExecution(client, async () => allSkipped, 150, async (m) => { notifications.push(m); });

    assert.equal(client.updateItemStatusCalls.length, 0, "must not move the ticket anywhere");
    assert.equal(item.status, "Inbox");
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }, { issueNumber: 1382, label: "error:real-claude-gate" }]);
    assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
    assert.equal(notifications.length, 1, "a gate that cannot judge must ping a human");
  });

  test("exit 0 with no artifact at all parks rather than passing", async () => {
    const client = new MockClient([parkedItem()]);
    const notifications: string[] = [];

    await runRealClaudeGateExecution(
      client,
      async () => report({ exitCode: 0, tally: null }),
      150,
      async (m) => { notifications.push(m); },
    );

    assert.equal(client.updateItemStatusCalls.length, 0);
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }, { issueNumber: 1382, label: "error:real-claude-gate" }]);
    assert.equal(notifications.length, 1);
  });

  test("a runner that throws still parks the ticket", async () => {
    // Without this, the exception escapes, the card sits in Inbox with no
    // error label, and the next cycle picks it up and throws again — an
    // invisible loop that burns a full suite's wall clock each time.
    const client = new MockClient([parkedItem()]);
    const notifications: string[] = [];

    await runRealClaudeGateExecution(
      client,
      async () => { throw new Error("worktree exploded"); },
      150,
      async (m) => { notifications.push(m); },
    );

    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 1382, label: REAL_CLAUDE_GATE_RUNNING_LABEL }, { issueNumber: 1382, label: "error:real-claude-gate" }]);
    assert.equal(notifications.length, 1);
    assert.match(client.addCommentCalls[0]?.body ?? "", /worktree exploded/);
  });
});

describe("runRealClaudeGateExecution — evidence and cache", () => {
  test("clears the items cache after ANY run, including one that changed nothing", async () => {
    // Not the usual mutated-only rule. A suite is 300s-plus, so by the time
    // it returns the cycle's board snapshot is minutes stale — and ticket
    // selection still runs after this step.
    const client = new MockClient([parkedItem()]);

    await runRealClaudeGateExecution(
      client,
      async () => report({ exitCode: 0, tally: null }),  // parks, moves nothing
      150,
      async () => {},
    );

    assert.equal(client.updateItemStatusCalls.length, 0, "sanity: this run moved nothing");
    assert.equal(client.clearItemsCacheCalls, 1, "the cache is stale by wall clock, not by mutation");
  });

  test("the evidence comment carries the commits-behind figure and the executed count", async () => {
    // Both numbers are what make the verdict auditable rather than asserted.
    const client = new MockClient([parkedItem()]);

    await runRealClaudeGateExecution(client, async () => report(), 150, async () => {});

    const body = client.addCommentCalls[0]?.body ?? "";
    assert.match(body, /29 commit\(s\) behind/);
    assert.match(body, /\| 176 \| 176 \| 0 \| 14 \|/);
    assert.match(body, /go test -tags e2e_realclaude/);
    assert.match(body, /In Documentation/);
  });

  test("skip reasons are listed on a pass, not silently absorbed", async () => {
    // 14 deliberate skips are expected on this suite. Listing them is how a
    // reader can tell a deliberate skip from a credential that fell out.
    const client = new MockClient([parkedItem()]);
    const withSkips = report({
      tally: tally({
        executed: 176,
        passed: 176,
        skipped: 2,
        skipReasons: ["pkg.TestExternal: no network", "pkg.TestBilling: metered key absent"],
      }),
    });

    await runRealClaudeGateExecution(client, async () => withSkips, 150, async () => {});

    const body = client.addCommentCalls[0]?.body ?? "";
    assert.match(body, /metered key absent/);
    assert.match(body, /a skip is not a pass/);
  });
});

// --------- Real-claude gate under the builder stage set ---------
//
// The gate's trigger and rework labels derive from the active stage set:
// done:code-review / needs-rework:developer in classic (every test above,
// unchanged), done:verifier / needs-rework:builder under builder. These
// tests walk a needs-real-claude ticket through park + execute under the
// builder set exactly the way the classic tests above do, so the pilot
// fork keeps its e2e proof.

/** Pin PYRY_STAGE_SET for one test, resetting the memoized set both ways. */
async function withStageSet<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.PYRY_STAGE_SET;
  if (value === undefined) delete process.env.PYRY_STAGE_SET;
  else process.env.PYRY_STAGE_SET = value;
  resetActiveStageSetForTests();
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.PYRY_STAGE_SET;
    else process.env.PYRY_STAGE_SET = prior;
    resetActiveStageSetForTests();
  }
}

/** A builder-set ticket that finished verifier review and wants the gate. */
function builderParkedItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return makeItem({
    id: "item-77",
    issueNumber: 77,
    status: "Inbox",
    labels: ["done:verifier", "needs-real-claude", "size:m"],
    ...overrides,
  });
}

describe("real-claude gate — builder stage set", () => {
  test("parks a verifier-reviewed needs-real-claude ticket in Inbox (done:verifier triggers)", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({
        id: "item-70",
        issueNumber: 70,
        status: "In Code Review",
        labels: ["done:verifier", "needs-real-claude"],
      });
      const client = new MockClient([item]);

      await runRealClaudeGate(client);

      assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-70", newStatus: "Inbox" }]);
      assert.equal(item.status, "Inbox");
      assert.equal(client.clearItemsCacheCalls, 1);
      // The operator instructions must name the SET's fail label, not the
      // classic one — needs-rework:developer would never route here.
      assert.match(client.addCommentCalls[0]?.body ?? "", /needs-rework:builder/);
      assert.ok(!(client.addCommentCalls[0]?.body ?? "").includes("needs-rework:developer"));
    });
  });

  test("does NOT park on the classic done:code-review under builder (no builder agent emits it)", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({
        id: "item-71",
        issueNumber: 71,
        status: "In Code Review",
        labels: ["done:code-review", "needs-real-claude"],
      });
      const client = new MockClient([item]);

      await runRealClaudeGate(client);

      assert.equal(client.updateItemStatusCalls.length, 0);
      assert.equal(client.clearItemsCacheCalls, 0);
    });
  });

  test("execute: pass advances to In Documentation and clears the gate label (as classic)", async () => {
    await withStageSet("builder", async () => {
      const item = builderParkedItem();
      const client = new MockClient([item]);

      await runRealClaudeGateExecution(client, async () => report(), 150, async () => {});

      assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-77", newStatus: "In Documentation" }]);
      assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 77, label: "needs-real-claude" }, { issueNumber: 77, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
      assert.deepEqual(client.addLabelCalls, [{ issueNumber: 77, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
      assert.equal(item.status, "In Documentation");
    });
  });

  test("execute: failure routes to In Development with needs-rework:builder, keeping needs-real-claude", async () => {
    await withStageSet("builder", async () => {
      const item = builderParkedItem();
      const client = new MockClient([item]);
      const failing = report({
        exitCode: 1,
        tally: tally({ executed: 176, passed: 175, failed: 1, failedNames: ["pkg.TestThing"], packageFailed: true }),
      });

      await runRealClaudeGateExecution(client, async () => failing, 150, async () => {});

      assert.deepEqual(client.updateItemStatusCalls, [{ itemId: "item-77", newStatus: "In Development" }]);
      assert.deepEqual(client.addLabelCalls, [{ issueNumber: 77, label: REAL_CLAUDE_GATE_RUNNING_LABEL }, { issueNumber: 77, label: "needs-rework:builder" }]);
      assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 77, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
      assert.ok(item.labels.includes("needs-real-claude"));
    });
  });

  test("execute: a classic-reviewed ticket (done:code-review) is not selected under builder", async () => {
    await withStageSet("builder", async () => {
      const item = builderParkedItem({ labels: ["done:code-review", "needs-real-claude"] });
      const client = new MockClient([item]);
      let ranCount = 0;

      await runRealClaudeGateExecution(client, async () => { ranCount++; return report(); }, 150, async () => {});

      assert.equal(ranCount, 0, "no run may start for a ticket the set's review stage never signed off");
      assert.equal(client.updateItemStatusCalls.length, 0);
    });
  });
});


describe("live artifact handoff", () => {
  for (const flaky of [false, true]) {
    test(`a ${flaky ? "flaky" : "clean"} pass returns pending artifacts for implementation and re-verification`, async () => {
      await withStageSet("builder", async () => {
        const item = builderParkedItem({ labels: ["done:builder", "done:verifier", "needs-real-claude", "needs-live-artifacts"] });
        const client = new MockClient([item]);
        const liveReport = flaky ? report({ exitCode: 1,
          tally: tally({ executed: 176, passed: 175, failed: 1, failedNames: ["pkg.TestCapture"], packageFailed: true }),
          rerunFailures: [],
        }) : report();
        await runRealClaudeGateExecution(client, async () => liveReport, 150, async () => {});
        assert.equal(item.status, "In Development");
        assert.ok(item.labels.includes("needs-rework:builder"));
        assert.ok(item.labels.includes("needs-live-artifacts"));
        assert.ok(item.labels.includes("needs-real-claude"));
        assert.match(client.addCommentCalls.at(-1)?.body ?? "", /commit.*artifact/i);
        await runReworkRouting(client);
        assert.ok(!item.labels.includes("done:builder"));
        assert.ok(!item.labels.includes("done:verifier"));
        // Builder commits the evidence and clears only its pending marker.
        item.labels = item.labels.filter(label => label !== "needs-live-artifacts");
        item.labels.push("done:builder");
        await runAutoAdvance(client, 1, 0);
        assert.equal(item.status, "In Code Review");
        item.labels.push("done:verifier");
        await runRealClaudeGate(client);
        await runRealClaudeGateExecution(client, async () => report(), 150, async () => {});
        assert.equal(item.status, "In Documentation");
        assert.ok(!item.labels.includes("needs-real-claude"));
      });
    });
  }
  test("artifact handoff cannot continue if its evidence comment fails", async () => {
    await withStageSet("builder", async () => {
      const item = builderParkedItem({ labels: ["done:verifier", "needs-real-claude", "needs-live-artifacts"] });
      const client = new MockClient([item]);
      client.addComment = async () => { throw new Error("GitHub unavailable"); };
      await runRealClaudeGateExecution(client, async () => report(), 150, async () => {});
      assert.equal(item.status, "Inbox");
      assert.deepEqual(client.addLabelCalls, [{ issueNumber: 77, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
      assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 77, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
    });
  });
});


test("artifact marker uses fresh labels and does not turn an unavailable gate into completion", async () => {
  await withStageSet("builder", async () => {
    const item = builderParkedItem();
    const client = new MockClient([item]);
    client.freshLabels.set(77, [...item.labels, "needs-live-artifacts"]);
    await runRealClaudeGateExecution(client, async () => report(), 150, async () => {});
    assert.equal(item.status, "In Development");
    assert.ok(item.labels.includes("needs-real-claude"));
    const unavailable = builderParkedItem({ labels: ["done:verifier", "needs-real-claude", "needs-live-artifacts"] });
    const second = new MockClient([unavailable]);
    await runRealClaudeGateExecution(second, async () => report({ runError: "login unavailable" }), 150, async () => {});
    assert.equal(unavailable.status, "Inbox");
    assert.ok(unavailable.labels.includes("error:real-claude-gate"));
    assert.ok(!unavailable.labels.includes("needs-rework:builder"));
    assert.deepEqual(second.removeLabelCalls, [{ issueNumber: 77, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
  });
});

test("failed artifact rework label write cannot move the ticket forward", async () => {
  await withStageSet("builder", async () => {
    const item = builderParkedItem({ labels: ["done:verifier", "needs-real-claude", "needs-live-artifacts"] });
    const client = new MockClient([item]);
    const addLabel = client.addLabel.bind(client);
    client.addLabel = async (issueNumber, label) => {
      if (label === "needs-rework:builder") throw new Error("GitHub unavailable");
      await addLabel(issueNumber, label);
    };
    await runRealClaudeGateExecution(client, async () => report(), 150, async () => {});
    assert.equal(item.status, "Inbox");
    assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 77, label: REAL_CLAUDE_GATE_RUNNING_LABEL }]);
  });
});

// =====================================================================
// Live gate merge conflict → code owner (2026-10-04)
// =====================================================================
//
// Mobile #1337 parked twice on 2026-10-01, 17 and 18 commits behind main,
// and #1631 on 2026-10-04, over a conflict as small as two changes each
// adding one argument to the same call. Each waited hours for a person to
// merge main. The final merge already sends that shape to the code owner
// (merge-handoff.ts); the gate now does the same, within the same budget.

describe("real-claude gate — a branch that conflicts with main goes to its code owner", () => {
  const conflicted = () => report({
    runError: "`feature/77` conflicts with `origin/main`, so there is no merged state to gate. Resolve the conflict and the gate will run on the next cycle.",
    exitCode: null,
    tally: null,
    branchName: "feature/77",
    commitsBehind: 18,
    mergeConflict: { paths: ["app/src/main/java/Thread.kt"] },
  });

  test("hands the merge to the builder without a rework, without the error label, and keeping needs-real-claude", async () => {
    await withStageSet("builder", async () => {
      const item = builderParkedItem({ labels: ["done:builder", "done:verifier", "needs-real-claude", "rework-count:2"] });
      const client = new MockClient([item]);
      const notifications: string[] = [];

      await runRealClaudeGateExecution(client, async () => conflicted(), 150, async (m) => { notifications.push(m); });

      assert.equal(item.status, "In Development", "straight to the owner's column; Inbox is not one the router scans");
      assert.ok(item.labels.includes("merge-handoff"));
      assert.ok(item.labels.includes("needs-rework:builder"));
      assert.ok(item.labels.includes("needs-real-claude"), "the gate must run again after the merge");
      assert.ok(!item.labels.includes("error:real-claude-gate"), "a conflict the owner can settle is not a park");
      assert.ok(!item.labels.includes(REAL_CLAUDE_GATE_RUNNING_LABEL));
      assert.equal(client.addCommentCalls.length, 1, "the handoff comment replaces the evidence comment");
      const comment = client.addCommentCalls[0]!.body;
      assert.ok(comment.startsWith("<!-- final-merge-handoff -->"), "counts toward the final merge's shared budget");
      assert.match(comment, /app\/src\/main\/java\/Thread\.kt/);
      assert.match(comment, /18 commit\(s\) behind/);
      assert.match(comment, /handoff 1 of 2/);
      assert.match(comment, /does not count as a rework/);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!, /sent back to builder to finish the merge \(handoff 1\/2\)/);

      // The router then clears the trail and counts nothing.
      await runReworkRouting(client);
      assert.equal(item.status, "In Development");
      assert.deepEqual(item.labels.sort(), ["needs-real-claude", "rework-count:2"]);
    });
  });

  test("classic set: the developer owns the merge", async () => {
    const item = parkedItem();
    const client = new MockClient([item]);

    await runRealClaudeGateExecution(client, async () => conflicted(), 150, async () => {});

    assert.equal(item.status, "In Development");
    assert.ok(item.labels.includes("needs-rework:developer"));
    assert.ok(item.labels.includes("merge-handoff"));
    assert.ok(!item.labels.includes("error:real-claude-gate"));
  });

  test("with the shared handoff budget spent it parks exactly as before, and says why", async () => {
    await withStageSet("builder", async () => {
      const item = builderParkedItem();
      const client = new MockClient([item]);
      client.priorMarkerComments.set(77, 2);
      const notifications: string[] = [];

      await runRealClaudeGateExecution(client, async () => conflicted(), 150, async (m) => { notifications.push(m); });

      assert.equal(item.status, "Inbox");
      assert.equal(client.updateItemStatusCalls.length, 0);
      assert.deepEqual(client.addLabelCalls, [
        { issueNumber: 77, label: REAL_CLAUDE_GATE_RUNNING_LABEL },
        { issueNumber: 77, label: "error:real-claude-gate" },
      ]);
      assert.ok(!item.labels.includes("merge-handoff"));
      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!, /could not judge #77/);
      const evidence = client.addCommentCalls[0]?.body ?? "";
      assert.match(evidence, /NO USABLE RESULT/);
      assert.match(evidence, /already gone back to builder 2 times/);
    });
  });

  test("parks as before when the earlier handoffs cannot be counted", async () => {
    await withStageSet("builder", async () => {
      const item = builderParkedItem();
      const client = new MockClient([item]);
      client.countMarkerCommentsError = new Error("Failed to fetch comments: Bad Gateway");

      await runRealClaudeGateExecution(client, async () => conflicted(), 150, async () => {});

      assert.equal(item.status, "Inbox");
      assert.ok(item.labels.includes("error:real-claude-gate"));
      assert.ok(!item.labels.includes("needs-rework:builder"));
      assert.match(client.addCommentCalls[0]?.body ?? "", /could not be counted/);
    });
  });

  test("parks rather than strand the ticket in Inbox when the move fails", async () => {
    // The labels are already on by then. Without the park, a ticket carrying
    // needs-rework in Inbox would be skipped by the gate and never routed.
    await withStageSet("builder", async () => {
      const item = builderParkedItem();
      const client = new MockClient([item]);
      client.updateItemStatus = async () => { throw new Error("GraphQL 502"); };

      await runRealClaudeGateExecution(client, async () => conflicted(), 150, async () => {});

      assert.equal(item.status, "Inbox");
      assert.ok(item.labels.includes("error:real-claude-gate"));
      assert.match(client.addCommentCalls.at(-1)?.body ?? "", /Sending it to builder to finish the merge failed: GraphQL 502/);
    });
  });

  test("a run error that is not a conflict still parks at once", async () => {
    await withStageSet("builder", async () => {
      const item = builderParkedItem();
      const client = new MockClient([item]);

      await runRealClaudeGateExecution(client, async () => report({ runError: "git fetch origin failed: offline", tally: null }), 150, async () => {});

      assert.equal(item.status, "Inbox");
      assert.ok(item.labels.includes("error:real-claude-gate"));
      assert.ok(!item.labels.includes("merge-handoff"));
    });
  });
});

describe("runReworkRouting: a builder parked on a blocker counts no rework (2026-10-07)", () => {
  test("desktop #1738: stays in In Development at rework-count:1, trigger stripped, no second comment", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({
        id: "item-1738",
        issueNumber: 1738,
        status: "In Development",
        labels: ["enhancement", "family-dispatches:8", "needs-rework:builder", "rework-count:1"],
        blockedBy: [{ number: 1796, state: "OPEN" }],
      });
      const client = new MockClient([item]);

      await runReworkRouting(client, { readPrVerdicts: async () => { throw new Error("verdicts are not read for a wait"); } });

      assert.deepEqual(client.updateItemStatusCalls, []);
      assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 1738, label: "needs-rework:builder" }]);
      assert.deepEqual(client.addLabelCalls, [], "no rework-count:2, no error:rework-loop");
      assert.deepEqual(client.addCommentCalls, [], "the builder's own 'Waiting on #1796' comment already says it");
      assert.deepEqual(item.labels, ["enhancement", "family-dispatches:8", "rework-count:1"]);
    });
  });

  test("desktop #1766: the first builder run's wait leaves it with no rework count at all", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({
        id: "item-1766",
        issueNumber: 1766,
        status: "In Development",
        labels: ["security-sensitive", "needs-real-claude", "done:refiner", "family-dispatches:2", "needs-rework:builder"],
        blockedBy: [{ number: 1785, state: "OPEN" }],
      });
      const client = new MockClient([item]);

      await runReworkRouting(client);

      assert.deepEqual(client.addLabelCalls, [], "no rework-count:1");
      assert.deepEqual(item.labels, ["security-sensitive", "needs-real-claude", "family-dispatches:2"]);
      assert.ok(!item.labels.some(l => l.startsWith("rework-count:")));
    });
  });

  test("a builder wait at the hard cap does not park", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({
        id: "item-1723",
        issueNumber: 1723,
        status: "In Development",
        labels: ["needs-rework:builder", "rework-count:6"],
        blockedBy: [{ number: 1766, state: "OPEN" }],
      });
      const client = new MockClient([item]);

      await runReworkRouting(client);

      assert.ok(!item.labels.includes("error:rework-loop"));
      assert.deepEqual(item.labels, ["rework-count:6"]);
    });
  });
});

describe("runReworkRouting: a stale base FAIL costs no builder round (merge race, 2026-10-07)", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/desktop-stale-base-verdicts.json", import.meta.url), "utf8")) as {
    tickets: Record<string, { comments: Array<{ createdAt: string; body: string }> }>;
  };
  const prJson = (ticket: number, upTo?: string) => JSON.stringify({
    reviews: [],
    comments: fixture.tickets[String(ticket)].comments.filter(c => upTo === undefined || c.createdAt <= upTo),
  });
  const merged: StaleBaseRefresh = { kind: "merged", mainSha: "e94bf2a5aadc057e21828e1ea4ccf7e0e0ff4fc4", headSha: "362f24a647561f7e6071b3a9904d6c3702205a8f" };

  /** #1825 at 00:22:27 UTC, the cycle that parked it with error:rework-loop. */
  function ticket1825(): ProjectItem {
    return makeItem({
      id: "item-1825",
      issueNumber: 1825,
      status: "In Code Review",
      labels: ["done:builder", "enhancement", "needs-rework:builder", "rework-count:1", "security-sensitive"],
    });
  }

  test("desktop #1825: main is merged by the dispatcher, the ticket stays for the verifier, uncounted and unparked", async () => {
    await withStageSet("builder", async () => {
      const item = ticket1825();
      const client = new MockClient([item]);
      const refreshed: number[] = [];

      await runReworkRouting(client, {
        readPrVerdicts: async () => prJson(1825),
        refreshStaleBase: async (n) => { refreshed.push(n); return merged; },
      });

      assert.deepEqual(refreshed, [1825]);
      assert.deepEqual(client.updateItemStatusCalls, [], "stays in In Code Review");
      assert.deepEqual(client.addLabelCalls, [], "no rework-count:2 and no error:rework-loop");
      assert.deepEqual(item.labels, ["done:builder", "enhancement", "rework-count:1", "security-sensitive"]);
      const comment = client.addCommentCalls.at(-1)?.body ?? "";
      assert.ok(comment.includes(STALE_BASE_REFRESH_MARKER));
      assert.match(comment, /Stale base settled by the dispatcher/);
      assert.match(comment, /e94bf2a5aadc/);
      assert.doesNotMatch(comment, /Rework loop detected/);
      assert.equal(client.clearItemsCacheCalls, 1);
    });
  });

  test("desktop #1825 on a dispatcher without the refresh: no false park, an ordinary counted rework", async () => {
    await withStageSet("builder", async () => {
      const item = ticket1825();
      const client = new MockClient([item]);

      await runReworkRouting(client, { readPrVerdicts: async () => prJson(1825) });

      assert.ok(!item.labels.includes("error:rework-loop"), "the branch finding is not a repeat");
      assert.equal(item.status, "In Development");
      assert.ok(item.labels.includes("rework-count:2"));
    });
  });

  test("desktop #1818 at rework-count:2: its stale base FAIL after a real one is settled too", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({
        id: "item-1818",
        issueNumber: 1818,
        status: "In Code Review",
        labels: ["done:builder", "enhancement", "needs-real-claude", "needs-rework:builder", "rework-count:2", "security-sensitive"],
      });
      const client = new MockClient([item]);

      await runReworkRouting(client, { readPrVerdicts: async () => prJson(1818), refreshStaleBase: async () => merged });

      assert.equal(item.status, "In Code Review");
      assert.ok(item.labels.includes("rework-count:2"), "still 2, not 3");
      assert.ok(!item.labels.includes("needs-rework:builder"));
    });
  });

  test("a branch that already contains main is settled without a merge", async () => {
    await withStageSet("builder", async () => {
      const item = ticket1825();
      const client = new MockClient([item]);
      await runReworkRouting(client, {
        readPrVerdicts: async () => prJson(1825),
        refreshStaleBase: async () => ({ kind: "current", mainSha: merged.mainSha, headSha: merged.headSha }),
      });
      assert.equal(item.status, "In Code Review");
      assert.match(client.addCommentCalls.at(-1)?.body ?? "", /already contains current `main`/);
      assert.deepEqual(client.addLabelCalls, []);
    });
  });

  test("main that conflicts goes to the builder as a merge handoff: moved, labels stripped, nothing counted", async () => {
    await withStageSet("builder", async () => {
      const item = ticket1825();
      const client = new MockClient([item]);
      await runReworkRouting(client, {
        readPrVerdicts: async () => prJson(1825),
        refreshStaleBase: async () => ({ kind: "conflict", paths: ["src/renderer/src/store/conversationListStore.ts"] }),
      });
      assert.equal(item.status, "In Development");
      assert.deepEqual(item.labels, ["enhancement", "rework-count:1", "security-sensitive"], "trigger and done:builder stripped, count untouched");
      assert.deepEqual(client.addLabelCalls, []);
      const comment = client.addCommentCalls.at(-1)?.body ?? "";
      assert.match(comment, /merge conflict sent to the code owner/);
      assert.ok(comment.includes("conversationListStore.ts"));
      assert.ok(comment.includes(STALE_BASE_REFRESH_MARKER), "a handoff counts toward the cap");
    });
  });

  test("a refresh that fails routes the FAIL as an ordinary rework", async () => {
    await withStageSet("builder", async () => {
      const item = ticket1825();
      const client = new MockClient([item]);
      await runReworkRouting(client, {
        readPrVerdicts: async () => prJson(1825),
        refreshStaleBase: async () => ({ kind: "failed", reason: "git fetch origin failed" }),
      });
      assert.equal(item.status, "In Development");
      assert.ok(item.labels.includes("rework-count:2"));
      assert.ok(!item.labels.includes("error:rework-loop"));
    });
  });

  test(`after ${STALE_BASE_REFRESH_MAX} settlements the next stale base FAIL is an ordinary rework`, async () => {
    await withStageSet("builder", async () => {
      const item = ticket1825();
      const client = new MockClient([item]);
      client.priorMarkerComments.set(1825, STALE_BASE_REFRESH_MAX);
      let refreshed = 0;
      await runReworkRouting(client, { readPrVerdicts: async () => prJson(1825), refreshStaleBase: async () => { refreshed++; return merged; } });
      assert.equal(refreshed, 0);
      assert.equal(item.status, "In Development");
      assert.ok(item.labels.includes("rework-count:2"));
    });
  });

  test("a stale base FAIL at the hard cap is settled, not parked", async () => {
    await withStageSet("builder", async () => {
      const item = ticket1825();
      item.labels = item.labels.map(l => (l === "rework-count:1" ? "rework-count:6" : l));
      const client = new MockClient([item]);
      await runReworkRouting(client, { readPrVerdicts: async () => prJson(1825), refreshStaleBase: async () => merged });
      assert.ok(!item.labels.includes("error:rework-loop"));
      assert.equal(item.status, "In Code Review");
    });
  });

  test("desktop #1731: a stale base beside a real defect still goes to the builder, counted", async () => {
    await withStageSet("builder", async () => {
      const item = makeItem({
        id: "item-1731",
        issueNumber: 1731,
        status: "In Code Review",
        labels: ["done:builder", "needs-rework:builder", "rework-count:2"],
      });
      const client = new MockClient([item]);
      let refreshed = 0;
      await runReworkRouting(client, { readPrVerdicts: async () => prJson(1731), refreshStaleBase: async () => { refreshed++; return merged; } });
      assert.equal(refreshed, 0);
      assert.equal(item.status, "In Development");
      assert.ok(item.labels.includes("rework-count:3"));
    });
  });
});
