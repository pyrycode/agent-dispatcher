// Verifier out of time: a verdict run that runs out of time or turns ends
// with one plain comment on the ticket, not a bare error string.
//
// 2026-10-03, Mobile #1619, twice: the dispatcher's gates, including both
// emulator suites, took the verifier's whole 60-minute budget, so the final
// review never started. The ticket got "Verifier budget exhausted before
// final review. No verdict published. Manual intervention required." All
// gates had passed and the source review had finished, but neither result
// reached the ticket. Each time a person read the logs, wrote down that the
// gates were green and recorded for reuse, cleared `error:verifier` and
// dispatched again.
//
// Gate time no longer counts against the review (`finalReviewBudgetMs`,
// 2026-10-04), but a review can still run out of its own time. When it does,
// the comment says which part ran out and how long it had, how long the gates
// took outside that budget, whether a green gate run is recorded for the next
// run to reuse and until when, and it carries the finished source review's
// report. The ticket still parks under `error:<agent>`: a re-run of a review
// that ran out of time usually just runs out again, so a person decides.
//
// Pure helpers here; the I/O (gate pass file, labels, comment) stays in
// dispatch.ts.

import { runStopKind } from "./agent-runtime.js";

/** Which budget ran out. */
export type ReviewBudgetKind = "time" | "turns";

/** The part of a verdict run that was going when the budget ran out. With
 *  review overlap on, a source review runs beside the gates and a final
 *  review publishes. Without it there is one review. */
export type ReviewPhase = "review" | "source review" | "final review";

/**
 * What a verdict run got through, recorded on the dispatch context as each
 * phase starts and ends, so a run that runs out of time can say so.
 */
export interface ReviewProgress {
  phase: ReviewPhase;
  /** Wall clock the current phase was given. */
  budgetMs: number;
  /** How long the dispatcher's gates took, when any ran. */
  gatesMs?: number;
  /** How long the overlapped source review took. */
  sourceMs?: number;
  /** The finished source review's report. */
  sourceReport?: string;
  /** Continuation legs the review used before giving up. */
  legsUsed?: number;
}

/**
 * Thrown by the overlapped review when a budget runs out before the final
 * review can start: the source review hit its wall clock, or used every
 * turn the two phases share.
 */
export class ReviewBudgetExhaustedError extends Error {
  constructor(message: string, readonly kind: ReviewBudgetKind) {
    super(message);
    this.name = "ReviewBudgetExhaustedError";
  }
}

/**
 * Whether a failed verdict run ended because a budget ran out. The wall
 * clock counts through both doors `runStopKind` reads: the runner's
 * rejection and a result frame the dispatcher marked. An idle stall is not
 * a budget stop; it retries. A permission denial, a blocked Codex run and a
 * refinement request keep their own handling.
 */
export function reviewBudgetStop(
  error: unknown,
  streamResult: {
    isError: boolean;
    timedOut: boolean;
    terminalReason: string;
    hadPermissionDenial: boolean;
  } | null,
): ReviewBudgetKind | null {
  if (error instanceof ReviewBudgetExhaustedError) return error.kind;
  if (runStopKind(error, streamResult) === "timeout") return "time";
  if (streamResult?.isError && !streamResult.hadPermissionDenial && streamResult.terminalReason === "max_turns") {
    return "turns";
  }
  return null;
}

/** Longest source report the comment carries. GitHub refuses comments over
 *  65536 characters, and the rest of the comment needs room. */
export const OUT_OF_TIME_REPORT_CAP = 20_000;

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "under a minute";
  return m === 1 ? "1 minute" : `${m} minutes`;
}

function minuteBudget(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}-minute`;
}

function utc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** The comment a verdict run that ran out of time leaves on its ticket. */
export function outOfTimeComment(opts: {
  agentName: string;
  kind: ReviewBudgetKind;
  progress: ReviewProgress | undefined;
  /** The run's own wall clock, used when no progress was recorded. */
  fallbackBudgetMs: number;
  /** A green run of every gate the next dispatch would reuse, or null. */
  reusableGates: { commit: string; untilMs: number } | null;
  errorLabel: string;
  /** Command that resumes the stopped session, when one was captured. */
  resumeHint: string | null;
  /** Dispatch log file, named when the report had to be cut. */
  logFile: string;
}): string {
  const { agentName, kind, progress, reusableGates, errorLabel } = opts;
  const phase = progress?.phase ?? "review";
  const budgetMs = progress?.budgetMs ?? opts.fallbackBudgetMs;
  const legs = progress?.legsUsed ?? 0;
  const legText = legs === 0 ? "" : legs === 1 ? " and one continuation leg with a fresh budget" : ` and ${legs} continuation legs with fresh budgets`;
  const budget = kind === "time" ? `its ${minuteBudget(budgetMs)} budget` : "the whole turn budget";
  const what = phase === "review" ? `The ${agentName}` : `The ${agentName}'s ${phase}`;
  const outcome = phase === "source review"
    ? "The final review never started, so no verdict was published."
    : "It was stopped before it published a verdict.";
  const lines = [
    `## ⏱️ ${agentName[0]!.toUpperCase()}${agentName.slice(1)} ran out of ${kind}`,
    "",
    `${what} used ${budget}${legText}. ${outcome} The ticket is parked under \`${errorLabel}\`.`,
    "",
  ];
  const facts: string[] = [];
  if (progress?.gatesMs !== undefined) {
    facts.push(`- **Gates:** took ${minutes(progress.gatesMs)}. That time is not charged to the review's budget.`);
    facts.push(reusableGates
      ? `- **Gate results:** every gate passed on commit \`${reusableGates.commit.slice(0, 12)}\`. The next ${agentName} run reuses them instead of running the gates again, as long as the merged files are unchanged and it starts before ${utc(reusableGates.untilMs)}.`
      : `- **Gate results:** no green run of every gate is recorded for these files, so the next ${agentName} run runs the gates again.`);
  }
  if (progress?.sourceReport !== undefined && progress.sourceMs !== undefined) {
    facts.push(`- **Source review:** finished in ${minutes(progress.sourceMs)}. Its report is below.`);
  }
  if (facts.length > 0) lines.push(...facts, "");
  lines.push(`**Next step:** remove \`${errorLabel}\` to run the ${agentName} again.`);
  if (progress?.sourceReport !== undefined) {
    const report = progress.sourceReport.trim();
    const cut = report.length > OUT_OF_TIME_REPORT_CAP;
    lines.push(
      "",
      "<details><summary>Source review report</summary>",
      "",
      cut ? report.slice(0, OUT_OF_TIME_REPORT_CAP) : report,
      ...(cut ? ["", `The report was cut here. The whole report is in the dispatch log \`${opts.logFile}\`.`] : []),
      "",
      "</details>",
    );
  }
  if (opts.resumeHint) lines.push("", `**Debug**: \`${opts.resumeHint}\``);
  return lines.join("\n");
}
