import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { FleetStore, type StartRequest } from "./fleet-store.js";
import { serveFleet, FleetClient, JsonClient } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { scheduleMachine, type WorkOffer } from "./machine-scheduler.js";
import { readCodexThrottleConfig, DEFAULT_CODEX_START_SPACING_MS, type CodexSpacingState } from "./codex-throttle.js";

// 2026-10-14: eight 429s with only three Codex runs in flight while the plan
// still showed 66 percent left, which points at a tokens-per-minute limit. A
// Codex run's opening turns are its largest requests, so the claim service
// admits at most one new Codex start per spacing, fleet-wide.
const SEC = 1000;
const limits = { box: { heavyLimit: 3, combinedLimit: 6 }, hp: { heavyLimit: 3, combinedLimit: 6 } };

function fixture(t: TestContext, spacingMs = DEFAULT_CODEX_START_SPACING_MS) {
  let clock = 1_800_000_000_000;
  const store = new FleetStore(":memory:", limits, { now: () => clock, log: () => {},
    codexThrottle: { ...readCodexThrottleConfig(undefined), startSpacingMs: spacingMs } });
  t.after(() => store.close());
  return { store, advance: (ms: number) => { clock += ms; }, now: () => clock };
}
let next = 0;
const req = (role: string, extra: Partial<StartRequest> = {}): StartRequest => {
  const n = ++next;
  return { id: `run-${n}`, machine: "box", session: "s1", project: "org/core", ticket: `org/core#${n}`, role, resource: "medium", locks: [], ...extra };
};

describe("fleet-wide Codex start spacing", () => {
  test("one Codex start per twenty seconds across every computer; the held offer reserves nothing", t => {
    const { store, advance } = fixture(t);
    store.setRunner("codex");
    assert.equal(store.start(req("builder")).ok, true);
    const held = req("verifier", { machine: "hp" });
    assert.deepEqual(store.start(held), { ok: false, reason: "codex-spaced" });
    // Nothing was reserved for the held start: no run, no claim, no place taken.
    const state = store.snapshot();
    assert.equal(state.runs.some(r => r.ticket === held.ticket), false);
    assert.equal(state.claims.some(c => c.ticket === held.ticket), false);
    assert.equal(state.codexSpacing?.held, true);
    assert.equal(state.codexSpacing?.remainingSeconds, 20);
    assert.deepEqual(state.codexSpacing?.lastStart, { machine: "box", ticket: "org/core#" + (next - 1), role: "builder" });
    assert.equal(state.codexSpacing?.heldSinceLastStart, 1);
    // Work that starts no Codex agent is admitted meanwhile.
    for (const role of ["merge", "real-claude-gate", "main-sweep"]) assert.equal(store.start(req(role, { resource: "light" })).ok, true, role);
    advance(20 * SEC - 1);
    assert.deepEqual(store.start(held), { ok: false, reason: "codex-spaced" });
    advance(1);
    assert.equal(store.start(held).ok, true);
    const after = store.snapshot().codexSpacing;
    assert.equal(after?.held, true, "the new start begins the next spacing");
    assert.equal(after?.heldSinceLastStart, 0);
    assert.equal(store.codex.spacingState().startsLastHour, 2);
  });

  test("a refused start of any other kind does not use the spacing, and Claude runs are never spaced", t => {
    const { store, advance } = fixture(t);
    store.setRunner("codex");
    const first = req("builder", { locks: ["org/core:main"] });
    assert.equal(store.start(first).ok, true);
    advance(20 * SEC);
    // Refused for its lock: not admitted, so it does not start the next spacing.
    assert.deepEqual(store.start(req("builder", { locks: ["org/core:main"] })), { ok: false, reason: "locked" });
    assert.equal(store.start(req("builder")).ok, true);
    // The Claude choice is never spaced.
    store.setRunner("claude");
    assert.equal(store.start(req("builder")).ok, true);
    assert.equal(store.start(req("verifier")).ok, true);
    // Without a central choice, a dispatcher's own Claude runner is not spaced either.
    store.setRunner(null);
    assert.equal(store.start(req("builder", { runner: "claude" })).ok, true);
    assert.deepEqual(store.start(req("builder", { runner: "codex" })), { ok: false, reason: "codex-spaced" });
  });

  test("a lost-reply retry of an admitted start still recovers its grant inside the spacing", t => {
    const { store } = fixture(t);
    store.setRunner("codex");
    const first = req("builder");
    const granted = store.start(first);
    assert.equal(granted.ok, true);
    assert.deepEqual(store.start(first), granted);
  });

  test("spacing 0 turns it off; a start stamped in the future, after the clock steps back, holds nothing", t => {
    const off = fixture(t, 0);
    off.store.setRunner("codex");
    assert.equal(off.store.start(req("builder")).ok, true);
    assert.equal(off.store.start(req("builder")).ok, true);
    assert.equal(off.store.snapshot().codexSpacing, undefined);

    const { store, advance } = fixture(t);
    store.setRunner("codex");
    advance(10 * 60 * SEC);
    assert.equal(store.start(req("builder")).ok, true);
    advance(-10 * 60 * SEC); // the clock steps back ten minutes
    assert.equal(store.codex.spacingWaitMs(), 0);
    assert.equal(store.start(req("builder")).ok, true);
    assert.deepEqual(store.start(req("builder")), { ok: false, reason: "codex-spaced" });
  });

  test("configuration: default twenty seconds, zero allowed, bounded at five minutes", () => {
    assert.equal(readCodexThrottleConfig(undefined).startSpacingMs, 20 * SEC);
    assert.equal(readCodexThrottleConfig({ startSpacingSeconds: 30 }).startSpacingMs, 30 * SEC);
    assert.equal(readCodexThrottleConfig({ startSpacingSeconds: 0 }).startSpacingMs, 0);
    assert.throws(() => readCodexThrottleConfig({ startSpacingSeconds: -1 }), /between 0 and 300/);
    assert.throws(() => readCodexThrottleConfig({ startSpacingSeconds: 301 }), /between 0 and 300/);
    assert.throws(() => readCodexThrottleConfig({ startSpacingSeconds: "20" }), /between 0 and 300/);
  });
});

