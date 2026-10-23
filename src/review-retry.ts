/** Explicit operator handback of a completed failed review, never acceptance. */
import type {DatabaseSync} from 'node:sqlite';
import type {WorkflowItem} from './workflow-store.js';
export interface ReviewRetryRequest {
 commandId:string; ticket:string; revision:number; incidentId:string; runId:string;
 candidate:string; pullRequest:number; reason:string;
}
export function reviewRetryRequest(value:ReviewRetryRequest):ReviewRetryRequest {
 if(!value || Object.keys(value).some(k=>!['commandId','ticket','revision','incidentId','runId','candidate','pullRequest','reason'].includes(k))
  || typeof value.commandId!=='string' || !/^[\w.:-]{1,160}$/.test(value.commandId)
  || typeof value.ticket!=='string' || !/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(value.ticket)
  || !Number.isSafeInteger(value.revision) || value.revision<1
  || typeof value.incidentId!=='string' || !/^[a-f0-9-]{36}$/.test(value.incidentId)
  || typeof value.runId!=='string' || !/^[\w.:@-]{1,128}$/.test(value.runId)
  || typeof value.candidate!=='string' || !/^[a-f0-9]{40}$/.test(value.candidate)
  || !Number.isSafeInteger(value.pullRequest) || value.pullRequest<1
  || typeof value.reason!=='string' || !value.reason.trim() || value.reason.length>6000)throw new Error('Invalid review retry request');
 return {commandId:value.commandId,ticket:value.ticket,revision:value.revision,incidentId:value.incidentId,
  runId:value.runId,candidate:value.candidate,pullRequest:value.pullRequest,reason:value.reason};
}
export class ReviewRetries {
 constructor(private db:DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS fleet_review_retries (id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL) STRICT');
 }
 saved(input:ReviewRetryRequest):WorkflowItem|undefined {
  const old=this.db.prepare('SELECT request,result FROM fleet_review_retries WHERE id=?').get(input.commandId);
  if(!old)return;
  if(old.request!==JSON.stringify(input))throw new Error('Review retry command identity reused');
  return JSON.parse(String(old.result));
 }
 save(input:ReviewRetryRequest,result:WorkflowItem):WorkflowItem {
  this.db.prepare('INSERT INTO fleet_review_retries VALUES (?,?,?)').run(input.commandId,JSON.stringify(input),JSON.stringify(result));
  return result;
 }
}
