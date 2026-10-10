// Pipeline state machine: auto-advance, rework routing, done-cleanup,
// post-run label decisions, label predicates, rework-target extraction,
// rework-loop circuit breaker, advance-rule lookup.
//
// All pure: takes labels, columns, rule tables; returns decisions.
//
// Split from lib.ts on 2026-05-09. Imports `hasOpenBlockers` from blockers.ts
// (the only cross-file dependency in this file).

import { hasOpenBlockers } from "./blockers.js";
import { byTicketPriority } from "./ticket-priority.js";
import { MERGE_HANDOFF_LABEL } from "./merge-handoff.js";

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
      !isRetryWaiting(item.labels) &&
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
  /** Sub-issue parent chain from the board snapshot. Optional; defaults
   *  to "no parent" (the ticket is its own family root). Read by
   *  `resolveFamilyRoot` for the family circuit breaker. */
  parentNumber?: number | null;
  grandparentNumber?: number | null;
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
  /** Items in Backlog held because no seat is free
   *  (`seatsTaken >= maxConcurrent`); logged as 🛑 held. */
  backlogHeld: number[];
}

/**
 * Pure decision function for `runAutoAdvance`. Given the rule table, gate
 * set, current items in each `from` column, the number of seats taken
 * (runs in flight plus tickets past Backlog about to start, counted by
 * `runAutoAdvance`), and the concurrency cap, return the list of advances
 * to perform plus the diagnostic info the caller needs to log gate/hold
 * heartbeats.
 *
 * Semantics:
 *   - **Gated columns** (in MANUAL_ADVANCE_GATES): no advance even when
 *     `done:<agent>` is set. Eligible items are reported in `gatedAwaiting`
 *     for heartbeat logging.
 *   - **Backlog**: capacity = `max(0, maxConcurrent - seatsTaken)`.
 *     Advance the first `min(eligible.length, capacity)` items in priority
 *     order, preserving board position for ties; hold the rest in
 *     `backlogHeld`. When capacity is 0, all eligible Backlog items are held.
 *     The cap matches `selectDispatches`'s
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
 * Backlog priority labels override board order. Equal priorities retain the
 * input order from the board query, so top-of-column comes first for ties.
 */
export function decideAutoAdvance(
  rules: readonly AdvanceRule[],
  gates: ReadonlySet<string>,
  itemsByColumn: ReadonlyMap<string, readonly DecisionItem[]>,
  seatsTaken: number,
  maxConcurrent: number,
): AutoAdvanceDecision {
  const advances: AdvanceAction[] = [];
  const gatedAwaiting: { column: string; itemNumbers: number[] }[] = [];
  const backlogHeld: number[] = [];

  const isEligible = (item: DecisionItem, rule: AdvanceRule): boolean =>
    item.issueNumber > 0 &&
    item.labels.includes(rule.readyLabel) &&
    !item.labels.some(l => l.startsWith("needs-rework:") || l.startsWith("error:")) &&
    // Real-claude gate (belt to runRealClaudeGate). A ticket needing a
    // live-claude run must not auto-advance past code review until the gate
    // has actually RUN and its result has been READ. The 2026-07-22 failure
    // (pyrycode#1168) was not a missing human — it was a missing guard: the
    // suite skipped, a skip exits 0, and the code-review agent read that 0 as
    // a pass. Only an executed-test count can tell those apart, so nothing
    // advances until something has counted. Scoped to the code-review→
    // documentation boundary so the ticket still flows through the earlier
    // stages; it holds here, and the gate step parks it in Inbox for
    // `runRealClaudeGateExecution` to run.
    // This is the structural guarantee — it does not depend on the gate step
    // running, so removing or breaking that step cannot un-gate a ticket.
    !(rule.from === REAL_CLAUDE_GATE_FROM_COLUMN && item.labels.includes(REAL_CLAUDE_GATE_LABEL)) &&
    // A background gate run is still writing its verdict. A failure moves the
    // ticket to its rework column before adding the rework label, so for a
    // moment it reads as a finished stage with no rework pending. The running
    // label comes off last, after every verdict write.
    !item.labels.includes(REAL_CLAUDE_GATE_RUNNING_LABEL) &&
    !hasOpenBlockers(item.blockedBy ?? []);

  for (const rule of rules) {
    const all = itemsByColumn.get(rule.from) ?? [];
    const filtered = all.filter(item => isEligible(item, rule));
    const eligible = rule.from === "Backlog" ? byTicketPriority(filtered, item => item.labels) : filtered;

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
      // in priority order, then board-position order; hold the rest.
      // Capacity tracks free pipeline seats so PO refinements don't pile
      // up as `done:po`
      // tickets that can't enter the pipeline (the bug shape: with WIP=N
      // dispatch but a hardcoded WIP=1 advance, refined backlog tickets
      // got stranded one-per-cycle while the pipeline ran serially).
      const capacity = Math.max(0, maxConcurrent - seatsTaken);
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
  /** Set when the route is a wait on open blockers rather than a rework:
   *  the ticket stays in `fromColumn` and no rework is counted. Holds the
   *  open blocker numbers. Two shapes: a refinement bail from past Backlog
   *  strips only the trigger, and a route back to the ticket's own column
   *  (a builder parked on a blocker) strips the usual state labels too.
   *  See `decideReworkRoutes`. */
  waitingOn?: number[];
  /** Set when the route only sends the ticket to its code owner to finish a
   *  merge of the default branch (the ticket carries MERGE_HANDOFF_LABEL).
   *  The ticket moves as usual, but no rework is counted and the loop
   *  breaker is not consulted. See merge-handoff.ts. */
  mergeHandoff?: true;
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
 * A refinement bail from past Backlog on a ticket with an OPEN blocker is a
 * wait, not a rework. Dispatch never picks a blocked ticket, so the blocker
 * was added by the run that bailed: the file-overlap check found another
 * open branch editing the same files. Sending it to Backlog bought a
 * refinement run on a sound ticket and a rework count that walked it toward
 * the loop breaker (pyrycode-mobile #808, parked behind #803 and then #804
 * on 2026-09-22 and 2026-09-23). The route keeps the ticket in its column
 * and strips only the trigger. It holds no seat while blocked, and the same
 * agent picks it up when the blocker closes.
 *
 * A route back to the ticket's own column on a ticket with an OPEN blocker
 * is a wait too: the run that just linked the blocker parked itself there
 * (the Codex builder's `waiting_on_blocker` ending adds `needs-rework:builder`
 * in In Development). It strips the usual state labels like any same-column
 * route, but carries `waitingOn`, so the caller counts nothing.
 *
 * A route on a ticket carrying MERGE_HANDOFF_LABEL is a merge handoff: the
 * dispatcher's merge before a later stage conflicted and sent the ticket to
 * its code owner. Since 2026-10-02 the final merge from Done does the same
 * once its retries are spent, leaving the ticket in the last stage's column.
 * It moves like any rework and the marker is stripped with it, but it is
 * flagged so the caller counts nothing. Nothing was wrong with the ticket,
 * and main has to move again for the next conflict, so it cannot loop on its
 * own; the final merge also stops after FINAL_MERGE_HANDOFF_MAX routes.
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

      // An in-flight agent owns its ticket until it exits. Since 2026-09-22
      // routing runs while agents are still working (dispatch-pool.ts), so
      // a ticket carrying wip:<agent> waits for the next pass: the rework
      // label is still there then, and a dead run's stale wip is cleared
      // by the stranded-wip sweep after its age gate.
      if (item.labels.some((l) => l.startsWith("wip:"))) continue;

      // First valid rework label wins. Iterate in array order for
      // determinism — same order GitHub returns from the labels query.
      for (const label of item.labels) {
        const target = extractReworkTarget(label);
        if (target === null) continue;
        const targetColumn = agentColumnMap.get(target);
        if (!targetColumn) continue;

        const openBlockers = (item.blockedBy ?? [])
          .filter(b => b.state === "OPEN")
          .map(b => b.number);
        if (targetColumn === "Backlog" && fromColumn !== "Backlog" && openBlockers.length > 0) {
          routes.push({
            itemId: item.id,
            issueNumber: item.issueNumber,
            fromColumn,
            toColumn: fromColumn,
            triggerLabel: label,
            labelsToStrip: [label],
            waitingOn: openBlockers,
          });
          break;
        }

        const mergeHandoff = item.labels.includes(MERGE_HANDOFF_LABEL);
        const labelsToStrip = [
          label,
          ...item.labels.filter(l =>
            l !== label &&
            (l.startsWith("done:") || l.startsWith("wip:") || l.startsWith("error:") || l === MERGE_HANDOFF_LABEL),
          ),
        ];

        // A ticket sent back to the column it already sits in, while it has
        // an open blocker, is the run that just parked it on that blocker:
        // dispatch never picks a blocked ticket, so nothing else can have
        // added the label. The Codex builder's `waiting_on_blocker` ending
        // does exactly this (`needs-rework:builder` in In Development, plus
        // the blocked-by link). It routes as before, so done/wip/error state
        // is stripped and the ticket stays put, but it is a wait: no rework
        // is counted and the loop breaker is not consulted. Desktop #1738
        // and #1766 each gained a rework count this way on 2026-10-05 and
        // 2026-10-06 with no review failed.
        const selfWait = targetColumn === fromColumn && openBlockers.length > 0;

        routes.push({
          itemId: item.id,
          issueNumber: item.issueNumber,
          fromColumn,
          toColumn: targetColumn,
          triggerLabel: label,
          labelsToStrip,
          ...(mergeHandoff ? { mergeHandoff: true as const } : {}),
          ...(selfWait ? { waitingOn: openBlockers } : {}),
        });
        break; // first valid rework label wins
      }
    }
  }

  return routes;
}

/**
 * Label the dispatcher adds when a ticket carries a `needs-rework:<target>`
 * whose target is not an agent in the active stage set. The `error:` prefix
 * is what stops dispatch; the specific name says why.
 */
export const REWORK_TARGET_ERROR_LABEL = "error:rework-target";

/** A ticket whose rework labels all name agents this board does not run. */
export interface UnroutableRework {
  itemId: string;
  issueNumber: number;
  fromColumn: string;
  /** The rework labels that could not be routed, in label order. */
  labels: string[];
}

/**
 * Companion to `decideReworkRoutes`: the tickets it silently passed over.
 *
 * `decideReworkRoutes` skips a rework label whose target is not in the
 * agent map, which is right for a typo but wrong as the whole story. The
 * label stays on the ticket, nothing moves, and `shouldSkipDispatch` only
 * blocks the agent the label names — so the agent that APPLIED it runs
 * again on the next cycle. On 2026-09-06 a verifier on the builder set
 * applied `needs-rework:po`, a role that set does not have; the dispatcher
 * re-ran the verifier 27 seconds later and bumped the family counter for
 * nothing (pyrycode #2089). The honest translation of "route to an agent
 * that is not here" is "stop and tell a human", which is what the caller
 * does with these.
 *
 * Only tickets with NO routable rework label are returned: a ticket that
 * carries both a known and an unknown target routes on the known one,
 * exactly as `decideReworkRoutes` already does, and the unknown label is
 * stripped with the rest of the state trail.
 */
