import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLL_INTERVAL_MS, DispatchPool, candidateKey, excludeInFlight, freeSeats, launchCandidates, resolvePollIntervalMs } from "./dispatch-pool.js";

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

  // Desktop board on pyrybox, 2026-10-05: the stop signal landed at
  // 21:49:52 while a cycle was already past its top-of-loop drain check.
  // Eight seconds later that cycle selected a builder rework and started
  // it beside the one run still in flight.
  test("a stop signal that arrives mid-cycle launches nothing and leaves the board untouched", async () => {
    const pool = new DispatchPool();
    const inFlight = deferred();
    pool.launch("verifier#1700", () => inFlight.promise);

    let prepped = 0;
    let ran = 0;
    const launched = await launchCandidates({
      candidates: [builder],
      pool,
      draining: () => true,
      prep: async () => { prepped++; },
      run: async () => { ran++; },
    });
    await tick();

    assert.equal(launched, 0);
    assert.equal(prepped, 0, "no running label or family counter is written for a run that will not start");
    assert.equal(ran, 0);
    assert.deepEqual([...pool.keys()], ["verifier#1700"], "only the run already in flight stays");
    inFlight.resolve();
    await pool.drain();
  });

  test("without a stop signal every candidate is prepared and launched", async () => {
    const pool = new DispatchPool();
    const runs = [deferred(), deferred()];
    const candidates = [builder, { agent: { name: "verifier" }, item: { issueNumber: 1725 } }];
    const prepared: number[] = [];
    const launched = await launchCandidates({
      candidates,
      pool,
      draining: () => false,
      prep: async (cs) => { prepared.push(...cs.map((c) => c.item.issueNumber)); },
      run: (c) => runs[candidates.indexOf(c)]!.promise,
    });

    assert.equal(launched, 2);
    assert.deepEqual(prepared, [1724, 1725]);
    assert.deepEqual([...pool.keys()], ["builder#1724", "verifier#1725"]);
    for (const r of runs) r.resolve();
    await pool.drain();
  });
});
