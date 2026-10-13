import type { DatabaseSync } from 'node:sqlite';
import { scrubCredentials } from './agent-runtime.js';

export const OPERATION_PHASES: readonly string[] = ['current','stopped','drain-requested','draining','start-requested','verifying','complete','attention','preflight-failed','changed-before-drain','waiting-for-native-task'];

const AUTOMATIC_CHANGES = ['health-latch-cleared','operation-retired','native-task-unrecoverable','native-task-skipped'];

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
    const report = {operations,...(housekeeping.length ? {housekeeping} : {}),...(value.service === 'attention' ? {service:'attention',reason:scrubCredentials(String(value.reason ?? 'Control service unavailable').slice(0,1000))} : {})};
    this.db.prepare('INSERT INTO fleet_operation_reports VALUES (?,?,?) ON CONFLICT(machine) DO UPDATE SET received=excluded.received,report=excluded.report').run(machine,this.now(),JSON.stringify(report));
  }
  list() { return this.db.prepare('SELECT * FROM fleet_operation_reports ORDER BY machine').all().map(r => ({machine:String(r.machine),received:Number(r.received),...JSON.parse(String(r.report))})); }
}