export function decideUnroutableRework(
  agentColumnMap: ReadonlyMap<string, string>,
  itemsByColumn: ReadonlyMap<string, readonly DecisionItem[]>,
): UnroutableRework[] {
  const out: UnroutableRework[] = [];
  for (const [fromColumn, items] of itemsByColumn) {
    for (const item of items) {
      if (item.issueNumber <= 0) continue;
      const unknown: string[] = [];
      let routable = false;
      for (const label of item.labels) {
        const target = extractReworkTarget(label);
        if (target === null) continue;
        if (agentColumnMap.has(target)) { routable = true; break; }
        unknown.push(label);
      }
      if (routable || unknown.length === 0) continue;
      out.push({ itemId: item.id, issueNumber: item.issueNumber, fromColumn, labels: unknown });
    }
  }
  return out;
}

// --------- Real-claude operator gate ---------

/**
 * Label marking a ticket whose acceptance requires a live run against real
 * claude, rather than the fakes the rest of the pipeline uses.
 *
 * **What actually went wrong on 2026-07-22, and what did not.** The failure
 * (pyrycode PR #1169 / #1168) was that the real-claude suite SKIPPED, a skip
 * exits 0, and the code-review agent read that 0 as a pass — so an unverified
 * permission-path change shipped and the gate was still red after merge. The
 * missing thing was a guard that counts executed tests. It was NOT a missing
 * human.
 *
 * **The "no login token here" premise was never measured, and it is false.**
 * Commit `affd97b` (2026-07-22) asserted in four places that the dispatch
 * environment has no Claude credential, so the suite could only skip. Nothing
 * in the dispatcher ever probed for one. Measured 2026-08-07 on the same
 * machine: the fork's `.env` supplies `CLAUDE_CODE_OAUTH_TOKEN`,
 * `SPAWN_ENV_DENYLIST` does not strip it, and the real skip guard
 * (`WithWorktreeAuthenticated`, pyrycode `internal/e2e/realclaude/fixtures.go`)
 * wants exactly that variable plus a readable `~/.claude.json`. Both hold. A
 * full suite run from this machine that day: exit 0, 308.022s, 176 passed,
 * 0 failed, 14 skipped, every skip deliberate.
 *
 * So the dispatcher runs the gate itself. A ticket carrying this label is held
 * at the code-review→documentation boundary (the structural belt lives in
 * `decideAutoAdvance`'s eligibility check), parked in Inbox by
 * `runRealClaudeGate`, and executed there by `runRealClaudeGateExecution`. A
 * pass advances it and clears the label; a failure routes it back to the
 * developer with the label KEPT, so it must re-gate after the fix; an
 * environment problem parks it under `error:real-claude-gate` and pings
 * Discord. Recognition is soft (the PO applies the label during refinement,
 * per po/CLAUDE.md); enforcement is hard (this label, once present, cannot
 * auto-advance).
 *
 * With `PYRY_REAL_CLAUDE_GATE_CMD` unset the execution step is a strict no-op
 * and the park-for-operator behaviour is exactly what it was.
 */
export const REAL_CLAUDE_GATE_LABEL = "needs-real-claude";
/** Visible only while the dispatcher is executing the live suite. */
export const REAL_CLAUDE_GATE_RUNNING_LABEL = "wip:real-claude-gate";

/**
 * The column the gate fires from: the last stage before Done that the
 * dispatcher can itself complete. Parking a ticket here means every
 * machine-checkable stage (architecture, dev, QA, code review) is done and
 * only the live-claude run remains. Firing at exactly one boundary means a
 * gated ticket flows normally through the earlier stages and stops once.
 */
export const REAL_CLAUDE_GATE_FROM_COLUMN = "In Code Review";

/**
 * Where gated tickets are parked. Reuses the existing "needs a live claude or
 * an operator" holding column, which no agent runs on, so the ticket is fully
 * out of the pipeline until an operator acts.
 */
export const REAL_CLAUDE_GATE_TO_COLUMN = "Inbox";

/** A single park-to-Inbox move for a real-claude-gated ticket. */
export interface RealClaudeGateRoute {
  itemId: string;
  issueNumber: number;
  fromColumn: string;
  toColumn: string;
}

/**
 * Pure decision for `runRealClaudeGate`. A ticket in `In Code Review` that has
 * finished review AND carries `needs-real-claude` is routed to Inbox.
 *
 * `reviewDoneLabel` is the stage set's final pre-documentation review
 * signal — `done:code-review` in classic (the default, so existing callers
 * and tests are byte-identical), `done:verifier` in the builder set; the
 * caller passes `activeStageSet().realClaudeGate.reviewDoneLabel`.
 *
 * Requiring the review done label ensures the machine-checkable review
 * completed before parking (a mid-review ticket has no such label, so it is
 * left alone), and lets a real review failure (the set's rework label) take
 * precedence via the rework router — that ticket never gets the done label.
 * Firing only from `In Code Review` means once a ticket is parked in Inbox
 * it is out of the scan set: no loop, and the operator-instruction comment
 * posts exactly once.
 *
 * Pure over already-collected items; the caller does the I/O.
 */
export function decideRealClaudeGate(
  itemsByColumn: ReadonlyMap<string, readonly DecisionItem[]>,
  reviewDoneLabel = "done:code-review",
): RealClaudeGateRoute[] {
  const routes: RealClaudeGateRoute[] = [];
  const items = itemsByColumn.get(REAL_CLAUDE_GATE_FROM_COLUMN) ?? [];
  for (const item of items) {
    if (item.issueNumber <= 0) continue;
    if (!item.labels.includes(reviewDoneLabel)) continue;
    if (!item.labels.includes(REAL_CLAUDE_GATE_LABEL)) continue;
    routes.push({
      itemId: item.id,
      issueNumber: item.issueNumber,
      fromColumn: REAL_CLAUDE_GATE_FROM_COLUMN,
      toColumn: REAL_CLAUDE_GATE_TO_COLUMN,
    });
  }
  return routes;
}

// --------- Dispatcher-executed real-claude gate ---------

/**
 * Parked gated tickets wait here, and this is where the execution step
 * looks for its next candidate. Same column `runRealClaudeGate` parks
 * into, so a ticket that finishes code review this cycle is parked and
 * then gated in the same cycle.
 */
export const REAL_CLAUDE_GATE_RUN_FROM_COLUMN = REAL_CLAUDE_GATE_TO_COLUMN;

/** Where a passing ticket lands: the normal next stage after code review. */
export const REAL_CLAUDE_GATE_PASS_COLUMN = "In Documentation";

/** Where a failing ticket lands: back to the developer agent. */
export const REAL_CLAUDE_GATE_FAIL_COLUMN = "In Development";

/**
 * Applied when the gate could not produce a trustworthy answer — the run
 * errored, timed out, wrote an unreadable artifact, or executed too few
 * tests to mean anything.
 *
 * The `error:` prefix is load-bearing rather than cosmetic. It already
 * excludes a ticket from the work-in-progress count (`countPipelineInFlight`)
 * and from gate re-selection (`decideRealClaudeGateRun`), so a ticket that
 * parks this way stops consuming pipeline capacity and never re-runs the
 * gate on a loop. The mechanism is self-limiting without any extra counter.
 */
export const REAL_CLAUDE_GATE_ERROR_LABEL = "error:real-claude-gate";

/** The label a failed gate adds in the CLASSIC set, routing the ticket
 *  back to the developer. Default for `decideGateOutcome`; other stage
 *  sets pass their own (`activeStageSet().realClaudeGate.failReworkLabel`,
 *  e.g. builder's `needs-rework:builder`). */
export const REAL_CLAUDE_GATE_REWORK_LABEL = "needs-rework:developer";

/** The one ticket the dispatcher will gate this cycle. */
export interface RealClaudeGateRunCandidate {
  itemId: string;
  issueNumber: number;
}

/**
 * Pick at most ONE parked ticket to gate this cycle.
 *
 * One, not all: a real-claude suite is minutes of wall clock (308s measured
 * on pyrycode, 2026-08-07) and the dispatcher is single-threaded at the
 * top of its cycle. Gating two tickets back-to-back would stall ticket
 * selection for the sum of both, and the chain drains just as fast one per
 * cycle because each pass unblocks the next ticket's build anyway.
 *
 * Eligibility mirrors the rest of the pipeline: review finished (the stage
 * set's review done label — classic default `done:code-review`), the gate
 * is wanted (`needs-real-claude`), nothing is
 * already wrong (`error:*`), no rework is pending (`needs-rework:*`), no run
 * is marked active (`wip:*`), and no blocker is open. Excluding `error:*`
 * stops a ticket the gate already parked from being re-selected forever.
 *
 * Input order is the board's own ordering (`POSITION` ascending), which is
 * the user's prioritisation signal. First eligible wins; don't re-sort.
 */
export function decideRealClaudeGateRun(
  items: readonly DecisionItem[],
  reviewDoneLabel = "done:code-review",
): RealClaudeGateRunCandidate | null {
  for (const item of items) {
    if (item.issueNumber <= 0) continue;
    if (!item.labels.includes(reviewDoneLabel)) continue;
    if (!item.labels.includes(REAL_CLAUDE_GATE_LABEL)) continue;
    if (item.labels.some(l => l.startsWith("error:") || l.startsWith("needs-rework:") || l.startsWith("wip:"))) continue;
    if (hasOpenBlockers(item.blockedBy ?? [])) continue;
    return { itemId: item.id, issueNumber: item.issueNumber };
  }
  return null;
}

/** The things a gate run can mean. */
export type GateVerdict =
  /** The suite ran, enough of it executed, and none of it failed. */
  | "pass"
  /**
   * Every failure passed when re-run on the same merged tree, so the suite
   * is green and the failures were nondeterministic. Advances like a pass,
   * but pings a human so the flaky tests get looked at rather than buried.
   */
  | "flaky-pass"
  /** Real test failures, or a suite-level failure like a build error. */
  | "fail"
  /** The suite ran but verified (almost) nothing — the 2026-07-22 shape. */
  | "zero-executed"
  /** No trustworthy answer: run error, timeout, or unreadable artifact. */
  | "unusable"
  /**
   * Real failures, but every one of them also fails on the base commit, so
   * the branch introduced none of them. Not a pass, because the suite is
   * genuinely red; not the branch's fault either.
   */
  | "inherited-failure";

