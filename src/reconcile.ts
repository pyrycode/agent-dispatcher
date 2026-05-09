// Cycle reconciliation: forward auto-advance and backward rework routing.
//
// Both functions share a structural invariant: they perform mutations
// (`updateItemStatus`, `removeLabel`, `addLabel`) that are NOT visible to
// the per-cycle items cache in `GitHubProjectClient`. To keep
// finish-first priority intact in the same cycle, each function calls
// `client.clearItemsCache()` after applying any state-changing mutation.
//
// Why not in-place patch the cache? It would couple cache correctness to
// every mutation site (addLabel, removeLabel, updateItemStatus). One
// extra GraphQL fetch per cycle that actually changed state is cheap and
// keeps the invalidation rule centralized.
//
// Why not just live with one-cycle lag? It silently inverts pollOrder.
// On 2026-05-03 09:33, dispatcher advanced #127 to In Code Review via
// `runAutoAdvance` mutation, then the per-agent for-loop in the SAME
// cycle queried "In Code Review" against the stale cache, found it
// empty, fell through to PO/Backlog and dispatched on #132 — burning a
// dispatch slot on a less-advanced ticket while the more-advanced one
// waited a full cycle. See `dispatch.test.ts` for the regression test.
//
// Lives in its own file so `reconcile.test.ts` can import without
// triggering `dispatch.ts`'s top-level env-var check (which calls
// `process.exit(1)` on missing config — fine for production, fatal for
// tests).

import type { GitHubProjectClient } from "./github.js";
import { AGENTS, type ProjectItem } from "./types.js";
import { AGENT_COLUMN_MAP } from "./dispatch-selection.js";
import {
  AUTO_ADVANCE_RULES,
  MANUAL_ADVANCE_GATES,
  MID_PIPELINE_COLUMNS,
  REWORK_LOOP_THRESHOLD,
  countPipelineInFlight,
  decideAutoAdvance,
  decideReworkRoutes,
  extractReworkCount,
} from "./pipeline-decisions.js";

/**
 * Subset of `GitHubProjectClient` that reconciliation actually uses.
 * Declaring it here makes the dependency surface explicit (and lets
 * tests pass a mock without `as any` casting).
 */
export interface ReconcileClient {
  getItemsByStatus(status: string): Promise<ProjectItem[]>;
  updateItemStatus(itemId: string, newStatus: string): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  addLabel(issueNumber: number, label: string): Promise<void>;
  addComment(issueNumber: number, body: string): Promise<void>;
  clearItemsCache(): void;
}

// Auto-advance moves tickets forward when an agent passes; rework labels
// route backward (see runReworkRouting). The rule data + helpers live in
// lib.ts so they can be unit-tested without spinning up the dispatcher.

