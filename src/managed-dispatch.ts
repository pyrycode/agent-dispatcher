import {startGitHubBridge} from "./github-bridge.js";
import {withGitHubActor} from "./github-transport.js";
import {workflowClient} from "./workflow-client.js";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { JsonClient } from "./fleet-http.js";
import type { Claim, FleetRun, FleetSnapshot, ResourceClass } from "./fleet-store.js";
import type { WorkOffer } from "./machine-scheduler.js";
import type { AgentConfig, ProjectItem } from "./types.js";
import { observationFor } from "./recovery-work.js";
import type { PauseRecord, EvidenceRecord, CoordinationRecord } from "./recovery-facts.js";
import type { RecoveryObservation, RecoveryIncident, RecoveryDecision } from "./fleet-recovery.js";
import type { AgentRunner } from './agent-runner.js';
import {taskBridge} from "./recovery-task-bridge.js";
import { offerId } from "./machine-manager.js";

const DEFAULT_RESOURCE_CLASSES: Readonly<Record<string, ResourceClass>> = {
  builder: "medium", developer: "medium", refiner: "light", po: "light", documentation: "light",
};
const currentRun = new AsyncLocalStorage<{ run: FleetRun; groups: Set<number>; taskSocket?: string; githubEnv?:NodeJS.ProcessEnv }>();
/** A granted run uses its saved choice even after the global setting changes. */
export function managedRunRunner(): AgentRunner | undefined { return currentRun.getStore()?.run.runnerPolicy?.runner ?? undefined; }
export function managedTaskEnv(): NodeJS.ProcessEnv {
  const socket=currentRun.getStore()?.taskSocket;
  return {...currentRun.getStore()?.githubEnv,...(socket?{PYRY_TASK_SOCKET:socket}:{})};
}
/** Native repair recipes use the same tracked-child completion rule as project workers. */
export async function withManagedTaskRun<T>(run: FleetRun, work: () => Promise<T>): Promise<T> {
  return currentRun.run({run,groups:new Set()},async()=>{
    try {return await work();}
    finally {while([...currentRun.getStore()!.groups].some(managedGroupAlive)) await sleep(1000);}
  });
}
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
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some(v => v !== "heavy" && v !== "medium" && v !== "light")) throw new Error("PYRY_RESOURCE_CLASSES must map role names to heavy, medium or light");
  return parsed;
}

