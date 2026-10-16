import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore} from './fleet-store.js';
import {FleetClient,serveFleet} from './fleet-http.js';
import {GitHubBroker} from './github-broker.js';

test('only an operator can select an upstream-main controller revision',async t=>{
 const store=new FleetStore(':memory:',{hp:{heavyLimit:1,combinedLimit:2}});
 const revision='a'.repeat(40);let accepted=true;
 const github=new GitHubBroker({token:'test-token',projects:['pyrycode/agent-dispatcher'],fetcher:async()=>new Response(JSON.stringify({
  status:accepted?'ahead':'diverged',merge_base_commit:{sha:accepted?revision:'b'.repeat(40)}}),{status:200}) as any});
 const server=await serveFleet(store,{hp:'machine-test'},'operator-test',0,'127.0.0.1',github,undefined,'pyrycode/agent-dispatcher');
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`,operator=new FleetClient(url,'operator-test'),machine=new FleetClient(url,'machine-test');
 await assert.rejects(machine.call('/operations/control-target',{revision}),/403/);
 await assert.rejects(operator.call('/operations/control-target',{revision:'main'}),/409/);
 accepted=false;await assert.rejects(operator.call('/operations/control-target',{revision}),/409/);
 assert.equal(store.controlTarget(),undefined);
 accepted=true;assert.deepEqual(await operator.call('/operations/control-target',{revision}),{desired:revision});
 assert.equal(store.controlTarget(),revision);
});
