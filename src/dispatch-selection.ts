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
import { shouldSkipDispatch, type DecisionItem } from "./pipeline-decisions.js";
import { hasOpenBlockers } from "./blockers.js";

// Built from AGENTS — single source of truth for the name → column mapping.
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
 * Iterates `pollOrder` (most-advanced-first) and within each agent's column
 * scans items in order, accumulating eligible dispatches. Eligibility is the
 * same per-item gate the original WIP=1 loop applied — `shouldSkipDispatch`
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
 * Pure function over a snapshot. Caller is responsible for invalidating the
 * snapshot (per-cycle items cache) at appropriate boundaries.
 */
export function selectDispatches<T extends DecisionItem>(opts: {
  itemsByColumn: ReadonlyMap<string, readonly T[]>;
  pollOrder: readonly AgentConfig[];
  maxConcurrent: number;
}): DispatchCandidate<T>[] {
  const { itemsByColumn, pollOrder, maxConcurrent } = opts;
  const out: DispatchCandidate<T>[] = [];
  if (maxConcurrent <= 0) return out;
  for (const agent of pollOrder) {
    if (out.length >= maxConcurrent) break;
    const items = itemsByColumn.get(agent.column) ?? [];
    for (const item of items) {
      if (out.length >= maxConcurrent) break;
      if (shouldSkipDispatch(item.labels, agent.name)) continue;
      if (item.issueNumber > 0 && hasOpenBlockers(item.blockedBy ?? [])) continue;
      out.push({ agent, item });
    }
  }
  return out;
}
