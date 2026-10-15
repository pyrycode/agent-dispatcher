import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,statSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {scrubCredentials} from './agent-runtime.js';

interface ReleaseRequest {commandId:string;revision:string;expected:string|null;reason:string}
export interface ReleaseRecord extends ReleaseRequest {state:'pending'|'complete';backup:string;at:string}
const SHA=/^[a-f0-9]{40}$/;
function validate(value:ReleaseRequest):ReleaseRequest {
 if(!value || typeof value.commandId!=='string' || !/^[\w.-]{1,100}$/.test(value.commandId) || !SHA.test(value.revision) || value.expected!==null&&!SHA.test(value.expected)
  || typeof value.reason!=='string' || !value.reason.trim() || value.reason.length>2000
  || Object.keys(value).some(k=>!['commandId','revision','expected','reason'].includes(k))) throw new Error('A release needs its command id, exact revision, expected target and reason');
 return {commandId:value.commandId,revision:value.revision,expected:value.expected,reason:scrubCredentials(value.reason.trim())};
}

/** One audited controller release. This class never signals or starts a service. */
export class FleetReleases {
 constructor(private db:DatabaseSync,private now=Date.now) {
  db.exec("CREATE TABLE IF NOT EXISTS fleet_releases (id TEXT PRIMARY KEY,request TEXT NOT NULL,state TEXT NOT NULL,backup TEXT NOT NULL,created INTEGER NOT NULL) STRICT; CREATE UNIQUE INDEX IF NOT EXISTS fleet_one_release ON fleet_releases(state) WHERE state='pending';");
 }
 private target():string|null {return this.db.prepare('SELECT revision FROM fleet_control_target WHERE singleton=1').get()?.revision as string??null;}
 list():ReleaseRecord[] {
  return this.db.prepare('SELECT * FROM fleet_releases ORDER BY created,id').all().map(row=>({...JSON.parse(String(row.request)),state:row.state,backup:String(row.backup),
   at:new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Helsinki',dateStyle:'short',timeStyle:'long'}).format(Number(row.created))}));
 }
 private previous(request:ReleaseRequest):ReleaseRecord|undefined {
  const row=this.db.prepare('SELECT request FROM fleet_releases WHERE id=?').get(request.commandId);
  if(!row) return undefined;
  if(row.request!==JSON.stringify(request)) throw new Error('Release command id reused with different content');
  return this.list().find(r=>r.commandId===request.commandId);
 }
 private ready(request:ReleaseRequest):void {
  if(this.db.prepare("SELECT 1 FROM fleet_releases WHERE state='pending'").get()) throw new Error('Another release is still in progress');
  if(this.target()!==request.expected) throw new Error('Controller target changed. Read it again before proposing another release');
  if(request.revision===request.expected) throw new Error('The requested controller target is already selected');
 }
 begin(value:ReleaseRequest,directory:string):ReleaseRecord {
  const request=validate(value),old=this.previous(request);
  if(old) return old;
  this.ready(request);
  mkdirSync(directory,{recursive:true,mode:0o700});
  if(statSync(directory).mode&0o077) throw new Error('Release backup directory must be private');
  const backup=join(directory,createHash('sha256').update(JSON.stringify(request)).digest('hex')+'-'+randomUUID()+'.sqlite');
  this.db.prepare('VACUUM INTO ?').run(backup);
  chmodSync(backup,0o600);
  const copy=new DatabaseSync(backup,{readOnly:true});
  try {if(copy.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok') throw new Error('Release backup failed its integrity check');}
  finally {copy.close();}
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const replay=this.previous(request);
   if(replay) {this.db.exec('COMMIT');return replay;}
   this.ready(request);
   this.db.prepare("INSERT INTO fleet_releases VALUES (?,?,'pending',?,?)").run(request.commandId,JSON.stringify(request),backup,this.now());
   this.db.prepare('INSERT INTO fleet_control_target VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision').run(request.revision);
   this.db.exec('COMMIT');
  } catch(error) {this.db.exec('ROLLBACK');throw error;}
  return this.list().find(r=>r.commandId===request.commandId)!;
 }
 complete(id:string,centralLoaded:string|undefined,machines:string[]):ReleaseRecord {
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const release=this.list().find(r=>r.commandId===id);
   if(!release) throw new Error('Unknown release');
   if(release.state==='complete') {this.db.exec('COMMIT');return release;}
   if(this.target()!==release.revision || centralLoaded!==release.revision || machines.some(m=>this.db.prepare('SELECT revision FROM fleet_control_ready WHERE machine=?').get(m)?.revision!==release.revision)) throw new Error('Every configured controller must report the selected revision before completing a release');
   this.db.prepare("UPDATE fleet_releases SET state='complete' WHERE id=? AND state='pending'").run(id);
   this.db.exec('COMMIT');
   return {...release,state:'complete'};
  } catch(error) {this.db.exec('ROLLBACK');throw error;}
 }
}
