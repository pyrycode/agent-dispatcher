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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupAfterDispatch,
  dispatchToAgent,
  handleAgentResultErrors,
  handleDispatchError,
  handlePostRun,
  makeDispatchContext,
  prepareAgentSpawn,
  runAutoMerge,
  runClosedSweep,
  runConcurrentDispatches,
  runDoneCleanup,
  runPreDispatchPrep,
  setupBranchAndWorktree,
  type DispatchClient,
  type DispatchContext,
  type DispatchDeps,
  type StreamResult,
} from "./dispatch.js";
import type { AgentConfig, BlockerInfo, ProjectItem } from "./types.js";
import { resolveAgentsRepoRoot, resolveTargetRepoRoot } from "./worktree.js";

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
};

function emptyCallLog(): CallLog {
  return {
    exec: [],
    spawn: [],
    fs: [],
    client: [],
    discord: [],
    claudeStreams: 0,
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
  comments: { issueNumber: number; body: string }[] = [];
  addLabelCalls: { issueNumber: number; label: string }[] = [];
  removeLabelCalls: { issueNumber: number; label: string }[] = [];
  getItemStatusCalls: { issueNumber: number; forceRefresh: boolean | undefined }[] = [];
  getIssueLabelsCalls: number[] = [];
  getItemsByStatusCalls: string[] = [];
  getClosedItemsNotInDoneCalls = 0;
  updateItemStatusCalls: { itemId: string; newStatus: string }[] = [];
  failures: {
    addLabel?: Error | ((issueNumber: number, label: string) => Error | null);
    removeLabel?: Error | ((issueNumber: number, label: string) => Error | null);
    addComment?: Error;
    getIssueLabels?: Error;
    getItemStatus?: Error;
    getItemsByStatus?: Error;
    getClosedItemsNotInDone?: Error;
    updateItemStatus?: Error | ((itemId: string, newStatus: string) => Error | null);
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
    this.comments.push({ issueNumber, body });
    if (this.failures.addComment) throw this.failures.addComment;
  }

  async getIssueLabels(issueNumber: number): Promise<string[]> {
    this.getIssueLabelsCalls.push(issueNumber);
    if (this.failures.getIssueLabels) throw this.failures.getIssueLabels;
    return [...(this.labelsByIssue.get(issueNumber) ?? [])];
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
}

// --------- Factories ---------

export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "developer",
    column: "In Development",
    claudeMdPath: "developer/CLAUDE.md",
    description: "Developer — implements Go code with tests",
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
// (PO/issue-0) path. Mock granularity is per-execSync-substring so a
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

  test("abort-local-ahead-of-origin → diverged commits + SHAs in comment, label, {ok:false}", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 155 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          // Both refs exist; SHAs differ; local is NOT an ancestor of
          // origin — the integrity-error path that surfaced in #155
          // (2026-05-07).
          "git rev-parse --verify feature/155": () => "",
          "git rev-parse --verify origin/feature/155": () => "",
          "git rev-parse origin/feature/155": () => "origin-sha-aaaaaaaa\n",
          "git rev-parse feature/155": () => "local-sha-bbbbbbbb\n",
          "git merge-base --is-ancestor": () => execError({ stderr: "" }),
          // The diverged-commits log capture.
          "git log --oneline -n 30": () => "bbbbbbbb local-only commit\n",
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 155, label: "error:developer" }]);
    assert.equal(client.comments.length, 1);
    const body = client.comments[0]!.body;
    assert.match(body, /commits not present on origin/);
    // The diverged-commits + SHA blocks both surface in the comment.
    assert.match(body, /local-sha-bbbbbbbb/);
    assert.match(body, /origin-sha-aaaaaaaa/);
    assert.match(body, /Diverged commits/);
    assert.match(body, /bbbbbbbb local-only commit/);
    // No worktree creation should follow an integrity-error abort.
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
          "git merge main --no-edit": () => execError({ stderr: "CONFLICT (content): Merge conflict in foo.go" }),
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
    //   2. `git worktree remove --force` runs AFTER `git worktree add`
    assert.ok(
      calls.exec.some(c => c.cmd.includes("git merge --abort")),
      "merge-conflict path must call `git merge --abort`",
    );
    const addIdx = calls.exec.findIndex(c => c.cmd.includes("git worktree add"));
    const removeAfterAdd = calls.exec.slice(addIdx + 1).some(c => c.cmd.includes("git worktree remove --force"));
    assert.ok(removeAfterAdd, "merge-conflict path must clean up its own worktree after creating it");
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
      c.cmd.includes(`git worktree remove --force "${orphanPath}"`),
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
      calls.exec.some(c => c.cmd.includes("git worktree remove --force")),
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
    assert.equal(config.maxTurns, 70, "developer base budget post-2026-05-03 is 70");
    assert.equal(config.cwd, ctx.agentCwd);
    assert.equal(config.timeoutMs, 1_500_000, "developer = 25min");
    // baseTools without Agent (developer doesn't sub-dispatch).
    assert.ok(config.allowedTools.includes("Bash,Read,Write,Edit"));
    assert.ok(config.allowedTools.includes("mcp__codegraph__"));
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

  test("agent-specific tools / turns / timeout", async () => {
    // Parametric across agents. Asserts:
    //   - architect + code-review get the `,Agent` tool suffix
    //   - code-review = 100 turns + 40min, developer/docs = 70 turns + 25min,
    //     others (architect, po) = 70 turns + 20min
    // Field names mirror AgentConfig (`name`, not `agent`) so the
    // makeAgentConfig overrides actually apply — passing `{agent:...}`
    // would be silently dropped because AgentConfig has no such field.
    const cases: Array<Partial<AgentConfig> & {
      maxTurns: number; timeoutMs: number; hasAgentTool: boolean;
    }> = [
      { name: "architect",     column: "In Architecture",  claudeMdPath: "architect/CLAUDE.md",     usesWorktree: true,  producesCommits: true,  maxTurns: 70,  timeoutMs: 1_200_000, hasAgentTool: true },
      { name: "developer",     column: "In Development",   claudeMdPath: "developer/CLAUDE.md",     usesWorktree: true,  producesCommits: true,  maxTurns: 70,  timeoutMs: 1_500_000, hasAgentTool: false },
      { name: "code-review",   column: "In Code Review",   claudeMdPath: "code-review/CLAUDE.md",   usesWorktree: true,  producesCommits: false, maxTurns: 100, timeoutMs: 2_400_000, hasAgentTool: true },
      { name: "documentation", column: "In Documentation", claudeMdPath: "documentation/CLAUDE.md", usesWorktree: true,  producesCommits: true,  maxTurns: 70,  timeoutMs: 1_500_000, hasAgentTool: false },
      { name: "po",            column: "Backlog",          claudeMdPath: "po/CLAUDE.md",            usesWorktree: false, producesCommits: false, maxTurns: 70,  timeoutMs: 1_200_000, hasAgentTool: false },
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
    }
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
    ...overrides,
  };
}

