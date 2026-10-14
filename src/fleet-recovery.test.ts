import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RecoveryLedger, recoveryFingerprint, recoveryTrigger, RECOVERY_RECHECK_MS, RECOVERY_SAFETY_RECHECK_MS, RECOVERY_STALLED_RUN_MS, type RecoveryObservation, type RecoveryIncident } from "./fleet-recovery.js";
import { FleetStore, type StartRequest } from "./fleet-store.js";
import { FleetClient, JsonClient, serveFleet } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { ManagedDispatch } from "./managed-dispatch.js";
import { runRecoveryWork, recoveryPlan, parseRecoveryDecision, recoveryHandoff, observationFor, cleanRecoveryLabels } from "./recovery-work.js";
import type { AgentConfig, ProjectItem } from "./types.js";
import { recoveryLogContext } from "./recovery-context.js";

const project = "org/core";
const limits = { mac: { heavyLimit: 1, combinedLimit: 2 }, linux: { heavyLimit: 1, combinedLimit: 2 } };
const observation = (n = 1, labels = ["error:builder"]): RecoveryObservation => ({ ticket: `${project}#${n}`, status: "In Development", labels, blocked: false });
const request = (n = 1, extra: Partial<StartRequest> = {}): StartRequest => ({ id: `run-${n}`, session: "session", machine: "mac", project, ticket: `${project}#${n}`, role: "recovery", resource: "heavy", locks: [], ...extra });

test("quiet Inbox intake can be assessed without treating holds or errors as idle", () => {
  const store = new FleetStore(":memory:", limits);
  const inbox = { ...observation(1, []), status: "Inbox" };
  assert.equal(store.recoveryReport("mac", project, [inbox])[0]?.state, "queued");
  assert.deepEqual(store.snapshot().idleRecoveryTickets, [inbox.ticket]);
  store.recoveryReport("mac", project, [{ ...inbox, labels: ["error:refiner"] }]);
  assert.equal(store.snapshot().idleRecoveryTickets, undefined);
  assert.equal(store.recoveryReport("mac", project, [{ ...inbox, labels: ["needs-human:decision"] }])[0]?.state, "escalated");
  assert.equal(store.snapshot().idleRecoveryTickets, undefined);
  store.close();
});

test("an unchanged idle Inbox wait does not repeat on the ordinary retry timer", () => {
  const db = new DatabaseSync(":memory:"); let now = 100000000;
  const ledger = new RecoveryLedger(db, () => now);
  const inbox = { ...observation(1, []), status: "Inbox" };
  const [incident] = ledger.report("mac", project, [inbox], { claims: [], runs: [] });
  assert.ok(incident);
  ledger.begin(incident.id, "r"); ledger.decide(incident.id, "r", { action: "wait", reason: "Needs a clearer scope" }); ledger.complete(incident.id, "r");
  now += RECOVERY_RECHECK_MS + 1;
  assert.deepEqual(ledger.report("mac", project, [inbox], { claims: [], runs: [] }), []);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.report("mac", project, [{ ...inbox, evidenceRevision: "a".repeat(64) }], { claims: [], runs: [] })[0]?.state, "queued");
  db.close();
});

test("completed assessment-only waits release ownership and retain their evidence", () => {
  for (const hasImplementation of [false, true]) {
    const store = new FleetStore(":memory:", limits);
    if (hasImplementation) {
      store.start(request(1, { id: "builder", role: "builder" }));
      store.finish("mac", "session", "builder");
    }
    const [incident] = store.recoveryReport("mac", project, [{ ...observation(1, []), blocked: true }]);
    store.start(request());
    store.recoveryStep("mac", "session", project, incident.id, "run-1", "begin");
    store.recoveryStep("mac", "session", project, incident.id, "run-1", "decide", { action: "wait", reason: "The prerequisite is still being built" });
    store.recoveryStep("mac", "session", project, incident.id, "run-1", "complete");
    store.finish("mac", "session", "run-1");
    assert.equal(store.snapshot().claims.length, hasImplementation ? 1 : 0);
    assert.equal(store.snapshot().releasedAssessmentClaims?.length ?? 0, hasImplementation ? 0 : 1);
    assert.equal(store.recovery.incident(incident.id).state, "complete");
    assert.equal(store.recovery.incident(incident.id).decision?.action, "wait");
    store.finish("mac", "session", "run-1");
    assert.equal(store.snapshot().claims.length, hasImplementation ? 1 : 0, "completion replay preserves the result");
    store.close();
  }
});

test("an unfinished or repair-assigned assessment keeps its claim", () => {
  for (const outcome of ["unconfirmed", "repair"] as const) {
    const store = new FleetStore(":memory:", limits);
    const [incident] = store.recoveryReport("mac", project, [observation()]);
    store.start(request());
    store.recoveryStep("mac", "session", project, incident.id, "run-1", "begin");
    store.recoveryStep("mac", "session", project, incident.id, "run-1", "decide",
      { action: outcome === "repair" ? "rework" : "wait", reason: "Recorded assessment" });
    if (outcome === "repair") store.recoveryStep("mac", "session", project, incident.id, "run-1", "complete");
    store.finish("mac", "session", "run-1", outcome === "repair");
    assert.equal(store.snapshot().claims.length, 1);
    store.close();
  }
});
const agents: AgentConfig[] = ["refiner", "builder", "verifier", "documentation"].map((name, n) => ({ name, column: ["Backlog", "In Development", "In Code Review", "In Documentation"][n], description: name, claudeMdPath: "unused", usesWorktree: true, producesCommits: name === "builder" }));
const item = (labels = ["error:builder"]): ProjectItem => ({ id: "item", issueId: "issue", issueNumber: 1, title: "Repair", body: "", status: "In Development", labels, url: "https://example.test/1", blockedBy: [], parentNumber: null, grandparentNumber: null });
const url = (server: { address(): unknown }) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;

test("quiet polls and expected waits never schedule AI; two reworks request assessment", () => {
  assert.equal(recoveryTrigger(observation(1, [])), null);
  assert.equal(recoveryTrigger({ ...observation(), blocked: true })?.manual, false);
  assert.equal(recoveryTrigger(observation(1, ["error-retry-count:2"])), null);
  assert.equal(recoveryTrigger(observation(1, ["needs-real-claude"])), null);
  assert.equal(recoveryTrigger(observation(1, ["rework-count:1"])), null);
  assert.equal(recoveryTrigger(observation(1, ["rework-count:2"]))?.manual, false);
  assert.equal(recoveryTrigger({ ...observation(), status: "Halted" })?.manual, true);
  assert.equal(recoveryTrigger(observation(1, ["error:builder:permission_denied"]))?.manual, true);
});

