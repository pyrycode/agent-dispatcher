import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { agentShellEnvNameProblem, buildCodexInvocation, codexRefusalText, codexRouterMessages, CodexStreamAdapter, failedMcpCallLogLine, formatRunCost, MCP_FAILURE_LOG_CAP, MCP_STARTUP_RETRIES, MCP_STARTUP_RETRY_WAIT_MS, resolveAgentShellEnv, resumeCommand, resolveAgentRunner, resolveCodexExecutable, retryRequiredMcpStartup } from "./agent-runner.js";
import { advanceCodexIdleWatchdogState, initIdleWatchdogState, runStopKind, shouldFireIdleWatchdog, type IdleWatchdogState } from "./agent-runtime.js";
import { classifyAgentError } from "./pipeline-decisions.js";

/** Real Codex approval shapes; see the fixture's "source". */
const signals = JSON.parse(readFileSync(new URL("./fixtures/codex-approval-signals.json", import.meta.url), "utf8")) as Record<string, any>;

describe("runner selection", () => {
  test("Claude stays the default and unknown runners fail closed", () => {
    assert.equal(resolveAgentRunner({}), "claude");
    assert.equal(resolveAgentRunner({ PYRY_AGENT_RUNNER: "codex" }), "codex");
    assert.throws(() => resolveAgentRunner({ PYRY_AGENT_RUNNER: "codxe" }), /PYRY_AGENT_RUNNER/);
  });
});
describe("Codex invocation", () => {
  test("source review cannot publish or request writable access", () => {
    const spec = buildCodexInvocation({ cwd: "/tmp/isolated-review", role: "Read sources", model: "chosen-model", effort: "high", sourceReview: true });
    assert.ok(!spec.args.includes("--approve-for-me"));
    assert.equal(spec.args[spec.args.indexOf("--sandbox") + 1], "read-only");
    assert.ok(spec.args.includes('approval_policy="never"'));
    assert.ok(spec.args.includes("--ignore-user-config"));
    assert.ok(spec.args.includes("features.apps=false"));
    assert.ok(spec.args.includes("features.plugins=false"));
    assert.ok(spec.args.includes("features.multi_agent=false"));
    assert.ok(spec.args.includes("--skip-git-repo-check"));
  });
  test("keeps role instructions additive, prompts on stdin and permissions reviewed", () => {
    const role = 'Review "quoted" paths\nDo not modify code.';
    const spec = buildCodexInvocation({ cwd: "/tmp/a b", role, model: "", effort: "" });
    assert.equal(spec.bin, "codex");
    assert.deepEqual(spec.args.slice(0, 2), ["exec", "--json"]);
    assert.ok(spec.args.includes("--approve-for-me"));
    assert.ok(!spec.args.includes("--sandbox"), "approve-for-me selects workspace-write and conflicts with --sandbox");
    assert.equal(spec.args[spec.args.indexOf("--cd") + 1], "/tmp/a b");
    assert.equal(spec.args.at(-1), "-");
    assert.ok(spec.args.includes(`developer_instructions=${JSON.stringify(role)}`));
    assert.ok(spec.args.includes('project_doc_fallback_filenames=["CLAUDE.md"]'));
    assert.ok(!spec.args.some(arg => arg.startsWith("shell_environment_policy.set.AGENTS_REPO_PATH=")), "an absent path must not overwrite user configuration");
    for (const forbidden of ["--model", "--max-turns", "--allowedTools", "--dangerously-bypass-approvals-and-sandbox", "--full-auto"]) assert.ok(!spec.args.includes(forbidden));
  });
  test("a continuation leg resumes the thread with every flag re-passed before the subcommand", () => {
    const fresh = buildCodexInvocation({ cwd: "/repo", role: "role", model: "m", effort: "high", agentsRepoPath: "/agents" });
    const resumed = buildCodexInvocation({ cwd: "/repo", role: "role", model: "m", effort: "high", agentsRepoPath: "/agents", resumeThreadId: "thread-1" });
    // `codex exec resume` takes no --cd or --approve-for-me of its own, so the
    // exec-level flags stay in front of it and the prompt still comes on stdin.
    assert.deepEqual(resumed.args, [...fresh.args.slice(0, -1), "resume", "thread-1", "-"]);
  });
  test("uses only explicitly selected Codex model and effort", () => {
    const spec = buildCodexInvocation({cwd:"/repo",role:"role",model:"chosen-model",effort:"high"});
    assert.equal(spec.args[spec.args.indexOf("--model")+1],"chosen-model");
    assert.ok(spec.args.includes('model_reasoning_effort="high"'));
  });
});
describe("PYRY_AGENT_SHELL_ENV: non-secret settings for Codex commands", () => {
  const quiet = () => ({ warnings: [] as string[], warned: new Set<string>() });
  test("refuses names that look secret, in any case, and names that are not plain upper-case", () => {
    for (const name of ["GITHUB_TOKEN", "OPENAI_API_KEY", "MY_SECRET_DIR", "DB_PASSWORD", "SMTP_PASSWD", "AWS_CREDENTIALS",
      "GH_AUTH_HOST", "PRIVATE_DIR", "OP_SERVICE_ACCOUNT", "OP_CONNECT_HOST", "SSH_KEYFILE"]) {
      assert.match(agentShellEnvNameProblem(name) ?? "", /secret/, name);
    }
    for (const name of ["android_home", "Java_Home", "1PATH", "A-B", "A.B", "A B", "ANDROID_HOME=x", ""]) {
      assert.match(agentShellEnvNameProblem(name) ?? "", /upper-case/, name);
    }
    for (const name of ["ANDROID_HOME", "JAVA_HOME", "PYRYCODE_SRC", "PYRYCODE_RELAY_SRC", "_X", "GRADLE_USER_HOME"]) {
      assert.equal(agentShellEnvNameProblem(name), null, name);
    }
  });
  test("passes listed names that are set and non-blank, comma- or space-separated, once each", () => {
    const q = quiet();
    const env = {
      PYRY_AGENT_SHELL_ENV: "ANDROID_HOME, JAVA_HOME PYRYCODE_SRC,,ANDROID_HOME UNSET_ONE BLANK_ONE",
      ANDROID_HOME: "/sdk", JAVA_HOME: "/Applications/Android Studio.app/jbr", PYRYCODE_SRC: "/src/pyrycode", BLANK_ONE: "  ",
    };
    assert.deepEqual(resolveAgentShellEnv(env, { warn: m => q.warnings.push(m), warned: q.warned }), {
      ANDROID_HOME: "/sdk", JAVA_HOME: "/Applications/Android Studio.app/jbr", PYRYCODE_SRC: "/src/pyrycode",
    });
    assert.deepEqual(q.warnings, []);
  });
  test("unset or empty list passes nothing", () => {
    const q = quiet();
    assert.deepEqual(resolveAgentShellEnv({ ANDROID_HOME: "/sdk" }, { warn: m => q.warnings.push(m), warned: q.warned }), {});
    assert.deepEqual(resolveAgentShellEnv({ PYRY_AGENT_SHELL_ENV: " ", ANDROID_HOME: "/sdk" }, { warn: m => q.warnings.push(m), warned: q.warned }), {});
    assert.deepEqual(q.warnings, []);
  });
  test("a refused name is skipped with one warning per process, even when set, across many runs", () => {
    const q = quiet();
    const env = { PYRY_AGENT_SHELL_ENV: "ANDROID_HOME,GITHUB_TOKEN,op_session,GITHUB_TOKEN", ANDROID_HOME: "/sdk", GITHUB_TOKEN: "ghp_fixture", op_session: "x" };
    for (let run = 0; run < 3; run++) {
      assert.deepEqual(resolveAgentShellEnv(env, { warn: m => q.warnings.push(m), warned: q.warned }), { ANDROID_HOME: "/sdk" });
    }
    assert.equal(q.warnings.length, 2);
    assert.ok(q.warnings.some(m => m.includes('"GITHUB_TOKEN"') && /secret/.test(m)));
    assert.ok(q.warnings.some(m => m.includes('"op_session"')));
    assert.ok(q.warnings.every(m => !m.includes("ghp_fixture")), "a warning names the variable, never its value");
  });
  test("each allowed setting becomes one -c shell_environment_policy.set override with a quoted value", () => {
    const spec = buildCodexInvocation({ cwd: "/repo", role: "role", model: "", effort: "", agentsRepoPath: "/agents",
      shellEnv: { ANDROID_HOME: "/sdk", JAVA_HOME: '/Applications/Android Studio.app/Contents/jbr "x"' } });
    const sets = spec.args.flatMap((arg, i) => spec.args[i - 1] === "-c" && arg.startsWith("shell_environment_policy.set.") ? [arg] : []);
    assert.deepEqual(sets, [
      'shell_environment_policy.set.AGENTS_REPO_PATH="/agents"',
      'shell_environment_policy.set.ANDROID_HOME="/sdk"',
      `shell_environment_policy.set.JAVA_HOME=${JSON.stringify('/Applications/Android Studio.app/Contents/jbr "x"')}`,
    ]);
    assert.ok(!spec.args.some(arg => arg.startsWith("shell_environment_policy.inherit")), "the user's inheritance policy is left alone");
    assert.equal(spec.args.at(-1), "-");
  });
  test("AGENTS_REPO_PATH is not set twice when also listed", () => {
    const spec = buildCodexInvocation({ cwd: "/repo", role: "role", model: "", effort: "", agentsRepoPath: "/agents",
      shellEnv: { AGENTS_REPO_PATH: "/agents", ANDROID_HOME: "/sdk" } });
    assert.equal(spec.args.filter(arg => arg.startsWith("shell_environment_policy.set.AGENTS_REPO_PATH=")).length, 1);
  });
  test("no settings leaves the invocation as before; source review never gets them", () => {
    const before = buildCodexInvocation({ cwd: "/repo", role: "role", model: "m", effort: "high" });
    assert.deepEqual(buildCodexInvocation({ cwd: "/repo", role: "role", model: "m", effort: "high", shellEnv: {} }), before);
    const review = buildCodexInvocation({ cwd: "/tmp/review", role: "role", model: "m", effort: "high", sourceReview: true, shellEnv: { ANDROID_HOME: "/sdk" } });
    assert.ok(!review.args.some(arg => arg.startsWith("shell_environment_policy.set.ANDROID_HOME")));
  });
});
describe("Codex event adapter", () => {
  test("requires completed turn and preserves final text, thread and usage", () => {
    const s = new CodexStreamAdapter();
    s.accept({type:"thread.started",thread_id:"thread-1"});
    s.accept({type:"item.completed",item:{type:"agent_message",text:"Working..."}});
    s.accept({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({status:"completed",summary:"Finished"})}});
    s.accept({type:"turn.completed",usage:{input_tokens:123,cached_input_tokens:40,output_tokens:21}});
    const r=s.finish(0,false,500);
    assert.equal(r.isError,false);assert.equal(r.output,"Finished");assert.equal(r.sessionId,"thread-1");
    assert.deepEqual(r.usage,{input_tokens:123,cache_read_input_tokens:40,output_tokens:21});
    assert.equal(r.runner,"codex");assert.equal(r.costKnown,false);assert.equal(r.durationMs,500);
  });
  test("never promotes partial output or a failed process to success", () => {
    for (const code of [0,1,null]) {
      const s=new CodexStreamAdapter();s.accept({type:"item.completed",item:{type:"agent_message",text:"Looks done"}});
      assert.equal(s.finish(code,false,2).isError,true);
    }
    const s=new CodexStreamAdapter();s.accept({type:"turn.completed",usage:{}});
    assert.equal(s.finish(1,false,2).isError,true);
  });
  test("failed turns retain error text rather than last narration", () => {
    const s=new CodexStreamAdapter();s.accept({type:"thread.started",thread_id:"recover-me"});
    s.accept({type:"item.completed",item:{type:"agent_message",text:"I will inspect"}});
    s.accept({type:"turn.failed",error:{message:"usage limit reached"}});
    const r=s.finish(1,false,2);assert.equal(r.isError,true);assert.match(r.output,/usage limit/);
    assert.equal(r.sessionId,"recover-me");
  });
  test("transient error events can recover but terminal failure cannot", () => {
    const s=new CodexStreamAdapter();s.accept({type:"error",message:"Reconnecting 1/5"});
    s.accept({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({status:"completed",summary:"recovered"})}});
    s.accept({type:"turn.completed",usage:{}});assert.equal(s.finish(0,false,2).isError,false);
    s.accept({type:"turn.failed",error:{message:"failed"}});assert.equal(s.finish(0,false,2).isError,true);
  });
  test("stderr-derived failure text is scrubbed before it can reach the ticket", () => {
    const key = "sk-ant-api03-" + "Z".repeat(40);
    const s=new CodexStreamAdapter();
    const r=s.finish(1,false,2,`fatal: auth failed with ${key}\n`);
    assert.equal(r.isError,true);
    assert.match(r.output,/fatal: auth failed/);
    assert.ok(!r.output.includes(key), "the key must not survive into the output");
    assert.match(r.output,/\[REDACTED\]/);
  });
  test("timeout retains thread for salvage and overrides a completed event", () => {
    const s=new CodexStreamAdapter();s.accept({type:"thread.started",thread_id:"thread-1"});
    s.accept({type:"turn.completed",usage:{}});
    const r=s.finish(null,true,20);assert.equal(r.isError,true);assert.equal(r.timedOut,true);
    assert.equal(r.terminalReason,"timeout");assert.equal(r.sessionId,"thread-1");
  });
});

