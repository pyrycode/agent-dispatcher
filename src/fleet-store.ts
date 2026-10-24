import {ReviewRetries,reviewRetryRequest,type ReviewRetryRequest} from './review-retry.js';
import { DeclarationRepairs, declarationRepairRequest, declarationCaptureFiles, type DeclarationRepairRequest } from './stage-declaration-repair.js';
import { ClaimsHistory, historyHash } from "./claims-history.js";
import { StageResults, stageBasis, type StagePlan, type StageSubmission } from "./stage-results.js";
import { PlanningSplits, type PlanningActor } from './planning-split.js';
import { RequiredRepairChildren, type RepairActor } from './required-repair-children.js';
import { RecoverySplits, renderRecoverySlice, splitBodyHash, splitRequirements, splitItemBasis, validateSplitAgainstTicket, validateRecoverySplit, type RecoverySplitRecord } from './recovery-split.js';
import {StorageMaintenance,type StorageRequest} from './storage-maintenance.js';
import { parseFeatureRoot } from './feature-lineage.js';
import {scrubCredentials} from './agent-runtime.js';
import { isRepairWip, recoveryAssignmentLabels } from "./recovery-labels.js";
import { PRIORITY_HIGH } from "./ticket-priority.js";
import { WorkflowStore, type WorkflowChange } from "./workflow-store.js";
// The one authority for fleet ownership. No heartbeat expires a claim or run.
// Keep this file on the claim server's local disk, never on a shared filesystem.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { RecoveryFacts, type PauseRecord, type EvidenceRecord, type CoordinationRecord } from "./recovery-facts.js";
import { RecoveryLedger, recoveryFingerprint, hasOperatorHold, validateObservations, IDLE_RECOVERY_REASONS, RECOVERY_UNKNOWN_PAUSE_REASON, type RecoveryObservation, type RecoveryDecision, type RecoveryIncident, type RecoveryLedgerOptions } from "./fleet-recovery.js";
import { OperationReports } from './operation-reports.js';
import { OrphanedTaskWatch } from './orphaned-tasks.js';
import {RecoveryTasks, assessmentTasks, recoveryTaskId, validateTaskRequest, type RecoveryTaskRequest, type RecoveryTaskResult} from './recovery-tasks.js';
import { currentWorkflow, recordRepairWorkflow, dispatcherRepairCap } from './recovery-repair-cap.js';
import {createHash} from 'node:crypto';
import {manifestHash, artifactManifest} from './recovery-artifacts.js';
import type { AgentRunner } from './agent-runner.js';
import { CAPABILITY_REPORT_FRESH_MS, missingCapabilities, ticketRequirements, validateCapabilityReport } from "./ticket-requirements.js";
import { DesiredStateStore, workRefusal, type DesiredCommand, type DesiredDocument, type DesiredPoll } from './desired-state.js';
import { CodexThrottle, startsCodex, DEFAULT_CODEX_THROTTLE, type CodexThrottleConfig, type CodexPauseState, type CodexSpacingState } from './codex-throttle.js';
import { FlakySightingLedger } from './flaky-sightings.js';
import { FLAKY_REOPEN_WINDOW_MS, FLAKY_TEST_COLUMN, FLAKY_TEST_LABEL, hasFlakyMarker, staleLabelsOnReopen } from './flaky-tickets.js';
import { inheritedMarker } from './inherited-tickets.js';
import {TestInvestigations} from './test-investigation.js';
import {ApprovalStates, type ApprovalOutcome} from './approval-state.js';
import {VerifierHandoffs, type VerifierHandoffRequest, type VerifierHandoff, type VerificationPin} from './verifier-handoff.js';
import type {EvidenceStore} from './evidence-store.js';
import {MachineRecoveries,validateMachineRecovery,type MachineRecoveryRequest,type MachineRecovery} from './machine-recovery.js';

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

/** Support task states that hold their ticket's own stages. */
export const OPEN_SUPPORT_TASK_STATES = ["queued", "running", "publishing", "attention"] as const;
/**
 * Admission refuses every stage of a numbered ticket except a recovery
 * assessment while a support task is open on it. The scheduler and the
 * manager's queue use this same test on the snapshot's openTaskTickets, so
 * they do not offer or report as eligible work the authority would refuse.
 * pyrycode-mobile #2442, 2026-10-23: shown eligible on two computers for a
 * day behind a queued support task no computer could run.
 */
export function supportTaskHolds(ticket: string, role: string, openTaskTickets: readonly string[]): boolean {
  return /#[1-9]\d*$/.test(ticket) && role !== "recovery" && openTaskTickets.includes(ticket);
}

