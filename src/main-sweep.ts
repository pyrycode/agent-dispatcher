// Main sweep: an in-depth test run against the default branch, between tickets.
//
// Some forks keep a suite too slow for every verifier pass. Mobile runs its
// Compose screen tests under Robolectric on each pass and keeps the emulator run
// of the same tests for occasional depth; a screen that behaves differently on a
// real device than under Robolectric would otherwise reach main unnoticed. The
// sweep runs that slow command against main when the dispatcher has nothing else
// to do, or once enough tickets have merged since the last sweep, and files a
// Backlog ticket when it fails.
//
// This module holds the pure half: configuration, the run decision, the state
// file and the ticket text. The process half (worktree, spawn, board writes)
// lives beside the real-claude gate runner in dispatch.ts.

import { isGateOutputFormat, type GateOutputFormat } from "./gate-output.js";

export interface MainSweepConfig {
  /** Shell command run from a detached worktree of main. Empty disables the sweep. */
  command: string;
  /** Merges since the last sweep that force one even when the board is busy. */
  every: number;
  timeoutMs: number;
  /** Optional: read the command's stdout to name the failing tests in the ticket. */
  format: GateOutputFormat | null;
}

export const DEFAULT_MAIN_SWEEP_EVERY = 5;
export const DEFAULT_MAIN_SWEEP_TIMEOUT_MS = 1_800_000;

/** Null when `PYRY_MAIN_SWEEP_CMD` is unset or empty, which keeps the sweep off. */
export function resolveMainSweepConfig(env: NodeJS.ProcessEnv): MainSweepConfig | null {
  const command = (env.PYRY_MAIN_SWEEP_CMD ?? "").trim();
  if (command === "") return null;
  const every = parseInt(env.PYRY_MAIN_SWEEP_EVERY ?? "", 10);
  const timeoutMs = parseInt(env.PYRY_MAIN_SWEEP_TIMEOUT_MS ?? "", 10);
  const rawFormat = (env.PYRY_MAIN_SWEEP_FORMAT ?? "").trim();
  return {
    command,
    every: Number.isFinite(every) && every > 0 ? every : DEFAULT_MAIN_SWEEP_EVERY,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_MAIN_SWEEP_TIMEOUT_MS,
    // An unknown format only loses the test names in the ticket; the exit code still judges the run.
    format: isGateOutputFormat(rawFormat) ? rawFormat : null,
  };
}

/** Persisted in the agents repo's logs directory, so a restart neither repeats nor forgets a sweep. */
export interface MainSweepState {
  /** The main commit the last sweep ran against, pass or fail. */
  lastSha: string | null;
  /** The last main commit a sweep passed on. The start of the range a failure ticket names. */
  lastGoodSha: string | null;
  /** The ticket filed for the current failure, so a repeat failure does not file another. */
  openIssue: number | null;
  /**
   * The failing tests of the last sweep that ran, and the main commit it ran
   * on. Empty names after a pass. A verifier gate sets aside a failure listed
   * here, but only when this commit is in the gated branch's merged tree, so
   * a missing record means no sweep is used as a baseline.
   */
  failures: { sha: string; names: string[] } | null;
  /**
   * The failure set last written to `openIssue`, by the ticket itself or an
   * update comment. A later failed sweep comments only when its set differs.
   * Null when nothing was recorded, as for a ticket filed before this field.
   */
  reportedNames: string[] | null;
}

export const EMPTY_MAIN_SWEEP_STATE: MainSweepState = {
  lastSha: null, lastGoodSha: null, openIssue: null, failures: null, reportedNames: null,
};

/** Tolerates a missing or damaged file: the worst case is one extra sweep. */
export function parseMainSweepState(raw: string | null): MainSweepState {
  if (raw === null) return { ...EMPTY_MAIN_SWEEP_STATE };
  try {
    const parsed = JSON.parse(raw);
    const sha = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{7,40}$/.test(v) ? v : null);
    const issue = parsed?.openIssue;
    const names = (v: unknown) =>
      Array.isArray(v) && v.every((n) => typeof n === "string") ? [...v] as string[] : null;
    const failureSha = sha(parsed?.failures?.sha);
    const failureNames = names(parsed?.failures?.names);
    return {
      lastSha: sha(parsed?.lastSha),
      lastGoodSha: sha(parsed?.lastGoodSha),
      openIssue: Number.isInteger(issue) && issue > 0 ? issue : null,
      // Both halves or neither: names without the commit they failed on
      // cannot be checked against a branch.
      failures: failureSha !== null && failureNames !== null ? { sha: failureSha, names: failureNames } : null,
      reportedNames: names(parsed?.reportedNames),
    };
  } catch {
    return { ...EMPTY_MAIN_SWEEP_STATE };
  }
}

