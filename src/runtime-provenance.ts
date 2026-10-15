import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
export interface RuntimeProvenance {image:string;tools:string;gates:string;testDaemon:string;agents:string}
/** Only immutable identifiers from a protected record are shared with later roles. */
export function validateRuntimeProvenance(value:unknown):RuntimeProvenance {
 const v=value as RuntimeProvenance;
 if(!v || Object.keys(v).sort().join(',')!=='agents,gates,image,testDaemon,tools'
  || typeof v.agents!=='string' || typeof v.testDaemon!=='string' || !/^[a-f0-9]{40}$/.test(v.agents) || !/^[a-f0-9]{40}$/.test(v.testDaemon)
  || ![v.image,v.tools,v.gates].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))) throw new Error('Invalid protected runtime record');
 return {...v};
}
export function readRuntimeProvenance(path:string|undefined,ticketRoot:string):RuntimeProvenance|undefined {
 if(path===undefined) return undefined;
 try {
  if(lstatSync(path).isSymbolicLink()) throw new Error();
  const inside=relative(realpathSync(ticketRoot),realpathSync(path));
  if(!isAbsolute(inside)&&inside!=='..'&&!inside.startsWith('..'+sep)) throw new Error();
  return validateRuntimeProvenance(JSON.parse(readFileSync(resolve(path),'utf8')));
 } catch {throw new Error('Protected runtime provenance is unavailable or invalid');}
}
