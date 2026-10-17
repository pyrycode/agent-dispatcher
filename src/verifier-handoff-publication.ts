import type {FleetStore} from './fleet-store.js';
import type {GitHubBroker} from './github-broker.js';
export class PublishedCandidateChanged extends Error {}
/** Candidate checks stay in the existing publication path, including later advance and merge. */
export async function guardPinnedPublication(store:FleetStore,upstream:GitHubBroker|undefined,ticket:string):Promise<void>{
 const candidate=store.verificationCandidate(ticket);if(!candidate)return;
 if(!upstream)throw new Error('Pinned verification requires shared GitHub publication checks');
 const project=ticket.split('#')[0],number=ticket.split('#')[1];
 const result=await upstream.request(project,{method:'GET',path:`/repos/${project}/git/ref/heads/feature/${number}`,fresh:true});
 if(result.status!==200)throw new Error('Cannot confirm published handoff candidate');
 if(JSON.parse(result.body).object?.sha!==candidate){
  store.invalidateVerificationCandidate(ticket,candidate);
  throw new PublishedCandidateChanged('Published candidate changed; pinned verdict and advance refused');
 }
}
