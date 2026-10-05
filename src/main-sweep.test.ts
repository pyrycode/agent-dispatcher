import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  DEFAULT_MAIN_SWEEP_EVERY,
  DEFAULT_MAIN_SWEEP_TIMEOUT_MS,
  buildMainSweepIssue,
  buildMainSweepUpdateComment,
  decideMainSweep,
  holdVerifiersDuringSweep,
  parseMainSweepState,
  resolveMainSweepConfig,
  shouldCommentSweepFailures,
  tailLines,
  type MainSweepConfig,
  type MainSweepOutcome,
} from "./main-sweep.js";
import {
  runMainSweep,
  runMainSweepCycle,
  startMainSweepCycle,
  type GateRunnerDeps,
  type GateSpawnRequest,
  type MainSweepClient,
} from "./dispatch.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function outcome(over: Partial<MainSweepOutcome> = {}): MainSweepOutcome {
  return {
    passed: false, exitCode: 1, timedOut: false, runError: null, failedNames: [],
    stdoutPath: "/logs/out.log", stderrPath: "/logs/err.log", stderrTail: "", durationMs: 349_000, ...over,
  };
}

describe("main sweep config", () => {
  test("off unless a command is set", () => {
    assert.equal(resolveMainSweepConfig({}), null);
    assert.equal(resolveMainSweepConfig({ PYRY_MAIN_SWEEP_CMD: "   " }), null);
  });

  test("defaults and overrides", () => {
    assert.deepEqual(resolveMainSweepConfig({ PYRY_MAIN_SWEEP_CMD: " make deep " }), {
      command: "make deep", every: DEFAULT_MAIN_SWEEP_EVERY, timeoutMs: DEFAULT_MAIN_SWEEP_TIMEOUT_MS, format: null,
    });
    assert.deepEqual(resolveMainSweepConfig({
      PYRY_MAIN_SWEEP_CMD: "x", PYRY_MAIN_SWEEP_EVERY: "3", PYRY_MAIN_SWEEP_TIMEOUT_MS: "900000",
      PYRY_MAIN_SWEEP_FORMAT: "junit-xml",
    }), { command: "x", every: 3, timeoutMs: 900_000, format: "junit-xml" });
  });

  test("bad numbers and formats fall back instead of disabling the sweep", () => {
    assert.deepEqual(resolveMainSweepConfig({
      PYRY_MAIN_SWEEP_CMD: "x", PYRY_MAIN_SWEEP_EVERY: "0", PYRY_MAIN_SWEEP_TIMEOUT_MS: "soon",
      PYRY_MAIN_SWEEP_FORMAT: "tap",
    }), { command: "x", every: DEFAULT_MAIN_SWEEP_EVERY, timeoutMs: DEFAULT_MAIN_SWEEP_TIMEOUT_MS, format: null });
  });
});

describe("main sweep state file", () => {
  test("missing or damaged reads as empty", () => {
    const empty = { lastSha: null, lastGoodSha: null, openIssue: null, failures: null, reportedNames: null };
    assert.deepEqual(parseMainSweepState(null), empty);
    assert.deepEqual(parseMainSweepState("{not json"), empty);
    assert.deepEqual(parseMainSweepState(JSON.stringify({ lastSha: "; rm -rf /", openIssue: -3 })), empty);
  });

  test("round-trips valid fields", () => {
    const state = {
      lastSha: A, lastGoodSha: B, openIssue: 944,
      failures: { sha: A, names: ["p.C#a"] }, reportedNames: ["p.C#a", "p.C#b"],
    };
    assert.deepEqual(parseMainSweepState(JSON.stringify(state)), state);
  });

  test("a file from before the failure fields reads with none recorded", () => {
    assert.deepEqual(parseMainSweepState(JSON.stringify({ lastSha: A, lastGoodSha: B, openIssue: 1046 })), {
      lastSha: A, lastGoodSha: B, openIssue: 1046, failures: null, reportedNames: null,
    });
  });

  test("failures without a usable commit are dropped, so no sweep stands as a baseline", () => {
    for (const failures of [{ names: ["p.C#a"] }, { sha: "main", names: ["p.C#a"] }, { sha: A, names: "p.C#a" }]) {
      assert.equal(parseMainSweepState(JSON.stringify({ lastSha: A, failures })).failures, null);
    }
  });
});

