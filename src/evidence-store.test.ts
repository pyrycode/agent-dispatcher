import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync,utimesSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FleetStore} from './fleet-store.js';
import {FleetClient,JsonClient,listen,serveFleet} from './fleet-http.js';
import {MachineManager,serveManager} from './machine-manager.js';
import {EvidenceStore,DEFAULT_EVIDENCE_LIMITS,readEvidenceLimits,type EvidenceLimits} from './evidence-store.js';
import {RunEvidence,collectRunEvidence,evidenceExcerpts,readEvidenceFile,redact,dropOrphanKeyTail,stripPromptSections,uploadEvidenceBundle,type EvidenceConnection,type EvidenceListing} from './run-evidence.js';
import {scrubCredentials} from './agent-runtime.js';
import {taskBridge} from './recovery-task-bridge.js';
import {artifactManifest} from './recovery-artifacts.js';

const execute=promisify(execFile);
const TOKEN='ghp_'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const KEY='CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-'+'x'.repeat(40);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

/** Two computers, each with its own machine manager, sharing one claim service. */
async function fleet(t:TestContext, options:{evidence?:boolean;limits?:EvidenceLimits}={}) {
 const directory=mkdtempSync(join(tmpdir(),'evidence-'));
 const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:2},hp:{heavyLimit:1,combinedLimit:2}});
 const evidence=options.evidence===false?undefined:new EvidenceStore(':memory:',options.limits??DEFAULT_EVIDENCE_LIMITS,id=>store.runOwner(id));
 const authority=await serveFleet(store,{box:'box-token',hp:'hp-token'},'admin-token',0,'127.0.0.1',undefined,undefined,undefined,undefined,undefined,evidence);
 const address=authority.address();assert.ok(address&&typeof address!=='string');
 const url='http://127.0.0.1:'+address.port;
 const managers=await Promise.all(['box','hp'].map(async machine=>{
  const manager=new MachineManager({machine,projects:['org/core','org/app'],heavyLimit:1,combinedLimit:2},new FleetClient(url,machine+'-token'));
  const socket=join(directory,machine+'.sock');
  const server=await serveManager(manager,{'org/core':machine+'-core','org/app':machine+'-app'},machine+'-local-admin',socket);
  return {server,socket};
 }));
 t.after(async()=>{for(const m of managers) await new Promise<void>(r=>m.server.close(()=>r()));await new Promise<void>(r=>authority.close(()=>r()));store.close();evidence?.close();rmSync(directory,{recursive:true,force:true});});
 const project=(machine:'box'|'hp',p='core')=>new JsonClient('unix://'+managers[machine==='box'?0:1].socket,`${machine}-${p}`);
 const run=(id:string,machine:string,ticket:string,role='verifier')=>{
  assert.equal(store.start({id,machine,session:'s-'+machine,project:ticket.split('#')[0],ticket,role,resource:'heavy',locks:[]}).ok,true);
  store.finish(machine,'s-'+machine,id,true);
 };
 return {directory,store,evidence,url,project,run};
}

/** A logs folder like an agents repo's, after one verifier run on #12. */
function logs(root:string, issue=12) {
 const dir=join(root,'logs-'+Math.random().toString(36).slice(2));
 mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,`2026-10-15T05-00-00-000Z_verifier_#${issue}.log`),'agent stream\n'+`Authorization: Bearer ${'z'.repeat(30)}\n`+'verdict FAIL\n');
 writeFileSync(join(dir,`verifier-gate_#${issue}_1.log`),'make check\n');
 writeFileSync(join(dir,`verifier-gate_#${issue}_1.stderr.log`),`error: go vet failed at relay.go:12\nGH_TOKEN=${TOKEN}\n`);
 writeFileSync(join(dir,`verdict-last-verifier-${issue}.json`),'{"verdict":"FAIL"}');
 writeFileSync(join(dir,`2026-10-15T05-00-00-000Z_verifier_#${issue}.log.prompt.txt`),'the whole prompt');
 writeFileSync(join(dir,`2026-10-15T05-00-00-000Z_verifier_#${issue+1}.log`),'another ticket');
 writeFileSync(join(dir,`managed-worktree-${'a'.repeat(64)}.json`),'{}');
 const gate=join(dir,'evidence',String(issue),'gate-runs','2026-10-15T05-00-00-000Z','main');
 mkdirSync(gate,{recursive:true});
 writeFileSync(join(gate,'junit.xml'),'<testsuite tests="2" failures="1"><testcase name="relay"/></testsuite>');
 writeFileSync(join(gate,'video.mp4'),Buffer.concat([Buffer.from([0,1,2,3]),Buffer.alloc(4096,7)]));
 writeFileSync(join(gate,'logcat.txt'),'line '.repeat(200_000)+KEY+'\nlast logcat line\n');
 return dir;
}

