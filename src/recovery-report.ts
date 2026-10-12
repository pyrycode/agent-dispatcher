import type { RecoveryIncident } from "./fleet-recovery.js";
import { scrubCredentials } from "./agent-runtime.js";

/** One fleet-wide decision list, independent of board columns or historical resolved alerts. */
export function recoveryReport(incidents: RecoveryIncident[], machine: { projects?: Array<{ project: string; health: string }>; attention?: unknown[] }) {
  const current = incidents.filter(i => i.current !== false && !["resolved", "complete"].includes(i.state));
  const decisions = current.filter(i => i.state === "escalated" && i.reason !== "Explicit operator hold").map(i => ({
    id: i.id, ticket: i.ticket, url: `https://github.com/${i.ticket.replace("#", "/issues/")}`,
    kind: i.decision?.action === "propose-close" ? "closure-proposal" : i.decision?.category==='operational' ? 'automatic-wait' : "decision-needed",
    reason: scrubCredentials(i.decision?.reason ?? i.reason), updated: i.updated,
    nextAction: i.decision?.category==='operational' ? 'The existing recovery cycle will recheck this condition automatically.' : i.decision?.action === "propose-close" ? "Approve or retain this investigation. No repair is being claimed."
      : i.reason.startsWith("Pause origin unknown") ? "Confirm why this ticket is paused and what allows it to resume."
      : "Resolve the specific missing permission, evidence or policy described above.",
  }));
  return { generatedAt: new Date().toISOString(), decisions,
    recovering: current.filter(i => ["queued", "assessing", "applying", "waiting"].includes(i.state)).map(i => ({ ticket: i.ticket, state: i.state, reason: i.reason })),
    humanHolds: current.filter(i => i.reason === "Explicit operator hold").map(i => i.ticket),
    computers: (machine.projects ?? []).filter(p => p.health !== "reporting"), reservations: machine.attention ?? [] };
}
