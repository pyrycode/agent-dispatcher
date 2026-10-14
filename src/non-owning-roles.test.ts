import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetStore, NON_OWNING_ROLES, startsOwnership, type StartRequest } from "./fleet-store.js";
import { scheduleMachine, type WorkOffer } from "./machine-scheduler.js";
import type { RecoveryObservation } from "./fleet-recovery.js";

// Decided 2026-10-14: recovery assessments and refinement start no ticket
// ownership. Ownership starts with the first stage that makes local work.
const project = "org/core";
const ticket = `${project}#1`;
const limits = { mac: { heavyLimit: 1, combinedLimit: 2 }, linux: { heavyLimit: 1, combinedLimit: 2 } };
const start = (id: string, role: string, extra: Partial<StartRequest> = {}): StartRequest => ({
  id, session: "session", machine: "mac", project, ticket, role,
  resource: role === "recovery" ? "heavy" : role === "refiner" || role === "po" ? "light" : "medium", locks: [], ...extra,
});
const blocked = (labels: string[] = []): RecoveryObservation => ({ ticket, status: "Backlog", labels, blocked: true });
const failing = (): RecoveryObservation => ({ ticket, status: "In Development", labels: ["error:builder"], blocked: false });

function assess(store: FleetStore, machine: string, runId: string, observation: RecoveryObservation, decision: Parameters<FleetStore["recoveryStep"]>[6]) {
  const [incident] = store.recoveryReport(machine, project, [observation]);
  assert.equal(incident?.state, "queued");
  assert.equal(store.start(start(runId, "recovery", { machine })).ok, true);
  store.recoveryStep(machine, "session", project, incident.id, runId, "begin");
  store.recoveryStep(machine, "session", project, incident.id, runId, "decide", decision);
  store.recoveryStep(machine, "session", project, incident.id, runId, "complete");
  store.finish(machine, "session", runId);
  return incident;
}

test("only recovery, refiner and po start no ownership", () => {
  assert.deepEqual([...NON_OWNING_ROLES].sort(), ["po", "recovery", "refiner"]);
  for (const role of ["builder", "architect", "developer", "verifier", "qa", "code-review", "documentation", "merge", "real-claude-gate", "recovery-task", "reconcile"])
    assert.equal(startsOwnership(role), true, role);
});

test("an assessment on an unowned ticket holds its reservation exclusively but creates no claim", () => {
  const store = new FleetStore(":memory:", limits);
  const [incident] = store.recoveryReport("mac", project, [blocked()]);
  const grant = store.start(start("assess", "recovery"));
  assert.equal(grant.ok, true);
  if (!grant.ok) return;
  assert.deepEqual(store.snapshot().claims, []);
  assert.deepEqual(store.snapshot().runs.map(r => [r.id, r.machine, r.generation, r.resource]), [["assess", "mac", grant.generation, "heavy"]]);
  // Nobody else can run or write the ticket while the assessment runs.
  assert.deepEqual(store.start(start("builder", "builder", { machine: "linux" })), { ok: false, reason: "running" });
  assert.deepEqual(store.start(start("assess-2", "recovery", { machine: "linux" })), { ok: false, reason: "locked" });
  assert.throws(() => store.authorize("linux", "session", ticket), /another machine/);
  assert.throws(() => store.authorize("linux", "session", ticket, "assess"), /another machine/);
  assert.throws(() => store.authorize("mac", "other-session", ticket, "assess"), /active run/);
  assert.throws(() => store.authorize("mac", "session", ticket), /active run/);
  // The assessment's own writes are tied to its own generation.
  assert.equal(store.authorize("mac", "session", ticket, "assess").generation, grant.generation);
  assert.deepEqual(store.start(start("other", "verifier", { ticket: `${project}#2`, resource: "heavy" })), { ok: false, reason: "capacity" }, "the assessment holds its heavy place");
  store.recoveryStep("mac", "session", project, incident.id, "assess", "begin");
  store.recordPause("mac", "session", project, "assess", { ticket, origin: "pipeline", actor: "x", reason: "Waits on #2", missing: "#2", resumeOn: "#2 closes", resumeStatus: "Backlog", revision: "ignored" });
  assert.equal(store.facts.getPause(ticket)?.revision, grant.generation);
  store.recoveryStep("mac", "session", project, incident.id, "assess", "decide", { action: "wait", reason: "The prerequisite is open" });
  store.recoveryStep("mac", "session", project, incident.id, "assess", "complete");
  store.finish("mac", "session", "assess");
  assert.deepEqual(store.snapshot().claims, []);
  assert.deepEqual(store.snapshot().runs, []);
  assert.equal(store.snapshot().releasedAssessmentClaims, undefined, "nothing was owned, so nothing was released");
  assert.throws(() => store.authorize("mac", "session", ticket, "assess"), /grant/, "a finished assessment cannot write");
  // When the blocker closes, any computer can take the work and owns it from its builder.
  const builder = store.start(start("builder", "builder", { machine: "linux" }));
  assert.equal(builder.ok, true);
  assert.deepEqual(store.snapshot().claims.map(c => [c.ticket, c.machine]), [[ticket, "linux"]]);
  store.close();
});

