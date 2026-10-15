import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore} from './fleet-store.js';
import {scrubSpawnEnv,agentSpawnEnv} from './agent-runtime.js';
const request={id:'a',machine:'mac',session:'s',project:'o/r',ticket:'o/r#1',role:'builder',resource:'medium' as const,locks:[]};
test('native-only policy refuses unattended agents and ordinary role-name bypasses centrally',()=>{
 const store=new FleetStore(':memory:',{mac:{heavyLimit:1,combinedLimit:2,unattendedPolicy:'native-only'}});
 try {
  for(const role of ['builder','verifier','refiner','recovery','recovery-task','interactive-test']) assert.deepEqual(store.start({...request,role}),{ok:false,reason:'incapable'});
  assert.deepEqual(store.snapshot().runs,[]);assert.deepEqual(store.snapshot().claims,[]);
  const task=store.tasks.request('o/r#2',{recipe:'platform-probe',capability:'macos-arm64',reason:'Native readiness'});
  store.tasks.report('mac',{capabilities:['macos-arm64'],ready:true});
  assert.equal(store.taskStart('mac',task.id,'native').ok,true);
 } finally {store.close();}
});
test('existing isolated configurations preserve grants and replay before a new restriction',()=>{
 const store=new FleetStore(':memory:',{mac:{heavyLimit:1,combinedLimit:2,unattendedPolicy:'isolated'}});
 try {assert.equal(store.start(request).ok,true);assert.equal(store.start(request).ok,true);}finally{store.close();}
 assert.throws(()=>new FleetStore(':memory:',{mac:{heavyLimit:1,combinedLimit:2,unattendedPolicy:'typo' as any}}),/unattended/);
});
test('dispatcher merge, release and operator environment credentials never reach an agent',()=>{
 const names=['GITHUB_TOKEN','GH_TOKEN','PYRY_RELEASE_TOKEN','FLEET_GITHUB_TOKEN','FLEET_CLAIMS_OPERATOR_TOKEN'];
 const parent={PATH:'/bin',...Object.fromEntries(names.map(name=>[name,'private-value']))};
 const child=scrubSpawnEnv(parent);
 for(const name of names) {assert.equal(child[name],undefined);assert.equal(parent[name as keyof typeof parent],'private-value');}
 assert.equal(child.PATH,'/bin');
});

 test('only an explicitly configured agent publishing token replaces a broad parent token',()=>{
  const parent={GH_TOKEN:'broad-parent',GITHUB_TOKEN:'controller-parent',PYRY_AGENT_GITHUB_TOKEN:'agent-only'};
  const child=agentSpawnEnv(parent,'builder');
  assert.equal(child.GH_TOKEN,'agent-only');assert.equal(child.PYRY_AGENT_GITHUB_TOKEN,undefined);assert.equal(child.GITHUB_TOKEN,undefined);
  assert.equal(agentSpawnEnv({GH_TOKEN:'broad-parent'},'builder').GH_TOKEN,undefined);
 });
