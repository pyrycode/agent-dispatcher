// Unit tests for the review-verdict backtest's pure join logic. Run with:
//
//   pnpm exec tsx --test src/eval/review-backtest.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { backtestReviews, didBounceAfter, extractReviewVerdict } from "./review-backtest.js";
import type { TicketOutcome } from "./github-outcomes.js";

function outcome(partial: Partial<TicketOutcome> & { number: number }): TicketOutcome {
  return {
    state: "CLOSED",
    closedAt: null,
    parentChain: [],
    labelEvents: [],
    statusMoves: [],
    closingPrs: [],
    timelineTotal: 0,
    timelineIncomplete: false,
    ...partial,
  };
}

describe("extractReviewVerdict", () => {
  test("reads a bold PASS headline", () => {
    const got = extractReviewVerdict("## Review complete: #1938 / PR #1960 — **PASS**\n\nFindings — 2 SHOULD FIX, 1 NIT.\n");
    assert.equal(got.verdict, "PASS");
    assert.equal(got.mustFix, 0);
    assert.equal(got.shouldFix, 2);
    assert.equal(got.nit, 1);
  });

  test("reads a Decision: FAIL even when bold PASS appears later in prose", () => {
    const got = extractReviewVerdict(
      "Review complete. **Decision: FAIL**, needs-rework applied.\n\nHad this been clean it would be **PASS**.\n1 MUST FIX, 3 SHOULD FIX.\n",
    );
    assert.equal(got.verdict, "FAIL");
    assert.equal(got.mustFix, 1);
    assert.equal(got.shouldFix, 3);
  });

  test("with both bold markers and no Decision:, the earlier one is the headline", () => {
    const got = extractReviewVerdict("Verdict — **PASS**. The threshold for **FAIL** was not met.\n");
    assert.equal(got.verdict, "PASS");
  });

  test("a bold or heading first line carries the verdict, ahead of any bold token below it", () => {
    const table = "**PR #1969 (#1968): PASS.**\n\n## Triage\n\n| check | result |\n|---|---|\n| row | (a) **FAIL**, (b) **executes and PASSES** |\n";
    assert.equal(extractReviewVerdict(table).verdict, "PASS");
    assert.equal(extractReviewVerdict("**Triage verdict: FAIL — regression. Routed back to the builder.**\n").verdict, "FAIL");
    assert.equal(extractReviewVerdict("**PASS.** Verdict posted: https://example/pr/2019\n").verdict, "PASS");
    assert.equal(extractReviewVerdict("## PR #1971 (#1964) — PASS\n\nTree clean.\n").verdict, "PASS");
  });

  test("a plain-prose first line is not a headline, even when it mentions a verdict word", () => {
    const got = extractReviewVerdict("Baseline worktree removed, no labels applied (correct for a PASS).\n\n## Verdict: FAIL — #900 / PR #903\n");
    assert.equal(got.verdict, "FAIL");
  });

  test("reads the verifier's Verdict line in its three observed shapes", () => {
    assert.equal(extractReviewVerdict("**Verdict: PASS** — posted to PR #893.\n").verdict, "PASS");
    assert.equal(extractReviewVerdict("Tree clean.\n\n## Verdict: FAIL — #900 / PR #903\n").verdict, "FAIL");
    assert.equal(extractReviewVerdict("**Verdict on PR #909 (#906): PASS.** Tree clean.\n").verdict, "PASS");
  });

  test("a Verdict line yields to an explicit Decision: line", () => {
    const got = extractReviewVerdict("Verdict: PASS on the plan.\n\n**Decision: FAIL** — needs-rework applied.\n");
    assert.equal(got.verdict, "FAIL");
  });

  test("prose about a verdict, not at a line start, is not a verdict", () => {
    assert.equal(extractReviewVerdict("The plan's security review carries a PASS verdict: fine.\n").verdict, "UNKNOWN");
  });

  test("'No MUST FIX' is a zero claim, not one occurrence", () => {
    const got = extractReviewVerdict("**Verdict: PASS** on #921. No MUST FIX, no SHOULD FIX, no NIT.\n");
    assert.equal(got.mustFix, 0);
    assert.equal(got.shouldFix, 0);
    assert.equal(got.nit, 0);
  });

  test("falls back to a bare PASS/FAIL on the Review complete line", () => {
    assert.equal(extractReviewVerdict("Review complete — PASS, posted as a PR comment.\n").verdict, "PASS");
  });

  test("prose mentioning FAIL thresholds without a verdict shape is UNKNOWN", () => {
    const got = extractReviewVerdict("Posted the review. The threshold for FAIL is 3 SHOULD FIX.\n");
    assert.equal(got.verdict, "UNKNOWN");
    // The numeric claim is read even from prose — harmless here, since
    // an UNKNOWN verdict feeds no metric.
    assert.equal(got.shouldFix, 3);
  });

  test("threshold prose after a findings headline does not override the headline", () => {
    const got = extractReviewVerdict("**PASS**\n\nFindings — 2 SHOULD FIX, 1 NIT (threshold for FAIL is 3 SHOULD FIX).\n");
    assert.equal(got.shouldFix, 2);
  });

  test("falls back to counting bare markers when no number is claimed", () => {
    const got = extractReviewVerdict("**PASS** — a MUST FIX was found and fixed inline.\n");
    assert.equal(got.mustFix, 1);
  });

  test("counts hyphenated spellings and NIT plurals", () => {
    const got = extractReviewVerdict("**PASS** — 2 MUST-FIX handled, 1 SHOULD-FIX, 3 NITs\n");
    assert.equal(got.mustFix, 2);
    assert.equal(got.shouldFix, 1);
    assert.equal(got.nit, 3);
  });

  test("does not count lowercase nit prose as a NIT finding", () => {
    assert.equal(extractReviewVerdict("**PASS** — one nit-level remark inline.\n").nit, 0);
  });
});

