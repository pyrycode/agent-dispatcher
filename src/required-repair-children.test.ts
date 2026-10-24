import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetStore } from './fleet-store.js';
import { WorkflowGitHub } from './workflow-github.js';
import { GitHubBroker } from './github-broker.js';
import { MachineManager } from './machine-manager.js';
import { scheduleMachine, type WorkOffer } from './machine-scheduler.js';
import { serveFleet, JsonClient } from './fleet-http.js';
import type { WorkflowItem } from './workflow-store.js';

const project = 'fixture/mobile', parent = `${project}#2338`, child = `${project}#2522`;
const actor = { machine: 'box', session: 's', runId: 'refiner-2338' };
const item = (n: number, extra: Partial<WorkflowItem> = {}): WorkflowItem => ({
  id: `P${n}`, issueId: `I${n}`, issueNumber: n, title: `Fixture ${n}`, body: 'Required repair; parent retains integration and acceptance.',
  url: `https://github.com/${project}/issues/${n}`, state: 'OPEN', status: 'Inbox', labels: [], blockedBy: [],
  parentNumber: null, grandparentNumber: null, revision: 1, position: n, subIssues: {total: 0, completed: 0}, ...extra,
});
const config = { machine: 'box', projects: [project], heavyLimit: 4, combinedLimit: 4, ticketLimit: 4 };
const offer: WorkOffer = { workflowVersion: 1, key: 'builder-2522', order: 0, project, ticket: child, role: 'builder', resource: 'medium', locks: [] };
async function fixture(t: TestContext, count = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'required-repair-'));
  const path = join(dir, 'claims.sqlite');
  let now = Date.now(), store = new FleetStore(path, {box: config, other: config}, {now: () => now});
  store.workflow.import({project, projectId: 'P', statusFieldId: 'S', options: {Inbox:'i', Backlog:'b', 'In Development':'dev', Done:'d', Halted:'h'}}, [item(2338,{status:'Backlog'})]);
  assert.equal(store.start({...actor, id: actor.runId, workflowVersion:1, project, ticket:parent, role:'refiner', resource:'light', locks:[]}).ok,true);
  const remote = new Map([[2338,item(2338,{status:'Backlog'})]]);
  let next = 2522, incomplete = false, unavailable = false;
  const fetcher: typeof fetch = async (_url, init) => {
    if (unavailable) throw Error('GitHub unavailable');
    const body = JSON.parse(String(init?.body ?? '{}')), q = body.query ?? '';
    if (q.includes('createIssue')) {
      const n = next++;
      remote.set(n, item(n));
      return Response.json({data:{createIssue:{issue:{id:`I${n}`}}}});
    }
    if (q.includes('addSubIssue')) {
      const n = Number(body.variables.input.subIssueId.slice(1));
      remote.get(n)!.parentNumber = 2338;
      remote.get(2338)!.subIssues!.total++;
      return Response.json({data:{addSubIssue:{issue:{id:'I2338'}}}});
    }
    if (q.includes('subIssues(first:100)')) return Response.json({data:{node:{id:'I2338',
      subIssues:{nodes:[...remote.values()].filter(i=>i.parentNumber===2338).map(i=>({id:i.issueId,number:i.issueNumber})),pageInfo:{hasNextPage:incomplete}},
      blocking:{nodes:[],pageInfo:{hasNextPage:false}},
    }}});
    const i = remote.get(Number(body.variables.id.slice(1)))!;
    return Response.json({data:{node:{...i,id:i.issueId,number:i.issueNumber,repository:{nameWithOwner:project},
      labels:{nodes:i.labels.map(name=>({name})),pageInfo:{hasNextPage:false}},blockedBy:{nodes:i.blockedBy,pageInfo:{hasNextPage:false}},
      parent:i.parentNumber?{number:i.parentNumber,parent:null}:null,subIssuesSummary:i.subIssues,
      projectItems:{nodes:[{id:i.id,project:{id:'P'},fieldValueByName:{name:i.status}}],pageInfo:{hasNextPage:false}},
    }}});
  };
  const upstream = new GitHubBroker({token:'fixture-only',projects:[project],fetcher});
  let api = new WorkflowGitHub(store,upstream);
  const graphql = (query: string, variables: unknown) => api.request(project,{method:'POST',path:'/graphql',body:JSON.stringify({query,variables})},actor);
  for (let n=2522;n<2522+count;n++) {
    await graphql('mutation($input:CreateIssueInput!){createIssue(input:$input){issue{id}}}',{input:{repositoryId:'R',title:'Required repair',body:'Own acceptance'}});
    await graphql('mutation($input:AddSubIssueInput!){addSubIssue(input:$input){issue{id}}}',{input:{issueId:'I2338',subIssueId:`I${n}`}});
    store.workflowChange(actor.machine,actor.session,actor.runId,`${project}#${n}`,{status:'In Development',addLabels:['done:refiner']},`refine-${n}`);
  }
  store.workflowChange(actor.machine,actor.session,actor.runId,parent,{blockedBy:[...remote.values()].filter(i=>i.parentNumber===2338).map(i=>({number:i.issueNumber,state:i.state,url:i.url}))},'required-blockers');
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;}, get api(){return api;}, upstream,
    end(){store.finish(actor.machine,actor.session,actor.runId);},
    reopen(){store.close();store=new FleetStore(path,{box:config,other:config},{now:()=>now});api=new WorkflowGitHub(store,upstream);},
    advanceTime(){now+=24*3600000;}, truncate(){incomplete=true;}, disconnect(){unavailable=true;},
    inspect:()=>api.requiredRepairs(actor,parent),
    declare:(request:unknown)=>api.requiredRepairs(actor,parent,request),
    start:()=>store.start({...offer,id:'builder-2522',machine:'box',session:'builder'}),
    plan:()=>({...store.requiredRepairChildren.inspect(parent),commandId:'required-2522',summary:'Canonical observer repair; parent retains diagnostic PR and acceptance.',repairs:[2522]}),
    manager:()=>new MachineManager(config,{snapshot:async()=>store.snapshot(),start:async r=>store.start(r),finish:async(s,id)=>store.finish('box',s,id)}),
  };
}

