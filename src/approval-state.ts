import type {DatabaseSync} from 'node:sqlite';
import {scrubCredentials} from './agent-runtime.js';

export interface ApprovalState {
  ticket:string; runId:string; role:string; kind:'review_failed'|'rejected'; created:number;
  authorization?:{commandId:string; reason:string; created:number};
}
export interface ApprovalOutcome {approvalReviewFailed:boolean; hadPermissionDenial:boolean}
export class ApprovalHandoffError extends Error {}

/** Only dispatcher-observed signals enter this store, never ticket prose. */
export class ApprovalStates {
  constructor(private db:DatabaseSync, private now=Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_approval_events (
      ticket TEXT NOT NULL, run_id TEXT PRIMARY KEY, record TEXT NOT NULL, created INTEGER NOT NULL
    ) STRICT; CREATE INDEX IF NOT EXISTS fleet_approval_ticket ON fleet_approval_events(ticket,created);`);
  }
  record(ticket:string,runId:string,role:string,outcome:ApprovalOutcome):ApprovalState|undefined {
    if(!outcome || Object.keys(outcome).some(k=>!['approvalReviewFailed','hadPermissionDenial'].includes(k))
      || typeof outcome.approvalReviewFailed!=='boolean' || typeof outcome.hadPermissionDenial!=='boolean') throw new Error('Invalid approval outcome');
    if(!outcome.approvalReviewFailed && !outcome.hadPermissionDenial) return;
    const kind=outcome.hadPermissionDenial?'rejected':'review_failed';
    const previous=this.db.prepare('SELECT record FROM fleet_approval_events WHERE run_id=?').get(runId);
    if(previous) {
      const saved=JSON.parse(String(previous.record)) as ApprovalState;
      if(saved.ticket!==ticket || saved.role!==role || saved.kind!==kind) throw new Error('Approval outcome identity reused');
      return saved;
    }
    const record:ApprovalState={ticket,runId,role,kind,created:this.now()};
    this.db.prepare('INSERT INTO fleet_approval_events VALUES (?,?,?,?)').run(ticket,runId,JSON.stringify(record),record.created);
    return record;
  }
  get(ticket:string):ApprovalState|undefined {
    // An unresolved rejection cannot be hidden by a later service outage.
    const row=this.db.prepare(`SELECT record FROM fleet_approval_events WHERE ticket=? ORDER BY
      (json_extract(record,'$.kind')='rejected' AND json_extract(record,'$.authorization') IS NULL) DESC,
      created DESC,rowid DESC LIMIT 1`).get(ticket);
    return row?JSON.parse(String(row.record)):undefined;
  }
  authorize(ticket:string,runId:string,commandId:string,reason:string):ApprovalState {
    if(typeof commandId!=='string' || !/^[\w.:@-]{1,128}$/.test(commandId)
      || typeof reason!=='string' || !reason.trim() || reason.length>2000 || scrubCredentials(reason)!==reason
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(reason)) throw new Error('Invalid operator approval decision');
    const record=this.get(ticket);
    if(!record || record.runId!==runId) throw new Error('Approval evidence changed; read again');
    if(record.authorization) {
      if(record.authorization.commandId!==commandId || record.authorization.reason!==reason) throw new Error('Approval decision identity reused');
      return record;
    }
    record.authorization={commandId,reason,created:this.now()};
    this.db.prepare('UPDATE fleet_approval_events SET record=? WHERE run_id=?').run(JSON.stringify(record),runId);
    return record;
  }
}

/** Fixed instructions. Display data and operator reasons are never executable prompt text. */
export function approvalHandoff(state:ApprovalState|undefined):string {
  if(!state) return '';
  const identity=JSON.stringify({ticket:state.ticket,runId:state.runId,role:state.role,kind:state.kind});
  return '\n## Recorded approval outcome\n'+identity+'\n'+(state.authorization
    ? 'The operator reviewed this recorded stop and authorised continuation of this ticket. Continue from the preserved work through normal approval checks. This does not bypass any new rejection or authorise unrelated operations.'
    : state.kind==='review_failed'
      ? 'The preceding automatic approval review failed to complete. It did not reject the action as unsafe. This is the dispatcher\'s bounded retry. A historical review-service failure alone does not require operator approval. Continue from preserved work and submit any necessary operation through the normal approval check. Do not treat this record as approval of that operation. A new safety rejection still requires stopping.'
      : 'The preceding automatic approval review rejected an action as unsafe. No operator continuation decision is recorded. Stop with status blocked. Do not replay or work around that action.');
}
