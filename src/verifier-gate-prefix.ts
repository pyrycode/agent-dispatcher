import { createHash } from "node:crypto";
import { parseGateOutput, type GateOutputFormat } from "./gate-output.js";

/** A successful test process must carry complete, nonempty test evidence.
 * Plain build and lint commands have no test format and retain their exit code. */
export function retainableGateEvidence(raw: string, format?: GateOutputFormat): boolean {
  if (!format) return true;
  const tally = parseGateOutput(raw, format);
  return tally.completeParse === true && tally.executed > 0 && tally.failed === 0 && tally.packageFailures.length === 0 && !tally.abnormalExit;
}

export interface PassedGate {
  gate: string;
  summary: string;
  logs: [string, string];
  evidence: string;
}

/** A partial run never certifies the entire list. Only these raw green steps
 * may be retained; the failed step and every later step must run again. */
export interface GatePrefix {
  key: string;
  passedAt: number;
  gates: PassedGate[];
}

/** Includes the consumer's explicit external-input snapshot. Credentials are
 * hashed with the environment, never written in the record or printed. */
export function gatePrefixKey(tree: string, gates: readonly string[], env: NodeJS.ProcessEnv, inputs: string): string {
  return createHash("sha256").update(JSON.stringify([tree, gates, Object.entries(env).sort(([a], [b]) => a.localeCompare(b)), inputs])).digest("hex");
}

export function retainedGatePrefix(raw: string, key: string, gates: readonly string[], now: number, read: (path: string) => string | null): PassedGate[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return [];
    const record = value as GatePrefix;
    if (record.key !== key || !Number.isFinite(record.passedAt) || now < record.passedAt || now - record.passedAt >= 86400000 || !Array.isArray(record.gates) || record.gates.length >= gates.length) return [];
    const kept: PassedGate[] = [];
    for (const [i, pass] of record.gates.entries()) {
      if (!pass || pass.gate !== gates[i] || pass.summary !== `✓ ${pass.gate} (exit 0)` || !Array.isArray(pass.logs) || pass.logs.length !== 2 || !pass.logs.every(p => typeof p === "string" && p.length > 0)) return [];
      const out = read(pass.logs[0]), err = read(pass.logs[1]);
      if (out === null || err === null || pass.evidence !== gatePrefixKey("", [], {}, out + "\u0000" + err)) return [];
      kept.push(pass);
    }
    return kept;
  } catch { return []; }
}
