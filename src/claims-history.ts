import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const historyHash = (request: string) => createHash('sha256').update(request).digest('hex');
export function readClaimsRetention(value: unknown = {}): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'retentionDays')) throw new Error('Invalid claimsHistory configuration');
  const config = value as {retentionDays?: number};
  const days = config.retentionDays ?? 30;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0 || !Number.isSafeInteger(days * 86400_000))
    throw new Error('claimsHistory.retentionDays must be positive with a safe whole-millisecond duration');
  return days * 86400_000;
}

/** Unknown legacy ages start a full retention window, never an inferred historical age. */
export function initializeCommandHistory(db: DatabaseSync, now: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_command_ages (id TEXT PRIMARY KEY, created INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS workflow_command_age ON workflow_command_ages(created);
    CREATE TABLE IF NOT EXISTS fleet_retired_commands (id TEXT PRIMARY KEY, ticket TEXT NOT NULL, request_hash TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL, retired INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS fleet_retired_runs (id TEXT PRIMARY KEY, machine TEXT NOT NULL, ticket TEXT NOT NULL, role TEXT NOT NULL, request_hash TEXT NOT NULL, verification_pin TEXT, created INTEGER NOT NULL, finished INTEGER NOT NULL, outcome TEXT, retired INTEGER NOT NULL, generation TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS fleet_retired_run_generation ON fleet_retired_runs(ticket,generation);
    CREATE VIEW IF NOT EXISTS fleet_run_history AS
      SELECT id,ticket,generation,finished,outcome,json_extract(request,'$.role') AS role FROM fleet_runs
      UNION ALL SELECT id,ticket,generation,finished,outcome,role FROM fleet_retired_runs;`);
  db.prepare('INSERT OR IGNORE INTO workflow_command_ages SELECT id,? FROM workflow_commands').run(now);
}

/** Large payloads expire. Compact identities and upload owners deliberately never expire. */
export class ClaimsHistory {
  constructor(private db: DatabaseSync, private done: (ticket: string) => boolean | undefined, private now = Date.now) {}

  sweep(retentionMs: number): { commands: number; runs: number } {
    if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) throw new Error('Invalid claims history retention');
    const cutoff = this.now() - retentionMs;
    this.db.exec('SAVEPOINT claims_retention');
    try {
      const pins = new Set<string>();
      // A conservative reference inventory. Parse only stored structured records.
      const collect = (value: unknown): void => {
        if (typeof value === 'string') pins.add(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') Object.entries(value).forEach(([key, v]) => { pins.add(key); collect(v); });
      };
      const records = (sql: string): void => {
        for (const row of this.db.prepare(sql).all())
          for (const value of Object.values(row)) {
            if (typeof value !== 'string') continue;
            collect(value);
            if (value.startsWith('{') || value.startsWith('[')) collect(JSON.parse(value));
          }
      };
      // Durable ownership survives completion. Its claim alone does not pin
      // payloads; active work and unresolved references below still do.
      records('SELECT run_id FROM fleet_locks');
      records('SELECT report FROM fleet_operation_reports');
      records('SELECT id,ticket,request FROM fleet_runs WHERE finished IS NULL');
      records("SELECT ticket,run_id,decision FROM fleet_recovery WHERE present=1 AND state!='resolved'");
      records("SELECT ticket,run_id,record FROM fleet_stage_results WHERE coalesce(json_extract(record,'$.acceptance.state'),'waiting')!='accepted'");
      records('SELECT ticket,run_id FROM fleet_stage_publications WHERE published=0');
      records("SELECT ticket,record FROM fleet_verifier_handoffs WHERE json_extract(record,'$.state') IN ('pending','admitted')");
      records("SELECT t.id,t.ticket,t.run_id,t.request FROM fleet_recovery_tasks t LEFT JOIN fleet_task_artifacts a ON a.task=t.id WHERE t.state NOT IN ('complete','failed') OR a.committed=0");
      records('SELECT ticket,run_id,record FROM fleet_test_investigations WHERE assessed IS NULL');
      records("SELECT * FROM fleet_recovery_splits WHERE state!='complete'");
      records('SELECT ticket,request FROM fleet_storage_maintenance WHERE finished IS NULL');
      // Decisions and their provenance remain audit history even after completion.
      records('SELECT ticket,run_id,record FROM fleet_approval_events');
      records('SELECT request,record FROM fleet_machine_recoveries');
      const completed = new Map<string, boolean>();
      const isDone = (ticket: string): boolean => {
        if (!completed.has(ticket)) completed.set(ticket, this.done(ticket) === true);
        return completed.get(ticket)!;
      };
      // Closed ancestors and blockers may still be required by open descendants.
      for (const row of this.db.prepare('SELECT ticket,project,item FROM workflow_tickets').all()) {
        const item = JSON.parse(String(row.item));
        if (isDone(String(row.ticket)) && !item.labels.some((label: string) => /^(needs-human:|held:|wip:|error:|needs-rework:)/.test(label))) continue;
        collect(String(row.ticket));
        collect(item);
        for (const number of [item.parentNumber, item.grandparentNumber])
          if (number) pins.add(`${row.project}#${number}`);
        for (const blocker of item.blockedBy ?? [])
          pins.add(`${blocker.url?.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] ?? row.project}#${blocker.number}`);
      }
      let commands = 0, runs = 0;
      for (const row of this.db.prepare(`SELECT c.*,a.created FROM workflow_commands c JOIN workflow_command_ages a ON a.id=c.id WHERE a.created<?`).all(cutoff)) {
        const ticket = String(row.ticket), request = String(row.request);
        // Human/operator decisions are never removed by routine retention.
        const actor = JSON.parse(request).actor;
        if (pins.has(ticket) || pins.has(String(row.id)) || !isDone(ticket) || /operator|approval/i.test(String(actor))) continue;
        this.db.prepare('INSERT INTO fleet_retired_commands VALUES (?,?,?,?,?,?)').run(row.id, ticket, historyHash(request), String(actor), row.created, this.now());
        this.db.prepare('DELETE FROM workflow_commands WHERE id=?').run(row.id);
        this.db.prepare('DELETE FROM workflow_command_ages WHERE id=?').run(row.id);
        commands++;
      }
      for (const row of this.db.prepare('SELECT * FROM fleet_runs WHERE finished IS NOT NULL AND finished<?').all(cutoff)) {
        const ticket = String(row.ticket), request = JSON.parse(String(row.request));
        if (pins.has(ticket) || pins.has(String(row.id)) || !isDone(ticket)
          || request.parentTicket && (!isDone(request.parentTicket) || pins.has(request.parentTicket))) continue;
        const { runnerPolicy: _policy, ...original } = request;
        this.db.prepare('INSERT INTO fleet_retired_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.id, row.machine, ticket, String(request.role ?? 'unknown'), historyHash(JSON.stringify(original)), request.verificationPin ? JSON.stringify(request.verificationPin) : null, row.created, row.finished, row.outcome, this.now(), row.generation);
        this.db.prepare('DELETE FROM fleet_runs WHERE id=?').run(row.id);
        runs++;
      }
      this.db.exec('RELEASE claims_retention');
      return { commands, runs };
    } catch (error) {
      this.db.exec('ROLLBACK TO claims_retention; RELEASE claims_retention');
      throw error;
    }
  }

  /** No full VACUUM in a service tick. Existing NONE databases need the offline conversion. */
  vacuumStep(): { free: number; conversionRequired: boolean } {
    const conversionRequired = Number(this.db.prepare('PRAGMA auto_vacuum').get()!.auto_vacuum) !== 2;
    const timeout = Number(this.db.prepare('PRAGMA busy_timeout').get()!.timeout);
    try {
      // An external reader must not stall the authority waiting for a checkpoint.
      this.db.exec('PRAGMA busy_timeout=0');
      if (!conversionRequired) this.db.exec('PRAGMA incremental_vacuum(4096)');
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return { free: Number(this.db.prepare('PRAGMA freelist_count').get()!.freelist_count), conversionRequired };
    } finally { this.db.exec(`PRAGMA busy_timeout=${timeout}`); }
  }
}

/** Independent of evidence-store enablement; the caller stops both timers before closing SQLite. */
export function startClaimsMaintenance(history: Pick<ClaimsHistory, 'sweep' | 'vacuumStep'>, retentionMs: number,
  warn: (message: string) => void = console.warn,
  interval: (work: () => void, ms: number) => () => void = (work, ms) => { const timer = setInterval(work, ms); return () => clearInterval(timer); },
): () => void {
  const sweep = () => { try { history.sweep(retentionMs); } catch (error) { warn("Claims retention failed; history retained"); } };
  let reportedConversion = false;
  const vacuum = () => { try {
    if (history.vacuumStep().conversionRequired && !reportedConversion) { warn('Claims incremental vacuum requires offline conversion; history and ownership retained'); reportedConversion = true; }
  } catch (error) { warn("Claims vacuum failed; retrying at the next bounded step"); } };
  sweep();
  const stopSweep = interval(sweep, 3600_000), stopVacuum = interval(vacuum, 60_000);
  return () => { stopSweep(); stopVacuum(); };
}
