import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";

export interface CustodyIO {
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  realpathSync?: typeof realpathSync;
  lstatSync?: typeof lstatSync;
  openSync?: typeof openSync;
  closeSync?: typeof closeSync;
  fstatSync?: typeof fstatSync;
  ftruncateSync?: typeof ftruncateSync;
}

const MAX_CUSTODY_BYTES = 512 * 1024; // Includes three base64-encoded migration attestations.

function checkStat(stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CUSTODY_BYTES) {
    throw new Error("Managed worktree custody must be a bounded, unaliased regular file");
  }
}

function checkDescriptor(fd: number, expected: Stats | undefined, io: CustodyIO): void {
  const actual = (io.fstatSync ?? fstatSync)(fd);
  checkStat(actual);
  if (expected && (actual.dev !== expected.dev || actual.ino !== expected.ino)) {
    throw new Error("Managed worktree custody changed during inspection");
  }
}

/** Absence is a filesystem fact, never inferred from a failed read. Check
 * the parent too: O_NOFOLLOW protects the final component, not its parents. */
function custodyStat(path: string, io: CustodyIO) {
  if (path !== resolve(path) || String((io.realpathSync ?? realpathSync)(dirname(path))) !== dirname(path)) {
    throw new Error("Aliased managed worktree custody directory");
  }
  let stat;
  try { stat = (io.lstatSync ?? lstatSync)(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  checkStat(stat);
  return stat;
}

export function readManagedCustody(path: string, io: CustodyIO): string | undefined {
  const stat = custodyStat(path, io);
  if (!stat) return undefined;
  // A read failure, including ENOENT after a successful lstat, is unsafe.
  const fd = (io.openSync ?? openSync)(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    checkDescriptor(fd, stat, io);
    const bytes = String(io.readFileSync(fd, "utf8"));
    if (Buffer.byteLength(bytes) > MAX_CUSTODY_BYTES) throw new Error("Managed worktree custody exceeded its size bound");
    return bytes;
  } finally { (io.closeSync ?? closeSync)(fd); }
}

/** Preflight immutable evidence before adding any artifacts or changing Git. */
export function checkManagedCustody(path: string, bytes: string, io: CustodyIO): void {
  const existing = readManagedCustody(path, io);
  if (existing !== undefined && existing !== bytes) throw new Error("Conflicting retained managed worktree custody evidence");
}

export function writeManagedCustody(path: string, bytes: string, io: CustodyIO, replace = false): void {
  const existing = readManagedCustody(path, io);
  if (!replace && existing !== undefined) {
    if (existing !== bytes) throw new Error("Conflicting retained managed worktree custody evidence");
    return;
  }
  // Exclusive creation refuses a newly introduced record (including dangling
  // links). Updating the current pointer must never follow a symlink either.
  const stat = custodyStat(path, io);
  const flag = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
    (existing === undefined ? constants.O_CREAT | constants.O_EXCL : 0);
  const fd = (io.openSync ?? openSync)(path, flag, 0o600);
  try {
    // Validate the opened inode before truncating, so a link or replacement
    // introduced since preflight cannot redirect a custody update.
    checkDescriptor(fd, stat, io);
    (io.ftruncateSync ?? ftruncateSync)(fd, 0);
    io.writeFileSync(fd, bytes);
  } catch (error) {
    // A failed exclusive creation owns only this newly opened inode. Leave
    // pre-existing records and any replacement introduced by others alone.
    if (existing === undefined) {
      const opened = (io.fstatSync ?? fstatSync)(fd);
      const current = (io.lstatSync ?? lstatSync)(path);
      if (opened.dev === current.dev && opened.ino === current.ino) unlinkSync(path);
    }
    throw error;
  } finally { (io.closeSync ?? closeSync)(fd); }
}
