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

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { dispatchInbox, pollLoop } from "./dispatch.js";
import { findMissingAgentClaudeMds } from "./agent-runtime.js";
import { AGENTS } from "./types.js";
import { resolveAgentsRepoRootWithEnv } from "./worktree.js";

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
  agents: AGENTS,
  agentsRepoRoot,
  existsSync,
});
if (missingClaudeMds.length > 0) {
  console.error(`Missing per-agent CLAUDE.md files in ${agentsRepoRoot}:`);
  for (const m of missingClaudeMds) {
    console.error(`  ${m.name}: ${m.path}`);
  }
  console.error(`Restore the prompts (or fix the AGENTS config paths) before restarting the dispatcher.`);
  process.exit(1);
}

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
