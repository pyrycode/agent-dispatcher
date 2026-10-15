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
// Whatever the gates changed is put back where that is exact (the file was
// clean before), and every changed path is kept out of all automatic commits
// of the run, which is the guarantee: a restore that fails still cannot ship.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { statusEntries } from "./worktree.js";

type SpawnSync = (cmd: string, args: readonly string[], opts: { cwd: string; stdio: "pipe"; timeout: number }) => SpawnSyncReturns<Buffer>;

/** A path inside any `testdata/` folder, at any depth. */
export function isTestdataPath(path: string): boolean {
  return /(^|\/)testdata\//.test(path);
}

/** Dirty `testdata/` paths, each with its status and content digest. */
export type TestdataSnapshot = Map<string, string>;

function digest(cwd: string, path: string): string {
  const full = resolve(cwd, path);
  try {
    const stat = lstatSync(full);
    if (!stat.isFile()) return stat.isSymbolicLink() ? "symlink" : "other";
    return createHash("sha256").update(readFileSync(full)).digest("hex");
  } catch {
    return "missing";
  }
}

/** Read the worktree's dirty `testdata/` paths. Throws when git cannot be read. */
export function snapshotTestdata(cwd: string, spawnSync: SpawnSync): TestdataSnapshot {
  const status = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd, stdio: "pipe", timeout: 15_000 });
  if (status.status !== 0) throw new Error(`git status failed: ${status.stderr?.toString() || "unknown"}`);
  const snapshot: TestdataSnapshot = new Map();
  for (const entry of statusEntries(status.stdout.toString())) {
    for (const path of [entry.path, ...(entry.from !== undefined ? [entry.from] : [])]) {
      if (isTestdataPath(path)) snapshot.set(path, `${entry.status}:${digest(cwd, path)}`);
    }
  }
  return snapshot;
}

/** Paths the gates changed: dirty now and not in that exact state before. */
export function changedTestdata(before: TestdataSnapshot, after: TestdataSnapshot): string[] {
  return [...after.keys()].filter(path => before.get(path) !== after.get(path)).sort();
}

export interface TestdataRestore {
  /** Put back exactly as before the gates. */
  restored: string[];
  /** Left as the gates wrote them: dirty before the gates, or the restore failed. Never committed. */
  kept: string[];
}

/**
 * Put back each changed path that was clean before the gates: a tracked file
 * returns to HEAD, a new untracked file is removed. A path that was already
 * dirty has no exact earlier state here and is kept, as is one whose restore
 * fails. The caller keeps every changed path out of automatic commits anyway.
 */
export function restoreGateTestdata(cwd: string, before: TestdataSnapshot, changed: readonly string[], spawnSync: SpawnSync): TestdataRestore {
  const restored: string[] = [], kept: string[] = [];
  for (const path of changed) {
    if (before.has(path)) { kept.push(path); continue; }
    try {
      const tracked = spawnSync("git", ["cat-file", "-e", `HEAD:${path}`], { cwd, stdio: "pipe", timeout: 15_000 }).status === 0;
      if (tracked) {
        const r = spawnSync("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", `:(literal)${path}`], { cwd, stdio: "pipe", timeout: 15_000 });
        if (r.status !== 0) throw new Error(r.stderr?.toString() || "git restore failed");
      } else {
        // Unstage first in case something added it, then remove the file.
        spawnSync("git", ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", `:(literal)${path}`], { cwd, stdio: "pipe", timeout: 15_000 });
        rmSync(resolve(cwd, path), { force: true });
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
    ...(result.kept.length ? ["", "Left in the worktree and kept out of every automatic commit:", "", list(result.kept)] : []),
    "",
    "A test that writes its own fixtures on an ordinary run is a defect in that test: it should run only on request, behind a build tag or an explicit opt-in.",
  ].join("\n");
}
