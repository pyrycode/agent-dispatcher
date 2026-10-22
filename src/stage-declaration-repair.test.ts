import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetStore, type StartRequest } from './fleet-store.js';
import { EvidenceStore, DEFAULT_EVIDENCE_LIMITS } from './evidence-store.js';
import { artifactManifest } from './recovery-artifacts.js';
import { GATE_PARSER_VERSION } from './gate-output.js';
import type { WorkflowItem } from './workflow-store.js';
import type { StageSubmission } from './stage-results.js';

const project = 'org/core', ticket = project + '#3620', sha = 'a'.repeat(40);
const capture = 'evidence/gate-runs/run/main/capture.jsonl', text = '{"capture":"complete"}\n';
const config = { project, projectId: 'P', statusFieldId: 'S', options: { Inbox: 'i', 'In Development': 'd', 'In Code Review': 'r', 'In Documentation': 'doc', Done: 'done' } };
const item: WorkflowItem = { id: 'P3620', issueId: 'I3620', issueNumber: 3620, title: 'Capture', body: 'Capture the named scenario', url: 'https://github.com/org/core/issues/3620', status: 'Inbox', state: 'OPEN', revision: 1, position: 1, labels: ['needs-live-artifacts', 'needs-real-claude', 'done:verifier', 'rework-count:2'], blockedBy: [], parentNumber: null, grandparentNumber: null };
const run = (id = 'capture', role = 'real-claude-gate'): StartRequest => ({ workflowVersion: 1, id, machine: 'linux', session: 's', project, ticket, role, resource: 'light', locks: [] });
const liveResult = (): StageSubmission => ({ version: 1, candidate: sha, files: [], checks: [{ name: 'live-acceptance', outcome: 'passed', evidence: JSON.stringify({ report: { headSha: sha, outputFormat: 'go-json', command: 'go test -json ./...', runError: null, timedOut: false, exitCode: 0, tally: { parserVersion: GATE_PARSER_VERSION, completeParse: true, recognizedLines: 10, executed: 1, passed: 1, failed: 0, skipped: 0, passedNames: ['pkg.TestCapture'], failedNames: [], skippedTests: [], packageFailed: false, packageFailures: [], timedOutTests: [] }, rerunFailures: null, baselineFailures: null } }) }] });
function fixture(database = ':memory:', finish = true, submission = liveResult()) {
 const store = new FleetStore(database, { linux: { heavyLimit: 1, combinedLimit: 2 } });
 const evidence = new EvidenceStore(':memory:', DEFAULT_EVIDENCE_LIMITS, id => store.runOwner(id));
 store.workflow.import(config, [item]);
 assert.equal(store.start(run()).ok, true);
 store.stagePlan('linux', 's', ticket, 'capture', { version: 1, kind: 'live-gate', candidate: sha, checks: ['live-acceptance'], artifacts: [], minExecuted: 1, requiredTests: ['TestCapture'] });
 const waiting = store.stageResult('linux', 's', ticket, 'capture', submission);
 if (finish) store.finish('linux', 's', 'capture');
 const inventory = JSON.stringify({ ticket, runId: 'capture', machine: 'linux', candidateRevision: sha, files: [{ path: capture, bytes: Buffer.byteLength(text), included: 'whole' }] });
 const files = { [capture]: text, 'run.json': inventory };
 const manifest = artifactManifest(files);
 const upload = evidence.begin('linux', project, ticket, 'capture', { kind: 'gate', role: 'real-claude-gate', outcome: 'waiting', candidateRevision: sha, startedAt: 1, endedAt: 2 }, manifest);
 for (const [path, contents] of Object.entries(files)) evidence.put('linux', project, ticket, 'capture', upload.digest, path, 0, Buffer.from(contents).toString('base64'));
 evidence.commit('linux', project, ticket, 'capture', upload.digest);
 const input = { commandId: 'repair-3620', ticket, revision: store.workflow.get(ticket).revision, runId: 'capture', candidate: sha, pullRequest: 3621, evidence: { runId: 'capture', digest: upload.digest }, captures: [capture] };
 return { store, evidence, input, waiting };
}

