import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupAfterDispatch, type DispatchContext } from './dispatch.js';

for (const dirty of [false, true]) {
  test(`cleanup preserves main files and ${dirty ? 'retains dirty' : 'removes clean'} worktree`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatcher-cleanup-safety-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'Cleanup Test');
      git('config', 'user.email', 'cleanup@example.invalid');
      writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
      git('branch', '--show-current');
      git('add', 'tracked.txt');
      git('commit', '-m', 'seed');
      git('worktree', 'add', '-b', 'feature/1', worktree);
      writeFileSync(join(repo, 'tracked.txt'), 'operator edit\n');
      writeFileSync(join(repo, 'untracked.txt'), 'operator new file\n');
      if (dirty) {
        writeFileSync(join(worktree, 'tracked.txt'), 'unfinished agent edit\n');
        writeFileSync(join(worktree, 'evidence.txt'), 'uncaptured evidence\n');
      }
      const rejected: string[] = [];
      const ctx = {
        useWorktree: true, worktreeDir: worktree,
        deps: { execSync: (command: string) => {
          // Never execute the old destructive implementation, even during RED.
          if (command !== `git worktree remove "${worktree}"` &&
              command !== 'git status --porcelain --untracked-files=normal') {
            rejected.push(command);
            throw new Error('Rejected destructive or unexpected cleanup command');
          }
          return execSync(command, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
        } },
      } as unknown as DispatchContext;
      await cleanupAfterDispatch(ctx);
      assert.deepEqual(rejected, [], 'cleanup must never request destructive commands');
      assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'operator edit\n');
      assert.equal(readFileSync(join(repo, 'untracked.txt'), 'utf8'), 'operator new file\n');
      assert.equal(existsSync(worktree), dirty);
      if (dirty) {
        assert.equal(readFileSync(join(worktree, 'tracked.txt'), 'utf8'), 'unfinished agent edit\n');
        assert.equal(readFileSync(join(worktree, 'evidence.txt'), 'utf8'), 'uncaptured evidence\n');
        assert.match(git('worktree', 'list', '--porcelain').toString(), /branch refs\/heads\/feature\/1/);
      }
    } finally {
      // This test owns the entire disposable repository and its synthetic files.
      rmSync(root, { recursive: true, force: true });
    }
  });
}
