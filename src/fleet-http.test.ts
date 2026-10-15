import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetStore } from "./fleet-store.js";
import { serveFleet, FleetClient } from "./fleet-http.js";

test('worktree predecessor proof requires an active owner and exact normal completion history', async t => {
  const store = new FleetStore(':memory:', { mac: { heavyLimit: 1, combinedLimit: 1 }, linux: { heavyLimit: 1, combinedLimit: 1 } });
  const server = await serveFleet(store, { mac: 'mac-test', linux: 'linux-test' }, 'operator-test', 0);
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); store.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const mac = new FleetClient(endpoint, 'mac-test'), linux = new FleetClient(endpoint, 'linux-test');
  const admin = new FleetClient(endpoint, 'operator-test');
  const request = { machine: 'mac', session: 'verifier-session', project: 'org/desktop', ticket: 'org/desktop#1936', role: 'verifier', resource: 'medium' as const, locks: [] };
  assert.equal((await mac.start({ ...request, id: 'prior' })).ok, true);
  const prior = store.snapshot().runs[0];
  assert.equal(await mac.call('/worktree/predecessor', { session: request.session, runId: 'prior', priorId: 'prior' }), null);
  await mac.finish(request.session, 'prior', false);
  await mac.start({ ...request, id: 'unused', session: 'unused-session' });
  await mac.finish('unused-session', 'unused', false, true);
  await mac.start({ ...request, id: 'current', session: 'builder-session', role: 'builder' });
  const body = { session: 'builder-session', runId: 'current', priorId: 'prior' };
  const before = store.snapshot();
  assert.deepEqual(await mac.call('/worktree/predecessor', body), prior);
  for (const priorId of ['never-admitted', 'unused', 'current']) assert.equal(await mac.call('/worktree/predecessor', { ...body, priorId }), null);
  await assert.rejects(linux.call('/worktree/predecessor', body), /409/);
  await assert.rejects(admin.call('/worktree/predecessor', body), /403/);
  await assert.rejects(mac.call('/worktree/predecessor', { ...body, session: 'unknown' }), /409/);
  assert.deepEqual(store.snapshot(), before, 'proof is read-only');
  await admin.free(request.ticket, prior.generation, true);
  await mac.start({ ...request, id: 'new-generation', session: 'fresh-session', role: 'builder' });
  assert.equal(await mac.call('/worktree/predecessor', { session: 'fresh-session', runId: 'new-generation', priorId: 'prior' }), null);
});

test('only the central operator can change the fleet runner', async t => {
  const store = new FleetStore(':memory:', { mac: { heavyLimit: 1, combinedLimit: 1 } });
  const server = await serveFleet(store, { mac: 'machine-test' }, 'operator-test', 0);
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); store.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const machine = new FleetClient(url, 'machine-test');
  const operator = new FleetClient(url, 'operator-test');
  assert.equal(await operator.call('/runner'), null);
  await assert.rejects(machine.call('/runner', { runner: 'claude' }), /403/);
  await assert.rejects(operator.call('/runner', { runner: 'typo' }), /409/);
  assert.equal(await operator.call('/runner'), null, 'invalid writes preserve the current setting');
  assert.deepEqual(await operator.call('/runner', { runner: 'codex' }), { runner: 'codex', revision: 1 });
  assert.deepEqual((await machine.snapshot()).runnerPolicy, { runner: 'codex', revision: 1 });
  assert.deepEqual(await operator.call('/runner', { runner: null }), { runner: null, revision: 2 });
});

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
