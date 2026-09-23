import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveImportOnlyConflicts, resolveImportOnlyMerge } from "./merge-resolve.js";

const file = (...lines: string[]) => lines.join("\n") + "\n";

describe("resolveImportOnlyConflicts — keep both sides' added imports, park anything else (2026-09-23)", () => {
  test("Mobile #803 shape: each side added one import at the same slot → both kept, sorted", () => {
    const text = file(
      "package de.pyryco.mobile.ui.conversations.thread",
      "",
      "import de.pyryco.mobile.data.repository.QueuedMessage",
      "<<<<<<< HEAD",
      "import de.pyryco.mobile.data.repository.ThinkingProgress",
      "||||||| 5c02b67",
      "=======",
      "import de.pyryco.mobile.data.repository.SessionSettings",
      ">>>>>>> main",
      "import de.pyryco.mobile.data.repository.ThreadItem",
      "",
      "class ThreadViewModel",
    );
    assert.equal(resolveImportOnlyConflicts(text), file(
      "package de.pyryco.mobile.ui.conversations.thread",
      "",
      "import de.pyryco.mobile.data.repository.QueuedMessage",
      "import de.pyryco.mobile.data.repository.SessionSettings",
      "import de.pyryco.mobile.data.repository.ThinkingProgress",
      "import de.pyryco.mobile.data.repository.ThreadItem",
      "",
      "class ThreadViewModel",
    ));
  });

  test("several hunks, several lines per side, and an import both sides added", () => {
    const text = file(
      "import a.A",
      "<<<<<<< HEAD",
      "import a.B",
      "import a.D",
      "||||||| base",
      "=======",
      "import a.C",
      "import a.D",
      ">>>>>>> main",
      "import a.E",
      "import b.A",
      "<<<<<<< HEAD",
      "import b.B",
      "||||||| base",
      "=======",
      "import b.C as Cee",
      ">>>>>>> main",
    );
    assert.equal(resolveImportOnlyConflicts(text), file(
      "import a.A", "import a.B", "import a.C", "import a.D", "import a.E",
      "import b.A", "import b.B", "import b.C as Cee",
    ));
  });

  test("a side that removed or rewrote an import (non-empty base) → null", () => {
    const text = file(
      "<<<<<<< HEAD",
      "import a.B",
      "||||||| base",
      "import a.Old",
      "=======",
      "import a.C",
      ">>>>>>> main",
    );
    assert.equal(resolveImportOnlyConflicts(text), null);
  });

  test("any non-import line in a hunk, a blank line included → null", () => {
    for (const extra of ["val x = 1", "", "import static a.b.C.d;", "import { A } from \"./a\";"]) {
      const text = file("<<<<<<< HEAD", "import a.B", extra, "||||||| base", "=======", "import a.C", ">>>>>>> main");
      assert.equal(resolveImportOnlyConflicts(text), null, `line ${JSON.stringify(extra)} must park`);
    }
  });

  test("one good hunk does not rescue a bad one in the same file → null", () => {
    const text = file(
      "<<<<<<< HEAD", "import a.B", "||||||| base", "=======", "import a.C", ">>>>>>> main",
      "fun f() {",
      "<<<<<<< HEAD", "    one()", "||||||| base", "=======", "    two()", ">>>>>>> main",
      "}",
    );
    assert.equal(resolveImportOnlyConflicts(text), null);
  });

  test("two-way markers (no base section) cannot show the base was empty → null", () => {
    const text = file("<<<<<<< HEAD", "import a.B", "=======", "import a.C", ">>>>>>> main");
    assert.equal(resolveImportOnlyConflicts(text), null);
  });

  test("an order that is not plain string order around the hunk → null", () => {
    // ktlint's default puts kotlin.* after everything else, so the slot
    // between org.z and kotlin.a is not in plain string order.
    const grouped = file(
      "import org.z.Last",
      "<<<<<<< HEAD", "import org.zz.Mine", "||||||| base", "=======", "import kotlin.Unit", ">>>>>>> main",
      "import kotlin.a.First",
    );
    assert.equal(resolveImportOnlyConflicts(grouped), null);
    const unsortedSide = file("<<<<<<< HEAD", "import a.D", "import a.B", "||||||| base", "=======", "import a.C", ">>>>>>> main");
    assert.equal(resolveImportOnlyConflicts(unsortedSide), null);
    const duplicatesNeighbour = file("import a.B", "<<<<<<< HEAD", "import a.B", "||||||| base", "=======", "import a.C", ">>>>>>> main");
    assert.equal(resolveImportOnlyConflicts(duplicatesNeighbour), null);
  });

  test("no conflict, or an unterminated or stray marker → null", () => {
    assert.equal(resolveImportOnlyConflicts(file("import a.B")), null);
    assert.equal(resolveImportOnlyConflicts(file("<<<<<<< HEAD", "import a.B", "||||||| base", "=======", "import a.C")), null);
    assert.equal(resolveImportOnlyConflicts(file("import a.B", "=======", "import a.C")), null);
  });

  test("CRLF files resolve with their line endings kept", () => {
    const text = ["import a.A", "<<<<<<< HEAD", "import a.B", "||||||| base", "=======", "import a.C", ">>>>>>> main", "import a.D", ""].join("\r\n");
    assert.equal(resolveImportOnlyConflicts(text), ["import a.A", "import a.B", "import a.C", "import a.D", ""].join("\r\n"));
  });
});