test("an assessment of an owned ticket runs under its claim and leaves it unchanged", () => {
  for (const decision of [
    { action: "wait" as const, reason: "Still blocked" },
    { action: "escalate" as const, category: "human" as const, reason: "Needs a decision" },
    { action: "rework" as const, reason: "Fix the failing path" },
  ]) {
    const store = new FleetStore(":memory:", limits);
    store.start(start("builder", "builder"));
    store.finish("mac", "session", "builder");
    const [owner] = store.snapshot().claims;
    assert.deepEqual(store.start(start("foreign", "recovery", { machine: "linux" })), { ok: false, reason: "foreign-claim" });
    assert.deepEqual(store.recoveryReport("linux", project, [failing()]), [], "another computer does not assess an owned ticket");
    const [incident] = store.recoveryReport("mac", project, [failing()]);
    const grant = store.start(start("assess", "recovery"));
    assert.deepEqual(grant, { ok: true, generation: owner.generation });
    store.recoveryStep("mac", "session", project, incident.id, "assess", "begin");
    store.recoveryStep("mac", "session", project, incident.id, "assess", "decide", decision);
    store.recoveryStep("mac", "session", project, incident.id, "assess", "complete");
    store.finish("mac", "session", "assess");
    assert.deepEqual(store.snapshot().claims, [owner], decision.action);
    // An ordered rework stays with the owner.
    assert.deepEqual(store.start(start("rework", "builder", { machine: "linux" })), { ok: false, reason: "foreign-claim" });
    assert.deepEqual(store.start(start("rework", "builder")), { ok: true, generation: owner.generation });
    store.close();
  }
});

test("after an unowned assessment, other computers see and assess the ticket instead of treating it as foreign", () => {
  const store = new FleetStore(":memory:", limits);
  // An escalation is not an assessment-only wait, so before 2026-10-14 it kept the claim it created.
  assess(store, "mac", "assess", blocked(), { action: "escalate", category: "operational", reason: "The prerequisite is stuck" });
  assert.deepEqual(store.snapshot().claims, []);
  const [reopened] = store.recoveryReport("linux", project, [{ ...failing() }]);
  assert.equal(reopened?.state, "queued", "the stage error is visible to every computer");
  assert.equal(store.start(start("assess-linux", "recovery", { machine: "linux" })).ok, true);
  assert.deepEqual(store.recoveryReport("mac", project, [failing()]), [], "the running assessment is not offered twice");
  store.close();
});

test("a repair decision on an unowned ticket orders work that claims normally when admitted", () => {
  const store = new FleetStore(":memory:", limits);
  const incident = assess(store, "mac", "assess", failing(), { action: "rework", reason: "Fix the failing path" });
  assert.equal(store.recovery.incident(incident.id).state, "complete");
  assert.deepEqual(store.snapshot().claims, []);
  // The ordered stage is not pinned to the assessing computer.
  assert.deepEqual(store.start(start("builder", "builder", { machine: "linux" })).ok, true);
  assert.deepEqual(store.snapshot().claims.map(c => c.machine), ["linux"]);
  store.close();
});

