import {accessSync,constants,mkdtempSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';

function executable(name:string,path:string):string {
 for(const folder of path.split(':')) {
  if(!isAbsolute(folder))continue;
  const file=join(folder,name);
  try {accessSync(file,constants.X_OK);return file;}catch {/* next PATH entry */}
 }
 throw new Error(`Managed Core builder needs ${name} on its dispatcher PATH`);
}
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;

/** Only the agent gets this PATH. Dispatcher/verifier commands retain their own Go. */
export function managedGoPath(root:string,path:string):{path:string;release:()=>void} {
 const go=executable('go',path),python=executable('python3',path);
 const folder=mkdtempSync(join(tmpdir(),'pyry-builder-go-'));
 const file=join(folder,'go');
 const helper=fileURLToPath(new URL('../scripts/managed-go.py',import.meta.url));
 writeFileSync(file,`#!/bin/sh\nexec ${[python,helper,root,go].map(quote).join(' ')} "$@"\n`,{mode:0o700});
 return {path:`${folder}:${path}`,release:()=>{unlinkSync(file);rmdirSync(folder);}};
}
