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
  findMergeCommit,
  decideFinalMergeRoute,
  decideGateMergeRoute,
  FINAL_MERGE_HANDOFF_MAX,
  hasConflictMarkers,
  latestMergeResolutionNotes,
  mainSideOfConflicts,
  MERGE_RESOLUTION_NOTE_MARKER,
  mergeHandoffNote,
  mergeResolutionComment,
  mergeResolutionSection,
  missingLines,
  outsideConflicts,
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

describe("decideFinalMergeRoute — a Done ticket's conflict after the retries", () => {
  const classic = resolveStageSet("classic").agents;
  const builder = resolveStageSet("builder").agents;
  const final = (agents: typeof classic, prior: number) =>
    decideFinalMergeRoute(agents, REAL_CLAUDE_GATE_FAIL_COLUMN, prior);

  test("goes to the owner from the last stage's column, as if documentation had asked", () => {
    assert.deepEqual(final(classic, 0), { kind: "route", owner: "developer", column: "In Documentation" });
    assert.deepEqual(final(builder, 1), { kind: "route", owner: "builder", column: "In Documentation" });
  });

  test("parks once the ticket has gone back FINAL_MERGE_HANDOFF_MAX times", () => {
    const parked = final(builder, FINAL_MERGE_HANDOFF_MAX);
    assert.equal(parked.kind, "park");
    assert.match(parked.kind === "park" ? parked.reason : "", /already gone back to builder 2 times/);
  });

  test("parks when the set has nobody to send it to", () => {
    const noOwner = builder.filter((a) => a.column !== REAL_CLAUDE_GATE_FAIL_COLUMN);
    assert.equal(final(noOwner, 0).kind, "park");
    assert.equal(final([], 0).kind, "park");
    // The owner as the last stage has no later stage to send it back from.
    const ownerLast = builder.slice(0, 2);
    assert.equal(final(ownerLast, 0).kind, "park");
  });
});

