import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FleetStore} from './fleet-store.js';
import {serveFleet} from './fleet-http.js';
import {validateTaskResult} from './recovery-tasks.js';
import {scrubCredentials} from './agent-runtime.js';
import {GitHubBroker} from './github-broker.js';
import {RepairRefusal,validateRepairPublication} from './recovery-source-publication.js';

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

// Generated test values, assembled so the tests themselves remain publishable.
const entropy='aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iLoR9u';
const providerSecrets=[
 ['npm', 'np'+'m_'+entropy.slice(0,36)],
 ['Slack', 'xo'+'xb-123456789012-123456789012-'+entropy.slice(0,24)],
 ['Stripe', 'sk'+'_live_'+entropy],
];
const filenameSecrets=[
 ['secret.yaml','apiVersion: v1\nkind: Secret\nmetadata:\n  name: synthetic-test\ntype: Opaque\ndata:\n  opaque: '+Buffer.from(entropy).toString('base64')+'\n'],
 ['NuGet.config','<?xml version="1.0" encoding="utf-8"?>\n<configuration><packageSourceCredentials><synthetic><add key="Password" value="'+entropy+'" /></synthetic></packageSourceCredentials></configuration>\n'],
];
test('central preparation refuses filename-scoped Kubernetes and NuGet secrets even in excluded directories',async t=>{
 for(const [name,source] of filenameSecrets) for(const prefix of ['', '.hidden/', 'node_modules/', '.git/']) await t.test(prefix+name,()=>{
  assert.equal(scrubCredentials(source),source,name+' exercises the filename-scoped detector');
  const {store,id}=admitted();try {
   const before=store.snapshot(),task=store.tasks.get(id);
   assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({[prefix+name]:source})),{message:'Source package scan refused; retain it privately'});
   assert.deepEqual(store.snapshot(),before);assert.deepEqual(store.tasks.get(id),task);
  }finally{store.close();}
 });
});

test('central preparation refuses excluded lockfiles and ZIP-prefixed filename-scoped secrets',async t=>{
 const yaml=filenameSecrets[0][1],xml=filenameSecrets[1][1],zip=['P','K','\u0003','\u0004'].join('');
 const cases=[
  ['pnpm-lock.yaml',yaml],['node_modules/pnpm-lock.yaml',yaml],
  ['secret.yaml',zip+yaml],['pnpm-lock.yaml',zip+yaml],
  ['NuGet.config',zip+xml],['node_modules/gitleaks.toml-NuGet.config',zip+xml],
 ];
 for(const [path,source] of cases) await t.test(path+(source.startsWith(zip)?' with ZIP prefix':''),()=>{
  assert.equal(scrubCredentials(source),source,'diagnostics do not detect this filename-scoped secret');
  const {store,id}=admitted();try {
   const before=store.snapshot(),task=store.tasks.get(id);
   assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({[path]:source})),{message:'Source package scan refused; retain it privately'});
   assert.deepEqual(store.snapshot(),before);assert.deepEqual(store.tasks.get(id),task);
  }finally{store.close();}
 });
});

test('central preparation retains all five pinned filename rule families',async t=>{
 // These shapes follow the exact sourceCommit in gitleaks-runtime-pin.json.
 const php="<?php return ['secret"+"_key' => 'sk"+'_'+entropy.slice(0,29)+"'];\n";
 const terraform='password = "'+entropy.slice(0,12)+'"\n';
 const cases=[...filenameSecrets,['settings.php',php],['main.tf',terraform],['main.hcl',terraform],
  ['bundle.p12','synthetic bundle bytes'],['bundle.pfx','synthetic bundle bytes']];
 for(const [name,source] of cases) for(const prefix of ['', 'node_modules/gitleaks.toml-']) await t.test(prefix+name,()=>{
  assert.equal(scrubCredentials(source),source,'diagnostics do not detect this filename-scoped secret');
  const {store,id}=admitted();try {
   const before=store.snapshot(),task=store.tasks.get(id);
   assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({[prefix+name]:source})),{message:'Source package scan refused; retain it privately'});
   assert.deepEqual(store.snapshot(),before);assert.deepEqual(store.tasks.get(id),task);
  }finally{store.close();}
 });
});

