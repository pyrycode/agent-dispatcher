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
        ["refiner", "medium", "high"],
        ["verifier", "high", "high"], ["documentation", "low", "medium"],
      ]) {
        assert.equal(select(role, routine, [], runner).effort, normal);
        assert.equal(select(role, elevated, [], runner).effort, risk);
      }
    }
  });

  test("security-sensitive overrides a routine assessment even on an extra-small ticket", () => {
    for (const role of ["refiner", "verifier"]) {
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
      assert.equal(select("refiner", body, ["size:xs"]).effort, "medium");
      assert.equal(select("documentation", body).effort, "medium");
    }
    assert.equal(select("refiner", "").effort, "medium");
  });

  test("assessment is bounded by headings and accepts CRLF", () => {
    assert.equal(select("documentation", routine.replaceAll("\n", "\r\n")).effort, "low");
    assert.equal(select("documentation", routine + "## Other\nRisk: elevated\n").effort, "low");
    assert.equal(select("documentation", "## Effort assessment\nRisk: routine\n## Other\nReason: something\n").effort, "medium");
  });

  test("a rework or outage label alone does not increase effort", () => {
    assert.equal(select("documentation", routine, ["needs-rework:documentation", "rework-count:2", "error:documentation"]).effort, "low");
  });

  test("unselected consumers keep their previous settings", () => {
    assert.equal(resolveEffort({ agent: agent("verifier", "xhigh"), item: { body: routine, labels: [] },
      runner: "claude", env: {}, stageSet: "builder" }).effort, "xhigh");
    assert.equal(resolveEffort({ agent: agent("verifier"), item: { body: routine, labels: [] },
      runner: "claude", env: {}, stageSet: "builder" }).effort, "high");
    assert.equal(resolveEffort({ agent: agent("verifier", "high"), item: { body: routine, labels: [] },
      runner: "codex", env: {}, stageSet: "builder" }).effort, "");
  });

  test("explicit Codex effort wins over the trial", () => {
    const result = resolveEffort({ agent: agent("verifier"), item: { body: elevated, labels: [] },
      runner: "codex", env: { PYRY_EFFORT_POLICY: "role-risk-v1", PYRY_CODEX_EFFORT: "xhigh" }, stageSet: "builder" });
    assert.equal(result.effort, "xhigh");
    assert.match(result.reason, /PYRY_CODEX_EFFORT/);
  });

  test("invalid configuration fails before board processing; off restores previous behaviour", () => {
    assert.throws(() => resolveEffort({ agent: agent("builder"), item: { body: routine, labels: [] },
      runner: "claude", env: { PYRY_EFFORT_POLICY: "typo" }, stageSet: "builder" }), /PYRY_EFFORT_POLICY/);
    assert.throws(() => validateEffortPolicy("typo", "builder"), /PYRY_EFFORT_POLICY/);
    assert.throws(() => validateEffortPolicy("role-risk-v1", "classic"), /builder/);
    assert.doesNotThrow(() => validateEffortPolicy(undefined, "classic"));
    assert.equal(resolveEffort({ agent: agent("builder"), item: { body: routine, labels: [] },
      runner: "claude", env: { PYRY_EFFORT_POLICY: "off" }, stageSet: "builder" }).effort, "high");
  });
});

describe("builder effort", () => {
  const builder = (opts: { runner?: "claude" | "codex"; env?: NodeJS.ProcessEnv; reworkAfterFail?: boolean; effort?: string; body?: string; labels?: string[] } = {}) =>
    resolveEffort({ agent: agent("builder", opts.effort), item: { body: opts.body ?? routine, labels: opts.labels ?? [] },
      runner: opts.runner ?? "claude", env: opts.env ?? {}, stageSet: "builder", reworkAfterFail: opts.reworkAfterFail });

  test("high on a normal run and xhigh on a rework after a verifier FAIL, with either runner", () => {
    for (const runner of ["claude", "codex"] as const) {
      const first = builder({ runner });
      assert.equal(first.effort, "high");
      assert.equal(first.reason, "builder, not a rework after a verifier FAIL");
      const rework = builder({ runner, reworkAfterFail: true });
      assert.equal(rework.effort, "xhigh");
      assert.equal(rework.reason, "builder rework after a verifier FAIL");
    }
  });

  test("a rework label without a verifier FAIL stays at high", () => {
    assert.equal(builder({ labels: ["needs-rework:builder", "rework-count:2"] }).effort, "high");
  });

  test("beats the agent's own setting, role-risk-v1 and PYRY_CODEX_EFFORT, and names what it overrode", () => {
    assert.equal(builder({ effort: "medium" }).effort, "high");
    const trial = builder({ env: { PYRY_EFFORT_POLICY: "role-risk-v1" } });
    assert.equal(trial.effort, "high", "a routine assessment no longer lowers the builder");
    assert.equal(trial.policy, "role-risk-v1");
    assert.match(trial.reason, /overrides role-risk-v1$/);
    const codex = builder({ runner: "codex", reworkAfterFail: true, env: { PYRY_CODEX_EFFORT: "medium", PYRY_EFFORT_POLICY: "role-risk-v1" } });
    assert.equal(codex.effort, "xhigh");
    assert.match(codex.reason, /overrides PYRY_CODEX_EFFORT=medium and role-risk-v1$/);
    assert.doesNotMatch(builder({ runner: "claude", env: { PYRY_CODEX_EFFORT: "medium" } }).reason, /PYRY_CODEX_EFFORT/,
      "the Codex setting never applied to Claude, so nothing was overridden");
  });
});
