import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { FleetStore } from "./fleet-store.js";
import { MachineManager, serveManager, type DesiredStateOptions } from "./machine-manager.js";
import { JsonClient, ServiceError, serveFleet } from "./fleet-http.js";
import { persistDesiredState, persistProjectDrains as persistDesiredStateLegacy } from "./fleet-config.js";
import { parseDesiredCommand, effectiveWork, workRefusal, DESIRED_STATE_SCHEMA, MACHINE_SCOPE as MACHINE_SCOPE_NAME, type DesiredPoll } from "./desired-state.js";
import type { WorkOffer } from "./machine-scheduler.js";

const core = "org/core", mobile = "org/mobile";
const offer = (project: string, ticket: string, role = "builder"): WorkOffer => ({
  project, ticket: `${project}#${ticket}`, role, resource: "light", key: `${ticket}-${role}`, order: 0, locks: role === "reconcile" ? [`${project}:reconcile`] : [],
});
const limits = { hp: { heavyLimit: 1, combinedLimit: 2 }, mac: { heavyLimit: 1, combinedLimit: 2 } };
/** A claim client for one computer, talking to the store directly, as the manager's FleetClient would. */
function client(store: FleetStore, machine: string, reachable = () => true) {
  const up = () => { if (!reachable()) throw new Error("connect ECONNREFUSED"); };
  return {
    snapshot: async () => { up(); return store.snapshot(); },
    start: async (r: any) => { up(); return store.start(r); },
    finish: async (s: string, id: string) => { up(); store.finish(machine, s, id); },
    call: async <T>(path: string, body?: any): Promise<T> => {
      up();
      if (path === "/machines/desired") return store.desiredPoll(machine, body as DesiredPoll) as T;
      if (path === "/machines/capabilities") return store.reportMachineCapabilities(machine, body.capabilities, body.projects) as T;
      throw new ServiceError(404, { error: "Unknown operation" }, "Unknown operation");
    },
  };
}
/** A manager configuration file, as fleet-bin reads and writes it. */
function configFile(initial: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "desired-"));
  const path = join(dir, "manager.json");
  writeFileSync(path, JSON.stringify({ machine: "hp", ...initial }));
  return { path, read: () => JSON.parse(readFileSync(path, "utf8")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
/** Construct the manager exactly as fleet-bin does from a configuration file. */
function managerFrom(path: string, claims: ReturnType<typeof client>, persist?: DesiredStateOptions["persist"]) {
  const saved = JSON.parse(readFileSync(path, "utf8"));
  return new MachineManager({ machine: "hp", projects: [core, mobile], heavyLimit: 1, combinedLimit: 2, drainingProjects: saved.drainingProjects, projectDrainChanges: saved.projectDrainChanges }, claims, Date.now,
    { ...(saved.desiredState ? { cached: saved.desiredState } : {}), persist: persist ?? (u => persistDesiredState(path, u)) });
}
async function grantsFor(manager: MachineManager, project: string, session: string, work: WorkOffer[]) {
  manager.offer(project, session, work);
  await manager.tick();
  return manager.grants(project, session);
}

test("a starting manager grants nothing before it has applied its desired state", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  const file = configFile(); t.after(file.cleanup);
  let up = false;
  const manager = managerFrom(file.path, client(store, "hp", () => up));
  assert.equal(manager.desiredKnown(), false);
  // The claim service is unreachable: nothing at all is admitted, not even housekeeping.
  manager.offer(core, "s", [offer(core, "1"), offer(core, "@reconcile", "reconcile")]);
  await manager.tick();
  await manager.refreshDesired();
  assert.equal(manager.desiredKnown(), false);
  up = true;
  await manager.tick();
  assert.deepEqual(store.snapshot().runs, []);
  const status = await manager.status();
  assert.equal(status.desiredState?.mode, "unknown");
  assert.ok(status.queue.every(q => q.state === "desired-state-unknown"));
  // Once the claim service answers, an empty document means taking work.
  await manager.refreshDesired();
  assert.equal(manager.desiredStatus()?.mode, "central");
  assert.equal((await grantsFor(manager, core, "s", [offer(core, "1")])).length, 1);
});

test("a central drain survives a manager restart with the claim service unreachable, and a claim service reload", async t => {
  const dir = mkdtempSync(join(tmpdir(), "desired-db-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "claims.sqlite");
  let store = new FleetStore(database, limits);
  const file = configFile(); t.after(file.cleanup);
  let up = true;
  // The claims client reads the current store, so a reload swaps it underneath.
  const claims = () => client(store, "hp", () => up);
  let manager = managerFrom(file.path, claims());
  await manager.refreshDesired();
  store.reportMachineCapabilities("hp", [], [core, mobile]);
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "drained" } });
  await manager.refreshDesired();
  assert.equal(manager.work(mobile), "drained");
  assert.deepEqual(file.read().drainingProjects, [mobile]);
  assert.equal(file.read().desiredState.document.entries[0].work, "drained");

  // Manager restart while the claim service is down: the saved copy applies.
  up = false;
  manager = managerFrom(file.path, claims());
  await manager.refreshDesired();
  assert.equal(manager.desiredStatus()?.mode, "cached");
  assert.equal(manager.work(mobile), "drained");
  assert.equal(manager.work(core), "taking");

  // Controller load: the claim service restarts on the same database.
  store.close();
  store = new FleetStore(database, limits);
  t.after(() => store.close());
  up = true;
  manager = managerFrom(file.path, claims());
  await manager.refreshDesired();
  assert.equal(manager.desiredStatus()?.mode, "central");
  assert.deepEqual(await grantsFor(manager, mobile, "s", [offer(mobile, "1")]), []);
  assert.equal((await grantsFor(manager, core, "c", [offer(core, "2")])).length, 1);
  assert.equal((await manager.status()).queue.find(q => q.ticket === `${mobile}#1`)?.state, "drained");
});

