// Unit tests for the pure logic the dispatcher depends on. Run with:
//
//   pnpm test
//
// or directly:
//
//   pnpm exec tsx --test src/lib.test.ts
//
// These tests cover the parts that broke in real life or could break
// silently in the future (path resolution, label parsing, the auto-advance
// chain, agent column consistency). Side-effecting code (GraphQL, gh CLI,
// claude subprocess, worktree management) is not tested here — the
// validation ticket is the integration check for that surface.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { AGENTS } from "./types.js";
import {
  AUTO_ADVANCE_RULES,
  AGENT_COLUMN_MAP,
  MANUAL_ADVANCE_GATES,
  MID_PIPELINE_COLUMNS,
  PIPELINE_LABEL_PREFIXES,
  resolveAgentsRepoRoot,
  resolveAgentsRepoRootWithEnv,
  resolveDefaultBranch,
  resolveTargetRepoRoot,
  isPipelineLabel,
  isPipelineLabelForAgent,
  decidePostRunLabels,
  scrubSpawnEnv,
  SPAWN_ENV_DENYLIST,
  shouldSkipDispatch,
  extractReworkTarget,
  isPipelineInFlight,
  countPipelineInFlight,
  isMergeConflictError,
  decideAutoAdvance,
  decideReworkRoutes,
  decideDoneCleanup,
  shouldAutoCommit,
  shouldUseWorktree,
  shouldProduceCommits,
  parseCommitsAhead,
  shouldFlagEmptyBranch,
  decideCodegraphSymlink,
  hasOpenBlockers,
  shouldSkipBlockedFor,
  extractReworkCount,
  REWORK_LOOP_THRESHOLD,
  findAdvanceRule,
  maxTurnsFor,
  parseSalvageGates,
  shouldAttemptSafeSalvage,
  findReadyPrNumber,
  extractRateLimitInfo,
  shouldAddReadyLabel,
  selectDispatches,
  decideBranchSetup,
  findWorktreesForBranch,
} from "./lib.js";

describe("resolveAgentsRepoRoot", () => {
  test("resolves to agents/ from agents/dispatch/src/ (the bug from c72adb4)", () => {
    // The original bug used "../../.." and landed at the parent of agents/
    // (the pyrycode/ Go repo). The fix is "../..". Lock it in.
    const got = resolveAgentsRepoRoot("/work/pyrycode/agents/dispatch/src");
    assert.equal(got, "/work/pyrycode/agents");
  });

  test("normalizes trailing slashes", () => {
    const got = resolveAgentsRepoRoot("/work/pyrycode/agents/dispatch/src/");
    assert.equal(got, "/work/pyrycode/agents");
  });
});

describe("resolveTargetRepoRoot", () => {
  test("resolves to the parent of agents/ — the target repo", () => {
    // agents/ lives INSIDE the target repo, so target root = parent of agents/.
    // The original code had `agentsRepoRoot + "../pyrycode"`, which only
    // "worked" when agentsRepoRoot was buggy and pointed at pyrycode/.
    // Once that bug was fixed, this one surfaced — pyrycode/pyrycode/
    // doesn't exist. Lock the corrected derivation in.
    const got = resolveTargetRepoRoot("/work/pyrycode/agents");
    assert.equal(got, "/work/pyrycode");
  });

  test("works for any consumer repo, not just pyrycode", () => {
    // The dispatcher source is shared across forks (pyrycode-mobile-agents,
    // pyrycode-relay-agents). Each fork's agents/ lives inside its own
    // target repo; this resolver must not assume the name is "pyrycode".
    assert.equal(
      resolveTargetRepoRoot("/work/pyrycode-mobile/agents"),
      "/work/pyrycode-mobile",
    );
    assert.equal(
      resolveTargetRepoRoot("/work/pyrycode-relay/agents"),
      "/work/pyrycode-relay",
    );
  });

  test("composes correctly with resolveAgentsRepoRoot", () => {
    // End-to-end: from a hypothetical src/ directory, the pair of
    // resolvers should land back at the target repo root.
    const agentsRoot = resolveAgentsRepoRoot("/work/pyrycode/agents/dispatch/src");
    const targetRoot = resolveTargetRepoRoot(agentsRoot);
    assert.equal(targetRoot, "/work/pyrycode");
  });
});

describe("resolveAgentsRepoRootWithEnv", () => {
  // The env-var precedence layer over `resolveAgentsRepoRoot`. Mirrors
  // the existing pattern for `TARGET_REPO_PATH`/`resolveTargetRepoRoot`
  // (added 2026-05-09). Reason for the layer: once the dispatcher source
  // moves out of `agents/dispatch/src/` and into a standalone repo
  // (`pyrycode/agent-dispatcher`), `__dirname`-based walk-up returns the
  // wrong tree. Consumers set AGENTS_REPO_PATH explicitly via their
  // bin/pyry-start launcher; the walk-up fallback exists only as a
  // convenience for in-repo `pnpm exec tsx` invocations during the
  // pre-split window.

  test("env value takes precedence over the srcDir fallback", () => {
    const got = resolveAgentsRepoRootWithEnv({
      envValue: "/explicit/agents",
      fallbackSrcDir: "/work/pyrycode/agents/dispatch/src",
    });
    assert.equal(got, "/explicit/agents");
  });

  test("falls back to resolveAgentsRepoRoot when env value is undefined", () => {
    const got = resolveAgentsRepoRootWithEnv({
      envValue: undefined,
      fallbackSrcDir: "/work/pyrycode/agents/dispatch/src",
    });
    assert.equal(got, "/work/pyrycode/agents");
  });

  test("treats empty string env value as unset (falls back)", () => {
    // process.env.X is "" (not undefined) when the var is exported but
    // empty. Treat it as unset so an accidental `AGENTS_REPO_PATH=` line
    // in .env doesn't silently resolve to the CWD.
    const got = resolveAgentsRepoRootWithEnv({
      envValue: "",
      fallbackSrcDir: "/work/pyrycode/agents/dispatch/src",
    });
    assert.equal(got, "/work/pyrycode/agents");
  });

  test("normalizes the env value (resolves relative segments)", () => {
    // Symmetry with resolve(process.env.TARGET_REPO_PATH). An absolute
    // path with a `..` segment in the middle should normalize.
    const got = resolveAgentsRepoRootWithEnv({
      envValue: "/work/pyrycode/foo/../agents",
      fallbackSrcDir: "/anywhere/else",
    });
    assert.equal(got, "/work/pyrycode/agents");
  });
});

describe("resolveDefaultBranch", () => {
  // Lets consumers configure their target repo's default branch via
  // TARGET_DEFAULT_BRANCH env var. Pyrycode + relay + mobile all use
  // `main`, so the fallback covers today's deployments without any
  // .env updates. Forks targeting `master` or trunk-based variants set
  // the env var explicitly.

  test("env value takes precedence over the fallback", () => {
    assert.equal(resolveDefaultBranch("master"), "master");
  });

  test("falls back to 'main' when env value is undefined", () => {
    assert.equal(resolveDefaultBranch(undefined), "main");
  });

  test("treats empty string as unset (falls back to 'main')", () => {
    // An accidental `TARGET_DEFAULT_BRANCH=` line in .env shouldn't
    // silently turn into an empty branch name and break every git
    // command — fall back instead.
    assert.equal(resolveDefaultBranch(""), "main");
  });
});

describe("isPipelineLabel", () => {
  test("matches all four pipeline prefixes", () => {
    assert.equal(isPipelineLabel("ready:po"), true);
    assert.equal(isPipelineLabel("needs-rework:developer"), true);
    assert.equal(isPipelineLabel("wip:architect"), true);
    assert.equal(isPipelineLabel("error:code-review"), true);
  });

  test("rejects non-pipeline labels", () => {
    assert.equal(isPipelineLabel("size:s"), false);
    assert.equal(isPipelineLabel("enhancement"), false);
    assert.equal(isPipelineLabel("bug"), false);
    assert.equal(isPipelineLabel(""), false);
  });

  test("rejects legacy labels that look pipeline-ish but aren't", () => {
    // The old labels existed before the per-agent prefix scheme.
    assert.equal(isPipelineLabel("ready-for-review"), false);
    assert.equal(isPipelineLabel("needs-rework"), false);
  });
});

describe("isPipelineLabelForAgent", () => {
  // The pre-dispatch strip loop must scope cleanup to the dispatching
  // agent's labels — stripping `error:OTHER_AGENT` silently erases a
  // human-actionable failure signal from a prior run on a different agent.

  test("matches the agent's own pipeline labels", () => {
    assert.equal(isPipelineLabelForAgent("ready:developer", "developer"), true);
    assert.equal(isPipelineLabelForAgent("wip:developer", "developer"), true);
    assert.equal(isPipelineLabelForAgent("error:developer", "developer"), true);
    assert.equal(isPipelineLabelForAgent("needs-rework:developer", "developer"), true);
  });

  test("does NOT match other agents' pipeline labels (the bug)", () => {
    // Dispatching `architect`, an `error:developer` left as a breadcrumb
    // by a prior dev run is NOT the architect dispatch's concern.
    assert.equal(isPipelineLabelForAgent("error:developer", "architect"), false);
    assert.equal(isPipelineLabelForAgent("ready:po", "architect"), false);
    assert.equal(isPipelineLabelForAgent("wip:code-review", "developer"), false);
    assert.equal(isPipelineLabelForAgent("needs-rework:po", "developer"), false);
  });

  test("does NOT match prefix collisions (developer vs developer-foo)", () => {
    // `error:developer-foo` should not match agent `developer`, even though
    // the prefix `error:developer` is a substring.
    assert.equal(isPipelineLabelForAgent("error:developer-foo", "developer"), false);
  });

  test("rejects non-pipeline labels", () => {
    assert.equal(isPipelineLabelForAgent("bug", "developer"), false);
    assert.equal(isPipelineLabelForAgent("size:s", "developer"), false);
    assert.equal(isPipelineLabelForAgent("", "developer"), false);
  });

  test("rejects legacy non-prefixed labels", () => {
    assert.equal(isPipelineLabelForAgent("needs-rework", "developer"), false);
    assert.equal(isPipelineLabelForAgent("ready-for-review", "developer"), false);
  });
});

describe("shouldSkipDispatch", () => {
  test("skips when ANY of the four prefixes is set for the same agent", () => {
    for (const prefix of PIPELINE_LABEL_PREFIXES) {
      assert.equal(
        shouldSkipDispatch([`${prefix}developer`], "developer"),
        true,
        `should skip on ${prefix}developer for agent developer`,
      );
    }
  });

  test("does NOT skip when only OTHER agents' labels are present", () => {
    // The bug this guards against: stripping all pipeline labels would
    // skip dispatch even for agents that haven't run yet.
    assert.equal(
      shouldSkipDispatch(["ready:po", "ready:architect", "wip:developer"], "code-review"),
      false,
    );
  });

  test("does NOT skip on empty labels", () => {
    assert.equal(shouldSkipDispatch([], "developer"), false);
  });

  test("does NOT skip on non-pipeline labels", () => {
    assert.equal(shouldSkipDispatch(["enhancement", "size:m"], "developer"), false);
  });

  test("matches every agent in AGENTS without panicking on hyphens", () => {
    // 'code-review' has a hyphen — make sure prefix concatenation works.
    for (const agent of AGENTS) {
      assert.equal(shouldSkipDispatch([`ready:${agent.name}`], agent.name), true);
      assert.equal(shouldSkipDispatch([], agent.name), false);
    }
  });

  test("error:max_turns_salvaged blocks ALL agents until human triages", () => {
    // The salvaged label sits on a ticket whose work is preserved as a
    // draft PR awaiting human review. WITHOUT this gate, the next
    // dispatch cycle would re-dispatch the same agent, hit max_turns
    // again, and the existing PR-already-exists salvage path would
    // treat the open draft PR as success — auto-advancing partial work
    // to code-review with `ready:<agent>`. That's exactly what the
    // safer-salvage design is meant to prevent. The label must block
    // dispatch on every agent until a human triages and removes it.
    for (const agent of AGENTS) {
      assert.equal(
        shouldSkipDispatch(["error:max_turns_salvaged"], agent.name),
        true,
        `error:max_turns_salvaged should block dispatch for ${agent.name}`,
      );
    }
  });

  test("error:max_turns_salvaged combines with size labels safely", () => {
    // Real ticket state after salvage: salvaged label + the original
    // size label. Skip should still fire.
    assert.equal(
      shouldSkipDispatch(["size:s", "error:max_turns_salvaged"], "developer"),
      true,
    );
  });

  test("error:merge-conflict blocks ALL agents until human resolves the conflict", () => {
    // The conflict label sits on a Done-column ticket whose PR can't be
    // auto-merged because main has moved. WITHOUT a global block, the
    // dispatcher's auto-merge loop retries every cycle and burns
    // GraphQL points indefinitely. WITH the block, the per-agent
    // dispatch path also skips the ticket, which doesn't matter much
    // (the ticket is in Done) but keeps the semantics consistent —
    // any global-block label means "human, look at this."
    for (const agent of AGENTS) {
      assert.equal(
        shouldSkipDispatch(["error:merge-conflict"], agent.name),
        true,
        `error:merge-conflict should block dispatch for ${agent.name}`,
      );
    }
  });
});

