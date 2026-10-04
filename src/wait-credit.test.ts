import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceGateWaitState,
  advanceRunClock,
  decideRunClock,
  DEFAULT_TIMEOUT_CEILING_FACTOR,
  DEFAULT_TIMEOUT_GRACE_MINUTES,
  finishedWaits,
  gateDeadline,
  gateWaitCreditMs,
  initGateWaitState,
  initRunClock,
  mergeIntervals,
  parseTimeoutCeilingFactor,
  parseTimeoutGraceMs,
  runClockCreditMs,
  runClockDeadline,
  unionLengthMs,
  type RunClock,
} from "./wait-credit.js";

const S = 1000;
const MIN = 60_000;
/** Epoch ms for a UTC wall-clock time on 2026-10-04. */
const at = (hms: string) => Date.parse(`2026-10-04T${hms}Z`);

// The queues' exact messages, as the product scripts print them.
const DEVICE_HELD = "Android gate: device held by live from /Users/j/.pyrycode-worktrees/pyrycode-mobile/real-claude-gate-1697 since 2026-10-04T04:06:01Z; waiting up to 600s";
const DEVICE_GAVE_UP = "Android gate: device busy, not a test result: gave up after 600s; held by live from /Users/j/.pyrycode-worktrees/pyrycode-mobile/real-claude-gate-1697 since 2026-10-04T04:06:01Z";
const deviceFree = (s: number) => `Android gate: device free after ${s}s waiting`;
const slotWaiting = (m: number) => `Pyrycode build slots: all 2 places are taken by other pipeline builds; waiting (${m} min so far).`;
const slotGot = (s: number) => `Pyrycode build slots: got a place after ${s} s.`;
const SLOT_GAVE_UP = "Pyrycode build slots: no place after 20 minutes; building without one.";

describe("wait messages — what the device hold and build places print", () => {
  test("reads every finished wait, in seconds or minutes", () => {
    assert.deepEqual(finishedWaits([
      "> Task :app:compileDebugKotlin",
      deviceFree(170),
      DEVICE_GAVE_UP,
      slotGot(37),
      SLOT_GAVE_UP,
      "BUILD SUCCESSFUL in 22s",
    ].join("\n")).map((w) => [w.queue, w.ms]), [
      ["device", 170 * S],
      ["device", 600 * S],
      ["slot", 37 * S],
      ["slot", 20 * MIN],
    ]);
  });

  test("a wait still in progress is not a finished wait", () => {
    assert.deepEqual(finishedWaits([DEVICE_HELD, slotWaiting(3)].join("\n")), []);
  });

  test("tolerates colour codes, carriage returns and indentation", () => {
    assert.equal(finishedWaits(`\x1b[1;34m${deviceFree(12)}\x1b[0m\r\n  ${slotGot(5)}\r\n`).length, 2);
  });

  test("a search hit on the scripts' own source never counts", () => {
    const rg = [
      'scripts/android-test-gate.py:327:            print(f"Android gate: device free after {time.monotonic() - start:.0f}s waiting", file=sys.stderr)',
      'gradle/pyry-build-slots.gradle:88: if (waited > 0) println "Pyrycode build slots: got a place after ${waited} s."',
      `logs/verifier-gate_#1646_6.stderr.log:12:${deviceFree(900)}`,
    ].join("\n");
    assert.deepEqual(finishedWaits(rg), []);
  });
});

describe("knobs fall back to safe defaults", () => {
  test("PYRY_TIMEOUT_CEILING_FACTOR: at least 1, default 2", () => {
    assert.equal(DEFAULT_TIMEOUT_CEILING_FACTOR, 2);
    for (const raw of [undefined, "", "  ", "abc", "NaN", "0", "0.5", "-3", "Infinity"]) {
      assert.equal(parseTimeoutCeilingFactor(raw), 2, String(raw));
    }
    assert.equal(parseTimeoutCeilingFactor("1"), 1);
    assert.equal(parseTimeoutCeilingFactor(" 1.5 "), 1.5);
    assert.equal(parseTimeoutCeilingFactor("3"), 3);
  });

  test("PYRY_TIMEOUT_GRACE_MINUTES: default 20, 0 or negative is off, fractions allowed", () => {
    assert.equal(DEFAULT_TIMEOUT_GRACE_MINUTES, 20);
    for (const raw of [undefined, "", "abc", "NaN"]) assert.equal(parseTimeoutGraceMs(raw), 20 * MIN, String(raw));
    assert.equal(parseTimeoutGraceMs("0"), 0);
    assert.equal(parseTimeoutGraceMs("-5"), 0);
    assert.equal(parseTimeoutGraceMs("2.5"), 150 * S);
  });
});