test('central preparation retains pinned filename predicates for extension-only and mixed-case basenames',async t=>{
 const yaml=filenameSecrets[0][1],xml=filenameSecrets[1][1],zip=['P','K','\u0003','\u0004'].join('');
 // Avoid generic-token matches so these cases require the filename rules.
 const php="<?php return ['secret"+"_key' => 'sk"+'_'+'ab!'.repeat(9)+'12'+"'];\n";
 const terraform='password = "'+entropy.slice(0,8)+'"\n';
 const cases=[
  ['.yaml',yaml],['nested/.yml',yaml],['nested/.YaML',yaml],
  ['.php',php],['nested/.PhP',php],['.tf',terraform],['nested/.hcl',terraform],
  ['.NuGet.config',xml],['nested/prefixedNuGet.CONFIG',xml],
  ['.bundle.p12','synthetic bundle bytes'],['nested/.bundle.PFX','synthetic bundle bytes'],
 ];
 for(const [name,content] of cases) for(const prefix of ['', 'node_modules/gitleaks.toml-']) for(const padding of ['',zip]) {
  const path=prefix+name,source=padding+content;
  await t.test(path+(padding?' with ZIP prefix':''),()=>{
   assert.equal(scrubCredentials(source),source,'diagnostics do not detect this filename-scoped secret');
   const {store,id}=admitted();try {
    const before=store.snapshot(),task=store.tasks.get(id);
    assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({[path]:source})),{message:'Source package scan refused; retain it privately'});
    assert.deepEqual(store.snapshot(),before);assert.deepEqual(store.tasks.get(id),task);
   }finally{store.close();}
  });
 }
});

test('central preparation preserves nonmatching filename suffixes and complete safe publication bytes',()=>{
 const yaml=filenameSecrets[0][1],xml=filenameSecrets[1][1],zip=['P','K','\u0003','\u0004'].join('');
 const php="<?php return ['secret"+"_key' => 'sk"+'_'+'ab!'.repeat(9)+'12'+"'];\n";
 const terraform='password = "'+entropy.slice(0,8)+'"\n';
 const value={...publication({
  '.yaml.backup':yaml,'nested/.yml.txt':yaml,'.php.txt':php,
  '.tf.backup':terraform,'nested/.hcl.txt':terraform,
  'nested/.config':xml,'NuGet.config.backup':xml,
  // The pinned PKCS #12 predicate requires a basename before the suffix.
  '.p12':'synthetic bytes','nested/.pfx':zip+'synthetic bytes',
  '.yaml':zip+'kind: ConfigMap\ndata:\n  color: blue\n',
  'nested/.PhP':'<?php return [];\n','nested/.tf':'name = "synthetic"\n',
  'nested/.hcl':'name = "synthetic"\n','.NuGet.config':zip+'<configuration />\n',
  'deleted.p12':null,
 }),modes:{'nested/.pfx':'100755'}};
 const {store,id}=admitted();try {
  const prepared=store.prepareRepair('mac',id,'repair',value);
  assert.equal(prepared.state,'publishing');
  assert.equal(prepared.result?.files['publication.json'],JSON.stringify(value));
 }finally{store.close();}
});

test('canonical scan copies preserve publication filenames and complete ZIP-prefixed bytes',()=>{
 const zip=['P','K','\u0003','\u0004'].join('');
 const value={...publication({'node_modules/pnpm-lock.yaml':zip+'kind: ConfigMap\ndata:\n  color: blue\n',
  'config/gitleaks.toml-NuGet.config':zip+'<configuration />\n','deleted.yaml':null}),modes:{'node_modules/pnpm-lock.yaml':'100755'}};
 const {store,id}=admitted();try {
  const prepared=store.prepareRepair('mac',id,'repair',value);
  assert.equal(prepared.state,'publishing');
  assert.equal(prepared.result?.files['publication.json'],JSON.stringify(value));
 }finally{store.close();}
});

