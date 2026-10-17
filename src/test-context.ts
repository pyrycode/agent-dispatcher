import {existsSync,mkdirSync,readFileSync,realpathSync,renameSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';

export interface TestContext {runId:string;project:string;socket:string}

/** This record is written by the admitted dispatcher, never from shell role variables. */
export function bindTestContext(worktree:string,context:TestContext):()=>void {
 const root=realpathSync(worktree);
 let git=join(root,'.git');
 if(!existsSync(git))throw new Error('Managed test context needs a Git worktree');
 try {
  const text=readFileSync(git,'utf8').trim();
  if(!text.startsWith('gitdir: '))throw new Error('Invalid Git worktree link');
  git=realpathSync(resolve(root,text.slice(8)));
 }catch(error){if((error as NodeJS.ErrnoException).code!=='EISDIR')throw error;}
 if(!context.runId || !context.project || !isAbsolute(context.socket))throw new Error('Invalid managed test context');
 const folder=join(git,'pyry-test-context'),sentinel=join(git,'pyry-test-managed');
 const record=JSON.stringify({version:1,root,...context});
 // The separate sentinel makes a deleted context folder fail closed.
 writeFileSync(sentinel,context.runId,{mode:0o600});
 mkdirSync(folder,{recursive:true,mode:0o700});
 const file=join(folder,'context.json'),temporary=join(folder,`context-${process.pid}.json`);
 writeFileSync(temporary,record,{mode:0o600});renameSync(temporary,file);
 return ()=>{
  try {
   if(readFileSync(file,'utf8')!==record)return;
   unlinkSync(file);
   try {rmdirSync(folder);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOTEMPTY')throw error;}
   if(readFileSync(sentinel,'utf8')===context.runId)unlinkSync(sentinel);
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 };
}
