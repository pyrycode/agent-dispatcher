import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  FLAKY_SIGHTING_RETENTION_MS,
  FLAKY_SIGHTING_WINDOW_MS,
  FlakySightingLedger,
  FlakySightingRecorder,
  flakySightingId,
  type FlakySighting,
  type FlakySightingFs,
} from "./flaky-sightings.js";
import { FleetStore } from "./fleet-store.js";
import { FleetClient, JsonClient, ServiceError, listen, serveFleet } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-15T12:00:00.000Z");
const TEST = "chat-history-recording.spec.ts › receipt saturation still saves a repeated page";

function sighting(over: Partial<FlakySighting> = {}): FlakySighting {
  const at = over.at ?? T0;
  return { id: flakySightingId(["verifier", over.ticket ?? 1990, "/logs/gate.log", at], over.test ?? TEST), test: TEST, ticket: 1990, gate: "verifier", counts: true, at, ...over };
}

/** An in-memory file system for the recorder's local file. */
function memoryFs(): FlakySightingFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFileSync: (path) => { const v = files.get(path); if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return v; },
    writeFileSync: (path, data) => { files.set(path, data); },
    renameSync: (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
  };
}

describe("the shared sighting record", () => {
  test("counts a test's sightings inside 14 days, from any computer, once each", () => {
    let now = T0;
    const ledger = new FlakySightingLedger(new DatabaseSync(":memory:"), () => now);
    const first = ledger.record("build-hp-1", "org/desktop", [sighting()]);
    assert.equal(first.windowMs, FLAKY_SIGHTING_WINDOW_MS);
    assert.equal(first.results[0].count, 1, "a first sighting");
    assert.deepEqual(first.results[0].earlier, []);

    assert.equal(ledger.record("build-hp-1", "org/desktop", [sighting()]).results[0].count, 1, "the same sighting sent again counts once");

    now = T0 + DAY;
    const second = ledger.record("build-fractal-2", "org/desktop", [sighting({ at: now, ticket: 2001 })]);
    assert.equal(second.results[0].count, 2, "a second computer's sighting is the second sighting");
    assert.deepEqual(second.results[0].earlier, [{ machine: "build-hp-1", ticket: "org/desktop#1990", gate: "verifier", at: T0 }]);

    assert.equal(ledger.record("build-hp-1", "org/other", [sighting({ at: now })]).results[0].count, 1, "another project keeps its own count");
    assert.deepEqual(ledger.history("org/desktop", TEST).map((h) => h.machine), ["build-fractal-2", "build-hp-1"]);
  });

  test("two sightings on the same computer count as two", () => {
    const ledger = new FlakySightingLedger(new DatabaseSync(":memory:"), () => T0 + DAY);
    ledger.record("pyrybox", "org/desktop", [sighting()]);
    assert.equal(ledger.record("pyrybox", "org/desktop", [sighting({ at: T0 + DAY, ticket: 1991 })]).results[0].count, 2);
  });

  test("a sighting older than the window no longer counts", () => {
    let now = T0;
    const ledger = new FlakySightingLedger(new DatabaseSync(":memory:"), () => now);
    ledger.record("build-hp-1", "org/desktop", [sighting()]);
    now = T0 + 15 * DAY;
    const later = ledger.record("build-hp-1", "org/desktop", [sighting({ at: now, ticket: 2002 })]);
    assert.equal(later.results[0].count, 1, "fifteen days later it is a first sighting again");
    assert.equal(ledger.history("org/desktop", TEST).length, 2, "but the old one is still history");

    now = T0 + FLAKY_SIGHTING_RETENTION_MS + DAY;
    ledger.record("build-hp-1", "org/desktop", [sighting({ at: now, ticket: 2003 })]);
    assert.deepEqual(ledger.history("org/desktop", TEST).map((h) => h.ticket), ["org/desktop#2003", "org/desktop#2002"], "history past the retention is pruned");
  });

  test("an uncounted sighting is recorded and never counted", () => {
    const ledger = new FlakySightingLedger(new DatabaseSync(":memory:"), () => T0 + DAY);
    const held = ledger.record("build-hp-1", "org/desktop", [sighting({ counts: false })]);
    assert.equal(held.results[0].count, 0);
    assert.equal(ledger.record("build-hp-1", "org/desktop", [sighting({ at: T0 + DAY, ticket: 2004 })]).results[0].count, 1);
    assert.equal(ledger.history("org/desktop", TEST)[1].counts, false);
  });

  test("refuses malformed input whole", () => {
    const ledger = new FlakySightingLedger(new DatabaseSync(":memory:"), () => T0);
    assert.throws(() => ledger.record("m", "not a project", [sighting()]), /project/);
    assert.throws(() => ledger.record("m", "org/r", []), /Invalid flaky sightings/);
    assert.throws(() => ledger.record("m", "org/r", [sighting(), { ...sighting(), gate: "other" }]), /Invalid flaky sightings/);
    assert.equal(ledger.history("org/r", TEST).length, 0, "nothing of a refused batch is stored");
  });
});

