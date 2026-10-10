import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FleetSnapshot } from "./fleet-store.js";

export interface RecoveryObservation {
  ticket: string; status: string; labels: string[]; blocked: boolean;
}
export type RecoveryAction = "wait" | "retry" | "rework" | "escalate";
export interface RecoveryDecision { action: RecoveryAction; reason: string }
export interface RecoveryIncident {
  id: string; ticket: string; fingerprint: string; reason: string;
  state: "queued" | "assessing" | "applying" | "complete" | "escalated" | "resolved";
  created: number; updated: number; runId: string | null; decision: RecoveryDecision | null;
}

export const RECOVERY_RECHECK_MS = 30 * 60_000;
export const RECOVERY_REPAIRS_PER_TICKET = 3;
export function hasOperatorHold(labels: readonly string[]): boolean {
  return labels.some(l => l.startsWith("needs-human:") && l !== "needs-human:sizing");
}

export function validateObservations(project: string, observations: RecoveryObservation[]): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(project) || !Array.isArray(observations) || observations.length > 5000) throw new Error("Invalid recovery report");
  const seen = new Set<string>();
  for (const o of observations) {
    if (!o || !o.ticket.startsWith(`${project}#`) || !/^[1-9]\d*$/.test(o.ticket.slice(project.length + 1)) || seen.has(o.ticket)
      || typeof o.status !== "string" || o.status.length > 100 || typeof o.blocked !== "boolean"
      || !Array.isArray(o.labels) || o.labels.length > 200 || o.labels.some(l => typeof l !== "string" || l.length > 200)) throw new Error("Invalid recovery observation");
    seen.add(o.ticket);
  }
}
export function recoveryFingerprint(o: RecoveryObservation): string {
  return createHash("sha256").update(JSON.stringify([o.status, o.blocked,
    o.labels.filter(l => /^(error:|needs-human:|rework-count:|done:|needs-rework:|needs-real-claude$)/.test(l)).sort()])).digest("hex");
}
export function recoveryTrigger(o: RecoveryObservation): { reason: string; manual: boolean } | null {
  if (o.status === "Done") return null;
  if (o.status === "Halted" || hasOperatorHold(o.labels)) return { reason: "Explicit operator hold", manual: true };
  if (o.labels.some(l => /permission_denied|family-breaker/.test(l))) return { reason: "Permission or family boundary needs an operator", manual: true };
  // These waits already have dedicated bounded recovery. Do not buy another retry budget.
  if (o.blocked || o.labels.some(l => l.startsWith("error-retry-count:") || l.startsWith("health-hold:"))) return null;
  const errors = o.labels.filter(l => l.startsWith("error:"));
  if (errors.length) return { reason: errors.sort().join(", "), manual: false };
  if (o.labels.some(l => /^rework-count:\d+$/.test(l) && Number(l.split(":")[1]) >= 2)) return { reason: "Repeated review rework", manual: false };
  return null;
}
export function validateRecoveryDecision(value: unknown): RecoveryDecision {
  const d = value as RecoveryDecision;
  if (!d || !["wait", "retry", "rework", "escalate"].includes(d.action) || typeof d.reason !== "string" || !d.reason.trim() || d.reason.length > 6000) throw new Error("Invalid recovery decision");
  return { action: d.action, reason: d.reason };
}

