import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { FleetStore } from "./fleet-store.js";
import { FleetClient, serveFleet } from "./fleet-http.js";
import { MachineManager, offerId, serveManager } from "./machine-manager.js";
import { ManagedDispatch, managedRunRunner, trackManagedChild } from "./managed-dispatch.js";
import { createRunnerSelector } from './runner-file.js';
import type { Server } from "node:http";
import type { ProjectItem } from "./types.js";

const url = (server: Server) => {
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("Server did not listen");
  return `http://127.0.0.1:${a.port}`;
};
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

test('one central runner reaches every role and computer without replacing an active run', async t => {
  const store = new FleetStore(':memory:', { mac: { heavyLimit: 2, combinedLimit: 2 }, linux: { heavyLimit: 2, combinedLimit: 2 } });
  const claimsServer = await serveFleet(store, { mac: 'mac-test', linux: 'linux-test' }, 'admin-test', 0);
  const instances: Array<{ manager: MachineManager; server: Server; managed: ManagedDispatch; env: NodeJS.ProcessEnv }> = [];
  t.after(async () => {
    for (const instance of instances) { await instance.managed.stop(); await close(instance.server); }
    await close(claimsServer); store.close();
  });
  for (const machine of ['mac', 'linux']) {
    const project = `org/${machine}`;
    const manager = new MachineManager({ machine, heavyLimit: 2, combinedLimit: 2, projects: [project] }, new FleetClient(url(claimsServer), `${machine}-test`));
    const server = await serveManager(manager, { [project]: 'project-test' }, 'operator-test', 0);
    const env = { GITHUB_OWNER: 'org', GITHUB_REPO: machine, PYRY_MANAGER_URL: url(server), PYRY_MANAGER_TOKEN: 'project-test' };
    const managed = new ManagedDispatch(project, env);
    instances.push({ manager, server, managed, env });
    await managed.start();
  }
  const select = createRunnerSelector({ path: '/unused/runner.json', env: { PYRY_AGENT_RUNNER: 'claude' }, override: managedRunRunner,
    read: () => '{"runner":"claude","roles":{"verifier":"claude","recovery":"claude"}}' });
  assert.equal(select('builder'), 'claude', 'unmanaged selection remains local');
  store.setRunner('codex');
  for (const { manager, managed, env } of instances) {
    await managed.sync();
    assert.equal(managed.runner(), 'codex', 'health checks see the central choice');
    assert.equal(await ManagedDispatch.runnerFromEnv(env), 'codex', 'startup validation uses the central choice');
    let issue = 1;
    for (const role of ['po', 'architect', 'developer', 'qa', 'code-review', 'refiner', 'builder', 'verifier', 'documentation', 'recovery']) {
      managed.beginCycle();
      const offer = managed.offer(issue++, role, role === 'recovery' ? 'heavy' : 'light');
      await managed.endCycle(); await manager.tick(); await managed.sync();
      assert.equal(managed.ready(offer), true, role);
      await managed.run(offer, async () => assert.equal(select(role), 'codex', role));
    }
  }
  const first = instances[0];
  first.managed.beginCycle();
  const active = first.managed.offer(100, 'builder', 'medium');
  await first.managed.endCycle(); await first.manager.tick(); await first.managed.sync();
  await first.managed.run(active, async () => {
    assert.equal(select('builder'), 'codex');
    store.setRunner('claude');
    await first.managed.sync();
    assert.equal(first.managed.runner(), 'codex', 'active health and launch phases retain their admitted runner');
    assert.equal(select('builder'), 'codex', 'continuation retains the active selection');
    const second = instances[1];
    second.managed.beginCycle();
    const fresh = second.managed.offer(100, 'builder', 'medium');
    await second.managed.endCycle(); await second.manager.tick(); await second.managed.sync();
    await second.managed.run(fresh, async () => assert.equal(select('builder'), 'claude', 'a new grant uses the new choice'));
    assert.equal(select('builder'), 'codex', 'another concurrent run cannot replace this context');
  });
  assert.equal(first.managed.runner(), 'claude', 'idle health checks follow the latest setting');
  store.setRunner(null); await first.managed.sync();
  assert.equal(first.managed.runner(), undefined, 'local restores existing per-role selection');
});

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
  managed.beginCycle(); const refiner = managed.offer(1905, "refiner", "light");
  const transition = managed.endCycle();
  admit(); await tick; await transition;
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


