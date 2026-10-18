import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore,type StartRequest} from './fleet-store.js';
import type {WorkflowItem} from './workflow-store.js';
import {serveFleet,JsonClient} from './fleet-http.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scheduleMachine} from './machine-scheduler.js';

const project='org/core',ticket=project+'#1';
function fixture(path=':memory:',role='builder') {
  let now=1_000_000;
  const store=new FleetStore(path,{source:{heavyLimit:1,combinedLimit:2},target:{heavyLimit:1,combinedLimit:2}},{now:()=>now});
  const status=role==='refiner'?'Backlog':'In Development';
  const item:WorkflowItem={id:'P1',issueId:'I1',issueNumber:1,title:'Recovery',body:'Requirements stay intact',url:'https://github.com/org/core/issues/1',status,labels:['priority:high','rework-count:2','done:previous-stage'],blockedBy:[],parentNumber:null,grandparentNumber:null,state:'OPEN',revision:1,position:1};
  store.workflow.import({project,projectId:'P',statusFieldId:'S',options:{Inbox:'i',Backlog:'b',Done:'done','In Development':'d','In Code Review':'r'}},[item]);
  for (const machine of ['source','target']) {
    store.reportMachineCapabilities(machine,['linux'],[project]);
    store.desired.set({machines:[machine],project,change:{run:'running'}});
  }
  const req:StartRequest={workflowVersion:1,id:'failed',machine:'source',session:'original',project,ticket,role,resource:role==='refiner'?'light':'heavy',locks:[project+':ticket-1']};
  const grant=store.start(req);assert.equal(grant.ok,true);if(!grant.ok)throw new Error('fixture');
  store.workflow.change(ticket,{addLabels:['wip:'+role]},'run:failed','running');
  const input={commandId:'recover-failed',machine:'source',runId:req.id,session:req.session,generation:grant.generation,revision:store.workflow.get(ticket).revision,proof:'native-stopped' as const,retainedDigest:'a'.repeat(64)};
  const target={...req,id:'replacement',session:'new',machine:'target'};
  return {store,req,input,target,advance:(ms:number)=>now+=ms};
}

test('stopped builder releases exactly its attempt, retains workflow and blocks the source through restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'machine-recovery-')),path=join(dir,'claims.sqlite');
 const {store,input,target,req}=fixture(path);
 try {
   const before=store.workflow.get(ticket);
   const result=store.recoverStoppedWorker('source',input);
   assert.equal(result.ticket,ticket);assert.equal(store.snapshot().runs.length,0);assert.equal(store.snapshot().claims.length,0);
   const after=store.workflow.get(ticket);
   assert.equal(after.status,before.status);assert.equal(after.body,before.body);assert.deepEqual(after.blockedBy,before.blockedBy);
   for(const label of ['priority:high','rework-count:2','done:previous-stage','orchestrator:recovery-priority'])assert.ok(after.labels.includes(label));
   assert.ok(!after.labels.includes('wip:builder'));
   assert.deepEqual(store.start({...req,id:'late-source'}),{ok:false,reason:'drained'});
   assert.deepEqual(store.start(req),{ok:false,reason:'finished'});
   assert.throws(()=>store.authorizeWorkflow('source',req.session,ticket,req.id));
   assert.equal(store.start(target).ok,true);
   assert.deepEqual(store.recoverStoppedWorker('source',input),result,'lost reply returns original result after replacement starts');
   assert.equal(store.snapshot().runs[0].id,target.id);
   assert.throws(()=>store.recoverStoppedWorker('source',{...input,retainedDigest:'b'.repeat(64)}),/reused/);
   const reopened=new FleetStore(path,{source:{heavyLimit:1,combinedLimit:2},target:{heavyLimit:1,combinedLimit:2}});
   try {assert.equal(reopened.machineRecoveries.blocked('source',project),true);assert.equal(reopened.snapshot().runs[0].id,target.id);}finally{reopened.close();}
   assert.equal(store.snapshot().releasedAssessmentClaims?.[0].generation,input.generation);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a light non-owning refiner can recover without inventing an implementation claim',()=>{
 const {store,input,target}=fixture(':memory:','refiner');try{
   assert.equal(store.snapshot().claims.length,0);
   store.recoverStoppedWorker('source',input);
   assert.equal(store.start(target).ok,true);assert.equal(store.snapshot().claims.length,0);
 }finally{store.close();}
});

