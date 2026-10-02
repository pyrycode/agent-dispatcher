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
  appendStderrTail,
  noResultErrorMessage,
  scrubCredentials,
  STDERR_MESSAGE_CHARS,
  STDERR_TAIL_CAP,
  stderrForMessage,
  AgentRunStoppedError,
  canSalvagePartialWork,
  decidePartialWorkSalvage,
  runStopKind,
  advanceIdleWatchdogState,
  advancePermissionDenialState,
  buildResumeArgv,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  idleStallMessage,
  idleWatchdogTickMs,
  initIdleWatchdogState,
  parseIdleTimeoutMs,
  shouldFireIdleWatchdog,
  buildResumePrompt,
  captureSessionId,
  decideCodegraphHealth,
  detectPermissionDenial,
  extractRateLimitInfo,
  findMissingAgentClaudeMds,
  findReadyPrNumber,
  initPermissionDenialState,
  isRetryableSpawnError,
  MAX_SPAWN_ATTEMPTS,
  maxTurnsFor,
  timeoutFor,
  mergeLegResults,
  parseBudgetScale,
  parseResumeLegs,
  parseSalvageGates,
  pickFinalSessionId,
  ResourceExhaustedError,
  retrySpawnOnTransientError,
  scrubSpawnEnv,
  shouldAttemptResume,
  shouldAttemptSafeSalvage,
  shouldUseWorktree,
  SPAWN_ENV_DENYLIST,
  SPAWN_RETRY_DELAYS_MS,
} from "./agent-runtime.js";
import {
  hasOpenBlockers,
  parseCommitsAhead,
  shouldFlagEmptyBranch,
  shouldProduceCommits,
} from "./blockers.js";
import { AGENT_COLUMN_MAP, selectDispatches } from "./dispatch-selection.js";
import {
  AUTO_ADVANCE_RULES,
  MANUAL_ADVANCE_GATES,
  MID_PIPELINE_COLUMNS,
  PIPELINE_LABEL_PREFIXES,
  REWORK_LOOP_THRESHOLD,
  countPipelineInFlight,
  decideAutoAdvance,
  decideDoneCleanup,
  decideStrandedWip,
  selectStrandedWipCandidates,
  decideMergeRetry,
  decidePostRunLabels,
  decidePendingDoneFinalizations,
  PENDING_DONE_PREFIX,
  decideReworkRoutes,
  decideFamilyBreaker,
  extractFamilyDispatchCount,
  extractMergeAttemptCount,
  extractReworkCount,
  FAMILY_BREAKER_COMMENT_MARKER,
  FAMILY_BREAKER_LABEL,
  FAMILY_DISPATCH_COMMENT_MARKER,
  FAMILY_DISPATCH_COUNT_PREFIX,
  FAMILY_DISPATCH_LIMIT_DEFAULT,
  collectOffBoardFamilyRoots,
  FAMILY_DISPATCH_RESET_MARKER,
  tallyFamilyComments,
  resolveFamilyDispatchLimit,
  resolveFamilyRoot,
  resolveFamilyTally,
  extractReworkTarget,
  findAdvanceRule,
  isMergeConflictError,
  isPipelineInFlight,
  isPipelineLabel,
  isPipelineLabelForAgent,
  decideRealClaudeGate,
  decideGateOutcome,
  decideGateVerdict,
  decideBaselineAdjustedVerdict,
  decideUnroutableRework,
  REWORK_TARGET_ERROR_LABEL,
  decideRealClaudeGateRun,
  REAL_CLAUDE_GATE_LABEL,
  REAL_CLAUDE_GATE_RUNNING_LABEL,
  shouldAddReadyLabel,
  shouldSkipDispatch,
  classifyAgentError,
} from "./pipeline-decisions.js";
import { buildBaselineCommand, buildBaselineFilter, formatGateEvidenceComment, parseGateOutput, stripPackageQualifier } from "./gate-output.js";
import { mapParentChain } from "./github.js";
import {
  decideBranchSetup,
  decideCodegraphSymlink,
  describeHeldWorktrees,
  findWorktreesForBranch,
  resolveAgentsRepoRoot,
  resolveAgentsRepoRootWithEnv,
  resolveDefaultBranch,
  resolveTargetRepoRoot,
  shouldAutoCommit,
  shouldPushPreRunMerge,
} from "./worktree.js";

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
    assert.equal(isPipelineLabel("done:po"), true);
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
    assert.equal(isPipelineLabelForAgent("done:developer", "developer"), true);
    assert.equal(isPipelineLabelForAgent("wip:developer", "developer"), true);
    assert.equal(isPipelineLabelForAgent("error:developer", "developer"), true);
    assert.equal(isPipelineLabelForAgent("needs-rework:developer", "developer"), true);
  });

  test("does NOT match other agents' pipeline labels (the bug)", () => {
    // Dispatching `architect`, an `error:developer` left as a breadcrumb
    // by a prior dev run is NOT the architect dispatch's concern.
    assert.equal(isPipelineLabelForAgent("error:developer", "architect"), false);
    assert.equal(isPipelineLabelForAgent("done:po", "architect"), false);
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
      shouldSkipDispatch(["done:po", "done:architect", "wip:developer"], "code-review"),
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
      assert.equal(shouldSkipDispatch([`done:${agent.name}`], agent.name), true);
      assert.equal(shouldSkipDispatch([], agent.name), false);
    }
  });

  test("error:max_turns_salvaged blocks ALL agents until human triages", () => {
    // The salvaged label sits on a ticket whose work is preserved as a
    // draft PR awaiting human review. WITHOUT this gate, the next
    // dispatch cycle would re-dispatch the same agent, hit max_turns
    // again, and the existing PR-already-exists salvage path would
    // treat the open draft PR as success — auto-advancing partial work
    // to code-review with `done:<agent>`. That's exactly what the
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

  test("error:rework-loop blocks all agents while the ticket awaits human triage", () => {
    for (const agent of AGENTS) {
      assert.equal(shouldSkipDispatch(["error:rework-loop"], agent.name), true);
    }
    assert.equal(
      shouldSkipDispatch(
        ["done:builder", "needs-rework:builder", "rework-count:3", "error:rework-loop"],
        "verifier",
      ),
      true,
    );
  });

  test("needs-human:sizing does NOT block dispatch — it is a marker, not a gate", () => {
    // Design change, same day it was introduced. The label was briefly a
    // global block, on the reading that an agent hitting the split-depth
    // gate stops and waits for a person to choose between one ticket and
    // the split it described.
    //
    // The operator's call after seeing it fire on pyrycode#1938: once
    // splitting is off the table there is no "do not build this"
    // outcome, so the wait only buys a delay and a second run at the
    // same measurement. The agent now records the split it would have
    // made, applies this label so the judgement is findable on the
    // board, and carries on. The prompts changed with this commit.
    //
    // The label therefore MUST NOT block. It survives on the ticket
    // after the agent commits its spec, so a block here would stall the
    // developer on the very ticket the agent just unblocked.
    for (const agent of AGENTS) {
      assert.equal(
        shouldSkipDispatch(["needs-human:sizing"], agent.name),
        false,
        `needs-human:sizing must not block dispatch for ${agent.name}`,
      );
    }
  });

  test("needs-human:sizing alongside a real ticket's labels still does not block", () => {
    // #1938's actual set at the moment the gate fired.
    assert.equal(
      shouldSkipDispatch(
        ["enhancement", "size:s", "done:po", "security-sensitive", "needs-real-claude", "needs-human:sizing"],
        "architect",
      ),
      false,
    );
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

  test("matches gh pr update-branch --rebase's refusal verbatim (2026-09-23)", () => {
    assert.equal(
      isMergeConflictError("GraphQL: rebase conflict between base and head (updatePullRequestBranch)"),
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

  test("matches `gh pr update-branch --rebase`'s conflict phrasing", () => {
    // THE GAP THAT LET THE DONE-CARD TRAP RUN FOR MONTHS, captured live
    // from gh on 2026-08-06 against a deliberately conflicting scratch PR:
    //   X Cannot update PR branch due to conflicts
    //
    // This is a DIFFERENT sentence from `gh pr merge`'s, and it matched
    // none of the three original patterns. It matters more than the merge
    // one, because runAutoMerge's Step 1.5 rebase runs FIRST and `continue`s
    // on a non-conflict verdict — so on a conflicting PR the code never
    // reached Step 2's working detector at all. The result was a silent
    // skip every cycle forever: no `error:merge-conflict` label, no Discord
    // notification, and a Done card sitting over an unmerged PR with nothing
    // anywhere saying so. #1174 sat that way for ten days, #1240 twice.
    assert.equal(
      isMergeConflictError("X Cannot update PR branch due to conflicts"),
      true,
    );
  });

  test("matches the 'due to conflicts' phrase alone", () => {
    // Robust against gh rewording the prefix, the same posture as the
    // 'merge commit cannot be cleanly created' test above.
    assert.equal(isMergeConflictError("failed: due to conflicts"), true);
  });

  test("does not match partial-keyword false positives", () => {
    // 'merge' alone, or 'conflict' alone, should NOT match — too broad.
    // This is why the update-branch fix adds the phrase 'due to conflicts'
    // rather than widening to a bare 'conflict' substring, which would
    // regress this case.
    assert.equal(isMergeConflictError("ready to merge"), false);
    assert.equal(isMergeConflictError("name conflict in resource"), false);
    assert.equal(isMergeConflictError("resolved a naming conflict"), false);
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
    assert.equal(extractReworkTarget("done:po"), null);
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
      const agentName = rule.readyLabel.replace("done:", "");
      assert.ok(
        knownAgents.has(agentName),
        `rule readyLabel ${rule.readyLabel} references unknown agent ${agentName}`,
      );
    }
  });

  test("each rule's `from` column is owned by its readyLabel's agent", () => {
    // The `from` column should be the column of the agent whose `done:`
    // label triggers the advance — i.e. PO's column is Backlog, architect's
    // is In Architecture, etc.
    for (const rule of AUTO_ADVANCE_RULES) {
      const agentName = rule.readyLabel.replace("done:", "");
      const expectedColumn = AGENT_COLUMN_MAP.get(agentName);
      assert.equal(
        rule.from,
        expectedColumn,
        `rule ${rule.readyLabel} should advance from agent's column (${expectedColumn}), got ${rule.from}`,
      );
    }
  });

  test("one rule per agent (no missing or extra stages)", () => {
    assert.equal(AUTO_ADVANCE_RULES.length, AGENTS.length);
  });

  test("developer → qa → code-review ordering (QA gates tests BEFORE code-review judgment)", () => {
    // QA inserted 2026-05-22 between developer and code-review. Locks the
    // economic property: red runs cost only a QA spawn + rework cycle;
    // code-review never burns judgment-heavy tokens on code about to be
    // rejected on mechanical gates. Reversing the order (developer → code-review
    // → qa) would re-introduce the original economic problem.
    const devRule = AUTO_ADVANCE_RULES.find(r => r.from === "In Development");
    assert.ok(devRule, "expected an advance rule from In Development");
    assert.equal(devRule!.to, "In QA");
    assert.equal(devRule!.readyLabel, "done:developer");

    const qaRule = AUTO_ADVANCE_RULES.find(r => r.from === "In QA");
    assert.ok(qaRule, "expected an advance rule from In QA");
    assert.equal(qaRule!.to, "In Code Review");
    assert.equal(qaRule!.readyLabel, "done:qa");
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
      isPipelineInFlight([{ issueNumber: 28, labels: ["size:s", "done:architect"] }]),
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
        { issueNumber: 28, labels: ["done:architect"] },
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
      isPipelineInFlight([{ issueNumber: -1, labels: ["done:po"] }]),
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

  test("a ticket a background gate is still writing to never advances", () => {
    // A failing verdict moves the ticket back before adding its rework label.
    // In between it reads as finished developer work, until the running label
    // comes off last.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["In Development", [
        { id: "i1", issueNumber: 1382, labels: ["done:developer", REAL_CLAUDE_GATE_LABEL, REAL_CLAUDE_GATE_RUNNING_LABEL] },
      ]]),
      0,
      3,
    );
    assert.deepEqual(d.advances, []);
  });

  test("single done:po in Backlog, pipeline empty → advance to In Architecture", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["done:po", "size:s"] }]]),
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

  test("two done:po in Backlog at maxConcurrent=1, pipeline empty → first advances, second held", () => {
    // With WIP=1 (legacy mode, PYRY_MAX_CONCURRENT=1), only one Backlog
    // ticket may enter the pipeline per cycle. This is the b39f569 fix
    // semantic: without the within-cycle cap, both #28 and #29 would
    // have advanced together when the pipeline could only accept one.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i1", issueNumber: 28, labels: ["done:po", "size:s"] },
        { id: "i2", issueNumber: 29, labels: ["done:po", "size:s"] },
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
        { id: "i2", issueNumber: 29, labels: ["done:po"] },
        { id: "i1", issueNumber: 28, labels: ["done:po"] },
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
        { id: "i3", issueNumber: 31, labels: ["done:po"] },
        { id: "i1", issueNumber: 28, labels: ["done:po"] },
        { id: "i2", issueNumber: 30, labels: ["done:po"] },
      ]]),
      0,
      1,
    );
    // First eligible (input order) = #31; held = [#28, #30] in input order
    // (NOT [28, 30, 31] sorted, NOT [31, 30, 28] reversed).
    assert.equal(d.advances[0].issueNumber, 31);
    assert.deepEqual(d.backlogHeld, [28, 30]);
  });

  test("done:po in Backlog while pipeline at capacity → all held, no advance", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 29, labels: ["done:po"] }]]),
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
      items(["In Architecture", [{ id: "i1", issueNumber: 28, labels: ["done:architect"] }]]),
      1,
      1,
    );
    assert.deepEqual(d.advances, []);
    assert.equal(d.gatedAwaiting.length, 1);
    assert.equal(d.gatedAwaiting[0].column, "In Architecture");
    assert.deepEqual(d.gatedAwaiting[0].itemNumbers, [28]);
  });

  test("needs-rework label blocks advance even with done:po", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["done:po", "needs-rework:po"] }]]),
      0,
      1,
    );
    assert.deepEqual(d.advances, []);
  });

  test("error label blocks advance even with done:po", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 28, labels: ["done:po", "error:po"] }]]),
      0,
      1,
    );
    assert.deepEqual(d.advances, []);
  });

  test("non-issue items (issueNumber <= 0) skip", () => {
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{ id: "i1", issueNumber: 0, labels: ["done:po"] }]]),
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
    // A ticket sitting in In Development with done:developer should advance
    // to In QA even though another ticket sits at In Architecture.
    // The cap holds NEW tickets out of the pipeline; in-flight tickets keep
    // flowing forward regardless.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(
        ["In Architecture", [{ id: "i1", issueNumber: 28, labels: ["done:architect"] }]],
        ["In Development",  [{ id: "i2", issueNumber: 30, labels: ["done:developer"] }]],
      ),
      1,
      1,
    );
    const devAdvance = d.advances.find(a => a.fromColumn === "In Development");
    assert.ok(devAdvance, "expected an advance from In Development");
    assert.equal(devAdvance!.issueNumber, 30);
    assert.equal(devAdvance!.toColumn, "In QA");
  });

  test("blocked Backlog item does not auto-advance (stays in Backlog until unblocked)", () => {
    // A blocked ticket can be PO-refined (done:po set) but should not
    // auto-advance to In Architecture while blockers are open. Keeps
    // the board state honest: blocked tickets stay in the queue, not
    // the architect's column.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [{
        id: "i1",
        issueNumber: 45,
        labels: ["done:po", "size:s"],
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
        labels: ["done:po", "size:s"],
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
        ["In Development", [{ id: "i1", issueNumber: 30, labels: ["done:developer"] }]],
        ["In Code Review", [{ id: "i2", issueNumber: 31, labels: ["done:code-review"] }]],
      ),
      2,
      2,
    );
    assert.equal(d.advances.length, 2);
    assert.ok(d.advances.some(a => a.issueNumber === 30 && a.toColumn === "In QA"));
    assert.ok(d.advances.some(a => a.issueNumber === 31 && a.toColumn === "In Documentation"));
  });

  // ----- WIP=N cap on Backlog promotion (2026-05-08 fix) -----
  //
  // Before the fix, `decideAutoAdvance` advanced at most ONE Backlog ticket
  // per cycle even when `selectDispatches` had room for N. Refined
  // `done:po` tickets piled up in Backlog while only one drained per cycle,
  // so PO frontran the queue (consuming the second WIP slot for new
  // refinement work) while the pipeline ran serially. Concurrency was a
  // mirage. These tests lock in the new capacity-bounded behaviour.

  test("WIP=N: two done:po, no in-flight, max=2 → both advance same cycle", () => {
    // The bug case. Pre-fix: only #28 advanced; #29 stayed `done:po` in
    // Backlog and waited a full cycle for the next promotion slot. Post-fix:
    // capacity = max(0, 2 - 0) = 2 → both go.
    const d = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["Backlog", [
        { id: "i1", issueNumber: 28, labels: ["done:po"] },
        { id: "i2", issueNumber: 29, labels: ["done:po"] },
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
        { id: "i1", issueNumber: 28, labels: ["done:po"] },
        { id: "i2", issueNumber: 29, labels: ["done:po"] },
        { id: "i3", issueNumber: 30, labels: ["done:po"] },
        { id: "i4", issueNumber: 31, labels: ["done:po"] },
        { id: "i5", issueNumber: 32, labels: ["done:po"] },
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
        { id: "i1", issueNumber: 28, labels: ["done:po"] },
        { id: "i2", issueNumber: 29, labels: ["done:po"] },
        { id: "i3", issueNumber: 30, labels: ["done:po"] },
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
      items(["Backlog", [{ id: "i1", issueNumber: 30, labels: ["done:po"] }]]),
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
      items(["Backlog", [{ id: "i1", issueNumber: 30, labels: ["done:po"] }]]),
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
        { id: "i1", issueNumber: 28, labels: ["done:po"] },
        { id: "i2", issueNumber: 29, labels: ["done:po"] },
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
        { issueNumber: 28, labels: ["done:architect"] },
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
        { issueNumber: 28, labels: ["done:architect"] },
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
        { issueNumber: -1, labels: ["done:po"] },
        { issueNumber: 28, labels: [] },
      ]),
      1,
    );
  });

  test("excludes tickets with OPEN blockers (the #10 deadlock fix)", () => {
    // Surfaced 2026-05-16: pyrycode/pyrycode#383 in "In Development"
    // blocked-by #409. `hasOpenBlockers` correctly prevents dispatch,
    // but pre-fix the same ticket held a capacity seat — deadlocking
    // Backlog promotion at MAX_CONCURRENT=1.
    assert.equal(
      countPipelineInFlight([
        { issueNumber: 28, labels: ["done:architect"] },
        { issueNumber: 383, labels: ["size:s"], blockedBy: [{ number: 409, state: "OPEN" }] },
      ]),
      1,
      "blocked ticket must not consume a pipeline seat",
    );
  });

  test("CLOSED blockers do NOT exclude — only OPEN blockers park a ticket", () => {
    // A blocker that already closed is no longer blocking; the ticket
    // is back in active flow and should consume a seat.
    assert.equal(
      countPipelineInFlight([
        { issueNumber: 28, labels: [], blockedBy: [{ number: 100, state: "CLOSED" }] },
        { issueNumber: 29, labels: [], blockedBy: [{ number: 101, state: "CLOSED" }, { number: 102, state: "CLOSED" }] },
      ]),
      2,
    );
  });

  test("mixed OPEN+CLOSED blockers → still excluded (any OPEN blocker parks the ticket)", () => {
    // Inherits hasOpenBlockers semantics: one OPEN entry is enough.
    assert.equal(
      countPipelineInFlight([
        { issueNumber: 383, labels: [], blockedBy: [{ number: 100, state: "CLOSED" }, { number: 409, state: "OPEN" }] },
      ]),
      0,
    );
  });

  test("error:* AND blocked → still excluded (order-independent)", () => {
    // Both exclusions stack; the ticket is excluded once even when
    // both reasons apply.
    assert.equal(
      countPipelineInFlight([
        { issueNumber: 383, labels: ["error:developer"], blockedBy: [{ number: 409, state: "OPEN" }] },
        { issueNumber: 28, labels: [] },
      ]),
      1,
    );
  });

  test("undefined blockedBy treated as no blockers (back-compat with pre-fix call sites)", () => {
    // The shape was tightened with an optional field; existing callers
    // that pass {issueNumber, labels} without blockedBy must keep
    // counting as in-flight (they're not blocked).
    assert.equal(
      countPipelineInFlight([
        { issueNumber: 28, labels: ["done:architect"] },
        { issueNumber: 29, labels: [], blockedBy: [] },
      ]),
      2,
    );
  });

  test("isPipelineInFlight is countPipelineInFlight > 0", () => {
    // Locks the alias relationship — boolean wrapper must agree with count.
    const cases: { issueNumber: number; labels: string[]; blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[] }[][] = [
      [],
      [{ issueNumber: 1, labels: [] }],
      [{ issueNumber: 99, labels: ["error:po"] }],
      [
        { issueNumber: 99, labels: ["error:po"] },
        { issueNumber: 28, labels: [] },
      ],
      // #10 cases: blocker exclusion propagates to the boolean wrapper.
      [{ issueNumber: 383, labels: [], blockedBy: [{ number: 409, state: "OPEN" }] }],
      [
        { issueNumber: 383, labels: [], blockedBy: [{ number: 409, state: "OPEN" }] },
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

describe("decideRealClaudeGate + auto-advance belt", () => {
  type Item = { id: string; issueNumber: number; labels: string[]; blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[] };
  const items = (...rows: [string, Item[]][]): Map<string, Item[]> => new Map(rows);

  test("empty pipeline → no gate routes", () => {
    assert.deepEqual(decideRealClaudeGate(items()), []);
  });

  test("In Code Review + done:code-review + needs-real-claude → route to Inbox", () => {
    const r = decideRealClaudeGate(
      items(["In Code Review", [{
        id: "i1",
        issueNumber: 1168,
        labels: ["done:code-review", "size:s", REAL_CLAUDE_GATE_LABEL],
      }]]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].issueNumber, 1168);
    assert.equal(r[0].fromColumn, "In Code Review");
    assert.equal(r[0].toColumn, "Inbox");
  });

  test("gate label present but review not done → NOT parked (waits for code review)", () => {
    // Requiring done:code-review lets a mid-review ticket flow normally and a
    // real review failure (needs-rework:developer) take precedence — that
    // ticket never gets done:code-review.
    const r = decideRealClaudeGate(
      items(["In Code Review", [{
        id: "i1",
        issueNumber: 1168,
        labels: ["size:s", REAL_CLAUDE_GATE_LABEL],
      }]]),
    );
    assert.deepEqual(r, []);
  });

  test("done:code-review but no gate label → NOT parked", () => {
    const r = decideRealClaudeGate(
      items(["In Code Review", [{
        id: "i1",
        issueNumber: 42,
        labels: ["done:code-review", "size:s"],
      }]]),
    );
    assert.deepEqual(r, []);
  });

  test("gate label in an earlier column → NOT parked (fires only at the code-review boundary)", () => {
    const r = decideRealClaudeGate(
      items(["In Development", [{
        id: "i1",
        issueNumber: 42,
        labels: ["done:developer", REAL_CLAUDE_GATE_LABEL],
      }]]),
    );
    assert.deepEqual(r, []);
  });

  test("belt: decideAutoAdvance refuses to advance a gated ticket past code review", () => {
    // The structural guarantee, independent of runRealClaudeGate: a ticket
    // eligible in every other respect must NOT advance to In Documentation
    // while it carries the gate label.
    const gated = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["In Code Review", [{
        id: "i1",
        issueNumber: 1168,
        labels: ["done:code-review", REAL_CLAUDE_GATE_LABEL],
      }]]),
      0,
      5,
    );
    assert.equal(gated.advances.length, 0);

    // Control: the same ticket WITHOUT the label advances normally.
    const ungated = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["In Code Review", [{
        id: "i1",
        issueNumber: 1168,
        labels: ["done:code-review"],
      }]]),
      0,
      5,
    );
    assert.equal(ungated.advances.length, 1);
    assert.equal(ungated.advances[0].toColumn, "In Documentation");
  });

  test("belt scoped to the boundary: a gated ticket still advances through earlier stages", () => {
    // The hold must not strand a gated ticket before code review. A gated
    // ticket with done:developer in In Development still advances to In QA.
    const r = decideAutoAdvance(
      AUTO_ADVANCE_RULES,
      MANUAL_ADVANCE_GATES,
      items(["In Development", [{
        id: "i1",
        issueNumber: 1168,
        labels: ["done:developer", REAL_CLAUDE_GATE_LABEL],
      }]]),
      0,
      5,
    );
    assert.equal(r.advances.length, 1);
    assert.equal(r.advances[0].toColumn, "In QA");
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
        labels: ["done:architect", "size:m", "needs-rework:po"],
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

  test("rework label strips done:/error: along with itself", () => {
    // The dispatcher cleans up stale state-prefix labels on rework so the
    // ticket arrives in the target column with a clean slate. Lock that.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["done:architect", "error:architect", "needs-rework:po", "size:m"],
      }]]),
    );
    assert.equal(r.length, 1);
    const stripped = new Set(r[0].labelsToStrip);
    assert.ok(stripped.has("needs-rework:po"));
    assert.ok(stripped.has("done:architect"));
    assert.ok(stripped.has("error:architect"));
    // Non-state labels survive
    assert.ok(!stripped.has("size:m"));
  });

  test("a ticket still carrying wip:<agent> is not routed this pass (2026-09-22)", () => {
    // Until 2026-09-22 routing only ran between awaited batches, so a wip
    // label here was always stale and got stripped with the rest. With the
    // dispatch pool routing runs while agents work, and a live wip means
    // the agent still owns the ticket. Routing waits for the next pass; a
    // dead run's stale wip is the stranded-wip sweep's job.
    const r = decideReworkRoutes(
      AGENT_COLUMN_MAP,
      items(["In Architecture", [{
        id: "i1",
        issueNumber: 27,
        labels: ["done:architect", "wip:architect", "error:architect", "needs-rework:po", "size:m"],
      }]]),
    );
    assert.equal(r.length, 0);
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

describe("decideUnroutableRework", () => {
  type Item = { id: string; issueNumber: number; labels: string[] };
  const items = (...rows: [string, Item[]][]): Map<string, Item[]> => new Map(rows);

  test("a rework label naming an agent the set lacks is reported", () => {
    // 2026-09-06, pyrycode #2089: a verifier on the builder set applied
    // needs-rework:po, a role that set does not have. The route decision
    // skipped it, the label stayed, and the verifier was re-dispatched 27
    // seconds later for a guaranteed repeat.
    const r = decideUnroutableRework(
      AGENT_COLUMN_MAP,
      items(["In Code Review", [{ id: "i1", issueNumber: 2089, labels: ["needs-rework:designer", "done:verifier"] }]]),
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].issueNumber, 2089);
    assert.equal(r[0].fromColumn, "In Code Review");
    assert.deepEqual(r[0].labels, ["needs-rework:designer"]);
  });

  test("a routable label alongside an unknown one is a route, not a park", () => {
    const r = decideUnroutableRework(
      AGENT_COLUMN_MAP,
      items(["In Code Review", [{ id: "i1", issueNumber: 1, labels: ["needs-rework:designer", "needs-rework:developer"] }]]),
    );
    assert.deepEqual(r, []);
  });

  test("no rework label, a bare one, or a non-issue item is nothing to report", () => {
    const r = decideUnroutableRework(
      AGENT_COLUMN_MAP,
      items(["Backlog", [
        { id: "i1", issueNumber: 1, labels: ["size:s"] },
        { id: "i2", issueNumber: 2, labels: ["needs-rework:"] },
        { id: "i3", issueNumber: 0, labels: ["needs-rework:designer"] },
      ]]),
    );
    assert.deepEqual(r, []);
  });

  test("the park label carries the error: prefix that stops dispatch", () => {
    assert.ok(REWORK_TARGET_ERROR_LABEL.startsWith("error:"));
  });
});

describe("decideDoneCleanup", () => {
  type Item = { id: string; issueNumber: number; labels: string[] };

  test("empty Done column → no cleanups", () => {
    const c = decideDoneCleanup([]);
    assert.deepEqual(c, []);
  });

  test("ticket with done:documentation → strip it", () => {
    // The reported bug: done:documentation persists on tickets that flow
    // into Done via runAutoAdvance. The auto-merge path strips pipeline
    // labels, but only when a PR exists. Doc-only tickets, manually-merged
    // PRs, and closed-as-won't-fix never get cleaned without this pass.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["done:documentation"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    assert.equal(c[0].itemId, "i1");
    assert.equal(c[0].issueNumber, 21);
    assert.deepEqual(c[0].labelsToStrip, ["done:documentation"]);
  });

  test("accumulated done:* labels from full pipeline run → strip all", () => {
    // A ticket that flowed through every agent accumulates a done:<agent>
    // for each. None get stripped between columns. Lock in that all five
    // come off when the ticket reaches Done.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: [
        "done:po",
        "done:architect",
        "done:developer",
        "done:code-review",
        "done:documentation",
      ],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    const stripped = new Set(c[0].labelsToStrip);
    assert.ok(stripped.has("done:po"));
    assert.ok(stripped.has("done:architect"));
    assert.ok(stripped.has("done:developer"));
    assert.ok(stripped.has("done:code-review"));
    assert.ok(stripped.has("done:documentation"));
    assert.equal(c[0].labelsToStrip.length, 5);
  });

  test("non-pipeline labels (size:, priority:, custom tags) survive", () => {
    // The cleanup is targeted at pipeline-state labels only. PO sizing,
    // priority, and any free-form tags (release notes, area:, etc.) must
    // not be touched.
    const items: Item[] = [{
      id: "i1",
      issueNumber: 21,
      labels: ["done:documentation", "size:s", "priority:normal", "area:dispatcher"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].labelsToStrip, ["done:documentation"]);
  });

  test("wip:/error:/needs-rework: also stripped on Done", () => {
    // A ticket can reach Done via the closed-sweep path (e.g. user
    // closes a won't-fix while it had wip:developer set, or the ticket
    // had needs-rework:po set when it got closed manually). These are
    // pipeline state, same family as done:*, and need cleanup too.
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
      labels: ["done:documentation", "rework-count:2"],
    }];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 1);
    const stripped = new Set(c[0].labelsToStrip);
    assert.ok(stripped.has("done:documentation"));
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
      { id: "i1", issueNumber: 21, labels: ["done:documentation"] },
      { id: "i2", issueNumber: 22, labels: ["size:s"] }, // already clean
      { id: "i3", issueNumber: 23, labels: ["wip:developer", "rework-count:1"] },
    ];
    const c = decideDoneCleanup(items);
    assert.equal(c.length, 2);
    const byNumber = new Map(c.map(e => [e.issueNumber, e]));
    assert.deepEqual(byNumber.get(21)!.labelsToStrip, ["done:documentation"]);
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
      labels: ["done:documentation"],
    }];
    const c = decideDoneCleanup(items);
    assert.deepEqual(c, []);
  });
});

