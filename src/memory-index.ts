// Deterministic trim of the per-repo memory index (`MEMORY.md`).
//
// Follows the dispatcher's pure-function-plus-injected-IO style (see
// agent-runtime.ts): `trimMemoryIndex` is pure and fully tested against
// byte-accurate fixtures; `trimMemoryIndexFile` is a thin IO wrapper with
// injectable fs deps.
//
// **Why this exists.** Claude Code's native memory tool injects the
// per-repo index into every agent run — it is the discovery map that lets
// an agent find the right per-ticket note by ticket number or topic. The
// harness hard-caps the index at a ~24.4KB read limit (past which it
// truncates on injection and agents lose older entries) and fires a
// built-in PostToolUse hook that tells the agent, mid-run, to hand-compact
// the index when it nears that limit. That compaction runs inside the
// agent's wall-clock budget: on pyrycode ticket #994 the architect spent
// its whole 20-minute budget in a measure-and-trim loop and was killed,
// discarding a finished spec. The hook is baked into the harness and lives
// in no settings file we own, so we cannot disable it. The controllable
// seam is the dispatcher: keep the index small between runs and the hook
// never fires and the index never crosses the read limit.
//
// **Classification.** Entries are self-classifying by line shape, so no
// file restructure is needed. A ticket entry's title starts with a digit
// (`- [994 ...]`); a lesson entry's title starts with a word
// (`- [sec=design ...]`). The trim drops the oldest ticket entries — which
// is bottom-up, since the memory tool appends the newest at the top — and
// always keeps every lesson entry, header, comment, and blank line. Lesson
// growth is slow and hand-curated, so this trim never touches it by design.

import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  renameSync as fsRenameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Safe cap for the memory index, in bytes. Raised from 15000 to 17000 on
 * 2026-07-16 to keep more ticket entries in the discovery map. The lesson
 * floor turned out to be genuine unique knowledge that curation cannot
 * shrink much, so the cap is the lever for map depth. 17000 stays under the
 * harness's ~17.1KB compact-to target and its ~19.6KB hook trigger, leaving
 * ~2600 bytes of buffer for a cycle's appends before the hook could fire,
 * and far under the ~24.4KB read limit. At the current ~11700-byte lesson
 * floor this fits roughly 17 tickets, up from roughly 10 at 15000.
 */
export const MEMORY_INDEX_CAP_BYTES = 17_000;

/**
 * A bullet whose title starts with a digit — a per-ticket entry. Everything
 * else (lesson bullets, headers, HTML comments, blanks) is keep-always.
 *
 * Exported so a fork whose index writes ticket entries in a different shape
 * (e.g. pyrycode-mobile's `[#578 ...]` or tui-driver's `[Title ... #291]`)
 * can override it. Under the default pattern those shapes classify as
 * lessons, so the trim is a safe no-op there rather than dropping the wrong
 * lines.
 */
export const TICKET_LINE = /^\s*[-*]\s+\[\d/;

/**
 * Drop the oldest ticket entries until the content is at or under `capBytes`,
 * always keeping every non-ticket line. Pure.
 *
 * - If already at or under cap, returns the input unchanged (so it is
 *   idempotent and cheap on the common no-op path).
 * - Drops ticket lines oldest-first, which is bottom-up since the newest is
 *   appended at the top, stopping the moment byte length is at or under cap
 *   so it never over-drops.
 * - Keeps every non-ticket line regardless of position, so a lesson that
 *   sits physically below a dropped ticket survives — classification, not
 *   position, decides.
 * - Preserves line order and the presence or absence of a trailing newline.
 * - If there are no ticket lines, or if the non-ticket lines alone exceed
 *   the cap, returns the best effort still over cap and lets the caller
 *   warn. It never drops a lesson to force the cap.
 *
 * Byte length is measured with `Buffer.byteLength`, never `String.length`,
 * so multibyte UTF-8 content is capped by its real on-disk size.
 */
export function trimMemoryIndex(content: string, capBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= capBytes) return content;

  // Split on "\n" and rejoin on "\n": lossless for a trailing newline
  // (which becomes a trailing "" element) and for its absence.
  const lines = content.split("\n");
  const ticketIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (TICKET_LINE.test(lines[i])) ticketIndices.push(i);
  }

  // Nothing droppable — best effort, still over cap.
  if (ticketIndices.length === 0) return content;

  const removed = new Set<number>();
  const render = (): string => lines.filter((_, i) => !removed.has(i)).join("\n");

  // Oldest-first = bottom-up.
  for (let k = ticketIndices.length - 1; k >= 0; k--) {
    removed.add(ticketIndices[k]);
    const candidate = render();
    if (Buffer.byteLength(candidate, "utf8") <= capBytes) return candidate;
  }

  // Every ticket dropped and still over cap (lessons alone exceed it).
  return render();
}

/**
 * The canonical on-disk path of a repo's memory index. The claude-projects
 * directory encodes the repo's absolute path by replacing every `/` and `.`
 * with `-`, so `/Users/u/Workspace/Projects/pyrycode` becomes
 * `~/.claude/projects/-Users-u-Workspace-Projects-pyrycode/memory/MEMORY.md`.
 */
export function memoryIndexPath(repoRoot: string, homeDir: string = homedir()): string {
  const encoded = repoRoot.replace(/[/.]/g, "-");
  return join(homeDir, ".claude", "projects", encoded, "memory", "MEMORY.md");
}

/** The subset of `node:fs` the file wrapper touches. Injectable for tests. */
export interface MemoryIndexFs {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
}

export interface TrimMemoryIndexResult {
  /** True iff the file was rewritten (content actually shrank). */
  changed: boolean;
  /** Byte length before the trim (0 if the file was missing). */
  before: number;
  /** Byte length after the trim (0 if the file was missing). */
  after: number;
  /** True iff the result is still over cap — lessons alone exceed it. */
  overCap: boolean;
}

const defaultFs: MemoryIndexFs = {
  existsSync: fsExistsSync,
  readFileSync: (p) => fsReadFileSync(p, "utf8"),
  writeFileSync: (p, d) => fsWriteFileSync(p, d),
  renameSync: fsRenameSync,
};

/**
 * Read the repo's memory index, apply `trimMemoryIndex`, and write it back
 * only if it changed. No-op if the file is missing.
 *
 * The write is atomic: it writes a temp file in the same directory then
 * renames over `MEMORY.md`, so a crash mid-write can never leave a
 * half-written index that a booting agent would read.
 *
 * IO is injectable via `fs` for testing; `homeDir` defaults to the real
 * home directory.
 */
export function trimMemoryIndexFile(opts: {
  repoRoot: string;
  capBytes?: number;
  homeDir?: string;
  fs?: Partial<MemoryIndexFs>;
}): TrimMemoryIndexResult {
  const capBytes = opts.capBytes ?? MEMORY_INDEX_CAP_BYTES;
  const fs: MemoryIndexFs = { ...defaultFs, ...opts.fs };
  const path = memoryIndexPath(opts.repoRoot, opts.homeDir);

  if (!fs.existsSync(path)) {
    return { changed: false, before: 0, after: 0, overCap: false };
  }

  const content = fs.readFileSync(path);
  const before = Buffer.byteLength(content, "utf8");
  const trimmed = trimMemoryIndex(content, capBytes);
  const after = Buffer.byteLength(trimmed, "utf8");
  const overCap = after > capBytes;

  if (trimmed === content) {
    return { changed: false, before, after, overCap };
  }

  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, trimmed);
  fs.renameSync(tmp, path);
  return { changed: true, before, after, overCap };
}
