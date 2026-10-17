import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore, type StartRequest} from './fleet-store.js';
import {EvidenceStore, DEFAULT_EVIDENCE_LIMITS} from './evidence-store.js';
import {artifactManifest, manifestHash} from './recovery-artifacts.js';
import {serveFleet, JsonClient, FleetClient} from './fleet-http.js';
import {MachineManager, serveManager} from './machine-manager.js';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ManagedDispatch} from './managed-dispatch.js';
import {recoveryStillCurrent} from './recovery-work.js';
import type {ProjectItem} from './types.js';

const project='pyrycode/pyrycode-mobile', ticket=project+'#2202';
const start=(id:string,role='builder',extra:Partial<StartRequest>={}):StartRequest=>({id,role,session:'session',machine:'mac',project,ticket,resource:'heavy',locks:[],...extra});
function fixture(path=':memory:') {
 const store=new FleetStore(path,{mac:{heavyLimit:1,combinedLimit:2}});
 const evidence=new EvidenceStore(':memory:',DEFAULT_EVIDENCE_LIMITS,id=>store.runOwner(id));
 assert.equal(store.start(start('failed-verifier','verifier')).ok,true);store.finish('mac','session','failed-verifier',true);
 const files={'logs/failing.xml':'<testsuite failures="1"><testcase name="screenOpen"><failure>1434 ms exceeds 1000 ms</failure></testcase></testsuite>'};
 const manifest=artifactManifest(files), digest=manifestHash(manifest);
 evidence.begin('mac',project,ticket,'failed-verifier',{kind:'agent',role:'verifier',outcome:'completed',startedAt:1,endedAt:2},manifest);
 evidence.put('mac',project,ticket,'failed-verifier',digest,'logs/failing.xml',0,Buffer.from(files['logs/failing.xml']).toString('base64'));
 evidence.commit('mac',project,ticket,'failed-verifier',digest);
 const request={revision:'a'.repeat(40),failedTests:['ScreenTest#screenOpen'],evidence:[{runId:'failed-verifier',digest,path:'logs/failing.xml'}],scope:{kind:'sequence',selectors:['ScreenTest#screenOpen','ScreenTest#restore']},narrowerInsufficient:'The isolated screen test passed; investigate the preceding restore sequence.'};
 return {store,evidence,request,close:()=>{store.close();evidence.close();}};
}

test('a builder cannot request the complete Mobile native suite with ticket prose as authority',()=>{
 const f=fixture();try {
  f.store.start(start('builder'));
  assert.throws(()=>f.store.requestTask('mac','session',project,'builder',{recipe:'mobile-in-depth',capability:'mobile-android',revision:'a'.repeat(40),reason:'The ticket explicitly requires a full baseline.'}),/full|complete|investigat/i);
  assert.equal(f.store.tasks.list(ticket).length,0);
 }finally{f.close();}
});

test('a retained-evidence investigation is idempotent and becomes assessable after the source worker ends',()=>{
 const f=fixture();try {
  f.store.start(start('builder'));
  const owner=f.store.snapshot().claims[0];
  const receipt=f.store.requestInvestigation('mac','session',project,'builder',f.request,f.evidence);
  assert.equal(receipt.status,'assessment-queued');assert.equal(receipt.executed,0);
  assert.deepEqual(f.store.requestInvestigation('mac','session',project,'builder',f.request,f.evidence),receipt);
  assert.equal(f.store.tasks.list(ticket).length,0);
  assert.deepEqual(f.store.snapshot().claims,[owner]);
  const observation={ticket,status:'In Development',labels:[],blocked:false};
  assert.deepEqual(f.store.recoveryReport('mac',project,[observation]),[],'a builder request cannot start a competing assessment');
  f.store.finish('mac','session','builder');
  const [incident]=f.store.recoveryReport('mac',project,[observation]);
  assert.equal(incident?.state,'queued');assert.match(incident.reason,/investigation/i);
  assert.deepEqual(f.store.snapshot().claims,[owner]);
  const facts=f.store.recoveryFacts([ticket]);
  assert.equal(facts[0].investigation?.id,receipt.id);
  assert.deepEqual(facts[0].investigation?.request.failedTests,f.request.failedTests);
  const hydrated={issueNumber:2202,status:'In Development',labels:[],blockedBy:[],artifactRevision:facts[0].artifactRevision,testInvestigationRevision:receipt.id} as unknown as ProjectItem;
  assert.ok(recoveryStillCurrent(project,hydrated,incident),'ordinary assessment safety checks retain the investigation identity');
  assert.equal(recoveryStillCurrent(project,{...hydrated,testInvestigationRevision:undefined},incident),false);
  assert.equal(f.store.start(start('assessment','recovery')).ok,true);
  f.store.recoveryStep('mac','session',project,incident.id,'assessment','begin');
  f.store.recoveryStep('mac','session',project,incident.id,'assessment','decide',{action:'wait',reason:'The recorded evidence supports the named sequence only.'});
  f.store.recoveryStep('mac','session',project,incident.id,'assessment','complete');
  f.store.finish('mac','session','assessment');
  assert.deepEqual(f.store.recoveryReport('mac',project,[observation]),[],'the assessed request does not loop on a healthy ticket');
 }finally{f.close();}
});

