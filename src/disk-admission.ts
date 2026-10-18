import { statfs } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface DiskAdmissionConfig { path: string; minFreeBytes: number }
export type DiskSpaceProbe = (path:string) => Promise<number>;
export interface DiskAdmissionStatus {
  state:'disabled'|'ready'|'waiting-storage'; allowed:boolean;
  path?:string; minFreeBytes?:number; freeBytes?:number|null; reason?:string;
}

export function validateDiskAdmission(config:DiskAdmissionConfig|undefined):void {
  if(config===undefined)return;
  if(!config || typeof config.path!=='string' || !isAbsolute(config.path) || config.path.includes('\0')
    || config.path.split('/').includes('..') || !Number.isSafeInteger(config.minFreeBytes) || config.minFreeBytes<1
    || Object.keys(config).some(key=>!['path','minFreeBytes'].includes(key)))throw new Error('Invalid disk admission configuration');
}

export const availableDiskBytes:DiskSpaceProbe = async path => {
  const observed=await statfs(path,{bigint:true});
  if(observed.bavail<0n || observed.bsize<=0n)throw new Error('Available disk space is unknown');
  const available=observed.bavail*observed.bsize;
  return Number(available>BigInt(Number.MAX_SAFE_INTEGER)?BigInt(Number.MAX_SAFE_INTEGER):available);
};

export async function diskAdmission(config:DiskAdmissionConfig|undefined,probe:DiskSpaceProbe=availableDiskBytes):Promise<DiskAdmissionStatus> {
  if(config===undefined)return {state:'disabled',allowed:true};
  validateDiskAdmission(config);
  const basis={path:config.path,minFreeBytes:config.minFreeBytes};
  try {
    const freeBytes=await probe(config.path);
    if(!Number.isSafeInteger(freeBytes)||freeBytes<0)throw new Error('Available disk space is unknown');
    const allowed=freeBytes>=config.minFreeBytes;
    return {...basis,state:allowed?'ready':'waiting-storage',allowed,freeBytes,...(!allowed?{
      reason:'Free disk space is below the configured start floor. New heavy work waits for storage.'}: {})};
  } catch {
    return {...basis,state:'waiting-storage',allowed:false,freeBytes:null,
      reason:'Available disk space could not be confirmed. New heavy work waits for a successful storage check.'};
  }
}
