import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startTestContextServer} from './test-context-server.js';
import {bindTestContext} from './test-context.js';
import {taskBridge} from './recovery-task-bridge.js';
import type {JsonClient} from './fleet-http.js';
import type {FleetRun} from './fleet-store.js';
import {Worker} from 'node:worker_threads';

test('the actual managed bridge admits a build while its parent is blocked in a salvage gate',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'sync-salvage-role-')));mkdirSync(join(root,'.git'));
 const bridge=await taskBridge({} as JsonClient,{id:'builder-one',project:'pyrycode/pyrycode-mobile',role:'builder'} as FleetRun,{request:false,read:false,evidence:false});
 t.after(async()=>{await bridge.close();rmSync(root,{recursive:true});});
 t.after(bindTestContext(root,{runId:'builder-one',project:'pyrycode/pyrycode-mobile',socket:bridge.contextSocket!}));
 const policy=fileURLToPath(new URL('../scripts/test-selection.py',import.meta.url));
 assert.doesNotThrow(()=>execFileSync('python3',['-c',"import runpy,sys;runpy.run_path(sys.argv[1])['check'](sys.argv[2],'gradle',['assembleDebug'])",policy,root],{cwd:root,stdio:'pipe',timeout:5000}));
});

test('frozen context replies while the dispatcher event loop is synchronously blocked',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'blocked-role-parent-')));mkdirSync(join(root,'.git'));
 const responder=await startTestContextServer({id:'builder-one',project:'pyrycode/pyrycode-mobile',role:'builder'});
 t.after(async()=>{await responder.close();rmSync(root,{recursive:true});});
 const release=bindTestContext(root,{runId:'builder-one',project:'pyrycode/pyrycode-mobile',socket:responder.socket});t.after(release);
 const policy=fileURLToPath(new URL('../scripts/test-selection.py',import.meta.url));
 const program=`import runpy,sys,time\np=runpy.run_path(sys.argv[1])\ntime.sleep(3.1)\np['check'](sys.argv[2],'gradle',['assembleDebug'])\ntry:\n p['check'](sys.argv[2],'android',['ui'])\nexcept ValueError as e:\n print(str(e))\nelse:\n raise SystemExit('full builder UI unexpectedly admitted')\n`;
 const result=execFileSync('python3',['-c',program,policy,root],{cwd:root,encoding:'utf8',timeout:8000});
 assert.match(result,/Full acceptance belongs to the dispatcher/);
 assert.doesNotMatch(result,/timed out/);
 await responder.close();assert.equal(responder.worker.threadId,-1);
 assert.equal(existsSync(dirname(responder.socket)),false);
});

test('an exited responder fails closed and disposal removes its private socket directory',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dead-role-parent-')));mkdirSync(join(root,'.git'));
 const responder=await startTestContextServer({id:'builder-one',project:'pyrycode/pyrycode-mobile',role:'builder'});
 t.after(async()=>{await responder.close();rmSync(root,{recursive:true});});
 t.after(bindTestContext(root,{runId:'builder-one',project:'pyrycode/pyrycode-mobile',socket:responder.socket}));
 await responder.worker.terminate();
 const policy=fileURLToPath(new URL('../scripts/test-selection.py',import.meta.url));
 assert.throws(()=>execFileSync('python3',['-c',"import runpy,sys;runpy.run_path(sys.argv[1])['check'](sys.argv[2],'gradle',['assembleDebug'])",policy,root],{cwd:root,stdio:'pipe',timeout:5000}),/Command failed/);
 await responder.close();assert.equal(existsSync(dirname(responder.socket)),false);
 await responder.close();
});

test('failed responder startup cleans its worker and socket directory before any binding exists',async()=>{
 let socket='',worker:Worker|undefined;
 await assert.rejects(startTestContextServer({id:'builder-one',project:'pyrycode/pyrycode-mobile',role:'builder'},(_source,options)=>{
  socket=options.workerData.socket;
  worker=new Worker("throw new Error('role responder startup fault')",options);
  return worker;
 }),/startup fault/);
 assert.equal(worker?.threadId,-1);
 assert.equal(existsSync(dirname(socket)),false);
});
