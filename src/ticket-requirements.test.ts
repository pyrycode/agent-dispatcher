// Ticket requirements (2026-10-15): `requires:macos`, `requires:linux` and
// `requires:android-device` hold every stage of a ticket to a computer that
// advertises the capability. Desktop #1983 failed only on macOS and was owned
// by a Linux builder that could not reproduce it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetStore, type FleetSnapshot, type StartRequest } from "./fleet-store.js";
import { scheduleMachine, type WorkOffer } from "./machine-scheduler.js";
import { MachineManager } from "./machine-manager.js";
import { serveFleet, FleetClient } from "./fleet-http.js";
import { labelColor } from "./label-colors.js";
import {
  capabilityAttention, machineCapabilities, missingCapabilities, osCapability, osRequirementToDrop,
  ticketRequirements, validateCapabilityReport, CAPABILITY_REPORT_FRESH_MS,
} from "./ticket-requirements.js";
import { recordFlakyTests, flakyMarker, failureTicketLabels, type FlakyRunContext, type FlakyTicketClient } from "./flaky-tickets.js";
import { recordInheritedTests, type InheritedTicketClient } from "./inherited-tickets.js";
import { buildMainSweepIssue, mainSweepIssueLabels, type MainSweepOutcome } from "./main-sweep.js";
import type { WorkflowItem } from "./workflow-store.js";

// ---------- Labels and capabilities ----------

test("the operating system is detected and the configuration adds only hardware", () => {
  assert.equal(osCapability("darwin"), "macos");
  assert.equal(osCapability("linux"), "linux");
  assert.equal(osCapability("win32"), undefined);
  assert.deepEqual(machineCapabilities(undefined, "linux"), ["linux"]);
  assert.deepEqual(machineCapabilities(["android-device"], "darwin"), ["android-device", "macos"]);
  assert.deepEqual(machineCapabilities(["android-device", "android-device"], "darwin"), ["android-device", "macos"]);
  for (const bad of [["macos"], ["linux"], ["gpu"], "android-device", [1]]) {
    assert.throws(() => machineCapabilities(bad, "linux"), /operating system is detected/, JSON.stringify(bad));
  }
});

test("a ticket's requirements come from its requires: labels, unknown names included", () => {
  assert.deepEqual(ticketRequirements(["bug", "requires:macos", "priority:low", "requires:macos"]), ["macos"]);
  assert.deepEqual(ticketRequirements(["requires:android-device", "requires:macos"]), ["android-device", "macos"]);
  assert.deepEqual(ticketRequirements(["requires:gpu"]), ["gpu"], "no computer offers it, so it waits visibly");
  assert.deepEqual(ticketRequirements(["requires:", "required:macos"]), []);
  assert.deepEqual(missingCapabilities(["android-device", "macos"], ["macos"]), ["android-device"]);
  assert.deepEqual(missingCapabilities(["linux"], undefined), ["linux"]);
});

test("capability reports accept only known capabilities", () => {
  assert.deepEqual(validateCapabilityReport(["macos", "android-device", "macos"]), ["android-device", "macos"]);
  assert.deepEqual(validateCapabilityReport([]), []);
  for (const bad of [undefined, "macos", ["gpu"], [null]]) assert.throws(() => validateCapabilityReport(bad), /Invalid machine capabilities/);
});

test("requires: labels get their own colour", () => {
  assert.equal(labelColor("requires:macos"), "5C3D1E");
  assert.equal(labelColor("requires:android-device"), "5C3D1E");
});

test("a second operating system drops only the other system's requirement", () => {
  assert.equal(osRequirementToDrop(["bug", "requires:linux"], "darwin"), "requires:linux");
  assert.equal(osRequirementToDrop(["bug", "requires:macos"], "linux"), "requires:macos");
  assert.equal(osRequirementToDrop(["requires:linux"], "linux"), undefined, "same system: still one");
  assert.equal(osRequirementToDrop(["requires:android-device"], "linux"), undefined, "hardware stays");
  assert.equal(osRequirementToDrop(["requires:linux"], "win32"), undefined);
});

// ---------- The authority ----------