test("a completed turn reporting blocked must not advance the ticket", () => {
 const s=new CodexStreamAdapter();
 s.accept({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({status:"blocked",summary:"Reviewer rejected the required action"})}});
 s.accept({type:"turn.completed",usage:{}});
 const r=s.finish(0,false,1);assert.equal(r.isError,true);assert.equal(r.terminalReason,"codex_blocked");assert.match(r.output,/Reviewer rejected/);
});
test("success without a valid task outcome fails closed", () => {
 const s=new CodexStreamAdapter();s.accept({type:"item.completed",item:{type:"agent_message",text:"I cannot finish"}});
 s.accept({type:"turn.completed",usage:{}});assert.equal(s.finish(0,false,1).isError,true);
});

test("recovery and cost reports do not pretend Codex is Claude", () => {
 const s=new CodexStreamAdapter();const r=s.finish(1,false,1);
 assert.equal(formatRunCost(r),"cost unavailable");
 assert.equal(resumeCommand({...r,sessionId:"thread"}),"codex resume thread");
 assert.equal(resumeCommand({sessionId:"claude-session"}),"claude --resume claude-session");
});
test("blocked reason wins over an earlier reconnect diagnostic", () => {
 const s=new CodexStreamAdapter();s.accept({type:"error",message:"connection reset"});
 s.accept({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({status:"blocked",summary:"Review rejected commit"})}});
 s.accept({type:"turn.completed",usage:{}});assert.equal(s.finish(0,false,1).output,"Review rejected commit");
});

