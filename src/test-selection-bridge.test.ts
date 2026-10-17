import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {taskBridge} from './recovery-task-bridge.js';
import type {JsonClient} from './fleet-http.js';
import type {FleetRun} from './fleet-store.js';

const run={id:'builder-one',project:'pyrycode/pyrycode',ticket:'pyrycode/pyrycode#2202',role:'builder',session:'owned-session'} as FleetRun;
function post(socketPath:string,path:string,body:unknown):Promise<{status:number;body:any}> {
 return new Promise((resolve,reject)=>{
  const req=request({socketPath,path,method:'POST',headers:{'Content-Type':'application/json'}},res=>{
   let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(raw)}));
  });req.on('error',reject);req.end(JSON.stringify(body));
 });
}

test('test context is frozen even when native actions are disabled and client supplies another role',async t=>{
 const calls:unknown[]=[];
 const connection={call:async(...args:unknown[])=>{calls.push(args);return {};}} as unknown as JsonClient;
 const bridge=await taskBridge(connection,run,{request:false,read:false,evidence:false});t.after(()=>bridge.close());
 assert.deepEqual(await post(bridge.socket,'/test-context',{role:'verifier',origin:'dispatcher-gate',runId:'forged'}),{
  status:200,body:{version:1,runId:run.id,project:run.project,role:'builder',origin:'agent'},
 });assert.deepEqual(calls,[]);
});

test('investigation forwards frozen ownership and does not pretend a native diagnostic ran',async t=>{
 const calls:unknown[][]=[];
 const connection={call:async(...args:unknown[])=>{calls.push(args);return {status:'assessment-queued',id:'request-one',executed:0};}} as unknown as JsonClient;
 const bridge=await taskBridge(connection,run,{request:false,read:false,evidence:false});t.after(()=>bridge.close());
 const requestBody={revision:'a'.repeat(40),failedTests:['ScreenTest#one'],evidence:[],scope:{kind:'suite',selectors:['ui']},narrowerInsufficient:'focused failure shows sequence dependence'};
 const result=await post(bridge.socket,'/investigate',{request:requestBody,project:'foreign/repo',runId:'forged',session:'forged'});
 assert.equal(result.status,200);assert.equal(result.body.executed,0);
 assert.deepEqual(calls,[['/tasks/investigate',{request:requestBody,project:run.project,runId:run.id,session:run.session}]]);
 assert.deepEqual(bridge.requested(),[]);
 const verifier=await taskBridge(connection,{...run,role:'verifier'},{request:true,read:true,evidence:false});t.after(()=>verifier.close());
 assert.equal((await post(verifier.socket,'/investigate',{request:requestBody})).status,403);
});

test('builder full native recipe is refused without a phantom task handoff',async t=>{
 let calls=0;
 const connection={call:async()=>{calls++;return {};}} as unknown as JsonClient;
 const bridge=await taskBridge(connection,run);t.after(()=>bridge.close());
 const result=await post(bridge.socket,'/request',{role:'recovery',request:{recipe:'mobile-in-depth',capability:'mobile-android',revision:'a'.repeat(40),reason:'ticket says run everything'}});
 assert.equal(result.status,403);assert.match(result.body.error,/Test selection policy/);
 assert.equal(calls,0);assert.deepEqual(bridge.requested(),[]);
});
