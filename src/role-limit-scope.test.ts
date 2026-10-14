// Machine-scoped role limits and per-project heavy limits (2026-10-14).
//
// The verifier's one-at-a-time cap protects the host (emulator, local relay
// and daemon), so it counts per computer. Documentation's cap protects
// shared repository files, so it stays fleet-wide. Separately, a computer
// can cap one project's heavy jobs below its own heavy limit: build-hp-1
// fits a Mobile and a Core heavy job together, but not two Mobile verifiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetStore, heavyProject, validateLimits, validateStart, type FleetSnapshot, type StartRequest } from "./fleet-store.js";
import { scheduleMachine, type WorkOffer } from "./machine-scheduler.js";
import { MachineManager } from "./machine-manager.js";
import { ManagedDispatch } from "./managed-dispatch.js";
import { resolveStageSet } from "./stage-sets.js";

const CORE = "org/core", MOBILE = "org/mobile";
const MACHINES = { pyrybox: { heavyLimit: 1, combinedLimit: 2 }, hp: { heavyLimit: 1, combinedLimit: 2 }, fractal: { heavyLimit: 1, combinedLimit: 2 } };

/** A verifier offer as this change's dispatcher states it. */
const newVerifier = (n: number, project = CORE): WorkOffer => ({
  project, ticket: `${project}#${n}`, role: "verifier", resource: "heavy", locks: [], key: `v${n}`, order: 0, roleLimit: 1, roleLimitScope: "machine",
});
/** The same offer from a dispatcher that predates the scope: a fleet role lock and no scope. */
const oldVerifier = (n: number, project = CORE): WorkOffer => ({
  project, ticket: `${project}#${n}`, role: "verifier", resource: "heavy", locks: [`${project}:role:verifier`], key: `v${n}`, order: 0, roleLimit: 1,
});
const documentation = (n: number, project = CORE): WorkOffer => ({
  project, ticket: `${project}#${n}`, role: "documentation", resource: "light", locks: [`${project}:role:documentation`], key: `d${n}`, order: 0, roleLimit: 1,
});
const job = (n: number, project: string, role = "builder", resource: "heavy" | "medium" | "light" = "heavy"): WorkOffer => ({
  project, ticket: `${project}#${n}`, role, resource, locks: [], key: `${role}${n}`, order: n,
});
const start = (offer: WorkOffer, machine: string, id = `${machine}-${offer.key}`): StartRequest => {
  const { key: _key, order: _order, ...rest } = offer;
  return { ...rest, id, machine, session: `s-${machine}` };
};
const running = (offer: WorkOffer, machine: string) => ({ ...start(offer, machine), generation: "g", created: 1 });
const empty: FleetSnapshot = { claims: [], runs: [] };
const schedule = (machine: string, offers: WorkOffer[], state: FleetSnapshot, limits: { heavyLimit: number; combinedLimit: number; projectHeavyLimits?: Record<string, number> } = MACHINES.pyrybox) =>
  scheduleMachine({ machine, projects: [CORE, MOBILE], offers, state, ...limits }).map(o => o.ticket);

// ---------- Part 1: role limit scope ----------

test("the authority admits same-project verifiers on different computers and refuses a second on one computer", () => {
  const store = new FleetStore(":memory:", { ...MACHINES, pyrybox: { heavyLimit: 2, combinedLimit: 3 } });
  try {
    // The 2026-10-14 case: #3341 verifying on Fractal, #3354 and #3331 waiting.
    assert.equal(store.start(start(newVerifier(3341), "fractal")).ok, true);
    assert.equal(store.start(start(newVerifier(3354), "pyrybox")).ok, true);
    assert.equal(store.start(start(newVerifier(3331), "hp")).ok, true);
    // pyrybox has a second heavy place here, so only the role limit can refuse this.
    assert.deepEqual(store.start(start(newVerifier(3332), "pyrybox")), { ok: false, reason: "locked" });
    // Another project's verifier is its own role.
    assert.equal(store.start(start(newVerifier(7, MOBILE), "pyrybox")).ok, true);
  } finally { store.close(); }
});

test("the scheduler offers a verifier while another computer verifies, and holds it behind a local one", () => {
  const elsewhere = { ...empty, runs: [running(newVerifier(3341), "fractal")] };
  assert.deepEqual(schedule("pyrybox", [newVerifier(3354)], elsewhere), [`${CORE}#3354`]);
  const roomy = { heavyLimit: 2, combinedLimit: 3 };
  const local = { ...empty, runs: [running(newVerifier(3341), "pyrybox")] };
  assert.deepEqual(schedule("pyrybox", [newVerifier(3354), job(5, CORE, "builder", "medium")], local, roomy), [`${CORE}#5`]);
  // Two waiting verifiers on one computer: one is selected per pass.
  assert.deepEqual(schedule("pyrybox", [newVerifier(3354), newVerifier(3331)], empty, roomy), [`${CORE}#3331`]);
});