test('default excluded filenames still receive the byte scan',t=>{
 const {store,id}=admitted(),safe=admitted(),spawn=childProcess.spawnSync,calls:string[]=[];
 t.mock.method(childProcess,'spawnSync',(binary:string,args:string[],options:any)=>{
  calls.push(args[0]);
  assert.equal(args.includes('--ignore-gitleaks-allow'),true);
  assert.equal(args.includes('--redact=100'),true);
  assert.equal(args.includes('--follow-symlinks'),false);
  assert.equal(args.some(value=>value.includes(providerSecrets[0][1])),false);
  assert.equal(Object.keys(options.env).some(name=>name.startsWith('GITLEAKS')),false);
  assert.equal(fs.readFileSync(args[args.indexOf('--config')+1],'utf8'),'[extend]\nuseDefault = true\n');
  assert.equal(fs.readFileSync(args[args.indexOf('--gitleaks-ignore-path')+1],'utf8'),'');
  assert.deepEqual(options.stdio,['pipe','ignore','ignore']);
  assert.equal(options.timeout,10_000);assert.equal(options.killSignal,'SIGKILL');
  return spawn(binary,args,options);
 });
 try {
  const value=publication({'package-lock.json':'{"name":"synthetic-test"}\n'});
  const prepared=safe.store.prepareRepair('mac',safe.id,'repair',value);
  assert.equal(prepared.result?.files['publication.json'],JSON.stringify(value));
  assert.deepEqual(calls,['dir','stdin']);calls.length=0;
  const before=store.snapshot(),task=store.tasks.get(id);
  assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({'package-lock.json':'// '+providerSecrets[0][1]+'\n'})),{message:'Source package scan refused; retain it privately'});
  assert.deepEqual(calls,['dir']); // Canonical names now expose the credential before stdin.
  assert.deepEqual(store.snapshot(),before);assert.deepEqual(store.tasks.get(id),task);
 }finally{store.close();safe.store.close();}
});

test('central preparation refuses provider secrets missed by diagnostic patterns',()=>{
 for(const [provider,value] of providerSecrets) {
  const source='// '+value+'\n';
  assert.equal(scrubCredentials(source)===source,true,provider+' exercises the additional detector');
  const {store,id}=admitted();try {
   const before=store.snapshot();
   assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({'notes.txt':source})),/Source package scan refused/);
   assert.deepEqual(store.snapshot(),before);
   assert.equal(store.tasks.get(id).state,'running');
  }finally{store.close();}
 }
});

test('binary-looking source and source beyond the first scanner fragment are still scanned',()=>{
 for(const source of ['PK\u0003\u0004'+providerSecrets[0][1], 'safe\n'.repeat(30_000)+'// '+providerSecrets[0][1]]) {
  const {store,id}=admitted();try {
   const before=store.snapshot(),task=store.tasks.get(id);
   assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({'payload.bin':source})),{message:'Source package scan refused; retain it privately'});
   assert.deepEqual(store.snapshot(),before);assert.deepEqual(store.tasks.get(id),task);
  }finally{store.close();}
 }
});