test('a failed verifier run on one computer is fetched whole and redacted from another, with large files as pointers',async t=>{
 const f=await fleet(t);
 f.run('verifier-run','box','org/core#12');
 const dir=logs(f.directory);
 const handoff=join(f.directory,'verifier-12.md');writeFileSync(handoff,'## Verdict\nFAIL: go vet\n');
 const box=new RunEvidence({connection:f.project('box'),project:'org/core',logsDir:dir,machine:()=>'box',dispatcherRevision:'c'.repeat(40),log:()=>{}});
 const spooled=await box.record({issueNumber:12,runId:'verifier-run',role:'verifier',kind:'agent',outcome:'failed',startedAt:Date.now()-60_000,endedAt:Date.now(),verdictHandoffPath:handoff});
 await box.flush();
 assert.equal(box.pending().length,0,'the uploaded bundle leaves the outbox');

 const hp=f.project('hp','app');
 const listing=await hp.call<EvidenceListing>('/evidence/list',{ticket:'org/core#12'});
 assert.equal(listing.bundles.length,1);
 const bundle=listing.bundles[0];
 assert.equal(bundle.machine,'box');assert.equal(bundle.role,'verifier');assert.equal(bundle.meta.outcome,'failed');
 assert.equal(bundle.meta.dispatcherRevision,'c'.repeat(40));
 const paths=bundle.manifest.files.map(file=>file.path);
 for(const path of ['run.json','pointers.json','SHA256SUMS','handoff/verifier-12.md','logs/verifier-gate__12_1.stderr.log','logs/verdict-last-verifier-12.json',
  'evidence/gate-runs/2026-10-15T05-00-00-000Z/main/junit.xml','evidence/gate-runs/2026-10-15T05-00-00-000Z/main/logcat.txt.tail']) assert.ok(paths.includes(path),path);
 assert.ok(!paths.some(p=>p.includes('prompt')||p.includes('managed-worktree')||p.includes('_13.')),'prompts, state files and other tickets stay out');
 assert.ok(!paths.some(p=>p.endsWith('video.mp4')),'binary files are pointed to, never uploaded');

 const stderr=await readEvidenceFile(hp,bundle,'logs/verifier-gate__12_1.stderr.log');
 assert.match(stderr,/go vet failed at relay\.go:12/);
 assert.ok(!stderr.includes(TOKEN),'the GitHub token is redacted');
 const agent=await readEvidenceFile(hp,bundle,paths.find(p=>p.endsWith('_verifier__12.log'))!);
 assert.ok(!agent.includes('z'.repeat(30)),'a bearer token is redacted');
 const tail=await readEvidenceFile(hp,bundle,'evidence/gate-runs/2026-10-15T05-00-00-000Z/main/logcat.txt.tail');
 assert.ok(tail.endsWith('last logcat line\n'));assert.ok(!tail.includes('x'.repeat(40)),'the OAuth token in the tail is redacted');
 assert.ok(Buffer.byteLength(tail)<=256*1024+64);

 const pointers=JSON.parse(await readEvidenceFile(hp,bundle,'pointers.json'));
 const video=pointers.find((p:any)=>p.path.endsWith('video.mp4'));
 assert.equal(video.machine,'box');assert.equal(video.bytes,4100);assert.equal(video.reason,'binary');
 assert.equal(video.sha256,createHash('sha256').update(readFileSync(join(dir,'evidence/12/gate-runs/2026-10-15T05-00-00-000Z/main/video.mp4'))).digest('hex'));
 assert.ok(pointers.some((p:any)=>p.path.endsWith('logcat.txt')&&/sha256|tail/.test(p.reason+p.sha256)),'the full logcat stays local behind a pointer');
 const sums=await readEvidenceFile(hp,bundle,'SHA256SUMS');
 for(const file of bundle.manifest.files.filter(file=>file.path!=='SHA256SUMS')) assert.ok(sums.includes(`${file.sha256}  ${file.path}`),file.path);

 const runJson=JSON.parse(await readEvidenceFile(hp,bundle,'run.json'));
 assert.equal(runJson.ticket,'org/core#12');assert.equal(runJson.machine,'box');assert.equal(runJson.outcome,'failed');
});

