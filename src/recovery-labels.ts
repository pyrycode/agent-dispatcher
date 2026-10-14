/**
 * Recovery labels. Kept free of imports (bar the dependency-free colour table) so the scheduler, the effort policy,
 * the central store and the publisher can all read them.
 *
 * `orchestrator:fixing` had two jobs until 2026-10-14. It gave every later
 * stage of an assigned repair recovery priority, and people read it as "being
 * repaired now". The two jobs now have their own labels. The active repair
 * label was first `orchestrator:repairing` and became `wip:repair` the same
 * day, so that every board tool that already reads `wip:` as "busy" shows it.
 */
import { labelColor } from "./label-colors.js";

export const RECOVERY_INVESTIGATING = "orchestrator:investigating";
/** An assigned repair. Scheduler priority and builder effort, until Done, a hold, a new error or an escalation. */
export const RECOVERY_PRIORITY = "orchestrator:recovery-priority";
/**
 * The assigned repair run itself: from the handback until that stage's first run finishes.
 * It is a `wip:` label, so a ticket carrying it is busy for takeover, halt and the
 * board watch. It is NOT an agent run: see isRepairWip and hasRunningWip.
 */
export const RECOVERY_REPAIRING = "wip:repair";
/** The first name of the repair label (PR 238). Readers accept it; the central store rewrites it at start. */
export const LEGACY_RECOVERY_REPAIRING = "orchestrator:repairing";
/** The old name of RECOVERY_PRIORITY. Every reader treats it as the same label. */
export const LEGACY_RECOVERY_PRIORITY = "orchestrator:fixing";
/**
 * Dispatchers older than this release read only the old name. While any of
 * them may run, handbacks write both names and the store keeps both. Turn this
 * off only once every dispatcher and manager carries this release. The central
 * store then removes the old name from saved tickets at its next start.
 */
export const WRITE_LEGACY_RECOVERY_PRIORITY = true;

export const RECOVERY_PRIORITY_LABELS: readonly string[] = [RECOVERY_PRIORITY, LEGACY_RECOVERY_PRIORITY];
/** Both names of the active repair label. Writers use RECOVERY_REPAIRING, readers and cleanup take either. */
export const RECOVERY_REPAIRING_LABELS: readonly string[] = [RECOVERY_REPAIRING, LEGACY_RECOVERY_REPAIRING];
/** Labels written by a handback, in write order. */
export const RECOVERY_ASSIGNMENT_LABELS: readonly string[] = [RECOVERY_PRIORITY, LEGACY_RECOVERY_PRIORITY, RECOVERY_REPAIRING, LEGACY_RECOVERY_REPAIRING];

/** True for the active repair label under either name. */
export function isRepairWip(label: string): boolean {
  return RECOVERY_REPAIRING_LABELS.includes(label);
}

/** True when a ticket carries the active repair label under either name. */
export function hasRepairMarker(labels: readonly string[]): boolean {
  return labels.some(isRepairWip);
}

/**
 * True when an agent run holds the ticket: any `wip:` label except the repair
 * marker. A ticket waiting for its repair run carries the marker and no agent
 * label yet, so this is the right test wherever the question is "is a worker
 * running, or did one strand a label" (the stranded sweep, retry waiting, the
 * recovery stuck-label trigger). "Is the ticket busy" is any `wip:` label,
 * the repair marker included.
 */
export function hasRunningWip(labels: readonly string[]): boolean {
  return labels.some(l => l.startsWith("wip:") && !isRepairWip(l));
}

/** Recovery decisions that assign a repair, and so recovery priority. */
export const RECOVERY_REPAIR_ACTIONS: readonly string[] = ["retry", "rework", "resume", "refine", "unblock", "coordinate"];
/**
 * Decisions that hand the ticket to an ordinary stage run: the failed stage
 * for retry, the builder or developer for rework, the recorded stage for
 * resume and the refiner for refine. Unblock only removes a blocker and
 * coordinate runs a task on another computer, so neither assigns a run.
 */
export const RECOVERY_REPAIR_RUN_ACTIONS: readonly string[] = ["retry", "rework", "resume", "refine"];

export function hasRecoveryPriority(labels: readonly string[]): boolean {
  return labels.some(l => RECOVERY_PRIORITY_LABELS.includes(l));
}

/** The labels a handback writes for one decision. */
export function recoveryAssignmentLabels(action: string): string[] {
  if (!RECOVERY_REPAIR_ACTIONS.includes(action)) return [];
  return [RECOVERY_PRIORITY, ...(WRITE_LEGACY_RECOVERY_PRIORITY ? [LEGACY_RECOVERY_PRIORITY] : []),
    ...(RECOVERY_REPAIR_RUN_ACTIONS.includes(action) ? [RECOVERY_REPAIRING] : [])];
}

/** GitHub label definitions used when the publisher first creates a label. Colours come from the shared label scheme. */
export const RECOVERY_LABEL_DEFINITIONS: Readonly<Record<string, { color: string; description: string }>> = {
  [RECOVERY_PRIORITY]: { color: labelColor(RECOVERY_PRIORITY), description: "Orchestrator repair assigned. Its stages get recovery priority until Done, a hold or a new error." },
  [RECOVERY_REPAIRING]: { color: labelColor(RECOVERY_REPAIRING), description: "The assigned repair run is waiting to start or running now. Busy like any wip label." },
};
