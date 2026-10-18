import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {FleetStore,type StartRequest} from './fleet-store.js';
import type {WorkflowItem} from './workflow-store.js';

const limits={source:{heavyLimit:1,combinedLimit:2},target:{heavyLimit:1,combinedLimit:2}};
const desktop='pyrycode/pyrycode-desktop';
function item(project:string,closed=false):WorkflowItem {
  return {id:'P1',issueId:'I1',issueNumber:7,title:'useful behaviour',body:'Retained acceptance requirements',url:`https://github.com/${project}/issues/7`,status:closed?'Done':'In Development',labels:[],blockedBy:[],parentNumber:null,grandparentNumber:null,state:closed?'CLOSED':'OPEN',revision:1,position:1};
}
function authority(project:string,closed=false) {
  const store=new FleetStore(':memory:',limits,{now:()=>100000});
  store.workflow.import({project,projectId:'P',statusFieldId:'S',options:{Inbox:'i',Done:'done','In Development':'d','In Code Review':'r'}},[item(project,closed)]);
  return store;
}

test('cache exclusion rolls back verifier handoff ownership and preserves the pending transfer for retry',()=>{
  const store=authority(desktop),ticket=desktop+'#7',candidate='a'.repeat(40);
  try {
    const builder:StartRequest={workflowVersion:1,id:'build',machine:'source',session:'source-session',project:desktop,ticket,role:'builder',resource:'medium',locks:[]};
    assert.equal(store.start(builder).ok,true);
    store.finish('source','source-session',builder.id);
    store.workflow.change(ticket,{status:'In Code Review'},'operator',randomUUID());
    for(const machine of ['source','target'])store.reportMachineCapabilities(machine,['linux'],[desktop]);
    const original=store.snapshot().claims.find(c=>c.ticket===ticket)!;
    const handoff={commandId:'pending-transfer',ticket,source:'source',generation:original.generation,revision:store.workflow.get(ticket).revision,candidate,target:'target'};
    store.requestVerifierHandoff(handoff);
    store.confirmVerifierHandoff('source',handoff.commandId,'source-session',undefined,{list:()=>[{machine:'source',role:'builder',meta:{outcome:'completed',candidateRevision:candidate}}]} as any);
    const lease=store.acquireStorage({id:randomUUID(),machine:'target',kind:'cache',path:'/tmp/approved-go-cache'});
    const verifier:StartRequest={...builder,id:'verify',machine:'target',session:'target-session',role:'verifier',resource:'heavy'};
    assert.throws(()=>store.confirmVerifierHandoff('target',handoff.commandId,'target-session',verifier),/admission refused: locked/);
    assert.deepEqual(store.snapshot().claims.find(c=>c.ticket===ticket),original);
    assert.equal(store.snapshot().runs.length,0);
    assert.equal(store.verifierHandoffs.get(handoff.commandId).state,'pending');
    assert.equal(store.storage.active()[0].id,lease.id);
    store.finishStorage(lease.id,'target',true,'complete');
    const admitted=store.confirmVerifierHandoff('target',handoff.commandId,'target-session',verifier);
    assert.equal(admitted.state,'admitted');
    assert.equal(store.snapshot().claims.find(c=>c.ticket===ticket)?.machine,'target');
    assert.equal(store.snapshot().runs[0].verificationPin?.candidate,candidate);
  }finally{store.close();}
});

test('direct native task grant respects a cross-machine ticket lease without cancelling queued work',()=>{
  const project='org/product',store=authority(project,true),ticket=project+'#7';
  try {
    const lease=store.acquireStorage({id:randomUUID(),machine:'source',kind:'ticket',ticket,path:'/tmp/registered-builder-7',head:'b'.repeat(40)});
    const task=store.tasks.request(ticket,{recipe:'platform-probe',capability:'macos-arm64',reason:'Retained operator platform check'});
    store.tasks.report('target',{capabilities:['macos-arm64'],ready:true});
    const request:StartRequest={id:'native-direct',machine:'target',session:'native-session',project,ticket:`${project}#@task-${task.id}`,role:'recovery-task',resource:'light',locks:[],supportTaskId:task.id,parentTicket:ticket};
    const controls=store.desired.document('target');
    assert.deepEqual(store.start(request),{ok:false,reason:'locked'});
    assert.equal(store.tasks.get(task.id).state,'queued');
    assert.equal(store.snapshot().runs.length,0);
    assert.deepEqual(store.desired.document('target'),controls);
    assert.throws(()=>store.verifyStorage(lease.id,'source'),/unfinished support/);
    store.finishStorage(lease.id,'source',true,'held');
    assert.equal(store.start(request).ok,true);
    assert.equal(store.tasks.get(task.id).state,'running');
    assert.equal(store.snapshot().runs[0].parentTicket,ticket);
  }finally{store.close();}
});