describe("isMergeConflictError", () => {
  // The dispatcher's auto-merge block runs `gh pr merge` on Done-column
  // tickets. When the PR conflicts with main, gh prints a deterministic
  // error to stderr. The dispatcher uses this predicate to detect that
  // case and add `error:merge-conflict` (a global block) instead of
  // looping on the same retry every cycle.

  test("matches the canonical 'is not mergeable' phrase from gh CLI", () => {
    // Verbatim shape from the live 2026-05-08 incident logs:
    //   X Pull request pyrycode/pyrycode#193 is not mergeable: the merge commit cannot be cleanly created.
    const stderr = "X Pull request pyrycode/pyrycode#193 is not mergeable: the merge commit cannot be cleanly created.";
    assert.equal(isMergeConflictError(stderr), true);
  });

  test("matches the 'merge commit cannot be cleanly created' phrase alone", () => {
    // Robust against gh shortening the prefix in a future version.
    assert.equal(
      isMergeConflictError("the merge commit cannot be cleanly created"),
      true,
    );
  });

  test("matches the lowercase 'merge conflict' phrase (older gh / alt tooling)", () => {
    assert.equal(isMergeConflictError("error: merge conflict in foo.go"), true);
  });

  test("is case-insensitive", () => {
    // gh's wording capitalisation has shifted across versions; don't
    // tie our gate to a specific casing.
    assert.equal(
      isMergeConflictError("PULL REQUEST IS NOT MERGEABLE: blah"),
      true,
    );
  });

  test("does NOT match unrelated gh errors", () => {
    // Non-merge-conflict failure modes (network, auth, missing PR) must
    // NOT trigger the merge-conflict label — they're transient and
    // labelling them would block tickets that just need a retry.
    assert.equal(isMergeConflictError("could not find pull request"), false);
    assert.equal(isMergeConflictError("network is unreachable"), false);
    assert.equal(isMergeConflictError("HTTP 403: rate limit exceeded"), false);
    assert.equal(isMergeConflictError("authentication required"), false);
  });

  test("returns false for empty / undefined / null input", () => {
    // Some execSync errors set `stderr` to empty when the failure
    // happened before the subprocess could write anything. Don't
    // false-positive on those.
    assert.equal(isMergeConflictError(""), false);
    assert.equal(isMergeConflictError(undefined), false);
    assert.equal(isMergeConflictError(null), false);
  });

  test("does not match partial-keyword false positives", () => {
    // 'merge' alone, or 'conflict' alone, should NOT match — too broad.
    assert.equal(isMergeConflictError("ready to merge"), false);
    assert.equal(isMergeConflictError("name conflict in resource"), false);
  });
});

describe("extractReworkTarget", () => {
  test("extracts agent name from valid rework labels", () => {
    assert.equal(extractReworkTarget("needs-rework:po"), "po");
    assert.equal(extractReworkTarget("needs-rework:architect"), "architect");
    assert.equal(extractReworkTarget("needs-rework:code-review"), "code-review");
    assert.equal(extractReworkTarget("needs-rework:documentation"), "documentation");
  });

  test("returns null for non-rework labels", () => {
    assert.equal(extractReworkTarget("ready:po"), null);
    assert.equal(extractReworkTarget("wip:developer"), null);
    assert.equal(extractReworkTarget("size:s"), null);
    assert.equal(extractReworkTarget(""), null);
  });

  test("returns null for the malformed empty-target form", () => {
    // Someone could type just `needs-rework:` without a target. Should
    // not silently succeed with an empty agent name.
    assert.equal(extractReworkTarget("needs-rework:"), null);
  });

  test("does NOT match the legacy 'needs-rework' label (no colon)", () => {
    // The pre-prefix legacy label is stripped separately in pollLoop.
    assert.equal(extractReworkTarget("needs-rework"), null);
  });
});

describe("AUTO_ADVANCE_RULES", () => {
  test("first rule starts at Backlog, last rule ends at Done", () => {
    assert.equal(AUTO_ADVANCE_RULES[0].from, "Backlog");
    assert.equal(AUTO_ADVANCE_RULES[AUTO_ADVANCE_RULES.length - 1].to, "Done");
  });

  test("Inbox is human-gated — no auto-advance rule references it", () => {
    // Inbox is the human's column: anyone can create issues there, but no
    // agent operates on Inbox tickets. Promotion to Backlog is a manual
    // gesture (status edit). This test locks in the invariant.
    for (const rule of AUTO_ADVANCE_RULES) {
      assert.notEqual(
        rule.from,
        "Inbox",
        `rule ${rule.readyLabel}: from must not be "Inbox" (human-gated column)`,
      );
      assert.notEqual(
        rule.to,
        "Inbox",
        `rule ${rule.readyLabel}: to must not be "Inbox" (PO demotes via direct status edit, not auto-advance)`,
      );
    }
  });

  test("chain has no gaps (each rule's `to` matches the next rule's `from`)", () => {
    // If a refactor splits a column or renames it, this catches the drift.
    for (let i = 0; i < AUTO_ADVANCE_RULES.length - 1; i++) {
      assert.equal(
        AUTO_ADVANCE_RULES[i].to,
        AUTO_ADVANCE_RULES[i + 1].from,
        `rule ${i} ends at ${AUTO_ADVANCE_RULES[i].to} but rule ${i + 1} starts at ${AUTO_ADVANCE_RULES[i + 1].from}`,
      );
    }
  });

  test("every readyLabel matches a known agent", () => {
    const knownAgents = new Set(AGENTS.map((a) => a.name));
    for (const rule of AUTO_ADVANCE_RULES) {
      const agentName = rule.readyLabel.replace("ready:", "");
      assert.ok(
        knownAgents.has(agentName),
        `rule readyLabel ${rule.readyLabel} references unknown agent ${agentName}`,
      );
    }
  });

  test("each rule's `from` column is owned by its readyLabel's agent", () => {
    // The `from` column should be the column of the agent whose `ready:`
    // label triggers the advance — i.e. PO's column is Backlog, architect's
    // is In Architecture, etc.
    for (const rule of AUTO_ADVANCE_RULES) {
      const agentName = rule.readyLabel.replace("ready:", "");
      const expectedColumn = AGENT_COLUMN_MAP.get(agentName);
      assert.equal(
        rule.from,
        expectedColumn,
        `rule ${rule.readyLabel} should advance from agent's column (${expectedColumn}), got ${rule.from}`,
      );
    }
  });

  test("five rules — one per agent (no missing or extra stages)", () => {
    assert.equal(AUTO_ADVANCE_RULES.length, AGENTS.length);
  });
});

describe("MANUAL_ADVANCE_GATES", () => {
  test("every gated column is a known `from` in AUTO_ADVANCE_RULES", () => {
    // A gate on a column that doesn't appear in AUTO_ADVANCE_RULES is
    // dead config — the auto-advance loop never iterates over it, so
    // the gate has no effect. Catch that drift here.
    const knownFromColumns = new Set(AUTO_ADVANCE_RULES.map(r => r.from));
    for (const gated of MANUAL_ADVANCE_GATES) {
      assert.ok(
        knownFromColumns.has(gated),
        `MANUAL_ADVANCE_GATES references "${gated}" but no AUTO_ADVANCE_RULES rule has that as a "from" column`,
      );
    }
  });

  test("currently no gates — pipeline runs end-to-end without forced human pauses (2026-05-02)", () => {
    // The architect → developer human gate was added on 2026-05-01 as a
    // safety net for oversized specs, then removed on 2026-05-02 once
    // the size policy was enforced in code (architect either sizes ≤M
    // or splits via needs-rework:po). The gate was duplicating safeguards.
    //
    // Adding a future gate is a deliberate policy decision and should
    // require updating this test. The set is the durable record of
    // "what's gated right now"; emptiness is meaningful.
    assert.equal(MANUAL_ADVANCE_GATES.size, 0);
  });

  test("Done is not gated (terminal column needs no further advance)", () => {
    // Sanity check: even if a future policy adds a gate, Done shouldn't
    // be in the set — gating a terminal column does nothing.
    assert.ok(!MANUAL_ADVANCE_GATES.has("Done"));
  });
});

describe("MID_PIPELINE_COLUMNS", () => {
  test("excludes Inbox, Backlog, Done", () => {
    // Mid-pipeline = "in flight." Inbox and Backlog are pre-flight,
    // Done is post-flight. Locks the capacity-cap rule's intent
    // (Backlog holds when `inFlightCount >= maxConcurrent`).
    for (const off of ["Inbox", "Backlog", "Done"]) {
      assert.ok(
        !MID_PIPELINE_COLUMNS.includes(off),
        `MID_PIPELINE_COLUMNS must not include "${off}"`,
      );
    }
  });

  test("every entry is a known agent column", () => {
    // A column in MID_PIPELINE_COLUMNS that no agent owns is dead config.
    const agentColumns = new Set(AGENT_COLUMN_MAP.values());
    for (const col of MID_PIPELINE_COLUMNS) {
      assert.ok(
        agentColumns.has(col),
        `MID_PIPELINE_COLUMNS references "${col}" but no agent owns it`,
      );
    }
  });

  test("contains every non-PO agent column", () => {
    // The capacity cap counts every non-PO agent column toward
    // in-flight load. PO's column (Backlog) is pre-flight (refinement
    // doesn't consume a pipeline seat), so every non-PO agent column
    // must be in MID_PIPELINE_COLUMNS for the cap to bite uniformly.
    for (const [name, col] of AGENT_COLUMN_MAP) {
      if (name === "po") continue; // PO owns Backlog, which is pre-flight
      assert.ok(
        MID_PIPELINE_COLUMNS.includes(col),
        `${name}'s column "${col}" should be in MID_PIPELINE_COLUMNS`,
      );
    }
  });
});

describe("isPipelineInFlight", () => {
  test("empty input → not in flight", () => {
    // Pristine pipeline. Backlog should be free to advance.
    assert.equal(isPipelineInFlight([]), false);
  });

  test("any non-errored ticket counts as in flight", () => {
    // The most common case: a ticket actively progressing.
    assert.equal(
      isPipelineInFlight([{ issueNumber: 28, labels: ["size:s", "ready:architect"] }]),
      true,
    );
  });

  test("ticket with no labels still counts (just-arrived in column)", () => {
    // A ticket that just got promoted to a mid-pipeline column may have
    // had its agent labels stripped by the dispatch loop. It's still in
    // flight — about to be dispatched on.
    assert.equal(isPipelineInFlight([{ issueNumber: 42, labels: [] }]), true);
  });

  test("error-labelled ticket does NOT count", () => {
    // Errored tickets are stuck on exceptional human action. Unrelated
    // work shouldn't be blocked behind them.
    assert.equal(
      isPipelineInFlight([{ issueNumber: 99, labels: ["error:developer"] }]),
      false,
    );
  });

  test("any error: prefix excludes (not just specific agents)", () => {
    // Confirms the prefix-match approach. error:parked, error:human-blocked,
    // and any future variant should all park the ticket.
    for (const variant of ["error:po", "error:parked", "error:human-blocked"]) {
      assert.equal(
        isPipelineInFlight([{ issueNumber: 99, labels: [variant] }]),
        false,
        `${variant} should exclude from in-flight`,
      );
    }
  });

  test("mixed: errored + non-errored → in flight", () => {
    // If even one non-errored ticket is mid-pipeline, hold Backlog.
    // The errored one is parked; the other one is real work.
    assert.equal(
      isPipelineInFlight([
        { issueNumber: 99, labels: ["error:developer"] },
        { issueNumber: 28, labels: ["ready:architect"] },
      ]),
      true,
    );
  });

  test("non-issue items (issueNumber <= 0) are ignored", () => {
    // Project items without an issue (drafts, epics) shouldn't trigger
    // the WIP gate. Locks the issueNumber > 0 guard.
    assert.equal(
      isPipelineInFlight([{ issueNumber: 0, labels: [] }]),
      false,
    );
    assert.equal(
      isPipelineInFlight([{ issueNumber: -1, labels: ["ready:po"] }]),
      false,
    );
  });

  test("all errored → not in flight", () => {
    // Pipeline full of stuck tickets. New work should be allowed in.
    assert.equal(
      isPipelineInFlight([
        { issueNumber: 99, labels: ["error:developer"] },
        { issueNumber: 100, labels: ["error:parked"] },
      ]),
      false,
    );
  });
});

