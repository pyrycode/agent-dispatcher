import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore,type StartRequest} from './fleet-store.js';
import type {WorkflowItem} from './workflow-store.js';

const project='org/mobile',ticket=project+'#2493',candidate='a'.repeat(40);
const config={project,projectId:'P',statusFieldId:'S',options:{Inbox:'inbox','In Development':'dev','In Code Review':'review','In Documentation':'docs',Done:'done',Halted:'halt'}};
const item:WorkflowItem={id:'I',issueId:'ISSUE',issueNumber:2493,title:'Read recovery',body:'Preserve strict acceptance',url:'https://github.com/'+project+'/issues/2493',state:'OPEN',status:'In Code Review',labels:['done:builder','rework-count:2'],blockedBy:[],parentNumber:null,grandparentNumber:null,revision:1,position:0};
const run=(id:string,role='verifier'):StartRequest=>({id,machine:'mac',session:'s',project,ticket,role,resource:role==='recovery'?'heavy':'light',locks:[],workflowVersion:1});
function fixture(reason='Retry must target the failed current stage. Tooling repaired; request independent verification.',finishAssessment=true) {
 const store=new FleetStore(':memory:',{mac:{heavyLimit:1,combinedLimit:2}});
 store.workflow.import(config,[structuredClone(item),{...structuredClone(item),id:'OTHER',issueId:'OTHER-ISSUE',issueNumber:7,status:'Halted',labels:['needs-human:operator']}]);
 const admitted=store.start(run('failed-review'));assert.equal(admitted.ok,true,JSON.stringify(admitted));
 store.stagePlan('mac','s',ticket,'failed-review',{version:1,kind:'verifier',candidate,checks:['scripted'],artifacts:[]});
 store.stageResult('mac','s',ticket,'failed-review',{version:1,candidate,checks:[{name:'scripted',outcome:'failed',evidence:'24 executed; 19 passed; five failed'}],files:[],pullRequest:2499,verdict:{commit:candidate,decision:'FAIL',labels:['needs-rework:builder'],body:'## Verifier Review\nDecision: FAIL\nComparison selector refused before execution.'}});
 store.finish('mac','s','failed-review');
 store.workflowOperator(ticket,{removeLabels:['needs-rework:builder']},'prepared-unchanged-review',store.workflow.get(ticket).revision);
 const [incident]=store.recoveryReport('mac',project,[{ticket,status:'In Code Review',labels:store.workflow.get(ticket).labels,blocked:false}]);
 assert.equal(store.start(run('assessment','recovery')).ok,true);
 store.recoveryStep('mac','s',project,incident.id,'assessment','begin');
 store.recoveryStep('mac','s',project,incident.id,'assessment','decide',{action:'escalate',category:'human',reason});
 store.recoveryStep('mac','s',project,incident.id,'assessment','complete');
 if(finishAssessment)store.finish('mac','s','assessment');
 if(finishAssessment)store.workflowOperator(ticket,{status:'In Code Review',addLabels:['done:builder','orchestrator:escalated'],removeLabels:['needs-rework:builder','done:verifier','wip:verifier']},'project-escalation',store.workflow.get(ticket).revision);
 const request={commandId:'approved-review-retry',ticket,revision:store.workflow.get(ticket).revision,incidentId:incident.id,runId:'failed-review',candidate,pullRequest:2499,reason:'Operator reviewed installed selector repair; repeat independent acceptance.'};
 return {store,request,incident};
}

test('explicit review handback preserves failed evidence and assigns a fresh ordinary verifier',()=>{
 const {store,request,incident}=fixture();try {
  const unrelated=store.workflow.get(project+'#7');
  const stage=structuredClone(store.stages.get('failed-review')),history=structuredClone(store.recovery.list(project).find(i=>i.id===incident.id)!),claims=store.snapshot().claims;
  const changed=store.retryReview(request);
  assert.equal(changed.status,'In Code Review');
  assert.ok(changed.labels.includes('done:builder'));
  assert.ok(changed.labels.includes('rework-count:2'));
  assert.ok(changed.labels.includes('orchestrator:recovery-priority'));
  assert.ok(changed.labels.includes('wip:repair'));
  assert.equal(changed.labels.includes('orchestrator:escalated'),false);
  assert.equal(changed.labels.includes('done:verifier'),false);
  assert.deepEqual(store.stages.get('failed-review'),stage,'no acceptance or failed receipts rewritten');
  const {cadence: _cadence,...savedHistory}=history;
  assert.deepEqual(store.recovery.list(project).find(i=>i.id===incident.id)!,{...savedHistory,current:false},'original human decision retained');
  assert.deepEqual(store.snapshot().claims,claims);
  assert.deepEqual(store.workflow.get(project+'#7'),unrelated,'unrelated deliberate hold preserved');
  assert.match(store.workflow.comments(ticket).at(-1)!.body,/Normal approval, admission and configured acceptance/);
  assert.equal(store.snapshot().runs.length,0,'operator handoff starts no tests');
  store.recoveryReport('mac',project,[{ticket,status:changed.status,labels:changed.labels,blocked:false}]);
  assert.equal(store.recovery.list(project).some(i=>i.ticket===ticket && i.current),false,'normal reconciliation preserves the assigned handback');
  assert.equal(store.start(run('fresh-verifier')).ok,true,'normal admission still owns actual execution');
 } finally {store.close();}
});

