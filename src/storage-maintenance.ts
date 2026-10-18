import type {DatabaseSync} from 'node:sqlite';

export interface StorageRequest {
  id: string; machine: string; kind: 'ticket'|'cache'|'native-task'; ticket?: string; path: string; head?: string; taskId?:string; referenceDigest?:string; artifactDigest?:string;
}
export interface StorageLease extends StorageRequest { basis: string; created: number; finished: number|null }

/** Sticky admission exclusion. Never expires while a filesystem command may still run. */
export class StorageMaintenance {
  constructor(private db:DatabaseSync,private now:()=>number) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_storage_maintenance (
      id TEXT PRIMARY KEY, machine TEXT NOT NULL, ticket TEXT, request TEXT NOT NULL,
      basis TEXT NOT NULL, created INTEGER NOT NULL, finished INTEGER, result TEXT
    ) STRICT`);
    db.exec('CREATE TABLE IF NOT EXISTS fleet_native_storage_references (task TEXT NOT NULL,digest TEXT NOT NULL,artifact TEXT NOT NULL,PRIMARY KEY(task,digest,artifact)) STRICT');
  }
  private validate(value:StorageRequest):void {
    if(!value || !/^[a-f0-9-]{36}$/.test(value.id??'') || !/^[\w.-]{1,100}$/.test(value.machine??'')
      || !['ticket','cache','native-task'].includes(value.kind) || typeof value.path!=='string' || !value.path.startsWith('/')
      || value.path.length>4096 || value.path.includes('\0') || value.path.split('/').includes('..')) throw new Error('Invalid storage maintenance request');
    if(value.kind!=='cache' && (!/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(value.ticket??'') || !/^[a-f0-9]{40}$/.test(value.head??''))) throw new Error('Storage cleanup requires an exact ticket and commit');
    if(value.kind==='cache' && (value.ticket!==undefined || value.head!==undefined)) throw new Error('Cache maintenance is machine scoped');
    if(value.kind==='native-task' ? !/^[a-f0-9]{64}$/.test(value.taskId??'') || !/^[a-f0-9]{64}$/.test(value.referenceDigest??'') || !/^[a-f0-9]{64}$/.test(value.artifactDigest??'') : value.taskId!==undefined || value.referenceDigest!==undefined || value.artifactDigest!==undefined) throw new Error('Native storage requires an exact task and dependency reference');
    if(Object.keys(value).some(k=>!['id','machine','kind','ticket','path','head','taskId','referenceDigest','artifactDigest'].includes(k))) throw new Error('Unknown storage request field');
  }
  active():StorageLease[] {
    return this.db.prepare('SELECT * FROM fleet_storage_maintenance WHERE finished IS NULL ORDER BY created,id').all().map(r=>({...JSON.parse(String(r.request)),basis:String(r.basis),created:Number(r.created),finished:null}));
  }
  get(id:string):StorageLease {
    const r=this.db.prepare('SELECT * FROM fleet_storage_maintenance WHERE id=?').get(id);
    if(!r)throw new Error('Unknown storage lease');
    return {...JSON.parse(String(r.request)),basis:String(r.basis),created:Number(r.created),finished:r.finished===null?null:Number(r.finished)};
  }
  blocks(machine:string,ticket:string,parentTicket?:string,taskId?:string):boolean {
    return this.active().some(l=>l.kind==='cache' && l.machine===machine || l.kind==='ticket' && [ticket,parentTicket].includes(l.ticket) || l.kind==='native-task' && l.taskId===taskId);
  }
  acquire(request:StorageRequest,basis:()=>string):StorageLease {
    this.validate(request);
    request=this.canonical(request);
    const prior=this.db.prepare('SELECT request FROM fleet_storage_maintenance WHERE id=?').get(request.id);
    if(prior) {
      if(String(prior.request)!==JSON.stringify(request))throw new Error('Storage lease identity reused with different contents');
      return this.verify(request.id,request.machine,basis);
    }
    if(this.active().some(l=>l.machine===request.machine && (l.kind==='cache'||request.kind==='cache') || request.ticket!==undefined && l.ticket===request.ticket && (l.kind==='ticket'||request.kind==='ticket') || l.kind==='native-task' && request.kind==='native-task' && (l.taskId===request.taskId || l.path===request.path))) throw new Error('Storage scope already held');
    const snapshot=basis();
    this.db.prepare('INSERT INTO fleet_storage_maintenance VALUES (?,?,?,?,?,?,NULL,NULL)').run(request.id,request.machine,request.ticket??null,JSON.stringify(request),snapshot,this.now());
    return this.get(request.id);
  }
  verify(id:string,machine:string,basis:()=>string):StorageLease {
    const lease=this.get(id);
    if(lease.machine!==machine || lease.finished!==null)throw new Error('Storage lease is not active for this machine');
    if(lease.basis!==basis())throw new Error('Storage scope changed; cleanup must stop');
    return lease;
  }
  finish(id:string,machine:string,drained:unknown,result:unknown):StorageLease {
    const lease=this.get(id);
    if(lease.machine!==machine || drained!==true)throw new Error('Storage release requires matching machine and confirmed command drainage');
    if(lease.finished!==null)return lease;
    if(!['complete','held','aborted'].includes(String(result)))throw new Error('Invalid storage completion');
    this.db.prepare('UPDATE fleet_storage_maintenance SET finished=?,result=? WHERE id=? AND finished IS NULL').run(this.now(),String(result),id);
    return this.get(id);
  }
  /** Persist cancellation even before a delayed acquisition reaches authority. */
  cancel(request:StorageRequest,drained:unknown):StorageLease {
    this.validate(request);
    if(drained!==true)throw new Error('Storage cancellation requires confirmed command drainage');
    request=this.canonical(request);
    const prior=this.db.prepare('SELECT request FROM fleet_storage_maintenance WHERE id=?').get(request.id);
    if(prior) {
      if(String(prior.request)!==JSON.stringify(request))throw new Error('Storage cancellation identity differs from acquisition');
      return this.finish(request.id,request.machine,true,'aborted');
    }
    const at=this.now();
    this.db.prepare('INSERT INTO fleet_storage_maintenance VALUES (?,?,?,?,?,?,?,?)').run(request.id,request.machine,request.ticket??null,JSON.stringify(request),'cancelled-before-acquisition',at,at,'aborted');
    return this.get(request.id);
  }
  attest(request:StorageRequest,basis:()=>string):{taskId:string;referenceDigest:string;artifactDigest:string} {
    this.validate(request);
    if(request.kind!=='native-task')throw new Error('Only a native dependency reference can be attested');
    basis();
    this.db.prepare('INSERT OR IGNORE INTO fleet_native_storage_references VALUES (?,?,?)').run(request.taskId!,request.referenceDigest!,request.artifactDigest!);
    return {taskId:request.taskId!,referenceDigest:request.referenceDigest!,artifactDigest:request.artifactDigest!};
  }
  attested(request:StorageRequest):boolean {
    return !!this.db.prepare('SELECT 1 FROM fleet_native_storage_references WHERE task=? AND digest=? AND artifact=?').get(request.taskId!,request.referenceDigest!,request.artifactDigest!);
  }
  private canonical(r:StorageRequest):StorageRequest {
    return {id:r.id,machine:r.machine,kind:r.kind,path:r.path,...(r.ticket!==undefined?{ticket:r.ticket,head:r.head}:{}),...(r.kind==='native-task'?{taskId:r.taskId,referenceDigest:r.referenceDigest,artifactDigest:r.artifactDigest}:{})};
  }
}
