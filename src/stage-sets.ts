// Stage sets: named agent-pipeline configurations selected by the
// PYRY_STAGE_SET env var, resolved once at startup.
//
// Why this exists: one fork pilots a collapsed four-role pipeline
// (`builder`) while every other fork keeps the classic six-agent relay.
// The classic set IS today's config — it wraps the existing `AGENTS`
// array and `AUTO_ADVANCE_RULES` table by reference, so when the env var
// is unset (or set to `classic`) every derived structure (poll order,
// advance rules, tool grants, column maps) is byte-identical to the
// pre-stage-set dispatcher. Locked by stage-sets.test.ts against literal
// copies of the current values.
//
// All pure: config data plus a resolver. The one impurity is the
// process-lifetime memo in `activeStageSet()` (reads process.env once).
//
// Resolution timing is load-bearing: dispatch.ts loads the fork's .env
// via dotenv in its module body, AFTER its imports (this module
// included) are evaluated. A module-top `resolveStageSet(process.env…)`
// here would therefore run before .env exists and silently pin every
// fork to classic. `activeStageSet()` resolves lazily on first call —
// dispatch-bin.ts makes that first call at startup (fail-fast for
// unknown values), after dispatch.ts's dotenv load has run.

import { AGENTS, type AgentConfig } from "./types.js";
import {
  AUTO_ADVANCE_RULES,
  REAL_CLAUDE_GATE_FAIL_COLUMN,
  REAL_CLAUDE_GATE_FROM_COLUMN,
  type AdvanceRule,
} from "./pipeline-decisions.js";

/** Operator-facing list of valid PYRY_STAGE_SET values, printed by the
 *  fail-fast error. Keep in lockstep with `resolveStageSet`. */
export const STAGE_SET_NAMES = ["classic", "builder"] as const;

export interface StageSet {
  name: string;
  /** Pipeline agents in board order (Backlog-side first). The poll loop
   *  reverses this for finish-first priority. */
  agents: AgentConfig[];
  /** Forward auto-advance chain. Must walk every column of this set from
   *  Backlog to Done with no gaps (same invariant lib.test.ts locks for
   *  the classic table). */
  advanceRules: AdvanceRule[];
  /** agent name → column. The rework router's target lookup — a
   *  `needs-rework:<name>` label only routes when <name> is in here. */
  columnByAgent: ReadonlyMap<string, string>;
  /** Columns that count toward the WIP cap: every advance-rule `from`
   *  except Backlog. For classic this equals MID_PIPELINE_COLUMNS. */
  midPipelineColumns: readonly string[];
  /** Agent names granted the Agent (sub-agent) tool at spawn. */
  agentToolNames: ReadonlySet<string>;
  /** Agent names granted WebSearch at spawn. */
  webSearchToolNames: ReadonlySet<string>;
  /**
   * Pre-spawn deterministic gates (the builder set's pre-verifier gate),
   * or null when the feature is inert (classic). `agentNames` are the
   * agents whose dispatch runs the `PYRY_VERIFIER_GATES` commands in the
   * ticket's worktree BEFORE the model spawns. The deterministic layer
   * decides green vs red only: green injects a gates-passed note into the
   * agent's prompt, red STILL spawns the agent with the failure context
   * injected in TRIAGE MODE — the agent owns the baseline partition and
   * the bounce-vs-advance call, so a failure the branch merely inherited
   * never bounces forever. See `maybeRunPreSpawnGates` in dispatch.ts.
   */
  preSpawnGate: { agentNames: ReadonlySet<string> } | null;
  /**
   * The real-claude gate's per-set label keys (see pipeline-decisions.ts
   * for the gate itself). Derived, not declared: `reviewDoneLabel` is the
   * ready label of the advance rule leaving the gate's from-column (the
   * set's final pre-documentation review stage — done:code-review in
   * classic, done:verifier in builder), and `failReworkLabel` targets the
   * agent owning the gate's fail column (needs-rework:developer /
   * needs-rework:builder). Deriving keeps them consistent with the chain
   * by construction — a set whose review stage is renamed cannot leave
   * the gate keyed to a label nobody emits.
   */
  realClaudeGate: { reviewDoneLabel: string; failReworkLabel: string };
}

