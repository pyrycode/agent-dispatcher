import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeStreaming } from "./dispatch.js";

// Exercise the real detached child, stdin, JSONL buffering and close handlers.
// This executable never contacts a model, repository or board.
const executable = `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  fs.writeFileSync('observed.json', JSON.stringify({
    argv: process.argv.slice(2), input, cwd: process.cwd(), pid: process.pid,
    credentialKeys: Object.keys(process.env).filter(key => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(key) || key === 'CLAUDE_CONFIG_DIR'),
    ordinary: process.env.TEST_ORDINARY
  }));
  const events = [
    {type:'thread.started', thread_id:'fixture-thread'},
    {type:'turn.started'},
    {type:'item.completed', item:{id:'message', type:'agent_message', text:JSON.stringify({status:'completed', summary:'Fixture finished'})}},
    {type:'turn.completed', usage:{input_tokens:100, cached_input_tokens:60, output_tokens:12}}
  ];
  if (process.env.TEST_MODE === 'timeout') {
    process.on('SIGTERM', () => fs.writeFileSync('term-received', 'yes'));
    process.stdout.write(JSON.stringify(events[0]) + '\\n');
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.TEST_MODE === 'reconnect') events.splice(2, 0, {type:'error',message:'Reconnecting 1/5: connection reset'});
  if (process.env.TEST_MODE === 'failed-command') events.splice(2, 0, {type:'item.completed',item:{id:'red-test',type:'command_execution',status:'failed',exit_code:1,aggregated_output:'Expected red test'}});
  if (process.env.TEST_MODE === 'blocked') events[2].item.text = JSON.stringify({status:'blocked', summary:'Required action rejected by review'});
  if (process.env.TEST_MODE === 'unicode') events[2].item.text = JSON.stringify({status:'completed', summary:'Fixture café finished'});
  if (process.env.TEST_MODE === 'missing-terminal') events.pop();
  const output = events.map(event => JSON.stringify(event)).join('\\n');
  if (process.env.TEST_MODE === 'unicode') {
    const bytes = Buffer.from(output);
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 20));
    process.stdout.write(bytes.subarray(split));
  } else if (process.env.TEST_MODE === 'chunks') {
    for (let at = 0; at < output.length; at += 17) {
      process.stdout.write(output.slice(at, at + 17));
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  } else process.stdout.write(output);
  process.exitCode = process.env.TEST_MODE === 'nonzero' ? 7 : 0;
});
`;

function fixture(t: { after: (fn: () => void) => void }, mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "codex-runner integration "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "fake codex.cjs");
  writeFileSync(bin, executable);
  chmodSync(bin, 0o755);
  const prompt = 'Task with "quotes", $literal and `backticks`\nSecond line.\n';
  const role = 'Role with "quotes" and a newline\nStay in assigned scope.';
  writeFileSync(join(dir, "prompt.txt"), prompt);
  writeFileSync(join(dir, "role.txt"), role);
  return {
    dir, prompt, role,
    options: {
      runner: "codex" as const, promptFile: join(dir, "prompt.txt"),
      systemPromptFile: join(dir, "role.txt"), model: "fixture-model", effort: "high",
      maxTurns: 99, allowedTools: "Bash,Read", disallowedTools: "AskUserQuestion",
      cwd: dir, timeoutMs: 5000, logFile: join(dir, "run.log"),
      env: {
        PATH: process.env.PATH, PYRY_CODEX_BIN: bin, TEST_MODE: mode,
        TEST_ORDINARY: "preserved", CLAUDE_CODE_OAUTH_TOKEN: "fixture-only",
        ANTHROPIC_API_KEY: "fixture-only", CLAUDE_CONFIG_DIR: "/fixture-only",
      },
    },
  };
}

