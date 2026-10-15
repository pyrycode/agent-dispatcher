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

import { execFileSync, execSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
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
  const { DEFAULT_DEPS, setupBranchAndWorktree, makeDispatchContext, worktreePath, managedWorktreeRecordPath, processesUsingPath } = await import('./dispatch.js');
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
  const accepted = async (f: Awaited<ReturnType<typeof fixture>>, force: boolean, ctx = f.builder()) => {
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
  await t.test('macOS mixed native descriptor types permit both retained-tree inspections', async () => {
    const f = await fixture();
    const ctx = f.builder();
    const claims = store.snapshot().claims;
    let inspections = 0;
    ctx.deps.processesUsingPath = path => processesUsingPath(path, { platform: 'darwin', spawnSync: (() => {
      inspections++;
      return lsofResult({ stdout: MACOS_MIXED_LSOF });
    }) as unknown as typeof spawnSync });
    await accepted(f, false, ctx);
    assert.equal(inspections, 2);
    assert.deepEqual(store.snapshot().claims, claims);
  });
  await t.test('a tree whose only changes are runtime files is removed (#1936 shape)', async () => {
    const f = await fixture();
    rmSync(join(f.path, '.codegraph', 'codegraph.db-wal'));
    writeFileSync(join(f.path, '.codegraph', 'codegraph.db-shm'), 'untracked runtime\n');
    await accepted(f, true);
    assert.match(f.comments[0]!, /only CodeGraph files \(.*codegraph\.db-wal/);
  });
  await t.test('an old shared CodeGraph link is removed as a link and the canonical index survives', async () => {
    const f = await fixture();
    rmSync(join(f.path, '.codegraph'), { recursive: true });
    symlinkSync(join(repo, '.codegraph'), join(f.path, '.codegraph'));
    await accepted(f, true);
    assert.equal(readFileSync(join(repo, '.codegraph', 'codegraph.db-wal'), 'utf8'), 'historically tracked runtime\n');
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
    ['foreign CodeGraph symlink', /CodeGraph symlink that does not point at this repository's index/],
    ['submodules', /it has submodules/],
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
      if (condition === 'foreign CodeGraph symlink') { mkdirSync(join(root, `elsewhere-${f.number}`)); rmSync(join(path, '.codegraph'), { recursive: true }); symlinkSync(join(root, `elsewhere-${f.number}`), join(path, '.codegraph')); }
      if (condition === 'submodules') writeFileSync(join(path, '.gitmodules'), '[submodule "x"]\n\tpath = x\n');
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
  for (const condition of ['active process', 'unnamed filesystem descriptor', 'unresolved vnode', 'unsupported valid type', 'launch failure', 'timeout', 'buffer overflow', 'signal', 'nonzero exit', 'incomplete output']) {
    for (const failingInspection of [1, 2]) await t.test(`macOS inspection ${failingInspection} refuses a retained tree on ${condition}`, async () => {
      const f = await fixture();
      const ctx = f.builder();
      const head = git('rev-parse', `feature/${f.number}`);
      const status = gitAt(f.path, 'status', '--porcelain', '--untracked-files=all');
      const claims = store.snapshot().claims;
      // Ignored evidence does not itself block removal: process inspection must.
      writeFileSync(join(f.path, 'ignored-evidence'), 'retained inspection evidence\n');
      writeFileSync(join(repo, '.git', 'info', 'exclude'), 'ignored-evidence\n');
      let inspections = 0;
      ctx.deps.processesUsingPath = path => processesUsingPath(path, { platform: 'darwin', spawnSync: (() => {
        inspections++;
        if (inspections !== failingInspection) return lsofResult();
        let stdout = MACOS_MIXED_LSOF + (condition === 'active process' ? `f33\ntREG\nn${path}/source.ts\n` : '');
        if (condition === 'launch failure') return lsofResult({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), status: null, stdout: '' });
        if (condition === 'timeout' || condition === 'buffer overflow') return lsofResult({ error: Object.assign(new Error(condition), { code: condition === 'timeout' ? 'ETIMEDOUT' : 'ENOBUFS' }), status: null, stdout });
        if (condition === 'signal') return lsofResult({ signal: 'SIGTERM', status: null, stdout });
        if (condition === 'incomplete output') stdout = stdout.slice(0, -1);
        if (condition === 'unnamed filesystem descriptor') stdout += 'f33\ntREG\nn\n';
        if (condition === 'unresolved vnode') stdout += MACOS_UNRESOLVED_VNODE;
        if (condition === 'unsupported valid type') stdout += 'f31\ntFSEVENTS\nn\n';
        return lsofResult({ stdout, status: condition === 'nonzero exit' ? 1 : 0 });
      }) as unknown as typeof spawnSync });
      f.commands.length = 0;
      assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: false });
      assert.equal(inspections, failingInspection);
      assert.match(f.comments[0]!, condition === 'active process' ? /process\(es\) 4242 still use it/ : /processes using it could not be checked.*lsof failed/);
      if (condition === 'unresolved vnode') assert.match(f.comments[0]!, /unresolved filesystem\/vnode inspection.*fd="32" type=<absent> name=unavailable/);
      if (condition === 'unsupported valid type') assert.match(f.comments[0]!, /unsupported unnamed type.*type="FSEVENTS"/);
      assert.deepEqual(f.labels, ['error:builder']);
      assert.deepEqual(store.snapshot().claims, claims);
      assert.deepEqual(ctx.item.labels, ['needs-rework:builder', 'rework-count:1']);
      assert.equal(git('rev-parse', `feature/${f.number}`), head);
      assert.equal(gitAt(f.path, 'status', '--porcelain', '--untracked-files=all'), status);
      assert.equal(readFileSync(join(f.path, 'ignored-evidence'), 'utf8'), 'retained inspection evidence\n');
      assert.equal(existsSync(managedWorktreeRecordPath(f.path)), false, 'no custody is invented for a refused tree');
      assert.equal(existsSync(ctx.worktreeDir), false);
      assert.ok(!f.commands.some(cmd => /worktree (add|remove|move|prune)|git add|git push|branch -f/.test(cmd)), f.commands.join('\n'));
    });
  }
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

// Representative mixed -Fpfnt stream, not a claim of a complete native capture.
// #3404 supplied f6/NPOLICY, f7/NEXUS, f8/rte with present, empty names, and
// f32 with absent type and "no more information"; the recovery brief reports
// that native enumeration identified it as VNODE. No path probe is replayed.
// Keep those boundaries and field-presence distinctions. Other records combine
// the existing supported dialect with redacted paths and synthetic PID 4242.
const MACOS_MIXED_LSOF = `p4242
fcwd
tDIR
n/elsewhere
ftxt
tREG
n/elsewhere/program
f0
tCHR
n/dev/null
f6
tNPOLICY
n
f7
tNEXUS
n
f8
trte
n
f9
tKQUEUE
n
f10
tPIPE
n
f11
tIPv4
n127.0.0.1:1234
f12
tIPv6
n
f13
tsystm
n
f14
tunix
n/elsewhere/socket
`;
const MACOS_UNRESOLVED_VNODE = 'f32\nnno more information\n';

function lsofResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return { pid: 42, status: 0, signal: null, stdout: MACOS_MIXED_LSOF, stderr: '', output: [], ...overrides };
}

test('macOS processesUsingPath accepts unnamed non-filesystem records and checks later paths', async () => {
  const { processesUsingPath } = await import('./dispatch.js');
  for (const [stdout, pids] of [
    [MACOS_MIXED_LSOF, []],
    [MACOS_MIXED_LSOF + 'f33\ntREG\nn/retained-tree/source.ts\n', [4242]],
    [MACOS_MIXED_LSOF + 'p4243\nf33\ntREG\nn/retained-tree/source.ts\n', [4243]],
    ['p4242\nf6\ntNPOLICY\nn\n', []],
    ['p4242\nf6\nn\ntNPOLICY\n', []],
    ...['KQUEUE', 'PIPE', 'IPv4', 'IPv6', 'systm', 'NEXUS', 'rte'].map(type => [`p4242\nf6\nt${type}\nn\n`, []] as const),
  ] as const) {
    assert.deepEqual(processesUsingPath('/retained-tree', { platform: 'darwin', spawnSync: (() => lsofResult({ stdout })) as unknown as typeof spawnSync }), pids);
  }
});

test('macOS processesUsingPath inventories the whole dialect while refusing unresolved vnode evidence', async () => {
  const { processesUsingPath } = await import('./dispatch.js');
  // An unsupported but valid lsof type must not hide a later unresolved vnode,
  // another process, or the later matching file. No name/path is logged.
  const stdout = MACOS_MIXED_LSOF + 'f31\ntFSEVENTS\nn\n' + MACOS_UNRESOLVED_VNODE + 'f34\ntREG\nf35\nn\n' +
    'p4243\nf33\ntREG\nn/retained-tree/private-source.ts\n';
  assert.throws(() => processesUsingPath('/retained-tree', { platform: 'darwin', spawnSync: (() => lsofResult({ stdout })) as unknown as typeof spawnSync }), (error: Error) => {
    assert.match(error.message, /unsupported unnamed type.*pid=4242 fd="31" type="FSEVENTS" name=empty/);
    assert.match(error.message, /unresolved filesystem\/vnode inspection.*pid=4242 fd="32" type=<absent> name=unavailable/);
    assert.match(error.message, /inventory: processes=2 files=17/);
    for (const entry of ['"NEXUS"/empty=1', '"rte"/empty=1', '<absent>/unavailable=1', '"REG"/present=2', '"REG"/absent=1', '<absent>/empty=1']) {
      assert.ok(error.message.includes(entry), error.message);
    }
    assert.doesNotMatch(error.message, /elsewhere|private-source|\/retained-tree/);
    return true;
  });
});

test('macOS inspection diagnostics bound samples and inventory without hiding later vnode uncertainty', async () => {
  const { processesUsingPath } = await import('./dispatch.js');
  const padding = '\t'.repeat(10_000);
  const stdout = 'p4242\n' + Array.from({ length: 100 }, (_, index) =>
    `f${index}${padding}\ntFUTURE_${index}${padding}\nn\n`).join('') + MACOS_UNRESOLVED_VNODE;
  assert.throws(() => processesUsingPath('/retained-tree', { platform: 'darwin', spawnSync: (() => lsofResult({ stdout })) as unknown as typeof spawnSync }), (error: Error) => {
    assert.match(error.message, /unsupported unnamed type: 100 record\(s\)/);
    assert.match(error.message, /further records omitted/);
    assert.match(error.message, /unresolved filesystem\/vnode inspection: 1 record\(s\).*fd="32"/);
    assert.match(error.message, /inventory: processes=1 files=101/);
    assert.match(error.message, /85 other record\(s\)/);
    assert.ok(error.message.length < 8192, `diagnostic length ${error.message.length}`);
    assert.doesNotMatch(error.message, /[\t\n\r]/);
    return true;
  });
});

test('macOS processesUsingPath discovers system lsof with /usr/sbin absent from PATH', async t => {
  const { processesUsingPath } = await import('./dispatch.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'macos-processes-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = join(root, 'tree');
  const linked = join(root, 'link');
  const restrictedPath = join(root, 'empty-bin');
  mkdirSync(tree); mkdirSync(restrictedPath); symlinkSync(tree, linked);
  const stdout = MACOS_MIXED_LSOF + `p0\nfcwd\ntDIR\nn/elsewhere\np1000001\nfcwd\ntDIR\nn${tree}\nf3\ntREG\nn${tree}/nested/file\np1000002\nfcwd\ntDIR\nn${tree}-sibling/file\np1000003\nf4\ntREG\nn${linked}/file\np1000004\nf5\ntREG\nn${tree}/removed (deleted)\n`;
  const installedLsof = join(root, 'installed-lsof');
  writeFileSync(installedLsof, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)});\n`, { mode: 0o700 });
  const commands: string[] = [];
  // Only the installed system location is mapped to the fixture on Linux.
  // A bare lsof must still go through real executable discovery and fail.
  const run = ((file: string, args: string[], options: any) => {
    commands.push(file);
    assert.deepEqual(args, ['-b', '-w', '-n', '-P', '-Fpfnt']);
    return spawnSync(file === '/usr/sbin/lsof' ? installedLsof : file, args, options);
  }) as typeof spawnSync;
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = restrictedPath;
    assert.deepEqual(processesUsingPath(tree, { platform: 'darwin', spawnSync: run }), [1000001, 1000004]);
    assert.deepEqual(processesUsingPath(linked, { platform: 'darwin', spawnSync: run }), [1000001, 1000003, 1000004]);
    assert.deepEqual(commands, ['/usr/sbin/lsof', '/usr/sbin/lsof']);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  }
});

test('macOS processesUsingPath refuses failed or incomplete lsof inspection', async () => {
  const { processesUsingPath } = await import('./dispatch.js');
  for (const [name, result] of [
    ['launch failure', lsofResult({ status: null, stdout: '', error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })],
    ['timeout with partial output', lsofResult({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) })],
    ['buffer overflow', lsofResult({ status: null, error: Object.assign(new Error('ENOBUFS'), { code: 'ENOBUFS' }) })],
    ['nonzero exit with output', lsofResult({ status: 1 })],
    ['signal with output', lsofResult({ status: null, signal: 'SIGTERM' })],
    ['empty output', lsofResult({ stdout: '' })],
    ['truncated output', lsofResult({ stdout: 'p4242\nn/elsewhere' })],
    ['missing file records', lsofResult({ stdout: 'p4242\n' })],
    ['missing process record', lsofResult({ stdout: 'n/elsewhere\n' })],
    ['invalid process record', lsofResult({ stdout: 'pNaN\nn/elsewhere\n' })],
    ...[
      ['unnamed regular file', MACOS_MIXED_LSOF + 'f33\ntREG\nn\n'],
      ['unnamed directory', MACOS_MIXED_LSOF + 'f33\ntDIR\nn\n'],
      ['unnamed FIFO', MACOS_MIXED_LSOF + 'f33\ntFIFO\nn\n'],
      ['unnamed unknown type', MACOS_MIXED_LSOF + 'f33\ntUNKNOWN\nn\n'],
      ['unnamed unix socket', MACOS_MIXED_LSOF + 'f33\ntunix\nn\n'],
      ['unnamed missing type', MACOS_MIXED_LSOF + 'f33\nn\n'],
      ['named file missing type', MACOS_MIXED_LSOF + 'f33\nn/elsewhere\n'],
      ['unresolved native vnode', MACOS_MIXED_LSOF + MACOS_UNRESOLVED_VNODE],
      ['unresolved vnode after matching path', MACOS_MIXED_LSOF + 'f33\ntREG\nn/retained-tree/source.ts\n' + MACOS_UNRESOLVED_VNODE],
      ['unresolved vnode before matching path', MACOS_MIXED_LSOF + MACOS_UNRESOLVED_VNODE + 'f33\ntREG\nn/retained-tree/source.ts\n'],
      ['typed unresolved vnode', MACOS_MIXED_LSOF + 'f32\ntREG\nnno more information\n'],
      ['unavailable kernel object name', MACOS_MIXED_LSOF + 'f32\ntNEXUS\nnno more information\n'],
      ['type from preceding descriptor', 'p4242\nf6\ntNPOLICY\nn\nf7\nn\n'],
      ['NEXUS type from preceding descriptor', 'p4242\nf7\ntNEXUS\nn\nf32\nnno more information\n'],
      ['rte type from preceding descriptor', 'p4242\nf8\ntrte\nn\nf32\nn\n'],
      ['name from preceding descriptor', MACOS_MIXED_LSOF + 'f33\ntNEXUS\n'],
      ['incomplete trailing file', MACOS_MIXED_LSOF + 'f33\n'],
      ['incomplete file before process', MACOS_MIXED_LSOF + 'f33\ntREG\np4243\nfcwd\ntDIR\nn/elsewhere\n'],
      ['missing name on non-filesystem object', 'p4242\nf6\ntNPOLICY\n'],
      ['missing name on NEXUS', 'p4242\nf7\ntNEXUS\n'],
      ['missing name on rte', 'p4242\nf8\ntrte\n'],
      ['missing descriptor', 'p4242\ntNPOLICY\nn\n'],
      ['empty descriptor', 'p4242\nf\ntNPOLICY\nn\n'],
      ['duplicate type', 'p4242\nf6\ntNPOLICY\ntREG\nn\n'],
      ['duplicate name', MACOS_MIXED_LSOF + 'n/elsewhere\n'],
      ['unexpected field', MACOS_MIXED_LSOF + 'xunexpected\n'],
      ['empty internal line', MACOS_MIXED_LSOF + '\n'],
      ['incomplete process after a match', 'p4242\nf7\ntREG\nn/retained-tree/source.ts\np4243\n'],
    ].map(([name, stdout]) => [name, lsofResult({ stdout })] as const),
  ] as const) {
    assert.throws(() => processesUsingPath('/retained-tree', { platform: 'darwin', spawnSync: (() => result) as unknown as typeof spawnSync }), /lsof failed/, name);
  }
});

test('processesUsingPath finds a process working inside a tree, also through a linked path', async t => {
  const { processesUsingPath } = await import('./dispatch.js');
  const { spawn } = await import('node:child_process');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'processes-using-')));
  const tree = join(root, 'tree');
  mkdirSync(join(tree, 'nested'), { recursive: true });
  symlinkSync(tree, join(root, 'link'));
  const child = spawn('sleep', ['30'], { cwd: join(tree, 'nested'), stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => child.once('spawn', resolve));
  assert.ok(processesUsingPath(tree).includes(child.pid!));
  assert.ok(processesUsingPath(join(root, 'link')).includes(child.pid!));
  assert.ok(!processesUsingPath(join(root, 'tree-sibling')).includes(child.pid!));
});
