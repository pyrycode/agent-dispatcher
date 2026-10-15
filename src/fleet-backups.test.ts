import {promisify} from 'node:util';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync,execFile} from 'node:child_process';
import {FleetStore} from './fleet-store.js';
import {EvidenceStore} from './evidence-store.js';
import {artifactManifest,manifestHash} from './recovery-artifacts.js';
import {backupFileHash} from './fleet-backups.js';
import {validateRuntimeProvenance} from './runtime-provenance.js';
test('a coherent private backup restores evidence beside its exact historical run with admission held',()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-backup-'));
 const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:2}});
 const evidence=new EvidenceStore(':memory:',undefined,id=>store.runOwner(id));
 try {
  store.start({id:'run',machine:'box',session:'s',project:'o/r',ticket:'o/r#1',role:'builder',resource:'medium',locks:[]});
  const files={'summary.md':'Readable stage summary'},manifest=artifactManifest(files),digest=manifestHash(manifest);
  evidence.begin('box','o/r','o/r#1','run',{kind:'agent',role:'builder',outcome:'passed',startedAt:1,endedAt:2},manifest);
  evidence.put('box','o/r','o/r#1','run',digest,'summary.md',0,Buffer.from(files['summary.md']).toString('base64'));
  evidence.commit('box','o/r','o/r#1','run',digest);
  const backup=store.backup(join(root,'backups'),evidence);
  assert.equal(statSync(backup.directory).mode&0o077,0);
  for(const name of ['claims.sqlite','evidence.sqlite']) assert.deepEqual(backupFileHash(join(backup.directory,name)),backup.manifest.files[name]);
  const restored=join(root,'isolated');
  const result=JSON.parse(execFileSync('python3',['scripts/fleet-restore-check.py',backup.directory,restored],{encoding:'utf8'}));
  assert.equal(result.bundles,1);assert.equal(result.uncertainRuns,1);assert.equal(result.admissionAllowed,false);
  assert.equal(JSON.parse(readFileSync(join(restored,'RESTORE_HOLD.json'),'utf8')).networkStarted,false);
  assert.equal(store.snapshot().runs.length,1,'backup never completes or frees live work');
  const config=join(root,'restore-config.json');writeFileSync(config,JSON.stringify({database:join(restored,'claims.sqlite')}));
  const startup=spawnSync(process.execPath,['--import','tsx','src/fleet-bin.ts','claims',config],{encoding:'utf8'});
  assert.equal(startup.status,1);assert.match(startup.stderr,/Restored authority remains held/);
 } finally {evidence.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('runtime records accept only exact source and content identifiers, never free text',()=>{
 const record={image:'a'.repeat(64),tools:'b'.repeat(64),gates:'c'.repeat(64),testDaemon:'d'.repeat(40),agents:'e'.repeat(40)};
 assert.deepEqual(validateRuntimeProvenance(record),record);
 for(const value of [{...record,image:'latest'},{...record,testDaemon:'unknown'},{...record,token:'private'},{...record,agents:['e'.repeat(40)]}]) assert.throws(()=>validateRuntimeProvenance(value));
});

 test('only a configured protected operator can request a coherent snapshot',async()=>{
  const {serveFleet,JsonClient}=await import('./fleet-http.js');
  const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:2}});
  const server=await serveFleet(store,{box:'machine-test'},'admin-test',0);
  try {
   const address=server.address() as {port:number},url='http://127.0.0.1:'+address.port;
   await assert.rejects(()=>new JsonClient(url,'machine-test').call('/operations/backup',{directory:'/ignored'}),/403/);
   await assert.rejects(()=>new JsonClient(url,'admin-test').call('/operations/backup',{}),/409/);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
 });

 test('each collected run preserves the installed runtime identifiers in readable evidence',async()=>{
  const {collectRunEvidence}=await import('./run-evidence.js');
  const root=mkdtempSync(join(tmpdir(),'fleet-runtime-'));
  const runtime={image:'a'.repeat(64),tools:'b'.repeat(64),gates:'c'.repeat(64),testDaemon:'d'.repeat(40),agents:'e'.repeat(40)};
  try {
   const bundle=await collectRunEvidence({project:'o/r',machine:'box',logsDir:root,issueNumber:1,runId:'run',role:'builder',kind:'agent',outcome:'passed',startedAt:1,endedAt:2,runtime});
   assert.deepEqual(bundle.meta.runtime,runtime);assert.deepEqual(JSON.parse(bundle.files['run.json']).runtime,runtime);
  } finally {rmSync(root,{recursive:true,force:true});}
 });

 test('runtime records with two-dot names remain inside the untrusted checkout',async()=>{
  const {readRuntimeProvenance}=await import('./runtime-provenance.js');
  const root=mkdtempSync(join(tmpdir(),'runtime-policy-'));
  try {
   const path=join(root,'..runtime.json');writeFileSync(path,JSON.stringify({image:'a'.repeat(64),tools:'b'.repeat(64),gates:'c'.repeat(64),testDaemon:'d'.repeat(40),agents:'e'.repeat(40)}));
   assert.throws(()=>readRuntimeProvenance(path,root),/unavailable or invalid/);
  } finally {rmSync(root,{recursive:true,force:true});}
 });

 test('the backup CLI selects the central operator credential and seals both stores',async()=>{
  const {serveFleet}=await import('./fleet-http.js');
  const root=mkdtempSync(join(tmpdir(),'backup-cli-'));
  const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:2}},{backupDirectory:join(root,'backups')});
  const evidence=new EvidenceStore(':memory:',undefined,id=>store.runOwner(id));
  const server=await serveFleet(store,{box:'machine-test'},'admin-test',0,'127.0.0.1',undefined,undefined,undefined,undefined,undefined,evidence);
  try {
   const address=server.address() as {port:number},config=join(root,'config.json');
   writeFileSync(config,JSON.stringify({claimsUrl:'http://127.0.0.1:'+address.port,operatorTokenEnv:'TEST_LOCAL_TOKEN',claimsOperatorTokenEnv:'TEST_CLAIMS_TOKEN'}),{mode:0o600});
   const reply=await promisify(execFile)(process.execPath,['--import','tsx','src/fleet-bin.ts','backup',config],{env:{PATH:process.env.PATH,HOME:root,TEST_LOCAL_TOKEN:'local-test',TEST_CLAIMS_TOKEN:'admin-test'},timeout:10_000});
   const result=JSON.parse(reply.stdout);assert.ok(result.directory.startsWith(join(root,'backups')));assert.deepEqual(Object.keys(result.manifest.files),['claims.sqlite','evidence.sqlite']);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));evidence.close();store.close();rmSync(root,{recursive:true,force:true});}
 });