test("exhausted documentation retries queue one immediate assessment without restarting pending retries", () => {
  const store = new FleetStore(":memory:", limits);
  const stopped = { ...observation(1809, ["error:documentation", "error-retry-count:4", "done:verifier"]), status: "In Documentation" };
  const [incident] = store.recoveryReport("mac", project, [stopped]);
  assert.ok(incident, "the parked documentation error must not wait for the 24-hour fallback");
  assert.equal(incident.state, "queued");
  assert.equal(store.recoveryReport("mac", project, [stopped])[0].id, incident.id);
  assert.equal(recoveryTrigger(observation(1, ["error:builder", "error-retry-count:2"]))?.manual, false, "an error marks a stopped stage even below the retry limit");
  assert.equal(recoveryTrigger(observation(1, ["error-retry-count:4"])), null, "the final pending retry still owns its backoff");
  assert.notEqual(recoveryFingerprint(stopped), recoveryFingerprint({ ...stopped, labels: stopped.labels.filter(l => !l.startsWith("error-retry-count:")) }), "a counter change invalidates a stale reset decision");
  assert.equal(recoveryTrigger({ ...stopped, labels: [...stopped.labels, "health-hold:login"] }), null);
  assert.equal(recoveryTrigger({ ...stopped, labels: [...stopped.labels, "needs-human:approval"] })?.manual, true);
  store.close();
});

test("ordinary retry resets require a relevant recovery finding and preserve review counters", () => {
  const stopped = { ...item(["error:documentation", "error-retry-count:4", "done:verifier", "rework-count:2", "family-dispatches:9"]), status: "In Documentation" };
  const finding = "The dedicated live sign-in is now provisioned and its login probe succeeds; rerun the named Luna scenario.";
  const retry = parseRecoveryDecision(JSON.stringify({ action: "retry", reason: "The missing prerequisite has been restored", retryReset: finding }));
  assert.deepEqual(recoveryPlan(stopped, retry, agents).remove.sort(), ["error-retry-count:4", "error:documentation"]);
  assert.throws(() => recoveryPlan(stopped, { action: "retry", reason: "Try unchanged" }, agents), /retry reset/i);
  for (const action of ["wait", "escalate", "propose-close"]) {
    assert.deepEqual(recoveryPlan(stopped, parseRecoveryDecision(JSON.stringify({ action, reason: "No actionable finding" })), agents).remove, []);
    assert.throws(() => parseRecoveryDecision(JSON.stringify({ action, reason: "No action", retryReset: finding })), /Invalid/);
  }
  for (const retryReset of ["", "   ", false, "x".repeat(6001)]) {
    assert.throws(() => parseRecoveryDecision(JSON.stringify({ action: "retry", reason: "Retry", retryReset })), /Invalid/);
  }
  const broken = item(["error:builder", "error-retry-count:4", "rework-count:2", "family-dispatches:9"]);
  const repair = parseRecoveryDecision(JSON.stringify({ action: "rework", reason: "Repair the confirmed environment-name mismatch", retryReset: "The builder can replace the mismatched environment name and prove the original failure no longer occurs." }));
  assert.deepEqual(recoveryPlan(broken, repair, agents).remove.sort(), ["error-retry-count:4", "error:builder"]);
  assert.throws(() => recoveryPlan(broken, { action: "rework", reason: "Repeat the previous repair" }, agents), /retry reset/i);
  const inbox = { ...item(["error:refiner", "error-retry-count:4", "orchestrator:returned-inbox"]), status: "Inbox" };
  const refinement = parseRecoveryDecision(JSON.stringify({ action: "refine", reason: "Add the missing reproducible planning input", retryReset: "A bounded local capture recipe replaces the unavailable historical artifact." }));
  assert.deepEqual(recoveryPlan(inbox, refinement, agents).remove.sort(), ["error-retry-count:4", "error:refiner", "orchestrator:returned-inbox"]);
  const halted = { ...item(["error-retry-count:4"]), status: "Halted", recoveryPause: { ticket: project + "#1", origin: "pipeline" as const, actor: "builder", reason: "Login unavailable", missing: "Login", resumeOn: "Login restored", resumeStatus: "In Development", revision: "pause" } };
  const resume = parseRecoveryDecision(JSON.stringify({ action: "resume", reason: "Login restored", retryReset: "The missing login now passes the credential probe." }));
  assert.deepEqual(recoveryPlan(halted, resume, agents).remove, ["error-retry-count:4"]);
});

test("a documented retry reset survives the decision ledger and is applied before releasing the stage error", async () => {
  for (const budgetExhausted of [false, true]) {
    const db = new DatabaseSync(":memory:");
    const ledger = new RecoveryLedger(db, () => 100000000);
    const current = { ...item(["error:documentation", "error-retry-count:4", "done:verifier"]), status: "In Documentation" };
    const [incident] = ledger.report("mac", project, [observationFor(project, current)], { claims: [], runs: [] });
    assert.ok(incident);
    if (budgetExhausted) db.prepare("INSERT INTO fleet_recovery VALUES (?,?,?,?,?,?,?,?,?,0)").run("prior", project + "#1", "prior", "prior repair", "complete", 99999000, 99999000, "prior", JSON.stringify({ action: "rework", reason: "Earlier repair" }));
    if (budgetExhausted) for (const id of ["prior-2", "prior-3"]) db.prepare("INSERT INTO fleet_recovery SELECT ?,ticket,fingerprint,reason,state,created,updated,run_id,decision,present FROM fleet_recovery WHERE id='prior'").run(id);
    const writes: string[] = []; let comment = "";
    const decision = parseRecoveryDecision(JSON.stringify({ action: "retry", reason: "The dedicated account now passes the login probe", retryReset: "Restored the missing dedicated account and verified the prerequisite." }));
    await runRecoveryWork(incident, {
      project, agents, readCurrent: async () => current, begin: async () => ledger.begin(incident.id, "recovery"),
      assess: async () => decision, decide: async d => ledger.decide(incident.id, "recovery", d), complete: async () => ledger.complete(incident.id, "recovery"),
      addLabel: async () => {}, removeLabel: async (_issue, label) => { writes.push(label); },
      comment: async (_issue, body) => { comment = body; }, move: async () => {}, notify: async () => {},
    });
    if (budgetExhausted) {
      assert.equal(ledger.incident(incident.id).decision?.action, "escalate");
      assert.equal(writes.includes("error-retry-count:4"), false);
      assert.equal(writes.includes("error:documentation"), false);
    } else {
      assert.deepEqual(ledger.incident(incident.id).decision, decision);
      assert.equal(ledger.incident(incident.id).state, "complete");
      assert.ok(writes.indexOf("error-retry-count:4") < writes.indexOf("error:documentation"));
      assert.match(comment, /Restored the missing dedicated account/);
      assert.match(comment, /^<!-- fleet-recovery:.* -->\n<!-- pyry-auto-retry-reset -->\n/, "the durable comment reader needs an unambiguous reset boundary");
    }
    db.close();
  }
});

