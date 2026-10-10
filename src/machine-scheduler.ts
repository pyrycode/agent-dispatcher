import type { FleetSnapshot, MachineLimits, ResourceClass } from "./fleet-store.js";

export interface WorkOffer {
  project: string;
  ticket: string;
  role: string;
  resource: ResourceClass;
  locks: string[];
  key: string;
  order: number;
  roleLimit?: number;
}

/** Offers are already eligible: blockers, errors and backoff belong to the dispatcher. */
export function scheduleMachine(opts: {
  machine: string; projects: readonly string[];
  offers: readonly WorkOffer[]; state: FleetSnapshot;
} & MachineLimits): WorkOffer[] {
  const claims = new Map(opts.state.claims.map(c => [c.ticket, c]));
  const active = new Set(opts.state.runs.map(r => r.ticket));
  const locks = new Set(opts.state.runs.flatMap(r => r.locks));
  const localRuns = opts.state.runs.filter(r => r.machine === opts.machine);
  let heavyPlaces = Math.max(0, opts.heavyLimit - localRuns.filter(r => r.resource === "heavy").length);
  let combinedPlaces = Math.max(0, opts.combinedLimit - localRuns.filter(r => r.resource !== "light").length);
  const rank = new Map(opts.projects.map((p, i) => [p, i]));
  const ready = opts.offers.filter(o => rank.has(o.project) && (!claims.has(o.ticket) || claims.get(o.ticket)!.machine === opts.machine));
  ready.sort((a, b) => {
    const ac = claims.get(a.ticket), bc = claims.get(b.ticket);
    return Number(!ac) - Number(!bc)
      || (ac && bc ? ac.created - bc.created : rank.get(a.project)! - rank.get(b.project)!)
      || a.order - b.order || a.ticket.localeCompare(b.ticket) || a.key.localeCompare(b.key);
  });
  const selected: WorkOffer[] = [];
  for (const job of ready) {
    if (active.has(job.ticket) || locks.has(`${job.project}:reconcile`) || job.locks.some(l => locks.has(l))) continue;
    if (job.roleLimit !== undefined && [...opts.state.runs, ...selected].filter(r => r.project === job.project && r.role === job.role).length >= job.roleLimit) continue;
    if (job.resource !== "light" && combinedPlaces === 0) continue;
    if (job.resource === "heavy" && heavyPlaces === 0) continue;
    if (job.resource === "heavy") heavyPlaces--;
    if (job.resource !== "light") combinedPlaces--;
    active.add(job.ticket);
    job.locks.forEach(l => locks.add(l));
    selected.push(job);
  }
  return selected;
}
