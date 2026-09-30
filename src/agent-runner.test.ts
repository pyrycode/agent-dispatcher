import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCodexInvocation, CodexStreamAdapter, formatRunCost, resumeCommand, resolveAgentRunner, resolveCodexExecutable } from "./agent-runner.js";

describe("runner selection", () => {
  test("Claude stays the default and unknown runners fail closed", () => {
    assert.equal(resolveAgentRunner({}), "claude");
    assert.equal(resolveAgentRunner({ PYRY_AGENT_RUNNER: "codex" }), "codex");
    assert.throws(() => resolveAgentRunner({ PYRY_AGENT_RUNNER: "codxe" }), /PYRY_AGENT_RUNNER/);
  });
});
describe("Codex invocation", () => {
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
  test("uses only explicitly selected Codex model and effort", () => {
    const spec = buildCodexInvocation({cwd:"/repo",role:"role",model:"chosen-model",effort:"high"});
    assert.equal(spec.args[spec.args.indexOf("--model")+1],"chosen-model");
    assert.ok(spec.args.includes('model_reasoning_effort="high"'));
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
  adapter.accept({type:"item.completed", item:{type:"command_execution", aggregated_output:"This action was rejected due to unacceptable risk."}});
  const rejected = adapter.finish(0, false, 1);
  assert.equal(rejected.terminalReason, "codex_blocked");
  assert.equal(rejected.isError, true);
});

test("an approval rejection cannot be converted into a refinement request", () => {
  const adapter = new CodexStreamAdapter();
  adapter.accept({type:"item.completed", item:{type:"command_execution", aggregated_output:'CreateProcess Rejected("This action was rejected due to unacceptable risk.")'}});
  adapter.accept({type:"item.completed", item:{type:"agent_message", text:JSON.stringify({status:"needs_refinement", summary:"Try routing through dispatcher"})}});
  adapter.accept({type:"turn.completed", usage:{}});
  const result = adapter.finish(0, false, 1);
  assert.equal(result.isError, true);
  assert.equal(result.terminalReason, "codex_blocked");
});


test("approval rejection on stderr also blocks refinement", () => {
  const adapter = new CodexStreamAdapter();
  adapter.accept({type:"item.completed", item:{type:"agent_message", text:JSON.stringify({status:"needs_refinement", summary:"Scope conflict"})}});
  adapter.accept({type:"turn.completed", usage:{}});
  const result = adapter.finish(0, false, 1, "This action was rejected due to unacceptable risk");
  assert.equal(result.terminalReason, "codex_blocked");
  assert.equal(result.isError, true);
});