test('investigations reject forged roles, unavailable or unrelated evidence and malformed scope',()=>{
 const f=fixture();try {
  f.store.start(start('builder'));
  for(const request of [
   {...f.request,evidence:[]},
   {...f.request,evidence:[{...f.request.evidence[0],digest:'b'.repeat(64)}]},
   {...f.request,evidence:[{...f.request.evidence[0],path:'logs/absent.xml'}]},
   {...f.request,evidence:[{...f.request.evidence[0],path:'../outside.xml'}]},
   {...f.request,failedTests:[]},
   {...f.request,scope:{kind:'sequence',selectors:[]}},
   {...f.request,scope:{kind:'suite',selectors:['*']}},
   {...f.request,role:'recovery'},
  ]) assert.throws(()=>f.store.requestInvestigation('mac','session',project,'builder',request,f.evidence));
  assert.throws(()=>f.store.requestInvestigation('mac','wrong',project,'builder',f.request,f.evidence));
  assert.throws(()=>f.store.requestInvestigation('mac','session',project,'builder',f.request));
  f.store.finish('mac','session','builder');
  f.store.start(start('verifier','verifier'));
  assert.throws(()=>f.store.requestInvestigation('mac','session',project,'verifier',f.request,f.evidence));
  assert.equal(f.store.recoveryFacts([ticket])[0].investigation,undefined);
 }finally{f.close();}
});

test('an investigation does not lift a human hold or modify ticket workflow',()=>{
 const f=fixture();try {
  f.store.start(start('builder'));
  f.store.requestInvestigation('mac','session',project,'builder',f.request,f.evidence);
  f.store.finish('mac','session','builder');
  const [incident]=f.store.recoveryReport('mac',project,[{ticket,status:'In Development',labels:['needs-human:decision'],blocked:false}]);
  assert.equal(incident.state,'escalated');assert.equal(incident.reason,'Explicit operator hold');
  assert.equal(f.store.tasks.list(ticket).length,0);
  assert.equal(f.store.facts.getPause(ticket),undefined);
 }finally{f.close();}
});

test('a queued investigation survives controller restart and keeps normal ownership',()=>{
 const directory=mkdtempSync(join(tmpdir(),'investigation-restart-')),path=join(directory,'fleet.sqlite');
 const f=fixture(path);let store=f.store;
 try {
  store.start(start('builder'));
  const receipt=store.requestInvestigation('mac','session',project,'builder',f.request,f.evidence);
  store.finish('mac','session','builder');const owner=store.snapshot().claims[0];
  store.close();store=new FleetStore(path,{mac:{heavyLimit:1,combinedLimit:2}});
  assert.equal(store.recoveryFacts([ticket])[0].investigation?.id,receipt.id);
  const [incident]=store.recoveryReport('mac',project,[{ticket,status:'In Development',labels:[],blocked:false}]);
  assert.equal(incident.state,'queued');assert.deepEqual(store.snapshot().claims,[owner]);
 }finally{store.close();f.evidence.close();rmSync(directory,{recursive:true});}
});

