import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkHandover,shadowHandoverChoice,type HandoverProof,type HandoverFacts} from './handover-check.js';
import type {EvidenceStore} from './evidence-store.js';
const now=1_000_000;
const proof:HandoverProof={ticket:'o/r#1',runId:'run',generation:'g',commit:'a'.repeat(40),remoteCommit:'a'.repeat(40),remoteCheckedAt:now,evidenceDigest:'b'.repeat(64),requiredFiles:['summary.md','failure.json']};
const facts:HandoverFacts={latestRunId:'run',snapshot:{claims:[{ticket:proof.ticket,machine:'old',generation:'g',created:0}],runs:[]},predecessor:{ticket:proof.ticket,machine:'old',generation:'g',finished:now-1,outcome:'completed'},workflow:{state:'OPEN',labels:[]},tasks:[]};
const evidence={list:()=>[{digest:proof.evidenceDigest,manifest:{files:proof.requiredFiles.map(path=>({path,bytes:2,chunks:['hash']}))}}],read:()=>({})} as unknown as EvidenceStore;
test('exact stopped completion and readable required files pass without changing any ownership',()=>{
 const before=JSON.stringify(facts);assert.deepEqual(checkHandover(proof,facts,evidence,now),{ready:true,reasons:[]});assert.equal(JSON.stringify(facts),before);
});
test('missing evidence, pending verdict, uncertain tasks and changed or live predecessors refuse',()=>{
 const changed=[{...facts,latestRunId:'newer'}, {...facts,predecessor:undefined},{...facts,predecessor:{...facts.predecessor!,finished:null}},
 {...facts,predecessor:{...facts.predecessor!,outcome:'cancelled'}},{...facts,workflow:{state:'OPEN',labels:['pending-verdict:verifier']}},
 {...facts,tasks:[{state:'complete',artifactsPending:true}]},{...facts,tasks:[{state:'attention'}]}];
 for(const item of changed) assert.equal(checkHandover(proof,item,evidence,now).ready,false);
 assert.equal(checkHandover({...proof,remoteCommit:'c'.repeat(40)},facts,evidence,now).ready,false);
 assert.equal(checkHandover(proof,facts,evidence,now+60_001).ready,false);
 assert.equal(checkHandover(proof,facts,{...evidence,read:()=>{throw new Error('gone');}} as unknown as EvidenceStore,now).ready,false);
 assert.throws(()=>checkHandover({...proof,requiredFiles:['pointers.json']},facts,evidence,now));
});
test('shadow choice is disabled by default, Linux only, bounded and deterministic',()=>{
 const computers=[{name:'hp',platform:'linux',eligible:true,busy:false},{name:'mac',platform:'darwin',eligible:true,busy:false},{name:'fractal',platform:'linux',eligible:true,busy:true}];
 assert.equal(shadowHandoverChoice({projects:['o/r']},'o/r','fractal',now,computers,now+61_000),null);
 assert.equal(shadowHandoverChoice({enabled:true,projects:['o/r']},'o/r','fractal',now,computers,now+1),null);
 assert.equal(shadowHandoverChoice({enabled:true,projects:['o/r']},'o/r','fractal',now,computers,now+61_000),'hp');
 assert.equal(shadowHandoverChoice({enabled:true,projects:['other']},'o/r','fractal',now,computers,now+61_000),null);
});

 test('the protected route reads real historical completion and never frees its claim',async()=>{
  const {FleetStore}=await import('./fleet-store.js');
  const {serveFleet,JsonClient}=await import('./fleet-http.js');
  const store=new FleetStore(':memory:',{old:{heavyLimit:1,combinedLimit:2}},{now:()=>now});
  const server=await serveFleet(store,{old:'machine-test'},'admin-test',0,'127.0.0.1',undefined,undefined,undefined,undefined,undefined,evidence);
  try {
   const address=server.address() as {port:number};
   const machine=new JsonClient('http://127.0.0.1:'+address.port,'machine-test');
   const admin=new JsonClient('http://127.0.0.1:'+address.port,'admin-test');
   store.start({id:proof.runId,machine:'old',session:'s',project:'o/r',ticket:proof.ticket,role:'builder',resource:'medium',locks:[]});
   const generation=store.snapshot().claims[0].generation;
   store.finish('old','s',proof.runId,true);
   await assert.rejects(()=>machine.call('/handover/check',{...proof,generation}),/403/);
   const result=await admin.call<{ready:boolean;reasons:string[];ownershipChanged:boolean}>('/handover/check',{...proof,generation});
   assert.equal(result.ready,false);assert.equal(result.ownershipChanged,false);
   assert.ok(result.reasons.every(reason=>reason.includes('Workflow')));
   assert.equal(store.snapshot().claims[0].generation,generation);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
 });
