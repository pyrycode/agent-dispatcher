import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { FleetStore } from "./fleet-store.js";
import { FleetClient, JsonClient, serveFleet } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { ManagedDispatch } from "./managed-dispatch.js";

test("container clients share host capacity through an authenticated filesystem socket", async t => {
  // Short path also fits macOS's Unix socket path limit.
  const dir = mkdtempSync("/tmp/fleet-");
  const socket = join(dir, "manager.sock");
  const store = new FleetStore(":memory:", { box: { heavyLimit: 1, combinedLimit: 2 } });
  const claims = await serveFleet(store, { box: "box-token" }, "claims-operator", 0);
  const address = claims.address();
  assert.ok(address && typeof address !== "string");
  const manager = new MachineManager({ machine: "box", heavyLimit: 1, combinedLimit: 2, projects: ["org/core", "org/desktop"] },
    new FleetClient(`http://127.0.0.1:${address.port}`, "box-token"));
  const server = await serveManager(manager, { "org/core": "core-token", "org/desktop": "desktop-token" }, "manager-operator", socket);
  const core = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: `unix://${socket}`, PYRY_MANAGER_TOKEN: "core-token" });
  const desktop = new ManagedDispatch("org/desktop", { PYRY_MANAGER_URL: `unix://${socket}`, PYRY_MANAGER_TOKEN: "desktop-token" });
  t.after(async () => {
    await core.stop(); await desktop.stop();
    await new Promise<void>(r => server.close(() => r()));
    await new Promise<void>(r => claims.close(() => r()));
    store.close(); rmSync(dir, { recursive: true });
  });
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  await assert.rejects(new JsonClient(`unix://${socket}`, "wrong").call("/state"), /401/);
  await assert.rejects(new JsonClient(`unix://${socket}`, "core-token").call("/drain", {}), /403/);
  await assert.rejects(new JsonClient(`unix://${socket}`, "core-token").call("/offers", {
    session: "wrong-project", offers: [{ project: "org/desktop", ticket: "org/desktop#1", key: "k", role: "builder", resource: "medium", locks: [], order: 0 }],
  }), /409/);
  core.beginCycle(); desktop.beginCycle();
  const heavy = core.offer(1, "verifier", "heavy");
  const medium = desktop.offer(1, "builder", "medium");
  const waiting = desktop.offer(2, "builder", "medium");
  const light = desktop.offer(3, "refiner", "light");
  await core.endCycle(); await desktop.endCycle(); await manager.tick();
  await core.sync(); await desktop.sync();
  assert.equal(core.ready(heavy), true);
  assert.equal(desktop.ready(medium), true);
  assert.equal(desktop.ready(waiting), false);
  assert.equal(desktop.ready(light), true);
});

test("socket client rejects redirects and malformed socket addresses", async t => {
  for (const url of ["unix://host/tmp/a", "unix:///", "unix:///tmp/a?token=x", "unix:///tmp/a#x"]) {
    assert.throws(() => new JsonClient(url, "token"), /Invalid/);
  }
  const dir = mkdtempSync("/tmp/fleet-");
  const socket = join(dir, "redirect.sock");
  const server = createServer((_req, res) => { res.writeHead(302, { Location: "http://127.0.0.1:1" }); res.end("{}"); });
  await new Promise<void>(r => server.listen(socket, r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true }); });
  await assert.rejects(new JsonClient(`unix://${socket}`, "token").call("/state"), /Service 302/);
});
