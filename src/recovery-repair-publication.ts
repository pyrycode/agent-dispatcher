import type {GitHubBroker} from './github-broker.js';
import type {RecoveryTask} from './recovery-tasks.js';

export interface RepairPublication {files:Record<string,string|null>;modes?:Record<string,string>;message:string;review:'PASS';checksPassed:boolean}
/** Fixed repository, fixed new branch, ordinary non-forced GitHub writes. The configured host executor is the caller. */
export async function publishRepair(github:GitHubBroker,repository:string,task:RecoveryTask,value:RepairPublication, consumers:Record<string,string> = {}, beforeRollout?: (sha:string)=>boolean) {
 if (task.request.recipe!=='dispatcher-repair' || !['running','publishing'].includes(task.state) || value.review!=='PASS' || value.checksPassed!==true
  || typeof value.message!=='string' || value.message.length>2000 || !value.files || Object.keys(value.files).length>100) throw new Error('Repair requires passing independent review and full checks');
 if(task.state==='publishing' && task.result?.files['publication.json']!==JSON.stringify(value)) throw new Error('The prepared repair changed');
 const request=async(method:string,path:string,body?:unknown)=>{
  const r=await github.request(repository,{method,path:'/repos/'+repository+path,fresh:method==='GET',headers:{accept:'application/vnd.github+json','content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  if(r.status<200 || r.status>=300) throw new Error('Repair publication unavailable: HTTP '+r.status);
  return r.body?JSON.parse(typeof r.body==='string'?r.body:Buffer.from(r.body as any).toString()):null;
 };
 const branch='fix/recovery-'+task.id.slice(0,16);
 const base=await request('GET','/git/commits/'+task.request.revision);
 const tree=[];
 for(const[path,content] of Object.entries(value.files)) {
  if(!/^[\w./-]+$/.test(path) || path.split('/').some(p=>!p||p==='.'||p==='..') || !['string','object'].includes(typeof content) || content!==null && typeof content!=='string') throw new Error('Invalid repair path');
  if(content===null) tree.push({path,mode:'100644',type:'blob',sha:null});
  else {const blob=await request('POST','/git/blobs',{content,encoding:'utf-8'});tree.push({path,mode:value.modes?.[path]??'100644',type:'blob',sha:blob.sha});}
 }
 if(tree.some(t=>!['100644','100755'].includes(t.mode))) throw new Error('Unsupported repair file mode');
 if(tree.length===0) throw new Error('A repair must contain reviewed changes');
 const built=await request('POST','/git/trees',{base_tree:base.tree.sha,tree});
 const commit=await request('POST','/git/commits',{message:value.message,tree:built.sha,parents:[task.request.revision]});
 let existing:any=null;
 try {existing=await request('GET','/git/ref/heads/'+branch);}catch(error){if(!String(error).includes('404'))throw error;}
 if(existing && existing.object.sha!==commit.sha) {
  // The prior commit may have the same reviewed tree but a different server timestamp.
  const previous=await request('GET','/git/commits/'+existing.object.sha);
  if(previous.tree.sha!==built.sha || previous.parents?.[0]?.sha!==task.request.revision) throw new Error('Repair branch already carries different work');
 }else if(!existing) await request('POST','/git/refs',{ref:'refs/heads/'+branch,sha:commit.sha});
 const head=existing?.object.sha??commit.sha;
 let prs=await request('GET','/pulls?state=all&head='+encodeURIComponent(repository.split('/')[0]+':'+branch));
 const marker='<!-- fleet-recovery-task:'+task.id+' -->';
 let pr=prs.find((p:any)=>p.body?.includes(marker));
 if(!pr) pr=await request('POST','/pulls',{title:value.message.split('\n')[0].slice(0,120),head:branch,base:'main',body:marker+'\n\n'+task.request.reason+'\n\nTriggered by https://github.com/'+task.ticket.replace('#','/issues/')+'.\n\nThe fixed recovery executor ran the full dispatcher suite and type checking. An independent source review passed on the submitted tree.'});
 let merged:any;
 if(pr.state==='closed') {
  if(!pr.merged_at) return {url:pr.html_url,merged:false,reason:'The repair PR was closed without merging.'};
  merged={merged:true,sha:pr.merge_commit_sha};
 }else {
  const main=await request('GET','/git/ref/heads/main');
  if(main.object.sha!==task.request.revision) return {url:pr.html_url,merged:false,reason:'Main advanced. Fresh merged-tree checks are required.'};
  merged=await request('PUT','/pulls/'+pr.number+'/merge',{sha:head,merge_method:'merge'});
  if(!merged.merged) return {url:pr.html_url,merged:false};
 }
 const final=await request('GET','/git/commits/'+merged.sha);
 if(final.tree.sha!==built.sha) return {url:pr.html_url,merged:true,rollout:false,reason:'Merged tree changed. Its full checks must pass before rollout.'};
 if(beforeRollout && !beforeRollout(merged.sha)) return {url:pr.html_url,merged:true,pendingControl:true,dispatcherSHA:merged.sha};
 const consumerPRs=[];
 for(const consumer of [...new Set(Object.values(consumers))]) {
  const call=async(method:string,path:string,body?:unknown)=>{
   const response=await github.request(consumer,{method,path:'/repos/'+consumer+path,fresh:method==='GET',headers:{accept:'application/vnd.github+json','content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
   if(response.status<200||response.status>=300) throw new Error('Consumer pin publication unavailable: HTTP '+response.status);
   return JSON.parse(response.body);
  };
  const main=await call('GET','/git/ref/heads/main'),base=await call('GET','/git/commits/'+main.object.sha);
  const original=await call('GET','/git/trees/'+base.tree.sha);
  const submodule=original.tree.find((entry:any)=>entry.path==='dispatcher'&&entry.mode==='160000');
  if(!submodule) throw new Error('Configured consumer has no dispatcher submodule');
  if(submodule.sha===merged.sha) continue;
  const tree=await call('POST','/git/trees',{base_tree:base.tree.sha,tree:[{path:'dispatcher',mode:'160000',type:'commit',sha:merged.sha}]});
  const commit=await call('POST','/git/commits',{message:'Load verified dispatcher recovery repair',tree:tree.sha,parents:[main.object.sha]});
  const pinBranch=branch+'-pin';let existing:any=null;
  try{existing=await call('GET','/git/ref/heads/'+pinBranch);}catch(error){if(!String(error).includes('404'))throw error;}
  if(!existing) await call('POST','/git/refs',{ref:'refs/heads/'+pinBranch,sha:commit.sha});
  const pinHead=existing?.object.sha??commit.sha;
  const prs=await call('GET','/pulls?state=all&head='+encodeURIComponent(consumer.split('/')[0]+':'+pinBranch));
  let pin=prs.find((p:any)=>p.body?.includes(marker));
  if(!pin) pin=await call('POST','/pulls',{title:'Load verified dispatcher recovery repair',head:pinBranch,base:'main',body:marker+'\n\nLoads '+repository+'@'+merged.sha+' after full shared checks and independent review. Existing running workers finish before their supervised restart.'});
  if(pin.state!=='closed') await call('PUT','/pulls/'+pin.number+'/merge',{sha:pinHead,merge_method:'merge'});
  consumerPRs.push(pin.html_url);
 }
 return {url:pr.html_url,merged:true,dispatcherSHA:merged.sha,consumerPRs};
}
