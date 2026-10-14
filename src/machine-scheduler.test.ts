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

test("remote native recovery keeps its parent claim priority without moving ownership", () => {
  const ordinary=offer("org/core",3257);
  const helper:WorkOffer={...offer("org/core",2939),ticket:"org/core#@task-android",role:"recovery-task",supportTaskId:"android",parentTicket:"org/core#2939",recovery:true,recoveryError:true,order:-5};
  const state:FleetSnapshot={claims:[{ticket:helper.parentTicket!,machine:"linux",generation:"parent",created:1},{ticket:ordinary.ticket,machine:"mac",generation:"local",created:2}],runs:[]};
  const original=structuredClone(state);
  assert.equal(select([ordinary,helper],state)[0].ticket,helper.ticket);
  assert.deepEqual(state,original);
  const busy={...state,runs:[{...ordinary,id:"active",machine:"mac",session:"s",generation:"local",created:3}]};
  assert.deepEqual(select([helper],busy),[]);
});

// pyrycode-mobile #1977 on 2026-10-14: Done at 12:05:56, but the merge was
// heavy and build-hp-1's one heavy place belonged to a core repair task
// until 12:19:04. A merge is light now; its ownership guards are unchanged.
test("a Done ticket's merge starts beside a running heavy job, still singly owned", async () => {
  const { mergeOfferShape } = await import("./managed-dispatch.js");
  const mobile = "org/mobile";
  const shape = mergeOfferShape(mobile);
  const mergeOf = (n: number, key = `m${n}`): WorkOffer => ({ project: mobile, ticket: `${mobile}#${n}`, ...shape, key });
  const claim = (n: number, machine = "hp") => ({ ticket: `${mobile}#${n}`, machine, generation: "g", created: 1 });
  const repair = { project: "org/core", ticket: "org/core#@task-1", role: "recovery-task", resource: "heavy" as const, locks: [],
    key: "t", order: 0, id: "task", machine: "hp", session: "s", generation: "g", created: 1 };
  const schedule = (offers: WorkOffer[], state: FleetSnapshot) => scheduleMachine({
    machine: "hp", heavyLimit: 1, combinedLimit: 2, ticketLimit: 2, projects: ["org/core", mobile], offers, state,
  });

  assert.equal(shape.resource, "light");
  // Heavy and combined places both taken: the merge is still granted.
  const busy: FleetSnapshot = { claims: [claim(1977)], runs: [repair, { ...repair, id: "b", ticket: "org/core#9", resource: "medium" }] };
  assert.deepEqual(schedule([mergeOf(1977)], busy).map(o => o.ticket), [`${mobile}#1977`]);
  // Only the claiming computer is granted it.
  assert.deepEqual(schedule([mergeOf(1977)], { claims: [claim(1977, "fractal")], runs: [] }), []);
  // One merge per board across computers: the project lock holds.
  const merging: FleetSnapshot = { claims: [claim(1977), claim(1978, "fractal")],
    runs: [{ ...mergeOf(1978), id: "m", machine: "fractal", session: "s", generation: "g", created: 1 }] };
  assert.deepEqual(schedule([mergeOf(1977)], merging), []);
  // Two Done tickets in one selection: one grant.
  assert.equal(schedule([mergeOf(1977), mergeOf(1979)], { claims: [claim(1977), claim(1979)], runs: [] }).length, 1);
  // Never beside another run on the same ticket.
  const sameTicket: FleetSnapshot = { claims: [claim(1977)], runs: [{ ...repair, id: "r", project: mobile, ticket: `${mobile}#1977`, role: "recovery" }] };
  assert.deepEqual(schedule([mergeOf(1977)], sameTicket), []);
});

