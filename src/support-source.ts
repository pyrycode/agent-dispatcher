/**
 * Supporting core source for gates that build the test daemon
 * (agent-dispatcher#327).
 *
 * Mobile gates build a daemon from the core checkout named by `PYRYCODE_SRC`.
 * Nothing kept that checkout current: on 2026-10-23 the HP, Fractal and Mac
 * copies were all two days old, and mobile #2442's review ran zero Compact
 * tests against a daemon older than core #3725.
 *
 * Before a builder or gated verifier run, the dispatcher now reads the
 * intended core revision from origin (`main`, or `PYRYCODE_SRC_REF`), fetches
 * it into the configured checkout's repository without moving any of its
 * refs or files, and checks it out in a detached worktree of its own. Only
 * that run sees the worktree, so another run's source never changes under a
 * running gate. The run's gates and agent get its path as `PYRYCODE_SRC`, and
 * the worktree is removed when the run ends.
 *
 * Any failure is reported before the gates run. There is no fallback to the
 * configured checkout, which is what made stale results look like results.
 *
 * On by default wherever `PYRYCODE_SRC` is set; `PYRY_SUPPORT_SOURCE_REFRESH=0`
 * turns it off. Forks without `PYRYCODE_SRC` are untouched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawnSync as SpawnSync } from "node:child_process";

export const SUPPORT_SOURCE_VARIABLE = "PYRYCODE_SRC";
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface SupportSource {
  variable: string;
  /** The configured checkout, whose repository holds the run's worktree. */
  base: string;
  /** What was asked for: a branch on origin, or a pinned commit. */
  ref: string;
  /** The exact commit checked out for this run. */
  revision: string;
  /** The run's own detached worktree, passed as `variable`. */
  path: string;
  /** The configured checkout had local changes. They do not reach the run. */
  baseDirty: boolean;
}

export class SupportSourceError extends Error {}

/** Whether this fork refreshes its supporting core source at all. */
export function supportSourceEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env[SUPPORT_SOURCE_VARIABLE] ?? "").trim() !== "" && env.PYRY_SUPPORT_SOURCE_REFRESH !== "0";
}

type Git = (args: string[], timeoutMs?: number) => { ok: boolean; out: string; err: string };

function gitIn(spawn: typeof SpawnSync, cwd: string): Git {
  return (args, timeoutMs = 120_000) => {
    const r = spawn("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe", timeout: timeoutMs });
    const err = r.error ? String(r.error.message ?? r.error) : String(r.stderr ?? "").trim();
    return { ok: !r.error && r.status === 0, out: String(r.stdout ?? "").trim(), err };
  };
}

/**
 * Check out the intended core revision in a fresh detached worktree. Throws
 * `SupportSourceError` with a plain reason when the configured checkout is
 * missing or not a git repository, or the revision cannot be read or
 * fetched. Never touches the configured checkout's branch, refs or files.
 */
export function prepareSupportSource(opts: {
  env: NodeJS.ProcessEnv;
  /** Names the worktree folder, e.g. `mobile-2442-verifier`. */
  label: string;
  spawnSync: typeof SpawnSync;
  /** Where run worktrees go. Defaults to the system temporary folder. */
  root?: string;
}): SupportSource {
  const variable = SUPPORT_SOURCE_VARIABLE;
  const base = (opts.env[variable] ?? "").trim();
  const ref = (opts.env.PYRYCODE_SRC_REF ?? "").trim() || "main";
  const git = gitIn(opts.spawnSync, base);

  const top = git(["rev-parse", "--show-toplevel"], 30_000);
  if (!top.ok) throw new SupportSourceError(`${variable} (${base}) is not a git checkout: ${top.err || "git rev-parse failed"}`);
  const status = git(["status", "--porcelain", "--untracked-files=no"], 60_000);
  if (!status.ok) throw new SupportSourceError(`could not read the state of ${variable} (${base}): ${status.err}`);

  // Read the revision from origin and fetch it by commit. Fetching by commit
  // with no FETCH_HEAD writes no ref, so concurrent runs and the checkout's
  // own branch are never disturbed. One retry absorbs a network blip.
  let revision = FULL_SHA.test(ref) ? ref : "";
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!revision) {
      const remote = git(["ls-remote", "--exit-code", "origin", `refs/heads/${ref}`], 60_000);
      const sha = remote.out.split(/\s+/)[0] ?? "";
      if (!remote.ok || !FULL_SHA.test(sha)) { lastError = `could not read ${ref} from origin: ${remote.err || remote.out || "no such branch"}`; continue; }
      revision = sha;
    }
    if (git(["cat-file", "-e", `${revision}^{commit}`], 30_000).ok) { lastError = ""; break; }
    const fetch = git(["fetch", "--quiet", "--no-write-fetch-head", "origin", revision], 300_000);
    if (fetch.ok && git(["cat-file", "-e", `${revision}^{commit}`], 30_000).ok) { lastError = ""; break; }
    lastError = `could not fetch ${revision} (${ref}) from origin: ${fetch.err || "the commit is still missing"}`;
  }
  if (lastError) throw new SupportSourceError(`${variable} (${base}): ${lastError}`);

  const safeLabel = opts.label.replace(/[^A-Za-z0-9._-]+/g, "-");
  const path = mkdtempSync(join(opts.root ?? tmpdir(), `pyry-core-${safeLabel}-`));
  const add = git(["worktree", "add", "--detach", path, revision], 300_000);
  const head = add.ok ? gitIn(opts.spawnSync, path)(["rev-parse", "HEAD"], 30_000) : null;
  if (!add.ok || head?.out !== revision) {
    removeSupportSource({ base, path }, opts.spawnSync);
    throw new SupportSourceError(`could not check out ${revision} from ${variable} (${base}): ${add.err || `HEAD is ${head?.out}`}`);
  }
  return { variable, base, ref, revision, path, baseDirty: status.out !== "" };
}

/** Remove a run's worktree. Never throws: cleanup must not fail a run. */
export function removeSupportSource(source: Pick<SupportSource, "base" | "path">, spawn: typeof SpawnSync): void {
  const git = gitIn(spawn, source.base);
  // --force: the gate's build output is untracked in this throwaway tree.
  if (!git(["worktree", "remove", "--force", source.path]).ok) {
    try { rmSync(source.path, { recursive: true, force: true }); } catch {}
    git(["worktree", "prune"]);
  }
}

/** The variable a run's gates and agent get, or nothing. */
export function supportSourceEnv(source: SupportSource | undefined): Record<string, string> {
  return source ? { [source.variable]: source.path } : {};
}

/** One line for logs and gate evidence. */
export function describeSupportSource(source: SupportSource): string {
  const pinned = FULL_SHA.test(source.ref) ? "pinned" : `origin/${source.ref}`;
  return `${source.variable} = core ${source.revision} (${pinned}), a fresh worktree of ${source.base}` +
    (source.baseDirty ? `; ${source.base} has local changes, which this run does not use` : "");
}
