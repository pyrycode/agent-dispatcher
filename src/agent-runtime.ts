// Per-agent runtime policy: which agents use worktrees, turn budgets,
// safer-salvage gating, PR list parsing, GitHub rate-limit detection, and
// the spawn-env hygiene that keeps dispatcher secrets out of `claude`'s env.
//
// All pure: takes labels, agent config, parsed JSON, etc. No I/O.
//
// Split from lib.ts on 2026-05-09.

import type { AgentConfig } from "./types.js";

// --------- Per-agent dispatch policy ---------

/**
 * True if the dispatcher should set up a git worktree for this agent and
 * push the resulting feature branch after the run. False for agents that
 * only modify external state (issues, PRs, project board) — currently
 * just PO.
 *
 * Reads `agent.usesWorktree` (declared in types.ts). The predicate exists
 * so callers grep for the policy by name and so future logic (e.g.
 * conditional behaviour by ticket type) has one place to live.
 *
 * Caught the cosmetic "feature/27 push failed: src refspec doesn't
 * match any" bug surfaced on #27: PO's run had no commits, so the
 * dispatcher's unconditional `git push` failed. Gating the push on this
 * predicate removes the spurious failure.
 */
export function shouldUseWorktree(agent: AgentConfig): boolean {
  return agent.usesWorktree;
}

/**
 * The `claude --max-turns` budget for this agent's run.
 *
 * Code review gets 100 because it dispatches sub-agents (the parent
 * turn budget covers all child invocations). Everyone else gets the
 * base budget.
 *
 * **Base budget bumped 60 → 70 on 2026-05-03 (later afternoon)** after
 * three Mode-E max_turns events in one session (#128, #75, #99) all
 * hit at exactly turn 60-61, all caught merge-ready by safer-salvage,
 * all in the housekeeping phase (commit/docs polish/PROJECT-MEMORY
 * edit/qmd re-index). Pattern: implementation + tests landed cleanly,
 * cap hit during cleanup. The salvage backstop preserved the work in
 * each case ($4.74-$6.68 each), but draft-PR-then-mark-ready is
 * higher-friction than just shipping. 10 more turns covers the
 * housekeeping tail without weakening the forcing function.
 *
 * **Earlier history:** Base budget bumped 50 → 60 on 2026-05-02
 * after #55 hit the 50 cap on an S-sized e2e ticket. Distribution
 * analysis at the time: 7+ tickets clustered exactly AT 50 turns,
 * indicating the cap was binding. Combined with the architect-spec
 * "Files to read first" rule, 60 reclaimed most of the long tail.
 *
 * Re-evaluate after ~10 dispatched runs at 70. If Mode E recurs at
 * 70-71, the right move is per-size differentiation (XS=40, S=70,
 * e2e/refactor=90) rather than another flat bump — the Mode-E cluster
 * suggests housekeeping cost is roughly fixed regardless of impl size,
 * so smaller tickets are over-budgeted at the flat rate.
 */
export function maxTurnsFor(agent: AgentConfig): number {
  if (agent.name === "code-review") return 100;
  return 70;
}

// --------- Safer max_turns salvage ---------

/**
 * True when the dispatcher should attempt the safer-salvage path on a
 * `max_turns` failure: auto-commit the agent's uncommitted work, push
 * it, open a draft PR with the agent's last messages in the body, and
 * label the ticket `error:max_turns_salvaged` for human triage.
 *
 * Distinct from the existing PR-already-exists salvage (which treats
 * max_turns + open PR as success). This fires when the agent didn't
 * get to PR creation but did produce buildable code worth preserving.
 *
 * **All four gates must pass:**
 * 1. `terminalReason === "max_turns"` — other failure shapes (api_error,
 *    timeout) don't fit the salvage pattern.
 * 2. No PR already exists — the existing salvage path handles that case.
 * 3. Working tree has changes — nothing to salvage if the worktree is
 *    clean (the agent did no productive work).
 * 4. `go vet` AND `go build` both clean — don't ship broken code as a
 *    draft PR. Failing tests are fine (they're often the signal the
 *    agent was chasing); failing vet/build means the code itself is
 *    indeterminate.
 *
 * **Why a draft PR (not a regular PR + `ready:developer`):**
 * salvaged work is by definition incomplete (the agent stopped in the
 * middle). A regular PR risks silent auto-merge of broken or partial
 * work. A draft PR + `error:max_turns_salvaged` label keeps the work
 * visible while forcing a human triage step before it advances.
 *
 * Earned its slot from four observed independent failure modes:
 * - #55 run 1: comprehension surface (mode A)
 * - #29, #40, #45: edit fan-out (mode B)
 * - #55 run 2: developer found a real production bug, thrashed trying
 *   to fix it instead of bailing (mode C)
 * - #81: OS-service polling time eats budget (mode D)
 * In all four, the developer produced real value the dispatcher
 * silently destroyed via worktree teardown. Salvage preserves it.
 *
 * Pure decision; the caller does the I/O (commit, push, gh pr create,
 * label) so this stays testable.
 */
export function shouldAttemptSafeSalvage(opts: {
  terminalReason: string;
  prAlreadyExists: boolean;
  gitStatusOutput: string;
  vetExitCode: number;
  buildExitCode: number;
}): boolean {
  if (opts.terminalReason !== "max_turns") return false;
  if (opts.prAlreadyExists) return false;
  if (opts.gitStatusOutput.trim().length === 0) return false;
  if (opts.vetExitCode !== 0) return false;
  if (opts.buildExitCode !== 0) return false;
  return true;
}

