import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { FleetStore } from './fleet-store.js';
import { GitHubBroker } from './github-broker.js';
import { WorkflowGitHub } from './workflow-github.js';
import { EvidenceStore, DEFAULT_EVIDENCE_LIMITS } from './evidence-store.js';
import { artifactManifest, manifestHash } from './recovery-artifacts.js';
import { splitBodyHash, splitRequirements, validateRecoverySplit, validateSplitAgainstTicket, type RecoverySplitPlan } from './recovery-split.js';
import type { WorkflowItem, WorkflowProject } from './workflow-store.js';
import { observationFor, runRecoveryWork } from './recovery-work.js';
const project = 'org/app', ticket = `${project}#3`;
const config: WorkflowProject = {project, projectId:'P',statusFieldId:'S',options:{Inbox:'i',Backlog:'b','In Development':'d','In Code Review':'r',Done:'x'}};
const item = (n:number, extra:Partial<WorkflowItem> = {}):WorkflowItem => ({id:`P${n}`,issueId:`I${n}`,issueNumber:n,title:`Ticket ${n}`,body:'',status:'Backlog',labels:[],url:`https://github.com/${project}/issues/${n}`,blockedBy:[],parentNumber:null,grandparentNumber:null,state:'OPEN',revision:1,position:n,...extra});
const body = '## Acceptance Criteria\n- [ ] Selected host history stays isolated\n- [ ] Background task menu updates independently\n## Security review\nAuthentication checks remain required';
export function recoverySplitFixturePlan():RecoverySplitPlan {
  const children = [
    {key:'host-history',title:'Keep selected host history isolated',body:'## Acceptance Criteria\n- [ ] Selected host history stays isolated\nRegression: history cannot cross hosts\nAuthentication checks remain required',outcome:'History remains within the selected host',checks:['History isolation test fails before the repair and passes after'],kind:'bug' as const,regression:'Regression: history cannot cross hosts',dependsOn:[],reuse:['feature/3 at preserved candidate head']},
    {key:'task-menu',title:'Update background task menu independently',body:'## Acceptance Criteria\n- [ ] Background task menu updates independently\nRegression: menu updates when background task completes\nAuthentication checks remain required',outcome:'Task menu reflects background completion while history still works',checks:['Background task completion updates the menu'],kind:'bug' as const,regression:'Regression: menu updates when background task completes',dependsOn:['host-history'],reuse:['Preserve parent PR review and failed evidence']},
  ];
  return {featureRoot:`${project}#1`,bodyHash:splitBodyHash(body),classification:'accumulating-behaviours',justification:'Retained reviews resolved host selection then exposed an independently useful task menu behaviour',smallerResult:'Each child repairs one observable result with its regression while the app remains usable',
    evidence:['builder','verifier','recovery'].map((role,index)=>({runId:`evidence-${role}`,digest:String(index+1).repeat(64),role:role as 'builder'|'verifier'|'recovery',findings:[role==='verifier'?'menu-state':'host-scope'],inspectedPaths:[`${role}.log`],conclusion:`Inspected ${role} output and compared original and new findings`})),
    findings:[{id:'host-scope',description:'History loses the selected host',child:'host-history'},{id:'menu-state',description:'Background menu has independent stale state',child:'task-menu'}],
    behaviours:[{id:'history',description:'Selected host history stays isolated',child:'host-history',verification:'Cross-host history regression'},{id:'menu',description:'Background task menu updates independently',child:'task-menu',verification:'Background menu completion regression'}],
    requirements:[{text:'Selected host history stays isolated',child:'host-history'},{text:'Background task menu updates independently',child:'task-menu'},{text:'Authentication checks remain required',child:'host-history'},{text:'Authentication checks remain required',child:'task-menu'}],children};
}
async function fixture(t:TestContext, options:{metadata?:boolean;causal?:boolean;oversized?:boolean}={}) {
  const store = new FleetStore(':memory:',{mac:{heavyLimit:4,combinedLimit:4},linux:{heavyLimit:4,combinedLimit:4}});
  store.reportMachineCapabilities('mac',[],[project]);
  const parent = item(3,{blockedBy:options.causal?[{number:5,state:'OPEN',url:'https://github.com/org/app/issues/5'}]:[],parentNumber:2,grandparentNumber:1,status:'In Code Review',body,labels:['rework-count:3','error:rework-loop','security-sensitive','needs-real-claude','priority:high']});
  store.workflow.import(config,[item(1,{state:'CLOSED',status:'Done'}),item(2,{parentNumber:1,state:'CLOSED',status:'Done'}),parent,item(4,{blockedBy:[{number:3,state:'OPEN',url:parent.url}]}),...(options.causal?[item(5)]:[])]);
  const evidence = new EvidenceStore(':memory:',{...DEFAULT_EVIDENCE_LIMITS,totalBytes:1024*1024,ticketBytes:512*1024,bundleBytes:256*1024},id=>store.runOwner(id));
  const plan = recoverySplitFixturePlan();
  for (const reference of plan.evidence) {
    // Historical runs remain intact. The test uses ordinary authority run records and real hashed bundles.
    const role = reference.role;
    const prior = store.workflow.get(ticket);
    store.workflow.change(ticket,{status:role==='verifier'?'In Code Review':'In Development',labels:[],blockedBy:[]},'operator',`prepare-${role}`);
    store.start({id:reference.runId,machine:'mac',session:'session',project,ticket,role:role==='recovery'?'recovery':role,resource:'heavy',locks:[],workflowVersion:1});
    const evidencePath = role === 'verifier' ? 'handoff/verifier-3.md' : `${role}.log`;
    reference.inspectedPaths = [evidencePath];
    const files = {[options.metadata?'run.json':evidencePath]:`Retained ${role}: host isolation and task-menu findings\n`};
    const manifest = artifactManifest(files), digest = manifestHash(manifest);
    evidence.begin('mac',project,ticket,reference.runId,{kind:role==='recovery'?'recovery':'agent',role,outcome:'failed',startedAt:1,endedAt:2},manifest);
    for (const [path,content] of Object.entries(files)) evidence.put('mac',project,ticket,reference.runId,digest,path,0,Buffer.from(content).toString('base64'));
    evidence.commit('mac',project,ticket,reference.runId,digest);
    store.finish('mac','session',reference.runId);
    reference.digest = digest;
    store.workflow.change(ticket,{status:prior.status,labels:prior.labels,blockedBy:prior.blockedBy},'operator',`restore-${role}`);
  }
  if(options.oversized) {plan.children[1].body += '\n'+'context '.repeat(5500);plan.children[1].checks=['check '.repeat(900),'another '.repeat(700),'third '.repeat(900)];}
  const [incident] = store.recoveryReport('mac',project,[observationFor(project,store.workflow.get(ticket))]);
  const recoveryRun = {id:'active-recovery',machine:'mac',session:'session',project,ticket,role:'recovery',resource:'heavy' as const,locks:[],workflowVersion:1 as const};
  assert.equal(store.start(recoveryRun).ok,true);
  store.recoveryStep('mac','session',project,incident.id,recoveryRun.id,'begin');
  store.recoveryStep('mac','session',project,incident.id,recoveryRun.id,'decide',{action:'split',reason:plan.justification,split:plan});
  const issues = new Map<number,WorkflowItem>(), calls:string[]=[];
  const faults = {afterLink:0,loseCreate:0};
  const fetcher = (async (input:any,init:any) => {
    const url = new URL(String(input)), b=init.body?JSON.parse(String(init.body)):undefined;
    if (url.pathname===`/repos/${project}/issues` && init.method==='POST') {
      const n=100+issues.size, child=item(n,{title:b.title,body:b.body,labels:b.labels,status:'Inbox'});issues.set(n,child);calls.push(`create:${n}`);
      if (faults.loseCreate-- > 0) return new Response('lost create answer',{status:502});
      return Response.json({node_id:child.issueId},{status:201});
    }
    if (url.pathname===`/repos/${project}/issues` && init.method==='GET') return Response.json([...issues.values()].reverse().map(i=>({node_id:i.issueId,body:i.body,created_at:new Date().toISOString()})));
    if (url.pathname==='/graphql') {
      if (b.query.includes('addProjectV2ItemById')) return Response.json({data:{addProjectV2ItemById:{item:{id:`P${Number(b.variables.issue.slice(1))}`}}}});
      if (b.query.includes('addSubIssue')) {
        const child=[...issues.values()].find(i=>i.issueId===b.variables.child)!;child.parentNumber=3;child.grandparentNumber=2;calls.push(`link:${child.issueNumber}`);
        if(faults.afterLink-- > 0) return new Response('lost link answer',{status:502});
        return Response.json({data:{addSubIssue:{issue:{id:'I3'}}}});
      }
      const child=[...issues.values()].find(i=>i.issueId===b.variables.id)!;
      return Response.json({data:{node:{id:child.issueId,number:child.issueNumber,title:child.title,body:child.body,url:child.url,state:child.state,repository:{nameWithOwner:project},labels:{nodes:child.labels.map(name=>({name})),pageInfo:{hasNextPage:false}},blockedBy:{nodes:[],pageInfo:{hasNextPage:false}},parent:child.parentNumber?{number:child.parentNumber,parent:{number:child.grandparentNumber}}:null,subIssuesSummary:{total:0,completed:0},projectItems:{nodes:[{id:child.id,project:{id:'P'},fieldValueByName:{name:'Inbox'}}],pageInfo:{hasNextPage:false}}}}});
    }
    throw new Error(`Unexpected ${url.pathname}`);
  }) as typeof fetch;
  const broker = new GitHubBroker({token:'test',projects:[project],fetcher});
  const bridge = new WorkflowGitHub(store,broker), actor={machine:'mac',session:'session',runId:recoveryRun.id};
  t.after(()=>{evidence.close();store.close();});
  return {store,evidence,plan,incident,actor,bridge,calls,faults,issues};
}

