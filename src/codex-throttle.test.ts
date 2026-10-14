import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { FleetStore, type StartRequest } from "./fleet-store.js";
import { serveFleet, FleetClient, JsonClient } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { scheduleMachine, type WorkOffer } from "./machine-scheduler.js";
import { ManagedDispatch, managedCodexReporter } from "./managed-dispatch.js";
import {
  codexPauseAttention, codexStartJitterMaxMs, DEFAULT_CODEX_START_JITTER_MS, readCodexThrottleConfig, startsCodex,
  type CodexPauseState,
} from "./codex-throttle.js";

const MIN = 60_000;
const limits = { box: { heavyLimit: 2, combinedLimit: 4 }, hp: { heavyLimit: 2, combinedLimit: 4 } };

function fixture(t: TestContext, options: ConstructorParameters<typeof FleetStore>[2] = {}, path?: string) {
  let clock = 1_800_000_000_000;
  const logs: string[] = [];
  const dir = path ? undefined : mkdtempSync(join(tmpdir(), "codex-throttle-"));
  const file = path ?? join(dir!, "claims.sqlite");
  const store = new FleetStore(file, limits, { now: () => clock, log: line => logs.push(line), ...options });
  t.after(() => { try { store.close(); } catch { /* a test closed it to restart */ } if (dir) rmSync(dir, { recursive: true, force: true }); });
  return { store, logs, file, advance: (ms: number) => { clock += ms; }, now: () => clock };
}
let next = 0;
const req = (role: string, extra: Partial<StartRequest> = {}): StartRequest => {
  const n = ++next;
  return { id: `run-${n}`, machine: "box", session: "s1", project: "org/core", ticket: `org/core#${n}`, role, resource: "light", locks: [], ...extra };
};
/** Admit a run and return it. */
function admit(store: FleetStore, role = "builder", extra: Partial<StartRequest> = {}): StartRequest {
  const r = req(role, extra);
  assert.deepEqual(store.start(r), { ok: true, generation: store.snapshot().claims.find(c => c.ticket === r.ticket)?.generation ?? assert.fail("no claim") });
  return r;
}
const limited = (store: FleetStore, run: StartRequest) => store.codexReport(run.machine, run.session, run.project, run.id, "rate-limited");
const clean = (store: FleetStore, run: StartRequest) => store.codexReport(run.machine, run.session, run.project, run.id, "clean");

