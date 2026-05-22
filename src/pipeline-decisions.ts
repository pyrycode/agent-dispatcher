// Pipeline state machine: auto-advance, rework routing, done-cleanup,
// post-run label decisions, label predicates, rework-target extraction,
// rework-loop circuit breaker, advance-rule lookup.
//
// All pure: takes labels, columns, rule tables; returns decisions.
//
// Split from lib.ts on 2026-05-09. Imports `hasOpenBlockers` from blockers.ts
// (the only cross-file dependency in this file).

import { hasOpenBlockers } from "./blockers.js";

// --------- Auto-advance rules ---------

export interface AdvanceRule {
  from: string;
  readyLabel: string;
  to: string;
}

// Auto-advance rules: a ticket moves from `from` → `to` when its labels
// include `readyLabel`. The chain must walk every column from Backlog to
// Done with no gaps; the consistency tests in lib.test.ts enforce this.
export const AUTO_ADVANCE_RULES: AdvanceRule[] = [
  { from: "Backlog",            readyLabel: "done:po",             to: "In Architecture" },
  { from: "In Architecture",    readyLabel: "done:architect",      to: "In Development" },
  { from: "In Development",     readyLabel: "done:developer",      to: "In QA" },
  { from: "In QA",              readyLabel: "done:qa",             to: "In Code Review" },
  { from: "In Code Review",     readyLabel: "done:code-review",    to: "In Documentation" },
  { from: "In Documentation",   readyLabel: "done:documentation",  to: "Done" },
];

/**
 * Columns where the dispatcher does NOT auto-advance even when the
 * matching `done:<agent>` label is present — a human reviews the work
 * and moves the ticket forward manually (same gesture as Inbox → Backlog).
 *
 * **Currently empty** (as of 2026-05-02). The architect → developer gate
 * was added 2026-05-01 as a safety net for oversized specs, then removed
 * once the size policy was enforced in code (architect either sizes ≤M
 * with a "Why M, not split" justification, or splits via `needs-rework:po`
 * — both produce a deterministic outcome that doesn't need human review).
 * The gate was duplicating safeguards.
 *
 * The mechanism stays. Adding a future gate is a deliberate policy decision:
 * append the column name here, update the corresponding test in lib.test.ts,
 * and the gating behaviour in `decideAutoAdvance` activates automatically.
 *
 * Tickets in a gated column sit with `done:<agent>` set; the gate
 * just suppresses the auto-advance step. `shouldSkipDispatch` prevents
 * re-dispatch of an agent that has already added `done:` for itself,
 * so the ticket is stable.
 */
export const MANUAL_ADVANCE_GATES: ReadonlySet<string> = new Set<string>();

/**
 * Columns considered "mid-pipeline" for the WIP cap. A ticket sitting in
 * any of these columns is in flight: actively progressing through agents,
 * awaiting human gate, or transiently in rework.
 *
 * Backlog and Inbox are not mid-pipeline (work hasn't started). Done is
 * not mid-pipeline (work is complete).
 *
 * Used by `runAutoAdvance` to compute available capacity for Backlog →
 * In Architecture promotions: `capacity = max(0, maxConcurrent - inFlight)`.
 * When the pipeline is at capacity, eligible Backlog tickets are held;
 * otherwise up to `capacity` of them advance per cycle, in board-position
 * order (top-of-column first).
 *
 * Tickets carrying any `error:*` label are excluded from the in-flight
 * count by the caller — they're stuck on exceptional human action and
 * shouldn't block unrelated work. Adding an `error:*` label is the
 * escape hatch for parking a normal-path ticket too (e.g. a long
 * human-gate delay where you want unrelated tickets to flow).
 */
export const MID_PIPELINE_COLUMNS: readonly string[] = [
  "In Architecture",
  "In Development",
  "In QA",
  "In Code Review",
  "In Documentation",
];

