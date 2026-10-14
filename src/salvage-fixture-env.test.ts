import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {recoveryCheckEnv} from './recovery-checks.js';

for(const gates of ['', 'consumer-build --check']) {
 test(`salvage failing-build fixture rejects with inherited SALVAGE_GATES=${JSON.stringify(gates)}`,t=>{
  const directory=mkdtempSync(join(tmpdir(),'salvage-fixture-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  // The launching parent can have computed checkEnv before the builder patched
  // recoveryCheckEnv. Exercise that old environment in a fresh module instance.
  const env:NodeJS.ProcessEnv={...recoveryCheckEnv(process.env),AGENTS_REPO_PATH:directory,TARGET_REPO_PATH:directory,SALVAGE_GATES:gates};
  delete env.NODE_TEST_CONTEXT; // Start a standalone runner, rather than a recursive node:test child.
  const output=execFileSync(process.execPath,['--import','tsx','--test','--test-reporter=spec',
   '--test-name-pattern=committed timeout work with a failing build cannot open a draft',
   fileURLToPath(new URL('./dispatch.test.ts',import.meta.url))],{env,encoding:'utf8',timeout:30000});
  assert.match(output,/committed timeout work with a failing build cannot open a draft/);
  assert.match(output,/\bpass 1\b/);
  assert.doesNotMatch(output,/draft PR opened/);
 });
}