test("the saved document applies a ticket drain at start: owned tickets continue, new ones wait", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  store.start({ ...offer(mobile, "1"), id: "old", machine: "hp", session: "old" });
  store.finish("hp", "old", "old");
  store.reportMachineCapabilities("hp", [], [core, mobile]);
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "tickets-drained" } });
  const file = configFile({ desiredState: { document: store.desired.document("hp"), fetchedAt: 1 } }); t.after(file.cleanup);
  const manager = managerFrom(file.path, client(store, "hp", () => true));
  assert.equal(manager.desiredStatus()?.mode, "cached");
  const grants = await grantsFor(manager, mobile, "s", [offer(mobile, "1", "verifier"), offer(mobile, "2")]);
  assert.deepEqual(grants.map(g => g.ticket), [`${mobile}#1`]);
});

test("the claim service refuses new grants to a drained board even from an older manager", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  store.start({ ...offer(mobile, "1"), id: "owned", machine: "hp", session: "s" });
  store.finish("hp", "s", "owned");
  store.reportMachineCapabilities("hp", [], [core, mobile]);
  // An older manager: no desired state option, and it never fetches.
  const old = new MachineManager({ machine: "hp", projects: [core, mobile], heavyLimit: 1, combinedLimit: 2 }, client(store, "hp"));
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "tickets-drained" } });
  assert.equal(store.start({ ...offer(mobile, "2"), id: "new", machine: "hp", session: "s" }).ok, false);
  assert.deepEqual(store.start({ ...offer(mobile, "2"), id: "new", machine: "hp", session: "s" }), { ok: false, reason: "drained" });
  // Owned work and housekeeping continue through a ticket drain.
  assert.equal(store.start({ ...offer(mobile, "1", "verifier"), id: "owned-2", machine: "hp", session: "s" }).ok, true);
  store.finish("hp", "s", "owned-2");
  assert.equal(store.start({ ...offer(mobile, "@reconcile", "reconcile"), id: "rec", machine: "hp", session: "s" }).ok, true);
  store.finish("hp", "s", "rec");
  // A full drain holds everything on that board, through the older manager too.
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "drained" } });
  assert.deepEqual(await grantsFor(old, mobile, "o", [offer(mobile, "1", "documentation"), offer(mobile, "@reconcile", "reconcile")]), []);
  assert.equal((await grantsFor(old, core, "c", [offer(core, "3")])).length, 1);
  // A computer-wide drain holds every board; another computer is unaffected.
  store.setDesired({ machines: ["hp"], change: { work: "drained" } });
  assert.deepEqual(store.start({ ...offer(core, "4"), id: "c4", machine: "hp", session: "c" }), { ok: false, reason: "drained" });
  assert.equal(store.start({ ...offer(core, "4"), id: "m4", machine: "mac", session: "m" }).ok, true);
  // A stopped board is drained too.
  store.setDesired({ machines: ["hp"], change: { work: "taking" } });
  store.setDesired({ machines: ["hp"], project: core, change: { run: "stopped" } });
  assert.deepEqual(store.start({ ...offer(core, "5"), id: "c5", machine: "hp", session: "c" }), { ok: false, reason: "drained" });
});

