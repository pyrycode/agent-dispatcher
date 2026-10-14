import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RecoveryLedger, RECOVERY_REASSESS_BASE_MS, RECOVERY_REASSESS_CEILING_MS, validateReassessSpacing, type RecoveryObservation, type RecoveryDecision } from "./fleet-recovery.js";
import { RecoveryTasks } from "./recovery-tasks.js";

// Shapes from 2026-10-14. pyrycode#3268 sat in Inbox waiting for a human
// product decision and was escalated to a person five times between 09:10 and
// 15:05, about every 50 minutes: each escalation posted a recovery comment,
// the comment pushed an older comment out of the latest-eight read, the
// evidence revision moved, and the thirty-minute evidence cooldown let the
// next assessment through. pyrycode-mobile#2151 was assessed seven times
// between 08:00 and 17:51, each time coordinating another dispatcher repair
// that failed.
const core = "pyrycode/pyrycode", mobile = "pyrycode/pyrycode-mobile";
const empty = { claims: [], runs: [] };
const MIN = 60_000, HOUR = 60 * MIN, POLL = 5 * MIN;
const hex = (n: number) => n.toString(16).padStart(64, "0");

function setup(options = {}) {
  const db = new DatabaseSync(":memory:");
  const clock = { now: 1791939108464 };
  const ledger = new RecoveryLedger(db, () => clock.now, options);
  const tasks = new RecoveryTasks(db, () => clock.now);
  return { db, clock, ledger, tasks };
}
const inbox3268 = (evidence: number, labels: string[] = []): RecoveryObservation => ({ ticket: `${core}#3268`, status: "Inbox",
  labels: ["security-sensitive", "needs-human:sizing", "rework-other:1", "orchestrator:returned-inbox", ...labels], blocked: false,
  evidenceRevision: hex(evidence), assessmentPolicy: 1 });

/** Assess every queued incident for the ticket the way a worker would, with a fixed decision. */
function assessQueued(ledger: RecoveryLedger, project: string, o: RecoveryObservation, decision: RecoveryDecision, run: string) {
  const queued = ledger.report("hp", project, [o], empty).filter(i => i.state === "queued");
  for (const incident of queued) {
    ledger.begin(incident.id, run);
    ledger.decide(incident.id, run, decision);
    ledger.complete(incident.id, run);
  }
  return queued.length;
}

/** Poll every five minutes; every decision moves the evidence revision, the worst case the ledger can see. */
function churn(ledger: RecoveryLedger, clock: { now: number }, decision: RecoveryDecision, hours: number) {
  let runs = 0;
  const times: number[] = [];
  const start = clock.now;
  for (let t = 0; t < hours * HOUR; t += POLL) {
    const n = assessQueued(ledger, core, inbox3268(runs), decision, `r${runs}`);
    if (n) { runs += n; times.push(clock.now - start); }
    clock.now += POLL;
  }
  return { runs, gaps: times.slice(1).map((t, i) => t - times[i]) };
}

test("a wait whose only change is evidence churn is reassessed on a doubling interval", () => {
  const { db, clock, ledger } = setup();
  const { runs, gaps } = churn(ledger, clock, { action: "wait", reason: "Planning inputs are still missing" }, 9);
  // 30 minutes, then 1, 2 and 4 hours: never sooner than the doubling interval.
  for (const [i, gap] of gaps.entries()) assert.ok(gap >= Math.min(RECOVERY_REASSESS_CEILING_MS, RECOVERY_REASSESS_BASE_MS * 2 ** i), `repeat ${i + 1} came after ${gap / MIN} minutes`);
  assert.ok(runs <= 5, `${runs} assessments in nine hours; the 30-minute cooldown alone allowed about 15`);
  const current = ledger.list(core).find(i => i.current)!;
  assert.equal(current.cadence?.quietRepeats, runs - 1);
  assert.equal(current.cadence?.nextQuietReassessAt, current.updated + ledger.quietInterval(runs - 1));
  db.close();
});