describe("intervals", () => {
  test("overlapping time counts once", () => {
    assert.deepEqual(mergeIntervals([[5, 9], [0, 3], [2, 4], [9, 10], [20, 20]]), [[0, 4], [5, 10]]);
    assert.equal(unionLengthMs([[0, 10], [5, 15], [30, 40]]), 25);
    assert.equal(unionLengthMs([]), 0);
  });
});

describe("dispatcher-run gates — the deadline follows live waiting", () => {
  const T0 = at("04:00:00");
  const BUDGET = 60 * MIN;

  test("a device wait in progress counts as it happens, up to its printed limit", () => {
    let s = initGateWaitState(T0);
    s = advanceGateWaitState(s, "Android gate: building pyry for the scripted run", T0 + 1 * MIN);
    s = advanceGateWaitState(s, "Android gate: device held by ui from /w/verifier-1722 since 2026-10-04T03:59:00Z; waiting up to 2700s", T0 + 2 * MIN);
    assert.equal(gateWaitCreditMs(s, T0 + 2 * MIN), 0);
    assert.equal(gateWaitCreditMs(s, T0 + 12 * MIN), 10 * MIN);
    // A gate that dies mid-wait without its final line stops at the limit.
    assert.equal(gateWaitCreditMs(s, T0 + 200 * MIN), 45 * MIN);
  });

  test("the final line replaces the open wait with the reported figure", () => {
    let s = initGateWaitState(T0);
    s = advanceGateWaitState(s, DEVICE_HELD, T0 + 5 * S);
    s = advanceGateWaitState(s, deviceFree(1500), T0 + 1505 * S);
    assert.equal(gateWaitCreditMs(s, T0 + 1505 * S), 1500 * S);
    assert.equal(gateWaitCreditMs(s, T0 + 90 * MIN), 1500 * S, "nothing more accrues once the hold is taken");
  });

  test("a gate that gives up on the device is credited the time it waited", () => {
    let s = initGateWaitState(T0);
    s = advanceGateWaitState(s, DEVICE_HELD, T0);
    s = advanceGateWaitState(s, DEVICE_GAVE_UP, T0 + 600 * S);
    assert.equal(gateWaitCreditMs(s, T0 + 30 * MIN), 600 * S);
  });

  test("build-place notes count while they keep coming, then stop on their own", () => {
    let s = initGateWaitState(T0);
    s = advanceGateWaitState(s, slotWaiting(0), T0 + 1 * MIN);
    s = advanceGateWaitState(s, slotWaiting(1), T0 + 2 * MIN);
    s = advanceGateWaitState(s, slotWaiting(2), T0 + 3 * MIN);
    assert.equal(gateWaitCreditMs(s, T0 + 3 * MIN + 30 * S), 2 * MIN + 30 * S);
    // The build was killed: no more notes, no final line.
    assert.equal(gateWaitCreditMs(s, T0 + 40 * MIN), 2 * MIN + 75 * S);
  });

  test("a build place taken, or given up on, closes the wait at the reported figure", () => {
    let s = initGateWaitState(T0);
    s = advanceGateWaitState(s, slotWaiting(0), T0);
    s = advanceGateWaitState(s, slotGot(95), T0 + 95 * S);
    s = advanceGateWaitState(s, slotWaiting(0), T0 + 10 * MIN);
    s = advanceGateWaitState(s, SLOT_GAVE_UP, T0 + 30 * MIN);
    assert.equal(gateWaitCreditMs(s, T0 + 50 * MIN), 95 * S + 20 * MIN);
  });

  test("a device wait and a build wait at the same time count once", () => {
    let s = initGateWaitState(T0);
    s = advanceGateWaitState(s, DEVICE_HELD, T0);
    s = advanceGateWaitState(s, slotWaiting(0), T0 + 1 * MIN);
    s = advanceGateWaitState(s, slotGot(120), T0 + 3 * MIN);
    s = advanceGateWaitState(s, deviceFree(300), T0 + 5 * MIN);
    assert.equal(gateWaitCreditMs(s, T0 + 6 * MIN), 5 * MIN);
  });

  test("a reported wait never reaches back before the gate started", () => {
    let s = initGateWaitState(T0);
    s = advanceGateWaitState(s, deviceFree(99999), T0 + 2 * MIN);
    assert.equal(gateWaitCreditMs(s, T0 + 2 * MIN), 2 * MIN);
  });

  test("the deadline moves by the credit, and the hard ceiling caps it", () => {
    let s = initGateWaitState(T0);
    assert.equal(gateDeadline(s, T0, BUDGET, 2).deadlineAt, T0 + BUDGET);
    // Mobile: a 45-minute device wait inside a 60-minute gate budget.
    s = advanceGateWaitState(s, "Android gate: device held by live from /w since x; waiting up to 2700s", T0 + 10 * MIN);
    s = advanceGateWaitState(s, deviceFree(2700), T0 + 55 * MIN);
    const d = gateDeadline(s, T0 + 70 * MIN, BUDGET, 2);
    assert.equal(d.creditMs, 45 * MIN);
    assert.equal(d.deadlineAt, T0 + 105 * MIN);
    assert.equal(d.ceilingAt, T0 + 120 * MIN);
    // Waits past what the ceiling allows are cut off at it.
    s = advanceGateWaitState(s, slotWaiting(0), T0 + 60 * MIN);
    for (let m = 61; m <= 100; m++) s = advanceGateWaitState(s, slotWaiting(m - 60), T0 + m * MIN);
    assert.equal(gateDeadline(s, T0 + 100 * MIN, BUDGET, 2).deadlineAt, T0 + 120 * MIN);
    // Factor 1 is the old fixed deadline.
    assert.equal(gateDeadline(s, T0 + 100 * MIN, BUDGET, 1).deadlineAt, T0 + BUDGET);
  });

  test("ordinary output changes nothing", () => {
    let s = initGateWaitState(T0);
    for (const line of ["> Task :app:lint", "BUILD SUCCESSFUL in 4m", "Android gate: 1 executed; process exit 0", ""]) {
      s = advanceGateWaitState(s, line, T0 + MIN);
    }
    assert.equal(gateWaitCreditMs(s, T0 + 30 * MIN), 0);
  });
});