test("the post-merge codegraph refresh is charged as medium work, one per computer", async () => {
  const { codegraphOfferShape } = await import("./managed-dispatch.js");
  const shape = codegraphOfferShape("build-hp-1")!;
  assert.equal(shape.resource, "medium");
  assert.equal(shape.ticket, "@codegraph-build-hp-1");
  const refresh: WorkOffer = { project: "org/mobile", ...shape, ticket: `org/mobile#${shape.ticket}`, key: "c" };
  const full: FleetSnapshot = { claims: [], runs: [1, 2].map(n => ({ ...offer("org/core", n), resource: "medium" as const, id: `r${n}`, machine: "mac", session: "s", generation: "g", created: 1 })) };
  assert.deepEqual(scheduleMachine({ machine: "mac", heavyLimit: 1, combinedLimit: 2, projects: ["org/core", "org/mobile"], offers: [refresh], state: full }), [], "waits for a combined place");
  assert.equal(scheduleMachine({ machine: "mac", heavyLimit: 1, combinedLimit: 2, projects: ["org/core", "org/mobile"], offers: [refresh], state: { claims: [], runs: [] } }).length, 1);
  assert.equal(codegraphOfferShape("bad name"), null, "a name a ticket cannot carry skips the refresh instead of failing the cycle");
});

// pyrycode #3324 and #3354 on 2026-10-14: priority:high verifiers sat behind
// 23 recovery checks waiting for pyrybox's one heavy place.
const verifier = (n: number, project = "org/core"): WorkOffer => ({ ...offer(project, n), role: "verifier" });
const claimOf = (o: WorkOffer, created: number, machine = "mac") => ({ ticket: o.ticket, machine, generation: `g${created}`, created });
const urgent = (state: FleetSnapshot, ...offers: WorkOffer[]): FleetSnapshot => ({ ...state, priorityHighTickets: offers.map(o => o.ticket) });

test("a priority:high verifier is admitted ahead of every kind of recovery waiting for the heavy place", () => {
  const ownedCheck = { ...offer("org/core", 1), role: "recovery", order: -100 };
  const failedCheck = { ...offer("org/core", 2), role: "recovery", recoveryError: true, order: -100 };
  const repair = { ...offer("org/core", 3), recovery: true, recoveryError: true, order: -100 };
  const unclaimedCheck = { ...offer("org/mobile", 4), role: "recovery", order: -100 };
  const task: WorkOffer = { ...offer("org/core", 5), ticket: "org/core#@task-a", role: "recovery-task", supportTaskId: "a", parentTicket: "org/core#5", recovery: true, recoveryError: true, order: -5 };
  const v = { ...verifier(3354, "org/mobile"), order: 100 };
  const claims = [ownedCheck, failedCheck, repair].map((o, i) => claimOf(o, i + 1)).concat(claimOf({ ...offer("org/core", 5) }, 4));
  const state = urgent({ ...empty, claims }, v);
  for (const rival of [ownedCheck, failedCheck, repair, unclaimedCheck, task]) {
    assert.deepEqual(select([rival, v], state).map(o => o.ticket), [v.ticket], `${rival.ticket} ${rival.role}`);
  }
  // The whole queue at once: the verifier takes the one heavy place, recovery keeps its own order behind it.
  const all = [ownedCheck, failedCheck, repair, unclaimedCheck, task, v];
  assert.deepEqual(select(all, state).map(o => o.ticket), [v.ticket]);
  assert.deepEqual(select(all, state, 3).map(o => o.ticket), [v.ticket, failedCheck.ticket, repair.ticket]);
});

test("a verifier without priority:high keeps today's place behind recovery", () => {
  const check = { ...offer("org/core", 1), role: "recovery" };
  const repair = { ...offer("org/core", 2), recovery: true };
  const plain = verifier(3354, "org/mobile");
  const ownedPlain = verifier(3355);
  const state = { ...empty, claims: [claimOf(check, 1), claimOf(repair, 2), claimOf(ownedPlain, 3)] };
  for (const s of [state, urgent(state, offer("org/core", 99))]) {
    assert.deepEqual(select([plain, check], s).map(o => o.ticket), [check.ticket]);
    assert.deepEqual(select([ownedPlain, repair], s).map(o => o.ticket), [repair.ticket]);
  }
});

test("priority:high on another stage does not move it ahead of recovery", () => {
  const check = { ...offer("org/core", 1), role: "recovery" };
  const builder = offer("org/core", 2);
  const state = urgent({ ...empty, claims: [claimOf(check, 1), claimOf(builder, 2)] }, builder);
  assert.deepEqual(select([builder, check], state).map(o => o.ticket), [check.ticket]);
});

