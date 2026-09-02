// Unit tests for the report's pure parts: CLI arg parsing, wall-clock
// distributions, waiting-pattern tells, and markdown rendering. The CLI
// entry itself is IO wiring and is exercised against the real corpus,
// not unit tested. Run with:
//
//   pnpm exec tsx --test src/eval/report.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  computeNoopStats,
  detectWaitingTells,
  parseArgs,
  percentile,
  renderMarkdown,
  reviewInputs,
  summarizeWallClock,
  WAITING_TELLS,
} from "./report.js";
import type { ParsedRun } from "./log-parser.js";

function run(partial: Partial<ParsedRun> & { agent: string; wallClockSeconds: number }): ParsedRun {
  return {
    file: "x.log",
    ticket: 1,
    fileTimestamp: "2026-08-02T18:00:00.000Z",
    sections: [],
    dispatch: { ticketTitle: "t", branch: "b", worktree: "w", maxTurns: 135, timeoutMinutes: 25 },
    status: "success",
    output: "done",
    errorText: null,
    usage: {
      turns: 10,
      durationSeconds: Math.round(partial.wallClockSeconds),
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheCreation: 0,
      costUsd: 1,
      sessionId: "s",
    },
    wallClockEndSource: "usage",
    ...partial,
  };
}

describe("parseArgs", () => {
  test("requires --agents-repo and applies defaults", () => {
    const got = parseArgs(["--agents-repo", "/p/agents"]);
    assert.deepEqual(got, {
      agentsRepo: "/p/agents",
      ghRepo: "pyrycode/pyrycode",
      cacheDir: ".eval-cache",
      jsonPath: null,
    });
  });

  test("accepts overrides", () => {
    const got = parseArgs([
      "--agents-repo", "/p", "--gh-repo", "acme/proj", "--cache-dir", "/tmp/c", "--json", "out.json",
    ]);
    assert.equal(got.ghRepo, "acme/proj");
    assert.equal(got.cacheDir, "/tmp/c");
    assert.equal(got.jsonPath, "out.json");
  });

  test("skips the bare -- that pnpm run forwards", () => {
    const got = parseArgs(["--", "--agents-repo", "/p"]);
    assert.equal(got.agentsRepo, "/p");
  });

  test("throws a usage error without --agents-repo or on unknown flags", () => {
    assert.throws(() => parseArgs([]), /--agents-repo/);
    assert.throws(() => parseArgs(["--agents-repo", "/p", "--bogus"]), /--bogus/);
  });
});

describe("percentile", () => {
  test("median and p90 of a sorted list", () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
    assert.equal(percentile([42], 50), 42);
    assert.equal(percentile([], 50), 0);
  });
});

describe("summarizeWallClock", () => {
  const runs = [
    run({ agent: "developer", wallClockSeconds: 30 }),
    run({ agent: "developer", wallClockSeconds: 80 }),
    run({ agent: "developer", wallClockSeconds: 400 }),
    run({ agent: "developer", wallClockSeconds: 900 }),
    run({ agent: "qa", wallClockSeconds: 100 }),
    // Failed runs do not count as finished:
    run({ agent: "developer", wallClockSeconds: 10, status: "failed", usage: null, output: null }),
  ];
  const stats = summarizeWallClock(runs);

  test("per-agent wall-clock distribution over finished runs only", () => {
    const dev = stats.find((s) => s.agent === "developer")!;
    assert.equal(dev.finished, 4);
    assert.equal(dev.under60Share, 0.25);
    assert.equal(dev.under90Share, 0.5);
    assert.equal(dev.medianWallS, 240); // even count: mean of 80 and 400
    assert.equal(dev.p90WallS, 900);
  });

  test("model-reported duration summarized alongside for comparison", () => {
    const dev = stats.find((s) => s.agent === "developer")!;
    assert.equal(dev.under60ShareModel, 0.25);
    assert.equal(dev.medianModelS, 240);
  });

  test("agents are sorted by name", () => {
    assert.deepEqual(stats.map((s) => s.agent), ["developer", "qa"]);
  });
});

describe("detectWaitingTells", () => {
  test("matches case-insensitively anywhere in the output", () => {
    assert.deepEqual(detectWaitingTells("Everything was Already Committed by the previous run."), ["already committed"]);
    assert.deepEqual(detectWaitingTells("I will wait for the batch to land.\nNo changes needed."), [
      "wait for the batch",
      "no changes needed",
    ]);
  });

  test("returns empty for a normal output", () => {
    assert.deepEqual(detectWaitingTells("Implemented the feature, opened PR #5."), []);
  });

  test("the tell list is the documented five", () => {
    assert.equal(WAITING_TELLS.length, 5);
  });
});

describe("computeNoopStats", () => {
  const runs = [
    run({ agent: "developer", wallClockSeconds: 30, output: "Nothing to do here." }),
    run({ agent: "developer", wallClockSeconds: 500, output: "Shipped PR." }),
    run({ agent: "developer", wallClockSeconds: 45, output: "Work was already complete." }),
    run({ agent: "qa", wallClockSeconds: 20, output: "no changes needed" }),
  ];
  const stats = computeNoopStats(runs, "developer");

  test("wall-clock and tell-based no-op rates over finished developer runs", () => {
    assert.equal(stats.finished, 3);
    assert.equal(stats.under60Wall, 2);
    assert.equal(stats.under60Model, 2);
    assert.equal(stats.withTells, 2);
    assert.equal(stats.under60WallShare, 2 / 3);
  });

  test("tell counts are itemized", () => {
    assert.deepEqual(
      stats.tellCounts.filter((t) => t.count > 0).map((t) => t.tell),
      ["already complete", "nothing to do"],
    );
  });
});

