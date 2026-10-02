// Worktree, branch setup, codegraph symlink, and path resolution helpers.
//
// All pure: parses git output, makes decisions; the caller does the I/O
// (git invocations, fs.symlinkSync, fs.existsSync, etc).
//
// Split from lib.ts on 2026-05-09 — see "Pyrycode dispatcher refactor"
// in OPEN-QUESTIONS.

import { resolve } from "node:path";

// --------- Auto-commit safety net ---------

/**
 * True if the worktree has uncommitted changes that the dispatcher should
 * auto-commit before pushing. Catches agents that wrote files but forgot
 * to commit (the bug that destroyed #27's spec via `git worktree remove
 * --force`).
 *
 * Input is the raw output of `git status --porcelain`. Whitespace-only
 * output is treated as clean — guards against false positives from
 * trailing newlines or shell padding.
 */
export function shouldAutoCommit(gitStatusOutput: string): boolean {
  return gitStatusOutput.trim().length > 0;
}

// --------- Codegraph worktree integration ---------

/**
 * The decision shape returned by `decideCodegraphSymlink`. The caller
 * applies the side effect (symlinkSync) and the log line based on the
 * `action` and `reason`.
 *
 * - `symlink` + `ready`: caller should `symlinkSync(source, dest)`
 * - `skip` + `already-present`: dst exists; do nothing, don't warn
 * - `skip` + `no-source`: source index missing; warn so operator
 *   bootstraps via `codegraph init -i` in the canonical repo
 */
export interface CodegraphSymlinkDecision {
  action: "symlink" | "skip";
  reason: "ready" | "already-present" | "no-source";
}

/**
 * Decide whether to symlink the canonical repo's `.codegraph/` index
 * into a freshly created worktree.
 *
 * **Why a symlink at all:** the dispatcher creates a worktree per
 * dispatched ticket (`.pyrycode-worktrees/<repo>/<agent>-<n>/`).
 * Each worktree is a fresh checkout — `git worktree add` does not
 * carry untracked files into the new tree, and `.codegraph/` is
 * gitignored. An agent spawned in the worktree with codegraph in its
 * `allowedTools` would launch the codegraph MCP server with cwd =
 * worktree dir, find no `.codegraph/`, and return empty results for
 * every query. The agent then silently falls back to grep, paying
 * for the codegraph tool surface in tokens without getting any of
 * the value.
 *
 * **Soft-fail on no-source:** if the canonical repo hasn't been
 * indexed yet, we don't fail the dispatch. Agents still run; they
 * just lose codegraph for that ticket. The warning surfaces the
 * setup gap so the operator knows to run `codegraph init -i`.
 *
 * **Idempotent:** if the destination already exists (previous run
 * left a symlink, or an operator dropped a real dir there), leave
 * it alone. Re-creating would either be a no-op or destroy
 * intentional state.
 *
 * Pure decision; the caller (in dispatch.ts) does the `existsSync`
 * checks, the `symlinkSync` call, and the log/warn output.
 */
export function decideCodegraphSymlink(opts: {
  sourceExists: boolean;
  destExists: boolean;
}): CodegraphSymlinkDecision {
  if (opts.destExists) {
    return { action: "skip", reason: "already-present" };
  }
  if (!opts.sourceExists) {
    return { action: "skip", reason: "no-source" };
  }
  return { action: "symlink", reason: "ready" };
}

// --------- Worktree branch setup ---------

/**
 * Decide what to do with a feature branch before creating its worktree.
 *
 * The dispatcher's earlier behaviour was: if the local ref already exists
 * (from a prior dispatch), reuse it AS-IS. That breaks when someone pushes
 * to `origin/<branch>` out-of-band between dispatches (e.g., manual triage
 * worktree, hot-fix). Local stayed stale, worktree got the old commit, the
 * agent ran on out-of-date code. Surfaced 2026-05-07 (#155 code-review).
 *
 * Origin is the source of truth: if local is behind, fast-forward; if
 * local has commits not in origin, that's an integrity error (a prior
 * dispatch failed to push and we never noticed) and requires human triage.
 */
export type BranchSetupAction =
  /** Neither local nor remote exists. Create local from `main`. */
  | "create-from-main"
  /** Only remote exists. Create local from `origin/<branch>`. */
  | "create-from-origin"
  /** Local exists but no remote. Reuse local; first push will create origin. */
  | "reuse-local-no-remote"
  /** Both exist and local SHA == origin SHA. Reuse local (no-op sync). */
  | "reuse-local-already-synced"
  /** Both exist; local is a strict ancestor of origin. Fast-forward local. */
  | "fast-forward-from-origin"
  /** Both exist; origin is a strict ancestor of local. Local carries real
   *  commits not yet on origin (a prior dispatch committed but failed to
   *  push). Pushing the missing commits is the likely fix, so the operator
   *  advice can safely say "push". Abort for human triage. */
  | "abort-local-strictly-ahead"
  /** Both exist; local and origin have diverged (neither is an ancestor of
   *  the other). Origin was advanced out-of-band while local held its own
   *  commits. Pushing local would REVERT origin's work, so the advice must
   *  point at origin as the source of truth, not at pushing local. Also the
   *  cautious default when the ancestry flags are missing. Abort. */
  | "abort-local-diverged";

