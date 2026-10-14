import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RecoveryLedger, RECOVERY_RECHECK_MS, RECOVERY_SAFETY_RECHECK_MS, validateRecoveryDecision, type RecoveryObservation } from "./fleet-recovery.js";
import { RecoveryTasks } from "./recovery-tasks.js";
import { RecoveryFacts } from "./recovery-facts.js";
import { FleetStore } from "./fleet-store.js";
import { recoveryReport } from "./recovery-report.js";

// Shapes of the 2026-10-14 overnight loop: both tickets were reassessed about
// every 35 minutes from 02:17 with nothing changed between runs.
const relay = "pyrycode/pyrycode-relay", mobile = "pyrycode/pyrycode-mobile";
const relay170: RecoveryObservation = { ticket: `${relay}#170`, status: "Inbox", labels: ["done:refiner"], blocked: false,
  evidenceRevision: "1".repeat(64), artifactRevision: "2".repeat(64) };
const mobile2152: RecoveryObservation = { ticket: `${mobile}#2152`, status: "Inbox", labels: ["done:refiner"], blocked: false,
  evidenceRevision: "3".repeat(64), artifactRevision: "4".repeat(64) };
const empty = { claims: [], runs: [] };
const FIVE_MINUTES = 5 * 60_000;

function setup(options = {}) {
  const db = new DatabaseSync(":memory:");
  const clock = { now: 1791939108464 };
  const ledger = new RecoveryLedger(db, () => clock.now, options);
  const tasks = new RecoveryTasks(db, () => clock.now);
  const facts = new RecoveryFacts(db);
  return { db, clock, ledger, tasks, facts };
}
function assessWait(ledger: RecoveryLedger, project: string, o: RecoveryObservation, run: string, decision: Parameters<RecoveryLedger["decide"]>[2]) {
  const [incident] = ledger.report("hp", project, [o], empty);
  assert.equal(incident?.state, "queued", "the first observation queues one assessment");
  ledger.begin(incident.id, run);
  ledger.decide(incident.id, run, decision);
  ledger.complete(incident.id, run);
  return incident;
}
/** Poll every five minutes, as the dispatcher's recovery cycle does. Returns the queued incidents seen. */
function poll(ledger: RecoveryLedger, clock: { now: number }, project: string, o: RecoveryObservation, durationMs: number) {
  const queued: string[] = [];
  for (let elapsed = 0; elapsed < durationMs; elapsed += FIVE_MINUTES) {
    clock.now += FIVE_MINUTES;
    for (const i of ledger.report("hp", project, [o], empty)) if (i.state === "queued") queued.push(i.id);
  }
  return queued;
}

test("#170 shape: an unchanged wait for planning inputs is not reassessed overnight", () => {
  const { db, clock, ledger } = setup();
  const first = assessWait(ledger, relay, relay170, "r1", { action: "wait", reason: "Keep #170 in Inbox pending its recorded planning inputs: a metrics collection route and probe scope." });
  assert.deepEqual(poll(ledger, clock, relay, relay170, 8 * 3600_000), [], "fourteen extra assessments overnight was the bug");
  const current = ledger.list(relay).filter(i => i.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].id, first.id);
  // The settled basis is auditable: the exact fingerprint and safety deadline are recorded.
  assert.equal(current[0].settlement?.basis.fingerprint, first.fingerprint);
  assert.equal(current[0].settlement?.recheckAt, current[0].settlement!.created + RECOVERY_SAFETY_RECHECK_MS);
  assert.equal(current[0].settlement?.reopened, null);
  assert.ok(/^[a-f0-9]{64}$/.test(current[0].settlement!.digest));
  db.close();
});