test("a pipeline return to Inbox queues one assessment without promoting ordinary intake or operator holds", () => {
  const store = new FleetStore(":memory:", limits);
  const returned = { ...observation(167, ["orchestrator:returned-inbox"]), status: "Inbox" };
  assert.equal(recoveryTrigger({ ...returned, labels: [] })?.reason, "Inbox readiness reassessment");
  assert.equal(recoveryTrigger({ ...returned, status: "Backlog" }), null);
  assert.equal(recoveryTrigger({ ...returned, labels: [...returned.labels, "needs-human:decision"] })?.manual, true);
  const [incident] = store.recoveryReport("mac", project, [returned]);
  assert.equal(incident.state, "queued");
  assert.equal(store.recoveryReport("mac", project, [returned])[0].id, incident.id);
  assert.notEqual(recoveryFingerprint(returned), recoveryFingerprint({ ...returned, labels: [] }));
  store.close();
});





test("an incident survives restart and only its admitted owner can assess it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "recovery-db-")), "fleet.sqlite");
  let store = new FleetStore(path, limits);
  const [incident] = store.recoveryReport("mac", project, [observation()]);
  assert.equal(store.recoveryReport("linux", project, [observation()])[0].id, incident.id);
  assert.throws(() => store.recoveryStep("mac", "session", project, incident.id, "missing", "begin"), /admitted/);
  assert.equal(store.start(request()).ok, true);
  assert.throws(() => store.recoveryStep("linux", "session", project, incident.id, "run-1", "begin"), /another machine|owner/i);
  assert.equal(store.recoveryReport("linux", project, [observation()]).length, 0);
  assert.equal(store.recoveryReport("mac", project, [observation()])[0].id, incident.id, "a granted but unstarted recovery stays available");
  store.recoveryStep("mac", "session", project, incident.id, "run-1", "begin");
  store.close(); store = new FleetStore(path, limits);
  assert.equal(store.recovery.incident(incident.id).state, "assessing");
  assert.equal(store.snapshot().runs.length, 1);
  assert.equal(store.recoveryReport("mac", project, [observation()]).length, 0);
  // Neither a restart nor a missing report authorises reclaiming a run.
  assert.equal(store.start(request(1, { id: "new", machine: "linux" })).ok, false);
  store.finish("mac", "session", "run-1", false);
  store.recoveryReport("mac", project, [observation()]);
  assert.equal(store.recovery.incident(incident.id).state, "escalated");
  store.close();
});

test("recurrence is a new event with a persistent per-ticket repair limit", () => {
  const store = new FleetStore(":memory:", limits);
  const [first] = store.recoveryReport("mac", project, [observation()]);
  store.start(request());
  store.recoveryStep("mac", "session", project, first.id, "run-1", "begin");
  const d = { action: "retry" as const, reason: "Temporary failure cleared" };
  assert.deepEqual(store.recoveryStep("mac", "session", project, first.id, "run-1", "decide", d), d);
  assert.deepEqual(store.recoveryStep("mac", "session", project, first.id, "run-1", "decide", d), d, "lost acknowledgement spends no extra budget");
  store.recoveryStep("mac", "session", project, first.id, "run-1", "complete");
  store.finish("mac", "session", "run-1");
  assert.equal(store.recoveryReport("mac", project, [observation()]).length, 0);
  store.recoveryReport("mac", project, [observation(1, [])]);
  const [second] = store.recoveryReport("mac", project, [observation()]);
  assert.notEqual(second.id, first.id);
  store.start(request(1, { id: "again" }));
  store.recoveryStep("mac", "session", project, second.id, "again", "begin");
  assert.equal((store.recoveryStep("mac", "session", project, second.id, "again", "decide", d) as any).action, "retry");
  store.close();
});

test("recovery respects capacity, drains and fleet-wide assessment exclusion", async () => {
  const store = new FleetStore(":memory:", limits);
  const claims = { snapshot: async () => store.snapshot(), start: async (r: StartRequest) => store.start(r), finish: async (s: string, id: string) => store.finish("mac", s, id) };
  const manager = new MachineManager({ machine: "mac", projects: [project], heavyLimit: 1, combinedLimit: 2, drainingProjects: [project] }, claims);
  const offer = { project, ticket: `${project}#1`, key: "recover", role: "recovery", resource: "heavy" as const, locks: [], order: -4 };
  manager.offer(project, "session", [offer]);
  await manager.tick(); assert.equal(store.snapshot().runs.length, 0, "project drain rejects new claims");
  store.start(request(1, { id: "previous", role: "builder" })); store.finish("mac", "session", "previous");
  manager.draining = true; await manager.tick(); assert.equal(store.snapshot().runs.length, 0);
  manager.draining = false; await manager.tick(); assert.equal(store.snapshot().runs[0].role, "recovery");
  assert.deepEqual(store.start(request(2, { machine: "linux" })), { ok: false, reason: "locked" });
  assert.throws(() => store.start(request(3, { resource: "light" })), /heavy/);
  const run = store.snapshot().runs[0]; store.finish("mac", "session", run.id);
  store.start(request(4, { role: "verifier" }));
  assert.deepEqual(store.start(request(2)), { ok: false, reason: "capacity" });
  store.close();
});

