import type { FleetSnapshot, ResourceClass } from "./fleet-store.js";

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
  machine: string; limit: number; projects: readonly string[];
  offers: readonly WorkOffer[]; state: FleetSnapshot;
}): WorkOffer[] {
  const claims = new Map(opts.state.claims.map(c => [c.ticket, c]));
  const active = new Set(opts.state.runs.map(r => r.ticket));
  const locks = new Set(opts.state.runs.flatMap(r => r.locks));
  let places = Math.max(0, opts.limit - opts.state.runs.filter(r => r.machine === opts.machine && r.resource === "heavy").length);
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
    if (job.resource === "heavy" && places === 0) continue;
    if (job.resource === "heavy") places--;
    active.add(job.ticket);
    job.locks.forEach(l => locks.add(l));
    selected.push(job);
  }
  return selected;
}