test('real creator/link/refinement path: explicit repair waits for creator, then admits builder with parent open',async t=>{
  const f=await fixture(t);
  assert.equal(f.store.planningSplits.childPending(f.store.workflow.get(child),project),true);
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
  const m=f.manager();m.offer(project,'builder',[offer]);
  assert.equal((await m.status()).queue[0].state,'planning-child-pending');
  assert.deepEqual(scheduleMachine({...config,state:f.store.snapshot(),offers:[offer]}),[]);
  await f.inspect();
  const before=f.store.workflow.get(parent), request=f.plan();
  await f.declare(request);
  assert.equal(f.store.planningSplits.childPending(f.store.workflow.get(child),project),false);
  assert.equal((await m.status()).queue[0].state,'creator-active');
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
  f.advanceTime(); // A declared creator remains held even past the general bounded hold.
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
  f.end();f.reopen();
  const manager=f.manager();manager.offer(project,'builder',[offer]);
  assert.equal((await manager.status()).queue[0].state,'eligible');
  await manager.tick();
  assert.equal((await manager.grants(project,'builder')).length,1);
  assert.deepEqual({...f.store.workflow.get(parent),revision:before.revision},before);
  assert.deepEqual(f.store.workflow.get(child).labels,['done:refiner']);
});

test('ended creator requires protected explicit finalization; exact replay survives offline restart',async t=>{
  const f=await fixture(t);await f.inspect();f.end();const request=f.plan();
  await assert.rejects(f.declare(request),/finished|ownership/);
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
  const result=await f.api.requiredRepairs('operator',parent,request);
  f.reopen();f.disconnect();
  assert.deepEqual(await f.api.requiredRepairs('operator',parent,request),result);
  await assert.rejects(f.api.requiredRepairs('operator',parent,{...request,summary:'changed'}),/identity/);
  await assert.rejects(f.declare(request),/identity|owner/);
  assert.equal(f.store.workflow.comments(parent).length,1);
  assert.equal(f.start().ok,true);
});