describe("the dispatcher's recorder", () => {
  const ledgerConnection = (ledger: FlakySightingLedger, machine: string) =>
    ({ call: async <T>(path: string, body: any): Promise<T> => { assert.equal(path, "/flaky/sightings"); return ledger.record(machine, "org/desktop", body.sightings) as T; } });

  test("counts through the shared record and keeps a local copy", async () => {
    const ledger = new FlakySightingLedger(new DatabaseSync(":memory:"), () => T0);
    const fs = memoryFs();
    const recorder = new FlakySightingRecorder({ connection: ledgerConnection(ledger, "pyrybox"), statePath: "/logs/flaky.json", fs, now: () => T0, runId: () => "run-7" });
    const outcome = await recorder.record([sighting()]);
    assert.equal(outcome.source, "central");
    assert.equal([...outcome.counts.values()][0].count, 1);
    assert.equal(ledger.history("org/desktop", TEST)[0].runId, "run-7", "the admitted run is stamped on");
    assert.equal(JSON.parse(fs.files.get("/logs/flaky.json")!).sightings[0].delivered, true);
  });

  test("an older service keeps the sighting on this computer, files nothing on a first sighting, and delivers it later", async () => {
    const ledger = new FlakySightingLedger(new DatabaseSync(":memory:"), () => T0 + DAY);
    let old = true;
    const connection = {
      call: async <T>(path: string, body: any): Promise<T> => {
        if (old) throw new ServiceError(404, { error: "Unknown operation" }, '{"error":"Unknown operation"}');
        return ledgerConnection(ledger, "build-hp-1").call<T>(path, body);
      },
    };
    const fs = memoryFs();
    const logs: string[] = [];
    const recorder = new FlakySightingRecorder({ connection, statePath: "/logs/flaky.json", fs, now: () => T0, log: (l) => logs.push(l) });
    const first = await recorder.record([sighting()]);
    assert.equal(first.source, "local");
    assert.equal([...first.counts.values()][0].count, 1, "a first sighting still");
    assert.equal(JSON.parse(fs.files.get("/logs/flaky.json")!).sightings[0].delivered, false, "kept to send again");
    assert.equal(logs.length, 1);

    old = false;
    const second = await recorder.record([sighting({ at: T0 + 1000, ticket: 2005 })]);
    assert.equal(second.source, "central");
    assert.equal([...second.counts.values()][0].count, 2, "the earlier sighting arrived with this one");
    assert.deepEqual(ledger.history("org/desktop", TEST).map((h) => h.at), [T0 + 1000, T0], "with its own time");
    assert.ok(JSON.parse(fs.files.get("/logs/flaky.json")!).sightings.every((s: any) => s.delivered));
  });

  test("while the shared record is down, two sightings on this computer still count as two", async () => {
    const fs = memoryFs();
    const recorder = new FlakySightingRecorder({ connection: { call: async () => { throw new Error("connect ECONNREFUSED"); } }, statePath: "/f.json", fs, now: () => T0, machine: "pyrybox", log: () => {} });
    await recorder.record([sighting()]);
    const again = await recorder.record([sighting({ at: T0 + 5, ticket: 2006 })]);
    assert.equal(again.source, "local");
    const count = [...again.counts.values()][0];
    assert.equal(count.count, 2);
    assert.deepEqual(count.earlier.map((e) => [e.machine, e.ticket]), [["pyrybox", "#1990"]]);
  });

  test("unmanaged, this computer's file is the whole record, and it forgets past the window", async () => {
    let now = T0;
    const fs = memoryFs();
    const recorder = new FlakySightingRecorder({ connection: null, statePath: "/f.json", fs, now: () => now });
    await recorder.record([sighting()]);
    now = T0 + 15 * DAY;
    const later = await recorder.record([sighting({ at: now, ticket: 2007 })]);
    assert.equal([...later.counts.values()][0].count, 1);
    assert.equal(JSON.parse(fs.files.get("/f.json")!).sightings.length, 2, "an undelivered one waits up to 30 days");
  });

  test("parallel calls never lose each other's sightings", async () => {
    const fs = memoryFs();
    const recorder = new FlakySightingRecorder({ connection: null, statePath: "/f.json", fs, now: () => T0 });
    await Promise.all([1, 2, 3].map((n) => recorder.record([sighting({ ticket: n, at: T0 + n })])));
    assert.equal(JSON.parse(fs.files.get("/f.json")!).sightings.length, 3);
  });

  test("an unreadable local file starts again instead of failing", async () => {
    const fs = memoryFs();
    fs.files.set("/f.json", "{not json");
    const recorder = new FlakySightingRecorder({ connection: null, statePath: "/f.json", fs, now: () => T0, log: () => {} });
    assert.equal([...(await recorder.record([sighting()])).counts.values()][0].count, 1);
  });
});