describe("selectStrandedWipCandidates", () => {
  type Item = { id: string; issueNumber: number; labels: string[]; status?: string };

  test("clean board → nothing to consider", () => {
    // The normal case, and the one that has to stay free: a healthy board
    // yields no candidates and the sweep costs zero comments fetches. Runs
    // this process has in flight are excluded through the second argument
    // (the dispatch pool's keys); see the in-flight test below.
    const items: Item[] = [
      { id: "i1", issueNumber: 1, labels: ["done:builder"], status: "In Review" },
      { id: "i2", issueNumber: 2, labels: [], status: "Backlog" },
    ];
    assert.deepEqual(selectStrandedWipCandidates(items), []);
  });

  test("a wip: label that belongs to a run in flight is not a candidate (2026-09-22)", () => {
    // With the dispatch pool the sweep runs while agents work. On Mobile's
    // first pooled cycle it started its clock on both in-flight tickets and
    // posted an observation comment on each; a stale observation can later
    // authorise stripping a live run's label. In-flight keys are
    // `<agent>#<issue>`, the same as dispatch-pool.ts.
    const items: Item[] = [
      { id: "i1", issueNumber: 782, labels: ["done:builder", "wip:verifier"], status: "In Code Review" },
      { id: "i2", issueNumber: 590, labels: ["wip:verifier"], status: "In Code Review" },
      { id: "i3", issueNumber: 601, labels: ["wip:builder"], status: "In Development" },
    ];
    const c = selectStrandedWipCandidates(items, new Set(["verifier#782", "verifier#590"]));
    assert.deepEqual(c.map((x) => x.issueNumber), [601], "only the ticket with no run behind its label remains");
    assert.equal(selectStrandedWipCandidates(items, new Set(["builder#782"])).length, 3, "a different agent's run on the same ticket does not cover this label");
  });

  test("wip: label outside Done → a candidate carrying its wip labels", () => {
    const items: Item[] = [
      { id: "i1", issueNumber: 2191, labels: ["done:builder", "wip:verifier"], status: "In Review" },
    ];
    const c = selectStrandedWipCandidates(items);
    assert.equal(c.length, 1);
    assert.equal(c[0].issueNumber, 2191);
    assert.deepEqual(c[0].wipLabels, ["wip:verifier"]);
  });

  test("Done column is left to the Done cleanup", () => {
    // decideDoneCleanup already strips wip: there, and it does so without
    // an age gate because a ticket in Done is finished by definition.
    const items: Item[] = [
      { id: "i1", issueNumber: 7, labels: ["wip:documentation"], status: "Done" },
    ];
    assert.deepEqual(selectStrandedWipCandidates(items), []);
  });

  test("epics and virtual items (issueNumber <= 0) are skipped", () => {
    const items: Item[] = [
      { id: "i1", issueNumber: 0, labels: ["wip:developer"], status: "Backlog" },
    ];
    assert.deepEqual(selectStrandedWipCandidates(items), []);
  });

  test("several wip labels on one ticket all come back together", () => {
    // Two stages both stranded means two failed cleanups, which is exactly
    // what a sustained outage produces. They strip as one unit.
    const items: Item[] = [
      { id: "i1", issueNumber: 9, labels: ["wip:developer", "wip:qa", "size:m"], status: "In Development" },
    ];
    const c = selectStrandedWipCandidates(items);
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].wipLabels, ["wip:developer", "wip:qa"]);
  });
});

describe("decideStrandedWip", () => {
  const MIN_AGE = 120 * 60_000;
  const NOW = new Date("2026-09-09T12:00:00Z").getTime();
  const base = { issueNumber: 2191, wipLabels: ["wip:verifier"], minAgeMs: MIN_AGE, now: NOW };

  test("never observed → start the clock, strip nothing", () => {
    const a = decideStrandedWip({ ...base, markers: { observedAt: null, sweptAt: null } });
    assert.deepEqual(a, { kind: "mark", issueNumber: 2191 });
  });

  test("observed a moment ago → hold, with the time left", () => {
    // The window a legitimately running agent lives in. Stripping here is
    // what would let a second run force-remove the first one's worktree.
    const observedAt = new Date(NOW - 10 * 60_000);
    const a = decideStrandedWip({ ...base, markers: { observedAt, sweptAt: null } });
    assert.equal(a?.kind, "hold");
    assert.equal((a as { msRemaining: number }).msRemaining, MIN_AGE - 10 * 60_000);
  });

  test("observed longer ago than the gate → strip", () => {
    const observedAt = new Date(NOW - MIN_AGE - 60_000);
    const a = decideStrandedWip({ ...base, markers: { observedAt, sweptAt: null } });
    assert.deepEqual(a, { kind: "strip", issueNumber: 2191, labelsToStrip: ["wip:verifier"] });
  });

  test("exactly at the gate → strip (the boundary is inclusive)", () => {
    const observedAt = new Date(NOW - MIN_AGE);
    assert.equal(decideStrandedWip({ ...base, markers: { observedAt, sweptAt: null } })?.kind, "strip");
  });

  test("a sweep already acted on the newest observation → re-observe, do NOT strip", () => {
    // The regression this marker pair exists for. Ticket was stranded and
    // swept hours ago, then legitimately re-dispatched. Without the swept
    // marker the old observation is still the newest one and still older
    // than the gate, so the sweep would strip the running label off a live
    // agent within one poll of it starting.
    const observedAt = new Date(NOW - 5 * 60 * 60_000);
    const sweptAt = new Date(NOW - 5 * 60 * 60_000 + 1000);
    const a = decideStrandedWip({ ...base, markers: { observedAt, sweptAt } });
    assert.deepEqual(a, { kind: "mark", issueNumber: 2191 });
  });

  test("a swept marker OLDER than the observation does not block the strip", () => {
    // The second time a ticket strands. The older swept marker belongs to
    // the previous incident and must not veto this one forever.
    const sweptAt = new Date(NOW - 10 * 60 * 60_000);
    const observedAt = new Date(NOW - MIN_AGE - 60_000);
    assert.equal(decideStrandedWip({ ...base, markers: { observedAt, sweptAt } })?.kind, "strip");
  });

  test("no wip labels → no action at all", () => {
    assert.equal(
      decideStrandedWip({ ...base, wipLabels: [], markers: { observedAt: null, sweptAt: null } }),
      null,
    );
  });
});