test("blocked task stays blocked even when process shutdown times out", () => {
 const s=new CodexStreamAdapter();
 s.accept({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({status:"blocked",summary:"Commit rejected"})}});
 const r=s.finish(null,true,1000);assert.equal(r.terminalReason,"codex_blocked");assert.equal(r.timedOut,true);
});

test("Codex executable is pinned from PATH before dispatch", () => {
 assert.equal(resolveCodexExecutable({PATH:"/first:/second"}, {platform:"linux", isExecutable:p=>p==="/second/codex"}), "/second/codex");
});
test("macOS launch finds bundled Codex when the terminal PATH omits it", () => {
 const bundle="/Applications/ChatGPT.app/Contents/Resources/codex";
 assert.equal(resolveCodexExecutable({PATH:"/usr/bin:/bin"}, {platform:"darwin", isExecutable:p=>p===bundle}),bundle);
});
test("explicit Codex path wins and an invalid override fails without fallback", () => {
 assert.equal(resolveCodexExecutable({PYRY_CODEX_BIN:"/custom/codex",PATH:"/bin"}, {isExecutable:p=>p==="/custom/codex"}),"/custom/codex");
 assert.throws(()=>resolveCodexExecutable({PYRY_CODEX_BIN:"/missing/codex"}, {platform:"darwin",isExecutable:p=>p==="/Applications/ChatGPT.app/Contents/Resources/codex"}),/PYRY_CODEX_BIN/);
});
test("missing Codex fails preflight with an actionable error", () => {
 assert.throws(()=>resolveCodexExecutable({PATH:"/bin"},{platform:"linux",isExecutable:()=>false}),/Install Codex.*PYRY_CODEX_BIN/);
});

