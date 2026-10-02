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
 * Code review gets 150 because it dispatches sub-agents (the parent
 * turn budget covers all child invocations). Everyone else gets the
 * base budget.
 *
 * **All caps bumped +50% on 2026-06-06** (code-review 100 → 150,
 * base 90 → 135, qa 30 → 45) after a claude behavior change in which
 * the same work now consumes materially more turns, pushing real
 * implementation runs into the cap (e.g. mobile #346/#351 both jammed
 * the 90 cap at the commit boundary on 2026-06-02). The flat 50%
 * scaling preserves the relative ratios between roles and the
 * oversize-ticket forcing function; the wall-clock timeouts in
 * `timeoutFor` were deliberately left unchanged this round.
 *
 * **Base budget bumped 70 → 90 on 2026-05-20** after a turn-by-turn
 * log audit of the recent successful runs (#454: 68, #466: 65, #463:
 * 66, #459: 59, #450: 65, #453: 60) showed a cluster jammed against
 * the 70 cap on real implementation work — not housekeeping. The
 * 2026-05-19 trim of the knowledge-doc AC + PR body template was the
 * first response (saves ~1-3 turns on tickets where the doc was an
 * AC), but the data showed the binding constraint was implementation
 * + tests + verification on legitimately-sized S tickets, not a fixed
 * housekeeping tail. The per-size differentiation idea (XS=40, S=70,
 * e2e/refactor=90) predicted in the prior history was falsified by
 * #478 (size:s, still hit 71): housekeeping cost is fixed, but so is
 * the impl+test cost on S work — a flat bump is the right move when
 * BOTH are jammed against the cap. 20 more turns absorbs both classes
 * without making oversize tickets less detectable; the architect's
 * total-LOC red lines (2026-05-17 `6029238`) and the per-ticket-doc
 * trim (2026-05-19 `5183a67`) remain the forcing functions.
 *
 * **Earlier history:**
 * - Base budget bumped 60 → 70 on 2026-05-03 after three Mode-E
 *   max_turns events (#128, #75, #99) all hit at turn 60-61 in the
 *   housekeeping phase (commit/docs polish/PROJECT-MEMORY edit/qmd
 *   re-index). 10 more turns covered the housekeeping tail without
 *   weakening the forcing function.
 * - Base budget bumped 50 → 60 on 2026-05-02 after #55 hit the 50 cap
 *   on an S-sized e2e ticket. Distribution analysis: 7+ tickets
 *   clustered exactly AT 50 turns, indicating the cap was binding.
 *   Combined with the architect-spec "Files to read first" rule, 60
 *   reclaimed most of the long tail.
 *
 * Re-evaluate after ~10 dispatched runs at 90. If runs cluster at
 * 85-90, the cap is still binding and per-size differentiation finally
 * earns its keep. If runs land at 50-75, the bump was right and the
 * 2026-05-19 doc/PR-body trim accounts for the rest of the headroom.
 *
 * Every tier is multiplied by `PYRY_BUDGET_SCALE` (see `parseBudgetScale`).
 */
export function maxTurnsFor(agent: AgentConfig): number {
  const scaled = baseMaxTurns(agent) * parseBudgetScale(process.env.PYRY_BUDGET_SCALE);
  return Math.max(1, Math.round(scaled));
}

/**
 * Per-fork multiplier on every agent's turn and wall-clock budget, from
 * `PYRY_BUDGET_SCALE`. Unset, empty, non-numeric, zero or negative → 1, so
 * a fork that does not set it keeps the budgets in `maxTurnsFor` and
 * `timeoutFor` byte-for-byte.
 *
 * Added 2026-09-23 for pyrycode-mobile, which runs Opus 5.5 and raised its
 * ticket ceiling from 800 to 1600 lines. The first 50 Opus 5.5 builder runs
 * there peaked at a third of the builder's turns and time, so the budgets
 * were not binding; the scale keeps the same headroom ratio as tickets grow.
 * A multiplier rather than per-agent values keeps the relative ratios
 * between roles, the same reasoning as the flat +50% of 2026-06-06.
 */
export function parseBudgetScale(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function baseMaxTurns(agent: AgentConfig): number {
  // Config-carried override first: stage-set agents (stage-sets.ts) whose
  // budgets don't map onto the classic names declare them inline (the
  // builder set's builder=200 / verifier=150). No classic agent sets the
  // field, so classic budgets below are untouched.
  if (agent.maxTurns !== undefined) return agent.maxTurns;
  if (agent.name === "code-review") return 150;
  // QA: hot path (run gates → green → exit) is 5-10 turns; cold path
  // (red → baseline-comparison routing → triage comment + needs-rework
  // OR exit-with-message) is 15-25 turns. 45 leaves modest headroom
  // without blunting the forcing function — QA should NEVER drift into
  // judgment work (idiom/design) that lives in code-review.
  if (agent.name === "qa") return 45;
  return 135;
}

/**
 * Wall-clock timeout (ms) for an agent run, keyed off the role and the
 * ticket's labels. `timeoutLabel` (the DISPATCH-log "Timeout: Nmin"
 * string) is derived from this — `${timeoutFor(...) / 60_000}min`.
 *
 * Tiers:
 *  - code-review → 40min. Runs adversarial sub-agents (each round-trips
 *    through claude) and routinely needs the headroom.
 *  - security-sensitive architect → 40min. A `security-sensitive` ticket
 *    makes the architect write the spec AND run the adversarial
 *    security-review pass (`architect/security-review.md`) — structurally
 *    the same "produce an artifact + run a sub-agent audit" shape as
 *    code-review, so it shares the budget. The base 20min was not enough
 *    on pyrycode-mobile#304 (2026-05-31): the spec landed right at the
 *    20min mark and the review never started; because the salvage path
 *    skips timeout failures, the uncommitted spec was discarded.
 *  - developer / documentation / qa → 25min. QA is medium-tier because
 *    `go test -race ./...` on the full pyrycode suite (~346 tests as of
 *    2026-05-10) is 2-5min of wall-clock plus baseline-comparison triage
 *    on red.
 *  - everyone else (po, non-security architect) → 20min.
 *
 * `labels` is the ticket's current label set; callers without labels in
 * scope can omit it (defaults to none → base tiers only).
 *
 * Every tier is multiplied by `PYRY_BUDGET_SCALE` and rounded to whole
 * minutes, so the "Timeout: Nmin" label stays whole.
 */
export function timeoutFor(agent: AgentConfig, labels: string[] = []): number {
  if (agent.name === "builder" && process.env.PYRY_BUILDER_TIMEOUT_MINUTES !== undefined) {
    const raw = process.env.PYRY_BUILDER_TIMEOUT_MINUTES;
    if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 240) {
      throw new Error("PYRY_BUILDER_TIMEOUT_MINUTES must be a whole number from 1 to 240");
    }
    return Number(raw) * 60_000;
  }
  const scaled = baseTimeout(agent, labels) * parseBudgetScale(process.env.PYRY_BUDGET_SCALE);
  return Math.max(60_000, Math.round(scaled / 60_000) * 60_000);
}

function baseTimeout(agent: AgentConfig, labels: string[]): number {
  // Config-carried override first (flat — the label-conditional bump below
  // applies only to the name-keyed path). Used by the builder stage set's
  // builder + verifier (both 40min); no classic agent sets the field.
  if (agent.timeoutMs !== undefined) return agent.timeoutMs;
  if (agent.name === "code-review") return 2_400_000;
  if (agent.name === "architect" && labels.includes("security-sensitive")) {
    return 2_400_000;
  }
  if (["developer", "documentation", "qa"].includes(agent.name)) return 1_500_000;
  return 1_200_000;
}

// --------- Safer budget-exhaustion salvage ---------

/**
 * True when the dispatcher should attempt the safer-salvage path on a
 * budget-exhaustion failure: auto-commit the agent's uncommitted work,
 * push it, open a draft PR with the agent's last messages in the body,
 * and label the ticket `error:max_turns_salvaged` for human triage.
 *
 * Distinct from the existing PR-already-exists salvage (which treats
 * max_turns + open PR as success). This fires when the agent didn't
 * get to PR creation but did produce buildable code worth preserving.
 *
 * **All four gates must pass:**
 * 1. The agent ran out of budget: either `terminalReason === "max_turns"`
 *    (turn budget) or `timedOut` (wall-clock budget). Both mean "stopped
 *    mid-work with the worktree about to be torn down", which is the only
 *    thing this path cares about. Other shapes (api_error, a clean
 *    non-zero exit) are genuine failures and still skip salvage.
 *
 *    `timedOut` is the dispatcher's OWN record that it fired the SIGTERM,
 *    not an inference from claude's self-reported result. That matters:
 *    on a wall-clock kill claude still emits a `result`, but with
 *    `subtype=error_during_execution` and an EMPTY `terminal_reason`, so
 *    reading the reason alone cannot tell a timeout from any other wedge.
 *    The same ambiguity is already noted at the error-message site, which
 *    prints elapsed-vs-budget for exactly this reason.
 *
 *    Added 2026-08-10 after pyrycode#1452: a developer run was killed at
 *    its 25-minute wall on turn 104 having spent $11.91, this gate read
 *    the empty reason, salvage was skipped, and the worktree teardown
 *    destroyed every edit — the branch kept only the architect's spec
 *    commit. The previous wording of this gate claimed timeout "doesn't
 *    fit the salvage pattern"; #1452 refutes it. A wall-clock kill with a
 *    dirty worktree IS the pattern, and gates 2-4 below carry the entire
 *    safety argument on their own without caring which budget ran out.
 *    pyrycode#1417 the day before is the control: same thrash, same
 *    25-minute wall, but it exited via the permission-denial door, a
 *    different salvage fired, the work was pushed, and the next run
 *    finished it from that branch.
 * 2. No PR already exists — the existing salvage path handles that case.
 * 3. Working tree has changes, or the committed branch differs from
 *    the default branch. An agent can commit and push before timing
 *    out on PR creation; a clean worktree does not imply no work.
 * 4. All configured salvage gates exit 0 — don't ship broken code as a
 *    draft PR. Default gates are Go-specific (`go vet ./...` and
 *    `go build ./...`); consumers in other ecosystems override via the
 *    `SALVAGE_GATES` env var (`;`-delimited shell commands). An empty
 *    list means "no gating" — consumer opted out. Failing tests are fine
 *    (they're often the signal the agent was chasing); failing build
 *    gates mean the code itself is indeterminate.
 *
 * **Why a draft PR (not a regular PR + `done:developer`):**
 * salvaged work is by definition incomplete (the agent stopped in the
 * middle). A regular PR risks silent auto-merge of broken or partial
 * work. A draft PR + `error:max_turns_salvaged` label keeps the work
 * visible while forcing a human triage step before it advances.
 *
 * Earned its slot from five observed independent failure modes:
 * - #55 run 1: comprehension surface (mode A)
 * - #29, #40, #45: edit fan-out (mode B)
 * - #55 run 2: developer found a real production bug, thrashed trying
 *   to fix it instead of bailing (mode C)
 * - #81: OS-service polling time eats budget (mode D)
 * - pyrycode#1452: line-cite bookkeeping eats the wall clock (mode E,
 *   and the first to arrive through the timeout door)
 * In all five, the developer produced real value the dispatcher
 * silently destroyed via worktree teardown. Salvage preserves it.
 *
 * NOTE the label `error:max_turns_salvaged` is now shape-inaccurate for
 * a timeout salvage. It is kept deliberately: the label's FUNCTION is
 * "salvaged work sits in a draft PR, block every agent until a human
 * triages", it is wired into `GLOBAL_BLOCK_LABELS` and the selection
 * filter, and renaming it would strand tickets already carrying it. The
 * triage comment and PR body name the real shape instead.
 *
 * Pure decision; the caller does the I/O (commit, push, gh pr create,
 * label) so this stays testable.
 */
export function shouldAttemptSafeSalvage(opts: {
  terminalReason: string;
  /**
   * True when the dispatcher itself killed the agent at its wall-clock
   * budget. Authoritative, unlike `terminalReason`, which a timeout
   * leaves empty. See gate 1 above.
   */
  timedOut: boolean;
  prAlreadyExists: boolean;
  gitStatusOutput: string;
  /** Committed branch content differs from its merge base with the default branch. */
  hasCommittedChanges?: boolean;
  /**
   * Exit codes from each configured salvage gate, in execution order.
   * All must be 0 for salvage to proceed. Empty array = no gating
   * (consumer opted out via empty `SALVAGE_GATES` env var).
   */
  gateExitCodes: number[];
}): boolean {
  if (opts.terminalReason !== "max_turns" && !opts.timedOut) return false;
  if (opts.prAlreadyExists) return false;
  if (opts.gitStatusOutput.trim().length === 0 && !opts.hasCommittedChanges) return false;
  if (opts.gateExitCodes.some((code) => code !== 0)) return false;
  return true;
}

/**
 * Parse the `SALVAGE_GATES` env var into a list of shell commands.
 *
 * Format: `;`-delimited shell commands; each runs in the agent's
 * worktree. All must exit 0 for `shouldAttemptSafeSalvage` to fire.
 *
 * - **Unset** (`undefined`): defaults to the legacy Go pair
 *   `["go vet ./...", "go build ./..."]` for back-compat with pyrycode
 *   + pyrycode-relay. Forks targeting other ecosystems set the env var
 *   explicitly.
 * - **Empty string** (`""`): zero gates — `shouldAttemptSafeSalvage`
 *   skips the gate check entirely. Useful for consumers in ecosystems
 *   without cheap precommit gates, or who prefer human triage at PR
 *   review.
 * - **Set**: split on `;`, trim each segment, drop empties. So `"cargo
 *   check; cargo build"`, `";cargo check;;"`, and `"cargo check  ;
 *   cargo build  "` all yield two-gate or one-gate clean lists.
 *
 * Pure decision; the caller (`attemptSaferSalvage` in dispatch.ts) does
 * the `execSync` per gate and threads exit codes back here.
 */
/**
 * Startup pre-flight that classifies the canonical `.codegraph/` index
 * into one of three operator-facing states:
 *
 * - **missing**: no `.codegraph/` at all. Agents fall through to grep.
 *   Bootstrap recommended (`codegraph init -i` at the target repo root).
 * - **queryable**: index exists, `codegraph status` agrees. Good to go;
 *   spawned agents will see real symbol data through the worktree
 *   symlink.
 * - **broken**: index exists but `codegraph status` says it isn't
 *   usable. Surfaces broken self-ref symlinks, schema mismatches, db
 *   corruption, wrong-project indexes — all the cases where existsSync
 *   says "true" but the index can't actually answer queries. Warn
 *   loudly so the operator notices at boot, before a dispatch silently
 *   degrades. Particularly important after the 2026-05-09 self-ref
 *   symlink incident: existsSync returned true on the bad symlink (it
 *   existed as a symlink), but every codegraph query through the
 *   worktree symlink hit ELOOP and returned no data.
 *
 * Don't fail-fast on broken — codegraph isn't load-bearing; agents fall
 * through to grep. The point is operator visibility at boot, not
 * blocking the dispatcher.
 *
 * Pure decision; the caller (`dispatch-bin.ts`) does the `existsSync`
 * + `spawnSync("codegraph", ["status", ...])` and threads the results
 * back here.
 */
export function decideCodegraphHealth(opts: {
  exists: boolean;
  /** spawnSync's `.status` — number on normal exit, null when the
   *  binary couldn't be spawned at all (ENOENT, PATH miss, etc.). */
  statusExitCode: number | null;
  statusStdout: string;
  statusStderr: string;
}): { state: "missing" | "queryable" | "broken"; detail: string } {
  if (!opts.exists) {
    return { state: "missing", detail: "no .codegraph/ at the canonical path" };
  }
  if (opts.statusExitCode !== 0) {
    const detail = opts.statusStderr.trim() || opts.statusStdout.trim() || `codegraph status exited with ${opts.statusExitCode}`;
    return { state: "broken", detail };
  }
  // Codegraph CLI returns exit 0 on `Not initialized` (it's an
  // informational state, not an error). Treat the message in stdout as
  // authoritative — broken self-ref symlinks land here.
  if (/not initialized/i.test(opts.statusStdout)) {
    return { state: "broken", detail: opts.statusStdout.trim() };
  }
  if (/error/i.test(opts.statusStderr)) {
    return { state: "broken", detail: opts.statusStderr.trim() };
  }
  return { state: "queryable", detail: "ok" };
}

/**
 * Pre-flight check: list any agent whose CLAUDE.md file is missing from
 * the consumer's agents repo. Empty array means all CLAUDE.mds resolve.
 *
 * **Why this exists.** Pre-2026-05-09, the dispatcher source lived
 * inside each consumer's agents repo and a `lib.test.ts` test verified
 * each agent's CLAUDE.md existed on disk. After the dispatcher was
 * extracted into `pyrycode/agent-dispatcher`, that test moved out
 * because the standalone dispatcher doesn't own per-agent CLAUDE.md
 * files. The runtime "agent CLAUDE.md not found" error in `dispatch.ts`
 * still catches missing files mid-dispatch — but only when that agent
 * actually gets dispatched, which can be hours after startup. This
 * surfaces the gap at startup instead.
 *
 * Reports ALL missing files in one shot (don't bail on the first) so
 * an operator setting up a fresh fork sees every gap at once, fixes
 * them together, and doesn't run-fail-run-fail.
 *
 * Pure decision; the caller (`dispatch-bin.ts`) does the `existsSync`
 * calls and the `process.exit(1)` on non-empty result.
 */
export function findMissingAgentClaudeMds(opts: {
  agents: ReadonlyArray<{ name: string; claudeMdPath: string }>;
  agentsRepoRoot: string;
  existsSync: (path: string) => boolean;
}): Array<{ name: string; path: string }> {
  const missing: Array<{ name: string; path: string }> = [];
  for (const agent of opts.agents) {
    const path = `${opts.agentsRepoRoot}/${agent.claudeMdPath}`;
    if (!opts.existsSync(path)) {
      missing.push({ name: agent.name, path });
    }
  }
  return missing;
}

export function parseSalvageGates(envValue: string | undefined): string[] {
  if (envValue === undefined) {
    return ["go vet ./...", "go build ./..."];
  }
  return envValue
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse the `PYRY_VERIFIER_GATES` env var — the deterministic gate
 * commands the dispatcher itself runs in the ticket's worktree before
 * spawning the builder stage set's verifier agent (see
 * `maybeRunPreSpawnGates` in dispatch.ts). Classic stage set: never read.
 *
 * Deliberately the exact same parsing contract as `SALVAGE_GATES`
 * (delegates to `parseSalvageGates`):
 * - **Unset**: the Go pair `go vet ./...` + `go build ./...`.
 * - **Empty string**: zero gates — the pre-verifier gate step is skipped
 *   entirely (consumer opted out).
 * - **Set**: `;`-delimited shell commands, trimmed, empties dropped. A
 *   fork's `.env` sets the full list, e.g.
 *   `PYRY_VERIFIER_GATES="make check;make build"`.
 */
export function parseVerifierGates(envValue: string | undefined): string[] {
  return parseSalvageGates(envValue);
}

// --------- Same-dispatch resume-in-place (continuation legs) ---------
//
// When a run exhausts its turn budget or wall clock, the dispatcher can
// resume the SAME claude session with a fresh budget — same dispatch,
// same worktree — before falling back to salvage. Most budget
// exhaustions are "ran out mid-task", not "stuck", so one continuation
// leg converts most human interruptions into automatic completions.
// The pure pieces live here; dispatch.ts does the spawn.

/**
 * Stream-loop reducer: capture the session id from the FIRST event that
 * carries one. Spike-proven on claude CLI 2.1.239 (2026-08-31): every
 * stream-json event carries `session_id` and the `system/init` frame
 * arrives within seconds of spawn, while a run killed by SIGTERM/SIGKILL
 * emits NO result frame at all — so capturing at init time is the only
 * reliable way to keep the id on the kill paths. First carrier wins;
 * later events never overwrite (same session anyway — this just keeps
 * the reducer deterministic).
 */
export function captureSessionId(current: string, msg: Record<string, unknown>): string {
  if (current) return current;
  const sid = msg.session_id;
  return typeof sid === "string" && sid.length > 0 ? sid : current;
}

/**
 * Final session id for a StreamResult: the result frame's value wins
 * when present (it is claude's authoritative self-report); the
 * init-captured value fills in when no result frame ever arrived
 * (timeout/kill paths, denial force-exit).
 */
export function pickFinalSessionId(resultSessionId: unknown, initSessionId: string): string {
  return typeof resultSessionId === "string" && resultSessionId.length > 0
    ? resultSessionId
    : initSessionId;
}

/**
 * Parse the `PYRY_RESUME_LEGS` env var: how many continuation legs a
 * budget-exhausted run may get before salvage.
 *
 * - **Unset / empty**: 1 — the pilot default. One fresh budget catches
 *   the common "ran out mid-task" shape without letting a genuinely
 *   stuck run burn budgets forever.
 * - **0**: feature disabled — dispatch behaviour is byte-identical to
 *   the pre-resume dispatcher (proven by tests).
 * - **N > 0**: up to N continuation legs.
 * - **Negative**: treated as 0 (a below-zero budget reads as "off").
 * - **Garbage / NaN**: falls back to the default of 1 — a typo in the
 *   knob should not silently disable the safety net.
 */
export function parseResumeLegs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return 1;
  return n < 0 ? 0 : n;
}

/**
 * True when the dispatcher should resume the exhausted run in place —
 * spawn a continuation leg of the SAME claude session with a fresh
 * budget — instead of going straight to the salvage paths.
 *
 * **All five gates must pass:**
 * 1. The run ended by budget exhaustion: `terminalReason === "max_turns"`
 *    (turn budget) or `timedOut` (the dispatcher's own wall-clock
 *    SIGTERM — authoritative, since a killed run's terminal reason is
 *    empty; see `shouldAttemptSafeSalvage` gate 1).
 * 2. A session id was captured. `--resume` needs it; without one there
 *    is nothing to resume into (the init-frame capture makes this
 *    nearly always available — see `captureSessionId`).
 * 3. The run executed in a worktree. The continuation leg re-enters the
 *    same cwd; a non-worktree agent (PO) mutates external state where
 *    "continue where you left off" has no branch to anchor to.
 * 4. Legs remain: `legsUsed < maxLegs` (`PYRY_RESUME_LEGS`, default 1;
 *    0 disables the feature entirely).
 * 5. NOT a permission denial. A denial is a policy stop, not a budget
 *    stop — resuming would re-attempt the denied operation with a
 *    fresh budget. Denials keep their existing salvage path.
 *
 * Pure decision; `maybeResumeExhaustedRun` in dispatch.ts does the
 * spawn, logging, and outcome merging.
 */
export function shouldAttemptResume(opts: {
  terminalReason: string;
  /** True when the dispatcher itself killed the agent at its wall-clock
   *  budget. See `shouldAttemptSafeSalvage` for why this flag, not the
   *  terminal reason, is the timeout signal. */
  timedOut: boolean;
  sessionId: string;
  usedWorktree: boolean;
  hadPermissionDenial: boolean;
  /** Continuation legs already consumed in this dispatch (0 before the
   *  first resume). */
  legsUsed: number;
  /** From `parseResumeLegs(process.env.PYRY_RESUME_LEGS)`. */
  maxLegs: number;
}): boolean {
  if (opts.terminalReason !== "max_turns" && !opts.timedOut) return false;
  if (!opts.sessionId) return false;
  if (!opts.usedWorktree) return false;
  if (opts.legsUsed >= opts.maxLegs) return false;
  if (opts.hadPermissionDenial) return false;
  return true;
}

/**
 * Argv for a continuation leg.
 *
 * **Pilot bridge: always the `claude` binary, regardless of
 * PYRY_USE_LEGACY_CLAUDE.** The `pyry agent-run` wrapper (the default
 * spawn since the 2026-05-14 Phase C cutover) has no resume support
 * yet, so the resume leg goes through the claude CLI directly until it
 * does. The properties the wrapper exists for still hold here: argv-only
 * (no shell), prompt piped on stdin, stream-json on stdout.
 *
 * Spike-proven (claude CLI 2.1.239): permissions and flags do NOT carry
 * over on `--resume`, so every flag is re-passed — model, effort,
 * max-turns (per-invocation, hence the fresh budget), allowedTools,
 * disallowedTools, and the system-prompt file. `--verbose` is required
 * with stream-json.
 */
export function buildResumeArgv(opts: {
  sessionId: string;
  model: string;
  effort: string;
  maxTurns: number;
  allowedTools: string;
  disallowedTools: string;
  systemPromptFile: string;
}): { bin: "claude"; args: string[] } {
  return {
    bin: "claude",
    args: [
      "-p",
      "--verbose",
      "--output-format", "stream-json",
      "--resume", opts.sessionId,
      "--model", opts.model,
      "--effort", opts.effort,
      "--max-turns", String(opts.maxTurns),
      "--allowedTools", opts.allowedTools,
      ...(opts.disallowedTools ? ["--disallowedTools", opts.disallowedTools] : []),
      "--append-system-prompt-file", opts.systemPromptFile,
    ],
  };
}

/**
 * Continuation prompt piped on the resume leg's stdin. The resumed
 * session has its full history (including partial tool calls from a
 * killed run), so the prompt only needs to orient: which budget ran
 * out, that the worktree/branch survived, and what "finish" means.
 */
export function buildResumePrompt(reason: "max_turns" | "timeout"): string {
  const budget = reason === "max_turns"
    ? "its turn budget (max turns)"
    : "its wall-clock time limit";
  return [
    `Your previous run hit ${budget} mid-task and was stopped. This is a continuation of the same session with a fresh budget.`,
    "",
    "The worktree and branch are intact — every file edit and commit you made is still there. Check `git status` and `git log` to see exactly where you stopped, then continue without redoing completed work.",
    "",
    "Finish the remaining work. Run the gates, and when they pass, commit and push.",
    "",
  ].join("\n");
}

/**
 * Merge a continuation leg's StreamResult into the run-so-far view, for
 * the USAGE log line and the downstream success path.
 *
 * - **Terminal fields** (output, error state, terminal reason, raw
 *   result, denial state, timedOut) come from the LAST leg — it
 *   describes how the run actually ended.
 * - **Turns, cost, duration sum** across legs, so the USAGE line
 *   reports what the whole dispatch consumed and the wall clock spans
 *   all legs.
 * - **Token counters** the USAGE line reads (input/output/cache read/
 *   cache creation) sum when either side has them; other usage keys
 *   keep the last leg's value.
 * - **Session id**: the last leg's, falling back to the first's (same
 *   session either way — `--resume` continues it, not forks it).
 *
 * Generic over the concrete StreamResult shape (defined in dispatch.ts)
 * to keep this module import-cycle-free.
 */
export function mergeLegResults<T extends {
  sessionId: string;
  numTurns: number;
  totalCostUsd: number;
  durationMs: number;
  usage: Record<string, unknown>;
}>(first: T, leg: T): T {
  const TOKEN_KEYS = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ] as const;
  const usage: Record<string, unknown> = { ...first.usage, ...leg.usage };
  for (const key of TOKEN_KEYS) {
    const a = first.usage[key];
    const b = leg.usage[key];
    if (typeof a === "number" || typeof b === "number") {
      usage[key] = (typeof a === "number" ? a : 0) + (typeof b === "number" ? b : 0);
    }
  }
  return {
    ...leg,
    sessionId: leg.sessionId || first.sessionId,
    numTurns: first.numTurns + leg.numTurns,
    totalCostUsd: first.totalCostUsd + leg.totalCostUsd,
    durationMs: first.durationMs + leg.durationMs,
    usage,
  };
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
 * would auto-advance partial work via `done:<agent>`, defeating the
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

// --------- Spawn retry on transient resource exhaustion ---------

/**
 * `posix_spawn` errnos that signal *temporary* resource pressure on the
 * host — retrying after a short backoff almost always succeeds.
 *
 * - **EAGAIN** ("Resource temporarily unavailable"): typically RLIMIT_NPROC
 *   exhaustion from accumulated zombie/leaked subprocesses. Bounded by
 *   the time it takes the kernel to reap zombies / the operator to clear
 *   the leak — minutes, not hours.
 * - **ENOMEM** ("Cannot allocate memory"): host memory pressure. Same
 *   pattern — transient, bounded.
 *
 * EMFILE/ENFILE (file descriptor exhaustion) are also transient but not
 * yet observed; add when evidence shows up.
 *
 * Source: agent-dispatcher#9 (2026-05-15 22:51Z EAGAIN cascade — five PO
 * spawns failed in a 17-second window with 485/4000 NPROC at the time of
 * post-mortem, confirming transience).
 */
export const RETRYABLE_SPAWN_ERRNOS: ReadonlySet<string> = new Set([
  "EAGAIN",
  "ENOMEM",
]);

/**
 * Default backoff schedule between failed spawn attempts, in ms.
 *
 * Five attempts total. Wait 1s after attempt 1 fails (before attempt 2),
 * 2s before attempt 3, etc. The fifth (final) failure throws
 * `ResourceExhaustedError` immediately — no terminal sleep, since there's
 * no sixth attempt for it to delay.
 *
 * Worst-case wall-clock for the retry sequence: 1+2+4+8 = 15s of waits
 * between five quick spawn failures. Generous enough to outwait a
 * subprocess-reap cycle; short enough that an operator-visible "stuck"
 * dispatch is rare.
 */
export const SPAWN_RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 2000, 4000, 8000];

