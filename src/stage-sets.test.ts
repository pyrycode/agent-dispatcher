// Stage sets: named agent-pipeline configurations selected by
// PYRY_STAGE_SET. `classic` must be byte-identical to the pre-stage-set
// dispatcher (locked below against literal copies of today's AGENTS and
// AUTO_ADVANCE_RULES); `builder` is the collapsed four-role pipeline
// piloted on one fork. See stage-sets.ts for the module under test.

import { describe, test } from "node:test";
import assert from "node:assert";

import {
  activeStageSet,
  resetActiveStageSetForTests,
  resolveStageSet,
  STAGE_SET_NAMES,
  type StageSet,
} from "./stage-sets.js";
import { AGENTS, type AgentConfig } from "./types.js";
import {
  AUTO_ADVANCE_RULES,
  MANUAL_ADVANCE_GATES,
  MID_PIPELINE_COLUMNS,
  REAL_CLAUDE_GATE_LABEL,
  decideAutoAdvance,
  decideGateOutcome,
  decideRealClaudeGate,
  decideRealClaudeGateRun,
  decideReworkRoutes,
} from "./pipeline-decisions.js";
import { AGENT_COLUMN_MAP, selectDispatches } from "./dispatch-selection.js";
import { maxTurnsFor, parseVerifierGates, timeoutFor } from "./agent-runtime.js";

// --------- Env wrap helper ---------

/** Run `fn` with PYRY_STAGE_SET set (or unset for `undefined`), resetting
 *  the memoized active set on entry and exit so neighbouring tests never
 *  see a stale resolution. */
function withStageSetEnv<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.PYRY_STAGE_SET;
  if (value === undefined) delete process.env.PYRY_STAGE_SET;
  else process.env.PYRY_STAGE_SET = value;
  resetActiveStageSetForTests();
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.PYRY_STAGE_SET;
    else process.env.PYRY_STAGE_SET = prior;
    resetActiveStageSetForTests();
  }
}

// --------- Resolution table ---------

describe("resolveStageSet — resolution table", () => {
  test("unset (undefined) → classic", () => {
    assert.equal(resolveStageSet(undefined).name, "classic");
  });

  test("empty string → classic (unset-equivalent, matches PYRY_RESUME_LEGS convention)", () => {
    assert.equal(resolveStageSet("").name, "classic");
  });

  test("'classic' → classic", () => {
    assert.equal(resolveStageSet("classic").name, "classic");
  });

  test("'builder' → builder", () => {
    assert.equal(resolveStageSet("builder").name, "builder");
  });

  test("surrounding whitespace is trimmed", () => {
    assert.equal(resolveStageSet("  builder  ").name, "builder");
  });

  test("garbage → throws with the valid set names in the message", () => {
    assert.throws(
      () => resolveStageSet("garbage"),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /PYRY_STAGE_SET/);
        assert.match(e.message, /"garbage"/);
        for (const name of STAGE_SET_NAMES) {
          assert.ok(e.message.includes(name), `message must list valid set "${name}"`);
        }
        return true;
      },
    );
  });

  test("names are case-sensitive — 'CLASSIC' is an error, not a silent default", () => {
    assert.throws(() => resolveStageSet("CLASSIC"), /PYRY_STAGE_SET/);
  });

  test("repeated resolution returns the same instances (stable references)", () => {
    assert.equal(resolveStageSet("classic"), resolveStageSet(undefined));
    assert.equal(resolveStageSet("builder"), resolveStageSet("builder"));
  });
});

// --------- Classic identity ---------

