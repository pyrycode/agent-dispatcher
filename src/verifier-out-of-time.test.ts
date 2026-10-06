import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AgentRunStoppedError } from "./agent-runtime.js";
import {
  OUT_OF_TIME_REPORT_CAP,
  outOfTimeComment,
  ReviewBudgetExhaustedError,
  reviewBudgetStop,
  type ReviewProgress,
} from "./verifier-out-of-time.js";

const result = (overrides: Partial<{ isError: boolean; timedOut: boolean; terminalReason: string; hadPermissionDenial: boolean }> = {}) => ({
  isError: true,
  timedOut: false,
  terminalReason: "",
  hadPermissionDenial: false,
  ...overrides,
});

describe("reviewBudgetStop", () => {
  test("the wall clock counts through the runner's rejection and through a marked result", () => {
    assert.equal(reviewBudgetStop(new AgentRunStoppedError("Agent timed out after 3600s", "timeout"), null), "time");
    assert.equal(reviewBudgetStop(new Error("Agent error (timeout)"), result({ timedOut: true, terminalReason: "timeout" })), "time");
  });

  test("the turn cap counts", () => {
    assert.equal(reviewBudgetStop(new Error("Agent error (max_turns)"), result({ terminalReason: "max_turns" })), "turns");
  });

  test("the overlapped review's own budget errors carry their kind", () => {
    assert.equal(reviewBudgetStop(new ReviewBudgetExhaustedError("source review ran out of time", "time"), null), "time");
    assert.equal(reviewBudgetStop(new ReviewBudgetExhaustedError("turn budget exhausted", "turns"), null), "turns");
  });

  test("an idle stall, a denial, a blocked run and an ordinary error are not budget stops", () => {
    assert.equal(reviewBudgetStop(new AgentRunStoppedError("idle", "idle_stall"), null), null);
    assert.equal(reviewBudgetStop(new Error("x"), result({ timedOut: true, hadPermissionDenial: true })), null);
    assert.equal(reviewBudgetStop(new Error("x"), result({ terminalReason: "max_turns", hadPermissionDenial: true })), null);
    assert.equal(reviewBudgetStop(new Error("x"), result({ timedOut: true, terminalReason: "codex_blocked" })), null);
    assert.equal(reviewBudgetStop(new Error("x"), result({ terminalReason: "codex_error" })), null);
    assert.equal(reviewBudgetStop(new Error("Preliminary source review did not complete"), null), null);
    assert.equal(reviewBudgetStop(new Error("x"), result({ isError: false, terminalReason: "max_turns" })), null);
  });
});

describe("outOfTimeComment", () => {
  const MIN = 60_000;
  const base = {
    agentName: "verifier",
    kind: "time" as const,
    fallbackBudgetMs: 60 * MIN,
    reusableGates: null,
    errorLabel: "error:verifier",
    agentOutput: "",
    resumeHint: null,
    logFile: "/logs/verifier_#1619.log",
  };

  test("mobile #1619's shape: green gates outside the budget, finished source review, final review out of time", () => {
    const progress: ReviewProgress = {
      phase: "final review",
      budgetMs: 56 * MIN,
      gatesMs: 61 * MIN,
      sourceMs: 4 * MIN,
      sourceReport: "No MUST FIX findings.\n- NIT: index.md, Failure notice",
    };
    const body = outOfTimeComment({
      ...base,
      progress,
      reusableGates: { commit: "7aced731aaaabbbbccccddddeeeeffff00001111", untilMs: Date.parse("2026-10-04T09:18:00Z") },
      agentOutput: "[shell] figma get_screenshot 696:4913\nComparing the frames",
      resumeHint: "codex resume thread-1",
    });
    assert.match(body, /^## ⏱️ Verifier ran out of time\n/);
    assert.match(body, /The verifier's final review used its 56-minute budget\. It was stopped before it published a verdict\. The ticket is parked under `error:verifier`\./);
    assert.match(body, /\*\*Gates:\*\* took 61 minutes\. That time is not charged to the review's budget\./);
    assert.match(body, /every gate passed on commit `7aced731aaaa`\. The next verifier run reuses them .* starts before 2026-10-04 09:18 UTC\./);
    assert.match(body, /\*\*Source review:\*\* finished in 4 minutes\. Its report is below\./);
    assert.match(body, /\*\*Next step:\*\* remove `error:verifier` to run the verifier again\./);
    assert.match(body, /<details><summary>Source review report<\/summary>\n\nNo MUST FIX findings\.\n- NIT: index\.md, Failure notice\n\n<\/details>/);
    assert.match(body, /\*\*Last output from the agent\*\* \(its messages and tool calls, newest last\):\n\n```\n\[shell\] figma get_screenshot 696:4913\nComparing the frames\n```\n\n\*\*Debug\*\*: `codex resume thread-1`$/);
    assert.doesNotMatch(body, /Manual intervention required/);
  });

  test("a source review out of time says the final review never started", () => {
    const body = outOfTimeComment({ ...base, progress: { phase: "source review", budgetMs: 60 * MIN, gatesMs: 30 * MIN, sourceMs: 60 * MIN } });
    assert.match(body, /The verifier's source review used its 60-minute budget\. The final review never started, so no verdict was published\./);
    assert.match(body, /no green run of every gate is recorded for these files, so the next verifier run runs the gates again/);
    assert.doesNotMatch(body, /Source review report/, "no report to carry");
  });

  test("turns, and a single review that used its continuation leg", () => {
    const turns = outOfTimeComment({ ...base, kind: "turns", progress: { phase: "source review", budgetMs: 60 * MIN, gatesMs: 0, sourceMs: 5 * MIN, sourceReport: "Report" } });
    assert.match(turns, /^## ⏱️ Verifier ran out of turns\n/);
    assert.match(turns, /The verifier's source review used the whole turn budget\. The final review never started/);
    assert.match(turns, /\*\*Gates:\*\* took under a minute\./);

    const serial = outOfTimeComment({ ...base, progress: { phase: "review", budgetMs: 60 * MIN, gatesMs: 20 * MIN, legsUsed: 1 } });
    assert.match(serial, /The verifier used its 60-minute budget and one continuation leg with a fresh budget\. It was stopped before it published a verdict\./);
  });

  test("with nothing recorded it still names the budget and the next step", () => {
    const body = outOfTimeComment({ ...base, progress: undefined });
    assert.match(body, /The verifier used its 60-minute budget\. It was stopped before it published a verdict\./);
    assert.doesNotMatch(body, /Gates:/);
    assert.doesNotMatch(body, /Last output from the agent|Debug/);
    assert.match(body, /remove `error:verifier`/);
  });

  test("a long report is cut and points at the dispatch log", () => {
    const report = "x".repeat(OUT_OF_TIME_REPORT_CAP + 500);
    const body = outOfTimeComment({ ...base, progress: { phase: "final review", budgetMs: 30 * MIN, sourceMs: MIN, sourceReport: report } });
    assert.ok(body.length < OUT_OF_TIME_REPORT_CAP + 2000);
    assert.match(body, /The report was cut here\. The whole report is in the dispatch log `\/logs\/verifier_#1619\.log`\./);
  });
});