test('source comments, submitted ignores and hostile ambient settings cannot suppress the pinned scan',t=>{
 const directory=fs.mkdtempSync(join(tmpdir(),'pyry-hostile-scan-'));
 const cwd=process.cwd(),config=join(directory,'.gitleaks.toml'),baseline=join(directory,'baseline.json');
 const hostile='[[allowlists]]\nregexes = [".*"]\n';
 fs.writeFileSync(config,hostile);
 fs.writeFileSync(join(directory,'.gitleaksignore'),':npm-access-token:1\n');
 fs.writeFileSync(baseline,JSON.stringify([{RuleID:'npm-access-token',StartLine:1,Secret:providerSecrets[0][1]}]));
 const settings={GITLEAKS_CONFIG:config,GITLEAKS_CONFIG_TOML:hostile,GITLEAKS_BASELINE_PATH:baseline,GITLEAKS_IGNORE_PATH:directory};
 const previous=Object.fromEntries(Object.keys(settings).map(name=>[name,process.env[name]]));
 const {store,id}=admitted();
 try {
  process.chdir(directory);Object.assign(process.env,settings);
  const spawn=childProcess.spawnSync;
  t.mock.method(childProcess,'spawnSync',(binary:string,args:string[],options:any)=>{
   assert.equal(args.includes('--ignore-gitleaks-allow'),true);
   assert.equal(args.includes('--redact=100'),true);
   assert.equal(args.some(value=>value.includes(providerSecrets[0][1])),false);
   assert.equal(Object.keys(options.env).some(name=>name.startsWith('GITLEAKS')),false);
   assert.notEqual(options.cwd,directory);
   assert.deepEqual(options.stdio,['pipe','ignore','ignore']);
   assert.equal(fs.readFileSync(args[args.indexOf('--config')+1],'utf8'),'[extend]\nuseDefault = true\n');
   assert.equal(fs.readFileSync(args[args.indexOf('--gitleaks-ignore-path')+1],'utf8'),'');
   assert.equal(fs.statSync(options.cwd).mode&0o777,0o700);
   return spawn(binary,args,options);
  });
  for(const [name,source] of [['notes.txt','// '+providerSecrets[0][1]+' // gitleaks:allow\n'],...filenameSecrets.map(([name,source])=>['.hidden/'+name,source.trimEnd()+(name.endsWith('.yaml')?' # gitleaks:allow\n':' <!-- gitleaks:allow -->\n')])]) {
   const before=store.snapshot(),task=store.tasks.get(id);
   assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({
    '.gitleaks.toml':hostile,'default.toml':hostile,
    '.gitleaksignore':name+':npm-access-token:1\n'+name+':kubernetes-secret-yaml:2\n'+name+':nuget-config-password:2\n',
    '.gitignore':'*\n','.ignore':'*\n','.git/config':'[core]\nexcludesfile = .gitignore\n',
    [name]:source,
   })),{message:'Source package scan refused; retain it privately'});
   assert.deepEqual(store.snapshot(),before);assert.deepEqual(store.tasks.get(id),task);
  }
 }finally {
  process.chdir(cwd);
  for(const [name,value] of Object.entries(previous)) {if(value===undefined) delete process.env[name];else process.env[name]=value;}
  store.close();fs.rmSync(directory,{recursive:true,force:true});
 }
});

