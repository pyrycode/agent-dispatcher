import { countsForRoleLimit, heavyProject, type FleetSnapshot, type MachineLimits, type ResourceClass, type RoleLimitScope } from "./fleet-store.js";
import type { AgentRunner } from "./agent-runner.js";
import { startsCodex } from "./codex-throttle.js";

export interface WorkOffer {
  workflowVersion?: 1;
  project: string;
  ticket: string;
  role: string;
  resource: ResourceClass;
  locks: string[];
  key: string;
  order: number;
  roleLimit?: number;
  /** Absent means "fleet": the limit counts this project's role on every computer. */
  roleLimitScope?: RoleLimitScope;
  recovery?: boolean;
  recoveryError?: boolean;
  requiresRecovery?: boolean;
  readyRepairs?: string[];
  supportTaskId?:string; parentTicket?:string;
  runner?: AgentRunner;
}

/**
 * The authority refuses this offer while a fleet Codex pause lasts, so the
 * scheduler passes over it for work that can start. The authority still
 * decides: a pause can begin after this snapshot. A support task's recipe is
 * not in its offer, so only the authority can hold one.
 */
export function codexPaused(offer: WorkOffer, state: FleetSnapshot): boolean {
  return state.codexPause?.active === true && offer.role !== "recovery-task" && startsCodex(offer, state.runnerPolicy);
}

/** The authority classifies queued checks, including offers from older workers. */
function idleAssessment(offer: WorkOffer, state: FleetSnapshot): boolean {
  return offer.role === "recovery" && !!state.idleRecoveryTickets?.includes(offer.ticket);
}

/**
 * A priority:high ticket waiting for its verifier. It ranks ahead of recovery
 * checks, assigned repairs and support tasks, so it also ranks ahead of all
 * other waiting work. Ranking only: every admission check below still applies.
 * The authority names the tickets from its workflow labels.
 */
function urgentVerifier(offer: WorkOffer, priorityHigh: ReadonlySet<string>): boolean {
  return offer.role === "verifier" && /#[1-9]\d*$/.test(offer.ticket) && priorityHigh.has(offer.ticket);
}

/** Draining stops new tickets, while reconciliation can still advance owned work. */
export function acceptsDuringProjectDrain(offer: WorkOffer, machine: string, drainingProjects: readonly string[], state: FleetSnapshot): boolean {
  return offer.role==="recovery-task" && !!offer.supportTaskId
    || !drainingProjects.includes(offer.project)
    || (offer.role === "reconcile" && offer.ticket === `${offer.project}#@reconcile`)
    || (/#[1-9]\d*$/.test(offer.ticket) && state.claims.some(c => c.ticket === offer.ticket && c.machine === machine));
}

/** Count runnable ownership, not persistent claims for completed or blocked tickets. */
export function runnableTickets(machine: string, offers: readonly WorkOffer[], state: FleetSnapshot): Set<string> {
  const owned = new Set(state.claims.filter(c => c.machine === machine).map(c => c.ticket));
  return new Set([
    ...state.runs.filter(r => r.machine === machine).map(r => r.ticket),
    ...offers.filter(o => owned.has(o.ticket) && !idleAssessment(o, state)).map(o => o.ticket),
  ].filter(ticket => /#[1-9]\d*$/.test(ticket)));
}

/** Offers are already eligible: blockers, errors and backoff belong to the dispatcher. */
export function scheduleMachine(opts: {
  machine: string; projects: readonly string[]; drainingProjects?: readonly string[]; ticketLimit?: number;
  offers: readonly WorkOffer[]; state: FleetSnapshot;
} & MachineLimits): WorkOffer[] {
  const claims = new Map(opts.state.claims.map(c => [c.ticket, c]));
  const active = new Set(opts.state.runs.map(r => r.ticket));
  const locks = new Set(opts.state.runs.flatMap(r => r.locks));
  const localRuns = opts.state.runs.filter(r => r.machine === opts.machine);
  let heavyPlaces = Math.max(0, opts.heavyLimit - localRuns.filter(r => r.resource === "heavy").length);
  let combinedPlaces = Math.max(0, opts.combinedLimit - localRuns.filter(r => r.resource !== "light").length);
  // Heavy places a project may still take here, for projects with their own limit.
  const projectHeavy = new Map(Object.entries(opts.projectHeavyLimits ?? {}).map(([project, limit]) =>
    [project, Math.max(0, limit - localRuns.filter(r => r.resource === "heavy" && heavyProject(r) === project).length)]));
  const runnable = runnableTickets(opts.machine, opts.offers, opts.state);
  let ticketPlaces = Math.max(0, (opts.ticketLimit ?? Infinity) - runnable.size);
  const rank = new Map(opts.projects.map((p, i) => [p, i]));
  const priorityHigh = new Set(opts.state.priorityHighTickets ?? []);
  const ready = opts.offers.filter(o => rank.has(o.project) && (!claims.has(o.ticket) || claims.get(o.ticket)!.machine === opts.machine)
    && acceptsDuringProjectDrain(o, opts.machine, opts.drainingProjects ?? [], opts.state));
  ready.sort((a, b) => {
    const parentClaim=(o:WorkOffer)=>o.supportTaskId&&o.parentTicket?claims.get(o.parentTicket):undefined;
    const ac=claims.get(a.ticket)??parentClaim(a),bc=claims.get(b.ticket)??parentClaim(b);
    return Number(idleAssessment(a, opts.state)) - Number(idleAssessment(b, opts.state))
      || Number(!urgentVerifier(a, priorityHigh)) - Number(!urgentVerifier(b, priorityHigh))
      || Number(!ac) - Number(!bc)
      || Number(!(a.role === "recovery" || a.recovery)) - Number(!(b.role === "recovery" || b.recovery))
      || Number(!a.recoveryError) - Number(!b.recoveryError)
      || (ac && bc ? ac.created - bc.created : rank.get(a.project)! - rank.get(b.project)!)
      || a.order - b.order || a.ticket.localeCompare(b.ticket) || a.key.localeCompare(b.key);
  });
  const selected: WorkOffer[] = [];
  for (const job of ready) {
    if (idleAssessment(job, opts.state) && [...localRuns, ...selected].some(r => /#[1-9]\d*$/.test(r.ticket))) continue;
    if (active.has(job.ticket) || locks.has(`${job.project}:reconcile`) || job.locks.some(l => locks.has(l))) continue;
    if (codexPaused(job, opts.state)) continue;
    if (job.roleLimit !== undefined && [...opts.state.runs, ...selected].filter(r => countsForRoleLimit(r, job, opts.machine)).length >= job.roleLimit) continue;
    const newTicket = /#[1-9]\d*$/.test(job.ticket) && !claims.has(job.ticket);
    if (newTicket && ticketPlaces === 0) continue;
    if (job.resource !== "light" && combinedPlaces === 0) continue;
    if (job.resource === "heavy" && heavyPlaces === 0) continue;
    if (job.resource === "heavy" && projectHeavy.get(heavyProject(job)) === 0) continue;
    if (job.resource === "heavy") {
      heavyPlaces--;
      const project = heavyProject(job);
      if (projectHeavy.has(project)) projectHeavy.set(project, projectHeavy.get(project)! - 1);
    }
    if (job.resource !== "light") combinedPlaces--;
    if (newTicket) ticketPlaces--;
    active.add(job.ticket);
    job.locks.forEach(l => locks.add(l));
    selected.push(job);
  }
  return selected;
}
