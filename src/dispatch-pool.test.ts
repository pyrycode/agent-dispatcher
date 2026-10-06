import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLL_INTERVAL_MS, DispatchPool, candidateKey, excludeInFlight, freeSeats, launchCandidates, liveGateRunnerFor, mayStartMainSweep, resolvePollIntervalMs } from "./dispatch-pool.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("dispatch pool — seats refill as runs settle (2026-09-22)", () => {
  test("freeSeats is the cap minus in-flight, never negative", () => {
    assert.equal(freeSeats(2, 0), 2);
    assert.equal(freeSeats(2, 1), 1);
    assert.equal(freeSeats(2, 2), 0);
    assert.equal(freeSeats(1, 3), 0);
  });

  test("PYRY_POLL_INTERVAL_MS sets the poll interval when it is a whole number at or above the floor", () => {
    assert.equal(resolvePollIntervalMs({ PYRY_POLL_INTERVAL_MS: "120000" }), 120_000);
    assert.equal(resolvePollIntervalMs({ PYRY_POLL_INTERVAL_MS: "10000" }), 10_000);
  });

  test("PYRY_POLL_INTERVAL_MS keeps the 60s default when unset, empty, not plain digits or below the floor", () => {
    assert.equal(DEFAULT_POLL_INTERVAL_MS, 60_000);
    for (const value of [undefined, "", "  ", "abc", "60.5", "0", "-5", "9999", "1e4", "+120000"]) {
      assert.equal(resolvePollIntervalMs({ PYRY_POLL_INTERVAL_MS: value }), 60_000, `value ${JSON.stringify(value)}`);
    }
  });

  test("candidateKey names the run by agent and ticket", () => {
    assert.equal(candidateKey("builder", 590), "builder#590");
  });

  test("excludeInFlight drops a candidate a stale snapshot would pick twice", () => {
    const c = (name: string, n: number) => ({ agent: { name }, item: { issueNumber: n } });
    const out = excludeInFlight([c("verifier", 782), c("builder", 590), c("refiner", 652)], new Set(["builder#590"]));
    assert.deepStrictEqual(out.map((x) => candidateKey(x.agent.name, x.item.issueNumber)), ["verifier#782", "refiner#652"]);
  });

  test("launch tracks a run until it settles, and anySettled wakes on the first to finish", async () => {
    const pool = new DispatchPool();
    const slow = deferred();
    const fast = deferred();
    pool.launch("verifier#782", () => slow.promise);
    pool.launch("refiner#590", () => fast.promise);
    assert.equal(pool.size, 2);
    assert.deepStrictEqual([...pool.keys()].sort(), ["refiner#590", "verifier#782"]);

    let woke = false;
    const wake = pool.anySettled().then(() => { woke = true; });
    await tick();
    assert.equal(woke, false, "nothing settled yet");

    fast.resolve();
    await wake;
    assert.equal(woke, true);
    assert.equal(pool.size, 1, "the fast run left the pool while the slow one stays");
    assert.equal(pool.has("verifier#782"), true);
    assert.equal(pool.has("refiner#590"), false);

    slow.resolve();
    await pool.drain();
    assert.equal(pool.size, 0);
  });

  test("a rejected run still frees its seat and wakes the loop", async () => {
    const pool = new DispatchPool();
    const failing = deferred();
    pool.launch("builder#1", () => failing.promise);
    const wake = pool.anySettled();
    failing.reject(new Error("boom"));
    await wake;
    assert.equal(pool.size, 0);
  });

  test("drain resolves at once when idle and waits for every run when busy", async () => {
    const pool = new DispatchPool();
    await pool.drain();
    const a = deferred();
    const b = deferred();
    pool.launch("a#1", () => a.promise);
    pool.launch("b#2", () => b.promise);
    let drained = false;
    const d = pool.drain().then(() => { drained = true; });
    a.resolve();
    await tick();
    assert.equal(drained, false, "one run still in flight");
    b.resolve();
    await d;
    assert.equal(drained, true);
  });

  test("launching a key already in flight is refused", () => {
    const pool = new DispatchPool();
    const never = deferred();
    pool.launch("builder#7", () => never.promise);
    assert.throws(() => pool.launch("builder#7", () => never.promise), /already in flight/);
    never.resolve();
  });
});