/**
 * Count of "in flight" tickets among the given mid-pipeline items —
 * the number of pipeline threads currently consuming WIP capacity.
 *
 * Counts:
 *   - tickets actively running, awaiting human gate, or transiently in rework
 *   - tickets with no labels (just-arrived in column, awaiting dispatch)
 *
 * Excludes:
 *   - non-issue items (issueNumber <= 0, e.g. epics or draft project items)
 *   - tickets carrying any `error:*` label — those are stuck on exceptional
 *     human action and shouldn't block unrelated work. Adding `error:*` is
 *     also the escape hatch for parking a normal-path ticket (e.g. a long
 *     human-gate hold where you want unrelated tickets to flow).
 *   - tickets with an OPEN `blockedBy` dependency — they're parked, not
 *     progressing. `hasOpenBlockers` correctly prevents the dispatcher
 *     from picking them; without this exclusion they still held a
 *     capacity seat, deadlocking Backlog promotion at MAX_CONCURRENT=1
 *     when a blocker pair sits opposite each other (agent-dispatcher#10,
 *     surfaced 2026-05-16 with pyrycode/pyrycode#383 blocked by #409).
 *
 * Pure function over the items the caller already collected from
 * MID_PIPELINE_COLUMNS — no I/O, no side effects, easy to unit-test.
 */
export function countPipelineInFlight(
  items: { issueNumber: number; labels: string[]; blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[] }[],
): number {
  return items.filter(
    item =>
      item.issueNumber > 0 &&
      !item.labels.some(l => l.startsWith("error:")) &&
      !hasOpenBlockers(item.blockedBy ?? []),
  ).length;
}

/**
 * True if any item in the mid-pipeline column set counts as in-flight.
 * Thin wrapper over `countPipelineInFlight`; kept as a boolean alias
 * for callers that don't need the count.
 *
 * Inherits the blocker exclusion transparently — semantics shifted from
 * "any non-errored mid-pipeline" to "any progressing mid-pipeline,"
 * which is what every existing caller actually wants.
 */
export function isPipelineInFlight(
  items: { issueNumber: number; labels: string[]; blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[] }[],
): boolean {
  return countPipelineInFlight(items) > 0;
}

// --------- Auto-advance decision ---------

/** Minimum item shape the decision functions need. Subset of `ProjectItem`. */
export interface DecisionItem {
  id: string;
  issueNumber: number;
  labels: string[];
  /** GitHub-native blocked-by relationships. Optional; defaults to empty
   *  (no blockers). Auto-advance excludes items with any OPEN blocker. */
  blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[];
}

/** A single column-to-column move the dispatcher will execute. */
export interface AdvanceAction {
  itemId: string;
  issueNumber: number;
  fromColumn: string;
  toColumn: string;
}

/** What `decideAutoAdvance` returns: advances + diagnostics for logging. */
export interface AutoAdvanceDecision {
  advances: AdvanceAction[];
  /** Items currently sitting at a human gate (logged as 🚦 awaiting review). */
  gatedAwaiting: { column: string; itemNumbers: number[] }[];
  /** Items in Backlog held because the pipeline is at capacity
   *  (`inFlightCount >= maxConcurrent`); logged as 🛑 held. */
  backlogHeld: number[];
}

/**
 * Pure decision function for `runAutoAdvance`. Given the rule table, gate
 * set, current items in each `from` column, the count of pipeline threads
 * currently in flight, and the concurrency cap, return the list of advances
 * to perform plus the diagnostic info the caller needs to log gate/hold
 * heartbeats.
 *
 * Semantics:
 *   - **Gated columns** (in MANUAL_ADVANCE_GATES): no advance even when
 *     `done:<agent>` is set. Eligible items are reported in `gatedAwaiting`
 *     for heartbeat logging.
 *   - **Backlog**: capacity = `max(0, maxConcurrent - inFlightCount)`.
 *     Advance the first `min(eligible.length, capacity)` items in input
 *     order; hold the rest in `backlogHeld`. When capacity is 0, all
 *     eligible Backlog items are held. The cap matches `selectDispatches`'s
 *     concurrency model — N parallel threads through the pipeline, no
 *     PO frontrunning past available capacity. Without this cap, refined
 *     `done:po` tickets would accumulate in Backlog while only one
 *     advanced per cycle (the pre-2026-05-08 bug).
 *   - **Mid-pipeline columns**: advance ALL eligible items. Once a ticket
 *     is past Backlog we want it to keep flowing.
 *   - An item is **eligible** when it has the rule's `readyLabel`, has a
 *     positive `issueNumber`, carries no `needs-rework:*` or `error:*`
 *     label, and has no OPEN blocker.
 *
 * Backlog input order is the user's prioritization signal — `runAutoAdvance`
 * queries with `orderBy: { field: POSITION, direction: ASC }` so top-of-column
 * comes first. Trust it; don't re-sort.
 */