describe("didBounceAfter", () => {
  const after = "2026-08-02T19:40:00Z";

  test("a later needs-rework label is a bounce", () => {
    const got = didBounceAfter(
      outcome({
        number: 1,
        labelEvents: [
          { type: "labeled", label: "needs-rework:developer", at: "2026-08-02T19:41:00Z" },
        ],
      }),
      after,
    );
    assert.deepEqual(got, { bounced: true, signal: "needs-rework:developer", at: "2026-08-02T19:41:00Z" });
  });

  test("a needs-rework label before the review is not a bounce", () => {
    const got = didBounceAfter(
      outcome({
        number: 1,
        labelEvents: [{ type: "labeled", label: "needs-rework:developer", at: "2026-08-02T19:00:00Z" }],
      }),
      after,
    );
    assert.equal(got.bounced, false);
  });

  test("removing a label is never a bounce", () => {
    const got = didBounceAfter(
      outcome({
        number: 1,
        labelEvents: [{ type: "unlabeled", label: "needs-rework:developer", at: "2026-08-02T19:41:00Z" }],
      }),
      after,
    );
    assert.equal(got.bounced, false);
  });

  test("a rework-count increment is a bounce", () => {
    const got = didBounceAfter(
      outcome({
        number: 1,
        labelEvents: [{ type: "labeled", label: "rework-count:2", at: "2026-08-02T20:00:00Z" }],
      }),
      after,
    );
    assert.deepEqual(got, { bounced: true, signal: "rework-count:2", at: "2026-08-02T20:00:00Z" });
  });

  test("a column move back into In Development is a bounce", () => {
    const got = didBounceAfter(
      outcome({
        number: 1,
        statusMoves: [{ previousStatus: "In Review", status: "In Development", at: "2026-08-02T19:45:00Z" }],
      }),
      after,
    );
    assert.deepEqual(got, { bounced: true, signal: "column:In Development", at: "2026-08-02T19:45:00Z" });
  });

  test("a forward column move is not a bounce", () => {
    const got = didBounceAfter(
      outcome({
        number: 1,
        statusMoves: [{ previousStatus: "In Review", status: "Done", at: "2026-08-02T19:45:00Z" }],
      }),
      after,
    );
    assert.equal(got.bounced, false);
  });

  test("the earliest signal wins when several fire", () => {
    const got = didBounceAfter(
      outcome({
        number: 1,
        labelEvents: [{ type: "labeled", label: "needs-rework:developer", at: "2026-08-02T19:50:00Z" }],
        statusMoves: [{ previousStatus: "In Review", status: "In Development", at: "2026-08-02T19:44:00Z" }],
      }),
      after,
    );
    assert.equal(got.signal, "column:In Development");
  });

  test("sub-minute timestamps compare numerically, not as strings", () => {
    // Review end carries millis, label events do not. String comparison
    // would order "19:40:00.500Z" after "19:40:00Z" incorrectly.
    const got = didBounceAfter(
      outcome({
        number: 1,
        labelEvents: [{ type: "labeled", label: "needs-rework:qa", at: "2026-08-02T19:40:01Z" }],
      }),
      "2026-08-02T19:40:00.500Z",
    );
    assert.equal(got.bounced, true);
  });
});

