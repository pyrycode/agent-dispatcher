import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { DispatchPool, candidateKey, excludeInFlight, freeSeats } from "./dispatch-pool.js";

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