describe("fleet Codex pause at admission", () => {
  test("a 429 pauses new Codex starts fleet-wide for two minutes; other work and running work are untouched", t => {
    const { store, advance, logs } = fixture(t);
    store.setRunner("codex");
    const running = admit(store, "builder");
    const failed = admit(store, "refiner", { machine: "hp" });
    const state = limited(store, failed);
    assert.equal(state.active, true);
    assert.equal(state.durationMs, 2 * MIN);
    assert.equal(state.nextDurationMs, 4 * MIN);
    assert.equal(state.remainingSeconds, 120);
    assert.deepEqual(state.cause, { machine: "hp", project: "org/core", ticket: failed.ticket, role: "refiner", runId: failed.id });
    assert.match(logs.join("\n"), /pause-started: 429 from refiner on org\/core#\d+ \(hp\)\. New Codex runs are paused fleet-wide for 2 min/);

    // Every Codex role, on every computer, waits. The admitted run stays.
    for (const role of ["builder", "verifier", "refiner", "documentation", "recovery-like-agent"]) {
      assert.deepEqual(store.start(req(role, { machine: "hp" })), { ok: false, reason: "codex-paused" });
    }
    assert.ok(store.snapshot().runs.some(r => r.id === running.id));
    // Work that starts no Codex agent is admitted.
    for (const role of ["merge", "reconcile", "codegraph", "main-sweep", "real-claude-gate"]) {
      const r = req(role, role === "reconcile" ? { ticket: "org/core#@reconcile", locks: ["org/core:reconcile"] } : {});
      assert.equal(store.start(r).ok, true, role);
      store.finish(r.machine, r.session, r.id);
    }
    // A Claude run admits during the pause once the central choice is Claude.
    store.setRunner("claude");
    assert.equal(store.start(req("builder")).ok, true);
    store.setRunner("codex");

    advance(2 * MIN - 1);
    assert.deepEqual(store.start(req("builder")), { ok: false, reason: "codex-paused" });
    advance(1);
    assert.equal(store.start(req("builder")).ok, true);
    assert.equal(store.snapshot().codexPause?.active, false);
  });

  test("a lost-reply retry of an admission made before the pause still recovers its grant", t => {
    const { store } = fixture(t);
    store.setRunner("codex");
    const first = admit(store, "builder");
    limited(store, first);
    assert.equal(store.start(first).ok, true);
  });

  test("without a central choice, the dispatcher's stated runner decides; an unstated one is never paused", t => {
    const { store } = fixture(t);
    const failed = admit(store, "builder", { runner: "codex" });
    limited(store, failed);
    assert.deepEqual(store.start(req("builder", { runner: "codex" })), { ok: false, reason: "codex-paused" });
    assert.equal(store.start(req("builder", { runner: "claude" })).ok, true);
    assert.equal(store.start(req("builder")).ok, true, "an older dispatcher without the field and no central choice");
    assert.throws(() => store.start(req("builder", { runner: "gpt" as never })), /Invalid runner/);
  });

  test("startsCodex follows the central choice first, then the stated runner, and knows non-agent roles", () => {
    const codex = { runner: "codex" as const, revision: 1 }, claude = { runner: "claude" as const, revision: 2 };
    assert.equal(startsCodex({ role: "builder" }, codex), true);
    assert.equal(startsCodex({ role: "builder", runner: "claude" }, codex), true, "the central choice overrides local files");
    assert.equal(startsCodex({ role: "builder", runner: "codex" }, claude), false);
    assert.equal(startsCodex({ role: "builder", runner: "codex" }, undefined), true);
    assert.equal(startsCodex({ role: "builder" }, undefined), false);
    assert.equal(startsCodex({ role: "builder" }, { runner: null, revision: 3 }), false);
    for (const role of ["merge", "reconcile", "codegraph", "main-sweep", "real-claude-gate"]) assert.equal(startsCodex({ role }, codex), false, role);
    assert.equal(startsCodex({ role: "recovery-task" }, codex, "dispatcher-repair"), true);
    assert.equal(startsCodex({ role: "recovery-task" }, codex, "platform-probe"), false);
    assert.equal(startsCodex({ role: "recovery-task" }, claude, "dispatcher-repair"), false);
  });
});

describe("Codex pause backoff", () => {
  test("429s with no clean start between them double the pause up to the ceiling, which needs attention", t => {
    const { store, advance } = fixture(t);
    store.setRunner("codex");
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const run = admit(store, "builder");
      const state = limited(store, run);
      seen.push(state.durationMs / MIN);
      assert.equal(codexPauseAttention(state) !== null, state.durationMs === 30 * MIN);
      advance(state.durationMs);
    }
    assert.deepEqual(seen, [2, 4, 8, 16, 30, 30]);
    const run = admit(store, "builder");
    const ceiling = limited(store, run);
    assert.equal(ceiling.atCeiling, true);
    const item = codexPauseAttention(ceiling)!;
    assert.equal(item.kind, "codex-paused");
    assert.match(item.reason, /30 min, the ceiling/);
    assert.match(item.reason, /operator\.sh codex clear/);
  });

  test("a 429 during a pause neither extends it nor doubles twice: one burst is one step", t => {
    const { store, advance, logs } = fixture(t);
    store.setRunner("codex");
    const burst = [admit(store, "builder"), admit(store, "refiner", { machine: "hp" }), admit(store, "verifier")];
    const first = limited(store, burst[0]);
    advance(2_000);
    const second = limited(store, burst[1]);
    const third = limited(store, burst[2]);
    assert.equal(second.until, first.until);
    assert.equal(third.reports, 3);
    assert.equal(third.nextDurationMs, 4 * MIN);
    assert.equal(logs.filter(l => l.includes("pause-started")).length, 1);
    assert.equal(logs.filter(l => l.includes("during the current pause")).length, 2);
    advance(2 * MIN);
    assert.equal(limited(store, admit(store, "builder")).durationMs, 4 * MIN, "the next 429 doubles");
  });

  test("a clean start from a run admitted after the pause began resets the backoff; an older run's does not", t => {
    const { store, advance, logs } = fixture(t);
    store.setRunner("codex");
    const before = admit(store, "builder");
    limited(store, admit(store, "builder"));
    advance(2 * MIN);
    assert.equal(clean(store, before).level, 1, "a run admitted before the pause says nothing about new starts");
    const after = admit(store, "builder");
    const reset = clean(store, after);
    assert.equal(reset.level, 0);
    assert.equal(reset.nextDurationMs, 2 * MIN);
    assert.ok(logs.some(l => /reset: builder on org\/core#\d+ \(box\) started Codex cleanly/.test(l)));
    assert.equal(clean(store, after).level, 0);
    assert.equal(logs.filter(l => l.includes("reset:")).length, 1, "a second clean report changes nothing");
    assert.equal(limited(store, admit(store, "builder")).durationMs, 2 * MIN);
  });

  test("a 429 long after the last pause, with no Codex start in between, starts over at two minutes", t => {
    const { store, advance } = fixture(t);
    store.setRunner("codex");
    limited(store, admit(store, "builder"));
    advance(2 * MIN + 30 * MIN + 1);
    assert.equal(limited(store, admit(store, "builder")).durationMs, 2 * MIN);
  });

  test("each pause start and end is logged once and kept, across a claim service restart", t => {
    const { store, advance, logs, file, now } = fixture(t);
    store.setRunner("codex");
    limited(store, admit(store, "builder"));
    advance(MIN);
    store.codexTick();
    assert.equal(logs.filter(l => l.includes("pause-ended")).length, 0);
    store.close();
    // A restart keeps the pause and still logs its end once.
    let clock = now();
    const restarted = new FleetStore(file, limits, { now: () => clock, log: line => logs.push(line) });
    t.after(() => restarted.close());
    assert.deepEqual(restarted.start(req("builder")), { ok: false, reason: "codex-paused" });
    clock += MIN;
    restarted.codexTick(); restarted.codexTick();
    assert.equal(logs.filter(l => l.includes("pause-ended")).length, 1);
    assert.match(logs.find(l => l.includes("pause-ended"))!, /after a 2 min pause \(1 rate-limit report\)\. The next 429 before a clean start pauses 4 min/);
    assert.deepEqual(restarted.codex.events().map(e => e.kind), ["pause-ended", "pause-started"]);
    assert.equal(restarted.start(req("builder")).ok, true);
  });

  test("the operator can end a pause early and reset the backoff", t => {
    const { store, logs } = fixture(t);
    store.setRunner("codex");
    limited(store, admit(store, "builder"));
    const cleared = store.clearCodexPause();
    assert.equal(cleared.active, false);
    assert.equal(cleared.level, 0);
    assert.equal(store.start(req("builder")).ok, true);
    assert.ok(logs.some(l => l.includes("cleared: Operator ended the pause")));
  });

  test("a disabled throttle records a 429 and pauses nothing", t => {
    const { store } = fixture(t, { codexThrottle: { baseMs: 2 * MIN, ceilingMs: 30 * MIN, enabled: false } });
    store.setRunner("codex");
    const state = limited(store, admit(store, "builder"));
    assert.equal(state.active, false);
    assert.equal(state.enabled, false);
    assert.equal(store.start(req("builder")).ok, true);
  });

  test("only the run's own computer, session and project can report it", t => {
    const { store } = fixture(t);
    const run = admit(store, "builder");
    assert.throws(() => store.codexReport("hp", run.session, run.project, run.id, "rate-limited"), /own admitted run/);
    assert.throws(() => store.codexReport("box", "other", run.project, run.id, "rate-limited"), /own admitted run/);
    assert.throws(() => store.codexReport("box", run.session, "org/other", run.id, "rate-limited"), /project mismatch/);
    assert.throws(() => store.codexReport("box", run.session, run.project, "missing", "rate-limited"), /own admitted run/);
    assert.throws(() => store.codexReport("box", run.session, run.project, run.id, "pause"), /rate-limited or clean/);
    // The report races the run's completion, so a finished run still counts.
    store.finish("box", run.session, run.id, false);
    assert.equal(store.codexReport("box", run.session, run.project, run.id, "rate-limited").active, true);
  });

  test("the snapshot carries the pause only once a 429 has been seen", t => {
    const { store } = fixture(t);
    assert.equal("codexPause" in store.snapshot(), false);
    limited(store, admit(store, "builder"));
    assert.equal(store.snapshot().codexPause?.active, true);
  });
});

describe("configuration", () => {
  test("claim service settings are validated and default to two and thirty minutes", () => {
    assert.deepEqual(readCodexThrottleConfig(undefined), { baseMs: 2 * MIN, ceilingMs: 30 * MIN, enabled: true });
    assert.deepEqual(readCodexThrottleConfig({ baseSeconds: 60, ceilingSeconds: 600 }), { baseMs: MIN, ceilingMs: 10 * MIN, enabled: true });
    assert.equal(readCodexThrottleConfig({ enabled: false }).enabled, false);
    assert.throws(() => readCodexThrottleConfig({ baseSeconds: 600, ceilingSeconds: 60 }), /at least baseSeconds/);
    assert.throws(() => readCodexThrottleConfig({ baseSeconds: 1 }), /between 10 and 86400/);
    assert.throws(() => readCodexThrottleConfig({ enabled: "no" }), /true or false/);
    assert.throws(() => readCodexThrottleConfig([]), /object/);
  });

  test("the dispatcher start spread defaults to a minute, can be off, and is held at five minutes", () => {
    assert.equal(codexStartJitterMaxMs(undefined), DEFAULT_CODEX_START_JITTER_MS);
    assert.equal(codexStartJitterMaxMs(""), 60_000);
    assert.equal(codexStartJitterMaxMs("0"), 0);
    assert.equal(codexStartJitterMaxMs("15000"), 15_000);
    assert.equal(codexStartJitterMaxMs("garbage"), 60_000);
    assert.equal(codexStartJitterMaxMs("-5"), 60_000);
    assert.equal(codexStartJitterMaxMs("99999999"), 300_000);
  });
});

describe("scheduling during a pause", () => {
  const paused: CodexPauseState = { active: true, since: 1, until: 2, durationMs: 1, nextDurationMs: 2, level: 1, atCeiling: false, reports: 1, cause: null, lastCleanAt: null, remainingSeconds: 60, enabled: true };
  const offer = (key: string, role: string, extra: Partial<WorkOffer> = {}): WorkOffer => ({ project: "org/core", ticket: `org/core#${key}`, role, resource: "medium", locks: [], key, order: 0, ...extra });

  test("the scheduler passes over Codex work for work that can start", () => {
    const offers = [offer("1", "builder"), offer("2", "merge", { resource: "light" }), offer("3", "verifier", { runner: "codex" })];
    const state = { claims: [], runs: [], runnerPolicy: { runner: "codex" as const, revision: 1 }, codexPause: paused };
    const picked = scheduleMachine({ machine: "box", projects: ["org/core"], heavyLimit: 1, combinedLimit: 2, offers, state }).map(o => o.key);
    assert.deepEqual(picked, ["2"]);
    const resumed = scheduleMachine({ machine: "box", projects: ["org/core"], heavyLimit: 1, combinedLimit: 2, offers, state: { ...state, codexPause: { ...paused, active: false } } }).map(o => o.key);
    assert.deepEqual(resumed.sort(), ["1", "2", "3"]);
  });
});

const url = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

describe("end to end over the claim service and machine manager", () => {
  test("a dispatcher's 429 report pauses the fleet; status shows it; the operator reads and clears it", async t => {
    const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } }, { log: () => {} });
    store.setRunner("codex");
    const central = await serveFleet(store, { mac: "mac-token" }, "central-admin", 0);
    const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 2, projects: ["org/core"] }, new FleetClient(url(central), "mac-token"));
    const server = await serveManager(manager, { "org/core": "project-token" }, "manager-admin", 0);
    t.after(async () => { await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => central.close(() => r())); store.close(); });
    const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: url(server), PYRY_MANAGER_TOKEN: "project-token" });
    managed.localRunner = role => role === "refiner" ? "claude" : "codex";
    await managed.sync();
    const first = managed.offer(1, "builder", "medium");
    assert.equal(first.offer.runner, "codex", "agent offers state the local runner");
    assert.equal(managed.offer(2, "merge", "light").offer.runner, undefined, "non-agent offers state none");
    await managed.sync(); await manager.tick(); await managed.sync();
    assert.equal(managed.ready(first), true);

    let pause: CodexPauseState | null = null;
    await managed.run(first, async () => {
      const report = managedCodexReporter();
      assert.ok(report);
      pause = await report("rate-limited");
      return false;
    });
    assert.equal(pause!.active, true);
    assert.equal(managedCodexReporter(), null, "no reporter outside a run");

    const second = managed.offer(3, "verifier", "medium");
    await managed.sync(); await manager.tick(); await managed.sync();
    assert.equal(managed.ready(second), false);
    const operator = new JsonClient(url(server), "manager-admin");
    const status = await operator.call<any>("/state");
    assert.equal(status.codexPause.active, true);
    assert.equal(status.queue.find((q: any) => q.ticket === "org/core#3").state, "codex-paused");

    const centralOperator = new JsonClient(url(central), "central-admin");
    const shown = await centralOperator.call<any>("/codex");
    assert.equal(shown.pause.active, true);
    assert.equal(shown.events[0].kind, "pause-started");
    await assert.rejects(new JsonClient(url(central), "mac-token").call("/codex/clear", {}), /Operator credential required/);
    await assert.rejects(centralOperator.call("/codex/report", { session: managed.session, runId: "x", event: "clean" }), /Machine credential required/);
    assert.equal((await centralOperator.call<CodexPauseState>("/codex/clear", {})).active, false);
    await managed.sync(); await manager.tick(); await managed.sync();
    assert.equal(managed.ready(second), true);
  });

  test("a clean report is sent once per run, whatever the run spawns", async () => {
    const calls: unknown[] = [];
    const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: "http://127.0.0.1:1", PYRY_MANAGER_TOKEN: "t" });
    (managed as any).connection = { call: async (path: string, body: unknown) => { calls.push([path, body]); return { active: false }; } };
    const report = managed.codexReporter({ id: "r1", ticket: "org/core#1" } as any);
    await Promise.all([report("clean"), report("clean"), report("clean")]);
    await report("rate-limited");
    assert.deepEqual(calls.map(c => (c as any)[1].event), ["clean", "rate-limited"]);
    assert.deepEqual((calls[0] as any)[1], { session: managed.session, runId: "r1", event: "clean" });
    // A failed delivery is null, never a thrown error inside the stream handler.
    (managed as any).connection = { call: async () => { throw new Error("Service 404"); } };
    assert.equal(await managed.codexReporter({ id: "r2", ticket: "org/core#2" } as any)("rate-limited"), null);
  });
});
