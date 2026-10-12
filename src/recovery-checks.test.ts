import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoveryCheckEnv,runRecoveryCheck} from './recovery-checks.js';

test('repair checks do not inherit another consumers production role or checkout',()=>{
 const env=recoveryCheckEnv({PATH:'/tools',HOME:'/private/home',PYRY_STAGE_SET:'builder',PYRY_VERIFIER_GATES:'production gate',AGENTS_REPO_PATH:'/production/agents',TARGET_REPO_PATH:'/production/core',FLEET_ADMIN:'fixture',GITHUB_TOKEN:'fixture'});
 assert.deepEqual(env,{PATH:'/tools',HOME:'/private/home'});
});
test('a failed gate retains its diagnostic output privately before returning failure',t=>{
 const root=mkdtempSync(join(tmpdir(),'repair-check-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const log=join(root,'test.log');
 assert.throws(()=>runRecoveryCheck(process.execPath,['-e','process.stdout.write("exact failure detail");process.stderr.write("stderr detail");process.exit(1)'],{cwd:root,env:process.env,log,timeout:5000}),/Check failed/);
 assert.match(readFileSync(log,'utf8'),/exact failure detail/);assert.match(readFileSync(log,'utf8'),/stderr detail/);assert.equal(statSync(log).mode&0o777,0o600);
});
