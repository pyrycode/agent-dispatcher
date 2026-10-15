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

import { execFileSync, execSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync, renameSync, readdirSync, lstatSync, readlinkSync, openSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FleetStore, type FleetRun, type FleetSnapshot } from './fleet-store.js';
import { managedPredecessorFinished, IN_PROGRESS_GIT_PATHS } from './worktree.js';
import type { DispatchDeps, DispatchClient } from './dispatch.js';
import type { AgentConfig, ProjectItem } from './types.js';
import { withManagedTaskRun, trackManagedChild } from './managed-dispatch.js';

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
  const fixture = async (legacy = false) => {
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
    if (legacy) {
      // Pre-deployment launch: deliberately do NOT call the repaired setup,
      // create a custody record, or delete one made by the repaired setup.
      git('branch', `feature/${number}`, 'main');
      mkdirSync(join(verifier.worktreeDir, '..'), { recursive: true });
      git('worktree', 'add', verifier.worktreeDir, `feature/${number}`);
      assert.equal(existsSync(managedWorktreeRecordPath(verifier.worktreeDir)), false);
    } else assert.deepEqual(await setupBranchAndWorktree(verifier), { ok: true });
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
  const ref = (path: string) => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
  const treeBytes = (path: string): unknown => Object.fromEntries(readdirSync(path).sort().map(name => {
    const file = join(path, name), stat = lstatSync(file);
    return [name, stat.isSymbolicLink() ? { link: readlinkSync(file) } : stat.isDirectory() ? treeBytes(file) : readFileSync(file).toString('base64')];
  }));
  const legacyFixture = async () => {
    const f = await fixture(true);
    writeFileSync(join(f.path, '.gitignore'), 'FAIL-evidence.txt\n');
    gitAt(f.path, 'add', '.gitignore'); gitAt(f.path, 'commit', '-m', 'retain ignored gate evidence'); gitAt(f.path, 'push');
    const source = join(root, `legacy-launch-${f.number}.json`), completion = join(root, `legacy-completion-${f.number}.json`);
    const record = { repository: repo, commonGitDir: realpathSync(join(repo, '.git')), path: f.path,
      branch: `feature/${f.number}`, run: f.prior };
    const launched = Date.now();
    writeFileSync(source, JSON.stringify({ version: 1, kind: 'managed-worktree-launch', record, launched }));
    // Positive child exit and the managed child guard establish this fixture's
    // completion independently of the custody migration and authority lookup.
    await withManagedTaskRun(f.prior, async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30)'], { cwd: f.path, detached: true, stdio: 'ignore' });
      assert.ok(child.pid); trackManagedChild(child.pid);
      assert.deepEqual(await once(child, 'exit'), [0, null]);
    });
    writeFileSync(completion, JSON.stringify({ version: 1, kind: 'managed-child-completion', run: f.prior,
      finished: Date.now(), trackedChildren: 'finished' }));
    f.finish();
    const ctx = f.builder();
    ctx.failedPreSpawnGate = 'application gate FAIL';
    const manifest = join(root, `legacy-migration-${f.number}.json`);
    const pin = () => {
      const { machine, project, ticket, generation, role } = ctx.deps.managedWorktree!.run;
      writeFileSync(manifest, JSON.stringify({ version: 1, successor: { machine, project, ticket, generation, role }, expires: Date.now() + 3_600_000,
        launch: ref(source), childCompletion: ref(completion) }));
      ctx.deps.managedWorktree!.migration = ref(manifest);
    };
    return { f, ctx, source, completion, manifest, pin };
  };
  await t.test('pre-deployment verifier recovery requires independently retained launch and child-completion proof', async () => {
    const { f, ctx, source, completion, manifest, pin } = await legacyFixture();
    gitAt(f.path, 'add', '.codegraph', 'worker.pid', 'runtime');
    const before = store.snapshot();
    const head = gitAt(f.path, 'rev-parse', 'HEAD');
    const status = gitAt(f.path, 'status', '--porcelain=v1', '-z');
    const bytes = treeBytes(f.path);
    // A role-shaped directory and normal authority completion alone are insufficient.
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: false });
    assert.equal(gitAt(f.path, 'status', '--porcelain=v1', '-z'), status);
    // The operator pins an exact import, rather than the worker trusting any
    // file it happens to find next to the retained tree.
    pin();
    f.commands.length = 0; f.labels.length = 0;
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: true });
    assert.equal(ctx.worktreeDir, f.path);
    assert.equal(ctx.failedPreSpawnGate, 'application gate FAIL');
    assert.equal(gitAt(f.path, 'rev-parse', 'HEAD'), head);
    assert.equal(gitAt(f.path, 'diff', '--cached', '--name-only'), '', 'staged runtime refreshes remain excluded');
    assert.deepEqual(treeBytes(f.path), bytes, 'all retained tree bytes survive migration');
    assert.equal(readFileSync(join(f.path, '.codegraph', 'codegraph.db-wal'), 'utf8'), 'retained WAL bytes\n');
    assert.equal(readFileSync(join(f.path, 'worker.pid'), 'utf8'), '999999\n');
    assert.match(readFileSync(join(f.path, 'FAIL-evidence.txt'), 'utf8'), /gate FAIL/);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(f.item.labels, ['needs-rework:builder', 'rework-count:2']);
    assert.deepEqual(f.labels, []);
    assert.ok(!f.commands.some(cmd => /worktree (add|remove|move)|branch -f|reset|git push/.test(cmd)));
    const archive = JSON.parse(readFileSync(managedWorktreeRecordPath(f.path) + '.' + createHash('sha256').update(f.prior.id).digest('hex'), 'utf8'));
    assert.deepEqual(archive.run, f.prior);
    const evidence = JSON.parse(readFileSync(archive.migration.archive, 'utf8'));
    for (const [key, path] of Object.entries({ manifest, launch: source, childCompletion: completion })) {
      assert.deepEqual(Buffer.from(evidence[key], 'base64'), readFileSync(path));
    }
    assert.equal(lstatSync(archive.migration.archive).mode & 0o777, 0o600);
  });
  await t.test('legacy migration preserves source edits and intentional untracking while excluding runtime refreshes', async () => {
    const { f, ctx, pin } = await legacyFixture();
    writeFileSync(join(f.path, 'source.ts'), 'export const repaired = true;\n');
    gitAt(f.path, 'add', '.codegraph', 'worker.pid', 'runtime');
    gitAt(f.path, 'rm', '--cached', '.codegraph/codegraph.db-wal');
    const bytes = treeBytes(f.path), before = store.snapshot();
    pin();
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: true });
    assert.deepEqual(treeBytes(f.path), bytes);
    assert.equal(gitAt(f.path, 'show', 'HEAD:source.ts'), 'export const repaired = true;');
    for (const path of ['.codegraph/codegraph.db-wal', '.codegraph/codegraph.db-shm', 'worker.pid', 'runtime/nested/only.pid']) {
      assert.throws(() => gitAt(f.path, 'show', `HEAD:${path}`));
    }
    assert.equal(readFileSync(join(f.path, '.codegraph', 'codegraph.db-wal'), 'utf8'), 'retained WAL bytes\n');
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(f.labels, []);
  });
  await t.test('legacy migration can retry an interrupted evidence archive without replacing proof', async () => {
    const { f, ctx, pin } = await legacyFixture();
    pin();
    const recordPath = managedWorktreeRecordPath(f.path), bytes = treeBytes(f.path);
    const predecessorFile = recordPath + '.' + createHash('sha256').update(f.prior.id).digest('hex');
    ctx.deps.openSync = ((path: any, ...args: any[]) => {
      if (path === predecessorFile) throw new Error('interrupted evidence write');
      return (openSync as any)(path, ...args);
    }) as typeof openSync;
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: false });
    assert.deepEqual(treeBytes(f.path), bytes);
    assert.equal(existsSync(recordPath), false);
    const archivePath = `${recordPath}.migration-${ctx.deps.managedWorktree!.migration!.sha256}.json`;
    const archive = readFileSync(archivePath);
    delete ctx.deps.openSync;
    assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: true });
    assert.deepEqual(readFileSync(archivePath), archive);
    assert.deepEqual(treeBytes(f.path), bytes);
  });
  for (const condition of ['missing pin', 'wrong pin', 'missing launch', 'missing completion', 'tampered launch', 'log text', 'oversized evidence', 'aliased evidence',
    'active children', 'unknown children', 'wrong completion run', 'wrong authority run', 'unavailable authority', 'unknown worker',
    'active worker', 'empty active runs', 'changed ownership', 'replayed migration', 'expired migration', 'existing corrupt record', 'existing unreadable record',
    'dangling custody record', 'aliased custody record', 'hardlinked custody record', 'vanished custody read', 'custody directory', 'unreadable custody metadata',
    'wrong repository', 'ambiguous repository', 'ambiguous holders', 'locked', ...IN_PROGRESS_GIT_PATHS, 'branch lock', 'diverged', 'behind origin',
    'unreadable Git state', 'evidence write failure', 'conflicting evidence', 'conflicting predecessor evidence',
    'dangling migration archive', 'aliased migration archive', 'dangling predecessor archive', 'aliased predecessor archive', 'dangling successor archive']) {
    await t.test(`legacy migration refuses ${condition} with the complete retained tree unchanged`, async () => {
      const { f, ctx, source, completion, manifest, pin } = await legacyFixture();
      const managed = ctx.deps.managedWorktree!;
      const launch = JSON.parse(readFileSync(source, 'utf8')), done = JSON.parse(readFileSync(completion, 'utf8'));
      const recordPath = managedWorktreeRecordPath(f.path);
      if (condition.includes('custody') || condition.includes('archive')) {
        // Unsafe records must be caught before substantive edits or staged
        // runtime entries can be committed or unstaged by recovery.
        writeFileSync(join(f.path, 'source.ts'), 'export const retainedRepair = true;\n');
        gitAt(f.path, 'add', '.codegraph', 'worker.pid');
      }
      if (condition === 'log text') writeFileSync(source, 'Managed verifier launched here and its PID is gone; gate FAIL\n');
      if (condition === 'oversized evidence') writeFileSync(source, ' '.repeat(64 * 1024 + 1));
      if (condition === 'aliased evidence') { renameSync(source, source + '.original'); symlinkSync(source + '.original', source); }
      if (condition === 'active children' || condition === 'unknown children') {
        done.trackedChildren = condition === 'active children' ? 'active' : 'unknown';
        writeFileSync(completion, JSON.stringify(done));
      }
      if (condition === 'wrong completion run') { done.run.id = 'other'; writeFileSync(completion, JSON.stringify(done)); }
      if (condition === 'wrong authority run') {
        // Same identity fields but a different authority payload must fail too.
        launch.record.run.resource = done.run.resource = 'light';
        writeFileSync(source, JSON.stringify(launch)); writeFileSync(completion, JSON.stringify(done));
      }
      if (condition === 'wrong repository') { launch.record.commonGitDir = join(root, 'origin.git'); writeFileSync(source, JSON.stringify(launch)); }
      pin();
      if (condition === 'missing pin') delete managed.migration;
      if (condition === 'wrong pin') managed.migration!.sha256 = '0'.repeat(64);
      if (condition === 'missing launch' || condition === 'missing completion') rmSync(condition === 'missing launch' ? source : completion);
      if (condition === 'tampered launch') writeFileSync(source, JSON.stringify({ ...launch, launched: 0 }));
      if (condition === 'unavailable authority') managed.predecessor = async () => { throw new Error('unreachable'); };
      if (condition === 'unknown worker') managed.predecessor = async () => null;
      if (condition === 'active worker') managed.snapshot = async () => ({ ...store.snapshot(), runs: [...store.snapshot().runs, f.prior] });
      if (condition === 'empty active runs') managed.snapshot = async () => ({ ...store.snapshot(), runs: [] });
      if (condition === 'changed ownership') managed.snapshot = async () => ({ ...store.snapshot(), claims: store.snapshot().claims.map(c => ({ ...c, generation: 'new' })) });
      if (condition === 'replayed migration' || condition === 'expired migration') {
        const value = JSON.parse(readFileSync(manifest, 'utf8'));
        if (condition === 'replayed migration') value.successor.generation = 'previous-owner';
        else value.expires = Date.now() - 1;
        writeFileSync(manifest, JSON.stringify(value)); managed.migration = ref(manifest);
      }
      if (condition === 'existing corrupt record' || condition === 'existing unreadable record') writeFileSync(recordPath, '{corrupt');
      const aliasTarget = join(root, `custody-target-${f.number}.json`);
      if (condition === 'dangling custody record' || condition === 'aliased custody record') {
        if (condition === 'aliased custody record') writeFileSync(aliasTarget, JSON.stringify(launch.record));
        symlinkSync(aliasTarget, recordPath);
      }
      if (condition === 'hardlinked custody record') { writeFileSync(aliasTarget, JSON.stringify(launch.record)); linkSync(aliasTarget, recordPath); }
      if (condition === 'vanished custody read') {
        writeFileSync(recordPath, JSON.stringify(launch.record));
        ctx.deps.openSync = ((path: any, ...args: any[]) => {
          if (path === recordPath) throw Object.assign(new Error('unavailable after lstat'), { code: 'ENOENT' });
          return (openSync as any)(path, ...args);
        }) as typeof openSync;
      }
      if (condition === 'custody directory') mkdirSync(recordPath);
      if (condition === 'unreadable custody metadata') ctx.deps.lstatSync = (() => {
        throw Object.assign(new Error('metadata denied'), { code: 'EACCES' });
      }) as typeof lstatSync;
      if (condition === 'existing unreadable record') ctx.deps.openSync = ((path: any, ...args: any[]) => {
        if (path === recordPath) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return (openSync as any)(path, ...args);
      }) as typeof openSync;
      if (condition === 'ambiguous repository') ctx.deps.realpathSync = ((path: any) => path === f.path ? f.path + '-alias' : realpathSync(path)) as typeof realpathSync;
      if (condition === 'locked') git('worktree', 'lock', f.path);
      let operationPath: string | undefined;
      if (IN_PROGRESS_GIT_PATHS.includes(condition as any) || condition === 'branch lock') {
        const name = condition === 'branch lock' ? `refs/heads/feature/${f.number}.lock` : condition;
        operationPath = resolve(f.path, gitAt(f.path, 'rev-parse', '--git-path', name));
        if (['sequencer', 'rebase-merge', 'rebase-apply'].includes(name)) mkdirSync(operationPath);
        else writeFileSync(operationPath, 'unfinished operation\n');
      }
      if (condition === 'diverged' || condition === 'behind origin') {
        const remoteTree = join(root, `legacy-remote-${f.number}`);
        git('worktree', 'add', '--detach', remoteTree, `origin/feature/${f.number}`);
        writeFileSync(join(remoteTree, 'remote.txt'), 'remote work\n');
        gitAt(remoteTree, 'add', 'remote.txt'); gitAt(remoteTree, 'commit', '-m', 'remote work');
        gitAt(remoteTree, 'push', 'origin', `HEAD:refs/heads/feature/${f.number}`);
        if (condition === 'diverged') {
          writeFileSync(join(f.path, 'local.txt'), 'local work\n');
          gitAt(f.path, 'add', 'local.txt'); gitAt(f.path, 'commit', '-m', 'local work');
        }
      }
      const execute = ctx.deps.execSync;
      ctx.deps.execSync = ((command: string, options: any) => {
        if (condition === 'unreadable Git state' && command.includes('--git-path MERGE_HEAD')) throw new Error('unreadable');
        const result = execute(command, options);
        if (condition === 'ambiguous holders' && command === 'git worktree list --porcelain') return String(result) +
          `\nworktree ${f.path}-duplicate\nHEAD duplicate\nbranch refs/heads/feature/${f.number}\n\n`;
        return result;
      }) as typeof execSync;
      if (condition === 'evidence write failure') ctx.deps.writeFileSync = () => { throw new Error('evidence store unavailable'); };
      const archivePath = `${recordPath}.migration-${managed.migration?.sha256}.json`;
      const predecessorFile = recordPath + '.' + createHash('sha256').update(f.prior.id).digest('hex');
      if (condition === 'conflicting evidence') writeFileSync(archivePath, 'original evidence');
      if (condition === 'conflicting predecessor evidence') writeFileSync(predecessorFile, 'original predecessor evidence');
      const successorFile = recordPath + '.' + createHash('sha256').update(managed.run.id).digest('hex');
      if (condition.includes('migration archive') || condition.includes('predecessor archive') || condition === 'dangling successor archive') {
        if (condition.startsWith('aliased')) {
          const { readManagedWorktreeMigration } = await import('./managed-worktree-migration.js');
          const migration = readManagedWorktreeMigration(managed.migration, managed.run, ctx.deps);
          writeFileSync(aliasTarget, condition.includes('migration archive') ? migration.archive : JSON.stringify({ ...migration.record,
            migration: { sha256: migration.sha256, archive: archivePath } }));
        }
        symlinkSync(aliasTarget, condition.includes('migration archive') ? archivePath : condition.includes('predecessor archive') ? predecessorFile : successorFile);
      }
      const bytes = treeBytes(f.path), head = git('rev-parse', `feature/${f.number}`), before = store.snapshot();
      const index = readFileSync(resolve(f.path, gitAt(f.path, 'rev-parse', '--git-path', 'index')));
      const evidencePaths = [source, completion, manifest, recordPath, archivePath, predecessorFile, successorFile, aliasTarget];
      const evidenceSnapshot = () => Object.fromEntries(evidencePaths.map(path => {
        let stat;
        try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, null]; throw error; }
        return [path, stat.isSymbolicLink() ? { link: readlinkSync(path) } : stat.isDirectory() ? treeBytes(path) : readFileSync(path).toString('base64')];
      }));
      const evidenceBytes = evidenceSnapshot();
      f.commands.length = 0;
      assert.deepEqual(await setupBranchAndWorktree(ctx), { ok: false });
      assert.deepEqual(treeBytes(f.path), bytes);
      assert.deepEqual(readFileSync(resolve(f.path, gitAt(f.path, 'rev-parse', '--git-path', 'index'))), index);
      assert.equal(git('rev-parse', `feature/${f.number}`), head);
      assert.deepEqual(store.snapshot(), before);
      assert.deepEqual(evidenceSnapshot(), evidenceBytes);
      assert.ok(!f.commands.some(cmd => /worktree (add|remove|move)|git add|git push|branch -f/.test(cmd)));
      assert.deepEqual(f.item.labels, ['needs-rework:builder', 'rework-count:2']);
      if (operationPath) rmSync(operationPath, { recursive: true });
    });
  }
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
