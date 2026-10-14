// Review queue limit (2026-10-14).
//
// A computer takes no new ticket while the tickets it owns that wait for
// review reach its limit, by default its heavy limit. build-fractal-2 owned
// six runnable tickets, three of them waiting for its one heavy place, while
// build-hp-1 sat half idle. Work on owned tickets is never held.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetStore, type FleetSnapshot, type StartRequest } from "./fleet-store.js";
import { scheduleMachine, reviewQueue, effectiveReviewQueueLimit, type WorkOffer } from "./machine-scheduler.js";
import { MachineManager } from "./machine-manager.js";
import { awaitsReview, type WorkflowItem } from "./workflow-store.js";

const CORE = "org/core", MOBILE = "org/mobile";
const claim = (ticket: string, machine = "fractal") => ({ ticket, machine, generation: `g-${ticket}`, created: 1 });
const offer = (ticket: string, role = "builder", resource: "heavy" | "medium" | "light" = "medium"): WorkOffer => ({
  project: ticket.split("#")[0], ticket, role, resource, locks: [], key: `${role}-${ticket}`, order: Number(ticket.split("#")[1]),
});
const schedule = (state: FleetSnapshot, offers: WorkOffer[], limits: { heavyLimit: number; combinedLimit: number; reviewQueueLimit?: number } = { heavyLimit: 1, combinedLimit: 3 }, machine = "fractal") =>
  scheduleMachine({ machine, projects: [CORE, MOBILE], offers, state, ticketLimit: 10, ...limits }).map(o => `${o.role} ${o.ticket}`);

// ---------- Which tickets wait for review ----------

const item = (status: string, labels: string[] = [], blockedBy: WorkflowItem["blockedBy"] = [], state: "OPEN" | "CLOSED" = "OPEN") => ({ status, labels, blockedBy, state });

test("a ticket waits for review in its review column with nothing holding it", () => {
  assert.equal(awaitsReview(item("In Code Review")), true);
  assert.equal(awaitsReview(item("In QA")), true, "classic qa");
  assert.equal(awaitsReview(item("In Code Review", ["priority:high", "size:S", "error-retry-count:1", "rework-count:2", "wip:repair", "needs-human:sizing"])), true);
  assert.equal(awaitsReview(item("In Code Review", [], [{ number: 5, state: "CLOSED" }])), true, "a closed blocker holds nothing");
  for (const status of ["Backlog", "In Development", "In Architecture", "In Documentation", "Done", "Halted", "Inbox"]) assert.equal(awaitsReview(item(status)), false, status);
});

test("blocked, errored, held, running, reworked and passed tickets do not wait for review", () => {
  const held: Array<[string, ReturnType<typeof item>]> = [
    ["open blocker", item("In Code Review", [], [{ number: 5, state: "OPEN" }])],
    ["error", item("In Code Review", ["error:verifier"])],
    ["family breaker", item("In Code Review", ["error:family-breaker"])],
    ["operator hold", item("In Code Review", ["needs-human:approval"])],
    ["health hold", item("In Code Review", ["health-hold:emulator"])],
    ["running verifier", item("In Code Review", ["wip:verifier"])],
    ["rework on its way", item("In Code Review", ["needs-rework:builder"])],
    ["passed verifier", item("In Code Review", ["done:verifier"])],
    ["passed code review", item("In Code Review", ["done:code-review"])],
    ["passed qa", item("In QA", ["done:qa"])],
    ["closed", item("In Code Review", [], [], "CLOSED")],
  ];
  for (const [name, i] of held) assert.equal(awaitsReview(i), false, name);
  // Passing qa in the classic set leads on to code review, which is review again.
  assert.equal(awaitsReview(item("In Code Review", ["done:qa"])), true);
});

// ---------- The scheduler ----------

