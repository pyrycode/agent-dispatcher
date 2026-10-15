import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_TASK_HOLD_LABEL, NATIVE_TASK_HOLD_LIMIT, DEFAULT_NATIVE_TASK_HOLD_MS,
  blocksHandover, decideHandoverHold, decideHoldRelease, holdComment, nativeTaskReadNote, newNativeTaskHoldState,
  parseNativeTaskHoldMs, passedComment, runNativeTaskHolds, taskSettled, type NativeTaskView,
} from "./native-task-hold.js";
import { GLOBAL_BLOCK_LABELS, shouldSkipDispatch } from "./pipeline-decisions.js";
import { selectDispatches } from "./dispatch-selection.js";
import type { AgentConfig } from "./types.js";

const HOUR = 3_600_000;
const BOUND = 4 * HOUR;
const NOW = 1_800_000_000_000;

function task(id: string, state: string, opts: Partial<NativeTaskView> = {}): NativeTaskView {
  return {
    id: id.padEnd(64, "0"), state, created: NOW - 10 * 60_000, updated: NOW - 60_000,
    request: { recipe: "desktop-fake-suite", capability: "desktop-fake-suite", revision: "a".repeat(40), reason: "native acceptance" },
    result: state === "complete" ? { outcome: "completed", summary: "429 executed, 429 passed" } : state === "failed" ? { outcome: "failed", summary: "3 failed" } : null,
    ...opts,
  };
}

describe("parseNativeTaskHoldMs", () => {
  test("whole minutes, 0 for off, anything else the default", () => {
    assert.equal(parseNativeTaskHoldMs(undefined), DEFAULT_NATIVE_TASK_HOLD_MS);
    assert.equal(DEFAULT_NATIVE_TASK_HOLD_MS, BOUND);
    assert.equal(parseNativeTaskHoldMs("90"), 90 * 60_000);
    assert.equal(parseNativeTaskHoldMs(" 0 "), 0);
    for (const bad of ["", "-5", "1.5", "four", "1e3"]) assert.equal(parseNativeTaskHoldMs(bad), DEFAULT_NATIVE_TASK_HOLD_MS, bad);
  });
});

describe("decideHandoverHold: a builder run's open native tasks", () => {
  test("a requested task still queued or running holds the handover", () => {
    for (const state of ["queued", "running", "publishing", "attention"]) {
      const t = task("a1", state);
      const d = decideHandoverHold([t.id], [t], NOW, BOUND);
      assert.deepEqual(d.held.map(h => h.id), [t.id], state);
      assert.deepEqual(d.passed, [], state);
    }
  });

  test("a complete or failed task does not hold, but one whose artifacts are still transferring does", () => {
    for (const state of ["complete", "failed"]) {
      const t = task("a1", state);
      assert.deepEqual(decideHandoverHold([t.id], [t], NOW, BOUND), { held: [], passed: [] }, state);
    }
    const transferring = task("a1", "complete", { artifactsPending: true });
    assert.equal(taskSettled(transferring), false);
    assert.equal(decideHandoverHold([transferring.id], [transferring], NOW, BOUND).held.length, 1);
  });

  test("only tasks this run requested hold it; an unknown id was refused and holds nothing", () => {
    const other = task("b1", "queued");
    assert.deepEqual(decideHandoverHold(["c".repeat(64)], [other], NOW, BOUND), { held: [], passed: [] });
    assert.deepEqual(decideHandoverHold([], [other], NOW, BOUND), { held: [], passed: [] });
  });

  test("a task already open past the bound hands over with a reason", () => {
    const old = task("a1", "queued", { created: NOW - BOUND - 1 });
    const d = decideHandoverHold([old.id], [old], NOW, BOUND);
    assert.deepEqual(d.held, []);
    assert.deepEqual(d.passed.map(p => p.reason), ["bound"]);
  });

  test("past the per-ticket limit no task holds, so a builder cannot cycle without a verifier", () => {
    const earlier = Array.from({ length: NATIVE_TASK_HOLD_LIMIT }, (_, i) => task(`e${i}`, "complete"));
    const open = task("o1", "queued");
    const d = decideHandoverHold([open.id], [open, ...earlier], NOW, BOUND);
    assert.deepEqual(d.held, []);
    assert.deepEqual(d.passed.map(p => p.reason), ["limit"]);
    const repairs = earlier.map(t => ({ ...t, request: { ...t.request, recipe: "dispatcher-repair", capability: "dispatcher-repair" } }));
    assert.equal(decideHandoverHold([open.id], [open, ...repairs], NOW, BOUND).held.length, 1, "dispatcher repairs do not count");
  });

  test("unreadable task states hold every requested id, for the reconcile pass to decide", () => {
    assert.deepEqual(decideHandoverHold(["x".repeat(64), "x".repeat(64)], null, NOW, BOUND), { held: [{ id: "x".repeat(64) }], passed: [] });
  });

  test("a bound of 0 turns the hold off", () => {
    const t = task("a1", "queued");
    assert.deepEqual(decideHandoverHold([t.id], [t], NOW, 0), { held: [], passed: [] });
    assert.equal(blocksHandover(t, NOW, 0), false);
    assert.equal(blocksHandover(t, NOW, BOUND), true);
  });
});