test('a coordinated diagnostic retains its investigation until fresh results are reassessed',()=>{
 const f=fixture();try {
  f.store.start(start('builder'));
  const receipt=f.store.requestInvestigation('mac','session',project,'builder',f.request,f.evidence);
  f.store.finish('mac','session','builder');
  const observation={ticket,status:'In Development',labels:[],blocked:false};
  const [first]=f.store.recoveryReport('mac',project,[observation]);
  assert.equal(f.store.start(start('assessment','recovery')).ok,true);
  f.store.recoveryStep('mac','session',project,first.id,'assessment','begin');
  f.store.recoveryStep('mac','session',project,first.id,'assessment','decide',{action:'coordinate',reason:'The retained failure depends on preceding native tests; a controlled complete profile is required.',
   task:{recipe:'mobile-in-depth',capability:'mobile-android',revision:f.request.revision,reason:'Retain the complete profile to compare the suite-order failure.'}});
  f.store.recoveryStep('mac','session',project,first.id,'assessment','complete');
  f.store.finish('mac','session','assessment');
  assert.equal(f.store.investigations.pending(ticket)?.id,receipt.id);
  assert.deepEqual(f.store.recoveryReport('mac',project,[observation]),[],'pending native work cannot start another assessment');
  const [task]=f.store.tasks.list(ticket);
  f.store.reportMachineCapabilities('mac',[],[project]);
  f.store.tasks.report('mac',{capabilities:['mobile-android'],ready:true});
  assert.equal(f.store.taskStart('mac',task.id,'native-session').ok,true);
  f.store.taskComplete('mac',task.id,'native-session',{outcome:'failed',summary:'Synthetic diagnostic fixture failed; no production test was run.',files:{}});
  const [second]=f.store.recoveryReport('mac',project,[observation]);
  assert.equal(second?.state,'queued');assert.notEqual(second.id,first.id);
  assert.equal(f.store.start(start('reassessment','recovery')).ok,true);
  f.store.recoveryStep('mac','session',project,second.id,'reassessment','begin');
  f.store.recoveryStep('mac','session',project,second.id,'reassessment','decide',{action:'wait',reason:'The controlled result is retained; no further diagnostic is justified.'});
  f.store.recoveryStep('mac','session',project,second.id,'reassessment','complete');
  f.store.finish('mac','session','reassessment');
  assert.equal(f.store.investigations.pending(ticket),undefined);
  assert.deepEqual(f.store.recoveryReport('mac',project,[observation]),[]);
 }finally{f.close();}
});

test('the per-project manager forwards investigation requests with server-owned project identity',async t=>{
 const f=fixture(), directory=mkdtempSync(join(tmpdir(),'investigation-http-'));
 const authority=await serveFleet(f.store,{mac:'machine-token'},'operator-token',0,'127.0.0.1',undefined,undefined,undefined,undefined,undefined,f.evidence);
 const url='http://127.0.0.1:'+(authority.address() as {port:number}).port;
 const manager=new MachineManager({machine:'mac',projects:[project],heavyLimit:1,combinedLimit:2},new FleetClient(url,'machine-token'));
 const server=await serveManager(manager,{[project]:'project-token'},'local-operator',join(directory,'manager.sock'));
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await new Promise<void>(r=>authority.close(()=>r()));f.close();rmSync(directory,{recursive:true});});
 f.store.start(start('builder'));
 const client=new JsonClient('unix://'+join(directory,'manager.sock'),'project-token');
 const receipt=await client.call<{status:string;executed:number}>('/tasks/investigate',{project:'other/repo',session:'session',runId:'builder',request:f.request});
 assert.deepEqual([receipt.status,receipt.executed],['assessment-queued',0]);
 const managed=new ManagedDispatch(project,{PYRY_MANAGER_URL:'unix://'+join(directory,'manager.sock'),PYRY_MANAGER_TOKEN:'project-token'});
 const hydrated=await managed.hydrateRecovery({issueNumber:2202} as ProjectItem);
 assert.match(hydrated.testInvestigationRevision??'',/^[a-f0-9]{64}$/);
});
