import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker,type WorkerOptions} from 'node:worker_threads';

interface FrozenContext {id:string;project:string;role:string}

/** Only immutable role replies live off-thread. Existing task RPC stays on the dispatcher. */
export async function startTestContextServer(run:FrozenContext,createWorker=(source:string,options:WorkerOptions)=>new Worker(source,options)) {
 const folder=mkdtempSync(join(tmpdir(),'pyry-role-')),socket=join(folder,'api.sock');
 let worker:Worker;
 try {
  worker=createWorker(`
   const {createServer}=require('node:http');
   const {parentPort,workerData}=require('node:worker_threads');
   const reply=JSON.stringify(workerData.context);
   const server=createServer((req,res)=>{
    req.resume();
    if(req.method!=='POST'||req.url!=='/test-context') {
     res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"Unknown context action"}');return;
    }
    res.writeHead(200,{'Content-Type':'application/json'});res.end(reply);
   });
   server.requestTimeout=3000;
   server.on('error',error=>{throw error;});
   server.listen(workerData.socket,()=>parentPort.postMessage('ready'));
   parentPort.on('message',message=>{
    if(message==='close') {
     server.close(()=>parentPort.close());server.closeAllConnections();
    }
   });
  `,{eval:true,execArgv:[],env:{},name:'managed-test-role',workerData:{socket,context:{version:1,runId:run.id,project:run.project,role:run.role,origin:'agent'}}});
 }catch(error){rmSync(folder,{recursive:true});throw error;}
 let exited=false;
 const exit=new Promise<void>(resolve=>worker.once('exit',()=>{exited=true;resolve();}));
 let startupTimer:ReturnType<typeof setTimeout>;
 const ready=new Promise<void>((resolve,reject)=>{
  startupTimer=setTimeout(()=>reject(new Error('Managed test role responder did not become ready')),15000);
  worker.once('message',message=>message==='ready'?resolve():reject(new Error('Invalid role responder readiness')));worker.once('error',reject);
  worker.once('exit',code=>reject(new Error(`Managed test role responder exited before admission: ${code}`)));
 });
 try {await ready;}
 catch(error){await worker.terminate();await exit;rmSync(folder,{recursive:true});throw error;}
 finally {clearTimeout(startupTimer!);}
 let disposed=false;
 return {socket,worker,close:async()=>{
  if(disposed)return;disposed=true;
  if(!exited)worker.postMessage('close');
  await exit;
  // Only this responder's private directory, including a stale Unix socket
  // after an unexpected worker exit, is removed here.
  rmSync(folder,{recursive:true});
 }};
}