test("#3268 shape: a person's escalation keeps the flat thirty minutes, so a reply by comment is read promptly", () => {
  // On 2026-10-14 the churn itself came from the comment read, which
  // evidence-revision.test.ts covers. Here the ledger must not slow a reply.
  const { db, clock, ledger } = setup();
  const { gaps } = churn(ledger, clock, { action: "escalate", category: "human", reason: "A write-authority product decision is missing" }, 4);
  assert.ok(gaps.length >= 3);
  for (const gap of gaps) assert.ok(gap >= RECOVERY_REASSESS_BASE_MS && gap <= RECOVERY_REASSESS_BASE_MS + POLL, `${gap / MIN} minutes`);
  const current = ledger.list(core).find(i => i.current)!;
  assert.equal(current.state, "escalated");
  assert.equal(current.cadence?.nextQuietReassessAt, current.updated + RECOVERY_REASSESS_BASE_MS);
  db.close();
});

test("a code deadline is kept even when evidence moved meanwhile, and does not reset the count", () => {
  const { db, clock, ledger } = setup();
  const wait: RecoveryDecision = { action: "wait", reason: "x" };
  assessQueued(ledger, core, inbox3268(0), wait, "r0");
  for (let i = 1; i <= 2; i++) { clock.now += ledger.quietInterval(i - 1); assert.equal(assessQueued(ledger, core, inbox3268(i), wait, `r${i}`), 1); }
  // A transient transport failure: an operational escalation with the code cooldown.
  clock.now += ledger.quietInterval(2);
  const [incident] = ledger.report("hp", core, [inbox3268(3)], empty);
  ledger.begin(incident.id, "r3");
  ledger.decide(incident.id, "r3", { action: "escalate", category: "operational", reason: "GitHub transport failed", cooldown: true });
  // Evidence moves inside the cooldown. At the 30-minute deadline it is assessed, not held for the 4-hour step.
  clock.now += 10 * MIN;
  assert.equal(ledger.report("hp", core, [inbox3268(4)], empty).filter(i => i.state === "queued").length, 0);
  clock.now += 20 * MIN;
  const reopened = ledger.report("hp", core, [inbox3268(4)], empty).filter(i => i.state === "queued");
  assert.equal(reopened.length, 1);
  ledger.begin(reopened[0].id, "r4");
  ledger.decide(reopened[0].id, "r4", wait);
  assert.equal(ledger.list(core).find(i => i.current)?.cadence?.quietRepeats, 3, "the timer kept the count of three quiet repeats");
  db.close();
});

test("a new error, a stage move or a manual hold is never held by the quiet interval, and resets it", () => {
  const { db, clock, ledger } = setup();
  const escalate: RecoveryDecision = { action: "escalate", category: "human", reason: "Needs a product decision" };
  assessQueued(ledger, core, inbox3268(1), escalate, "r1");
  for (let i = 2; i <= 4; i++) {
    clock.now += ledger.quietInterval(i - 2);
    assert.equal(assessQueued(ledger, core, inbox3268(i), escalate, `r${i}`), 1);
  }
  assert.equal(ledger.list(core).find(i => i.current)?.cadence?.quietRepeats, 3);
  // A quiet change one minute later waits for the next interval.
  clock.now += MIN;
  assert.equal(assessQueued(ledger, core, inbox3268(5), escalate, "r5"), 0);
  // A new stage error is a workflow change: assessed at once.
  const errored: RecoveryObservation = { ...inbox3268(5), status: "In Development", labels: ["error:builder"] };
  assert.equal(assessQueued(ledger, core, errored, { action: "wait", reason: "Builder retry pending" }, "r6"), 1);
  const current = ledger.list(core).find(i => i.current)!;
  assert.equal(current.cadence?.quietRepeats, 0, "a workflow change starts the count again");
  // Back to quiet changes: the first repeat waits only the base interval.
  clock.now += RECOVERY_REASSESS_BASE_MS - MIN;
  assert.equal(assessQueued(ledger, core, { ...errored, evidenceRevision: hex(6) }, { action: "wait", reason: "x" }, "r7"), 0);
  clock.now += MIN;
  assert.equal(assessQueued(ledger, core, { ...errored, evidenceRevision: hex(6) }, { action: "wait", reason: "x" }, "r7"), 1);
  // A person's hold surfaces at once, whatever the interval says.
  clock.now += MIN;
  const [hold] = ledger.report("hp", core, [{ ...errored, evidenceRevision: hex(7), labels: ["error:builder", "needs-human:decision"] }], empty);
  assert.equal(hold?.state, "escalated");
  assert.equal(hold?.reason, "Explicit operator hold");
  db.close();
});

