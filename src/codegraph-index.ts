// Per-worktree codegraph index: the filesystem side of
// `decideCodegraphIndexCopy` (worktree.ts).

import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Files besides the database that make a `.codegraph/` usable. */
const CODEGRAPH_SIDE_FILES = ["config.json", ".gitignore"] as const;

/** True when `path` itself is a symbolic link, dangling or not. */
export function isSymlinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Copy the canonical `.codegraph/` into a worktree as a private index.
 *
 * The database goes through SQLite's `VACUUM INTO`, which reads one
 * consistent snapshot even while a post-merge `codegraph sync` writes the
 * source, so a copy never mixes two states of the index. Only the database
 * and its config travel; the source's runtime files (`daemon.pid`,
 * `writer.pid`, the socket, the lock) stay behind, since they belong to the
 * process serving the canonical checkout.
 *
 * Throws on failure after removing only what it created, so the caller can
 * warn and let the agent run without an index. A legacy symlink at
 * `dstDir` is removed first when `replaceSymlink` is set.
 */
export function copyCodegraphIndex(srcDir: string, dstDir: string, opts: { replaceSymlink?: boolean } = {}): void {
  if (opts.replaceSymlink && isSymlinkPath(dstDir)) unlinkSync(dstDir);
  // A repo may track `.codegraph/config.json`, so the directory can already
  // exist in a fresh checkout. Never overwrite or remove what was there.
  const createdDir = !existsSync(dstDir);
  mkdirSync(dstDir, { recursive: true });
  const created: string[] = [];
  const tmp = join(dstDir, "codegraph.db.copying");
  try {
    for (const name of CODEGRAPH_SIDE_FILES) {
      const from = join(srcDir, name);
      const to = join(dstDir, name);
      if (existsSync(from) && !existsSync(to)) {
        copyFileSync(from, to);
        created.push(to);
      }
    }
    rmSync(tmp, { force: true });
    const db = new DatabaseSync(join(srcDir, "codegraph.db"), { readOnly: true });
    try {
      db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    renameSync(tmp, join(dstDir, "codegraph.db"));
  } catch (e) {
    rmSync(tmp, { force: true });
    if (createdDir) rmSync(dstDir, { recursive: true, force: true });
    else for (const path of created) rmSync(path, { force: true });
    throw e;
  }
}
