import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore, type StartRequest} from './fleet-store.js';
import {EvidenceStore, DEFAULT_EVIDENCE_LIMITS} from './evidence-store.js';
import {artifactManifest, manifestHash} from './recovery-artifacts.js';
import type {WorkflowItem} from './workflow-store.js';
import type {StagePlan, StageSubmission} from './stage-results.js';

// Mobile #2526, PR #2536, 2026-10-24: a verifier PASS for the exact candidate
// accepted a builder investigation's remaining evidence limits by name. The
// investigation was still pending, because its first assessment ended with
// "Ticket changed during assessment", so the PASS's own move to documentation
// queued heavy recovery (incident aaa49d40) instead of the documentation stage.
const project='pyrycode/pyrycode-mobile', ticket=project+'#2526';
const candidate='87e5eb82008794fdf2459cb78faf5b3fb2e91cbe', requested='0fc2d7270812af9df2ac28c83ff6658da5c21cea';
const config={project,projectId:'P',statusFieldId:'S',options:{Backlog:'b',Inbox:'i','In Development':'d','In Code Review':'v','In Documentation':'doc',Done:'done'}};
const item=(labels:string[]=[]):WorkflowItem=>({id:'P2526',issueId:'I2526',issueNumber:2526,title:'Attachment replay',body:'Required behaviour',url:'https://github.com/pyrycode/pyrycode-mobile/issues/2526',
 status:'In Development',state:'OPEN',revision:1,position:1,labels,blockedBy:[],parentNumber:null,grandparentNumber:null});
const start=(id:string,role:string,resource:'heavy'|'light'='heavy'):StartRequest=>({workflowVersion:1,id,role,session:'s',machine:'mac',project,ticket,resource,locks:[]});
const plan:StagePlan={version:1,kind:'verifier',candidate,checks:['ui'],artifacts:[]};
const verdict=(over:Record<string,unknown>={}):StageSubmission=>({version:1,candidate,checks:[{name:'ui',outcome:'passed',evidence:'Protected executor: configured UI command completed'}],files:[],pullRequest:2536,
 verdict:{decision:'PASS',commit:candidate,labels:[],body:'## Verifier Review: #2526\n\nDecision: PASS\n\nThis verdict accepts the controlled causal regression without claiming the historical failures are uniquely explained.',...over} as StageSubmission['verdict']});
const observe=(store:FleetStore)=>{const current=store.workflow.get(ticket);return {ticket,status:current.status,labels:current.labels,blocked:false};};
const INVESTIGATION=/investigation requested by builder/;

function fixture() {
 const store=new FleetStore(':memory:',{mac:{heavyLimit:1,combinedLimit:3}});
 const evidence=new EvidenceStore(':memory:',DEFAULT_EVIDENCE_LIMITS,id=>store.runOwner(id));
 store.workflow.import(config,[item()]);
 assert.equal(store.start(start('failed-gate','builder')).ok,true);store.finish('mac','s','failed-gate',true);
 const files={'logs/failing.xml':'<testsuite failures="1"><testcase name="offeredFile"><failure>viewer wait exceeded 90 s</failure></testcase></testsuite>'};
 const manifest=artifactManifest(files),digest=manifestHash(manifest);
 evidence.begin('mac',project,ticket,'failed-gate',{kind:'agent',role:'verifier',outcome:'completed',startedAt:1,endedAt:2},manifest);
 evidence.put('mac',project,ticket,'failed-gate',digest,'logs/failing.xml',0,Buffer.from(files['logs/failing.xml']).toString('base64'));
 evidence.commit('mac',project,ticket,'failed-gate',digest);
 assert.equal(store.start(start('builder','builder')).ok,true);
 const {id}=store.requestInvestigation('mac','s',project,'builder',{revision:requested,failedTests:['AttachmentTest#offeredFile'],evidence:[{runId:'failed-gate',digest,path:'logs/failing.xml'}],
  scope:{kind:'class',selectors:['AttachmentTest']},narrowerInsufficient:'The historical bundles lack pre-cleanup phase telemetry.'},evidence);
 store.finish('mac','s','builder');
 return {store,id,close:()=>{store.close();evidence.close();}};
}
/** The observed first assessment: it ended because the ticket moved, so it never assessed the request. */
function unassessedFirstAssessment(store:FleetStore) {
 const [first]=store.recoveryReport('mac',project,[observe(store)]);
 assert.match(first?.reason??'',INVESTIGATION);
 assert.equal(store.start(start('assessment','recovery')).ok,true);
 store.recoveryStep('mac','s',project,first.id,'assessment','begin');
 store.recoveryStep('mac','s',project,first.id,'assessment','decide',{action:'wait',reason:'Ticket changed during assessment; no action taken'});
 store.finish('mac','s','assessment');
}
function review(store:FleetStore,submission:StageSubmission,during?:()=>void) {
 store.workflow.change(ticket,{status:'In Code Review'},'test','to-review');
 const admitted=store.start(start('review','verifier','light'));
 if(!admitted.ok) throw new Error('Review admission refused: '+admitted.reason);
 store.stagePlan('mac','s',ticket,'review',plan);
 during?.();
 return store.stageResult('mac','s',ticket,'review',submission);
}

