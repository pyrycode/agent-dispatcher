// Dispatch candidate selection: given the per-cycle items snapshot and
// the agent poll order, pick which (agent, item) tuples to dispatch this
// cycle, up to `maxConcurrent`.
//
// All pure: takes a snapshot, returns chosen tuples. The caller (pollLoop)
// does the I/O.
//
// Split from lib.ts on 2026-05-09. Imports `shouldSkipDispatch` from
// pipeline-decisions.ts and `hasOpenBlockers` from blockers.ts.

import { AGENTS, type AgentConfig } from "./types.js";
import { resolveFamilyRoot, shouldSkipDispatch, type DecisionItem } from "./pipeline-decisions.js";
import { hasOpenBlockers } from "./blockers.js";
import { byTicketPriority } from "./ticket-priority.js";

// Built from AGENTS — the CLASSIC stage set's name → column mapping. Kept
// for callers pinned to the classic shape (tests); live routing reads the
// resolved stage set's `columnByAgent` instead (see stage-sets.ts), which
// is identical to this map when PYRY_STAGE_SET is unset or `classic`.
export const AGENT_COLUMN_MAP: ReadonlyMap<string, string> = new Map(
  AGENTS.map((a: AgentConfig) => [a.name, a.column]),
);

// --------- Dispatch candidate selection ---------

/** A single (agent, item) pair the dispatcher will run this cycle. */
export interface DispatchCandidate<T extends DecisionItem = DecisionItem> {
  agent: AgentConfig;
  item: T;
}

/**
 * Pick which (agent, item) tuples to dispatch this cycle, up to `maxConcurrent`.
 *
 * Priority labels come first: high, normal, unmarked, then low. Equal
 * priorities preserve `pollOrder` (most-advanced-first), then board order.
 * Caps are applied after sorting so a lower-priority item cannot take the
 * only slot for a serial agent before a higher-priority item is considered.
 * Eligibility is the same per-item gate the original WIP=1 loop applied:
 * `shouldSkipDispatch`
 * (label-based: ready/needs-rework/wip/error/error:max_turns_salvaged) AND
 * `hasOpenBlockers` (open-blocker-based, applies to all agents
 * including PO — see that function's docstring for the docs-lag rationale).
 *
 * Concurrency model: WIP=1 *per dependency chain*, parallel across chains.
 * Two unrelated tickets (neither blocks the other) can run simultaneously.
 * Two tickets where A blocks B are kept serial because while A's wip:<agent>
 * is set, A's issue stays OPEN, and B's blockedBy(A) gates it through
 * `hasOpenBlockers`. So this function never picks both halves of an
 * in-flight blocker pair, even when iterating an outdated snapshot.
 *
 * Multiple eligible items in the same column produce multiple candidates for
 * the same agent — two PO instances can refine two unrelated Backlog tickets
 * in parallel. The cap is the `maxConcurrent` budget, not per-agent.
 *
 * **Per-agent serial cap.** Agents marked `serial: true` in their
 * `AgentConfig` (currently: documentation) get a per-agent WIP=1 cap on top
 * of the global `maxConcurrent`. Counts in-flight `wip:<agent>` from any
 * column in the snapshot AND items already picked this cycle as slots
 * consumed; once one slot is taken, no further items for that agent are
 * picked this cycle. Applies to agents that touch centralized cross-cutting
 * files every ticket also touches (e.g. `docs/knowledge/INDEX.md`,
 * `docs/PROJECT-MEMORY.md`) — two parallel runs produce add/add merge
 * conflicts the dispatcher's pre-merge step can't resolve. Surfaced
 * 2026-05-10 by concurrent documentation runs on #1 and #2.
 *
 * **Family breaker veto.** `rootLabelsByIssue` maps issue number → label
 * set for every item on the board (all columns, closed included — a split
 * family's root usually sits closed in Done). Each candidate's family
 * root is resolved from its parent-chain snapshot fields, and a root
 * carrying `error:family-breaker` vetoes the candidate via
 * `shouldSkipDispatch`'s rootLabels arm. Optional: without the lookup
 * (older callers, lookup build failure) selection behaves exactly as
 * before and the veto is left to `runFamilyBreaker`'s tally check.
 *
 * **`excludedRoots`.** Families the caller has already established are
 * parked THIS cycle — a tally trip the root's labels do not yet show.
 * Selection spends its `maxConcurrent` budget before the tally check
 * runs, so without a way to re-select minus the parked family, a single
 * parked lineage at the head of a column starves the whole board: the
 * budget is handed to candidates that are guaranteed to be dropped, and
 * the next cycle repeats it from the same snapshot order. The poll loop
 * re-selects with this set filled in. Empty or absent behaves exactly as
 * before.
 *
 * Pure function over a snapshot. Caller is responsible for invalidating the
 * snapshot (per-cycle items cache) at appropriate boundaries.
 */
export function selectDispatches<T extends DecisionItem>(opts: {
  itemsByColumn: ReadonlyMap<string, readonly T[]>;
  pollOrder: readonly AgentConfig[];
  maxConcurrent: number;
  rootLabelsByIssue?: ReadonlyMap<number, readonly string[]>;
  excludedRoots?: ReadonlySet<number>;
  /** Managed callers offer all candidates; shared admission applies role caps. */
  deferRoleLimits?: boolean;
}): DispatchCandidate<T>[] {
  const { itemsByColumn, pollOrder, maxConcurrent, rootLabelsByIssue, excludedRoots } = opts;
  const out: DispatchCandidate<T>[] = [];
  if (maxConcurrent <= 0) return out;
  const budgets = new Map<AgentConfig, number>();
  const candidates: DispatchCandidate<T>[] = [];
  for (const agent of pollOrder) {
    const cap = opts.deferRoleLimits ? undefined : agent.serial ? 1 : agent.maxInFlight;
    let inFlight = 0;
    if (cap !== undefined) {
      const wipLabel = `wip:${agent.name}`;
      for (const cols of itemsByColumn.values()) {
        for (const item of cols) {
          if (item.labels.includes(wipLabel)) inFlight++;
        }
      }
    }
    budgets.set(agent, cap === undefined ? Infinity : Math.max(0, cap - inFlight));
    for (const item of itemsByColumn.get(agent.column) ?? []) {
      const familyRoot = resolveFamilyRoot(item);
      if (excludedRoots?.has(familyRoot)) continue;
      if (shouldSkipDispatch(item.labels, agent.name, rootLabelsByIssue?.get(familyRoot))) continue;
      if (item.issueNumber > 0 && hasOpenBlockers(item.blockedBy ?? [])) continue;
      candidates.push({ agent, item });
    }
  }
  for (const candidate of byTicketPriority(candidates, c => c.item.labels)) {
    if (out.length >= maxConcurrent) break;
    const remaining = budgets.get(candidate.agent)!;
    if (remaining <= 0) continue;
    out.push(candidate);
    budgets.set(candidate.agent, remaining - 1);
  }
  return out;
}
