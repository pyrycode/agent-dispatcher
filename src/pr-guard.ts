// PR guard: an agent whose job ends in a pull request must leave one open.
//
// The builder set's builder opens the ticket's pull request as its last
// step, and nothing downstream checks that it did. On 2026-09-24 pyrycode
// #2569's builder ended its turn with "The suite is still running; I'll
// push once the completion notice arrives." The safety-net push put the
// branch on origin, the run exited cleanly, and the dispatcher applied
// `done:builder`. The verifier found no PR, reviewed the branch instead and
// passed it, documentation ran, and the ticket reached Done with the issue
// open. Auto-merge only merges an open PR, so it skipped the ticket and
// nothing ever reached main.
//
// This guard is the code-level net for that shape, the same fabric as the
// empty-branch and verdict guards: after a clean run of an agent marked
// `opensPr`, `feature/<n>` must have an open pull request, unless the run
// routed the ticket with a rework label. Otherwise the run is an error, not
// a pass, and the ticket parks with `error:<agent>` for a person to look at.
//
// Pure helpers here; the I/O (the `gh` call) stays in dispatch.ts.

/**
 * Count the pull requests in `gh pr list --head feature/<n> --state open
 * --json number` output. Drafts count: the builder may open one on
 * purpose. Throws on malformed JSON so the caller can skip the guard
 * rather than flag a run on a parse failure.
 */
export function countOpenPrs(json: string): number {
  const prs = JSON.parse(json || "[]") as unknown;
  return Array.isArray(prs) ? prs.length : 0;
}

/**
 * The guard's decision. Flags only when the agent must open a pull
 * request, the run left no rework label (a bail routes by label and owes
 * no PR), and the lookup found none open. A negative count means the
 * lookup failed; the guard then stays quiet, matching the empty-branch
 * guard's stance on git errors.
 */
export function shouldFlagMissingPr(
  agent: { opensPr?: boolean },
  postLabels: readonly string[],
  openPrs: number,
): boolean {
  if (!agent.opensPr) return false;
  if (openPrs !== 0) return false;
  if (postLabels.some((l) => l.startsWith("needs-rework:"))) return false;
  return true;
}
