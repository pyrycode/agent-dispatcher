import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {runClaudeStreaming} from './dispatch.js';

// Real runner processes and real Python wait reports, with no model or network.
// No wait output is returned to the agent. Waiting exceeds the old wall ceiling.
for(const runner of ['codex','claude'] as const)test(`${runner}: redirected/background admission waits leave the active work budget intact`,{timeout:20000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'admission-runner-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const previous={grace:process.env.PYRY_TIMEOUT_GRACE_MINUTES,idle:process.env.PYRY_AGENT_IDLE_TIMEOUT_MINUTES,legacy:process.env.PYRY_USE_LEGACY_CLAUDE};
 process.env.PYRY_TIMEOUT_GRACE_MINUTES='0';process.env.PYRY_AGENT_IDLE_TIMEOUT_MINUTES='0.05';delete process.env.PYRY_USE_LEGACY_CLAUDE;
 t.after(()=>{for(const [key,value] of [['PYRY_TIMEOUT_GRACE_MINUTES',previous.grace],['PYRY_AGENT_IDLE_TIMEOUT_MINUTES',previous.idle],['PYRY_USE_LEGACY_CLAUDE',previous.legacy]])value===undefined?delete process.env[key!]:process.env[key!]=value;});
 const helper=fileURLToPath(new URL('../scripts/test-wait.py',import.meta.url));
 const python=execFileSync('which',['python3'],{encoding:'utf8'}).trim();
 const code=`import runpy,time\nw=runpy.run_path(${JSON.stringify(helper)})['AdmissionWait']()\nfor _ in range(80):\n w.heartbeat()\n time.sleep(.1)\nw.finish()\n`;
 const bin=join(root,'pyry');
 writeFileSync(bin,`#!${process.execPath}
 const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');
 const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');
 if(${JSON.stringify(runner)}==='codex')out({type:'thread.started',thread_id:'wait-test'});
 const child=spawn(${JSON.stringify(python)},['-c',${JSON.stringify(code)}],{env:process.env,stdio:'ignore'});
 child.on('exit',code=>{
  if(code!==0)process.exit(2);
  fs.writeFileSync('observed.json',JSON.stringify({budget:JSON.parse(fs.readFileSync(path.join(process.env.PYRY_TEST_WAIT_DIRECTORY,'budget.json'),'utf8')),argv:process.argv.slice(2)}));
  setTimeout(()=>{
   if(${JSON.stringify(runner)}==='codex'){
    out({type:'item.completed',item:{id:'final',type:'agent_message',text:JSON.stringify({status:'completed',summary:'tests finished'})}});
    out({type:'turn.completed',usage:{}});
   }else out({type:'result',is_error:false,result:'tests finished',session_id:'wait-test',terminal_reason:'completed'});
  },1200);
 });
 `);chmodSync(bin,0o700);
 writeFileSync(join(root,'prompt'),'task');writeFileSync(join(root,'role'),'role');
 const result=await runClaudeStreaming({runner,cwd:root,promptFile:join(root,'prompt'),systemPromptFile:join(root,'role'),model:'fixture',effort:'high',maxTurns:10,allowedTools:'Bash',disallowedTools:'',timeoutMs:4000,logFile:join(root,'run.log'),env:{PATH:root+':'+process.env.PATH,PYRY_CODEX_BIN:bin}});
 assert.equal(result.isError,false,JSON.stringify(result)+'\n'+readFileSync(join(root,'run.log'),'utf8'));assert.equal(result.timedOut,false);
 assert.ok(result.waitCreditMs!>=7900);
 const observed=JSON.parse(readFileSync(join(root,'observed.json'),'utf8'));
 assert.ok(observed.budget.remainingMs>=1500,'the agent can see its working time instead of guessing from elapsed time');
 if(runner==='codex'){
  assert.equal(observed.argv.at(-1),'-');
  assert.ok(observed.argv.some((arg:string)=>arg.startsWith('shell_environment_policy.set.PYRY_TEST_WAIT_DIRECTORY=')));
 }
});