/** Derived pieces shared by both set constructors. */
function deriveStageSet(opts: {
  name: string;
  agents: AgentConfig[];
  advanceRules: AdvanceRule[];
  agentToolNames: ReadonlySet<string>;
  webSearchToolNames: ReadonlySet<string>;
  preSpawnGate: StageSet["preSpawnGate"];
}): StageSet {
  const reviewRule = opts.advanceRules.find((r) => r.from === REAL_CLAUDE_GATE_FROM_COLUMN);
  const failAgent = opts.agents.find((a) => a.column === REAL_CLAUDE_GATE_FAIL_COLUMN);
  if (!reviewRule || !failAgent) {
    // Config error in this file, caught at module load by any test run:
    // every stage set must own the gate's from-column and fail-column so
    // needs-real-claude tickets keep their e2e proof under it.
    throw new Error(
      `stage set "${opts.name}" cannot key the real-claude gate: it needs an advance rule ` +
        `from "${REAL_CLAUDE_GATE_FROM_COLUMN}" and an agent owning "${REAL_CLAUDE_GATE_FAIL_COLUMN}".`,
    );
  }
  return {
    ...opts,
    columnByAgent: new Map(opts.agents.map((a) => [a.name, a.column])),
    midPipelineColumns: opts.advanceRules
      .map((r) => r.from)
      .filter((c) => c !== "Backlog"),
    realClaudeGate: {
      reviewDoneLabel: reviewRule.readyLabel,
      failReworkLabel: `needs-rework:${failAgent.name}`,
    },
  };
}

// --------- classic: today's six-agent relay, by reference ---------

const CLASSIC_STAGE_SET: StageSet = deriveStageSet({
  name: "classic",
  // Same array/table objects as types.ts + pipeline-decisions.ts — not
  // copies — so classic can never drift from the canonical config.
  agents: AGENTS,
  advanceRules: AUTO_ADVANCE_RULES,
  // Mirrors the pre-stage-set literals in prepareAgentSpawn: Agent for
  // the two sub-agent-dispatching roles, WebSearch for the researcher.
  agentToolNames: new Set(["architect", "code-review"]),
  webSearchToolNames: new Set(["architect"]),
  // No pre-spawn gates in classic — the feature is entirely inert.
  preSpawnGate: null,
});

// --------- builder: collapsed four-role pipeline (piloted on one fork) ---------

// documentation is deliberately the SAME config object as classic's —
// serial cap, sonnet model and high effort carry over by reference.
const classicDocumentation = AGENTS.find((a) => a.name === "documentation")!;

const BUILDER_AGENTS: AgentConfig[] = [
  {
    // The PO contract under its new name: refines triaged Backlog
    // tickets via gh, never touches code.
    name: "refiner",
    column: "Backlog",
    claudeMdPath: "refiner/CLAUDE.md",
    description: "Refiner — creates structured issues (the PO contract under the builder set)",
    usesWorktree: false, // operates on issue body via gh, no commits
    producesCommits: false, // GH-side only (issue body, comments, labels)
  },
  {
    // Absorbs architect + developer: researches the approach, writes the
    // spec thinking inline, implements with tests. Bigger budgets than
    // the classic developer because it carries two classic stages.
    name: "builder",
    column: "In Development",
    claudeMdPath: "builder/CLAUDE.md",
    description: "Builder — designs and implements with tests (absorbs the architect's research)",
    usesWorktree: true,
    producesCommits: true,
    maxTurns: 200,
    timeoutMs: 2_400_000, // 40min
  },
  {
    // Absorbs qa + code-review: the dispatcher runs the mechanical gates
    // itself before this agent spawns (see preSpawnGate below), so the
    // verifier spends its budget on judgment. Code-review's budgets.
    name: "verifier",
    column: "In Code Review",
    claudeMdPath: "verifier/CLAUDE.md",
    description: "Verifier — reviews PRs for quality and correctness (gates pre-run by the dispatcher)",
    usesWorktree: true, // reads code locally to review
    producesCommits: false, // PR comments + labels only
    maxTurns: 150,
    timeoutMs: 2_400_000, // 40min
    // One verifier at a time, whatever PYRY_MAX_CONCURRENT says. The
    // pre-spawn gates are host-level work that does not partition by
    // worktree: on Mobile they boot Gradle-managed emulators (the UI
    // suite alone runs two instances since 2026-09-22) and the scripted
    // scenarios start a relay and a daemon on the host. Two verifiers
    // gating at once contend for the same managed device under the
    // Android plugin's cross-build device lock, and a gate queued behind
    // another run's emulator work overruns VERIFIER_GATE_TIMEOUT_MS and
    // spawns the verifier in triage mode on a red that is nobody's
    // fault. A builder and a verifier still overlap, so the cap still
    // pays; only verifier-with-verifier is serialised. Same mechanism as
    // documentation's cap in selectDispatches. Decided with Juhana
    // 2026-09-22 when Mobile moved to two tickets at once. A fork that
    // wants to try concurrent verifiers sets PYRY_VERIFIER_SERIAL=0 and
    // gets the variant built below; see resolveStageSet.
    serial: true,
  },
  classicDocumentation,
];

