// Tests for the per-repo memory-index trim (src/memory-index.ts).
//
// Written test-first. The pure `trimMemoryIndex` is exercised against
// hand-built fixtures with byte-accurate caps; `memoryIndexPath` against
// the canonical claude-projects encoding; `trimMemoryIndexFile` against a
// mock filesystem that records call order so the atomic temp-then-rename
// write is verified.
//
// Why this module exists: the harness fires a PostToolUse hook mid-run
// telling the agent to hand-compact MEMORY.md when it nears the ~24.4KB
// read limit, which burns the agent's wall-clock budget and timed out
// ticket #994's architect. Trimming the index deterministically between
// cycles keeps the hook from ever firing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_INDEX_CAP_BYTES,
  MEMORY_INDEX_LESSON_WATERMARK_BYTES,
  MEMORY_INDEX_LESSON_REARM_BYTES,
  TICKET_LINE,
  trimMemoryIndex,
  lessonFloorBytes,
  decideCurationTrigger,
  memoryIndexPath,
  trimMemoryIndexFile,
  type MemoryIndexFs,
} from "./memory-index.js";

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

// Ticket entries: title starts with a digit. Lesson entries: title starts
// with a word. See the live pyrycode MEMORY.md.
const ticket = (n: number, pad = ""): string =>
  `- [${n} ticket entry ${pad}](po-${n}-note.md) — detail ${pad}`;
const lesson = (name: string, pad = ""): string =>
  `- [${name} lesson ${pad}](${name}-note.md) — detail ${pad}`;