test("stale labels produce one alert; manager heartbeat is not worker proof", async () => {
  const db = new DatabaseSync(":memory:"); let now = 1000;
  const ledger = new RecoveryLedger(db, () => now);
  const stuck = observation(1, ["wip:builder"]);
  assert.equal(ledger.report("mac", project, [stuck], { claims: [], runs: [] }).length, 0);
  now += 3 * 3600000;
  const [alert] = ledger.report("mac", project, [stuck], { claims: [], runs: [] });
  assert.equal(alert.state, "escalated");
  assert.equal(ledger.report("mac", project, [stuck], { claims: [], runs: [] }).length, 0);
  const manager = new MachineManager({ machine: "mac", projects: [project], heavyLimit: 1, combinedLimit: 2 }, {
    snapshot: async () => ({ claims: [], runs: [] }), start: async () => ({ ok: false, reason: "locked" }), finish: async () => {},
  }, () => now);
  manager.offer(project, "session", []);
  now += 180001;
  assert.equal((await manager.status()).projects[0].health, "dispatcher-unreachable");
  db.close();
});

test("a retained Backlog builder produces one durable diagnostic without releasing or duplicating work", () => {
  const path = join(mkdtempSync(join(tmpdir(), "retained-run-db-")), "fleet.sqlite");
  const store = new FleetStore(path, limits);
  let now = Date.now();
  let db = new DatabaseSync(path);
  let ledger = new RecoveryLedger(db, () => now);
  store.start(request(1, { role: "builder" }));
  const before = store.snapshot();
  now = before.runs[0].created;
  const backlog = { ...observation(1, []), status: "Backlog" };
  assert.deepEqual(ledger.report("mac", project, [backlog], before), []);
  now += RECOVERY_STALLED_RUN_MS - 1;
  assert.deepEqual(ledger.report("mac", project, [backlog], before), []);
  now++;
  const [incident] = ledger.report("mac", project, [backlog], before);
  assert.equal(incident.state, "escalated");
  assert.equal(incident.runId, "run-1");
  assert.match(incident.reason, /Retained reservation.*local child processes/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(store.start(request(1, { id: "duplicate", role: "refiner" })), { ok: false, reason: "running" });
  db.close(); db = new DatabaseSync(path); ledger = new RecoveryLedger(db, () => now);
  assert.deepEqual(ledger.report("mac", project, [backlog], before), [], "restart must not repeat the alert");
  assert.deepEqual(ledger.report("linux", project, [backlog], before), [], "a different computer must not diagnose the owner's ticket");
  store.finish("mac", "session", "run-1");
  ledger.report("mac", project, [backlog], store.snapshot());
  assert.equal(ledger.incident(incident.id).state, "resolved");
  assert.deepEqual(store.snapshot().claims, before.claims, "finishing the run preserves its ticket owner and generation");
  assert.equal(store.start(request(1, { id: "refine", role: "refiner" })).ok, true);
  db.close(); store.close();
});

test("stalled retained runs remain visible with errors, running labels or earlier completed assessments", () => {
  for (const status of ["Backlog", "In Development"]) for (const labels of [[], ["wip:builder"], ["error:builder"]]) {
    const db = new DatabaseSync(":memory:"); let now = 1000;
    const ledger = new RecoveryLedger(db, () => now);
    const stuck = { ...observation(1, labels), status };
    const fleet = { claims: [], runs: [{ ...request(1, { role: "builder" }), generation: "generation", created: now }] };
    if (labels.includes("error:builder")) {
      const [assessment] = ledger.report("mac", project, [stuck], { claims: [], runs: [] });
      ledger.begin(assessment.id, "assessment");
      ledger.decide(assessment.id, "assessment", { action: "wait", reason: "Wait for the builder" });
    }
    ledger.report("mac", project, [stuck], fleet);
    now += RECOVERY_STALLED_RUN_MS;
    const [alert] = ledger.report("mac", project, [stuck], fleet);
    assert.equal(alert.state, "escalated");
    assert.deepEqual(ledger.report("mac", project, [stuck], fleet), []);
    const resumed = ledger.report("mac", project, [stuck], { claims: [], runs: [] });
    assert.equal(ledger.incident(alert.id).state, "resolved");
    if (labels.includes("error:builder")) assert.equal(resumed[0].state, "queued", "a stopped run's diagnostic must not suppress ordinary error recovery");
    db.close();
  }
});

test("workflow progress and a newly admitted run restart the retained-reservation grace period", () => {
  const db = new DatabaseSync(":memory:"); let now = 1000;
  const ledger = new RecoveryLedger(db, () => now);
  const run = { ...request(1, { role: "builder" }), generation: "generation", created: now };
  const fleet = { claims: [], runs: [run] };
  ledger.report("mac", project, [observation(1, [])], fleet);
  now += RECOVERY_STALLED_RUN_MS - 1;
  const changed = { ...observation(1, ["done:builder"]), status: "Backlog" };
  assert.deepEqual(ledger.report("mac", project, [changed], fleet), []);
  now += RECOVERY_STALLED_RUN_MS - 1;
  assert.deepEqual(ledger.report("mac", project, [changed], fleet), []);
  fleet.runs = [{ ...run, id: "new-run", created: now }];
  now++;
  assert.deepEqual(ledger.report("mac", project, [changed], fleet), []);
  now += RECOVERY_STALLED_RUN_MS;
  assert.equal(ledger.report("mac", project, [changed], fleet)[0].runId, "new-run");
  db.close();
});

test("ordinary unclaimed Backlog waits stay quiet while stranded Backlog running labels alert", () => {
  const db = new DatabaseSync(":memory:"); let now = 1000;
  const ledger = new RecoveryLedger(db, () => now);
  const empty = { claims: [], runs: [] };
  const backlog = { ...observation(1, []), status: "Backlog" };
  const stranded = { ...observation(2, ["wip:builder"]), status: "Backlog" };
  ledger.report("mac", project, [backlog, stranded], empty);
  now += 24 * 3600000;
  const incidents = ledger.report("mac", project, [backlog, stranded], empty);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].ticket, stranded.ticket);
  assert.equal(incidents[0].state, "escalated");
  db.close();
});

