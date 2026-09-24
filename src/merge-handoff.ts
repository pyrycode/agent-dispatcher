// Hands a merge conflict the dispatcher cannot settle to the agent that owns
// the ticket's code, and checks that agent's resolution before anything is
// pushed.
//
// Why this exists. The dispatcher merges the default branch into a ticket's
// worktree before every agent run. Until 2026-09-23 any conflict it could
// not settle itself (merge-resolve.ts handles import-only ones) parked the
// ticket with `error:<agent>` for a human. Mobile hit four of those in two
// days: #802 (siblings split from one parent), #803 and #823 (imports added
// at the same slot) and #808 (two builders starting in the same minute, so
// neither overlap check saw the other). Each was minutes of work, and each
// came from a different cause. Prevention covers one cause at a time;
// resolution covers all of them.
//
// Who resolves. The code owner is the agent owning the real-claude gate's
// fail column (developer in classic, builder in builder), the same agent a
// failing e2e run goes back to.
//   - The owner's own run keeps the conflicted merge in its worktree and is
//     told, in its prompt, to finish it first.
//   - A later stage aborts the merge and sends the ticket back to the owner.
//     That route is not a rework, since nothing was wrong with the ticket, so
//     it carries MERGE_HANDOFF_LABEL and the router does not count it. The
//     owner's commit then walks the review stages again.
//   - An earlier stage (refinement, architecture) still parks: routing the
//     ticket forward would skip that stage's own work.
//
// The hard check. An agent resolving a conflict can drop the other side's
// change and still build. When the owner's run ends, the merge must be
// committed with main inside it, no conflict markers may remain in the
// conflicted files, and every non-blank line main added to those files since
// the merge base must still be in them. Lines compare trimmed, because a
// resolution may re-indent main's lines under new code (#808 wrapped the
// block #805 had just edited). Failing any of these parks the ticket with
// nothing pushed and the worktree kept.
//
// Two resolutions drop main's lines correctly, and the check lets them pass.
// Both key on what the branch had already done before the merge, so a
// resolver cannot invent either one.
//   - The branch had deleted the file, and the result keeps it deleted.
//     Mobile #883 retired a screen and its tests while main moved those
//     tests to a new folder.
//   - Both sides edited the same line, and one result line holds both
//     edits: main's line and a vanished branch line appear in it, token by
//     token, in order. Mobile #932 added an argument to the same call main
//     had just added one to.

import type { execSync as ExecSync } from "node:child_process";
import type { readFileSync as ReadFileSync } from "node:fs";
import type { AgentConfig } from "./types.js";

/** Marks a `needs-rework:<owner>` route that exists only to finish a merge,
 *  so the rework router moves the ticket without counting a rework. */
export const MERGE_HANDOFF_LABEL = "merge-handoff";

export type ConflictRoute =
  /** This agent owns the code: finish the merge in this run. */
  | { kind: "resolve" }
  /** A later stage: send the ticket back to the owner. */
  | { kind: "route"; owner: string }
  /** An earlier stage, or an agent this set does not run: a human decides. */
  | { kind: "park" };

/**
 * Decide who settles a conflict found before `agentName`'s run. `agents` is
 * the stage set's board order, Backlog side first; the owner is the agent
 * owning `ownerColumn`.
 */
export function decideConflictRoute(
  agents: readonly AgentConfig[],
  agentName: string,
  ownerColumn: string,
): ConflictRoute {
  const ownerIdx = agents.findIndex((a) => a.column === ownerColumn);
  const selfIdx = agents.findIndex((a) => a.name === agentName);
  if (ownerIdx < 0 || selfIdx < 0) return { kind: "park" };
  if (selfIdx === ownerIdx) return { kind: "resolve" };
  if (selfIdx > ownerIdx) return { kind: "route", owner: agents[ownerIdx]!.name };
  return { kind: "park" };
}

/** A merge left in progress for the owner's run, and what the check needs. */
export type PendingMerge = {
  /** Files git left conflicted, relative to the worktree. */
  paths: string[];
  /** The commit being merged in: the default branch's tip at merge time. */
  mainSha: string;
  /** The merge base, so the check knows what main added. */
  baseSha: string;
  /** The branch tip the merge started from, so the check knows what the ticket changed. */
  headSha: string;
};

export type MergeHandoffDeps = {
  execSync: typeof ExecSync;
  readFileSync: typeof ReadFileSync;
};

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const run = (deps: MergeHandoffDeps, cmd: string, cwd: string) =>
  String(deps.execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" })).trim();

/**
 * Read a stopped merge's conflicted files, the commit being merged and the
 * merge base. Returns null when any of them cannot be read, so the caller
 * falls back to parking.
 */
export function readPendingMerge(cwd: string, deps: MergeHandoffDeps): PendingMerge | null {
  try {
    const paths = run(deps, `git diff --name-only --diff-filter=U -z`, cwd).split("\0").filter(Boolean);
    const mainSha = run(deps, `git rev-parse MERGE_HEAD`, cwd);
    const baseSha = run(deps, `git merge-base HEAD MERGE_HEAD`, cwd);
    const headSha = run(deps, `git rev-parse HEAD`, cwd);
    if (paths.length === 0 || !mainSha || !baseSha || !headSha) return null;
    return { paths, mainSha, baseSha, headSha };
  } catch (e) {
    console.warn(`   ⚠️  Could not read the stopped merge, leaving it to a human: ${e}`);
    return null;
  }
}

/** The non-blank lines a unified diff adds, trimmed. */
export function addedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1).trim())
    .filter((l) => l !== "");
}