const DESKTOP = "org/desktop";
const PROJECT = { project: DESKTOP, projectId: "P", statusFieldId: "S",
  options: { Inbox: "i", Backlog: "b", "In Development": "d", "In Code Review": "r", "In Documentation": "doc", Done: "done" } };
const item = (n: number, status = "In Development", labels: string[] = []): WorkflowItem => ({
  id: `P${n}`, issueId: `I${n}`, issueNumber: n, title: "t", body: "b", url: `https://github.com/${DESKTOP}/issues/${n}`,
  status, labels, blockedBy: [], parentNumber: null, grandparentNumber: null, state: "OPEN", revision: 1, position: n });
const request = (id: string, machine: string, n: number, role = "builder", resource: "heavy" | "medium" | "light" = "medium"): StartRequest =>
  ({ workflowVersion: 1, id, machine, session: `s-${machine}`, project: DESKTOP, ticket: `${DESKTOP}#${n}`, role, resource, locks: [] });

function fleet(items: WorkflowItem[]) {
  let now = 1_000_000;
  const store = new FleetStore(":memory:", {
    mac: { heavyLimit: 2, combinedLimit: 3 }, hp: { heavyLimit: 2, combinedLimit: 3 }, fractal: { heavyLimit: 2, combinedLimit: 3 },
  }, { now: () => now });
  store.workflow.import(PROJECT, items);
  return { store, advance: (ms: number) => { now += ms; }, label: (n: number, change: { addLabels?: string[]; removeLabels?: string[] }) =>
    store.workflow.change(`${DESKTOP}#${n}`, change, "operator", `c-${n}-${JSON.stringify(change)}`) };
}

test("every stage of a ticket with a requirement is admitted only where it can run", () => {
  const { store } = fleet([item(1, "Backlog", ["requires:macos"]), item(2, "In Development", ["requires:macos"]),
    item(3, "In Code Review", ["requires:macos"]), item(4, "In Development"), item(5, "In Development", ["requires:macos", "requires:android-device"]),
    item(6, "In Documentation", ["requires:macos"]), item(7, "Done", ["requires:macos"])]);
  try {
    store.reportMachineCapabilities("mac", ["macos"]);
    store.reportMachineCapabilities("hp", ["linux"]);
    for (const [id, n, role, resource] of [["r1", 1, "refiner", "light"], ["b2", 2, "builder", "medium"], ["v3", 3, "verifier", "heavy"],
      ["a1", 1, "recovery", "heavy"], ["d6", 6, "documentation", "light"], ["m7", 7, "merge", "light"]] as const) {
      const locks = role === "merge" ? [`${DESKTOP}:merge`] : [];
      assert.deepEqual(store.start({ ...request(`hp-${id}`, "hp", n, role, resource), locks }), { ok: false, reason: "incapable" }, `${role} on Linux`);
    }
    assert.equal(store.snapshot().runs.length, 0, "a refusal reserves nothing");
    assert.equal(store.start(request("hp-b4", "hp", 4)).ok, true, "no requirement: any computer, as before");
    assert.equal(store.start(request("mac-b2", "mac", 2)).ok, true);
    assert.equal(store.start(request("mac-v3", "mac", 3, "verifier", "heavy")).ok, true);
    assert.equal(store.start(request("mac-d6", "mac", 6, "documentation", "light")).ok, true);
    assert.equal(store.start({ ...request("mac-m7", "mac", 7, "merge", "light"), locks: [`${DESKTOP}:merge`] }).ok, true);
    assert.deepEqual(store.start(request("mac-b5", "mac", 5)), { ok: false, reason: "incapable" }, "the Mac lacks the configured phone");
    store.reportMachineCapabilities("mac", ["macos", "android-device"]);
    assert.equal(store.start(request("mac-b5b", "mac", 5)).ok, true);
    // A computer that never reported, such as one on an older manager, offers nothing.
    assert.deepEqual(store.start(request("fractal-b1", "fractal", 1, "refiner", "light")), { ok: false, reason: "incapable" });
    assert.throws(() => store.reportMachineCapabilities("nobody", ["linux"]), /Unknown machine/);
  } finally { store.close(); }
});

