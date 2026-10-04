// --------- Time limits that stop stalled work, not waiting work ---------
//
// Two host-wide queues now sit in front of pipeline work on the mobile host:
//
//  - The Android device hold in the product repo's
//    `scripts/android-test-gate.py` (`device_hold`). One emulator run at a
//    time; the rest wait up to ANDROID_GATE_WAIT_SECONDS (mobile: 2700).
//  - Pipeline Gradle build places, `~/.gradle/init.d/pyry-build-slots.gradle`
//    (2026-10-04). Two pipeline builds at a time; the rest wait up to 20 min.
//
// A run that waits in one of them spends its wall clock standing in a queue.
// Mobile #1646's builder hit its 70-minute limit on 2026-10-04 at 04:26 UTC
// after its own device checks had spent more than half of it waiting on other
// tickets' gates, and was killed two minutes after updating its PR.
//
// This module is the pure half: what the queues print, how much waiting that
// proves, and when a run's clock is really spent. The spawn code in
// dispatch.ts only feeds it lines and events and acts on its answers.
//
// Everything here is bounded by a hard ceiling (twice the normal budget by
// default), so a hung run still ends.

/** A closed time span, [start, end), in epoch milliseconds. */
export type Interval = readonly [number, number];

/** Sorted, non-overlapping, non-empty copies of `intervals`. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).slice().sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Total time covered by `intervals`, counting overlaps once. */
export function unionLengthMs(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, [a, b]) => sum + (b - a), 0);
}

function clipTo(intervals: readonly Interval[], [lo, hi]: Interval): Interval[] {
  return mergeIntervals(intervals)
    .map(([a, b]): Interval => [Math.max(a, lo), Math.min(b, hi)])
    .filter(([a, b]) => b > a);
}

// --------- What the queues print ---------
//
// Exact messages, copied from the scripts, anchored at the start of a line
// so a `grep -n` or `rg` hit on the scripts' own source never counts. The
// device messages go to stderr, the build-slot ones to Gradle's stdout.

type WaitQueue = "device" | "slot";

const FINISHED_WAITS: ReadonlyArray<{ queue: WaitQueue; pattern: RegExp; unitMs: number }> = [
  // Printed once the hold is taken after waiting.
  { queue: "device", pattern: /^Android gate: device free after (\d+)s waiting$/, unitMs: 1000 },
  // Printed when the wait limit runs out. The gate exits without testing.
  { queue: "device", pattern: /^Android gate: device busy, not a test result: gave up after (\d+)s; held by /, unitMs: 1000 },
  // Printed once a place is taken after waiting. Not printed for no wait.
  { queue: "slot", pattern: /^Pyrycode build slots: got a place after (\d+) s\.$/, unitMs: 1000 },
  // Printed when the build stops waiting and builds without a place.
  { queue: "slot", pattern: /^Pyrycode build slots: no place after (\d+) minutes; building without one\.$/, unitMs: 60_000 },
];

/** Printed once when a gate starts waiting for the device; N is its limit. */
const DEVICE_WAIT_STARTED = /^Android gate: device held by .+; waiting up to (\d+)s$/;
/** Printed when a build starts waiting and then once a minute; M is minutes so far. */
const SLOT_WAITING = /^Pyrycode build slots: all \d+ places are taken by other pipeline builds; waiting \((\d+) min so far\)\.$/;

const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

function cleanLine(line: string): string {
  return line.replace(ANSI_ESCAPE, "").trim();
}

function mentionsQueue(line: string): boolean {
  return line.startsWith("Android gate:") || line.startsWith("Pyrycode build slots:");
}

/** One finished wait a queue reported: the line itself and how long it waited. */
export interface FinishedWait {
  line: string;
  queue: WaitQueue;
  ms: number;
}

function matchFinishedWait(line: string): FinishedWait | null {
  for (const { queue, pattern, unitMs } of FINISHED_WAITS) {
    const m = pattern.exec(line);
    if (m) return { line, queue, ms: Number(m[1]) * unitMs };
  }
  return null;
}

/** Every finished wait reported in `text`, in order. */
export function finishedWaits(text: string): FinishedWait[] {
  const out: FinishedWait[] = [];
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = cleanLine(raw);
    if (!mentionsQueue(line)) continue;
    const wait = matchFinishedWait(line);
    if (wait) out.push(wait);
  }
  return out;
}

// --------- Knobs ---------

/**
 * Default hard ceiling, as a multiple of a run's or gate's normal budget.
 * Wait credit and grace together never take anything past it.
 */
export const DEFAULT_TIMEOUT_CEILING_FACTOR = 2;

/**
 * Parse `PYRY_TIMEOUT_CEILING_FACTOR`. A number of at least 1; `1` turns
 * every extension off, which is the behaviour before 2026-10-04. Unset,
 * empty, below 1 or garbage gives the default of 2.
 */
