import { coordinationReceipts } from './recovery-receipts.js';
import { execFileSync } from 'node:child_process';
import { writeRuntimeReceipt } from './runtime-receipt.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecoveryFacts, type PauseRecord } from './recovery-facts.js';
import { RecoveryLedger, recoveryTrigger } from './fleet-recovery.js';
import { FleetStore } from './fleet-store.js';
import { recoveryPlan, observationFor, runRecoveryWork } from './recovery-work.js';
import { recoveryInventory, relatedTickets } from './recovery-evidence.js';
import { coordinationCanRelease } from './recovery-coordination.js';
import { recoveryReport } from './recovery-report.js';
import { FleetUpdates } from './fleet-updates.js';
import type { AgentConfig, ProjectItem } from './types.js';

const project = 'org/core';
const empty = { claims: [], runs: [] };
const item: ProjectItem = { id:'card',issueId:'node',issueNumber:1,title:'Repair',body:'',status:'Halted',labels:[],url:'https://github.com/org/core/issues/1',blockedBy:[],parentNumber:null,grandparentNumber:null };
const agents: AgentConfig[] = [{name:'builder',column:'In Development',description:'',claudeMdPath:'',usesWorktree:true,producesCommits:true}];
const pause: PauseRecord = {ticket:project+'#1',origin:'pipeline',actor:'mac/builder',reason:'Live infrastructure was unavailable',missing:'Restored access',resumeOn:'Verified access has returned',resumeStatus:'In Development',revision:'generation'};

test('Halted requires an authoritative origin; operator holds never resume', () => {
  assert.equal(recoveryTrigger(observationFor(project,item))?.manual,true);
  const pipeline = {...item,recoveryPause:pause};
  assert.equal(recoveryTrigger(observationFor(project,pipeline))?.manual,false);
  assert.equal(recoveryPlan(pipeline,{action:'resume',reason:'Access verified'},agents).status,'In Development');
  assert.throws(()=>recoveryPlan({...pipeline,recoveryPause:{...pause,origin:'operator'}},{action:'resume',reason:'Guess'},agents));
  assert.throws(()=>recoveryPlan({...pipeline,labels:['needs-human:approval']},{action:'resume',reason:'Guess'},agents));
  assert.throws(()=>recoveryPlan({...pipeline,blockedBy:[{number:2,state:'OPEN'}]},{action:'resume',reason:'Guess'},agents));
});

test('pipeline receipts cannot be forged in board observations or by a different owner', () => {
  const store = new FleetStore(':memory:', {mac:{heavyLimit:1,combinedLimit:2},linux:{heavyLimit:1,combinedLimit:2}});
  const [incident] = store.recoveryReport('mac',project,[{...observationFor(project,item),pause}]);
  assert.equal(incident.state,'escalated');
  const request = {id:'run',session:'session',machine:'mac',project,ticket:project+'#1',role:'builder',resource:'medium' as const,locks:[]};
  store.start(request);
  assert.throws(()=>store.recordPause('linux','session',project,'run',pause));
  store.recordPause('mac','session',project,'run',pause);
  assert.equal(store.facts.getPause(project+'#1')?.actor,'mac/builder');
  assert.throws(()=>store.recordPause('mac','session',project,'run',{...pause,origin:'operator'}));
  store.close();
});

test('new evidence wakes a blocked ticket once; an unchanged wait does not buy repeated assessments', () => {
  const db = new DatabaseSync(':memory:'); let now=1000;
  const ledger = new RecoveryLedger(db,()=>now);
  const o = {...observationFor(project,{...item,status:'Inbox',blockedBy:[{number:2,state:'OPEN'}]}),evidenceRevision:'a'.repeat(64)};
  const [first]=ledger.report('mac',project,[o],empty);
  ledger.begin(first.id,'run'); ledger.decide(first.id,'run',{action:'wait',reason:'Real dependency needs repair'});
  now+=3600000;
  assert.deepEqual(ledger.report('mac',project,[o],empty),[]);
  const [second]=ledger.report('mac',project,[{...o,evidenceRevision:'b'.repeat(64)}],empty);
  assert.equal(second.state,'queued'); assert.notEqual(second.id,first.id);
  assert.equal(ledger.report('mac',project,[{...o,evidenceRevision:'b'.repeat(64)}],empty)[0].id,second.id);
  db.close();
});

test('cross-computer evidence is a content-free inventory and changes reassessment revision', () => {
  const dir=mkdtempSync(join(tmpdir(),'recovery-evidence-'));
  writeFileSync(join(dir,'2026-10-09_builder_#1968.log'),'private user payload\n'+JSON.stringify({status:'blocked',summary:'private secret body'}));
  const records=recoveryInventory(dir,project,'mac',[1968]);
  assert.equal(records[0].outcome,'blocked'); assert.equal(JSON.stringify(records).includes('private'),false);
  const db=new DatabaseSync(':memory:'); const facts=new RecoveryFacts(db);
  facts.evidence('mac',project,records);
  assert.equal(facts.getEvidence([project+'#1968'])[0].machine,'mac');
  assert.throws(()=>facts.evidence('linux',project,records));
  const revision=facts.revision([project+'#1968']);
  writeFileSync(join(dir,'2026-10-09_builder_#1968.log'),JSON.stringify({status:'completed'}));
  facts.evidence('mac',project,recoveryInventory(dir,project,'mac',[1968]));
  assert.notEqual(facts.revision([project+'#1968']),revision);
  db.close();
});

test('related evidence follows only configured GitHub repositories and bounded ticket references', () => {
  assert.deepEqual(relatedTickets(project,['See #1968 and https://github.com/org/mobile/issues/2012 and https://evil.test/org/mobile/issues/2013'],[],[project,'org/mobile']),[ 'org/mobile#2012',project+'#1968']);
  assert.deepEqual(relatedTickets(project,['https://github.com/unrelated/secret/issues/1'],[],[project]),[]);
});