export interface StartRequest {
  /** Issued only by atomic operator handoff admission. */
  verificationPin?: VerificationPin;
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
export interface FleetSnapshot { planningChildHolds?: Record<string, "planning-child-pending" | "creator-active">; machineRecoveries?: MachineRecovery[]; verifierHandoffs?: VerifierHandoff[]; workflowProjects?: string[]; claims: Claim[]; runs: FleetRun[]; runnerPolicy?: RunnerPolicy; idleRecoveryTickets?: string[]; priorityHighTickets?: string[]; releasedAssessmentClaims?: Claim[]; features?: {recoveryTasks:boolean; evidence?: boolean}; evidenceStore?: import("./evidence-store.js").EvidenceUsage; requiredRepairs?: Record<string,string[]>; codexPause?: CodexPauseState;
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
  readonly splits: RecoverySplits;
  readonly planningSplits: PlanningSplits;
  readonly requiredRepairChildren: RequiredRepairChildren;
  readonly workflow: WorkflowStore;
  readonly facts: RecoveryFacts;
  readonly operations: OperationReports;
  readonly tasks: RecoveryTasks;
  readonly orphans: OrphanedTaskWatch;
  readonly codex: CodexThrottle;
  /** The operator's central drains and stops per computer and board. See desired-state.ts. */
  readonly desired: DesiredStateStore;
  /** Every flaky-test sighting from every computer. See flaky-sightings.ts. */
  readonly flaky: FlakySightingLedger;
  readonly investigations: TestInvestigations;
  readonly approvals: ApprovalStates;
  readonly stages: StageResults;
  readonly declarationRepairs: DeclarationRepairs;
  readonly reviewRetries: ReviewRetries;
  readonly machineRecoveries: MachineRecoveries;
  readonly verifierHandoffs: VerifierHandoffs;
  readonly storage: StorageMaintenance;
  readonly history: ClaimsHistory;
  private readonly clock: () => number;
  constructor(path: string, private readonly limits: Readonly<Record<string, MachineLimits>>, options: FleetStoreOptions = {}) {
    for (const value of Object.values(limits)) validateLimits(value);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA auto_vacuum=INCREMENTAL;
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
      CREATE INDEX IF NOT EXISTS fleet_runs_ticket ON fleet_runs(ticket);
      CREATE TABLE IF NOT EXISTS fleet_locks (
        name TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES fleet_runs(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_runner_policy (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        runner TEXT CHECK(runner IS NULL OR runner IN ('claude','codex')),
        revision INTEGER NOT NULL CHECK(revision>0)
      ) STRICT;
    `);
    this.workflow = new WorkflowStore(this.db, options.now ?? Date.now);
    this.stages = new StageResults(this.db);
    this.declarationRepairs = new DeclarationRepairs(this.db);
    this.reviewRetries = new ReviewRetries(this.db);
    this.machineRecoveries = new MachineRecoveries(this.db);
    this.recovery = new RecoveryLedger(this.db, Date.now, options);
    this.facts = new RecoveryFacts(this.db);
    this.approvals = new ApprovalStates(this.db,options.now ?? Date.now);
    this.investigations = new TestInvestigations(this.db);
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
    this.verifierHandoffs = new VerifierHandoffs(this.db, this.clock);
    this.storage = new StorageMaintenance(this.db,this.clock);
    this.splits = new RecoverySplits(this.db);
    this.planningSplits = new PlanningSplits(this.db, this);
    this.requiredRepairChildren = new RequiredRepairChildren(this.db, this);
    this.codex = new CodexThrottle(this.db, clock, options.codexThrottle ?? DEFAULT_CODEX_THROTTLE, options.log);
    this.desired = new DesiredStateStore(this.db, Object.keys(limits), clock, machine => this.machineCapabilities()[machine]?.projects);
    this.flaky = new FlakySightingLedger(this.db, clock);
    this.history = new ClaimsHistory(this.db, ticket => this.ticketDone(ticket), clock);
  }
  close(): void { this.db.close(); }
  private storageBasis(request:StorageRequest,attesting=false):string {
    if(!Object.hasOwn(this.limits,request.machine))throw new Error('Unknown storage machine');
    const desired=this.desired.document(request.machine);
    const machine=desired.entries.find(e=>e.project==='*');
    if(request.kind==='native-task') {
      const task=this.tasks.get(request.taskId!);
      if(task.machine!==request.machine || task.ticket!==request.ticket || task.request.recipe!=='desktop-fake-suite'
        || !(task.state==='complete'&&task.result?.outcome==='completed' || task.state==='failed'&&task.result?.outcome==='failed') || task.artifactsPending || !task.artifacts
        || task.request.revision!==request.head || task.result.candidateRevision!==request.head
        || !request.path.endsWith('/'+task.id+'/desktop'))throw new Error('Native cleanup requires its exact completed published task and revision');
      if(manifestHash(task.artifacts)!==request.artifactDigest)throw new Error('Native cleanup published evidence differs');
      if(!attesting && !this.storage.attested(request)) {
        const file=task.artifacts.files.find(f=>f.path==='desktop/capture.json');
        if(!file)throw new Error('Native cleanup dependency reference has no published provenance');
        const data=Buffer.concat(file.chunks.map((_,part)=>Buffer.from(this.tasks.artifact(task.id,request.artifactDigest!,'desktop/capture.json',part).data,'base64')));
        if(JSON.parse(data.toString('utf8')).dependencyReferenceDigest!==request.referenceDigest)throw new Error('Native cleanup dependency reference requires a protected attestation');
      }
      if(this.snapshot().runs.some(r=>r.id===task.runId || r.supportTaskId===task.id))throw new Error('Native cleanup has active task custody');
      const project=task.ticket.split('#')[0];
      if(this.machineRecoveries.blocked(request.machine,project))throw new Error('Native cleanup preserves unreconciled stopped-worker evidence');
      if(!this.workflow.enabled(project)||this.workflow.preparing(project))throw new Error('Native cleanup requires active workflow authority');
      const item=this.workflow.get(task.ticket),approval=this.approvals.get(task.ticket);
      if(task.state==='failed' && (item.state!=='CLOSED'||item.status!=='Done'))throw new Error('Native cleanup retains failed evidence while its source remains unresolved');
      const incident=this.db.prepare('SELECT reason,decision,state FROM fleet_recovery WHERE ticket=? AND present=1').get(task.ticket);
      if(item.status==='Halted' || item.labels.some(l=>/^(needs-human:|health-hold:|held:|error:|wip:|needs-rework:|pending-done:|pending-verdict:|orchestrator:escalated)/.test(l)||l.includes('permission_denied'))
        || approval?.kind==='rejected'&&!approval.authorization
        || incident && (/Explicit operator hold|Denied permission|Pause origin unknown/.test(String(incident.reason)) || incident.state==='escalated' && incident.decision && JSON.parse(String(incident.decision)).category==='human')) throw new Error('Native cleanup preserves source holds and recovery attention');
      const owner=this.db.prepare('SELECT machine,generation FROM fleet_claims WHERE ticket=?').get(task.ticket)??null;
      // Drains stop admission. They do not prohibit reclaiming dependencies from
      // this published, drained task. They are still immutable in the basis.
      return JSON.stringify({desired,revision:item.revision,owner,task,incident:incident??null});
    }
    if(machine?.work && machine.work!=='taking')throw new Error('Storage maintenance respects machine drains');
    const runs=this.snapshot().runs;
    if(request.kind==='cache') {
      if(runs.some(r=>r.machine===request.machine))throw new Error('Cache maintenance requires an idle machine');
      if(this.tasks.list().some(t=>t.machine===request.machine && ['queued','running','publishing','attention'].includes(t.state)))throw new Error('Cache maintenance has unresolved support custody');
      return JSON.stringify({desired});
    }
    const ticket=request.ticket!,project=ticket.split('#')[0];
    if(this.machineRecoveries.blocked(request.machine,project))throw new Error('Storage cleanup preserves unreconciled stopped-worker evidence');
    if(!this.workflow.enabled(project)||this.workflow.preparing(project))throw new Error('Storage cleanup requires active workflow authority');
    if(this.desired.work(request.machine,project)!=='taking')throw new Error('Storage cleanup respects project controls');
    const item=this.workflow.get(ticket);
    if(item.state!=='CLOSED'||item.status!=='Done'||item.archived)throw new Error('Storage cleanup requires a completed known ticket');
    if(item.recoverySplit || (item.subIssues?.total??0)>0 || this.workflow.list(project).some(i=>i.parentNumber===item.issueNumber))throw new Error('Split parents are retained; closure does not complete their feature');
    if(item.labels.some(l=>/^(needs-human:|health-hold:|held:|error:|wip:|needs-rework:|pending-done:|pending-verdict:|orchestrator:escalated)/.test(l)||l.includes('permission_denied')))throw new Error('Storage cleanup preserves ticket holds and failed work');
    const approval=this.approvals.get(ticket);
    if(approval?.kind==='rejected'&&!approval.authorization)throw new Error('Storage cleanup preserves approval holds');
    if(runs.some(r=>r.ticket===ticket||r.parentTicket===ticket))throw new Error('Storage cleanup has an affected active worker');
    if(this.openTaskTickets().includes(ticket))throw new Error('Storage cleanup has unfinished support work');
    const owner=this.db.prepare('SELECT machine,generation FROM fleet_claims WHERE ticket=?').get(ticket)??null;
    return JSON.stringify({revision:item.revision,owner,desired});
  }
  acquireStorage(request:StorageRequest) {return this.transaction(()=>this.storage.acquire(request,()=>this.storageBasis(request)));}
  attestStorage(request:StorageRequest) {return this.transaction(()=>this.storage.attest(request,()=>this.storageBasis(request,true)));}
  verifyStorage(id:string,machine:string) {return this.transaction(()=>{const lease=this.storage.get(id);return this.storage.verify(id,machine,()=>this.storageBasis(lease));});}
  finishStorage(id:string,machine:string,drained:unknown,result:unknown) {return this.transaction(()=>this.storage.finish(id,machine,drained,result));}
  cancelStorage(request:StorageRequest,drained:unknown) {return this.transaction(()=>{
    if(!request||!Object.hasOwn(this.limits,request.machine))throw new Error('Unknown storage machine');
    return this.storage.cancel(request,drained);
  });}
  /** The authority's record of one run, finished or not. Evidence uploads are accepted only from its own computer. */
  runOwner(id: string): { machine: string; ticket: string; role: string } | undefined {
    const source=id.startsWith("acceptance:")?id.slice("acceptance:".length):id;
    if(source!==id && !this.stages.get(source))return undefined;
    const run = this.db.prepare("SELECT machine,ticket,request FROM fleet_runs WHERE id=?").get(source);
    if (!run) {
      const retired = this.db.prepare('SELECT machine,ticket,role FROM fleet_retired_runs WHERE id=?').get(source);
      return retired ? {machine: String(retired.machine), ticket: String(retired.ticket), role: String(retired.role)} : undefined;
    }
    let role = "unknown";
    try { role = String(JSON.parse(String(run.request)).role ?? "unknown"); } catch { /* an unreadable request still names its computer */ }
    return { machine: String(run.machine), ticket: String(run.ticket), role };
  }
  /** True for a Done or closed workflow ticket, false for an open one, undefined for one the workflow store does not hold. */
  ticketDone(ticket: string): boolean | undefined {
    let item;
    // Only an unknown ticket is unknown; any other failure says nothing and is rethrown.
    try { item = this.workflow.get(ticket); } catch (error) { if ((error as Error).message === "Unknown workflow ticket") return undefined; throw error; }
    // Replacement closure is not completion, and must not age out its failed evidence.
    if ((item as any).recoverySplit) return false;
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
      pause: this.facts.getPause(o.ticket), artifactRevision: this.artifactRevision(o.ticket),
      investigationRevision:this.investigations.pending(o.ticket)?.id })), this.snapshot()));
  }
  recoveryStep(machine: string, session: string, project: string, id: string, runId: string, step: "begin" | "decide" | "complete", decision?: RecoveryDecision) {
    const incident = this.recovery.incident(id);
    const run = this.snapshot().runs.find(r => r.id === runId);
    if (!run || run.project !== project || run.ticket !== incident.ticket || run.role !== "recovery" || run.resource !== "heavy") throw new Error("Recovery requires its admitted heavy run");
    this.authorize(machine, session, incident.ticket, runId);
    return this.transaction(() => {
      if (step === "begin") {
        const result=this.recovery.begin(id, runId);
        this.investigations.begin(incident.ticket,id);
        return result;
      }
      if (step === "decide") {
        const selected = this.recovery.decide(id, runId, decision!);
        if (selected.action === 'coordinate') {
          const task = this.tasks.request(incident.ticket, selected.task!,incident.id);
          if (task.request.recipe === 'dispatcher-repair') recordRepairWorkflow(this.db, task.id, task.ticket, currentWorkflow(this.db, task.ticket));
        }
        return selected;
      }
      if (step === "complete") {
        this.recovery.complete(id, runId);
        if(this.recovery.incident(id).decision?.action!=='coordinate') this.investigations.complete(id);
        return { ok: true };
      }
      throw new Error("Invalid recovery operation");
    });
  }

  /** An unstarted request has no worker whose stop needs confirmation. */
  cancelQueuedTask(id: string, reason: string) {
    if (!/^[a-f0-9]{64}$/.test(id) || typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new Error('Provide a task id and cancellation reason');
    return this.transaction(() => {
      const task=this.tasks.get(id);
      const summary='Withdrawn before it started by operator: '+scrubCredentials(reason.trim());
      if(task.state==='failed' && task.result?.summary===summary)return task;
      if(task.state!=='queued' || task.machine || task.session || task.runId || this.snapshot().runs.some(run=>run.supportTaskId===id))throw new Error('Only an unstarted queued task can be cancelled');
      this.db.prepare("UPDATE fleet_recovery_tasks SET state='failed',result=?,updated=? WHERE id=? AND state='queued'")
        .run(JSON.stringify({outcome:'failed',summary,files:{}}),this.clock(),id);
      return this.tasks.get(id);
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
    if(['builder','developer'].includes(run.role) && request?.recipe==='mobile-in-depth')
      throw new Error('Complete Mobile suites are dispatcher-owned; request an investigation with retained failure evidence');
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
  requestInvestigation(machine:string,session:string,project:string,runId:string,request:unknown,evidence?:Pick<EvidenceStore,'list'>) {
    const run=this.snapshot().runs.find(r=>r.id===runId && r.machine===machine && r.session===session && r.project===project);
    if(!run || !['builder','developer'].includes(run.role) || !/#[1-9]\d*$/.test(run.ticket))
      throw new Error('Investigation requires its admitted builder or developer');
    this.authorize(machine,session,run.ticket,runId);
    return this.transaction(()=>this.investigations.request(run.ticket,run.id,machine,request,evidence));
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

  declareRequiredRepairChildren(actor: RepairActor, ticket: string, input: unknown) {
    return this.transaction(() => this.requiredRepairChildren.finalize(actor, ticket, input));
  }
  finalizePlanningSplit(actor: PlanningActor, ticket: string, input: unknown) {
    return this.transaction(() => this.planningSplits.finalize(actor, ticket, input));
  }
  workflowChange(machine: string, session: string, runId: string | undefined, ticket: string, change: WorkflowChange, commandId: string, revision?: number) {
    return this.transaction(() => {
      this.authorizeWorkflow(machine, session, ticket, runId);
      if ((change.addLabels?.some(l => l === 'done:refiner' || l === 'done:po')
          || change.labels?.some(l => l === 'done:refiner' || l === 'done:po')
          || ['In Architecture', 'In Development'].includes(change.status ?? '')) && this.planningSplits.parentPending(ticket))
        throw new OwnershipRefusal('Unfinished planning split must finalize before the parent advances');
      const accepted=runId && this.stages.get(runId)?.acceptance;
      if(accepted && accepted.state!=="waiting" && (change.status!==undefined || change.state!==undefined || change.labels!==undefined || change.addLabels?.some(l=>/^(error:|done:|needs-rework:)/.test(l))))throw new Error("Accepted stage result cannot be overwritten by executor bookkeeping");
      if(runId && this.stages.get(runId) && (change.addLabels?.some(l=>l.startsWith("done:")) || change.labels?.some(l=>l.startsWith("done:")) || ["In Documentation","Done"].includes(change.status??""))) throw new Error("Contracted stage completion requires its structured result");
      return this.workflow.change(ticket, change, machine + ':' + session, commandId, revision);
    });
  }
  stagePlan(machine: string, session: string, ticket: string, runId: string, plan: StagePlan) {
    return this.transaction(() => {
      this.authorizeWorkflow(machine, session, ticket, runId);
      const run = this.snapshot().runs.find(r => r.id === runId);
      if (!run || run.ticket !== ticket || run.role !== (plan.kind === "verifier" ? "verifier" : "real-claude-gate")) throw new Error("Stage run does not match its plan");
      return this.stages.begin(ticket, runId, this.workflow.get(ticket), plan);
    });
  }
  stageResult(machine: string, session: string, ticket: string, runId: string, result: StageSubmission, evidence?: EvidenceStore) {
    return this.transaction(() => {
      const old = this.stages.get(runId);
      // Exact retries remain readable after execution and its ownership have ended.
      const owner = this.db.prepare("SELECT machine,session,ticket FROM fleet_runs WHERE id=?").get(runId);
      if (!owner || owner.machine !== machine || owner.session !== session || owner.ticket !== ticket) throw new Error("Stage result owner mismatch");
      if(old?.result)return this.stages.complete(runId,this.workflow.get(ticket),result,()=>{throw new Error("A saved result cannot be applied again");});
      this.authorizeWorkflow(machine, session, ticket, runId);
      const approval=this.approvals.get(ticket);
      if(approval?.kind==='rejected' && !approval.authorization)throw new Error("Stage result cannot bypass the recorded approval refusal");
      if(scrubCredentials(JSON.stringify(result))!==JSON.stringify(result))throw new Error("Stage result must be scrubbed before retention");
      const item = this.workflow.get(ticket);
      if(old?.plan.kind==="live-gate") {
        const receipt=JSON.parse(result.checks.find(c=>c.name==="live-acceptance")?.evidence??"null");
        for(const tracker of receipt?.acceptedInherited??[]) {
          const tracked=this.workflow.get(`${ticket.split("#")[0]}#${tracker.issue}`);
          if(tracked.state!=="OPEN" || !tracked.body.includes(inheritedMarker(tracker.name)))throw new Error("Accepted inherited failure has no current authoritative tracker");
        }
      }
      const record = this.stages.complete(runId, item, result, change =>
        this.workflow.change(ticket, change, "stage-result:" + runId, "stage-result:" + runId), files=>{
          if(!evidence)throw new Error("Shared evidence storage is unavailable");
          const id="acceptance:"+runId, contents=Object.fromEntries(files.map(f=>[f.name,f.text])), manifest=artifactManifest(contents);
          evidence.pinAcceptance(ticket);
          const upload=evidence.begin(machine,undefined,ticket,id,{kind:"gate",role:old!.plan.kind==="verifier"?"verifier":"real-claude-gate",outcome:"accepted-output",candidateRevision:result.candidate,startedAt:Date.now(),endedAt:Date.now()},manifest);
          for(const f of manifest.files){const data=Buffer.from(contents[f.path]);for(const part of upload.missing[f.path]??[])
            evidence.put(machine,undefined,ticket,id,upload.digest,f.path,part,data.subarray(part*manifest.chunkBytes,(part+1)*manifest.chunkBytes).toString("base64"));}
          evidence.commit(machine,undefined,ticket,id,upload.digest);
          return {runId:id,digest:upload.digest};
        });
      // An accepted PASS settles only the pending investigations it names
      // (Mobile #2526: an unsettled one diverted documentation into recovery).
      const named = record.plan.kind === "verifier" && record.acceptance?.state === "accepted" ? result.verdict?.investigations ?? [] : [];
      if (named.length) this.investigations.reconcile(ticket, { stageRunId: runId, candidate: record.plan.candidate, pullRequest: result.pullRequest!, decision: "PASS",
        verdictDigest: createHash("sha256").update(result.verdict!.body).digest("hex") }, named);
      return record;
    });
  }
  /** Operator-only: request a fresh verifier after the known failed-review retry refusal. */
  retryReview(value:ReviewRetryRequest) {
    const input=reviewRetryRequest(value);
    return this.transaction(()=>{
      const replay=this.reviewRetries.saved(input);
      if(replay)return replay;
      const item=this.workflow.get(input.ticket),stage=this.stages.records(input.ticket)[0];
      if(item.revision!==input.revision || item.state!=='OPEN' || item.status!=='In Code Review'
        || !item.labels.some(l=>l==='done:builder'||l==='done:developer')
        || item.labels.some(l=>/^(needs-human:|health-hold:|held:|error:|wip:|needs-rework:|pending-done:|pending-verdict:)/.test(l)
          || l.includes('permission_denied') || ['done:verifier','done:code-review','done:documentation'].includes(l))
        || item.blockedBy.some(b=>b.state==='OPEN'))throw new Error('Review retry requires the current unheld review-ready ticket');
      const approval=this.approvals.get(input.ticket);
      if(approval?.kind==='rejected' && !approval.authorization)throw new Error('Recorded approval rejection forbids review retry');
      if(!stage || stage.runId!==input.runId || stage.plan.kind!=='verifier' || stage.plan.candidate!==input.candidate
        || stage.result?.candidate!==input.candidate || stage.result.pullRequest!==input.pullRequest
        || stage.result.verdict?.decision!=='FAIL' || stage.acceptance?.state!=='rework'
        || stage.basis!==stageBasis(item))throw new Error('Latest failed review or its requirements changed');
      const incident=this.recovery.list(input.ticket.split("#")[0]).find(i=>i.id===input.incidentId);
      if(!incident || incident.ticket!==input.ticket || !incident.current || incident.state!=='escalated'
        || incident.reason!=='Repeated review rework' || incident.decision?.action!=='escalate'
        || incident.decision.category!=='human' || !incident.decision.reason.startsWith('Retry must target the failed current stage. '))
        throw new Error('Review retry requires the exact refused review handback incident');
      const source=this.db.prepare('SELECT request,machine,generation,finished,outcome FROM fleet_runs WHERE id=? AND ticket=?').get(input.runId,input.ticket);
      const assessment=this.db.prepare('SELECT request,finished,outcome FROM fleet_runs WHERE id=? AND ticket=?').get(incident.runId,input.ticket);
      const claim=this.db.prepare('SELECT machine,generation FROM fleet_claims WHERE ticket=?').get(input.ticket);
      if(!source || source.finished==null || source.outcome!=='completed' || JSON.parse(String(source.request)).role!=='verifier'
        || !assessment || assessment.finished==null || assessment.outcome!=='completed' || JSON.parse(String(assessment.request)).role!=='recovery'
        || !claim || claim.machine!==source.machine || claim.generation!==source.generation)
        throw new Error('Review and assessment must be finished with unchanged source ownership');
      if(this.snapshot().runs.some(r=>r.ticket===input.ticket || r.parentTicket===input.ticket)
        || this.openTaskTickets().includes(input.ticket))throw new Error('Review retry has active or uncertain work');
      const changed=this.workflow.change(input.ticket,{addLabels:recoveryAssignmentLabels('retry'),removeLabels:['orchestrator:escalated']},
        'review-retry:'+input.runId,'review-retry:'+input.commandId,input.revision);
      this.workflow.comment(input.ticket,`## Operator review retry

${input.reason}

Request a fresh independent verifier of candidate ${input.candidate} after failed review ${input.runId}. The previous FAIL and its evidence remain unchanged. Normal approval, admission and configured acceptance checks remain required.`,
        'review-retry-comment:'+input.commandId);
      this.recovery.retireReviewRetry(input.incidentId);
      return this.reviewRetries.save(input,changed);
    });
  }
  repairStageDeclaration(value: DeclarationRepairRequest, evidence?: EvidenceStore) {
    const input = declarationRepairRequest(value);
    return this.transaction(() => {
      const replay = this.declarationRepairs.saved(input);
      if (replay) return replay;
      const item = this.workflow.get(input.ticket), stage = this.stages.records(input.ticket)[0];
      if (item.revision !== input.revision || item.state !== 'OPEN'
        || !item.labels.includes('held:stage-result') || !item.labels.includes('needs-live-artifacts'))
        throw new Error('Declaration repair requires the current open declaration hold');
      if (!stage || stage.runId !== input.runId || stage.plan.kind !== 'live-gate' || stage.plan.candidate !== input.candidate
        || !stage.artifactsRequired || stage.plan.artifacts.length || !stage.result
        || stage.acceptance?.state !== 'waiting' || stage.acceptance.reason !== 'Required capture outputs have not been declared in the stage plan')
        throw new Error('Latest stage is not a terminal undeclared-capture wait');
      if (stage.basis !== stageBasis({ ...item, labels: item.labels.filter(l => !/^(held:|needs-human:)/.test(l)) }))
        throw new Error('Stage requirements changed before declaration repair');
      const source = this.db.prepare('SELECT request,machine,generation,finished,outcome FROM fleet_runs WHERE id=? AND ticket=?').get(input.runId, input.ticket);
      const claim = this.db.prepare('SELECT machine,generation FROM fleet_claims WHERE ticket=?').get(input.ticket);
      if (!source || source.finished == null || source.outcome !== 'completed' || JSON.parse(String(source.request)).role !== 'real-claude-gate'
        || !claim || claim.machine !== source.machine || claim.generation !== source.generation)
        throw new Error('Source execution has not ended with unchanged ownership');
      if (this.snapshot().runs.some(r => r.ticket === input.ticket || r.parentTicket === input.ticket)
        || this.openTaskTickets().includes(input.ticket)) throw new Error('Declaration repair has active or uncertain work');
      const approval = this.approvals.get(input.ticket);
      if (approval?.kind === 'rejected' && !approval.authorization) throw new Error('Recorded approval rejection forbids declaration repair');
      declarationCaptureFiles(input, stage, String(source.machine), evidence);
      const changed = this.workflow.change(input.ticket, { status: 'In Development',
        removeLabels: ['held:stage-result', 'done:builder', 'done:verifier'] }, 'declaration-repair:' + input.runId,
        'declaration-repair:' + input.commandId, input.revision);
      evidence!.pinAcceptance(input.ticket);
      return this.declarationRepairs.save(input, changed);
    });
  }
  authorizeWorkflow(machine:string,session:string,ticket:string,runId?:string):void {
    if(runId && !this.db.prepare('SELECT 1 FROM fleet_runs WHERE id=? AND machine=? AND session=? AND finished IS NULL').get(runId,machine,session)) throw new OwnershipRefusal('Workflow run has finished or lost ownership');
    this.authorize(machine,session,ticket,runId);
  }
  workflowComment(machine:string,session:string,runId:string|undefined,ticket:string,body:string,id:string):void {
    this.transaction(()=>{this.authorizeWorkflow(machine,session,ticket,runId);this.workflow.comment(ticket,body,id);});
  }
  /** A parent planner may add its child to an existing cross-project dependent.
   * This never grants general authority or changes the dependent's claim. */
  private splitDependent(machine: string, session: string, runId: string | undefined, project: string, ticket: string) {
    const row = runId && this.db.prepare("SELECT ticket,request FROM fleet_runs WHERE id=? AND machine=? AND session=? AND finished IS NULL").get(runId, machine, session);
    if (!row) throw new OwnershipRefusal("Split handoff requires an active planning run");
    const run = JSON.parse(String(row.request)) as StartRequest;
    if (run.project !== project || !["refiner", "po"].includes(run.role))
      throw new OwnershipRefusal("Split handoff requires the parent planning run");
    const parent = this.workflow.get(String(row.ticket));
    this.authorizeWorkflow(machine, session, String(row.ticket), runId);
    const target = this.workflow.get(ticket);
    const has = (url: string) => target.blockedBy.some(b => b.url === url);
    if (ticket.split("#")[0] === project || target.state !== "OPEN" || !has(parent.url))
      throw new OwnershipRefusal("Split handoff requires an existing foreign dependent of the parent");
    if (this.db.prepare("SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NULL").get(ticket))
      throw new OwnershipRefusal("Split dependent has an active run");
    return { target, children: this.workflow.list(project).filter(i => i.parentNumber === parent.issueNumber) };
  }
  workflowSplitDependency(machine: string, session: string, runId: string | undefined, project: string, ticket: string, childTicket: string) {
    return this.transaction(() => {
      const { target, children } = this.splitDependent(machine, session, runId, project, ticket);
      const child = children.find(i => `${project}#${i.issueNumber}` === childTicket);
      if (!child) throw new OwnershipRefusal("Split dependency must be a child of the admitted parent");
      return this.workflow.change(ticket, { blockedBy: [
        ...target.blockedBy.filter(b => b.url !== child.url),
        { number: child.issueNumber, state: child.state, url: child.url },
      ] }, machine + ':' + session, randomUUID());
    });
  }
  workflowSplitComment(machine: string, session: string, runId: string | undefined, project: string, ticket: string, body: string, id: string) {
    this.transaction(() => {
      const { target, children } = this.splitDependent(machine, session, runId, project, ticket);
      if (!children.some(child => target.blockedBy.some(b => b.url === child.url)))
        throw new OwnershipRefusal("Split handoff comment requires the transferred child dependency");
      this.workflow.comment(ticket, body, id);
    });
  }
  /** Record flaky-test sightings from `machine` and count them (flaky-sightings.ts). */
  flakySightings(machine: string, project: unknown, sightings: unknown) {
    if (!Object.hasOwn(this.limits, machine)) throw new Error("Unknown machine");
    return this.transaction(() => this.flaky.record(machine, project, sightings));
  }
  /**
   * A gate run's write on a failure tracker the pipeline filed
   * (flaky-tickets.ts, inherited-tickets.ts): an occurrence comment on an
   * open tracker, or a reopen of a closed one into Backlog with its stale
   * stage labels dropped and the comment added, in one transaction.
   *
   * Such a tracker usually belongs to another computer, the one that filed or
   * fixed it, and a closed ticket keeps its claim, so the ordinary ownership
   * check would refuse every computer but that one. This write is narrower
   * instead: the caller must hold an active run, the ticket must carry the
   * kind's label and name one of the tests on its own marker line, and no
   * other run may be active on the ticket. A reopen also needs the ticket to
   * have closed inside the reopen window, when its closing is recorded here.
   *
   * A reopen is new work, so it releases the closed ticket's claim, when no
   * support task is open on it, and the next free capable computer takes it.
   * Kept, the claim would hold it for a computer that may be drained or gone.
   */
  flakyTrack(machine: string, session: unknown, project: unknown, input: any): { ticket: string; state: string; status: string; revision: number } {
    if (!Object.hasOwn(this.limits, machine)) throw new Error("Unknown machine");
    if (typeof project !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(project)) throw new Error("Tracker writes require a project");
    if (typeof session !== "string" || !session) throw new Error("Tracker writes require a session");
    const { ticket, kind, tests, comment, reopen, top, commandId, runId } = input ?? {};
    if (typeof ticket !== "string" || !ticket.startsWith(`${project}#`) || !/^[1-9]\d*$/.test(ticket.slice(project.length + 1))) throw new Error("Invalid tracker ticket");
    if (kind !== "flaky" && kind !== "inherited") throw new Error("Invalid tracker kind");
    if (!Array.isArray(tests) || tests.length === 0 || tests.length > 100 || tests.some((t: unknown) => typeof t !== "string" || !t || t.length > 2000)) throw new Error("Invalid tracker tests");
    if (typeof comment !== "string" || !comment.trim() || comment.length > 60_000) throw new Error("Invalid tracker comment");
    if (typeof reopen !== "boolean" || (top !== undefined && typeof top !== "boolean")) throw new Error("Invalid tracker change");
    if (typeof commandId !== "string" || !/^[\w.:-]{1,200}$/.test(commandId)) throw new Error("Invalid tracker command");
    if (typeof runId !== "string" || !runId) throw new OwnershipRefusal("Tracker writes require an admitted run");
    if (!this.workflow.enabled(project)) throw new Error("Workflow not enabled for this project");
    return this.transaction(() => {
      const run = this.db.prepare("SELECT request FROM fleet_runs WHERE id=? AND machine=? AND session=? AND finished IS NULL").get(runId, machine, session);
      if (!run || (JSON.parse(String(run.request)) as StartRequest).project !== project) throw new OwnershipRefusal("Workflow run has finished or lost ownership");
      const summary = () => { const i = this.workflow.get(ticket); return { ticket, state: i.state, status: i.status, revision: i.revision }; };
      // A retry of a reopen that already landed answers as it did.
      const replay = reopen ? this.db.prepare("SELECT ticket FROM workflow_commands WHERE id=?").get(commandId) : undefined;
      if (replay && replay.ticket !== ticket) throw new Error("Workflow command identity reused");
      if (replay) return summary();
      const item = this.workflow.get(ticket);
      const label = kind === "flaky" ? FLAKY_TEST_LABEL : "bug";
      const named = (tests as string[]).some(t => kind === "flaky" ? hasFlakyMarker(item.body, t)
        : item.body.split("\n").some(line => line.trim() === inheritedMarker(t)));
      if (!item.labels.includes(label) || !named) throw new Error("Not a tracker the pipeline filed for these tests");
      // The caller's own run on the tracker, such as the tracker's own verifier, may write it.
      const active = this.db.prepare("SELECT id,machine,session FROM fleet_runs WHERE ticket=? AND finished IS NULL").get(ticket);
      if (active && (active.id !== runId || active.machine !== machine || active.session !== session)) throw new OwnershipRefusal("Ticket has an active run");
      if (reopen) {
        if (item.state !== "CLOSED") throw new Error("Tracker is already open");
        const closed = this.db.prepare("SELECT at FROM workflow_events WHERE ticket=? AND json_extract(change,'$.state')='CLOSED' ORDER BY id DESC LIMIT 1").get(ticket);
        if (closed && Number(closed.at) < this.clock() - FLAKY_REOPEN_WINDOW_MS) throw new Error("Tracker closed outside the reopen window");
        const stale = staleLabelsOnReopen(item.labels);
        this.workflow.change(ticket, { state: "OPEN", status: FLAKY_TEST_COLUMN, ...(stale.length ? { removeLabels: stale } : {}), ...(top ? { top: true } : {}) },
          `flaky:${machine}:${session}`, commandId);
        if (!active && !this.db.prepare("SELECT 1 FROM fleet_recovery_tasks WHERE ticket=? AND state IN ('queued','running','publishing','attention')").get(ticket))
          this.db.prepare("DELETE FROM fleet_claims WHERE ticket=?").run(ticket);
      } else if (item.state !== "OPEN") throw new Error("Tracker is closed");
      this.workflow.comment(ticket, comment, `flaky-${commandId}`);
      return summary();
    });
  }
  workflowOperator(ticket: string, change: WorkflowChange, commandId: string, revision: number) {
    return this.transaction(() => {
      if (!Number.isSafeInteger(revision)) throw new Error('Expected workflow revision required');
      if (this.snapshot().runs.some(r=>r.ticket===ticket)) throw new Error('Ticket has an active reservation; drain it before changing workflow');
      const before = this.workflow.get(ticket);
      const result = this.workflow.change(ticket, change, 'operator', commandId, revision);
      const current = this.workflow.get(ticket);
      const releasesHold = hasOperatorHold(change.removeLabels ?? [])
        || change.labels !== undefined && hasOperatorHold(before.labels) && !hasOperatorHold(current.labels);
      // A saved command replay must not retire a later hold. Reconcile only
      // this exact ticket after an effective, revision-checked operator release.
      if (releasesHold && current.revision !== before.revision) {
        this.recovery.releaseOperatorHold({ ticket, status: current.status, labels: current.labels,
          blocked: current.blockedBy.some(b => b.state === 'OPEN'), pause: this.facts.getPause(ticket) });
      }
      return result;
    });
  }
  recordApprovalOutcome(machine:string,session:string,project:string,runId:string,ticket:string,outcome:ApprovalOutcome) {
    return this.transaction(()=>{
      const run=this.snapshot().runs.find(r=>r.id===runId && r.machine===machine && r.session===session && r.project===project && r.ticket===ticket);
      if(!run || !/#[1-9]\d*$/.test(ticket)) throw new Error('Approval outcome requires its admitted source run');
      this.authorize(machine,session,ticket,runId);
      return this.approvals.record(ticket,runId,run.role,outcome) ?? null;
    });
  }
  authorizeApproval(ticket:string,runId:string,commandId:string,reason:string,revision:number) {
    return this.transaction(()=>{
      const record=this.approvals.authorize(ticket,runId,commandId,reason);
      const change={
        removeLabels:[`error:${record.role}`,'orchestrator:escalated'],addLabels:['orchestrator:recovery-priority'],
      };
      // Recover a lost acknowledgement after the replacement has started.
      // change() verifies every original argument before returning its saved result.
      const replay=this.db.prepare('SELECT 1 FROM workflow_commands WHERE id=?').get(commandId);
      const item=replay ? this.workflow.change(ticket,change,'operator',commandId,revision)
        : this.workflowOperator(ticket,change,commandId,revision);
      return {approval:record,item};
    });
  }
  /** The final step of an operator filing. A retry hours later must not overwrite a running ticket. */
  workflowFile(id: string, ticket: string, change: WorkflowChange) {
    return this.transaction(() => {
      if (this.snapshot().runs.some(r=>r.ticket===ticket)) throw new Error('Ticket has an active reservation; drain it before changing workflow');
      return this.workflow.completeFiling(id, ticket, change);
    });
  }
  /** The full lineage is resolved once before a recovery split and kept on every child. */
  recoveryFeatureRoot(ticket: string): string {
    const project = ticket.split('#')[0];
    let item = this.workflow.get(ticket);
    const seen = new Set<number>();
    for (;;) {
      const explicit = item.featureRoot ?? parseFeatureRoot(item.body, project);
      if (explicit) return explicit;
      if (seen.has(item.issueNumber)) throw new Error('Cyclic feature lineage');
      seen.add(item.issueNumber);
      if (!item.parentNumber) return `${project}#${item.issueNumber}`;
      try { item = this.workflow.get(`${project}#${item.parentNumber}`); }
      catch (error) {
        if ((error as Error).message !== 'Unknown workflow ticket') throw error;
        throw new Error('Original feature-root lineage is incomplete; inspect the actual parent chain before splitting');
      }
    }
  }
  /** No workflow or GitHub mutation is authorised while any affected worker is active. */
  private guardRecoverySplit(record: RecoverySplitRecord, allowedRun?: string): void {
    const affected = new Set([...Object.keys(record.affected), ...Object.values(record.children)]);
    if (this.verifierHandoffs.pending().some(h => h.expires > this.clock() && affected.has(h.ticket)))
      throw new Error('An affected verifier handoff is pending; cancel it or wait for expiry before splitting');
    const incident = this.recovery.incident(record.id);
    const source = incident.runId && this.runOwner(incident.runId);
    for (const run of this.snapshot().runs) {
      const task = run.supportTaskId ? this.tasks.get(run.supportTaskId) : undefined;
      if (run.id !== allowedRun && (affected.has(run.ticket) || !!run.parentTicket && affected.has(run.parentTicket) || !!task && affected.has(task.ticket)))
        throw new Error('An affected ticket or support worker is running; drain it before splitting');
    }
    for (const [ticket, basis] of Object.entries(record.affected)) {
      const item = this.workflow.get(ticket);
      const claim = this.snapshot().claims.find(c => c.ticket === ticket);
      if ((claim ? `${claim.machine}:${claim.generation}` : null) !== record.owners[ticket]) throw new OwnershipRefusal('Affected ownership changed; preserve partial recovery work');
      if (this.tasks.list(ticket).some(task=>['queued','running','publishing','attention'].includes(task.state))) throw new Error('An affected support task remains pending; preserve its recovery before splitting');
      if (splitItemBasis(item) !== basis) throw new Error('Affected workflow changed; preserve the partial split and reassess before continuing');
      if (item.labels.some(l => l.startsWith('needs-human:') && l !== 'needs-human:sizing' || l.startsWith('health-hold:') || l.startsWith('held:') || l.includes('permission_denied'))
        || item.status === 'Halted' || this.approvals.get(ticket)?.kind === 'rejected' && !this.approvals.get(ticket)?.authorization)
        throw new Error('Recovery split cannot override a hold or approval rejection');
      const owner = this.snapshot().claims.find(c => c.ticket === ticket)?.machine ?? (source ? source.machine : undefined);
      if (!owner || this.desired.work(owner, ticket.split('#')[0]) !== 'taking') throw new Error('Recovery split preserves operator drains and stops');
    }
  }
  prepareRecoverySplit(id: string, actor?: {machine:string;session:string;runId:string}): RecoverySplitRecord {
    return this.transaction(() => {
      const incident = this.recovery.incident(id);
      if (incident.decision?.action !== 'split') throw new Error('A retained recovery split decision is required');
      if (actor) {
        const run = this.snapshot().runs.find(r => r.id === actor.runId && r.ticket === incident.ticket && r.role === 'recovery');
        if (!run || incident.runId !== run.id) throw new OwnershipRefusal('Split requires its admitted recovery assessment');
        this.authorizeWorkflow(actor.machine,actor.session,incident.ticket,actor.runId);
      }
      const old = this.splits.get(id);
      if (old?.state === 'complete') return old;
      const project = incident.ticket.split('#')[0], item = this.workflow.get(incident.ticket);
      const plan = validateRecoverySplit(incident.decision.split);
      if (!old && recoveryFingerprint({ticket:incident.ticket,status:item.status,labels:item.labels,blocked:item.blockedBy.some(b=>b.state==='OPEN'),evidenceRevision:item.evidenceRevision,artifactRevision:this.artifactRevision(incident.ticket),pause:this.facts.getPause(incident.ticket),investigationRevision:this.investigations.pending(incident.ticket)?.id}) !== incident.fingerprint)
        throw new Error('Recovery evidence or workflow changed after assessment; retain the decision and reassess before splitting');
      validateSplitAgainstTicket(plan,item,this.recoveryFeatureRoot(incident.ticket));
      if (!old && this.workflow.list(project).some(i => i.parentNumber === item.issueNumber)) throw new Error('The parent already has children; resume its existing split');
      const all = this.workflow.projects().flatMap(p => this.workflow.list(p.project));
      const affected = new Set([item.url]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of all) {
          const parentUrl = `https://github.com/${candidate.url.match(/github.com\/([^/]+\/[^/]+)\/issues\//)?.[1]}/issues/${candidate.parentNumber}`;
          if (!affected.has(candidate.url) && (affected.has(parentUrl) || candidate.state === 'OPEN' && candidate.blockedBy.some(b => !!b.url && affected.has(b.url)))) { affected.add(candidate.url); changed = true; }
        }
      }
      if (old) {
        for (const candidate of all.filter(i=>affected.has(i.url))) {
          const reference = candidate.url.replace('https://github.com/','').replace('/issues/','#');
          const provisional = plan.children.some(c=>this.workflow.filingMatches(`recovery-split:${id}:${c.key}`,candidate.issueId));
          if (!Object.hasOwn(old.affected,reference) && !Object.values(old.children).includes(reference) && !provisional) {
            if (candidate.parentNumber === item.issueNumber) throw new Error('Another child appeared during recovery; preserve both split records for operator assessment');
            const claim=this.snapshot().claims.find(c=>c.ticket===reference);
            this.splits.enlist(id,reference,splitItemBasis(candidate),claim?`${claim.machine}:${claim.generation}`:null);
          }
        }
      }
      const record = this.splits.prepare(id,incident.ticket,plan,all.filter(i => affected.has(i.url)),project,Object.fromEntries(all.filter(i => affected.has(i.url)).map(i=>{const ref=i.url.replace('https://github.com/','').replace('/issues/','#');const claim=this.snapshot().claims.find(c=>c.ticket===ref);return [ref,claim?`${claim.machine}:${claim.generation}`:null];})));
      this.guardRecoverySplit(record,actor?.runId);
      return record;
    });
  }
  checkRecoverySplit(id: string, actor?: {machine:string;session:string;runId:string}): RecoverySplitRecord {
    const record = this.prepareRecoverySplit(id,actor);
    if (record.state !== 'complete') this.guardRecoverySplit(record,actor?.runId);
    return record;
  }
  recordRecoveryChild(id: string, key: string, ticket: string): void {
    this.transaction(() => {
      const record = this.splits.get(id)!;
      if (!record.plan.children.some(c => c.key === key)) throw new Error('Unexpected recovery child');
      const child = this.workflow.get(ticket);
      const slice = record.plan.children.find(c=>c.key===key)!;
      const parent = this.workflow.get(record.ticket);
      const expectedBody = renderRecoverySlice(record.plan,parent.issueNumber,slice)+`\n\n<!-- orchestrator-filing:recovery-split:${id}:${key} -->`;
      const expectedLabels = parent.labels.filter(l=>! /^(wip:|done:|error:|error-retry-count:|rework-count:|needs-rework:|claim:|orchestrator:|needs-human:)/.test(l)).sort();
      if (child.body !== expectedBody || child.title !== slice.title || JSON.stringify([...child.labels].sort()) !== JSON.stringify(expectedLabels))
        throw new Error('Recovery child content changed before binding; preserve its original acceptance and partial evidence');
      if (child.state !== 'OPEN' || child.status !== 'Inbox' || !child.blockedBy.some(b => b.url === this.workflow.get(record.ticket).url && b.state === 'OPEN'))
        throw new Error('Partial recovery children must remain blocked by the open parent');
      this.splits.child(id,key,ticket);
      record.affected[ticket] = splitItemBasis(child);
      this.splits.bindChild(id,ticket,splitItemBasis(child));
    });
  }
  completeRecoverySplit(id: string, actor?: {machine:string;session:string;runId:string}): RecoverySplitRecord {
    return this.transaction(() => {
      const record = this.checkRecoverySplit(id,actor);
      if (record.state === 'complete') return record;
      const parent = this.workflow.get(record.ticket), project = record.ticket.split('#')[0];
      if (record.plan.children.some(c => !record.children[c.key])) throw new Error('All recovery children must exist before activation');
      const children = record.plan.children.map(c => ({slice:c,ticket:record.children[c.key],item:this.workflow.get(record.children[c.key])}));
      for (const {item} of children) if (item.status !== 'Inbox' || item.state !== 'OPEN' || item.labels.some(l => l.startsWith('needs-human:') && l !== 'needs-human:sizing')) throw new Error('Partial child workflow changed; preserve it for operator assessment');
      let after = parent.id;
      const common = parent.labels.filter(l => !/^(wip:|done:|error:|error-retry-count:|rework-count:|needs-rework:|claim:|orchestrator:)/.test(l) && l !== 'needs-human:sizing');
      for (const {slice,ticket,item} of children) {
        // All children wait for prior siblings, including shared insertion points, and inherit causal dependencies.
        const earlier = children.slice(0,children.findIndex(c => c.ticket === ticket));
        this.workflow.change(ticket,{status:'Backlog',addLabels:common,blockedBy:[...parent.blockedBy,...earlier.map(c => ({number:c.item.issueNumber,state:c.item.state,url:c.item.url}))],afterItemId:after},'recovery-split',`${id}:activate:${slice.key}`,item.revision);
        this.workflow.recoveryMetadata(ticket,{featureRoot:record.plan.featureRoot,parentNumber:parent.issueNumber,grandparentNumber:parent.parentNumber,
          recoverySlice:{id,featureRoot:record.plan.featureRoot,behaviours:record.plan.behaviours.filter(b=>b.child===slice.key).map(b=>b.description.replace(/\s+/g,' ').trim())}});
        this.workflow.comment(ticket,`Recovery split from ${record.ticket}. Feature root: ${record.plan.featureRoot}.\n\nResult: ${slice.outcome}\n\nVerification: ${slice.checks.join('; ')}\n\nPreserved work to reuse: ${slice.reuse.join('; ') || 'Inspect the retained parent branches, commits, reviews and evidence before implementation.'}\n\nUnresolved findings: ${record.plan.findings.filter(f=>f.child===slice.key).map(f=>`${f.id}: ${f.description}`).join('; ')}\n\nEvery normal security review and acceptance gate still applies.`,`${id}:brief:${slice.key}`);
        after = item.id;
      }
      for (const ticket of Object.keys(record.affected).filter(t => t !== record.ticket && !Object.values(record.children).includes(t))) {
        const dependent = this.workflow.get(ticket);
        if (!dependent.blockedBy.some(b => b.url === parent.url)) continue;
        this.workflow.change(ticket,{blockedBy:[...dependent.blockedBy,...children.map(c=>({number:c.item.issueNumber,state:c.item.state,url:c.item.url}))]},'recovery-split',`${id}:dependent:${ticket}`,dependent.revision);
      }
      this.workflow.recoveryMetadata(record.ticket,{featureRoot:record.plan.featureRoot,recoverySplit:{id,featureRoot:record.plan.featureRoot,children:children.map(c=>c.ticket),state:'replaced'}});
      this.workflow.comment(record.ticket,`Replaced by recovery split. Feature ${record.plan.featureRoot} remains incomplete until its required leaf results merge and pass all acceptance.\n\nReason another split was justified: ${record.plan.justification}\n\nSmaller independently verifiable result: ${record.plan.smallerResult}\n\nChildren: ${children.map(c=>c.ticket).join(', ')}\n\nAll original commits, branches, reviews and failed evidence are retained. No requirement was removed.\n\nRequirement and finding allocation:\n${JSON.stringify({requirements:record.plan.requirements,findings:record.plan.findings,behaviours:record.plan.behaviours,evidence:record.plan.evidence},null,2)}`,`${id}:replacement`);
      this.workflow.change(record.ticket,{status:'Done',state:'CLOSED'},'recovery-split',`${id}:replace`,this.workflow.get(record.ticket).revision);
      this.splits.complete(id);
      this.db.prepare("UPDATE fleet_recovery SET state='complete',updated=? WHERE id=?").run(this.clock(),id);
      return this.splits.get(id)!;
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
      const investigation=this.investigations.pending(ticket);
      return {ticket,pause:this.facts.getPause(ticket),approvalState:this.approvals.get(ticket),artifactRevision:this.artifactRevision(ticket),evidence:evidence.filter(e=>e.ticket===ticket),capabilities:this.tasks.capabilities(),
        ...(investigation?{investigation}:{}),
        ...(ticket === diagnosticTicket ? {splitContext: (()=>{try {const item=this.workflow.get(ticket);return {featureRoot:this.recoveryFeatureRoot(ticket),bodyHash:splitBodyHash(item.body),requirements:splitRequirements(item.body),priorBehaviours:(item as any).recoverySlice?.behaviours};}catch(error){return {unavailable:(error as Error).message};}})()} : {}),
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
    const run = this.snapshot().runs.find(r => r.id === runId && r.machine === machine && r.session === session);
    if (run && ['refiner', 'po'].includes(run.role)) this.planningSplits.holdChild(issueId, run.ticket);
  }

  private transactionDepth = 0;
  private transaction<T>(work: () => T): T {
    if(this.transactionDepth) return work();
    this.db.exec("BEGIN IMMEDIATE");this.transactionDepth++;
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally {this.transactionDepth--;}
  }

  private verifierHandoffValid(h: VerifierHandoffRequest): boolean {
    if(this.splits.pending(h.ticket)) return false;
    const claim=this.db.prepare('SELECT * FROM fleet_claims WHERE ticket=?').get(h.ticket);
    if(!claim || claim.machine!==h.source || claim.generation!==h.generation) return false;
    if(this.db.prepare('SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NULL').get(h.ticket)) return false;
    if(!this.workflow.reviewReadyTickets().includes(h.ticket)) return false;
    const item=this.workflow.get(h.ticket);
    if(item.revision!==h.revision || this.workflow.preparing('pyrycode/pyrycode-desktop')) return false;
    if(this.tasks.list(h.ticket).some(t=>t.artifactsPending || ['queued','running','publishing','attention'].includes(t.state))) return false;
    const approval=this.approvals.get(h.ticket);
    if(approval?.kind==='rejected' && !approval.authorization) return false;
    for(const machine of [h.source,h.target]) {
      if(!Object.hasOwn(this.limits,machine)) return false;
      if(workRefusal(p=>this.desired.work(machine,p),{project:'pyrycode/pyrycode-desktop',ticket:h.ticket,role:'verifier'},machine===h.source)) return false;
      const report=this.machineCapabilities()[machine];
      if(!report || this.clock()-report.updated>CAPABILITY_REPORT_FRESH_MS || !report.projects?.includes('pyrycode/pyrycode-desktop')) return false;
    }
    return !missingCapabilities(this.requirementsOf(h.ticket),this.reportedCapabilities(h.target)).length;
  }
  activeVerifierHandoffs(): VerifierHandoff[] {return this.verifierHandoffs.active(h=>this.verifierHandoffValid(h));}
  requestVerifierHandoff(input: VerifierHandoffRequest): VerifierHandoff {
    return this.transaction(()=>this.verifierHandoffs.request(input,()=>{
      this.activeVerifierHandoffs();
      if(!this.verifierHandoffValid(input))throw new Error('Handoff requires unchanged ready workflow, idle source ticket, fresh capable hosts and taking target');
    }));
  }
  cancelVerifierHandoff(id:string):VerifierHandoff {return this.transaction(()=>this.verifierHandoffs.cancel(id));}
  confirmVerifierHandoff(machine:string,id:string,session:string,target?:StartRequest,evidence?:Pick<EvidenceStore,'list'>):VerifierHandoff {
    return this.transaction(()=>{
      const h=this.verifierHandoffs.get(id);
      if(!session || session.length>200 || ![h.source,h.target].includes(machine))throw new Error('Handoff actor mismatch');
      if(h.state==='admitted'||h.state==='accepted') {
        if(machine!==h.target || target?.id!==h.runId)throw new Error('Handoff already admitted');
        return h;
      }
      if(!this.activeVerifierHandoffs().some(r=>r.commandId===id))throw new Error('Handoff is no longer pending');
      if(machine===h.source){
        if(target)throw new Error('Source cannot choose target admission');
        const builder=this.db.prepare("SELECT id,outcome FROM fleet_runs WHERE ticket=? AND machine=? AND generation=? AND json_extract(request,'$.role')='builder' ORDER BY created DESC,rowid DESC LIMIT 1").get(h.ticket,h.source,h.generation);
        if(!builder || builder.outcome!=='completed' || !evidence?.list(h.ticket,String(builder.id)).some(b=>b.machine===h.source && b.role==='builder' && b.meta.outcome==='completed' && b.meta.candidateRevision===h.candidate))throw new Error('Latest builder evidence must cover the exact handoff candidate');
        return this.verifierHandoffs.save({...h,sourceSession:session,sourceAt:this.clock()});
      }
      if(h.sourceAt===undefined || this.clock()-h.sourceAt>30_000)throw new Error('Fresh source confirmation required');
      if(!target || target.machine!==machine || target.session!==session || target.ticket!==h.ticket || target.project!=='pyrycode/pyrycode-desktop'
        || target.role!=='verifier' || target.resource!=='heavy' || target.verificationPin || target.supportTaskId)throw new Error('Target verifier offer mismatch');
      const pin:VerificationPin={handoff:id,candidate:h.candidate,revision:h.revision,sourceGeneration:h.generation};
      this.db.prepare('UPDATE fleet_claims SET machine=?,generation=? WHERE ticket=? AND generation=?').run(machine,randomUUID(),h.ticket,h.generation);
      const result=this.startAdmitted({...target,verificationPin:pin});
      if(!result.ok)throw new Error('Handoff target admission refused: '+result.reason);
      this.db.prepare('INSERT OR IGNORE INTO fleet_assessment_releases VALUES(?,?,?,?)').run(h.ticket,h.source,h.generation,this.clock());
      return this.verifierHandoffs.save({...h,state:'admitted',runId:target.id});
    });
  }

  /** A transferred candidate remains an obligation across declined/failed attempts.
   * Only a later real builder or explicit unused return ends it. */
  private durableVerifierPin(ticket:string,machine:string):VerificationPin|undefined {
    const row=this.db.prepare("SELECT r.rowid AS ordinal,r.generation,h.record FROM fleet_verifier_handoffs h JOIN fleet_runs r ON r.id=json_extract(h.record,'$.runId') JOIN fleet_claims c ON c.ticket=h.ticket AND c.machine=r.machine AND c.generation=r.generation WHERE h.ticket=? AND r.machine=? AND json_extract(h.record,'$.state')='admitted' ORDER BY r.rowid DESC LIMIT 1").get(ticket,machine);
    if(!row || this.db.prepare("SELECT 1 FROM fleet_runs WHERE ticket=? AND rowid>? AND json_extract(request,'$.role')='builder' AND (finished IS NULL OR outcome IS NULL OR outcome!='unused')").get(ticket,row.ordinal))return undefined;
    const h=JSON.parse(String(row.record)) as VerifierHandoff;
    return {handoff:h.commandId,candidate:h.candidate,revision:h.revision,sourceGeneration:h.generation};
  }
  verificationCandidate(ticket:string):string|undefined {
    const claim=this.db.prepare('SELECT machine FROM fleet_claims WHERE ticket=?').get(ticket);
    return claim?this.durableVerifierPin(ticket,String(claim.machine))?.candidate:undefined;
  }
  invalidateVerificationCandidate(ticket:string,candidate:string):void {
    this.transaction(()=>{
      if(this.verificationCandidate(ticket)!==candidate)return;
      const item=this.workflow.get(ticket);
      if(item.status==='In Code Review' && item.labels.includes('error:verifier') && !item.labels.some(l=>['done:verifier','done:documentation'].includes(l)))return;
      this.workflow.change(ticket,{status:'In Code Review',removeLabels:['done:verifier','done:documentation'],addLabels:['error:verifier']},'handoff-candidate-check',randomUUID());
    });
  }
  start(req: StartRequest): StartResult {
    return this.transaction(() => {
      const prior=this.db.prepare('SELECT id FROM fleet_runs WHERE id=?').get(req.id);
      const retired = !prior && this.db.prepare('SELECT verification_pin FROM fleet_retired_runs WHERE id=?').get(req.id);
      if (retired) {
        if (!req.verificationPin && req.role === 'verifier' && retired.verification_pin)
          req = {...req, verificationPin: JSON.parse(String(retired.verification_pin))};
        return this.startAdmitted(req);
      }
      if(req.verificationPin && !prior) throw new Error('Verification pins require operator handoff admission');
      if(!req.verificationPin && req.role==='verifier') {
        const saved=prior ? this.db.prepare('SELECT request FROM fleet_runs WHERE id=?').get(req.id) : undefined;
        const pin=saved ? (JSON.parse(String(saved.request)) as StartRequest).verificationPin : this.durableVerifierPin(req.ticket,req.machine);
        if(pin)req={...req,verificationPin:pin};
      }
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
    const retired = this.db.prepare('SELECT request_hash FROM fleet_retired_runs WHERE id=?').get(req.id);
    if (retired) {
      if (retired.request_hash !== historyHash(request)) throw new Error('Request ID reused with different contents');
      return {ok: false, reason: 'finished'};
    }
      const previous = this.db.prepare("SELECT request,generation,finished FROM fleet_runs WHERE id=?").get(req.id);
      if (previous) {
        const { runnerPolicy: _policy, ...original } = JSON.parse(String(previous.request));
        if (JSON.stringify(original) !== request) throw new Error("Request ID reused with different contents");
        return previous.finished === null ? { ok: true, generation: String(previous.generation) } : { ok: false, reason: "finished" };
      }
    if(this.storage.blocks(req.machine,req.ticket,req.parentTicket,req.supportTaskId))return {ok:false,reason:'locked'};
    if (!req.verificationPin && this.activeVerifierHandoffs().some(h=>h.ticket===req.ticket)) return {ok:false,reason:'locked'};
    if (this.machineRecoveries.blocked(req.machine,req.project)) return {ok:false,reason:'drained'};
    // The operator's central drain or stop holds new grants here even when
    // the computer's manager is older or has not fetched it yet. A retry of
    // a lost reply above still recovers its grant.
    if (workRefusal(project => this.desired.work(req.machine, project), req,
      this.db.prepare("SELECT machine FROM fleet_claims WHERE ticket=?").get(req.ticket)?.machine === req.machine)) return { ok: false, reason: "drained" };
    if (this.splits.pending(req.ticket) || req.parentTicket && this.splits.pending(req.parentTicket)) return {ok:false,reason:'locked'};
    if(this.workflow.preparing(req.project))return {ok:false,reason:'locked'};
    const approval=this.approvals.get(req.ticket);
    if(req.role!=='recovery' && approval?.kind==='rejected' && !approval.authorization) return {ok:false,reason:'locked'};
    if(this.workflow.enabled(req.project) && !req.supportTaskId && req.workflowVersion!==1) return {ok:false,reason:"locked"};
    if(this.workflow.enabled(req.project) && /#[1-9]\d*$/.test(req.ticket)) {
      const item=this.workflow.get(req.ticket);
      if (this.planningSplits.childPending(item, req.project)) return {ok:false,reason:'locked'};
      const recoveryFiling = item.body.match(/<!-- orchestrator-filing:recovery-split:([a-f0-9-]{36}):[a-z][a-z0-9-]* -->/);
      if (recoveryFiling && this.splits.get(recoveryFiling[1])?.state === 'preparing') return {ok:false,reason:'locked'};
      const columns:Record<string,string>={po:'Backlog',refiner:'Backlog',architect:'In Architecture',developer:'In Development',builder:'In Development',qa:'In QA','code-review':'In Code Review',verifier:'In Code Review',documentation:'In Documentation'};
      if(columns[req.role] && (item.state!=='OPEN' || item.status!==columns[req.role] || item.labels.some(l=>l.startsWith('held:')||l.startsWith('error:')||l.startsWith('needs-rework:')||(l.startsWith('wip:')&&!isRepairWip(l))||l.startsWith('needs-human:')&&l!=='needs-human:sizing') || item.blockedBy.some(b=>b.state==='OPEN'))) return {ok:false,reason:'locked'};
      // A ticket split off by a run that is still active waits for that run,
      // which may still be writing its labels, priority and board order.
      // Generic creator holds are bounded. An explicitly declared repair also
      // waits for its declaring planning run to end.
      if(this.creatorActive(item.issueId)) return {ok:false,reason:'locked'};
    }
    // Every stage of a ticket with a requirement runs only where it can.
    const needs = this.requirementsOf(req.ticket);
    if (needs.length && missingCapabilities(needs, this.reportedCapabilities(req.machine)).length) return { ok: false, reason: "incapable" };
    if(/#[1-9]\d*$/.test(req.ticket) && req.role!=='recovery') {
      const required=this.requiredRepairs()[req.ticket]??[];
      if(required.some(sha=>!req.readyRepairs?.includes(sha))) return {ok:false,reason:'locked'};
    }
    if(supportTaskHolds(req.ticket, req.role, this.openTaskTickets([req.ticket]))) return {ok:false,reason:'locked'};
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
  finish(machine: string, session: string, id: string, completed: boolean, unused: boolean, observation: RecoveryObservation | undefined, verificationAccepted: string | undefined): RecoveryIncident[];
  finish(machine: string, session: string, id: string, completed = true, unused = false, observation?: RecoveryObservation, verificationAccepted?:string): RecoveryIncident[] {
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
      if(verificationAccepted!==undefined) {
        const pin=request.verificationPin,item=this.workflow.get(request.ticket);
        const valid=completed && !unused && pin?.candidate===verificationAccepted && item.state==='OPEN' && item.status==='In Code Review' && item.labels.includes('done:verifier') && !item.labels.some(l=>/^(error:|needs-rework:|pending-verdict:|pending-done:|held:|needs-human:)/.test(l));
        if(valid && pin) {
          const h=this.verifierHandoffs.get(pin.handoff);
          if(h.state==='admitted')this.verifierHandoffs.save({...h,state:'accepted',acceptedRunId:id});
          else completed=false;
        } else {
          // Late holds or label changes refuse acceptance, not completion.
          // Children are already drained: retain the pin and release the place.
          completed=false;
          this.workflow.change(request.ticket,{removeLabels:['done:verifier'],addLabels:['error:verifier']},'handoff-acceptance-refused',randomUUID());
        }
      }
      this.db.prepare("DELETE FROM fleet_locks WHERE run_id=?").run(id);
      // Generic creator holds end here. Linked planning children additionally
      // require explicit classification or replacement, surviving this run and process.
      this.db.prepare("DELETE FROM fleet_ticket_creators WHERE run_id=?").run(id);
      this.db.prepare("UPDATE fleet_runs SET finished=?,outcome=? WHERE id=? AND finished IS NULL").run(Date.now(), unused ? "unused" : completed ? "completed" : "cancelled", id);
      if(unused && request.verificationPin && !this.db.prepare("SELECT 1 FROM fleet_run_history WHERE ticket=? AND generation=? AND id!=? AND (finished IS NULL OR outcome IS NULL OR outcome!='unused')").get(run.ticket,run.generation,id)) {
        const h=this.verifierHandoffs.get(request.verificationPin.handoff);
        this.db.prepare('UPDATE fleet_claims SET machine=?,generation=? WHERE ticket=? AND generation=?').run(h.source,h.generation,h.ticket,run.generation);
        this.verifierHandoffs.save({...h,state:'cancelled',reason:'Target confirmed admission was unused; source ownership restored'});
      }
      // An explicitly withdrawn, never-started reservation has no work to own.
      // Preserve this generation if any actual or uncertain run used it. In
      // particular, blocked/failed work and offline reservations remain owned.
      if (unused) {
        this.db.prepare(`DELETE FROM fleet_claims WHERE ticket=? AND generation=?
          AND NOT EXISTS (SELECT 1 FROM fleet_run_history WHERE ticket=? AND generation=?
            AND (finished IS NULL OR outcome IS NULL OR outcome!='unused'))`)
          .run(run.ticket, run.generation, run.ticket, run.generation);
      }
      // Confirmed read-only waits and pause-provenance reviews own no delivery work.
      // Preserve ownership if this generation has any normal or uncertain run.
      if (completed && request.role === "recovery" && this.db.prepare(`SELECT 1 FROM fleet_recovery
        WHERE run_id=? AND ((state='complete' AND json_extract(decision,'$.action')='wait')
          OR (reason=? AND state='escalated' AND json_extract(decision,'$.action') IN ('escalate','propose-close')))`).get(id, RECOVERY_UNKNOWN_PAUSE_REASON)) {
        const released = this.db.prepare(`DELETE FROM fleet_claims WHERE ticket=? AND generation=?
          AND NOT EXISTS (SELECT 1 FROM fleet_run_history WHERE ticket=? AND generation=?
            AND (finished IS NULL OR outcome IS NULL OR outcome NOT IN ('completed','unused')
              OR (role!='recovery' AND outcome!='unused')))
          AND NOT EXISTS (SELECT 1 FROM fleet_recovery AS recovery JOIN fleet_run_history AS history ON history.id=recovery.run_id
            WHERE history.ticket=? AND history.generation=?
            AND json_extract(recovery.decision,'$.action') IN ('retry','rework','resume','refine','unblock','coordinate'))
          AND NOT EXISTS (SELECT 1 FROM fleet_recovery_tasks AS tasks WHERE tasks.ticket=fleet_claims.ticket
            AND (tasks.created>=fleet_claims.created OR tasks.state IN ('queued','running','publishing','attention')))`)
          .run(run.ticket, run.generation, run.ticket, run.generation, run.ticket, run.generation);
        if (released.changes) this.db.prepare("INSERT OR IGNORE INTO fleet_assessment_releases VALUES (?,?,?,?)")
          .run(run.ticket, run.machine, run.generation, Date.now());
      }
      if(this.stages.get(id))this.stages.endWithoutResult(id,this.workflow.get(String(run.ticket)),change=>{
        if(Object.keys(change).length)this.workflow.change(String(run.ticket),change,"stage-execution-ended:"+id,"stage-execution-ended:"+id);
      });
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

  clearMachineRecoveries(machine: string, project: string, ids: string[]): void {
    this.transaction(() => this.machineRecoveries.clear(machine,project,ids,this.clock()));
  }

  /** The trusted source supervisor proves stoppage and retains its files before this call.
   * No timeout, heartbeat or failed contact is accepted as process proof. */
  recoverStoppedWorker(machine: string, input: MachineRecoveryRequest): MachineRecovery {
    validateMachineRecovery(input);
    if (input.machine !== machine) throw new Error('Recovery source mismatch');
    return this.transaction(() => {
      const replay = this.machineRecoveries.replay(input);
      if (replay) return replay;
      const run = this.snapshot().runs.find(r => r.id === input.runId);
      if (!run || run.machine !== machine || run.session !== input.session || run.generation !== input.generation) throw new Error('Stopped run changed; inspect it again');
      const roles = ['builder','developer','architect','refiner','po','verifier','code-review','qa','documentation'];
      if (!roles.includes(run.role) || run.supportTaskId || run.verificationPin || !/#[1-9]\d*$/.test(run.ticket)) throw new Error('This reservation needs its existing specialised recovery');
      if (this.storage.blocks(machine,run.ticket)) throw new Error('Storage maintenance still has custody on the source');
      const claim = this.snapshot().claims.find(c => c.ticket === run.ticket);
      if (claim && (claim.machine !== machine || claim.generation !== input.generation)) throw new Error('Ticket ownership changed');
      const controls = this.desired.document(machine).entries;
      if (!controls.some(c => c.project === run.project && c.run === 'running') || this.desired.work(machine,run.project) !== 'taking') throw new Error('Source is deliberately stopped or drained, or its run policy is unknown');
      if (!this.workflow.enabled(run.project) || this.workflow.preparing(run.project)) throw new Error('Workflow authority is unavailable or preparing');
      const item = this.workflow.get(run.ticket);
      const approval = this.approvals.get(run.ticket);
      if (item.revision !== input.revision || item.state !== 'OPEN' || item.labels.includes('done:'+run.role) || item.status === 'Halted' ||
          item.blockedBy.some(b => b.state === 'OPEN') || item.labels.some(l => /^(held:|health-hold:|pending-verdict:|pending-done:|error:|orchestrator:escalated)/.test(l) || l.startsWith('needs-human:') && l !== 'needs-human:sizing') ||
          approval?.kind === 'rejected' && !approval.authorization || this.splits.pending(run.ticket) ||
          this.activeVerifierHandoffs().some(h => h.ticket === run.ticket) ||
          this.tasks.list(run.ticket).some(t => t.artifactsPending || ['queued','running','publishing','attention'].includes(t.state))) throw new Error('Workflow changed or is held; recovery cannot override it');
      const capable = Object.entries(this.machineCapabilities()).some(([target,report]) => target !== machine &&
        this.clock() - report.updated <= CAPABILITY_REPORT_FRESH_MS && report.projects?.includes(run.project) &&
        !missingCapabilities(this.requirementsOf(run.ticket),report.capabilities).length &&
        !this.machineRecoveries.blocked(target,run.project) && this.desired.work(target,run.project) === 'taking' &&
        this.desired.document(target).entries.some(c => c.project === run.project && c.run === 'running'));
      if (!capable) throw new Error('No other configured computer is ready for this project and its requirements');
      // Finish only this proven-stopped attempt. The source hold, workflow marker
      // removal and release commit together. Admission chooses the replacement.
      const record: MachineRecovery = {...input,ticket:run.ticket,project:run.project,role:run.role,created:this.clock()};
      this.machineRecoveries.save(input,record);
      this.finish(machine,run.session,run.id,false,false);
      this.db.prepare('DELETE FROM fleet_claims WHERE ticket=? AND machine=? AND generation=?').run(run.ticket,machine,run.generation);
      if (claim) this.db.prepare('INSERT OR IGNORE INTO fleet_assessment_releases VALUES(?,?,?,?)').run(run.ticket,machine,run.generation,this.clock());
      this.workflow.change(run.ticket,{addLabels:['orchestrator:recovery-priority']},'stopped-worker-recovery',input.commandId);
      this.workflow.comment(run.ticket,`The dispatcher on ${machine} and its child processes are confirmed stopped. Another capable computer may retry the interrupted ${run.role} stage through normal admission. Original working copies, commits, logs and captures remain retained on ${machine}. Recovery receipt: ${input.commandId}. Retention digest: ${input.retainedDigest}. The replacement uses the published branch and runs fresh checks. The source project is held until an operator reconciles retained work and clears the recovery hold.`,input.commandId+':evidence');
      return record;
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

  /** Tickets with an open support task, in the states start() refuses. `among` narrows the read to those tickets. */
  openTaskTickets(among?: readonly string[]): string[] {
    const states = OPEN_SUPPORT_TASK_STATES.map(() => "?").join(",");
    const only = among ? ` AND ticket IN (${among.map(() => "?").join(",") || "NULL"})` : "";
    return this.db.prepare(`SELECT DISTINCT ticket FROM fleet_recovery_tasks WHERE state IN (${states})${only} ORDER BY ticket`)
      .all(...OPEN_SUPPORT_TASK_STATES, ...(among ?? [])).map(r => String(r.ticket));
  }

  /** Read-only custody proof. A missing active reservation alone cannot
   * establish that a recorded predecessor ever ran or finished normally. */
  worktreePredecessor(machine: string, session: string, runId: string, priorId: string): (FleetRun & { outcome: "completed" | "cancelled" }) | null {
    const state = this.snapshot();
    const current = state.runs.find(run => run.id === runId && run.machine === machine && run.session === session);
    if (!current) throw new Error("Run owner mismatch");
    const row = this.db.prepare("SELECT request,generation,created,finished,outcome FROM fleet_runs WHERE id=?").get(priorId);
    if (!row || row.finished === null || !["completed", "cancelled"].includes(String(row.outcome))) return null;
    const outcome = String(row.outcome) as "completed" | "cancelled";
    const prior = { ...JSON.parse(String(row.request)), generation: String(row.generation), created: Number(row.created) } as FleetRun;
    if (prior.id === current.id || prior.machine !== machine || prior.project !== current.project ||
        prior.ticket !== current.ticket || prior.created > current.created ||
        state.runs.some(run => run.ticket === current.ticket && run.id !== current.id) ||
        !state.claims.some(claim => claim.ticket === current.ticket && claim.machine === machine && claim.generation === current.generation)) return null;
    // Normal ManagedDispatch completion waits for tracked process groups
    // before /finish. Operator /free leaves no normal outcome at all.
    // Stopped-worker recovery finishes the run as cancelled and releases the
    // claim, leaving its files for an operator: across an ownership change
    // only a normal completion confirms the predecessor.
    if (prior.generation !== current.generation && outcome !== "completed") return null;
    return { ...prior, outcome };
  }

  private creatorActive(issueId: string): boolean {
    return this.requiredRepairChildren.creatorActive(issueId) || !!this.db.prepare('SELECT 1 FROM fleet_ticket_creators AS c JOIN fleet_runs AS r ON r.id=c.run_id WHERE c.issue_id=? AND r.finished IS NULL AND c.created>?').get(issueId,this.clock()-CREATOR_HOLD_MS);
  }
  private planningChildHolds(): NonNullable<FleetSnapshot['planningChildHolds']> {
    const holds: NonNullable<FleetSnapshot['planningChildHolds']> = {};
    // Scan the workflow once, then use ticket primary keys; historical creator
    // rows must not each trigger a full issue-ID lookup on every manager poll.
    const rows = this.db.prepare(`SELECT w.ticket FROM workflow_tickets w
      WHERE json_extract(w.item,'$.state')='OPEN' AND (
        EXISTS (SELECT 1 FROM fleet_split_children c WHERE c.issue_id=json_extract(w.item,'$.issueId')) OR
        EXISTS (SELECT 1 FROM fleet_ticket_creators c WHERE c.issue_id=json_extract(w.item,'$.issueId')))
    `).all();
    for (const row of rows) {
      const ticket = String(row.ticket), item = this.workflow.get(ticket), project = ticket.split('#')[0];
      if (this.planningSplits.childPending(item, project)) holds[ticket] = 'planning-child-pending';
      else if (this.creatorActive(item.issueId)) holds[ticket] = 'creator-active';
    }
    return holds;
  }

  snapshot(): FleetSnapshot {
    const verifierHandoffs = this.activeVerifierHandoffs();
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
    const machineRecoveries = this.machineRecoveries.list();
    const planningChildHolds = this.planningChildHolds();
    return {
      ...(Object.keys(planningChildHolds).length ? { planningChildHolds } : {}),
      ...(machineRecoveries.length ? {machineRecoveries} : {}),
      ...(verifierHandoffs.length ? { verifierHandoffs } : {}),
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
