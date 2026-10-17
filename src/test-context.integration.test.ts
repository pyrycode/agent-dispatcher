import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagedDispatch,bindManagedTestWorktree,managedAgentEnv,managedBridgeActions} from './managed-dispatch.js';
import {FleetStore} from './fleet-store.js';
import {FleetClient,serveFleet} from './fleet-http.js';
import {MachineManager,serveManager} from './machine-manager.js';
import {request} from 'node:http';

test('admitted product binding exists without native flags and is retired only with its managed run',async t=>{
 const project='pyrycode/pyrycode-mobile';
 const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:2}});
 const central=await serveFleet(store,{box:'box-token'},'operator-token',0);
 const centralAddress=central.address();assert.ok(centralAddress&&typeof centralAddress!=='string');
 const manager=new MachineManager({machine:'box',projects:[project],heavyLimit:1,combinedLimit:2},new FleetClient(`http://127.0.0.1:${centralAddress.port}`,'box-token'));
 const local=await serveManager(manager,{[project]:'project-token'},'local-token',0);
 const address=local.address();assert.ok(address&&typeof address!=='string');
 const managed=new ManagedDispatch(project,{PYRY_MANAGER_URL:`http://127.0.0.1:${address.port}`,PYRY_MANAGER_TOKEN:'project-token',PYRY_RECOVERY_TASKS:'0'});
 const root=realpathSync(mkdtempSync(join(tmpdir(),'admitted-test-context-')));mkdirSync(join(root,'.git'));
 t.after(async()=>{await managed.stop();await new Promise<void>(r=>local.close(()=>r()));await new Promise<void>(r=>central.close(()=>r()));store.close();rmSync(root,{recursive:true});});
 await managed.start();managed.beginCycle();const offer=managed.offer(2202,'builder','medium');await managed.endCycle();
 for(let i=0;i<40&&!managed.ready(offer);i++){await manager.tick();await managed.sync();if(!managed.ready(offer))await new Promise(r=>setTimeout(r,50));}
 assert.ok(managed.ready(offer));
 await managed.run(offer,async()=>{
  assert.deepEqual(managedBridgeActions(),{request:false,read:false,evidence:false});
  bindManagedTestWorktree(root);
  const file=join(root,'.git/pyry-test-context/context.json');assert.ok(existsSync(file));
  const context=JSON.parse(readFileSync(file,'utf8'));assert.equal(context.root,root);
  assert.notEqual(managedAgentEnv().PYRY_TASK_SOCKET,context.socket,'task requests and frozen role replies use separate responders');
  const reply=await new Promise<any>((resolve,reject)=>{
   const req=request({socketPath:context.socket,path:'/test-context',method:'POST'},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve(JSON.parse(body)));});
   req.on('error',reject);req.end('{"role":"verifier"}');
  });assert.equal(reply.role,'builder');assert.equal(reply.runId,context.runId);
 });
 assert.equal(existsSync(join(root,'.git/pyry-test-context')),false);
 assert.equal(existsSync(join(root,'.git/pyry-test-managed')),false);
 assert.equal(store.snapshot().runs.length,0);
});