test("a requirement added after a Linux build releases the claim, and the Mac takes the next stage", () => {
  const { store, label } = fleet([item(1983, "In Development"), item(7, "In Development")]);
  try {
    store.reportMachineCapabilities("mac", ["macos"]);
    store.reportMachineCapabilities("hp", ["linux"]);
    assert.equal(store.start(request("b1", "hp", 1983)).ok, true);
    assert.equal(store.start(request("b7", "hp", 7)).ok, true);
    store.finish("hp", "s-hp", "b7");
    label(1983, { addLabels: ["requires:macos"] });
    label(7, { addLabels: ["requires:linux"] });
    // A running stage keeps its claim until it ends.
    assert.deepEqual(store.releaseIncapableClaims(), []);
    assert.deepEqual(store.snapshot().claims.map(c => [c.ticket, c.machine]), [[`${DESKTOP}#1983`, "hp"], [`${DESKTOP}#7`, "hp"]]);
    store.finish("hp", "s-hp", "b1");
    const generation = store.snapshot().claims.find(c => c.ticket === `${DESKTOP}#1983`)!.generation;
    const released = store.releaseIncapableClaims();
    assert.deepEqual(released.map(c => [c.ticket, c.machine, c.generation]), [[`${DESKTOP}#1983`, "hp", generation]]);
    const after = store.snapshot();
    assert.deepEqual(after.claims.map(c => [c.ticket, c.machine]), [[`${DESKTOP}#7`, "hp"]], "a capable owner keeps its claim");
    // Recorded as a release, so a supervised update does not latch on the vanished claim.
    assert.deepEqual(after.releasedAssessmentClaims?.map(c => [c.ticket, c.machine, c.generation]), [[`${DESKTOP}#1983`, "hp", generation]]);
    assert.deepEqual(store.releaseIncapableClaims(), [], "nothing left to release");
    // The old owner cannot take it back, and cannot write to it as an owner.
    assert.deepEqual(store.start(request("b1-again", "hp", 1983)), { ok: false, reason: "incapable" });
    // The Mac builds it under a new generation and owns it from then on.
    const started = store.start(request("mac-b1", "mac", 1983));
    assert.equal(started.ok, true);
    const claim = store.snapshot().claims.find(c => c.ticket === `${DESKTOP}#1983`)!;
    assert.equal(claim.machine, "mac");
    assert.notEqual(claim.generation, generation);
    assert.throws(() => store.authorize("hp", "s-hp", `${DESKTOP}#1983`), /another machine/);
  } finally { store.close(); }
});

test("a released ticket refined on the Mac starts no claim, and a closed ticket keeps its claim", () => {
  const { store } = fleet([item(1, "In Development")]);
  try {
    store.reportMachineCapabilities("mac", ["macos"]);
    store.reportMachineCapabilities("hp", ["linux"]);
    assert.equal(store.start(request("b1", "hp", 1)).ok, true);
    store.finish("hp", "s-hp", "b1");
    store.workflow.change(`${DESKTOP}#1`, { status: "Backlog", addLabels: ["requires:macos"] }, "operator", "back");
    assert.equal(store.releaseIncapableClaims().length, 1);
    assert.equal(store.start(request("mac-r1", "mac", 1, "refiner", "light")).ok, true);
    assert.deepEqual(store.snapshot().claims, [], "refinement starts no ownership");
    // A closed ticket's requirement no longer matters, so its claim stays.
    const { store: second, label: label2 } = fleet([item(2, "In Development")]);
    try {
      second.reportMachineCapabilities("hp", ["linux"]);
      assert.equal(second.start(request("b2", "hp", 2)).ok, true);
      second.finish("hp", "s-hp", "b2");
      second.workflow.change(`${DESKTOP}#2`, { state: "CLOSED", status: "Done" }, "operator", "close");
      label2(2, { addLabels: ["requires:macos"] });
      assert.deepEqual(second.releaseIncapableClaims(), []);
    } finally { second.close(); }
  } finally { store.close(); }
});

