import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaimLabelMirror } from './claim-labels.js';
import { isVerdictPublishFailure } from './verdict-handoff.js';

test('3178 exact HTTP 429 publication failure is recoverable, permission refusal is not', () => {
  const text = 'Review verdict: PASS; GitHub rejected verdict publication with HTTP 429.';
  assert.equal(isVerdictPublishFailure(text, {approvalRejected:false}), true);
  assert.equal(isVerdictPublishFailure(text, {approvalRejected:true}), false);
  assert.equal(isVerdictPublishFailure(text + ' permission denied', {approvalRejected:false}), false);
});

test('escalation label backfills, survives restart, and clears when the incident progresses', async () => {
  let escalated = ['org/core#3178'];
  let labels = ['error:verifier', 'priority:high'];
  const catalog = new Set<string>();
  const api = {
    listLabels: async () => [...catalog],
    listIssues: async (_repo:string,label:string) => labels.includes(label) ? [{number:3178,labels:[...labels]}] : [],
    createLabel: async (_repo:string,label:string) => {catalog.add(label);},
    addLabel: async (_repo:string,_n:number,label:string) => {labels.push(label);},
    removeLabel: async (_repo:string,_n:number,label:string) => {labels=labels.filter(l=>l!==label);},
  };
  await new ClaimLabelMirror(['org/core'],()=>[],api,()=>escalated).sync();
  assert.deepEqual(labels, ['error:verifier','priority:high','orchestrator:escalated']);
  await new ClaimLabelMirror(['org/core'],()=>[],api,()=>escalated).sync();
  assert.equal(labels.filter(l=>l==='orchestrator:escalated').length,1);
  escalated=[];
  await new ClaimLabelMirror(['org/core'],()=>[],api,()=>escalated).sync();
  assert.deepEqual(labels,['error:verifier','priority:high']);
});

test('the private native-check socket reaches Codex tool commands without a fleet token',async()=>{
 const {resolveAgentShellEnv,buildCodexInvocation}=await import('./agent-runner.js');
 const shell=resolveAgentShellEnv({PYRY_TASK_SOCKET:'/tmp/private-task/api.sock'});
 assert.equal(shell.PYRY_TASK_SOCKET,'/tmp/private-task/api.sock');
 const invocation=buildCodexInvocation({cwd:'/tmp/task',role:'builder',model:'gpt-6.1-sol',effort:'xhigh',shellEnv:shell,builderLiveTests:true});
 assert.ok(invocation.args.some(a=>a.includes('shell_environment_policy.set.PYRY_TASK_SOCKET=')));
 assert.ok(invocation.args.some(a=>a.includes('include_only')&&a.includes('PYRY_TASK_SOCKET')));
 assert.equal(shell.PYRY_MANAGER_TOKEN,undefined);
});