describe("main sweep decision", () => {
  const base = { head: B, lastSha: A, mergesSince: 1, every: 5, idle: false, verifierBusy: false };

  test("never beside a verifier, never twice on the same commit", () => {
    assert.equal(decideMainSweep({ ...base, idle: true, verifierBusy: true }).run, false);
    assert.equal(decideMainSweep({ ...base, idle: true, head: A }).run, false);
    assert.equal(decideMainSweep({ ...base, idle: true, head: null }).run, false);
  });

  test("idle runs as soon as main has moved, even after one merge", () => {
    assert.equal(decideMainSweep({ ...base, idle: true }).run, true);
  });

  test("a busy board waits for the merge count", () => {
    assert.equal(decideMainSweep({ ...base, mergesSince: 4 }).run, false);
    assert.equal(decideMainSweep({ ...base, mergesSince: 5 }).run, true);
    assert.equal(decideMainSweep({ ...base, mergesSince: null }).run, true);
  });

  test("the first sweep waits for an idle cycle", () => {
    assert.equal(decideMainSweep({ ...base, lastSha: null, mergesSince: null }).run, false);
    assert.equal(decideMainSweep({ ...base, lastSha: null, mergesSince: null, idle: true }).run, true);
  });
});

describe("main sweep ticket", () => {
  test("names the failing tests and the merge range", () => {
    const { title, body } = buildMainSweepIssue({
      repo: "pyrycode/pyrycode-mobile",
      head: C,
      lastGoodSha: A,
      mergeSubjects: ["Merge pull request #939 from pyrycode/x", "Merge pull request #940 from pyrycode/y"],
      command: "UI_DEVICE_ALL=1 python3 scripts/android-test-gate.py ui",
      outcome: outcome({ failedNames: ["de.pyryco.mobile.ui.FooTest.bar"], stderrTail: "FAILED\n" }),
    });
    assert.equal(title, "In-depth test run failed on main at ccccccc");
    assert.match(body, /`de\.pyryco\.mobile\.ui\.FooTest\.bar`/);
    assert.match(body, /Merge pull request #939/);
    assert.match(body, new RegExp(`compare/${A}\\.\\.\\.${C}`));
    assert.match(body, /```\nFAILED\n```/);
  });

  test("says so when it could not run or has no good commit", () => {
    const { title, body } = buildMainSweepIssue({
      repo: "o/r", head: C, lastGoodSha: null, mergeSubjects: [], command: "x",
      outcome: outcome({ exitCode: null, runError: "could not create the sweep worktree: boom" }),
    });
    assert.equal(title, "In-depth test run could not run on main at ccccccc");
    assert.match(body, /No earlier sweep passed/);
    assert.match(body, /Run error: could not create the sweep worktree: boom/);
  });

  test("a failed sweep comments only a named failure set that differs from the one recorded", () => {
    assert.equal(shouldCommentSweepFailures(["p.C#a"], ["p.C#a"]), false, "same set");
    assert.equal(shouldCommentSweepFailures(["p.C#a", "p.C#b"], ["p.C#b", "p.C#a"]), false, "order does not matter");
    assert.equal(shouldCommentSweepFailures(["p.C#a"], ["p.C#a", "p.C#b"]), true, "a new failure");
    assert.equal(shouldCommentSweepFailures(["p.C#a", "p.C#b"], ["p.C#a"]), true, "a fixed failure");
    assert.equal(shouldCommentSweepFailures(null, ["p.C#a"]), true, "nothing recorded yet");
    assert.equal(shouldCommentSweepFailures(["p.C#a"], []), false, "a run that named nothing has no set");
  });

  test("the update comment lists the full set and what changed since the last record", () => {
    const body = buildMainSweepUpdateComment({
      head: C,
      reportedNames: ["p.C#a", "p.C#gone"],
      outcome: outcome({ failedNames: ["p.C#a", "p.C#new"] }),
    });
    assert.match(body, /## Main sweep failures changed/);
    assert.match(body, new RegExp(`failed again on \`${C}\`, with 2 failing test`));
    assert.match(body, /Newly failing: 1/);
    assert.match(body, /No longer failing: 1\n  - `p\.C#gone`/);
    assert.match(body, /- `p\.C#a`\n- `p\.C#new`/);
    const first = buildMainSweepUpdateComment({ head: C, reportedNames: null, outcome: outcome({ failedNames: ["p.C#a"] }) });
    assert.match(first, /No failure set was recorded on this ticket before/);
    assert.ok(!first.includes("Newly failing"));
  });

  test("tailLines keeps the end", () => {
    assert.equal(tailLines("1\n2\n3\n4", 2), "3\n4");
    assert.equal(tailLines("abcdef", 40, 3), "def");
  });
});

// ---------------------------------------------------------------------------
// Process half, through injected deps: no shell, no worktree, no suite.
// ---------------------------------------------------------------------------

function runnerDeps(over: {
  gitFail?: (cmd: string) => boolean;
  files?: Record<string, string>;
  spawn?: { exitCode: number | null; timedOut?: boolean; spawnError?: string | null };
} = {}) {
  const calls: string[] = [];
  const requests: GateSpawnRequest[] = [];
  const deps: Partial<GateRunnerDeps> = {
    execSync: ((cmd: string) => {
      calls.push(cmd);
      if (over.gitFail?.(cmd)) throw new Error(`boom: ${cmd}`);
      return Buffer.from("");
    }) as any,
    mkdirSync: (() => undefined) as any,
    readFileSync: ((path: string) => {
      const hit = Object.entries(over.files ?? {}).find(([suffix]) => path.endsWith(suffix));
      if (!hit) throw new Error("ENOENT");
      return hit[1];
    }) as any,
    now: () => 0,
    spawnGate: async (req: GateSpawnRequest) => {
      requests.push(req);
      return { exitCode: 0, timedOut: false, spawnError: null, ...over.spawn };
    },
  };
  return { deps, calls, requests };
}

const sweep = (h: ReturnType<typeof runnerDeps>, format: "junit-xml" | null = null) => runMainSweep({
  sha: C, command: "deep", format, timeoutMs: 60_000, repoRoot: "/tmp/repo", logsDir: "/tmp/logs", deps: h.deps,
});

describe("runMainSweep", () => {
  test("runs the command in a detached worktree of the commit and removes it after", async () => {
    const h = runnerDeps({ files: { ".stderr.log": "tail\n" } });
    const result = await sweep(h);
    assert.equal(result.passed, true);
    assert.equal(result.stderrTail, "tail\n");
    assert.ok(h.calls.some((c) => c.startsWith("git worktree add --detach") && c.endsWith(C)));
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].command, "deep");
    assert.match(h.requests[0].cwd, /\.pyrycode-worktrees\/[^/]+\/main-sweep$/);
    assert.ok(h.calls.at(-2)?.startsWith("git worktree remove "));
  });

  test("a non-zero exit, a timeout or a spawn error is a failure", async () => {
    assert.equal((await sweep(runnerDeps({ spawn: { exitCode: 1 } }))).passed, false);
    assert.equal((await sweep(runnerDeps({ spawn: { exitCode: null, timedOut: true } }))).passed, false);
    const spawnFailed = await sweep(runnerDeps({ spawn: { exitCode: null, spawnError: "ENOENT bash" } }));
    assert.equal(spawnFailed.passed, false);
    assert.equal(spawnFailed.runError, "ENOENT bash");
  });

  test("names failing tests when a format is configured", async () => {
    const xml = '<testsuite tests="2"><testcase classname="a.B" name="ok"/>' +
      '<testcase classname="a.B" name="bad"><failure/></testcase></testsuite>';
    const result = await sweep(runnerDeps({ spawn: { exitCode: 1 }, files: { "_main-sweep_ccccccc.log": xml } }), "junit-xml");
    assert.equal(result.failedNames.length, 1);
    assert.match(result.failedNames[0], /bad/);
  });

  test("a worktree that cannot be created is a run error, and nothing is spawned", async () => {
    const h = runnerDeps({ gitFail: (c) => c.startsWith("git worktree add") });
    const result = await sweep(h);
    assert.equal(result.passed, false);
    assert.match(result.runError ?? "", /could not create the sweep worktree/);
    assert.equal(h.requests.length, 0);
  });
});