test("missing configured binary stops real startup before role or board processing", () => {
 const root=mkdtempSync(join(tmpdir(),"codex-preflight-"));
 try {
  const child=spawnSync(process.execPath,["--import","tsx",fileURLToPath(new URL("./dispatch-bin.ts",import.meta.url))],{
   encoding:"utf8",timeout:10000,
   env:{...process.env,AGENTS_REPO_PATH:root,TARGET_REPO_PATH:root,GITHUB_OWNER:"fixture",GITHUB_REPO:"fixture",PROJECT_NUMBER:"1",GITHUB_TOKEN:"fixture",PYRY_AGENT_RUNNER:"codex",PYRY_EFFORT_POLICY:"off",PYRY_CODEX_BIN:join(root,"missing-codex")},
  });
  assert.equal(child.status,1);assert.match(child.stderr,/PYRY_CODEX_BIN/);
  assert.doesNotMatch(child.stdout+child.stderr,/Missing per-agent|Dispatching|Polling/);
 } finally {rmSync(root,{recursive:true,force:true});}
});


test("refinement is a distinct successful handoff, never implementation completion", () => {
  const adapter = new CodexStreamAdapter();
  adapter.accept({type:"item.completed", item:{type:"agent_message", text:JSON.stringify({status:"needs_refinement", summary:"Acceptance criteria contradict each other"})}});
  adapter.accept({type:"turn.completed", usage:{}});
  const result = adapter.finish(0, false, 1);
  assert.equal(result.isError, false);
  assert.equal(result.terminalReason, "needs_refinement");
  assert.equal(adapter.finish(1, false, 1).isError, true);
  assert.equal(adapter.finish(null, true, 1).isError, true);
});