export function parseTimeoutCeilingFactor(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_CEILING_FACTOR;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_TIMEOUT_CEILING_FACTOR;
}

/**
 * Default grace, in minutes, for a command still running when a Codex run's
 * budget is spent. The device hold and a build place can each hold a command
 * for 20 minutes or more, and Codex reports a command's output only when it
 * finishes, so the run needs the chance to see it.
 */
export const DEFAULT_TIMEOUT_GRACE_MINUTES = 20;

/**
 * Parse `PYRY_TIMEOUT_GRACE_MINUTES` into milliseconds, like
 * `parseIdleTimeoutMs`: unset or empty gives the 20-minute default, `0` or a
 * negative number turns the grace off, fractions are allowed, and garbage
 * falls back to the default.
 */
export function parseTimeoutGraceMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_GRACE_MINUTES * 60_000;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_GRACE_MINUTES * 60_000;
  return n <= 0 ? 0 : Math.round(n * 60_000);
}

function ceilingAt(startedAt: number, budgetMs: number, factor: number): number {
  return startedAt + Math.round(budgetMs * Math.max(1, factor));
}

// --------- Dispatcher-run gates: live output ---------
//
// The verifier gates, the real-claude gate and the main sweep are spawned by
// the dispatcher, which reads their output as it is written. A wait in
// progress is visible, so a gate's deadline simply moves with it.

/** The device-hold message prints once, so its own limit bounds the wait. */
interface OpenDeviceWait { readonly since: number; readonly limitMs: number }
/** Build-slot notes repeat each minute; the wait ends a little after the last. */
interface OpenSlotWait { readonly since: number; readonly lastNoteAt: number }

/** How long after its last once-a-minute note a slot wait still counts. */
const SLOT_NOTE_SPAN_MS = 75_000;

export interface GateWaitState {
  readonly startedAt: number;
  /** Finished waits, from each queue's own report of how long it waited. */
  readonly done: readonly Interval[];
  readonly device: OpenDeviceWait | null;
  readonly slot: OpenSlotWait | null;
}

export function initGateWaitState(startedAt: number): GateWaitState {
  return { startedAt, done: [], device: null, slot: null };
}

/** Advance on one output line from either stream. Pure. */
export function advanceGateWaitState(state: GateWaitState, rawLine: string, now: number): GateWaitState {
  const line = cleanLine(rawLine);
  if (!mentionsQueue(line)) return state;
  const finished = matchFinishedWait(line);
  if (finished) {
    const span: Interval = [Math.max(state.startedAt, now - finished.ms), now];
    return {
      ...state,
      done: [...state.done, span],
      device: finished.queue === "device" ? null : state.device,
      slot: finished.queue === "slot" ? null : state.slot,
    };
  }
  const started = DEVICE_WAIT_STARTED.exec(line);
  if (started) {
    return state.device ? state : { ...state, device: { since: now, limitMs: Number(started[1]) * 1000 } };
  }
  const waiting = SLOT_WAITING.exec(line);
  if (waiting) {
    const since = state.slot?.since ?? Math.max(state.startedAt, now - Number(waiting[1]) * 60_000);
    return { ...state, slot: { since, lastNoteAt: now } };
  }
  return state;
}

/**
 * Time the gate has spent waiting so far: finished waits as reported, plus
 * any wait still open. An open device wait counts up to its printed limit,
 * an open slot wait up to shortly after its last note, so a waiter that dies
 * without a final line stops earning credit on its own. Overlaps count once.
 */
export function gateWaitCreditMs(state: GateWaitState, now: number): number {
  const open: Interval[] = [];
  if (state.device) open.push([state.device.since, Math.min(now, state.device.since + state.device.limitMs)]);
  if (state.slot) open.push([state.slot.since, Math.min(now, state.slot.lastNoteAt + SLOT_NOTE_SPAN_MS)]);
  return unionLengthMs([...state.done, ...open]);
}

/** A gate's deadline right now: its budget plus waiting, never past the ceiling. */
export function gateDeadline(state: GateWaitState, now: number, budgetMs: number, ceilingFactor: number): {
  deadlineAt: number; ceilingAt: number; creditMs: number;
} {
  const ceiling = ceilingAt(state.startedAt, budgetMs, ceilingFactor);
  const creditMs = gateWaitCreditMs(state, now);
  return { deadlineAt: Math.min(ceiling, state.startedAt + budgetMs + creditMs), ceilingAt: ceiling, creditMs };
}

// --------- Codex agent runs: completed-command output ---------
//
// `codex exec --json` reports a command twice: `item.started` when it begins
// and `item.completed`, with `aggregated_output`, when it exits. Nothing in
// between. So a wait becomes visible only when some command's output shows
// the queue's final line.
//
// Builders usually redirect a long gate to a file and `tail` it, so the line
// often arrives in a short `tail` command, sometimes long after the wait,
// and sometimes again in the next `tail`. The credit rule copes with that:
//
//  - Each distinct line counts once per run.
//  - A sighting at time t of waits totalling N counts only the time in
//    [t - N, t] when at least one of this run's commands was running. A
//    `tail` of an old log, or a wait behind a detached background process,
//    therefore earns little or nothing, and the credit can never exceed the
//    time the run actually had a command going.
//  - Overlapping credit counts once.

