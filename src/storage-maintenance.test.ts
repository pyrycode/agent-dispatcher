import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {FleetStore,type StartRequest} from './fleet-store.js';
import {serveFleet,JsonClient} from './fleet-http.js';
import type {StorageRequest} from './storage-maintenance.js';

const project='org/product',ticket=project+'#7';
const limits={mac:{heavyLimit:1,combinedLimit:2},linux:{heavyLimit:1,combinedLimit:2}};
function fixture(path=':memory:',parent=false) {
  const s=new FleetStore(path,limits);
  s.workflow.import({project,projectId:'P',statusFieldId:'S',options:{Inbox:'inbox',Done:'done','In Development':'dev',Backlog:'backlog','In Code Review':'review',Halted:'halted'}},[
    {id:'I',issueId:'ISSUE',issueNumber:7,title:'completed useful behaviour',body:'Requirements retained',url:'https://example.test/7',state:'CLOSED',status:'Done',labels:['merged'],blockedBy:[],parentNumber:null,grandparentNumber:null,revision:1,position:0,...(parent?{subIssues:{total:2,completed:0}}:{})},
    {id:'J',issueId:'OTHER',issueNumber:8,title:'other behaviour',body:'Requirements',url:'https://example.test/8',state:'OPEN',status:'In Development',labels:[],blockedBy:[],parentNumber:parent?7:null,grandparentNumber:null,revision:1,position:1},
  ]);return s;
}
const lease=(extra:Partial<StorageRequest>={}):StorageRequest=>({id:randomUUID(),machine:'mac',kind:'ticket',ticket,path:'/tmp/registered-builder-7',head:'a'.repeat(40),...extra});
const run=(id:string,extra:Partial<StartRequest>={}):StartRequest=>({id,machine:'mac',session:'s',project,ticket:project+'#8',role:'builder',resource:'medium',locks:[],workflowVersion:1,...extra});

test('ticket lease excludes affected work across machines but preserves unrelated work and controls',()=>{
  const s=fixture();try {
    const before=s.snapshot().claims,controls=s.desired.document('mac');
    const l=s.acquireStorage(lease());
    // A later operator reopen is allowed, but it cannot start a worker into cleanup.
    s.workflow.change(ticket,{state:'OPEN',status:'In Development'},'operator',randomUUID());
    assert.deepEqual(s.start(run('affected',{ticket,machine:'linux'})),{ok:false,reason:'locked'});
    assert.equal(s.start(run('unrelated')).ok,true);
    assert.throws(()=>s.verifyStorage(l.id,'mac'),/completed|scope changed/);
    assert.deepEqual(s.desired.document('mac'),controls);
    assert.deepEqual(s.snapshot().claims.filter(c=>c.ticket===ticket),before);
    s.finishStorage(l.id,'mac',true,'aborted');
    assert.equal(s.start(run('resumed',{ticket,machine:'linux'})).ok,true);
  }finally{s.close();}
});

test('storage exclusion survives central restart and a lost acquisition reply',()=>{
  const d=mkdtempSync(join(tmpdir(),'storage-restart-')),p=join(d,'claims.sqlite');
  let s=fixture(p);try {
    const request=lease({kind:'cache',ticket:undefined,head:undefined,path:'/tmp/go-cache'});
    s.acquireStorage(request);s.close();s=new FleetStore(p,limits);
    assert.deepEqual(s.start(run('during-restart')),{ok:false,reason:'locked'});
    assert.equal(s.acquireStorage({...request}).id,request.id);
    assert.throws(()=>s.finishStorage(request.id,'linux',true,'complete'),/matching machine/);
    assert.throws(()=>s.finishStorage(request.id,'mac',false,'complete'),/drainage/);
    assert.equal(s.storage.active().length,1);
    s.finishStorage(request.id,'mac',true,'complete');
    s.finishStorage(request.id,'mac',true,'complete');
    assert.equal(s.start(run('after-completion')).ok,true);
    assert.throws(()=>s.acquireStorage(request),/not active/);
  }finally{s.close();rmSync(d,{recursive:true,force:true});}
});

test('old completion retries cannot release a newer lease and reordered JSON is idempotent',()=>{
  const s=fixture();try {
    const first=lease();s.acquireStorage(first);
    const {id,machine,kind,path,ticket:ref,head}=first;
    assert.equal(s.acquireStorage({head,ticket:ref,path,kind,machine,id}).id,id);
    s.finishStorage(id,machine,true,'complete');
    const second=lease();s.acquireStorage(second);
    s.finishStorage(id,machine,true,'complete');
    assert.equal(s.storage.active()[0].id,second.id);
    assert.throws(()=>s.acquireStorage({...second,path:'/tmp/changed'}),/different contents/);
  }finally{s.close();}
});

