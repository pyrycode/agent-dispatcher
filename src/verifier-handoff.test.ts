import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore, type StartRequest} from './fleet-store.js';
import type {WorkflowItem} from './workflow-store.js';
const evidence={list:()=>[{machine:'source',role:'builder',meta:{outcome:'completed',candidateRevision:'a'.repeat(40)}}]} as any;
const project='pyrycode/pyrycode-desktop',ticket=project+'#1',candidate='a'.repeat(40);
function fixture(){
 let now=100000;
 const store=new FleetStore(':memory:',{source:{heavyLimit:1,combinedLimit:2},target:{heavyLimit:1,combinedLimit:2}},{now:()=>now});
 const item:WorkflowItem={id:'P1',issueId:'I1',issueNumber:1,title:'t',body:'b',url:`https://github.com/${project}/issues/1`,status:'In Development',labels:[],blockedBy:[],parentNumber:null,grandparentNumber:null,state:'OPEN',revision:1,position:1};
 store.workflow.import({project,projectId:'P',statusFieldId:'S',options:{Inbox:'i',Done:'done','In Development':'d','In Code Review':'r'}},[item]);
 const req:StartRequest={workflowVersion:1,id:'build',machine:'source',session:'s',project,ticket,role:'builder',resource:'medium',locks:[]};
 assert.equal(store.start(req).ok,true);store.finish('source','s','build');
 store.workflow.change(ticket,{status:'In Code Review'},'operator','ready');
 for(const machine of ['source','target'])store.reportMachineCapabilities(machine,['linux'],[project]);
 const claim=store.snapshot().claims[0];
 const input={commandId:'move-1',ticket,source:'source',generation:claim.generation,revision:store.workflow.get(ticket).revision,candidate,target:'target'};
 const targetReq={...req,id:'verify',machine:'target',session:'target-session',role:'verifier',resource:'heavy' as const};
 return {store,input,req,targetReq,advance:(ms:number)=>now+=ms};
}
test('handoff retains source ownership until both hosts confirm then atomically admits the pinned target',()=>{
 const {store,input,targetReq,req}=fixture();try{
 const first=store.requestVerifierHandoff(input);
 assert.equal(first.state,'pending');assert.equal(store.snapshot().claims[0].machine,'source');
 assert.deepEqual(store.requestVerifierHandoff(input),first);
 assert.deepEqual(store.start({...req,id:'old-verifier',role:'verifier',resource:'heavy'}),{ok:false,reason:'locked'});
 assert.throws(()=>store.confirmVerifierHandoff('target',input.commandId,'target-session',targetReq),/source confirmation/);
 store.confirmVerifierHandoff('source',input.commandId,'source-session',undefined,evidence);
 const admitted=store.confirmVerifierHandoff('target',input.commandId,'target-session',targetReq);
 assert.equal(admitted.state,'admitted');assert.equal(store.snapshot().claims[0].machine,'target');
 assert.equal(store.snapshot().runs.length,1);assert.equal(store.snapshot().runs[0].verificationPin?.candidate,candidate);
 assert.equal(store.snapshot().runs[0].id,'verify');
 assert.equal(store.start({...req,id:'stale',role:'verifier',resource:'heavy'}).ok,false);
 assert.deepEqual(store.confirmVerifierHandoff('target',input.commandId,'target-session',targetReq),admitted);
 assert.throws(()=>store.requestVerifierHandoff({...input,candidate:'b'.repeat(40)}),/reused/);
 }finally{store.close();}
});
test('expiry, cancellation and changed workflow restore original admission without transferring ownership',()=>{
 for(const change of ['expire','cancel','workflow']){
 const {store,input,req,advance}=fixture();try{
 store.requestVerifierHandoff(input);
 if(change==='expire')advance(180001);
 if(change==='cancel')store.cancelVerifierHandoff(input.commandId);
 if(change==='workflow')store.workflow.change(ticket,{addLabels:['priority:high']},'operator','priority');
 assert.equal(store.start({...req,id:'original',role:'verifier',resource:'heavy'}).ok,true,change);
 assert.equal(store.snapshot().claims[0].machine,'source');
 }finally{store.close();}}
});
test('target capacity and controls never leave transferred ownership on refusal',()=>{
 for(const block of ['capacity','drain','stop','capability','hold']){
 const {store,input,targetReq}=fixture();try{
 store.requestVerifierHandoff(input);store.confirmVerifierHandoff('source',input.commandId,'source-session',undefined,evidence);
 if(block==='capacity')assert.equal(store.start({...targetReq,id:'other',project:'org/other',ticket:'org/other#2',role:'builder'}).ok,true);
 if(block==='drain')store.desired.set({machines:['target'],project,change:{work:'tickets-drained'}});
 if(block==='stop')store.desired.set({machines:['target'],project,change:{run:'stopped'}});
 if(block==='capability'){store.workflow.change(ticket,{addLabels:['requires:macos']},'operator','mac');}
 if(block==='hold')store.workflow.change(ticket,{addLabels:['held:manual']},'operator','hold');
 assert.throws(()=>store.confirmVerifierHandoff('target',input.commandId,'target-session',targetReq));
 assert.equal(store.snapshot().claims.find(c=>c.ticket===ticket)?.machine,'source',block);assert.ok(!store.snapshot().runs.some(r=>r.ticket===ticket));
 }finally{store.close();}}
});

