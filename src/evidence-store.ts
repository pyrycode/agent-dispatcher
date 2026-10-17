// Shared run evidence. Every agent run and live gate run uploads a bounded,
// redacted bundle to the claims service, keyed by ticket and run id, so a
// later stage or a recovery check on another computer can read it.
//
// Why. Ordinary runs kept their evidence on the disk of the computer that ran
// them: verifier gate logs, live gate test reports and logcat, the gate
// evidence folders and the agents repo's retained logs. On 2026-10-14 Desktop
// #1978's builder on the Mac needed the Linux verifier's error and could not
// get it, and recovery checks read only the owner's own disk.
//
// The format is the recovery task artifact store's: a version 1 manifest of
// exact UTF-8 files in 256 KiB chunks, each chunk and file hashed. It lives in
// its own database beside the authority, so the authority's `VACUUM INTO`
// backups before each rollout stay small, and deleted evidence returns its
// pages to the file system.
//
// Bounded three ways: per bundle, per ticket and in total. Over the per-ticket
// or total cap, the oldest bundles are removed first, Done tickets before open
// ones, never the bundle just committed. A ticket's bundles are deleted 14
// days after it reaches Done. Uploads come only from the computer that ran
// the run, and reads need a fleet credential.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { scrubCredentials } from "./agent-runtime.js";
import { ARTIFACT_LIMITS, manifestHash, sha256, validateManifest, type ArtifactManifest } from "./recovery-artifacts.js";

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EvidenceLimits {
  /** One bundle's declared bytes. */
  bundleBytes: number;
  /** All committed bundles of one ticket. */
  ticketBytes: number;
  /** Everything in the store, committed and pending. */
  totalBytes: number;
  /** Bundles of a Done ticket are deleted this long after it reached Done. */
  doneRetentionMs: number;
  /** Bundles of a ticket the workflow store does not know are deleted at this age. */
  unknownRetentionMs: number;
  /** An upload never committed is discarded at this age. */
  pendingMs: number;
  /** Usage at or above this share of totalBytes is reported as near the cap. */
  nearCapRatio: number;
}

/** pyrybox's disk was 89% full on 2026-10-15 (49 GB free), so the total defaults to 5 GiB. */
export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  bundleBytes: 8 * MIB,
  ticketBytes: 64 * MIB,
  totalBytes: 5 * 1024 * MIB,
  doneRetentionMs: 14 * DAY_MS,
  unknownRetentionMs: 30 * DAY_MS,
  pendingMs: DAY_MS,
  nearCapRatio: 0.9,
};

/** Files in one bundle. A bundle is a bounded summary, not a log archive. */
export const EVIDENCE_MAX_FILES = 256;
/** Newest bundles returned per ticket by one list call. */
export const EVIDENCE_LIST_LIMIT = 20;

export type EvidenceKind = "agent" | "gate" | "recovery";
export interface EvidenceMeta {
  candidateRevision?: string;
  kind: EvidenceKind;
  role: string;
  outcome: string;
  startedAt: number;
  endedAt: number;
  dispatcherRevision?: string;
}
export interface EvidenceBundleView {
  ticket: string;
  runId: string;
  machine: string;
  role: string;
  meta: EvidenceMeta;
  created: number;
  committed: number;
  digest: string;
  totalBytes: number;
  manifest: ArtifactManifest;
}
export interface EvidenceUsage {
  usedBytes: number;
  committedBundles: number;
  pendingBundles: number;
  tickets: number;
  limits: { bundleBytes: number; ticketBytes: number; totalBytes: number; doneRetentionDays: number };
  usedRatio: number;
  nearCap: boolean;
}
export interface RunOwner { machine: string; ticket: string; role: string }

const TICKET = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;
/**
 * Newest means when the run ended, not when its upload began: a backlog
 * flushed from an outbox after an outage must not list or evict as newest.
 */
const runOrder = (direction: "ASC" | "DESC", table = "") => `json_extract(${table}meta,'$.endedAt') ${direction}, ${table}created ${direction}`;
const RUN_ID = /^[\w.:@-]{1,128}$/;