test("an open-blocker wait is a distinct handoff, while approval rejection remains an error", () => {
  const adapter = new CodexStreamAdapter();
  adapter.accept({type:"item.completed", item:{type:"agent_message", text:JSON.stringify({status:"waiting_on_blocker", summary:"Waiting on #1280"})}});
  adapter.accept({type:"turn.completed", usage:{}});
  assert.equal(adapter.finish(0, false, 1).terminalReason, "waiting_on_blocker");
  assert.equal(adapter.finish(0, false, 1).isError, false);
  const rejected = adapter.finish(0, false, 1, signals.stderr.rejected1766);
  assert.equal(rejected.terminalReason, "codex_blocked");
  assert.equal(rejected.isError, true);
});

test("an approval rejection cannot be converted into a refinement request", () => {
  const adapter = new CodexStreamAdapter();
  adapter.accept(signals.relayedByTool);
  adapter.accept({type:"item.completed", item:{type:"agent_message", text:JSON.stringify({status:"needs_refinement", summary:"Try routing through dispatcher"})}});
  adapter.accept({type:"turn.completed", usage:{}});
  const result = adapter.finish(0, false, 1);
  assert.equal(result.isError, true);
  assert.equal(result.terminalReason, "codex_blocked");
});


test("approval rejection on stderr also blocks refinement", () => {
  const adapter = new CodexStreamAdapter();
  adapter.accept(signals.declinedCommand1766);
  adapter.accept({type:"item.completed", item:{type:"agent_message", text:JSON.stringify({status:"needs_refinement", summary:"Scope conflict"})}});
  adapter.accept({type:"turn.completed", usage:{}});
  const result = adapter.finish(0, false, 1, signals.stderr.rejected1766);
  assert.equal(result.terminalReason, "codex_blocked");
  assert.equal(result.isError, true);
});