// Literal copy of the AGENTS array as of 2026-09-01 (HEAD 88664d5). If
// this test fails, either types.ts drifted (update the literal
// deliberately) or the classic stage set stopped mirroring it (a bug).
const CLASSIC_AGENTS_LITERAL: AgentConfig[] = [
  {
    name: "po",
    column: "Backlog",
    claudeMdPath: "po/CLAUDE.md",
    description: "Product Owner — creates structured issues",
    usesWorktree: false,
    producesCommits: false,
  },
  {
    name: "architect",
    column: "In Architecture",
    claudeMdPath: "architect/CLAUDE.md",
    description: "System Architect — defines interfaces, data flows, concurrency patterns",
    usesWorktree: true,
    producesCommits: true,
  },
  {
    name: "developer",
    column: "In Development",
    claudeMdPath: "developer/CLAUDE.md",
    description: "Developer — implements code with tests",
    usesWorktree: true,
    producesCommits: true,
  },
  {
    name: "qa",
    column: "In QA",
    claudeMdPath: "qa/CLAUDE.md",
    description: "QA — runs mechanical gates (tests/vet/build) and triages failures against baseline",
    usesWorktree: true,
    producesCommits: false,
    model: "claude-sonnet-5",
    effort: "high",
  },
  {
    name: "code-review",
    column: "In Code Review",
    claudeMdPath: "code-review/CLAUDE.md",
    description: "Code Reviewer — reviews PRs for quality and correctness (assumes green tests from QA)",
    usesWorktree: true,
    producesCommits: false,
  },
  {
    name: "documentation",
    column: "In Documentation",
    claudeMdPath: "documentation/CLAUDE.md",
    description: "Documentation Agent — synthesizes project knowledge base",
    usesWorktree: true,
    producesCommits: true,
    serial: true,
    model: "claude-sonnet-5",
    effort: "high",
  },
];

// Literal copy of AUTO_ADVANCE_RULES as of 2026-09-01.
const CLASSIC_RULES_LITERAL = [
  { from: "Backlog",          readyLabel: "done:po",            to: "In Architecture" },
  { from: "In Architecture",  readyLabel: "done:architect",     to: "In Development" },
  { from: "In Development",   readyLabel: "done:developer",     to: "In QA" },
  { from: "In QA",            readyLabel: "done:qa",            to: "In Code Review" },
  { from: "In Code Review",   readyLabel: "done:code-review",   to: "In Documentation" },
  { from: "In Documentation", readyLabel: "done:documentation", to: "Done" },
];