describe("decideAutoAdvance", () => {
  // Helper to build the itemsByColumn map ergonomically.
  type Item = { id: string; issueNumber: number; labels: string[]; blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[] };
  const items = (...rows: [string, Item[]][]): Map<string, Item[]> => new Map(rows);

  test("empty pipeline → no advances, no holds, no gates", () => {
    const d = decideAutoAdvance(AUTO_ADVANCE_RULES, MANUAL_ADVANCE_GATES, items(), 0, 1);
    assert.deepEqual(d.advances, []);
    assert.deepEqual(d.backlogHeld, []);
    assert.deepEqual(d.gatedAwaiting, []);
  });

  test("single ready:po in Backlog, pipeline empty → advance to In Architecture", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["ready:po", "size:s"] }]]),
      0,
      1,
    );
    assert.equal(d.advances.length, 1);
    assert.deepEqual(d.advances[0], {
      itemId: "i1",
      issueNumber: 28,
      fromColumn: "Backlog",
      toColumn: "In Architecture",
    });
    assert.deepEqual(d.backlogHeld, []);
  });

  test("two ready:po in Backlog at maxConcurrent=1, pipeline empty → first advances, second held", () => {
    // With WIP=1 (legacy mode, PYRY_MAX_CONCURRENT=1), only one Backlog
    // ticket may enter the pipeline per cycle. This is the b39f569 fix
    // semantic: without the within-cycle cap, both #28 and #29 would
    // have advanced together when the pipeline could only accept one.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i1", issueNumber: 28, labels: ["ready:po", "size:s"] },
        { id: "i2", issueNumber: 29, labels: ["ready:po", "size:s"] },
      ]]),
      0,
      1,
    );
    assert.equal(d.advances.length, 1);
    assert.equal(d.advances[0].issueNumber, 28);
    assert.deepEqual(d.backlogHeld, [29]);
  });

  test("Backlog advance picks items from input order (board POSITION) at maxConcurrent=1", () => {
    // The pure function trusts the caller's input order. The caller
    // (`runAutoAdvance`) queries GraphQL with `orderBy: { field: POSITION,
    // direction: ASC }`, which returns items in board-position order
    // (top of column first). Manual board reordering by humans is the
    // priority signal — we respect it.
    //
    // Insert #29 ahead of #28 to prove the function takes input order
    // verbatim, NOT issueNumber. The earlier "sort by issueNumber" rule
    // (3abe7a3) was wrong: it ignored the user's manual board ordering.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i2", issueNumber: 29, labels: ["ready:po"] },
        { id: "i1", issueNumber: 28, labels: ["ready:po"] },
      ]]),
      0,
      1,
    );
    assert.equal(d.advances.length, 1);
    assert.equal(d.advances[0].issueNumber, 29);
    assert.deepEqual(d.backlogHeld, [28]);
  });

  test("backlogHeld preserves input order (board POSITION)", () => {
    // When multiple items are held, the held list is in input order
    // (which is board POSITION from the GraphQL query). Heartbeat output
    // matches what the user sees on the project board top-to-bottom.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i3", issueNumber: 31, labels: ["ready:po"] },
        { id: "i1", issueNumber: 28, labels: ["ready:po"] },
        { id: "i2", issueNumber: 30, labels: ["ready:po"] },
      ]]),
      0,
      1,
    );
    // First eligible (input order) = #31; held = [#28, #30] in input order
    // (NOT [28, 30, 31] sorted, NOT [31, 30, 28] reversed).
    assert.equal(d.advances[0].issueNumber, 31);
    assert.deepEqual(d.backlogHeld, [28, 30]);
  });

  test("ready:po in Backlog while pipeline at capacity → all held, no advance", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 29, labels: ["ready:po"] }]]),
      1,
      1,
    );
    assert.deepEqual(d.advances, []);
    assert.deepEqual(d.backlogHeld, [29]);
  });

  test("gated column skips advance and reports in gatedAwaiting (mechanism test)", () => {
    // Tests the GATING MECHANISM independent of which columns are
    // currently gated in production. Production MANUAL_ADVANCE_GATES is
    // empty as of 2026-05-02 (the architect→developer gate was removed
    // once the size policy was enforced in code). Pass a custom set so
    // this test still exercises the function's gating behaviour even
    // when production policy doesn't gate anything.
    const customGates: ReadonlySet<string> = new Set(["In Architecture"]);
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      customGates,
      items(["In Architecture", [{ id: "i1", issueNumber: 28, labels: ["ready:architect"] }]]),
      1,
      1,
    );
    assert.deepEqual(d.advances, []);
    assert.equal(d.gatedAwaiting.length, 1);
    assert.equal(d.gatedAwaiting[0].column, "In Architecture");
    assert.deepEqual(d.gatedAwaiting[0].itemNumbers, [28]);
  });

  test("needs-rework label blocks advance even with ready:po", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["ready:po", "needs-rework:po"] }]]),
      0,
      1,
    );
    assert.deepEqual(d.advances, []);
  });

  test("error label blocks advance even with ready:po", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["ready:po", "error:po"] }]]),
      0,
      1,
    );
    assert.deepEqual(d.advances, []);
  });

  test("non-issue items (issueNumber <= 0) skip", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 0, labels: ["ready:po"] }]]),
      0,
      1,
    );
    assert.deepEqual(d.advances, []);
  });

  test("missing readyLabel → no advance", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["size:s"] }]]),
      0,
      1,
    );
    assert.deepEqual(d.advances, []);
  });

  test("mid-pipeline advance proceeds even when pipeline at capacity", () => {
    // A ticket sitting in In Development with ready:developer should advance
    // to In Code Review even though another ticket sits at In Architecture.
    // The cap holds NEW tickets out of the pipeline; in-flight tickets keep
    // flowing forward regardless.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(
        ["In Architecture", [{ id: "i1", issueNumber: 28, labels: ["ready:architect"] }]],
        ["In Development",  [{ id: "i2", issueNumber: 30, labels: ["ready:developer"] }]],
      ),
      1,
      1,
    );
    const devAdvance = d.advances.find(a => a.fromColumn === "In Development");
    assert.ok(devAdvance, "expected an advance from In Development");
    assert.equal(devAdvance!.issueNumber, 30);
    assert.equal(devAdvance!.toColumn, "In Code Review");
  });

  test("blocked Backlog item does not auto-advance (stays in Backlog until unblocked)", () => {
    // A blocked ticket can be PO-refined (ready:po set) but should not
    // auto-advance to In Architecture while blockers are open. Keeps
    // the board state honest: blocked tickets stay in the queue, not
    // the architect's column.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{
        id: "i1",
        issueNumber: 45,
        labels: ["ready:po", "size:s"],
        blockedBy: [{ number: 40, state: "OPEN" }],
      }]]),
      0,
      1,
    );
    assert.deepEqual(d.advances, []);
  });

  test("CLOSED-only blockers don't prevent advance (dependencies satisfied)", () => {
    // Once the blocker closes, the ticket is free to advance. Locks
    // the "any-OPEN-blocker holds" semantic.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{
        id: "i1",
        issueNumber: 45,
        labels: ["ready:po", "size:s"],
        blockedBy: [{ number: 40, state: "CLOSED" }],
      }]]),
      0,
      1,
    );
    assert.equal(d.advances.length, 1);
    assert.equal(d.advances[0].issueNumber, 45);
  });

  test("multiple mid-pipeline advances in one decision", () => {
    // Unusual but possible: dev finishes ticket X, code-review finishes ticket Y,
    // both ready in same cycle. Both should advance.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(
        ["In Development", [{ id: "i1", issueNumber: 30, labels: ["ready:developer"] }]],
        ["In Code Review", [{ id: "i2", issueNumber: 31, labels: ["ready:code-review"] }]],
      ),
      2,
      2,
    );
    assert.equal(d.advances.length, 2);
    assert.ok(d.advances.some(a => a.issueNumber === 30 && a.toColumn === "In Code Review"));
    assert.ok(d.advances.some(a => a.issueNumber === 31 && a.toColumn === "In Documentation"));
  });

  // ----- WIP=N cap on Backlog promotion (2026-05-08 fix) -----
  //
  // Before the fix, `decideAutoAdvance` advanced at most ONE Backlog ticket
  // per cycle even when `selectDispatches` had room for N. Refined
  // `ready:po` tickets piled up in Backlog while only one drained per cycle,
  // so PO frontran the queue (consuming the second WIP slot for new
  // refinement work) while the pipeline ran serially. Concurrency was a
  // mirage. These tests lock in the new capacity-bounded behaviour.

  test("WIP=N: two ready:po, no in-flight, max=2 → both advance same cycle", () => {
    // The bug case. Pre-fix: only #28 advanced; #29 stayed `ready:po` in
    // Backlog and waited a full cycle for the next promotion slot. Post-fix:
    // capacity = max(0, 2 - 0) = 2 → both go.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i1", issueNumber: 28, labels: ["ready:po"] },
        { id: "i2", issueNumber: 29, labels: ["ready:po"] },
      ]]),
      0,
      2,
    );
    assert.equal(d.advances.length, 2);
    assert.equal(d.advances[0].issueNumber, 28);
    assert.equal(d.advances[1].issueNumber, 29);
    assert.deepEqual(d.backlogHeld, []);
  });

  test("WIP=N: more eligible than capacity → advance up to capacity, hold the rest in input order", () => {
    // Five refined tickets, no in-flight, max=2. Top two by board position
    // advance; remaining three held in input (board POSITION) order.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i1", issueNumber: 28, labels: ["ready:po"] },
        { id: "i2", issueNumber: 29, labels: ["ready:po"] },
        { id: "i3", issueNumber: 30, labels: ["ready:po"] },
        { id: "i4", issueNumber: 31, labels: ["ready:po"] },
        { id: "i5", issueNumber: 32, labels: ["ready:po"] },
      ]]),
      0,
      2,
    );
    assert.deepEqual(d.advances.map(a => a.issueNumber), [28, 29]);
    assert.deepEqual(d.backlogHeld, [30, 31, 32]);
  });

  test("WIP=N: partial in-flight reduces capacity → advance fills only remaining seats", () => {
    // Pipeline already has one thread running (e.g. an in-flight architect run).
    // Capacity = max(0, 2 - 1) = 1. Only one Backlog ticket advances even
    // though three are eligible.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i1", issueNumber: 28, labels: ["ready:po"] },
        { id: "i2", issueNumber: 29, labels: ["ready:po"] },
        { id: "i3", issueNumber: 30, labels: ["ready:po"] },
      ]]),
      1,
      2,
    );
    assert.deepEqual(d.advances.map(a => a.issueNumber), [28]);
    assert.deepEqual(d.backlogHeld, [29, 30]);
  });

  test("WIP=N: pipeline at capacity (inFlight == max) → all eligible held", () => {
    // Two threads already running, max=2 → capacity=0. Backlog freezes
    // until a thread completes and frees a seat.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 30, labels: ["ready:po"] }]]),
      2,
      2,
    );
    assert.deepEqual(d.advances, []);
    assert.deepEqual(d.backlogHeld, [30]);
  });

  test("WIP=N: in-flight count exceeding max (transient) clamps capacity to 0", () => {
    // Defensive: if an external mutation (manual board edit, error-recovery
    // restart) leaves more tickets mid-pipeline than the configured cap,
    // capacity must not go negative. Backlog stays held until the pipeline
    // drains back below the cap.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 30, labels: ["ready:po"] }]]),
      5,
      2,
    );
    assert.deepEqual(d.advances, []);
    assert.deepEqual(d.backlogHeld, [30]);
  });

  test("WIP=N: maxConcurrent=0 holds all eligible Backlog (degenerate config)", () => {
    // Boundary: a misconfigured cap of 0 must not advance anything from
    // Backlog. Mid-pipeline rules are independent of the cap.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i1", issueNumber: 28, labels: ["ready:po"] },
        { id: "i2", issueNumber: 29, labels: ["ready:po"] },
      ]]),
      0,
      0,
    );
    assert.deepEqual(d.advances, []);
    assert.deepEqual(d.backlogHeld, [28, 29]);
  });
});

