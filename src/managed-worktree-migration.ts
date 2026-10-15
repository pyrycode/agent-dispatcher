import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { FleetRun } from "./fleet-store.js";
import type { ManagedWorktreeRecord } from "./worktree.js";
import { checkManagedCustody, writeManagedCustody, type CustodyIO } from "./managed-worktree-custody.js";

export interface MigrationReference { path: string; sha256: string }
export type MigrationSuccessor = Pick<FleetRun, "machine" | "project" | "ticket" | "generation" | "role">;
export function migrationSuccessor(run: FleetRun): MigrationSuccessor {
  const { machine, project, ticket, generation, role } = run;
  return { machine, project, ticket, generation, role };
}
export interface ManagedWorktreeMigration {
  record: ManagedWorktreeRecord;
  sha256: string;
  archive: string;
}
type IO = CustodyIO;

/**
 * Explicit, operator-pinned import for a tree launched before custody records.
 * No artifact discovery or reconstruction from logs, role paths or processes.
 * PYRY_MANAGED_WORKTREE_MIGRATION names the manifest; its SHA-256 is pinned
 * separately in PYRY_MANAGED_WORKTREE_MIGRATION_SHA256 in trusted configuration.
 *
 * The pinned v1 manifest names a successor scope (machine, project, ticket,
 * generation, role), an expiry (expires), and two hashed JSON attestations,
 * established independently of this import. Scoping to the ownership generation
 * permits configuration before the authority issues the next run's grant.
 * - launch: {version:1, kind:"managed-worktree-launch", record:ManagedWorktreeRecord, launched:number}
 * - childCompletion: {version:1, kind:"managed-child-completion", run:FleetRun,
 *                     finished:number, trackedChildren:"finished"}
 * Times are epoch milliseconds. The operator must establish the launch/path
 * binding and tracked-child completion before pinning these attestations in
 * trusted dispatcher configuration. A normal authority outcome by itself does
 * not supply the missing launch/path evidence. This code never creates proof.
 */
export function readManagedWorktreeMigration(reference: MigrationReference | undefined, successor: FleetRun, io: IO): ManagedWorktreeMigration {
  const read = (ref: MigrationReference): Buffer => {
    if (!ref || typeof ref.path !== "string" || ref.path !== resolve(ref.path) ||
        !/^[a-f0-9]{64}$/.test(ref.sha256) || String((io.realpathSync ?? realpathSync)(ref.path)) !== ref.path) {
      throw new Error("Invalid or aliased managed worktree migration reference");
    }
    const stat = statSync(ref.path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Managed worktree migration evidence must be a bounded regular file");
    const bytes = io.readFileSync(ref.path);
    if (bytes.length > 64 * 1024 || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) {
      throw new Error("Managed worktree migration evidence digest or size mismatch");
    }
    return bytes;
  };
  if (!reference) throw new Error("No custody record or operator-pinned legacy migration proof");
  const manifestBytes = read(reference);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.version !== 1 || !isDeepStrictEqual(manifest.successor, migrationSuccessor(successor)) ||
      !Number.isSafeInteger(manifest.expires) || successor.created > manifest.expires || Date.now() > manifest.expires) {
    throw new Error("Legacy migration is expired or does not match this successor's ownership generation and role");
  }
  const launchBytes = read(manifest.launch), completionBytes = read(manifest.childCompletion);
  const launch = JSON.parse(launchBytes.toString("utf8")), completion = JSON.parse(completionBytes.toString("utf8"));
  const record = launch?.record as ManagedWorktreeRecord;
  if (launch?.version !== 1 || launch.kind !== "managed-worktree-launch" || !record?.run || typeof record.path !== "string" ||
      completion?.version !== 1 || completion.kind !== "managed-child-completion" || completion.trackedChildren !== "finished" ||
      !isDeepStrictEqual(record.run, completion.run) || !Number.isSafeInteger(launch.launched) || !Number.isSafeInteger(completion.finished) ||
      !Number.isFinite(record.run.created) || record.run.created > launch.launched || launch.launched > completion.finished || completion.finished > successor.created) {
    throw new Error("Legacy migration lacks matching managed launch and tracked-child completion attestations");
  }
  for (const ref of [reference, manifest.launch, manifest.childCompletion] as MigrationReference[]) {
    if (ref.path === record.path || ref.path.startsWith(record.path + sep)) throw new Error("Legacy migration proof must be retained outside the worker tree");
  }
  return { record, sha256: reference.sha256, archive: JSON.stringify({ manifest: manifestBytes.toString("base64"),
    launch: launchBytes.toString("base64"), childCompletion: completionBytes.toString("base64") }) };
}

/** Only called after authority, repository, locks, Git state and ancestry pass.
 * Keep the original bytes as well as the migrated predecessor record. Never
 * replace existing evidence, even on a retry after an interrupted import. */
export function retainManagedWorktreeMigration(file: string, migration: ManagedWorktreeMigration, io: IO): void {
  const archive = `${file}.migration-${migration.sha256}.json`;
  const runKey = createHash("sha256").update(migration.record.run.id).digest("hex");
  const files = [[archive, migration.archive],
    [`${file}.${runKey}`, JSON.stringify({ ...migration.record, migration: { sha256: migration.sha256, archive } })]] as const;
  // Detect existing conflicts before adding either artifact. Exclusive writes
  // below also protect against another importer winning after this preflight.
  for (const [path, bytes] of files) checkManagedCustody(path, bytes, io);
  for (const [path, bytes] of files) writeManagedCustody(path, bytes, io);
}

export function exactMigrationPredecessor(migration: ManagedWorktreeMigration, prior: FleetRun | null): boolean {
  return isDeepStrictEqual(migration.record.run, prior);
}