describe("through the machine manager", () => {
  async function fleet(t: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), "flaky-sightings-"));
    const store = new FleetStore(":memory:", { box: { heavyLimit: 1, combinedLimit: 2 }, hp: { heavyLimit: 1, combinedLimit: 2 } });
    const authority = await serveFleet(store, { box: "box-token", hp: "hp-token" }, "admin-token", 0);
    const address = authority.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const managers = await Promise.all(["box", "hp"].map(async (machine) => {
      const manager = new MachineManager({ machine, projects: ["org/desktop"], heavyLimit: 1, combinedLimit: 2 }, new FleetClient(url, `${machine}-token`));
      const socket = join(directory, `${machine}.sock`);
      return serveManager(manager, { "org/desktop": `${machine}-desktop` }, `${machine}-admin`, socket);
    }));
    t.after(async () => {
      for (const m of managers) await new Promise<void>((r) => m.close(() => r()));
      await new Promise<void>((r) => authority.close(() => r()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const dispatcher = (machine: "box" | "hp") => new JsonClient(`unix://${join(directory, `${machine}.sock`)}`, `${machine}-desktop`);
    return { store, dispatcher };
  }

  test("a flake on one computer and then another is the second sighting", async (t) => {
    const f = await fleet(t);
    const box = new FlakySightingRecorder({ connection: f.dispatcher("box"), statePath: "/box.json", fs: memoryFs() });
    const hp = new FlakySightingRecorder({ connection: f.dispatcher("hp"), statePath: "/hp.json", fs: memoryFs() });
    const now = Date.now();
    assert.equal([...(await box.record([sighting({ at: now })])).counts.values()][0].count, 1);
    const second = [...(await hp.record([sighting({ at: now + 1, ticket: 2008 })])).counts.values()][0];
    assert.equal(second.count, 2);
    assert.deepEqual(second.earlier.map((e) => [e.machine, e.ticket]), [["box", "org/desktop#1990"]], "the manager names the project, the service the computer");
  });

  test("a manager from before the route answers Unknown operation, and the recorder keeps the sighting", async (t) => {
    const old = createServer((_req, res) => { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Unknown operation" })); });
    await listen(old, 0);
    t.after(() => new Promise<void>((r) => old.close(() => r())));
    const address = old.address(); assert.ok(address && typeof address !== "string");
    const fs = memoryFs();
    const recorder = new FlakySightingRecorder({ connection: new JsonClient(`http://127.0.0.1:${address.port}`, "t"), statePath: "/f.json", fs, log: () => {} });
    const outcome = await recorder.record([sighting({ at: Date.now() })]);
    assert.equal(outcome.source, "local");
    assert.equal(JSON.parse(fs.files.get("/f.json")!).sightings[0].delivered, false);
  });
});
