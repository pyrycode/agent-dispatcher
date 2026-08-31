// Tests for the package-overview size detector (src/docs-size.ts).
//
// Written test-first. The pure `oversizedDocs` and `formatSplitDirective`
// are exercised against hand-built fixtures with byte-accurate caps;
// `scanFeatureDocs` against a mock filesystem so no real directory is read.
//
// Why this module exists: QMD cuts a document into ~900-token chunks and
// prefers a heading boundary, but only searches a narrow window around each
// cut. A 315KB overview whose sections average 7000 bytes offers no heading
// inside that window, so its 150 chunks are cut at paragraph breaks and
// carry no heading. Measured 2026-08-31: three query shapes against a topic
// whose canonical home is a section of `v2-session-manager.md` returned the
// frozen per-ticket archive and never the overview itself. Keeping each
// overview small keeps its sections near chunk size, which is what lets the
// heading preference fire at all.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  FEATURE_DOCS_CAP_BYTES,
  oversizedDocs,
  formatSplitDirective,
  scanFeatureDocs,
  type DocsSizeFs,
} from "./docs-size.js";

describe("oversizedDocs", () => {
  test("returns nothing when every doc is at or under cap", () => {
    const entries = [
      { name: "a.md", bytes: 100 },
      { name: "b.md", bytes: 500 },
    ];
    assert.deepEqual(oversizedDocs(entries, 500), []);
  });

  test("a doc exactly at cap is not oversized", () => {
    assert.deepEqual(oversizedDocs([{ name: "a.md", bytes: 500 }], 500), []);
  });

  test("returns the oversized docs largest first", () => {
    const entries = [
      { name: "small.md", bytes: 10 },
      { name: "big.md", bytes: 900 },
      { name: "medium.md", bytes: 600 },
    ];
    assert.deepEqual(oversizedDocs(entries, 500), [
      { name: "big.md", bytes: 900 },
      { name: "medium.md", bytes: 600 },
    ]);
  });

  test("ties break by name so the order is stable across runs", () => {
    const entries = [
      { name: "zebra.md", bytes: 900 },
      { name: "alpha.md", bytes: 900 },
    ];
    assert.deepEqual(oversizedDocs(entries, 500), [
      { name: "alpha.md", bytes: 900 },
      { name: "zebra.md", bytes: 900 },
    ]);
  });

  test("does not mutate the caller's array", () => {
    const entries = [
      { name: "a.md", bytes: 10 },
      { name: "b.md", bytes: 900 },
    ];
    oversizedDocs(entries, 500);
    assert.equal(entries[0].name, "a.md");
  });

  test("the shipped cap is 50000 bytes", () => {
    assert.equal(FEATURE_DOCS_CAP_BYTES, 50_000);
  });
});

describe("formatSplitDirective", () => {
  test("empty string when nothing is oversized, so the prompt is untouched", () => {
    assert.equal(formatSplitDirective([], 50_000), "");
  });

  test("names every oversized doc with its size", () => {
    const out = formatSplitDirective(
      [
        { name: "v2-session-manager.md", bytes: 318099 },
        { name: "protocol-package.md", bytes: 196505 },
      ],
      50_000,
    );
    assert.match(out, /v2-session-manager\.md/);
    assert.match(out, /318099/);
    assert.match(out, /protocol-package\.md/);
    assert.match(out, /196505/);
  });

  test("states the cap so the agent knows the target", () => {
    const out = formatSplitDirective([{ name: "a.md", bytes: 60_000 }], 50_000);
    assert.match(out, /50000/);
  });

  test("tells the agent to split before writing, not after", () => {
    const out = formatSplitDirective([{ name: "a.md", bytes: 60_000 }], 50_000);
    assert.match(out, /before/i);
  });
});

describe("scanFeatureDocs", () => {
  const mockFs = (files: Record<string, number>): DocsSizeFs => ({
    existsSync: () => true,
    readdirSync: () => Object.keys(files),
    statSync: (p: string) => {
      const name = p.split("/").pop() as string;
      return { size: files[name] ?? 0 };
    },
  });

  test("returns the oversized docs under docs/knowledge/features", () => {
    const fs = mockFs({ "big.md": 90_000, "small.md": 100 });
    const out = scanFeatureDocs({ repoRoot: "/repo", capBytes: 50_000, fs });
    assert.deepEqual(out, [{ name: "big.md", bytes: 90_000 }]);
  });

  test("ignores non-markdown files", () => {
    const fs = mockFs({ "big.md": 90_000, "notes.txt": 90_000 });
    const out = scanFeatureDocs({ repoRoot: "/repo", capBytes: 50_000, fs });
    assert.deepEqual(out, [{ name: "big.md", bytes: 90_000 }]);
  });

  test("returns nothing when the features directory is missing", () => {
    const fs: DocsSizeFs = {
      existsSync: () => false,
      readdirSync: () => {
        throw new Error("should not read a missing directory");
      },
      statSync: () => {
        throw new Error("should not stat in a missing directory");
      },
    };
    assert.deepEqual(scanFeatureDocs({ repoRoot: "/repo", capBytes: 50_000, fs }), []);
  });

  test("a read failure yields nothing rather than throwing into dispatch", () => {
    const fs: DocsSizeFs = {
      existsSync: () => true,
      readdirSync: () => {
        throw new Error("EIO");
      },
      statSync: () => ({ size: 0 }),
    };
    assert.deepEqual(scanFeatureDocs({ repoRoot: "/repo", capBytes: 50_000, fs }), []);
  });

  test("a stat failure skips that one file and keeps the rest", () => {
    const fs: DocsSizeFs = {
      existsSync: () => true,
      readdirSync: () => ["good.md", "vanished.md"],
      statSync: (p: string) => {
        if (p.endsWith("vanished.md")) throw new Error("ENOENT");
        return { size: 90_000 };
      },
    };
    assert.deepEqual(scanFeatureDocs({ repoRoot: "/repo", capBytes: 50_000, fs }), [
      { name: "good.md", bytes: 90_000 },
    ]);
  });

  test("defaults to the shipped cap", () => {
    const fs = mockFs({ "under.md": FEATURE_DOCS_CAP_BYTES, "over.md": FEATURE_DOCS_CAP_BYTES + 1 });
    const out = scanFeatureDocs({ repoRoot: "/repo", fs });
    assert.deepEqual(out, [{ name: "over.md", bytes: FEATURE_DOCS_CAP_BYTES + 1 }]);
  });
});
