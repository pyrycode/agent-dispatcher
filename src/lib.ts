// Barrel module — re-exports from the split lib files.
//
// Pre-2026-05-09 lib.ts was 1381 LOC of pure helpers. Split along
// section dividers into 5 files (pipeline-decisions, agent-runtime,
// worktree, blockers, dispatch-selection) with this barrel preserving
// the `import { ... } from "./lib.js"` interface for dispatch.ts and
// the test files.
//
// One-cycle compatibility shim: external code still imports from "./lib.js".
// Internal cross-file imports (pipeline-decisions → blockers,
// dispatch-selection → pipeline-decisions + blockers) go file-to-file
// directly to avoid the barrel circularity risk.
//
// New code: prefer importing from the specific module by name. Re-evaluate
// keeping this barrel after one upstream-sync cycle through the forks.

export * from "./pipeline-decisions.js";
export * from "./agent-runtime.js";
export * from "./worktree.js";
export * from "./blockers.js";
export * from "./dispatch-selection.js";
