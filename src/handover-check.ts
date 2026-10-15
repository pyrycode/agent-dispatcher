import type { FleetSnapshot } from './fleet-store.js';
import type { EvidenceStore } from './evidence-store.js';

export interface HandoverProof {
  ticket: string; runId: string; generation: string; commit: string; remoteCommit: string;
  remoteCheckedAt: number; evidenceDigest: string; requiredFiles: string[];
}
export interface HandoverFacts {
  snapshot: FleetSnapshot;
  latestRunId?:string;
  predecessor?: {ticket:string;generation:string;machine:string;finished:number|null;outcome:string|null};
  workflow?: {state:string; labels:string[]};
  tasks: {state:string; artifactsPending?:boolean}[];
}
/** A preflight only. No proof here can free a claim or replace stop confirmation. */
export function checkHandover(proof:HandoverProof,facts:HandoverFacts,evidence:EvidenceStore,now=Date.now()): {ready:boolean; reasons:string[]} {
  if(!proof || !/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(proof.ticket)
    || !/^[a-f0-9]{40}$/.test(proof.commit) || !/^[a-f0-9]{40}$/.test(proof.remoteCommit)
    || !/^[a-f0-9]{64}$/.test(proof.evidenceDigest) || typeof proof.generation!=='string'
    || !Array.isArray(proof.requiredFiles) || !proof.requiredFiles.length || proof.requiredFiles.length>100
    || proof.requiredFiles.some(p=>typeof p!=='string'||!p||p==='pointers.json'||p.split('/').some(s=>!s||s==='.'||s==='..'))) throw new Error('Invalid handover proof');
  const reasons:string[]=[];
  const run=facts.predecessor;
  const claim=facts.snapshot.claims.find(c=>c.ticket===proof.ticket);
  if(facts.latestRunId!==proof.runId) reasons.push('The proof is not for the latest predecessor');
  if(!claim || claim.generation!==proof.generation || !run || run.ticket!==proof.ticket
    || run.generation!==proof.generation || run.machine!==claim.machine) reasons.push('The exact claimed predecessor is missing or changed');
  if(!run || run.finished===null || run.outcome!=='completed'
    || facts.snapshot.runs.some(r=>r.ticket===proof.ticket)) reasons.push('The predecessor is not confirmed complete and stopped');
  if(proof.commit!==proof.remoteCommit || !Number.isSafeInteger(proof.remoteCheckedAt)
    || proof.remoteCheckedAt>now || now-proof.remoteCheckedAt>60_000) reasons.push('The exact remote commit needs a fresh protected check');
  if(!facts.workflow || facts.workflow.state!=='OPEN' || facts.workflow.labels.some(l=>/^(pending-verdict:|pending-done:|wip:|error:|needs-rework:|held:|needs-human:)/.test(l))) reasons.push('Workflow or a verdict is unsettled');
  if(facts.tasks.some(t=>!['complete','failed'].includes(t.state)||t.artifactsPending)) reasons.push('Native task execution or publication is unsettled');
  try {
    const bundle=evidence.list(proof.ticket,proof.runId)[0];
    if(!bundle || bundle.digest!==proof.evidenceDigest) throw new Error();
    for(const path of proof.requiredFiles) {
      const file=bundle.manifest.files.find(f=>f.path===path);
      if(!file || file.bytes===0) throw new Error();
      for(let part=0;part<file.chunks.length;part++) evidence.read(proof.ticket,proof.runId,bundle.digest,path,part);
    }
  } catch {reasons.push('Every required file must be readable in the committed bundle, not a local pointer');}
  return {ready:reasons.length===0,reasons};
}

export interface PilotComputer {name:string;platform:string;eligible:boolean;busy:boolean}
/** Disabled shadow choice. It never admits work, releases ownership or uses heartbeats. */
export function shadowHandoverChoice(config:{enabled?:boolean;projects:string[];affinityMs?:number},project:string,previous:string,completedAt:number,computers:PilotComputer[],now=Date.now()):string|null {
  if(!config.enabled || !config.projects.includes(project)) return null;
  if(!Number.isSafeInteger(completedAt)||completedAt>now) return null;
  const affinity=config.affinityMs??60_000;
  if(!Number.isSafeInteger(affinity)||affinity<0||affinity>300_000) throw new Error('Invalid handover affinity');
  const candidates=computers.filter(c=>c.platform==='linux'&&c.eligible&&!c.busy).sort((a,b)=>a.name.localeCompare(b.name));
  if(now-completedAt<affinity) return candidates.find(c=>c.name===previous)?.name??null;
  return candidates.find(c=>c.name===previous)?.name??candidates[0]?.name??null;
}
