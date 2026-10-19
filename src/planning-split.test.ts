import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetStore, OwnershipRefusal } from './fleet-store.js';
import type { WorkflowItem } from './workflow-store.js';
import { WorkflowGitHub } from './workflow-github.js';
import { GitHubBroker } from './github-broker.js';

const project = 'org/desktop';
const parent = `${project}#2098`;
const actor = { machine: 'box', session: 's', runId: 'refiner-2098' };
const item = (n: number, extra: Partial<WorkflowItem> = {}): WorkflowItem => ({
  id: `P${n}`, issueId: `I${n}`, issueNumber: n, title: `Ticket ${n}`, body: 'Acceptance remains in the child.',
  url: `https://github.com/${project}/issues/${n}`, state: 'OPEN', status: 'Inbox', labels: [],
  blockedBy: [], parentNumber: null, grandparentNumber: null, revision: 1, position: n, ...extra,
});
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'planning-split-'));
  const path = join(dir, 'claims.sqlite');
  let store = new FleetStore(path, { box: { heavyLimit: 4, combinedLimit: 4 } });
  const config = { project, projectId: 'P', statusFieldId: 'S', options: { Inbox: 'inbox', Backlog: 'backlog', Done: 'done', Halted: 'halted' } };
  store.workflow.import(config, [
    item(2098, { status: 'Backlog', labels: ['enhancement', 'priority:normal', 'security-sensitive'], subIssues: { total: 2, completed: 0 } }),
    item(2106, { parentNumber: 2098 }), item(2107, { parentNumber: 2098 }),
    item(2100, { status: 'Backlog', blockedBy: [{ number: 2098, state: 'OPEN', url: item(2098).url }] }),
  ]);
  assert.equal(store.start({ workflowVersion: 1, id: actor.runId, machine: actor.machine, session: actor.session,
    project, ticket: parent, role: 'refiner', resource: 'heavy', locks: [] }).ok, true);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen() { store.close(); store = new FleetStore(path, { box: { heavyLimit: 4, combinedLimit: 4 } }); } };
}
function plan(store: FleetStore) {
  return { commandId: 'split-2098', summary: 'Typography and spacing replace the original ticket.',
    revision: store.workflow.get(parent).revision,
    children: [2106, 2107].map(number => ({ number, revision: store.workflow.get(`${project}#${number}`).revision, dependsOn: [] as number[] })),
    dependents: [{ ticket: `${project}#2100`, revision: store.workflow.get(`${project}#2100`).revision, children: [2106, 2107] }],
  };
}
const finish = (store: FleetStore, request = plan(store), who = actor) => (store as any).finalizePlanningSplit(who, parent, request);

test('Desktop #2098: activate children, transfer prerequisites and close the parent in one commit', t => {
  const { store } = fixture(t);
  const before = plan(store);
  const result = finish(store, before);
  assert.equal(result.parent.state, 'CLOSED');
  assert.equal(result.parent.status, 'Done');
  for (const number of [2106, 2107]) {
    const child = store.workflow.get(`${project}#${number}`);
    assert.equal(child.state, 'OPEN'); assert.equal(child.status, 'Backlog');
    assert.equal(child.featureRoot, parent);
    assert.ok(child.labels.includes('priority:normal')); assert.ok(child.labels.includes('security-sensitive'));
  }
  assert.deepEqual(store.workflow.get(`${project}#2100`).blockedBy.map(b => b.number), [2098, 2106, 2107]);
  assert.equal(store.workflow.comments(parent).length, 1);
  assert.match(store.workflow.comments(parent)[0].body, /replace|Replaced/);
  // Replacement is not feature delivery: leaves stay open and independently verifiable.
  assert.equal(store.workflow.get(parent).subIssues?.completed, 0);
});

test('lost acknowledgement survives process restart and finished ownership without repeating writes', t => {
  const f = fixture(t), request = plan(f.store);
  const first = finish(f.store, request);
  f.store.finish(actor.machine, actor.session, actor.runId);
  f.reopen();
  assert.deepEqual(finish(f.store, request), first);
  assert.equal(f.store.workflow.comments(parent).length, 1);
  assert.throws(() => finish(f.store, { ...request, summary: 'different request' }), /identity|reused/);
  assert.throws(() => finish(f.store, request, { ...actor, session: 'foreign' }), /identity|owner/);
});

