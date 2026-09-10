// Pyrycode dispatcher entry point.
//
// All CLI argv parsing + env-var validation + entry-point dispatch
// lives here. dispatch.ts is a library module — its functions
// (phase orchestrator, pollLoop, dispatchInbox) are called from this
// file but never run as a side effect of `import`.
//
// Why a separate file: 2026-05-09 a test process (`tsx --test
// src/*.test.ts`) accidentally became a real dispatcher because
// dispatch.ts had bottom-of-file entry-point code that fell through
// for any argv shape. Within ~10s the test polled GitHub, attempted
// to auto-merge a conflicted PR, and re-applied error labels to the
// live project. The inline `__isMain` gate fix worked but coupled
// "is this main?" to dispatch.ts itself; this structural split makes
// the entry/library boundary file-level so the failure mode can't
// recur even under a future refactor that misses the gate. See
// `📋 Projects/2026-04-10 - Pyrycode/Lessons.md` for the full lesson.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dispatchInbox, installSignalHandlers, pollLoop } from "./dispatch.js";
import { decideCodegraphHealth, findMissingAgentClaudeMds } from "./agent-runtime.js";
import { resolveAgentRunner } from "./agent-runner.js";
import { activeStageSet, type StageSet } from "./stage-sets.js";
import { resolveAgentsRepoRootWithEnv, resolveTargetRepoRoot } from "./worktree.js";

// Validate required environment variables. dispatch.ts loads .env at
// module top-level (via dotenv.config), so by the time this file runs,
// process.env reflects the .env contents. Validation here means
// library callers (tests, sibling modules) can `import` from
// dispatch.ts without GITHUB_TOKEN set.
const REQUIRED_ENV = ["GITHUB_OWNER", "GITHUB_REPO", "PROJECT_NUMBER", "GITHUB_TOKEN"] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}. Check .env file.`);
    process.exit(1);
  }
}
if (isNaN(parseInt(process.env.PROJECT_NUMBER!, 10))) {
  console.error(`PROJECT_NUMBER must be a number, got: "${process.env.PROJECT_NUMBER}"`);
  process.exit(1);
}

// Resolve the stage set once for the process (PYRY_STAGE_SET; the fork's
// .env is already loaded by dispatch.ts's module body, which ESM evaluates
// before this file's body runs). An unknown value fails fast HERE, with
// the valid names, before any pre-flight or polling — a typo'd stage set
// must never silently run the wrong pipeline. Every later consumer (poll
// loop, spawn prep, reconciliation) reads the same memoized instance.
let stageSet: StageSet;
try {
  stageSet = activeStageSet();
  resolveAgentRunner(process.env);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

// Pre-flight: each agent's CLAUDE.md exists in the consumer's agents
// repo. Catches typo'd paths, accidental `git rm`, fresh forks that
// haven't created the prompts yet — at startup, before pollLoop can
// dispatch anything. Today's runtime "agent CLAUDE.md not found" error
// in dispatch.ts still catches the same gap at dispatch time, but
// hours into a session is too late. Reports all gaps in one shot.
//
// agentsRepoRoot resolution mirrors dispatch.ts's module-top logic —
// re-resolved here rather than imported to keep this validation a
// pure pre-flight that could in principle move out of dispatch-bin.ts
// (e.g. into a CLI subcommand `pyry preflight`).
const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsRepoRoot = resolveAgentsRepoRootWithEnv({
  envValue: process.env.AGENTS_REPO_PATH,
  fallbackSrcDir: __dirname,
});
const missingClaudeMds = findMissingAgentClaudeMds({
  agents: stageSet.agents,
  agentsRepoRoot,
  existsSync,
});
if (missingClaudeMds.length > 0) {
  console.error(`Missing per-agent CLAUDE.md files in ${agentsRepoRoot}:`);
  for (const m of missingClaudeMds) {
    console.error(`  ${m.name}: ${m.path}`);
  }
  console.error(`Restore the prompts (or fix the "${stageSet.name}" stage set's config paths) before restarting the dispatcher.`);
  process.exit(1);
}

// Pre-flight: codegraph index queryability at the canonical path.
// Surfaces broken self-ref symlinks, schema mismatches, missing
// installs, db corruption — all the states where existsSync says
// "yes" but `codegraph status` disagrees. Logs the result; doesn't
// fail-fast (codegraph isn't load-bearing — agents fall through to
// grep when it's degraded).
//
// targetRepoRoot resolution mirrors dispatch.ts's module-top logic.
// Re-resolved here rather than imported to keep this validation a
// pure pre-flight that doesn't depend on dispatch.ts internals.
const targetRepoRoot = process.env.TARGET_REPO_PATH
  ? resolve(process.env.TARGET_REPO_PATH)
  : resolveTargetRepoRoot(agentsRepoRoot);
const codegraphPath = resolve(targetRepoRoot, ".codegraph");
const codegraphExists = existsSync(codegraphPath);
const cgStatus = codegraphExists
  ? spawnSync("codegraph", ["status", targetRepoRoot], { encoding: "utf-8", timeout: 10_000 })
  : null;
const cgHealth = decideCodegraphHealth({
  exists: codegraphExists,
  statusExitCode: cgStatus ? cgStatus.status : null,
  statusStdout: cgStatus?.stdout ?? "",
  statusStderr: cgStatus?.stderr ?? "",
});
if (cgHealth.state === "queryable") {
  console.log(`✓ codegraph: ${codegraphPath} indexed and queryable`);
} else if (cgHealth.state === "missing") {
  console.warn(`⚠️  codegraph: no index at ${codegraphPath} — agents fall through to grep. Bootstrap with \`cd ${targetRepoRoot} && codegraph init -i\`.`);
} else {
  // broken
  console.warn(`⚠️  codegraph: ${codegraphPath} exists but isn't queryable.`);
  console.warn(`    Detail: ${cgHealth.detail.slice(0, 500)}`);
  console.warn(`    Fix: \`rm ${codegraphPath} && cd ${targetRepoRoot} && codegraph init -i\` (or investigate why status fails — broken symlink, schema mismatch, db corruption, codegraph CLI not on PATH).`);
}

// Signal handlers are intentionally installed HERE rather than at
// dispatch.ts module load — test imports of dispatch.ts must not
// register SIGINT/SIGHUP handlers that would `process.exit` the test
// runner on signal delivery. See `installSignalHandlers` docstring.
installSignalHandlers();

// Entry-point dispatch.
const args = process.argv.slice(2);

if (args[0] === "inbox" && args[1]) {
  dispatchInbox(args.slice(1).join(" ")).catch((e) => {
    console.error("Fatal error in inbox dispatch:", e);
    process.exit(1);
  });
} else if (args[0] === "po" && args[1]) {
  // Backwards-compat shim: old `pnpm start po "..."` now delegates to
  // dispatchInbox with a deprecation notice. PO no longer runs on raw
  // requests — it only refines triaged Backlog tickets.
  console.warn("⚠️  `pnpm start po` is deprecated. Use `pnpm start inbox` instead.");
  console.warn("    PO no longer creates tickets from raw requests; tickets land in Inbox");
  console.warn("    and are promoted to Backlog manually when ready for PO to refine.\n");
  dispatchInbox(args.slice(1).join(" ")).catch((e) => {
    console.error("Fatal error in inbox dispatch:", e);
    process.exit(1);
  });
} else {
  pollLoop().catch((e) => {
    console.error("Fatal error in poll loop:", e);
    process.exit(1);
  });
}
