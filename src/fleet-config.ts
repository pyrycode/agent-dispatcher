import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";

/** Save only the drain policy, retaining the rest of the private configuration. */
export function persistProjectDrains(path: string, projects: string[]): void {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...config, drainingProjects: projects }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