test("a claim is kept while only its owner can finish something, and an owner that never reported keeps its claims", () => {
  const { store, label } = fleet([item(1, "In Development"), item(2, "In Development"), item(3, "In Development"), item(4, "In Development"), item(5, "In Development")]);
  try {
    store.reportMachineCapabilities("hp", ["linux"]);
    for (const n of [1, 2, 3, 4]) { assert.equal(store.start(request(`b${n}`, "hp", n)).ok, true); store.finish("hp", "s-hp", `b${n}`); }
    // Fractal builds #5 before its manager has ever reported (an older manager during a rollout).
    assert.equal(store.start(request("b5", "fractal", 5)).ok, true);
    store.finish("fractal", "s-fractal", "b5");
    label(1, { addLabels: ["requires:macos", "pending-verdict:verifier"] });
    label(2, { addLabels: ["requires:macos", "pending-done:verifier"] });
    label(3, { addLabels: ["requires:macos", "wip:builder"] });
    label(4, { addLabels: ["requires:macos"] });
    label(5, { addLabels: ["requires:linux"] });
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare("INSERT INTO fleet_recovery_tasks (id,ticket,request,state,created,updated) VALUES (?,?,?,?,1,1)").run("t4", `${DESKTOP}#4`, "{}", "running");
    assert.deepEqual(store.releaseIncapableClaims(), [], "saved verdicts, a stranded wip label, a running support task and an unknown owner all keep the claim");
    // Once the support task ends, #4 goes.
    db.prepare("UPDATE fleet_recovery_tasks SET state='complete' WHERE id='t4'").run();
    assert.deepEqual(store.releaseIncapableClaims().map(c => c.ticket), [`${DESKTOP}#4`]);
    // Once its verdict has published, #1 goes too.
    label(1, { removeLabels: ["pending-verdict:verifier"] });
    assert.deepEqual(store.releaseIncapableClaims().map(c => c.ticket), [`${DESKTOP}#1`]);
    // Fractal reports Linux: it can run #5, so it keeps it.
    store.reportMachineCapabilities("fractal", ["linux"]);
    assert.deepEqual(store.releaseIncapableClaims(), []);
    assert.deepEqual(store.snapshot().claims.map(c => c.ticket), [`${DESKTOP}#2`, `${DESKTOP}#3`, `${DESKTOP}#5`]);
  } finally { store.close(); }
});

test("only computers serving the ticket's project count as able to run it", () => {
  const { store } = fleet([item(1, "Backlog", ["requires:macos"])]);
  try {
    store.reportMachineCapabilities("mac", ["macos"], ["org/core"]);
    store.reportMachineCapabilities("hp", ["linux"], [DESKTOP]);
    const state = store.snapshot();
    assert.deepEqual(state.noCapableMachine, [{ ticket: `${DESKTOP}#1`, requires: ["macos"], missing: ["macos"] }]);
    assert.deepEqual(state.machineCapabilities?.mac, { capabilities: ["macos"], projects: ["org/core"], updated: 1_000_000 });
    assert.match(capabilityAttention(state)[0].reason, /No computer serving org\/desktop offers macos/);
    store.reportMachineCapabilities("mac", ["macos"], ["org/core", DESKTOP]);
    assert.equal(store.snapshot().noCapableMachine, undefined);
    // A report that names no projects counts for all of them.
    store.reportMachineCapabilities("mac", ["macos"]);
    assert.equal(store.snapshot().noCapableMachine, undefined);
    assert.throws(() => store.reportMachineCapabilities("mac", ["macos"], ["not a repo"]), /Invalid machine projects/);
  } finally { store.close(); }
});

