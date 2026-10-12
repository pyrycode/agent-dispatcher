import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore} from './fleet-store.js';

const SHA='9950e6fbd28aac7ec3f6772e2deeebbcf83b52a2';
const req={id:'builder',machine:'box',session:'s',project:'org/core',ticket:'org/core#3154',role:'builder',resource:'medium' as const,locks:[]};
const limits={box:{heavyLimit:1,combinedLimit:2},mac:{heavyLimit:1,combinedLimit:2},hp:{heavyLimit:1,combinedLimit:2}};

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
  s.taskComplete('mac',job.id,'repair',{outcome:'completed',summary:'repair deployed',files:{},dispatcherRevision:repaired});
  s.finish('box','s','builder');
  assert.equal(s.start({...req,id:'stale'}).ok,false);
  assert.equal(s.start({...req,id:'current',readyRepairs:[repaired]}).ok,true);
 }finally{s.close();}
});