/** Everything `decideGateVerdict` is allowed to look at. */
export interface GateVerdictInput {
  /** Non-null when the run could not be started or completed at all. */
  runError: string | null;
  /** True when the outer wall clock fired. */
  timedOut: boolean;
  /** Parsed artifact. Null when no artifact could be read from disk. */
  tally: GateTallyLike | null;
  /** The command's exit status. Null when it never produced one. */
  exitCode: number | null;
  /** Floor for the executed-test guard. Clamped to at least 1. */
  minExecuted: number;
}

/**
 * The slice of `GateTally` the verdict depends on. Declared structurally so
 * pipeline-decisions.ts stays free of a runtime import on the parser — this
 * file is the pure decision layer and has no business knowing how a Go test
 * event is shaped.
 */
export interface GateTallyLike {
  executed: number;
  failed: number;
  packageFailed: boolean;
  recognizedLines: number;
  /**
   * Tests still running when the test binary's OWN deadline fired, as
   * opposed to the outer wall clock in `timedOut`. Optional because only
   * the Go parser produces it.
   */
  timedOutTests?: readonly string[];
  /** The deadline the binary reported, e.g. `20m0s`, when it fired. */
  timedOutBudget?: string;
  /** How long each killed test had been running when the deadline fired. */
  timedOutRunningFor?: Readonly<Record<string, string>>;
}

export interface GateVerdictDecision {
  verdict: GateVerdict;
  /** One line, suitable for a log and for the evidence comment. */
  reason: string;
}

/**
 * Turn one gate run into a verdict. This function IS the safety property;
 * everything else around it is plumbing.
 *
 * **The invariant: a zero exit code never upgrades anything.** The exit
 * status is consulted at exactly one point, step 7, and only to make a
 * verdict WORSE. It can never turn a non-pass into a pass, because every
 * check that could reject has already run by then. That ordering is the
 * exact inversion of the 2026-07-22 failure, where a 0 was read first and
 * treated as sufficient. `lib.test.ts` pins it with a table-driven test
 * over every input shape.
 *
 * Strict evaluation order, worst evidence first:
 *
 *   1. **Run error** — the command never really ran. Nothing to judge.
 *   2. **Timeout** — the run was cut off mid-flight, so the artifact is a
 *      prefix of the truth, not the truth. A prefix with no failures in it
 *      is not a pass.
 *   3. **Unreadable artifact** — zero recognisable events. "Nothing to
 *      judge" and "nothing failed" look identical to an exit code and must
 *      never look identical here.
 *   4. **The test binary's own deadline** — `go test -timeout` fired with
 *      tests still running. The suite outran its budget; the test holding
 *      the floor when the alarm went off is not the regression, and every
 *      parallel test parked behind it never ran at all. Unusable like the
 *      outer timeout, and checked BEFORE failures because the parser counts
 *      the killed test as a failure. On 2026-09-09 pyrycode #2279 spent a
 *      rework leg on a 361-second test its diff never touched, because a
 *      base re-run of that test alone had the whole budget and passed.
 *   5. **Any failure** — a failed test, or a suite-level failure with no
 *      test to attribute it to (a build error or panic).
 *   6. **Below the executed floor** — the suite ran and verified nothing.
 *      This is the check the whole mechanism exists for.
 *   7. **Non-zero exit with a clean artifact** — the belt. The report says
 *      green and the process says red, so the two disagree and neither can
 *      be trusted. Unusable rather than fail: there is no failing test to
 *      hand a developer, and sending one a contradiction burns rework
 *      cycles it cannot resolve.
 *   8. Otherwise: pass.
 */
export function decideGateVerdict(input: GateVerdictInput): GateVerdictDecision {
  if (input.runError) {
    return { verdict: "unusable", reason: `gate run failed to complete: ${input.runError}` };
  }

  if (input.timedOut) {
    return {
      verdict: "unusable",
      reason: "gate run hit the outer wall-clock timeout; the artifact is a truncated prefix, not a result",
    };
  }

  const tally = input.tally;
  if (tally === null || tally.recognizedLines <= 0) {
    return {
      verdict: "unusable",
      reason:
        "no readable test events in the gate output — nothing was judged, which is not the same as nothing failing " +
        "(does the command emit machine-readable per-test output, e.g. `go test -json`?)",
    };
  }

  const timedOutTests = tally.timedOutTests ?? [];
  if (timedOutTests.length > 0) {
    const runningFor = tally.timedOutRunningFor ?? {};
    const named = timedOutTests
      .slice(0, 5)
      .map(name => (runningFor[name] ? `${name} (running for ${runningFor[name]})` : name))
      .join(", ");
    const more = timedOutTests.length > 5 ? `, and ${timedOutTests.length - 5} more` : "";
    const budget = tally.timedOutBudget ? `${tally.timedOutBudget} ` : "";
    return {
      verdict: "unusable",
      reason:
        `the test binary's own ${budget}deadline fired with ${timedOutTests.length} test(s) still running: ` +
        `${named}${more}. The suite has outrun its budget, so this is not a regression in the test that ` +
        "happened to be running, and every test parked behind it never ran. Raise the budget or shorten the suite",
    };
  }

  if (tally.failed > 0 || tally.packageFailed) {
    const detail = tally.failed > 0
      ? `${tally.failed} test(s) failed`
      : "a suite-level failure with no failing test (build error, panic, or harness crash)";
    return { verdict: "fail", reason: detail };
  }

  // A floor of 0 would disable the guard this whole file exists for, so a
  // misconfigured fork gets 1 rather than an unguarded gate.
  const floor = Math.max(1, input.minExecuted);
  if (tally.executed < floor) {
    return {
      verdict: "zero-executed",
      reason:
        `only ${tally.executed} test(s) actually executed, below the floor of ${floor}. ` +
        "A suite that skips everything still exits 0; that is exactly the false green this gate exists to catch",
    };
  }

  if (input.exitCode !== 0) {
    return {
      verdict: "unusable",
      reason:
        `the test report is clean but the command exited ${input.exitCode ?? "with no status"}. ` +
        "Report and process disagree, so neither is trustworthy",
    };
  }

  return { verdict: "pass", reason: `${tally.executed} test(s) executed, none failed` };
}

/** What a baseline comparison concluded about a branch's failures. */
export interface BaselineAdjustedVerdict {
  verdict: GateVerdict;
  reason: string;
  /** Failures the branch introduced: red here, green on the base. */
  introduced: string[];
  /** Failures the branch inherited: red both ways. */
  preExisting: string[];
  /** Failures that passed when re-run on the same merged tree: flaky. */
  flaky: string[];
}

/**
 * Re-judge a failing run against what the base commit already fails.
 *
 * **Why this exists.** On the gate's first live run, 2026-08-07, pyrycode
 * #1382 came back with 519 passed and 2 failed. Both failures reproduced
 * identically on clean `main`, and neither touched the ticket's subject.
 * The baseline makes that attribution visible even when the red test run
 * routes to rework. It prevents the issue evidence from blaming the branch
 * for failures it inherited.
 *
 * Kept separate from `decideGateVerdict` rather than folded into it, so
 * that function stays a judgement about one run and its ordering invariant
 * stays easy to state and to test. This one only ever runs after it, and
 * only on a failure.
 *
 * **A missing baseline is not an exoneration.** When `baselineFailures` is
 * null nothing was compared, so the verdict is left alone at `fail`. Null
 * and empty must not collapse: empty means the baseline ran and every
 * failure is new, null means nothing is known. Treating unknown as
 * pre-existing would let a genuine regression park quietly as somebody
 * else's problem, which is a worse failure than the one this fixes.
 *
 * **The same-tree re-run comes first, and a missing re-run excuses nothing
 * either.** A base comparison answers "did this branch break it?" and a
 * flake answers "yes" to that by accident: it fails on the branch, passes
 * on the base, and reads as a regression. On 2026-09-06 pyrycode #2089, a
 * finished ticket with a fifth-pass review PASS, was routed to rework and
 * tripped the three-strike breaker over a liveness test its diff never
 * reaches, which had passed the previous nineteen gate runs and passed
 * three of three by hand minutes later. So before the base is consulted,
 * every named failure is re-run on the same merged tree. A failure that
 * passes there is set aside as flaky; only the ones that fail again are
 * compared against the base. When every failure was flaky the verdict is
 * `flaky-pass`, which advances like a pass and pings a human. Null
 * `rerunFailures` means nothing was re-run, and every failure stays on
 * the hook exactly as before.
 */
export function decideBaselineAdjustedVerdict(opts: {
  verdict: GateVerdict;
  /** Failing test names from the branch run, package-qualified. */
  branchFailures: readonly string[];
  /** Failing names from the base re-run, or null when none ran. */
  baselineFailures: readonly string[] | null;
  /**
   * Names that failed AGAIN when re-run on the merged tree, or null when no
   * re-run happened. Optional so a caller with no re-run stage behaves
   * exactly as before.
   */
  rerunFailures?: readonly string[] | null;
  reason: string;
}): BaselineAdjustedVerdict {
  // Only a failure has anything to compare. Every other verdict is about
  // whether the run is trustworthy at all, which a baseline cannot change.
  if (opts.verdict !== "fail") {
    return { verdict: opts.verdict, reason: opts.reason, introduced: [], preExisting: [], flaky: [] };
  }

  const rerunSet = opts.rerunFailures == null ? null : new Set(opts.rerunFailures);
  const flaky = rerunSet === null ? [] : opts.branchFailures.filter(name => !rerunSet.has(name));
  const persistent = rerunSet === null ? [...opts.branchFailures] : opts.branchFailures.filter(name => rerunSet.has(name));

  if (rerunSet !== null && opts.branchFailures.length > 0 && persistent.length === 0) {
    return {
      verdict: "flaky-pass",
      reason:
        `${flaky.length} test(s) failed once and passed when re-run on the same merged tree, ` +
        `so the failure is nondeterministic rather than this branch's`,
      introduced: [],
      preExisting: [],
      flaky,
    };
  }

  const flakyNote = flaky.length > 0
    ? `; ${flaky.length} other(s) passed on re-run and are set aside as flaky`
    : "";

  if (opts.baselineFailures === null) {
    return {
      verdict: "fail",
      reason: `${opts.reason}; no base comparison was available, so the failures are treated as this branch's${flakyNote}`,
      introduced: persistent,
      preExisting: [],
      flaky,
    };
  }

  const baseSet = new Set(opts.baselineFailures);
  const introduced = persistent.filter(name => !baseSet.has(name));
  const preExisting = persistent.filter(name => baseSet.has(name));

  // A package-level failure with no named failing test cannot be attributed
  // either way, so it keeps the branch on the hook.
  if (introduced.length === 0 && persistent.length > 0) {
    return {
      verdict: "inherited-failure",
      reason:
        `${preExisting.length} test(s) failed, and every one of them fails on the base commit too, ` +
        `so this branch introduced none of them${flakyNote}`,
      introduced,
      preExisting,
      flaky,
    };
  }

  return {
    verdict: "fail",
    reason: (preExisting.length > 0
      ? `${introduced.length} test(s) failed that pass on the base commit, plus ${preExisting.length} already failing there`
      : opts.reason) + flakyNote,
    introduced,
    preExisting,
    flaky,
  };
}