test("the snapshot lists requirements, reports and the requirements nobody fresh can satisfy", () => {
  const { store, advance, label } = fleet([item(1, "Backlog", ["requires:macos"]), item(2, "Backlog", ["requires:android-device"]),
    item(3, "Backlog"), item(4, "Backlog", ["requires:gpu"])]);
  try {
    assert.equal(store.snapshot().machineCapabilities, undefined, "absent before any report");
    store.reportMachineCapabilities("hp", ["linux"]);
    advance(1000);
    store.reportMachineCapabilities("mac", ["macos", "android-device"]);
    let state = store.snapshot();
    assert.deepEqual(state.ticketRequirements, { [`${DESKTOP}#1`]: ["macos"], [`${DESKTOP}#2`]: ["android-device"], [`${DESKTOP}#4`]: ["gpu"] });
    assert.deepEqual(state.machineCapabilities, { hp: { capabilities: ["linux"], updated: 1_000_000 }, mac: { capabilities: ["android-device", "macos"], updated: 1_001_000 } });
    assert.deepEqual(state.noCapableMachine, [{ ticket: `${DESKTOP}#4`, requires: ["gpu"], missing: ["gpu"] }]);
    // The Mac's manager stops reporting: its tickets have nowhere to run.
    advance(CAPABILITY_REPORT_FRESH_MS);
    store.reportMachineCapabilities("hp", ["linux"]);
    state = store.snapshot();
    assert.deepEqual(state.noCapableMachine?.map(g => g.ticket), [`${DESKTOP}#1`, `${DESKTOP}#2`, `${DESKTOP}#4`]);
    const attention = capabilityAttention(state);
    assert.match(attention[0].reason, /mac did earlier; check that its manager is running/);
    assert.match(attention[2].reason, /No computer serving org\/desktop offers gpu\. Configure one, or remove the requires: label/);
    // A stale report still admits: capabilities do not change while a computer is away.
    assert.equal(store.start(request("mac-r1", "mac", 1, "refiner", "light")).ok, true);
    // Removing the label ends the requirement.
    label(4, { removeLabels: ["requires:gpu"] });
    assert.equal(store.snapshot().ticketRequirements?.[`${DESKTOP}#4`], undefined);
  } finally { store.close(); }
});

test("a combination split across two computers is not satisfied", () => {
  const { store } = fleet([item(1, "Backlog", ["requires:linux", "requires:android-device"])]);
  try {
    store.reportMachineCapabilities("hp", ["linux"]);
    store.reportMachineCapabilities("mac", ["macos", "android-device"]);
    assert.deepEqual(store.snapshot().noCapableMachine, [{ ticket: `${DESKTOP}#1`, requires: ["android-device", "linux"], missing: [] }]);
  } finally { store.close(); }
});

test("only a known computer reports its own capabilities over the network", async t => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 }, hp: { heavyLimit: 1, combinedLimit: 1 } });
  const server = await serveFleet(store, { mac: "mac-test", hp: "hp-test" }, "operator-test", 0);
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); store.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const mac = new FleetClient(endpoint, "mac-test"), admin = new FleetClient(endpoint, "operator-test");
  await mac.call("/machines/capabilities", { capabilities: ["macos", "android-device"], machine: "hp" });
  assert.deepEqual(store.machineCapabilities().mac.capabilities, ["android-device", "macos"], "the credential names the computer, not the body");
  assert.equal(store.machineCapabilities().hp, undefined);
  await admin.call("/machines/capabilities", { machine: "hp", capabilities: ["linux"] });
  assert.deepEqual(store.machineCapabilities().hp.capabilities, ["linux"]);
  await assert.rejects(admin.call("/machines/capabilities", { machine: "nobody", capabilities: [] }), /403/);
  await assert.rejects(mac.call("/machines/capabilities", { capabilities: ["gpu"] }), /409/);
});

// ---------- The scheduler and manager ----------

const offer = (n: number, role = "builder", resource: "heavy" | "medium" | "light" = "medium"): WorkOffer =>
  ({ workflowVersion: 1, project: DESKTOP, ticket: `${DESKTOP}#${n}`, role, resource, locks: [], key: `${role}-${n}`, order: n });

test("the scheduler passes over a ticket it cannot run, so other work starts", () => {
  const state: FleetSnapshot = { claims: [], runs: [], ticketRequirements: { [`${DESKTOP}#1`]: ["macos"] } };
  const schedule = (capabilities: string[] | undefined) => scheduleMachine({ machine: "hp", projects: [DESKTOP], offers: [offer(1), offer(2)],
    state, heavyLimit: 1, combinedLimit: 1, ticketLimit: 5, capabilities }).map(o => o.ticket);
  assert.deepEqual(schedule(["linux"]), [`${DESKTOP}#2`]);
  assert.deepEqual(schedule(["macos"]), [`${DESKTOP}#1`]);
  assert.deepEqual(schedule(undefined), [`${DESKTOP}#2`], "a manager with no capabilities runs only unrestricted tickets");
  // Shared jobs and support tasks are not ticket stages.
  const shared: WorkOffer = { ...offer(0, "reconcile", "light"), ticket: `${DESKTOP}#@reconcile`, key: "reconcile", locks: [`${DESKTOP}:reconcile`] };
  assert.deepEqual(scheduleMachine({ machine: "hp", projects: [DESKTOP], offers: [shared], state: { ...state, ticketRequirements: { [`${DESKTOP}#@reconcile`]: ["macos"] } },
    heavyLimit: 1, combinedLimit: 1, capabilities: ["linux"] }).length, 1);
});