test('declaration wait returns to ordinary builder without accepting or changing the original result', () => {
 const { store, evidence, input, waiting } = fixture();
 try {
  assert.equal(store.start(run('before', 'builder')).ok, false, 'held builder reproduces the deadlock');
  const claim = store.snapshot().claims;
  const repaired = store.repairStageDeclaration(input, evidence);
  assert.equal(repaired.status, 'In Development');
  assert.ok(!repaired.labels.includes('held:stage-result'));
  assert.ok(!repaired.labels.includes('done:builder'));
  assert.ok(!repaired.labels.includes('done:verifier'));
  assert.ok(repaired.labels.includes('needs-live-artifacts'));
  assert.ok(repaired.labels.includes('needs-real-claude'));
  assert.ok(repaired.labels.includes('rework-count:2'));
  assert.deepEqual(store.stages.get('capture'), waiting);
  assert.deepEqual(store.snapshot().claims, claim);
  assert.equal(store.start(run('builder', 'builder')).ok, true);
  assert.deepEqual(store.repairStageDeclaration(input, undefined), repaired, 'lost response is safe after builder starts');
  assert.equal(Buffer.from(evidence.read(ticket, 'capture', input.evidence.digest, capture, 0).data, 'base64').toString(), text);
 } finally { evidence.close(); store.close(); }
});

