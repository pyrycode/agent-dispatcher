import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReconcileClient } from './reconcile.js';
import type { ProjectItem } from './types.js';

// Import actual startup configuration with a stale live command still set.
// Each test file has its own process; other consumers keep their defaults.
process.env.PYRY_REAL_CLAUDE_GATE_ENABLED = '0';
process.env.PYRY_REAL_CLAUDE_GATE_CMD = 'exit 97';
const { makeRealClaudeGateRunner } = await import('./dispatch.js');
const { runAutoAdvance, runRealClaudeGate, runRealClaudeGateExecution } = await import('./reconcile.js');
const { decideAutoAdvance, realClaudeGateEnabled } = await import('./pipeline-decisions.js');

const { resetActiveStageSetForTests } = await import('./stage-sets.js');

const item = { id: 'reviewed', issueNumber: 2026, status: 'In Code Review', labels: ['done:code-review', 'needs-real-claude'], blockedBy: [] } as unknown as ProjectItem;
const rule = { from: 'In Code Review', to: 'In Documentation', readyLabel: 'done:code-review' };

test('retired gate cannot create a live runner even with a stale configured command', () => {
  assert.equal(makeRealClaudeGateRunner(), null);
  assert.equal(realClaudeGateEnabled({}), true);
  assert.equal(realClaudeGateEnabled({ PYRY_REAL_CLAUDE_GATE_ENABLED: '0' }), false);
  assert.equal(realClaudeGateEnabled({ PYRY_REAL_CLAUDE_GATE_ENABLED: 'false' }), true);
});

test('retired gate never reads or parks board tickets', async () => {
  let reads = 0;
  const client = new Proxy({}, { get() { reads++; throw new Error('retired gate touched board'); } }) as ReconcileClient;
  await runRealClaudeGate(client);
  assert.equal(reads, 0);
});

test('retired gate cannot execute a supplied runner or read the board', async () => {
  let reads = 0;
  const client = new Proxy({}, { get() { reads++; throw new Error('retired gate touched board'); } }) as ReconcileClient;
  assert.equal(await runRealClaudeGateExecution(client, async () => { throw new Error('live runner invoked'); }, 1, async () => {}), false);
  assert.equal(reads, 0);
});

test('normal advancement ignores the retired label while keeping other safety checks', async () => {
  for (const stage of ['classic', 'builder']) {
    process.env.PYRY_STAGE_SET = stage;
    resetActiveStageSetForTests();
    const ready = stage === 'builder' ? 'done:verifier' : 'done:code-review';
    const reviewed = { ...item, labels: [ready, 'needs-real-claude'] };
    const held = [
      { ...item, id: 'running', issueNumber: 2, labels: [...reviewed.labels, 'wip:real-claude-gate'] },
      { ...item, id: 'failed', issueNumber: 3, labels: [...reviewed.labels, 'error:builder'] },
      { ...item, id: 'blocked', issueNumber: 4, blockedBy: [{ number: 9, state: 'OPEN' as const }] },
      { ...item, id: 'unfinished', issueNumber: 5, labels: ['needs-real-claude'] },
    ];
    const items = [reviewed, ...held];
    const moved: string[] = [];
    const client = {
      getItemsByStatus: async (status: string) => items.filter(i => i.status === status),
      updateItemStatus: async (id: string) => { moved.push(id); },
      clearItemsCache() {},
    } as unknown as ReconcileClient;
    await runAutoAdvance(client, 1, 0);
    assert.deepEqual(moved, ['reviewed']);
    // Unconfigured consumers still enforce the live gate by default.
    assert.equal(decideAutoAdvance([{ ...rule, readyLabel: ready }], new Set(), new Map([[rule.from, [reviewed]]]), 0, 1).advances.length, 0);
  }
});