describe("resolveImportOnlyMerge — against a real git merge", () => {
  const dirs: string[] = [];
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  // A repo where `main` and `feature` each changed Thread.kt from the same
  // base; returns the repo after `git merge main` has stopped on the conflict.
  function conflictedRepo(baseBody: string, mainBody: string, featureBody: string): string {
    const dir = mkdtempSync(join(tmpdir(), "merge-resolve-"));
    dirs.push(dir);
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: "pipe", encoding: "utf-8" });
    const write = (body: string) => writeFileSync(join(dir, "Thread.kt"), body);
    git("init -q -b main");
    git("config user.name test");
    git("config user.email test@example.com");
    git("config commit.gpgsign false");
    write(baseBody); git("add ."); git("commit -q -m base");
    git("switch -q -c feature");
    write(featureBody); git("commit -q -am feature");
    git("switch -q main");
    write(mainBody); git("commit -q -am main");
    git("switch -q feature");
    assert.throws(() => git("-c merge.conflictStyle=diff3 merge main --no-edit"), "fixture must conflict");
    return dir;
  }

  const deps = { execSync, readFileSync, writeFileSync };

  test("import-only conflict → resolved, committed as a two-parent merge, tree clean", () => {
    // The code edits sit apart, so git merges them itself and the only
    // conflict left is the import slot.
    const body = (imports: string[], a: string, d: string) =>
      file("package p", "", ...imports, "", "class Thread {", `  val a = ${a}`, "  val b = 2", "  val c = 3", `  val d = ${d}`, "}");
    const dir = conflictedRepo(
      body(["import a.A", "import a.Z"], "1", "4"),
      body(["import a.A", "import a.Main", "import a.Z"], "Main", "4"),
      body(["import a.A", "import a.Feature", "import a.Z"], "1", "Feature"),
    );

    assert.deepEqual(resolveImportOnlyMerge(dir, deps), ["Thread.kt"]);

    assert.equal(
      readFileSync(join(dir, "Thread.kt"), "utf-8"),
      body(["import a.A", "import a.Feature", "import a.Main", "import a.Z"], "Main", "Feature"),
    );
    assert.equal(execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" }), "");
    assert.equal(execSync("git rev-list --parents -n 1 HEAD", { cwd: dir, encoding: "utf-8" }).trim().split(" ").length, 3);
  });

  test("code conflict → null, nothing written, merge left for the caller to abort", () => {
    const dir = conflictedRepo(
      file("import a.A", "", "val x = 0"),
      file("import a.A", "", "val x = 1"),
      file("import a.A", "", "val x = 2"),
    );
    const before = readFileSync(join(dir, "Thread.kt"), "utf-8");

    assert.equal(resolveImportOnlyMerge(dir, deps), null);

    assert.equal(readFileSync(join(dir, "Thread.kt"), "utf-8"), before);
    assert.match(execSync("git status --porcelain", { cwd: dir, encoding: "utf-8" }), /^UU Thread\.kt/m);
  });
});
