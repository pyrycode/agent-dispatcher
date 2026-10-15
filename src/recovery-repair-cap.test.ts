import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FleetStore } from "./fleet-store.js";
import { RecoveryLedger, type RecoveryObservation } from "./fleet-recovery.js";
import { RecoveryTasks, type RecoveryTaskRequest } from "./recovery-tasks.js";
import { dispatcherRepairCap, recordRepairWorkflow, repairFailureKind, REPAIR_CAP_REASON, REPAIR_CAP_WINDOW_MS } from "./recovery-repair-cap.js";
import { recoveryReport } from "./recovery-report.js";

const project = "org/core";
const ticket = `${project}#3389`;
const limits = { mac: { heavyLimit: 1, combinedLimit: 2 }, linux: { heavyLimit: 1, combinedLimit: 2 } };
const repair = (n: number): RecoveryTaskRequest => ({ recipe: "dispatcher-repair", capability: "dispatcher-repair", revision: n.toString(16).repeat(40), reason: `Repair brief ${n}` });
const CHECKS = "Dispatcher repair did not complete: Check failed; private diagnostics: test.check.log. Private checkout and exact logs retained.";
const REVIEW = "Dispatcher repair did not complete: Independent review found an unresolved defect. Private checkout and exact logs retained.";
const PUBLICATION = "Repair publication refused: Repair contains credential-shaped text; retain it privately The repair finished, but it was not published.";
const INTERRUPTED = "Native task worker was interrupted before it wrote a result. Admitted into the Core container while the supervisor drained it.";

test("repair failures are classified from their summaries; an interrupted worker is not an attempt", () => {
  assert.equal(repairFailureKind(CHECKS), "checks failed");
  assert.equal(repairFailureKind(REVIEW), "independent review failed");
  assert.equal(repairFailureKind("Dispatcher repair did not complete: Independent review did not complete on the checked tree."), "independent review failed");
  assert.equal(repairFailureKind(PUBLICATION), "publication refused");
  assert.equal(repairFailureKind("Publication refused: credential-shaped text (claims service 409)."), "publication refused");
  // Also how a Codex rate limit or a runner error ends: not counted.
  assert.equal(repairFailureKind("Dispatcher repair did not complete: Implementation did not complete or permission was denied."), null);
  assert.equal(repairFailureKind("Dispatcher repair did not complete: git fetch failed."), null);
  assert.equal(repairFailureKind(INTERRUPTED), null);
});

/** One assessment cycle through the claim service, as the recovery worker drives it. */
function assess(store: FleetStore, observation: RecoveryObservation, run: string, decision: object) {
  const incident = store.recoveryReport("mac", project, [observation]).find(i => i.ticket === observation.ticket && i.state === "queued");
  assert.ok(incident, `${run}: an incident is queued`);
  store.start({ id: run, session: "s", machine: "mac", project, ticket: observation.ticket, role: "recovery", resource: "heavy", locks: [] });
  store.recoveryStep("mac", "s", project, incident.id, run, "begin");
  const selected = store.recoveryStep("mac", "s", project, incident.id, run, "decide", decision as any) as any;
  store.finish("mac", "s", run, true);
  return { incident, selected };
}
function runTask(store: FleetStore, summary: string, outcome: "failed" | "completed" = "failed") {
  const task = store.tasks.list(ticket).find(t => t.state === "queued")!;
  assert.equal(store.taskStart("linux", task.id, `helper-${task.id}`).ok, true);
  store.taskComplete("linux", task.id, `helper-${task.id}`, { outcome, summary, files: {} });
}

test("automatic repair proposals escalate immediately while ordinary product rework remains available", () => {
  const store = new FleetStore(":memory:", limits);
  try {
    const seen = (n: number): RecoveryObservation => ({ ticket, status: "In Code Review", labels: ["error:verifier", `error-retry-count:${n}`], blocked: false });
    const first = assess(store, seen(1), "a1", { action: "coordinate", reason: "Repair the gate", task: repair(1) });
    assert.equal(first.selected.action, "escalate");
    assert.equal(first.selected.category, "human");
    assert.match(first.selected.reason, /Automatic dispatcher repair is disabled/);
    assert.equal(store.tasks.list(ticket).length, 0);
    assert.equal(assess(store, seen(2), "a2", { action: "rework", reason: "Builder repairs the product" }).selected.action, "rework");
  } finally { store.close(); }
});

test("a repair worker's direct request is refused at the cap; repeating an existing request still returns it", () => {
  const store = new FleetStore(":memory:", limits);
  try {
    store.tasks.report("linux", { capabilities: ["dispatcher-repair"], ready: true });
    store.start({ id: "builder", session: "s", machine: "mac", project, ticket, role: "builder", resource: "heavy", locks: [] });
    const first = store.requestTask("mac", "s", project, "builder", repair(1));
    runTask(store, CHECKS);
    store.requestTask("mac", "s", project, "builder", repair(2));
    runTask(store, PUBLICATION);
    assert.throws(() => store.requestTask("mac", "s", project, "builder", repair(3)), new RegExp(REPAIR_CAP_REASON));
    assert.equal(store.requestTask("mac", "s", project, "builder", repair(1)).id, first.id);
    // Other recipes are not capped.
    assert.equal(store.requestTask("mac", "s", project, "builder", { recipe: "platform-probe", capability: "linux-amd64", reason: "probe" }).state, "queued");
  } finally { store.close(); }
});

