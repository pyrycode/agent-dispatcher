// Raw evidence folders for the dispatcher's live gate.
//
// The real-claude gate runs in a detached worktree that is removed when the
// run ends. Anything the gate command writes inside that worktree goes with
// it: pyrycode-mobile's per-test JUnit XML, phone logcat, harness logs and
// per-arm captures all lived under its ignored `build/` folder, so the
// documentation stage kept sending tickets back for captures nobody could
// recreate (Mobile #2137 and #1977 on 2026-10-14). Mobile's harness only
// chose a persistent folder when the checkout was on a `feature/N` branch,
// and the gate's checkout never is.
//
// So the dispatcher names the folder. Every gate spawn for a ticket gets
// `PYRY_GATE_EVIDENCE_DIR`, a fresh folder outside the worktree under the
// agents repo's logs, scoped to the ticket and the run:
//
//   <logs>/evidence/<issue>/gate-runs/<stamp>/<part>/
//
// where `<part>` is `main`, `rerun`, `base` or `infra-check`. A gate script
// that honours the variable writes its captures there; one that does not is
// unaffected. The run record and the evidence comment name the folder, so
// the verifier and documentation roles can find it.
//
// Bounded: before a new run folder is made, old ones are pruned by age, by
// count per ticket and by total size. Only folders this module creates are
// ever touched: a `gate-runs` child named like a run stamp, under a numeric
// ticket folder. Everything else under `evidence/`, such as a builder's own
// retained captures, is left alone. Pruning never throws.

import { lstatSync, mkdirSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

/** The variable a gate command reads its evidence folder from. */
export const GATE_EVIDENCE_ENV = "PYRY_GATE_EVIDENCE_DIR";

/** The folder under each ticket's evidence folder that holds gate runs. */
export const GATE_RUNS_DIR = "gate-runs";

/** Run folders are named by the gate's own stamp, `new Date().toISOString()` with `:` and `.` replaced. */
const RUN_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export interface GateEvidenceRetention {
  /** Newest run folders kept per ticket. */
  keepPerTicket: number;
  /** Run folders older than this are removed. */
  maxAgeDays: number;
  /** Total size of all run folders, oldest removed first above it. */
  maxTotalBytes: number;
}

export const DEFAULT_GATE_EVIDENCE_RETENTION: GateEvidenceRetention = {
  keepPerTicket: 5,
  maxAgeDays: 30,
  maxTotalBytes: 2048 * 1024 * 1024,
};

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (Number.isSafeInteger(n) && n >= 1) return n;
  console.warn(`   ⚠️  ${name}=${JSON.stringify(raw)} is not a whole number of at least 1; using ${fallback}`);
  return fallback;
}

/**
 * `PYRY_GATE_EVIDENCE_KEEP` (runs per ticket, default 5),
 * `PYRY_GATE_EVIDENCE_DAYS` (default 30, the dispatch log retention) and
 * `PYRY_GATE_EVIDENCE_MAX_MB` (default 2048). An invalid value falls back to
 * its default with a warning.
 */
export function gateEvidenceRetentionFromEnv(env: NodeJS.ProcessEnv): GateEvidenceRetention {
  const d = DEFAULT_GATE_EVIDENCE_RETENTION;
  return {
    keepPerTicket: positiveInt(env.PYRY_GATE_EVIDENCE_KEEP, d.keepPerTicket, "PYRY_GATE_EVIDENCE_KEEP"),
    maxAgeDays: positiveInt(env.PYRY_GATE_EVIDENCE_DAYS, d.maxAgeDays, "PYRY_GATE_EVIDENCE_DAYS"),
    maxTotalBytes: positiveInt(env.PYRY_GATE_EVIDENCE_MAX_MB, d.maxTotalBytes / 1024 / 1024, "PYRY_GATE_EVIDENCE_MAX_MB") * 1024 * 1024,
  };
}

/** The run folder for one gate run of one ticket. */
export function gateRunEvidenceDir(logsDir: string, issueNumber: number, stamp: string): string {
  return resolve(logsDir, "evidence", String(issueNumber), GATE_RUNS_DIR, stamp);
}

/** Bytes under `path`, without following symbolic links. */
function treeBytes(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let st;
    try { st = lstatSync(current); } catch { continue; }
    if (st.isDirectory()) {
      let names: string[] = [];
      try { names = readdirSync(current); } catch {}
      for (const name of names) stack.push(resolve(current, name));
    } else {
      total += st.size;
    }
  }
  return total;
}

interface RunFolder { path: string; ticket: string; stamp: string; mtimeMs: number; bytes: number }