test('replacement controls: arbitrary readiness changes and ended creator release nothing',async t=>{
  const f=await fixture(t,2);f.end();f.reopen();
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
  await f.api.requiredRepairs('operator',parent);
  const request=f.plan();request.repairs=[2522];
  await f.api.requiredRepairs('operator',parent,request);
  assert.equal(f.store.planningSplits.childPending(f.store.workflow.get(`${project}#2523`),project),true);
  assert.equal(f.store.planningSplits.parentPending(parent),true);
  assert.equal(f.start().ok,true);
});

for (const [name,mutate,pattern] of [
  ['partial inventory',(f:any,r:any)=>{r.children=[];},/inventory/],
  ['stale revision',(f:any,r:any)=>{r.revision++;},/changed/],
  ['stale ownership',(f:any,r:any)=>{r.ownership={machine:'other',generation:'stale'};},/ownership/],
  ['missing blocker',(f:any,r:any)=>{f.store.workflow.change(parent,{blockedBy:[]},'fixture','remove-blocker');r.revision=f.store.workflow.get(parent).revision;},/blocker/],
  ['operator hold',(f:any,r:any)=>{f.store.workflow.change(child,{addLabels:['held:operator']},'fixture','hold');r.children[0].revision=f.store.workflow.get(child).revision;},/holds/],
  ['approval refusal',(f:any)=>{f.store.approvals.record(child,'prior','refiner',{approvalReviewFailed:false,hadPermissionDenial:true});},/approval/],
  ['support custody',(f:any)=>{f.store.tasks.request(child,{recipe:'platform-probe',capability:'linux-amd64',reason:'Existing support'});},/support/],
  ['feature lineage',(f:any,r:any)=>{f.store.workflow.recoveryMetadata(child,{featureRoot:`${project}#1000`});r.children[0].revision=f.store.workflow.get(child).revision;},/lineage/],
] as const) test(`required repairs refuse ${name} without releasing admission`,async t=>{
  const f=await fixture(t);await f.inspect();f.end();const request=f.plan();
  mutate(f,request);
  await assert.rejects(f.api.requiredRepairs('operator',parent,request),pattern);
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
  assert.equal(f.store.workflow.comments(parent).length,0);
});

test('truncated upstream inventories and active parent refuse operator declaration',async t=>{
  const f=await fixture(t);await f.inspect();const request=f.plan();
  await assert.rejects(f.api.requiredRepairs('operator',parent,request),/active/);
  f.end();f.truncate();
  await assert.rejects(f.api.requiredRepairs('operator',parent,request),/incomplete/);
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
});

test('failed persistence rolls back release; removal of acceptance blocker reholds a declared child',async t=>{
  const f=await fixture(t);await f.inspect();f.end();const request=f.plan();
  const comment=f.store.workflow.comment.bind(f.store.workflow);
  f.store.workflow.comment=()=>{throw Error('injected persistence failure');};
  await assert.rejects(f.api.requiredRepairs('operator',parent,request),/persistence/);
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
  f.store.workflow.comment=comment;
  await f.api.requiredRepairs('operator',parent,request);
  f.store.workflow.change(parent,{blockedBy:[]},'fixture','remove-after-declaration');
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
});

test('HTTP operator path refuses machine credentials and inspects before declaring',async t=>{
  const f=await fixture(t);f.end();
  const server=await serveFleet(f.store,{box:'machine-test'},'operator-test',0,'127.0.0.1',f.upstream);
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  const machine=new JsonClient(`http://127.0.0.1:${addr.port}`,'machine-test');
  const operator=new JsonClient(`http://127.0.0.1:${addr.port}`,'operator-test');
  const path='/workflow/required-repairs';
  await assert.rejects(machine.call(path,{project,ticket:parent}),/403/);
  const inspected=await operator.call<any>(path,{project,ticket:parent});
  assert.equal(inspected.children[0].number,2522);
  const result=await operator.call<any>(path,{project,ticket:parent,declaration:{...inspected,commandId:'http-repair',summary:'Retain acceptance parent.',repairs:[2522]}});
  assert.deepEqual(result.repairs,[child]);
  assert.equal(f.start().ok,true);
});