test("a retained-run diagnostic resolves on observed progress or replacement of that exact run", () => {
  for (const mode of ["progress", "replacement"]) {
    const db = new DatabaseSync(":memory:"); let now = 1000;
    const ledger = new RecoveryLedger(db, () => now);
    let current = { ...observation(1, []), status: "Backlog" };
    const fleet = { claims: [], runs: [{ ...request(1, { role: "builder" }), generation: "generation", created: now }] };
    ledger.report("mac", project, [current], fleet);
    now += RECOVERY_STALLED_RUN_MS;
    const [alert] = ledger.report("mac", project, [current], fleet);
    if (mode === "progress") current = { ...current, status: "In Development", labels: ["done:builder"] };
    else fleet.runs = [{ ...fleet.runs[0], id: "replacement", created: now }];
    assert.deepEqual(ledger.report("mac", project, [current], fleet), []);
    assert.equal(ledger.incident(alert.id).state, "resolved");
    now += RECOVERY_STALLED_RUN_MS;
    assert.notEqual(ledger.report("mac", project, [current], fleet)[0].id, alert.id);
    db.close();
  }
});

test("strict decisions and code guards cannot bypass holds, review or dependencies", () => {
  assert.deepEqual(parseRecoveryDecision('{"action":"wait","reason":"Findings shrink"}'), { action: "wait", reason: "Findings shrink" });
  assert.throws(() => parseRecoveryDecision('{"action":"merge","reason":"Skip review"}'), /Invalid/);
  assert.throws(() => parseRecoveryDecision('{"status":"blocked","summary":"{}"}'), /did not complete/);
  const rework = { action: "rework" as const, reason: "Repair the common cause" };
  for (const changed of [ { ...item(), status: "Halted" }, item(["error:builder:permission_denied"]), item(["rework-count:2", "done:verifier"]), { ...item(), blockedBy: [{ number: 2, state: "OPEN" as const }] } ]) {
    assert.throws(() => recoveryPlan(changed, rework, agents));
  }
  const labels = ["error:rework-loop", "done:builder", "needs-rework:builder", "rework-count:6", "needs-real-claude", "claim:mac"];
  const plan = recoveryPlan(item(labels), rework, agents);
  assert.equal(plan.status, "In Development");
  assert.deepEqual(plan.remove.sort(), ["done:builder", "error:rework-loop", "needs-rework:builder"]);
});

test("changed evidence, converging work and failed assessments never trigger a repair", async () => {
  for (const mode of ["changed", "wait", "failed"] as const) {
    let reads = 0; let assessed = 0; const writes: string[] = []; let decided: any;
    const current = item();
    const incident: RecoveryIncident = { id: "incident", ticket: `${project}#1`, fingerprint: recoveryFingerprint(observationFor(project, current)), reason: "error", state: "queued", created: 1, updated: 1, runId: null, decision: null };
    await runRecoveryWork(incident, {
      project, agents, addLabel: async () => {}, begin: async () => ({ ...incident, state: "assessing" }),
      readCurrent: async () => ++reads > 1 && mode === "changed" ? { ...current, status: "Done" } : current,
      assess: async () => { assessed++; if (mode === "failed") throw new Error("bad output"); return { action: mode === "wait" ? "wait" : "retry", reason: "Evidence" }; },
      decide: async d => { decided = d; return d; }, complete: async () => {},
      comment: async () => {}, removeLabel: async (_n, label) => { writes.push(label); }, move: async () => { writes.push("move"); }, notify: async () => {},
    });
    assert.equal(assessed, 1); assert.deepEqual(writes, mode === "failed" ? ["orchestrator:investigating", "orchestrator:fixing"] : ["orchestrator:investigating"]);
    assert.equal(decided.action, mode === "failed" ? "escalate" : "wait");
  }
});

test("real HTTP admission, durable decision and code-owner handback work together", async t => {
  const store = new FleetStore(":memory:", limits);
  const central = await serveFleet(store, { mac: "mac-token" }, "central-admin", 0);
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 2, projects: [project] }, new FleetClient(url(central), "mac-token"));
  const server = await serveManager(manager, { [project]: "project-token" }, "manager-admin", 0);
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => central.close(() => r())); store.close(); });
  const managed = new ManagedDispatch(project, { PYRY_MANAGER_URL: url(server), PYRY_MANAGER_TOKEN: "project-token" });
  await managed.sync();
  const current = item(["error:rework-loop", "done:builder", "rework-count:6", "needs-real-claude"]);
  const [incident] = await managed.recoveryReport([current]);
  const offer = managed.offer(1, "recovery", "heavy", [], -4);
  await managed.sync(); await manager.tick(); await managed.sync();
  assert.equal(managed.ready(offer), true);
  const order: string[] = []; let comment = "";
  await managed.run(offer, () => runRecoveryWork(incident, {
    project, agents, addLabel: async () => {}, readCurrent: async () => structuredClone(current),
    begin: () => managed.recoveryStep<RecoveryIncident>("begin", incident.id),
    assess: async () => ({ action: "rework", reason: "Reproduce the history validator gap and repair all entry points" }),
    decide: async d => { order.push("persist"); return managed.recoveryStep("decide", incident.id, d); },
    complete: () => managed.recoveryStep("complete", incident.id),
    comment: async (_n, body) => { await managed.authorize(1); order.push("comment"); comment = body; },
    move: async () => { await managed.authorize(1); order.push("move"); },
    removeLabel: async (_n, label) => { await managed.authorize(1); order.push(label); current.labels = current.labels.filter(l => l !== label); },
    notify: async () => { order.push("notify"); },
  }));
  assert.deepEqual(order, ["persist", "comment", "move", "done:builder", "error:rework-loop", "notify", "orchestrator:investigating"]);
  assert.deepEqual(current.labels, ["rework-count:6", "needs-real-claude"]);
  assert.match(recoveryHandoff([comment]), /repair all entry points/);
  assert.equal(store.snapshot().runs.length, 0);
  assert.equal(store.snapshot().claims[0].machine, "mac");
  assert.equal(store.recovery.incident(incident.id).state, "complete");
  const operator = new JsonClient(url(server), "manager-admin");
  assert.equal((await operator.call<RecoveryIncident[]>("/recovery/state"))[0].id, incident.id);
});

test("unrelated tickets cannot exhaust each other's assessments or repairs", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new RecoveryLedger(db, () => 100000000);
  const empty = { claims: [], runs: [] };
  for (let n = 1; n <= 41; n++) {
    const incident = ledger.report("mac", project, [observation(n)], empty).find(i => i.ticket === `${project}#${n}`)!;
    const started = ledger.begin(incident.id, `run-${n}`);
    assert.equal(started.state, "assessing");
    const decision = ledger.decide(incident.id, `run-${n}`, { action: "retry", reason: "Temporary fault cleared" });
    assert.equal(decision.action, "retry");
    ledger.complete(incident.id, `run-${n}`);
  }
  db.close();
});