describe("only Codex's own refusal counts as an approval rejection (desktop #1726)", () => {
  const passed = JSON.stringify({ status: "completed", summary: "Published PASS verdict" });
  function run(items: Record<string, any>[], stderr = "") {
    const adapter = new CodexStreamAdapter();
    adapter.accept({ type: "turn.started" });
    for (const item of items) adapter.accept(item);
    adapter.accept({ type: "item.completed", item: { type: "agent_message", text: passed } });
    adapter.accept({ type: "turn.completed", usage: {} });
    return adapter.finish(0, false, 1, stderr);
  }

  test("a command whose output quotes the rejection sentence does not reject a passing run", () => {
    const result = run([signals.grep1726]);
    assert.equal(result.hadPermissionDenial, false);
    assert.equal(result.isError, false);
    assert.equal(result.terminalReason, "stop");
    assert.equal(result.output, "Published PASS verdict");
  });

  test("nor does a failed command, or a completed MCP call, that prints it or the reviewer-failure words", () => {
    const failed = structuredClone(signals.grep1726);
    failed.item.exit_code = 1;
    failed.item.status = "failed";
    failed.item.aggregated_output += "The automatic permission approval review did not finish before its deadline.\n";
    const mcp = { type: "item.completed", item: { type: "mcp_tool_call", server: "qmd", tool: "get", arguments: {},
      result: { content: [{ type: "text", text: "This action was rejected due to unacceptable risk.\nAutomatic approval review failed: x" }], structured_content: null },
      error: null, status: "completed" } };
    const result = run([failed, mcp]);
    assert.equal(result.hadPermissionDenial, false);
    assert.equal(result.approvalReviewFailed, false);
    assert.equal(result.isError, false);
  });

  test("stderr counts only Codex's router message, not other text that carries the sentence", () => {
    const patchError = "2026-10-05T14:40:00.000000Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in src/agent-runner.ts:\n" +
      "    this.approvalRejected ||= /This action was rejected due to unacceptable risk/.test(stderr);";
    const result = run([], `${patchError}\nThis action was rejected due to unacceptable risk.\n${signals.stderr.unrelated1655}`);
    assert.equal(result.hadPermissionDenial, false);
    assert.equal(result.approvalReviewFailed, false);
    assert.equal(result.isError, false);
  });

  test("a genuine shell rejection on stderr still blocks, beside its declined item", () => {
    const result = run([signals.declinedCommand1766], signals.stderr.rejected1766);
    assert.equal(result.hadPermissionDenial, true);
    assert.equal(result.terminalReason, "codex_blocked");
    assert.equal(result.output, "Automatic approval review rejected an action. Operator review required.");
  });

  test("a genuine rejection Codex or a tool reports in a failed MCP item still blocks", () => {
    const codex = { type: "item.completed", item: { type: "mcp_tool_call", server: "codegraph", tool: "codegraph_context", arguments: {},
      result: null, error: { message: signals.relayedByTool.item.result.content[0].text }, status: "failed" } };
    for (const item of [codex, signals.relayedByTool]) assert.equal(run([item]).hadPermissionDenial, true);
  });

  test("a declined item carrying Codex's refusal counts, as codex-rs writes it for a refused tool call", () => {
    const declined = structuredClone(signals.declinedCommand1766);
    declined.item.aggregated_output = signals.relayedByTool.item.result.content[0].text;
    assert.equal(run([declined]).hadPermissionDenial, true);
  });

  test("the extractors return only Codex's text", () => {
    assert.equal(codexRefusalText(signals.grep1726.item), "");
    assert.equal(codexRefusalText(signals.declinedCommand1766.item), "");
    assert.equal(codexRefusalText({ type: "agent_message", text: "This action was rejected due to unacceptable risk." }), "");
    assert.match(codexRefusalText(signals.relayedByTool.item), /^This action was rejected/);
    assert.deepEqual(codexRouterMessages(signals.stderr.unrelated1655), ["Failed to create unified exec process: No such file or directory (os error 2)\\\")\" }"]);
    assert.match(codexRouterMessages(signals.stderr.rejected1766)[0], /^This action was rejected due to unacceptable risk\.\\\\nReason: Applying Spotless/);
    assert.match(codexRouterMessages(signals.stderr.capacity1582)[0], /^Automatic approval review failed: Selected model is at capacity/);
    assert.match(codexRouterMessages(signals.stderr.deadline1655)[0], /^The automatic permission approval review did not finish before its deadline/);
  });
});