describe("runMainSweepCycle", () => {
  const config: MainSweepConfig = { command: "deep", every: 5, timeoutMs: 60_000, format: null };

  function harness(opts: {
    state?: object | null;
    head?: string;
    merges?: string;
    issueState?: string;
    result?: MainSweepOutcome;
    createFails?: boolean;
    commentFails?: boolean;
  } = {}) {
    const written: string[] = [];
    const runs: string[] = [];
    const board: string[] = [];
    const comments: { issue: number; body: string }[] = [];
    const client: MainSweepClient = {
      addComment: async (issue, body) => {
        if (opts.commentFails) throw new Error("502");
        comments.push({ issue, body });
      },
      createIssue: async (title) => {
        if (opts.createFails) throw new Error("403");
        board.push(`create ${title}`);
        return { number: 950, nodeId: "N", url: "u" };
      },
      addItemToProject: async () => { board.push("add"); return "ITEM"; },
      updateItemStatus: async (_id, status) => { board.push(`status ${status}`); },
    };
    const execSync = ((cmd: string) => {
      if (cmd === "git rev-parse origin/main") return Buffer.from(opts.head ?? C);
      if (cmd.startsWith("git rev-list --count --merges")) return Buffer.from(opts.merges ?? "1");
      if (cmd.startsWith("gh issue view")) return Buffer.from(opts.issueState ?? "OPEN");
      if (cmd.startsWith("git log --merges")) return Buffer.from("Merge pull request #939 from x\n");
      throw new Error(`unexpected ${cmd}`);
    }) as any;
    const cycle = (idle: boolean, verifierBusy = false) => runMainSweepCycle({
      config, client, idle, verifierBusy, repo: "o/r", repoRoot: "/tmp/repo", defaultBranch: "main",
      deps: {
        execSync,
        readState: () => (opts.state === null || opts.state === undefined ? null : JSON.stringify(opts.state)),
        writeState: (json) => { written.push(json); },
        run: async (sha) => { runs.push(sha); return opts.result ?? outcome({ passed: true, exitCode: 0 }); },
      },
    });
    const lastState = () => JSON.parse(written.at(-1) ?? "null");
    // Starts a cycle whose run stays open until `release` is called.
    let release: (o: MainSweepOutcome) => void = () => {};
    const start = (idle: boolean) => startMainSweepCycle({
      config, client, idle, verifierBusy: false, repo: "o/r", repoRoot: "/tmp/repo", defaultBranch: "main",
      deps: {
        execSync,
        readState: () => (opts.state === null || opts.state === undefined ? null : JSON.stringify(opts.state)),
        writeState: (json) => { written.push(json); },
        run: (sha) => { runs.push(sha); return new Promise((r) => { release = r; }); },
      },
    });
    return { cycle, start, release: (o: MainSweepOutcome) => release(o), runs, board, comments, written, lastState };
  }

  test("off when not configured", async () => {
    const d = await runMainSweepCycle({ config: null, client: {} as any, idle: true, verifierBusy: false, repo: "o/r" });
    assert.deepEqual(d, { run: false, reason: "not configured" });
  });

  test("a pass records main as the last good commit and clears the open ticket", async () => {
    const h = harness({ state: { lastSha: A, lastGoodSha: A, openIssue: 944 } });
    const d = await h.cycle(true);
    assert.equal(d.run, true);
    assert.deepEqual(h.runs, [C]);
    assert.deepEqual(h.lastState(), {
      lastSha: C, lastGoodSha: C, openIssue: null, failures: { sha: C, names: [] }, reportedNames: null,
    });
    assert.deepEqual(h.board, []);
  });

  test("a busy board with too few merges does nothing", async () => {
    const h = harness({ state: { lastSha: A, lastGoodSha: A, openIssue: null }, merges: "4" });
    assert.equal((await h.cycle(false)).run, false);
    assert.deepEqual(h.runs, []);
    assert.deepEqual(h.written, []);
  });

  test("a running verifier holds the sweep back even when idle-looking", async () => {
    const h = harness({ state: { lastSha: A, lastGoodSha: A, openIssue: null }, merges: "9" });
    assert.equal((await h.cycle(true, true)).run, false);
    assert.deepEqual(h.runs, []);
  });

  test("a failure files one Backlog ticket and remembers it", async () => {
    const h = harness({ state: { lastSha: A, lastGoodSha: A, openIssue: null }, result: outcome({ failedNames: ["p.C#a"] }) });
    await h.cycle(true);
    assert.deepEqual(h.board, ["create In-depth test run failed on main at ccccccc", "add", "status Backlog"]);
    assert.deepEqual(h.lastState(), {
      lastSha: C, lastGoodSha: A, openIssue: 950, failures: { sha: C, names: ["p.C#a"] }, reportedNames: ["p.C#a"],
    });
    assert.deepEqual(h.comments, []);
  });

  test("a repeat failure files nothing while the earlier ticket is open", async () => {
    const h = harness({ state: { lastSha: A, lastGoodSha: A, openIssue: 950 }, result: outcome(), issueState: "OPEN" });
    await h.cycle(true);
    assert.deepEqual(h.board, []);
    assert.deepEqual(h.comments, [], "a failure that named no tests has no set to record");
    assert.deepEqual(h.lastState(), {
      lastSha: C, lastGoodSha: A, openIssue: 950, failures: { sha: C, names: [] }, reportedNames: null,
    });
  });

  test("a repeat failure with a changed set comments it on the open ticket and stores it", async () => {
    // pyrycode-mobile #1046 was filed for three failures on 2026-09-24 and
    // stayed open while the sweeps grew to 38; nothing named the new ones.
    const h = harness({
      state: { lastSha: A, lastGoodSha: A, openIssue: 1046, reportedNames: ["p.C#a"] },
      result: outcome({ failedNames: ["p.C#a", "p.C#b"] }),
      issueState: "OPEN",
    });
    await h.cycle(true);
    assert.deepEqual(h.board, [], "still no second ticket");
    assert.equal(h.comments.length, 1);
    assert.equal(h.comments[0]!.issue, 1046);
    assert.match(h.comments[0]!.body, /- `p\.C#b`/);
    assert.deepEqual(h.lastState().reportedNames, ["p.C#a", "p.C#b"]);
    assert.deepEqual(h.lastState().failures, { sha: C, names: ["p.C#a", "p.C#b"] });
  });

  test("a repeat failure with the same set posts nothing", async () => {
    const h = harness({
      state: { lastSha: A, lastGoodSha: A, openIssue: 1046, reportedNames: ["p.C#b", "p.C#a"] },
      result: outcome({ failedNames: ["p.C#a", "p.C#b"] }),
      issueState: "OPEN",
    });
    await h.cycle(true);
    assert.deepEqual(h.comments, []);
    assert.deepEqual(h.board, []);
    assert.deepEqual(h.lastState().reportedNames, ["p.C#b", "p.C#a"]);
  });

  test("a ticket filed before the set was stored gets the current set once", async () => {
    const h = harness({
      state: { lastSha: A, lastGoodSha: A, openIssue: 1046 },
      result: outcome({ failedNames: ["p.C#a"] }),
      issueState: "OPEN",
    });
    await h.cycle(true);
    assert.equal(h.comments.length, 1);
    assert.deepEqual(h.lastState().reportedNames, ["p.C#a"]);
  });

  test("a comment that fails leaves the stored set alone, so the next sweep tries again", async () => {
    const h = harness({
      state: { lastSha: A, lastGoodSha: A, openIssue: 1046, reportedNames: ["p.C#a"] },
      result: outcome({ failedNames: ["p.C#b"] }),
      issueState: "OPEN",
      commentFails: true,
    });
    await h.cycle(true);
    assert.deepEqual(h.lastState().reportedNames, ["p.C#a"]);
    assert.deepEqual(h.lastState().failures, { sha: C, names: ["p.C#b"] });
  });

  test("a sweep that could not run keeps the last recorded failures", async () => {
    const h = harness({
      state: { lastSha: A, lastGoodSha: B, openIssue: 1046, failures: { sha: A, names: ["p.C#a"] }, reportedNames: ["p.C#a"] },
      result: outcome({ exitCode: null, runError: "could not create the sweep worktree: boom" }),
      issueState: "OPEN",
    });
    await h.cycle(true);
    assert.deepEqual(h.lastState().failures, { sha: A, names: ["p.C#a"] });
    assert.deepEqual(h.comments, []);
  });

  test("a failure after the earlier ticket closed files a new one", async () => {
    const h = harness({ state: { lastSha: A, lastGoodSha: A, openIssue: 950 }, result: outcome(), issueState: "CLOSED" });
    await h.cycle(true);
    assert.equal(h.board[0], "create In-depth test run failed on main at ccccccc");
  });

  test("a board write that fails still records the sweep, so it does not rerun every cycle", async () => {
    const h = harness({ state: { lastSha: A, lastGoodSha: A, openIssue: null }, result: outcome(), createFails: true });
    await h.cycle(true);
    assert.deepEqual(h.lastState(), {
      lastSha: C, lastGoodSha: A, openIssue: null, failures: { sha: C, names: [] }, reportedNames: null,
    });
  });

  test("start returns while the sweep is still running, and records it when it ends", async () => {
    const h = harness({ state: { lastSha: A, lastGoodSha: A, openIssue: null } });
    const { decision, finished } = await h.start(true);
    assert.equal(decision.run, true);
    assert.notEqual(finished, null);
    assert.deepEqual(h.runs, [C]);
    assert.deepEqual(h.written, []);
    h.release(outcome({ passed: true, exitCode: 0 }));
    await finished;
    assert.deepEqual(h.lastState(), {
      lastSha: C, lastGoodSha: C, openIssue: null, failures: { sha: C, names: [] }, reportedNames: null,
    });
  });

  test("start hands back no run when the decision is not to sweep", async () => {
    const h = harness({ state: { lastSha: A, lastGoodSha: A, openIssue: null }, merges: "4" });
    const { decision, finished } = await h.start(false);
    assert.equal(decision.run, false);
    assert.equal(finished, null);
    assert.deepEqual(h.runs, []);
  });

  test("a run that throws still settles the sweep", async () => {
    const { finished } = await startMainSweepCycle({
      config, client: {} as any, idle: true, verifierBusy: false, repo: "o/r", repoRoot: "/tmp/repo", defaultBranch: "main",
      deps: {
        execSync: ((cmd: string) => cmd === "git rev-parse origin/main" ? Buffer.from(C) : Buffer.from("1")) as any,
        readState: () => JSON.stringify({ lastSha: A, lastGoodSha: A, openIssue: null }),
        writeState: () => {},
        run: async () => { throw new Error("boom"); },
      },
    });
    assert.notEqual(finished, null);
    await finished; // resolves, never rejects
  });
});

describe("holdVerifiersDuringSweep", () => {
  const c = (name: string) => ({ agent: { name }, item: { issueNumber: 1 } });

  test("drops verifiers while a sweep runs and keeps the other stages", () => {
    assert.deepEqual(
      holdVerifiersDuringSweep([c("builder"), c("verifier"), c("documentation")], true).map((x) => x.agent.name),
      ["builder", "documentation"],
    );
  });

  test("keeps everything when no sweep runs", () => {
    assert.equal(holdVerifiersDuringSweep([c("verifier")], false).length, 1);
  });
});
