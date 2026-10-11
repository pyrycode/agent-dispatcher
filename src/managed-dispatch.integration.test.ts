import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { FleetStore } from "./fleet-store.js";
import { FleetClient, serveFleet } from "./fleet-http.js";
import { MachineManager, offerId, serveManager } from "./machine-manager.js";
import { ManagedDispatch, trackManagedChild } from "./managed-dispatch.js";
import type { Server } from "node:http";
import type { ProjectItem } from "./types.js";

const url = (server: Server) => {
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("Server did not listen");
  return `http://127.0.0.1:${a.port}`;
};
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

test("a cancelled stale stage offer cannot outrank a higher-priority ticket", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 } });
  const claimsServer = await serveFleet(store, { mac: "mac-test" }, "admin-test", 0);
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 1, projects: ["org/core"] }, new FleetClient(url(claimsServer), "mac-test"));
  const managerServer = await serveManager(manager, { "org/core": "project-test" }, "operator-test", 0);
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: url(managerServer), PYRY_MANAGER_TOKEN: "project-test" });
  t.after(async () => { await managed.stop(); await close(managerServer); await close(claimsServer); store.close(); });
  await managed.start();
  managed.beginCycle();
  managed.offer(3086, "verifier", "heavy");
  await managed.endCycle();
  await manager.tick();
  await managed.sync();
  managed.beginCycle();
  const first = managed.offer(3088, "verifier", "heavy", [], 0);
  managed.offer(3086, "builder", "medium", [], 1);
  await managed.endCycle();
  await manager.tick();
  await managed.sync();
  assert.equal(managed.ready(first), true);
  assert.equal(store.snapshot().claims.some(c => c.ticket === "org/core#3086"), false);
  await managed.stop();
  assert.deepEqual(store.snapshot(), { claims: [], runs: [] });
});

test("real manager grants cover workflow writes and remain occupied until the child group exits", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 }, linux: { heavyLimit: 1, combinedLimit: 1 } });
  const claimsServer = await serveFleet(store, { mac: "mac-test", linux: "linux-test" }, "admin-test", 0);
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 1, projects: ["org/core"] }, new FleetClient(url(claimsServer), "mac-test"));
  const managerServer = await serveManager(manager, { "org/core": "project-test" }, "operator-test", 0);
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: url(managerServer), PYRY_MANAGER_TOKEN: "project-test" });
  t.after(async () => { await managed.stop(); await close(managerServer); await close(claimsServer); store.close(); });
  await managed.start();
  managed.beginCycle();
  const pending = managed.offer(1, "builder", "heavy");
  await managed.endCycle();
  await manager.tick();
  await managed.sync();
  assert.equal(managed.ready(pending), true);
  let writes = 0;
  const items = [1, 2].map(n => ({ id: `item-${n}`, issueNumber: n }) as ProjectItem);
  const base = { getAllProjectItems: async () => items, addLabel: async (_n: number, _l: string) => { writes++; } };
  const client = managed.client(base);
  await assert.rejects(client.addLabel(1, "done:builder"), /active run/);
  assert.equal(writes, 0);
  store.start({ id: "foreign", machine: "linux", session: "linux-session", project: "org/core", ticket: "org/core#2", role: "builder", resource: "heavy", locks: [] });
  await managed.sync();
  assert.deepEqual((await client.getAllProjectItems()).map(i => i.issueNumber), [1]);
  assert.deepEqual(await managed.client(base, true).getAllProjectItems(), []);
  let finished = false;
  const run = managed.run(pending, async () => {
    await client.addLabel(1, "done:builder");
    const child = spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], {stdio: 'ignore'}).unref()"], { detached: true, stdio: "ignore" });
    assert.ok(child.pid);
    trackManagedChild(child.pid);
    await once(child, "exit");
  }).then(() => { finished = true; });
  await sleep(100);
  assert.equal(writes, 1);
  assert.equal(finished, false);
  assert.equal(store.snapshot().runs.filter(r => r.machine === "mac").length, 1);
  await run;
  assert.equal(store.snapshot().runs.filter(r => r.machine === "mac").length, 0);
  assert.equal(store.snapshot().claims.find(c => c.ticket === "org/core#1")?.machine, "mac");
});