/** Every run folder this module made, oldest stamp first. */
function listRunFolders(logsDir: string): RunFolder[] {
  const root = resolve(logsDir, "evidence");
  const out: RunFolder[] = [];
  let tickets: string[] = [];
  // Every level is checked with lstat, so a link anywhere on the way is
  // skipped rather than followed out of the logs folder.
  const isRealDir = (path: string): boolean => {
    try { return lstatSync(path).isDirectory(); } catch { return false; }
  };
  if (!isRealDir(root)) return out;
  try { tickets = readdirSync(root); } catch { return out; }
  for (const ticket of tickets) {
    if (!/^\d+$/.test(ticket)) continue;
    if (!isRealDir(resolve(root, ticket))) continue;
    const runsDir = resolve(root, ticket, GATE_RUNS_DIR);
    try { if (!lstatSync(runsDir).isDirectory()) continue; } catch { continue; }
    let stamps: string[] = [];
    try { stamps = readdirSync(runsDir); } catch { continue; }
    for (const stamp of stamps) {
      if (!RUN_STAMP.test(stamp)) continue;
      const path = resolve(runsDir, stamp);
      let st;
      try { st = lstatSync(path); } catch { continue; }
      if (!st.isDirectory()) continue;
      out.push({ path, ticket, stamp, mtimeMs: st.mtimeMs, bytes: treeBytes(path) });
    }
  }
  return out.sort((a, b) => a.stamp.localeCompare(b.stamp));
}

/**
 * Remove run folders over the retention limits, oldest first: anything older
 * than `maxAgeDays`, anything beyond the newest `keepPerTicket` of its
 * ticket, then the oldest until the total fits `maxTotalBytes`. Returns the
 * paths removed. A folder in `protect`, the run about to start, is counted
 * but never removed. Never throws; a folder that cannot be removed is
 * reported and skipped.
 */
export function pruneGateEvidence(
  logsDir: string, retention: GateEvidenceRetention, nowMs: number, protect: ReadonlySet<string> = new Set(),
): string[] {
  const removed: string[] = [];
  try {
    const folders = listRunFolders(logsDir);
    const doomed = new Set<RunFolder>();
    const cutoff = nowMs - retention.maxAgeDays * 24 * 60 * 60 * 1000;
    for (const f of folders) if (f.mtimeMs < cutoff) doomed.add(f);
    const byTicket = new Map<string, RunFolder[]>();
    for (const f of folders) byTicket.set(f.ticket, [...(byTicket.get(f.ticket) ?? []), f]);
    for (const list of byTicket.values()) {
      for (const f of list.slice(0, Math.max(0, list.length - retention.keepPerTicket))) doomed.add(f);
    }
    // The size pass never takes a ticket's newest run: that is the evidence
    // a ticket in flight still needs. So the total can exceed the cap by at
    // most one run per ticket, and the age and count limits bound those.
    const newest = new Set([...byTicket.values()].map(list => list[list.length - 1]));
    let total = folders.filter(f => !doomed.has(f)).reduce((sum, f) => sum + f.bytes, 0);
    for (const f of folders) {
      if (total <= retention.maxTotalBytes) break;
      if (doomed.has(f) || newest.has(f)) continue;
      doomed.add(f);
      total -= f.bytes;
    }
    for (const f of folders) {
      if (!doomed.has(f) || protect.has(f.path)) continue;
      try {
        rmSync(f.path, { recursive: true, force: true });
        removed.push(f.path);
      } catch (e: any) {
        console.warn(`   ⚠️  Gate evidence: could not remove ${f.path}: ${e?.message ?? e}`);
      }
    }
    if (removed.length > 0) console.log(`   🧹 Gate evidence: removed ${removed.length} old run folder(s)`);
  } catch (e: any) {
    console.warn(`   ⚠️  Gate evidence: pruning failed: ${e?.message ?? e}`);
  }
  return removed;
}

/** Create `dir` and its parents, owner-only. Throws on failure. */
export function makePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Create the run folder for a new gate run, then prune the others. Returns
 * the folder, or null when it could not be created: the run then goes ahead
 * without `PYRY_GATE_EVIDENCE_DIR`, as before this existed, rather than
 * failing a gate over its evidence folder.
 */
export function prepareGateRunEvidence(logsDir: string, issueNumber: number, stamp: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = gateRunEvidenceDir(logsDir, issueNumber, stamp);
  let made: string | null = null;
  try {
    makePrivateDir(dir);
    made = dir;
  } catch (e: any) {
    console.warn(`   ⚠️  Gate evidence: could not create ${dir}; the run goes ahead without ${GATE_EVIDENCE_ENV}: ${e?.message ?? e}`);
  }
  pruneGateEvidence(logsDir, gateEvidenceRetentionFromEnv(env), Date.now(), new Set(made === null ? [] : [made]));
  return made;
}

/**
 * The environment entry for one part of a gate run (`main`, `rerun`, `base`,
 * `infra-check`): its own folder inside the run folder, created owner-only.
 * Empty when there is no run folder or the part folder cannot be made, so the
 * command runs as it would have without one.
 */
export function gateEvidenceEnv(
  runDir: string | null | undefined,
  part: string,
  mkdir: (path: string, options: { recursive: true; mode: number }) => unknown = (path, options) => mkdirSync(path, options),
): NodeJS.ProcessEnv {
  if (!runDir) return {};
  const dir = resolve(runDir, part);
  try {
    mkdir(dir, { recursive: true, mode: 0o700 });
    return { [GATE_EVIDENCE_ENV]: dir };
  } catch (e: any) {
    console.warn(`   ⚠️  Gate evidence: could not create ${dir}; this part runs without ${GATE_EVIDENCE_ENV}: ${e?.message ?? e}`);
    return {};
  }
}
