import type { CoordinationRecord } from "./recovery-facts.js";

/** Parse an admitted planning run's explicit receipt, never a ticket comment or a log tail. */
export function coordinationReceipts(output: string, project: string, issue: number): CoordinationRecord[] {
  const records: CoordinationRecord[] = [];
  for (const match of output.matchAll(/^<!-- edit-coordination: (.{1,6000}) -->$/gm)) {
    if (records.length >= 10) throw new Error("Too many coordination receipts");
    const value = JSON.parse(match[1]);
    if (!/^[1-9]\d*$/.test(String(value.blocker))) throw new Error("Invalid coordination blocker");
    records.push({ ticket: `${project}#${issue}`, blocker: `${project}#${value.blocker}`, paths: value.paths, reason: value.reason });
  }
  return records;
}
