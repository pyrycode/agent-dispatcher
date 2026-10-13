import {execFileSync} from 'node:child_process';
import {writeFileSync,openSync,closeSync,readSync,fstatSync,existsSync,readFileSync,appendFileSync,fchmodSync} from 'node:fs';
import {basename,join} from 'node:path';
import {scrubSpawnEnv,scrubCredentials} from './agent-runtime.js';

function boundedDiagnostic(text:string):string {
 const clean=scrubCredentials(text);
 return clean.length<=16000?clean:clean.slice(0,8000)+'\n[excerpt shortened; exact artifact retained privately]\n'+clean.slice(-7900);
}

/** The exact logs stay private. Decode complete results before bounding their excerpts. */
export function repairDiagnostics(directory:string,binding?:{taskId:string;ticket:string;candidateRevision?:string}):Record<string,string> {
 const files:Record<string,string>={};
 for(const name of ['builder','reviewer','install','test','typecheck','helpers']) {
  // Streaming logs may truncate the final agent message. Prefer the separately
  // retained result so a failed review's actual findings reach reassessment.
  // Claude's structured output can differ from its last narrative message.
  // Keep both privately and prefer the authoritative runner result.
  const output=join(directory,name+'.output.txt');
  const result=existsSync(output)?output:join(directory,name+'.result.txt');
  const path=(name==='builder'||name==='reviewer') && existsSync(result)?result:
   join(directory,name+(name==='builder'||name==='reviewer'?'.log':'.check.log'));
  if(!existsSync(path)) continue;
  let fd:number|undefined;
  try {
   fd=openSync(path,'r');
   const size=fstatSync(fd).size;
   // Result envelopes are often a single line longer than the log-tail limit.
   // A bounded full read preserves JSON structure; oversized results stay private.
   const cap=path===result?4*1024*1024:32000;
   if(path===result && size>cap) {
    files[name+'.diagnostic.log']='Agent result exceeds diagnostic parse limit; exact artifact retained privately.';
    continue;
   }
   const start=Math.max(0,size-cap),bytes=Buffer.alloc(Math.min(size,cap));
   const count=readSync(fd,bytes,0,bytes.length,start);
   const content=bytes.subarray(0,count).toString('utf8');
   // Drop a partial first line rather than exposing a truncated credential value.
   const complete=start>0?content.slice(content.indexOf('\n')<0?content.length:content.indexOf('\n')+1):content;
   let diagnostic=complete;
   if(path===result) {
    // Decode result envelopes before scrubbing so JSON-escaped credential
    // assignments in a finding are visible to the shared scrubber.
    try {
     let value=JSON.parse(diagnostic);
     if(typeof value?.summary==='string') {diagnostic=value.summary;try{value=JSON.parse(diagnostic);}catch{value=null;}}
     if(typeof value?.findings==='string') {
      diagnostic=String(value.decision)+'\n'+value.findings;
      if(name==='reviewer' && ['PASS','FAIL'].includes(value.decision)) {
       let findings=boundedDiagnostic(value.findings);
       // Bound the encoded artifact too; findings can contain many escaped characters.
       while(JSON.stringify({...binding,decision:value.decision,findings}).length>16000) {
        const half=Math.floor(findings.length*.4);
        findings=findings.slice(0,half)+'\n[excerpt shortened]\n'+findings.slice(-half);
       }
       files['reviewer.findings.json']=JSON.stringify({...binding,decision:value.decision,findings});
      }
     }
    }catch{ /* Plain agent output still receives ordinary credential scrubbing. */ }
   }
   const terminal=join(directory,name+'.check.result.json');
   if(existsSync(terminal)) diagnostic=readFileSync(terminal,'utf8').slice(0,2000)+'\n'+diagnostic;
   files[name+'.diagnostic.log']=boundedDiagnostic(diagnostic);
  }catch {
   files[name+'.diagnostic.log']='Diagnostic unavailable; exact artifact retained privately.';
  }finally{if(fd!==undefined)closeSync(fd);}
 }
 return files;
}

/** Unit checks use their own fixtures rather than the launching consumer's configuration. */
export function recoveryCheckEnv(parent:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
 return Object.fromEntries(Object.entries(scrubSpawnEnv(parent)).filter(([name])=>!name.startsWith('FLEET_')&&!name.startsWith('PYRY_')&&!['AGENTS_REPO_PATH','TARGET_REPO_PATH','TARGET_DEFAULT_BRANCH'].includes(name)));
}
export function runRecoveryCheck(program:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;log:string;timeout:number}):void {
 const started=Date.now(),fd=openSync(options.log,'w',0o600);
 fchmodSync(fd,0o600);
 let terminal:{outcome:string;status:number|null;signal:string|null;errorCode?:string;durationMs?:number}={outcome:'completed',status:0,signal:null};
 try {
  // Both streams write directly to the private file, preserving order and avoiding
  // buffered-output limits that can hide a check's actual failure.
  // pnpm otherwise aborts or prompts before replacing a mismatched modules store
  // with ignored stdin. Keep CI confined to installation, preserving test policy.
  const env=program==='pnpm' && args[0]==='install'?{...options.env,CI:'true'}:options.env;
  execFileSync(program,args,{cwd:options.cwd,env,stdio:['ignore',fd,fd],timeout:options.timeout});
 }catch(error) {
  const failure=error as {status?:number|null;signal?:string|null;code?:string;stdout?:Buffer|string;stderr?:Buffer|string};
  terminal={outcome:'failed',status:failure.status??null,signal:failure.signal??null,...(failure.code?{errorCode:failure.code}:{})};
  // Some executors return buffered diagnostics, including test fixtures.
  if(failure.stdout)appendFileSync(fd,failure.stdout);
  if(failure.stderr)appendFileSync(fd,failure.stderr);
  throw new Error('Check failed; private diagnostics: '+basename(options.log));
 }finally {
  closeSync(fd);
  terminal.durationMs=Date.now()-started;
  writeFileSync(options.log.replace(/\.log$/,'')+'.result.json',JSON.stringify(terminal),{mode:0o600});
 }
}
