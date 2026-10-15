import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readJson,listen, type JsonClient} from './fleet-http.js';
import type {FleetRun} from './fleet-store.js';

/**
 * What one run's socket accepts. `tasks`: request and read native checks,
 * builders and developers only. `evidence`: read the shared evidence of any
 * ticket's earlier runs (evidence-store.ts), every agent.
 */
export interface BridgeActions {tasks:boolean;evidence:boolean}

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

/** A private, per-run socket carries fixed requests. Children receive no fleet credential. */
export async function taskBridge(connection:JsonClient,run:FleetRun,actions:BridgeActions={tasks:true,evidence:false}) {
 const socket=join(mkdtempSync(join(tmpdir(),'pyry-task-')),'api.sock');
 const server=createServer(async(req,res)=>{
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  try {
   const url=req.url??'';
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
   if(req.method!=='POST' || !actions.tasks || !['/request','/read','/artifact'].includes(url)) return send(404,{error:'Unknown task action'});
   const body=await readJson(req);
   send(200,await connection.call('/tasks'+url,{...body,project:run.project,session:run.session,runId:run.id}));
  }catch {send(409,{error:'Task request unavailable or outside this admitted ticket'});}
 });
 server.requestTimeout=15000;await listen(server,socket);
 return {socket,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