/** Total spawn attempts (including the first). */
export const MAX_SPAWN_ATTEMPTS = 5;

/**
 * Thrown by `retrySpawnOnTransientError` when every attempt failed with
 * a retryable errno. Distinct type so callers (handleDispatchError) can
 * differentiate "couldn't even spawn" from "agent crashed mid-run" and
 * apply a distinct label (`error:<agent>:resource_exhausted` vs
 * `error:<agent>`).
 */
export class ResourceExhaustedError extends Error {
  readonly errno: string;
  readonly attempts: number;
  constructor(errno: string, attempts: number) {
    super(
      `Failed to spawn agent process after ${attempts} retries (final errno: ${errno}). ` +
        `Likely transient host resource exhaustion (RLIMIT_NPROC / available memory).`,
    );
    this.name = "ResourceExhaustedError";
    this.errno = errno;
    this.attempts = attempts;
  }
}

/**
 * True iff `err` looks like a Node `posix_spawn` failure with a
 * retryable errno. Tolerates plain `Error` instances with a `.code`
 * property (the shape Node throws on `child.on("error", ...)` for
 * spawn failures) and unstructured/unknown values (returns false).
 */
export function isRetryableSpawnError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && RETRYABLE_SPAWN_ERRNOS.has(code);
}

/**
 * Run `attempt` up to `maxAttempts` times, retrying with bounded backoff
 * when it rejects with a retryable spawn errno (EAGAIN/ENOMEM).
 *
 * Non-retryable errors propagate immediately — the caller's existing
 * error path handles them as today. After every retryable attempt is
 * exhausted, throws `ResourceExhaustedError` carrying the final errno.
 *
 * Pure logic; the caller injects the side-effecting `attempt` (spawn +
 * stream consumption) and optional `sleep` / `logger` for testability.
 *
 * @param opts.delaysMs - Backoff schedule. `delaysMs[i-1]` is the wait
 *   after attempt `i` fails (before attempt `i+1`). The final attempt's
 *   failure throws without sleeping.
 * @param opts.maxAttempts - Total attempts including the first.
 * @param opts.sleep - Override for testability. Defaults to setTimeout.
 * @param opts.logger - Optional INFO-level retry logger. Receives one
 *   line per retry (`spawn EAGAIN: attempt 1/5 failed, retrying in 1000ms`).
 */
