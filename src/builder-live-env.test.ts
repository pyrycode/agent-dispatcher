import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSpawnEnv, SPAWN_ENV_DENYLIST } from "./agent-runtime.js";
import { agentShellEnvNameProblem, buildCodexInvocation, codexChildEnv } from "./agent-runner.js";
import { healthEnvForAgent } from "./health-check.js";

test("only the builder keeps a loaded live-test credential through Codex's scrubber", () => {
  const parent = { CLAUDE_CODE_OAUTH_TOKEN: "loaded-live-fixture", PYRY_LIVE_CLAUDE_TOKEN: "untrusted-alias-fixture" };
  const builder = codexChildEnv(agentSpawnEnv(parent, "builder"));
  assert.equal(builder.PYRY_LIVE_CLAUDE_TOKEN, "loaded-live-fixture");
  assert.equal(builder.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  for (const role of ["verifier", "refiner", "documentation", "recovery", "developer", "code-review"]) {
    assert.equal(codexChildEnv(agentSpawnEnv(parent, role)).PYRY_LIVE_CLAUDE_TOKEN, undefined, role);
  }
});

test("a loaded credential supports builder health checks without a service account", () => {
  const health = healthEnvForAgent({ CLAUDE_CODE_OAUTH_TOKEN: "loaded-live-fixture", RANDOM_SETTING: "dropped" }, "builder", "codex");
  assert.equal(health.key, "builder:codex-live");
  assert.equal(health.env.PYRY_LIVE_CLAUDE_TOKEN, "loaded-live-fixture");
  assert.equal(health.env.OP_SERVICE_ACCOUNT_TOKEN, undefined);
  assert.equal(health.env.RANDOM_SETTING, undefined);
});

test("only builder receives the restricted account, never Automation", () => {
  const parent = { PYRY_DEV_AGENTS_TOKEN: "restricted-fixture", OP_SERVICE_ACCOUNT_TOKEN: "automation-fixture", PATH: "/bin" };
  const builder = agentSpawnEnv(parent, "builder");
  assert.equal(builder.OP_SERVICE_ACCOUNT_TOKEN, "restricted-fixture");
  assert.equal(builder.PYRY_DEV_AGENTS_TOKEN, undefined);
  for (const role of ["refiner", "verifier", "documentation", "developer", "architect", "qa", "code-review", "po"]) {
    const env = agentSpawnEnv(parent, role);
    assert.equal(env.OP_SERVICE_ACCOUNT_TOKEN, undefined, role);
    assert.equal(env.PYRY_DEV_AGENTS_TOKEN, undefined, role);
  }
  assert.equal(parent.OP_SERVICE_ACCOUNT_TOKEN, "automation-fixture");
});

test("unset and blank restricted accounts are absent", () => {
  for (const token of [undefined, "", " "]) {
    const env = agentSpawnEnv({ PYRY_DEV_AGENTS_TOKEN: token, OP_SERVICE_ACCOUNT_TOKEN: "automation-fixture" }, "builder");
    assert.equal(Object.hasOwn(env, "OP_SERVICE_ACCOUNT_TOKEN"), false);
  }
});

test("the existing denylist still holds for every role", () => {
  const parent = Object.fromEntries([...SPAWN_ENV_DENYLIST].map(key => [key, "fixture"]));
  parent.PYRY_DEV_AGENTS_TOKEN = "restricted-fixture";
  parent.PYRY_AGENT_GITHUB_TOKEN = "agent-only-fixture";
  for (const role of ["builder", "verifier"]) {
    const env = agentSpawnEnv(parent, role);
    for (const key of SPAWN_ENV_DENYLIST) {
      if (role === "builder" && key === "OP_SERVICE_ACCOUNT_TOKEN") continue;
      if (key === "GH_TOKEN") { assert.equal(env[key], "agent-only-fixture"); continue; }
      assert.equal(env[key], undefined, key);
    }
  }
});

test("Codex builder uses names-only narrow inheritance and secret names stay rejected", () => {
  assert.ok(agentShellEnvNameProblem("OP_SERVICE_ACCOUNT_TOKEN"));
  assert.ok(agentShellEnvNameProblem("PYRY_DEV_AGENTS_TOKEN"));
  const opts = { cwd: "/repo", role: "builder", model: "", effort: "", builderLiveTests: true, shellEnv: { ANDROID_HOME: "/sdk" } };
  const { args } = buildCodexInvocation(opts);
  assert.ok(args.includes('shell_environment_policy.inherit="all"'));
  const names = args.find(arg => arg.startsWith("shell_environment_policy.include_only="))!;
  assert.ok(names.includes("OP_SERVICE_ACCOUNT_TOKEN"));
  assert.ok(names.includes("PYRY_LIVE_CLAUDE_TOKEN"));
  assert.ok(names.includes("ANDROID_HOME"));
  assert.ok(names.includes("GH_TOKEN"), "container publishing login must survive the builder override");
  assert.ok(names.includes("DISPLAY"), "Desktop live tests need the container display");
  assert.ok(names.includes("PLAYWRIGHT_BROWSERS_PATH"), "Desktop uses the image's browser cache");
  assert.ok(!names.includes("PYRY_DEV_AGENTS_TOKEN"));
  assert.ok(!names.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.ok(!names.includes("GITHUB_TOKEN"));
  assert.ok(!buildCodexInvocation({ ...opts, sourceReview: true }).args.some(arg => arg.includes("OP_SERVICE_ACCOUNT_TOKEN")));
  assert.ok(!buildCodexInvocation({ ...opts, builderLiveTests: false }).args.some(arg => arg.includes("OP_SERVICE_ACCOUNT_TOKEN")));
});

test("only the code-writing roles keep the Codex test login (pyrycode #3389)", () => {
  const parent = { PYRY_CODEX_CAPTURE_BIN: "/opt/codex", PYRY_CODEX_CAPTURE_HOME: "/home/x/.codex-test", PATH: "/bin" };
  for (const role of ["builder", "developer"]) assert.equal(agentSpawnEnv(parent, role).PYRY_CODEX_CAPTURE_HOME, "/home/x/.codex-test", role);
  for (const role of ["verifier", "code-review", "qa", "refiner", "documentation", "recovery", "po", "architect"]) {
    const env = agentSpawnEnv(parent, role);
    assert.ok(!("PYRY_CODEX_CAPTURE_BIN" in env) && !("PYRY_CODEX_CAPTURE_HOME" in env), role);
  }
});
