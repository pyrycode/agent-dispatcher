import { isRepairWip } from "./recovery-labels.js";
import { PRIORITY_HIGH } from "./ticket-priority.js";
import { WorkflowStore, type WorkflowChange } from "./workflow-store.js";
// The one authority for fleet ownership. No heartbeat expires a claim or run.
// Keep this file on the claim server's local disk, never on a shared filesystem.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { RecoveryFacts, type PauseRecord, type EvidenceRecord, type CoordinationRecord } from "./recovery-facts.js";
import { RecoveryLedger, validateObservations, IDLE_RECOVERY_REASONS, RECOVERY_UNKNOWN_PAUSE_REASON, type RecoveryObservation, type RecoveryDecision, type RecoveryIncident, type RecoveryLedgerOptions } from "./fleet-recovery.js";
import { OperationReports } from './operation-reports.js';
import { OrphanedTaskWatch } from './orphaned-tasks.js';
import {RecoveryTasks, assessmentTasks, recoveryTaskId, validateTaskRequest, type RecoveryTaskRequest, type RecoveryTaskResult} from './recovery-tasks.js';
import { currentWorkflow, recordRepairWorkflow, dispatcherRepairCap } from './recovery-repair-cap.js';
import {createHash} from 'node:crypto';
import {manifestHash} from './recovery-artifacts.js';
import type { AgentRunner } from './agent-runner.js';
import { CAPABILITY_REPORT_FRESH_MS, missingCapabilities, ticketRequirements, validateCapabilityReport } from "./ticket-requirements.js";
import { DesiredStateStore, workRefusal, type DesiredCommand, type DesiredDocument, type DesiredPoll } from './desired-state.js';
import { CodexThrottle, startsCodex, DEFAULT_CODEX_THROTTLE, type CodexThrottleConfig, type CodexPauseState, type CodexSpacingState } from './codex-throttle.js';

/** An operator choice, frozen into each new grant. Null restores local settings. */
export interface RunnerPolicy { runner: AgentRunner | null; revision: number }