describe("handleAgentResultErrors", () => {
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
        streamResult({ isError: true, terminalReason: "api_error", output: "Anthropic 529" }),
        ctx,
      ),
      /Agent error \(api_error\)/,
    );
    // Sanity: neither salvage path was probed (gh pr list runs only
    // for max_turns; same for safer-salvage).
    assert.equal(calls.exec.filter(c => c.cmd.includes("gh pr list")).length, 0);
    assert.equal(calls.exec.filter(c => c.cmd.includes("git status")).length, 0);
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
    // ready:code-review + auto-advance.
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
    // Crucially: no `ready:developer` was applied. Push success is the
    // precondition for treating the agent's verdict as canonical.
    assert.ok(!client.addLabelCalls.some(c => c.label === "ready:developer"));
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
    assert.ok(!client.addLabelCalls.some(c => c.label === "ready:developer"));
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
    assert.ok(!client.addLabelCalls.some(c => c.label === "ready:developer"));
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
    // (decidePostRunLabels won't add ready:architect either, because
    // postLabels has needs-rework:po — that's tested in lib.test.ts.)
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
    // Code-review still gets ready:code-review (the agent's column hasn't moved).
    assert.ok(client.addLabelCalls.some(c => c.label === "ready:code-review"));
  });
});

describe("handlePostRun — decidePostRunLabels integration", () => {
  test("addReadyLabel=true (happy path) → ready:<agent> + completion comment + success Discord notify", async () => {
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
    assert.ok(client.addLabelCalls.some(c => c.label === "ready:developer"));
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /completed work on this ticket/);
    assert.match(client.comments[0]!.body, /Ready for human review/);
    // Success Discord notify (one message, "✅" prefix).
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /^✅/);
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
    // No `ready:developer` (rework target wins per shouldAddReadyLabel).
    assert.ok(!client.addLabelCalls.some(c => c.label === "ready:developer"));
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /rework by \*\*po\*\*/);
    assert.match(client.comments[0]!.body, /Needs rework by po/);
    // Success notify still fires (it's gated on !saferSalvaged, not rework).
    // But content describes rework, not success — that's a side-effect of
    // the existing dispatch.ts wiring; just assert one notify happened.
    assert.equal(calls.discord.length, 1);
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
    assert.ok(!client.addLabelCalls.some(c => c.label === "ready:po"),
      "moved-out path must not apply ready:<agent>");
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
    // Cautious default: skip ready:<agent> when we can't confirm the column.
    assert.ok(!client.addLabelCalls.some(c => c.label === "ready:developer"));
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
    assert.ok(!client.addLabelCalls.some(c => c.label === "ready:developer"),
      "salvage path must not apply ready:<agent>");
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
});

