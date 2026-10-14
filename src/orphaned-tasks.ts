import type { DatabaseSync } from 'node:sqlite';
import type { RecoveryTasks } from './recovery-tasks.js';
import type { OperationReports } from './operation-reports.js';

/** How long a central task may have no reservation and no local receipt before it is reported. */
export const ORPHANED_TASK_MS = 60 * 60_000;
/** A computer whose last report is older than this is not evidence about anything. */
export const REPORT_FRESH_MS = 15 * 60_000;

export interface OrphanedTask {
  kind: 'orphaned-task';
  task: string;
  ticket: string;
  machine: string;
  state: string;
  /** When this was first seen without any holder, in Unix seconds like the watchdog's items. */
  since: number;
  reason: string;
}

/**
 * Central native tasks that are running or in attention while nothing holds them:
 * no reservation in the claims database and no receipt on any computer. Report
 * only. It never closes a task or releases anything.
 *
 * "Nothing holds it" must be positive evidence. The task's own computer has to
 * have reported recently and listed its receipts, so a computer that is briefly
 * offline, or still on a supervisor that does not list receipts, reports nothing.
 * The clock starts when the condition is first seen and restarts if it ever
 * stops holding, so a task mid-handoff or on a returning computer starts over.
 */
export class OrphanedTaskWatch {
  constructor(private db: DatabaseSync, private tasks: RecoveryTasks, private reports: OperationReports,
    private now = Date.now, private limitMs = ORPHANED_TASK_MS) {
    if (!Number.isFinite(limitMs) || limitMs < 60_000) throw new Error('Orphaned task limit must be at least one minute');
    db.exec('CREATE TABLE IF NOT EXISTS fleet_orphaned_task_seen (task TEXT PRIMARY KEY, since INTEGER NOT NULL) STRICT;');
  }

  private reserved(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM fleet_runs WHERE finished IS NULL AND (id=? OR json_extract(request,'$.supportTaskId')=?)").get(`task-${id}`, id);
  }

  /** Record which tasks are unheld right now. Cheap enough to call on every report. */
  observe(): void {
    const now = this.now();
    const reports = this.reports.list(true) as Array<{ machine: string; received: number; localTasks?: string[] }>;
    const fresh = new Map(reports.filter(r => now >= r.received && now - r.received <= REPORT_FRESH_MS && Array.isArray(r.localTasks)).map(r => [r.machine, new Set<string>(r.localTasks!)]));
    const unheld: string[] = [];
    for (const row of this.db.prepare("SELECT id FROM fleet_recovery_tasks WHERE state IN ('running','attention')").all()) {
      const id = String(row.id), task = this.tasks.get(id);
      if (!task.machine || !fresh.has(task.machine)) continue;
      if ([...fresh.values()].some(ids => ids.has(id)) || this.reserved(id)) continue;
      unheld.push(id);
    }
    const known = new Set(this.db.prepare('SELECT task FROM fleet_orphaned_task_seen').all().map(r => String(r.task)));
    for (const id of known) if (!unheld.includes(id)) this.db.prepare('DELETE FROM fleet_orphaned_task_seen WHERE task=?').run(id);
    for (const id of unheld) if (!known.has(id)) this.db.prepare('INSERT INTO fleet_orphaned_task_seen VALUES (?,?)').run(id, now);
  }

  list(): OrphanedTask[] {
    this.observe();
    const now = this.now();
    return this.db.prepare('SELECT task,since FROM fleet_orphaned_task_seen ORDER BY since,task').all()
      .filter(r => now - Number(r.since) >= this.limitMs)
      .map(r => {
        const task = this.tasks.get(String(r.task)), since = Number(r.since);
        return { kind: 'orphaned-task' as const, task: task.id, ticket: task.ticket, machine: task.machine!, state: task.state, since: Math.floor(since / 1000),
          reason: `Central task ${task.id.slice(0, 12)} is ${task.state} but has no reservation and no local receipt on any computer. Nothing was closed or released. Check ${task.machine} and close the record by hand if the work is gone.` };
      });
  }
}
