import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactManifest } from './recovery-artifacts.js';
import { DEFAULT_EVIDENCE_LIMITS, EvidenceStore, type RunOwner } from './evidence-store.js';

const day = 86400000;
function fixture(path = ':memory:') {
  let now = 100 * day;
  const owners = new Map<string, RunOwner>();
  const limits = { ...DEFAULT_EVIDENCE_LIMITS, bundleBytes: 4096, ticketBytes: 8192, totalBytes: 16384 };
  const open = () => new EvidenceStore(path, limits, id => owners.get(id), () => now);
  let store = open();
  const stage = (ticket: string, runId: string, bytes = 3000) => {
    owners.set(runId, { machine: 'box', ticket, role: 'verifier' });
    const content = 'failed retained finding '.repeat(bytes).slice(0, bytes);
    const begun = store.begin('box', undefined, ticket, runId,
      { kind: 'agent', role: 'verifier', outcome: 'failed', startedAt: now - 1, endedAt: now },
      artifactManifest({ 'handoff/verifier.md': content }));
    store.put('box', undefined, ticket, runId, begun.digest, 'handoff/verifier.md', 0, Buffer.from(content).toString('base64'));
    return { digest: begun.digest, commit: () => {
      store.commit('box', undefined, ticket, runId, begun.digest);
      now++;
      return begun.digest;
    } };
  };
  const upload = (ticket: string, runId: string, bytes = 3000) => stage(ticket, runId, bytes).commit();
  return { get store() { return store; }, upload, stage, advance: (ms: number) => { now += ms; },
    reopen: () => { store.close(); store = open(); } };
}

test('recovery pins survive restart and preserve failed bytes after replacement closure or missing workflow', t => {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-evidence-pins-'));
  const f = fixture(join(directory, 'evidence.sqlite'));
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const digest = f.upload('org/core#12', 'failed-verifier');
  f.store.sweep(() => true);
  f.store.pinTicket('org/core#12', 'recovery-split:incident');
  f.store.pinTicket('org/core#12', 'recovery-split:incident');
  f.reopen();
  f.advance(100 * day);
  assert.equal(f.store.sweep(() => true).deleted, 0);
  assert.equal(f.store.sweep(() => undefined).deleted, 0);
  const bundle = f.store.list('org/core#12')[0];
  assert.equal(bundle.digest, digest);
  assert.equal(f.store.read('org/core#12', 'failed-verifier', digest, 'handoff/verifier.md', 0).sha256,
    bundle.manifest.files[0].chunks[0]);
});

test('interleaved uploads reserve space and exact retries do not reserve it twice', t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.upload('org/core#12', 'failed-first');
  f.upload('org/core#12', 'failed-second');
  f.store.pinTicket('org/core#12', 'recovery-split:incident');
  const pending = f.stage('org/core#12', 'pending-first', 2000);
  assert.equal(f.stage('org/core#12', 'pending-first', 2000).digest, pending.digest);
  assert.throws(() => f.stage('org/core#12', 'pending-second', 2000), /protected evidence.*ticket cap/i);
  pending.commit();
  const other = f.stage('org/core#13', 'other-first', 4000);
  const second = f.stage('org/core#14', 'other-second', 4000);
  assert.throws(() => f.stage('org/core#15', 'other-third', 1000), /protected evidence.*total cap/i);
  other.commit();
  second.commit();
  assert.equal(f.store.usage().usedBytes, 16000);
  assert.equal(f.store.usage().pendingBundles, 0);
});

test('store pressure evicts ordinary evidence while all committed split-parent evidence is retained', t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.upload('org/core#12', 'failed-builder');
  f.upload('org/core#12', 'failed-verifier');
  f.store.pinTicket('org/core#12', 'recovery-split:incident');
  f.store.sweep(() => true);
  f.upload('org/core#13', 'ordinary-1', 4000);
  f.upload('org/core#14', 'ordinary-2', 4000);
  f.upload('org/core#15', 'ordinary-3', 4000);
  assert.deepEqual(f.store.list('org/core#12').map(b => b.runId).sort(), ['failed-builder', 'failed-verifier']);
  assert.equal(f.store.list('org/core#13').length, 0);
  assert.ok(f.store.usage().usedBytes <= f.store.limits.totalBytes);
  assert.throws(() => f.upload('org/core#12', 'another-attempt'), /protected evidence.*ticket cap/i);
  assert.equal(f.store.list('org/core#12').length, 2);
});

test('uploads that cannot fit beside protected evidence stay refused without deleting retained bundles', t => {
  const f = fixture();
  t.after(() => f.store.close());
  for (const ticket of ['org/core#12', 'org/core#13']) {
    f.upload(ticket, ticket.replace(/\W/g, '-') + '-first', 4000);
    f.upload(ticket, ticket.replace(/\W/g, '-') + '-second', 4000);
    f.store.pinTicket(ticket, 'recovery-split:incident');
  }
  assert.throws(() => f.upload('org/core#14', 'new-attempt', 1000), /protected evidence.*total cap/i);
  assert.equal(f.store.list('org/core#12').length, 2);
  assert.equal(f.store.list('org/core#13').length, 2);
  assert.equal(f.store.usage().usedBytes, 16000);
  assert.equal(f.store.usage().pendingBundles, 0);
});

test('a recovery pin added during an upload is rechecked before that upload can commit', t => {
  const f = fixture();
  t.after(() => f.store.close());
  for (const [ticket, bytes] of [['org/core#12', 4000], ['org/core#13', 4000], ['org/core#14', 4000], ['org/core#15', 2000]] as const)
    f.upload(ticket, ticket.replace(/\W/g, '-'), bytes);
  const pending = f.stage('org/core#16', 'pending-during-split', 4000);
  for (const ticket of ['org/core#12', 'org/core#13', 'org/core#14', 'org/core#15'])
    f.store.pinTicket(ticket, 'recovery-split:incident');
  assert.throws(() => pending.commit(), /protected evidence.*total cap/i);
  assert.equal(f.store.list('org/core#16').length, 0);
  for (const ticket of ['org/core#12', 'org/core#13', 'org/core#14', 'org/core#15'])
    assert.equal(f.store.list(ticket).length, 1);
});