describe("countPipelineInFlight", () => {
  test("empty input → 0", () => {
    assert.equal(countPipelineInFlight([]), 0);
  });

  test("counts non-errored tickets with positive issueNumber", () => {
    assert.equal(
      countPipelineInFlight([
        { issueNumber: 28, labels: ["ready:architect"] },
        { issueNumber: 30, labels: [] },
        { issueNumber: 31, labels: ["wip:developer"] },
      ]),
      3,
    );
  });

  test("excludes error-labelled tickets", () => {
    // Errored tickets are parked; they don't consume a WIP seat.
    assert.equal(
      countPipelineInFlight([
        { issueNumber: 28, labels: ["ready:architect"] },
        { issueNumber: 99, labels: ["error:developer"] },
        { issueNumber: 100, labels: ["error:max_turns_salvaged"] },
      ]),
      1,
    );
  });

  test("excludes non-issue items (issueNumber <= 0)", () => {
    assert.equal(
      countPipelineInFlight([
        { issueNumber: 0, labels: [] },
        { issueNumber: -1, labels: ["ready:po"] },
        { issueNumber: 28, labels: [] },
      ]),
      1,
    );
  });

  test("isPipelineInFlight is countPipelineInFlight > 0", () => {
    // Locks the alias relationship — boolean wrapper must agree with count.
    const cases: { issueNumber: number; labels: string[] }[][] = [
      [],
      [{ issueNumber: 1, labels: [] }],
      [{ issueNumber: 99, labels: ["error:po"] }],
      [
        { issueNumber: 99, labels: ["error:po"] },
        { issueNumber: 28, labels: [] },
      ],
    ];
    for (const c of cases) {
      assert.equal(
        isPipelineInFlight(c),
        countPipelineInFlight(c) > 0,
        `mismatch for ${JSON.stringify(c)}`,
      );
    }
  });
});

describe("decideReworkRoutes", () => {
  type Item = { id: string; issueNumber: number; labels: string[]; blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[] };
  const items = (...rows: [string, Item[]][]): Map<string, Item[]> => new Map(rows);

  test("empty pipeline → no routes", () => {
    const r = decideReworkRoutes(AGENT_COLUMN_MAP, items());
    assert.deepEqual(r, []);
  });

  test("needs-rework:po in In Architecture → route to Backlog", () => {
    // The case from #27 today: architect-detected oversize sent back to PO.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["ready:architect", "size:m", "needs-rework:po"],
      }]]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].issueNumber, 27);
    assert.equal(r[0].fromColumn, "In Architecture");
    assert.equal(r[0].toColumn, "Backlog");
    assert.equal(r[0].triggerLabel, "needs-rework:po");
  });

  test("same-column case (needs-rework:architect in In Architecture) → strip-only route", () => {
    // Earlier versions skipped same-column cases as "self-loops," but that
    // left the rework label permanently on the item — and shouldSkipDispatch
    // permanently blocked agent dispatch as a result. Now we DO emit a
    // route; the caller's updateItemStatus is a no-op for same-column,
    // but the label-strip + rework-count bump still happen, which is what
    // unblocks dispatch. Surfaced as Pyrycode #59 broader bug 2026-05-02.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["needs-rework:architect"],
      }]]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].itemId, "i1");
    assert.equal(r[0].fromColumn, "In Architecture");
    assert.equal(r[0].toColumn, "In Architecture");
    assert.equal(r[0].triggerLabel, "needs-rework:architect");
    assert.deepEqual(r[0].labelsToStrip, ["needs-rework:architect"]);
  });

  test("same-column case for PO in Backlog → strip-only route", () => {
    // The exact scenario from #45 in 2026-05-02: ticket manually moved to
    // Backlog with needs-rework:po set. Without this route, PO dispatch
    // was permanently blocked.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["Backlog", [{
        id: "i45",
        issueNumber: 45,
        labels: ["needs-rework:po", "size:s"],
      }]]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].fromColumn, "Backlog");
    assert.equal(r[0].toColumn, "Backlog");
    assert.equal(r[0].triggerLabel, "needs-rework:po");
    // size:s is not a state-prefix label; should NOT be stripped.
    assert.deepEqual(r[0].labelsToStrip, ["needs-rework:po"]);
  });

  test("rework label strips ready:/error:/wip: along with itself", () => {
    // The dispatcher cleans up stale state-prefix labels on rework so the
    // ticket arrives in the target column with a clean slate. Lock that.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["ready:architect", "wip:architect", "error:architect", "needs-rework:po", "size:m"],
      }]]),
    );
    assert.equal(r.length, 1);
    const stripped = new Set(r[0].labelsToStrip);
    assert.ok(stripped.has("needs-rework:po"));
    assert.ok(stripped.has("ready:architect"));
    assert.ok(stripped.has("wip:architect"));
    assert.ok(stripped.has("error:architect"));
    // Non-state labels survive
    assert.ok(!stripped.has("size:m"));
  });

  test("malformed needs-rework: (no target) → no route", () => {
    // extractReworkTarget returns null for bare "needs-rework:" — guards
    // against typos producing accidental routes.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["needs-rework:"],
      }]]),
    );
    assert.deepEqual(r, []);
  });

  test("unknown rework target → no route", () => {
    // needs-rework:designer when designer isn't an agent → no targetColumn.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["needs-rework:designer"],
      }]]),
    );
    assert.deepEqual(r, []);
  });

  test("non-issue items (issueNumber <= 0) skip", () => {
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 0,
        labels: ["needs-rework:po"],
      }]]),
    );
    assert.deepEqual(r, []);
  });

  test("multiple needs-rework labels on one item → first valid route wins", () => {
    // Pathological case: two rework labels. We route on the first valid one
    // (label order in the array). Keeps the function deterministic.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Code Review", [{
        id: "i1",
        issueNumber: 50,
        labels: ["needs-rework:developer", "needs-rework:po"],
      }]]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].triggerLabel, "needs-rework:developer");
    assert.equal(r[0].toColumn, "In Development");
  });
});

describe("decideDoneCleanup", () => {
  type Item = { id: string; issueNumber: number; labels: string[] };

  test("empty Done column → no cleanups", () => {
    const c = decideDoneCleanup([]);
    assert.deepEqual(c, []);
  });

  test("ticket with ready:documentation → strip it", () => {
    // The reported bug: ready:documentation persists on tickets that flow
    // into Done via runAutoAdvance. The auto-merge path strips pipeline
    // labels, but only when a PR exists. Doc-only tickets, manually-merged
    // PRs, and closed-as-won't-fix never get cleaned without this pass.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["ready:documentation"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    assert.equal(c[0].itemId, "i1");
    assert.equal(c[0].issueNumber, 21);
    assert.deepEqual(c[0].labelsToStrip, ["ready:documentation"]);
  });

  test("accumulated ready:* labels from full pipeline run → strip all", () => {
    // A ticket that flowed through every agent accumulates a ready:<agent>
    // for each. None get stripped between columns. Lock in that all five
    // come off when the ticket reaches Done.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: [
        "ready:po",
        "ready:architect",
        "ready:developer",
        "ready:code-review",
        "ready:documentation",
      ],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    const stripped = new Set(c[0].labelsToStrip);
    assert.ok(stripped.has("ready:po"));
    assert.ok(stripped.has("ready:architect"));
    assert.ok(stripped.has("ready:developer"));
    assert.ok(stripped.has("ready:code-review"));
    assert.ok(stripped.has("ready:documentation"));
    assert.equal(c[0].labelsToStrip.length, 5);
  });

  test("non-pipeline labels (size:, priority:, custom tags) survive", () => {
    // The cleanup is targeted at pipeline-state labels only. PO sizing,
    // priority, and any free-form tags (release notes, area:, etc.) must
    // not be touched.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["ready:documentation", "size:s", "priority:normal", "area:dispatcher"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].labelsToStrip, ["ready:documentation"]);
  });

  test("wip:/error:/needs-rework: also stripped on Done", () => {
    // A ticket can reach Done via the closed-sweep path (e.g. user
    // closes a won't-fix while it had wip:developer set, or the ticket
    // had needs-rework:po set when it got closed manually). These are
    // pipeline state, same family as ready:*, and need cleanup too.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["wip:developer", "error:architect", "needs-rework:po", "size:s"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    const stripped = new Set(c[0].labelsToStrip);
    assert.ok(stripped.has("wip:developer"));
    assert.ok(stripped.has("error:architect"));
    assert.ok(stripped.has("needs-rework:po"));
    assert.ok(!stripped.has("size:s"));
  });

  test("rework-count:N is stripped along with pipeline labels", () => {
    // rework-count: isn't in PIPELINE_LABEL_PREFIXES (it's a counter,
    // not a state label), but it IS pipeline state. Cleaning it on Done
    // means the counter resets if the ticket ever re-opens — otherwise a
    // re-opened ticket would carry stale rework-count and could trip
    // REWORK_LOOP_THRESHOLD prematurely.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["ready:documentation", "rework-count:2"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    const stripped = new Set(c[0].labelsToStrip);
    assert.ok(stripped.has("ready:documentation"));
    assert.ok(stripped.has("rework-count:2"));
  });

  test("idempotent: ticket with no pipeline labels → no cleanup entry", () => {
    // Cleanup runs every poll cycle; the second run on a ticket already
    // cleaned in cycle 1 must be a no-op (no entry in the result), not a
    // wasted GraphQL removeLabel call. Caller iterates over the result;
    // empty result == zero work.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["size:s", "priority:normal"],
    }];
    const c = decideDoneCleanup(items);
    assert.deepEqual(c, []);
  });

  test("multiple Done items handled independently", () => {
    // Done holds many tickets over time. Cleanup must scan each
    // independently and emit one entry per ticket that needs work.
    const items: Item[] = [
      { id: "i1", issueNumber: 21, labels: ["ready:documentation"] },
      { id: "i2", issueNumber: 22, labels: ["size:s"] }, // already clean
      { id: "i3", issueNumber: 23, labels: ["wip:developer", "rework-count:1"] },
    ];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 2);
    const byNumber = new Map(c.map(e => [e.issueNumber, e]));
    assert.deepEqual(byNumber.get(21)!.labelsToStrip, ["ready:documentation"]);
    const stripped3 = new Set(byNumber.get(23)!.labelsToStrip);
    assert.ok(stripped3.has("wip:developer"));
    assert.ok(stripped3.has("rework-count:1"));
  });

  test("non-issue items (issueNumber <= 0) skip", () => {
    // Mirrors decideReworkRoutes — epics or virtual items with
    // issueNumber <= 0 don't have a real GitHub issue to label-edit.
    const items: Item[] = [{
      id: "i0",
      issueNumber: 0,
      labels: ["ready:documentation"],
    }];
    const c = decideDoneCleanup(items);
    assert.deepEqual(c, []);
  });
});

