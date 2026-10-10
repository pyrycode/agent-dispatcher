import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { JsonClient } from "./fleet-http.js";
import type { Claim, FleetRun, FleetSnapshot, ResourceClass } from "./fleet-store.js";
import type { WorkOffer } from "./machine-scheduler.js";
import type { AgentConfig, ProjectItem } from "./types.js";

const currentRun = new AsyncLocalStorage<{ run: FleetRun; groups: Set<number> }>();
/** Called by the existing spawn sites. Slot release waits for grandchildren too. */
export function trackManagedChild(pid: number): void { currentRun.getStore()?.groups.add(pid); }
export function managedGroupAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid child process group");
  try { process.kill(-pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function resourceClasses(raw: string | undefined): Record<string, ResourceClass> {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some(v => v !== "heavy" && v !== "light")) throw new Error("PYRY_RESOURCE_CLASSES must map role names to heavy or light");
  return parsed;
}

interface Pending { offer: WorkOffer; run?: FleetRun }
export class ManagedDispatch {
  readonly session = randomUUID();
  readonly connection: JsonClient;
  readonly classes: Record<string, ResourceClass>;
  private pending = new Map<string, Pending>();
  private seen = new Set<string>();
  private running = new Set<string>();
  private state: FleetSnapshot = { claims: [], runs: [] };
  private wake: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing = false;
  private errorAt = 0;
  private readonly cooldown = new Map<string, number>();
  draining = false;

  constructor(readonly project: string, env: NodeJS.ProcessEnv) {
    if (!env.PYRY_MANAGER_URL || !env.PYRY_MANAGER_TOKEN) throw new Error("Managed dispatch requires PYRY_MANAGER_URL and PYRY_MANAGER_TOKEN");
    this.connection = new JsonClient(env.PYRY_MANAGER_URL, env.PYRY_MANAGER_TOKEN);
    this.classes = resourceClasses(env.PYRY_RESOURCE_CLASSES);
  }
  static fromEnv(env: NodeJS.ProcessEnv): ManagedDispatch | null {
    if (!env.PYRY_MANAGER_URL && !env.PYRY_MANAGER_TOKEN && env.PYRY_MANAGED !== "1") return null;
    return new ManagedDispatch(`${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, env);
  }
  async start(): Promise<void> {
    await this.sync();
    this.timer = setInterval(() => void this.sync().catch(e => {
      // A service outage authorises no new work. Existing grants stay reserved.
      if (Date.now() - this.errorAt > 60_000) { console.error("Manager unavailable:", e.message); this.errorAt = Date.now(); }
    }), 2000);
  }
  async stop(): Promise<void> {
    this.draining = true;
    if (this.timer) clearInterval(this.timer);
    while (this.syncing) await sleep(20);
    const runs = await this.connection.call<FleetRun[]>("/withdraw", { session: this.session });
    for (const run of runs) if (!this.running.has(run.id)) await this.finish(run, false);
    this.pending.clear();
  }
  beginCycle(): void { this.seen.clear(); }
  private name(ticket: string, role: string): string { return `${ticket}/${role}`; }
  offer(issue: number | string, role: string, resource: ResourceClass, locks: string[] = [], order = 0): Pending {
    const ticket = `${this.project}#${issue}`;
    const name = this.name(ticket, role);
    this.seen.add(name);
    let pending = this.pending.get(name);
    if (!pending) {
      pending = { offer: { project: this.project, ticket, role, resource, locks, key: randomUUID(), order } };
      this.pending.set(name, pending);
    }
    // Order is scheduling metadata, not part of the durable run identity.
    if (!pending.run) pending.offer.order = order;
    return pending;
  }
  agentOffer(agent: AgentConfig, item: ProjectItem, order: number): Pending {
    const pending = this.offer(item.issueNumber, agent.name, this.classes[agent.name] ?? "heavy",
      agent.serial ? [`${this.project}:role:${agent.name}`] : [], order);
    pending.offer.roleLimit = agent.serial ? 1 : agent.maxInFlight;
    return pending;
  }
  ready(pending: Pending): boolean { return !this.draining && !!pending.run && !this.running.has(pending.run.id); }
  async endCycle(): Promise<void> {
    for (const [name, pending] of this.pending) {
      if (this.seen.has(name) || (pending.run && this.running.has(pending.run.id))) continue;
      if (pending.run) await this.finish(pending.run, false); // Never started: safe to cancel.
      this.pending.delete(name);
    }
    await this.sync();
  }
  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const state = await this.connection.call<FleetSnapshot & { draining: boolean }>("/state");
      const runs = await this.connection.call<FleetRun[]>("/offers", { session: this.session, offers: [...this.pending.values()]
        .filter(p => Date.now() >= (this.cooldown.get(this.name(p.offer.ticket, p.offer.role)) ?? 0)).map(p => p.offer) });
      this.state = state;
      this.draining = state.draining || this.draining;
      let fresh = false;
      for (const p of this.pending.values()) {
        // Returned grants belong to this session. Ticket + role is unique in its offers.
        const run = runs.find(r => r.ticket === p.offer.ticket && r.role === p.offer.role);
        if (run && !p.run) fresh = true;
        p.run = run;
      }
      if (fresh) { this.wake?.(); this.wake = undefined; }
    } finally { this.syncing = false; }
  }
  anyGranted(): Promise<void> {
    return new Promise(resolve => { this.wake = resolve; });
  }
  async run<T>(pending: Pending, work: () => Promise<T>): Promise<T> {
    if (!this.ready(pending)) throw new Error("No managed run grant");
    const run = pending.run!;
    this.running.add(run.id);
    return currentRun.run({ run, groups: new Set() }, async () => {
      let completed = false;
      try {
        // Fresh authority check before starting, including after a manual release.
        const state = await this.connection.call<FleetSnapshot>("/state");
        if (!state.runs.some(r => r.id === run.id && r.session === this.session && r.generation === run.generation)) throw new Error("Run grant no longer active");
        const result = await work();
        completed = result !== false;
        return result;
      } finally {
        const groups = currentRun.getStore()!.groups;
        while ([...groups].some(managedGroupAlive)) await sleep(1000);
        // Never free a slot on an uncertain reply or on parent-process exit alone.
        while (true) {
          try { await this.finish(run, completed); break; }
          catch { await sleep(5000); }
        }
        this.running.delete(run.id);
        this.pending.delete(this.name(pending.offer.ticket, pending.offer.role));
        this.cooldown.set(this.name(pending.offer.ticket, pending.offer.role), Date.now() + 60_000);
        this.wake?.(); this.wake = undefined;
      }
    });
  }
  private async finish(run: FleetRun, completed = true): Promise<void> {
    await this.connection.call("/finish", { session: this.session, id: run.id, completed });
  }
  async authorize(issue: number): Promise<void> {
    await this.connection.call<Claim>("/authorize", { session: this.session, ticket: `${this.project}#${issue}`, runId: currentRun.getStore()?.run.id });
  }
  inFlightKeys(): Set<string> {
    return new Set(this.state.runs.filter(r => r.project === this.project).map(r => `${r.role}#${r.ticket.split("#")[1]}`));
  }
  /** Restrict all workflow writers, including cleanup, to this computer's tickets. */
  client<T extends object>(base: T, maintenance = false, onlyIssue?: number): T {
    const itemNumbers = new Map<string, number>();
    const createdNumbers = new Map<string, number>();
    const numbers = new Set(["addLabel", "removeLabel", "addComment", "closeIssue", "addBlocker"]);
    const items = new Set(["updateItemStatus", "moveItemToTop"]);
    const lists = new Set(["getAllProjectItems", "getItemsByStatus", "getClosedItemsNotInDone"]);
    return new Proxy(base, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (typeof key !== "string") return value.bind(target);
        if (!numbers.has(key) && !items.has(key) && !lists.has(key) && key !== "createIssue" && key !== "addItemToProject") return value.bind(target);
        return async (...args: any[]) => {
          if (numbers.has(key)) await this.authorize(args[0]);
          if (items.has(key)) {
            const number = itemNumbers.get(args[0]);
            if (number === undefined) throw new Error("Cannot mutate an item outside the managed snapshot");
            await this.authorize(number);
          }
          const result = await value.apply(target, args);
          if (key === "createIssue") createdNumbers.set(result.nodeId, result.number);
          if (key === "addItemToProject" && createdNumbers.has(args[0])) itemNumbers.set(result, createdNumbers.get(args[0])!);
          if (!lists.has(key)) return result;
          return (result as ProjectItem[]).filter(item => {
            itemNumbers.set(item.id, item.issueNumber);
            if (onlyIssue !== undefined && item.issueNumber !== onlyIssue) return false;
            const ticket = `${this.project}#${item.issueNumber}`;
            const claim = this.state.claims.find(c => c.ticket === ticket);
            const machine = (this.state as FleetSnapshot & { machine?: string }).machine;
            if (claim && claim.machine !== machine) return false;
            return !maintenance || !this.state.runs.some(r => r.ticket === ticket);
          });
        };
      },
    });
  }
}
