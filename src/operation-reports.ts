import type { DatabaseSync } from 'node:sqlite';
import { scrubCredentials } from './agent-runtime.js';

export const OPERATION_PHASES: readonly string[] = ['current','stopped','drain-requested','draining','start-requested','verifying','complete','attention','preflight-failed','changed-before-drain','waiting-for-native-task','signal-failed'];

const AUTOMATIC_CHANGES = ['health-latch-cleared','operation-retired','native-task-unrecoverable','native-task-skipped','native-task-interrupted','native-task-deferred',
  'native-task-finalized','machine-worker-recovered','watchdog-stalled','watchdog-starvation','watchdog-finalize-refused'];

/** Every kind scripts/fleet-watchdog.py reports. */
export const WATCHDOG_KINDS: readonly string[] = ['stalled','starvation','finalize-refused','finalized','released','error'];
const WATCHDOG_TEXT = ['subject','ticket','phase','worker','action','holder'] as const;
const WATCHDOG_NUMBERS = ['since','lastProgress','limitSeconds'] as const;

/**
 * The supervisor's no-progress findings, the same items its local report holds.
 * Malformed items are dropped rather than rejected, like the housekeeping list.
 */
function watchdogItems(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((w: any) => w && WATCHDOG_KINDS.includes(w.kind) && typeof w.reason === 'string').slice(0,20).map((w: any) => {
    const item: Record<string, string | number> = {kind:String(w.kind),reason:scrubCredentials(w.reason.slice(0,1000))};
    for (const key of WATCHDOG_TEXT) if (typeof w[key] === 'string') item[key] = scrubCredentials(w[key].slice(0,200));
    for (const key of WATCHDOG_NUMBERS) if (Number.isFinite(w[key])) item[key] = Number(w[key]);
    return item;
  });
}

/**
 * Native task ids this computer still holds a receipt for. Absent when the supervisor
 * did not say, which is different from an empty list. Bad entries are dropped. A list
 * too long to keep whole is not kept at all: a truncated list would read as absence.
 */
export const LOCAL_TASK_LIMIT = 2000;
function localTaskIds(value: unknown) {
  if (!Array.isArray(value) || value.length > LOCAL_TASK_LIMIT) return undefined;
  return [...new Set(value.filter((id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)))];
}

/**
 * The supervisor's recent automatic clears and retirements. Malformed entries are
 * dropped rather than rejected, so this audit trail can never cost the operation report.
 */
function automaticChanges(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((h: any) => h && Number.isFinite(h.at) && AUTOMATIC_CHANGES.includes(h.kind) && typeof h.subject === 'string' && typeof h.reason === 'string')
    .slice(-20).map((h: any) => ({at:Number(h.at),kind:String(h.kind),subject:scrubCredentials(h.subject.slice(0,200)),reason:scrubCredentials(h.reason.slice(0,1000))}));
}

export class OperationReports {
  constructor(private db: DatabaseSync, private machines: string[], private now = Date.now) {
    db.exec('CREATE TABLE IF NOT EXISTS fleet_operation_reports (machine TEXT PRIMARY KEY, received INTEGER NOT NULL, report TEXT NOT NULL) STRICT;');
  }
  record(machine: string, value: any): void {
    if (!this.machines.includes(machine) || !value || !Array.isArray(value.operations) || value.operations.length > 20) throw new Error('Invalid operation report');
    // Every phase scripts/fleet-supervisor.py writes. A missing one rejects the
    // whole report, so the machine publishes only a generic control-service error.
    const phases = OPERATION_PHASES;
    const operations = value.operations.map((o: any) => {
      if (!o || !/^[\w.-]+\/[\w.-]+$/.test(o.project ?? '') || !phases.includes(o.phase)) throw new Error('Invalid operation status');
      return {project:o.project,phase:o.phase,...(typeof o.reason === 'string' ? {reason:scrubCredentials(o.reason.slice(0,1000))} : {})};
    });
    const housekeeping = automaticChanges(value.housekeeping);
    const watchdog = watchdogItems(value.watchdog);
    const localTasks = localTaskIds(value.localTasks);
    const report = {operations,...(localTasks ? {localTasks} : {}),...(housekeeping.length ? {housekeeping} : {}),...(watchdog.length ? {watchdog} : {}),...(value.service === 'attention' ? {service:'attention',reason:scrubCredentials(String(value.reason ?? 'Control service unavailable').slice(0,1000))} : {})};
    this.db.prepare('INSERT INTO fleet_operation_reports VALUES (?,?,?) ON CONFLICT(machine) DO UPDATE SET received=excluded.received,report=excluded.report').run(machine,this.now(),JSON.stringify(report));
  }
  /** The receipt lists are for the orphaned task watch only, so the operator report leaves them out. */
  list(receipts = false) {
    return this.db.prepare('SELECT * FROM fleet_operation_reports ORDER BY machine').all().map(r => {
      const { localTasks, ...rest } = JSON.parse(String(r.report));
      return { machine: String(r.machine), received: Number(r.received), ...rest, ...(receipts && localTasks ? { localTasks } : {}) };
    });
  }
}