test('exact handoff retries survive restart and reject reused identities', () => {
 const dir = mkdtempSync(join(tmpdir(), 'declaration-repair-')), db = join(dir, 'fleet.sqlite');
 const { store, evidence, input } = fixture(db);
 let reopened: FleetStore | undefined;
 try {
  const repaired = store.repairStageDeclaration(input, evidence);
  store.close();
  reopened = new FleetStore(db, { linux: { heavyLimit: 1, combinedLimit: 2 } });
  assert.deepEqual(reopened.repairStageDeclaration(input, undefined), repaired);
  const restored = reopened;
  assert.throws(() => restored.repairStageDeclaration({ ...input, candidate: 'b'.repeat(40) }, evidence), /identity/);
 } finally { evidence.close(); reopened?.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const change of ['revision', 'candidate', 'digest', 'missing bundle', 'empty captures', 'log pointer', 'traversal'] as const) {
 test(`refuses ${change} without a workflow mutation`, () => {
  const {store,evidence,input,waiting}=fixture();
  try {
   const invalid = structuredClone(input);
   if(change==='revision') invalid.revision++;
   if(change==='candidate') invalid.candidate='b'.repeat(40);
   if(change==='digest') invalid.evidence.digest='b'.repeat(64);
   if(change==='missing bundle') invalid.evidence.runId='missing';
   if(change==='empty captures') invalid.captures=[];
   if(change==='log pointer') invalid.captures=['pointers.json'];
   if(change==='traversal') invalid.captures=['../capture.jsonl'];
   const before=store.workflow.get(ticket);
   assert.throws(()=>store.repairStageDeclaration(invalid,evidence));
   assert.deepEqual(store.workflow.get(ticket),before);
   assert.deepEqual(store.stages.get('capture'),waiting);
  } finally {evidence.close();store.close();}
 });
}
test('refuses a source whose execution is still active',()=>{
 const {store,evidence,input}=fixture(':memory:',false);
 try {
  const before=store.workflow.get(ticket);
  assert.throws(()=>store.repairStageDeclaration(input,evidence),/execution has not ended/);
  assert.deepEqual(store.workflow.get(ticket),before);
 }finally{evidence.close();store.close();}
});
test('refuses another incomplete live acceptance cause',()=>{
 const {store,evidence,input}=fixture(':memory:',true,{...liveResult(),checks:[]});
 try {
  assert.throws(()=>store.repairStageDeclaration(input,evidence),/not a terminal undeclared/);
  assert.ok(store.workflow.get(ticket).labels.includes('held:stage-result'));
 }finally{evidence.close();store.close();}
});
test('refuses a newer stage and active or queued support work',()=>{
 for(const kind of ['new stage','support task','active worker']) {
  const {store,evidence,input}=fixture();
  try {
   if(kind==='support task') store.tasks.request(ticket,{recipe:'platform-probe',capability:'linux-amd64',reason:'Retained diagnosis'},'capture');
   else {
    assert.equal(store.start(run('next-live')).ok,true);
    if(kind==='new stage') {
     store.stagePlan('linux','s',ticket,'next-live',{version:1,kind:'live-gate',candidate:sha,checks:['live-acceptance'],artifacts:[],minExecuted:1});
     store.finish('linux','s','next-live');
    }
   }
   const before=store.workflow.get(ticket);
   assert.throws(()=>store.repairStageDeclaration({...input,revision:before.revision},evidence),/not a terminal|active or uncertain/);
   assert.deepEqual(store.workflow.get(ticket),before);
  }finally{evidence.close();store.close();}
 }
});
test('refuses unresolved approval rejection and preserves its history',()=>{
 const {store,evidence,input}=fixture();
 try {
  store.approvals.record(ticket,'capture','real-claude-gate',{approvalReviewFailed:false,hadPermissionDenial:true});
  const approval=store.approvals.get(ticket),before=store.workflow.get(ticket);
  assert.throws(()=>store.repairStageDeclaration(input,evidence),/approval rejection/);
  assert.deepEqual(store.approvals.get(ticket),approval);
  assert.deepEqual(store.workflow.get(ticket),before);
 }finally{evidence.close();store.close();}
});
test('an unrelated manual hold survives and still prevents builder admission',()=>{
 const {store,evidence,input,waiting}=fixture();
 try {
  const held=store.workflowOperator(ticket,{addLabels:['needs-human:operator-hold']},'another-hold',input.revision);
  const repaired=store.repairStageDeclaration({...input,revision:held.revision},evidence);
  assert.ok(repaired.labels.includes('needs-human:operator-hold'));
  assert.equal(store.start(run('blocked-builder','builder')).ok,false);
  assert.deepEqual(store.stages.get('capture'),waiting);
 }finally{evidence.close();store.close();}
});
test('an atomic receipt failure rolls back the workflow change',()=>{
 const {store,evidence,input,waiting}=fixture();
 try {
  (store as any).db.exec("CREATE TRIGGER refuse_declaration_receipt BEFORE INSERT ON fleet_declaration_repairs BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
  const before=store.workflow.get(ticket);
  assert.throws(()=>store.repairStageDeclaration(input,evidence),/receipt unavailable/);
  assert.deepEqual(store.workflow.get(ticket),before);
  assert.deepEqual(store.stages.get('capture'),waiting);
  assert.equal(store.declarationRepairs.saved(input),undefined);
 }finally{evidence.close();store.close();}
});
test('the HTTP handoff requires operator access and the current published candidate',async t=>{
 const {serveFleet,JsonClient}=await import('./fleet-http.js');
 const {GitHubBroker}=await import('./github-broker.js');
 const {store,evidence,input}=fixture();
 let head='b'.repeat(40),repo=project,publicationReads=0;
 const github=new GitHubBroker({token:'test',projects:[project],fetcher:async url=>{
  publicationReads++;
  return new Response(JSON.stringify(String(url).includes('/pulls/')?{state:'open',head:{sha:head,ref:'feature/3620',repo:{full_name:repo}}}:{object:{sha:head}}));
 }});
 const server=await serveFleet(store,{linux:'linux-fixture'},'operator-fixture',0,'127.0.0.1',github,undefined,undefined,undefined,undefined,evidence);
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));evidence.close();store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`,operator=new JsonClient(url,'operator-fixture'),machine=new JsonClient(url,'linux-fixture');
 const request={...input,project};
 await assert.rejects(machine.call('/workflow/declaration-repair',request),/Operator credential/);
 assert.equal(publicationReads,0);
 await assert.rejects(operator.call('/workflow/declaration-repair',request),/candidate changed/);
 head=sha;repo='org/foreign';
 await assert.rejects(operator.call('/workflow/declaration-repair',request),/candidate changed/);
 repo=project;
 const accepted=await operator.call('/workflow/declaration-repair',request),reads=publicationReads;
 head='c'.repeat(40);
 assert.deepEqual(await operator.call('/workflow/declaration-repair',request),accepted);
 assert.equal(publicationReads,reads,'lost response does not require publication to remain unchanged');
 await assert.rejects(operator.call('/workflow/declaration-repair',{...request,project:'org/foreign'}),/project mismatch/);
});

test('changed ticket requirements cannot reuse the old declaration wait',()=>{
 const {store,evidence,input}=fixture();
 try {
  const before=store.workflow.get(ticket);
  store.workflow.observe(project,[{...before,body:before.body+'\nA new required scenario'}]);
  const current=store.workflow.get(ticket);
  assert.throws(()=>store.repairStageDeclaration({...input,revision:current.revision},evidence),/requirements changed/);
  assert.deepEqual(store.workflow.get(ticket),current);
 }finally{evidence.close();store.close();}
});
