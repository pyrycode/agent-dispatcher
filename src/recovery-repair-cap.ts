// A cap on automatic dispatcher repairs for one ticket.
//
// Overnight 2026-10-14 to 2026-10-15 the recovery orchestrator ordered 21
// dispatcher-repair tasks for six Core tickets, and 22 more for Desktop and
// Mobile. Each failed its checks, its independent review or its publication,
// each assessment wrote a longer brief, and the next one ordered another
// repair. After two failed attempts more of the same is not progress: the
// ticket goes to a person with a short account of what was tried.
//
// Two failures count against a ticket when both were ordered while its
// workflow fingerprint (stage, recovery labels and blockers, without the
// evidence and task results that change with every attempt) was what it is
// now, or when both ended within the last 24 hours. A repair that completed,
// merged or overtaken by main, starts the count again. Only failures of the
// repair's own work count: its checks, its independent review and its
// publication. An unfinished implementation, which is also how a Codex rate
// limit or a runner error ends, and an interrupted worker that never wrote a
// result are not counted.
//
// At the cap, the ticket's queued dispatcher repairs are withdrawn (ended as
// failed with a summary that does not count) and none starts.
//
// Only `dispatcher-repair` is capped. Other recovery actions keep their own
// rules (the per-ticket repair budget in fleet-recovery.ts).

import type { DatabaseSync } from "node:sqlite";
import type { RecoveryTaskRequest } from "./recovery-tasks.js";

export const REPAIR_CAP_FAILURES = 2;
export const REPAIR_CAP_WINDOW_MS = 24 * 3600_000;
export const REPAIR_CAP_REASON = "Dispatcher repair cap reached";

export type RepairFailureKind = "checks failed" | "independent review failed" | "publication refused";

/** What a failed repair's summary says went wrong, or null when it is not a counted failure of the repair's own work. */
export function repairFailureKind(summary: string): RepairFailureKind | null {
  if (/^(Repair publication refused|Publication refused):/.test(summary)) return "publication refused";
  if (!/^Dispatcher repair did not complete:/.test(summary)) return null;
  if (/Independent review/.test(summary)) return "independent review failed";
  if (/Check failed/.test(summary)) return "checks failed";
  return null;
}

export interface RepairAttempt { id: string; revision: string | null; ended: number; kind: RepairFailureKind }
export type RepairCap = { capped: false } | { capped: true; attempts: RepairAttempt[]; reason: string };

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** The ticket's current workflow fingerprint, as the recovery ledger last recorded it. */
export function currentWorkflow(db: DatabaseSync, ticket: string): string | null {
  if (!hasTable(db, "fleet_recovery_workflow")) return null;
  const row = db.prepare("SELECT fingerprint FROM fleet_recovery_workflow WHERE ticket=?").get(ticket);
  return row ? String(row.fingerprint) : null;
}

/** Remember the workflow fingerprint a dispatcher repair was ordered under. First record wins. */
export function recordRepairWorkflow(db: DatabaseSync, task: string, ticket: string, workflow: string | null): void {
  db.exec("CREATE TABLE IF NOT EXISTS fleet_repair_workflow (task TEXT PRIMARY KEY, ticket TEXT NOT NULL, workflow TEXT) STRICT");
  db.prepare("INSERT OR IGNORE INTO fleet_repair_workflow VALUES (?,?,?)").run(task, ticket, workflow);
}

/**
 * Whether another dispatcher repair may be ordered or started for `ticket`,
 * whose workflow fingerprint is now `workflow`. Reads the authority's own tables.
 */
export function dispatcherRepairCap(db: DatabaseSync, ticket: string, workflow: string | null, now: number, requested?: RecoveryTaskRequest): RepairCap {
  if (!hasTable(db, "fleet_recovery_tasks")) return { capped: false };
  const recorded = hasTable(db, "fleet_repair_workflow");
  const tasks = db.prepare(`SELECT t.id,t.request,t.state,t.created,t.updated,t.result,${recorded ? "w.workflow" : "NULL"} AS workflow
    FROM fleet_recovery_tasks t ${recorded ? "LEFT JOIN fleet_repair_workflow w ON w.task=t.id" : ""}
    WHERE t.ticket=? AND json_extract(t.request,'$.recipe')='dispatcher-repair' ORDER BY t.created,t.id`).all(ticket)
    .map(r => ({ id: String(r.id), request: JSON.parse(String(r.request)) as RecoveryTaskRequest, state: String(r.state),
      created: Number(r.created), updated: Number(r.updated), workflow: r.workflow === null ? null : String(r.workflow),
      summary: r.result ? String(JSON.parse(String(r.result)).summary ?? "") : "" }));
  // A completed repair, merged or overtaken by main, starts the count again.
  const reset = Math.max(-Infinity, ...tasks.filter(t => t.state === "complete").map(t => t.updated));
  const failures = tasks.flatMap(t => {
    const kind = t.state === "failed" && t.created > reset ? repairFailureKind(t.summary) : null;
    return kind ? [{ id: t.id, revision: t.request.revision ?? null, ended: t.updated, kind, workflow: t.workflow }] : [];
  });
  const unchanged = workflow === null ? [] : failures.filter(f => f.workflow === workflow);
  const recent = failures.filter(f => now - f.ended < REPAIR_CAP_WINDOW_MS);
  const counted = unchanged.length >= REPAIR_CAP_FAILURES ? unchanged : recent.length >= REPAIR_CAP_FAILURES ? recent : null;
  if (!counted) return { capped: false };
  const scope = counted === unchanged ? "with the ticket's stage and recovery labels unchanged" : "for this ticket in the last 24 hours";
  const attempts = counted.map((a, i) => `${i + 1}) task ${a.id.slice(0, 8)} on ${a.revision?.slice(0, 8) ?? "no revision"}, ended ${new Date(a.ended).toISOString().slice(0, 16)}Z: ${a.kind}`);
  const brief = requested?.reason ? ` The repair this assessment asked for: ${requested.reason.replace(/\s+/g, " ").slice(0, 600)}` : "";
  const reason = `${REPAIR_CAP_REASON}: ${counted.length} failed dispatcher repairs ${scope}. No further dispatcher repair is ordered or started automatically; a person decides the next step. Attempts: ${attempts.join("; ")}.${brief}`;
  return { capped: true, attempts: counted.map(({ workflow: _, ...a }) => a), reason: reason.slice(0, 6000) };
}

export const REPAIR_WITHDRAWN_SUMMARY = "Withdrawn before it started: dispatcher repair cap reached. No further dispatcher repair runs for this ticket automatically.";

/**
 * End the ticket's queued dispatcher repairs once the cap is reached, so an
 * assessment waiting on them reopens and escalates instead of waiting on work
 * that can never start. A withdrawal is not a counted failure. Returns the ids.
 */
export function withdrawCappedRepairs(db: DatabaseSync, ticket: string, now: number): string[] {
  if (!hasTable(db, "fleet_recovery_tasks") || !dispatcherRepairCap(db, ticket, currentWorkflow(db, ticket), now).capped) return [];
  const queued = db.prepare("SELECT id FROM fleet_recovery_tasks WHERE ticket=? AND state='queued' AND json_extract(request,'$.recipe')='dispatcher-repair'").all(ticket).map(r => String(r.id));
  const result = JSON.stringify({ outcome: "failed", summary: REPAIR_WITHDRAWN_SUMMARY, files: {} });
  for (const id of queued) db.prepare("UPDATE fleet_recovery_tasks SET state='failed',result=?,updated=? WHERE id=? AND state='queued'").run(result, now, id);
  return queued;
}