test('source proof must be the latest completed builder in the source generation and exact candidate',()=>{
 const {store,input}=fixture();try{
 store.requestVerifierHandoff(input);
 for(const bundles of [[],[{machine:'source',role:'builder',meta:{outcome:'completed',candidateRevision:'b'.repeat(40)}}],
 [{machine:'target',role:'builder',meta:{outcome:'completed',candidateRevision:candidate}}],
 [{machine:'source',role:'builder',meta:{outcome:'failed',candidateRevision:candidate}}]]){
 assert.throws(()=>store.confirmVerifierHandoff('source',input.commandId,'s',undefined,{list:()=>bundles} as any),/Latest builder evidence/);
 }
 assert.equal(store.verifierHandoffs.get(input.commandId).sourceAt,undefined);
 store.confirmVerifierHandoff('source',input.commandId,'s',undefined,evidence);
 }finally{store.close();}
});
test('stale source confirmation and foreign actors cannot move ownership',()=>{
 const {store,input,targetReq,advance}=fixture();try{
 store.requestVerifierHandoff(input);store.confirmVerifierHandoff('source',input.commandId,'s',undefined,evidence);
 advance(30001);assert.throws(()=>store.confirmVerifierHandoff('target',input.commandId,'target-session',targetReq),/Fresh source/);
 assert.throws(()=>store.confirmVerifierHandoff('outsider',input.commandId,'s'),/actor/);
 assert.equal(store.snapshot().claims[0].machine,'source');
 }finally{store.close();}
});
test('workers cannot forge a pin or use operator metadata in a handoff request',()=>{
 const {store,input,targetReq}=fixture();try{
 assert.throws(()=>store.requestVerifierHandoff({...input,sourceAt:100000} as any),/Invalid/);
 for(const key of ['commandId','ticket','source','generation','candidate','target'])assert.throws(()=>store.requestVerifierHandoff({...input,[key]:123} as any),/Invalid/);
 assert.throws(()=>store.start({...targetReq,verificationPin:{handoff:'forged',candidate,revision:1,sourceGeneration:input.generation}}),/operator handoff/);
 assert.equal(store.snapshot().runs.length,0);
 }finally{store.close();}
});
test('declined or failed verifier attempts retain the pin until actual accepted verification or later builder work',()=>{
 const {store,input,targetReq}=fixture();try{
 store.requestVerifierHandoff(input);store.confirmVerifierHandoff('source',input.commandId,'s',undefined,evidence);store.confirmVerifierHandoff('target',input.commandId,'target-session',targetReq);
 store.finish('target','target-session','verify',true);
 assert.equal(store.verificationCandidate(ticket),candidate,'undefined callback completion does not accept the candidate');
 assert.equal(store.start({...targetReq,id:'after-declined'}).ok,true);
 assert.equal(store.snapshot().runs[0].verificationPin?.candidate,candidate);
 store.finish('target','target-session','after-declined',false);
 assert.equal(store.start({...targetReq,id:'after-failure'}).ok,true);assert.equal(store.snapshot().runs[0].verificationPin?.candidate,candidate);
 store.finish('target','target-session','after-failure',true,false,undefined,candidate);
 assert.equal(store.snapshot().runs.length,0);assert.equal(store.verificationCandidate(ticket),candidate);
 store.workflow.change(ticket,{removeLabels:['error:verifier']},'operator','clear');
 assert.equal(store.start({...targetReq,id:'accepted-final'}).ok,true);
 store.workflow.change(ticket,{addLabels:['done:verifier']},'target','verdict');
 store.finish('target','target-session','accepted-final',true,false,undefined,candidate);
 assert.equal(store.verifierHandoffs.get(input.commandId).state,'accepted');assert.equal(store.verificationCandidate(ticket),undefined,'normal documentation and merge rules resume after verified acceptance');
 }finally{store.close();}
});
test('real new builder work replaces the old verification obligation but unused builder admission does not',()=>{
 const {store,input,targetReq}=fixture();try{
 store.requestVerifierHandoff(input);store.confirmVerifierHandoff('source',input.commandId,'s',undefined,evidence);store.confirmVerifierHandoff('target',input.commandId,'target-session',targetReq);store.finish('target','target-session','verify',false);
 store.workflow.change(ticket,{status:'In Development'},'operator','repair');
 const builder={...targetReq,id:'unused-build',role:'builder',resource:'medium' as const};assert.equal(store.start(builder).ok,true);store.finish('target','target-session',builder.id,false,true);assert.equal(store.verificationCandidate(ticket),candidate);
 assert.equal(store.start({...builder,id:'actual-build'}).ok,true);store.finish('target','target-session','actual-build',true);assert.equal(store.verificationCandidate(ticket),undefined);
 }finally{store.close();}
});
test('a late hold refuses acceptance while releasing drained capacity and retaining the obligation',()=>{
 const {store,input,targetReq}=fixture();try{
 store.requestVerifierHandoff(input);store.confirmVerifierHandoff('source',input.commandId,'s',undefined,evidence);store.confirmVerifierHandoff('target',input.commandId,'target-session',targetReq);
 store.workflow.change(ticket,{addLabels:['done:verifier','held:operator']},'operator','late-hold');
 store.finish('target','target-session','verify',true,false,undefined,candidate);
 assert.equal(store.snapshot().runs.length,0);assert.equal(store.verificationCandidate(ticket),candidate);assert.equal(store.verifierHandoffs.get(input.commandId).state,'admitted');
 assert.ok(store.workflow.get(ticket).labels.includes('held:operator'));assert.ok(!store.workflow.get(ticket).labels.includes('done:verifier'));
 }finally{store.close();}
});