// Codex events in the shape `codex exec --json` writes them.
const started = (id: string, command = "/bin/zsh -lc 'true'") =>
  ({ type: "item.started", item: { id, type: "command_execution", command, aggregated_output: "", exit_code: null, status: "in_progress" } });
const completed = (id: string, output = "", command = "/bin/zsh -lc 'true'") =>
  ({ type: "item.completed", item: { id, type: "command_execution", command, aggregated_output: output, exit_code: 0, status: "completed" } });

function replay(clock: RunClock, events: Array<[number, unknown]>): RunClock {
  for (const [time, event] of events) clock = advanceRunClock(clock, event, time);
  return clock;
}

describe("Codex runs — credit from completed command output", () => {
  test("mobile #1646, 2026-10-04: the device wait a builder tailed from a file is credited once", () => {
    // Its 70-minute builder started 03:16:55 UTC. At 04:07 it started two
    // device checks with their output redirected to files; both waited the
    // full 600 s for another ticket's live gate and gave up at 04:17:18.
    // Only a later `tail` showed the gave-up line. The run was killed at
    // 04:26:55 just after updating its PR, before it could report.
    const start = at("03:16:55");
    let clock = initRunClock({ startedAt: start, budgetMs: 70 * MIN, ceilingFactor: 2, graceMs: 20 * MIN });
    clock = replay(clock, [
      [at("04:07:00"), started("item_131", "python3 /tmp/builder-1646/run-device.py > /tmp/builder-1646/focus-device-retry.log 2>&1")],
      [at("04:07:00"), started("item_132", "python3 scripts/android-test-gate.py scripted stream > /tmp/builder-1646/stream.log 2>&1")],
      [at("04:09:33"), started("item_133")],
      [at("04:09:33"), completed("item_133", `${DEVICE_HELD}\n${DEVICE_HELD}\n`)],
      [at("04:13:29"), started("item_134")],
      [at("04:13:29"), completed("item_134", `${DEVICE_HELD}\n`)],
      [at("04:17:18"), completed("item_131", "")],
      [at("04:17:18"), completed("item_132", "")],
    ]);
    assert.equal(runClockCreditMs(clock), 0, "a wait still in progress earns nothing yet");
    clock = replay(clock, [
      [at("04:18:58"), started("item_137", "tail -10 /tmp/builder-1646/focus-device-retry.log && tail -10 /tmp/builder-1646/stream.log")],
      [at("04:18:58"), completed("item_137", `${DEVICE_HELD}\n${DEVICE_HELD}\n${DEVICE_GAVE_UP}\n`)],
    ]);
    // [04:08:58, 04:17:18]: the part of the 600 s before the sighting when
    // the waiting commands were running.
    assert.equal(runClockCreditMs(clock), 500 * S);
    assert.equal(runClockDeadline(clock), at("04:35:15"));
    assert.deepEqual(decideRunClock(clock, at("04:26:55")), { kind: "run", checkAt: at("04:35:15"), grace: false });
    // The agent tails the same log again: no second credit.
    clock = replay(clock, [[at("04:20:00"), started("item_150")], [at("04:20:00"), completed("item_150", DEVICE_GAVE_UP)]]);
    assert.equal(runClockCreditMs(clock), 500 * S);
  });

  test("a gate whose own output shows the wait is credited in full", () => {
    const start = at("09:40:09");
    let clock = initRunClock({ startedAt: start, budgetMs: 70 * MIN, ceilingFactor: 2, graceMs: 20 * MIN });
    clock = replay(clock, [
      [at("09:50:34"), started("item_36", "python3 scripts/android-test-gate.py scripted send-now 2>&1 | tail -40")],
      [at("10:12:00"), completed("item_36", [DEVICE_HELD, deviceFree(1080), "Android gate: scripted send-now; artifacts: /x", "Android gate: 1 executed; process exit 0"].join("\n"))],
    ]);
    assert.equal(runClockCreditMs(clock), 1080 * S);
  });

  test("several waits in one output add up, within the command's own running time", () => {
    const start = at("08:00:00");
    let clock = initRunClock({ startedAt: start, budgetMs: 70 * MIN, ceilingFactor: 2, graceMs: 20 * MIN });
    clock = replay(clock, [
      [at("08:10:00"), started("gradle")],
      [at("08:40:00"), completed("gradle", `${slotGot(300)}\n> Task :app:check\n${deviceFree(600)}`)],
    ]);
    assert.equal(runClockCreditMs(clock), 900 * S);
    // A claim longer than the command ran is cut to the command.
    clock = replay(clock, [[at("08:50:00"), started("short")], [at("08:52:00"), completed("short", SLOT_GAVE_UP)]]);
    assert.equal(runClockCreditMs(clock), 900 * S + 2 * MIN);
  });

  test("reading an old log with nothing else running earns nothing", () => {
    const start = at("08:00:00");
    let clock = initRunClock({ startedAt: start, budgetMs: 70 * MIN, ceilingFactor: 2, graceMs: 20 * MIN });
    clock = replay(clock, [[at("08:30:00"), started("cat")], [at("08:30:00"), completed("cat", deviceFree(1200))]]);
    assert.equal(runClockCreditMs(clock), 0);
  });

  test("two commands waiting side by side are credited the shared time once", () => {
    const start = at("08:00:00");
    let clock = initRunClock({ startedAt: start, budgetMs: 70 * MIN, ceilingFactor: 2, graceMs: 20 * MIN });
    clock = replay(clock, [
      [at("08:10:00"), started("a")],
      [at("08:10:00"), started("b")],
      [at("08:20:00"), completed("a", slotGot(600))],
      [at("08:20:00"), completed("b", slotGot(599))],
    ]);
    assert.equal(runClockCreditMs(clock), 600 * S);
  });

  test("tool calls and messages are not commands", () => {
    const start = at("08:00:00");
    let clock = initRunClock({ startedAt: start, budgetMs: 70 * MIN, ceilingFactor: 2, graceMs: 20 * MIN });
    clock = replay(clock, [
      [at("08:01:00"), { type: "item.started", item: { id: "m", type: "mcp_tool_call", server: "figma", tool: "get_screenshot", status: "in_progress" } }],
      [at("08:02:00"), { type: "item.completed", item: { id: "x", type: "agent_message", text: deviceFree(600) } }],
      [at("08:03:00"), { type: "turn.completed", usage: {} }],
    ]);
    assert.equal(clock.running.size, 0);
    assert.equal(runClockCreditMs(clock), 0);
  });
});

