import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetStore } from "./fleet-store.js";
import { MachineManager } from "./machine-manager.js";
import type { WorkOffer } from "./machine-scheduler.js";

test("manager restart preserves reservations and grants only the original dispatcher session", async () => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 } });
  const client = { snapshot: async () => store.snapshot(), start: async (r: any) => store.start(r), finish: async (s: string, id: string) => store.finish("mac", s, id) };
  const offer: WorkOffer = { project: "org/core", ticket: "org/core#1", role: "builder", resource: "heavy", key: "offer", order: 0, locks: [] };
  const config = { machine: "mac", heavyLimit: 1, combinedLimit: 1, projects: ["org/core"] };
  let manager = new MachineManager(config, client);
  manager.offer("org/core", "session-a", [offer]);
  await manager.tick();
  const granted = await manager.grants("org/core", "session-a");
  assert.equal(granted.length, 1);
  manager = new MachineManager(config, client);
  manager.offer("org/core", "session-b", [offer]);
  await manager.tick();
  assert.equal((await manager.grants("org/core", "session-b")).length, 0);
  assert.equal(store.snapshot().runs.length, 1);
  store.close();
});

test("uncertain start response is retried with the same ID, never a second grant", async () => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 } });
  let fail = true;
  const client = { snapshot: async () => store.snapshot(), start: async (r: any) => {
    const result = store.start(r); if (fail) { fail = false; throw new Error("lost response"); } return result;
  }, finish: async (s: string, id: string) => store.finish("mac", s, id) };
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 1, projects: ["org/core"] }, client);
  manager.offer("org/core", "session", [{ project: "org/core", ticket: "org/core#1", role: "builder", resource: "heavy", key: "offer", order: 0, locks: [] }]);
  await assert.rejects(manager.tick(), /lost response/);
  await manager.tick();
  assert.equal((await manager.grants("org/core", "session")).length, 1);
  assert.equal(store.snapshot().runs.length, 1);
  store.close();
});

test("a completed shared check cannot keep hiding other work", async () => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 } });
  const project = "org/core";
  store.start({ id: "old", machine: "mac", session: "old", project, ticket: `${project}#@main-sweep-abc`, role: "main-sweep", resource: "heavy", locks: [] });
  store.finish("mac", "old", "old");
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 1, projects: [project] }, {
    snapshot: async () => store.snapshot(), start: async r => store.start(r), finish: async (s, id) => store.finish("mac", s, id),
  });
  manager.offer(project, "s", [
    { project, ticket: `${project}#@main-sweep-abc`, role: "main-sweep", resource: "heavy", locks: [], key: "sweep", order: 0 },
    { project, ticket: `${project}#1`, role: "builder", resource: "heavy", locks: [], key: "build", order: 1 },
  ]);
  await manager.tick();
  await manager.tick();
  assert.equal(store.snapshot().runs[0]?.ticket, `${project}#1`);
  store.close();
});

test("withdraw waits for an uncertain in-flight grant and returns it for cancellation", async () => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 } });
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  let started!: () => void;
  const starting = new Promise<void>(r => { started = r; });
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 1, projects: ["org/core"] }, {
    snapshot: async () => store.snapshot(), start: async r => { started(); await barrier; return store.start(r); }, finish: async (s, id) => store.finish("mac", s, id),
  });
  manager.offer("org/core", "s", [{ project: "org/core", ticket: "org/core#1", role: "builder", resource: "heavy", locks: [], key: "build", order: 0 }]);
  const tick = manager.tick();
  await starting;
  const withdrawal = manager.withdraw("org/core", "s");
  release();
  await tick;
  const runs = await withdrawal;
  assert.equal(runs.length, 1);
  await manager.finish("org/core", "s", runs[0].id, false);
  manager.offer("org/core", "new-session", []);
  assert.equal(store.snapshot().runs.length, 0);
  store.close();
});

test("manager rejects invalid claim budgets", () => {
  const client = { snapshot: async () => ({ claims: [], runs: [] }), start: async () => ({ ok: false as const, reason: "foreign-claim" as const }), finish: async () => {} };
  for (const ticketLimit of [0, -1, 1.5, NaN]) assert.throws(() => new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 2, projects: ["org/core"], ticketLimit }, client), /ticket limit/);
});
test("manager enforces the cap over repeated polls and returns space after completion", async () => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } });
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 2, ticketLimit: 2, projects: ["org/core", "org/mobile"] }, {
    snapshot: async () => store.snapshot(), start: async r => store.start(r), finish: async (s, id) => store.finish("mac", s, id),
  });
  const work = (project: string, n: number): WorkOffer => ({ project, ticket: `${project}#${n}`, role: "refiner", resource: "light", key: `${n}`, order: n, locks: [] });
  manager.offer("org/core", "s", [work("org/core", 1)]);
  manager.offer("org/mobile", "m", [work("org/mobile", 2), work("org/mobile", 3)]);
  await manager.tick(); await manager.tick();
  assert.equal(store.snapshot().runs.length, 2);
  assert.equal((await manager.status()).runnableTicketCount, 2);
  const run = store.snapshot().runs.find(r => r.project === "org/core")!;
  await manager.finish("org/core", "s", run.id);
  manager.offer("org/core", "s", []);
  await manager.tick();
  assert.deepEqual(store.snapshot().runs.map(r => r.ticket).sort(), ["org/mobile#2", "org/mobile#3"]);
  assert.equal(store.snapshot().claims.length, 3); // Done claims remain reserved.
  store.close();
});