/** Board actions for one gate verdict. */
export interface GateOutcome {
  /** Target column, or null to leave the ticket where it is. */
  toColumn: string | null;
  addLabels: string[];
  removeLabels: string[];
  /** Whether this outcome deserves a Discord ping. */
  notify: boolean;
}

/**
 * Map a verdict onto board actions.
 *
 *   pass          → In Documentation, clear `needs-real-claude`
 *   flaky-pass    → the same, plus a Discord ping naming the flaky tests
 *   fail          → In Development, add the set's fail rework label (classic: `needs-rework:developer`)
 *   inherited-failure → stays at the live gate behind separate fix-ticket blockers
 *   zero-executed → stays in Inbox, add `error:real-claude-gate`, notify
 *   unusable      → stays in Inbox, add `error:real-claude-gate`, notify
 *
 * **A failure deliberately KEEPS `needs-real-claude`.** The ticket must
 * re-gate once the developer fixes it; dropping the label would let the
 * fix walk to Done having proved nothing. Stripping the stale `done:*`
 * trail is left to `runReworkRouting`, which already owns that job the
 * moment the card lands in In Development — and which brings the existing
 * three-strike rework breaker along with it, so a ticket that cannot be
 * fixed halts instead of looping.
 *
 * **Environment problems park rather than route.** This is a deliberate
 * deviation from "route failures back to the pipeline", which is the right
 * rule for genuine test failures and the wrong one here: a developer agent
 * handed a missing credential or a timed-out suite cannot fix it, and would
 * burn all three rework spawns discovering that. Parking under an `error:`
 * label is self-limiting, and no path here reads as green.
 */
export function decideGateOutcome(
  verdict: GateVerdict,
  /** The stage set's rework label for a genuine failure — classic default
   *  `needs-rework:developer`; builder passes `needs-rework:builder`. */
  failReworkLabel: string = REAL_CLAUDE_GATE_REWORK_LABEL,
): GateOutcome {
  switch (verdict) {
    case "pass":
      return {
        toColumn: REAL_CLAUDE_GATE_PASS_COLUMN,
        addLabels: [],
        removeLabels: [REAL_CLAUDE_GATE_LABEL],
        notify: false,
      };
    case "flaky-pass":
      // Same board actions as a pass: the suite is green on re-run and the
      // ticket did nothing wrong. The ping is for the suite, not the ticket.
      return {
        toColumn: REAL_CLAUDE_GATE_PASS_COLUMN,
        addLabels: [],
        removeLabels: [REAL_CLAUDE_GATE_LABEL],
        notify: true,
      };
    case "fail":
      return {
        toColumn: REAL_CLAUDE_GATE_FAIL_COLUMN,
        addLabels: [failReworkLabel],
        removeLabels: [],
        notify: false,
      };
    case "inherited-failure":
      // Reconciliation creates and confirms the fix-ticket blockers first.
      // The next live run waits for them to close, without a rework route.
      return { toColumn: null, addLabels: [], removeLabels: [], notify: true };
    case "zero-executed":
    case "unusable":
      return {
        toColumn: null,
        addLabels: [REAL_CLAUDE_GATE_ERROR_LABEL],
        removeLabels: [],
        notify: true,
      };
  }
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
 *   - any `rework-count:N` or `rework-other:N` label (counters — reset so
 *     a re-opened ticket starts fresh rather than carrying stale rounds
 *     toward the loop cap)
 *   - any `family-dispatches:N` convenience counter (the durable family
 *     tally lives in the root's marker comments, so the board copy can
 *     go; a family whose root reaches Done and later re-opens should not
 *     wear a stale badge)
 *
 * Does NOT touch:
 *   - `size:`, `priority:`, `merged`, or any free-form tag
 *   - `error:family-breaker` specifically, despite its `error:` prefix —
 *     it is the family circuit breaker's park switch on the (often
 *     closed, Done-column) family root, not a stale trail. Stripping it
 *     here would erase the operator's board signal every cycle while the
 *     breaker re-vetoes on the comment tally anyway. Only the operator
 *     removes it.
 *   - the `merged` label specifically — its semantic is "PR was merged,"
 *     set only by the auto-merge path; reaching Done some other way
 *     shouldn't grant it
 *   - any `merge-attempt:N` counter. It counts auto-merge conflicts
 *     across cycles while the ticket sits in Done, and this pass runs
 *     before the auto-merge in every cycle. Stripping it here reset the
 *     count to zero each cycle, so the retry never reached its give-up
 *     threshold: mobile #878 retried a conflicting PR every two minutes
 *     for over 30 hours (2026-09-23 to 09-25). The auto-merge path
 *     clears the counter itself, on merge and on give-up.
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
      l => l !== FAMILY_BREAKER_LABEL
        && (isPipelineLabel(l)
          || l.startsWith("rework-count:")
          || l.startsWith(REWORK_OTHER_PREFIX)
          || l.startsWith(ERROR_RETRY_COUNT_PREFIX)
          || l.startsWith(FAMILY_DISPATCH_COUNT_PREFIX)),
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

// --------- Stranded `wip:` sweep ---------

/**
 * Hidden marker the sweep posts the FIRST time it sees a `wip:<agent>` on a
 * ticket outside Done. Its createdAt is the clock the age gate reads. An
 * HTML comment renders invisibly in GitHub's Markdown, same as the
 * auto-retry and family-dispatch markers.
 */
export const STRANDED_WIP_OBSERVED_MARKER = "<!-- pyry-stranded-wip-observed -->";

/**
 * Hidden marker the sweep posts AFTER it strips a stranded `wip:`.
 *
 * This is the piece that makes the sweep safe to run forever. Without it,
 * the observed marker from an old incident stays the newest one on the
 * ticket for good — so the ticket's NEXT legitimate dispatch would be seen
 * with a `wip:` label and an observation hours old, and the sweep would
 * strip the label off a live agent within one poll. The swept marker
 * invalidates the observation that caused it: whenever the newest swept
 * marker is newer than the newest observed one, the sweep re-observes from
 * scratch instead of stripping.
 */
export const STRANDED_WIP_SWEPT_MARKER = "<!-- pyry-stranded-wip-swept -->";

/**
 * Safety margin added on top of the longest possible agent run when
 * deriving the sweep's age gate. Covers pre-spawn gates, worktree setup and
 * the post-run GitHub writes — everything inside a dispatch that isn't the
 * agent's own wall-clock budget.
 */
export const STRANDED_WIP_MARGIN_MS = 30 * 60_000;

/** The two marker timestamps the sweep reads, newest of each kind. */
export interface StrandedWipMarkers {
  observedAt: Date | null;
  sweptAt: Date | null;
}

/** What the sweep should do about one ticket carrying a `wip:` label. */
export type StrandedWipAction =
  | { kind: "mark"; issueNumber: number }
  | { kind: "strip"; issueNumber: number; labelsToStrip: string[] }
  | { kind: "hold"; issueNumber: number; msRemaining: number };

/**
 * Tickets the sweep must consider: anything outside the Done column that
 * carries a `wip:<agent>` label.
 *
 * Split out from `decideStrandedWip` so the caller pays for one comments
 * fetch per CANDIDATE rather than one per board item. On a healthy board
 * this returns nothing at all.
 *
 * `inFlight` is the set of runs this process has going, keyed
 * `<agent>#<issue>` (dispatch-pool.ts). Until 2026-09-22 the sweep ran only
 * between awaited batches, so any `wip:` on the board was by construction
 * a label with no dispatch behind it. With the dispatch pool the sweep runs
 * while agents work, and on Mobile's first pooled cycle it started its
 * clock on both in-flight tickets, posting an observation comment on each.
 * A stale observation can later authorise stripping a live run's label on
 * the same ticket, so a ticket whose `wip:` belongs to a run in flight is
 * never a candidate.
 *
 * Done is excluded because `decideDoneCleanup` already strips `wip:` there,
 * and closed-but-stranded tickets reach Done via the closed sweep first.
 * Items with `issueNumber <= 0` (epics, virtual items) are skipped, same as
 * `decideDoneCleanup` and `decideReworkRoutes`.
 */
export function selectStrandedWipCandidates(
  items: readonly (DecisionItem & { status?: string })[],
  inFlight: ReadonlySet<string> = new Set(),
): { issueNumber: number; wipLabels: string[] }[] {
  const out: { issueNumber: number; wipLabels: string[] }[] = [];
  for (const item of items) {
    if (item.issueNumber <= 0) continue;
    if (item.status === "Done") continue;
    const wipLabels = item.labels.filter((l) => l.startsWith("wip:"));
    if (wipLabels.length === 0) continue;
    const running = wipLabels.some((l) => inFlight.has(`${l.slice("wip:".length)}#${item.issueNumber}`));
    if (running) continue;
    out.push({ issueNumber: item.issueNumber, wipLabels });
  }
  return out;
}

/**
 * Pure age gate for one stranded-`wip:` candidate.
 *
 * A `wip:<agent>` label on the board at the top of a poll cycle means no
 * dispatch in THIS process is running it — but it does not prove no agent
 * anywhere is. A dispatcher killed with SIGKILL leaves detached `claude`
 * grandchildren still writing into the ticket's worktree, and stripping the
 * label under them would let a second run start and `git worktree remove
 * --force` the directory the first one is working in. So the sweep waits
 * out the longest a legitimate run could still be going before it decides
 * the label is dead. `minAgeMs` is derived from the configured agent
 * timeouts rather than hardcoded, so raising a timeout cannot silently make
 * this gate too short.
 *
 * Returns null when the ticket carries no `wip:` label at all.
 */
