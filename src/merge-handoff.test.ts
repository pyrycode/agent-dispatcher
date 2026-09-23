import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addedLines,
  checkMergeResolution,
  decideConflictRoute,
  hasConflictMarkers,
  mergeHandoffNote,
  missingLines,
  readPendingMerge,
} from "./merge-handoff.js";
import { REAL_CLAUDE_GATE_FAIL_COLUMN } from "./pipeline-decisions.js";
import { resolveStageSet } from "./stage-sets.js";

describe("decideConflictRoute — who settles a conflict", () => {
  const classic = resolveStageSet("classic").agents;
  const builder = resolveStageSet("builder").agents;
  const route = (agents: typeof classic, name: string) =>
    decideConflictRoute(agents, name, REAL_CLAUDE_GATE_FAIL_COLUMN);

  test("the code owner resolves in its own run", () => {
    assert.deepEqual(route(classic, "developer"), { kind: "resolve" });
    assert.deepEqual(route(builder, "builder"), { kind: "resolve" });
  });

  test("a later stage sends the ticket to the owner", () => {
    for (const name of ["qa", "code-review", "documentation"]) {
      assert.deepEqual(route(classic, name), { kind: "route", owner: "developer" }, name);
    }
    for (const name of ["verifier", "documentation"]) {
      assert.deepEqual(route(builder, name), { kind: "route", owner: "builder" }, name);
    }
  });

  test("an earlier stage, or an agent the set does not run, parks", () => {
    assert.deepEqual(route(classic, "architect"), { kind: "park" });
    assert.deepEqual(route(builder, "refiner"), { kind: "park" });
    assert.deepEqual(route(builder, "developer"), { kind: "park" });
  });
});

describe("merge check helpers", () => {
  test("addedLines keeps non-blank added lines, trimmed, and skips the file header", () => {
    const diff = [
      "diff --git a/T.kt b/T.kt",
      "--- a/T.kt",
      "+++ b/T.kt",
      "@@ -1,0 +2,2 @@",
      "+    turnOutcome = turnOutcome,",
      "+",
      "-    removed",
    ].join("\n");
    assert.deepEqual(addedLines(diff), ["turnOutcome = turnOutcome,"]);
  });

  test("hasConflictMarkers sees the outer markers and ignores a Markdown rule of seven =", () => {
    assert.equal(hasConflictMarkers("a\n<<<<<<< HEAD\nb"), true);
    assert.equal(hasConflictMarkers("a\n>>>>>>> main\nb"), true);
    assert.equal(hasConflictMarkers("Title\n=======\n"), false);
  });

  test("missingLines compares trimmed, so a re-indented line still counts", () => {
    assert.deepEqual(missingLines(["x = 1,", "y = 2,"], "        x = 1,\n"), ["y = 2,"]);
  });

  test("the prompt note names every conflicted file and the commit step", () => {
    const note = mergeHandoffNote("main", ["a/Thread.kt", "res/strings.xml"]);
    assert.match(note, /Finish the merge of `main` first/);
    assert.match(note, /- `a\/Thread\.kt`/);
    assert.match(note, /- `res\/strings\.xml`/);
    assert.match(note, /git commit --no-edit/);
  });
});

// The #805 / #808 collision on 2026-09-23, in a real repository. The branch
// wraps a call in a new layer (re-indenting it) while main adds one argument
// to that call, so git cannot line them up.
describe("checkMergeResolution — real git, the #808 shape", () => {
  const deps = { execSync, readFileSync };
  const git = (cwd: string, cmd: string) =>
    execSync(`git -c user.name=t -c user.email=t@t ${cmd}`, { cwd, stdio: "pipe", encoding: "utf-8" });

  const BASE = ["fun screen() {", "  Status(", "    usage = usage,", "  )", "}", ""].join("\n");
  const MAIN = ["fun screen() {", "  Status(", "    usage = usage,", "    turnOutcome = turnOutcome,", "  )", "}", ""].join("\n");
  const BRANCH = ["fun screen() {", "  Overlay {", "    Status(", "      usage = usage,", "    )", "  }", "}", ""].join("\n");

  function conflictedRepo() {
    const dir = mkdtempSync(join(tmpdir(), "merge-handoff-"));
    git(dir, "init -q -b main");
    writeFileSync(join(dir, "Screen.kt"), BASE);
    git(dir, "add -A");
    git(dir, "commit -q -m base");
    git(dir, "checkout -q -b feature/808");
    writeFileSync(join(dir, "Screen.kt"), BRANCH);
    git(dir, "commit -q -am overlay");
    git(dir, "checkout -q main");
    writeFileSync(join(dir, "Screen.kt"), MAIN);
    git(dir, "commit -q -am outcome");
    git(dir, "checkout -q feature/808");
    assert.throws(() => git(dir, "-c merge.conflictStyle=diff3 merge main --no-edit"), "the fixture must conflict");
    const pending = readPendingMerge(dir, deps);
    assert.ok(pending, "a stopped merge must be readable");
    assert.deepEqual(pending.paths, ["Screen.kt"]);
    return { dir, pending };
  }

  test("an unfinished merge fails the check", () => {
    const { dir, pending } = conflictedRepo();
    try {
      const problems = checkMergeResolution(dir, pending, deps);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /never committed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeping only the branch's side is caught: main's added line is named", () => {
    // What a careless resolution does, and what the first hand attempt on
    // #808 did: take the ticket's whole file.
    const { dir, pending } = conflictedRepo();
    try {
      writeFileSync(join(dir, "Screen.kt"), BRANCH);
      git(dir, "commit -q -am merge --no-edit");
      const problems = checkMergeResolution(dir, pending, deps);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /`Screen\.kt` lost 1 line\(s\) main added: `turnOutcome = turnOutcome,`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("markers committed into the file are caught", () => {
    const { dir, pending } = conflictedRepo();
    try {
      git(dir, "commit -q -am merge --no-edit");
      const problems = checkMergeResolution(dir, pending, deps);
      assert.ok(problems.some(p => /still has conflict markers/.test(p)), problems.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a resolution that keeps both sides, re-indented, passes", () => {
    const { dir, pending } = conflictedRepo();
    try {
      const merged = ["fun screen() {", "  Overlay {", "    Status(", "      usage = usage,", "      turnOutcome = turnOutcome,", "    )", "  }", "}", ""].join("\n");
      writeFileSync(join(dir, "Screen.kt"), merged);
      git(dir, "commit -q -am merge --no-edit");
      assert.deepEqual(checkMergeResolution(dir, pending, deps), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("abandoning the merge for a plain commit is caught: main is not in the branch", () => {
    const { dir, pending } = conflictedRepo();
    try {
      git(dir, "merge --abort");
      writeFileSync(join(dir, "Screen.kt"), BRANCH.replace("usage = usage,", "usage = usage, turnOutcome = turnOutcome,"));
      git(dir, "commit -q -am 'hand-edit'");
      const problems = checkMergeResolution(dir, pending, deps);
      assert.ok(problems.some(p => /no longer contains/.test(p)), problems.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