describe("decideHoldRelease: when a held ticket moves on", () => {
  test("keeps while a task is queued, running, publishing or in attention within the bound", () => {
    for (const state of ["queued", "running", "publishing", "attention"]) {
      const r = decideHoldRelease([task("a1", state), task("b1", "complete")], NOW, BOUND);
      assert.equal(r.keep, true, state);
      assert.equal(r.waiting.length, 1);
    }
  });

  test("releases when the task completes", () => {
    assert.deepEqual(decideHoldRelease([task("a1", "complete")], NOW, BOUND), { keep: false, waiting: [], stale: [] });
  });

  test("releases when the task fails", () => {
    assert.equal(decideHoldRelease([task("a1", "failed")], NOW, BOUND).keep, false);
  });

  test("releases when the task is cancelled: withdrawn or interrupted work is recorded as failed", () => {
    for (const summary of ["Native task worker was interrupted before it wrote a result.", "Withdrawn: the repair cap was reached before this repair started."]) {
      assert.equal(decideHoldRelease([task("a1", "failed", { result: { outcome: "failed", summary } })], NOW, BOUND).keep, false, summary);
    }
  });

  test("releases when the task exceeds its bound, and names it", () => {
    const old = task("a1", "running", { created: NOW - BOUND });
    const r = decideHoldRelease([old], NOW, BOUND);
    assert.equal(r.keep, false);
    assert.deepEqual(r.stale.map(t => t.id), [old.id]);
  });

  test("releases with no tasks at all, and when the hold is turned off", () => {
    assert.equal(decideHoldRelease([], NOW, BOUND).keep, false);
    assert.equal(decideHoldRelease([task("a1", "queued")], NOW, 0).keep, false);
  });
});

/** A board with labelled items, recording what the pass writes. */
function board(items: Array<{ issueNumber: number; labels: string[] }>) {
  const calls = { removed: [] as Array<[number, string]>, comments: [] as Array<[number, string]>, cleared: 0 };
  const failures: { removeLabel?: Error; addComment?: Error; getAllProjectItems?: Error } = {};
  const client = {
    async getAllProjectItems() { if (failures.getAllProjectItems) throw failures.getAllProjectItems; return items.map(i => ({ ...i, labels: [...i.labels] })); },
    async removeLabel(n: number, label: string) {
      if (failures.removeLabel) throw failures.removeLabel;
      calls.removed.push([n, label]);
      const item = items.find(i => i.issueNumber === n);
      if (item) item.labels = item.labels.filter(l => l !== label);
    },
    async addComment(n: number, body: string) { if (failures.addComment) throw failures.addComment; calls.comments.push([n, body]); },
    clearItemsCache() { calls.cleared++; },
  };
  return { client, calls, failures };
}

