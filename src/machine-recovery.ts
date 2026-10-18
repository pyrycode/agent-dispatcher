/** A stopped dispatcher's work stays on disk while another computer retries its stage. */
import type {DatabaseSync} from 'node:sqlite';

export interface MachineRecoveryRequest {
  commandId: string;
  machine: string;
  runId: string;
  session: string;
  generation: string;
  revision: number;
  proof: 'container-stopped' | 'native-stopped';
  retainedDigest: string;
}
export interface MachineRecovery extends MachineRecoveryRequest {
  ticket: string;
  project: string;
  role: string;
  created: number;
  cleared?: number;
}
export function validateMachineRecovery(value: MachineRecoveryRequest): void {
  const fields = ['commandId','machine','runId','session','generation','revision','proof','retainedDigest'];
  if (!value || Object.keys(value).some(k => !fields.includes(k)) ||
      fields.filter(k => k !== 'revision').some(k => typeof (value as unknown as Record<string,unknown>)[k] !== 'string') ||
      !/^[\w.:-]{1,160}$/.test(value.commandId) || !/^[\w.-]{1,100}$/.test(value.machine) ||
      [value.runId,value.session,value.generation].some(v => !v || v.length > 250) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !['container-stopped','native-stopped'].includes(value.proof) || !/^[a-f0-9]{64}$/.test(value.retainedDigest)) {
    throw new Error('Invalid stopped-worker recovery receipt');
  }
}
export class MachineRecoveries {
  constructor(private db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS fleet_machine_recoveries(id TEXT PRIMARY KEY, machine TEXT NOT NULL, project TEXT NOT NULL, request TEXT NOT NULL, record TEXT NOT NULL) STRICT');
  }
  replay(request: MachineRecoveryRequest): MachineRecovery | undefined {
    const row = this.db.prepare('SELECT * FROM fleet_machine_recoveries WHERE id=?').get(request.commandId);
    if (!row) return undefined;
    // Compare fields in a fixed order, independently of JSON property order.
    const prior = JSON.parse(String(row.request));
    if (Object.keys(prior).some(k => prior[k] !== (request as unknown as Record<string,unknown>)[k])) throw new Error('Recovery command identity reused');
    return JSON.parse(String(row.record));
  }
  list(): MachineRecovery[] {
    return this.db.prepare('SELECT record FROM fleet_machine_recoveries ORDER BY rowid').all().map(r => JSON.parse(String(r.record)));
  }
  blocked(machine: string, project: string): boolean {
    return this.list().some(r => r.machine === machine && r.project === project && r.cleared === undefined);
  }
  save(request: MachineRecoveryRequest, record: MachineRecovery): void {
    this.db.prepare('INSERT INTO fleet_machine_recoveries VALUES(?,?,?,?,?)').run(request.commandId,request.machine,record.project,JSON.stringify(request),JSON.stringify(record));
  }
  clear(machine: string, project: string, ids: string[], now: number): void {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Inspect the recovery receipts before clearing the source hold');
    const records = this.list().filter(r => r.machine === machine && r.project === project);
    if (ids.some(id => !records.some(r => r.commandId === id)) || records.some(r => r.cleared === undefined && !ids.includes(r.commandId))) throw new Error('Recovery receipts changed; inspect them again');
    for (const r of records.filter(r => ids.includes(r.commandId) && r.cleared === undefined)) {
      this.db.prepare('UPDATE fleet_machine_recoveries SET record=? WHERE id=?').run(JSON.stringify({...r,cleared:now}),r.commandId);
    }
  }
}
