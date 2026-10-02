import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeStreaming } from "./dispatch.js";

// Real subprocess/stream path for the default claude runner (`pyry
// agent-run`), driven by a fixture binary on PATH. No model, no board.
//
// The fixture prints stream-json lines per MODE:
//   stall         one thinking block, then silence (pyrycode-mobile #1430)
//   stall-result  as stall, but answers SIGTERM with an error result frame
//   linger        a success result, then the process hangs on exit
//   tool-silence  a tool call that runs longer than the idle threshold
const FIXTURE = `#!${process.execPath}
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const mode = process.env.MODE;
out({ type: "system", subtype: "init", session_id: "sess-fixture" });
if (mode === "linger") {
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", session_id: "sess-fixture", terminal_reason: "completed" });
  setTimeout(() => {}, 30_000);
} else if (mode === "stall" || mode === "stall-result") {
  out({ type: "assistant", message: { content: [{ type: "thinking", thinking: "planning the edit" }] } });
  if (mode === "stall-result") {
    process.on("SIGTERM", () => {
      out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 4, session_id: "sess-fixture", terminal_reason: "" });
      process.exit(143);
    });
  }
  setTimeout(() => {}, 30_000);
} else if (mode === "tool-silence") {
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "gradle", name: "Bash", input: {} }] } });
  setTimeout(() => {
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "gradle", content: "BUILD SUCCESSFUL" }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", session_id: "sess-fixture", terminal_reason: "completed" });
  }, 2500);
}
`;

async function runFixture(t: { after: (fn: () => void) => void }, mode: string, idleMinutes: string, timeoutMs = 20_000) {
  const root = mkdtempSync(join(tmpdir(), "claude-runner-test-"));
  const savedIdle = process.env.PYRY_AGENT_IDLE_TIMEOUT_MINUTES;
  const savedLegacy = process.env.PYRY_USE_LEGACY_CLAUDE;
  process.env.PYRY_AGENT_IDLE_TIMEOUT_MINUTES = idleMinutes;
  delete process.env.PYRY_USE_LEGACY_CLAUDE;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedIdle === undefined) delete process.env.PYRY_AGENT_IDLE_TIMEOUT_MINUTES;
    else process.env.PYRY_AGENT_IDLE_TIMEOUT_MINUTES = savedIdle;
    if (savedLegacy !== undefined) process.env.PYRY_USE_LEGACY_CLAUDE = savedLegacy;
  });
  writeFileSync(join(root, "pyry"), FIXTURE);
  chmodSync(join(root, "pyry"), 0o755);
  writeFileSync(join(root, "prompt.txt"), "do the thing");
  writeFileSync(join(root, "system.txt"), "role");
  const logFile = join(root, "run.log");
  const run = runClaudeStreaming({
    runner: "claude", cwd: root, promptFile: join(root, "prompt.txt"), systemPromptFile: join(root, "system.txt"),
    model: "fixture-model", effort: "high", maxTurns: 10, allowedTools: "Bash", disallowedTools: "",
    timeoutMs, logFile, env: { PATH: root + ":" + process.env.PATH, MODE: mode },
  });
  return { run, logFile };
}

// 0.01 min = 600ms of silence; the watchdog polls every second.
test("idle watchdog kills a run that goes silent with no tool outstanding, and the error says idle_stall", async t => {
  const { run, logFile } = await runFixture(t, "stall", "0.01");
  const started = Date.now();
  await assert.rejects(run, (err: Error) => {
    assert.match(err.message, /idle_stall/);
    return true;
  });
  assert.ok(Date.now() - started < 10_000, "fired on the idle threshold, not the 20s wall clock");
  assert.match(readFileSync(logFile, "utf8"), /IDLE STALL/);
});

test("idle watchdog: a result frame written after the kill is reported as idle_stall", async t => {
  const { run } = await runFixture(t, "stall-result", "0.01");
  const result = await run;
  assert.equal(result.isError, true);
  assert.equal(result.terminalReason, "idle_stall");
  assert.equal(result.timedOut, false, "a stall is not a wall-clock timeout");
});

test("idle watchdog stands down once the result is in: a process lingering after success stays a success", async t => {
  const { run, logFile } = await runFixture(t, "linger", "0.01", 3000);
  const result = await run;
  assert.equal(result.isError, false);
  assert.equal(result.output, "done");
  assert.equal(result.timedOut, true, "the wall clock, not the watchdog, ended the lingering process");
  assert.doesNotMatch(readFileSync(logFile, "utf8"), /IDLE STALL/);
});

test("idle watchdog stays quiet while a tool call is outstanding", async t => {
  const { run, logFile } = await runFixture(t, "tool-silence", "0.01");
  const result = await run;
  assert.equal(result.isError, false);
  assert.equal(result.output, "done");
  assert.doesNotMatch(readFileSync(logFile, "utf8"), /IDLE STALL/);
});
