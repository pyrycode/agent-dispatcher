import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {scrubCredentials} from './agent-runtime.js';
import {validateRepairPublication} from './recovery-source-publication.js';
import {ARTIFACT_LIMITS,artifactManifest,manifestHash,sha256,validateArtifactPath,validateManifest,type ArtifactManifest} from './recovery-artifacts.js';

export const CAPABILITIES = ['linux-amd64','macos-arm64','android-emulator','dispatcher-repair'] as const;
export type Capability = typeof CAPABILITIES[number];
export interface RecoveryTaskRequest {
 recipe: 'platform-probe'|'memory-runtime-smoke'|'android-tool-then-text'|'dispatcher-repair';
 capability: Capability; revision?: string; reason: string;
}
export interface RecoveryTaskResult {outcome:'completed'|'failed';summary:string;files:Record<string,string>;dispatcherRevision?:string;candidateRevision?:string}
export interface RecoveryTask {
 id:string;ticket:string;request:RecoveryTaskRequest;state:'queued'|'running'|'complete'|'failed'|'attention'|'publishing';
 created:number;updated:number;machine:string|null;session:string|null;runId:string|null;result:RecoveryTaskResult|null;
 artifacts?:ArtifactManifest;
 artifactsPending?:boolean;
}
export interface MachineCapabilities {capabilities:Capability[];ready:boolean}

