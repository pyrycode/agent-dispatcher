import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore} from './fleet-store.js';
import {assessmentTasks, validateTaskResult, type RecoveryTask} from './recovery-tasks.js';

import {ARTIFACT_LIMITS,artifactManifest,manifestHash,sha256,validateManifest} from './recovery-artifacts.js';
import {scrubCredentials} from './agent-runtime.js';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SHA='9950e6fbd28aac7ec3f6772e2deeebbcf83b52a2';
const req={id:'builder',machine:'box',session:'s',project:'org/core',ticket:'org/core#3154',role:'builder',resource:'medium' as const,locks:[]};
const limits={box:{heavyLimit:1,combinedLimit:2},mac:{heavyLimit:1,combinedLimit:2},hp:{heavyLimit:1,combinedLimit:2}};

for(const chunked of [false,true]) test('only the owning admitted recovery assessment receives bounded failed-task diagnostics ('+(chunked?'chunks':'legacy')+')',()=>{
 const s=new FleetStore(':memory:',limits);try {
  s.start(req);s.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
  const job=s.requestTask('box','s','org/core','builder',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision:SHA,reason:'repair'});
  s.taskStart('mac',job.id,'repair');
  const candidateRevision='b'.repeat(40);
  const finding=JSON.stringify({taskId:job.id,ticket:req.ticket,candidateRevision,decision:'FAIL',findings:'Retain custody'});
  assert.throws(()=>s.taskComplete('mac',job.id,'repair',{outcome:'failed',candidateRevision:'invalid',summary:'check failed',files:{}}),/candidate revision/);
  assert.equal(s.tasks.get(job.id).state,'running');
  const result={outcome:'failed' as const,candidateRevision,summary:'check failed',files:{'test.diagnostic.log':'AssertionError: read happened\n'+'x'.repeat(20000),'reviewer.findings.json':finding,'raw.log':'private raw data'}};
  if(chunked) {
   const manifest=artifactManifest(result.files),{digest,missing}=s.tasks.beginArtifacts(job.id,'mac','repair',manifest);
   for(const file of manifest.files) for(const part of missing[file.path]) s.tasks.putArtifact(job.id,'mac','repair',digest,file.path,part,Buffer.from(result.files[file.path as keyof typeof result.files]).toString('base64'));
   assert.throws(()=>s.commitTaskArtifacts('mac',job.id,'repair',digest,{...result,files:{},candidateRevision:'invalid'}),/candidate revision/);
   s.commitTaskArtifacts('mac',job.id,'repair',digest,{...result,files:{}});
  } else s.taskComplete('mac',job.id,'repair',result);
  const related=s.tasks.request('org/core#99',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision:SHA,reason:'related repair'});
  s.taskStart('mac',related.id,'related');
  s.taskComplete('mac',related.id,'related',{outcome:'failed',summary:'related failed',files:{'test.diagnostic.log':'related diagnostic'}});
  assert.equal(s.recoveryFacts([req.ticket])[0].tasks[0].result?.files['test.diagnostic.log'],'retained private artifact');
  s.finish('box','s','builder');
  s.recoveryReport('box','org/core',[{ticket:req.ticket,status:'In Development',labels:['error:builder'],blocked:false}]);
  s.start({...req,id:'assessment',role:'recovery',resource:'heavy'});
  const actor={machine:'box',session:'s',project:'org/core',runId:'assessment'};
  const facts=s.recoveryFacts([req.ticket,'org/core#99'],actor);
  assert.equal(facts[0].tasks[0].result?.files['test.diagnostic.log'].length,16000);
  assert.equal(facts[0].tasks[0].result?.files['raw.log'],'retained private artifact');
  assert.equal(facts[0].tasks[0].result?.candidateRevision,candidateRevision);
  assert.deepEqual(JSON.parse(facts[0].tasks[0].result!.files['reviewer.findings.json']),JSON.parse(finding));
  assert.equal(facts[1].tasks[0].result?.files['test.diagnostic.log'],'retained private artifact');
  assert.throws(()=>s.recoveryFacts([req.ticket],{...actor,machine:'mac'}));
  s.finish('box','s','assessment');
  assert.throws(()=>s.recoveryFacts([req.ticket],actor));
 }finally{s.close();}
});