test("Codex subprocess receives literal stdin, additive role, schema and reviewed workspace permissions", async t => {
  const f = fixture(t, "normal");
  const result = await runClaudeStreaming(f.options);
  assert.equal(result.isError, false);
  assert.equal(result.output, "Fixture finished");
  assert.equal(result.sessionId, "fixture-thread");
  assert.equal(result.costKnown, false);
  assert.equal(result.usage.cache_read_input_tokens, 60);
  const observed = JSON.parse(readFileSync(join(f.dir, "observed.json"), "utf8"));
  assert.equal(observed.input, f.prompt);
  assert.equal(observed.cwd, realpathSync(f.dir));
  assert.deepEqual(observed.credentialKeys, []);
  assert.equal(observed.ordinary, "preserved");
  const args: string[] = observed.argv;
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--approve-for-me"));
  // --approve-for-me selects workspace-write and conflicts with --sandbox.
  assert.ok(!args.includes("--sandbox"));
  assert.equal(args[args.indexOf("--cd") + 1], f.dir);
  assert.equal(args[args.indexOf("--model") + 1], "fixture-model");
  assert.equal(args.at(-1), "-");
  const roleArg = args.find(arg => arg.startsWith("developer_instructions="));
  assert.ok(roleArg);
  assert.ok(JSON.parse(roleArg.slice("developer_instructions=".length)).startsWith(f.role));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('project_doc_fallback_filenames=["CLAUDE.md"]'));
  const schema = JSON.parse(readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
  assert.deepEqual(schema.properties.status.enum, ["completed", "blocked"]);
  for (const forbidden of ["--max-turns", "--allowedTools", "--disallowedTools", "--dangerously-bypass-approvals-and-sandbox"]) assert.ok(!args.includes(forbidden));
});

test("Codex JSON split across chunks and terminal event without newline is consumed", async t => {
  const f = fixture(t, "chunks");
  const result = await runClaudeStreaming(f.options);
  assert.equal(result.isError, false);
  assert.equal(result.output, "Fixture finished");
  assert.equal(result.numTurns, 1);
});

test("Codex nonzero process exit cannot become success after a completed turn", async t => {
  const result = await runClaudeStreaming(fixture(t, "nonzero").options);
  assert.equal(result.isError, true);
  assert.equal(result.terminalReason, "codex_error");
  assert.match(result.output, /code 7/);
});

test("Codex UTF-8 summary split within a character survives stdout buffering", async t => {
  const result = await runClaudeStreaming(fixture(t, "unicode").options);
  assert.equal(result.isError, false);
  assert.equal(result.output, "Fixture café finished");
});

test("Codex reconnect diagnostics do not poison a later completed task", async t => {
  const result = await runClaudeStreaming(fixture(t, "reconnect").options);
  assert.equal(result.isError, false);
  assert.equal(result.output, "Fixture finished");
});

test("Codex expected failed command does not mark the complete task failed", async t => {
  const result = await runClaudeStreaming(fixture(t, "failed-command").options);
  assert.equal(result.isError, false);
});

test("Codex completed process with blocked outcome stays an error", async t => {
  const result = await runClaudeStreaming(fixture(t, "blocked").options);
  assert.equal(result.isError, true);
  assert.equal(result.terminalReason, "codex_blocked");
  assert.match(result.output, /rejected by review/);
});

test("Codex exit zero without terminal event cannot advance the task", async t => {
  const result = await runClaudeStreaming(fixture(t, "missing-terminal").options);
  assert.equal(result.isError, true);
});

test("Codex timeout preserves thread and kills a process that ignores SIGTERM", { timeout: 10000 }, async t => {
  const f = fixture(t, "timeout");
  const start = Date.now();
  const result = await runClaudeStreaming({ ...f.options, timeoutMs: 700 });
  assert.equal(result.isError, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminalReason, "timeout");
  assert.equal(result.sessionId, "fixture-thread");
  assert.ok(existsSync(join(f.dir, "term-received")), "fixture must install its handler and observe SIGTERM before SIGKILL");
  assert.ok(Date.now() - start < 8000, "SIGKILL must bound an ignored SIGTERM");
  const { pid } = JSON.parse(readFileSync(join(f.dir, "observed.json"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