test("a lost grant reply is still recovered after a drain", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  store.reportMachineCapabilities("hp", [], [core]);
  const request = { ...offer(core, "1"), id: "g", machine: "hp", session: "s" };
  const first = store.start(request);
  assert.equal(first.ok, true);
  store.setDesired({ machines: ["hp"], change: { work: "drained" } });
  assert.deepEqual(store.start(request), first);
});

test("support tasks follow the board of the ticket they serve", () => {
  const work = (p: string) => p === mobile ? "drained" as const : "taking" as const;
  const task = { project: core, ticket: `${core}#@task-x`, role: "recovery-task", supportTaskId: "a".repeat(64), parentTicket: `${mobile}#7` };
  assert.equal(workRefusal(work, task, false), "drained");
  assert.equal(workRefusal(p => p === mobile ? "tickets-drained" : "taking", task, false), undefined);
  assert.equal(effectiveWork([{ project: "*", work: "drained", revision: 1, updated: 1, actor: "operator" }, { project: core, work: "taking", revision: 2, updated: 2, actor: "operator" }], core), "drained");
});

test("existing saved project drains are imported, not lost, and a central resume lifts them", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  store.start({ ...offer(mobile, "1"), id: "old", machine: "hp", session: "old" });
  store.finish("hp", "old", "old");
  // The configuration of a manager before this change: a persistent project drain.
  const file = configFile({ drainingProjects: [mobile], projectDrainChanges: [{ project: mobile, draining: true, at: 5 }] }); t.after(file.cleanup);
  const manager = managerFrom(file.path, client(store, "hp"));
  await manager.refreshDesired();
  const entry = store.desired.document("hp").entries.find(e => e.project === mobile);
  assert.equal(entry?.work, "tickets-drained");
  assert.equal(entry?.actor, "import");
  assert.equal(manager.work(mobile), "tickets-drained");
  // The file now carries the document; drainingProjects mirrors it for an older manager after a rollback.
  assert.deepEqual(file.read().drainingProjects, [mobile]);
  assert.ok(file.read().desiredState);
  // Same semantics as before: the owned ticket continues, a new one waits.
  assert.deepEqual((await grantsFor(manager, mobile, "s", [offer(mobile, "1", "verifier"), offer(mobile, "2")])).map(g => g.ticket), [`${mobile}#1`]);
  // The import happens once. A restart does not import again over a central resume.
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "taking" } });
  const restarted = managerFrom(file.path, client(store, "hp"));
  await restarted.refreshDesired();
  assert.equal(restarted.work(mobile), "taking");
  assert.deepEqual(file.read().drainingProjects, []);
  // The supervisor sees the resume as a recorded central change. The import changed nothing it reports.
  assert.deepEqual(file.read().projectDrainChanges.filter((c: any) => c.source === "central").map((c: any) => [c.project, c.draining]), [[mobile, false]]);
});

test("an import never loosens a stricter central state", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  store.reportMachineCapabilities("hp", [], [core, mobile]);
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "drained" } });
  const file = configFile({ drainingProjects: [mobile] }); t.after(file.cleanup);
  const manager = managerFrom(file.path, client(store, "hp"));
  await manager.refreshDesired();
  assert.equal(store.desired.work("hp", mobile), "drained");
  assert.equal(manager.work(mobile), "drained");
});