export function validateEvidenceTicket(ticket: unknown): string {
  if (typeof ticket !== "string" || ticket.length > 200 || !TICKET.test(ticket)) throw new Error("Invalid evidence ticket");
  return ticket;
}
function validateRunId(runId: unknown): string {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("Invalid evidence run");
  return runId;
}
function validateMeta(value: unknown): EvidenceMeta {
  const m = value as EvidenceMeta;
  const word = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max && /^[\w.:-]+$/.test(s);
  if (!m || typeof m !== "object" || Array.isArray(m)
    || !["agent", "gate", "recovery"].includes(m.kind) || !word(m.role, 64) || !word(m.outcome, 32)
    || !Number.isSafeInteger(m.startedAt) || !Number.isSafeInteger(m.endedAt) || m.startedAt < 0 || m.endedAt < 0
    || (m.dispatcherRevision !== undefined && !/^[a-f0-9]{40}$/.test(String(m.dispatcherRevision)))
    || (m.candidateRevision !== undefined && !/^[a-f0-9]{40}$/.test(String(m.candidateRevision)))
    || Object.keys(m).some(k => !["candidateRevision", "kind", "role", "outcome", "startedAt", "endedAt", "dispatcherRevision"].includes(k))) throw new Error("Invalid evidence metadata");
  return { ...(m.candidateRevision!==undefined?{candidateRevision:m.candidateRevision}:{}),kind: m.kind, role: m.role, outcome: m.outcome, startedAt: m.startedAt, endedAt: m.endedAt,
    ...(m.dispatcherRevision !== undefined ? { dispatcherRevision: m.dispatcherRevision } : {}) };
}

function positive(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) throw new Error(`evidence.${name} must be a number above 0`);
  return raw;
}
/**
 * The `evidence` section of the claims configuration. Sizes in MiB, ages in
 * days. Every key is optional; an absent one keeps its default.
 */
export function readEvidenceLimits(config: unknown): EvidenceLimits {
  const c = (config ?? {}) as Record<string, unknown>;
  if (typeof c !== "object" || Array.isArray(c)) throw new Error("evidence must be an object");
  const d = DEFAULT_EVIDENCE_LIMITS;
  const mib = (key: string, fallback: number) => { const v = positive(c[key], key); return v === undefined ? fallback : Math.round(v * MIB); };
  const days = (key: string, fallback: number) => { const v = positive(c[key], key); return v === undefined ? fallback : Math.round(v * DAY_MS); };
  const limits: EvidenceLimits = {
    bundleBytes: mib("maxBundleMB", d.bundleBytes),
    ticketBytes: mib("maxTicketMB", d.ticketBytes),
    totalBytes: mib("maxTotalMB", d.totalBytes),
    doneRetentionMs: days("doneRetentionDays", d.doneRetentionMs),
    unknownRetentionMs: days("unknownRetentionDays", d.unknownRetentionMs),
    pendingMs: d.pendingMs,
    nearCapRatio: d.nearCapRatio,
  };
  if (limits.bundleBytes > ARTIFACT_LIMITS.bytes) throw new Error("evidence.maxBundleMB is above the artifact format's 64 MiB");
  if (limits.bundleBytes < MIB) throw new Error("evidence.maxBundleMB must be at least 1");
  if (limits.bundleBytes > limits.ticketBytes || limits.ticketBytes > limits.totalBytes) throw new Error("evidence caps must satisfy maxBundleMB <= maxTicketMB <= maxTotalMB");
  return limits;
}

