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

import { dispatchInbox, pollLoop } from "./dispatch.js";

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