test('missing, nonregular, changed and unusable scanners, execution errors and real timeouts retain the exact reservation',async t=>{
 for(const failure of ['missing','nonregular','changed','unusable','dir-error','stdin-error','dir-timeout','stdin-timeout']) await t.test(failure,t=>{
  const {store,id}=admitted();
  try {
   const open=fs.openSync,read=fs.readFileSync,write=fs.writeFileSync,spawn=childProcess.spawnSync;
   if(failure==='missing') t.mock.method(fs,'openSync',((path:any,...args:any[])=>{
    if(String(path).endsWith('/gitleaks')) throw new Error('unavailable');
    return (open as any)(path,...args);
   }) as typeof open);
   if(failure==='nonregular') t.mock.method(fs,'fstatSync',()=>({isFile:()=>false}));
   if(failure==='changed') t.mock.method(fs,'readFileSync',((path:any,...args:any[])=>{
    return typeof path==='number'?Buffer.from('changed executable'):(read as any)(path,...args);
   }) as typeof read);
   if(failure==='unusable') t.mock.method(fs,'writeFileSync',((path:any,data:any,options:any)=>{
    return write(path,data,String(path).endsWith('/gitleaks')?{...options,mode:0o600}:options);
   }) as typeof write);
   if(failure.endsWith('-error')) t.mock.method(childProcess,'spawnSync',(binary:string,args:string[],options:any)=>{
    if(!failure.startsWith(args[0]+'-')) return spawn(binary,args,options);
    return {status:2,signal:null,error:undefined,stdout:providerSecrets[0][1],stderr:providerSecrets[0][1]};
   });
   if(failure.endsWith('-timeout')) t.mock.method(childProcess,'spawnSync',(binary:string,args:string[],options:any)=>{
    if(!failure.startsWith(args[0]+'-')) return spawn(binary,args,options);
    const result=spawn(binary,args,{...options,timeout:1});
    assert.equal((result.error as NodeJS.ErrnoException|undefined)?.code,'ETIMEDOUT');
    return result;
   });
   const before=store.snapshot(),task=store.tasks.get(id);
   assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({'src/safe.ts':'export const safe=true;'})),{message:'Source package scan refused; retain it privately'});
   assert.deepEqual(store.snapshot(),before);assert.deepEqual(store.tasks.get(id),task);
  }finally{store.close();}
 });
});

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
 // The package as submitted for pyrycode/pyrycode#3236, read from its own
 // commit. Reading the working tree instead made this test fail for any later
 // change to a file whose unrelated lines the scanner refuses, such as the
 // GitHub client setup in dispatch.ts.
 const submitted='be414ca678e0bbbaaaacb48517a1091033576b8d';
 const names=new Set(execFileSync('git',['diff','--name-only',revision,submitted],{encoding:'utf8'}).trim().split('\n').filter(Boolean));
 assert.ok(names.has('src/recovery-source-publication.test.ts'));
 const files=Object.fromEntries([...names].map(path=>[path,execFileSync('git',['show',`${submitted}:${path}`],{encoding:'utf8',maxBuffer:64*1024*1024})]));
 const modeOf=(path:string)=>execFileSync('git',['ls-tree',submitted,'--',path],{encoding:'utf8'}).split(/\s/)[0];
 const value={...publication(files),modes:Object.fromEntries([...names].map(path=>[path,modeOf(path)==='100755'?'100755':'100644']))};
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
  // A refusal of the submitted bytes is final, so the supervisor can end the task.
  assert.equal(response.status,422);
  assert.equal((await response.json()).refused,true);
  assert.deepEqual(store.snapshot(),before);
 }
});


// Operator regression: actual pinned defaults excluded these submitted basenames.
test('configuration-shaped basenames cannot hide filename-specific credentials',()=>{
 const encoded=['VGhpcy1pcy1hL','XRlc3QtY3JlZ','GVudGlhbA=='].join('');
 const yaml='apiVersion: v1\nkind: Secret\ndata:\n  database: '+encoded+'\n';
 const xml='<configuration><packageSourceCredentials><sample><add key="Password" value="Synthet1c!Pass" /></sample></packageSourceCredentials></configuration>';
 for(const [path,content] of [['config/gitleaks.toml-secret.yaml',yaml],['config/gitleaks.toml-NuGet.config',xml]]) {
  const {store,id}=admitted();
  try {
   const before=store.snapshot();
   assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({[path]:content})),/Source package scan refused/);
   assert.deepEqual(store.snapshot(),before);
   assert.equal(store.tasks.get(id).state,'running');
  }finally {store.close();}
 }
});

// ---------------------------------------------------------------------
// pyrycode/pyrycode#3289, 2026-10-14. A reviewed repair to src/dispatch.ts
// and src/dispatch.test.ts was refused at every supervisor pass. The flagged
// lines were two synthetic provider-key fixtures already on main and two
// ordinary `token: process.env.GITHUB_TOKEN!` lines, none of them changed.
// All values are assembled at runtime so this file itself stays publishable.
const anthropic='sk'+'-ant-';
const fixtureLines=[
 '  const env = buildGateSpawnEnv({ ANTHROPIC_API_KEY: "'+anthropic+'metered", CLAUDE_CODE_OAUTH_TOKEN: "t" });',
 '  const key = "'+anthropic+'api03-" + "k".repeat(48);',
];
const clientLines=['const client = new GitHubClient({','  token: process.env.GITHUB_TOKEN!,','  owner: "org",','});'];
const baseTest=['import { test } from "node:test";',...fixtureLines,'test("old", () => {});',''].join('\n');
const baseSource=['export const VERIFIER_GATE_TIMEOUT_MS = 600_000;',...clientLines,''].join('\n');
const repairedTest=baseTest.replace('test("old", () => {});','test("old", () => {});\ntest("a simulated 686-second gate completes (#3289)", () => {});');
const repairedSource=baseSource.replace('600_000','1_200_000');
const base3289={'src/dispatch.test.ts':baseTest,'src/dispatch.ts':baseSource};

