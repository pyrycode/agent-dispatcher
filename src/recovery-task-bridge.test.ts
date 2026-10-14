import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FleetStore} from './fleet-store.js';
import {serveFleet,FleetClient,JsonClient} from './fleet-http.js';
import {MachineManager,serveManager} from './machine-manager.js';
import {taskBridge} from './recovery-task-bridge.js';
import {ARTIFACT_LIMITS,artifactManifest,manifestHash,sha256} from './recovery-artifacts.js';

const execute=promisify(execFile);
for(const capability of ['linux-amd64','macos-arm64'] as const) {
 test(`the Python helper retrieves unchanged installer and owner records for ${capability}`,async t=>{
  const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:2},native:{heavyLimit:1,combinedLimit:2}});
  const authority=await serveFleet(store,{box:'box-token',native:'native-token'},'admin-token',0);
  const address=authority.address();assert.ok(address&&typeof address!=='string');
  const manager=new MachineManager({machine:'box',projects:['org/core'],heavyLimit:1,combinedLimit:2},new FleetClient('http://127.0.0.1:'+address.port,'box-token'));
  const local=await serveManager(manager,{'org/core':'project-token'},'local-admin-token',0);
  const localAddress=local.address();assert.ok(localAddress&&typeof localAddress!=='string');
  const source={id:'builder',machine:'box',session:'s',project:'org/core',ticket:'org/core#3290',role:'builder',resource:'medium' as const,locks:[]};
  assert.equal(store.start(source).ok,true);
  const run=store.snapshot().runs.find(r=>r.id===source.id)!;
  const bridge=await taskBridge(new JsonClient('http://127.0.0.1:'+localAddress.port,'project-token'),run);
  const directory=mkdtempSync(join(tmpdir(),'memory-task-client-'));
  t.after(async()=>{await bridge.close();await new Promise<void>(r=>local.close(()=>r()));await new Promise<void>(r=>authority.close(()=>r()));store.close();rmSync(directory,{recursive:true});});
  const request={recipe:'memory-runtime-smoke' as const,capability,revision:'b'.repeat(40),reason:'Installer and owner evidence from the full pushed product candidate'};
  const file=join(directory,'request.json');writeFileSync(file,JSON.stringify(request));
  const helper=fileURLToPath(new URL('../scripts/fleet-task.py',import.meta.url));
  const env={PATH:process.env.PATH,PYRY_TASK_SOCKET:bridge.socket};
  const call=async(...args:string[])=>JSON.parse((await execute('python3',[helper,...args],{env})).stdout);
  const task=await call('request',file);
  assert.equal(task.ticket,source.ticket);assert.deepEqual(task.request,request);assert.equal(task.state,'queued');
  assert.equal((await call('request',file)).id,task.id);
  store.tasks.report('native',{capabilities:[capability],ready:true});
  assert.equal(store.taskStart('native',task.id,'smoke').ok,true);
  const records={'smoke.json':'{ "executed": 2, "passed": 2, "suite": "installer" }\r\n',
                 'memory-owner.json':'{ "executed": 3, "passed": 3, "suite": "owner" }\r\n'};
  const manifest=artifactManifest(records),digest=manifestHash(manifest);
  const native=new JsonClient('http://127.0.0.1:'+address.port,'native-token');
  const actor={id:task.id,session:'smoke'};
  const begin=await native.call<{digest:string;missing:Record<string,number[]>}>('/tasks/artifacts-begin',{...actor,manifest});
  assert.equal(begin.digest,digest);
  for(const entry of manifest.files) for(const part of begin.missing[entry.path]) await native.call('/tasks/artifacts-put',{...actor,digest,path:entry.path,part,
   data:Buffer.from(records[entry.path as keyof typeof records]).subarray(part*ARTIFACT_LIMITS.chunkBytes,(part+1)*ARTIFACT_LIMITS.chunkBytes).toString('base64')});
  await native.call('/tasks/artifacts-commit',{...actor,digest,result:{outcome:'completed',summary:'Installer and owner checks passed',files:{}}});
  const output=join(directory,'evidence');
  const completed=await call('await',task.id,'--out',output);
  assert.equal(completed.state,'complete');
  assert.deepEqual(completed.result.files,manifest.files.map(entry=>entry.path));
  assert.deepEqual(completed.request,request);
  for(const [name,record] of Object.entries(records)) {
   assert.equal(readFileSync(join(output,name),'utf8'),record);
   assert.equal(statSync(join(output,name)).mode&0o777,0o600);
  }
  assert.equal(store.snapshot().claims.find(c=>c.ticket===source.ticket)?.machine,'box');
  assert.equal(store.tasks.list(source.ticket).length,1);
  const conflict=mkdtempSync(join(directory,'existing-evidence-'));
  writeFileSync(join(conflict,'smoke.json'),'existing local evidence');
  await assert.rejects(call('await',task.id,'--out',conflict),/Existing artifact differs/);
  assert.equal(readFileSync(join(conflict,'smoke.json'),'utf8'),'existing local evidence');
  assert.equal(readFileSync(join(conflict,'memory-owner.json'),'utf8'),records['memory-owner.json']);
 });
}

