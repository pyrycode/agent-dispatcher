import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRunnerSelector, loadRunnerFileStrict, parseRunnerFile, runnerFilePath, runnersInUse } from "./runner-file.js";

const enoent = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };

/** A selector over an in-memory file whose content the test can change between spawns. */
function selector(env: NodeJS.ProcessEnv, initial: string | null) {
  let content = initial;
  const warnings: string[] = [];
  const select = createRunnerSelector({
    path: "/agents/runner.json", env,
    read: () => (content === null ? enoent() : content),
    warn: (message) => warnings.push(message),
  });
  return { select, warnings, set: (next: string | null) => { content = next; } };
}

describe("runner file", () => {
  test("parses the runner and per-role overrides, and rejects anything else", () => {
    assert.deepEqual(parseRunnerFile('{"runner":"codex","roles":{"verifier":"claude"}}'),
      { runner: "codex", roles: { verifier: "claude" } });
    assert.deepEqual(parseRunnerFile("{}"), {});
    assert.throws(() => parseRunnerFile('{"runner":"gpt"}'), /"runner" must be "claude" or "codex"/);
    assert.throws(() => parseRunnerFile('{"runer":"codex"}'), /unknown key "runer"/);
    assert.throws(() => parseRunnerFile('{"roles":{"builder":"opus"}}'), /role "builder"/);
    assert.throws(() => parseRunnerFile('{"roles":["builder"]}'), /"roles" must be an object/);
    assert.throws(() => parseRunnerFile("[]"), /JSON object/);
    assert.throws(() => parseRunnerFile("{runner: codex}"), /not valid JSON/);
  });

  test("a role entry beats the file's runner, which beats PYRY_AGENT_RUNNER", () => {
    const { select } = selector({ PYRY_AGENT_RUNNER: "claude" }, '{"runner":"codex","roles":{"verifier":"claude"}}');
    assert.equal(select("builder"), "codex");
    assert.equal(select("verifier"), "claude");
    const env = selector({ PYRY_AGENT_RUNNER: "codex" }, '{"roles":{"verifier":"claude"}}');
    assert.equal(env.select("builder"), "codex");
    assert.equal(env.select("verifier"), "claude");
  });

  test("without a file, PYRY_AGENT_RUNNER decides, and Claude is the default", () => {
    assert.equal(selector({ PYRY_AGENT_RUNNER: "codex" }, null).select("builder"), "codex");
    assert.equal(selector({}, null).select("builder"), "claude");
  });

  test("an edit takes effect at the next spawn, with no restart", () => {
    const s = selector({}, '{"runner":"codex"}');
    assert.equal(s.select("builder"), "codex");
    s.set('{"runner":"claude"}');
    assert.equal(s.select("builder"), "claude");
  });

  test("a file that turns broken keeps the last valid one and warns once per error", () => {
    const s = selector({}, '{"runner":"codex"}');
    assert.equal(s.select("builder"), "codex");
    s.set('{"runner":"codx"}');
    assert.equal(s.select("builder"), "codex");
    assert.equal(s.select("verifier"), "codex");
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0], /keeping the last valid one/);
    s.set('{"runner":"claude"}');
    assert.equal(s.select("builder"), "claude");
  });

  test("a file broken from the start falls back to PYRY_AGENT_RUNNER", () => {
    const s = selector({ PYRY_AGENT_RUNNER: "codex" }, "not json");
    assert.equal(s.select("builder"), "codex");
    assert.match(s.warnings[0], /using PYRY_AGENT_RUNNER \(codex\)/);
  });

  test("deleting the file is deliberate: the fallback applies again", () => {
    const s = selector({ PYRY_AGENT_RUNNER: "claude" }, '{"runner":"codex"}');
    assert.equal(s.select("builder"), "codex");
    s.set(null);
    assert.equal(s.select("builder"), "claude");
    assert.equal(s.warnings.length, 0);
  });

  test("startup fails on a broken file and lists every runner in use", () => {
    assert.throws(() => loadRunnerFileStrict("/a/runner.json", () => '{"runner":1}'), /\/a\/runner.json/);
    assert.equal(loadRunnerFileStrict("/a/runner.json", enoent), null);
    assert.equal(loadRunnerFileStrict(null), null);
    assert.deepEqual([...runnersInUse({ roles: { verifier: "codex" } }, "claude")].sort(), ["claude", "codex"]);
    assert.deepEqual([...runnersInUse(null, "codex")], ["codex"]);
  });

  test("the path defaults beside the agents repo, can be moved, and can be turned off", () => {
    assert.equal(runnerFilePath({}, "/work/agents"), "/work/agents/runner.json");
    assert.equal(runnerFilePath({ PYRY_RUNNER_FILE: "/config/runner.json" }, "/work/agents"), "/config/runner.json");
    assert.equal(runnerFilePath({ PYRY_RUNNER_FILE: "" }, "/work/agents"), null);
  });
});