describe("Codex idle watchdog — recorded event sequences", () => {
  const MIN = 60_000;
  const IDLE = 10 * MIN;
  const at = (hms: string, day = "2026-09-20") => Date.parse(`${day}T${hms}Z`);
  const cmd = (phase: "started" | "completed", id: string) =>
    ({ type: `item.${phase}`, item: { id, type: "command_execution", command: "/bin/zsh -lc 'true'", aggregated_output: "", status: phase === "started" ? "in_progress" : "completed" } });
  const mcp = (phase: "started" | "completed", id: string) =>
    ({ type: `item.${phase}`, item: { id, type: "mcp_tool_call", server: "figma", tool: "get_screenshot", arguments: {}, status: phase === "started" ? "in_progress" : "completed" } });
  const message = (id: string) => ({ type: "item.completed", item: { id, type: "agent_message", text: "Working." } });
  const play = (events: Array<[number, unknown]>, start: number): IdleWatchdogState => {
    let s = initIdleWatchdogState(start);
    for (const [t, e] of events) s = advanceCodexIdleWatchdogState(s, e, t);
    return s;
  };

  test("builder #626, 2026-09-20: silent 30 minutes after a Figma call returned, nothing outstanding → fires at 10", () => {
    const s = play([
      [at("17:06:39"), mcp("started", "item_11")],
      [at("17:06:44"), mcp("completed", "item_11")],
      [at("17:06:55"), cmd("started", "item_12")],
      [at("17:06:55"), cmd("completed", "item_12")],
      [at("17:06:55"), mcp("started", "item_13")],
      [at("17:06:58"), mcp("completed", "item_13")],
    ], at("17:05:43"));
    assert.equal(s.outstandingToolIds.size, 0);
    assert.equal(shouldFireIdleWatchdog(s, at("17:16:57"), IDLE), false);
    assert.equal(shouldFireIdleWatchdog(s, at("17:16:58"), IDLE), true, "fires 20 minutes before the 40-minute wall clock did");
  });

  test("a long Gradle command, with other commands finishing around it, never trips it", () => {
    // Builder #1642, 2026-10-04: item_18 ran 7 minutes while the agent ran
    // and finished other commands and wrote messages.
    const day = "2026-10-04";
    let s = play([
      [at("09:42:24", day), cmd("started", "item_18")],
      [at("09:42:34", day), message("item_19")],
      [at("09:42:37", day), cmd("started", "item_20")],
      [at("09:42:41", day), cmd("completed", "item_20")],
    ], at("09:40:20", day));
    assert.deepEqual([...s.outstandingToolIds], ["item_18"]);
    assert.equal(shouldFireIdleWatchdog(s, at("10:30:00", day), IDLE), false, "a running command is bounded by the wall clock, not this");
    s = advanceCodexIdleWatchdogState(s, cmd("completed", "item_18"), at("09:49:26", day));
    assert.equal(shouldFireIdleWatchdog(s, at("09:59:25", day), IDLE), false);
    assert.equal(shouldFireIdleWatchdog(s, at("09:59:26", day), IDLE), true);
  });

  test("an MCP tool call or file change in flight holds it off too; a todo list does not", () => {
    const start = at("10:00:00");
    let s = play([[start, mcp("started", "m1")]], start);
    assert.equal(shouldFireIdleWatchdog(s, start + 60 * MIN, IDLE), false);
    s = advanceCodexIdleWatchdogState(s, mcp("completed", "m1"), start + MIN);
    s = advanceCodexIdleWatchdogState(s, { type: "item.started", item: { id: "t", type: "todo_list", items: [] } }, start + 2 * MIN);
    assert.equal(shouldFireIdleWatchdog(s, start + 12 * MIN, IDLE), true, "a plan stays open all turn; it is not a running tool");
    s = advanceCodexIdleWatchdogState(s, { type: "item.started", item: { id: "f", type: "file_change", changes: [], status: "in_progress" } }, start + 13 * MIN);
    assert.equal(shouldFireIdleWatchdog(s, start + 40 * MIN, IDLE), false);
  });

  test("verifier #1291, 2026-09-30: 10.3 silent minutes while Codex retried a slow stream would fire 16 s early (accepted)", () => {
    const day = "2026-09-30";
    const s = play([[at("01:51:44", day), cmd("started", "item_23")], [at("01:51:44", day), cmd("completed", "item_23")]], at("01:48:47", day));
    assert.equal(shouldFireIdleWatchdog(s, at("02:01:44", day), IDLE), true);
  });

  test("every event is activity, including reconnect notices and unknown types", () => {
    const start = at("10:00:00");
    let s = initIdleWatchdogState(start);
    s = advanceCodexIdleWatchdogState(s, { type: "error", message: "Reconnecting... 2/5" }, start + 9 * MIN);
    assert.equal(shouldFireIdleWatchdog(s, start + 18 * MIN, IDLE), false);
    s = advanceCodexIdleWatchdogState(s, null, start + 18 * MIN);
    assert.equal(shouldFireIdleWatchdog(s, start + 27 * MIN, IDLE), false);
  });

  test("a stalled Codex run fails as idle_stall, which retries, and keeps its partial work", () => {
    const s = new CodexStreamAdapter();
    s.accept({ type: "thread.started", thread_id: "stalled" });
    s.accept({ type: "turn.started" });
    s.accept({ type: "item.completed", item: { type: "agent_message", text: "Checking the screenshot." } });
    const r = s.finish(null, false, 30 * MIN, "", IDLE);
    assert.equal(r.isError, true);
    assert.equal(r.terminalReason, "idle_stall");
    assert.match(r.output, /idle_stall: no stream output for 10min/);
    assert.equal(r.sessionId, "stalled");
    assert.equal(classifyAgentError(`Agent error (${r.terminalReason}). ${r.output}`, { terminalReason: r.terminalReason }).transient, true);
    assert.equal(runStopKind(null, r), "idle_stall");
    // The stall is the cause even when the wall clock also fired meanwhile.
    assert.equal(s.finish(null, true, 30 * MIN, "", IDLE).terminalReason, "idle_stall");
  });

  test("a blocked outcome or rejected action is never turned into a retryable stall", () => {
    const blocked = new CodexStreamAdapter();
    blocked.accept({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "blocked", summary: "Rejected" }) } });
    assert.equal(blocked.finish(null, false, 1, "", IDLE).terminalReason, "codex_blocked");
    const rejected = new CodexStreamAdapter();
    rejected.accept(signals.declinedCommand1766);
    assert.equal(rejected.finish(null, false, 1, signals.stderr.rejected1766, IDLE).terminalReason, "codex_blocked");
  });

  test("without a stall the adapter reports as before", () => {
    const s = new CodexStreamAdapter();
    assert.equal(s.finish(null, true, 1).terminalReason, "timeout");
  });
});

