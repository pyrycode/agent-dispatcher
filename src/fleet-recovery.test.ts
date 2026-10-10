import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RecoveryLedger, recoveryFingerprint, recoveryTrigger, type RecoveryObservation, type RecoveryIncident } from "./fleet-recovery.js";
import { FleetStore, type StartRequest } from "./fleet-store.js";
import { FleetClient, JsonClient, serveFleet } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { ManagedDispatch } from "./managed-dispatch.js";
import { runRecoveryWork, recoveryPlan, parseRecoveryDecision, recoveryHandoff, observationFor } from "./recovery-work.js";
import type { AgentConfig, ProjectItem } from "./types.js";
import { recoveryLogContext } from "./recovery-context.js";

const project = "org/core";
const limits = { mac: { heavyLimit: 1, combinedLimit: 2 }, linux: { heavyLimit: 1, combinedLimit: 2 } };
const observation = (n = 1, labels = ["error:builder"]): RecoveryObservation => ({ ticket: `${project}#${n}`, status: "In Development", labels, blocked: false });
const request = (n = 1, extra: Partial<StartRequest> = {}): StartRequest => ({ id: `run-${n}`, session: "session", machine: "mac", project, ticket: `${project}#${n}`, role: "recovery", resource: "heavy", locks: [], ...extra });
const agents: AgentConfig[] = ["refiner", "builder", "verifier", "documentation"].map((name, n) => ({ name, column: ["Backlog", "In Development", "In Code Review", "In Documentation"][n], description: name, claudeMdPath: "unused", usesWorktree: true, producesCommits: name === "builder" }));
const item = (labels = ["error:builder"]): ProjectItem => ({ id: "item", issueId: "issue", issueNumber: 1, title: "Repair", body: "", status: "In Development", labels, url: "https://example.test/1", blockedBy: [], parentNumber: null, grandparentNumber: null });
const url = (server: { address(): unknown }) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;

test("quiet polls and expected waits never schedule AI; two reworks request assessment", () => {
  assert.equal(recoveryTrigger(observation(1, [])), null);
  assert.equal(recoveryTrigger({ ...observation(), blocked: true }), null);
  assert.equal(recoveryTrigger(observation(1, ["error-retry-count:2", "error:builder"])), null);
  assert.equal(recoveryTrigger(observation(1, ["needs-real-claude"])), null);
  assert.equal(recoveryTrigger(observation(1, ["rework-count:1"])), null);
  assert.equal(recoveryTrigger(observation(1, ["rework-count:2"]))?.manual, false);
  assert.equal(recoveryTrigger({ ...observation(), status: "Halted" })?.manual, true);
  assert.equal(recoveryTrigger(observation(1, ["error:builder:permission_denied"]))?.manual, true);
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

test("recurrence is a new event but cannot buy another ticket repair within a day", () => {
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
  assert.equal((store.recoveryStep("mac", "session", project, second.id, "again", "decide", d) as any).action, "escalate");
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

test("strict decisions and code guards cannot bypass holds, review or dependencies", () => {
  assert.deepEqual(parseRecoveryDecision('{"action":"wait","reason":"Findings shrink"}'), { action: "wait", reason: "Findings shrink" });
  assert.throws(() => parseRecoveryDecision('{"action":"merge","reason":"Skip review"}'), /Invalid/);
  assert.throws(() => parseRecoveryDecision('{"status":"blocked","summary":"{}"}'), /did not complete/);
  const rework = { action: "rework" as const, reason: "Repair the common cause" };
  for (const changed of [ { ...item(), status: "Halted" }, item(["error:family-breaker"]), item(["error:builder:permission_denied"]), item(["rework-count:2", "done:verifier"]), { ...item(), blockedBy: [{ number: 2, state: "OPEN" as const }] } ]) {
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
      project, agents, begin: async () => ({ ...incident, state: "assessing" }),
      readCurrent: async () => ++reads > 1 && mode === "changed" ? { ...current, status: "Done" } : current,
      assess: async () => { assessed++; if (mode === "failed") throw new Error("bad output"); return { action: mode === "wait" ? "wait" : "retry", reason: "Evidence" }; },
      decide: async d => { decided = d; return d; }, complete: async () => {},
      comment: async () => {}, removeLabel: async (_n, label) => { writes.push(label); }, move: async () => { writes.push("move"); }, notify: async () => {},
    });
    assert.equal(assessed, 1); assert.deepEqual(writes, []);
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
    project, agents, readCurrent: async () => structuredClone(current),
    begin: () => managed.recoveryStep<RecoveryIncident>("begin", incident.id),
    assess: async () => ({ action: "rework", reason: "Reproduce the history validator gap and repair all entry points" }),
    decide: async d => { order.push("persist"); return managed.recoveryStep("decide", incident.id, d); },
    complete: () => managed.recoveryStep("complete", incident.id),
    comment: async (_n, body) => { await managed.authorize(1); order.push("comment"); comment = body; },
    move: async () => { await managed.authorize(1); order.push("move"); },
    removeLabel: async (_n, label) => { await managed.authorize(1); order.push(label); current.labels = current.labels.filter(l => l !== label); },
    notify: async () => { order.push("notify"); },
  }));
  assert.deepEqual(order, ["persist", "comment", "move", "done:builder", "error:rework-loop", "notify"]);
  assert.deepEqual(current.labels, ["rework-count:6", "needs-real-claude"]);
  assert.match(recoveryHandoff([comment]), /repair all entry points/);
  assert.equal(store.snapshot().runs.length, 0);
  assert.equal(store.snapshot().claims[0].machine, "mac");
  assert.equal(store.recovery.incident(incident.id).state, "complete");
  const operator = new JsonClient(url(server), "manager-admin");
  assert.equal((await operator.call<RecoveryIncident[]>("/recovery/state"))[0].id, incident.id);
});

