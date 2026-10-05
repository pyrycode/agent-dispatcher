// Verifier gate reuse: skip the pre-verifier gates when they already passed
// on exactly these files.
//
// On pyrycode-mobile the pre-verifier gates take 11 to 22 minutes a pass,
// most of it emulator device tests. On 2026-10-02 #1340's verifier crashed
// one second after all seven gates passed ("Claude CLI exited with code 1,
// no result message received"). Any retry on the same commit ran every gate
// again for nothing.
//
// So a full pass is written down, keyed by the issue, the tree the gates ran
// on (the files of HEAD after the default branch was merged in) and a hash
// of the ordered gate list. The next verifier dispatch for the issue reuses
// it when all three match, the pass is less than a day old and the gate logs
// it names are still on disk.
//
// The key is the tree, not the commit. Identical files give identical gate
// results, and the merge of the default branch is a fresh commit with a new
// SHA whenever it is made again over the same two parents. Keying on that
// SHA would miss exactly the retries this exists for. The commit is still
// recorded, so the note and the log can say which run is being reused.
//
// Only a full pass is recorded: a red, timed-out or unspawnable gate never
// is, so a retry after a flaky failure runs the gates again.
// `PYRY_VERIFIER_GATE_REUSE=0` turns the whole thing off.
//
// Pure helpers here; the file I/O stays in dispatch.ts.

import { createHash } from "node:crypto";

/** A recorded pass older than this is run again rather than reused. */
export const VERIFIER_GATE_REUSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** On unless `PYRY_VERIFIER_GATE_REUSE` is exactly `0`. Read at dispatch
 *  time, like the other verifier gate settings. */
export function verifierGateReuseEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.PYRY_VERIFIER_GATE_REUSE?.trim() !== "0";
}

/** File name of an issue's recorded pass, in the logs dir beside the gate
 *  logs. One per issue: each new pass overwrites the last. */
export function verifierGatePassFileName(issueNumber: number): string {
  return `verifier-gate_#${issueNumber}.pass.json`;
}

/** Hash of the ordered gate command list. JSON keeps it unambiguous: no
 *  delimiter inside a command can make two different lists hash alike. */
export function hashGateList(gates: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(gates)).digest("hex");
}

/** What a full pass records. */
export interface VerifierGatePass {
  issueNumber: number;
  /** HEAD of the merged worktree the gates ran on. Recorded for the note
   *  and the log; reuse does not match on it. */
  commit: string;
  /** `HEAD^{tree}` of that worktree: the files the gates tested. The
   *  reuse key. */
  tree: string;
  /** `hashGateList` of the gates that ran. */
  gatesHash: string;
  /** The gate commands themselves, for a person reading the file. */
  gates: string[];
  /** ISO time the last gate finished. */
  passedAt: string;
  /** One line per gate, as the GATES log section shows them. */
  summary: string[];
  /** The stdout and stderr log of every gate in the run. */
  logPaths: string[];
}

/**
 * Read a recorded pass back. Anything that is not the shape written by
 * dispatch.ts, including a truncated or hand-edited file, comes back as null
 * and the caller runs the gates as normal.
 */
export function parseVerifierGatePass(raw: string): VerifierGatePass | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const isStrings = (x: unknown): x is string[] =>
    Array.isArray(x) && x.every((s) => typeof s === "string");
  if (
    typeof r.issueNumber !== "number"
    || typeof r.commit !== "string"
    || typeof r.tree !== "string"
    || typeof r.gatesHash !== "string"
    || !isStrings(r.gates)
    || typeof r.passedAt !== "string"
    || !isStrings(r.summary)
    || !isStrings(r.logPaths)
  ) {
    return null;
  }
  return {
    issueNumber: r.issueNumber,
    commit: r.commit,
    tree: r.tree,
    gatesHash: r.gatesHash,
    gates: r.gates,
    passedAt: r.passedAt,
    summary: r.summary,
    logPaths: r.logPaths,
  };
}

export type VerifierGateReuseDecision =
  | { reuse: true; pass: VerifierGatePass }
  | {
    reuse: false;
    reason: "no-record" | "other-issue" | "tree-changed" | "gates-changed" | "expired" | "log-missing";
  };

/**
 * Whether a recorded pass stands in for running the gates now. Every part of
 * the key must match, the pass must be younger than
 * `VERIFIER_GATE_REUSE_MAX_AGE_MS`, and every gate log it names must still
 * exist, since those logs are the evidence the reused verdict rests on. The
 * match is on the tree, so a re-made merge commit over the same files still
 * reuses. An unknown current tree never matches.
 */
