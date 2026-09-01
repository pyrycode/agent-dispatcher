// Unit tests for the run-log parser. Run with:
//
//   pnpm test
//
// or directly:
//
//   pnpm exec tsx --test src/eval/log-parser.test.ts
//
// All fixtures are synthetic strings built here — never real log files.
// The real logs directory is read-only production data and stays out of
// the repo and out of the tests.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyLogFileName,
  loadRuns,
  parseFileName,
  parseRunLog,
  parseUsageLine,
} from "./log-parser.js";

const DELIM = "=".repeat(60);

/** Build a section: delimiter, `NAME — <iso>` header, delimiter, body. */
function section(name: string, iso: string, body: string): string {
  return `${DELIM}\n${name} — ${iso}\n${DELIM}\n${body}`;
}

const DISPATCH_BODY = [
  "Agent: developer",
  "Ticket: #1260 — Capture every stream-json line — with an em-dash in the title",
  "Branch: feature/1260",
  "Worktree: /work/.worktrees/developer-1260",
  "Max turns: 135",
  "Timeout: 25min",
  "Allowed tools: Bash,Read,Write",
  "",
].join("\n");

const USAGE_LINE =
  "Turns: 53 | Duration: 1094s | Input tokens: 86 | Output tokens: 80263 | " +
  "Cache read: 8601104 | Cache creation: 211244 | Cost: $8.4341 | " +
  "Session: 3f2ca1ea-35ac-4320-9c57-c8f9b74c2e0c";

/** A complete successful run log, timestamps matching a real run's shape.
 *  Stream clock times are local (UTC+3 here); section headers are UTC. */
function successLog(): string {
  return [
    "",
    section("DISPATCH", "2026-08-02T18:49:12.446Z", DISPATCH_BODY),
    section("PROMPT", "2026-08-02T18:49:12.447Z", "# Ticket #1260: Capture\n\nIssue body here.\n"),
    section(
      "SYSTEM PROMPT",
      "2026-08-02T18:49:12.447Z",
      [
        "You are the developer agent.",
        "",
        "[21:49:30] 🔧 Session initialized (3f2ca1ea)",
        "[21:55:02] [tool] Bash",
        "[22:07:27] 🏁 success | Turns: 53",
        "",
      ].join("\n"),
    ),
    section("OUTPUT (success)", "2026-08-02T19:07:27.617Z", "PR opened: https://example.test/pr/1265\n\nAll done, nothing to see.\n"),
    section("USAGE", "2026-08-02T19:07:27.617Z", `${USAGE_LINE}\n`),
  ].join("\n");
}

describe("classifyLogFileName", () => {
  test("accepts a normal run log", () => {
    assert.equal(classifyLogFileName("2026-08-02T18-49-06-962Z_developer_#1260.log"), "run");
  });

  test("rejects real-claude-gate logs (different schema entirely)", () => {
    assert.equal(classifyLogFileName("2026-08-07T20-15-28-403Z_real-claude-gate_#1382.log"), "excluded");
    assert.equal(classifyLogFileName("2026-08-07T20-15-28-403Z_real-claude-gate-base_#1382.log"), "excluded");
  });

  test("rejects stderr and non-log files", () => {
    assert.equal(classifyLogFileName("2026-08-07T20-15-28-403Z_developer_#1382.stderr.log"), "excluded");
    assert.equal(classifyLogFileName("notes.txt"), "excluded");
    assert.equal(classifyLogFileName(".DS_Store"), "excluded");
  });
});

describe("parseFileName", () => {
  test("extracts timestamp, agent, ticket", () => {
    const got = parseFileName("2026-08-02T18-49-06-962Z_code-review_#1260.log");
    assert.deepEqual(got, {
      timestamp: "2026-08-02T18:49:06.962Z",
      agent: "code-review",
      ticket: 1260,
    });
  });

  test("returns null for a name that does not match the run shape", () => {
    assert.equal(parseFileName("random.log"), null);
  });
});

describe("parseUsageLine", () => {
  test("parses every field of the pipe-delimited usage line", () => {
    const got = parseUsageLine(USAGE_LINE);
    assert.deepEqual(got, {
      turns: 53,
      durationSeconds: 1094,
      inputTokens: 86,
      outputTokens: 80263,
      cacheRead: 8601104,
      cacheCreation: 211244,
      costUsd: 8.4341,
      sessionId: "3f2ca1ea-35ac-4320-9c57-c8f9b74c2e0c",
    });
  });

  test("returns null on a line that is not a usage line", () => {
    assert.equal(parseUsageLine("Turns: many | vibes: good"), null);
  });
});

