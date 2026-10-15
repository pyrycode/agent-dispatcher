import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {recoveryCheckEnv,runRecoveryCheck,repairDiagnostics} from './recovery-checks.js';

test('repair checks do not inherit another consumers production role or checkout',()=>{
 const parent={PATH:'/tools',HOME:'/private/home',PYRY_STAGE_SET:'builder',PYRY_VERIFIER_GATES:'production gate',SALVAGE_GATES:'npm run build',AGENTS_REPO_PATH:'/production/agents',TARGET_REPO_PATH:'/production/core',FLEET_ADMIN:'fixture',GITHUB_TOKEN:'fixture'};
 const env=recoveryCheckEnv(parent);
 assert.deepEqual(env,{PATH:'/tools',HOME:'/private/home'});
 assert.equal(parent.SALVAGE_GATES,'npm run build','production configuration stays intact');
});

test('salvage fixtures reject failing gates under the unchanged consumer launcher environment',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-inherited-gates-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 // The already-running parent computed checkEnv before this repair. Deliberately
 // put its leaked consumer setting back; fixing recoveryCheckEnv alone cannot help it.
 const env:NodeJS.ProcessEnv={...recoveryCheckEnv(process.env),SALVAGE_GATES:'npm run build',AGENTS_REPO_PATH:root,TARGET_REPO_PATH:root};
 delete env.NODE_TEST_CONTEXT;
 const result=childProcess.spawnSync(process.execPath,['--import','tsx','--test',
  '--test-name-pattern=committed timeout work with a failing build|consumer-configured salvage gate failure',
  'src/dispatch.test.ts'],{cwd:new URL('..',import.meta.url),env,encoding:'utf8',timeout:30000});
 assert.equal(result.error,undefined);
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/committed timeout work with a failing build/);
 assert.match(result.stdout,/consumer-configured salvage gate failure/);
});

test('real pnpm repairs mismatched stores with stdin ignored and the unchanged parent runs postinstall', {timeout:60000}, t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-pnpm-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const env=recoveryCheckEnv(process.env);
 // Only this fixture clears inherited install settings; check environments stay unchanged.
 for(const key of Object.keys(env)) if(/^(node_test_context|npm_config_(store_dir|ignore_scripts|userconfig))$/i.test(key)) delete env[key];
 env.CI='false';
 env.npm_config_userconfig=join(root,'unused.npmrc');
 writeFileSync(join(root,'.npmrc'),readFileSync(new URL('../.npmrc',import.meta.url)));
 mkdirSync(join(root,'dependency'));
 writeFileSync(join(root,'dependency/package.json'),JSON.stringify({name:'local-install-proof',version:'1.0.0',main:'index.cjs'}));
 writeFileSync(join(root,'dependency/index.cjs'),'module.exports = 2939;\n');
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'repair-install-proof',private:true,
  dependencies:{'local-install-proof':'file:dependency'},scripts:{postinstall:'node postinstall.cjs'}}));
 writeFileSync(join(root,'postinstall.cjs'),"require('node:fs').writeFileSync('postinstall.json', JSON.stringify({ci:process.env.CI??null,value:require('local-install-proof')}));\n");
 const oldStore=join(root,'old-store');
 childProcess.execFileSync('pnpm',['install','--store-dir',oldStore,'--ignore-scripts','--offline'],{cwd:root,env,stdio:'ignore',timeout:15000});
 const lock=readFileSync(join(root,'pnpm-lock.yaml'));
 assert.equal(existsSync(join(root,'postinstall.json')),false);
 const modulesBefore=readFileSync(join(root,'node_modules/.modules.yaml'));
 assert.ok(modulesBefore.toString().includes(oldStore));
 // This is the deployed parent's exact frozen-lockfile command and ignored stdin.
 // Depending on pnpm's version, it aborts or exits at an unanswered removal prompt.
 const before=childProcess.spawnSync('pnpm',['install','--frozen-lockfile'],{cwd:root,env,stdio:['ignore','pipe','pipe'],timeout:15000});
 assert.equal(before.error,undefined);assert.equal(before.signal,null);
 assert.ok(before.status===1 || before.status===0 && /modules directory.*removed/s.test(before.stdout.toString()));
 assert.equal(existsSync(join(root,'postinstall.json')),false);
 assert.deepEqual(readFileSync(join(root,'node_modules/.modules.yaml')),modulesBefore);
 runRecoveryCheck('pnpm',['install','--frozen-lockfile'],{cwd:root,env,log:join(root,'install.check.log'),timeout:15000});
 assert.deepEqual(JSON.parse(readFileSync(join(root,'postinstall.json'),'utf8')),{ci:'true',value:2939});
 assert.equal(env.CI,'false','install CI must not leak into later checks');
 assert.ok(readFileSync(join(root,'node_modules/.modules.yaml'),'utf8').includes(join(root,'.pnpm-store')));
 unlinkSync(join(root,'postinstall.json'));
 // After bootstrap, even the old parent needs no CI override or extra flags.
 childProcess.execFileSync('pnpm',['install','--frozen-lockfile'],{cwd:root,env,stdio:'ignore',timeout:15000});
 assert.deepEqual(JSON.parse(readFileSync(join(root,'postinstall.json'),'utf8')),{ci:'false',value:2939});
 runRecoveryCheck('pnpm',['exec',process.execPath,'-e',"if(process.env.CI!=='false') process.exit(1)"],{
  cwd:root,env,log:join(root,'test.check.log'),timeout:15000,
 });
 assert.deepEqual(readFileSync(join(root,'pnpm-lock.yaml')),lock,'all frozen installs retain the exact lockfile');
});
test('a failed gate retains its diagnostic output privately before returning failure',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-check-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const log=join(root,'test.log');
 assert.throws(()=>runRecoveryCheck(process.execPath,['-e','process.stdout.write("exact failure detail");process.stderr.write("stderr detail");process.exit(1)'],{cwd:root,env:process.env,log,timeout:5000}),/Check failed/);
 assert.match(readFileSync(log,'utf8'),/exact failure detail/);assert.match(readFileSync(log,'utf8'),/stderr detail/);assert.equal(statSync(log).mode&0o777,0o600);
});

