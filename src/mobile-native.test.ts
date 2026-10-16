import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore} from './fleet-store.js';
import {validateTaskRequest} from './recovery-tasks.js';

const revision='a'.repeat(40);
for(const recipe of ['mobile-scripted-evidence','mobile-in-depth'] as const) {
 test(recipe+' is restricted to a pushed Mobile revision and Mobile Android readiness',()=>{
  const request={recipe,revision,capability:'mobile-android' as const,reason:'Run the unchanged native candidate'};
  assert.equal(validateTaskRequest(request).recipe,recipe);
  assert.throws(()=>validateTaskRequest({...request,revision:undefined}),/exact revision/);
  assert.throws(()=>validateTaskRequest({...request,capability:'android-emulator'}),/platform/);
  const store=new FleetStore(':memory:',{hp:{heavyLimit:1,combinedLimit:2}});
  try {
   assert.throws(()=>store.tasks.request('pyrycode/pyrycode#2169',request),/Mobile source/);
   const task=store.tasks.request('pyrycode/pyrycode-mobile#2169',request);
   store.tasks.report('hp',{capabilities:['android-emulator'],ready:true});
   assert.equal(store.tasks.available('hp',task.id),false);
   store.tasks.report('hp',{capabilities:['mobile-android'],ready:true});
   assert.equal(store.tasks.available('hp',task.id),true);
  }finally{store.close();}
 });
 test(recipe+' cannot report a pass without counted native evidence',()=>{
  const store=new FleetStore(':memory:',{hp:{heavyLimit:1,combinedLimit:2}});
  try {
   const task=store.tasks.request('pyrycode/pyrycode-mobile#2169',{recipe,revision,capability:'mobile-android',reason:'native capture'});
   store.tasks.report('hp',{capabilities:['mobile-android'],ready:true});
   store.taskStart('hp',task.id,'native');
   assert.throws(()=>store.taskComplete('hp',task.id,'native',{outcome:'completed',candidateRevision:revision,summary:'zero',files:{}}),/Mobile capture/);
  }finally{store.close();}
 });
 test(recipe+' accepts exact counted reports and rejects partial or wrong-profile claims',()=>{
  const store=new FleetStore(':memory:',{hp:{heavyLimit:1,combinedLimit:2}});
  try {
   const task=store.tasks.request('pyrycode/pyrycode-mobile#2169',{recipe,revision,capability:'mobile-android',reason:'native capture'});
   store.tasks.report('hp',{capabilities:['mobile-android'],ready:true});store.taskStart('hp',task.id,'native');
   const selections=recipe==='mobile-in-depth'?[['ui']]:[['scripted','reply-suggestion'],['scripted','selection-copy']];
   const capture={repository:'pyrycode/pyrycode-mobile',revision,recipe,complete:true,elapsedSeconds:10,errors:[],
    supportingRevisions:{mobile:revision,agents:'b'.repeat(40)},profile:{UI_GATE_FULL:'1',UI_DEVICE_ALL:'1',UI_SHARDS:'2'},
    runs:selections.map(selection=>({command:['python3','/agents/scripts/android-test-gate.py',...selection],exitCode:0,
     counts:{executed:1,passed:1,failed:0,skipped:0}}))};
   const files:Record<string,string>={'mobile/capture.json':JSON.stringify(capture)};
   for(let index=0;index<selections.length;index++)files[`mobile/gate-${index}.xml`]='<testsuite tests="1"><testcase classname="C" name="x"/></testsuite>';
   const result={outcome:'completed' as const,candidateRevision:revision,summary:'counted',files};
   assert.throws(()=>store.taskComplete('hp',task.id,'native',{...result,files:{...files,'mobile/gate-0.xml':'<testsuite tests="2"><testcase classname="C" name="x"/></testsuite>'}}),/Mobile capture/);
   assert.throws(()=>store.taskComplete('hp',task.id,'native',{...result,files:{...files,'mobile/capture.json':JSON.stringify({...capture,revision:'c'.repeat(40)})}}),/Mobile capture/);
   if(recipe==='mobile-in-depth')assert.throws(()=>store.taskComplete('hp',task.id,'native',{...result,files:{...files,'mobile/capture.json':JSON.stringify({...capture,profile:{UI_DEVICE_ALL:'0'}})}}),/Mobile capture/);
   store.taskComplete('hp',task.id,'native',result);
   assert.equal(store.tasks.get(task.id).state,'complete');
  }finally{store.close();}
 });
}