test("a claim service from before desired state leaves the older local drains in force", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  const file = configFile({ drainingProjects: [mobile] }); t.after(file.cleanup);
  const old = client(store, "hp");
  const claims = { ...old, call: async <T>(path: string, body?: any): Promise<T> => {
    if (path === "/machines/desired") throw new ServiceError(404, { error: "Unknown operation" }, "Unknown operation");
    return old.call<T>(path, body);
  } };
  const manager = managerFrom(file.path, claims);
  await manager.refreshDesired();
  assert.equal(manager.desiredStatus()?.mode, "unsupported");
  assert.equal(manager.localDrainsAllowed(), true);
  assert.equal(manager.work(mobile), "tickets-drained");
  assert.equal((await grantsFor(manager, core, "c", [offer(core, "1")])).length, 1);
});

test("acknowledgements: pending before the manager fetches, applied after, failed when it cannot save", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  store.reportMachineCapabilities("hp", [], [core, mobile]);
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "drained" } });
  const board = () => store.desired.report(store.operations.list()).find(m => m.machine === "hp")!.boards.find(b => b.project === mobile) as any;
  assert.equal(board().ack.work.state, "pending");
  assert.match(board().ack.work.reason, /never fetched/);
  const file = configFile(); t.after(file.cleanup);
  let failSave = false;
  const manager = managerFrom(file.path, client(store, "hp"), u => { if (failSave) throw new Error("read-only file system"); persistDesiredState(file.path, u); });
  await manager.refreshDesired();
  assert.deepEqual(board().ack.work, { state: "applied" });
  assert.equal(board().effectiveWork, "drained");
  failSave = true;
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "taking" } });
  await manager.refreshDesired();
  // Not saved, so not applied: the manager keeps the drain.
  assert.equal(manager.work(mobile), "drained");
  await manager.refreshDesired();
  assert.equal(board().ack.work.state, "failed");
  assert.match(board().ack.work.reason, /read-only file system/);
  failSave = false;
  await manager.refreshDesired();
  assert.equal(board().ack.work.state, "applied");
  assert.equal(manager.work(mobile), "taking");

  // Run state is acknowledged from the supervisor's operation report.
  store.setDesired({ machines: ["hp"], project: core, change: { run: "stopped" } });
  const coreBoard = () => store.desired.report(store.operations.list()).find(m => m.machine === "hp")!.boards.find(b => b.project === core) as any;
  assert.equal(coreBoard().ack.run.state, "pending");
  store.operations.record("hp", { operations: [{ project: core, phase: "draining" }] });
  assert.equal(coreBoard().ack.run.state, "pending");
  store.operations.record("hp", { operations: [{ project: core, phase: "signal-failed", reason: "Stop signal not sent: Dispatcher changed before signalling." }] });
  assert.equal(coreBoard().ack.run.state, "failed");
  store.operations.record("hp", { operations: [{ project: core, phase: "stopped", reason: "Stopped as desired." }] });
  assert.equal(coreBoard().ack.run.state, "applied");
});

test("attention lists changes that stay unapplied past the grace period", async t => {
  let now = 1_000_000;
  const store = new FleetStore(":memory:", limits, { now: () => now }); t.after(() => store.close());
  store.reportMachineCapabilities("mac", [], [core]);
  store.setDesired({ machines: ["mac"], change: { work: "drained" } });
  assert.deepEqual(store.desired.attention(store.operations.list()), []);
  now += 3 * 60_000;
  const items = store.desired.attention(store.operations.list());
  assert.equal(items.length, 1);
  assert.equal(items[0].machine, "mac");
  assert.equal(items[0].state, "pending");
});