/** Uses the claim authority's database. No independent watcher can race this ledger. */
export class RecoveryLedger {
  constructor(private db: DatabaseSync, private now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_recovery (
      id TEXT PRIMARY KEY, ticket TEXT NOT NULL, fingerprint TEXT NOT NULL, reason TEXT NOT NULL,
      state TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      run_id TEXT, decision TEXT, present INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS fleet_recovery_current ON fleet_recovery(ticket) WHERE present=1;
    CREATE TABLE IF NOT EXISTS fleet_recovery_progress (
      ticket TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, since INTEGER NOT NULL
    ) STRICT;`);
  }
  list(project?: string): RecoveryIncident[] {
    const rows = project ? this.db.prepare("SELECT * FROM fleet_recovery WHERE ticket LIKE ? ORDER BY created DESC LIMIT 500").all(`${project}#%`)
      : this.db.prepare("SELECT * FROM fleet_recovery ORDER BY created DESC LIMIT 500").all();
    return rows.map(r => ({ id: String(r.id), ticket: String(r.ticket), fingerprint: String(r.fingerprint), reason: String(r.reason),
      state: r.state as RecoveryIncident["state"], created: Number(r.created), updated: Number(r.updated), runId: r.run_id as string | null,
      decision: r.decision ? JSON.parse(String(r.decision)) : null }));
  }
  report(machine: string, project: string, observations: RecoveryObservation[], fleet: FleetSnapshot): RecoveryIncident[] {
    validateObservations(project, observations);
    const active = new Set(fleet.runs.map(r => r.ticket));
    const seen = new Set<string>();
    const newAlerts = new Set<string>();
    for (const o of observations) {
      const owner = fleet.claims.find(c => c.ticket === o.ticket);
      if (owner && owner.machine !== machine) continue;
      seen.add(o.ticket);
      const old = this.db.prepare("SELECT * FROM fleet_recovery WHERE ticket=? AND present=1").get(o.ticket);
      const fingerprint = recoveryFingerprint(o);
      let progress = this.db.prepare("SELECT * FROM fleet_recovery_progress WHERE ticket=?").get(o.ticket);
      if (!progress || progress.fingerprint !== fingerprint) {
        this.db.prepare("INSERT INTO fleet_recovery_progress VALUES (?,?,?) ON CONFLICT(ticket) DO UPDATE SET fingerprint=excluded.fingerprint,since=excluded.since").run(o.ticket, fingerprint, this.now());
        progress = { since: this.now() };
      }
      // A run, including an uncertain crashed run, keeps its incident and reservation.
      if (active.has(o.ticket)) continue;
      if (old && ["assessing", "applying"].includes(String(old.state))) {
        this.db.prepare("UPDATE fleet_recovery SET state='escalated', reason=?, updated=? WHERE id=?")
          .run("Recovery ended without a confirmed result; inspect before retrying", this.now(), old.id);
        newAlerts.add(String(old.id));
        continue;
      }
      let trigger = recoveryTrigger(o);
      const wip = o.labels.some(l => l.startsWith("wip:"));
      if ((!trigger || wip) && !o.blocked && o.status.startsWith("In ") && this.now() - Number(progress.since) >= (wip ? 3 : 24) * 3600000) {
        trigger = { reason: wip ? "Running label without a reservation; verify the worker stopped" : "No workflow progress for 24 hours", manual: true };
      }
      if (old && trigger?.manual && old.state === "queued" && old.fingerprint === fingerprint) {
        this.db.prepare("UPDATE fleet_recovery SET state='escalated',reason=?,updated=? WHERE id=?").run(trigger.reason, this.now(), old.id);
        newAlerts.add(String(old.id));
        continue;
      }
      const legacyLimit = old?.state === "escalated" && ["Explicit operator hold", "Fleet recovery assessment daily limit reached",
        "Automatic repair budget exhausted: two fleet repairs and one per ticket per day"].includes(String(old.reason));
      const waited = old?.state === "complete" && old.decision && JSON.parse(String(old.decision)).action === "wait"
        && this.now() - Number(old.updated) >= RECOVERY_RECHECK_MS;
      const recheck = (legacyLimit || waited) && trigger && !trigger.manual && !wip;
      if (old && (!trigger || old.fingerprint !== fingerprint || recheck)) this.db.prepare("UPDATE fleet_recovery SET present=0, updated=CASE WHEN state='queued' THEN ? ELSE updated END, state=CASE WHEN state='queued' THEN 'resolved' ELSE state END WHERE id=?").run(this.now(), old.id);
      if (!trigger || old?.fingerprint === fingerprint && !recheck || (wip && !trigger.manual)) continue;
      const id = randomUUID();
      this.db.prepare("INSERT INTO fleet_recovery VALUES (?,?,?,?,?,?,?,NULL,NULL,1)").run(id, o.ticket, fingerprint, trigger.reason, trigger.manual ? "escalated" : "queued", this.now(), this.now());
      if (trigger.manual) newAlerts.add(id);
    }
    for (const row of this.db.prepare("SELECT id,ticket FROM fleet_recovery WHERE ticket LIKE ? AND present=1").all(`${project}#%`)) {
      const ticket = String(row.ticket);
      if (!seen.has(ticket) && !active.has(ticket) && !fleet.claims.some(c => c.ticket === ticket && c.machine !== machine)) {
        this.db.prepare("UPDATE fleet_recovery SET present=0, state=CASE WHEN state='queued' THEN 'resolved' ELSE state END, updated=? WHERE id=?").run(this.now(), row.id);
      }
    }
    return this.list(project).filter(i => newAlerts.has(i.id) || (i.state === "queued" && seen.has(i.ticket)
      && !observations.find(o => o.ticket === i.ticket)?.labels.some(l => l.startsWith("wip:"))
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
    if (decision.action === "retry" || decision.action === "rework") {
      const repairs = this.db.prepare("SELECT count(*) AS n FROM fleet_recovery WHERE ticket=? AND decision IS NOT NULL AND updated>? AND json_extract(decision,'$.action') IN ('retry','rework')").get(incident.ticket, this.now() - 86400000)!;
      if (Number(repairs.n) >= RECOVERY_REPAIRS_PER_TICKET) decision = { action: "escalate", reason: "Automatic repair budget exhausted: three repairs per ticket per rolling day" };
    }
    this.db.prepare("UPDATE fleet_recovery SET state=?, decision=?, updated=? WHERE id=?").run(
      ["retry", "rework"].includes(decision.action) ? "applying" : decision.action === "wait" ? "complete" : "escalated", JSON.stringify(decision), this.now(), id);
    return decision;
  }
  complete(id: string, runId: string): void {
    const incident = this.incident(id);
    if (incident.runId !== runId) throw new Error("Recovery run mismatch");
    if (incident.state === "applying") this.db.prepare("UPDATE fleet_recovery SET state='complete', updated=? WHERE id=?").run(this.now(), id);
  }
}