describe("shouldSkipBlockedFor", () => {
  test("ALL agents (including PO) skip blocked tickets — flipped 2026-05-08", () => {
    // PO used to bypass the blocker check on the rationale that
    // refinement is "cheap prep work." But PO refines from the issue
    // body PLUS the docs — and the Documentation agent runs LAST in
    // the pipeline, so the docs lag the code. PO refining a blocked
    // ticket reads docs that don't yet describe the upstream's API,
    // baking stale assumptions into AC. Flipped so PO waits like
    // every other agent.
    //
    // See lib.ts's shouldSkipBlockedFor docstring + project Lessons.md
    // for full rationale.
    for (const agent of ["po", "architect", "developer", "code-review", "documentation"]) {
      assert.equal(
        shouldSkipBlockedFor(agent, [{ number: 40, state: "OPEN" }]),
        true,
        `${agent} should skip on OPEN blocker`,
      );
    }
  });

  test("any agent + no blockers → not skipped", () => {
    for (const agent of ["po", "architect", "developer", "code-review", "documentation"]) {
      assert.equal(shouldSkipBlockedFor(agent, []), false);
    }
  });

  test("any agent + all-CLOSED blockers → not skipped (dependencies satisfied)", () => {
    // Once all blockers close, the gate releases for every agent.
    for (const agent of ["po", "architect", "developer", "code-review", "documentation"]) {
      assert.equal(
        shouldSkipBlockedFor(agent, [{ number: 40, state: "CLOSED" }]),
        false,
        `${agent} should not skip when all blockers are CLOSED`,
      );
    }
  });

  test("any-OPEN-blocker holds even when other blockers are CLOSED", () => {
    // Mixed state: one blocker still open. Gate stays closed.
    assert.equal(
      shouldSkipBlockedFor("po", [
        { number: 40, state: "CLOSED" },
        { number: 41, state: "OPEN" },
      ]),
      true,
    );
  });
});

describe("extractReworkCount", () => {
  test("empty labels → 0", () => {
    assert.equal(extractReworkCount([]), 0);
  });

  test("no rework-count label → 0", () => {
    assert.equal(extractReworkCount(["size:s", "ready:po"]), 0);
  });

  test("single rework-count:2 → 2", () => {
    assert.equal(extractReworkCount(["size:s", "rework-count:2", "ready:po"]), 2);
  });

  test("rework-count:0 → 0 (legitimate zero, not a missing label)", () => {
    // Edge case: a ticket may explicitly carry rework-count:0 if the
    // counter was reset. Don't conflate with "no label present" in tests.
    assert.equal(extractReworkCount(["rework-count:0"]), 0);
  });

  test("malformed rework-count → 0", () => {
    // Defensively tolerate garbage. Don't crash on a typo'd label.
    assert.equal(extractReworkCount(["rework-count:abc"]), 0);
    assert.equal(extractReworkCount(["rework-count:"]), 0);
  });

  test("multiple rework-count labels → max wins", () => {
    // Pathological state — shouldn't happen in normal operation, but
    // if it does, bias toward halting (max is safer than min). The
    // worst-case rework count is the truthful one.
    assert.equal(
      extractReworkCount(["rework-count:1", "rework-count:3", "rework-count:2"]),
      3,
    );
  });

  test("negative rework-count → 0 (treated as invalid)", () => {
    assert.equal(extractReworkCount(["rework-count:-1"]), 0);
  });

  test("REWORK_LOOP_THRESHOLD is 3 (locked default)", () => {
    // Adjusting the threshold is a deliberate policy change. This test
    // makes the default explicit and forces an update to the test if
    // the constant changes — discussion-required, not silent drift.
    assert.equal(REWORK_LOOP_THRESHOLD, 3);
  });
});

describe("hasOpenBlockers", () => {
  test("no blockers → false (ticket is not dependency-blocked)", () => {
    assert.equal(hasOpenBlockers([]), false);
  });

  test("all blockers CLOSED → false (dependencies satisfied)", () => {
    // Once a blocker issue closes, the dependency is satisfied and the
    // ticket can flow. Mirrors GitHub's `issueDependenciesSummary` model:
    // completed dependencies don't gate progression.
    assert.equal(
      hasOpenBlockers([
        { number: 100, state: "CLOSED" },
        { number: 101, state: "CLOSED" },
      ]),
      false,
    );
  });

  test("any OPEN blocker → true (mixed CLOSED + OPEN)", () => {
    // Even one open blocker holds the ticket. Locks the "blocked"
    // semantic: ALL blockers must close before the ticket flows.
    assert.equal(
      hasOpenBlockers([
        { number: 100, state: "CLOSED" },
        { number: 101, state: "OPEN" },
      ]),
      true,
    );
  });

  test("single OPEN blocker → true", () => {
    // The Pyrycode #41 case: blocked by #40, which is OPEN. Skip dispatch.
    assert.equal(
      hasOpenBlockers([{ number: 40, state: "OPEN" }]),
      true,
    );
  });
});

describe("shouldUseWorktree", () => {
  test("PO does not use a worktree (operates on issue body via gh)", () => {
    const po = AGENTS.find(a => a.name === "po")!;
    assert.equal(shouldUseWorktree(po), false);
  });

  test("architect uses a worktree (writes spec to docs/specs/architecture/)", () => {
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldUseWorktree(arch), true);
  });

  test("developer uses a worktree (writes code + tests)", () => {
    const dev = AGENTS.find(a => a.name === "developer")!;
    assert.equal(shouldUseWorktree(dev), true);
  });

  test("code-review uses a worktree (reads code locally to review)", () => {
    const cr = AGENTS.find(a => a.name === "code-review")!;
    assert.equal(shouldUseWorktree(cr), true);
  });

  test("documentation uses a worktree (writes to docs/)", () => {
    const docs = AGENTS.find(a => a.name === "documentation")!;
    assert.equal(shouldUseWorktree(docs), true);
  });

  test("every AgentConfig declares usesWorktree explicitly", () => {
    // Adding a new agent must force an explicit decision about whether
    // it operates on the working tree. No implicit defaults — the policy
    // is declarative on the agent record. This locks in the rule that
    // bit us on #27 (PO's hardcoded `if (agent.name === "po")` was the
    // only place the policy lived; missing it for a new agent would
    // silently default to "uses worktree" with cosmetic push failures).
    for (const agent of AGENTS) {
      assert.equal(
        typeof agent.usesWorktree,
        "boolean",
        `${agent.name} must declare usesWorktree`,
      );
    }
  });
});

describe("maxTurnsFor", () => {
  // Code review runs sub-agents (each consumes turns from the parent
  // budget) and routinely needs the headroom; everyone else gets the
  // base budget. The base bumped 60 → 70 on 2026-05-03 (later afternoon)
  // after three Mode-E events in one session (#128, #75, #99) all hit
  // exactly at turn 60-61 in the housekeeping phase (commit/docs polish/
  // PROJECT-MEMORY edit/qmd re-index). All three were caught merge-ready
  // by safer-salvage. 10 more turns covers the housekeeping tail.
  // Earlier: 50 → 60 on 2026-05-02 after #55.
  test("code-review gets 100 (runs sub-agents)", () => {
    const cr = AGENTS.find(a => a.name === "code-review")!;
    assert.equal(maxTurnsFor(cr), 100);
  });

  test("developer gets 70 (was 60 — bumped 2026-05-03 after #128/#75/#99)", () => {
    const dev = AGENTS.find(a => a.name === "developer")!;
    assert.equal(maxTurnsFor(dev), 70);
  });

  test("architect gets 70 (base budget — sketch + spec)", () => {
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(maxTurnsFor(arch), 70);
  });

  test("po gets 70 (base budget — issue body refinement)", () => {
    const po = AGENTS.find(a => a.name === "po")!;
    assert.equal(maxTurnsFor(po), 70);
  });

  test("documentation gets 70 (base budget — knowledge base writes)", () => {
    const docs = AGENTS.find(a => a.name === "documentation")!;
    assert.equal(maxTurnsFor(docs), 70);
  });

  test("unknown agent name still gets the base budget (no implicit zero)", () => {
    // Defensive: a typo or new agent shouldn't silently dispatch with
    // 0 turns. The policy returns the base budget for any non-code-review
    // name; if a future agent needs more, it must be added explicitly.
    assert.equal(maxTurnsFor({ name: "ghost", column: "", claudeMdPath: "", description: "", usesWorktree: false, producesCommits: false }), 70);
  });
});

describe("shouldAttemptSafeSalvage", () => {
  // Decision predicate for the safer-salvage path: when an agent hits
  // max_turns with uncommitted work AND the build is clean, the dispatcher
  // can preserve the work as a draft PR for human triage rather than
  // destroying it via `git worktree remove --force`. Distinct from the
  // existing PR-already-exists salvage; this fires only when the agent
  // didn't get to PR-creation but did produce buildable code.
  //
  // Caller does the I/O (git commit, push, gh pr create); this function
  // only decides whether to attempt salvage. A true return means: clean
  // build, real changes to preserve, and a max_turns failure (not other
  // error classes — those don't fit the salvage shape).

  const baseOk = {
    terminalReason: "max_turns",
    prAlreadyExists: false,
    gitStatusOutput: " M internal/e2e/rotation_test.go\n?? internal/e2e/internal/fakeclaude/main.go\n",
    gateExitCodes: [0, 0],
  };

  test("max_turns + uncommitted + all gates pass → salvage", () => {
    assert.equal(shouldAttemptSafeSalvage(baseOk), true);
  });

  test("non-max_turns error → no salvage (different failure shape)", () => {
    assert.equal(
      shouldAttemptSafeSalvage({ ...baseOk, terminalReason: "api_error" }),
      false,
    );
    assert.equal(
      shouldAttemptSafeSalvage({ ...baseOk, terminalReason: "timeout" }),
      false,
    );
  });

  test("PR already exists → no salvage (existing salvage path handles it)", () => {
    assert.equal(
      shouldAttemptSafeSalvage({ ...baseOk, prAlreadyExists: true }),
      false,
    );
  });

  test("clean working tree → no salvage (nothing to preserve)", () => {
    assert.equal(
      shouldAttemptSafeSalvage({ ...baseOk, gitStatusOutput: "" }),
      false,
    );
    assert.equal(
      shouldAttemptSafeSalvage({ ...baseOk, gitStatusOutput: "   \n  " }),
      false,
    );
  });

  test("any failing gate → no salvage (don't ship broken code as a draft PR)", () => {
    // Every gate must be 0; any non-zero blocks. The point is that a
    // human reviewing the salvage PR has buildable code to work with —
    // failing tests are fine (they're often the signal the agent was
    // chasing), but failing vet/build means the code itself is in an
    // indeterminate state.
    assert.equal(shouldAttemptSafeSalvage({ ...baseOk, gateExitCodes: [1, 0] }), false);
    assert.equal(shouldAttemptSafeSalvage({ ...baseOk, gateExitCodes: [0, 1] }), false);
    assert.equal(shouldAttemptSafeSalvage({ ...baseOk, gateExitCodes: [1] }), false);
    assert.equal(shouldAttemptSafeSalvage({ ...baseOk, gateExitCodes: [2] }), false);
  });

  test("empty gate list → salvage proceeds (consumer opted out of gating)", () => {
    // SALVAGE_GATES="" (explicitly empty env var) means "always salvage
    // when the other criteria match" — useful for languages without
    // cheap precommit gates, or for consumers who'd rather let humans
    // sort it out at PR review.
    assert.equal(shouldAttemptSafeSalvage({ ...baseOk, gateExitCodes: [] }), true);
  });

  test("variable gate count works (3+ gates, any failing blocks)", () => {
    assert.equal(shouldAttemptSafeSalvage({ ...baseOk, gateExitCodes: [0, 0, 0] }), true);
    assert.equal(shouldAttemptSafeSalvage({ ...baseOk, gateExitCodes: [0, 0, 1] }), false);
    assert.equal(shouldAttemptSafeSalvage({ ...baseOk, gateExitCodes: [0, 1, 0] }), false);
  });
});

describe("parseSalvageGates", () => {
  // Lets consumers configure what build gates run before the dispatcher
  // ships salvaged work. SALVAGE_GATES is a `;`-delimited list of shell
  // commands; each runs in the agent's worktree, all must exit 0.
  //
  // - Unset:     defaults to the legacy Go pair (back-compat for pyrycode).
  // - Empty "":  zero gates (always salvage when other criteria match).
  // - Set:       split on `;`, trim, drop empty entries.

  test("unset → Go default pair (back-compat)", () => {
    assert.deepEqual(parseSalvageGates(undefined), ["go vet ./...", "go build ./..."]);
  });

  test("empty string → no gates (consumer opted out)", () => {
    assert.deepEqual(parseSalvageGates(""), []);
  });

  test("single gate → single-element array", () => {
    assert.deepEqual(parseSalvageGates("cargo check"), ["cargo check"]);
  });

  test("semicolon-separated → multiple gates", () => {
    assert.deepEqual(
      parseSalvageGates("npm run lint; npm run build"),
      ["npm run lint", "npm run build"],
    );
  });

  test("trims surrounding whitespace per gate", () => {
    assert.deepEqual(
      parseSalvageGates("  cargo check  ;  cargo build  "),
      ["cargo check", "cargo build"],
    );
  });

  test("drops empty segments (trailing/leading/double semicolons)", () => {
    assert.deepEqual(parseSalvageGates(";cargo check;;cargo build;"), ["cargo check", "cargo build"]);
    assert.deepEqual(parseSalvageGates(";;"), []);
  });
});

