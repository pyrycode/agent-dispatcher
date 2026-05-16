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

import { runAutoAdvance, runReworkRouting, type ReconcileClient } from "./reconcile.js";
import type { ProjectItem } from "./types.js";

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

  async addComment(): Promise<void> {
    /* no-op for tests */
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
  };
}

describe("runAutoAdvance — cache invalidation", () => {
  test("clears items cache when an advance is applied (the 2026-05-03 #127 bug)", async () => {
    // Reproduces the exact shape that misfired in production: a ticket
    // in In Development with `ready:developer` should auto-advance to
    // In Code Review AND signal cache invalidation so the per-agent
    // loop in the same cycle sees the new placement.
    const item = makeItem({
      id: "item-127",
      issueNumber: 127,
      status: "In Development",
      labels: ["ready:developer", "size:xs"],
    });
    const client = new MockClient([item]);

    await runAutoAdvance(client, 1);

    // Sanity: the advance happened.
    assert.equal(client.updateItemStatusCalls.length, 1, "expected one updateItemStatus call");
    assert.equal(client.updateItemStatusCalls[0]?.itemId, "item-127");
    assert.equal(client.updateItemStatusCalls[0]?.newStatus, "In Code Review");

    // The bug: cache wasn't invalidated. The fix: invalidate after any advance.
    assert.equal(
      client.clearItemsCacheCalls,
      1,
      "expected clearItemsCache to be called once after advancing #127 — without this, " +
        "the per-agent for-loop in the same cycle reads a stale snapshot and skips In Code Review",
    );
  });

  test("does NOT clear cache when no advance is applied", async () => {
    // Empty pipeline → nothing to advance → no cache churn.
    const client = new MockClient([]);

    await runAutoAdvance(client, 1);

    assert.equal(client.updateItemStatusCalls.length, 0);
    assert.equal(
      client.clearItemsCacheCalls,
      0,
      "no-op cycles must not pay an extra GraphQL fetch on the next read",
    );
  });

  test("clears cache for Backlog → In Architecture advance when nothing in flight", async () => {
    // The other path that mutates: Backlog ticket with `ready:po` and
    // an empty mid-pipeline. decideAutoAdvance moves it to In Architecture.
    const item = makeItem({
      id: "item-200",
      issueNumber: 200,
      status: "Backlog",
      labels: ["ready:po", "size:s"],
    });
    const client = new MockClient([item]);

    await runAutoAdvance(client, 1);

    assert.equal(client.updateItemStatusCalls.length, 1);
    assert.equal(client.updateItemStatusCalls[0]?.newStatus, "In Architecture");
    assert.equal(client.clearItemsCacheCalls, 1);
  });

  test("blocked mid-pipeline ticket does NOT hold a capacity seat (the #10 deadlock fix)", async () => {
    // The 2026-05-16 deadlock shape: #383 sits in "In Development"
    // blocked-by #409 (still open). #409 sits in Backlog with
    // `ready:po`, ready to advance into the pipeline. Pre-fix, #383
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
      labels: ["ready:po", "size:xs"],
    });
    const client = new MockClient([blocked, blockingBacklog]);

    await runAutoAdvance(client, 1);

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
      labels: ["ready:po", "size:s"],
    });
    const client = new MockClient([midActive, backlog]);

    await runAutoAdvance(client, 1);

    // #100 counts as in-flight (its blocker is closed → it's progressing).
    // Capacity = max(0, 1 - 1) = 0 → #101 stays in Backlog.
    assert.equal(
      client.updateItemStatusCalls.length, 0,
      "active mid-pipeline ticket (no OPEN blockers) consumes capacity — Backlog stays held",
    );
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

    // The route stripped the label and bumped rework-count.
    assert.ok(
      client.removeLabelCalls.some(c => c.issueNumber === 132 && c.label === "needs-rework:po"),
      "expected needs-rework:po to be stripped",
    );
    assert.ok(
      client.addLabelCalls.some(c => c.issueNumber === 132 && c.label === "rework-count:1"),
      "expected rework-count:1 to be added",
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
      labels: ["needs-rework:developer", "ready:architect", "size:m"],
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
});