test("stage withdrawal recovers a grant committed before the dispatcher received it", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } });
  const claimsServer = await serveFleet(store, { mac: "mac-test" }, "admin-test", 0);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  const client = new FleetClient(url(claimsServer), "mac-test");
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 2, projects: ["org/core"] }, {
    snapshot: () => client.snapshot(),
    start: async request => { started(); await barrier; return client.start(request); },
    finish: (...args) => client.finish(...args),
  });
  const managerServer = await serveManager(manager, { "org/core": "project-test" }, "operator-test", 0);
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: url(managerServer), PYRY_MANAGER_TOKEN: "project-test" });
  t.after(async () => { release(); await managed.stop(); await close(managerServer); await close(claimsServer); store.close(); });
  await managed.start();
  managed.beginCycle();
  managed.offer(3089, "verifier", "heavy");
  await managed.endCycle();
  const tick = manager.tick();
  await starting;
  managed.beginCycle();
  const builder = managed.offer(3089, "builder", "medium");
  const transition = managed.endCycle();
  release();
  await tick;
  await transition;
  assert.equal(store.snapshot().runs.some(run => run.role === "verifier"), false);
  await manager.tick();
  await managed.sync();
  assert.equal(managed.ready(builder), true);
});


test("withdrawing outdated offers preserves an already running job", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } });
  const claimsServer = await serveFleet(store, { mac: "mac-test" }, "admin-test", 0);
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 2, projects: ["org/core"] }, new FleetClient(url(claimsServer), "mac-test"));
  const managerServer = await serveManager(manager, { "org/core": "project-test" }, "operator-test", 0);
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: url(managerServer), PYRY_MANAGER_TOKEN: "project-test" });
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  let activeRun: Promise<unknown> | undefined;
  t.after(async () => { release(); await activeRun; await managed.stop(); await close(managerServer); await close(claimsServer); store.close(); });
  await managed.start();
  managed.beginCycle();
  const active = managed.offer(1, "builder", "medium");
  managed.offer(2, "verifier", "heavy");
  await managed.endCycle();
  await manager.tick();
  await managed.sync();
  activeRun = managed.run(active, async () => { started(); await barrier; });
  await starting;
  managed.beginCycle();
  await managed.endCycle();
  assert.deepEqual(store.snapshot().runs.map(run => run.ticket), ["org/core#1"]);
  assert.equal(store.snapshot().claims.some(claim => claim.ticket === "org/core#2"), false);
  release();
  await activeRun;
  assert.deepEqual(store.snapshot().runs, []);
  assert.equal(store.snapshot().claims[0]?.ticket, "org/core#1");
});

test("a PR comment's ownership check travels through the machine manager to the store (#2148 / PR #2150)", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 } });
  const claimsServer = await serveFleet(store, { mac: "mac-test" }, "admin-test", 0);
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 1, projects: ["org/core"] }, new FleetClient(url(claimsServer), "mac-test"));
  const managerServer = await serveManager(manager, { "org/core": "project-test" }, "operator-test", 0);
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: url(managerServer), PYRY_MANAGER_TOKEN: "project-test" });
  t.after(async () => { await close(managerServer); await close(claimsServer); store.close(); });
  const posted: number[] = [];
  const client = managed.client({ addPullRequestComment: async (_n: number, pr: number, _body: string) => { posted.push(pr); } });
  // No claim and no admitted run: the store's own refusal comes back, not
  // the manager's "Unsupported project workflow operation".
  await assert.rejects(client.addPullRequestComment(3248, 3250, "verdict"), /Unclaimed workflow writes require a run grant/);
  assert.deepEqual(posted, []);
});

