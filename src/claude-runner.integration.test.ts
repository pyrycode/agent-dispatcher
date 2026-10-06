import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeStreaming } from "./dispatch.js";
import { AgentRunFailedError } from "./agent-runtime.js";

// Real subprocess/stream path for the default claude runner (`pyry
// agent-run`), driven by a fixture binary on PATH. No model, no board.
//
// The fixture prints stream-json lines per MODE:
//   stall         one thinking block, then silence (pyrycode-mobile #1430)
//   stall-result  as stall, but answers SIGTERM with an error result frame
//   linger        a success result, then the process hangs on exit
//   tool-silence  a tool call that runs longer than the idle threshold
//   crash         stderr only, exit 1, no result frame (pyrycode-mobile #1340)
//   crash-after-work  a text message and a tool call, then as crash
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
} else if (mode === "crash-after-work") {
  out({ type: "assistant", message: { content: [{ type: "text", text: "All tests pass. Committing the fix." }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "commit", name: "Bash", input: { command: "git commit -m 'fix(thread): close the prompt'" } }] } });
  process.stderr.write("Error: socket hang up\\n");
  process.exitCode = 1;
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

test("a CLI that exits without a result hands on the agent's own last output with its rejection (#16)", async t => {
  const { run } = await runFixture(t, "crash-after-work", "10");
  await assert.rejects(run, (err: Error) => {
    assert.ok(err instanceof AgentRunFailedError);
    assert.match(err.message, /^Claude CLI exited with code 1, no result message received/);
    assert.equal(err.agentOutputTail, "All tests pass. Committing the fix.\n[Bash] git commit -m 'fix(thread): close the prompt'");
    assert.doesNotMatch(err.message, /All tests pass/, "the agent's words stay out of the classified message");
    return true;
  });
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

// Wait credit for Claude runs (wait-credit.ts). The fixture runs one Bash
// call from boot for COMMAND_MS, past the dispatcher's 4 s budget, then
// returns its result: a device wait as long as the call, or a plain build
// line. It answers as both `pyry` (a first leg) and `claude` (a
// continuation leg, which resumes through the `claude` binary).
const WAIT_FIXTURE = `#!${process.execPath}
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const mode = process.env.MODE;
const commandMs = Number(process.env.COMMAND_MS || 6000);
out({ type: "system", subtype: "init", session_id: "sess-wait" });
out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_gate", name: "Bash", input: { command: "python3 scripts/android-test-gate.py scripted send-now 2>&1", timeout: 600000 } }] } });
setTimeout(() => {
  const content = mode === "grace-credit"
    ? "Android gate: device held by live from /w since x; waiting up to 2700s\\nAndroid gate: device free after " + commandMs / 1000 + "s waiting\\nAndroid gate: 1 executed; process exit 0\\n"
    : "BUILD SUCCESSFUL\\n";
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_gate", content }] } });
  setTimeout(() => {
    out({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", session_id: "sess-wait", terminal_reason: "completed" });
  }, mode === "grace-credit" ? 0 : 1500);
}, commandMs);
`;

function waitFixture(t: { after: (fn: () => void) => void }, mode: string, ceilingFactor: string, resumeSessionId?: string) {
  const root = mkdtempSync(join(tmpdir(), "claude-wait-test-"));
  const saved = Object.fromEntries(["PYRY_AGENT_IDLE_TIMEOUT_MINUTES", "PYRY_USE_LEGACY_CLAUDE", "PYRY_TIMEOUT_CEILING_FACTOR", "PYRY_TIMEOUT_GRACE_MINUTES"]
    .map(k => [k, process.env[k]]));
  process.env.PYRY_AGENT_IDLE_TIMEOUT_MINUTES = "10";
  process.env.PYRY_TIMEOUT_CEILING_FACTOR = ceilingFactor;
  delete process.env.PYRY_USE_LEGACY_CLAUDE;
  delete process.env.PYRY_TIMEOUT_GRACE_MINUTES;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  for (const bin of ["pyry", "claude"]) {
    writeFileSync(join(root, bin), WAIT_FIXTURE);
    chmodSync(join(root, bin), 0o755);
  }
  writeFileSync(join(root, "prompt.txt"), "do the thing");
  writeFileSync(join(root, "system.txt"), "role");
  const logFile = join(root, "run.log");
  const run = runClaudeStreaming({
    runner: "claude", cwd: root, promptFile: join(root, "prompt.txt"), systemPromptFile: join(root, "system.txt"),
    model: "fixture-model", effort: "high", maxTurns: 10, allowedTools: "Bash", disallowedTools: "",
    timeoutMs: 4000, logFile, env: { PATH: root + ":" + process.env.PATH, MODE: mode }, resumeSessionId,
  });
  return { run, logFile };
}

test("Claude Bash call running past the budget gets a grace, and a wait it reports buys the time to finish", { timeout: 30000 }, async t => {
  // Margins are wide because the fake can take seconds to boot on a loaded
  // host: its Bash call starts inside the 4 s budget, then returns 6 s after
  // boot showing a 6 s device wait, which moves the deadline to about 10 s,
  // past its result.
  const { run, logFile } = waitFixture(t, "grace-credit", "10");
  const result = await run;
  assert.equal(result.isError, false, result.output);
  assert.equal(result.timedOut, false);
  assert.equal(result.output, "done");
  assert.ok((result.waitCreditMs ?? 0) >= 4000, `credit ${result.waitCreditMs}`);
  const log = readFileSync(logFile, "utf8");
  assert.match(log, /GRACE/);
  assert.match(log, /WAIT CREDIT/);
});

test("Claude continuation leg earns wait credit on its own clock", { timeout: 30000 }, async t => {
  const { run, logFile } = waitFixture(t, "grace-credit", "10", "sess-wait");
  const result = await run;
  assert.equal(result.isError, false, result.output);
  assert.equal(result.sessionId, "sess-wait");
  assert.ok((result.waitCreditMs ?? 0) >= 4000, `credit ${result.waitCreditMs}`);
  assert.match(readFileSync(logFile, "utf8"), /WAIT CREDIT/);
});

test("Claude grace ends when the Bash call returns without showing a wait", { timeout: 30000 }, async t => {
  // The fake would report success 1.5 s after its Bash result; the kill lands first.
  const { run, logFile } = waitFixture(t, "grace-no-credit", "10");
  await assert.rejects(run, (err: Error) => {
    assert.match(err.message, /timed out/);
    return true;
  });
  assert.match(readFileSync(logFile, "utf8"), /the command the grace waited for has finished/);
});

test("Claude grace still stops at the hard ceiling", { timeout: 30000 }, async t => {
  // A 5 s ceiling on a 4 s budget; the Bash call would report only 6 s after boot.
  const start = Date.now();
  const { run, logFile } = waitFixture(t, "grace-credit", "1.25");
  await assert.rejects(run, /timed out/);
  assert.ok(Date.now() - start < 9000, "stopped at the ceiling, not after the call reported its wait");
  assert.match(readFileSync(logFile, "utf8"), /hard ceiling reached/);
});
