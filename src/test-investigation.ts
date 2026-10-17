import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {EvidenceStore} from './evidence-store.js';
import {validateArtifactPath} from './recovery-artifacts.js';
import {scrubCredentials} from './agent-runtime.js';

export interface TestInvestigationRequest {
 revision:string;
 failedTests:string[];
 evidence:Array<{runId:string;digest:string;path:string}>;
 scope:{kind:'tests'|'class'|'package'|'sequence'|'suite';selectors:string[]};
 narrowerInsufficient:string;
}
export interface TestInvestigation {
 id:string;ticket:string;runId:string;machine:string;created:number;request:TestInvestigationRequest;
}
const HASH=/^[a-f0-9]{64}$/;
function keys(value:unknown, names:string[]):value is Record<string,any> {
 return !!value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).length===names.length && Object.keys(value).every(k=>names.includes(k));
}
function text(value:unknown,max:number):value is string {
 return typeof value==='string' && !!value.trim() && value.length<=max
  && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && scrubCredentials(value)===value;
}
export function validateInvestigation(value:unknown):TestInvestigationRequest {
 if(!keys(value,['revision','failedTests','evidence','scope','narrowerInsufficient'])
  || typeof value.revision!=='string' || !/^[a-f0-9]{40}$/.test(value.revision)
  || !Array.isArray(value.failedTests) || !value.failedTests.length || value.failedTests.length>16
  || value.failedTests.some((s:unknown)=>!text(s,512))
  || !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length>8
  || !keys(value.scope,['kind','selectors']) || !['tests','class','package','sequence','suite'].includes(value.scope.kind)
  || !Array.isArray(value.scope.selectors) || value.scope.selectors.length>16
  || (value.scope.kind==='suite' ? value.scope.selectors.length!==0 : !value.scope.selectors.length)
  || value.scope.selectors.some((s:unknown)=>!text(s,512) || /[*?]/.test(s) || ['.','./...','...','all'].includes(s))
  || !text(value.narrowerInsufficient,2000) || Buffer.byteLength(JSON.stringify(value))>8192)
  throw new Error('Invalid investigation request; retain failed tests, evidence, exact revision and bounded scope');
 for(const ref of value.evidence) {
  if(!keys(ref,['runId','digest','path']) || typeof ref.runId!=='string' || !/^[\w.:@-]{1,128}$/.test(ref.runId)
   || typeof ref.digest!=='string' || !HASH.test(ref.digest)) throw new Error('Invalid investigation evidence identity');
  validateArtifactPath(ref.path);
 }
 return {revision:value.revision,failedTests:[...value.failedTests],
  evidence:value.evidence.map((e:any)=>({runId:e.runId,digest:e.digest,path:e.path})),
  scope:{kind:value.scope.kind,selectors:[...value.scope.selectors]},narrowerInsufficient:value.narrowerInsufficient};
}

/** Requests ask for assessment, never authorise or start test execution. */
export class TestInvestigations {
 constructor(private db:DatabaseSync, private now=Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_test_investigations (
   id TEXT PRIMARY KEY, ticket TEXT NOT NULL, run_id TEXT NOT NULL, created INTEGER NOT NULL,
   record TEXT NOT NULL, incident TEXT, assessed INTEGER
  ) STRICT;`);
 }
 request(ticket:string,runId:string,machine:string,value:unknown,evidence?:Pick<EvidenceStore,'list'>) {
  const request=validateInvestigation(value);
  const id=createHash('sha256').update(JSON.stringify([ticket,runId,request])).digest('hex');
  const receipt={status:'assessment-queued' as const,id,executed:0 as const};
  if(this.db.prepare('SELECT 1 FROM fleet_test_investigations WHERE id=?').get(id)) return receipt;
  if(!evidence) throw new Error('Retained run evidence store unavailable; investigation was not queued');
  for(const ref of request.evidence) {
   const bundle=evidence.list(ticket,ref.runId).find(b=>b.digest===ref.digest);
   if(!bundle || !bundle.manifest.files.some(f=>f.path===ref.path && f.bytes>0))
    throw new Error('Investigation evidence must name a nonempty file in a committed bundle for this ticket');
  }
  const record:TestInvestigation={id,ticket,runId,machine,created:this.now(),request};
  this.db.prepare('INSERT INTO fleet_test_investigations VALUES (?,?,?,?,?,NULL,NULL)')
   .run(id,ticket,runId,record.created,JSON.stringify(record));
  return receipt;
 }
 pending(ticket:string):TestInvestigation|undefined {
  const row=this.db.prepare('SELECT record FROM fleet_test_investigations WHERE ticket=? AND assessed IS NULL ORDER BY created,id LIMIT 1').get(ticket);
  return row?JSON.parse(String(row.record)):undefined;
 }
 begin(ticket:string,incident:string):void {
  const pending=this.pending(ticket);
  if(pending) this.db.prepare('UPDATE fleet_test_investigations SET incident=? WHERE id=? AND assessed IS NULL').run(incident,pending.id);
 }
 complete(incident:string):void {
  this.db.prepare('UPDATE fleet_test_investigations SET assessed=? WHERE incident=? AND assessed IS NULL').run(this.now(),incident);
 }
}
