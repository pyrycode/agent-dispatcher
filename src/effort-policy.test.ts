import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveEffort, validateEffortPolicy } from "./effort-policy.js";
import type { AgentConfig } from "./types.js";

const routine = "## Effort assessment\nRisk: routine\nReason: Copy change with explicit acceptance criteria.\n";
const elevated = "## Effort assessment\nRisk: elevated\nReason: Reconnect races with background delivery.\n";
const agent = (name: string, effort?: string) => ({ name, effort } as AgentConfig);
const select = (name: string, body = routine, labels: string[] = [], runner: "claude" | "codex" = "claude") =>
  resolveEffort({ agent: agent(name), item: { body, labels }, runner,
    env: { PYRY_EFFORT_POLICY: "role-risk-v1" }, stageSet: "builder" });

describe("role-risk effort trial", () => {
  test("routine and elevated work use the same role policy with either runner", () => {
    for (const runner of ["claude", "codex"] as const) {
      for (const [role, normal, risk] of [
        ["refiner", "medium", "high"], ["builder", "medium", "high"],
        ["verifier", "high", "high"], ["documentation", "low", "medium"],
      ]) {
        assert.equal(select(role, routine, [], runner).effort, normal);
        assert.equal(select(role, elevated, [], runner).effort, risk);
      }
    }
  });

  test("security-sensitive overrides a routine assessment even on an extra-small ticket", () => {
    for (const role of ["refiner", "builder", "verifier"]) {
      const result = select(role, routine, ["size:xs", "security-sensitive"]);
      assert.equal(result.effort, "high");
      assert.match(result.reason, /security-sensitive/);
    }
  });

  test("missing, malformed or ambiguous assessments cannot lower implementation effort", () => {
    for (const body of ["", "Risk: routine", "## Effort assessment\nRisk: routine",
      routine.replace("routine", "unknown"), routine + elevated,
      routine.replace("Risk: routine", "Risk: routine\nRisk: elevated"),
      "```md\n" + routine + "```\n"]) {
      assert.equal(select("builder", body, ["size:xs"]).effort, "high");
      assert.equal(select("documentation", body).effort, "medium");
    }
    assert.equal(select("refiner", "").effort, "medium");
  });

  test("assessment is bounded by headings and accepts CRLF", () => {
    assert.equal(select("builder", routine.replaceAll("\n", "\r\n")).effort, "medium");
    assert.equal(select("builder", routine + "## Other\nRisk: elevated\n").effort, "medium");
    assert.equal(select("builder", "## Effort assessment\nRisk: routine\n## Other\nReason: something\n").effort, "high");
  });

  test("a rework or outage label alone does not increase effort", () => {
    assert.equal(select("builder", routine, ["needs-rework:builder", "rework-count:2", "error:builder"]).effort, "medium");
  });

  test("unselected consumers keep their previous settings", () => {
    assert.equal(resolveEffort({ agent: agent("builder", "xhigh"), item: { body: routine, labels: [] },
      runner: "claude", env: {}, stageSet: "builder" }).effort, "xhigh");
    assert.equal(resolveEffort({ agent: agent("builder"), item: { body: routine, labels: [] },
      runner: "claude", env: {}, stageSet: "builder" }).effort, "high");
    assert.equal(resolveEffort({ agent: agent("builder", "high"), item: { body: routine, labels: [] },
      runner: "codex", env: {}, stageSet: "builder" }).effort, "");
  });

  test("explicit Codex effort wins over the trial", () => {
    const result = resolveEffort({ agent: agent("builder"), item: { body: elevated, labels: [] },
      runner: "codex", env: { PYRY_EFFORT_POLICY: "role-risk-v1", PYRY_CODEX_EFFORT: "xhigh" }, stageSet: "builder" });
    assert.equal(result.effort, "xhigh");
    assert.match(result.reason, /PYRY_CODEX_EFFORT/);
  });

  test("invalid configuration fails before board processing; off restores previous behaviour", () => {
    assert.throws(() => validateEffortPolicy("typo", "builder"), /PYRY_EFFORT_POLICY/);
    assert.throws(() => validateEffortPolicy("role-risk-v1", "classic"), /builder/);
    assert.doesNotThrow(() => validateEffortPolicy(undefined, "classic"));
    assert.equal(resolveEffort({ agent: agent("builder"), item: { body: routine, labels: [] },
      runner: "claude", env: { PYRY_EFFORT_POLICY: "off" }, stageSet: "builder" }).effort, "high");
  });
});