export function decideAutoAdvance(
  rules: readonly AdvanceRule[],
  gates: ReadonlySet<string>,
  itemsByColumn: ReadonlyMap<string, readonly DecisionItem[]>,
  inFlightCount: number,
  maxConcurrent: number,
): AutoAdvanceDecision {
  const advances: AdvanceAction[] = [];
  const gatedAwaiting: { column: string; itemNumbers: number[] }[] = [];
  const backlogHeld: number[] = [];

  const isEligible = (item: DecisionItem, readyLabel: string): boolean =>
    item.issueNumber > 0 &&
    item.labels.includes(readyLabel) &&
    !item.labels.some(l => l.startsWith("needs-rework:") || l.startsWith("error:")) &&
    !hasOpenBlockers(item.blockedBy ?? []);

  for (const rule of rules) {
    const all = itemsByColumn.get(rule.from) ?? [];
    const eligible = all.filter(item => isEligible(item, rule.readyLabel));

    if (gates.has(rule.from)) {
      if (eligible.length > 0) {
        gatedAwaiting.push({
          column: rule.from,
          itemNumbers: eligible.map(i => i.issueNumber),
        });
      }
      continue;
    }

    if (rule.from === "Backlog") {
      // Capacity-bounded Backlog promotion. Advance up to `capacity` items
      // in input (board-position) order; hold the rest. Capacity tracks
      // free pipeline seats so PO refinements don't pile up as `done:po`
      // tickets that can't enter the pipeline (the bug shape: with WIP=N
      // dispatch but a hardcoded WIP=1 advance, refined backlog tickets
      // got stranded one-per-cycle while the pipeline ran serially).
      const capacity = Math.max(0, maxConcurrent - inFlightCount);
      if (capacity === 0) {
        backlogHeld.push(...eligible.map(i => i.issueNumber));
        continue;
      }
      if (eligible.length === 0) continue;
      const advancing = eligible.slice(0, capacity);
      for (const item of advancing) {
        advances.push({
          itemId: item.id,
          issueNumber: item.issueNumber,
          fromColumn: rule.from,
          toColumn: rule.to,
        });
      }
      if (eligible.length > capacity) {
        backlogHeld.push(...eligible.slice(capacity).map(i => i.issueNumber));
      }
      continue;
    }

    // Mid-pipeline: advance every eligible item.
    for (const item of eligible) {
      advances.push({
        itemId: item.id,
        issueNumber: item.issueNumber,
        fromColumn: rule.from,
        toColumn: rule.to,
      });
    }
  }

  return { advances, gatedAwaiting, backlogHeld };
}

// --------- Rework routing decision ---------

/** A single rework move + the labels the dispatcher will strip on routing. */
export interface ReworkRoute {
  itemId: string;
  issueNumber: number;
  fromColumn: string;
  toColumn: string;
  /** The needs-rework:<target> label that triggered this route. */
  triggerLabel: string;
  /** Labels to remove on routing — includes the trigger plus any
   *  done:/wip:/error: state labels (so the target column receives a
   *  clean ticket, ready for re-dispatch). Non-state labels (size:,
   *  priority:, custom tags) are preserved. */
  labelsToStrip: string[];
}

/**
 * Pure decision function for `runReworkRouting`. Given the agent→column
 * map and current items in each column, return the list of rework routes
 * to apply.
 *
 * Per item with one or more `needs-rework:<target>` labels, the FIRST valid
 * label (by array order) wins:
 *   - Item must have `issueNumber > 0`.
 *   - Target must extract cleanly via `extractReworkTarget` (rejects bare
 *     `needs-rework:` and non-rework labels).
 *   - Target must be a known agent (in `agentColumnMap`).
 *
 * Same-column case (target column == source column) IS routed — earlier
 * versions skipped this as a "self-loop," but that left the rework label
 * on the item permanently. Combined with `shouldSkipDispatch` checking
 * for `needs-rework:<agent>` in `PIPELINE_LABEL_PREFIXES`, the label
 * persistence permanently blocked dispatch on the matching agent. The
 * fix: route same-column cases too — the caller's `updateItemStatus`
 * is a no-op for same-column updates, but the label-strip and
 * rework-count bump still happen, which unblocks dispatch. Surfaced as
 * Pyrycode #59's broader bug 2026-05-02.
 *
 * Pure function over already-collected items; the caller does the I/O
 * (status updates and label removals).
 */