test("documentation stays fleet-wide in the dispatcher's offer, the scheduler and the authority", () => {
  const managed = new ManagedDispatch(CORE, { PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test" });
  const set = resolveStageSet("builder", {});
  const docs = managed.agentOffer(set.agents.find(a => a.name === "documentation")!, { issueNumber: 9, labels: [] } as any, 0).offer;
  assert.equal(docs.roleLimit, 1);
  assert.equal(docs.roleLimitScope, undefined);
  assert.deepEqual(docs.locks, [`${CORE}:role:documentation`]);

  const elsewhere = { ...empty, runs: [running(documentation(1), "fractal")] };
  assert.deepEqual(schedule("pyrybox", [documentation(2)], elsewhere), []);
  // Even without the lock, the unscoped role limit counts other computers.
  assert.deepEqual(schedule("pyrybox", [{ ...documentation(2), locks: [] }], elsewhere), []);

  const store = new FleetStore(":memory:", MACHINES);
  try {
    assert.equal(store.start(start(documentation(1), "fractal")).ok, true);
    assert.deepEqual(store.start(start({ ...documentation(2), locks: [] }, "pyrybox")), { ok: false, reason: "locked" });
    // An explicit "fleet" scope means the same as none.
    assert.deepEqual(store.start(start({ ...documentation(2), locks: [], roleLimitScope: "fleet" }, "pyrybox")), { ok: false, reason: "locked" });
  } finally { store.close(); }
});

test("the builder set's serial verifier is machine-scoped and takes no fleet lock; a PYRY_VERIFIER_MAX cap stays a fleet total", () => {
  const managed = new ManagedDispatch(CORE, { PYRY_MANAGER_URL: "http://localhost:1", PYRY_MANAGER_TOKEN: "test" });
  const serial = resolveStageSet("builder", {}).agents.find(a => a.name === "verifier")!;
  assert.equal(serial.roleLimitScope, "machine");
  const offer = managed.agentOffer(serial, { issueNumber: 100, labels: [] } as any, 0).offer;
  assert.deepEqual([offer.locks, offer.roleLimit, offer.roleLimitScope], [[], 1, "machine"]);

  const capped = resolveStageSet("builder", { PYRY_VERIFIER_SERIAL: "0", PYRY_VERIFIER_MAX: "2" }).agents.find(a => a.name === "verifier")!;
  assert.equal("roleLimitScope" in capped, false);
  const cappedOffer = managed.agentOffer(capped, { issueNumber: 101, labels: [] } as any, 0).offer;
  assert.deepEqual([cappedOffer.locks, cappedOffer.roleLimit, cappedOffer.roleLimitScope], [[], 2, undefined]);

  const open = resolveStageSet("builder", { PYRY_VERIFIER_SERIAL: "0" }).agents.find(a => a.name === "verifier")!;
  assert.equal("roleLimitScope" in open, false);
  const openOffer = managed.agentOffer(open, { issueNumber: 102, labels: [] } as any, 0).offer;
  assert.deepEqual([openOffer.roleLimit, openOffer.roleLimitScope], [undefined, undefined]);
  // The default set is untouched by building the variants.
  assert.equal(resolveStageSet("builder", {}).agents.find(a => a.name === "verifier")!.roleLimitScope, "machine");
});

test("mixed versions: an older verifier offer keeps counting the whole fleet", () => {
  // Older dispatcher on pyrybox, newer one on Fractal, both on this authority.
  const store = new FleetStore(":memory:", MACHINES);
  try {
    assert.equal(store.start(start(newVerifier(3341), "fractal")).ok, true);
    // The old offer has no scope, so Fractal's verifier counts against it.
    assert.deepEqual(store.start(start(oldVerifier(3354), "pyrybox")), { ok: false, reason: "locked" });
    // The newer offer counts only its own computer.
    assert.equal(store.start(start(newVerifier(3354), "pyrybox")).ok, true);
  } finally { store.close(); }
  const store2 = new FleetStore(":memory:", MACHINES);
  try {
    // The old verifier runs first and holds its fleet lock. A new offer
    // carries no lock, so the lock does not hold it; its own computer is free.
    assert.equal(store2.start(start(oldVerifier(3341), "fractal")).ok, true);
    assert.equal(store2.start(start(newVerifier(3354), "pyrybox")).ok, true);
    // A second old offer is still refused, by lock and fleet count.
    assert.deepEqual(store2.start(start(oldVerifier(3331), "hp")), { ok: false, reason: "locked" });
  } finally { store2.close(); }
  // An older manager's scheduler ignores the scope and counts every computer:
  // the same answer as an unscoped offer, which is today's behaviour.
  const elsewhere = { ...empty, runs: [running(newVerifier(3341), "fractal")] };
  assert.deepEqual(schedule("pyrybox", [{ ...newVerifier(3354), roleLimitScope: undefined }], elsewhere), []);
});

test("the start request validates the scope and requires a role limit with it", () => {
  const base = start(newVerifier(1), "pyrybox");
  assert.doesNotThrow(() => validateStart(base));
  assert.doesNotThrow(() => validateStart({ ...base, roleLimitScope: "fleet" }));
  assert.throws(() => validateStart({ ...base, roleLimitScope: "host" as any }), /role limit scope/);
  assert.throws(() => validateStart({ ...base, roleLimit: undefined }), /role limit scope/);
  // Only a support task may be charged to another ticket's project.
  assert.throws(() => validateStart({ ...start(job(1, CORE), "hp"), parentTicket: `${MOBILE}#1` }), /support task/);
});

test("the manager's status queue and admission both apply the machine scope", async () => {
  const store = new FleetStore(":memory:", { ...MACHINES, pyrybox: { heavyLimit: 2, combinedLimit: 3 } });
  try {
    const client = { snapshot: async () => store.snapshot(), start: async (r: StartRequest) => store.start(r), finish: async (s: string, id: string) => store.finish("pyrybox", s, id) };
    assert.equal(store.start(start(newVerifier(3341), "fractal")).ok, true);
    const manager = new MachineManager({ machine: "pyrybox", heavyLimit: 2, combinedLimit: 3, ticketLimit: 3, projects: [CORE] }, client);
    manager.offer(CORE, "s", [newVerifier(3354), newVerifier(3331)]);
    const before = await manager.status();
    assert.deepEqual(before.queue.map(q => q.state).sort(), ["eligible", "waiting-for-capacity-or-lock"]);
    await manager.tick();
    const granted = (await manager.grants(CORE, "s")).map(r => r.ticket);
    assert.equal(granted.length, 1);
    const after = await manager.status();
    const waiting = after.queue.find(q => !granted.includes(q.ticket))!;
    assert.equal(waiting.state, "waiting-for-capacity-or-lock");
    assert.equal(store.snapshot().runs.filter(r => r.role === "verifier").length, 2);
  } finally { store.close(); }
});

// ---------- Part 2: per-project heavy limit ----------

const HP = { heavyLimit: 2, combinedLimit: 3, projectHeavyLimits: { [MOBILE]: 1 } };

test("a per-project heavy limit holds a second Mobile heavy job and lets a Core one take the place", () => {
  const mobileRunning = { ...empty, runs: [running(newVerifier(1, MOBILE), "hp")] };
  assert.deepEqual(schedule("hp", [job(2, MOBILE), job(3, CORE)], mobileRunning, HP), [`${CORE}#3`]);
  // With a heavy place free and only Mobile waiting, the Mobile job still waits.
  assert.deepEqual(schedule("hp", [job(2, MOBILE)], mobileRunning, HP), []);
  // Within one pass, too: one of two waiting Mobile heavy jobs, with a heavy place left over.
  assert.deepEqual(schedule("hp", [job(2, MOBILE), job(4, MOBILE)], empty, HP), [`${MOBILE}#2`]);
  assert.deepEqual(schedule("hp", [job(2, MOBILE), job(4, MOBILE), job(3, CORE)], empty, HP), [`${CORE}#3`, `${MOBILE}#2`]);
  // Medium and light Mobile work is not charged to the heavy limit.
  assert.deepEqual(schedule("hp", [job(5, MOBILE, "builder", "medium"), job(6, MOBILE, "refiner", "light")], mobileRunning, HP),
    [`${MOBILE}#5`, `${MOBILE}#6`]);
  // Another computer's Mobile heavy run does not count here.
  const elsewhere = { ...empty, runs: [running(job(1, MOBILE), "pyrybox")] };
  assert.deepEqual(schedule("hp", [job(2, MOBILE)], elsewhere, HP), [`${MOBILE}#2`]);
  // Absent means no extra limit: two Mobile heavy jobs fit a heavy limit of 2.
  assert.deepEqual(schedule("hp", [job(2, MOBILE), job(4, MOBILE)], empty, { heavyLimit: 2, combinedLimit: 3 }), [`${MOBILE}#2`, `${MOBILE}#4`]);
});

test("a support task is charged to the project of the ticket it serves", () => {
  assert.equal(heavyProject({ project: CORE, parentTicket: `${MOBILE}#12` }), MOBILE);
  assert.equal(heavyProject({ project: CORE }), CORE);
  const task: WorkOffer = { ...job(0, CORE, "recovery-task"), ticket: `${CORE}#@task-${"a".repeat(64)}`, supportTaskId: "a".repeat(64), parentTicket: `${MOBILE}#12` };
  const mobileRunning = { ...empty, runs: [running(newVerifier(1, MOBILE), "hp")] };
  assert.deepEqual(schedule("hp", [task], mobileRunning, HP), []);
  assert.deepEqual(schedule("hp", [task], empty, HP), [task.ticket]);
});

test("the authority enforces the per-project heavy limit on its own", () => {
  const store = new FleetStore(":memory:", { hp: HP, pyrybox: MACHINES.pyrybox });
  try {
    assert.equal(store.start(start(job(1, MOBILE), "hp")).ok, true);
    assert.deepEqual(store.start(start(job(2, MOBILE), "hp")), { ok: false, reason: "capacity" });
    assert.equal(store.start(start(job(2, MOBILE, "builder", "medium"), "hp")).ok, true);
    assert.equal(store.start(start(job(3, CORE), "hp")).ok, true);
    // Both heavy places are full now.
    assert.deepEqual(store.start(start(job(4, CORE), "hp")), { ok: false, reason: "capacity" });
    // Finishing the Mobile run frees the Mobile place.
    store.finish("hp", "s-hp", "hp-builder1");
    assert.equal(store.start(start(job(5, MOBILE), "hp")).ok, true);
    // pyrybox has no per-project limit.
    assert.equal(store.start(start(job(6, MOBILE), "pyrybox")).ok, true);
  } finally { store.close(); }
});

test("per-project heavy limits are optional, validated, and shown in the manager status", async () => {
  assert.doesNotThrow(() => validateLimits({ heavyLimit: 1, combinedLimit: 2 }));
  assert.doesNotThrow(() => validateLimits(HP));
  for (const bad of [{ [MOBILE]: 0 }, { [MOBILE]: 1.5 }, { [MOBILE]: "1" }, { mobile: 1 }, [1], null]) {
    assert.throws(() => validateLimits({ heavyLimit: 2, combinedLimit: 3, projectHeavyLimits: bad as any }), /projectHeavyLimits/);
  }
  const store = new FleetStore(":memory:", { hp: HP });
  try {
    const client = { snapshot: async () => store.snapshot(), start: async (r: StartRequest) => store.start(r), finish: async (s: string, id: string) => store.finish("hp", s, id) };
    assert.throws(() => new MachineManager({ machine: "hp", ...HP, projects: [CORE] }, client), /does not serve/);
    assert.throws(() => new FleetStore(":memory:", { hp: { ...HP, projectHeavyLimits: { [MOBILE]: 0 } } }), /projectHeavyLimits/);
    const manager = new MachineManager({ machine: "hp", ...HP, ticketLimit: 3, projects: [CORE, MOBILE] }, client);
    assert.deepEqual((await manager.status()).projectHeavyLimits, { [MOBILE]: 1 });
    manager.offer(MOBILE, "m", [job(1, MOBILE), job(2, MOBILE)]);
    manager.offer(CORE, "c", [job(3, CORE)]);
    await manager.tick();
    assert.deepEqual(store.snapshot().runs.map(r => r.ticket).sort(), [`${CORE}#3`, `${MOBILE}#1`]);
    const queue = (await manager.status()).queue;
    assert.equal(queue.find(q => q.ticket === `${MOBILE}#2`)!.state, "waiting-for-capacity-or-lock");
    // The manager holds the limit even when the authority has none for this computer.
    const loose = new FleetStore(":memory:", { hp: { heavyLimit: 2, combinedLimit: 3 } });
    try {
      const looseClient = { snapshot: async () => loose.snapshot(), start: async (r: StartRequest) => loose.start(r), finish: async (s: string, id: string) => loose.finish("hp", s, id) };
      const strict = new MachineManager({ machine: "hp", ...HP, ticketLimit: 3, projects: [CORE, MOBILE] }, looseClient);
      strict.offer(MOBILE, "m", [job(1, MOBILE), job(2, MOBILE)]);
      await strict.tick();
      assert.deepEqual(loose.snapshot().runs.map(r => r.ticket), [`${MOBILE}#1`]);
    } finally { loose.close(); }
    const plain = new MachineManager({ machine: "hp", heavyLimit: 2, combinedLimit: 3, projects: [CORE] }, client);
    assert.equal("projectHeavyLimits" in await plain.status(), false);
  } finally { store.close(); }
});
