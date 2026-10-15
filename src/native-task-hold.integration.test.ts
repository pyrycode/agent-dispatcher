import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { FleetStore } from "./fleet-store.js";
import { FleetClient, JsonClient, serveFleet } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { ManagedDispatch, managedBridgeActions, managedRequestedTasks, managedTaskEnv, managedTicketTasks } from "./managed-dispatch.js";
import { NATIVE_TASK_HOLD_LABEL, decideHandoverHold, newNativeTaskHoldState, runNativeTaskHolds } from "./native-task-hold.js";
import { taskBridge } from "./recovery-task-bridge.js";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../scripts/fleet-task.py", import.meta.url));
const url = (server: Server) => {
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("Server did not listen");
  return `http://127.0.0.1:${a.port}`;
};
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const BOUND = 4 * 3_600_000;

test("every role reads and awaits its own ticket's native task, only builders request, and a builder's open task holds the handover without a place", async t => {
  const store = new FleetStore(":memory:", { box: { heavyLimit: 1, combinedLimit: 3 }, mac: { heavyLimit: 1, combinedLimit: 2 } });
  const claims = await serveFleet(store, { box: "box-token", mac: "mac-token" }, "admin-token", 0);
  const manager = new MachineManager({ machine: "box", heavyLimit: 1, combinedLimit: 3, projects: ["org/core"] }, new FleetClient(url(claims), "box-token"));
  const local = await serveManager(manager, { "org/core": "project-token" }, "operator-token", 0);
  const managed = new ManagedDispatch("org/core", { GITHUB_OWNER: "org", GITHUB_REPO: "core", PYRY_MANAGER_URL: url(local), PYRY_MANAGER_TOKEN: "project-token" });
  const directory = mkdtempSync(join(tmpdir(), "native-task-reads-"));
  t.after(async () => { await managed.stop(); await close(local); await close(claims); store.close(); rmSync(directory, { recursive: true, force: true }); });
  await managed.start();

  const asRole = async <T>(issue: number, role: string, resource: "light" | "medium", work: () => Promise<T>): Promise<T> => {
    managed.beginCycle();
    const offer = managed.offer(issue, role, resource);
    await managed.endCycle(); await manager.tick(); await managed.sync();
    assert.equal(managed.ready(offer), true, role);
    return managed.run(offer, work);
  };
  const helperEnv = () => ({ PATH: process.env.PATH, PYRY_TASK_SOCKET: managedTaskEnv().PYRY_TASK_SOCKET });
  const call = async (...args: string[]) => JSON.parse((await execute("python3", [helper, ...args], { env: helperEnv() })).stdout);
  const request = { recipe: "platform-probe", capability: "macos-arm64", reason: "Native acceptance on the Mac" };
  const requestFile = join(directory, "request.json");
  writeFileSync(requestFile, JSON.stringify(request));
  // Another ticket's task, which no run of #40 may read.
  const foreign = store.tasks.request("org/core#41", request as any, "other-run");

  // The builder requests a check and ends before it finishes.
  const requested = await asRole(40, "builder", "medium", async () => {
    assert.deepEqual(managedBridgeActions(), { request: true, read: true, evidence: false });
    const task = await call("request", requestFile);
    assert.equal(task.state, "queued");
    assert.deepEqual(managedRequestedTasks(), [task.id], "the socket records what this run asked for");
    const decision = decideHandoverHold(managedRequestedTasks(), await managedTicketTasks(), Date.now(), BOUND);
    assert.deepEqual(decision.held.map(h => h.id), [task.id], "an open requested task holds the handover");
    await assert.rejects(call("read", foreign.id), /outside this admitted ticket/);
    return task;
  });
  // The builder's place is free: the hold is a label, not a run.
  assert.equal(store.snapshot().runs.some(r => r.ticket === "org/core#40"), false, "no run holds capacity for the held ticket");
  assert.equal(store.tasks.get(requested.id).state, "queued");

  // The reconcile pass keeps the hold while the task is open.
  const items = [{ issueNumber: 40, labels: [NATIVE_TASK_HOLD_LABEL] }];
  const removed: number[] = [];
  const comments: string[] = [];
  const holdClient = {
    getAllProjectItems: async () => items.map(i => ({ ...i, labels: [...i.labels] })),
    removeLabel: async (n: number, label: string) => { removed.push(n); items[0].labels = items[0].labels.filter(l => l !== label); },
    addComment: async (_n: number, body: string) => { comments.push(body); },
    clearItemsCache: () => {},
  };
  const holds = newNativeTaskHoldState();
  const readTasks = (n: number) => managed.ticketTasks(`org/core#${n}`);
  await runNativeTaskHolds({ client: holdClient, readTasks, state: holds, boundMs: BOUND });
  assert.deepEqual(removed, [], "still queued: the hold stays");

  // While the task is open the claim service admits no stage on the ticket
  // (FleetStore.startAdmitted), which is what started #1998's verifier only
  // at 13:00. Unchanged by the hold.
  managed.beginCycle();
  const early = managed.offer(40, "verifier", "light");
  await managed.endCycle(); await manager.tick(); await managed.sync();
  assert.equal(managed.ready(early), false, "no verifier while the builder's task is open");
  managed.beginCycle(); await managed.endCycle();

  // The Mac runs the check.
  store.tasks.report("mac", { capabilities: ["macos-arm64"], ready: true });
  assert.equal(store.taskStart("mac", requested.id, "native").ok, true);
  await runNativeTaskHolds({ client: holdClient, readTasks, state: holds, boundMs: BOUND });
  assert.deepEqual(removed, [], "still running: the hold stays");
  store.taskComplete("mac", requested.id, "native", { outcome: "completed", summary: "Platform route available: 429 executed, 429 passed", files: { "probe.txt": "ok\n" } });

  // The hold lifts once the task has finished.
  await runNativeTaskHolds({ client: holdClient, readTasks, state: holds, boundMs: BOUND });
  assert.deepEqual(removed, [40]);
  assert.match(comments[0], /Every native task this ticket was waiting for has finished/);
  assert.match(comments[0], /429 executed, 429 passed/);

  // A verifier reads and awaits the ticket's task, and cannot request one or read another ticket's.
  await asRole(40, "verifier", "light", async () => {
    assert.deepEqual(managedBridgeActions(), { request: false, read: true, evidence: false });
    assert.equal((await call("read", requested.id)).state, "complete");
    assert.equal((await call("await", requested.id)).result.summary, "Platform route available: 429 executed, 429 passed");
    await assert.rejects(call("request", requestFile), /Native check requests are for builder and developer runs/);
    await assert.rejects(call("read", foreign.id), /outside this admitted ticket/);
    await assert.rejects(call("await", foreign.id, "--timeout", "0"), /outside this admitted ticket/);
    assert.deepEqual(managedRequestedTasks(), [], "a refused request records nothing");
  });

  // Documentation awaits and downloads the finished result.
  await asRole(40, "documentation", "light", async () => {
    assert.deepEqual(managedBridgeActions(), { request: false, read: true, evidence: false });
    const out = join(directory, "doc-result");
    const finished = await call("await", requested.id, "--out", out);
    assert.equal(finished.state, "complete");
    assert.equal(readFileSync(join(out, "probe.txt"), "utf8"), "ok\n");
    await assert.rejects(call("request", requestFile), /Native check requests are for builder and developer runs/);
    await assert.rejects(call("read", foreign.id), /outside this admitted ticket/);
    const listed = await managedTicketTasks();
    assert.deepEqual(listed?.map(task => [task.id, task.state]), [[requested.id, "complete"]], "the prompt's task list is this ticket's only");
  });
  assert.equal(store.tasks.list("org/core#40").length, 1, "no reading role created a task");
});

