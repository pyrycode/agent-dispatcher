import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {basename} from 'node:path';
import {scrubSpawnEnv} from './agent-runtime.js';

/** Unit checks use their own fixtures rather than the launching consumer's configuration. */
export function recoveryCheckEnv(parent:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
 return Object.fromEntries(Object.entries(scrubSpawnEnv(parent)).filter(([name])=>!name.startsWith('FLEET_')&&!name.startsWith('PYRY_')&&!['AGENTS_REPO_PATH','TARGET_REPO_PATH','TARGET_DEFAULT_BRANCH'].includes(name)));
}
export function runRecoveryCheck(program:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;log:string;timeout:number}):void {
 try {
  const output=execFileSync(program,args,{cwd:options.cwd,env:options.env,stdio:'pipe',timeout:options.timeout,maxBuffer:20*1024*1024});
  writeFileSync(options.log,output,{mode:0o600});
 }catch(error) {
  const failure=error as {stdout?:Buffer|string;stderr?:Buffer|string};
  writeFileSync(options.log,Buffer.concat([Buffer.from(failure.stdout??''),Buffer.from(failure.stderr??'')]),{mode:0o600});
  throw new Error('Check failed; private diagnostics: '+basename(options.log));
 }
}