describe("parseRunLog — successful run", () => {
  const result = parseRunLog("2026-08-02T18-49-06-962Z_developer_#1260.log", successLog());

  test("parses as a run, not an exclusion", () => {
    assert.equal(result.kind, "run");
  });

  test("extracts dispatch metadata", () => {
    assert.ok(result.kind === "run");
    const run = result.run;
    assert.equal(run.agent, "developer");
    assert.equal(run.ticket, 1260);
    assert.equal(run.fileTimestamp, "2026-08-02T18:49:06.962Z");
    assert.equal(run.dispatch.ticketTitle, "Capture every stream-json line — with an em-dash in the title");
    assert.equal(run.dispatch.branch, "feature/1260");
    assert.equal(run.dispatch.worktree, "/work/.worktrees/developer-1260");
    assert.equal(run.dispatch.maxTurns, 135);
    assert.equal(run.dispatch.timeoutMinutes, 25);
  });

  test("records section names and timestamps in order", () => {
    assert.ok(result.kind === "run");
    assert.deepEqual(
      result.run.sections.map((s) => s.name),
      ["DISPATCH", "PROMPT", "SYSTEM PROMPT", "OUTPUT (success)", "USAGE"],
    );
    assert.equal(result.run.sections[0].timestamp, "2026-08-02T18:49:12.446Z");
    assert.equal(result.run.sections[4].timestamp, "2026-08-02T19:07:27.617Z");
  });

  test("classifies as success and parses usage", () => {
    assert.ok(result.kind === "run");
    assert.equal(result.run.status, "success");
    assert.equal(result.run.usage?.turns, 53);
    assert.equal(result.run.usage?.costUsd, 8.4341);
    assert.equal(result.run.usage?.sessionId, "3f2ca1ea-35ac-4320-9c57-c8f9b74c2e0c");
  });

  test("captures the OUTPUT body", () => {
    assert.ok(result.kind === "run");
    assert.match(result.run.output ?? "", /PR opened/);
  });

  test("wall clock runs from the DISPATCH header to the USAGE header", () => {
    assert.ok(result.kind === "run");
    // 18:49:12.446 → 19:07:27.617 = 1095.171s
    assert.equal(result.run.wallClockEndSource, "usage");
    assert.ok(Math.abs(result.run.wallClockSeconds - 1095.171) < 0.01);
  });

  test("wall clock disagrees with the model-reported duration when it should", () => {
    assert.ok(result.kind === "run");
    // Model said 1094s; wall clock is ~1095.2s. Both survive, separately.
    assert.equal(result.run.usage?.durationSeconds, 1094);
    assert.ok(result.run.wallClockSeconds > result.run.usage!.durationSeconds);
  });
});

describe("parseRunLog — failure signals", () => {
  test("a run with ERROR and no OUTPUT/USAGE is failed, wall clock ends at ERROR", () => {
    const log = [
      "",
      section("DISPATCH", "2026-08-02T17:56:57.072Z", DISPATCH_BODY),
      section("PROMPT", "2026-08-02T17:56:57.072Z", "prompt\n"),
      section("SYSTEM PROMPT", "2026-08-02T17:56:57.072Z", "[20:57:10] spawn\n[21:00:44] dying\n"),
      section("ERROR", "2026-08-02T18:00:44.836Z", "Agent error (api_error): connection closed.\nSession: 7bb5a0eb\n"),
    ].join("\n");
    const result = parseRunLog("2026-08-02T17-56-52-841Z_documentation_#1251.log", log);
    assert.ok(result.kind === "run");
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.usage, null);
    assert.match(result.run.errorText ?? "", /api_error/);
    assert.equal(result.run.wallClockEndSource, "error");
    assert.ok(Math.abs(result.run.wallClockSeconds - 227.764) < 0.01);
  });

  test("a killed run (no section after the stream) ends at the last stream line", () => {
    // Section headers are UTC; stream clock is local UTC+3.
    // Last stream line 21:30:00 local = 18:30:00Z → 1800s after dispatch.
    const log = [
      "",
      section("DISPATCH", "2026-08-02T18:00:00.000Z", DISPATCH_BODY),
      section("PROMPT", "2026-08-02T18:00:00.100Z", "prompt\n"),
      section(
        "SYSTEM PROMPT",
        "2026-08-02T18:00:00.200Z",
        "system prompt text\n[21:00:05] 🔧 Session initialized\n[21:14:00] working\n[21:30:00] last sign of life\n",
      ),
    ].join("\n");
    const result = parseRunLog("2026-08-02T17-59-59-000Z_developer_#1300.log", log);
    assert.ok(result.kind === "run");
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.wallClockEndSource, "stream");
    assert.ok(Math.abs(result.run.wallClockSeconds - 1800) < 1);
  });

  test("stream clock rolling past midnight does not go backwards", () => {
    // Dispatch at 23:50:01Z; local clock UTC+3 so stream starts 02:50:10.
    // Last line 00:20:00 local crossed local midnight → 21:20:00Z...
    // no: 00:20:00 local next day = 2026-08-03T21:20? Work it through the
    // parser's contract instead: elapsed must be positive and small, and
    // the end must land after the start.
    const log = [
      "",
      section("DISPATCH", "2026-08-02T23:50:00.000Z", DISPATCH_BODY),
      section("PROMPT", "2026-08-02T23:50:00.500Z", "prompt\n"),
      section(
        "SYSTEM PROMPT",
        "2026-08-02T23:50:01.000Z",
        "[02:50:10] 🔧 Session initialized\n[02:59:59] tick\n[03:20:00] tock\n",
      ),
    ].join("\n");
    const result = parseRunLog("2026-08-02T23-49-58-000Z_qa_#1301.log", log);
    assert.ok(result.kind === "run");
    // 23:50:00Z → 03:20:00 local (= 00:20:00Z next day) = 1800s.
    assert.ok(Math.abs(result.run.wallClockSeconds - 1800) < 1);
  });

  test("a killed run with no stream lines ends at the last section header", () => {
    const log = [
      "",
      section("DISPATCH", "2026-08-02T18:00:00.000Z", DISPATCH_BODY),
      section("PROMPT", "2026-08-02T18:00:01.000Z", "prompt\n"),
      section("SYSTEM PROMPT", "2026-08-02T18:00:02.000Z", "system prompt only\n"),
    ].join("\n");
    const result = parseRunLog("2026-08-02T17-59-59-000Z_developer_#1302.log", log);
    assert.ok(result.kind === "run");
    assert.equal(result.run.wallClockEndSource, "section");
    assert.ok(Math.abs(result.run.wallClockSeconds - 2) < 0.01);
  });
});