test("sizing review remains informational while real operator holds stay manual", async () => {
  const current = item(["needs-human:sizing", "error:rework-loop", "done:builder"]);
  assert.equal(recoveryTrigger(observationFor(project, current))?.manual, false);
  assert.equal(recoveryTrigger(observation(1, ["needs-human:sizing"])), null);
  assert.equal(recoveryTrigger(observation(1, ["needs-human:sizing", "needs-human:decision", "error:builder"]))?.manual, true);
  assert.equal(recoveryPlan(current, { action: "rework", reason: "Repair repeated source provenance defect" }, agents).status, "In Development");
  current.labels = ["needs-human:sizing", "orchestrator:fixing"];
  const removed: string[] = [];
  await cleanRecoveryLabels([current], async (_n, label) => { removed.push(label); });
  assert.deepEqual(removed, [], "informational sizing must not remove repair priority");
});

test("unchanged waits recheck only after the persisted safety interval and never duplicate an active worker", () => {
  const db = new DatabaseSync(":memory:"); let now = 100000000;
  let ledger = new RecoveryLedger(db, () => now);
  const empty = { claims: [], runs: [] };
  const [first] = ledger.report("mac", project, [observation()], empty);
  ledger.begin(first.id, "first");
  ledger.decide(first.id, "first", { action: "wait", reason: "Temporary service outage is resolving" });
  ledger = new RecoveryLedger(db, () => now);
  now += RECOVERY_RECHECK_MS;
  assert.equal(ledger.report("mac", project, [observation()], empty).length, 0, "the old thirty-minute timer no longer reopens an unchanged wait");
  now += RECOVERY_SAFETY_RECHECK_MS - RECOVERY_RECHECK_MS - 1;
  assert.equal(ledger.report("mac", project, [observation()], empty).length, 0);
  now++;
  assert.equal(ledger.report("mac", project, [observation()], { claims: [], runs: [{ ...request(), generation: "generation", created: now }] }).length, 0);
  const [second] = ledger.report("mac", project, [observation()], empty);
  assert.notEqual(second.id, first.id);
  assert.equal(second.state, "queued");
  assert.equal(ledger.report("mac", project, [observation()], empty)[0].id, second.id);
  ledger.begin(second.id, "second");
  ledger.decide(second.id, "second", { action: "escalate", reason: "Operator decision required" });
  now += 86400000;
  assert.equal(ledger.report("mac", project, [observation()], empty).length, 0, "a real escalation is not an automatic retry");
  db.close();
});

test("three repair assignments per ticket survive restart and expire without extending old budgets", () => {
  const db = new DatabaseSync(":memory:"); let now = 100000000;
  let ledger = new RecoveryLedger(db, () => now);
  const empty = { claims: [], runs: [] };
  for (let n = 1; n <= 4; n++) {
    const [incident] = ledger.report("mac", project, [observation(1, ["error:builder", `rework-count:${n}`])], empty);
    ledger.begin(incident.id, `run-${n}`);
    const decision = ledger.decide(incident.id, `run-${n}`, { action: "rework", reason: "Repair the diagnosed cause" });
    assert.equal(decision.action, n <= 3 ? "rework" : "escalate");
    assert.deepEqual(ledger.decide(incident.id, `run-${n}`, { action: "rework", reason: "Lost reply" }), decision);
    if (n <= 3) ledger.complete(incident.id, `run-${n}`);
    ledger = new RecoveryLedger(db, () => now);
  }
  now += 86400001;
  const [next] = ledger.report("mac", project, [observation(1, ["error:builder", "rework-count:5"])], empty);
  ledger.begin(next.id, "next-day");
  assert.equal(ledger.decide(next.id, "next-day", { action: "rework", reason: "New evidence" }).action, "rework");
  db.close();
});

test("a policy upgrade reassesses old safe escalations without overriding manual holds", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new RecoveryLedger(db, () => 100000000);
  const empty = { claims: [], runs: [] };
  const [old] = ledger.report("mac", project, [observation(1, ["needs-human:sizing", "error:rework-loop"])], empty);
  db.prepare("UPDATE fleet_recovery SET state='escalated',reason='Explicit operator hold' WHERE id=?").run(old.id);
  const [next] = ledger.report("mac", project, [observation(1, ["needs-human:sizing", "error:rework-loop"])], empty);
  assert.notEqual(next.id, old.id);
  assert.equal(next.state, "queued");
  const [held] = ledger.report("mac", project, [observation(2, ["needs-human:decision", "error:builder"])], empty);
  assert.equal(held.state, "escalated");
  const [limited] = ledger.report("mac", project, [observation(3)], empty);
  db.prepare("UPDATE fleet_recovery SET state='escalated',reason='Fleet recovery assessment daily limit reached' WHERE id=?").run(limited.id);
  assert.equal(ledger.report("mac", project, [observation(3)], empty)[0].state, "queued");
  const [interrupted] = ledger.report("mac", project, [observation(4)], empty);
  db.prepare("UPDATE fleet_recovery SET state='escalated',reason='Recovery ended without a confirmed result; inspect before retrying' WHERE id=?").run(interrupted.id);
  assert.equal(ledger.report("mac", project, [observation(4)], empty).length, 0, "an interrupted handback must not be reopened by the upgrade");
  db.close();
});

