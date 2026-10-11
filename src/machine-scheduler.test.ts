import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleMachine, type WorkOffer } from "./machine-scheduler.js";
import type { FleetSnapshot } from "./fleet-store.js";

const offer = (project: string, n: number, resource: "heavy" | "light" = "heavy"): WorkOffer => ({
  project, ticket: `${project}#${n}`, role: resource === "light" ? "refiner" : "builder", resource, locks: [], key: `${n}`, order: n,
});
const empty: FleetSnapshot = { claims: [], runs: [] };
const select = (offers: WorkOffer[], state = empty, limit = 1) => scheduleMachine({
  machine: "mac", heavyLimit: limit, combinedLimit: limit, projects: ["org/core", "org/mobile"], offers, state,
});

test("ready local claims override project priorities", () => {
  const state = { ...empty, claims: [{ ticket: "org/mobile#2", machine: "mac", generation: "g", created: 1 }] };
  assert.deepEqual(select([offer("org/core", 1), offer("org/mobile", 2)], state).map(o => o.ticket), ["org/mobile#2"]);
});
test("blocked claims absent from offers do not stop fallback and take priority when ready", () => {
  const state = { ...empty, claims: [{ ticket: "org/mobile#2", machine: "mac", generation: "g", created: 1 }] };
  assert.equal(select([offer("org/core", 1)], state)[0].ticket, "org/core#1");
});
test("light jobs start at full heavy capacity with no artificial cap", () => {
  const state: FleetSnapshot = { ...empty, runs: [{ ...offer("org/core", 99), id: "r", machine: "mac", session: "s", generation: "g", created: 1 }] };
  const offers = [offer("org/core", 1), ...Array.from({ length: 20 }, (_, i) => offer("org/mobile", i + 1, "light"))];
  assert.equal(select(offers, state).length, 20);
});
test("foreign owners and existing runs never enter the local queue", () => {
  const state = { ...empty, claims: [{ ticket: "org/core#1", machine: "linux", generation: "g", created: 1 }] };
  assert.equal(select([offer("org/core", 1), offer("org/mobile", 2)], state)[0].ticket, "org/mobile#2");
});
test("one ticket and exclusive operation get at most one grant per selection", () => {
  const a = { ...offer("org/core", 1, "light"), locks: ["org/core:docs"] };
  const b = { ...offer("org/core", 2, "light"), locks: a.locks };
  assert.equal(select([a, b, { ...a, key: "another-stage" }], empty, 2).length, 1);
});

test("one heavy plus one medium or two mediums fit, and light stays unlimited", () => {
  const choose = (resources: Array<"heavy" | "medium" | "light">, combinedLimit = 2) => scheduleMachine({
    machine: "mac", heavyLimit: 1, combinedLimit, projects: ["org/core"], state: empty,
    offers: resources.map((resource, i) => ({ ...offer("org/core", i + 1), resource })),
  }).map(o => o.resource);
  assert.deepEqual(choose(["heavy", "heavy", "medium", "medium", "light"]), ["heavy", "medium", "light"]);
  assert.deepEqual(choose(["medium", "medium", "medium", "heavy", "light"]), ["medium", "medium", "light"]);
  assert.deepEqual(choose(["medium", "heavy", "light"], 1), ["medium", "light"]);
});

test("active medium reservations consume combined capacity after a restart", () => {
  const state: FleetSnapshot = { ...empty, runs: [1, 2].map(n => ({ ...offer("org/core", n), resource: "medium", id: `r${n}`, machine: "mac", session: "old", generation: "g", created: 1 })) };
  const selected = scheduleMachine({ machine: "mac", heavyLimit: 1, combinedLimit: 2, projects: ["org/core", "org/mobile"], state,
    offers: [offer("org/mobile", 3), offer("org/mobile", 4, "light")] });
  assert.deepEqual(selected.map(o => o.resource), ["light"]);
});

