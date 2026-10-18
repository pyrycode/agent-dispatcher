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
import {artifactManifest,manifestHash} from './recovery-artifacts.js';

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
    {addLabels:['health-hold:github']},
    {addLabels:['held:design']},
    {addLabels:['permission_denied:builder']},
    {addLabels:['pending-verdict:verifier']},
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
    const delayed=lease();
    await assert.rejects(()=>worker.call('/storage/cancel',{request:delayed,drained:true}),/403/);
    await operator.call('/storage/cancel',{request:delayed,drained:true});
    await assert.rejects(()=>operator.call('/storage/acquire',delayed),/not active/);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));s.close();}
});

test('cancellation tombstones settle delayed acquisitions and lost completion replies without touching newer scopes',()=>{
  const s=fixture();try {
    const delayed=lease();
    assert.throws(()=>s.cancelStorage(delayed,false),/drainage/);
    assert.equal(s.storage.active().length,0);
    const cancelled=s.cancelStorage(delayed,true);
    assert.notEqual(cancelled.finished,null);
    assert.throws(()=>s.acquireStorage(delayed),/not active/);
    assert.deepEqual(s.cancelStorage(delayed,true),cancelled);
    assert.throws(()=>s.cancelStorage({...delayed,path:'/tmp/different'},true),/differs/);
    const active=lease();s.acquireStorage(active);
    s.finishStorage(active.id,'mac',true,'complete');
    s.cancelStorage(active,true); // The completion reply was lost.
    const newer=lease();s.acquireStorage(newer);
    s.cancelStorage(delayed,true);
    assert.equal(s.storage.active()[0].id,newer.id);
    assert.throws(()=>s.cancelStorage({...newer,machine:'linux'},true),/differs/);
    assert.equal(s.storage.active()[0].id,newer.id);
  }finally{s.close();}
});

const desktop='pyrycode/pyrycode-desktop',nativeTicket=desktop+'#1975';
function publishedNative(s:FleetStore,attest=true) {
  s.workflow.import({project:desktop,projectId:'PD',statusFieldId:'SD',options:{Inbox:'inbox',Done:'done','In Development':'dev',Backlog:'backlog',Halted:'halted'}},[
    {id:'ID',issueId:'ISSUED',issueNumber:1975,title:'Desktop behaviour',body:'Retain all acceptance requirements',url:'https://example.test/1975',state:'OPEN',status:'In Development',labels:[],blockedBy:[],parentNumber:null,grandparentNumber:null,revision:1,position:0},
  ]);
  const task=s.tasks.request(nativeTicket,{recipe:'desktop-fake-suite',capability:'desktop-fake-suite',revision:'a'.repeat(40),reason:'Pinned native acceptance'});
  const db=(s as unknown as {db:DatabaseSync}).db;
  const result={outcome:'completed',summary:'Published passing native evidence',candidateRevision:'a'.repeat(40),files:{}};
  db.prepare("UPDATE fleet_recovery_tasks SET state='complete',machine='mac',session='native-session',run_id='native-run',result=? WHERE id=?").run(JSON.stringify(result),task.id);
  const capture=JSON.stringify({dependencyReferenceDigest:'b'.repeat(64)});
  const manifest=artifactManifest({'desktop/capture.json':capture});
  db.prepare('INSERT INTO fleet_task_artifacts VALUES (?,?,?,1)').run(task.id,JSON.stringify(manifest),manifestHash(manifest));
  db.prepare('INSERT INTO fleet_task_chunks VALUES (?,?,0,?)').run(task.id,'desktop/capture.json',Buffer.from(capture));
  const request:StorageRequest={id:randomUUID(),machine:'mac',kind:'native-task',taskId:task.id,ticket:nativeTicket,head:'a'.repeat(40),path:'/retained/desktop-captures/'+task.id+'/desktop',referenceDigest:'b'.repeat(64),artifactDigest:manifestHash(manifest)};
  if(attest)s.attestStorage(request);
  return {task,db,request};
}

test('native dependency scope preserves project drains and excludes only its exact task',()=>{
  const s=fixture();try {
    const {task,request}=publishedNative(s);
    s.reportMachineCapabilities('mac',['macos'],[project,desktop]);
    s.setDesired({machines:['mac'],project:desktop,change:{work:'drained'}});
    const controls=s.desired.document('mac'),claims=s.snapshot().claims;
    const held=s.acquireStorage(request);
    assert.equal(s.storage.blocks('mac',nativeTicket,undefined,task.id),true);
    assert.equal(s.storage.blocks('linux',nativeTicket,undefined,'other-native-task'),false);
    assert.equal(s.start(run('unrelated-native-scope')).ok,true);
    assert.deepEqual(s.desired.document('mac'),controls);
    assert.deepEqual(s.snapshot().claims.filter(c=>c.ticket===nativeTicket),claims.filter(c=>c.ticket===nativeTicket));
    s.workflow.change(nativeTicket,{addLabels:['held:operator']},'operator',randomUUID());
    assert.throws(()=>s.verifyStorage(held.id,'mac'),/holds/);
    assert.equal(s.storage.active().length,1);
    s.cancelStorage(request,true);
  }finally{s.close();}
});