test("the manager reports its capabilities, shows why a ticket waits and starts only what it can run", async () => {
  const { store, advance } = fleet([item(1, "In Development", ["requires:macos"]), item(2, "In Development"), item(3, "In Development", ["requires:android-device"])]);
  try {
    const client = { snapshot: async () => store.snapshot(), start: async (r: StartRequest) => store.start(r), finish: async () => {},
      call: async <T>(path: string, body?: any): Promise<T> => {
        assert.equal(path, "/machines/capabilities");
        assert.deepEqual(body.projects, [DESKTOP]);
        return store.reportMachineCapabilities("hp", body.capabilities, body.projects) as T;
      } };
    const manager = new MachineManager({ machine: "hp", heavyLimit: 1, combinedLimit: 2, ticketLimit: 5, projects: [DESKTOP], capabilities: ["linux", "linux"] }, client);
    assert.deepEqual(manager.config.capabilities, ["linux"]);
    await manager.reportCapabilities();
    store.reportMachineCapabilities("mac", ["macos"]);
    manager.offer(DESKTOP, "d", [offer(1), offer(2), offer(3)]);
    const status = await manager.status();
    assert.deepEqual(status.capabilities, ["linux"]);
    assert.deepEqual(Object.fromEntries(status.queue.map(q => [q.ticket, q.state])),
      { [`${DESKTOP}#1`]: "missing-capability", [`${DESKTOP}#2`]: "eligible", [`${DESKTOP}#3`]: "no-capable-machine" });
    await manager.tick();
    assert.deepEqual(store.snapshot().runs.map(r => r.ticket), [`${DESKTOP}#2`]);
    // The Mac goes quiet: its ticket now has nowhere to run either.
    advance(CAPABILITY_REPORT_FRESH_MS);
    await manager.reportCapabilities();
    assert.equal((await manager.status()).queue.find(q => q.ticket === `${DESKTOP}#1`)!.state, "no-capable-machine");
    assert.throws(() => new MachineManager({ machine: "hp", heavyLimit: 1, combinedLimit: 1, projects: [DESKTOP], capabilities: ["gpu"] }, client), /Invalid machine capabilities/);
  } finally { store.close(); }
});

// ---------- Tickets the pipeline files ----------

const run: FlakyRunContext = { gatedIssue: 1936, at: "2026-10-15T08:00:00Z", report: {
  branchName: "feature/1936", headSha: "a".repeat(40), baseRef: "origin/main", baseSha: "b".repeat(40),
  outputPath: "/logs/live.log", rerunOutputPath: "/logs/rerun.log", baselineOutputPath: "/logs/base.log",
} as FlakyRunContext["report"] };
const NAME = "desktop.e2e#mute toggles";

class Board implements FlakyTicketClient, InheritedTicketClient {
  open: { number: number; nodeId: string; title?: string; body: string; labels?: string[] }[] = [];
  created: { title: string; body: string; labels: string[] }[] = [];
  comments: { issue: number; body: string }[] = [];
  removed: { issue: number; label: string }[] = [];
  async listOpenIssuesWithLabel() { return this.open.map(i => ({ ...i, labels: [...(i.labels ?? [])] })); }
  async createIssue(title: string, body: string, labels: string[] = []) {
    this.created.push({ title, body, labels });
    const number = 2000 + this.created.length;
    this.open.push({ number, nodeId: `n${number}`, title, body, labels });
    return { number, nodeId: `n${number}`, url: "u" };
  }
  async addItemToProject(nodeId: string) { return nodeId; }
  async updateItemStatus() {}
  async getItemStatus() { return "Backlog"; }
  async moveItemToTop() {}
  async addBlocker() {}
  async addComment(issue: number, body: string) { this.comments.push({ issue, body }); }
  async removeLabel(issue: number, label: string) { this.removed.push({ issue, label }); }
}

