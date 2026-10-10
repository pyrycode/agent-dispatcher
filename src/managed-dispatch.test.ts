import { test } from "node:test";
import assert from "node:assert/strict";
import { ManagedDispatch, resourceClasses } from "./managed-dispatch.js";

test("resource classification rejects typos instead of treating them as light", () => {
  assert.deepEqual(resourceClasses(undefined), {});
  assert.deepEqual(resourceClasses('{"refiner":"light","builder":"heavy"}'), { refiner: "light", builder: "heavy" });
  assert.throws(() => resourceClasses('{"builder":"hevy"}'));
});
test("partial manager configuration never falls back to independent dispatch", () => {
  assert.equal(ManagedDispatch.fromEnv({}), null);
  assert.throws(() => ManagedDispatch.fromEnv({ PYRY_MANAGER_URL: "http://localhost:1" }));
  assert.throws(() => ManagedDispatch.fromEnv({ PYRY_MANAGED: "1" }));
});
test("managed client preserves synchronous helpers and rejects unseen item writes", async () => {
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test" });
  const base = { getRateLimit: () => ({ remaining: 42 }), updateItemStatus: async () => {}, clearItemsCache: () => {} };
  const client = managed.client(base);
  assert.deepEqual(client.getRateLimit(), { remaining: 42 });
  assert.equal(client.clearItemsCache(), undefined);
  await assert.rejects(client.updateItemStatus(), /outside the managed snapshot/);
});

test("ungranted offers follow updated ticket order without changing identity", () => {
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test" });
  const first = managed.offer(1, "builder", "heavy", [], 4);
  const next = managed.offer(1, "builder", "heavy", [], 0);
  assert.equal(first.offer.key, next.offer.key);
  assert.equal(next.offer.order, 0);
});

test("build agents default to medium and refinement to light, with explicit overrides", () => {
  const env = { PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test" };
  const managed = new ManagedDispatch("org/core", env);
  const item = { issueNumber: 1 } as any;
  for (const [name, resource] of [["builder", "medium"], ["developer", "medium"], ["refiner", "light"], ["po", "light"], ["verifier", "heavy"], ["documentation", "heavy"], ["unknown", "heavy"]]) {
    assert.equal(managed.agentOffer({ name } as any, item, 0).offer.resource, resource, name);
  }
  const override = new ManagedDispatch("org/core", { ...env, PYRY_RESOURCE_CLASSES: '{"builder":"heavy","documentation":"medium"}' });
  assert.equal(override.agentOffer({ name: "builder" } as any, item, 0).offer.resource, "heavy");
  assert.equal(override.agentOffer({ name: "documentation" } as any, item, 0).offer.resource, "medium");
});