test('review handback refuses stale revision, candidate, source and incident identities atomically',()=>{
 for(const change of [{revision:999},{candidate:'b'.repeat(40)},{runId:'other'},{incidentId:'00000000-0000-4000-8000-000000000000'}]) {
  const {store,request,incident}=fixture();try {
   const before=store.workflow.get(ticket),history=store.recovery.list(project).find(i=>i.id===incident.id)!;
   assert.throws(()=>store.retryReview({...request,...change}));
   assert.deepEqual(store.workflow.get(ticket),before);assert.deepEqual(store.recovery.list(project).find(i=>i.id===incident.id)!,history);
  } finally {store.close();}
 }
});

test('review handback preserves source holds, pending rework and unsafe approval decisions',()=>{
 for(const label of ['needs-human:decision','error:builder','error:verifier:permission_denied','held:stage-result','health-hold:disk','wip:builder','pending-verdict:verifier','needs-rework:builder','done:verifier','done:documentation']) {
  const {store,request,incident}=fixture();try {
   store.workflowOperator(ticket,{addLabels:[label]},'new-hold',request.revision);
   assert.throws(()=>store.retryReview({...request,revision:store.workflow.get(ticket).revision}));
   assert.ok(store.workflow.get(ticket).labels.includes(label));assert.equal(store.recovery.list(project).find(i=>i.id===incident.id)!.current,true);
  } finally {store.close();}
 }
 const {store,request}=fixture();try {
  store.approvals.record(ticket,'denied','verifier',{hadPermissionDenial:true,approvalReviewFailed:false});
  assert.throws(()=>store.retryReview(request),/approval rejection/i);
 } finally {store.close();}
});

test('replayed operator command cannot retire a later hold or change its approved request',()=>{
 const {store,request}=fixture();try {
  const original=store.retryReview(request);
  store.workflowOperator(ticket,{addLabels:['needs-human:later']},'later-hold',original.revision);
  const held=store.workflow.get(ticket);
  assert.deepEqual(store.retryReview(request),original);
  assert.deepEqual(store.workflow.get(ticket),held,'replay does no live mutation');
  assert.throws(()=>store.retryReview({...request,reason:'Different intent'}),/identity reused/i);
 } finally {store.close();}
});

test('handback refuses changed requirements, causal blockers, closed work and a newer stage',()=>{
 for(const change of [{body:'New acceptance requirement'},{blockedBy:[{number:7,state:'OPEN' as const}]},{state:'CLOSED' as const},{status:'In Documentation'}]) {
  const {store,request,incident}=fixture();try {
   if('body' in change)store.workflow.observe(project,[{...store.workflow.get(ticket),...change}]);
   else store.workflowOperator(ticket,change,'changed-requirement',request.revision);
   assert.throws(()=>store.retryReview({...request,revision:store.workflow.get(ticket).revision}));
   assert.equal(store.recovery.list(project).find(i=>i.id===incident.id)!.current,true);
  } finally {store.close();}
 }
 const {store,request}=fixture();try {
  store.stages.begin(ticket,'newer-review',store.workflow.get(ticket),{version:1,kind:'verifier',candidate,checks:[],artifacts:[]});
  assert.throws(()=>store.retryReview(request),/latest failed review/i);
 } finally {store.close();}
});

