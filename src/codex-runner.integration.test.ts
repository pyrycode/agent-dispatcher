import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  if (process.env.TEST_MODE === 'agents-path') {
    // Model the CLI's core shell environment: custom inherited values disappear
    // unless the runner explicitly supplies them through the config set table.
    const shellEnv = {};
    for (const arg of process.argv.slice(2)) {
      const match = /^shell_environment_policy\\.set\\.AGENTS_REPO_PATH=(.*)$/.exec(arg);
      if (match) shellEnv.AGENTS_REPO_PATH = JSON.parse(match[1]);
    }
    const path = shellEnv.AGENTS_REPO_PATH;
    if (!path || fs.readFileSync(require('node:path').join(path, 'builder/security-review.md'), 'utf8') !== 'fixture security checklist') {
      process.stderr.write('Security review path unavailable in core shell environment');
      process.exitCode = 1;
      return;
    }
  }
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
  if (process.env.TEST_MODE === 'refinement') events[2].item.text = JSON.stringify({status:'needs_refinement', summary:'Scope conflict requires refinement'});
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
  assert.ok(args.some((arg, i) => arg === "-c" && args[i + 1] === "mcp_servers.meshy.enabled=false"), "dispatcher agents must not start Meshy and request 1Password access");
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
  assert.deepEqual(schema.properties.status.enum, ["completed", "blocked", "needs_refinement", "waiting_on_blocker"]);
  for (const forbidden of ["--max-turns", "--allowedTools", "--disallowedTools", "--dangerously-bypass-approvals-and-sandbox"]) assert.ok(!args.includes(forbidden));
});

test("security review remains readable with a core shell environment", async t => {
  const f = fixture(t, "agents-path");
  const agents = join(f.dir, 'agents with "quotes" and $literal');
  mkdirSync(join(agents, "builder"), { recursive: true });
  writeFileSync(join(agents, "builder/security-review.md"), "fixture security checklist");
  const result = await runClaudeStreaming({
    ...f.options,
    env: { ...f.options.env, AGENTS_REPO_PATH: agents },
  });
  assert.equal(result.isError, false, result.output);
  const observed = JSON.parse(readFileSync(join(f.dir, "observed.json"), "utf8"));
  assert.ok(observed.argv.includes(`shell_environment_policy.set.AGENTS_REPO_PATH=${JSON.stringify(agents)}`));
  assert.deepEqual(observed.credentialKeys, []);
  assert.ok(!observed.argv.some((arg: string) => arg.startsWith("shell_environment_policy.inherit=")));
});

test("PYRY_AGENT_SHELL_ENV reaches Codex as named overrides, never secrets or withheld Claude settings", async t => {
  const f = fixture(t, "normal");
  const result = await runClaudeStreaming({
    ...f.options,
    env: { ...f.options.env, PYRY_AGENT_SHELL_ENV: "ANDROID_HOME,JAVA_HOME,FIXTURE_TOKEN,CLAUDE_CONFIG_DIR",
      ANDROID_HOME: "/fixture/sdk", JAVA_HOME: "/fixture/jbr home", FIXTURE_TOKEN: "fixture-secret" },
  });
  assert.equal(result.isError, false, result.output);
  const argv: string[] = JSON.parse(readFileSync(join(f.dir, "observed.json"), "utf8")).argv;
  const sets = argv.filter(arg => arg.startsWith("shell_environment_policy.set."));
  assert.deepEqual(sets, ['shell_environment_policy.set.ANDROID_HOME="/fixture/sdk"', 'shell_environment_policy.set.JAVA_HOME="/fixture/jbr home"']);
  assert.ok(!argv.some(arg => arg.includes("fixture-secret")));
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


test("Codex subprocess preserves the explicit refinement outcome", async t => {
  const result = await runClaudeStreaming(fixture(t, "refinement").options);
  assert.equal(result.isError, false);
  assert.equal(result.terminalReason, "needs_refinement");
  assert.equal(result.output, "Scope conflict requires refinement");
});
