import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {RecoveryLedger,recoveryFingerprint,type RecoveryObservation,type RecoveryDecision} from './fleet-recovery.js';
import {FleetStore} from './fleet-store.js';
import {runRecoveryWork,observationFor} from './recovery-work.js';
import type {ProjectItem,AgentConfig} from './types.js';

const project='org/core',empty={claims:[],runs:[]},limits={mac:{heavyLimit:1,combinedLimit:2}};
const error:RecoveryObservation={ticket:project+'#3211',status:'In Development',labels:['error:builder'],blocked:false};
const upgraded=(o:RecoveryObservation)=>({...o,assessmentPolicy:1});
function seed(db:DatabaseSync,o:RecoveryObservation,decision:RecoveryDecision|null=null,reason='error:builder') {
 db.prepare('INSERT INTO fleet_recovery VALUES (?,?,?,?,?,?,?,?,?,1)').run('old',o.ticket,recoveryFingerprint(o),reason,'escalated',100,100,'finished',decision?JSON.stringify(decision):null);
}
const item=(o:RecoveryObservation):ProjectItem=>({id:'item',issueId:'issue',issueNumber:Number(o.ticket.split('#')[1]),title:'Repair',body:'',status:o.status,labels:o.labels,url:'https://example.test/issue',blockedBy:[],parentNumber:null,grandparentNumber:null,...(o.pause?{recoveryPause:o.pause}:{})});
const agents:AgentConfig[]=[{name:'builder',column:'In Development',description:'builder',claudeMdPath:'unused',usesWorktree:true,producesCommits:true}];

test('existing technical escalations get one fresh assessment only after their worker loads the policy',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let ledger=new RecoveryLedger(db,()=>1000);
 seed(db,error,{action:'escalate',reason:'Native Mac diagnostics were unavailable'});
 assert.deepEqual(ledger.report('mac',project,[error],empty),[],'old workers cannot consume the new assessment');
 const [next]=ledger.report('mac',project,[upgraded(error)],empty);assert.ok(next);assert.notEqual(next.id,'old');assert.equal(next.state,'queued');
 assert.equal(ledger.report('mac',project,[upgraded(error)],empty)[0]?.id,next.id);
 ledger.begin(next.id,'review');ledger.decide(next.id,'review',{action:'escalate',reason:'An actual decision is still required'});
 ledger=new RecoveryLedger(db,()=>100000000);
 assert.deepEqual(ledger.report('mac',project,[upgraded(error)],empty),[],'the policy does not repeatedly recreate an unclassified assessment');
 assert.equal(ledger.list().filter(r=>r.current).length,1);
});

test('a legacy failed assessment can be diagnosed but a possibly applied handback is retained',t=>{
 for(const decision of [null,{action:'retry',reason:'Repair handback reserved'} as RecoveryDecision]) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const ledger=new RecoveryLedger(db,()=>1000);
  seed(db,error,decision,'Recovery ended without a confirmed result; inspect before retrying');
  const rows=ledger.report('mac',project,[upgraded(error)],empty);
  assert.equal(rows.length,decision?0:1);if(decision)assert.equal(ledger.incident('old').state,'escalated');
 }
});

test('genuine human decisions, operator pauses, denied permissions and active workers remain protected',t=>{
 const pause={ticket:error.ticket,origin:'operator' as const,actor:'operator',reason:'Deliberate shutdown',missing:'operator decision',resumeOn:'explicit instruction',resumeStatus:'In Development',revision:'hold-1'};
 for(const scenario of ['human','operator','permission','paused-permission','active','wip','uncertain'] as const) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const ledger=new RecoveryLedger(db,()=>1000);
  const o=upgraded(scenario==='operator'?{...error,status:'Halted',pause}:['permission','paused-permission'].includes(scenario)?{...error,status:scenario==='paused-permission'?'Halted':error.status,labels:['error:builder:permission_denied']}:scenario==='wip'?{...error,labels:['error:builder','wip:builder']}:error);
  seed(db,o,scenario==='human'?{action:'escalate',category:'human',reason:'Explicit scope decision required'}:null,scenario==='uncertain'?'Retained reservation without workflow progress for three hours; inspect local child processes before intervening':'error:builder');
  const fleet=['active','uncertain'].includes(scenario)?{claims:[],runs:[{id:scenario==='uncertain'?'finished':'live',session:'s',machine:'mac',project,ticket:o.ticket,role:'builder',resource:'medium' as const,locks:[],generation:'g',created:1000}]}:empty;
  assert.equal(ledger.report('mac',project,[o],fleet).filter(r=>r.state==='queued').length,0,scenario);
 }
});

test('unknown halted provenance is queued as an idle read-only assessment without reopening the ticket',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const ledger=new RecoveryLedger(db,()=>1000);
 const paused=upgraded({...error,status:'Halted',labels:[]});seed(db,paused,null,'Pause origin unknown; record who paused this ticket and the reopening condition');
 const [next]=ledger.report('mac',project,[paused],empty);assert.equal(next?.state,'queued');
 assert.equal(ledger.report('mac',project,[paused],empty)[0]?.id,next.id,'another observation must not turn the queued review back into a manual hold');
 const store=new FleetStore(':memory:',limits);t.after(()=>store.close());store.recoveryReport('mac',project,[paused]);
 assert.deepEqual(store.snapshot().idleRecoveryTickets,[paused.ticket]);
});

