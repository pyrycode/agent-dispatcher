import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FleetStore } from './fleet-store.js';
import type { WorkflowItem } from './workflow-store.js';

const project = 'org/core', ticket = project + '#1';
const limits = { linux: { heavyLimit: 1, combinedLimit: 2 } };
const config = { project, projectId: 'P', statusFieldId: 'S', options: { Inbox: 'i', 'In Development': 'd', Done: 'done' } };
const item: WorkflowItem = { id: 'P1', issueId: 'I1', issueNumber: 1, title: 'Indexed history', body: '', url: 'https://github.com/org/core/issues/1', status: 'In Development', state: 'OPEN', revision: 1, position: 1, labels: [], blockedBy: [], parentNumber: null, grandparentNumber: null };
const queries = [
 { table: 'workflow_commands', sql: 'SELECT id,request,result FROM workflow_commands WHERE ticket=?', args: [ticket] },
 { table: 'fleet_runs', sql: 'SELECT id FROM fleet_runs WHERE ticket=?', args: [ticket] },
 { table: 'fleet_runs', sql: "SELECT id,outcome FROM fleet_runs WHERE ticket=? AND machine=? AND generation=? AND json_extract(request,'$.role')='builder' ORDER BY created DESC,rowid DESC LIMIT 1", args: [ticket, 'linux', 'generation'] },
];
const plans = (db: DatabaseSync) => queries.map(q => ({ table: q.table, details: db.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.args).map(r => String(r.detail)).join('\n') }));
const digest = (db: DatabaseSync) => createHash('sha256').update(JSON.stringify([
 db.prepare('SELECT * FROM fleet_runs ORDER BY id').all(), db.prepare('SELECT * FROM workflow_commands ORDER BY id').all(),
])).digest('hex');

test('populated legacy database gains indexed ticket history without changing data or command replay', t => {
 const dir = mkdtempSync(join(tmpdir(), 'ticket-index-')), path = join(dir, 'claims.sqlite');
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 let store = new FleetStore(path, limits);
 store.workflow.import(config, [item]);
 const saved = store.workflowOperator(ticket, { addLabels: ['priority:high'] }, 'saved-command', 1);
 store.close();
 let db = new DatabaseSync(path);
 // Model an already populated database from before this migration.
 db.exec('DROP INDEX IF EXISTS fleet_runs_ticket; DROP INDEX IF EXISTS workflow_commands_ticket; BEGIN');
 const run = db.prepare('INSERT INTO fleet_runs VALUES (?,?,?,?,?,?,?,?,?,?)');
 const command = db.prepare('INSERT INTO workflow_commands VALUES (?,?,?,?)');
 for (let i = 0; i < 2000; i++) {
  const id = 'finished-' + i, key = project + '#' + (i + 1);
  run.run(id, 'linux', 'session', key, 'generation', 'light', JSON.stringify({ role: 'builder' }), i, i + 1, 'completed');
  command.run('historic-' + i, key, JSON.stringify({ historic: i }), JSON.stringify({ preserved: i }));
 }
 run.run('unfinished', 'linux', 'session', project + '#3000', 'current', 'light', '{}', 3000, null, null);
 db.exec('COMMIT');
 const before = digest(db), prior = plans(db);
 for (const p of prior) assert.match(p.details, new RegExp('SCAN ' + p.table), 'legacy historical lookup scans the table');
 db.close();
 store = new FleetStore(path, limits);
 try {
  db = new DatabaseSync(path);
  assert.equal(digest(db), before, 'migration preserves all historical and current rows byte for byte');
  const migrated = plans(db);
  t.diagnostic(JSON.stringify({ legacy: prior, migrated }));
  for (const p of migrated) {
   assert.match(p.details, new RegExp('SEARCH ' + p.table + ' USING'), p.details);
   assert.doesNotMatch(p.details, new RegExp('SCAN ' + p.table), p.details);
  }
  assert.deepEqual({...db.prepare(queries[2].sql).get(...queries[2].args)}, { id: 'finished-0', outcome: 'completed' });
  assert.deepEqual(store.workflowOperator(ticket, { addLabels: ['priority:high'] }, 'saved-command', 1), saved);
  assert.throws(() => db.prepare('INSERT INTO fleet_runs VALUES (?,?,?,?,?,?,?,?,?,?)').run('duplicate', 'linux', 'other', project + '#3000', 'other', 'light', '{}', 4000, null, null), /UNIQUE/);
  assert.equal(digest(db), before, 'command replay and rejected admission cannot alter retained history');
  db.close();
 } finally { store.close(); }
 store = new FleetStore(path, limits);
 try {
  db = new DatabaseSync(path);
  assert.equal(digest(db), before, 'reopening the migrated database is idempotent');
  for (const p of plans(db)) assert.doesNotMatch(p.details, new RegExp('SCAN ' + p.table));
  db.close();
 } finally { store.close(); }
});
