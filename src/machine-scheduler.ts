import { countsForRoleLimit, heavyProject, supportTaskHolds, type FleetSnapshot, type MachineLimits, type ResourceClass, type RoleLimitScope } from "./fleet-store.js";
import type { AgentRunner } from "./agent-runner.js";
import { startsCodex } from "./codex-throttle.js";
import { missingCapabilities } from "./ticket-requirements.js";

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
/**
 * The authority also spaces Codex starts fleet-wide. While the snapshot says
 * the next start must wait, the scheduler passes over Codex offers the same
 * way, so fitting non-Codex work starts instead.
 */
export function codexSpaced(offer: WorkOffer, state: FleetSnapshot): boolean {
  return state.codexSpacing?.held === true && offer.role !== "recovery-task" && startsCodex(offer, state.runnerPolicy);
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

/**
 * The capabilities this computer lacks for an offer's ticket, from the
 * authority's requirement list. Empty when it can run the offer. The
 * authority refuses the start anyway; skipping it here lets other work
 * start in its place. A support task carries its own platform and is not
 * a ticket stage, so it is never held here.
 */
export function lackingCapabilities(offer: WorkOffer, state: FleetSnapshot, capabilities: readonly string[] | undefined): string[] {
  const required = /#[1-9]\d*$/.test(offer.ticket) ? state.ticketRequirements?.[offer.ticket] : undefined;
  return required?.length ? missingCapabilities(required, capabilities) : [];
}

/** Draining stops new tickets, while reconciliation can still advance owned work. */
export function acceptsDuringProjectDrain(offer: WorkOffer, machine: string, drainingProjects: readonly string[], state: FleetSnapshot): boolean {
  return offer.role==="recovery-task" && !!offer.supportTaskId
    || !drainingProjects.includes(offer.project)
    || (offer.role === "reconcile" && offer.ticket === `${offer.project}#@reconcile`)
    || (/#[1-9]\d*$/.test(offer.ticket) && state.claims.some(c => c.ticket === offer.ticket && c.machine === machine));
}

/** Count runnable ownership, not persistent claims for completed or blocked tickets. */
export function runnableTickets(machine: string, offers: readonly WorkOffer[], state: FleetSnapshot, policy?: EligibilityPolicy): Set<string> {
  const owned = new Set(state.claims.filter(c => c.machine === machine).map(c => c.ticket));
  return new Set([
    ...state.runs.filter(r => r.machine === machine).map(r => r.ticket),
    ...offers.filter(o => owned.has(o.ticket) && !idleAssessment(o, state) && (!policy || !workEligibility(o, state, policy))).map(o => o.ticket),
  ].filter(ticket => /#[1-9]\d*$/.test(ticket)));
}

/** A numbered ticket no computer owns yet. Taking it is taking a new ticket. */
export function isNewTicket(ticket: string, state: FleetSnapshot): boolean {
  return /#[1-9]\d*$/.test(ticket) && !state.claims.some(c => c.ticket === ticket);
}

/** Roles that review a ticket: the builder set's verifier and the classic qa and code-review. */
export const REVIEW_ROLES: ReadonlySet<string> = new Set(["verifier", "qa", "code-review"]);

/**
 * This computer's review queue: tickets it owns, across all its projects,
 * that the authority reports waiting for review, that no run holds
 * (including a support task serving the ticket), and whose review its own
 * dispatcher currently offers with every required repair ready. The offer
 * test fails open: a review the dispatcher holds back (a failed health
 * check, a verdict waiting to publish, backoff, a stopped dispatcher or a
 * project this manager no longer serves) cannot hold new work here.
 * Undefined when the claim service predates the report, so an older
 * authority holds nothing.
 */
export interface EligibilityPolicy {
  machine: string; projects: readonly string[]; drainingProjects?: readonly string[]; drainedProjects?: readonly string[]; capabilities?: readonly string[];
}
export function workEligibility(offer: WorkOffer, state: FleetSnapshot, policy: EligibilityPolicy): string | undefined {
  const owned = state.claims.find(c => c.ticket === offer.ticket);
  if (!policy.projects.includes(offer.project)) return "unserved";
  if (owned && owned.machine !== policy.machine) return "owned-elsewhere";
  if ((policy.drainedProjects ?? []).some(p => p === offer.project || p === offer.parentTicket?.split("#")[0])) return "drained";
  if (!acceptsDuringProjectDrain(offer, policy.machine, policy.drainingProjects ?? [], state)) return "project-draining";
  if ((state.machineRecoveries ?? []).some(r => r.machine === policy.machine && r.cleared === undefined && [offer.project, offer.parentTicket?.split("#")[0]].includes(r.project))) return "drained";
  if (lackingCapabilities(offer, state, policy.capabilities).length) return "missing-capability";
  if (offer.role !== "recovery" && !(state.requiredRepairs?.[offer.ticket] ?? []).every(sha => offer.readyRepairs?.includes(sha))) return "missing-repair";
  // The authority refuses it until the ticket's support task ends. An older
  // claim service leaves the list out, which holds nothing here.
  if (supportTaskHolds(offer.ticket, offer.role, state.openTaskTickets ?? [])) return "support-task-open";
  return undefined;
}
export function reviewQueue(machine: string, state: FleetSnapshot, offers: readonly WorkOffer[], policy?: EligibilityPolicy): string[] | undefined {
  if (!state.reviewReadyTickets) return undefined;
  const owned = new Set(state.claims.filter(c => c.machine === machine).map(c => c.ticket));
  const running = new Set(state.runs.flatMap(r => r.parentTicket ? [r.ticket, r.parentTicket] : [r.ticket]));
  const offered = new Set(offers.filter(o => REVIEW_ROLES.has(o.role) && (!policy || !workEligibility(o, state, policy))
    && (state.requiredRepairs?.[o.ticket] ?? []).every(sha => o.readyRepairs?.includes(sha))).map(o => o.ticket));
  return state.reviewReadyTickets.filter(t => owned.has(t) && !running.has(t) && offered.has(t));
}

/**
 * The review queue limit in force: the configured reviewQueueLimit, or the
 * heavy limit when none is set, since review takes a heavy place. 0 turns the
 * hold off.
 */
export function effectiveReviewQueueLimit(limits: { heavyLimit: number; reviewQueueLimit?: number }): number {
  return limits.reviewQueueLimit ?? limits.heavyLimit;
}

/** Offers are already eligible: blockers, errors and backoff belong to the dispatcher. */
export function scheduleMachine(opts: {
  machine: string; projects: readonly string[]; drainingProjects?: readonly string[]; ticketLimit?: number;
  /**
   * Boards that take no new grants at all: a central drain or stop (see
   * desired-state.ts). A support task is held when the board of the ticket
   * it serves is listed too.
   */
  drainedProjects?: readonly string[];
  /** What this computer advertises to tickets with a `requires:` label. See ticket-requirements.ts. */
  capabilities?: readonly string[];
  /**
   * While this computer has at least this many owned tickets waiting for
   * review, it takes no new ticket. Owned work always continues. Defaults to
   * heavyLimit; 0 turns the hold off. See reviewQueue.
   */
  reviewQueueLimit?: number;
  /**
   * Every current offer, for the review queue's offer test. The manager's
   * admission loop passes `offers` without the ones it already tried this
   * tick, and a review refused for capacity still waits. Defaults to offers.
   */
  reviewOffers?: readonly WorkOffer[];
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
  const runnable = runnableTickets(opts.machine, opts.offers, opts.state, opts);
  let ticketPlaces = Math.max(0, (opts.ticketLimit ?? Infinity) - runnable.size);
  const reviewLimit = effectiveReviewQueueLimit(opts);
  // A ticket leaves the queue once a run selected here takes it.
  const waitingReview = new Set(reviewQueue(opts.machine, opts.state, opts.reviewOffers ?? opts.offers, opts) ?? []);
  const reviewQueueFull = () => reviewLimit > 0 && opts.state.reviewReadyTickets !== undefined && waitingReview.size >= reviewLimit;
  const rank = new Map(opts.projects.map((p, i) => [p, i]));
  const priorityHigh = new Set(opts.state.priorityHighTickets ?? []);
  const ready = opts.offers.filter(o => workEligibility(o, opts.state, opts) === undefined);
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
    if (codexPaused(job, opts.state) || codexSpaced(job, opts.state)) continue;
    if (lackingCapabilities(job, opts.state, opts.capabilities).length) continue;
    if (job.roleLimit !== undefined && [...opts.state.runs, ...selected].filter(r => countsForRoleLimit(r, job, opts.machine)).length >= job.roleLimit) continue;
    const newTicket = /#[1-9]\d*$/.test(job.ticket) && !claims.has(job.ticket);
    if (newTicket && ticketPlaces === 0) continue;
    if (newTicket && reviewQueueFull()) continue;
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
    waitingReview.delete(job.ticket);
    if (job.parentTicket) waitingReview.delete(job.parentTicket);
    active.add(job.ticket);
    job.locks.forEach(l => locks.add(l));
    selected.push(job);
  }
  return selected;
}