describe("Codex runs — deadline, grace and ceiling", () => {
  const T0 = at("03:00:00");
  const BUDGET = 70 * MIN;
  const fresh = (opts: Partial<{ ceilingFactor: number; graceMs: number }> = {}) =>
    initRunClock({ startedAt: T0, budgetMs: BUDGET, ceilingFactor: opts.ceilingFactor ?? 2, graceMs: opts.graceMs ?? 20 * MIN });

  test("runs until its budget, then stops when nothing is running", () => {
    const clock = fresh();
    assert.deepEqual(decideRunClock(clock, T0 + 10 * MIN), { kind: "run", checkAt: T0 + BUDGET, grace: false });
    assert.deepEqual(decideRunClock(clock, T0 + BUDGET), { kind: "stop", reason: "deadline" });
  });

  test("a command running at the deadline gets the grace, a later one does not", () => {
    let clock = replay(fresh(), [[T0 + 65 * MIN, started("gate")]]);
    assert.deepEqual(decideRunClock(clock, T0 + BUDGET), { kind: "run", checkAt: T0 + 90 * MIN, grace: true });
    // During the grace the agent starts more commands; they hold nothing.
    clock = replay(clock, [[T0 + 72 * MIN, started("tail")]]);
    clock = replay(clock, [[T0 + 75 * MIN, completed("gate", "BUILD SUCCESSFUL")]]);
    assert.deepEqual(decideRunClock(clock, T0 + 75 * MIN), { kind: "stop", reason: "deadline" });
  });

  test("the grace ends at its limit even if the command is still running", () => {
    const clock = replay(fresh(), [[T0 + 50 * MIN, started("stuck")]]);
    assert.deepEqual(decideRunClock(clock, T0 + 89 * MIN), { kind: "run", checkAt: T0 + 90 * MIN, grace: true });
    assert.deepEqual(decideRunClock(clock, T0 + 90 * MIN), { kind: "stop", reason: "grace_ended" });
  });

  test("a command that finishes in the grace and shows a wait buys that time back", () => {
    let clock = replay(fresh(), [[T0 + 40 * MIN, started("gate")]]);
    assert.equal(decideRunClock(clock, T0 + BUDGET).kind, "run");
    clock = replay(clock, [[T0 + 80 * MIN, completed("gate", `${DEVICE_HELD}\n${deviceFree(1800)}\nAndroid gate: 1 executed; process exit 0`)]]);
    assert.equal(runClockCreditMs(clock), 30 * MIN);
    assert.deepEqual(decideRunClock(clock, T0 + 80 * MIN), { kind: "run", checkAt: T0 + 100 * MIN, grace: false });
    assert.deepEqual(decideRunClock(clock, T0 + 100 * MIN), { kind: "stop", reason: "deadline" });
  });

  test("nothing passes the hard ceiling, however much waiting is shown", () => {
    let clock = replay(fresh(), [
      [T0 + 1 * MIN, started("long")],
      [T0 + 139 * MIN, completed("long", `${deviceFree(4000)}\n${slotGot(4000)}`)],
      [T0 + 139 * MIN, started("next")],
    ]);
    assert.equal(runClockDeadline(clock), T0 + 140 * MIN);
    assert.deepEqual(decideRunClock(clock, T0 + 139 * MIN + 59 * S), { kind: "run", checkAt: T0 + 140 * MIN, grace: false });
    assert.deepEqual(decideRunClock(clock, T0 + 140 * MIN), { kind: "stop", reason: "ceiling" });
    // The grace cannot pass it either.
    clock = replay(fresh(), [[T0 + 1 * MIN, started("gate")], [T0 + 69 * MIN, completed("gate", deviceFree(3600))], [T0 + 125 * MIN, started("g2")]]);
    assert.equal(runClockDeadline(clock), T0 + 130 * MIN);
    assert.deepEqual(decideRunClock(clock, T0 + 130 * MIN), { kind: "run", checkAt: T0 + 140 * MIN, grace: true });
    assert.deepEqual(decideRunClock(clock, T0 + 140 * MIN), { kind: "stop", reason: "ceiling" });
  });

  test("ceiling factor 1 is the old fixed wall clock: no credit, no grace", () => {
    const clock = replay(fresh({ ceilingFactor: 1 }), [
      [T0 + 10 * MIN, started("gate")],
      [T0 + 30 * MIN, completed("gate", deviceFree(1200))],
      [T0 + 65 * MIN, started("gradle")],
    ]);
    assert.equal(runClockDeadline(clock), T0 + BUDGET);
    assert.deepEqual(decideRunClock(clock, T0 + BUDGET), { kind: "stop", reason: "deadline" });
  });

  test("grace 0 turns only the grace off", () => {
    const clock = replay(fresh({ graceMs: 0 }), [[T0 + 65 * MIN, started("gate")]]);
    assert.deepEqual(decideRunClock(clock, T0 + BUDGET), { kind: "stop", reason: "deadline" });
  });
});