const diagnosticNames=new Set(['builder','reviewer','install','test','typecheck','helpers'].map(n=>n+'.diagnostic.log'));
const diagnosticOrder=['reviewer.findings.json',...['helpers','typecheck','test','install','reviewer','builder'].map(n=>n+'.diagnostic.log')];
export interface AssessmentBudget {bytes:number;diagnosticCharacters:number}
export type AssessmentTask=Omit<RecoveryTask,'artifacts'> & {artifacts?:{digest:string;totalBytes:number;fileCount:number;omittedFileCount:number}};
/** Only bounded diagnostic excerpts leave private artifact storage, for the owning assessment. */
export function assessmentTasks(tasks:RecoveryTask[],includeDiagnostics:boolean,readArtifact?:(task:RecoveryTask,path:string)=>string,
 budget:AssessmentBudget={bytes:512*1024,diagnosticCharacters:48000}):AssessmentTask[] {
 const views:AssessmentTask[]=[];
 for(const task of tasks) {
  let remaining=budget.diagnosticCharacters;
  const manifest=task.artifacts??(!task.artifactsPending&&task.result?artifactManifest(task.result.files):undefined);
  const priority=(name:string)=>{const rank=diagnosticOrder.indexOf(name);return rank<0?100:rank;};
  const paths=(manifest?manifest.files.map(file=>file.path):Object.keys(task.result?.files??{}))
   .sort((a,b)=>priority(a)-priority(b)||(a<b?-1:a>b?1:0));
  // A preview must not duplicate a full 1024-file inventory in every assessment.
  // The complete digest-backed inventory is returned only by /tasks/read.
  const preview=paths.slice(0,16);
  const files=Object.fromEntries(preview.map(name=>{
   let data=task.result&&Object.hasOwn(task.result.files,name)?task.result.files[name]:undefined;
   if(includeDiagnostics && task.state==='failed' && remaining>0 && readArtifact && task.artifacts
    && (diagnosticNames.has(name) || name==='reviewer.findings.json' && task.artifacts.files.find(f=>f.path===name)!.bytes<=Math.min(16000,remaining))) {
    data=readArtifact(task,name);
   }
   if(data!==undefined && includeDiagnostics && task.state==='failed' && name==='reviewer.findings.json' && data.length<=Math.min(16000,remaining)) {
    const clean=scrubCredentials(data);remaining-=clean.length;return [name,clean];
   }
   if(data!==undefined && includeDiagnostics && task.state==='failed' && diagnosticNames.has(name) && remaining>0) {
    const excerpt=scrubCredentials(data).slice(-Math.min(16000,remaining));remaining-=excerpt.length;
    return [name,excerpt];
   }
   return [name,'retained private artifact'];
  }));
  const view:AssessmentTask={...task,artifacts:manifest?{digest:manifestHash(manifest),totalBytes:manifest.totalBytes,fileCount:manifest.files.length,omittedFileCount:paths.length-preview.length}:undefined,
   request:{...task.request,reason:scrubCredentials(task.request.reason)},result:task.result?{...task.result,summary:scrubCredentials(task.result.summary),files}:null};
  // Count JSON escaping and UTF-8 bytes, including the separator in the task array.
  const bytes=Buffer.byteLength(JSON.stringify(view))+1;
  if(bytes>budget.bytes) break;
  budget.bytes-=bytes;budget.diagnosticCharacters=remaining;views.push(view);
 }
 return views;
}

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
  || !value.files || Array.isArray(value.files) || typeof value.files!=='object' || Object.keys(value.files).length>ARTIFACT_LIMITS.files) throw new Error('Invalid task result');
 if(value.dispatcherRevision!==undefined && !/^[a-f0-9]{40}$/.test(value.dispatcherRevision)) throw new Error('Invalid deployed dispatcher revision');
 if(value.candidateRevision!==undefined && !/^[a-f0-9]{40}$/.test(value.candidateRevision)) throw new Error('Invalid checked candidate revision');
 let bytes=0;
 for (const [path,data] of Object.entries(value.files)) {
  validateArtifactPath(path);
  if(typeof data!=='string' || Buffer.from(data).toString('utf8')!==data) throw new Error('Artifact is not exact UTF-8');
  bytes+=Buffer.byteLength(data);
  if (bytes>ARTIFACT_LIMITS.bytes) throw new Error('Task artifacts exceed total bounds');
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
  CREATE TABLE IF NOT EXISTS fleet_capabilities (machine TEXT PRIMARY KEY,record TEXT NOT NULL,updated INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS fleet_task_artifacts (task TEXT PRIMARY KEY,manifest TEXT NOT NULL,digest TEXT NOT NULL,committed INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS fleet_task_chunks (task TEXT NOT NULL,path TEXT NOT NULL,part INTEGER NOT NULL,data BLOB NOT NULL,
   PRIMARY KEY(task,path,part)) STRICT;`);
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
  const artifacts=this.db.prepare('SELECT manifest,committed FROM fleet_task_artifacts WHERE task=?').get(id);
  return {id:String(r.id),ticket:String(r.ticket),request:JSON.parse(String(r.request)),state:r.state as RecoveryTask['state'],
   created:Number(r.created),updated:Number(r.updated),machine:r.machine as string|null,session:r.session as string|null,runId:r.run_id as string|null,result:r.result?JSON.parse(String(r.result)):null,
   ...(artifacts?.committed?{artifacts:JSON.parse(String(artifacts.manifest))}:artifacts?{artifactsPending:true}:{})};
 }
 list(ticket?:string):RecoveryTask[] {
  return (ticket?this.db.prepare('SELECT id FROM fleet_recovery_tasks WHERE ticket=? ORDER BY created DESC LIMIT 50').all(ticket)
   :this.db.prepare('SELECT id FROM fleet_recovery_tasks ORDER BY created DESC LIMIT 500').all()).map(r=>this.get(String(r.id)));
 }
 count(ticket:string):number {
  return Number(this.db.prepare('SELECT COUNT(*) AS count FROM fleet_recovery_tasks WHERE ticket=?').get(ticket)!.count);
 }
 available(machine:string,id:string):boolean {
  const task=this.get(id), host=this.capabilities().find(c=>c.machine===machine);
  const incident=this.db.prepare('SELECT reason,decision,state FROM fleet_recovery WHERE ticket=? AND present=1').get(task.ticket);
  // A read-only provenance assessment never authorises a previously queued task.
  if(incident && (/Explicit operator hold|Denied permission|Pause origin unknown/.test(String(incident.reason))
    || incident.state==='escalated' && incident.decision && JSON.parse(String(incident.decision)).category==='human')) return false;
  return task.state==='queued' && !!host?.ready && this.now()-host.updated<180000 && host.capabilities.includes(task.request.capability);
 }
 begin(id:string,machine:string,session:string,runId:string):void {
  if (!this.available(machine,id)) throw new Error('Task or capability unavailable');
  this.db.prepare("UPDATE fleet_recovery_tasks SET state='running',machine=?,session=?,run_id=?,updated=? WHERE id=? AND state='queued'").run(machine,session,runId,this.now(),id);
 }
 complete(id:string,machine:string,session:string,value:RecoveryTaskResult):RecoveryTask {
  const task=this.get(id);
  if (task.machine!==machine || task.session!==session) throw new Error('Task actor mismatch');
  const result=validateTaskResult(value);
  if (['complete','failed'].includes(task.state)) {
   if (JSON.stringify(task.result)!==JSON.stringify(result)) throw new Error('Completed task result changed');
   return task;
  }
  if (!['running','attention','publishing'].includes(task.state)) throw new Error('Task is not running');
  this.db.prepare('UPDATE fleet_recovery_tasks SET state=?,result=?,updated=? WHERE id=?').run(result.outcome==='completed'?'complete':'failed',JSON.stringify(result),this.now(),id);
  return this.get(id);
 }
 prepareRepair(id:string,machine:string,session:string,publication:unknown):RecoveryTask {
  const task=this.get(id);
  if(task.machine!==machine||task.session!==session||task.request.recipe!=='dispatcher-repair'||!task.runId) throw new Error('Repair actor mismatch');
  const serialized=JSON.stringify(validateRepairPublication(publication));
  if(task.state==='publishing') {
   if(task.result?.files['publication.json']!==serialized) throw new Error('Prepared repair changed');
   return task;
  }
  if(!['running','attention'].includes(task.state)) throw new Error('Repair is not running');
  const result:RecoveryTaskResult={outcome:'completed',summary:'Verified repair prepared; publication and deployment remain pending.',files:{'publication.json':serialized}};
  this.db.prepare("UPDATE fleet_recovery_tasks SET state='publishing',result=?,updated=? WHERE id=?").run(JSON.stringify(result),this.now(),id);
  return this.get(id);
 }
 private artifactOwner(id:string,machine:string,session:string):RecoveryTask {
  const task=this.get(id);
  if(task.machine!==machine || task.session!==session || !task.runId
   || !['running','attention','publishing','complete','failed'].includes(task.state)) throw new Error('Task actor mismatch');
  return task;
 }
 beginArtifacts(id:string,machine:string,session:string,value:ArtifactManifest) {
  this.artifactOwner(id,machine,session);
  const manifest=validateManifest(value),digest=manifestHash(manifest);
  const old=this.db.prepare('SELECT digest FROM fleet_task_artifacts WHERE task=?').get(id);
  if(old && old.digest!==digest) throw new Error('Artifact manifest changed');
  if(!old) this.db.prepare('INSERT INTO fleet_task_artifacts VALUES (?,?,?,0)').run(id,JSON.stringify(manifest),digest);
  const missing=Object.fromEntries(manifest.files.map(file=>[file.path,file.chunks.map((_,i)=>i).filter(i=>{
   const row=this.db.prepare('SELECT data FROM fleet_task_chunks WHERE task=? AND path=? AND part=?').get(id,file.path,i);
   if(!row) return true;
   const data=Buffer.from(row.data as Uint8Array);
   return data.length!==Math.min(ARTIFACT_LIMITS.chunkBytes,file.bytes-i*ARTIFACT_LIMITS.chunkBytes) || sha256(data)!==file.chunks[i];
  })]));
  return {digest,missing};
 }
 putArtifact(id:string,machine:string,session:string,digest:string,path:string,part:number,encoded:string):void {
  this.artifactOwner(id,machine,session);
  const transfer=this.db.prepare('SELECT * FROM fleet_task_artifacts WHERE task=? AND digest=?').get(id,digest);
  if(!transfer) throw new Error('Unknown artifact manifest');
  const manifest:ArtifactManifest=JSON.parse(String(transfer.manifest)),file=manifest.files.find(f=>f.path===path);
  if(!file || !Number.isSafeInteger(part) || part<0 || part>=file.chunks.length
   || typeof encoded!=='string' || encoded.length>Math.ceil(ARTIFACT_LIMITS.chunkBytes/3)*4) throw new Error('Invalid artifact chunk');
  const data=Buffer.from(encoded,'base64');
  if(data.toString('base64')!==encoded || data.length!==Math.min(ARTIFACT_LIMITS.chunkBytes,file.bytes-part*ARTIFACT_LIMITS.chunkBytes)
   || sha256(data)!==file.chunks[part]) throw new Error('Artifact chunk byte/hash mismatch');
  const old=this.db.prepare('SELECT data FROM fleet_task_chunks WHERE task=? AND path=? AND part=?').get(id,path,part);
  if(old && data.equals(Buffer.from(old.data as Uint8Array))) return;
  // The immutable manifest permits restoring a missing or corrupt retained part
  // only with its originally verified bytes. It never changes the task outcome.
  this.db.prepare('INSERT INTO fleet_task_chunks VALUES (?,?,?,?) ON CONFLICT(task,path,part) DO UPDATE SET data=excluded.data').run(id,path,part,data);
 }
 commitArtifacts(id:string,machine:string,session:string,digest:string,value:RecoveryTaskResult):RecoveryTask {
  const task=this.artifactOwner(id,machine,session),result=validateTaskResult(value);
  const terminal=['complete','failed'].includes(task.state);
  if(Object.keys(result.files).length) throw new Error('Artifact commit requires manifest-backed files');
  const transfer=this.db.prepare('SELECT * FROM fleet_task_artifacts WHERE task=? AND digest=?').get(id,digest);
  if(!transfer) throw new Error('Unknown artifact manifest');
  // Recovery can attach retained evidence; the original terminal result is immutable.
  if(terminal && (task.result?.outcome!==result.outcome || task.result?.summary!==result.summary
   || task.result?.dispatcherRevision!==result.dispatcherRevision || task.result?.candidateRevision!==result.candidateRevision)) throw new Error('Completed task result changed');
  const manifest:ArtifactManifest=JSON.parse(String(transfer.manifest));
  for(const file of manifest.files) {
   const parts=file.chunks.map((hash,i)=>{
    const row=this.db.prepare('SELECT data FROM fleet_task_chunks WHERE task=? AND path=? AND part=?').get(id,file.path,i);
    if(!row) throw new Error('Artifact chunk missing');
    const bytes=Buffer.from(row.data as Uint8Array);
    if(bytes.length!==Math.min(ARTIFACT_LIMITS.chunkBytes,file.bytes-i*ARTIFACT_LIMITS.chunkBytes) || sha256(bytes)!==hash) throw new Error('Artifact chunk byte/hash mismatch');
    return bytes;
   });
   const data=Buffer.concat(parts),text=data.toString('utf8');
   if(data.length!==file.bytes || sha256(data)!==file.sha256 || !Buffer.from(text).equals(data)) throw new Error('Artifact byte/hash or UTF-8 mismatch');
   // Check complete reconstructed content: secrets may span any chunk boundary.
   if(scrubCredentials(text)!==text) throw new Error('Artifact contains credential-shaped text; retain it privately and return a sanitised diagnostic');
   if(terminal && task.result && Object.hasOwn(task.result.files,file.path) && task.result.files[file.path]!==text) throw new Error('Retained artifact changed');
  }
  if(terminal && task.result && Object.keys(task.result.files).some(path=>!manifest.files.some(f=>f.path===path))) throw new Error('Retained artifact inventory incomplete');
  if(!terminal) this.complete(id,machine,session,result);
  this.db.prepare('UPDATE fleet_task_artifacts SET committed=1 WHERE task=?').run(id);
  return this.get(id);
 }
 manifest(id:string):ArtifactManifest|undefined {
  const task=this.get(id);
  return task.artifacts ?? (!task.artifactsPending && task.result?artifactManifest(task.result.files):undefined);
 }
 artifact(id:string,digest:string,path:string,part:number) {
  const task=this.get(id),manifest=this.manifest(id),file=manifest?.files.find(f=>f.path===path);
  if(!manifest || manifestHash(manifest)!==digest || !file || !Number.isSafeInteger(part) || part<0 || part>=file.chunks.length) throw new Error('Unknown artifact chunk');
  const row=task.artifacts?this.db.prepare('SELECT data FROM fleet_task_chunks WHERE task=? AND path=? AND part=?').get(id,path,part):undefined;
  const data=task.artifacts?(row?Buffer.from(row.data as Uint8Array):undefined):task.result&&Object.hasOwn(task.result.files,path)
   ? Buffer.from(task.result.files[path]).subarray(part*ARTIFACT_LIMITS.chunkBytes,(part+1)*ARTIFACT_LIMITS.chunkBytes):undefined;
  if(!data || data.length!==Math.min(ARTIFACT_LIMITS.chunkBytes,file.bytes-part*ARTIFACT_LIMITS.chunkBytes) || sha256(data)!==file.chunks[part]) throw new Error('Artifact chunk missing or corrupt');
  return {digest,path,part,bytes:data.length,sha256:sha256(data),data:data.toString('base64')};
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
  return terminal.length?createHash('sha256').update(JSON.stringify(terminal.map(t=>[t.id,t.state,t.result,...(t.artifacts?[manifestHash(t.artifacts)]:[])]))).digest('hex'):undefined;
 }
}
