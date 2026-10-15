// Test fixtures a gate rewrote never reach a commit.
//
// A deterministic gate runs the fork's own suite in the agent's worktree. A
// test that records live data into `testdata/` (Core's `TestCaptureLive` has
// no build tag) rewrites tracked fixtures whenever the computer happens to
// have the credentials it looks for. The safety-net commit after the run then
// pushed those rewrites as the verifier's own work: pyrycode #3389 (3d7f3937)
// and #3385 (38b09727) on 2026-10-15, six capture fixtures each.
//
// The pre-spawn gate step snapshots `testdata/` before and after the gates.
// Whatever the gates changed is put back as it was, and every changed path is
// kept out of all automatic commits of the run, so a restore that fails still
// cannot ship in this run.

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { statusEntries } from "./worktree.js";

type SpawnSync = (cmd: string, args: readonly string[], opts: { cwd: string; stdio: "pipe"; timeout: number }) => SpawnSyncReturns<Buffer>;

/** A path inside any `testdata/` folder, at any depth. */
export function isTestdataPath(path: string): boolean {
  return /(^|\/)testdata\//.test(path);
}

/** What a dirty `testdata/` path held: a file's digest, mode and (before the gates) bytes, a symlink's target, or nothing. */
export interface TestdataEntry { status: string; kind: "file" | "symlink" | "missing" | "other"; digest?: string; mode?: number; data?: Buffer; target?: string }
/** Dirty `testdata/` paths before or after the gates. */
export type TestdataSnapshot = Map<string, TestdataEntry>;

function entry(cwd: string, path: string, status: string, keepBytes: boolean): TestdataEntry {
  const full = resolve(cwd, path);
  try {
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return { status, kind: "symlink", target: readlinkSync(full) };
    if (stat.isFile()) {
      const data = readFileSync(full);
      return { status, kind: "file", digest: createHash("sha256").update(data).digest("hex"), mode: stat.mode & 0o7777, ...(keepBytes ? { data } : {}) };
    }
    return { status, kind: "other" };
  } catch {
    return { status, kind: "missing" };
  }
}
/** Remove a file or symlink, dangling or not. Missing is fine; a folder is not removed. */
function removeEntry(full: string): void {
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) unlinkSync(full);
}
function same(a: TestdataEntry | undefined, b: TestdataEntry | undefined): boolean {
  return !!a && !!b && a.status === b.status && a.kind === b.kind && a.target === b.target && a.digest === b.digest && a.mode === b.mode;
}

/**
 * Read the worktree's dirty `testdata/` paths. Throws when git cannot be read.
 * `keepBytes` (the snapshot before the gates) keeps file contents for an exact
 * restore; the snapshot after the gates needs only digests.
 */
export function snapshotTestdata(cwd: string, spawnSync: SpawnSync, keepBytes = true): TestdataSnapshot {
  const status = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd, stdio: "pipe", timeout: 15_000 });
  if (status.status !== 0) throw new Error(`git status failed: ${status.stderr?.toString() || "unknown"}`);
  const snapshot: TestdataSnapshot = new Map();
  for (const e of statusEntries(status.stdout.toString())) {
    for (const path of [e.path, ...(e.from !== undefined ? [e.from] : [])]) {
      if (isTestdataPath(path)) snapshot.set(path, entry(cwd, path, e.status, keepBytes));
    }
  }
  return snapshot;
}

/**
 * Paths the gates changed: dirty now and not in that exact state before, or
 * dirty before and clean now (a gate put it back to HEAD or deleted a new file).
 */
export function changedTestdata(before: TestdataSnapshot, after: TestdataSnapshot): string[] {
  return [...new Set([...after.keys(), ...before.keys()])].filter(path => !same(before.get(path), after.get(path))).sort();
}

export interface TestdataRestore {
  /** Put back exactly as before the gates. */
  restored: string[];
  /** Left as the gates wrote them because the restore failed. Never committed by this run. */
  kept: string[];
}

/**
 * Put back each changed path as it was before the gates. One that was clean
 * returns to HEAD, or is removed when HEAD does not have it. One that was
 * already dirty gets its earlier bytes or link target back. A path whose
 * restore fails, or whose earlier state was not a file or link, is kept; the
 * caller keeps every changed path out of the run's automatic commits anyway.
 */
export function restoreGateTestdata(cwd: string, before: TestdataSnapshot, changed: readonly string[], spawnSync: SpawnSync): TestdataRestore {
  const restored: string[] = [], kept: string[] = [];
  for (const path of changed) {
    const full = resolve(cwd, path);
    const earlier = before.get(path);
    try {
      if (earlier) {
        // Dirty before the gates: put the earlier bytes back. The index is left alone.
        if (earlier.kind === "other") throw new Error("not a file");
        removeEntry(full);
        if (earlier.kind === "file") {
          if (!earlier.data) throw new Error("no saved bytes");
          mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, earlier.data); chmodSync(full, earlier.mode ?? 0o644);
        }
        else if (earlier.kind === "symlink") { mkdirSync(dirname(full), { recursive: true }); symlinkSync(earlier.target!, full); }
      } else if (spawnSync("git", ["cat-file", "-e", `HEAD:${path}`], { cwd, stdio: "pipe", timeout: 15_000 }).status === 0) {
        const r = spawnSync("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", `:(literal)${path}`], { cwd, stdio: "pipe", timeout: 15_000 });
        if (r.status !== 0) throw new Error(r.stderr?.toString() || "git restore failed");
      } else {
        // New: unstage it in case something added it, then remove the file.
        spawnSync("git", ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", `:(literal)${path}`], { cwd, stdio: "pipe", timeout: 15_000 });
        removeEntry(full);
      }
      restored.push(path);
    } catch {
      kept.push(path);
    }
  }
  return { restored, kept };
}

/** The ticket comment naming what a gate rewrote and what happened to it. */
export function gateTestdataComment(agent: string, result: TestdataRestore): string {
  const list = (paths: readonly string[]) => paths.map(p => `- \`${p}\``).join("\n");
  return [
    "## Gate rewrote test fixtures",
    "",
    `The deterministic gates before \`${agent}\` changed files under \`testdata/\`. A gate must not change the tree, so none of these is committed by the dispatcher.`,
    ...(result.restored.length ? ["", "Put back as they were before the gates:", "", list(result.restored)] : []),
    ...(result.kept.length ? ["", "Could not be put back. Left in the worktree and kept out of this run's automatic commits:", "", list(result.kept)] : []),
    "",
    "A test that writes its own fixtures on an ordinary run is a defect in that test: it should run only on request, behind a build tag or an explicit opt-in.",
  ].join("\n");
}
