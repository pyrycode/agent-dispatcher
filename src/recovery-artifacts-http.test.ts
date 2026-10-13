import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FleetStore} from './fleet-store.js';
import {FleetClient,JsonClient,serveFleet} from './fleet-http.js';
import {MachineManager,serveManager} from './machine-manager.js';
import {ARTIFACT_LIMITS,artifactManifest,manifestHash} from './recovery-artifacts.js';
import type {RecoveryTaskResult} from './recovery-tasks.js';

const ticket='org/core#2939';
const request={recipe:'android-tool-then-text' as const,capability:'android-emulator' as const,revision:'a'.repeat(40),reason:'Retained diagnostic recording'};
const diagnosticFiles=Object.fromEntries(['reviewer.findings.json',...['helpers','typecheck','test','install','reviewer','builder'].map(n=>n+'.diagnostic.log')]
 .map(name=>[name,name.endsWith('.json')?'\u007b"decision":"FAIL","findings":"Retain custody"}':name+' failed']));

async function fixture(t:TestContext) {
 const directory=mkdtempSync(join(tmpdir(),'task-rpc-'));
 const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:2},hp:{heavyLimit:1,combinedLimit:2}});
 const authority=await serveFleet(store,{box:'box-token',hp:'hp-token'},'admin-token',0);
 const address=authority.address();assert.ok(address&&typeof address!=='string');
 const manager=new MachineManager({machine:'box',projects:['org/core'],heavyLimit:1,combinedLimit:2},new FleetClient('http://127.0.0.1:'+address.port,'box-token'));
 const socket=join(directory,'manager.sock');
 const local=await serveManager(manager,{'org/core':'project-token'},'local-admin-token',socket);
 t.after(async()=>{await new Promise<void>(r=>local.close(()=>r()));await new Promise<void>(r=>authority.close(()=>r()));store.close();rmSync(directory,{recursive:true});});
 store.tasks.report('hp',{capabilities:['android-emulator'],ready:true});
 assert.equal(store.start({id:'assessment',machine:'box',session:'s',project:'org/core',ticket,role:'recovery',resource:'heavy',locks:[]}).ok,true);
 return {store,client:new JsonClient('unix://'+socket,'project-token'),actor:{project:'org/core',session:'s',runId:'assessment'}};
}

function complete(store:FleetStore,source:string,context:string,result:RecoveryTaskResult,chunked:boolean) {
 const task=store.tasks.request(source,request,context),session='capture-'+context;
 assert.equal(store.taskStart('hp',task.id,session).ok,true);
 if(!chunked) {store.taskComplete('hp',task.id,session,result);return task.id;}
 const manifest=artifactManifest(result.files),{digest,missing}=store.tasks.beginArtifacts(task.id,'hp',session,manifest);
 for(const file of manifest.files) for(const part of missing[file.path]) {
  const data=Buffer.from(result.files[file.path]).subarray(part*ARTIFACT_LIMITS.chunkBytes,(part+1)*ARTIFACT_LIMITS.chunkBytes);
  store.tasks.putArtifact(task.id,'hp',session,digest,file.path,part,data.toString('base64'));
 }
 store.commitTaskArtifacts('hp',task.id,session,digest,{...result,files:{}});
 return task.id;
}