test('grandchild recovery split preserves full feature root, security, regression, evidence, ownership and dependency order',async t=>{
  const f=await fixture(t), before=f.store.snapshot().claims;
  const result:any=await f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor);
  assert.equal(result.state,'complete');
  const parent=f.store.workflow.get(ticket), a=f.store.workflow.get('org/app#100'), b=f.store.workflow.get('org/app#101');
  assert.equal(parent.state,'CLOSED');assert.equal(parent.status,'Done');assert.equal(f.store.ticketDone(ticket),false);
  for (const child of [a,b]) {assert.equal(child.featureRoot,'org/app#1');assert.equal(child.parentNumber,3);assert.equal(child.status,'Backlog');assert(child.labels.includes('security-sensitive'));assert(child.labels.includes('needs-real-claude'));assert(!child.labels.includes('done:verifier'));assert(!child.labels.includes('done:refiner'));assert(child.body.includes('Regression:'));assert(child.body.includes('<!-- ticket-scope-policy: behaviour-slices-v1 -->'));}
  assert(a.position>parent.position && b.position>a.position);
  assert(b.blockedBy.some(x=>x.number===100&&x.state==='OPEN'));
  assert(!a.blockedBy.some(x=>x.number===3));
  assert.deepEqual(f.store.workflow.get('org/app#4').blockedBy.filter(x=>x.state==='OPEN').map(x=>x.number),[100,101]);
  assert.deepEqual(f.store.snapshot().claims,before);assert.equal(f.evidence.list(ticket).length,3);
  assert(f.store.workflow.comments(ticket).some(c=>c.body.includes('remains incomplete')));
  await f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor);
  assert.equal(f.calls.filter(c=>c.startsWith('create')).length,2);
});

