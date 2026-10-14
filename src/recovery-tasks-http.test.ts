import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore} from './fleet-store.js';
import {serveFleet,JsonClient} from './fleet-http.js';
import {recoveryFingerprint} from './fleet-recovery.js';
import {DEFAULT_CODEX_THROTTLE} from './codex-throttle.js';

const limits={box:{heavyLimit:1,combinedLimit:2},mac:{heavyLimit:1,combinedLimit:2}};
const revision='9950e6fbd28aac7ec3f6772e2deeebbcf83b52a2';
test('failed-task excerpts require the owning recovery run over HTTP',async t=>{
 const store=new FleetStore(':memory:',limits),server=await serveFleet(store,{box:'b',mac:'m'},'a',0);
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url='http://127.0.0.1:'+address.port,box=new JsonClient(url,'b'),mac=new JsonClient(url,'m');
 const ticket='org/core#1947';
 store.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
 const task=store.tasks.request(ticket,{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision,reason:'failed check'});
 store.taskStart('mac',task.id,'native');
 store.taskComplete('mac',task.id,'native',{outcome:'failed',summary:'failed',files:{'test.diagnostic.log':'AssertionError: read happened','raw.log':'private record'}});
 store.start({id:'assessment',machine:'box',session:'s',project:'org/core',ticket,role:'recovery',resource:'heavy',locks:[]});
 const request={tickets:[ticket],project:'org/core',session:'s',runId:'assessment'};
 const [facts]=await box.call<any[]>('/recovery/facts',request);
 assert.equal(facts.tasks[0].result.files['test.diagnostic.log'],'AssertionError: read happened');
 assert.equal(facts.tasks[0].result.files['raw.log'],'retained private artifact');
 await assert.rejects(mac.call('/recovery/facts',request));
 const [ordinary]=await box.call<any[]>('/recovery/facts',{tickets:[ticket]});
 assert.equal(ordinary.tasks[0].result.files['test.diagnostic.log'],'retained private artifact');
});

test('real HTTP source admission, native result, ownership and reassessment work together',async t=>{
 const store=new FleetStore(':memory:',limits,{codexThrottle:{...DEFAULT_CODEX_THROTTLE,startSpacingMs:0}}),server=await serveFleet(store,{box:'b',mac:'m'},'a',0);
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url='http://127.0.0.1:'+address.port,box=new JsonClient(url,'b'),mac=new JsonClient(url,'m'),admin=new JsonClient(url,'a');
 const observation={ticket:'org/core#3154',status:'In Development',labels:['error:builder'],blocked:false};
 // The failed builder made box the owner; its assessment and the native task leave that unchanged.
 store.start({id:'builder',machine:'box',session:'s',project:'org/core',ticket:observation.ticket,role:'builder',resource:'medium',locks:[]});store.finish('box','s','builder');
 const [incident]=store.recoveryReport('box','org/core',[observation]);
 store.start({id:'recovery',machine:'box',session:'s',project:'org/core',ticket:observation.ticket,role:'recovery',resource:'heavy',locks:[]});
 store.recoveryStep('box','s','org/core',incident.id,'recovery','begin');
 store.recoveryStep('box','s','org/core',incident.id,'recovery','decide',{action:'coordinate',reason:'native route',task:{recipe:'platform-probe',capability:'macos-arm64',reason:'native route'}});
 store.finish('box','s','recovery');
 assert.equal(store.recovery.list()[0].state,'waiting');
 assert.equal(store.recoveryReport('box','org/core',[observation]).length,0);
 await mac.call('/tasks/capabilities',{record:{capabilities:['macos-arm64'],ready:true}});
 const [job]=await mac.call<any[]>('/tasks/queue',{});
 assert.ok((await mac.call<any>('/tasks/start',{id:job.id,session:'native'})).ok);
 await assert.rejects(box.call('/tasks/complete',{id:job.id,session:'native',result:{outcome:'completed',summary:'probe',files:{}}}));
 await mac.call('/tasks/complete',{id:job.id,session:'native',result:{outcome:'completed',summary:'route is available; not a candidate pass',files:{'platform.json':'{"candidate_tests_executed":false}'}}});
 const next=store.recoveryReport('box','org/core',[observation]);assert.equal(next[0].state,'queued');
 assert.equal(store.snapshot().claims.find(c=>c.ticket===observation.ticket)?.machine,'box');
 assert.notEqual(next[0].fingerprint,recoveryFingerprint(observation));
 await assert.rejects(admin.call('/tasks/request',{project:'org/core',runId:'recovery',request:{recipe:'platform-probe',capability:'macos-arm64',reason:'not an active source worker'}}));
});

