import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore} from './fleet-store.js';
import {serveFleet,JsonClient} from './fleet-http.js';

const request={recipe:'dispatcher-repair' as const,capability:'dispatcher-repair' as const,revision:'a'.repeat(40),reason:'Retain this demonstrated defect'};

test('service refuses old and new repair execution and publication paths',async t=>{
 const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:2}});
 let githubCalls=0;
 const server=await serveFleet(store,{box:'machine-test'},'operator-test',0,'127.0.0.1',{request:async()=>{githubCalls++;throw new Error('Unexpected GitHub write');}} as any);
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const machine=new JsonClient('http://127.0.0.1:'+address.port,'machine-test');
 const operator=new JsonClient('http://127.0.0.1:'+address.port,'operator-test');
 store.tasks.report('box',{capabilities:['dispatcher-repair'],ready:true});
 const old=store.tasks.request('org/core#1',request);
 assert.deepEqual(await machine.call('/tasks/queue',{}),[]);
 for(const client of [machine,operator]) {
  await assert.rejects(client.call('/tasks/start',{id:old.id,machine:'box',session:'s'}),/disabled/);
  await assert.rejects(client.call('/tasks/operator-request',{ticket:old.ticket,request}),/disabled|Operator credential/);
  await assert.rejects(client.call('/tasks/publish-repair',{id:old.id}),/retired/);
 }
 await assert.rejects(machine.call('/tasks/request',{request}),/disabled/);
 await assert.rejects(machine.call('/start',{id:'bypass',machine:'box',session:'s',project:'org/core',ticket:'org/core#@task-'+old.id,role:'recovery-task',resource:'heavy',locks:[],supportTaskId:old.id,parentTicket:old.ticket}),/disabled/);
 await assert.rejects(machine.call('/tasks/cancel-queued',{id:old.id,reason:'Not needed'}),/Operator credential/);
 const cancelled=await operator.call<any>('/tasks/cancel-queued',{id:old.id,reason:'Superseded by reviewed manual work'});
 assert.equal(cancelled.state,'failed');
 assert.deepEqual(await operator.call('/tasks/cancel-queued',{id:old.id,reason:'Superseded by reviewed manual work'}),cancelled);
 assert.equal(store.snapshot().runs.length,0);
 assert.equal(store.controlTarget(),undefined);
 assert.equal(githubCalls,0);
 const native=await operator.call<any>('/tasks/operator-request',{ticket:'org/core#2',request:{recipe:'platform-probe',capability:'linux-amd64',reason:'Check the preserved native path'}});
 store.tasks.report('box',{capabilities:['linux-amd64','dispatcher-repair'],ready:true});
 assert.equal((await machine.call<any[]>('/tasks/queue',{}))[0].id,native.id);
 assert.equal((await machine.call<any>('/tasks/start',{id:native.id,session:'probe'})).ok,true);
 await machine.call('/tasks/complete',{id:native.id,session:'probe',result:{outcome:'completed',summary:'Route available only',files:{}}});
});

test('queued cancellation cannot settle a started or publishing worker',()=>{
 const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:2}});
 try {
  const task=store.tasks.request('org/core#1',request);
  store.tasks.report('box',{capabilities:['dispatcher-repair'],ready:true});
  store.taskStart('box',task.id,'s');
  assert.throws(()=>store.cancelQueuedTask(task.id,'Stop it'),/unstarted/);
  assert.equal(store.snapshot().runs.length,1);
  store.prepareRepair('box',task.id,'s',{files:{'fix.txt':'private patch'},message:'Fix',review:'PASS',checksPassed:true});
  assert.throws(()=>store.cancelQueuedTask(task.id,'Stop it'),/unstarted/);
  assert.ok(store.tasks.get(task.id).result?.files['publication.json']);
 } finally {store.close();}
});
