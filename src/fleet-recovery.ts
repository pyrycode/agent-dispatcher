import { validateRecoverySplit, type RecoverySplitPlan } from "./recovery-split.js";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FleetSnapshot } from "./fleet-store.js";
import {validateTaskRequest, CAPABILITY_FRESH_MS, type RecoveryTaskRequest} from "./recovery-tasks.js";
import type { PauseRecord } from "./recovery-facts.js";
import { hasRecoveryPriority, hasRepairMarker, hasRunningWip } from "./recovery-labels.js";
import { currentWorkflow, dispatcherRepairCap, withdrawCappedRepairs } from "./recovery-repair-cap.js";

export interface RecoveryObservation {
  ticket: string; status: string; labels: string[]; blocked: boolean;
  evidenceRevision?: string;
  artifactRevision?: string;
  pause?: PauseRecord;
  familyHold?: string;
  assessmentPolicy?: number;
  /** Only the claim authority supplies a retained-evidence investigation identity. */
  investigationRevision?:string;
}
export type RecoveryAction = "wait" | "retry" | "rework" | "split" | "resume" | "refine" | "unblock" | "propose-close" | "coordinate" | "escalate";
/** What should reopen a settled wait or operational escalation. Recovery task ids and full ticket references only. */
export interface RecoveryWaitFor { tasks?: string[]; tickets?: string[] }
export interface RecoveryDecision { split?: RecoverySplitPlan; action: RecoveryAction; reason: string; blocker?: string; retryReset?: string; recheckAt?: number; task?: RecoveryTaskRequest; category?: "operational" | "human";
  waitFor?: RecoveryWaitFor;
  /** Code-only: a transient transport failure keeps its short cooldown. Never accepted from an assessment. */
  cooldown?: boolean }
/**
 * The state a wait or operational escalation was settled against. A settled
 * incident is reassessed only when this basis changes, at an explicit code
 * deadline, or after the long safety interval.
 */
export interface RecoverySettlement {
  incident: string; ticket: string; created: number; recheckAt: number;
  basis: { fingerprint: string; tasks: Record<string, string>; tickets: Record<string, string>; coordination: string | null; capabilities?: string[] };
  digest: string; reopened: string | null; reopenedAt: number | null;
}
export interface RecoveryIncident {
  id: string; ticket: string; fingerprint: string; reason: string;
  state: "queued" | "assessing" | "applying" | "waiting" | "complete" | "escalated" | "resolved";
  created: number; updated: number; runId: string | null; decision: RecoveryDecision | null;
  current?: boolean;
  /** Present for a settled wait or operational escalation: what it waits on and why it reopened. */
  settlement?: RecoverySettlement;
  /**
   * Present on a current assessed incident. `quietRepeats` counts assessments
   * in a row with no stage, recovery label or blocker change; a change of only
   * comments, logs or task results is assessed again no earlier than
   * `nextQuietReassessAt`.
   */
  cadence?: { quietRepeats: number; nextQuietReassessAt: number };
}

/** Short code-set cooldown, used only for transient transport failures. */
export const RECOVERY_RECHECK_MS = 30 * 60_000;
/** Default safety reassessment of an unchanged settled wait or operational escalation. */
export const RECOVERY_SAFETY_RECHECK_MS = 24 * 3600_000;
/**
 * Spacing of repeat assessments of one ticket whose stage, recovery labels
 * and blockers have not changed since its last assessment: only its comments,
 * body, logs, recovery task results, coordination or dependencies moved. The
 * first such repeat waits `base` after the last decision, the same thirty
 * minutes as the earlier evidence cooldown, and each further one in a row
 * doubles it up to `ceiling`. Any change to stage, recovery labels or
 * blockers, a new error among them, resets the run and is assessed at once.
 *
 * Measured 2026-10-14: 154 recovery assessments in one day, each a large
 * Codex request, against 36 builder runs. See docs/machine-manager.md.
 */
