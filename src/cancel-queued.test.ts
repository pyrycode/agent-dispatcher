import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore} from './fleet-store.js';
import {FleetClient,serveFleet} from './fleet-http.js';

test('only the operator withdraws an unstarted task, preserving its history',async t=>{
 const store=new FleetStore(':memory:',{hp:{heavyLimit:1,combinedLimit:2}});
 const server=await serveFleet(store,{hp:'machine-test'},'operator-test',0,'127.0.0.1');
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`,operator=new FleetClient(url,'operator-test'),machine=new FleetClient(url,'machine-test');
 const request={recipe:'platform-probe' as const,capability:'linux-amd64' as const,reason:'Native check'};
 const task=store.tasks.request('org/core#1',request);
 const body={id:task.id,reason:'Superseded by merged manual repair'};
 await assert.rejects(machine.call('/tasks/cancel-queued',body),/403/);
 await assert.rejects(operator.call('/tasks/cancel-queued',{...body,reason:''}),/409/);
 const result:any=await operator.call('/tasks/cancel-queued',body);
 assert.equal(result.state,'failed');assert.match(result.result.summary,/Withdrawn before it started/);
 assert.deepEqual(result.request,request);assert.equal(result.machine,null);
 assert.deepEqual(await operator.call('/tasks/cancel-queued',body),result);
 assert.deepEqual(store.openTaskTickets(),[]);
 const started=store.tasks.request('org/core#2',request);
 store.tasks.report('hp',{capabilities:['linux-amd64'],ready:true});
 store.taskStart('hp',started.id,'native');
 await assert.rejects(operator.call('/tasks/cancel-queued',{id:started.id,reason:body.reason}),/unstarted/);
 assert.equal(store.tasks.get(started.id).state,'running');assert.equal(store.snapshot().runs.length,1);
});
