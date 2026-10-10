import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { listen, readJson, tokenMatches, type FleetClient } from "./fleet-http.js";
import { validateStart, validateLimits, type MachineLimits, type FleetRun } from "./fleet-store.js";
import { scheduleMachine, runnableTickets, acceptsDuringProjectDrain, type WorkOffer } from "./machine-scheduler.js";

export interface MachineConfig extends MachineLimits { machine: string; projects: string[]; drainingProjects?: string[]; ticketLimit?: number }
type ClaimService = Pick<FleetClient, "snapshot" | "start" | "finish"> & Partial<Pick<FleetClient, "authorize">>;
interface Offers { session: string; work: WorkOffer[]; at: number }
export function offerId(machine: string, session: string, offer: WorkOffer): string {
  return createHash("sha256").update(JSON.stringify([machine, session, offer.project, offer.key])).digest("hex");
}

export class MachineManager {
  private readonly offers = new Map<string, Offers>();
  private tickPromise: Promise<void> | undefined;
  private readonly finished = new Set<string>();
  draining = false;
  constructor(readonly config: MachineConfig, readonly claims: ClaimService, private readonly now = Date.now) {
    validateLimits(config);
    if (config.ticketLimit !== undefined && (!Number.isSafeInteger(config.ticketLimit) || config.ticketLimit < 1)) throw new Error("Invalid ticket limit");
    if (!config.machine || new Set(config.projects).size !== config.projects.length) throw new Error("Invalid machine configuration");
    if (config.drainingProjects !== undefined && (!Array.isArray(config.drainingProjects) || config.drainingProjects.some(p => !config.projects.includes(p)))) throw new Error("Invalid project drain configuration");
  }
  async setProjectDraining(project: string, draining: boolean, persist: (projects: string[]) => void): Promise<void> {
    if (!this.config.projects.includes(project) || typeof draining !== "boolean") throw new Error("Invalid project drain request");
    const projects = new Set(this.config.drainingProjects ?? []);
    if (draining) projects.add(project); else projects.delete(project);
    const next = [...projects];
    // Save before acknowledging or changing admission. A failed save leaves
    // the previous policy intact. Both operations are synchronous.
    persist(next);
    this.config.drainingProjects = next;
    // A start already sent to the authority can still commit. Wait for it
    // before acknowledging the drain; subsequent jobs check the new policy.
    try { await this.tickPromise; } catch { /* a lost reply remains reserved */ }
  }
  offer(project: string, session: string, work: WorkOffer[]): void {
    if (!this.config.projects.includes(project) || !session || session.length > 200 || !Array.isArray(work) || work.length > 5000) throw new Error("Invalid offers");
    const keys = new Set<string>();
    for (const item of work) {
      if (item.project !== project || typeof item.key !== "string" || !item.key || item.key.length > 200 || keys.has(item.key) || !Number.isFinite(item.order)) throw new Error("Invalid offer");
      keys.add(item.key);
      validateStart({ ...item, id: offerId(this.config.machine, session, item), machine: this.config.machine, session });
    }
    const old = this.offers.get(project);
    if (old && old.session !== session && this.now() - old.at < 180_000) throw new Error("Another dispatcher session is registered; drain it first");
    this.offers.set(project, { session, work: structuredClone(work), at: this.now() });
  }
  tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    if (this.draining) return Promise.resolve();
    const promise = this.tickOnce().finally(() => { this.tickPromise = undefined; });
    this.tickPromise = promise;
    return promise;
  }
  private async tickOnce(): Promise<void> {
    const state = await this.claims.snapshot();
    const offers = [...this.offers.values()].filter(o => this.now() - o.at < 180_000).flatMap(o => o.work).filter(o => !this.finished.has(`${o.project}/${o.key}`));
    const selected = scheduleMachine({ ...this.config, offers, state });
    for (const job of selected) {
      if (this.draining) break;
      if (!acceptsDuringProjectDrain(job, this.config.machine, this.config.drainingProjects ?? [], state)) continue;
      const current = this.offers.get(job.project);
      if (!current || !current.work.some(w => w.key === job.key) || this.now() - current.at >= 180_000) continue;
      // A lost reply leaves a durable reservation. grants() recovers that exact
      // run from the server; it never guesses that a timed-out start failed.
      const { key: _key, order: _order, ...request } = job;
      const result = await this.claims.start({ ...request, id: offerId(this.config.machine, current.session, job), machine: this.config.machine, session: current.session });
      if (!result.ok && result.reason === "finished") this.finished.add(`${job.project}/${job.key}`);
    }
  }
  async withdraw(project: string, session: string): Promise<FleetRun[]> {
    const current = this.offers.get(project);
    if (current && current.session !== session) throw new Error("Dispatcher session mismatch");
    if (current) current.work = [];
    // A request already sent to the authority can still commit. Wait for it,
    // then return every reservation so the dispatcher can cancel unused ones.
    try { await this.tickPromise; } catch { /* snapshot recovers uncertain starts */ }
    const runs = (await this.claims.snapshot()).runs.filter(r => r.machine === this.config.machine && r.project === project && r.session === session);
    if (this.offers.get(project)?.session === session) this.offers.delete(project);
    return runs;
  }
  async status() {
    const state = await this.claims.snapshot();
    const available = [...this.offers.values()].filter(o => this.now() - o.at < 180_000).flatMap(o => o.work);
    const runnableOffers = available.filter(o => !this.finished.has(`${o.project}/${o.key}`));
    const eligible = new Set(scheduleMachine({ ...this.config, offers: runnableOffers, state }).map(o => `${o.project}/${o.key}`));
    return { machine: this.config.machine, heavyLimit: this.config.heavyLimit, combinedLimit: this.config.combinedLimit, ticketLimit: this.config.ticketLimit ?? null, runnableTicketCount: runnableTickets(this.config.machine, runnableOffers, state).size, draining: this.draining, drainingProjects: this.config.drainingProjects ?? [], ...state,
      projects: this.config.projects.map(project => ({ project, draining: this.config.drainingProjects?.includes(project) ?? false, lastSeen: this.offers.get(project)?.at ?? null })),
      queue: available.map(o => ({ ticket: o.ticket, role: o.role, resource: o.resource,
        state: this.finished.has(`${o.project}/${o.key}`) ? "already-completed"
          : state.runs.some(r => r.ticket === o.ticket) ? "reserved-or-running"
          : this.draining ? "draining"
          : state.claims.some(c => c.ticket === o.ticket && c.machine !== this.config.machine) ? "owned-elsewhere"
          : !acceptsDuringProjectDrain(o, this.config.machine, this.config.drainingProjects ?? [], state) ? "project-draining"
          : eligible.has(`${o.project}/${o.key}`) ? "eligible" : "waiting-for-capacity-or-lock" })),
    };
  }
  async grants(project: string, session: string): Promise<FleetRun[]> {
    const current = this.offers.get(project);
    if (!current || current.session !== session) return [];
    const ids = new Set(current.work.map(o => offerId(this.config.machine, session, o)));
    return (await this.claims.snapshot()).runs.filter(r => r.machine === this.config.machine && r.project === project && r.session === session && ids.has(r.id));
  }
  async finish(project: string, session: string, id: string, completed = true, unused = false): Promise<void> {
    const state = await this.claims.snapshot();
    const run = state.runs.find(r => r.id === id);
    if (run && (run.project !== project || run.session !== session || run.machine !== this.config.machine)) throw new Error("Run owner mismatch");
    await this.claims.finish(session, id, completed, unused);
  }
}

