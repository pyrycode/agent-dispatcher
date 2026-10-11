import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFamilyDispatchTallies, selectWithFamilyAccounting } from './dispatch.js';
import { shouldSkipDispatch, FAMILY_BREAKER_LABEL } from './pipeline-decisions.js';
import { RecoveryLedger, recoveryFingerprint, recoveryTrigger } from './fleet-recovery.js';
import { DatabaseSync } from 'node:sqlite';
import type { AgentConfig, ProjectItem } from './types.js';

const verifier: AgentConfig = { name: 'verifier', column: 'In Code Review', description: '', claudeMdPath: '', usesWorktree: true, producesCommits: false };
const child: ProjectItem = { id: 'child', issueId: 'issue', issueNumber: 3163, parentNumber: 3100, grandparentNumber: 2962, title: '', body: '', status: 'In Code Review', labels: ['done:builder'], url: '', blockedBy: [] };
function client() {
  const writes: unknown[] = []; const reads: number[] = [];
  return { writes, reads, getFamilyDispatchState: async (root: number) => { reads.push(root); return { markerCount: 1000, breakerCommented: true }; },
    addLabel: async (...args: unknown[]) => { writes.push(args); }, addComment: async (...args: unknown[]) => { writes.push(args); } };
}

test('a family above every former limit keeps candidates and its historical tally without parking writes', async () => {
  const c = client(); const candidates = [{ agent: verifier, item: child }];
  const result = await readFamilyDispatchTallies(candidates, c as any);
  assert.deepEqual(result.kept, candidates); assert.equal(result.tallies.get(2962), 1000);
  assert.deepEqual(c.reads, [2962]); assert.deepEqual(c.writes, []);
});

test('a legacy hold on a closed ancestor or the ticket cannot block runnable review', async () => {
  const result = await selectWithFamilyAccounting({ itemsByColumn: new Map([['In Code Review', [child]]]), pollOrder: [verifier], maxConcurrent: 1,
    rootLabelsByIssue: new Map([[2962, [FAMILY_BREAKER_LABEL, 'family-dispatches:1000']]]), client: client() as any });
  assert.equal(result.candidates[0]?.item.issueNumber, 3163);
  assert.equal(shouldSkipDispatch([FAMILY_BREAKER_LABEL], 'verifier'), false);
  assert.equal(shouldSkipDispatch(['wip:verifier'], 'verifier'), true);
  assert.equal(shouldSkipDispatch(['error:verifier'], 'verifier'), true);
});

test('old family-only recovery observations are inert while genuine stage errors still request assessment', () => {
  const observation = { ticket: 'org/core#3163', status: 'In Code Review', labels: [FAMILY_BREAKER_LABEL], blocked: false, familyHold: 'org/core#2962' };
  assert.equal(recoveryTrigger(observation), null);
  assert.equal(recoveryTrigger({ ...observation, labels: ['error:verifier'] })?.manual, false);
  assert.equal(recoveryTrigger({ ...observation, labels: ['needs-human:decision'] })?.manual, true);
  assert.equal(recoveryFingerprint(observation), recoveryFingerprint({ ...observation, labels: [], familyHold: undefined }));
});


test('unreadable family history preserves dispatch and falls back to the visible count once per root', async () => {
  let reads = 0;
  const c = { ...client(), getFamilyDispatchState: async () => { reads++; throw new Error('unavailable'); } };
  const candidates = [{ agent: verifier, item: child }, { agent: verifier, item: { ...child, issueNumber: 3164 } }];
  const result = await readFamilyDispatchTallies(candidates, c as any, { rootLabelsByIssue: new Map([[2962, ['family-dispatches:1000']]]) });
  assert.deepEqual(result.kept, candidates); assert.equal(result.tallies.get(2962), 1000);
  assert.equal(reads, 1); assert.deepEqual(c.writes, []);
});

test('a previously escalated family budget is retired and genuine review rework gets a normal assessment', () => {
  const db = new DatabaseSync(':memory:'); const ledger = new RecoveryLedger(db, () => 1000);
  db.prepare('INSERT INTO fleet_recovery VALUES (?,?,?,?,?,?,?,?,?,1)').run('old', 'org/core#3163', 'legacy-budget', 'Family dispatch budget reached on org/core#2962; deliberate operator budget decision required', 'escalated', 1, 1, null, null);
  const observation = { ticket: 'org/core#3163', status: 'In Code Review', labels: ['done:builder', 'rework-count:2'], blocked: false, familyHold: 'org/core#2962' };
  const [next] = ledger.report('box', 'org/core', [observation], { claims: [], runs: [] });
  assert.equal(next.state, 'queued'); assert.equal(next.reason, 'Repeated review rework');
  assert.equal(ledger.list('org/core').find(i => i.id === 'old')?.current, false);
  db.close();
});