test('assessment excerpts have a total bound, scrub credentials and hide successful artifacts',()=>{
 const task:RecoveryTask={id:'fixture',ticket:req.ticket,request:{recipe:'platform-probe',capability:'macos-arm64',reason:'fixture'},
  state:'failed',created:0,updated:0,machine:'mac',session:'s',runId:'native',result:{outcome:'failed',summary:'failed',files:{'test.diagnostic.log':'x'.repeat(17000)+'\nBearer '+'c'.repeat(40)}}};
 const view=assessmentTasks(Array.from({length:5},()=>task),true);
 assert.match(view[0].result!.files['test.diagnostic.log'],/Bearer \[REDACTED\]/);
 assert.equal(view[3].result!.files['test.diagnostic.log'],'retained private artifact');
 assert.equal(assessmentTasks([{...task,state:'complete'}],true)[0].result!.files['test.diagnostic.log'],'retained private artifact');
});

test('escaped credentials in retained legacy diagnostics cannot enter assessment facts',()=>{
 const secret='k'.repeat(40);
 const message=JSON.stringify({text:'"api_key": "'+secret+'"'});
 const task:RecoveryTask={id:'fixture',ticket:req.ticket,request:{recipe:'platform-probe',capability:'macos-arm64',reason:message},
  state:'failed',created:0,updated:0,machine:'mac',session:'s',runId:'native',result:{outcome:'failed',summary:message,files:{
   'reviewer.diagnostic.log':JSON.stringify({text:'"api_key": "'+secret+'"'}),
  }}};
 assert.doesNotMatch(JSON.stringify(assessmentTasks([task],true)),new RegExp(secret));
 assert.doesNotMatch(JSON.stringify(assessmentTasks([task],false)),new RegExp(secret));
});

test('credential-shaped diagnostic artifacts are rejected before storage',()=>{
 const secret='k'.repeat(40),raw=JSON.stringify({text:'"api_key": "'+secret+'"'});
 assert.throws(()=>validateTaskResult({outcome:'failed',summary:'failed',files:{'reviewer.diagnostic.log':raw}}),/credential-shaped/);
});

test('the assessment bound prioritizes terminal check diagnostics and structured findings',()=>{
 const files=Object.fromEntries(['builder','reviewer','install','test','typecheck','helpers'].map(name=>[name+'.diagnostic.log',name+' '+'x'.repeat(15990)]));
 files['reviewer.findings.json']=JSON.stringify({decision:'FAIL',findings:'retained custody'});
 const task:RecoveryTask={id:'fixture',ticket:req.ticket,request:{recipe:'platform-probe',capability:'macos-arm64',reason:'fixture'},
  state:'failed',created:0,updated:0,machine:'mac',session:'s',runId:'native',result:{outcome:'failed',summary:'failed',files}};
 const view=assessmentTasks([task],true)[0].result!.files;
 assert.equal(JSON.parse(view['reviewer.findings.json']).decision,'FAIL');
 assert.match(view['helpers.diagnostic.log'],/^helpers/);
 assert.equal(view['builder.diagnostic.log'],'retained private artifact');
});

test('uncertain native custody retains its compute reservation and the source device lock',()=>{
 const s=new FleetStore(':memory:',limits);try {
  s.start({...req,locks:['org/core:device']});s.tasks.report('mac',{capabilities:['macos-arm64'],ready:true});
  const job=s.requestTask('box','s','org/core','builder',{recipe:'platform-probe',capability:'macos-arm64',reason:'probe'});
  s.taskStart('mac',job.id,'native');
  s.tasks.uncertain(job.id,'mac','native','Surviving or uncertain descendants');
  assert.equal(s.tasks.get(job.id).state,'attention');
  assert.ok(s.snapshot().runs.some(r=>r.id==='task-'+job.id));
  assert.ok(s.snapshot().runs.some(r=>r.locks.includes('org/core:device')));
  assert.equal(s.start({...req,id:'other',ticket:'org/core#9',locks:['org/core:device']}).ok,false);
 }finally{s.close();}
});

