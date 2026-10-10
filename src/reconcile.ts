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
import { type ProjectItem } from "./types.js";
import { activeStageSet } from "./stage-sets.js";
import {
  MANUAL_ADVANCE_GATES,
  REAL_CLAUDE_GATE_FAIL_COLUMN,
  REAL_CLAUDE_GATE_FROM_COLUMN,
  REAL_CLAUDE_GATE_LABEL,
  REAL_CLAUDE_GATE_RUNNING_LABEL,
  REAL_CLAUDE_GATE_RUN_FROM_COLUMN,
  REWORK_LOOP_THRESHOLD,
  decideAutoAdvance,
  decideBaselineAdjustedVerdict,
  decideGateOutcome,
  decideGateVerdict,
  decideRealClaudeGate,
  decideRealClaudeGateRun,
  decideReworkBreaker,
  decideReworkRoutes,
  decideUnroutableRework,
  extractReworkCount,
  extractReworkOtherCount,
  REWORK_OTHER_PREFIX,
  isRetryWaiting,
  REWORK_TARGET_ERROR_LABEL,
  type RealClaudeGateRunCandidate,
} from "./pipeline-decisions.js";
import {
  FINAL_MERGE_HANDOFF_MARKER,
  FINAL_MERGE_HANDOFF_MAX,
  MERGE_HANDOFF_LABEL,
  decideGateMergeRoute,
} from "./merge-handoff.js";
import { selectDispatches } from "./dispatch-selection.js";
import { findRepeatedMustFix, parseVerdictArtifacts } from "./verdict-guard.js";
import { formatGateEvidenceComment, gateRunFloor, type GateRunReport } from "./gate-output.js";
import type { FlakyRunContext, FlakyTicketResult } from "./flaky-tickets.js";
import type { InheritedTicketResult } from "./inherited-tickets.js";

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
  /**
   * Authoritative label list for one issue, straight from the REST API.
   *
   * The board snapshot is NOT authoritative here: its GraphQL query asks
   * for `labels(first: 10)` (github.ts), and a ticket that has walked the
   * whole pipeline plausibly carries nine or ten already — `done:po`,
   * `done:architect`, `done:developer`, `done:qa`, `done:code-review`, a
   * size, a priority, a type, `needs-real-claude`. One more and the
   * truncation starts eating exactly the labels the gate decides on.
   * Cheap REST call, read once per gate run, only where correctness turns
   * on it.
   */
  getIssueLabels(issueNumber: number): Promise<string[]>;
  getOpenBlockers(issueNumber: number): Promise<number[]>;
  /** How many of the issue's comments contain `marker`. The live gate reads
   *  the merge-handoff budget it shares with the final merge through it. */
  countMarkerComments(issueNumber: number, marker: string): Promise<number>;
  clearItemsCache(): void;
}

// Auto-advance moves tickets forward when an agent passes; rework labels
// route backward (see runReworkRouting). The rule data + helpers live in
// lib.ts so they can be unit-tested without spinning up the dispatcher.

