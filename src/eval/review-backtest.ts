// Review-verdict backtest: did the code-review agent's verdict predict
// what the ticket did next?
//
// For every parsed code-review run, the verdict (PASS/FAIL plus MUST
// FIX / SHOULD FIX / NIT occurrence counts) is read from the OUTPUT
// section, then joined against the ticket's GitHub timeline AFTER the
// review's end timestamp. A later needs-rework:* label, a rework-count
// increment, or a column move back into In Development means the ticket
// bounced. A PASS followed by a bounce is the missed-defect proxy; a
// FAIL is a catch. Pure join logic — the caller supplies parsed runs
// and fetched outcomes.

import type { TicketOutcome } from "./github-outcomes.js";

export interface ReviewVerdict {
  verdict: "PASS" | "FAIL" | "UNKNOWN";
  mustFix: number;
  shouldFix: number;
  nit: number;
}

/** How many findings of one kind does the review claim? Reviews write a
 *  findings headline like "Findings — 2 SHOULD FIX, 1 NIT", so the
 *  first numeric claim (`N MUST FIX`) wins; threshold prose ("threshold
 *  for FAIL is 3 SHOULD FIX") always comes later and stays ignored.
 *  Without any numeric claim, bare occurrences of the marker count. */
function countFindings(output: string, kindPattern: string): number {
  const numeric = output.match(new RegExp(`(\\d+)\\s+${kindPattern}\\b`));
  if (numeric) return Number(numeric[1]);
  return (output.match(new RegExp(`\\b${kindPattern}\\b`, "g")) ?? []).length;
}

/** Verdict shapes observed in the corpus, most reliable first:
 *  `Decision: FAIL` (with or without bold), a bold `**PASS**`/`**FAIL**`
 *  headline (earliest occurrence wins when prose mentions the other),
 *  and a bare PASS/FAIL on the "Review complete" line. Anything else is
 *  UNKNOWN rather than guessed. */
export function extractReviewVerdict(output: string): ReviewVerdict {
  const counts = {
    mustFix: countFindings(output, "MUST[ -]FIX"),
    shouldFix: countFindings(output, "SHOULD[ -]FIX"),
    nit: countFindings(output, "NITs?"),
  };

  const decision = output.match(/Decision:\s*\**(PASS|FAIL)/);
  if (decision) return { verdict: decision[1] as "PASS" | "FAIL", ...counts };

  const bold = output.match(/\*\*(PASS|FAIL)\*\*/);
  if (bold) return { verdict: bold[1] as "PASS" | "FAIL", ...counts };

  for (const line of output.split("\n")) {
    if (!/Review complete/i.test(line)) continue;
    const bare = line.match(/\b(PASS|FAIL)\b/);
    if (bare) return { verdict: bare[1] as "PASS" | "FAIL", ...counts };
  }

  return { verdict: "UNKNOWN", ...counts };
}

export interface BounceCheck {
  bounced: boolean;
  /** The earliest bounce signal: a label name, or `column:<status>`. */
  signal: string | null;
  at: string | null;
}

/** Did the ticket bounce back into rework after `afterIso`? Signals:
 *  a needs-rework:* or rework-count:* label APPLIED after the mark, or
 *  a column move whose new status is In Development. Earliest wins. */
export function didBounceAfter(outcome: TicketOutcome, afterIso: string): BounceCheck {
  const afterMs = Date.parse(afterIso);
  const candidates: { signal: string; at: string }[] = [];
  for (const event of outcome.labelEvents) {
    if (event.type !== "labeled") continue;
    if (Date.parse(event.at) <= afterMs) continue;
    if (event.label.startsWith("needs-rework:") || event.label.startsWith("rework-count:")) {
      candidates.push({ signal: event.label, at: event.at });
    }
  }
  for (const move of outcome.statusMoves) {
    if (Date.parse(move.at) <= afterMs) continue;
    if (move.status === "In Development") {
      candidates.push({ signal: `column:${move.status}`, at: move.at });
    }
  }
  if (candidates.length === 0) return { bounced: false, signal: null, at: null };
  candidates.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { bounced: true, signal: candidates[0].signal, at: candidates[0].at };
}

