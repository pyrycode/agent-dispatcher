import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync,readdirSync,lstatSync,readFileSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {FleetClient} from './fleet-http.js';
import {withManagedTaskRun} from './managed-dispatch.js';
import type {GateSpawner} from './dispatch.js';
import type {StartRequest} from './fleet-store.js';

interface InteractiveConfig {
 machine:string;claimsUrl:string;claimsTokenEnv:string;projects:string[];receiptDirectory:string;timeoutMinutes?:number;
 idleCache?:{directory:string;maxBytes:number};
}
function cacheBytes(path:string):number {
 const stat=lstatSync(path);
 if(stat.isSymbolicLink()) return 0;
 if(stat.isFile()) return stat.size;
 return stat.isDirectory()?readdirSync(path).reduce((sum,name)=>sum+cacheBytes(resolve(path,name)),0):0;
}
const quote=(value:string)=>"'"+value.replace(/'/g,"'\"'\"'")+"'";

/** Local interactive suites use the same authority and process proof as fleet gates. */
export async function runAdmittedTests(config:InteractiveConfig,project:string,args:string[],spawner?:GateSpawner):Promise<number> {
 const minutes=config.timeoutMinutes??30;
 if(!config.machine || !Array.isArray(config.projects) || !config.projects.includes(project) || !isAbsolute(config.receiptDirectory)
  || !Number.isInteger(minutes) || minutes<1 || minutes>240 || !args.length || args.some(a=>typeof a!=='string'||a.includes('\0'))
  || !/^[A-Z][A-Z0-9_]*$/.test(config.claimsTokenEnv)) throw new Error('Configure the machine, project, private receipt directory and test timeout');
 const cache=config.idleCache;
 if(cache && (!isAbsolute(cache.directory)||!Number.isSafeInteger(cache.maxBytes)||cache.maxBytes<1)) throw new Error('Configure a dedicated Go cache and its positive byte limit');
 const credential=process.env[config.claimsTokenEnv];
 if(!credential) throw new Error('Missing configured machine credential');
 mkdirSync(config.receiptDirectory,{recursive:true,mode:0o700});
 if(lstatSync(config.receiptDirectory).isSymbolicLink() || lstatSync(config.receiptDirectory).mode&0o077) throw new Error('The receipt directory must be private');
 const directory=mkdtempSync(resolve(config.receiptDirectory,'interactive-'));
 const id=randomUUID(),session=randomUUID();
 const request:StartRequest={id,machine:config.machine,session,project,ticket:project+'#@interactive-'+id,role:'interactive-test',resource:'heavy',exclusiveMachine:true,locks:[],workflowVersion:1};
 const record=(state:string,extra:object={})=>writeFileSync(resolve(directory,'receipt.json'),JSON.stringify({request,pid:process.pid,state,...extra})+'\n',{mode:0o600});
 const client=new FleetClient(config.claimsUrl,credential);
 if(!(await client.snapshot()).features?.exclusiveTests) throw new Error('Update the controller before using exclusive interactive tests');
 record('requested');
 const granted=await client.start(request);
 if(!granted.ok) {record('refused',{reason:granted.reason});throw new Error('Test admission held: '+granted.reason);}
 let code=1;
 try {
  record('admitted',{generation:granted.generation});
  const result=await withManagedTaskRun({...request,generation:granted.generation,created:Date.now()},async()=>{
   const {buildGateSpawnEnv,spawnGateCommand}=await import('./dispatch.js');
   const run=spawner??spawnGateCommand;
   const env=buildGateSpawnEnv(process.env);
   if(cache && cacheBytes(cache.directory)>cache.maxBytes) {
    if(lstatSync(cache.directory).isSymbolicLink() || !readFileSync(resolve(cache.directory,'README'),'utf8').startsWith('This directory holds cached build artifacts from the Go build system.')) throw new Error('The configured directory is not an identified Go build cache');
    const cleaned=await run({command:'go clean -cache',cwd:process.cwd(),env:{...env,GOCACHE:cache.directory},timeoutMs:600_000,
     stdoutPath:resolve(directory,'cache.stdout.log'),stderrPath:resolve(directory,'cache.stderr.log')});
    if(cleaned.exitCode!==0 || cleaned.timedOut || cleaned.spawnError) return cleaned;
   }
   return run({command:args.map(quote).join(' '),cwd:process.cwd(),env,timeoutMs:minutes*60_000,
    stdoutPath:resolve(directory,'tests.stdout.log'),stderrPath:resolve(directory,'tests.stderr.log')});
  });
  code=result.exitCode===0 && !result.timedOut && !result.spawnError?0:1;
  return code;
 } finally {
  record('finishing',{generation:granted.generation,exitCode:code});
  await client.finish(session,id,code===0);
  record('finished',{generation:granted.generation,exitCode:code});
 }
}