test('a passed run uploads too, and the newest bundle is listed first',async t=>{
 const f=await fleet(t);
 // A refiner owns nothing (PR 257), so the next stage can run on the other computer.
 f.run('builder-run','box','org/core#12','refiner');
 f.run('verifier-pass','hp','org/core#12');
 const box=new RunEvidence({connection:f.project('box'),project:'org/core',logsDir:logs(f.directory),machine:()=>'box',log:()=>{}});
 const hp=new RunEvidence({connection:f.project('hp'),project:'org/core',logsDir:logs(f.directory),machine:()=>'hp',log:()=>{}});
 await box.record({issueNumber:12,runId:'builder-run',role:'refiner',kind:'agent',outcome:'completed',startedAt:Date.now()-60_000,endedAt:Date.now()});await box.flush();
 await sleep(5);
 await hp.record({issueNumber:12,runId:'verifier-pass',role:'verifier',kind:'agent',outcome:'completed',startedAt:Date.now()-60_000,endedAt:Date.now()});await hp.flush();
 const listing=await f.project('box').call<EvidenceListing>('/evidence/list',{ticket:'org/core#12'});
 assert.deepEqual(listing.bundles.map(b=>[b.runId,b.machine,b.meta.outcome]),[['verifier-pass','hp','completed'],['builder-run','box','completed']]);
 const one=await f.project('box').call<EvidenceListing>('/evidence/list',{ticket:'org/core#12',runId:'builder-run'});
 assert.deepEqual(one.bundles.map(b=>b.runId),['builder-run']);
});

test('only the computer that ran a run uploads its evidence, and only for its own project',async t=>{
 const f=await fleet(t);
 f.run('box-run','box','org/core#12');
 const bundle=await collectRunEvidence({issueNumber:12,runId:'box-run',role:'verifier',kind:'agent',outcome:'failed',startedAt:Date.now()-60_000,endedAt:Date.now(),project:'org/core',machine:'hp',logsDir:logs(f.directory)});
 await assert.rejects(uploadEvidenceBundle(f.project('hp'),bundle),/Evidence run owner mismatch/);
 await assert.rejects(uploadEvidenceBundle(f.project('box','app'),bundle),/Evidence project mismatch/,'a project token writes only its own project');
 await assert.rejects(uploadEvidenceBundle(f.project('box'),{...bundle,ticket:'org/core#99'}),/Evidence run owner mismatch/,'the run must belong to the ticket');
 await uploadEvidenceBundle(f.project('box'),bundle);
 // A retry of the same bytes is accepted; different bytes for a committed run are not.
 await uploadEvidenceBundle(f.project('box'),bundle);
 await assert.rejects(uploadEvidenceBundle(f.project('box'),{...bundle,files:{...bundle.files,'extra.txt':'later'}}),/already committed/);
 await assert.rejects(new JsonClient(f.url,'nobody').call('/evidence/list',{ticket:'org/core#12'}),/401/,'reads need a fleet credential');
});

test('credential-shaped text is redacted before upload and refused by the service if it ever arrives',async t=>{
 const f=await fleet(t);
 f.run('box-run','box','org/core#12');
 const raw={version:1 as const,ticket:'org/core#12',runId:'box-run',meta:{kind:'agent' as const,role:'verifier',outcome:'failed',startedAt:1,endedAt:2},files:{'stderr.log':`GH_TOKEN=${TOKEN}\n`}};
 await assert.rejects(uploadEvidenceBundle(f.project('box'),raw),/credential-shaped/);
 assert.equal(redact(redact(`x ${TOKEN} ${KEY}`)),redact(`x ${TOKEN} ${KEY}`),'redaction reaches a fixed point');
 // The dispatcher drops a bundle the service refuses for its content rather than retrying it forever.
 const dir=logs(f.directory);
 const box=new RunEvidence({connection:f.project('box'),project:'org/core',logsDir:dir,machine:()=>'box',log:()=>{}});
 mkdirSync(box.outbox,{recursive:true});writeFileSync(join(box.outbox,'0001-12-raw.json'),JSON.stringify(raw));
 await box.flush(true);
 assert.equal(box.pending().length,0);
 assert.equal((await f.project('box').call<EvidenceListing>('/evidence/list',{ticket:'org/core#12'})).bundles.length,0);
});