test('the credential-free Python helper requests and retrieves native evidence through real admission',async t=>{
 const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:2},hp:{heavyLimit:1,combinedLimit:2}});
 const authority=await serveFleet(store,{box:'box-token',hp:'hp-token'},'admin-token',0);
 const address=authority.address();assert.ok(address&&typeof address!=='string');
 const manager=new MachineManager({machine:'box',projects:['org/core'],heavyLimit:1,combinedLimit:2},new FleetClient('http://127.0.0.1:'+address.port,'box-token'));
 const local=await serveManager(manager,{'org/core':'project-token'},'local-admin-token',0);
 const localAddress=local.address();assert.ok(localAddress&&typeof localAddress!=='string');
 const source={id:'builder',machine:'box',session:'s',project:'org/core',ticket:'org/core#2939',role:'builder',resource:'medium' as const,locks:[]};
 assert.equal(store.start(source).ok,true);
 const run=store.snapshot().runs.find(r=>r.id===source.id)!;
 const bridge=await taskBridge(new JsonClient('http://127.0.0.1:'+localAddress.port,'project-token'),run);
 const directory=mkdtempSync(join(tmpdir(),'native-task-client-'));
 t.after(async()=>{await bridge.close();await new Promise<void>(r=>local.close(()=>r()));await new Promise<void>(r=>authority.close(()=>r()));store.close();rmSync(directory,{recursive:true});});
 const request={recipe:'android-tool-then-text' as const,capability:'android-emulator' as const,revision:'a'.repeat(40),reason:'Collect the exact candidate through normal Android admission'};
 const file=join(directory,'request.json');writeFileSync(file,JSON.stringify(request));
 const helper=fileURLToPath(new URL('../scripts/fleet-task.py',import.meta.url));
 const env={PATH:process.env.PATH,PYRY_TASK_SOCKET:bridge.socket};
 const call=async(...args:string[])=>JSON.parse((await execute('python3',[helper,...args],{env})).stdout);
 const task=await call('request',file);
 assert.equal(task.ticket,source.ticket);assert.deepEqual(task.request,request);assert.equal(task.state,'queued');
 assert.equal((await call('request',file)).id,task.id,'a lost acknowledgement does not duplicate execution');
 store.tasks.report('hp',{capabilities:['android-emulator'],ready:true});
 assert.equal(store.taskStart('hp',task.id,'capture').ok,true);
 const recording='{"type":"stream_event"}\r\n{"type":"result"}\r\n';
 const files={'mobile/daemon.stdout':recording.repeat(100000),'mobile/shared-harness-redacted.json':'{"counts":{"executed":1}}',
  'mobile/mobile.xml':'<testsuite tests="1" failures="1"/>','mobile/driver.json':'{"exit_code":1}',
  ...Object.fromEntries(['__proto__','constructor','toString'].map(name=>[name,name+'\r\né\n'])),
  ...Object.fromEntries(Array.from({length:33},(_,i)=>[[`mobile/child-${i}.stdout`,'event\r\n'],[`mobile/child-${i}.manifest.json`,'{"dropped_rows":0,"tail_bytes":0}']]).flat())};
 const manifest=artifactManifest(files),digest=manifestHash(manifest);
 assert.ok(manifest.totalBytes>4*1024*1024);assert.ok(manifest.files.length>64);
 const hp=new JsonClient('http://127.0.0.1:'+address.port,'hp-token');
 const actor={id:task.id,session:'capture'};
 const begin=await hp.call<{digest:string;missing:Record<string,number[]>}>('/tasks/artifacts-begin',{...actor,manifest});
 assert.equal(begin.digest,digest);
 for(const entry of manifest.files) for(const part of begin.missing[entry.path]) await hp.call('/tasks/artifacts-put',{...actor,digest,path:entry.path,part,
  data:Buffer.from(files[entry.path]).subarray(part*ARTIFACT_LIMITS.chunkBytes,(part+1)*ARTIFACT_LIMITS.chunkBytes).toString('base64')});
 await hp.call('/tasks/artifacts-commit',{...actor,digest,result:{outcome:'failed',summary:'Diagnostic recording retained; cause is not established',files:{}}});
 const output=join(directory,'evidence');
 assert.equal((await call('await',task.id,'--out',output)).state,'failed');
 for(const entry of manifest.files) {
  const data=readFileSync(join(output,entry.path));assert.equal(data.length,entry.bytes);assert.equal(sha256(data),entry.sha256);
 }
 assert.equal(JSON.parse(readFileSync(join(output,'.fleet-task-manifest.json'),'utf8')).digest,digest);
 assert.equal(statSync(join(output,'mobile/daemon.stdout')).mode&0o777,0o600);
 assert.equal((await call('read',task.id,'--out',output)).artifacts.files.length,manifest.files.length,'verified retrieval is idempotent');
 const project=new JsonClient('http://127.0.0.1:'+localAddress.port,'project-token');
 await assert.rejects(project.call('/tasks/artifacts-put',{...actor,digest,path:manifest.files[0].path,part:0,data:''}),/Unknown operation/);
 const box=new JsonClient('http://127.0.0.1:'+address.port,'box-token');
 await assert.rejects(box.call('/tasks/artifacts-begin',{...actor,machine:'hp',manifest}),/actor mismatch/);
 await assert.rejects(new JsonClient('http://127.0.0.1:'+address.port,'unknown').call('/tasks/artifact',{id:task.id}),/401/);
 assert.equal(store.snapshot().claims.find(c=>c.ticket===source.ticket)?.machine,'box');
 writeFileSync(file,JSON.stringify({...request,command:'echo denied'}));
 await assert.rejects(call('request',file),/Task request unavailable/);
 const foreign=store.tasks.request('org/core#9',request);
 await assert.rejects(call('read',foreign.id),/outside this admitted ticket/);
 await assert.rejects(project.call('/tasks/artifact',{id:foreign.id,digest,path:manifest.files[0].path,part:0,runId:'builder',session:'s'}),/admitted source ticket/);
 store.finish('box','s','builder');writeFileSync(file,JSON.stringify(request));
 await assert.rejects(call('request',file),/outside this admitted ticket/);
 await assert.rejects(call('read',task.id,'--out',output),/outside this admitted ticket/);
 assert.equal(store.tasks.list(source.ticket).length,1);
});