test("operator commands: only the operator credential, only configured computers and served projects", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  const server = await serveFleet(store, { hp: "hp-fixture", mac: "mac-fixture" }, "admin-fixture", 0);
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const admin = new JsonClient(url, "admin-fixture"), hp = new JsonClient(url, "hp-fixture"), mac = new JsonClient(url, "mac-fixture");
  // A machine credential cannot set desired state, even its own.
  await assert.rejects(hp.call("/desired/set", { machines: ["hp"], change: { work: "taking" } }), /403/);
  await assert.rejects(admin.call("/desired/set", { machines: ["nas"], change: { work: "drained" } }), /Unknown machine/);
  // Projects come from the computer's own report; before it, project commands are refused.
  await assert.rejects(admin.call("/desired/set", { machines: ["hp"], project: core, change: { run: "stopped" } }), /has not reported/);
  await hp.call("/machines/desired", { projects: [core, mobile], appliedRevision: null });
  await mac.call("/machines/desired", { projects: [core], appliedRevision: null });
  await assert.rejects(admin.call("/desired/set", { machines: ["hp"], project: "org/other", change: { run: "stopped" } }), /does not serve/);
  await assert.rejects(admin.call("/desired/set", { machines: ["hp"], change: { run: "stopped" } }), /name a project/);
  await assert.rejects(admin.call("/desired/set", { machines: ["hp"], change: { work: "drained", run: "stopped" } }), /exactly one/);
  await assert.rejects(admin.call("/desired/set", { machines: ["hp"], change: { work: "rm -rf" } }), /exactly one/);
  await assert.rejects(admin.call("/desired/set", { machines: ["hp"], change: { work: "drained", command: "x" } }), /exactly one/);
  // --all-machines skips computers that do not serve the project.
  const stopped = await admin.call<any>("/desired/set", { machines: "all", project: mobile, change: { run: "stopped" } });
  assert.deepEqual(stopped.changed.map((c: any) => c.machine), ["hp"]);
  assert.deepEqual(stopped.skipped, ["mac"]);
  // Repeating a change does not bump the revision.
  const again = await admin.call<any>("/desired/set", { machines: "all", project: mobile, change: { run: "stopped" } });
  assert.deepEqual(again.unchanged, ["hp"]);
  // A computer reads only its own document.
  const doc = await mac.call<any>("/machines/desired", { projects: [core], appliedRevision: 0 });
  assert.equal(doc.machine, "mac");
  assert.deepEqual(doc.entries, []);
  const report = await mac.call<any>("/desired");
  assert.equal(report.machines.find((m: any) => m.machine === "hp").boards.find((b: any) => b.project === mobile).desired.run, "stopped");
});

test("operator command arguments", () => {
  assert.equal(parseDesiredCommand("drain", []), undefined);
  assert.deepEqual(parseDesiredCommand("drain", ["--machine", "mac"]), { machines: ["mac"], change: { work: "drained" } });
  assert.deepEqual(parseDesiredCommand("drain", ["--all-machines", "--project", core, "--tickets", "--reason", "rollout"]), { machines: "all", project: core, change: { work: "tickets-drained" }, reason: "rollout" });
  assert.deepEqual(parseDesiredCommand("drain", ["--machine", "hp", "--tickets", "--loosen"]), { machines: ["hp"], change: { work: "tickets-drained" }, loosen: true });
  assert.deepEqual(parseDesiredCommand("resume", ["--machine", "hp", "--project", core]), { machines: ["hp"], project: core, change: { work: "taking" } });
  assert.deepEqual(parseDesiredCommand("stop", ["--machine", "hp", "--project", mobile]), { machines: ["hp"], project: mobile, change: { run: "stopped" } });
  assert.deepEqual(parseDesiredCommand("start", ["--all-machines", "--project", mobile]), { machines: "all", project: mobile, change: { run: "running" } });
  for (const [command, args] of [["stop", ["--machine", "hp"]], ["start", ["--all-machines"]], ["drain", ["--machine", "hp", "--all-machines"]], ["resume", ["--project", core]],
    ["resume", ["--machine", "hp", "--tickets"]], ["resume", ["--machine", "hp", "--loosen"]], ["drain", ["--machine"]], ["drain", ["--machine", "hp", "--exec", "sh"]], ["drain", ["--machine", "hp", "--project", "core"]]] as const) {
    assert.throws(() => parseDesiredCommand(command, args), /./, `${command} ${args.join(" ")}`);
  }
});

