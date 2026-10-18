import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {availableDiskBytes, diskAdmission} from './disk-admission.js';
import {FleetStore} from './fleet-store.js';
import {MachineManager, type MachineConfig} from './machine-manager.js';
import type {WorkOffer} from './machine-scheduler.js';

const project='org/core';
const offer=(n:number,role='builder',resource:WorkOffer['resource']='medium'):WorkOffer=>({project,ticket:`${project}#${n}`,role,resource,key:String(n),order:n,locks:[]});
function fixture(probe:(path:string)=>Promise<number>,extra={}) {
  const store=new FleetStore(':memory:',{mac:{heavyLimit:3,combinedLimit:5}});
  const started:string[]=[];
  const claims={snapshot:async()=>store.snapshot(),start:async(r:any)=>{started.push(r.ticket);return store.start(r);},finish:async(s:string,id:string)=>store.finish('mac',s,id)};
  const config:MachineConfig={machine:'mac',heavyLimit:3,combinedLimit:5,ticketLimit:5,projects:[project],diskAdmission:{path:tmpdir(),minFreeBytes:200},...extra};
  const manager=new MachineManager(config,claims,Date.now,undefined,probe);
  return {store,started,manager,config};
}

test('below floor or unknown disk space holds medium builders and heavy work before reservation; light reconciliation continues',async t=>{
  for(const value of [199,NaN,-1,null]) {
    const f=fixture(async()=>{if(value===null)throw new Error('statfs unavailable');return value;});
    t.after(()=>f.store.close());
    const light={...offer(3,'reconcile','light'),ticket:project+'#@reconcile',locks:[project+':reconcile']};
    f.manager.offer(project,'s',[offer(1),offer(2,'verifier','heavy'),light]);
    await f.manager.tick();
    assert.deepEqual(f.started,[light.ticket]);
    assert.equal(f.store.snapshot().claims.filter(c=>/#[1-9]\d*$/.test(c.ticket)).length,0);
    const status=await f.manager.status();
    assert.equal(status.diskAdmission?.state,'waiting-storage');
    assert.deepEqual(status.queue.filter(q=>q.ticket!==light.ticket).map(q=>q.state),['waiting-storage','waiting-storage']);
  }
});

test('each new start gets a fresh disk probe and a later poll resumes automatically at the floor',async t=>{
  let free=200,probes=0;
  const f=fixture(async()=>{probes++;const observed=free;free=199;return observed;});t.after(()=>f.store.close());
  f.manager.offer(project,'s',[offer(1),offer(2)]);
  await f.manager.tick();
  assert.deepEqual(f.started,[project+'#1']);
  assert.equal(probes,2);
  assert.deepEqual(f.store.snapshot().claims.map(c=>c.ticket),[project+'#1']);
  free=200;
  await f.manager.tick();
  assert.deepEqual(f.started,[project+'#1',project+'#2']);
});

test('concurrent scheduling calls share the in-flight probe and cannot admit a second job from its reading',async t=>{
  let release!:(value:number)=>void,entered!:()=>void,probes=0;
  const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const first=new Promise<number>(resolve=>{release=resolve;});
  const f=fixture(async()=>{probes++;entered();return probes===1?first:0;});t.after(()=>f.store.close());
  f.manager.offer(project,'s',[offer(1),offer(2)]);
  const ticks=Array.from({length:15},()=>f.manager.tick());
  await waiting;assert.equal(probes,1);
  release(200);await Promise.all(ticks);
  assert.equal(probes,2);
  assert.deepEqual(f.started,[project+'#1']);
});

test('a disk-producing stage cannot bypass the floor through a light resource label',async t=>{
  for(const role of ['builder','developer','verifier','qa','code-review']) {
    const f=fixture(async()=>0);t.after(()=>f.store.close());
    f.manager.offer(project,'s',[offer(1,role,'light')]);await f.manager.tick();
    assert.equal(f.started.length,0,role);
    assert.equal((await f.manager.status()).queue[0].state,'waiting-storage');
  }
});

test('a failed probe preserves existing grants, ownership, project drains and operator change history',async t=>{
  let fail=false;
  const f=fixture(async()=>{if(fail)throw new Error('read failed');return 200;});t.after(()=>f.store.close());
  f.manager.offer(project,'s',[offer(1)]);await f.manager.tick();
  const snapshot=structuredClone(f.store.snapshot());
  await f.manager.setProjectDraining(project,true,()=>{});
  const drains=structuredClone(f.config.drainingProjects);
  const history=structuredClone(f.config.projectDrainChanges);
  fail=true;
  f.manager.offer(project,'s',[offer(1),offer(2)]);await f.manager.tick();
  assert.deepEqual(structuredClone(f.store.snapshot()),snapshot);
  assert.deepEqual((await f.manager.grants(project,'s')).map(r=>r.id),snapshot.runs.map(r=>r.id));
  const status=await f.manager.status();
  assert.equal(status.queue[0].state,'reserved-or-running');
  assert.equal(status.queue[1].state,'project-draining');
  assert.deepEqual(f.config.drainingProjects,drains);
  assert.deepEqual(f.config.projectDrainChanges,history);
});

test('native heavy support offers wait before authority start while the fixed light platform probe can be admitted',async()=>{
  const tasks=[{id:'a'.repeat(64),ticket:project+'#1',request:{recipe:'dispatcher-repair'}},
    {id:'b'.repeat(64),ticket:project+'#2',request:{recipe:'platform-probe'}}];
  const starts:any[]=[];
  const claims={snapshot:async()=>({runs:[],claims:[]}),start:async(r:any)=>{starts.push(r);return {ok:false as const,reason:'locked' as const};},finish:async()=>{},
    call:async<T>(path:string)=>{return (path==='/tasks/queue'?tasks:[]) as T;}};
  const manager=new MachineManager({machine:'mac',projects:[project],heavyLimit:3,combinedLimit:5,diskAdmission:{path:tmpdir(),minFreeBytes:200}},claims,Date.now,undefined,async()=>0);
  await manager.support('scheduler');
  assert.deepEqual(starts.map(r=>r.supportTaskId),['b'.repeat(64)]);
  assert.equal((await manager.status()).queue.find(q=>q.parentTicket===project+'#1')?.state,'waiting-storage');
});

test('target verifier handoff checks disk before confirming ownership transfer',async()=>{
  let free=199;
  const calls:string[]=[];
  const work=offer(1,'verifier');
  const claims={snapshot:async()=>({runs:[],claims:[{ticket:work.ticket,machine:'source',generation:'g',created:1}],
    verifierHandoffs:[{commandId:'h',ticket:work.ticket,source:'source',target:'mac'}]}) as any,
    start:async()=>({ok:false as const,reason:'locked' as const}),finish:async()=>{},call:async<T>(path:string)=>{calls.push(path);return {} as T;}};
  const manager=new MachineManager({machine:'mac',projects:[project],heavyLimit:3,combinedLimit:5,diskAdmission:{path:tmpdir(),minFreeBytes:200}},claims,Date.now,undefined,async()=>free);
  manager.offer(project,'s',[work]);
  await assert.rejects(manager.confirmVerifierHandoff(project,'s','h'),/waiting-storage/);
  assert.deepEqual(calls,[]);
  free=200;await manager.confirmVerifierHandoff(project,'s','h');
  assert.deepEqual(calls,['/verification-handoff/confirm']);
});

test('real local statfs measures caller-available free bytes and configuration fails closed',async()=>{
  const measured=await availableDiskBytes(tmpdir());
  assert.ok(Number.isSafeInteger(measured)&&measured>=0);
  assert.equal((await diskAdmission({path:tmpdir(),minFreeBytes:1})).allowed,measured>=1);
  assert.equal((await diskAdmission({path:'/missing-disk-admission-fixture',minFreeBytes:1})).state,'waiting-storage');
  for(const config of [{path:'relative',minFreeBytes:1},{path:tmpdir(),minFreeBytes:0},{path:tmpdir(),minFreeBytes:NaN}])
    await assert.rejects(diskAdmission(config),/configuration/);
});

test('local drains and withdrawn offers remain authoritative while an asynchronous handoff disk probe waits',async()=>{
  for(const change of ['machine-drain','project-drain','withdraw-offer']) {
    let release!:(value:number)=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    const probe=new Promise<number>(resolve=>{release=resolve;});
    const work=offer(1,'verifier');
    const calls:string[]=[];
    const claims={snapshot:async()=>({runs:[],claims:[{ticket:work.ticket,machine:'source',generation:'g',created:1}],
      verifierHandoffs:[{commandId:'h',ticket:work.ticket,source:'source',target:'mac'}]}) as any,
      start:async()=>({ok:false as const,reason:'locked' as const}),finish:async()=>{},call:async<T>(path:string)=>{calls.push(path);return {} as T;}};
    const manager=new MachineManager({machine:'mac',projects:[project],heavyLimit:3,combinedLimit:5,diskAdmission:{path:tmpdir(),minFreeBytes:200}},claims,Date.now,undefined,async()=>{entered();return probe;});
    manager.offer(project,'s',[work]);
    const confirm=manager.confirmVerifierHandoff(project,'s','h');
    await waiting;
    if(change==='machine-drain')manager.draining=true;
    else if(change==='project-drain')await manager.setProjectDraining(project,true,()=>{});
    else manager.offer(project,'s',[]);
    release(200);
    await assert.rejects(confirm,/held/,change);
    assert.deepEqual(calls,[],change);
  }
});
