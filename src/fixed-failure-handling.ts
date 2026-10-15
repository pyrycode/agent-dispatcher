import type {ProjectItem} from './types.js';
import type {RecoveryDecision} from './fleet-recovery.js';

/** Known restrictions keep their evidence and wait for an observable change. */
export function fixedFailureDecision(item: ProjectItem, coordinated = false): RecoveryDecision | null {
  if (item.labels.includes('error:publication-refused')) return {
    action:'escalate', category:'human', reason:'Publication was definitely refused. Retain the local work and resolve the refusal before an operator retries publication.',
  };
  if (item.labels.includes('error:authentication')) return {
    action:'escalate', category:'operational', reason:'The configured login was refused. Restore the login through its existing account helper, then clear the held stage through the operator command.',
  };
  if (item.labels.includes('error:infra') || item.labels.includes('held:health-check')) return {
    action:'escalate', category:'operational', reason:'A required platform, toolchain or health check is unavailable. Keep the stage held until readiness or its evidence changes.',
  };
  if (item.recoveryPause?.origin === 'pipeline' && /login|credential|platform|toolchain/i.test(item.recoveryPause.missing)) return {
    action:'escalate', category:'operational', reason:'A recorded login, platform or toolchain prerequisite is unavailable. Keep its pause until the prerequisite changes.',
  };
  if (!coordinated && !item.labels.some(l=>l.startsWith('error:')) && item.blockedBy.some(b=>b.state==='OPEN')) return {
    action:'wait', reason:'An open causal dependency holds this stage. Reconsider when the dependency or ticket evidence changes.',
    waitFor:{tickets:item.blockedBy.filter(b=>b.state==='OPEN').flatMap(b=>{
      const match=/^https:\/\/github.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)$/.exec(b.url??'');
      return match?[match[1]+'#'+match[2]]:[];
    })},
  };
  return null;
}