test("a manager with central desired state refuses the older local project drain command", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  const file = configFile(); t.after(file.cleanup);
  const manager = managerFrom(file.path, client(store, "hp"));
  await manager.refreshDesired();
  const dir = mkdtempSync(join(tmpdir(), "desired-sock-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socket = join(dir, "manager.sock");
  const server = await serveManager(manager, { [core]: "core-fixture", [mobile]: "mobile-fixture" }, "local-admin", socket, "127.0.0.1", () => { throw new Error("must not save"); });
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); });
  const local = new JsonClient(`unix://${socket}`, "local-admin");
  await assert.rejects(local.call("/project-drain", { project: mobile, draining: true }), /central/);
  const status = await local.call<any>("/state");
  assert.equal(status.desiredState.mode, "central");
  assert.equal(status.projects.find((p: any) => p.project === mobile).work, "taking");
});

test("the documented schema matches what the claim service creates, so a rollout can seed it first", t => {
  const dir = mkdtempSync(join(tmpdir(), "desired-seed-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "claims.sqlite");
  // Seed today's in-memory drains before the claim service ever runs this change.
  const db = new DatabaseSync(database);
  db.exec(DESIRED_STATE_SCHEMA);
  db.prepare("INSERT INTO fleet_desired_state VALUES (?,?,?,?,?,?,?,?)").run("hp", "*", "drained", null, 1, 1, "operator", "seeded at rollout");
  db.prepare("INSERT INTO fleet_desired_revisions VALUES (?,?)").run("hp", 1);
  db.close();
  const store = new FleetStore(database, limits);
  t.after(() => store.close());
  assert.equal(store.desired.work("hp", core), "drained");
  assert.deepEqual(store.start({ ...offer(core, "1"), id: "x", machine: "hp", session: "s" }), { ok: false, reason: "drained" });
});

test("a drain an older manager saved after a rollback is imported on roll-forward, and holds meanwhile", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  const file = configFile(); t.after(file.cleanup);
  let up = true;
  await managerFrom(file.path, client(store, "hp", () => up)).refreshDesired();
  // Rolled back: the older manager's drain-project writes drainingProjects and leaves desiredState in place.
  writeFileSync(file.path, JSON.stringify({ ...file.read(), drainingProjects: [mobile] }));
  up = false;
  const manager = managerFrom(file.path, client(store, "hp", () => up));
  await manager.refreshDesired();
  assert.equal(manager.desiredStatus()?.mode, "cached");
  assert.equal(manager.work(mobile), "tickets-drained");
  up = true;
  await manager.refreshDesired();
  assert.equal(store.desired.work("hp", mobile), "tickets-drained");
  assert.equal(manager.work(mobile), "tickets-drained");
  assert.deepEqual(file.read().drainingProjects, [mobile]);
});

test("a saved import is not sent again after a failed save, so a later resume holds", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  const file = configFile({ drainingProjects: [mobile] }); t.after(file.cleanup);
  let failSave = true;
  const manager = managerFrom(file.path, client(store, "hp"), u => { if (failSave) throw new Error("disk full"); persistDesiredState(file.path, u); });
  await manager.refreshDesired();
  assert.equal(store.desired.work("hp", mobile), "tickets-drained");
  // Not saved: still nothing granted, since no document is known.
  assert.equal(manager.desiredKnown(), false);
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "taking" } });
  failSave = false;
  await manager.refreshDesired();
  assert.equal(store.desired.work("hp", mobile), "taking");
  assert.equal(manager.work(mobile), "taking");
});

test("a claims database that goes back in revision cannot lift a saved drain or stop", async t => {
  let store = new FleetStore(":memory:", limits);
  const file = configFile(); t.after(file.cleanup);
  const claims = () => client(store, "hp");
  let manager = managerFrom(file.path, claims());
  await manager.refreshDesired();
  store.setDesired({ machines: ["hp"], change: { work: "drained" } });
  store.setDesired({ machines: ["hp"], project: core, change: { run: "stopped" } });
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "tickets-drained" } });
  await manager.refreshDesired();
  const applied = manager.desiredStatus()!.appliedRevision!;
  assert.ok(applied >= 3);
  // Replaced by an empty database, as when a backup from before the change is restored.
  store.close();
  store = new FleetStore(":memory:", limits);
  t.after(() => store.close());
  // Before the manager's next fetch, an operator change for it is refused rather than overriding its saved state.
  store.desired.poll("hp", { projects: [core, mobile], appliedRevision: applied });
  assert.throws(() => store.setDesired({ machines: ["hp"], project: mobile, change: { work: "taking" } }), /newer desired state/);
  manager = managerFrom(file.path, claims());
  await manager.refreshDesired();
  // The fetch merged the saved state back in: nothing was lifted.
  assert.equal(store.desired.work("hp", core), "drained");
  assert.equal(store.desired.document("hp").entries.find(e => e.project === core)?.run, "stopped");
  assert.equal(store.desired.document("hp").entries.find(e => e.project === MACHINE_SCOPE_NAME)?.actor, "restore-merge");
  assert.ok(store.desired.document("hp").revision > applied);
  assert.equal(manager.work(core), "drained");
  assert.equal(manager.work(mobile), "drained");
  assert.equal(manager.desiredStatus()?.projects[core].run, "stopped");
  // From here operator changes apply as usual.
  store.setDesired({ machines: ["hp"], change: { work: "taking" } });
  await manager.refreshDesired();
  assert.equal(manager.work(mobile), "tickets-drained");
  assert.equal(manager.work(core), "drained");
});