test('lost creation/link answers retain blocked partial children and protected operator resumes one durable split',async t=>{
  const f=await fixture(t);f.faults.afterLink=1;
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor),/GitHub unavailable/);
  assert.equal(f.store.workflow.get(ticket).state,'OPEN');assert.equal(f.store.workflow.get('org/app#100').status,'Inbox');
  assert.equal(f.store.start({id:'child-builder',machine:'mac',session:'session',project,ticket:'org/app#100',role:'builder',resource:'heavy',locks:[],workflowVersion:1}).ok,false);
  f.store.finish('mac','session',f.actor.runId,false);
  await f.bridge.recoverySplit(f.incident.id,f.evidence);
  assert.equal(f.store.workflow.get(ticket).state,'CLOSED');assert.equal(f.calls.filter(c=>c==='create:100').length,1);assert.equal(f.calls.filter(c=>c==='link:100').length,1);
});

test('a held or edited partial child cannot be activated and the original parent stays open',async t=>{
  const f=await fixture(t);f.faults.afterLink=1;
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor));
  f.store.workflow.change('org/app#100',{addLabels:['needs-human:security']},'operator','hold-child');
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor),/changed|hold/);
  assert.equal(f.store.workflow.get(ticket).state,'OPEN');assert.equal(f.issues.size,1);
});