export function decideBranchSetup(opts: {
  localExists: boolean;
  remoteExists: boolean;
  /** True iff local SHA equals origin SHA. Required when both exist. */
  localEqualsOrigin?: boolean;
  /** True iff local is a strict ancestor of origin (fast-forwardable).
   *  Required when both exist and SHAs differ. */
  localIsAncestorOfOrigin?: boolean;
  /** True iff origin is a strict ancestor of local (local strictly ahead).
   *  Distinguishes "real unpushed work" (advise push) from a genuine
   *  divergence (advise reset to origin). Required when both exist, SHAs
   *  differ, and local is not behind origin. */
  originIsAncestorOfLocal?: boolean;
}): BranchSetupAction {
  if (!opts.localExists && !opts.remoteExists) return "create-from-main";
  if (!opts.localExists) return "create-from-origin";
  if (!opts.remoteExists) return "reuse-local-no-remote";
  if (opts.localEqualsOrigin) return "reuse-local-already-synced";
  if (opts.localIsAncestorOfOrigin) return "fast-forward-from-origin";
  if (opts.originIsAncestorOfLocal) return "abort-local-strictly-ahead";
  return "abort-local-diverged";
}

/**
 * Decide whether to push the pre-run merge of the default branch into the
 * feature branch as soon as it is committed, instead of only when the run
 * ends.
 *
 * Before every agent run the dispatcher merges the default branch into
 * `feature/<n>` inside the worktree. That merge used to reach origin only
 * with the end-of-run push, so a run that died in between (a crash, a kill)
 * stranded the merge commit locally, and the next dispatch refused with
 * `abort-local-strictly-ahead` ("a prior dispatch committed work but failed
 * to push"). Three of the last four such errors were the dispatcher's own
 * merge: pyrycode-mobile #1340 on 2026-10-02 (the verifier crashed after the
 * merge), #1250 and #680 before it.
 *
 * Push only when:
 *  - the branch already exists on origin. A fresh ticket's branch is first
 *    created on origin by the end-of-run push, as before, not by this one.
 *  - HEAD moved, so the merge made a commit (or fast-forwarded). A no-op
 *    merge has nothing to push.
 *  - both HEAD readings are known. When either could not be read, leave it
 *    to the end-of-run push.
 *
 * Pure decision; the caller reads HEAD before and after the merge and runs
 * the push.
 */
export function shouldPushPreRunMerge(opts: {
  remoteExists: boolean;
  headBefore: string;
  headAfter: string;
}): boolean {
  if (!opts.remoteExists) return false;
  if (opts.headBefore === "" || opts.headAfter === "") return false;
  return opts.headBefore !== opts.headAfter;
}

// --------- Worktree introspection ---------

/**
 * Parse `git worktree list --porcelain` output and return the worktree
 * directories (if any) currently checked out at the given branch.
 *
 * `git worktree add <path> <branch>` fails with "fatal: '<branch>' is already
 * checked out at '<other-path>'" when the branch is in use elsewhere — even
 * if `<path>` is fresh. The dispatcher's stale-worktree cleanup at the start
 * of `dispatchToAgent` only handles the same-path case (`worktreeDir`); it
 * misses orphan worktrees on the same branch under different paths (a prior
 * cycle's `architect-100` left over when this cycle wants `developer-100`).
 *
 * Surfaced 2026-05-08 review (#5). The orphan blocks all future dispatches
 * on the affected branch with `error:<agent>`, indefinitely, until a human
 * runs `git worktree remove --force` by hand.
 *
 * Porcelain format (one record per worktree, blank-line separated):
 *
 *     worktree /path/to/wt
 *     HEAD <sha>
 *     branch refs/heads/<branch>
 *
 * Detached HEADs surface as `detached` (no `branch` line). Bare repos as
 * `bare`. Either way we don't match (no branch to compare).
 *
 * Pure function over the porcelain string; no I/O. Tests in lib.test.ts.
 */
export function findWorktreesForBranch(
  porcelainOutput: string,
  branchName: string,
): string[] {
  const target = `refs/heads/${branchName}`;
  const out: string[] = [];
  let currentPath: string | null = null;
  for (const rawLine of porcelainOutput.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      currentPath = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }
    if (line.startsWith("branch ") && currentPath !== null) {
      const branchRef = line.slice("branch ".length);
      if (branchRef === target) out.push(currentPath);
    }
  }
  return out;
}

/** A worktree on the branch that the dispatcher's cleanup could not remove. */
export interface HeldWorktree {
  path: string;
  /** git's refusal from `git worktree remove` (never run with --force). */
  error: string;
}