export interface RunClock {
  readonly startedAt: number;
  readonly budgetMs: number;
  readonly ceilingAt: number;
  readonly graceMs: number;
  /** Commands started and not yet completed: item id → start time. */
  readonly running: ReadonlyMap<string, number>;
  /** When finished commands ran, merged. */
  readonly ran: readonly Interval[];
  /** Waiting time credited back to the run. */
  readonly credited: readonly Interval[];
  /** Queue lines already credited. */
  readonly seenWaitLines: ReadonlySet<string>;
}

export function initRunClock(opts: { startedAt: number; budgetMs: number; ceilingFactor: number; graceMs: number }): RunClock {
  return {
    startedAt: opts.startedAt,
    budgetMs: opts.budgetMs,
    ceilingAt: ceilingAt(opts.startedAt, opts.budgetMs, opts.ceilingFactor),
    graceMs: Math.max(0, opts.graceMs),
    running: new Map(),
    ran: [],
    credited: [],
    seenWaitLines: new Set(),
  };
}

/** Advance on one Codex JSONL event. Only command executions matter. Pure. */
export function advanceRunClock(clock: RunClock, event: unknown, now: number): RunClock {
  if (!event || typeof event !== "object") return clock;
  const e = event as Record<string, unknown>;
  const item = e.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "command_execution" || typeof item.id !== "string") return clock;
  const id = item.id;

  if (e.type === "item.started") {
    if (clock.running.has(id)) return clock;
    const running = new Map(clock.running);
    running.set(id, now);
    return { ...clock, running };
  }
  if (e.type !== "item.completed") return clock;

  let { running, ran, credited, seenWaitLines } = clock;
  const began = running.get(id);
  if (began !== undefined) {
    const next = new Map(running);
    next.delete(id);
    running = next;
    ran = mergeIntervals([...ran, [began, now]]);
  }

  const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
  let totalMs = 0;
  let seen: Set<string> | null = null;
  for (const wait of finishedWaits(output)) {
    if (seenWaitLines.has(wait.line) || seen?.has(wait.line)) continue;
    seen ??= new Set(seenWaitLines);
    seen.add(wait.line);
    totalMs += wait.ms;
  }
  if (seen) {
    seenWaitLines = seen;
    const window: Interval = [Math.max(clock.startedAt, now - totalMs), now];
    const busy: Interval[] = [...ran, ...[...running.values()].map((s): Interval => [s, now])];
    credited = mergeIntervals([...credited, ...clipTo(busy, window)]);
  }
  return { ...clock, running, ran, credited, seenWaitLines };
}

export function runClockCreditMs(clock: RunClock): number {
  return unionLengthMs(clock.credited);
}

/** The run's deadline: budget plus credited waiting, never past the ceiling. */
export function runClockDeadline(clock: RunClock): number {
  return Math.min(clock.ceilingAt, clock.startedAt + clock.budgetMs + runClockCreditMs(clock));
}

export type RunClockDecision =
  | { kind: "run"; checkAt: number; grace: boolean }
  | { kind: "stop"; reason: "deadline" | "grace_ended" | "ceiling" };

/**
 * Whether a Codex run may keep going at `now`, and when to ask again.
 *
 * Before the deadline it runs. At the deadline, a command that started
 * before it and is still running gets a grace of up to `graceMs` to finish,
 * since its output, and any wait it reports, arrives only when it does.
 * Once every such command has finished the deadline applies again, with
 * whatever credit they brought. Commands started after the deadline do not
 * hold the run. Nothing passes the ceiling.
 */
export function decideRunClock(clock: RunClock, now: number): RunClockDecision {
  const extendable = clock.ceilingAt > clock.startedAt + clock.budgetMs;
  if (now >= clock.ceilingAt) return { kind: "stop", reason: extendable ? "ceiling" : "deadline" };
  const deadline = runClockDeadline(clock);
  if (now < deadline) return { kind: "run", checkAt: deadline, grace: false };
  const holding = [...clock.running.values()].some((began) => began < deadline);
  if (clock.graceMs <= 0 || !holding) return { kind: "stop", reason: "deadline" };
  const graceEnd = Math.min(clock.ceilingAt, deadline + clock.graceMs);
  return now < graceEnd ? { kind: "run", checkAt: graceEnd, grace: true } : { kind: "stop", reason: "grace_ended" };
}

/** Minutes for log lines, one decimal. */
export function formatMinutes(ms: number): string {
  return `${Math.round((ms / 60_000) * 10) / 10}min`;
}