describe("hasOpenBlockers — uniform across agents (post-2026-05-08 flip)", () => {
  // PO used to bypass the blocker check on the rationale that
  // refinement is "cheap prep work." But PO refines from the issue
  // body PLUS the docs — and the Documentation agent runs LAST in
  // the pipeline, so the docs lag the code. PO refining a blocked
  // ticket reads docs that don't yet describe the upstream's API,
  // baking stale assumptions into AC. Flipped so PO waits like
  // every other agent — this tier of tests locks in that the gate
  // is purely blocker-state-driven, no per-agent variation.
  //
  // The earlier `shouldSkipBlockedFor(agentName, blockers)` wrapper
  // existed to support the per-agent exemption. After the 2026-05-08
  // flip it was a one-line `return hasOpenBlockers(blockers)` with
  // an unused `agentName` parameter, so it was deleted 2026-05-09
  // late evening. These tests now exercise `hasOpenBlockers` directly.

  test("OPEN blocker → skip (any agent)", () => {
    assert.equal(hasOpenBlockers([{ number: 40, state: "OPEN" }]), true);
  });

  test("no blockers → don't skip", () => {
    assert.equal(hasOpenBlockers([]), false);
  });

  test("all-CLOSED blockers → don't skip (dependencies satisfied)", () => {
    assert.equal(hasOpenBlockers([{ number: 40, state: "CLOSED" }]), false);
  });

  test("any-OPEN-blocker holds even when other blockers are CLOSED", () => {
    assert.equal(
      hasOpenBlockers([
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
    assert.equal(extractReworkCount(["size:s", "done:po"]), 0);
  });

  test("single rework-count:2 → 2", () => {
    assert.equal(extractReworkCount(["size:s", "rework-count:2", "done:po"]), 2);
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

describe("extractMergeAttemptCount", () => {
  // Mirror of extractReworkCount's contract — same shape, different
  // counter (`merge-attempt:N` instead of `rework-count:N`). Used by
  // runAutoMerge to spread auto-merge conflict retries across cycles.

  test("empty labels → 0", () => {
    assert.equal(extractMergeAttemptCount([]), 0);
  });

  test("no merge-attempt label → 0", () => {
    assert.equal(extractMergeAttemptCount(["size:s", "done:developer"]), 0);
  });

  test("single merge-attempt:2 → 2", () => {
    assert.equal(extractMergeAttemptCount(["merge-attempt:2", "size:s"]), 2);
  });

  test("merge-attempt:0 → 0 (treated same as missing)", () => {
    // Edge case: counters are written by addLabel, never reset to 0
    // explicitly — they're stripped on success. But tolerate a literal
    // 0 if it ever appears (e.g. operator typo) by reading max-of-0.
    assert.equal(extractMergeAttemptCount(["merge-attempt:0"]), 0);
  });

  test("malformed merge-attempt → 0 (defensive)", () => {
    assert.equal(extractMergeAttemptCount(["merge-attempt:abc"]), 0);
    assert.equal(extractMergeAttemptCount(["merge-attempt:"]), 0);
  });

  test("multiple merge-attempt labels → max wins", () => {
    // Counter-accumulation is possible if a previous-counter strip
    // failed (network blip mid-cycle). Reading max biases toward
    // exhaustion — we'd rather give up early than under-count and
    // loop forever.
    assert.equal(
      extractMergeAttemptCount(["merge-attempt:1", "merge-attempt:3", "merge-attempt:2"]),
      3,
    );
  });

  test("negative merge-attempt → 0", () => {
    assert.equal(extractMergeAttemptCount(["merge-attempt:-1"]), 0);
  });
});

describe("decideMergeRetry", () => {
  // Pure decision: given the current attempt count and the max-attempts
  // threshold, what does the caller (runAutoMerge) do next on a
  // conflict — retry or give up?

  test("currentCount=0, max=3 → retry as attempt 1", () => {
    const r = decideMergeRetry({ currentCount: 0, maxAttempts: 3 });
    assert.deepEqual(r, { shouldGiveUp: false, newCount: 1, previousCount: 0 });
  });

  test("currentCount=1, max=3 → retry as attempt 2", () => {
    const r = decideMergeRetry({ currentCount: 1, maxAttempts: 3 });
    assert.deepEqual(r, { shouldGiveUp: false, newCount: 2, previousCount: 1 });
  });

  test("currentCount=2, max=3 → retry exhausted → give up", () => {
    // 3rd attempt failed = newCount === maxAttempts → shouldGiveUp.
    const r = decideMergeRetry({ currentCount: 2, maxAttempts: 3 });
    assert.deepEqual(r, { shouldGiveUp: true, newCount: 3, previousCount: 2 });
  });

  test("currentCount >= max → give up (defensive against double-bump)", () => {
    // If a prior retry path already bumped to maxAttempts and the
    // counter wasn't stripped, the next conflict still gives up
    // immediately — never loops past the threshold.
    const r = decideMergeRetry({ currentCount: 5, maxAttempts: 3 });
    assert.equal(r.shouldGiveUp, true);
  });

  test("maxAttempts=1 → first conflict gives up immediately", () => {
    // Edge case: caller could disable retry by setting max=1.
    const r = decideMergeRetry({ currentCount: 0, maxAttempts: 1 });
    assert.deepEqual(r, { shouldGiveUp: true, newCount: 1, previousCount: 0 });
  });
});

describe("decideDoneCleanup — merge-attempt counter", () => {
  // The counter counts auto-merge conflicts while the ticket sits open
  // in Done. Done cleanup runs before the auto-merge every cycle, so it
  // must leave the counter alone or the retry never reaches give-up
  // (mobile #878, 2026-09-23 to 09-25). The auto-merge path clears it
  // on merge and on give-up.

  test("strips pipeline labels and rework-count:N but keeps merge-attempt:N", () => {
    const cleanups = decideDoneCleanup([
      {
        id: "x",
        issueNumber: 42,
        labels: ["done:documentation", "rework-count:1", "merge-attempt:2", "size:s", "priority:high"],
      },
    ]);
    assert.equal(cleanups.length, 1);
    const stripped = new Set(cleanups[0]!.labelsToStrip);
    assert.ok(stripped.has("done:documentation"));
    assert.ok(stripped.has("rework-count:1"));
    assert.ok(!stripped.has("merge-attempt:2"));
    // Non-pipeline labels are left alone.
    assert.ok(!stripped.has("size:s"));
    assert.ok(!stripped.has("priority:high"));
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

  test("qa uses a worktree (checks out feature branch to run tests)", () => {
    const qa = AGENTS.find(a => a.name === "qa")!;
    assert.equal(shouldUseWorktree(qa), true);
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
  // base budget. The base bumped 70 → 90 on 2026-05-20 after a
  // turn-by-turn audit showed successful runs clustering at 59-68 turns
  // (#454, #466, #463, #459, #450, #453) jammed against the 70 cap on
  // real implementation work, not housekeeping. Earlier: 60 → 70 on
  // 2026-05-03 (housekeeping-tail cluster), 50 → 60 on 2026-05-02
  // (after #55).
  test("code-review gets 150 (runs sub-agents)", () => {
    const cr = AGENTS.find(a => a.name === "code-review")!;
    assert.equal(maxTurnsFor(cr), 150);
  });

  test("developer gets 135 (base budget)", () => {
    const dev = AGENTS.find(a => a.name === "developer")!;
    assert.equal(maxTurnsFor(dev), 135);
  });

  test("architect gets 135 (base budget — sketch + spec)", () => {
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(maxTurnsFor(arch), 135);
  });

  test("po gets 135 (base budget — issue body refinement)", () => {
    const po = AGENTS.find(a => a.name === "po")!;
    assert.equal(maxTurnsFor(po), 135);
  });

  test("documentation gets 135 (base budget — knowledge base writes)", () => {
    const docs = AGENTS.find(a => a.name === "documentation")!;
    assert.equal(maxTurnsFor(docs), 135);
  });

  test("qa gets 45 (hot path 5-10 turns, cold path 15-25 — mechanical gates only)", () => {
    // QA's work is bounded: run gates → green → exit, OR red → baseline-comparison
    // routing → triage. Below the base budget on purpose — drift into judgment
    // work (idiom/design) is what QA must NOT do; the low cap is the forcing
    // function. If genuine triage cost exceeds 30, the failure is a signal to
    // bump deliberately, not a routine adjustment.
    const qa = AGENTS.find(a => a.name === "qa")!;
    assert.equal(maxTurnsFor(qa), 45);
  });

  test("unknown agent name still gets the base budget (no implicit zero)", () => {
    // Defensive: a typo or new agent shouldn't silently dispatch with
    // 0 turns. The policy returns the base budget for any non-code-review
    // name; if a future agent needs more, it must be added explicitly.
    assert.equal(maxTurnsFor({ name: "ghost", column: "", claudeMdPath: "", description: "", usesWorktree: false, producesCommits: false }), 135);
  });
});

describe("timeoutFor", () => {
  // Wall-clock budget per role. code-review gets 40min (adversarial
  // sub-agents); developer/docs/qa get 25min; po + base architect get
  // 20min. The security-sensitive architect carve-out (40min) was added
  // 2026-05-31 after pyrycode-mobile#304 timed out: the architect wrote
  // the spec right at the 20min mark and the mandatory security-review
  // pass never started, and the salvage path discards timeout failures so
  // the uncommitted spec was lost.
  const arch = AGENTS.find(a => a.name === "architect")!;
  const cr = AGENTS.find(a => a.name === "code-review")!;
  const dev = AGENTS.find(a => a.name === "developer")!;
  const docs = AGENTS.find(a => a.name === "documentation")!;
  const qa = AGENTS.find(a => a.name === "qa")!;
  const po = AGENTS.find(a => a.name === "po")!;

  test("code-review gets 40min (runs sub-agents)", () => {
    assert.equal(timeoutFor(cr), 2_400_000);
    // code-review's budget is role-driven, not label-driven.
    assert.equal(timeoutFor(cr, ["security-sensitive"]), 2_400_000);
  });

  test("developer/documentation/qa get 25min (medium tier)", () => {
    assert.equal(timeoutFor(dev), 1_500_000);
    assert.equal(timeoutFor(docs), 1_500_000);
    assert.equal(timeoutFor(qa), 1_500_000);
  });

  test("po gets 20min (light tier)", () => {
    assert.equal(timeoutFor(po), 1_200_000);
  });

  test("architect gets 20min on an ordinary ticket", () => {
    assert.equal(timeoutFor(arch), 1_200_000);
    assert.equal(timeoutFor(arch, ["size:s"]), 1_200_000);
  });

  test("architect gets 40min when the ticket is security-sensitive (spec + adversarial security-review)", () => {
    assert.equal(timeoutFor(arch, ["security-sensitive"]), 2_400_000);
    assert.equal(timeoutFor(arch, ["done:po", "size:s", "security-sensitive"]), 2_400_000);
  });

  test("the security-sensitive bump is architect-only — it does not lift po", () => {
    // Only the architect runs the security-review pass, so only the
    // architect's budget keys off the label. PO on a security-sensitive
    // ticket stays at the light tier.
    assert.equal(timeoutFor(po, ["security-sensitive"]), 1_200_000);
  });

  test("unknown agent name still gets the base tier (no implicit zero)", () => {
    const ghost = { name: "ghost", column: "", claudeMdPath: "", description: "", usesWorktree: false, producesCommits: false };
    assert.equal(timeoutFor(ghost), 1_200_000);
    assert.equal(timeoutFor(ghost, ["security-sensitive"]), 1_200_000);
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
    timedOut: false,
    prAlreadyExists: false,
    gitStatusOutput: " M internal/e2e/rotation_test.go\n?? internal/e2e/internal/fakeclaude/main.go\n",
    gateExitCodes: [0, 0],
  };

  test("max_turns + uncommitted + all gates pass → salvage", () => {
    assert.equal(shouldAttemptSafeSalvage(baseOk), true);
  });

  test("a genuine error shape, with no timeout kill → no salvage", () => {
    // api_error is a real failure, not a budget running out. Nothing to
    // preserve on purpose.
    assert.equal(
      shouldAttemptSafeSalvage({ ...baseOk, terminalReason: "api_error" }),
      false,
    );
  });

  test("the REASON STRING 'timeout' does not trigger salvage — only the dispatcher's own kill flag does", () => {
    // Guards the distinction the pyrycode#1452 fix turns on. A reason
    // field that happens to read "timeout" is claude's self-report and is
    // NOT authoritative; the dispatcher's `timedOut` is. Keeping these
    // apart is what stops a future refactor from "simplifying" the gate
    // into a string match that a real wall-clock kill would miss, since a
    // real one leaves the reason EMPTY (see the next test).
    assert.equal(
      shouldAttemptSafeSalvage({ ...baseOk, terminalReason: "timeout", timedOut: false }),
      false,
    );
  });

  test("pyrycode#1452: wall-clock kill leaves an EMPTY reason and still salvages", () => {
    // The exact shape that destroyed 25 minutes of work on 2026-08-10.
    // The agent was SIGTERM'd at its wall; claude still emitted a result,
    // but with subtype=error_during_execution and no terminal_reason. The
    // old gate read the empty reason, skipped salvage, and the worktree
    // teardown took every edit with it.
    //
    // This assertion fails on the pre-fix predicate, which is the point.
    assert.equal(
      shouldAttemptSafeSalvage({ ...baseOk, terminalReason: "", timedOut: true }),
      true,
    );
  });

  test("a timeout kill still has to clear every other gate", () => {
    // Widening gate 1 must not weaken 2-4. These carry the whole safety
    // argument: don't double-handle a ticket that already has a PR, don't
    // open an empty PR, don't ship code that doesn't build.
    const timedOutBase = { ...baseOk, terminalReason: "", timedOut: true };
    assert.equal(
      shouldAttemptSafeSalvage({ ...timedOutBase, prAlreadyExists: true }),
      false,
      "timeout + existing PR must not salvage",
    );
    assert.equal(
      shouldAttemptSafeSalvage({ ...timedOutBase, gitStatusOutput: "" }),
      false,
      "timeout + clean worktree has nothing to preserve",
    );
    assert.equal(
      shouldAttemptSafeSalvage({ ...timedOutBase, gateExitCodes: [0, 1] }),
      false,
      "timeout + failing build gate must not ship a draft PR",
    );
  });

  test("both budgets exhausted at once → salvage (no double-counting)", () => {
    // A run can hit max_turns and be SIGTERM'd in the same breath. The
    // gate is an OR, so this is just the happy path twice over.
    assert.equal(
      shouldAttemptSafeSalvage({ ...baseOk, terminalReason: "max_turns", timedOut: true }),
      true,
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

describe("decideCodegraphHealth", () => {
  // Startup pre-flight that classifies the canonical .codegraph index
  // into one of three states for operator-facing logging:
  //   - missing:    no .codegraph at all (agents grep; bootstrap recommended)
  //   - queryable:  index exists, `codegraph status` agreed (good to go)
  //   - broken:     index exists but `codegraph status` says it isn't usable
  //                 (broken self-ref symlink, schema mismatch, db corruption,
  //                 wrong-project index — all surface here as a warn-loudly
  //                 signal so the operator can investigate at boot rather
  //                 than after a dispatch silently degrades)
  //
  // Pure decision; caller (dispatch-bin.ts) does the existsSync + spawnSync
  // and threads the results back here.

  test("missing index → state=missing", () => {
    const got = decideCodegraphHealth({
      exists: false,
      statusExitCode: null,
      statusStdout: "",
      statusStderr: "",
    });
    assert.equal(got.state, "missing");
  });

  test("exists + status exit 0 + clean output → state=queryable", () => {
    const got = decideCodegraphHealth({
      exists: true,
      statusExitCode: 0,
      statusStdout: "CodeGraph Status\nProject: /work/repo\nFiles indexed: 133\nIndex is up to date",
      statusStderr: "",
    });
    assert.equal(got.state, "queryable");
  });

  test("exists + 'Not initialized' in stdout → state=broken (the self-ref symlink case)", () => {
    // The exact failure mode that bricked pyrycode/.codegraph in the
    // late evening 2026-05-09 session — broken self-ref symlink lets
    // existsSync return true (the symlink exists), but codegraph status
    // can't follow it and reports "Not initialized" with exit 0. The
    // pre-flight catches this state at boot.
    const got = decideCodegraphHealth({
      exists: true,
      statusExitCode: 0,
      statusStdout: "CodeGraph Status\nProject: /work/repo\n⚠ Not initialized\nRun \"codegraph init\" to initialize",
      statusStderr: "",
    });
    assert.equal(got.state, "broken");
  });

  test("exists + non-zero exit → state=broken", () => {
    const got = decideCodegraphHealth({
      exists: true,
      statusExitCode: 1,
      statusStdout: "",
      statusStderr: "Error: db corruption detected",
    });
    assert.equal(got.state, "broken");
  });

  test("exists + null exit (spawn failed entirely) → state=broken", () => {
    // spawnSync returns null status when the binary couldn't be found
    // or the process couldn't be spawned (no PATH, ENOENT, etc.). Treat
    // as broken — codegraph CLI isn't installed or isn't reachable from
    // the dispatcher's environment.
    const got = decideCodegraphHealth({
      exists: true,
      statusExitCode: null,
      statusStdout: "",
      statusStderr: "",
    });
    assert.equal(got.state, "broken");
  });

  test("detail field surfaces actionable info on broken state", () => {
    const got = decideCodegraphHealth({
      exists: true,
      statusExitCode: 0,
      statusStdout: "Not initialized — run codegraph init",
      statusStderr: "",
    });
    assert.equal(got.state, "broken");
    assert.match(got.detail, /not initialized/i);
  });
});

describe("findMissingAgentClaudeMds", () => {
  // Belt-and-suspenders for the (rare but observed) failure mode where
  // a CLAUDE.md file goes missing in a consumer's agents repo —
  // typo'd path in the AGENTS config, accidental `git rm`, fork that
  // hasn't created the prompt file yet, etc. Today's runtime error
  // ("agent CLAUDE.md not found") catches it at dispatch time, mid-
  // cycle; this lets dispatch-bin.ts catch it at startup before
  // pollLoop ever runs. Pre-flight check, fail-fast.
  //
  // Pure decision; the caller (dispatch-bin.ts) does the existsSync
  // calls and the process.exit on non-empty result.

  const fakeAgents = [
    { name: "po", claudeMdPath: "po/CLAUDE.md" },
    { name: "architect", claudeMdPath: "architect/CLAUDE.md" },
    { name: "developer", claudeMdPath: "developer/CLAUDE.md" },
  ];

  test("all present → empty array (clean)", () => {
    const got = findMissingAgentClaudeMds({
      agents: fakeAgents,
      agentsRepoRoot: "/work/agents",
      existsSync: () => true,
    });
    assert.deepEqual(got, []);
  });

  test("one missing → single-entry array with absolute path", () => {
    const got = findMissingAgentClaudeMds({
      agents: fakeAgents,
      agentsRepoRoot: "/work/agents",
      existsSync: (p) => !p.endsWith("architect/CLAUDE.md"),
    });
    assert.deepEqual(got, [{ name: "architect", path: "/work/agents/architect/CLAUDE.md" }]);
  });

  test("multiple missing → all reported (don't bail on first)", () => {
    // Reporting all up front is more useful than fail-fast-on-first
    // when an operator just cloned a fresh fork — they want to fix
    // every gap at once, not run + fail + run + fail.
    const got = findMissingAgentClaudeMds({
      agents: fakeAgents,
      agentsRepoRoot: "/work/agents",
      existsSync: (p) => p.endsWith("po/CLAUDE.md"),
    });
    assert.deepEqual(got, [
      { name: "architect", path: "/work/agents/architect/CLAUDE.md" },
      { name: "developer", path: "/work/agents/developer/CLAUDE.md" },
    ]);
  });

  test("empty agents list → empty result (vacuously OK)", () => {
    const got = findMissingAgentClaudeMds({
      agents: [],
      agentsRepoRoot: "/work/agents",
      existsSync: () => false,
    });
    assert.deepEqual(got, []);
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
  // cleanup" auto-advances partial work via `done:<agent>`, which
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

  test("ineligible labels filter out (wip:* / done:* / needs-rework:* / error:*)", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["Backlog", [
          item(1, ["wip:po"]),                        // skipped (in flight)
          item(2, ["done:po"]),                      // skipped (already done)
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

  test("a rework-loop halt prevents another review dispatch on the same ticket", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["In Code Review", [
          item(2671, ["done:builder", "needs-rework:builder", "rework-count:3", "error:rework-loop"]),
        ]],
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
    });
    assert.deepEqual(r, []);
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

  // Serial agent cap (post-2026-05-10). Agents with `serial: true` in
  // AgentConfig (currently: documentation) get a per-agent WIP=1 cap on
  // top of the global maxConcurrent. Surfaced when concurrent
  // documentation runs on #1 and #2 produced add/add merge conflicts on
  // docs/knowledge/INDEX.md (both branches added the same file
  // independently), leaving #2's PR mergeStateStatus=DIRTY after #1
  // merged.

  test("serial agent: real AGENTS — documentation caps at 1 picks per cycle", () => {
    // documentation has `serial: true` in the real AGENTS array. Two
    // eligible items in In Documentation must produce exactly one
    // candidate — the second one waits for the first to finish.
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["In Documentation", [item(1), item(2)]],
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 5,
    });
    assert.equal(r.length, 1, "documentation must serialize regardless of maxConcurrent");
    assert.equal(r[0].agent.name, "documentation");
    assert.equal(r[0].item.issueNumber, 1);
  });

  test("serial agent: in-flight wip:<self> in same column blocks new pick", () => {
    // One item already running (wip:documentation present in the
    // snapshot). Even if the global cap allows more, the serial cap is 1
    // — the new candidate must wait.
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["In Documentation", [
          item(1, ["wip:documentation"]),  // already running
          item(2),                         // would be eligible
        ]],
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 5,
    });
    assert.equal(r.length, 0);
  });

  test("serial agent: in-flight wip:<self> in another column also counts", () => {
    // Edge case: wip:documentation could survive on a ticket already
    // moved to Done before runDoneCleanup strips it. The serial cap
    // counts wip:* across ALL columns so snapshot races don't smuggle
    // a second concurrent run through.
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["Done", [item(99, ["wip:documentation"])]],  // stale wip from prior cycle
        ["In Documentation", [item(1)]],              // new candidate
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 5,
    });
    assert.equal(r.length, 0, "stale wip:* in any column counts as in-flight for serial agents");
  });

  test("serial cap doesn't constrain other agents in the same cycle", () => {
    // documentation is serial. PO is not. A serialized documentation
    // pick must NOT prevent PO from filling the rest of the global
    // budget with parallel refinements.
    const r = selectDispatches({
      itemsByColumn: new Map([
        ["In Documentation", [item(10), item(11)]],   // serial cap → 1
        ["Backlog", [item(1), item(2), item(3)]],     // PO unbounded (within global)
      ]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 4,
    });
    // 1 documentation + 3 PO = 4 (hits global cap)
    assert.equal(r.length, 4);
    const byAgent = r.reduce((acc, c) => {
      acc[c.agent.name] = (acc[c.agent.name] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    assert.equal(byAgent["documentation"], 1);
    assert.equal(byAgent["po"], 3);
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

  test("both exist, origin is ancestor of local → abort-local-strictly-ahead", () => {
    // Local has real commits on top of origin (a prior dispatch committed
    // but failed to push). Pushing the missing commits is the likely fix, so
    // this case is safe to advise "push". Distinct from a genuine divergence.
    assert.equal(
      decideBranchSetup({
        localExists: true,
        remoteExists: true,
        localEqualsOrigin: false,
        localIsAncestorOfOrigin: false,
        originIsAncestorOfLocal: true,
      }),
      "abort-local-strictly-ahead",
    );
  });

  test("both exist, neither is ancestor of the other → abort-local-diverged", () => {
    // Local and origin have both moved: origin was advanced out-of-band (a
    // manual triage / hot-fix push) while local carried its own commits.
    // Pushing local would REVERT origin's work, so the advice must differ
    // from the strictly-ahead case. Origin is the source of truth.
    assert.equal(
      decideBranchSetup({
        localExists: true,
        remoteExists: true,
        localEqualsOrigin: false,
        localIsAncestorOfOrigin: false,
        originIsAncestorOfLocal: false,
      }),
      "abort-local-diverged",
    );
  });

  test("local exists, remote exists, ancestry flags missing → abort-local-diverged (cautious default)", () => {
    // If the caller forgot to compute the equality/ancestor flags, default
    // to the cautious message: never advise pushing local, since we can't
    // prove it's strictly ahead. Abort and surface for human triage.
    assert.equal(
      decideBranchSetup({ localExists: true, remoteExists: true }),
      "abort-local-diverged",
    );
  });
});

describe("shouldPushPreRunMerge", () => {
  // pyrycode-mobile #1340, 2026-10-02: a pre-run merge that only the
  // end-of-run push carried was stranded when the run crashed, and the next
  // dispatch refused with abort-local-strictly-ahead.

  test("branch on origin, HEAD moved → push", () => {
    assert.equal(shouldPushPreRunMerge({ remoteExists: true, headBefore: "a", headAfter: "b" }), true);
  });

  test("branch on origin, HEAD unchanged (no-op merge) → no push", () => {
    assert.equal(shouldPushPreRunMerge({ remoteExists: true, headBefore: "a", headAfter: "a" }), false);
  });

  test("branch not on origin → no push, even when HEAD moved", () => {
    assert.equal(shouldPushPreRunMerge({ remoteExists: false, headBefore: "a", headAfter: "b" }), false);
  });

  test("either HEAD unreadable → no push, the end-of-run push decides", () => {
    assert.equal(shouldPushPreRunMerge({ remoteExists: true, headBefore: "", headAfter: "b" }), false);
    assert.equal(shouldPushPreRunMerge({ remoteExists: true, headBefore: "a", headAfter: "" }), false);
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
    assert.deepEqual(d.priorReadyLabelsToStrip, []);
  });

  // --- priorReadyLabelsToStrip — added 2026-05-10 to fix observed
  // accumulation on relay #7 (carried `done:po + done:architect +
  // error:max_turns_salvaged` mid-pipeline). The asymmetry has been
  // present since pyrycode/agents@985bad1 — auto-advance moves columns
  // without stripping prior agents' `done:*`, runReworkRouting strips
  // only on rework, runDoneCleanup strips only at Done. For tickets
  // that freeze on a global-block label between Done and the rework
  // path, prior `done:*` labels are misleading provenance. Surfacing
  // them was rare enough that no one observed it until the first
  // `error:max_turns_salvaged` ticket got past two agents.

  test("happy path with prior done:po → strips done:po before adding done:architect", () => {
    // The relay #7 shape: PO refined → done:po; auto-advance to
    // In Architecture; architect ran successfully → addReadyLabel=true.
    // Without strip, ticket carries both done:po + done:architect.
    const d = decidePostRunLabels({
      postLabels: ["done:po", "size:s", "security-sensitive"],
      agentName: "architect",
      agentColumn: "In Architecture",
      currentColumn: "In Architecture",
    });
    assert.equal(d.addReadyLabel, true);
    assert.equal(d.logKind, "ready");
    assert.deepEqual(d.priorReadyLabelsToStrip, ["done:po"]);
  });

  test("happy path with multiple prior done:* → strips all of them", () => {
    // A developer run after PO + architect — both prior `done:*`
    // accumulated. All should be stripped before adding done:developer.
    const d = decidePostRunLabels({
      postLabels: ["done:po", "done:architect", "size:m"],
      agentName: "developer",
      agentColumn: "In Development",
      currentColumn: "In Development",
    });
    assert.equal(d.addReadyLabel, true);
    assert.deepEqual(d.priorReadyLabelsToStrip, ["done:po", "done:architect"]);
  });

  test("happy path: never strips this agent's own done:<self> from the list", () => {
    // Defense-in-depth: runPreDispatchPrep strips `done:<self>` before
    // dispatch via isPipelineLabelForAgent, so this case shouldn't arise
    // organically. But if it does (re-dispatch race, manual edit), don't
    // emit a redundant remove → re-add round-trip.
    const d = decidePostRunLabels({
      postLabels: ["done:po", "done:architect"],
      agentName: "architect",
      agentColumn: "In Architecture",
      currentColumn: "In Architecture",
    });
    assert.equal(d.addReadyLabel, true);
    assert.deepEqual(d.priorReadyLabelsToStrip, ["done:po"]);
  });

  test("rework path → priorReadyLabelsToStrip is empty (runReworkRouting handles strip)", () => {
    // `runReworkRouting` strips ALL done:/wip:/error: labels when a
    // needs-rework:<target> is added. Stripping here would duplicate
    // that work; the rework path is the existing strip surface.
    const d = decidePostRunLabels({
      postLabels: ["done:po", "needs-rework:po"],
      agentName: "architect",
      agentColumn: "In Architecture",
      currentColumn: "In Architecture",
    });
    assert.equal(d.addReadyLabel, false);
    assert.equal(d.logKind, "rework");
    assert.deepEqual(d.priorReadyLabelsToStrip, []);
  });

  test("moved-out path → priorReadyLabelsToStrip is empty (no ready add to bookend)", () => {
    // PO demoting Backlog → Inbox: addReadyLabel=false, so there's
    // nothing to bookend with a strip. Pre-existing behavior preserved.
    const d = decidePostRunLabels({
      postLabels: ["done:po"],
      agentName: "po",
      agentColumn: "Backlog",
      currentColumn: "Inbox",
    });
    assert.equal(d.addReadyLabel, false);
    assert.equal(d.logKind, "moved-out");
    assert.deepEqual(d.priorReadyLabelsToStrip, []);
  });

  test("status-unknown path → priorReadyLabelsToStrip is empty (cautious)", () => {
    // Same caution as addReadyLabel=false: skip strips when we can't
    // confirm the post-run column. Next cycle re-runs the decision
    // with fresh state.
    const d = decidePostRunLabels({
      postLabels: ["done:po"],
      agentName: "architect",
      agentColumn: "In Architecture",
      currentColumn: null,
    });
    assert.equal(d.addReadyLabel, false);
    assert.equal(d.logKind, "status-unknown");
    assert.deepEqual(d.priorReadyLabelsToStrip, []);
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

describe("describeHeldWorktrees", () => {
  // pyrycode-mobile #1430, 2026-10-02: the stale-worktree cleanup now runs
  // before the branch update. A dirty worktree still stays (no --force), and
  // the error comment has to say which one and why.

  test("nothing held → empty, the comment is unchanged", () => {
    assert.equal(describeHeldWorktrees("feature/1430", []), "");
  });

  test("a dirty worktree → named, with its uncommitted changes", () => {
    const text = describeHeldWorktrees("feature/1430", [{
      path: "/w/.pyrycode-worktrees/pyrycode-mobile/documentation-1430",
      error: "fatal: '/w/.pyrycode-worktrees/pyrycode-mobile/documentation-1430' contains modified or untracked files, use --force to delete it",
    }]);
    assert.match(text, /`feature\/1430` is still checked out/);
    assert.match(text, /- `\/w\/\.pyrycode-worktrees\/pyrycode-mobile\/documentation-1430` has uncommitted changes/);
    assert.match(text, /never force-removes/);
  });

  test("refused for another reason → git's first line quoted, not called uncommitted changes", () => {
    const text = describeHeldWorktrees("feature/7", [{
      path: "/w/locked-7",
      error: "fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first",
    }]);
    assert.match(text, /- `\/w\/locked-7` could not be removed: fatal: cannot remove a locked working tree;$/m);
    assert.doesNotMatch(text, /uncommitted/);
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
  // After a successful agent run, the dispatcher adds `done:<agent>`
  // so the auto-advance step moves the ticket to the next column. But
  // some agents legitimately move the ticket OUT of their dispatch
  // column during a successful run — PO can demote a Backlog ticket
  // back to Inbox when it lacks information for refinement (per
  // PO's CLAUDE.md), and PO moves a parent ticket to Done after a
  // split. In those cases, adding `done:po` would attach a "ready
  // for the next stage" signal to a ticket the agent explicitly
  // moved off the pipeline, creating a stale label that misleads
  // anyone scanning the board.
  //
  // Pyrycode #57 (2026-05-02): PO demoted to Inbox per its CLAUDE.md
  // ("defer until Phase 1.1's pyry attach <id> lands"). Dispatcher
  // still added `done:po` because its existing check only gated on
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
    // itself (none currently do, but defensive). Adding done:<agent>
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

  test("qa does not produce commits (runs gates, emits labels + PR comments)", () => {
    // QA uses a worktree (checks out feature branch to run go test) but never
    // writes — its output is PR comments + labels (done:qa / needs-rework:developer).
    // A 0-ahead branch after qa is the normal case, not a failure signal.
    const qa = AGENTS.find(a => a.name === "qa")!;
    assert.equal(shouldProduceCommits(qa), false);
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
  // is still 0 ahead of main after the run AND the agent didn't
  // legitimately bail via needs-rework. Belt-and-suspenders against
  // agents that exit cleanly without doing the work (relay #5: architect
  // refused without spec, developer refused without spec, code-review
  // FAILed silently because needs-rework labels didn't exist — board
  // marched to Done with feature/5 unchanged from main).

  test("PO + 0 commits → false (PO doesn't commit, expected)", () => {
    const po = AGENTS.find(a => a.name === "po")!;
    assert.equal(shouldFlagEmptyBranch(po, 0, []), false);
  });

  test("code-review + 0 commits → false (code-review doesn't commit, expected)", () => {
    const cr = AGENTS.find(a => a.name === "code-review")!;
    assert.equal(shouldFlagEmptyBranch(cr, 0, []), false);
  });

  test("architect + 0 commits → true (silent failure)", () => {
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldFlagEmptyBranch(arch, 0, []), true);
  });

  test("architect + 1+ commits → false (did the work)", () => {
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldFlagEmptyBranch(arch, 1, []), false);
    assert.equal(shouldFlagEmptyBranch(arch, 17, []), false);
  });

  test("developer + 0 commits → true (silent failure)", () => {
    const dev = AGENTS.find(a => a.name === "developer")!;
    assert.equal(shouldFlagEmptyBranch(dev, 0, []), true);
  });

  test("documentation + 0 commits → true (silent failure)", () => {
    const docs = AGENTS.find(a => a.name === "documentation")!;
    assert.equal(shouldFlagEmptyBranch(docs, 0, []), true);
  });

  test("negative commits-ahead (parse failed) → false (don't act on garbage)", () => {
    // -1 from `parseCommitsAhead` means "git output unparseable" — caller
    // skips the flag rather than acting on a value it doesn't trust.
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldFlagEmptyBranch(arch, -1, []), false);
  });

  test("architect + 0 commits + needs-rework:po → false (legitimate bail)", () => {
    // Surfaced on relay#26 (2026-05-10): architect ran file-overlap
    // check, found `feature/25` and `feature/7` overlap with the spec
    // it would have written, applied `needs-rework:po`, exited success
    // without writing a spec. Empty branch is the EXPECTED outcome of
    // that documented bail path — flagging it as `error:architect` is
    // a false positive that blocks downstream rework routing.
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldFlagEmptyBranch(arch, 0, ["needs-rework:po"]), false);
  });

  test("developer + 0 commits + needs-rework:architect → false (legitimate bail)", () => {
    // Same shape for developer bailing via needs-rework when the spec
    // doesn't match reality (e.g., a path it expects doesn't exist).
    const dev = AGENTS.find(a => a.name === "developer")!;
    assert.equal(shouldFlagEmptyBranch(dev, 0, ["needs-rework:architect"]), false);
  });

  test("architect + 0 commits + done:po (no needs-rework) → true (still silent failure)", () => {
    // Sanity: the bail-suppression specifically requires a
    // `needs-rework:*` label, not just any non-error label. An agent
    // that exits with stale `done:po` and no needs-rework still
    // triggers the guard.
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldFlagEmptyBranch(arch, 0, ["done:po", "size:s"]), true);
  });

  test("architect + 0 commits + needs-rework:architect (self-route) → false (still a bail)", () => {
    // Even self-routed needs-rework is a deliberate bail — the agent
    // is signaling "I made progress that needs review-and-redo" rather
    // than silently producing nothing. Same suppression applies.
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldFlagEmptyBranch(arch, 0, ["needs-rework:architect"]), false);
  });

  test("architect + 0 commits + needs-human:sizing → TRUE (a stop is now a deviation)", () => {
    // The mirror of the dispatch-block test above, and it flips for the
    // same reason. `needs-human:sizing` was briefly exempted here, when
    // hitting the split-depth gate meant stopping without a spec and an
    // empty branch was the expected outcome.
    //
    // Under the prompts shipped with this commit the agent no longer
    // stops. It records the split it would have made, applies the label
    // as a marker, and writes the spec. So an empty branch carrying this
    // label means the agent stopped when its prompt told it to continue,
    // and that is exactly what the guard exists to catch. Exempting it
    // would hand the developer a ticket with no spec under a
    // `done:architect` label.
    //
    // Contrast `needs-rework:*` below, which stays exempt: that one
    // still means "handed to another agent", and `runReworkRouting`
    // moves the ticket rather than advancing it.
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(shouldFlagEmptyBranch(arch, 0, ["needs-human:sizing"]), true);
  });

  test("architect + 0 commits + needs-human:sizing alongside done:po → true", () => {
    // #1938's actual post-run label set. No label in it suppresses the
    // guard, and none should: the run produced no spec.
    const arch = AGENTS.find(a => a.name === "architect")!;
    assert.equal(
      shouldFlagEmptyBranch(arch, 0, ["enhancement", "size:s", "done:po", "needs-human:sizing"]),
      true,
    );
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
      ["done:architect"],
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
    // done:developer in Architecture column — wrong stage.
    const rule = findAdvanceRule(
      AUTO_ADVANCE_RULES,
      "In Architecture",
      ["done:developer"],
    );
    assert.equal(rule, null);
  });

  test("returns null for an unknown column", () => {
    const rule = findAdvanceRule(
      AUTO_ADVANCE_RULES,
      "Some Bogus Column",
      ["done:po"],
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

// =====================================================================
// retrySpawnOnTransientError + isRetryableSpawnError
// =====================================================================
//
// Covers the EAGAIN/ENOMEM retry helper added for #9 (2026-05-15 22:51Z
// EAGAIN cascade — five PO spawns failed in 17s). Pure logic; the helper
// takes injected `sleep` so we can run zero-wait retries without timing
// flakiness in CI.

describe("isRetryableSpawnError", () => {
  test("EAGAIN → true", () => {
    assert.equal(isRetryableSpawnError(Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" })), true);
  });

  test("ENOMEM → true", () => {
    assert.equal(isRetryableSpawnError(Object.assign(new Error("oom"), { code: "ENOMEM" })), true);
  });

  test("ENOENT → false (binary missing is not transient)", () => {
    assert.equal(isRetryableSpawnError(Object.assign(new Error("nope"), { code: "ENOENT" })), false);
  });

  test("EMFILE → false (fd exhaustion not yet observed; conservative until evidence)", () => {
    assert.equal(isRetryableSpawnError(Object.assign(new Error("fd"), { code: "EMFILE" })), false);
  });

  test("plain Error without .code → false", () => {
    assert.equal(isRetryableSpawnError(new Error("just a string")), false);
  });

  test("null / undefined / non-object → false", () => {
    assert.equal(isRetryableSpawnError(null), false);
    assert.equal(isRetryableSpawnError(undefined), false);
    assert.equal(isRetryableSpawnError("EAGAIN"), false);
    assert.equal(isRetryableSpawnError(42), false);
  });
});

describe("retrySpawnOnTransientError", () => {
  /** Build a spawn-style errno error matching what Node throws on
   *  `child.on("error", ...)` for posix_spawn failures. */
  const errno = (code: string) =>
    Object.assign(new Error(`spawn ${code}`), { code }) as NodeJS.ErrnoException;

  /** Zero-wait sleep so tests are deterministic; record delays so we
   *  can assert the backoff schedule. */
  const recordingSleep = () => {
    const delays: number[] = [];
    return {
      delays,
      sleep: async (ms: number) => { delays.push(ms); },
    };
  };

  test("first attempt succeeds → no retry, no logger output", async () => {
    let attempts = 0;
    const logs: string[] = [];
    const result = await retrySpawnOnTransientError(
      async () => { attempts++; return "ok"; },
      { sleep: async () => {}, logger: (m) => logs.push(m) },
    );
    assert.equal(result, "ok");
    assert.equal(attempts, 1);
    assert.deepEqual(logs, []);
  });

  test("EAGAIN twice then success → 3 attempts, 2 logged retries, default backoff schedule", async () => {
    let attempts = 0;
    const logs: string[] = [];
    const { delays, sleep } = recordingSleep();
    const result = await retrySpawnOnTransientError(
      async () => {
        attempts++;
        if (attempts < 3) throw errno("EAGAIN");
        return "ok";
      },
      { sleep, logger: (m) => logs.push(m) },
    );
    assert.equal(result, "ok");
    assert.equal(attempts, 3);
    // Two retries → two logger calls, two sleeps.
    assert.equal(logs.length, 2);
    assert.match(logs[0]!, /EAGAIN.*attempt 1\/5.*1000ms/);
    assert.match(logs[1]!, /EAGAIN.*attempt 2\/5.*2000ms/);
    assert.deepEqual(delays, [1000, 2000]);
  });

  test("ENOMEM is also retryable (not just EAGAIN)", async () => {
    let attempts = 0;
    const result = await retrySpawnOnTransientError(
      async () => {
        attempts++;
        if (attempts === 1) throw errno("ENOMEM");
        return "ok";
      },
      { sleep: async () => {}, logger: () => {} },
    );
    assert.equal(result, "ok");
    assert.equal(attempts, 2);
  });

  test("non-retryable error propagates immediately, no retries", async () => {
    let attempts = 0;
    await assert.rejects(
      retrySpawnOnTransientError(
        async () => { attempts++; throw errno("ENOENT"); },
        { sleep: async () => {}, logger: () => {} },
      ),
      (err: Error) => err.message === "spawn ENOENT" && (err as any).code === "ENOENT",
    );
    assert.equal(attempts, 1, "ENOENT must not retry — it's not transient");
  });

  test("EAGAIN exhausted across all 5 attempts → ResourceExhaustedError with errno + count", async () => {
    let attempts = 0;
    const { delays, sleep } = recordingSleep();
    const logs: string[] = [];
    await assert.rejects(
      retrySpawnOnTransientError(
        async () => { attempts++; throw errno("EAGAIN"); },
        { sleep, logger: (m) => logs.push(m) },
      ),
      (err: Error) => {
        if (!(err instanceof ResourceExhaustedError)) return false;
        assert.equal(err.errno, "EAGAIN");
        assert.equal(err.attempts, MAX_SPAWN_ATTEMPTS);
        assert.match(err.message, /5 retries/);
        assert.match(err.message, /EAGAIN/);
        return true;
      },
    );
    assert.equal(attempts, MAX_SPAWN_ATTEMPTS, "must spawn exactly 5 times");
    // 4 sleeps between 5 attempts; no terminal sleep before throwing.
    assert.deepEqual(delays, [...SPAWN_RETRY_DELAYS_MS]);
    assert.equal(logs.length, 4, "one log per retry, not after final failure");
  });

  test("mid-sequence non-retryable error short-circuits (no retry, no ResourceExhaustedError)", async () => {
    let attempts = 0;
    await assert.rejects(
      retrySpawnOnTransientError(
        async () => {
          attempts++;
          // EAGAIN, then EAGAIN, then a real spawn error → bail.
          if (attempts < 3) throw errno("EAGAIN");
          throw errno("ENOENT");
        },
        { sleep: async () => {}, logger: () => {} },
      ),
      (err: Error) => err.message === "spawn ENOENT" && !(err instanceof ResourceExhaustedError),
    );
    assert.equal(attempts, 3);
  });

  test("delaysMs override applies (test isolation against schedule changes)", async () => {
    let attempts = 0;
    const { delays, sleep } = recordingSleep();
    await assert.rejects(
      retrySpawnOnTransientError(
        async () => { attempts++; throw errno("EAGAIN"); },
        { sleep, logger: () => {}, delaysMs: [10, 20], maxAttempts: 3 },
      ),
      (err: Error) => err instanceof ResourceExhaustedError,
    );
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [10, 20]);
  });
});

// =====================================================================
// detectPermissionDenial + advancePermissionDenialState (#8 Layer 2)
// =====================================================================
//
// Pure state machine for the permission-denial watchdog. Covers the
// detection predicate (conjunction across type/is_error/substring) and
// the watchdog grace window — one turn-boundary after detection to let
// Layer 1's CLAUDE.md rule fire, force-exit on workaround attempt.

describe("detectPermissionDenial", () => {
  /** Real shape from pyrycode/pyrycode#398 JSONL trace. */
  const denialMsg = {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        is_error: true,
        content: "Permission to use Bash with command `git reset --hard HEAD~1` has been denied.",
        tool_use_id: "toolu_01ABCD",
      }],
    },
  };

  test("real #398 denial fixture → match, returns full content string", () => {
    const got = detectPermissionDenial(denialMsg);
    assert.ok(got !== null);
    assert.match(got!.content, /git reset --hard/);
    assert.match(got!.content, /has been denied/);
  });

  test("denial with different command → still matches (substring conjunction is the rule, not the command)", () => {
    const msg = {
      type: "user",
      message: { role: "user", content: [{
        type: "tool_result", is_error: true,
        content: "Permission to use Bash with command `rm -rf /` has been denied.",
      }]},
    };
    assert.ok(detectPermissionDenial(msg) !== null);
  });

  test("user message but no tool_result block → no match", () => {
    const msg = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Permission to use foo has been denied." }] },
    };
    assert.equal(detectPermissionDenial(msg), null);
  });

  test("tool_result but is_error=false → no match (success path)", () => {
    const msg = {
      type: "user",
      message: { role: "user", content: [{
        type: "tool_result", is_error: false,
        content: "Permission to use Bash with command `ls` has been denied.",
      }]},
    };
    assert.equal(detectPermissionDenial(msg), null);
  });

  test("tool_result with is_error=true but no denial substring → no match (generic Bash failure)", () => {
    const msg = {
      type: "user",
      message: { role: "user", content: [{
        type: "tool_result", is_error: true,
        content: "fatal: not a git repository",
      }]},
    };
    assert.equal(detectPermissionDenial(msg), null);
  });

  test("only one of the two substrings present → no match (conjunction is load-bearing)", () => {
    const msg1 = {
      type: "user",
      message: { role: "user", content: [{
        type: "tool_result", is_error: true,
        content: "Permission to use Bash was revoked.",
      }]},
    };
    assert.equal(detectPermissionDenial(msg1), null);
    const msg2 = {
      type: "user",
      message: { role: "user", content: [{
        type: "tool_result", is_error: true,
        content: "Operation has been denied by the operator.",
      }]},
    };
    assert.equal(detectPermissionDenial(msg2), null);
  });

  test("type=assistant → no match (denials are user-role tool_results)", () => {
    const msg = {
      type: "assistant",
      message: { content: [{
        type: "tool_result", is_error: true,
        content: "Permission to use Bash has been denied.",
      }]},
    };
    assert.equal(detectPermissionDenial(msg), null);
  });

  test("malformed / null / non-object inputs → no match (defensive)", () => {
    assert.equal(detectPermissionDenial(null), null);
    assert.equal(detectPermissionDenial(undefined), null);
    assert.equal(detectPermissionDenial("user"), null);
    assert.equal(detectPermissionDenial({ type: "user" }), null); // no message
    assert.equal(detectPermissionDenial({ type: "user", message: { content: "not-an-array" } }), null);
    assert.equal(detectPermissionDenial({ type: "user", message: { content: [null, undefined, "string"] } }), null);
  });
});

describe("advancePermissionDenialState — watchdog state machine", () => {
  const denialMsg = {
    type: "user",
    message: { role: "user", content: [{
      type: "tool_result", is_error: true,
      content: "Permission to use Bash with command `git reset --hard HEAD~1` has been denied.",
    }]},
  };
  const toolUseMsg = (name = "Bash") => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input: { command: "echo hi" } }] },
  });
  const textMsg = (text: string) => ({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  const mixedMsg = (text: string, toolName = "Bash") => ({
    type: "assistant",
    message: { content: [{ type: "text", text }, { type: "tool_use", name: toolName, input: {} }] },
  });

  test("initial state — no denial, no watchdog, no text", () => {
    const s = initPermissionDenialState();
    assert.deepEqual(s, {
      hadPermissionDenial: false,
      watchdogPending: false,
      stoppedAtDenial: false,
      deniedContent: null,
      lastAssistantText: null,
    });
  });

  test("denial event → hadPermissionDenial+watchdogPending set, action=logDenial", () => {
    const { state, action } = advancePermissionDenialState(initPermissionDenialState(), denialMsg);
    assert.equal(state.hadPermissionDenial, true);
    assert.equal(state.watchdogPending, true);
    assert.match(state.deniedContent!, /git reset --hard/);
    assert.equal(action, "logDenial");
  });

  test("first denial wins — second denial does NOT overwrite deniedContent", () => {
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, denialMsg));
    const secondDenial = {
      type: "user",
      message: { role: "user", content: [{
        type: "tool_result", is_error: true,
        content: "Permission to use Bash with command `git push --force` has been denied.",
      }]},
    };
    ({ state: s } = advancePermissionDenialState(s, secondDenial));
    assert.match(s.deniedContent!, /git reset --hard/);
    assert.doesNotMatch(s.deniedContent!, /git push --force/);
  });

  test("tool_use BEFORE any denial → no action (normal stream); lastAssistantText unchanged from pure tool_use msg", () => {
    const s0 = initPermissionDenialState();
    const { state, action } = advancePermissionDenialState(s0, toolUseMsg("Bash"));
    assert.equal(action, "none");
    assert.equal(state.watchdogPending, false);
    assert.equal(state.lastAssistantText, null); // tool_use without text doesn't update lastAssistantText
  });

  test("assistant text BEFORE denial → captured into lastAssistantText, no action", () => {
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, textMsg("I'm going to undo the revert commit.")));
    assert.equal(s.lastAssistantText, "I'm going to undo the revert commit.");
    assert.equal(s.watchdogPending, false);
  });

  test("denial then tool_use → action=forceExit, watchdog clears, hadPermissionDenial stays true", () => {
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, denialMsg));
    assert.equal(s.watchdogPending, true);
    const advanced = advancePermissionDenialState(s, toolUseMsg("Bash"));
    assert.equal(advanced.action, "forceExit");
    assert.equal(advanced.state.watchdogPending, false);
    assert.equal(advanced.state.hadPermissionDenial, true, "denial flag persists past watchdog clear");
  });

  test("denial then text-only assistant → action=none (Layer 1 worked), watchdog clears, hadPermissionDenial stays true", () => {
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, denialMsg));
    const advanced = advancePermissionDenialState(s, textMsg(
      "The dispatcher denied `git reset --hard HEAD~1`. I was trying to undo the revert commit. Stopping here per the absolute rule."
    ));
    assert.equal(advanced.action, "none", "clean text exit must NOT force-exit");
    assert.equal(advanced.state.watchdogPending, false);
    assert.equal(advanced.state.hadPermissionDenial, true);
    assert.match(advanced.state.lastAssistantText!, /Stopping here/);
  });

  test("denial then mixed (text + tool_use) → action=forceExit (tool_use wins even with accompanying text)", () => {
    // Defensive: an agent that emits "I'll work around this" + a Bash
    // call in the same turn is still a workaround attempt.
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, denialMsg));
    const advanced = advancePermissionDenialState(s, mixedMsg("Let me try git revert instead", "Bash"));
    assert.equal(advanced.action, "forceExit");
    assert.equal(advanced.state.lastAssistantText, "Let me try git revert instead");
  });

  test("denial then unrelated message (non-assistant) → watchdog stays pending; assistant-text-or-tool-use is the only trigger", () => {
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, denialMsg));
    const sysMsg = { type: "system", session_id: "sess-001" };
    const advanced = advancePermissionDenialState(s, sysMsg);
    assert.equal(advanced.action, "none");
    assert.equal(advanced.state.watchdogPending, true, "watchdog must NOT clear on non-assistant events");
  });

  // stoppedAtDenial: did the run end on a denial, or carry on past it?
  // A clean exit only routes as permission_denied when it stopped there
  // (pyrycode#2586: the verifier obeyed Layer 1, exited cleanly, and the
  // ticket got the generic missing-verdict error instead).
  test("denial → stoppedAtDenial set", () => {
    const { state } = advancePermissionDenialState(initPermissionDenialState(), denialMsg);
    assert.equal(state.stoppedAtDenial, true);
  });

  test("denial then text-only exit → stoppedAtDenial stays true", () => {
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, denialMsg));
    ({ state: s } = advancePermissionDenialState(s, textMsg("Denied, so I am stopping.")));
    assert.equal(s.stoppedAtDenial, true);
  });

  test("denial, text, then a later tool_use → stoppedAtDenial clears (agent carried on)", () => {
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, denialMsg));
    ({ state: s } = advancePermissionDenialState(s, textMsg("That was denied; reading the file instead.")));
    ({ state: s } = advancePermissionDenialState(s, toolUseMsg("Read")));
    assert.equal(s.stoppedAtDenial, false);
    assert.equal(s.hadPermissionDenial, true, "the history flag still records the denial");
  });

  test("recovered, then denied again and stopped → stoppedAtDenial set again", () => {
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, denialMsg));
    ({ state: s } = advancePermissionDenialState(s, textMsg("Trying another way.")));
    ({ state: s } = advancePermissionDenialState(s, toolUseMsg("Read")));
    ({ state: s } = advancePermissionDenialState(s, denialMsg));
    ({ state: s } = advancePermissionDenialState(s, textMsg("Denied again, stopping.")));
    assert.equal(s.stoppedAtDenial, true);
  });

  test("empty / whitespace text doesn't overwrite lastAssistantText (preserves real intent)", () => {
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, textMsg("Real intent.")));
    ({ state: s } = advancePermissionDenialState(s, textMsg("   ")));
    assert.equal(s.lastAssistantText, "Real intent.");
  });

  test("full sequence: text → denial → workaround tool_use → forceExit; state captures intent + denied op", () => {
    let s = initPermissionDenialState();
    ({ state: s } = advancePermissionDenialState(s, textMsg("Cleaning up the revert commit.")));
    ({ state: s } = advancePermissionDenialState(s, denialMsg));
    const advanced = advancePermissionDenialState(s, toolUseMsg("Bash"));
    assert.equal(advanced.action, "forceExit");
    assert.equal(advanced.state.hadPermissionDenial, true);
    assert.match(advanced.state.deniedContent!, /git reset --hard/);
    assert.equal(advanced.state.lastAssistantText, "Cleaning up the revert commit.");
  });
});


// ==========================================================================
// Dispatcher-executed real-claude gate
//
// The whole point of this surface is that a suite which verified NOTHING
// must never read as green. Every test below is ultimately about that one
// property, approached from a different angle.
// ==========================================================================

describe("parseGateOutput — go-json", () => {
  test("counts a normal mix of pass, fail and skip", () => {
    const raw = [
      '{"Action":"run","Package":"p","Test":"TestA"}',
      '{"Action":"pass","Package":"p","Test":"TestA"}',
      '{"Action":"run","Package":"p","Test":"TestB"}',
      '{"Action":"fail","Package":"p","Test":"TestB"}',
      '{"Action":"output","Package":"p","Test":"TestC","Output":"    fixtures.go:96: no login token\\n"}',
      '{"Action":"skip","Package":"p","Test":"TestC"}',
      '{"Action":"fail","Package":"p"}',
    ].join("\n");

    const t = parseGateOutput(raw, "go-json");

    assert.equal(t.executed, 2, "executed is pass + fail; a skip executed nothing");
    assert.equal(t.passed, 1);
    assert.equal(t.failed, 1);
    assert.equal(t.skipped, 1);
    assert.deepEqual(t.failedNames, ["p.TestB"]);
    assert.deepEqual(t.passedNames, ["p.TestA"]);
    assert.equal(t.packageFailed, true);
    assert.match(t.skipReasons[0], /no login token/);
  });

  test("a go test timeout panic names the hung tests as failures", () => {
    // pyrycode #2089, 2026-09-06 12:06: 939 passed, 0 failed, and the binary
    // died on its own 20-minute deadline with one offline test still
    // running. With no name to attribute, the run read as a suite-level
    // failure, skipped the base comparison, and routed straight to rework.
    // The panic had named the test in full.
    const raw = [
      '{"Action":"run","Package":"p","Test":"TestOk"}',
      '{"Action":"pass","Package":"p","Test":"TestOk"}',
      '{"Action":"run","Package":"p","Test":"TestHold"}',
      '{"Action":"run","Package":"p","Test":"TestHold/release_returns"}',
      '{"Action":"output","Package":"p","Test":"TestHold/release_returns","Output":"panic: test timed out after 20m0s\\n"}',
      '{"Action":"output","Package":"p","Test":"TestHold/release_returns","Output":"\\trunning tests:\\n"}',
      '{"Action":"output","Package":"p","Test":"TestHold/release_returns","Output":"\\t\\tTestHold (3m0s)\\n"}',
      '{"Action":"output","Package":"p","Test":"TestHold/release_returns","Output":"\\t\\tTestHold/release_returns (2m59s)\\n"}',
      '{"Action":"output","Package":"p","Test":"TestHold/release_returns","Output":"\\n"}',
      '{"Action":"output","Package":"p","Test":"TestHold/release_returns","Output":"goroutine 2026 [running]:\\n"}',
      '{"Action":"fail","Package":"p"}',
    ].join("\n");

    const t = parseGateOutput(raw, "go-json");

    assert.deepEqual(t.failedNames, ["p.TestHold/release_returns"], "the hung leaf, not its parent");
    assert.deepEqual(t.timedOutTests, ["p.TestHold/release_returns"]);
    assert.equal(t.timedOutBudget, "20m0s");
    assert.deepEqual(t.timedOutRunningFor, { "p.TestHold/release_returns": "2m59s" });
    assert.equal(t.failed, 1);
    assert.equal(t.executed, 2, "the hung test ran a body; it counts as executed");
    assert.deepEqual(t.passedNames, ["p.TestOk"]);
  });

  test("a parent whose subtests ALL skipped counts zero executed", () => {
    // Go reports the parent as `pass` — its body ran, the subtests declined.
    // Counting that parent would let a suite verifying nothing clear a floor
    // of 1, which reopens the exact false-green hole one level up.
    const raw = [
      '{"Action":"run","Package":"p","Test":"TestParent"}',
      '{"Action":"run","Package":"p","Test":"TestParent/case_one"}',
      '{"Action":"skip","Package":"p","Test":"TestParent/case_one"}',
      '{"Action":"run","Package":"p","Test":"TestParent/case_two"}',
      '{"Action":"skip","Package":"p","Test":"TestParent/case_two"}',
      '{"Action":"pass","Package":"p","Test":"TestParent"}',
      '{"Action":"pass","Package":"p"}',
    ].join("\n");

    const t = parseGateOutput(raw, "go-json");

    assert.equal(t.executed, 0, "the parent verified nothing; only leaves count");
    assert.equal(t.passed, 0);
    assert.equal(t.skipped, 2);
  });

  test("a parent with passing subtests counts the subtests, not the parent", () => {
    const raw = [
      '{"Action":"pass","Package":"p","Test":"TestParent/one"}',
      '{"Action":"pass","Package":"p","Test":"TestParent/two"}',
      '{"Action":"pass","Package":"p","Test":"TestParent"}',
    ].join("\n");

    const t = parseGateOutput(raw, "go-json");

    assert.equal(t.executed, 2, "two leaves, one parent — the parent is not a third test");
  });

  test("the same test name in two packages does not mask a leaf", () => {
    // Scoping parent detection by package matters: `p2.TestX` is a genuine
    // leaf even though `p1.TestX` has a subtest.
    const raw = [
      '{"Action":"pass","Package":"p1","Test":"TestX/sub"}',
      '{"Action":"pass","Package":"p1","Test":"TestX"}',
      '{"Action":"pass","Package":"p2","Test":"TestX"}',
    ].join("\n");

    const t = parseGateOutput(raw, "go-json");

    assert.equal(t.executed, 2, "p1.TestX/sub and p2.TestX; p1.TestX is a parent");
  });

  test("ignores interleaved non-JSON instead of treating it as fatal", () => {
    // Build errors and panic traces land in the same stream. Refusing to
    // parse would turn a readable failure into an unusable park, hiding the
    // failure from the developer agent that should be fixing it.
    const raw = [
      "# github.com/pyrycode/pyrycode/internal/e2e",
      "panic: something went very wrong",
      '{"Action":"fail","Package":"p","Test":"TestA"}',
      "goroutine 1 [running]:",
      '{"Action":"fail","Package":"p"}',
      "",
    ].join("\n");

    const t = parseGateOutput(raw, "go-json");

    assert.equal(t.recognizedLines, 2);
    assert.equal(t.failed, 1);
    assert.equal(t.packageFailed, true);
  });

  test("an empty artifact yields zero recognized lines, not an empty pass", () => {
    const t = parseGateOutput("", "go-json");
    assert.equal(t.recognizedLines, 0);
    assert.equal(t.executed, 0);
  });

  test("a build failure has a package failure and no failing test", () => {
    // The combination `packageFailed && failed === 0` is the only shape that
    // says "something broke and there is no test to blame".
    const raw = [
      '{"Action":"output","Package":"p","Output":"undefined: Foo\\n"}',
      '{"Action":"fail","Package":"p"}',
    ].join("\n");

    const t = parseGateOutput(raw, "go-json");

    assert.equal(t.failed, 0);
    assert.equal(t.packageFailed, true);
    assert.deepEqual(t.packageFailures, ["p"]);
  });

  test("a duplicated terminal event does not double-count", () => {
    const raw = [
      '{"Action":"pass","Package":"p","Test":"TestA"}',
      '{"Action":"pass","Package":"p","Test":"TestA"}',
    ].join("\n");

    assert.equal(parseGateOutput(raw, "go-json").executed, 1);
  });
});

describe("parseGateOutput — playwright-json", () => {
  test("reads statuses out of a nested suite tree", () => {
    const doc = JSON.stringify({
      errors: [],
      suites: [{
        title: "gate.spec.ts",
        specs: [
          { title: "passes", tests: [{ status: "expected" }] },
          { title: "breaks", tests: [{ status: "unexpected" }] },
          { title: "declines", tests: [{ status: "skipped", annotations: [{ type: "skip", description: "no token" }] }] },
        ],
        suites: [{
          title: "nested",
          specs: [{ title: "deep", tests: [{ status: "flaky" }] }],
        }],
      }],
    });

    const t = parseGateOutput(doc, "playwright-json");

    assert.equal(t.executed, 3, "expected + unexpected + flaky; skipped executed nothing");
    assert.equal(t.passed, 2, "a flake did run and did end green");
    assert.equal(t.failed, 1);
    assert.equal(t.skipped, 1);
    assert.match(t.skipReasons[0], /no token/);
    assert.match(t.failedNames[0], /breaks/);
  });

  test("a global error is a suite-level failure with no failing test", () => {
    const doc = JSON.stringify({ errors: [{ message: "global setup threw" }], suites: [] });
    const t = parseGateOutput(doc, "playwright-json");
    assert.equal(t.packageFailed, true);
    assert.equal(t.failed, 0);
  });

  test("strips a non-JSON preamble before the report", () => {
    const doc = "Running 3 tests using 1 worker\n" + JSON.stringify({ errors: [], suites: [] });
    assert.equal(parseGateOutput(doc, "playwright-json").recognizedLines, 1);
  });

  test("unparseable input yields zero recognized lines rather than throwing", () => {
    assert.equal(parseGateOutput("not json at all", "playwright-json").recognizedLines, 0);
    assert.equal(parseGateOutput("{ oops", "playwright-json").recognizedLines, 0);
  });
});

describe("decideGateVerdict", () => {
  const clean = {
    executed: 176, failed: 0, packageFailed: false, recognizedLines: 400,
  };
  const base = { runError: null, timedOut: false, tally: clean, exitCode: 0, minExecuted: 150 };

  test("passes only when the artifact itself says so", () => {
    assert.equal(decideGateVerdict(base).verdict, "pass");
  });

  test("an all-skip run with exit 0 is zero-executed, never pass", () => {
    // The 2026-07-22 failure, reduced to its essence.
    const d = decideGateVerdict({
      ...base,
      tally: { executed: 0, failed: 0, packageFailed: false, recognizedLines: 400 },
    });
    assert.equal(d.verdict, "zero-executed");
    assert.match(d.reason, /below the floor/);
  });

  test("exit 0 with no artifact is unusable, never pass", () => {
    assert.equal(decideGateVerdict({ ...base, tally: null }).verdict, "unusable");
  });

  test("exit 0 with an artifact holding no events is unusable", () => {
    assert.equal(
      decideGateVerdict({ ...base, tally: { ...clean, recognizedLines: 0 } }).verdict,
      "unusable",
    );
  });

  test("a run error beats everything, including a clean-looking artifact", () => {
    assert.equal(decideGateVerdict({ ...base, runError: "worktree missing" }).verdict, "unusable");
  });

  test("a timeout is unusable even when nothing had failed yet", () => {
    // The artifact is a prefix of the truth, not the truth. A prefix with no
    // failures in it is not a pass.
    assert.equal(decideGateVerdict({ ...base, timedOut: true }).verdict, "unusable");
  });

  test("the test binary's own deadline is a budget exhaustion, not a failure of whoever was running", () => {
    // pyrycode #2279, 2026-09-09: the suite had grown to within seconds of
    // its 20-minute deadline, the alarm fired during a 361-second test the
    // branch never touched, and a base re-run of that test alone passed, so
    // the gate called it a regression and sent the ticket to rework. The
    // parser counts the killed test as failed; this check must outrank
    // that count and name the budget and the running time instead.
    const d = decideGateVerdict({
      ...base,
      exitCode: 1,
      tally: {
        ...clean,
        failed: 1,
        packageFailed: true,
        timedOutTests: ["p.TestRealClaude_TaskNotificationCapture"],
        timedOutBudget: "20m0s",
        timedOutRunningFor: { "p.TestRealClaude_TaskNotificationCapture": "5m50s" },
      },
    });
    assert.equal(d.verdict, "unusable");
    assert.match(d.reason, /20m0s/);
    assert.match(d.reason, /TaskNotificationCapture \(running for 5m50s\)/);
    assert.match(d.reason, /outrun its budget/);
  });

  test("a failing test outranks the executed floor", () => {
    // A run with one failure and only 3 executed is a FAIL, routed to the
    // developer — not an environment park. Ordering decides which.
    const d = decideGateVerdict({
      ...base,
      tally: { executed: 3, failed: 1, packageFailed: true, recognizedLines: 10 },
    });
    assert.equal(d.verdict, "fail");
  });

  test("a suite-level failure with no failing test is still a fail", () => {
    const d = decideGateVerdict({
      ...base,
      tally: { executed: 176, failed: 0, packageFailed: true, recognizedLines: 400 },
    });
    assert.equal(d.verdict, "fail");
    assert.match(d.reason, /build error, panic, or harness crash/);
  });

  test("a clean report contradicted by a non-zero exit is unusable, not pass", () => {
    // The belt. Report says green, process says red; neither is trustworthy,
    // and there is no failing test to hand a developer.
    const d = decideGateVerdict({ ...base, exitCode: 1 });
    assert.equal(d.verdict, "unusable");
    assert.match(d.reason, /disagree/);
  });

  test("a floor of 0 is clamped to 1 so the guard cannot be configured away", () => {
    const d = decideGateVerdict({
      ...base,
      minExecuted: 0,
      tally: { executed: 0, failed: 0, packageFailed: false, recognizedLines: 5 },
    });
    assert.equal(d.verdict, "zero-executed");
  });

  test("INVARIANT: exit code 0 alone never yields a pass", () => {
    // The named property, table-driven. This is the exact inversion of the
    // 2026-07-22 failure, where a 0 was read first and treated as sufficient.
    // Every row here holds exitCode 0 and some other defect; none may pass.
    const rows: { name: string; input: Parameters<typeof decideGateVerdict>[0] }[] = [
      { name: "run error", input: { ...base, exitCode: 0, runError: "spawn failed" } },
      { name: "timed out", input: { ...base, exitCode: 0, timedOut: true } },
      {
        name: "binary deadline fired",
        input: { ...base, exitCode: 0, tally: { ...clean, failed: 1, packageFailed: true, timedOutTests: ["p.TestX"] } },
      },
      { name: "no artifact", input: { ...base, exitCode: 0, tally: null } },
      { name: "artifact with no events", input: { ...base, exitCode: 0, tally: { ...clean, recognizedLines: 0 } } },
      { name: "one failing test", input: { ...base, exitCode: 0, tally: { ...clean, failed: 1 } } },
      { name: "package failed", input: { ...base, exitCode: 0, tally: { ...clean, packageFailed: true } } },
      { name: "nothing executed", input: { ...base, exitCode: 0, tally: { ...clean, executed: 0 } } },
      { name: "one short of the floor", input: { ...base, exitCode: 0, tally: { ...clean, executed: 149 } } },
      {
        name: "everything skipped",
        input: {
          ...base,
          exitCode: 0,
          tally: { executed: 0, failed: 0, packageFailed: false, recognizedLines: 900 },
        },
      },
    ];

    for (const row of rows) {
      const d = decideGateVerdict(row.input);
      assert.notEqual(d.verdict, "pass", `exit 0 must not rescue: ${row.name}`);
    }
  });

  test("INVARIANT: flipping the exit code to 0 never improves a verdict", () => {
    // Stronger than the row table: for each defective input, the verdict must
    // be IDENTICAL whether the process exited 0 or 1. The exit code is only
    // ever allowed to make things worse.
    const defects = [
      { runError: "boom" },
      { timedOut: true },
      { tally: null },
      { tally: { ...clean, failed: 2 } },
      { tally: { ...clean, executed: 0 } },
      { tally: { ...clean, recognizedLines: 0 } },
    ];
    for (const defect of defects) {
      const withZero = decideGateVerdict({ ...base, ...defect, exitCode: 0 });
      const withOne = decideGateVerdict({ ...base, ...defect, exitCode: 1 });
      assert.equal(
        withZero.verdict,
        withOne.verdict,
        `exit status changed the verdict for ${JSON.stringify(defect)}`,
      );
    }
  });
});

describe("decideGateOutcome", () => {
  test("pass advances and clears the gate label", () => {
    const o = decideGateOutcome("pass");
    assert.equal(o.toColumn, "In Documentation");
    assert.deepEqual(o.removeLabels, ["needs-real-claude"]);
    assert.deepEqual(o.addLabels, []);
    assert.equal(o.notify, false);
  });

  test("fail routes to the developer and KEEPS the gate label", () => {
    // Dropping it would let the fix reach Done having proved nothing.
    const o = decideGateOutcome("fail");
    assert.equal(o.toColumn, "In Development");
    assert.deepEqual(o.addLabels, ["needs-rework:developer"]);
    assert.deepEqual(o.removeLabels, [], "the ticket must re-gate after the fix");
    assert.equal(o.notify, false);
  });

  test("environment problems park with an error label and ping a human", () => {
    // Deliberately NOT routed to the developer: an agent cannot fix a missing
    // credential, and would burn all three rework spawns discovering that.
    for (const verdict of ["zero-executed", "unusable"] as const) {
      const o = decideGateOutcome(verdict);
      assert.equal(o.toColumn, null, `${verdict} must leave the ticket where it is`);
      assert.deepEqual(o.addLabels, ["error:real-claude-gate"]);
      assert.equal(o.notify, true);
    }
  });

  test("no verdict ever removes the gate label except a pass", () => {
    for (const verdict of ["fail", "zero-executed", "unusable"] as const) {
      assert.deepEqual(decideGateOutcome(verdict).removeLabels, [], verdict);
    }
  });
});

describe("decideRealClaudeGateRun", () => {
  const item = (over: Partial<{ id: string; issueNumber: number; labels: string[]; blockedBy: any[] }> = {}) => ({
    id: over.id ?? "i1",
    issueNumber: over.issueNumber ?? 1382,
    labels: over.labels ?? ["done:code-review", "needs-real-claude"],
    blockedBy: over.blockedBy ?? [],
  });

  test("picks the first eligible ticket in board order", () => {
    const picked = decideRealClaudeGateRun([
      item({ id: "a", issueNumber: 1382 }),
      item({ id: "b", issueNumber: 1381 }),
    ]);
    assert.deepEqual(picked, { itemId: "a", issueNumber: 1382 });
  });

  test("returns at most one, never a list", () => {
    // One gate per cycle: a suite is minutes of blocking wall clock and the
    // chain drains just as fast one link at a time.
    const picked = decideRealClaudeGateRun([item({ id: "a" }), item({ id: "b" }), item({ id: "c" })]);
    assert.equal(picked?.itemId, "a");
  });

  test("skips a ticket already carrying an error label", () => {
    // This is what stops a parked ticket re-running the gate forever. The
    // mechanism is self-limiting because of it.
    assert.equal(decideRealClaudeGateRun([
      item({ labels: ["done:code-review", "needs-real-claude", "error:real-claude-gate"] }),
    ]), null);
  });

  test("skips a ticket pending rework", () => {
    assert.equal(decideRealClaudeGateRun([
      item({ labels: ["done:code-review", "needs-real-claude", "needs-rework:developer"] }),
    ]), null);
  });

  test("skips a ticket marked as running", () => {
    assert.equal(decideRealClaudeGateRun([
      item({ labels: ["done:code-review", "needs-real-claude", "wip:real-claude-gate"] }),
    ]), null);
  });

  test("skips a ticket with an open blocker", () => {
    assert.equal(decideRealClaudeGateRun([
      item({ blockedBy: [{ number: 99, state: "OPEN" }] }),
    ]), null);
  });

  test("a closed blocker does not disqualify", () => {
    assert.ok(decideRealClaudeGateRun([item({ blockedBy: [{ number: 99, state: "CLOSED" }] })]));
  });

  test("requires both a finished review and the gate label", () => {
    assert.equal(decideRealClaudeGateRun([item({ labels: ["needs-real-claude"] })]), null);
    assert.equal(decideRealClaudeGateRun([item({ labels: ["done:code-review"] })]), null);
  });

  test("skips non-issue board items", () => {
    assert.equal(decideRealClaudeGateRun([item({ issueNumber: 0 })]), null);
  });

  test("passes over an ineligible ticket to reach an eligible one", () => {
    const picked = decideRealClaudeGateRun([
      item({ id: "blocked", labels: ["done:code-review", "needs-real-claude", "error:qa"] }),
      item({ id: "ready" }),
    ]);
    assert.equal(picked?.itemId, "ready");
  });
});

describe("formatGateEvidenceComment", () => {
  const baseReport = {
    runError: null,
    timedOut: false,
    exitCode: 0,
    tally: {
      executed: 176, passed: 176, failed: 0, skipped: 14,
      failedNames: [], passedNames: [], timedOutTests: [], skipReasons: ["p.TestExternal: no network"],
      packageFailed: false, packageFailures: [], recognizedLines: 400,
    },
    command: "go test -tags e2e_realclaude -json ./...",
    branchName: "feature/1382",
    baseRef: "origin/main",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    commitsBehind: 29,
    durationMs: 308_022,
    outputPath: "/logs/gate.log",
    outputBytes: 2_100_000,
    baselineFailures: null,
    baselineSkipReason: null,
    baselineOutputPath: null,
    rerunFailures: null,
    rerunSkipReason: null,
    rerunOutputPath: null,
  };

  test("names flaky tests and does not blame the branch for them", () => {
    const body = formatGateEvidenceComment({
      verdict: "flaky-pass", reason: "1 test(s) failed once and passed when re-run",
      report: {
        ...baseReport,
        tally: { ...baseReport.tally, failed: 1, failedNames: ["p.TestLive"] },
        rerunFailures: [], rerunOutputPath: "/logs/rerun.log",
      },
      minExecuted: 150, action: "moved it to In Documentation", flaky: ["p.TestLive"],
    });
    assert.match(body, /PASS, AFTER A RE-RUN/);
    assert.match(body, /passed when re-run on the same merged tree \(1\)/);
    assert.match(body, /p\.TestLive/);
    assert.doesNotMatch(body, /introduced by this branch/);
    assert.doesNotMatch(body, /No base comparison was made/);
  });

  test("lists tests the test binary's own timeout killed", () => {
    const body = formatGateEvidenceComment({
      verdict: "fail", reason: "1 test(s) failed",
      report: {
        ...baseReport,
        tally: { ...baseReport.tally, failed: 1, failedNames: ["p.TestHang"], timedOutTests: ["p.TestHang"], packageFailed: true },
      },
      minExecuted: 150, action: "moved it to In Development",
    });
    assert.match(body, /own timeout fired \(1\)/);
    assert.doesNotMatch(body, /Suite-level failure with no failing test/);
  });

  test("carries the commits-behind figure so the merged-state claim is auditable", () => {
    const body = formatGateEvidenceComment({
      verdict: "pass", reason: "176 test(s) executed, none failed",
      report: baseReport, minExecuted: 150, action: "moved it to In Documentation",
    });
    assert.match(body, /29 commit\(s\) behind/);
    assert.match(body, /origin\/main/);
    assert.match(body, /308\.0s/);
  });

  test("states the floor alongside the executed count", () => {
    const body = formatGateEvidenceComment({
      verdict: "pass", reason: "ok", report: baseReport, minExecuted: 150, action: "advanced",
    });
    assert.match(body, /floor for this fork is 150/);
  });

  test("says plainly that nothing was judged when there is no artifact", () => {
    const body = formatGateEvidenceComment({
      verdict: "unusable", reason: "no readable test events",
      report: { ...baseReport, tally: null, stderrPath: "/logs/gate.stderr.log" }, minExecuted: 150, action: "parked",
    });
    assert.match(body, /not the same as nothing failing/);
    assert.match(body, /Diagnostic log: `\/logs\/gate\.stderr\.log`/);
    assert.match(body, /Test report: `\/logs\/gate\.log`/);
  });

  test("reports an uncomputable commits-behind rather than omitting it", () => {
    const body = formatGateEvidenceComment({
      verdict: "pass", reason: "ok",
      report: { ...baseReport, commitsBehind: null }, minExecuted: 150, action: "advanced",
    });
    assert.match(body, /could not be computed/);
  });
});

describe("buildBaselineFilter", () => {
  test("builds an anchored, shell-quoted alternation from qualified names, at the top level", () => {
    // `go test -run` splits its pattern on `/` and matches each level on its
    // own, so `^(TestA|TestB/sub_case)$` becomes `^(TestA` and `sub_case)$`,
    // two broken regexps and a run that refuses to start. The parent is
    // filtered instead; results are still compared by full leaf name.
    const f = buildBaselineFilter(["pkg/path.TestA", "pkg/path.TestB/sub_case"]);
    assert.equal(f, "'^(TestA|TestB)$'");
  });

  test("two subtests of one parent collapse to that parent", () => {
    assert.equal(buildBaselineFilter(["p.TestA/x", "p.TestA/y"]), "'^(TestA)$'");
  });

  test("strips only the package qualifier, keeping subtest paths", () => {
    assert.equal(stripPackageQualifier("github.com/o/r/internal/e2e.TestA/b/c"), "TestA/b/c");
    assert.equal(stripPackageQualifier("TestBare"), "TestBare");
  });

  test("deduplicates repeated names", () => {
    assert.equal(buildBaselineFilter(["p.TestA", "p.TestA"]), "'^(TestA)$'");
  });

  test("escapes the regex metacharacters the safe set allows", () => {
    assert.equal(buildBaselineFilter(["p.TestA-x.y"]), "'^(TestA\\-x\\.y)$'");
  });

  test("finds the package boundary even when the test name carries a dot", () => {
    // Splitting on the last dot yields "y" here, a filter for a test that
    // does not exist, and the base run then finds no failures and
    // exonerates the branch. Splitting on the first dot lands inside
    // "github.com". Both are wrong on real input.
    assert.equal(stripPackageQualifier("github.com/o/r/internal.TestA-x.y"), "TestA-x.y");
    assert.equal(stripPackageQualifier("gopkg.in/yaml.v2.TestThing"), "TestThing");
  });

  test("REFUSES rather than dropping when a name is unsafe", () => {
    // Dropping a name would compare different test sets on the two sides
    // and could call a real regression pre-existing. Refusing the whole
    // filter is the only safe partial state.
    assert.equal(buildBaselineFilter(["p.TestOk", "p.Test'; rm -rf /"]), null);
    assert.equal(buildBaselineFilter(["p.Test With Space"]), null);
    assert.equal(buildBaselineFilter(["p.Test$(whoami)"]), null);
  });

  test("returns null for an empty list rather than a match-everything filter", () => {
    // An empty filter would re-run the WHOLE suite against the base,
    // turning a seconds-long check into a second five-minute run.
    assert.equal(buildBaselineFilter([]), null);
  });

  test("junit-xml builds a comma-separated Class#method list, not a regex", () => {
    // Android instrumentation selects by this list. The Go regex matched
    // nothing there, so every live failure stayed the branch's and
    // pyrycode-mobile #1016 was sent back three times for flakes.
    const f = buildBaselineFilter(
      ["de.pyryco.mobile.e2e.InteractiveStreamE2ETest#interactiveTurn_a", "de.pyryco.mobile.e2e.InteractiveStreamE2ETest#interactiveTurn_b"],
      "junit-xml",
    );
    assert.equal(f, "'de.pyryco.mobile.e2e.InteractiveStreamE2ETest#interactiveTurn_a,de.pyryco.mobile.e2e.InteractiveStreamE2ETest#interactiveTurn_b'");
  });

  test("junit-xml deduplicates and keeps a nested class", () => {
    assert.equal(buildBaselineFilter(["p.A$Inner#m", "p.A$Inner#m"], "junit-xml"), "'p.A$Inner#m'");
  });

  test("junit-xml REFUSES the whole list when one name is not a plain Class#method", () => {
    assert.equal(buildBaselineFilter(["p.A#ok", "p.A#param[0]"], "junit-xml"), null);
    assert.equal(buildBaselineFilter(["p.A#with space"], "junit-xml"), null);
    assert.equal(buildBaselineFilter(["p.A#m'; rm -rf /"], "junit-xml"), null);
    assert.equal(buildBaselineFilter(["p.A"], "junit-xml"), null);
    assert.equal(buildBaselineFilter(["p.A#m,p.B#n"], "junit-xml"), null);
    assert.equal(buildBaselineFilter([], "junit-xml"), null);
  });

  test("junit-xml filter survives command substitution intact", () => {
    const cmd = buildBaselineCommand("python3 gate.py live --tests {{TESTS}}", buildBaselineFilter(["p.A$B#m"], "junit-xml")!);
    assert.equal(cmd, "python3 gate.py live --tests 'p.A$B#m'");
  });
});

describe("decideBaselineAdjustedVerdict", () => {
  const base = { verdict: "fail" as const, reason: "2 test(s) failed", branchFailures: ["p.TestA", "p.TestB"] };

  test("failures that also fail on the base become inherited-failure", () => {
    // The pyrycode#1382 case, 2026-08-07: 519 passed, 2 failed, and both
    // failures reproduce identically on clean main with nothing to do with
    // the ticket. Keep that attribution in the evidence even though a
    // trustworthy red run now waits on separate fix-ticket blockers.
    const d = decideBaselineAdjustedVerdict({ ...base, baselineFailures: ["p.TestA", "p.TestB"] });
    assert.equal(d.verdict, "inherited-failure");
    assert.deepEqual(d.introduced, []);
    assert.deepEqual(d.preExisting, ["p.TestA", "p.TestB"]);
  });

  test("a single branch-introduced failure keeps the whole run a fail", () => {
    // One genuine regression is not excused by its neighbours being old.
    const d = decideBaselineAdjustedVerdict({ ...base, baselineFailures: ["p.TestA"] });
    assert.equal(d.verdict, "fail");
    assert.deepEqual(d.introduced, ["p.TestB"]);
    assert.deepEqual(d.preExisting, ["p.TestA"]);
  });

  test("no overlap at all is an ordinary fail", () => {
    const d = decideBaselineAdjustedVerdict({ ...base, baselineFailures: [] });
    assert.equal(d.verdict, "fail");
    assert.deepEqual(d.introduced, ["p.TestA", "p.TestB"]);
  });

  test("INVARIANT: a MISSING baseline never exonerates a branch", () => {
    // null and empty must not collapse. Empty means the baseline ran and
    // every failure is new; null means nothing is known. Treating unknown
    // as pre-existing would let a real regression park as somebody else's
    // problem, which is worse than the bug this fixes.
    const d = decideBaselineAdjustedVerdict({ ...base, baselineFailures: null });
    assert.equal(d.verdict, "fail");
    assert.match(d.reason, /no base comparison was available/);
    assert.deepEqual(d.preExisting, []);
  });

  test("a package-level failure with no named test stays the branch's problem", () => {
    // Nothing to attribute, so nothing is excused.
    const d = decideBaselineAdjustedVerdict({
      verdict: "fail", reason: "suite-level failure", branchFailures: [], baselineFailures: [],
    });
    assert.equal(d.verdict, "fail");
  });

  test("leaves every non-fail verdict untouched", () => {
    // A baseline says nothing about whether a run is trustworthy at all.
    for (const v of ["pass", "zero-executed", "unusable"] as const) {
      const d = decideBaselineAdjustedVerdict({
        verdict: v, reason: "r", branchFailures: [], baselineFailures: ["p.TestA"],
      });
      assert.equal(d.verdict, v);
    }
  });

  test("every failure passing on the same-tree re-run is a flaky-pass, not a fail", () => {
    // pyrycode #2089, 2026-09-06 12:47: a finished ticket with a fifth-pass
    // review PASS failed one liveness test its diff never reaches. The test
    // had passed the previous nineteen gate runs and passed three of three
    // by hand minutes later; it passed on the base too, so the base
    // comparison called it a regression and the rework breaker tripped.
    const d = decideBaselineAdjustedVerdict({ ...base, baselineFailures: null, rerunFailures: [] });
    assert.equal(d.verdict, "flaky-pass");
    assert.deepEqual(d.flaky, ["p.TestA", "p.TestB"]);
    assert.deepEqual(d.introduced, []);
    assert.deepEqual(d.preExisting, []);
  });

  test("a failure that fails again is judged against the base; the flaky one is set aside", () => {
    const d = decideBaselineAdjustedVerdict({ ...base, baselineFailures: [], rerunFailures: ["p.TestB"] });
    assert.equal(d.verdict, "fail");
    assert.deepEqual(d.introduced, ["p.TestB"]);
    assert.deepEqual(d.flaky, ["p.TestA"]);
    assert.match(d.reason, /set aside as flaky/);
  });

  test("a persistent failure that is also red on the base is inherited, flaky ones aside", () => {
    const d = decideBaselineAdjustedVerdict({ ...base, baselineFailures: ["p.TestB"], rerunFailures: ["p.TestB"] });
    assert.equal(d.verdict, "inherited-failure");
    assert.deepEqual(d.preExisting, ["p.TestB"]);
    assert.deepEqual(d.flaky, ["p.TestA"]);
  });

  test("INVARIANT: a MISSING re-run never excuses a failure", () => {
    // Null and empty must not collapse here either. Empty means every
    // failure ran again and passed; null means nothing was re-run.
    for (const rerun of [null, undefined]) {
      const d = decideBaselineAdjustedVerdict({ ...base, baselineFailures: [], rerunFailures: rerun });
      assert.equal(d.verdict, "fail");
      assert.deepEqual(d.introduced, ["p.TestA", "p.TestB"]);
      assert.deepEqual(d.flaky, []);
    }
  });

  test("flaky-pass advances like a pass but pings a human", () => {
    const o = decideGateOutcome("flaky-pass");
    assert.equal(o.toColumn, "In Documentation");
    assert.deepEqual(o.removeLabels, ["needs-real-claude"]);
    assert.deepEqual(o.addLabels, []);
    assert.equal(o.notify, true);
  });

  test("inherited test failures wait in Inbox without requesting rework", () => {
    const o = decideGateOutcome("inherited-failure");
    assert.equal(o.toColumn, null);
    assert.deepEqual(o.addLabels, []);
    assert.deepEqual(o.removeLabels, [], "the gate label must survive");
    assert.equal(o.notify, true);
  });
});

describe("buildBaselineCommand", () => {
  test("does NOT let the filter's trailing $' eat the rest of the command", () => {
    // The 2026-08-07 live failure. `replaceAll` with a string replacement
    // treats `$'` as "everything after the match", so the anchor plus
    // closing quote at the end of the filter swallowed the package path and
    // left the quote open. bash rejected the whole command, the base run
    // wrote nothing, and the branch was blamed for failures it had not
    // caused — the exact bug the baseline exists to fix, one layer down.
    const filter = buildBaselineFilter(["p.TestA", "p.TestB"]);
    assert.equal(filter, "'^(TestA|TestB)$'");

    const cmd = buildBaselineCommand("go test -json -run {{TESTS}} ./internal/e2e/...", filter!);

    assert.equal(cmd, "go test -json -run '^(TestA|TestB)$' ./internal/e2e/...");
    // The specific corruption, named so a regression is unmistakable.
    assert.ok(!cmd!.includes("./internal/e2e/... ./internal/e2e/..."), "the path was duplicated by $' expansion");
    assert.equal((cmd!.match(/'/g) ?? []).length % 2, 0, "single quotes must be balanced or bash rejects the command");
  });

  test("leaves $& and backtick-dollar patterns alone too", () => {
    // Same family of replacement patterns, same fix.
    assert.equal(buildBaselineCommand("run {{TESTS}} end", "$&"), "run $& end");
    assert.equal(buildBaselineCommand("run {{TESTS}} end", "$`"), "run $` end");
  });

  test("substitutes every occurrence", () => {
    assert.equal(buildBaselineCommand("a {{TESTS}} b {{TESTS}}", "X"), "a X b X");
  });

  test("returns null when the template has no placeholder", () => {
    // Substituting nothing would silently re-run the whole suite against
    // the base, turning a seconds-long check into a second full run.
    assert.equal(buildBaselineCommand("go test ./...", "'^(TestA)$'"), null);
  });
});

// =====================================================================
// Family circuit breaker — parent-chain mapping (github.ts)
// =====================================================================

describe("mapParentChain — GraphQL parent chain → ProjectItem fields", () => {
  test("maps a two-level chain: parent and grandparent numbers both surface", () => {
    const mapped = mapParentChain({
      parent: { number: 40, parent: { number: 12 } },
    });
    assert.deepEqual(mapped, { parentNumber: 40, grandparentNumber: 12 });
  });

  test("maps a single-level chain: parent surfaces, grandparent is null", () => {
    const mapped = mapParentChain({
      parent: { number: 40, parent: null },
    });
    assert.deepEqual(mapped, { parentNumber: 40, grandparentNumber: null });
  });

  test("a parentless issue maps to null for both fields", () => {
    assert.deepEqual(mapParentChain({ parent: null }), { parentNumber: null, grandparentNumber: null });
  });

  test("a node with no parent key at all maps to null for both fields", () => {
    // Defensive: GraphQL omits the key when the fragment doesn't match.
    assert.deepEqual(mapParentChain({}), { parentNumber: null, grandparentNumber: null });
    assert.deepEqual(mapParentChain(null), { parentNumber: null, grandparentNumber: null });
    assert.deepEqual(mapParentChain(undefined), { parentNumber: null, grandparentNumber: null });
  });

  test("a parent node without a usable number is treated as no parent", () => {
    // A parent that is a PR fragment or an inaccessible issue yields no
    // number; the chain must not invent one, and a grandparent hanging
    // off an unresolved parent is unreachable by definition.
    assert.deepEqual(mapParentChain({ parent: { parent: { number: 3 } } } as any), {
      parentNumber: null,
      grandparentNumber: null,
    });
  });
});

// =====================================================================
// Family circuit breaker — pure decision layer
// =====================================================================

describe("resolveFamilyRoot", () => {
  test("a ticket with no parent is its own family root", () => {
    assert.equal(resolveFamilyRoot({ issueNumber: 7 }), 7);
    assert.equal(resolveFamilyRoot({ issueNumber: 7, parentNumber: null, grandparentNumber: null }), 7);
  });

  test("a child resolves to its parent as the family root", () => {
    assert.equal(resolveFamilyRoot({ issueNumber: 41, parentNumber: 40, grandparentNumber: null }), 40);
  });

  test("a grandchild resolves to its grandparent as the family root", () => {
    assert.equal(resolveFamilyRoot({ issueNumber: 42, parentNumber: 41, grandparentNumber: 40 }), 40);
  });
});

describe("decideFamilyBreaker", () => {
  test("a family one dispatch under the threshold is allowed (23 of 24)", () => {
    const d = decideFamilyBreaker({ rootNumber: 40, markerCount: 23, threshold: 24 });
    assert.equal(d.veto, false);
  });

  test("a family exactly at the threshold is vetoed (24 of 24)", () => {
    const d = decideFamilyBreaker({ rootNumber: 40, markerCount: 24, threshold: 24 });
    assert.equal(d.veto, true);
    assert.ok(d.reason.includes("24"), "reason should carry the tally");
  });

  test("a family over the threshold stays vetoed", () => {
    assert.equal(decideFamilyBreaker({ rootNumber: 40, markerCount: 213, threshold: 24 }).veto, true);
  });

  test("a fresh family with zero dispatches is allowed", () => {
    assert.equal(decideFamilyBreaker({ rootNumber: 40, markerCount: 0, threshold: 24 }).veto, false);
  });

  test("the default limit is 24 — about four clean six-stage tickets", () => {
    assert.equal(FAMILY_DISPATCH_LIMIT_DEFAULT, 24);
  });
});

describe("resolveFamilyDispatchLimit — PYRY_FAMILY_DISPATCH_LIMIT parsing", () => {
  test("unset falls back to the default of 24", () => {
    assert.equal(resolveFamilyDispatchLimit(undefined), FAMILY_DISPATCH_LIMIT_DEFAULT);
    assert.equal(resolveFamilyDispatchLimit(""), FAMILY_DISPATCH_LIMIT_DEFAULT);
  });

  test("a positive integer is honoured", () => {
    assert.equal(resolveFamilyDispatchLimit("48"), 48);
    assert.equal(resolveFamilyDispatchLimit("1"), 1);
  });

  test("zero, negatives, and garbage fall back to the default — a limit of 0 would park every family", () => {
    assert.equal(resolveFamilyDispatchLimit("0"), FAMILY_DISPATCH_LIMIT_DEFAULT);
    assert.equal(resolveFamilyDispatchLimit("-5"), FAMILY_DISPATCH_LIMIT_DEFAULT);
    assert.equal(resolveFamilyDispatchLimit("many"), FAMILY_DISPATCH_LIMIT_DEFAULT);
  });
});

describe("extractFamilyDispatchCount", () => {
  test("reads the count from a family-dispatches:N label", () => {
    assert.equal(extractFamilyDispatchCount(["size:m", "family-dispatches:7"]), 7);
  });

  test("no counter label reads as zero", () => {
    assert.equal(extractFamilyDispatchCount([]), 0);
    assert.equal(extractFamilyDispatchCount(["size:m", "done:po"]), 0);
  });

  test("multiple counters read as the maximum (bias toward tripping, mirrors extractReworkCount)", () => {
    assert.equal(extractFamilyDispatchCount(["family-dispatches:3", "family-dispatches:9"]), 9);
  });

  test("malformed and negative tails are treated as zero", () => {
    assert.equal(extractFamilyDispatchCount(["family-dispatches:", "family-dispatches:abc", "family-dispatches:-2"]), 0);
  });
});

describe("resolveFamilyTally — comments are the source of truth", () => {
  test("when the marker-comment count and the label disagree, the comments win", () => {
    // Label says 50 (stale or corrupted), comments say 3 → the family is fine.
    assert.equal(resolveFamilyTally(3, ["family-dispatches:50"]), 3);
    // Label says 3 (failed writes), comments say 30 → the family trips.
    assert.equal(resolveFamilyTally(30, ["family-dispatches:3"]), 30);
  });

  test("an unreadable comment count falls back to the convenience label", () => {
    assert.equal(resolveFamilyTally(null, ["family-dispatches:12"]), 12);
  });

  test("an unreadable comment count with no label reads as zero — fail open, a crashed cycle is worse", () => {
    assert.equal(resolveFamilyTally(null, []), 0);
  });
});

describe("family labels do not collide with the pipeline label scheme", () => {
  test("family-dispatches:N is not a pipeline label, so pre-dispatch prep never strips it", () => {
    assert.equal(isPipelineLabel("family-dispatches:24"), false);
    for (const agent of AGENTS) {
      assert.equal(
        isPipelineLabelForAgent(`family-dispatches:${agent.name}`, agent.name),
        false,
        `family-dispatches: must not read as a pipeline label for ${agent.name}`,
      );
      assert.equal(isPipelineLabelForAgent("family-dispatches:24", agent.name), false);
    }
  });

  test("the counter prefix is disjoint from every pipeline prefix", () => {
    for (const prefix of PIPELINE_LABEL_PREFIXES) {
      assert.ok(
        !FAMILY_DISPATCH_COUNT_PREFIX.startsWith(prefix),
        `${FAMILY_DISPATCH_COUNT_PREFIX} must not start with ${prefix}`,
      );
    }
  });

  test("error:family-breaker IS a pipeline label but belongs to no agent name", () => {
    // The error: prefix is load-bearing: it already excludes the root from
    // the WIP count. No agent is named family-breaker, so the per-agent
    // strip loop never touches it.
    assert.equal(isPipelineLabel(FAMILY_BREAKER_LABEL), true);
    for (const agent of AGENTS) {
      assert.equal(isPipelineLabelForAgent(FAMILY_BREAKER_LABEL, agent.name), false);
    }
  });
});

describe("shouldSkipDispatch — family breaker veto", () => {
  test("error:family-breaker on the ticket itself blocks every agent (the parked root)", () => {
    for (const agent of AGENTS) {
      assert.equal(
        shouldSkipDispatch([FAMILY_BREAKER_LABEL], agent.name),
        true,
        `error:family-breaker should block dispatch for ${agent.name}`,
      );
    }
  });

  test("error:family-breaker on the ROOT's labels blocks a clean descendant for every agent", () => {
    for (const agent of AGENTS) {
      assert.equal(
        shouldSkipDispatch([], agent.name, [FAMILY_BREAKER_LABEL]),
        true,
        `a root carrying error:family-breaker should veto descendants for ${agent.name}`,
      );
    }
  });

  test("a root without the breaker label does not veto the descendant", () => {
    assert.equal(shouldSkipDispatch([], "developer", ["size:m", "done:po"]), false);
    assert.equal(shouldSkipDispatch([], "developer", []), false);
    assert.equal(shouldSkipDispatch([], "developer", undefined), false);
  });

  test("other error labels on the root do NOT veto the descendant — only the family breaker crosses the parent chain", () => {
    // A root parked on its own error (say error:po) is that ticket's
    // problem; its siblings and children keep flowing.
    assert.equal(shouldSkipDispatch([], "developer", ["error:po"]), false);
    assert.equal(shouldSkipDispatch([], "developer", ["error:merge-conflict"]), false);
  });
});

describe("decideDoneCleanup — family breaker labels", () => {
  test("strips the family-dispatches:N counter when a ticket reaches Done", () => {
    const cleanups = decideDoneCleanup([
      { id: "a", issueNumber: 40, labels: ["family-dispatches:11", "size:m"] },
    ]);
    assert.equal(cleanups.length, 1);
    assert.deepEqual(cleanups[0].labelsToStrip, ["family-dispatches:11"]);
  });

  test("preserves error:family-breaker on a Done root — it is the park switch, not a stale trail", () => {
    // A split family's root sits closed in Done while its descendants
    // dispatch. Stripping the breaker label there would erase the
    // operator's board signal every cycle and re-arm nothing.
    const cleanups = decideDoneCleanup([
      { id: "a", issueNumber: 40, labels: [FAMILY_BREAKER_LABEL, "done:po", "family-dispatches:24"] },
    ]);
    assert.equal(cleanups.length, 1);
    assert.ok(!cleanups[0].labelsToStrip.includes(FAMILY_BREAKER_LABEL), "the park switch must survive Done cleanup");
    assert.ok(cleanups[0].labelsToStrip.includes("done:po"));
    assert.ok(cleanups[0].labelsToStrip.includes("family-dispatches:24"));
  });

  test("a Done root carrying ONLY the breaker label needs no cleanup at all", () => {
    const cleanups = decideDoneCleanup([
      { id: "a", issueNumber: 40, labels: [FAMILY_BREAKER_LABEL] },
    ]);
    assert.deepEqual(cleanups, []);
  });

  test("other error labels are still stripped on Done", () => {
    const cleanups = decideDoneCleanup([
      { id: "a", issueNumber: 41, labels: ["error:developer"] },
    ]);
    assert.equal(cleanups.length, 1);
    assert.deepEqual(cleanups[0].labelsToStrip, ["error:developer"]);
  });
});

describe("selectDispatches — family breaker veto at the selection layer", () => {
  const POLL_ORDER = [...AGENTS].reverse();

  const child = (n: number, root: number, labels: string[] = []) =>
    ({ id: `item-${n}`, issueNumber: n, labels, blockedBy: [], parentNumber: root, grandparentNumber: null });

  test("a breaker label on the family root vetoes a clean child candidate", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [child(41, 40)]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
      rootLabelsByIssue: new Map([[40, [FAMILY_BREAKER_LABEL]]]),
    });
    assert.deepEqual(r, []);
  });

  test("a grandchild is vetoed through its grandparent root", () => {
    const grandchild = { id: "item-42", issueNumber: 42, labels: [], blockedBy: [], parentNumber: 41, grandparentNumber: 40 };
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [grandchild]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
      rootLabelsByIssue: new Map([[40, [FAMILY_BREAKER_LABEL]]]),
    });
    assert.deepEqual(r, []);
  });

  test("a healthy family is unaffected by the lookup", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [child(41, 40)]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
      rootLabelsByIssue: new Map([[40, ["size:l"]]]),
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].item.issueNumber, 41);
  });

  test("without the lookup (older callers), selection behaves exactly as before", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [child(41, 40)]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
    });
    assert.equal(r.length, 1);
  });

  test("a parked root selected directly is vetoed by its own labels even without the lookup", () => {
    const root = { id: "item-40", issueNumber: 40, labels: [FAMILY_BREAKER_LABEL], blockedBy: [] };
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [root]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
    });
    assert.deepEqual(r, []);
  });
});