test('a file-rich diagnostic result retains all 65 records',()=>{
 const files=Object.fromEntries(Array.from({length:65},(_,i)=>[`child-${i}.manifest.json`,JSON.stringify({dropped_rows:0})]));
 assert.deepEqual(validateTaskResult({outcome:'failed',summary:'Original capture failed',files}).files,files);
});

function startArtifactTask(s:FleetStore) {
 s.start({...req,ticket:'org/core#2939'});s.tasks.report('hp',{capabilities:['android-emulator'],ready:true});
 const task=s.requestTask('box','s','org/core','builder',{recipe:'android-tool-then-text',capability:'android-emulator',revision:SHA,reason:'original capture'});
 assert.equal(s.taskStart('hp',task.id,'capture').ok,true);return task.id;
}
const metadata={outcome:'failed' as const,summary:'Original capture failed',files:{}};

test('oversized uploads resume after authority restart and commit only a complete verified inventory',()=>{
 const directory=mkdtempSync(join(tmpdir(),'task-artifacts-')),path=join(directory,'authority.sqlite');
 let s=new FleetStore(path,limits);
 try {
  const id=startArtifactTask(s),files={'mobile/child.stdout':'row\r\n'.repeat(850000),'mobile/child.manifest.json':'{"dropped_rows":0,"tail_bytes":0}'};
  const manifest=artifactManifest(files),digest=manifestHash(manifest),entry=manifest.files.find(f=>f.path.endsWith('.stdout'))!;
  assert.ok(manifest.totalBytes>4*1024*1024);
  assert.equal(s.tasks.beginArtifacts(id,'hp','capture',manifest).digest,digest);
  const first=Buffer.from(files[entry.path as keyof typeof files]).subarray(0,ARTIFACT_LIMITS.chunkBytes).toString('base64');
  s.tasks.putArtifact(id,'hp','capture',digest,entry.path,0,first);
  assert.throws(()=>s.commitTaskArtifacts('hp',id,'capture',digest,metadata),/chunk missing/);
  assert.equal(s.tasks.get(id).state,'running');assert.equal(s.tasks.get(id).artifacts,undefined);
  assert.ok(s.snapshot().runs.some(r=>r.supportTaskId===id),'missing evidence keeps the reservation');
  assert.throws(()=>s.readTaskArtifact('box','s','org/core','builder',id,digest,entry.path,0));
  s.close();s=new FleetStore(path,limits);
  const resumed=s.tasks.beginArtifacts(id,'hp','capture',manifest);
  assert.ok(!resumed.missing[entry.path].includes(0));
  s.tasks.putArtifact(id,'hp','capture',digest,entry.path,0,first); // lost acknowledgement replay
  for(const file of manifest.files) for(const part of resumed.missing[file.path]) {
   const data=Buffer.from(files[file.path as keyof typeof files]).subarray(part*ARTIFACT_LIMITS.chunkBytes,(part+1)*ARTIFACT_LIMITS.chunkBytes);
   s.tasks.putArtifact(id,'hp','capture',digest,file.path,part,data.toString('base64'));
  }
  s.commitTaskArtifacts('hp',id,'capture',digest,metadata);
  assert.equal(s.tasks.get(id).state,'failed');assert.deepEqual(s.tasks.get(id).artifacts,manifest);
  assert.throws(()=>s.readTask('box','s','org/core','builder',id),/requires the manifest-v1 client/);
  assert.deepEqual(s.readTask('box','s','org/core','builder',id,'manifest-v1').result?.files,{});
  assert.equal(s.snapshot().runs.some(r=>r.supportTaskId===id),false);
  s.commitTaskArtifacts('hp',id,'capture',digest,metadata);
  const reconstructed=Buffer.concat(entry.chunks.map((_,part)=>Buffer.from(s.readTaskArtifact('box','s','org/core','builder',id,digest,entry.path,part).data,'base64')));
  assert.equal(reconstructed.toString(),files[entry.path as keyof typeof files]);assert.equal(sha256(reconstructed),entry.sha256);
  assert.throws(()=>s.commitTaskArtifacts('hp',id,'capture',digest,{...metadata,outcome:'completed'}),/result changed/);
  const damage=new DatabaseSync(path);
  damage.prepare('UPDATE fleet_task_chunks SET data=? WHERE task=? AND path=? AND part=0').run(Buffer.from('corrupt'),id,entry.path);
  assert.throws(()=>s.readTaskArtifact('box','s','org/core','builder',id,digest,entry.path,0),/missing or corrupt/);
  damage.prepare('DELETE FROM fleet_task_chunks WHERE task=? AND path=? AND part=0').run(id,entry.path);damage.close();
  assert.throws(()=>s.readTaskArtifact('box','s','org/core','builder',id,digest,entry.path,0),/missing or corrupt/);
  assert.ok(s.tasks.beginArtifacts(id,'hp','capture',manifest).missing[entry.path].includes(0));
  s.tasks.putArtifact(id,'hp','capture',digest,entry.path,0,first);
  s.commitTaskArtifacts('hp',id,'capture',digest,metadata);
  assert.equal(s.readTaskArtifact('box','s','org/core','builder',id,digest,entry.path,0).data,first);
  assert.equal(s.tasks.get(id).state,'failed');
 } finally {s.close();rmSync(directory,{recursive:true});}
});

