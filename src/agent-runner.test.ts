import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCodexInvocation, CodexStreamAdapter, formatRunCost, resumeCommand, resolveAgentRunner } from "./agent-runner.js";

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
