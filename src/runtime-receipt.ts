import { execFileSync } from "node:child_process";
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

/** Attest source loaded at startup. Looking at a later checkout HEAD cannot prove loaded code. */
export function writeRuntimeReceipt(target: string, agents: string, dispatcher: string): void {
  const revision = (path: string) => execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const file = join(target, "runtime.json");
  const temporary = `${file}.${process.pid}.new`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, started: Date.now(), consumer: revision(agents), dispatcher: revision(dispatcher) }), { mode: 0o600 });
  renameSync(temporary, file);
}
