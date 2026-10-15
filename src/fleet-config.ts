import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";

/** Save only the drain policy, retaining the rest of the private configuration. */
export function persistProjectDrains(path: string, projects: string[], changes?: Array<{ project: string; draining: boolean; at: number }>): void {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...config, drainingProjects: projects, ...(changes ? { projectDrainChanges: changes } : {}) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Save a manager's applied desired state document together with the drain
 * policy it implies, in one atomic replacement. `drainingProjects` then
 * mirrors the central state, so an older manager started on this file after
 * a rollback still holds those boards back from new tickets.
 */
export function persistDesiredState(path: string, update: { desiredState: unknown; drainingProjects: string[]; projectDrainChanges: unknown[] }): void {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...config, desiredState: update.desiredState, drainingProjects: update.drainingProjects, projectDrainChanges: update.projectDrainChanges }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
