import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import type { GateRunReport } from "./gate-output.js";
import {
  FLAKY_REOPEN_WINDOW_MS,
  FLAKY_RUN_TEST_LIMIT,
  FLAKY_TEST_COLUMN,
  FLAKY_TEST_LABEL,
  buildFlakyTestIssue,
  classifyFlakyRun,
  describeFlakySightings,
  findFlakyTicket,
  flakyMarker,
  flakyTrackingNotes,
  recordFlakyTests,
  shortTestName,
  buildFlakyRecurrenceComment,
  failureTicketLabels,
  staleLabelsOnReopen,
  type ClosedTracker,
  type FlakyRunContext,
  type FlakyTicketClient,
  type TrackerRef,
  type VerifierGateFlakyContext,
} from "./flaky-tickets.js";
import { FlakySightingLedger, FlakySightingRecorder, type FlakySightingFs, type FlakySightingStore } from "./flaky-sightings.js";

function memoryFs(): FlakySightingFs {
  const files = new Map<string, string>();
  return {
    readFileSync: (path) => { const v = files.get(path); if (v === undefined) throw new Error("ENOENT"); return v; },
    writeFileSync: (path, data) => { files.set(path, data); },
    renameSync: (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
  };
}

const NAME = "de.pyryco.mobile.e2e.InteractiveStreamE2ETest#interactiveTurn_stopRunningTurn_showsInterruptedThenRepliesAgain";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-15T12:00:00.000Z");

let runs = 0;
/** A live gate run. Each call is a separate run, so its sightings are new. */
function ctx(at = new Date(T0 + runs++).toISOString()): FlakyRunContext {
  return {
    gatedIssue: 1016,
    at,
    report: {
      branchName: "feature/1016",
      headSha: "c51aea6481".padEnd(40, "0"),
      baseRef: "origin/main",
      baseSha: "31234eccda".padEnd(40, "0"),
      outputPath: "/logs/gate.log",
      rerunOutputPath: "/logs/rerun.log",
    } as GateRunReport,
  };
}

/** One shared sighting record, and each computer's recorder in front of it. */
function shared(clock: () => number = () => T0 + runs) {
  const ledger = new FlakySightingLedger(new DatabaseSync(":memory:"), clock);
  const on = (machine: string): FlakySightingStore => new FlakySightingRecorder({
    connection: { call: async <T>(_path: string, body: any) => ledger.record(machine, "org/mobile", body.sightings) as T },
    statePath: `/${machine}.json`, fs: memoryFs(), now: clock,
  });
  return { ledger, on };
}

class FakeClient implements FlakyTicketClient {
  open: { number: number; body: string; labels?: string[] }[] = [];
  closed: ClosedTracker[] = [];
  created: { title: string; body: string; labels: string[] }[] = [];
  comments: { issue: number; body: string }[] = [];
  statuses: { itemId: string; status: string }[] = [];
  reopenedIssues: number[] = [];
  removed: { issue: number; label: string }[] = [];
  listError: Error | null = null;
  closedError: Error | null = null;
  createError: Error | null = null;
  next = 3000;

  async listOpenIssuesWithLabel(label: string) {
    assert.equal(label, FLAKY_TEST_LABEL);
    if (this.listError) throw this.listError;
    return [...this.open];
  }
  async listRecentlyClosedIssuesWithLabel(label: string, since: Date) {
    assert.equal(label, FLAKY_TEST_LABEL);
    if (this.closedError) throw this.closedError;
    return this.closed.filter((c) => Date.parse(c.closedAt) >= since.getTime());
  }
  async createIssue(title: string, body: string, labels: string[] = []) {
    if (this.createError) throw this.createError;
    this.created.push({ title, body, labels });
    const number = this.next++;
    return { number, nodeId: `node-${number}`, url: `https://x/${number}` };
  }
  async addItemToProject(nodeId: string) { return `item-${nodeId}`; }
  async updateItemStatus(itemId: string, status: string) { this.statuses.push({ itemId, status }); }
  async addComment(issue: number, body: string) { this.comments.push({ issue, body }); }
  async reopenIssue(issue: number) { this.reopenedIssues.push(issue); }
  async removeLabel(issue: number, label: string) { this.removed.push({ issue, label }); }
}

/** A client on a board the claim service owns: reopens and comments go through `/flaky/track`. */
class AdoptedClient extends FakeClient {
  tracked: { issue: number; comment: string; ref: TrackerRef; reopen: boolean }[] = [];
  async reopenTracker(issue: ClosedTracker, comment: string, ref: TrackerRef) { this.tracked.push({ issue: issue.number, comment, ref, reopen: true }); }
  async commentOnTracker(issue: number, comment: string, ref: TrackerRef) { this.tracked.push({ issue, comment, ref, reopen: false }); }
}

describe("flaky-test tickets", () => {
  test("a first sighting files nothing, is recorded, and is named in the notes", async () => {
    const { ledger, on } = shared();
    const client = new FakeClient();

    const result = await recordFlakyTests(client, [NAME], ctx(), { store: on("build-hp-1") });

    assert.deepEqual(result.filed, []);
    assert.deepEqual(result.firstSightings, [NAME]);
    assert.equal(result.sightingSource, "central");
    assert.equal(client.created.length, 0);
    assert.equal(ledger.history("org/mobile", NAME).length, 1, "the sighting is in the shared record");
    assert.match(flakyTrackingNotes(result).get(NAME)!, /^first sighting in 14 days, recorded; a ticket is filed if it flakes again$/);
  });

  test("a second sighting on the same computer files a Backlog ticket, labelled and findable by its marker", async () => {
    const { on } = shared();
    const box = on("pyrybox");
    const client = new FakeClient();
    await recordFlakyTests(client, [NAME], ctx(), { store: box });

    const result = await recordFlakyTests(client, [NAME], ctx(), { store: box });

    assert.deepEqual(result.filed, [{ name: NAME, issue: 3000 }]);
    assert.equal(client.created[0].title, "flaky live test: interactiveTurn_stopRunningTurn_showsInterruptedThenRepliesAgain");
    assert.deepEqual(client.created[0].labels, failureTicketLabels(["bug", FLAKY_TEST_LABEL, "priority:low"]));
    assert.match(client.created[0].labels[3], /^requires:(linux|macos)$/, "the system it was seen on");
    assert.match(client.created[0].body, /Gate run for #1016/);
    assert.match(client.created[0].body, /Earlier sightings in the last 14 days:\n\n- Live gate for org\/mobile#1016 on pyrybox at /);
    assert.equal(findFlakyTicket([{ number: 3000, body: client.created[0].body }], NAME), 3000);
    assert.deepEqual(client.statuses, [{ itemId: "item-node-3000", status: FLAKY_TEST_COLUMN }]);
  });

  test("a second sighting on another computer files too", async () => {
    const { on } = shared();
    const client = new FakeClient();
    await recordFlakyTests(client, [NAME], ctx(), { store: on("build-hp-1") });
    const result = await recordFlakyTests(client, [NAME], ctx(), { store: on("build-fractal-2") });
    assert.equal(result.filed.length, 1);
    assert.match(client.created[0].body, /on build-hp-1 at /);
  });

  test("a sighting outside the 14-day window does not count", async () => {
    let now = T0;
    const { on } = shared(() => now);
    const store = on("pyrybox");
    const client = new FakeClient();
    await recordFlakyTests(client, [NAME], ctx(new Date(now).toISOString()), { store, now: () => now });
    now = T0 + 15 * DAY;
    const result = await recordFlakyTests(client, [NAME], ctx(new Date(now).toISOString()), { store, now: () => now });
    assert.deepEqual(result.firstSightings, [NAME]);
    assert.equal(client.created.length, 0);
  });

  test("a later flake comments on the open ticket, whatever its count", async () => {
    const { on } = shared();
    const client = new FakeClient();
    client.open.push({ number: 1036, body: `text\n${flakyMarker(NAME)}\n` });

    const result = await recordFlakyTests(client, [NAME, NAME], ctx(), { store: on("pyrybox") });

    assert.deepEqual(result.commented, [{ name: NAME, issue: 1036 }]);
    assert.equal(client.created.length, 0);
    assert.equal(client.comments.length, 1, "a name repeated in one run is recorded once");
    assert.match(client.comments[0].body, /Flaked again/);
  });

  test("on a board the claim service owns, the occurrence comment goes through the tracker write", async () => {
    const { on } = shared();
    const client = new AdoptedClient();
    client.open.push({ number: 1036, body: flakyMarker(NAME) });
    await recordFlakyTests(client, [NAME], ctx(), { store: on("pyrybox") });
    assert.deepEqual(client.tracked.map((t) => [t.issue, t.reopen, t.ref.kind, t.ref.tests]), [[1036, false, "flaky", [NAME]]]);
    assert.match(client.tracked[0].ref.key!, /^[0-9a-f]{48}$/, "a key, so the same run judged twice comments once");
    assert.equal(client.comments.length, 0);
  });

  test("a run judged twice is one sighting", async () => {
    const { ledger, on } = shared();
    const store = on("pyrybox");
    const client = new FakeClient();
    const run = { ...ctx(), runKey: "/logs/2026-10-15T10-00-00-000Z_real-claude-gate_#1016.log" };
    await recordFlakyTests(client, [NAME], run, { store });
    const again = await recordFlakyTests(client, [NAME], { ...run, at: new Date(T0 + 60_000).toISOString() }, { store });
    assert.deepEqual(again.firstSightings, [NAME]);
    assert.equal(ledger.history("org/mobile", NAME).length, 1);
  });

  test("a due test whose filing another run holds is left to that run", async () => {
    const client = new FakeClient();
    const busy: FlakySightingStore = { record: async (s) => ({ source: "central", counts: new Map(s.map((x) => [x.id, { id: x.id, test: x.test, count: 3, earlier: [], file: false }])) }) };
    const result = await recordFlakyTests(client, [NAME], ctx(), { store: busy });
    assert.deepEqual(result.deferred, [NAME]);
    assert.equal(client.created.length, 0);
    assert.equal(flakyTrackingNotes(result).get(NAME), "seen again; another gate run is filing or reopening its ticket");
  });

  test("a ticket a person closed as not planned is neither reopened nor filed again inside the window", async () => {
    const { on } = shared(() => T0);
    const store = on("pyrybox");
    const client = new AdoptedClient();
    client.closed.push({ number: 1918, nodeId: "node-1918", body: flakyMarker(NAME), labels: ["bug", FLAKY_TEST_LABEL], closedAt: new Date(T0 - DAY).toISOString(), stateReason: "not_planned" });
    await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });
    const result = await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });
    assert.deepEqual(result.declined, [{ name: NAME, issue: 1918 }]);
    assert.equal(client.created.length + client.tracked.length, 0);
  });

  test("matches the whole marker line, so one test cannot claim another's ticket", () => {
    const issues = [{ number: 1, body: flakyMarker("p.C#test_ab") }];
    assert.equal(findFlakyTicket(issues, "p.C#test_a"), null);
    assert.equal(findFlakyTicket(issues, "p.C#test_ab"), 1);
  });

  describe("more than three failures in one run", () => {
    const names = Array.from({ length: FLAKY_RUN_TEST_LIMIT + 2 }, (_, i) => `p.C#t${i}`);

    test("files at most one ticket for the run, naming every test, once one of them is a second sighting", async () => {
      const { on } = shared();
      const store = on("pyrybox");
      const client = new FakeClient();
      await recordFlakyTests(client, [names[0]], ctx(), { store });

      const result = await recordFlakyTests(client, names, ctx(), { store });

      assert.equal(client.created.length, 1, "one ticket for the run");
      assert.deepEqual(result.filed, names.map((name) => ({ name, issue: 3000 })));
      const { title, body } = client.created[0];
      assert.equal(title, "flaky live tests: 5 failed together in one gate run");
      for (const n of names) assert.ok(body.includes(flakyMarker(n)), `a marker for ${n}`);
      assert.ok(body.includes("- `p.C#t0` (also flaked earlier, see below)"));
      assert.match(body, /usually share one cause/);
      assert.equal(findFlakyTicket([{ number: 3000, body }], names[3]), 3000, "a later flake of any of them comments here");
    });

    test("files nothing when every one is a first sighting", async () => {
      const { on } = shared();
      const client = new FakeClient();
      const result = await recordFlakyTests(client, names, ctx(), { store: on("pyrybox") });
      assert.equal(client.created.length, 0);
      assert.deepEqual(result.firstSightings, names);
    });

    test("counts failures that persisted too", () => {
      assert.equal(classifyFlakyRun(["a"], { failed: ["a", "b", "c", "d"], persistent: [], branchOwnsPersistent: false }), "burst");
      assert.equal(classifyFlakyRun(["a", "b", "c"]), "quiet");
    });
  });

  describe("a run where another failure persisted on the re-run", () => {
    const onMain = (flakes: string[]) => ({ failed: [...flakes, "p.C#broken"], persistent: ["p.C#broken"], branchOwnsPersistent: false });

    test("files at most one ticket for its flakes when the persistent failure is main's", async () => {
      const { ledger, on } = shared();
      const store = on("pyrybox");
      const client = new FakeClient();
      const flakes = ["p.C#one", "p.C#two"];
      await recordFlakyTests(client, ["p.C#one"], ctx(), { store });

      const result = await recordFlakyTests(client, flakes, ctx(), { store, shape: onMain(flakes) });

      assert.equal(client.created.length, 1, "one ticket for the run");
      assert.deepEqual(result.filed, flakes.map((name) => ({ name, issue: 3000 })));
      assert.match(client.created[0].body, /1 other test\(s\) failed again on the re-run and fail on main too[^]*`p\.C#broken`/);
      assert.ok(!client.created[0].body.includes(flakyMarker("p.C#broken")), "main's failure is named, not tracked here");
      assert.equal(ledger.history("org/mobile", "p.C#one").filter((h) => h.counts).length, 2, "a main failure beside it leaves the flake counted");
    });

    test("a single flake beside main's failure gets its own ticket, as the run's one", async () => {
      const { on } = shared();
      const store = on("pyrybox");
      const client = new FakeClient();
      await recordFlakyTests(client, [NAME], ctx(), { store });
      const result = await recordFlakyTests(client, [NAME], ctx(), { store, shape: onMain([NAME]) });
      assert.deepEqual(result.filed, [{ name: NAME, issue: 3000 }]);
      assert.match(client.created[0].title, /^flaky live test: /);
    });

    test("files none when the live gate already filed the run's shared live failure ticket", async () => {
      const { on } = shared();
      const store = on("pyrybox");
      const client = new FakeClient();
      client.open.push({ number: 1036, body: flakyMarker(NAME) });
      await recordFlakyTests(client, [NAME], ctx(), { store });
      const result = await recordFlakyTests(client, [NAME], ctx(), { store, shape: { ...onMain([NAME]), persistentTracked: true } });
      assert.deepEqual(result.commented, [{ name: NAME, issue: 1036 }], "its open ticket still counts the occurrence");
      assert.equal(client.comments.length, 2);

      const other = "p.C#other";
      await recordFlakyTests(client, [other], ctx(), { store });
      const held = await recordFlakyTests(client, [other], ctx(), { store, shape: { ...onMain([other]), persistentTracked: true } });
      assert.deepEqual(held.held, [other]);
      assert.equal(client.created.length, 0, "no flaky ticket beside the shared live failure ticket");
      assert.match(flakyTrackingNotes(held).get(other)!, /^recorded; no flaky ticket, because the run's failures that failed again already have its one ticket/);
    });

    test("does not count the flake when the persistent failure is the branch's own", async () => {
      const { ledger, on } = shared();
      const store = on("pyrybox");
      const client = new FakeClient();
      const shape = { failed: [NAME, "p.C#broken"], persistent: ["p.C#broken"], branchOwnsPersistent: true };
      const held = await recordFlakyTests(client, [NAME], ctx(), { store, shape });
      assert.equal(held.uncounted, true);
      assert.equal(ledger.history("org/mobile", NAME)[0].counts, false);

      const next = await recordFlakyTests(client, [NAME], ctx(), { store });
      assert.deepEqual(next.firstSightings, [NAME], "the branch's run did not count, so this is the first");
    });
  });

  describe("a recently closed ticket", () => {
    const closed = (number: number, daysAgo: number, labels = ["bug", FLAKY_TEST_LABEL, "merged", "done:verifier", "claim:build-hp-1"]): ClosedTracker => ({
      number, nodeId: `node-${number}`, body: `ctx\n${flakyMarker(NAME)}`, labels, closedAt: new Date(T0 - daysAgo * DAY).toISOString(),
    });

    test("is reopened through the claim service instead of a new one being filed", async () => {
      const { on } = shared(() => T0);
      const store = on("pyrybox");
      const client = new AdoptedClient();
      client.closed.push(closed(1861, 6), closed(1978, 1));
      await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });

      const result = await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });

      assert.equal(client.created.length, 0, "no duplicate");
      assert.deepEqual(result.reopened, [{ name: NAME, issue: 1978 }], "the most recently closed one");
      assert.equal(client.tracked.length, 1);
      assert.deepEqual([client.tracked[0].ref.kind, client.tracked[0].ref.tests], ["flaky", [NAME]]);
      assert.equal(client.tracked[0].reopen, true);
      assert.match(client.tracked[0].comment, /## Flaked again after this ticket closed/);
      assert.match(client.tracked[0].comment, /reopened it into Backlog instead of filing a new one/);
      assert.deepEqual(client.reopenedIssues, [], "no direct GitHub reopen on an owned board");
      assert.equal(flakyTrackingNotes(result).get(NAME), "reopened #1978");
    });

    test("is reopened with GitHub's own steps where the claim service does not own the board", async () => {
      const { on } = shared(() => T0);
      const store = on("pyrybox");
      const client = new FakeClient();
      client.closed.push(closed(1978, 1));
      await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });
      await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });

      assert.deepEqual(client.reopenedIssues, [1978]);
      assert.deepEqual(client.removed, [{ issue: 1978, label: "merged" }, { issue: 1978, label: "done:verifier" }]);
      assert.deepEqual(client.statuses, [{ itemId: "item-node-1978", status: "Backlog" }]);
      assert.match(client.comments[0].body, /after this ticket closed/);
      assert.equal(client.created.length, 0);
    });

    test("closed more than 30 days ago is left closed, and a new ticket is filed", async () => {
      const { on } = shared(() => T0);
      const store = on("pyrybox");
      const client = new AdoptedClient();
      client.closed.push(closed(1700, 31));
      await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });
      const result = await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });
      assert.deepEqual(result.reopened, []);
      assert.equal(result.filed.length, 1);
      assert.equal(FLAKY_REOPEN_WINDOW_MS, 30 * DAY);
    });

    test("files nothing when the closed tickets cannot be read, since a duplicate is what this avoids", async () => {
      const { on } = shared();
      const store = on("pyrybox");
      const client = new FakeClient();
      client.closedError = new Error("REST 502");
      await recordFlakyTests(client, [NAME], ctx(), { store });
      const result = await recordFlakyTests(client, [NAME], ctx(), { store });
      assert.deepEqual(result.untracked, [NAME]);
      assert.equal(client.created.length, 0);
    });

    test("a reopen that fails files nothing beside it; the next sighting tries again", async () => {
      const { on } = shared(() => T0);
      const store = on("pyrybox");
      const client = new AdoptedClient();
      client.closed.push(closed(1978, 1));
      client.reopenTracker = async () => { throw new Error("Service 409: Ticket has an active run"); };
      await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });
      const result = await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });
      assert.deepEqual(result.untracked, [NAME]);
      assert.equal(client.created.length, 0);
    });

    test("a ticket that can never be reopened through this path gets a new one beside it", async () => {
      const { on } = shared(() => T0);
      const store = on("pyrybox");
      const client = new AdoptedClient();
      client.closed.push(closed(1978, 1));
      client.reopenTracker = async () => { throw new Error("Service 409: Unknown workflow ticket"); };
      await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });
      const result = await recordFlakyTests(client, [NAME], ctx(), { store, now: () => T0 });
      assert.deepEqual(result.filed, [{ name: NAME, issue: 3000 }]);
      assert.deepEqual(result.untracked, []);
    });

    test("drops only the labels that would mislead the pipeline", () => {
      assert.deepEqual(staleLabelsOnReopen(["bug", "merged", "done:builder", "wip:verifier", "error:merge", "pending-done:documentation",
        "needs-rework:builder", "needs-human:triage", "merge-attempt:2", "claim:build-hp-1", "requires:linux", "priority:low", "family-dispatches:3"]),
      ["merged", "done:builder", "wip:verifier", "error:merge", "pending-done:documentation", "needs-rework:builder", "needs-human:triage", "merge-attempt:2"]);
    });
  });

  test("with no sighting record nothing is filed, and the notes say why", async () => {
    const client = new FakeClient();
    const result = await recordFlakyTests(client, [NAME], ctx());
    assert.equal(result.sightingSource, "none");
    assert.equal(client.created.length, 0);
    assert.match(flakyTrackingNotes(result).get(NAME)!, /^not recorded/);
  });

  test("writes nothing when the open tickets cannot be listed, since every flake would look new", async () => {
    const { on } = shared();
    const client = new FakeClient();
    client.listError = new Error("REST 502");

    const result = await recordFlakyTests(client, [NAME], ctx(), { store: on("pyrybox") });

    assert.deepEqual(result.untracked, [NAME]);
    assert.equal(client.created.length, 0);
    assert.equal(client.comments.length, 0);
  });

  test("never throws when filing fails", async () => {
    const { on } = shared();
    const store = on("pyrybox");
    const client = new FakeClient();
    client.createError = new Error("REST 500");
    await recordFlakyTests(client, [NAME], ctx(), { store });

    const result = await recordFlakyTests(client, [NAME], ctx(), { store });

    assert.deepEqual(result.filed, []);
    assert.deepEqual(result.untracked, [NAME]);
  });

  test("short names read as the method or the Go test", () => {
    assert.equal(shortTestName("p.C#method"), "method");
    assert.equal(shortTestName("github.com/o/r/internal/e2e.TestLive/sub"), "TestLive/sub");
    assert.equal(shortTestName("bare"), "bare");
  });

  test("a ticket filed from a verifier gate names the gate command and its log, not a real-claude report", async () => {
    const gate = "python3 scripts/android-test-gate.py ui";
    const gateCtx = (at: string): VerifierGateFlakyContext => ({
      gatedIssue: 1760,
      at,
      verifierGate: {
        gate,
        commit: "d4e5f6a7b8".padEnd(40, "0"),
        outputPath: "/logs/verifier-gate_#1760_2.log",
        rerunOutputPath: "/logs/verifier-gate-rerun_#1760.log",
      },
    });
    const { on } = shared();
    const store = on("pyrybox");
    const client = new FakeClient();
    await recordFlakyTests(client, [NAME], gateCtx("2026-10-05T08:00:00.000Z"), { store });

    const result = await recordFlakyTests(client, [NAME], gateCtx("2026-10-05T09:00:00.000Z"), { store });

    assert.deepEqual(result.filed, [{ name: NAME, issue: 3000 }]);
    const { title, body } = client.created[0];
    assert.equal(title, "flaky test: interactiveTurn_stopRunningTurn_showsInterruptedThenRepliesAgain");
    assert.ok(body.includes(`Verifier gate run for #1760 at 2026-10-05T09:00:00.000Z`));
    assert.ok(body.includes(`\`${gate}\` on merged commit \`d4e5f6a7b8\``));
    assert.ok(body.includes("`/logs/verifier-gate_#1760_2.log`, re-run output: `/logs/verifier-gate-rerun_#1760.log`"));
    assert.ok(!/real-claude|live gate|Branch `/.test(body), "no real-claude wording or report fields");
    assert.equal(findFlakyTicket([{ number: 3000, body }], NAME), 3000, "the same per-test marker, so both gates share one ticket");

    const comment = buildFlakyRecurrenceComment(NAME, gateCtx("2026-10-05T10:00:00.000Z"));
    assert.ok(comment.includes(`\`${gate}\``));
    assert.ok(comment.includes("/logs/verifier-gate_#1760_2.log"));
  });

  test("a real-claude ticket keeps its wording", () => {
    const { title, body } = buildFlakyTestIssue(NAME, ctx());
    assert.match(title, /^flaky live test: /);
    assert.match(body, /The real-claude gate saw this test fail/);
    assert.match(body, /on a test's second fail-then-pass inside 14 days/);
    assert.ok(body.includes("- Branch `feature/1016` at `c51aea6481`, merged with `origin/main` at `31234eccda`"));
  });

  test("the ticket body stays within the refiner's shape", () => {
    const { body } = buildFlakyTestIssue(NAME, ctx());
    for (const heading of ["## User Story", "## Context", "## Acceptance Criteria"]) assert.ok(body.includes(heading));
    assert.ok(body.length < 8000);
  });

  test("the live gate's evidence paragraph says which flakes are first sightings", async () => {
    const { on } = shared();
    const store = on("pyrybox");
    const client = new FakeClient();
    await recordFlakyTests(client, ["p.C#old"], ctx(), { store });
    const outcome = await store.record([
      { id: "a", test: "p.C#old", ticket: 1, gate: "live", counts: true, at: T0 + runs },
      { id: "b", test: "p.C#new", ticket: 1, gate: "live", counts: true, at: T0 + runs },
    ]);
    const text = describeFlakySightings(["p.C#old", "p.C#new"], outcome);
    assert.match(text, /- `p\.C#old`: seen 2 times in 14 days, so it is due for a flaky-test ticket/);
    assert.match(text, /- `p\.C#new`: first sighting in 14 days, recorded$/m);
    assert.match(text, /^Flaky-test tracking: a test with an open flaky-test ticket gets a comment on it; otherwise a ticket is filed/);
    assert.match(describeFlakySightings(["x"], outcome, { failed: ["x", "y"], persistent: ["y"], branchOwnsPersistent: true }), /do not count toward a ticket/);
    assert.match(describeFlakySightings(["x"], undefined), /could not be recorded/);
  });
});