export function decideStrandedWip(opts: {
  issueNumber: number;
  wipLabels: string[];
  markers: StrandedWipMarkers;
  minAgeMs: number;
  now: number;
}): StrandedWipAction | null {
  const { issueNumber, wipLabels, markers, minAgeMs, now } = opts;
  if (wipLabels.length === 0) return null;

  const observed = markers.observedAt?.getTime() ?? null;
  const swept = markers.sweptAt?.getTime() ?? null;

  // No observation yet, or the newest one has already been acted on (its
  // strip posted a swept marker after it). Either way this `wip:` label is
  // newly seen as far as the sweep is concerned — start its clock.
  if (observed === null || (swept !== null && swept >= observed)) {
    return { kind: "mark", issueNumber };
  }

  const elapsed = now - observed;
  if (elapsed >= minAgeMs) {
    return { kind: "strip", issueNumber, labelsToStrip: [...wipLabels] };
  }
  return { kind: "hold", issueNumber, msRemaining: minAgeMs - elapsed };
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

/** One deferred post-run decision, finished against a known column. */
export interface PendingDoneFinalization {
  issueNumber: number;
  agentName: string;
  /** The `pending-done:<agent>` label to remove in every outcome. */
  pendingLabel: string;
  /** True when the ticket is still in the agent's column with no rework
   *  label: add `done:<agent>` exactly as a normal post-run would. */
  addReadyLabel: boolean;
  priorReadyLabelsToStrip: string[];
  logKind: PostRunLabelDecision["logKind"];
}

/**
 * Finish the post-run decisions that `handlePostRun` had to defer.
 *
 * A successful run whose post-run column read failed gets
 * `pending-done:<agent>` instead of `done:<agent>` (2026-09-22: a GraphQL
 * rate limit left #796, #803 and #807 with neither label, so the next
 * cycle would have re-run a builder on each finished branch). The pending
 * label blocks re-dispatch through `shouldSkipDispatch`, and this decision
 * runs on the next board read, where every item's column is known.
 *
 * It is `decidePostRunLabels` with that column filled in: still in the
 * agent's column and no rework label → ready; moved out → drop the pending
 * label only; a rework label → drop it and leave routing to
 * `runReworkRouting`. Labels for agents the stage set does not know are
 * ignored. Pure; the caller applies the side effects.
 */
export function decidePendingDoneFinalizations(
  items: ReadonlyArray<{ issueNumber: number; status: string | null; labels: readonly string[] }>,
  columnByAgent: ReadonlyMap<string, string>,
): PendingDoneFinalization[] {
  const out: PendingDoneFinalization[] = [];
  for (const item of items) {
    for (const label of item.labels) {
      if (!label.startsWith(PENDING_DONE_PREFIX)) continue;
      const agentName = label.slice(PENDING_DONE_PREFIX.length);
      const agentColumn = columnByAgent.get(agentName);
      if (agentColumn === undefined) continue;
      const decision = decidePostRunLabels({
        postLabels: item.labels.filter((l) => l !== label),
        agentName,
        agentColumn,
        currentColumn: item.status,
      });
      out.push({
        issueNumber: item.issueNumber,
        agentName,
        pendingLabel: label,
        addReadyLabel: decision.addReadyLabel,
        priorReadyLabelsToStrip: decision.priorReadyLabelsToStrip,
        logKind: decision.logKind,
      });
    }
  }
  return out;
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

// --------- Family circuit breaker (agent-dispatcher family-breaker) ---------
//
// A runaway ticket FAMILY — a split lineage where agents keep splitting,
// reworking, and re-splitting — can consume agent runs far past what any
// single-ticket breaker sees. A recursive-split spiral once burned ~213$
// overnight across 11 descendant tickets; each individual ticket looked
// healthy, so neither the rework-loop breaker nor the transient-retry cap
// could trip. The family breaker counts DISPATCHES per family and parks
// the whole lineage on the board once the tally crosses a limit.
//
// State is board-encoded, on the family ROOT issue, copying the durable
// pattern of the transient-retry system:
//
//   - tally         -> count of marker comments (FAMILY_DISPATCH_COMMENT_MARKER)
//                      on the root; one is posted per dispatch of any family
//                      member. Comments are durable; labels can fail to
//                      write silently (the transient-retry code learned this).
//   - convenience   -> `family-dispatches:N` label on the root, rewritten
//                      from the comment tally each dispatch. Cosmetic; the
//                      comments win whenever the two disagree.
//   - park switch   -> `error:family-breaker` label on the root. Vetoes the
//                      root directly (GLOBAL_BLOCK_LABELS) and every
//                      descendant through the parent chain on the snapshot
//                      (shouldSkipDispatch's rootLabels arm).
//   - reset         -> a comment containing FAMILY_DISPATCH_RESET_MARKER on
//                      the root zeroes the tally: only markers posted after
//                      the LATEST reset count, and the trip-comment dedupe
//                      also looks only past it, so a resumed family that
//                      runs away again explains itself again
//                      (tallyFamilyComments).
//
// The root is resolved WITHOUT walking descendants: the PO's split-depth
// cap keeps chains at most 3 deep, so `grandparentNumber ?? parentNumber
// ?? own number` (two levels of parent on the board snapshot) is exact.
// Anchoring the counter on the root means the tally survives children
// closing.
//
// The breaker only filters DISPATCH candidates and marks the root. It
// never blocks the real-claude gate, auto-merge, the closed sweep, or
// rework routing, and a ticket mid-run when the family trips finishes
// normally. To resume ONE parked family: post a comment containing the
// reset marker on the root (zeroes that family's tally), then remove
// `error:family-breaker`. Raising PYRY_FAMILY_DISPATCH_LIMIT is the
// global fallback — it raises the budget for every family at once. The
// marker comments persist harmlessly as the family's audit trail.

/** Park switch on the family root. The `error:` prefix is load-bearing:
 *  it already excludes the root from the WIP count and blocks its own
 *  dispatch via GLOBAL_BLOCK_LABELS. No agent is named `family-breaker`,
 *  so `isPipelineLabelForAgent` never strips it, and `decideDoneCleanup`
 *  explicitly preserves it (a split family's root sits closed in Done
 *  while its descendants dispatch — stripping there would erase the
 *  operator's board signal every cycle). */
export const FAMILY_BREAKER_LABEL = "error:family-breaker";

/** Convenience-counter prefix on the family root: `family-dispatches:N`.
 *  Single colon, and deliberately disjoint from the `done:`/`needs-rework:`/
 *  `wip:`/`error:` pipeline prefixes so no per-agent strip loop can eat it
 *  (locked by a test in lib.test.ts). Comments are the source of truth when
 *  the two disagree; this label is the human-readable mirror. */
export const FAMILY_DISPATCH_COUNT_PREFIX = "family-dispatches:";

/** Hidden marker embedded in the per-dispatch comment posted on the family
 *  root. The count of these comments IS the family tally. An HTML comment
 *  renders invisibly in GitHub's Markdown (same shape as
 *  AUTO_RETRY_COMMENT_MARKER). */
export const FAMILY_DISPATCH_COMMENT_MARKER = "<!-- family-dispatch-marker -->";

/** Hidden marker embedded in the one explanatory comment posted when the
 *  breaker trips. Its presence is the cross-cycle dedupe: a family that
 *  stays tripped re-vetoes every cycle but explains itself only once —
 *  measured from the latest reset (see FAMILY_DISPATCH_RESET_MARKER). */
export const FAMILY_BREAKER_COMMENT_MARKER = "<!-- family-breaker-tripped -->";

/** The operator's per-family reset switch: a comment containing this
 *  marker on the family ROOT zeroes that family's tally. Only dispatch
 *  markers posted AFTER the latest reset count, and the trip-comment
 *  dedupe also looks only past it. This keeps resume per-family — no
 *  global PYRY_FAMILY_DISPATCH_LIMIT raise needed to free one lineage.
 *  The trip comment QUOTES this string in its instructions, so
 *  `tallyFamilyComments` never treats a trip comment as a reset. The
 *  three family markers are mutually distinct, non-substring strings
 *  (locked by test). */
export const FAMILY_DISPATCH_RESET_MARKER = "<!-- family-dispatch-reset -->";

/** Default dispatch budget per family — about four clean six-stage tickets
 *  (a clean ticket takes ~6 runs). The 213$ overnight spiral would have
 *  been capped after roughly a quarter of its burn. Override with
 *  PYRY_FAMILY_DISPATCH_LIMIT. */
export const FAMILY_DISPATCH_LIMIT_DEFAULT = 24;

/**
 * Parse PYRY_FAMILY_DISPATCH_LIMIT. Positive integers are honoured;
 * unset, zero, negative, or garbage falls back to the default — a limit
 * of 0 would park every family on its first dispatch, which is never
 * what a typo intends.
 */
export function resolveFamilyDispatchLimit(raw: string | undefined): number {
  if (!raw) return FAMILY_DISPATCH_LIMIT_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : FAMILY_DISPATCH_LIMIT_DEFAULT;
}

/**
 * A ticket's family ROOT: the top of its split lineage. The PO's
 * split-depth cap guarantees chains are at most 3 deep (grandchild), so
 * two levels of parent — carried on the board snapshot — fully resolve
 * the root without any descendant walk or extra query.
 */
export function resolveFamilyRoot(item: {
  issueNumber: number;
  parentNumber?: number | null;
  grandparentNumber?: number | null;
}): number {
  return item.grandparentNumber ?? item.parentNumber ?? item.issueNumber;
}

/**
 * Family roots that no board lookup can see.
 *
 * `rootLabelsByIssue` is built from the project board, so it only knows
 * issues that are ON the board. A split family's root is closed the
 * moment its children are filed, and a closed root leaves the board for
 * two ordinary reasons: the operator archives a crowded Done column
 * (which is what happened to #1906 on 2026-09-01), or the root was never
 * added to the board at all. Either way the root's `error:family-breaker`
 * label becomes unreadable, the selection-layer veto silently stops
 * vetoing, and the parked family keeps taking dispatch slots it can only
 * lose — see the starvation note on `runFamilyBreaker`.
 *
 * This returns exactly the roots worth a direct issue fetch: referenced
 * by a board item, not the item itself (an item is its own root only
 * when it has no parent, and then its labels are already in hand), and
 * missing from the board lookup. On a board of unsplit tickets that set
 * is empty and the cycle costs nothing extra.
 */
export function collectOffBoardFamilyRoots(
  items: Iterable<{
    issueNumber: number;
    parentNumber?: number | null;
    grandparentNumber?: number | null;
  }>,
  known: ReadonlyMap<number, readonly string[]>,
): Set<number> {
  const missing = new Set<number>();
  for (const item of items) {
    const root = resolveFamilyRoot(item);
    if (root === item.issueNumber) continue;
    if (known.has(root)) continue;
    missing.add(root);
  }
  return missing;
}

/**
 * Read the convenience counter from the root's labels. Max-of-found
 * (same defensive shape as `extractReworkCount`): duplicate counters
 * shouldn't co-exist, but if a partial label-strip race leaves
 * stragglers, biasing high errs toward tripping rather than
 * under-counting. Malformed / negative tails are treated as 0.
 */
export function extractFamilyDispatchCount(labels: readonly string[]): number {
  let max = 0;
  for (const label of labels) {
    if (!label.startsWith(FAMILY_DISPATCH_COUNT_PREFIX)) continue;
    const tail = label.slice(FAMILY_DISPATCH_COUNT_PREFIX.length);
    if (tail.length === 0) continue;
    const n = parseInt(tail, 10);
    if (isNaN(n) || n < 0) continue;
    if (n > max) max = n;
  }
  return max;
}

/**
 * The family's effective tally. The marker-comment count is the source
 * of truth whenever it could be read — labels can silently fail to
 * write, so when the two disagree the comments win in BOTH directions
 * (a stale-high label must not park a healthy family; a stale-low label
 * must not hide a runaway one). A null `markerCount` means the comments
 * could not be fetched this cycle; the convenience label is the
 * fallback, and no label at all reads as 0 — fail open, because a
 * missed veto costs one dispatch while a spurious park stalls a family.
 */
export function resolveFamilyTally(
  markerCount: number | null,
  rootLabels: readonly string[],
): number {
  if (markerCount !== null) return markerCount;
  return extractFamilyDispatchCount(rootLabels);
}

/**
 * Fold one issue's comment stream into the family breaker's durable
 * state: the dispatch tally and whether the trip explanation stands.
 *
 * Semantics, per comment in chronological order:
 *   - a TRIP comment (contains FAMILY_BREAKER_COMMENT_MARKER) arms the
 *     dedupe. It also quotes the reset marker in its operator
 *     instructions, so trip detection wins: a body carrying both markers
 *     is a trip, never a reset — otherwise every trip would immediately
 *     zero the tally it tripped on.
 *   - a RESET comment (contains FAMILY_DISPATCH_RESET_MARKER, and is not
 *     a trip) zeroes the running tally AND clears the dedupe. Only what
 *     comes after the LATEST reset counts, so an operator resume is
 *     per-family and a resumed family that runs away again both trips
 *     again and explains itself again.
 *   - a DISPATCH marker (contains FAMILY_DISPATCH_COMMENT_MARKER)
 *     increments the running tally.
 *
 * Ordering: when EVERY comment carries a parseable `created_at`, the
 * stream is sorted by it (array position as tiebreak) — belt-and-braces
 * against a future ordering change. Otherwise array order stands;
 * GitHub's REST API returns issue comments oldest-first.
 *
 * Pure — shared by the real client (github.ts) and the test mock, so
 * the two can never disagree about reset semantics.
 */
export function tallyFamilyComments(
  comments: ReadonlyArray<{ body?: unknown; created_at?: unknown }>,
): { markerCount: number; breakerCommented: boolean } {
  const dated = comments.map((c, i) => ({
    c,
    i,
    t: typeof c?.created_at === "string" ? Date.parse(c.created_at) : NaN,
  }));
  const ordered = dated.every((x) => !isNaN(x.t))
    ? [...dated].sort((a, b) => a.t - b.t || a.i - b.i)
    : dated;

  let markerCount = 0;
  let breakerCommented = false;
  for (const { c } of ordered) {
    const body = c?.body;
    if (typeof body !== "string") continue;
    const isTrip = body.includes(FAMILY_BREAKER_COMMENT_MARKER);
    if (!isTrip && body.includes(FAMILY_DISPATCH_RESET_MARKER)) {
      markerCount = 0;
      breakerCommented = false;
      continue;
    }
    if (body.includes(FAMILY_DISPATCH_COMMENT_MARKER)) markerCount++;
    if (isTrip) breakerCommented = true;
  }
  return { markerCount, breakerCommented };
}

/** What `decideFamilyBreaker` returns: the veto plus a loggable reason. */
export interface FamilyBreakerDecision {
  veto: boolean;
  reason: string;
}

/**
 * The breaker decision: given a candidate's family root, the root's
 * dispatch tally, and the limit, veto or allow. Tally at or over the
 * limit vetoes (24 vetoes at the default 24; 23 does not).
 *
 * Deliberately dumb — no rates, no windows, no exemptions. The limit is
 * a hard budget per family lineage; a deterministic cap is the whole
 * point (the 213$ spiral was invisible to every clever per-ticket
 * heuristic already in place).
 */
export function decideFamilyBreaker(opts: {
  rootNumber: number;
  markerCount: number;
  threshold: number;
}): FamilyBreakerDecision {
  if (opts.markerCount >= opts.threshold) {
    return {
      veto: true,
      reason:
        `family root #${opts.rootNumber} has consumed ${opts.markerCount} dispatches, ` +
        `at/over the limit of ${opts.threshold} (PYRY_FAMILY_DISPATCH_LIMIT)`,
    };
  }
  return {
    veto: false,
    reason: `family root #${opts.rootNumber} at ${opts.markerCount}/${opts.threshold} dispatches`,
  };
}

// --------- Label predicates ---------

// The label prefixes the dispatcher uses for per-agent state.
//   done:<agent>         — agent completed successfully
//   needs-rework:<agent> — agent (or another) flagged the ticket back here
//   wip:<agent>          — agent currently running
//   error:<agent>        — agent crashed
//   pending-done:<agent> — agent succeeded but the post-run column read
//                          failed; the next board read finishes the
//                          decision (see decidePendingDoneFinalizations)
//   pending-verdict:<agent> — agent finished a verdict GitHub would not
//                          take; the dispatcher posts the saved verdict on
//                          a later cycle (see verdict-handoff.ts)
export const PIPELINE_LABEL_PREFIXES = [
  "done:",
  "needs-rework:",
  "wip:",
  "error:",
  "pending-done:",
  "pending-verdict:",
] as const;

export const PENDING_DONE_PREFIX = "pending-done:";

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
 *
 * `needs-human:sizing` is deliberately NOT a member, though it was one
 * for a few hours on 2026-09-01. It marks a ticket where an agent
 * measured past its size boundary but the split-depth gate forbade a
 * split. When that meant "stop and wait for a person" the block was
 * needed, or the next cycle re-dispatched the same agent to re-derive
 * the same measurement. The prompts changed the same day: the agent now
 * records the split it would have made, applies the label so the call is
 * findable on the board, and does its normal job. The label therefore
 * outlives the run that set it, and blocking on it would stall the
 * developer on a ticket the architect had already specced.
 */
export const GLOBAL_BLOCK_LABELS: ReadonlySet<string> = new Set([
  "error:max_turns_salvaged",
  "error:merge-conflict",
  // Rework routing leaves the ticket in its current column at the threshold.
  // Block that column's agent too, or it reviews the same branch every cycle.
  "error:rework-loop",
  // The family circuit breaker's park switch, applied to the family ROOT.
  // Membership here blocks the root itself; descendants are vetoed through
  // the parent chain by shouldSkipDispatch's rootLabels arm. See the
  // family-breaker section above for the full mechanism.
  FAMILY_BREAKER_LABEL,
]);

/**
 * True if the given subprocess stderr/error indicates a gh command failed
 * because the PR conflicts with its base.
 *
 * `runAutoMerge` feeds this the stderr of TWO different gh commands, and
 * they do not word the conflict the same way. Both shapes are captured
 * live, not guessed:
 *
 *   `gh pr merge --merge`   →  X Pull request owner/repo#N is not mergeable:
 *                              the merge commit cannot be cleanly created.
 *   `gh pr update-branch --rebase`
 *                           →  X Cannot update PR branch due to conflicts
 *
 * **The second one was missing until 2026-08-06, and its absence is the
 * whole mechanism behind the Done-card trap.** Step 1.5 of `runAutoMerge`
 * rebases before it merges, and on a non-conflict verdict it `continue`s
 * rather than falling through. So a conflicting PR failed the rebase,
 * this predicate said "not a conflict", the loop skipped silently, and
 * Step 2's working detector was never reached. Every cycle, indefinitely:
 * no `error:merge-conflict` label, no Discord notification, and a Done
 * card sitting over an unmerged PR with nothing anywhere saying so.
 * #1174 sat like that for ten days, #1240 twice, #1260 again on 2026-08-06.
 *
 * Deliberately matched by PHRASE, not by a bare "conflict" substring: the
 * negative tests require "name conflict in resource" to stay false, and
 * widening to the bare word would trade one silent failure for a noisy one.
 *
 * Case-insensitive — gh's wording capitalisation has shifted across versions.
 *
 * Used by the dispatcher's auto-merge loop on Done tickets: if an attempt
 * errors and `isMergeConflictError(stderr) === true`, the dispatcher labels
 * the ticket `error:merge-conflict` (a global block), posts a triage comment
 * with the resolution recipe, and stops retrying. Returns `false` for empty
 * / undefined input — caller decides whether "no stderr" means "no error"
 * (skip) or "unknown failure" (also skip).
 */
export function isMergeConflictError(stderr: string | null | undefined): boolean {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return (
    s.includes("not mergeable") ||
    s.includes("merge commit cannot be cleanly created") ||
    s.includes("merge conflict") ||
    // `gh pr update-branch --rebase`, the Step 1.5 path.
    s.includes("due to conflicts") ||
    // Verbatim from `gh pr update-branch --rebase` (2026-09-23):
    // "GraphQL: rebase conflict between base and head (updatePullRequestBranch)".
    s.includes("rebase conflict")
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
 * human strips them.
 *
 * `rootLabels` is the label set of the ticket's family ROOT (resolved via
 * the parent chain on the board snapshot). Only `error:family-breaker`
 * crosses the parent chain: a root parked by the family circuit breaker
 * vetoes every descendant for every agent, while a root parked on its own
 * unrelated error (`error:po`, `error:merge-conflict`) stays that ticket's
 * problem and its family keeps flowing. Optional so label-only callers
 * (and every pre-breaker test) keep their exact semantics.
 */
export function shouldSkipDispatch(
  labels: string[],
  agentName: string,
  rootLabels?: readonly string[],
): boolean {
  if (labels.some((l) => GLOBAL_BLOCK_LABELS.has(l))) return true;
  if (rootLabels?.includes(FAMILY_BREAKER_LABEL)) return true;
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
 * Hard cap on builder reworks: a ticket whose `rework-count:N` has reached
 * this many is parked with `error:rework-loop` instead of being sent back
 * again, so the route that would pass the cap parks. Overridden per fork by
 * `PYRY_BUILDER_REWORK_CAP` (`resolveReworkLoopCap`). Adjusting the default
 * is a deliberate policy change — see the test in lib.test.ts that locks it
 * to 6.
 *
 * Only reworks routed to the code owner count (`needs-rework:builder` in the
 * builder set, `needs-rework:developer` in classic). Every other rework route
 * bumps `rework-other:N`, which never trips the breaker, and merge handoffs
 * and blocker waits count nothing. On a verifier → builder route a
 * `[MUST FIX]` finding repeated across the last two FAIL verdicts parks at
 * once, whatever the count (`findRepeatedMustFix`); the cap is the backstop
 * for steady progress that never converges. See `decideReworkBreaker`.
 *
 * Why the change (agent-dispatcher#122, 2026-10-05): until then every rework
 * route counted and the breaker parked at 3. Mobile #1782 was parked while
 * the verifier named different defects each round and the builder fixed
 * each set; once restarted the next round passed. #1735 and #1797 reached
 * the limit on documentation-to-verifier routes, not builder defects. A real
 * loop is the same finding raised again, which the count alone cannot see.
 * The original reason for a breaker stands: Pyrycode #41 hit 6
 * dev↔architect rounds before the dev agent self-halted by intelligence
 * rather than structure.
 */
export const REWORK_LOOP_THRESHOLD = 6;

/** Counter for rework routes that are not the code owner's. Never trips the
 *  breaker; kept so a ticket shows how often it bounced. */
export const REWORK_OTHER_PREFIX = "rework-other:";

/** Max of every `<prefix>N` label; malformed or negative values read as 0. */
function maxCounterLabel(labels: string[], prefix: string): number {
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
  return maxCounterLabel(labels, "rework-count:");
}

/** `rework-other:N`, read the same way as `extractReworkCount`. */
export function extractReworkOtherCount(labels: string[]): number {
  return maxCounterLabel(labels, REWORK_OTHER_PREFIX);
}

/**
 * Parse `PYRY_BUILDER_REWORK_CAP`. Unset, zero, negative or garbage keeps
 * `REWORK_LOOP_THRESHOLD`: a cap of 0 would park every builder rework.
 */
export function resolveReworkLoopCap(raw: string | undefined): number {
  if (!raw) return REWORK_LOOP_THRESHOLD;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : REWORK_LOOP_THRESHOLD;
}

export type ReworkBreakerDecision =
  | { park: false }
  | { park: true; rule: "repeat"; keys: string[] }
  | { park: true; rule: "cap"; cap: number };

/**
 * The rework breaker for one route. `counted` is whether the route is the
 * code owner's rework; anything else never parks. A repeated verifier finding
 * parks at once and wins over the cap, so the comment can name it. Otherwise
 * the route parks when the ticket already has `hardCap` builder reworks.
 * `repeatedKeys` is empty when the verdicts were not read, could not be read
 * or did not parse, which leaves the count rule alone in charge.
 */
export function decideReworkBreaker(input: {
  counted: boolean;
  reworkCount: number;
  hardCap: number;
  repeatedKeys: readonly string[];
}): ReworkBreakerDecision {
  if (!input.counted) return { park: false };
  if (input.repeatedKeys.length > 0) return { park: true, rule: "repeat", keys: [...input.repeatedKeys] };
  if (input.reworkCount >= input.hardCap) return { park: true, rule: "cap", cap: input.hardCap };
  return { park: false };
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

// --------- Transient-error auto-retry (agent-dispatcher#25) ---------
//
// When an agent run fails with a transient transport/API error (dropped
// socket, 5xx, 429, EAGAIN host pressure), the dispatcher auto-retries on
// a board-encoded exponential backoff instead of immediately parking the
// ticket with `error:<stage>` for a human. State lives entirely on the
// board so it survives the frequent dispatcher restarts:
//
//   - attempt number   -> `error-retry-count:N` label (mirrors `rework-count:N`)
//   - last-failure time -> createdAt of the marker-tagged auto-retry comment
//
// The poll loop is the timer: each cycle recomputes `eligible_at =
// lastErrorAt + backoffDelayMs(N)` from board state and skips re-dispatch
// until it passes. Nothing in-process, so a restart mid-wait resumes the
// same schedule rather than resetting it.
//
// The schedule is itself a soft classifier: a genuine blip clears on the
// first short retry; anything still failing through the full schedule
// isn't transient and escalates to a human at the cap. That makes the
// allowlist self-correcting against a mistakenly-added signature.

/** Label prefix carrying the transient-retry attempt counter. Note it is
 *  `error-retry-count:` (no colon after `error`), so it does NOT match the
 *  `error:` pipeline-label prefix — a retry-waiting ticket is not treated
 *  as an `error:`-parked one, and `isPipelineLabelForAgent` won't strip it
 *  on re-dispatch (the counter must survive so the next failure increments). */
export const ERROR_RETRY_COUNT_PREFIX = "error-retry-count:";

/** Maximum auto-retry attempts before parking for a human. With the
 *  5/10/20/40-min schedule below, total wait is <= ~75 min. */
export const RETRY_MAX_ATTEMPTS = 4;

/** Base backoff (attempt 1 nominal). Doubles per attempt: 5/10/20/40 min. */
export const RETRY_BASE_MS = 5 * 60_000;

/** Hidden marker embedded in every auto-retry comment so the dispatcher can
 *  find the most recent one and read its createdAt as the last-failure time.
 *  An HTML comment renders invisibly in GitHub's Markdown. */
export const AUTO_RETRY_COMMENT_MARKER = "<!-- pyry-auto-retry -->";

/** One transient-error signature: `match` is the lowercased substring probed
 *  against the agent's error text; `signature` is the human-facing name
 *  surfaced in the auto-retry comment. */
export interface RetrySignature {
  signature: string;
  match: string;
}

/**
 * Allowlist of transient transport/API error signatures that clear on a
 * clean retry. Deliberately NARROW — the ticket's "never auto-retry" list
 * stays OFF here so a blind re-run can't waste money or mask a real bug:
 *   - git divergence ("commits not present on origin") — integrity decision
 *   - wall-clock timeout / `max_turns` — a re-run just buys another overrun
 *   - genuine test/build failures or wrong output — rework territory
 *   - `400 thinking/redacted_thinking blocks` — a harness bug; fix it, don't mask
 * Those never reach this allowlist (no matching entry) and park immediately.
 *
 * `idle_stall` IS on the list (unlike `timeout`/`max_turns`): pyry's
 * streamrunner watchdog (pyrycode#360) emits it when claude's HTTPS stream to
 * the Anthropic API wedges mid-run — zero bytes while claude still owes an
 * assistant turn. That is a wedged connection, not a slow or over-budget
 * agent, so a clean re-run genuinely clears it (it does not just buy another
 * overrun). The watchdog (~240s) fires well before the dispatcher's 20-40min
 * hard cap, so the synthetic `idle_stall` result reaches us first; the
 * per-ticket retry cap still bounds a *persistent* stall to the operator.
 *
 * `auth token (401)` IS on the list too: the dispatcher's agent runs and
 * interactive Claudian share ONE macOS keychain Claude login, whose token
 * refresh can fail transiently and self-heal (observed 2-min and 20-min
 * outages on 2026-07-03, both recovered with no manual `/login`). The standard
 * 5/10/20/40-min schedule is what makes this safe: a 20-min outage clears on
 * attempt 3 (~+35min), while a genuinely dead login that needs interactive
 * `/login` just parks at the cap instead of on the first failure.
 */
// Order matters: more-specific signatures are probed before broader ones.
// `overloaded_error` / `529` come before the generic `api error: 5` so an
// "API Error: 529 (overloaded)" surfaces the precise signature rather than
// the catch-all 5xx one. (Both are transient, so `transient` is unaffected
// either way — only the human-facing `signature` string differs.)
export const RETRY_ALLOWLIST: readonly RetrySignature[] = [
  { signature: "idle stream stall",      match: "idle_stall" },
  { signature: "socket closed",          match: "socket connection was closed unexpectedly" },
  { signature: "fetch failed",           match: "fetch failed" },
  { signature: "connection reset",       match: "econnreset" },
  { signature: "connection reset",       match: "connection reset" },
  { signature: "overloaded",             match: "overloaded_error" },
  { signature: "overloaded (529)",       match: "529" },
  { signature: "rate limit (429)",       match: "429" },
  { signature: "API 5xx",                match: "api error: 5" },
  { signature: "cannot fork",            match: "cannot fork" },
  { signature: "host pressure (EAGAIN)", match: "resource temporarily unavailable" },
  { signature: "host pressure (EAGAIN)", match: "eagain" },
  // Shared-keychain Claude login (`Claude Code-credentials`) token-refresh
  // failure. The dispatcher's agent runs and interactive Claudian share ONE
  // macOS keychain login, whose refresh can fail transiently and self-heal.
  // Observed 2026-07-03: a ~2-min wobble (3 tickets, board #1) and a ~20-min
  // outage (26 tickets, tui-driver), both recovered with no manual `/login`.
  // Two phrasings of the one failure; either matches. Deliberately narrow —
  // `please run /login` and `invalid authentication credentials` are the
  // Claude CLI's own auth-token strings, NOT a GitHub `401 Bad credentials`.
  // A genuinely dead login (needs interactive `/login`) self-corrects by
  // parking at the ~75-min cap, same as any mistakenly-added signature.
  { signature: "auth token (401)",       match: "please run /login" },
  { signature: "auth token (401)",       match: "invalid authentication credentials" },
];

/**
 * claude's own `terminal_reason` for "the API returned an error", read off
 * the result frame (`StreamResult.terminalReason`). Structural, not prose:
 * matching on it covers every wording the API has used and every wording it
 * has yet to use, which is what the allowlist below cannot do.
 *
 * Measured 2026-08-24 over all 4103 agent logs back to 2026-05-09: 79 runs
 * ended with this reason and ALL 79 were server-side transients — 529
 * overload (64), "Anthropic API failure" (9), "Server error mid-response"
 * (3), "403 Unable to verify organization membership" (2), "Connection
 * closed mid-response" (1). Zero deterministic failures in the class.
 *
 * 15 of those 79 (19%) matched no allowlist entry and parked a ticket for a
 * human that a retry would have cleared. The wording list has now been
 * extended twice (2026-07-04 for the 401 strings, and would need two more
 * entries today) and each extension only ever covers the wording already
 * seen. Hence the structural arm.
 */
export const API_ERROR_TERMINAL_REASON = "api_error";

/**
 * `terminal_reason` values that must NEVER take the structural retry arm,
 * even if claude relabels a failure into one. Belt-and-braces: today none of
 * these carry `api_error`, so the guard is inert — it exists so a future
 * relabelling can't silently widen the retry into a deterministic class.
 *
 *   - `completed` — the `400 thinking/redacted_thinking blocks` harness bug
 *     surfaces here, NOT under `api_error` (3 instances, 2026-05-28, relay
 *     board). It is deterministic: retrying burns the full ~75-min backoff
 *     and parks anyway. Fix the harness, don't mask it.
 *   - `timeout` — a wall-clock kill. A re-run just buys another overrun,
 *     the same reason `max_turns` stays off the allowlist.
 */
export const NEVER_RETRY_TERMINAL_REASONS: readonly string[] = ["completed", "timeout"];

/**
 * Classify an agent failure as transient (auto-retry) or not (park).
 *
 * Two arms, structural first:
 *   1. `opts.terminalReason === "api_error"` — claude itself reporting that
 *      the API errored. Covers any wording, present or future.
 *   2. Case-insensitive substring match against RETRY_ALLOWLIST. Still the
 *      only arm for failures that never reach a result frame at all —
 *      spawn-side (`cannot fork`, EAGAIN), the watchdog's synthetic
 *      `idle_stall`, and the shared-keychain 401 strings.
 *
 * Returns the matching signature (for the auto-retry comment) and
 * `transient: true`; otherwise `{ transient: false }`.
 *
 * `opts` is optional so every existing caller and test keeps its behaviour:
 * with no structured reason supplied, this is exactly the allowlist match it
 * always was.
 *
 * Pure — no I/O. Unit-tested against captured real error strings including
 * a non-matching one.
 */
export function classifyAgentError(
  errText: string | null | undefined,
  opts?: { terminalReason?: string | null },
): { transient: boolean; signature: string } {
  const reason = (opts?.terminalReason ?? "").trim().toLowerCase();
  if (reason && NEVER_RETRY_TERMINAL_REASONS.includes(reason)) {
    return { transient: false, signature: "" };
  }
  if (reason === API_ERROR_TERMINAL_REASON) {
    return { transient: true, signature: "API error (server-side)" };
  }
  if (!errText) return { transient: false, signature: "" };
  const s = errText.toLowerCase();
  for (const entry of RETRY_ALLOWLIST) {
    if (s.includes(entry.match)) return { transient: true, signature: entry.signature };
  }
  return { transient: false, signature: "" };
}

/**
 * Reasons a Codex agent gives for stopping with `status: blocked` that a
 * later run can clear by itself: a tool, MCP server or environment variable
 * it needs was missing or unavailable when it looked.
 *
 * Every pattern comes from a summary that parked a ticket for a cause outside
 * the ticket's own work:
 *   - "Required Figma tools are unavailable in this session" (mobile #1646,
 *     2026-10-03) and "Required Figma tools `get_design_context` and
 *     `get_screenshot` are unavailable" (mobile #1668, 2026-10-04). Both
 *     cleared on their own; a Codex call to the Figma `whoami` tool worked
 *     hours later the same day. Desktop #1696 said "those tools are
 *     unavailable" on 2026-09-30.
 *   - "ANDROID_HOME is missing from the dispatcher environment" (mobile
 *     #1631, 2026-10-03) and "AGENTS_REPO_PATH is unset" (mobile #1305,
 *     2026-09-30). The dispatcher's environment, not the agent's work.
 *
 * Kept narrow on purpose. Checked against every blocked summary in the
 * Mobile, Desktop and pyrycode logs up to 2026-10-04, 23 distinct ones: it
 * matches the five above and none of the eighteen that need a person, such as
 * a role conflict, a missing design decision or a denied permission.
 *
 * The variable pattern is case-sensitive so that only an upper-case name with
 * an underscore reads as an environment variable, never a field or a word.
 */
export const BLOCKED_RETRY_PATTERNS: readonly { signature: string; pattern: RegExp }[] = [
  {
    signature: "required tool unavailable",
    pattern: /\b(?:tools?|mcp(?: servers?)?)\b(?:(?!\.\s)[^\n]){0,160}?\b(?:is|are|was|were)\s+(?:unavailable|not available|not connected|disconnected)\b/i,
  },
  {
    signature: "environment variable missing",
    pattern: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b`?\s+(?:environment variable\s+)?(?:is|was)\s+(?:missing|unset|not set|empty)\b/,
  },
  {
    signature: "environment variable missing",
    pattern: /\bmissing\s+(?:required\s+)?environment\s+variables?\b/i,
  },
];

/**
 * Words that mean a person has to act, whatever else the summary says. Any of
 * them keeps a blocked run parked even when it also names a missing tool. The
 * automatic approval reviewer's rejection is the most important one: retrying
 * it would repeat an action that was refused.
 */
export const BLOCKED_NEVER_RETRY = /\bapproval\b|unacceptable risk|permission denied|\bhuman\b|\bmaintainer\b|\bdecision\b/i;

/**
 * Classify a Codex run that stopped with `status: blocked`. Transient only
 * when its stated reason is a missing or unavailable tool, MCP server or
 * environment variable (`BLOCKED_RETRY_PATTERNS`), and nothing in it says a
 * person must act (`BLOCKED_NEVER_RETRY`). A rejected action is never
 * transient, whatever the text says.
 *
 * Transient blocked runs go through the same capped auto-retry as transport
 * errors. A tool that stays missing parks at the cap, as before, about 75
 * minutes later instead of at once.
 *
 * One more kind retries: Codex's automatic approval reviewer failed to
 * decide, because its own model was at capacity or it missed its deadline,
 * and Codex said this is not a rejection (`approvalReviewFailed`,
 * pyrycode-mobile #1582 and #1655, 2026-10-05). A rejection alongside it
 * still parks.
 *
 * Separate from `classifyAgentError` because a blocked summary is the agent's
 * own prose. The transport allowlist must never read it: a blocked summary
 * mentioning "connection reset" is still a block (see dispatch.test.ts).
 */
export function classifyBlockedRun(
  text: string | null | undefined,
  opts?: { approvalRejected?: boolean; approvalReviewFailed?: boolean },
): { transient: boolean; signature: string } {
  if (opts?.approvalRejected) return { transient: false, signature: "" };
  // Before BLOCKED_NEVER_RETRY: the summary of such a block always says
  // "approval". The flag comes from Codex's own words, not the summary.
  if (opts?.approvalReviewFailed) return { transient: true, signature: "approval review failed" };
  if (!text) return { transient: false, signature: "" };
  if (BLOCKED_NEVER_RETRY.test(text)) return { transient: false, signature: "" };
  for (const entry of BLOCKED_RETRY_PATTERNS) {
    if (entry.pattern.test(text)) return { transient: true, signature: entry.signature };
  }
  return { transient: false, signature: "" };
}

// --------- Required environment preflight ---------

/**
 * The names in `PYRY_REQUIRED_ENV`: separated by commas or whitespace, with
 * blanks and repeats dropped. Unset or empty means nothing is required, which
 * keeps the preflight a no-op for every fork that does not opt in.
 */
export function parseRequiredEnv(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(/[\s,]+/).filter(Boolean))];
}

/**
 * The required names that are unset or blank in `env`, in declared order. A
 * blank value counts as missing: `ANDROID_HOME=` is no more use to Gradle
 * than no `ANDROID_HOME` at all.
 */
export function missingRequiredEnv(
  required: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return required.filter((name) => (env[name] ?? "").trim() === "");
}

/**
 * Deterministic [0,1) PRNG seeded on (issueNumber, attempt). Same inputs
 * always yield the same value, so `backoffDelayMs` produces a STABLE
 * `eligible_at` across the poll cycles that recompute it from board state
 * — without this, fresh jitter each cycle would move the deadline and the
 * ticket would never settle. Different tickets get different jitter, which
 * is also the decorrelation a global-overload burst needs. mulberry32 — a
 * small, well-distributed integer PRNG, no dependencies.
 */
export function seededRng(issueNumber: number, attempt: number): () => number {
  // Combine the inputs, then run a splitmix32 finalizer so the seed
  // avalanches BEFORE the first draw. mulberry32's first output has weak
  // avalanche straight off a lightly-mixed seed — without this finalizer,
  // consecutive issue numbers (the common case: tickets erroring together)
  // collapse to the same first value, and `backoffDelayMs` only ever draws
  // once. The finalizer makes that single draw decorrelate across tickets.
  let seed = (Math.imul(issueNumber | 0, 0x9e3779b1) ^ Math.imul(attempt | 0, 0x85ebca77)) >>> 0;
  seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) >>> 0;
  seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) >>> 0;
  let a = (seed ^ (seed >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Backoff delay (ms) for retry `attempt` (1-based). The nominal schedule
 * doubles per attempt — 5/10/20/40 min — and full-jitter spreads the actual
 * delay uniformly across `[0, nominal]` so a global Anthropic overload that
 * errors many tickets at once doesn't retry them in lockstep and re-overload.
 *
 * `rng` MUST be deterministic per (ticket, attempt) in production (see
 * `seededRng`) — eligibility is recomputed every poll, so a non-deterministic
 * roll would make the deadline drift. Tests inject a fixed rng.
 *
 * `attempt <= 0` returns 0 (defensive). No cap is applied here; the
 * attempt cap is a separate policy the caller enforces via RETRY_MAX_ATTEMPTS.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { rng: () => number; baseMs?: number },
): number {
  if (attempt <= 0) return 0;
  const baseMs = opts.baseMs ?? RETRY_BASE_MS;
  const nominal = baseMs * 2 ** (attempt - 1);
  const r = opts.rng();
  const frac = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  return Math.round(nominal * frac);
}

/**
 * True if `now` has reached `lastErrorAt + backoffDelayMs(attempt)` — i.e.
 * the backoff window for the current attempt has elapsed and the ticket may
 * be re-dispatched. `lastErrorAt`/`now` accept epoch-ms or Date. The caller
 * passes the same seeded rng used to schedule, so the recomputed delay
 * matches.
 *
 * Pure — no I/O. The caller supplies `lastErrorAt` (the auto-retry comment's
 * createdAt) and `now`.
 */
export function isRetryEligible(
  lastErrorAt: number | Date,
  attempt: number,
  now: number | Date,
  opts: { rng: () => number; baseMs?: number },
): boolean {
  const last = lastErrorAt instanceof Date ? lastErrorAt.getTime() : lastErrorAt;
  const nowMs = now instanceof Date ? now.getTime() : now;
  return nowMs >= last + backoffDelayMs(attempt, opts);
}

/**
 * Read the current transient-retry attempt count from a ticket's labels.
 * Max-of-found (same defensive shape as `extractReworkCount`): multiple
 * counters shouldn't co-exist, but if a partial label-strip race leaves
 * stragglers, biasing high errs toward parking rather than over-retrying.
 * Malformed / negative tails are treated as 0.
 */
export function extractErrorRetryCount(labels: string[]): number {
  let max = 0;
  for (const label of labels) {
    if (!label.startsWith(ERROR_RETRY_COUNT_PREFIX)) continue;
    const tail = label.slice(ERROR_RETRY_COUNT_PREFIX.length);
    if (tail.length === 0) continue;
    const n = parseInt(tail, 10);
    if (isNaN(n) || n < 0) continue;
    if (n > max) max = n;
  }
  return max;
}

/**
 * True when a ticket is parked in transient-retry backoff: it carries an
 * `error-retry-count:N` label but is NOT currently running (`wip:`). Such a
 * ticket isn't consuming a pipeline thread, so `countPipelineInFlight`
 * excludes it from the WIP count (a waiting retry "costs nothing against
 * the WIP limit"). A retry that has been re-dispatched carries `wip:<agent>`
 * and DOES count — it's genuinely in flight.
 */
export function isRetryWaiting(labels: string[]): boolean {
  if (!labels.some(l => l.startsWith(ERROR_RETRY_COUNT_PREFIX))) return false;
  return !labels.some(l => l.startsWith("wip:"));
}