test('failed repair diagnostics include builder output and counted check failures without exposing raw logs',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-diagnostics-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const raw='x'.repeat(40000)+'\nAuthorization: Bearer '+ 'c'.repeat(40)+'\nAssertionError: read happened\nfail 4\n';
 writeFileSync(join(root,'test.check.log'),raw);
 writeFileSync(join(root,'builder.log'),'owned shell exit 0 followed by denied probe\n');
 writeFileSync(join(root,'unrelated.log'),'private unrelated record');
 const files=repairDiagnostics(root);
 assert.match(files['test.diagnostic.log'],/AssertionError: read happened\nfail 4/);
 assert.match(files['test.diagnostic.log'],/Bearer \[REDACTED\]/);
 assert.ok(files['test.diagnostic.log'].length<=16000);
 assert.match(files['builder.diagnostic.log'],/denied probe/);
 assert.deepEqual(Object.keys(files).sort(),['builder.diagnostic.log','test.diagnostic.log']);
 assert.equal(readFileSync(join(root,'test.check.log'),'utf8'),raw);
});

test('failed review diagnostics preserve complete final findings when streaming logs truncate them',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-review-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const finding=JSON.stringify({status:'completed',summary:JSON.stringify({decision:'FAIL',findings:
  'Reassessment loses grandchild identity. Bearer '+'c'.repeat(40)+'\n"api_key": "'+'k'.repeat(40)+'"'})});
 writeFileSync(join(root,'reviewer.log'),'truncated final agent message');
 writeFileSync(join(root,'reviewer.result.txt'),finding,{mode:0o600});
 const files=repairDiagnostics(root);
 assert.match(files['reviewer.diagnostic.log'],/Reassessment loses grandchild identity/);
 assert.match(files['reviewer.diagnostic.log'],/Bearer \[REDACTED\]/);
 assert.doesNotMatch(files['reviewer.diagnostic.log'],/k{40}/);
 assert.doesNotMatch(files['reviewer.diagnostic.log'],/truncated/);
 assert.equal(readFileSync(join(root,'reviewer.result.txt'),'utf8'),finding);
 assert.equal(statSync(join(root,'reviewer.result.txt')).mode&0o777,0o600);
});

test('raw streaming fallback and assessment facts scrub nested JSON-escaped assignments',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-escaped-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const secret='k'.repeat(40);
 for(const whitespace of [' ','\n','\t']) {
  let message='"api_key":'+whitespace+'"'+secret+'"\nAuthorization: Bearer'+whitespace+secret;
  for(let depth=0;depth<4;depth++) {
   message=JSON.stringify({type:'agent_message',text:message});
   writeFileSync(join(root,'reviewer.log'),'[item.completed] '+message+'\n');
   const diagnostic=repairDiagnostics(root)['reviewer.diagnostic.log'];
   assert.doesNotMatch(diagnostic,new RegExp(secret));
   assert.match(diagnostic,/REDACTED/);
  }
 }
});

