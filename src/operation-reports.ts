import type { DatabaseSync } from 'node:sqlite';
import { scrubCredentials } from './agent-runtime.js';

export class OperationReports {
  constructor(private db: DatabaseSync, private machines: string[], private now = Date.now) {
    db.exec('CREATE TABLE IF NOT EXISTS fleet_operation_reports (machine TEXT PRIMARY KEY, received INTEGER NOT NULL, report TEXT NOT NULL) STRICT;');
  }
  record(machine: string, value: any): void {
    if (!this.machines.includes(machine) || !value || !Array.isArray(value.operations) || value.operations.length > 20) throw new Error('Invalid operation report');
    const phases = ['current','stopped','drain-requested','draining','start-requested','verifying','complete','attention','preflight-failed','changed-before-drain'];
    const operations = value.operations.map((o: any) => {
      if (!o || !/^[\w.-]+\/[\w.-]+$/.test(o.project ?? '') || !phases.includes(o.phase)) throw new Error('Invalid operation status');
      return {project:o.project,phase:o.phase,...(typeof o.reason === 'string' ? {reason:scrubCredentials(o.reason.slice(0,1000))} : {})};
    });
    const report = {operations,...(value.service === 'attention' ? {service:'attention',reason:scrubCredentials(String(value.reason ?? 'Control service unavailable').slice(0,1000))} : {})};
    this.db.prepare('INSERT INTO fleet_operation_reports VALUES (?,?,?) ON CONFLICT(machine) DO UPDATE SET received=excluded.received,report=excluded.report').run(machine,this.now(),JSON.stringify(report));
  }
  list() { return this.db.prepare('SELECT * FROM fleet_operation_reports ORDER BY machine').all().map(r => ({machine:String(r.machine),received:Number(r.received),...JSON.parse(String(r.report))})); }
}
