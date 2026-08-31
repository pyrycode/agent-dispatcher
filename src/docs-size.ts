// Size detector for the per-package overviews under `docs/knowledge/features/`.
//
// Follows the dispatcher's pure-function-plus-injected-IO style (see
// memory-index.ts): `oversizedDocs` and `formatSplitDirective` are pure and
// fully tested; `scanFeatureDocs` is a thin read-only wrapper with
// injectable fs deps.
//
// **Why this exists.** The documentation phase folds every ticket's lessons
// into the package overview for the area it touched, and nothing bounds the
// result. pyrycode reached 10 overviews over 50KB and 7 over 100KB, the
// largest at 350KB, and that breaks retrieval outright.
//
// QMD is the search surface every agent uses. Its structure-aware chunker
// covers typescript, tsx, javascript, python, go and rust; markdown is not
// on that list, so markdown is cut at a fixed ~2295 bytes with no regard for
// headings. A 315KB overview becomes 150 slices that start and end
// mid-sentence and carry no heading context. Measured 2026-08-31 against
// `v2-session-manager.md`: a semantic query, a hybrid query and a keyword
// query with reranking off, all aimed at a topic whose canonical home is a
// section of that file, and none of the three returned the file. What came
// back instead was the frozen `docs/knowledge/codebase/` archive that was
// closed on 2026-08-19 for being read by nobody.
//
// File path and title are the only structural signal QMD has for markdown.
// In a 20KB document every chunk is about the document's topic; in a 315KB
// document no chunk is about anything nameable. So the fix is to keep each
// overview small, and this module is the detector half of that.
//
// **Read-only by design.** Unlike the memory-index trim, nothing here
// writes, so it needs no single-writer seam and no cooldown. It runs
// per-dispatch against the agent's own worktree, which also means it always
// sees the branch the agent is about to write to rather than a cached view
// of main. The split itself is done by the documentation agent, which is
// already the sole writer under `docs/knowledge/` and already `serial: true`
// — the existing write path, review path and merge path all apply, so no
// separate runner is needed.

import {
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  statSync as fsStatSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Size cap for a single package overview, in bytes.
 *
 * 50000 is set against the collection that already retrieves well: the
 * median pyrycode overview is 18874 bytes and the median desktop overview is
 * 15021, and documents in that band are found by search. 50000 leaves room
 * for a genuinely large package without reaching the size where a document's
 * chunks stop sharing a topic. It is a trigger to split, not a hard budget:
 * the target for each child document after a split is roughly 20000.
 */
export const FEATURE_DOCS_CAP_BYTES = 50_000;

/** The directory the overviews live in, relative to the repo root. */
export const FEATURE_DOCS_DIR = "docs/knowledge/features";

/** One overview and its on-disk size. */
export interface DocEntry {
  name: string;
  bytes: number;
}

/**
 * The overviews at or over `capBytes`, largest first, ties broken by name so
 * the order is stable across runs and the directive text does not churn.
 * Does not mutate the input. Pure.
 *
 * A document exactly at cap is not oversized: the cap is the largest size
 * that is still acceptable, so the comparison is strictly greater than.
 */
export function oversizedDocs(entries: DocEntry[], capBytes: number): DocEntry[] {
  return entries
    .filter((e) => e.bytes > capBytes)
    .slice()
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

/**
 * The prompt block naming the oversized overviews, or the empty string when
 * there are none so the prompt is left byte-identical on the common path.
 * Pure.
 *
 * Addressed to the documentation agent, which is the only agent that writes
 * these files. It states the cap and the target rather than only the
 * problem, because "this file is too big" without a target produces an
 * arbitrary cut.
 */
export function formatSplitDirective(docs: DocEntry[], capBytes: number): string {
  if (docs.length === 0) return "";

  const rows = docs.map((d) => `- \`${d.name}\` — ${d.bytes} bytes`).join("\n");
  const target = Math.round(capBytes * 0.4);

  return [
    "",
    "## Oversized package overviews",
    "",
    `These documents under \`${FEATURE_DOCS_DIR}/\` are over the ${capBytes}-byte cap:`,
    "",
    rows,
    "",
    "**If this ticket's lessons belong in one of them, split that document before",
    "writing to it.** Cut at `##` headings, and where a `##` section is itself over",
    `${capBytes} bytes cut it at its \`###\` headings. Aim for about ${target} bytes per`,
    "child document. Name each child `<parent-stem>-<section-slug>.md` alongside the",
    "parent in the same directory.",
    "",
    "**Keep the parent file at its own path.** It keeps its title and its intro",
    "prose, and its body becomes a table linking to the children with a one-line",
    "topic per row. Every other agent prompt names the parent path, and hundreds of",
    "documents link to it, so the path must keep resolving. Retarget any inbound",
    "`#anchor` link that pointed at a section you moved, and add a row to",
    "`docs/knowledge/INDEX.md` for each child.",
    "",
    "Splitting is not optional housekeeping you may defer: a document this size is",
    "not retrievable by search at all, so a lesson folded into it is a lesson lost.",
    "",
  ].join("\n");
}

/** The subset of `node:fs` the scan touches. Injectable for tests. */
export interface DocsSizeFs {
  existsSync: (path: string) => boolean;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { size: number };
}

const defaultFs: DocsSizeFs = {
  existsSync: fsExistsSync,
  readdirSync: (p) => fsReaddirSync(p),
  statSync: (p) => fsStatSync(p),
};

/**
 * The oversized overviews in a repo, largest first. Read-only.
 *
 * Returns an empty array rather than throwing on any IO failure, including a
 * missing directory: this runs inside dispatch preparation, and a failure to
 * measure documentation must never stop a ticket from being worked. A single
 * file that vanishes between the directory read and its stat is skipped and
 * the rest still report.
 */
export function scanFeatureDocs(opts: {
  repoRoot: string;
  capBytes?: number;
  fs?: Partial<DocsSizeFs>;
}): DocEntry[] {
  const capBytes = opts.capBytes ?? FEATURE_DOCS_CAP_BYTES;
  const fs: DocsSizeFs = { ...defaultFs, ...opts.fs };
  const dir = join(opts.repoRoot, FEATURE_DOCS_DIR);

  if (!fs.existsSync(dir)) return [];

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const entries: DocEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      entries.push({ name, bytes: fs.statSync(join(dir, name)).size });
    } catch {
      // The file vanished or is unreadable. Skip it; the rest still report.
    }
  }

  return oversizedDocs(entries, capBytes);
}