export function decideReworkRoutes(
  agentColumnMap: ReadonlyMap<string, string>,
  itemsByColumn: ReadonlyMap<string, readonly DecisionItem[]>,
): ReworkRoute[] {
  const routes: ReworkRoute[] = [];

  for (const [fromColumn, items] of itemsByColumn) {
    for (const item of items) {
      if (item.issueNumber <= 0) continue;

      // First valid rework label wins. Iterate in array order for
      // determinism — same order GitHub returns from the labels query.
      for (const label of item.labels) {
        const target = extractReworkTarget(label);
        if (target === null) continue;
        const targetColumn = agentColumnMap.get(target);
        if (!targetColumn) continue;

        const labelsToStrip = [
          label,
          ...item.labels.filter(l =>
            l !== label &&
            (l.startsWith("done:") || l.startsWith("wip:") || l.startsWith("error:")),
          ),
        ];

        routes.push({
          itemId: item.id,
          issueNumber: item.issueNumber,
          fromColumn,
          toColumn: targetColumn,
          triggerLabel: label,
          labelsToStrip,
        });
        break; // first valid rework label wins
      }
    }
  }

  return routes;
}

// --------- Done-column cleanup decision ---------

/** A single ticket's worth of pipeline-state cleanup on entering Done. */
export interface DoneCleanup {
  itemId: string;
  issueNumber: number;
  /** Pipeline-state labels to remove. Always non-empty (clean tickets
   *  produce no entry in the result array). */
  labelsToStrip: string[];
}

/**
 * Pure decision function for `runDoneCleanup`. Given the items currently
 * in the Done column, return one cleanup entry per ticket that still
 * carries pipeline-state labels.
 *
 * The bug this fixes: `runAutoAdvance` moves tickets between columns by
 * `updateItemStatus` only — it doesn't strip the `done:<agent>` labels
 * that drove each advance. So a ticket that flowed through every agent
 * arrives in Done carrying every `done:*` from the trail. The auto-merge
 * path strips pipeline labels, but only after `gh pr merge` succeeds —
 * doc-only tickets, manually-merged PRs, and closed-as-won't-fix never
 * get cleaned. `runClosedSweep` (which moves closed-but-not-Done tickets
 * to Done) also doesn't strip. This pass closes the gap.
 *
 * Symmetric in spirit with `decideReworkRoutes`: rework routing returns
 * `labelsToStrip` for backward column moves; this returns `labelsToStrip`
 * for the terminal column. The asymmetry between auto-advance (no strip)
 * and rework (strip) was the root cause; cleanup here re-establishes the
 * invariant that no ticket sits in a final-state column with stale
 * pipeline labels.
 *
 * Strips:
 *   - any `done:`/`wip:`/`error:`/`needs-rework:` label (`isPipelineLabel`)
 *   - any `rework-count:N` label (counter — reset so a re-opened ticket
 *     starts fresh rather than carrying stale rounds toward the loop
 *     threshold)
 *
 * Does NOT touch:
 *   - `size:`, `priority:`, `merged`, or any free-form tag
 *   - the `merged` label specifically — its semantic is "PR was merged,"
 *     set only by the auto-merge path; reaching Done some other way
 *     shouldn't grant it
 *
 * Skips items with `issueNumber <= 0` (epics, virtual items) — same as
 * `decideReworkRoutes`. Idempotent: a clean ticket produces no entry.
 *
 * Pure function over already-collected items; the caller does the I/O
 * (label removals).
 */
export function decideDoneCleanup(
  doneItems: readonly DecisionItem[],
): DoneCleanup[] {
  const cleanups: DoneCleanup[] = [];

  for (const item of doneItems) {
    if (item.issueNumber <= 0) continue;

    const labelsToStrip = item.labels.filter(
      l => isPipelineLabel(l)
        || l.startsWith("rework-count:")
        || l.startsWith("merge-attempt:"),
    );

    if (labelsToStrip.length === 0) continue;

    cleanups.push({
      itemId: item.id,
      issueNumber: item.issueNumber,
      labelsToStrip,
    });
  }

  return cleanups;
}

// --------- Post-run label decision (pure layer for #16 extraction) ---------

