// Settles the one merge-conflict shape that is safe without a human: both
// sides only ADDED import lines at the same spot.
//
// Why this exists. Tickets built in parallel append imports at the same
// alphabetical slot, so whichever merges second conflicts when the
// dispatcher merges the default branch into its worktree, and parks with
// `error:<agent>`. Mobile #802 (verifier), #803 and #823 (documentation)
// parked this way on 2026-09-22; #803 and #823 were import-only, and the
// hand resolution was always "keep both, in order".
//
// What counts as import-only, and why each rule:
//   - diff3 markers with an EMPTY common-ancestor section. An empty base
//     means neither side removed or rewrote an import, so keeping both
//     loses nothing. A non-empty base (one side dropped an unused import,
//     the other renamed one) needs judgement and parks as before.
//   - every added line is a single-line `import a.b.C` (Kotlin / Java
//     shape, optional `as X`, optional `;`). Anything else, a blank line
//     included, parks.
//   - each side's lines are already in plain string order, and the merged
//     block still sorts between its neighbouring imports. When that holds
//     the file's local order is plain string order, so sorting the union
//     keeps the linter's import order. Otherwise it parks.
// One file or hunk that fails any rule leaves the whole merge to a human.

import type { execSync as ExecSync } from "node:child_process";
import type { readFileSync as ReadFileSync, writeFileSync as WriteFileSync } from "node:fs";
import { resolve } from "node:path";

const OURS = /^<{7}(?: |\r?$)/;
const BASE = /^\|{7}(?: |\r?$)/;
const SPLIT = /^={7}\r?$/;
const THEIRS = /^>{7}(?: |\r?$)/;
const IMPORT_LINE = /^import [\w.]+(?:\.\*)?(?: as \w+)?;?\r?$/;

const isMarker = (line: string) =>
  OURS.test(line) || BASE.test(line) || SPLIT.test(line) || THEIRS.test(line);
const isSorted = (lines: string[]) => lines.every((l, k) => k === 0 || lines[k - 1]! < l);

/**
 * Resolve every conflict hunk in `text` by keeping both sides' imports in
 * sorted order. Returns the resolved file, or null when the file has no
 * hunks or any hunk is not import-only (see the file header). Expects
 * diff3 markers; plain two-way markers return null because they cannot
 * show whether the base was empty.
 */
export function resolveImportOnlyConflicts(text: string): string | null {
  const lines = text.split("\n");
  const out: string[] = [];
  let hunks = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!OURS.test(line)) {
      if (isMarker(line)) return null;
      out.push(line);
      continue;
    }

    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let section = ours;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (section === ours && BASE.test(l)) section = base;
      else if (section === base && SPLIT.test(l)) section = theirs;
      else if (section === theirs && THEIRS.test(l)) { end = j; break; }
      else if (isMarker(l)) return null;
      else section.push(l);
    }
    if (end === -1 || base.length > 0) return null;

    const added = [...new Set([...ours, ...theirs])];
    if (added.length === 0 || !added.every(l => IMPORT_LINE.test(l))) return null;
    if (!isSorted(ours) || !isSorted(theirs)) return null;
    added.sort();

    const before = out[out.length - 1];
    const after = lines[end + 1];
    if (before !== undefined && IMPORT_LINE.test(before) && before >= added[0]!) return null;
    if (after !== undefined && IMPORT_LINE.test(after) && after <= added[added.length - 1]!) return null;

    out.push(...added);
    i = end;
    hunks++;
  }

  return hunks > 0 ? out.join("\n") : null;
}

export type MergeResolveDeps = {
  execSync: typeof ExecSync;
  readFileSync: typeof ReadFileSync;
  writeFileSync: typeof WriteFileSync;
};

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * After a `git merge` in `cwd` stopped on conflicts (run with
 * `merge.conflictStyle=diff3`), resolve and commit it when every conflicted
 * file is import-only. Returns the resolved paths, or null when the merge
 * still needs a human. Writes nothing unless every file resolves; if the
 * commit itself fails, returns null and the caller's `git merge --abort`
 * restores the tree.
 */
export function resolveImportOnlyMerge(cwd: string, deps: MergeResolveDeps): string[] | null {
  try {
    const listed = deps.execSync(`git diff --name-only --diff-filter=U -z`, { cwd, encoding: "utf-8", stdio: "pipe" });
    const paths = String(listed).split("\0").filter(Boolean);
    if (paths.length === 0) return null;

    const resolved: [string, string][] = [];
    for (const path of paths) {
      const text = resolveImportOnlyConflicts(String(deps.readFileSync(resolve(cwd, path), "utf-8")));
      if (text === null) return null;
      resolved.push([path, text]);
    }

    for (const [path, text] of resolved) deps.writeFileSync(resolve(cwd, path), text);
    deps.execSync(`git add -- ${paths.map(shellQuote).join(" ")}`, { cwd, stdio: "pipe" });
    deps.execSync(`git commit --no-edit`, { cwd, stdio: "pipe" });
    return paths;
  } catch (e) {
    console.warn(`   ⚠️  Import-only conflict resolution failed, leaving the merge to a human: ${e}`);
    return null;
  }
}