test('a failure after the first child write rolls the whole split back; exact retry then succeeds', t => {
  const { store } = fixture(t), request = plan(store);
  const change = store.workflow.change.bind(store.workflow);
  let writes = 0;
  store.workflow.change = ((...args: Parameters<typeof change>) => {
    if (++writes === 2) throw Error('controlled interruption');
    return change(...args);
  }) as typeof change;
  assert.throws(() => finish(store, request), /controlled interruption/);
  store.workflow.change = change;
  assert.equal(store.workflow.get(parent).state, 'OPEN');
  assert.equal(store.workflow.get(`${project}#2106`).status, 'Inbox');
  assert.equal(store.workflow.get(`${project}#2106`).featureRoot, undefined);
  assert.deepEqual(store.workflow.get(`${project}#2100`).blockedBy.map(b => b.number), [2098]);
  assert.equal(store.workflow.comments(parent).length, 0);
  assert.equal(finish(store, request).parent.state, 'CLOSED');
});

test('a missing dependent or child cannot prematurely unblock existing work', t => {
  const { store } = fixture(t), request = plan(store);
  assert.throws(() => finish(store, { ...request, dependents: [] }), /dependent/);
  assert.throws(() => finish(store, { ...request, children: request.children.slice(0, 1) }), /child|children/);
  assert.equal(store.workflow.get(parent).state, 'OPEN');
  assert.equal(store.workflow.get(`${project}#2106`).status, 'Inbox');
});

test('concurrent changes, active dependents and recorded approval rejections preserve the partial split', t => {
  const { store } = fixture(t), request = plan(store);
  store.workflow.change(`${project}#2107`, { addLabels: ['security-sensitive'] }, 'operator', 'concurrent');
  assert.throws(() => finish(store, request), /changed|revision/);
  const fresh = plan(store);
  assert.equal(store.start({ workflowVersion: 1, id: 'other', machine: actor.machine, session: actor.session,
    project, ticket: `${project}#2100`, role: 'recovery', resource: 'heavy', locks: [] }).ok, true);
  assert.throws(() => finish(store, fresh), /active|running/);
  store.finish(actor.machine, actor.session, 'other');
  store.approvals.record(parent, actor.runId, 'refiner', { approvalReviewFailed: false, hadPermissionDenial: true });
  assert.throws(() => finish(store, fresh), /approval|rejection/);
  assert.equal(store.workflow.get(parent).state, 'OPEN');
});

test('a cycle introduced by a declared child dependency rolls back parent closure and activation', t => {
  const { store } = fixture(t), request = plan(store);
  request.children[0].dependsOn = [2107]; request.children[1].dependsOn = [2106];
  assert.throws(() => finish(store, request), /cycle|earlier|order/);
  assert.equal(store.workflow.get(parent).state, 'OPEN');
  assert.equal(store.workflow.get(`${project}#2106`).status, 'Inbox');
});

test('a finished or crashed creator never releases a linked child before parent replacement', t => {
  const f = fixture(t);
  f.store.recordTicketCreator(actor.machine, actor.session, actor.runId, 'I2106');
  assert.throws(() => f.store.workflowChange(actor.machine, actor.session, actor.runId, parent,
    { addLabels: ['done:refiner'] }, 'false-completion'), /finalize/);
  f.store.workflow.change(`${project}#2106`, { status: 'Backlog' }, 'operator', 'legacy-early-activation');
  f.store.finish(actor.machine, actor.session, actor.runId, false);
  f.reopen();
  const startChild = () => f.store.start({ workflowVersion: 1, id: 'child', machine: actor.machine, session: actor.session,
    project, ticket: `${project}#2106`, role: 'refiner', resource: 'heavy', locks: [] });
  assert.deepEqual(startChild(), { ok: false, reason: 'locked' });
  const recoveryActor = { ...actor, runId: 'recovered-refiner' };
  assert.equal(f.store.start({ workflowVersion: 1, id: recoveryActor.runId, machine: actor.machine, session: actor.session,
    project, ticket: parent, role: 'refiner', resource: 'heavy', locks: [] }).ok, true);
  finish(f.store, plan(f.store), recoveryActor);
  assert.equal(startChild().ok, true);
});