test('closed split parents and held or failed tickets cannot authorise filesystem cleanup',()=>{
  for(const change of [
    {addLabels:['needs-human:operator-hold']},
    {addLabels:['error:builder']},
    {addLabels:['wip:builder']},
    {state:'OPEN' as const},
    {status:'Halted'},
  ]) {
    const s=fixture();try {s.workflow.change(ticket,change,'operator',randomUUID());assert.throws(()=>s.acquireStorage(lease()),/completed|holds/);assert.equal(s.storage.active().length,0);}finally{s.close();}
  }
  const s=fixture(':memory:',true);try {
    assert.throws(()=>s.acquireStorage(lease()),/Split parents/);
  }finally{s.close();}
});

test('cache budget cannot acquire while any machine worker exists, including light housekeeping',()=>{
  for(const extra of [{},{role:'native-task',resource:'light' as const,ticket:project+'#@task-local'}]) {
    const s=fixture();try {
      assert.equal(s.start(run('already-running',extra)).ok,true);
      assert.throws(()=>s.acquireStorage(lease({kind:'cache',ticket:undefined,head:undefined})),/idle machine/);
      assert.equal(s.snapshot().runs[0].id,'already-running');
      assert.equal(s.storage.active().length,0);
    }finally{s.close();}
  }
});

test('cleanup preserves central machine/project drains and owner changes revoke authority',()=>{
  for(const scope of ['*',project]) {
    const s=fixture();try {
      s.reportMachineCapabilities('mac',['macos'],[project]);
      s.setDesired({machines:['mac'],...(scope==='*'?{}:{project:scope}),change:{work:'drained'}});
      const before=s.desired.document('mac');
      assert.throws(()=>s.acquireStorage(lease()),/drains|controls/);
      assert.deepEqual(s.desired.document('mac'),before);
    }finally{s.close();}
  }
  const dir=mkdtempSync(join(tmpdir(),'storage-owner-')),file=join(dir,'claims.sqlite');
  const s=fixture(file);try {
    const l=s.acquireStorage(lease());
    const connection=new DatabaseSync(file);
    connection.prepare('INSERT INTO fleet_claims VALUES (?,?,?,?)').run(ticket,'linux','changed-generation',Date.now());connection.close();
    assert.throws(()=>s.verifyStorage(l.id,'mac'),/scope changed/);
    assert.equal(s.storage.active().length,1,'lost authority retains the exclusion until safe drainage');
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('a newly queued support task cannot start through a ticket cleanup lease',()=>{
  const s=fixture();try {
    const l=s.acquireStorage(lease());
    const task=s.tasks.request(ticket,{recipe:'platform-probe',capability:'macos-arm64',reason:'Operator requested check'});
    s.tasks.report('mac',{capabilities:['macos-arm64'],ready:true});
    assert.deepEqual(s.taskStart('mac',task.id,'native'),{ok:false,reason:'locked'});
    assert.equal(s.tasks.get(task.id).state,'queued');
    assert.throws(()=>s.verifyStorage(l.id,'mac'),/unfinished support/);
    assert.equal(s.snapshot().runs.length,0);
  }finally{s.close();}
});

test('actual HTTP authority rejects worker credentials and accepts only protected storage operations',async()=>{
  const s=fixture(),server=await serveFleet(s,{mac:'machine-secret',linux:'linux-secret'},'operator-secret',0);
  try {
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const url=`http://127.0.0.1:${address.port}`;
    const worker=new JsonClient(url,'machine-secret'),operator=new JsonClient(url,'operator-secret');
    const request=lease();
    await assert.rejects(()=>worker.call('/storage/acquire',request),/403/);
    assert.equal(s.storage.active().length,0);
    const l=await operator.call<any>('/storage/acquire',request);
    assert.equal(l.id,request.id);
    await assert.rejects(()=>worker.call('/storage/finish',{id:l.id,machine:'mac',drained:true,result:'complete'}),/403/);
    await operator.call('/storage/verify',{id:l.id,machine:'mac'});
    await operator.call('/storage/finish',{id:l.id,machine:'mac',drained:true,result:'complete'});
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));s.close();}
});