test('retained terminal evidence attaches without changing its failed result or original files',()=>{
 const s=new FleetStore(':memory:',limits);try {
  const id=startArtifactTask(s);
  const committed={...metadata,candidateRevision:SHA},original={...committed,files:{'mobile/driver.json':'{"exit_code":1}'}};
  s.taskComplete('hp',id,'capture',original);const before=s.tasks.get(id),revision=s.artifactRevision(before.ticket);
  const files:Record<string,string>={...original.files,...Object.fromEntries(Array.from({length:65},(_,i)=>[`mobile/child-${i}.manifest.json`,'{"dropped_rows":0}']))};
  const manifest=artifactManifest(files),{digest,missing}=s.tasks.beginArtifacts(id,'hp','capture',manifest);
  assert.equal(s.readTask('box','s','org/core','builder',id,'manifest-v1').artifactsPending,true);
  assert.equal(s.readTask('box','s','org/core','builder',id,'manifest-v1').artifacts,undefined);
  assert.throws(()=>s.readTask('box','s','org/core','builder',id),/still transferring/);
  for(const entry of manifest.files) for(const part of missing[entry.path]) s.tasks.putArtifact(id,'hp','capture',digest,entry.path,part,Buffer.from(files[entry.path]).toString('base64'));
  assert.throws(()=>s.commitTaskArtifacts('hp',id,'capture',digest,{...committed,summary:'changed'}),/result changed/);
  assert.throws(()=>s.commitTaskArtifacts('hp',id,'capture',digest,{...committed,candidateRevision:'b'.repeat(40)}),/result changed/);
  const terminal=s.commitTaskArtifacts('hp',id,'capture',digest,committed);
  assert.deepEqual(terminal.result,before.result);assert.equal(terminal.updated,before.updated);assert.equal(terminal.state,'failed');
  assert.equal(terminal.artifacts?.files.length,66);assert.notEqual(s.artifactRevision(before.ticket),revision);
  assert.deepEqual(s.readTask('box','s','org/core','builder',id).result?.files,files,'active legacy helpers can retrieve small transferred results');
  assert.equal(s.recoveryFacts([before.ticket])[0].tasks[0].artifacts?.fileCount,66);
  assert.equal(s.taskStart('hp',id,'another-capture').ok,false);
 } finally {s.close();}
});

