import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import type {VerifierHandoff,VerificationPin} from './verifier-handoff.js';
export type HandoffGit=(args:string[],cwd:string)=>string;
const git:HandoffGit=(args,cwd)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30_000}).trim();
/** Preflight changes no branch or worktree. Fetch downloads the named published object only. */
export function preflightVerifierHandoff(root:string,h:VerifierHandoff,machine:string,run:HandoffGit=git):void {
 const branch='feature/'+h.ticket.split('#')[1];
 if(![h.source,h.target].includes(machine))throw new Error('Not a handoff host');
 if(run(['symbolic-ref','--short','HEAD'],root)!=='main' || run(['status','--porcelain','--untracked-files=all','--','.',':(exclude).dispatcher.lock'],root))throw new Error('Canonical checkout is not clean main');
 const published=run(['ls-remote','--exit-code','origin','refs/heads/'+branch],root).split(/\s+/)[0];
 if(published!==h.candidate)throw new Error('Published candidate changed');
 run(['fetch','--no-write-fetch-head','origin',h.candidate],root);
 if(run(['rev-parse',h.candidate+'^{commit}'],root)!==h.candidate)throw new Error('Candidate is unavailable');
 const local=run(['for-each-ref','--format=%(objectname)','refs/heads/'+branch],root);
 if(local && local!==h.candidate)throw new Error('Local ticket branch differs from candidate');
 const trees=run(['worktree','list','--porcelain'],root).split('\n\n').filter(block=>block.split('\n').includes('branch refs/heads/'+branch));
 for(const block of trees){
  const path=block.split('\n').find(l=>l.startsWith('worktree '))?.slice(9);
  if(!path || machine===h.target || run(['rev-parse','HEAD'],path)!==h.candidate || run(['status','--porcelain','--untracked-files=all'],path))throw new Error('Retained ticket work prevents handoff');
 }
}
/** An admitted transfer always uses its candidate. Current main is never merged or pushed here. */
export function setupPinnedVerifier(root:string,path:string,branch:string,pin:VerificationPin,run:HandoffGit=git):void {
 if(!/^[a-f0-9]{40}$/.test(pin.candidate)||!/^feature\/[1-9]\d*$/.test(branch))throw new Error('Invalid verifier pin');
 if(existsSync(path))throw new Error('Pinned worktree path already exists; preserved');
 if(run(['ls-remote','--exit-code','origin','refs/heads/'+branch],root).split(/\s+/)[0]!==pin.candidate)throw new Error('Published candidate changed after handoff');
 run(['fetch','--no-write-fetch-head','origin',pin.candidate],root);
 const local=run(['for-each-ref','--format=%(objectname)','refs/heads/'+branch],root);
 if(local && local!==pin.candidate)throw new Error('Local ticket branch changed after handoff');
 if(!local)run(['branch',branch,pin.candidate],root);
 run(['worktree','add',path,branch],root);
 assertPinnedVerifier(path,pin,run);
}
export function assertPinnedVerifier(path:string,pin:VerificationPin,run:HandoffGit=git):void {
 if(run(['rev-parse','HEAD'],path)!==pin.candidate || run(['status','--porcelain','--untracked-files=all'],path))throw new Error('Pinned verifier candidate changed; verdict withheld');
 const branch=run(['symbolic-ref','--short','HEAD'],path);
 if(!/^feature\/[1-9]\d*$/.test(branch) || run(['ls-remote','--exit-code','origin','refs/heads/'+branch],path).split(/\s+/)[0]!==pin.candidate)throw new Error('Published candidate changed; verdict withheld');
}