test("#2151 shape: a coordinate loop of failing repairs is reassessed less and less often", () => {
  const { db, clock, ledger, tasks } = setup();
  const ticket = `${mobile}#2151`;
  const blocked: RecoveryObservation = { ticket, status: "Backlog", labels: [], blocked: true, evidenceRevision: hex(1), assessmentPolicy: 1 };
  const assessments: number[] = [];
  const start = clock.now;
  let artifact = 0;
  // Every assessment coordinates a dispatcher repair; every repair fails 35
  // minutes later. Each failure is a real change, a task result, so this is
  // not suppressed, only spaced.
  for (let t = 0; t < 10 * HOUR; t += POLL) {
    const o = { ...blocked, ...(artifact ? { artifactRevision: hex(100 + artifact) } : {}) };
    for (const incident of ledger.report("hp", mobile, [o], empty).filter(i => i.state === "queued")) {
      ledger.begin(incident.id, `run-${assessments.length}`);
      ledger.decide(incident.id, `run-${assessments.length}`, { action: "coordinate", reason: "Repair the dispatcher",
        task: { recipe: "dispatcher-repair", capability: "dispatcher-repair", revision: "a".repeat(40), reason: "Fix the reported defect" } });
      tasks.request(ticket, { recipe: "dispatcher-repair", capability: "dispatcher-repair", revision: "a".repeat(40), reason: `Fix the reported defect ${assessments.length}` }, incident.id);
      assessments.push(clock.now - start);
    }
    for (const task of tasks.list(ticket).filter(x => x.state === "queued" && clock.now - x.created >= 35 * MIN)) {
      db.prepare("UPDATE fleet_recovery_tasks SET state='failed',updated=?,result=? WHERE id=?").run(clock.now, JSON.stringify({ outcome: "failed", summary: "Repair did not pass review", files: {} }), task.id);
      artifact++;
    }
    clock.now += POLL;
  }
  const gaps = assessments.slice(1).map((t, i) => t - assessments[i]);
  // The first failed repair is read at the first poll after it lands, 35 minutes in.
  assert.equal(gaps[0], 40 * MIN);
  // Repeats then wait 30 minutes, 1, 2 and 4 hours after the last decision.
  for (const [i, gap] of gaps.slice(1).entries()) assert.ok(gap >= Math.min(RECOVERY_REASSESS_CEILING_MS, RECOVERY_REASSESS_BASE_MS * 2 ** i), `repeat ${i + 2} after ${gap / MIN} minutes`);
  assert.ok(assessments.length <= 6, `${assessments.length} assessments in ten hours, against seven on 2026-10-14 and about fifteen at one per repair`);
  db.close();
});

test("quiet repeat spacing is configurable and validated", () => {
  const { db, ledger } = setup({ reassessBaseMs: 10 * MIN, reassessCeilingMs: HOUR });
  assert.deepEqual([0, 1, 2, 3, 10].map(n => ledger.quietInterval(n) / MIN), [10, 20, 40, 60, 60]);
  assert.throws(() => validateReassessSpacing(MIN, HOUR), /between five minutes and one day/);
  assert.throws(() => validateReassessSpacing(HOUR, 10 * MIN), /between the base and seven days/);
  assert.throws(() => new RecoveryLedger(new DatabaseSync(":memory:"), Date.now, { reassessCeilingMs: 8 * 24 * HOUR }), /seven days/);
  db.close();
});