test("a drain releases idle grants, including reconcile's project lock, and leaves the run in flight alone", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 }, linux: { heavyLimit: 1, combinedLimit: 2 } });
  const claimsServer = await serveFleet(store, { mac: "mac-test", linux: "linux-test" }, "admin-test", 0);
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 2, projects: ["org/core"] }, new FleetClient(url(claimsServer), "mac-test"));
  const managerServer = await serveManager(manager, { "org/core": "project-test" }, "operator-test", 0);
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: url(managerServer), PYRY_MANAGER_TOKEN: "project-test" });
  const other = new FleetClient(url(claimsServer), "linux-test");
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  let activeRun: Promise<unknown> | undefined;
  t.after(async () => { release(); await activeRun?.catch(() => {}); await managed.stop(); await close(managerServer); await close(claimsServer); store.close(); });
  // Syncs are driven by hand here: the 2 s timer would make a manual sync return early.
  await managed.sync();
  const reconcileLocked = () => store.snapshot().runs.some(run => run.locks.includes("org/core:reconcile"));

  // A long run is in flight.
  managed.beginCycle();
  const active = managed.offer(1, "builder", "medium");
  await managed.endCycle(); await manager.tick(); await managed.sync();
  activeRun = managed.run(active, async () => { started(); await barrier; return true; });
  await starting;

  // The next cycle offers reconcile and the light verifier, which are not granted before the cycle ends.
  managed.beginCycle();
  const reconcile = managed.offer("@reconcile", "reconcile", "light", ["org/core:reconcile"], -3);
  const verifier = managed.offer(2, "verifier", "light");
  await managed.endCycle();
  assert.equal(managed.ready(reconcile), false);

  // SIGTERM: the loop's next cycle drains. The 2 s timer keeps syncing meanwhile.
  managed.beginCycle();
  await managed.drain();
  for (let i = 0; i < 3; i++) { await manager.tick(); await managed.sync(); }
  assert.equal(reconcileLocked(), false, "no idle reconcile grant holds the project lock");
  assert.deepEqual(store.snapshot().runs.map(run => run.ticket), ["org/core#1"], "only the run in flight keeps a grant");
  assert.equal(store.snapshot().claims.some(claim => claim.ticket === "org/core#2"), false, "an unused grant leaves no claim");
  assert.equal(managed.ready(reconcile) || managed.ready(verifier), false);

  // Another computer can reconcile the project while this one drains.
  const otherRun = await other.start({ id: "linux-reconcile", machine: "linux", session: "linux-session",
    project: "org/core", ticket: "org/core#@reconcile", role: "reconcile", resource: "light", locks: ["org/core:reconcile"] });
  assert.equal(otherRun.ok, true, "the project is not locked fleet-wide");
  await other.finish("linux-session", "linux-reconcile", true);

  // Work offered during the drain, such as a failed run's recovery successor, is not granted here.
  // Checked right after the manager's tick: a grant that a later sync released would still have held its place meanwhile.
  const late = managed.offer(3, "recovery", "heavy", [], -4);
  await managed.sync(); await manager.tick();
  assert.deepEqual(store.snapshot().runs.map(run => run.ticket), ["org/core#1"], "the late offer was never published");
  await managed.sync();
  assert.equal(managed.ready(late), false);

  // The run in flight is undisturbed and finishes as completed.
  assert.equal(managed.ready(active), false);
  release();
  assert.equal(await activeRun, true);
  assert.deepEqual(store.snapshot().runs, []);
  assert.equal(store.snapshot().claims[0]?.ticket, "org/core#1", "the finished run's ticket stays owned");
  await managed.stop();
  assert.deepEqual(store.snapshot().runs, []);
});

test("a grant reaching a draining dispatcher is released by its next sync", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 } });
  const claimsServer = await serveFleet(store, { mac: "mac-test" }, "admin-test", 0);
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 1, projects: ["org/core"] }, new FleetClient(url(claimsServer), "mac-test"));
  const managerServer = await serveManager(manager, { "org/core": "project-test" }, "operator-test", 0);
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: url(managerServer), PYRY_MANAGER_TOKEN: "project-test" });
  t.after(async () => { await managed.stop(); await close(managerServer); await close(claimsServer); store.close(); });
  await managed.sync();
  managed.beginCycle();
  const reconcile = managed.offer("@reconcile", "reconcile", "light", ["org/core:reconcile"], -3);
  await managed.endCycle(); await manager.tick(); await managed.sync();
  assert.equal(managed.ready(reconcile), true);
  // The manager's own drain flag reaches the dispatcher through its next sync.
  manager.draining = true;
  await managed.sync();
  assert.equal(managed.draining, true);
  assert.deepEqual(store.snapshot().runs, [], "the idle grant is released as unused");
  assert.equal(managed.ready(reconcile), false);
});

test("a grant left by a failed drain() is released by the next sync", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 } });
  const claimsServer = await serveFleet(store, { mac: "mac-test" }, "admin-test", 0);
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 1, projects: ["org/core"] }, new FleetClient(url(claimsServer), "mac-test"));
  const managerServer = await serveManager(manager, { "org/core": "project-test" }, "operator-test", 0);
  const managed = new ManagedDispatch("org/core", { PYRY_MANAGER_URL: url(managerServer), PYRY_MANAGER_TOKEN: "project-test" });
  t.after(async () => { await managed.stop(); await close(managerServer); await close(claimsServer); store.close(); });
  await managed.sync();
  managed.beginCycle();
  const reconcile = managed.offer("@reconcile", "reconcile", "light", ["org/core:reconcile"], -3);
  await managed.endCycle(); await manager.tick(); await managed.sync();
  assert.equal(managed.ready(reconcile), true);
  // drain() marks the dispatcher draining before it calls the manager, so a failed call still leaves it draining.
  const replace = managed.connection.call.bind(managed.connection);
  managed.connection.call = (async (path: string, body?: unknown) => {
    if (path === "/replace") throw new Error("manager unreachable");
    return replace(path, body);
  }) as typeof managed.connection.call;
  await assert.rejects(managed.drain(), /manager unreachable/);
  assert.equal(store.snapshot().runs.length, 1, "the failed drain left the grant in place");
  await managed.sync();
  assert.deepEqual(store.snapshot().runs, [], "the timer's sync releases it");
});