test('operator drains and active dependent reservations prevent splitting without touching running work',async t=>{
  const f=await fixture(t);
  assert.equal(f.store.start({id:'dependent-refiner',machine:'linux',session:'other',project,ticket:'org/app#4',role:'recovery',resource:'heavy',locks:[],workflowVersion:1}).ok,false,'only one fleet recovery runs');
  // A retained native support task is equally affected, even with a synthetic run ticket.
  f.store.tasks.report('linux',{ready:true,capabilities:['linux-amd64'],revision:'a'.repeat(40)} as any);
  const task=f.store.tasks.request('org/app#4',{recipe:'platform-probe',capability:'linux-amd64',reason:'Retained dependent native task'});
  const started=f.store.start({id:'support',machine:'linux',session:'other',project,ticket:`${project}#@task-${task.id}`,parentTicket:'org/app#4',supportTaskId:task.id,role:'recovery-task',resource:'light',locks:[]});
  assert.equal(started.ok,true);
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor),/running|support/);
  assert.equal(f.store.snapshot().runs.some(r=>r.id==='support'),true);assert.equal(f.issues.size,0);
});

test('metadata-only evidence cannot justify splitting an unresolved defect',async t=>{
  const f=await fixture(t,{metadata:true});
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor),/substantive retained/);
  assert.equal(f.issues.size,0);assert.equal(f.store.workflow.get(ticket).state,'OPEN');
});

test('scope validation rejects infrastructure, dropped acceptance, detached regression, marker conflicts and unchanged deeper scope',()=>{
  const p=recoverySplitFixturePlan();assert(validateRecoverySplit(p));
  assert.throws(()=>validateRecoverySplit({...p,children:p.children.map(c=>({...c,body:body+'\n'+c.regression}))}),/repeats scope/);
  assert.throws(()=>validateRecoverySplit({...p,classification:'infrastructure'}));
  assert.throws(()=>validateRecoverySplit({...p,children:p.children.map((c,i)=>i?c:{...c,body:'Unused plumbing'})}));
  assert.throws(()=>validateRecoverySplit({...p,children:p.children.map((c,i)=>i?c:{...c,body:c.body+'\n<!-- feature-root: org/app#9 -->'})}));
  assert.deepEqual(splitRequirements(body),['Selected host history stays isolated','Background task menu updates independently','Authentication checks remain required']);
  const current=item(3,{body,labels:['rework-count:2']});
  const duplicated = {...p,children:p.children.map(c=>({...c,body:body+'\n'+c.regression})),requirements:splitRequirements(body).flatMap(text=>p.children.map(c=>({text,child:c.key})))};
  assert.throws(()=>validateSplitAgainstTicket(duplicated,current,'org/app#1'),/cannot be duplicated/);
  assert.throws(()=>validateSplitAgainstTicket({...p,requirements:p.requirements.slice(1)},current,'org/app#1'),/every original acceptance/);
  assert.throws(()=>validateSplitAgainstTicket(p,{...current,recoverySlice:{id:'old',featureRoot:'org/app#1',behaviours:['Only the assigned original result']}},'org/app#1'),/immutable previously assigned/);
});


test('lost issue creation answer resumes by its retained marker without duplicate children',async t=>{
  const f=await fixture(t);f.faults.loseCreate=1;
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor),/GitHub unavailable/);
  assert.equal(f.issues.size,1);assert.equal(f.store.workflow.get(ticket).state,'OPEN');
  await f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor);
  assert.equal(f.issues.size,2);assert.equal(f.calls.filter(c=>c==='create:100').length,1);
});

test('a newly discovered dependent is safely enlisted and remains blocked after replacement',async t=>{
  const f=await fixture(t);f.faults.afterLink=1;
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor));
  f.store.workflow.observe(project,[item(9,{blockedBy:[{number:3,state:'OPEN',url:f.store.workflow.get(ticket).url}]})]);
  await f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor);
  assert.equal(f.store.workflow.get(ticket).state,'CLOSED');
  assert.deepEqual(f.store.workflow.get('org/app#9').blockedBy.filter(b=>b.state==='OPEN').map(b=>b.number),[100,101]);
});

