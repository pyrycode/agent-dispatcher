// Issue dependencies (`addBlockedBy`) and empty-branch guard.
//
// All pure: examines blocker state, agent config, parsed git output.
//
// Split from lib.ts on 2026-05-09.

import type { AgentConfig } from "./types.js";

// --------- Issue dependencies ---------

/**
 * True if any of the listed blockers is still OPEN.
 *
 * Uses GitHub's first-class `addBlockedBy` relationship (queryable as
 * `Issue.blockedBy` in GraphQL, visible in the issue UI as a "Blocked by
 * #N" badge). The dispatcher skips dispatch on any ticket where this
 * returns true — a blocked ticket can't make progress until its
 * dependencies close.
 *
 * Avoids the retry-loop class of failures (Pyrycode #41 hit this 6 times,
 * burning ~$4 of dev tokens, before the dev agent self-halted by
 * setting `error:developer`). Native `blockedBy` makes the constraint
 * structural — survives across runs, visible in the GitHub UI, and
 * doesn't require a custom label scheme.
 */
export function hasOpenBlockers(
  blockers: { number: number; state: "OPEN" | "CLOSED" }[],
): boolean {
  return blockers.some(b => b.state === "OPEN");
}

// Note: `shouldSkipBlockedFor(agentName, blockers)` used to live here as a
// per-agent gate predicate. PO was originally exempted ("refinement is cheap
// prep work") but that bypass shipped stale refinements when PO read pre-merge
// docs about an upstream blocker (relay #198/#199, 2026-05-08); since then
// the gate is uniform across all agents — `hasOpenBlockers(blockers)`
// directly. Wrapper deleted 2026-05-09 late evening as dead generalization.
// Full rationale + the generalizable "informational vs API dependencies"
// pattern in [[Lessons#PO refines from docs ...]].

// --------- Empty-branch guard ---------

/**
 * True if this agent is expected to produce commits during a normal
 * successful run. The empty-branch guard fires only on agents where
 * this is true AND the post-run branch is 0 ahead of `main`.
 *
 * Reads `agent.producesCommits` (declared in types.ts). Distinct from
 * `shouldUseWorktree`: code-review uses a worktree (reads code) but
 * never commits — its output is PR comments via `gh pr review`.
 *
 * Surfaced by relay #5 (2026-05-08): architect refused to spec without
 * blocker resolution, developer refused to code without spec, code-review
 * couldn't apply `needs-rework:developer` because that label didn't
 * exist in the relay repo — and the dispatcher march-marched the ticket
 * across every column to "Done" with `feature/5` unchanged from main.
 * The fix is deterministic: don't trust the agent's prose about whether
 * work happened; verify by counting commits.
 */
export function shouldProduceCommits(agent: AgentConfig): boolean {
  return agent.producesCommits;
}

/**
 * Parse the integer count from `git rev-list --count <base>..<branch>`.
 * Returns -1 on unparseable input — caller treats as "git output
 * unknown, don't act on it" (safer than treating garbage as 0 and
 * falsely flagging a successful run as empty).
 *
 * The git command itself either succeeds with a single integer line or
 * exits non-zero (then `execSync` throws and the caller's `catch`
 * leaves `commitsAhead` at -1). This function only exists so the
 * parsing is testable without shelling out — the contract is "trust
 * a parsed integer; treat anything else as unknown."
 */
export function parseCommitsAhead(revListOutput: string): number {
  const trimmed = revListOutput.trim();
  if (trimmed.length === 0) return -1;
  const n = Number.parseInt(trimmed, 10);
  if (Number.isNaN(n)) return -1;
  return n;
}

/**
 * True iff the dispatcher should treat this agent's post-run branch
 * state as a silent failure — the agent was expected to produce
 * commits but the branch is still 0 ahead of `main`.
 *
 * Caller side (in dispatch.ts) wraps this in:
 *   - `useWorktree` gate (no worktree = no branch to count against)
 *   - `!saferSalvaged` gate (salvage path manages its own labeling)
 *   - error-handling around the `git rev-list` call (treat throw as -1)
 *
 * Returns false on negative `commitsAhead` (parse failed or git errored)
 * — the dispatcher prefers to advance the ticket and let downstream
 * gates catch the issue rather than block on uncertain state.
 *
 * Returns false when `postLabels` includes any `needs-rework:*` label
 * — the agent legitimately bailed via the documented rework path
 * (architect on a too-large or blocked ticket, code-review on FAIL,
 * etc.). Empty branch is the EXPECTED outcome of that bail; flagging
 * it as `error:<agent>` is a false positive that blocks downstream
 * routing. Surfaced 2026-05-10 morning on `pyrycode-relay#26`'s
 * architect run — see Lessons.md "Empty-branch guard false-positives
 * on legitimate `needs-rework` bails (2026-05-10 morning)".
 *
 * Returns false on any `needs-human:*` label for the same reason, with
 * a different destination. `needs-rework:*` hands the ticket to another
 * agent and `runReworkRouting` moves it; `needs-human:*` hands it to a
 * person and nothing moves it until they decide. Both are documented
 * stop-without-committing paths in the agent prompts, so both produce
 * an empty branch by design. The architect and PO prompts prescribe
 * `needs-human:sizing` when a ticket is over its size boundary and the
 * split-depth gate ("stop at two") forbids proposing a split.
 *
 * Surfaced 2026-09-01 on `pyrycode#1938` — the first ticket in the
 * pipeline's history to take that path, which is why the gap between
 * the prompts and the dispatcher sat unnoticed. `GLOBAL_BLOCK_LABELS`
 * carries the other half of this fix: it parks the bailed ticket, which
 * is what stops it being re-dispatched into the same bail now that this
 * guard no longer parks it by accident under an `error:<agent>` label.
 *
 * See `shouldProduceCommits` for the per-agent classification and the
 * relay #5 incident that motivated this guard.
 */
export function shouldFlagEmptyBranch(
  agent: AgentConfig,
  commitsAhead: number,
  postLabels: readonly string[],
): boolean {
  if (!shouldProduceCommits(agent)) return false;
  if (commitsAhead < 0) return false;
  if (commitsAhead !== 0) return false;
  // Legitimate bail: agent added a needs-rework:* label deliberately.
  // Empty branch is expected; rework routing handles the next step.
  if (postLabels.some(l => l.startsWith("needs-rework:"))) return false;
  // Legitimate bail: agent handed the ticket to a human deliberately.
  // Same shape as needs-rework:*, different destination — no agent
  // picks this up, so there is no routing step, just a parked ticket.
  if (postLabels.some(l => l.startsWith("needs-human:"))) return false;
  return true;
}