test("a builder admission committed after its Backlog handback is cancelled before refinement starts", async t => {
  const project = "org/core";
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 } });
  store.start({ id: "original-builder", machine: "mac", session: "original-session", project,
    ticket: `${project}#1905`, role: "builder", resource: "medium", locks: [] });
  store.finish("mac", "original-session", "original-builder");
  const originalClaim = store.snapshot().claims[0];
  let admit!: () => void, started!: () => void;
  const admission = new Promise<void>(resolve => { admit = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 1, projects: [project] }, {
    snapshot: async () => store.snapshot(),
    start: async request => { started(); await admission; return store.start(request); },
    finish: async (session, id, completed, unused) => store.finish("mac", session, id, completed, unused),
  });
  const server = await serveManager(manager, { [project]: "project-test" }, "operator-test", 0);
  const managed = new ManagedDispatch(project, { PYRY_MANAGER_URL: url(server), PYRY_MANAGER_TOKEN: "project-test" });
  t.after(async () => { admit(); await managed.stop(); await close(server); store.close(); });
  await managed.sync();
  managed.beginCycle(); managed.offer(1905, "builder", "medium"); await managed.endCycle();
  const tick = manager.tick(); await requested;
  // The completed builder has returned the card to Backlog before its stale
  // admission commits. The dispatcher never received or launched that grant.
  managed.beginCycle(); const refiner = managed.offer(1905, "refiner", "light"); await managed.endCycle();
  admit(); await tick;
  assert.equal(store.snapshot().runs[0].role, "builder", "reproduce the late stale-stage grant");
  await managed.sync();
  assert.equal(store.snapshot().runs.length, 0, "the live session can prove this exact grant never launched");
  assert.deepEqual(store.snapshot().claims, [originalClaim]);
  await manager.tick(); await managed.sync();
  assert.equal(managed.ready(refiner), true, "refinement gets normal admission after cancellation");
  let refinements = 0;
  await managed.run(refiner, async () => { refinements++; });
  assert.equal(refinements, 1);
  assert.deepEqual(store.snapshot().claims, [originalClaim]);
});

test("an unseen grant retains old-session ownership while same-session cancellation retries after failure", async t => {
  const project = "org/core";
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 2, combinedLimit: 2 } });
  let unavailable = true;
  const manager = new MachineManager({ machine: "mac", heavyLimit: 2, combinedLimit: 2, projects: [project] }, {
    snapshot: async () => store.snapshot(), start: async request => store.start(request),
    finish: async (session, id, completed, unused) => {
      if (unavailable) throw new Error("temporary service outage");
      store.finish("mac", session, id, completed, unused);
    },
  });
  const server = await serveManager(manager, { [project]: "project-test" }, "operator-test", 0);
  const managed = new ManagedDispatch(project, { PYRY_MANAGER_URL: url(server), PYRY_MANAGER_TOKEN: "project-test" });
  t.after(async () => { unavailable = false; await managed.stop(); await close(server); store.close(); });
  const stale = { project, ticket: `${project}#1`, role: "builder", resource: "medium" as const, locks: [], key: "withdrawn", order: 0 };
  store.start({ ...stale, id: offerId("mac", managed.session, stale), machine: "mac", session: managed.session });
  store.start({ id: "uncertain", machine: "mac", session: "previous-session", project,
    ticket: `${project}#2`, role: "builder", resource: "medium", locks: [] });
  const before = store.snapshot();
  await assert.rejects(managed.sync(), /temporary service outage/);
  assert.deepEqual(store.snapshot(), before, "failure must retain the exact reservation for retry");
  unavailable = false; await managed.sync();
  assert.deepEqual(store.snapshot().runs, before.runs.filter(r => r.id === "uncertain"));
  assert.deepEqual(store.snapshot().claims, before.claims.filter(c => c.ticket === `${project}#2`));
});