describe("trimMemoryIndex", () => {
  test("under cap returns the identical string", () => {
    const content = ["# Index", ticket(1), lesson("sec")].join("\n") + "\n";
    const cap = bytes(content) + 100;
    assert.equal(trimMemoryIndex(content, cap), content);
  });

  test("at cap exactly is unchanged", () => {
    const content = ["# Index", ticket(1), lesson("sec")].join("\n") + "\n";
    const cap = bytes(content);
    assert.equal(trimMemoryIndex(content, cap), content);
  });

  test("one drop removes only the bottom-most (oldest) ticket", () => {
    const header = "# Index";
    const newest = ticket(200);
    const oldest = ticket(100);
    const content = [header, newest, oldest].join("\n") + "\n";
    const afterOneDrop = [header, newest].join("\n") + "\n";
    // Cap sits exactly at the one-drop size: full content is over, one
    // drop lands at cap.
    const cap = bytes(afterOneDrop);
    const result = trimMemoryIndex(content, cap);
    assert.equal(result, afterOneDrop);
    assert.ok(result.includes(newest), "newest ticket survives");
    assert.ok(!result.includes(oldest), "oldest ticket dropped");
  });

  test("multiple drops stop as soon as at or under cap and do not over-drop", () => {
    const header = "# Index";
    const t1 = ticket(300); // newest
    const t2 = ticket(200);
    const t3 = ticket(100); // oldest
    const content = [header, t1, t2, t3].join("\n") + "\n";
    const afterTwoDrops = [header, t1].join("\n") + "\n";
    // Cap forces dropping t3 then t2, but not t1.
    const cap = bytes(afterTwoDrops);
    const result = trimMemoryIndex(content, cap);
    assert.equal(result, afterTwoDrops);
    assert.ok(result.includes(t1), "newest survives — no over-drop");
    assert.ok(!result.includes(t2));
    assert.ok(!result.includes(t3));
  });

  test("a lesson below a ticket survives while the ticket is dropped (classification, not position)", () => {
    const header = "# Index";
    const t = ticket(500, "xxxxxxxxxxxxxxxxxxxx");
    const l = lesson("design"); // physically below the ticket
    const content = [header, t, l].join("\n") + "\n";
    const afterDrop = [header, l].join("\n") + "\n";
    const cap = bytes(afterDrop);
    const result = trimMemoryIndex(content, cap);
    assert.equal(result, afterDrop);
    assert.ok(!result.includes(t), "ticket dropped");
    assert.ok(result.includes(l), "lesson below the ticket survives");
  });

  test("headers, HTML comments, and blanks are never dropped", () => {
    const header = "# Memory Index";
    const comment = "<!-- generated: do not edit -->";
    const blank = "";
    const content =
      [header, comment, blank, ticket(9), ticket(8), ticket(7)].join("\n") + "\n";
    // Tiny cap forces dropping every ticket.
    const cap = bytes([header, comment, blank].join("\n") + "\n");
    const result = trimMemoryIndex(content, cap);
    assert.ok(result.includes(header));
    assert.ok(result.includes(comment));
    assert.ok(result.startsWith(header));
    // The blank line between comment and (now-gone) tickets is preserved.
    assert.equal(result, [header, comment, blank].join("\n") + "\n");
  });

  test("zero ticket lines over cap returns unchanged and still over cap", () => {
    const content = [lesson("a"), lesson("b"), lesson("c")].join("\n") + "\n";
    const cap = 10; // far under
    const result = trimMemoryIndex(content, cap);
    assert.equal(result, content, "nothing to drop → identical");
    assert.ok(bytes(result) > cap, "still over cap");
  });

  test("lessons alone over cap drops all tickets and is best-effort over cap", () => {
    const l1 = lesson("alpha", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    const l2 = lesson("beta", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    const content = [l1, ticket(2), l2, ticket(1)].join("\n") + "\n";
    // Cap below the two lessons alone → every ticket is dropped, still over.
    const cap = bytes([l1, l2].join("\n") + "\n") - 1;
    const result = trimMemoryIndex(content, cap);
    assert.ok(result.includes(l1));
    assert.ok(result.includes(l2));
    assert.ok(!result.includes(ticket(2)));
    assert.ok(!result.includes(ticket(1)));
    assert.ok(bytes(result) > cap, "best-effort: still over cap");
    assert.equal(result, [l1, l2].join("\n") + "\n");
  });

  test("empty string stays empty", () => {
    assert.equal(trimMemoryIndex("", 100), "");
    assert.equal(trimMemoryIndex("", 0), "");
  });

  test("order is preserved with interleaved ticket/lesson lines", () => {
    const lines = [
      ticket(300), // newest
      lesson("la"),
      ticket(200),
      lesson("lb"),
      ticket(100), // oldest
    ];
    const content = lines.join("\n") + "\n";
    // Drop the two oldest tickets (100, then 200).
    const cap = bytes([ticket(300), lesson("la"), lesson("lb")].join("\n") + "\n");
    const result = trimMemoryIndex(content, cap);
    const resultLines = result.split("\n").filter((l) => l.length > 0);
    // Kept lines are a subsequence of the original in original order.
    assert.deepEqual(resultLines, [ticket(300), lesson("la"), lesson("lb")]);
  });

  test("trailing newline preserved when present", () => {
    const content = [ticket(3), ticket(2), ticket(1)].join("\n") + "\n";
    const cap = bytes([ticket(3)].join("\n") + "\n");
    const result = trimMemoryIndex(content, cap);
    assert.ok(result.endsWith("\n"), "trailing newline kept");
  });

  test("absence of a trailing newline is preserved", () => {
    const content = [ticket(3), ticket(2), ticket(1)].join("\n"); // no trailing \n
    const cap = bytes(ticket(3));
    const result = trimMemoryIndex(content, cap);
    assert.ok(!result.endsWith("\n"), "no trailing newline added");
    assert.equal(result, ticket(3));
  });

  test("is idempotent", () => {
    const content = [ticket(3), ticket(2), ticket(1)].join("\n") + "\n";
    const cap = bytes([ticket(3), ticket(2)].join("\n") + "\n");
    const once = trimMemoryIndex(content, cap);
    const twice = trimMemoryIndex(once, cap);
    assert.equal(twice, once);
    assert.ok(bytes(once) <= cap);
  });

  test("multibyte UTF-8 under cap by char count but over by bytes still trims", () => {
    // Each emoji is 4 bytes but 2 UTF-16 code units. Build content whose
    // character length is under cap but byte length is over.
    const t1 = "- [3 🎯🎯🎯🎯🎯 ticket](f3.md)";
    const t2 = "- [2 🎯🎯🎯🎯🎯 ticket](f2.md)";
    const t3 = "- [1 🎯🎯🎯🎯🎯 ticket](f1.md)";
    const content = [t1, t2, t3].join("\n") + "\n";
    const cap = content.length; // char count, deliberately < byte count
    assert.ok(content.length < bytes(content), "byte count exceeds char count");
    const result = trimMemoryIndex(content, cap);
    assert.notEqual(result, content, "trims despite char count being under cap");
    assert.ok(bytes(result) <= cap, "lands at or under the byte cap");
  });

  test("classification: digit and #-digit titles are tickets, word-prefixed are not", () => {
    const cases: Array<[string, boolean]> = [
      // pyrycode bare-digit shape
      ["- [982 recent_workspaces e2e](f.md) — x", true],
      ["- [1000 give-up seam](f.md) — x", true],
      ["* [7 asterisk bullet](f.md) — x", true],
      ["  - [3 indented ticket](f.md) — x", true],
      // mobile / desktop #-digit shape
      ["- [#578 DONE PR#580 mobile ticket](f.md) — x", true],
      ["- [#449 real-claude desktop ticket](f.md) — x", true],
      ["  * [#7 hash indented asterisk](f.md) — x", true],
      // # then non-digit is NOT a ticket (no such entries today, but the
      // rule must not over-match a hypothetical #-titled lesson)
      ["- [#live-mode rung note](f.md) — x", false],
      // word-titled lessons across the forks
      ["- [new v2 Type* trips guard](f.md) — x", false],
      ["- [RED restore](f.md) — x", false],
      ["- [sec spec heading](f.md) — x", false],
      ["- [Injectable timeout breaks advanceUntilIdle() tests](f.md) — x", false],
      ["- [src/main CANNOT import src/renderer](f.md) — x", false],
      ["# header", false],
      ["<!-- comment -->", false],
      ["", false],
      ["- plain bullet, no bracket", false],
      ["random prose line", false],
    ];
    for (const [line, expected] of cases) {
      assert.equal(TICKET_LINE.test(line), expected, `classify: ${JSON.stringify(line)}`);
    }
  });

  test("drops #-prefixed tickets (mobile/desktop shape) while keeping word lessons", () => {
    const header = "# Index";
    const t1 = "- [#578 newest mobile ticket](578-note.md) — detail";
    const l = "- [Injectable timeout breaks tests](inj-note.md) — detail";
    const t2 = "- [#535 older mobile ticket](535-note.md) — detail";
    const content = [header, t1, l, t2].join("\n") + "\n";
    // Cap forces dropping the bottom-most ticket (#535); keep #578 and the lesson.
    const cap = bytes([header, t1, l].join("\n") + "\n");
    const result = trimMemoryIndex(content, cap);
    assert.equal(result, [header, t1, l].join("\n") + "\n");
    assert.ok(result.includes(t1), "newest #-ticket kept");
    assert.ok(result.includes(l), "word lesson kept");
    assert.ok(!result.includes(t2), "oldest #-ticket dropped");
  });
});

describe("memoryIndexPath", () => {
  test("encodes the pyrycode repo path correctly", () => {
    const path = memoryIndexPath(
      "/Users/juhanailmoniemi/Workspace/Projects/pyrycode",
      "/Users/juhanailmoniemi",
    );
    assert.equal(
      path,
      "/Users/juhanailmoniemi/.claude/projects/-Users-juhanailmoniemi-Workspace-Projects-pyrycode/memory/MEMORY.md",
    );
  });

  test("turns a dot in the repo path into a dash", () => {
    const path = memoryIndexPath("/repo/v1.2", "/home/u");
    assert.ok(
      path.includes("/projects/-repo-v1-2/memory/MEMORY.md"),
      `dot became dash: ${path}`,
    );
  });
});

// Records every fs call in order so the atomic write sequence can be
// asserted. Files live in an in-memory map.
class MockFs implements MemoryIndexFs {
  files = new Map<string, string>();
  calls: string[] = [];

  existsSync = (p: string): boolean => {
    this.calls.push(`exists:${p}`);
    return this.files.has(p);
  };
  readFileSync = (p: string): string => {
    this.calls.push(`read:${p}`);
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  };
  writeFileSync = (p: string, data: string): void => {
    this.calls.push(`write:${p}`);
    this.files.set(p, data);
  };
  renameSync = (from: string, to: string): void => {
    this.calls.push(`rename:${from}->${to}`);
    const v = this.files.get(from);
    this.files.delete(from);
    if (v !== undefined) this.files.set(to, v);
  };

  writeCalls(): string[] {
    return this.calls.filter((c) => c.startsWith("write:") || c.startsWith("rename:"));
  }
}

describe("trimMemoryIndexFile", () => {
  const repoRoot = "/Users/u/Workspace/Projects/pyrycode";
  const homeDir = "/Users/u";
  const path = memoryIndexPath(repoRoot, homeDir);

  test("missing file is a no-op with no writes", () => {
    const fs = new MockFs();
    const result = trimMemoryIndexFile({ repoRoot, homeDir, fs });
    assert.equal(result.changed, false);
    assert.equal(result.overCap, false);
    assert.deepEqual(fs.writeCalls(), [], "no write or rename");
  });

  test("under cap reads but does not write", () => {
    const fs = new MockFs();
    fs.files.set(path, "# Index\n" + ticket(1) + "\n");
    const result = trimMemoryIndexFile({ repoRoot, homeDir, capBytes: 10_000, fs });
    assert.equal(result.changed, false);
    assert.ok(fs.calls.includes(`read:${path}`), "read happened");
    assert.deepEqual(fs.writeCalls(), [], "no write or rename");
  });

  test("over cap writes to a same-dir temp then renames over the real path, in that order", () => {
    const fs = new MockFs();
    const content = ["# Index", ticket(3), ticket(2), ticket(1)].join("\n") + "\n";
    fs.files.set(path, content);
    const cap = bytes(["# Index", ticket(3)].join("\n") + "\n");
    const result = trimMemoryIndexFile({ repoRoot, homeDir, capBytes: cap, fs });
    assert.equal(result.changed, true);
    const tmp = `${path}.tmp`;
    assert.deepEqual(
      fs.writeCalls(),
      [`write:${tmp}`, `rename:${tmp}->${path}`],
      "temp write precedes rename over the real path",
    );
    // Temp lives in the same directory as the real file.
    assert.equal(tmp.slice(0, path.lastIndexOf("/")), path.slice(0, path.lastIndexOf("/")));
    // Final content on disk is the trimmed version.
    assert.equal(fs.files.get(path), ["# Index", ticket(3)].join("\n") + "\n");
  });

  test("lessons-only over cap returns changed:false, overCap:true with no write", () => {
    const fs = new MockFs();
    const content = [lesson("a"), lesson("b"), lesson("c")].join("\n") + "\n";
    fs.files.set(path, content);
    const result = trimMemoryIndexFile({ repoRoot, homeDir, capBytes: 10, fs });
    assert.equal(result.changed, false);
    assert.equal(result.overCap, true);
    assert.deepEqual(fs.writeCalls(), [], "no write when nothing can be dropped");
  });

  test("default cap is MEMORY_INDEX_CAP_BYTES", () => {
    assert.equal(MEMORY_INDEX_CAP_BYTES, 17_000);
  });

  test("result carries lessonFloor = bytes of the non-ticket lines after trim", () => {
    const fs = new MockFs();
    // Two tickets + two lessons, no trailing newline; cap forces one ticket
    // drop. lessonFloor is the non-ticket bytes of the trimmed content,
    // unaffected by that drop.
    const content = [ticket(2), ticket(1), lesson("a"), lesson("b")].join("\n");
    fs.files.set(path, content);
    const cap = bytes([ticket(2), lesson("a"), lesson("b")].join("\n"));
    const result = trimMemoryIndexFile({ repoRoot, homeDir, capBytes: cap, fs });
    assert.equal(result.lessonFloor, bytes([lesson("a"), lesson("b")].join("\n")));
  });
});

describe("lessonFloorBytes", () => {
  test("all-lesson content: floor equals full byte length (no tickets to drop)", () => {
    const content = [lesson("a"), lesson("b"), lesson("c")].join("\n");
    assert.equal(lessonFloorBytes(content), bytes(content));
  });

  test("mixed content: floor is the non-ticket bytes only", () => {
    const kept = [lesson("a"), lesson("b")];
    const content = [ticket(9), ...kept, ticket(8)].join("\n");
    assert.equal(lessonFloorBytes(content), bytes(kept.join("\n")));
  });

  test("empty content is zero", () => {
    assert.equal(lessonFloorBytes(""), 0);
  });

  test("multibyte lessons are measured by UTF-8 byte length", () => {
    const content = "- [emoji lesson 🧹](x-note.md) — détail ✳";
    assert.equal(lessonFloorBytes(content), Buffer.byteLength(content, "utf8"));
  });

  test("#-prefixed tickets are excluded too", () => {
    const kept = lesson("a");
    const content = ["- [#578 mobile ticket](po-578-note.md) — d", kept].join("\n");
    assert.equal(lessonFloorBytes(content), bytes(kept));
  });
});

describe("decideCurationTrigger", () => {
  const watermark = MEMORY_INDEX_LESSON_WATERMARK_BYTES;
  const rearm = MEMORY_INDEX_LESSON_REARM_BYTES;

  test("watermark constants: rearm is below the fire watermark (hysteresis)", () => {
    assert.equal(watermark, 13_000);
    assert.equal(rearm, 12_500);
    assert.ok(rearm < watermark);
  });

  test("at/above watermark with no marker: fire once", () => {
    assert.deepEqual(
      decideCurationTrigger({ lessonFloorBytes: 13_000, watermark, rearm, markerPresent: false }),
      { fire: true, clear: false },
    );
    assert.deepEqual(
      decideCurationTrigger({ lessonFloorBytes: 18_808, watermark, rearm, markerPresent: false }),
      { fire: true, clear: false },
    );
  });

  test("at/above watermark with a marker already present: do not re-fire", () => {
    assert.deepEqual(
      decideCurationTrigger({ lessonFloorBytes: 18_808, watermark, rearm, markerPresent: true }),
      { fire: false, clear: false },
    );
  });

  test("in the hysteresis band (rearm..watermark) with a marker: hold, no clear", () => {
    assert.deepEqual(
      decideCurationTrigger({ lessonFloorBytes: 12_800, watermark, rearm, markerPresent: true }),
      { fire: false, clear: false },
    );
  });

  test("below rearm with a marker: clear it (re-arm)", () => {
    assert.deepEqual(
      decideCurationTrigger({ lessonFloorBytes: 11_449, watermark, rearm, markerPresent: true }),
      { fire: false, clear: true },
    );
  });

  test("below rearm with no marker: nothing to do", () => {
    assert.deepEqual(
      decideCurationTrigger({ lessonFloorBytes: 11_449, watermark, rearm, markerPresent: false }),
      { fire: false, clear: false },
    );
  });
});
