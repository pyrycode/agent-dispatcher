import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {bindTestContext} from './test-context.js';

test('managed context binds the actual Git worktree and removes only its own record',()=>{
 const root=mkdtempSync(join(tmpdir(),'test-context-'));
 try {
  const git=join(root,'metadata');mkdirSync(git);
  const worktree=join(root,'product');mkdirSync(worktree);writeFileSync(join(worktree,'.git'),'gitdir: '+git+'\n');
  const release=bindTestContext(worktree,{runId:'run-one',project:'pyrycode/pyrycode',socket:'/private/run/api.sock'});
  const file=join(git,'pyry-test-context/context.json');
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{version:1,root:realpathSync(worktree),runId:'run-one',project:'pyrycode/pyrycode',socket:'/private/run/api.sock'});
  assert.ok(existsSync(join(git,'pyry-test-managed')));
  writeFileSync(file,JSON.stringify({version:1,root:resolve(worktree),runId:'run-two',project:'pyrycode/pyrycode',socket:'/other/api.sock'}));
  release();
  assert.ok(existsSync(file),'old completion cannot erase a successor binding');
 } finally {rmSync(root,{recursive:true});}
});

test('normal context completion removes both owned binding and managed sentinel',()=>{
 const root=mkdtempSync(join(tmpdir(),'test-context-'));
 try {
  mkdirSync(join(root,'.git'));
  const release=bindTestContext(root,{runId:'run-one',project:'pyrycode/pyrycode',socket:'/private/run/api.sock'});
  release();
  assert.equal(existsSync(join(root,'.git/pyry-test-context')),false);
  assert.equal(existsSync(join(root,'.git/pyry-test-managed')),false);
 } finally {rmSync(root,{recursive:true});}
});
