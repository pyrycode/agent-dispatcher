// The one authority for fleet ownership. No heartbeat expires a claim or run.
// Keep this file on the claim server's local disk, never on a shared filesystem.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { RecoveryFacts, type PauseRecord, type EvidenceRecord, type CoordinationRecord } from "./recovery-facts.js";
import { RecoveryLedger, validateObservations, IDLE_RECOVERY_REASONS, type RecoveryObservation, type RecoveryDecision, type RecoveryIncident } from "./fleet-recovery.js";
import { OperationReports } from './operation-reports.js';
import {RecoveryTasks, type RecoveryTaskRequest, type RecoveryTaskResult} from './recovery-tasks.js';
import {createHash} from 'node:crypto';
import type { AgentRunner } from './agent-runner.js';

/** An operator choice, frozen into each new grant. Null restores local settings. */
export interface RunnerPolicy { runner: AgentRunner | null; revision: number }

export type ResourceClass = "heavy" | "medium" | "light";
export interface MachineLimits { heavyLimit: number; combinedLimit: number }
export function validateLimits(limits: MachineLimits): void {
  if (!limits || !Number.isSafeInteger(limits.heavyLimit) || limits.heavyLimit < 1 ||
      !Number.isSafeInteger(limits.combinedLimit) || limits.combinedLimit < limits.heavyLimit) {
    throw new Error("Limits require positive integers with combinedLimit >= heavyLimit");
  }
}
export interface StartRequest {
  id: string;
  machine: string;
  session: string;
  project: string;
  ticket: string;
  role: string;
  resource: ResourceClass;
  locks: string[];
  roleLimit?: number;
  requiresRecovery?: boolean;
  readyRepairs?: string[];
  supportTaskId?: string; parentTicket?: string;
}
export interface Claim { ticket: string; machine: string; generation: string; created: number }
export interface FleetRun extends StartRequest { generation: string; created: number; runnerPolicy?: RunnerPolicy }
export interface FleetSnapshot { claims: Claim[]; runs: FleetRun[]; runnerPolicy?: RunnerPolicy; idleRecoveryTickets?: string[]; releasedAssessmentClaims?: Claim[]; features?: {recoveryTasks:boolean}; requiredRepairs?: Record<string,string[]> }
export type StartResult = { ok: true; generation: string } | {
  ok: false; reason: "foreign-claim" | "running" | "capacity" | "locked" | "finished";
};

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
  if (req.requiresRecovery !== undefined && (typeof req.requiresRecovery !== 'boolean' || req.role !== 'recovery')) throw new Error('Invalid recovery requirement');
  if(req.readyRepairs!==undefined && (!Array.isArray(req.readyRepairs)||req.readyRepairs.length>10||req.readyRepairs.some(s=>! /^[a-f0-9]{40}$/.test(s)))) throw new Error("Invalid repair readiness");
  if(req.supportTaskId!==undefined && (req.role!=="recovery-task"||! /^[a-f0-9]{64}$/.test(req.supportTaskId)||! /^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(req.parentTicket??""))) throw new Error("Invalid support task admission");
  if (!Array.isArray(req.locks) || req.locks.length > 16 || req.locks.some(k => typeof k !== "string" || !k.startsWith(`${req.project}:`) || k.length > 300)) {
    throw new Error("Invalid project locks");
  }
}

