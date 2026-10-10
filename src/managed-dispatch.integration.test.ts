import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { FleetStore } from "./fleet-store.js";
import { FleetClient, serveFleet } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { ManagedDispatch, trackManagedChild } from "./managed-dispatch.js";
import type { Server } from "node:http";
import type { ProjectItem } from "./types.js";

const url = (server: Server) => {
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("Server did not listen");
  return `http://127.0.0.1:${a.port}`;
};
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

test("real manager grants cover workflow writes and remain occupied until the child group exits", async t => {
  const store = new FleetStore(":memory:", { mac: 1, linux: 1 });
  const claimsServer = await serveFleet(store, { mac: "mac-test", linux: "linux-test" }, "admin-test", 0);
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, projects: ["org/core"] }, new FleetClient(url(claimsServer), "mac-test"));
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