export async function runAutoAdvance(client: ReconcileClient, maxConcurrent: number): Promise<void> {
  // Probe in-flight count: non-errored tickets in mid-pipeline columns.
  // The Backlog promotion budget is `max(0, maxConcurrent - inFlightCount)`,
  // so we need the count, not just a boolean.
  let inFlightCount = 0;
  try {
    const midItems = await Promise.all(
      MID_PIPELINE_COLUMNS.map(c => client.getItemsByStatus(c)),
    );
    inFlightCount = countPipelineInFlight(midItems.flat());
  } catch (error: any) {
    // Fail-open: a transient GraphQL error shouldn't deadlock the pipeline.
    // inFlightCount stays 0, so the cycle behaves as if the pipeline is
    // empty (matches the pre-fix fail-open behaviour).
    console.warn(`   ⚠️  In-flight probe failed; auto-advance proceeds without WIP gate: ${error.message}`);
  }

  // Fetch items for each unique `from` column referenced by the rule table.
  // Building once and passing into the pure decision keeps I/O bounded and
  // the decision deterministic.
  const fromColumns = [...new Set(AUTO_ADVANCE_RULES.map(r => r.from))];
  const itemsByColumn = new Map<string, ProjectItem[]>();
  try {
    const fetched = await Promise.all(fromColumns.map(c => client.getItemsByStatus(c)));
    fromColumns.forEach((c, i) => itemsByColumn.set(c, fetched[i]));
  } catch (error: any) {
    console.error(`Error fetching auto-advance candidate items: ${error.message}`);
    return;
  }

  // Pure decision — see decideAutoAdvance for semantics (gate skip,
  // capacity-bounded Backlog promotion, mid-pipeline advance-all).
  // Test surface lives in lib.test.ts.
  const decision = decideAutoAdvance(
    AUTO_ADVANCE_RULES,
    MANUAL_ADVANCE_GATES,
    itemsByColumn,
    inFlightCount,
    maxConcurrent,
  );

  // Apply advances. Track whether ANY mutation was attempted — the
  // cache-invalidation rule is "did we change board state?" not "did
  // every mutation succeed?". Even a partial failure may have changed
  // some items' columns; safer to over-invalidate than to under.
  let mutated = false;
  for (const adv of decision.advances) {
    try {
      await client.updateItemStatus(adv.itemId, adv.toColumn);
      mutated = true;
      console.log(`   📋 Auto-moved #${adv.issueNumber} from ${adv.fromColumn} → ${adv.toColumn}`);
    } catch (e) {
      console.warn(`   ⚠️  Failed to move #${adv.issueNumber} to ${adv.toColumn}: ${e}`);
    }
  }

  // Heartbeat logs for diagnostics. Visible in poll output so gates and
  // holds aren't silent.
  for (const gate of decision.gatedAwaiting) {
    const numbers = gate.itemNumbers.map(n => `#${n}`).join(", ");
    const target = AUTO_ADVANCE_RULES.find(r => r.from === gate.column)?.to ?? "?";
    console.log(`   🚦 ${gate.column}: ${numbers} awaiting human review (move to ${target} when ready)`);
  }
  if (decision.backlogHeld.length > 0) {
    const numbers = decision.backlogHeld.map(n => `#${n}`).join(", ");
    console.log(
      `   🛑 Backlog: ${numbers} held — pipeline at capacity (${inFlightCount}/${maxConcurrent} in flight)`,
    );
  }

  // Invalidate the per-cycle cache so subsequent sub-steps in the same
  // cycle (per-agent dispatch loop in particular) see the new column
  // placements. Only when something actually changed — common case
  // (zero advances) pays nothing.
  if (mutated) {
    client.clearItemsCache();
  }
}

// Backward routing: when an agent adds needs-rework:{target}, move the ticket
// to the target agent's column and strip the label so the target can pick it
// up. AGENT_COLUMN_MAP and extractReworkTarget live in lib.ts.