test("one owned ticket waiting for review holds new tickets at heavy limit 1, at any stage", () => {
  const state: FleetSnapshot = { claims: [claim(`${CORE}#1`)], runs: [], reviewReadyTickets: [`${CORE}#1`] };
  // A new builder, a new refiner and a recovery check of an unowned ticket all wait.
  assert.deepEqual(schedule(state, [offer(`${MOBILE}#7`), offer(`${CORE}#8`, "refiner", "light"), offer(`${CORE}#9`, "recovery", "heavy")]), []);
  // Shared jobs are not tickets and are not held.
  assert.deepEqual(schedule(state, [offer(`${CORE}#@reconcile`, "reconcile", "light")]), [`reconcile ${CORE}#@reconcile`]);
  // Without the queue the same offers are taken.
  assert.deepEqual(schedule({ ...state, reviewReadyTickets: [] }, [offer(`${MOBILE}#7`), offer(`${CORE}#8`, "refiner", "light")]),
    [`refiner ${CORE}#8`, `builder ${MOBILE}#7`]);
});

test("the count spans every project on the computer", () => {
  const offers = [offer(`${CORE}#9`)];
  const hp = { heavyLimit: 2, combinedLimit: 3 };
  const one: FleetSnapshot = { claims: [claim(`${CORE}#1`)], runs: [], reviewReadyTickets: [`${CORE}#1`] };
  assert.deepEqual(schedule(one, offers, hp), [`builder ${CORE}#9`]);
  const two: FleetSnapshot = { claims: [claim(`${CORE}#1`), claim(`${MOBILE}#2`)], runs: [], reviewReadyTickets: [`${CORE}#1`, `${MOBILE}#2`] };
  assert.deepEqual(schedule(two, offers, hp), [], "a Core and a Mobile ticket make two");
});

test("only this computer's idle owned tickets count", () => {
  const offers = [offer(`${CORE}#9`)];
  const ready = [`${CORE}#1`, `${CORE}#2`, `${CORE}#3`];
  // Owned by other computers.
  assert.deepEqual(schedule({ claims: [claim(`${CORE}#1`, "hp"), claim(`${CORE}#2`, "pyrybox")], runs: [], reviewReadyTickets: ready }, offers), [`builder ${CORE}#9`]);
  // Under review already: a verifier run, or a support task serving it.
  const verifying = { ...offer(`${CORE}#1`, "verifier", "heavy"), id: "v", machine: "fractal", session: "s", generation: "g", created: 1 };
  assert.deepEqual(schedule({ claims: [claim(`${CORE}#1`)], runs: [verifying], reviewReadyTickets: ready }, offers, { heavyLimit: 1, combinedLimit: 3 }), [`builder ${CORE}#9`]);
  const task = { project: CORE, ticket: `${CORE}#@task-x`, role: "recovery-task", resource: "light" as const, locks: [], parentTicket: `${CORE}#1`, supportTaskId: "x".repeat(64), id: "t", machine: "fractal", session: "s", generation: "g", created: 1 };
  assert.deepEqual(schedule({ claims: [claim(`${CORE}#1`)], runs: [task], reviewReadyTickets: ready }, offers), [`builder ${CORE}#9`]);
  // Owned but not ready (blocked, errored, held or in development) is absent from the authority's list.
  assert.deepEqual(schedule({ claims: [claim(`${CORE}#4`), claim(`${CORE}#5`)], runs: [], reviewReadyTickets: ready }, offers), [`builder ${CORE}#9`]);
});

test("owned work is never held: verifiers, rework builders, documentation and recovery continue", () => {
  const claims = [1, 2, 3, 4, 5].map(n => claim(`${CORE}#${n}`));
  const state: FleetSnapshot = { claims, runs: [], reviewReadyTickets: [`${CORE}#1`, `${CORE}#2`] };
  const owned = [offer(`${CORE}#1`, "verifier", "heavy"), offer(`${CORE}#3`, "builder"), offer(`${CORE}#4`, "documentation", "light"), offer(`${CORE}#5`, "recovery", "light")];
  const picked = schedule(state, [...owned, offer(`${MOBILE}#9`)], { heavyLimit: 1, combinedLimit: 3 });
  assert.deepEqual(picked.sort(), [`builder ${CORE}#3`, `documentation ${CORE}#4`, `recovery ${CORE}#5`, `verifier ${CORE}#1`].sort());
});

