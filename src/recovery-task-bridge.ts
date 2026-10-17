import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readJson,listen, type JsonClient} from './fleet-http.js';
import type {FleetRun} from './fleet-store.js';
import {recoveryTaskId,validateTaskRequest} from './recovery-tasks.js';
import {NON_AGENT_ROLES} from './codex-throttle.js';

/**
 * What one run's socket accepts.
 *
 * `request`: schedule a native check. Builders and developers only: a check
 * spends heavy time on the Mac or the Android host, and the stages after the
 * builder judge evidence rather than make it.
 *
 * `read`: read a native task, its artifacts, and wait for it (the helper's
 * `read` and `await`). Every agent role of a numbered ticket but a recovery
 * assessment (readsNativeTasks). The claim
 * service answers only for a task of the run's own ticket, while the run is
 * active (FleetStore.readTask), so a run never reads another ticket's tasks.
 * Until agent-dispatcher PR 206's single `tasks` switch was split, reads went
 * with requests, so a verifier or documentation run could not read the
 * native result its builder asked for (Desktop #1998, 2026-10-15).
 *
 * `evidence`: read the shared evidence of any ticket's earlier runs
 * (evidence-store.ts), every agent.
 */
export interface BridgeActions {request:boolean;read:boolean;evidence:boolean}

/** Roles whose runs may request a native check. */
export const TASK_REQUEST_ROLES: ReadonlySet<string> = new Set(['builder','developer']);

/**
 * Roles whose runs read their ticket's native tasks: every agent role, with
 * two exceptions. Recovery assessments get each task's state, summary and a
 * failed task's bounded, scrubbed diagnostics in their facts, by design
 * (recovery-tasks.ts `assessmentTasks`), and full artifacts would widen that.
 * Dispatcher jobs such as merge, reconcile and codegraph start no agent.
 */
export function readsNativeTasks(role:string):boolean {
 return !NON_AGENT_ROLES.has(role) && role!=='recovery';
}

/** Newest bundles one evidence list returns through the socket: the helper reads at most 2 MiB a reply. */
export const BRIDGE_EVIDENCE_BUNDLES=5;

/** `12`, `#12` or `owner/repo#12`; a bare number is this run's project. */
export function evidenceTicket(value:unknown,project:string):string {
 const raw=typeof value==='number'?String(value):typeof value==='string'?value.trim():'';
 const n=raw.match(/^#?([1-9]\d*)$/);
 if(n) return `${project}#${n[1]}`;
 if(/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(raw)) return raw;
 throw new Error('Invalid evidence ticket');
}

/**
 * A private, per-run socket carries fixed requests. Children receive no fleet credential.
 * `requested()` names the tasks this run asked for, so its handover can wait
 * for them (native-task-hold.ts). An id is recorded before the request is
 * sent, from the same identity the claim service gives the task, so a reply
 * lost on the way back still counts.
 */
export async function taskBridge(connection:JsonClient,run:FleetRun,actions:BridgeActions={request:true,read:true,evidence:false}) {
 const socket=join(mkdtempSync(join(tmpdir(),'pyry-task-')),'api.sock');
 const requested=new Set<string>();
 const server=createServer(async(req,res)=>{
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  try {
   const url=req.url??'';
   if(req.method==='POST' && url==='/test-context') {
    // The socket belongs to one admitted run. Client-supplied roles, origins
    // and environment variables never change that authority.
    await readJson(req);
    return send(200,{version:1,runId:run.id,project:run.project,role:run.role,origin:'agent'});
   }
   if(req.method==='POST' && url==='/investigate') {
    if(!TASK_REQUEST_ROLES.has(run.role))return send(403,{error:'Wider investigation requests are for builder and developer runs'});
    const body=await readJson(req);
    return send(200,await connection.call('/tasks/investigate',{request:body.request,project:run.project,session:run.session,runId:run.id}));
   }
   if(req.method==='POST' && actions.evidence && ['/evidence-list','/evidence-chunk'].includes(url)) {
    const body=await readJson(req);
    const ticket=evidenceTicket(body.ticket,run.project);
    if(url==='/evidence-list') {
     const limit=Number.isSafeInteger(body.limit)&&body.limit>0?Math.min(body.limit,BRIDGE_EVIDENCE_BUNDLES):BRIDGE_EVIDENCE_BUNDLES;
     const listing=await connection.call<{bundles:unknown[]}>('/evidence/list',{ticket,...(typeof body.runId==='string'?{runId:body.runId}:{})});
     return send(200,{ticket,bundles:listing.bundles.slice(0,limit)});
    }
    return send(200,await connection.call('/evidence/chunk',{ticket,runId:body.runId,digest:body.digest,path:body.path,part:body.part}));
   }
   const allowed=req.method==='POST' && (url==='/request'?actions.request:['/read','/artifact'].includes(url) && actions.read);
   if(!allowed) {
    // Say why a reader cannot request, rather than that the action is unknown.
    if(req.method==='POST' && url==='/request' && actions.read) return send(403,{error:'Native check requests are for builder and developer runs; this run can read and await this ticket\'s tasks'});
    return send(404,{error:'Unknown task action'});
   }
   const body=await readJson(req);
   if(url==='/request') {
    if(TASK_REQUEST_ROLES.has(run.role) && body.request?.recipe==='mobile-in-depth')return send(403,{error:'Test selection policy: complete Mobile suites are dispatcher-owned. Submit investigate with retained failed-test evidence and requested scope; no diagnostic has executed.'});
    try {requested.add(recoveryTaskId(run.ticket,validateTaskRequest(body.request),run.id));}catch {/* invalid: the service refuses it too */}
   }
   const reply=await connection.call<{id?:unknown}>('/tasks'+url,{...body,project:run.project,session:run.session,runId:run.id});
   if(url==='/request' && typeof reply?.id==='string') requested.add(reply.id);
   send(200,reply);
  }catch {send(409,{error:'Task request unavailable or outside this admitted ticket'});}
 });
 server.requestTimeout=15000;await listen(server,socket);
 return {socket,requested:()=>[...requested],close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