test('caps: a bundle over its cap is refused, a ticket and the store evict their oldest bundles, Done tickets first',async t=>{
 const now={value:1_000_000};
 const owners=new Map<string,{machine:string;ticket:string;role:string}>();
 const store=new EvidenceStore(':memory:',{...DEFAULT_EVIDENCE_LIMITS,bundleBytes:4096,ticketBytes:8192,totalBytes:16384},id=>owners.get(id),()=>now.value);
 t.after(()=>store.close());
 const meta={kind:'agent',role:'builder',outcome:'completed',startedAt:1,endedAt:2};
 const put=(ticket:string,runId:string,bytes:number)=>{
  owners.set(runId,{machine:'box',ticket,role:'builder'});
  const files={'log.txt':'a'.repeat(bytes)};const manifest=artifactManifest(files);
  const begun=store.begin('box','org/core',ticket,runId,meta,manifest);
  store.put('box','org/core',ticket,runId,begun.digest,'log.txt',0,Buffer.from(files['log.txt']).toString('base64'));
  now.value+=1000;
  return store.commit('box','org/core',ticket,runId,begun.digest);
 };
 assert.throws(()=>put('org/core#1','too-big',5000),/per-bundle cap/);
 put('org/core#1','r1',3000);put('org/core#1','r2',3000);put('org/core#1','r3',3000);
 assert.deepEqual(store.list('org/core#1').map(b=>b.runId),['r3','r2'],'the ticket cap removed its oldest bundle');
 put('org/core#2','d1',3000);put('org/core#3','o1',3000);
 store.sweep(ticket=>ticket==='org/core#2'?true:false); // #2 is Done
 put('org/core#3','o2',3000);put('org/core#3','o3',1000);
 assert.equal(store.usage().usedBytes,16000,'nothing is evicted under the total cap');
 put('org/core#4','n1',4000);
 assert.deepEqual(store.list('org/core#2').map(b=>b.runId),[],'over the total cap, the Done ticket goes first');
 assert.deepEqual(store.list('org/core#1').map(b=>b.runId),['r3'],'then the oldest bundle of an open ticket');
 assert.deepEqual(store.list('org/core#3').map(b=>b.runId),['o3','o2','o1']);
 assert.deepEqual(store.list('org/core#4').map(b=>b.runId),['n1'],'the bundle just committed is never the one evicted');
 const usage=store.usage();
 assert.equal(usage.usedBytes,14000);assert.equal(usage.limits.totalBytes,16384);assert.equal(usage.nearCap,false);
 put('org/core#4','n2',1000);
 assert.equal(store.usage().nearCap,true,'at 90% of the cap the store reports itself near it');
 assert.throws(()=>readEvidenceLimits({maxBundleMB:128}),/64 MiB/);
 assert.throws(()=>readEvidenceLimits({maxTicketMB:1,maxBundleMB:2}),/<=/);
 assert.equal(readEvidenceLimits({maxTotalMB:2048}).totalBytes,2048*1024*1024);
 assert.equal(readEvidenceLimits(undefined).totalBytes,5*1024*1024*1024,'the store defaults to 5 GiB');
});

test('retention: deleted 14 days after Done, kept while open or reopened, unknown tickets after 30 days, stale uploads after a day',async t=>{
 const day=24*3600*1000,now={value:100*day};
 const owners=new Map<string,{machine:string;ticket:string;role:string}>();
 const store=new EvidenceStore(':memory:',DEFAULT_EVIDENCE_LIMITS,id=>owners.get(id),()=>now.value);
 t.after(()=>store.close());
 const meta={kind:'gate',role:'real-claude-gate',outcome:'exit-1',startedAt:1,endedAt:2};
 const upload=(ticket:string,runId:string,commit=true)=>{
  owners.set(runId,{machine:'box',ticket,role:'real-claude-gate'});
  const files={'a.txt':'evidence'};const begun=store.begin('box',undefined,ticket,runId,meta,artifactManifest(files));
  store.put('box',undefined,ticket,runId,begun.digest,'a.txt',0,Buffer.from('evidence').toString('base64'));
  if(commit) store.commit('box',undefined,ticket,runId,begun.digest);
 };
 upload('org/core#1','done');upload('org/core#2','reopened');upload('org/core#3','open');upload('other/x#4','unknown');upload('org/core#5','pending',false);
 const state:Record<string,boolean|undefined>={'org/core#1':true,'org/core#2':true,'org/core#3':false,'org/core#5':false};
 store.sweep(t=>state[t]);
 now.value+=2*day;
 store.sweep(t=>state[t]);
 assert.equal(store.usage().pendingBundles,0,'an upload never committed is discarded after a day');
 state['org/core#2']=false; // reopened
 store.sweep(t=>state[t]);
 now.value+=13*day;
 store.sweep(t=>state[t]);
 assert.equal(store.list('org/core#1').length,0,'14 days after Done the bundles are gone');
 assert.equal(store.list('org/core#2').length,1,'a reopened ticket keeps its evidence');
 assert.equal(store.list('org/core#3').length,1,'an open ticket keeps its evidence');
 assert.equal(store.list('other/x#4').length,1);
 now.value+=16*day;
 store.sweep(t=>state[t]);
 assert.equal(store.list('other/x#4').length,0,'a ticket the workflow store does not know goes after 30 days');
 assert.equal(store.list('org/core#3').length,1);
});