// =====================================================================
// cleanupAfterDispatch
// =====================================================================
//
// 3 tests: useWorktree=true (full cleanup), useWorktree=false (return
// to main only), worktree-remove failure tolerated.

describe("cleanupAfterDispatch", () => {
  test("useWorktree=true → git worktree remove --force + checkout -- . + clean -fd", async () => {
    const { ctx, calls } = makeTestContext({ item: { issueNumber: 600 } });

    await cleanupAfterDispatch(ctx);

    const cmds = calls.exec.map(c => c.cmd);
    assert.ok(
      cmds.some(c => c.includes("git worktree remove --force")),
      "must remove the worktree",
    );
    assert.ok(
      cmds.some(c => c === "git checkout -- ."),
      "must reset main repo's working tree (catches Claude Code's leaked .claude/worktrees/)",
    );
    assert.ok(
      cmds.some(c => c.startsWith("git clean -fd")),
      "must clean untracked files in the main repo (with logs/node_modules excluded)",
    );
    // useWorktree=true → no `git checkout main` (which is the no-worktree path).
    assert.ok(!cmds.includes("git checkout main"));
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
    // the error; cleanup proceeds to checkout/clean. The dispatcher
    // can't usefully recover from a stuck worktree mid-cleanup, so
    // it logs and moves on.
    const { ctx } = makeTestContext({
      item: { issueNumber: 602 },
      mockOptions: {
        execImpls: {
          "git worktree remove --force": () => execError({ stderr: "fatal: '<path>' is locked" }),
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

/** Distinguishing marker: cleanup ran iff calls.exec contains `git checkout -- .` */
function cleanupRan(execCalls: { cmd: string }[]): boolean {
  return execCalls.some(c => c.cmd === "git checkout -- .");
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

describe("dispatchToAgent — orchestrator integration", () => {
  test("happy-path full run → setup + spawn + stream + post-run all green; ready:<agent> + cleanup runs", async () => {
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

    // ready:developer applied (post-success labeling).
    assert.ok(client.addLabelCalls.some(c => c.label === "ready:developer"));
    // No error labels.
    assert.ok(!client.addLabelCalls.some(c => c.label.startsWith("error:")));
    // Cleanup ran (the marker command).
    assert.ok(cleanupRan(calls.exec), "happy path must run cleanupAfterDispatch");
    // Streaming was invoked exactly once.
    assert.equal(calls.claudeStreams, 1);
    // Success Discord notify.
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /^✅/);
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
      streamResult: streamResult({ isError: true, terminalReason: "api_error", output: "Anthropic 529" }),
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
    // ready:<agent> + success comment + success Discord →
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
    // No ready:<agent> (suppressed by saferSalvaged=true).
    assert.ok(!client.addLabelCalls.some(c => c.label === "ready:developer"));
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
    // distinguishing marker (`git checkout -- .`) does NOT fire.
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
    assert.ok(calls.exec.some(c => c.cmd.includes("git worktree remove --force")));
    // But the orchestrator's full cleanup did NOT run — its marker is
    // `git checkout -- .` which lives only in cleanupAfterDispatch.
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
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 800 && c.label === "ready:developer"));
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 801 && c.label === "ready:developer"));
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
    // Discord notify fired twice (success per dispatch).
    assert.equal(calls.discord.length, 2);
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
    // 802 got error:developer (push failed); NO ready:developer.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 802 && c.label === "error:developer"));
    assert.ok(!client.addLabelCalls.some(c => c.issueNumber === 802 && c.label === "ready:developer"));
    // 803 got ready:developer (happy path); NO error:developer.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 803 && c.label === "ready:developer"));
    assert.ok(!client.addLabelCalls.some(c => c.issueNumber === 803 && c.label === "error:developer"));

    // Cleanup-skip is per-dispatch: 803's worktree was cleaned up
    // (cleanup ran), 802's was preserved. The orchestrator's cleanup
    // marker is `git checkout -- .` — it should appear at least once
    // (for 803), not twice. (Each dispatchToAgent that runs cleanup
    // emits this exactly once.)
    const cleanupMarkerCount = calls.exec.filter(c => c.cmd === "git checkout -- .").length;
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
      // Per-dispatch stream resolution via opts.cwd: 804 returns
      // api_error, 805 returns timeout. Both should hit the
      // non-max_turns throw path independently.
      streamResult: (opts) => {
        if (opts?.cwd?.includes("developer-804")) {
          return streamResult({ isError: true, terminalReason: "api_error", output: "Anthropic 529" });
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
    const cleanupMarkerCount = calls.exec.filter(c => c.cmd === "git checkout -- .").length;
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
    // agent name (ready:architect on 806, ready:developer on 807).
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
    // ready:<agent> prefix matching the dispatching agent's name.
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 806 && c.label === "ready:architect"));
    assert.ok(client.addLabelCalls.some(c => c.issueNumber === 807 && c.label === "ready:developer"));
    // No cross-pollination: 806 didn't get ready:developer, 807 didn't get ready:architect.
    assert.ok(!client.addLabelCalls.some(c => c.issueNumber === 806 && c.label === "ready:developer"));
    assert.ok(!client.addLabelCalls.some(c => c.issueNumber === 807 && c.label === "ready:architect"));

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
    // Two Done items with stale ready:* labels accumulated from the pipeline run.
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 900, status: "Done", labels: ["ready:documentation", "size:s"], state: "OPEN" },
        { issueNumber: 901, status: "Done", labels: ["ready:po", "ready:architect", "ready:developer", "ready:code-review", "ready:documentation"], state: "OPEN" },
      ],
    });

    await runDoneCleanup(client);

    // Item 900: only ready:documentation stripped; size:s preserved
    // (decideDoneCleanup leaves size labels alone).
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 900 && c.label === "ready:documentation"));
    assert.ok(!client.removeLabelCalls.some(c => c.issueNumber === 900 && c.label === "size:s"));

    // Item 901: all five ready:* stripped.
    const stripped901 = client.removeLabelCalls.filter(c => c.issueNumber === 901).map(c => c.label);
    assert.ok(stripped901.includes("ready:po"));
    assert.ok(stripped901.includes("ready:architect"));
    assert.ok(stripped901.includes("ready:developer"));
    assert.ok(stripped901.includes("ready:code-review"));
    assert.ok(stripped901.includes("ready:documentation"));
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
        { issueNumber: 909_001, status: "Done", labels: ["ready:developer"], state: "OPEN" },
      ],
    });
    client.failures.removeLabel = new Error("renamed label, REST 404");

    // Two cycles in a row. Both call removeLabel (the dedup is on the
    // *warning log*, not the API call — the warning silencing prevents
    // log spam without changing behavior).
    await runDoneCleanup(client);
    await runDoneCleanup(client);

    // Both cycles attempted removal of the same label.
    const attempts = client.removeLabelCalls.filter(c => c.issueNumber === 909_001 && c.label === "ready:developer");
    assert.equal(attempts.length, 2, "removeLabel attempted on both cycles (warn-once doesn't suppress the call)");
    // The warn-once Set is module-level and only-observable via
    // console.warn; we can't assert it directly without exporting the
    // Set. The behavioral guarantee tested is "two cycles → two
    // removeLabel attempts that both fail without crashing the pass."
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
      labels: { 1000: ["ready:developer", "error:architect", "wip:po", "size:m", "needs-rework:code-review"] },
    });
    const item = makeProjectItem({ issueNumber: 1000, labels: client.labelsByIssue.get(1000)! });
    const agent = makeAgentConfig({});  // developer

    await runPreDispatchPrep([{ agent, item }], client);

    const stripped = client.removeLabelCalls.map(c => c.label);
    // Developer's own pipeline label stripped.
    assert.ok(stripped.includes("ready:developer"));
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
      labels: { 1002: ["ready:developer"], 1003: ["ready:architect"] },
    });
    const candidates = [
      { agent: makeAgentConfig({}), item: makeProjectItem({ issueNumber: 1002, labels: ["ready:developer"] }) },
      { agent: makeAgentConfig({ name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md" }), item: makeProjectItem({ issueNumber: 1003, labels: ["ready:architect"] }) },
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
        ? streamResult({ isError: true, terminalReason: "api_error", output: "anthropic 529" })
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
  test("happy path → gh pr merge succeeds, labels stripped, git pull, Discord notified", async () => {
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1200, status: "Done", labels: ["ready:documentation", "size:s"], state: "OPEN" },
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
    // Pipeline label stripped (ready:documentation is a pipeline label).
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1200 && c.label === "ready:documentation"));
    // Non-pipeline label (size:s) NOT stripped.
    assert.ok(!client.removeLabelCalls.some(c => c.label === "size:s"));
    // Discord notify (one 🔀 message for the merge).
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /^🔀 PR #789 merged for #1200/);
    // No error:merge-conflict label applied (this is a clean merge).
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:merge-conflict"));
  });

  test("merge conflict → error:merge-conflict label + triage comment + Discord notify + Status rolled back to In Code Review", async () => {
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1201", issueNumber: 1201, status: "Done", labels: ["ready:documentation"], state: "OPEN" },
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
    // isn't really done; labels stay until human resolves).
    assert.ok(!client.removeLabelCalls.some(c => c.issueNumber === 1201));
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
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1207", issueNumber: 1207, status: "Done", labels: ["ready:documentation"], state: "OPEN" },
        { id: "PVTI_1208", issueNumber: 1208, status: "Done", labels: ["ready:documentation"], state: "OPEN" },
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
        { id: "PVTI_1205", issueNumber: 1205, status: "Done", labels: ["ready:documentation"], state: "OPEN" },                  // would process if it had a PR
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
        { issueNumber: 1206, status: "Done", labels: ["ready:documentation"], state: "OPEN" },
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
        { issueNumber: 1300, status: "Done", labels: ["ready:documentation"], state: "OPEN" },
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
    // Standard merge path still completed (label cleanup + Discord).
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1300 && c.label === "ready:documentation"));
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /^🔀 PR #800 merged/);
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
        { issueNumber: 1301, status: "Done", labels: ["ready:documentation"], state: "OPEN" },
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
    // Standard merge path still completed.
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1301));
    assert.equal(calls.discord.length, 1);
  });

  test("codegraph reindex failure is non-fatal — labels still cleaned, Discord still notified", async () => {
    // Codegraph isn't load-bearing. If `codegraph index -f` errors
    // (lock contention, disk full, transient binary issue), the
    // dispatcher must log a warning and continue — the merge already
    // happened on origin, the labels matter more than a temporarily
    // stale index. Same posture as the existing post-merge `git pull`
    // failure path (line 1858-1861).
    const client = new MockGitHubClient({
      items: [
        { issueNumber: 1302, status: "Done", labels: ["ready:documentation"], state: "OPEN" },
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
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1302 && c.label === "ready:documentation"));
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /^🔀 PR #802 merged/);
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
        { issueNumber: 1400, status: "Done", labels: ["ready:documentation", "size:s"], state: "OPEN" },
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
    assert.ok(client.removeLabelCalls.some(c => c.issueNumber === 1400 && c.label === "ready:documentation"));
    assert.equal(calls.discord.length, 1);
    assert.match(calls.discord[0]!, /^🔀 PR #900 merged/);
    assert.ok(!client.addLabelCalls.some(c => c.label === "error:merge-conflict"));
  });

  test("pre-merge rebase conflict → label + comment + Status rollback applied, gh pr merge NEVER invoked", async () => {
    // When the rebase itself surfaces a conflict, the dispatcher must
    // short-circuit BEFORE the merge call — same load-bearing conflict
    // path as a merge-time conflict (label + triage comment + Discord +
    // Status rollback to In Code Review). The whole point of the rebase
    // step is to catch the conflict at this earlier seam; falling
    // through to attempt the merge would defeat it.
    const client = new MockGitHubClient({
      items: [
        { id: "PVTI_1401", issueNumber: 1401, status: "Done", labels: ["ready:documentation"], state: "OPEN" },
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
      },
    });

    await runAutoMerge(client, deps);

    // The merge call MUST NOT have been attempted.
    assert.ok(!calls.exec.some(c => c.cmd.includes("gh pr merge")),
      "rebase-time conflict must short-circuit before merge attempt");
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
        { issueNumber: 1402, status: "Done", labels: ["ready:documentation"], state: "OPEN" },
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
