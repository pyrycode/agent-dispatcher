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
 * Lesson-floor watermark, in bytes. The deterministic trim only drops ticket
 * entries, never lessons, so once the lessons alone approach the cap the trim
 * can no longer help. This watermark fires earlier, while there is still
 * runway, to request an out-of-band curation pass (compress verbose summaries,
 * relocate the oldest lessons to the project Lessons.md, then de-index them).
 * It is measured on the lesson floor (see `lessonFloorBytes`), not the total,
 * because that floor is exactly the part the trim cannot reduce.
 *
 * Measurement 2026-07-17: 106 genuine pyrycode lessons compress to only
 * ~16000 bytes, so compression alone cannot clear the cap; the real lever is
 * cutting the lesson count by relocation. 13000 leaves the curation room to
 * reach a comfortable ~11500 target with headroom before the cap.
 */
export const MEMORY_INDEX_LESSON_WATERMARK_BYTES = 13_000;

/**
 * Re-arm threshold, in bytes, below the fire watermark. Once a curation pass
 * brings the lesson floor under this, the request marker is cleared so the
 * next crossing can fire again. The gap between this and the watermark is
 * hysteresis: it stops a single lesson append from re-firing curation right
 * after it finishes.
 */
export const MEMORY_INDEX_LESSON_REARM_BYTES = 12_500;

/**
 * A bullet whose title starts with a ticket number — a per-ticket entry.
 * Matches both `- [994 ...]` (pyrycode) and `- [#578 ...]` (mobile and
 * desktop); the `#` is optional. Everything else (lesson bullets, headers,
 * HTML comments, blanks) is keep-always.
 *
 * The one-character `#?` covers the only shape difference across the forks.
 * Verified 2026-07-16 that pyrycode, mobile, and desktop all title tickets
 * with an optional `#` then the issue number, and no lesson entry in any of
 * them starts with `[#` or `[<digit>`, so the rule catches exactly the
 * tickets on all three. Exported so a fork with a genuinely different shape
 * can still override it.
 */
export const TICKET_LINE = /^\s*[-*]\s+\[#?\d/;

// ---------------------------------------------------------------------------
// Ticket entries do not belong in the index at all (2026-08-26).
//
// `TICKET_LINE` above keys on the title's FIRST character, and that is what
// broke. Any decoration in front of the number defeats it: desktop's pipeline
// wrote `⭐⭐⭐ #675 …`, pyrycode's writes `po: #1254 …`, and neither was
// classified as a ticket. Both forks' finished ticket work therefore counted
// as permanent lessons, which is what drove 216 curation passes and about 34
// hours of blocked dispatch between 2026-07-20 and 2026-08-25.
//
// The deeper point is that the pointer was redundant the whole time. A
// ticket's knowledge lives in the repo and is committed: pyrycode folds it
// into the package overview at `docs/knowledge/features/<package>.md`, and
// desktop does the same as of 2026-08-26. So the index only needs to carry a
// lesson that outlives its ticket, and a ticket entry can be dropped outright
// rather than aged out against a byte cap. The note file itself always stays
// on disk, so a strip removes a pointer and never knowledge.
// ---------------------------------------------------------------------------

/** One index entry, split into its title and its note filename. */
const ENTRY_LINE = /^\s*[-*]\s+\[([^\]]*)\]\(([^)]+\.md)\)/;

/**
 * A ticket-number-shaped token in a title: a hash then 3 to 5 digits
 * anywhere, or 3 to 5 digits at the very start. A bare number mid-prose
 * ("raise the 1024 byte cap") is deliberately not a match, because without
 * the hash or the leading position it is a quantity and not a reference.
 */
const TICKET_IN_TITLE = /#\d{3,5}(?!\d)|^\s*\d{3,5}(?!\d)/;

/**
 * The same token in a note filename, which every fork embeds identically:
 * `ticket-757-clears.md`, `po-1254-grep.md`, `994-note.md`. Anchored on a
 * dash or the string start, so digits fused to a word (`adr025-…`) do not
 * match.
 */
const TICKET_IN_FILENAME = /(?:^|-)\d{3,5}(?=[-.])/;

