/**
 * Recovery labels. Kept free of imports (bar the dependency-free colour table) so the scheduler, the effort policy,
 * the central store and the publisher can all read them.
 *
 * `orchestrator:fixing` had two jobs until 2026-10-14. It gave every later
 * stage of an assigned repair recovery priority, and people read it as "being
 * repaired now". The two jobs now have their own labels.
 */
import { labelColor } from "./label-colors.js";

export const RECOVERY_INVESTIGATING = "orchestrator:investigating";
/** An assigned repair. Scheduler priority and builder effort, until Done, a hold, a new error or an escalation. */
export const RECOVERY_PRIORITY = "orchestrator:recovery-priority";
/** The assigned repair run itself: from the handback until that stage's first run finishes. */
export const RECOVERY_REPAIRING = "orchestrator:repairing";
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
/** Labels written by a handback, in write order. */
export const RECOVERY_ASSIGNMENT_LABELS: readonly string[] = [RECOVERY_PRIORITY, LEGACY_RECOVERY_PRIORITY, RECOVERY_REPAIRING];

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
  [RECOVERY_REPAIRING]: { color: labelColor(RECOVERY_REPAIRING), description: "The repair run the orchestrator assigned is waiting to start or running now." },
};