test('native cleanup refuses failed attention unpublished mismatched or currently running tasks',()=>{
  for(const variation of ['failed','attention','publishing','unpublished','revision','run','hold']) {
    const s=fixture();try {
      const {task,db,request}=publishedNative(s);
      if(['failed','attention','publishing'].includes(variation))db.prepare('UPDATE fleet_recovery_tasks SET state=? WHERE id=?').run(variation,task.id);
      if(variation==='unpublished')db.prepare('UPDATE fleet_task_artifacts SET committed=0 WHERE task=?').run(task.id);
      if(variation==='revision')request.head='c'.repeat(40);
      if(variation==='run')assert.equal(s.start(run('native-run',{project:desktop,ticket:desktop+'#@task-'+task.id,role:'native-task',resource:'heavy'})).ok,true);
      if(variation==='hold')s.workflow.change(nativeTicket,{status:'Halted'},'operator',randomUUID());
      assert.throws(()=>s.acquireStorage(request),/Native cleanup/);
      assert.equal(s.storage.active().length,0);
    }finally{s.close();}
  }
});

test('native reference identity survives restart and cannot be changed by cancellation or retry',()=>{
  const directory=mkdtempSync(join(tmpdir(),'native-storage-restart-')),file=join(directory,'claims.sqlite');
  let s=fixture(file);try {
    const {request}=publishedNative(s);s.acquireStorage(request);s.close();s=new FleetStore(file,limits);
    assert.equal(s.acquireStorage({...request}).taskId,request.taskId);
    assert.throws(()=>s.acquireStorage({...request,referenceDigest:'d'.repeat(64)}),/different contents/);
    assert.throws(()=>s.cancelStorage({...request,taskId:'e'.repeat(64)},true),/differs/);
    assert.equal(s.storage.active().length,1);
    s.cancelStorage(request,true);assert.equal(s.storage.active().length,0);
  }finally{s.close();rmSync(directory,{recursive:true,force:true});}
});

test('published reference binding rejects invented leaves until explicit protected attestation',async()=>{
  const s=fixture(),server=await serveFleet(s,{mac:'worker',linux:'linux'},'protected',0);try {
    const {request}=publishedNative(s,false);
    const initial=s.acquireStorage(request);s.finishStorage(initial.id,'mac',true,'complete');
    const changed={...request,id:randomUUID(),referenceDigest:'e'.repeat(64)};
    assert.throws(()=>s.acquireStorage(changed),/protected attestation/);
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const worker=new JsonClient(`http://127.0.0.1:${address.port}`,'worker'),operator=new JsonClient(`http://127.0.0.1:${address.port}`,'protected');
    await assert.rejects(()=>worker.call('/storage/attest',changed),/403/);
    await operator.call('/storage/attest',changed);
    assert.equal(s.acquireStorage(changed).referenceDigest,changed.referenceDigest);
    s.finishStorage(changed.id,'mac',true,'complete');
    assert.throws(()=>s.acquireStorage({...changed,id:randomUUID(),artifactDigest:'f'.repeat(64)}),/published evidence differs/);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));s.close();}
});

test('failed native dependencies require resolved source and retain original failed result and published artifacts',()=>{
  const s=fixture();try {
    const {task,db,request}=publishedNative(s);
    const result={...s.tasks.get(task.id).result!,outcome:'failed',summary:'The original full failed execution remains retained'};
    db.prepare("UPDATE fleet_recovery_tasks SET state='failed',result=? WHERE id=?").run(JSON.stringify(result),task.id);
    assert.throws(()=>s.acquireStorage(request),/source remains unresolved/);
    s.workflow.change(nativeTicket,{state:'CLOSED',status:'Done'},'operator',randomUUID());
    const before=s.tasks.get(task.id),controls=s.desired.document('mac');
    const lease=s.acquireStorage(request);s.finishStorage(lease.id,'mac',true,'complete');
    assert.deepEqual(s.tasks.get(task.id),before);assert.deepEqual(s.desired.document('mac'),controls);
  }finally{s.close();}
});