test('otherwise identical control without a creator hold admits normally',async t=>{
  const f=await fixture(t);f.end();
  const control=new FleetStore(':memory:',{box:config});t.after(()=>control.close());
  control.workflow.import(f.store.workflow.config(project)!,f.store.workflow.list(project));
  assert.deepEqual(scheduleMachine({...config,state:control.snapshot(),offers:[offer]}),[offer]);
  assert.equal(control.start({...offer,id:'control-builder',machine:'box',session:'builder'}).ok,true);
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
});

test('partial nonempty inventory and unlinked creator issue cannot be omitted',async t=>{
  const f=await fixture(t,2);await f.inspect();
  const request=f.plan();
  await assert.rejects(f.declare({...request,children:request.children.slice(0,1)}),/incomplete/);
  f.store.recordTicketCreator(actor.machine,actor.session,actor.runId,'I2524');
  await assert.rejects(f.declare(request),/unlinked|unavailable/);
  f.end();assert.deepEqual(f.start(),{ok:false,reason:'locked'});
});

test('declaration cannot take active child custody, waive later refusals, or close acceptance via replacement',async t=>{
  const f=await fixture(t);await f.inspect();await f.declare(f.plan());
  assert.throws(()=>f.store.finalizePlanningSplit(actor,parent,{commandId:'replacement',revision:f.store.workflow.get(parent).revision,
    summary:'Replace acceptance',children:[2522,2523].map(number=>({number,revision:1,dependsOn:[]})),dependents:[]}),/retains acceptance/);
  f.end();
  f.store.approvals.record(child,'later-refusal','builder',{approvalReviewFailed:false,hadPermissionDenial:true});
  assert.deepEqual(f.start(),{ok:false,reason:'locked'});
  f.store.approvals.authorize(child,'later-refusal','fixture-authorization','Fixture explicit authorization');
  assert.equal(f.start().ok,true);
  const runs=f.store.snapshot().runs,claims=f.store.snapshot().claims;
  await assert.rejects(f.api.requiredRepairs('operator',parent,{...f.plan(),commandId:'second-declaration'}),/active/);
  assert.deepEqual(f.store.snapshot().runs,runs);assert.deepEqual(f.store.snapshot().claims,claims);
});

test('completed declared repairs release parent refinement; reopened repairs still require their blocker',async t=>{
  const f=await fixture(t);await f.inspect();await f.declare(f.plan());f.end();
  assert.equal(f.start().ok,true);
  f.store.finish('box','builder','builder-2522');
  // Simulate the normal accepted child completion; declaration itself accepts no work.
  f.store.workflow.change(child,{state:'CLOSED',status:'Done'},'accepted-child-completion','complete-repair');
  assert.equal(f.store.workflow.get(parent).blockedBy[0].state,'CLOSED');
  assert.equal(f.store.planningSplits.parentPending(parent),false);
  assert.equal(f.store.start({workflowVersion:1,id:'parent-acceptance-refiner',machine:'box',session:'parent',
    project,ticket:parent,role:'refiner',resource:'light',locks:[]}).ok,true);
  f.store.workflowChange('box','parent','parent-acceptance-refiner',parent,
    {status:'In Development',addLabels:['done:refiner']},'advance-acceptance-parent');
  assert.equal(f.store.workflow.get(parent).state,'OPEN');
  assert.equal(f.store.workflow.get(parent).status,'In Development');
  f.store.finish('box','parent','parent-acceptance-refiner');
  // Completion must not make the exemption unconditional if the child reopens.
  f.store.workflow.change(parent,{blockedBy:[]},'fixture','remove-completed-blocker');
  assert.equal(f.store.planningSplits.parentPending(parent),false);
  f.store.workflow.change(child,{state:'OPEN',status:'In Development'},'fixture','reopen-repair');
  assert.equal(f.store.planningSplits.childPending(f.store.workflow.get(child),project),true);
  assert.equal(f.store.planningSplits.parentPending(parent),true);
  const again={...offer,id:'reopened-builder',machine:'box',session:'builder'};
  assert.deepEqual(f.store.start(again),{ok:false,reason:'locked'});
  f.store.workflow.change(parent,{blockedBy:[{number:2522,state:'OPEN',url:item(2522).url}]},'fixture','restore-blocker');
  assert.equal(f.store.planningSplits.parentPending(parent),false);
  assert.equal(f.store.start(again).ok,true);
});
