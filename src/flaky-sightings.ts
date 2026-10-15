// Flaky-test sightings: the shared record of every time a gate saw a test
// fail and then pass on its same-tree re-run.
//
// Why. Until 2026-10-15 the dispatcher filed a flaky-test ticket on the first
// fail-then-pass, up to five per gate run, and matched only open tickets. On
// pyrycode-desktop that filed the same receipt saturation test three times
// (#1861, #1918, #1978), five tickets for one branch's own selector race
// (#2006 to #2010), and flaky tickets used about 10 of 62 agent hours from
// 2026-10-10 to 2026-10-15. Most were contention flakes that never came back.
//
// So a sighting is recorded first, and a ticket waits for the second one.
// Sightings are shared across computers in the claim service's database, the
// way run evidence is, so a flake seen once on HP and once on Fractal counts
// twice. Two sightings on the same computer count as well.
//
// The window is 14 days. A test that flakes twice inside it is worth a ticket;
// one that flaked once two weeks ago and once today is two unrelated events
// as far as anyone fixing it can tell, so neither sighting is enough on its
// own. Rows are kept for 90 days as history, then pruned.
//
// A dispatcher that cannot reach the shared record, because the claim service
// or its machine manager predates it or is down, keeps the sighting in a local
// file and sends it with the next one. Meanwhile it counts only what this
// computer saw itself, which can only undercount: a first sighting never
// files a ticket because the shared record was unavailable.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A sighting counts toward a ticket for this long. */
export const FLAKY_SIGHTING_WINDOW_MS = 14 * DAY_MS;
/** The window in days, for ticket and prompt text. */
export const FLAKY_SIGHTING_WINDOW_DAYS = FLAKY_SIGHTING_WINDOW_MS / DAY_MS;
/** Sightings inside the window that file a ticket. */
export const FLAKY_SIGHTINGS_TO_FILE = 2;
/** The claim service keeps sightings this long as history. */
export const FLAKY_SIGHTING_RETENTION_MS = 90 * DAY_MS;
/** An undelivered local sighting is sent for this long, then dropped. */
export const FLAKY_LOCAL_PENDING_MS = 30 * DAY_MS;
/**
 * A due sighting files or reopens its test's ticket under this lease. Two
 * runs that reach the second sighting at once, such as two verifiers on one
 * busy computer, otherwise both find no ticket and both file one. The lease
 * outlives a filing by far; one that failed is retried by the next sighting
 * after it.
 */
export const FLAKY_FILING_LEASE_MS = 10 * 60 * 1000;
/** At most this many sightings in one request. */
export const FLAKY_SIGHTINGS_PER_REQUEST = 200;
/** The local file keeps at most this many sightings. */
const LOCAL_SIGHTING_CAP = 2000;

export type FlakyGate = "verifier" | "live";

export interface FlakySighting {
  /** Idempotency key: the same sighting sent twice is recorded once. */
  id: string;
  /** The test's qualified name, as the gate's parser names it. */
  test: string;
  /** The gated ticket's issue number. */
  ticket: number;
  gate: FlakyGate;
  /**
   * False for a run in which another failure persisted and is the gated
   * branch's own. Such a flake may be the branch's doing, so it is recorded
   * but never counted toward a ticket.
   */
  counts: boolean;
  /** When the gate saw it, in milliseconds. */
  at: number;
  /** The admitted run, when the dispatcher is managed. */
  runId?: string;
}

export interface FlakySightingCount {
  id: string;
  test: string;
  /** Counted sightings of the test inside the window, this one included when it counts. */
  count: number;
  /** The other counted sightings inside the window, newest first, at most five. */
  earlier: { machine: string; ticket: string; gate: FlakyGate; at: number }[];
  /**
   * Set by the claim service when the sighting is due: true when this one
   * holds the filing lease (FLAKY_FILING_LEASE_MS), false when another
   * sighting of the test does. Absent from a local count.
   */
  file?: boolean;
}

