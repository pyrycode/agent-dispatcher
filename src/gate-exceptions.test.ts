import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exceptionRefusal,failureSignature,checkInheritedException,type GateException} from './gate-exceptions.js';
const raw=(message:string)=>[
 {Action:'run',Package:'pkg',Test:'TestOld'},
 {Action:'output',Package:'pkg',Test:'TestOld',Output:'    old_test.go:10: '+message+'\n'},
 {Action:'fail',Package:'pkg',Test:'TestOld'},
 {Action:'fail',Package:'pkg'},
].map(e=>JSON.stringify(e)).join('\n');
const signature=failureSignature(raw('expected 1, got 2'),'go-json','pkg.TestOld')!;
const now=Date.parse('2026-10-15T21:00:00+03:00');
const record:GateException={project:'org/core',gate:'go test -json ./...',test:'pkg.TestOld',tracker:42,signature,environment:'test-environment',approvedBy:'Juhana',approvedAt:'2026-10-15T20:00:00+03:00',expiresAt:'2026-10-16T20:00:00+03:00',allowedPaths:['docs/']};
const input={project:record.project,gate:record.gate,test:record.test,tracker:42,branch:signature,base:signature,environment:record.environment,paths:['docs/readme.md']};

test('an approved matching failure is reusable only within its time, environment and path scope',()=>{
 assert.ok(signature);assert.equal(exceptionRefusal(record,input,now),null);
 for(const changed of [{...record,expiresAt:'2026-10-15T20:30:00+03:00'},{...record,expiresAt:'2026-11-15T20:00:00+02:00'},{...record,approvedBy:'agent' as any}]) assert.ok(exceptionRefusal(changed,input,now));
 for(const changed of [{...input,tracker:43},{...input,project:'other/repo'},{...input,environment:'other'},{...input,paths:['src/changed.ts']},{...input,test:'pkg.TestAuthentication'},{...input,paths:['docs/security.md']}]) assert.ok(exceptionRefusal(record,changed,now));
 assert.ok(exceptionRefusal({...record,allowedPaths:['*']},input,now));
});

test('the same test name cannot excuse a different assertion or missing diagnostic evidence',()=>{
 const regression=failureSignature(raw('expected 1, got 3'),'go-json','pkg.TestOld');
 assert.notEqual(regression,signature);
 assert.ok(exceptionRefusal(record,{...input,branch:regression},now));
 assert.ok(exceptionRefusal(record,{...input,base:null},now));
 assert.equal(failureSignature('{malformed','go-json','pkg.TestOld'),null);
 assert.equal(failureSignature(raw('expected 1, got 2'),'go-json','pkg.TestOther'),null);
 assert.ok(checkInheritedException({issueNumber:42,policyFile:'/absent/policy',project:record.project,gate:record.gate,test:record.test,tracker:42,format:'go-json',branchPath:'/absent/branch',basePath:null,cwd:'/tmp',base:'a'.repeat(40),head:'b'.repeat(40)},now));
});

test('JUnit assertion messages remain distinct even with the same test identity',()=>{
 const report=(text:string)=>'<testsuite name="suite" tests="1" failures="1"><testcase classname="C" name="old"><failure message="'+text+'"/></testcase></testsuite>';
 assert.ok(failureSignature(report('expected one'),'junit-xml','C#old'));
 assert.notEqual(failureSignature(report('expected one'),'junit-xml','C#old'),failureSignature(report('expected two'),'junit-xml','C#old'));
 assert.equal(failureSignature(report(''),'junit-xml','C#old'),null);
});

 test('security classification refuses even when the failed name looks unrelated',()=>{
  assert.match(exceptionRefusal({...record,test:'pkg.TestAuthentication'},{...input,test:'pkg.TestAuthentication'},now)!,/Security/);
  assert.match(checkInheritedException({issueNumber:42,policyFile:'/absent/policy',project:record.project,gate:record.gate,test:record.test,tracker:42,format:'go-json',branchPath:'/absent/branch',basePath:null,cwd:'/tmp',base:'a'.repeat(40),head:'b'.repeat(40),securitySensitive:true},now)!,/Security/);
 });

 test('a two-dot filename is still inside the ticket checkout',()=>{
  const root=mkdtempSync(join(tmpdir(),'gate-policy-'));
  try {
   const policy=join(root,'..policy.json');writeFileSync(policy,JSON.stringify({version:1,exceptions:[]}));
   assert.match(checkInheritedException({issueNumber:42,policyFile:policy,project:record.project,gate:record.gate,test:record.test,tracker:42,format:'go-json',branchPath:'/unused',basePath:'/unused',cwd:root,base:'a'.repeat(40),head:'b'.repeat(40)},now)!,/outside the ticket checkout/);
  } finally {rmSync(root,{recursive:true,force:true});}
 });

 test('Desktop 1908 protocol coverage cannot be waived through an inherited exception',()=>{
  const refusal=checkInheritedException({issueNumber:1908,project:'pyrycode/pyrycode-desktop',policyFile:'/absent/policy',gate:record.gate,test:record.test,tracker:42,format:'go-json',branchPath:'/absent/branch',basePath:'/absent/base',cwd:'/tmp',base:'a'.repeat(40),head:'b'.repeat(40)},now);
  assert.match(refusal!,/1908 protocol migration cannot use inherited exceptions/);
 });
