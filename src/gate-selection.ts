// Per-ticket test selection for the real-claude gate.
//
// The gate used to run a fork's whole live suite for every gated ticket. On
// mobile that is 39 real-Claude scenarios and about eight and a half minutes,
// almost all of it spent on flows the ticket never touched. With selection on,
// a ticket runs the live tests its pull request names, plus a small fixed set
// of basic flows, and the whole suite runs only when it has to:
//
// - the branch changes code every live test goes through (the fork's full
//   paths, such as the connection layer);
// - the pull request names no tests, names them in a shape the filter cannot
//   carry, or asks for `all`;
// - enough merges have landed on the base since the last full run that passed.
//   That last rule is the backstop: a ticket that broke a flow it did not name
//   is caught by the next full run, at most `every` merges later.
//
// Every doubt resolves toward the full suite. A selection that cannot be read
// costs eight minutes; a selection that silently ran nothing costs a shipped
// regression.
//
// This module is the pure half. The runner in dispatch.ts reads the pull
// request body, the branch diff and the state file, and hands them here.

import { buildBaselineFilter, type GateOutputFormat } from "./gate-output.js";

export interface GateSelectionConfig {
  /** Tests every selected run includes, as qualified names. */
  alwaysTests: string[];
  /** Path prefixes whose change forces the full suite. */
  fullPaths: string[];
  /** Merges on the base since the last passing full run that force another. */
  fullEvery: number;
}

export const DEFAULT_GATE_FULL_EVERY = 10;

/** The pull-request heading the builder lists its live tests under. */
export const LIVE_TESTS_HEADING = "Live tests";

const splitList = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map(s => s.trim()).filter(s => s !== "");

/** Null when `PYRY_REAL_CLAUDE_GATE_SELECT` is not exactly `1`, which keeps every run full. */
export function readGateSelectionConfig(env: NodeJS.ProcessEnv): GateSelectionConfig | null {
  if ((env.PYRY_REAL_CLAUDE_GATE_SELECT ?? "").trim() !== "1") return null;
  const every = Number(env.PYRY_REAL_CLAUDE_GATE_FULL_EVERY);
  return {
    alwaysTests: splitList(env.PYRY_REAL_CLAUDE_GATE_ALWAYS_TESTS),
    fullPaths: splitList(env.PYRY_REAL_CLAUDE_GATE_FULL_PATHS),
    fullEvery: Number.isInteger(every) && every > 0 ? every : DEFAULT_GATE_FULL_EVERY,
  };
}

export type LiveTestsSection =
  | { kind: "missing" }
  | { kind: "all" }
  | { kind: "list"; names: string[] };

/**
 * Read the `## Live tests` section of a pull request body. Entries are one per
 * line, as list items or bare, with optional backticks; commas also separate.
 * An empty section reads as missing, so a forgotten list runs the full suite.
 */
export function parseLiveTestsSection(body: string): LiveTestsSection {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(l => /^##\s+live tests\s*$/i.test(l.trim()));
  if (start === -1) return { kind: "missing" };
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line.trim())) break;
    for (const part of line.replace(/^\s*[-*]\s*/, "").split(",")) {
      const name = part.trim().replace(/^`+|`+$/g, "").trim();
      if (name === "") continue;
      if (name.toLowerCase() === "all") return { kind: "all" };
      if (!names.includes(name)) names.push(name);
    }
  }
  return names.length === 0 ? { kind: "missing" } : { kind: "list", names };
}

export type GateSelection =
  | { mode: "full"; reason: string }
  | { mode: "selected"; tests: string[]; filter: string; reason: string };

/**
 * Decide whether this run is the full suite or a named subset, and why.
 *
 * `changedPaths` and `mergesSinceFull` are null when they could not be
 * computed; both resolve to the full suite. The rules run in order of how
 * much each one says about risk: shared code first, the periodic backstop
 * second, and the pull request's own list last.
 */
export function decideGateSelection(input: {
  config: GateSelectionConfig;
  section: LiveTestsSection;
  changedPaths: readonly string[] | null;
  mergesSinceFull: number | null;
  format: GateOutputFormat;
}): GateSelection {
  const { config, section } = input;

  if (input.changedPaths === null) {
    return { mode: "full", reason: "the branch's changed files could not be listed" };
  }
  const shared = input.changedPaths.find(p => config.fullPaths.some(prefix => p.startsWith(prefix)));
  if (shared !== undefined) {
    return { mode: "full", reason: `the branch changes \`${shared}\`, which every live test goes through` };
  }

  if (input.mergesSinceFull === null) {
    return { mode: "full", reason: "no passing full run is on record for the current base" };
  }
  if (input.mergesSinceFull >= config.fullEvery) {
    return {
      mode: "full",
      reason: `${input.mergesSinceFull} merges have landed since the last passing full run, and the fork runs the full suite every ${config.fullEvery}`,
    };
  }

  if (section.kind === "missing") {
    return { mode: "full", reason: `the pull request has no \`## ${LIVE_TESTS_HEADING}\` list` };
  }
  if (section.kind === "all") {
    return { mode: "full", reason: `the pull request's \`## ${LIVE_TESTS_HEADING}\` list asks for all of them` };
  }

  if (config.alwaysTests.length > 0 && buildBaselineFilter(config.alwaysTests, input.format) === null) {
    return {
      mode: "full",
      reason: "a name in the fork's PYRY_REAL_CLAUDE_GATE_ALWAYS_TESTS is not a plain qualified test name. " +
        "An env-file loader may have cut the value at a `#`; quote it",
    };
  }

  const tests = [...config.alwaysTests];
  for (const name of section.names) if (!tests.includes(name)) tests.push(name);
  const filter = buildBaselineFilter(tests, input.format);
  if (filter === null) {
    return {
      mode: "full",
      reason: `a name in the \`## ${LIVE_TESTS_HEADING}\` list is not a plain qualified test name, so no safe filter could be built`,
    };
  }
  return {
    mode: "selected",
    tests,
    filter,
    reason: `${section.names.length} test(s) named by the pull request and ${config.alwaysTests.length} always-run test(s)`,
  };
}

/** The base commit of the last full run that passed. */
export interface GateFullState {
  lastFullPassSha: string | null;
}

export function parseGateFullState(raw: string | null): GateFullState {
  if (raw === null) return { lastFullPassSha: null };
  try {
    const parsed = JSON.parse(raw);
    return { lastFullPassSha: typeof parsed?.lastFullPassSha === "string" ? parsed.lastFullPassSha : null };
  } catch {
    return { lastFullPassSha: null };
  }
}