test('unknown pauses are inspected but cannot be blindly resumed or lose their hold',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const ledger=new RecoveryLedger(db,()=>1000);
 const paused=upgraded({...error,status:'Halted',labels:[]}),current=item(paused);const [incident]=ledger.report('mac',project,[paused],empty);
 assert.ok(incident);let assessed=0;const mutations:string[]=[];
 await runRecoveryWork(incident,{project,agents,readCurrent:async()=>current,begin:async()=>ledger.begin(incident.id,'read-only'),assess:async()=>{assessed++;return {action:'resume',reason:'Earlier backlog approval exists'};},decide:async d=>ledger.decide(incident.id,'read-only',d),complete:async()=>ledger.complete(incident.id,'read-only'),addLabel:async(_n,l)=>{if(l==='orchestrator:fixing')mutations.push(l);},removeLabel:async(_n,l)=>{if(l.startsWith('error:'))mutations.push(l);},comment:async()=>{},move:async()=>{mutations.push('move');},notify:async()=>{}});
 assert.equal(assessed,1);assert.deepEqual(mutations,[]);assert.equal(current.status,'Halted');assert.equal(ledger.incident(incident.id).decision?.category,'human');
});

test('a confirmed pause-provenance assessment retains no delivery claim without implementation history',t=>{
 const store=new FleetStore(':memory:',limits);t.after(()=>store.close());const paused=upgraded({...error,status:'Halted',labels:[]});const [incident]=store.recoveryReport('mac',project,[paused]);
 store.start({id:'review',session:'s',machine:'mac',project,ticket:paused.ticket,role:'recovery',resource:'heavy',locks:[]});
 store.recoveryStep('mac','s',project,incident.id,'review','begin');store.recoveryStep('mac','s',project,incident.id,'review','decide',{action:'escalate',category:'human',reason:'Need one explicit decision on the halted documentation batches'});store.finish('mac','s','review',true);
 assert.equal(store.snapshot().claims.length,0);assert.equal(store.recovery.incident(incident.id).state,'escalated');assert.equal(store.snapshot().releasedAssessmentClaims?.length,1);
});

test('new dispatcher observations advertise the reassessment policy without changing the workflow fingerprint',()=>{
 const o=observationFor(project,item(error));assert.equal((o as RecoveryObservation&{assessmentPolicy?:number}).assessmentPolicy,1);assert.equal(recoveryFingerprint(o),recoveryFingerprint(error));
});

 test('read-only pause diagnosis does not release a generation with real implementation history',t=>{
 const store=new FleetStore(':memory:',limits);t.after(()=>store.close());const paused=upgraded({...error,status:'Halted',labels:[]});
 store.start({id:'builder',session:'s',machine:'mac',project,ticket:paused.ticket,role:'builder',resource:'heavy',locks:[]});store.finish('mac','s','builder',true);
 const [incident]=store.recoveryReport('mac',project,[paused]);store.start({id:'review',session:'s',machine:'mac',project,ticket:paused.ticket,role:'recovery',resource:'heavy',locks:[]});
 store.recoveryStep('mac','s',project,incident.id,'review','begin');store.recoveryStep('mac','s',project,incident.id,'review','decide',{action:'escalate',category:'human',reason:'Need the pause decision'});store.finish('mac','s','review',true);assert.equal(store.snapshot().claims.length,1);
});

test('a delayed old-worker report cannot cancel or consume an upgraded unknown-pause assessment',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let ledger=new RecoveryLedger(db,()=>1000);const paused={...error,status:'Halted',labels:[]};
 const [first]=ledger.report('mac',project,[upgraded(paused)],empty);
 assert.deepEqual(ledger.report('old-worker',project,[paused],empty),[]);
 assert.equal(ledger.incident(first.id).state,'queued');ledger=new RecoveryLedger(db,()=>2000);
 assert.equal(ledger.report('mac',project,[upgraded(paused)],empty)[0]?.id,first.id);
});

test('a pipeline pause cannot hide permission denial or authorise coordination',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const ledger=new RecoveryLedger(db,()=>1000);
 const paused=upgraded({...error,status:'Halted',labels:['error:builder:permission_denied'],pause:{ticket:error.ticket,origin:'pipeline' as const,actor:'mac/builder',reason:'Missing platform',missing:'native run',resumeOn:'native result',resumeStatus:'In Development',revision:'pause-1'}});
 seed(db,paused,{action:'escalate',reason:'Native platform unavailable'});assert.deepEqual(ledger.report('mac',project,[paused],empty),[]);
 const current=item(paused);let assessed=0;await runRecoveryWork({...ledger.incident('old'),state:'queued'},{project,agents,readCurrent:async()=>current,begin:async()=>({...ledger.incident('old'),state:'assessing'}),assess:async()=>{assessed++;return {action:'coordinate',reason:'Use the new Mac',task:{recipe:'platform-probe',capability:'macos-arm64',reason:'probe'}};},decide:async d=>d,complete:async()=>{},addLabel:async()=>{},removeLabel:async()=>{},comment:async()=>{},move:async()=>{},notify:async()=>{}});assert.equal(assessed,0);
});

