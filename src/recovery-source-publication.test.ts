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
  assert.equal(response.status,409);
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