test("the claim service refuses a read from a run whose ticket is not the task's, whatever the socket allows", async t => {
  const store = new FleetStore(":memory:", { box: { heavyLimit: 1, combinedLimit: 2 } });
  t.after(() => store.close());
  assert.equal(store.start({ id: "verifier-40", machine: "box", session: "s", project: "org/core", ticket: "org/core#40", role: "verifier", resource: "light", locks: [] }).ok, true);
  const own = store.tasks.request("org/core#40", { recipe: "platform-probe", capability: "macos-arm64", reason: "own" }, "builder-run");
  const other = store.tasks.request("org/core#41", { recipe: "platform-probe", capability: "macos-arm64", reason: "other" }, "builder-run");
  assert.equal(store.readTask("box", "s", "org/core", "verifier-40", own.id, "manifest-v1").id, own.id);
  assert.throws(() => store.readTask("box", "s", "org/core", "verifier-40", other.id, "manifest-v1"), /admitted source ticket/);
  assert.throws(() => store.readTaskArtifact("box", "s", "org/core", "verifier-40", other.id, "d".repeat(64), "probe.txt", 0), /admitted source ticket/);
  assert.throws(() => store.requestTask("box", "s", "org/core", "verifier-40", { recipe: "platform-probe", capability: "macos-arm64", reason: "x" }), /admitted source worker/,
    "the service also refuses a verifier's request");
});

test("a reading role's await waits for a running task of its ticket and returns its artifacts", async t => {
  const store = new FleetStore(":memory:", { box: { heavyLimit: 1, combinedLimit: 2 }, mac: { heavyLimit: 1, combinedLimit: 2 } });
  const claims = await serveFleet(store, { box: "box-token", mac: "mac-token" }, "admin-token", 0);
  const manager = new MachineManager({ machine: "box", projects: ["org/core"], heavyLimit: 1, combinedLimit: 2 }, new FleetClient(url(claims), "box-token"));
  const local = await serveManager(manager, { "org/core": "project-token" }, "operator-token", 0);
  // A documentation run admitted before the task existed, as after a hold
  // released past its bound while the task kept running.
  assert.equal(store.start({ id: "doc-40", machine: "box", session: "s", project: "org/core", ticket: "org/core#40", role: "documentation", resource: "light", locks: [] }).ok, true);
  const run = store.snapshot().runs.find(r => r.id === "doc-40")!;
  const bridge = await taskBridge(new JsonClient(url(local), "project-token"), run, { request: false, read: true, evidence: false });
  const directory = mkdtempSync(join(tmpdir(), "native-task-await-"));
  t.after(async () => { await bridge.close(); await close(local); await close(claims); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const task = store.tasks.request("org/core#40", { recipe: "platform-probe", capability: "macos-arm64", reason: "builder's check" }, "builder-run");
  store.tasks.report("mac", { capabilities: ["macos-arm64"], ready: true });
  assert.equal(store.taskStart("mac", task.id, "native").ok, true);
  const out = join(directory, "result");
  const waiting = execute("python3", [helper, "await", task.id, "--out", out, "--timeout", "60"], { env: { PATH: process.env.PATH, PYRY_TASK_SOCKET: bridge.socket } });
  await new Promise(resolve => setTimeout(resolve, 1500));
  store.taskComplete("mac", task.id, "native", { outcome: "failed", summary: "Route probe failed on the Mac", files: { "probe.txt": "no route\n" } });
  const finished = JSON.parse((await waiting).stdout);
  assert.equal(finished.state, "failed");
  assert.equal(readFileSync(join(out, "probe.txt"), "utf8"), "no route\n");
  assert.deepEqual(bridge.requested(), []);
});
