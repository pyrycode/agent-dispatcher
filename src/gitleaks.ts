import childProcess from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=new URL('../',import.meta.url);
const pins=JSON.parse(fs.readFileSync(new URL('scripts/gitleaks-runtime-pin.json',root),'utf8'));
const platform=process.platform+'-'+process.arch;
const FAILURE='Source package scan refused; retain it privately';
const TIMEOUT_MS=10_000;
// All filename predicates from config/gitleaks.toml at pins.sourceCommit.
// Each alias matches its rule without retaining an excluded submitted name.
const privateNames:Array<[RegExp,string]>=[
 [/\.php$/i,'candidate.php'],
 [/\.(?:tf|hcl)$/i,'candidate.tf'],
 [/\.ya?ml$/i,'candidate.yaml'],
 [/nuget\.config$/i,'NuGet.config'],
 [/(?:^|\/)[^\/]+\.p(?:12|fx)$/i,'candidate.p12'],
];

/** Offline, fail-closed scan of every submitted byte, without filename exclusions. */
export function scanSourcePackage(files:Record<string,string|null>):void {
 let directory:string|undefined;
 try {
  const pin=pins.platforms[platform];
  if(!pin) throw new Error();
  const executable=fileURLToPath(new URL('.gitleaks-runtime/'+pins.version+'/'+platform+'/gitleaks',root));
  // Read through one regular-file handle. Execute a private copy of these exact
  // verified bytes, so concurrent installation cannot replace the checked file.
  const handle=fs.openSync(executable,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  let bytes:Buffer;
  try {
   const stat=fs.fstatSync(handle);
   if(!stat.isFile()||!(stat.mode&0o111)||stat.size>64*1024*1024) throw new Error();
   bytes=fs.readFileSync(handle);
  }finally{fs.closeSync(handle);}
  if(createHash('sha256').update(bytes).digest('hex')!==pin.binarySha256) throw new Error();
  directory=fs.mkdtempSync(join(tmpdir(),'pyry-source-scan-'));
  fs.chmodSync(directory,0o700);
  const binary=join(directory,'gitleaks'),config=join(directory,'default.toml'),ignore=join(directory,'.gitleaksignore');
  fs.writeFileSync(binary,bytes,{mode:0o700,flag:'wx'});
  fs.writeFileSync(config,'[extend]\nuseDefault = true\n',{mode:0o600,flag:'wx'});
  fs.writeFileSync(ignore,'',{mode:0o600,flag:'wx'});
  const source=join(directory,'source');
  fs.mkdirSync(source,{mode:0o700});
  // Paths/modes/size were validated before this call. Match the pinned rules
  // directly: extname loses extension-only basenames such as .yaml, while
  // PKCS #12 requires a basename before its suffix (so .p12 does not match).
  let index=0;
  for(const [path,content] of Object.entries(files)) if(content!==null) {
   const folder=join(source,String(index++));
   fs.mkdirSync(folder,{mode:0o700});
   const original=basename(path);
   const name=privateNames.find(([predicate])=>{
    const match=predicate.exec(original);
    // Go's $ requires the absolute end; JavaScript's also permits a final LF.
    return match && match.index+match[0].length===original.length;
   })?.[1]??'candidate';
   // Scan padding defeats MIME/archive sniffing only in the private copy.
   // The complete original content and publication bytes remain unchanged.
   fs.writeFileSync(join(folder,name),'\n'.repeat(1024)+content,{mode:0o600,flag:'wx'});
  }
  const flags=[
   '--config',config,'--gitleaks-ignore-path',ignore,
   '--ignore-gitleaks-allow','--redact=100','--no-banner','--no-color',
   '--log-level','error','--exit-code','1','--timeout','9',
  ];
  // Both scans use the same trusted config and empty ignore, with no ambient
  // settings. Directory mode retains filenames required by embedded rules.
  // stdin additionally covers bytes skipped by MIME/filename/default allowlists.
  for(const mode of ['dir','stdin']) {
   const result=childProcess.spawnSync(binary,[mode,...flags,...(mode==='dir'?[source]:[])],{
    cwd:directory,env:{HOME:directory,TMPDIR:directory,XDG_CONFIG_HOME:directory,GOMAXPROCS:'2'},
    // A trusted text prefix prevents stdin's MIME sniff from skipping a whole
    // package whose first submitted bytes happen to have a binary signature.
    input:mode==='stdin'?'\n'.repeat(1024)+Object.values(files).filter((value):value is string=>value!==null).join('\n'):undefined,
    stdio:['pipe','ignore','ignore'],timeout:TIMEOUT_MS,killSignal:'SIGKILL',
   });
   if(result.error||result.signal||result.status!==0) throw new Error();
  }
 }catch {
  // Never propagate scanner output, matches, source, or system error paths.
  throw new Error(FAILURE);
 }finally {
  if(directory) {
   try {fs.rmSync(directory,{recursive:true,force:true});}
   catch {throw new Error(FAILURE);}
  }
 }
}