/**
 * Parse the output of `gh pr list --head <branch> --state open --json
 * number,isDraft` and return the number of the first NON-DRAFT (ready)
 * PR, or null if none exists (no PRs at all, all are drafts, or the
 * input is unparseable).
 *
 * Used by the existing PR-already-exists salvage path. That path treats
 * `max_turns + open PR exists` as success (the agent finished the work
 * and ran out of turns on cleanup). But after the safer-salvage lever
 * shipped, an open PR for a branch is often a DRAFT opened by salvage
 * itself — partial work awaiting human triage. Treating it as success
 * would auto-advance partial work via `ready:<agent>`, defeating the
 * safer-salvage design's safety property.
 *
 * Defaults to "draft" when `isDraft` is missing — the cautious default.
 * False positive (treating ready as draft) wastes a dispatch turn but
 * doesn't auto-advance broken work. False negative (treating draft as
 * ready) silently advances partial work to code-review. Cost asymmetry
 * favors the cautious default.
 */
export function findReadyPrNumber(prListJson: string): number | null {
  let prs: Array<{ number?: number; isDraft?: boolean }>;
  try {
    prs = JSON.parse(prListJson);
  } catch {
    return null;
  }
  if (!Array.isArray(prs)) return null;
  for (const pr of prs) {
    if (typeof pr.number !== "number") continue;
    if (pr.isDraft === false) return pr.number;
  }
  return null;
}

/**
 * Detect whether a thrown error is a GitHub rate-limit failure, and
 * surface the reset deadline so the caller can sleep until reset
 * instead of cascading errors for the rest of the rate-limit window.
 *
 * Returns:
 * - `null` if the error is NOT a rate-limit (caller handles normally)
 * - `{ isRateLimited: true, resetUnixSeconds: <number> | null }` if
 *   it IS a rate-limit; the unix timestamp is from the
 *   `x-ratelimit-reset` header on the failed response if Octokit
 *   surfaced it, or null if not (caller falls back to a default sleep).
 *
 * Detection is by message text — GitHub's GraphQL API returns
 * "API rate limit already exceeded" and the REST API returns "API rate
 * limit exceeded"; we match both. The reset header is informational
 * only — its presence alone doesn't indicate rate-limit state (GitHub
 * returns it on every authenticated request).
 *
 * Last night's incident: dispatcher hit the 5000 points/hour limit and
 * cascaded errors for the next ~50 minutes until reset. With this
 * detection + a sleep loop in pollLoop, the dispatcher pauses cleanly
 * and resumes on the same cycle after reset.
 */
export function extractRateLimitInfo(err: unknown): {
  isRateLimited: true;
  resetUnixSeconds: number | null;
} | null {
  // Octokit shape — status + headers — is the most reliable signal.
  // GitHub localizes error message text and changes wording; relying on
  // the english "API rate limit … exceeded" string was a single point
  // of failure (review #12). Status codes are stable: 429 is the modern
  // rate-limit response; 403 with `x-ratelimit-remaining: 0` is the
  // legacy GraphQL flavour.
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  const headers = (err as any)?.response?.headers ?? (err as any)?.headers;
  const remainingRaw = headers?.["x-ratelimit-remaining"];
  const remaining = typeof remainingRaw === "string" ? parseInt(remainingRaw, 10)
                  : typeof remainingRaw === "number" ? remainingRaw
                  : null;

  let isRateLimited = false;
  if (status === 429) {
    isRateLimited = true;
  } else if (status === 403 && remaining === 0) {
    isRateLimited = true;
  }

  // Fallback for non-Octokit error shapes (Error from a thrown string,
  // wrapped library errors that drop status/headers): match the legacy
  // english text. Future localization breaks this fallback but the
  // status-code path above stays correct.
  if (!isRateLimited) {
    let message: string | null = null;
    if (err instanceof Error) message = err.message;
    else if (typeof err === "string") message = err;
    else if (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string") {
      message = (err as any).message;
    }
    if (message && message.includes("API rate limit") && message.includes("exceeded")) {
      isRateLimited = true;
    }
  }

  if (!isRateLimited) return null;

  let resetUnixSeconds: number | null = null;
  const headerValue = headers?.["x-ratelimit-reset"];
  if (typeof headerValue === "string") {
    const parsed = parseInt(headerValue, 10);
    if (!isNaN(parsed)) resetUnixSeconds = parsed;
  } else if (typeof headerValue === "number") {
    resetUnixSeconds = headerValue;
  }

  return { isRateLimited: true, resetUnixSeconds };
}

// --------- Spawn env hygiene ---------

/**
 * Environment variables that MUST NOT be passed to spawned `claude`
 * processes. These are dispatcher secrets and config; the spawned agent
 * doesn't need them and shouldn't see them.
 *
 * `GITHUB_TOKEN` is the canonical leak case — `claude` uses `gh`'s own
 * credential store (or `git credential helper`) for repo access; the
 * dispatcher's token would only enable the agent to act with the
 * dispatcher's identity (different scope, surprises in audit logs, and
 * bypasses any per-agent token rotation later).
 *
 * Denylist over allowlist deliberately: `claude` relies on a wide set of
 * env vars (PATH, HOME, LANG, LC_*, TMPDIR, NODE_*, ANTHROPIC_*, …) and
 * an allowlist would silently break new dependencies. A small denylist
 * keeps the secret-leak surface bounded without reducing flexibility.
 */
export const SPAWN_ENV_DENYLIST: ReadonlySet<string> = new Set([
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "PROJECT_NUMBER",
  "DISCORD_WEBHOOK_URL",
  "PYRY_MAX_CONCURRENT",
  "TARGET_REPO_PATH",
]);

/**
 * Filter dispatcher secrets/config out of an env map before spawning a
 * child agent. Returns a fresh object — does not mutate the input.
 */
export function scrubSpawnEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (SPAWN_ENV_DENYLIST.has(key)) continue;
    out[key] = value;
  }
  return out;
}