test('four valid 1024-file inventories fit the actual Unix assessment response',async t=>{
 const {store,client,actor}=await fixture(t);
 const files={...diagnosticFiles,...Object.fromEntries(Array.from({length:1024-Object.keys(diagnosticFiles).length},(_,i)=>{
  const prefix='mobile/'+i.toString().padStart(4,'0')+'-';
  return [prefix+'r'.repeat(240-prefix.length-5)+'.json',''];
 }))};
 const manifest=artifactManifest(files),digest=manifestHash(manifest);
 assert.equal(manifest.files.length,1024);
 const ids=Array.from({length:4},(_,i)=>complete(store,ticket,'inventory-'+i,{outcome:'failed',summary:'Original capture failed',files},true));
 const [facts]=await client.call<any[]>('/recovery/facts',{...actor,tickets:[ticket]});
 assert.ok(Buffer.byteLength(JSON.stringify([facts]))<1024*1024);
 assert.equal(facts.tasks.length,4);
 for(const task of facts.tasks) {
  assert.ok(ids.includes(task.id));
  assert.equal(task.artifacts.digest,digest);assert.equal(task.artifacts.fileCount,1024);assert.equal(task.artifacts.totalBytes,manifest.totalBytes);
  assert.ok(task.artifacts.omittedFileCount>0);
  assert.equal(Object.keys(task.result.files).length+task.artifacts.omittedFileCount,1024);
  assert.equal(task.result.files['reviewer.findings.json'],diagnosticFiles['reviewer.findings.json']);
  assert.equal(task.result.files['helpers.diagnostic.log'],diagnosticFiles['helpers.diagnostic.log']);
 }
 const read=await client.call<any>('/tasks/read',{...actor,id:ids[0],format:'manifest-v1'});
 assert.deepEqual(read.artifacts,manifest,'complete inventory remains available through the admitted manifest endpoint');
});

test('aggregate history and related-ticket metadata share the Unix response budget',async t=>{
 const {store,client,actor}=await fixture(t),related=['org/core#99','org/core#100','org/core#101'];
 for(const source of [ticket,...related]) for(let i=0;i<55;i++) complete(store,source,source+'-'+i,{
  outcome:'failed',summary:'\u0000"\\é'.repeat(4000),files:diagnosticFiles,
 },false);
 // The owning assessment must retain diagnostics even when related tickets were requested first.
 const facts=await client.call<any[]>('/recovery/facts',{...actor,tickets:[...related,ticket]});
 assert.ok(Buffer.byteLength(JSON.stringify(facts))<1024*1024);
 const owned=facts.find(f=>f.ticket===ticket);assert.ok(owned.tasks.length>0);
 assert.equal(owned.tasks[0].result.files['reviewer.findings.json'],diagnosticFiles['reviewer.findings.json']);
 for(const fact of facts) {
  assert.equal(fact.taskHistory.totalCount,55);assert.equal(fact.taskHistory.returnedCount,fact.tasks.length);
  assert.equal(fact.taskHistory.omittedCount,55-fact.tasks.length);
  if(fact.ticket!==ticket) for(const task of fact.tasks) assert.equal(task.result.files['helpers.diagnostic.log'],'retained private artifact');
 }
 assert.ok(facts.some(f=>f.taskHistory.omittedCount>5),'aggregate byte bound is explicit beyond the existing 50-task history cap');
});

for(const chunked of [false,true]) test('exact legacy and manifest retrieval of prototype filenames ('+(chunked?'chunks':'legacy')+')',async t=>{
 const {store,client,actor}=await fixture(t);
 const files=Object.fromEntries(['__proto__','constructor','toString'].map(name=>[name,name+'\r\né\n']));
 const id=complete(store,ticket,'prototype',{outcome:'failed',summary:'Original failed outcome',files},chunked);
 const legacy=await client.call<any>('/tasks/read',{...actor,id});
 assert.deepEqual(legacy.result.files,files);
 const task=await client.call<any>('/tasks/read',{...actor,id,format:'manifest-v1'}),digest=manifestHash(task.artifacts);
 for(const file of task.artifacts.files) {
  const chunk=await client.call<any>('/tasks/artifact',{...actor,id,digest,path:file.path,part:0});
  assert.equal(Buffer.from(chunk.data,'base64').toString(),files[file.path]);
 }
 const [facts]=await client.call<any[]>('/recovery/facts',{...actor,tickets:[ticket]});
 for(const path of Object.keys(files)) assert.equal(facts.tasks[0].result.files[path],'retained private artifact');
 assert.equal(facts.tasks[0].artifacts.fileCount,3);
});