/**
 * Does this line name a ticket? Checks the title and the note filename, and
 * consults no prefix, so a fork's title style cannot break the rule. Either
 * half agreeing is enough: the title is composed fresh on every write, the
 * filename is composed once, so requiring both would let a single sloppy
 * write escape. Pure.
 */
export function isTicketEntry(line: string): boolean {
  const m = ENTRY_LINE.exec(line);
  if (m === null) return false;
  return TICKET_IN_TITLE.test(m[1]) || TICKET_IN_FILENAME.test(m[2]);
}

/**
 * Remove every ticket entry. Headers, comments and lesson entries are kept
 * verbatim and in order. Pure.
 *
 * Returns the input unchanged when there is nothing to remove, so the common
 * path is byte-identical and the caller's write is skipped.
 *
 * Removing an entry leaves behind the blank line that separated it, so runs
 * of blanks are collapsed to one. Without that, an index that has been
 * stripped for months would be mostly whitespace. Only files that actually
 * lost an entry are reflowed.
 */
export function stripTicketEntries(content: string): string {
  const lines = content.split("\n");
  const kept = lines.filter((line) => !isTicketEntry(line));
  if (kept.length === lines.length) return content;

  const collapsed: string[] = [];
  for (const line of kept) {
    const blank = line.trim() === "";
    const prevBlank = collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === "";
    if (blank && prevBlank) continue;
    collapsed.push(line);
  }
  return collapsed.join("\n");
}

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
 * The lesson floor: the byte length of everything the trim can never drop.
 * The trim only removes ticket lines, so the floor is the content with every
 * ticket line removed — lessons plus headers, comments, and blanks. This is
 * the quantity `trimMemoryIndex` converges to as `capBytes` shrinks, so it is
 * exactly what decides whether the trim can reach the cap. Pure.
 *
 * Byte length is measured with `Buffer.byteLength`, so multibyte UTF-8 lessons
 * count by their real on-disk size.
 */
export function lessonFloorBytes(content: string, ticketLine: RegExp = TICKET_LINE): number {
  const kept = content
    .split("\n")
    .filter((line) => !ticketLine.test(line))
    .join("\n");
  return Buffer.byteLength(kept, "utf8");
}

/**
 * Pure edge-trigger for the auto-curation request, mirroring
 * `decideDrainNotification` in dispatch.ts. The presence of the request
 * marker file is the persisted armed state (the dispatcher dies and restarts
 * often, so an in-memory flag would re-fire on every restart).
 *
 *   - lesson floor at/above the watermark AND no marker yet → fire once
 *     (the caller writes the marker + pings).
 *   - lesson floor below the re-arm threshold AND a marker exists → clear it
 *     (the crossing is resolved; the next one can fire again).
 *   - anything else, including the hysteresis band between re-arm and
 *     watermark → do nothing.
 */
export function decideCurationTrigger(opts: {
  lessonFloorBytes: number;
  watermark: number;
  rearm: number;
  markerPresent: boolean;
}): { fire: boolean; clear: boolean } {
  if (opts.lessonFloorBytes >= opts.watermark && !opts.markerPresent) {
    return { fire: true, clear: false };
  }
  if (opts.lessonFloorBytes < opts.rearm && opts.markerPresent) {
    return { fire: false, clear: true };
  }
  return { fire: false, clear: false };
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
  /**
   * Byte length of the lesson floor after the trim (non-ticket lines). 0 if
   * the file was missing. This is what the auto-curation watermark keys on.
   */
  lessonFloor: number;
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
    return { changed: false, before: 0, after: 0, overCap: false, lessonFloor: 0 };
  }

  const content = fs.readFileSync(path);
  const before = Buffer.byteLength(content, "utf8");
  // Strip first. A ticket entry is never wanted, so it goes regardless of
  // size; the cap trim then only ever sees lessons, headers and blanks, and
  // is a no-op unless the lessons alone exceed the cap.
  const stripped = stripTicketEntries(content);
  const trimmed = trimMemoryIndex(stripped, capBytes);
  const after = Buffer.byteLength(trimmed, "utf8");
  const overCap = after > capBytes;
  const lessonFloor = lessonFloorBytes(trimmed);

  if (trimmed === content) {
    return { changed: false, before, after, overCap, lessonFloor };
  }

  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, trimmed);
  fs.renameSync(tmp, path);
  return { changed: true, before, after, overCap, lessonFloor };
}
