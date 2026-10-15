import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FleetStore } from "./fleet-store.js";
import { RecoveryLedger, type RecoveryObservation } from "./fleet-recovery.js";
import { RecoveryTasks, type RecoveryTaskRequest } from "./recovery-tasks.js";
import { dispatcherRepairCap, repairFailureKind, REPAIR_CAP_REASON, REPAIR_CAP_WINDOW_MS } from "./recovery-repair-cap.js";
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
  assert.equal(repairFailureKind("Dispatcher repair did not complete: Implementation did not complete or permission was denied."), "implementation did not complete");
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

test("after two failed dispatcher repairs the next order escalates to a person and orders nothing (#3389, 2026-10-15)", () => {
  const store = new FleetStore(":memory:", limits);
  try {
    store.tasks.report("linux", { capabilities: ["dispatcher-repair"], ready: true });
    // Labels move a little each cycle, as they did overnight, so every incident has its own fingerprint.
    const seen = (n: number): RecoveryObservation => ({ ticket, status: "In Code Review", labels: ["error:verifier", `error-retry-count:${n}`], blocked: false });
    assert.equal(assess(store, seen(1), "a1", { action: "coordinate", reason: "Repair the gate", task: repair(1) }).selected.action, "coordinate");
    runTask(store, CHECKS);
    assert.equal(assess(store, seen(2), "a2", { action: "coordinate", reason: "Repair the gate again", task: repair(2) }).selected.action, "coordinate");
    runTask(store, REVIEW);
    const third = assess(store, seen(3), "a3", { action: "coordinate", reason: "Repair the gate a third time", task: repair(3) });
    assert.equal(third.selected.action, "escalate");
    assert.equal(third.selected.category, "human");
    assert.match(third.selected.reason, new RegExp(`^${REPAIR_CAP_REASON}: 2 failed dispatcher repairs for this ticket in the last 24 hours`));
    assert.match(third.selected.reason, /checks failed; 2\) task .* independent review failed/);
    assert.match(third.selected.reason, /Repair brief 3/);
    assert.equal(store.tasks.list(ticket).length, 2, "no third repair task");
    assert.equal(store.recovery.incident(third.incident.id).state, "escalated");
    assert.deepEqual(store.recovery.escalatedTickets(), [ticket], "the ticket carries orchestrator:escalated");
    const attention = recoveryReport(store.recovery.list(), {});
    const decision = attention.decisions.find(d => d.ticket === ticket)!;
    assert.equal(decision.kind, "decision-needed", "board watch reports decision-needed escalations");
    assert.equal((decision as any).repairCap, true);
    assert.match(decision.nextAction, /Two dispatcher repairs failed/);
    // Other recovery actions are not capped.
    assert.equal(assess(store, seen(4), "a4", { action: "rework", reason: "Builder repairs the test" }).selected.action, "rework");
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

test("the cap counts per ticket within 24 hours or per incident fingerprint, and a completed repair starts it again", () => {
  const db = new DatabaseSync(":memory:"); let now = 1_000_000_000;
  new RecoveryLedger(db, () => now);
  const tasks = new RecoveryTasks(db, () => now);
  const fail = (n: number, summary: string, context = `ctx-${n}`) => {
    const task = tasks.request(ticket, repair(n), context);
    db.prepare("UPDATE fleet_recovery_tasks SET state='failed',result=?,updated=? WHERE id=?").run(JSON.stringify({ outcome: "failed", summary, files: {} }), now, task.id);
    now += 60_000;
    return task;
  };
  fail(1, CHECKS); fail(2, INTERRUPTED);
  assert.equal(dispatcherRepairCap(db, ticket, null, now).capped, false, "an interrupted worker does not count");
  fail(3, REVIEW);
  assert.equal(dispatcherRepairCap(db, ticket, null, now).capped, true);
  // Older than the window, on different fingerprints: no longer counted.
  now += REPAIR_CAP_WINDOW_MS;
  assert.equal(dispatcherRepairCap(db, ticket, "fp-new", now).capped, false);
  // The same incident fingerprint ordered both failures: counted however old.
  db.prepare("INSERT INTO fleet_recovery VALUES ('i1',?, 'fp-same','error:verifier','waiting',1,1,'r',?,0)").run(ticket, JSON.stringify({ action: "coordinate", reason: "r", task: repair(4) }));
  db.prepare("INSERT INTO fleet_recovery VALUES ('i2',?, 'fp-same','error:verifier','waiting',1,1,'r',?,0)").run(ticket, JSON.stringify({ action: "coordinate", reason: "r", task: repair(5) }));
  fail(4, CHECKS, "i1"); fail(5, PUBLICATION, "i2");
  now += 2 * REPAIR_CAP_WINDOW_MS;
  const byFingerprint = dispatcherRepairCap(db, ticket, "fp-same", now);
  assert.equal(byFingerprint.capped, true);
  assert.match((byFingerprint as any).reason, /for this incident/);
  assert.equal(dispatcherRepairCap(db, ticket, "fp-other", now).capped, false);
  // A repair that completed resets the count.
  const done = tasks.request(ticket, repair(6), "ok");
  db.prepare("UPDATE fleet_recovery_tasks SET state='complete',result=?,updated=? WHERE id=?").run(JSON.stringify({ outcome: "completed", summary: "Merged", files: {} }), now, done.id);
  now += 60_000;
  assert.equal(dispatcherRepairCap(db, ticket, "fp-same", now).capped, false);
  fail(7, CHECKS);
  assert.equal(dispatcherRepairCap(db, ticket, "fp-same", now).capped, false, "one failure since the success");
  fail(8, REVIEW);
  assert.equal(dispatcherRepairCap(db, ticket, "fp-same", now).capped, true);
  assert.equal(dispatcherRepairCap(db, `${project}#1`, null, now).capped, false, "per ticket");
  db.close();
});
