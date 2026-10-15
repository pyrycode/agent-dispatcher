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
  // Module paths are fixed at first import, so these share this repository.
  await legacyWorktreeCases(t, root, repo, store);
});


// Desktop #1979, #1978 and Mobile #2052: trees retained by runs on code from
// before PR 260 have no custody record. A safe one is removed and dispatch
// starts fresh; anything that could lose work is refused, untouched.
async function legacyWorktreeCases(t: import('node:test').TestContext, root: string, repo: string, store: FleetStore) {
  const gitAt = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const git = (...args: string[]) => gitAt(repo, ...args);
  const { DEFAULT_DEPS, setupBranchAndWorktree, makeDispatchContext, worktreePath, managedWorktreeRecordPath } = await import('./dispatch.js');
  let ticket = 2050;
  const fixture = async (opts: { push?: boolean; commit?: boolean; role?: string } = {}) => {
    for (const run of store.snapshot().runs) store.finish(run.machine, run.session, run.id, false);
    const number = ++ticket;
    const request = (role: string, tag = '') => ({ id: `${number}-${role}${tag}`, session: `${number}-${role}${tag}-session`, machine: 'local',
      project: 'org/desktop', ticket: `org/desktop#${number}`, role, resource: 'medium' as const, locks: [] });
    const start = (role: string, tag = ''): FleetRun => {
      const req = request(role, tag); assert.equal(store.start(req).ok, true);
      return store.snapshot().runs.find(run => run.id === req.id)!;
    };
    // The predecessor ran on older code: a plain worktree and no record.
    const prior = start(opts.role ?? 'verifier', '-prior');
    const path = worktreePath(repo, `${opts.role ?? 'verifier'}-${number}`);
    git('branch', `feature/${number}`, 'main');
    mkdirSync(resolve(path, '..'), { recursive: true });
    git('worktree', 'add', path, `feature/${number}`);
    if (opts.commit !== false) {
      writeFileSync(join(path, 'source.ts'), `export const ticket = ${number};\n`);
      gitAt(path, 'commit', '-am', 'prior work');
    }
    if (opts.push !== false) gitAt(path, 'push', '-u', 'origin', `feature/${number}`);
    store.finish('local', prior.session, prior.id, false);
    assert.equal(existsSync(managedWorktreeRecordPath(path)), false);
    const comments: string[] = [], labels: string[] = [], commands: string[] = [];
    const client = { addComment: async (_n: number, body: string) => { comments.push(body); },
      addLabel: async (_n: number, label: string) => { labels.push(label); } } as unknown as DispatchClient;
    const item = { issueNumber: number, labels: ['needs-rework:builder', 'rework-count:1'], title: 'legacy tree', id: `item-${number}` } as ProjectItem;
    const builder = () => {
      const run = start('builder');
      const deps: DispatchDeps = { ...DEFAULT_DEPS,
        managedWorktree: { run, snapshot: async () => ({ ...store.snapshot(), openTaskTickets: store.openTaskTickets() }),
          predecessor: async id => store.worktreePredecessor(run.machine, run.session, run.id, id) },
        execSync: ((cmd: string, o: any) => { commands.push(cmd); return execSync(cmd, o); }) as typeof execSync };
      return makeDispatchContext({ name: 'builder', usesWorktree: true, column: 'In Development', claudeMdPath: 'builder/CLAUDE.md' } as AgentConfig, item, client, deps);
    };
    return { number, path, builder, comments, labels, commands };
  };
  const accepted = async (f: Awaited<ReturnType<typeof fixture>>, force: boolean) => {
    const ctx = f.builder();
    const head = git('rev-parse', `feature/${f.number}`);
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: true });
    assert.equal(ctx.worktreeDir, worktreePath(repo, `builder-${f.number}`));
    if (f.path !== ctx.worktreeDir) assert.equal(existsSync(f.path), false, 'the legacy tree is gone');
    assert.deepEqual(gitAt(ctx.worktreeDir, 'status', '--porcelain', '--untracked-files=all'), '', 'the new tree is fresh');
    assert.equal(gitAt(ctx.worktreeDir, 'symbolic-ref', 'HEAD'), `refs/heads/feature/${f.number}`);
    assert.equal(git('rev-parse', `feature/${f.number}`), head, 'no history was rewritten');
    assert.equal(JSON.parse(readFileSync(managedWorktreeRecordPath(ctx.worktreeDir), 'utf8')).run.id, ctx.deps.managedWorktree!.run.id);
    if (f.path !== ctx.worktreeDir) assert.equal(existsSync(managedWorktreeRecordPath(f.path)), false, 'no record is written for the removed tree');
    assert.ok(f.commands.includes(`git worktree remove ${force ? '--force ' : ''}"${f.path}"`), f.commands.join('\n'));
    assert.ok(!f.commands.some(cmd => /worktree prune/.test(cmd)), 'other worktrees are never pruned');
    assert.equal(f.comments.length, 1);
    assert.match(f.comments[0]!, /Removed legacy worktree without custody record/);
    assert.deepEqual(f.labels, []);
  };
  await t.test('a clean pushed tree is removed and dispatch starts fresh', async () => {
    const f = await fixture();
    // Ignored files never block, as with the old cleanup.
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'ignored-scratch\n');
    writeFileSync(join(f.path, 'ignored-scratch'), 'x');
    await accepted(f, false);
    assert.match(f.comments[0]!, /git status showed it clean/);
    assert.match(f.comments[0]!, /Ignored files went with it.*`ignored-scratch`/);
  });
  await t.test('a tree whose only changes are runtime files is removed (#1936 shape)', async () => {
    const f = await fixture();
    rmSync(join(f.path, '.codegraph', 'codegraph.db-wal'));
    writeFileSync(join(f.path, '.codegraph', 'codegraph.db-shm'), 'untracked runtime\n');
    await accepted(f, true);
    assert.match(f.comments[0]!, /only CodeGraph files \(.*codegraph\.db-wal/);
  });
  await t.test("a legacy tree at this run's own path is removed and recreated there", async () => {
    const f = await fixture({ role: 'builder' });
    await accepted(f, false);
  });
  await t.test('a tree left by a role the current stage set no longer runs is recognised', async () => {
    const f = await fixture({ role: 'developer' });
    await accepted(f, false);
  });
  await t.test('a tree with no remote branch and nothing beyond main is removed', async () => {
    const f = await fixture({ push: false, commit: false });
    await accepted(f, false);
  });
  const refusals: Array<[string, RegExp]> = [
    ['untracked evidence', /uncommitted changes \(FAIL-evidence\.txt\)/],
    ['modified source', /uncommitted changes \(source\.ts\)/],
    ['staged runtime untracking', /uncommitted changes \(\.codegraph\/codegraph\.db-wal\)/],
    ['runtime-shaped file outside CodeGraph', /uncommitted changes \(notes\.pid\)/],
    ['skip-worktree edit', /hidden from git status by assume-unchanged or skip-worktree \(source\.ts\)/],
    ['process still using it', /process\(es\) 4242 still use it/],
    ['own path already exists', /own path .*builder-\d+ already exists/],
    ['files change during the checks', /its files changed while it was being checked/],
    ['support task opened during the checks', /a support task is open for the ticket/],
    ...['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'BISECT_START', 'index.lock'].map(name => [name, /unfinished/] as [string, RegExp]),
    ['unpushed commits', /1 commit\(s\) are not on origin\/feature\//],
    ['no remote branch with work', /1 commit\(s\) are not on origin\/main/],
    ['live run', /another live run on the ticket/],
    ['open support task', /a support task is open for the ticket/],
    ['older authority', /does not report open support tasks/],
    ['ownership changed', /no claim for this run's ownership generation/],
    ['unreadable authority', /authority could not be read/],
    ['locked', /it is locked/],
    ['personal path', /not a dispatcher worktree path/],
    ['shared CodeGraph symlink', /shared CodeGraph symlink/],
  ];
  for (const [condition, expected] of refusals) {
    await t.test(`refuses ${condition} and leaves the tree untouched`, async () => {
      const f = await fixture(condition === 'no remote branch with work' ? { push: false } : {});
      let path = f.path;
      if (condition === 'untracked evidence') writeFileSync(join(path, 'FAIL-evidence.txt'), 'gate FAIL\n');
      if (condition === 'modified source') writeFileSync(join(path, 'source.ts'), 'export const unsaved = true;\n');
      if (condition === 'staged runtime untracking') gitAt(path, 'rm', '--cached', '.codegraph/codegraph.db-wal');
      if (condition === 'runtime-shaped file outside CodeGraph') writeFileSync(join(path, 'notes.pid'), 'real notes\n');
      if (condition === 'skip-worktree edit') { gitAt(path, 'update-index', '--skip-worktree', 'source.ts'); writeFileSync(join(path, 'source.ts'), 'export const hidden = true;\n'); }
      if (condition === 'own path already exists') mkdirSync(worktreePath(repo, `builder-${f.number}`), { recursive: true });
      if (condition === 'unpushed commits') { writeFileSync(join(path, 'more.ts'), 'x\n'); gitAt(path, 'add', 'more.ts'); gitAt(path, 'commit', '-m', 'local only'); }
      if (condition === 'locked') git('worktree', 'lock', path);
      if (condition === 'personal path') { const other = join(root, `personal-${f.number}`); git('worktree', 'move', path, other); path = other; }
      if (condition === 'shared CodeGraph symlink') { rmSync(join(path, '.codegraph'), { recursive: true }); symlinkSync(join(repo, '.codegraph'), join(path, '.codegraph')); }
      let operationPath: string | undefined;
      if (IN_PROGRESS_GIT_PATHS.includes(condition as any)) {
        operationPath = resolve(path, gitAt(path, 'rev-parse', '--git-path', condition));
        if (condition.startsWith('rebase-')) mkdirSync(operationPath); else writeFileSync(operationPath, 'unfinished operation\n');
      }
      const ctx = f.builder();
      const run = ctx.deps.managedWorktree!.run;
      const authority = async () => ({ ...store.snapshot(), openTaskTickets: store.openTaskTickets() });
      if (condition === 'live run') ctx.deps.managedWorktree!.snapshot = async () => { const s = await authority(); return { ...s, runs: [...s.runs, { ...run, id: 'still-running', role: 'verifier' }] }; };
      if (condition === 'open support task') ctx.deps.managedWorktree!.snapshot = async () => ({ ...(await authority()), openTaskTickets: [run.ticket] });
      if (condition === 'older authority') ctx.deps.managedWorktree!.snapshot = async () => store.snapshot();
      if (condition === 'ownership changed') ctx.deps.managedWorktree!.snapshot = async () => { const s = await authority(); return { ...s, claims: s.claims.map(c => ({ ...c, generation: 'new-owner' })) }; };
      if (condition === 'unreadable authority') ctx.deps.managedWorktree!.snapshot = async () => { throw new Error('unreachable'); };
      if (condition === 'support task opened during the checks') {
        let reads = 0;
        ctx.deps.managedWorktree!.snapshot = async () => ({ ...(await authority()), openTaskTickets: reads++ === 0 ? [] : [run.ticket] });
      }
      ctx.deps.processesUsingPath = () => condition === 'process still using it' ? [4242] : [];
      if (condition === 'files change during the checks') ctx.deps.processesUsingPath = () => { writeFileSync(join(path, 'late.ts'), 'late\n'); return []; };
      const head = git('rev-parse', `feature/${f.number}`);
      const status = gitAt(path, 'status', '--porcelain', '--untracked-files=all');
      f.commands.length = 0;
      assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: false });
      assert.equal(f.comments.length, 1);
      assert.match(f.comments[0]!, /Managed worktree handoff refused: .*Legacy worktree without custody record/);
      assert.match(f.comments[0]!, expected);
      assert.deepEqual(f.labels, ['error:builder']);
      assert.equal(existsSync(path), true);
      if (condition !== 'files change during the checks') assert.equal(gitAt(path, 'status', '--porcelain', '--untracked-files=all'), status);
      assert.equal(git('rev-parse', `feature/${f.number}`), head);
      if (condition !== 'own path already exists') assert.equal(existsSync(worktreePath(repo, `builder-${f.number}`)), false);
      assert.equal(existsSync(managedWorktreeRecordPath(path)), false, 'a record is never written for a refused tree');
      assert.ok(!f.commands.some(cmd => /worktree (add|remove|move|prune)|git add|git push|branch -f/.test(cmd)), f.commands.join('\n'));
      if (operationPath) rmSync(operationPath, { recursive: true });
      if (condition === 'locked') git('worktree', 'unlock', path);
      if (condition === 'skip-worktree edit') gitAt(path, 'update-index', '--no-skip-worktree', 'source.ts');
    });
  }
  await t.test('a removal that does not complete says so instead of claiming the tree was kept', async () => {
    const f = await fixture();
    const ctx = f.builder();
    const execute = ctx.deps.execSync;
    ctx.deps.execSync = ((cmd: string, o: any) => {
      if (cmd.startsWith('git worktree remove')) throw new Error('simulated timeout');
      return execute(cmd, o);
    }) as typeof execSync;
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: false });
    assert.match(f.comments[0]!, /started and did not complete: simulated timeout/);
    assert.doesNotMatch(f.comments[0]!, /left in place/);
    assert.deepEqual(f.labels, ['error:builder']);
  });
  await t.test('a dangling custody symlink is evidence, not absence', async () => {
    const f = await fixture();
    const record = managedWorktreeRecordPath(f.path);
    mkdirSync(resolve(record, '..'), { recursive: true });
    symlinkSync(join(root, 'missing-target.json'), record);
    const ctx = f.builder();
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: false });
    assert.match(f.comments[0]!, /Custody record is not a regular file/);
    assert.equal(existsSync(f.path), true);
    assert.equal(existsSync(join(root, 'missing-target.json')), false, 'nothing was written through the link');
    assert.ok(!f.commands.some(cmd => /worktree (add|remove)/.test(cmd)));
  });
  await t.test('a fresh tree never writes its custody record through a link', async () => {
    const f = await fixture();
    const fresh = worktreePath(repo, `builder-${f.number}`);
    const target = join(root, `planted-${f.number}.json`);
    mkdirSync(resolve(managedWorktreeRecordPath(fresh), '..'), { recursive: true });
    symlinkSync(target, managedWorktreeRecordPath(fresh));
    const ctx = f.builder();
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: false });
    assert.equal(existsSync(target), false, 'nothing was written through the link');
    assert.match(f.comments.at(-1)!, /Could not record managed worktree custody: .*not a regular file/);
  });
  await t.test('an unreadable custody record location refuses', async () => {
    const f = await fixture();
    const ctx = f.builder();
    ctx.deps.lstatSync = (() => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); }) as any;
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: false });
    assert.match(f.comments[0]!, /EACCES/);
    assert.equal(existsSync(f.path), true);
  });
}