test('holds, approvals, stale authority and unavailable destinations never release work',()=>{
 const cases:Record<string,(f:ReturnType<typeof fixture>)=>void>={
   'stale revision':f=>{f.input.revision--;},
   'wrong session':f=>{f.input.session='other';},
   'wrong generation':f=>{f.input.generation='other';},
   'missing proof':f=>{(f.input as any).proof='offline';},
   'foreign source':f=>{f.input.machine='target';},
   'held ticket':f=>{f.store.workflow.change(ticket,{addLabels:['held:operator']},'operator','hold');f.input.revision=f.store.workflow.get(ticket).revision;},
   'safety refusal':f=>{f.store.recordApprovalOutcome('source',f.req.session,project,f.req.id,ticket,{approvalReviewFailed:false,hadPermissionDenial:true});},
   'source stopped':f=>{f.store.desired.set({machines:['source'],project,change:{run:'stopped'}});},
   'source drained':f=>{f.store.desired.set({machines:['source'],change:{work:'drained'}});},
   'target stopped':f=>{f.store.desired.set({machines:['target'],project,change:{run:'stopped'}});},
   'target drained':f=>{f.store.desired.set({machines:['target'],project,change:{work:'tickets-drained'}});},
   'target stale':f=>{f.advance(180001);},
   'required device missing':f=>{f.store.workflow.change(ticket,{addLabels:['requires:android-device']},'operator','device');f.input.revision=f.store.workflow.get(ticket).revision;},
   'pending verdict':f=>{f.store.workflow.change(ticket,{addLabels:['pending-verdict:builder']},'operator','verdict');f.input.revision=f.store.workflow.get(ticket).revision;},
 };
 for(const [name,change] of Object.entries(cases)) {
   const f=fixture();try{change(f);assert.throws(()=>f.store.recoverStoppedWorker('source',f.input),name);
     assert.equal(f.store.snapshot().runs[0].id,f.req.id,name);assert.equal(f.store.snapshot().claims[0].machine,'source',name);assert.deepEqual(f.store.machineRecoveries.list(),[],name);
   }finally{f.store.close();}
 }
});

test('source hold requires operator reconciliation and cannot clear newer recovery records',()=>{
 const {store,input,req,target}=fixture();try{
   store.recoverStoppedWorker('source',input);
   assert.throws(()=>store.machineRecoveries.clear('source',project,['wrong'],Date.now()),/changed/);
   store.machineRecoveries.clear('source',project,[input.commandId],Date.now());
   assert.equal(store.machineRecoveries.blocked('source',project),false);
   assert.equal(store.start({...req,id:'source-repaired',session:'repaired'}).ok,true);
   const run=store.snapshot().runs[0];
   const next={...input,commandId:'second-failure',runId:run.id,session:run.session,generation:run.generation,revision:store.workflow.get(ticket).revision};
   store.recoverStoppedWorker('source',next);
   assert.throws(()=>store.machineRecoveries.clear('source',project,[input.commandId],Date.now()),/changed/);
   assert.equal(store.start(target).ok,true);
 }finally{store.close();}
});

test('capacity, role locks and destination admission remain ordinary scheduling decisions',()=>{
 const {store,input,target}=fixture();try{
   store.recoverStoppedWorker('source',input);
   assert.equal(store.start({...target,id:'other',project:'org/other',ticket:'org/other#2',locks:[]}).ok,true);
   assert.deepEqual(store.start(target),{ok:false,reason:'capacity'});
   assert.equal(store.snapshot().claims.some(c=>c.ticket===ticket),false);
   store.finish('target','new','other');
   assert.equal(store.start(target).ok,true);
 }finally{store.close();}
});

test('HTTP restricts release to its source and clearing to the protected operator',async t=>{
 const {store,input,target}=fixture();
 const server=await serveFleet(store,{source:'source-secret',target:'target-secret'},'operator-secret',0);
 t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`;
 const source=new JsonClient(url,'source-secret'),foreign=new JsonClient(url,'target-secret'),operator=new JsonClient(url,'operator-secret');
 await assert.rejects(foreign.call('/machine-recovery/release',input),/source mismatch/);
 await assert.rejects(source.call('/machine-recovery/clear',{machine:'source',project,ids:[input.commandId]}),/403/);
 assert.equal((await source.call<any>('/machine-recovery/release',input)).ticket,ticket);
 assert.equal(store.start(target).ok,true);
 assert.equal((await operator.call<any[]>('/machine-recovery/read',{})).length,1);
 await operator.call('/machine-recovery/clear',{machine:'source',project,ids:[input.commandId]});
 assert.equal(store.machineRecoveries.blocked('source',project),false);
});


test('failed evidence storage rolls back the run, claim, workflow and source hold together',()=>{
 const {store,input}=fixture();try{
   const before=store.snapshot(),workflow=store.workflow.get(ticket);
   const comment=store.workflow.comment.bind(store.workflow);
   store.workflow.comment=()=>{throw new Error('storage full');};
   assert.throws(()=>store.recoverStoppedWorker('source',input),/storage full/);
   assert.deepEqual(store.snapshot(),before);assert.deepEqual(store.workflow.get(ticket),workflow);
   store.workflow.comment=comment;
   assert.equal(store.recoverStoppedWorker('source',input).ticket,ticket);
 }finally{store.close();}
});

test('the scheduler never offers a recovery-held source project and continues unrelated projects',()=>{
 const {store,input}=fixture();try{
   store.recoverStoppedWorker('source',input);
   const offer={key:'build',project,ticket,role:'builder',resource:'heavy' as const,locks:[],order:0};
   const other={...offer,key:'other',project:'org/other',ticket:'org/other#1'};
   const selected=scheduleMachine({machine:'source',projects:[project,'org/other'],heavyLimit:1,combinedLimit:2,offers:[offer,other],state:store.snapshot()});
   assert.deepEqual(selected.map(o=>o.ticket),[other.ticket]);
 }finally{store.close();}
});