describe("classic stage set — identity with today's pipeline", () => {
  const classic = resolveStageSet(undefined);

  test("agents IS the AGENTS array (same reference, so every derived structure is identical)", () => {
    assert.equal(classic.agents, AGENTS);
  });

  test("advanceRules IS AUTO_ADVANCE_RULES (same reference)", () => {
    assert.equal(classic.advanceRules, AUTO_ADVANCE_RULES);
  });

  test("agents match the literal current values", () => {
    assert.deepStrictEqual(classic.agents, CLASSIC_AGENTS_LITERAL);
  });

  test("advance rules match the literal current values", () => {
    assert.deepStrictEqual(classic.advanceRules, CLASSIC_RULES_LITERAL);
  });

  test("derived poll order (finish-first) is byte-identical to today's", () => {
    assert.deepStrictEqual(
      [...classic.agents].reverse().map((a) => a.name),
      ["documentation", "code-review", "qa", "developer", "architect", "po"],
    );
  });

  test("columnByAgent equals AGENT_COLUMN_MAP", () => {
    assert.deepStrictEqual(classic.columnByAgent, AGENT_COLUMN_MAP);
  });

  test("midPipelineColumns equals MID_PIPELINE_COLUMNS and the literal", () => {
    assert.deepStrictEqual([...classic.midPipelineColumns], [...MID_PIPELINE_COLUMNS]);
    assert.deepStrictEqual(
      [...classic.midPipelineColumns],
      ["In Architecture", "In Development", "In QA", "In Code Review", "In Documentation"],
    );
  });

  test("Agent-tool grants are exactly architect + code-review", () => {
    assert.deepStrictEqual(classic.agentToolNames, new Set(["architect", "code-review"]));
  });

  test("WebSearch grant is architect only", () => {
    assert.deepStrictEqual(classic.webSearchToolNames, new Set(["architect"]));
  });

  test("no pre-spawn gates in classic (feature entirely inert)", () => {
    assert.equal(classic.preSpawnGate, null);
  });

  test("real-claude gate keys: literal current values (done:code-review, needs-rework:developer)", () => {
    assert.deepStrictEqual(classic.realClaudeGate, {
      reviewDoneLabel: "done:code-review",
      failReworkLabel: "needs-rework:developer",
    });
  });

  test("classic budgets unchanged (spot-check through maxTurnsFor / timeoutFor)", () => {
    const byName = new Map(classic.agents.map((a) => [a.name, a]));
    assert.equal(maxTurnsFor(byName.get("po")!), 135);
    assert.equal(maxTurnsFor(byName.get("architect")!), 135);
    assert.equal(maxTurnsFor(byName.get("developer")!), 135);
    assert.equal(maxTurnsFor(byName.get("qa")!), 45);
    assert.equal(maxTurnsFor(byName.get("code-review")!), 150);
    assert.equal(maxTurnsFor(byName.get("documentation")!), 135);
    assert.equal(timeoutFor(byName.get("po")!), 1_200_000);
    assert.equal(timeoutFor(byName.get("architect")!), 1_200_000);
    assert.equal(timeoutFor(byName.get("architect")!, ["security-sensitive"]), 2_400_000);
    assert.equal(timeoutFor(byName.get("developer")!), 1_500_000);
    assert.equal(timeoutFor(byName.get("qa")!), 1_500_000);
    assert.equal(timeoutFor(byName.get("code-review")!), 2_400_000);
    assert.equal(timeoutFor(byName.get("documentation")!), 1_500_000);
  });
});

// --------- Builder set ---------

