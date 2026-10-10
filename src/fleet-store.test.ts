import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore, type StartRequest } from "./fleet-store.js";

const request = (id: string, machine = "mac", ticket = "org/mobile#1"): StartRequest => ({
  id, machine, session: "session-1", project: ticket.split("#")[0], ticket,
  role: "builder", resource: "heavy", locks: [],
});

test("an unused first reservation does not leave a priority claim", t => {
  const { store } = fixture(t);
  store.start(request("unused"));
  store.finish("mac", "session-1", "unused", false, true);
  assert.deepEqual(store.snapshot(), { claims: [], runs: [] });
  assert.equal(store.start(request("next", "linux")).ok, true);
  store.finish("mac", "session-1", "unused", false, true);
  assert.equal(store.snapshot().claims[0].machine, "linux");
  assert.equal(store.snapshot().runs[0].id, "next");
});

test("unused reservations preserve ownership after completed or blocked work", t => {
  const { store } = fixture(t);
  for (const completed of [true, false]) {
    const ticket = `org/mobile#${completed ? 1 : 2}`;
    store.start(request(`worked-${completed}`, "mac", ticket));
    store.finish("mac", "session-1", `worked-${completed}`, completed);
    store.start(request(`unused-${completed}`, "mac", ticket));
    store.finish("mac", "session-1", `unused-${completed}`, false, true);
    assert.deepEqual(store.start(request(`foreign-${completed}`, "linux", ticket)), { ok: false, reason: "foreign-claim" });
    // A contradictory retry cannot retroactively turn actual work into unused work.
    store.finish("mac", "session-1", `worked-${completed}`, false, true);
    assert.equal(store.snapshot().claims.find(c => c.ticket === ticket)?.machine, "mac");
  }
});
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-store-"));
  const path = join(dir, "claims.sqlite");
  const store = new FleetStore(path, { mac: { heavyLimit: 2, combinedLimit: 2 }, linux: { heavyLimit: 2, combinedLimit: 2 } });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, path };
}

test("only one computer owns a ticket, including after reopening the database", t => {
  const { store, path } = fixture(t);
  assert.equal(store.start(request("a")).ok, true);
  const second = new FleetStore(path, { mac: { heavyLimit: 2, combinedLimit: 2 }, linux: { heavyLimit: 2, combinedLimit: 2 } });
  t.after(() => second.close());
  assert.deepEqual(second.start(request("b", "linux")), { ok: false, reason: "foreign-claim" });
  store.finish("mac", "session-1", "a");
  assert.deepEqual(second.start(request("c", "linux")), { ok: false, reason: "foreign-claim" });
});

test("heavy capacity is shared across projects and light work remains eligible", t => {
  const { store } = fixture(t);
  assert.equal(store.start(request("a")).ok, true);
  assert.equal(store.start(request("b", "mac", "org/desktop#1")).ok, true);
  assert.deepEqual(store.start(request("c", "mac", "org/core#1")), { ok: false, reason: "capacity" });
  assert.equal(store.start({ ...request("d", "mac", "org/core#1"), role: "refiner", resource: "light" }).ok, true);
  assert.equal(store.snapshot().claims.length, 3);
});

test("retries cannot replay a completed start or free a later run", t => {
  const { store } = fixture(t);
  const req = request("a");
  assert.deepEqual(store.start(req), store.start(req));
  store.finish("mac", "session-1", "a");
  assert.deepEqual(store.start(req), { ok: false, reason: "finished" });
  assert.equal(store.start(request("b")).ok, true);
  store.finish("mac", "session-1", "a");
  assert.equal(store.snapshot().runs.length, 1);
  assert.throws(() => store.finish("linux", "session-1", "b"), /owner/);
});

test("project locks exclude other tickets and computers without claiming losers", t => {
  const { store } = fixture(t);
  const a = { ...request("a"), resource: "light" as const, role: "documentation", locks: ["org/mobile:role:documentation"] };
  const b = { ...request("b", "linux", "org/mobile#2"), resource: "light" as const, role: "documentation", locks: a.locks };
  assert.equal(store.start(a).ok, true);
  assert.deepEqual(store.start(b), { ok: false, reason: "locked" });
  assert.equal(store.snapshot().claims.length, 1);
  store.finish("mac", "session-1", "a");
  assert.equal(store.start(b).ok, true);
});

test("manual release requires stopped confirmation and expected ownership generation", t => {
  const { store } = fixture(t);
  const grant = store.start(request("a"));
  assert.equal(grant.ok, true);
  if (!grant.ok) return;
  assert.throws(() => store.free("org/mobile#1", grant.generation, false), /stopped/);
  store.free("org/mobile#1", grant.generation, true);
  assert.equal(store.snapshot().runs.length, 0);
  const next = store.start(request("b", "linux"));
  assert.equal(next.ok, true);
  assert.throws(() => store.free("org/mobile#1", grant.generation, true), /changed/);
  assert.deepEqual(store.start(request("a")), { ok: false, reason: "finished" });
});

test("reject reused request IDs with different contents and malformed inputs", t => {
  const { store } = fixture(t);
  store.start(request("a"));
  assert.throws(() => store.start({ ...request("a"), session: "other" }), /reused/);
  assert.throws(() => store.start({ ...request("b"), resource: "typo" as "heavy" }), /resource/);
  assert.throws(() => store.start(request("b", "unknown")), /machine/);
  assert.throws(() => store.start({ ...request("b"), project: "org/other" }), /ticket/);
});