describe("parseRunLog — salvage variants", () => {
  test("SAFER_SALVAGE with a later OUTPUT/USAGE classifies as salvaged", () => {
    const log = [
      "",
      section("DISPATCH", "2026-08-31T16:30:00.000Z", DISPATCH_BODY),
      section("PROMPT", "2026-08-31T16:30:00.100Z", "prompt\n"),
      section("SYSTEM PROMPT", "2026-08-31T16:30:00.200Z", "[19:30:05] init\n[19:59:00] cut off\n"),
      section("SAFER_SALVAGE", "2026-08-31T17:00:32.610Z", "Committed + pushed + draft PR opened for #303 (70 turns, $4.74)\n"),
      section("OUTPUT (success)", "2026-08-31T17:00:33.000Z", "Draft PR opened.\n"),
      section("USAGE", "2026-08-31T17:00:33.000Z", `${USAGE_LINE}\n`),
    ].join("\n");
    const result = parseRunLog("2026-08-31T16-29-58-000Z_developer_#303.log", log);
    assert.ok(result.kind === "run");
    assert.equal(result.run.status, "salvaged");
    assert.equal(result.run.usage?.turns, 53);
    assert.equal(result.run.wallClockEndSource, "usage");
  });

  test("SALVAGED alone still classifies as salvaged", () => {
    const log = [
      "",
      section("DISPATCH", "2026-08-11T14:00:00.000Z", DISPATCH_BODY),
      section("PROMPT", "2026-08-11T14:00:00.100Z", "prompt\n"),
      section("SYSTEM PROMPT", "2026-08-11T14:00:00.200Z", "[17:00:05] init\n"),
      section("SALVAGED", "2026-08-11T14:10:11.258Z", "Agent hit max_turns but ready PR #42 was already created. Treating as success.\n"),
    ].join("\n");
    const result = parseRunLog("2026-08-11T13-59-58-000Z_developer_#1400.log", log);
    assert.ok(result.kind === "run");
    assert.equal(result.run.status, "salvaged");
  });
});

