import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { FleetStore, type StartRequest } from './fleet-store.js';
import { ClaimsHistory, readClaimsRetention, startClaimsMaintenance } from './claims-history.js';
import { EvidenceStore, DEFAULT_EVIDENCE_LIMITS } from './evidence-store.js';
import {artifactManifest} from './recovery-artifacts.js';
import type { WorkflowItem } from './workflow-store.js';

const now = 100_000, window = 10_000;
const config = { project: 'org/core', projectId: 'P', statusFieldId: 'S', options: { Inbox: 'inbox', Done: 'done', Backlog: 'backlog' } };
const item = (n: number, extra: Partial<WorkflowItem> = {}): WorkflowItem => ({
  id: 'P'+n, issueId: 'I'+n, issueNumber: n, title: 'History', body: '', url: `https://github.com/org/core/issues/${n}`,
  status: 'Done', state: 'CLOSED', labels: [], blockedBy: [], parentNumber: null, grandparentNumber: null, revision: 1, position: n, ...extra,
});
const request = (id: string, n: number): StartRequest => ({id, machine: 'box', session: 'source', ticket: `org/core#${n}`, project: config.project, role: 'builder', resource: 'heavy', locks: []});
function seedRun(db: DatabaseSync, id: string, n: number, finished: number|null = 1, extra: object = {}) {
  const req = {...request(id,n), ...extra};
  db.prepare('INSERT INTO fleet_runs VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,req.machine,req.session,req.ticket,'generation','heavy',JSON.stringify(req),1,finished,finished === null ? null : 'completed');
  return req;
}
function seedCommand(store: FleetStore, db: DatabaseSync, id: string, n: number, age = 1, actor = 'builder') {
  store.workflow.change(`org/core#${n}`, {addLabels: ['proof']}, actor, id);
  db.prepare('UPDATE workflow_command_ages SET created=? WHERE id=?').run(age,id);
}

test('legacy ages are conservative; expired payloads keep durable replay refusal and upload ownership', t => {
  const directory = mkdtempSync(join(tmpdir(),'claims-history-')), path = join(directory,'claims.sqlite');
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  let store = new FleetStore(path,{box:{heavyLimit:2,combinedLimit:3}}, {now: () => now});
  const db = (store as any).db as DatabaseSync;
  store.workflow.import(config,[item(1),item(2),item(3,{state:'OPEN',status:'Backlog'}),item(4),item(5,{recoverySplit:{id:'replacement',featureRoot:'org/core#5',children:['org/core#3'],state:'replaced'}})]);
  seedCommand(store,db,'expired',1);
  seedCommand(store,db,'boundary',2,now-window);
  seedCommand(store,db,'open',3);
  seedCommand(store,db,'replacement',5);
  seedCommand(store,db,'operator',2,1,'operator');
  // A legacy command with no known age receives its first safe timestamp on reopen.
  seedCommand(store,db,'legacy',2); db.prepare('DELETE FROM workflow_command_ages WHERE id=?').run('legacy');
  const req=seedRun(db,'expired-run',1);
  const pinned=seedRun(db,'expired-verifier',1,1,{role:'verifier',verificationPin:{handoff:'h',candidate:'a'.repeat(40),revision:1,sourceGeneration:'g'}});
  seedRun(db,'open-run',3); seedRun(db,'unknown-run',999);
  seedRun(db,'boundary-run',2,now-window);
  seedRun(db,'active-run',4,null);
  seedRun(db,'support-parent',2,1,{parentTicket:'org/core#3',supportTaskId:'a'.repeat(64)});
  const priorRequest = String(db.prepare('SELECT request FROM workflow_commands WHERE id=?').get('expired')!.request);
  store.close();
  store = new FleetStore(path,{box:{heavyLimit:2,combinedLimit:3}}, {now: () => now});
  const reopened = (store as any).db as DatabaseSync;
  assert.equal(reopened.prepare('SELECT created FROM workflow_command_ages WHERE id=?').get('legacy')!.created,now);
  assert.deepEqual(store.history.sweep(window),{commands:1,runs:2});
  assert.deepEqual(store.history.sweep(window),{commands:0,runs:0});
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM workflow_commands').get()!.n,5);
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM fleet_runs').get()!.n,5);
  assert.equal(reopened.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
  assert.deepEqual({...reopened.prepare("SELECT created,finished,outcome FROM fleet_retired_runs WHERE id='expired-run'").get()},{created:1,finished:1,outcome:'completed'});
  store.close();
  store = new FleetStore(path,{box:{heavyLimit:2,combinedLimit:3}}, {now: () => now});
  t.after(() => store.close());
  store.workflow.change('org/core#1',{state:'OPEN',status:'Backlog'},'operator','reopen');
  const saved = JSON.parse(priorRequest);
  assert.throws(() => store.workflow.change(saved.ticket,saved.change,saved.actor,'expired'),/expired/);
  assert.throws(() => store.workflow.change(saved.ticket,{status:'Done'},saved.actor,'expired'),/identity reused/);
  assert.deepEqual(store.start(req),{ok:false,reason:'finished'});
  assert.deepEqual(store.start({...pinned,verificationPin:undefined}),{ok:false,reason:'finished'});
  assert.throws(() => store.start({...req,machine:'foreign'}),/Unknown machine|different contents/);
  assert.deepEqual(store.runOwner(req.id),{machine:'box',ticket:'org/core#1',role:'builder'});
  const evidence = new EvidenceStore(join(directory,'evidence.sqlite'),DEFAULT_EVIDENCE_LIMITS,id => store.runOwner(id));
  t.after(() => evidence.close());
  // The real upload authorization path still knows the retired run's computer.
  const meta={kind:'agent',role:'builder',outcome:'completed',startedAt:1,endedAt:2}, manifest=artifactManifest({'result.txt':'retained'});
  assert.throws(() => evidence.begin('foreign', 'org/core', 'org/core#1', req.id, meta, manifest), /owner mismatch/);
  assert.equal(evidence.begin('box','org/core','org/core#1',req.id,meta,manifest).committed,false);
});

test('unresolved references and approval provenance pin completed-ticket records; lookup failures roll back', t => {
  const store = new FleetStore(':memory:',{box:{heavyLimit:2,combinedLimit:3}}, {now: () => now});
  t.after(() => store.close());
  const db = (store as any).db as DatabaseSync;
  store.workflow.import(config,Array.from({length:12},(_,i)=>item(i+1)));
  for(let n=1;n<=12;n++){seedCommand(store,db,'c'+n,n);seedRun(db,'r'+n,n);}
  db.prepare('INSERT INTO fleet_claims VALUES (?,?,?,?)').run('org/core#1','box','held',1);
  db.prepare('INSERT INTO fleet_locks VALUES (?,?)').run('retained','r2');
  db.prepare("INSERT INTO fleet_recovery VALUES (?,?,?,?,?,?,?,?,?,1)").run('incident','org/core#3','fingerprint','repair','waiting',1,1,'r3',JSON.stringify({waitFor:['org/core#4']}));
  db.prepare('INSERT INTO fleet_stage_results VALUES (?,?,?)').run('r5','org/core#5',JSON.stringify({acceptance:{state:'waiting'}}));
  db.prepare('INSERT INTO fleet_stage_publications VALUES (?,?,?,?,0)').run('r6','org/core#6',1,'pending');
  db.prepare('INSERT INTO fleet_verifier_handoffs VALUES (?,?,?,?)').run('handoff','org/core#7','{}',JSON.stringify({state:'admitted',runId:'r7'}));
  db.prepare('INSERT INTO fleet_recovery_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('task','org/core#8','{}','queued',1,1,null,null,null,null);
  db.prepare('INSERT INTO fleet_approval_events VALUES (?,?,?,?)').run('org/core#9','r9','{}',1);
  store.workflow.change('org/core#10',{state:'OPEN',status:'Backlog',blockedBy:[{number:11,state:'CLOSED',url:'https://github.com/org/core/issues/11'}]},'operator','open-child');
  db.prepare("UPDATE workflow_tickets SET item=json_set(item,'$.parentNumber',12) WHERE ticket='org/core#10'").run();
  const result=store.history.sweep(window);
  assert.deepEqual(result,{commands:1,runs:0},'a lock pins its run, not unrelated command payloads');
  assert.ok(db.prepare("SELECT 1 FROM workflow_commands WHERE id='c11'").get());
  const broken = new ClaimsHistory(db,()=>{throw new Error('completion unavailable');},()=>now);
  assert.throws(()=>broken.sweep(window),/completion unavailable/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM fleet_retired_runs').get()!.n,0);
});

test('maintenance uses independent bounded timers and reports failures without losing records', () => {
  const scheduled = new Map<number,()=>void>(), warnings:string[]=[], calls:string[]=[];
  const stop=startClaimsMaintenance({sweep:()=>{calls.push('sweep');throw new Error('private payload');},vacuumStep:()=>({free:0,conversionRequired:true})},window,message=>warnings.push(message),(work,ms)=>{scheduled.set(ms,work);return()=>{scheduled.delete(ms);};});
  assert.deepEqual([...scheduled.keys()],[3600_000,60_000]);
  scheduled.get(3600_000)!();scheduled.get(60_000)!();scheduled.get(60_000)!();
  assert.equal(calls.length,2);assert.equal(warnings.length,3);assert.ok(!warnings.join('').includes('private payload'));
  stop();assert.equal(scheduled.size,0);
  assert.equal(readClaimsRetention(),30*86400_000);
  for(const value of [null,false,{retentionDays:0},{retentionDays:-1},{retentionDays:NaN},{retentionDays:Infinity},{retentionDays:'30'},{unknown:1}])assert.throws(()=>readClaimsRetention(value));
});

test('offline conversion keeps a consistent backup and bounded vacuum reclaims populated legacy bytes', t => {
  const directory=mkdtempSync(join(tmpdir(),'claims-convert-')),path=join(directory,'claims.sqlite'),backup=join(directory,'backup.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  // A real legacy layout, without incremental auto-vacuum or command ages.
  const old=new DatabaseSync(path);old.exec('PRAGMA journal_mode=WAL; CREATE TABLE workflow_commands(id TEXT PRIMARY KEY,ticket TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL) STRICT;');
  old.prepare('INSERT INTO workflow_commands VALUES (?,?,?,?)').run('legacy','org/core#1',JSON.stringify({actor:'builder'}),'x'.repeat(8*1024*1024));old.close();
  const store=new FleetStore(path,{box:{heavyLimit:2,combinedLimit:3}},{now:()=>now});
  store.workflow.import(config,[item(1)]);
  const db=(store as any).db as DatabaseSync;
  assert.equal(db.prepare('PRAGMA auto_vacuum').get()!.auto_vacuum,0);
  assert.equal(store.history.vacuumStep().conversionRequired,true);
  store.close();
  // Keep a committed write in WAL while the consistent backup is taken.
  const wal = new DatabaseSync(path);
  wal.prepare('INSERT INTO workflow_events(ticket,actor,at,change) VALUES (?,?,?,?)').run('org/core#1','builder',now,'WAL sentinel');
  const script=new URL('../scripts/claims-vacuum.py',import.meta.url).pathname;
  assert.throws(()=>execFileSync('python3',[script,path,backup],{stdio:'pipe'}),/Command failed/);
  const conversion=JSON.parse(execFileSync('python3',[script,path,backup,'--service-stopped'],{encoding:'utf8'}));
  assert.equal(conversion.integrity,'ok');
  const saved=new DatabaseSync(backup);assert.equal(saved.prepare('SELECT length(result) AS n FROM workflow_commands').get()!.n,8*1024*1024);assert.equal(saved.prepare("SELECT count(*) AS n FROM workflow_events WHERE change='WAL sentinel'").get()!.n,1);saved.close();wal.close();
  assert.throws(()=>execFileSync('python3',[script,path,backup,'--service-stopped'],{stdio:'pipe'}),/Command failed/);
  const converted=new FleetStore(path,{box:{heavyLimit:2,combinedLimit:3}},{now:()=>now+window+1});
  const current=(converted as any).db as DatabaseSync;
  const before=statSync(path).size;
  assert.deepEqual(converted.history.sweep(window),{commands:1,runs:0});
  for(let n=0;n<2200 && converted.history.vacuumStep().free;n++);
  assert.equal(converted.history.vacuumStep().free,0);
  const after=statSync(path).size;
  assert.ok(after < before/2,`legacy fixture ${before} -> ${after}`);
  assert.equal(current.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
  assert.equal(current.prepare('PRAGMA foreign_key_check').all().length,0);
  converted.close();
  t.diagnostic(`synthetic legacy database reclaimed ${before-after} bytes: ${before} -> ${after}; no production measurement`);
});


test('a failure after payload deletion begins rolls the entire retirement transaction back', t => {
  const store=new FleetStore(':memory:',{box:{heavyLimit:2,combinedLimit:3}},{now:()=>now});
  t.after(()=>store.close());
  const db=(store as any).db as DatabaseSync;
  store.workflow.import(config,[item(1)]);
  seedCommand(store,db,'rollback-command',1);seedRun(db,'rollback-run',1);
  db.exec("CREATE TRIGGER refuse_retirement BEFORE DELETE ON fleet_runs BEGIN SELECT RAISE(ABORT,'retained reference changed'); END;");
  assert.throws(()=>store.history.sweep(window),/retained reference changed/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM fleet_retired_commands').get()!.n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM fleet_retired_runs').get()!.n,0);
  assert.ok(db.prepare("SELECT 1 FROM workflow_commands WHERE id='rollback-command'").get());
  assert.ok(db.prepare("SELECT 1 FROM fleet_runs WHERE id='rollback-run'").get());
});

test('offline conversion refuses unsettled reservations before creating a backup', t => {
  const directory=mkdtempSync(join(tmpdir(),'claims-conversion-held-')),path=join(directory,'claims.sqlite'),backup=join(directory,'backup.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new FleetStore(path,{box:{heavyLimit:2,combinedLimit:3}});
  seedRun((store as any).db,'active',1,null);store.close();
  const script=new URL('../scripts/claims-vacuum.py',import.meta.url).pathname;
  assert.throws(()=>execFileSync('python3',[script,path,backup,'--service-stopped'],{stdio:'pipe'}),/Unsettled run records/);
  const saved=new DatabaseSync(path);assert.equal(saved.prepare('SELECT count(*) AS n FROM fleet_runs WHERE finished IS NULL').get()!.n,1);saved.close();
});
