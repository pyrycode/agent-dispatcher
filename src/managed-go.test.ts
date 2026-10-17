import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {managedGoPath} from './managed-go.js';
import {bindTestContext} from './test-context.js';
import {taskBridge} from './recovery-task-bridge.js';
import type {JsonClient} from './fleet-http.js';
import type {FleetRun} from './fleet-store.js';
import {buildCodexInvocation,resolveAgentShellEnv} from './agent-runner.js';

const execute=promisify(execFile);
test('ordinary Go uses frozen builder selection before launch and preserves focused/compiler execution',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'managed-go-proof-')));t.after(()=>rmSync(root,{recursive:true}));
 mkdirSync(join(root,'.git'));const bin=join(root,'tools');mkdirSync(bin);
 const marker=join(root,'executed.json');
 writeFileSync(join(bin,'go'),`#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\nexit 17\n`,{mode:0o700});
 const frozen={id:'builder-one',project:'pyrycode/pyrycode',role:'builder',session:'one',ticket:'pyrycode/pyrycode#2202'} as FleetRun;
 const bridge=await taskBridge({} as JsonClient,frozen,{request:false,read:false,evidence:false});t.after(()=>bridge.close());
 const release=bindTestContext(root,{runId:frozen.id,project:frozen.project,socket:bridge.socket});t.after(release);
 const shim=managedGoPath(root,bin+':'+process.env.PATH);t.after(shim.release);
 const env={...process.env,PATH:shim.path,PYRY_TEST_PATH:shim.path,CLAUDE_CODE_ENTRYPOINT:'verifier',PYRY_TASK_SOCKET:'/forged/socket'};
 assert.equal(resolveAgentShellEnv(env).PATH,shim.path,'Codex tool commands retain the generated PATH');
 assert.ok(buildCodexInvocation({cwd:root,role:'builder',model:'',effort:'',shellEnv:resolveAgentShellEnv(env),managedTestPath:true}).args.includes('allow_login_shell=false'));
 assert.ok(!buildCodexInvocation({cwd:root,role:'verifier',model:'',effort:''}).args.includes('allow_login_shell=false'));
 for(const args of [['test','./...'],['-C',root,'test','./...'],['test','-bench','BenchmarkFoo','./...']]) {
  await assert.rejects(execute('go',args,{cwd:root,env}),error=>{
   assert.match(String((error as any).stderr),/Test selection policy/);return true;
  });assert.equal(existsSync(marker),false,'full builder tests never launch Go');
 }
 for(const args of [['test','-race','./internal/thread'],['test','-run','^TestX$','./...'],['build','./...']]) {
  await assert.rejects(execute('go',args,{cwd:root,env}),error=>(error as any).code===17);
  assert.ok(existsSync(marker));rmSync(marker);
 }
 await assert.rejects(execute('go',['test','./internal/thread'],{cwd:root,env:{...env,GOFLAGS:'-run=.'}}),/Command failed/);
 assert.equal(existsSync(marker),false);
 rmSync(join(root,'.git/pyry-test-context'),{recursive:true});
 await assert.rejects(execute('go',['test','./internal/thread'],{cwd:root,env}),/Managed test context was deleted/);
 assert.equal(existsSync(marker),false);
});

test('the same managed Go entry preserves full verifier acceptance',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'managed-go-verifier-')));t.after(()=>rmSync(root,{recursive:true}));
 mkdirSync(join(root,'.git'));const bin=join(root,'tools');mkdirSync(bin);
 writeFileSync(join(bin,'go'),'#!/bin/sh\nexit 23\n',{mode:0o700});
 const run={id:'verifier-one',project:'pyrycode/pyrycode',role:'verifier'} as FleetRun;
 const bridge=await taskBridge({} as JsonClient,run,{request:false,read:false,evidence:false});t.after(()=>bridge.close());
 t.after(bindTestContext(root,{runId:run.id,project:run.project,socket:bridge.socket}));
 const shim=managedGoPath(root,bin+':'+process.env.PATH);t.after(shim.release);
 await assert.rejects(execute('go',['test','./...'],{cwd:root,env:{...process.env,PATH:shim.path}}),error=>(error as any).code===23);
});
