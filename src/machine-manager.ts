import type {RecoveryTask} from "./recovery-tasks.js";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { listen, readJson, tokenMatches, ownershipRefusal, ServiceError, type FleetClient } from "./fleet-http.js";
import { effectiveWork, desiredRun, stricter, validateDocument, workRefusal, MACHINE_SCOPE, type DesiredDocument, type DesiredPoll, type WorkState } from "./desired-state.js";
import { validateStart, validateLimits, type MachineLimits, type FleetRun } from "./fleet-store.js";
import { scheduleMachine, workEligibility, runnableTickets, codexPaused, codexSpaced, isNewTicket, reviewQueue, effectiveReviewQueueLimit, lackingCapabilities, type WorkOffer } from "./machine-scheduler.js";
import { validateCapabilityReport } from "./ticket-requirements.js";
import { diskAdmission, validateDiskAdmission, availableDiskBytes, type DiskAdmissionConfig, type DiskSpaceProbe } from './disk-admission.js';

/**
 * An operator drain or resume, kept so a supervisor can tell it from an
 * unexplained policy change. `source: "central"` marks one the manager
 * applied from the claim service's desired state.
 */
export interface ProjectDrainChange { project: string; draining: boolean; at: number; source?: "central" }
/** The last desired state document a manager applied, saved in its configuration. */
export interface CachedDesiredState { document: DesiredDocument; fetchedAt: number }
/**
 * Central desired state for a production manager. Without it the manager
 * keeps its older local behaviour, which library users and tests rely on.
 */
export interface DesiredStateOptions {
  /** From the manager's configuration. Absent until the first document was applied. */
  cached?: CachedDesiredState;
  /** Saves the document with the drain policy it implies, atomically. Throws on failure. */
  persist: (update: { desiredState: CachedDesiredState; drainingProjects: string[]; projectDrainChanges: ProjectDrainChange[] }) => void;
}
/**
 * - central: applied a document fetched from the claim service.
 * - cached: applying the saved document; the claim service has not answered since start.
 * - unknown: no saved document and no answer yet. Nothing is granted.
 * - unsupported: the claim service predates desired state; the older local drains apply.
 */
export type DesiredMode = "central" | "cached" | "unknown" | "unsupported";
export interface MachineConfig extends MachineLimits { machine: string; projects: string[]; drainingProjects?: string[]; projectDrainChanges?: ProjectDrainChange[]; ticketLimit?: number;
  /** Automatic start floor. Never changes desired state, holds or existing grants. */
  diskAdmission?:DiskAdmissionConfig;
  /** New tickets wait while this many owned tickets wait for review. Absent: heavyLimit. 0: no hold. */
  reviewQueueLimit?: number; controlRevision?: string;
  /**
   * Everything this computer advertises to tickets with a `requires:` label:
   * its operating system and configured hardware (machineCapabilities in
   * ticket-requirements.ts). Reported to the claim service, which enforces
   * it. Absent: nothing, so only tickets without a requirement run here.
   */
  capabilities?: string[] }
type ClaimService = Pick<FleetClient, "snapshot" | "start" | "finish"> & Partial<Pick<FleetClient, "authorize" | "github" | "call">>;
interface Offers { session: string; work: WorkOffer[]; at: number }
// These stages can compile or test even if an older dispatcher labels them
// light. Native support's sole light recipe is the fixed platform probe.
function needsStorage(offer:WorkOffer):boolean {
  return offer.resource!=='light'||['builder','developer','verifier','qa','code-review'].includes(offer.role);
}
export function offerId(machine: string, session: string, offer: WorkOffer): string {
  return createHash("sha256").update(JSON.stringify([machine, session, offer.project, offer.key])).digest("hex");
}

