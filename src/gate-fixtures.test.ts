import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedTestdata, gateTestdataComment, isTestdataPath, restoreGateTestdata, snapshotTestdata } from "./gate-fixtures.js";
import { shouldAutoCommit } from "./worktree.js";
import { stageAutomaticChanges } from "./dispatch.js";

/** A repository with Core's capture fixtures committed, like internal/codexsup/testdata/capture. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-fixtures-"));
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: "pipe" });
  git("init -q -b main");
  git("config user.email t@example.com"); git("config user.name t");
  mkdirSync(join(dir, "internal/codexsup/testdata/capture"), { recursive: true });
  writeFileSync(join(dir, "internal/codexsup/testdata/capture/plain.jsonl"), "committed\n");
  writeFileSync(join(dir, "internal/codexsup/testdata/capture/reasoning.jsonl"), "committed\n");
  writeFileSync(join(dir, "main.go"), "package main\n");
  git("add -A"); git("commit -q -m init");
  return dir;
}

test("isTestdataPath matches testdata folders at any depth, not names that merely contain it", () => {
  assert.equal(isTestdataPath("internal/codexsup/testdata/capture/plain.jsonl"), true);
  assert.equal(isTestdataPath("testdata/x.json"), true);
  assert.equal(isTestdataPath("src/mytestdata/x.json"), false);
  assert.equal(isTestdataPath("testdata.go"), false);
});

test("a gate's fixture rewrites are found, put back exactly, and a file dirty before the gate is kept", () => {
  const dir = repo();
  const capture = (name: string) => join(dir, "internal/codexsup/testdata/capture", name);
  // Dirty before the gate: no exact earlier state to restore.
  writeFileSync(capture("reasoning.jsonl"), "agent edit\n");
  const before = snapshotTestdata(dir, spawnSync);
  // The gate: TestCaptureLive rewrites fixtures, adds one, and the suite touches source too.
  writeFileSync(capture("plain.jsonl"), "live capture\n");
  writeFileSync(capture("reasoning.jsonl"), "live capture\n");
  writeFileSync(capture("interrupted.jsonl"), "new capture\n");
  writeFileSync(join(dir, "main.go"), "package main // touched\n");
  const changed = changedTestdata(before, snapshotTestdata(dir, spawnSync));
  assert.deepEqual(changed, [
    "internal/codexsup/testdata/capture/interrupted.jsonl",
    "internal/codexsup/testdata/capture/plain.jsonl",
    "internal/codexsup/testdata/capture/reasoning.jsonl",
  ], "testdata only, and the already-dirty file because its content changed");
  const outcome = restoreGateTestdata(dir, before, changed, spawnSync);
  assert.deepEqual(outcome.restored, ["internal/codexsup/testdata/capture/interrupted.jsonl", "internal/codexsup/testdata/capture/plain.jsonl"]);
  assert.deepEqual(outcome.kept, ["internal/codexsup/testdata/capture/reasoning.jsonl"]);
  assert.equal(readFileSync(capture("plain.jsonl"), "utf8"), "committed\n");
  assert.equal(existsSync(capture("interrupted.jsonl")), false);
  assert.equal(readFileSync(capture("reasoning.jsonl"), "utf8"), "live capture\n", "left for the exclusion below");
  assert.equal(readFileSync(join(dir, "main.go"), "utf8"), "package main // touched\n", "non-fixture files are not touched");
  const note = gateTestdataComment("verifier", outcome);
  assert.match(note, /Gate rewrote test fixtures/);
  assert.match(note, /plain\.jsonl/);
  assert.match(note, /kept out of every automatic commit/);
});

test("an unchanged dirty fixture is not the gate's", () => {
  const dir = repo();
  writeFileSync(join(dir, "internal/codexsup/testdata/capture/plain.jsonl"), "builder fixture\n");
  const before = snapshotTestdata(dir, spawnSync);
  assert.deepEqual(changedTestdata(before, snapshotTestdata(dir, spawnSync)), []);
});

test("automatic staging and the dirty check leave excluded fixtures out of the commit", () => {
  const dir = repo();
  const fixture = "internal/codexsup/testdata/capture/plain.jsonl";
  writeFileSync(join(dir, fixture), "live capture\n");
  const status = () => execSync("git status --porcelain -z --untracked-files=all", { cwd: dir }).toString();
  const exclude = new Set([fixture]);
  assert.equal(shouldAutoCommit(status(), exclude), false, "only the gate's fixture is dirty: nothing to commit");
  assert.equal(shouldAutoCommit(status()), true);
  writeFileSync(join(dir, "notes.md"), "agent forgot to commit this\n");
  assert.equal(shouldAutoCommit(status(), exclude), true);
  stageAutomaticChanges(dir, { execSync, spawnSync } as any, exclude);
  const staged = execSync("git diff --cached --name-only", { cwd: dir }).toString().trim().split("\n");
  assert.deepEqual(staged, ["notes.md"]);
  assert.match(status(), / M internal\/codexsup\/testdata\/capture\/plain\.jsonl/, "the fixture stays as an unstaged change");
});