// =====================================================================
// Family circuit breaker — per-family reset (tallyFamilyComments)
// =====================================================================

describe("tallyFamilyComments — dispatch tally with per-family reset", () => {
  const marker = (n = 1) => ({ body: `${FAMILY_DISPATCH_COMMENT_MARKER}\n🧮 Family dispatch ${n}` });
  const reset = () => ({ body: `${FAMILY_DISPATCH_RESET_MARKER} resetting after triage` });
  const trip = () => ({ body: `${FAMILY_BREAKER_COMMENT_MARKER}\ntripped — post \`${FAMILY_DISPATCH_RESET_MARKER}\` to reset` });

  test("counts every dispatch marker when no reset comment exists", () => {
    const out = tallyFamilyComments([marker(), { body: "unrelated chatter" }, marker(), marker()]);
    assert.deepEqual(out, { markerCount: 3, breakerCommented: false });
  });

  test("a reset comment zeroes the tally — only markers posted after the latest reset count", () => {
    const out = tallyFamilyComments([marker(), marker(), reset(), marker()]);
    assert.deepEqual(out, { markerCount: 1, breakerCommented: false });
  });

  test("with several resets, only markers after the LAST one count", () => {
    const out = tallyFamilyComments([marker(), reset(), marker(), marker(), reset(), marker()]);
    assert.deepEqual(out, { markerCount: 1, breakerCommented: false });
  });

  test("a reset also clears the trip-comment dedupe, so a resumed family that runs away again explains itself again", () => {
    const out = tallyFamilyComments([marker(), trip(), reset(), marker()]);
    assert.deepEqual(out, { markerCount: 1, breakerCommented: false });
  });

  test("the trip comment quotes the reset marker in its instructions but never counts as a reset itself", () => {
    // The trip comment MUST show the operator the exact string to post, so
    // its body contains the reset marker. If that mention counted as a
    // reset, every trip would immediately zero the tally it tripped on.
    const out = tallyFamilyComments([marker(), marker(), trip(), marker()]);
    assert.deepEqual(out, { markerCount: 3, breakerCommented: true });
  });

  test("a trip comment after the latest reset re-arms the dedupe", () => {
    const out = tallyFamilyComments([trip(), reset(), marker(), trip()]);
    assert.deepEqual(out, { markerCount: 1, breakerCommented: true });
  });

  test("comments are ordered by created_at when every comment carries one", () => {
    // Positionally the reset comes first, chronologically it comes last —
    // the tally must follow time, not array position, when GitHub's
    // ordering can be trusted from timestamps.
    const out = tallyFamilyComments([
      { body: `${FAMILY_DISPATCH_RESET_MARKER}`, created_at: "2026-09-01T12:00:00Z" },
      { body: FAMILY_DISPATCH_COMMENT_MARKER, created_at: "2026-09-01T10:00:00Z" },
      { body: FAMILY_DISPATCH_COMMENT_MARKER, created_at: "2026-09-01T11:00:00Z" },
    ]);
    assert.deepEqual(out, { markerCount: 0, breakerCommented: false });
  });

  test("without timestamps, array order stands (GitHub returns issue comments oldest-first)", () => {
    const out = tallyFamilyComments([reset(), marker(), marker()]);
    assert.deepEqual(out, { markerCount: 2, breakerCommented: false });
  });

  test("non-string bodies are skipped, not crashed on", () => {
    const out = tallyFamilyComments([{ body: null }, {}, marker()]);
    assert.deepEqual(out, { markerCount: 1, breakerCommented: false });
  });

  test("the three family marker strings are mutually distinct — none contains another", () => {
    const markers = [FAMILY_DISPATCH_COMMENT_MARKER, FAMILY_BREAKER_COMMENT_MARKER, FAMILY_DISPATCH_RESET_MARKER];
    for (const a of markers) {
      for (const b of markers) {
        if (a === b) continue;
        assert.ok(!a.includes(b), `${a} must not contain ${b} — substring collision would corrupt the tally`);
      }
    }
  });
});