export interface ReviewInput {
  ticket: number;
  file: string;
  /** The review run's end timestamp (its USAGE header). */
  endAt: string;
  /** OUTPUT (success) body. */
  output: string;
}

export interface ReviewRow extends ReviewInput {
  verdict: ReviewVerdict;
  bounce: BounceCheck;
  hasOutcome: boolean;
}

export interface MustFixBucket {
  bucket: "0" | "1" | "2" | "3+";
  reviews: number;
  bounced: number;
}

export interface BacktestReport {
  reviewsTotal: number;
  byVerdict: { PASS: number; FAIL: number; UNKNOWN: number };
  /** PASS verdicts with no later bounce. */
  passCleanCount: number;
  /** PASS verdicts where the ticket still bounced — the missed-defect proxy. */
  passThenBounced: ReviewRow[];
  /** FAIL verdicts — defects caught before they shipped. */
  failCount: number;
  /** FAIL verdicts whose ticket did bounce afterwards (rework confirmed). */
  failThenBounced: number;
  /** MUST FIX occurrence count vs whether the ticket later bounced,
   *  over reviews with a known verdict and a fetched outcome. */
  mustFixBuckets: MustFixBucket[];
  /** Reviews whose ticket had no fetched outcome. */
  withoutOutcome: number;
  rows: ReviewRow[];
}

function bucketFor(mustFix: number): MustFixBucket["bucket"] {
  if (mustFix >= 3) return "3+";
  return String(mustFix) as MustFixBucket["bucket"];
}

export function backtestReviews(reviews: ReviewInput[], outcomes: Map<number, TicketOutcome>): BacktestReport {
  const rows: ReviewRow[] = reviews.map((review) => {
    const outcome = outcomes.get(review.ticket);
    const usable = outcome !== undefined && outcome.state !== "MISSING";
    return {
      ...review,
      verdict: extractReviewVerdict(review.output),
      bounce: usable ? didBounceAfter(outcome, review.endAt) : { bounced: false, signal: null, at: null },
      hasOutcome: usable,
    };
  });

  const byVerdict = { PASS: 0, FAIL: 0, UNKNOWN: 0 };
  const buckets = new Map<MustFixBucket["bucket"], { reviews: number; bounced: number }>([
    ["0", { reviews: 0, bounced: 0 }],
    ["1", { reviews: 0, bounced: 0 }],
    ["2", { reviews: 0, bounced: 0 }],
    ["3+", { reviews: 0, bounced: 0 }],
  ]);
  let passCleanCount = 0;
  const passThenBounced: ReviewRow[] = [];
  let failCount = 0;
  let failThenBounced = 0;
  let withoutOutcome = 0;

  for (const row of rows) {
    byVerdict[row.verdict.verdict]++;
    if (!row.hasOutcome) {
      withoutOutcome++;
      continue;
    }
    if (row.verdict.verdict === "PASS") {
      if (row.bounce.bounced) passThenBounced.push(row);
      else passCleanCount++;
    } else if (row.verdict.verdict === "FAIL") {
      failCount++;
      if (row.bounce.bounced) failThenBounced++;
    }
    if (row.verdict.verdict !== "UNKNOWN") {
      const bucket = buckets.get(bucketFor(row.verdict.mustFix))!;
      bucket.reviews++;
      if (row.bounce.bounced) bucket.bounced++;
    }
  }

  return {
    reviewsTotal: rows.length,
    byVerdict,
    passCleanCount,
    passThenBounced,
    failCount,
    failThenBounced,
    mustFixBuckets: [...buckets.entries()].map(([bucket, counts]) => ({ bucket, ...counts })),
    withoutOutcome,
    rows,
  };
}
