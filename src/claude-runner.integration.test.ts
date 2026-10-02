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
//   crash         stderr only, exit 1, no result frame (pyrycode-mobile #1340)
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
} else if (mode === "crash") {
  process.stderr.write("Error: Request timed out.\\n    at retry (cli.js:1:2)\\n");
  process.stderr.write("auth header: Bearer " + "c".repeat(40) + "\\n");
  process.exitCode = 1; // natural exit, so the piped stderr is flushed first
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

test("a CLI that exits without a result keeps its stderr: scrubbed tail in the error and the log", async t => {
  const { run, logFile } = await runFixture(t, "crash", "10");
  await assert.rejects(run, (err: Error) => {
    assert.match(err.message, /^Claude CLI exited with code 1, no result message received\n--- stderr/);
    assert.match(err.message, /Error: Request timed out\./);
    assert.match(err.message, /Bearer \[REDACTED\]/);
    assert.ok(!err.message.includes("c".repeat(40)));
    return true;
  });
  const log = readFileSync(logFile, "utf8");
  assert.match(log, /STDERR \(tail\)/);
  assert.match(log, /at retry \(cli\.js:1:2\)/);
  assert.ok(!log.includes("c".repeat(40)), "the log copy is scrubbed too");
});

// pyrycode-mobile #1432 (2026-10-02): the source review's prompt was piped
// in after spawn, the dispatcher's event loop did not get to it within the
// CLI's 3-second stdin window, and the CLI exited 1 with no result. The
// prompt now IS the child's stdin, a regular file the kernel serves, so its
// delivery no longer depends on this process. The fixture reports what fd 0
// is and what it read, while the parent blocks its own event loop for 1.5 s
// right after starting the run, the shape of a burst of blocking git calls.
const STDIN_FIXTURE = `#!${process.execPath}
const fs = require("node:fs");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const kind = fs.fstatSync(0).isFile() ? "file" : "other";
const text = kind === "file" ? fs.readFileSync(0, "utf8") : "";
out({ type: "system", subtype: "init", session_id: "sess-stdin" });
out({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: kind + ":" + text, session_id: "sess-stdin", terminal_reason: "completed" });
`;

test("a runner that reads its prompt on stdin gets the prompt file itself, even while the event loop is blocked", async t => {
  const root = mkdtempSync(join(tmpdir(), "claude-stdin-test-"));
  const savedLegacy = process.env.PYRY_USE_LEGACY_CLAUDE;
  process.env.PYRY_USE_LEGACY_CLAUDE = "1"; // the `claude -p` path reads the prompt from stdin
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedLegacy === undefined) delete process.env.PYRY_USE_LEGACY_CLAUDE;
    else process.env.PYRY_USE_LEGACY_CLAUDE = savedLegacy;
  });
  writeFileSync(join(root, "claude"), STDIN_FIXTURE);
  chmodSync(join(root, "claude"), 0o755);
  writeFileSync(join(root, "prompt.txt"), "review this diff");
  writeFileSync(join(root, "system.txt"), "role");
  const run = runClaudeStreaming({
    runner: "claude", cwd: root, promptFile: join(root, "prompt.txt"), systemPromptFile: join(root, "system.txt"),
    model: "fixture-model", effort: "high", maxTurns: 10, allowedTools: "Bash", disallowedTools: "",
    timeoutMs: 20_000, logFile: join(root, "run.log"), env: { PATH: root + ":" + process.env.PATH },
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  const result = await run;
  assert.equal(result.output, "file:review this diff");
});
