import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixedFailureDecision} from './fixed-failure-handling.js';
import {RecoveryLedger} from './fleet-recovery.js';
import {observationFor,runRecoveryWork} from './recovery-work.js';
import {FleetStore} from './fleet-store.js';
import type {ProjectItem} from './types.js';
const project='org/core';
const item=(labels:string[]=[],blocked=false):ProjectItem=>({id:'item',issueId:'issue',issueNumber:1,title:'Work',body:'Requirements',status:'In Development',labels,url:'https://github.com/org/core/issues/1',parentNumber:null,grandparentNumber:null,blockedBy:blocked?[{number:2,state:'OPEN',url:'https://github.com/org/core/issues/2'}]:[]});

test('known waits and refusals retain their errors without a model call',async()=>{
 for(const current of [item([],true),item(['error:infra']),item(['error:authentication']),item(['error:publication-refused'])]) {
  const db=new DatabaseSync(':memory:');
  try {
   const ledger=new RecoveryLedger(db);
   const [incident]=ledger.report('box',project,[observationFor(project,current)],{claims:[],runs:[]});
   let calls=0;const removed:string[]=[];
   await runRecoveryWork(incident,{project,agents:[],readCurrent:async()=>current,begin:async()=>ledger.begin(incident.id,'r'),
    knownDecision:async i=>fixedFailureDecision(i),assess:async()=>{calls++;throw new Error('Unexpected model call');},
    decide:async d=>ledger.decide(incident.id,'r',d),complete:async()=>ledger.complete(incident.id,'r'),
    comment:async()=>{},addLabel:async()=>{},removeLabel:async(_n,l)=>{removed.push(l);},move:async()=>{},notify:async()=>{}});
   assert.equal(calls,0);assert.ok(ledger.incident(incident.id).decision);
   assert.ok(removed.every(l=>!l.startsWith('error:')));
  } finally {db.close();}
 }
 assert.equal(fixedFailureDecision(item(['error:builder'])),null,'unknown failures still need assessment');
 assert.equal(fixedFailureDecision(item([],true),true),null,'recorded coordination remains assessable');
 assert.equal(fixedFailureDecision(item([],true))?.waitFor?.tickets?.[0],'org/core#2');
});

test('infrastructure retry allowance survives restart and time without resetting between days',()=>{
 const root=mkdtempSync(join(tmpdir(),'retry-ledger-'));
 try {
  for(let n=0;n<3;n++) {
   const db=new DatabaseSync(join(root,'claims.sqlite'));
   try {
    const ledger=new RecoveryLedger(db,()=>1_000_000_000+n*86400_000);
    const current=item(['error:builder','error-retry-count:'+n]);
    const [incident]=ledger.report('box',project,[observationFor(project,current)],{claims:[],runs:[]});
    ledger.begin(incident.id,'run-'+n);
    const chosen=ledger.decide(incident.id,'run-'+n,{action:'retry',reason:'Confirmed infrastructure repair'});
    assert.equal(chosen.action,n<2?'retry':'escalate');
    assert.deepEqual(ledger.decide(incident.id,'run-'+n,{action:'retry',reason:'Lost acknowledgement retry'}),chosen);
    assert.equal(db.prepare('SELECT attempts FROM fleet_recovery_retries').get()?.attempts,Math.min(n+1,2));
    ledger.complete(incident.id,'run-'+n);
   } finally {db.close();}
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('read-only recovery fits beside occupied heavy capacity and still holds its ticket',()=>{
 const store=new FleetStore(':memory:',{box:{heavyLimit:1,combinedLimit:1}});
 try {
  store.start({id:'suite',machine:'box',session:'s',project,ticket:project+'#2',role:'verifier',resource:'heavy',locks:[]});
  assert.equal(store.start({id:'assessment',machine:'box',session:'s',project,ticket:project+'#1',role:'recovery',resource:'light',locks:[]}).ok,true);
  assert.equal(store.start({id:'overlap',machine:'box',session:'s',project,ticket:project+'#1',role:'builder',resource:'light',locks:[]}).ok,false);
  assert.equal(store.snapshot().claims.some(c=>c.ticket===project+'#1'),false);
 } finally {store.close();}
});