describe("builder stage set — collapsed four-role pipeline", () => {
  const builder = resolveStageSet("builder");
  const byName = new Map(builder.agents.map((a) => [a.name, a]));

  test("four roles in pipeline order: refiner, builder, verifier, documentation", () => {
    assert.deepStrictEqual(
      builder.agents.map((a) => a.name),
      ["refiner", "builder", "verifier", "documentation"],
    );
  });

  test("poll order (finish-first) is documentation, verifier, builder, refiner", () => {
    assert.deepStrictEqual(
      [...builder.agents].reverse().map((a) => a.name),
      ["documentation", "verifier", "builder", "refiner"],
    );
  });

  test("refiner: Backlog, refiner/CLAUDE.md, no worktree (the PO contract)", () => {
    const refiner = byName.get("refiner")!;
    assert.equal(refiner.column, "Backlog");
    assert.equal(refiner.claudeMdPath, "refiner/CLAUDE.md");
    assert.equal(refiner.usesWorktree, false);
    assert.equal(refiner.producesCommits, false);
    assert.equal(refiner.serial, undefined);
    // PO budgets: base turns, light-tier timeout.
    assert.equal(maxTurnsFor(refiner), 135);
    assert.equal(timeoutFor(refiner), 1_200_000);
  });

  test("builder: In Development, builder/CLAUDE.md, worktree, 200 turns, 40min", () => {
    const b = byName.get("builder")!;
    assert.equal(b.column, "In Development");
    assert.equal(b.claudeMdPath, "builder/CLAUDE.md");
    assert.equal(b.usesWorktree, true);
    assert.equal(b.producesCommits, true);
    assert.equal(maxTurnsFor(b), 200);
    assert.equal(timeoutFor(b), 2_400_000);
  });

  test("verifier: In Code Review, verifier/CLAUDE.md, worktree, code-review budgets (150 turns, 40min)", () => {
    const v = byName.get("verifier")!;
    assert.equal(v.column, "In Code Review");
    assert.equal(v.claudeMdPath, "verifier/CLAUDE.md");
    assert.equal(v.usesWorktree, true);
    assert.equal(v.producesCommits, false, "verifier reviews + labels; it never commits (code-review contract)");
    assert.equal(maxTurnsFor(v), 150);
    assert.equal(timeoutFor(v), 2_400_000);
    assert.equal(v.serial, true, "two verifiers gating at once contend for the host's emulators (2026-09-22)");
  });

  test("verifier is serial: two In Code Review items yield one verifier pick, and a builder still runs beside it", () => {
    // The pre-spawn gates are host-level work (managed emulators, a relay
    // and a daemon on fixed host resources), so a second verifier must
    // wait for the first. The builder in the same cycle is unaffected:
    // the cap buys builder-plus-verifier overlap, never verifier-plus-
    // verifier.
    const item = (n: number, labels: string[] = []) => ({ id: `i${n}`, issueNumber: n, labels });
    const pollOrder = [...builder.agents].reverse();
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["In Code Review", [item(1), item(2)]],
        ["In Development", [item(3)]],
      ]),
      pollOrder,
      maxConcurrent: 3,
    });
    assert.deepStrictEqual(
      r.map((c) => [c.agent.name, c.item.issueNumber]),
      [["verifier", 1], ["builder", 3]],
    );
    const inFlight = selectDispatches({
      itemsByColumn: new Map([
        ["In Code Review", [item(1, ["wip:verifier"]), item(2)]],
        ["In Development", [item(3)]],
      ]),
      pollOrder,
      maxConcurrent: 3,
    });
    assert.deepStrictEqual(
      inFlight.map((c) => [c.agent.name, c.item.issueNumber]),
      [["builder", 3]],
      "an in-flight verifier blocks the second pick but not the builder",
    );
  });

  test("PYRY_VERIFIER_SERIAL=0 hands back the builder set with concurrent verifiers, nothing else changed", () => {
    // A fork opts out of the verifier cap per process, not per code
    // change. Only the verifier's config differs; documentation keeps its
    // cap by reference and the rest of the set is the same objects.
    const concurrent = resolveStageSet("builder", { PYRY_VERIFIER_SERIAL: "0" });
    const v = concurrent.agents.find((a) => a.name === "verifier")!;
    assert.equal(v.serial, false);
    assert.equal(v.column, "In Code Review");
    assert.equal(maxTurnsFor(v), 150);
    for (const name of ["refiner", "builder", "documentation"]) {
      assert.equal(concurrent.agents.find((a) => a.name === name), byName.get(name), `${name} is the same object`);
    }
    assert.equal(concurrent.agents.find((a) => a.name === "documentation")!.serial, true);
    assert.deepStrictEqual(concurrent.preSpawnGate, builder.preSpawnGate);
    const item = (n: number, labels: string[] = []) => ({ id: `i${n}`, issueNumber: n, labels });
    const r = selectDispatches({
      itemsByColumn: new Map([["In Code Review", [item(1), item(2)]]]),
      pollOrder: [...concurrent.agents].reverse(),
      maxConcurrent: 3,
    });
    assert.deepStrictEqual(r.map((c) => c.item.issueNumber), [1, 2], "two verifiers may run at once");
  });

  test("PYRY_VERIFIER_SERIAL keeps the cap for every value but the exact string 0", () => {
    for (const value of [undefined, "", "1", "false", "no", " 0"]) {
      const set = resolveStageSet("builder", { PYRY_VERIFIER_SERIAL: value });
      assert.equal(set, builder, `value ${JSON.stringify(value)} resolves to the default set`);
      assert.equal(set.agents.find((a) => a.name === "verifier")!.serial, true);
    }
    assert.equal(resolveStageSet("classic", { PYRY_VERIFIER_SERIAL: "0" }).name, "classic", "the switch has no effect on classic");
  });

  test("documentation is unchanged from classic (same config object)", () => {
    const docs = byName.get("documentation")!;
    const classicDocs = AGENTS.find((a) => a.name === "documentation")!;
    assert.equal(docs, classicDocs, "builder set must reuse the classic documentation config by reference");
    assert.equal(docs.serial, true, "serial documentation budget carries into the builder set");
    assert.equal(docs.model, "claude-sonnet-5");
    assert.equal(docs.effort, "high");
    assert.equal(maxTurnsFor(docs), 135);
    assert.equal(timeoutFor(docs), 1_500_000);
  });

  test("advance chain: Backlog → In Development → In Code Review → In Documentation → Done", () => {
    assert.deepStrictEqual(builder.advanceRules, [
      { from: "Backlog",          readyLabel: "done:refiner",       to: "In Development" },
      { from: "In Development",   readyLabel: "done:builder",       to: "In Code Review" },
      { from: "In Code Review",   readyLabel: "done:verifier",      to: "In Documentation" },
      { from: "In Documentation", readyLabel: "done:documentation", to: "Done" },
    ]);
  });

  test("In Architecture and In QA are simply absent — no column, no rule, no mid-pipeline entry", () => {
    const absent = ["In Architecture", "In QA"];
    for (const column of absent) {
      assert.ok(
        !builder.agents.some((a) => a.column === column),
        `no builder-set agent may own "${column}" (never polled)`,
      );
      for (const rule of builder.advanceRules) {
        assert.notEqual(rule.from, column, `no rule may advance FROM "${column}"`);
        assert.notEqual(rule.to, column, `no rule may advance INTO "${column}"`);
      }
      assert.ok(
        !builder.midPipelineColumns.includes(column),
        `"${column}" must not count toward the WIP probe`,
      );
    }
  });

  test("midPipelineColumns are the three post-Backlog columns", () => {
    assert.deepStrictEqual(
      [...builder.midPipelineColumns],
      ["In Development", "In Code Review", "In Documentation"],
    );
  });

  test("chain has no gaps and each from-column is owned by its readyLabel's agent (same invariants lib.test.ts locks for classic)", () => {
    assert.equal(builder.advanceRules[0]!.from, "Backlog");
    assert.equal(builder.advanceRules[builder.advanceRules.length - 1]!.to, "Done");
    for (let i = 0; i < builder.advanceRules.length - 1; i++) {
      assert.equal(builder.advanceRules[i]!.to, builder.advanceRules[i + 1]!.from);
    }
    assert.equal(builder.advanceRules.length, builder.agents.length, "one rule per agent");
    for (const rule of builder.advanceRules) {
      const agentName = rule.readyLabel.replace("done:", "");
      assert.equal(rule.from, builder.columnByAgent.get(agentName));
    }
  });

  test("columnByAgent maps all four roles and nothing else", () => {
    assert.deepStrictEqual(
      builder.columnByAgent,
      new Map([
        ["refiner", "Backlog"],
        ["builder", "In Development"],
        ["verifier", "In Code Review"],
        ["documentation", "In Documentation"],
      ]),
    );
  });

  test("Agent-tool grants: builder + verifier; WebSearch: builder only (absorbs the architect's research)", () => {
    assert.deepStrictEqual(builder.agentToolNames, new Set(["builder", "verifier"]));
    assert.deepStrictEqual(builder.webSearchToolNames, new Set(["builder"]));
  });

  test("pre-spawn gates: the verifier is the gated agent", () => {
    assert.ok(builder.preSpawnGate, "builder set must configure the pre-verifier gate");
    assert.deepStrictEqual(builder.preSpawnGate!.agentNames, new Set(["verifier"]));
  });

  test("real-claude gate keys derive from the set: done:verifier triggers, failures route to the builder", () => {
    assert.deepStrictEqual(builder.realClaudeGate, {
      reviewDoneLabel: "done:verifier",
      failReworkLabel: "needs-rework:builder",
    });
  });
});