export class MachineManager {
  private supportOffers:Offers|undefined;
  private readonly offers = new Map<string, Offers>();
  private tickPromise: Promise<void> | undefined;
  private readonly finished = new Set<string>();
  draining = false;
  /** A fresh manager has heard from no dispatcher yet. Supervisors read this as a reporting gap, not a health failure. */
  readonly startedAt: number;
  private desiredMode: DesiredMode | undefined;
  private desiredDoc: DesiredDocument | undefined;
  private desiredFetchedAt: number | undefined;
  private desiredError: string | undefined;
  private appliedRevision: number | null = null;
  private applyError: { revision: number; reason: string } | undefined;
  /**
   * Saved project drains the central document does not hold yet: all of them
   * on a manager's first start with desired state, or ones an older manager
   * wrote after a rollback. Sent until the claim service has answered once.
   */
  private pendingImports: Set<string>;
  /** The same drains, still applied here until a document that holds them is saved. */
  private localFloor: Set<string>;
  private refreshing: Promise<void> | undefined;
  constructor(readonly config: MachineConfig, readonly claims: ClaimService, private readonly now = Date.now, private readonly desired?: DesiredStateOptions, private readonly diskProbe:DiskSpaceProbe=availableDiskBytes) {
    this.startedAt = now();
    if (desired) {
      if (!claims.call) throw new Error("Desired state requires the claim service");
      if (desired.cached) {
        this.desiredDoc = validateDocument(desired.cached.document, config.machine);
        this.desiredFetchedAt = desired.cached.fetchedAt;
        this.appliedRevision = this.desiredDoc.revision;
        this.desiredMode = "cached";
      } else this.desiredMode = "unknown";
    }
    const saved = (config.drainingProjects ?? []).filter(p => config.projects.includes(p));
    this.pendingImports = new Set(desired ? saved.filter(p => !this.desiredDoc || effectiveWork(this.desiredDoc.entries, p) === "taking") : []);
    this.localFloor = new Set(this.pendingImports);
    validateLimits(config);
    validateDiskAdmission(config.diskAdmission);
    if (config.ticketLimit !== undefined && (!Number.isSafeInteger(config.ticketLimit) || config.ticketLimit < 1)) throw new Error("Invalid ticket limit");
    if (config.reviewQueueLimit !== undefined && (!Number.isSafeInteger(config.reviewQueueLimit) || config.reviewQueueLimit < 0)) throw new Error("Invalid review queue limit");
    if (!config.machine || new Set(config.projects).size !== config.projects.length) throw new Error("Invalid machine configuration");
    if (config.projectHeavyLimits !== undefined && Object.keys(config.projectHeavyLimits).some(p => !config.projects.includes(p))) throw new Error("projectHeavyLimits names a project this manager does not serve");
    if (config.capabilities !== undefined) config.capabilities = validateCapabilityReport(config.capabilities);
    if (config.drainingProjects !== undefined && (!Array.isArray(config.drainingProjects) || config.drainingProjects.some(p => !config.projects.includes(p)))) throw new Error("Invalid project drain configuration");
  }
  async setProjectDraining(project: string, draining: boolean, persist: (projects: string[], changes: ProjectDrainChange[]) => void): Promise<void> {
    if (!this.config.projects.includes(project) || typeof draining !== "boolean") throw new Error("Invalid project drain request");
    const projects = new Set(this.config.drainingProjects ?? []);
    if (draining) projects.add(project); else projects.delete(project);
    const next = [...projects];
    const changes = [...(this.config.projectDrainChanges ?? []), { project, draining, at: this.now() }].slice(-50);
    // Save before acknowledging or changing admission. A failed save leaves
    // the previous policy intact. Both operations are synchronous.
    persist(next, changes);
    this.config.drainingProjects = next;
    this.config.projectDrainChanges = changes;
    // Made while the claim service predates desired state: imported once it supports it.
    if (this.desired) {
      if (draining) { this.pendingImports.add(project); this.localFloor.add(project); }
      else { this.pendingImports.delete(project); this.localFloor.delete(project); }
    }
    // A start already sent to the authority can still commit. Wait for it
    // before acknowledging the drain; subsequent jobs check the new policy.
    try { await this.tickPromise; } catch { /* a lost reply remains reserved */ }
  }
  /**
   * The work state this manager applies to one board. Without central
   * desired state, or while the claim service predates it, the saved local
   * project drains apply. With no saved document and no answer yet, nothing
   * is granted.
   */
  work(project: string): WorkState {
    const local: WorkState = this.config.drainingProjects?.includes(project) ? "tickets-drained" : "taking";
    if (!this.desired || this.desiredMode === "unsupported") return local;
    if (this.desiredMode === "unknown" || !this.desiredDoc) return "drained";
    return stricter(effectiveWork(this.desiredDoc.entries, project), this.localFloor.has(project) ? "tickets-drained" : undefined);
  }
  /** Local project drain commands apply only without central desired state. */
  localDrainsAllowed(): boolean { return !this.desired || this.desiredMode === "unsupported"; }
  /**
   * Boards reported as draining, for the supervisor's policy comparison.
   * Before the first document is known nothing is granted, but the saved
   * list is reported, so a brief start-up gap is not a policy change.
   */
  reportedDraining(): string[] {
    if (this.desired && this.desiredMode === "unknown") return (this.config.drainingProjects ?? []).filter(p => this.config.projects.includes(p));
    return this.config.projects.filter(p => this.work(p) !== "taking");
  }
  /** Whether the manager may grant at all. False only before the first desired state is known. */
  desiredKnown(): boolean { return this.desiredMode !== "unknown"; }
  /** The queue state an offer is held in by drains and stops, or undefined. */
  private held(offer: WorkOffer, state: { claims: Array<{ ticket: string; machine: string }> }): "desired-state-unknown" | "drained" | "project-draining" | undefined {
    if (!this.desiredKnown()) return "desired-state-unknown";
    const refusal = workRefusal(project => this.config.projects.includes(project) ? this.work(project) : "taking", offer,
      state.claims.some(c => c.ticket === offer.ticket && c.machine === this.config.machine));
    return refusal === "drained" ? "drained" : refusal === "tickets-drained" ? "project-draining" : undefined;
  }
  /**
   * Fetch this computer's desired state through the outbound claim service
   * connection, save it, then apply it. The fetch carries what was applied
   * last, which is the acknowledgement. A failed fetch keeps what applies
   * now: the saved document, or nothing granted when there is none.
   */
  refreshDesired(): Promise<void> {
    if (!this.desired) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const work = this.refreshOnce().finally(() => { this.refreshing = undefined; });
    this.refreshing = work;
    return work;
  }
  private poll(): DesiredPoll {
    return { projects: this.config.projects, appliedRevision: this.appliedRevision, ...(this.applyError ? { applyError: this.applyError } : {}),
      ...(this.pendingImports.size ? { localDrains: [...this.pendingImports] } : {}),
      ...(this.desiredDoc ? { savedEntries: this.desiredDoc.entries.filter(e => e.project === MACHINE_SCOPE || this.config.projects.includes(e.project)).map(e => ({ project: e.project, ...(e.work ? { work: e.work } : {}), ...(e.run ? { run: e.run } : {}) })) } : {}) };
  }
  private async refreshOnce(): Promise<void> {
    let doc: DesiredDocument;
    try { doc = validateDocument(await this.claims.call!<DesiredDocument>("/machines/desired", this.poll()), this.config.machine); }
    catch (error) {
      // A claim service from before this change answers that it has no such
      // route. It enforces nothing, so the older local drains apply. Any other
      // failure keeps what applies now.
      if (error instanceof ServiceError && error.status === 404 && this.desiredMode === "unknown") this.desiredMode = "unsupported";
      this.desiredError = String((error as Error).message).slice(0, 300);
      return;
    }
    this.desiredError = undefined;
    // The claim service has imported them now; sending them again would undo
    // an operator's later resume. They stay applied until a document is saved.
    this.pendingImports.clear();
    if (this.appliedRevision !== null && doc.revision < this.appliedRevision) {
      // A restored or replaced claims database. Its older document could lift
      // drains this computer holds, so the saved one stays until the operator
      // changes anything for this computer, which moves the revision past it.
      this.applyError = { revision: this.appliedRevision, reason: `Central desired state is at revision ${doc.revision}, behind the applied ${this.appliedRevision}, as after a claims database restore. Keeping the saved state until an operator change for this computer.` };
      return;
    }
    const changed = this.desiredMode !== "central" || doc.revision !== this.appliedRevision || this.applyError !== undefined || this.localFloor.size > 0;
    if (!changed) { this.desiredFetchedAt = this.now(); return; }
    const before = this.reportedDraining();
    const draining = this.config.projects.filter(p => effectiveWork(doc.entries, p) !== "taking");
    const at = this.now();
    // A supervisor accepts a drain policy difference that a recorded change explains.
    const flips = this.config.projects.filter(p => before.includes(p) !== draining.includes(p))
      .map(project => ({ project, draining: draining.includes(project), at, source: "central" as const }));
    const changes = [...(this.config.projectDrainChanges ?? []), ...flips].slice(-50);
    try { this.desired!.persist({ desiredState: { document: doc, fetchedAt: at }, drainingProjects: draining, projectDrainChanges: changes }); }
    catch (error) {
      // Not saved, so not applied: a restart would not keep it. The claim
      // service still refuses new grants to drained boards meanwhile.
      this.applyError = { revision: doc.revision, reason: `Could not save desired state: ${String((error as Error).message).slice(0, 200)}` };
      return;
    }
    this.desiredDoc = doc;
    this.desiredMode = "central";
    this.desiredFetchedAt = at;
    this.config.drainingProjects = draining;
    this.config.projectDrainChanges = changes;
    this.localFloor.clear();
    // A start already sent to the claim service can still commit. Wait for
    // it before acknowledging; later admissions use the new state.
    try { await this.tickPromise; } catch { /* a lost reply remains reserved */ }
    this.appliedRevision = doc.revision;
    this.applyError = undefined;
    // Acknowledge now rather than at the next fetch. The next fetch repeats it.
    try { await this.claims.call!("/machines/desired", this.poll()); } catch { /* sent again with the next fetch */ }
  }
  /** What the supervisor and operator see of desired state. */
  desiredStatus() {
    if (!this.desired) return undefined;
    const entries = this.desiredDoc?.entries ?? [];
    return { mode: this.desiredMode, known: this.desiredKnown(), revision: this.desiredDoc?.revision ?? null, appliedRevision: this.appliedRevision,
      fetchedAt: this.desiredFetchedAt ?? null, ...(this.desiredError ? { lastError: this.desiredError } : {}), ...(this.applyError ? { applyError: this.applyError } : {}),
      machine: { work: entries.find(e => e.project === MACHINE_SCOPE)?.work ?? "taking" },
      projects: Object.fromEntries(this.config.projects.map(p => [p, { work: entries.find(e => e.project === p)?.work ?? null, run: desiredRun(entries, p) ?? null, effectiveWork: this.work(p) }])) };
  }
  offer(project: string, session: string, work: WorkOffer[]): void {
    if (!this.config.projects.includes(project) || !session || session.length > 200 || !Array.isArray(work) || work.length > 5000) throw new Error("Invalid offers");
    if(work.some(w=>w.supportTaskId!==undefined||w.role==="recovery-task")) throw new Error("Support tasks use the operator lane");
    const keys = new Set<string>();
    for (const item of work) {
      if (item.project !== project || typeof item.key !== "string" || !item.key || item.key.length > 200 || keys.has(item.key) || !Number.isFinite(item.order)) throw new Error("Invalid offer");
      keys.add(item.key);
      if (item.recovery !== undefined && typeof item.recovery !== "boolean") throw new Error("Invalid recovery priority");
      if (item.recoveryError !== undefined && typeof item.recoveryError !== 'boolean') throw new Error('Invalid error priority');
      validateStart({ ...item, id: offerId(this.config.machine, session, item), machine: this.config.machine, session });
    }
    const old = this.offers.get(project);
    if (old && old.session !== session && this.now() - old.at < 180_000) throw new Error("Another dispatcher session is registered; drain it first");
    this.offers.set(project, { session, work: structuredClone(work), at: this.now() });
  }
  /**
   * Tell the claim service what this computer offers tickets. The service
   * admits a ticket with a requirement only on a computer whose report
   * covers it, and lists requirements no fresh report covers. An older
   * service without the route refuses; the caller logs and retries.
   */
  async reportCapabilities(): Promise<void> {
    if (!this.claims.call) throw new Error("Capability reports require the claim service");
    await this.claims.call("/machines/capabilities", { capabilities: this.config.capabilities ?? [], projects: this.config.projects });
  }
  tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    if (this.draining || !this.desiredKnown()) return Promise.resolve();
    const promise = this.tickOnce().finally(() => { this.tickPromise = undefined; });
    this.tickPromise = promise;
    return promise;
  }
  private async tickOnce(): Promise<void> {
    const attempted = new Set<string>();
    while (!this.draining && this.desiredKnown()) {
      const state = await this.claims.snapshot();
      if (this.draining) break;
      const fresh = [...this.offers.values(),...(this.supportOffers?[this.supportOffers]:[])].filter(o => this.now() - o.at < 180_000).flatMap(o => o.work);
      // Reviews tried this tick still count for the review queue; finished ones do not.
      const unfinished = fresh.filter(o => !this.finished.has(`${o.project}/${o.key}`));
      const offers = unfinished.filter(o => !attempted.has(`${o.project}/${o.key}`));
      const job = scheduleMachine({ ...this.config, ...this.schedulingDrains(), offers, reviewOffers: unfinished, state })[0];
      if (!job) break;
      attempted.add(`${job.project}/${job.key}`);
      if (this.held(job, state)) continue;
      const current=job.supportTaskId?this.supportOffers:this.offers.get(job.project);
      if (!current || !current.work.some(w => w.key === job.key) || this.now() - current.at >= 180_000) continue;
      // Probe for each prospective grant. Do not reserve first or reuse one
      // free-space snapshot across several simultaneous heavy starts.
      if(needsStorage(job) && !(await diskAdmission(this.config.diskAdmission,this.diskProbe)).allowed)continue;
      // Desired state or offers can change while the filesystem probe waits.
      if(this.draining || this.held(job,state) || (job.supportTaskId?this.supportOffers:this.offers.get(job.project))!==current
        || !current.work.some(w=>w.key===job.key) || this.now()-current.at>=180_000)continue;
      // A lost reply leaves a durable reservation. grants() recovers that exact
      // run from the server; it never guesses that a timed-out start failed.
      const { key: _key, order: _order, recovery: _recovery, recoveryError: _error, ...request } = job;
      const result = await this.claims.start({ ...request, id: offerId(this.config.machine, current.session, job), machine: this.config.machine, session: current.session });
      if (!result.ok && result.reason === "finished") this.finished.add(`${job.project}/${job.key}`);
    }
  }
  /** The drain lists the scheduler filters by, from the work state of each board. */
  private schedulingDrains(): { drainingProjects: string[]; drainedProjects: string[] } {
    const works = this.config.projects.map(p => [p, this.work(p)] as const);
    return { drainingProjects: works.filter(([, w]) => w !== "taking").map(([p]) => p), drainedProjects: works.filter(([, w]) => w === "drained").map(([p]) => p) };
  }
  async support(session:string):Promise<Array<{task:RecoveryTask;run:FleetRun}>> {
    if(!this.claims.call||!session||session.length>200) throw new Error('Support scheduling requires a configured operator');
    const tasks=await this.claims.call<RecoveryTask[]>('/tasks/queue',{});
    const fallback=this.config.projects.includes('pyrycode/pyrycode')?'pyrycode/pyrycode':this.config.projects[0];
    this.supportOffers={session,at:this.now(),work:tasks.map(task=>{
      const source=task.ticket.split('#')[0],project=this.config.projects.includes(source)?source:fallback;
      return {project,ticket:`${project}#@task-${task.id}`,role:'recovery-task',resource:task.request.recipe==='platform-probe'?'light':'heavy',locks:[],key:task.id,order:-5,recovery:true,recoveryError:true,supportTaskId:task.id,parentTicket:task.ticket};
    })};
    await this.tick();
    const state=await this.claims.snapshot();
    const active=state.runs.filter(r=>r.machine===this.config.machine&&r.session===session&&r.supportTaskId);
    const current=await this.claims.call<RecoveryTask[]>('/tasks/active',{session});
    return active.flatMap(run=>{const task=current.find(t=>t.id===run.supportTaskId);return task?[{task,run}]:[];});
  }
  async replace(project: string, session: string, work: WorkOffer[]): Promise<FleetRun[]> {
    // Survivors remain published while an already-sent admission settles.
    this.offer(project, session, work);
    try { await this.tickPromise; } catch { /* snapshot recovers uncertain starts */ }
    return (await this.claims.snapshot()).runs.filter(r => r.machine === this.config.machine && r.project === project && r.session === session);
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
  /** Readiness is checked before Git preflight and again immediately before admission. */
  async verifierHandoffPreflight(project:string,session:string,id:string) {
    if(!this.claims.call || this.draining || !this.desiredKnown())throw new Error('Manager cannot confirm handoff');
    const state=await this.claims.snapshot();
    const h=state.verifierHandoffs?.find(r=>r.commandId===id && r.ticket.startsWith(project+'#'));
    if(!h)throw new Error('No pending handoff for project');
    const current=this.offers.get(project);
    if(!current || current.session!==session || this.now()-current.at>=180_000)throw new Error('No fresh dispatcher offers');
    const verifier=current.work.find(o=>o.ticket===h.ticket && o.role==='verifier');
    if(!verifier)throw new Error('Dispatcher is not offering this verifier');
    if(this.config.machine===h.source)return {h};
    if(this.config.machine!==h.target)throw new Error('Wrong handoff target');
    // Target is a new owner. Apply ticket/review limits and every local drain before moving anything.
    const hypothetical={...state,claims:state.claims.filter(c=>c.ticket!==h.ticket)};
    const ready=()=>{
      if(this.draining||!this.desiredKnown()||this.offers.get(project)!==current||this.now()-current.at>=180_000||!current.work.includes(verifier))throw new Error('Handoff target held after dispatcher or manager state changed');
      const available=[...this.offers.values()].filter(o=>this.now()-o.at<180_000).flatMap(o=>o.work).filter(o=>!this.finished.has(`${o.project}/${o.key}`));
      if(!scheduleMachine({...this.config,...this.schedulingDrains(),offers:available,state:hypothetical}).some(o=>o.key===verifier.key))throw new Error('Handoff target held by manager scheduling controls');
    };
    ready();
    if(needsStorage(verifier) && !(await diskAdmission(this.config.diskAdmission,this.diskProbe)).allowed)throw new Error('Handoff target waiting-storage: new heavy work requires available disk space');
    ready();
    const {key:_key,order:_order,recovery:_recovery,recoveryError:_error,...request}=verifier;
    return {h,target:{...request,id:offerId(this.config.machine,session,verifier),machine:this.config.machine,session}};
  }
  async confirmVerifierHandoff(project:string,session:string,id:string):Promise<unknown> {
    const prepared=await this.verifierHandoffPreflight(project,session,id);
    return this.claims.call!('/verification-handoff/confirm',{id,session,...(prepared.target?{target:prepared.target}:{})});
  }
  async status() {
    const state = await this.claims.snapshot();
    const available = [...this.offers.values(),...(this.supportOffers?[this.supportOffers]:[])].filter(o => this.now() - o.at < 180_000).flatMap(o => o.work);
    const runnableOffers = available.filter(o => !this.finished.has(`${o.project}/${o.key}`));
    const storage=await diskAdmission(this.config.diskAdmission,this.diskProbe);
    const eligible = new Set((this.desiredKnown() ? scheduleMachine({ ...this.config, ...this.schedulingDrains(), offers: runnableOffers.filter(o=>storage.allowed||!needsStorage(o)), reviewOffers:runnableOffers, state }) : []).map(o => `${o.project}/${o.key}`));
    const desired = this.desiredStatus();
    const reviewLimit = effectiveReviewQueueLimit(this.config);
    const waitingReview = reviewQueue(this.config.machine, state, runnableOffers, { ...this.config, ...this.schedulingDrains() });
    const reviewFull = reviewLimit > 0 && waitingReview !== undefined && waitingReview.length >= reviewLimit;
    return { ...(this.config.controlRevision?{controlRevision:this.config.controlRevision}:{}), ...(this.config.diskAdmission?{diskAdmission:storage}:{}), managerStartedAt: this.startedAt, machine: this.config.machine, heavyLimit: this.config.heavyLimit, combinedLimit: this.config.combinedLimit, ...(this.config.projectHeavyLimits ? { projectHeavyLimits: this.config.projectHeavyLimits } : {}), ticketLimit: this.config.ticketLimit ?? null,
      // tickets is null when the claim service predates the report; nothing is held then.
      reviewQueue: { limit: reviewLimit, tickets: waitingReview ?? null, full: reviewFull }, capabilities: this.config.capabilities ?? [], runnableTicketCount: runnableTickets(this.config.machine, runnableOffers, state).size, draining: this.draining,
      // Every board that is not taking work, so a supervisor sees a central drain as a policy change it can explain.
      drainingProjects: this.reportedDraining(), projectDrainChanges: this.config.projectDrainChanges ?? [], ...(desired ? { desiredState: desired } : {}), ...state,
      projects: this.config.projects.map(project => ({ project, draining: this.work(project) !== "taking", work: this.work(project), ...(desired ? { desiredRun: desired.projects[project].run } : {}), lastSeen: this.offers.get(project)?.at ?? null, health: !this.offers.has(project) ? "not-registered" : this.now() - this.offers.get(project)!.at >= 180_000 ? "dispatcher-unreachable" : "reporting" })),
      attention: state.runs.filter(r => r.machine === this.config.machine && this.now() - r.created >= 3 * 3600000)
        .map(r => ({ ticket: r.ticket, runId: r.id, reason: "Reservation older than three hours; verify worker progress before intervening" })),
      queue: available.map(o => ({ ticket: o.ticket, role: o.role, resource: o.resource, ...(o.parentTicket ? { parentTicket: o.parentTicket } : {}),
        state: this.finished.has(`${o.project}/${o.key}`) ? "already-completed"
          : state.runs.some(r => r.ticket === o.ticket) ? "reserved-or-running"
          : this.draining ? "draining"
          : state.claims.some(c => c.ticket === o.ticket && c.machine !== this.config.machine) ? "owned-elsewhere"
          // A central drain or stop, a saved project drain, or no desired state yet.
          : this.held(o, state) ? this.held(o, state)!
          // No computer that reported recently can run it, or only another one can.
          : lackingCapabilities(o, state, this.config.capabilities).length
            ? (state.noCapableMachine?.some(g => g.ticket === o.ticket) ? "no-capable-machine" : "missing-capability")
          : workEligibility(o, state, { ...this.config, ...this.schedulingDrains() }) ? workEligibility(o, state, { ...this.config, ...this.schedulingDrains() })!
          : needsStorage(o) && !storage.allowed ? 'waiting-storage'
          : codexPaused(o, state) ? "codex-paused"
          : codexSpaced(o, state) ? "codex-spaced"
          // A verifier selected in the same pass can shorten the queue, so an offer it frees is eligible.
          : reviewFull && isNewTicket(o.ticket, state) && !eligible.has(`${o.project}/${o.key}`) ? "review-queue-full"
          : eligible.has(`${o.project}/${o.key}`) ? "eligible" : "waiting-for-capacity-or-lock" })),
    };
  }
  async grants(project: string, session: string): Promise<FleetRun[]> {
    const current = this.offers.get(project);
    if (!current || current.session !== session) return [];
    const ids = new Set(current.work.map(o => offerId(this.config.machine, session, o)));
    return (await this.claims.snapshot()).runs.filter(r => r.machine === this.config.machine && r.project === project && r.session === session && ids.has(r.id));
  }
  async finish(project: string, session: string, id: string, completed = true, unused = false, verificationAccepted?:string): Promise<void> {
    const state = await this.claims.snapshot();
    const run = state.runs.find(r => r.id === id);
    if (run && (run.project !== project || run.session !== session || run.machine !== this.config.machine)) throw new Error("Run owner mismatch");
    if(verificationAccepted!==undefined){if(!this.claims.call)throw new Error('Handoff completion unavailable');await this.claims.call('/finish',{session,id,completed,unused,verificationAccepted});}
    else await this.claims.finish(session, id, completed, unused);
  }
}

