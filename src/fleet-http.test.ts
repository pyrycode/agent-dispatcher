import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetStore } from "./fleet-store.js";
import { serveFleet, FleetClient } from "./fleet-http.js";

test("authenticated HTTP contention and recovery preserve exactly one owner", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 }, linux: { heavyLimit: 1, combinedLimit: 1 } });
  const server = await serveFleet(store, { mac: "mac-secret", linux: "linux-secret" }, "admin-secret", 0);
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); store.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const mac = new FleetClient(url, "mac-secret"), linux = new FleetClient(url, "linux-secret");
  const base = { session: "s", project: "org/core", ticket: "org/core#1", role: "builder", resource: "heavy" as const, locks: [] };
  const results = await Promise.all([mac.start({ ...base, id: "a", machine: "mac" }), linux.start({ ...base, id: "b", machine: "linux" })]);
  assert.equal(results.filter(r => r.ok).length, 1);
  await assert.rejects(mac.start({ ...base, id: "bad", machine: "linux" }), /403/);
  await assert.rejects(new FleetClient(url, "wrong").snapshot(), /401/);
  await assert.rejects(mac.free(base.ticket, "g", true), /403/);
  const state = await mac.snapshot();
  const admin = new FleetClient(url, "admin-secret");
  await admin.free(base.ticket, state.claims[0].generation, true);
  assert.equal((await mac.snapshot()).claims.length, 0);
});

test("concurrent project requests cannot exceed either machine limit", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } });
  const server = await serveFleet(store, { mac: "mac-secret" }, "admin-secret", 0);
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); store.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new FleetClient(`http://127.0.0.1:${address.port}`, "mac-secret");
  const results = await Promise.all(["heavy", "heavy", "medium", "medium"].map((resource, n) => client.start({
    id: `job-${n}`, machine: "mac", session: "s", project: `org/project-${n}`, ticket: `org/project-${n}#1`, role: "test",
    resource: resource as "heavy" | "medium", locks: [],
  })));
  assert.equal(results.filter(r => r.ok).length, 2);
  const runs = (await client.snapshot()).runs;
  assert.equal(runs.length, 2);
  assert.ok(runs.filter(r => r.resource === "heavy").length <= 1);
  assert.equal((await client.start({ id: "light", machine: "mac", session: "s", project: "org/light", ticket: "org/light#1", role: "refiner", resource: "light", locks: [] })).ok, true);
});
