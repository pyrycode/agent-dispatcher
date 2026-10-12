import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {publishRepair} from './recovery-repair-publication.js';
import type {RecoveryTask} from './recovery-tasks.js';

const BASE='0123456789abcdef0123456789abcdef01234567';
const task:RecoveryTask={id:'a'.repeat(64),ticket:'org/core#3178',request:{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision:BASE,reason:'Recover the observed HTTP 429 publication defect'},state:'running',created:1,updated:1,machine:'box',session:'s',runId:'r',result:null};
const publication={files:{'src/fix.ts':'export const repaired=true;\n'},modes:{'src/fix.ts':'100644'},message:'Fix verdict publication',review:'PASS' as const,checksPassed:true};
function fixture(){
 const calls:any[]=[];let serial=0;
 const states=new Map<string,any>();
 for(const repo of ['org/dispatcher','org/agents'])states.set(repo,{refs:new Map([['main',BASE]]),commits:new Map([[BASE,{sha:BASE,tree:{sha:'base-tree'},parents:[]}]]),trees:new Map([['base-tree',[{path:'dispatcher',mode:'160000',sha:'old-pin',type:'commit'},{path:'keep.txt',mode:'100644',sha:'keep',type:'blob'}]]]),pulls:[]});
 const github={request:async(repo:string,r:any)=>{
  calls.push({repo,...r});const s=states.get(repo),path=r.path.replace('/repos/'+repo,''),body=r.body?JSON.parse(r.body):null;
  const response=(status:number,value:any)=>({status,body:JSON.stringify(value),headers:{}});
  if(r.method==='GET'&&path.startsWith('/git/commits/'))return response(s.commits.has(path.slice(13))?200:404,s.commits.get(path.slice(13)));
  if(r.method==='GET'&&path.startsWith('/git/trees/'))return response(200,{tree:s.trees.get(path.slice(11))});
  if(r.method==='GET'&&path.startsWith('/git/ref/heads/')){const sha=s.refs.get(path.slice(15));return response(sha?200:404,{object:{sha}});}
  if(path==='/git/blobs')return response(201,{sha:createHash('sha1').update(body.content).digest('hex')});
  if(path==='/git/trees'){
   const map=new Map(s.trees.get(body.base_tree).map((e:any)=>[e.path,e]));for(const entry of body.tree){if(entry.sha===null)map.delete(entry.path);else map.set(entry.path,entry);}
   const entries=[...map.values()].sort((a:any,b:any)=>a.path.localeCompare(b.path));const sha=createHash('sha1').update(JSON.stringify(entries)).digest('hex');s.trees.set(sha,entries);return response(201,{sha});
  }
  if(path==='/git/commits'){const sha=(++serial).toString(16).padStart(40,'0');s.commits.set(sha,{sha,tree:{sha:body.tree},parents:body.parents.map((sha:string)=>({sha}))});return response(201,{sha});}
  if(path==='/git/refs'){assert.equal(body.force,undefined);assert.ok(!s.refs.has(body.ref.replace('refs/heads/','')));s.refs.set(body.ref.replace('refs/heads/',''),body.sha);return response(201,{object:{sha:body.sha}});}
  if(r.method==='GET'&&path.startsWith('/pulls?'))return response(200,s.pulls);
  if(r.method==='POST'&&path==='/pulls'){const pr={number:s.pulls.length+1,html_url:'https://github.com/'+repo+'/pull/'+(s.pulls.length+1),state:'open',body:body.body,branch:body.head};s.pulls.push(pr);return response(201,pr);}
  if(r.method==='PUT'&&/^\/pulls\/\d+\/merge$/.test(path)){
   const pr=s.pulls.find((p:any)=>p.number===Number(path.split('/')[2]));assert.equal(body.sha,s.refs.get(pr.branch));
   const sha=(++serial).toString(16).padStart(40,'0');s.commits.set(sha,{sha,tree:s.commits.get(body.sha).tree,parents:[{sha:s.refs.get('main')},{sha:body.sha}]});s.refs.set('main',sha);Object.assign(pr,{state:'closed',merged_at:'now',merge_commit_sha:sha});return response(200,{sha,merged:true});
  }
  throw new Error('Unimplemented fixture request '+r.method+' '+path);
 }};
 return {github:github as any,calls,states};
}

test('publication retries recover their own PR and wait for controllers before consumer rollout',async()=>{
 const f=fixture();
 const first=await publishRepair(f.github,'org/dispatcher',task,publication,{'org/core':'org/agents'},()=>false);
 assert.equal(first.pendingControl,true);assert.equal(f.states.get('org/agents').pulls.length,0);
 const second=await publishRepair(f.github,'org/dispatcher',task,publication,{'org/core':'org/agents'},()=>true);
 assert.equal(second.merged,true);assert.equal(second.consumerPRs?.length,1);
 assert.equal(f.states.get('org/dispatcher').pulls.length,1);
 const source=f.states.get('org/dispatcher'),consumer=f.states.get('org/agents');
 const deployedTree=consumer.trees.get(consumer.commits.get(consumer.refs.get('main')).tree.sha);
 assert.equal(deployedTree.find((e:any)=>e.path==='dispatcher').sha,source.refs.get('main'));
 assert.equal(deployedTree.find((e:any)=>e.path==='keep.txt').sha,'keep');
 assert.ok(f.calls.filter(c=>c.method==='GET').every(c=>c.fresh===true));
 assert.ok(f.calls.filter(c=>c.method!=='GET').every(c=>c.headers['content-type']==='application/json'));
 assert.ok(f.calls.every(c=>!c.body||JSON.parse(c.body).force!==true));
});

test('failed review and checks cannot create GitHub writes',async()=>{
 const f=fixture();
 await assert.rejects(publishRepair(f.github,'org/dispatcher',task,{...publication,checksPassed:false}));
 await assert.rejects(publishRepair(f.github,'org/dispatcher',task,{...publication,review:'FAIL'} as any));
 assert.equal(f.calls.length,0);
});

test('moved main retains the reviewed PR instead of deploying untested changes',async()=>{
 const f=fixture();f.states.get('org/dispatcher').refs.set('main','f'.repeat(40));
 const result=await publishRepair(f.github,'org/dispatcher',task,publication);
 assert.equal(result.merged,false);assert.match(result.reason??'',/Main advanced/);
 assert.equal(f.calls.some(c=>c.method==='PUT'),false);
});