export interface FlakySightingOutcome {
  /** One entry per sighting asked about, by id. */
  counts: Map<string, FlakySightingCount>;
  /**
   * `central` when the counts came from the shared record. `local` when it
   * could not be reached and the counts are this computer's own only.
   */
  source: "central" | "local";
}

/** The deterministic id of one test's sighting in one gate run. */
export function flakySightingId(parts: readonly (string | number)[], test: string): string {
  return createHash("sha256").update(JSON.stringify([...parts, test])).digest("hex");
}

// ---------------------------------------------------------------------------
// The claim service's side.

const PROJECT = /^[\w.-]+\/[\w.-]+$/;

function validSighting(value: any): value is FlakySighting {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof value.id === "string" && /^[\w.:-]{1,200}$/.test(value.id)
    && typeof value.test === "string" && value.test.length > 0 && value.test.length <= 2000
    && Number.isSafeInteger(value.ticket) && value.ticket > 0
    && (value.gate === "verifier" || value.gate === "live")
    && typeof value.counts === "boolean"
    && typeof value.at === "number" && Number.isFinite(value.at) && value.at > 0
    && (value.runId === undefined || (typeof value.runId === "string" && value.runId.length > 0 && value.runId.length <= 250));
}

/** The central table. FleetStore runs each call in its own transaction. */
export class FlakySightingLedger {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_flaky_sightings (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, test TEXT NOT NULL, ticket TEXT NOT NULL,
        run_id TEXT, machine TEXT NOT NULL, gate TEXT NOT NULL, counts INTEGER NOT NULL, at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS fleet_flaky_sightings_test ON fleet_flaky_sightings(project, test, at);
      CREATE TABLE IF NOT EXISTS fleet_flaky_filing_leases (
        project TEXT NOT NULL, test TEXT NOT NULL, sighting TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(project, test)
      ) STRICT;
    `);
  }

  /**
   * Record each sighting once, then count it. A sighting older than the
   * retention is not stored, but is still answered. A time in the future is
   * read as now.
   */
  record(machine: string, project: unknown, sightings: unknown): { windowMs: number; results: FlakySightingCount[] } {
    if (typeof project !== "string" || !PROJECT.test(project)) throw new Error("Flaky sightings require a project");
    if (!Array.isArray(sightings) || sightings.length === 0 || sightings.length > FLAKY_SIGHTINGS_PER_REQUEST
      || !sightings.every(validSighting)) throw new Error("Invalid flaky sightings");
    const now = this.clock();
    this.db.prepare("DELETE FROM fleet_flaky_sightings WHERE at<?").run(now - FLAKY_SIGHTING_RETENTION_MS);
    const insert = this.db.prepare("INSERT OR IGNORE INTO fleet_flaky_sightings VALUES (?,?,?,?,?,?,?,?,?)");
    for (const s of sightings as FlakySighting[]) {
      const at = Math.min(Math.floor(s.at), now);
      if (at < now - FLAKY_SIGHTING_RETENTION_MS) continue;
      insert.run(s.id, project, s.test, `${project}#${s.ticket}`, s.runId ?? null, machine, s.gate, s.counts ? 1 : 0, at);
    }
    const since = now - FLAKY_SIGHTING_WINDOW_MS;
    const count = this.db.prepare("SELECT count(*) AS n FROM fleet_flaky_sightings WHERE project=? AND test=? AND counts=1 AND at>=?");
    const earlier = this.db.prepare(`SELECT machine,ticket,gate,at FROM fleet_flaky_sightings
      WHERE project=? AND test=? AND counts=1 AND at>=? AND id<>? ORDER BY at DESC, id LIMIT 5`);
    this.db.prepare("DELETE FROM fleet_flaky_filing_leases WHERE until<?").run(now);
    const lease = this.db.prepare("SELECT sighting FROM fleet_flaky_filing_leases WHERE project=? AND test=?");
    const take = this.db.prepare(`INSERT INTO fleet_flaky_filing_leases VALUES (?,?,?,?)
      ON CONFLICT(project,test) DO UPDATE SET sighting=excluded.sighting, until=excluded.until`);
    const results = (sightings as FlakySighting[]).map((s): FlakySightingCount => {
      const n = Number((count.get(project, s.test, since) as { n: number }).n);
      const result: FlakySightingCount = {
        id: s.id,
        test: s.test,
        count: n,
        earlier: earlier.all(project, s.test, since, s.id).map((r: any) => ({
          machine: String(r.machine), ticket: String(r.ticket), gate: r.gate as FlakyGate, at: Number(r.at),
        })),
      };
      if (s.counts && n >= FLAKY_SIGHTINGS_TO_FILE) {
        const held = lease.get(project, s.test) as { sighting: string } | undefined;
        // The holder asking again, after a lost answer, keeps it.
        result.file = !held || held.sighting === s.id;
        if (result.file) take.run(project, s.test, s.id, now + FLAKY_FILING_LEASE_MS);
      }
      return result;
    });
    return { windowMs: FLAKY_SIGHTING_WINDOW_MS, results };
  }

  /** Every recorded sighting of `test`, newest first. For operators and tests. */
  history(project: string, test: string): { id: string; machine: string; ticket: string; gate: FlakyGate; counts: boolean; at: number; runId: string | null }[] {
    return this.db.prepare("SELECT * FROM fleet_flaky_sightings WHERE project=? AND test=? ORDER BY at DESC, id").all(project, test)
      .map((r: any) => ({ id: String(r.id), machine: String(r.machine), ticket: String(r.ticket), gate: r.gate as FlakyGate,
        counts: Number(r.counts) === 1, at: Number(r.at), runId: r.run_id === null ? null : String(r.run_id) }));
  }
}