test("a coordinated repair task on an unowned ticket runs anywhere and leaves the ticket unowned", () => {
  const store = new FleetStore(":memory:", limits);
  assess(store, "mac", "assess", failing(), { action: "coordinate", reason: "Dispatcher repair needed",
    task: { recipe: "dispatcher-repair", capability: "dispatcher-repair", revision: "a".repeat(40), reason: "Concrete dispatcher repair" } });
  assert.deepEqual(store.snapshot().claims, []);
  const [task] = store.tasks.list(ticket);
  assert.equal(task.state, "queued");
  store.tasks.report("linux", { capabilities: ["dispatcher-repair"], ready: true });
  assert.equal(store.taskStart("linux", task.id, "helper").ok, true);
  assert.deepEqual(store.snapshot().claims.map(c => c.ticket), [`${project}#@task-${task.id}`], "only the task's own reservation");
  store.taskComplete("linux", task.id, "helper", { outcome: "failed", summary: "Nothing to publish", files: {} });
  assert.deepEqual(store.snapshot().claims, []);
  store.close();
});

test("refinement starts no ownership; the builder claims; a refiner on an owned ticket keeps it", () => {
  for (const planner of ["refiner", "po"]) {
    const store = new FleetStore(":memory:", limits);
    const refined = store.start(start("refine", planner, { locks: [`${project}:role:${planner}`] }));
    assert.equal(refined.ok, true);
    assert.deepEqual(store.snapshot().claims, []);
    assert.deepEqual(store.start(start("refine-2", planner, { machine: "linux" })), { ok: false, reason: "running" });
    assert.deepEqual(store.start(start("other", planner, { ticket: `${project}#2`, locks: [`${project}:role:${planner}`] })), { ok: false, reason: "locked" }, "its locks hold while it runs");
    store.recordCoordination("mac", "session", project, "refine", { ticket, blocker: `${project}#9`, paths: ["src/a.ts"], reason: "Shares a file with #9" });
    store.finish("mac", "session", "refine");
    assert.deepEqual(store.snapshot().claims, []);
    assert.equal(store.start(start("other", planner, { ticket: `${project}#2`, locks: [`${project}:role:${planner}`] })).ok, true, "locks are released");
    const first = planner === "po" ? "architect" : "builder";
    assert.equal(store.start(start("build", first, { machine: "linux" })).ok, true);
    assert.deepEqual(store.snapshot().claims.filter(c => c.ticket === ticket).map(c => c.machine), ["linux"]);
    store.finish("linux", "session", "build");
    const [owner] = store.snapshot().claims.filter(c => c.ticket === ticket);
    assert.deepEqual(store.start(start("refine-again", planner)), { ok: false, reason: "foreign-claim" });
    assert.deepEqual(store.start(start("refine-again", planner, { machine: "linux" })), { ok: true, generation: owner.generation });
    store.finish("linux", "session", "refine-again");
    assert.deepEqual(store.snapshot().claims.filter(c => c.ticket === ticket), [owner]);
    store.close();
  }
});

test("the operator can end an unowned assessment by its run generation", () => {
  const store = new FleetStore(":memory:", limits);
  store.recoveryReport("mac", project, [failing()]);
  const grant = store.start(start("assess", "recovery"));
  assert.equal(grant.ok, true);
  if (!grant.ok) return;
  assert.throws(() => store.free(ticket, grant.generation, false), /stopped/);
  assert.throws(() => store.free(ticket, "other-generation", true), /changed/);
  store.free(ticket, grant.generation, true);
  assert.deepEqual(store.snapshot().runs, []);
  assert.deepEqual(store.snapshot().claims, []);
  assert.throws(() => store.free(ticket, grant.generation, true), /changed/, "a repeated release finds nothing");
  assert.equal(store.start(start("builder", "builder", { machine: "linux" })).ok, true);
  store.close();
});

test("a refined ticket's builder counts against the claim budget like any new ticket", () => {
  const store = new FleetStore(":memory:", limits);
  store.start(start("refine", "refiner"));
  store.finish("mac", "session", "refine");
  store.start(start("owned", "builder", { ticket: `${project}#2` }));
  store.finish("mac", "session", "owned");
  const offer = (n: number): WorkOffer => ({ project, ticket: `${project}#${n}`, role: "builder", resource: "medium", key: `builder#${n}`, order: n, locks: [] });
  const selected = scheduleMachine({ machine: "mac", projects: [project], ticketLimit: 1, heavyLimit: 1, combinedLimit: 2,
    offers: [offer(1), offer(2)], state: store.snapshot() });
  assert.deepEqual(selected.map(o => o.ticket), [`${project}#2`], "the refiner did not reserve the refined ticket");
  store.close();
});
