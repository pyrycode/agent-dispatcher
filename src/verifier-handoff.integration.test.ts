import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FleetStore} from './fleet-store.js';
import {FleetClient,JsonClient,serveFleet} from './fleet-http.js';
import {MachineManager,serveManager} from './machine-manager.js';
import {ManagedDispatch} from './managed-dispatch.js';
import {EvidenceStore,DEFAULT_EVIDENCE_LIMITS} from './evidence-store.js';
import {artifactManifest} from './recovery-artifacts.js';
import {uploadEvidenceBundle} from './run-evidence.js';
import {preflightVerifierHandoff,setupPinnedVerifier,assertPinnedVerifier} from './verifier-handoff-local.js';
import {resolveStageSet} from './stage-sets.js';
import {selectDispatches} from './dispatch-selection.js';
import type {WorkflowItem} from './workflow-store.js';
const project='pyrycode/pyrycode-desktop',ticket=project+'#1';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function repositories(directory:string){
 const remote=join(directory,'origin.git'),seed=join(directory,'seed');mkdirSync(seed);git(seed,'init','-b','main');git(seed,'config','user.email','fixture@example.invalid');git(seed,'config','user.name','Fixture');writeFileSync(join(seed,'app.txt'),'main\n');git(seed,'add','.');git(seed,'commit','-m','initial');git(directory,'clone','--bare',seed,remote);git(seed,'remote','add','origin',remote);
 git(seed,'checkout','-b','feature/1');writeFileSync(join(seed,'app.txt'),'candidate\n');git(seed,'commit','-am','candidate');git(seed,'push','origin','feature/1');const candidate=git(seed,'rev-parse','HEAD');git(seed,'checkout','main');
 const source=join(directory,'source'),target=join(directory,'target');git(directory,'clone',remote,source);git(directory,'clone',remote,target);git(source,'branch','feature/1',candidate);
 // Real dispatchers own this untracked file. It is the only canonical-state exclusion.
 writeFileSync(join(source,'.dispatcher.lock'),'fixture');writeFileSync(join(target,'.dispatcher.lock'),'fixture');
 return {remote,seed,source,target,candidate};
}
test('operator request travels through separate source/target managers and real offers into an exact-candidate worktree',async t=>{
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'verifier-handoff-')));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const repos=repositories(directory);
 const store=new FleetStore(':memory:',{source:{heavyLimit:1,combinedLimit:2},target:{heavyLimit:1,combinedLimit:2}});t.after(()=>store.close());
 const evidence=new EvidenceStore(':memory:',DEFAULT_EVIDENCE_LIMITS,id=>store.runOwner(id));t.after(()=>evidence.close());
 const upstream={request:async(_project:string,request:{path:string})=>{if(!request.path.includes('/git/ref/heads/feature/1'))throw new Error('Unexpected fixture upstream request');return {status:200,headers:{},body:JSON.stringify({object:{sha:git(repos.source,'ls-remote',repos.remote,'refs/heads/feature/1').split(/\s+/)[0]}})};}};
 const authority=await serveFleet(store,{source:'source-token',target:'target-token'},'operator-token',0,'127.0.0.1',upstream as any,undefined,undefined,undefined,undefined,evidence);t.after(()=>authority.close());
 const address=authority.address();assert.ok(address&&typeof address!=='string');const url='http://127.0.0.1:'+address.port;
 const operator=new JsonClient(url,'operator-token');
 const item:WorkflowItem={id:'P1',issueId:'I1',issueNumber:1,title:'t',body:'b',url:`https://github.com/${project}/issues/1`,status:'In Development',labels:[],blockedBy:[],parentNumber:null,grandparentNumber:null,state:'OPEN',revision:1,position:1};
 store.workflow.import({project,projectId:'P',statusFieldId:'S',options:{Inbox:'i',Done:'done','In Development':'d','In Code Review':'r'}},[item]);
 const builder={workflowVersion:1 as const,id:'builder',machine:'source',session:'build-session',project,ticket,role:'builder',resource:'medium' as const,locks:[]};
 assert.equal(store.start(builder).ok,true);store.finish('source','build-session','builder');store.workflow.change(ticket,{status:'In Code Review'},'operator','ready');
 const views=await Promise.all((['source','target'] as const).map(async machine=>{
  const fleet=new FleetClient(url,machine+'-token');
  const manager=new MachineManager({machine,projects:[project],heavyLimit:1,combinedLimit:2,capabilities:['linux'],ticketLimit:2},fleet);
  await manager.reportCapabilities();
  const socket=join(directory,machine+'.sock'),server=await serveManager(manager,{[project]:machine+'-project-token'},machine+'-operator-token',socket);t.after(()=>server.close());
  const dispatch=new ManagedDispatch(project,{PYRY_MANAGER_URL:'unix://'+socket,PYRY_MANAGER_TOKEN:machine+'-project-token',PYRY_CODEX_START_JITTER_MS:'0',PYRY_SHARED_GITHUB:'1',GH_CONFIG_DIR:directory});
  dispatch.verifierHandoffPreflight=async h=>preflightVerifierHandoff(repos[machine],h,machine);
  await dispatch.sync();
  const agent=resolveStageSet('builder').agents.find(a=>a.name==='verifier')!;
  const visible=await dispatch.client({getItemsByStatus:async(_status:string)=>[store.workflow.get(ticket)]}).getItemsByStatus('In Code Review');
  const selected=selectDispatches({itemsByColumn:new Map([['In Code Review',visible]]),pollOrder:[agent],maxConcurrent:2,deferRoleLimits:true});
  assert.equal(selected.length,machine==='source'?1:0,'foreign ownership hides the verifier until an explicit pending handoff');
  const pending=selected[0]?dispatch.agentOffer(selected[0].agent,selected[0].item,0):undefined;
  await dispatch.sync();
  return {manager,dispatch,pending,fleet};
 }));
 const [source,target]=views;
 const input={commandId:'operator-move',ticket,source:'source',generation:store.snapshot().claims[0].generation,revision:store.workflow.get(ticket).revision,candidate:repos.candidate,target:'target'};
 // Missing evidence holds confirmation. An old or differently built candidate cannot authorize transfer.
 await operator.call('/verification-handoff/request',input);
 await source.dispatch.sync();assert.equal(store.verifierHandoffs.get(input.commandId).sourceAt,undefined);
 const files={'proof.txt':'builder evidence'};const bundle={version:1 as const,ticket,runId:'builder',meta:{kind:'agent' as const,role:'builder',outcome:'completed',startedAt:1,endedAt:2,candidateRevision:repos.candidate},files};
 await uploadEvidenceBundle(source.fleet,bundle);
 (source.dispatch as any).handoffChecks.clear();
 await source.dispatch.sync();assert.ok(store.verifierHandoffs.get(input.commandId).sourceAt);
 await target.dispatch.sync();
 const visible=await target.dispatch.client({getItemsByStatus:async(_status:string)=>[store.workflow.get(ticket)]}).getItemsByStatus('In Code Review');
 const agent=resolveStageSet('builder').agents.find(a=>a.name==='verifier')!;
 const selected=selectDispatches({itemsByColumn:new Map([['In Code Review',visible]]),pollOrder:[agent],maxConcurrent:2,deferRoleLimits:true});
 assert.equal(selected.length,1,'pending handoff exposes only the target verifier');
 target.pending=target.dispatch.agentOffer(agent,selected[0].item,0);
 (target.dispatch as any).handoffChecks.clear();
 await target.dispatch.sync();await target.dispatch.sync();
 assert.ok(target.dispatch.ready(target.pending!));const run=target.pending!.run!;assert.equal(run.verificationPin?.candidate,repos.candidate);
 assert.equal(store.snapshot().claims[0].machine,'target');assert.equal(store.snapshot().runs.length,1);
 await source.manager.tick();await source.dispatch.sync();assert.equal(source.dispatch.ready(source.pending!),false);assert.equal(store.snapshot().runs.length,1);
 // New main commits arriving during the handoff must never enter its candidate.
 writeFileSync(join(repos.seed,'new-main.txt'),'arrived later\n');git(repos.seed,'add','.');git(repos.seed,'commit','-m','new main');git(repos.seed,'push','origin','main');
 const restarted=new ManagedDispatch(project,{PYRY_MANAGER_URL:'unix://'+join(directory,'target.sock'),PYRY_MANAGER_TOKEN:'target-project-token'});
 await assert.rejects(restarted.sync(),/Another dispatcher session/);assert.equal(store.snapshot().runs[0].verificationPin?.candidate,repos.candidate);
 // The real callback may decline without launching anything. Its successor must stay pinned.
 await target.dispatch.run(target.pending!,async()=>undefined);
 assert.equal(store.verificationCandidate(ticket),repos.candidate);assert.equal(store.snapshot().runs.length,0);
 const next=async()=>{
  (target.dispatch as any).cooldown.clear();
  const pending=target.dispatch.agentOffer(agent,store.workflow.get(ticket),0);
  await target.dispatch.sync();await target.manager.tick();await target.dispatch.sync();
  assert.ok(target.dispatch.ready(pending));assert.equal(pending.run!.verificationPin?.candidate,repos.candidate);return pending;
 };
 const consumer=join(directory,'consumer');mkdirSync(consumer);
 process.env.AGENTS_REPO_PATH=consumer;process.env.TARGET_REPO_PATH=repos.target;process.env.PYRY_STAGE_SET='builder';
 const production=await import('./dispatch.js');
 const client={addLabel:async(_n:number,label:string)=>{store.workflow.change(ticket,{addLabels:[label]},'fixture',crypto.randomUUID());},removeLabel:async(_n:number,label:string)=>{store.workflow.change(ticket,{removeLabels:[label]},'fixture',crypto.randomUUID());},addComment:async()=>{},getIssueLabels:async()=>store.workflow.get(ticket).labels} as any;
 const deps=(admitted:typeof run)=>({...production.DEFAULT_DEPS,recordEvidence:async()=>{},managedWorktree:{run:admitted,snapshot:()=>target.dispatch.connection.call<any>('/state'),predecessor:(id:string)=>target.dispatch.connection.call<any>('/worktree/predecessor',{session:admitted.session,runId:admitted.id,priorId:id})}});
 const failed=await next();const first=production.makeDispatchContext(agent,store.workflow.get(ticket),client,deps(failed.run!));
 await assert.rejects(target.dispatch.run(failed,async()=>{assert.equal((await production.setupBranchAndWorktree(first)).ok,true);throw new Error('fixture model transport failure');}),/fixture model/);
 assert.equal(git(first.worktreeDir,'rev-parse','HEAD'),repos.candidate);assert.throws(()=>git(first.worktreeDir,'show','HEAD:new-main.txt'));
 const retry=await next();const retryContext=production.makeDispatchContext(agent,store.workflow.get(ticket),client,deps(retry.run!));
 await target.dispatch.run(retry,async()=>{assert.equal((await production.setupBranchAndWorktree(retryContext)).ok,true,'clean proven predecessor can be reused');return false;});
 const path=retryContext.worktreeDir;
 writeFileSync(join(path,'new-source.ts'),'export const changed=true;');assert.throws(()=>assertPinnedVerifier(path,run.verificationPin!),/changed/);
 const swallowed=await next();
 await target.dispatch.run(swallowed,()=>production.runConcurrentDispatches([{agent,item:store.workflow.get(ticket)}],client,deps(swallowed.run!),'target'));
 assert.equal(store.snapshot().runs.length,0);assert.equal(store.verificationCandidate(ticket),repos.candidate,'swallowed setup failure cannot accept or lose the pin');assert.ok(store.workflow.get(ticket).labels.includes('error:verifier'));
 rmSync(join(path,'new-source.ts'));store.workflow.change(ticket,{removeLabels:['error:verifier']},'operator','retry-publication');
 const publishing=await next();
 // A remote candidate change is rejected both locally and by the authoritative publication boundary.
 git(repos.seed,'checkout','feature/1');writeFileSync(join(repos.seed,'changed.txt'),'later candidate');git(repos.seed,'add','.');git(repos.seed,'commit','-m','later candidate');git(repos.seed,'push','origin','feature/1');
 assert.throws(()=>assertPinnedVerifier(path,run.verificationPin!),/Published candidate changed/);
 await assert.rejects(target.dispatch.connection.call('/workflow/change',{project,ticket,session:publishing.run!.session,runId:publishing.run!.id,change:{addLabels:['done:verifier']},commandId:'stale-done'}),/candidate changed/);
 assert.ok(!store.workflow.get(ticket).labels.includes('done:verifier'));assert.ok(store.workflow.get(ticket).labels.includes('error:verifier'));
 await target.dispatch.connection.call('/finish',{session:publishing.run!.session,id:publishing.run!.id,completed:true,verificationAccepted:repos.candidate});
 assert.equal(store.snapshot().runs.length,0);assert.equal(store.verifierHandoffs.get(input.commandId).state,'admitted');

});

