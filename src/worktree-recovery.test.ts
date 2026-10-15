import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOwnWorktreeReuse, shouldAutoCommit } from './worktree.js';

test('a confirmed same-ticket predecessor can hand its runtime-dirty worktree to another role', () => {
  assert.deepEqual(decideOwnWorktreeReuse({
    ownPath: '/managed/builder-1936', held: [{path: '/managed/verifier-1936', error: 'runtime dirt'}],
    branchAction: 'reuse-local-already-synced', locked: false, operationInProgress: false,
    gitStatusOutput: ' M .codegraph/codegraph.db-wal\n', managedHandoff: true,
  }), {reuse: true, commitLeftovers: false});
});

// Desktop #1936: CodeGraph writers leave runtime files after verifier FAIL.
test('runtime-only dirt is never an automatic commit, even when already tracked', () => {
  for (const status of ['?? .codegraph/\n', ' M .codegraph/codegraph.db-wal\n',
    ' M cache.sqlite-shm\n', 'A  worker.pid\n', '?? cache.db-journal\n']) {
    assert.equal(shouldAutoCommit(status), false, status);
  }
  assert.equal(shouldAutoCommit(' M src/app.ts\n?? .codegraph/\n'), true);
  assert.equal(shouldAutoCommit('D  .codegraph/codegraph.db-wal\n?? .codegraph/codegraph.db-wal\n'), true,
    'explicitly staged untracking remains committable');
});

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FleetStore, type FleetRun, type FleetSnapshot } from './fleet-store.js';
import { managedPredecessorFinished, IN_PROGRESS_GIT_PATHS } from './worktree.js';
import type { DispatchDeps, DispatchClient } from './dispatch.js';
import type { AgentConfig, ProjectItem } from './types.js';

test('only an admitted successor in the same ownership generation confirms shutdown', () => {
  const prior: FleetRun = { id: 'prior', session: 's1', generation: 'g1', machine: 'local', project: 'org/desktop',
    ticket: 'org/desktop#1936', role: 'verifier', created: 1, resource: 'medium', locks: [] };
  const current = { ...prior, id: 'next', session: 's2', role: 'builder', created: 2 };
  const state: FleetSnapshot = { runs: [current], claims: [{ ticket: prior.ticket, machine: 'local', generation: 'g1', created: 1 }] };
  assert.equal(managedPredecessorFinished(prior, current, state, prior), true);
  assert.equal(managedPredecessorFinished(prior, current, state, null), false);
  assert.equal(managedPredecessorFinished(prior, current, state, { ...prior, id: 'unknown' }), false);
  for (const snapshot of [
    { ...state, runs: [] }, { ...state, runs: [prior] }, { ...state, runs: [prior, current] },
    { ...state, claims: [] }, { ...state, claims: [{ ...state.claims[0]!, generation: 'new-owner' }] },
    { ...state, runs: [{ ...current, session: 'unknown' }] },
  ]) assert.equal(managedPredecessorFinished(prior, current, snapshot, prior), false);
  assert.equal(managedPredecessorFinished({ ...prior, ticket: 'org/desktop#9999' }, current, state, prior), false);
  assert.equal(managedPredecessorFinished({ ...prior, generation: 'old-owner' }, current, state, prior), false);
});

