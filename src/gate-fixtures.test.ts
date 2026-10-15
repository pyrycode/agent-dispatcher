import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

test("a gate's fixture rewrites are found and put back exactly, also over a file dirty before the gate", () => {
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
  assert.deepEqual(outcome.restored, changed);
  assert.deepEqual(outcome.kept, []);
  assert.equal(readFileSync(capture("plain.jsonl"), "utf8"), "committed\n");
  assert.equal(existsSync(capture("interrupted.jsonl")), false);
  assert.equal(readFileSync(capture("reasoning.jsonl"), "utf8"), "agent edit\n", "the earlier uncommitted edit is back");
  assert.equal(readFileSync(join(dir, "main.go"), "utf8"), "package main // touched\n", "non-fixture files are not touched");
  assert.deepEqual(changedTestdata(before, snapshotTestdata(dir, spawnSync)), [], "nothing the gate did is left");
  const note = gateTestdataComment("verifier", outcome);
  assert.match(note, /Gate rewrote test fixtures/);
  assert.match(note, /plain\.jsonl/);
  assert.doesNotMatch(note, /Could not be put back/);
  assert.match(gateTestdataComment("verifier", { restored: [], kept: ["testdata/x"] }), /Could not be put back/);
});

test("a fixture the gate deleted comes back, and a retargeted symlink is noticed and restored", () => {
  const dir = repo();
  const plain = join(dir, "internal/codexsup/testdata/capture/plain.jsonl");
  const link = join(dir, "internal/codexsup/testdata/capture/latest");
  symlinkSync("plain.jsonl", link);
  const before = snapshotTestdata(dir, spawnSync);
  rmSync(plain);
  unlinkSync(link); symlinkSync("reasoning.jsonl", link);
  const changed = changedTestdata(before, snapshotTestdata(dir, spawnSync));
  assert.deepEqual(changed, ["internal/codexsup/testdata/capture/latest", "internal/codexsup/testdata/capture/plain.jsonl"]);
  restoreGateTestdata(dir, before, changed, spawnSync);
  assert.equal(readFileSync(plain, "utf8"), "committed\n");
  assert.equal(readlinkSync(link), "plain.jsonl");
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

test("a fixture deleted and re-added under a near name, staged as a rename, stays out on both sides", () => {
  const dir = repo();
  const from = "internal/codexsup/testdata/capture/plain.jsonl", to = "internal/codexsup/testdata/capture/plain2.jsonl";
  const body = "a long enough fixture body for git to pair the two paths as a rename\n".repeat(20);
  writeFileSync(join(dir, from), body);
  execSync("git commit -qam body", { cwd: dir });
  rmSync(join(dir, from)); writeFileSync(join(dir, to), body);
  writeFileSync(join(dir, "notes.md"), "real work\n");
  const exclude = new Set([from, to]);
  stageAutomaticChanges(dir, { execSync, spawnSync } as any, exclude);
  assert.deepEqual(execSync("git diff --cached --name-status", { cwd: dir }).toString().trim().split("\n"), ["A\tnotes.md"]);
  // The dirty check: a rename is excluded only when both sides are.
  execSync("git add -A", { cwd: dir });
  const staged = execSync("git status --porcelain -z --untracked-files=all", { cwd: dir }).toString();
  assert.match(staged, /^R/m);
  assert.equal(shouldAutoCommit(staged.replace(/notes\.md/, "x"), new Set([from, to, "x"])), false);
  assert.equal(shouldAutoCommit(staged, new Set([to])), true, "the deletion side is still work");
});

test("a dirty fixture the gate reset to HEAD gets its earlier bytes and mode back", () => {
  const dir = repo();
  const plain = join(dir, "internal/codexsup/testdata/capture/plain.jsonl");
  writeFileSync(plain, "earlier edit\n"); chmodSync(plain, 0o755);
  const before = snapshotTestdata(dir, spawnSync);
  execSync("git checkout -- internal/codexsup/testdata/capture/plain.jsonl", { cwd: dir });
  const changed = changedTestdata(before, snapshotTestdata(dir, spawnSync, false));
  assert.deepEqual(changed, ["internal/codexsup/testdata/capture/plain.jsonl"], "clean now, dirty before: still the gate's change");
  assert.deepEqual(restoreGateTestdata(dir, before, changed, spawnSync).restored, changed);
  assert.equal(readFileSync(plain, "utf8"), "earlier edit\n");
  assert.equal(statSync(plain).mode & 0o777, 0o755);
});

test("only the excluded side of a rename is unstaged; the agent's own side stays", () => {
  const dir = repo();
  const gone = "internal/codexsup/testdata/capture/plain.jsonl", added = "internal/codexsup/testdata/capture/agent.jsonl";
  const body = "a long enough fixture body for git to pair the two paths as a rename\n".repeat(20);
  writeFileSync(join(dir, gone), body);
  execSync("git commit -qam body", { cwd: dir });
  rmSync(join(dir, gone)); writeFileSync(join(dir, added), body);
  stageAutomaticChanges(dir, { execSync, spawnSync } as any, new Set([gone]));
  assert.deepEqual(execSync("git diff --cached --name-status", { cwd: dir }).toString().trim().split("\n"), [`A\t${added}`]);
});