/**
 * The decision shape returned by `decidePostRunLabels`. The caller
 * applies the side effects (label add, label strip, log line, comment
 * framing) based on these flags.
 */
export interface PostRunLabelDecision {
  /** The agent named in any `needs-rework:<target>` label, or null. */
  reworkTarget: string | null;
  /** True if a legacy `needs-rework` (no agent suffix) is present and
   *  should be stripped — the dispatcher's legacy-label cleanup. */
  shouldStripLegacyNeedsRework: boolean;
  /** True if the dispatcher should add `done:<agentName>`. False if
   *  rework was requested, the agent moved the ticket out of its
   *  column, or the post-run status fetch failed. */
  addReadyLabel: boolean;
  /** `done:*` labels from prior agents that should be stripped before
   *  the new `done:<agentName>` is applied. Populated only when
   *  `addReadyLabel === true`; empty otherwise.
   *
   *  `runAutoAdvance` moves tickets between columns without stripping
   *  the `done:<agent>` labels that drove each advance (auto-advance
   *  is column-only by design — see `decideAutoAdvance` and
   *  `decideDoneCleanup`'s docstring for the asymmetry). The rework
   *  path strips via `runReworkRouting`; the Done path strips via
   *  `runDoneCleanup` + `runAutoMerge`. Mid-pipeline tickets that
   *  freeze on a `GLOBAL_BLOCK_LABELS` entry (e.g. `error:max_turns_salvaged`)
   *  carry every prior `done:*` until human triage. Stripping at the
   *  point the next agent's `done:<self>` is added closes the gap.
   *
   *  Excludes `done:<agentName>` itself (idempotency: don't remove +
   *  re-add this agent's own label if a re-dispatch left it set).
   *
   *  Surfaced 2026-05-10 by relay #7 carrying `done:po + done:architect
   *  + error:max_turns_salvaged`. The asymmetry has been present since
   *  pyrycode/agents@985bad1; rare visibility because most tickets
   *  flow to Done before stalling.
   */
  priorReadyLabelsToStrip: string[];
  /** Why `addReadyLabel` is what it is — drives the log message
   *  shape so humans can see the reasoning at a glance. */
  logKind: "ready" | "rework" | "moved-out" | "status-unknown";
}

/**
 * Decide post-run labeling for an agent dispatch given the labels
 * present after the run, the agent's column, and the post-run column.
 *
 * Replaces the inline label-routing block in `dispatchToAgent` (review
 * #16). Three responsibilities, all pure:
 *
 * 1. Find the rework target — the agent named in any `needs-rework:<target>`
 *    label. Also flags whether a legacy `needs-rework` (no suffix) is
 *    present so the caller can strip it.
 * 2. Decide whether to add `done:<agentName>` — defers to
 *    `shouldAddReadyLabel` for the canonical rule (rework wins, column
 *    move wins, status-unknown wins).
 * 3. Categorize the outcome for logging — `ready`, `rework`, `moved-out`,
 *    or `status-unknown`.
 *
 * `currentColumn === null` means the post-run status fetch failed; the
 * caller logs the status-unknown case and skips the ready label
 * (cautious — preserves the next cycle's chance to recover).
 */
export function decidePostRunLabels(opts: {
  postLabels: readonly string[];
  agentName: string;
  agentColumn: string;
  currentColumn: string | null;
}): PostRunLabelDecision {
  // Find a needs-rework:<target> label (first match wins; multiple
  // shouldn't co-exist but if they do, the first one is canonical).
  let reworkTarget: string | null = null;
  for (const label of opts.postLabels) {
    const target = extractReworkTarget(label);
    if (target !== null) {
      reworkTarget = target;
      break;
    }
  }

  const hasLegacy = opts.postLabels.includes("needs-rework");
  // Legacy `needs-rework` (no suffix) is interpreted as "this agent's work
  // needs rework by this same agent" — the dispatcher's pre-prefix-scheme
  // semantics. Promotes it into a structured target only if no explicit
  // one was found.
  const effectiveReworkTarget = reworkTarget ?? (hasLegacy ? opts.agentName : null);

  const addReadyLabel = shouldAddReadyLabel({
    agentColumn: opts.agentColumn,
    currentColumn: opts.currentColumn,
    hasReworkTarget: effectiveReworkTarget !== null,
  });

  let logKind: PostRunLabelDecision["logKind"];
  if (addReadyLabel) {
    logKind = "ready";
  } else if (effectiveReworkTarget !== null) {
    logKind = "rework";
  } else if (opts.currentColumn !== null && opts.currentColumn !== opts.agentColumn) {
    logKind = "moved-out";
  } else {
    logKind = "status-unknown";
  }

  // Strip prior agents' `done:*` only when we're about to add
  // `done:<self>`. Rework path defers to `runReworkRouting`; moved-out
  // and status-unknown paths skip strips by design (no ready add to
  // bookend; cautious recovery on next cycle).
  const ownReadyLabel = `done:${opts.agentName}`;
  const priorReadyLabelsToStrip = addReadyLabel
    ? opts.postLabels.filter(
        (l) => l.startsWith("done:") && l !== ownReadyLabel,
      )
    : [];

  return {
    reworkTarget: effectiveReworkTarget,
    shouldStripLegacyNeedsRework: hasLegacy,
    addReadyLabel,
    priorReadyLabelsToStrip,
    logKind,
  };
}