describe("selectDispatches — a reset alone does not resume a parked family", () => {
  test("the breaker label wins at selection even after the tally was reset to zero", () => {
    // The reset comment zeroes the tally; the label is the park switch.
    // Both steps of the resume gesture are required: selection never
    // consults tallies, so a root still wearing error:family-breaker
    // keeps vetoing its descendants regardless of the reset.
    const POLL_ORDER = [...AGENTS].reverse();
    const child = { id: "item-41", issueNumber: 41, labels: [], blockedBy: [], parentNumber: 40, grandparentNumber: null };
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [child]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
      rootLabelsByIssue: new Map([[40, [FAMILY_BREAKER_LABEL]]]),
    });
    assert.deepEqual(r, []);
  });
});

// =====================================================================
// Resume-in-place — pure decisions (same-dispatch continuation leg)
// =====================================================================
//
// When a run exhausts its turn budget or wall clock, the dispatcher may
// resume the SAME claude session with a fresh budget before falling back
// to salvage. The pure pieces: session-id capture from the stream,
// the resume decision gates, the forced-claude argv bridge, the
// continuation prompt, and the cross-leg usage merge.

describe("captureSessionId — init-frame stream capture", () => {
  // Spike-proven (claude CLI 2.1.239): a run killed by SIGTERM/SIGKILL
  // emits NO result frame, so the result-frame-only capture loses the
  // session id exactly when a resume needs it. Every stream event
  // carries session_id and the system/init frame arrives within
  // seconds of spawn — so the FIRST event that carries one wins.

  test("the system/init frame's session id is captured as the first carrier", () => {
    const init = { type: "system", subtype: "init", session_id: "sess-abc" };
    assert.equal(captureSessionId("", init), "sess-abc");
  });

  test("a session id already captured is never overwritten by a later event", () => {
    const later = { type: "assistant", session_id: "sess-DIFFERENT" };
    assert.equal(captureSessionId("sess-abc", later), "sess-abc");
  });

  test("events without a session id leave the capture unchanged", () => {
    assert.equal(captureSessionId("", { type: "assistant" }), "");
    assert.equal(captureSessionId("sess-abc", { type: "assistant" }), "sess-abc");
  });

  test("a non-string or empty session_id field is ignored", () => {
    assert.equal(captureSessionId("", { session_id: 42 }), "");
    assert.equal(captureSessionId("", { session_id: "" }), "");
    assert.equal(captureSessionId("", { session_id: null }), "");
  });

  test("the no-result-frame kill shape still yields the init session id", () => {
    // Sequence a SIGKILLed run actually produces: init frame, a few
    // assistant/tool frames, then nothing — no result frame ever.
    const events: Record<string, unknown>[] = [
      { type: "system", subtype: "init", session_id: "sess-kill-7" },
      { type: "assistant", session_id: "sess-kill-7", message: {} },
      { type: "assistant", session_id: "sess-kill-7", message: {} },
    ];
    const captured = events.reduce(captureSessionId, "");
    assert.equal(captured, "sess-kill-7");
  });
});