export async function serveManager(manager: MachineManager, projectTokens: Record<string, string>, operatorToken: string, port: number | string, host = "127.0.0.1", persistDrains?: (projects: string[]) => void): Promise<Server> {
  const tokens = [...Object.values(projectTokens), operatorToken];
  if (tokens.some(t => !t) || new Set(tokens).size !== tokens.length) throw new Error("Manager credentials must be distinct");
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    const admin = tokenMatches(req.headers.authorization, operatorToken);
    const project = Object.keys(projectTokens).find(p => tokenMatches(req.headers.authorization, projectTokens[p]));
    if (!admin && !project) return send(401, { error: "Authentication required" });
    try {
      if (req.method === "GET" && req.url === "/state") return send(200, await manager.status());
      if (req.method !== "POST") return send(404, { error: "Unknown operation" });
      const body = await readJson(req);
      if (req.url === "/drain") {
        if (!admin) return send(403, { error: "Operator credential required" });
        manager.draining = true;
        return send(200, { ok: true });
      }
      if (req.url === "/project-drain") {
        if (!admin) return send(403, { error: "Operator credential required" });
        if (!persistDrains) throw new Error("Persistent project drains are not configured");
        await manager.setProjectDraining(body.project, body.draining, persistDrains);
        return send(200, { ok: true, drainingProjects: manager.config.drainingProjects });
      }
      if (!project) return send(403, { error: "Project credential required" });
      if (req.url === "/offers") {
        manager.offer(project, body.session, body.offers);
        return send(200, await manager.grants(project, body.session));
      }
      if (req.url === "/withdraw") return send(200, await manager.withdraw(project, body.session));
      if (req.url === "/finish") {
        await manager.finish(project, body.session, body.id, body.completed !== false, body.unused === true);
        return send(200, { ok: true });
      }
      if (req.url === "/authorize") {
        if (typeof body.ticket !== "string" || !body.ticket.startsWith(`${project}#`) || !manager.claims.authorize) return send(403, { error: "Project mismatch" });
        return send(200, await manager.claims.authorize(body.session, body.ticket, body.runId));
      }
      return send(404, { error: "Unknown operation" });
    } catch (e) { return send(409, { error: e instanceof Error ? e.message : "Operation failed" }); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return listen(server, port, host);
}