const capped = (offers: WorkOffer[], state: FleetSnapshot = empty) => scheduleMachine({
  machine: "mac", heavyLimit: 1, combinedLimit: 2, ticketLimit: 2,
  projects: ["org/core", "org/mobile"], offers, state,
});
test("new light claims share the two-ticket budget across projects", () => {
  assert.deepEqual(capped([offer("org/mobile", 3, "light"), offer("org/core", 1, "light"), offer("org/core", 2, "light")]).map(o => o.ticket), ["org/core#1", "org/core#2"]);
});
test("active tickets count after restart, but maintenance does not", () => {
  const state: FleetSnapshot = { claims: [], runs: [1, 2].map(n => ({ ...offer("org/core", n, "light"), id: `r${n}`, machine: "mac", session: "old", generation: "g", created: 1 })) };
  const maintenance = { ...offer("org/mobile", 9, "light"), ticket: "org/mobile#@reconcile", role: "reconcile" };
  assert.deepEqual(capped([offer("org/mobile", 3, "light"), maintenance], state).map(o => o.ticket), [maintenance.ticket]);
});
test("blocked and completed claims without offers leave room for new tickets", () => {
  const state: FleetSnapshot = { ...empty, claims: [1, 2, 3].map(n => ({ ticket: `org/core#${n}`, machine: "mac", generation: "g", created: n })) };
  assert.equal(capped([offer("org/mobile", 4, "light"), offer("org/mobile", 5, "light")], state).length, 2);
});
test("legacy owned ready tickets continue above the cap and prevent new claims", () => {
  const state: FleetSnapshot = { ...empty, claims: [1, 2, 3].map(n => ({ ticket: `org/core#${n}`, machine: "mac", generation: "g", created: n })) };
  assert.deepEqual(capped([1, 2, 3, 4].map(n => offer("org/core", n, "light")), state).map(o => o.ticket), ["org/core#1", "org/core#2", "org/core#3"]);
  assert.deepEqual(capped([offer("org/core", 1, "light"), offer("org/mobile", 4, "light"), offer("org/mobile", 5, "light")], state).map(o => o.ticket), ["org/core#1", "org/mobile#4"]);
});


test("owned ordinary work precedes unclaimed recovery and repair stages", () => {
  const normal = { ...offer("org/mobile", 1), order: 100 };
  const recovery = { ...offer("org/core", 2), role: "recovery", order: -100 };
  const state = { ...empty, claims: [{ ticket: normal.ticket, machine: "mac", generation: "old", created: 1 }] };
  assert.equal(select([recovery, normal], state)[0].ticket, normal.ticket);
  assert.equal(select([{ ...recovery, role: "builder", recovery: true }, normal], state)[0].ticket, normal.ticket);
});

test("owned recovery and repair stages precede older owned ordinary work", () => {
  const normal = { ...offer("org/core", 1), order: -100 };
  const recovery = { ...offer("org/mobile", 2), role: "recovery", order: 100 };
  const state = { ...empty, claims: [normal, recovery].map((o, i) => ({ ticket: o.ticket, machine: "mac", generation: "g", created: i + 1 })) };
  assert.equal(select([normal, recovery], state)[0].ticket, recovery.ticket);
  assert.equal(select([normal, { ...recovery, role: "builder", recovery: true }], state)[0].ticket, recovery.ticket);
});

test("an owned heavy offer without capacity allows fitting unclaimed work", () => {
  const owned = offer("org/mobile", 2);
  const state: FleetSnapshot = { claims: [{ ticket: owned.ticket, machine: "mac", generation: "g", created: 1 }],
    runs: [{ ...offer("org/core", 1), id: "active", machine: "mac", session: "s", generation: "g", created: 1 }] };
  const fitting: WorkOffer = { ...offer("org/core", 3), resource: "medium" };
  assert.deepEqual(scheduleMachine({ machine: "mac", heavyLimit: 1, combinedLimit: 2, ticketLimit: 3,
    projects: ["org/core", "org/mobile"], offers: [owned, fitting], state }).map(o => o.ticket), [fitting.ticket]);
});

test("unclaimed recovery still precedes unclaimed ordinary project priority", () => {
  const recovery = { ...offer("org/mobile", 2), role: "recovery" };
  assert.equal(select([offer("org/core", 1), recovery])[0].ticket, recovery.ticket);
});