/**
 * Decide whether to add `done:<agent>` after a successful agent run.
 *
 * The auto-advance step interprets `done:<agent>` as "this agent is
 * done, move the ticket forward." But some agents legitimately move
 * the ticket OUT of their dispatch column during a successful run:
 *
 * - **PO** demotes Backlog → Inbox when a ticket lacks information
 *   for refinement (per PO's CLAUDE.md: "If a Backlog ticket lacks
 *   enough information to refine, demote it back to Inbox").
 * - **PO** moves the parent ticket Backlog → Done after a split (it's
 *   superseded by the child tickets PO created).
 *
 * In those cases, adding `done:po` would attach a stale "ready for
 * the next stage" signal to a ticket the agent explicitly moved off
 * the pipeline. The auto-advance rule wouldn't fire (the ticket is
 * no longer in the rule's `from` column), but a human scanning the
 * board sees `done:po` on an Inbox ticket and is misled about state.
 *
 * Rules:
 * - Rework requested → skip (existing semantics)
 * - Agent moved ticket out of its column → skip (the move IS the signal)
 * - Current column unknown (post-run fetch failed) → skip (cautious)
 * - Otherwise → add the label
 *
 * Cost asymmetry favors caution: false positive (skip when should add)
 * means one cycle of delay before the next agent dispatches; false
 * negative (add when shouldn't) creates a stale label that misleads
 * the board view.
 */
export function shouldAddReadyLabel(opts: {
  agentColumn: string;
  currentColumn: string | null;
  hasReworkTarget: boolean;
}): boolean {
  if (opts.hasReworkTarget) return false;
  if (opts.currentColumn === null) return false;
  return opts.currentColumn === opts.agentColumn;
}

// --------- Label predicates ---------

// The four label prefixes the dispatcher uses for per-agent state.
//   done:<agent>        — agent completed successfully
//   needs-rework:<agent> — agent (or another) flagged the ticket back here
//   wip:<agent>          — agent currently running
//   error:<agent>        — agent crashed
export const PIPELINE_LABEL_PREFIXES = [
  "done:",
  "needs-rework:",
  "wip:",
  "error:",
] as const;

/**
 * True if the given label is one of the dispatcher's pipeline-state labels.
 * Used for stripping stale labels before re-dispatching an agent.
 */
export function isPipelineLabel(label: string): boolean {
  return PIPELINE_LABEL_PREFIXES.some((p) => label.startsWith(p));
}

/**
 * True if the given label is a pipeline-state label for the given agent
 * specifically (e.g. `error:developer` is for `developer`, not for any
 * other agent).
 *
 * The pre-dispatch strip loop uses this to scope cleanup to labels for the
 * agent we're about to run — without it, dispatching `architect` would
 * silently strip a `error:developer` that a prior dev run left as a
 * human-actionable signal. The pattern surfaced in the 2026-05-08 review
 * (#9): "labels are the truth" cuts both ways — stripping another agent's
 * signal IS a state mutation that the agent never authorized.
 *
 * shouldSkipDispatch already blocks the candidate when the SAME agent's
 * label is present, so the strip is purely defensive against state-drift
 * (e.g. label arrived between candidate selection and dispatch). Scoping
 * to the agent's own labels means the strip can't accidentally erase
 * another agent's state.
 */