test("#170 shape: a human comment reopens the settled wait at once", () => {
  const { db, clock, ledger } = setup();
  const first = assessWait(ledger, relay, relay170, "r1", { action: "wait", reason: "Pending planning inputs" });
  assert.deepEqual(poll(ledger, clock, relay, relay170, 3 * 3600_000), []);
  const commented = { ...relay170, evidenceRevision: "5".repeat(64) };
  const [next] = ledger.report("hp", relay, [commented], empty);
  assert.equal(next?.state, "queued", "Juhana's answer reaches assessment on the next poll");
  assert.notEqual(next.id, first.id);
  assert.equal(ledger.settlement(first.id)?.reopened, "ticket changed");
  db.close();
});

test("#170 shape: label, stage, blocker and new run results reopen the settled wait", () => {
  for (const [change, changed] of [
    ["label", { ...relay170, labels: [...relay170.labels, "rework-count:2"] }],
    ["stage", { ...relay170, status: "In Development", labels: ["error:builder"] }],
    ["new run result", { ...relay170, artifactRevision: "6".repeat(64) }],
    ["blocker", { ...relay170, blocked: true }],
  ] as const) {
    const { db, clock, ledger } = setup();
    assessWait(ledger, relay, relay170, "r1", { action: "wait", reason: "Pending planning inputs" });
    assert.deepEqual(poll(ledger, clock, relay, relay170, 2 * 3600_000), []);
    const [next] = ledger.report("hp", relay, [changed as RecoveryObservation], empty);
    assert.equal(next?.state, "queued", `${change} must reopen`);
    db.close();
  }
});

test("#2152 shape: waiting on a dispatcher repair named only in prose reopens when that task finishes", () => {
  const { db, clock, ledger, tasks } = setup();
  const repair = tasks.request(`${mobile}#2151`, { recipe: "dispatcher-repair", capability: "dispatcher-repair",
    revision: "18e65d4fe5175b706f7a0008e1bf47a88cd3aa5f", reason: "Redact JVM option echoes" }, "incident");
  const first = assessWait(ledger, mobile, mobile2152, "r1", { action: "wait",
    reason: `Await queued #2151 dispatcher repair ${repair.id} on ready Pyrybox. It supersedes ${"b".repeat(64)}, which failed review.` });
  const settled = ledger.settlement(first.id)!;
  assert.deepEqual(settled.basis.tasks, { [repair.id]: "pending" }, "only the real task id is tracked, not other 64-hex digests");
  assert.deepEqual(poll(ledger, clock, mobile, mobile2152, 6 * 3600_000), []);
  db.prepare("UPDATE fleet_recovery_tasks SET state='running' WHERE id=?").run(repair.id);
  assert.deepEqual(poll(ledger, clock, mobile, mobile2152, 3600_000), [], "the repair starting to run is not a reason to reassess");
  db.prepare("UPDATE fleet_recovery_tasks SET state='complete' WHERE id=?").run(repair.id);
  clock.now += FIVE_MINUTES;
  const [next] = ledger.report("hp", mobile, [mobile2152], empty);
  assert.equal(next?.state, "queued", "the finished dependency reopens assessment");
  assert.notEqual(next.id, first.id);
  assert.equal(ledger.settlement(first.id)?.reopened, `dependency task ${repair.id} complete`);
  assert.equal(ledger.report("hp", mobile, [mobile2152], empty)[0].id, next.id, "exactly one fresh assessment is queued");
  db.close();
});