// --------- Builder set through the pure pipeline decisions ---------

describe("builder stage set — pure decision plumbing", () => {
  const builder = resolveStageSet("builder");
  const item = (id: string, issueNumber: number, labels: string[]) => ({ id, issueNumber, labels });

  test("decideAutoAdvance walks the collapsed chain (done:builder advances In Development → In Code Review)", () => {
    const itemsByColumn = new Map([
      ["In Development", [item("i1", 10, ["done:builder"])]],
    ]);
    const d = decideAutoAdvance(builder.advanceRules, MANUAL_ADVANCE_GATES, itemsByColumn, 0, 2);
    assert.deepStrictEqual(
      d.advances.map((a) => ({ issueNumber: a.issueNumber, toColumn: a.toColumn })),
      [{ issueNumber: 10, toColumn: "In Code Review" }],
    );
  });

  test("decideAutoAdvance promotes Backlog straight into In Development on done:refiner", () => {
    const itemsByColumn = new Map([
      ["Backlog", [item("i2", 11, ["done:refiner"])]],
    ]);
    const d = decideAutoAdvance(builder.advanceRules, MANUAL_ADVANCE_GATES, itemsByColumn, 0, 2);
    assert.deepStrictEqual(
      d.advances.map((a) => ({ issueNumber: a.issueNumber, toColumn: a.toColumn })),
      [{ issueNumber: 11, toColumn: "In Development" }],
    );
  });

  test("decideReworkRoutes sends needs-rework:builder from In Code Review to In Development (the label the verifier's triage applies)", () => {
    const itemsByColumn = new Map([
      ["In Code Review", [item("i3", 12, ["needs-rework:builder"])]],
    ]);
    const routes = decideReworkRoutes(builder.columnByAgent, itemsByColumn);
    assert.equal(routes.length, 1);
    assert.equal(routes[0]!.issueNumber, 12);
    assert.equal(routes[0]!.toColumn, "In Development");
    assert.equal(routes[0]!.triggerLabel, "needs-rework:builder");
  });

  test("decideReworkRoutes ignores classic-only targets under the builder set (needs-rework:developer has no home column)", () => {
    const itemsByColumn = new Map([
      ["In Code Review", [item("i4", 13, ["needs-rework:developer"])]],
    ]);
    const routes = decideReworkRoutes(builder.columnByAgent, itemsByColumn);
    assert.equal(routes.length, 0);
  });

  test("decideRealClaudeGate parks on done:verifier under the builder set's review label", () => {
    const itemsByColumn = new Map([
      ["In Code Review", [item("g1", 20, ["done:verifier", REAL_CLAUDE_GATE_LABEL])]],
    ]);
    const routes = decideRealClaudeGate(itemsByColumn, builder.realClaudeGate.reviewDoneLabel);
    assert.equal(routes.length, 1);
    assert.equal(routes[0]!.issueNumber, 20);
    assert.equal(routes[0]!.toColumn, "Inbox");
  });

  test("decideRealClaudeGate under builder does NOT park on the classic done:code-review (no builder agent emits it)", () => {
    const itemsByColumn = new Map([
      ["In Code Review", [item("g2", 21, ["done:code-review", REAL_CLAUDE_GATE_LABEL])]],
    ]);
    const routes = decideRealClaudeGate(itemsByColumn, builder.realClaudeGate.reviewDoneLabel);
    assert.equal(routes.length, 0);
  });

  test("decideRealClaudeGate default argument stays the classic literal (identity)", () => {
    const itemsByColumn = new Map([
      ["In Code Review", [item("g3", 22, ["done:code-review", REAL_CLAUDE_GATE_LABEL])]],
    ]);
    assert.equal(decideRealClaudeGate(itemsByColumn).length, 1);
  });

  test("decideRealClaudeGateRun selects on the builder review label", () => {
    const parked = [item("g4", 23, ["done:verifier", REAL_CLAUDE_GATE_LABEL])];
    const picked = decideRealClaudeGateRun(parked, builder.realClaudeGate.reviewDoneLabel);
    assert.ok(picked);
    assert.equal(picked!.issueNumber, 23);
    assert.equal(
      decideRealClaudeGateRun(parked),
      null,
      "the classic default must not select a builder-reviewed ticket",
    );
  });

  test("decideGateOutcome('fail') routes with the set's fail rework label", () => {
    const o = decideGateOutcome("fail", builder.realClaudeGate.failReworkLabel);
    assert.equal(o.toColumn, "In Development");
    assert.deepStrictEqual(o.addLabels, ["needs-rework:builder"]);
    const classicO = decideGateOutcome("fail");
    assert.deepStrictEqual(classicO.addLabels, ["needs-rework:developer"], "default stays the classic literal");
  });
});

