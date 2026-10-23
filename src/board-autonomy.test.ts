import {decideReworkRoutes} from './pipeline-decisions.js';
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
import { OPERATION_PHASES } from './operation-reports.js';
import { serveFleet, JsonClient } from './fleet-http.js';
import { recoveryPlan, observationFor, runRecoveryWork } from './recovery-work.js';
import { recoveryInventory, relatedTickets, relatedEvidence } from './recovery-evidence.js';
import { coordinationCanRelease } from './recovery-coordination.js';
import { recoveryReport } from './recovery-report.js';
import { FleetUpdates } from './fleet-updates.js';
import type { AgentConfig, ProjectItem } from './types.js';

const project = 'org/core';
const empty = { claims: [], runs: [] };
const item: ProjectItem = { id:'card',issueId:'node',issueNumber:1,title:'Repair',body:'',status:'Halted',labels:[],url:'https://github.com/org/core/issues/1',blockedBy:[],parentNumber:null,grandparentNumber:null };
const agents: AgentConfig[] = [{name:'builder',column:'In Development',description:'',claudeMdPath:'',usesWorktree:true,producesCommits:true}];
const pause: PauseRecord = {ticket:project+'#1',origin:'pipeline',actor:'mac/builder',reason:'Live infrastructure was unavailable',missing:'Restored access',resumeOn:'Verified access has returned',resumeStatus:'In Development',revision:'generation'};

test('supervisor reports are machine-scoped and contain no executable or ownership data', async t => {
  const store = new FleetStore(':memory:', {mac:{heavyLimit:1,combinedLimit:2},linux:{heavyLimit:1,combinedLimit:2}});
  const server = await serveFleet(store,{mac:'mac-fixture',linux:'linux-fixture'},'admin-fixture',0);
  t.after(async () => {await new Promise<void>(r=>server.close(()=>r()));store.close();});
  const address=server.address(); assert.ok(address && typeof address !== 'string');
  const client=new JsonClient(`http://127.0.0.1:${address.port}`,'mac-fixture');
  const report={operations:[{project,phase:'attention',reason:'Restart needs inspection',claims:['private'],desired:{credential:'fingerprint'},command:'launch-something'}]};
  await assert.rejects(client.call('/operations/report',{machine:'linux',report}),/403/);
  await client.call('/operations/report',{machine:'mac',report});
  const records=await client.call<any[]>('/operations/reports');
  assert.deepEqual(records[0].operations,[{project,phase:'attention',reason:'Restart needs inspection'}]);
  assert.equal(records[0].machine,'mac');
  await assert.rejects(client.call('/operations/report',{machine:'mac',report:{operations:[{project,phase:'arbitrary-command'}]}}));
});

test('operation reports accept every phase the supervisor writes', async t => {
  const source = readFileSync(join(import.meta.dirname, '..', 'scripts', 'fleet-supervisor.py'), 'utf8');
  // Storage observations in main have their own schema. Operation phases
  // are written by Supervisor, before the executable's main loop.
  const operations = source.slice(source.indexOf('class Supervisor:'),source.indexOf('\ndef main('));
  const written = new Set([...operations.matchAll(/'phase'\]?\s*[:=]\s*'([a-z-]+)'/g)].map(m => m[1]));
  assert.ok(written.has('waiting-for-native-task'));
  assert.deepEqual([...written].filter(phase => !OPERATION_PHASES.includes(phase)), []);
  const store = new FleetStore(':memory:', {linux:{heavyLimit:1,combinedLimit:2}});
  const server = await serveFleet(store,{linux:'linux-fixture'},'admin-fixture',0);
  t.after(async () => {await new Promise<void>(r=>server.close(()=>r()));store.close();});
  const address=server.address(); assert.ok(address && typeof address !== 'string');
  const client=new JsonClient(`http://127.0.0.1:${address.port}`,'linux-fixture');
  await client.call('/operations/report',{machine:'linux',report:{operations:[{project,phase:'waiting-for-native-task'},{project:'org/desktop',phase:'complete'}]}});
  const records=await client.call<any[]>('/operations/reports');
  assert.deepEqual(records[0].operations,[{project,phase:'waiting-for-native-task'},{project:'org/desktop',phase:'complete'}]);
});

test('supervisor reports keep automatic clears and retirements visible without risking the report', async t => {
  const store = new FleetStore(':memory:', {mac:{heavyLimit:1,combinedLimit:2}});
  const server = await serveFleet(store,{mac:'mac-fixture'},'admin-fixture',0);
  t.after(async () => {await new Promise<void>(r=>server.close(()=>r()));store.close();});
  const address=server.address(); assert.ok(address && typeof address !== 'string');
  const client=new JsonClient(`http://127.0.0.1:${address.port}`,'mac-fixture');
  const retired={at:1791915253,kind:'operation-retired',subject:project,reason:'Retired verifying record automatically',archive:'/private/path'};
  const housekeeping=[retired,{at:'soon',kind:'operation-retired',subject:project,reason:'bad time'},{at:1,kind:'run-command',subject:project,reason:'unknown kind'},
    {at:1791915300,kind:'native-task-unrecoverable',subject:'c02a547f',reason:'Retained artifacts unrecoverable. FileNotFoundError'},
    {at:1791920992,kind:'native-task-interrupted',subject:'29219c8b',reason:'Its container pyrycode-dispatcher is not running. Reservation released as interrupted work.'},
    {at:1791920936,kind:'native-task-deferred',subject:'29219c8b',reason:'Admitted while its container was draining or updating.'}];
  await client.call('/operations/report',{machine:'mac',report:{operations:[{project,phase:'current'}],housekeeping}});
  const [record]=await client.call<any[]>('/operations/reports');
  assert.deepEqual(record.operations,[{project,phase:'current'}]);
  assert.deepEqual(record.housekeeping,[{at:1791915253,kind:'operation-retired',subject:project,reason:'Retired verifying record automatically'},
    {at:1791915300,kind:'native-task-unrecoverable',subject:'c02a547f',reason:'Retained artifacts unrecoverable. FileNotFoundError'},
    {at:1791920992,kind:'native-task-interrupted',subject:'29219c8b',reason:'Its container pyrycode-dispatcher is not running. Reservation released as interrupted work.'},
    {at:1791920936,kind:'native-task-deferred',subject:'29219c8b',reason:'Admitted while its container was draining or updating.'}]);
});