export class FleetStore {
  private readonly db: DatabaseSync;
  readonly recovery: RecoveryLedger;
  readonly facts: RecoveryFacts;
  readonly operations: OperationReports;
  readonly tasks: RecoveryTasks;
  constructor(path: string, private readonly limits: Readonly<Record<string, MachineLimits>>) {
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
    this.recovery = new RecoveryLedger(this.db);
    this.facts = new RecoveryFacts(this.db);
    this.tasks = new RecoveryTasks(this.db);
    this.db.exec("CREATE TABLE IF NOT EXISTS fleet_assessment_releases (ticket TEXT NOT NULL, machine TEXT NOT NULL, generation TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(ticket,generation)) STRICT");
    this.db.exec("CREATE TABLE IF NOT EXISTS fleet_control_target (singleton INTEGER PRIMARY KEY,revision TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS fleet_control_ready (machine TEXT PRIMARY KEY,revision TEXT NOT NULL) STRICT;");
    this.operations = new OperationReports(this.db, Object.keys(limits));
  }
  close(): void { this.db.close(); }

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
        if (selected.action === 'coordinate') this.tasks.request(incident.ticket, selected.task!,incident.id);
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
    return this.transaction(() => this.tasks.request(run.ticket, request,run.id));
  }
  taskStart(machine: string, id: string, session: string): StartResult & {runnerPolicy?: RunnerPolicy;run?:FleetRun} {
    if(!Object.hasOwn(this.limits,machine)) throw new Error('Unknown machine');
    const task=this.tasks.get(id);
    if(!this.tasks.available(machine,id)) return {ok:false,reason:'locked'};
    const project=task.ticket.split('#')[0],runId=`task-${id}`;
    const started=this.start({id:runId,machine,session,project,ticket:`${project}#@task-${id}`,role:'recovery-task',resource:task.request.recipe==='platform-probe'?'light':'heavy',locks:[],supportTaskId:id,parentTicket:task.ticket});
    return {...started,...(started.ok?{runnerPolicy:this.snapshot().runs.find(r=>r.id===runId)?.runnerPolicy,run:this.snapshot().runs.find(r=>r.id===runId)}:{})};
  }
  readTask(machine:string,session:string,project:string,runId:string,id:string) {
    const task=this.tasks.get(id);
    const run=this.snapshot().runs.find(r=>r.id===runId&&r.machine===machine&&r.session===session&&r.project===project&&r.ticket===task.ticket);
    if(!run) throw new Error('Artifact read needs its admitted source ticket');
    this.authorize(machine,session,task.ticket,runId);
    return task;
  }
  requiredRepairs():Record<string,string[]> {
    const required:Record<string,string[]>={};
    for(const task of this.tasks.list()) if(task.state==='complete' && task.result?.dispatcherRevision) {
      if(!required[task.ticket]) required[task.ticket]=[task.result.dispatcherRevision];
    }
    return required;
  }
  prepareRepair(machine:string,id:string,session:string,publication:unknown) {
    return this.transaction(()=>{
      const task=this.tasks.get(id);
      if(task.machine!==machine||task.session!==session||task.request.recipe!=='dispatcher-repair'||!task.runId) throw new Error('Repair actor mismatch');
      const serialized=JSON.stringify(publication);
      if(task.state==='publishing') {
        if(task.result?.files['publication.json']!==serialized) throw new Error('Prepared repair changed');
        return task;
      }
      if(task.state!=='running') throw new Error('Repair is not running');
      const result={outcome:'completed' as const,summary:'Verified repair prepared; publication and deployment remain pending.',files:{'publication.json':serialized}};
      this.tasks.complete(id,machine,session,result);
      this.db.prepare("UPDATE fleet_recovery_tasks SET state='publishing' WHERE id=?").run(id);
      this.releaseTaskRun(task.runId,machine,session,true);
      return this.tasks.get(id);
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
  taskComplete(machine: string, id: string, session: string, result: RecoveryTaskResult) {
    return this.transaction(() => {
      const task=this.tasks.get(id);
      if (task.machine!==machine || task.session!==session || !task.runId) throw new Error('Task actor mismatch');
      const completed=this.tasks.complete(id,machine,session,result);
      this.releaseTaskRun(task.runId,machine,session,result.outcome==='completed');
      return completed;
    });
  }

  recoveryFacts(tickets: string[]) {
    const evidence = this.facts.getEvidence(tickets);
    return tickets.map(ticket => ({ ticket, pause: this.facts.getPause(ticket),
      artifactRevision: this.artifactRevision(ticket), evidence: evidence.filter(e => e.ticket === ticket), capabilities:this.tasks.capabilities(), tasks: this.tasks.list(ticket).map(t => ({...t,result:t.result ? {...t.result,files:Object.fromEntries(Object.keys(t.result.files).map(p=>[p,"retained private artifact"]))} : null})),
      coordination: this.facts.getCoordination(ticket) }));
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
      if (claim && claim.machine !== machine) throw new Error("Ticket belongs to another machine");
      const active = this.db.prepare("SELECT id,session FROM fleet_runs WHERE ticket=? AND finished IS NULL").get(ticket);
      if (active && (active.id !== runId || active.session !== session)) throw new Error("Ticket has an active run");
      if (claim) return claim;
      const grant = runId ? this.db.prepare("SELECT request,generation FROM fleet_runs WHERE id=? AND machine=? AND session=? AND finished IS NULL").get(runId, machine, session) : undefined;
      if (!grant) throw new Error("Unclaimed workflow writes require a run grant");
      const request = JSON.parse(String(grant.request)) as StartRequest;
      if (!ticket.startsWith(`${request.project}#`)) throw new Error("Run project mismatch");
      const result = { ticket, machine, generation: randomUUID(), created: Date.now() };
      // Recording follow-ups and housekeeping must not reserve their future
      // work. Only start() creates ownership after scheduling admission.
      return result;
    });
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
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
      if (req.resource !== "light") {
        const row = this.db.prepare(`SELECT
          count(CASE WHEN resource='heavy' THEN 1 END) AS heavy,
          count(CASE WHEN resource IN ('heavy','medium') THEN 1 END) AS combined
          FROM fleet_runs WHERE machine=? AND finished IS NULL`).get(req.machine)!;
        const limit = this.limits[req.machine];
        if (Number(row.combined) >= limit.combinedLimit ||
            (req.resource === "heavy" && Number(row.heavy) >= limit.heavyLimit)) return { ok: false, reason: "capacity" };
      }
      if (req.roleLimit !== undefined) {
        const active = this.db.prepare("SELECT request FROM fleet_runs WHERE finished IS NULL").all();
        if (active.filter(r => { const job = JSON.parse(String(r.request)); return job.project === req.project && job.role === req.role; }).length >= req.roleLimit) return { ok: false, reason: "locked" };
      }
      for (const lock of req.locks) {
        if (this.db.prepare("SELECT 1 FROM fleet_locks WHERE name=?").get(lock)) return { ok: false, reason: "locked" };
      }
      const generation = claim ? String(claim.generation) : randomUUID();
      const now = Date.now();
      const runnerPolicy = this.runnerPolicy();
      const admitted = runnerPolicy ? JSON.stringify({ ...JSON.parse(request), runnerPolicy }) : request;
      this.db.prepare("INSERT OR IGNORE INTO fleet_claims VALUES (?,?,?,?)").run(req.ticket, req.machine, generation, now);
      this.db.prepare("INSERT INTO fleet_runs VALUES (?,?,?,?,?,?,?,?,NULL,NULL)").run(req.id, req.machine, req.session, req.ticket, generation, req.resource, admitted, now);
      for (const lock of new Set(req.locks)) this.db.prepare("INSERT INTO fleet_locks VALUES (?,?)").run(lock, req.id);
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
      // A completed read-only check that says wait owns no delivery work.
      // Preserve ownership if this generation has any normal or uncertain run.
      if (completed && request.role === "recovery" && this.db.prepare(`SELECT 1 FROM fleet_recovery
        WHERE run_id=? AND state='complete' AND json_extract(decision,'$.action')='wait'`).get(id)) {
        const released = this.db.prepare(`DELETE FROM fleet_claims WHERE ticket=? AND generation=?
          AND NOT EXISTS (SELECT 1 FROM fleet_runs WHERE ticket=? AND generation=?
            AND (finished IS NULL OR outcome IS NULL OR outcome NOT IN ('completed','unused')
              OR (json_extract(request,'$.role')!='recovery' AND outcome!='unused')))`)
          .run(run.ticket, run.generation, run.ticket, run.generation);
        if (released.changes) this.db.prepare("INSERT OR IGNORE INTO fleet_assessment_releases VALUES (?,?,?,?)")
          .run(run.ticket, run.machine, run.generation, Date.now());
      }
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

  // Operator recovery only. The caller must disable/stop the old worker first.
  // Matching the generation prevents an old confirmation from releasing a new owner.
  free(ticket: string, generation: string, stopped: boolean): void {
    if (stopped !== true) throw new Error("Confirm the old worker and its subprocesses have stopped");
    this.transaction(() => {
      const claim = this.db.prepare("SELECT generation FROM fleet_claims WHERE ticket=?").get(ticket);
      if (!claim || claim.generation !== generation) throw new Error("Ticket ownership changed; inspect it again");
      this.db.prepare("DELETE FROM fleet_locks WHERE run_id IN (SELECT id FROM fleet_runs WHERE ticket=? AND finished IS NULL)").run(ticket);
      this.db.prepare("UPDATE fleet_runs SET finished=? WHERE ticket=? AND finished IS NULL").run(Date.now(), ticket);
      this.db.prepare("DELETE FROM fleet_claims WHERE ticket=? AND generation=?").run(ticket, generation);
    });
  }

  snapshot(): FleetSnapshot {
    const runnerPolicy = this.runnerPolicy();
    const idleRecoveryTickets = this.db.prepare("SELECT ticket FROM fleet_recovery WHERE present=1 AND state='queued' AND reason IN (?,?)")
      .all(...IDLE_RECOVERY_REASONS).map(r => String(r.ticket));
    const releasedAssessmentClaims = this.db.prepare("SELECT * FROM fleet_assessment_releases").all() as unknown as Claim[];
    return {
      ...(runnerPolicy ? { runnerPolicy } : {}),
      ...(idleRecoveryTickets.length ? { idleRecoveryTickets } : {}),
      ...(releasedAssessmentClaims.length ? { releasedAssessmentClaims } : {}),
      claims: this.db.prepare("SELECT * FROM fleet_claims ORDER BY created,ticket").all() as unknown as Claim[],
      runs: this.db.prepare("SELECT request,generation,created FROM fleet_runs WHERE finished IS NULL ORDER BY created,id").all()
        .map(row => ({ ...JSON.parse(String(row.request)), generation: String(row.generation), created: Number(row.created) })),
    };
  }
}