export const RECOVERY_REASSESS_BASE_MS = RECOVERY_RECHECK_MS;
export const RECOVERY_REASSESS_CEILING_MS = 4 * 3600_000;
export interface RecoveryLedgerOptions { safetyRecheckMs?: number; reassessBaseMs?: number; reassessCeilingMs?: number }
export function validateSafetyRecheck(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 60 * 60_000 || ms > 30 * 86400_000) throw new Error("Recovery safety recheck must be between one hour and thirty days");
  return ms;
}
export function validateReassessSpacing(baseMs: number, ceilingMs: number): { baseMs: number; ceilingMs: number } {
  if (!Number.isSafeInteger(baseMs) || baseMs < 5 * 60_000 || baseMs > 24 * 3600_000) throw new Error("Recovery reassessment base must be between five minutes and one day");
  if (!Number.isSafeInteger(ceilingMs) || ceilingMs < baseMs || ceilingMs > 7 * 86400_000) throw new Error("Recovery reassessment ceiling must be between the base and seven days");
  return { baseMs, ceilingMs };
}
/** Consecutive quiet repeats are counted up to this, far past any ceiling. */
const REASSESS_STREAK_CAP = 20;
const TASK_ID = /^[a-f0-9]{64}$/;
const FULL_TICKET = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;
/** Pending task states collapse, so a dependency starting to run is not a change. */
const taskPhase = (state: string | undefined) => state === undefined ? "missing" : ["queued", "running", "publishing"].includes(state) ? "pending" : state;
function settles(state: string, decision: RecoveryDecision | null): boolean {
  return !!decision && (state === "complete" && decision.action === "wait" || state === "escalated" && decision.action === "escalate" && decision.category === "operational");
}
export const RECOVERY_DEPENDENCY_REASON = "Dependency evidence and coordination reassessment";
export const RECOVERY_INBOX_REASON = "Inbox readiness reassessment";
export const RECOVERY_UNKNOWN_PAUSE_REASON = "Pause origin unknown; record who paused this ticket and the reopening condition";
export const RECOVERY_ASSESSMENT_POLICY = 1;
export const IDLE_RECOVERY_REASONS = [RECOVERY_DEPENDENCY_REASON, RECOVERY_INBOX_REASON, RECOVERY_UNKNOWN_PAUSE_REASON];
export const RECOVERY_RETURNED_INBOX = "orchestrator:returned-inbox";
export const RECOVERY_REPAIRS_PER_TICKET = 3;
export const RECOVERY_STALLED_RUN_MS = 3 * 3600000;
const RETAINED_RUN_REASON = "Retained reservation without workflow progress for three hours; inspect local child processes before intervening";
export function hasOperatorHold(labels: readonly string[]): boolean {
  return labels.some(l => l.startsWith("needs-human:") && l !== "needs-human:sizing");
}
/** Inspection can establish pause provenance, but cannot authorise reopening. */
export function canInspectUnknownPause(o: RecoveryObservation): boolean {
  return o.status === "Halted" && !o.pause && !hasOperatorHold(o.labels)
    && !o.labels.some(l => /permission_denied/.test(l)) && !hasRunningWip(o.labels);
}

export function validateObservations(project: string, observations: RecoveryObservation[]): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(project) || !Array.isArray(observations) || observations.length > 5000) throw new Error("Invalid recovery report");
  const seen = new Set<string>();
  for (const o of observations) {
    if (!o || !o.ticket.startsWith(`${project}#`) || !/^[1-9]\d*$/.test(o.ticket.slice(project.length + 1)) || seen.has(o.ticket)
      || typeof o.status !== "string" || o.status.length > 100 || typeof o.blocked !== "boolean"
      || !Array.isArray(o.labels) || o.labels.length > 200 || o.labels.some(l => typeof l !== "string" || l.length > 200)) throw new Error("Invalid recovery observation");
    if (o.artifactRevision !== undefined && !/^[a-f0-9]{64}$/.test(o.artifactRevision)) throw new Error("Invalid artifact revision");
    if (o.evidenceRevision !== undefined && !/^[a-f0-9]{64}$/.test(o.evidenceRevision)) throw new Error("Invalid evidence revision");
    if (o.assessmentPolicy !== undefined && (!Number.isSafeInteger(o.assessmentPolicy) || o.assessmentPolicy < 1)) throw new Error("Invalid assessment policy");
    if(o.investigationRevision!==undefined && !/^[a-f0-9]{64}$/.test(o.investigationRevision)) throw new Error('Invalid investigation identity');
    if (o.familyHold !== undefined && (typeof o.familyHold !== "string" || !o.familyHold.startsWith(`${project}#`) || !/^[1-9]\d*$/.test(o.familyHold.slice(project.length + 1)))) throw new Error("Invalid family hold");
    seen.add(o.ticket);
  }
}
export function recoveryFingerprint(o: RecoveryObservation): string {
  const basis:unknown[]=[o.status, o.blocked,
    o.labels.filter(l => l !== "error:family-breaker" && (l === RECOVERY_RETURNED_INBOX || /^(error:|error-retry-count:|needs-human:|rework-count:|done:|needs-rework:|needs-real-claude$)/.test(l))).sort(),
    o.evidenceRevision ?? null, o.artifactRevision ?? null, o.pause ?? null];
  if(o.investigationRevision) basis.push(o.investigationRevision);
  return createHash('sha256').update(JSON.stringify(basis)).digest('hex');
}
/**
 * True when the code owner's work has passed review since its last rework:
 * the reviewer's `done:` label is on the ticket, or the ticket has moved on
 * to documentation. A rework routed back to the code owner strips every
 * `done:` label and moves the ticket out of review, so neither holds during
 * a real loop. A pending rework for the code owner (`needs-rework:builder`
 * or `needs-rework:developer`, the only routes `rework-count` counts) means
 * another round is already on its way, so it never counts as passed.
 *
 * `rework-count:N` is history and stays on the ticket after the pass. Read
 * alone, it held a passed ticket (pyrycode #3324, 2026-10-14, verifier PASS
 * at 18:27 EEST) in a recovery assessment instead of its documentation stage.
 */