describe("backtestReviews", () => {
  const reviews = [
    // PASS, never bounced → clean.
    { ticket: 10, file: "a.log", endAt: "2026-08-02T10:00:00.000Z", output: "**PASS** — 0 findings\n" },
    // PASS, later needs-rework → missed-defect proxy.
    { ticket: 11, file: "b.log", endAt: "2026-08-02T11:00:00.000Z", output: "**PASS** — 1 NIT\n" },
    // FAIL, later rework label → caught.
    { ticket: 12, file: "c.log", endAt: "2026-08-02T12:00:00.000Z", output: "**Decision: FAIL** — 2 MUST FIX\n" },
    // Verdict-less output.
    { ticket: 13, file: "d.log", endAt: "2026-08-02T13:00:00.000Z", output: "posted a comment\n" },
    // No outcome fetched for this ticket.
    { ticket: 99, file: "e.log", endAt: "2026-08-02T14:00:00.000Z", output: "**PASS**\n" },
  ];
  const outcomes = new Map<number, TicketOutcome>([
    [10, outcome({ number: 10 })],
    [11, outcome({ number: 11, labelEvents: [{ type: "labeled", label: "needs-rework:developer", at: "2026-08-02T18:00:00Z" }] })],
    [12, outcome({ number: 12, labelEvents: [{ type: "labeled", label: "needs-rework:developer", at: "2026-08-02T12:05:00Z" }] })],
    [13, outcome({ number: 13 })],
  ]);
  const report = backtestReviews(reviews, outcomes);

  test("counts and verdict split", () => {
    assert.equal(report.reviewsTotal, 5);
    assert.deepEqual(report.byVerdict, { PASS: 3, FAIL: 1, UNKNOWN: 1 });
    assert.equal(report.withoutOutcome, 1);
  });

  test("splits clean passes from passes that later bounced", () => {
    assert.equal(report.passCleanCount, 1);
    assert.equal(report.passThenBounced.length, 1);
    assert.equal(report.passThenBounced[0].ticket, 11);
  });

  test("fails are caught, and their later bounce is confirmed rework", () => {
    assert.equal(report.failCount, 1);
    assert.equal(report.failThenBounced, 1);
  });

  test("buckets MUST FIX counts against later bounces", () => {
    const zero = report.mustFixBuckets.find((b) => b.bucket === "0")!;
    // Ticket 10 (clean) and 11 (bounced) had 0 MUST FIX; ticket 99 has
    // no outcome and stays out of the correlation.
    assert.equal(zero.reviews, 2);
    assert.equal(zero.bounced, 1);
    const two = report.mustFixBuckets.find((b) => b.bucket === "2")!;
    assert.equal(two.reviews, 1);
    assert.equal(two.bounced, 1);
  });
});
