import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSpawnEnv, SPAWN_ENV_DENYLIST } from "./agent-runtime.js";
import { agentShellEnvNameProblem, buildCodexInvocation } from "./agent-runner.js";

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
  for (const role of ["builder", "verifier"]) {
    const env = agentSpawnEnv(parent, role);
    for (const key of SPAWN_ENV_DENYLIST) {
      if (role === "builder" && key === "OP_SERVICE_ACCOUNT_TOKEN") continue;
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
  assert.ok(names.includes("ANDROID_HOME"));
  assert.ok(!names.includes("PYRY_DEV_AGENTS_TOKEN"));
  assert.ok(!names.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.ok(!names.includes("GITHUB_TOKEN"));
  assert.ok(!buildCodexInvocation({ ...opts, sourceReview: true }).args.some(arg => arg.includes("OP_SERVICE_ACCOUNT_TOKEN")));
  assert.ok(!buildCodexInvocation({ ...opts, builderLiveTests: false }).args.some(arg => arg.includes("OP_SERVICE_ACCOUNT_TOKEN")));
});