export async function runAutoAdvance(
  client: ReconcileClient,
  maxConcurrent: number,
  runsInFlight: number,
): Promise<void> {
  // Rules + WIP-probe columns come from the stage set resolved at startup.
  // The builder set skips In Architecture and In QA entirely.
  const { advanceRules, midPipelineColumns, agents } = activeStageSet();

  // Read waiting work so ready Backlog tickets compete for free seats by
  // priority. A running agent always keeps its seat.
  let midByColumn: Map<string, ProjectItem[]> | undefined;
  try {
    const midItems = await Promise.all(
      midPipelineColumns.map(c => client.getItemsByStatus(c)),
    );
    midByColumn = new Map(
      midPipelineColumns.map((c, i) => [c, midItems[i].filter(it => !isRetryWaiting(it.labels))] as const),
    );
  } catch (error: any) {
    // Fail-open: a transient read error should not deadlock promotion.
    console.warn(`   ⚠️  Seat probe failed; Backlog promotion counts running agents only: ${error.message}`);
  }

  // Fetch items for each unique `from` column referenced by the rule table.
  // Building once and passing into the pure decision keeps I/O bounded and
  // the decision deterministic.
  const fromColumns = [...new Set(advanceRules.map(r => r.from))];
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
    advanceRules,
    MANUAL_ADVANCE_GATES,
    itemsByColumn,
    runsInFlight,
    maxConcurrent,
  );

  let waitingForSeat = 0;
  if (midByColumn) {
    // Put prospective promotions after existing work in their target column.
    // Selection applies priority first; equal priorities favour work already
    // past Backlog. The original board arrays stay untouched.
    const prospective = new Map(midByColumn);
    const promotions = decision.advances.filter(a => a.fromColumn === "Backlog");
    const promotionIds = new Set(promotions.map(a => a.itemId));
    for (const promotion of promotions) {
      const item = itemsByColumn.get("Backlog")!.find(i => i.id === promotion.itemId)!;
      prospective.set(promotion.toColumn, [
        ...(prospective.get(promotion.toColumn) ?? []),
        { ...item, status: promotion.toColumn },
      ]);
    }
    const selected = selectDispatches({
      itemsByColumn: prospective,
      pollOrder: [...agents].reverse(),
      maxConcurrent: Math.max(0, maxConcurrent - runsInFlight),
    });
    const selectedIds = new Set(selected.map(c => c.item.id));
    waitingForSeat = selected.filter(c => !promotionIds.has(c.item.id)).length;
    decision.advances = decision.advances.filter(a => {
      if (a.fromColumn !== "Backlog" || selectedIds.has(a.itemId)) return true;
      decision.backlogHeld.push(a.issueNumber);
      return false;
    });
  }

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
    const target = advanceRules.find(r => r.from === gate.column)?.to ?? "?";
    console.log(`   🚦 ${gate.column}: ${numbers} awaiting human review (move to ${target} when ready)`);
  }
  if (decision.backlogHeld.length > 0) {
    const numbers = decision.backlogHeld.map(n => `#${n}`).join(", ");
    console.log(
      `   🛑 Backlog: ${numbers} held — waiting for a dispatch seat (${runsInFlight} running + ${waitingForSeat} waiting past Backlog, cap ${maxConcurrent})`,
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
// up. The name→column map comes from the stage set; extractReworkTarget
// lives in pipeline-decisions.ts.

/** What `runReworkRouting` needs from the dispatcher beyond the board. */
export interface ReworkRoutingOptions {
  /** Builder rework hard cap, `PYRY_BUILDER_REWORK_CAP` resolved by the
   *  caller. Defaults to REWORK_LOOP_THRESHOLD. */
  hardCap?: number;
  /** `gh pr view <n> --json reviews,comments` for the ticket's open pull
   *  request, null when it has none. Throws when it cannot be read. Absent,
   *  the repeat rule never fires and the count rule alone applies. */
  readPrVerdicts?: (issueNumber: number) => Promise<string | null>;
}

export async function runReworkRouting(
  client: ReconcileClient,
  options: ReworkRoutingOptions = {},
): Promise<void> {
  // Agents + the name→column routing map come from the resolved stage set
  // (classic: identical to the old AGENTS / AGENT_COLUMN_MAP pair).
  const { agents, columnByAgent, realClaudeGate } = activeStageSet();
  const hardCap = options.hardCap ?? REWORK_LOOP_THRESHOLD;
  // Only the code owner's rework counts toward the breaker: the agent
  // owning In Development, whose rework label the live gate also applies.
  const countedLabel = realClaudeGate.failReworkLabel;
  // Columns of the agents that rule by verdict (the builder set's
  // verifier). Only a route out of one of them reads the verdicts.
  const verdictColumns = new Set(agents.filter(a => a.requiresVerdict).map(a => a.column));

  // Fetch items in every agent's column (one query per column, in parallel).
  const itemsByColumn = new Map<string, ProjectItem[]>();
  for (const agent of agents) {
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
  const routes = decideReworkRoutes(columnByAgent, itemsByColumn);

  // Apply each route: check the rework breaker, move the item, strip
  // stale labels, increment the route's counter. Track
  // mutations the same way runAutoAdvance does — invalidate the cache
  // at the end if any state-changing operation happened.
  let mutated = false;
  for (const route of routes) {
    // A wait on open blockers: drop the trigger, leave the column and the
    // counter alone, and skip the loop breaker since nothing was reworked.
    // A failed strip posts nothing; the label is still there next pass.
    if (route.waitingOn?.length) {
      const blockers = route.waitingOn.map(n => `#${n}`).join(", ");
      try {
        await client.removeLabel(route.issueNumber, route.triggerLabel);
      } catch (e) {
        console.warn(`   ⚠️  Failed to strip ${route.triggerLabel} from #${route.issueNumber}: ${e}`);
        continue;
      }
      mutated = true;
      try {
        await client.addComment(
          route.issueNumber,
          `## ⏸️ Waiting on ${blockers}\n\n` +
          `\`${route.triggerLabel}\` arrived with an open blocker, so this is a wait, not a rework. ` +
          `The ticket stays in ${route.fromColumn} and is picked up again once ${blockers} ` +
          `${route.waitingOn.length > 1 ? "close" : "closes"}. No refinement run, and the rework count is unchanged.`,
        );
      } catch (e) {
        console.warn(`   ⚠️  Failed to post wait comment on #${route.issueNumber}: ${e}`);
      }
      console.log(`   ⏸️  Wait: #${route.issueNumber} stays in ${route.fromColumn} until ${blockers} closes (${route.triggerLabel} dropped, no rework counted)`);
      continue;
    }

    // Find the source item to read its current rework counters.
    const srcItems = itemsByColumn.get(route.fromColumn) ?? [];
    const srcItem = srcItems.find(it => it.id === route.itemId);
    const srcLabels = srcItem?.labels ?? [];
    const currentCount = extractReworkCount(srcLabels);
    const counted = !route.mergeHandoff && route.triggerLabel === countedLabel;

    // Circuit breaker on the code owner's reworks (see REWORK_LOOP_THRESHOLD
    // and decideReworkBreaker): a verifier finding repeated across the last
    // two FAIL verdicts parks at once, otherwise the route that would pass
    // the hard cap parks. Adds error:rework-loop and a comment for human
    // attention. Catches the recursive-rework class of failure (Pyrycode
    // #41 hit 6 dev↔architect rounds before the dev agent self-halted by
    // intelligence — this makes the halt structural).
    //
    // The rework-loop comment + label only need to fire ONCE — once
    // `error:rework-loop` is on the ticket, the dispatcher's own
    // GLOBAL_BLOCK_LABELS gates further dispatch. But the trigger label
    // (`needs-rework:<target>`) stays attached, so each cycle re-derives
    // the same route. Without this quiet path the cycle log shows the same
    // warning every minute forever (review #20), and the verdicts would be
    // re-read every cycle too.
    if (counted && srcLabels.includes("error:rework-loop")) continue;
    let repeatedKeys: string[] = [];
    if (counted && verdictColumns.has(route.fromColumn) && options.readPrVerdicts) {
      // An unreadable or unparseable verdict is never a repeat: the count
      // rule decides alone.
      try {
        const json = await options.readPrVerdicts(route.issueNumber);
        if (json !== null) repeatedKeys = findRepeatedMustFix(parseVerdictArtifacts(json));
      } catch (e: any) {
        console.warn(`   ⚠️  Could not read verdicts for #${route.issueNumber}; rework breaker uses the count alone: ${e?.message ?? e}`);
      }
    }
    const breaker = decideReworkBreaker({ counted, reworkCount: currentCount, hardCap, repeatedKeys });
    if (breaker.park) {
      const why = breaker.rule === "repeat"
        ? `**Rule that fired:** repeated finding. The newest FAIL verdict on the pull request raises a \`[MUST FIX]\` ` +
          `finding the FAIL verdict before it already raised, after a builder round that was meant to fix it:\n\n` +
          breaker.keys.map(k => `- \`${k}\``).join("\n") + `\n\n` +
          `Another round is unlikely to fix it on its own. The count did not matter: this ticket has ` +
          `${currentCount} builder rework${currentCount === 1 ? "" : "s"}, and the hard cap is ${hardCap}.\n\n`
        : `**Rule that fired:** hard cap. This ticket has already been sent back with \`${route.triggerLabel}\` ` +
          `${currentCount} times, the cap is ${hardCap} (\`PYRY_BUILDER_REWORK_CAP\`), and no repeated verifier finding was found.\n\n`;
      const resume = breaker.rule === "repeat"
        ? `Clearing \`error:rework-loop\` alone parks it again, because the same two verdicts are still the newest. ` +
          `Resolve the finding, or move the ticket to ${route.toColumn} by hand and remove both \`${route.triggerLabel}\` and \`error:rework-loop\`.`
        : `Clear \`error:rework-loop\` and \`rework-count:${currentCount}\` to resume dispatch.`;
      try {
        await client.addLabel(route.issueNumber, "error:rework-loop");
        await client.addComment(
          route.issueNumber,
          `## 🛑 Rework loop detected\n\n` +
          why +
          `Halting dispatch to prevent further token burn.\n\n` +
          `**Triggering label this round:** \`${route.triggerLabel}\`\n` +
          `**Routed from:** ${route.fromColumn} (would have moved to ${route.toColumn})\n\n` +
          `Manual intervention required. Inspect prior agent comments to find the root cause. ${resume}`,
        );
        mutated = true;
        const fired = breaker.rule === "repeat" ? `repeated finding ${breaker.keys.join(", ")}` : `hard cap ${hardCap}`;
        console.log(`   🛑 Rework loop: #${route.issueNumber} ${fired} — halting dispatch (was: ${route.fromColumn} → ${route.toColumn})`);
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
      // Bump the route's counter: rework-count for the code owner's rework,
      // rework-other for any other. Strip ALL existing labels of that
      // counter first — the extract helpers read the max, but a buggy
      // mutation chain could leave duplicates (rework-count:1 +
      // rework-count:2). Stripping only the max would leave stragglers.
      // Idempotent strip of every label of the counter keeps the state
      // clean. (review #19)
      mutated = true;
      const transition = route.fromColumn === route.toColumn
        ? `cleared at ${route.toColumn}`
        : `moved ${route.fromColumn} → ${route.toColumn}`;
      // A merge handoff is not a rework (see decideReworkRoutes): the
      // counters stay where they are.
      if (route.mergeHandoff) {
        console.log(`   🔀 Merge handoff: #${route.issueNumber} ${transition} (${route.triggerLabel}, no rework counted)`);
        continue;
      }
      const prefix = counted ? "rework-count:" : REWORK_OTHER_PREFIX;
      const next = (counted ? currentCount : extractReworkOtherCount(srcLabels)) + 1;
      for (const label of srcLabels) {
        if (label.startsWith(prefix)) {
          try { await client.removeLabel(route.issueNumber, label); } catch {}
        }
      }
      try { await client.addLabel(route.issueNumber, `${prefix}${next}`); } catch {}
      const tally = counted ? `builder rework ${next}/${hardCap}` : `${prefix}${next}, not counted toward the breaker`;
      console.log(`   ↩️  Rework: #${route.issueNumber} ${transition} (${route.triggerLabel}, ${tally})`);
    } catch (e) {
      console.warn(`   ⚠️  Failed to route rework for #${route.issueNumber}: ${e}`);
    }
  }

  // Rework labels naming an agent this stage set does not run. The loop
  // above passed over them, and without this the agent that APPLIED the
  // label is simply re-dispatched next cycle (see decideUnroutableRework).
  // Park once, with a comment naming the label and the agents that exist;
  // the `error:` prefix keeps every agent off the ticket until a human acts.
  for (const stuck of decideUnroutableRework(columnByAgent, itemsByColumn)) {
    const item = (itemsByColumn.get(stuck.fromColumn) ?? []).find(it => it.id === stuck.itemId);
    if ((item?.labels ?? []).includes(REWORK_TARGET_ERROR_LABEL)) continue; // already parked
    const agents = [...columnByAgent.keys()].map(a => `\`${a}\``).join(", ");
    try {
      await client.addLabel(stuck.issueNumber, REWORK_TARGET_ERROR_LABEL);
      await client.addComment(
        stuck.issueNumber,
        `## 🛑 Rework label routes nowhere\n\n` +
        `${stuck.labels.map(l => `\`${l}\``).join(", ")} names an agent this board's stage set does not run. ` +
        `The agents here are ${agents}.\n\n` +
        `Dispatch is paused on this ticket. Swap the label for one of those agents, or clear it and route the ` +
        `ticket by hand, then remove \`${REWORK_TARGET_ERROR_LABEL}\` to resume.`,
      );
      mutated = true;
      console.log(
        `   🛑 Unroutable rework: #${stuck.issueNumber} carries ${stuck.labels.join(", ")} in ${stuck.fromColumn} — parked`,
      );
    } catch (e) {
      console.warn(`   ⚠️  Failed to park unroutable rework on #${stuck.issueNumber}: ${e}`);
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

// Real-claude gate, part one: park. A ticket whose acceptance needs a live run
// against real claude is pulled out of In Code Review into Inbox, where part
// two (`runRealClaudeGateExecution`, below) runs the suite for it on the same
// cycle. With no gate command configured the ticket simply waits there for an
// operator, which is the pre-2026-08-07 behaviour unchanged.
//
// See decideRealClaudeGate and REAL_CLAUDE_GATE_LABEL in pipeline-decisions.ts.
// This MUST run before runAutoAdvance so the ticket is pulled out of In Code
// Review before the forward-advance rule would move it to In Documentation
// (belt-and-suspenders: decideAutoAdvance also refuses to advance a gated
// ticket, so a skipped or removed gate step still cannot un-gate one).

export async function runRealClaudeGate(client: ReconcileClient): Promise<void> {
  // The gate's trigger + rework labels come from the resolved stage set:
  // classic keys on done:code-review / needs-rework:developer (identical
  // to the pre-stage-set literals), builder on done:verifier /
  // needs-rework:builder — so the pilot fork's needs-real-claude tickets
  // keep their e2e proof instead of silently losing the gate.
  const { realClaudeGate } = activeStageSet();

  const itemsByColumn = new Map<string, ProjectItem[]>();
  try {
    const items = await client.getItemsByStatus(REAL_CLAUDE_GATE_FROM_COLUMN);
    itemsByColumn.set(REAL_CLAUDE_GATE_FROM_COLUMN, items);
  } catch (error: any) {
    console.error(`Error scanning ${REAL_CLAUDE_GATE_FROM_COLUMN} for real-claude gate: ${error.message}`);
    return;
  }

  const routes = decideRealClaudeGate(itemsByColumn, realClaudeGate.reviewDoneLabel);

  let mutated = false;
  for (const route of routes) {
    try {
      await client.updateItemStatus(route.itemId, route.toColumn);
      await client.addComment(
        route.issueNumber,
        `## 🧪 Real-claude gate — parked for the live run\n\n` +
        `This ticket carries \`${REAL_CLAUDE_GATE_LABEL}\`: its acceptance needs a live run against real ` +
        `claude, which the rest of the pipeline's fakes cannot stand in for. Code review passed everything ` +
        `machine-checkable, so it is moved to **${route.toColumn}**, out of the pipeline, until that run happens.\n\n` +
        `**Why it does not just advance.** A real-claude suite with no credential SKIPS every test and still ` +
        `exits 0. On 2026-07-22 that 0 was read as a pass and an unverified change shipped ` +
        `(pyrycode PR #1169 / #1168). Only a count of tests that actually executed can tell a pass from a ` +
        `skip, so nothing advances until something has counted.\n\n` +
        `**What happens next.** If this fork sets \`PYRY_REAL_CLAUDE_GATE_CMD\`, the dispatcher runs the suite ` +
        `itself on its next cycle and posts an evidence comment with the executed-test count. Otherwise an ` +
        `operator runs it by hand:\n\n` +
        `1. Run the fork's real-claude suite with per-test JSON output, on a machine with a Claude login.\n` +
        `2. **Pass** → remove \`${REAL_CLAUDE_GATE_LABEL}\` and move the ticket to **In Documentation**.\n` +
        `3. **Fail** → add \`${realClaudeGate.failReworkLabel}\` and move it to **In Development**, keeping ` +
        `\`${REAL_CLAUDE_GATE_LABEL}\` on so it re-gates after the fix.\n\n` +
        `Read the skip reasons, not the exit code. Do not move it back to In Code Review with the label ` +
        `still on — it will just re-park here.`,
      );
      mutated = true;
      console.log(`   🧪 Real-claude gate: parked #${route.issueNumber} in ${route.toColumn} for operator (${REAL_CLAUDE_GATE_LABEL})`);
    } catch (e) {
      console.warn(`   ⚠️  Failed to park #${route.issueNumber} for real-claude gate: ${e}`);
    }
  }

  if (mutated) {
    client.clearItemsCache();
  }
}

// Real-claude gate, part two: execute.
//
// Runs the fork's live-claude suite against one parked ticket, reads the
// result, and moves the ticket accordingly. This is what makes a chain of
// gated tickets drain unattended — on board #1, four tickets deep, where
// each pass only revealed the next gate and each one cost a human
// interruption.
//
// The process work (git, worktree, spawn) lives in dispatch.ts behind the
// `runner` seam; the verdict logic is pure in pipeline-decisions.ts. This
// function owns only the board I/O between them.

/**
 * Runs the gate for one ticket and reports what happened. Supplied by
 * dispatch.ts; null when `PYRY_REAL_CLAUDE_GATE_CMD` is unset, which is
 * the feature's off switch.
 */
export type RealClaudeGateRunner = (opts: { issueNumber: number }) => Promise<GateRunReport>;

/**
 * Hands a started run to the caller instead of awaiting it. The caller keeps
 * the poll loop going while `work` runs and must not start another gate run
 * until it settles. `work` never rejects.
 */
export type RealClaudeGateBackground = (issueNumber: number, work: () => Promise<void>) => void;

/**
 * Returns true when a confirmed candidate is held because conflicting runs
 * are in flight, or when its run was handed to `background`.
 *
 * Without `background` the run is awaited here and `inFlight` counts every
 * agent run: the caller dispatches nothing new while held, so the pool
 * empties and the gate runs alone. With `background` the caller counts only
 * the runs that share the emulator with the gate's suite and holds those
 * back while the run is going; every other agent keeps working beside it.
 */
export async function runRealClaudeGateExecution(
  client: ReconcileClient,
  runner: RealClaudeGateRunner | null,
  minExecuted: number,
  notifyDiscord: (message: string) => Promise<void>,
  inFlight = 0,
  recordFlaky: (flaky: readonly string[], ctx: FlakyRunContext) => Promise<FlakyTicketResult> = noFlakyTickets,
  background?: RealClaudeGateBackground,
  recordInherited: (failures: readonly string[], ctx: FlakyRunContext) => Promise<InheritedTicketResult> = noInheritedTickets,
): Promise<boolean> {
  // Off switch. No command configured means this step never touches the
  // board, so the whole feature can land on a live dispatcher before any
  // fork opts in.
  if (runner === null) return false;

  // Same stage-set keys as the park step above.
  const { realClaudeGate } = activeStageSet();

  let parked: ProjectItem[];
  try {
    parked = await client.getItemsByStatus(REAL_CLAUDE_GATE_RUN_FROM_COLUMN);
  } catch (error: any) {
    console.error(`Error scanning ${REAL_CLAUDE_GATE_RUN_FROM_COLUMN} for real-claude gate runs: ${error.message}`);
    return false;
  }

  const candidate = decideRealClaudeGateRun(parked, realClaudeGate.reviewDoneLabel);
  if (candidate === null) return false;

  // Re-read labels from the REST API before committing minutes of wall
  // clock to a run. The board snapshot truncates at ten labels and a
  // ticket this far down the pipeline is plausibly at nine, so the
  // snapshot can be missing the very label that disqualifies it — a
  // freshly-added `error:*` or `needs-rework:*`, or a `needs-real-claude`
  // an operator just cleared by hand.
  let freshLabels: string[];
  let freshBlockers: number[];
  try {
    freshLabels = await client.getIssueLabels(candidate.issueNumber);
    freshBlockers = await client.getOpenBlockers(candidate.issueNumber);
  } catch (error: any) {
    // No fresh read, no run. Gating on a possibly-truncated label set is
    // how a ticket gets gated after someone already parked it.
    console.warn(
      `   ⚠️  Real-claude gate: could not re-read labels or blockers for #${candidate.issueNumber}, skipping this cycle: ${error.message}`,
    );
    return false;
  }

  const confirmed = decideRealClaudeGateRun([
    {
      id: candidate.itemId,
      issueNumber: candidate.issueNumber,
      labels: freshLabels,
      blockedBy: freshBlockers.map(number => ({ number, state: "OPEN" as const })),
    },
  ], realClaudeGate.reviewDoneLabel);
  if (confirmed === null) {
    console.log(
      `   🧪 Real-claude gate: #${candidate.issueNumber} no longer eligible on a fresh label read — skipping`,
    );
    return false;
  }

  // Never beside a conflicting run. A builder running device tests on the
  // same managed device stretched a mobile gate from 2m50s to 28 minutes on
  // 2026-09-24. Its pairing codes expired mid-run, 23 of 24 methods failed,
  // and the failure was blamed on the branch (mobile #993). Pairing codes are
  // now minted after the build and mobile's test script holds the device
  // host-wide, so a background caller counts only verifiers and the main
  // sweep, whose long device runs would time out queued behind the suite.
  if (inFlight > 0) {
    console.log(
      background
        ? `   🧪 Real-claude gate: #${candidate.issueNumber} waits for ${inFlight} run(s) that share the emulator`
        : `   🧪 Real-claude gate: #${candidate.issueNumber} waits for ${inFlight} in-flight run(s); holding new dispatches`,
    );
    return true;
  }

  console.log(
    background
      ? `   🧪 Real-claude gate: running the live suite for #${candidate.issueNumber} in the background…`
      : `   🧪 Real-claude gate: running the live suite for #${candidate.issueNumber} (this blocks the cycle)…`,
  );

  try {
    await client.addLabel(candidate.issueNumber, REAL_CLAUDE_GATE_RUNNING_LABEL);
  } catch (error) {
    console.warn(`   ⚠️  Real-claude gate: could not mark #${candidate.issueNumber} as running, skipping this cycle: ${error}`);
    return false;
  }

  const work = async (): Promise<void> => {
    try {
      let report: GateRunReport;
      try {
        report = await runner({ issueNumber: candidate.issueNumber });
      } catch (error: any) {
        // A runner that throws must still park the ticket. Letting the
        // exception escape would leave the card sitting in Inbox with no
        // error label, so the next cycle would pick it up and throw again —
        // an invisible loop that burns a full suite's wall clock each time.
        report = {
          runError: `gate runner threw: ${error?.message ?? error}`,
          timedOut: false,
          exitCode: null,
          tally: null,
          command: "(runner threw before reporting the command)",
          branchName: `feature/${candidate.issueNumber}`,
          baseRef: "unknown",
          baseSha: "",
          headSha: "",
          commitsBehind: null,
          durationMs: 0,
          outputPath: "(none)",
          outputBytes: 0,
          baselineFailures: null,
          baselineSkipReason: "the runner threw before any comparison could run",
          baselineOutputPath: null,
          rerunFailures: null,
          rerunSkipReason: "the runner threw before any re-run could happen",
          rerunOutputPath: null,
        };
      }

      // A conflict with the base is neither the branch's test failure nor an
      // environment problem: the code owner can settle it. Hand it over the
      // way the final merge does (merge-handoff.ts), without a rework and
      // without the error label. When the shared budget is spent, or the
      // route cannot be written, fall through and park exactly as before.
      let conflictParkNote = "";
      if (report.mergeConflict) {
        const handoff = await handOffGateConflict(client, candidate, report, notifyDiscord);
        if (handoff.kind === "routed") return;
        conflictParkNote = handoff.reason;
      }

      const raw = decideGateVerdict({
        runError: report.runError,
        timedOut: report.timedOut,
        tally: report.tally,
        exitCode: report.exitCode,
        minExecuted: gateRunFloor(report, minExecuted),
      });
      // Re-judge a failure against what the base commit already fails, so a
      // branch is not blamed for breakage it inherited. No-op for every other
      // verdict, and a no-op when no baseline ran.
      let { verdict, reason, introduced, preExisting, flaky } = decideBaselineAdjustedVerdict({
        verdict: raw.verdict,
        reason: raw.reason,
        branchFailures: report.tally?.failedNames ?? [],
        baselineFailures: report.baselineFailures,
        rerunFailures: report.rerunFailures,
      });
      if (conflictParkNote !== "") reason = `${reason} ${conflictParkNote.replace(/\.$/, "")}`;
      let inheritedTickets: InheritedTicketResult = { blockers: [], untracked: [] };
      if (preExisting.length > 0) {
        try {
          inheritedTickets = await recordInherited(preExisting, {
            gatedIssue: candidate.issueNumber, report, at: new Date().toISOString(),
          });
        } catch (error) {
          console.warn(`   ⚠️ Shared live failure filing failed: ${error}`);
          inheritedTickets.untracked = [...preExisting];
        }
      }
      if ((inheritedTickets.owned?.length ?? 0) > 0) {
        verdict = "fail";
        reason += `; this ticket already owns the fix for ${inheritedTickets.owned!.join(", ")}, so its builder must repair them`;
      }
      const inheritedWait = verdict === "inherited-failure" && inheritedTickets.untracked.length === 0
        && preExisting.every(name => inheritedTickets.blockers.some(b => b.name === name));
      const blockerNote = inheritedTickets.blockers.length > 0
        ? ` Shared failures tracked on ${[...new Set(inheritedTickets.blockers.map(b => `#${b.issue}`))].join(", ")}.`
        : "";
      const artifactsPending = freshLabels.includes("needs-live-artifacts")
        && (verdict === "pass" || verdict === "flaky-pass");
      const outcome = artifactsPending
        ? { toColumn: "In Development", addLabels: [realClaudeGate.failReworkLabel], removeLabels: [], notify: verdict === "flaky-pass" }
        : decideGateOutcome(verdict === "inherited-failure" && !inheritedWait ? "unusable" : verdict, realClaudeGate.failReworkLabel);

      const action = artifactsPending
        ? `returned it to **In Development** with \`${realClaudeGate.failReworkLabel}\`. ` +
          `Commit the exact usable live artifacts from this run's durable records and all matching reader/schema changes. ` +
          `Use the output path below to find the records; do not invent evidence. ` +
          `Then remove \`needs-live-artifacts\` after committing and pushing, and complete the implementation role. ` +
          `The pending marker and \`needs-real-claude\` remain until that work is done; review and the live gate must run again. ` +
          `This is an evidence handoff, not final acceptance.`
        : verdict === "inherited-failure"
        ? inheritedWait
          ? `left it in **${REAL_CLAUDE_GATE_RUN_FROM_COLUMN}** waiting on the separate fix-ticket blockers.${blockerNote} ` +
            `No rework requested and no retry consumed. The live gate runs again against current main after the blockers close.`
          : `could not confirm every shared-failure blocker. Left it in **${REAL_CLAUDE_GATE_RUN_FROM_COLUMN}** ` +
            `with \`error:real-claude-gate\` for recovery.${blockerNote} No rework requested.`
        : outcome.toColumn === null
        ? `left it in ${REAL_CLAUDE_GATE_RUN_FROM_COLUMN} and added \`${outcome.addLabels.join("`, `")}\`. ` +
          `This needs a human: the gate could not produce a trustworthy answer, and no agent can fix that by ` +
          `rewriting code.`
        : `moved it to **${outcome.toColumn}**` +
          (outcome.addLabels.length > 0 ? `, added \`${outcome.addLabels.join("`, `")}\`` : "") +
          (outcome.removeLabels.length > 0 ? `, removed \`${outcome.removeLabels.join("`, `")}\`` : "") +
          (verdict === "fail"
            ? `. \`${REAL_CLAUDE_GATE_LABEL}\` stays on, so this ticket must pass the gate again after the fix.`
            : verdict === "flaky-pass"
              ? `. The suite is green on re-run and the ticket did nothing wrong. The flaky test(s) named above ` +
                `are the suite's problem, not this branch's, and a human has been pinged about them.`
              : ".");

      // Comment first, mutate second. If a label write fails, the evidence
      // is already on the ticket and an operator can finish by hand; the
      // reverse order can move a card with no record of why.
      //
      // Then column BEFORE labels, which matters on a pass. If the move
      // fails after `needs-real-claude` was already stripped, the ticket sits
      // in Inbox with nothing marking it as gated: it would never re-gate and
      // never advance, stuck silently. This order fails the other way — the
      // label survives, the ticket re-gates next cycle, and the worst cost is
      // one repeated suite run.
      try {
        await client.addComment(
          candidate.issueNumber,
          formatGateEvidenceComment({ verdict, reason, report, minExecuted, action: action + (verdict === "fail" ? blockerNote : ""), introduced, preExisting, flaky }),
        );
      } catch (e) {
        console.warn(`   ⚠️  Failed to post real-claude gate evidence on #${candidate.issueNumber}: ${e}`);
        if (artifactsPending) return; // Recovery needs the durable evidence pointer.
      }

      // Mark rework before moving so a failed write cannot forward stale approvals.
      if (artifactsPending) {
        try {
          await client.addLabel(candidate.issueNumber, realClaudeGate.failReworkLabel);
        } catch (e) {
          console.warn(`   ⚠️  Failed to mark live artifact handoff for #${candidate.issueNumber}: ${e}`);
          return;
        }
      }
      if (outcome.toColumn !== null) {
        try {
          await client.updateItemStatus(candidate.itemId, outcome.toColumn);
        } catch (e) {
          console.warn(`   ⚠️  Failed to move #${candidate.issueNumber} to ${outcome.toColumn}: ${e}`);
        }
      }
      for (const label of artifactsPending ? [] : outcome.addLabels) {
        try { await client.addLabel(candidate.issueNumber, label); } catch (e) {
          console.warn(`   ⚠️  Failed to add ${label} to #${candidate.issueNumber}: ${e}`);
        }
      }
      for (const label of outcome.removeLabels) {
        try { await client.removeLabel(candidate.issueNumber, label); } catch (e) {
          console.warn(`   ⚠️  Failed to remove ${label} from #${candidate.issueNumber}: ${e}`);
        }
      }

      const icon = verdict === "pass" ? "✅" : verdict === "flaky-pass" || verdict === "inherited-failure" ? "⚠️" : verdict === "fail" ? "❌" : "🚨";
      console.log(`   ${icon} Real-claude gate #${candidate.issueNumber}: ${verdict} — ${reason}`);

      // After the gated ticket's own writes, so a slow or failing board write
      // here can never hold up or undo its verdict. Any verdict can carry
      // flakes: a fail whose other failures reproduced still names them.
      let flakyTickets: FlakyTicketResult | null = null;
      if (flaky.length > 0) {
        flakyTickets = await recordFlaky(flaky, {
          gatedIssue: candidate.issueNumber,
          report,
          at: new Date().toISOString(),
        });
        for (const { name, issue } of flakyTickets.filed) console.log(`   🎫 Filed #${issue} in Backlog for flaky ${name}`);
        for (const { name, issue } of flakyTickets.commented) console.log(`   💬 Flaky ${name} recorded on #${issue}`);
        if (flakyTickets.untracked.length > 0) {
          console.warn(`   ⚠️  Flaky test(s) with no ticket this run: ${flakyTickets.untracked.join(", ")}`);
        }
      }

      if (outcome.notify) {
        await notifyDiscord(
          verdict === "flaky-pass"
            ? `⚠️ **Real-claude gate passed #${candidate.issueNumber} only on re-run.** ` +
              `${flaky.map(name => `\`${name}\``).join(", ")} failed once and passed the second time on the same ` +
              `merged tree. The ticket advanced; the flake is the suite's to fix — see the evidence comment.` +
              flakyTicketNote(flakyTickets)
            : verdict === "inherited-failure"
              ? `⚠️ **Real-claude gate found failures on main for #${candidate.issueNumber}.** ${reason}. ` +
                action
            : `🚨 **Real-claude gate could not judge #${candidate.issueNumber}** (${verdict}): ${reason}\n` +
              `Parked in ${REAL_CLAUDE_GATE_RUN_FROM_COLUMN} with \`${outcome.addLabels.join("`, `")}\`. ` +
              `Needs a human — see the evidence comment.`,
        );
      }
    } finally {
      try {
        await client.removeLabel(candidate.issueNumber, REAL_CLAUDE_GATE_RUNNING_LABEL);
      } catch (error) {
        console.warn(`   ⚠️  Real-claude gate: could not clear the running label on #${candidate.issueNumber}: ${error}`);
      }
      // Unconditionally, not just on mutation. The board snapshot this cycle
      // started with is now minutes old — a full suite is 300s-plus — and
      // ticket selection still runs after this step. Even a run that changed
      // nothing has invalidated the cache by outliving it.
      client.clearItemsCache();
    }
  };

  if (background) {
    background(candidate.issueNumber, () => work().catch((error: any) => {
      console.error(`   ❌ Real-claude gate #${candidate.issueNumber} ended unexpectedly: ${error?.message ?? error}`);
    }));
    return true;
  }
  await work();
  return false;
}

/**
 * Send a gated ticket whose branch conflicts with the base to its code owner,
 * only to finish the merge (see `decideGateMergeRoute` for the incidents).
 * The same comment marker, labels and owner as the final merge's handoff in
 * dispatch.ts: the rework router then moves nothing and counts nothing, the
 * owner's next run meets the conflict in its own pre-run merge and finishes
 * it there, and the review stages and this gate run again after it.
 * `needs-real-claude` stays on throughout.
 *
 * Returns `park` with one sentence for the evidence comment when the shared
 * handoff budget is spent, when the earlier handoffs cannot be counted, or
 * when a write fails. The caller then parks the ticket exactly as it did
 * before this route existed. The comment is posted before the labels and the
 * move, so a failed attempt still counts toward the budget.
 */
async function handOffGateConflict(
  client: ReconcileClient,
  candidate: RealClaudeGateRunCandidate,
  report: GateRunReport,
  notifyDiscord: (message: string) => Promise<void>,
): Promise<{ kind: "routed" } | { kind: "park"; reason: string }> {
  let prior: number;
  try {
    prior = await client.countMarkerComments(candidate.issueNumber, FINAL_MERGE_HANDOFF_MARKER);
  } catch (e: any) {
    return { kind: "park", reason: `Its earlier merge handoffs could not be counted, so it was not sent on: ${e?.message ?? e}.` };
  }
  const route = decideGateMergeRoute(activeStageSet().agents, REAL_CLAUDE_GATE_FAIL_COLUMN, prior);
  if (route.kind === "park") return route;

  const files = report.mergeConflict?.paths ?? [];
  const behind = report.commitsBehind === null ? "" : `, ${report.commitsBehind} commit(s) behind it,`;
  try {
    await client.addComment(
      candidate.issueNumber,
      `${FINAL_MERGE_HANDOFF_MARKER}\n## 🔀 Live gate merge sent to ${route.owner}\n\n` +
      `The real-claude gate merges \`${report.baseRef}\` into \`${report.branchName}\` before it runs the live suite. ` +
      `The branch${behind} conflicts with it` +
      (files.length > 0 ? ` in:\n\n${files.map(p => `- \`${p}\``).join("\n")}\n\n` : `. `) +
      `The conflict is more than imports added on both sides, so the dispatcher cannot settle it, and nothing ran.\n\n` +
      `This ticket goes back to ${route.owner} only to finish this merge. It does not count as a rework. ` +
      `${route.owner}'s next run merges the default branch into \`${report.branchName}\` and settles the conflict. ` +
      `\`${REAL_CLAUDE_GATE_LABEL}\` stays on, so after the review stages the live gate runs again on the merged branch.\n\n` +
      `This is merge handoff ${prior + 1} of ${FINAL_MERGE_HANDOFF_MAX}, counted together with any final-merge handoffs. ` +
      `If the branch conflicts again after the last one, the ticket parks for a human.`,
    );
    await client.addLabel(candidate.issueNumber, MERGE_HANDOFF_LABEL);
    await client.addLabel(candidate.issueNumber, `needs-rework:${route.owner}`);
    await client.updateItemStatus(candidate.itemId, route.column);
  } catch (e: any) {
    console.warn(`   ⚠️  Real-claude gate: failed to send #${candidate.issueNumber}'s merge to ${route.owner}: ${e?.message ?? e}`);
    return { kind: "park", reason: `Sending it to ${route.owner} to finish the merge failed: ${e?.message ?? e}.` };
  }

  console.log(
    `   🔀 Real-claude gate #${candidate.issueNumber}: conflicts with ${report.baseRef}; sent to ${route.owner} ` +
    `in ${route.column} to finish the merge (not a rework, handoff ${prior + 1}/${FINAL_MERGE_HANDOFF_MAX})`,
  );
  try {
    await notifyDiscord(
      `🔀 Live gate merge conflict on #${candidate.issueNumber} — sent back to ${route.owner} to finish the merge ` +
      `(handoff ${prior + 1}/${FINAL_MERGE_HANDOFF_MAX}).`,
    );
  } catch (e: any) {
    console.warn(`   ⚠️  Discord notify failed for #${candidate.issueNumber}: ${e?.message ?? e}`);
  }
  return { kind: "routed" };
}

/** Default for `runRealClaudeGateExecution`'s flake filing: file nothing. */
async function noFlakyTickets(flaky: readonly string[]): Promise<FlakyTicketResult> {
  return { filed: [], commented: [], untracked: [...flaky] };
}

/** One sentence for the Discord ping naming where the flakes are tracked. */
function flakyTicketNote(result: FlakyTicketResult | null): string {
  if (result === null) return "";
  const tracked = [...result.filed, ...result.commented].map(t => `#${t.issue}`);
  return tracked.length > 0 ? ` Tracked on ${tracked.join(", ")}.` : "";
}

/** Missing integration cannot spend the unrelated ticket's retry budget. */
async function noInheritedTickets(failures: readonly string[]): Promise<InheritedTicketResult> {
  return { blockers: [], untracked: [...failures] };
}