test('#3289: unchanged fixtures and environment reads in changed files no longer refuse a reviewed repair',()=>{
 for(const line of [...fixtureLines,clientLines[1]]) assert.notEqual(scrubCredentials(line),line,'each line is credential-shaped to the diagnostic patterns');
 const value=publication({'src/dispatch.test.ts':repairedTest,'src/dispatch.ts':repairedSource});
 assert.equal(validateRepairPublication(value,base3289),value);
 // Without the base every line is new, and the synthetic literals stay refused.
 assert.throws(()=>validateRepairPublication(value),RepairRefusal);
 // The environment read alone is source syntax, not a credential, base or not.
 assert.doesNotThrow(()=>validateRepairPublication(publication({'src/dispatch.ts':repairedSource})));
 const {store,id}=admitted();try {
  const prepared=store.prepareRepair('mac',id,'repair',value,base3289);
  assert.equal(prepared.state,'publishing');
  assert.equal(prepared.result?.files['publication.json'],JSON.stringify(value));
  // A repeat compares the prepared bytes and does not need the base again.
  assert.deepEqual(store.prepareRepair('mac',id,'repair',value),prepared);
 }finally{store.close();}
});

test('#3289: added or changed lines stay strict for literal secrets',async t=>{
 const secret='aB3dE6gH9jK2mN5pQ8sT1vW4';
 const cases:Array<[string,Record<string,string>]>=[
  ['a new provider key literal',{'src/dispatch.test.ts':repairedTest+'const added = "'+anthropic+'api03-'+secret+'";\n'}],
  ['an edited fixture line',{'src/dispatch.test.ts':repairedTest.replace('metered','metered2')}],
  ['a second copy of an unchanged fixture',{'src/dispatch.test.ts':repairedTest+fixtureLines[0]+'\n'}],
  ['a token literal on a changed line',{'src/dispatch.ts':repairedSource.replace('owner: "org"','owner: "org", token: "'+secret+'"')}],
  ['an undeclared bare identifier',{'src/dispatch.ts':repairedSource+'export const config = { token: '+secret+' };\n'}],
  ['a provider key inside a changed environment read',{'src/dispatch.ts':repairedSource+'const auth = { token: process.env.'+'gh'+'p_'+'A'.repeat(36)+' };\n'}],
  ['a secret in a changed comment',{'src/dispatch.ts':repairedSource+'// token='+secret+'\n'}],
  ['a new file',{'src/new.ts':fixtureLines[0]+'\n'}],
 ];
 for(const [name,files] of cases) await t.test(name,()=>{
  assert.throws(()=>validateRepairPublication(publication(files),base3289),RepairRefusal);
 });
});

test('identifier and environment references are not credentials, in code and in comments',async t=>{
 const accepted:Array<[string,string]>=[
  ['a non-null environment read','export const c = { token: process.env.GITHUB_TOKEN! };'],
  ['a parenthesised cast environment read','export const c = { token: (process.env.GITHUB_TOKEN as string)! };'],
  ['a declared variable','const installationAccessToken = read();\nexport const c = { token: installationAccessToken! };'],
  ['a parameter','export function f(sharedGitHubToken: string) { return { token: sharedGitHubToken }; }'],
  ['a read on this','class C { t = ""; m() { return { token: this.t }; } }'],
  // PR #222 (2026-10-14): a test comment quoting source was refused.
  ['a comment quoting an environment read','// The client reads token: process.env.GITHUB_TOKEN! once at startup.\nexport {};'],
  ['a comment naming a declared variable','const installationAccessToken = read();\n// token: installationAccessToken!\nexport {};'],
 ];
 for(const [name,source] of accepted) await t.test(name,()=>{
  assert.doesNotThrow(()=>validateRepairPublication(publication({'src/client.ts':source})));
 });
 const refused:Array<[string,Record<string,string>]>=[
  ['an undeclared root in a comment',{'src/client.ts':'// token: parentEnv.PYRY_DEV_AGENTS_TOKEN\nexport {};'}],
  ['an undeclared identifier in a comment',{'src/client.ts':'// token: aB3dE6gH9jK2mN5pQ8sT1vW4\nexport {};'}],
  ['an environment read outside source',{'notes.txt':'token: process.env.GITHUB_TOKEN\n'}],
 ];
 for(const [name,files] of refused) await t.test(name,()=>{
  assert.throws(()=>validateRepairPublication(publication(files)),RepairRefusal);
 });
});