export async function runReworkRouting(client: ReconcileClient): Promise<void> {
  // Fetch items in every agent's column (one query per column, in parallel).
  const itemsByColumn = new Map<string, ProjectItem[]>();
  for (const agent of AGENTS) {
    try {
      const items = await client.getItemsByStatus(agent.column);
      itemsByColumn.set(agent.column, items);
    } catch (error: any) {
      console.error(`Error scanning ${agent.column} for rework routing: ${error.message}`);
    }
  }

  // Pure decision — see decideReworkRoutes for semantics (first valid
  // rework label wins, self-loops skipped, label stripping rules). Test
  // surface lives in lib.test.ts.
  const routes = decideReworkRoutes(AGENT_COLUMN_MAP, itemsByColumn);

  // Apply each route: check rework counter (halt at threshold), move
  // the item, strip stale labels, increment the counter. Track
  // mutations the same way runAutoAdvance does — invalidate the cache
  // at the end if any state-changing operation happened.
  let mutated = false;
  for (const route of routes) {
    // Find the source item to read its current rework count.
    const srcItems = itemsByColumn.get(route.fromColumn) ?? [];
    const srcItem = srcItems.find(it => it.id === route.itemId);
    const currentCount = srcItem ? extractReworkCount(srcItem.labels) : 0;

    // Circuit breaker: halt rework routing on tickets that have reached
    // the threshold. Adds error:rework-loop and a comment for human
    // attention. Catches the recursive-rework class of failure
    // (Pyrycode #41 hit 6 dev↔architect rounds before the dev agent
    // self-halted by intelligence — this makes the halt structural).
    if (currentCount >= REWORK_LOOP_THRESHOLD) {
      // The rework-loop comment + label only need to fire ONCE — once
      // `error:rework-loop` is on the ticket, the dispatcher's own
      // GLOBAL_BLOCK_LABELS gates further dispatch. But the trigger
      // label (`needs-rework:<target>`) stays attached, so each cycle
      // re-derives the same route and re-fires this branch. Without
      // dedupe, the cycle log shows the same warning every minute
      // forever (review #20).
      const alreadyHalted = (srcItem?.labels ?? []).includes("error:rework-loop");
      if (alreadyHalted) {
        // Quiet path: ticket is already halted, nothing more to do.
        continue;
      }
      try {
        await client.addLabel(route.issueNumber, "error:rework-loop");
        await client.addComment(
          route.issueNumber,
          `## 🛑 Rework loop detected\n\nThis ticket has been rework'd ${currentCount} times across the pipeline. ` +
          `Halting dispatch to prevent further token burn.\n\n` +
          `**Triggering label this round:** \`${route.triggerLabel}\`\n` +
          `**Routed from:** ${route.fromColumn} (would have moved to ${route.toColumn})\n\n` +
          `Manual intervention required. Inspect prior agent comments to find the root cause; ` +
          `clear \`error:rework-loop\` and \`rework-count:${currentCount}\` to resume dispatch.`,
        );
        mutated = true;
        console.log(`   🛑 Rework loop: #${route.issueNumber} hit threshold ${REWORK_LOOP_THRESHOLD} — halting dispatch (was: ${route.fromColumn} → ${route.toColumn})`);
      } catch (e) {
        console.warn(`   ⚠️  Failed to set rework-loop error on #${route.issueNumber}: ${e}`);
      }
      continue;
    }

    try {
      await client.updateItemStatus(route.itemId, route.toColumn);
      for (const label of route.labelsToStrip) {
        try { await client.removeLabel(route.issueNumber, label); } catch {}
      }
      // Bump the rework counter. Strip ALL existing rework-count:* labels
      // first — extractReworkCount reads the max, but a buggy mutation
      // chain could leave duplicates (rework-count:1 + rework-count:2).
      // Stripping only the max would leave stragglers. Idempotent strip
      // of every rework-count:* label keeps the state clean. (review #19)
      const srcLabels = srcItem?.labels ?? [];
      for (const label of srcLabels) {
        if (label.startsWith("rework-count:")) {
          try { await client.removeLabel(route.issueNumber, label); } catch {}
        }
      }
      try { await client.addLabel(route.issueNumber, `rework-count:${currentCount + 1}`); } catch {}
      mutated = true;
      const transition = route.fromColumn === route.toColumn
        ? `cleared at ${route.toColumn}`
        : `moved ${route.fromColumn} → ${route.toColumn}`;
      console.log(`   ↩️  Rework: #${route.issueNumber} ${transition} (${route.triggerLabel}, count ${currentCount + 1}/${REWORK_LOOP_THRESHOLD})`);
    } catch (e) {
      console.warn(`   ⚠️  Failed to route rework for #${route.issueNumber}: ${e}`);
    }
  }

  // Same rationale as runAutoAdvance: invalidate the cache so subsequent
  // sub-steps see the new column placement / stripped labels. Without
  // this, the per-agent loop in the same cycle would see the OLD labels
  // (`needs-rework:<agent>` still present in the cache) and skip
  // dispatch via `shouldSkipDispatch` — defeating the route's intent.
  if (mutated) {
    client.clearItemsCache();
  }
}
