import {createHash} from 'node:crypto';

// Per-task bounds apply to the complete inventory, independently of the RPC size.
export const ARTIFACT_LIMITS = {bytes:64*1024*1024,files:1024,chunkBytes:256*1024,manifestBytes:1024*1024} as const;
export interface ArtifactFile {path:string;bytes:number;sha256:string;chunks:string[]}
export interface ArtifactManifest {version:1;chunkBytes:number;totalBytes:number;files:ArtifactFile[]}
export const sha256=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export const manifestHash=(manifest:ArtifactManifest)=>sha256(JSON.stringify(manifest));

export function validateArtifactPath(path:string):void {
 if(typeof path!=='string' || path.length>240 || !/^[\w./-]+$/.test(path) || path.startsWith('/')
  || path.split('/').some(p=>!p || p==='.' || p==='..') || path.split('/')[0].startsWith('.fleet-task-')) throw new Error('Invalid artifact path');
}
export function validateManifest(value:ArtifactManifest):ArtifactManifest {
 if(!value || value.version!==1 || value.chunkBytes!==ARTIFACT_LIMITS.chunkBytes || !Array.isArray(value.files)
  || value.files.length>ARTIFACT_LIMITS.files || JSON.stringify(value).length>ARTIFACT_LIMITS.manifestBytes
  || Object.keys(value).some(k=>!['version','chunkBytes','totalBytes','files'].includes(k))) throw new Error('Invalid artifact manifest');
 const paths=new Set<string>();let total=0;
 const files=value.files.map(file=>{
  if(!file) throw new Error('Invalid artifact manifest');
  validateArtifactPath(file.path);
  if(paths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes<0 || file.bytes>ARTIFACT_LIMITS.bytes
   || typeof file.sha256!=='string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !Array.isArray(file.chunks)
   || file.chunks.length!==Math.ceil(file.bytes/ARTIFACT_LIMITS.chunkBytes) || file.chunks.some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h))
   || Object.keys(file).some(k=>!['path','bytes','sha256','chunks'].includes(k))) throw new Error('Invalid artifact inventory');
  paths.add(file.path);total+=file.bytes;
  return {path:file.path,bytes:file.bytes,sha256:file.sha256,chunks:[...file.chunks]};
 }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(total>ARTIFACT_LIMITS.bytes || value.totalBytes!==total) throw new Error('Task artifacts exceed total bounds or byte count');
 for(const path of paths) {
  const parts=path.split('/');parts.pop();
  while(parts.length) {if(paths.has(parts.join('/'))) throw new Error('Conflicting artifact paths');parts.pop();}
 }
 return {version:1,chunkBytes:ARTIFACT_LIMITS.chunkBytes,totalBytes:total,files};
}
export function artifactManifest(files:Record<string,string>):ArtifactManifest {
 return validateManifest({version:1,chunkBytes:ARTIFACT_LIMITS.chunkBytes,totalBytes:Object.values(files).reduce((n,s)=>n+Buffer.byteLength(s),0),
  files:Object.entries(files).map(([path,text])=>{
   const data=Buffer.from(text),chunks:string[]=[];
   if(data.toString('utf8')!==text) throw new Error('Artifact is not exact UTF-8');
   for(let i=0;i<data.length;i+=ARTIFACT_LIMITS.chunkBytes) chunks.push(sha256(data.subarray(i,i+ARTIFACT_LIMITS.chunkBytes)));
   return {path,bytes:data.length,sha256:sha256(data),chunks};
  })});
}