export function isPipelineLabelForAgent(label: string, agentName: string): boolean {
  return PIPELINE_LABEL_PREFIXES.some((p) => label === p + agentName);
}

/**
 * Pipeline labels that block dispatch for ALL agents (not scoped to a
 * specific agent's name). Until any of these is stripped, no agent should
 * re-run on the ticket.
 *
 * - `error:max_turns_salvaged` — ticket's salvaged work sits in a draft PR
 *   awaiting human triage. Without the block, the next dispatch's existing
 *   PR-salvage path (which treats max_turns + open PR as success) would
 *   auto-advance partial work via `done:<agent>`. See `attemptSaferSalvage`
 *   and `shouldAttemptSafeSalvage` for the salvage flow.
 * - `error:merge-conflict` — auto-merge against `main` failed because the
 *   PR has a merge conflict. The label stops the auto-merge retry loop
 *   (which would otherwise hammer `gh pr merge` every cycle for zero
 *   progress, burning GraphQL points). The dispatcher's auto-merge block
 *   skips tickets carrying this label; the human resolves the conflict
 *   manually (`gh pr checkout … && git merge origin/main && …`) and strips
 *   the label to resume. Mirrors `error:max_turns_salvaged` shape: preserve
 *   work, force human attention, stop the loop. Detection uses
 *   `isMergeConflictError` on the gh CLI's stderr.
 */
export const GLOBAL_BLOCK_LABELS: ReadonlySet<string> = new Set([
  "error:max_turns_salvaged",
  "error:merge-conflict",
]);

/**
 * True if the given subprocess stderr/error indicates `gh pr merge` failed
 * because the PR has a merge conflict against its base. Matches the two
 * canonical phrases gh CLI emits ("is not mergeable" / "merge commit cannot
 * be cleanly created") plus the lower-case "merge conflict" phrase older
 * gh versions and other tooling use. Case-insensitive — gh's wording has
 * shifted across versions.
 *
 * Used by the dispatcher's auto-merge loop on Done tickets: if a merge
 * attempt errors and `isMergeConflictError(stderr) === true`, the
 * dispatcher labels the ticket `error:merge-conflict` (a global block),
 * posts a triage comment with the resolution recipe, and stops retrying.
 * Returns `false` for empty / undefined input — caller decides whether
 * "no stderr" means "no error" (skip) or "unknown failure" (also skip).
 */
export function isMergeConflictError(stderr: string | null | undefined): boolean {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return (
    s.includes("not mergeable") ||
    s.includes("merge commit cannot be cleanly created") ||
    s.includes("merge conflict")
  );
}

/**
 * The four-label gate from pollLoop's per-ticket inner loop: a ticket
 * should be skipped from dispatch if any of `done:<agent>`,
 * `needs-rework:<agent>`, `wip:<agent>`, or `error:<agent>` is present.
 *
 * Returns true to skip (don't dispatch this agent on this ticket).
 * Returns false otherwise (proceed with dispatch).
 *
 * Per-agent labels: OTHER agents' labels do NOT cause a skip — only
 * labels scoped to the agent currently being considered.
 *
 * Global-block labels (`GLOBAL_BLOCK_LABELS`) skip ALL agents until a
 * human strips them. Currently just `error:max_turns_salvaged`.
 */
export function shouldSkipDispatch(labels: string[], agentName: string): boolean {
  if (labels.some((l) => GLOBAL_BLOCK_LABELS.has(l))) return true;
  return PIPELINE_LABEL_PREFIXES.some((p) => labels.includes(p + agentName));
}

// --------- Rework target extraction ---------

/**
 * Parse a `needs-rework:<agent>` label and return the target agent name.
 * Returns null for labels that don't have the prefix or have an empty
 * target (the latter is an unusual but defensible input — e.g. someone
 * typed `needs-rework:` without a target).
 */
export function extractReworkTarget(label: string): string | null {
  const prefix = "needs-rework:";
  if (!label.startsWith(prefix)) return null;
  const target = label.slice(prefix.length);
  return target.length > 0 ? target : null;
}

// --------- Rework loop circuit-breaker ---------