test("a verifier started in the same pass frees a place in the queue", () => {
  const state: FleetSnapshot = { claims: [claim(`${CORE}#1`)], runs: [], reviewReadyTickets: [`${CORE}#1`] };
  assert.deepEqual(schedule(state, [offer(`${CORE}#1`, "verifier", "heavy"), offer(`${MOBILE}#9`)]), [`verifier ${CORE}#1`, `builder ${MOBILE}#9`]);
});

test("reviewQueueLimit overrides the heavy limit, and 0 turns the hold off", () => {
  const state: FleetSnapshot = { claims: [claim(`${CORE}#1`), claim(`${CORE}#2`)], runs: [], reviewReadyTickets: [`${CORE}#1`, `${CORE}#2`] };
  const offers = [offer(`${MOBILE}#9`)];
  assert.deepEqual(schedule(state, offers, { heavyLimit: 1, combinedLimit: 3, reviewQueueLimit: 3 }), [`builder ${MOBILE}#9`]);
  assert.deepEqual(schedule(state, offers, { heavyLimit: 2, combinedLimit: 3, reviewQueueLimit: 2 }), []);
  assert.deepEqual(schedule(state, offers, { heavyLimit: 2, combinedLimit: 3, reviewQueueLimit: 0 }), [`builder ${MOBILE}#9`]);
  assert.equal(effectiveReviewQueueLimit({ heavyLimit: 2 }), 2);
  assert.equal(effectiveReviewQueueLimit({ heavyLimit: 2, reviewQueueLimit: 0 }), 0);
});

test("an older claim service that sends no review list holds nothing", () => {
  const state: FleetSnapshot = { claims: [claim(`${CORE}#1`), claim(`${CORE}#2`)], runs: [] };
  assert.equal(reviewQueue("fractal", state), undefined);
  assert.deepEqual(schedule(state, [offer(`${MOBILE}#9`)]), [`builder ${MOBILE}#9`]);
});

test("the manager rejects an invalid review queue limit", () => {
  const client = { snapshot: async () => ({ claims: [], runs: [] }), start: async () => ({ ok: true as const, generation: "g" }), finish: async () => {} };
  const base = { machine: "fractal", heavyLimit: 1, combinedLimit: 2, projects: [CORE] };
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => new MachineManager({ ...base, reviewQueueLimit: bad }, client), /review queue limit/);
  assert.doesNotThrow(() => new MachineManager({ ...base, reviewQueueLimit: 0 }, client));
});

// ---------- End to end through the authority ----------

const PROJECT = (project: string) => ({ project, projectId: `P-${project}`, statusFieldId: "S",
  options: { Inbox: "i", Backlog: "b", "In Development": "d", "In Code Review": "r", "In Documentation": "doc", Done: "done" } });
const ticketItem = (project: string, n: number, status = "In Development", labels: string[] = [], blockedBy: WorkflowItem["blockedBy"] = []) => ({
  id: `P${project}${n}`, issueId: `I${project}${n}`, issueNumber: n, title: "t", body: "b", url: `https://github.com/${project}/issues/${n}`,
  status, labels, blockedBy, parentNumber: null, grandparentNumber: null, state: "OPEN" as const, revision: 1, position: n });
const request = (id: string, machine: string, ticket: string, role = "builder", resource: "heavy" | "medium" | "light" = "medium"): StartRequest =>
  ({ workflowVersion: 1, id, machine, session: `s-${machine}`, project: ticket.split("#")[0], ticket, role, resource, locks: [] });

