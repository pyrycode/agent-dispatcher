/** Explicit operator-requested Desktop verification transfer. Pending requests own no capacity. */
import type {DatabaseSync} from 'node:sqlite';
export const VERIFIER_HANDOFF_MS=180_000;
export interface VerifierHandoffRequest {
 commandId:string;ticket:string;source:string;generation:string;revision:number;candidate:string;target:string;
}
export interface VerificationPin {handoff:string;candidate:string;revision:number;sourceGeneration:string}
export interface VerifierHandoff extends VerifierHandoffRequest {
 created:number;expires:number;state:'pending'|'admitted'|'accepted'|'cancelled';acceptedRunId?:string;sourceSession?:string;sourceAt?:number;runId?:string;reason?:string;
}
export function validateHandoff(input:VerifierHandoffRequest):void {
 if(!input || ['commandId','ticket','source','generation','candidate','target'].some(k=>typeof (input as unknown as Record<string,unknown>)[k]!=='string') || input.ticket.length>250 || input.source.length>250 || input.target.length>250 || Object.keys(input).some(k=>!['commandId','ticket','source','generation','revision','candidate','target'].includes(k)) || !/^[\w.:-]{1,160}$/.test(input.commandId)||!/^pyrycode\/pyrycode-desktop#[1-9]\d*$/.test(input.ticket)
  || !/^[a-f0-9]{40}$/.test(input.candidate)||!Number.isSafeInteger(input.revision)||input.revision<1
  || !input.generation || input.generation.length>200 || !/^[\w.-]+$/.test(input.source)||! /^[\w.-]+$/.test(input.target)||input.source===input.target)
  throw new Error('Invalid Desktop verifier handoff');
}
export class VerifierHandoffs {
 constructor(private db:DatabaseSync,private now:()=>number){
  db.exec('CREATE TABLE IF NOT EXISTS fleet_verifier_handoffs(id TEXT PRIMARY KEY,ticket TEXT NOT NULL,request TEXT NOT NULL,record TEXT NOT NULL) STRICT; CREATE INDEX IF NOT EXISTS verifier_handoff_ticket ON fleet_verifier_handoffs(ticket)');
 }
 get(id:string):VerifierHandoff {const row=this.db.prepare('SELECT record FROM fleet_verifier_handoffs WHERE id=?').get(id);if(!row)throw new Error('Unknown verifier handoff');return JSON.parse(String(row.record));}
 save(record:VerifierHandoff){this.db.prepare('UPDATE fleet_verifier_handoffs SET record=? WHERE id=?').run(JSON.stringify(record),record.commandId);return record;}
 request(input:VerifierHandoffRequest,guard:()=>void):VerifierHandoff {
  validateHandoff(input);
  input={commandId:input.commandId,ticket:input.ticket,source:input.source,generation:input.generation,revision:input.revision,candidate:input.candidate,target:input.target};
  const old=this.db.prepare('SELECT request FROM fleet_verifier_handoffs WHERE id=?').get(input.commandId);
  if(old){if(String(old.request)!==JSON.stringify(input))throw new Error('Handoff command identity reused');return this.get(input.commandId);}
  guard();if(this.pending().some(r=>r.ticket===input.ticket))throw new Error('Ticket already has a pending handoff');
  const record:VerifierHandoff={...input,created:this.now(),expires:this.now()+VERIFIER_HANDOFF_MS,state:'pending'};
  this.db.prepare('INSERT INTO fleet_verifier_handoffs VALUES(?,?,?,?)').run(input.commandId,input.ticket,JSON.stringify(input),JSON.stringify(record));return record;
 }
 pending():VerifierHandoff[]{return this.db.prepare("SELECT record FROM fleet_verifier_handoffs WHERE json_extract(record,'$.state')='pending'").all().map(r=>JSON.parse(String(r.record)) as VerifierHandoff).filter(r=>r.state==='pending');}
 cancel(id:string,reason='Operator cancelled'):VerifierHandoff {const record=this.get(id);if(record.state==='admitted'||record.state==='accepted')throw new Error('Admitted handoff keeps its reservation');return record.state==='cancelled'?record:this.save({...record,state:'cancelled',reason});}
 active(valid:(record:VerifierHandoff)=>boolean):VerifierHandoff[]{
  return this.pending().filter(r=>{if(this.now()>=r.expires||!valid(r)){this.cancel(r.commandId,this.now()>=r.expires?'Request expired':'Ownership, workflow or controls changed');return false;}return true;});
 }
}
