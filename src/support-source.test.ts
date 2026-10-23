import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSupportSource, prepareSupportSource, removeSupportSource, supportSourceEnabled, supportSourceEnv, SupportSourceError } from "./support-source.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function commit(repo: string, file: string, text: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", text);
  return git(repo, "rev-parse", "HEAD");
}

/** An origin, a configured copy cloned from it, and origin moved on since. */
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "support-source-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const upstream = join(dir, "upstream");
  execFileSync("git", ["init", "-q", "-b", "main", upstream]);
  const stale = commit(upstream, "a.txt", "one");
  const origin = join(dir, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", upstream, origin]);
  const base = join(dir, "pyrycode");
  execFileSync("git", ["clone", "-q", origin, base]);
  const current = commit(upstream, "a.txt", "two");
  git(upstream, "push", "-q", origin, "main");
  const runs = join(dir, "runs");
  execFileSync("mkdir", [runs]);
  return { dir, upstream, origin, base, stale, current, runs };
}

test("a run gets current origin main in its own worktree; the configured copy is left as it was", (t) => {
  const f = fixture(t);
  const source = prepareSupportSource({ env: { PYRYCODE_SRC: f.base }, label: "2442-verifier", spawnSync, root: f.runs });
  assert.equal(source.revision, f.current);
  assert.equal(git(source.path, "rev-parse", "HEAD"), f.current);
  assert.notEqual(source.path, f.base);
  assert.equal(source.baseDirty, false);
  assert.deepEqual(supportSourceEnv(source), { PYRYCODE_SRC: source.path });
  // Nothing in the configured copy moved: branch, HEAD, remote-tracking ref.
  assert.equal(git(f.base, "rev-parse", "HEAD"), f.stale);
  assert.equal(git(f.base, "rev-parse", "origin/main"), f.stale);
  assert.equal(git(f.base, "branch", "--show-current"), "main");
  assert.match(describeSupportSource(source), new RegExp(`core ${f.current} \\(origin/main\\)`));

  removeSupportSource(source, spawnSync);
  assert.equal(existsSync(source.path), false);
  assert.ok(!git(f.base, "worktree", "list").includes(source.path));
});

test("concurrent runs each get their own worktree", (t) => {
  const f = fixture(t);
  const a = prepareSupportSource({ env: { PYRYCODE_SRC: f.base }, label: "1-builder", spawnSync, root: f.runs });
  const b = prepareSupportSource({ env: { PYRYCODE_SRC: f.base }, label: "2-verifier", spawnSync, root: f.runs });
  assert.notEqual(a.path, b.path);
  removeSupportSource(a, spawnSync);
  assert.equal(git(b.path, "rev-parse", "HEAD"), f.current, "removing one run's source leaves the other's");
  removeSupportSource(b, spawnSync);
});

test("a pinned commit is used as given", (t) => {
  const f = fixture(t);
  const source = prepareSupportSource({ env: { PYRYCODE_SRC: f.base, PYRYCODE_SRC_REF: f.stale }, label: "x", spawnSync, root: f.runs });
  assert.equal(source.revision, f.stale);
  assert.match(describeSupportSource(source), /\(pinned\)/);
  removeSupportSource(source, spawnSync);
});

test("a configured copy that is itself a worktree, as on the Mac, works the same", (t) => {
  const f = fixture(t);
  const snapshot = join(f.dir, "mobile-core-2c68b595440d");
  git(f.base, "worktree", "add", "-q", "--detach", snapshot, f.stale);
  const source = prepareSupportSource({ env: { PYRYCODE_SRC: snapshot }, label: "x", spawnSync, root: f.runs });
  assert.equal(git(source.path, "rev-parse", "HEAD"), f.current);
  assert.equal(git(snapshot, "rev-parse", "HEAD"), f.stale);
  removeSupportSource(source, spawnSync);
});

test("local changes in the configured copy are reported and kept out of the run", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.base, "a.txt"), "local edit");
  const source = prepareSupportSource({ env: { PYRYCODE_SRC: f.base }, label: "x", spawnSync, root: f.runs });
  assert.equal(source.baseDirty, true);
  assert.match(describeSupportSource(source), /has local changes, which this run does not use/);
  assert.equal(git(source.path, "status", "--porcelain"), "");
  removeSupportSource(source, spawnSync);
});

test("a failed fetch is an error, never the stale copy", (t) => {
  const f = fixture(t);
  git(f.base, "remote", "set-url", "origin", join(f.dir, "missing.git"));
  assert.throws(() => prepareSupportSource({ env: { PYRYCODE_SRC: f.base }, label: "x", spawnSync, root: f.runs }),
    (e: unknown) => e instanceof SupportSourceError && /could not read main from origin/.test(e.message));
  assert.equal(execFileSync("ls", [f.runs], { encoding: "utf-8" }).trim(), "", "no worktree is left behind");
});

test("a pinned commit origin does not have is an error", (t) => {
  const f = fixture(t);
  assert.throws(() => prepareSupportSource({ env: { PYRYCODE_SRC: f.base, PYRYCODE_SRC_REF: "f".repeat(40) }, label: "x", spawnSync, root: f.runs }),
    (e: unknown) => e instanceof SupportSourceError && /could not fetch f{40}/.test(e.message));
});

test("a path that is not a git checkout is an error", (t) => {
  const f = fixture(t);
  assert.throws(() => prepareSupportSource({ env: { PYRYCODE_SRC: f.runs }, label: "x", spawnSync, root: f.runs }),
    (e: unknown) => e instanceof SupportSourceError && /is not a git checkout/.test(e.message));
});

test("only forks that set PYRYCODE_SRC refresh, and the switch turns it off", () => {
  assert.equal(supportSourceEnabled({}), false);
  assert.equal(supportSourceEnabled({ PYRYCODE_SRC: "  " }), false);
  assert.equal(supportSourceEnabled({ PYRYCODE_SRC: "/work/Projects/pyrycode" }), true);
  assert.equal(supportSourceEnabled({ PYRYCODE_SRC: "/work/Projects/pyrycode", PYRY_SUPPORT_SOURCE_REFRESH: "0" }), false);
  assert.deepEqual(supportSourceEnv(undefined), {});
});