export function passedReview(o: Pick<RecoveryObservation, "status" | "labels">): boolean {
  if (o.labels.some(l => l === "needs-rework:builder" || l === "needs-rework:developer")) return false;
  if (o.status === "In Documentation") return true;
  // A route back strips done labels only after it moves the ticket, and a
  // failed strip is not retried. A reviewer's done label left behind in a
  // column before review is that half-applied route, not a pass.
  return !PRE_REVIEW_COLUMNS.includes(o.status) && o.labels.some(l => l === "done:verifier" || l === "done:code-review");
}
const PRE_REVIEW_COLUMNS = ["Backlog", "In Architecture", "In Development", "In QA"];
export function recoveryTrigger(o: RecoveryObservation): { reason: string; manual: boolean } | null {
  if (o.status === "Done") return null;
  if (hasOperatorHold(o.labels) || o.status === "Halted" && o.pause?.origin === "operator") return { reason: "Explicit operator hold", manual: true };
  if (o.labels.some(l => /permission_denied/.test(l))) return { reason: "Denied permission needs an operator", manual: true };
  if (o.status === "Halted") return o.pause?.origin === "pipeline"
    ? { reason: `Pipeline pause: ${o.pause.reason}`, manual: false }
    : { reason: RECOVERY_UNKNOWN_PAUSE_REASON, manual: true };
  // Health holds and pending transient retries keep their existing recovery.
  // A stage error means retries have stopped, so it needs diagnosis, not a blind retry.
  if (o.labels.some(l => l.startsWith("health-hold:"))) return null;
  const errors = o.labels.filter(l => l.startsWith("error:") && l !== "error:family-breaker");
  if (errors.length) return { reason: errors.sort().join(", "), manual: false };
  if (o.blocked) return { reason: RECOVERY_DEPENDENCY_REASON, manual: false };
  if(o.investigationRevision) return {reason:'Retained-evidence test investigation requested by builder',manual:false};
  if (o.labels.some(l => l.startsWith("error-retry-count:"))) return null;
  // The assigned repair already addresses these retained historical counts.
  // A new stage error still triggers diagnosis above.
  if (hasRecoveryPriority(o.labels)) return null;
  if (o.labels.some(l => /^rework-count:\d+$/.test(l) && Number(l.split(":")[1]) >= 2) && !passedReview(o)) return { reason: "Repeated review rework", manual: false };
  if (o.status === "Inbox" && o.labels.some(l => l === RECOVERY_RETURNED_INBOX || l === "needs-real-claude" || l === "done:refiner")) return { reason: "Pipeline evidence or refinement is needed in Inbox", manual: false };
  if (o.status === "Inbox") return { reason: RECOVERY_INBOX_REASON, manual: false };
  return null;
}
export function validateRecoveryDecision(value: unknown): RecoveryDecision {
  const d = value as RecoveryDecision;
  if (!d || !["wait", "retry", "rework", "split", "resume", "refine", "unblock", "propose-close", "coordinate", "escalate"].includes(d.action) || typeof d.reason !== "string" || !d.reason.trim() || d.reason.length > 6000) throw new Error("Invalid recovery decision");
  if (d.action === "unblock" && !/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(d.blocker ?? "")) throw new Error("Unblock requires a full blocker ticket");
  if (d.retryReset !== undefined && (!['retry', 'rework', 'refine', 'resume'].includes(d.action)
    || typeof d.retryReset !== "string" || !d.retryReset.trim() || d.retryReset.length > 6000)) throw new Error("Invalid retry reset finding");
  if (d.category !== undefined && !["operational","human"].includes(d.category)) throw new Error("Invalid escalation category");
  const task = d.action === "coordinate" ? validateTaskRequest(d.task) : undefined;
  // A malformed reopening hint is dropped rather than failing the assessment.
  const hint = (values: unknown, pattern: RegExp) => Array.isArray(values) ? [...new Set(values.filter((v): v is string => typeof v === "string" && pattern.test(v)))].slice(0, 10) : [];
  const waitFor = (d.action === "wait" || d.action === "escalate") && d.waitFor && typeof d.waitFor === "object"
    ? { tasks: hint(d.waitFor.tasks, TASK_ID), tickets: hint(d.waitFor.tickets, FULL_TICKET) } : undefined;
  return { action: d.action, reason: d.reason, ...(d.action === "split" ? {split: validateRecoverySplit(d.split)} : {}), ...(task ? {task} : {}), ...(d.action === "escalate" && d.category ? {category:d.category} : {}), ...(d.action === "unblock" ? { blocker: d.blocker } : {}),
    ...(d.retryReset !== undefined ? { retryReset: d.retryReset } : {}),
    ...(waitFor && (waitFor.tasks.length || waitFor.tickets.length) ? { waitFor } : {}),
    ...(d.cooldown === true && d.action === "escalate" && d.category === "operational" ? { cooldown: true } : {}) };
}