// ---------------------------------------------------------------------------
// The dispatcher's side.

export interface FlakySightingConnection { call<T>(path: string, body?: unknown): Promise<T> }

interface LocalSighting extends FlakySighting { delivered: boolean }
interface LocalState { version: 1; sightings: LocalSighting[] }

export interface FlakySightingFs {
  readFileSync(path: string, encoding: "utf-8"): string;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  mkdirSync?(path: string, options: { recursive: true }): unknown;
}

export interface FlakySightingRecorderOptions {
  /** The machine manager. Null for an unmanaged dispatcher, whose own file is then the whole record. */
  connection: FlakySightingConnection | null;
  /** This computer's sightings, and the ones not yet delivered. */
  statePath: string;
  /** How this computer is named in a local count. */
  machine?: string;
  /** The managed session, sent so the claim service can tell runs apart. */
  session?: string;
  /** The admitted run the sighting came from, stamped on any sighting without one. */
  runId?: () => string | undefined;
  now?: () => number;
  fs?: FlakySightingFs;
  log?: (line: string) => void;
}

/** The narrow interface the ticket filing uses; `FlakySightingRecorder` satisfies it. */
export interface FlakySightingStore {
  /** Never throws. */
  record(sightings: readonly FlakySighting[]): Promise<FlakySightingOutcome>;
}

const NODE_FS: FlakySightingFs = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  writeFileSync: (path, data) => writeFileSync(path, data),
  renameSync: (from, to) => renameSync(from, to),
  mkdirSync: (path, options) => mkdirSync(path, options),
};

