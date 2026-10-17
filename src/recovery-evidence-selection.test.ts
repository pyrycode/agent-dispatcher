import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactManifest, manifestHash, sha256 } from './recovery-artifacts.js';
import { evidenceExcerpts, type EvidenceConnection } from './run-evidence.js';

const ticket = 'org/core#12';
function retained(runId: string, role: string, files: Record<string, string>, created: number) {
  const manifest = artifactManifest(files);
  return { ticket, runId, role, machine: 'box', meta: { kind: 'agent' as const, role, outcome: 'failed', startedAt: created, endedAt: created + 1 },
    created, committed: created + 2, digest: manifestHash(manifest), totalBytes: manifest.totalBytes, manifest, content: files };
}
function connection(bundles: ReturnType<typeof retained>[], unreadable = new Set<string>()) {
  const reads: string[] = [];
  const client: EvidenceConnection = { call: async <T>(path: string, body?: unknown): Promise<T> => {
    if (path === '/evidence/list') return { bundles } as T;
    const request = body as { runId: string; path: string; part: number; digest: string };
    reads.push(request.runId);
    if (unreadable.has(request.runId)) throw new Error('Evidence unavailable');
    const bundle = bundles.find(b => b.runId === request.runId)!;
    const data = Buffer.from(bundle.content[request.path]);
    return { digest: request.digest, path: request.path, part: request.part, sha256: sha256(data), data: data.toString('base64') } as T;
  } };
  return { client, reads };
}

test('recovery sees substantive builder, verifier and recovery findings behind newer metadata-only runs', async () => {
  const metadata = Array.from({ length: 8 }, (_, n) => retained('metadata-' + n, 'recovery', { 'run.json': '{}', 'pointers.json': '[]' }, 30 - n));
  const builder = retained('builder', 'builder', { 'logs/builder.log': 'builder repair '.repeat(20) }, 3);
  const verifier = retained('verifier', 'verifier', { 'handoff/verifier.md': 'verifier unresolved '.repeat(20) }, 2);
  const recovery = retained('recovery', 'recovery', { 'logs/recovery.log': 'recovery diagnosis '.repeat(20) }, 1);
  const { client, reads } = connection([...metadata, builder, verifier, recovery]);
  const result = await evidenceExcerpts(client, ticket, { bundles: 3, characters: 90, perFile: 80 });
  assert.ok(result);
  assert.deepEqual(result.bundles.map(b => b.role).sort(), ['builder', 'recovery', 'verifier']);
  assert.deepEqual(result.missingRoles, []);
  assert.equal(reads.length, 3);
  assert.ok(result.bundles.every(b => b.digest === [builder, verifier, recovery].find(original => original.runId === b.runId)!.digest));
  assert.ok(result.bundles.every(b => b.inspectedPaths.length > 0 && Object.values(b.excerpts).some(v => v.length > 0)));
  assert.ok(result.bundles.reduce((n, b) => n + Object.values(b.excerpts).reduce((m, v) => m + v.length, 0), 0) <= 90);
});

test('metadata and unreadable files do not claim that a required evidence role was inspected', async () => {
  const builder = retained('builder', 'builder', { 'logs/builder.log': 'retained repair' }, 3);
  const verifier = retained('verifier', 'verifier', { 'handoff/verifier.md': 'retained finding' }, 2);
  const recovery = retained('recovery', 'recovery', { 'run.json': '{}', 'pointers.json': '[{"reason":"omitted"}]' }, 1);
  const { client } = connection([builder, verifier, recovery], new Set(['verifier']));
  const result = await evidenceExcerpts(client, ticket);
  assert.ok(result);
  assert.deepEqual(result.missingRoles.sort(), ['recovery', 'verifier']);
  assert.deepEqual(result.bundles.find(b => b.runId === 'verifier')?.inspectedPaths, []);
  assert.match(result.bundles.find(b => b.runId === 'recovery')?.excerpts['pointers.json'] ?? '', /omitted/);
});

test('a corrupt manifest digest or another ticket cannot supply recovery inspection evidence', async () => {
  const corrupt = retained('corrupt', 'builder', { 'logs/builder.log': 'repair' }, 3);
  corrupt.digest = '0'.repeat(64);
  const foreign = retained('foreign', 'verifier', { 'handoff/verifier.md': 'finding' }, 2);
  foreign.ticket = 'org/core#13';
  const { client, reads } = connection([corrupt, foreign]);
  const result = await evidenceExcerpts(client, ticket);
  assert.ok(result);
  assert.deepEqual(result.bundles, []);
  assert.deepEqual(result.missingRoles.sort(), ['builder', 'recovery', 'verifier']);
  assert.deepEqual(reads, []);
});