test('chunks cannot evade whole-content credential checks, hashes, actor identity or terminal immutability',()=>{
 const s=new FleetStore(':memory:',limits);try {
  const id=startArtifactTask(s),text='x'.repeat(ARTIFACT_LIMITS.chunkBytes-3)+' ghp_'+'A'.repeat(32),bytes=Buffer.from(text);
  for(let i=0;i<bytes.length;i+=ARTIFACT_LIMITS.chunkBytes) assert.equal(scrubCredentials(bytes.subarray(i,i+ARTIFACT_LIMITS.chunkBytes).toString()),bytes.subarray(i,i+ARTIFACT_LIMITS.chunkBytes).toString());
  const manifest=artifactManifest({'child.stdout':text}),{digest}=s.tasks.beginArtifacts(id,'hp','capture',manifest);
  assert.throws(()=>s.tasks.beginArtifacts(id,'box','capture',manifest),/actor mismatch/);
  assert.throws(()=>s.tasks.putArtifact(id,'hp','wrong',digest,'child.stdout',0,''),/actor mismatch/);
  assert.throws(()=>s.tasks.putArtifact(id,'hp','capture',digest,'child.stdout',0,Buffer.from('bad').toString('base64')),/byte\/hash mismatch/);
  assert.throws(()=>s.tasks.putArtifact(id,'hp','capture',digest,'../escape',0,''),/Invalid artifact chunk/);
  assert.throws(()=>s.tasks.putArtifact(id,'hp','capture',digest,'child.stdout',-1,''),/Invalid artifact chunk/);
  for(let part=0;part<manifest.files[0].chunks.length;part++) s.tasks.putArtifact(id,'hp','capture',digest,'child.stdout',part,bytes.subarray(part*ARTIFACT_LIMITS.chunkBytes,(part+1)*ARTIFACT_LIMITS.chunkBytes).toString('base64'));
  assert.throws(()=>s.commitTaskArtifacts('hp',id,'capture',digest,metadata),/credential-shaped/);
  assert.equal(s.tasks.get(id).artifacts,undefined);assert.equal(s.tasks.get(id).state,'running');
  assert.throws(()=>s.readTaskArtifact('box','s','org/core','builder',id,digest,'child.stdout',0));
  assert.throws(()=>s.tasks.beginArtifacts(id,'hp','capture',artifactManifest({'child.stdout':'changed'})),/manifest changed/);
 } finally {s.close();}
});

test('manifest bounds reject oversized totals, too many files, conflicting paths and incorrect whole-file hashes',()=>{
 assert.throws(()=>artifactManifest(Object.fromEntries(Array.from({length:ARTIFACT_LIMITS.files+1},(_,i)=>[`f-${i}`,'']))),/manifest/);
 const large={path:'child.stdout',bytes:ARTIFACT_LIMITS.bytes+1,sha256:'a'.repeat(64),chunks:Array(257).fill('a'.repeat(64))};
 assert.throws(()=>validateManifest({version:1,chunkBytes:ARTIFACT_LIMITS.chunkBytes,totalBytes:large.bytes,files:[large]}),/inventory/);
 for(const path of ['../outside','/absolute','a//b','.fleet-task-cache/overwrite']) assert.throws(()=>artifactManifest({[path]:'data'}),/path/);
 assert.throws(()=>artifactManifest({'a':'','a/b':''}),/Conflicting/);
 const s=new FleetStore(':memory:',limits);try {
  const id=startArtifactTask(s),manifest=artifactManifest({'child.stdout':'data'});manifest.files[0].sha256='a'.repeat(64);
  const {digest}=s.tasks.beginArtifacts(id,'hp','capture',manifest);
  s.tasks.putArtifact(id,'hp','capture',digest,'child.stdout',0,Buffer.from('data').toString('base64'));
  assert.throws(()=>s.commitTaskArtifacts('hp',id,'capture',digest,metadata),/byte\/hash/);
  assert.equal(s.tasks.get(id).state,'running');
 } finally {s.close();}
});