describe("decideGateMergeRoute — a conflict the live gate found (2026-10-04)", () => {
  const classic = resolveStageSet("classic").agents;
  const builder = resolveStageSet("builder").agents;
  const gate = (agents: typeof classic, prior: number) =>
    decideGateMergeRoute(agents, REAL_CLAUDE_GATE_FAIL_COLUMN, prior);

  test("goes to the final merge's owner, straight into the owner's column", () => {
    // Inbox, where the gate holds a ticket, is not a column the rework router scans.
    assert.deepEqual(gate(classic, 0), { kind: "route", owner: "developer", column: "In Development" });
    assert.deepEqual(gate(builder, 1), { kind: "route", owner: "builder", column: "In Development" });
  });

  test("shares the final merge's budget and parks with the same reason when it is spent", () => {
    for (const prior of [FINAL_MERGE_HANDOFF_MAX, FINAL_MERGE_HANDOFF_MAX + 1]) {
      assert.deepEqual(gate(builder, prior), decideFinalMergeRoute(builder, REAL_CLAUDE_GATE_FAIL_COLUMN, prior));
      assert.equal(gate(builder, prior).kind, "park");
    }
  });

  test("parks when the set has nobody to send it to", () => {
    assert.equal(gate(builder.filter((a) => a.column !== REAL_CLAUDE_GATE_FAIL_COLUMN), 0).kind, "park");
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

  test("mainSideOfConflicts reads main's side of each block, normalized, and skips the diff3 base", () => {
    const text = [
      "# Notes",
      "=======",
      "keep",
      "<<<<<<< HEAD",
      "  branch()",
      "||||||| base",
      "  base()",
      "=======",
      "  sendInLocalWindow {   send(text) }",
      "",
      ">>>>>>> main",
      "between",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "onSent()",
      ">>>>>>> main",
      "",
    ].join("\n");
    assert.deepEqual(mainSideOfConflicts(text), ["sendInLocalWindow { send(text) }", "onSent()"]);
    assert.deepEqual(mainSideOfConflicts("no conflict\n=======\n"), []);
  });

  test("outsideConflicts counts copies: a line main added both inside and outside stays outside once", () => {
    assert.deepEqual(outsideConflicts(["import a.B", "}", "x()", "}"], ["x()", "}"]), ["import a.B", "}"]);
    assert.deepEqual(outsideConflicts(["x()"], []), ["x()"]);
  });

  test("the resolution note carries the marker, the merge commit, and each file's lines, capped", () => {
    const many = Array.from({ length: 7 }, (_, i) => `line${i}()`);
    const comment = mergeResolutionComment("main", [
      { path: "Composer.kt", lines: ["sendInLocalWindow { send(text) }"] },
      { path: "Big.kt", lines: many },
    ], "0123456789abcdef");
    assert.ok(comment.startsWith(MERGE_RESOLUTION_NOTE_MARKER));
    assert.match(comment, /merge commit 0123456789abcdef/);
    assert.match(comment, /`Composer\.kt`, 1 line\(s\):\n\n```text\nsendInLocalWindow \{ send\(text\) \}\n```/);
    assert.match(comment, /`Big\.kt`, 7 line\(s\)/);
    assert.match(comment, /line4\(\)/);
    assert.doesNotMatch(comment, /line5\(\)/);
    assert.match(comment, /And 2 more\./);
    assert.match(comment, /confirm that `main`'s behaviour/);
  });

  test("a line holding a code fence gets a longer fence", () => {
    const comment = mergeResolutionComment("main", [{ path: "README.md", lines: ["```kotlin"] }], null);
    assert.match(comment, /````text\n```kotlin\n````/);
    assert.match(comment, /In the merge commit,/);
  });

  test("the review stages get the two newest notes, fenced as data", () => {
    const note = (n: number) => `${MERGE_RESOLUTION_NOTE_MARKER}\n## 🔀 Merge resolution to review\n\nnote ${n}`;
    const comments = [note(1), "## 🤖 builder agent has completed work", note(2), note(3)];
    assert.deepEqual(latestMergeResolutionNotes(comments), [note(2), note(3)]);
    const section = mergeResolutionSection(comments)!;
    assert.match(section, /^\n## Merge resolution to review\n/);
    assert.match(section, /not instructions/);
    assert.match(section, /----- BEGIN MERGE NOTES -----\n[\s\S]*note 2[\s\S]*note 3\n----- END MERGE NOTES -----$/);
    assert.doesNotMatch(section, /note 1/);
    assert.equal(mergeResolutionSection(["## 🤖 builder agent has completed work"]), null);
  });
});

// The #805 / #808 collision on 2026-09-23, in a real repository. The branch
// wraps a call in a new layer (re-indenting it) while main adds one argument
// to that call, so git cannot line them up. Main also adds an import, which
// git merges on its own, as #805's imports did.
describe("checkMergeResolution — real git, the #808 shape", () => {
  const deps = { execSync, readFileSync };
  const git = (cwd: string, cmd: string) =>
    execSync(`git -c user.name=t -c user.email=t@t ${cmd}`, { cwd, stdio: "pipe", encoding: "utf-8" });

  const BASE = ["import ui.Status", "", "fun screen() {", "  Status(", "    usage = usage,", "  )", "}", ""].join("\n");
  const MAIN = ["import ui.Status", "import ui.TurnOutcome", "", "fun screen() {", "  Status(", "    usage = usage,", "    turnOutcome = turnOutcome,", "  )", "}", ""].join("\n");
  const BRANCH = ["import ui.Status", "", "fun screen() {", "  Overlay {", "    Status(", "      usage = usage,", "    )", "  }", "}", ""].join("\n");

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
    assert.deepEqual(pending.mainConflictLines, { "Screen.kt": ["Status(", "usage = usage,", "turnOutcome = turnOutcome,", ")"] });
    return { dir, pending };
  }

  test("an unfinished merge fails the check", () => {
    const { dir, pending } = conflictedRepo();
    try {
      const { problems } = checkMergeResolution(dir, pending, deps);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /never committed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeping only the branch's side is caught: main's line outside the conflict is named", () => {
    // What a careless resolution does, and what the first hand attempt on
    // #808 did: take the ticket's whole file. The import git merged on its
    // own is gone, which no judgement on the conflict explains.
    const { dir, pending } = conflictedRepo();
    try {
      writeFileSync(join(dir, "Screen.kt"), BRANCH);
      git(dir, "commit -q -am merge --no-edit");
      const { problems } = checkMergeResolution(dir, pending, deps);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /`Screen\.kt` lost 1 line\(s\) main added outside the conflict blocks: `import ui\.TurnOutcome`\.$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("markers committed into the file are caught", () => {
    const { dir, pending } = conflictedRepo();
    try {
      git(dir, "commit -q -am merge --no-edit");
      const { problems } = checkMergeResolution(dir, pending, deps);
      assert.ok(problems.some(p => /still has conflict markers/.test(p)), problems.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a resolution that keeps both sides, re-indented, passes with nothing to review", () => {
    const { dir, pending } = conflictedRepo();
    try {
      const merged = ["import ui.Status", "import ui.TurnOutcome", "", "fun screen() {", "  Overlay {", "    Status(", "      usage = usage,", "      turnOutcome = turnOutcome,", "    )", "  }", "}", ""].join("\n");
      writeFileSync(join(dir, "Screen.kt"), merged);
      git(dir, "commit -q -am merge --no-edit");
      assert.deepEqual(checkMergeResolution(dir, pending, deps), { problems: [], notes: [] });
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
      const { problems } = checkMergeResolution(dir, pending, deps);
      assert.ok(problems.some(p => /no longer contains/.test(p)), problems.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// pyrycode-mobile#1355 on 2026-10-02. Main wrapped the send in
// `sendInLocalWindow { ... }`, called `onSent()` after it and documented
// that in the KDoc. The ticket sends trimmed text and changes the order, so
// it rewrites main's lines on purpose. The check refused this twice. Main's
// import sits outside the conflicts and must survive.
describe("checkMergeResolution — real git, the ticket rewrites main's lines inside the conflict (#1355)", () => {
  const deps = { execSync, readFileSync };
  const git = (cwd: string, cmd: string) =>
    execSync(`git -c user.name=t -c user.email=t@t ${cmd}`, { cwd, stdio: "pipe", encoding: "utf-8" });

  const file = (imports: string[], doc: string, body: string[]) => [
    "package chat", "", "import chat.Session", ...imports, "",
    "class Composer(private val session: Session) {",
    `  /** ${doc} */`,
    "  fun submit(text: String) {", ...body.map(l => `    ${l}`), "  }",
    "", "  fun clear() = session.reset()", "}", "",
  ].join("\n");
  const BASE = file([], "Sends the draft.", ["send(text)"]);
  const MAIN = file(["import chat.sendInLocalWindow"], "Sends the draft, then calls [onSent].", ["sendInLocalWindow { send(text) }", "onSent()"]);
  const BRANCH = file([], "Sends the trimmed draft.", ["val trimmed = text.trim()", "send(trimmed)"]);

  function conflictedRepo() {
    const dir = mkdtempSync(join(tmpdir(), "merge-handoff-"));
    git(dir, "init -q -b main");
    writeFileSync(join(dir, "Composer.kt"), BASE);
    git(dir, "add -A");
    git(dir, "commit -q -m base");
    git(dir, "checkout -q -b feature/1355");
    writeFileSync(join(dir, "Composer.kt"), BRANCH);
    git(dir, "commit -q -am trim");
    git(dir, "checkout -q main");
    writeFileSync(join(dir, "Composer.kt"), MAIN);
    git(dir, "commit -q -am window");
    git(dir, "checkout -q feature/1355");
    assert.throws(() => git(dir, "-c merge.conflictStyle=diff3 merge main --no-edit"), "the fixture must conflict");
    const pending = readPendingMerge(dir, deps);
    assert.ok(pending, "a stopped merge must be readable");
    assert.deepEqual(pending.mainConflictLines, {
      "Composer.kt": ["/** Sends the draft, then calls [onSent]. */", "sendInLocalWindow { send(text) }", "onSent()"],
    });
    return { dir, pending };
  }

  const commitResolution = (dir: string, text: string) => {
    writeFileSync(join(dir, "Composer.kt"), text);
    git(dir, "commit -q -am merge --no-edit");
  };

  test("rewriting main's lines inside the conflicts passes, with a note naming them", () => {
    const { dir, pending } = conflictedRepo();
    try {
      commitResolution(dir, file(
        ["import chat.sendInLocalWindow"],
        "Calls [onSent] first, then sends the trimmed draft.",
        ["val trimmed = text.trim()", "onSent()", "sendInLocalWindow { send(trimmed) }"],
      ));
      const merge = git(dir, "rev-parse HEAD").trim();
      writeFileSync(join(dir, "Later.kt"), "val later = 1\n");
      git(dir, "add -A");
      git(dir, "commit -q -m later");
      assert.deepEqual(checkMergeResolution(dir, pending, deps), {
        problems: [],
        notes: [{ path: "Composer.kt", lines: ["/** Sends the draft, then calls [onSent]. */", "sendInLocalWindow { send(text) }"] }],
      });
      assert.equal(findMergeCommit(dir, pending, deps), merge, "the note names the merge, not a later commit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dropping main's line inside a conflict passes, with a note naming it", () => {
    const { dir, pending } = conflictedRepo();
    try {
      commitResolution(dir, file(["import chat.sendInLocalWindow"], "Sends the draft, then calls [onSent].", ["sendInLocalWindow { send(text) }"]));
      assert.deepEqual(checkMergeResolution(dir, pending, deps), {
        problems: [],
        notes: [{ path: "Composer.kt", lines: ["onSent()"] }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("taking the branch's whole file is still refused for main's import outside the conflicts", () => {
    const { dir, pending } = conflictedRepo();
    try {
      commitResolution(dir, BRANCH);
      const { problems } = checkMergeResolution(dir, pending, deps);
      assert.deepEqual(problems, ["`Composer.kt` lost 1 line(s) main added outside the conflict blocks: `import chat.sendInLocalWindow`."]);
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

  test("one line carrying both sides' changes passes with nothing to review", () => {
    const { dir, pending } = conflictedRepo();
    try {
      writeFileSync(join(dir, "Module.kt"), file("thread(handle, viewing, reader)"));
      git(dir, "commit -q -am merge --no-edit");
      assert.deepEqual(checkMergeResolution(dir, pending, deps), { problems: [], notes: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeping only the branch's version of the line passes, with main's line noted for review", () => {
    // Refused until 2026-10-02. Main's line sat inside the conflict, so
    // dropping it is the resolver's judgement: the review stages see it
    // rather than a human unparking the ticket (#1355).
    const { dir, pending } = conflictedRepo();
    try {
      writeFileSync(join(dir, "Module.kt"), BRANCH);
      git(dir, "commit -q -am merge --no-edit");
      assert.deepEqual(checkMergeResolution(dir, pending, deps), {
        problems: [],
        notes: [{ path: "Module.kt", lines: ["val t = thread(handle, viewing)"] }],
      });
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
        assert.deepEqual(checkMergeResolution(dir, pending, deps), { problems: [], notes: [] });
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
      // `val a = 3` sat inside the conflict, but deleting the file settled
      // no conflict, so it still parks.
      const { problems, notes } = checkMergeResolution(dir, pending, deps);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /`A\.kt` lost 1 line\(s\) main added: `val a = 3`/);
      assert.deepEqual(notes, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