describe("pickFinalSessionId — result frame wins over init capture", () => {
  test("the result frame's value wins when both exist and differ", () => {
    assert.equal(pickFinalSessionId("sess-result", "sess-init"), "sess-result");
  });

  test("falls back to the init-captured value when the result frame carries none", () => {
    assert.equal(pickFinalSessionId("", "sess-init"), "sess-init");
    assert.equal(pickFinalSessionId(undefined, "sess-init"), "sess-init");
    assert.equal(pickFinalSessionId(null, "sess-init"), "sess-init");
  });

  test("a non-string result-frame value falls back to the init capture", () => {
    assert.equal(pickFinalSessionId(42, "sess-init"), "sess-init");
  });

  test("empty on both sides stays empty", () => {
    assert.equal(pickFinalSessionId("", ""), "");
  });
});

describe("parseBudgetScale — the PYRY_BUDGET_SCALE knob", () => {
  test("unset or empty keeps every budget as it is", () => {
    assert.equal(parseBudgetScale(undefined), 1);
    assert.equal(parseBudgetScale(""), 1);
  });

  test("a positive number is the multiplier", () => {
    assert.equal(parseBudgetScale("1.5"), 1.5);
    assert.equal(parseBudgetScale("2"), 2);
    assert.equal(parseBudgetScale("0.5"), 0.5);
  });

  test("garbage, zero and negatives fall back to 1", () => {
    assert.equal(parseBudgetScale("banana"), 1);
    assert.equal(parseBudgetScale("1.5x"), 1);
    assert.equal(parseBudgetScale("0"), 1);
    assert.equal(parseBudgetScale("-2"), 1);
  });
});

