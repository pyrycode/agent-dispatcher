import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface PauseRecord {
  ticket: string; origin: "operator" | "pipeline"; actor: string;
  reason: string; missing: string; resumeOn: string; resumeStatus: string; revision: string;
}
export interface EvidenceRecord {
  ticket: string; machine: string; source: string; digest: string; bytes: number; modified: number;
  outcome: string;
}
export interface CoordinationRecord {
  ticket: string; blocker: string; paths: string[]; reason: string;
}
const ticketPattern = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
export function validatePause(p: PauseRecord): void {
  if (!p || !ticketPattern.test(p.ticket) || !["operator", "pipeline"].includes(p.origin)
    || !text(p.actor, 200) || !text(p.reason, 2000) || !text(p.missing, 2000) || !text(p.resumeOn, 2000)
    || !text(p.resumeStatus, 100) || !text(p.revision, 100)) throw new Error("Invalid pause record");
}
export function validateEvidence(e: EvidenceRecord): void {
  if (!e || !ticketPattern.test(e.ticket) || !text(e.machine, 100) || !text(e.source, 500)
    || !/^[a-f0-9]{64}$/.test(e.digest) || !Number.isSafeInteger(e.bytes) || e.bytes < 0
    || !Number.isFinite(e.modified) || e.modified < 0
    || !["completed", "blocked", "errored", "incomplete", "unknown"].includes(e.outcome)) throw new Error("Invalid evidence record");
}

/** Trusted workflow receipts and content-free artifact inventory share the claim database. */
export class RecoveryFacts {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_pauses (ticket TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_evidence (ticket TEXT NOT NULL, machine TEXT NOT NULL, source TEXT NOT NULL,
      record TEXT NOT NULL, PRIMARY KEY(ticket,machine,source)) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_coordination (ticket TEXT NOT NULL, blocker TEXT NOT NULL,
      record TEXT NOT NULL, PRIMARY KEY(ticket,blocker)) STRICT;`);
  }
  pause(record: PauseRecord): void {
    validatePause(record);
    this.db.prepare("INSERT INTO fleet_pauses VALUES (?,?) ON CONFLICT(ticket) DO UPDATE SET record=excluded.record")
      .run(record.ticket, JSON.stringify(record));
  }
  getPause(ticket: string): PauseRecord | undefined {
    const row = this.db.prepare("SELECT record FROM fleet_pauses WHERE ticket=?").get(ticket);
    return row ? JSON.parse(String(row.record)) : undefined;
  }
  evidence(machine: string, project: string, records: EvidenceRecord[]): void {
    if (!Array.isArray(records) || records.length > 10000) throw new Error("Invalid evidence inventory");
    for (const e of records) {
      validateEvidence(e);
      if (e.machine !== machine || !e.ticket.startsWith(`${project}#`)) throw new Error("Evidence inventory owner mismatch");
    }
    for (const e of records) this.db.prepare("INSERT INTO fleet_evidence VALUES (?,?,?,?) ON CONFLICT(ticket,machine,source) DO UPDATE SET record=excluded.record")
      .run(e.ticket, machine, e.source, JSON.stringify(e));
  }
  getEvidence(tickets: string[]): EvidenceRecord[] {
    if (!Array.isArray(tickets) || tickets.length > 30 || tickets.some(t => !ticketPattern.test(t))) throw new Error("Invalid evidence request");
    return tickets.flatMap(t => this.db.prepare("SELECT record FROM fleet_evidence WHERE ticket=? ORDER BY source DESC LIMIT 12").all(t)
      .map(r => JSON.parse(String(r.record)) as EvidenceRecord));
  }
  coordinate(record: CoordinationRecord): void {
    if (!record || !ticketPattern.test(record.ticket) || !ticketPattern.test(record.blocker) || !text(record.reason, 2000)
      || !Array.isArray(record.paths) || !record.paths.length || record.paths.length > 100
      || record.paths.some(p => !text(p, 500) || p.startsWith("/") || p.split("/").includes(".."))) throw new Error("Invalid coordination record");
    this.db.prepare("INSERT INTO fleet_coordination VALUES (?,?,?) ON CONFLICT(ticket,blocker) DO UPDATE SET record=excluded.record")
      .run(record.ticket, record.blocker, JSON.stringify(record));
  }
  getCoordination(ticket: string): CoordinationRecord[] {
    return this.db.prepare("SELECT record FROM fleet_coordination WHERE ticket=?").all(ticket).map(r => JSON.parse(String(r.record)));
  }
  revision(tickets: string[]): string | undefined {
    const evidence = this.getEvidence(tickets);
    return evidence.length ? createHash("sha256").update(JSON.stringify(evidence.map(e => [e.machine, e.source, e.digest]))).digest("hex") : undefined;
  }
}