test("a restore and a rollback drain together: the import cannot carry the older document past the saved one", async t => {
  let store = new FleetStore(":memory:", limits);
  const file = configFile(); t.after(file.cleanup);
  await managerFrom(file.path, client(store, "hp")).refreshDesired();
  store.reportMachineCapabilities("hp", [], [core, mobile]);
  store.setDesired({ machines: ["hp"], project: core, change: { run: "stopped" } });
  await managerFrom(file.path, client(store, "hp")).refreshDesired();
  // Restored claims database, and an older manager's drain-project during the rollback.
  store.close();
  store = new FleetStore(":memory:", limits);
  t.after(() => store.close());
  writeFileSync(file.path, JSON.stringify({ ...file.read(), drainingProjects: [core, mobile] }));
  const manager = managerFrom(file.path, client(store, "hp"));
  await manager.refreshDesired();
  assert.equal(store.desired.document("hp").entries.find(e => e.project === core)?.run, "stopped");
  assert.equal(store.desired.work("hp", mobile), "tickets-drained");
  assert.equal(manager.work(core), "drained");
  assert.equal(manager.work(mobile), "tickets-drained");
});

test("a local drain made while the claim service predates desired state is imported after its upgrade", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  const file = configFile(); t.after(file.cleanup);
  let old = true;
  const real = client(store, "hp");
  const claims = { ...real, call: async <T>(path: string, body?: any): Promise<T> => {
    if (path === "/machines/desired" && old) throw new ServiceError(404, { error: "Unknown operation" }, "Unknown operation");
    return real.call<T>(path, body);
  } };
  const manager = managerFrom(file.path, claims);
  await manager.refreshDesired();
  assert.equal(manager.desiredStatus()?.mode, "unsupported");
  await manager.setProjectDraining(mobile, true, (projects, changes) => persistDesiredStateLegacy(file.path, projects, changes));
  old = false;
  await manager.refreshDesired();
  assert.equal(store.desired.work("hp", mobile), "tickets-drained");
  assert.equal(manager.work(mobile), "tickets-drained");
  assert.deepEqual(await grantsFor(manager, mobile, "s", [offer(mobile, "9")]), []);
});

test("a drain command never loosens a stricter drain without --loosen", async t => {
  const store = new FleetStore(":memory:", limits); t.after(() => store.close());
  store.reportMachineCapabilities("hp", [], [core, mobile]);
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "drained" } });
  const result = store.setDesired({ machines: ["hp"], project: mobile, change: { work: "tickets-drained" } });
  assert.deepEqual(result.unchanged, ["hp"]);
  assert.match(result.notes.join(" "), /already drained/);
  assert.equal(store.desired.work("hp", mobile), "drained");
  store.setDesired({ machines: ["hp"], project: mobile, change: { work: "tickets-drained" }, loosen: true });
  assert.equal(store.desired.work("hp", mobile), "tickets-drained");
  // A computer-wide resume names the boards still held by their own entries.
  store.setDesired({ machines: ["hp"], change: { work: "drained" } });
  assert.match(store.setDesired({ machines: ["hp"], change: { work: "taking" } }).notes.join(" "), /still holds back org\/mobile/);
});
