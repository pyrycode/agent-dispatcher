// The one authority for fleet ownership. No heartbeat expires a claim or run.
// Keep this file on the claim server's local disk, never on a shared filesystem.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type ResourceClass = "heavy" | "medium" | "light";
export interface MachineLimits { heavyLimit: number; combinedLimit: number }
export function validateLimits(limits: MachineLimits): void {
  if (!limits || !Number.isSafeInteger(limits.heavyLimit) || limits.heavyLimit < 1 ||
      !Number.isSafeInteger(limits.combinedLimit) || limits.combinedLimit < limits.heavyLimit) {
    throw new Error("Limits require positive integers with combinedLimit >= heavyLimit");
  }
}
export interface StartRequest {
  id: string;
  machine: string;
  session: string;
  project: string;
  ticket: string;
  role: string;
  resource: ResourceClass;
  locks: string[];
  roleLimit?: number;
}
export interface Claim { ticket: string; machine: string; generation: string; created: number }
export interface FleetRun extends StartRequest { generation: string; created: number }
export interface FleetSnapshot { claims: Claim[]; runs: FleetRun[] }
export type StartResult = { ok: true; generation: string } | {
  ok: false; reason: "foreign-claim" | "running" | "capacity" | "locked" | "finished";
};

export function validateStart(req: StartRequest): void {
  for (const key of ["id", "machine", "session", "project", "ticket", "role"] as const) {
    if (typeof req[key] !== "string" || !req[key] || req[key].length > 250) throw new Error(`Invalid ${key}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(req.project)) throw new Error("Invalid project");
  // @ names are shared non-ticket jobs, such as a main revision check.
  if (!req.ticket.startsWith(`${req.project}#`) || !/^(?:[1-9]\d*|@[\w.-]+)$/.test(req.ticket.slice(req.project.length + 1))) {
    throw new Error("Invalid ticket");
  }
  if (req.resource !== "heavy" && req.resource !== "medium" && req.resource !== "light") throw new Error("Invalid resource class");
  if (req.roleLimit !== undefined && (!Number.isSafeInteger(req.roleLimit) || req.roleLimit < 1)) throw new Error("Invalid role limit");
  if (!Array.isArray(req.locks) || req.locks.length > 16 || req.locks.some(k => typeof k !== "string" || !k.startsWith(`${req.project}:`) || k.length > 300)) {
    throw new Error("Invalid project locks");
  }
}

export class FleetStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly limits: Readonly<Record<string, MachineLimits>>) {
    for (const value of Object.values(limits)) validateLimits(value);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS fleet_claims (
        ticket TEXT PRIMARY KEY, machine TEXT NOT NULL, generation TEXT NOT NULL, created INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_runs (
        id TEXT PRIMARY KEY, machine TEXT NOT NULL, session TEXT NOT NULL,
        ticket TEXT NOT NULL, generation TEXT NOT NULL, resource TEXT NOT NULL,
        request TEXT NOT NULL, created INTEGER NOT NULL, finished INTEGER, outcome TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS fleet_ticket_running ON fleet_runs(ticket) WHERE finished IS NULL;
      CREATE TABLE IF NOT EXISTS fleet_locks (
        name TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES fleet_runs(id)
      ) STRICT;
    `);
  }
  close(): void { this.db.close(); }

  /** Guard small workflow writes too. An active job is writable only by that run. */
  authorize(machine: string, session: string, ticket: string, runId?: string): Claim {
    if (!Object.hasOwn(this.limits, machine) || !session || !/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(ticket)) throw new Error("Invalid ownership request");
    return this.transaction(() => {
      const claim = this.db.prepare("SELECT * FROM fleet_claims WHERE ticket=?").get(ticket) as unknown as Claim | undefined;
      if (claim && claim.machine !== machine) throw new Error("Ticket belongs to another machine");
      const active = this.db.prepare("SELECT id,session FROM fleet_runs WHERE ticket=? AND finished IS NULL").get(ticket);
      if (active && (active.id !== runId || active.session !== session)) throw new Error("Ticket has an active run");
      if (claim) return claim;
      const grant = runId ? this.db.prepare("SELECT request,generation FROM fleet_runs WHERE id=? AND machine=? AND session=? AND finished IS NULL").get(runId, machine, session) : undefined;
      if (!grant) throw new Error("Unclaimed workflow writes require a run grant");
      const request = JSON.parse(String(grant.request)) as StartRequest;
      if (!ticket.startsWith(`${request.project}#`)) throw new Error("Run project mismatch");
      const result = { ticket, machine, generation: randomUUID(), created: Date.now() };
      // Housekeeping changes stages/labels under the project lock, without
      // hoarding all ready tickets before the scheduler can prioritise them.
      if (request.role !== "reconcile") this.db.prepare("INSERT INTO fleet_claims VALUES (?,?,?,?)").run(ticket, machine, result.generation, result.created);
      return result;
    });
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  start(req: StartRequest): StartResult {
    validateStart(req);
    if (!Object.hasOwn(this.limits, req.machine)) throw new Error("Unknown machine");
    const request = JSON.stringify({ ...req, locks: [...new Set(req.locks)].sort() });
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT request,generation,finished FROM fleet_runs WHERE id=?").get(req.id);
      if (previous) {
        if (previous.request !== request) throw new Error("Request ID reused with different contents");
        return previous.finished === null ? { ok: true, generation: String(previous.generation) } : { ok: false, reason: "finished" };
      }
      if (req.ticket.includes("#@main-sweep-") && this.db.prepare("SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NOT NULL AND outcome='completed'").get(req.ticket)) return { ok: false, reason: "finished" };
      if (req.role === "reconcile" && (req.ticket !== `${req.project}#@reconcile` || !req.locks.includes(`${req.project}:reconcile`))) throw new Error("Housekeeping requires the project lock");
      if (this.db.prepare("SELECT 1 FROM fleet_locks WHERE name=?").get(`${req.project}:reconcile`)) return { ok: false, reason: "locked" };
      const claim = this.db.prepare("SELECT * FROM fleet_claims WHERE ticket=?").get(req.ticket);
      if (claim && claim.machine !== req.machine) return { ok: false, reason: "foreign-claim" };
      if (this.db.prepare("SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NULL").get(req.ticket)) return { ok: false, reason: "running" };
      if (req.resource !== "light") {
        const row = this.db.prepare(`SELECT
          count(CASE WHEN resource='heavy' THEN 1 END) AS heavy,
          count(CASE WHEN resource IN ('heavy','medium') THEN 1 END) AS combined
          FROM fleet_runs WHERE machine=? AND finished IS NULL`).get(req.machine)!;
        const limit = this.limits[req.machine];
        if (Number(row.combined) >= limit.combinedLimit ||
            (req.resource === "heavy" && Number(row.heavy) >= limit.heavyLimit)) return { ok: false, reason: "capacity" };
      }
      if (req.roleLimit !== undefined) {
        const active = this.db.prepare("SELECT request FROM fleet_runs WHERE finished IS NULL").all();
        if (active.filter(r => { const job = JSON.parse(String(r.request)); return job.project === req.project && job.role === req.role; }).length >= req.roleLimit) return { ok: false, reason: "locked" };
      }
      for (const lock of req.locks) {
        if (this.db.prepare("SELECT 1 FROM fleet_locks WHERE name=?").get(lock)) return { ok: false, reason: "locked" };
      }
      const generation = claim ? String(claim.generation) : randomUUID();
      const now = Date.now();
      this.db.prepare("INSERT OR IGNORE INTO fleet_claims VALUES (?,?,?,?)").run(req.ticket, req.machine, generation, now);
      this.db.prepare("INSERT INTO fleet_runs VALUES (?,?,?,?,?,?,?,?,NULL,NULL)").run(req.id, req.machine, req.session, req.ticket, generation, req.resource, request, now);
      for (const lock of new Set(req.locks)) this.db.prepare("INSERT INTO fleet_locks VALUES (?,?)").run(lock, req.id);
      return { ok: true, generation };
    });
  }

  finish(machine: string, session: string, id: string, completed = true): void {
    this.transaction(() => {
      const run = this.db.prepare("SELECT * FROM fleet_runs WHERE id=?").get(id);
      if (!run || run.machine !== machine || run.session !== session) throw new Error("Run owner mismatch");
      this.db.prepare("DELETE FROM fleet_locks WHERE run_id=?").run(id);
      this.db.prepare("UPDATE fleet_runs SET finished=?,outcome=? WHERE id=? AND finished IS NULL").run(Date.now(), completed ? "completed" : "cancelled", id);
      // Shared maintenance jobs have no long-lived ticket owner.
      if (String(run.ticket).includes("#@")) {
        this.db.prepare("DELETE FROM fleet_claims WHERE ticket=? AND generation=? AND NOT EXISTS (SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NULL)")
          .run(run.ticket, run.generation, run.ticket);
      }
    });
  }

  // Operator recovery only. The caller must disable/stop the old worker first.
  // Matching the generation prevents an old confirmation from releasing a new owner.
  free(ticket: string, generation: string, stopped: boolean): void {
    if (stopped !== true) throw new Error("Confirm the old worker and its subprocesses have stopped");
    this.transaction(() => {
      const claim = this.db.prepare("SELECT generation FROM fleet_claims WHERE ticket=?").get(ticket);
      if (!claim || claim.generation !== generation) throw new Error("Ticket ownership changed; inspect it again");
      this.db.prepare("DELETE FROM fleet_locks WHERE run_id IN (SELECT id FROM fleet_runs WHERE ticket=? AND finished IS NULL)").run(ticket);
      this.db.prepare("UPDATE fleet_runs SET finished=? WHERE ticket=? AND finished IS NULL").run(Date.now(), ticket);
      this.db.prepare("DELETE FROM fleet_claims WHERE ticket=? AND generation=?").run(ticket, generation);
    });
  }

  snapshot(): FleetSnapshot {
    return {
      claims: this.db.prepare("SELECT * FROM fleet_claims ORDER BY created,ticket").all() as unknown as Claim[],
      runs: this.db.prepare("SELECT request,generation,created FROM fleet_runs WHERE finished IS NULL ORDER BY created,id").all()
        .map(row => ({ ...JSON.parse(String(row.request)), generation: String(row.generation), created: Number(row.created) })),
    };
  }
}