test("the 24 hour window, the workflow fingerprint and a completed repair's reset", () => {
  const db = new DatabaseSync(":memory:"); let now = 1_000_000_000;
  new RecoveryLedger(db, () => now);
  const tasks = new RecoveryTasks(db, () => now);
  const fail = (n: number, summary: string, workflow: string | null = null) => {
    const task = tasks.request(ticket, repair(n), `ctx-${n}`);
    recordRepairWorkflow(db, task.id, ticket, workflow);
    db.prepare("UPDATE fleet_recovery_tasks SET state='failed',result=?,updated=? WHERE id=?").run(JSON.stringify({ outcome: "failed", summary, files: {} }), now, task.id);
    now += 60_000;
    return task;
  };
  fail(1, CHECKS); fail(2, INTERRUPTED);
  assert.equal(dispatcherRepairCap(db, ticket, null, now).capped, false, "an interrupted worker does not count");
  fail(3, REVIEW);
  assert.equal(dispatcherRepairCap(db, ticket, null, now).capped, true);
  now += REPAIR_CAP_WINDOW_MS;
  assert.equal(dispatcherRepairCap(db, ticket, "wf-new", now).capped, false, "older than the window, other workflow");
  fail(4, CHECKS, "wf-same"); now += 2 * REPAIR_CAP_WINDOW_MS; fail(5, PUBLICATION, "wf-same");
  assert.equal(dispatcherRepairCap(db, ticket, "wf-same", now + 2 * REPAIR_CAP_WINDOW_MS).capped, true);
  assert.equal(dispatcherRepairCap(db, ticket, "wf-other", now + 2 * REPAIR_CAP_WINDOW_MS).capped, false);
  const done = tasks.request(ticket, repair(6), "ok");
  db.prepare("UPDATE fleet_recovery_tasks SET state='complete',result=?,updated=? WHERE id=?").run(JSON.stringify({ outcome: "completed", summary: "Merged", files: {} }), now, done.id);
  now += 60_000;
  assert.equal(dispatcherRepairCap(db, ticket, "wf-same", now).capped, false, "a completed repair resets");
  fail(7, CHECKS, "wf-same");
  assert.equal(dispatcherRepairCap(db, ticket, "wf-same", now).capped, false, "one failure since the success");
  fail(8, REVIEW, "wf-same");
  assert.equal(dispatcherRepairCap(db, ticket, "wf-same", now).capped, true);
  assert.equal(dispatcherRepairCap(db, `${project}#1`, null, now).capped, false, "per ticket");
  db.close();
});

test("a repair queued before this version, on a ticket already at the cap, does not start", () => {
  const db = new DatabaseSync(":memory:"); const now = 1_000_000_000;
  new RecoveryLedger(db, () => now);
  const tasks = new RecoveryTasks(db, () => now);
  for (const [n, summary] of [[1, CHECKS], [2, REVIEW]] as const) {
    const t = tasks.request(ticket, repair(n), `ctx-${n}`);
    db.prepare("UPDATE fleet_recovery_tasks SET state='failed',result=?,updated=? WHERE id=?").run(JSON.stringify({ outcome: "failed", summary, files: {} }), now, t.id);
  }
  const queued = tasks.request(ticket, repair(3), "ctx-3");
  tasks.report("linux", { capabilities: ["dispatcher-repair"], ready: true });
  assert.equal(tasks.available("linux", queued.id), false);
  const other = tasks.request(`${project}#1`, repair(3), "ctx");
  assert.equal(tasks.available("linux", other.id), true, "another ticket is unaffected");
  db.close();
});

test("a person can still order a repair after the cap, and a withdrawn repair is not new evidence", () => {
  const db = new DatabaseSync(":memory:"); let now = 1_000_000_000;
  new RecoveryLedger(db, () => now);
  const tasks = new RecoveryTasks(db, () => now);
  tasks.report("linux", { capabilities: ["dispatcher-repair"], ready: true });
  const queuedBehind = tasks.request(ticket, repair(9), "queued-behind");
  for (const [n, summary] of [[1, CHECKS], [2, REVIEW]] as const) {
    now += 60_000;
    const t = tasks.request(ticket, repair(n), `ctx-${n}`);
    db.prepare("UPDATE fleet_recovery_tasks SET state='running',machine='linux',session='s',run_id='r' WHERE id=?").run(t.id);
    tasks.complete(t.id, "linux", "s", { outcome: "failed", summary, files: {} });
  }
  assert.equal(tasks.get(queuedBehind.id).state, "failed", "withdrawn at the cap");
  const revision = tasks.revision(ticket);
  db.prepare("UPDATE fleet_recovery_tasks SET state='queued' WHERE id=?").run(queuedBehind.id);
  assert.equal(tasks.revision(ticket), revision, "the withdrawn task does not move the evidence revision");
  db.prepare("UPDATE fleet_recovery_tasks SET state='failed' WHERE id=?").run(queuedBehind.id);
  now += 60_000;
  tasks.report("linux", { capabilities: ["dispatcher-repair"], ready: true });
  const operator = tasks.request(ticket, repair(3), "");
  assert.equal(dispatcherRepairCap(db, ticket, null, now).capped, true);
  assert.equal(tasks.available("linux", operator.id), true, "an operator's later request may start");
  // An assessment's order queued after the failures, as 51d9c8b9 on #3389 was, is still held.
  const automatic = tasks.request(ticket, repair(4), "incident-after-the-failures");
  assert.equal(tasks.available("linux", automatic.id), false);
  db.close();
});