test('large single-line agent results are decoded before bounding the findings',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-large-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const findings='First finding: unknown custody must retain the reservation.\n'+'detail '.repeat(6000)+'\nLast finding: report archival failed.';
 const raw=JSON.stringify({status:'completed',summary:JSON.stringify({decision:'FAIL',findings})});
 writeFileSync(join(root,'reviewer.result.txt'),raw,{mode:0o600});
 writeFileSync(join(root,'reviewer.log'),'truncated streaming result');
 const diagnostic=repairDiagnostics(root)['reviewer.diagnostic.log'];
 assert.match(diagnostic,/FAIL\nFirst finding: unknown custody/);
 assert.match(diagnostic,/Last finding: report archival failed/);
 assert.ok(diagnostic.length<=16000);
 assert.equal(readFileSync(join(root,'reviewer.result.txt'),'utf8'),raw);
});

test('check diagnostics retain terminal status independently of output',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-terminal-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 t.mock.method(childProcess,'execFileSync',()=>{throw Object.assign(new Error('fixture'),{status:7,signal:null,stdout:Buffer.from('exact failure'),stderr:Buffer.from('exact stderr')});});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const log=join(root,'helpers.check.log');
 assert.throws(()=>runRecoveryCheck('fixture',[],{cwd:root,env:{},log,timeout:5000}),/Check failed/);
 const status=JSON.parse(readFileSync(join(root,'helpers.check.result.json'),'utf8'));
 assert.equal(status.status,7);assert.equal(status.signal,null);assert.equal(status.outcome,'failed');
 assert.match(repairDiagnostics(root)['helpers.diagnostic.log'],/"status":7/);
 assert.equal(statSync(join(root,'helpers.check.result.json')).mode&0o777,0o600);
});

test('successful checks retain both streams in order and a separate terminal record',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-success-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const log=join(root,'helpers.check.log');
 runRecoveryCheck(process.execPath,['-e','process.stdout.write("stdout\\n");process.stderr.write("stderr\\n")'],{cwd:root,env:{},log,timeout:5000});
 assert.equal(readFileSync(log,'utf8'),'stdout\nstderr\n');
 const terminal=JSON.parse(readFileSync(join(root,'helpers.check.result.json'),'utf8'));
 assert.equal(terminal.outcome,'completed');assert.equal(terminal.status,0);assert.equal(terminal.signal,null);
});

test('check timeout and launch errors retain uncertainty rather than a zero exit',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-timeout-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 t.mock.method(childProcess,'execFileSync',()=>{throw Object.assign(new Error('fixture'),{status:null,signal:'SIGTERM',code:'ETIMEDOUT'});});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const log=join(root,'test.check.log');
 assert.throws(()=>runRecoveryCheck('fixture',[],{cwd:root,env:{},log,timeout:5000}),/Check failed/);
 const terminal=JSON.parse(readFileSync(join(root,'test.check.result.json'),'utf8'));
 assert.equal(terminal.outcome,'failed');assert.equal(terminal.status,null);assert.equal(terminal.signal,'SIGTERM');assert.equal(terminal.errorCode,'ETIMEDOUT');
});

test('review findings have a structured bounded assessment artifact',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-findings-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'reviewer.result.txt'),JSON.stringify({status:'completed',summary:JSON.stringify({decision:'FAIL',findings:'credential api_key="'+'k'.repeat(40)+'"; retain custody'})}));
 const files=repairDiagnostics(root),review=JSON.parse(files['reviewer.findings.json']);
 assert.equal(review.decision,'FAIL');assert.match(review.findings,/retain custody/);
 assert.doesNotMatch(review.findings,/k{40}/);
});

test('authoritative Claude review output survives a conflicting narrative and carries candidate identity',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-structured-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'reviewer.result.txt'),'Narrative assistant text without the review decision.');
 writeFileSync(join(root,'reviewer.output.txt'),JSON.stringify({decision:'FAIL',findings:'Clone failures lose custody. api_key="'+'k'.repeat(40)+'"'}));
 const binding={taskId:'a'.repeat(64),ticket:'org/mobile#1947',candidateRevision:'b'.repeat(40)};
 const files=repairDiagnostics(root,binding);
 assert.ok(files['reviewer.findings.json'],'structured review findings must reach reassessment');
 const review=JSON.parse(files['reviewer.findings.json']);
 assert.equal(review.decision,'FAIL');assert.match(review.findings,/Clone failures lose custody/);
 assert.deepEqual({taskId:review.taskId,ticket:review.ticket,candidateRevision:review.candidateRevision},binding);
 assert.doesNotMatch(JSON.stringify(files),/k{40}|Narrative assistant/);
 assert.match(readFileSync(join(root,'reviewer.result.txt'),'utf8'),/Narrative assistant/);
});