test('2526: an exact-candidate PASS that accepts a pending investigation lets documentation start',()=>{
 const f=fixture();try {
  unassessedFirstAssessment(f.store);
  assert.equal(f.store.investigations.pending(ticket)?.id,f.id,'the unassessed request is still pending at review');
  const accepted=review(f.store,verdict({investigations:[f.id]}));
  f.store.finish('mac','s','review');
  assert.equal(accepted.acceptance?.state,'accepted');
  assert.equal(f.store.workflow.get(ticket).status,'In Documentation');
  assert.deepEqual(f.store.recoveryReport('mac',project,[observe(f.store)]),[],'documentation is not diverted into recovery');
  assert.equal(f.store.investigations.pending(ticket),undefined);
  const [history]=f.store.investigations.reconciliations(ticket);
  assert.equal(history.investigation.id,f.id);
  assert.deepEqual(history.investigation.request.failedTests,['AttachmentTest#offeredFile'],'the original request and failures are retained');
  assert.deepEqual([history.reconciliation.stageRunId,history.reconciliation.candidate,history.reconciliation.pullRequest,history.reconciliation.decision],['review',candidate,2536,'PASS']);
  assert.match(history.reconciliation.verdictDigest,/^[a-f0-9]{64}$/);
  assert.match(history.reconciliation.reason,/accepted/i);
  assert.ok(f.store.stages.get('review')?.result?.verdict?.body.includes('historical failures'),'the verdict itself is retained');
 }finally{f.close();}
});

test('a PASS that does not name the investigation leaves it pending; the stage and done label are not acceptance',()=>{
 for(const named of [undefined,['b'.repeat(64)]]) {
  const f=fixture();try {
   unassessedFirstAssessment(f.store);
   const accepted=review(f.store,verdict(named?{investigations:named}:{}));
   f.store.finish('mac','s','review');
   assert.equal(accepted.acceptance?.state,'accepted');
   assert.equal(f.store.investigations.pending(ticket)?.id,f.id);
   const [incident]=f.store.recoveryReport('mac',project,[observe(f.store)]);
   assert.equal(incident?.state,'queued');assert.match(incident.reason,INVESTIGATION);
   assert.deepEqual(f.store.investigations.reconciliations(ticket),[]);
  }finally{f.close();}
 }
});

test('a failed, malformed or wrong-candidate verdict cannot reconcile an investigation',()=>{
 for(const over of [
  {decision:'FAIL',labels:['needs-rework:builder']},
  {commit:'c'.repeat(40)},
  {investigations:'not-a-list'},
  {investigations:['short']},
 ]) {
  const f=fixture();try {
   const accepted=review(f.store,verdict({investigations:[f.id],...over}));
   assert.notEqual(accepted.acceptance?.state,'accepted',JSON.stringify(over));
   assert.equal(f.store.investigations.pending(ticket)?.id,f.id,JSON.stringify(over));
   assert.deepEqual(f.store.investigations.reconciliations(ticket),[]);
  }finally{f.close();}
 }
});

test('an approval refusal or deliberate hold keeps the investigation pending',()=>{
 const refused=fixture();try {
  refused.store.approvals.record(ticket,'prior','builder',{approvalReviewFailed:false,hadPermissionDenial:true});
  assert.throws(()=>review(refused.store,verdict({investigations:[refused.id]})),/admission refused: locked/);
  assert.equal(refused.store.investigations.pending(ticket)?.id,refused.id);
 }finally{refused.close();}
 const held=fixture();try {
  assert.throws(()=>review(held.store,verdict({investigations:[held.id]}),()=>held.store.workflow.change(ticket,{addLabels:['needs-human:decision']},'operator','hold')),/requirements changed|holds forbid/);
  assert.equal(held.store.investigations.pending(ticket)?.id,held.id);
  assert.deepEqual(held.store.investigations.reconciliations(ticket),[]);
 }finally{held.close();}
});

test('an investigation an assessment or its diagnostic is working on stays protected',()=>{
 const assessing=fixture();try {
  const [incident]=assessing.store.recoveryReport('mac',project,[observe(assessing.store)]);
  assert.equal(assessing.store.start(start('assessment','recovery')).ok,true);
  assessing.store.recoveryStep('mac','s',project,incident.id,'assessment','begin');
  assert.throws(()=>review(assessing.store,verdict({investigations:[assessing.id]})),/admission refused: running/);
  assert.equal(assessing.store.investigations.pending(ticket)?.id,assessing.id);
 }finally{assessing.close();}
 const coordinated=fixture();try {
  const [incident]=coordinated.store.recoveryReport('mac',project,[observe(coordinated.store)]);
  assert.equal(coordinated.store.start(start('assessment','recovery')).ok,true);
  coordinated.store.recoveryStep('mac','s',project,incident.id,'assessment','begin');
  coordinated.store.recoveryStep('mac','s',project,incident.id,'assessment','decide',{action:'coordinate',reason:'The retained failure needs a controlled class run.',
   task:{recipe:'mobile-scripted-evidence',capability:'mobile-android',revision:requested,reason:'Capture the class with phase telemetry before cleanup.'}});
  coordinated.store.recoveryStep('mac','s',project,incident.id,'assessment','complete');
  coordinated.store.finish('mac','s','assessment');
  assert.throws(()=>review(coordinated.store,verdict({investigations:[coordinated.id]})),/admission refused: locked/,'queued diagnostic work is not overtaken');
  assert.equal(coordinated.store.investigations.pending(ticket)?.id,coordinated.id);
 }finally{coordinated.close();}
});