// --------- activeStageSet (env-memoized singleton) ---------

describe("activeStageSet — resolved once from PYRY_STAGE_SET", () => {
  test("default env → classic", () => {
    withStageSetEnv(undefined, () => {
      assert.equal(activeStageSet().name, "classic");
    });
  });

  test("PYRY_STAGE_SET=builder → builder", () => {
    withStageSetEnv("builder", () => {
      assert.equal(activeStageSet().name, "builder");
    });
  });

  test("memoized: an env change after first resolution does not flip the set mid-process", () => {
    withStageSetEnv("builder", () => {
      assert.equal(activeStageSet().name, "builder");
      process.env.PYRY_STAGE_SET = "classic";
      assert.equal(activeStageSet().name, "builder", "resolution must be startup-stable, not per-call");
    });
  });

  test("garbage env → throws the fail-fast error", () => {
    withStageSetEnv("nonsense", () => {
      assert.throws(() => activeStageSet(), /PYRY_STAGE_SET/);
    });
  });
});

// --------- Verifier gate parsing ---------

describe("parseVerifierGates — same parsing as salvage gates", () => {
  test("unset → the default Go pair", () => {
    assert.deepStrictEqual(parseVerifierGates(undefined), ["go vet ./...", "go build ./..."]);
  });

  test("empty string → zero gates (consumer opted out)", () => {
    assert.deepStrictEqual(parseVerifierGates(""), []);
  });

  test("`;`-delimited commands, trimmed, empties dropped", () => {
    assert.deepStrictEqual(
      parseVerifierGates("  make check ; make build ;; "),
      ["make check", "make build"],
    );
  });
});