test('operational escalation rechecks with delay while human decisions remain held',()=>{
 const store=new FleetStore(':memory:',limits);try{
  const o={ticket:'org/core#1',status:'In Development',labels:['error:builder'],blocked:false};
  const [incident]=store.recoveryReport('box','org/core',[o]);
  store.start({id:'r',machine:'box',session:'s',project:'org/core',ticket:o.ticket,role:'recovery',resource:'heavy',locks:[]});
  store.recoveryStep('box','s','org/core',incident.id,'r','begin');
  store.recoveryStep('box','s','org/core',incident.id,'r','decide',{action:'escalate',category:'operational',reason:'Configured route temporarily offline'});
  store.finish('box','s','r');
  assert.equal(store.recovery.list()[0].decision?.category,'operational');
  assert.equal(store.recoveryReport('box','org/core',[o]).length,0);
 }finally{store.close();}
});

test('native helpers wait for active owned work through ordinary machine capacity',async t=>{
 const {MachineManager}=await import('./machine-manager.js');
 const {FleetClient}=await import('./fleet-http.js');
 const store=new FleetStore(':memory:',limits),server=await serveFleet(store,{box:'b',mac:'m'},'a',0);
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url='http://127.0.0.1:'+address.port;
 store.start({id:'original',machine:'box',session:'s',project:'org/core',ticket:'org/core#3154',role:'builder',resource:'medium',locks:[]});
 const task=store.requestTask('box','s','org/core','original',{recipe:'memory-runtime-smoke',capability:'macos-arm64',revision,reason:'native execution'});
 store.tasks.report('mac',{capabilities:['macos-arm64'],ready:true});
 store.start({id:'owned-before',machine:'mac',session:'p',project:'org/core',ticket:'org/core#9',role:'builder',resource:'medium',locks:[]});
 store.finish('mac','p','owned-before');
 const manager=new MachineManager({machine:'mac',projects:['org/core'],heavyLimit:1,combinedLimit:2},new FleetClient(url,'m'));
 manager.offer('org/core','product',[{project:'org/core',ticket:'org/core#9',role:'verifier',resource:'heavy',locks:[],key:'owned',order:0}]);
 await manager.tick(); // The product worker was already admitted when native work arrived.
 assert.equal((await manager.support('native')).length,0);
 assert.equal(store.tasks.get(task.id).state,'queued');
 const own=store.snapshot().runs.find(r=>r.ticket==='org/core#9');assert.ok(own);
 await manager.replace('org/core','product',[]);store.finish('mac','product',own.id);
 const jobs=await manager.support('native');assert.equal(jobs.length,1);assert.equal(jobs[0].task.id,task.id);
 assert.equal(jobs[0].run.supportTaskId,task.id);
 assert.equal(store.snapshot().claims.find(c=>c.ticket==='org/core#3154')?.machine,'box');
});

test('a failed completion waits for a publication still being written, and a conditional one needs the expected state', async t => {
 const SHA='9950e6fbd28aac7ec3f6772e2deeebbcf83b52a2';
 const store=new FleetStore(':memory:',limits);
 // A publication whose GitHub writes never answer, as one still landing.
 const github={request:()=>new Promise(()=>{})} as any;
 const server=await serveFleet(store,{box:'b',mac:'m'},'a',0,'127.0.0.1',github,undefined,'org/dispatcher');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const mac=new JsonClient('http://127.0.0.1:'+address.port,'m');
 store.start({id:'builder',machine:'box',session:'s',project:'org/core',ticket:'org/core#3289',role:'builder',resource:'medium',locks:[]});
 store.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
 const job=store.requestTask('box','s','org/core','builder',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision:SHA,reason:'repair'});
 store.taskStart('mac',job.id,'repair');
 const failed={outcome:'failed',summary:'Watchdog: refused on every pass',files:{}};
 // Conditional release: a publishing task is not released.
 await assert.rejects(mac.call('/tasks/complete',{id:job.id,session:'repair',result:failed,expectStates:'running'}),/Invalid expected task states/);
 const publication={files:{'src/fix.ts':'export const repaired=true;\n'},message:'Fix',review:'PASS',checksPassed:true};
 store.prepareRepair('mac',job.id,'repair',publication);
 await assert.rejects(mac.call('/tasks/complete',{id:job.id,session:'repair',result:failed,expectStates:['running','attention']}),/Task state is publishing/);
 assert.equal(store.tasks.get(job.id).state,'publishing');
 void mac.call('/tasks/publish-repair',{id:job.id,session:'repair',publication}).catch(()=>{});
 await new Promise(r=>setTimeout(r,200));
 await assert.rejects(mac.call('/tasks/complete',{id:job.id,session:'repair',result:failed}),/Repair publication in progress/);
 assert.equal(store.tasks.get(job.id).state,'publishing');
});