interface Pending { offer: WorkOffer; run?: FleetRun; retired?: boolean }
interface CompletionRecovery { observe: () => Promise<ProjectItem | undefined>; onRecovery: (incidents: RecoveryIncident[]) => void }
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
  private readonly dispatcherRoot=fileURLToPath(new URL("..",import.meta.url));
  private readonly loadedRevision=execFileSync("git",["rev-parse","HEAD"],{cwd:this.dispatcherRoot,encoding:"utf8"}).trim();
  private readonly repairProofs=new Map<string,boolean>();
  private recoveryTickets = new Set<string>();
  draining = false;
  tasksEnabled: boolean;
  private readonly tasksDisabled: boolean;

  constructor(readonly project: string, private readonly env: NodeJS.ProcessEnv) {
    if (!env.PYRY_MANAGER_URL || !env.PYRY_MANAGER_TOKEN) throw new Error("Managed dispatch requires PYRY_MANAGER_URL and PYRY_MANAGER_TOKEN");
    this.connection = new JsonClient(env.PYRY_MANAGER_URL, env.PYRY_MANAGER_TOKEN);
    this.classes = resourceClasses(env.PYRY_RESOURCE_CLASSES);
    this.tasksEnabled = false;
    this.tasksDisabled = env.PYRY_RECOVERY_TASKS === "0";
  }
  static fromEnv(env: NodeJS.ProcessEnv): ManagedDispatch | null {
    if (!env.PYRY_MANAGER_URL && !env.PYRY_MANAGER_TOKEN && env.PYRY_MANAGED !== "1") return null;
    return new ManagedDispatch(`${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, env);
  }
  /** Read the central choice before validating local runner files at startup. */
  static async runnerFromEnv(env: NodeJS.ProcessEnv): Promise<AgentRunner | undefined> {
    const managed = ManagedDispatch.fromEnv(env);
    if (!managed) return undefined;
    const state = await managed.connection.call<FleetSnapshot>('/state');
    return state.runnerPolicy?.runner ?? undefined;
  }
  runner(): AgentRunner | undefined {
    const active = currentRun.getStore();
    return (active ? active.run.runnerPolicy : this.state.runnerPolicy)?.runner ?? undefined;
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
    for (const run of runs) if (!this.running.has(run.id)) await this.finish(run, false, true);
    this.pending.clear();
  }
  beginCycle(): void { this.seen.clear(); }
  setRecoveryTickets(items: readonly ProjectItem[]): void {
    this.recoveryTickets = new Set(items.filter(i => i.labels.includes("orchestrator:fixing"))
      .map(i => `${this.project}#${i.issueNumber}`));
    for (const p of this.pending.values()) if (!p.run && p.offer.role !== 'recovery') {
      p.offer.recovery = this.recoveryTickets.has(p.offer.ticket);
      p.offer.recoveryError = p.offer.recovery;
    }
  }
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
    const required=pending.run ? [] : this.state.requiredRepairs?.[ticket]??[];
    if(!pending.run) pending.offer.readyRepairs=required.filter(sha=>{
      if(!this.repairProofs.has(sha)) {
        try {execFileSync('git',['merge-base','--is-ancestor',sha,this.loadedRevision],{cwd:this.dispatcherRoot,stdio:'ignore'});this.repairProofs.set(sha,true);}
        catch {this.repairProofs.set(sha,false);}
      }
      return this.repairProofs.get(sha);
    });
    pending.retired = false;
    // Order is scheduling metadata, not part of the durable run identity.
    if (!pending.run) {
      pending.offer.order = order;
      if(this.state.workflowProjects?.includes(this.project))pending.offer.workflowVersion=1;
      pending.offer.recovery = this.recoveryTickets.has(ticket);
    }
    return pending;
  }
  agentOffer(agent: AgentConfig, item: ProjectItem, order: number): Pending {
    const pending = this.offer(item.issueNumber, agent.name, this.classes[agent.name] ?? DEFAULT_RESOURCE_CLASSES[agent.name] ?? "heavy",
      agent.serial ? [`${this.project}:role:${agent.name}`] : [], order);
    pending.offer.roleLimit = agent.serial ? 1 : agent.maxInFlight;
    if (!pending.run) {
      pending.offer.recovery = item.labels.includes("orchestrator:fixing");
      pending.offer.recoveryError = pending.offer.recovery;
    }
    return pending;
  }
  ready(pending: Pending): boolean { return !this.draining && !pending.retired && !!pending.run && !this.running.has(pending.run.id); }
  private offers(exclude?: Pending): WorkOffer[] {
    return [...this.pending.values()].filter(p => p !== exclude && !p.retired
      && Date.now() >= (this.cooldown.get(this.name(p.offer.ticket, p.offer.role)) ?? 0)).map(p => p.offer);
  }
  async endCycle(): Promise<void> {
    const retired = [...this.pending].filter(([name, pending]) =>
      !this.seen.has(name) && !(pending.run && this.running.has(pending.run.id)));
    if (retired.length) {
      for (const [, pending] of retired) pending.retired = true;
      // Replace the queue in one operation. Surviving offers stay visible.
      // Wait for uncertain admissions before cancelling only retired grants.
      while (this.syncing) await sleep(20);
      this.syncing = true;
      try {
        const runs = await this.connection.call<FleetRun[]>('/replace', { session: this.session, offers: this.offers() });
        for (const [name, pending] of retired) {
          const run = runs.find(r => r.id === offerId(r.machine, this.session, pending.offer));
          if (run && !this.running.has(run.id)) await this.finish(run, false, true); // Never started: safe to cancel.
          this.pending.delete(name);
        }
      } finally { this.syncing = false; }
    }
    await this.sync();
  }
  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const state = await this.connection.call<FleetSnapshot & { machine: string; draining: boolean }>("/state");
      const runs = await this.connection.call<FleetRun[]>("/offers", { session: this.session, offers: this.offers() });
      this.state = state;
      this.tasksEnabled = !this.tasksDisabled && state.features?.recoveryTasks === true;
      this.draining = state.draining || this.draining;
      let fresh = false;
      for (const p of this.pending.values()) {
        // Exact identity matters when a stage is withdrawn and offered again
        // while a previous admission request is still in flight.
        const run = runs.find(r => r.id === offerId(state.machine, this.session, p.offer));
        if (run && !p.run) fresh = true;
        p.run = run;
      }
      for (const run of state.runs) {
        if (run.machine !== state.machine || run.project !== this.project || run.session !== this.session || this.running.has(run.id)) continue;
        const pending = this.pending.get(this.name(run.ticket, run.role));
        if (pending && !pending.retired && offerId(state.machine, this.session, pending.offer) === run.id) continue;
        // Admission may have committed after an ungranted offer disappeared.
        // Only this live session knows this run never entered run(), whose
        // running entry lasts through child exit and finish acknowledgement.
        // Old sessions and uncertain/running children are never inferred dead.
        await this.finish(run, false, true);
      }
      if (fresh) { this.wake?.(); this.wake = undefined; }
    } finally { this.syncing = false; }
  }
  anyGranted(): Promise<void> {
    return new Promise(resolve => { this.wake = resolve; });
  }
  async run<T>(pending: Pending, work: () => Promise<T>, recovery?: CompletionRecovery): Promise<T> {
    if (!this.ready(pending)) throw new Error("No managed run grant");
    const run = pending.run!;
    this.running.add(run.id);
    return withGitHubActor({session:this.session,runId:run.id},()=>currentRun.run({ run, groups: new Set() }, async () => {
      let completed = false;
      let ghBridge:Awaited<ReturnType<typeof startGitHubBridge>>;
      let bridge:Awaited<ReturnType<typeof taskBridge>>|undefined;
      try {
        if(this.state.workflowProjects?.includes(this.project)) {
          if(this.env.PYRY_SHARED_GITHUB!=='1')throw new Error('Authoritative workflow requires the shared GitHub bridge');
          const ghEnv={...this.env};
          ghBridge=await startGitHubBridge(ghEnv,{session:this.session,runId:run.id});
          if(ghBridge)currentRun.getStore()!.githubEnv={GH_CONFIG_DIR:ghEnv.GH_CONFIG_DIR};
        }
        bridge=this.tasksEnabled && /#[1-9]\d*$/.test(run.ticket) && ['builder','developer'].includes(run.role) ? await taskBridge(this.connection,run) : undefined;
        if(bridge)currentRun.getStore()!.taskSocket=bridge.socket;
        // Fresh authority check before starting, including after a manual release.
        const state = await this.connection.call<FleetSnapshot>("/state");
        if (!state.runs.some(r => r.id === run.id && r.session === this.session && r.generation === run.generation)) throw new Error("Run grant no longer active");
        const result = await work();
        completed = result !== false;
        return result;
      } finally {
        if (bridge) await bridge.close();
        const groups = currentRun.getStore()!.groups;
        while ([...groups].some(managedGroupAlive)) await sleep(1000);
        if (recovery) {
          // Keep the slot until fresh failure evidence and its successor offer
          // are recorded. The authority commits the incident with slot release.
          while (this.syncing) await sleep(20);
          this.syncing = true;
          try {
            let prepared = false, observation: RecoveryObservation | undefined, successor: Pending | undefined;
            while (true) {
              try {
                if (!prepared) {
                  const item = await recovery.observe();
                  observation = item ? observationFor(this.project, item) : undefined;
                  // Only the authority has the durable pause origin and latest
                  // recovery facts. Publish a possibility; its incident check
                  // prevents healthy completions and operator holds launching.
                  if (item) {
                    successor = this.offer(item.issueNumber, 'recovery', 'heavy', [], -4);
                    successor.offer.roleLimit = 1;
                    successor.offer.requiresRecovery = true;
                    successor.offer.recoveryError = item.labels.some(l => l.startsWith('error:') && l !== 'error:family-breaker');
                  }
                  prepared = true;
                }
                await this.connection.call('/offers', { session: this.session, offers: this.offers(pending) });
                const result = await this.connection.call<{ incidents?: RecoveryIncident[] }>('/finish', { session: this.session, id: run.id, completed, observation });
                const incidents = result.incidents ?? [];
                if (successor && !incidents.some(i => i.state === 'queued' && i.current !== false)) {
                  successor.retired = true;
                }
                recovery.onRecovery(incidents);
                break;
              } catch (error) {
                console.error('Completion handoff pending:', error instanceof Error ? error.message : error);
                await sleep(5000);
              }
            }
          } finally { this.syncing = false; }
        } else {
          // Never free a slot on an uncertain reply or on parent-process exit alone.
          while (true) {
            try { await this.finish(run, completed); break; }
            catch { await sleep(5000); }
          }
        }
        ghBridge?.kill();
        this.running.delete(run.id);
        this.pending.delete(this.name(pending.offer.ticket, pending.offer.role));
        this.cooldown.set(this.name(pending.offer.ticket, pending.offer.role), Date.now() + 60_000);
        this.wake?.(); this.wake = undefined;
      }
    }));
  }
  private async finish(run: FleetRun, completed = true, unused = false): Promise<void> {
    await this.connection.call("/finish", { session: this.session, id: run.id, completed, unused });
  }
  async authorize(issue: number): Promise<void> {
    await this.connection.call<Claim>("/authorize", { session: this.session, ticket: `${this.project}#${issue}`, runId: currentRun.getStore()?.run.id });
  }
  /**
   * Ownership for a PR comment, checked against the PR's ticket. The body
   * goes to GitHub, not the store, so this repeats the store's own check for
   * a ticket comment: a finished run or lost ownership is refused. With no
   * admitted run, as in the pending-verdict sweep, the machine's claim on
   * the ticket decides, exactly as for its labels.
   */
  async authorizeWorkflow(issue: number): Promise<void> {
    await this.connection.call("/workflow/authorize", { project: this.project, session: this.session, ticket: `${this.project}#${issue}`, runId: currentRun.getStore()?.run.id });
  }
  async recoveryFacts(tickets: string[]) {
    const run=currentRun.getStore()?.run;
    return this.connection.call<Array<{ ticket: string; pause?: PauseRecord; artifactRevision?: string; evidence: EvidenceRecord[]; coordination: CoordinationRecord[] }>>("/recovery/facts", {
      tickets,...(run?.role==='recovery'?{project:this.project,session:run.session,runId:run.id}:{}),
    });
  }
  async hydrateRecovery(item: ProjectItem): Promise<ProjectItem> {
    const [facts] = await this.recoveryFacts([`${this.project}#${item.issueNumber}`]);
    return { ...item, recoveryPause: facts.pause, artifactRevision: facts.artifactRevision };
  }
  recordEvidence(records: EvidenceRecord[]) { return this.connection.call("/recovery/evidence", { records }); }
  async recoveryReport(items: ProjectItem[]): Promise<RecoveryIncident[]> {
    const observations: RecoveryObservation[] = items.map(i => observationFor(this.project, i));
    return this.connection.call("/recovery/report", { observations });
  }
  recoveryStep<T>(step: "begin" | "decide" | "complete", id: string, decision?: RecoveryDecision): Promise<T> {
    const run = currentRun.getStore()?.run;
    if (!run || run.role !== "recovery") throw new Error("Recovery needs an admitted run");
    return this.connection.call(`/recovery/${step}`, { id, session: this.session, runId: run.id, decision });
  }
  inFlightKeys(): Set<string> {
    return new Set(this.state.runs.filter(r => r.project === this.project).map(r => `${r.role}#${r.ticket.split("#")[1]}`));
  }
  authorityClient<T extends object>(base:T):T {
    return workflowClient(base,this.connection,this.project,()=>this.state.workflowProjects?.includes(this.project)===true,()=>({session:this.session,runId:currentRun.getStore()?.run.id}));
  }
  /** Restrict all workflow writers, including cleanup, to this computer's tickets. */
  client<T extends object>(base: T, maintenance = false, onlyIssue?: number): T {
    base = this.authorityClient(base);
    const itemNumbers = new Map<string, number>();
    const createdNumbers = new Map<string, number>();
    const numbers = new Set(["addLabel", "removeLabel", "addComment", "closeIssue", "addBlocker", "removeBlocker"]);
    const items = new Set(["updateItemStatus", "moveItemToTop"]);
    const lists = new Set(["getAllProjectItems", "getOpenProjectItems", "getItemsByStatus", "getClosedItemsNotInDone"]);
    return new Proxy(base, {
      get: (target, key) => {
        if (key === "recordCoordination") return async (record: CoordinationRecord) => {
          const run = currentRun.getStore()?.run;
          if (!run || !record.ticket.startsWith(`${this.project}#`)) throw new Error("Coordination requires an admitted planning run");
          await this.connection.call("/recovery/coordination", { session: this.session, runId: run.id, record });
        };
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (typeof key !== "string") return value.bind(target);
        if (!numbers.has(key) && !items.has(key) && !lists.has(key) && key !== "createIssue" && key !== "addItemToProject" && key !== "addPullRequestComment") return value.bind(target);
        return async (...args: any[]) => {
          if (numbers.has(key)) await this.authorize(args[0]);
          if (key === "addPullRequestComment") await this.authorizeWorkflow(args[0]);
          if (items.has(key)) {
            const number = itemNumbers.get(args[0]);
            if (number === undefined) throw new Error("Cannot mutate an item outside the managed snapshot");
            await this.authorize(number);
            if (key === "updateItemStatus" && args[1] === "Halted") {
              const run = currentRun.getStore()?.run;
              if (!run) throw new Error("Pipeline pause requires an admitted run");
              const previous = await (target as any).getItemStatus(number, { forceRefresh: true });
              await this.connection.call("/recovery/pause", { session: this.session, runId: run.id, record: {
                ticket: `${this.project}#${number}`, origin: "pipeline", actor: run.role,
                reason: "Pipeline requested a pause", missing: "Read the stage outcome and newest evidence",
                resumeOn: "Assessment confirms the missing prerequisite is satisfied", resumeStatus: previous,
                revision: run.generation } });
            }
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