export class FlakySightingRecorder implements FlakySightingStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly fs: FlakySightingFs;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private warned = false;

  constructor(private readonly options: FlakySightingRecorderOptions) {
    this.fs = options.fs ?? NODE_FS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  /** One call at a time, so parallel verifier runs never lose each other's lines. */
  record(sightings: readonly FlakySighting[]): Promise<FlakySightingOutcome> {
    const work = this.queue.then(() => this.recordNow(sightings));
    this.queue = work.catch(() => undefined);
    return work.catch((e: any) => {
      this.log(`   ⚠️  Flaky sightings could not be recorded: ${e?.message ?? e}`);
      return { counts: new Map(), source: "local" as const };
    });
  }

  private async recordNow(given: readonly FlakySighting[]): Promise<FlakySightingOutcome> {
    const now = this.now();
    const runId = this.options.runId?.();
    const sightings = given.map((s) => s.runId === undefined && runId ? { ...s, runId } : s);
    const state = this.load();
    for (const s of sightings) {
      if (!state.sightings.some((l) => l.id === s.id)) state.sightings.push({ ...s, delivered: false });
    }
    state.sightings = state.sightings
      .filter((l) => l.at >= now - (l.delivered ? FLAKY_SIGHTING_WINDOW_MS : FLAKY_LOCAL_PENDING_MS))
      .slice(-LOCAL_SIGHTING_CAP);

    let central: FlakySightingCount[] | null = null;
    if (this.options.connection !== null) {
      // The new sightings first, so a long backlog never crowds them out.
      const ids = new Set(sightings.map((s) => s.id));
      const pending = state.sightings.filter((l) => !l.delivered);
      const batch = [...pending.filter((l) => ids.has(l.id)), ...pending.filter((l) => !ids.has(l.id))]
        .slice(0, FLAKY_SIGHTINGS_PER_REQUEST);
      if (batch.length > 0) {
        try {
          const answer = await this.options.connection.call<{ results: FlakySightingCount[] }>("/flaky/sightings", {
            sightings: batch.map(({ delivered: _delivered, ...s }) => s),
            ...(this.options.session ? { session: this.options.session } : {}),
          });
          if (!Array.isArray(answer?.results)) throw new Error("the claim service gave no counts");
          const sent = new Set(batch.map((s) => s.id));
          for (const l of state.sightings) if (sent.has(l.id)) l.delivered = true;
          central = answer.results;
          this.warned = false;
        } catch (e: any) {
          if (!this.warned) {
            this.log(`   ⚠️  Flaky sightings kept on this computer for now: the shared record answered ${e?.message ?? e}`);
            this.warned = true;
          }
        }
      }
    }
    this.save(state);

    const counts = new Map<string, FlakySightingCount>();
    if (central !== null) {
      for (const r of central) if (sightings.some((s) => s.id === r.id)) counts.set(r.id, r);
      // Every new sighting was in the batch, so this is only a guard against a short answer.
      if (sightings.every((s) => counts.has(s.id))) return { counts, source: "central" };
    }
    const since = now - FLAKY_SIGHTING_WINDOW_MS;
    for (const s of sightings) {
      const same = state.sightings.filter((l) => l.test === s.test && l.counts && l.at >= since);
      counts.set(s.id, {
        id: s.id,
        test: s.test,
        count: same.length,
        earlier: same.filter((l) => l.id !== s.id).sort((a, b) => b.at - a.at).slice(0, 5)
          .map((l) => ({ machine: this.options.machine ?? "this computer", ticket: `#${l.ticket}`, gate: l.gate, at: l.at })),
      });
    }
    return { counts, source: "local" };
  }

  private load(): LocalState {
    let raw: string;
    try {
      raw = this.fs.readFileSync(this.options.statePath, "utf-8");
    } catch {
      return { version: 1, sightings: [] };
    }
    try {
      const parsed = JSON.parse(raw);
      const sightings = Array.isArray(parsed?.sightings)
        ? parsed.sightings.filter((s: any) => typeof s?.delivered === "boolean" && validSighting(s))
        : [];
      return { version: 1, sightings };
    } catch {
      // Kept beside it, since it may hold sightings not yet delivered.
      const aside = `${this.options.statePath}.unreadable-${this.now()}`;
      try { this.fs.renameSync(this.options.statePath, aside); } catch { /* starting again is still right */ }
      this.log(`   ⚠️  Flaky sightings file ${this.options.statePath} is unreadable; kept as ${aside} and starting it again`);
      return { version: 1, sightings: [] };
    }
  }

  private save(state: LocalState): void {
    const tmp = `${this.options.statePath}.${process.pid}.tmp`;
    try {
      this.fs.mkdirSync?.(dirname(this.options.statePath), { recursive: true });
      this.fs.writeFileSync(tmp, JSON.stringify(state) + "\n");
      this.fs.renameSync(tmp, this.options.statePath);
    } catch (e: any) {
      this.log(`   ⚠️  Could not save flaky sightings to ${this.options.statePath}: ${e?.message ?? e}`);
    }
  }
}