describe("launchCandidates — no new run once draining (2026-10-05)", () => {
  const builder = { agent: { name: "builder" }, item: { issueNumber: 1724 } };
  const verifier = { agent: { name: "verifier" }, item: { issueNumber: 1725 } };

  // Desktop board on pyrybox, 2026-10-05: the stop signal landed at
  // 21:49:52 while a cycle was already past its top-of-loop drain check.
  // Eight seconds later that cycle selected a builder rework and started
  // it beside the one run still in flight.
  test("a stop signal that arrives mid-cycle launches nothing and leaves the board untouched", async () => {
    const pool = new DispatchPool();
    const inFlight = deferred();
    pool.launch("verifier#1700", () => inFlight.promise);

    let claimed = 0;
    let ran = 0;
    const launched = await launchCandidates({
      candidates: [builder],
      pool,
      draining: () => true,
      claim: async () => { claimed++; },
      release: async () => {},
      run: async () => { ran++; },
    });
    await tick();

    assert.equal(launched, 0);
    assert.equal(claimed, 0, "no running label or family counter is written for a run that will not start");
    assert.equal(ran, 0);
    assert.deepEqual([...pool.keys()], ["verifier#1700"], "only the run already in flight stays");
    inFlight.resolve();
    await pool.drain();
  });

  // The window PR #150 left open: the signal lands while the running label
  // is being written. The claim is undone, nothing is counted, and neither
  // that candidate nor the next one starts.
  test("a stop signal that lands during a candidate's claim undoes that claim and starts nothing", async () => {
    const pool = new DispatchPool();
    let draining = false;
    const claimed: number[] = [];
    const released: Array<{ issue: number; claim: string }> = [];
    const committed: number[] = [];
    let ran = 0;
    const launched = await launchCandidates({
      candidates: [builder, verifier],
      pool,
      draining: () => draining,
      claim: async (c) => { claimed.push(c.item.issueNumber); draining = true; return `claim-${c.item.issueNumber}`; },
      release: async (c, claim) => { released.push({ issue: c.item.issueNumber, claim }); },
      commit: async (c) => { committed.push(c.item.issueNumber); },
      run: async () => { ran++; },
    });
    await tick();

    assert.equal(launched, 0);
    assert.deepEqual(claimed, [1724], "the next candidate is not claimed");
    assert.deepEqual(released, [{ issue: 1724, claim: "claim-1724" }], "the claim is undone with what it wrote");
    assert.deepEqual(committed, [], "no family dispatch is counted for a run that did not start");
    assert.equal(ran, 0);
    assert.equal(pool.size, 0);
  });

  test("without a stop signal every candidate is claimed, counted and launched in turn", async () => {
    const pool = new DispatchPool();
    const runs = [deferred(), deferred()];
    const candidates = [builder, verifier];
    const order: string[] = [];
    const launched = await launchCandidates({
      candidates,
      pool,
      draining: () => false,
      claim: async (c) => { order.push(`claim ${c.item.issueNumber}`); },
      release: async () => { throw new Error("nothing to undo"); },
      commit: async (c) => { order.push(`count ${c.item.issueNumber}`); },
      run: (c) => runs[candidates.indexOf(c)]!.promise,
    });

    assert.equal(launched, 2);
    assert.deepEqual(order, ["claim 1724", "count 1724", "claim 1725", "count 1725"]);
    assert.deepEqual([...pool.keys()], ["builder#1724", "verifier#1725"]);
    for (const r of runs) r.resolve();
    await pool.drain();
  });
});

// PR #150 stopped new agent runs once the stop signal arrives, but the live
// test gate and the main-branch sweep could still start in that same round.
describe("the live gate and the main sweep do not start once draining", () => {
  const runner = { name: "live gate" };

  test("the live gate gets no runner while draining, as when the environment or a health check holds it", () => {
    assert.equal(liveGateRunnerFor({ runner, draining: false, envHeld: false, healthFailures: 0 }), runner);
    assert.equal(liveGateRunnerFor({ runner, draining: true, envHeld: false, healthFailures: 0 }), null);
    assert.equal(liveGateRunnerFor({ runner, draining: false, envHeld: true, healthFailures: 0 }), null);
    assert.equal(liveGateRunnerFor({ runner, draining: false, envHeld: false, healthFailures: 1 }), null);
    assert.equal(liveGateRunnerFor({ runner: null, draining: false, envHeld: false, healthFailures: 0 }), null);
  });

  test("the main sweep does not start while draining", () => {
    const ready = { configured: true, sweepRunning: false, gateActive: false, envHeld: false, draining: false };
    assert.equal(mayStartMainSweep(ready), true);
    assert.equal(mayStartMainSweep({ ...ready, draining: true }), false);
    assert.equal(mayStartMainSweep({ ...ready, configured: false }), false);
    assert.equal(mayStartMainSweep({ ...ready, sweepRunning: true }), false);
    assert.equal(mayStartMainSweep({ ...ready, gateActive: true }), false);
    assert.equal(mayStartMainSweep({ ...ready, envHeld: true }), false);
  });
});