test("#2152 shape: a structured waitFor ticket reopens when that ticket changes stage or leaves the board", () => {
  for (const finish of ["stage", "closed"] as const) {
    const { db, clock, ledger } = setup();
    const blocker: RecoveryObservation = { ticket: `${mobile}#2151`, status: "In Development", labels: [], blocked: false };
    ledger.report("hp", mobile, [blocker, mobile2152], { claims: [{ ticket: blocker.ticket, machine: "fractal", generation: "g", created: 1 }], runs: [] });
    const [incident] = ledger.report("hp", mobile, [blocker, mobile2152], empty).filter(i => i.ticket === mobile2152.ticket);
    ledger.begin(incident.id, "r1");
    ledger.decide(incident.id, "r1", { action: "wait", reason: "Await the sibling repair", waitFor: { tickets: [blocker.ticket] } });
    // The sibling keeps working and gaining comments: no stage change, no reassessment.
    for (let i = 0; i < 24; i++) {
      clock.now += FIVE_MINUTES;
      const queued = ledger.report("hp", mobile, [{ ...blocker, evidenceRevision: String(i % 10).repeat(64) }, mobile2152], empty)
        .filter(x => x.ticket === mobile2152.ticket && x.state === "queued");
      assert.deepEqual(queued, []);
    }
    clock.now += FIVE_MINUTES;
    const after = finish === "stage" ? [{ ...blocker, status: "Done" }, mobile2152] : [mobile2152];
    const [next] = ledger.report("hp", mobile, after, empty).filter(x => x.ticket === mobile2152.ticket);
    assert.equal(next?.state, "queued", `dependency ${finish} must reopen`);
    assert.match(ledger.settlement(incident.id)!.reopened!, new RegExp(`dependency ticket ${blocker.ticket} ${finish === "stage" ? "Done" : "absent"}`));
    db.close();
  }
});

test("an operator coordination command reopens a settled wait", () => {
  const { db, clock, ledger, facts } = setup();
  const first = assessWait(ledger, relay, relay170, "r1", { action: "wait", reason: "Pending planning inputs" });
  assert.deepEqual(poll(ledger, clock, relay, relay170, 3600_000), []);
  facts.coordinate({ ticket: relay170.ticket, blocker: `${relay}#198`, paths: ["src/metrics.go"], reason: "Operator records the probe scope owner" });
  clock.now += FIVE_MINUTES;
  assert.equal(ledger.report("hp", relay, [relay170], empty)[0]?.state, "queued");
  assert.equal(ledger.settlement(first.id)?.reopened, "coordination record changed");
  db.close();
});

test("the safety interval reopens an unchanged wait, and is configurable", () => {
  for (const safety of [undefined, 6 * 3600_000]) {
    const { db, clock, ledger } = setup(safety ? { safetyRecheckMs: safety } : {});
    const first = assessWait(ledger, mobile, mobile2152, "r1", { action: "wait", reason: "Await the repair" });
    const interval = safety ?? RECOVERY_SAFETY_RECHECK_MS;
    clock.now += interval - 1;
    assert.deepEqual(ledger.report("hp", mobile, [mobile2152], empty), []);
    clock.now += 1;
    const [next] = ledger.report("hp", mobile, [mobile2152], empty);
    assert.equal(next?.state, "queued");
    assert.equal(ledger.settlement(first.id)?.reopened, "safety interval");
    db.close();
  }
  assert.throws(() => new RecoveryLedger(new DatabaseSync(":memory:"), Date.now, { safetyRecheckMs: 60_000 }), /between one hour and thirty days/);
});

test("waits settled before this policy are compared against current state, not re-run on deploy", () => {
  const { db, clock, ledger, tasks } = setup();
  const repair = tasks.request(`${mobile}#2151`, { recipe: "dispatcher-repair", capability: "dispatcher-repair", revision: "a".repeat(40), reason: "Repair" }, "x");
  const [incident] = ledger.report("hp", mobile, [mobile2152], empty);
  ledger.begin(incident.id, "r1");
  ledger.decide(incident.id, "r1", { action: "wait", reason: `Await ${repair.id}` });
  // Simulate an incident decided by the previous controller: no settlement row.
  db.prepare("DELETE FROM fleet_recovery_settlement").run();
  clock.now += 2 * 3600_000;
  assert.deepEqual(ledger.report("hp", mobile, [mobile2152], empty), [], "the deploy itself does not trigger an assessment");
  assert.deepEqual(ledger.settlement(incident.id)?.basis.tasks, { [repair.id]: "pending" });
  db.prepare("UPDATE fleet_recovery_tasks SET state='failed' WHERE id=?").run(repair.id);
  assert.equal(ledger.report("hp", mobile, [mobile2152], empty)[0]?.state, "queued");
  db.close();
});