export async function serveManager(manager: MachineManager, projectTokens: Record<string, string>, operatorToken: string, port: number | string, host = "127.0.0.1", persistDrains?: (projects: string[], changes: ProjectDrainChange[]) => void): Promise<Server> {
  const tokens = [...Object.values(projectTokens), operatorToken];
  if (tokens.some(t => !t) || new Set(tokens).size !== tokens.length) throw new Error("Manager credentials must be distinct");
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    const admin = tokenMatches(req.headers.authorization, operatorToken);
    const project = Object.keys(projectTokens).find(p => tokenMatches(req.headers.authorization, projectTokens[p]));
    if (!admin && !project) return send(401, { error: "Authentication required" });
    try {
      if (req.method === "GET" && req.url === "/state") return send(200, await manager.status());
      if (req.method === "GET" && req.url === "/recovery/state") {
        if (!manager.claims.call) throw new Error("Recovery service unavailable");
        const incidents = await manager.claims.call<Array<{ ticket: string }>>("/recovery/state");
        return send(200, incidents.filter(i => project ? i.ticket.startsWith(`${project}#`) : manager.config.projects.some(p => i.ticket.startsWith(`${p}#`))));
      }
      if (req.method !== "POST") return send(404, { error: "Unknown operation" });
      const body = await readJson(req);
      if(req.url==='/support-offers') {
        if(!admin) return send(403,{error:'Support scheduling requires the local operator'});
        return send(200,await manager.support(body.session));
      }
      if (req.url === "/drain") {
        if (!admin) return send(403, { error: "Operator credential required" });
        manager.draining = true;
        return send(200, { ok: true });
      }
      if (req.url === "/project-drain") {
        if (!admin) return send(403, { error: "Operator credential required" });
        if (!persistDrains) throw new Error("Persistent project drains are not configured");
        // A local drain here would be overwritten by the next central document.
        if (!manager.localDrainsAllowed()) return send(409, { error: "Project drains are central now: use drain --machine MACHINE --project PROJECT --tickets, or resume" });
        await manager.setProjectDraining(body.project, body.draining, persistDrains);
        return send(200, { ok: true, drainingProjects: manager.config.drainingProjects });
      }
      if (!project) return send(403, { error: "Project credential required" });
      if(req.url==='/verification-handoff/preflight'){await manager.verifierHandoffPreflight(project,body.session,body.id);return send(200,{ready:true});}
      if(req.url==='/verification-handoff/confirm')return send(200,await manager.confirmVerifierHandoff(project,body.session,body.id));
      if (req.url === "/worktree/predecessor") {
        const run = (await manager.claims.snapshot()).runs.find(run => run.id === body.runId);
        if (!manager.claims.call || !run || run.project !== project || run.machine !== manager.config.machine || run.session !== body.session) return send(403, { error: "Run owner mismatch" });
        return send(200, await manager.claims.call(req.url, body));
      }
      if (["/codex/report", "/tasks/request", "/tasks/investigate", "/tasks/read", "/tasks/artifact", "/recovery/facts", "/recovery/evidence", "/recovery/pause", "/recovery/coordination", "/recovery/report", "/recovery/begin", "/recovery/decide", "/recovery/complete", "/recovery/split",
        "/evidence/begin", "/evidence/put", "/evidence/commit", "/evidence/list", "/evidence/chunk", "/evidence/usage",
        "/flaky/sightings", "/flaky/track"].includes(req.url ?? "")) {
        if (!manager.claims.call) throw new Error("Recovery service unavailable");
        return send(200, await manager.claims.call(req.url!, { ...body, project,
          ...(req.url === "/recovery/evidence" ? { records: body.records?.map((r: any) => ({ ...r, machine: manager.config.machine })) } : {}) }));
      }
      if(req.url?.startsWith('/workflow/')) {
        if(!['/workflow/read','/workflow/change','/workflow/comments','/workflow/comment','/workflow/authorize','/workflow/approval-outcome','/workflow/stage-plan','/workflow/stage-result','/workflow/stage-read'].includes(req.url) || !manager.claims.call) return send(403,{error:'Unsupported project workflow operation'});
        if(body.ticket && body.ticket.split('#')[0]!==project) return send(403,{error:'Workflow project mismatch'});
        return send(200,await manager.claims.call(req.url,{...body,project}));
      }
      if (req.url === "/github") {
        if (!manager.claims.github) return send(403, { error: "Shared GitHub not configured" });
        return send(200, await manager.claims.github(project, body));
      }
      if (req.url === "/offers") {
        manager.offer(project, body.session, body.offers);
        return send(200, await manager.grants(project, body.session));
      }
      if (req.url === "/withdraw") return send(200, await manager.withdraw(project, body.session));
      if (req.url === '/replace') return send(200, await manager.replace(project, body.session, body.offers));
      if (req.url === "/finish") {
        if (body.observation !== undefined) {
          if (!manager.claims.call || body.observation?.ticket?.split('#')[0] !== project) throw new Error('Completion project mismatch');
          return send(200, await manager.claims.call('/finish', body));
        }
        await manager.finish(project, body.session, body.id, body.completed !== false, body.unused === true, body.verificationAccepted);
        return send(200, { ok: true });
      }
      if (req.url === "/authorize") {
        if (typeof body.ticket !== "string" || !body.ticket.startsWith(`${project}#`) || !manager.claims.authorize) return send(403, { error: "Project mismatch" });
        return send(200, await manager.claims.authorize(body.session, body.ticket, body.runId));
      }
      return send(404, { error: "Unknown operation" });
    } catch (e) {
      // The claim service's ownership refusal keeps its reason, unwrapped.
      const refusal = ownershipRefusal(e);
      if (refusal) return send(409, refusal);
      return send(409, { error: e instanceof Error ? e.message : "Operation failed" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return listen(server, port, host);
}