export type MainSweepDecision =
  | { run: false; reason: string }
  | { run: true; reason: string };

/**
 * Whether to sweep this cycle.
 *
 * Never while a verifier is in flight: its gates may be driving the same
 * emulators, and two overlapping device runs each took twice as long when
 * measured on 2026-09-22. The sweep runs inline in the poll loop, so once it
 * starts no new verifier can launch until it ends.
 *
 * `mergesSince` is null when git cannot count, for instance after a history
 * rewrite; that counts as due, since the unknown range may hold anything.
 */
export function decideMainSweep(input: {
  head: string | null;
  lastSha: string | null;
  mergesSince: number | null;
  every: number;
  idle: boolean;
  verifierBusy: boolean;
}): MainSweepDecision {
  if (input.head === null) return { run: false, reason: "main could not be resolved" };
  if (input.head === input.lastSha) return { run: false, reason: "main unchanged since the last sweep" };
  if (input.verifierBusy) return { run: false, reason: "a verifier is in flight" };
  if (input.idle) return { run: true, reason: "the board is idle and main has changed" };
  if (input.lastSha === null) return { run: false, reason: "no sweep yet; waiting for an idle cycle" };
  if (input.mergesSince === null) return { run: true, reason: "the merges since the last sweep could not be counted" };
  if (input.mergesSince >= input.every) {
    return { run: true, reason: `${input.mergesSince} merges since the last sweep (every ${input.every})` };
  }
  return { run: false, reason: `${input.mergesSince} of ${input.every} merges since the last sweep` };
}

/**
 * While a main sweep runs, no verifier starts: its gates would share the
 * emulators with the sweep. Every other stage dispatches as usual.
 */
export function holdVerifiersDuringSweep<T extends { agent: { name: string } }>(
  candidates: readonly T[],
  sweepRunning: boolean,
): T[] {
  return sweepRunning ? candidates.filter((c) => c.agent.name !== "verifier") : [...candidates];
}

export interface MainSweepOutcome {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the run could not happen at all: no worktree, no spawn. */
  runError: string | null;
  failedNames: readonly string[];
  stdoutPath: string;
  stderrPath: string;
  /** Last lines of stderr, where build tools and the gate script report. */
  stderrTail: string;
  durationMs: number;
}

const MAX_LISTED_FAILURES = 30;

/** The Backlog ticket for a failed sweep. Written for the refiner that picks it up. */
export function buildMainSweepIssue(input: {
  repo: string;
  head: string;
  lastGoodSha: string | null;
  mergeSubjects: readonly string[];
  command: string;
  outcome: MainSweepOutcome;
}): { title: string; body: string } {
  const { outcome } = input;
  const short = input.head.slice(0, 7);
  const what = outcome.runError !== null
    ? "could not run"
    : outcome.timedOut
      ? "timed out"
      : "failed";
  const title = `In-depth test run ${what} on main at ${short}`;

  const lines: string[] = [];
  lines.push(
    `The dispatcher's main sweep ${what} on \`${input.head}\`. The sweep runs the fork's in-depth test ` +
    `command against main between tickets, because that command is too slow for every verifier pass.`,
  );
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push(`- Command: \`${input.command}\``);
  if (outcome.runError !== null) lines.push(`- Run error: ${outcome.runError}`);
  if (outcome.timedOut) lines.push("- The dispatcher's wall clock killed the command.");
  if (outcome.exitCode !== null) lines.push(`- Exit code: ${outcome.exitCode}`);
  lines.push(`- Duration: ${Math.round(outcome.durationMs / 1000)}s`);
  lines.push(`- Output on the dispatcher host: \`${outcome.stdoutPath}\` and \`${outcome.stderrPath}\``);
  lines.push("");

  if (outcome.failedNames.length > 0) {
    lines.push("## Failing tests");
    lines.push("");
    for (const name of outcome.failedNames.slice(0, MAX_LISTED_FAILURES)) lines.push(`- \`${name}\``);
    if (outcome.failedNames.length > MAX_LISTED_FAILURES) {
      lines.push(`- ... and ${outcome.failedNames.length - MAX_LISTED_FAILURES} more`);
    }
    lines.push("");
  }

  lines.push("## Where it broke");
  lines.push("");
  if (input.lastGoodSha === null) {
    lines.push("No earlier sweep passed, so there is no known-good commit to compare against.");
  } else {
    lines.push(
      `The last passing sweep ran on \`${input.lastGoodSha}\`. The cause is in \`${input.lastGoodSha.slice(0, 7)}..${short}\`:`,
    );
    lines.push("");
    if (input.mergeSubjects.length === 0) lines.push("- (no merge commits in that range)");
    for (const subject of input.mergeSubjects) lines.push(`- ${subject}`);
    lines.push(
      "",
      `Compare: https://github.com/${input.repo}/compare/${input.lastGoodSha}...${input.head}`,
    );
  }
  lines.push("");

  if (outcome.stderrTail.trim() !== "") {
    lines.push("## Output tail");
    lines.push("");
    lines.push("```");
    lines.push(outcome.stderrTail.trimEnd());
    lines.push("```");
    lines.push("");
  }

  lines.push("## What to do");
  lines.push("");
  lines.push(
    "Reproduce with the command above on main. Decide per failing test whether the code regressed or the test " +
    "only behaves differently in the in-depth environment, and fix whichever it is. The sweep files no further " +
    "ticket while this one is open, and runs again when main changes. When a later sweep fails a different set " +
    "of tests, it comments the new set here.",
  );
  return { title, body: lines.join("\n") };
}