describe("PYRY_BUDGET_SCALE applied through maxTurnsFor / timeoutFor", () => {
  const dev = AGENTS.find(a => a.name === "developer")!;
  const inline = { ...dev, name: "builder", maxTurns: 200, timeoutMs: 2_400_000 };

  function withScale(value: string | undefined, fn: () => void): void {
    const prior = process.env.PYRY_BUDGET_SCALE;
    if (value === undefined) delete process.env.PYRY_BUDGET_SCALE;
    else process.env.PYRY_BUDGET_SCALE = value;
    try {
      fn();
    } finally {
      if (prior === undefined) delete process.env.PYRY_BUDGET_SCALE;
      else process.env.PYRY_BUDGET_SCALE = prior;
    }
  }

  test("unset leaves name-keyed and inline budgets unchanged", () => {
    const previous = process.env.PYRY_BUILDER_TIMEOUT_MINUTES;
    delete process.env.PYRY_BUILDER_TIMEOUT_MINUTES;
    try {
      withScale(undefined, () => {
        assert.equal(maxTurnsFor(dev), 135);
        assert.equal(timeoutFor(dev), 1_500_000);
        assert.equal(maxTurnsFor(inline), 200);
        assert.equal(timeoutFor(inline), 2_400_000);
      });
    } finally {
      if (previous !== undefined) process.env.PYRY_BUILDER_TIMEOUT_MINUTES = previous;
    }
  });

  test("1.5 scales inline stage-set budgets (builder 200 turns / 40min → 300 / 60min)", () => {
    const previous = process.env.PYRY_BUILDER_TIMEOUT_MINUTES;
    delete process.env.PYRY_BUILDER_TIMEOUT_MINUTES;
    try {
      withScale("1.5", () => {
        assert.equal(maxTurnsFor(inline), 300);
        assert.equal(timeoutFor(inline), 3_600_000);
      });
    } finally {
      if (previous !== undefined) process.env.PYRY_BUILDER_TIMEOUT_MINUTES = previous;
    }
  });

  test("a builder-only timeout overrides the scaled wall clock without changing turn or verifier budgets", () => {
    const previous = process.env.PYRY_BUILDER_TIMEOUT_MINUTES;
    try {
      process.env.PYRY_BUILDER_TIMEOUT_MINUTES = "70";
      withScale("1.5", () => {
        assert.equal(maxTurnsFor(inline), 300);
        assert.equal(timeoutFor(inline), 4_200_000);
        assert.equal(timeoutFor(dev), 2_280_000);
      });
      process.env.PYRY_BUILDER_TIMEOUT_MINUTES = "70x";
      assert.throws(() => timeoutFor(inline), /PYRY_BUILDER_TIMEOUT_MINUTES/);
    } finally {
      if (previous === undefined) delete process.env.PYRY_BUILDER_TIMEOUT_MINUTES;
      else process.env.PYRY_BUILDER_TIMEOUT_MINUTES = previous;
    }
  });

  test("1.5 scales name-keyed budgets and rounds timeouts to whole minutes", () => {
    withScale("1.5", () => {
      assert.equal(maxTurnsFor(dev), 203); // 202.5 rounds up
      assert.equal(timeoutFor(dev), 2_280_000); // 37.5min rounds to 38min
    });
  });

  test("a tiny scale never yields zero turns or a zero timeout", () => {
    withScale("0.001", () => {
      assert.equal(maxTurnsFor(dev), 1);
      assert.equal(timeoutFor(dev), 60_000);
    });
  });
});

describe("parseResumeLegs — the PYRY_RESUME_LEGS knob", () => {
  test("unset defaults to one continuation leg", () => {
    assert.equal(parseResumeLegs(undefined), 1);
  });

  test("empty string defaults to one continuation leg", () => {
    assert.equal(parseResumeLegs(""), 1);
  });

  test("zero disables the feature entirely", () => {
    assert.equal(parseResumeLegs("0"), 0);
  });

  test("a positive integer grants that many continuation legs", () => {
    assert.equal(parseResumeLegs("2"), 2);
    assert.equal(parseResumeLegs("5"), 5);
  });

  test("garbage falls back to the default of one", () => {
    assert.equal(parseResumeLegs("banana"), 1);
  });

  test("a negative value disables, same as zero", () => {
    assert.equal(parseResumeLegs("-3"), 0);
  });
});

describe("shouldAttemptResume — decision gates", () => {
  // All five gates must pass: budget exhaustion (max_turns OR timedOut),
  // a captured session id, a worktree run, legs remaining, and NOT a
  // permission denial (denials keep their existing salvage).
  const baseOk = {
    terminalReason: "max_turns",
    timedOut: false,
    sessionId: "sess-abc",
    usedWorktree: true,
    hadPermissionDenial: false,
    legsUsed: 0,
    maxLegs: 1,
  };

  test("max_turns with a session id in a worktree and legs remaining → resume", () => {
    assert.equal(shouldAttemptResume(baseOk), true);
  });

  test("a wall-clock timeout (empty terminal reason) also resumes", () => {
    assert.equal(
      shouldAttemptResume({ ...baseOk, terminalReason: "", timedOut: true }),
      true,
    );
  });

  test("a genuine error shape (no exhaustion, no timeout) never resumes", () => {
    assert.equal(
      shouldAttemptResume({ ...baseOk, terminalReason: "api_error" }),
      false,
    );
  });

  test("no captured session id → no resume (nothing to resume into)", () => {
    assert.equal(shouldAttemptResume({ ...baseOk, sessionId: "" }), false);
  });

  test("a non-worktree run never resumes", () => {
    assert.equal(shouldAttemptResume({ ...baseOk, usedWorktree: false }), false);
  });

  test("legs already used up → no resume", () => {
    assert.equal(shouldAttemptResume({ ...baseOk, legsUsed: 1, maxLegs: 1 }), false);
  });

  test("maxLegs=0 (feature disabled) → no resume even on a perfect shape", () => {
    assert.equal(shouldAttemptResume({ ...baseOk, maxLegs: 0 }), false);
  });

  test("a permission denial never resumes, even on a max_turns reason", () => {
    assert.equal(
      shouldAttemptResume({ ...baseOk, hadPermissionDenial: true }),
      false,
    );
  });

  test("a permission denial never resumes, even when the wall clock also fired", () => {
    assert.equal(
      shouldAttemptResume({
        ...baseOk,
        terminalReason: "permission_denied",
        timedOut: true,
        hadPermissionDenial: true,
      }),
      false,
    );
  });

  test("a second leg is granted when maxLegs allows it", () => {
    assert.equal(shouldAttemptResume({ ...baseOk, legsUsed: 1, maxLegs: 2 }), true);
  });
});

describe("buildResumeArgv — forced-claude continuation argv", () => {
  const baseOpts = {
    sessionId: "sess-abc",
    model: "opus",
    effort: "xhigh",
    maxTurns: 135,
    allowedTools: "Bash,Read,Write",
    disallowedTools: "AskUserQuestion,Skill",
    systemPromptFile: "/agents/.system-prompt-developer.txt",
  };

  test("the continuation leg always spawns the claude binary, never pyry agent-run", () => {
    // The pyry agent-run wrapper has no resume support yet; the resume
    // leg bridges through the claude CLI regardless of
    // PYRY_USE_LEGACY_CLAUDE.
    assert.equal(buildResumeArgv(baseOpts).bin, "claude");
  });

  test("argv re-passes every flag the resumed session does NOT inherit", () => {
    // Permissions and flags do not carry over on --resume: model,
    // effort, max-turns, allowedTools, disallowedTools, and the
    // system-prompt file must all be re-passed per invocation.
    const { args } = buildResumeArgv(baseOpts);
    assert.deepEqual(args, [
      "-p",
      "--verbose",
      "--output-format", "stream-json",
      "--resume", "sess-abc",
      "--model", "opus",
      "--effort", "xhigh",
      "--max-turns", "135",
      "--allowedTools", "Bash,Read,Write",
      "--disallowedTools", "AskUserQuestion,Skill",
      "--append-system-prompt-file", "/agents/.system-prompt-developer.txt",
    ]);
  });

  test("an empty disallowedTools omits the flag entirely", () => {
    const { args } = buildResumeArgv({ ...baseOpts, disallowedTools: "" });
    assert.ok(!args.includes("--disallowedTools"));
    assert.ok(args.includes("--allowedTools"));
  });

  test("--verbose is present (required with stream-json)", () => {
    assert.ok(buildResumeArgv(baseOpts).args.includes("--verbose"));
  });
});

describe("buildResumePrompt — continuation prompt content", () => {
  test("states the budget exhaustion, the intact worktree, and the no-redo instruction", () => {
    const prompt = buildResumePrompt("max_turns");
    assert.match(prompt, /turn budget/i);
    assert.match(prompt, /worktree and branch are intact/i);
    assert.match(prompt, /without redoing/i);
    assert.match(prompt, /commit and push/i);
    assert.match(prompt, /gates/i);
  });

  test("names the wall-clock timeout when that was the exhausted budget", () => {
    const prompt = buildResumePrompt("timeout");
    assert.match(prompt, /wall-clock/i);
    assert.doesNotMatch(prompt, /turn budget/i);
  });
});