test('pinned scanner findings are final refusals; an unavailable scanner is not',t=>{
 try {validateRepairPublication(publication({'notes.txt':'// '+providerSecrets[0][1]+'\n'}));assert.fail('refused');}
 catch(error) {assert.ok(error instanceof RepairRefusal);assert.equal((error as Error).message,'Source package scan refused; retain it privately');}
 const spawn=childProcess.spawnSync;
 t.mock.method(childProcess,'spawnSync',(binary:string,args:string[],options:any)=>{
  // Gitleaks exits 1 on its own fatal errors. That is never a finding.
  if(args[0]==='dir') return {status:1,signal:null,error:undefined,stdout:'',stderr:''};
  return spawn(binary,args,options);
 });
 try {validateRepairPublication(publication({'src/safe.ts':'export const safe=true;'}));assert.fail('refused');}
 catch(error) {assert.ok(!(error instanceof RepairRefusal));assert.equal((error as Error).message,'Source package scan refused; retain it privately');}
});

test('#3289 over HTTP: the base is read from GitHub at the repair revision, and refusals are final',async t=>{
 const reads:string[]=[];let failing=false;
 const github=new GitHubBroker({token:'central',projects:['org/dispatcher'],fetcher:async(input,init)=>{
  const url=new URL(String(input));reads.push(url.pathname+url.search);
  if(failing) return new Response('unavailable',{status:502});
  if(url.pathname==='/repos/org/dispatcher/git/commits/'+revision) return new Response('{"sha":"'+revision+'"}');
  assert.equal(new Headers(init?.headers).get('accept'),'application/vnd.github.raw+json');
  const path=url.pathname.replace('/repos/org/dispatcher/contents/','');
  assert.equal(url.searchParams.get('ref'),revision);
  return Object.hasOwn(base3289,path)?new Response(base3289[path as keyof typeof base3289]):new Response('{"message":"Not Found"}',{status:404});
 }});
 const {store,id}=admitted(),server=await serveFleet(store,{box:'b-test',mac:'m-test'},'a-test',0,'127.0.0.1',github,undefined,'org/dispatcher');
 const other=admitted(),otherServer=await serveFleet(other.store,{box:'b-test',mac:'m-test'},'a-test',0,'127.0.0.1',github,undefined,'org/dispatcher');
 t.after(async()=>{
  for(const s of [server,otherServer]) await new Promise<void>(resolve=>s.close(()=>resolve()));
  store.close();other.store.close();
 });
 const post=(target:typeof server,taskId:string,p:unknown)=>{
  const address=target.address();assert.ok(address&&typeof address!=='string');
  return fetch('http://127.0.0.1:'+address.port+'/tasks/prepare-repair',{method:'POST',headers:{authorization:'Bearer m-test','content-type':'application/json'},body:JSON.stringify({id:taskId,session:'repair',publication:p})});
 };
 const value=publication({'src/dispatch.test.ts':repairedTest,'src/dispatch.ts':repairedSource});
 // A temporary GitHub failure is retryable and keeps the reservation.
 failing=true;
 let before=store.snapshot();
 assert.equal((await post(server,id,value)).status,503);
 assert.deepEqual(store.snapshot(),before);assert.equal(store.tasks.get(id).state,'running');
 failing=false;
 assert.equal((await post(server,id,value)).status,200);
 assert.ok(reads.includes('/repos/org/dispatcher/contents/src/dispatch.ts?ref='+revision));
 assert.equal(store.tasks.get(id).state,'publishing');
 assert.equal(store.snapshot().runs.some(r=>r.id==='task-'+id),false);
 // A new file has no base, so every line is judged. That refusal is final.
 before=other.store.snapshot();
 const response=await post(otherServer,other.id,publication({'src/new.ts':fixtureLines[0]+'\n'}));
 assert.equal(response.status,422);
 assert.deepEqual(await response.json(),{error:'Repair contains credential-shaped text; retain it privately',refused:true});
 assert.deepEqual(other.store.snapshot(),before);assert.equal(other.store.tasks.get(other.id).state,'running');
});