describe("findReadyPrNumber", () => {
  // Used by the existing PR-already-exists salvage path: max_turns is
  // treated as success ONLY if a non-draft (ready) PR exists for the
  // branch. Draft PRs don't count — they're typically the salvage
  // helper's own output, opened mid-work and waiting on human triage.
  // Treating a draft PR as "agent finished, just out of turns on
  // cleanup" auto-advances partial work via `ready:<agent>`, which
  // is exactly what the safer-salvage design is meant to prevent.

  test("empty array → null", () => {
    assert.equal(findReadyPrNumber("[]"), null);
  });

  test("single draft PR → null (don't treat draft as success)", () => {
    assert.equal(findReadyPrNumber('[{"number": 42, "isDraft": true}]'), null);
  });

  test("single ready PR → that PR's number", () => {
    assert.equal(findReadyPrNumber('[{"number": 42, "isDraft": false}]'), 42);
  });

  test("draft + ready → ready PR's number (skip the draft)", () => {
    assert.equal(
      findReadyPrNumber('[{"number": 41, "isDraft": true}, {"number": 42, "isDraft": false}]'),
      42,
    );
  });

  test("multiple ready → first one (deterministic)", () => {
    // gh pr list returns most-recent first; first ready = most recent.
    assert.equal(
      findReadyPrNumber('[{"number": 42, "isDraft": false}, {"number": 41, "isDraft": false}]'),
      42,
    );
  });

  test("malformed JSON → null (don't crash on gh CLI failure)", () => {
    assert.equal(findReadyPrNumber("not json"), null);
    assert.equal(findReadyPrNumber(""), null);
    assert.equal(findReadyPrNumber("   "), null);
  });

  test("missing isDraft field → treated as ready (defensive — assume non-draft)", () => {
    // If gh's output ever omits isDraft (schema change?), default to
    // ready. The PR-salvage path is the safer path to default to —
    // false positives just cause an extra dispatch run, false negatives
    // (treating ready as draft) would silently auto-advance.
    // Wait — that's backwards. Treating a draft AS ready auto-advances;
    // treating ready as draft makes the dispatcher re-run the agent,
    // wasting tokens but never auto-advancing. The cautious default
    // is "treat as draft when unclear" — i.e., return null for missing
    // isDraft. Lock that in.
    assert.equal(findReadyPrNumber('[{"number": 42}]'), null);
  });
});

describe("selectDispatches", () => {
  // Concurrency model: WIP=N (default 2), serial within a dependency chain
  // (preserved by shouldSkipBlockedFor's open-blocker check), parallel across
  // unrelated tickets. Replaces WIP=1 globally.
  //
  // Pure function over a snapshot. Caller (dispatch.ts poll loop) does the
  // mutations + actual claude spawn.

  const POLL_ORDER = [...AGENTS].reverse();
  const PO = POLL_ORDER.find(a => a.name === "po")!;
  const ARCH = POLL_ORDER.find(a => a.name === "architect")!;
  const DEV = POLL_ORDER.find(a => a.name === "developer")!;

  const item = (n: number, labels: string[] = [], blockedBy: { number: number; state: "OPEN" | "CLOSED" }[] = []) =>
    ({ id: `item-${n}`, issueNumber: n, labels, blockedBy });

  test("empty input → empty output", () => {
    const r = selectDispatches({ itemsByColumn: new Map(), pollOrder: POLL_ORDER, maxConcurrent: 2 });
    assert.deepEqual(r, []);
  });

  test("maxConcurrent=0 → empty output even with eligible items", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [item(1)]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 0,
    });
    assert.deepEqual(r, []);
  });

  test("single eligible ticket in PO column → one candidate", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [item(1)]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].agent.name, "po");
    assert.equal(r[0].item.issueNumber, 1);
  });

  test("multiple eligible Backlog items → caps at maxConcurrent (parallel POs allowed)", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [item(1), item(2), item(3)]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
    });
    assert.equal(r.length, 2);
    assert.equal(r[0].agent.name, "po");
    assert.equal(r[1].agent.name, "po");
    assert.deepEqual(r.map(c => c.item.issueNumber), [1, 2]);
  });

  test("eligible items across columns → picked in pollOrder (most-advanced first)", () => {
    // pollOrder is [...AGENTS].reverse() = documentation, code-review, developer, architect, po
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["Backlog", [item(1)]],          // PO eligible
        ["In Development", [item(2)]],   // Developer eligible
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
    });
    assert.equal(r.length, 2);
    // Developer comes before PO in pollOrder (more advanced)
    assert.equal(r[0].agent.name, "developer");
    assert.equal(r[1].agent.name, "po");
  });

  test("ineligible labels filter out (wip:* / ready:* / needs-rework:* / error:*)", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["Backlog", [
          item(1, ["wip:po"]),                        // skipped (in flight)
          item(2, ["ready:po"]),                      // skipped (already done)
          item(3, ["error:max_turns_salvaged"]),      // skipped (global block)
          item(4, []),                                // eligible
        ]],
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 5,
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].item.issueNumber, 4);
  });

  test("OPEN blocker → skipped for ALL agents including PO (post-2026-05-08 flip)", () => {
    // Pre-2026-05-08, PO bypassed `shouldSkipBlockedFor` so a blocked
    // Backlog ticket would still get PO refinement. That produced
    // stale refinements (PO refines from docs; Documentation agent
    // runs last; docs lag the code). Flipped so PO waits.
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["Backlog", [item(1, [], [{ number: 99, state: "OPEN" }])]],          // PO now skipped
        ["In Development", [item(2, [], [{ number: 99, state: "OPEN" }])]],    // Developer skipped (unchanged)
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
    });
    // No candidates — both columns have items but both are blocked.
    assert.equal(r.length, 0);
  });

  test("CLOSED blocker → not skipped", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["In Development", [item(1, [], [{ number: 99, state: "CLOSED" }])]],
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].agent.name, "developer");
  });

  test("issueNumber=0 (synthetic items) skips blocker check", () => {
    // Pre-Inbox synthetic items use issueNumber=0; the blocker check is bypassed
    // there because they aren't real GitHub issues yet.
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["Backlog", [item(0, [], [{ number: 99, state: "OPEN" }])]],
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].item.issueNumber, 0);
  });

  test("partial cap fill across columns when fewer eligible than maxConcurrent", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["In Architecture", [item(1)]],
        ["Backlog", [item(2)]],
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 5,  // far higher than available
    });
    assert.equal(r.length, 2);
    // Architect column comes before Backlog in pollOrder (more advanced)
    assert.equal(r[0].agent.name, "architect");
    assert.equal(r[1].agent.name, "po");
  });
});

describe("decideBranchSetup", () => {
  // Origin is the source of truth: if local is behind, fast-forward;
  // if local has commits not in origin, abort (integrity error from a
  // prior dispatch's failed push). Surfaced 2026-05-07 (#155 stale-worktree).

  test("neither exists → create-from-main", () => {
    assert.equal(
      decideBranchSetup({ localExists: false, remoteExists: false }),
      "create-from-main",
    );
  });

  test("only remote exists → create-from-origin", () => {
    assert.equal(
      decideBranchSetup({ localExists: false, remoteExists: true }),
      "create-from-origin",
    );
  });

  test("only local exists → reuse-local-no-remote", () => {
    // Edge case: branch was created locally and never pushed yet.
    // Reuse it; the dispatcher's later push will create origin.
    assert.equal(
      decideBranchSetup({ localExists: true, remoteExists: false }),
      "reuse-local-no-remote",
    );
  });

  test("both exist, local == origin → reuse-local-already-synced", () => {
    assert.equal(
      decideBranchSetup({
        localExists: true,
        remoteExists: true,
        localEqualsOrigin: true,
      }),
      "reuse-local-already-synced",
    );
  });

  test("both exist, local is ancestor of origin → fast-forward-from-origin", () => {
    // The case that matters: someone pushed to origin out-of-band
    // (manual triage commit, hot-fix push) between dispatches. Local
    // is behind, fast-forward catches up.
    assert.equal(
      decideBranchSetup({
        localExists: true,
        remoteExists: true,
        localEqualsOrigin: false,
        localIsAncestorOfOrigin: true,
      }),
      "fast-forward-from-origin",
    );
  });

  test("both exist, local NOT ancestor of origin → abort-local-ahead-of-origin", () => {
    // Local has commits that aren't in origin. Per the dispatcher's flow,
    // this means a prior dispatch failed to push and we didn't notice.
    // Don't blow them away — abort and surface for human triage.
    assert.equal(
      decideBranchSetup({
        localExists: true,
        remoteExists: true,
        localEqualsOrigin: false,
        localIsAncestorOfOrigin: false,
      }),
      "abort-local-ahead-of-origin",
    );
  });

  test("local exists, remote exists, SHA-equality flag missing → treats as ahead (defensive)", () => {
    // If the caller forgot to compute the equality/ancestor flags,
    // default to abort rather than silently force-update local.
    // The "both exist + missing flags" code path shouldn't happen in
    // production, but we lock in the safe default.
    assert.equal(
      decideBranchSetup({ localExists: true, remoteExists: true }),
      "abort-local-ahead-of-origin",
    );
  });
});

describe("decidePostRunLabels", () => {
  // The post-run label decision is the single biggest pure-logic surface
  // that previously sat inline in dispatchToAgent (review #16). Tests here
  // pin the rules; the dispatch.ts caller applies the side effects.

  test("clean run, current column matches agent column → addReadyLabel=true", () => {
    const d = decidePostRunLabels({
      postLabels: [],
      agentName: "developer",
      agentColumn: "In Development",
      currentColumn: "In Development",
    });
    assert.equal(d.reworkTarget, null);
    assert.equal(d.addReadyLabel, true);
    assert.equal(d.logKind, "ready");
    assert.equal(d.shouldStripLegacyNeedsRework, false);
  });

  test("needs-rework:<target> present → reworkTarget set, no ready label", () => {
    const d = decidePostRunLabels({
      postLabels: ["needs-rework:architect"],
      agentName: "developer",
      agentColumn: "In Development",
      currentColumn: "In Development",
    });
    assert.equal(d.reworkTarget, "architect");
    assert.equal(d.addReadyLabel, false);
    assert.equal(d.logKind, "rework");
  });

  test("agent moved ticket out of column → moved-out, no ready label", () => {
    // PO demotes Backlog → Inbox: the column move IS the completion signal.
    const d = decidePostRunLabels({
      postLabels: [],
      agentName: "po",
      agentColumn: "Backlog",
      currentColumn: "Inbox",
    });
    assert.equal(d.addReadyLabel, false);
    assert.equal(d.logKind, "moved-out");
  });

  test("post-run status fetch failed (currentColumn=null) → status-unknown, no ready label", () => {
    // Cautious — preserves the next cycle's chance to recover.
    const d = decidePostRunLabels({
      postLabels: [],
      agentName: "developer",
      agentColumn: "In Development",
      currentColumn: null,
    });
    assert.equal(d.addReadyLabel, false);
    assert.equal(d.logKind, "status-unknown");
  });

  test("legacy `needs-rework` (no suffix) → strip flag set, target falls back to agent", () => {
    // Pre-prefix-scheme semantics: `needs-rework` alone means "this agent
    // needs to redo its work."
    const d = decidePostRunLabels({
      postLabels: ["needs-rework"],
      agentName: "developer",
      agentColumn: "In Development",
      currentColumn: "In Development",
    });
    assert.equal(d.reworkTarget, "developer");
    assert.equal(d.shouldStripLegacyNeedsRework, true);
    assert.equal(d.addReadyLabel, false);
    assert.equal(d.logKind, "rework");
  });

  test("explicit needs-rework:<target> wins over legacy `needs-rework`", () => {
    const d = decidePostRunLabels({
      postLabels: ["needs-rework:po", "needs-rework"],
      agentName: "developer",
      agentColumn: "In Development",
      currentColumn: "In Development",
    });
    assert.equal(d.reworkTarget, "po");
    assert.equal(d.shouldStripLegacyNeedsRework, true); // legacy still gets stripped
    assert.equal(d.addReadyLabel, false);
    assert.equal(d.logKind, "rework");
  });

  test("no rework target, currentColumn === agentColumn → ready (the happy path)", () => {
    const d = decidePostRunLabels({
      postLabels: ["size:m", "priority:p2"],  // non-pipeline labels are noise
      agentName: "code-review",
      agentColumn: "In Code Review",
      currentColumn: "In Code Review",
    });
    assert.equal(d.addReadyLabel, true);
    assert.equal(d.logKind, "ready");
  });
});