test("operational escalations wait for a change instead of a thirty-minute timer; code cooldowns keep theirs", () => {
  const { db, clock, ledger } = setup();
  db.prepare("CREATE TABLE IF NOT EXISTS fleet_capabilities (machine TEXT PRIMARY KEY,record TEXT NOT NULL,updated INTEGER NOT NULL) STRICT").run();
  db.prepare("INSERT INTO fleet_capabilities VALUES ('hp',?,1)").run(JSON.stringify({ capabilities: ["android-emulator"], ready: false }));
  const [incident] = ledger.report("hp", mobile, [mobile2152], empty);
  ledger.begin(incident.id, "r1");
  ledger.decide(incident.id, "r1", { action: "escalate", category: "operational", reason: "No ready Android emulator" });
  assert.deepEqual(poll(ledger, clock, mobile, mobile2152, 4 * 3600_000), [], "an assessment cannot request the short cooldown by itself");
  db.prepare("UPDATE fleet_capabilities SET record=? WHERE machine='hp'").run(JSON.stringify({ capabilities: ["android-emulator"], ready: true }));
  assert.equal(ledger.report("hp", mobile, [mobile2152], empty)[0]?.state, "queued");
  assert.equal(ledger.settlement(incident.id)?.reopened, "capability android-emulator ready");
  // Transient transport failures are marked by code and keep the bounded cooldown.
  const second = ledger.list(mobile).find(i => i.current)!;
  ledger.begin(second.id, "r2");
  const decided = ledger.decide(second.id, "r2", { action: "escalate", category: "operational", cooldown: true, reason: "Temporary GitHub transport failure" });
  assert.equal(decided.cooldown, undefined);
  assert.equal(decided.recheckAt, clock.now + RECOVERY_RECHECK_MS);
  clock.now += RECOVERY_RECHECK_MS;
  assert.equal(ledger.report("hp", mobile, [mobile2152], empty)[0]?.state, "queued");
  assert.equal(ledger.settlement(second.id)?.reopened, "code deadline");
  db.close();
});

test("decision validation keeps only well-formed reopening hints and never an assessment cooldown on a wait", () => {
  assert.deepEqual(validateRecoveryDecision({ action: "wait", reason: "r", cooldown: true,
    waitFor: { tasks: ["f".repeat(64), "short", 7], tickets: [`${mobile}#2151`, "#2151", `${mobile}#2151`] } }),
  { action: "wait", reason: "r", waitFor: { tasks: ["f".repeat(64)], tickets: [`${mobile}#2151`] } });
  assert.deepEqual(validateRecoveryDecision({ action: "rework", reason: "r", waitFor: { tasks: ["f".repeat(64)] } }), { action: "rework", reason: "r" });
});

test("FleetStore wires the configured safety interval and reports the settlement", () => {
  const store = new FleetStore(":memory:", { hp: { heavyLimit: 1, combinedLimit: 2 } }, { safetyRecheckMs: 12 * 3600_000 });
  const [incident] = store.recoveryReport("hp", relay, [relay170]);
  store.start({ id: "run-1", session: "s", machine: "hp", project: relay, ticket: relay170.ticket, role: "recovery", resource: "heavy", locks: [] });
  store.recoveryStep("hp", "s", relay, incident.id, "run-1", "begin");
  store.recoveryStep("hp", "s", relay, incident.id, "run-1", "decide", { action: "wait", reason: "Pending planning inputs" });
  store.recoveryStep("hp", "s", relay, incident.id, "run-1", "complete");
  store.finish("hp", "s", "run-1");
  const listed = store.recovery.list(relay).find(i => i.id === incident.id)!;
  assert.equal(listed.settlement!.recheckAt - listed.settlement!.created, 12 * 3600_000);
  assert.deepEqual(store.recoveryReport("hp", relay, [relay170]), []);
  assert.deepEqual(recoveryReport(store.recovery.list(), {}).decisions, [], "a settled wait is not an operator decision");
  store.close();
});