test('coordination removal requires a recorded purpose and complete non-overlapping changes', () => {
  const record={ticket:project+'#1',blocker:project+'#2',paths:['screen.kt'],reason:'Edit coordination only'};
  assert.equal(coordinationCanRelease(undefined,['a'],['b']),false);
  assert.equal(coordinationCanRelease(record,null,['b']),false);
  assert.equal(coordinationCanRelease(record,[],['b']),false);
  assert.equal(coordinationCanRelease(record,['screen.kt'],['screen.kt']),false);
  assert.equal(coordinationCanRelease(record,['screen.kt'],['other.kt']),true);
});

test('a closure proposal reaches the single decision report and performs no closure', async () => {
  const db=new DatabaseSync(':memory:'); const ledger=new RecoveryLedger(db);
  const current={...item,status:'In Development',labels:['error:builder']};
  const [incident]=ledger.report('mac',project,[observationFor(project,current)],empty);
  const writes:string[]=[];
  await runRecoveryWork(incident,{project,agents,readCurrent:async()=>current,begin:async()=>ledger.begin(incident.id,'run'),
    assess:async()=>({action:'propose-close',reason:'Three exact comparisons pass. Original artifact is missing. Cause remains unproved.'}),
    decide:async d=>ledger.decide(incident.id,'run',d),complete:async()=>ledger.complete(incident.id,'run'),
    comment:async()=>{writes.push('comment');},addLabel:async()=>{},removeLabel:async()=>{},move:async()=>{writes.push('move');},notify:async()=>{}});
  const report=recoveryReport(ledger.list(),{});
  assert.equal(report.decisions[0].kind,'closure-proposal'); assert.deepEqual(writes,['comment']);
  assert.match(report.decisions[0].reason,/unproved/); db.close();
});

test('resolved historic alerts disappear from the decision report', () => {
  const db=new DatabaseSync(':memory:'); const ledger=new RecoveryLedger(db);
  ledger.report('mac',project,[observationFor(project,item)],empty);
  ledger.report('mac',project,[],empty);
  assert.deepEqual(recoveryReport(ledger.list(),{}).decisions,[]); db.close();
});

test('consumer lookup validates the dispatcher destination and expires stale manifests', async () => {
  let now=1000;
  const broker={request:async(_project:string,req:{path:string})=>({status:200,body:JSON.stringify(req.path.includes('/contents/')?{sha:'b'.repeat(40),submodule_git_url:'https://github.com/org/dispatcher.git'}:{object:{sha:'a'.repeat(40)}})})};
  const updates=new FleetUpdates(broker as any,{[project]:'org/core-agents'},'org/dispatcher',()=>now);
  await updates.refresh(); assert.equal(updates.snapshot()[project].dispatcher,'b'.repeat(40));
  now+=900001; assert.deepEqual(updates.snapshot(),{});
  const hostile=new FleetUpdates({request:async()=>({status:200,body:JSON.stringify({object:{sha:'a'.repeat(40)},sha:'b'.repeat(40),submodule_git_url:'https://evil.test/dispatcher'})})} as any,{[project]:'org/core-agents'},'org/dispatcher');
  await assert.rejects(hostile.refresh(),/destination/);
});


test('loaded source is retained when a later checkout changes on disk', () => {
  const root=mkdtempSync(join(tmpdir(),'loaded-source-')); const logs=join(root,'logs'); mkdirSync(logs);
  const repo=join(root,'dispatcher'); mkdirSync(repo);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('init','--initial-branch','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.test');
  writeFileSync(join(repo,'source'),'first'); assert.equal(git('branch','--show-current'),'main'); git('add','source'); git('commit','-m','first');
  const first=git('rev-parse','HEAD'); writeRuntimeReceipt(logs,repo,repo);
  writeFileSync(join(repo,'source'),'second'); assert.equal(git('branch','--show-current'),'main'); git('add','source'); git('commit','-m','second');
  assert.notEqual(first,git('rev-parse','HEAD'));
  const receipt=JSON.parse(readFileSync(join(logs,'runtime.json'),'utf8'));
  assert.equal(receipt.dispatcher,first); assert.equal(receipt.consumer,first); assert.equal(receipt.pid,process.pid);
});


test('only explicit admitted planning output records coordination for the current ticket', () => {
  const receipt='<!-- edit-coordination: {"blocker":2,"paths":["screen.kt"],"reason":"Shared edits only"} -->';
  assert.deepEqual(coordinationReceipts(receipt,project,1),[{ticket:project+'#1',blocker:project+'#2',paths:['screen.kt'],reason:'Shared edits only'}]);
  assert.deepEqual(coordinationReceipts('Quoted: '+receipt,project,1),[]);
  assert.throws(()=>coordinationReceipts('<!-- edit-coordination: {"blocker":"other/repo#2"} -->',project,1));
});


test('the 3071 shape requests evidence refinement without bypassing a causal dependency', () => {
  const inbox={...item,status:'Inbox',labels:['needs-real-claude','security-sensitive','rework-other:1']};
  assert.equal(recoveryTrigger(observationFor(project,inbox))?.manual,false);
  const planner={...agents[0],name:'refiner',column:'Backlog'};
  assert.equal(recoveryPlan(inbox,{action:'refine',reason:'Collect portable authenticated queue proof'},[planner,...agents]).status,'Backlog');
  assert.throws(()=>recoveryPlan({...inbox,blockedBy:[{number:2,state:'OPEN'}]},{action:'refine',reason:'Skip dependency'},[planner,...agents]));
});