describe("mergeLegResults — cross-leg usage aggregation", () => {
  const firstLeg = {
    output: "ran out of turns",
    sessionId: "sess-abc",
    isError: true,
    numTurns: 135,
    totalCostUsd: 4.5,
    durationMs: 600_000,
    usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
    terminalReason: "max_turns",
    rawResult: { subtype: "error_max_turns" },
    hadPermissionDenial: false,
    deniedOpContent: null,
    lastAssistantText: "still working",
    timedOut: false,
  };
  const resumeLeg = {
    ...firstLeg,
    output: "finished cleanly",
    sessionId: "sess-abc",
    isError: false,
    numTurns: 40,
    totalCostUsd: 1.25,
    durationMs: 200_000,
    usage: { input_tokens: 300, output_tokens: 700, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 },
    terminalReason: "stop",
    rawResult: { subtype: "success" },
    lastAssistantText: "done",
  };

  test("turns, cost, and duration sum across legs", () => {
    const merged = mergeLegResults(firstLeg, resumeLeg);
    assert.equal(merged.numTurns, 175);
    assert.equal(merged.totalCostUsd, 5.75);
    assert.equal(merged.durationMs, 800_000);
  });

  test("the token counters the USAGE line reads sum across legs", () => {
    const merged = mergeLegResults(firstLeg, resumeLeg);
    assert.equal(merged.usage.input_tokens, 1300);
    assert.equal(merged.usage.output_tokens, 2700);
    assert.equal(merged.usage.cache_read_input_tokens, 550);
    assert.equal(merged.usage.cache_creation_input_tokens, 120);
  });

  test("the last leg's session id is kept (same session anyway)", () => {
    const merged = mergeLegResults(firstLeg, { ...resumeLeg, sessionId: "sess-abc" });
    assert.equal(merged.sessionId, "sess-abc");
  });

  test("an empty last-leg session id falls back to the first leg's", () => {
    const merged = mergeLegResults(firstLeg, { ...resumeLeg, sessionId: "" });
    assert.equal(merged.sessionId, "sess-abc");
  });

  test("terminal fields (output, error state, reason, raw result) come from the last leg", () => {
    const merged = mergeLegResults(firstLeg, resumeLeg);
    assert.equal(merged.output, "finished cleanly");
    assert.equal(merged.isError, false);
    assert.equal(merged.terminalReason, "stop");
    assert.deepEqual(merged.rawResult, { subtype: "success" });
    assert.equal(merged.lastAssistantText, "done");
  });

  test("usage keys outside the known counters keep the last leg's value", () => {
    const merged = mergeLegResults(
      { ...firstLeg, usage: { ...firstLeg.usage, service_tier: "standard" } },
      { ...resumeLeg, usage: { ...resumeLeg.usage, service_tier: "priority" } },
    );
    assert.equal(merged.usage.service_tier, "priority");
  });

  test("a counter missing on one side sums as if it were zero", () => {
    const merged = mergeLegResults(
      { ...firstLeg, usage: { input_tokens: 1000 } },
      { ...resumeLeg, usage: { output_tokens: 700 } },
    );
    assert.equal(merged.usage.input_tokens, 1000);
    assert.equal(merged.usage.output_tokens, 700);
  });
});

// =====================================================================
// collectOffBoardFamilyRoots — the family veto must survive a Done sweep
// =====================================================================
//
// The board-wide label lookup only knows issues that are ON the board.
// Archiving a crowded Done column takes closed family roots off it, and
// the root's error:family-breaker label then reads as absent. That is
// how #1906 kept passing the selection veto on 2026-09-01 while its
// tally vetoed it every cycle. This helper names the roots worth one
// direct issue read to close that hole.

describe("collectOffBoardFamilyRoots", () => {
  const item = (n: number, parent: number | null = null, grandparent: number | null = null) =>
    ({ issueNumber: n, parentNumber: parent, grandparentNumber: grandparent });

  test("a descendant whose root left the board is worth a direct read", () => {
    const known = new Map<number, readonly string[]>([[1927, []]]);
    assert.deepEqual([...collectOffBoardFamilyRoots([item(1927, 1906)], known)], [1906]);
  });

  test("a root still on the board needs no read", () => {
    const known = new Map<number, readonly string[]>([[1927, []], [1906, [FAMILY_BREAKER_LABEL]]]);
    assert.deepEqual([...collectOffBoardFamilyRoots([item(1927, 1906)], known)], []);
  });

  test("a ticket with no parent is its own root — its labels are already in hand", () => {
    assert.deepEqual([...collectOffBoardFamilyRoots([item(1958)], new Map())], []);
  });

  test("a grandchild resolves to the grandparent, not the parent", () => {
    assert.deepEqual([...collectOffBoardFamilyRoots([item(42, 41, 40)], new Map())], [40]);
  });

  test("siblings of one off-board root collapse to a single read", () => {
    const siblings = [item(1927, 1906), item(1928, 1906), item(1907, 1906)];
    assert.deepEqual([...collectOffBoardFamilyRoots(siblings, new Map())], [1906]);
  });

  test("a board of unsplit tickets costs nothing", () => {
    const flat = [item(10), item(11), item(12)];
    assert.equal(collectOffBoardFamilyRoots(flat, new Map()).size, 0);
  });
});

describe("selectDispatches — excludedRoots breaks the starvation loop", () => {
  const POLL_ORDER = [...AGENTS].reverse();
  const child = (n: number, root: number) =>
    ({ id: `item-${n}`, issueNumber: n, labels: [], blockedBy: [], parentNumber: root, grandparentNumber: null });
  const loner = (n: number) =>
    ({ id: `item-${n}`, issueNumber: n, labels: [], blockedBy: [], parentNumber: null, grandparentNumber: null });

  test("an excluded root's descendants stop consuming the concurrency budget", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [child(1927, 1906), child(1928, 1906), loner(1958)]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 1,
      excludedRoots: new Set([1906]),
    });
    assert.deepEqual(r.map(c => c.item.issueNumber), [1958]);
  });

  test("an empty set behaves exactly as no set at all", () => {
    const items = new Map([["Backlog", [child(1927, 1906), loner(1958)]]]);
    const withEmpty = selectDispatches({ itemsByColumn: items, pollOrder: POLL_ORDER, maxConcurrent: 1, excludedRoots: new Set() });
    const without = selectDispatches({ itemsByColumn: items, pollOrder: POLL_ORDER, maxConcurrent: 1 });
    assert.deepEqual(withEmpty.map(c => c.item.issueNumber), without.map(c => c.item.issueNumber));
    assert.deepEqual(without.map(c => c.item.issueNumber), [1927]);
  });

  test("exclusion is by family, not by ticket — a sibling of the excluded ticket is excluded too", () => {
    const r = selectDispatches({
      itemsByColumn: new Map([["Backlog", [child(1928, 1906), loner(1958)]]]),
      pollOrder: POLL_ORDER,
      maxConcurrent: 2,
      excludedRoots: new Set([1906]),
    });
    assert.deepEqual(r.map(c => c.item.issueNumber), [1958]);
  });
});

// =====================================================================
// Pending-done: a deferred post-run decision (2026-09-22)
// =====================================================================

describe("decidePendingDoneFinalizations", () => {
  const cols = new Map([["refiner", "Backlog"], ["builder", "In Development"], ["verifier", "In Code Review"]]);

  test("still in the agent's column → ready: done:<agent> added, prior done:* stripped, own kept out of the strip", () => {
    const [f, ...rest] = decidePendingDoneFinalizations(
      [{ issueNumber: 803, status: "In Development", labels: ["enhancement", "done:refiner", "pending-done:builder"] }],
      cols,
    );
    assert.equal(rest.length, 0);
    assert.equal(f!.agentName, "builder");
    assert.equal(f!.pendingLabel, "pending-done:builder");
    assert.equal(f!.addReadyLabel, true);
    assert.deepEqual(f!.priorReadyLabelsToStrip, ["done:refiner"]);
    assert.equal(f!.logKind, "ready");
  });

  test("moved out of the agent's column → no done label, only the pending label goes", () => {
    const [f] = decidePendingDoneFinalizations(
      [{ issueNumber: 900, status: "Inbox", labels: ["pending-done:refiner", "done:po"] }],
      cols,
    );
    assert.equal(f!.addReadyLabel, false);
    assert.deepEqual(f!.priorReadyLabelsToStrip, []);
    assert.equal(f!.logKind, "moved-out");
  });

  test("a rework label wins → no done label; routing is left to runReworkRouting", () => {
    const [f] = decidePendingDoneFinalizations(
      [{ issueNumber: 901, status: "In Development", labels: ["pending-done:builder", "needs-rework:refiner"] }],
      cols,
    );
    assert.equal(f!.addReadyLabel, false);
    assert.equal(f!.logKind, "rework");
  });

  test("no pending label, or one for an agent the stage set does not know → nothing to do", () => {
    assert.deepEqual(decidePendingDoneFinalizations(
      [
        { issueNumber: 1, status: "In Development", labels: ["done:builder"] },
        { issueNumber: 2, status: "In Development", labels: ["pending-done:architect"] },
      ],
      cols,
    ), []);
  });

  test("the pending label blocks re-dispatch of that agent only", () => {
    assert.equal(shouldSkipDispatch([`${PENDING_DONE_PREFIX}builder`], "builder"), true);
    assert.equal(shouldSkipDispatch([`${PENDING_DONE_PREFIX}builder`], "verifier"), false);
  });
});

describe("idle-stream watchdog — claude runner (pyrycode-mobile #1430, 2026-10-02)", () => {
  const MIN = 60_000;
  const T0 = 1_000_000;
  const toolUse = (id: string) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "./gradlew test" } }] },
  });
  const toolResult = (id: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "BUILD SUCCESSFUL" }] },
  });
  const thinking = { type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }] } };
  const system = { type: "system", subtype: "init", session_id: "s" };

  test("fires after N minutes of silence with no tool outstanding", () => {
    let s = initIdleWatchdogState(T0);
    s = advanceIdleWatchdogState(s, system, T0);
    s = advanceIdleWatchdogState(s, toolUse("t1"), T0 + 1000);
    s = advanceIdleWatchdogState(s, toolResult("t1"), T0 + 2000);
    // #1430's shape: a thinking block arrives, then the turn wedges.
    s = advanceIdleWatchdogState(s, thinking, T0 + 3000);
    assert.equal(shouldFireIdleWatchdog(s, T0 + 3000 + 10 * MIN - 1, 10 * MIN), false, "just under N");
    assert.equal(shouldFireIdleWatchdog(s, T0 + 3000 + 10 * MIN, 10 * MIN), true, "at N");
  });

  test("does not fire while a tool call is outstanding, however long the silence", () => {
    let s = initIdleWatchdogState(T0);
    s = advanceIdleWatchdogState(s, toolUse("gradle"), T0);
    assert.equal(shouldFireIdleWatchdog(s, T0 + 60 * MIN, 10 * MIN), false);
    // The result comes back: the clock restarts from that line.
    s = advanceIdleWatchdogState(s, toolResult("gradle"), T0 + 30 * MIN);
    assert.equal(shouldFireIdleWatchdog(s, T0 + 39 * MIN, 10 * MIN), false);
    assert.equal(shouldFireIdleWatchdog(s, T0 + 40 * MIN, 10 * MIN), true);
  });

  test("parallel tool calls: stays quiet until every one has returned", () => {
    let s = initIdleWatchdogState(T0);
    s = advanceIdleWatchdogState(s, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }] },
    }, T0);
    s = advanceIdleWatchdogState(s, toolResult("a"), T0 + 1000);
    assert.equal(shouldFireIdleWatchdog(s, T0 + 30 * MIN, 10 * MIN), false, "b still running");
    s = advanceIdleWatchdogState(s, toolResult("b"), T0 + 2000);
    assert.equal(shouldFireIdleWatchdog(s, T0 + 2000 + 10 * MIN, 10 * MIN), true);
  });

  test("a result for an id it never saw does not open or close anything", () => {
    let s = initIdleWatchdogState(T0);
    s = advanceIdleWatchdogState(s, toolResult("unknown"), T0);
    assert.equal(s.outstandingToolIds.size, 0);
  });

  test("resets on any stream line: system notices, text, and lines that do not parse", () => {
    let s = initIdleWatchdogState(T0);
    for (const [msg, at] of [[system, 9 * MIN], [null, 18 * MIN], [{ type: "rate_limit_event" }, 27 * MIN]] as const) {
      s = advanceIdleWatchdogState(s, msg, T0 + at);
      assert.equal(shouldFireIdleWatchdog(s, T0 + at + 9 * MIN, 10 * MIN), false);
    }
    assert.equal(shouldFireIdleWatchdog(s, T0 + 37 * MIN, 10 * MIN), true);
  });

  test("advancing never mutates the previous state", () => {
    const before = initIdleWatchdogState(T0);
    const after = advanceIdleWatchdogState(before, toolUse("t1"), T0 + 5);
    assert.equal(before.outstandingToolIds.size, 0);
    assert.equal(before.lastLineAt, T0);
    assert.equal(after.outstandingToolIds.size, 1);
  });

  test("disabled at 0: never fires", () => {
    const s = initIdleWatchdogState(T0);
    assert.equal(shouldFireIdleWatchdog(s, T0 + 24 * 60 * MIN, 0), false);
  });

  test("PYRY_AGENT_IDLE_TIMEOUT_MINUTES: default 10, 0 disables, garbage keeps the default", () => {
    assert.equal(DEFAULT_IDLE_TIMEOUT_MINUTES, 10);
    assert.equal(parseIdleTimeoutMs(undefined), 10 * MIN);
    assert.equal(parseIdleTimeoutMs(""), 10 * MIN);
    assert.equal(parseIdleTimeoutMs("0"), 0);
    assert.equal(parseIdleTimeoutMs("15"), 15 * MIN);
    assert.equal(parseIdleTimeoutMs("0.5"), 30_000);
    assert.equal(parseIdleTimeoutMs("-1"), 0);
    assert.equal(parseIdleTimeoutMs("ten"), 10 * MIN);
  });

  test("the poll tick is a tenth of the threshold, clamped to 1s..30s", () => {
    assert.equal(idleWatchdogTickMs(10 * MIN), 30_000);
    assert.equal(idleWatchdogTickMs(2 * MIN), 12_000);
    assert.equal(idleWatchdogTickMs(600), 1_000);
  });

  test("the stall error is classified transient, so the dispatcher retries with backoff", () => {
    const msg = idleStallMessage(10 * MIN);
    assert.match(msg, /idle_stall/);
    assert.match(msg, /10min/);
    const r = classifyAgentError(msg);
    assert.equal(r.transient, true);
    assert.equal(r.signature, "idle stream stall");
    // The result-frame door: handleAgentResultErrors names the reason.
    assert.equal(classifyAgentError("Agent error (idle_stall): subtype=error_during_execution. Ran 15m 2s (timeout 25min).", { terminalReason: "idle_stall" }).transient, true);
  });
});

describe("partial-work salvage decisions (mobile #1430, #1332)", () => {
  const result = (over: Partial<{ isError: boolean; timedOut: boolean; terminalReason: string; hadPermissionDenial: boolean }> = {}) => ({
    isError: true, timedOut: false, terminalReason: "", hadPermissionDenial: false, ...over,
  });

  test("runStopKind reads both doors: the runner's rejection and a marked result frame", () => {
    assert.equal(runStopKind(new AgentRunStoppedError("Agent timed out after 2280s", "timeout"), null), "timeout");
    assert.equal(runStopKind(new AgentRunStoppedError("Agent idle_stall: ...", "idle_stall"), null), "idle_stall");
    assert.equal(runStopKind(new Error("Agent error ()"), result({ timedOut: true })), "timeout");
    assert.equal(runStopKind(new Error("Agent error (idle_stall)"), result({ terminalReason: "idle_stall" })), "idle_stall");
  });

  test("runStopKind: anything else is not a stop", () => {
    assert.equal(runStopKind(new Error("Claude CLI exited with code 1, no result message received"), null), null);
    assert.equal(runStopKind(new Error("x"), result({ terminalReason: "max_turns" })), null);
    assert.equal(runStopKind(new Error("x"), result({ isError: false, timedOut: true })), null, "a success that landed after the kill");
    assert.equal(runStopKind(new Error("x"), result({ timedOut: true, hadPermissionDenial: true })), null, "a denial is a policy stop");
    assert.equal(runStopKind(new Error("x"), result({ timedOut: true, terminalReason: "codex_blocked" })), null, "never work around a rejected action");
  });

  test("canSalvagePartialWork: only stages that own commits, in a worktree, on a real ticket", () => {
    const base = { stopKind: "timeout" as const, useWorktree: true, issueNumber: 1430 };
    for (const name of ["architect", "developer", "documentation"]) {
      assert.equal(canSalvagePartialWork({ ...base, agent: AGENTS.find(a => a.name === name)! }), true, name);
    }
    for (const name of ["po", "qa", "code-review"]) {
      assert.equal(canSalvagePartialWork({ ...base, agent: AGENTS.find(a => a.name === name)! }), false, name);
    }
    const dev = AGENTS.find(a => a.name === "developer")!;
    assert.equal(canSalvagePartialWork({ ...base, stopKind: null, agent: dev }), false);
    assert.equal(canSalvagePartialWork({ ...base, useWorktree: false, agent: dev }), false);
    assert.equal(canSalvagePartialWork({ ...base, issueNumber: 0, agent: dev }), false);
  });

  const ok = { openPrCount: 1, gitStatusOutput: " M a.md\n", commitsAheadOfOrigin: 0, mergeInProgress: false, mergeCheckProblems: [] as string[] };

  test("decidePartialWorkSalvage: PR + dirty tree, or PR + local commits → salvage", () => {
    assert.deepEqual(decidePartialWorkSalvage(ok), { salvage: true });
    assert.deepEqual(decidePartialWorkSalvage({ ...ok, gitStatusOutput: "", commitsAheadOfOrigin: 2 }), { salvage: true });
  });

  test("decidePartialWorkSalvage: each gate refuses on its own", () => {
    const refused = (over: Partial<typeof ok>, why: RegExp) => {
      const d = decidePartialWorkSalvage({ ...ok, ...over });
      assert.equal(d.salvage, false);
      assert.match((d as { reason: string }).reason, why);
    };
    refused({ openPrCount: 0 }, /no open pull request/);
    refused({ openPrCount: -1 }, /could not look up/);
    refused({ mergeInProgress: true }, /MERGE_HEAD/);
    refused({ mergeCheckProblems: ["`a.kt` still has conflict markers."] }, /conflict markers/);
    refused({ gitStatusOutput: "", commitsAheadOfOrigin: 0 }, /nothing to save/);
    refused({ gitStatusOutput: "  \n", commitsAheadOfOrigin: -1 }, /nothing to save/);
  });
});

describe("runner stderr: tail, scrub and message (pyrycode-mobile #1340, 2026-10-02)", () => {
  // Built at runtime so no literal credential-shaped string sits in the repo.
  const anthropic = "sk-ant-api03-" + "a1B2".repeat(20);
  const oauth = "sk-ant-oat01-" + "Q".repeat(60);
  const ghp = "ghp_" + "x".repeat(36);
  const gho = "gho_" + "y".repeat(36);
  const pat = "github_pat_" + "11ABCDEFG0" + "z".repeat(60);
  const b64 = "dGhpcyBpcyBhIHZlcnkgbG9uZyBzZWNyZXQgdmFsdWU=";

  test("appendStderrTail keeps only the last cap characters", () => {
    let tail = "";
    for (let i = 0; i < 100; i++) tail = appendStderrTail(tail, `line ${i}\n`.padEnd(100, "."));
    assert.equal(tail.length, STDERR_TAIL_CAP);
    assert.ok(tail.endsWith(`line 99\n`.padEnd(100, ".")));
    assert.equal(appendStderrTail("abc", "def", 4), "cdef");
  });

  test("scrubCredentials blanks every credential shape named in the ticket", () => {
    const cases: [string, string][] = [
      [`ANTHROPIC_API_KEY used: ${anthropic}`, anthropic],
      [`oauth ${oauth} expired`, oauth],
      [`Authorization: Bearer ${b64}`, b64],
      [`remote: ${ghp} rejected`, ghp],
      [`token ${gho}`, gho],
      [`fine-grained ${pat}`, pat],
      [`GET /v1?token=${b64}&x=1`, b64],
      [`api_key=${b64}`, b64],
      [`CLAUDE_CODE_OAUTH_TOKEN=${b64}`, b64],
      [`{"secret_key": "${b64}"}`, b64],
      [`fatal: https://x-access-token:hunter2hunter2@github.com/o/r.git`, "hunter2hunter2"],
    ];
    for (const [text, secret] of cases) {
      const out = scrubCredentials(text);
      assert.ok(!out.includes(secret), `secret survived in: ${out}`);
      assert.match(out, /\[REDACTED\]/, text);
    }
  });

  test("scrubCredentials leaves ordinary diagnostics alone", () => {
    const text = [
      "Error: ECONNRESET reading response body",
      "API Error: 529 overloaded_error",
      "at Object.<anonymous> (/opt/claude/cli.js:12:34)",
      "key=short token=abc",
      "the monkey ran",
    ].join("\n");
    assert.equal(scrubCredentials(text), text);
  });

  test("stderrForMessage: scrubbed, last 1500 chars, cannot close the comment's code block", () => {
    const long = "x".repeat(3000) + `\nfinal error ${anthropic}\n\`\`\`\nnot a fence`;
    const out = stderrForMessage(long);
    assert.ok(out.length <= STDERR_MESSAGE_CHARS);
    assert.match(out, /final error sk-ant-\[REDACTED\]/);
    assert.ok(!out.includes("```"), "a triple backtick would end the ticket comment's code block");
    assert.equal(stderrForMessage("  \n"), "");
  });

  test("noResultErrorMessage appends the scrubbed tail, and nothing when stderr was empty", () => {
    assert.equal(noResultErrorMessage(1, ""), "Claude CLI exited with code 1, no result message received");
    const msg = noResultErrorMessage(1, `Error: stream closed\nAuthorization: Bearer ${b64}\n`);
    assert.match(msg, /^Claude CLI exited with code 1, no result message received\n--- stderr \(last 1500 chars\) ---\n/);
    assert.match(msg, /Error: stream closed/);
    assert.ok(!msg.includes(b64));
  });
});