// Real Git repos and a real authority ledger; no network, pipeline writes,
// branch rewriting, or deletion of a retained worktree during recovery.
test('managed verifier FAIL hands its entire retained tree to builder safely', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'managed-handoff-')));
  const repo = join(root, 'repo');
  const agents = join(root, 'agents');
  mkdirSync(repo); mkdirSync(agents);
  const oldEnv = { target: process.env.TARGET_REPO_PATH, agents: process.env.AGENTS_REPO_PATH, stage: process.env.PYRY_STAGE_SET };
  process.env.TARGET_REPO_PATH = repo;
  process.env.AGENTS_REPO_PATH = agents;
  process.env.PYRY_STAGE_SET = 'builder';
  const store = new FleetStore(':memory:', { local: { heavyLimit: 2, combinedLimit: 2 } });
  t.after(() => {
    store.close();
    for (const [key, value] of Object.entries({ TARGET_REPO_PATH: oldEnv.target, AGENTS_REPO_PATH: oldEnv.agents, PYRY_STAGE_SET: oldEnv.stage })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // This test owns the complete disposable repository, trees and files.
    rmSync(root, { recursive: true, force: true });
  });
  const gitAt = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const git = (...args: string[]) => gitAt(repo, ...args);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Recovery Test'); git('config', 'user.email', 'recovery@example.invalid');
  writeFileSync(join(repo, 'source.ts'), 'export const original = true;\n');
  mkdirSync(join(repo, '.codegraph'));
  writeFileSync(join(repo, '.codegraph', 'codegraph.db-wal'), 'historically tracked runtime\n');
  git('branch', '--show-current'); git('add', '.'); git('commit', '-m', 'seed');
  git('init', '--bare', join(root, 'origin.git'));
  git('remote', 'add', 'origin', join(root, 'origin.git')); git('push', '-u', 'origin', 'main');
  const { DEFAULT_DEPS, setupBranchAndWorktree, makeDispatchContext, worktreePath, stageAutomaticChanges, managedWorktreeRecordPath } = await import('./dispatch.js');
  let ticket = 1935;
  const fixture = async () => {
    for (const run of store.snapshot().runs) store.finish(run.machine, run.session, run.id, false);
    const number = ++ticket;
    const request = (role: string) => ({ id: `${number}-${role}`, session: `${number}-${role}-session`, machine: 'local',
      project: 'org/desktop', ticket: `org/desktop#${number}`, role, resource: 'medium' as const, locks: [] });
    const start = (role: string): FleetRun => {
      const req = request(role); assert.equal(store.start(req).ok, true);
      return store.snapshot().runs.find(run => run.id === req.id)!;
    };
    const prior = start('verifier');
    const comments: string[] = [], labels: string[] = [], commands: string[] = [];
    const client = { addComment: async (_n: number, body: string) => { comments.push(body); },
      addLabel: async (_n: number, label: string) => { labels.push(label); } } as unknown as DispatchClient;
    const deps = (run: FleetRun): DispatchDeps => ({ ...DEFAULT_DEPS, managedWorktree: { run, snapshot: async () => store.snapshot(), predecessor: async id => store.worktreePredecessor(run.machine, run.session, run.id, id) },
      execSync: ((cmd: string, opts: any) => { commands.push(cmd); return execSync(cmd, opts); }) as typeof execSync });
    const item = { issueNumber: number, labels: ['needs-rework:builder', 'rework-count:2'], title: 'recover FAIL', id: `item-${number}` } as ProjectItem;
    const agent = (name: string) => ({ name, usesWorktree: true, column: 'In Development', claudeMdPath: `${name}/CLAUDE.md` }) as AgentConfig;
    const verifier = makeDispatchContext(agent('verifier'), item, client, deps(prior));
    assert.deepEqual(await setupBranchAndWorktree(verifier), { ok: true });
    const path = verifier.worktreeDir;
    gitAt(path, 'push', '-u', 'origin', `feature/${number}`);
    writeFileSync(join(path, '.codegraph', 'codegraph.db-wal'), 'retained WAL bytes\n');
    writeFileSync(join(path, '.codegraph', 'codegraph.db-shm'), 'retained SHM bytes\n');
    writeFileSync(join(path, 'worker.pid'), '999999\n');
    mkdirSync(join(path, 'runtime', 'nested'), { recursive: true });
    writeFileSync(join(path, 'runtime', 'nested', 'only.pid'), 'nested runtime\n');
    writeFileSync(join(path, 'runtime', 'line\nbreak.pid'), 'runtime name with newline\n');
    writeFileSync(join(path, 'FAIL-evidence.txt'), 'Application gate FAIL; never accepted\n');
    const finish = () => store.finish('local', prior.session, prior.id, false);
    const builder = () => {
      const run = start('builder');
      return makeDispatchContext(agent('builder'), item, client, deps(run));
    };
    commands.length = 0; comments.length = 0;
    return { number, prior, path, finish, builder, comments, labels, commands, item };
  };
  await t.test('runtime-only dirt resumes without commit and keeps bytes and evidence', async () => {
    const f = await fixture();
    // Keep the FAIL evidence ignored so this case has only runtime dirt.
    writeFileSync(join(f.path, '.gitignore'), 'FAIL-evidence.txt\n');
    gitAt(f.path, 'add', '.gitignore'); gitAt(f.path, 'commit', '-m', 'ignore gate capture'); gitAt(f.path, 'push');
    gitAt(f.path, 'add', '.codegraph', 'worker.pid', 'runtime');
    writeFileSync(join(f.path, '.codegraph', 'intent.pid'), 'retained intent-to-add runtime\n');
    gitAt(f.path, 'add', '-N', '.codegraph/intent.pid');
    writeFileSync(join(f.path, '.codegraph', 'codegraph.db.copying'), 'retained index-copy evidence\n');
    f.finish();
    const before = store.snapshot().claims;
    const recordPath = managedWorktreeRecordPath(f.path);
    const priorRecord = readFileSync(recordPath, 'utf8');
    const priorArchive = recordPath + '.' + createHash('sha256').update(f.prior.id).digest('hex');
    const ctx = f.builder();
    ctx.failedPreSpawnGate = 'application gate FAIL';
    let indexCopies = 0;
    ctx.deps.copyCodegraphIndex = () => { indexCopies++; };
    const fileExists = ctx.deps.existsSync;
    ctx.deps.existsSync = path => String(path) === join(repo, '.codegraph', 'codegraph.db') || fileExists(path);
    const head = gitAt(f.path, 'rev-parse', 'HEAD');
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: true });
    assert.equal(ctx.worktreeDir, f.path); assert.equal(ctx.agentCwd, f.path);
    assert.equal(readFileSync(priorArchive, 'utf8'), priorRecord, 'predecessor custody evidence remains byte-for-byte');
    assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).run.id, ctx.deps.managedWorktree!.run.id);
    assert.equal(ctx.failedPreSpawnGate, 'application gate FAIL');
    assert.equal(indexCopies, 0);
    assert.equal(readFileSync(join(f.path, '.codegraph', 'codegraph.db.copying'), 'utf8'), 'retained index-copy evidence\n');
    assert.equal(existsSync(worktreePath(repo, `builder-${f.number}`)), false);
    assert.equal(gitAt(f.path, 'diff', '--cached', '--name-only'), '');
    assert.equal(gitAt(f.path, 'rev-parse', 'HEAD'), head, 'runtime-only dirt makes no empty commit');
    assert.equal(readFileSync(join(f.path, '.codegraph', 'codegraph.db-wal'), 'utf8'), 'retained WAL bytes\n');
    assert.equal(readFileSync(join(f.path, '.codegraph', 'codegraph.db-shm'), 'utf8'), 'retained SHM bytes\n');
    assert.equal(readFileSync(join(f.path, 'worker.pid'), 'utf8'), '999999\n');
    assert.equal(readFileSync(join(f.path, '.codegraph', 'intent.pid'), 'utf8'), 'retained intent-to-add runtime\n');
    assert.match(readFileSync(join(f.path, 'FAIL-evidence.txt'), 'utf8'), /gate FAIL/);
    assert.deepEqual(store.snapshot().claims, before);
    assert.deepEqual(f.item.labels, ['needs-rework:builder', 'rework-count:2']);
    assert.deepEqual(f.labels, []);
    assert.ok(!f.commands.some(cmd => /worktree (add|remove|move)|branch -f|reset|git add|git push/.test(cmd)));
  });
  await t.test('source edits are preserved and committed without tracked or staged runtime refreshes', async () => {
    const f = await fixture();
    writeFileSync(join(f.path, 'source.ts'), 'export const repaired = true;\n');
    gitAt(f.path, 'add', '.codegraph', 'worker.pid'); // Even explicitly staged runtime must not leak.
    f.finish(); const ctx = f.builder();
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: true });
    assert.equal(gitAt(f.path, 'show', 'HEAD:source.ts'), 'export const repaired = true;');
    assert.equal(gitAt(f.path, 'show', 'HEAD:.codegraph/codegraph.db-wal'), 'historically tracked runtime');
    assert.throws(() => gitAt(f.path, 'show', 'HEAD:worker.pid'));
    assert.throws(() => gitAt(f.path, 'show', 'HEAD:runtime/nested/only.pid'));
    assert.throws(() => gitAt(f.path, 'show', 'HEAD:runtime/line\nbreak.pid'));
    assert.throws(() => gitAt(f.path, 'show', 'HEAD:.codegraph/codegraph.db-shm'));
    assert.equal(readFileSync(join(f.path, 'worker.pid'), 'utf8'), '999999\n');
    assert.match(gitAt(f.path, 'log', '-1', '--format=%s'), /partial work/);
  });
  await t.test('intentional untracking stays staged and preserves the local sidecar', async () => {
    const f = await fixture();
    gitAt(f.path, 'rm', '--cached', '.codegraph/codegraph.db-wal');
    stageAutomaticChanges(f.path, DEFAULT_DEPS);
    assert.match(gitAt(f.path, 'diff', '--cached', '--name-status'), /D\s+\.codegraph\/codegraph.db-wal/);
    gitAt(f.path, 'commit', '-m', 'remove runtime from repository');
    assert.throws(() => gitAt(f.path, 'show', 'HEAD:.codegraph/codegraph.db-wal'));
    assert.equal(readFileSync(join(f.path, '.codegraph', 'codegraph.db-wal'), 'utf8'), 'retained WAL bytes\n');
    f.finish();
  });
  for (const condition of ['unknown worker', 'invented worker', 'active worker', 'lost authority', 'unreadable status', 'unreadable operation state', 'unreadable branch lock', 'incomplete operation paths', 'ambiguous holders', 'ownership changed', 'locked', ...IN_PROGRESS_GIT_PATHS, 'branch lock', 'diverged', 'behind origin', 'personal path', 'aliased path', 'wrong repository', 'recorded branch mismatch', 'shared CodeGraph symlink']) {
    await t.test(`refuses ${condition} without changing retained files or Git history`, async () => {
      const f = await fixture();
      const recordPath = managedWorktreeRecordPath(f.path);
      if (condition === 'unknown worker') writeFileSync(recordPath, '{}');
      if (condition === 'invented worker') {
        const record = JSON.parse(readFileSync(recordPath, 'utf8'));
        record.run.id = 'never-admitted';
        writeFileSync(recordPath, JSON.stringify(record));
      }
      if (condition === 'locked') git('worktree', 'lock', f.path);
      if (condition === 'shared CodeGraph symlink') {
        renameSync(join(f.path, '.codegraph'), join(f.path, 'retained-codegraph'));
        symlinkSync(join(repo, '.codegraph'), join(f.path, '.codegraph'));
      }
      if (condition === 'personal path' || condition === 'aliased path') {
        const record = JSON.parse(readFileSync(recordPath, 'utf8'));
        const other = join(root, `personal-${f.number}`);
        if (condition === 'personal path') {
          git('worktree', 'move', f.path, other);
          record.path = other;
          writeFileSync(managedWorktreeRecordPath(other), JSON.stringify(record));
        } else {
          renameSync(f.path, other);
          symlinkSync(other, f.path);
        }
      }
      if (condition === 'wrong repository' || condition === 'recorded branch mismatch') {
        const record = JSON.parse(readFileSync(recordPath, 'utf8'));
        if (condition === 'wrong repository') record.commonGitDir = join(root, 'origin.git');
        else record.branch = 'feature/99999';
        writeFileSync(recordPath, JSON.stringify(record));
      }
      let operationPath: string | undefined;
      if (IN_PROGRESS_GIT_PATHS.includes(condition as any) || condition === 'branch lock') {
        const name = condition === 'branch lock' ? `refs/heads/feature/${f.number}.lock` : condition;
        const path = resolve(f.path, gitAt(f.path, 'rev-parse', '--git-path', name));
        operationPath = path;
        if (['sequencer', 'rebase-merge', 'rebase-apply'].includes(name)) mkdirSync(path);
        else writeFileSync(path, 'unfinished operation\n');
      }
      if (condition === 'diverged' || condition === 'behind origin') {
        const remoteTree = join(root, `remote-${f.number}`);
        git('worktree', 'add', '--detach', remoteTree, `origin/feature/${f.number}`);
        writeFileSync(join(remoteTree, 'remote.txt'), 'remote work\n');
        gitAt(remoteTree, 'add', 'remote.txt'); gitAt(remoteTree, 'commit', '-m', 'remote work');
        gitAt(remoteTree, 'push', 'origin', `HEAD:refs/heads/feature/${f.number}`);
        if (condition === 'diverged') {
          writeFileSync(join(f.path, 'local.txt'), 'local work\n');
          gitAt(f.path, 'add', 'local.txt'); gitAt(f.path, 'commit', '-m', 'local work');
        }
      }
      const beforeHead = git('rev-parse', `feature/${f.number}`);
      if (condition !== 'active worker') f.finish();
      const ctx = condition === 'active worker'
        ? makeDispatchContext({ name: 'builder', usesWorktree: true } as AgentConfig, f.item, { addComment: async () => {}, addLabel: async () => {} } as unknown as DispatchClient,
          { ...DEFAULT_DEPS, managedWorktree: { run: { ...f.prior, id: 'unadmitted-builder', role: 'builder' }, snapshot: async () => store.snapshot(), predecessor: async () => null } })
        : f.builder();
      if (condition === 'lost authority') ctx.deps.managedWorktree!.snapshot = async () => { throw new Error('unreachable'); };
      if (condition === 'ownership changed') ctx.deps.managedWorktree!.snapshot = async () => ({ ...store.snapshot(), claims: store.snapshot().claims.map(claim => ({ ...claim, generation: 'new-owner' })) });
      const execute = ctx.deps.execSync;
      ctx.deps.execSync = ((command: string, options: any) => {
        if ((condition === 'unreadable status' && command.includes('git status')) ||
            (condition === 'unreadable operation state' && command.includes('--git-path MERGE_HEAD')) ||
            (condition === 'unreadable branch lock' && command.includes(`--git-path refs/heads/feature/${f.number}.lock`))) throw new Error('unreadable Git state');
        if (condition === 'incomplete operation paths' && command.includes('--git-path MERGE_HEAD')) return '';
        const result = execute(command, options);
        if (condition === 'ambiguous holders' && command === 'git worktree list --porcelain') return String(result) +
          `\nworktree ${f.path}-duplicate\nHEAD duplicate\nbranch refs/heads/feature/${f.number}\n\n`;
        return result;
      }) as typeof execSync;
      f.commands.length = 0;
      assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: false });
      assert.equal(git('rev-parse', `feature/${f.number}`), beforeHead);
      assert.ok(!f.commands.some(cmd => /worktree (add|remove|move)|git add|git push|branch -f/.test(cmd)));
      const path = condition === 'personal path' ? join(root, `personal-${f.number}`) : f.path;
      const codegraph = condition === 'shared CodeGraph symlink' ? 'retained-codegraph' : '.codegraph';
      assert.equal(readFileSync(join(path, codegraph, 'codegraph.db-wal'), 'utf8'), 'retained WAL bytes\n');
      assert.match(readFileSync(join(path, 'FAIL-evidence.txt'), 'utf8'), /gate FAIL/);
      if (operationPath) rmSync(operationPath, { recursive: true });
      if (condition === 'active worker') f.finish();
    });
  }
});