export async function retrySpawnOnTransientError<T>(
  attempt: () => Promise<T>,
  opts?: {
    delaysMs?: ReadonlyArray<number>;
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    logger?: (msg: string) => void;
  },
): Promise<T> {
  const delays = opts?.delaysMs ?? SPAWN_RETRY_DELAYS_MS;
  const max = opts?.maxAttempts ?? MAX_SPAWN_ATTEMPTS;
  const sleep =
    opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts?.logger ?? (() => {});
  let lastErrno = "unknown";
  for (let i = 1; i <= max; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isRetryableSpawnError(err)) throw err;
      lastErrno = (err as NodeJS.ErrnoException).code ?? "unknown";
      if (i === max) break;
      const delay = delays[i - 1] ?? delays[delays.length - 1] ?? 0;
      log(`spawn ${lastErrno}: attempt ${i}/${max} failed, retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw new ResourceExhaustedError(lastErrno, max);
}

// --------- Permission-denial detection + watchdog (#8 Layer 2) ---------

/**
 * True iff `msg` is a claude stream-json `user` event carrying a
 * permission-denied `tool_result` from the dispatcher's tool-call gate.
 *
 * Claude emits these in a fixed shape when a Bash tool call hits the
 * dispatcher's allowlist denial:
 *
 *   { "type": "user", "message": { "role": "user", "content": [{
 *       "type": "tool_result",
 *       "is_error": true,
 *       "content": "Permission to use Bash with command <cmd> has been denied.",
 *       "tool_use_id": "..."
 *   }]}}
 *
 * Detection is the conjunction of three independent fields (type,
 * is_error, substring) — false-positive risk is very low. Substring
 * `"Permission to use"` AND `"has been denied"` is claude-generated
 * (not user-influenceable in this position), so user-supplied content
 * cannot trip it.
 *
 * Returns the `tool_result.content` string when matched (so the caller
 * can quote the denied operation back to the operator), or null.
 *
 * Source: pyrycode/pyrycode#398 JSONL trace (2026-05-15 overnight).
 */
export function detectPermissionDenial(msg: unknown): { content: string } | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "user") return null;
  const message = m.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_result") continue;
    if (b.is_error !== true) continue;
    const blockContent = typeof b.content === "string" ? b.content : null;
    if (!blockContent) continue;
    if (
      blockContent.includes("Permission to use") &&
      blockContent.includes("has been denied")
    ) {
      return { content: blockContent };
    }
  }
  return null;
}

/**
 * Watchdog state for the permission-denial Layer 2 detector. Threaded
 * through the stream-parsing loop as a pure state machine:
 *
 * - `hadPermissionDenial` flips true at the first denial and never
 *   clears — downstream uses it to apply
 *   `error:<agent>:permission_denied`.
 * - `watchdogPending` flips true on detection and clears as soon as the
 *   agent's next assistant event arrives. If that event is a `tool_use`
 *   (workaround attempt), the state machine emits `forceExit` and the
 *   driver SIGTERMs the child — Layer 1 missed; Layer 2 enforces the
 *   stop. If it's text-only (clean Layer 1 exit), the watchdog clears
 *   silently and the stream winds down on its own.
 * - `stoppedAtDenial` is true while no `tool_use` has followed the most
 *   recent denial. At stream end it says whether the agent stopped at a
 *   denial or carried on past it. A clean exit only routes as
 *   permission-denied when it stopped there (pyrycode#2586).
 * - `deniedContent` captures the first denial's `tool_result.content`
 *   so the post-run comment can quote the denied op back to the operator.
 * - `lastAssistantText` is the most recent assistant text block (the
 *   agent's "intent" — what it was trying to do). Captured for the
 *   diagnostic comment.
 */
export interface PermissionDenialState {
  hadPermissionDenial: boolean;
  watchdogPending: boolean;
  stoppedAtDenial: boolean;
  deniedContent: string | null;
  lastAssistantText: string | null;
}

export function initPermissionDenialState(): PermissionDenialState {
  return {
    hadPermissionDenial: false,
    watchdogPending: false,
    stoppedAtDenial: false,
    deniedContent: null,
    lastAssistantText: null,
  };
}

/** Side-effect signal the stream-driver should perform after advancing
 *  the state machine. Driver maps to: append log line, SIGTERM the
 *  child, or no-op. */
export type StreamWatchdogAction = "none" | "logDenial" | "forceExit";

/**
 * Advance the watchdog state machine on one parsed stream-json message.
 *
 * **Design choice (deviates from literal ticket text "force-exit on
 * detection"):** the watchdog gives the agent one turn-boundary of grace
 * to comply with Layer 1's CLAUDE.md rule (emit a single text message
 * naming the denied op, then end the turn). Only if the next assistant
 * event is *another* `tool_use` does the driver force-exit. A clean
 * text-only message clears the watchdog silently and the stream winds
 * down on its own.
 *
 * Rationale: a literal force-exit-on-first-denial bypasses Layer 1
 * entirely — the agent never gets its clean-exit slot, and the
 * dispatcher's "different fabric" safety net effectively replaces the
 * stochastic rule instead of backing it up. The watchdog keeps Layer 2
 * deterministic when Layer 1 fails while preserving Layer 1's value
 * when it works.
 *
 * Pure: no I/O. Driver is responsible for the SIGTERM + 2s SIGKILL
 * grace timer + log writes.
 */
export function advancePermissionDenialState(
  state: PermissionDenialState,
  msg: unknown,
): { state: PermissionDenialState; action: StreamWatchdogAction } {
  // Denial event always wins (even if it co-arrives with assistant text
  // in the same parse window — which doesn't happen in claude's stream
  // shape, but the check is defensive).
  const denial = detectPermissionDenial(msg);
  if (denial) {
    return {
      state: {
        ...state,
        hadPermissionDenial: true,
        // First denial wins — keep the original op visible to the
        // operator even if claude emits subsequent denials before
        // force-exit lands.
        deniedContent: state.deniedContent ?? denial.content,
        watchdogPending: true,
        stoppedAtDenial: true,
      },
      action: "logDenial",
    };
  }

  if (!msg || typeof msg !== "object") return { state, action: "none" };
  const m = msg as Record<string, unknown>;
  if (m.type !== "assistant") return { state, action: "none" };
  const message = m.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return { state, action: "none" };

  let sawToolUse = false;
  let lastText: string | null = state.lastAssistantText;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use") sawToolUse = true;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
      lastText = b.text;
    }
  }

  if (state.watchdogPending && sawToolUse) {
    // Workaround attempt — Layer 1 missed. Force-exit.
    return {
      state: { ...state, lastAssistantText: lastText, watchdogPending: false, stoppedAtDenial: false },
      action: "forceExit",
    };
  }
  if (state.watchdogPending && !sawToolUse) {
    // Clean text-only emission — Layer 1 worked. Clear watchdog,
    // stream winds down naturally.
    return {
      state: { ...state, lastAssistantText: lastText, watchdogPending: false },
      action: "none",
    };
  }
  return {
    state: { ...state, lastAssistantText: lastText, stoppedAtDenial: state.stoppedAtDenial && !sawToolUse },
    action: "none",
  };
}

// --------- Idle-stream watchdog (claude runner) ---------

/**
 * Default idle threshold for the claude runner's stream watchdog, in
 * minutes. Override with `PYRY_AGENT_IDLE_TIMEOUT_MINUTES`; `0` disables.
 *
 * Why it exists. On 2026-10-02 pyrycode-mobile #1430's documentation run
 * went silent: its log shows four system stream messages between 05:03:30
 * and 05:05:17, then nothing until 05:25:10, and the 38-minute wall clock
 * killed it at 05:31 with finished edits uncommitted. Claude's own
 * transcript shows the gap sat inside ONE assistant turn: a thinking block
 * arrived at 05:05:17 and the Edit that followed it took twenty minutes to
 * come back. The API stream had wedged mid-turn.
 *
 * pyry's own streamrunner watchdog (pyrycode#360, 240s) did not catch it.
 * That watchdog only arms while claude "owes" an assistant turn, and the
 * thinking block counted as the turn arriving, so the wedge after it was
 * invisible. This watchdog keys on the opposite fact: is a TOOL running?
 * If no tool call is outstanding, claude itself is the only thing that can
 * be working, and N minutes of silence from it is a stall, whichever
 * content block it was in the middle of.
 *
 * Neither claude spawn passes `--include-partial-messages` (the dispatcher's
 * legacy `claude -p` argv does not, and pyry agent-run's BuildClaudeArgs
 * does not), so a line arrives only per finished content block, tool result
 * or system notice. A long legitimate block is therefore silent until it
 * completes. Ten minutes clears a full 32k-token output block at observed
 * generation rates with room to spare; the per-ticket retry cap bounds a
 * false positive.
 */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;

/**
 * Parse `PYRY_AGENT_IDLE_TIMEOUT_MINUTES` into milliseconds.
 *
 * - **Unset / empty**: the 10-minute default.
 * - **0**: watchdog disabled.
 * - **Positive number**: that many minutes (fractions allowed).
 * - **Negative**: treated as 0 (off), matching `parseResumeLegs`.
 * - **Garbage / NaN**: falls back to the default. A typo in the knob
 *   should not silently disable the safety net.
 */
export function parseIdleTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_TIMEOUT_MINUTES * 60_000;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return DEFAULT_IDLE_TIMEOUT_MINUTES * 60_000;
  return n <= 0 ? 0 : Math.round(n * 60_000);
}

/**
 * The substring every idle-stall failure carries. `RETRY_ALLOWLIST`
 * (pipeline-decisions.ts) matches it, so a stalled run is classified as
 * transient and re-dispatched with backoff instead of parking. pyry's own
 * watchdog emits the same token, so both detectors share one retry path.
 */
export const IDLE_STALL_REASON = "idle_stall";

/** The error text a dispatcher-detected stall fails with. */
export function idleStallMessage(idleMs: number): string {
  const minutes = Math.round((idleMs / 60_000) * 10) / 10;
  return `Agent ${IDLE_STALL_REASON}: no stream output for ${minutes}min with no tool call outstanding`;
}

/**
 * Watchdog state, advanced once per stream-json line.
 *
 * - `lastLineAt`: when the last line of any kind arrived. Every line is
 *   activity, including system notices and lines that fail to parse.
 * - `outstandingToolIds`: `tool_use` ids the agent has issued whose
 *   `tool_result` has not come back yet. While this is non-empty a tool is
 *   running, and a tool such as a Gradle test run legitimately prints
 *   nothing for many minutes; the wall clock bounds that case instead.
 */
export interface IdleWatchdogState {
  lastLineAt: number;
  outstandingToolIds: ReadonlySet<string>;
}

export function initIdleWatchdogState(now: number): IdleWatchdogState {
  return { lastLineAt: now, outstandingToolIds: new Set() };
}

function contentBlocks(msg: Record<string, unknown>): Record<string, unknown>[] {
  const message = msg.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
}

/**
 * Advance the watchdog on one stream line. `msg` is the parsed JSON, or
 * null for a line that did not parse (still activity). Assistant
 * `tool_use` blocks add their id; user `tool_result` blocks remove theirs.
 *
 * Pure: no I/O, no clock. The driver passes `now`.
 */
export function advanceIdleWatchdogState(
  state: IdleWatchdogState,
  msg: unknown,
  now: number,
): IdleWatchdogState {
  let outstanding = state.outstandingToolIds;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (m.type === "assistant") {
      for (const b of contentBlocks(m)) {
        if (b.type === "tool_use" && typeof b.id === "string") {
          if (outstanding === state.outstandingToolIds) outstanding = new Set(outstanding);
          (outstanding as Set<string>).add(b.id);
        }
      }
    } else if (m.type === "user") {
      for (const b of contentBlocks(m)) {
        if (b.type === "tool_result" && typeof b.tool_use_id === "string" && outstanding.has(b.tool_use_id)) {
          if (outstanding === state.outstandingToolIds) outstanding = new Set(outstanding);
          (outstanding as Set<string>).delete(b.tool_use_id);
        }
      }
    }
  }
  return { lastLineAt: now, outstandingToolIds: outstanding };
}

/**
 * True when the run has stalled: the watchdog is enabled, no tool call is
 * outstanding, and nothing has arrived for at least `idleMs`.
 */
export function shouldFireIdleWatchdog(
  state: IdleWatchdogState,
  now: number,
  idleMs: number,
): boolean {
  if (idleMs <= 0) return false;
  if (state.outstandingToolIds.size > 0) return false;
  return now - state.lastLineAt >= idleMs;
}

/** How often the driver checks the watchdog: a tenth of the threshold,
 *  clamped to [1s, 30s], so a firing lands within 10% of the threshold. */
export function idleWatchdogTickMs(idleMs: number): number {
  return Math.min(30_000, Math.max(1_000, Math.round(idleMs / 10)));
}

// --------- Partial-work salvage for runs that already have a PR ---------

/** How a run was stopped by the dispatcher rather than finishing. */
export type RunStopKind = "timeout" | "idle_stall";

/**
 * The runner's rejection when the dispatcher itself stopped the run and no
 * result frame came back: the wall clock, or the idle watchdog. Typed so
 * the orchestrator can tell these from every other failure without
 * matching message text. The message is unchanged from the plain `Error`
 * it replaces, so retry classification and comments read the same.
 *
 * This is the door most timeouts arrive through: a SIGTERMed `pyry
 * agent-run` writes no result frame, so pyrycode-mobile #1430 (2026-10-02)
 * and #1332 (2026-10-01) both failed with "Agent timed out after 2280s"
 * here, never reaching `handleAgentResultErrors` at all.
 */
export class AgentRunStoppedError extends Error {
  constructor(message: string, readonly kind: RunStopKind) {
    super(message);
    this.name = "AgentRunStoppedError";
  }
}

/**
 * Which stop, if any, ended this run. Both doors count: the runner's
 * rejection (`AgentRunStoppedError`) and a result frame the dispatcher
 * marked (`timedOut`, or terminal reason `idle_stall` from either the
 * dispatcher's watchdog or pyry's). A result that is not an error is not
 * a stop. Neither is a permission denial or a Codex blocked or refinement
 * outcome: those are policy stops with their own handling, and saving
 * their work automatically could repeat the action that was refused.
 */
export function runStopKind(
  error: unknown,
  streamResult: {
    isError: boolean;
    timedOut: boolean;
    terminalReason: string;
    hadPermissionDenial: boolean;
  } | null,
): RunStopKind | null {
  if (error instanceof AgentRunStoppedError) return error.kind;
  if (!streamResult || !streamResult.isError || streamResult.hadPermissionDenial) return null;
  if (["codex_blocked", "needs_refinement", "waiting_on_blocker"].includes(streamResult.terminalReason)) return null;
  if (streamResult.terminalReason === IDLE_STALL_REASON) return "idle_stall";
  if (streamResult.timedOut) return "timeout";
  return null;
}

/**
 * True when this run's stage may have its partial work committed and
 * pushed for it. Only stages that own commits on the branch qualify:
 * `producesCommits` is already that list (architect, developer, builder,
 * documentation). Reviewer stages (verifier, code-review, qa) and the
 * refiner/PO carry `false`, so their worktree is never pushed for them.
 */
export function canSalvagePartialWork(opts: {
  stopKind: RunStopKind | null;
  agent: Pick<AgentConfig, "producesCommits">;
  useWorktree: boolean;
  issueNumber: number;
}): boolean {
  return opts.stopKind !== null && opts.agent.producesCommits && opts.useWorktree && opts.issueNumber > 0;
}

/**
 * Whether to commit and push a stopped run's leftovers to its branch.
 *
 * Why. The draft-PR salvage (`shouldAttemptSafeSalvage`) only covers a
 * branch with no pull request yet, because it opens one. Every rework,
 * documentation and later run already has a PR, so a timeout there left
 * its edits in the worktree: pyrycode-mobile #1430 (2026-10-02) and #1332
 * (2026-10-01) both timed out in documentation with finished edits
 * uncommitted. A dirty worktree also blocks the next run from recreating
 * it, and unpushed local commits make the next setup abort as "local
 * ahead of origin". Pushing to the existing branch fixes both; the PR
 * already exists, so nothing new is opened and nothing auto-advances.
 *
 * Gates, all required:
 * - an open PR on the branch (`openPrCount > 0`; -1 means the lookup
 *   failed, which skips);
 * - no merge in progress (`MERGE_HEAD`), and a merge handed to this run
 *   passed `checkMergeResolution`, so conflict markers are never pushed;
 * - something to save: uncommitted changes, or local commits origin lacks.
 *
 * Pure; the caller (`salvagePartialWork` in dispatch.ts) does the I/O.
 */
export function decidePartialWorkSalvage(opts: {
  openPrCount: number;
  gitStatusOutput: string;
  /** `git rev-list --count origin/<branch>..HEAD`; -1 when unknown. */
  commitsAheadOfOrigin: number;
  mergeInProgress: boolean;
  /** `checkMergeResolution` problems for a merge handed to this run; empty otherwise. */
  mergeCheckProblems: readonly string[];
}): { salvage: true } | { salvage: false; reason: string } {
  if (opts.openPrCount < 0) return { salvage: false, reason: "could not look up the branch's pull request" };
  if (opts.openPrCount === 0) return { salvage: false, reason: "no open pull request on the branch" };
  if (opts.mergeInProgress) return { salvage: false, reason: "a merge is still in progress (MERGE_HEAD)" };
  if (opts.mergeCheckProblems.length > 0) {
    return { salvage: false, reason: `the merge handed to this run failed its check: ${opts.mergeCheckProblems.join(" ")}` };
  }
  const dirty = opts.gitStatusOutput.trim().length > 0;
  if (!dirty && opts.commitsAheadOfOrigin <= 0) {
    return { salvage: false, reason: "nothing to save: worktree clean and in sync with origin" };
  }
  return { salvage: true };
}

// --------- Runner stderr: keep the tail, scrub credentials ---------

/**
 * How much of a runner's stderr the dispatcher keeps, and how much of that
 * goes into an error message.
 *
 * Why. On 2026-10-02 pyrycode-mobile #1340's verifier failed after 21
 * minutes with only "Claude CLI exited with code 1, no result message
 * received". The dispatcher wrote the CLI's stderr to its own terminal and
 * kept none of it (the tail was collected for Codex only), so the cause is
 * unknowable. Every runner now keeps the last STDERR_TAIL_CAP characters,
 * writes them to the run's log on failure, and appends the last
 * STDERR_MESSAGE_CHARS to the no-result error, which lands in the ticket's
 * error comment inside its code block.
 */
export const STDERR_TAIL_CAP = 4000;
export const STDERR_MESSAGE_CHARS = 1500;

/** Append a stderr chunk, keeping only the last `cap` characters. */
export function appendStderrTail(tail: string, chunk: string, cap = STDERR_TAIL_CAP): string {
  return (tail + chunk).slice(-cap);
}

const REDACTED = "[REDACTED]";

/**
 * Credential shapes to blank before text leaves the machine. Order
 * matters: specific shapes first, so the generic `token=`/`key=` rule
 * does not leave a recognisable prefix behind.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization: Bearer <token>` and friends.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // Anthropic API and OAuth keys: sk-ant-api03-..., sk-ant-oat01-...
  [/\bsk-ant-[A-Za-z0-9_-]+/g, `sk-ant-${REDACTED}`],
  // GitHub tokens: classic and OAuth/app/refresh (gh[pousr]_), fine-grained (github_pat_).
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  // Credentials embedded in a URL: https://user:secret@host
  [/(\bhttps?:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  // A long base64-looking value after token=, key=, secret= or password=
  // (also `:` and quoted forms, e.g. CLAUDE_CODE_OAUTH_TOKEN=..., "api_key": "...").
  [/(\b[A-Za-z0-9_-]*(?:token|key|secret|password)["']?\s*[=:]\s*["']?)[A-Za-z0-9+/_.=-]{16,}/gi, `$1${REDACTED}`],
];

/**
 * Blank anything that looks like a credential. Used on every piece of
 * runner stderr before it reaches a log, an error message or a GitHub
 * comment; the Codex adapter shares it for its stderr-derived failure
 * text, which previously went to the ticket unscrubbed.
 */
export function scrubCredentials(text: string): string {
  let out = text;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The scrubbed last `max` characters of a stderr tail, ready to sit inside
 * the error comment's code block: a run of three or more backticks would
 * close that block early, so those become quotes. "" when there is none.
 */
export function stderrForMessage(tail: string, max = STDERR_MESSAGE_CHARS): string {
  return scrubCredentials(tail).slice(-max).replace(/`{3,}/g, "'''").trim();
}

/** The runner's error when the CLI exits without a result frame. */
export function noResultErrorMessage(code: number | null, stderrTail: string): string {
  const base = `Claude CLI exited with code ${code}, no result message received`;
  const tail = stderrForMessage(stderrTail);
  return tail ? `${base}\n--- stderr (last ${STDERR_MESSAGE_CHARS} chars) ---\n${tail}` : base;
}