for (const phase of ["initial read", "assessment evidence read", "post-assessment read"] as const) {
  test(`a transient GitHub failure at the ${phase} durably waits for safe reassessment`, async t => {
    const db = new DatabaseSync(":memory:"); t.after(() => db.close());
    let now = 100000000;
    let ledger = new RecoveryLedger(db, () => now);
    const current = item(["error:builder", "error-retry-count:4", "rework-count:2"]);
    const observed = observationFor(project, current);
    const empty = { claims: [], runs: [] };
    const [incident] = ledger.report("mac", project, [observed], empty);
    const active = { claims: [], runs: [{ ...request(), generation: "generation", created: now }] };
    const outage = Object.assign(new Error("Shared GitHub temporarily unavailable (504)"), { status: 504 });
    let reads = 0, assessments = 0;
    const writes: string[] = [];
    await runRecoveryWork(incident, {
      project, agents, begin: async () => ledger.begin(incident.id, "run-1"),
      readCurrent: async () => {
        reads++;
        if (phase === "initial read" || phase === "post-assessment read" && reads === 2) throw outage;
        return structuredClone(current);
      },
      assess: async () => {
        assessments++;
        if (phase === "assessment evidence read") throw outage;
        return { action: "retry", reason: "The diagnosed temporary fault cleared", retryReset: "The credential probe now passes" };
      },
      decide: async d => ledger.decide(incident.id, "run-1", d),
      complete: async () => { assert.fail("No handback completed"); },
      addLabel: async (_n, label) => { writes.push(`add:${label}`); },
      removeLabel: async (_n, label) => { writes.push(`remove:${label}`); },
      comment: async () => { assert.fail("No recovery mutation may be applied"); },
      move: async () => { assert.fail("No recovery mutation may be applied"); },
      notify: async () => { assert.fail("A transient outage must not request inspection"); },
    });
    assert.equal(assessments, phase === "initial read" ? 0 : 1);
    const recorded = ledger.incident(incident.id);
    assert.equal(recorded.state, "escalated");
    assert.equal(recorded.decision?.action, "escalate");
    assert.equal(recorded.decision?.category, "operational");
    assert.match(recorded.decision!.reason, /GitHub.*504/);
    assert.equal(recorded.decision?.retryReset, undefined);
    assert.deepEqual(writes, [...(phase === "initial read" ? [] : ["add:orchestrator:investigating"]), "remove:orchestrator:investigating"]);
    assert.deepEqual(current.labels, ["error:builder", "error-retry-count:4", "rework-count:2"]);
    ledger = new RecoveryLedger(db, () => now);
    now += RECOVERY_RECHECK_MS - 1;
    assert.deepEqual(ledger.report("mac", project, [observed], empty), []);
    now++;
    assert.deepEqual(ledger.report("mac", project, [observed], active), [], "a live or uncertain worker keeps its reservation");
    assert.deepEqual(ledger.report("linux", project, [observed], {
      claims: [{ ticket: incident.ticket, machine: "mac", generation: "generation", created: now }], runs: [],
    }), [], "another machine cannot reassess an owned ticket");
    const [next] = ledger.report("mac", project, [observed], empty);
    assert.notEqual(next.id, incident.id);
    assert.equal(next.state, "queued");
    assert.equal(ledger.report("mac", project, [observed], empty)[0].id, next.id, "one fresh assessment is queued");
  });
}

test("transport deferral never overrides a human assessment or an assessment failure", async t => {
  for (const mode of ["human", "invalid"] as const) {
    const db = new DatabaseSync(":memory:"); t.after(() => db.close());
    let now = 100000000;
    const ledger = new RecoveryLedger(db, () => now);
    const current = item();
    const observed = observationFor(project, current), empty = { claims: [], runs: [] };
    const [incident] = ledger.report("mac", project, [observed], empty);
    let reads = 0;
    await runRecoveryWork(incident, {
      project, agents, begin: async () => ledger.begin(incident.id, "run-1"),
      readCurrent: async () => {
        if (++reads === 2) throw new Error("Shared GitHub temporarily unavailable (504)");
        return current;
      },
      assess: async () => {
        if (mode === "invalid") throw new Error("Recovery assessment failed");
        return { action: "escalate", category: "human", reason: "A permission was denied; an operator must resolve it" };
      },
      decide: async d => ledger.decide(incident.id, "run-1", d),
      complete: async () => { assert.fail("No handback completed"); },
      addLabel: async () => {}, removeLabel: async () => {},
      comment: async () => { assert.fail("No ticket mutation"); }, move: async () => { assert.fail("No ticket mutation"); }, notify: async () => {},
    });
    const decision = ledger.incident(incident.id).decision!;
    assert.equal(decision.action, "escalate");
    assert.notEqual(decision.category, "operational");
    assert.match(decision.reason, mode === "human" ? /permission was denied/ : /assessment failed/);
    now += RECOVERY_RECHECK_MS;
    assert.deepEqual(ledger.report("mac", project, [observed], empty), []);
  }
});

test("operational transport waits still obey fresh permission, operator and running-label holds", () => {
  for (const hold of ["error:builder:permission_denied", "needs-human:decision", "operator pause", "unknown pause", "wip:builder"]) {
    const db = new DatabaseSync(":memory:"); let now = 100000000;
    const ledger = new RecoveryLedger(db, () => now), empty = { claims: [], runs: [] };
    const observed = observation();
    const [incident] = ledger.report("mac", project, [observed], empty);
    ledger.begin(incident.id, "run-1");
    ledger.decide(incident.id, "run-1", { action: "escalate", category: "operational", reason: "Temporary GitHub outage" });
    now += RECOVERY_RECHECK_MS;
    const held: RecoveryObservation = hold.endsWith("pause") ? { ...observed, status: "Halted",
      ...(hold === "operator pause" ? { pause: { ticket: observed.ticket, origin: "operator" as const, actor: "operator", reason: "Manual pause",
        missing: "Operator decision", resumeOn: "Operator approval", resumeStatus: observed.status, revision: "pause-1" } } : {}) }
      : { ...observed, labels: [...observed.labels, hold] };
    const results = ledger.report("mac", project, [held], empty);
    assert.ok(results.every(i => i.state === "escalated"), `${hold} must not queue recovery`);
    db.close();
  }
});