test("a flaky test ticket requires the system it flaked on, until it flakes on another", async () => {
  const board = new Board();
  await recordFlakyTests(board, [NAME], run, "darwin");
  assert.deepEqual(board.created[0].labels, ["bug", "flaky-test", "priority:low", "requires:macos"]);
  assert.match(board.created[0].body, /- Seen on macOS/);
  await recordFlakyTests(board, [NAME], run, "darwin");
  assert.deepEqual(board.removed, [], "the same system again: still one system");
  assert.match(board.comments[0].body, /- Seen on macOS/);
  await recordFlakyTests(board, [NAME], run, "linux");
  assert.deepEqual(board.removed, [{ issue: 2001, label: "requires:macos" }]);
  assert.match(board.comments[1].body, /- Seen on Linux/);
  assert.equal(board.created.length, 1);
  assert.deepEqual(failureTicketLabels(["bug"], "win32"), ["bug"], "an unknown system adds no requirement");
});

test("a failed requirement removal is logged and the sighting still counts", async t => {
  const board = new Board();
  board.open.push({ number: 5, nodeId: "n5", body: flakyMarker(NAME), labels: ["requires:linux"] });
  board.removeLabel = async () => { throw new Error("owned elsewhere"); };
  const warn = t.mock.method(console, "warn", () => {});
  const result = await recordFlakyTests(board, [NAME], run, "darwin");
  assert.deepEqual(result, { filed: [], commented: [{ name: NAME, issue: 5 }], untracked: [] });
  assert.ok(warn.mock.calls.some(c => /Could not remove requires:linux from #5: owned elsewhere/.test(String(c.arguments[0]))));
  assert.deepEqual(board.open[0].labels, ["requires:linux"], "the label stays");
});

test("a shared live failure ticket requires its system, and drops it only on its own ticket", async () => {
  const board = new Board();
  await recordInheritedTests(board, [NAME], run, {}, "linux");
  assert.deepEqual(board.created[0].labels, ["bug", "priority:low", "requires:linux"]);
  assert.match(board.created[0].body, /- Seen on Linux/);
  await recordInheritedTests(board, [NAME], run, {}, "darwin");
  assert.deepEqual(board.removed, [{ issue: 2001, label: "requires:linux" }]);
  assert.match(board.comments[0].body, /Shared failure seen again[\s\S]*- Seen on macOS/);
  // A person's bug ticket matched by the test's name keeps the requirement they chose.
  const own = new Board();
  own.open.push({ number: 1983, nodeId: "n1983", title: "flaky mute test", body: `\`${NAME}\` fails with HTTP 400`, labels: ["bug", "requires:macos"] });
  await recordInheritedTests(own, [NAME], run, {}, "linux");
  assert.equal(own.created.length, 0);
  assert.equal(own.comments[0].issue, 1983);
  assert.deepEqual(own.removed, []);
});

test("a main sweep failure ticket requires the system the suite failed on", () => {
  const outcome = (runError: string | null): MainSweepOutcome => ({ passed: false, exitCode: 1, timedOut: false, durationMs: 1000,
    stdoutPath: "/o", stderrPath: "/e", failedNames: ["p.C#a"], runError, stderrTail: "" } as unknown as MainSweepOutcome);
  assert.deepEqual(mainSweepIssueLabels(outcome(null), "darwin"), ["bug", "priority:low", "requires:macos"]);
  assert.deepEqual(mainSweepIssueLabels(outcome("spawn failed"), "linux"), ["bug", "priority:low"], "a sweep that could not start proves nothing about the system");
  const { body } = buildMainSweepIssue({ repo: DESKTOP, head: "c".repeat(40), lastGoodSha: null, mergeSubjects: [], command: "pnpm e2e", outcome: outcome(null), platform: "linux" });
  assert.match(body, /- Seen on Linux/);
});