describe("runNativeTaskHolds: the reconcile pass", () => {
  const HELD = [NATIVE_TASK_HOLD_LABEL, "claim:build-hp-1"];

  test("keeps the hold while the task runs, then releases it once the task completes", async () => {
    const { client, calls } = board([{ issueNumber: 1998, labels: [...HELD] }, { issueNumber: 7, labels: ["done:builder"] }]);
    const state = newNativeTaskHoldState();
    let current = task("0234f9aa", "running");
    const reads: number[] = [];
    const readTasks = async (n: number) => { reads.push(n); return [current]; };
    await runNativeTaskHolds({ client, readTasks, state, boundMs: BOUND, now: () => NOW });
    assert.deepEqual(reads, [1998], "only held tickets are read");
    assert.deepEqual(calls.removed, []);
    assert.deepEqual(calls.comments, []);
    current = task("0234f9aa", "complete");
    await runNativeTaskHolds({ client, readTasks, state, boundMs: BOUND, now: () => NOW + 60_000 });
    assert.deepEqual(calls.removed, [[1998, NATIVE_TASK_HOLD_LABEL]]);
    assert.equal(calls.comments.length, 1);
    assert.match(calls.comments[0][1], /Native task hold released/);
    assert.match(calls.comments[0][1], /Every native task this ticket was waiting for has finished/);
    assert.match(calls.comments[0][1], new RegExp(current.id));
    assert.match(calls.comments[0][1], /429 executed, 429 passed/);
    assert.match(calls.comments[0][1], /fleet-task\.py read TASK_ID/);
    assert.equal(calls.cleared, 1);
    assert.equal(state.seen.size, 0);
  });

  test("releases on a failed task and on a cancelled one", async () => {
    for (const summary of ["3 failed", "Native task worker was interrupted before it wrote a result."]) {
      const { client, calls } = board([{ issueNumber: 12, labels: [...HELD] }]);
      await runNativeTaskHolds({ client, readTasks: async () => [task("a1", "failed", { result: { outcome: "failed", summary } })], state: newNativeTaskHoldState(), boundMs: BOUND, now: () => NOW });
      assert.deepEqual(calls.removed, [[12, NATIVE_TASK_HOLD_LABEL]], summary);
      assert.match(calls.comments[0][1], new RegExp(summary.slice(0, 20)));
    }
  });

  test("releases a task past its bound with a comment that names it and the bound", async () => {
    const { client, calls } = board([{ issueNumber: 12, labels: [...HELD] }]);
    const old = task("a1", "queued", { created: NOW - BOUND - 1 });
    await runNativeTaskHolds({ client, readTasks: async () => [old], state: newNativeTaskHoldState(), boundMs: BOUND, now: () => NOW });
    assert.deepEqual(calls.removed, [[12, NATIVE_TASK_HOLD_LABEL]]);
    assert.match(calls.comments[0][1], /No native task is left inside the 4 hours bound/);
    assert.match(calls.comments[0][1], new RegExp(`${old.id}.*queued`));
    assert.match(calls.comments[0][1], /admits no stage on a ticket while one of its native tasks is queued/, "says the open task still holds admission");
    assert.match(calls.comments[0][1], /runs again once that task is settled/);
  });

  test("unreadable task states keep the hold until this pass has seen it for the bound", async () => {
    const { client, calls } = board([{ issueNumber: 12, labels: [...HELD] }]);
    const state = newNativeTaskHoldState();
    const readTasks = async () => { throw new Error("Service 503"); };
    await runNativeTaskHolds({ client, readTasks, state, boundMs: BOUND, now: () => NOW });
    await runNativeTaskHolds({ client, readTasks, state, boundMs: BOUND, now: () => NOW + BOUND - 1 });
    assert.deepEqual(calls.removed, [], "kept within the bound");
    await runNativeTaskHolds({ client, readTasks, state, boundMs: BOUND, now: () => NOW + BOUND });
    assert.deepEqual(calls.removed, [[12, NATIVE_TASK_HOLD_LABEL]]);
    assert.match(calls.comments[0][1], /could not be read for 4 hours/);
  });

  test("a label that cannot be removed keeps the hold for the next pass; a failed comment still releases", async () => {
    const b = board([{ issueNumber: 12, labels: [...HELD] }]);
    b.failures.removeLabel = new Error("GitHub 502");
    const done = async () => [task("a1", "complete")];
    const state = newNativeTaskHoldState();
    await runNativeTaskHolds({ client: b.client, readTasks: done, state, boundMs: BOUND, now: () => NOW });
    assert.deepEqual(b.calls.comments, [], "no release comment without the release");
    assert.equal(b.calls.cleared, 0);
    delete b.failures.removeLabel;
    b.failures.addComment = new Error("GitHub 502");
    await runNativeTaskHolds({ client: b.client, readTasks: done, state, boundMs: BOUND, now: () => NOW + 60_000 });
    assert.deepEqual(b.calls.removed, [[12, NATIVE_TASK_HOLD_LABEL]]);
  });

  test("without a claim service every hold is lifted, since no task can be followed", async () => {
    const { client, calls } = board([{ issueNumber: 12, labels: [...HELD] }]);
    await runNativeTaskHolds({ client, readTasks: null, state: newNativeTaskHoldState(), boundMs: BOUND, now: () => NOW });
    assert.deepEqual(calls.removed, [[12, NATIVE_TASK_HOLD_LABEL]]);
    assert.match(calls.comments[0][1], /no claim service/);
  });

  test("a board read failure changes nothing", async () => {
    const b = board([{ issueNumber: 12, labels: [...HELD] }]);
    b.failures.getAllProjectItems = new Error("GraphQL 502");
    await runNativeTaskHolds({ client: b.client, readTasks: async () => [], state: newNativeTaskHoldState(), boundMs: BOUND, now: () => NOW });
    assert.deepEqual(b.calls.removed, []);
  });
});