/**
 * Text for a dispatch-error comment naming the worktrees that still have
 * the branch checked out after the cleanup, so a human knows where to look.
 * Returns "" when there are none.
 *
 * The cleanup removes worktrees without --force, so one with uncommitted
 * changes stays and keeps blocking the branch on purpose. git's own error
 * ("cannot force update the branch ... used by worktree at ...") names the
 * path but not why the dispatcher left it there; this says so. A refusal
 * for another reason (a locked worktree) is quoted as git gave it.
 *
 * Pure function; the caller collects the refusals.
 */
export function describeHeldWorktrees(branchName: string, held: HeldWorktree[]): string {
  if (held.length === 0) return "";
  const lines = held.map(({ path, error }) =>
    /modified or untracked files/.test(error)
      ? `- \`${path}\` has uncommitted changes (modified or untracked files).`
      : `- \`${path}\` could not be removed: ${error.split("\n")[0]?.trim() || "unknown error"}`,
  );
  return `\n\n\`${branchName}\` is still checked out in a worktree the dispatcher would not remove:\n\n` +
    `${lines.join("\n")}\n\n` +
    `The dispatcher never force-removes a worktree, so nothing there was lost. Save or discard its changes, remove it, then retry.`;
}

// --------- Path resolution ---------

/**
 * Resolve the agents repo root from a source-file directory.
 *
 * The dispatch source lives at `agents/dispatch/src/`, so `../..` takes us
 * to `agents/`. Anything more would escape into the parent (the
 * `pyrycode/` Go repo) — which is what the original buggy version did
 * with `"../../.."` (commit `c72adb4` fixed it).
 */
export function resolveAgentsRepoRoot(srcDir: string): string {
  return resolve(srcDir, "../..");
}

/**
 * Resolve the agents repo root with env-var precedence over the
 * `__dirname`-based walk-up.
 *
 * Mirrors the existing `process.env.TARGET_REPO_PATH ?? resolveTargetRepoRoot()`
 * pattern (added 2026-05-09 in commit `275c8a0`). Same shape, same fallback
 * semantics — once the dispatcher source moves out of `agents/dispatch/src/`
 * and into the standalone `pyrycode/agent-dispatcher` repo, the `__dirname`
 * walk-up returns the wrong tree (the parent of `agent-dispatcher/`, not
 * the consumer's `agents/`). Consumers set `AGENTS_REPO_PATH` explicitly
 * via their `bin/pyry-start` launcher; the walk-up fallback exists only
 * as a convenience for in-repo `pnpm exec tsx src/dispatch-bin.ts`
 * invocations during the pre-split window.
 *
 * Empty string is treated as unset (a stray `AGENTS_REPO_PATH=` line in
 * .env shouldn't silently resolve to the dispatcher's CWD).
 *
 * Pure decision; the caller (`dispatch.ts` module top) reads `process.env`
 * and `__dirname` itself.
 */
export function resolveAgentsRepoRootWithEnv(opts: {
  envValue: string | undefined;
  fallbackSrcDir: string;
}): string {
  if (opts.envValue && opts.envValue.length > 0) {
    return resolve(opts.envValue);
  }
  return resolveAgentsRepoRoot(opts.fallbackSrcDir);
}

/**
 * Resolve the target repo's default branch with env-var precedence
 * over the hardcoded fallback `main`.
 *
 * Pyrycode + relay + mobile all use `main`, so the fallback covers
 * today's deployments without any .env updates. Forks targeting a
 * `master` or trunk-based variant set `TARGET_DEFAULT_BRANCH=master`
 * (or whatever) in their `.env`.
 *
 * Empty string is treated as unset (a stray `TARGET_DEFAULT_BRANCH=`
 * line in .env shouldn't silently turn into an empty branch name and
 * break every `git checkout` / `git rev-list` call downstream).
 */
export function resolveDefaultBranch(envValue: string | undefined): string {
  if (envValue && envValue.length > 0) return envValue;
  return "main";
}

/**
 * Resolve the target repo root from the agents repo root.
 *
 * `agents/` lives **inside** the target repo (gitignored there) rather
 * than as a sibling, so the target root is just the parent of agents/.
 * Works for any consumer of this dispatcher — pyrycode itself,
 * pyrycode-mobile-agents → pyrycode-mobile, pyrycode-relay-agents →
 * pyrycode-relay.
 *
 * Historical note: original code had `agentsRepoRoot + "../pyrycode"`,
 * which silently "worked" only because `agentsRepoRoot` was *also*
 * buggy and pointed at the pyrycode root. Once that bug was fixed,
 * this one surfaced — first dispatcher run after the fix tried
 * `pyrycode/pyrycode/` and ENOENT'd.
 */
export function resolveTargetRepoRoot(agentsRepoRoot: string): string {
  return resolve(agentsRepoRoot, "..");
}