describe("scheduling while spaced", () => {
  const spacing: CodexSpacingState = { spacingSeconds: 20, held: true, remainingSeconds: 12, lastStartAt: 1, nextStartAt: 2, lastStart: null, heldSinceLastStart: 0, startsLastHour: 1 };
  const offer = (key: string, role: string, extra: Partial<WorkOffer> = {}): WorkOffer => ({ project: "org/core", ticket: `org/core#${key}`, role, resource: "medium", locks: [], key, order: 0, ...extra });
  test("the scheduler passes over Codex offers for work that can start", () => {
    const offers = [offer("1", "builder"), offer("2", "merge", { resource: "light" }), offer("3", "verifier", { runner: "codex" })];
    const state = { claims: [], runs: [], runnerPolicy: { runner: "codex" as const, revision: 1 }, codexSpacing: spacing };
    assert.deepEqual(scheduleMachine({ machine: "box", projects: ["org/core"], heavyLimit: 1, combinedLimit: 2, offers, state }).map(o => o.key), ["2"]);
    const free = scheduleMachine({ machine: "box", projects: ["org/core"], heavyLimit: 1, combinedLimit: 2, offers, state: { ...state, codexSpacing: undefined } });
    assert.deepEqual(free.map(o => o.key).sort(), ["1", "2", "3"]);
  });
});

const url = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test("end to end: two computers' managers start Codex work twenty seconds apart, and operator.sh codex shows the spacing", async t => {
  let clock = 1_800_000_000_000;
  const store = new FleetStore(":memory:", limits, { now: () => clock, log: () => {} });
  store.setRunner("codex");
  const central = await serveFleet(store, { box: "box-token", hp: "hp-token" }, "central-admin", 0);
  const box = new MachineManager({ machine: "box", heavyLimit: 3, combinedLimit: 6, projects: ["org/core"] }, new FleetClient(url(central), "box-token"));
  const hp = new MachineManager({ machine: "hp", heavyLimit: 3, combinedLimit: 6, projects: ["org/app"] }, new FleetClient(url(central), "hp-token"));
  const boxServer = await serveManager(box, { "org/core": "core-token" }, "box-admin", 0);
  t.after(async () => { await new Promise<void>(r => boxServer.close(() => r())); await new Promise<void>(r => central.close(() => r())); store.close(); });
  const work = (project: string, n: number, role: string, resource: "medium" | "light" = "medium"): WorkOffer =>
    ({ project, ticket: `${project}#${n}`, role, resource, locks: [], key: `${n}-${role}`, order: n });
  box.offer("org/core", "core-session", [work("org/core", 1, "builder"), work("org/core", 2, "verifier"), work("org/core", 3, "merge", "light")]);
  hp.offer("org/app", "app-session", [work("org/app", 4, "refiner")]);
  await box.tick(); await hp.tick();
  let runs = store.snapshot().runs.map(r => r.ticket).sort();
  assert.deepEqual(runs, ["org/core#1", "org/core#3"], "one Codex start, plus the merge, which is not Codex");
  const status = await new JsonClient(url(boxServer), "box-admin").call<any>("/state");
  assert.equal(status.queue.find((q: any) => q.ticket === "org/core#2").state, "codex-spaced");
  assert.equal(status.codexSpacing.held, true);

  clock += 20_000;
  await hp.tick(); await box.tick();
  runs = store.snapshot().runs.map(r => r.ticket).sort();
  assert.deepEqual(runs, ["org/app#4", "org/core#1", "org/core#3"], "the next Codex start went to whichever manager asked first");
  clock += 20_000;
  await box.tick();
  assert.equal(store.snapshot().runs.length, 4);

  const shown = await new JsonClient(url(central), "central-admin").call<any>("/codex");
  assert.equal(shown.spacing.spacingSeconds, 20);
  assert.equal(shown.spacing.startsLastHour, 3);
  assert.equal(shown.config.startSpacingMs, 20_000);
  assert.deepEqual(shown.recentStarts.map((s: any) => s.ticket), ["org/core#2", "org/app#4", "org/core#1"]);
});
