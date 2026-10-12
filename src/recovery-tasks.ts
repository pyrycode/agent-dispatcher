import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {scrubCredentials} from './agent-runtime.js';

export const CAPABILITIES = ['linux-amd64','macos-arm64','android-emulator','dispatcher-repair'] as const;
export type Capability = typeof CAPABILITIES[number];
export interface RecoveryTaskRequest {
 recipe: 'platform-probe'|'memory-runtime-smoke'|'android-tool-then-text'|'dispatcher-repair';
 capability: Capability; revision?: string; reason: string;
}
export interface RecoveryTaskResult {outcome:'completed'|'failed';summary:string;files:Record<string,string>;dispatcherRevision?:string}
export interface RecoveryTask {
 id:string;ticket:string;request:RecoveryTaskRequest;state:'queued'|'running'|'complete'|'failed'|'attention'|'publishing';
 created:number;updated:number;machine:string|null;session:string|null;runId:string|null;result:RecoveryTaskResult|null;
}
export interface MachineCapabilities {capabilities:Capability[];ready:boolean}

export function validateTaskRequest(value:unknown): RecoveryTaskRequest {
 const r=value as RecoveryTaskRequest;
 if (!r || !['platform-probe','memory-runtime-smoke','android-tool-then-text','dispatcher-repair'].includes(r.recipe)
  || !CAPABILITIES.includes(r.capability) || typeof r.reason!=='string' || !r.reason.trim() || r.reason.length>6000
  || Object.keys(r).some(k=>!['recipe','capability','revision','reason'].includes(k))) throw new Error('Invalid recovery task');
 if (r.recipe!=='platform-probe' && !/^[a-f0-9]{40}$/.test(r.revision??'')) throw new Error('An executed task requires an exact revision');
 if (r.recipe==='android-tool-then-text' && r.capability!=='android-emulator'
  || r.recipe==='memory-runtime-smoke' && !['linux-amd64','macos-arm64'].includes(r.capability)
  || r.recipe==='dispatcher-repair' && r.capability!=='dispatcher-repair') throw new Error('Recipe does not match the required platform');
 return {recipe:r.recipe,capability:r.capability,...(r.revision?{revision:r.revision}:{}),reason:scrubCredentials(r.reason)};
}
export function validateTaskResult(value:RecoveryTaskResult): RecoveryTaskResult {
 if (!value || !['completed','failed'].includes(value.outcome) || typeof value.summary!=='string' || !value.summary.trim() || value.summary.length>16000
  || !value.files || Array.isArray(value.files) || typeof value.files!=='object' || Object.keys(value.files).length>64) throw new Error('Invalid task result');
 if(value.dispatcherRevision!==undefined && !/^[a-f0-9]{40}$/.test(value.dispatcherRevision)) throw new Error('Invalid deployed dispatcher revision');
 let bytes=0;
 for (const [path,data] of Object.entries(value.files)) {
  if (!/^[\w./-]+$/.test(path) || path.startsWith('/') || path.split('/').some(p=>!p || p==='.' || p==='..') || typeof data!=='string') throw new Error('Invalid artifact path');
  bytes+=Buffer.byteLength(data);
  if (bytes>4*1024*1024) throw new Error('Task artifacts exceed the private transport limit');
  if (scrubCredentials(data)!==data) throw new Error('Artifact contains credential-shaped text; retain it privately and return a sanitised diagnostic');
 }
 return {...value,summary:scrubCredentials(value.summary)};
}