export type ResourceClass = "heavy" | "medium" | "light";
export interface MachineLimits {
  heavyLimit: number;
  combinedLimit: number;
  /**
   * Optional. At most this many heavy runs of one project at a time on this
   * computer, inside heavyLimit. A project absent from the map has no extra
   * limit. Added 2026-10-14 for build-hp-1: one Mobile verifier reached 17 to
   * 22 GB of its 31 GB, so two would swap, while a Mobile and a Core heavy
   * job fit together.
   */
  projectHeavyLimits?: Record<string, number>;
}
export function validateLimits(limits: MachineLimits): void {
  if (!limits || !Number.isSafeInteger(limits.heavyLimit) || limits.heavyLimit < 1 ||
      !Number.isSafeInteger(limits.combinedLimit) || limits.combinedLimit < limits.heavyLimit) {
    throw new Error("Limits require positive integers with combinedLimit >= heavyLimit");
  }
  const perProject = limits.projectHeavyLimits;
  if (perProject === undefined) return;
  if (!perProject || typeof perProject !== "object" || Array.isArray(perProject)
    || Object.entries(perProject).some(([project, limit]) => !/^[\w.-]+\/[\w.-]+$/.test(project) || !Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error("projectHeavyLimits must map owner/repo names to positive integers");
  }
}

/**
 * The project a heavy run is charged to for a per-project heavy limit. A
 * support task can be admitted under another project's name, so it is
 * charged to the project of the ticket it serves.
 */
export function heavyProject(run: { project: string; parentTicket?: string }): string {
  return run.parentTicket?.split("#")[0] || run.project;
}

/**
 * Where a role limit counts runs. "fleet" counts every computer and is the
 * default, so offers from older workers keep their meaning. "machine" counts
 * only the computer being admitted to: a limit that protects host resources,
 * such as the verifier's emulator and local relay, not shared repository
 * files such as documentation's index.
 */
export type RoleLimitScope = "machine" | "fleet";
/** Whether an active run counts against a role limit for an offer bound for `machine`. */
export function countsForRoleLimit(run: { project: string; role: string; machine?: string }, offer: { project: string; role: string; roleLimitScope?: RoleLimitScope }, machine: string): boolean {
  return run.project === offer.project && run.role === offer.role
    && (offer.roleLimitScope !== "machine" || run.machine === undefined || run.machine === machine);
}
/**
 * Roles whose admitted run does not start ticket ownership. A recovery
 * assessment only reads and decides. A refiner (po in the classic stage set)
 * writes the issue body, comments and labels on GitHub, and leaves no branch,
 * worktree or local evidence a later stage needs. So ownership starts with
 * the first stage that makes local work: builder, or architect and developer
 * in the classic set.
 *
 * The run still holds its reservation, locks and generation while it runs, so
 * the ticket cannot run twice. A ticket the computer already owns stays owned
 * exactly as it was. Decided 2026-10-14: an assessment that decided to wait on
 * a blocker had made its computer the ticket's permanent owner, and the claim
 * budget lets existing ownership exceed the cap, so one computer owned six
 * runnable tickets once the blockers closed.
 */
export const NON_OWNING_ROLES: ReadonlySet<string> = new Set(["recovery", "refiner", "po"]);
export function startsOwnership(role: string): boolean {
  return !NON_OWNING_ROLES.has(role);
}

export interface StartRequest {
  workflowVersion?: 1;
  id: string;
  machine: string;
  session: string;
  project: string;
  ticket: string;
  role: string;
  resource: ResourceClass;
  locks: string[];
  roleLimit?: number;
  /** Absent means "fleet". See RoleLimitScope. */
  roleLimitScope?: RoleLimitScope;
  requiresRecovery?: boolean;
  readyRepairs?: string[];
  supportTaskId?: string; parentTicket?: string;
  /** The dispatcher's own runner for an agent role. The central choice still wins; this decides only without one. */
  runner?: AgentRunner;
}
export interface Claim { ticket: string; machine: string; generation: string; created: number }
export interface FleetRun extends StartRequest { generation: string; created: number; runnerPolicy?: RunnerPolicy }
export interface FleetSnapshot { workflowProjects?: string[]; claims: Claim[]; runs: FleetRun[]; runnerPolicy?: RunnerPolicy; idleRecoveryTickets?: string[]; priorityHighTickets?: string[]; releasedAssessmentClaims?: Claim[]; features?: {recoveryTasks:boolean; evidence?: boolean}; evidenceStore?: import("./evidence-store.js").EvidenceUsage; requiredRepairs?: Record<string,string[]>; codexPause?: CodexPauseState;
  /**
   * Open tickets of adopted projects waiting for review with nothing holding
   * them (see awaitsReview), whoever owns them. Present, possibly empty,
   * whenever any project is adopted; an older claim service leaves it out,
   * and a manager then applies no review queue limit.
   */
  reviewReadyTickets?: string[];
  /**
   * Open tickets with a `requires:` label and the capabilities they need
   * (see ticket-requirements.ts). Absent when there are none, or from an
   * older claim service, which enforces no requirement.
   */
  ticketRequirements?: Record<string, string[]>;
  /** Each computer's last capability report. Absent before any report. */
  machineCapabilities?: Record<string, MachineCapabilityReport>;
  /** Requirements no computer with a fresh report can satisfy. Absent when there are none. */
  noCapableMachine?: CapabilityGap[];
  /**
   * Claims on tickets with a requirement held by a computer that has never
   * reported its capabilities, such as one still on an older manager. The
   * claim is kept, since the owner may be able to run the ticket, but the
   * owner's starts are refused until it reports. Absent when there are none.
   */
  unreportedOwners?: Array<{ ticket: string; machine: string; requires: string[] }>;
  /** Present only while a new Codex start would be refused for spacing. */
  codexSpacing?: CodexSpacingState;
  /**
   * Tickets with a support task queued, running, publishing or waiting for
   * attention. Always present from a claim service that reports it, possibly
   * empty; absent from an older one, which a reader must treat as unknown.
   */
  openTaskTickets?: string[] }
export type StartResult = { ok: true; generation: string } | {
  ok: false; reason: "foreign-claim" | "running" | "capacity" | "locked" | "finished" | "codex-paused" | "codex-spaced" | "incapable" | "drained";
};
/** projects: the projects the computer's manager serves; absent from a report that did not say, which counts for every project. */
export interface MachineCapabilityReport { capabilities: string[]; projects?: string[]; updated: number }
/** A ticket whose requirement no computer that reported recently advertises. */
export interface CapabilityGap { ticket: string; requires: string[]; missing: string[] }

export function validateStart(req: StartRequest): void {
  if (Object.hasOwn(req, 'runnerPolicy')) throw new Error('Runner choice belongs to the central operator');
  for (const key of ["id", "machine", "session", "project", "ticket", "role"] as const) {
    if (typeof req[key] !== "string" || !req[key] || req[key].length > 250) throw new Error(`Invalid ${key}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(req.project)) throw new Error("Invalid project");
  // @ names are shared non-ticket jobs, such as a main revision check.
  if (!req.ticket.startsWith(`${req.project}#`) || !/^(?:[1-9]\d*|@[\w.-]+)$/.test(req.ticket.slice(req.project.length + 1))) {
    throw new Error("Invalid ticket");
  }
  if (req.resource !== "heavy" && req.resource !== "medium" && req.resource !== "light") throw new Error("Invalid resource class");
  if (req.roleLimit !== undefined && (!Number.isSafeInteger(req.roleLimit) || req.roleLimit < 1)) throw new Error("Invalid role limit");
  if (req.roleLimitScope !== undefined && ((req.roleLimitScope !== "machine" && req.roleLimitScope !== "fleet") || req.roleLimit === undefined)) throw new Error("Invalid role limit scope");
  if (req.runner !== undefined && req.runner !== 'claude' && req.runner !== 'codex') throw new Error('Invalid runner');
  if (req.requiresRecovery !== undefined && (typeof req.requiresRecovery !== 'boolean' || req.role !== 'recovery')) throw new Error('Invalid recovery requirement');
  if(req.readyRepairs!==undefined && (!Array.isArray(req.readyRepairs)||req.readyRepairs.length>10||req.readyRepairs.some(s=>! /^[a-f0-9]{40}$/.test(s)))) throw new Error("Invalid repair readiness");
  // Only a support task is charged to another ticket's project, so only it may name one.
  if(req.parentTicket!==undefined && req.supportTaskId===undefined) throw new Error("Invalid support task admission");
  if(req.supportTaskId!==undefined && (req.role!=="recovery-task"||! /^[a-f0-9]{64}$/.test(req.supportTaskId)||! /^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(req.parentTicket??""))) throw new Error("Invalid support task admission");
  if (!Array.isArray(req.locks) || req.locks.length > 16 || req.locks.some(k => typeof k !== "string" || !k.startsWith(`${req.project}:`) || k.length > 300)) {
    throw new Error("Invalid project locks");
  }
}

export interface FleetStoreOptions extends RecoveryLedgerOptions {
  /** How long a running or attention task may have no holder before it is reported. Default one hour. */
  orphanedTaskMs?: number;
  now?: () => number;
  /** The fleet-wide Codex rate-limit pause. Default two minutes doubling to thirty. */
  codexThrottle?: CodexThrottleConfig;
  /** Where throttle pause starts and ends are logged. Default the console. */
  log?: (line: string) => void;
}

/** How long a creating run holds its new tickets at most: the stale-reservation age. */
export const CREATOR_HOLD_MS = 3 * 60 * 60 * 1000;

/**
 * A workflow write refused because the ticket is owned elsewhere: another
 * computer's claim or run, another run on the same computer, or a run grant
 * that has finished. The HTTP layers report it as a 409 refusal with this
 * reason instead of a generic failure.
 */
export class OwnershipRefusal extends Error {
  constructor(message: string) { super(message); this.name = "OwnershipRefusal"; }
}

export class FleetStore {
  private readonly db: DatabaseSync;
  readonly recovery: RecoveryLedger;
  readonly workflow: WorkflowStore;
  readonly facts: RecoveryFacts;
  readonly operations: OperationReports;
  readonly tasks: RecoveryTasks;
  readonly orphans: OrphanedTaskWatch;
  readonly codex: CodexThrottle;
  /** The operator's central drains and stops per computer and board. See desired-state.ts. */
  readonly desired: DesiredStateStore;
  private readonly clock: () => number;
  constructor(path: string, private readonly limits: Readonly<Record<string, MachineLimits>>, options: FleetStoreOptions = {}) {
    for (const value of Object.values(limits)) validateLimits(value);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS fleet_claims (
        ticket TEXT PRIMARY KEY, machine TEXT NOT NULL, generation TEXT NOT NULL, created INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_runs (
        id TEXT PRIMARY KEY, machine TEXT NOT NULL, session TEXT NOT NULL,
        ticket TEXT NOT NULL, generation TEXT NOT NULL, resource TEXT NOT NULL,
        request TEXT NOT NULL, created INTEGER NOT NULL, finished INTEGER, outcome TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS fleet_ticket_running ON fleet_runs(ticket) WHERE finished IS NULL;
      CREATE TABLE IF NOT EXISTS fleet_locks (
        name TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES fleet_runs(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_runner_policy (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        runner TEXT CHECK(runner IS NULL OR runner IN ('claude','codex')),
        revision INTEGER NOT NULL CHECK(revision>0)
      ) STRICT;
    `);
    this.workflow = new WorkflowStore(this.db);
    this.recovery = new RecoveryLedger(this.db, Date.now, options);
    this.facts = new RecoveryFacts(this.db);
    this.tasks = new RecoveryTasks(this.db);
    this.db.exec("CREATE TABLE IF NOT EXISTS fleet_assessment_releases (ticket TEXT NOT NULL, machine TEXT NOT NULL, generation TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(ticket,generation)) STRICT");
    // The run that created a ticket, by GitHub issue node ID. While that run is
    // active the ticket is not admitted (see startAdmitted), so a refiner that
    // splits a ticket keeps write access to its children until it finishes.
    this.db.exec("CREATE TABLE IF NOT EXISTS fleet_ticket_creators (issue_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created INTEGER NOT NULL) STRICT");
    this.db.exec("CREATE TABLE IF NOT EXISTS fleet_machine_capabilities (machine TEXT PRIMARY KEY, capabilities TEXT NOT NULL, projects TEXT, updated INTEGER NOT NULL) STRICT");
    this.db.exec("CREATE TABLE IF NOT EXISTS fleet_control_target (singleton INTEGER PRIMARY KEY,revision TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS fleet_control_ready (machine TEXT PRIMARY KEY,revision TEXT NOT NULL) STRICT;");
    const clock = options.now ?? Date.now;
    this.operations = new OperationReports(this.db, Object.keys(limits), clock);
    this.orphans = new OrphanedTaskWatch(this.db, this.tasks, this.operations, clock, options.orphanedTaskMs);
    this.clock = clock;
    this.codex = new CodexThrottle(this.db, clock, options.codexThrottle ?? DEFAULT_CODEX_THROTTLE, options.log);
    this.desired = new DesiredStateStore(this.db, Object.keys(limits), clock, machine => this.machineCapabilities()[machine]?.projects);
  }
  close(): void { this.db.close(); }
  /** The authority's record of one run, finished or not. Evidence uploads are accepted only from its own computer. */
  runOwner(id: string): { machine: string; ticket: string; role: string } | undefined {
    const run = this.db.prepare("SELECT machine,ticket,request FROM fleet_runs WHERE id=?").get(id);
    if (!run) return undefined;
    let role = "unknown";
    try { role = String(JSON.parse(String(run.request)).role ?? "unknown"); } catch { /* an unreadable request still names its computer */ }
    return { machine: String(run.machine), ticket: String(run.ticket), role };
  }
  /** True for a Done or closed workflow ticket, false for an open one, undefined for one the workflow store does not hold. */
  ticketDone(ticket: string): boolean | undefined {
    let item;
    // Only an unknown ticket is unknown; any other failure says nothing and is rethrown.
    try { item = this.workflow.get(ticket); } catch (error) { if ((error as Error).message === "Unknown workflow ticket") return undefined; throw error; }
    return item.status === "Done" || item.state === "CLOSED";
  }

  runnerPolicy(): RunnerPolicy | undefined {
    const row = this.db.prepare('SELECT runner,revision FROM fleet_runner_policy WHERE singleton=1').get();
    return row ? { runner: row.runner as AgentRunner | null, revision: Number(row.revision) } : undefined;
  }
  setRunner(runner: unknown): RunnerPolicy {
    if (runner !== null && runner !== 'claude' && runner !== 'codex') throw new Error('Runner must be claude, codex or null');
    return this.transaction(() => {
      const previous = this.runnerPolicy();
      if (previous?.runner === runner) return previous;
      const policy: RunnerPolicy = { runner, revision: (previous?.revision ?? 0) + 1 };
      this.db.prepare('INSERT INTO fleet_runner_policy VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET runner=excluded.runner,revision=excluded.revision')
        .run(policy.runner, policy.revision);
      return policy;
    });
  }

  recoveryReport(machine: string, project: string, observations: RecoveryObservation[]) {
    if (!Object.hasOwn(this.limits, machine)) throw new Error("Unknown machine");
    return this.transaction(() => this.recovery.report(machine, project, observations.map(o => ({ ...o,
      pause: this.facts.getPause(o.ticket), artifactRevision: this.artifactRevision(o.ticket) })), this.snapshot()));
  }
  recoveryStep(machine: string, session: string, project: string, id: string, runId: string, step: "begin" | "decide" | "complete", decision?: RecoveryDecision) {
    const incident = this.recovery.incident(id);
    const run = this.snapshot().runs.find(r => r.id === runId);
    if (!run || run.project !== project || run.ticket !== incident.ticket || run.role !== "recovery" || run.resource !== "heavy") throw new Error("Recovery requires its admitted heavy run");
    this.authorize(machine, session, incident.ticket, runId);
    return this.transaction(() => {
      if (step === "begin") return this.recovery.begin(id, runId);
      if (step === "decide") {
        const selected = this.recovery.decide(id, runId, decision!);
        if (selected.action === 'coordinate') {
          const task = this.tasks.request(incident.ticket, selected.task!,incident.id);
          if (task.request.recipe === 'dispatcher-repair') recordRepairWorkflow(this.db, task.id, task.ticket, currentWorkflow(this.db, task.ticket));
        }
        return selected;
      }
      if (step === "complete") { this.recovery.complete(id, runId); return { ok: true }; }
      throw new Error("Invalid recovery operation");
    });
  }

  controlTarget(revision?: string): string | undefined {
    if(revision!==undefined) {
      if(!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid control revision');
      this.db.prepare('INSERT INTO fleet_control_target VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision').run(revision);
    }
    return this.db.prepare('SELECT revision FROM fleet_control_target WHERE singleton=1').get()?.revision as string|undefined;
  }
  recordControlReady(machine:string,revision:string):void {
    if(!Object.hasOwn(this.limits,machine)||! /^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid control readiness');
    this.db.prepare('INSERT INTO fleet_control_ready VALUES (?,?) ON CONFLICT(machine) DO UPDATE SET revision=excluded.revision').run(machine,revision);
  }
  controlsReady(revision:string,centralRevision?:string):boolean {
    return centralRevision===revision && Object.keys(this.limits).every(machine=>this.db.prepare('SELECT revision FROM fleet_control_ready WHERE machine=?').get(machine)?.revision===revision);
  }
  artifactRevision(ticket: string): string | undefined {
    const revisions = [this.facts.revision([ticket]), this.tasks.revision(ticket)].filter(Boolean);
    if(revisions.length===1) return revisions[0];
    return revisions.length ? createHash('sha256').update(JSON.stringify(revisions)).digest('hex') : undefined;
  }
  requestTask(machine: string, session: string, project: string, runId: string, request: RecoveryTaskRequest) {
    const run = this.snapshot().runs.find(r => r.id === runId && r.machine === machine && r.session === session && r.project === project);
    if (!run || !['builder','developer','recovery'].includes(run.role) || !/#[1-9]\d*$/.test(run.ticket)) throw new Error('Task needs an admitted source worker');
    this.authorize(machine, session, run.ticket, runId);
    return this.transaction(() => {
      // The same cap as an assessment's order. Repeating an existing request still returns it.
      let known = false;
      try { this.tasks.get(recoveryTaskId(run.ticket, validateTaskRequest(request), run.id)); known = true; } catch { /* new, or invalid and refused below */ }
      const workflow = currentWorkflow(this.db, run.ticket);
      if (!known && request?.recipe === 'dispatcher-repair') {
        const cap = dispatcherRepairCap(this.db, run.ticket, workflow, this.clock(), request);
        if (cap.capped) throw new Error(cap.reason);
      }
      const task = this.tasks.request(run.ticket, request,run.id);
      if (task.request.recipe === 'dispatcher-repair') recordRepairWorkflow(this.db, task.id, task.ticket, workflow);
      return task;
    });
  }
  taskStart(machine: string, id: string, session: string): StartResult & {runnerPolicy?: RunnerPolicy;run?:FleetRun} {
    if(!Object.hasOwn(this.limits,machine)) throw new Error('Unknown machine');
    const task=this.tasks.get(id);
    if(!this.tasks.available(machine,id)) return {ok:false,reason:'locked'};
    const project=task.ticket.split('#')[0],runId=`task-${id}`;
    const started=this.start({id:runId,machine,session,project,ticket:`${project}#@task-${id}`,role:'recovery-task',resource:task.request.recipe==='platform-probe'?'light':'heavy',locks:[],supportTaskId:id,parentTicket:task.ticket});
    return {...started,...(started.ok?{runnerPolicy:this.snapshot().runs.find(r=>r.id===runId)?.runnerPolicy,run:this.snapshot().runs.find(r=>r.id===runId)}:{})};
  }
  readTask(machine:string,session:string,project:string,runId:string,id:string,format?:string) {
    const task=this.tasks.get(id);
    const run=this.snapshot().runs.find(r=>r.id===runId&&r.machine===machine&&r.session===session&&r.project===project&&r.ticket===task.ticket);
    if(!run) throw new Error('Artifact read needs its admitted source ticket');
    this.authorize(machine,session,task.ticket,runId);
    const artifacts=this.tasks.manifest(id);
    if(format==='manifest-v1') return {...task,result:task.result?{...task.result,files:{}}:null,artifacts};
    if(format!==undefined) throw new Error('Unsupported artifact read format');
    if(task.artifactsPending) throw new Error('Retained task artifacts are still transferring');
    // Workers already running during rollout can still read small legacy results.
    // An old helper must fail explicitly instead of silently receiving no files.
    if(artifacts && artifacts.totalBytes>4*1024*1024) throw new Error('Artifact bundle requires the manifest-v1 client');
    let legacy=task;
    if(task.artifacts && task.result) {
      const digest=manifestHash(task.artifacts);
      const files=Object.fromEntries(task.artifacts.files.map(file=>[file.path,Buffer.concat(file.chunks.map((_,part)=>
        Buffer.from(this.tasks.artifact(id,digest,file.path,part).data,'base64'))).toString('utf8')]));
      legacy={...task,result:{...task.result,files}};
    }
    if(Buffer.byteLength(JSON.stringify(legacy))>8*1024*1024) throw new Error('Artifact bundle requires the manifest-v1 client');
    return legacy;
  }
  readTaskArtifact(machine:string,session:string,project:string,runId:string,id:string,digest:string,path:string,part:number) {
    this.readTask(machine,session,project,runId,id,'manifest-v1');
    return this.tasks.artifact(id,digest,path,part);
  }
  commitTaskArtifacts(machine:string,id:string,session:string,digest:string,result:RecoveryTaskResult) {
    return this.transaction(()=>{
      const task=this.tasks.commitArtifacts(id,machine,session,digest,result);
      this.releaseTaskRun(task.runId!,machine,session,task.result!.outcome==='completed');
      return task;
    });
  }
  requiredRepairs():Record<string,string[]> {
    const required:Record<string,string[]>={};
    for(const task of this.tasks.list()) if(task.state==='complete' && task.result?.dispatcherRevision) {
      if(!required[task.ticket]) required[task.ticket]=[task.result.dispatcherRevision];
    }
    return required;
  }
  prepareRepair(machine:string,id:string,session:string,publication:unknown,base?:Record<string,string|null>) {
    return this.transaction(()=>{
      const task=this.tasks.prepareRepair(id,machine,session,publication,base);
      this.releaseTaskRun(task.runId!,machine,session,true);
      return task;
    });
  }
  private releaseTaskRun(runId:string,machine:string,session:string,completed:boolean):void {
    const row=this.db.prepare('SELECT ticket FROM fleet_runs WHERE id=? AND machine=? AND session=?').get(runId,machine,session);
    if(!row) throw new Error('Task run changed');
    this.db.prepare("UPDATE fleet_runs SET finished=?,outcome=? WHERE id=? AND finished IS NULL")
      .run(Date.now(),completed?'completed':'errored',runId);
    this.db.prepare('DELETE FROM fleet_locks WHERE run_id=?').run(runId);
    this.db.prepare('DELETE FROM fleet_claims WHERE ticket=? AND NOT EXISTS (SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NULL)')
      .run(row.ticket,row.ticket);
  }
  /** expectStates makes the release conditional on the task's current state, read in the same transaction. */
  taskComplete(machine: string, id: string, session: string, result: RecoveryTaskResult, expectStates?: unknown) {
    return this.transaction(() => {
      const task=this.tasks.get(id);
      if (task.machine!==machine || task.session!==session || !task.runId) throw new Error('Task actor mismatch');
      if (expectStates!==undefined) {
        if (!Array.isArray(expectStates) || !expectStates.length || expectStates.some(s=>typeof s!=='string')) throw new Error('Invalid expected task states');
        // A terminal task answers through complete's own identical-result check, so a lost reply can be retried.
        if (!['complete','failed'].includes(task.state) && !expectStates.includes(task.state)) throw new Error(`Task state is ${task.state}, not ${expectStates.join(' or ')}`);
      }
      const completed=this.tasks.complete(id,machine,session,result);
      this.releaseTaskRun(task.runId,machine,session,result.outcome==='completed');
      return completed;
    });
  }

  workflowChange(machine: string, session: string, runId: string | undefined, ticket: string, change: WorkflowChange, commandId: string, revision?: number) {
    return this.transaction(() => {
      this.authorizeWorkflow(machine, session, ticket, runId);
      return this.workflow.change(ticket, change, machine + ':' + session, commandId, revision);
    });
  }
  authorizeWorkflow(machine:string,session:string,ticket:string,runId?:string):void {
    if(runId && !this.db.prepare('SELECT 1 FROM fleet_runs WHERE id=? AND machine=? AND session=? AND finished IS NULL').get(runId,machine,session)) throw new OwnershipRefusal('Workflow run has finished or lost ownership');
    this.authorize(machine,session,ticket,runId);
  }
  workflowComment(machine:string,session:string,runId:string|undefined,ticket:string,body:string,id:string):void {
    this.transaction(()=>{this.authorizeWorkflow(machine,session,ticket,runId);this.workflow.comment(ticket,body,id);});
  }
  workflowOperator(ticket: string, change: WorkflowChange, commandId: string, revision: number) {
    return this.transaction(() => {
      if (!Number.isSafeInteger(revision)) throw new Error('Expected workflow revision required');
      if (this.snapshot().runs.some(r=>r.ticket===ticket)) throw new Error('Ticket has an active reservation; drain it before changing workflow');
      return this.workflow.change(ticket, change, 'operator', commandId, revision);
    });
  }
  /** The final step of an operator filing. A retry hours later must not overwrite a running ticket. */
  workflowFile(id: string, ticket: string, change: WorkflowChange) {
    return this.transaction(() => {
      if (this.snapshot().runs.some(r=>r.ticket===ticket)) throw new Error('Ticket has an active reservation; drain it before changing workflow');
      return this.workflow.completeFiling(id, ticket, change);
    });
  }
  recoveryFacts(tickets: string[], assessment?:{machine:string;session:string;project:string;runId:string}) {
    let diagnosticTicket: string | undefined;
    if(assessment) {
      const run=this.snapshot().runs.find(r=>r.id===assessment.runId && r.machine===assessment.machine && r.session===assessment.session && r.project===assessment.project && r.role==='recovery');
      if(!run) throw new Error('Diagnostics require the owning admitted recovery assessment');
      this.authorize(assessment.machine,assessment.session,run.ticket,run.id);
      diagnosticTicket=run.ticket;
    }
    const evidence = this.facts.getEvidence(tickets);
    const facts=tickets.map(ticket => {
      const totalCount=this.tasks.count(ticket);
      return {ticket,pause:this.facts.getPause(ticket),artifactRevision:this.artifactRevision(ticket),evidence:evidence.filter(e=>e.ticket===ticket),capabilities:this.tasks.capabilities(),
        tasks:[] as ReturnType<typeof assessmentTasks>,taskHistory:{totalCount,returnedCount:0,omittedCount:totalCount},coordination:this.facts.getCoordination(ticket)};
    });
    // The Unix client permits 1 MiB for /recovery/facts. Reserve the existing
    // metadata first, then share the remaining bytes across all task histories.
    const budget={bytes:1024*1024-Buffer.byteLength(JSON.stringify(facts))-tickets.length*2,diagnosticCharacters:48000};
    if(budget.bytes<0) throw new Error('Recovery facts exceed response bounds; request fewer tickets');
    // Related-ticket order cannot starve the owning assessment of its diagnostics.
    for(const fact of [...facts].sort((a,b)=>Number(b.ticket===diagnosticTicket)-Number(a.ticket===diagnosticTicket))) {
      fact.tasks=assessmentTasks(this.tasks.list(fact.ticket),fact.ticket===diagnosticTicket,(task,path)=>{
        const file=task.artifacts!.files.find(f=>f.path===path)!,digest=manifestHash(task.artifacts!);
        return Buffer.concat(file.chunks.map((_,part)=>Buffer.from(this.tasks.artifact(task.id,digest,path,part).data,'base64'))).toString('utf8');
      },budget);
      fact.taskHistory.returnedCount=fact.tasks.length;
      fact.taskHistory.omittedCount-=fact.tasks.length;
    }
    return facts;
  }
  recordPause(machine: string, session: string, project: string, runId: string, record: PauseRecord) {
    if (!record?.ticket?.startsWith(`${project}#`) || record.origin !== "pipeline") throw new Error("Pipeline pause required");
    const claim = this.authorize(machine, session, record.ticket, runId);
    const run = this.snapshot().runs.find(r => r.id === runId);
    if (!run || run.project !== project) throw new Error("Pause requires an admitted run");
    this.facts.pause({ ...record, actor: `${machine}/${run.role}`, revision: claim.generation });
    return { ok: true };
  }
  recordCoordination(machine: string, session: string, project: string, runId: string, record: CoordinationRecord) {
    if (!record?.ticket?.startsWith(`${project}#`)) throw new Error("Coordination project mismatch");
    this.authorize(machine, session, record.ticket, runId);
    const run = this.snapshot().runs.find(r => r.id === runId);
    if (!run || !["refiner", "po"].includes(run.role)) throw new Error("Coordination requires an admitted planning run");
    this.facts.coordinate(record); return { ok: true };
  }
  recordEvidence(machine: string, project: string, records: EvidenceRecord[]) {
    if (!Object.hasOwn(this.limits, machine)) throw new Error("Unknown machine");
    return this.transaction(() => { this.facts.evidence(machine, project, records); return { ok: true }; });
  }

  /** Guard small workflow writes too. An active job is writable only by that run. */
  authorize(machine: string, session: string, ticket: string, runId?: string): Claim {
    if (!Object.hasOwn(this.limits, machine) || !session || !/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(ticket)) throw new Error("Invalid ownership request");
    return this.transaction(() => {
      const claim = this.db.prepare("SELECT * FROM fleet_claims WHERE ticket=?").get(ticket) as unknown as Claim | undefined;
      if (claim && claim.machine !== machine) throw new OwnershipRefusal("Ticket belongs to another machine");
      const active = this.db.prepare("SELECT id,machine,session FROM fleet_runs WHERE ticket=? AND finished IS NULL").get(ticket);
      // An unowned ticket's run, such as an assessment, is guarded here rather than by a claim.
      if (active && active.machine !== machine) throw new OwnershipRefusal("Ticket is running on another machine");
      if (active && (active.id !== runId || active.session !== session)) throw new OwnershipRefusal("Ticket has an active run");
      if (claim) return claim;
      const grant = runId ? this.db.prepare("SELECT ticket,request,generation FROM fleet_runs WHERE id=? AND machine=? AND session=? AND finished IS NULL").get(runId, machine, session) : undefined;
      if (!grant) throw new OwnershipRefusal("Unclaimed workflow writes require a run grant");
      const request = JSON.parse(String(grant.request)) as StartRequest;
      if (!ticket.startsWith(`${request.project}#`)) throw new OwnershipRefusal("Run project mismatch");
      // A run that starts no ownership writes its own ticket under its own generation.
      const generation = String(grant.ticket) === ticket ? String(grant.generation) : randomUUID();
      const result = { ticket, machine, generation, created: Date.now() };
      // Recording follow-ups and housekeeping must not reserve their future
      // work. Only start() creates ownership after scheduling admission.
      return result;
    });
  }

  /**
   * Record that an admitted run created this issue. Only the run's own
   * computer and session can record it, and only while the run is active.
   * The first creator wins, so a later write cannot move the hold. Rows
   * past the hold limit are pruned here, so runs that end without finish()
   * leave nothing behind for long.
   */
  recordTicketCreator(machine: string, session: string, runId: string | undefined, issueId: string): void {
    if (!runId || typeof issueId !== "string" || !issueId) return;
    const now = this.clock();
    this.db.prepare("DELETE FROM fleet_ticket_creators WHERE created<?").run(now - CREATOR_HOLD_MS);
    this.db.prepare("INSERT OR IGNORE INTO fleet_ticket_creators SELECT ?,id,? FROM fleet_runs WHERE id=? AND machine=? AND session=? AND finished IS NULL")
      .run(issueId, now, runId, machine, session);
  }

  private transactionDepth = 0;
  private transaction<T>(work: () => T): T {
    if(this.transactionDepth) return work();
    this.db.exec("BEGIN IMMEDIATE");this.transactionDepth++;
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally {this.transactionDepth--;}
  }

  start(req: StartRequest): StartResult {
    return this.transaction(() => {
      const prior=this.db.prepare('SELECT id FROM fleet_runs WHERE id=?').get(req.id);
      if(req.supportTaskId && !prior) {
        validateStart(req);
        const task=this.tasks.get(req.supportTaskId);
        if(!this.tasks.available(req.machine,task.id)) return {ok:false,reason:'locked'};
        if(req.parentTicket!==task.ticket || req.ticket!==`${req.project}#@task-${task.id}`
          || req.project!==task.ticket.split('#')[0] && req.project!=='pyrycode/pyrycode'
          || req.resource!==(task.request.recipe==='platform-probe'?'light':'heavy')) throw new Error('Support task grant does not match its fixed request');
        const admitted=this.startAdmitted(req);
        if(admitted.ok) this.tasks.begin(task.id,req.machine,req.session,req.id);
        return admitted;
      }
      return this.startAdmitted(req);
    });
  }
  private startAdmitted(req: StartRequest): StartResult {
    validateStart(req);
    if (!Object.hasOwn(this.limits, req.machine)) throw new Error("Unknown machine");
    const request = JSON.stringify({ ...req, locks: [...new Set(req.locks)].sort() });
      const previous = this.db.prepare("SELECT request,generation,finished FROM fleet_runs WHERE id=?").get(req.id);
      if (previous) {
        const { runnerPolicy: _policy, ...original } = JSON.parse(String(previous.request));
        if (JSON.stringify(original) !== request) throw new Error("Request ID reused with different contents");
        return previous.finished === null ? { ok: true, generation: String(previous.generation) } : { ok: false, reason: "finished" };
      }
    // The operator's central drain or stop holds new grants here even when
    // the computer's manager is older or has not fetched it yet. A retry of
    // a lost reply above still recovers its grant.
    if (workRefusal(project => this.desired.work(req.machine, project), req,
      this.db.prepare("SELECT machine FROM fleet_claims WHERE ticket=?").get(req.ticket)?.machine === req.machine)) return { ok: false, reason: "drained" };
    if(this.workflow.preparing(req.project))return {ok:false,reason:'locked'};
    if(this.workflow.enabled(req.project) && !req.supportTaskId && req.workflowVersion!==1) return {ok:false,reason:"locked"};
    if(this.workflow.enabled(req.project) && /#[1-9]\d*$/.test(req.ticket)) {
      const item=this.workflow.get(req.ticket);
      const columns:Record<string,string>={po:'Backlog',refiner:'Backlog',architect:'In Architecture',developer:'In Development',builder:'In Development',qa:'In QA','code-review':'In Code Review',verifier:'In Code Review',documentation:'In Documentation'};
      if(columns[req.role] && (item.state!=='OPEN' || item.status!==columns[req.role] || item.labels.some(l=>l.startsWith('error:')||l.startsWith('needs-rework:')||(l.startsWith('wip:')&&!isRepairWip(l))||l.startsWith('needs-human:')&&l!=='needs-human:sizing') || item.blockedBy.some(b=>b.state==='OPEN'))) return {ok:false,reason:'locked'};
      // A ticket split off by a run that is still active waits for that run,
      // which may still be writing its labels, priority and board order.
      // Bounded, so a creator whose computer went away cannot hold its
      // children past the point where its reservation is reported as stale.
      if(this.db.prepare('SELECT 1 FROM fleet_ticket_creators AS c JOIN fleet_runs AS r ON r.id=c.run_id WHERE c.issue_id=? AND r.finished IS NULL AND c.created>?').get(item.issueId,this.clock()-CREATOR_HOLD_MS)) return {ok:false,reason:'locked'};
    }
    // Every stage of a ticket with a requirement runs only where it can.
    const needs = this.requirementsOf(req.ticket);
    if (needs.length && missingCapabilities(needs, this.reportedCapabilities(req.machine)).length) return { ok: false, reason: "incapable" };
    if(/#[1-9]\d*$/.test(req.ticket) && req.role!=='recovery') {
      const required=this.requiredRepairs()[req.ticket]??[];
      if(required.some(sha=>!req.readyRepairs?.includes(sha))) return {ok:false,reason:'locked'};
      if(this.tasks.list(req.ticket).some(t=>['queued','running','publishing','attention'].includes(t.state))) return {ok:false,reason:'locked'};
    }
      if (req.ticket.includes("#@main-sweep-") && this.db.prepare("SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NOT NULL AND outcome='completed'").get(req.ticket)) return { ok: false, reason: "finished" };
      if (req.role === "reconcile" && (req.ticket !== `${req.project}#@reconcile` || !req.locks.includes(`${req.project}:reconcile`))) throw new Error("Housekeeping requires the project lock");
      if (req.role === "recovery") {
        if (req.resource !== "heavy" || !/#[1-9]\d*$/.test(req.ticket)) throw new Error("Recovery requires a heavy ticket reservation");
        if (req.requiresRecovery && !this.db.prepare("SELECT 1 FROM fleet_recovery WHERE ticket=? AND present=1 AND state='queued'").get(req.ticket)) return { ok: false, reason: 'locked' };
        if (this.db.prepare("SELECT 1 FROM fleet_runs WHERE finished IS NULL AND json_extract(request,'$.role')='recovery'").get()) return { ok: false, reason: "locked" };
      }
      if (this.db.prepare("SELECT 1 FROM fleet_locks WHERE name=?").get(`${req.project}:reconcile`)) return { ok: false, reason: "locked" };
      const claim = this.db.prepare("SELECT * FROM fleet_claims WHERE ticket=?").get(req.ticket);
      if (claim && claim.machine !== req.machine) return { ok: false, reason: "foreign-claim" };
      if (this.db.prepare("SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NULL").get(req.ticket)) return { ok: false, reason: "running" };
      // A Codex rate limit pauses new Codex starts across the fleet, and
      // Codex starts are spaced apart fleet-wide (checked below, after the
      // other admission checks). Admitted runs and work that starts no Codex
      // agent are untouched. A refusal reserves nothing.
      const codex = startsCodex(req, this.runnerPolicy(), req.supportTaskId ? this.tasks.get(req.supportTaskId).request.recipe : undefined);
      if (codex && this.codex.paused(this.clock())) return { ok: false, reason: "codex-paused" };
      if (req.resource !== "light") {
        const row = this.db.prepare(`SELECT
          count(CASE WHEN resource='heavy' THEN 1 END) AS heavy,
          count(CASE WHEN resource IN ('heavy','medium') THEN 1 END) AS combined
          FROM fleet_runs WHERE machine=? AND finished IS NULL`).get(req.machine)!;
        const limit = this.limits[req.machine];
        if (Number(row.combined) >= limit.combinedLimit ||
            (req.resource === "heavy" && Number(row.heavy) >= limit.heavyLimit)) return { ok: false, reason: "capacity" };
        const projectLimit = req.resource === "heavy" ? limit.projectHeavyLimits?.[heavyProject(req)] : undefined;
        if (projectLimit !== undefined) {
          const heavy = this.db.prepare("SELECT request FROM fleet_runs WHERE machine=? AND finished IS NULL AND resource='heavy'").all(req.machine);
          if (heavy.filter(r => heavyProject(JSON.parse(String(r.request))) === heavyProject(req)).length >= projectLimit) return { ok: false, reason: "capacity" };
        }
      }
      if (req.roleLimit !== undefined) {
        const active = this.db.prepare("SELECT machine,request FROM fleet_runs WHERE finished IS NULL").all();
        if (active.filter(r => countsForRoleLimit({ ...JSON.parse(String(r.request)), machine: String(r.machine) }, req, req.machine)).length >= req.roleLimit) return { ok: false, reason: "locked" };
      }
      for (const lock of req.locks) {
        if (this.db.prepare("SELECT 1 FROM fleet_locks WHERE name=?").get(lock)) return { ok: false, reason: "locked" };
      }
      // Last, so a start that would be refused anyway is not counted as spaced.
      if (codex && this.codex.spacingWaitMs(this.clock()) > 0) { this.codex.spacingHeld(); return { ok: false, reason: "codex-spaced" }; }
      // A run that starts no ownership still gets a generation of its own, so
      // its grant, workflow writes and completion are tied to this run.
      const generation = claim ? String(claim.generation) : randomUUID();
      const now = this.clock();
      const runnerPolicy = this.runnerPolicy();
      const admitted = runnerPolicy ? JSON.stringify({ ...JSON.parse(request), runnerPolicy }) : request;
      if (!claim && startsOwnership(req.role)) this.db.prepare("INSERT OR IGNORE INTO fleet_claims VALUES (?,?,?,?)").run(req.ticket, req.machine, generation, now);
      this.db.prepare("INSERT INTO fleet_runs VALUES (?,?,?,?,?,?,?,?,NULL,NULL)").run(req.id, req.machine, req.session, req.ticket, generation, req.resource, admitted, now);
      for (const lock of new Set(req.locks)) this.db.prepare("INSERT INTO fleet_locks VALUES (?,?)").run(lock, req.id);
      if (codex) this.codex.started({ machine: req.machine, ticket: req.ticket, role: req.role }, now);
      return { ok: true, generation };
  }

  finish(machine: string, session: string, id: string, completed?: boolean, unused?: boolean): void;
  finish(machine: string, session: string, id: string, completed: boolean, unused: boolean, observation: RecoveryObservation | undefined): RecoveryIncident[];
  finish(machine: string, session: string, id: string, completed = true, unused = false, observation?: RecoveryObservation): RecoveryIncident[] {
    if (unused && completed) throw new Error("Unused work cannot be completed");
    return this.transaction(() => {
      const run = this.db.prepare("SELECT * FROM fleet_runs WHERE id=?").get(id);
      if (!run || run.machine !== machine || run.session !== session) throw new Error("Run owner mismatch");
      const request = JSON.parse(String(run.request)) as StartRequest;
      if (observation) {
        validateObservations(request.project, [observation]);
        if (unused || observation.ticket !== run.ticket) throw new Error('Completion observation mismatch');
      }
      // Recover the original result after a lost acknowledgement. Do not report
      // again after a recovery worker may already have started.
      if (run.finished !== null) return observation ? this.recovery.list(request.project).filter(i => i.current && i.ticket === run.ticket) : [];
      this.db.prepare("DELETE FROM fleet_locks WHERE run_id=?").run(id);
      // Its split children are admissible from now on.
      this.db.prepare("DELETE FROM fleet_ticket_creators WHERE run_id=?").run(id);
      this.db.prepare("UPDATE fleet_runs SET finished=?,outcome=? WHERE id=? AND finished IS NULL").run(Date.now(), unused ? "unused" : completed ? "completed" : "cancelled", id);
      // An explicitly withdrawn, never-started reservation has no work to own.
      // Preserve this generation if any actual or uncertain run used it. In
      // particular, blocked/failed work and offline reservations remain owned.
      if (unused) {
        this.db.prepare(`DELETE FROM fleet_claims WHERE ticket=? AND generation=?
          AND NOT EXISTS (SELECT 1 FROM fleet_runs WHERE ticket=? AND generation=?
            AND (finished IS NULL OR outcome IS NULL OR outcome!='unused'))`)
          .run(run.ticket, run.generation, run.ticket, run.generation);
      }
      // Confirmed read-only waits and pause-provenance reviews own no delivery work.
      // Preserve ownership if this generation has any normal or uncertain run.
      if (completed && request.role === "recovery" && this.db.prepare(`SELECT 1 FROM fleet_recovery
        WHERE run_id=? AND ((state='complete' AND json_extract(decision,'$.action')='wait')
          OR (reason=? AND state='escalated' AND json_extract(decision,'$.action') IN ('escalate','propose-close')))`).get(id, RECOVERY_UNKNOWN_PAUSE_REASON)) {
        const released = this.db.prepare(`DELETE FROM fleet_claims WHERE ticket=? AND generation=?
          AND NOT EXISTS (SELECT 1 FROM fleet_runs WHERE ticket=? AND generation=?
            AND (finished IS NULL OR outcome IS NULL OR outcome NOT IN ('completed','unused')
              OR (json_extract(request,'$.role')!='recovery' AND outcome!='unused')))
          AND NOT EXISTS (SELECT 1 FROM fleet_recovery AS recovery JOIN fleet_runs AS history ON history.id=recovery.run_id
            WHERE history.ticket=? AND history.generation=?
            AND json_extract(recovery.decision,'$.action') IN ('retry','rework','resume','refine','unblock','coordinate'))
          AND NOT EXISTS (SELECT 1 FROM fleet_recovery_tasks AS tasks WHERE tasks.ticket=fleet_claims.ticket
            AND (tasks.created>=fleet_claims.created OR tasks.state IN ('queued','running','publishing','attention')))`)
          .run(run.ticket, run.generation, run.ticket, run.generation, run.ticket, run.generation);
        if (released.changes) this.db.prepare("INSERT OR IGNORE INTO fleet_assessment_releases VALUES (?,?,?,?)")
          .run(run.ticket, run.machine, run.generation, Date.now());
      }
      this.workflow.finish(String(run.ticket), request.role, id);
      // Shared maintenance jobs have no long-lived ticket owner.
      if (String(run.ticket).includes("#@")) {
        this.db.prepare("DELETE FROM fleet_claims WHERE ticket=? AND generation=? AND NOT EXISTS (SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NULL)")
          .run(run.ticket, run.generation, run.ticket);
      }
      // The new incident and slot release commit together. A single completion
      // must never retire incidents belonging to other tickets in the project.
      if (!observation) return [];
      return this.recovery.report(machine, request.project, [{ ...observation,
        pause: this.facts.getPause(observation.ticket), artifactRevision: this.artifactRevision(observation.ticket) }], this.snapshot(), true);
    });
  }

  /**
   * A dispatcher's report about one of its admitted Codex runs: it hit a rate
   * limit, or it got a model response. Only the run's own computer and
   * session can report it, and a finished run can still be reported, since
   * the report races the run's completion.
   */
  codexReport(machine: string, session: string, project: string, runId: string, event: unknown): CodexPauseState {
    if (event !== "rate-limited" && event !== "clean") throw new Error("Codex report must be rate-limited or clean");
    if (typeof runId !== "string" || typeof session !== "string" || typeof project !== "string") throw new Error("Invalid Codex report");
    return this.transaction(() => {
      const run = this.db.prepare("SELECT machine,session,ticket,request,created FROM fleet_runs WHERE id=?").get(runId);
      if (!run || run.machine !== machine || run.session !== session) throw new Error("Codex report needs its own admitted run");
      const request = JSON.parse(String(run.request)) as StartRequest;
      if (request.project !== project) throw new Error("Codex report project mismatch");
      const source = { machine, project, ticket: String(run.ticket), role: request.role, runId, admittedAt: Number(run.created) };
      return event === "clean" ? this.codex.clean(source) : this.codex.rateLimited(source);
    });
  }
  /** A manager's desired state fetch. See DesiredStateStore.poll. */
  desiredPoll(machine: string, poll: DesiredPoll): DesiredDocument { return this.transaction(() => this.desired.poll(machine, poll)); }
  /** Operator: a central drain, resume, stop or start. See DesiredStateStore.set. */
  setDesired(command: DesiredCommand) { return this.transaction(() => this.desired.set(command)); }
  /** Operator: end a Codex pause early and reset its backoff. */
  clearCodexPause(): CodexPauseState { return this.transaction(() => this.codex.clear()); }
  /** Log a Codex pause that has run out. Called on a timer by the claim service. */
  codexTick(): void { this.transaction(() => this.codex.tick()); }

  /**
   * A manager's report of what its computer offers tickets: its operating
   * system and configured hardware (see ticket-requirements.ts).
   */
  reportMachineCapabilities(machine: string, capabilities: unknown, projects?: unknown): MachineCapabilityReport {
    if (!Object.hasOwn(this.limits, machine)) throw new Error("Unknown machine");
    const list = validateCapabilityReport(capabilities);
    if (projects !== undefined && (!Array.isArray(projects) || projects.length > 50 || projects.some(p => typeof p !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(p)))) throw new Error("Invalid machine projects");
    const served = projects === undefined ? undefined : [...new Set(projects as string[])].sort();
    const updated = this.clock();
    this.db.prepare("INSERT INTO fleet_machine_capabilities VALUES (?,?,?,?) ON CONFLICT(machine) DO UPDATE SET capabilities=excluded.capabilities,projects=excluded.projects,updated=excluded.updated")
      .run(machine, JSON.stringify(list), served === undefined ? null : JSON.stringify(served), updated);
    return { capabilities: list, ...(served ? { projects: served } : {}), updated };
  }
  /** Last reports of configured computers. A computer that never reported is absent. */
  machineCapabilities(): Record<string, MachineCapabilityReport> {
    return Object.fromEntries(this.db.prepare("SELECT * FROM fleet_machine_capabilities ORDER BY machine").all()
      .filter(r => Object.hasOwn(this.limits, String(r.machine)))
      .map(r => [String(r.machine), { capabilities: JSON.parse(String(r.capabilities)) as string[],
        ...(r.projects === null ? {} : { projects: JSON.parse(String(r.projects)) as string[] }), updated: Number(r.updated) }]));
  }
  /**
   * What a computer advertised in its last report, whatever its age: a
   * computer's capabilities do not change while it is away. A computer that
   * never reported, such as one on an older manager, advertises nothing.
   */
  private reportedCapabilities(machine: string): string[] | undefined {
    const row = this.db.prepare("SELECT capabilities FROM fleet_machine_capabilities WHERE machine=?").get(machine);
    return row ? JSON.parse(String(row.capabilities)) as string[] : undefined;
  }
  /** The capabilities a numbered ticket of an adopted project requires. Shared jobs require nothing. */
  private requirementsOf(ticket: string): string[] {
    if (!/#[1-9]\d*$/.test(ticket) || !this.workflow.enabled(ticket.split("#")[0])) return [];
    let labels: string[];
    try { labels = this.workflow.get(ticket).labels; } catch { return []; }
    return ticketRequirements(labels);
  }
  /**
   * Release every claim whose owner lacks a capability its open ticket now
   * requires, when nothing the owner alone holds is pending: no run, no open
   * support task, no running or stranded wip: label, and no saved verdict
   * waiting to publish (pending-verdict:, pending-done:), which only the
   * owner's disk has. The owner can never run another stage of the ticket,
   * so the claim would only trap it. Its next stage is then taken like any
   * unowned ticket by a computer that can run it. An owner that never
   * reported, such as one on an older manager during a rollout, is unknown
   * rather than incapable, and keeps its claims. The
   * release is recorded with the assessment releases, so a supervised update
   * reads the disappearing claim as a release, not an ownership change.
   * Branches, working copies and GitHub state are untouched, as with free().
   * The claim service runs this on a timer.
   */
  releaseIncapableClaims(): Claim[] {
    return this.transaction(() => {
      const requirements = this.workflow.openTicketRequirements();
      const released: Claim[] = [];
      for (const claim of this.db.prepare("SELECT * FROM fleet_claims ORDER BY created,ticket").all() as unknown as Claim[]) {
        const required = requirements[claim.ticket];
        const owner = required && this.reportedCapabilities(claim.machine);
        if (!required || !owner || !missingCapabilities(required, owner).length) continue;
        if (this.db.prepare("SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NULL").get(claim.ticket)) continue;
        if (this.db.prepare("SELECT 1 FROM fleet_recovery_tasks WHERE ticket=? AND state IN ('queued','running','publishing','attention')").get(claim.ticket)) continue;
        let labels: string[];
        try { labels = this.workflow.get(claim.ticket).labels; } catch { continue; }
        if (labels.some(l => /^(wip:|pending-verdict:|pending-done:)/.test(l))) continue;
        this.db.prepare("DELETE FROM fleet_claims WHERE ticket=? AND generation=?").run(claim.ticket, claim.generation);
        this.db.prepare("INSERT OR IGNORE INTO fleet_assessment_releases VALUES (?,?,?,?)").run(claim.ticket, claim.machine, claim.generation, this.clock());
        released.push(claim);
      }
      return released;
    });
  }
  /** Requirements no configured computer that serves the ticket's project and reported recently can satisfy. */
  private capabilityGaps(requirements: Record<string, string[]>, reports: Record<string, MachineCapabilityReport>): CapabilityGap[] {
    const now = this.clock();
    const fresh = Object.values(reports).filter(r => now - r.updated < CAPABILITY_REPORT_FRESH_MS);
    return Object.entries(requirements).flatMap(([ticket, required]) => {
      const project = ticket.split("#")[0];
      const serving = fresh.filter(r => !r.projects || r.projects.includes(project)).map(r => r.capabilities);
      if (serving.some(caps => !missingCapabilities(required, caps).length)) return [];
      return [{ ticket, requires: required, missing: required.filter(c => !serving.some(caps => caps.includes(c))) }];
    });
  }

  // Operator recovery only. The caller must disable/stop the old worker first.
  // Matching the generation prevents an old confirmation from releasing a new owner.
  free(ticket: string, generation: string, stopped: boolean): void {
    if (stopped !== true) throw new Error("Confirm the old worker and its subprocesses have stopped");
    this.transaction(() => {
      const claim = this.db.prepare("SELECT generation FROM fleet_claims WHERE ticket=?").get(ticket);
      // An unowned ticket can still hold a run that starts no ownership, such
      // as a recovery assessment. The operator ends it by its run generation.
      const unownedRun = !claim && this.db.prepare("SELECT 1 FROM fleet_runs WHERE ticket=? AND generation=? AND finished IS NULL").get(ticket, generation);
      if (claim ? claim.generation !== generation : !unownedRun) throw new Error("Ticket ownership changed; inspect it again");
      this.db.prepare("DELETE FROM fleet_locks WHERE run_id IN (SELECT id FROM fleet_runs WHERE ticket=? AND finished IS NULL)").run(ticket);
      this.db.prepare("UPDATE fleet_runs SET finished=? WHERE ticket=? AND finished IS NULL").run(Date.now(), ticket);
      this.db.prepare("DELETE FROM fleet_claims WHERE ticket=? AND generation=?").run(ticket, generation);
    });
  }

  /**
   * The workflow's review-ready tickets less those this authority would refuse
   * a review for while a support task is open on them (see start()).
   */
  private reviewReadyTickets(): string[] | undefined {
    let ready: string[];
    // A row that cannot be read must not stop every manager's scheduling:
    // leaving the list out means no review queue hold anywhere.
    try { ready = this.workflow.reviewReadyTickets(); }
    catch (e) { console.warn("Review queue list unavailable:", (e as Error).message); return undefined; }
    if (!ready.length) return ready;
    const tasked = new Set(this.db.prepare("SELECT DISTINCT ticket FROM fleet_recovery_tasks WHERE state IN ('queued','running','publishing','attention')").all().map(r => String(r.ticket)));
    return ready.filter(t => !tasked.has(t));
  }

  /** Tickets with an open support task, in the states start() refuses. */
  openTaskTickets(): string[] {
    return this.db.prepare("SELECT DISTINCT ticket FROM fleet_recovery_tasks WHERE state IN ('queued','running','publishing','attention') ORDER BY ticket").all().map(r => String(r.ticket));
  }

  /** Read-only custody proof. A missing active reservation alone cannot
   * establish that a recorded predecessor ever ran or finished normally. */
  worktreePredecessor(machine: string, session: string, runId: string, priorId: string): FleetRun | null {
    const state = this.snapshot();
    const current = state.runs.find(run => run.id === runId && run.machine === machine && run.session === session);
    if (!current) throw new Error("Run owner mismatch");
    const row = this.db.prepare("SELECT request,generation,created,finished,outcome FROM fleet_runs WHERE id=?").get(priorId);
    if (!row || row.finished === null || !["completed", "cancelled"].includes(String(row.outcome))) return null;
    const prior = { ...JSON.parse(String(row.request)), generation: String(row.generation), created: Number(row.created) } as FleetRun;
    if (prior.id === current.id || prior.machine !== machine || prior.project !== current.project ||
        prior.ticket !== current.ticket || prior.generation !== current.generation || prior.created > current.created ||
        !state.claims.some(claim => claim.ticket === current.ticket && claim.machine === machine && claim.generation === current.generation)) return null;
    // Normal ManagedDispatch completion waits for tracked process groups
    // before /finish. Operator /free leaves no normal outcome and changes ownership.
    return prior;
  }

  snapshot(): FleetSnapshot {
    const runnerPolicy = this.runnerPolicy();
    const idleRecoveryTickets = this.db.prepare(`SELECT ticket FROM fleet_recovery WHERE present=1 AND state='queued' AND reason IN (${IDLE_RECOVERY_REASONS.map(() => '?').join(',')})`)
      .all(...IDLE_RECOVERY_REASONS).map(r => String(r.ticket));
    const releasedAssessmentClaims = this.db.prepare("SELECT * FROM fleet_assessment_releases").all() as unknown as Claim[];
    const codexPause = this.codex.snapshot();
    const codexSpacing = this.codex.spacingWaitMs() > 0 ? this.codex.spacingState() : undefined;
    // Read from the workflow authority, so offers from older workers are ranked too.
    const priorityHighTickets = this.workflow.openTicketsWithLabel(PRIORITY_HIGH);
    const workflowProjects = this.workflow.projects().map(p => p.project);
    const reviewReadyTickets = workflowProjects.length ? this.reviewReadyTickets() : undefined;
    const ticketRequirements = workflowProjects.length ? this.workflow.openTicketRequirements() : {};
    const machineCapabilities = this.machineCapabilities();
    const noCapableMachine = this.capabilityGaps(ticketRequirements, machineCapabilities);
    const claims = this.db.prepare("SELECT * FROM fleet_claims ORDER BY created,ticket").all() as unknown as Claim[];
    const unreportedOwners = claims.filter(c => ticketRequirements[c.ticket] && !Object.hasOwn(machineCapabilities, c.machine))
      .map(c => ({ ticket: c.ticket, machine: c.machine, requires: ticketRequirements[c.ticket] }));
    return {
      ...(codexPause ? { codexPause } : {}),
      ...(codexSpacing ? { codexSpacing } : {}),
      ...(workflowProjects.length ? { workflowProjects } : {}),
      ...(runnerPolicy ? { runnerPolicy } : {}),
      ...(idleRecoveryTickets.length ? { idleRecoveryTickets } : {}),
      ...(priorityHighTickets.length ? { priorityHighTickets } : {}),
      ...(reviewReadyTickets ? { reviewReadyTickets } : {}),
      ...(Object.keys(ticketRequirements).length ? { ticketRequirements } : {}),
      ...(Object.keys(machineCapabilities).length ? { machineCapabilities } : {}),
      ...(noCapableMachine.length ? { noCapableMachine } : {}),
      ...(unreportedOwners.length ? { unreportedOwners } : {}),
      ...(releasedAssessmentClaims.length ? { releasedAssessmentClaims } : {}),
      claims,
      runs: this.db.prepare("SELECT request,generation,created FROM fleet_runs WHERE finished IS NULL ORDER BY created,id").all()
        .map(row => ({ ...JSON.parse(String(row.request)), generation: String(row.generation), created: Number(row.created) })),
    };
  }
}