/**
 * Whether a failed sweep should comment its failure set on the still-open
 * ticket. Only a sweep that named its failures has a set to record, and only
 * a set that differs from the one last recorded is worth a comment. Until
 * 2026-10-05 a repeat failure posted nothing at all: pyrycode-mobile #1046,
 * filed for three failures, stayed open while the sweeps grew to 38, and no
 * ticket named them until one was filed by hand.
 */
export function shouldCommentSweepFailures(
  reportedNames: readonly string[] | null,
  failedNames: readonly string[],
): boolean {
  if (failedNames.length === 0) return false;
  if (reportedNames === null) return true;
  const now = new Set(failedNames);
  const before = new Set(reportedNames);
  return now.size !== before.size || [...now].some((name) => !before.has(name));
}

/** The comment a failed sweep posts on the still-open ticket when its failure set changed. */
export function buildMainSweepUpdateComment(input: {
  head: string;
  reportedNames: readonly string[] | null;
  outcome: MainSweepOutcome;
}): string {
  const names = [...new Set(input.outcome.failedNames)];
  const before = input.reportedNames === null ? null : new Set(input.reportedNames);
  const now = new Set(names);
  const lines: string[] = [];
  lines.push("## Main sweep failures changed");
  lines.push("");
  lines.push(
    `The main sweep failed again on \`${input.head}\`, with ${names.length} failing test(s). ` +
    (before === null
      ? "No failure set was recorded on this ticket before, so this is the full current set."
      : "That set differs from the one last recorded on this ticket."),
  );
  lines.push("");
  if (before !== null) {
    const added = names.filter((name) => !before.has(name));
    const gone = [...before].filter((name) => !now.has(name));
    lines.push(`- Newly failing: ${added.length}`);
    lines.push(`- No longer failing: ${gone.length}`);
    for (const name of gone.slice(0, MAX_LISTED_FAILURES)) lines.push(`  - \`${name}\``);
    if (gone.length > MAX_LISTED_FAILURES) lines.push(`  - ... and ${gone.length - MAX_LISTED_FAILURES} more`);
    lines.push("");
  }
  lines.push("## Failing tests");
  lines.push("");
  // Listed in full, unlike the ticket body: verifier gates look names up here
  // to avoid recording one twice.
  for (const name of names) lines.push(`- \`${name}\``);
  lines.push("");
  lines.push(`Output on the dispatcher host: \`${input.outcome.stdoutPath}\` and \`${input.outcome.stderrPath}\``);
  return lines.join("\n");
}

/** The last `maxLines` lines of `text`, capped at `maxChars`, for a ticket body. */
export function tailLines(text: string, maxLines = 40, maxChars = 4000): string {
  const tail = text.split("\n").slice(-maxLines).join("\n");
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}