/** Fractal builds #1 to #4 of each listed ticket, so it owns them, and each moves on to review. */
function fleet() {
  const store = new FleetStore(":memory:", { fractal: { heavyLimit: 1, combinedLimit: 3 }, hp: { heavyLimit: 2, combinedLimit: 3 } });
  store.workflow.import(PROJECT(CORE), [1, 2, 3, 4, 9].map(n => ticketItem(CORE, n, n === 4 ? "Backlog" : "In Development")));
  store.workflow.import(PROJECT(MOBILE), [1, 2, 9].map(n => ticketItem(MOBILE, n)));
  const build = (machine: string, ticket: string) => {
    assert.equal(store.start(request(`b-${ticket}`, machine, ticket)).ok, true);
    store.finish(machine, `s-${machine}`, `b-${ticket}`);
    store.workflow.change(ticket, { status: "In Code Review" }, "test", `review-${ticket}`);
  };
  return { store, build };
}

test("the authority reports review-ready tickets across projects, resolving blockers, and follows changes", () => {
  const { store, build } = fleet();
  try {
    assert.deepEqual(store.snapshot().reviewReadyTickets, [], "present and empty once projects are adopted");
    build("fractal", `${CORE}#1`);
    build("fractal", `${MOBILE}#1`);
    build("hp", `${CORE}#2`);
    assert.deepEqual(store.snapshot().reviewReadyTickets, [`${CORE}#1`, `${CORE}#2`, `${MOBILE}#1`]);
    // An error, a hold and an open blocker take tickets out; clearing them puts them back.
    store.workflow.change(`${CORE}#1`, { addLabels: ["error:verifier"] }, "test", "e1");
    store.workflow.change(`${MOBILE}#1`, { blockedBy: [{ number: 9, state: "OPEN", url: `https://github.com/${CORE}/issues/9` }] }, "test", "blk");
    store.workflow.change(`${CORE}#2`, { addLabels: ["needs-human:approval"] }, "test", "hold");
    assert.deepEqual(store.snapshot().reviewReadyTickets, []);
    // The blocker is another project's ticket; closing it in the store releases its dependant.
    store.workflow.change(`${CORE}#9`, { state: "CLOSED", status: "Done" }, "test", "close-9");
    store.workflow.change(`${CORE}#1`, { removeLabels: ["error:verifier"] }, "test", "e1-clear");
    assert.deepEqual(store.snapshot().reviewReadyTickets, [`${CORE}#1`, `${MOBILE}#1`]);
    // Callers cannot alter the kept list.
    store.snapshot().reviewReadyTickets!.push(`${CORE}#99`);
    assert.deepEqual(store.snapshot().reviewReadyTickets, [`${CORE}#1`, `${MOBILE}#1`]);
  } finally { store.close(); }
});

test("a claim service with no adopted project sends no review list", () => {
  const store = new FleetStore(":memory:", { fractal: { heavyLimit: 1, combinedLimit: 3 } });
  try { assert.equal(store.snapshot().reviewReadyTickets, undefined); } finally { store.close(); }
});

test("the manager holds new tickets, shows review-queue-full and keeps owned work moving", async () => {
  const { store, build } = fleet();
  try {
    build("fractal", `${CORE}#1`);
    build("hp", `${CORE}#2`);
    // Fractal also owns #3, still in development (a rework builder).
    assert.equal(store.start(request("b3", "fractal", `${CORE}#3`)).ok, true);
    store.finish("fractal", "s-fractal", "b3");
    const client = { snapshot: async () => store.snapshot(), start: async (r: StartRequest) => store.start(r), finish: async () => {} };
    const manager = new MachineManager({ machine: "fractal", heavyLimit: 1, combinedLimit: 3, ticketLimit: 10, projects: [CORE, MOBILE] }, client);
    const newBuilder = { ...offer(`${MOBILE}#9`), workflowVersion: 1 as const };
    const newRefiner = { ...offer(`${CORE}#4`, "refiner", "light"), workflowVersion: 1 as const };
    const rework = { ...offer(`${CORE}#3`), workflowVersion: 1 as const };
    manager.offer(MOBILE, "m", [newBuilder]);
    manager.offer(CORE, "c", [newRefiner, rework]);
    const status = await manager.status();
    assert.deepEqual(status.reviewQueue, { limit: 1, tickets: [`${CORE}#1`], full: true });
    assert.deepEqual(Object.fromEntries(status.queue.map(q => [q.ticket, q.state])),
      { [`${MOBILE}#9`]: "review-queue-full", [`${CORE}#4`]: "review-queue-full", [`${CORE}#3`]: "eligible" });
    await manager.tick();
    assert.deepEqual(store.snapshot().runs.map(r => r.ticket), [`${CORE}#3`], "only the owned rework started");

    // Its verifier starts: #1 is under review, so the queue empties and new work flows.
    store.finish("fractal", "c", (await manager.grants(CORE, "c"))[0].id);
    manager.offer(CORE, "c", [newRefiner, { ...offer(`${CORE}#1`, "verifier", "heavy"), workflowVersion: 1 }]);
    await manager.tick();
    assert.deepEqual(store.snapshot().runs.map(r => r.ticket).sort(), [`${CORE}#1`, `${CORE}#4`, `${MOBILE}#9`].sort());
    assert.deepEqual((await manager.status()).reviewQueue, { limit: 1, tickets: [], full: false });
  } finally { store.close(); }
});