test('supervisor reports carry the no-progress watchdog findings, bounded and scrubbed, without risking the report', async t => {
  const store = new FleetStore(':memory:', {pyrybox:{heavyLimit:1,combinedLimit:2}});
  const server = await serveFleet(store,{pyrybox:'pyrybox-fixture'},'admin-fixture',0);
  t.after(async () => {await new Promise<void>(r=>server.close(()=>r()));store.close();});
  const address=server.address(); assert.ok(address && typeof address !== 'string');
  const client=new JsonClient(`http://127.0.0.1:${address.port}`,'pyrybox-fixture');
  // Modelled on the #3289 repair task, 2026-10-14: finished 09:31:47, its publication refused every pass.
  const finalized={kind:'finalized',subject:'58915c35',ticket:'pyrycode/pyrycode#3289',phase:'finalizing',since:1791959507,lastProgress:1791959507,
    limitSeconds:600,worker:'finished',action:'released',reason:'Native task finished and drained, but completing it was refused. Reservation released as failed; files kept.'};
  const starvation={kind:'starvation',subject:'pyrycode/pyrycode-desktop#1809 real-claude-gate',ticket:'pyrycode/pyrycode-desktop#1809',phase:'real-claude-gate',
    since:1791962760,lastProgress:1791959507,limitSeconds:3600,holder:'pyrycode/pyrycode#3289 native task',action:'attention',reason:'A heavy job has waited for capacity.'};
  const credential=['Bearer','Q7'.repeat(12)].join(' ');
  const watchdog=[finalized,starvation,{kind:'restart-worker',reason:'unknown kind'},{kind:'stalled'},null,
    {kind:'stalled',subject:7,since:'soon',limitSeconds:Infinity,extra:'dropped',reason:'Last refusal: '+credential}];
  await client.call('/operations/report',{machine:'pyrybox',report:{operations:[{project,phase:'waiting-for-native-task'}],watchdog,
    housekeeping:[{at:1791960107,kind:'native-task-finalized',subject:'58915c35',reason:finalized.reason},{at:1791960107,kind:'watchdog-starvation',subject:'x',reason:'waited'}]}});
  const [record]=await client.call<any[]>('/operations/reports');
  assert.deepEqual(record.watchdog.slice(0,2),[finalized,starvation]);
  assert.equal(record.watchdog.length,3);
  assert.deepEqual(Object.keys(record.watchdog[2]).sort(),['kind','reason']);
  assert.ok(!record.watchdog[2].reason.includes(credential));
  assert.deepEqual(record.housekeeping.map((h:any)=>h.kind),['native-task-finalized','watchdog-starvation']);
  await client.call('/operations/report',{machine:'pyrybox',report:{operations:[],watchdog:Array.from({length:30},(_,i)=>({...starvation,subject:'s'+i}))}});
  assert.equal((await client.call<any[]>('/operations/reports'))[0].watchdog.length,20);
  await client.call('/operations/report',{machine:'pyrybox',report:{operations:[],watchdog:'not a list'}});
  assert.equal((await client.call<any[]>('/operations/reports'))[0].watchdog,undefined);
});

test('unavailable optional related evidence preserves the other ticket evidence', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('/issues/2')) throw new Error('transport failure with private details');
    return new Response(JSON.stringify(url.includes('/comments') ? [] : {title:'Useful evidence',state:'open',body:'Observed failure'}));
  };
  try {
    const result = await relatedEvidence(['org/core#1','org/core#2'], 'test-token');
    assert.equal(result[0].body, 'Observed failure');
    assert.deepEqual(result[1], {ticket:'org/core#2',unavailable:'transport'});
  } finally { globalThis.fetch = original; }
});

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
  assert.equal(incident.state,'queued');
  assert.equal(store.facts.getPause(project+'#1'),undefined);
  assert.throws(()=>recoveryPlan(item,{action:'resume',reason:'Forged board receipt'},agents));
  assert.deepEqual(store.snapshot().idleRecoveryTickets,[project+'#1']);
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

test('builder scope discovery enters recovery immediately and cannot retry unchanged',()=>{
 const scoped={...item,status:'In Development',labels:['error:builder:scope','needs-real-claude']};
 assert.equal(recoveryTrigger(observationFor(project,scoped))?.manual,false);
 assert.throws(()=>recoveryPlan(scoped,{action:'retry',reason:'Continue the larger estimate'},agents),/reassessment/);
 const plan=recoveryPlan(scoped,{action:'rework',reason:'Inspection establishes one bounded defect; retain its regression and repair the shared completion boundary'},agents);
 assert.equal(plan.status,'In Development');
 assert.deepEqual(plan.remove,['error:builder:scope']);
 assert.throws(()=>recoveryPlan({...scoped,labels:[...scoped.labels,'needs-human:approval']},{action:'rework',reason:'Ignore hold'},agents));
});

test('stale rework routing cannot erase a builder scope request',()=>{
 const scoped={...item,status:'In Development',labels:['error:builder:scope','needs-rework:builder']};
 assert.deepEqual(decideReworkRoutes(new Map([['builder','In Development']]),new Map([['In Development',[scoped]]])),[]);
});