/** Uses the claim authority's database. No independent watcher can race this ledger. */
export class RecoveryLedger {
  private readonly safetyRecheckMs: number;
  private readonly reassess: { baseMs: number; ceilingMs: number };
  constructor(private db: DatabaseSync, private now = Date.now, options: RecoveryLedgerOptions = {}) {
    this.safetyRecheckMs = validateSafetyRecheck(options.safetyRecheckMs ?? RECOVERY_SAFETY_RECHECK_MS);
    this.reassess = validateReassessSpacing(options.reassessBaseMs ?? RECOVERY_REASSESS_BASE_MS, options.reassessCeilingMs ?? RECOVERY_REASSESS_CEILING_MS);
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_recovery (
      id TEXT PRIMARY KEY, ticket TEXT NOT NULL, fingerprint TEXT NOT NULL, reason TEXT NOT NULL,
      state TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      run_id TEXT, decision TEXT, present INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS fleet_recovery_current ON fleet_recovery(ticket) WHERE present=1;
    CREATE TABLE IF NOT EXISTS fleet_recovery_progress (
      ticket TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, since INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS fleet_recovery_workflow (ticket TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS fleet_recovery_assessment_policy (incident_id TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS fleet_recovery_settlement (
      incident_id TEXT PRIMARY KEY, ticket TEXT NOT NULL, basis TEXT NOT NULL, digest TEXT NOT NULL,
      created INTEGER NOT NULL, recheck_at INTEGER NOT NULL, reopened TEXT, reopened_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS fleet_recovery_status (ticket TEXT PRIMARY KEY, status TEXT NOT NULL, present INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS fleet_recovery_cadence (ticket TEXT PRIMARY KEY, streak INTEGER NOT NULL, updated INTEGER NOT NULL, pause TEXT) STRICT;`);
  }
  /** Quiet repeat assessments in a row for a ticket. */
  private quietRepeats(ticket: string): number {
    return Number(this.db.prepare("SELECT streak FROM fleet_recovery_cadence WHERE ticket=?").get(ticket)?.streak ?? 0);
  }
  /** How long after its last decision a ticket with only quiet changes waits. */
  quietInterval(repeats: number): number {
    return Math.min(this.reassess.ceilingMs, this.reassess.baseMs * 2 ** Math.min(Math.max(0, repeats), 30));
  }
  /**
   * The wait after the last decision before a quiet repeat. An awaited
   * result is one step shorter and immediate the first time. A person's
   * escalation keeps the flat base, so a reply by comment is read within it.
   */
  private quietDelay(repeats: number, awaited: boolean, human: boolean): number {
    if (human) return this.reassess.baseMs;
    return !awaited ? this.quietInterval(repeats) : repeats === 0 ? 0 : this.quietInterval(repeats - 1);
  }
  private hasTable(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  }
  /** Current state of everything a settled incident is waiting on. */
  private basis(ticket: string, fingerprint: string, tasks: string[], tickets: string[], operational: boolean): RecoverySettlement["basis"] {
    const taskStates = Object.fromEntries(tasks.sort().map(id => [id, taskPhase(this.hasTable("fleet_recovery_tasks")
      ? this.db.prepare("SELECT state FROM fleet_recovery_tasks WHERE id=?").get(id)?.state as string | undefined : undefined)]));
    const ticketStates = Object.fromEntries(tickets.sort().map(t => {
      const row = this.db.prepare("SELECT status,present FROM fleet_recovery_status WHERE ticket=?").get(t);
      return [t, !row ? "unobserved" : Number(row.present) ? String(row.status) : "absent"];
    }));
    const coordination = this.hasTable("fleet_coordination")
      ? this.db.prepare("SELECT blocker,record FROM fleet_coordination WHERE ticket=? ORDER BY blocker").all(ticket).map(r => [String(r.blocker), String(r.record)]) : [];
    // Same freshness rule as task admission: a stale ready record is an
    // offline machine, so its return must count as a gained capability.
    const capabilities = operational && this.hasTable("fleet_capabilities")
      ? [...new Set(this.db.prepare("SELECT record,updated FROM fleet_capabilities").all().flatMap(r => {
          const record = JSON.parse(String(r.record)) as { ready?: boolean; capabilities?: string[] };
          return record.ready && this.now() - Number(r.updated) < CAPABILITY_FRESH_MS ? record.capabilities ?? [] : [];
        }))].sort() : undefined;
    return { fingerprint, tasks: taskStates, tickets: ticketStates,
      coordination: coordination.length ? createHash("sha256").update(JSON.stringify(coordination)).digest("hex") : null,
      ...(capabilities ? { capabilities } : {}) };
  }
  private dependencies(ticket: string, decision: RecoveryDecision): { tasks: string[]; tickets: string[] } {
    // Assessments often name the repair they wait on only in prose. Accept a
    // 64-hex identifier from the reason only when it is a real recovery task.
    const named = this.hasTable("fleet_recovery_tasks") ? [...decision.reason.matchAll(/\b[a-f0-9]{64}\b/g)].map(m => m[0])
      .filter(id => this.db.prepare("SELECT 1 FROM fleet_recovery_tasks WHERE id=?").get(id)) : [];
    return { tasks: [...new Set([...decision.waitFor?.tasks ?? [], ...named])].slice(0, 10),
      tickets: [...new Set(decision.waitFor?.tickets ?? [])].filter(t => t !== ticket).slice(0, 10) };
  }
  private settle(incident: string, ticket: string, fingerprint: string, decision: RecoveryDecision, since?: number): RecoverySettlement {
    const created = this.now();
    const deps = this.dependencies(ticket, decision);
    const basis = this.basis(ticket, fingerprint, deps.tasks, deps.tickets, decision.action === "escalate");
    const digest = createHash("sha256").update(JSON.stringify(basis)).digest("hex");
    this.db.prepare("INSERT INTO fleet_recovery_settlement VALUES (?,?,?,?,?,?,NULL,NULL) ON CONFLICT(incident_id) DO NOTHING")
      .run(incident, ticket, JSON.stringify(basis), digest, created, (since ?? created) + this.safetyRecheckMs);
    return this.settlement(incident)!;
  }
  settlement(incident: string): RecoverySettlement | undefined {
    const r = this.db.prepare("SELECT * FROM fleet_recovery_settlement WHERE incident_id=?").get(incident);
    return r ? { incident: String(r.incident_id), ticket: String(r.ticket), created: Number(r.created), recheckAt: Number(r.recheck_at),
      basis: JSON.parse(String(r.basis)), digest: String(r.digest), reopened: r.reopened as string | null, reopenedAt: r.reopened_at as number | null } : undefined;
  }
  /**
   * Why a settled incident should be assessed again, or null while nothing it
   * depends on has changed. Ticket fingerprint changes are handled by the caller.
   */
  private reopenCause(old: Record<string, unknown>, decision: RecoveryDecision): string | null {
    const id = String(old.id);
    // Incidents settled before this policy are recorded against today's state.
    const settled = this.settlement(id) ?? this.settle(id, String(old.ticket), String(old.fingerprint), decision, Number(old.updated));
    if (decision.recheckAt !== undefined && this.now() >= decision.recheckAt) return "code deadline";
    if (this.now() >= settled.recheckAt) return "safety interval";
    const current = this.basis(settled.ticket, settled.basis.fingerprint, Object.keys(settled.basis.tasks), Object.keys(settled.basis.tickets), !!settled.basis.capabilities);
    const task = Object.keys(settled.basis.tasks).find(t => current.tasks[t] !== settled.basis.tasks[t]);
    if (task) return `dependency task ${task} ${current.tasks[task]}`;
    const ticket = Object.keys(settled.basis.tickets).find(t => current.tickets[t] !== settled.basis.tickets[t]);
    if (ticket) return `dependency ticket ${ticket} ${current.tickets[ticket]}`;
    if (current.coordination !== settled.basis.coordination) return "coordination record changed";
    const gained = current.capabilities?.find(c => !settled.basis.capabilities!.includes(c));
    if (gained) return `capability ${gained} ready`;
    return null;
  }
  private markReopened(incident: string, cause: string): void {
    this.db.prepare("UPDATE fleet_recovery_settlement SET reopened=?,reopened_at=? WHERE incident_id=? AND reopened IS NULL").run(cause.slice(0, 500), this.now(), incident);
  }
  escalatedTickets():string[] {
    return this.db.prepare("SELECT ticket FROM fleet_recovery WHERE present=1 AND state='escalated' ORDER BY ticket").all().map(r=>String(r.ticket));
  }
  list(project?: string): RecoveryIncident[] {
    const rows = project ? this.db.prepare("SELECT * FROM fleet_recovery WHERE ticket LIKE ? ORDER BY created DESC LIMIT 500").all(`${project}#%`)
      : this.db.prepare("SELECT * FROM fleet_recovery ORDER BY created DESC LIMIT 500").all();
    return rows.map(r => ({ id: String(r.id), ticket: String(r.ticket), fingerprint: String(r.fingerprint), reason: String(r.reason),
      state: r.state as RecoveryIncident["state"], created: Number(r.created), updated: Number(r.updated), runId: r.run_id as string | null,
      decision: r.decision ? JSON.parse(String(r.decision)) : null, current: r.present === 1 }))
      .map(i => { const settlement = this.settlement(i.id); return settlement ? { ...i, settlement } : i; })
      .map(i => {
        if (!i.current || !i.decision || i.state === "queued" || i.state === "resolved") return i;
        const quietRepeats = this.quietRepeats(i.ticket);
        const delay = this.quietDelay(quietRepeats, i.state === "waiting", i.state === "escalated" && i.decision.category === "human");
        return { ...i, cadence: { quietRepeats, nextQuietReassessAt: i.updated + delay } };
      });
  }
  report(machine: string, project: string, observations: RecoveryObservation[], fleet: FleetSnapshot, partial = false): RecoveryIncident[] {
    validateObservations(project, observations);
    const active = new Set(fleet.runs.map(r => r.ticket));
    const seen = new Set<string>();
    const newAlerts = new Set<string>();
    // Dependency tickets are compared by stage and presence, never by comment churn.
    for (const o of observations) this.db.prepare("INSERT INTO fleet_recovery_status VALUES (?,?,1) ON CONFLICT(ticket) DO UPDATE SET status=excluded.status,present=1").run(o.ticket, o.status);
    if (!partial) {
      const observed = new Set(observations.map(o => o.ticket));
      for (const row of this.db.prepare("SELECT ticket FROM fleet_recovery_status WHERE ticket LIKE ? AND present=1").all(`${project}#%`))
        if (!observed.has(String(row.ticket))) this.db.prepare("UPDATE fleet_recovery_status SET present=0 WHERE ticket=?").run(row.ticket);
    }
    for (const o of observations) {
      const owner = fleet.claims.find(c => c.ticket === o.ticket);
      if (owner && owner.machine !== machine) continue;
      seen.add(o.ticket);
      let old = this.db.prepare("SELECT * FROM fleet_recovery WHERE ticket=? AND present=1").get(o.ticket);
      const fingerprint = recoveryFingerprint(o);
      let progress = this.db.prepare("SELECT * FROM fleet_recovery_progress WHERE ticket=?").get(o.ticket);
      if (!progress || progress.fingerprint !== fingerprint) {
        this.db.prepare("INSERT INTO fleet_recovery_progress VALUES (?,?,?) ON CONFLICT(ticket) DO UPDATE SET fingerprint=excluded.fingerprint,since=excluded.since").run(o.ticket, fingerprint, this.now());
        progress = { since: this.now() };
      }
      // A retained run never authorises a second worker. It must not also hide
      // a stalled handback to Backlog or an uncertain crashed worker forever.
      const run = fleet.runs.find(r => r.ticket === o.ticket);
      const retainedAlert = old?.reason === RETAINED_RUN_REASON;
      // A new run or workflow progress also confirms the diagnosed stall ended.
      // Do not turn a resolved reservation diagnostic into an operator hold.
      if (old && retainedAlert && (old.run_id !== run?.id || old.fingerprint !== fingerprint)) {
        this.db.prepare("UPDATE fleet_recovery SET present=0,state='resolved',updated=? WHERE id=?").run(this.now(), old.id);
        old = undefined;
      }
      if (run) {
        // Only the run's own computer can inspect its child processes. On an
        // unowned ticket, such as during an assessment, others observe it too.
        if (run.machine === machine && this.now() - Math.max(Number(progress.since), run.created) >= RECOVERY_STALLED_RUN_MS
          && !["assessing", "applying"].includes(String(old?.state))
          && (!old || old.fingerprint !== fingerprint || ["queued", "complete", "resolved"].includes(String(old.state)))) {
          if (old) this.db.prepare("UPDATE fleet_recovery SET present=0 WHERE id=?").run(old.id);
          const id = randomUUID();
          this.db.prepare("INSERT INTO fleet_recovery VALUES (?,?,?,?,?,?,?,?,NULL,1)")
            .run(id, o.ticket, fingerprint, RETAINED_RUN_REASON, "escalated", this.now(), this.now(), run.id);
          newAlerts.add(id);
        }
        continue;
      }
      if (old && ["assessing", "applying"].includes(String(old.state))) {
        this.db.prepare("UPDATE fleet_recovery SET state='escalated', reason=?, updated=? WHERE id=?")
          .run("Recovery ended without a confirmed result; inspect before retrying", this.now(), old.id);
        newAlerts.add(String(old.id));
        continue;
      }
      let trigger = recoveryTrigger(o);
      // An agent run label. The repair marker (wip:repair) only says a repair run is due, so a ticket that
      // carries just that stays assessable: a repair that never starts must be able to reopen.
      const wip = hasRunningWip(o.labels);
      const upgraded = (o.assessmentPolicy ?? 0) >= RECOVERY_ASSESSMENT_POLICY;
      const policyRecorded = old && this.db.prepare("SELECT 1 FROM fleet_recovery_assessment_policy WHERE incident_id=? AND version>=?").get(old.id, RECOVERY_ASSESSMENT_POLICY);
      // A delayed old-worker observation cannot undo upgraded assessment work.
      // Only an upgraded worker receives that queued read-only offer below.
      const pauseInspection = (upgraded || !!policyRecorded) && canInspectUnknownPause(o);
      // A Backlog ticket whose work has started: owned, running, assigned a
      // repair, or refined. Refinement and assessments own nothing since
      // 2026-10-14, so a refined ticket or a refine repair that never starts
      // is recognised by its labels rather than by a claim.
      const backlogStarted = wip || !!owner || hasRepairMarker(o.labels) || hasRecoveryPriority(o.labels)
        || o.labels.some(l => l === "done:refiner" || l === "done:po");
      const workflowColumn = o.status === "Inbox" || o.status.startsWith("In ") || o.status === "Backlog" && backlogStarted;
      if ((!trigger || wip) && !o.blocked && workflowColumn && this.now() - Number(progress.since) >= (wip ? 3 : 24) * 3600000) {
        trigger = { reason: wip ? "Running label without a reservation; verify the worker stopped" : "No workflow progress for 24 hours", manual: wip };
      }
      if (old && trigger?.manual && !pauseInspection && old.state === "queued" && old.fingerprint === fingerprint) {
        this.db.prepare("UPDATE fleet_recovery SET state='escalated',reason=?,updated=? WHERE id=?").run(trigger.reason, this.now(), old.id);
        newAlerts.add(String(old.id));
        continue;
      }
      const legacyLimit = old?.state === "escalated" && ["Explicit operator hold", "Fleet recovery assessment daily limit reached",
        "Automatic repair budget exhausted: two fleet repairs and one per ticket per day"].includes(String(old.reason));
      // A settled wait or operational escalation is assessed again only when
      // something it depends on changed, at a code deadline, or after the long
      // safety interval. A changed ticket fingerprint is handled below.
      const oldDecision = old?.decision ? JSON.parse(String(old.decision)) as RecoveryDecision : null;
      const settledIncident = !!old && settles(String(old.state), oldDecision);
      const reopened = settledIncident && old!.fingerprint === fingerprint ? this.reopenCause(old!, oldDecision!) : null;
      const waited = !o.blocked && trigger && !IDLE_RECOVERY_REASONS.includes(trigger.reason)
        && old?.state === "complete" && oldDecision?.action === "wait" && !!reopened;
      const workflow = recoveryFingerprint({ ...o, evidenceRevision: undefined, artifactRevision: undefined, pause: undefined });
      const assessedWorkflow = this.db.prepare("SELECT fingerprint FROM fleet_recovery_workflow WHERE ticket=?").get(o.ticket);
      const taskFinished = old?.state === 'waiting' && !this.db.prepare("SELECT 1 FROM fleet_recovery_tasks WHERE ticket=? AND state IN ('queued','running','publishing','attention')").get(o.ticket);
      const evidenceChanged = !taskFinished && trigger && old && old.fingerprint !== fingerprint && assessedWorkflow?.fingerprint === workflow
        && this.now() - Number(old.updated) < this.reassess.baseMs;
      if (evidenceChanged && trigger && !trigger.manual) continue;
      if(old?.state==='waiting' && trigger?.manual) {
        this.db.prepare("UPDATE fleet_recovery SET state='escalated',reason=?,decision=?,updated=? WHERE id=?")
          .run(trigger.reason,JSON.stringify({action:'escalate',category:'human',reason:trigger.reason}),this.now(),old.id);
        newAlerts.add(String(old.id));continue;
      }
      if (old?.state === 'waiting' && this.db.prepare("SELECT 1 FROM fleet_recovery_tasks WHERE ticket=? AND state IN ('queued','running','publishing','attention')").get(o.ticket)) continue;
      const coordinated = old?.state === 'waiting' && !this.db.prepare("SELECT 1 FROM fleet_recovery_tasks WHERE ticket=? AND state IN ('queued','running','publishing','attention')").get(o.ticket);
      const operational = old?.state === 'escalated' && oldDecision?.category === 'operational' && !!reopened;
      const previousDecision = old?.decision ? JSON.parse(String(old.decision)) as RecoveryDecision : null;
      // Wait for the reporting worker to load the policy. Revisit only legacy
      // assessments, never a possibly applied repair or a classified human hold.
      const legacyAssessment = upgraded && old?.state === "escalated" && old.reason !== RETAINED_RUN_REASON
        && (!previousDecision || previousDecision.action === "escalate" && !previousDecision.category)
        && !policyRecorded;
      const recheck = (legacyLimit || waited || coordinated || operational || legacyAssessment)
        && trigger && (!trigger.manual || pauseInspection) && !wip;
      // A repeat assessment whose stage, recovery labels, blocked state and
      // pause record are what the last one saw: only comments, logs, task
      // results or dependencies moved. It waits a growing interval after the
      // last decision. A new error, a stage move or a manual trigger is never
      // held here, nor is a code deadline or the safety interval, which are
      // timers already, nor anything after an applied repair.
      const manualNow = !!trigger?.manual && !pauseInspection;
      // Why a settled incident reopened, also when its evidence moved meanwhile.
      const cause = !settledIncident ? null : reopened ?? (old!.fingerprint !== fingerprint ? this.reopenCause(old!, oldDecision!) : null);
      const timed = cause === "code deadline" || cause === "safety interval";
      const pauseKey = createHash("sha256").update(JSON.stringify(o.pause ?? null)).digest("hex");
      const cadence = this.db.prepare("SELECT pause FROM fleet_recovery_cadence WHERE ticket=?").get(o.ticket);
      const quiet = !!old && !!trigger && !manualNow && !(wip && !trigger.manual)
        && !["queued", "assessing", "applying"].includes(String(old.state)) && !!oldDecision
        && !["retry", "rework", "resume", "refine", "unblock"].includes(oldDecision.action)
        && assessedWorkflow?.fingerprint === workflow && (!cadence?.pause || cadence.pause === pauseKey)
        && (old.fingerprint !== fingerprint || recheck) && !timed;
      // A result the last decision waited for, its own repair task or a named
      // dependency, is read at once the first time; only repeats are spaced.
      const awaited = coordinated || (!!cause && /^(dependency |coordination |capability )/.test(cause));
      const human = old?.state === "escalated" && oldDecision?.category === "human";
      if (quiet && this.now() < Number(old!.updated) + this.quietDelay(this.quietRepeats(o.ticket), awaited, human)) continue;
      if (old && (!trigger || old.fingerprint !== fingerprint || recheck)) this.db.prepare("UPDATE fleet_recovery SET present=0, updated=CASE WHEN state='queued' THEN ? ELSE updated END, state=CASE WHEN state='queued' THEN 'resolved' ELSE state END WHERE id=?").run(this.now(), old.id);
      if (!trigger || old?.fingerprint === fingerprint && !recheck || (wip && !trigger.manual)) continue;
      if (old && settledIncident) this.markReopened(String(old.id), old.fingerprint !== fingerprint ? "ticket changed" : reopened ?? "reassessed");
      const id = randomUUID();
      this.db.prepare("INSERT INTO fleet_recovery_workflow VALUES (?,?) ON CONFLICT(ticket) DO UPDATE SET fingerprint=excluded.fingerprint").run(o.ticket, workflow);
      const manual = trigger.manual && !pauseInspection;
      // Count quiet repeats in a row. A timer keeps the count; any other
      // assessment starts it again.
      if (!manual) {
        const repeats = this.quietRepeats(o.ticket);
        this.db.prepare(`INSERT INTO fleet_recovery_cadence VALUES (?,?,?,?)
          ON CONFLICT(ticket) DO UPDATE SET streak=excluded.streak,updated=excluded.updated,pause=excluded.pause`)
          .run(o.ticket, quiet ? Math.min(repeats + 1, REASSESS_STREAK_CAP) : timed ? repeats : 0, this.now(), pauseKey);
      }
      this.db.prepare("INSERT INTO fleet_recovery VALUES (?,?,?,?,?,?,?,NULL,NULL,1)").run(id, o.ticket, fingerprint, trigger.reason, manual ? "escalated" : "queued", this.now(), this.now());
      if (upgraded || pauseInspection) this.db.prepare("INSERT INTO fleet_recovery_assessment_policy VALUES (?,?)").run(id, RECOVERY_ASSESSMENT_POLICY);
      if (manual) newAlerts.add(id);
    }
    for (const row of partial ? [] : this.db.prepare("SELECT id,ticket FROM fleet_recovery WHERE ticket LIKE ? AND present=1").all(`${project}#%`)) {
      const ticket = String(row.ticket);
      if (!seen.has(ticket) && !active.has(ticket) && !fleet.claims.some(c => c.ticket === ticket && c.machine !== machine)) {
        this.db.prepare("UPDATE fleet_recovery SET present=0, state=CASE WHEN state='queued' THEN 'resolved' ELSE state END, updated=? WHERE id=?").run(this.now(), row.id);
      }
    }
    return this.list(project).filter(i => newAlerts.has(i.id) || (i.state === "queued" && seen.has(i.ticket)
      && (i.reason !== RECOVERY_UNKNOWN_PAUSE_REASON || (observations.find(o => o.ticket === i.ticket)?.assessmentPolicy ?? 0) >= RECOVERY_ASSESSMENT_POLICY)
      && !hasRunningWip(observations.find(o => o.ticket === i.ticket)?.labels ?? [])
      && (!active.has(i.ticket) || fleet.runs.some(r => r.ticket === i.ticket && r.role === "recovery" && r.machine === machine))));
  }
  incident(id: string): RecoveryIncident {
    const r = this.db.prepare("SELECT * FROM fleet_recovery WHERE id=?").get(id);
    if (!r) throw new Error("Unknown recovery incident");
    return { id: String(r.id), ticket: String(r.ticket), fingerprint: String(r.fingerprint), reason: String(r.reason),
      state: r.state as RecoveryIncident["state"], created: Number(r.created), updated: Number(r.updated), runId: r.run_id as string | null,
      decision: r.decision ? JSON.parse(String(r.decision)) : null };
  }
  begin(id: string, runId: string): RecoveryIncident {
    const incident = this.incident(id);
    // A lost response can retrieve the same attempt, never create another.
    if (incident.runId === runId && incident.state === "assessing") return incident;
    if (incident.state !== "queued") throw new Error("Recovery incident is not queued");
    this.db.prepare("UPDATE fleet_recovery SET state='assessing', run_id=?, updated=? WHERE id=?").run(runId, this.now(), id);
    return this.incident(id);
  }
  decide(id: string, runId: string, value: RecoveryDecision): RecoveryDecision {
    const incident = this.incident(id);
    if (incident.runId !== runId) throw new Error("Recovery run mismatch");
    if (incident.decision) return incident.decision;
    if (incident.state !== "assessing") throw new Error("Recovery is not being assessed");
    let decision = validateRecoveryDecision(value);
    // Two failed dispatcher repairs end automatic repair for the ticket (recovery-repair-cap.ts).
    if (decision.action === "coordinate" && decision.task?.recipe === "dispatcher-repair") {
      const cap = dispatcherRepairCap(this.db, incident.ticket, currentWorkflow(this.db, incident.ticket), this.now(), decision.task);
      if (cap.capped) { decision = { action: "escalate", category: "human", reason: cap.reason }; withdrawCappedRepairs(this.db, incident.ticket, this.now()); }
    }
    if (["retry", "rework", "resume", "refine", "unblock"].includes(decision.action)) {
      const repairs = this.db.prepare("SELECT count(*) AS n FROM fleet_recovery WHERE ticket=? AND decision IS NOT NULL AND updated>? AND json_extract(decision,'$.action') IN ('retry','rework','resume','refine','unblock')").get(incident.ticket, this.now() - 86400000)!;
      if (Number(repairs.n) >= RECOVERY_REPAIRS_PER_TICKET) {
        const first=this.db.prepare("SELECT min(updated) AS at FROM fleet_recovery WHERE ticket=? AND decision IS NOT NULL AND updated>? AND json_extract(decision,'$.action') IN ('retry','rework','resume','refine','unblock')").get(incident.ticket,this.now()-86400000)!;
        decision={action:'escalate',category:'operational',reason:'Automatic repair budget exhausted: three repairs per ticket per rolling day',recheckAt:Number(first.at)+86400001};
      }
    }
    if (decision.cooldown) {
      const { cooldown: _, ...rest } = decision;
      decision = { ...rest, recheckAt: this.now() + RECOVERY_RECHECK_MS };
    }
    const state = ["retry", "rework", "split", "resume", "refine", "unblock"].includes(decision.action) ? "applying" : decision.action === "coordinate" ? "waiting" : decision.action === "wait" ? "complete" : "escalated";
    this.db.prepare("UPDATE fleet_recovery SET state=?, decision=?, updated=? WHERE id=?").run(state, JSON.stringify(decision), this.now(), id);
    if (settles(state, decision)) this.settle(id, incident.ticket, incident.fingerprint, decision);
    return decision;
  }
  complete(id: string, runId: string): void {
    const incident = this.incident(id);
    if (incident.runId !== runId) throw new Error("Recovery run mismatch");
    if (incident.state === "applying") this.db.prepare("UPDATE fleet_recovery SET state='complete', updated=? WHERE id=?").run(this.now(), id);
  }
}
