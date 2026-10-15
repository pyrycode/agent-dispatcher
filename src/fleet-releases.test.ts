import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {FleetStore} from './fleet-store.js';
import {JsonClient,serveFleet} from './fleet-http.js';
const old='a'.repeat(40),next='b'.repeat(40);
const request={commandId:'reviewed-release-1',revision:next,expected:old,reason:'Juhana approved this exact source'};

test('one checked release backs up before selection and preserves desired controls',()=>{
 const root=mkdtempSync(join(tmpdir(),'release-test-'));
 const store=new FleetStore(join(root,'claims.sqlite'),{box:{heavyLimit:1,combinedLimit:1}});
 try {
  store.controlTarget(old);
  store.desired.set({machines:['box'],change:{work:'drained'},reason:'Keep this restriction'});
  const controls=store.desired.document('box');
  const release=store.releases.begin(request,join(root,'backups'));
  assert.equal(store.controlTarget(),next);assert.equal(release.state,'pending');
  assert.equal(statSync(release.backup).mode&0o777,0o600);
  const backup=new DatabaseSync(release.backup,{readOnly:true});
  try {assert.equal(backup.prepare('SELECT revision FROM fleet_control_target').get()?.revision,old);}
  finally {backup.close();}
  assert.deepEqual(store.releases.begin(request,join(root,'backups')),release);
  assert.throws(()=>store.releases.begin({...request,reason:'A different request'},join(root,'backups')),/reused/);
  assert.throws(()=>store.releases.begin({...request,commandId:'competing'},join(root,'backups')),/progress/);
  assert.throws(()=>store.releases.complete(request.commandId,next,['box']),/Every configured/);
  store.recordControlReady('box',next);
  assert.throws(()=>store.releases.complete(request.commandId,old,['box']),/Every configured/);
  assert.equal(store.releases.complete(request.commandId,next,['box']).state,'complete');
  assert.equal(store.releases.complete(request.commandId,next,['box']).state,'complete');
  assert.deepEqual(store.desired.document('box'),controls);
  assert.throws(()=>store.releases.begin({...request,commandId:'stale'},join(root,'backups')),/target changed/);
 } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test('backup refusal and invalid requests cannot select a target',()=>{
 const root=mkdtempSync(join(tmpdir(),'release-refusal-'));
 const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:1}});
 try {
  store.controlTarget(old);const blocked=join(root,'file');writeFileSync(blocked,'keep');
  assert.throws(()=>store.releases.begin(request,blocked));
  for(const value of [{...request,expected:undefined},{...request,commandId:123},{...request,revision:'main'},{...request,extra:'bad'}]) assert.throws(()=>store.releases.begin(value as any,root));
  assert.equal(store.controlTarget(),old);assert.deepEqual(store.releases.list(),[]);
 } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test('release changes require the operator and a configured private backup directory',async t=>{
 const root=mkdtempSync(join(tmpdir(),'release-http-'));
 const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:1}});store.controlTarget(old);
 const server=await serveFleet(store,{box:'machine-test'},'operator-test',0,'127.0.0.1',undefined,undefined,undefined,undefined,old,undefined,join(root,'backups'));
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const base='http://127.0.0.1:'+address.port;
 const machine=new JsonClient(base,'machine-test'),operator=new JsonClient(base,'operator-test');
 await assert.rejects(machine.call('/operations/release',request),/403/);
 await assert.rejects(machine.call('/operations/releases'),/403/);
 const release=await operator.call<any>('/operations/release',request);assert.equal(release.revision,next);
 await assert.rejects(machine.call('/operations/release-complete',{commandId:request.commandId}),/403/);
 assert.equal((await operator.call<any[]>('/operations/releases')).length,1);
});