test('mixed versions: an older claim service or manager keeps bundles for retry, an updated one takes them, and a failure never throws',async t=>{
 // An old claim service: the store is not there.
 const old=await fleet(t,{evidence:false});
 old.run('run-1','box','org/core#12');
 // An old manager: it does not forward the evidence routes.
 const oldManager=createServer((_req,res)=>{res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Unknown operation'}));});
 await listen(oldManager,join(old.directory,'old-manager.sock'));
 t.after(()=>new Promise<void>(r=>oldManager.close(()=>r())));
 const dir=logs(old.directory);
 for(const connection of [old.project('box'),new JsonClient('unix://'+join(old.directory,'old-manager.sock'),'token')]) {
  const messages:string[]=[];
  const box=new RunEvidence({connection,project:'org/core',logsDir:dir,machine:()=>'box',outbox:join(old.directory,'outbox-'+messages.length+Math.random()),log:m=>messages.push(m)});
  await box.record({issueNumber:12,runId:'run-1',role:'verifier',kind:'agent',outcome:'failed',startedAt:Date.now()-60_000,endedAt:Date.now()});
  await box.flush(true);
  assert.equal(box.pending().length,1,'the bundle stays for a later retry');
  assert.ok(messages.some(m=>/Unknown operation/.test(m)),messages.join('\n'));
 }
 const oldState=await old.project('box').call<any>('/state');
 assert.equal(oldState.features?.evidence,undefined,'a service without the store does not advertise it');

 // The same outbox reaches a service that has been updated.
 const updated=await fleet(t);
 updated.run('run-1','box','org/core#12');
 let target:EvidenceConnection=old.project('box');
 const swap:EvidenceConnection={call:(path,body)=>target.call(path,body)};
 const outbox=join(old.directory,'outbox-shared');
 const box=new RunEvidence({connection:swap,project:'org/core',logsDir:dir,machine:()=>'box',outbox,log:()=>{}});
 await box.record({issueNumber:12,runId:'run-1',role:'verifier',kind:'agent',outcome:'failed',startedAt:Date.now()-60_000,endedAt:Date.now()});
 await box.flush(true);
 assert.equal(box.pending().length,1);
 target=updated.project('box');
 box.maybeFlush(); // quiet after an old-version answer
 await box.flush(true);
 assert.equal(box.pending().length,0);
 assert.equal((await updated.project('hp').call<EvidenceListing>('/evidence/list',{ticket:'org/core#12'})).bundles.length,1);
 const state=await updated.project('box').call<any>('/state');
 assert.equal(state.features.evidence,true);assert.equal(state.evidenceStore.committedBundles,1,'operator status carries the store usage');
 assert.equal(typeof state.evidenceStore.limits.totalBytes,'number');

 // Unreachable: record still resolves, nothing throws.
 const down=new RunEvidence({connection:new JsonClient('unix:///nonexistent/socket.sock','token'),project:'org/core',logsDir:dir,machine:()=>'box',outbox:join(old.directory,'outbox-down'),log:()=>{}});
 await down.record({issueNumber:12,runId:'run-1',role:'verifier',kind:'agent',outcome:'failed',startedAt:Date.now()-60_000,endedAt:Date.now()});
 await down.flush(true);
 assert.equal(down.pending().length,1);
});

test('the outbox is bounded by count, size and age',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'evidence-outbox-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const now={value:Date.now()};
 const box=new RunEvidence({connection:{call:async()=>{throw new Error('down');}},project:'org/core',logsDir:logs(directory),machine:()=>'box',
  outboxLimits:{files:3,bytes:1024*1024*1024,ageMs:1000},now:()=>now.value,log:()=>{}});
 for(let i=0;i<5;i++) await box.record({issueNumber:12,runId:'run-'+i,role:'verifier',kind:'agent',outcome:'failed',startedAt:now.value-1000,endedAt:now.value+i});
 assert.equal(box.pending().length,3,'the oldest are dropped first');
 const files=box.pending();
 for(const file of files) utimesSync(file,new Date(now.value-10_000),new Date(now.value-10_000));
 await box.record({issueNumber:12,runId:'run-new',role:'verifier',kind:'agent',outcome:'failed',startedAt:now.value-1000,endedAt:now.value+10});
 assert.equal(box.pending().length,1,'stale bundles expire');
});

test('any agent reads shared evidence through its run socket and the Python helper; only builders request native checks',async t=>{
 const f=await fleet(t);
 f.run('verifier-run','box','org/core#12','recovery');
 const box=new RunEvidence({connection:f.project('box'),project:'org/core',logsDir:logs(f.directory),machine:()=>'box',log:()=>{}});
 await box.record({issueNumber:12,runId:'verifier-run',role:'verifier',kind:'agent',outcome:'failed',startedAt:Date.now()-60_000,endedAt:Date.now()});
 await box.flush();
 // A builder on the other computer, holding only its own run socket.
 assert.equal(f.store.start({id:'mac-builder',machine:'hp',session:'s-hp',project:'org/core',ticket:'org/core#12',role:'builder',resource:'medium',locks:[]}).ok,true);
 const run=f.store.snapshot().runs.find(r=>r.id==='mac-builder')!;
 const bridge=await taskBridge(f.project('hp'),run,{tasks:false,evidence:true});
 t.after(()=>bridge.close());
 const helper=fileURLToPath(new URL('../scripts/fleet-task.py',import.meta.url));
 const env={PATH:process.env.PATH,PYRY_TASK_SOCKET:bridge.socket};
 const out=join(f.directory,'fetched');
 const result=JSON.parse((await execute('python3',[helper,'evidence','12','--out',out],{env})).stdout);
 assert.equal(result.ticket,'org/core#12');assert.equal(result.bundles.length,1);
 assert.equal(result.bundles[0].machine,'box');assert.equal(result.bundles[0].meta.outcome,'failed');
 const fetched=join(out,'verifier-run');
 assert.match(readFileSync(join(fetched,'logs/verifier-gate__12_1.stderr.log'),'utf8'),/go vet failed/);
 assert.ok(readdirSync(join(fetched,'evidence/gate-runs/2026-10-15T05-00-00-000Z/main')).includes('junit.xml'));
 assert.ok(existsSync(join(fetched,'.fleet-task-manifest.json')));
 // Listing without --out, and a full ticket name.
 const listed=JSON.parse((await execute('python3',[helper,'evidence','org/core#12'],{env})).stdout);
 assert.ok(listed.bundles[0].files.some((f:any)=>f.path==='run.json'));
 // Native check requests stay with builders that have the tasks action.
 await assert.rejects(execute('python3',[helper,'read','a'.repeat(64)],{env}),/Unknown task action/);
});

test('a recovery assessment gets bounded excerpts of every computer\'s bundles, newest first',async t=>{
 const f=await fleet(t);
 f.run('verifier-run','box','org/core#12');
 const box=new RunEvidence({connection:f.project('box'),project:'org/core',logsDir:logs(f.directory),machine:()=>'box',log:()=>{}});
 await box.record({issueNumber:12,runId:'verifier-run',role:'verifier',kind:'agent',outcome:'failed',startedAt:Date.now()-60_000,endedAt:Date.now()});
 await box.flush();
 const excerpts=await evidenceExcerpts(f.project('hp'),'org/core#12',{bundles:6,characters:20_000,perFile:4000});
 assert.ok(excerpts);
 assert.equal(excerpts.bundles[0].machine,'box');
 assert.match(excerpts.bundles[0].excerpts['logs/verifier-gate__12_1.stderr.log'],/go vet failed/);
 assert.ok(JSON.stringify(excerpts).length<30_000);
 assert.ok(!JSON.stringify(excerpts).includes(TOKEN));
 assert.equal(await evidenceExcerpts({call:async()=>{throw new Error('Service 404');}},'org/core#12'),null,'an older service gives no central evidence, not an error');
});

test('a credential the tail read starts inside is never uploaded, even when redaction shrinks the tail',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'evidence-edge-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const dir=join(directory,'logs');mkdirSync(dir);
 const secret='Q'.repeat(36);
 // Redaction shrinks many long OAuth tokens near the end, so a naive cut of the
 // redacted text would reach back to the read's first bytes.
 const shrink=Array.from({length:250},()=>'sk-ant-oat01-'+'w'.repeat(400)).join('\n')+'\n';
 const tailBytes=256*1024,margin=64*1024,read=tailBytes+margin;
 for(const offset of [0,7,18,30]) {
  // The token ghp_<secret> sits so that the read, the last tail+margin bytes,
  // starts `offset` characters into the secret.
  // Over the 512 KiB whole-file limit, so the bundle holds a tail.
  const head=('f'.repeat(4096)+'\n').repeat(60)+'x'.repeat(10)+' ';
  const token='ghp_'+secret;
  const restLength=read-(token.length-4-offset);
  const rest='\n'+shrink+'z'.repeat(restLength-1-shrink.length-1)+'\n';
  assert.equal(rest.length,restLength);
  const final=head+token+rest;
  assert.equal(Buffer.byteLength(final)-read,head.length+4+offset,'the read starts inside the secret');
  const name=`verifier-gate_#12_${offset}.stderr.log`;
  writeFileSync(join(dir,name),final);
  const bundle=await collectRunEvidence({issueNumber:12,runId:'r',role:'verifier',kind:'agent',outcome:'failed',startedAt:Date.now()-60_000,endedAt:Date.now(),project:'org/core',machine:'box',logsDir:dir});
  const tail=bundle.files[`logs/verifier-gate__12_${offset}.stderr.log.tail`];
  assert.ok(tail!==undefined,Object.keys(bundle.files).join(','));
  assert.ok(!tail.includes('QQQQQQ'),`offset ${offset}: part of the token survived`);
  assert.ok(Buffer.byteLength(tail)<=tailBytes);
  rmSync(join(dir,name));
 }
});

