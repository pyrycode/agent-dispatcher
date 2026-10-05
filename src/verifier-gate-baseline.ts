// Verifier gate baseline: set aside red-gate failures that main already has,
// before the verifier is asked to judge them.
//
// A red pre-verifier gate spawns the verifier in TRIAGE MODE, and the
// verifier decides whether the failure is the ticket's. For device tests that
// fail only under full-suite load it cannot tell: a focused re-run passes on
// main and on the branch, so the failure looks like the branch's. On
// 2026-10-04 and 2026-10-05 pyrycode-mobile #1747 failed four verifier passes
// that way and tripped the rework breaker, while main itself failed 38 of
// 1211 device tests in the main sweep (pyrycode-mobile #1809).
//
// So a gate with a known output format has its failing test names read
// before the verifier spawns. A name that also failed in the latest main
// sweep is a baseline failure, but only when the sweep ran on a main commit
// the branch's merged tree contains: a sweep newer than the branch's merge of
// main may describe code the branch has never seen. The remaining names are
// re-run alone on the base commit, as the real-claude gate's baseline run
// does, and the ones that fail there are baseline too. Baseline names go to
// the open main-failure ticket, not the builder. When none remain, the gate
// counts as green for the verdict.
//
// The format is opt-in per gate (`PYRY_VERIFIER_GATE_FORMATS`). A gate
// without one behaves exactly as before.
//
// Pure helpers here; the runs, git calls and ticket writes stay in
// dispatch.ts.

import { isGateOutputFormat, type GateOutputFormat, type GateTally } from "./gate-output.js";

/** How to read one verifier gate's stdout, and how to re-run its failures. */
export interface VerifierGateFormat {
  format: GateOutputFormat;
  /** Base-commit re-run template with a `{{TESTS}}` placeholder, or null
   *  when only the main sweep can set failures aside. */
  baselineCommand: string | null;
}

/**
 * Parse `PYRY_VERIFIER_GATE_FORMATS`: a JSON object keyed by a gate command
 * exactly as it appears in `PYRY_VERIFIER_GATES` (trimmed). Each value is a
 * format name, or an object with `format` and an optional `baseline`
 * template:
 *
 *   {"python3 scripts/android-test-gate.py ui":
 *     {"format": "junit-xml", "baseline": "python3 scripts/android-test-gate.py ui --tests {{TESTS}}"}}
 *
 * JSON rather than another `;` list because gate commands carry `;`, spaces
 * and quotes of their own. Unset or empty yields no formats. Anything that
 * cannot be read is skipped with an error line for the log, and that gate
 * keeps today's behaviour: a typo must never excuse a failure.
 */
export function parseVerifierGateFormats(raw: string | undefined): {
  formats: Map<string, VerifierGateFormat>;
  errors: string[];
} {
  const formats = new Map<string, VerifierGateFormat>();
  const errors: string[] = [];
  const text = (raw ?? "").trim();
  if (text === "") return { formats, errors };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    return { formats, errors: [`PYRY_VERIFIER_GATE_FORMATS is not valid JSON, so no gate is read: ${e?.message ?? e}`] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { formats, errors: ["PYRY_VERIFIER_GATE_FORMATS must be a JSON object keyed by gate command, so no gate is read"] };
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const gate = key.trim();
    const spec = typeof value === "string" ? { format: value } : value;
    const format = (spec as any)?.format;
    const baseline = (spec as any)?.baseline;
    if (gate === "" || typeof format !== "string" || !isGateOutputFormat(format)) {
      errors.push(`PYRY_VERIFIER_GATE_FORMATS entry for \`${gate}\` has no known format, so that gate is not read`);
      continue;
    }
    if (baseline !== undefined && (typeof baseline !== "string" || baseline.trim() === "")) {
      errors.push(`PYRY_VERIFIER_GATE_FORMATS entry for \`${gate}\` has an unusable baseline, so that gate is not read`);
      continue;
    }
    formats.set(gate, { format, baselineCommand: typeof baseline === "string" ? baseline.trim() : null });
  }
  return { formats, errors };
}