describe("renderMarkdown", () => {
  test("renders the headline sections", () => {
    const md = renderMarkdown({
      logsDir: "/p/logs",
      ghRepo: "pyrycode/pyrycode",
      corpus: {
        runs: 3,
        byStatus: { success: 2, failed: 1, salvaged: 0 },
        excludedByReason: { filename: 1, "test-ticket": 2, "mock-prompt": 0, "no-dispatch": 3 },
        distinctTickets: 2,
        firstRunAt: "2026-08-02T18:49:12.446Z",
        lastRunAt: "2026-09-01T12:20:29.279Z",
      },
      wallClock: summarizeWallClock([run({ agent: "developer", wallClockSeconds: 100 })]),
      noop: computeNoopStats([run({ agent: "developer", wallClockSeconds: 100 })], "developer"),
      priorClaimUnder60Share: 0.3,
      backtest: {
        reviewsTotal: 1,
        byVerdict: { PASS: 1, FAIL: 0, UNKNOWN: 0 },
        passCleanCount: 1,
        passThenBounced: [],
        failCount: 0,
        failThenBounced: 0,
        mustFixBuckets: [
          { bucket: "0", reviews: 1, bounced: 0 },
          { bucket: "1", reviews: 0, bounced: 0 },
          { bucket: "2", reviews: 0, bounced: 0 },
          { bucket: "3+", reviews: 0, bounced: 0 },
        ],
        withoutOutcome: 0,
        rows: [],
      },
      backtestByAgent: [],
      fetch: { networkCalls: 0, reducedScope: false, missingTickets: 0, incompleteTimelines: 0 },
    });
    assert.match(md, /# Dispatcher eval report/);
    assert.match(md, /## Corpus/);
    assert.match(md, /## Developer no-op rate, remeasured/);
    assert.match(md, /## Review-verdict backtest/);
    assert.match(md, /\| developer \|/);
  });
});

describe("reviewInputs", () => {
  const usage = [{ name: "USAGE", timestamp: "2026-09-01T20:18:15.360Z" }];
  const runs = [
    run({ agent: "code-review", wallClockSeconds: 100, ticket: 1, sections: usage }),
    run({ agent: "verifier", wallClockSeconds: 100, ticket: 2, sections: usage }),
    run({ agent: "developer", wallClockSeconds: 100, ticket: 3, sections: usage }),
  ];

  test("takes the classic and the builder review stages, nothing else", () => {
    assert.deepEqual(reviewInputs(runs).map((r) => r.ticket), [1, 2]);
  });

  test("narrows to one stage on request", () => {
    assert.deepEqual(reviewInputs(runs, ["verifier"]).map((r) => r.ticket), [2]);
  });
});

describe("renderMarkdown per review stage", () => {
  const oneClean = {
    reviewsTotal: 1,
    byVerdict: { PASS: 1, FAIL: 0, UNKNOWN: 0 },
    passCleanCount: 1,
    passThenBounced: [],
    failCount: 0,
    failThenBounced: 0,
    mustFixBuckets: [
      { bucket: "0" as const, reviews: 1, bounced: 0 },
      { bucket: "1" as const, reviews: 0, bounced: 0 },
      { bucket: "2" as const, reviews: 0, bounced: 0 },
      { bucket: "3+" as const, reviews: 0, bounced: 0 },
    ],
    withoutOutcome: 0,
    rows: [],
  };
  const empty = { ...oneClean, reviewsTotal: 0, byVerdict: { PASS: 0, FAIL: 0, UNKNOWN: 0 }, passCleanCount: 0 };
  const data = (byAgent: { agent: string; backtest: typeof oneClean }[]) => ({
    logsDir: "/p/logs",
    ghRepo: "pyrycode/pyrycode",
    corpus: {
      runs: 1,
      byStatus: { success: 1, failed: 0, salvaged: 0 },
      excludedByReason: { filename: 0, "test-ticket": 0, "mock-prompt": 0, "no-dispatch": 0 },
      distinctTickets: 1,
      firstRunAt: null,
      lastRunAt: null,
    },
    wallClock: [],
    noop: computeNoopStats([], "developer"),
    priorClaimUnder60Share: 0.3,
    backtest: oneClean,
    backtestByAgent: byAgent,
    fetch: { networkCalls: 0, reducedScope: false, missingTickets: 0, incompleteTimelines: 0 },
  });

  test("splits by stage when the corpus spans both review stages", () => {
    const md = renderMarkdown(
      data([
        { agent: "code-review", backtest: oneClean },
        { agent: "verifier", backtest: oneClean },
      ]),
    );
    assert.match(md, /### By review stage: code-review/);
    assert.match(md, /### By review stage: verifier/);
  });

  test("stays a single section when only one stage has reviews", () => {
    const md = renderMarkdown(
      data([
        { agent: "code-review", backtest: oneClean },
        { agent: "verifier", backtest: empty },
      ]),
    );
    assert.doesNotMatch(md, /By review stage/);
  });
});