test('completion accepts only an explicitly accepted current candidate and releases capacity on late holds or unreadable publication',async t=>{
 for(const mode of ['accepted','unreadable','changed','late-hold','missing-verdict','valid-fail']){
  const candidate='a'.repeat(40),store=new FleetStore(':memory:',{source:{heavyLimit:1,combinedLimit:2},target:{heavyLimit:1,combinedLimit:2}});t.after(()=>store.close());
  const item:WorkflowItem={id:'P1',issueId:'I1',issueNumber:1,title:'t',body:'b',url:`https://github.com/${project}/issues/1`,status:'In Development',labels:[],blockedBy:[],parentNumber:null,grandparentNumber:null,state:'OPEN',revision:1,position:1};
  store.workflow.import({project,projectId:'P',statusFieldId:'S',options:{Inbox:'i',Done:'done','In Development':'d','In Code Review':'r','In Documentation':'docs'}},[item]);
  const build={workflowVersion:1 as const,id:'builder',machine:'source',session:'s',project,ticket,role:'builder',resource:'medium' as const,locks:[]};store.start(build);store.finish('source','s','builder');store.workflow.change(ticket,{status:'In Code Review'},'operator','ready');
  for(const machine of ['source','target'])store.reportMachineCapabilities(machine,['linux'],[project]);
  const input={commandId:'move',ticket,source:'source',generation:store.snapshot().claims[0].generation,revision:store.workflow.get(ticket).revision,candidate,target:'target'};
  store.requestVerifierHandoff(input);store.confirmVerifierHandoff('source','move','s',undefined,{list:()=>[{machine:'source',role:'builder',meta:{outcome:'completed',candidateRevision:candidate}}]} as any);
  store.confirmVerifierHandoff('target','move','target-session',{...build,id:'verifier',machine:'target',session:'target-session',role:'verifier',resource:'heavy'});
  if(!['missing-verdict','valid-fail'].includes(mode))store.workflow.change(ticket,{addLabels:['done:verifier',...(mode==='late-hold'?['held:operator']:[])]},'target','verdict');
  const upstream={request:async()=>{if(mode==='unreadable')throw new Error('temporary fixture outage');return {status:200,headers:{},body:JSON.stringify({object:{sha:mode==='changed'?'b'.repeat(40):candidate}})};}};
  const server=await serveFleet(store,{source:'source-token',target:'target-token'},'operator-token',0,'127.0.0.1',upstream as any);t.after(()=>server.close());
  const address=server.address();assert.ok(address&&typeof address!=='string');const client=new FleetClient('http://127.0.0.1:'+address.port,'target-token');
  if(mode==='valid-fail')await client.call('/workflow/change',{project,ticket,session:'target-session',runId:'verifier',change:{addLabels:['needs-rework:builder']},commandId:'fail-verdict'});
  const completion={id:'verifier',session:'target-session',completed:true,...(mode==='valid-fail'?{}:{verificationAccepted:candidate})};
  await client.call('/finish',completion);await client.call('/finish',completion);
  assert.equal(store.snapshot().runs.length,0,mode+' releases drained execution capacity');
  assert.equal(store.verifierHandoffs.get('move').state,mode==='accepted'?'accepted':'admitted');
  if(mode==='accepted'){
   assert.equal(store.verificationCandidate(ticket),undefined);store.workflow.change(ticket,{status:'In Documentation'},'operator','docs');assert.equal(store.start({...build,id:'docs',machine:'target',session:'target-session',role:'documentation',resource:'light'}).ok,true);
  }else{assert.equal(store.verificationCandidate(ticket),candidate);assert.ok(!store.workflow.get(ticket).labels.includes('done:verifier'));}
  if(mode==='valid-fail') {
   const directory=realpathSync(mkdtempSync(join(tmpdir(),'handoff-repair-')));t.after(()=>rmSync(directory,{recursive:true,force:true}));
   const manager=new MachineManager({machine:'target',projects:[project],heavyLimit:1,combinedLimit:2,capabilities:['linux']},client);
   const socket=join(directory,'manager.sock'),managerServer=await serveManager(manager,{[project]:'project-token'},'manager-operator-token',socket);t.after(()=>managerServer.close());
   const dispatch=new ManagedDispatch(project,{PYRY_MANAGER_URL:'unix://'+socket,PYRY_MANAGER_TOKEN:'project-token',PYRY_SHARED_GITHUB:'1',GH_CONFIG_DIR:directory});await dispatch.sync();
   const workflow=dispatch.client({clearItemsCache:()=>{}}) as any;
   process.env.PYRY_STAGE_SET='builder';
   const {runReworkRouting}=await import('./reconcile.js');await runReworkRouting(workflow);
   assert.equal(store.workflow.get(ticket).status,'In Development');assert.ok(!store.workflow.get(ticket).labels.includes('needs-rework:builder'));
   const builder=resolveStageSet('builder').agents.find(a=>a.name==='builder')!;
   const pending=dispatch.agentOffer(builder,store.workflow.get(ticket),0);await dispatch.sync();await manager.tick();await dispatch.sync();
   assert.ok(dispatch.ready(pending));assert.equal(pending.run!.verificationPin,undefined,'valid FAIL routes into ordinary builder work');
   await dispatch.run(pending,async()=>true);assert.equal(store.verificationCandidate(ticket),undefined);
  }
 }
});
