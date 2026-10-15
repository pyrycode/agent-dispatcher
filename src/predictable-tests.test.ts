import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FleetStore} from './fleet-store.js';
import {serveFleet} from './fleet-http.js';
import {runAdmittedTests} from './interactive-tests.js';
import {buildGateSpawnEnv,buildLiveGateSpawnEnv,spawnGateCommand} from './dispatch.js';
const project='org/core';

test('offline gates omit live logins and use fresh empty authentication directories',async()=>{
 const root=mkdtempSync(join(tmpdir(),'offline-proof-'));
 try {
  const env=buildGateSpawnEnv({...process.env,CLAUDE_CODE_OAUTH_TOKEN:'test-login',PYRY_LIVE_CLAUDE_TOKEN:'test-live',OPENAI_API_KEY:'test-key',GH_TOKEN:'test-github',CODEX_HOME:'/existing/login'});
  for(const name of ['CLAUDE_CODE_OAUTH_TOKEN','PYRY_LIVE_CLAUDE_TOKEN','OPENAI_API_KEY','GH_TOKEN','CODEX_HOME']) assert.equal(env[name],undefined);
  const outcome=await spawnGateCommand({command:process.execPath+" -e 'console.log(JSON.stringify({codex:process.env.CODEX_HOME,claude:process.env.CLAUDE_CONFIG_DIR}))'",cwd:root,env,timeoutMs:10_000,stdoutPath:join(root,'out'),stderrPath:join(root,'err')});
  assert.equal(outcome.exitCode,0);
  const paths=JSON.parse(readFileSync(join(root,'out'),'utf8'));
  assert.ok(paths.codex.startsWith(tmpdir()));assert.ok(paths.claude.startsWith(tmpdir()));
  assert.equal(existsSync(paths.codex),false);
  assert.equal(buildLiveGateSpawnEnv({CLAUDE_CODE_OAUTH_TOKEN:'test-login'}).CLAUDE_CODE_OAUTH_TOKEN,'test-login');
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('interactive suites and cache cleanup wait for an idle host and retain normal capacity proof',async t=>{
 const root=mkdtempSync(join(tmpdir(),'admitted-suite-'));
 const store=new FleetStore(':memory:',{box:{heavyLimit:2,combinedLimit:3}});
 const server=await serveFleet(store,{box:'machine-test'},'operator-test',0);
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});delete process.env.INTERACTIVE_TEST_CREDENTIAL;});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 process.env.INTERACTIVE_TEST_CREDENTIAL='machine-test';
 const cache=join(root,'cache');mkdirSync(cache);writeFileSync(join(cache,'README'),'This directory holds cached build artifacts from the Go build system.');
 const config={machine:'box',projects:[project],claimsUrl:'http://127.0.0.1:'+address.port,claimsTokenEnv:'INTERACTIVE_TEST_CREDENTIAL',receiptDirectory:join(root,'receipts'),idleCache:{directory:cache,maxBytes:1}};
 store.start({id:'busy',machine:'box',session:'s',project,ticket:project+'#2',role:'builder',resource:'medium',locks:[]});
 let calls=0;
 const spawn=async(req:any)=>{
  calls++;
  assert.equal(store.snapshot().runs[0]?.role,'interactive-test');
  assert.deepEqual(store.start({id:'overlap',machine:'box',session:'s',project,ticket:project+'#3',role:'builder',resource:'light',locks:[]}),{ok:false,reason:'capacity'});
  if(req.command==='go clean -cache') assert.equal(req.env.GOCACHE,cache);
  return {exitCode:0,timedOut:false,spawnError:null};
 };
 await assert.rejects(runAdmittedTests(config,project,['pnpm','test'],spawn),/capacity/);assert.equal(calls,0);
 store.finish('box','s','busy');
 assert.equal(await runAdmittedTests(config,project,['pnpm','test'],spawn),0);assert.equal(calls,2);
 assert.equal(store.snapshot().runs.length,0);
 const receipts=readdirSync(config.receiptDirectory).map(name=>JSON.parse(readFileSync(join(config.receiptDirectory,name,'receipt.json'),'utf8')));
 assert.ok(receipts.some(r=>r.state==='finished'));assert.ok(receipts.some(r=>r.state==='refused'));
});

 test('unrelated fleet commands keep machine-readable JSON and never load dispatcher settings',async t=>{
  const root=mkdtempSync(join(tmpdir(),'fleet-cli-json-'));
  const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:1}});
  store.setRunner('codex');
  const server=await serveFleet(store,{box:'machine-test'},'operator-test',0);
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(root,{recursive:true,force:true});});
  const address=server.address() as {port:number},config=join(root,'config.json');
  writeFileSync(config,JSON.stringify({claimsUrl:'http://127.0.0.1:'+address.port,claimsOperatorTokenEnv:'TEST_CLAIMS_TOKEN'}),{mode:0o600});
  const reply=await promisify(execFile)(process.execPath,['--import','tsx','src/fleet-bin.ts','runner',config],{env:{PATH:process.env.PATH,HOME:root,TEST_CLAIMS_TOKEN:'operator-test'},timeout:10_000});
  assert.equal(JSON.parse(reply.stdout).runner,'codex');
 });
