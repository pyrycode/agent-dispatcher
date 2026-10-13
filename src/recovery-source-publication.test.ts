import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
import {FleetStore} from './fleet-store.js';
import {serveFleet} from './fleet-http.js';
import {validateTaskResult} from './recovery-tasks.js';

const revision='6bf6a1971332440c5fe344ff3018414ecbccc7df';
const limits={box:{heavyLimit:1,combinedLimit:2},mac:{heavyLimit:1,combinedLimit:2}};
function admitted() {
 const store=new FleetStore(':memory:',limits);
 store.start({id:'builder',machine:'box',session:'s',project:'org/core',ticket:'org/core#1947',role:'builder',resource:'medium',locks:[]});
 const task=store.requestTask('box','s','org/core','builder',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision,reason:'Fix demonstrated source publication refusal'});
 store.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
 assert.equal(store.taskStart('mac',task.id,'repair').ok,true);
 return {store,id:task.id};
}
function publication(files:Record<string,string|null>) {
 return {files,message:'Fix dispatcher recovery',review:'PASS',checksPassed:true};
}
// Retain the original failing source unchanged, including all four false matches.
const original=publication({'src/agent-runtime.ts':readFileSync(new URL('./agent-runtime.ts',import.meta.url),'utf8')});

test('original source package is refused as a diagnostic but prepares without changing source bytes',()=>{
 assert.throws(()=>validateTaskResult({outcome:'completed',summary:'checked',files:{'publication.json':JSON.stringify(original)}}),/credential-shaped/);
 const {store,id}=admitted();try {
  const prepared=store.prepareRepair('mac',id,'repair',original);
  assert.equal(prepared.state,'publishing');
  assert.equal(prepared.result?.files['publication.json'],JSON.stringify(original));
  assert.equal(store.snapshot().runs.some(r=>r.id==='task-'+id),false);
  assert.deepEqual(store.prepareRepair('mac',id,'repair',original),prepared);
 }finally{store.close();}
});

test('the complete exact submitted package, including tests and new files, prepares over HTTP',async t=>{
 const names=new Set([...execFileSync('git',['diff','--name-only',revision],{encoding:'utf8'}).trim().split('\n'),...execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split('\n')].filter(Boolean));
 assert.ok(names.has('src/recovery-source-publication.test.ts'));
 const files=Object.fromEntries([...names].map(path=>[path,readFileSync(path,'utf8')]));
 const value={...publication(files),modes:Object.fromEntries([...names].map(path=>[path,statSync(path).mode&0o111?'100755':'100644']))};
 const {store,id}=admitted(),server=await serveFleet(store,{box:'b-test',mac:'m-test'},'a-test',0);
 t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url='http://127.0.0.1:'+address.port+'/tasks/prepare-repair';
 const send=(token:string,session:string,p:ReturnType<typeof publication>=value)=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({machine:'mac',id,session,publication:p})});
 const before=store.snapshot();
 assert.equal((await send('wrong-auth','repair')).status,401);
 assert.equal((await send('b-test','repair')).status,409);
 assert.equal((await send('m-test','wrong-session')).status,409);
 assert.deepEqual(store.snapshot(),before);
 assert.equal((await send('m-test','repair')).status,200);
 assert.equal(store.tasks.get(id).result?.files['publication.json'],JSON.stringify(value));
 assert.equal(store.snapshot().runs.some(r=>r.id==='task-'+id),false);
 assert.equal((await send('m-test','repair')).status,200);
 assert.equal((await send('m-test','repair',publication({'src/changed.ts':'changed'}))).status,409);
});

test('refused source literals and invalid publications retain the exact reservation',async t=>{
 const {store,id}=admitted(),server=await serveFleet(store,{box:'b-test',mac:'m-test'},'a-test',0);
 t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const key='gh'+'p_'+'A'.repeat(36),secret='a'.repeat(24);
 const invalid=[
  publication({'src/key.ts':'export const value="'+key+'";'}),
  publication({'src/key.ts':'// '+key}),
  publication({'src/key.ts':'const token="'+secret+'";'}),
  publication({'src/key.ts':'const token="\\u0061'+secret+'";'}),
  publication({'src/key.ts':'const token=("\\u0061'+secret+'" as string);'}),
  publication({'src/key.ts':'const config={"api_key":"\\u0061'+secret+'"};'}),
  publication({'src/key.ts':'const token=parentEnv /* '+key+' */ .VALUE;'}),
  publication({'src/key.ts':'const token=parentEnv.'+key+';'}),
  publication({'src/key.ts':'const value="gh\\u0070_'+ 'A'.repeat(36)+'";'}),
  publication({'src/key.ts':'// https'+'://user:'+secret+'@host'}),
  publication({'src/key.ts':'// sk'+'-ant-api03-'+secret}),
  publication({'src/key.ts':'// Bearer '+secret}),
  publication({'src/key.txt':['token',' = ', 'parentEnv.','PYRY_DEV_AGENTS_TOKEN'].join('')}),
  {...original,review:'FAIL'}, {...original,checksPassed:false}, {...original,message:key},
  publication({'../escape.ts':'safe'}),publication({'/absolute.ts':'safe'}),
  publication({'src/empty.ts':42 as any}),publication({}),
  {...original,modes:{'src/agent-runtime.ts':'120000'}},
  publication({'src/huge.ts':'x'.repeat(4*1024*1024)}),
 ];
 for(const value of invalid) {
  const before=store.snapshot();
  assert.throws(()=>store.prepareRepair('mac',id,'repair',value));
  assert.deepEqual(store.snapshot(),before);
  assert.equal(store.tasks.get(id).state,'running');
  const response:Response=await fetch('http://127.0.0.1:'+address.port+'/tasks/prepare-repair',{method:'POST',headers:{authorization:'Bearer m-test','content-type':'application/json'},body:JSON.stringify({id,session:'repair',publication:value})});
  assert.equal(response.status,409);
  assert.deepEqual(store.snapshot(),before);
 }
});