/**
 * The failing names of a red gate, when every failure has one. Null when the
 * red cannot be pinned on named tests: an unreadable artifact, no named
 * failure, or a suite or package that broke without a failing test of its
 * own to show for it (a build error, a crashed runner). Such a red always
 * stays the verifier's to triage; a baseline can only excuse what it names.
 */
export function attributableFailures(tally: GateTally): string[] | null {
  if (tally.recognizedLines === 0 || tally.failedNames.length === 0) return null;
  // Go marks a package failed whenever one of its tests fails, so a package
  // failure is covered when a named failure sits inside it. A JUnit suite is
  // marked broken only for a fault no test case carries, which nothing covers.
  const covered = (pkg: string) => tally.failedNames.some((name) => name.startsWith(`${pkg}.`));
  if (!tally.packageFailures.every(covered)) return null;
  return [...new Set(tally.failedNames)];
}

/** The last main sweep's failures and the main commit it ran on. */
export interface SweepFailures {
  sha: string;
  names: readonly string[];
}

/**
 * Split a red gate's failures by the latest main sweep. `sweepIsAncestor` is
 * whether the sweep's commit is in the branch's merged tree; anything but a
 * confirmed true, or no recorded sweep, uses nothing.
 */
export function splitBySweep(
  failedNames: readonly string[],
  sweep: SweepFailures | null,
  sweepIsAncestor: boolean | null,
): { baseline: string[]; remaining: string[] } {
  if (sweep === null || sweepIsAncestor !== true) return { baseline: [], remaining: [...failedNames] };
  const onMain = new Set(sweep.names);
  return {
    baseline: failedNames.filter((name) => onMain.has(name)),
    remaining: failedNames.filter((name) => !onMain.has(name)),
  };
}

/** Why a failure was set aside. */
export type BaselineSource = "main-sweep" | "base-commit";

export interface BaselineEntry {
  name: string;
  source: BaselineSource;
  /** The main commit it failed on: the sweep's, or the base the re-run used. */
  sha: string;
}

/** One red gate, read against the baseline. */
export interface GateBaselineAssessment {
  gate: string;
  baseline: BaselineEntry[];
  /** Failures still the ticket's. Empty means the gate counts as green. */
  remaining: string[];
  /** Why the base re-run did not happen, when it did not; for the log. */
  baseSkipReason: string | null;
}

/** A one-line description of an entry, for the note, the log and the ticket. */
export function describeBaselineEntry(entry: BaselineEntry): string {
  const where = entry.source === "main-sweep"
    ? `failed in the main sweep on \`${entry.sha.slice(0, 12)}\``
    : `failed when re-run alone on the base commit \`${entry.sha.slice(0, 12)}\``;
  return `\`${entry.name}\` (${where})`;
}

/**
 * Entries whose names the main-failure ticket does not mention yet. A name
 * counts as listed when its full name appears in backticks in the ticket
 * body or any comment, which is how the sweep's ticket and its update
 * comments write them. Keeps one entry per name.
 */
export function unlistedBaselineEntries(
  entries: readonly BaselineEntry[],
  ticketTexts: readonly string[],
): BaselineEntry[] {
  const out: BaselineEntry[] = [];
  for (const entry of entries) {
    if (out.some((e) => e.name === entry.name)) continue;
    if (ticketTexts.some((text) => text.includes(`\`${entry.name}\``))) continue;
    out.push(entry);
  }
  return out;
}

/** The comment that records a gated ticket's baseline failures on the main-failure ticket. */
export function buildBaselineRecordComment(input: {
  gatedIssue: number;
  commit: string | null;
  entries: readonly { gate: string; entry: BaselineEntry }[];
}): string {
  const at = input.commit === null ? "its merged worktree" : `merged commit \`${input.commit}\``;
  const lines = [
    `## Main failures seen by #${input.gatedIssue}`,
    "",
    `The verifier gates for #${input.gatedIssue} failed these tests at ${at}. ` +
    "Each also failed on main, so the dispatcher set it aside as not that ticket's and records it here:",
    "",
  ];
  for (const { gate, entry } of input.entries) lines.push(`- ${describeBaselineEntry(entry)}, gate \`${gate}\``);
  return lines.join("\n");
}