describe("failed MCP call log line (#1783)", () => {
  const items = JSON.parse(readFileSync(new URL("./fixtures/codex-mcp-items.json", import.meta.url), "utf8")) as Record<string, any>;

  test("Codex's own error wins, with its line breaks marked", () => {
    assert.equal(failedMcpCallLogLine(items.codexRefused.item),
      "MCP tool call failed, reported by Codex: codegraph.codegraph_status: MCP tool call requires approval, but approval policy is never");
    assert.match(failedMcpCallLogLine(items.reviewerFailed1783.item)!, /^MCP tool call failed, reported by Codex: codegraph\.codegraph_context: Automatic approval review failed: .* ⏎ The action was not executed/);
  });

  test("a tool's own error result is quoted from its text content", () => {
    assert.match(failedMcpCallLogLine(items.toolError.item)!, /reported by the tool: codegraph\.codegraph_status: Error: Tool execution failed: CodeGraph not initialized/);
  });

  test("a call in progress, a success and other item types give nothing", () => {
    assert.equal(failedMcpCallLogLine(items.started.item), null);
    assert.equal(failedMcpCallLogLine({ ...items.toolError.item, status: "completed" }), null);
    assert.equal(failedMcpCallLogLine({ type: "command_execution", status: "failed" }), null);
    assert.equal(failedMcpCallLogLine(undefined), null);
  });

  test("a long reason is capped and credentials are scrubbed", () => {
    const item = { ...items.codexRefused.item, error: { message: "x".repeat(MCP_FAILURE_LOG_CAP + 50) } };
    assert.match(failedMcpCallLogLine(item)!, /x…\(truncated\)$/);
    const secret = { ...items.codexRefused.item, error: { message: "auth failed for ghp_abcdefghijklmnopqrstuvwxyz0123456789" } };
    assert.doesNotMatch(failedMcpCallLogLine(secret)!, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  });
});

describe("required MCP startup retry", () => {
  const mcpFailure = () => {
    const codex = new CodexStreamAdapter();
    codex.accept({ type: "error", message: "required MCP servers failed to initialize: figma: request timed out" });
    return codex.finish(1, false, 10);
  };
  const success = () => {
    const codex = new CodexStreamAdapter();
    codex.accept({ type: "thread.started", thread_id: "t" });
    codex.accept({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "completed", summary: "done" }) } });
    codex.accept({ type: "turn.completed", usage: {} });
    return codex.finish(0, false, 10);
  };

  test("a failed Figma connection is retried inside the run until it connects", async () => {
    const results = [mcpFailure(), mcpFailure(), success()];
    const waits: number[] = [];
    let runs = 0;
    const result = await retryRequiredMcpStartup(async () => results[runs++], { sleep: async ms => { waits.push(ms); } });
    assert.equal(runs, 3);
    assert.equal(result.isError, false);
    assert.deepEqual(waits, [MCP_STARTUP_RETRY_WAIT_MS, MCP_STARTUP_RETRY_WAIT_MS]);
  });

  test("after the last retry the failure still parks as an agent error", async () => {
    let runs = 0;
    const result = await retryRequiredMcpStartup(async () => { runs++; return mcpFailure(); }, { sleep: async () => {} });
    assert.equal(runs, MCP_STARTUP_RETRIES + 1);
    assert.equal(result.terminalReason, "codex_error");
    assert.match(result.output, /required MCP servers failed to initialize: figma/);
  });

  test("any other Codex error is not retried", async () => {
    let runs = 0;
    const result = await retryRequiredMcpStartup(async () => {
      runs++;
      const codex = new CodexStreamAdapter();
      codex.accept({ type: "error", message: "something else broke" });
      return codex.finish(1, false, 10);
    }, { sleep: async () => {} });
    assert.equal(runs, 1);
    assert.equal(result.isError, true);
  });
});
