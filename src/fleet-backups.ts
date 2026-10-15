import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,lstatSync,chmodSync,openSync,readSync,closeSync,writeFileSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export function backupFileHash(path:string):{sha256:string;bytes:number} {
 const fd=openSync(path,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let bytes=0;
 try {for(;;) {const count=readSync(fd,buffer,0,buffer.length,null);if(!count) break;hash.update(buffer.subarray(0,count));bytes+=count;}}
 finally {closeSync(fd);}
 return {sha256:hash.digest('hex'),bytes};
}
/** Called synchronously by the sole writer of both databases. Never yield between snapshots. */
export function snapshotFleet(directory:string,claims:DatabaseSync,evidenceSnapshot:(path:string)=>void,now=Date.now()) {
  if(claims.isTransaction) throw new Error('Cannot back up inside another transaction');
  const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});
  if(lstatSync(root).isSymbolicLink() || (lstatSync(root).mode&0o077)!==0) throw new Error('Backup directory must be private and cannot be a link');
  const stage=mkdtempSync(join(root,'.pending-'));chmodSync(stage,0o700);
  // Failed snapshots remain private and unsealed for operator investigation.
  evidenceSnapshot(join(stage,'evidence.sqlite'));
  claims.exec("VACUUM INTO '"+join(stage,'claims.sqlite').replaceAll("'","''")+"'");
  const files:Record<string,{sha256:string;bytes:number}>={};
  for(const name of ['claims.sqlite','evidence.sqlite']) {
    const path=join(stage,name);chmodSync(path,0o600);
    const db=new DatabaseSync(path,{readOnly:true});
    try {if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok') throw new Error('Backup integrity check failed');}
    finally {db.close();}
    files[name]=backupFileHash(path);
  }
  const manifest={version:1,createdAt:new Date(now).toLocaleString('sv-SE',{timeZone:'Europe/Helsinki'})+' Europe/Helsinki',created:now,files};
  writeFileSync(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
  const destination=join(root,'fleet-'+now+'-'+randomUUID());renameSync(stage,destination);
  return {directory:destination,manifest};
}