describe("scrubSpawnEnv", () => {
  // The dispatcher's GITHUB_TOKEN, project config, and webhook URL must
  // not flow into spawned `claude` processes. claude has its own gh-auth
  // credentials; passing the dispatcher's token gives the agent the
  // dispatcher's identity and audit-log scope.

  test("strips every key in SPAWN_ENV_DENYLIST", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/x",
      GITHUB_TOKEN: "secret",
      GITHUB_OWNER: "pyrycode",
      GITHUB_REPO: "pyrycode",
      PROJECT_NUMBER: "1",
      DISCORD_WEBHOOK_URL: "https://discord.com/...",
      PYRY_MAX_CONCURRENT: "2",
      TARGET_REPO_PATH: "/repo",
    };
    const out = scrubSpawnEnv(input);
    for (const denied of SPAWN_ENV_DENYLIST) {
      assert.equal(out[denied], undefined, `expected ${denied} to be stripped`);
    }
  });

  test("preserves PATH, HOME, and other non-secret env", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/x",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "anthropic-secret",  // user's own key, kept
      GITHUB_TOKEN: "dispatcher-secret",       // stripped
    };
    const out = scrubSpawnEnv(input);
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.HOME, "/Users/x");
    assert.equal(out.LANG, "en_US.UTF-8");
    assert.equal(out.ANTHROPIC_API_KEY, "anthropic-secret");
    assert.equal(out.GITHUB_TOKEN, undefined);
  });

  test("does not mutate the input", () => {
    const input: NodeJS.ProcessEnv = { GITHUB_TOKEN: "secret", PATH: "/bin" };
    scrubSpawnEnv(input);
    assert.equal(input.GITHUB_TOKEN, "secret"); // input untouched
  });

  test("empty input → empty output (no crash)", () => {
    assert.deepEqual(scrubSpawnEnv({}), {});
  });
});

describe("findWorktreesForBranch", () => {
  // The dispatcher's stale-worktree cleanup at the start of dispatchToAgent
  // only handles the same-PATH case (worktreeDir). When a previous cycle's
  // cleanup execSync was swallowed (permissions, lockfile contention), the
  // orphan worktree at a DIFFERENT path on the same branch blocks all
  // future dispatches with `error:<agent>`. This function lets the
  // dispatcher detect such orphans before `git worktree add` errors out.

  test("empty porcelain → no matches", () => {
    assert.deepEqual(findWorktreesForBranch("", "feature/100"), []);
  });

  test("single worktree on the branch → returned", () => {
    const porcelain = [
      "worktree /repo/main",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.pyrycode-worktrees/architect-100",
      "HEAD def456",
      "branch refs/heads/feature/100",
      "",
    ].join("\n");
    assert.deepEqual(
      findWorktreesForBranch(porcelain, "feature/100"),
      ["/repo/.pyrycode-worktrees/architect-100"],
    );
  });

  test("multiple worktrees on the same branch → all returned", () => {
    // Should not normally happen, but we want to remove all of them if it does.
    const porcelain = [
      "worktree /repo/.pyrycode-worktrees/architect-100",
      "HEAD def456",
      "branch refs/heads/feature/100",
      "",
      "worktree /repo/.pyrycode-worktrees/developer-100",
      "HEAD def456",
      "branch refs/heads/feature/100",
      "",
    ].join("\n");
    assert.deepEqual(
      findWorktreesForBranch(porcelain, "feature/100"),
      [
        "/repo/.pyrycode-worktrees/architect-100",
        "/repo/.pyrycode-worktrees/developer-100",
      ],
    );
  });

  test("worktree on different branch → not matched", () => {
    const porcelain = [
      "worktree /repo/.pyrycode-worktrees/architect-101",
      "HEAD def456",
      "branch refs/heads/feature/101",
      "",
    ].join("\n");
    assert.deepEqual(findWorktreesForBranch(porcelain, "feature/100"), []);
  });

  test("detached HEAD worktree → not matched (no branch)", () => {
    const porcelain = [
      "worktree /repo/main",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.pyrycode-worktrees/wip",
      "HEAD def456",
      "detached",
      "",
    ].join("\n");
    assert.deepEqual(findWorktreesForBranch(porcelain, "feature/100"), []);
  });

  test("bare repo entry → not matched (no branch)", () => {
    const porcelain = [
      "worktree /repo/bare",
      "HEAD abc123",
      "bare",
      "",
    ].join("\n");
    assert.deepEqual(findWorktreesForBranch(porcelain, "feature/100"), []);
  });

  test("similar branch names don't false-match", () => {
    // refs/heads/feature/100 vs refs/heads/feature/1000 — must not collide.
    const porcelain = [
      "worktree /repo/.pyrycode-worktrees/architect-1000",
      "HEAD def456",
      "branch refs/heads/feature/1000",
      "",
    ].join("\n");
    assert.deepEqual(findWorktreesForBranch(porcelain, "feature/100"), []);
  });

  test("trailing whitespace on porcelain lines doesn't break parsing", () => {
    // git's porcelain output is well-formed, but we strip trailing whitespace
    // defensively so a future format quirk (CRLF, padding) doesn't silently
    // hide an orphan and re-introduce the bug.
    const porcelain = [
      "worktree /repo/.pyrycode-worktrees/architect-100  ",
      "HEAD def456",
      "branch refs/heads/feature/100  ",
      "",
    ].join("\n");
    assert.deepEqual(
      findWorktreesForBranch(porcelain, "feature/100"),
      ["/repo/.pyrycode-worktrees/architect-100"],
    );
  });
});

describe("extractRateLimitInfo", () => {
  // Detect GitHub rate-limit errors from the Octokit GraphQL client
  // and surface a wait deadline so the dispatcher can sleep until reset
  // instead of cascading errors for the rest of the rate-limit window.
  // Last night's incident: limit hit, dispatcher kept polling for ~50min
  // before reset, every cycle producing the full set of error logs.

  test("non-rate-limit error → null", () => {
    assert.equal(extractRateLimitInfo(new Error("network timeout")), null);
    assert.equal(extractRateLimitInfo(null), null);
    assert.equal(extractRateLimitInfo(undefined), null);
    assert.equal(extractRateLimitInfo({}), null);
  });

  test("rate-limit error message → detected as rate-limit", () => {
    const err = new Error("Request failed due to following response errors:\n - API rate limit already exceeded for user ID 275333887.");
    const info = extractRateLimitInfo(err);
    assert.notEqual(info, null);
    assert.equal(info!.isRateLimited, true);
  });

  test("rate-limit error with x-ratelimit-reset header → resetAt populated", () => {
    // Octokit error shape: error has `response.headers` map with the
    // unix timestamp of the next reset.
    const err: any = new Error("API rate limit already exceeded");
    err.response = { headers: { "x-ratelimit-reset": "1777793956" } };
    const info = extractRateLimitInfo(err);
    assert.equal(info!.isRateLimited, true);
    assert.equal(info!.resetUnixSeconds, 1777793956);
  });

  test("rate-limit error without reset header → no resetAt (caller defaults)", () => {
    const err = new Error("API rate limit already exceeded");
    const info = extractRateLimitInfo(err);
    assert.equal(info!.isRateLimited, true);
    assert.equal(info!.resetUnixSeconds, null);
  });

  test("non-rate-limit error WITH reset header → still null (don't conflate)", () => {
    // Defensive: the reset header alone doesn't indicate rate-limit;
    // GitHub returns the header on every request. Only the message text
    // signals the actual rate-limit state.
    const err: any = new Error("validation failed");
    err.response = { headers: { "x-ratelimit-reset": "1777793956" } };
    assert.equal(extractRateLimitInfo(err), null);
  });

  test("recognizes both 'rate limit' phrasings GitHub uses", () => {
    // GitHub's primary rate limit returns "API rate limit exceeded" on
    // the REST endpoints and "API rate limit already exceeded" on
    // GraphQL. Match both.
    assert.equal(
      extractRateLimitInfo(new Error("API rate limit exceeded for user"))?.isRateLimited,
      true,
    );
    assert.equal(
      extractRateLimitInfo(new Error("API rate limit already exceeded for user"))?.isRateLimited,
      true,
    );
  });

  test("string error (not Error instance) with rate-limit phrase → detected", () => {
    // Some Octokit error paths throw strings; be defensive.
    assert.equal(
      extractRateLimitInfo("API rate limit already exceeded")?.isRateLimited,
      true,
    );
  });

  test("HTTP 429 status → detected even without english 'rate limit' message", () => {
    // GitHub localizes error message text and changes wording. Status
    // codes are stable and language-independent.
    const err: any = new Error("Demande limitée");  // hypothetical localized message
    err.status = 429;
    err.response = { headers: { "x-ratelimit-reset": "1777793956" } };
    const info = extractRateLimitInfo(err);
    assert.equal(info?.isRateLimited, true);
    assert.equal(info?.resetUnixSeconds, 1777793956);
  });

  test("HTTP 403 + x-ratelimit-remaining: 0 → detected (legacy GraphQL flavour)", () => {
    const err: any = new Error("Forbidden");
    err.status = 403;
    err.response = { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1777793956" } };
    assert.equal(extractRateLimitInfo(err)?.isRateLimited, true);
  });

  test("HTTP 403 with remaining > 0 → not rate-limited", () => {
    // Plain 403 (auth issue, scope problem) — not a rate-limit response.
    const err: any = new Error("Forbidden");
    err.status = 403;
    err.response = { headers: { "x-ratelimit-remaining": "4500" } };
    assert.equal(extractRateLimitInfo(err), null);
  });

  test("HTTP 200 + 'API rate limit exceeded' message → falls back to text match", () => {
    // Some library wrappers strip status; the english fallback must
    // still detect the legacy phrasing.
    const err = new Error("API rate limit exceeded");
    assert.equal(extractRateLimitInfo(err)?.isRateLimited, true);
  });

  test("status nested under err.response.status → detected", () => {
    // Some Octokit shapes put status on err.response, not directly on err.
    const err: any = new Error("");
    err.response = { status: 429, headers: {} };
    assert.equal(extractRateLimitInfo(err)?.isRateLimited, true);
  });
});

describe("shouldAddReadyLabel", () => {
  // After a successful agent run, the dispatcher adds `ready:<agent>`
  // so the auto-advance step moves the ticket to the next column. But
  // some agents legitimately move the ticket OUT of their dispatch
  // column during a successful run — PO can demote a Backlog ticket
  // back to Inbox when it lacks information for refinement (per
  // PO's CLAUDE.md), and PO moves a parent ticket to Done after a
  // split. In those cases, adding `ready:po` would attach a "ready
  // for the next stage" signal to a ticket the agent explicitly
  // moved off the pipeline, creating a stale label that misleads
  // anyone scanning the board.
  //
  // Pyrycode #57 (2026-05-02): PO demoted to Inbox per its CLAUDE.md
  // ("defer until Phase 1.1's pyry attach <id> lands"). Dispatcher
  // still added `ready:po` because its existing check only gated on
  // `needs-rework:*` labels, not column movement. Same shape as the
  // earlier label/PR-classification bugs — predicate didn't account
  // for a new agent behavior pattern.

  test("agent column matches current + no rework → add label", () => {
    assert.equal(shouldAddReadyLabel({
      agentColumn: "Backlog", currentColumn: "Backlog", hasReworkTarget: false,
    }), true);
  });

  test("rework target set → skip (existing behavior)", () => {
    assert.equal(shouldAddReadyLabel({
      agentColumn: "Backlog", currentColumn: "Backlog", hasReworkTarget: true,
    }), false);
  });

  test("agent demoted ticket to Inbox → skip (don't auto-advance demoted work)", () => {
    assert.equal(shouldAddReadyLabel({
      agentColumn: "Backlog", currentColumn: "Inbox", hasReworkTarget: false,
    }), false);
  });

  test("agent moved ticket to Done (e.g. PO split parent) → skip", () => {
    assert.equal(shouldAddReadyLabel({
      agentColumn: "Backlog", currentColumn: "Done", hasReworkTarget: false,
    }), false);
  });

  test("any forward column move from agent → skip (agent already advanced)", () => {
    // Hypothetical: an agent that moves the ticket to the next column
    // itself (none currently do, but defensive). Adding ready:<agent>
    // when the ticket is already in the next column would just leave
    // a stale label.
    assert.equal(shouldAddReadyLabel({
      agentColumn: "In Development", currentColumn: "In Code Review", hasReworkTarget: false,
    }), false);
  });

  test("currentColumn null (couldn't fetch) → skip (cautious default)", () => {
    // If the post-run status fetch failed, default to "skip" rather
    // than "add". False positive (skip when should add) just means
    // one cycle of delay (next dispatch picks up the now-stable state).
    // False negative (add when shouldn't) creates a stale label.
    assert.equal(shouldAddReadyLabel({
      agentColumn: "Backlog", currentColumn: null, hasReworkTarget: false,
    }), false);
  });

  test("rework + column move both → skip (either alone would skip)", () => {
    assert.equal(shouldAddReadyLabel({
      agentColumn: "Backlog", currentColumn: "Inbox", hasReworkTarget: true,
    }), false);
  });
});

describe("shouldAutoCommit", () => {
  test("empty git status → false", () => {
    assert.equal(shouldAutoCommit(""), false);
  });

  test("whitespace-only git status → false", () => {
    // Stripping whitespace is what guards us against an accidental commit
    // when the git status output is just "\n" or trailing spaces.
    assert.equal(shouldAutoCommit("\n"), false);
    assert.equal(shouldAutoCommit("   "), false);
    assert.equal(shouldAutoCommit("\t\n  "), false);
  });

  test("modified file → true", () => {
    assert.equal(shouldAutoCommit(" M docs/specs/architecture/27-foo.md"), true);
  });

  test("untracked file → true", () => {
    assert.equal(shouldAutoCommit("?? new.go"), true);
  });

  test("multiple changes → true", () => {
    assert.equal(
      shouldAutoCommit(" M file1.go\n?? file2.go\nA  file3.go"),
      true,
    );
  });
});

describe("shouldProduceCommits", () => {
  // Mirrors `shouldUseWorktree` shape — declarative per-agent policy.
  // The dispatcher's empty-branch guard uses this to decide whether
  // a 0-ahead-of-main branch after the run is a silent failure
  // (architect/developer/documentation) or expected (po/code-review).

  test("PO does not produce commits (operates on issue body via gh)", () => {
    const po = AGENTS.find(a => a.name === "po")!;
    assert.equal(shouldProduceCommits(po), false);
  });

  test("architect produces commits (writes spec to docs/specs/architecture/)", () => {
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldProduceCommits(arch), true);
  });

  test("developer produces commits (writes Go code + tests)", () => {
    const dev = AGENTS.find(a => a.name === "developer")!;
    assert.equal(shouldProduceCommits(dev), true);
  });

  test("code-review does not produce commits (PR comments only)", () => {
    // code-review uses a worktree (reads code locally) but never writes
    // — its output is PR comments via `gh pr review`. A 0-ahead branch
    // after code-review is the normal case, not a failure signal.
    const cr = AGENTS.find(a => a.name === "code-review")!;
    assert.equal(shouldProduceCommits(cr), false);
  });

  test("documentation produces commits (writes to docs/)", () => {
    const docs = AGENTS.find(a => a.name === "documentation")!;
    assert.equal(shouldProduceCommits(docs), true);
  });

  test("every AgentConfig declares producesCommits explicitly", () => {
    // Same forcing-function shape as `usesWorktree`: adding a new agent
    // forces an explicit decision about whether a 0-ahead branch after
    // its run is a failure or normal. No implicit defaults.
    for (const agent of AGENTS) {
      assert.equal(
        typeof agent.producesCommits,
        "boolean",
        `${agent.name} must declare producesCommits`,
      );
    }
  });
});