test('operator handback cannot retire an unrelated human decision or unfinished assessment',()=>{
 const other=fixture('Operator must decide a product requirement');try {
  assert.throws(()=>other.store.retryReview(other.request),/exact refused review handback/);
  assert.equal(other.store.recovery.list(project).find(i=>i.id===other.incident.id)!.current,true);
 } finally {other.store.close();}
 const active=fixture(undefined,false);try {
  assert.throws(()=>active.store.retryReview(active.request),/finished|active|uncertain/);
  assert.equal(active.store.snapshot().runs.length,1);
 } finally {active.store.close();}
 const support=fixture();try {
  support.store.openTaskTickets=()=>[ticket];
  assert.throws(()=>support.store.retryReview(support.request),/active or uncertain/);
 } finally {support.store.close();}
});

test('only a protected operator with a fresh exact published head can request review',async t=>{
 const {serveFleet,JsonClient}=await import('./fleet-http.js');
 const {GitHubBroker}=await import('./github-broker.js');
 const {store,request}=fixture();t.after(()=>store.close());
 let branch=candidate,head='b'.repeat(40),state='open',repo=project,reads=0;
 const github=new GitHubBroker({token:'fixture-token',projects:[project],fetcher:async input=>{
  reads++;return new Response(JSON.stringify(String(input).includes('/pulls/')
   ? {state,head:{sha:head,ref:'feature/2493',repo:{full_name:repo}}}:{object:{sha:branch}}));
 }});
 const server=await serveFleet(store,{mac:'machine-token'},'operator-token',0,'127.0.0.1',github);
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const address=server.address() as {port:number},url=`http://127.0.0.1:${address.port}`;
 const machine=new JsonClient(url,'machine-token'),operator=new JsonClient(url,'operator-token');
 const body={...request,project};
 await assert.rejects(machine.call('/workflow/retry-review',body),/Operator credential/);
 assert.equal(reads,0);
 await assert.rejects(operator.call('/workflow/retry-review',{...body,project:'org/other'}),/project mismatch/);
 await assert.rejects(operator.call('/workflow/retry-review',{...body,confirmed:true}),/Invalid review retry request/);
 await assert.rejects(operator.call('/workflow/retry-review',body),/candidate changed/);
 head=candidate;branch='c'.repeat(40);
 await assert.rejects(operator.call('/workflow/retry-review',body),/candidate changed/);
 branch=candidate;repo='other/fork';
 await assert.rejects(operator.call('/workflow/retry-review',body),/candidate changed/);
 repo=project;state='closed';
 await assert.rejects(operator.call('/workflow/retry-review',body),/candidate changed/);
 state='open';const result=await operator.call('/workflow/retry-review',body);
 const count=reads;branch='d'.repeat(40);
 assert.deepEqual(await operator.call('/workflow/retry-review',body),result,'lost reply recovers original handoff');
 assert.equal(reads,count,'saved command cannot apply a later changed candidate');
});


test('review retry rolls back workflow, history and receipt when the handoff comment fails',()=>{
 const {store,request,incident}=fixture();try {
  const before=store.workflow.get(ticket),history=store.recovery.list(project).find(i=>i.id===incident.id);
  const comment=store.workflow.comment.bind(store.workflow);
  store.workflow.comment=()=>{throw new Error('controlled retention failure');};
  assert.throws(()=>store.retryReview(request),/controlled retention failure/);
  assert.deepEqual(store.workflow.get(ticket),before);
  assert.deepEqual(store.recovery.list(project).find(i=>i.id===incident.id),history);
  assert.equal(store.reviewRetries.saved(request),undefined);
  store.workflow.comment=comment;
  assert.ok(store.retryReview(request).labels.includes('wip:repair'));
 } finally {store.close();}
});

test('review retry refuses changed claim generation and preserves the new owner',()=>{
 const {store,request}=fixture();try {
  const old=store.snapshot().claims.find(c=>c.ticket===ticket)!;
  store.free(ticket,old.generation,true);
  store.workflowOperator(ticket,{addLabels:['wip:repair'],removeLabels:['orchestrator:escalated']},'replacement-owner-admission',store.workflow.get(ticket).revision);
  const replacement=store.start(run('replacement-review'));
  assert.equal(replacement.ok,true,JSON.stringify(replacement));
  store.finish('mac','s','replacement-review');
  store.workflowOperator(ticket,{addLabels:['orchestrator:escalated'],removeLabels:['wip:repair']},'restore-fixture-escalation',store.workflow.get(ticket).revision);
  const current=store.snapshot().claims;
  assert.notEqual(current.find(c=>c.ticket===ticket)!.generation,old.generation);
  assert.throws(()=>store.retryReview({...request,revision:store.workflow.get(ticket).revision}),/unchanged source ownership/);
  assert.deepEqual(store.snapshot().claims,current);
 } finally {store.close();}
});