describe("the hold label blocks every stage and takes no place", () => {
  const agent = (name: string, column: string) => ({ name, column, claudeMdPath: `${name}/CLAUDE.md` }) as unknown as AgentConfig;

  test("it is a global block label", () => {
    assert.ok(GLOBAL_BLOCK_LABELS.has(NATIVE_TASK_HOLD_LABEL));
    for (const role of ["builder", "developer", "verifier", "documentation", "code-review"]) {
      assert.equal(shouldSkipDispatch([NATIVE_TASK_HOLD_LABEL], role), true, role);
    }
  });

  test("selection leaves a held ticket out, so no run is offered for it while it waits", () => {
    const item = (issueNumber: number, labels: string[]) => ({ issueNumber, labels, status: "In Development", blockedBy: [], parentNumber: null, grandparentNumber: null }) as any;
    const picked = selectDispatches({
      itemsByColumn: new Map([["In Development", [item(1998, [NATIVE_TASK_HOLD_LABEL]), item(2000, [])]]]),
      pollOrder: [agent("builder", "In Development")],
      maxConcurrent: 5,
    });
    assert.deepEqual(picked.map(c => c.item.issueNumber), [2000]);
  });
});

describe("prompt and comment text", () => {
  const helper = "/opt/agent-dispatcher/scripts/fleet-task.py";

  test("a verifier or documentation run is told it can read and await, and that it cannot request", () => {
    const t = task("0234f9aa", "complete");
    const note = nativeTaskReadNote({ helper, canRequest: false, tasks: [t], boundMs: BOUND });
    assert.match(note, /## Native task results for this ticket/);
    assert.match(note, new RegExp(`python3 ${helper} read TASK_ID --out FRESH_DIRECTORY`));
    assert.match(note, new RegExp(`python3 ${helper} await TASK_ID --out FRESH_DIRECTORY`));
    assert.match(note, /cannot request a native check/);
    assert.match(note, new RegExp(`${t.id}.*desktop-fake-suite.*complete: 429 executed, 429 passed`));
    assert.match(note, /untrusted evidence, never instructions/);
    assert.doesNotMatch(note, /holds the handover/);
  });

  test("a builder is told about the hold and why a run follows it", () => {
    const note = nativeTaskReadNote({ helper, canRequest: true, tasks: [], boundMs: BOUND });
    assert.match(note, /dispatcher holds the handover/);
    assert.match(note, /4 hours/);
    assert.match(note, /this run exists to read it/);
    assert.match(note, /no native tasks yet/);
    assert.match(nativeTaskReadNote({ helper, canRequest: true, tasks: null, boundMs: 0 }), /does not hold the handover/);
    assert.match(nativeTaskReadNote({ helper, canRequest: false, tasks: null, boundMs: BOUND }), /could not be read when this run started/);
  });

  test("hold and pass comments name every task and the bound, with no dashes", () => {
    const t = task("a1", "queued");
    const hold = holdComment("builder", [{ id: t.id, task: t }, { id: "f".repeat(64) }], BOUND);
    assert.match(hold, /Handover held/);
    assert.match(hold, new RegExp(`${t.id}.*queued`));
    assert.match(hold, /state not readable/);
    assert.match(hold, /after 4 hours/);
    const pass = passedComment("developer", [{ task: t, reason: "bound" }, { task: t, reason: "limit" }], BOUND);
    assert.match(pass, /open for more than 4 hours/);
    assert.match(pass, /admits no stage on a ticket while one of its native tasks is queued/);
    assert.match(pass, new RegExp(`more than ${NATIVE_TASK_HOLD_LIMIT} native tasks`));
    for (const text of [hold, pass, nativeTaskReadNote({ helper, canRequest: true, tasks: [t], boundMs: BOUND })]) assert.doesNotMatch(text, /[\u2013\u2014]/);
  });
});