// The same set with concurrent verifiers, for a fork that opts out of the
// cap with PYRY_VERIFIER_SERIAL=0 (Mobile's experiment, 2026-09-22). Only
// the verifier's config differs; every other agent is the same object, so
// documentation keeps its cap and its model by reference.
const BUILDER_AGENTS_CONCURRENT_VERIFIERS: AgentConfig[] = BUILDER_AGENTS.map((a) =>
  a.name === "verifier" ? { ...a, serial: false } : a,
);

// The collapsed chain. In Architecture and In QA are simply absent —
// never polled, never advanced into.
const BUILDER_ADVANCE_RULES: AdvanceRule[] = [
  { from: "Backlog",          readyLabel: "done:refiner",       to: "In Development" },
  { from: "In Development",   readyLabel: "done:builder",       to: "In Code Review" },
  { from: "In Code Review",   readyLabel: "done:verifier",      to: "In Documentation" },
  { from: "In Documentation", readyLabel: "done:documentation", to: "Done" },
];

const BUILDER_STAGE_SET: StageSet = deriveStageSet({
  name: "builder",
  agents: BUILDER_AGENTS,
  advanceRules: BUILDER_ADVANCE_RULES,
  agentToolNames: new Set(["builder", "verifier"]),
  webSearchToolNames: new Set(["builder"]),
  preSpawnGate: { agentNames: new Set(["verifier"]) },
});

const BUILDER_STAGE_SET_CONCURRENT_VERIFIERS: StageSet = deriveStageSet({
  name: "builder",
  agents: BUILDER_AGENTS_CONCURRENT_VERIFIERS,
  advanceRules: BUILDER_ADVANCE_RULES,
  agentToolNames: new Set(["builder", "verifier"]),
  webSearchToolNames: new Set(["builder"]),
  preSpawnGate: { agentNames: new Set(["verifier"]) },
});

// --------- resolution ---------

/**
 * Resolve a PYRY_STAGE_SET value to its stage set.
 *
 * - **Unset / empty / whitespace** → `classic` (the default; byte-identical
 *   current behaviour).
 * - **`classic` / `builder`** → that set (stable singleton instances).
 * - **Anything else** → throws, listing the valid names. Callers at
 *   startup (dispatch-bin.ts) surface the message and exit 1 — a typo'd
 *   stage set must never silently run the wrong pipeline.
 *
 * Pure over its inputs; `activeStageSet` below owns the env read. `env`
 * carries the per-fork switches a set reads: today only
 * PYRY_VERIFIER_SERIAL, where the exact string "0" hands the builder set
 * back with concurrent verifiers and anything else keeps the default cap.
 */
export function resolveStageSet(
  raw: string | undefined,
  env: Pick<NodeJS.ProcessEnv, "PYRY_VERIFIER_SERIAL"> = process.env,
): StageSet {
  const name = (raw ?? "").trim();
  if (name === "" || name === "classic") return CLASSIC_STAGE_SET;
  if (name === "builder") {
    return env.PYRY_VERIFIER_SERIAL === "0" ? BUILDER_STAGE_SET_CONCURRENT_VERIFIERS : BUILDER_STAGE_SET;
  }
  throw new Error(
    `Unknown PYRY_STAGE_SET "${raw}". Valid stage sets: ${STAGE_SET_NAMES.join(", ")}. ` +
      `Unset the variable (or set "classic") for the default six-agent pipeline.`,
  );
}

let active: StageSet | null = null;

/**
 * The process's resolved stage set — read from PYRY_STAGE_SET on first
 * call and memoized, so a mid-run env mutation can never flip the
 * pipeline shape between cycles. dispatch-bin.ts makes the first call at
 * startup (after dispatch.ts's dotenv load) and fail-fasts on the throw;
 * every later caller (poll loop, spawn prep, reconciliation) gets the
 * same instance.
 */
export function activeStageSet(): StageSet {
  if (active === null) {
    active = resolveStageSet(process.env.PYRY_STAGE_SET, process.env);
  }
  return active;
}

/** Test-only: clear the memo so a test can re-resolve under a different
 *  PYRY_STAGE_SET. Production never calls this. */
export function resetActiveStageSetForTests(): void {
  active = null;
}