test('provisional parent blockers on children are replaced, not mistaken for external dependents', t => {
  const { store } = fixture(t);
  store.workflow.change(`${project}#2106`, { blockedBy: [{ number: 2098, state: 'OPEN', url: item(2098).url }] }, 'operator', 'provisional');
  finish(store);
  assert.equal(store.workflow.get(`${project}#2106`).blockedBy.length, 0);
});

function bridgeFixture(t: TestContext) {
  const f = fixture(t);
  let incomplete = false, unavailable = false, reads = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    reads++;
    if (unavailable) throw Error('GitHub unavailable');
    const input = JSON.parse(String(init?.body));
    if (input.query.includes('addSubIssue')) return Response.json({ data: { addSubIssue: { issue: { id: 'I2098' } } } });
    if (input.query.includes('subIssues(first:100)')) return Response.json({ data: { node: {
      id: 'I2098', subIssues: { nodes: [2106, 2107].map(number => ({ number, id: `I${number}` })), pageInfo: { hasNextPage: incomplete } },
      blocking: { nodes: [{ id: 'I2100', number: 2100, state: 'OPEN', repository: { nameWithOwner: project } }], pageInfo: { hasNextPage: false } },
    } } });
    const n = Number(input.variables.id.slice(1)), i = f.store.workflow.get(`${project}#${n}`);
    return Response.json({ data: { node: {
      id: i.issueId, number: n, title: i.title, body: i.body, url: i.url, state: i.state, repository: { nameWithOwner: project },
      labels: { nodes: [], pageInfo: { hasNextPage: false } }, blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
      parent: n === 2106 || i.parentNumber ? { number: n === 2106 ? 2098 : i.parentNumber, parent: null } : null,
      subIssuesSummary: i.subIssues ?? { total: 0, completed: 0 },
      projectItems: { nodes: [{ id: i.id, project: { id: 'P' }, fieldValueByName: { name: i.status } }], pageInfo: { hasNextPage: false } },
    } } });
  };
  const api = new WorkflowGitHub(f.store, new GitHubBroker({ token: 'central', projects: [project], fetcher }));
  const call = (method: string, body?: unknown, who = actor, target = project) => api.request(target, {
    method, path: `/repos/${project}/issues/2098/split`, ...(body ? { body: JSON.stringify(body) } : {}),
  }, who);
  return { ...f, api, call, get reads() { return reads; }, truncate() { incomplete = true; }, disconnect() { unavailable = true; } };
}

test('the managed bridge inspects fresh family links and retries a committed finalizer without GitHub', async t => {
  const f = bridgeFixture(t);
  const inspected = JSON.parse((await f.call('GET')).body);
  assert.deepEqual(inspected.children.map((c: any) => c.number), [2106, 2107]);
  const request = { ...inspected, commandId: 'bridge-split', summary: 'Partition the original acceptance.' };
  request.dependents[0].children = [2106, 2107];
  const result = await f.call('POST', request);
  assert.equal(JSON.parse(result.body).parent.state, 'CLOSED');
  const reads = f.reads;
  f.store.finish(actor.machine, actor.session, actor.runId);
  f.disconnect();
  assert.deepEqual(await f.call('POST', request), result);
  assert.equal(f.reads, reads);
});

test('truncated inventories, wrong projects and stale/foreign run identities cannot close the parent', async t => {
  const f = bridgeFixture(t), request = plan(f.store);
  f.truncate();
  await assert.rejects(f.call('POST', request), /incomplete/);
  await assert.rejects(f.call('POST', request, actor, 'org/other'), /workflow authority/);
  await assert.rejects(f.call('POST', request, { ...actor, runId: 'another' }), /ownership|active run|finished/);
  assert.equal(f.store.workflow.get(parent).state, 'OPEN');
  assert.equal(f.store.workflow.get(`${project}#2106`).status, 'Inbox');
});

