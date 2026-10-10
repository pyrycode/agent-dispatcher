import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FleetStore } from "./fleet-store.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { JsonClient } from "./fleet-http.js";
import { persistProjectDrains } from "./fleet-config.js";
import type { WorkOffer } from "./machine-scheduler.js";

const mobile = "org/mobile", core = "org/core";
const offer = (project: string, ticket: string, role = "builder"): WorkOffer => ({
  project, ticket: `${project}#${ticket}`, role, resource: "light", key: `${ticket}-${role}`, order: 0, locks: role === "reconcile" ? [`${project}:reconcile`] : [],
});
function fixture() {
  const store = new FleetStore(":memory:", { hp: { heavyLimit: 1, combinedLimit: 2 } });
  const client = { snapshot: async () => store.snapshot(), start: async (r: any) => store.start(r),
    finish: async (s: string, id: string) => store.finish("hp", s, id) };
  const config = { machine: "hp", projects: [core, mobile], heavyLimit: 1, combinedLimit: 2 };
  return { store, client, config };
}

test("project drain finishes owned tickets through every stage and keeps other projects open", async t => {
  const { store, client, config } = fixture(); t.after(() => store.close());
  store.start({ ...offer(mobile, "1"), id: "old", machine: "hp", session: "old" });
  store.finish("hp", "old", "old");
  let manager = new MachineManager(config, client);
  let persisted: string[] = [];
  await manager.setProjectDraining(mobile, true, projects => { persisted = projects; });
  // Reloading a saved policy must not enable new work.
  manager = new MachineManager({ ...config, drainingProjects: persisted }, client);
  for (const role of ["builder", "verifier", "documentation", "merge"]) {
    manager.offer(mobile, "s", [offer(mobile, "1", role), offer(mobile, "2", role)]);
    await manager.tick();
    const grants = await manager.grants(mobile, "s");
    assert.deepEqual(grants.map(r => r.ticket), [`${mobile}#1`]);
    await manager.finish(mobile, "s", grants[0].id);
  }
  manager.offer(core, "c", [offer(core, "3")]);
  await manager.tick();
  assert.equal((await manager.grants(core, "c")).length, 1);
  const status = await manager.status();
  assert.equal(status.projects.find(p => p.project === mobile)?.draining, true);
  assert.equal(status.queue.find(o => o.ticket === `${mobile}#2`)?.state, "project-draining");
  assert.equal(store.snapshot().claims.some(c => c.ticket === `${mobile}#2`), false);
});

test("drained projects retain blocked claims and reconcile but cannot start a main sweep", async t => {
  const { store, client, config } = fixture(); t.after(() => store.close());
  for (const ticket of ["1", "@main-sweep-old"]) {
    store.start({ ...offer(mobile, ticket), id: ticket, machine: "hp", session: "old" });
    store.finish("hp", "old", ticket);
  }
  const manager = new MachineManager({ ...config, drainingProjects: [mobile] }, client);
  manager.offer(mobile, "s", [offer(mobile, "@reconcile", "reconcile"), offer(mobile, "@main-sweep-old", "main-sweep"), offer(mobile, "@main-sweep-new", "main-sweep")]);
  await manager.tick();
  const grants = await manager.grants(mobile, "s");
  assert.deepEqual(grants.map(r => r.role), ["reconcile"]);
  await manager.finish(mobile, "s", grants[0].id);
  // A blocker disappears in a later cycle; the original claim can continue.
  manager.offer(mobile, "s", [offer(mobile, "1", "verifier")]);
  await manager.tick();
  assert.equal((await manager.grants(mobile, "s")).length, 1);
});

test("project drain waits for an in-flight start and denies further starts before returning", async t => {
  const { store, client, config } = fixture(); t.after(() => store.close());
  let release!: () => void, started!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const starting = new Promise<void>(r => { started = r; });
  const manager = new MachineManager(config, { ...client, start: async r => { started(); await barrier; return store.start(r); } });
  manager.offer(mobile, "s", [offer(mobile, "1"), offer(mobile, "2")]);
  const tick = manager.tick(); await starting;
  let returned = false;
  const drain = manager.setProjectDraining(mobile, true, () => {}).then(() => { returned = true; });
  await Promise.resolve(); assert.equal(returned, false);
  release(); await tick; await drain;
  assert.deepEqual(store.snapshot().runs.map(r => r.ticket), [`${mobile}#1`]);
});

test("operator-only project drain persists atomically and can be resumed", async t => {
  const { store, client, config } = fixture();
  const dir = mkdtempSync("/tmp/drain-");
  const path = join(dir, "manager.json");
  writeFileSync(path, JSON.stringify({ ...config, projects: [{ repo: mobile, tokenEnv: "MOBILE_TOKEN" }], custom: "preserved" }));
  const manager = new MachineManager(config, client);
  const server = await serveManager(manager, { [mobile]: "mobile-token" }, "operator-token", join(dir, "manager.sock"), "127.0.0.1", projects => persistProjectDrains(path, projects));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(dir, { recursive: true }); });
  const admin = new JsonClient(`unix://${join(dir, "manager.sock")}`, "operator-token");
  await assert.rejects(new JsonClient(`unix://${join(dir, "manager.sock")}`, "mobile-token").call("/project-drain", { project: mobile, draining: true }), /403/);
  await assert.rejects(admin.call("/project-drain", { project: "unknown", draining: true }), /409/);
  await assert.rejects(admin.call("/project-drain", { project: mobile, draining: "false" }), /409/);
  await admin.call("/project-drain", { project: mobile, draining: true });
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(saved.drainingProjects, [mobile]);
  assert.equal(saved.custom, "preserved");
  assert.deepEqual(saved.projects, [{ repo: mobile, tokenEnv: "MOBILE_TOKEN" }]);
  await admin.call("/project-drain", { project: mobile, draining: false });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).drainingProjects, []);
  manager.offer(mobile, "s", [offer(mobile, "9")]); await manager.tick();
  assert.equal((await manager.grants(mobile, "s")).length, 1);
});

test("failed persistence leaves admission unchanged and invalid saved projects are rejected", async t => {
  const { store, client, config } = fixture(); t.after(() => store.close());
  const manager = new MachineManager(config, client);
  await assert.rejects(manager.setProjectDraining(mobile, true, () => { throw new Error("disk unavailable"); }), /disk unavailable/);
  manager.offer(mobile, "s", [offer(mobile, "1")]); await manager.tick();
  assert.equal((await manager.grants(mobile, "s")).length, 1);
  assert.throws(() => new MachineManager({ ...config, drainingProjects: ["unknown"] }, client), /Invalid.*drain/);
});