/**
 * Number of rework rounds a single ticket can absorb before the dispatcher
 * halts dispatch and adds `error:rework-loop`. Adjusting this is a
 * deliberate policy change — see the test in lib.test.ts that locks the
 * default to 3.
 *
 * Why 3: the typical legitimate rework cycle is one round (agent finds
 * issue, routes back, fix lands, advances). A second round means the
 * fix wasn't right. A third round is unusual but defensible. A fourth
 * round is the loop pattern Pyrycode #41 hit (6 dispatches, ~$4
 * burned, dev agent self-halted by intelligence rather than structure).
 * Halting at 3 catches genuine loops well before they accumulate cost.
 */
export const REWORK_LOOP_THRESHOLD = 3;

/**
 * Read the current rework count from a ticket's labels. Looks for any
 * `rework-count:N` label and returns the maximum value found (or 0 if
 * none present). Multiple count labels shouldn't occur in normal
 * operation, but if they do, the maximum is the safest read — biases
 * toward halting rather than under-counting.
 *
 * Tolerates malformed labels (`rework-count:abc`, `rework-count:`) by
 * treating them as 0. Negative values are treated as invalid.
 */
export function extractReworkCount(labels: string[]): number {
  const prefix = "rework-count:";
  let max = 0;
  for (const label of labels) {
    if (!label.startsWith(prefix)) continue;
    const tail = label.slice(prefix.length);
    if (tail.length === 0) continue;
    const n = parseInt(tail, 10);
    if (isNaN(n) || n < 0) continue;
    if (n > max) max = n;
  }
  return max;
}

/**
 * Parse the current merge-conflict retry count from labels.
 *
 * Counter prefix: `merge-attempt:N`. Mirrors `extractReworkCount`'s
 * shape (max-of-found, defensive against multiple stale counters from
 * partial label-strip races).
 *
 * Used by `decideMergeRetry` to spread auto-merge conflict retries
 * across dispatcher cycles. The conflict failure mode is usually
 * transient — another sibling PR is mid-merge against the same line —
 * and a retry one cycle later, after the sibling has landed or also
 * failed, often succeeds. Pre-2026-05-10 evening the dispatcher gave
 * up after one conflict; this helper lets it count.
 *
 * Returns 0 when no `merge-attempt:N` label is present (fresh ticket).
 */
export function extractMergeAttemptCount(labels: string[]): number {
  const prefix = "merge-attempt:";
  let max = 0;
  for (const label of labels) {
    if (!label.startsWith(prefix)) continue;
    const tail = label.slice(prefix.length);
    if (tail.length === 0) continue;
    const n = parseInt(tail, 10);
    if (isNaN(n) || n < 0) continue;
    if (n > max) max = n;
  }
  return max;
}

/**
 * Decide what to do on an auto-merge conflict, given the current
 * `merge-attempt:N` count.
 *
 * Pure function — caller (runAutoMerge) does the I/O (label add/remove,
 * comment, Status rollback).
 *
 * Two outcomes:
 *
 *   - `shouldGiveUp: false` — bump the counter and skip this cycle.
 *     Caller writes `merge-attempt:<newCount>` and removes
 *     `merge-attempt:<previousCount>` (when previousCount > 0) to
 *     prevent counter accumulation.
 *   - `shouldGiveUp: true` — retries exhausted; caller falls through to
 *     the existing `handleMergeConflict` flow (error:merge-conflict
 *     label, triage comment, Status rollback to In Code Review).
 *
 * `maxAttempts` is the threshold AT which the dispatcher gives up (3 by
 * default). With currentCount=0 the next conflict bumps to 1 and retries
 * (1st attempt failed); at currentCount=2 the next conflict gives up
 * (3rd attempt failed = exhausted).
 */
export function decideMergeRetry(opts: {
  currentCount: number;
  maxAttempts: number;
}): { shouldGiveUp: boolean; newCount: number; previousCount: number } {
  const { currentCount, maxAttempts } = opts;
  const newCount = currentCount + 1;
  return {
    shouldGiveUp: newCount >= maxAttempts,
    newCount,
    previousCount: currentCount,
  };
}

// --------- Auto-advance rule lookup ---------

/**
 * Find the auto-advance rule that applies given the ticket's current
 * column and labels. Returns null if no rule matches.
 */
export function findAdvanceRule(
  rules: AdvanceRule[],
  fromColumn: string,
  labels: string[],
): AdvanceRule | null {
  return rules.find((r) => r.from === fromColumn && labels.includes(r.readyLabel)) ?? null;
}
