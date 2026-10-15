// A cap on automatic dispatcher repairs for one ticket.
//
// Overnight 2026-10-14 to 2026-10-15 the recovery orchestrator ordered 21
// dispatcher-repair tasks for six Core tickets, and 22 more for Desktop and
// Mobile. Each failed its checks, its independent review or its publication,
// each assessment wrote a longer brief, and the next one ordered another
// repair. After two failed attempts more of the same is not progress: the
// ticket goes to a person with a short account of what was tried.
//
// Two failures count against a ticket when they share the incident's
// fingerprint (the ticket's stage and recovery labels did not move between
// them) or when both ended within the last 24 hours. A repair that completed,
// merged or superseded because main moved on, starts the count again. Only
// failures of the repair's own work count: checks, independent review,
// publication and an implementation that did not finish. An interrupted
// worker that never wrote a result is infrastructure, not an attempt.
//
// Only `dispatcher-repair` is capped. Other recovery actions keep their own
// rules (the per-ticket repair budget in fleet-recovery.ts).

import type { DatabaseSync } from "node:sqlite";
import { recoveryTaskId, type RecoveryTaskRequest } from "./recovery-tasks.js";

export const REPAIR_CAP_FAILURES = 2;
export const REPAIR_CAP_WINDOW_MS = 24 * 3600_000;
export const REPAIR_CAP_REASON = "Dispatcher repair cap reached";

export type RepairFailureKind = "checks failed" | "independent review failed" | "publication refused" | "implementation did not complete" | "repair did not complete";

/** What a failed repair's summary says went wrong, or null when it is not a failure of the repair's own work. */
export function repairFailureKind(summary: string): RepairFailureKind | null {
  if (/publication refused/i.test(summary)) return "publication refused";
  if (!/^Dispatcher repair did not complete:/.test(summary)) return null;
  if (/Independent review/.test(summary)) return "independent review failed";
  if (/Check failed/.test(summary)) return "checks failed";
  if (/Implementation did not complete/.test(summary)) return "implementation did not complete";
  return "repair did not complete";
}

export interface RepairAttempt { id: string; revision: string | null; ended: number; kind: RepairFailureKind }
export type RepairCap = { capped: false } | { capped: true; attempts: RepairAttempt[]; reason: string };

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/**
 * Whether another dispatcher repair may be ordered for `ticket`, whose
 * current incident has `fingerprint`. Reads the authority's own tables.
 */
export function dispatcherRepairCap(db: DatabaseSync, ticket: string, fingerprint: string | null, now: number, requested?: RecoveryTaskRequest): RepairCap {
  if (!hasTable(db, "fleet_recovery_tasks")) return { capped: false };
  const tasks = db.prepare("SELECT id,request,state,created,updated,result FROM fleet_recovery_tasks WHERE ticket=? AND json_extract(request,'$.recipe')='dispatcher-repair' ORDER BY created,id").all(ticket)
    .map(r => ({ id: String(r.id), request: JSON.parse(String(r.request)) as RecoveryTaskRequest, state: String(r.state),
      created: Number(r.created), updated: Number(r.updated), summary: r.result ? String(JSON.parse(String(r.result)).summary ?? "") : "" }));
  // A completed repair, merged or overtaken by main, starts the count again.
  const reset = Math.max(-Infinity, ...tasks.filter(t => t.state === "complete").map(t => t.updated));
  const failures = tasks.flatMap(t => {
    const kind = t.state === "failed" && t.created > reset ? repairFailureKind(t.summary) : null;
    return kind ? [{ id: t.id, revision: t.request.revision ?? null, ended: t.updated, kind }] : [];
  });
  if (failures.length < REPAIR_CAP_FAILURES) return { capped: false };
  // Tasks the incidents with this fingerprint ordered. A task's id is derived from its incident.
  const sameFingerprint = new Set<string>();
  if (fingerprint !== null && hasTable(db, "fleet_recovery")) {
    for (const r of db.prepare("SELECT id,decision FROM fleet_recovery WHERE ticket=? AND fingerprint=? AND json_extract(decision,'$.action')='coordinate' AND json_extract(decision,'$.task.recipe')='dispatcher-repair'").all(ticket, fingerprint)) {
      sameFingerprint.add(recoveryTaskId(ticket, JSON.parse(String(r.decision)).task, String(r.id)));
    }
  }
  const byFingerprint = failures.filter(f => sameFingerprint.has(f.id));
  const recent = failures.filter(f => now - f.ended < REPAIR_CAP_WINDOW_MS);
  const counted = byFingerprint.length >= REPAIR_CAP_FAILURES ? byFingerprint : recent.length >= REPAIR_CAP_FAILURES ? recent : null;
  if (!counted) return { capped: false };
  const scope = counted === byFingerprint ? "for this incident" : "for this ticket in the last 24 hours";
  const attempts = counted.map((a, i) => `${i + 1}) task ${a.id.slice(0, 8)} on ${a.revision?.slice(0, 8) ?? "no revision"}, ended ${new Date(a.ended).toISOString().slice(0, 16)}Z: ${a.kind}`);
  const brief = requested?.reason ? ` The repair this assessment asked for: ${requested.reason.replace(/\s+/g, " ").slice(0, 600)}` : "";
  const reason = `${REPAIR_CAP_REASON}: ${counted.length} failed dispatcher repairs ${scope}. No further dispatcher repair is ordered automatically until one succeeds or the failures are older than 24 hours; a person decides the next step. Attempts: ${attempts.join("; ")}.${brief}`;
  return { capped: true, attempts: counted, reason: reason.slice(0, 6000) };
}