test('evidence redaction covers keys, cookies, basic auth, flags, named secrets and signed URLs; prompts are stripped from agent logs',()=>{
 const pem='-----BEGIN RSA PRIVATE KEY-----\n'+'MIIEow'.repeat(11)+'\n'+'abcdEF'.repeat(11)+'\n-----END RSA PRIVATE KEY-----';
 const orphan='abcdEF'.repeat(11)+'\n'+'ghijKL'.repeat(11)+'\n-----END PRIVATE KEY-----';
 const samples:Array<[string,string]>=[
  [pem,'MIIEow'],
  ['Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==','dXNlcjpw'],
  ['Cookie: session=abcdef1234567890; other=x','abcdef1234567890'],
  ['curl --token s3cr3tvalue99 https://x','s3cr3tvalue99'],['tool --api-key=s3cr3tvalue99','s3cr3tvalue99'],
  ['KEYSTORE_BASE64=QUJDREVGR0hJSktM','QUJDREVGR0hJSktM'],['SIGNING_KEY_PASSWORD=hunter2hunter2','hunter2hunter2'],
  ['key AKIAIOSFODNN7EXAMPLE used','AKIAIOSFODNN7EXAMPLE'],['sk-proj-'+'a'.repeat(30),'a'.repeat(30)],
  ['https://s3/x?X-Amz-Signature=deadbeefcafebabe1234&y=1','deadbeefcafebabe1234'],
 ];
 for(const [text,secret] of samples) assert.ok(!redact(text).includes(secret),text);
 assert.ok(!dropOrphanKeyTail(orphan+'\nafter').includes('ghijKL'),'the end of a key cut off before a tail goes too');
 assert.ok(dropOrphanKeyTail(orphan+'\nafter').endsWith('\nafter'));
 assert.equal(redact('ordinary: make check failed at relay.go:12 (exit 2)'),'ordinary: make check failed at relay.go:12 (exit 2)');
 for(const [text] of samples) assert.equal(scrubCredentials(redact(text)),redact(text),'the service-side check accepts redacted text');

 const rule='='.repeat(60);
 const log=[`${rule}`,'DISPATCH — 2026-10-15T02:07:22.487Z',rule,'dispatching',rule,'PROMPT — 2026-10-15T02:07:22.487Z',rule,'# Secret plan','line two',
  rule,'SYSTEM PROMPT — 2026-10-15T02:07:22.487Z',rule,'# Pyrycode verifier','You are the judge',
  '[02:07:23] [thread.started] {"type":"thread.started"}','[02:07:24] [item.completed] {"text":"FAIL"}',rule,'OUTPUT (success) — 2026-10-15T02:10:20.114Z',rule,'Posted FAIL'].join('\n');
 const stripped=stripPromptSections(log);
 assert.ok(!stripped.includes('Secret plan')&&!stripped.includes('You are the judge'));
 assert.ok(stripped.includes('[02:07:24] [item.completed]')&&stripped.includes('Posted FAIL')&&stripped.includes('dispatching'));
 assert.match(stripped,/\[2 prompt line\(s\) omitted/);
});

test('scrubbing stays linear on long token-like runs',()=>{
 for(const sample of ['a-'.repeat(128*1024),'Ab9_-'.repeat(52*1024)]) {
  const started=Date.now();scrubCredentials(sample);redact(sample);
  assert.ok(Date.now()-started<2000,`took ${Date.now()-started} ms`);
 }
});

test('collisions, many files and an unusable bundle: the bundle fits its cap and a bad one never blocks the outbox',async t=>{
 const f=await fleet(t);
 f.run('many','box','org/core#12','recovery');
 const dir=logs(f.directory);
 const ev=join(dir,'evidence','12');
 mkdirSync(join(ev,'a_b'),{recursive:true});
 writeFileSync(join(ev,'a b'),'one');writeFileSync(join(ev,'a_b','x'),'two');writeFileSync(join(ev,'x y.txt'),'three');writeFileSync(join(ev,'x_y.txt'),'four');
 mkdirSync(join(ev,'shots'));
 for(let i=0;i<3800;i++) writeFileSync(join(ev,'shots',`s${i}.png`),Buffer.from([0,1,2]));
 for(let i=0;i<3;i++) writeFileSync(join(ev,`report-${i}.xml`),'<x>'+'r'.repeat(2*1024*1024-10)+'</x>');
 const bundle=await collectRunEvidence({issueNumber:12,runId:'many',role:'verifier',kind:'agent',outcome:'failed',startedAt:Date.now()-60_000,endedAt:Date.now(),project:'org/core',machine:'box',logsDir:dir});
 const total=Object.values(bundle.files).reduce((n,v)=>n+Buffer.byteLength(v),0);
 assert.ok(total<=7*1024*1024,`bundle is ${total} bytes`);
 assert.ok(JSON.parse(bundle.files['run.json']).omittedFiles>0);
 const texts=Object.entries(bundle.files).filter(([p])=>p.startsWith('evidence/')&&!p.includes('shots')).map(([,v])=>v);
 for(const v of ['one','two','three','four']) assert.ok(texts.includes(v),v);
 await uploadEvidenceBundle(f.project('box'),bundle);

 // A bundle this computer cannot describe is dropped, and the next one still goes.
 const box=new RunEvidence({connection:f.project('box'),project:'org/core',logsDir:dir,machine:()=>'box',log:()=>{}});
 mkdirSync(box.outbox,{recursive:true});
 writeFileSync(join(box.outbox,'0000-12-bad.json'),JSON.stringify({...bundle,runId:'many',files:{'a':'x','a/b':'y'}}));
 f.run('after','box','org/core#13','recovery');
 const later=await collectRunEvidence({issueNumber:13,runId:'after',role:'verifier',kind:'agent',outcome:'completed',startedAt:Date.now()-60_000,endedAt:Date.now(),project:'org/core',machine:'box',logsDir:dir});
 writeFileSync(join(box.outbox,'0001-13-good.json'),JSON.stringify(later));
 await box.flush(true);
 assert.equal(box.pending().length,0);
 assert.equal((await f.project('hp').call<EvidenceListing>('/evidence/list',{ticket:'org/core#13'})).bundles.length,1);
});

test('newest means the run ended last, so an outbox backlog does not list or evict as newest; freed pages return in bounded steps',async t=>{
 const owners=new Map<string,{machine:string;ticket:string;role:string}>();
 const directory=mkdtempSync(join(tmpdir(),'evidence-db-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const store=new EvidenceStore(join(directory,'evidence.sqlite'),{...DEFAULT_EVIDENCE_LIMITS,ticketBytes:8*1024*1024},id=>owners.get(id));
 t.after(()=>store.close());
 const put=(runId:string,endedAt:number,bytes=1000,ticket='org/core#1')=>{
  owners.set(runId,{machine:'box',ticket,role:'builder'});
  const files={'log.txt':'a'.repeat(bytes)};const manifest=artifactManifest(files);
  const begun=store.begin('box','org/core',ticket,runId,{kind:'agent',role:'builder',outcome:'completed',startedAt:endedAt-10,endedAt},manifest);
  const data=Buffer.from(files['log.txt']);
  for(let part=0;part*262144<data.length;part++) store.put('box','org/core',ticket,runId,begun.digest,'log.txt',part,data.subarray(part*262144,(part+1)*262144).toString('base64'));
  store.commit('box','org/core',ticket,runId,begun.digest);
 };
 put('new-run',2000);put('backlog-run',1000);
 assert.deepEqual(store.list('org/core#1').map(b=>b.runId),['new-run','backlog-run']);
 for(let i=0;i<6;i++) put('big-'+i,3000+i,2*1024*1024);
 assert.ok(!store.list('org/core#1').some(b=>b.runId==='new-run'),'the ticket cap removed the runs that ended first');
 // About 30 MiB more across other tickets, so freeing it takes several vacuum steps.
 for(let i=0;i<15;i++) put('bulk-'+i,4000+i,2*1024*1024,'org/core#'+(10+Math.floor(i/3)));
 store.sweep(()=>true);
 // Retention far in the future removes everything; vacuum returns the pages in steps.
 const later=new EvidenceStore(join(directory,'evidence.sqlite'),{...DEFAULT_EVIDENCE_LIMITS,doneRetentionMs:1},id=>owners.get(id),()=>Date.now()+10_000);
 t.after(()=>later.close());
 later.sweep(()=>true);
 let free=later.vacuumStep(256);
 assert.ok(free>0,'one bounded step leaves pages for the next');
 while(free>0) free=later.vacuumStep(256);
 assert.equal(free,0);
});

test('a recovery excerpt reads the chunk before a short last chunk',async t=>{
 const f=await fleet(t);
 f.run('long','box','org/core#12','recovery');
 const dir=join(f.directory,'logs-long');mkdirSync(dir);
 // Just over one chunk after redaction: the last chunk alone holds a few bytes.
 writeFileSync(join(dir,'verifier-gate_#12_1.stderr.log'),'e'.repeat(262144-30)+'\nfinal error: relay refused\n'+'k'.repeat(40)+'\n');
 const box=new RunEvidence({connection:f.project('box'),project:'org/core',logsDir:dir,machine:()=>'box',log:()=>{}});
 await box.record({issueNumber:12,runId:'long',role:'verifier',kind:'agent',outcome:'failed',startedAt:Date.now()-60_000,endedAt:Date.now()});
 await box.flush();
 const excerpts=await evidenceExcerpts(f.project('hp'),'org/core#12');
 assert.match(excerpts!.bundles[0].excerpts['logs/verifier-gate__12_1.stderr.log'],/final error: relay refused/);
});