test("several priority:high verifiers keep the existing order among themselves", () => {
  const ownedOld = { ...verifier(10), order: 50 }, ownedNew = { ...verifier(11), order: 1 };
  const unclaimedCore = verifier(12), unclaimedMobile = verifier(1, "org/mobile");
  const repairing = { ...verifier(13), recovery: true };
  const check = { ...offer("org/core", 14), role: "recovery" };
  const state = urgent({ ...empty, claims: [claimOf(ownedNew, 2), claimOf(ownedOld, 1), claimOf(repairing, 3), claimOf(check, 0)] },
    ownedOld, ownedNew, unclaimedCore, unclaimedMobile, repairing);
  const order = scheduleMachine({ machine: "mac", heavyLimit: 9, combinedLimit: 9, projects: ["org/core", "org/mobile"], state,
    offers: [unclaimedMobile, check, unclaimedCore, ownedNew, ownedOld, repairing] }).map(o => o.ticket);
  // Owned before unclaimed, recovery before ordinary, older claim first, then project rank: as without the label.
  assert.deepEqual(order, [repairing.ticket, ownedOld.ticket, ownedNew.ticket, unclaimedCore.ticket, unclaimedMobile.ticket, check.ticket]);
});

test("a priority:high verifier never preempts and still obeys locks, ownership, drains and limits", () => {
  const v = verifier(3354), check = { ...offer("org/core", 1), role: "recovery" };
  const base = urgent({ ...empty, claims: [claimOf(check, 1)] }, v);
  const running = (o: WorkOffer, machine = "mac") => ({ ...o, id: `run-${o.ticket}`, machine, session: "s", generation: "g", created: 1 });
  // A running heavy job keeps its place; nothing new starts in a full heavy place.
  assert.deepEqual(select([v, check], { ...base, runs: [running(offer("org/mobile", 7))] }), []);
  // Same-ticket run, project lock, reconcile lock.
  assert.deepEqual(select([v, check], { ...base, runs: [running({ ...v, role: "builder", resource: "light" }, "linux")] }, 2).map(o => o.ticket), [check.ticket]);
  const locked = { ...v, locks: ["org/core:release"] };
  assert.deepEqual(select([locked, check], { ...base, runs: [running({ ...offer("org/mobile", 8, "light"), project: "org/core", ticket: "org/core#8", locks: ["org/core:release"] }, "linux")] }).map(o => o.ticket), [check.ticket]);
  assert.deepEqual(select([v], { ...base, runs: [running({ ...offer("org/core", 9, "light"), ticket: "org/core#@reconcile", locks: ["org/core:reconcile"] }, "linux")] }), []);
  // Owned by another computer: never admitted here.
  assert.deepEqual(select([v, check], { ...base, claims: [...base.claims, claimOf(v, 2, "linux")] }).map(o => o.ticket), [check.ticket]);
  // Project drain stops an unclaimed verifier.
  assert.deepEqual(scheduleMachine({ machine: "mac", projects: ["org/core", "org/mobile"], drainingProjects: ["org/core"], heavyLimit: 1, combinedLimit: 1,
    offers: [v], state: base }), []);
  // A full new-ticket budget leaves the unclaimed verifier waiting and the fitting owned check runs.
  const busy = { ...base, runs: [running(offer("org/mobile", 20, "light")), running(offer("org/mobile", 21, "light"))] };
  assert.deepEqual(capped([v, check], busy).map(o => o.ticket), [check.ticket]);
  // A role limit still holds.
  const limited = { ...v, roleLimit: 1 };
  assert.deepEqual(select([limited, check], { ...base, runs: [running(verifier(30), "linux")] }).map(o => o.ticket), [check.ticket]);
  // An unknown snapshot field from an older authority changes nothing.
  assert.deepEqual(select([v, check], { ...empty, claims: [claimOf(check, 1)] }).map(o => o.ticket), [check.ticket]);
});
