import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readJson,listen, type JsonClient} from './fleet-http.js';
import type {FleetRun} from './fleet-store.js';

/** A private, per-run socket carries fixed requests. Children receive no fleet credential. */
export async function taskBridge(connection:JsonClient,run:FleetRun) {
 const socket=join(mkdtempSync(join(tmpdir(),'pyry-task-')),'api.sock');
 const server=createServer(async(req,res)=>{
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  try {
   if(req.method!=='POST' || !['/request','/read'].includes(req.url??'')) return send(404,{error:'Unknown task action'});
   const body=await readJson(req);
   const payload=req.url==='/request'?{request:body}:body;
   send(200,await connection.call('/tasks'+req.url,{...payload,project:run.project,session:run.session,runId:run.id}));
  }catch {send(409,{error:'Task request unavailable or outside this admitted ticket'});}
 });
 server.requestTimeout=15000;await listen(server,socket);
 return {socket,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