export class EvidenceStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
    /** The authority's record of a run: only its own computer uploads its evidence. */
    private readonly runOwner: (runId: string) => RunOwner | undefined,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    // Incremental vacuum must be chosen before the first table exists.
    this.db.exec(`
      PRAGMA auto_vacuum=INCREMENTAL;
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA journal_size_limit=67108864;
      CREATE TABLE IF NOT EXISTS evidence_bundles (
        ticket TEXT NOT NULL, run_id TEXT NOT NULL, machine TEXT NOT NULL, role TEXT NOT NULL,
        meta TEXT NOT NULL, manifest TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL,
        created INTEGER NOT NULL, committed INTEGER, PRIMARY KEY(ticket, run_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS evidence_chunks (
        ticket TEXT NOT NULL, run_id TEXT NOT NULL, path TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY(ticket, run_id, path, part)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS evidence_pins (ticket TEXT PRIMARY KEY, reason TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS evidence_done (ticket TEXT PRIMARY KEY, since INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS evidence_age ON evidence_bundles(committed, created);
    `);
  }
  close(): void { this.db.close(); }
  /** Recovery replacement is audit history. It must survive closure and capacity pruning. */
  pinTicket(ticket: string, reason: string): void {
    validateEvidenceTicket(ticket);
    if (!reason) throw new Error('Evidence preservation reason required');
    this.db.prepare('INSERT OR IGNORE INTO evidence_pins VALUES (?,?)').run(ticket, reason);
  }
  private pinned(ticket: string): boolean { return !!this.db.prepare('SELECT 1 FROM evidence_pins WHERE ticket=?').get(ticket); }
  private protectCapacity(ticket: string, runId: string, bytes: number): void {
    if (this.pinned(ticket)) {
      const retained = Number(this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM evidence_bundles WHERE ticket=? AND run_id!=?").get(ticket, runId)!.n);
      if (retained + bytes > this.limits.ticketBytes) throw new Error("Protected evidence fills the ticket cap; retain this upload for retry");
    }
    // Pending manifests reserve their complete declared size. Excluding this
    // run permits exact retries without charging its reservation twice.
    const protectedBytes = Number(this.db.prepare("SELECT COALESCE(SUM(b.bytes),0) AS n FROM evidence_bundles b LEFT JOIN evidence_pins p ON p.ticket=b.ticket WHERE (p.ticket IS NOT NULL OR b.committed IS NULL) AND NOT (b.ticket=? AND b.run_id=?)").get(ticket, runId)!.n);
    if (protectedBytes + bytes > this.limits.totalBytes) throw new Error("Protected evidence and pending uploads fill the total cap; retain this upload for retry");
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private row(ticket: string, runId: string) {
    return this.db.prepare("SELECT * FROM evidence_bundles WHERE ticket=? AND run_id=?").get(ticket, runId);
  }
  private chunk(ticket: string, runId: string, path: string, part: number): Buffer | undefined {
    const row = this.db.prepare("SELECT data FROM evidence_chunks WHERE ticket=? AND run_id=? AND path=? AND part=?").get(ticket, runId, path, part);
    return row ? Buffer.from(row.data as Uint8Array) : undefined;
  }
  private remove(ticket: string, runId: string): void {
    this.db.prepare("DELETE FROM evidence_chunks WHERE ticket=? AND run_id=?").run(ticket, runId);
    this.db.prepare("DELETE FROM evidence_bundles WHERE ticket=? AND run_id=?").run(ticket, runId);
  }
  private owner(machine: string, project: string | undefined, ticket: string, runId: string): RunOwner {
    if (project !== undefined && !ticket.startsWith(`${project}#`)) throw new Error("Evidence project mismatch");
    const owner = this.runOwner(runId);
    if (!owner || owner.machine !== machine || owner.ticket !== ticket) throw new Error("Evidence run owner mismatch");
    return owner;
  }

  /** Start or resume an upload. Returns the chunks still missing; a committed identical bundle needs none. */
  begin(machine: string, project: string | undefined, ticketValue: unknown, runIdValue: unknown, metaValue: unknown, manifestValue: unknown):
    { digest: string; committed: boolean; missing: Record<string, number[]> } {
    const ticket = validateEvidenceTicket(ticketValue), runId = validateRunId(runIdValue);
    const owner = this.owner(machine, project, ticket, runId);
    const meta = validateMeta(metaValue), manifest = validateManifest(manifestValue as ArtifactManifest);
    if (manifest.files.length > EVIDENCE_MAX_FILES) throw new Error("Evidence bundle has too many files");
    if (manifest.totalBytes > this.limits.bundleBytes) throw new Error("Evidence bundle exceeds the per-bundle cap");
    const digest = manifestHash(manifest);
    return this.transaction(() => {
      const old = this.row(ticket, runId);
      if (old?.committed != null) {
        if (old.digest !== digest) throw new Error("Evidence bundle already committed with different content");
        return { digest, committed: true, missing: {} };
      }
      // Split evidence is retained permanently. Refuse an upload that cannot
      // fit beside it before storing anything, so the uploader keeps its outbox.
      this.protectCapacity(ticket, runId, manifest.totalBytes);
      if (old && old.digest !== digest) this.remove(ticket, runId);
      if (!old || old.digest !== digest) {
        this.db.prepare("INSERT INTO evidence_bundles VALUES (?,?,?,?,?,?,?,?,?,NULL)")
          .run(ticket, runId, machine, owner.role, JSON.stringify(meta), JSON.stringify(manifest), digest, manifest.totalBytes, this.now());
      }
      const missing = Object.fromEntries(manifest.files.map(file => [file.path, file.chunks.map((_, i) => i).filter(i => {
        const data = this.chunk(ticket, runId, file.path, i);
        return !data || data.length !== Math.min(ARTIFACT_LIMITS.chunkBytes, file.bytes - i * ARTIFACT_LIMITS.chunkBytes) || sha256(data) !== file.chunks[i];
      })]).filter(([, parts]) => (parts as number[]).length > 0));
      return { digest, committed: false, missing };
    });
  }

  put(machine: string, project: string | undefined, ticketValue: unknown, runIdValue: unknown, digest: unknown, path: unknown, part: unknown, encoded: unknown): void {
    const ticket = validateEvidenceTicket(ticketValue), runId = validateRunId(runIdValue);
    this.owner(machine, project, ticket, runId);
    const row = this.row(ticket, runId);
    if (!row || row.digest !== digest || row.machine !== machine) throw new Error("Unknown evidence upload");
    if (row.committed != null) return;
    const manifest: ArtifactManifest = JSON.parse(String(row.manifest));
    const file = manifest.files.find(f => f.path === path);
    if (!file || typeof part !== "number" || !Number.isSafeInteger(part) || part < 0 || part >= file.chunks.length
      || typeof encoded !== "string" || encoded.length > Math.ceil(ARTIFACT_LIMITS.chunkBytes / 3) * 4) throw new Error("Invalid evidence chunk");
    const data = Buffer.from(encoded, "base64");
    if (data.toString("base64") !== encoded || data.length !== Math.min(ARTIFACT_LIMITS.chunkBytes, file.bytes - part * ARTIFACT_LIMITS.chunkBytes)
      || sha256(data) !== file.chunks[part]) throw new Error("Evidence chunk byte/hash mismatch");
    this.db.prepare("INSERT INTO evidence_chunks VALUES (?,?,?,?,?) ON CONFLICT(ticket,run_id,path,part) DO UPDATE SET data=excluded.data")
      .run(ticket, runId, file.path, part, data);
  }

  /** Verify every file and make the bundle readable, then apply the ticket and total caps. */
  commit(machine: string, project: string | undefined, ticketValue: unknown, runIdValue: unknown, digest: unknown): { committed: true; evicted: number } {
    const ticket = validateEvidenceTicket(ticketValue), runId = validateRunId(runIdValue);
    this.owner(machine, project, ticket, runId);
    return this.transaction(() => {
      const row = this.row(ticket, runId);
      if (!row || row.digest !== digest || row.machine !== machine) throw new Error("Unknown evidence upload");
      if (row.committed != null) return { committed: true as const, evicted: 0 };
      const manifest: ArtifactManifest = JSON.parse(String(row.manifest));
      this.protectCapacity(ticket, runId, manifest.totalBytes);
      for (const file of manifest.files) {
        const parts = file.chunks.map((hash, i) => {
          const data = this.chunk(ticket, runId, file.path, i);
          if (!data) throw new Error("Evidence chunk missing");
          if (data.length !== Math.min(ARTIFACT_LIMITS.chunkBytes, file.bytes - i * ARTIFACT_LIMITS.chunkBytes) || sha256(data) !== hash) throw new Error("Evidence chunk byte/hash mismatch");
          return data;
        });
        const data = Buffer.concat(parts), text = data.toString("utf8");
        if (data.length !== file.bytes || sha256(data) !== file.sha256 || !Buffer.from(text).equals(data)) throw new Error("Evidence byte/hash or UTF-8 mismatch");
        // The uploader redacts. This is the second check, on the complete
        // reconstructed text: a credential may span chunk boundaries.
        if (scrubCredentials(text) !== text) throw new Error("Evidence contains credential-shaped text");
      }
      this.db.prepare("UPDATE evidence_bundles SET committed=? WHERE ticket=? AND run_id=?").run(this.now(), ticket, runId);
      const evicted = this.enforceTicketCap(ticket, runId) + this.enforceTotalCap(ticket, runId);
      this.usageCache = undefined;
      return { committed: true as const, evicted };
    });
  }

  private enforceTicketCap(ticket: string, keepRun: string): number {
    let evicted = 0;
    let used = Number(this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM evidence_bundles WHERE ticket=? AND committed IS NOT NULL").get(ticket)!.n);
    if (used <= this.limits.ticketBytes) return 0;
    for (const r of this.db.prepare(`SELECT run_id,bytes FROM evidence_bundles WHERE ticket=? AND committed IS NOT NULL AND run_id!=? ORDER BY ${runOrder("ASC")}`).all(ticket, keepRun)) {
      if (used <= this.limits.ticketBytes) break;
      if (this.pinned(ticket)) continue;
      this.remove(ticket, String(r.run_id)); used -= Number(r.bytes); evicted++;
    }
    return evicted;
  }
  /** Oldest first, a Done ticket's bundles before an open ticket's. Pending uploads count toward the total. */
  private enforceTotalCap(keepTicket?: string, keepRun?: string): number {
    let used = this.usedBytes();
    if (used <= this.limits.totalBytes) return 0;
    let evicted = 0;
    const candidates = this.db.prepare(`SELECT b.ticket,b.run_id,b.bytes FROM evidence_bundles b LEFT JOIN evidence_done d ON d.ticket=b.ticket
      WHERE b.committed IS NOT NULL ORDER BY (d.ticket IS NULL) ASC, ${runOrder("ASC", "b.")}`).all();
    for (const r of candidates) {
      if (used <= this.limits.totalBytes) break;
      if (r.ticket === keepTicket && r.run_id === keepRun) continue;
      if (this.pinned(String(r.ticket))) continue;
      this.remove(String(r.ticket), String(r.run_id)); used -= Number(r.bytes); evicted++;
    }
    return evicted;
  }
  private usedBytes(): number {
    return Number(this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM evidence_bundles").get()!.n);
  }

  /** The newest committed bundles of a ticket, optionally one run. */
  list(ticketValue: unknown, runIdValue?: unknown): EvidenceBundleView[] {
    const ticket = validateEvidenceTicket(ticketValue);
    const rows = runIdValue === undefined || runIdValue === null
      ? this.db.prepare(`SELECT * FROM evidence_bundles WHERE ticket=? AND committed IS NOT NULL ORDER BY ${runOrder("DESC")} LIMIT ?`).all(ticket, EVIDENCE_LIST_LIMIT)
      : this.db.prepare("SELECT * FROM evidence_bundles WHERE ticket=? AND run_id=? AND committed IS NOT NULL").all(ticket, validateRunId(runIdValue));
    return rows.map(r => ({ ticket: String(r.ticket), runId: String(r.run_id), machine: String(r.machine), role: String(r.role),
      meta: JSON.parse(String(r.meta)), created: Number(r.created), committed: Number(r.committed), digest: String(r.digest),
      totalBytes: Number(r.bytes), manifest: JSON.parse(String(r.manifest)) }));
  }

  /** One verified chunk of a committed bundle, base64. */
  read(ticketValue: unknown, runIdValue: unknown, digest: unknown, path: unknown, part: unknown) {
    const ticket = validateEvidenceTicket(ticketValue), runId = validateRunId(runIdValue);
    const row = this.row(ticket, runId);
    if (!row || row.committed == null || row.digest !== digest) throw new Error("Unknown evidence bundle");
    const manifest: ArtifactManifest = JSON.parse(String(row.manifest));
    const file = manifest.files.find(f => f.path === path);
    if (!file || typeof part !== "number" || !Number.isSafeInteger(part) || part < 0 || part >= file.chunks.length) throw new Error("Unknown evidence chunk");
    const data = this.chunk(ticket, runId, file.path, part);
    if (!data || data.length !== Math.min(ARTIFACT_LIMITS.chunkBytes, file.bytes - part * ARTIFACT_LIMITS.chunkBytes) || sha256(data) !== file.chunks[part]) throw new Error("Evidence chunk missing or corrupt");
    return { digest, path: file.path, part, bytes: data.length, sha256: sha256(data), data: data.toString("base64") };
  }

  private usageCache: { at: number; value: EvidenceUsage } | undefined;
  /** Usage for the claim service's snapshot, read every second by every manager: recomputed at most every 30 seconds. */
  cachedUsage(): EvidenceUsage {
    const now = this.now();
    if (!this.usageCache || now - this.usageCache.at >= 30_000 || now < this.usageCache.at) this.usageCache = { at: now, value: this.usage() };
    return this.usageCache.value;
  }
  usage(): EvidenceUsage {
    const used = this.usedBytes();
    const counts = this.db.prepare(`SELECT SUM(committed IS NOT NULL) AS committed, SUM(committed IS NULL) AS pending, COUNT(DISTINCT ticket) AS tickets FROM evidence_bundles`).get()!;
    const usedRatio = this.limits.totalBytes > 0 ? used / this.limits.totalBytes : 0;
    return { usedBytes: used, committedBundles: Number(counts.committed ?? 0), pendingBundles: Number(counts.pending ?? 0), tickets: Number(counts.tickets ?? 0),
      limits: { bundleBytes: this.limits.bundleBytes, ticketBytes: this.limits.ticketBytes, totalBytes: this.limits.totalBytes, doneRetentionDays: this.limits.doneRetentionMs / DAY_MS },
      usedRatio: Math.round(usedRatio * 1000) / 1000, nearCap: usedRatio >= this.limits.nearCapRatio };
  }

  /**
   * Retention. `done` answers from the workflow authority: true for a Done or
   * closed ticket, false for an open one, undefined for a ticket it does not
   * know. Never throws for one ticket's answer.
   */
  sweep(done: (ticket: string) => boolean | undefined): { deleted: number } {
    const now = this.now();
    let deleted = 0;
    this.transaction(() => {
      for (const r of this.db.prepare("SELECT ticket,run_id FROM evidence_bundles WHERE committed IS NULL AND created<?").all(now - this.limits.pendingMs)) {
        this.remove(String(r.ticket), String(r.run_id)); deleted++;
      }
      for (const r of this.db.prepare("SELECT DISTINCT ticket FROM evidence_bundles").all()) {
        const ticket = String(r.ticket);
        if (this.pinned(ticket)) continue;
        let state: boolean | undefined;
        // A lookup that fails says nothing: the ticket keeps its Done clock and its bundles.
        try { state = done(ticket); } catch { continue; }
        if (state === true) this.db.prepare("INSERT OR IGNORE INTO evidence_done VALUES (?,?)").run(ticket, now);
        else if (state === false) this.db.prepare("DELETE FROM evidence_done WHERE ticket=?").run(ticket);
        else {
          this.db.prepare("DELETE FROM evidence_done WHERE ticket=?").run(ticket);
          for (const old of this.db.prepare("SELECT run_id FROM evidence_bundles WHERE ticket=? AND created<?").all(ticket, now - this.limits.unknownRetentionMs)) {
            this.remove(ticket, String(old.run_id)); deleted++;
          }
        }
      }
      for (const r of this.db.prepare("SELECT d.ticket FROM evidence_done d WHERE d.since<?").all(now - this.limits.doneRetentionMs)) {
        const ticket = String(r.ticket);
        if (this.pinned(ticket)) continue;
        deleted += Number(this.db.prepare("SELECT COUNT(*) AS n FROM evidence_bundles WHERE ticket=?").get(ticket)!.n);
        this.db.prepare("DELETE FROM evidence_chunks WHERE ticket=?").run(ticket);
        this.db.prepare("DELETE FROM evidence_bundles WHERE ticket=?").run(ticket);
        this.db.prepare("DELETE FROM evidence_done WHERE ticket=?").run(ticket);
      }
      deleted += this.enforceTotalCap();
    });
    this.usageCache = undefined;
    if (deleted > 0) this.vacuumStep();
    return { deleted };
  }

  /**
   * Return freed pages to the file system in bounded steps, so a large
   * deletion never holds the claim service for long or grows the WAL by the
   * whole store. The service calls this every minute; it does nothing when
   * nothing is free. Returns the free pages left.
   */
  vacuumStep(pages = 4096): number {
    const free = Number(this.db.prepare("PRAGMA freelist_count").get()!.freelist_count ?? 0);
    if (free === 0) return 0;
    this.db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return Number(this.db.prepare("PRAGMA freelist_count").get()!.freelist_count ?? 0);
  }
}