test("recovery priority never interrupts active work or ignores project drains", () => {
  const recovery = { ...offer("org/mobile", 2), role: "recovery" };
  const state: FleetSnapshot = { ...empty, runs: [{ ...offer("org/core", 1), id: "active", machine: "mac", session: "s", generation: "g", created: 1 }] };
  assert.deepEqual(select([recovery], state), []);
  assert.deepEqual(scheduleMachine({machine: "mac", projects: ["org/core", "org/mobile"], drainingProjects: ["org/mobile"], heavyLimit: 1, combinedLimit: 1, offers: [recovery], state: empty}), []);
});

const idleCheck = (n: number) => ({ ...offer("org/core", n), role: "recovery" });
const idleState = (jobs: WorkOffer[]) => ({ ...empty,
  idleRecoveryTickets: jobs.map(o => o.ticket),
  claims: jobs.map((o, i) => ({ ticket: o.ticket, machine: "mac", generation: "g", created: i + 1 })),
});

test("an older owned idle assessment yields to unclaimed ready work", () => {
  const check = idleCheck(1), ready = offer("org/mobile", 2);
  assert.deepEqual(select([check, ready], idleState([check])).map(o => o.ticket), [ready.ticket]);
});

test("waiting idle assessments do not fill the new-ticket budget", () => {
  const checks = [idleCheck(1), idleCheck(2), idleCheck(3)], ready = offer("org/mobile", 4);
  assert.deepEqual(capped([...checks, ready], idleState(checks)).map(o => o.ticket), [ready.ticket]);
});

test("starting ticket work leaves idle assessments waiting despite spare capacity", () => {
  const check = idleCheck(1);
  const ready: WorkOffer = { ...offer("org/mobile", 2), resource: "medium" };
  assert.deepEqual(capped([check, ready], idleState([check])).map(o => o.ticket), [ready.ticket]);
});

test("a running medium ticket prevents idle assessment in the free heavy place", () => {
  const check = idleCheck(1);
  const state = { ...idleState([check]), runs: [{ ...offer("org/mobile", 2), resource: "medium" as const,
    id: "active", machine: "mac", session: "s", generation: "g", created: 1 }] };
  assert.deepEqual(capped([check], state), []);
});

test("an idle computer can assess while other computers work", () => {
  const check = idleCheck(1);
  const state = { ...idleState([check]), runs: [{ ...offer("org/mobile", 2),
    id: "remote", machine: "linux", session: "s", generation: "g", created: 1 }] };
  assert.deepEqual(capped([check], state).map(o => o.ticket), [check.ticket]);
});

test("foreign work and drained projects do not prevent a fitting idle assessment", () => {
  const check = idleCheck(1), foreign = offer("org/mobile", 2), drained = offer("org/mobile", 3);
  const state = { ...idleState([check]), claims: [...idleState([check]).claims,
    { ticket: foreign.ticket, machine: "linux", generation: "f", created: 1 }] };
  assert.deepEqual(scheduleMachine({ machine: "mac", projects: ["org/core", "org/mobile"],
    heavyLimit: 1, combinedLimit: 2, drainingProjects: ["org/mobile"],
    offers: [check, foreign, drained], state }).map(o => o.ticket), [check.ticket]);
});

test("idle checks do not displace error investigation or assigned repair", () => {
  const check = idleCheck(1);
  const failed = { ...offer("org/mobile", 2), role: "recovery", recoveryError: true };
  const repair = { ...offer("org/mobile", 3), recovery: true, recoveryError: true };
  for (const actionable of [failed, repair]) {
    assert.deepEqual(select([check, actionable], idleState([check])).map(o => o.ticket), [actionable.ticket]);
  }
});

test("internal housekeeping is not ticket work and still obeys its locks", () => {
  const check = idleCheck(1);
  const maintenance = { ...offer("org/mobile", 2, "light"), ticket: "org/mobile#@reconcile", role: "reconcile", locks: ["org/mobile:reconcile"] };
  assert.deepEqual(capped([check, maintenance], idleState([check])).map(o => o.ticket), [maintenance.ticket, check.ticket]);
});
