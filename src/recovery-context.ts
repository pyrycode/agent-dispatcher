import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { scrubCredentials } from "./agent-runtime.js";

/** Bounded evidence from this ticket only. Do not send complete logs or credential files. */
export function recoveryLogContext(logsDir: string, issue: number): Array<{ name: string; tail: string }> {
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error("Invalid recovery ticket");
  const names = readdirSync(logsDir).filter(n => n.endsWith(`_#${issue}.log`) && !n.includes("_recovery_")).sort().slice(-2);
  return names.map(name => {
    const path = join(logsDir, name);
    const fd = openSync(path, "r");
    try {
      const size = statSync(path).size;
      const bytes = Buffer.alloc(Math.min(size, 12000));
      const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      return { name, tail: scrubCredentials(bytes.subarray(0, count).toString("utf8")) };
    } finally { closeSync(fd); }
  });
}
