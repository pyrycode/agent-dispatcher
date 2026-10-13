import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore} from './fleet-store.js';
import {assessmentTasks, validateTaskResult, type RecoveryTask} from './recovery-tasks.js';

const SHA='9950e6fbd28aac7ec3f6772e2deeebbcf83b52a2';
const req={id:'builder',machine:'box',session:'s',project:'org/core',ticket:'org/core#3154',role:'builder',resource:'medium' as const,locks:[]};
const limits={box:{heavyLimit:1,combinedLimit:2},mac:{heavyLimit:1,combinedLimit:2},hp:{heavyLimit:1,combinedLimit:2}};

test('only the owning admitted recovery assessment receives bounded failed-task diagnostics',()=>{
 const s=new FleetStore(':memory:',limits);try {
  s.start(req);s.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
  const job=s.requestTask('box','s','org/core','builder',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision:SHA,reason:'repair'});
  s.taskStart('mac',job.id,'repair');
  const candidateRevision='b'.repeat(40);
  const finding=JSON.stringify({taskId:job.id,ticket:req.ticket,candidateRevision,decision:'FAIL',findings:'Retain custody'});
  assert.throws(()=>s.taskComplete('mac',job.id,'repair',{outcome:'failed',candidateRevision:'invalid',summary:'check failed',files:{}}),/candidate revision/);
  assert.equal(s.tasks.get(job.id).state,'running');
  s.taskComplete('mac',job.id,'repair',{outcome:'failed',candidateRevision,summary:'check failed',files:{'test.diagnostic.log':'AssertionError: read happened\n'+'x'.repeat(20000),'reviewer.findings.json':finding,'raw.log':'private raw data'}});
  const related=s.tasks.request('org/core#99',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision:SHA,reason:'related repair'});
  s.taskStart('mac',related.id,'related');
  s.taskComplete('mac',related.id,'related',{outcome:'failed',summary:'related failed',files:{'test.diagnostic.log':'related diagnostic'}});
  assert.equal(s.recoveryFacts([req.ticket])[0].tasks[0].result?.files['test.diagnostic.log'],'retained private artifact');
  s.finish('box','s','builder');
  s.recoveryReport('box','org/core',[{ticket:req.ticket,status:'In Development',labels:['error:builder'],blocked:false}]);
  s.start({...req,id:'assessment',role:'recovery',resource:'heavy'});
  const actor={machine:'box',session:'s',project:'org/core',runId:'assessment'};
  const result=s.recoveryFacts([req.ticket,'org/core#99'],actor);
  assert.equal(result[0].tasks[0].result?.files['test.diagnostic.log'].length,16000);
  assert.equal(result[0].tasks[0].result?.files['raw.log'],'retained private artifact');
  assert.equal(result[0].tasks[0].result?.candidateRevision,candidateRevision);
  assert.deepEqual(JSON.parse(result[0].tasks[0].result!.files['reviewer.findings.json']),JSON.parse(finding));
  assert.equal(result[1].tasks[0].result?.files['test.diagnostic.log'],'retained private artifact');
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