test("build-hp-1 at heavy limit 2 takes new work with one ticket waiting and holds at two", async () => {
  const { store, build } = fleet();
  try {
    build("hp", `${CORE}#1`);
    const client = { snapshot: async () => store.snapshot(), start: async (r: StartRequest) => store.start(r), finish: async () => {} };
    const manager = new MachineManager({ machine: "hp", heavyLimit: 2, combinedLimit: 3, ticketLimit: 10, projects: [CORE, MOBILE] }, client);
    assert.deepEqual((await manager.status()).reviewQueue, { limit: 2, tickets: [`${CORE}#1`], full: false });
    build("hp", `${MOBILE}#1`);
    const status = await manager.status();
    assert.deepEqual(status.reviewQueue, { limit: 2, tickets: [`${CORE}#1`, `${MOBILE}#1`], full: true });
    manager.offer(MOBILE, "m", [{ ...offer(`${MOBILE}#9`), workflowVersion: 1 }]);
    await manager.tick();
    assert.deepEqual(store.snapshot().runs, []);
  } finally { store.close(); }
});

test("a new manager on an older claim service reports an unknown queue and holds nothing", async () => {
  const { store, build } = fleet();
  try {
    build("fractal", `${CORE}#1`);
    build("fractal", `${CORE}#2`);
    // An older claim service: the same snapshot without the review list.
    const old = async () => { const { reviewReadyTickets: _gone, ...rest } = store.snapshot(); return rest; };
    const client = { snapshot: old, start: async (r: StartRequest) => store.start(r), finish: async () => {} };
    const manager = new MachineManager({ machine: "fractal", heavyLimit: 1, combinedLimit: 3, ticketLimit: 10, projects: [CORE, MOBILE] }, client);
    manager.offer(MOBILE, "m", [{ ...offer(`${MOBILE}#9`), workflowVersion: 1 }]);
    const status = await manager.status();
    assert.deepEqual(status.reviewQueue, { limit: 1, tickets: null, full: false });
    assert.equal(status.queue[0].state, "eligible");
    await manager.tick();
    assert.deepEqual(store.snapshot().runs.map(r => r.ticket), [`${MOBILE}#9`]);
  } finally { store.close(); }
});

test("an older manager ignores the new list: the snapshot only adds a field", () => {
  const { store, build } = fleet();
  try {
    build("fractal", `${CORE}#1`);
    const snapshot = store.snapshot();
    const { reviewReadyTickets, ...rest } = snapshot;
    assert.deepEqual(reviewReadyTickets, [`${CORE}#1`]);
    // Scheduling without the field, as an older manager does, is today's behaviour.
    assert.deepEqual(schedule(rest, [offer(`${MOBILE}#9`)]), [`builder ${MOBILE}#9`]);
    // The authority still admits it: the hold lives in the manager, like the ticket limit.
    assert.equal(store.start(request("old", "fractal", `${MOBILE}#9`)).ok, true);
  } finally { store.close(); }
});