test('3154 checks run on both native computers without transferring product ownership',()=>{
 const s=new FleetStore(':memory:',limits);try {
  s.start(req);
  s.tasks.report('mac',{capabilities:['macos-arm64'],ready:true});
  s.tasks.report('hp',{capabilities:['linux-amd64','android-emulator'],ready:true});
  const mac=s.requestTask('box','s','org/core','builder',{recipe:'memory-runtime-smoke',capability:'macos-arm64',revision:SHA,reason:'native proof'});
  assert.equal(s.requestTask('box','s','org/core','builder',{recipe:'memory-runtime-smoke',capability:'macos-arm64',revision:SHA,reason:'native proof'}).id,mac.id);
  assert.equal(s.taskStart('hp',mac.id,'wrong').ok,false);
  assert.equal(s.taskStart('mac',mac.id,'native').ok,true);
  assert.equal(s.taskStart('mac',mac.id,'duplicate').ok,false);
  assert.deepEqual(s.snapshot().claims.filter(c=>/#3154$/.test(c.ticket)).map(c=>c.machine),['box']);
  assert.throws(()=>s.taskComplete('hp',mac.id,'native',{outcome:'completed',summary:'ok',files:{}}));
  s.taskComplete('mac',mac.id,'native',{outcome:'completed',summary:'executed native proof',files:{'smoke.json':'{"executed":7,"passed":7}'}});
  assert.equal(s.tasks.get(mac.id).state,'complete');
  assert.equal(s.tasks.get(mac.id).request.revision,SHA);
  assert.equal(s.tasks.list('org/core#3154').length,1);
 }finally{s.close();}
});

test('2939 Android capture requires the emulator capability and ordinary heavy capacity',()=>{
 const s=new FleetStore(':memory:',limits);try {
  s.start({...req,ticket:'org/core#2939'});
  s.tasks.report('hp',{capabilities:['linux-amd64','android-emulator'],ready:true});
  const job=s.requestTask('box','s','org/core','builder',{recipe:'android-tool-then-text',capability:'android-emulator',revision:SHA,reason:'missing mobile capture'});
  s.start({...req,id:'busy',machine:'hp',ticket:'org/core#99',resource:'heavy'});
  assert.equal(s.taskStart('hp',job.id,'capture').ok,false);
  s.finish('hp','s','busy');
  assert.equal(s.taskStart('hp',job.id,'capture').ok,true);
  s.taskComplete('hp',job.id,'capture',{outcome:'failed',summary:'named method failed; diagnostic evidence retained',files:{'capture.json':'{"rejected":1}'}});
  assert.equal(s.tasks.get(job.id).state,'failed');
  assert.equal(s.recoveryFacts(['org/core#2939'])[0].tasks[0].result?.outcome,'failed');
  assert.throws(()=>s.requestTask('box','s','org/other','builder',{recipe:'platform-probe',capability:'macos-arm64',reason:'foreign project'}));
 }finally{s.close();}
});

test('task recipes refuse arbitrary commands, missing revisions and path traversal artifacts',()=>{
 const s=new FleetStore(':memory:',limits);try {
  s.start(req);s.tasks.report('mac',{capabilities:['macos-arm64'],ready:true});
  assert.throws(()=>s.requestTask('box','s','org/core','builder',{recipe:'shell',capability:'macos-arm64',reason:'run shell'} as any));
  assert.throws(()=>s.requestTask('box','s','org/core','builder',{recipe:'memory-runtime-smoke',capability:'macos-arm64',reason:'missing revision'}));
  const j=s.requestTask('box','s','org/core','builder',{recipe:'platform-probe',capability:'macos-arm64',reason:'route availability'});
  s.taskStart('mac',j.id,'probe');
  assert.throws(()=>s.taskComplete('mac',j.id,'probe',{outcome:'completed',summary:'probe',files:{'../escape':'data'}}));
  assert.equal(s.tasks.get(j.id).state,'running');
  assert.ok(s.snapshot().runs.some(r=>r.role==='recovery-task'));
 }finally{s.close();}
});

test('a reviewed dispatcher repair releases compute while publication waits and blocks stale workers',()=>{
 const s=new FleetStore(':memory:',limits);try{
  s.start(req);s.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
  const job=s.requestTask('box','s','org/core','builder',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision:SHA,reason:'fix the demonstrated publication defect'});
  s.taskStart('mac',job.id,'repair');
  const publication={files:{'src/fix.ts':'export const repaired=true;\n'},message:'Fix publication',review:'PASS',checksPassed:true};
  s.prepareRepair('mac',job.id,'repair',publication);
  assert.equal(s.tasks.get(job.id).state,'publishing');
  assert.equal(s.snapshot().runs.some(r=>r.id==='task-'+job.id),false);
  const repaired='fedcba9876543210fedcba9876543210fedcba98';
  const manifest=artifactManifest({'publication-result.json':'{"merged":true}'}),{digest}=s.tasks.beginArtifacts(job.id,'mac','repair',manifest);
  s.tasks.putArtifact(job.id,'mac','repair',digest,'publication-result.json',0,Buffer.from('{"merged":true}').toString('base64'));
  s.commitTaskArtifacts('mac',job.id,'repair',digest,{outcome:'completed',summary:'repair deployed',files:{},dispatcherRevision:repaired});
  s.finish('box','s','builder');
  assert.equal(s.start({...req,id:'stale'}).ok,false);
  assert.equal(s.start({...req,id:'current',readyRepairs:[repaired]}).ok,true);
 }finally{s.close();}
});

test('a drained repair can resume preparation from attention without losing source ownership',()=>{
 const s=new FleetStore(':memory:',limits);try {
  s.start(req);s.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
  const job=s.requestTask('box','s','org/core','builder',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision:SHA,reason:'repair'});
  s.taskStart('mac',job.id,'repair');
  s.tasks.uncertain(job.id,'mac','repair','Temporary census failure');
  assert.ok(s.snapshot().runs.some(r=>r.id==='task-'+job.id));
  const publication={files:{'src/fix.ts':'export const repaired=true;\n'},message:'Fix publication',review:'PASS',checksPassed:true};
  assert.throws(()=>s.prepareRepair('box',job.id,'repair',publication),/actor mismatch/);
  s.prepareRepair('mac',job.id,'repair',publication);
  assert.equal(s.tasks.get(job.id).state,'publishing');
  assert.equal(s.snapshot().runs.some(r=>r.id==='task-'+job.id),false);
  assert.equal(s.snapshot().claims.find(c=>c.ticket===req.ticket)?.machine,'box');
  assert.deepEqual(s.prepareRepair('mac',job.id,'repair',publication),s.tasks.get(job.id));
  assert.throws(()=>s.prepareRepair('mac',job.id,'repair',{...publication,message:'changed'}),/changed/);
 }finally{s.close();}
});

test('a conditional release frees a running task once and answers a retry with the same outcome',()=>{
 const s=new FleetStore(':memory:',limits);try {
  s.start(req);s.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
  const job=s.requestTask('box','s','org/core','builder',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision:SHA,reason:'repair'});
  s.taskStart('mac',job.id,'repair');
  const failed={outcome:'failed' as const,summary:'Watchdog: refused on every pass',files:{}};
  assert.throws(()=>s.taskComplete('mac',job.id,'repair',failed,['publishing']),/Task state is running, not publishing/);
  assert.equal(s.tasks.get(job.id).state,'running');
  for(let i=0;i<2;i++) assert.equal(s.taskComplete('mac',job.id,'repair',failed,['running','attention']).state,'failed');
  assert.equal(s.snapshot().runs.some(r=>r.supportTaskId===job.id),false);
  assert.throws(()=>s.taskComplete('mac',job.id,'repair',{...failed,summary:'other'},['running']),/Completed task result changed/);
 }finally{s.close();}
});
