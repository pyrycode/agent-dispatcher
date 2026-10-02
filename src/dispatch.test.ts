// Integration tests for the dispatcher's six extracted phase functions
// plus the orchestrator wiring. The pure-function decompositions in
// `lib.test.ts` cover the decisions; this file covers the IO-bearing
// glue around them — error labels on push failure, empty-branch guard,
// salvage routing, branch setup matrix, worktree cleanup invariants.
//
// Architecture: `DispatchDeps` (in dispatch.ts) lets tests swap every
// fs/child_process/helper call. `makeMockDeps` returns a deps object
// plus a `calls` log for assertions. `MockGitHubClient` mirrors the
// `MockClient` pattern from `reconcile.test.ts`, extended for the
// `addLabel` / `removeLabel` / `addComment` / `getIssueLabels` /
// `getItemStatus` surface dispatch.ts uses.
//
// **Why DI vs `mock.module()`:** the deps shape is small (10 fields),
// production wiring stays close to today (one destructure line per
// phase), and tests can construct exactly the failure mode they want
// (push-fail, gh-list-fail, merge-conflict) by swapping individual
// handlers — much cheaper than module-level mocks under tsx's loader.
//
// Coverage scope follows the plan in this session's PR — Tier B
// (known production failure modes + happy paths + decision branches).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildModeSection,
  selectUnansweredGateFailure,
  cleanupAfterDispatch,
  countActiveWork,
  decideDrainNotification,
  decideRefinementMode,
  decideSigint,
  dispatchToAgent,
  handleAgentResultErrors,
  handleDispatchError,
  handlePostRun,
  makeDispatchContext,
  maybeCurateMemory,
  maybeResumeExhaustedRun,
  prepareAgentSpawn,
  runAutoMerge,
  runParentClose,
  runClosedSweep,
  runConcurrentDispatches,
  runDoneCleanup,
  runStrandedWipSweep,
  runPendingDoneFinalize,
  salvagePartialWork,
  strandedWipMinAgeMs,
  runFamilyBreaker,
  selectPastParkedFamilies,
  runPreDispatchPrep,
  setupBranchAndWorktree,
  SIGINT_DEBOUNCE_MS,
  SIGINT_FORCE_EXIT_WINDOW_MS,
  type DispatchClient,
  type DispatchContext,
  type DispatchDeps,
  type SigintState,
  buildGateSpawnEnv,
  runRealClaudeGateSuite,
  clearGateWorktreePath,
  worktreePath,
  spawnGateCommand,
  maybeRunPreSpawnGates,
  runVerifierGates,
  VERIFIER_GATE_TAIL_CAP,
  VERIFIER_GATE_TIMEOUT_MS,
  type GateRunnerDeps,
  type GateSpawnOutcome,
  type GateSpawnRequest,
  type StreamResult,
} from "./dispatch.js";
import { formatGateEvidenceComment } from "./gate-output.js";
import { resetActiveStageSetForTests, resolveStageSet } from "./stage-sets.js";
import type { AgentConfig, BlockerInfo, ProjectItem } from "./types.js";
import {
  decideReworkRoutes,
  FAMILY_BREAKER_COMMENT_MARKER,
  FAMILY_BREAKER_LABEL,
  FAMILY_DISPATCH_COMMENT_MARKER,
  FAMILY_DISPATCH_RESET_MARKER,
  STRANDED_WIP_OBSERVED_MARKER,
  STRANDED_WIP_SWEPT_MARKER,
  tallyFamilyComments,
} from "./pipeline-decisions.js";
import { AGENTS } from "./types.js";
import { AgentRunStoppedError, idleStallMessage, ResourceExhaustedError, timeoutFor } from "./agent-runtime.js";
import { resolveAgentsRepoRoot, resolveTargetRepoRoot } from "./worktree.js";

// Importing dispatch.ts loads the fork's .env, so a fork running this suite
// from its installed copy (bin/pyry-test) handed the tests its own stage set
// and budget scale. Mobile's builder set and 1.5 scale failed nine tests on
// 2026-09-23. The suite runs on the defaults; tests that care pin their own
// with withStageSet or by setting the variable.
delete process.env.PYRY_STAGE_SET;
delete process.env.PYRY_BUDGET_SCALE;
delete process.env.PYRY_EFFORT_POLICY;
delete process.env.PYRY_VERIFIER_PARALLEL_REVIEW;
resetActiveStageSetForTests();

// Recompute agentsRepoRoot the same way dispatch.ts does so test
// fsMaps can use the absolute paths the production code resolves.
const TEST_AGENTS_REPO_ROOT = resolveAgentsRepoRoot(dirname(fileURLToPath(import.meta.url)));
// Mirror dispatch.ts:63's env-precedence pattern so tests can compute
// the same `repoRoot` the production code resolves.
const TEST_REPO_ROOT = process.env.TARGET_REPO_PATH
  ? resolve(process.env.TARGET_REPO_PATH)
  : resolveTargetRepoRoot(TEST_AGENTS_REPO_ROOT);
const TEST_CODEGRAPH_PATH = resolve(TEST_REPO_ROOT, ".codegraph");

// --------- Call log (assertion surface) ---------

/**
 * Every IO call the phase functions made during one test. Tests assert
 * shape against this — "did execSync receive `git push`?", "how many
 * times was addLabel called?", etc. Recording is structural; tests
 * decide whether to assert on order, count, or contents.
 */
export type CallLog = {
  exec: { cmd: string; opts?: any }[];
  spawn: { cmd: string; args: string[]; opts?: any; input?: string }[];
  fs: { kind: "exists" | "read" | "write" | "mkdir" | "symlink"; path: string; content?: string; target?: string }[];
  client: { method: string; args: any[] }[];
  discord: string[];
  /** Count of `runClaudeStreaming` invocations (not the streamed output). */
  claudeStreams: number;
  /** Every `deps.spawnGate` request (pre-verifier deterministic gates). */
  gates: GateSpawnRequest[];
  /** `writeLog` sections captured through the deps seam. Nothing may land
   *  on the real filesystem: see the log-write containment suite. */
  logs: { logFile: string; section: string; content: string }[];
};

function emptyCallLog(): CallLog {
  return {
    exec: [],
    spawn: [],
    fs: [],
    client: [],
    discord: [],
    claudeStreams: 0,
    gates: [],
    logs: [],
  };
}

// --------- Mock deps ---------

/**
 * Per-pattern handler for `execSync` — pattern is matched as a substring
 * of the command. Return string (success) or Error (throw). The Error
 * may carry `status`/`stdout`/`stderr` properties for code paths that
 * read them off `e.stderr`/`e.status`.
 */
export type ExecHandler = (cmd: string) => string | Error;

/**
 * Per-pattern handler for `spawnSync` — match against `[cmd, ...args].join(" ")`.
 * Returns either a status code (0=success) or a partial result with stderr/stdout.
 */
export type SpawnHandler = (cmd: string, args: string[]) => number | { status: number; stderr?: string; stdout?: string };

export type MockDepsOptions = {
  /**
   * Pattern → handler for execSync. First matching pattern wins.
   * Unknown commands return empty string (success). To make a command
   * throw, return an Error from the handler.
   */
  execImpls?: Record<string, ExecHandler>;
  /**
   * Pattern → handler for spawnSync. Same matching as execImpls.
   * Unknown commands return `{ status: 0 }`.
   */
  spawnImpls?: Record<string, SpawnHandler>;
  /**
   * Result `runClaudeStreaming` returns. Three forms:
   *   - Fixed `StreamResult` — every invocation returns the same value.
   *   - `() => StreamResult` — called per invocation, no args.
   *   - `(opts) => StreamResult` — called per invocation with the
   *     SpawnConfig (so concurrent-dispatch tests can branch on
   *     `opts.cwd` to differentiate which dispatch is asking).
   * Defaults to a clean success result.
   */
  streamResult?: StreamResult | ((opts?: any) => StreamResult);
  /**
   * Filesystem fixture. `existsSync(path)` returns true iff path is a
   * key. `readFileSync(path)` returns the value. `writeFileSync` /
   * `mkdirSync` / `symlinkSync` are recorded but not applied to the
   * map (tests assert via `calls.fs`).
   */
  fsMap?: Record<string, string>;
  /**
   * `buildPromptForAgent` mock return. Defaults to a stable string
   * containing the issue number for round-trip assertion if needed.
   */
  buildPromptResult?: string | ((agent: AgentConfig, item: ProjectItem) => string);
  /**
   * Outcome `deps.spawnGate` returns per request (pre-verifier gates).
   * Defaults to a clean pass (`exitCode: 0`). Requests are recorded in
   * `calls.gates` either way.
   */
  gateImpl?: (req: GateSpawnRequest) => GateSpawnOutcome;
};

export function makeMockDeps(opts: MockDepsOptions = {}): { deps: DispatchDeps; calls: CallLog } {
  const calls = emptyCallLog();
  const fsMap = { ...(opts.fsMap ?? {}) };

  const execImpls = opts.execImpls ?? {};
  const spawnImpls = opts.spawnImpls ?? {};

  const findExecHandler = (cmd: string): ExecHandler | undefined => {
    for (const [pattern, handler] of Object.entries(execImpls)) {
      if (cmd.includes(pattern)) return handler;
    }
    return undefined;
  };
  const findSpawnHandler = (cmd: string, args: string[]): SpawnHandler | undefined => {
    const joined = [cmd, ...args].join(" ");
    for (const [pattern, handler] of Object.entries(spawnImpls)) {
      if (joined.includes(pattern)) return handler;
    }
    return undefined;
  };

  const mockExecSync = ((cmd: string, execOpts?: any) => {
    calls.exec.push({ cmd, opts: execOpts });
    const handler = findExecHandler(cmd);
    const result = handler ? handler(cmd) : "";
    if (result instanceof Error) throw result;
    // Mimic real execSync: return string when encoding is set, Buffer otherwise.
    return execOpts?.encoding ? result : Buffer.from(result);
  }) as unknown as typeof import("node:child_process").execSync;

  const mockSpawnSync = ((cmd: string, args: string[], spawnOpts?: any) => {
    calls.spawn.push({ cmd, args, opts: spawnOpts, input: spawnOpts?.input });
    const handler = findSpawnHandler(cmd, args);
    const raw = handler ? handler(cmd, args) : 0;
    const result = typeof raw === "number" ? { status: raw } : raw;
    return {
      status: result.status,
      signal: null,
      pid: 12345,
      output: [null, Buffer.from(result.stdout ?? ""), Buffer.from(result.stderr ?? "")],
      stdout: Buffer.from(result.stdout ?? ""),
      stderr: Buffer.from(result.stderr ?? ""),
    };
  }) as unknown as typeof import("node:child_process").spawnSync;

  const mockExistsSync = ((path: string) => {
    calls.fs.push({ kind: "exists", path: String(path) });
    return Object.prototype.hasOwnProperty.call(fsMap, String(path));
  }) as unknown as typeof import("node:fs").existsSync;

  const mockReadFileSync = ((path: string) => {
    calls.fs.push({ kind: "read", path: String(path) });
    if (!Object.prototype.hasOwnProperty.call(fsMap, String(path))) {
      const e: NodeJS.ErrnoException = Object.assign(
        new Error(`ENOENT: no such file or directory, open '${path}'`),
        { code: "ENOENT", errno: -2 },
      );
      throw e;
    }
    return fsMap[String(path)];
  }) as unknown as typeof import("node:fs").readFileSync;

  const mockWriteFileSync = ((path: string, content: any) => {
    calls.fs.push({ kind: "write", path: String(path), content: String(content) });
  }) as unknown as typeof import("node:fs").writeFileSync;

  const mockMkdirSync = ((path: string) => {
    calls.fs.push({ kind: "mkdir", path: String(path) });
    return undefined;
  }) as unknown as typeof import("node:fs").mkdirSync;

  const mockSymlinkSync = ((target: string, path: string) => {
    calls.fs.push({ kind: "symlink", path: String(path), target: String(target) });
  }) as unknown as typeof import("node:fs").symlinkSync;

  const defaultStream: StreamResult = {
    output: "agent finished cleanly",
    sessionId: "sess-test-001",
    isError: false,
    numTurns: 12,
    totalCostUsd: 0.42,
    durationMs: 8_000,
    usage: { input_tokens: 100, output_tokens: 200 },
    terminalReason: "stop",
    rawResult: {},
    hadPermissionDenial: false,
    stoppedAtDenial: false,
    deniedOpContent: null,
    lastAssistantText: null,
    timedOut: false,
  };
  const streamResolver = opts.streamResult ?? defaultStream;
  const mockRunClaudeStreaming = (async (...args: any[]) => {
    calls.claudeStreams += 1;
    // Pass the SpawnConfig (first arg) to function resolvers so
    // concurrent tests can branch on opts.cwd to differentiate
    // which dispatch is asking. No-arg resolvers stay backward-compatible.
    return typeof streamResolver === "function" ? streamResolver(args[0]) : streamResolver;
  }) as unknown as DispatchDeps["runClaudeStreaming"];

  const mockNotifyDiscord = async (msg: string): Promise<void> => {
    calls.discord.push(msg);
  };

  const mockBuildPromptForAgent = (async (agent: AgentConfig, item: ProjectItem) => {
    if (typeof opts.buildPromptResult === "function") {
      return opts.buildPromptResult(agent, item);
    }
    return opts.buildPromptResult ?? `# Mock prompt for #${item.issueNumber} (${agent.name})`;
  }) as unknown as DispatchDeps["buildPromptForAgent"];

  const mockSpawnGate = (async (req: GateSpawnRequest): Promise<GateSpawnOutcome> => {
    calls.gates.push(req);
    return opts.gateImpl
      ? opts.gateImpl(req)
      : { exitCode: 0, timedOut: false, spawnError: null };
  }) as DispatchDeps["spawnGate"];

  const deps: DispatchDeps = {
    execSync: mockExecSync,
    spawnSync: mockSpawnSync,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    symlinkSync: mockSymlinkSync,
    runClaudeStreaming: mockRunClaudeStreaming,
    notifyDiscord: mockNotifyDiscord,
    buildPromptForAgent: mockBuildPromptForAgent,
    writeLog: (logFile, section, content) => {
      calls.logs.push({ logFile: String(logFile), section, content: String(content) });
    },
    curateMemoryIndex: async () => ({ ok: true }),
    spawnGate: mockSpawnGate,
  };

  return { deps, calls };
}

/**
 * Construct an `execSync`-style error with `status`/`stderr`/`stdout`
 * properties so failure-path code (`e?.stderr?.toString()`,
 * `e?.status`) sees the expected shape.
 */
export function execError(opts: { message?: string; status?: number; stderr?: string; stdout?: string }): Error {
  const e = new Error(opts.message ?? "Command failed");
  Object.assign(e, {
    status: opts.status ?? 1,
    stderr: Buffer.from(opts.stderr ?? ""),
    stdout: Buffer.from(opts.stdout ?? ""),
  });
  return e;
}

// --------- Mock GitHub client ---------

/**
 * In-memory `DispatchClient` for tests. Records every method call
 * AND maintains an items map so subsequent reads see the writes.
 *
 * `addLabel`/`removeLabel` mutate `labelsByIssue`; `getIssueLabels`
 * reads it. `addComment` is recorded but doesn't synthesize state.
 * `getItemStatus` reads a configurable `statusByIssue` map (and
 * defaults to `defaultStatus` when an issue is missing — most tests
 * don't care about column moves).
 *
 * Failure injection: set `failures.<method>` to an Error to make that
 * method throw. The `addLabel` failure has the "salvage cannot proceed
 * safely" coverage path; the `addComment` failure surfaces in the
 * dispatcher's error-path silent catch.
 */
export class MockGitHubClient implements DispatchClient {
  labelsByIssue: Map<number, string[]>;
  statusByIssue: Map<number, string | null>;
  /** Per-issueNumber backing for `getItemsByStatus` /
   *  `getClosedItemsNotInDone` / `updateItemStatus`. Each entry
   *  models one ProjectItem row on the board. Tests set this up
   *  via the `items` constructor option. */
  itemsByIssueNumber: Map<number, ProjectItem & { state: "OPEN" | "CLOSED" }>;
  defaultStatus: string | null;
  comments: { issueNumber: number; body: string; postedAt: Date }[] = [];
  addLabelCalls: { issueNumber: number; label: string }[] = [];
  removeLabelCalls: { issueNumber: number; label: string }[] = [];
  /**
   * Unified add/remove call log in chronological push order, used by
   * tests that need to assert ordering across both methods (e.g. the
   * strip-before-add contract in handlePostRun's prior-ready strip).
   * Per-method arrays above are still populated; this is additive.
   */
  labelOps: Array<{ op: "add" | "remove"; issueNumber: number; label: string }> = [];
  getItemStatusCalls: { issueNumber: number; forceRefresh: boolean | undefined }[] = [];
  getIssueLabelsCalls: number[] = [];
  getOpenBlockersCalls: number[] = [];
  getItemsByStatusCalls: string[] = [];
  getClosedItemsNotInDoneCalls = 0;
  updateItemStatusCalls: { itemId: string; newStatus: string }[] = [];
  closeIssueCalls: number[] = [];
  getLatestRetryAtCalls: number[] = [];
  retryAtByIssue: Map<number, Date | null> = new Map();
  /** Pre-seeded family tallies for `getFamilyDispatchState` — markers
   *  that existed on the root before this cycle. Comments posted through
   *  THIS client during the test are counted on top (durable-comment
   *  semantics, mirrors FakeClient.countRetryMarkers). */
  familyStateByIssue: Map<number, { markerCount: number; breakerCommented: boolean }> = new Map();
  getFamilyDispatchStateCalls: number[] = [];
  /** Pre-seeded stranded-wip marker times — markers that existed on the
   *  ticket before this test's writes. Comments posted through THIS client
   *  during the test override them, so a sweep's own mark is visible to the
   *  next sweep (same durable-comment semantics as the family tally). */
  strandedWipMarkersByIssue: Map<number, { observedAt: Date | null; sweptAt: Date | null }> = new Map();
  getStrandedWipMarkersCalls: number[] = [];
  getAllProjectItemsCalls = 0;
  clearItemsCacheCalls = 0;
  /** Clock stamped onto comments posted through this client. Overridable so
   *  a test can post a marker and then have it read back as old. */
  commentClock: () => Date = () => new Date();
  failures: {
    addLabel?: Error | ((issueNumber: number, label: string) => Error | null);
    removeLabel?: Error | ((issueNumber: number, label: string) => Error | null);
    addComment?: Error;
    getIssueLabels?: Error;
    getOpenBlockers?: Error;
    getItemStatus?: Error;
    getItemsByStatus?: Error;
    getClosedItemsNotInDone?: Error;
    updateItemStatus?: Error | ((itemId: string, newStatus: string) => Error | null);
    getLatestRetryAt?: Error;
    getFamilyDispatchState?: Error;
    getAllProjectItems?: Error;
    getStrandedWipMarkers?: Error | ((issueNumber: number) => Error | null);
    closeIssue?: Error | ((issueNumber: number) => Error | null);
  } = {};

  constructor(opts: {
    labels?: Record<number, string[]>;
    status?: Record<number, string | null>;
    defaultStatus?: string | null;
    /** Optional ProjectItem rows for tests that exercise
     *  `getItemsByStatus` / `getClosedItemsNotInDone`. Each row carries
     *  its own state (OPEN/CLOSED) — closed-sweep filters by it. */
    items?: Array<Partial<ProjectItem> & { issueNumber: number; status?: string; state?: "OPEN" | "CLOSED" }>;
  } = {}) {
    this.labelsByIssue = new Map(Object.entries(opts.labels ?? {}).map(([k, v]) => [parseInt(k, 10), [...v]]));
    this.statusByIssue = new Map(Object.entries(opts.status ?? {}).map(([k, v]) => [parseInt(k, 10), v]));
    this.defaultStatus = opts.defaultStatus ?? null;
    this.itemsByIssueNumber = new Map();
    for (const partial of opts.items ?? []) {
      const item = makeProjectItem({
        ...partial,
        labels: partial.labels ?? this.labelsByIssue.get(partial.issueNumber) ?? [],
        status: partial.status ?? this.statusByIssue.get(partial.issueNumber) ?? "Backlog",
      });
      this.itemsByIssueNumber.set(partial.issueNumber, { ...item, state: partial.state ?? "OPEN" });
      if (!this.labelsByIssue.has(partial.issueNumber)) {
        this.labelsByIssue.set(partial.issueNumber, [...item.labels]);
      }
    }
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    this.addLabelCalls.push({ issueNumber, label });
    this.labelOps.push({ op: "add", issueNumber, label });
    if (typeof this.failures.addLabel === "function") {
      const e = this.failures.addLabel(issueNumber, label);
      if (e) throw e;
    } else if (this.failures.addLabel) {
      throw this.failures.addLabel;
    }
    const cur = this.labelsByIssue.get(issueNumber) ?? [];
    if (!cur.includes(label)) cur.push(label);
    this.labelsByIssue.set(issueNumber, cur);
    // Keep the items map in sync so subsequent getItemsByStatus reflects it.
    const item = this.itemsByIssueNumber.get(issueNumber);
    if (item) item.labels = [...cur];
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    this.removeLabelCalls.push({ issueNumber, label });
    this.labelOps.push({ op: "remove", issueNumber, label });
    if (typeof this.failures.removeLabel === "function") {
      const e = this.failures.removeLabel(issueNumber, label);
      if (e) throw e;
    } else if (this.failures.removeLabel) {
      throw this.failures.removeLabel;
    }
    const cur = this.labelsByIssue.get(issueNumber) ?? [];
    const next = cur.filter(l => l !== label);
    this.labelsByIssue.set(issueNumber, next);
    const item = this.itemsByIssueNumber.get(issueNumber);
    if (item) item.labels = [...next];
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    this.comments.push({ issueNumber, body, postedAt: this.commentClock() });
    if (this.failures.addComment) throw this.failures.addComment;
  }

  async getIssueLabels(issueNumber: number): Promise<string[]> {
    this.getIssueLabelsCalls.push(issueNumber);
    if (this.failures.getIssueLabels) throw this.failures.getIssueLabels;
    return [...(this.labelsByIssue.get(issueNumber) ?? [])];
  }

  async getOpenBlockers(issueNumber: number): Promise<number[]> {
    this.getOpenBlockersCalls.push(issueNumber);
    if (this.failures.getOpenBlockers) throw this.failures.getOpenBlockers;
    return (this.itemsByIssueNumber.get(issueNumber)?.blockedBy ?? [])
      .filter(b => b.state === "OPEN").map(b => b.number);
  }

  async getItemStatus(issueNumber: number, options?: { forceRefresh?: boolean }): Promise<string | null> {
    this.getItemStatusCalls.push({ issueNumber, forceRefresh: options?.forceRefresh });
    if (this.failures.getItemStatus) throw this.failures.getItemStatus;
    if (this.statusByIssue.has(issueNumber)) return this.statusByIssue.get(issueNumber)!;
    const item = this.itemsByIssueNumber.get(issueNumber);
    if (item) return item.status;
    return this.defaultStatus;
  }

  async getItemsByStatus(status: string): Promise<ProjectItem[]> {
    this.getItemsByStatusCalls.push(status);
    if (this.failures.getItemsByStatus) throw this.failures.getItemsByStatus;
    return [...this.itemsByIssueNumber.values()]
      .filter(i => i.state !== "CLOSED" && i.status === status)
      .map(({ state: _state, ...item }) => item);
  }

  async getClosedItemsNotInDone(): Promise<ProjectItem[]> {
    this.getClosedItemsNotInDoneCalls += 1;
    if (this.failures.getClosedItemsNotInDone) throw this.failures.getClosedItemsNotInDone;
    return [...this.itemsByIssueNumber.values()]
      .filter(i => i.state === "CLOSED" && i.status !== "Done")
      .map(({ state: _state, ...item }) => item);
  }

  async updateItemStatus(itemId: string, newStatus: string): Promise<void> {
    this.updateItemStatusCalls.push({ itemId, newStatus });
    if (typeof this.failures.updateItemStatus === "function") {
      const e = this.failures.updateItemStatus(itemId, newStatus);
      if (e) throw e;
    } else if (this.failures.updateItemStatus) {
      throw this.failures.updateItemStatus;
    }
    for (const item of this.itemsByIssueNumber.values()) {
      if (item.id === itemId) item.status = newStatus;
    }
  }

  async closeIssue(issueNumber: number): Promise<void> {
    this.closeIssueCalls.push(issueNumber);
    if (typeof this.failures.closeIssue === "function") {
      const e = this.failures.closeIssue(issueNumber);
      if (e) throw e;
    } else if (this.failures.closeIssue) {
      throw this.failures.closeIssue;
    }
    const item = this.itemsByIssueNumber.get(issueNumber);
    if (item) item.state = "CLOSED";
  }

  async getLatestRetryAt(issueNumber: number): Promise<Date | null> {
    this.getLatestRetryAtCalls.push(issueNumber);
    if (this.failures.getLatestRetryAt) throw this.failures.getLatestRetryAt;
    return this.retryAtByIssue.get(issueNumber) ?? null;
  }

  async countRetryMarkers(_issueNumber: number): Promise<number> {
    return 0;
  }

  async getAllProjectItems(): Promise<ProjectItem[]> {
    this.getAllProjectItemsCalls += 1;
    if (this.failures.getAllProjectItems) throw this.failures.getAllProjectItems;
    return [...this.itemsByIssueNumber.values()].map(({ state: _state, ...item }) => item);
  }

  async getStrandedWipMarkers(issueNumber: number): Promise<{ observedAt: Date | null; sweptAt: Date | null }> {
    this.getStrandedWipMarkersCalls.push(issueNumber);
    if (typeof this.failures.getStrandedWipMarkers === "function") {
      const e = this.failures.getStrandedWipMarkers(issueNumber);
      if (e) throw e;
    } else if (this.failures.getStrandedWipMarkers) {
      throw this.failures.getStrandedWipMarkers;
    }
    const preset = this.strandedWipMarkersByIssue.get(issueNumber);
    let observedAt: Date | null = preset?.observedAt ?? null;
    let sweptAt: Date | null = preset?.sweptAt ?? null;
    for (const c of this.comments) {
      if (c.issueNumber !== issueNumber) continue;
      if (c.body.includes(STRANDED_WIP_OBSERVED_MARKER)) observedAt = c.postedAt;
      if (c.body.includes(STRANDED_WIP_SWEPT_MARKER)) sweptAt = c.postedAt;
    }
    return { observedAt, sweptAt };
  }

  clearItemsCache(): void {
    this.clearItemsCacheCalls += 1;
  }

  async getFamilyDispatchState(issueNumber: number): Promise<{ markerCount: number; breakerCommented: boolean }> {
    this.getFamilyDispatchStateCalls.push(issueNumber);
    if (this.failures.getFamilyDispatchState) throw this.failures.getFamilyDispatchState;
    // Synthesize the root's chronological comment stream: the preset
    // tallies stand for comments that existed before the test's writes
    // (oldest first), followed by everything posted through this client
    // in posted order. The tally semantics — including the per-family
    // reset marker — are the production ones: tallyFamilyComments is
    // shared, so mock and dispatcher can never disagree about resets.
    const preset = this.familyStateByIssue.get(issueNumber);
    const stream: { body: string }[] = [];
    for (let i = 0; i < (preset?.markerCount ?? 0); i++) {
      stream.push({ body: FAMILY_DISPATCH_COMMENT_MARKER });
    }
    if (preset?.breakerCommented) stream.push({ body: FAMILY_BREAKER_COMMENT_MARKER });
    for (const c of this.comments) {
      if (c.issueNumber === issueNumber) stream.push({ body: c.body });
    }
    return tallyFamilyComments(stream);
  }
}

// --------- Factories ---------

export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "developer",
    column: "In Development",
    claudeMdPath: "developer/CLAUDE.md",
    description: "Developer — implements code with tests",
    usesWorktree: true,
    producesCommits: true,
    ...overrides,
  };
}

export function makeProjectItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  const blockedBy: BlockerInfo[] = overrides.blockedBy ?? [];
  return {
    id: overrides.id ?? "PVTI_test",
    issueId: overrides.issueId ?? "I_test",
    issueNumber: overrides.issueNumber ?? 100,
    title: overrides.title ?? "Test ticket",
    body: overrides.body ?? "Body of test ticket",
    status: overrides.status ?? "In Development",
    labels: overrides.labels ?? [],
    url: overrides.url ?? "https://github.com/test/repo/issues/100",
    blockedBy,
    parentNumber: overrides.parentNumber ?? null,
    grandparentNumber: overrides.grandparentNumber ?? null,
    ...(overrides.subIssues ? { subIssues: overrides.subIssues } : {}),
  };
}

/**
 * Convenience wrapper around `makeDispatchContext` that builds a fresh
 * agent + item + mock client + mock deps. Tests override per-field via
 * the `overrides` arg; everything else gets sensible defaults (developer
 * agent, ticket #100 in In Development, empty client state).
 *
 * Returns the context plus the underlying `client` and `calls` so tests
 * can mutate / assert on them without separate factory invocations.
 */
export function makeTestContext(overrides: {
  agent?: Partial<AgentConfig>;
  item?: Partial<ProjectItem>;
  client?: MockGitHubClient;
  deps?: DispatchDeps;
  calls?: CallLog;
  mockOptions?: MockDepsOptions;
} = {}): {
  ctx: DispatchContext;
  client: MockGitHubClient;
  calls: CallLog;
} {
  const agent = makeAgentConfig(overrides.agent ?? {});
  const item = makeProjectItem(overrides.item ?? {});
  const client = overrides.client ?? new MockGitHubClient();

  // Either (a) caller supplies pre-built deps + calls (e.g. shared
  // across multiple ctxs), or (b) we mint fresh deps from mockOptions.
  let deps: DispatchDeps;
  let calls: CallLog;
  if (overrides.deps && overrides.calls) {
    deps = overrides.deps;
    calls = overrides.calls;
  } else {
    const mock = makeMockDeps(overrides.mockOptions ?? {});
    deps = mock.deps;
    calls = mock.calls;
  }

  const ctx = makeDispatchContext(agent, item, client, deps);
  return { ctx, client, calls };
}

// --------- Smoke test ---------

describe("dispatch test harness", () => {
  test("makeTestContext composes agent, item, mock client, mock deps", () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 200 },
      agent: { name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md", producesCommits: true },
    });

    // Context shape: agent + item flow through, branchName is derived,
    // useWorktree honors agent.usesWorktree, agentCwd is the worktree dir.
    assert.equal(ctx.agent.name, "architect");
    assert.equal(ctx.item.issueNumber, 200);
    assert.equal(ctx.branchName, "feature/200");
    assert.equal(ctx.useWorktree, true, "architect usesWorktree=true → context useWorktree=true");
    assert.equal(ctx.agentCwd, ctx.worktreeDir, "useWorktree=true → cwd is worktree");
    assert.ok(ctx.deps.execSync, "deps wired through");
    assert.ok(ctx.deps.runClaudeStreaming, "deps wired through");

    // Empty harness state: no execSync, no client mutations, no streams.
    assert.equal(calls.exec.length, 0);
    assert.equal(calls.claudeStreams, 0);
    assert.equal(client.addLabelCalls.length, 0);
    assert.equal(client.comments.length, 0);
  });
});

// =====================================================================
// setupBranchAndWorktree
// =====================================================================
//
// 12 tests: 5 failure modes + 6 decisions from `decideBranchSetup` +
// orphan-worktree cleanup + codegraph soft-fails + the no-worktree
// (PO/issue-0) path. Plus the import-only merge-conflict pair. Mock granularity is per-execSync-substring so a
// test can flip "fast-forward" to "abort" by adjusting one handler.
//
// **Invariant under test (the load-bearing one):** every failure path
// in this phase posts `error:<agent>` + a comment AND returns
// `{ ok: false }` so the orchestrator skips `cleanupAfterDispatch` —
// preserving the worktree (or the absence of one) as evidence for
// human triage. The merge-conflict path is the one exception that
// cleans up its own worktree (it just succeeded creating it).

/**
 * Empty-by-default exec baseline. Mock unmatched commands return empty
 * string (success) — anything that should *succeed silently* needs no
 * entry. Tests inject failure handlers for the specific commands they
 * want to break, plus rev-parse handlers for branch-existence + SHA
 * fixtures (those need specific output, not just success).
 *
 * Earlier draft put generic patterns like `"git branch "` here to
 * "document the happy path"; that shadowed per-test overrides like
 * `"git branch feature/101 main"` because object-key iteration matches
 * the broader pattern first. Lesson: keep mock baselines small + per-test
 * overrides specific.
 */
function happyExecBaseline(): Record<string, ExecHandler> {
  return {};
}

describe("setupBranchAndWorktree — failure modes", () => {
  test("update-main-fails on worktree path → error:<agent> label + comment + {ok:false}", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 100 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          // The first git checkout fails — typically a non-fast-forward
          // or a dirty working tree on main. Dispatch gives up before
          // touching the feature branch.
          "git checkout main && git pull": () => execError({ stderr: "error: cannot pull with rebase" }),
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 100, label: "error:developer" }]);
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /Failed to update `main` branch/);
    // Sanity: we never advanced past the checkout — no fetch, no branch,
    // no worktree add.
    assert.ok(!calls.exec.some(c => c.cmd.includes("git fetch")), "fetch should not run after checkout fail");
    assert.ok(!calls.exec.some(c => c.cmd.includes("git worktree add")), "worktree add should not run after checkout fail");
  });

  test("abort-local-diverged → divergence message + BOTH commit blocks + SHAs, no push advice", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 155 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          // Both refs exist; SHAs differ; NEITHER direction is an ancestor —
          // the genuine-divergence path (origin advanced out-of-band), which
          // misled triage on tui-driver #158 (2026-07-04). Blanket-failing
          // `--is-ancestor` fails both direction checks → diverged.
          "git rev-parse --verify feature/155": () => "",
          "git rev-parse --verify origin/feature/155": () => "",
          "git rev-parse origin/feature/155": () => "origin-sha-aaaaaaaa\n",
          "git rev-parse feature/155": () => "local-sha-bbbbbbbb\n",
          "git merge-base --is-ancestor": () => execError({ stderr: "" }),
          // Distinct commit listings per direction so we can assert both blocks.
          "git log --oneline -n 30 origin/feature/155..feature/155": () => "bbbbbbbb local-only commit\n",
          "git log --oneline -n 30 feature/155..origin/feature/155": () => "aaaaaaaa origin-only commit\n",
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 155, label: "error:developer" }]);
    assert.equal(client.comments.length, 1);
    const body = client.comments[0]!.body;
    // Divergence framing, not "unpushed work" framing.
    assert.match(body, /have DIVERGED/);
    assert.match(body, /would REVERT/);
    assert.match(body, /preserve the local branch and reconcile its commits without rewriting it/);
    assert.doesNotMatch(body, /git branch -f/);
    // Must NOT advise pushing local — that's the trap this split fixes.
    assert.ok(!/Push the missing commits/.test(body), "diverged message must not advise pushing local");
    // Both directions' commits + SHAs surface so the operator sees what a
    // blind push would revert.
    assert.match(body, /local-sha-bbbbbbbb/);
    assert.match(body, /origin-sha-aaaaaaaa/);
    assert.match(body, /bbbbbbbb local-only commit/);
    assert.match(body, /aaaaaaaa origin-only commit/);
    // No worktree creation should follow an integrity-error abort.
    assert.ok(!calls.exec.some(c => c.cmd.includes("git worktree add")));
  });

  test("abort-local-strictly-ahead → 'push the missing commits' advice, local-only block, no divergence framing", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 166 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          // Both refs exist; SHAs differ; local is NOT an ancestor of origin
          // but origin IS an ancestor of local → local strictly ahead (real
          // unpushed work). Only the local→origin direction fails; the
          // reverse direction has no override, so it succeeds (exit 0).
          "git rev-parse --verify feature/166": () => "",
          "git rev-parse --verify origin/feature/166": () => "",
          "git rev-parse origin/feature/166": () => "origin-sha-cccccccc\n",
          "git rev-parse feature/166": () => "local-sha-dddddddd\n",
          "git merge-base --is-ancestor feature/166 origin/feature/166": () => execError({ stderr: "" }),
          "git log --oneline -n 30 origin/feature/166..feature/166": () => "dddddddd unpushed work\n",
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 166, label: "error:developer" }]);
    assert.equal(client.comments.length, 1);
    const body = client.comments[0]!.body;
    assert.match(body, /commits not present on origin/);
    assert.match(body, /Push the missing commits/);
    assert.match(body, /dddddddd unpushed work/);
    // Strictly-ahead is NOT a divergence: no "would revert" warning.
    assert.ok(!/have DIVERGED/.test(body), "strictly-ahead must not use divergence framing");
    assert.ok(!/would REVERT/.test(body));
    assert.ok(!calls.exec.some(c => c.cmd.includes("git worktree add")));
  });

  test("git branch creation throws → caught, label + comment + {ok:false}", async () => {
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 101 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          // Neither ref exists → create-from-main path.
          "git rev-parse --verify feature/101": () => execError({ stderr: "fatal: need a single revision" }),
          "git rev-parse --verify origin/feature/101": () => execError({ stderr: "fatal: need a single revision" }),
          // The `git branch <name> main` itself fails (e.g. permission /
          // index lock / corrupted refs).
          "git branch feature/101 main": () => execError({ stderr: "fatal: cannot lock ref" }),
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 101, label: "error:developer" }]);
    assert.match(client.comments[0]!.body, /Failed to set up branch/);
    assert.match(client.comments[0]!.body, /create-from-main/);
  });

  test("git worktree add fails → label + comment + {ok:false}", async () => {
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 102 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/102": () => execError({ stderr: "fatal" }),
          "git rev-parse --verify origin/feature/102": () => execError({ stderr: "fatal" }),
          "git worktree add": () => execError({ stderr: "fatal: '<path>' already exists" }),
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 102, label: "error:developer" }]);
    assert.match(client.comments[0]!.body, /Failed to create git worktree/);
  });

  test("merge-conflict on main → main feature → git merge --abort runs, worktree cleaned up inline, label + comment + {ok:false}", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 103 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/103": () => execError({ stderr: "fatal" }),
          "git rev-parse --verify origin/feature/103": () => execError({ stderr: "fatal" }),
          // worktree creation succeeds, but the post-create merge fails.
          "merge main --no-edit": () => execError({ stderr: "CONFLICT (content): Merge conflict in foo.go" }),
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 103, label: "error:developer" }]);
    assert.match(client.comments[0]!.body, /Merge conflict on branch/);

    // The merge-conflict path is special: it just successfully created
    // the worktree, so it cleans up its own worktree inline. Two markers:
    //   1. `git merge --abort` runs (drains the failed merge state)
    //   2. `git worktree remove` runs AFTER `git worktree add`
    assert.ok(
      calls.exec.some(c => c.cmd.includes("git merge --abort")),
      "merge-conflict path must call `git merge --abort`",
    );
    const addIdx = calls.exec.findIndex(c => c.cmd.includes("git worktree add"));
    const removeAfterAdd = calls.exec.slice(addIdx + 1).some(c => c.cmd.includes("git worktree remove"));
    assert.ok(removeAfterAdd, "merge-conflict path must clean up its own worktree after creating it");
  });

  // Mobile #803 / #823 (2026-09-22) parked on conflicts where both sides
  // had only added an import at the same slot. merge-resolve.ts settles
  // that shape; everything else keeps the park-for-a-human path above.
  function conflictContext(issueNumber: number, conflicted: string) {
    const probe = makeTestContext({ item: { issueNumber } });
    const path = resolve(probe.ctx.worktreeDir, "Thread.kt");
    const made = makeTestContext({
      item: { issueNumber },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          [`git rev-parse --verify feature/${issueNumber}`]: () => execError({ stderr: "fatal" }),
          [`git rev-parse --verify origin/feature/${issueNumber}`]: () => execError({ stderr: "fatal" }),
          "merge main --no-edit": () => execError({ stderr: "CONFLICT (content): Merge conflict in Thread.kt" }),
          "git diff --name-only --diff-filter=U -z": () => "Thread.kt\0",
        },
        fsMap: { [path]: conflicted },
      },
    });
    return { ...made, path };
  }

  test("import-only merge conflict → resolved and committed in the worktree, comment, no error label, {ok:true}", async () => {
    const { ctx, client, calls, path } = conflictContext(104, [
      "import a.A",
      "<<<<<<< HEAD",
      "import a.Feature",
      "||||||| base",
      "=======",
      "import a.Main",
      ">>>>>>> main",
      "",
    ].join("\n"));

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(client.addLabelCalls, []);
    assert.match(client.comments[0]!.body, /Import-only merge conflict resolved/);
    assert.match(client.comments[0]!.body, /`Thread\.kt`/);
    assert.deepEqual(
      calls.fs.filter(f => f.kind === "write" && f.path === path).map(f => f.content),
      ["import a.A\nimport a.Feature\nimport a.Main\n"],
    );
    assert.ok(calls.exec.some(c => c.cmd.includes("merge.conflictStyle=diff3")), "merge must write diff3 markers");
    assert.ok(calls.exec.some(c => c.cmd === "git add -- 'Thread.kt'"));
    assert.ok(calls.exec.some(c => c.cmd === "git commit --no-edit"));
    assert.ok(!calls.exec.some(c => c.cmd.includes("git merge --abort")), "a resolved merge must not be aborted");
    const addIdx = calls.exec.findIndex(c => c.cmd.includes("git worktree add"));
    assert.ok(!calls.exec.slice(addIdx + 1).some(c => c.cmd.includes("git worktree remove")), "a resolved merge keeps its worktree");
  });

  // Anything past import-only goes to the code owner (merge-handoff.ts).
  // The stopped merge is readable: two conflicted-file lines are enough.
  const CODE_CONFLICT = [
    "<<<<<<< HEAD",
    "val x = 1",
    "||||||| base",
    "val x = 0",
    "=======",
    "val x = 2",
    ">>>>>>> main",
    "",
  ].join("\n");
  function codeConflictContext(issueNumber: number, agent: Partial<AgentConfig>) {
    const probe = makeTestContext({ item: { issueNumber }, agent });
    const path = resolve(probe.ctx.worktreeDir, "Thread.kt");
    const made = makeTestContext({
      item: { issueNumber },
      agent,
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          [`git rev-parse --verify feature/${issueNumber}`]: () => execError({ stderr: "fatal" }),
          [`git rev-parse --verify origin/feature/${issueNumber}`]: () => execError({ stderr: "fatal" }),
          "merge main --no-edit": () => execError({ stderr: "CONFLICT (content): Merge conflict in Thread.kt" }),
          "git diff --name-only --diff-filter=U -z": () => "Thread.kt\0",
          "git rev-parse MERGE_HEAD": () => "mainsha\n",
          "git merge-base HEAD MERGE_HEAD": () => "basesha\n",
          "git rev-parse HEAD": () => "headsha\n",
        },
        fsMap: { [path]: CODE_CONFLICT },
      },
    });
    return { ...made, path };
  }

  test("code conflict before the code owner's run → merge left in the worktree for it, comment, {ok:true}", async () => {
    const { ctx, client, calls, path } = codeConflictContext(105, {});

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(client.addLabelCalls, []);
    assert.match(client.comments[0]!.body, /Merge conflict left for developer/);
    assert.match(client.comments[0]!.body, /`Thread\.kt`/);
    assert.deepEqual(ctx.pendingMerge, { paths: ["Thread.kt"], mainSha: "mainsha", baseSha: "basesha", headSha: "headsha" });
    assert.ok(!calls.fs.some(f => f.kind === "write" && f.path === path), "the dispatcher resolves nothing itself");
    assert.ok(!calls.exec.some(c => c.cmd.includes("git merge --abort")), "the merge stays for the agent");
    assert.ok(!calls.exec.some(c => c.cmd.includes("git commit")));
  });

  test("code conflict before a later stage → aborted, sent to the owner as an uncounted handoff, {ok:false}", async () => {
    // pyrycode-mobile #808, 2026-09-23: documentation's merge hit #805's line.
    const { ctx, client, calls } = codeConflictContext(106, {
      name: "documentation", column: "In Documentation", claudeMdPath: "documentation/CLAUDE.md",
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [
      { issueNumber: 106, label: "merge-handoff" },
      { issueNumber: 106, label: "needs-rework:developer" },
    ]);
    assert.match(client.comments[0]!.body, /Merge conflict sent to developer/);
    assert.match(client.comments[0]!.body, /does not count as a rework/);
    assert.equal(ctx.pendingMerge, undefined);
    assert.ok(calls.exec.some(c => c.cmd.includes("git merge --abort")));
    const addIdx = calls.exec.findIndex(c => c.cmd.includes("git worktree add"));
    assert.ok(calls.exec.slice(addIdx + 1).some(c => c.cmd.includes("git worktree remove")), "the routed stage cleans up its worktree");
  });

  test("code conflict before an earlier stage → parks for a human as before", async () => {
    const { ctx, client, calls, path } = codeConflictContext(107, {
      name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md",
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 107, label: "error:architect" }]);
    assert.match(client.comments[0]!.body, /Merge conflict on branch/);
    assert.ok(!calls.fs.some(f => f.kind === "write" && f.path === path), "nothing may be written for an unresolvable conflict");
    assert.ok(!calls.exec.some(c => c.cmd.includes("git commit")));
    assert.ok(calls.exec.some(c => c.cmd.includes("git merge --abort")));
  });

  test("the owner's stopped merge cannot be read → parks rather than hand over blind", async () => {
    const { ctx, client, calls } = conflictContext(108, CODE_CONFLICT);

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 108, label: "error:developer" }]);
    assert.equal(ctx.pendingMerge, undefined);
    assert.ok(calls.exec.some(c => c.cmd.includes("git merge --abort")));
  });
});

describe("setupBranchAndWorktree — decideBranchSetup branches", () => {
  test("create-from-main → `git branch <name> main` invoked", async () => {
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 110 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/110": () => execError({ stderr: "fatal" }),
          "git rev-parse --verify origin/feature/110": () => execError({ stderr: "fatal" }),
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    assert.ok(
      calls.exec.some(c => c.cmd === "git branch feature/110 main"),
      "expected `git branch feature/110 main` exactly",
    );
  });

  test("create-from-origin → `git branch <name> origin/<name>` invoked", async () => {
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 111 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          // Local missing, remote present (recovery from prior dispatcher
          // wipe — origin is canonical).
          "git rev-parse --verify feature/111": () => execError({ stderr: "fatal" }),
          "git rev-parse --verify origin/feature/111": () => "",
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    assert.ok(
      calls.exec.some(c => c.cmd === "git branch feature/111 origin/feature/111"),
      "expected `git branch feature/111 origin/feature/111` exactly",
    );
  });

  test("fast-forward-from-origin → `git branch -f <name> origin/<name>` invoked", async () => {
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 112 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/112": () => "",
          "git rev-parse --verify origin/feature/112": () => "",
          // SHAs differ, local IS an ancestor of origin — fast-forward path.
          "git rev-parse origin/feature/112": () => "newer-origin-sha\n",
          "git rev-parse feature/112": () => "older-local-sha\n",
          "git merge-base --is-ancestor": () => "",  // exits 0 → ancestor
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    assert.ok(
      calls.exec.some(c => c.cmd === "git branch -f feature/112 origin/feature/112"),
      "expected `git branch -f feature/112 origin/feature/112` exactly",
    );
  });

  test("reuse-local-already-synced → no `git branch ...` invoked (no-op sync)", async () => {
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 113 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/113": () => "",
          "git rev-parse --verify origin/feature/113": () => "",
          // SHAs equal → reuse local, no branch mutation needed.
          "git rev-parse origin/feature/113": () => "matching-sha\n",
          "git rev-parse feature/113": () => "matching-sha\n",
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    // No `git branch <name> ...` mutation should happen — local is already canonical.
    const branchCmds = calls.exec.filter(c =>
      /^git branch (?!-f )(feature\/113|-f feature\/113)/.test(c.cmd),
    );
    assert.equal(branchCmds.length, 0, "reuse-local-already-synced must not invoke git branch");
  });
});

describe("setupBranchAndWorktree — coverage edges", () => {
  test("orphan worktree on same branch → removed before `git worktree add`", async () => {
    // The 2026-05-02 lesson: a previous cycle's worktree (e.g.
    // `architect-100`) on `feature/100` was never cleaned up; this
    // cycle wants `developer-100` on the same branch. Without orphan
    // cleanup, `git worktree add` fails with "branch is already checked
    // out at <other-path>", error:<agent> applied, dispatcher stuck.
    // The orphan loop should remove it BEFORE adding the new worktree.
    const orphanPath = "/tmp/.pyrycode-worktrees/architect-114";
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 114 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/114": () => "",
          "git rev-parse --verify origin/feature/114": () => "",
          "git rev-parse origin/feature/114": () => "same\n",
          "git rev-parse feature/114": () => "same\n",
          "git worktree list --porcelain": () =>
            `worktree ${orphanPath}\nHEAD abc123\nbranch refs/heads/feature/114\n\n`,
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    // The orphan-removal call must precede the worktree-add call.
    const orphanRemoveIdx = calls.exec.findIndex(c =>
      c.cmd.includes(`git worktree remove "${orphanPath}"`),
    );
    const addIdx = calls.exec.findIndex(c => c.cmd.includes("git worktree add"));
    assert.ok(orphanRemoveIdx >= 0, "orphan worktree removal must happen");
    assert.ok(addIdx > orphanRemoveIdx, "orphan removal must precede `git worktree add`");
  });

  test("codegraph symlink — source missing → warn, no symlink, still {ok:true}", async () => {
    // `decideCodegraphSymlink({sourceExists:false, destExists:false})`
    // returns `skip / no-source` — caller should warn but not fail.
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 115 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/115": () => execError({ stderr: "fatal" }),
          "git rev-parse --verify origin/feature/115": () => execError({ stderr: "fatal" }),
        },
        // fsMap empty → existsSync returns false for everything,
        // including the .codegraph source.
        fsMap: {},
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true }, "missing codegraph source must not block dispatch");
    // No symlink should have been issued — the existsSync check on the
    // source returned false (empty fsMap), so decideCodegraphSymlink
    // returns skip/no-source.
    assert.equal(
      calls.fs.filter(c => c.kind === "symlink").length,
      0,
      "no symlinkSync should be invoked when source is missing",
    );
  });

  test("PO / issue-0 path → `git checkout main && git pull` only, returns {ok:true}", async () => {
    // PO has `usesWorktree: false`. The setup phase should short-circuit:
    // pull main, return ok. No fetch, no branch ops, no worktree creation.
    const { ctx, client, calls } = makeTestContext({
      agent: { name: "po", column: "Backlog", claudeMdPath: "po/CLAUDE.md", usesWorktree: false, producesCommits: false },
      item: { issueNumber: 116 },
      mockOptions: { execImpls: happyExecBaseline() },
    });

    assert.equal(ctx.useWorktree, false, "PO ctx must have useWorktree=false");
    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    assert.equal(client.addLabelCalls.length, 0, "PO success path must not label");
    assert.equal(client.comments.length, 0, "PO success path must not comment");
    // The only git command should be the checkout/pull.
    const gitCmds = calls.exec.filter(c => c.cmd.startsWith("git"));
    assert.equal(gitCmds.length, 1, "PO path runs exactly one git command");
    assert.equal(gitCmds[0]!.cmd, "git checkout main && git pull");
  });
});

// =====================================================================
// AGENTS per-agent model / effort config
// =====================================================================

describe("AGENTS model/effort config", () => {
  const byName = (name: string) => {
    const agent = AGENTS.find(a => a.name === name);
    assert.ok(agent, `AGENTS must contain ${name}`);
    return agent;
  };

  test("QA and documentation run on claude-sonnet-5 at high effort", () => {
    for (const name of ["qa", "documentation"]) {
      const agent = byName(name);
      assert.equal(agent.model, "claude-sonnet-5", `${name} model`);
      assert.equal(agent.effort, "high", `${name} effort`);
    }
  });

  test("every other stage inherits the pipeline default (no override)", () => {
    for (const name of ["po", "architect", "developer", "code-review"]) {
      const agent = byName(name);
      assert.equal(agent.model, undefined, `${name} must not override model → inherits opus`);
      assert.equal(agent.effort, undefined, `${name} must not override effort → inherits high`);
    }
  });
});

// =====================================================================
// prepareAgentSpawn
// =====================================================================
//
// 5 tests: CLAUDE.md missing (the inline cleanup-skip path), the happy
// path (asserting the SpawnConfig shape), QMD soft-fail, PO skips QMD,
// and a parametric per-agent test for maxTurns + timeoutMs + Agent tool.

/** Path the production code resolves for an agent's CLAUDE.md. */
function claudeMdAbsPath(agentClaudeMdPath: string): string {
  return resolve(TEST_AGENTS_REPO_ROOT, agentClaudeMdPath);
}

describe("prepareAgentSpawn", () => {
  test("CLAUDE.md missing → comment + inline worktree cleanup + {ok:false}", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 200 },
      mockOptions: {
        // fsMap empty → readFileSync throws ENOENT for the CLAUDE.md path.
        fsMap: {},
      },
    });

    const result = await prepareAgentSpawn(ctx);

    assert.deepEqual(result, { ok: false });
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /Agent CLAUDE\.md not found/);
    assert.match(client.comments[0]!.body, /developer\/CLAUDE\.md/);
    // Inline worktree cleanup fires here (the orchestrator's catch-all
    // cleanup is skipped on early-return). Asserts the recovery
    // behaviour without depending on the orchestrator path.
    assert.ok(
      calls.exec.some(c => c.cmd.includes("git worktree remove")),
      "must clean up worktree inline since orchestrator skips cleanup on early-return",
    );
  });

  test("happy path → returns {ok:true, config} with correct tools, turns, timeout, env", async () => {
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 201, title: "Test feature" },
      mockOptions: {
        fsMap: { [claudeMd]: "Mock developer system prompt" },
        buildPromptResult: "## Mock prompt #201",
      },
    });

    const result = await prepareAgentSpawn(ctx);

    if (!result.ok) {
      assert.fail(`expected ok:true, got ok:false`);
    }
    const config = result.config;
    assert.equal(config.model, "opus");
    assert.equal(config.effort, "high");
    assert.equal(config.maxTurns, 135, "developer base budget post-2026-06-06 is 135");
    assert.equal(config.cwd, ctx.agentCwd);
    assert.equal(config.timeoutMs, 1_500_000, "developer = 25min");
    // baseTools without Agent (developer doesn't sub-dispatch).
    assert.ok(config.allowedTools.includes("Bash,Read,Write,Edit"));
    assert.ok(config.allowedTools.includes("mcp__codegraph__"));
    assert.ok(
      config.allowedTools.includes("mcp__plugin_context7_context7__resolve-library-id"),
      "context7 must use the plugin tool name so the allowlist matches the loaded tool",
    );
    assert.ok(
      config.allowedTools.includes("mcp__plugin_context7_context7__query-docs"),
      "context7 query-docs must use the plugin tool name",
    );
    assert.ok(
      !config.allowedTools.split(",").includes("mcp__context7__resolve-library-id"),
      "the stale non-plugin context7 name must be gone — it never matched the loaded tool and silently denied every call",
    );
    assert.ok(
      !config.allowedTools.split(",").includes("WebSearch"),
      "developer must NOT get WebSearch — research access is architect-scoped",
    );
    assert.ok(
      config.allowedTools.includes("mcp__plugin_figma_figma__get_design_context"),
      "developer must have Figma get_design_context for UI-anchored ticket flow",
    );
    assert.ok(
      config.allowedTools.includes("mcp__plugin_figma_figma__get_screenshot"),
      "developer must have Figma get_screenshot for visual reference + validation",
    );
    assert.ok(
      config.allowedTools.includes("mcp__plugin_figma_figma__get_metadata"),
      "developer must have Figma get_metadata for truncation-fallback to per-child fetch",
    );
    assert.ok(
      config.allowedTools.includes("mcp__plugin_figma_figma__get_variable_defs"),
      "developer must have Figma get_variable_defs for design-token tickets (variable mode values)",
    );
    assert.ok(
      config.allowedTools.includes("mcp__plugin_figma_figma__search_design_system"),
      "developer must have Figma search_design_system for finding components/variables/styles by name",
    );
    assert.ok(
      !config.allowedTools.includes("mcp__plugin_figma_figma__use_figma"),
      "developer must NOT have Figma write tools — read-only access",
    );
    assert.ok(!config.allowedTools.includes(",Agent"), "developer must not get Agent tool");
    // Env is scrubbed: no GITHUB_TOKEN, but CLAUDE_CODE_ENTRYPOINT set.
    assert.equal(config.env.GITHUB_TOKEN, undefined, "GITHUB_TOKEN must be scrubbed");
    assert.equal(config.env.CLAUDE_CODE_ENTRYPOINT, "developer");

    // Both prompt + system-prompt files were written.
    const writes = calls.fs.filter(f => f.kind === "write");
    assert.equal(writes.length, 2, "exactly two writeFileSync calls (prompt + system prompt)");
    assert.ok(writes.some(w => w.content === "## Mock prompt #201"));
    assert.ok(writes.some(w => w.content === "Mock developer system prompt"));
  });

  test("per-agent model/effort override flows into the spawn config (default opus/high is covered by the happy-path test above)", async () => {
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const { ctx } = makeTestContext({
      agent: { model: "claude-sonnet-5", effort: "medium" },
      item: { issueNumber: 205, title: "Override" },
      mockOptions: {
        fsMap: { [claudeMd]: "Mock system prompt" },
        buildPromptResult: "## Mock prompt #205",
      },
    });

    const result = await prepareAgentSpawn(ctx);

    if (!result.ok) {
      assert.fail(`expected ok:true, got ok:false`);
    }
    assert.equal(result.config.model, "claude-sonnet-5", "agent.model must override the opus default");
    assert.equal(result.config.effort, "medium", "agent.effort must override the high default");
  });

  test("QMD re-index fails → warning logged, dispatch continues", async () => {
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const { ctx } = makeTestContext({
      item: { issueNumber: 202 },
      mockOptions: {
        fsMap: { [claudeMd]: "system prompt" },
        execImpls: {
          // QMD failure shape: stderr + non-zero exit. The catch surfaces
          // both stderr and stdout in the warning; test just verifies the
          // outer call still succeeds.
          "qmd update": () => execError({ status: 1, stderr: "qmd: index lock taken" }),
        },
      },
    });

    const result = await prepareAgentSpawn(ctx);

    // QMD failure is non-fatal — dispatch proceeds with the (stale) index.
    assert.ok(result.ok, "QMD failure must not abort dispatch");
  });

  test("PO path skips QMD re-index (no useWorktree)", async () => {
    const claudeMd = claudeMdAbsPath("po/CLAUDE.md");
    const { ctx, calls } = makeTestContext({
      agent: { name: "po", column: "Backlog", claudeMdPath: "po/CLAUDE.md", usesWorktree: false, producesCommits: false },
      item: { issueNumber: 203 },
      mockOptions: {
        fsMap: { [claudeMd]: "po system prompt" },
        // QMD execImpls absent — assertion below is "no qmd call ever".
      },
    });

    const result = await prepareAgentSpawn(ctx);

    assert.ok(result.ok);
    // The QMD index lives in the worktree; running it in repoRoot would
    // mutate main's index across other dispatcher cycles. Gate is
    // `useWorktree` — PO has it false.
    const qmdCalls = calls.exec.filter(c => c.cmd.includes("qmd"));
    assert.equal(qmdCalls.length, 0, "PO must never invoke qmd (no isolated tree)");
  });

  test("agent-specific tools / turns / timeout", () => withStageSet("classic", async () => {
    // Pinned to the classic set: a builder fork's .env sets PYRY_STAGE_SET=builder,
    // which dispatch.ts loads at import, and the builder set has no architect,
    // so an unpinned run inside Mobile, Pyrycode or Desktop failed this row.
    // Parametric across agents. Asserts:
    //   - architect + code-review get the `,Agent` tool suffix
    //   - code-review = 150 turns + 40min, developer/docs = 135 turns + 25min,
    //     others (architect, po) = 135 turns + 20min (all +50% on 2026-06-06)
    // Field names mirror AgentConfig (`name`, not `agent`) so the
    // makeAgentConfig overrides actually apply — passing `{agent:...}`
    // would be silently dropped because AgentConfig has no such field.
    const cases: Array<Partial<AgentConfig> & {
      maxTurns: number; timeoutMs: number; hasAgentTool: boolean; hasWebSearch: boolean;
    }> = [
      { name: "architect",     column: "In Architecture",  claudeMdPath: "architect/CLAUDE.md",     usesWorktree: true,  producesCommits: true,  maxTurns: 135, timeoutMs: 1_200_000, hasAgentTool: true,  hasWebSearch: true  },
      { name: "developer",     column: "In Development",   claudeMdPath: "developer/CLAUDE.md",     usesWorktree: true,  producesCommits: true,  maxTurns: 135, timeoutMs: 1_500_000, hasAgentTool: false, hasWebSearch: false },
      { name: "code-review",   column: "In Code Review",   claudeMdPath: "code-review/CLAUDE.md",   usesWorktree: true,  producesCommits: false, maxTurns: 150, timeoutMs: 2_400_000, hasAgentTool: true,  hasWebSearch: false },
      { name: "documentation", column: "In Documentation", claudeMdPath: "documentation/CLAUDE.md", usesWorktree: true,  producesCommits: true,  maxTurns: 135, timeoutMs: 1_500_000, hasAgentTool: false, hasWebSearch: false },
      { name: "po",            column: "Backlog",          claudeMdPath: "po/CLAUDE.md",            usesWorktree: false, producesCommits: false, maxTurns: 135, timeoutMs: 1_200_000, hasAgentTool: false, hasWebSearch: false },
    ];

    for (const c of cases) {
      const claudeMd = claudeMdAbsPath(c.claudeMdPath!);
      const { ctx } = makeTestContext({
        agent: c,
        item: { issueNumber: 250 },
        mockOptions: { fsMap: { [claudeMd]: `${c.name} system prompt` } },
      });

      const result = await prepareAgentSpawn(ctx);
      assert.ok(result.ok, `${c.name} prepareAgentSpawn must succeed`);
      const cfg = (result as { ok: true; config: any }).config;
      assert.equal(cfg.maxTurns, c.maxTurns, `${c.name} maxTurns`);
      assert.equal(cfg.timeoutMs, c.timeoutMs, `${c.name} timeoutMs`);
      const hasAgent = cfg.allowedTools.split(",").includes("Agent");
      assert.equal(hasAgent, c.hasAgentTool, `${c.name} Agent tool presence`);
      const hasWebSearch = cfg.allowedTools.split(",").includes("WebSearch");
      assert.equal(hasWebSearch, c.hasWebSearch, `${c.name} WebSearch tool presence — research is architect-scoped`);
    }
  }));

  test("security-sensitive architect gets the 40min budget (item.labels threaded to timeoutFor)", async () => {
    // pyrycode-mobile#304 (2026-05-31): a security-sensitive architect run
    // must write the spec AND run the adversarial security-review pass; the
    // base 20min wasn't enough and the timed-out spec was discarded. This
    // locks that the ticket's labels actually reach the timeout computation
    // (the unit-level policy is covered by timeoutFor's own tests).
    const claudeMd = claudeMdAbsPath("architect/CLAUDE.md");
    const { ctx } = makeTestContext({
      agent: { name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md", usesWorktree: true, producesCommits: true },
      item: { issueNumber: 304, labels: ["done:po", "size:s", "security-sensitive"] },
      mockOptions: { fsMap: { [claudeMd]: "architect system prompt" } },
    });

    const result = await prepareAgentSpawn(ctx);
    assert.ok(result.ok, "security-sensitive architect prepareAgentSpawn must succeed");
    assert.equal((result as { ok: true; config: any }).config.timeoutMs, 2_400_000, "security-sensitive architect = 40min");
  });

  // ===================================================================
  // Contract: --disallowed-tools for non-interactive agents (#7)
  // ===================================================================
  //
  // Today the dispatcher does NOT pass `--disallowed-tools` to claude.
  // pyrycode/pyrycode#398 evidence: developer hit a `git reset --hard`
  // denial, invoked `AskUserQuestion` (no operator on the line), burned
  // its remaining turns, work stranded. `--allowed-tools` cannot exclude
  // these — claude treats `AskUserQuestion`/`EnterPlanMode`/`ExitPlanMode`
  // as always-available; only `--disallowed-tools` can strip them.
  //
  // Two coordinated changes ship the fix:
  //   1. (pyry side, TBD) `pyry agent-run` learns to forward
  //      `--disallowed-tools` to its child claude. Tracked in
  //      pyrycode/pyrycode follow-up (link in this PR).
  //   2. (this side, once 1 lands) `prepareAgentSpawn` adds a
  //      `disallowedTools` field to SpawnConfig, populated for ALL
  //      pipeline agents (every agent here is non-interactive).
  //
  // Shipping the dispatcher flag before pyry forwards it would break
  // production: pyry's `parseAgentRunArgs` errors on unknown flags.
  // So this test is `todo` — it locks in the *contract* now (what the
  // disallow list must contain), runs but doesn't fail CI, and flips
  // RED→GREEN as soon as both sides land.
  test(
    "disallowed-tools contract — AskUserQuestion/EnterPlanMode/ExitPlanMode stripped for all non-interactive agents",
    async () => {
      const REQUIRED_DISALLOWED = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"] as const;
      // Every pipeline agent is non-interactive — the disallow list
      // applies uniformly. (If a future agent role IS interactive,
      // narrow this when adding it.)
      const agents: Array<Partial<AgentConfig>> = [
        { name: "po",            column: "Backlog",          claudeMdPath: "po/CLAUDE.md",            usesWorktree: false, producesCommits: false },
        { name: "architect",     column: "In Architecture",  claudeMdPath: "architect/CLAUDE.md",     usesWorktree: true,  producesCommits: true  },
        { name: "developer",     column: "In Development",   claudeMdPath: "developer/CLAUDE.md",     usesWorktree: true,  producesCommits: true  },
        { name: "code-review",   column: "In Code Review",   claudeMdPath: "code-review/CLAUDE.md",   usesWorktree: true,  producesCommits: false },
        { name: "documentation", column: "In Documentation", claudeMdPath: "documentation/CLAUDE.md", usesWorktree: true,  producesCommits: true  },
      ];

      for (const a of agents) {
        const claudeMd = claudeMdAbsPath(a.claudeMdPath!);
        const { ctx } = makeTestContext({
          agent: a,
          item: { issueNumber: 270 },
          mockOptions: { fsMap: { [claudeMd]: `${a.name} system prompt` } },
        });

        const result = await prepareAgentSpawn(ctx);
        assert.ok(result.ok, `${a.name} prepareAgentSpawn must succeed`);
        const cfg = (result as { ok: true; config: any }).config;

        // CONTRACT (currently unmet — `cfg.disallowedTools` is undefined
        // until the spawn config gains the field):
        assert.ok(
          typeof cfg.disallowedTools === "string" && cfg.disallowedTools.length > 0,
          `${a.name} must declare disallowedTools (got ${JSON.stringify(cfg.disallowedTools)})`,
        );
        const disallowed = String(cfg.disallowedTools).split(",").map((s) => s.trim());
        for (const tool of REQUIRED_DISALLOWED) {
          assert.ok(
            disallowed.includes(tool),
            `${a.name} disallowedTools must include "${tool}" — non-interactive context cannot answer it`,
          );
        }
      }
    },
  );
});

// =====================================================================
// decideRefinementMode / buildModeSection — the po/refiner `## Mode` line
// =====================================================================
//
// Until 2026-09-21 every existing ticket (issueNumber > 0) was told it was
// a "rework — existing ticket routed back". Seven of eleven refiner runs
// on freshly split pyrycode-mobile children that day burned turns
// explaining a rework nobody had asked for. The signal is `rework-count:N`:
// `runReworkRouting` strips the `needs-rework:<agent>` trigger before the
// target is ever dispatched, and bumps that counter in the same pass.

describe("decideRefinementMode", () => {
  test("no ticket → create-from-inbox, whatever the labels say", () => {
    assert.equal(decideRefinementMode("po", { issueNumber: 0, labels: [] }), "create-from-inbox");
    assert.equal(decideRefinementMode("refiner", { issueNumber: 0, labels: ["rework-count:2"] }), "create-from-inbox");
  });

  test("existing ticket with no rework trail → refine (the freshly split child)", () => {
    // pyrycode-mobile #721's shape: size/priority tags, no comments, no
    // rework label in its history.
    assert.equal(decideRefinementMode("refiner", { issueNumber: 721, labels: [] }), "refine");
    assert.equal(decideRefinementMode("po", { issueNumber: 721, labels: ["size:S", "priority:high"] }), "refine");
  });

  test("rework-count:N left by the router → rework", () => {
    for (const agent of ["po", "refiner"]) {
      assert.equal(decideRefinementMode(agent, { issueNumber: 50, labels: ["size:M", "rework-count:1"] }), "rework");
      assert.equal(decideRefinementMode(agent, { issueNumber: 50, labels: ["rework-count:3"] }), "rework");
    }
  });

  test("the labels a real route leaves behind read as rework", () => {
    // What the target sees after `decideReworkRoutes` + the counter bump:
    // trigger and done:/wip:/error: trail stripped, counter added.
    const before = ["size:M", "done:refiner", "done:builder", "needs-rework:refiner"];
    const [route] = decideReworkRoutes(
      new Map([["refiner", "Backlog"], ["builder", "In Development"]]),
      new Map([["In Development", [{ id: "PVTI_1", issueNumber: 60, labels: before }]]]),
    );
    const after = [...before.filter(l => !route.labelsToStrip.includes(l)), "rework-count:1"];
    assert.deepEqual(after, ["size:M", "rework-count:1"]);
    assert.equal(decideRefinementMode("refiner", { issueNumber: 60, labels: after }), "rework");
  });

  test("a still-attached needs-rework:<self> counts; one naming another agent does not", () => {
    assert.equal(decideRefinementMode("refiner", { issueNumber: 61, labels: ["needs-rework:refiner"] }), "rework");
    assert.equal(decideRefinementMode("po", { issueNumber: 61, labels: ["needs-rework:po"] }), "rework");
    assert.equal(decideRefinementMode("refiner", { issueNumber: 61, labels: ["needs-rework:builder"] }), "refine");
  });

  test("malformed or zero counters are not a rework", () => {
    for (const label of ["rework-count:0", "rework-count:", "rework-count:abc", "rework-count:-1"]) {
      assert.equal(decideRefinementMode("refiner", { issueNumber: 62, labels: [label] }), "refine", label);
    }
  });

  test("unrelated pipeline state does not imply a rework", () => {
    // An error retry of a first refinement is still a first refinement.
    const labels = ["error-retry-count:1", "family-dispatches:4", "merge-attempt:1"];
    assert.equal(decideRefinementMode("refiner", { issueNumber: 63, labels }), "refine");
  });
});

describe("buildModeSection", () => {
  const refiner = { name: "refiner", column: "Backlog" };
  const po = { name: "po", column: "Backlog" };

  test("agents other than po/refiner get no mode section", () => {
    for (const name of ["architect", "developer", "builder", "verifier", "code-review", "qa", "documentation"]) {
      assert.equal(buildModeSection({ name, column: "In Development" }, { issueNumber: 70, labels: ["rework-count:1"] }, true), null, name);
    }
  });

  test("create-from-inbox line is unchanged", () => {
    const expected = "\n## Mode\ncreate-from-inbox — raw user request, draft a structured GitHub issue.";
    assert.equal(buildModeSection(po, { issueNumber: 0, labels: [] }, false), expected);
    assert.equal(buildModeSection(refiner, { issueNumber: 0, labels: [] }, false), expected);
  });

  test("first refinement never mentions being routed back as fact", () => {
    for (const agent of [po, refiner]) {
      for (const commentsIncluded of [false, true]) {
        const section = buildModeSection(agent, { issueNumber: 721, labels: ["size:S"] }, commentsIncluded);
        assert.ok(section, "po/refiner always get a mode section");
        assert.match(section, /^\n## Mode\nrefine — existing Backlog ticket, not a rework\./);
        assert.match(section, /No agent has routed it back/);
        assert.match(section, /first refinement/);
        assert.doesNotMatch(section, /\nrework —/);
        assert.doesNotMatch(section, /previous agent comments/i);
      }
    }
  });

  test("first-refinement line names the agent's own column", () => {
    const section = buildModeSection({ name: "refiner", column: "Refinement" }, { issueNumber: 722, labels: [] }, false);
    assert.match(section!, /existing Refinement ticket/);
  });

  test("rework with comments points at them and cites the counter", () => {
    const section = buildModeSection(refiner, { issueNumber: 80, labels: ["rework-count:2"] }, true);
    assert.equal(
      section,
      "\n## Mode\nrework — existing ticket routed back (ticket carries `rework-count:2`). " +
        "Read the previous agent comments above for the rework reason.",
    );
  });

  test("rework without comments does not point at a section that is not there", () => {
    const section = buildModeSection(po, { issueNumber: 81, labels: ["rework-count:1"] }, false);
    assert.ok(section);
    assert.match(section, /^\n## Mode\nrework — existing ticket routed back \(ticket carries `rework-count:1`\)\./);
    assert.match(section, /No ticket comments are included above/);
    assert.match(section, /gh issue view 81 --comments/);
    assert.doesNotMatch(section, /Read the previous agent comments above/);
  });

  test("rework signalled only by a live needs-rework label cites no counter", () => {
    const section = buildModeSection(refiner, { issueNumber: 82, labels: ["needs-rework:refiner"] }, true);
    assert.match(section!, /^\n## Mode\nrework — existing ticket routed back\. Read the previous/);
    assert.doesNotMatch(section!, /rework-count/);
  });
});

// =====================================================================
// selectUnansweredGateFailure — the implementer's `## Live Gate Failure`
// =====================================================================
//
// On pyrycode-mobile #996 (2026-09-24) the real-claude gate failed and
// routed the ticket to the builder, but the gate's comment never reached
// the builder's prompt. It redid the verifier's older, already-fixed
// finding and changed no code, so the same suite ran on the same tree.

describe("selectUnansweredGateFailure", () => {
  const report = {
    runError: null, timedOut: false, exitCode: 1,
    tally: {
      executed: 27, passed: 24, failed: 3, skipped: 0,
      failedNames: ["e2e.T#stopRunningTurn"], passedNames: [], timedOutTests: [], skipReasons: [],
      packageFailed: false, packageFailures: [], recognizedLines: 27,
    },
    command: "python3 scripts/android-test-gate.py live",
    branchName: "feature/996", baseRef: "origin/main",
    baseSha: "b".repeat(40), headSha: "h".repeat(40), commitsBehind: 0,
    durationMs: 416_800, outputPath: "/logs/gate.log", outputBytes: 3_800,
    baselineFailures: null, baselineSkipReason: "no baseline command configured for this fork", baselineOutputPath: null,
    rerunFailures: null, rerunSkipReason: "no baseline command configured for this fork", rerunOutputPath: null,
  };
  const gateFail = formatGateEvidenceComment({
    verdict: "fail", reason: "3 test(s) failed", report, minExecuted: 8,
    action: "moved it to **In Development**, added `needs-rework:builder`. `needs-real-claude` stays on, so this ticket must pass the gate again after the fix.",
  });
  const gateUnusable = formatGateEvidenceComment({
    verdict: "unusable", reason: "no report", report, minExecuted: 8,
    action: "left it in Inbox and added `error:real-claude-gate`. This needs a human.",
  });
  const parked = "## 🧪 Real-claude gate — parked for the live run\n\n3. **Fail** → add `needs-rework:builder` and move it to **In Development**.";
  const builderDone = "## 🤖 Builder — designs and implements\n\nbuilder agent has completed work on this ticket.\n\n<details>…</details>";
  const verifierFlagged = "## 🤖 Verifier — reviews PRs\n\nverifier agent flagged issues on this ticket → rework by **builder**.";
  const verifierPassed = "## 🤖 Verifier — reviews PRs\n\nverifier agent has completed work on this ticket.";
  const marker = "<!-- family-dispatch-marker -->\n🧮 Family dispatch 6: **builder** on #996";

  test("#996: a gate FAIL after the last builder report is returned", () => {
    const comments = [builderDone, verifierFlagged, builderDone, verifierPassed, parked, gateFail, marker];
    assert.equal(selectUnansweredGateFailure(comments, "builder"), gateFail);
  });

  test("a builder report after the gate FAIL means it was answered", () => {
    assert.equal(selectUnansweredGateFailure([builderDone, gateFail, marker, builderDone, verifierFlagged], "builder"), null);
  });

  test("the parked notice alone is not a gate failure", () => {
    assert.equal(selectUnansweredGateFailure([builderDone, verifierPassed, parked], "builder"), null);
  });

  test("a gate verdict that parks for a human is not a rework reason", () => {
    assert.equal(selectUnansweredGateFailure([builderDone, gateUnusable], "builder"), null);
  });

  test("another agent's completion does not count as the implementer's answer", () => {
    assert.equal(selectUnansweredGateFailure([gateFail, verifierPassed], "builder"), gateFail);
    assert.equal(selectUnansweredGateFailure([gateFail, builderDone], "developer"), gateFail);
  });

  test("no comments → null", () => {
    assert.equal(selectUnansweredGateFailure([], "builder"), null);
  });
});

// =====================================================================
// handleAgentResultErrors
// =====================================================================
//
// 6 tests: not-error pass-through, max_turns + ready PR (treat as
// success), max_turns + draft PR only (advance to safer-salvage),
// max_turns + safer-salvage success, gh pr list failure, non-max_turns
// throws to outer catch. Salvage path order matters — PR-already-exists
// runs first because safer-salvage explicitly skips drafts.

/** Compose a `StreamResult` with the fields handleAgentResultErrors reads. */
function streamResult(overrides: Partial<StreamResult> = {}): StreamResult {
  return {
    output: "",
    sessionId: "sess-test",
    isError: false,
    numTurns: 0,
    totalCostUsd: 0,
    durationMs: 0,
    usage: {},
    terminalReason: "stop",
    rawResult: {},
    hadPermissionDenial: false,
    stoppedAtDenial: false,
    deniedOpContent: null,
    lastAssistantText: null,
    timedOut: false,
    ...overrides,
  };
}

describe("handleAgentResultErrors", () => {
  test("timeout after commit and push recovers a clean branch as a blocked draft", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 1270 },
      mockOptions: {
        execImpls: { "gh pr list --head": () => "[]", "git status --porcelain": () => "" },
        spawnImpls: { "git diff --quiet": () => 1 },
      },
    });
    const recovered = await handleAgentResultErrors(
      streamResult({ isError: true, terminalReason: "", timedOut: true }), ctx,
    );
    assert.equal(recovered, true);
    assert.ok(!calls.exec.some(c => c.cmd.startsWith("git add")));
    assert.ok(!calls.spawn.some(c => c.cmd === "git" && c.args[0] === "commit"));
    assert.ok(calls.spawn.some(c => c.cmd === "git" && c.args[0] === "push"));
    const pr = calls.spawn.find(c => c.cmd === "gh" && c.args.includes("create"));
    assert.ok(pr?.args.includes("--draft"));
    assert.match(String(pr?.opts?.input), /already committed/);
    assert.ok(client.addLabelCalls.some(c => c.label === "error:max_turns_salvaged"));
    assert.ok(!client.addLabelCalls.some(c => c.label.startsWith("done:")));
  });

  for (const diffStatus of [0, 128]) {
    test(`clean branch with diff status ${diffStatus} cannot be recovered`, async () => {
      const { ctx, calls } = makeTestContext({
        mockOptions: {
          execImpls: { "gh pr list --head": () => "[]", "git status --porcelain": () => "" },
          spawnImpls: { "git diff --quiet": () => diffStatus },
        },
      });
      await assert.rejects(handleAgentResultErrors(
        streamResult({ isError: true, terminalReason: "", timedOut: true }), ctx,
      ), /Agent error/);
      assert.ok(calls.spawn.some(c => c.cmd === "git" && c.args[0] === "diff"));
      assert.ok(!calls.spawn.some(c => c.args[0] === "push" || c.cmd === "gh"));
    });
  }

  test("committed timeout work with a failing build cannot open a draft", async () => {
    const { ctx, calls } = makeTestContext({
      mockOptions: {
        execImpls: {
          "gh pr list --head": () => "[]",
          "git status --porcelain": () => "",
          "go build": () => execError({ stderr: "build failed" }),
        },
        spawnImpls: { "git diff --quiet": () => 1 },
      },
    });
    await assert.rejects(handleAgentResultErrors(
      streamResult({ isError: true, terminalReason: "", timedOut: true }), ctx,
    ), /Agent error/);
    assert.ok(!calls.spawn.some(c => c.args[0] === "push" || c.cmd === "gh"));
  });

  test("isError=false → returns false (no salvage, success path runs)", async () => {
    const { ctx, client, calls } = makeTestContext({ item: { issueNumber: 300 } });

    const saferSalvaged = await handleAgentResultErrors(streamResult({ isError: false }), ctx);

    assert.equal(saferSalvaged, false);
    // Hot exit: no execSync, no client mutations, no salvage paths.
    assert.equal(calls.exec.length, 0);
    assert.equal(client.addLabelCalls.length, 0);
    assert.equal(client.comments.length, 0);
  });

  test("max_turns + non-draft PR exists → returns false ('treating as success'); no salvage label", async () => {
    // The agent finished the work and ran out of turns on cleanup
    // (todo updates, etc.). PR already opened → treat as success.
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 301 },
      mockOptions: {
        execImpls: {
          // gh pr list returns a non-draft PR → findReadyPrNumber picks it.
          "gh pr list --head": () => `[{"number": 42, "isDraft": false}]`,
        },
      },
    });

    const saferSalvaged = await handleAgentResultErrors(
      streamResult({ isError: true, terminalReason: "max_turns" }),
      ctx,
    );

    assert.equal(saferSalvaged, false, "PR-already-exists path leaves saferSalvaged=false");
    // Crucially: no error:max_turns_salvaged label — that's only the
    // safer-salvage path. PR-already-exists is a full success.
    assert.ok(
      !client.addLabelCalls.some(c => c.label === "error:max_turns_salvaged"),
      "PR-already-exists must not apply the salvage block label",
    );
  });

  test("max_turns + draft PR only → drafts skipped, advances to safer-salvage path (which succeeds here)", async () => {
    // The salvage-path-order invariant: gh pr list returns ONLY draft
    // PRs, so the PR-already-exists path's `findReadyPrNumber` returns
    // null and we fall through to safer-salvage. Without the
    // skip-drafts discipline, a draft (often the salvage helper's own
    // earlier output) would get treated as success and auto-advance
    // partial work — defeating the entire safer-salvage design.
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 302 },
      mockOptions: {
        execImpls: {
          "gh pr list --head": () => `[{"number": 99, "isDraft": true}]`,
          // Safer-salvage gates: dirty + clean vet + clean build.
          "git status --porcelain": () => "M file.go\n",
          // go vet + go build default to success (empty exec impl).
        },
        // attemptSaferSalvage's commit + push + pr-create all spawn.
        // Default spawnSync returns status:0 → all succeed.
      },
    });

    const saferSalvaged = await handleAgentResultErrors(
      streamResult({ isError: true, terminalReason: "max_turns", output: "agent log tail" }),
      ctx,
    );

    assert.equal(saferSalvaged, true, "draft-only PR must NOT short-circuit; safer-salvage must run");
    assert.ok(
      client.addLabelCalls.some(c => c.label === "error:max_turns_salvaged"),
      "safer-salvage must apply the global-block label",
    );
  });

  test("max_turns + safer-salvage success → returns true, salvage label applied, draft PR opened", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 303 },
      mockOptions: {
        execImpls: {
          "gh pr list --head": () => "[]",                  // no PR → fall through
          "git status --porcelain": () => "M new.go\n",     // dirty → salvage gate passes
          // go vet + go build default to success.
        },
      },
    });

    const saferSalvaged = await handleAgentResultErrors(
      streamResult({ isError: true, terminalReason: "max_turns", numTurns: 70, totalCostUsd: 4.74, output: "last agent message" }),
      ctx,
    );

    assert.equal(saferSalvaged, true);
    assert.ok(
      client.addLabelCalls.some(c => c.label === "error:max_turns_salvaged"),
      "salvage path must apply the global-block label",
    );
    // Draft PR creation via spawnSync gh pr create.
    const ghPrCreate = calls.spawn.find(s => s.cmd === "gh" && s.args.includes("pr") && s.args.includes("create"));
    assert.ok(ghPrCreate, "salvage must invoke `gh pr create`");
    assert.ok(ghPrCreate!.args.includes("--draft"), "salvage PR must be a DRAFT");
    // Salvage comment posted to the issue.
    assert.ok(client.comments.some(c => /Salvaged from `max_turns`/.test(c.body)));
  });

  test("gh pr list fails → SALVAGE_GH_FAILED warn, falls through; throws when neither salvage applies", async () => {
    // Transient gh failure (network, auth, rate limit) was previously
    // swallowed and downgraded a possible-success outcome to error.
    // Now: surface the gh failure in the log + fall through. If
    // safer-salvage also doesn't apply (clean tree), throw — same
    // shape as a non-salvaged crash.
    const { ctx } = makeTestContext({
      item: { issueNumber: 304 },
      mockOptions: {
        execImpls: {
          "gh pr list --head": () => execError({ stderr: "gh: API rate limit" }),
          // Clean tree → safer-salvage gates fail → throws.
          "git status --porcelain": () => "",
        },
      },
    });

    await assert.rejects(
      handleAgentResultErrors(
        streamResult({ isError: true, terminalReason: "max_turns" }),
        ctx,
      ),
      /Agent error \(max_turns\)/,
      "must throw when both salvage paths fail",
    );
  });

  test("non-max_turns error → throws to outer catch (different failure shape, no salvage applies)", async () => {
    const { ctx, calls } = makeTestContext({ item: { issueNumber: 305 } });

    await assert.rejects(
      handleAgentResultErrors(
        streamResult({ isError: true, terminalReason: "api_error", output: "Anthropic API failure" }),
        ctx,
      ),
      /Agent error \(api_error\)/,
    );
    // Sanity: neither salvage path was probed (gh pr list runs only
    // for max_turns; same for safer-salvage).
    assert.equal(calls.exec.filter(c => c.cmd.includes("gh pr list")).length, 0);
    assert.equal(calls.exec.filter(c => c.cmd.includes("git status")).length, 0);
  });

  test("error_during_execution wedge → error surfaces subtype + api_error_status from rawResult, labels the narration", async () => {
    // The 2.1.199 wedge: claude emits a `result` with an EMPTY terminal_reason
    // (so the old message was `Agent error ()`) whose `result` text is just the
    // agent's last narration, NOT the failure cause. The real signal lives in
    // rawResult (subtype / api_error_status / stop_reason) and was dropped.
    const { ctx } = makeTestContext({ item: { issueNumber: 320 } });

    await assert.rejects(
      handleAgentResultErrors(
        streamResult({
          isError: true,
          terminalReason: "", // empty — the "Agent error ()" case
          output: "Let me check the commit messages before finalizing.", // narration, not the error
          rawResult: {
            subtype: "error_during_execution",
            is_error: true,
            api_error_status: { status: 500, message: "Internal server error" },
            stop_reason: "tool_use",
          },
        }),
        ctx,
      ),
      (err: Error) => {
        const m = String(err.message);
        // Structured cause surfaced instead of an empty ():
        assert.match(m, /error_during_execution/);
        assert.match(m, /api_error_status/);
        assert.match(m, /500/);
        // Narration kept but explicitly NOT presented as the failure cause:
        assert.match(m, /Last agent text/i);
        assert.match(m, /Let me check the commit messages/);
        return true;
      },
    );
  });

  test("failure message carries wall-clock duration + the timeout budget so a timeout kill is legible", async () => {
    // A `parent_canceled` on its own can't be told apart from a
    // dispatcher wall-clock timeout SIGTERM without the run duration.
    // The failure comment now states how long the run took and the
    // stage's timeout budget, so "ran ~= budget" reads as a timeout.
    // Default agent is `developer` (25min budget), default labels [].
    const { ctx } = makeTestContext({ item: { issueNumber: 321 } });

    await assert.rejects(
      handleAgentResultErrors(
        streamResult({
          isError: true,
          terminalReason: "parent_canceled",
          output: "extracting the failing test names",
        }),
        ctx,
      ),
      (err: Error) => {
        const m = String(err.message);
        assert.match(m, /parent_canceled/);
        // Wall-clock duration is present (Xm Ys shape).
        assert.match(m, /\d+m \d+s/);
        // Timeout budget is stated, and for the developer default it's 25min.
        assert.match(m, /timeout 25min/);
        return true;
      },
    );
  });

  // ===================================================================
  // Permission-denial salvage (#8 Layer 2)
  // ===================================================================
  //
  // Covers the salvage routing when `hadPermissionDenial` is set on the
  // stream result. Two paths: clean+dirty WIP → draft PR + label +
  // comment; no-WIP-or-failing-gates → label + comment only (no PR
  // because we don't ship broken/empty drafts).

  test("hadPermissionDenial=true + dirty WIP + clean gates → draft PR + error:<agent>:permission_denied label + diagnostic comment", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 310, title: "ticket title" },
      mockOptions: {
        execImpls: {
          // Salvage path probes git status + runs build gates + git
          // add/commit + push. Default success across the board.
          "git status --porcelain": () => "M file.go\n",
        },
      },
    });

    const saferSalvaged = await handleAgentResultErrors(
      streamResult({
        isError: true,
        terminalReason: "permission_denied",
        hadPermissionDenial: true,
        deniedOpContent: "Permission to use Bash with command `git reset --hard HEAD~1` has been denied.",
        lastAssistantText: "I'm trying to undo the revert commit.",
      }),
      ctx,
    );

    assert.equal(saferSalvaged, true);
    // Distinct label (NOT generic error:developer, NOT max_turns_salvaged).
    assert.ok(
      client.addLabelCalls.some((c) => c.label === "error:developer:permission_denied"),
      "must apply error:developer:permission_denied",
    );
    assert.ok(
      !client.addLabelCalls.some((c) => c.label === "error:developer"),
      "must NOT apply generic error:developer",
    );
    assert.ok(
      !client.addLabelCalls.some((c) => c.label === "error:max_turns_salvaged"),
      "must NOT apply max_turns label (wrong failure mode)",
    );
    // Diagnostic comment quotes denied op + agent intent.
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /Salvaged from `permission_denied`/);
    assert.match(client.comments[0]!.body, /git reset --hard/);
    // gh pr create --draft was invoked.
    const ghCalls = calls.spawn.filter((s) => s.cmd === "gh" && s.args[0] === "pr" && s.args.includes("--draft"));
    assert.equal(ghCalls.length, 1);
    assert.ok(ghCalls[0]!.args.includes("[permission_denied] ticket title"),
      "draft PR title must carry the permission_denied prefix");
    // Discord notify fires (💾 salvage shape).
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /💾.*developer.*permission-denied salvaged/);
  });

  test("hadPermissionDenial=true + clean worktree → label + diagnostic comment, NO draft PR", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 311 },
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",  // clean — no WIP to salvage
        },
      },
    });

    const saferSalvaged = await handleAgentResultErrors(
      streamResult({
        isError: true,
        terminalReason: "permission_denied",
        hadPermissionDenial: true,
        deniedOpContent: "Permission to use Bash with command `git push --force` has been denied.",
        lastAssistantText: "Force-pushing to clean up history.",
      }),
      ctx,
    );

    assert.equal(saferSalvaged, true, "salvage 'succeeds' even when there's nothing to ship — label + comment is the recovery");
    assert.ok(
      client.addLabelCalls.some((c) => c.label === "error:developer:permission_denied"),
    );
    // No draft PR was opened (nothing to ship).
    const ghCalls = calls.spawn.filter((s) => s.cmd === "gh" && s.args[0] === "pr" && s.args.includes("--draft"));
    assert.equal(ghCalls.length, 0, "must not open a draft PR when worktree is clean");
    // Comment explains the no-PR outcome + quotes the denied op.
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /Permission Denied — agent halted/);
    assert.match(client.comments[0]!.body, /git push --force/);
    assert.match(client.comments[0]!.body, /Worktree was clean/);
    // Discord notify fires with the no-salvage variant.
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /⛔.*permission-denied/);
  });

  // pyrycode#2586: the verifier hit a denial, obeyed Layer 1 and exited
  // cleanly (is_error=false). The isError early-return skipped the denial
  // salvage, and the ticket got the generic missing-verdict error.
  test("clean exit that stopped at a denial → error:<agent>:permission_denied, not the success path", async () => {
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 312 },
      mockOptions: { execImpls: { "git status --porcelain": () => "" } },
    });

    const saferSalvaged = await handleAgentResultErrors(
      streamResult({
        isError: false,
        terminalReason: "completed",
        hadPermissionDenial: true,
        stoppedAtDenial: true,
        deniedOpContent: "Permission to use Bash with command `codex app-server generate-json-schema` has been denied.",
        lastAssistantText: "I stopped the review before posting anything, because a command was denied.",
      }),
      ctx,
    );

    assert.equal(saferSalvaged, true, "must suppress the success path");
    assert.ok(client.addLabelCalls.some((c) => c.label === "error:developer:permission_denied"));
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /Permission Denied — agent halted/);
    assert.match(client.comments[0]!.body, /generate-json-schema/);
  });

  test("clean exit that carried on past a denial → success path, no labels", async () => {
    const { ctx, client } = makeTestContext({ item: { issueNumber: 313 } });

    const saferSalvaged = await handleAgentResultErrors(
      streamResult({
        isError: false,
        terminalReason: "completed",
        hadPermissionDenial: true,
        stoppedAtDenial: false,
        deniedOpContent: "Permission to use Bash with command `rm -rf /tmp/x` has been denied.",
      }),
      ctx,
    );

    assert.equal(saferSalvaged, false);
    assert.equal(client.addLabelCalls.length, 0);
    assert.equal(client.comments.length, 0);
  });

  test("hadPermissionDenial=true runs salvage BEFORE max_turns paths (permission_denied wins routing)", async () => {
    // Defensive: if the stream emitted both a max_turns terminal AND a
    // denial earlier, route as permission_denied. The max_turns paths
    // assume a normal-shutdown stream; permission denial overrides.
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 312 },
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          // If max_turns path ran, it would probe gh pr list. Assert
          // below that it didn't.
          "gh pr list --head": () => "[]",
        },
      },
    });

    await handleAgentResultErrors(
      streamResult({
        isError: true,
        terminalReason: "max_turns",  // would normally route to max_turns salvage
        hadPermissionDenial: true,    // but denial wins
        deniedOpContent: "Permission to use Bash with command `rm -rf /tmp/foo` has been denied.",
      }),
      ctx,
    );

    assert.ok(
      client.addLabelCalls.some((c) => c.label === "error:developer:permission_denied"),
      "must apply permission_denied label, not max_turns_salvaged",
    );
    assert.ok(
      !client.addLabelCalls.some((c) => c.label === "error:max_turns_salvaged"),
    );
  });
});

// =====================================================================
// handlePostRun
// =====================================================================
//
// 10 tests covering the post-success side-effect chain:
// - Push failure (the 2026-05-07 #155 lineage) and empty-branch guard
//   (the 2026-05-08 relay #5 incident) — both return {ok:false} and
//   DELIBERATELY skip cleanupAfterDispatch (worktree preserved as
//   evidence). Today's behavior; preserve verbatim.
// - decidePostRunLabels integration (4 logKind branches): ready,
//   rework, moved-out, status-unknown.
// - saferSalvaged invariant: when true, post-success labeling +
//   success comment + success Discord all suppressed.
// - Legacy `needs-rework` strip path.

const STREAM_OK = (): StreamResult => streamResult({
  output: "agent finished cleanly",
  isError: false,
  numTurns: 30,
  totalCostUsd: 1.23,
  durationMs: 60_000,
  usage: { input_tokens: 100, output_tokens: 200 },
});

describe("handlePostRun — failure modes", () => {
  test("push fails (non-fast-forward) → error:<agent> label + comment + {ok:false}", async () => {
    // The 2026-05-07 #155 lineage: code-review on stale worktree,
    // verdict failed, tried to push review comments, hit non-fast-forward
    // because someone pushed out-of-band during the run. Pre-fix the
    // dispatcher swallowed the push failure and continued to apply
    // done:code-review + auto-advance.
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 400 },
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",  // clean → no auto-commit
          "git push -u origin": () => execError({
            stderr: "! [rejected]        feature/400 -> feature/400 (non-fast-forward)",
          }),
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 400, label: "error:developer" }]);
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /git push/);
    assert.match(client.comments[0]!.body, /non-fast-forward/);
    // Crucially: no `done:developer` was applied. Push success is the
    // precondition for treating the agent's verdict as canonical.
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:developer"));
  });

  test("empty branch + agent-produces-commits → error:<agent> label + comment + {ok:false}", async () => {
    // The 2026-05-08 relay #5 incident: agent did the right thing
    // prose-wise (refused to act without prereqs) but produced 0
    // commits — dispatcher had no deterministic check that the prose
    // matched the branch state. The empty-branch guard is the
    // deterministic backstop.
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 401 },
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          // push succeeds, but the branch is 0 ahead of main.
          "git rev-list --count main..": () => "0\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 401, label: "error:developer" }]);
    assert.match(client.comments[0]!.body, /produced no commits/);
    assert.match(client.comments[0]!.body, /0 commits ahead of/);
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:developer"));
  });

  test("empty branch + saferSalvaged=true → guard skipped, no error label, salvage stays canonical", async () => {
    // The salvage-doesn't-fire-empty-branch invariant: salvage already
    // labeled error:max_turns_salvaged and opened a draft PR with
    // whatever WIP existed. The guard would falsely fire on a 0-ahead
    // branch otherwise, replacing the salvage label with error:<agent>
    // and breaking the global block.
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 402 },
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "0\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, /* saferSalvaged */ true);

    assert.deepEqual(result, { ok: true });
    // Crucially: NO error:developer applied even though branch is 0 ahead.
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:developer"));
    // Post-success labeling is also gated on !saferSalvaged → no ready label.
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:developer"));
  });

  test("empty branch + architect added needs-rework:po → guard skipped (legitimate bail, no false-positive error:architect)", async () => {
    // Surfaced on `pyrycode-relay#26` (2026-05-10): architect ran 24
    // turns, did file-overlap check correctly, found `feature/25` and
    // `feature/7` overlap, wired addBlockedBy, posted triage comment,
    // applied `needs-rework:po`, exited success. Got a false-positive
    // `error:architect` because `feature/26` was 0 ahead of main —
    // the architect deliberately didn't write a spec.
    //
    // The fix in `shouldFlagEmptyBranch` reads postLabels and skips
    // the flag when any `needs-rework:*` is present. This test locks
    // in the end-to-end behavior through `handlePostRun`.
    const client = new MockGitHubClient({
      status: { 426: "In Architecture" },
      labels: { 426: ["needs-rework:po"] },  // architect added during run
    });
    const { ctx, calls } = makeTestContext({
      agent: { name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md", usesWorktree: true, producesCommits: true },
      item: { issueNumber: 426 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "0\n",  // architect wrote no spec
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true }, "architect bail must not propagate as ok:false");
    // Critical: NO error:architect applied despite 0-commit branch.
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:architect"),
      "needs-rework:po + 0 commits is a legitimate bail; must NOT add error:architect");
    // No empty-branch error comment posted either.
    assert.ok(!client.comments.some(c => c.body.includes("produced no commits")),
      "empty-branch error comment must not be posted on legitimate bail");
    // The rework signal is preserved on the ticket — runReworkRouting
    // (separate maintenance pass) will pick it up next cycle.
    // (decidePostRunLabels won't add done:architect either, because
    // postLabels has needs-rework:po — that's tested in lib.test.ts.)
  });

  // pyrycode#2569 (2026-09-24): the builder ended its turn before opening
  // the PR, the run exited cleanly, and the ticket rode done:builder all the
  // way to Done with nothing for auto-merge to merge.
  const BUILDER = { name: "builder", column: "In Development", claudeMdPath: "builder/CLAUDE.md", usesWorktree: true, producesCommits: true, opensPr: true };

  test("builder exits cleanly with no open PR → error:builder + comment + {ok:false}", async () => {
    const client = new MockGitHubClient({ status: { 2569: "In Development" }, labels: { 2569: [] } });
    const { ctx } = makeTestContext({
      agent: BUILDER,
      item: { issueNumber: 2569 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "2\n",
          "gh pr list --head": () => "[]",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 2569, label: "error:builder" }]);
    assert.match(client.comments[0]!.body, /ended without opening a PR/);
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:builder"));
  });

  test("builder exits cleanly with an open PR → done:builder as before", async () => {
    const client = new MockGitHubClient({ status: { 2570: "In Development" }, labels: { 2570: [] } });
    const { ctx } = makeTestContext({
      agent: BUILDER,
      item: { issueNumber: 2570 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "2\n",
          "gh pr list --head": () => JSON.stringify([{ number: 2630 }]),
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true });
    assert.ok(client.addLabelCalls.some(c => c.label === "done:builder"));
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:builder"));
  });

  test("empty branch + architect added needs-human:sizing → error:architect (a stop is now a deviation)", async () => {
    // The end-to-end mirror of the unit test in lib.test.ts. When the
    // split-depth gate meant "stop and wait for a person", an empty
    // branch here was expected and the guard was suppressed. The
    // prompts shipped alongside this commit tell the agent to record the
    // split it would have made, apply the label as a marker and write
    // the spec anyway, so an empty branch now means it stopped when it
    // was told to continue.
    //
    // That has to reach a human. The alternative is `done:architect` on
    // a ticket with no spec, and a developer dispatched against it.
    const client = new MockGitHubClient({
      status: { 1938: "In Architecture" },
      labels: { 1938: ["size:s", "done:po", "needs-human:sizing"] },
    });
    const { ctx } = makeTestContext({
      agent: { name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md", usesWorktree: true, producesCommits: true },
      item: { issueNumber: 1938 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "0\n",  // no spec written
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: false }, "a specless architect run must not report success");
    assert.ok(client.addLabelCalls.some(c => c.label === "error:architect"),
      "an empty branch under the continue-by-default prompts is a deviation and must be flagged");
    assert.ok(client.comments.some(c => c.body.includes("produced no commits")),
      "the empty-branch diagnostic comment must be posted");
  });

  test("empty branch + agent-doesn't-produce-commits (code-review) → guard skipped via shouldFlagEmptyBranch", async () => {
    // code-review uses a worktree (reads code locally to review) but
    // its output is PR comments via `gh pr review` — never commits.
    // Empty branch on code-review is expected; guard must not fire.
    const client = new MockGitHubClient({
      status: { 403: "In Code Review" },
      labels: { 403: [] },
    });
    const { ctx } = makeTestContext({
      agent: { name: "code-review", column: "In Code Review", claudeMdPath: "code-review/CLAUDE.md", usesWorktree: true, producesCommits: false },
      item: { issueNumber: 403 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "0\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true }, "code-review with 0 commits is the expected case");
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:code-review"));
    // Code-review still gets done:code-review (the agent's column hasn't moved).
    assert.ok(client.addLabelCalls.some(c => c.label === "done:code-review"));
  });
});

describe("handlePostRun — decidePostRunLabels integration", () => {
  test("addReadyLabel=true (happy path) → done:<agent> + completion comment + no Discord notify", async () => {
    const client = new MockGitHubClient({
      status: { 410: "In Development" },     // matches developer.column
      labels: { 410: [] },                   // no rework target
    });
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 410 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "1\n",  // 1 commit, not empty
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true });
    assert.ok(client.addLabelCalls.some(c => c.label === "done:developer"));
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /completed work on this ticket/);
    assert.match(client.comments[0]!.body, /Ready for human review/);
    // Success ping dropped 2026-06-07 (operator noise reduction) — the
    // happy path completes silently; review is driven by the label + comment.
    assert.equal(calls.discord.length, 0);
  });

  test("addReadyLabel=true with prior done:po → strips done:po then adds done:architect (the relay #7 fix)", async () => {
    // Architect runs successfully on a ticket that PO refined earlier.
    // PO's `done:po` is still on the ticket because runAutoAdvance
    // moves columns without stripping. After this fix, handlePostRun
    // strips the prior `done:po` before applying `done:architect`.
    // Order matters: strip-before-add prevents a transient state where
    // both labels exist between API calls.
    const client = new MockGitHubClient({
      status: { 415: "In Architecture" },
      labels: { 415: ["done:po", "size:s", "security-sensitive"] },
    });
    const { ctx } = makeTestContext({
      agent: { name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md", usesWorktree: true, producesCommits: true },
      item: { issueNumber: 415 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "1\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true });

    // Prior `done:po` was stripped.
    assert.ok(
      client.removeLabelCalls.some(c => c.issueNumber === 415 && c.label === "done:po"),
      "prior done:po must be stripped",
    );

    // `done:architect` was added.
    assert.ok(
      client.addLabelCalls.some(c => c.issueNumber === 415 && c.label === "done:architect"),
      "done:architect must be added",
    );

    // Non-pipeline labels (`size:s`, `security-sensitive`) untouched.
    assert.ok(
      !client.removeLabelCalls.some(c => c.issueNumber === 415 && c.label === "size:s"),
      "size:s is not a pipeline-state label, must not be stripped",
    );
    assert.ok(
      !client.removeLabelCalls.some(c => c.issueNumber === 415 && c.label === "security-sensitive"),
      "security-sensitive is metadata, must not be stripped",
    );

    // Strip-before-add order is asserted via labelOps in the dedicated
    // "strip-before-add order" test below.
  });

  test("strip-before-add order: prior done:* removes precede done:<self> add in unified labelOps log (multi-prior)", async () => {
    // Contract: handlePostRun strips prior `done:*` labels via sequential
    // awaits BEFORE adding `done:<self>`. The ticket must never observably
    // hold both labels simultaneously between API calls — a board observer
    // (or another agent's pre-dispatch fetch) seeing `done:po + done:architect
    // + done:developer` mid-window would be misled about pipeline state.
    //
    // Asserted via MockGitHubClient.labelOps — a unified add/remove call
    // log in chronological push order. Multi-prior shape (developer running
    // after PO + architect) doubles as integration coverage for the
    // multi-prior strip case (only pure-tested in lib.test.ts otherwise).
    const client = new MockGitHubClient({
      status: { 416: "In Development" },
      labels: { 416: ["done:po", "done:architect", "size:s"] },
    });
    const { ctx } = makeTestContext({
      // Default agent in makeTestContext is developer / In Development.
      item: { issueNumber: 416 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "1\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);
    assert.deepEqual(result, { ok: true });

    // Filter to this issue's label ops (other tests may share the mock
    // module — though each test instantiates its own client so this is
    // belt-and-suspenders).
    const ops = client.labelOps.filter(o => o.issueNumber === 416);

    // Expected exact sequence:
    //   1. remove done:po       (first prior, in postLabels order)
    //   2. remove done:architect (second prior)
    //   3. add    done:developer (this agent's ready, AFTER both strips)
    // size:s is non-pipeline → not stripped, not in this log.
    assert.deepEqual(
      ops,
      [
        { op: "remove", issueNumber: 416, label: "done:po" },
        { op: "remove", issueNumber: 416, label: "done:architect" },
        { op: "add",    issueNumber: 416, label: "done:developer" },
      ],
      "all prior done:* strips must precede the done:<self> add",
    );
  });

  test("removeLabel failure on prior done:* is non-fatal — done:<self> still added", async () => {
    // Contract: each prior-strip removeLabel is wrapped in try/catch and
    // logs a warning on failure. Stale prior labels are cosmetic, not
    // state-bearing for dispatch decisions; a label-strip blip (network
    // glitch, label already removed by a concurrent dispatcher cycle,
    // GraphQL 503) must not block done:<self> from landing — that would
    // break auto-advance for the next agent and turn a transient label
    // problem into a stuck ticket.
    const client = new MockGitHubClient({
      status: { 417: "In Development" },
      labels: { 417: ["done:po", "done:architect"] },
    });
    // Inject failure on the FIRST strip; second strip + add still proceed.
    client.failures.removeLabel = (_n, label) =>
      label === "done:po" ? new Error("simulated GraphQL 503") : null;

    const { ctx } = makeTestContext({
      item: { issueNumber: 417 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "1\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);
    assert.deepEqual(result, { ok: true }, "post-run must not throw on a single removeLabel failure");

    // Both removeLabel attempts were made — push to removeLabelCalls
    // happens before the failure check, so a failed call is recorded.
    assert.ok(
      client.removeLabelCalls.some(c => c.issueNumber === 417 && c.label === "done:po"),
      "first strip was attempted (and recorded) even though it failed",
    );
    assert.ok(
      client.removeLabelCalls.some(c => c.issueNumber === 417 && c.label === "done:architect"),
      "second strip proceeds after the first one failed — try/catch isolates failures",
    );
    // done:<self> still landed despite the strip failure.
    assert.ok(
      client.addLabelCalls.some(c => c.issueNumber === 417 && c.label === "done:developer"),
      "done:<self> must still be applied even if a prior-label strip failed",
    );
  });

  test("rework path with prior done:* → handlePostRun does NOT strip (runReworkRouting handles it)", async () => {
    // When `addReadyLabel === false` because rework was requested,
    // handlePostRun's prior-strip block is skipped. `runReworkRouting`
    // (in reconcile.ts) strips ALL `done:/wip:/error:` labels when it
    // routes the ticket back upstream — pre-empting that here would
    // duplicate work AND potentially strip labels the upstream agent
    // might want to see during its own pre-dispatch state read.
    //
    // This test guards against a refactor that "helpfully" widens
    // the strip to all post-run paths.
    const client = new MockGitHubClient({
      status: { 418: "In Development" },
      labels: { 418: ["done:po", "done:architect", "needs-rework:po"] },
    });
    const { ctx } = makeTestContext({
      item: { issueNumber: 418 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "1\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);
    assert.deepEqual(result, { ok: true });

    // No `done:<self>` added (rework path wins per shouldAddReadyLabel).
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:developer"));

    // Critical: no prior `done:*` stripped here. runReworkRouting will
    // strip them on the next reconcile pass when it routes the ticket
    // back to PO.
    const readyStrips = client.removeLabelCalls.filter(
      c => c.issueNumber === 418 && c.label.startsWith("done:"),
    );
    assert.deepEqual(
      readyStrips, [],
      "rework path must not strip prior done:* labels in handlePostRun — runReworkRouting owns that",
    );
  });

  test("logKind=rework → no ready label, rework comment, no success Discord", async () => {
    const client = new MockGitHubClient({
      status: { 411: "In Development" },
      labels: { 411: ["needs-rework:po"] },  // explicit rework target
    });
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 411 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "1\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true });
    // No `done:developer` (rework target wins per shouldAddReadyLabel).
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:developer"));
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /rework by \*\*po\*\*/);
    assert.match(client.comments[0]!.body, /Needs rework by po/);
    // Success ping dropped 2026-06-07 — the post-run path no longer notifies
    // Discord on success OR rework. Rework triage is driven by the labels and
    // the rework completion comment, not a Discord ping.
    assert.equal(calls.discord.length, 0);
  });

  test("logKind=moved-out → agent moved ticket out of column, no ready label, no rework comment", async () => {
    // PO splitting parent → moves ticket to Done. addReadyLabel=false
    // because currentColumn !== agentColumn. logKind=moved-out.
    const client = new MockGitHubClient({
      status: { 412: "Done" },               // PO moved it
      labels: { 412: [] },
    });
    const { ctx } = makeTestContext({
      agent: { name: "po", column: "Backlog", claudeMdPath: "po/CLAUDE.md", usesWorktree: false, producesCommits: false },
      item: { issueNumber: 412 },
      client,
      // PO has useWorktree=false → no git push / empty-branch ops to mock.
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true });
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:po"),
      "moved-out path must not apply done:<agent>");
    // Comment still posted (the success-with-output comment), but no
    // rework framing.
    assert.equal(client.comments.length, 1);
    assert.ok(!/Needs rework by/.test(client.comments[0]!.body));
  });

  test("logKind=status-unknown (getItemStatus throws) → no ready label, no error", async () => {
    const client = new MockGitHubClient({
      labels: { 413: [] },
      // status omitted → getItemStatus returns null by default
      defaultStatus: null,
    });
    client.failures.getItemStatus = new Error("graphql 503");
    const { ctx } = makeTestContext({
      item: { issueNumber: 413 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "1\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true }, "post-run must not throw on getItemStatus failure");
    // Cautious default: skip done:<agent> when we can't confirm the column.
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:developer"));
    // ...but defer the decision instead of dropping it, so the next cycle
    // does not re-dispatch the developer on finished work.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 413 && c.label === "pending-done:developer"));
  });

  test("status-unknown and the pending label cannot be written either → still no throw, no done label", async () => {
    const client = new MockGitHubClient({ labels: { 414: [] }, defaultStatus: null });
    client.failures.getItemStatus = new Error("graphql rate limit");
    client.failures.addLabel = new Error("REST 502");
    const { ctx } = makeTestContext({
      item: { issueNumber: 414 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "1\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true });
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:developer"));
  });
});

describe("handlePostRun — coverage edges", () => {
  test("saferSalvaged=true suppresses ready label + success comment + success Discord notify", async () => {
    // The salvage-doesn't-auto-advance invariant. attemptSaferSalvage
    // already labeled error:max_turns_salvaged + opened a draft PR +
    // posted its own salvage comment + sent its own Discord notify.
    // handlePostRun must not re-emit any of those signals as success.
    const client = new MockGitHubClient({
      status: { 420: "In Development" },
      labels: { 420: ["error:max_turns_salvaged"] },
    });
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 420 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "0\n",  // salvage may not have produced commits
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, /* saferSalvaged */ true);

    assert.deepEqual(result, { ok: true });
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:developer"),
      "salvage path must not apply done:<agent>");
    // No success comment (the post-success block is gated on !saferSalvaged).
    assert.equal(client.comments.length, 0);
    // No success Discord notify (also gated on !saferSalvaged).
    assert.equal(calls.discord.length, 0);
  });

  test("shouldStripLegacyNeedsRework=true → removeLabel('needs-rework') called", async () => {
    // Legacy `needs-rework` (no suffix) on the ticket: dispatcher's
    // pre-prefix-scheme semantics treats it as "this agent's work
    // needs rework by this same agent". decidePostRunLabels flags
    // shouldStripLegacyNeedsRework so the caller cleans it up.
    const client = new MockGitHubClient({
      status: { 421: "In Development" },
      labels: { 421: ["needs-rework"] },     // legacy form
    });
    const { ctx } = makeTestContext({
      item: { issueNumber: 421 },
      client,
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "1\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true });
    assert.ok(
      client.removeLabelCalls.some(c => c.issueNumber === 421 && c.label === "needs-rework"),
      "legacy needs-rework must be stripped",
    );
  });
});

// =====================================================================
// handleDispatchError
// =====================================================================
//
// 4 tests: with-sessionId (resume hint surfaces), null streamResult
// (no resume hint), issue-0 manual dispatch (no GH side effects), and
// silent-catch on label/comment failure.

describe("handleDispatchError", () => {
  test("streamResult with sessionId → resume hint in error log + comment", async () => {
    const { ctx, client, calls } = makeTestContext({ item: { issueNumber: 500 } });

    await handleDispatchError(
      new Error("agent crashed mid-run"),
      ctx,
      streamResult({ sessionId: "sess-abc-123" }),
    );

    // Label + comment fired.
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 500, label: "error:developer" }]);
    assert.equal(client.comments.length, 1);
    // Resume hint surfaces in the comment Body — load-bearing for
    // JSONL-replay recovery (the path that recovered #27's spec).
    assert.match(client.comments[0]!.body, /claude --resume sess-abc-123/);
    // Discord notify fires once.
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /❌.*developer.*failed on #500/);
  });

  test("streamResult is null → 'unknown' sessionId, no resume hint in comment", async () => {
    const { ctx, client } = makeTestContext({ item: { issueNumber: 501 } });

    await handleDispatchError(new Error("setup failed before stream"), ctx, null);

    assert.equal(client.comments.length, 1);
    assert.ok(
      !/claude --resume/.test(client.comments[0]!.body),
      "no sessionId → no resume hint (would be misleading)",
    );
  });

  test("issue-0 manual dispatch → console.error + Discord notify only, no label/comment", async () => {
    // Issue 0 (and any issueNumber <= 0) means there's no GitHub
    // ticket to label/comment on — the manual-dispatch CLI path.
    // Discord notify still fires (operator visibility), but no
    // GitHub-side mutations.
    const { ctx, client, calls } = makeTestContext({ item: { issueNumber: 0 } });

    await handleDispatchError(new Error("manual dispatch crashed"), ctx, null);

    assert.equal(client.addLabelCalls.length, 0, "issue-0 must not addLabel");
    assert.equal(client.comments.length, 0, "issue-0 must not addComment");
    assert.equal(calls.discord.length, 1, "Discord notify still fires for operator visibility");
  });

  test("addLabel + addComment both fail → silent catch, function still completes (Discord still notified)", async () => {
    // The label/comment side effects are wrapped in `try {}` blocks
    // that swallow errors — the dispatcher must not crash when the
    // GitHub API is flaky during error handling. Discord notify is
    // OUTSIDE the catches and fires unconditionally.
    const client = new MockGitHubClient();
    client.failures.addLabel = new Error("graphql 500");
    client.failures.addComment = new Error("rest 502");
    const { ctx, calls } = makeTestContext({ item: { issueNumber: 502 }, client });

    // Must NOT throw.
    await handleDispatchError(new Error("agent error"), ctx, null);

    // Both API calls were attempted (and threw silently). The mock
    // records attempts regardless of failure injection — that's the
    // assertable surface. Production behavior is "the dispatcher
    // tried, the API said no, the dispatcher kept going."
    assert.equal(client.addLabelCalls.length, 1, "addLabel attempt recorded");
    assert.equal(client.comments.length, 1, "addComment attempt recorded");
    // Discord notify still fires (outside the silent catches).
    assert.equal(calls.discord.length, 1);
  });

  test("ResourceExhaustedError (EAGAIN) is transient → schedules a backoff retry on the first failure", async () => {
    // agent-dispatcher#25: EAGAIN host pressure is on the auto-retry
    // allowlist, so the first ResourceExhaustedError schedules a backoff
    // retry rather than parking immediately. The resource_exhausted park
    // is deferred to the retry cap (covered in retry-integration.test.ts).
    const { ctx, client } = makeTestContext({ item: { issueNumber: 503 } });

    await handleDispatchError(new ResourceExhaustedError("EAGAIN", 5), ctx, null);

    const labels = client.addLabelCalls.map((c) => c.label);
    assert.ok(labels.includes("error-retry-count:1"), "bumps the retry counter on first EAGAIN");
    assert.ok(!labels.includes("error:developer:resource_exhausted"), "no immediate resource_exhausted park on the first failure");
  });
});

// =====================================================================
// cleanupAfterDispatch
// =====================================================================
//
// 3 tests: useWorktree=true (full cleanup), useWorktree=false (return
// to main only), worktree-remove failure tolerated.

describe("cleanupAfterDispatch", () => {
  test("useWorktree=true removes only a clean worktree and inspects main without changing it", async () => {
    const { ctx, calls } = makeTestContext({ item: { issueNumber: 600 } });
    await cleanupAfterDispatch(ctx);
    assert.deepEqual(calls.exec.map(c => c.cmd), [
      `git worktree remove "${ctx.worktreeDir}"`,
      "git status --porcelain --untracked-files=normal",
    ]);
  });

  test("useWorktree=false (PO path) → git checkout main, no worktree ops", async () => {
    const { ctx, calls } = makeTestContext({
      agent: { name: "po", column: "Backlog", claudeMdPath: "po/CLAUDE.md", usesWorktree: false, producesCommits: false },
      item: { issueNumber: 601 },
    });

    await cleanupAfterDispatch(ctx);

    const cmds = calls.exec.map(c => c.cmd);
    assert.deepEqual(cmds, ["git checkout main"], "PO cleanup is exactly one command");
  });

  test("git worktree remove fails → warning logged, function does not throw", async () => {
    // The worktree-remove try is wrapped in a `try {}` that swallows
    // the error; cleanup proceeds to read-only main inspection. The dispatcher
    // can't usefully recover from a stuck worktree mid-cleanup, so
    // it logs and moves on.
    const { ctx } = makeTestContext({
      item: { issueNumber: 602 },
      mockOptions: {
        execImpls: {
          "git worktree remove": () => execError({ stderr: "fatal: '<path>' is locked" }),
        },
      },
    });

    // Must NOT throw.
    await assert.doesNotReject(cleanupAfterDispatch(ctx));
  });
});

// =====================================================================
// dispatchToAgent — orchestrator integration
// =====================================================================
//
// 5 end-to-end tests asserting the WIRING of the six phase functions.
// The phase functions themselves are tested above; this suite verifies
// the orchestrator threads the right context, handles early returns
// correctly, and respects the cleanup-skip vs cleanup-runs invariants.
//
// **The load-bearing invariant:** when a phase returns {ok:false}
// from inside the try block (push-fail, empty-branch guard) or before
// the try (setup, prepareSpawn fail), `cleanupAfterDispatch` is
// DELIBERATELY skipped — the worktree (and main-repo state) is
// preserved as evidence for human triage. When a phase throws,
// handleDispatchError runs AND cleanup runs (clean teardown after
// labelling).

/** Distinguishing marker: cleanup ran iff calls.exec contains `git status --porcelain --untracked-files=normal` */
function cleanupRan(execCalls: { cmd: string }[]): boolean {
  return execCalls.some(c => c.cmd === "git status --porcelain --untracked-files=normal");
}

/** Mock setup that lets dispatchToAgent walk the full happy path. */
function fullHappyExecImpls(branch: string): Record<string, ExecHandler> {
  return {
    [`git rev-parse --verify ${branch}`]: () => execError({ stderr: "fatal" }),
    [`git rev-parse --verify origin/${branch}`]: () => execError({ stderr: "fatal" }),
    "git status --porcelain": () => "",
    "git rev-list --count main..": () => "1\n",
  };
}

describe("parallel verifier source review", () => {
  async function withParallelReview(fn: () => Promise<void>, runner = "codex") {
    const prior = { runner: process.env.PYRY_AGENT_RUNNER, parallel: process.env.PYRY_VERIFIER_PARALLEL_REVIEW };
    process.env.PYRY_AGENT_RUNNER = runner;
    process.env.PYRY_VERIFIER_PARALLEL_REVIEW = "1";
    try { await withStageSet("builder", () => withVerifierGates("make check", fn)); }
    finally {
      if (prior.runner === undefined) delete process.env.PYRY_AGENT_RUNNER; else process.env.PYRY_AGENT_RUNNER = prior.runner;
      if (prior.parallel === undefined) delete process.env.PYRY_VERIFIER_PARALLEL_REVIEW; else process.env.PYRY_VERIFIER_PARALLEL_REVIEW = prior.parallel;
    }
  }
  function fixture() {
    const client = new MockGitHubClient({ status: { 1330: "In Code Review" }, labels: { 1330: [] } });
    const { deps, calls } = makeMockDeps({
      execImpls: fullHappyExecImpls("feature/1330"),
      fsMap: { [claudeMdAbsPath("verifier/CLAUDE.md")]: "Review independently" },
    });
    return { client, deps, calls, run: () => dispatchToAgent(builderAgent("verifier"), makeProjectItem({ issueNumber: 1330 }), client, deps) };
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
  }
  for (const runner of ["codex", "claude"] as const) {
  for (const first of ["source", "gates"] as const) {
    test(`${runner}: source and gates start together; ${first} finishing first cannot publish a verdict`, async () => {
      await withParallelReview(async () => {
        const f = fixture();
        const gate = deferred<GateSpawnOutcome>();
        const source = deferred<StreamResult>();
        const started = deferred<void>();
        let gateStarted = false, sourceStarted = false, finalized = false;
        f.deps.spawnGate = async () => { gateStarted = true; if (sourceStarted) started.resolve(); return gate.promise; };
        f.deps.runClaudeStreaming = async opts => {
          if (opts.sourceReview) { sourceStarted = true; if (gateStarted) started.resolve(); return source.promise; }
          finalized = true;
          return streamResult({ runner: runner as "claude" | "codex", output: "Published verdict", usage: { input_tokens: 7 } });
        };
        const run = f.run();
        // Await only a bounded event loop turn: serial dispatch must fail this test, not hang.
        await Promise.race([started.promise, new Promise<void>(r => setTimeout(r, 25))]);
        const bothStarted = gateStarted && sourceStarted;
        const green = { exitCode: 0, timedOut: false, spawnError: null };
        const findings = streamResult({ runner: runner as "claude" | "codex", output: "Inspect window ownership at Screen.kt:45", usage: { input_tokens: 11 } });
        if (first === "source") source.resolve(findings); else gate.resolve(green);
        await new Promise<void>(r => setImmediate(r));
        const earlyFinal = finalized;
        if (first === "source") gate.resolve(green); else source.resolve(findings);
        await run;
        assert.ok(bothStarted, "source review must start before gates settle");
        assert.equal(earlyFinal, false, "neither half alone may start the publishing phase");
        assert.equal(finalized, true);
        const prompt = f.calls.fs.filter(x => x.kind === "write" && x.path.endsWith(".prompt-1330.txt")).at(-1)!.content!;
        assert.match(prompt, /## Deterministic gates/);
        assert.match(prompt, /Screen.kt:45/);
        assert.match(loggedText(f.calls), /Input tokens: 18/);
        assert.ok(f.client.addLabelCalls.some(x => x.label === "done:verifier"));
      }, runner);
    });
  }
  test(`${runner}: red gates reach final triage alongside source findings; rework never gets done`, async () => {
    await withParallelReview(async () => {
      const f = fixture();
      f.deps.spawnGate = async () => ({ exitCode: 1, timedOut: false, spawnError: null });
      f.deps.runClaudeStreaming = async opts => {
        if (opts.sourceReview) return streamResult({ runner: runner as "claude" | "codex", output: "Complete source findings" });
        await f.client.addLabel(1330, "needs-rework:builder");
        return streamResult({ runner: runner as "claude" | "codex", output: "Regression needs rework" });
      };
      await f.run();
      const prompt = f.calls.fs.filter(x => x.kind === "write" && x.path.endsWith(".prompt-1330.txt")).at(-1)!.content!;
      assert.match(prompt, /TRIAGE MODE/);
      assert.match(prompt, /Complete source findings/);
      assert.ok(!f.client.addLabelCalls.some(x => x.label === "done:verifier"));
    }, runner);
  });
  for (const failure of ["source error", "source timeout", "source exception", "empty report", "gate exception"] as const) {
    test(`${runner}: ${failure} waits for its sibling and cannot advance or salvage`, async () => {
      await withParallelReview(async () => {
        const f = fixture();
        let finalized = false, siblingSettled = false;
        f.deps.spawnGate = async () => {
          if (failure === "gate exception") throw new Error("gate failed to run");
          await new Promise<void>(r => setTimeout(r, 5)); siblingSettled = true;
          return { exitCode: 0, timedOut: false, spawnError: null };
        };
        f.deps.runClaudeStreaming = async opts => {
          if (!opts.sourceReview) { finalized = true; return streamResult(); }
          if (failure === "source exception") throw new Error("Source reader failed");
          if (failure === "gate exception") {
            await new Promise<void>(r => setTimeout(r, 5)); siblingSettled = true;
            return streamResult({ runner: runner as "claude" | "codex", output: "Findings" });
          }
          return streamResult({ runner: runner as "claude" | "codex", isError: failure !== "empty report", terminalReason: failure === "source timeout" ? "timeout" : failure === "empty report" ? "stop" : "codex_error", output: failure === "empty report" ? "" : "Source review failed" });
        };
        await f.run();
        assert.equal(siblingSettled, true);
        assert.equal(finalized, false);
        assert.ok(f.client.addLabelCalls.some(x => x.label === "error:verifier"));
        assert.ok(!f.client.addLabelCalls.some(x => x.label === "done:verifier"));
        assert.ok(!f.calls.exec.some(x => x.cmd.includes("gh pr list --head")), "preliminary failure must not use PR-already-exists salvage");
      }, runner);
    });
  }
  }
  for (const withCriteria of [true, false]) {
    test(`source brief ${withCriteria ? "uses the fork's review criteria file" : "falls back to the verifier role file"}`, async () => {
      await withParallelReview(async () => {
        const client = new MockGitHubClient({ status: { 1330: "In Code Review" }, labels: { 1330: [] } });
        const fsMap: Record<string, string> = { [claudeMdAbsPath("verifier/CLAUDE.md")]: "Role file with triage scripts" };
        if (withCriteria) fsMap[claudeMdAbsPath("verifier/review-criteria.md")] = "Criteria: wire types match";
        const { deps, calls } = makeMockDeps({ execImpls: fullHappyExecImpls("feature/1330"), fsMap });
        deps.runClaudeStreaming = async opts => streamResult({ output: opts.sourceReview ? "Complete report" : "Final verdict" });
        await dispatchToAgent(builderAgent("verifier"), makeProjectItem({ issueNumber: 1330 }), client, deps);
        const brief = calls.fs.filter(x => x.kind === "write" && x.path.endsWith(".source-system.txt")).at(-1)!.content!;
        assert.match(brief, /An unread file is a remaining check, not a reason to stop/);
        if (withCriteria) {
          assert.match(brief, /## Review criteria\n\nCriteria: wire types match/);
          assert.doesNotMatch(brief, /triage scripts/);
        } else {
          assert.match(brief, /Role file with triage scripts/);
        }
      });
    });
  }
  test("Claude receives the complete diff and shares turns with the final phase", async () => {
    await withParallelReview(async () => {
      const f = fixture();
      const originalSpawn = f.deps.spawnSync;
      f.deps.spawnSync = ((bin, args, opts) => {
        if (bin === "git" && args?.includes("--no-ext-diff")) return { status: 0, stdout: "complete fixture diff", stderr: "" };
        return originalSpawn(bin, args, opts);
      }) as typeof f.deps.spawnSync;
      let initialTurns = 0;
      f.deps.runClaudeStreaming = async opts => {
        if (opts.sourceReview) {
          initialTurns = opts.maxTurns;
          assert.ok(opts.sourceReviewRoot);
          return streamResult({ output: "Complete report", numTurns: 8 });
        }
        assert.equal(opts.maxTurns, initialTurns - 8);
        return streamResult({ output: "Final verdict", numTurns: 4 });
      };
      await f.run();
      assert.ok(f.calls.fs.some(x => x.kind === "write" && x.path.endsWith(".source.txt") && x.content?.includes("complete fixture diff")));
      assert.match(loggedText(f.calls), /Turns: 12/);
      assert.ok(f.client.addLabelCalls.some(x => x.label === "done:verifier"));
    }, "claude");
  });
  for (const failure of ["diff unavailable", "turn budget exhausted", "final budget exhausted"] as const) {
    test(`Claude ${failure} cannot get a fresh continuation budget`, async () => {
      await withParallelReview(async () => {
        const f = fixture();
        if (failure === "diff unavailable") f.deps.spawnSync = (() => ({ status: 1, stdout: "", stderr: "failed" })) as any;
        let sourceRuns = 0, finalRuns = 0;
        f.deps.runClaudeStreaming = async opts => {
          if (opts.sourceReview) {
            sourceRuns++;
            return streamResult({ output: "Source findings", numTurns: failure === "turn budget exhausted" ? opts.maxTurns : 3 });
          }
          finalRuns++;
          return streamResult({ isError: true, terminalReason: "max_turns", numTurns: opts.maxTurns, sessionId: "existing-session" });
        };
        await f.run();
        assert.equal(sourceRuns, failure === "diff unavailable" ? 0 : 1);
        assert.equal(finalRuns, failure === "final budget exhausted" ? 1 : 0);
        assert.ok(!f.client.addLabelCalls.some(x => x.label === "done:verifier"));
      }, "claude");
    });
  }
  for (const mode of ["classic", "empty gates", "opted out"] as const) {
    test(`${mode} retains the single publishing run`, async () => {
      await withParallelReview(async () => {
        const f = fixture();
        let sourceRuns = 0, finalRuns = 0;
        f.deps.runClaudeStreaming = async opts => {
          if (opts.sourceReview) sourceRuns++; else finalRuns++;
          return streamResult({ output: "Review complete" });
        };
        if (mode === "classic") await withStageSet(undefined, f.run);
        else if (mode === "empty gates") await withVerifierGates("", f.run);
        else {
          process.env.PYRY_VERIFIER_PARALLEL_REVIEW = "0";
          await f.run();
        }
        assert.equal(sourceRuns, 0);
        assert.equal(finalRuns, 1);
      });
    });
  }
});

describe("dispatchToAgent — orchestrator integration", () => {
  test("happy-path full run → setup + spawn + stream + post-run all green; done:<agent> + cleanup runs", async () => {
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 700: "In Development" },
      labels: { 700: [] },
    });
    const item = makeProjectItem({ issueNumber: 700 });
    const agent = makeAgentConfig({});
    const { deps, calls } = makeMockDeps({
      execImpls: fullHappyExecImpls("feature/700"),
      fsMap: { [claudeMd]: "developer system prompt" },
    });

    await dispatchToAgent(agent, item, client, deps);

    // done:developer applied (post-success labeling).
    assert.ok(client.addLabelCalls.some(c => c.label === "done:developer"));
    // No error labels.
    assert.ok(!client.addLabelCalls.some(c => c.label.startsWith("error:")));
    // Cleanup ran (the marker command).
    assert.ok(cleanupRan(calls.exec), "happy path must run cleanupAfterDispatch");
    // Streaming was invoked exactly once.
    assert.equal(calls.claudeStreams, 1);
    // Success ping dropped 2026-06-07 — happy path completes without a
    // Discord notify.
    assert.equal(calls.discord.length, 0);
  });

  test("setup-fails (push-equivalent: empty-branch from handlePostRun) → cleanup-skipped invariant", async () => {
    // The push-fail and empty-branch return paths preserve the
    // worktree as evidence. Reproduces with empty-branch (rev-list
    // returns 0) — handlePostRun returns {ok:false} from inside the
    // try block, the orchestrator sees it and returns BEFORE the
    // unconditional cleanup at the end. The worktree + leaked .claude
    // files stay intact for the human triager.
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 701: "In Development" },
      labels: { 701: [] },
    });
    const item = makeProjectItem({ issueNumber: 701 });
    const agent = makeAgentConfig({});
    const { deps, calls } = makeMockDeps({
      execImpls: {
        ...fullHappyExecImpls("feature/701"),
        // Override: branch is 0 ahead of main → empty-branch guard
        // fires for developer (producesCommits=true).
        "git rev-list --count main..": () => "0\n",
      },
      fsMap: { [claudeMd]: "developer system prompt" },
    });

    await dispatchToAgent(agent, item, client, deps);

    // error:developer applied by handlePostRun.
    assert.ok(client.addLabelCalls.some(c => c.label === "error:developer"));
    // Critically: cleanup did NOT run. Worktree preserved as evidence.
    assert.ok(
      !cleanupRan(calls.exec),
      "empty-branch return from handlePostRun must skip cleanupAfterDispatch (preserves worktree as evidence)",
    );
  });

  test("outer catch path → cleanup-runs invariant; error label + Discord notify", async () => {
    // Agent threw a non-max_turns error → handleAgentResultErrors
    // throws → outer catch catches → handleDispatchError runs (label,
    // comment, Discord) → falls through to cleanupAfterDispatch.
    // Distinct from the {ok:false} early-return paths: thrown errors
    // produce a clean teardown; structural failure paths preserve state.
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 702: "In Development" },
      labels: { 702: [] },
    });
    const item = makeProjectItem({ issueNumber: 702 });
    const agent = makeAgentConfig({});
    const { deps, calls } = makeMockDeps({
      execImpls: fullHappyExecImpls("feature/702"),
      fsMap: { [claudeMd]: "developer system prompt" },
      // Stream returns a non-max_turns error → handleAgentResultErrors throws.
      // Deliberately NOT `api_error`: that reason auto-retries now (it is
      // claude reporting a server-side failure), so it would schedule a
      // backoff instead of parking and this park invariant would never fire.
      streamResult: streamResult({ isError: true, terminalReason: "timeout", output: "agent killed after 25min" }),
    });

    await dispatchToAgent(agent, item, client, deps);

    // handleDispatchError applied error:developer.
    assert.ok(client.addLabelCalls.some(c => c.label === "error:developer"));
    // Discord notify (one ❌ message).
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /^❌/);
    // Cleanup DID run — clean teardown after the catch.
    assert.ok(
      cleanupRan(calls.exec),
      "thrown errors run handleDispatchError + cleanupAfterDispatch (no preservation needed once labelled)",
    );
  });

  test("safer-salvage path → label salvage + skip ready label + cleanup runs", async () => {
    // Stream returns max_turns + uncommitted clean code →
    // handleAgentResultErrors triggers safer-salvage, returns
    // saferSalvaged=true → handlePostRun sees the flag and skips
    // done:<agent> + success comment + success Discord →
    // returns {ok:true} → cleanup runs.
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 703: "In Development" },
      labels: { 703: [] },
    });
    const item = makeProjectItem({ issueNumber: 703 });
    const agent = makeAgentConfig({});
    const { deps, calls } = makeMockDeps({
      execImpls: {
        ...fullHappyExecImpls("feature/703"),
        // Salvage gates: gh pr list returns no PRs → fall through to
        // safer-salvage; git status dirty → salvage gate passes;
        // go vet + go build default to success.
        "gh pr list --head": () => "[]",
        "git status --porcelain": () => "M file.go\n",
        // After salvage commits, rev-list returns 1 (1 commit ahead).
        // But empty-branch guard is gated on !saferSalvaged so it
        // doesn't run anyway.
      },
      fsMap: { [claudeMd]: "developer system prompt" },
      streamResult: streamResult({
        isError: true,
        terminalReason: "max_turns",
        numTurns: 70,
        totalCostUsd: 4.74,
        output: "agent log tail",
      }),
    });

    await dispatchToAgent(agent, item, client, deps);

    // Salvage label applied.
    assert.ok(client.addLabelCalls.some(c => c.label === "error:max_turns_salvaged"));
    // No done:<agent> (suppressed by saferSalvaged=true).
    assert.ok(!client.addLabelCalls.some(c => c.label === "done:developer"));
    // No error:<agent> either (salvage is the canonical signal here).
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:developer"));
    // Salvage notify (one 💾 message from attemptSaferSalvage; no
    // additional success notify because !saferSalvaged is false in
    // handlePostRun).
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /^💾/);
    // Cleanup DID run — salvage path is structurally a success
    // ({ok:true} from handlePostRun), so cleanup proceeds.
    assert.ok(cleanupRan(calls.exec));
  });

  test("CLAUDE.md missing (prepareAgentSpawn early-return) → orchestrator-cleanup skipped (inline cleanup happens)", async () => {
    // prepareAgentSpawn returns {ok:false} when the agent's CLAUDE.md
    // is missing. The orchestrator returns BEFORE the unconditional
    // cleanup. prepareAgentSpawn does its own inline `git worktree
    // remove --force` (since the orchestrator's outer cleanup is
    // skipped on its return path) — but the orchestrator-cleanup's
    // distinguishing marker (`git status --porcelain --untracked-files=normal`) does NOT fire.
    const client = new MockGitHubClient({
      status: { 704: "In Development" },
      labels: { 704: [] },
    });
    const item = makeProjectItem({ issueNumber: 704 });
    const agent = makeAgentConfig({});
    const { deps, calls } = makeMockDeps({
      execImpls: fullHappyExecImpls("feature/704"),
      fsMap: {},  // empty → CLAUDE.md missing → prepareAgentSpawn fails
    });

    await dispatchToAgent(agent, item, client, deps);

    // CLAUDE.md missing comment posted by prepareAgentSpawn.
    assert.ok(client.comments.some(c => /Agent CLAUDE\.md not found/.test(c.body)));
    // Stream was never invoked.
    assert.equal(calls.claudeStreams, 0);
    // Inline worktree removal DID happen (in prepareAgentSpawn's catch).
    assert.ok(calls.exec.some(c => c.cmd.includes("git worktree remove")));
    // But the orchestrator's full cleanup did NOT run — its marker is
    // `git status --porcelain --untracked-files=normal` which lives only in cleanupAfterDispatch.
    assert.ok(
      !cleanupRan(calls.exec),
      "prepareAgentSpawn early-return must skip cleanupAfterDispatch (inline cleanup is the path here)",
    );
  });
});

// =====================================================================
// dispatchToAgent — concurrent dispatches
// =====================================================================
//
// 4 tests covering the `pollLoop`'s real concurrency model:
// `Promise.allSettled(candidates.map(({ agent, item }) =>
// dispatchToAgent(agent, item, client)))`. Two simultaneous
// dispatchToAgent calls share the same `GitHubProjectClient`, the same
// fs/child_process surface, and the same module-level state. These
// tests verify the dispatcher's per-dispatch isolation invariants
// hold under that sharing:
//
// 1. Worktree paths derived from agent+ticket are distinct → no
//    git worktree add collision.
// 2. Per-issue label state stays scoped — addLabel(100, ...) and
//    addLabel(200, ...) don't interfere.
// 3. One dispatch's failure path doesn't leak into the other's
//    success path (cleanup-skip is per-dispatch, not per-process).
// 4. Promise.allSettled isolation — one dispatch's exception doesn't
//    prevent the other from completing.
//
// JS is single-threaded so there's no true parallelism, but `await`
// boundaries create interleavings — these tests catch shared-state
// bugs that depend on call ordering across awaits.

describe("dispatchToAgent — concurrent dispatches (pollLoop's Promise.allSettled model)", () => {
  test("two concurrent happy-path dispatches → both succeed cleanly with per-issue label state", async () => {
    // Shared client + shared deps, two distinct tickets. This is the
    // exact shape pollLoop uses: one client and one process-level deps
    // surface, multiple concurrent dispatches.
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 800: "In Development", 801: "In Development" },
      labels: { 800: [], 801: [] },
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        // Branch-existence checks for both tickets.
        "git rev-parse --verify feature/800": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/800": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify feature/801": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/801": () => execError({ stderr: "fatal" }),
        "git status --porcelain": () => "",
        "git rev-list --count main..": () => "1\n",
      },
      fsMap: { [claudeMd]: "developer system prompt" },
    });
    const agent = makeAgentConfig({});

    const results = await Promise.allSettled([
      dispatchToAgent(agent, makeProjectItem({ issueNumber: 800 }), client, deps),
      dispatchToAgent(agent, makeProjectItem({ issueNumber: 801 }), client, deps),
    ]);

    // Both promises completed successfully (no thrown errors).
    assert.equal(results[0]!.status, "fulfilled", `dispatch 1: ${results[0]!.status}`);
    assert.equal(results[1]!.status, "fulfilled", `dispatch 2: ${results[1]!.status}`);

    // Per-issue label state: each ticket got its own ready label, no cross-pollination.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 800 && c.label === "done:developer"));
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 801 && c.label === "done:developer"));
    // No error labels on either.
    assert.ok(!client.addLabelCalls.some(c => c.label.startsWith("error:")));

    // Both worktree dirs were referenced — and they're distinct paths
    // (one ends in `developer-800`, the other `developer-801`).
    const worktreeAddCalls = calls.exec.filter(c => c.cmd.includes("git worktree add"));
    assert.equal(worktreeAddCalls.length, 2, "exactly two worktree add calls (one per dispatch)");
    assert.ok(worktreeAddCalls.some(c => c.cmd.includes("developer-800")));
    assert.ok(worktreeAddCalls.some(c => c.cmd.includes("developer-801")));

    // Stream invoked twice (once per dispatch).
    assert.equal(calls.claudeStreams, 2);
    // Success ping dropped 2026-06-07 — neither successful dispatch notifies
    // Discord.
    assert.equal(calls.discord.length, 0);
  });

  test("one push-fail + one happy in parallel → no cross-contamination of labels or cleanup", async () => {
    // The cleanup-skip-on-failure invariant must be PER-DISPATCH, not
    // per-process. Ticket #802 push fails (worktree preserved as
    // evidence), ticket #803 succeeds (worktree cleaned up). Both
    // outcomes must be visible in the shared client + shared call log
    // without one ticket's signal contaminating the other.
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 802: "In Development", 803: "In Development" },
      labels: { 802: [], 803: [] },
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "git rev-parse --verify feature/802": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/802": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify feature/803": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/803": () => execError({ stderr: "fatal" }),
        "git status --porcelain": () => "",
        // Ticket 802's push fails; 803's push succeeds (default empty exec impl).
        "git push -u origin feature/802": () => execError({ stderr: "non-fast-forward" }),
        "git rev-list --count main..": () => "1\n",
      },
      fsMap: { [claudeMd]: "developer system prompt" },
    });
    const agent = makeAgentConfig({});

    await Promise.allSettled([
      dispatchToAgent(agent, makeProjectItem({ issueNumber: 802 }), client, deps),
      dispatchToAgent(agent, makeProjectItem({ issueNumber: 803 }), client, deps),
    ]);

    // Per-issue label scope holds:
    // 802 got error:developer (push failed); NO done:developer.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 802 && c.label === "error:developer"));
    assert.ok(!client.addLabelCalls.some(c => c.issueNumber === 802 && c.label === "done:developer"));
    // 803 got done:developer (happy path); NO error:developer.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 803 && c.label === "done:developer"));
    assert.ok(!client.addLabelCalls.some(c => c.issueNumber === 803 && c.label === "error:developer"));

    // Cleanup-skip is per-dispatch: 803's worktree was cleaned up
    // (cleanup ran), 802's was preserved. The orchestrator's cleanup
    // marker is `git status --porcelain --untracked-files=normal` — it should appear at least once
    // (for 803), not twice. (Each dispatchToAgent that runs cleanup
    // emits this exactly once.)
    const cleanupMarkerCount = calls.exec.filter(c => c.cmd === "git status --porcelain --untracked-files=normal").length;
    assert.equal(cleanupMarkerCount, 1, "cleanup must run for the success but not the failure (per-dispatch isolation)");
  });

  test("two concurrent failures (different non-max_turns errors) → both isolated, both run handleDispatchError + cleanup", async () => {
    // Both dispatches' streams return is-error with different terminal
    // reasons. Each independently goes through handleAgentResultErrors
    // (which throws because non-max_turns) → outer catch →
    // handleDispatchError → cleanupAfterDispatch.
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 804: "In Development", 805: "In Development" },
      labels: { 804: [], 805: [] },
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "git rev-parse --verify feature/804": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/804": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify feature/805": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/805": () => execError({ stderr: "fatal" }),
      },
      fsMap: { [claudeMd]: "developer system prompt" },
      // Per-dispatch stream resolution via opts.cwd: 804 returns a failed
      // test run, 805 returns timeout. Both should hit the non-max_turns
      // throw path independently. Neither reason may be `api_error`: that
      // one now auto-retries rather than parking, which would defeat the
      // error-label assertions below without testing anything about
      // concurrent isolation.
      streamResult: (opts) => {
        if (opts?.cwd?.includes("developer-804")) {
          return streamResult({ isError: true, terminalReason: "completed", output: "go test ./... FAILED: 3 tests failing" });
        }
        return streamResult({ isError: true, terminalReason: "timeout", output: "agent killed after 25min" });
      },
    });
    const agent = makeAgentConfig({});

    const results = await Promise.allSettled([
      dispatchToAgent(agent, makeProjectItem({ issueNumber: 804 }), client, deps),
      dispatchToAgent(agent, makeProjectItem({ issueNumber: 805 }), client, deps),
    ]);

    // Both promises completed (didn't throw out of dispatchToAgent —
    // outer catch handled the throw, then cleanup ran). This is the
    // load-bearing isolation guarantee for `Promise.allSettled` in
    // pollLoop.
    assert.equal(results[0]!.status, "fulfilled");
    assert.equal(results[1]!.status, "fulfilled");

    // Both got error:developer.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 804 && c.label === "error:developer"));
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 805 && c.label === "error:developer"));

    // Cleanup ran for BOTH (thrown errors get clean teardown).
    const cleanupMarkerCount = calls.exec.filter(c => c.cmd === "git status --porcelain --untracked-files=normal").length;
    assert.equal(cleanupMarkerCount, 2, "thrown-error path runs cleanup; both dispatches must emit the marker");

    // Two error Discord notifies (one per failure).
    assert.equal(calls.discord.length, 2);
    assert.ok(calls.discord.every(d => /^❌/.test(d)));
  });

  test("different agents on different tickets → distinct worktree paths + correct per-agent labels", async () => {
    // architect on #806, developer on #807. Different agents on
    // different tickets — the `<agent>-<n>` worktree path naming
    // scheme means no path collision is possible. Verify both
    // dispatches succeed AND their labels are scoped to the right
    // agent name (done:architect on 806, done:developer on 807).
    const archMd = claudeMdAbsPath("architect/CLAUDE.md");
    const devMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 806: "In Architecture", 807: "In Development" },
      labels: { 806: [], 807: [] },
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "git rev-parse --verify feature/806": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/806": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify feature/807": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/807": () => execError({ stderr: "fatal" }),
        "git status --porcelain": () => "",
        "git rev-list --count main..": () => "1\n",
      },
      fsMap: { [archMd]: "architect system prompt", [devMd]: "developer system prompt" },
    });

    const archAgent = makeAgentConfig({ name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md" });
    const devAgent = makeAgentConfig({});

    const results = await Promise.allSettled([
      dispatchToAgent(archAgent, makeProjectItem({ issueNumber: 806 }), client, deps),
      dispatchToAgent(devAgent, makeProjectItem({ issueNumber: 807 }), client, deps),
    ]);

    assert.equal(results[0]!.status, "fulfilled");
    assert.equal(results[1]!.status, "fulfilled");

    // Per-agent label scoping: each ticket got the correct
    // done:<agent> prefix matching the dispatching agent's name.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 806 && c.label === "done:architect"));
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 807 && c.label === "done:developer"));
    // No cross-pollination: 806 didn't get done:developer, 807 didn't get done:architect.
    assert.ok(!client.addLabelCalls.some(c => c.issueNumber === 806 && c.label === "done:developer"));
    assert.ok(!client.addLabelCalls.some(c => c.issueNumber === 807 && c.label === "done:architect"));

    // Worktree paths: `architect-806` and `developer-807` — distinct
    // by agent name AND ticket number, doubly safe.
    const worktreeAdds = calls.exec.filter(c => c.cmd.includes("git worktree add"));
    assert.equal(worktreeAdds.length, 2);
    assert.ok(worktreeAdds.some(c => c.cmd.includes("architect-806")));
    assert.ok(worktreeAdds.some(c => c.cmd.includes("developer-807")));
    // Sanity: NO crossed paths (architect-807 or developer-806).
    assert.ok(!worktreeAdds.some(c => c.cmd.includes("architect-807")));
    assert.ok(!worktreeAdds.some(c => c.cmd.includes("developer-806")));
  });
});

// =====================================================================
// runDoneCleanup
// =====================================================================
//
// Strips pipeline-state labels off any ticket sitting in the Done column.
// Pure decision is in `decideDoneCleanup` (tested in lib.test.ts); these
// tests cover the I/O wrapper: getItemsByStatus → filter → removeLabel
// per stripped label, with `warnOnceCleanup` deduping spam on permanent
// failures.

describe("runDoneCleanup", () => {
  test("strips pipeline labels from Done items", async () => {
    // Two Done items with stale done:* labels accumulated from the pipeline run.
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 900, status: "Done", labels: ["done:documentation", "size:s"], state: "OPEN" },
        { issueNumber: 901, status: "Done", labels: ["done:po", "done:architect", "done:developer", "done:code-review", "done:documentation"], state: "OPEN" },
      ],
    });

    await runDoneCleanup(client);

    // Item 900: only done:documentation stripped; size:s preserved
    // (decideDoneCleanup leaves size labels alone).
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 900 && c.label === "done:documentation"));
    assert.ok(!client.removeLabelCalls.some(c => c.issueNumber === 900 && c.label === "size:s"));

    // Item 901: all five done:* stripped.
    const stripped901 = client.removeLabelCalls.filter(c => c.issueNumber === 901).map(c => c.label);
    assert.ok(stripped901.includes("done:po"));
    assert.ok(stripped901.includes("done:architect"));
    assert.ok(stripped901.includes("done:developer"));
    assert.ok(stripped901.includes("done:code-review"));
    assert.ok(stripped901.includes("done:documentation"));
  });

  test("idempotent — clean Done item produces no removeLabel calls", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 902, status: "Done", labels: ["size:m", "merged"], state: "OPEN" },
      ],
    });

    await runDoneCleanup(client);

    assert.equal(client.removeLabelCalls.length, 0, "no pipeline labels → no removeLabel work");
  });

  test("getItemsByStatus failure → logs error, doesn't throw", async () => {
    const client = new MockGitHubClient();
    client.failures.getItemsByStatus = new Error("graphql 502");

    // Must NOT throw — the maintenance pass swallows fetch failures so
    // the next cycle's invocation gets a clean retry.
    await assert.doesNotReject(runDoneCleanup(client));
  });

  test("removeLabel failure → warnOnceCleanup dedups across two cycles for the same (issue, label, kind)", async () => {
    // Use a unique issueNumber so the warn-once Set key
    // `<issue>:<label>:Done-cleanup removeLabel` doesn't collide with
    // other tests in the file (the Set is module-level and persists
    // across tests within this process).
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 909_001, status: "Done", labels: ["done:developer"], state: "OPEN" },
      ],
    });
    client.failures.removeLabel = new Error("renamed label, REST 404");

    // Two cycles in a row. Both call removeLabel (the dedup is on the
    // *warning log*, not the API call — the warning silencing prevents
    // log spam without changing behavior).
    await runDoneCleanup(client);
    await runDoneCleanup(client);

    // Both cycles attempted removal of the same label.
    const attempts = client.removeLabelCalls.filter(c => c.issueNumber === 909_001 && c.label === "done:developer");
    assert.equal(attempts.length, 2, "removeLabel attempted on both cycles (warn-once doesn't suppress the call)");
    // The warn-once Set is module-level and only-observable via
    // console.warn; we can't assert it directly without exporting the
    // Set. The behavioral guarantee tested is "two cycles → two
    // removeLabel attempts that both fail without crashing the pass."
  });
});

// =====================================================================
// runStrandedWipSweep
// =====================================================================
//
// Clears `wip:<agent>` labels that no dispatch is behind, on a two-stage
// board-encoded schedule: observe, then strip once the observation has
// outlived the longest possible agent run. The stall it exists to end
// froze two boards for seven hours on 2026-09-08, when an outage took out
// every write on the failure path at once and left each ticket carrying
// nothing but its running label.

describe("runStrandedWipSweep", () => {
  const MIN_AGE = 120 * 60_000;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60_000);
  const silentDiscord = async () => {};

  test("clean board → no marker reads, no writes, no cache clear", async () => {
    const client = new MockGitHubClient({
      items: [{ issueNumber: 10, status: "In Review", labels: ["done:builder"] }],
    });
    await runStrandedWipSweep(client, silentDiscord, MIN_AGE);
    assert.deepEqual(client.getStrandedWipMarkersCalls, []);
    assert.deepEqual(client.removeLabelCalls, []);
    assert.equal(client.comments.length, 0);
    assert.equal(client.clearItemsCacheCalls, 0);
  });

  test("first sight of a stranded label → posts the observe marker, strips nothing", async () => {
    const client = new MockGitHubClient({
      items: [{ issueNumber: 2191, status: "In Review", labels: ["done:builder", "wip:verifier"] }],
    });
    const pings: string[] = [];
    await runStrandedWipSweep(client, async (m) => { pings.push(m); }, MIN_AGE);

    assert.equal(client.comments.length, 1);
    assert.ok(client.comments[0].body.includes(STRANDED_WIP_OBSERVED_MARKER));
    assert.deepEqual(client.removeLabelCalls, []);
    // Nothing has been decided yet, so nothing should reach the operator.
    assert.deepEqual(pings, []);
    assert.equal(client.clearItemsCacheCalls, 0);
  });

  test("observation still inside the gate → holds, no second marker", async () => {
    const client = new MockGitHubClient({
      items: [{ issueNumber: 2191, status: "In Review", labels: ["wip:verifier"] }],
    });
    client.strandedWipMarkersByIssue.set(2191, { observedAt: hoursAgo(1), sweptAt: null });
    await runStrandedWipSweep(client, silentDiscord, MIN_AGE);

    assert.deepEqual(client.removeLabelCalls, []);
    assert.equal(client.comments.length, 0, "a held ticket must not accumulate a marker per cycle");
  });

  test("observation older than the gate → strips, posts the swept marker, pings, clears the cache", async () => {
    const client = new MockGitHubClient({
      items: [{ issueNumber: 2191, status: "In Review", labels: ["done:builder", "wip:verifier"] }],
    });
    client.strandedWipMarkersByIssue.set(2191, { observedAt: hoursAgo(3), sweptAt: null });
    const pings: string[] = [];
    await runStrandedWipSweep(client, async (m) => { pings.push(m); }, MIN_AGE);

    assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 2191, label: "wip:verifier" }]);
    assert.ok(!client.labelsByIssue.get(2191)!.includes("wip:verifier"));
    // done:builder is another agent's signal and is not the sweep's to take.
    assert.ok(client.labelsByIssue.get(2191)!.includes("done:builder"));
    assert.equal(client.comments.length, 1);
    assert.ok(client.comments[0].body.includes(STRANDED_WIP_SWEPT_MARKER));
    assert.equal(pings.length, 1);
    assert.ok(pings[0].includes("2191"));
    // Without this the swept ticket stays invisible to the rest of the cycle.
    assert.equal(client.clearItemsCacheCalls, 1);
  });

  test("a swept marker newer than the observation → re-observes instead of stripping", async () => {
    // The live-agent regression. Ticket stranded and was swept hours ago,
    // then legitimately re-dispatched; the old observation is still older
    // than the gate. Stripping here would pull the running label out from
    // under an agent that started minutes ago.
    const client = new MockGitHubClient({
      items: [{ issueNumber: 2191, status: "In Review", labels: ["wip:verifier"] }],
    });
    client.strandedWipMarkersByIssue.set(2191, { observedAt: hoursAgo(6), sweptAt: hoursAgo(5) });
    await runStrandedWipSweep(client, silentDiscord, MIN_AGE);

    assert.deepEqual(client.removeLabelCalls, []);
    assert.equal(client.comments.length, 1);
    assert.ok(client.comments[0].body.includes(STRANDED_WIP_OBSERVED_MARKER));
  });

  test("two cycles: the sweep's own marker is what the next sweep reads", async () => {
    // The marker is durable board state, not dispatcher memory — the whole
    // point, since the dispatcher restarts constantly. Cycle 1 observes;
    // cycle 2 must see that observation rather than starting over.
    const client = new MockGitHubClient({
      items: [{ issueNumber: 2191, status: "In Review", labels: ["wip:verifier"] }],
    });
    await runStrandedWipSweep(client, silentDiscord, MIN_AGE);
    assert.equal(client.comments.length, 1);

    await runStrandedWipSweep(client, silentDiscord, MIN_AGE);
    assert.equal(client.comments.length, 1, "cycle 2 must read cycle 1's marker, not post a second");
    assert.deepEqual(client.removeLabelCalls, []);

    // Same marker, now old enough: cycle 3 strips.
    client.commentClock = () => hoursAgo(3);
    client.comments = [{ issueNumber: 2191, body: STRANDED_WIP_OBSERVED_MARKER, postedAt: hoursAgo(3) }];
    await runStrandedWipSweep(client, silentDiscord, MIN_AGE);
    assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 2191, label: "wip:verifier" }]);
  });

  test("strip fails → no ping, no cache clear, ticket waits another gate", async () => {
    // An outage that reaches the sweep itself. The label stays on, and the
    // swept marker written just before it retires the observation, so the
    // next cycle re-observes rather than stripping on stale authority.
    // Pinging on the attempt would fire every poll for the whole outage.
    const client = new MockGitHubClient({
      items: [{ issueNumber: 2191, status: "In Review", labels: ["wip:verifier"] }],
    });
    client.strandedWipMarkersByIssue.set(2191, { observedAt: hoursAgo(3), sweptAt: null });
    client.failures.removeLabel = new Error("502 Bad Gateway");
    const pings: string[] = [];
    await runStrandedWipSweep(client, async (m) => { pings.push(m); }, MIN_AGE);

    assert.equal(client.labelsByIssue.get(2191)!.includes("wip:verifier"), true);
    assert.deepEqual(pings, []);
    assert.equal(client.clearItemsCacheCalls, 0);

    // Next cycle re-observes: the swept marker is now newer than the
    // observation that authorised the failed strip.
    client.removeLabelCalls = [];
    await runStrandedWipSweep(client, silentDiscord, MIN_AGE);
    assert.deepEqual(client.removeLabelCalls, [], "must not strip on the retired observation");
    assert.ok(client.comments.some((c) => c.body.includes(STRANDED_WIP_OBSERVED_MARKER)));
  });

  test("the swept marker fails to post → nothing is stripped at all", async () => {
    // The ordering guard. If the strip landed first and the marker were
    // lost, the ticket would be dispatchable again with an expired
    // observation still the newest marker on it — and the very next cycle
    // would strip the running label off the agent that just started, whose
    // replacement would force-remove the worktree under it.
    const client = new MockGitHubClient({
      items: [{ issueNumber: 2191, status: "In Review", labels: ["wip:verifier"] }],
    });
    client.strandedWipMarkersByIssue.set(2191, { observedAt: hoursAgo(3), sweptAt: null });
    client.failures.addComment = new Error("502 Bad Gateway");
    const pings: string[] = [];
    await runStrandedWipSweep(client, async (m) => { pings.push(m); }, MIN_AGE);

    assert.deepEqual(client.removeLabelCalls, [], "a strip must never outrun its own marker");
    assert.ok(client.labelsByIssue.get(2191)!.includes("wip:verifier"));
    assert.deepEqual(pings, []);
    assert.equal(client.clearItemsCacheCalls, 0);
  });

  test("marker read fails → that ticket is skipped, the rest of the board still sweeps", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1, status: "In Review", labels: ["wip:verifier"] },
        { issueNumber: 2, status: "In Development", labels: ["wip:developer"] },
      ],
    });
    client.strandedWipMarkersByIssue.set(2, { observedAt: hoursAgo(3), sweptAt: null });
    client.failures.getStrandedWipMarkers = (n) => (n === 1 ? new Error("503") : null);
    await runStrandedWipSweep(client, silentDiscord, MIN_AGE);

    assert.deepEqual(client.removeLabelCalls, [{ issueNumber: 2, label: "wip:developer" }]);
  });

  test("board read fails → the sweep does nothing at all", async () => {
    const client = new MockGitHubClient({
      items: [{ issueNumber: 2191, status: "In Review", labels: ["wip:verifier"] }],
    });
    client.failures.getAllProjectItems = new Error("GraphQL down");
    await runStrandedWipSweep(client, silentDiscord, MIN_AGE);

    assert.deepEqual(client.getStrandedWipMarkersCalls, []);
    assert.deepEqual(client.removeLabelCalls, []);
  });

  test("several stranded labels on one ticket strip together, one ping", async () => {
    const client = new MockGitHubClient({
      items: [{ issueNumber: 9, status: "In Development", labels: ["wip:developer", "wip:qa", "size:m"] }],
    });
    client.strandedWipMarkersByIssue.set(9, { observedAt: hoursAgo(3), sweptAt: null });
    const pings: string[] = [];
    await runStrandedWipSweep(client, async (m) => { pings.push(m); }, MIN_AGE);

    assert.equal(client.removeLabelCalls.length, 2);
    assert.ok(client.labelsByIssue.get(9)!.includes("size:m"));
    assert.equal(pings.length, 1);
  });
});

describe("strandedWipMinAgeMs", () => {
  test("outlasts the longest agent budget the stage set can spend", async () => {
    // Derived rather than hardcoded so raising a stage's timeout cannot
    // silently shorten the gate. `timeoutFor` tops out at 40min today, and
    // one resume leg can spend that budget twice.
    const gate = strandedWipMinAgeMs(AGENTS);
    const longest = Math.max(...AGENTS.map((a) => timeoutFor(a, ["security-sensitive"])));
    assert.ok(gate > longest * 2, `gate ${gate} must exceed two full runs of the longest agent (${longest})`);
  });

  test("an empty stage set still yields the margin, never zero", async () => {
    assert.ok(strandedWipMinAgeMs([]) > 0);
  });
});

// =====================================================================
// runClosedSweep
// =====================================================================
//
// Moves closed issues that are stranded outside the Done column to
// Done. PO splitting + closing parents, manually-closed-as-wontfix,
// duplicates — all reach Done via this pass.

describe("runClosedSweep", () => {
  test("moves CLOSED items not in Done → Done via updateItemStatus", async () => {
    const client = new MockGitHubClient({
      items: [
        // Closed in Backlog (PO split + closed parent).
        { id: "PVTI_910", issueNumber: 910, status: "Backlog", state: "CLOSED" },
        // Closed in In Code Review (won't-fix during review).
        { id: "PVTI_911", issueNumber: 911, status: "In Code Review", state: "CLOSED" },
        // Already in Done — should NOT be moved (filter excludes).
        { id: "PVTI_912", issueNumber: 912, status: "Done", state: "CLOSED" },
        // Open in Backlog — should NOT be moved (filter excludes).
        { id: "PVTI_913", issueNumber: 913, status: "Backlog", state: "OPEN" },
      ],
    });

    await runClosedSweep(client);

    const movedIds = client.updateItemStatusCalls.map(c => c.itemId);
    assert.deepEqual(movedIds.sort(), ["PVTI_910", "PVTI_911"].sort(), "exactly the two stranded-closed items moved");
    assert.ok(client.updateItemStatusCalls.every(c => c.newStatus === "Done"));
  });

  test("getClosedItemsNotInDone failure → logs error, doesn't throw", async () => {
    const client = new MockGitHubClient();
    client.failures.getClosedItemsNotInDone = new Error("graphql 503");

    await assert.doesNotReject(runClosedSweep(client));
  });

  test("updateItemStatus failure on one item → warnOnceCleanup dedups, other items still processed", async () => {
    // Use a globally-unique issueNumber for the failing item so the
    // warn-once key doesn't collide with other tests (module-level Set).
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_909_010", issueNumber: 909_010, status: "Backlog", state: "CLOSED" },
        { id: "PVTI_915", issueNumber: 915, status: "Backlog", state: "CLOSED" },
      ],
    });
    client.failures.updateItemStatus = (itemId) =>
      itemId === "PVTI_909_010" ? new Error("project field permission denied") : null;

    await runClosedSweep(client);

    // Both updates were attempted.
    assert.equal(client.updateItemStatusCalls.length, 2);
    // The non-failing one succeeded — verify state changed.
    assert.equal(client.itemsByIssueNumber.get(915)!.status, "Done");
    // The failing one stayed in Backlog — failure is recoverable next cycle.
    assert.equal(client.itemsByIssueNumber.get(909_010)!.status, "Backlog");
  });
});

// =====================================================================
// runPreDispatchPrep
// =====================================================================
//
// 3 tests for the pre-dispatch label prep loop. The agent-scoped strip
// (`isPipelineLabelForAgent`) is the load-bearing invariant — pre-fix
// the loop stripped ALL pipeline labels, silently erasing
// error:<other-agent> signals from prior cycles (#9 review 2026-05-08).

describe("runPreDispatchPrep", () => {
  test("strips per-agent labels ONLY (does NOT touch other agents' labels — the #9 fix)", async () => {
    const client = new MockGitHubClient({
      labels: { 1000: ["done:developer", "error:architect", "wip:po", "size:m", "needs-rework:code-review"] },
    });
    const item = makeProjectItem({ issueNumber: 1000, labels: client.labelsByIssue.get(1000)! });
    const agent = makeAgentConfig({});  // developer

    await runPreDispatchPrep([{ agent, item }], client);

    const stripped = client.removeLabelCalls.map(c => c.label);
    // Developer's own pipeline label stripped.
    assert.ok(stripped.includes("done:developer"));
    // Other agents' pipeline labels PRESERVED (the load-bearing invariant).
    assert.ok(!stripped.includes("error:architect"), "other agent's error label must survive (human-actionable signal)");
    assert.ok(!stripped.includes("wip:po"), "other agent's wip label must survive");
    assert.ok(!stripped.includes("needs-rework:code-review"), "other agent's needs-rework must survive");
    // Non-pipeline labels left alone.
    assert.ok(!stripped.includes("size:m"));
    // wip:developer added.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1000 && c.label === "wip:developer"));
  });

  test("strips legacy `ready-for-review` and `needs-rework` (no suffix) labels", async () => {
    const client = new MockGitHubClient({
      labels: { 1001: ["ready-for-review", "needs-rework", "size:s"] },
    });
    const item = makeProjectItem({ issueNumber: 1001, labels: client.labelsByIssue.get(1001)! });
    const agent = makeAgentConfig({});

    await runPreDispatchPrep([{ agent, item }], client);

    const stripped = client.removeLabelCalls.map(c => c.label);
    assert.ok(stripped.includes("ready-for-review"), "legacy label must be stripped");
    assert.ok(stripped.includes("needs-rework"), "legacy label must be stripped");
    // wip:developer applied.
    assert.ok(client.addLabelCalls.some(c => c.label === "wip:developer"));
  });

  test("multi-candidate prep is sequential (stable ordering, no interleaving in the recorded calls)", async () => {
    // Sequential ordering matters because two candidates on different
    // tickets shouldn't race for prep. Sequential by design — the for-loop
    // awaits each iteration before the next.
    const client = new MockGitHubClient({
      labels: { 1002: ["done:developer"], 1003: ["done:architect"] },
    });
    const candidates = [
      { agent: makeAgentConfig({}), item: makeProjectItem({ issueNumber: 1002, labels: ["done:developer"] }) },
      { agent: makeAgentConfig({ name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md" }), item: makeProjectItem({ issueNumber: 1003, labels: ["done:architect"] }) },
    ];

    await runPreDispatchPrep(candidates, client);

    // Sequential ordering: all of 1002's ops happen before any of 1003's.
    // Find the index of the first call referencing each issue and assert
    // ordering between them.
    const calls1002 = client.addLabelCalls.findIndex(c => c.issueNumber === 1002);
    const calls1003 = client.addLabelCalls.findIndex(c => c.issueNumber === 1003);
    assert.ok(calls1002 >= 0 && calls1003 >= 0);
    assert.ok(calls1002 < calls1003, "first candidate's wip-add must precede second candidate's");

    // Each candidate got the right wip label.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1002 && c.label === "wip:developer"));
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1003 && c.label === "wip:architect"));
  });
});

// =====================================================================
// runConcurrentDispatches
// =====================================================================
//
// 4 tests for the Promise.allSettled wrapper that drives the cycle's
// concurrent dispatch. Both per-dispatch isolation AND the wip:<agent>
// finally-block discipline are tested.

describe("runConcurrentDispatches", () => {
  test("two candidates → both dispatched, both wip:<agent> stripped after completion", async () => {
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 1100: "In Development", 1101: "In Development" },
      labels: { 1100: ["wip:developer"], 1101: ["wip:developer"] },
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "git rev-parse --verify feature/1100": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/1100": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify feature/1101": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/1101": () => execError({ stderr: "fatal" }),
        "git status --porcelain": () => "",
        "git rev-list --count main..": () => "1\n",
      },
      fsMap: { [claudeMd]: "developer system prompt" },
    });
    const agent = makeAgentConfig({});
    const candidates = [
      { agent, item: makeProjectItem({ issueNumber: 1100 }) },
      { agent, item: makeProjectItem({ issueNumber: 1101 }) },
    ];

    const results = await runConcurrentDispatches(candidates, client, deps);

    // Both promises fulfilled.
    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.status === "fulfilled"));

    // Each ticket's wip:developer was stripped (finally-block ran).
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1100 && c.label === "wip:developer"));
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1101 && c.label === "wip:developer"));

    // Both dispatches completed (stream invoked twice).
    assert.equal(calls.claudeStreams, 2);
  });

  test("one dispatch's uncaught throw → other still completes, both wip:<agent> stripped (Promise.allSettled isolation)", async () => {
    // Force one dispatch to throw OUT of dispatchToAgent. The catch-all
    // inside the per-promise async fn in runConcurrentDispatches catches
    // it (logs to console.error). The other dispatch completes normally.
    // The load-bearing invariant: BOTH wip labels still get stripped
    // (each dispatch's finally runs independently), even when one
    // dispatch's promise rejected internally before being caught.
    //
    // To force the throw: make notifyDiscord (called from
    // handleDispatchError, NOT inside a try/catch on its last line)
    // throw. The chain: streaming errors → handleAgentResultErrors throws
    // → outer catch → handleDispatchError → its trailing notifyDiscord
    // throws → dispatchToAgent rejects.
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 1102: "In Development", 1103: "In Development" },
      labels: { 1102: ["wip:developer"], 1103: ["wip:developer"] },
    });
    const { deps } = makeMockDeps({
      execImpls: {
        "git rev-parse --verify feature/1102": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/1102": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify feature/1103": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/1103": () => execError({ stderr: "fatal" }),
        "git status --porcelain": () => "",
        "git rev-list --count main..": () => "1\n",
      },
      fsMap: { [claudeMd]: "developer system prompt" },
      // 1102 errors mid-stream; 1103 succeeds.
      streamResult: (opts) => opts?.cwd?.includes("developer-1102")
        ? streamResult({ isError: true, terminalReason: "api_error", output: "anthropic API failure" })
        : streamResult({ isError: false, output: "ok" }),
    });
    // Make notifyDiscord throw — only matters for 1102's failure path.
    const customDeps: DispatchDeps = {
      ...deps,
      notifyDiscord: async () => { throw new Error("Discord webhook 5xx"); },
    };
    const agent = makeAgentConfig({});

    const results = await runConcurrentDispatches(
      [
        { agent, item: makeProjectItem({ issueNumber: 1102 }) },
        { agent, item: makeProjectItem({ issueNumber: 1103 }) },
      ],
      client,
      customDeps,
    );

    // Both promises fulfilled — Promise.allSettled isolation holds even
    // when one dispatch internally rejects.
    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.status === "fulfilled"),
      `expected both fulfilled; got ${JSON.stringify(results.map(r => r.status))}`);

    // Both wip:developer stripped — the finally block ran for BOTH
    // dispatches even though one threw mid-flight. This is the
    // load-bearing per-dispatch isolation.
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1102 && c.label === "wip:developer"),
      "1102's wip must be stripped despite its dispatch throwing");
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1103 && c.label === "wip:developer"),
      "1103's wip must be stripped (sibling of the throwing dispatch)");
  });

  test("empty candidates → no dispatch, no error", async () => {
    const client = new MockGitHubClient();
    const { deps, calls } = makeMockDeps({});

    const results = await runConcurrentDispatches([], client, deps);

    assert.equal(results.length, 0);
    assert.equal(calls.claudeStreams, 0);
    assert.equal(client.removeLabelCalls.length, 0);
  });

  test("wip-removal failure in finally is silently swallowed (doesn't reject the outer promise)", async () => {
    // The `try { await client.removeLabel(...) } catch {}` in the
    // finally is the safety net: even if the GitHub API rejects the
    // wip-strip, the per-promise async fn must still resolve. Otherwise
    // a transient API failure on cleanup would propagate as a rejection,
    // and even Promise.allSettled would record it as such.
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const client = new MockGitHubClient({
      status: { 1104: "In Development" },
      labels: { 1104: ["wip:developer"] },
    });
    // Function-form failure: only fails when removing the wip:developer
    // label specifically (so internal removeLabel calls during dispatch
    // don't trigger it).
    client.failures.removeLabel = (issueNumber, label) =>
      issueNumber === 1104 && label === "wip:developer"
        ? new Error("REST 503")
        : null;
    const { deps } = makeMockDeps({
      execImpls: {
        "git rev-parse --verify feature/1104": () => execError({ stderr: "fatal" }),
        "git rev-parse --verify origin/feature/1104": () => execError({ stderr: "fatal" }),
        "git status --porcelain": () => "",
        "git rev-list --count main..": () => "1\n",
      },
      fsMap: { [claudeMd]: "developer system prompt" },
    });
    const agent = makeAgentConfig({});

    const results = await runConcurrentDispatches(
      [{ agent, item: makeProjectItem({ issueNumber: 1104 }) }],
      client,
      deps,
    );

    // The promise still fulfilled despite the finally's removeLabel throwing.
    assert.equal(results.length, 1);
    assert.equal(results[0]!.status, "fulfilled");
    // The attempted wip removal was recorded (failed, but attempted).
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1104 && c.label === "wip:developer"));
  });
});

// =====================================================================
// runAutoMerge
// =====================================================================
//
// 4 tests for the Done-column auto-merge driver. Skip cases (the 4
// guards: merged label, error:merge-conflict label, issueNumber<=0,
// empty PR list) collapse into one parametric test; happy path,
// conflict path, and transient-gh-failure each get their own.

describe("runAutoMerge", () => {
  test("happy path → gh pr merge succeeds, labels stripped, git pull, no Discord notify", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1200, status: "Done", labels: ["done:documentation", "size:s"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        // gh pr list returns the PR number on stdout (raw int).
        "gh pr list --head \"feature/1200\"": () => "789\n",
        // gh pr merge succeeds (empty output).
        "gh pr merge 789 --merge --delete-branch": () => "",
        // Post-merge git pull succeeds.
        "git checkout main && git pull": () => "",
      },
    });

    await runAutoMerge(client, deps);

    // gh pr merge invoked with the right PR number.
    assert.ok(calls.exec.some(c => c.cmd === "gh pr merge 789 --merge --delete-branch"),
      "must invoke `gh pr merge 789 --merge --delete-branch`");
    // Post-merge pull happened.
    assert.ok(calls.exec.some(c => c.cmd === "git checkout main && git pull"));
    // Pipeline label stripped (done:documentation is a pipeline label).
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1200 && c.label === "done:documentation"));
    // Non-pipeline label (size:s) NOT stripped.
    assert.ok(!client.removeLabelCalls.some(c => c.label === "size:s"));
    // Merged ping dropped 2026-06-07 (operator noise reduction) — a clean
    // auto-merge no longer notifies Discord.
    assert.equal(calls.discord.length, 0);
    // No error:merge-conflict label applied (this is a clean merge).
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:merge-conflict"));
  });

  test("merge conflict on retries-exhausted attempt → error:merge-conflict label + triage comment + Discord notify + Status rolled back to In Code Review", async () => {
    // Pre-seeded `merge-attempt:2` simulates the 3rd attempt — that's
    // when retries are exhausted and the dispatcher gives up. Earlier
    // attempts bump the counter and skip; see the retry tests below.
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1201", issueNumber: 1201, status: "Done", labels: ["done:documentation", "merge-attempt:2"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1201\"": () => "790\n",
        // gh pr merge throws with the canonical "not mergeable" stderr —
        // isMergeConflictError matches this verbatim.
        "gh pr merge 790 --merge --delete-branch": () => execError({
          stderr: "X Pull request #790 is not mergeable: the merge commit cannot be cleanly created.",
          message: "Command failed: gh pr merge 790",
        }),
      },
    });

    await runAutoMerge(client, deps);

    // The conflict-block label was applied (stops retry loop on next cycle).
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1201 && c.label === "error:merge-conflict"));
    // Triage comment posted with manual-resolution recipe.
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /Auto-merge blocked by merge conflict/);
    assert.match(client.comments[0]!.body, /gh pr checkout 790/);
    assert.match(client.comments[0]!.body, /git fetch origin main/);
    // Discord notify (one 🛑 message).
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /^🛑 Merge conflict on PR #790/);
    // Pipeline labels NOT stripped (the merge failed, so the ticket
    // isn't really done; labels stay until human resolves). Only the
    // spent retry counter is cleared, so a later return to Done retries
    // afresh.
    assert.deepEqual(
      client.removeLabelCalls.filter(c => c.issueNumber === 1201).map(c => c.label),
      ["merge-attempt:2"],
    );
    // Status rolled back from Done → In Code Review (the column-as-truth
    // fix shipped 2026-05-09 evening). Without this the ticket sits at
    // Status=Done with a still-open conflicting PR — exact bug #218 hit
    // this morning.
    assert.deepEqual(
      client.updateItemStatusCalls,
      [{ itemId: "PVTI_1201", newStatus: "In Code Review" }],
      "merge-conflict path must roll Status back from Done → In Code Review",
    );
    // Items map reflects the rollback (state actually changed, not just recorded).
    assert.equal(client.itemsByIssueNumber.get(1201)!.status, "In Code Review");
  });

  test("merge conflict — Status rollback failure is non-fatal (label still applied, sibling items still process)", async () => {
    // The Status-rollback updateItemStatus is wrapped in its own
    // try/catch — failure must not block the label/comment/Discord
    // path or the loop's `continue` to the next item. Label is the
    // load-bearing signal (blocks re-dispatch via GLOBAL_BLOCK_LABELS);
    // Status is cosmetic correctness.
    //
    // Pre-seeded `merge-attempt:2` on both items so the next conflict
    // triggers the give-up path (retries exhausted), not a counter bump.
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1207", issueNumber: 1207, status: "Done", labels: ["done:documentation", "merge-attempt:2"], state: "OPEN" },
        { id: "PVTI_1208", issueNumber: 1208, status: "Done", labels: ["done:documentation", "merge-attempt:2"], state: "OPEN" },
      ],
    });
    // Rollback fails for 1207 only; 1208 should still process normally.
    client.failures.updateItemStatus = (itemId) =>
      itemId === "PVTI_1207" ? new Error("project field permission denied") : null;
    const { deps } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1207\"": () => "791\n",
        "gh pr list --head \"feature/1208\"": () => "792\n",
        "gh pr merge 791 --merge --delete-branch": () => execError({ stderr: "is not mergeable" }),
        "gh pr merge 792 --merge --delete-branch": () => execError({ stderr: "is not mergeable" }),
      },
    });

    await runAutoMerge(client, deps);

    // Both items got labeled despite 1207's Status rollback failing.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1207 && c.label === "error:merge-conflict"));
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1208 && c.label === "error:merge-conflict"));
    // 1207's Status stayed Done (rollback failed); 1208's rolled back successfully.
    assert.equal(client.itemsByIssueNumber.get(1207)!.status, "Done");
    assert.equal(client.itemsByIssueNumber.get(1208)!.status, "In Code Review");
  });

  test("merge conflict on first attempt → bumps merge-attempt:1, no error:merge-conflict, no comment, no Status rollback", async () => {
    // First conflict (no prior counter): the retry path bumps the
    // counter to 1 and skips the cycle. The dispatcher's natural
    // poll loop produces the retry on the next cycle; a transient
    // race (sibling PR mid-merge) often resolves by then.
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1210", issueNumber: 1210, status: "Done", labels: ["done:documentation"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1210\"": () => "793\n",
        "gh pr merge 793 --merge --delete-branch": () => execError({
          stderr: "X Pull request #793 is not mergeable",
        }),
      },
    });

    await runAutoMerge(client, deps);

    // Counter bumped to 1.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1210 && c.label === "merge-attempt:1"));
    // No give-up signals.
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:merge-conflict"));
    assert.equal(client.comments.length, 0);
    assert.equal(client.updateItemStatusCalls.length, 0);
    // Discord notify NOT sent — give-up only.
    assert.equal(calls.discord.length, 0);
    // No previous-counter to strip on first attempt (currentCount=0).
    assert.ok(!client.removeLabelCalls.some(c => c.label.startsWith("merge-attempt:")));
  });

  test("conflict every cycle with Done cleanup in between → gives up on the third cycle (mobile #878 regression)", async () => {
    // The real poll loop runs runDoneCleanup before runAutoMerge in
    // every cycle. Cleanup used to strip merge-attempt:N from the open
    // Done ticket, so the count read zero each cycle and the retry
    // looped forever instead of handing the conflict back.
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1220", issueNumber: 1220, status: "Done", labels: ["done:documentation"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1220\"": () => "930\n",
        "gh pr merge 930 --merge --delete-branch": () => execError({ stderr: "X Pull request #930 is not mergeable" }),
      },
    });

    for (let cycle = 0; cycle < 3; cycle++) {
      await runDoneCleanup(client);
      await runAutoMerge(client, deps);
    }

    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1220 && c.label === "error:merge-conflict"));
    assert.equal(client.itemsByIssueNumber.get(1220)!.status, "In Code Review");
    assert.equal(calls.discord.length, 1);
    // The spent counter is cleared on give-up.
    assert.ok(!client.itemsByIssueNumber.get(1220)!.labels.some(l => l.startsWith("merge-attempt:")));
  });

  test("merge succeeds after a retry → merge-attempt counter cleared with the pipeline labels", async () => {
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1221", issueNumber: 1221, status: "Done", labels: ["done:documentation", "merge-attempt:1"], state: "OPEN" },
      ],
    });
    const { deps } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1221\"": () => "931\n",
      },
    });

    await runAutoMerge(client, deps);

    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1221 && c.label === "merge-attempt:1"));
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1221 && c.label === "done:documentation"));
  });

  test("merge conflict on second attempt (merge-attempt:1) → bumps to merge-attempt:2, strips merge-attempt:1, no give-up", async () => {
    // Second conflict: bump counter to 2, strip the previous counter
    // to prevent accumulation.
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1211", issueNumber: 1211, status: "Done", labels: ["done:documentation", "merge-attempt:1"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1211\"": () => "794\n",
        "gh pr merge 794 --merge --delete-branch": () => execError({ stderr: "is not mergeable" }),
      },
    });

    await runAutoMerge(client, deps);

    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1211 && c.label === "merge-attempt:2"));
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1211 && c.label === "merge-attempt:1"));
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:merge-conflict"));
    assert.equal(client.comments.length, 0);
    assert.equal(calls.discord.length, 0);
  });

  test("rebase-time conflict, merge conflicts too, first attempt → plain merge tried, then bumps merge-attempt:1", async () => {
    // A rebase conflict falls back to the plain merge. When the merge
    // conflicts as well, the conflict is real and the usual retry
    // counter applies.
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1410", issueNumber: 1410, status: "Done", labels: ["done:documentation"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1410\"": () => "910\n",
        "gh pr update-branch 910 --rebase": () => execError({ stderr: "is not mergeable" }),
        "gh pr merge 910 --merge --delete-branch": () => execError({ stderr: "is not mergeable" }),
      },
    });

    await runAutoMerge(client, deps);

    assert.ok(calls.exec.some(c => c.cmd === "gh pr merge 910 --merge --delete-branch"),
      "a rebase conflict must fall back to the plain merge");
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1410 && c.label === "merge-attempt:1"));
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:merge-conflict"));
  });

  test("rebase refused over a conflict the plain merge does not have → merges with a merge commit (#823 / PR 834)", async () => {
    // The branch had settled an earlier conflict by merging main. A
    // rebase replays the branch's own commits and ignores that merge, so
    // GitHub refuses it — with an error none of the conflict phrases
    // matched, which made the dispatcher skip the ticket silently every
    // cycle. The plain merge is clean. Error text captured verbatim from
    // a throwaway repo on 2026-09-23.
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1411", issueNumber: 1411, status: "Done", labels: ["done:documentation"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1411\"": () => "911\n",
        "gh pr update-branch 911 --rebase": () => execError({
          stderr: "GraphQL: rebase conflict between base and head (updatePullRequestBranch)",
          message: "Command failed: gh pr update-branch 911 --rebase",
        }),
        "gh pr merge 911 --merge --delete-branch": () => "",
        "git checkout main && git pull": () => "",
      },
    });

    await runAutoMerge(client, deps);

    assert.ok(calls.exec.some(c => c.cmd === "gh pr merge 911 --merge --delete-branch"),
      "must fall back to the plain merge");
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1411 && c.label === "done:documentation"),
      "a successful fallback merge cleans labels like any merge");
    assert.ok(!client.addLabelCalls.some(c => c.label.startsWith("merge-attempt:") || c.label.startsWith("error:")));
    assert.equal(client.updateItemStatusCalls.length, 0);
  });

  test("skip cases — merged label, error:merge-conflict label, issueNumber=0 → no gh pr list invoked", async () => {
    // Three skip-cases plus one normal item that DOES go through the
    // gh-pr-list step (so we can confirm the skip is selective, not
    // absolute). Fourth item has no PR (empty stdout) → continues
    // without merge.
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1202", issueNumber: 1202, status: "Done", labels: ["merged", "size:s"], state: "OPEN" },                     // skip: merged
        { id: "PVTI_1203", issueNumber: 1203, status: "Done", labels: ["error:merge-conflict"], state: "OPEN" },                  // skip: conflicted
        { id: "PVTI_1204", issueNumber: 0,    status: "Done", labels: [], state: "OPEN" },                                        // skip: issue-0 (epic)
        { id: "PVTI_1205", issueNumber: 1205, status: "Done", labels: ["done:documentation"], state: "OPEN" },                  // would process if it had a PR
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        // Item 1205's PR list returns empty (no open PR) → skip without merging.
        "gh pr list --head \"feature/1205\"": () => "",
      },
    });

    await runAutoMerge(client, deps);

    // No gh pr list calls were made for the three skip-case items.
    const ghListCalls = calls.exec.filter(c => c.cmd.includes("gh pr list"));
    assert.equal(ghListCalls.length, 1, "exactly one gh pr list (for 1205); skip-cases bypass the call entirely");
    assert.ok(ghListCalls[0]!.cmd.includes("feature/1205"));
    // No merges happened at all (1205's PR list was empty; others skipped).
    assert.ok(!calls.exec.some(c => c.cmd.includes("gh pr merge")));
    // No labels added or stripped.
    assert.equal(client.addLabelCalls.length, 0);
    assert.equal(client.removeLabelCalls.length, 0);
  });

  test("transient gh pr list failure → skip silently, retry next cycle (no error label)", async () => {
    // Network/auth/rate-limit failures on the PR-existence lookup are
    // transient. The dispatcher must skip the merge for this cycle and
    // try again next cycle — applying error:<agent> here would
    // permanently block legitimate PRs.
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1206, status: "Done", labels: ["done:documentation"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1206\"": () => execError({
          stderr: "GraphQL error: rate limit exceeded",
          message: "Command failed: gh pr list",
        }),
      },
    });

    await runAutoMerge(client, deps);

    // No merge attempt.
    assert.ok(!calls.exec.some(c => c.cmd.includes("gh pr merge")));
    // No error label applied — the failure is transient.
    assert.ok(!client.addLabelCalls.some(c => c.label.startsWith("error:")));
    // No comment, no Discord notify.
    assert.equal(client.comments.length, 0);
    assert.equal(calls.discord.length, 0);
  });

  test("happy path → codegraph index -f invoked when .codegraph exists at repoRoot", async () => {
    // Post-merge codegraph reindex: codegraph has no reliable watcher,
    // and the dispatcher only refreshes the index when explicitly told
    // (no per-spawn reindex, no FSEvents in stdio MCP). The natural seam
    // is right after a successful auto-merge — main has just stabilized,
    // and subsequent ticket spawns will be querying a fresh shape.
    //
    // Non-fatal: codegraph isn't load-bearing (agents fall through to
    // grep when index is missing/stale). Failure logs a warning and the
    // rest of the merge flow continues.
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1300, status: "Done", labels: ["done:documentation"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      fsMap: { [TEST_CODEGRAPH_PATH]: "" },  // existsSync returns true → reindex runs
      execImpls: {
        "gh pr list --head \"feature/1300\"": () => "800\n",
        "gh pr merge 800 --merge --delete-branch": () => "",
        "git checkout main && git pull": () => "",
        "codegraph index -f": () => "✓ Indexed 14 files",
      },
    });

    await runAutoMerge(client, deps);

    // codegraph index -f invoked at the target repo root.
    const cgCall = calls.exec.find(c => c.cmd.includes("codegraph index -f"));
    assert.ok(cgCall, "codegraph index -f must be invoked when .codegraph exists");
    assert.equal(cgCall.opts?.cwd, TEST_REPO_ROOT, "must run codegraph index -f at the target repo root");
    // Standard merge path still completed (label cleanup). Merged ping
    // dropped 2026-06-07 — no Discord notify.
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1300 && c.label === "done:documentation"));
    assert.equal(calls.discord.length, 0);
  });

  test("no .codegraph at repoRoot → reindex skipped silently", async () => {
    // If the target repo has no codegraph index (operator hasn't
    // bootstrapped one yet), the dispatcher's existing pre-flight already
    // warned about it at startup. The post-merge step must not invoke
    // `codegraph index -f` against a non-existent index — that would
    // either error or auto-bootstrap (codegraph CLI behaviour varies),
    // both of which are surprising side-effects of a merge.
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1301, status: "Done", labels: ["done:documentation"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      fsMap: {},  // no .codegraph at repoRoot → existsSync returns false
      execImpls: {
        "gh pr list --head \"feature/1301\"": () => "801\n",
        "gh pr merge 801 --merge --delete-branch": () => "",
        "git checkout main && git pull": () => "",
      },
    });

    await runAutoMerge(client, deps);

    // No codegraph invocation of any kind.
    assert.ok(!calls.exec.some(c => c.cmd.includes("codegraph")),
      "no codegraph command should run when .codegraph is absent");
    // Standard merge path still completed. Merged ping dropped 2026-06-07 —
    // no Discord notify.
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1301));
    assert.equal(calls.discord.length, 0);
  });

  test("codegraph reindex failure is non-fatal — labels still cleaned", async () => {
    // Codegraph isn't load-bearing. If `codegraph index -f` errors
    // (lock contention, disk full, transient binary issue), the
    // dispatcher must log a warning and continue — the merge already
    // happened on origin, the labels matter more than a temporarily
    // stale index. Same posture as the existing post-merge `git pull`
    // failure path (line 1858-1861).
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1302, status: "Done", labels: ["done:documentation"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      fsMap: { [TEST_CODEGRAPH_PATH]: "" },
      execImpls: {
        "gh pr list --head \"feature/1302\"": () => "802\n",
        "gh pr merge 802 --merge --delete-branch": () => "",
        "git checkout main && git pull": () => "",
        "codegraph index -f": () => execError({
          stderr: "Error: lock file exists at /path/.codegraph/lock",
          message: "Command failed: codegraph index -f",
        }),
      },
    });

    await runAutoMerge(client, deps);

    // The reindex was attempted (proves the path runs even on failure).
    assert.ok(calls.exec.some(c => c.cmd.includes("codegraph index -f")));
    // Critical: the rest of the merge path completed despite codegraph's failure.
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1302 && c.label === "done:documentation"));
    // Merged ping dropped 2026-06-07 — no Discord notify.
    assert.equal(calls.discord.length, 0);
    // No error label applied — codegraph failure isn't a ticket-level signal.
    assert.ok(!client.addLabelCalls.some(c => c.label.startsWith("error:")));
  });

  test("pre-merge rebase succeeds → gh pr update-branch invoked before gh pr merge, happy path completes", async () => {
    // The dispatcher rebases the feature branch onto current main BEFORE
    // attempting the merge. Catches retroactive sibling conflicts that
    // architect-time `git branch -r` overlap couldn't see (sibling PRs
    // landing AFTER architect ran). Pre-fix, this surfaced as
    // `error:merge-conflict` at merge time (see Lessons.md
    // "Auto-merge fails silently on stale-PR conflicts"); post-fix, GitHub
    // performs the rebase server-side and the subsequent merge proceeds
    // against fresh base.
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1400, status: "Done", labels: ["done:documentation", "size:s"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1400\"": () => "900\n",
        "gh pr update-branch 900 --rebase": () => "",
        "gh pr merge 900 --merge --delete-branch": () => "",
        "git checkout main && git pull": () => "",
      },
    });

    await runAutoMerge(client, deps);

    // Both calls happened, in order: update-branch first, then merge.
    const updateIdx = calls.exec.findIndex(c => c.cmd === "gh pr update-branch 900 --rebase");
    const mergeIdx = calls.exec.findIndex(c => c.cmd === "gh pr merge 900 --merge --delete-branch");
    assert.ok(updateIdx >= 0, "must invoke `gh pr update-branch 900 --rebase` before merge");
    assert.ok(mergeIdx >= 0, "merge must still run on rebase success");
    assert.ok(updateIdx < mergeIdx, "update-branch must precede merge");
    // Standard happy-path post-conditions still hold.
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1400 && c.label === "done:documentation"));
    // Merged ping dropped 2026-06-07 — no Discord notify.
    assert.equal(calls.discord.length, 0);
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:merge-conflict"));
  });

  test("pre-merge rebase conflict, merge conflicts too, retries exhausted → label + comment + Status rollback", async () => {
    // A rebase conflict falls back to the plain merge (2026-09-23: a
    // rebase can conflict where the merge is clean). When the merge
    // conflicts as well, the same load-bearing conflict path applies:
    // label + triage comment + Discord + Status rollback.
    //
    // Pre-seeded `merge-attempt:2` so this is the 3rd (final) attempt —
    // retries exhausted, dispatcher gives up.
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1401", issueNumber: 1401, status: "Done", labels: ["done:documentation", "merge-attempt:2"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1401\"": () => "901\n",
        // gh pr update-branch fails with a "not mergeable" stderr —
        // isMergeConflictError matches the substring, mirroring the
        // existing merge-conflict test.
        "gh pr update-branch 901 --rebase": () => execError({
          stderr: "X Pull request #901 is not mergeable: the merge commit cannot be cleanly created.",
          message: "Command failed: gh pr update-branch 901 --rebase",
        }),
        "gh pr merge 901 --merge --delete-branch": () => execError({
          stderr: "X Pull request #901 is not mergeable: the merge commit cannot be cleanly created.",
          message: "Command failed: gh pr merge 901",
        }),
      },
    });

    await runAutoMerge(client, deps);

    // The plain merge was tried after the rebase conflict.
    assert.ok(calls.exec.some(c => c.cmd === "gh pr merge 901 --merge --delete-branch"),
      "a rebase conflict must fall back to the plain merge");
    // Conflict-block label applied (stops retry loop).
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 1401 && c.label === "error:merge-conflict"));
    // Triage comment posted.
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /Auto-merge blocked by merge conflict/);
    assert.match(client.comments[0]!.body, /gh pr checkout 901/);
    // Discord notify (one 🛑).
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /^🛑 Merge conflict on PR #901/);
    // Status rolled back to In Code Review.
    assert.deepEqual(
      client.updateItemStatusCalls,
      [{ itemId: "PVTI_1401", newStatus: "In Code Review" }],
      "rebase-conflict path must roll Status back from Done → In Code Review",
    );
    assert.equal(client.itemsByIssueNumber.get(1401)!.status, "In Code Review");
  });

  test("pre-merge rebase transient failure (non-conflict) → silent skip, no label, no merge attempt this cycle", async () => {
    // Network/auth/rate-limit failures on `gh pr update-branch` are
    // transient. Same posture as the PR-list transient-failure path:
    // skip silently, retry next cycle, do NOT apply any error label
    // (an error label permanently blocks legitimate PRs). Crucially,
    // we also must not fall through to the merge step — the next
    // cycle will re-attempt the rebase, which is the correctness path.
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1402, status: "Done", labels: ["done:documentation"], state: "OPEN" },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1402\"": () => "902\n",
        "gh pr update-branch 902 --rebase": () => execError({
          stderr: "GraphQL error: rate limit exceeded",
          message: "Command failed: gh pr update-branch",
        }),
      },
    });

    await runAutoMerge(client, deps);

    // No merge attempt this cycle.
    assert.ok(!calls.exec.some(c => c.cmd.includes("gh pr merge")));
    // No error label applied (transient failure).
    assert.ok(!client.addLabelCalls.some(c => c.label.startsWith("error:")));
    // No comment, no Discord notify.
    assert.equal(client.comments.length, 0);
    assert.equal(calls.discord.length, 0);
    // Status NOT rolled back — the ticket may yet succeed next cycle.
    assert.equal(client.updateItemStatusCalls.length, 0);
  });
});

// =====================================================================
// runParentClose
// =====================================================================
//
// A parent ticket's work lands through its sub-issues' PRs, so no PR ever
// closes the parent itself. Before 2026-09-23 nothing closed it: five
// parents (Mobile #652, Desktop #1558/#1497/#1488/#1251) sat open in Done
// with every sub-issue closed. A ticket with no sub-issues is never
// touched — tui-driver #185 sits open in Done on purpose.

describe("runParentClose", () => {
  test("Done parent with every sub-issue closed and no open PR → comment + close", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1500, status: "Done", labels: [], state: "OPEN", subIssues: { total: 2, completed: 2 } },
      ],
    });
    const { deps, calls } = makeMockDeps({
      execImpls: { "gh pr list --head \"feature/1500\"": () => "" },
    });

    await runParentClose(client, deps);

    assert.deepEqual(client.closeIssueCalls, [1500]);
    assert.equal(client.comments.length, 1);
    assert.equal(client.comments[0]!.issueNumber, 1500);
    assert.match(client.comments[0]!.body, /2 of 2 sub-issues/);
    // Comment first, so the reason is on the ticket before it closes.
    assert.ok(calls.exec.some(c => c.cmd.includes("feature/1500")), "must check for the parent's own open PR");
  });

  test("a sub-issue still open → left open", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1501, status: "Done", labels: [], state: "OPEN", subIssues: { total: 3, completed: 2 } },
      ],
    });
    const { deps, calls } = makeMockDeps();

    await runParentClose(client, deps);

    assert.equal(client.closeIssueCalls.length, 0);
    assert.equal(client.comments.length, 0);
    assert.equal(calls.exec.length, 0, "no PR lookup for a ticket that is not a candidate");
  });

  test("no sub-issues (unknown or zero) → never touched, even open in Done (tui-driver #185)", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1502, status: "Done", labels: [], state: "OPEN" },
        { issueNumber: 1503, status: "Done", labels: [], state: "OPEN", subIssues: { total: 0, completed: 0 } },
      ],
    });
    const { deps, calls } = makeMockDeps();

    await runParentClose(client, deps);

    assert.equal(client.closeIssueCalls.length, 0);
    assert.equal(client.comments.length, 0);
    assert.equal(calls.exec.length, 0);
  });

  test("not in Done → left open, even with every sub-issue closed", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1504, status: "In Development", labels: [], state: "OPEN", subIssues: { total: 1, completed: 1 } },
      ],
    });
    const { deps } = makeMockDeps();

    await runParentClose(client, deps);

    assert.equal(client.closeIssueCalls.length, 0);
  });

  test("the parent has its own open PR → left open for the auto-merge", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1505, status: "Done", labels: [], state: "OPEN", subIssues: { total: 1, completed: 1 } },
      ],
    });
    const { deps } = makeMockDeps({
      execImpls: { "gh pr list --head \"feature/1505\"": () => "950\n" },
    });

    await runParentClose(client, deps);

    assert.equal(client.closeIssueCalls.length, 0);
    assert.equal(client.comments.length, 0);
  });

  test("the PR lookup fails → left open this cycle (fail closed)", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1506, status: "Done", labels: [], state: "OPEN", subIssues: { total: 1, completed: 1 } },
      ],
    });
    const { deps } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1506\"": () => execError({ stderr: "GraphQL error: rate limit exceeded" }),
      },
    });

    await runParentClose(client, deps);

    assert.equal(client.closeIssueCalls.length, 0);
  });

  test("error:merge-conflict on the parent → left open for the human", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1507, status: "Done", labels: ["error:merge-conflict"], state: "OPEN", subIssues: { total: 1, completed: 1 } },
      ],
    });
    const { deps, calls } = makeMockDeps();

    await runParentClose(client, deps);

    assert.equal(client.closeIssueCalls.length, 0);
    assert.equal(calls.exec.length, 0);
  });

  test("a close failure is non-fatal — the next parent still closes", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1508, status: "Done", labels: [], state: "OPEN", subIssues: { total: 1, completed: 1 } },
        { issueNumber: 1509, status: "Done", labels: [], state: "OPEN", subIssues: { total: 4, completed: 4 } },
      ],
    });
    client.failures.closeIssue = (n) => (n === 1508 ? new Error("403 forbidden") : null);
    const { deps } = makeMockDeps({
      execImpls: {
        "gh pr list --head \"feature/1508\"": () => "",
        "gh pr list --head \"feature/1509\"": () => "",
      },
    });

    await runParentClose(client, deps);

    assert.deepEqual(client.closeIssueCalls, [1508, 1509]);
    assert.equal(client.itemsByIssueNumber.get(1509)!.state, "CLOSED");
  });
});

// =====================================================================
// decideSigint
// =====================================================================
//
// SIGINT handler decision logic. The behaviour locked here:
//
//   - First SIGINT (drainMode false) → drain-init, record timestamp.
//   - Second SIGINT within SIGINT_DEBOUNCE_MS (500ms) → ignore-debounce.
//     This is pnpm/tsx forwarding a single user Ctrl+C as two SIGINTs.
//     Without this guard the force-exit logic misfires on the first
//     human press. State is NOT updated on ignore — the force-exit window
//     stays measured from the original press.
//   - SIGINT between SIGINT_DEBOUNCE_MS and SIGINT_FORCE_EXIT_WINDOW_MS
//     (500ms-5s) → force-exit. Deliberate double-tap.
//   - SIGINT after SIGINT_FORCE_EXIT_WINDOW_MS (>5s) → drain-already,
//     reset the timestamp so a fresh double-tap window opens.
//
// Surfaced 2026-05-22 when bin/pyry-start showed Ctrl+C firing the drain
// message AND the force-exit message back-to-back from a single user press.

describe("decideSigint", () => {
  const T0 = 1_000_000;  // arbitrary base for deterministic deltas

  test("first SIGINT → drain-init, records timestamp", () => {
    const initial: SigintState = { drainMode: false, lastSigintAt: 0 };
    const { action, newState } = decideSigint(initial, T0);
    assert.equal(action.kind, "drain-init");
    assert.deepEqual(newState, { drainMode: true, lastSigintAt: T0 });
  });

  test("SIGINT within debounce window → ignore-debounce, state unchanged", () => {
    // 10ms after drain-init: pnpm forwarding duplicate.
    const drained: SigintState = { drainMode: true, lastSigintAt: T0 };
    const { action, newState } = decideSigint(drained, T0 + 10);
    assert.equal(action.kind, "ignore-debounce");
    assert.deepEqual(newState, drained, "state must NOT be updated — the force-exit window stays measured from the original press");
  });

  test("SIGINT at the debounce boundary (exactly SIGINT_DEBOUNCE_MS) → force-exit (boundary is half-open: [0, DEBOUNCE) ignore, [DEBOUNCE, WINDOW) force-exit)", () => {
    const drained: SigintState = { drainMode: true, lastSigintAt: T0 };
    const { action } = decideSigint(drained, T0 + SIGINT_DEBOUNCE_MS);
    assert.equal(action.kind, "force-exit");
  });

  test("SIGINT just inside force-exit window (1s after drain) → force-exit", () => {
    const drained: SigintState = { drainMode: true, lastSigintAt: T0 };
    const { action } = decideSigint(drained, T0 + 1_000);
    assert.equal(action.kind, "force-exit");
  });

  test("SIGINT at force-exit window boundary (exactly 5s) → drain-already (boundary half-open)", () => {
    const drained: SigintState = { drainMode: true, lastSigintAt: T0 };
    const { action, newState } = decideSigint(drained, T0 + SIGINT_FORCE_EXIT_WINDOW_MS);
    assert.equal(action.kind, "drain-already");
    assert.deepEqual(newState, { drainMode: true, lastSigintAt: T0 + SIGINT_FORCE_EXIT_WINDOW_MS });
  });

  test("SIGINT well after force-exit window (10s after) → drain-already, timestamp refreshed", () => {
    // User pressed Ctrl+C, let it drain for 10s, then pressed Ctrl+C again
    // to change their mind. Should re-open a double-tap window from this point.
    const drained: SigintState = { drainMode: true, lastSigintAt: T0 };
    const { action, newState } = decideSigint(drained, T0 + 10_000);
    assert.equal(action.kind, "drain-already");
    assert.deepEqual(newState, { drainMode: true, lastSigintAt: T0 + 10_000 });
  });

  test("the pnpm-double-forward sequence (the bug this fixes): drain-init then ignore-debounce within 20ms", () => {
    // Reproduces the 2026-05-22 incident. First SIGINT arrives from terminal
    // pgroup-wide delivery; second arrives ~20ms later from pnpm's
    // signal-forwarding. Pre-fix, both were classified by the force-exit
    // logic → first press force-exited the dispatcher.
    let state: SigintState = { drainMode: false, lastSigintAt: 0 };

    const first = decideSigint(state, T0);
    assert.equal(first.action.kind, "drain-init", "first SIGINT should enter drain mode");
    state = first.newState;

    const second = decideSigint(state, T0 + 20);
    assert.equal(second.action.kind, "ignore-debounce", "second SIGINT 20ms later is a pnpm/tsx forwarding duplicate — must NOT force-exit");
    assert.deepEqual(second.newState, first.newState, "state must remain measured from the original press");
  });

  test("deliberate user double-tap (~1s apart) still triggers force-exit", () => {
    // User presses, sees drain message, decides to force-exit. ~1s later
    // they press again. The fix preserves this path.
    let state: SigintState = { drainMode: false, lastSigintAt: 0 };
    state = decideSigint(state, T0).newState;
    const second = decideSigint(state, T0 + 1_000);
    assert.equal(second.action.kind, "force-exit");
  });
});

// =====================================================================
// countActiveWork + decideDrainNotification — "board drained" ping
// =====================================================================
//
// countActiveWork counts tickets still moving on their own (running or
// mid transient-retry, NOT blocked/parked/done/idle). decideDrainNotification
// is the pure edge-trigger that fires the 📭 "board drained" ping exactly once
// when a board goes from busy to nothing-left-to-dispatch.

describe("countActiveWork", () => {
  const cols = (items: ProjectItem[]) =>
    new Map<string, ProjectItem[]>([["In Development", items]]);

  test("counts a running ticket (wip:<agent>)", () => {
    const m = cols([makeProjectItem({ issueNumber: 1, labels: ["wip:developer"] })]);
    assert.equal(countActiveWork(m), 1);
  });

  test("counts a transient retry that is NOT parked (backoff-waiting or re-dispatched)", () => {
    const m = cols([
      makeProjectItem({ issueNumber: 1, labels: ["error-retry-count:1"] }),           // waiting in backoff
      makeProjectItem({ issueNumber: 2, labels: ["error-retry-count:2", "wip:qa"] }),  // re-dispatched
    ]);
    assert.equal(countActiveWork(m), 2);
  });

  test("does NOT count an error-parked ticket, even with a leftover retry counter", () => {
    const m = cols([
      makeProjectItem({ issueNumber: 1, labels: ["error:developer"] }),
      makeProjectItem({ issueNumber: 2, labels: ["error:qa", "error-retry-count:3"] }),
    ]);
    assert.equal(countActiveWork(m), 0);
  });

  test("does NOT count a blocked, done, or idle ticket (no wip, no retry counter)", () => {
    const m = cols([
      makeProjectItem({ issueNumber: 1, labels: ["size:s"], blockedBy: [{ number: 9, state: "OPEN" }] }),
      makeProjectItem({ issueNumber: 2, labels: ["done:developer"] }),
      makeProjectItem({ issueNumber: 3, labels: [] }),
    ]);
    assert.equal(countActiveWork(m), 0);
  });

  test("sums active work across columns, ignoring inactive tickets", () => {
    const m = new Map<string, ProjectItem[]>([
      ["In Development", [
        makeProjectItem({ issueNumber: 1, labels: ["wip:developer"] }),       // active
        makeProjectItem({ issueNumber: 2, labels: ["done:developer"] }),      // not active
      ]],
      ["In QA", [
        makeProjectItem({ issueNumber: 3, labels: ["error-retry-count:1"] }), // active (retrying)
        makeProjectItem({ issueNumber: 4, labels: ["error:qa"] }),            // not active (parked)
      ]],
      ["Backlog", [
        makeProjectItem({ issueNumber: 5, labels: [] }),                      // not active (idle)
      ]],
    ]);
    assert.equal(countActiveWork(m), 2); // #1 + #3 only
  });

  test("an empty board counts as zero active work", () => {
    assert.equal(countActiveWork(new Map()), 0);
    assert.equal(countActiveWork(cols([])), 0);
  });
});

describe("decideDrainNotification", () => {
  test("a board idle from startup never pings (never armed)", () => {
    let armed = false;
    for (let i = 0; i < 3; i++) {
      const r = decideDrainNotification({ hasCandidates: false, activeWork: 0, armed });
      assert.equal(r.notify, false, "an unarmed, drained board must stay quiet");
      armed = r.armed;
    }
    assert.equal(armed, false);
  });

  test("dispatch candidates this cycle arm the board without pinging", () => {
    const r = decideDrainNotification({ hasCandidates: true, activeWork: 0, armed: false });
    assert.deepEqual(r, { notify: false, armed: true });
  });

  test("active work in flight (no candidates) also arms without pinging", () => {
    const r = decideDrainNotification({ hasCandidates: false, activeWork: 1, armed: false });
    assert.deepEqual(r, { notify: false, armed: true });
  });

  test("busy → drained fires the ping exactly once, then stays silent", () => {
    // Cycle 1: work present → arm, no ping.
    let s = decideDrainNotification({ hasCandidates: true, activeWork: 0, armed: false });
    assert.deepEqual(s, { notify: false, armed: true });

    // Cycle 2: board drained while armed → ping once, disarm.
    s = decideDrainNotification({ hasCandidates: false, activeWork: 0, armed: s.armed });
    assert.deepEqual(s, { notify: true, armed: false });

    // Cycle 3: still drained but no longer armed → silent.
    s = decideDrainNotification({ hasCandidates: false, activeWork: 0, armed: s.armed });
    assert.deepEqual(s, { notify: false, armed: false });
  });

  test("new work after a drain re-arms the board so the next drain pings again", () => {
    // Drain once.
    let s = decideDrainNotification({ hasCandidates: true, activeWork: 0, armed: false });
    s = decideDrainNotification({ hasCandidates: false, activeWork: 0, armed: s.armed });
    assert.equal(s.notify, true);

    // New work appears → re-arm (no ping).
    s = decideDrainNotification({ hasCandidates: false, activeWork: 2, armed: s.armed });
    assert.deepEqual(s, { notify: false, armed: true });

    // It drains again → pings again.
    s = decideDrainNotification({ hasCandidates: false, activeWork: 0, armed: s.armed });
    assert.equal(s.notify, true);
  });
});

// =====================================================================
// Detached-child contract: spawn options + pgrp teardown
// =====================================================================
//
// Source-level tripwires. `runClaudeStreamingOnce` lives below the
// `DispatchDeps` injection boundary — the production `spawn(bin, args,
// {...})` call and the signal handlers cannot be intercepted from this
// test suite, so we lock the contract by asserting the relevant tokens
// are literally present in dispatch.ts. If a future refactor drops one
// of these, the corresponding test fails before the regression ships.
//
// The four invariants under test (introduced 2026-05-22 + 2026-05-23):
//
//   1. The claude spawn uses `detached: true` so terminal Ctrl+C
//      doesn't kill the child directly via pgrp delivery.
//   2. There is exactly one `spawn(bin, args, {...})` call in the
//      file, so (1) is unambiguous about which spawn it's checking.
//   3. Intentional teardown paths use `process.kill(-pid, sig)` (pgrp
//      kill), not bare `child.kill(sig)` — otherwise the grandchild
//      (`claude` under `pyry agent-run`) orphans when the immediate
//      child dies and keeps consuming API credits unattended.
//   4. A SIGHUP handler is installed, so closing the terminal window
//      (or losing an SSH session) tears down detached children
//      instead of letting them orphan to launchd.

const dispatchTsPath = resolve(dirname(fileURLToPath(import.meta.url)), "dispatch.ts");
const readDispatchSource = (): string => readFileSync(dispatchTsPath, "utf8");

describe("runClaudeStreamingOnce spawn options", () => {
  test("exactly one `spawn(bin, args, {...})` call exists in dispatch.ts (anchor for the detached-true assertion below)", () => {
    const source = readDispatchSource();
    const matches = [...source.matchAll(/spawn\(bin, args, \{[\s\S]*?\}\);/g)];
    assert.equal(
      matches.length,
      1,
      "exactly one `spawn(bin, args, { ... });` must exist in dispatch.ts — if a second is added, this tripwire becomes ambiguous about which spawn it's asserting against. Narrow the regex (e.g. anchor on the `runClaudeStreamingOnce` function name) before adding a second call site.",
    );
  });

  test("spawn options include detached:true so terminal Ctrl+C does not reach the child via pgrp delivery", () => {
    const source = readDispatchSource();
    // Locate the single spawn call inside runClaudeStreamingOnce. We
    // anchor on the bin/args identifiers used at that call site so a
    // future renamed variable forces the test to be re-anchored
    // (intentional) rather than silently matching a different spawn.
    const spawnCallMatch = source.match(/spawn\(bin, args, \{[\s\S]*?\}\);/);
    assert.ok(spawnCallMatch, "expected to find `spawn(bin, args, { ... });` in dispatch.ts");
    const spawnCall = spawnCallMatch[0];

    assert.match(
      spawnCall,
      /\bdetached:\s*true\b/,
      "the claude spawn must include `detached: true` so the child runs in its own process group and terminal Ctrl+C does not kill it directly — see decideSigint block above for the corresponding parent-side debounce",
    );
  });
});

/**
 * Slice `source` from the start of a function/handler declaration to
 * the next top-level construct. "Top-level" = a line that starts with
 * `function `, `export function `, `const `, `let `, `var `, `class `,
 * or `process.on(` — anchored at the start of a line (no leading
 * whitespace), so nested code inside the slice doesn't terminate
 * extraction early.
 *
 * Used by the tripwires below to scope assertions to specific
 * function/handler bodies rather than scanning the whole file.
 * Returns `null` if the start anchor isn't found.
 */
const sliceDeclaration = (source: string, startAnchor: string): string | null => {
  const start = source.indexOf(startAnchor);
  if (start < 0) return null;
  // Search forward from just past the start anchor for the next
  // top-level boundary. The pattern allows leading newline + any of
  // the recognized declaration keywords (or `process.on(`).
  const tail = source.slice(start + startAnchor.length);
  const boundaryMatch = tail.match(/\n(?:export\s+)?(?:function |const |let |var |class |process\.on\()/);
  const sliceEnd = boundaryMatch && boundaryMatch.index !== undefined
    ? start + startAnchor.length + boundaryMatch.index
    : undefined;
  return source.slice(start, sliceEnd);
};

/**
 * Strip JS/TS comments from a source slice for tripwire matching.
 * KNOWN LIMITATION: this is a naive regex strip — it incorrectly
 * removes the tail of any line containing `//` inside a string
 * literal (e.g. a URL like `"https://example.com"`), and incorrectly
 * removes content between `/*` and the next `*​/` even when those
 * appear inside strings. The current dispatch.ts has no such cases
 * on lines that the tripwires below scrutinise, but a future edit
 * that introduces a URL on the same line as a `child.kill(` call
 * would create a false-negative in the "no bare child.kill" tripwire.
 *
 * Acceptable trade-off because (a) the test surface is small enough
 * to audit manually if a tripwire ever quietly passes when it
 * shouldn't, (b) upgrading to a real tokenizer adds a dependency for
 * marginal benefit, and (c) violating the convention is rare enough
 * that the false-negative window is narrow.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("detached-child teardown uses pgrp-kill", () => {
  test("`killChildPgrp` body sends `process.kill(-pid, sig)` (pgrp syntax)", () => {
    const body = sliceDeclaration(readDispatchSource(), "function killChildPgrp(");
    assert.ok(body, "could not locate `function killChildPgrp(` in dispatch.ts");
    const code = stripComments(body);
    assert.match(
      code,
      /process\.kill\(\s*-/,
      "`killChildPgrp` must signal the whole pgrp via `process.kill(-pid, sig)` — not bare `child.kill(sig)` which only reaches the immediate child and orphans the grandchild.",
    );
  });

  test("`killChildPgrp` body does NOT fall back to bare `child.kill(` on error (the orphaning bug the helper exists to prevent)", () => {
    const body = sliceDeclaration(readDispatchSource(), "function killChildPgrp(");
    assert.ok(body, "could not locate `function killChildPgrp(` in dispatch.ts");
    const code = stripComments(body);
    assert.doesNotMatch(
      code,
      /\bchild\.kill\(/,
      "`killChildPgrp` must NOT fall back to `child.kill(sig)` on non-ESRCH errors. A fallback re-creates the exact orphan-grandchild bug this helper exists to prevent, silently, in the unusual environments (EPERM, restricted namespaces) where the fallback would actually fire. Log loudly via `console.error` instead and let the caller proceed.",
    );
  });

  test("a SIGHUP handler is installed in `installSignalHandlers` so terminal-disconnect tears down detached children", () => {
    const body = sliceDeclaration(readDispatchSource(), "export function installSignalHandlers(");
    assert.ok(body, "could not locate `export function installSignalHandlers(` — handlers must live in this function so test imports don't inherit them at module load");
    assert.match(
      body,
      /process\.on\(\s*["']SIGHUP["']/,
      "without a SIGHUP handler, closing the terminal (Cmd-W on iTerm / SSH disconnect) exits the dispatcher with default behaviour and leaves the detached claude orphaned to launchd. The handler must call `killAllChildPgrps('SIGTERM')` then escalate to SIGKILL after the grace window.",
    );
  });

  test("SIGINT handler's `force-exit` case tears down child pgrps with SIGKILL escalation", () => {
    const body = sliceDeclaration(readDispatchSource(), "export function installSignalHandlers(");
    assert.ok(body, "could not locate `installSignalHandlers` body");
    const code = stripComments(body);
    // Find the force-exit case and walk to the next `case `/`}` boundary
    const forceExitStart = code.indexOf('case "force-exit"');
    assert.ok(forceExitStart >= 0, "could not locate the `case \"force-exit\":` branch in the SIGINT handler");
    const tail = code.slice(forceExitStart);
    const caseEnd = tail.search(/\n\s*case |\n\s*\}/);
    const caseBody = caseEnd >= 0 ? tail.slice(0, caseEnd) : tail;
    assert.match(
      caseBody,
      /killAllChildPgrps\(["']SIGTERM["']\)/,
      "force-exit must send SIGTERM to live child pgrps — otherwise the dispatcher dies and orphans claude.",
    );
    // SIGKILL escalation may be inline OR delegated to
    // `scheduleForceExit(...)`. Accept either — the SIGKILL contract
    // for the helper case is verified by the `scheduleForceExit`
    // tripwire below.
    const escalates = /killAllChildPgrps\(["']SIGKILL["']\)/.test(caseBody)
      || /scheduleForceExit\(/.test(caseBody);
    assert.ok(
      escalates,
      "force-exit must escalate to SIGKILL after the grace window — either inline as `killAllChildPgrps('SIGKILL')` or via `scheduleForceExit(...)`. Without escalation, children that ignore or hang on SIGTERM survive the dispatcher exit and orphan to launchd.",
    );
  });

  test("SIGHUP handler body tears down child pgrps with SIGKILL escalation", () => {
    const body = sliceDeclaration(readDispatchSource(), "export function installSignalHandlers(");
    assert.ok(body, "could not locate `installSignalHandlers` body");
    const code = stripComments(body);
    // Locate the SIGHUP `process.on(...)` registration, then slice
    // from there until the next `process.on(` (or end of installer)
    // so the assertion scopes to JUST the SIGHUP handler body — no
    // arbitrary character window that could miss content if the
    // handler grows.
    const sighupStart = code.search(/process\.on\(\s*["']SIGHUP["']/);
    assert.ok(sighupStart >= 0, "could not locate the SIGHUP handler");
    const tail = code.slice(sighupStart + 1);
    const nextHandlerIdx = tail.search(/process\.on\(/);
    const handlerSlice = nextHandlerIdx >= 0
      ? code.slice(sighupStart, sighupStart + 1 + nextHandlerIdx)
      : code.slice(sighupStart);
    // The SIGKILL escalation may be inline OR routed through a helper
    // (e.g. `scheduleForceExit(...)`). Accept either by checking for
    // SIGKILL appearing within the slice — if it's not here, it's not
    // reachable from the handler.
    assert.match(
      handlerSlice,
      /killAllChildPgrps\(["']SIGTERM["']\)/,
      "SIGHUP handler must send SIGTERM to live child pgrps before exit.",
    );
    // The SIGKILL stage may be inline or indirected through a helper
    // (e.g. `scheduleForceExit(129)`); accept either by checking that
    // the handler body either contains the literal `killAllChildPgrps('SIGKILL')`
    // or delegates to a `scheduleForceExit(`-shaped helper which is
    // itself asserted to use SIGKILL by the helper-body tripwire below.
    const escalates = /killAllChildPgrps\(["']SIGKILL["']\)/.test(handlerSlice)
      || /scheduleForceExit\(/.test(handlerSlice);
    assert.ok(
      escalates,
      "SIGHUP handler must escalate to SIGKILL after the grace window — either inline as `killAllChildPgrps('SIGKILL')` or via `scheduleForceExit(...)`. Without escalation, children that ignore or hang on SIGTERM orphan to launchd.",
    );
  });

  test("if `scheduleForceExit` helper exists, its body sends SIGKILL to live child pgrps before exit", () => {
    // Conditional tripwire: only fires if the helper is defined. The
    // SIGHUP / force-exit handlers may delegate SIGKILL escalation to
    // this helper; if so, the SIGKILL contract lives here.
    const helperBody = sliceDeclaration(readDispatchSource(), "function scheduleForceExit(");
    if (!helperBody) return; // helper not present; SIGHUP/force-exit must inline SIGKILL (asserted in the test above)
    const code = stripComments(helperBody);
    assert.match(
      code,
      /killAllChildPgrps\(["']SIGKILL["']\)/,
      "`scheduleForceExit` must call `killAllChildPgrps('SIGKILL')` — it's the SIGKILL escalation stage that SIGHUP / force-exit delegate to.",
    );
    assert.match(
      code,
      /process\.exit\(/,
      "`scheduleForceExit` must terminate the dispatcher via `process.exit(...)` after the SIGKILL escalation.",
    );
  });

  test("module-level scope of `dispatch.ts` does NOT register `process.on(SIGINT|SIGHUP|SIGTERM)` — handlers must live in `installSignalHandlers` so test imports don't inherit them", () => {
    const source = readDispatchSource();
    // Find every `process.on("SIGINT" | "SIGHUP" | "SIGTERM"` callsite
    // in CODE (not in comments — the docstring on `installSignalHandlers`
    // itself mentions these handler names as illustrative text). For the
    // index-based scope check we replace comments with same-length
    // whitespace runs so subsequent indices still align with the original
    // `source`.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
    const installerStart = codeOnly.indexOf("export function installSignalHandlers(");
    assert.ok(installerStart >= 0, "could not locate `installSignalHandlers` declaration");
    // installer body extends until the next top-level construct
    const tail = codeOnly.slice(installerStart + 1);
    const boundary = tail.search(/\n(?:export\s+)?(?:function |const |let |var |class |process\.on\()/);
    const installerEnd = boundary >= 0 ? installerStart + 1 + boundary : codeOnly.length;

    // Match every flavour of Node listener registration — `.on`,
    // `.once`, and `.addListener` are all valid APIs that bind a
    // callback to a signal. Without all three, a future refactor that
    // switched to `process.addListener` (copy-pasted from Node docs)
    // would slip past the scope check.
    const handlerPattern = /process\.(?:on|once|addListener)\(\s*["'](SIGINT|SIGHUP|SIGTERM)["']/g;
    const occurrences = [...codeOnly.matchAll(handlerPattern)];
    assert.ok(occurrences.length >= 3, `expected at least 3 process.(on|once|addListener)(SIG*) registrations in code, found ${occurrences.length}`);
    for (const m of occurrences) {
      const idx = m.index ?? -1;
      assert.ok(
        idx >= installerStart && idx < installerEnd,
        `found \`process.on("${m[1]}", ...)\` outside \`installSignalHandlers\` at index ${idx} (installer range: [${installerStart}, ${installerEnd})) — handlers must be registered only via \`installSignalHandlers\` (called from dispatch-bin.ts) so module imports (tests, sibling modules) don't inherit handlers that would \`process.exit\` the importer on signal delivery.`,
      );
    }
  });

  test("intentional teardown sites in `runClaudeStreamingOnce` do not use bare `child.kill(` (comments stripped before matching)", () => {
    const body = sliceDeclaration(readDispatchSource(), "function runClaudeStreamingOnce(");
    assert.ok(body, "could not locate `function runClaudeStreamingOnce(` in dispatch.ts");
    const code = stripComments(body);
    assert.doesNotMatch(
      code,
      /\bchild\.kill\(/,
      "intentional teardown sites in `runClaudeStreamingOnce` must use `killChildPgrp(child, sig)` (pgrp-kill) instead of bare `child.kill`. The latter reaches only `pyry agent-run` and orphans the grandchild — see the comment block above the function for the contract.",
    );
  });
});

describe("maybeCurateMemory (cooldown-gated inline auto-curation)", () => {
  const WATERMARK = 13_000;
  const COOLDOWN = 30 * 60_000;
  const T0 = 1_000_000_000; // arbitrary base ms; Date.now is avoided in tests

  // A curateMemoryIndex fake that records its calls and returns a scripted result.
  const makeCurator = (ok = true) => {
    const calls: Array<{ agentsRepoRoot: string }> = [];
    const deps: Pick<DispatchDeps, "curateMemoryIndex"> = {
      curateMemoryIndex: async (opts) => {
        calls.push(opts);
        return { ok };
      },
    };
    return { deps, calls };
  };

  const base = {
    autocurate: true,
    watermark: WATERMARK,
    cooldownMs: COOLDOWN,
    agentsRepoRoot: "/x/pyrycode-agents",
  };

  test("does nothing when auto-curation is off (fork-safety default)", async () => {
    const { deps, calls } = makeCurator();
    const next = await maybeCurateMemory({ ...base, autocurate: false, lessonFloorBytes: 20_000, nowMs: T0, lastAttemptMs: 0, deps });
    assert.equal(next, 0, "last-attempt unchanged");
    assert.equal(calls.length, 0, "curator never called when off");
  });

  test("does not fire below the watermark", async () => {
    const { deps, calls } = makeCurator();
    const next = await maybeCurateMemory({ ...base, lessonFloorBytes: WATERMARK - 1, nowMs: T0, lastAttemptMs: 0, deps });
    assert.equal(next, 0);
    assert.equal(calls.length, 0);
  });

  test("fires at/over the watermark once the cooldown has elapsed, records the attempt time", async () => {
    const { deps, calls } = makeCurator();
    const next = await maybeCurateMemory({ ...base, lessonFloorBytes: WATERMARK, nowMs: T0, lastAttemptMs: 0, deps });
    assert.equal(calls.length, 1, "curator invoked exactly once");
    assert.equal(calls[0].agentsRepoRoot, "/x/pyrycode-agents", "curates this fork");
    assert.equal(next, T0, "records nowMs as the last attempt");
  });

  test("does not re-fire inside the cooldown window", async () => {
    const { deps, calls } = makeCurator();
    const next = await maybeCurateMemory({ ...base, lessonFloorBytes: 20_000, nowMs: T0 + COOLDOWN - 1, lastAttemptMs: T0, deps });
    assert.equal(calls.length, 0, "cooldown suppresses the retry");
    assert.equal(next, T0, "last-attempt unchanged while cooling down");
  });

  test("fires again once the cooldown elapses even if the floor is still high", async () => {
    const { deps, calls } = makeCurator();
    const next = await maybeCurateMemory({ ...base, lessonFloorBytes: 20_000, nowMs: T0 + COOLDOWN, lastAttemptMs: T0, deps });
    assert.equal(calls.length, 1, "retries after the cooldown");
    assert.equal(next, T0 + COOLDOWN);
  });

  test("a failed (rolled-back) pass records the attempt and does NOT stick — it retries after the cooldown", async () => {
    // Regression for the 2026-07-21 bug: a failed curation left the floor high
    // and a sticky armed flag never re-armed, disabling curation forever. Here
    // the floor stays high after a failure, yet the next cooldown boundary fires.
    const { deps, calls } = makeCurator(false);
    const afterFail = await maybeCurateMemory({ ...base, lessonFloorBytes: 20_000, nowMs: T0, lastAttemptMs: 0, deps });
    assert.equal(calls.length, 1, "attempted once");
    assert.equal(afterFail, T0, "records the attempt despite the failure");
    const during = await maybeCurateMemory({ ...base, lessonFloorBytes: 20_000, nowMs: T0 + 60_000, lastAttemptMs: afterFail, deps });
    assert.equal(calls.length, 1, "no retry inside the cooldown");
    const after = await maybeCurateMemory({ ...base, lessonFloorBytes: 20_000, nowMs: T0 + COOLDOWN, lastAttemptMs: during, deps });
    assert.equal(calls.length, 2, "retries after the cooldown — never stuck");
    assert.equal(after, T0 + COOLDOWN);
  });
});

// ==========================================================================
// Dispatcher-executed real-claude gate — the runner
//
// The process half: git plumbing, worktree creation, and the spawn
// environment. Everything here goes through injected deps, so no test
// runs a shell, a suite, or a child process.
// ==========================================================================

/** Records every git call and lets a test make a chosen one fail. */
function makeGateDeps(over: Partial<GateRunnerDeps> & {
  gitFail?: (cmd: string) => boolean;
  gitOut?: (cmd: string) => string;
  probeStatus?: number;
  fileContents?: string | null;
  spawnOutcome?: Partial<GateSpawnOutcome>;
} = {}) {
  const calls: string[] = [];
  const spawnRequests: GateSpawnRequest[] = [];

  const deps: Partial<GateRunnerDeps> = {
    execSync: ((cmd: string) => {
      calls.push(cmd);
      if (over.gitFail?.(cmd)) throw new Error(`boom: ${cmd}`);
      return Buffer.from(over.gitOut?.(cmd) ?? "");
    }) as any,
    spawnSync: (() => ({ status: over.probeStatus ?? 0, stdout: "", stderr: "" })) as any,
    mkdirSync: (() => undefined) as any,
    readFileSync: ((path: string) => {
      if (over.fileContents === null) throw new Error("ENOENT");
      return over.fileContents ?? '{"Action":"pass","Package":"p","Test":"TestA"}';
    }) as any,
    statSync: (() => ({ size: 42 })) as any,
    now: () => 0,
    spawnGate: async (req: GateSpawnRequest) => {
      spawnRequests.push(req);
      return { exitCode: 0, timedOut: false, spawnError: null, ...over.spawnOutcome };
    },
    ...over,
  };

  return { deps, calls, spawnRequests };
}

const GATE_BASE_SHA = "b".repeat(40);
const GATE_HEAD_SHA = "h".repeat(40);
const GATE_SHAS: Record<string, string> = {
  "git rev-parse origin/main": GATE_BASE_SHA,
  "git rev-parse origin/feature/1382": GATE_HEAD_SHA,
  [`git rev-list --count ${GATE_HEAD_SHA}..${GATE_BASE_SHA}`]: "29",
};

function gateRun(over: Parameters<typeof makeGateDeps>[0] = {}) {
  const harness = makeGateDeps({ gitOut: (cmd) => GATE_SHAS[cmd] ?? "", ...over });
  return {
    ...harness,
    run: () => runRealClaudeGateSuite({
      issueNumber: 1382,
      command: "go test -json ./...",
      format: "go-json",
      timeoutMs: 60_000,
      repoRoot: "/tmp/fake-repo",
      defaultBranch: "main",
      logsDir: "/tmp/fake-logs",
      deps: harness.deps,
    }),
  };
}

describe("runRealClaudeGateSuite — worktree safety", () => {
  test("creates the worktree DETACHED", async () => {
    // Load-bearing twice over. Checking the branch out and merging main into
    // it would leave a merge commit on the local branch that origin lacks;
    // the next dispatch of that ticket would then hit
    // `abort-local-strictly-ahead` and park, telling the operator to push
    // commits that must never be pushed. The gate would poison every ticket
    // it passed. A detached worktree also holds no branch, so it can never
    // collide with a live dispatch worktree.
    const { run, calls } = gateRun();
    await run();

    const add = calls.find(c => c.includes("worktree add"));
    assert.ok(add, "expected a worktree to be created");
    assert.match(add!, /worktree add --detach/);
    assert.ok(!add!.includes("feature/1382"), "must check out the SHA, never the branch");
  });

  test("removes the worktree even when the run fails", async () => {
    const { run, calls } = gateRun({ spawnOutcome: { exitCode: 1, spawnError: "died" } });
    await run();

    const removes = calls.filter(c => c.includes("worktree remove"));
    assert.ok(removes.length >= 2, "expected a pre-run cleanup and a post-run removal");
  });

  test("removes the worktree when the merge conflicts, and reports it", async () => {
    const { run, calls } = gateRun({ gitFail: (c) => c.startsWith("git merge ") });
    const report = await run();

    assert.match(report.runError ?? "", /could not merge/);
    assert.ok(calls.some(c => c.includes("merge --abort")));
    assert.ok(calls.some(c => c.includes("worktree remove")));
  });

  test("moves a leftover worktree that removal refuses aside before creating its own (agent-dispatcher#79)", async () => {
    // A killed run leaves untracked captures, so plain `git worktree remove`
    // refuses the path. The retry must keep that evidence AND still start.
    let removes = 0;
    const { run, calls } = gateRun({
      gitFail: (c) => c.includes("worktree remove") && removes++ === 0,
    });
    const report = await run();

    assert.equal(report.runError, null);
    const moveIdx = calls.findIndex(c => c.includes("git worktree move"));
    const addIdx = calls.findIndex(c => c.includes("git worktree add"));
    assert.ok(moveIdx >= 0, "expected the leftover to be moved aside");
    assert.ok(moveIdx < addIdx, "the move must precede `git worktree add`");
    assert.match(calls[moveIdx], /real-claude-gate-1382" ".*\/stale-real-claude-gate-1382-\S+"$/);
    assert.ok(!calls.some(c => c.includes("--force")), "nothing may be force-removed");
  });

  test("moves nothing when the path clears normally", async () => {
    const { run, calls } = gateRun();
    await run();
    assert.ok(!calls.some(c => c.includes("git worktree move")));
  });

  test("keeps a finished run's worktree at its path when post-run removal refuses it", async () => {
    // Pre-run clear succeeds; the post-run removal is refused because the run
    // wrote captures. Those stay put for the implementation role.
    let removes = 0;
    const { run, calls } = gateRun({
      gitFail: (c) => c.includes("worktree remove") && removes++ > 0,
    });
    await run();
    assert.ok(!calls.some(c => c.includes("git worktree move")));
  });

  test("uses a worktree path that cannot collide with a dispatch worktree", async () => {
    // Dispatch worktrees are `<agent>-<issue>`; no agent is called
    // `real-claude-gate`.
    const { run, calls } = gateRun();
    await run();
    assert.match(calls.find(c => c.includes("worktree add"))!, /real-claude-gate-1382/);
  });
});

describe("runRealClaudeGateSuite — evidence gathering", () => {
  test("records how many commits behind the base the branch was", async () => {
    const report = await gateRun().run();
    assert.equal(report.commitsBehind, 29);
    assert.equal(report.baseRef, "origin/main");
    assert.equal(report.headSha, "h".repeat(40));
  });

  test("an uncomputable commits-behind does not fail the run", async () => {
    // Evidence-only. Losing it is worth a null in the comment, not a park.
    const report = await gateRun({ gitFail: (c) => c.startsWith("git rev-list") }).run();
    assert.equal(report.commitsBehind, null);
    assert.equal(report.runError, null);
  });

  test("judges the bytes read back FROM DISK", async () => {
    // Not an in-memory buffer: the judged bytes and the archived bytes have
    // to be provably the same bytes.
    const report = await gateRun({
      fileContents: [
        '{"Action":"pass","Package":"p","Test":"TestA"}',
        '{"Action":"skip","Package":"p","Test":"TestB"}',
      ].join("\n"),
    }).run();

    assert.equal(report.tally?.executed, 1);
    assert.equal(report.tally?.skipped, 1);
    assert.equal(report.outputBytes, 42);
  });

  test("a missing output file leaves a null tally, never an empty pass", async () => {
    const report = await gateRun({ fileContents: null }).run();
    assert.equal(report.tally, null);
    assert.equal(report.exitCode, 0, "the process exited fine; there is just nothing to judge");
  });

  test("names both log files with a .log suffix so rotation sweeps them", async () => {
    const { run, spawnRequests } = gateRun();
    const report = await run();
    assert.match(spawnRequests[0].stdoutPath, /\.log$/);
    assert.match(spawnRequests[0].stderrPath, /\.log$/);
    assert.notEqual(spawnRequests[0].stdoutPath, spawnRequests[0].stderrPath);
    assert.equal(report.stderrPath, spawnRequests[0].stderrPath);
  });
});

describe("runRealClaudeGateSuite — per-ticket selection", () => {
  const LAST_FULL = "f".repeat(40);
  const body = "## Summary\nx\n\n## Live tests\n- p.TestRename\n";

  function selectionRun(over: {
    prBody?: string;
    changed?: string;
    lastFull?: string | null;
    merges?: string;
    fileContents?: string;
    selection?: Parameters<typeof runRealClaudeGateSuite>[0]["selection"];
  } = {}) {
    const writes: string[] = [];
    const out: Record<string, string> = {
      ...GATE_SHAS,
      [`git diff --name-only ${GATE_BASE_SHA}...${GATE_HEAD_SHA}`]: over.changed ?? "ui/Settings.kt\n",
      [`git rev-list --count --merges ${LAST_FULL}..${GATE_BASE_SHA}`]: over.merges ?? "2",
    };
    const harness = makeGateDeps({
      gitOut: (cmd: string) => cmd.startsWith("gh pr list") ? (over.prBody ?? body) : (out[cmd] ?? ""),
      fileContents: over.fileContents,
      readGateFullState: () => over.lastFull === null ? null : JSON.stringify({ lastFullPassSha: over.lastFull ?? LAST_FULL }),
      writeGateFullState: (json: string) => { writes.push(json); },
    } as any);
    return {
      ...harness,
      writes,
      run: () => runRealClaudeGateSuite({
        issueNumber: 1382,
        command: "go test -json ./...",
        baselineCommand: "go test -json -run {{TESTS}} ./...",
        format: "go-json",
        timeoutMs: 60_000,
        selection: over.selection === undefined
          ? { alwaysTests: ["p.TestPing"], fullPaths: ["net/"], fullEvery: 10 }
          : over.selection,
        minExecuted: 1,
        repoRoot: "/tmp/fake-repo",
        defaultBranch: "main",
        logsDir: "/tmp/fake-logs",
        deps: harness.deps,
      }),
    };
  }

  test("runs the named tests and the always-run set through the baseline template", async () => {
    const { run, spawnRequests, writes } = selectionRun();
    const report = await run();

    assert.equal(report.selection?.mode, "selected");
    assert.match(spawnRequests[0].command, /-run '\^\(TestPing\|TestRename\)\$'/);
    assert.equal(report.command, spawnRequests[0].command, "the evidence shows the command that actually ran");
    assert.deepEqual(writes, [], "a selected run never resets the backstop");
  });

  test("a branch touching a full path runs the full command", async () => {
    const { run, spawnRequests } = selectionRun({ changed: "net/Relay.kt\n" });
    const report = await run();
    assert.equal(report.selection?.mode, "full");
    assert.equal(spawnRequests[0].command, "go test -json ./...");
  });

  test("with no full pass on record, runs the full command and records it when it is clean", async () => {
    const { run, spawnRequests, writes } = selectionRun({ lastFull: null });
    await run();
    assert.equal(spawnRequests[0].command, "go test -json ./...");
    assert.deepEqual(writes, [JSON.stringify({ lastFullPassSha: GATE_BASE_SHA })]);
  });

  test("a red full run leaves the backstop where it was", async () => {
    const { run, writes } = selectionRun({
      lastFull: null,
      fileContents: '{"Action":"fail","Package":"p","Test":"TestA"}',
    });
    await run();
    assert.deepEqual(writes, []);
  });

  test("a pull request with no list runs the full command", async () => {
    const { run, spawnRequests } = selectionRun({ prBody: "## Summary\nx" });
    const report = await run();
    assert.equal(report.selection?.mode, "full");
    assert.match(report.selection?.reason ?? "", /no `## Live tests` list/);
    assert.equal(spawnRequests[0].command, "go test -json ./...");
  });

  test("selection off reads no pull request and records nothing", async () => {
    const { run, calls, writes } = selectionRun({ selection: null, lastFull: null });
    const report = await run();
    assert.equal(report.selection, undefined);
    assert.ok(!calls.some(c => c.startsWith("gh pr list")));
    assert.deepEqual(writes, []);
  });
});

describe("runRealClaudeGateSuite — same-tree re-run before the base comparison", () => {
  // pyrycode #2089, 2026-09-06: a flaky liveness test failed once on the
  // branch and passed on the base, so the base comparison called it a
  // regression and the rework breaker tripped on a finished ticket. The
  // failing names are now re-run on the same merged tree first.
  const branchRun = [
    '{"Action":"run","Package":"p","Test":"TestFlaky"}',
    '{"Action":"fail","Package":"p","Test":"TestFlaky"}',
    '{"Action":"pass","Package":"p","Test":"TestSolid"}',
    '{"Action":"fail","Package":"p"}',
  ].join("\n");
  const rerunGreen = '{"Action":"pass","Package":"p","Test":"TestFlaky"}';
  const rerunRed = '{"Action":"fail","Package":"p","Test":"TestFlaky"}';

  function rerunHarness(byPath: (path: string) => string) {
    const harness = makeGateDeps({
      gitOut: (cmd) => GATE_SHAS[cmd] ?? "",
      spawnOutcome: { exitCode: 1 },
      readFileSync: ((path: string) => byPath(path)) as any,
    });
    return {
      ...harness,
      run: () => runRealClaudeGateSuite({
        issueNumber: 1382,
        command: "go test -json ./...",
        baselineCommand: "go test -json -run {{TESTS}} ./...",
        format: "go-json",
        timeoutMs: 60_000,
        repoRoot: "/tmp/fake-repo",
        defaultBranch: "main",
        logsDir: "/tmp/fake-logs",
        deps: harness.deps,
      }),
    };
  }
  const contents = (rerun: string, base: string = rerunGreen) => (path: string) =>
    path.includes("-rerun_") ? rerun : path.includes("-base_") ? base : branchRun;

  test("a failure that passes on re-run is recorded as flaky and never reaches the base", async () => {
    const { run, spawnRequests } = rerunHarness(contents(rerunGreen));
    const report = await run();

    assert.deepEqual(report.rerunFailures, []);
    assert.equal(report.rerunSkipReason, null);
    assert.equal(spawnRequests.length, 2, "the main run and the re-run; no base run");
    assert.equal(spawnRequests[1].cwd, spawnRequests[0].cwd, "the re-run uses the SAME merged worktree");
    assert.match(spawnRequests[1].command, /-run '\^\(TestFlaky\)\$'/);
    assert.equal(report.baselineFailures, null);
    assert.match(report.baselineSkipReason ?? "", /passed on the same-tree re-run/);
  });

  test("a failure that fails again is compared against the base as before", async () => {
    const { run, spawnRequests } = rerunHarness(contents(rerunRed, rerunGreen));
    const report = await run();

    assert.deepEqual(report.rerunFailures, ["p.TestFlaky"]);
    assert.equal(spawnRequests.length, 3, "main run, re-run, then the base run");
    assert.ok(spawnRequests[2].cwd.includes("real-claude-gate-base-1382"));
    assert.deepEqual(report.baselineFailures, []);
  });

  test("a re-run that skipped the test excuses nothing", async () => {
    // The same false green the gate exists to reject, one layer down.
    const skipped = '{"Action":"skip","Package":"p","Test":"TestFlaky"}';
    const { run } = rerunHarness(contents(skipped, rerunRed));
    const report = await run();

    assert.equal(report.rerunFailures, null);
    assert.match(report.rerunSkipReason ?? "", /executed nothing/);
    assert.deepEqual(report.baselineFailures, ["p.TestFlaky"], "the base comparison still runs over the full set");
  });

  test("a hang killed by the test binary's own timeout is neither re-tried nor compared", async () => {
    // Re-trying a hang costs the whole timeout again. And a base comparison
    // cannot attribute it either: the killed test re-run alone has the whole
    // budget and always passes, which is how pyrycode #2279 was sent to
    // rework over a test its diff never touched (2026-09-09). The verdict is
    // a budget exhaustion, decided from the tally alone, so neither leg runs.
    const hung = [
      '{"Action":"run","Package":"p","Test":"TestHang"}',
      '{"Action":"output","Package":"p","Test":"TestHang","Output":"panic: test timed out after 20m0s\\n"}',
      '{"Action":"output","Package":"p","Test":"TestHang","Output":"\\trunning tests:\\n"}',
      '{"Action":"output","Package":"p","Test":"TestHang","Output":"\\t\\tTestHang (2m59s)\\n"}',
      '{"Action":"output","Package":"p","Test":"TestHang","Output":"\\n"}',
      '{"Action":"fail","Package":"p"}',
    ].join("\n");
    const { run, spawnRequests } = rerunHarness(
      (path) => path.includes("-base_") ? '{"Action":"pass","Package":"p","Test":"TestHang"}' : hung,
    );
    const report = await run();

    assert.deepEqual(report.tally?.timedOutTests, ["p.TestHang"]);
    assert.equal(report.rerunFailures, null);
    assert.match(report.rerunSkipReason ?? "", /hang/);
    assert.equal(report.baselineFailures, null);
    assert.match(report.baselineSkipReason ?? "", /budget exhaustion/);
    assert.equal(spawnRequests.length, 1, "the main run only; no re-run and no base run");
  });
});

describe("runRealClaudeGateSuite — refusing to run", () => {
  test("reports a conflict from the merge-tree probe without touching the disk", async () => {
    // The probe stays in the object database, so it cannot contend with a
    // live dispatch. Preferred over the pull request's `mergeable` field,
    // which GitHub computes asynchronously and reports as unknown for a
    // window after each push.
    const { run, calls } = gateRun({ probeStatus: 1 });
    const report = await run();

    assert.match(report.runError ?? "", /conflicts with/);
    assert.ok(!calls.some(c => c.includes("worktree add")), "no worktree should be created");
  });

  test("an unsupported probe does not disable the gate", async () => {
    // Old git lacks `merge-tree --write-tree`. The merge itself would still
    // surface a real conflict, so a broken probe must not become a park.
    const { run, calls } = gateRun({ probeStatus: 129 });
    const report = await run();

    assert.equal(report.runError, null);
    assert.ok(calls.some(c => c.includes("worktree add")));
  });

  test("refuses to gate a branch that is not on origin", async () => {
    // The ticket has an open pull request. Gating a local-only branch would
    // attach a green verdict to code nobody is going to merge.
    const report = await gateRun({ gitFail: (c) => c === "git rev-parse origin/feature/1382" }).run();
    assert.match(report.runError ?? "", /pushed branch only/);
  });

  test("a failed fetch parks rather than running against stale refs", async () => {
    const report = await gateRun({ gitFail: (c) => c.startsWith("git fetch") }).run();
    assert.match(report.runError ?? "", /git fetch origin failed/);
  });

  test("never throws — every failure comes back as a report", async () => {
    // A throw would leave the ticket unlabelled in Inbox, so the next cycle
    // would try again and burn a full suite's wall clock every time.
    const report = await gateRun({ gitFail: () => true }).run();
    assert.ok(report.runError, "expected a runError, not an exception");
  });
});

describe("buildGateSpawnEnv", () => {
  test("keeps the Claude OAuth token", () => {
    // The credential the real-claude fixtures actually look for. The
    // 2026-07-22 belief that it is absent here was never measured and is
    // false: a full suite ran from this machine on 2026-08-07, 176 passed.
    const env = buildGateSpawnEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth-xyz", PATH: "/usr/bin" });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-oauth-xyz");
    assert.equal(env.PATH, "/usr/bin");
  });

  test("does NOT define the metered API key, even when the parent has one", () => {
    // Absent means the run bills against the subscription. Four
    // external-service tests skip as a consequence; that is the expected
    // cost of the billing choice, not a defect.
    const env = buildGateSpawnEnv({ ANTHROPIC_API_KEY: "sk-ant-metered", CLAUDE_CODE_OAUTH_TOKEN: "t" });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(!("ANTHROPIC_API_KEY" in env), "the key must be absent, not empty");
  });

  test("strips the dispatcher's GitHub token", () => {
    // A test process must not be able to reach the credential that drives
    // the board.
    const env = buildGateSpawnEnv({ GITHUB_TOKEN: "ghp_secret", CLAUDE_CODE_OAUTH_TOKEN: "t" });
    assert.equal(env.GITHUB_TOKEN, undefined);
  });

  test("the gate command receives that environment", async () => {
    const { run, spawnRequests } = gateRun();
    await run();
    assert.ok(!("GITHUB_TOKEN" in spawnRequests[0].env));
    assert.ok(!("ANTHROPIC_API_KEY" in spawnRequests[0].env));
  });
});

describe("spawnGateCommand — the real spawner", () => {
  // The seam exists so no other test needs a child process. These few do,
  // because the default spawner is the one piece the seam cannot cover, and
  // the bug it hides is invisible to any fake: a promise that never settles
  // does not fail, it lets Node's event loop drain and the process exit 0.

  const tmp = (name: string) => resolve(tmpdir(), `gate-spawn-test-${process.pid}-${name}`);

  test("resolves even when the output streams close before the child event", { timeout: 15_000 }, async () => {
    // The 2026-08-07 hang. A command that finishes instantly closes both
    // pipes in the same tick the child's own `close` fires. Listeners armed
    // after that point never hear it, the promise never settles, and the
    // dispatcher exits silently with the artifact written and no verdict.
    // Observed twice live against pyrycode#1382.
    //
    // A regression here does not throw, it never settles. The explicit
    // timeout is the assertion, and it must stay: without it the suite would
    // hang forever instead of reporting a failure.
    const stdoutPath = tmp("fast.log");
    const stderrPath = tmp("fast.err.log");

    const outcome = await spawnGateCommand({
      command: "echo done",
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 30_000,
      stdoutPath,
      stderrPath,
    });

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.spawnError, null);
  });

  test("the output file is complete by the time it returns", { timeout: 15_000 }, async () => {
    // The caller judges by reading this file back off disk. Returning before
    // the write stream flushed would let it read a partial artifact and call
    // a complete run truncated.
    const stdoutPath = tmp("complete.log");
    const stderrPath = tmp("complete.err.log");

    await spawnGateCommand({
      command: "for i in 1 2 3 4 5; do echo \"line $i\"; done",
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 30_000,
      stdoutPath,
      stderrPath,
    });

    assert.equal(readFileSync(stdoutPath, "utf-8").trim().split("\n").length, 5);
  });

  test("reports a non-zero exit rather than throwing", { timeout: 15_000 }, async () => {
    const outcome = await spawnGateCommand({
      command: "exit 7",
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 30_000,
      stdoutPath: tmp("fail.log"),
      stderrPath: tmp("fail.err.log"),
    });

    assert.equal(outcome.exitCode, 7);
    assert.equal(outcome.spawnError, null);
  });

  test("keeps stderr out of the judged artifact", { timeout: 15_000 }, async () => {
    // Merging them could split a JSON event in half. The parser tolerates
    // junk lines; it cannot reassemble a bisected one.
    const stdoutPath = tmp("split.log");
    const stderrPath = tmp("split.err.log");

    await spawnGateCommand({
      command: "echo to-stdout; echo to-stderr >&2",
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 30_000,
      stdoutPath,
      stderrPath,
    });

    assert.equal(readFileSync(stdoutPath, "utf-8").trim(), "to-stdout");
    assert.equal(readFileSync(stderrPath, "utf-8").trim(), "to-stderr");
  });

  test("a timeout tears the command down and reports it", { timeout: 15_000 }, async () => {
    const outcome = await spawnGateCommand({
      command: "sleep 30",
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 300,
      stdoutPath: tmp("timeout.log"),
      stderrPath: tmp("timeout.err.log"),
    });

    assert.equal(outcome.timedOut, true, "expected the outer wall clock to fire");
    assert.notEqual(outcome.exitCode, 0, "a killed command must not look successful");
  });
});

// =====================================================================
// runFamilyBreaker — the family circuit breaker's veto seam
// =====================================================================
//
// Sits between selectDispatches and runPreDispatchPrep, before any
// wip:<agent> is written or worktree created. Reads each candidate's
// family ROOT off the parent-chain snapshot fields, fetches the root's
// marker-comment tally (once per root per cycle), and drops candidates
// whose family is at/over PYRY_FAMILY_DISPATCH_LIMIT — parking the root
// with error:family-breaker and one deduped explanatory comment.

describe("runFamilyBreaker — veto seam", () => {
  const DEV = AGENTS.find(a => a.name === "developer")!;
  const child = (n: number, root: number) =>
    makeProjectItem({ issueNumber: n, parentNumber: root, url: `https://github.com/test/repo/issues/${n}` });

  test("a family under the threshold passes every candidate through untouched", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 23, breakerCommented: false });
    const candidates = [{ agent: DEV, item: child(41, 40) }];

    const out = await runFamilyBreaker(candidates, client, { threshold: 24 });

    assert.deepEqual(out.kept, candidates);
    assert.equal(out.tallies.get(40), 23);
    assert.equal(client.addLabelCalls.length, 0);
    assert.equal(client.comments.length, 0);
  });

  test("a family at the threshold drops the candidate and parks the ROOT, not the candidate", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 24, breakerCommented: false });
    const candidates = [{ agent: DEV, item: child(41, 40) }];

    const out = await runFamilyBreaker(candidates, client, { threshold: 24 });

    assert.deepEqual(out.kept, []);
    // The park switch lands on the family root #40, never on the child.
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 40, label: FAMILY_BREAKER_LABEL }]);
    assert.equal(client.comments.length, 1);
    assert.equal(client.comments[0].issueNumber, 40);
    assert.ok(client.comments[0].body.includes(FAMILY_BREAKER_COMMENT_MARKER), "trip comment carries the dedupe marker");
    assert.ok(client.comments[0].body.includes("24"), "trip comment carries the tally and threshold");
    assert.ok(client.comments[0].body.includes(FAMILY_BREAKER_LABEL), "trip comment tells the operator which label resumes the family");
  });

  test("a grandchild is vetoed through its grandparent root", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 30, breakerCommented: true });
    const grandchild = makeProjectItem({ issueNumber: 42, parentNumber: 41, grandparentNumber: 40 });

    const out = await runFamilyBreaker([{ agent: DEV, item: grandchild }], client, { threshold: 24 });

    assert.deepEqual(out.kept, []);
    assert.equal(client.getFamilyDispatchStateCalls[0], 40);
  });

  test("the trip comment posts once — a family that already explained itself is dropped quietly", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 30, breakerCommented: true });

    const out = await runFamilyBreaker([{ agent: DEV, item: child(41, 40) }], client, { threshold: 24 });

    assert.deepEqual(out.kept, []);
    assert.equal(client.comments.length, 0, "no second trip comment across cycles");
  });

  test("a root already wearing the breaker label is not relabelled", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 30, breakerCommented: true });

    const out = await runFamilyBreaker([{ agent: DEV, item: child(41, 40) }], client, {
      threshold: 24,
      rootLabelsByIssue: new Map([[40, [FAMILY_BREAKER_LABEL]]]),
    });

    assert.deepEqual(out.kept, []);
    assert.equal(client.addLabelCalls.length, 0, "label already present — no churn");
  });

  test("one tally fetch per family root per cycle serves every candidate of that family", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 30, breakerCommented: false });
    const candidates = [
      { agent: DEV, item: child(41, 40) },
      { agent: DEV, item: child(43, 40) },
    ];

    const out = await runFamilyBreaker(candidates, client, { threshold: 24 });

    assert.deepEqual(out.kept, []);
    assert.deepEqual(client.getFamilyDispatchStateCalls, [40], "one comments fetch for the shared root");
    assert.equal(client.addLabelCalls.length, 1, "park switch applied once");
    assert.equal(client.comments.length, 1, "trip comment posted once");
  });

  test("a tally fetch failure fails open — the candidate dispatches and the cycle survives", async () => {
    const client = new MockGitHubClient();
    client.failures.getFamilyDispatchState = new Error("comments API down");
    const candidates = [{ agent: DEV, item: child(41, 40) }];

    const out = await runFamilyBreaker(candidates, client, { threshold: 24 });

    assert.deepEqual(out.kept, candidates, "a missed veto costs one dispatch; a crashed cycle costs everything");
    assert.equal(client.addLabelCalls.length, 0);
    assert.equal(client.comments.length, 0);
  });

  test("when comments are unreadable the convenience label is the fallback and can still trip the breaker", async () => {
    const client = new MockGitHubClient();
    client.failures.getFamilyDispatchState = new Error("comments API down");

    const out = await runFamilyBreaker([{ agent: DEV, item: child(41, 40) }], client, {
      threshold: 24,
      rootLabelsByIssue: new Map([[40, ["family-dispatches:30"]]]),
    });

    assert.deepEqual(out.kept, []);
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 40, label: FAMILY_BREAKER_LABEL }]);
  });

  test("a convenience label lying high does not park a family whose comments say otherwise", async () => {
    // The disagreement case: comments are the source of truth.
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 3, breakerCommented: false });
    const candidates = [{ agent: DEV, item: child(41, 40) }];

    const out = await runFamilyBreaker(candidates, client, {
      threshold: 24,
      rootLabelsByIssue: new Map([[40, ["family-dispatches:50"]]]),
    });

    assert.deepEqual(out.kept, candidates);
    assert.equal(client.addLabelCalls.length, 0);
  });

  test("a ticket with no parent is its own family root and parks itself at the threshold", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(100, { markerCount: 24, breakerCommented: false });
    const item = makeProjectItem({ issueNumber: 100 });

    const out = await runFamilyBreaker([{ agent: DEV, item }], client, { threshold: 24 });

    assert.deepEqual(out.kept, []);
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 100, label: FAMILY_BREAKER_LABEL }]);
    assert.equal(client.comments[0].issueNumber, 100);
  });

  test("mixed candidates: only the tripped family is dropped, the healthy one dispatches", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 24, breakerCommented: false });
    client.familyStateByIssue.set(50, { markerCount: 2, breakerCommented: false });
    const healthy = { agent: DEV, item: child(51, 50) };

    const out = await runFamilyBreaker([{ agent: DEV, item: child(41, 40) }, healthy], client, { threshold: 24 });

    assert.deepEqual(out.kept, [healthy]);
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 40, label: FAMILY_BREAKER_LABEL }]);
  });

  test("a label-add failure on trip is swallowed — the candidate still drops and the cycle survives", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 24, breakerCommented: false });
    client.failures.addLabel = new Error("label write failed");
    client.failures.addComment = new Error("comment write failed");

    const out = await runFamilyBreaker([{ agent: DEV, item: child(41, 40) }], client, { threshold: 24 });

    assert.deepEqual(out.kept, [], "the veto holds even when the park bookkeeping fails");
  });
});

// =====================================================================
// runPreDispatchPrep — family dispatch accounting
// =====================================================================
//
// Every dispatch of any family member increments ONE counter on the
// family ROOT: a marker comment (the durable tally) plus a rewritten
// family-dispatches:N convenience label. Failures are logged and
// skipped — a missed increment is acceptable, a crashed cycle is not.

describe("runPreDispatchPrep — family dispatch accounting", () => {
  const DEV = AGENTS.find(a => a.name === "developer")!;

  test("each dispatch posts one marker comment on the family ROOT naming the agent and the ticket", async () => {
    const client = new MockGitHubClient();
    const item = makeProjectItem({ issueNumber: 41, parentNumber: 40 });

    await runPreDispatchPrep([{ agent: DEV, item }], client, { tallies: new Map([[40, 5]]) });

    const markers = client.comments.filter(c => c.body.includes(FAMILY_DISPATCH_COMMENT_MARKER));
    assert.equal(markers.length, 1);
    assert.equal(markers[0].issueNumber, 40, "the marker lands on the root, not the dispatched child");
    assert.ok(markers[0].body.includes("developer"), "human-readable agent name");
    assert.ok(markers[0].body.includes("#41"), "human-readable ticket number");
    // Convenience label rewritten from the tally: 5 → 6.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 40 && c.label === "family-dispatches:6"));
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 40 && c.label === "family-dispatches:5"));
  });

  test("stale convenience counters on the root are swept when the label is rewritten", async () => {
    const client = new MockGitHubClient();
    const item = makeProjectItem({ issueNumber: 41, parentNumber: 40 });

    await runPreDispatchPrep([{ agent: DEV, item }], client, {
      tallies: new Map([[40, 12]]),
      rootLabelsByIssue: new Map([[40, ["family-dispatches:3", "family-dispatches:9", "size:m"]]]),
    });

    const removed = client.removeLabelCalls.filter(c => c.issueNumber === 40).map(c => c.label);
    assert.ok(removed.includes("family-dispatches:3"));
    assert.ok(removed.includes("family-dispatches:9"));
    assert.ok(!removed.includes("size:m"), "non-counter labels are untouched");
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 40 && c.label === "family-dispatches:13"));
  });

  test("a marker posting failure is logged and skipped — the dispatch proceeds, the label is not bumped", async () => {
    const client = new MockGitHubClient();
    client.failures.addComment = new Error("comments API down");
    const item = makeProjectItem({ issueNumber: 41, parentNumber: 40 });

    // Must not throw: a missed increment is acceptable, a crashed cycle is not.
    await runPreDispatchPrep([{ agent: DEV, item }], client, { tallies: new Map([[40, 5]]) });

    assert.ok(client.addLabelCalls.some(c => c.label === "wip:developer"), "prep's own work still happens");
    assert.ok(
      !client.addLabelCalls.some(c => c.label.startsWith("family-dispatches:")),
      "the label mirrors the comment tally; no comment, no bump",
    );
  });

  test("two same-family candidates in one cycle number the tally sequentially", async () => {
    const client = new MockGitHubClient();
    const tallies = new Map([[40, 5]]);
    const candidates = [
      { agent: DEV, item: makeProjectItem({ issueNumber: 41, parentNumber: 40 }) },
      { agent: DEV, item: makeProjectItem({ issueNumber: 43, parentNumber: 40 }) },
    ];

    await runPreDispatchPrep(candidates, client, { tallies });

    const markers = client.comments.filter(c => c.issueNumber === 40 && c.body.includes(FAMILY_DISPATCH_COMMENT_MARKER));
    assert.equal(markers.length, 2, "one marker per dispatch");
    const added = client.addLabelCalls.filter(c => c.label.startsWith("family-dispatches:")).map(c => c.label);
    assert.deepEqual(added, ["family-dispatches:6", "family-dispatches:7"]);
    assert.equal(tallies.get(40), 7, "the shared tally advances for later steps in the cycle");
  });

  test("a candidate that is its own root posts the marker on itself and starts the counter at 1", async () => {
    const client = new MockGitHubClient();
    const item = makeProjectItem({ issueNumber: 100 });

    await runPreDispatchPrep([{ agent: DEV, item }], client, { tallies: new Map() });

    const markers = client.comments.filter(c => c.body.includes(FAMILY_DISPATCH_COMMENT_MARKER));
    assert.equal(markers.length, 1);
    assert.equal(markers[0].issueNumber, 100);
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 100 && c.label === "family-dispatches:1"));
    assert.ok(
      !client.removeLabelCalls.some(c => c.label === "family-dispatches:0"),
      "no pointless remove of a zero counter that never exists",
    );
  });

  test("without family opts, prep behaves exactly as before — no markers, no counter labels", async () => {
    const client = new MockGitHubClient();
    const item = makeProjectItem({ issueNumber: 41, parentNumber: 40 });

    await runPreDispatchPrep([{ agent: DEV, item }], client);

    assert.equal(client.comments.length, 0);
    assert.ok(!client.addLabelCalls.some(c => c.label.startsWith("family-dispatches:")));
    assert.ok(client.addLabelCalls.some(c => c.label === "wip:developer"));
  });
});

// =====================================================================
// runFamilyBreaker — per-family reset and resume
// =====================================================================

describe("runFamilyBreaker — per-family reset", () => {
  const DEV = AGENTS.find(a => a.name === "developer")!;
  const child = (n: number, root: number) =>
    makeProjectItem({ issueNumber: n, parentNumber: root });

  test("the trip comment instructs the two-step resume: reset comment first, then the label — env knob only as global fallback", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 24, breakerCommented: false });

    await runFamilyBreaker([{ agent: DEV, item: child(41, 40) }], client, { threshold: 24 });

    assert.equal(client.comments.length, 1);
    const body = client.comments[0].body;
    assert.ok(body.includes(FAMILY_DISPATCH_RESET_MARKER), "operator must be shown the exact reset marker to post");
    assert.ok(body.includes(FAMILY_BREAKER_LABEL), "operator must be told which label to remove");
    assert.ok(body.includes("PYRY_FAMILY_DISPATCH_LIMIT"), "env knob stays documented as the global fallback");
  });

  test("a reset comment zeroes the family tally so the freed family dispatches again", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 24, breakerCommented: false });
    // Operator posted the reset marker on the root.
    await client.addComment(40, `${FAMILY_DISPATCH_RESET_MARKER} resuming after fixing the split loop`);
    const candidates = [{ agent: DEV, item: child(41, 40) }];

    const out = await runFamilyBreaker(candidates, client, { threshold: 24 });

    assert.deepEqual(out.kept, candidates, "post-reset the tally is 0 — the family flows");
    assert.equal(out.tallies.get(40), 0, "prep numbering restarts from the reset");
    assert.ok(!client.addLabelCalls.some(c => c.label === FAMILY_BREAKER_LABEL), "no re-park after a reset");
  });

  test("trip, reset, resume, second runaway: the breaker trips again and posts a FRESH explanation", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 24, breakerCommented: false });
    const candidates = [{ agent: DEV, item: child(41, 40) }];

    // Cycle 1: the family trips and explains itself.
    const first = await runFamilyBreaker(candidates, client, { threshold: 24 });
    assert.deepEqual(first.kept, []);
    assert.equal(client.comments.filter(c => c.body.includes(FAMILY_BREAKER_COMMENT_MARKER)).length, 1);

    // Operator resumes: reset comment, then removes the label (the label
    // never reached rootLabelsByIssue here, so nothing else to clear).
    await client.addComment(40, `${FAMILY_DISPATCH_RESET_MARKER} resuming`);

    // Cycle 2: family flows again.
    const second = await runFamilyBreaker(candidates, client, { threshold: 24 });
    assert.deepEqual(second.kept, candidates);

    // The resumed family runs away again: 24 fresh dispatch markers.
    for (let i = 1; i <= 24; i++) {
      await client.addComment(40, `${FAMILY_DISPATCH_COMMENT_MARKER}\n🧮 Family dispatch ${i}`);
    }

    // Cycle 3: trips again AND explains again — the pre-reset trip comment
    // must not suppress the fresh explanation.
    const third = await runFamilyBreaker(candidates, client, { threshold: 24 });
    assert.deepEqual(third.kept, []);
    assert.equal(
      client.comments.filter(c => c.body.includes(FAMILY_BREAKER_COMMENT_MARKER)).length,
      2,
      "a second runaway after a reset gets its own trip comment",
    );
  });

  test("the trip comment's own reset-marker mention does not reset the tally it just tripped on", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(40, { markerCount: 24, breakerCommented: false });
    const candidates = [{ agent: DEV, item: child(41, 40) }];

    // Trip posts the explanation (whose body quotes the reset marker).
    await runFamilyBreaker(candidates, client, { threshold: 24 });
    // Next cycle: the tally must still be 24, the family still vetoed.
    const out = await runFamilyBreaker(candidates, client, { threshold: 24 });

    assert.deepEqual(out.kept, [], "a trip comment must never count as a reset");
    assert.equal(out.tallies.get(40), 24);
  });
});

// =====================================================================
// maybeResumeExhaustedRun — same-dispatch resume-in-place
// =====================================================================
//
// A budget-exhausted run (max_turns or wall-clock timeout) gets up to
// PYRY_RESUME_LEGS continuation legs of the SAME claude session — same
// dispatch, same worktree, fresh budget — before the salvage paths run.
// Success merges the legs and takes the normal success path; a still-
// exhausted (or errored) final leg falls through to salvage with the
// ORIGINAL first-leg result, so salvage behaves byte-identically to a
// world without the feature.

/** The dispatch-log sections a test captured, rendered as one searchable text. */
function loggedText(calls: CallLog): string {
  return calls.logs.map((l) => `${l.section}\n${l.content}`).join("\n");
}

/** Build the SpawnConfig a resume test hands to maybeResumeExhaustedRun. */
function makeSpawnConfig(
  logFile: string,
  overrides: Partial<Parameters<DispatchDeps["runClaudeStreaming"]>[0]> = {},
): Parameters<DispatchDeps["runClaudeStreaming"]>[0] {
  return {
    promptFile: resolve(TEST_AGENTS_REPO_ROOT, ".prompt-100.txt"),
    systemPromptFile: resolve(TEST_AGENTS_REPO_ROOT, ".system-prompt-developer.txt"),
    model: "opus",
    effort: "xhigh",
    maxTurns: 135,
    allowedTools: "Bash,Read,Write",
    disallowedTools: "AskUserQuestion,Skill",
    cwd: "/worktrees/developer-100",
    timeoutMs: 1_500_000,
    logFile,
    env: { CLAUDE_CODE_ENTRYPOINT: "developer" } as NodeJS.ProcessEnv,
    ...overrides,
  };
}

/** Run `fn` with PYRY_RESUME_LEGS set (or deleted for undefined), restoring after. */
async function withResumeLegs<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.PYRY_RESUME_LEGS;
  if (value === undefined) delete process.env.PYRY_RESUME_LEGS;
  else process.env.PYRY_RESUME_LEGS = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.PYRY_RESUME_LEGS;
    else process.env.PYRY_RESUME_LEGS = prior;
  }
}

const EXHAUSTED_MAX_TURNS = (): StreamResult => streamResult({
  isError: true,
  terminalReason: "max_turns",
  sessionId: "sess-first",
  numTurns: 135,
  totalCostUsd: 4.5,
  durationMs: 600_000,
  usage: { input_tokens: 1000, output_tokens: 2000 },
  output: "ran out of turns mid-task",
});

describe("maybeResumeExhaustedRun — same-dispatch continuation leg", () => {
  test("an exhausted max_turns run gets one continuation leg and the merged success takes over", async () => {
    await withResumeLegs(undefined, async () => {
      const seenConfigs: any[] = [];
      const { ctx, calls } = makeTestContext({
        mockOptions: {
          streamResult: (opts: any) => {
            seenConfigs.push(opts);
            return streamResult({
              isError: false,
              terminalReason: "stop",
              sessionId: "sess-first",
              numTurns: 40,
              totalCostUsd: 1.5,
              durationMs: 200_000,
              usage: { input_tokens: 300, output_tokens: 700 },
              output: "finished cleanly",
            });
          },
        },
      });
      const first = EXHAUSTED_MAX_TURNS();
      const config = makeSpawnConfig(ctx.logFile);

      const result = await maybeResumeExhaustedRun(first, config, ctx);

      // One continuation leg spawned, through the deps seam.
      assert.equal(calls.claudeStreams, 1);
      // The merged result is a success carrying cross-leg usage sums.
      assert.equal(result.isError, false);
      assert.equal(result.numTurns, 175);
      assert.equal(result.totalCostUsd, 6);
      assert.equal(result.durationMs, 800_000);
      assert.equal(result.usage.input_tokens, 1300);
      assert.equal(result.usage.output_tokens, 2700);
      assert.equal(result.sessionId, "sess-first");
      assert.equal(result.output, "finished cleanly");
    });
  });

  test("the continuation config re-passes every flag, keeps cwd/timeout, and swaps only the prompt", async () => {
    await withResumeLegs(undefined, async () => {
      const seenConfigs: any[] = [];
      const { ctx, calls } = makeTestContext({
        mockOptions: {
          streamResult: (opts: any) => {
            seenConfigs.push(opts);
            return streamResult({ isError: false, sessionId: "sess-first" });
          },
        },
      });
      const first = EXHAUSTED_MAX_TURNS();
      const config = makeSpawnConfig(ctx.logFile);

      await maybeResumeExhaustedRun(first, config, ctx);

      assert.equal(seenConfigs.length, 1);
      const resumeConfig = seenConfigs[0];
      // The session to resume — this is what forces the claude-binary
      // bridge inside the spawn helper.
      assert.equal(resumeConfig.resumeSessionId, "sess-first");
      // Flags do NOT carry over on --resume, so the config re-passes
      // them all unchanged.
      assert.equal(resumeConfig.model, config.model);
      assert.equal(resumeConfig.effort, config.effort);
      assert.equal(resumeConfig.maxTurns, config.maxTurns);
      assert.equal(resumeConfig.allowedTools, config.allowedTools);
      assert.equal(resumeConfig.disallowedTools, config.disallowedTools);
      assert.equal(resumeConfig.systemPromptFile, config.systemPromptFile);
      // Same worktree, same per-leg wall clock, same log, same env.
      assert.equal(resumeConfig.cwd, config.cwd);
      assert.equal(resumeConfig.timeoutMs, config.timeoutMs);
      assert.equal(resumeConfig.logFile, config.logFile);
      assert.deepEqual(resumeConfig.env, config.env);
      // Only the prompt swaps: a continuation prompt in its own file.
      assert.notEqual(resumeConfig.promptFile, config.promptFile);
      const promptWrite = calls.fs.find(
        (f) => f.kind === "write" && f.path === resumeConfig.promptFile,
      );
      assert.ok(promptWrite, "continuation prompt written before the leg");
      assert.match(promptWrite!.content!, /continuation of the same session/);
      assert.match(promptWrite!.content!, /turn budget/);
      assert.match(promptWrite!.content!, /without redoing completed work/);
    });
  });

  test("a RESUME section lands in the run log before the leg, naming leg number, session, and reason", async () => {
    await withResumeLegs(undefined, async () => {
      const { ctx, calls } = makeTestContext({
        item: { issueNumber: 951 },
        mockOptions: {
          streamResult: () => streamResult({ isError: false, sessionId: "sess-first" }),
        },
      });
      const first = EXHAUSTED_MAX_TURNS();

      await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile), ctx);

      const log = loggedText(calls);
      assert.match(log, /RESUME/);
      assert.match(log, /Leg: 1/);
      assert.match(log, /Session: sess-first/);
      assert.match(log, /Reason: max_turns/);
    });
  });

  test("a wall-clock timeout resumes too, logging reason: timeout and a wall-clock prompt", async () => {
    await withResumeLegs(undefined, async () => {
      const { ctx, calls } = makeTestContext({
        item: { issueNumber: 952 },
        mockOptions: {
          streamResult: () => streamResult({ isError: false, sessionId: "sess-t" }),
        },
      });
      // The timeout shape: dispatcher SIGTERM, empty terminal reason.
      const first = streamResult({
        isError: true,
        terminalReason: "",
        timedOut: true,
        sessionId: "sess-t",
      });

      await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile), ctx);

      assert.equal(calls.claudeStreams, 1);
      const log = loggedText(calls);
      assert.match(log, /Reason: timeout/);
      const promptWrite = calls.fs.find(
        (f) => f.kind === "write" && f.path.includes(".prompt-resume-952"),
      );
      assert.ok(promptWrite);
      assert.match(promptWrite!.content!, /wall-clock/);
    });
  });

  test("a still-exhausted continuation falls through with the ORIGINAL first-leg result", async () => {
    await withResumeLegs(undefined, async () => {
      const { ctx, calls } = makeTestContext({
        mockOptions: {
          // The continuation leg ALSO jams the cap.
          streamResult: () => streamResult({
            isError: true,
            terminalReason: "max_turns",
            sessionId: "sess-first",
            numTurns: 135,
          }),
        },
      });
      const first = EXHAUSTED_MAX_TURNS();

      const result = await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile), ctx);

      // Default budget is one leg; it was spent.
      assert.equal(calls.claudeStreams, 1);
      // Salvage must see the original inputs — the very same object.
      assert.equal(result, first);
    });
  });

  test("a continuation leg that throws is swallowed and the original result falls through to salvage", async () => {
    await withResumeLegs(undefined, async () => {
      const { ctx, calls } = makeTestContext({
        item: { issueNumber: 953 },
        mockOptions: {
          streamResult: () => { throw new Error("spawn claude ENOENT"); },
        },
      });
      const first = EXHAUSTED_MAX_TURNS();

      const result = await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile), ctx);

      assert.equal(calls.claudeStreams, 1);
      assert.equal(result, first);
      const log = loggedText(calls);
      assert.match(log, /RESUME_FAILED/);
      assert.match(log, /spawn claude ENOENT/);
    });
  });

  test("PYRY_RESUME_LEGS=0 short-circuits: no spawn, no prompt write, the result passes through untouched", async () => {
    await withResumeLegs("0", async () => {
      const { ctx, calls } = makeTestContext();
      const first = EXHAUSTED_MAX_TURNS();

      const result = await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile), ctx);

      assert.equal(result, first);
      assert.equal(calls.claudeStreams, 0);
      assert.ok(
        !calls.fs.some((f) => f.kind === "write" && f.path.includes(".prompt-resume-")),
        "no continuation prompt may be written when the feature is off",
      );
    });
  });

  test("a permission denial never resumes, even when the wall clock also fired", async () => {
    await withResumeLegs(undefined, async () => {
      const { ctx, calls } = makeTestContext();
      const first = streamResult({
        isError: true,
        terminalReason: "permission_denied",
        timedOut: true,
        hadPermissionDenial: true,
        sessionId: "sess-denied",
      });

      const result = await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile), ctx);

      assert.equal(result, first);
      assert.equal(calls.claudeStreams, 0);
    });
  });

  test("no captured session id → no resume (the kill happened before the init frame)", async () => {
    await withResumeLegs(undefined, async () => {
      const { ctx, calls } = makeTestContext();
      const first = streamResult({ isError: true, terminalReason: "max_turns", sessionId: "" });

      const result = await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile), ctx);

      assert.equal(result, first);
      assert.equal(calls.claudeStreams, 0);
    });
  });

  test("a non-worktree agent (PO shape) never resumes", async () => {
    await withResumeLegs(undefined, async () => {
      const { ctx, calls } = makeTestContext({
        agent: { name: "po", usesWorktree: false, producesCommits: false },
      });
      const first = EXHAUSTED_MAX_TURNS();

      const result = await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile), ctx);

      assert.equal(result, first);
      assert.equal(calls.claudeStreams, 0);
    });
  });

  test("a clean success passes through with no resume machinery at all", async () => {
    await withResumeLegs(undefined, async () => {
      const { ctx, calls } = makeTestContext();
      const first = streamResult({ isError: false });

      const result = await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile), ctx);

      assert.equal(result, first);
      assert.equal(calls.claudeStreams, 0);
    });
  });

  test("PYRY_RESUME_LEGS=2 grants a second continuation after an exhausted first one, merging all three legs", async () => {
    await withResumeLegs("2", async () => {
      let leg = 0;
      const { ctx, calls } = makeTestContext({
        mockOptions: {
          streamResult: () => {
            leg += 1;
            if (leg === 1) {
              return streamResult({
                isError: true,
                terminalReason: "max_turns",
                sessionId: "sess-first",
                numTurns: 135,
                totalCostUsd: 4,
                durationMs: 500_000,
              });
            }
            return streamResult({
              isError: false,
              terminalReason: "stop",
              sessionId: "sess-first",
              numTurns: 20,
              totalCostUsd: 0.5,
              durationMs: 100_000,
              output: "done on the third leg",
            });
          },
        },
      });
      const first = EXHAUSTED_MAX_TURNS();

      const result = await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile), ctx);

      assert.equal(calls.claudeStreams, 2);
      assert.equal(result.isError, false);
      assert.equal(result.numTurns, 135 + 135 + 20);
      assert.equal(result.totalCostUsd, 4.5 + 4 + 0.5);
      assert.equal(result.durationMs, 600_000 + 500_000 + 100_000);
      assert.equal(result.output, "done on the third leg");
    });
  });
});

describe("dispatchToAgent — resume-in-place integration", () => {
  test("success-after-resume walks the normal success path exactly as if the first run had succeeded", async () => {
    await withResumeLegs(undefined, async () => {
      const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
      const client = new MockGitHubClient({
        status: { 960: "In Development" },
        labels: { 960: [] },
      });
      const item = makeProjectItem({ issueNumber: 960 });
      const agent = makeAgentConfig({});
      const { deps, calls } = makeMockDeps({
        execImpls: fullHappyExecImpls("feature/960"),
        fsMap: { [claudeMd]: "developer system prompt" },
        streamResult: (opts: any) => opts?.resumeSessionId
          ? streamResult({ isError: false, terminalReason: "stop", sessionId: "sess-960", numTurns: 30, output: "wrapped up after resume" })
          : streamResult({ isError: true, terminalReason: "max_turns", sessionId: "sess-960", numTurns: 135 }),
      });

      await dispatchToAgent(agent, item, client, deps);

      // First leg + one continuation leg.
      assert.equal(calls.claudeStreams, 2);
      // Normal success path: done label, no error/salvage labels, cleanup.
      assert.ok(client.addLabelCalls.some((c) => c.label === "done:developer"));
      assert.ok(!client.addLabelCalls.some((c) => c.label.startsWith("error:")));
      assert.ok(cleanupRan(calls.exec), "success-after-resume must run cleanupAfterDispatch");
      assert.equal(calls.discord.length, 0);
    });
  });

  test("exhausted-after-resume falls through to safer salvage with the original session references", async () => {
    await withResumeLegs(undefined, async () => {
      const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
      const client = new MockGitHubClient({
        status: { 961: "In Development" },
        labels: { 961: [] },
      });
      const item = makeProjectItem({ issueNumber: 961 });
      const agent = makeAgentConfig({});
      const { deps, calls } = makeMockDeps({
        execImpls: {
          ...fullHappyExecImpls("feature/961"),
          "gh pr list --head": () => "[]",
          "git status --porcelain": () => "M file.go\n",
        },
        fsMap: { [claudeMd]: "developer system prompt" },
        // Both legs jam the cap. The continuation leg reports a
        // different session id (contrived — a real resume keeps it) so
        // the assertion below can PROVE salvage saw the original.
        streamResult: (opts: any) => opts?.resumeSessionId
          ? streamResult({ isError: true, terminalReason: "max_turns", sessionId: "sess-continuation", numTurns: 135 })
          : streamResult({ isError: true, terminalReason: "max_turns", sessionId: "sess-original", numTurns: 135, output: "first leg tail" }),
      });

      await dispatchToAgent(agent, item, client, deps);

      assert.equal(calls.claudeStreams, 2);
      // Salvage ran exactly as today.
      assert.ok(client.addLabelCalls.some((c) => c.label === "error:max_turns_salvaged"));
      assert.ok(!client.addLabelCalls.some((c) => c.label === "done:developer"));
      // The salvage commit cites the ORIGINAL run's session id.
      const commit = calls.spawn.find((sp) => sp.cmd === "git" && sp.args[0] === "commit");
      assert.ok(commit, "salvage must commit the worktree");
      assert.ok(
        commit!.args.some((a) => a.includes("Session: sess-original")),
        "salvage commit must reference the original session id",
      );
      assert.ok(cleanupRan(calls.exec));
    });
  });

  test("PYRY_RESUME_LEGS=0 restores the pre-resume dispatch byte-for-byte: one leg, straight to salvage", async () => {
    await withResumeLegs("0", async () => {
      const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
      const client = new MockGitHubClient({
        status: { 962: "In Development" },
        labels: { 962: [] },
      });
      const item = makeProjectItem({ issueNumber: 962 });
      const agent = makeAgentConfig({});
      const { deps, calls } = makeMockDeps({
        execImpls: {
          ...fullHappyExecImpls("feature/962"),
          "gh pr list --head": () => "[]",
          "git status --porcelain": () => "M file.go\n",
        },
        fsMap: { [claudeMd]: "developer system prompt" },
        streamResult: streamResult({
          isError: true,
          terminalReason: "max_turns",
          sessionId: "sess-962",
          numTurns: 135,
        }),
      });

      await dispatchToAgent(agent, item, client, deps);

      assert.equal(calls.claudeStreams, 1, "the feature off must spawn exactly one leg");
      assert.ok(client.addLabelCalls.some((c) => c.label === "error:max_turns_salvaged"));
      assert.ok(
        !calls.fs.some((f) => f.kind === "write" && f.path.includes(".prompt-resume-")),
        "no continuation prompt may be written when the feature is off",
      );
    });
  });
});

// =====================================================================
// Stage sets — spawn grants, pre-verifier gates, threading tripwires
// =====================================================================
//
// The pure stage-set shapes (classic identity, builder chain, budgets)
// live in stage-sets.test.ts. This block covers the IO-bearing side:
// what `prepareAgentSpawn` grants under each set, how the pre-verifier
// deterministic gates behave inside `dispatchToAgent`, and the source
// tripwires that keep the poll loop reading the resolved set.

/** Run `fn` with PYRY_STAGE_SET pinned (or unset), resetting the
 *  memoized active set on entry and exit. Mirrors `withResumeLegs`. */
async function withStageSet<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.PYRY_STAGE_SET;
  if (value === undefined) delete process.env.PYRY_STAGE_SET;
  else process.env.PYRY_STAGE_SET = value;
  resetActiveStageSetForTests();
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.PYRY_STAGE_SET;
    else process.env.PYRY_STAGE_SET = prior;
    resetActiveStageSetForTests();
  }
}

/** Pin PYRY_VERIFIER_GATES (or unset it) for the duration of `fn`. */
async function withVerifierGates<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.PYRY_VERIFIER_GATES;
  if (value === undefined) delete process.env.PYRY_VERIFIER_GATES;
  else process.env.PYRY_VERIFIER_GATES = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.PYRY_VERIFIER_GATES;
    else process.env.PYRY_VERIFIER_GATES = prior;
  }
}

const BUILDER_SET = resolveStageSet("builder");
const builderAgent = (name: string): AgentConfig =>
  BUILDER_SET.agents.find((a) => a.name === name)!;

describe("stage sets — prepareAgentSpawn grants + budgets", () => {
  test("builder set: builder gets Agent AND WebSearch, 200 turns, 40min", async () => {
    await withStageSet("builder", async () => {
      const claudeMd = claudeMdAbsPath("builder/CLAUDE.md");
      const { ctx } = makeTestContext({
        agent: builderAgent("builder"),
        item: { issueNumber: 900 },
        mockOptions: { fsMap: { [claudeMd]: "builder system prompt" } },
      });
      const result = await prepareAgentSpawn(ctx);
      assert.ok(result.ok);
      const tools = result.config.allowedTools.split(",");
      assert.ok(tools.includes("Agent"), "builder must get the Agent sub-agent tool");
      assert.ok(tools.includes("WebSearch"), "builder absorbs the architect's research → WebSearch");
      assert.equal(result.config.maxTurns, 200);
      assert.equal(result.config.timeoutMs, 2_400_000);
      assert.equal(result.config.model, "opus");
      assert.equal(result.config.effort, "high");
    });
  });

  test("builder set: verifier gets Agent but NOT WebSearch, code-review budgets", async () => {
    await withStageSet("builder", async () => {
      const claudeMd = claudeMdAbsPath("verifier/CLAUDE.md");
      const { ctx } = makeTestContext({
        agent: builderAgent("verifier"),
        item: { issueNumber: 901 },
        mockOptions: { fsMap: { [claudeMd]: "verifier system prompt" } },
      });
      const result = await prepareAgentSpawn(ctx);
      assert.ok(result.ok);
      const tools = result.config.allowedTools.split(",");
      assert.ok(tools.includes("Agent"), "verifier must get the Agent sub-agent tool");
      assert.ok(!tools.includes("WebSearch"), "verifier gets no open web access");
      assert.equal(result.config.maxTurns, 150);
      assert.equal(result.config.timeoutMs, 2_400_000);
    });
  });

  test("builder set: refiner and documentation get neither Agent nor WebSearch; budgets carry over", async () => {
    await withStageSet("builder", async () => {
      for (const [name, maxTurns, timeoutMs, model] of [
        ["refiner", 135, 1_200_000, "opus"],
        ["documentation", 135, 1_500_000, "claude-sonnet-5"],
      ] as const) {
        const agent = builderAgent(name);
        const claudeMd = claudeMdAbsPath(agent.claudeMdPath);
        const { ctx } = makeTestContext({
          agent,
          item: { issueNumber: 902 },
          mockOptions: { fsMap: { [claudeMd]: `${name} system prompt` } },
        });
        const result = await prepareAgentSpawn(ctx);
        assert.ok(result.ok, `${name} spawn prep must succeed`);
        const tools = result.config.allowedTools.split(",");
        assert.ok(!tools.includes("Agent"), `${name} must not get Agent`);
        assert.ok(!tools.includes("WebSearch"), `${name} must not get WebSearch`);
        assert.equal(result.config.maxTurns, maxTurns, `${name} maxTurns`);
        assert.equal(result.config.timeoutMs, timeoutMs, `${name} timeoutMs`);
        assert.equal(result.config.model, model, `${name} model`);
      }
    });
  });

  test("classic set (env unset): architect grants byte-identical to today (Agent + WebSearch)", async () => {
    await withStageSet(undefined, async () => {
      const claudeMd = claudeMdAbsPath("architect/CLAUDE.md");
      const { ctx } = makeTestContext({
        agent: { name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md", producesCommits: true },
        item: { issueNumber: 903 },
        mockOptions: { fsMap: { [claudeMd]: "architect system prompt" } },
      });
      const result = await prepareAgentSpawn(ctx);
      assert.ok(result.ok);
      const tools = result.config.allowedTools.split(",");
      assert.ok(tools.includes("Agent"));
      assert.ok(tools.includes("WebSearch"));
    });
  });
});

describe("runVerifierGates — deterministic gate execution", () => {
  const gateDeps = (opts: MockDepsOptions = {}) => {
    const { deps, calls } = makeMockDeps(opts);
    return { deps, calls };
  };

  test("runs every gate in the worktree cwd with the 10-minute cap, in order", async () => {
    const { deps, calls } = gateDeps();
    const result = await runVerifierGates({
      gates: ["make check", "make build"],
      cwd: "/worktrees/verifier-7",
      issueNumber: 7,
      deps,
    });
    assert.ok(result.ok);
    assert.equal(result.failedGate, null);
    assert.deepEqual(calls.gates.map((g) => g.command), ["make check", "make build"]);
    for (const req of calls.gates) {
      assert.equal(req.cwd, "/worktrees/verifier-7", "gates must run in the ticket's worktree");
      assert.equal(req.timeoutMs, VERIFIER_GATE_TIMEOUT_MS, "each gate gets the 10min cap");
      assert.equal(req.timeoutMs, 600_000);
    }
    assert.deepEqual(result.summary, [
      "✓ make check (exit 0)",
      "✓ make build (exit 0)",
    ]);
  });

  test("red exit code → stops at the failing gate, names it, later gates never run", async () => {
    const { deps, calls } = gateDeps({
      gateImpl: (req) =>
        req.command === "make check"
          ? { exitCode: 2, timedOut: false, spawnError: null }
          : { exitCode: 0, timedOut: false, spawnError: null },
    });
    const result = await runVerifierGates({
      gates: ["go vet ./...", "make check", "make build"],
      cwd: "/wt",
      issueNumber: 8,
      deps,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failedGate, "make check");
    assert.deepEqual(
      calls.gates.map((g) => g.command),
      ["go vet ./...", "make check"],
      "the gate after the red one must not run",
    );
    assert.match(result.summary[1]!, /^✗ make check \(exit 2\)$/);
  });

  test("output tail comes from the gate's stdout+stderr files, capped at 4000 chars (the tail, not the head)", async () => {
    const stdoutBody = "HEAD-" + "x".repeat(5000) + "-TAIL";
    const logsDir = "/gate-logs";
    const { deps } = gateDeps({
      gateImpl: () => ({ exitCode: 1, timedOut: false, spawnError: null }),
      fsMap: {
        [resolve(logsDir, "verifier-gate_#9_1.log")]: stdoutBody,
        [resolve(logsDir, "verifier-gate_#9_1.stderr.log")]: "",
      },
    });
    const result = await runVerifierGates({
      gates: ["make check"],
      cwd: "/wt",
      issueNumber: 9,
      logsDir,
      deps,
    });
    assert.equal(result.ok, false);
    assert.equal(result.outputTail.length, VERIFIER_GATE_TAIL_CAP);
    assert.ok(result.outputTail.endsWith("-TAIL"), "must keep the tail of the output");
    assert.ok(!result.outputTail.startsWith("HEAD-"), "the head is what gets cut");
  });

  test("timeout counts as red", async () => {
    const { deps } = gateDeps({
      gateImpl: () => ({ exitCode: null, timedOut: true, spawnError: null }),
    });
    const result = await runVerifierGates({ gates: ["make slow"], cwd: "/wt", issueNumber: 10, deps });
    assert.equal(result.ok, false);
    assert.equal(result.failedGate, "make slow");
    assert.match(result.summary[0]!, /timed out after 10min/);
  });

  test("spawn error counts as red", async () => {
    const { deps } = gateDeps({
      gateImpl: () => ({ exitCode: null, timedOut: false, spawnError: "could not spawn gate command: ENOENT" }),
    });
    const result = await runVerifierGates({ gates: ["make check"], cwd: "/wt", issueNumber: 11, deps });
    assert.equal(result.ok, false);
    assert.match(result.summary[0]!, /spawn error/);
  });
});

describe("pre-verifier gates — dispatchToAgent wiring", () => {
  // Contract: the deterministic layer decides green vs red only. Green →
  // gates-passed note (judgment-only review). Red → the verifier is STILL
  // spawned, with the failure context injected as a TRIAGE MODE prompt
  // note; the verifier owns baseline partition and bounce-vs-advance.

  test("classic set: entirely inert even with PYRY_VERIFIER_GATES set — no gate runs, agent spawns as today", async () => {
    await withStageSet(undefined, () => withVerifierGates("exit 1", async () => {
      const claudeMd = claudeMdAbsPath("code-review/CLAUDE.md");
      const client = new MockGitHubClient({ status: { 910: "In Code Review" }, labels: { 910: [] } });
      const item = makeProjectItem({ issueNumber: 910 });
      const agent = makeAgentConfig({
        name: "code-review",
        column: "In Code Review",
        claudeMdPath: "code-review/CLAUDE.md",
        producesCommits: false,
      });
      const { deps, calls } = makeMockDeps({
        execImpls: fullHappyExecImpls("feature/910"),
        fsMap: { [claudeMd]: "code-review system prompt" },
      });

      await dispatchToAgent(agent, item, client, deps);

      assert.equal(calls.gates.length, 0, "classic set must never invoke the gate spawner");
      assert.equal(calls.claudeStreams, 1, "the model spawn is unchanged");
      assert.ok(client.addLabelCalls.some((c) => c.label === "done:code-review"));
      assert.ok(!client.addLabelCalls.some((c) => c.label.startsWith("needs-rework:")));
    }));
  });

  test("builder set, gates green → verifier spawned with a gates-passed note appended to the prompt file", async () => {
    await withStageSet("builder", () => withVerifierGates(undefined, async () => {
      const claudeMd = claudeMdAbsPath("verifier/CLAUDE.md");
      const client = new MockGitHubClient({ status: { 911: "In Code Review" }, labels: { 911: [] } });
      const item = makeProjectItem({ issueNumber: 911 });
      const { deps, calls } = makeMockDeps({
        execImpls: fullHappyExecImpls("feature/911"),
        fsMap: { [claudeMd]: "verifier system prompt" },
      });

      await dispatchToAgent(builderAgent("verifier"), item, client, deps);

      // Default PYRY_VERIFIER_GATES → the Go pair, both green.
      assert.deepEqual(calls.gates.map((g) => g.command), ["go vet ./...", "go build ./..."]);
      assert.equal(calls.claudeStreams, 1, "green gates must spawn the verifier");
      assert.ok(client.addLabelCalls.some((c) => c.label === "done:verifier"));
      const promptWrite = calls.fs.find((f) => f.kind === "write" && f.path.endsWith(".prompt-911.txt"));
      assert.ok(promptWrite, "prompt file must be written");
      assert.match(promptWrite!.content!, /## Deterministic gates/);
      assert.match(promptWrite!.content!, /go vet \.\/\.\.\./);
    }));
  });

  test("builder set, gate red → verifier STILL spawned, prompt note in TRIAGE MODE with gate facts", async () => {
    // The deterministic layer decides only green vs red. A red gate must
    // not bounce blind: a pre-existing failure on the merge base would
    // bounce forever. The verifier gets the failure context and owns the
    // baseline partition + bounce-vs-advance call (like QA today).
    await withStageSet("builder", () => withVerifierGates(undefined, async () => {
      const claudeMd = claudeMdAbsPath("verifier/CLAUDE.md");
      const client = new MockGitHubClient({ status: { 912: "In Code Review" }, labels: { 912: [] } });
      const item = makeProjectItem({ issueNumber: 912 });
      const { deps, calls } = makeMockDeps({
        execImpls: fullHappyExecImpls("feature/912"),
        fsMap: { [claudeMd]: "verifier system prompt" },
        gateImpl: (req) =>
          req.command === "go vet ./..."
            ? { exitCode: 1, timedOut: false, spawnError: null }
            : { exitCode: 0, timedOut: false, spawnError: null },
      });

      await dispatchToAgent(builderAgent("verifier"), item, client, deps);

      assert.equal(calls.claudeStreams, 1, "red always gets a model — the verifier triages the failure");
      assert.ok(
        !client.addLabelCalls.some((c) => c.label === "needs-rework:builder"),
        "the dispatcher must not route rework on red — that call belongs to the verifier",
      );
      assert.ok(
        !client.comments.some((c) => c.body.includes("gates failed")),
        "no gate-failure ticket comment — the failure context goes to the verifier's prompt",
      );
      const promptWrite = calls.fs.find((f) => f.kind === "write" && f.path.endsWith(".prompt-912.txt"));
      assert.ok(promptWrite, "prompt file must be written");
      assert.match(promptWrite!.content!, /TRIAGE MODE/);
      assert.match(promptWrite!.content!, /go vet \.\/\.\.\./, "note must name the failing gate");
      assert.match(promptWrite!.content!, /exit 1/, "note must carry the exit code");
    }));
  });

  test("builder set, PYRY_VERIFIER_GATES='' → gating opted out, verifier spawns with no note", async () => {
    await withStageSet("builder", () => withVerifierGates("", async () => {
      const claudeMd = claudeMdAbsPath("verifier/CLAUDE.md");
      const client = new MockGitHubClient({ status: { 913: "In Code Review" }, labels: { 913: [] } });
      const item = makeProjectItem({ issueNumber: 913 });
      const { deps, calls } = makeMockDeps({
        execImpls: fullHappyExecImpls("feature/913"),
        fsMap: { [claudeMd]: "verifier system prompt" },
      });

      await dispatchToAgent(builderAgent("verifier"), item, client, deps);

      assert.equal(calls.gates.length, 0);
      assert.equal(calls.claudeStreams, 1);
      const promptWrite = calls.fs.find((f) => f.kind === "write" && f.path.endsWith(".prompt-913.txt"));
      assert.ok(promptWrite);
      assert.ok(!promptWrite!.content!.includes("Deterministic gates"));
    }));
  });

  test("builder set: non-gated agents (builder itself) skip the gate step", async () => {
    await withStageSet("builder", () => withVerifierGates(undefined, async () => {
      const claudeMd = claudeMdAbsPath("builder/CLAUDE.md");
      const client = new MockGitHubClient({ status: { 914: "In Development" }, labels: { 914: [] } });
      const item = makeProjectItem({ issueNumber: 914 });
      const { deps, calls } = makeMockDeps({
        execImpls: fullHappyExecImpls("feature/914"),
        fsMap: { [claudeMd]: "builder system prompt" },
      });

      await dispatchToAgent(builderAgent("builder"), item, client, deps);

      assert.equal(calls.gates.length, 0, "only the verifier is gate-gated");
      assert.equal(calls.claudeStreams, 1);
    }));
  });

  test("maybeRunPreSpawnGates green: GATES section written to the dispatch log, prompt note returned", async () => {
    await withStageSet("builder", () => withVerifierGates("make check", async () => {
      const { ctx, calls } = makeTestContext({
        agent: builderAgent("verifier"),
        item: { issueNumber: 915 },
      });

      const result = await maybeRunPreSpawnGates(ctx);

      assert.match(result.promptNote, /## Deterministic gates/);
      assert.ok(!result.promptNote.includes("TRIAGE MODE"), "green note must not read as a failure");
      assert.match(result.promptNote, /make check/);
      const log = loggedText(calls);
      assert.match(log, /GATES/);
      assert.match(log, /✓ make check \(exit 0\)/);
    }));
  });

  test("maybeRunPreSpawnGates red: TRIAGE MODE note carries gate, verdict and output tail; no board mutation", async () => {
    await withStageSet("builder", () => withVerifierGates("make check", async () => {
      const { ctx, client, calls } = makeTestContext({
        agent: builderAgent("verifier"),
        item: { issueNumber: 916 },
        mockOptions: {
          gateImpl: () => ({ exitCode: 3, timedOut: false, spawnError: null }),
        },
      });

      const result = await maybeRunPreSpawnGates(ctx);

      assert.match(result.promptNote, /TRIAGE MODE/);
      assert.match(result.promptNote, /make check/);
      assert.match(result.promptNote, /exit 3/);
      assert.equal(client.addLabelCalls.length, 0, "red gates mutate nothing — the verifier owns routing");
      assert.equal(client.comments.length, 0);
      const log = loggedText(calls);
      assert.match(log, /✗ make check \(exit 3\)/);
    }));
  });

  test("maybeRunPreSpawnGates red: output tail (capped at 4000) is embedded in the triage note", async () => {
    await withStageSet("builder", () => withVerifierGates("make check", async () => {
      const logsTail = "Z".repeat(120) + "-END";
      const { ctx } = makeTestContext({
        agent: builderAgent("verifier"),
        item: { issueNumber: 917 },
        mockOptions: {
          gateImpl: () => ({ exitCode: 2, timedOut: false, spawnError: null }),
          fsMap: {
            [resolve(TEST_AGENTS_REPO_ROOT, "logs", "verifier-gate_#917_1.log")]: logsTail,
            [resolve(TEST_AGENTS_REPO_ROOT, "logs", "verifier-gate_#917_1.stderr.log")]: "",
          },
        },
      });

      const result = await maybeRunPreSpawnGates(ctx);

      assert.match(result.promptNote, /Z{120}-END/, "the gate's output tail must reach the verifier");
    }));
  });
});

describe("stage-set threading tripwires (source assertions)", () => {
  test("pollLoop derives its poll order from the resolved stage set, not the AGENTS const", () => {
    const source = readDispatchSource();
    assert.match(
      source,
      /const pollOrder = \[\.\.\.stageSet\.agents\]\.reverse\(\);/,
      "pollLoop must build pollOrder from the resolved stage set",
    );
  });

  test("startup banner prints the active stage set", () => {
    const source = readDispatchSource();
    assert.match(
      source,
      /Stage set: \$\{stageSet\.name\}/,
      "the startup banner must name the active stage set",
    );
  });
});

// =====================================================================
// selectPastParkedFamilies — the board must not starve behind a parked
// family
// =====================================================================
//
// Regression cover for the 2026-09-01 stall on board #1. The breaker can
// only drop candidates; selection spends the whole concurrency budget
// before the drop happens. At concurrency 1 with three parked
// descendants of #1906 at the head of Backlog, every cycle handed its
// only slot to a ticket it then threw away, and 48 unrelated tickets
// never got looked at.

describe("selectPastParkedFamilies — a parked family must not starve the board", () => {
  const PO = AGENTS.find(a => a.name === "po")!;
  const child = (n: number, root: number) =>
    makeProjectItem({ issueNumber: n, status: "Backlog", parentNumber: root });
  const loner = (n: number) => makeProjectItem({ issueNumber: n, status: "Backlog" });

  test("at concurrency 1 the slot goes to the next unrelated ticket, not to the void", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(1906, { markerCount: 24, breakerCommented: false });
    // Board order is the live one: three parked descendants at the head,
    // an unrelated ticket behind them.
    const backlog = [child(1927, 1906), child(1928, 1906), child(1907, 1906), loner(1958)];

    const out = await selectPastParkedFamilies({
      itemsByColumn: new Map([["Backlog", backlog]]),
      pollOrder: [PO],
      maxConcurrent: 1,
      client,
      threshold: 24,
    });

    assert.equal(out.candidates.length, 1, "the cycle must dispatch, not idle");
    assert.equal(out.candidates[0].item.issueNumber, 1958, "the slot goes to the unrelated ticket");
  });

  test("one comments fetch and one park write per root, however many passes it takes", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(1906, { markerCount: 24, breakerCommented: false });
    const backlog = [child(1927, 1906), child(1928, 1906), child(1907, 1906), loner(1958)];

    await selectPastParkedFamilies({
      itemsByColumn: new Map([["Backlog", backlog]]),
      pollOrder: [PO],
      maxConcurrent: 1,
      client,
      threshold: 24,
    });

    assert.deepEqual(
      client.getFamilyDispatchStateCalls.filter(n => n === 1906).length,
      1,
      "the shared cycle state means a re-selection pass refetches nothing",
    );
    assert.deepEqual(
      client.addLabelCalls.filter(c => c.label === FAMILY_BREAKER_LABEL),
      [{ issueNumber: 1906, label: FAMILY_BREAKER_LABEL }],
      "the root is parked once, not once per pass",
    );
    assert.equal(
      client.comments.filter(c => c.body.includes(FAMILY_BREAKER_COMMENT_MARKER)).length,
      1,
      "one trip explanation per cycle",
    );
  });

  test("two parked families in a row both get skipped and the third family dispatches", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(500, { markerCount: 30, breakerCommented: false });
    client.familyStateByIssue.set(600, { markerCount: 24, breakerCommented: false });
    const backlog = [child(501, 500), child(601, 600), loner(700)];

    const out = await selectPastParkedFamilies({
      itemsByColumn: new Map([["Backlog", backlog]]),
      pollOrder: [PO],
      maxConcurrent: 1,
      client,
      threshold: 24,
    });

    assert.equal(out.candidates[0]?.item.issueNumber, 700);
    assert.deepEqual([...out.cycle.vetoedRoots].sort((a, b) => a - b), [500, 600]);
  });

  test("a healthy board takes exactly one pass — no extra selection, no extra fetch", async () => {
    const client = new MockGitHubClient();
    const backlog = [loner(10), loner(11)];

    const out = await selectPastParkedFamilies({
      itemsByColumn: new Map([["Backlog", backlog]]),
      pollOrder: [PO],
      maxConcurrent: 2,
      client,
      threshold: 24,
    });

    assert.deepEqual(out.candidates.map(c => c.item.issueNumber), [10, 11]);
    assert.equal(out.cycle.vetoedRoots.size, 0);
  });

  test("a board that is nothing but parked families dispatches nothing and says so", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(800, { markerCount: 24, breakerCommented: false });
    const backlog = [child(801, 800), child(802, 800)];

    const out = await selectPastParkedFamilies({
      itemsByColumn: new Map([["Backlog", backlog]]),
      pollOrder: [PO],
      maxConcurrent: 1,
      client,
      threshold: 24,
    });

    assert.deepEqual(out.candidates, [], "nothing dispatchable is the honest answer here");
    assert.deepEqual([...out.cycle.vetoedRoots], [800]);
  });

  test("the pass cap bounds the work and still dispatches what it found", async () => {
    const client = new MockGitHubClient();
    // Five parked families ahead of the healthy ticket, two passes allowed.
    for (const root of [10, 20, 30, 40, 50]) {
      client.familyStateByIssue.set(root, { markerCount: 24, breakerCommented: false });
    }
    const backlog = [
      child(11, 10), child(21, 20), child(31, 30), child(41, 40), child(51, 50), loner(99),
    ];

    const out = await selectPastParkedFamilies({
      itemsByColumn: new Map([["Backlog", backlog]]),
      pollOrder: [PO],
      maxConcurrent: 1,
      client,
      threshold: 24,
      maxPasses: 2,
    });

    assert.deepEqual(out.candidates, [], "the cap holds — this cycle gives up rather than walking the board");
    assert.equal(out.cycle.vetoedRoots.size, 2, "but every family it did examine is parked on the board");
    // The next cycle starts with those two vetoed at selection for free,
    // so progress is monotonic even when the cap bites.
    const next = await selectPastParkedFamilies({
      itemsByColumn: new Map([["Backlog", backlog]]),
      pollOrder: [PO],
      maxConcurrent: 1,
      rootLabelsByIssue: new Map([[10, [FAMILY_BREAKER_LABEL]], [20, [FAMILY_BREAKER_LABEL]]]),
      client,
      threshold: 24,
      maxPasses: 2,
    });
    assert.equal(next.cycle.vetoedRoots.size, 2, "two fresh families examined, not the two already labelled");
  });

  test("an already-labelled root costs no pass at all — the label veto absorbs it at selection", async () => {
    const client = new MockGitHubClient();
    client.familyStateByIssue.set(1906, { markerCount: 24, breakerCommented: true });
    const backlog = [child(1927, 1906), loner(1958)];

    const out = await selectPastParkedFamilies({
      itemsByColumn: new Map([["Backlog", backlog]]),
      pollOrder: [PO],
      maxConcurrent: 1,
      rootLabelsByIssue: new Map([[1906, [FAMILY_BREAKER_LABEL]]]),
      client,
      threshold: 24,
    });

    assert.equal(out.candidates[0]?.item.issueNumber, 1958);
    assert.ok(
      !client.getFamilyDispatchStateCalls.includes(1906),
      "the parked root costs no tally fetch — selection never offered its child",
    );
  });
});

// Codex thread identifiers must never be handed to Claude's resume path.
test("Codex timeout keeps salvage result without a Claude continuation", async () => {
  const { ctx, calls } = makeTestContext({});
  const first = streamResult({ runner: "codex", isError: true, timedOut: true, sessionId: "codex-thread" });
  const result = await maybeResumeExhaustedRun(first, makeSpawnConfig(ctx.logFile, { runner: "codex" }), ctx);
  assert.equal(result, first);
  assert.equal(calls.claudeStreams, 0);
});

test("Codex spawn selection does not inherit Claude model overrides", async () => {
  const keys = ["PYRY_AGENT_RUNNER", "PYRY_CODEX_MODEL", "PYRY_CODEX_EFFORT"] as const;
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    process.env.PYRY_AGENT_RUNNER = "codex";
    delete process.env.PYRY_CODEX_MODEL;
    delete process.env.PYRY_CODEX_EFFORT;
    const { ctx } = makeTestContext({
      agent: { model: "claude-sonnet-5", effort: "high" },
      mockOptions: { fsMap: { [claudeMdAbsPath("developer/CLAUDE.md")]: "role" } },
    });
    const result = await prepareAgentSpawn(ctx);
    assert.ok(result.ok);
    assert.equal(result.config.runner, "codex");
    assert.equal(result.config.model, "gpt-6.1-sol");
    assert.equal(result.config.effort, "");
    process.env.PYRY_CODEX_MODEL = "selected-codex-model";
    process.env.PYRY_CODEX_EFFORT = "medium";
    const selected = await prepareAgentSpawn(ctx);
    assert.ok(selected.ok);
    assert.equal(selected.config.model, "selected-codex-model");
    assert.equal(selected.config.effort, "medium");
  } finally {
    for (const k of keys) {
      if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];
    }
  }
});

test("effort trial reaches both runners and records the actual selection without changing models", async () => {
  const keys = ["PYRY_EFFORT_POLICY", "PYRY_AGENT_RUNNER", "PYRY_CODEX_MODEL", "PYRY_CODEX_EFFORT"] as const;
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    process.env.PYRY_EFFORT_POLICY = "role-risk-v1";
    delete process.env.PYRY_CODEX_MODEL;
    delete process.env.PYRY_CODEX_EFFORT;
    await withStageSet("builder", async () => {
      for (const runner of ["claude", "codex"]) {
        process.env.PYRY_AGENT_RUNNER = runner;
        for (const [name, expected] of [["refiner", "medium"], ["builder", "medium"], ["verifier", "high"], ["documentation", "low"]]) {
          const agent = builderAgent(name);
          const { ctx, calls } = makeTestContext({
            agent,
            item: { body: "## Effort assessment\nRisk: routine\nReason: Clear local change.\n", labels: [] },
            mockOptions: { fsMap: { [claudeMdAbsPath(agent.claudeMdPath)]: "role" } },
          });
          const result = await prepareAgentSpawn(ctx);
          assert.ok(result.ok);
          assert.equal(result.config.effort, expected);
          assert.equal(result.config.model, runner === "codex" ? "gpt-6.1-sol" : agent.model ?? "opus");
          const log = calls.logs.find(l => l.section === "DISPATCH")!;
          assert.match(log.content, /Effort policy: role-risk-v1/);
          assert.ok(log.content.includes(`Effort: ${expected}\n`));
          assert.match(log.content, /Effort reason:/);
          assert.equal(calls.claudeStreams, 0, "spawn preparation must not run an agent");
        }
      }
    });
  } finally {
    for (const k of keys) {
      if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];
    }
  }
});

test("Codex blocked outcome never retries even if its summary mentions a transient error", async () => {
  const { ctx, client } = makeTestContext({});
  await handleDispatchError(new Error("connection reset; reviewer rejected required action"), ctx,
    streamResult({ runner: "codex", isError: true, terminalReason: "codex_blocked", sessionId: "codex-thread" }));
  assert.ok(client.addLabelCalls.some(x => x.label === "error:developer"));
  assert.ok(!client.addLabelCalls.some(x => x.label.startsWith("error-retry-count:")));
  assert.ok(client.comments.some(x => x.body.includes("codex resume codex-thread")));
  assert.ok(!client.comments.some(x => x.body.includes("claude --resume codex-thread")));
});

test("Codex blocked work, including shutdown timeout, preserves edits without salvage", async () => {
 for (const timedOut of [false, true]) {
  const client=new MockGitHubClient({status:{799:"In Development"},labels:{799:[]}});
  let spawnIndex=0;
  const {deps,calls}=makeMockDeps({execImpls:fullHappyExecImpls("feature/799"),
   fsMap:{[claudeMdAbsPath("developer/CLAUDE.md")]:"role"},
   streamResult:()=>{spawnIndex=calls.exec.length;return streamResult({runner:"codex",isError:true,terminalReason:"codex_blocked",output:"Commit was rejected",sessionId:"codex-thread",timedOut});}});
  await dispatchToAgent(makeAgentConfig({}),makeProjectItem({issueNumber:799}),client,deps);
  assert.ok(client.addLabelCalls.some(c=>c.label==="error:developer"));
  assert.ok(!client.addLabelCalls.some(c=>c.label==="done:developer"));
  assert.ok(!cleanupRan(calls.exec));
  assert.ok(!calls.exec.slice(spawnIndex).some(c=>c.cmd.includes("git worktree remove") || c.cmd.includes("git add") || c.cmd.includes("git push")));
  assert.ok(client.comments.some(c=>c.body.includes("Worktree preserved")));
 }
});


describe("Codex builder refinement handoff", () => {
  const request = () => streamResult({runner:"codex", isError:false, terminalReason:"needs_refinement", output:"ACs conflict"});
  test("dispatcher comments and labels assigned issue without committing or advancing", async () => {
    const {ctx, client, calls} = makeTestContext({agent:{name:"builder"}});
    assert.deepEqual(await handlePostRun(request(), ctx, false), {ok:false});
    assert.deepEqual(client.addLabelCalls, [{issueNumber:100, label:"needs-rework:refiner"}]);
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0].body, /ACs conflict/);
    assert.equal(calls.exec.length, 0);
    assert.equal(calls.spawn.length, 0);
  });
  test("comment failure cannot route or advance", async () => {
    const {ctx, client} = makeTestContext({agent:{name:"builder"}});
    client.failures.addComment = new Error("offline");
    await assert.rejects(handlePostRun(request(), ctx, false), /offline/);
    assert.equal(client.addLabelCalls.length, 0);
  });
  test("other roles and failed or denied outcomes cannot request routing", async () => {
    for (const patch of [{runner:"claude" as const}, {isError:true}, {hadPermissionDenial:true}]) {
      const {ctx, client} = makeTestContext({agent:{name:"builder"}});
      await assert.rejects(handlePostRun({...request(), ...patch}, ctx, false));
      assert.equal(client.addLabelCalls.length, 0);
    }
    const {ctx, client} = makeTestContext({agent:{name:"verifier"}});
    await assert.rejects(handlePostRun(request(), ctx, false));
    assert.equal(client.addLabelCalls.length, 0);
  });
});

describe("Codex builder blocker wait", () => {
  const request = () => streamResult({runner:"codex", isError:false, terminalReason:"waiting_on_blocker", output:"Baseline format fix is #1280"});
  test("a fresh open dependency routes to the existing wait path", async () => {
    const {ctx, client, calls} = makeTestContext({agent:{name:"builder"}});
    client.itemsByIssueNumber.set(100, {...ctx.item, state:"OPEN", blockedBy:[{number:1280,state:"OPEN"}]});
    assert.deepEqual(await handlePostRun(request(), ctx, false), {ok:false});
    assert.deepEqual(client.getOpenBlockersCalls, [100]);
    assert.deepEqual(client.addLabelCalls, [{issueNumber:100,label:"needs-rework:builder"}]);
    assert.match(client.comments[0].body, /Waiting on #1280/);
    assert.equal(calls.exec.length, 0);
  });
  test("no open dependency cannot masquerade as a wait", async () => {
    const {ctx, client} = makeTestContext({agent:{name:"builder"}});
    await assert.rejects(handlePostRun(request(), ctx, false), /without an open GitHub blocker/);
    assert.equal(client.addLabelCalls.length, 0);
  });
  test("denied, failed, or non-builder outcomes cannot wait", async () => {
    for (const patch of [{hadPermissionDenial:true}, {isError:true}, {runner:"claude" as const}]) {
      const {ctx, client} = makeTestContext({agent:{name:"builder"}});
      await assert.rejects(handlePostRun({...request(),...patch}, ctx, false), /Invalid blocker wait/);
      assert.equal(client.getOpenBlockersCalls.length, 0);
    }
    const {ctx, client} = makeTestContext({agent:{name:"verifier"}});
    await assert.rejects(handlePostRun(request(), ctx, false), /Invalid blocker wait/);
    assert.equal(client.getOpenBlockersCalls.length, 0);
  });
});

// =====================================================================
// Log-write containment: dispatch logs go through deps, never the real
// filesystem (2026-09-01, ported 2026-09-22)
// =====================================================================
//
// `writeLog` used to call the module-imported `appendFileSync` directly,
// so mock deps could not intercept it and every phase function that logs
// appended to the live logs dir of whatever AGENTS_REPO_PATH resolved to.
// One `pnpm test` in the shared checkout wrote 86 fake-ticket logs to
// `<parent>/logs/`; runs inside installed forks wrote into each fork's
// live `logs/`, mixed in with real agent logs (920 found on 2026-09-22).
//
// Invariant: with mock deps, no phase function materializes `ctx.logFile`
// on the real filesystem. `existsSync` here is the REAL node:fs one.
// One test per deps-threading shape: ctx.deps destructured, the
// scheduleTransientRetry deps param, and the salvage helpers' opts.deps.

describe("log-write containment (deps.writeLog seam)", () => {
  test("prepareAgentSpawn: DISPATCH/PROMPT/SYSTEM PROMPT go through deps, ctx.logFile never hits the real filesystem", async () => {
    const claudeMd = claudeMdAbsPath("developer/CLAUDE.md");
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 998877, title: "Containment ticket" },
      mockOptions: {
        fsMap: { [claudeMd]: "Mock developer system prompt" },
        buildPromptResult: "## Mock prompt #998877",
      },
    });

    const result = await prepareAgentSpawn(ctx);

    assert.ok(result.ok, "happy-path sanity: spawn config produced");
    assert.equal(existsSync(ctx.logFile), false, `dispatch log escaped to the real filesystem: ${ctx.logFile}`);
    assert.deepEqual(calls.logs.map((l) => l.section), ["DISPATCH", "PROMPT", "SYSTEM PROMPT"]);
    assert.ok(calls.logs.every((l) => l.logFile === ctx.logFile));
  });

  test("handlePostRun: OUTPUT/USAGE go through deps, ctx.logFile never hits the real filesystem", async () => {
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 998878 },
      mockOptions: {
        execImpls: {
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "0\n",
        },
      },
    });

    const result = await handlePostRun(STREAM_OK(), ctx, /* saferSalvaged */ true);

    assert.deepEqual(result, { ok: true });
    assert.equal(existsSync(ctx.logFile), false, `dispatch log escaped to the real filesystem: ${ctx.logFile}`);
    assert.ok(calls.logs.length > 0, "post-run sections captured through the deps seam instead");
  });

  test("handleDispatchError: ERROR and the transient-retry sections go through deps, ctx.logFile never hits the real filesystem", async () => {
    const { ctx, calls } = makeTestContext({ item: { issueNumber: 998879 } });

    await handleDispatchError(new Error("deliberate non-transient failure"), ctx, null);

    assert.equal(existsSync(ctx.logFile), false, `dispatch log escaped to the real filesystem: ${ctx.logFile}`);
    assert.ok(calls.logs.some((l) => l.section === "ERROR"));
  });

  test("safer salvage: SAFER_SALVAGE goes through opts.deps, ctx.logFile never hits the real filesystem", async () => {
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 998880 },
      mockOptions: {
        execImpls: {
          "gh pr list --head": () => "[]",
          "git status --porcelain": () => "M new.go\n",
        },
      },
    });

    await handleAgentResultErrors(streamResult({ isError: true, terminalReason: "max_turns" }), ctx);

    assert.equal(existsSync(ctx.logFile), false, `dispatch log escaped to the real filesystem: ${ctx.logFile}`);
    assert.ok(calls.logs.length > 0, "salvage sections captured through the deps seam instead");
  });
});

// =====================================================================
// runPendingDoneFinalize: the next board read finishes a deferred
// post-run decision (2026-09-22)
// =====================================================================

describe("runPendingDoneFinalize", () => {
  // Pinned to the classic set: the fixtures use the classic developer
  // column, and a builder fork's .env would otherwise resolve the builder set.
  test("ticket still in its agent's column → prior done:* stripped, done:<agent> added, pending label removed, cache cleared", () => withStageSet("classic", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 7001, status: "In Development", labels: ["done:architect", "pending-done:developer"], state: "OPEN" },
      ],
    });

    await runPendingDoneFinalize(client);

    assert.deepEqual(client.removeLabelCalls.map(c => `${c.issueNumber} ${c.label}`), [
      "7001 done:architect",
      "7001 pending-done:developer",
    ]);
    assert.deepEqual(client.addLabelCalls.map(c => `${c.issueNumber} ${c.label}`), ["7001 done:developer"]);
    assert.equal(client.clearItemsCacheCalls, 1);
  }));

  test("ticket moved out of the agent's column → only the pending label goes, no done label", () => withStageSet("classic", async () => {
    const client = new MockGitHubClient({
      items: [{ issueNumber: 7002, status: "Inbox", labels: ["pending-done:developer"], state: "OPEN" }],
    });

    await runPendingDoneFinalize(client);

    assert.deepEqual(client.removeLabelCalls.map(c => c.label), ["pending-done:developer"]);
    assert.equal(client.addLabelCalls.length, 0);
  }));

  test("done label cannot be written → the pending label stays for the next cycle", () => withStageSet("classic", async () => {
    const client = new MockGitHubClient({
      items: [{ issueNumber: 7003, status: "In Development", labels: ["pending-done:developer"], state: "OPEN" }],
    });
    client.failures.addLabel = new Error("REST 502");

    await runPendingDoneFinalize(client);

    assert.equal(client.removeLabelCalls.length, 0, "pending label kept so the decision is not lost");
  }));

  test("board read fails → nothing changes", () => withStageSet("classic", async () => {
    const client = new MockGitHubClient({
      items: [{ issueNumber: 7004, status: "In Development", labels: ["pending-done:developer"], state: "OPEN" }],
    });
    client.failures.getAllProjectItems = new Error("graphql rate limit");

    await runPendingDoneFinalize(client);

    assert.equal(client.addLabelCalls.length, 0);
    assert.equal(client.removeLabelCalls.length, 0);
    assert.equal(client.clearItemsCacheCalls, 0);
  }));
});

// =====================================================================
// Merge handoff: the code owner's run finishes a merge of main
// =====================================================================
//
// setupBranchAndWorktree leaves a conflicted merge for the code owner and
// records it on the context (merge-handoff.ts). What the run does with it is
// checked before the safety-net commit and the push; a run that errors is
// never salvaged, since salvage would push whatever markers it left.
describe("merge handoff — the owner's run", () => {
  const pendingMerge = { paths: ["Thread.kt"], mainSha: "mainsha", baseSha: "basesha", headSha: "headsha" };

  test("merge still in progress → error:<agent>, comment, no commit, no push, {ok:false}", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 808 },
      mockOptions: { execImpls: { "git rev-parse -q --verify MERGE_HEAD": () => "mainsha\n" } },
    });
    ctx.pendingMerge = pendingMerge;

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 808, label: "error:developer" }]);
    assert.match(client.comments[0]!.body, /never committed/);
    assert.match(client.comments[0]!.body, /Nothing was pushed/);
    assert.ok(!calls.exec.some(c => c.cmd.includes("git add -A")), "the safety-net commit must not seal a half-finished merge");
    assert.ok(!calls.exec.some(c => c.cmd.includes("git push")));
  });

  test("main's added line dropped → names it, no push, {ok:false}", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 808 },
      mockOptions: {
        execImpls: {
          "git rev-parse -q --verify MERGE_HEAD": () => execError({ status: 1 }),
          "git show HEAD:": () => "Overlay {\n  Status(usage = usage)\n}\n",
          "git diff -U0 basesha mainsha": () => "+++ b/Thread.kt\n+    turnOutcome = turnOutcome,\n",
        },
      },
    });
    ctx.pendingMerge = pendingMerge;

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: false });
    assert.match(client.comments[0]!.body, /lost 1 line\(s\) main added: `turnOutcome = turnOutcome,`/);
    assert.ok(!calls.exec.some(c => c.cmd.includes("git push")));
  });

  test("clean resolution → passes the check and pushes as usual", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 808 },
      mockOptions: {
        execImpls: {
          "git rev-parse -q --verify MERGE_HEAD": () => execError({ status: 1 }),
          "git show HEAD:": () => "Overlay {\n  Status(\n      turnOutcome = turnOutcome,\n  )\n}\n",
          "git diff -U0 basesha mainsha": () => "+++ b/Thread.kt\n+    turnOutcome = turnOutcome,\n",
          "git status --porcelain": () => "",
          "git rev-list --count main..": () => "3\n",
        },
      },
    });
    ctx.pendingMerge = pendingMerge;

    const result = await handlePostRun(STREAM_OK(), ctx, false);

    assert.deepEqual(result, { ok: true });
    assert.ok(!client.addLabelCalls.some(c => c.label.startsWith("error:")));
    assert.ok(calls.exec.some(c => c.cmd.includes("git push -u origin feature/808")));
  });

  test("a run that errors mid-merge is never salvaged", async () => {
    const { ctx, client, calls } = makeTestContext({ item: { issueNumber: 808 } });
    ctx.pendingMerge = pendingMerge;

    await assert.rejects(
      handleAgentResultErrors(streamResult({ isError: true, terminalReason: "max_turns" }), ctx),
      /not salvaged/,
    );
    assert.ok(!calls.exec.some(c => c.cmd.includes("git add -A") || c.cmd.includes("git push")));
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:max_turns_salvaged"));
  });
});

describe("worktreePath", () => {
  test("gives each repository its own folder, so equal ticket numbers cannot collide", () => {
    const mobile = worktreePath("/w/pyrycode-mobile", "builder-1348");
    const desktop = worktreePath("/w/pyrycode-desktop", "builder-1348");
    assert.equal(mobile, "/w/.pyrycode-worktrees/pyrycode-mobile/builder-1348");
    assert.equal(desktop, "/w/.pyrycode-worktrees/pyrycode-desktop/builder-1348");
  });

  test("ignores a trailing slash on the repository path", () => {
    assert.equal(worktreePath("/w/pyrycode/", "main-sweep"), "/w/.pyrycode-worktrees/pyrycode/main-sweep");
  });
});

describe("clearGateWorktreePath", () => {
  const exec = (fail: (c: string) => boolean) => {
    const calls: string[] = [];
    const fn = ((cmd: string) => {
      calls.push(cmd);
      if (fail(cmd)) throw new Error(`boom: ${cmd}`);
      return Buffer.from("");
    }) as any;
    return { fn, calls };
  };
  const dir = "/tmp/.pyrycode-worktrees/real-claude-gate-7";

  test("returns the stale path it moved a refused leftover to", () => {
    const { fn, calls } = exec(c => c.includes("worktree remove"));
    const moved = clearGateWorktreePath(fn, "/tmp/repo", dir, "2026-09-25T14-35-53-625Z");
    assert.equal(moved, "/tmp/.pyrycode-worktrees/stale-real-claude-gate-7-2026-09-25T14-35-53-625Z");
    assert.ok(calls.some(c => c === "git worktree prune"));
  });

  test("returns null when nothing is at the path (remove and move both fail)", () => {
    const { fn, calls } = exec(c => c.includes("worktree remove") || c.includes("worktree move"));
    assert.equal(clearGateWorktreePath(fn, "/tmp/repo", dir, "s"), null);
    assert.ok(calls.some(c => c === "git worktree prune"), "prune still runs");
  });

  test("returns null and moves nothing when removal succeeds", () => {
    const { fn, calls } = exec(() => false);
    assert.equal(clearGateWorktreePath(fn, "/tmp/repo", dir, "s"), null);
    assert.ok(!calls.some(c => c.includes("worktree move")));
  });
});

// =====================================================================
// Partial-work salvage — a stopped run on a branch that already has a PR
// =====================================================================
//
// pyrycode-mobile #1430 (2026-10-02) and #1332 (2026-10-01) both timed out
// in documentation with finished edits uncommitted. Their tickets already
// had a PR, so the draft-PR salvage never applied, and both timeouts came
// through the runner's REJECT door ("Agent timed out after 2280s", no
// result frame). These tests drive dispatchToAgent through both doors.

describe("partial-work salvage — stopped run with an existing PR (mobile #1430, #1332)", () => {
  const DOC_AGENT: Partial<AgentConfig> = {
    name: "documentation", column: "In Documentation", claudeMdPath: "documentation/CLAUDE.md", producesCommits: true,
  };
  const PR_JSON = `[{"number": 1431}]`;
  const NO_MERGE = { "git rev-parse -q --verify MERGE_HEAD": () => execError({ status: 1 }) };

  function stoppedRun(opts: {
    issue: number;
    agent?: Partial<AgentConfig>;
    stop: { reject: Error } | { result: StreamResult };
    exec?: Record<string, ExecHandler>;
    spawn?: Record<string, SpawnHandler>;
  }) {
    const agent = makeAgentConfig(opts.agent ?? DOC_AGENT);
    const client = new MockGitHubClient({ status: { [opts.issue]: agent.column }, labels: { [opts.issue]: [] } });
    const item = makeProjectItem({ issueNumber: opts.issue, status: agent.column });
    const { deps, calls } = makeMockDeps({
      execImpls: { ...fullHappyExecImpls(`feature/${opts.issue}`), ...NO_MERGE, ...opts.exec },
      spawnImpls: opts.spawn,
      fsMap: { [claudeMdAbsPath(agent.claudeMdPath)]: "role prompt" },
      ...("result" in opts.stop ? { streamResult: opts.stop.result } : {}),
    });
    if ("reject" in opts.stop) {
      const err = opts.stop.reject;
      deps.runClaudeStreaming = (async () => { calls.claudeStreams += 1; throw err; }) as DispatchDeps["runClaudeStreaming"];
    }
    return { agent, item, client, deps, calls };
  }
  const commitOf = (calls: CallLog) => calls.spawn.find(c => c.cmd === "git" && c.args[0] === "commit");
  const pushOf = (calls: CallLog) => calls.spawn.find(c => c.cmd === "git" && c.args[0] === "push");

  test("timeout through the reject door, PR + dirty tree → commit, push, comment, then park as before", async () => {
    const { agent, item, client, deps, calls } = stoppedRun({
      issue: 1430,
      stop: { reject: new AgentRunStoppedError("Agent timed out after 2280s", "timeout") },
      exec: { "gh pr list --head": () => PR_JSON, "git status --porcelain": () => " M docs/knowledge/features/development-verification.md\n" },
    });

    await dispatchToAgent(agent, item, client, deps);

    const commit = commitOf(calls);
    assert.ok(commit, "the dirty tree is committed");
    assert.equal(commit!.args[2], "wip(documentation): partial work from a timed-out run (#1430)");
    assert.ok(calls.exec.some(c => c.cmd === "git add -A"));
    assert.deepEqual(pushOf(calls)?.args, ["push", "-u", "origin", "feature/1430"]);
    const saved = client.comments.findIndex(c => /Partial work saved/.test(c.body));
    const parked = client.comments.findIndex(c => /Agent Error: documentation/.test(c.body));
    assert.ok(saved >= 0, "the ticket says the work was pushed");
    assert.match(client.comments[saved]!.body, /PR #1431/);
    assert.match(client.comments[saved]!.body, /next documentation run on this ticket continues from it/);
    assert.ok(parked > saved, "the original error still parks, after the salvage comment");
    assert.ok(client.addLabelCalls.some(c => c.label === "error:documentation"), "a timeout still parks under error:<agent>");
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:max_turns_salvaged"));
    assert.ok(cleanupRan(calls.exec), "teardown runs after a successful push");
  });

  for (const door of ["reject", "result"] as const) {
    test(`idle stall through the ${door} door → salvage, then the transient retry still runs`, async () => {
      const stop = door === "reject"
        ? { reject: new AgentRunStoppedError(idleStallMessage(600_000), "idle_stall") }
        : { result: streamResult({ isError: true, terminalReason: "idle_stall", output: "Now update the catalog." }) };
      const { agent, item, client, deps, calls } = stoppedRun({
        issue: 1431,
        stop,
        exec: { "gh pr list --head": () => PR_JSON, "git status --porcelain": () => "?? docs/new-child.md\n" },
      });

      await dispatchToAgent(agent, item, client, deps);

      assert.equal(commitOf(calls)?.args[2], "wip(documentation): partial work from a stalled run (#1431)");
      assert.ok(pushOf(calls), "pushed to the existing branch");
      assert.ok(client.comments.some(c => /Partial work saved/.test(c.body) && /stalled/.test(c.body)));
      assert.ok(client.comments.some(c => /Auto-retry scheduled/.test(c.body)), "the stall is still retried as transient");
      assert.ok(!client.addLabelCalls.some(c => c.label === "error:documentation"), "no park on a transient stall");
    });
  }

  test("timeout through the result door with a PR → the draft-PR salvage stands aside, the partial salvage pushes", async () => {
    const { agent, item, client, deps, calls } = stoppedRun({
      issue: 1332,
      agent: { name: "developer" },
      stop: { result: streamResult({ isError: true, terminalReason: "", timedOut: true, sessionId: "" }) },
      exec: { "gh pr list --head": () => PR_JSON, "git status --porcelain": () => " M src/a.go\n" },
    });

    await dispatchToAgent(agent, item, client, deps);

    assert.ok(!calls.spawn.some(c => c.cmd === "gh" && c.args.includes("create")), "no second PR is attempted");
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:max_turns_salvaged"));
    assert.equal(commitOf(calls)?.args[2], "wip(developer): partial work from a timed-out run (#1332)");
    assert.ok(pushOf(calls));
    assert.ok(client.addLabelCalls.some(c => c.label === "error:developer"));
  });

  test("clean tree with local commits origin lacks → pushes without a new commit", async () => {
    const { agent, item, client, deps, calls } = stoppedRun({
      issue: 1433,
      stop: { reject: new AgentRunStoppedError("Agent timed out after 2280s", "timeout") },
      exec: { "gh pr list --head": () => PR_JSON, "git status --porcelain": () => "", "git rev-list --count origin/feature/1433..HEAD": () => "2\n" },
    });

    await dispatchToAgent(agent, item, client, deps);

    assert.equal(commitOf(calls), undefined);
    assert.ok(pushOf(calls));
    assert.ok(client.comments.some(c => /found local commits origin did not have/.test(c.body)));
  });

  for (const reviewer of ["verifier", "code-review", "qa"]) {
    test(`skipped for a reviewer stage (${reviewer})`, async () => {
      const { agent, item, client, deps, calls } = stoppedRun({
        issue: 1434,
        agent: { name: reviewer, column: "In Code Review", claudeMdPath: `${reviewer}/CLAUDE.md`, producesCommits: false },
        stop: { reject: new AgentRunStoppedError("Agent timed out after 2400s", "timeout") },
        exec: { "gh pr list --head": () => PR_JSON, "git status --porcelain": () => " M src/a.go\n" },
      });

      await dispatchToAgent(agent, item, client, deps);

      assert.equal(commitOf(calls), undefined);
      assert.equal(pushOf(calls), undefined);
      assert.ok(!calls.exec.some(c => c.cmd.includes("gh pr list")), "a reviewer stage is not even probed");
      assert.ok(!client.comments.some(c => /Partial work/.test(c.body)));
      assert.ok(client.addLabelCalls.some(c => c.label === `error:${reviewer}`));
    });
  }

  test("skipped with MERGE_HEAD present: a half-finished merge is never pushed", async () => {
    const { agent, item, client, deps, calls } = stoppedRun({
      issue: 1435,
      agent: { name: "developer" },
      stop: { reject: new AgentRunStoppedError("Agent timed out after 1500s", "timeout") },
      exec: { "gh pr list --head": () => PR_JSON, "git status --porcelain": () => "UU src/a.go\n", "git rev-parse -q --verify MERGE_HEAD": () => "mainsha\n" },
    });

    await dispatchToAgent(agent, item, client, deps);

    assert.ok(!calls.exec.some(c => c.cmd === "git add -A"));
    assert.equal(commitOf(calls), undefined);
    assert.equal(pushOf(calls), undefined);
    assert.ok(calls.logs.some(l => l.section === "PARTIAL_SALVAGE_SKIPPED" && /MERGE_HEAD/.test(l.content)));
  });

  test("a merge handed to the run must pass the merge check", async () => {
    // Committed merge (no MERGE_HEAD), but the file still has markers.
    const { ctx, client, calls } = makeTestContext({
      agent: { name: "developer" },
      item: { issueNumber: 1436 },
      mockOptions: {
        execImpls: {
          ...NO_MERGE,
          "gh pr list --head": () => PR_JSON,
          "git status --porcelain": () => " M src/Thread.kt\n",
          "git show HEAD:": () => "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n",
        },
      },
    });
    ctx.pendingMerge = { paths: ["src/Thread.kt"], mainSha: "mainsha", baseSha: "basesha", headSha: "headsha" };

    const res = await salvagePartialWork(ctx, "timeout");

    assert.deepEqual(res, { keepWorktree: false });
    assert.equal(commitOf(calls), undefined);
    assert.equal(pushOf(calls), undefined);
    assert.equal(client.comments.length, 0);
    assert.ok(calls.logs.some(l => l.section === "PARTIAL_SALVAGE_SKIPPED" && /conflict markers/.test(l.content)));
  });

  test("skipped when the worktree is clean and in sync with origin", async () => {
    const { agent, item, client, deps, calls } = stoppedRun({
      issue: 1437,
      stop: { reject: new AgentRunStoppedError("Agent timed out after 2280s", "timeout") },
      exec: { "gh pr list --head": () => PR_JSON, "git status --porcelain": () => "", "git rev-list --count origin/feature/1437..HEAD": () => "0\n" },
    });

    await dispatchToAgent(agent, item, client, deps);

    assert.equal(pushOf(calls), undefined);
    assert.ok(!client.comments.some(c => /Partial work/.test(c.body)));
    assert.ok(calls.logs.some(l => l.section === "PARTIAL_SALVAGE_SKIPPED" && /nothing to save/.test(l.content)));
  });

  test("skipped when the branch has no PR (the draft-PR salvage owns that case)", async () => {
    const { agent, item, client, deps, calls } = stoppedRun({
      issue: 1438,
      stop: { reject: new AgentRunStoppedError("Agent timed out after 2280s", "timeout") },
      exec: { "gh pr list --head": () => "[]", "git status --porcelain": () => " M a.md\n" },
    });

    await dispatchToAgent(agent, item, client, deps);

    assert.equal(pushOf(calls), undefined);
    assert.ok(calls.logs.some(l => l.section === "PARTIAL_SALVAGE_SKIPPED" && /no open pull request/.test(l.content)));
  });

  test("push failure → comment names the kept worktree, and the teardown is skipped", async () => {
    const { agent, item, client, deps, calls } = stoppedRun({
      issue: 1439,
      stop: { reject: new AgentRunStoppedError("Agent timed out after 2280s", "timeout") },
      exec: { "gh pr list --head": () => PR_JSON, "git status --porcelain": () => " M a.md\n" },
      spawn: { "git push": () => ({ status: 1, stderr: "! [rejected] non-fast-forward" }) },
    });

    await dispatchToAgent(agent, item, client, deps);

    assert.ok(commitOf(calls), "committed locally first");
    const note = client.comments.find(c => /Partial work not pushed/.test(c.body));
    assert.ok(note, "the ticket says the push failed");
    assert.match(note!.body, /kept worktree at `[^`]*documentation-1439`/);
    assert.ok(calls.logs.some(l => l.section === "PARTIAL_SALVAGE_PUSH_FAILED" && /non-fast-forward/.test(l.content)));
    assert.ok(client.addLabelCalls.some(c => c.label === "error:documentation"), "the error path still runs");
    assert.ok(!cleanupRan(calls.exec), "the worktree holding the only copy is not torn down");
  });
});