/** Only the outer markers: a line of seven `=` can be ordinary Markdown. */
export function hasConflictMarkers(text: string): boolean {
  return text.split("\n").some((l) => /^(<{7}|>{7})(?: |\r?$)/.test(l));
}

/** The lines of `required` that `text` no longer holds, compared trimmed. */
export function missingLines(required: readonly string[], text: string): string[] {
  const present = new Set(text.split("\n").map((l) => l.trim()));
  return [...new Set(required)].filter((l) => !present.has(l));
}

const tokens = (line: string) => line.match(/\w+|[^\s\w]/g) ?? [];

/** Whether every token of `part` appears in `whole`, in order. */
function tokensWithin(part: readonly string[], whole: readonly string[]): boolean {
  let i = 0;
  for (const t of whole) if (i < part.length && t === part[i]) i++;
  return i === part.length;
}

/**
 * The lines of `missing` that no line of `text` holds in combination with a
 * vanished branch line: one of `branchAdded` that `text` no longer holds
 * either. What remains was lost, not merged.
 */
export function uncombinedLines(missing: readonly string[], branchAdded: readonly string[], text: string): string[] {
  const lines = text.split("\n").map((l) => l.trim());
  const present = new Set(lines);
  const vanished = branchAdded.filter((l) => !present.has(l)).map(tokens);
  if (vanished.length === 0) return [...missing];
  const merged = lines.map(tokens).filter((r) => vanished.some((v) => tokensWithin(v, r)));
  return missing.filter((m) => !merged.some((r) => tokensWithin(tokens(m), r)));
}

/** A file's content at `rev`, or null when the file does not exist there. */
function fileAt(deps: MergeHandoffDeps, cwd: string, rev: string, path: string): string | null {
  try {
    return run(deps, `git show ${rev}:${shellQuote(path)}`, cwd);
  } catch {
    return null;
  }
}

const MAX_LINES_SHOWN = 5;

/**
 * Check the owner's resolution of `pending` in `cwd`. Returns the problems
 * found, one line each; an empty list means the merge is safe to push.
 */
export function checkMergeResolution(cwd: string, pending: PendingMerge, deps: MergeHandoffDeps): string[] {
  let inProgress = true;
  try {
    run(deps, `git rev-parse -q --verify MERGE_HEAD`, cwd);
  } catch {
    inProgress = false;
  }
  if (inProgress) return ["The merge was never committed: git still has it in progress."];

  const problems: string[] = [];
  try {
    run(deps, `git merge-base --is-ancestor ${pending.mainSha} HEAD`, cwd);
  } catch {
    problems.push(`The branch no longer contains \`${pending.mainSha.slice(0, 7)}\`, the main commit that was merged.`);
  }

  for (const path of pending.paths) {
    const result = fileAt(deps, cwd, "HEAD", path);
    // The branch had deleted this file before the merge, and it stays deleted.
    if (result === null && fileAt(deps, cwd, pending.headSha, path) === null) continue;
    const text = result ?? "";
    if (hasConflictMarkers(text)) {
      problems.push(`\`${path}\` still has conflict markers.`);
      continue;
    }
    let diff: string;
    try {
      diff = run(deps, `git diff -U0 ${pending.baseSha} ${pending.mainSha} -- ${shellQuote(path)}`, cwd);
    } catch (e) {
      problems.push(`Could not read what main changed in \`${path}\`: ${e}`);
      continue;
    }
    let missing = missingLines(addedLines(diff), text);
    if (missing.length > 0) {
      try {
        const branchDiff = run(deps, `git diff -U0 ${pending.baseSha} ${pending.headSha} -- ${shellQuote(path)}`, cwd);
        missing = uncombinedLines(missing, addedLines(branchDiff), text);
      } catch {}
    }
    if (missing.length > 0) {
      const shown = missing.slice(0, MAX_LINES_SHOWN).map((l) => `\`${l}\``).join(", ");
      const more = missing.length > MAX_LINES_SHOWN ? `, and ${missing.length - MAX_LINES_SHOWN} more` : "";
      problems.push(`\`${path}\` lost ${missing.length} line(s) main added: ${shown}${more}.`);
    }
  }
  return problems;
}

/** The note appended to the owner's prompt when a merge is left for it. */
export function mergeHandoffNote(defaultBranch: string, paths: readonly string[]): string {
  return [
    "",
    "",
    `## Finish the merge of \`${defaultBranch}\` first`,
    "",
    `Before this run the dispatcher merged \`${defaultBranch}\` into this branch, and it conflicted in:`,
    "",
    ...paths.map((p) => `- \`${p}\``),
    "",
    "The merge is still in progress in your working tree. Settle it before anything else:",
    "",
    `1. Resolve every conflict so both sides' changes survive. \`${defaultBranch}\`'s side is already reviewed and merged, so keep every line it added and fit this ticket's code around them. Re-indenting one of its lines is fine, and so is one line carrying both sides' edits when both changed the same line. Dropping or rewriting one of its lines is not. A file this ticket had already deleted may stay deleted.`,
    "2. Build, and run the tests that cover the conflicted files.",
    "3. Commit with `git commit --no-edit`.",
    "",
    "If the ticket's latest dispatcher comment says it was sent back only for this merge, stop after the commit and finish as usual. Skip the file-overlap check and the plan: the ticket's code is already written and reviewed, and the review stages run again after you.",
    "",
    `When your run ends the dispatcher checks that the merge is committed, that no conflict markers remain in those files, and that every line \`${defaultBranch}\` added to them is still there. If any check fails, the ticket parks for a human and nothing is pushed.`,
  ].join("\n");
}