test('a name the repair declares itself must read as source words to be exempt',async t=>{
 // Review of the #3289 fix: a declared name or a read on `this` could carry a
 // low-entropy secret that neither the shapes nor gitleaks would catch.
 for(const value of ['hunter2hunter2hunter2','Summer2026Summer2026x','deadbeefdeadbeefdeadbeef00','abcdefghijklmnopqrstuvwx']) await t.test(value,()=>{
  for(const source of [
   'function '+value+'(){}\nexport const c = { token: '+value+' };\n',
   'class C { m(){ return { token: this.'+value+' }; } }\n',
   'const cfg = {};\n// password: cfg.'+value+'\nexport {};\n',
   '// token: process.env.'+value+'\nexport {};\n',
  ]) assert.throws(()=>validateRepairPublication(publication({'src/a.ts':source})),RepairRefusal,source);
 });
 // A name already declared on an unchanged line is in the repository, whatever it looks like.
 const baseSource='const deadbeefdeadbeefdeadbeef00 = read();\nexport const c = {};\n';
 const changed=baseSource.replace('export const c = {};','export const c = { token: deadbeefdeadbeefdeadbeef00 };');
 assert.doesNotThrow(()=>validateRepairPublication(publication({'src/a.ts':changed}),{'src/a.ts':baseSource}));
 assert.throws(()=>validateRepairPublication(publication({'src/a.ts':changed})),RepairRefusal);
});

test('a task that is not running is refused for its state, not its content',()=>{
 const {store,id}=admitted();try {
  store.taskComplete('mac',id,'repair',{outcome:'failed',summary:'ended',files:{}});
  // Strict content, no base: still a state error, never a final content refusal.
  assert.throws(()=>store.prepareRepair('mac',id,'repair',publication({'src/new.ts':fixtureLines[0]+'\n'})),
   (error:Error)=>!(error instanceof RepairRefusal)&&error.message==='Repair is not running');
 }finally{store.close();}
});

test('base reads need the revision itself, and publication needs a prepared repair',async t=>{
 let commitStatus=404;
 const github=new GitHubBroker({token:'central',projects:['org/dispatcher'],fetcher:async input=>{
  const url=new URL(String(input));
  if(url.pathname==='/repos/org/dispatcher/git/commits/'+revision) return new Response('{"sha":"'+revision+'"}',{status:commitStatus});
  return new Response('{"message":"Not Found"}',{status:404});
 }});
 const {store,id}=admitted(),server=await serveFleet(store,{box:'b-test',mac:'m-test'},'a-test',0,'127.0.0.1',github,undefined,'org/dispatcher');
 t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const post=(route:string,p:unknown)=>fetch('http://127.0.0.1:'+address.port+route,{method:'POST',headers:{authorization:'Bearer m-test','content-type':'application/json'},body:JSON.stringify({id,session:'repair',publication:p})});
 const value=publication({'src/dispatch.test.ts':repairedTest});
 // Every path 404s, but so does the revision. That is not "every file is new".
 const before=store.snapshot();
 assert.equal((await post('/tasks/prepare-repair',value)).status,503);
 assert.deepEqual(store.snapshot(),before);
 // Publication without preparation would skip the source scan entirely.
 const response=await post('/tasks/publish-repair',value);
 assert.equal(response.status,409);
 assert.equal((await response.json()).error,'Repair must be prepared before publication');
 commitStatus=200;
 assert.equal((await post('/tasks/prepare-repair',value)).status,422,'with a readable revision a missing path is a new file');
});
