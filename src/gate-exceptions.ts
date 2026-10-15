import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {release} from 'node:os';
import {XMLParser} from 'fast-xml-parser';
import {parseGateOutput,type GateOutputFormat} from './gate-output.js';

export interface GateExceptionInput {
 policyFile:string;project:string;gate:string;test:string;tracker:number;format:GateOutputFormat;
 branchPath:string;basePath?:string|null;cwd:string;base:string;head:string;securitySensitive?:boolean;
}
export interface GateException {
 project:string;gate:string;test:string;tracker:number;signature:string;environment:string;
 approvedBy:'Juhana';approvedAt:string;expiresAt:string;allowedPaths:string[];
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const diagnostic=(v:any):string=>typeof v==='string'?v: v&&typeof v==='object'?[v['@_message'],v['#text']].filter(x=>typeof x==='string').join('\n'):'';

/** Hash exact diagnostics. Test names and pass/fail totals are insufficient. */
export function failureSignature(raw:string,format:GateOutputFormat,name:string):string|null {
 if(Buffer.byteLength(raw)>8*1024*1024) return null;
 const tally=parseGateOutput(raw,format);
 if(!tally.completeParse || !tally.failedNames.includes(name) || tally.abnormalExit) return null;
 const parts:string[]=[];
 try {
  if(format==='go-json') {
   for(const line of raw.split('\n')) {
    let event:any;try {event=JSON.parse(line);} catch {continue;}
    if(event.Action==='output' && event.Package+'.'+event.Test===name && typeof event.Output==='string'
      && !/^\s*(=== (RUN|PAUSE|CONT)|--- (FAIL|PASS|SKIP):)/.test(event.Output)) parts.push(event.Output);
   }
  } else if(format==='playwright-json') {
   const walk=(suite:any,trail:string[]):void=>{
    const titles=suite.title?[...trail,suite.title]:trail;
    for(const spec of suite.specs??[]) if([...titles,spec.title].join(' › ')===name) {
     for(const test of spec.tests??[]) for(const attempt of test.results??[]) if(['failed','timedOut','interrupted'].includes(attempt.status)) {
      for(const error of [...(attempt.errors??[]),...(attempt.error?[attempt.error]:[])]) parts.push(error.message??error.stack??'');
     }
    }
    for(const child of suite.suites??[]) walk(child,titles);
   };
   for(const suite of JSON.parse(raw).suites) walk(suite,[]);
  } else {
   const doc=new XMLParser({ignoreAttributes:false,isArray:key=>['testsuite','testcase','failure','error'].includes(key)}).parse(raw);
   const walk=(suite:any):void=>{
    for(const test of suite.testcase??[]) if((test['@_classname']||suite['@_name']||'JUnit runner')+'#'+test['@_name']===name)
     for(const entry of [...(test.failure??[]),...(test.error??[])]) parts.push(diagnostic(entry));
    for(const child of suite.testsuite??[]) walk(child);
   };
   for(const suite of doc.testsuite??doc.testsuites?.testsuite??[]) walk(suite);
  }
 } catch {return null;}
 const diagnostics=parts.map(part=>part.replace(/\u001b\[[0-9;]*m/g,'').trim()).filter(Boolean);
 return diagnostics.length?hash(JSON.stringify(diagnostics)):null;
}
export function gateEnvironment(gate:string):string {
 return hash(JSON.stringify([process.platform,process.arch,release(),process.version,gate,
  process.env.PYRY_RUNTIME_DIGEST??null,process.env.PYRY_TEST_DAEMON_REVISION??null]));
}
export function exceptionRefusal(record:GateException,input:{project:string;gate:string;test:string;tracker:number;branch:string|null;base:string|null;environment:string;paths:string[]},now=Date.now()):string|null {
 const approved=Date.parse(record.approvedAt),expires=Date.parse(record.expiresAt);
 if(record.approvedBy!=='Juhana' || !Number.isFinite(approved) || approved>now || !Number.isFinite(expires) || expires<=now || expires<=approved || expires-approved>7*86400_000) return 'The exception is unapproved, expired or longer than seven days';
 if(record.project!==input.project || record.gate!==input.gate || record.test!==input.test || record.tracker!==input.tracker) return 'The exception belongs to another project, gate, test or tracker';
 if(!input.branch || input.branch!==input.base || input.branch!==record.signature || !/^[a-f0-9]{64}$/.test(record.signature)) return 'Branch and baseline diagnostics do not match the approved failure';
 if(record.environment!==input.environment) return 'The test environment differs from the approved baseline';
 if(/security|secret|crypto|credential|permission|auth|data race|panic/i.test(input.test+' '+input.paths.join(' '))) return 'Security failures and affected security paths cannot use automatic exceptions';
 if(!Array.isArray(record.allowedPaths) || !record.allowedPaths.length || record.allowedPaths.some(p=>typeof p!=='string'||!p||p==='.'||p==='/'||p.includes('*')||p.split('/').includes('..'))
  || input.paths.some(p=>!record.allowedPaths.some(allowed=>allowed.endsWith('/')?p.startsWith(allowed):p===allowed))) return 'The change is outside the approved path scope';
 return null;
}

/** Protected configuration and retained branch/base reports decide acceptance. */
export function checkInheritedException(input:GateExceptionInput,now=Date.now()):string|null {
 try {
  if(input.securitySensitive) return 'Security-sensitive tickets cannot use automatic exceptions';
  if(!input.basePath || !/^[a-f0-9]{40}$/.test(input.base) || !/^[a-f0-9]{40}$/.test(input.head)) return 'Readable exact branch and baseline evidence is required';
  if(lstatSync(input.policyFile).isSymbolicLink()) return 'The exception policy cannot be a symbolic link';
  const inside=relative(realpathSync(input.cwd),realpathSync(input.policyFile));
  if(!isAbsolute(inside) && inside!=='..' && !inside.startsWith('..'+sep)) return 'The exception policy must be outside the ticket checkout';
  const policy=JSON.parse(readFileSync(input.policyFile,'utf8'));
  if(policy.version!==1 || !Array.isArray(policy.exceptions) || policy.exceptions.length>200) return 'The exception policy is invalid';
  const records:GateException[]=policy.exceptions.filter((r:GateException)=>r&&r.project===input.project&&r.gate===input.gate&&r.test===input.test&&r.tracker===input.tracker);
  if(records.length!==1) return 'One explicit approved exception is required for this failure';
  const paths=execFileSync('git',['diff','--name-only','-z',input.base+'...'+input.head],{cwd:input.cwd,encoding:'utf8',stdio:'pipe',timeout:30_000}).split('\0').filter(Boolean);
  return exceptionRefusal(records[0],{...input,branch:failureSignature(readFileSync(input.branchPath,'utf8'),input.format,input.test),
   base:failureSignature(readFileSync(input.basePath,'utf8'),input.format,input.test),environment:gateEnvironment(input.gate),paths},now);
 } catch {return 'No readable approved exception and complete matching baseline evidence';}
}
