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

  test("a line a formatter realigned still counts (pyrycode #2586)", () => {
    // gofmt widens a struct literal's alignment when the branch adds a
    // longer field name; main's lines survive with only their spacing changed.
    const diff = "+++ b/codex_runner.go\n+\t\t\tBinary:   bin,\n+\t\t\tHome:     h.home,\n";
    const merged = "\t\t\tBinary:         bin,\n\t\t\tHome:           h.home,\n\t\t\tPermissionMode: cfg.PermissionMode,\n";
    assert.deepEqual(missingLines(addedLines(diff), merged), []);
    assert.deepEqual(missingLines(addedLines(diff), "\t\t\tBinary:         bin,\n"), ["Home: h.home,"]);
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

// pyrycode-mobile#932 on 2026-09-24. Both sides changed the same line: main
// added one argument to a call and the ticket added another. The right
// resolution is one line carrying both, so neither side's line survives
// verbatim.
describe("checkMergeResolution — real git, both sides edit one line", () => {
  const deps = { execSync, readFileSync };
  const git = (cwd: string, cmd: string) =>
    execSync(`git -c user.name=t -c user.email=t@t ${cmd}`, { cwd, stdio: "pipe", encoding: "utf-8" });

  const file = (call: string) => ["fun module() {", `  val t = ${call}`, "  t.open()", "}", ""].join("\n");
  const BASE = file("thread(handle)");
  const MAIN = file("thread(handle, viewing)");
  const BRANCH = file("thread(handle, reader)");

  function conflictedRepo() {
    const dir = mkdtempSync(join(tmpdir(), "merge-handoff-"));
    git(dir, "init -q -b main");
    writeFileSync(join(dir, "Module.kt"), BASE);
    git(dir, "add -A");
    git(dir, "commit -q -m base");
    git(dir, "checkout -q -b feature/932");
    writeFileSync(join(dir, "Module.kt"), BRANCH);
    git(dir, "commit -q -am reader");
    git(dir, "checkout -q main");
    writeFileSync(join(dir, "Module.kt"), MAIN);
    git(dir, "commit -q -am viewing");
    git(dir, "checkout -q feature/932");
    assert.throws(() => git(dir, "merge main --no-edit"), "the fixture must conflict");
    const pending = readPendingMerge(dir, deps);
    assert.ok(pending, "a stopped merge must be readable");
    return { dir, pending };
  }

  test("one line carrying both sides' changes passes", () => {
    const { dir, pending } = conflictedRepo();
    try {
      writeFileSync(join(dir, "Module.kt"), file("thread(handle, viewing, reader)"));
      git(dir, "commit -q -am merge --no-edit");
      assert.deepEqual(checkMergeResolution(dir, pending, deps), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeping only the branch's version of the line is still caught", () => {
    const { dir, pending } = conflictedRepo();
    try {
      writeFileSync(join(dir, "Module.kt"), BRANCH);
      git(dir, "commit -q -am merge --no-edit");
      const problems = checkMergeResolution(dir, pending, deps);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /lost 1 line\(s\) main added: `val t = thread\(handle, viewing\)`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// pyrycode-mobile#883 on 2026-09-24. Main moved a test file and the ticket
// deleted it, because the ticket removes the screen it tests. Keeping the
// file deleted is the ticket's own reviewed change, not a lost side.
describe("checkMergeResolution — real git, the branch deleted a file main changed", () => {
  const deps = { execSync, readFileSync };
  const git = (cwd: string, cmd: string) =>
    execSync(`git -c user.name=t -c user.email=t@t ${cmd}`, { cwd, stdio: "pipe", encoding: "utf-8" });

  const OLD = ["class LiteralScreenTest {", "  fun shows() = check()", "}", ""].join("\n");

  function conflictedRepo(mainChange: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "merge-handoff-"));
    git(dir, "init -q -b main");
    writeFileSync(join(dir, "Keep.kt"), "keep\n");
    execSync("mkdir -p device shared", { cwd: dir });
    writeFileSync(join(dir, "device/LiteralScreenTest.kt"), OLD);
    git(dir, "add -A");
    git(dir, "commit -q -m base");
    git(dir, "checkout -q -b feature/883");
    git(dir, "rm -q device/LiteralScreenTest.kt");
    git(dir, "commit -q -m retire");
    git(dir, "checkout -q main");
    mainChange(dir);
    git(dir, "add -A");
    git(dir, "commit -q -m change");
    git(dir, "checkout -q feature/883");
    assert.throws(() => git(dir, "merge main --no-edit"), "the fixture must conflict");
    const pending = readPendingMerge(dir, deps);
    assert.ok(pending, "a stopped merge must be readable");
    return { dir, pending };
  }

  const move = (dir: string) => git(dir, "mv device/LiteralScreenTest.kt shared/LiteralScreenTest.kt");
  const edit = (dir: string) => writeFileSync(join(dir, "device/LiteralScreenTest.kt"), OLD.replace("check()", "check(robolectric = true)"));

  for (const [name, change] of [["moved", move], ["edited", edit]] as const) {
    test(`keeping the file deleted when main ${name} it passes`, () => {
      const { dir, pending } = conflictedRepo(change);
      try {
        git(dir, "rm -q --ignore-unmatch device/LiteralScreenTest.kt shared/LiteralScreenTest.kt");
        git(dir, "commit -q --no-edit");
        assert.deepEqual(checkMergeResolution(dir, pending, deps), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("deleting a file the branch still had is caught", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-handoff-"));
    try {
      git(dir, "init -q -b main");
      writeFileSync(join(dir, "A.kt"), "val a = 1\n");
      git(dir, "add -A");
      git(dir, "commit -q -m base");
      git(dir, "checkout -q -b feature/1");
      writeFileSync(join(dir, "A.kt"), "val a = 2\n");
      git(dir, "commit -q -am branch");
      git(dir, "checkout -q main");
      writeFileSync(join(dir, "A.kt"), "val a = 3\n");
      git(dir, "commit -q -am main");
      git(dir, "checkout -q feature/1");
      assert.throws(() => git(dir, "merge main --no-edit"), "the fixture must conflict");
      const pending = readPendingMerge(dir, deps);
      assert.ok(pending);
      git(dir, "rm -q A.kt");
      git(dir, "commit -q --no-edit");
      const problems = checkMergeResolution(dir, pending, deps);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /`A\.kt` lost 1 line\(s\) main added: `val a = 3`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