test('a confirmed provenance assessment retains ownership after an earlier recovery assigned repair',t=>{
 const store=new FleetStore(':memory:',limits);t.after(()=>store.close());const [repair]=store.recoveryReport('mac',project,[upgraded(error)]);
 store.start({id:'repair',session:'s',machine:'mac',project,ticket:error.ticket,role:'recovery',resource:'heavy',locks:[]});store.recoveryStep('mac','s',project,repair.id,'repair','begin');store.recoveryStep('mac','s',project,repair.id,'repair','decide',{action:'rework',reason:'Concrete implementation needed'});store.recoveryStep('mac','s',project,repair.id,'repair','complete');store.finish('mac','s','repair',true);
 const [pause]=store.recoveryReport('mac',project,[upgraded({...error,status:'Halted',labels:[]})]);store.start({id:'review',session:'s',machine:'mac',project,ticket:error.ticket,role:'recovery',resource:'heavy',locks:[]});store.recoveryStep('mac','s',project,pause.id,'review','begin');store.recoveryStep('mac','s',project,pause.id,'review','decide',{action:'escalate',category:'human',reason:'Need the pause decision'});store.finish('mac','s','review',true);assert.equal(store.snapshot().claims.length,1);
});

function coordinatedThenHalted(store:FleetStore,finishedTask=false) {
 const [incident]=store.recoveryReport('mac',project,[upgraded(error)]);
 store.start({id:'coordinate',session:'s',machine:'mac',project,ticket:error.ticket,role:'recovery',resource:'heavy',locks:[]});store.recoveryStep('mac','s',project,incident.id,'coordinate','begin');store.recoveryStep('mac','s',project,incident.id,'coordinate','decide',{action:'coordinate',reason:'Assigned dispatcher repair',task:{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision:'a'.repeat(40),reason:'Concrete dispatcher repair'}});store.finish('mac','s','coordinate',true);
 if(finishedTask){store.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});const task=store.tasks.list(error.ticket)[0];assert.equal(store.taskStart('mac',task.id,'helper').ok,true);store.taskComplete('mac',task.id,'helper',{outcome:'failed',summary:'Repair retained without publication',files:{}});}
 const paused=upgraded({...error,status:'Halted',labels:[]});store.recoveryReport('mac',project,[paused]);const [provenance]=store.recoveryReport('mac',project,[paused]);assert.equal(provenance.state,'queued');return provenance;
}

test('pause-provenance review preserves a previously coordinated repair even when its incident decision was replaced',t=>{
 const store=new FleetStore(':memory:',limits);t.after(()=>store.close());const incident=coordinatedThenHalted(store,true);
 store.start({id:'review',session:'s',machine:'mac',project,ticket:error.ticket,role:'recovery',resource:'heavy',locks:[]});store.recoveryStep('mac','s',project,incident.id,'review','begin');store.recoveryStep('mac','s',project,incident.id,'review','decide',{action:'escalate',category:'human',reason:'Pause needs an explicit decision'});store.finish('mac','s','review',true);assert.equal(store.snapshot().claims.length,1);
});

test('previously assigned support tasks remain paused throughout unknown-provenance review',t=>{
 const store=new FleetStore(':memory:',limits);t.after(()=>store.close());const incident=coordinatedThenHalted(store);store.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});const task=store.tasks.list(error.ticket)[0];
 assert.equal(store.tasks.available('mac',task.id),false,'queued provenance');store.start({id:'review',session:'s',machine:'mac',project,ticket:error.ticket,role:'recovery',resource:'heavy',locks:[]});store.recoveryStep('mac','s',project,incident.id,'review','begin');assert.equal(store.tasks.available('mac',task.id),false,'active provenance');
 store.recoveryStep('mac','s',project,incident.id,'review','decide',{action:'wait',reason:'No current authority to reopen'});assert.equal(store.tasks.available('mac',task.id),false,'completed provenance');
});

test('old reports preserve activated provenance review through changed evidence and restart',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let ledger=new RecoveryLedger(db,()=>1000);const paused={...error,status:'Halted',labels:[]};const [first]=ledger.report('mac',project,[upgraded(paused)],empty);
 const changed={...paused,artifactRevision:'a'.repeat(64)};assert.deepEqual(ledger.report('old-worker',project,[changed],empty),[]);const next=ledger.list(project).find(r=>r.current)!;assert.notEqual(next.id,first.id);assert.equal(next.state,'queued');
 assert.deepEqual(ledger.report('old-worker',project,[changed],empty),[]);assert.equal(ledger.incident(next.id).state,'queued');ledger=new RecoveryLedger(db,()=>2000);assert.equal(ledger.report('mac',project,[upgraded(changed)],empty)[0]?.id,next.id);
});
