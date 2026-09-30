import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeStreaming } from "./dispatch.js";

// Real subprocess/stream path, without contacting a model or board.
for (const mode of ["completed", "blocked", "missing-report", "nonzero", "timeout-result"] as const) {
  test(`Claude preliminary reader: ${mode}`, async t => {
    const root = mkdtempSync(join(tmpdir(), "claude-source-review-test "));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const observed = join(root, "observed.json");
    const bin = join(root, "claude");
    writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.OBSERVED, JSON.stringify({args:process.argv.slice(2), input, cwd:process.cwd(), authPresent:!!process.env.CLAUDE_CODE_OAUTH_TOKEN}));
  if (process.env.MODE === 'timeout-result') { setTimeout(() => console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{status:'completed',summary:'Too late'}})), 800); process.on('SIGTERM', () => {}); return; }
  console.log(JSON.stringify({type:'result', subtype:'success', is_error:false, num_turns:3, total_cost_usd:0.04, usage:{input_tokens:17}, structured_output:process.env.MODE === 'missing-report' ? undefined : {status:process.env.MODE === 'blocked' ? 'blocked' : 'completed',summary:'Complete source findings'}}));
  process.exitCode = process.env.MODE === 'nonzero' ? 7 : 0;
});
`);
    chmodSync(bin, 0o755);
    writeFileSync(join(root, "prompt.txt"), 'Review literal $text and `quotes`\n');
    writeFileSync(join(root, "system.txt"), "Read source only");
    const result = await runClaudeStreaming({
      runner: "claude", sourceReview: true, sourceReviewRoot: root,
      cwd: root, promptFile: join(root, "prompt.txt"), systemPromptFile: join(root, "system.txt"),
      model: "fixture-model", effort: "high", maxTurns: 12,
      allowedTools: "Bash,Read,Edit", disallowedTools: "", timeoutMs: mode === "timeout-result" ? 600 : 5000,
      logFile: join(root, "run.log"), env: { PATH: root + ":" + process.env.PATH, OBSERVED: observed, MODE: mode, CLAUDE_CODE_OAUTH_TOKEN: "fixture-only" },
    });
    assert.equal(result.isError, mode !== "completed");
    if (mode === "completed") {
      assert.equal(result.terminalReason, "stop");
      assert.equal(result.output, "Complete source findings");
      assert.equal(result.numTurns, 3);
      assert.equal(result.usage.input_tokens, 17);
    }
    const actual = JSON.parse(readFileSync(observed, "utf8"));
    assert.notEqual(realpathSync(root), actual.cwd);
    assert.equal(existsSync(actual.cwd), false, "isolated working directory is removed after the child exits");
    assert.equal(actual.input, readFileSync(join(root, "prompt.txt"), "utf8"));
    assert.equal(actual.authPresent, true);
    for (const flag of ["--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome"]) assert.ok(actual.args.includes(flag));
    for (const flag of ["--tools", "--allowedTools"]) assert.equal(actual.args[actual.args.indexOf(flag) + 1], "Read,Glob,Grep");
    assert.equal(actual.args[actual.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(actual.args[actual.args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.equal(actual.args[actual.args.indexOf("--add-dir") + 1], root);
    assert.equal(actual.args[actual.args.indexOf("--max-turns") + 1], "12");
    assert.ok(!actual.args.includes("--bare"), "OAuth authentication must keep working");
  });
}