test("assessment and repair limits persist and cannot be reset by a fresh report", () => {
  const db = new DatabaseSync(":memory:");
  const ledger = new RecoveryLedger(db, () => 100000000);
  const empty = { claims: [], runs: [] };
  for (let n = 1; n <= 41; n++) {
    const incident = ledger.report("mac", project, [observation(n)], empty).find(i => i.ticket === `${project}#${n}`)!;
    const started = ledger.begin(incident.id, `run-${n}`);
    if (n === 41) { assert.equal(started.state, "escalated"); break; }
    const decision = ledger.decide(incident.id, `run-${n}`, { action: "retry", reason: "Temporary fault cleared" });
    assert.equal(decision.action, n <= 2 ? "retry" : "escalate");
    ledger.complete(incident.id, `run-${n}`);
  }
  db.close();
});

test("a partial GitHub handback is never replayed and retains its repair budget", async () => {
  const store = new FleetStore(":memory:", limits);
  const current = item(["error:rework-loop", "done:builder", "rework-count:6"]);
  const [incident] = store.recoveryReport("mac", project, [observationFor(project, current)]);
  store.start(request());
  let assessed = 0;
  await assert.rejects(runRecoveryWork(incident, {
    project, agents, readCurrent: async () => current,
    begin: async () => store.recoveryStep("mac", "session", project, incident.id, "run-1", "begin") as RecoveryIncident,
    assess: async () => { assessed++; return { action: "rework", reason: "Fix common cause" }; },
    decide: async d => store.recoveryStep("mac", "session", project, incident.id, "run-1", "decide", d) as any,
    complete: async () => { throw new Error("must not complete"); },
    comment: async () => {}, move: async () => { throw new Error("GitHub unavailable"); }, removeLabel: async () => { throw new Error("must not clear the error"); }, notify: async () => {},
  }), /GitHub unavailable/);
  assert.equal(assessed, 1);
  assert.equal(store.recovery.incident(incident.id).state, "applying");
  store.finish("mac", "session", "run-1", false);
  const [alert] = store.recoveryReport("mac", project, [observationFor(project, current)]);
  assert.equal(alert.state, "escalated");
  assert.equal(store.recoveryReport("mac", project, [observationFor(project, current)]).length, 0);
  assert.ok(current.labels.includes("error:rework-loop"));
  store.close();
});

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