/** Requests and outcomes share the authority database. A lost acknowledgement never executes twice. */
export class RecoveryTasks {
 constructor(private db:DatabaseSync,private now=Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_recovery_tasks (
   id TEXT PRIMARY KEY,ticket TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,
   created INTEGER NOT NULL,updated INTEGER NOT NULL,machine TEXT,session TEXT,run_id TEXT,result TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS fleet_capabilities (machine TEXT PRIMARY KEY,record TEXT NOT NULL,updated INTEGER NOT NULL) STRICT;`);
 }
 report(machine:string,value:MachineCapabilities):void {
  if (!value || typeof value.ready!=='boolean' || !Array.isArray(value.capabilities) || value.capabilities.some(c=>!CAPABILITIES.includes(c))) throw new Error('Invalid capabilities');
  this.db.prepare('INSERT INTO fleet_capabilities VALUES (?,?,?) ON CONFLICT(machine) DO UPDATE SET record=excluded.record,updated=excluded.updated')
   .run(machine,JSON.stringify({capabilities:[...new Set(value.capabilities)].sort(),ready:value.ready}),this.now());
 }
 capabilities():Array<MachineCapabilities & {machine:string;updated:number}> {
  return this.db.prepare('SELECT * FROM fleet_capabilities ORDER BY machine').all().map(r=>({machine:String(r.machine),updated:Number(r.updated),...JSON.parse(String(r.record))}));
 }
 request(ticket:string,value:RecoveryTaskRequest,context=""):RecoveryTask {
  const request=validateTaskRequest(value);
  const id=createHash('sha256').update(JSON.stringify([ticket,request.recipe,request.capability,request.revision??null,context])).digest('hex');
  this.db.prepare("INSERT OR IGNORE INTO fleet_recovery_tasks VALUES (?,?,?,'queued',?,?,NULL,NULL,NULL,NULL)").run(id,ticket,JSON.stringify(request),this.now(),this.now());
  return this.get(id);
 }
 get(id:string):RecoveryTask {
  const r=this.db.prepare('SELECT * FROM fleet_recovery_tasks WHERE id=?').get(id);
  if (!r) throw new Error('Unknown recovery task');
  return {id:String(r.id),ticket:String(r.ticket),request:JSON.parse(String(r.request)),state:r.state as RecoveryTask['state'],
   created:Number(r.created),updated:Number(r.updated),machine:r.machine as string|null,session:r.session as string|null,runId:r.run_id as string|null,result:r.result?JSON.parse(String(r.result)):null};
 }
 list(ticket?:string):RecoveryTask[] {
  return (ticket?this.db.prepare('SELECT id FROM fleet_recovery_tasks WHERE ticket=? ORDER BY created DESC LIMIT 50').all(ticket)
   :this.db.prepare('SELECT id FROM fleet_recovery_tasks ORDER BY created DESC LIMIT 500').all()).map(r=>this.get(String(r.id)));
 }
 available(machine:string,id:string):boolean {
  const task=this.get(id), host=this.capabilities().find(c=>c.machine===machine);
  const incident=this.db.prepare('SELECT reason,decision,state FROM fleet_recovery WHERE ticket=? AND present=1').get(task.ticket);
  if(incident?.state==='escalated' && (/Explicit operator hold|Denied permission|Pause origin unknown/.test(String(incident.reason)) || incident.decision && JSON.parse(String(incident.decision)).category==='human')) return false;
  return task.state==='queued' && !!host?.ready && this.now()-host.updated<180000 && host.capabilities.includes(task.request.capability);
 }
 begin(id:string,machine:string,session:string,runId:string):void {
  if (!this.available(machine,id)) throw new Error('Task or capability unavailable');
  this.db.prepare("UPDATE fleet_recovery_tasks SET state='running',machine=?,session=?,run_id=?,updated=? WHERE id=? AND state='queued'").run(machine,session,runId,this.now(),id);
 }
 complete(id:string,machine:string,session:string,value:RecoveryTaskResult):RecoveryTask {
  const task=this.get(id),result=validateTaskResult(value);
  if (task.machine!==machine || task.session!==session) throw new Error('Task actor mismatch');
  if (['complete','failed'].includes(task.state)) {
   if (JSON.stringify(task.result)!==JSON.stringify(result)) throw new Error('Completed task result changed');
   return task;
  }
  if (!['running','attention','publishing'].includes(task.state)) throw new Error('Task is not running');
  this.db.prepare('UPDATE fleet_recovery_tasks SET state=?,result=?,updated=? WHERE id=?').run(result.outcome==='completed'?'complete':'failed',JSON.stringify(result),this.now(),id);
  return this.get(id);
 }
 uncertain(id:string,machine:string,session:string,reason:string):void {
  const task=this.get(id);
  if(task.machine!==machine || task.session!==session || !['running','attention'].includes(task.state)) throw new Error('Task actor mismatch');
  this.db.prepare("UPDATE fleet_recovery_tasks SET state='attention',updated=? WHERE id=?").run(this.now(),id);
  this.db.prepare("UPDATE fleet_recovery SET state='escalated',decision=?,updated=? WHERE ticket=? AND present=1")
   .run(JSON.stringify({action:'escalate',category:'human',reason:scrubCredentials(reason)}),this.now(),task.ticket);
 }
 revision(ticket:string):string|undefined {
  const terminal=this.list(ticket).filter(t=>t.result && ['complete','failed'].includes(t.state));
  return terminal.length?createHash('sha256').update(JSON.stringify(terminal.map(t=>[t.id,t.state,t.result]))).digest('hex'):undefined;
 }
}