for (const failure of ["move", "label removal", "decision reply"] as const) {
  test(`a transient failure at ${failure} after repair reservation is never replayed and retains its budget`, async t => {
    const store = new FleetStore(":memory:", limits); t.after(() => store.close());
    const current = item(["error:rework-loop", "done:builder", "rework-count:6"]);
    const [incident] = store.recoveryReport("mac", project, [observationFor(project, current)]);
    store.start(request());
    let assessed = 0, decisions = 0;
    const outage = Object.assign(new Error("Shared GitHub temporarily unavailable (504)"), { status: 504 });
    await assert.rejects(runRecoveryWork(incident, {
      project, agents, addLabel: async () => {}, readCurrent: async () => current,
      begin: async () => store.recoveryStep("mac", "session", project, incident.id, "run-1", "begin") as RecoveryIncident,
      assess: async () => { assessed++; return { action: "rework", reason: "Fix common cause" }; },
      decide: async d => {
        decisions++;
        const selected = store.recoveryStep("mac", "session", project, incident.id, "run-1", "decide", d) as any;
        if (failure === "decision reply") throw outage;
        return selected;
      },
      complete: async () => { throw new Error("must not complete"); },
      comment: async () => {},
      move: async () => { if (failure === "move") throw outage; },
      removeLabel: async (_n, label) => {
        if (label.startsWith("orchestrator:")) return;
        assert.equal(label, "done:builder", "the error must be removed last");
        current.labels = current.labels.filter(l => l !== label); // Applied, but its acknowledgement was lost.
        throw outage;
      }, notify: async () => {},
    }), /Shared GitHub temporarily unavailable/);
    assert.equal(assessed, 1);
    assert.equal(decisions, 1, "an uncertain decision must not be replaced by an operational wait");
    assert.equal(store.recovery.incident(incident.id).state, "applying");
    assert.equal(store.recovery.incident(incident.id).decision?.action, "rework");
    store.finish("mac", "session", "run-1", false);
    const [alert] = store.recoveryReport("mac", project, [observationFor(project, current)]);
    assert.equal(alert.state, "escalated");
    assert.notEqual(alert.decision?.category, "operational");
    assert.equal(store.snapshot().claims[0].machine, "mac");
    const next = store.recoveryReport("mac", project, [observationFor(project, current)]);
    if (failure === "label removal") {
      assert.notEqual(next[0].id, incident.id, "changed evidence can only request a fresh assessment");
      assert.equal(next[0].state, "queued");
      assert.equal(next[0].decision, null, "the partial handback must not be replayed");
    } else assert.deepEqual(next, []);
    assert.equal(store.recovery.incident(incident.id).decision?.action, "rework", "the original repair reservation remains spent");
    assert.ok(current.labels.includes("error:rework-loop"));
  });
}

test("project credentials cannot report or decide another project's recovery", async t => {
  const store = new FleetStore(":memory:", limits);
  const central = await serveFleet(store, { mac: "mac" }, "central", 0);
  const manager = new MachineManager({ machine: "mac", heavyLimit: 1, combinedLimit: 2, projects: [project, "org/mobile"] }, new FleetClient(url(central), "mac"));
  const server = await serveManager(manager, { [project]: "core", "org/mobile": "mobile" }, "operator", 0);
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => central.close(() => r())); store.close(); });
  const core = new JsonClient(url(server), "core");
  await assert.rejects(core.call("/recovery/report", { project: "org/mobile", observations: [{ ...observation(), ticket: "org/mobile#1" }] }), /Invalid recovery observation/);
  const mobile = new JsonClient(url(server), "mobile");
  const [incident] = await mobile.call<RecoveryIncident[]>("/recovery/report", { observations: [{ ...observation(), ticket: "org/mobile#1" }] });
  store.start(request(1, { project: "org/mobile", ticket: "org/mobile#1" }));
  await assert.rejects(core.call("/recovery/begin", { project: "org/mobile", session: "session", id: incident.id, runId: "run-1" }), /admitted/);
  assert.deepEqual(await core.call("/recovery/state"), []);
});

test("diagnosis evidence is bounded and restricted to this ticket's last two logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "recovery-context-"));
  for (const n of [1, 2, 3]) writeFileSync(join(dir, `${n}_builder_#1.log`), "x".repeat(13000) + `tail-${n}`);
  writeFileSync(join(dir, "4_builder_#2.log"), "another ticket");
  writeFileSync(join(dir, "5_recovery_#1.log"), "old assessment");
  const logs = recoveryLogContext(dir, 1);
  assert.deepEqual(logs.map(l => l.name), ["2_builder_#1.log", "3_builder_#1.log"]);
  assert.ok(logs.every(l => l.tail.length === 12000));
  assert.ok(logs[1].tail.endsWith("tail-3"));
});


test("investigating is visible during assessment; fixing survives a successful handback only", async () => {
  for (const mode of ["rework", "retry", "wait", "escalate", "interrupted"] as const) {
    const current = item();
    const incident: RecoveryIncident = {id: "visible", ticket: `${project}#1`, fingerprint: recoveryFingerprint(observationFor(project, current)), reason: "error", state: "queued", created: 1, updated: 1, runId: null, decision: null};
    const run = runRecoveryWork(incident, {
      project, agents, begin: async () => ({...incident, state: "assessing"}), readCurrent: async () => structuredClone(current),
      addLabel: async (_n, label) => {current.labels.push(label);},
      removeLabel: async (_n, label) => {current.labels = current.labels.filter(l => l !== label);},
      assess: async () => {
        assert.ok(current.labels.includes("orchestrator:investigating"));
        return {action: mode === "interrupted" ? "rework" : mode, reason: "Evidence"};
      },
      decide: async d => d, complete: async () => {}, notify: async () => {},
      comment: async () => {}, move: async () => {if (mode === "interrupted") throw new Error("outage");},
    });
    if (mode === "interrupted") await assert.rejects(run, /outage/); else await run;
    assert.equal(current.labels.includes("orchestrator:investigating"), false);
    assert.equal(current.labels.includes("orchestrator:fixing"), mode === "rework" || mode === "retry");
    assert.equal(current.labels.includes("error:builder"), mode !== "rework" && mode !== "retry");
  }
});

test("idle-ticket reconciliation repairs stale labels after outage or restart", async () => {
  const activeRepair = item(["orchestrator:fixing"]);
  const held = {...item(["orchestrator:fixing"]), issueNumber: 2, status: "Halted"};
  const failed = {...item(["orchestrator:fixing", "error:builder"]), issueNumber: 3};
  const done = {...item(["orchestrator:fixing", "orchestrator:investigating"]), issueNumber: 4, status: "Done"};
  const interrupted = {...item(["orchestrator:investigating"]), issueNumber: 5};
  const removed: string[] = [];
  await cleanRecoveryLabels([activeRepair, held, failed, done, interrupted], async (n,l) => {removed.push(`${n}:${l}`);});
  assert.deepEqual(removed, ["2:orchestrator:fixing", "3:orchestrator:fixing", "4:orchestrator:fixing", "4:orchestrator:investigating", "5:orchestrator:investigating"]);
  assert.deepEqual(activeRepair.labels, ["orchestrator:fixing"]);
  await cleanRecoveryLabels([held, failed, done, interrupted], async () => {throw new Error("duplicate cleanup");});
});