export function decideVerifierGateReuse(opts: {
  pass: VerifierGatePass | null;
  issueNumber: number;
  tree: string;
  gatesHash: string;
  nowMs: number;
  logExists: (path: string) => boolean;
}): VerifierGateReuseDecision {
  const { pass } = opts;
  if (pass === null) return { reuse: false, reason: "no-record" };
  if (pass.issueNumber !== opts.issueNumber) return { reuse: false, reason: "other-issue" };
  if (opts.tree === "" || pass.tree !== opts.tree) return { reuse: false, reason: "tree-changed" };
  if (pass.gatesHash !== opts.gatesHash) return { reuse: false, reason: "gates-changed" };
  // A pass stamped in the future, or with no readable time, is not trusted.
  const ageMs = opts.nowMs - Date.parse(pass.passedAt);
  if (!(ageMs >= 0 && ageMs < VERIFIER_GATE_REUSE_MAX_AGE_MS)) return { reuse: false, reason: "expired" };
  if (pass.logPaths.length === 0 || !pass.logPaths.every((p) => opts.logExists(p))) {
    return { reuse: false, reason: "log-missing" };
  }
  return { reuse: true, pass };
}

// Docs-only reuse (#134). A rework that changes only documentation or the
// plan changes the tree, so the exact match above misses, and every gate
// ran again on unchanged code: about 13 minutes on pyrycode-mobile for a
// one-file Markdown fix. When every file that differs between the recorded
// pass's commit and the current HEAD is documentation, the code gates'
// results stand and only the documentation gates run again. The age, gate
// list and log checks still apply.

/** Globs counted as documentation when `PYRY_VERIFIER_DOCS_PATHS` is unset.
 *  Covers the plan under `docs/specs/architecture/`. */
export const DEFAULT_VERIFIER_DOCS_PATHS: readonly string[] = ["docs/**"];

/** `PYRY_VERIFIER_DOCS_PATHS`: comma-separated path globs. Unset means
 *  `docs/**`. Empty means no path counts as documentation. */
export function parseVerifierDocsPaths(envValue: string | undefined): string[] {
  if (envValue === undefined) return [...DEFAULT_VERIFIER_DOCS_PATHS];
  return envValue.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** `PYRY_VERIFIER_DOCS_GATES`: gate commands, written exactly as in
 *  `PYRY_VERIFIER_GATES` and separated by `;`, that still run on a
 *  docs-only change. Unset or empty means none. */
export function parseVerifierDocsGates(envValue: string | undefined): string[] {
  return (envValue ?? "").split(";").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Whether a repo-relative path matches any glob. `**` spans folders,
 *  `*` stays inside one, everything else is literal. */
export function matchesDocsPath(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
      if (glob.startsWith("**/", i)) {
        re += "(?:.*/)?";
        i += 2;
      } else if (glob.startsWith("**", i)) {
        re += ".*";
        i += 1;
      } else if (glob[i] === "*") {
        re += "[^/]*";
      } else {
        re += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    return new RegExp(`^${re}$`).test(path);
  });
}

export type DocsOnlyGateReuseDecision =
  | {
    reuse: true;
    pass: VerifierGatePass;
    /** The files that changed since the pass, all documentation. */
    files: string[];
    /** The documentation gates to run again, in gate-list order. */
    rerun: string[];
  }
  | {
    reuse: false;
    reason:
      | Extract<VerifierGateReuseDecision, { reuse: false }>["reason"]
      | "same-tree"
      | "diff-failed"
      | "code-changed";
  };

/**
 * Whether a recorded pass on a different tree stands in for the code gates,
 * because only documentation changed since it. Every check of
 * `decideVerifierGateReuse` except the tree match applies first, and only
 * then is `changedFiles` asked for the files between the pass's commit and
 * HEAD, so a ruled-out pass costs no git call. A failed or empty diff, or
 * any path outside `docsPaths`, is no reuse.
 */
export function decideDocsOnlyGateReuse(opts: {
  pass: VerifierGatePass | null;
  issueNumber: number;
  tree: string;
  gates: readonly string[];
  gatesHash: string;
  nowMs: number;
  logExists: (path: string) => boolean;
  docsPaths: readonly string[];
  docsGates: readonly string[];
  /** Files changed between `fromCommit` and HEAD, or null on any error. */
  changedFiles: (fromCommit: string) => string[] | null;
}): DocsOnlyGateReuseDecision {
  const { pass } = opts;
  if (opts.tree === "") return { reuse: false, reason: "tree-changed" };
  if (pass !== null && pass.tree === opts.tree) return { reuse: false, reason: "same-tree" };
  // The exact-match checks, with the tree taken as matching.
  const base = decideVerifierGateReuse({ ...opts, tree: pass?.tree || opts.tree });
  if (!base.reuse) return base;
  const files = opts.changedFiles(base.pass.commit);
  if (files === null || files.length === 0) return { reuse: false, reason: "diff-failed" };
  if (!files.every((f) => matchesDocsPath(f, opts.docsPaths))) return { reuse: false, reason: "code-changed" };
  return {
    reuse: true,
    pass: base.pass,
    files,
    rerun: opts.gates.filter((g) => opts.docsGates.includes(g)),
  };
}