// --------- AgentConfig budget overrides (the mechanism the builder set uses) ---------

describe("AgentConfig maxTurns/timeoutMs overrides", () => {
  const base: AgentConfig = {
    name: "code-review",
    column: "In Code Review",
    claudeMdPath: "code-review/CLAUDE.md",
    description: "test",
    usesWorktree: true,
    producesCommits: false,
  };

  test("maxTurns override wins over the name-keyed tier", () => {
    assert.equal(maxTurnsFor({ ...base, maxTurns: 7 }), 7);
    assert.equal(maxTurnsFor(base), 150, "no override → name tier unchanged");
  });

  test("timeoutMs override wins over the name-keyed tier", () => {
    assert.equal(timeoutFor({ ...base, timeoutMs: 60_000 }), 60_000);
    assert.equal(timeoutFor(base), 2_400_000, "no override → name tier unchanged");
  });
});

// Exhaustiveness: STAGE_SET_NAMES is the operator-facing contract the
// fail-fast message prints. Keep it in lockstep with what resolves.
describe("STAGE_SET_NAMES", () => {
  test("every listed name resolves; the list is exactly classic + builder", () => {
    assert.deepStrictEqual([...STAGE_SET_NAMES], ["classic", "builder"]);
    for (const name of STAGE_SET_NAMES) {
      const set: StageSet = resolveStageSet(name);
      assert.equal(set.name, name);
    }
  });
});