test('a declared foreign prerequisite handoff preserves the dependent claim and every existing blocker', t => {
  const { store } = fixture(t), foreign = 'org/reader', target = `${foreign}#3001`;
  store.workflow.import({ project: foreign, projectId: 'R', statusFieldId: 'RS', options: { Inbox: 'i', Backlog: 'b', 'In Development': 'dev', Done: 'd' } },
    [item(3001, { url: `https://github.com/${foreign}/issues/3001`, status: 'In Development' })]);
  assert.equal(store.start({ workflowVersion: 1, id: 'reader-builder', machine: actor.machine, session: actor.session,
    project: foreign, ticket: target, role: 'builder', resource: 'heavy', locks: [] }).ok, true);
  store.finish(actor.machine, actor.session, 'reader-builder');
  store.workflowOperator(target, { blockedBy: [{ number: 2098, state: 'OPEN', url: item(2098).url }] }, 'existing-prerequisite', store.workflow.get(target).revision);
  const claims = store.snapshot().claims;
  const request = plan(store);
  request.dependents.push({ ticket: target, revision: store.workflow.get(target).revision, children: [2106] });
  finish(store, request);
  assert.deepEqual(store.snapshot().claims, claims);
  assert.deepEqual(store.workflow.get(target).blockedBy.map(b => b.url), [item(2098).url, item(2106).url]);
  assert.equal(store.workflow.get(target).status, 'In Development');
});

test('an ended planning run cannot initiate a split, and child holds cannot be silently cleared', t => {
  const { store } = fixture(t);
  store.workflowOperator(`${project}#2107`, { addLabels: ['held:operator'] }, 'held-child', store.workflow.get(`${project}#2107`).revision);
  assert.throws(() => finish(store), /holds/);
  store.finish(actor.machine, actor.session, actor.runId);
  assert.throws(() => finish(store), /finished|ownership/);
  assert.equal(store.workflow.get(parent).state, 'OPEN');
});

test('linking a new child refreshes parentage before a creator can finish and release the general hold', async t => {
  const f = bridgeFixture(t), ref = `${project}#2106`;
  f.store.workflow.observe(project, [{ ...f.store.workflow.get(ref), parentNumber: null }]);
  f.store.recordTicketCreator(actor.machine, actor.session, actor.runId, 'I2106');
  await f.api.request(project, { method: 'POST', path: '/graphql', body: JSON.stringify({
    query: 'mutation($input:AddSubIssueInput!){addSubIssue(input:$input){issue{id}}}',
    variables: { input: { issueId: 'I2098', subIssueId: 'I2106' } },
  }) }, actor);
  assert.equal(f.store.workflow.get(ref).parentNumber, 2098);
  f.store.finish(actor.machine, actor.session, actor.runId);
  assert.equal(f.store.planningSplits.childPending(f.store.workflow.get(ref), project), true);
});

test('finalization refuses to overwrite an existing child feature root', t => {
  const { store } = fixture(t), ref = `${project}#2106`;
  store.workflow.recoveryMetadata(ref, { featureRoot: `${project}#1000` });
  assert.throws(() => finish(store), /feature root|lineage/);
  assert.equal(store.workflow.get(ref).featureRoot, `${project}#1000`);
  assert.equal(store.workflow.get(parent).state, 'OPEN');
});

test('a stale split is an explicit workflow refusal, not a masked GitHub service outage', async t => {
  const f = bridgeFixture(t), inspected = JSON.parse((await f.call('GET')).body);
  const request = { ...inspected, commandId: 'stale-bridge', summary: 'Preserve acceptance.', revision: inspected.revision + 1 };
  request.dependents[0].children = [2106];
  await assert.rejects(f.call('POST', request), error => error instanceof OwnershipRefusal && /changed/.test(error.message));
  assert.equal(f.store.workflow.get(parent).state, 'OPEN');
});