describe("parseCommitsAhead", () => {
  // Wraps `git rev-list --count <base>..<branch>` — emits a single
  // integer line. The empty-branch guard uses this to decide whether
  // an agent's run produced any commits.

  test("zero commits ahead → 0", () => {
    assert.equal(parseCommitsAhead("0\n"), 0);
  });

  test("non-zero commits ahead → N", () => {
    assert.equal(parseCommitsAhead("5\n"), 5);
    assert.equal(parseCommitsAhead("42\n"), 42);
  });

  test("trailing whitespace is tolerated", () => {
    assert.equal(parseCommitsAhead("3"), 3);
    assert.equal(parseCommitsAhead("  7  \n"), 7);
  });

  test("empty / non-numeric output → -1 sentinel (caller treats as unknown)", () => {
    // The dispatcher's caller checks `>= 0` before flagging; -1 means
    // "git output unparseable, don't act on it" — safer than treating
    // garbage as 0 and falsely flagging the run as empty.
    assert.equal(parseCommitsAhead(""), -1);
    assert.equal(parseCommitsAhead("\n"), -1);
    assert.equal(parseCommitsAhead("not a number"), -1);
  });
});

describe("shouldFlagEmptyBranch", () => {
  // True iff the agent was supposed to produce commits AND the branch
  // is still 0 ahead of main after the run. Belt-and-suspenders against
  // agents that exit cleanly without doing the work (relay #5: architect
  // refused without spec, developer refused without spec, code-review
  // FAILed silently because needs-rework labels didn't exist — board
  // marched to Done with feature/5 unchanged from main).

  test("PO + 0 commits → false (PO doesn't commit, expected)", () => {
    const po = AGENTS.find(a => a.name === "po")!;
    assert.equal(shouldFlagEmptyBranch(po, 0), false);
  });

  test("code-review + 0 commits → false (code-review doesn't commit, expected)", () => {
    const cr = AGENTS.find(a => a.name === "code-review")!;
    assert.equal(shouldFlagEmptyBranch(cr, 0), false);
  });

  test("architect + 0 commits → true (silent failure)", () => {
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldFlagEmptyBranch(arch, 0), true);
  });

  test("architect + 1+ commits → false (did the work)", () => {
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldFlagEmptyBranch(arch, 1), false);
    assert.equal(shouldFlagEmptyBranch(arch, 17), false);
  });

  test("developer + 0 commits → true (silent failure)", () => {
    const dev = AGENTS.find(a => a.name === "developer")!;
    assert.equal(shouldFlagEmptyBranch(dev, 0), true);
  });

  test("documentation + 0 commits → true (silent failure)", () => {
    const docs = AGENTS.find(a => a.name === "documentation")!;
    assert.equal(shouldFlagEmptyBranch(docs, 0), true);
  });

  test("negative commits-ahead (parse failed) → false (don't act on garbage)", () => {
    // -1 from `parseCommitsAhead` means "git output unparseable" — caller
    // skips the flag rather than acting on a value it doesn't trust.
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldFlagEmptyBranch(arch, -1), false);
  });
});

describe("decideCodegraphSymlink", () => {
  // Worktrees don't share `.codegraph/` with the canonical repo (it's
  // gitignored, lives outside `.git/`, and `git worktree add` doesn't
  // copy untracked dirs). Without a symlink, agents spawned in the
  // worktree see an empty index and silently fall through to grep.
  // Soft-fail on missing source — warn the operator but proceed; agents
  // can still run, they just lose codegraph's value for that ticket.

  test("source index exists, no destination yet → symlink (ready)", () => {
    assert.deepEqual(
      decideCodegraphSymlink({ sourceExists: true, destExists: false }),
      { action: "symlink", reason: "ready" },
    );
  });

  test("source exists AND destination exists → skip (already-present)", () => {
    // Idempotency: a re-prep of an existing worktree shouldn't churn the
    // symlink. Existing dst could be the previous run's symlink or a
    // real dir an operator dropped in; either way, leave it alone.
    assert.deepEqual(
      decideCodegraphSymlink({ sourceExists: true, destExists: true }),
      { action: "skip", reason: "already-present" },
    );
  });

  test("source missing → skip (no-source) — caller warns operator", () => {
    // Index hasn't been bootstrapped in the canonical repo. The
    // dispatcher should warn (so the operator runs `codegraph init -i`)
    // but proceed — agents fall through to grep, which is what they
    // did before codegraph existed.
    assert.deepEqual(
      decideCodegraphSymlink({ sourceExists: false, destExists: false }),
      { action: "skip", reason: "no-source" },
    );
  });

  test("source missing but destination present → skip (already-present, don't warn)", () => {
    // Edge case: previous run linked successfully, then someone moved
    // the canonical index away. Leave the dst alone (it's a stale
    // symlink, but cleaning it up isn't this function's job) and
    // don't warn (the present dst hides the staleness from the agent
    // — that's a separate problem class).
    assert.deepEqual(
      decideCodegraphSymlink({ sourceExists: false, destExists: true }),
      { action: "skip", reason: "already-present" },
    );
  });
});

describe("AGENT_COLUMN_MAP", () => {
  test("contains every agent in AGENTS", () => {
    for (const agent of AGENTS) {
      assert.equal(AGENT_COLUMN_MAP.get(agent.name), agent.column);
    }
  });

  test("size matches AGENTS (no duplicate names)", () => {
    assert.equal(AGENT_COLUMN_MAP.size, AGENTS.length);
  });
});

describe("agent claudeMdPath resolution", () => {
  test("paths are relative to agentsRepoRoot, NOT prefixed with 'agents/'", () => {
    // The original paths were "agents/po/CLAUDE.md" etc., which only
    // worked when agentsRepoRoot was buggy and pointed at the parent of
    // agents/. With c72adb4 fixing that, the prefix was now wrong and
    // resolved to agents/agents/po/CLAUDE.md. This test locks in that
    // claudeMdPath is relative to agents/ (the actual root).
    for (const agent of AGENTS) {
      assert.ok(
        !agent.claudeMdPath.startsWith("agents/"),
        `${agent.name}.claudeMdPath should not start with "agents/" (got ${agent.claudeMdPath})`,
      );
    }
  });

  // Note: the "each agent's CLAUDE.md actually exists on disk" check
  // used to live here. After the split into a standalone
  // `agent-dispatcher` repo, the dispatcher no longer owns per-agent
  // CLAUDE.md files — they live in each consumer's agents repo. The
  // belt-and-suspenders existence check now lives per-consumer.
});

describe("findAdvanceRule", () => {
  test("returns the matching rule for a (column, ready label) pair", () => {
    const rule = findAdvanceRule(
      AUTO_ADVANCE_RULES,
      "In Architecture",
      ["ready:architect"],
    );
    assert.ok(rule);
    assert.equal(rule.to, "In Development");
  });

  test("returns null when ready label is missing", () => {
    const rule = findAdvanceRule(
      AUTO_ADVANCE_RULES,
      "In Architecture",
      ["wip:architect"],
    );
    assert.equal(rule, null);
  });

  test("returns null when ready label belongs to a different column", () => {
    // ready:developer in Architecture column — wrong stage.
    const rule = findAdvanceRule(
      AUTO_ADVANCE_RULES,
      "In Architecture",
      ["ready:developer"],
    );
    assert.equal(rule, null);
  });

  test("returns null for an unknown column", () => {
    const rule = findAdvanceRule(
      AUTO_ADVANCE_RULES,
      "Some Bogus Column",
      ["ready:po"],
    );
    assert.equal(rule, null);
  });

  test("matches every advance step against its rule", () => {
    // Sanity-check: walking the chain end-to-end resolves cleanly.
    for (const rule of AUTO_ADVANCE_RULES) {
      const found = findAdvanceRule(AUTO_ADVANCE_RULES, rule.from, [rule.readyLabel]);
      assert.equal(found, rule);
    }
  });
});