describe("parseRunLog — exclusions", () => {
  test("a DISPATCH Ticket line containing 'Test ticket' is test-suite pollution", () => {
    const body = DISPATCH_BODY.replace(/^Ticket: .*$/m, "Ticket: #250 — Test ticket");
    const log = [
      "",
      section("DISPATCH", "2026-08-11T14:10:11.253Z", body),
      section("PROMPT", "2026-08-11T14:10:11.254Z", "prompt\n"),
      section("SYSTEM PROMPT", "2026-08-11T14:10:11.255Z", "sp\n"),
    ].join("\n");
    const result = parseRunLog("2026-08-11T14-10-11-253Z_architect_#250.log", log);
    assert.deepEqual(result, {
      kind: "excluded",
      file: "2026-08-11T14-10-11-253Z_architect_#250.log",
      reason: "test-ticket",
    });
  });

  test("a PROMPT body of '## Mock prompt' is test-suite pollution even with a plausible title", () => {
    // The dispatcher's test suite also writes mock logs titled "Test
    // feature" / "Override" against tickets #201/#205. Their tell is the
    // mock PROMPT body, not the title.
    const body = DISPATCH_BODY.replace(/^Ticket: .*$/m, "Ticket: #201 — Test feature");
    const log = [
      "",
      section("DISPATCH", "2026-09-01T09:59:15.144Z", body),
      section("PROMPT", "2026-09-01T09:59:15.145Z", "## Mock prompt #201\n"),
      section("SYSTEM PROMPT", "2026-09-01T09:59:15.145Z", "Mock developer system prompt\n"),
    ].join("\n");
    const result = parseRunLog("2026-09-01T09-59-15-144Z_developer_#201.log", log);
    assert.deepEqual(result, {
      kind: "excluded",
      file: "2026-09-01T09-59-15-144Z_developer_#201.log",
      reason: "mock-prompt",
    });
  });

  test("a fragment with no DISPATCH section is unparseable pollution", () => {
    const log = ["", section("SALVAGED", "2026-08-11T14:10:11.258Z", "Treating as success.\n")].join("\n");
    const result = parseRunLog("2026-08-11T14-10-11-258Z_developer_#301.log", log);
    assert.deepEqual(result, {
      kind: "excluded",
      file: "2026-08-11T14-10-11-258Z_developer_#301.log",
      reason: "no-dispatch",
    });
  });
});

describe("parseRunLog — robustness", () => {
  test("timestamped-looking lines inside the PROMPT body do not shift the wall clock", () => {
    // The prompt quotes a log excerpt with clock lines wildly out of order.
    // Only the stream after SYSTEM PROMPT counts.
    const log = [
      "",
      section("DISPATCH", "2026-08-02T18:00:00.000Z", DISPATCH_BODY),
      section("PROMPT", "2026-08-02T18:00:00.100Z", "Quoting an old log:\n[03:00:00] ancient line\n[04:12:59] another\n"),
      section("SYSTEM PROMPT", "2026-08-02T18:00:00.200Z", "[21:00:05] init\n[21:10:00] end\n"),
    ].join("\n");
    const result = parseRunLog("2026-08-02T17-59-59-000Z_developer_#1303.log", log);
    assert.ok(result.kind === "run");
    assert.ok(Math.abs(result.run.wallClockSeconds - 600) < 1);
  });

  test("a lone delimiter line inside a section body does not start a section", () => {
    const log = [
      "",
      section("DISPATCH", "2026-08-02T18:00:00.000Z", DISPATCH_BODY),
      section("PROMPT", "2026-08-02T18:00:00.100Z", `code fence:\n${DELIM}\nnot a header\n`),
      section("SYSTEM PROMPT", "2026-08-02T18:00:00.200Z", "sp\n"),
      section("OUTPUT (success)", "2026-08-02T18:05:00.000Z", "done\n"),
      section("USAGE", "2026-08-02T18:05:00.000Z", `${USAGE_LINE}\n`),
    ].join("\n");
    const result = parseRunLog("2026-08-02T17-59-59-000Z_po_#1304.log", log);
    assert.ok(result.kind === "run");
    assert.deepEqual(
      result.run.sections.map((s) => s.name),
      ["DISPATCH", "PROMPT", "SYSTEM PROMPT", "OUTPUT (success)", "USAGE"],
    );
  });
});

describe("loadRuns", () => {
  test("walks a directory with injected deps, splitting runs from exclusions", () => {
    const files = new Map<string, string>([
      ["2026-08-02T18-49-06-962Z_developer_#1260.log", successLog()],
      ["2026-08-07T20-15-28-403Z_real-claude-gate_#1382.log", "raw go test output"],
      ["2026-08-07T20-15-28-403Z_developer_#1382.stderr.log", "stderr noise"],
      ["2026-08-11T14-10-11-258Z_developer_#301.log", ["", section("SALVAGED", "2026-08-11T14:10:11.258Z", "x\n")].join("\n")],
    ]);
    const deps = {
      readdirSync: (dir: string) => {
        assert.equal(dir, "/fake/logs");
        return [...files.keys()];
      },
      readFileSync: (path: string) => {
        const name = path.split("/").pop()!;
        const content = files.get(name);
        assert.ok(content !== undefined, `unexpected read: ${path}`);
        return content;
      },
    };
    const { runs, excluded } = loadRuns("/fake/logs", deps);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ticket, 1260);
    assert.equal(excluded.length, 3);
    const reasons = excluded.map((e) => e.reason).sort();
    assert.deepEqual(reasons, ["filename", "filename", "no-dispatch"]);
  });
});