test('plain and nested acceptance clauses remain required, while fenced source examples are evidence',()=>{
  assert.deepEqual(splitRequirements('## Acceptance Criteria\n- [ ] Save history\n### Failure handling\n- Return prior state after a failed write.\n## Context\nAn example follows.\n```md\n- [ ] Quoted unrelated item\n```'),['Save history','- Return prior state after a failed write.']);
});


test('an operator drain inserted during a partial split survives refusal and exact retry after resuming',async t=>{
  const f=await fixture(t);f.faults.afterLink=1;
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor));
  f.store.setDesired({machines:['mac'],project,change:{work:'drained'}});
  const before=f.store.desired.document('mac');
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor),/drains/);
  assert.deepEqual(f.store.desired.document('mac'),before);assert.equal(f.store.workflow.get(ticket).state,'OPEN');
  f.store.setDesired({machines:['mac'],project,change:{work:'taking'}});
  await f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor);
  assert.equal(f.store.workflow.get(ticket).state,'CLOSED');
});

test('metadata-only evidence failure leaves no durable split lock or half-applied workflow',async t=>{
  const f=await fixture(t,{metadata:true});
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor));
  assert.equal(f.store.splits.get(f.incident.id),undefined);
  assert.equal(f.store.splits.pending(ticket),false);assert.equal(f.store.splits.pending('org/app#4'),false);
});

test('a completed prerequisite during partial creation does not strand the same retry',async t=>{
  const f=await fixture(t,{causal:true});
  f.faults.afterLink=1;
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor));
  f.store.workflow.change('org/app#5',{state:'CLOSED',status:'Done'},'operator','prerequisite-completed');
  await f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor);
  const child=f.store.workflow.get('org/app#100');
  assert(child.blockedBy.some(b=>b.number===5 && b.state==='CLOSED'));
});


test('a changed child recovered after a lost create answer cannot replace its original acceptance',async t=>{
  const f=await fixture(t);f.faults.loseCreate=1;
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor));
  const child=f.issues.get(100)!;child.body=child.body.replaceAll('Selected host history stays isolated','Dropped original result');
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor),/content changed/);
  assert.equal(f.store.workflow.get(ticket).state,'OPEN');assert.equal(f.issues.size,1);
});


test('assessment split decision invokes only its protected split handoff and preserves ordinary counters',async t=>{
  const f=await fixture(t);let handoffs=0, completed=0;
  await runRecoveryWork(f.incident,{project,agents:[],readCurrent:async()=>f.store.workflow.get(ticket),begin:async()=>({...f.incident,state:'assessing'}),assess:async()=>({action:'split',reason:f.plan.justification,split:f.plan}),decide:async decision=>decision,complete:async()=>{completed++;},split:async()=>{handoffs++;return f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor);},comment:async()=>{throw new Error('Generic handback cannot edit split parents');},addLabel:async()=>{},removeLabel:async()=>{},move:async()=>{throw new Error('Generic handback cannot move split parents');},notify:async()=>{}});
  assert.equal(handoffs,1);assert.equal(completed,1);assert(f.store.workflow.get(ticket).labels.includes('rework-count:3'));
});

test('every fully rendered child is checked before durable locks or any external creation',async t=>{
  const f=await fixture(t,{oversized:true});
  await assert.rejects(f.bridge.recoverySplit(f.incident.id,f.evidence,f.actor),/60000/);
  assert.equal(f.store.splits.get(f.incident.id),undefined);assert.equal(f.issues.size,0);
});


test('one broad original acceptance criterion can be retained by the final child of two useful behaviours',()=>{
  const p=recoverySplitFixturePlan();
  const original='The selected host history and background task menu both work after repair';
  const parentBody=`## Acceptance Criteria\n- [ ] ${original}`;
  p.bodyHash=splitBodyHash(parentBody);
  p.requirements=[{text:original,child:'task-menu'}];
  p.children[1].body+=`\n- [ ] ${original}`;
  validateRecoverySplit(p);
  validateSplitAgainstTicket(p,item(3,{body:parentBody,labels:['rework-count:2']}),'org/app#1');
  assert.equal(p.requirements.length,1);assert.equal(p.behaviours.length,2);
});