test("workflow cleanup cannot modify another owner or a live run", t => {
  const { store } = fixture(t);
  store.start(request("a"));
  assert.throws(() => store.authorize("linux", "s", "org/mobile#1"), /another machine/);
  assert.throws(() => store.authorize("mac", "session-1", "org/mobile#1"), /active run/);
  assert.equal(store.authorize("mac", "session-1", "org/mobile#1", "a").machine, "mac");
  store.finish("mac", "session-1", "a");
  assert.equal(store.authorize("mac", "session-2", "org/mobile#1").machine, "mac");
});

test("role caps hold across machines, independently of their heavy limits", t => {
  const { store } = fixture(t);
  assert.equal(store.start({ ...request("a"), roleLimit: 2 }).ok, true);
  assert.equal(store.start({ ...request("b", "linux", "org/mobile#2"), roleLimit: 2 }).ok, true);
  assert.deepEqual(store.start({ ...request("c", "linux", "org/mobile#3"), roleLimit: 2 }), { ok: false, reason: "locked" });
});

test("a completed main revision check is not repeated on another computer", t => {
  const { store } = fixture(t);
  const ticket = "org/mobile#@main-sweep-abc123";
  store.start(request("a", "mac", ticket));
  store.finish("mac", "session-1", "a", false);
  assert.equal(store.start(request("b", "linux", ticket)).ok, true);
  store.finish("linux", "session-1", "b");
  assert.deepEqual(store.start(request("c", "mac", ticket)), { ok: false, reason: "finished" });
});

test("board housekeeping never reserves the unclaimed backlog or races a new agent", t => {
  const { store } = fixture(t);
  assert.throws(() => store.authorize("mac", "session-1", "org/mobile#2"), /grant/);
  assert.equal(store.start({ ...request("housekeeping", "mac", "org/mobile#@reconcile"), role: "reconcile", resource: "light", locks: ["org/mobile:reconcile"] }).ok, true);
  store.authorize("mac", "session-1", "org/mobile#2", "housekeeping");
  assert.equal(store.snapshot().claims.some(c => c.ticket === "org/mobile#2"), false);
  assert.deepEqual(store.start(request("new", "linux", "org/mobile#2")), { ok: false, reason: "locked" });
  store.finish("mac", "session-1", "housekeeping");
  assert.equal(store.start(request("new", "linux", "org/mobile#2")).ok, true);
});

test("medium admission obeys the shared combined cap across projects", t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } });
  t.after(() => store.close());
  assert.equal(store.start(request("heavy")).ok, true);
  assert.equal(store.start({ ...request("medium", "mac", "org/desktop#2"), resource: "medium" }).ok, true);
  assert.deepEqual(store.start({ ...request("extra", "mac", "org/core#3"), resource: "medium" }), { ok: false, reason: "capacity" });
  assert.deepEqual(store.start(request("heavy-2", "mac", "org/core#4")), { ok: false, reason: "capacity" });
  assert.equal(store.start({ ...request("light", "mac", "org/core#5"), resource: "light" }).ok, true);
  assert.equal(store.snapshot().claims.length, 3);
  store.finish("mac", "session-1", "heavy");
  assert.equal(store.start({ ...request("medium-2", "mac", "org/core#3"), resource: "medium" }).ok, true);
  assert.deepEqual(store.start(request("heavy-3", "mac", "org/core#6")), { ok: false, reason: "capacity" });
});

test("Mac combined limit permits either one builder or one verifier", t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 } });
  t.after(() => store.close());
  assert.equal(store.start({ ...request("build"), resource: "medium" }).ok, true);
  assert.deepEqual(store.start(request("verify", "mac", "org/desktop#2")), { ok: false, reason: "capacity" });
  store.finish("mac", "session-1", "build");
  assert.equal(store.start(request("verify", "mac", "org/desktop#2")).ok, true);
});

test("both capacity limits are explicit positive integers and combined covers heavy", () => {
  for (const limits of [1, {}, { heavyLimit: 1 }, { heavyLimit: 2, combinedLimit: 1 }, { heavyLimit: 1, combinedLimit: 1.5 }, { heavyLimit: 0, combinedLimit: 2 }]) {
    assert.throws(() => new FleetStore(":memory:", { mac: limits as any }), /limit/i);
  }
});

test("reopening with a lower combined limit keeps medium reservations occupied", t => {
  const { store, path } = fixture(t);
  store.start({ ...request("a"), resource: "medium" });
  store.start({ ...request("b", "mac", "org/desktop#2"), resource: "medium" });
  const restarted = new FleetStore(path, { mac: { heavyLimit: 1, combinedLimit: 1 } });
  t.after(() => restarted.close());
  assert.equal(restarted.snapshot().runs.length, 2);
  assert.deepEqual(restarted.start(request("new", "mac", "org/core#3")), { ok: false, reason: "capacity" });
  restarted.finish("mac", "session-1", "a");
  assert.deepEqual(restarted.start({ ...request("new", "mac", "org/core#3"), resource: "medium" }), { ok: false, reason: "capacity" });
  restarted.finish("mac", "session-1", "b");
  assert.equal(restarted.start(request("new", "mac", "org/core#3")).ok, true);
});
