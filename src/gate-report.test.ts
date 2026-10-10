import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGateReportSection, gateReportSection, gateRunMetaPath, isNamedIn, liveGateLines, MAX_LIVE_TESTS, serializeGateRunMeta, testMethod } from "./gate-report.js";
import { parseGateTestDetails, type GateRunReport } from "./gate-output.js";
import { verifierGatePassFileName, type VerifierGatePass } from "./verifier-gate-reuse.js";

const ISSUE = 1797;
const GATES = ["./gradlew check", "python3 scripts/android-test-gate.py ui"];

const JUNIT = `<?xml version="1.0"?>
<testsuites><testsuite name="ChatScreenTest" tests="3" failures="1" skipped="1">
<testcase classname="app.ChatScreenTest" name="sendsOnEnter"/>
<testcase classname="app.ChatScreenTest" name="showsError"><failure message="boom"/></testcase>
<testcase classname="app.ChatScreenTest" name="scrollsUp"><skipped message="flaky on CI"/></testcase>
</testsuite></testsuites>`;

const goLine = (action: string, test: string) =>
  JSON.stringify({ Action: action, Package: "github.com/pyrycode/pyrycode/e2e", Test: test });
const GO_OLD = [goLine("run", "TestSendOld"), goLine("pass", "TestSendOld")].join("\n");
const GO_NEW = [
  goLine("run", "TestSessionResume"), goLine("pass", "TestSessionResume"),
  goLine("run", "TestSessionCrash"), goLine("fail", "TestSessionCrash"),
].join("\n");

function recordedPass(logsDir: string): VerifierGatePass {
  return {
    issueNumber: ISSUE,
    commit: "c0ffee".padEnd(40, "0"),
    tree: "e".repeat(40),
    gatesHash: "h",
    gates: GATES,
    passedAt: "2026-10-05T08:00:00.000Z",
    summary: GATES.map((g) => `✓ ${g} (exit 0)`),
    logPaths: [join(logsDir, `verifier-gate_#${ISSUE}_1.log`), join(logsDir, `verifier-gate_#${ISSUE}_2.log`)],
  };
}

function logsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-report-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const UI_FORMATS = JSON.stringify({ [GATES[1]]: "junit-xml" });
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PYRY_VERIFIER_GATES: GATES.join(";"),
  ...extra,
});

describe("testMethod", () => {
  test("takes the part after # for JUnit, the last › segment for Playwright, the last . or / segment for Go", () => {
    assert.equal(testMethod("app.ChatScreenTest#sendsOnEnter", "junit-xml"), "sendsOnEnter");
    assert.equal(testMethod("chat.spec.ts › composer › sends on enter", "playwright-json"), "sends on enter");
    assert.equal(testMethod("github.com/pyrycode/pyrycode/e2e.TestResume", "go-json"), "TestResume");
    assert.equal(testMethod("github.com/pyrycode/pyrycode/e2e.TestResume/after_crash", "go-json"), "after_crash");
  });
});

describe("isNamedIn", () => {
  test("matches a method as a whole word only, so send does not match sendsOnEnter", () => {
    assert.equal(isNamedIn("send", "Check that `sendsOnEnter` passes."), false);
    assert.equal(isNamedIn("sendsOnEnter", "Check that `sendsOnEnter` passes."), true);
    assert.equal(isNamedIn("send", "The send test must pass."), true);
    assert.equal(isNamedIn("sends on enter", "Prove sends on enter still works."), true);
  });
});

describe("gateReportSection", () => {
  test("a recorded pass and a junit-xml UI gate log give the counts and passed for a method named in the issue body", () => {
    const dir = logsDir({
      [`verifier-gate_#${ISSUE}_2.log`]: JUNIT,
    });
    writeFileSync(join(dir, verifierGatePassFileName(ISSUE)), JSON.stringify(recordedPass(dir)));
    const text = gateReportSection({
      issueNumber: ISSUE, logsDir: dir, env: env({ PYRY_VERIFIER_GATE_FORMATS: UI_FORMATS }),
      namingText: "Evidence: `ChatScreenTest#sendsOnEnter` passes in the UI gate.",
    });
    assert.match(text, /^\n## Gate report\n/);
    assert.match(text, /----- BEGIN GATE REPORT -----\n[\s\S]*\n----- END GATE REPORT -----$/);
    assert.match(text, /passed at 2026-10-05T08:00:00.000Z on commit `c0ffee0{34}`/);
    assert.match(text, /- ✓ \.\/gradlew check \(exit 0\)/);
    assert.match(text, /- ✓ python3 scripts\/android-test-gate\.py ui \(exit 0\)/);
    assert.match(text, /verifier gate 2, `python3 scripts\/android-test-gate\.py ui` \(junit-xml\): 2 executed, 1 passed, 1 failed, 1 skipped/);
    assert.match(text, /- `sendsOnEnter`: verifier gate 2 passed\./);
    // The gate without a format is not a run of its own.
    assert.doesNotMatch(text, /verifier gate 1,/);
  });

  test("a named method absent from the log is not run, a failed one failed, a skipped one skipped", () => {
    const dir = logsDir({ [`verifier-gate_#${ISSUE}_2.log`]: JUNIT });
    const text = gateReportSection({
      issueNumber: ISSUE, logsDir: dir, env: env({ PYRY_VERIFIER_GATE_FORMATS: UI_FORMATS }),
      namingText: "Plan: cover `ChatScreenTest#scrollsToBottom`, showsError and scrollsUp.",
    });
    assert.match(text, /No recorded verifier gate pass/);
    assert.match(text, /- `scrollsToBottom`: verifier gate 2 not run\./);
    assert.match(text, /- `showsError`: verifier gate 2 failed\./);
    assert.match(text, /- `scrollsUp`: verifier gate 2 skipped\./);
    assert.doesNotMatch(text, /`sendsOnEnter`/, "a test the text does not name is not listed");
  });

  test("the latest real-claude output is read with PYRY_REAL_CLAUDE_GATE_FORMAT, ignoring rerun and base files", () => {
    const dir = logsDir({
      [`2026-10-04T10-00-00-000Z_real-claude-gate_#${ISSUE}.log`]: GO_OLD,
      [`2026-10-05T10-00-00-000Z_real-claude-gate_#${ISSUE}.log`]: GO_NEW,
      [`2026-10-05T11-00-00-000Z_real-claude-gate-rerun_#${ISSUE}.log`]: GO_OLD,
      [`2026-10-05T12-00-00-000Z_real-claude-gate-base_#${ISSUE}.log`]: GO_OLD,
      [`2026-10-05T13-00-00-000Z_real-claude-gate_#${ISSUE}.stderr.log`]: "noise",
      [`2026-10-06T10-00-00-000Z_real-claude-gate_#${ISSUE + 1}.log`]: GO_OLD,
    });
    const text = gateReportSection({
      issueNumber: ISSUE, logsDir: dir, env: env({ PYRY_REAL_CLAUDE_GATE_FORMAT: "go-json" }),
      namingText: "Run TestSessionResume and TestSessionCrash live. TestSendOld is unrelated.",
    });
    assert.match(text, /real-claude gate, latest output 2026-10-05T10-00-00-000Z \(go-json\): 2 executed, 1 passed, 1 failed, 0 skipped/);
    assert.match(text, /- `TestSessionResume`: real-claude gate passed\./);
    assert.match(text, /- `TestSessionCrash`: real-claude gate failed\./);
    assert.match(text, /- `TestSendOld`: real-claude gate not run\./);

    // Read with the configured format: the same go log under playwright-json
    // is unreadable, so it gives no counts and no result.
    const asPlaywright = gateReportSection({
      issueNumber: ISSUE, logsDir: dir, env: env({ PYRY_REAL_CLAUDE_GATE_FORMAT: "playwright-json" }),
      namingText: "TestSessionResume",
    });
    assert.match(asPlaywright, /real-claude gate, latest output 2026-10-05T10-00-00-000Z \(playwright-json\): unreadable, so no per-test counts/);
    assert.match(asPlaywright, /- `TestSessionResume`: real-claude gate no per-test counts\./);
    assert.doesNotMatch(asPlaywright, /gate passed/);

    // Unset, the format defaults to go-json as the gate itself does.
    const byDefault = gateReportSection({ issueNumber: ISSUE, logsDir: dir, env: env(), namingText: "" });
    assert.match(byDefault, /latest output 2026-10-05T10-00-00-000Z \(go-json\): 2 executed/);
  });

  test("a missing log or an unknown format gives no per-test counts, never passed", () => {
    const dir = logsDir({ [`2026-10-05T10-00-00-000Z_real-claude-gate_#${ISSUE}.log`]: GO_NEW });
    const text = gateReportSection({
      issueNumber: ISSUE, logsDir: dir,
      env: env({ PYRY_VERIFIER_GATE_FORMATS: UI_FORMATS, PYRY_REAL_CLAUDE_GATE_FORMAT: "tap" }),
      namingText: "`ChatScreenTest#sendsOnEnter` and TestSessionResume",
    });
    assert.match(text, /verifier gate 2, `python3 scripts\/android-test-gate\.py ui` \(junit-xml\): log missing, so no per-test counts/);
    assert.match(text, /real-claude gate, latest output 2026-10-05T10-00-00-000Z: no known format, so no per-test counts/);
    assert.match(text, /- `sendsOnEnter`: verifier gate 2 no per-test counts; real-claude gate no per-test counts\./);
    assert.doesNotMatch(text, /gate \d* *passed/);
  });

  test("no recorded pass, no formats and no live output give a short section", () => {
    const text = gateReportSection({ issueNumber: ISSUE, logsDir: logsDir({}), env: env(), namingText: "TestAnything" });
    assert.equal(text, "\n## Gate report\nNo gate report is available for this ticket: there is no recorded verifier gate pass, no verifier gate with a format in `PYRY_VERIFIER_GATE_FORMATS` and no real-claude gate output.");
  });
});

describe("buildGateReportSection", () => {
  test("caps the named tests it lists", () => {
    const names = Array.from({ length: 40 }, (_, i) => `TestCase${i}`);
    const raw = names.flatMap((n) => [goLine("run", n), goLine("pass", n)]).join("\n");
    const text = buildGateReportSection({
      pass: null,
      runs: [{ label: "real-claude gate", detail: "latest output s", format: "go-json", raw }],
      namingText: names.join(" "),
    });
    assert.equal((text.match(/^- `TestCase\d+`/gm) ?? []).length, 25);
    assert.match(text, /15 more named tests are not listed\./);
  });
});

// --------- The latest live gate run, test by test (2026-10-07) ---------
//
// Desktop #1818's documentation agent parked at 05:50 on 2026-10-07 asking
// for the named result of `real claude session checkbox grants repeated Bash
// use only in the current session`. The gate report it had said "No test in
// these runs is named in the issue body or the plan", and the totals alone
// prove nothing about one test. The live section lists every test.

/** A Playwright JSON report in the shape the desktop live gate writes. */
function playwrightReport(tests: Array<{ file: string; title: string; status: string; durations?: number[]; revision?: string; skip?: string }>): string {
  const byFile = new Map<string, any[]>();
  for (const t of tests) {
    const results = (t.durations ?? (t.status === "skipped" ? [] : [1000])).map((duration, i, all) => ({
      status: t.status === "flaky" && i < all.length - 1 ? "failed" : t.status === "unexpected" ? "failed" : "passed",
      duration,
      annotations: t.revision ? [{ type: "daemon-revision", description: t.revision }] : [],
    }));
    const spec = {
      title: t.title,
      tests: [{
        status: t.status,
        annotations: [
          ...(t.revision ? [{ type: "daemon-revision", description: t.revision }] : []),
          ...(t.skip ? [{ type: "skip", description: t.skip }] : []),
        ],
        results,
      }],
    };
    byFile.set(t.file, [...(byFile.get(t.file) ?? []), spec]);
  }
  return JSON.stringify({
    config: { metadata: {} },
    suites: [...byFile].map(([file, specs]) => ({ title: file, file, specs, suites: [] })),
    stats: { startTime: "2026-10-07T02:25:34.891Z" },
  });
}

const DESKTOP_1818 = playwrightReport([
  { file: "real-claude-attachment.spec.ts", title: "an attached image reaches claude, which describes it back (#1055 AC4)", status: "expected", durations: [12723] },
  { file: "real-claude-permission-modal.spec.ts", title: "real claude session checkbox grants repeated Bash use only in the current session", status: "expected", durations: [37172], revision: "0.37.0" },
  { file: "real-claude-permission-mode.spec.ts", title: "operator bypass stays confirmed through a no-op write", status: "flaky", durations: [9000, 20300], revision: "0.37.0" },
  { file: "real-claude-system-prompt.spec.ts", title: "real claude picks up a saved channel system prompt at Reset session", status: "skipped", skip: "needs a saved channel" },
]);

function liveMeta(over: Partial<GateRunReport> = {}): string {
  const report: GateRunReport = {
    runError: null, timedOut: false, exitCode: 0, tally: null,
    command: "npx playwright test --config playwright.real-claude.config.ts --reporter=json",
    branchName: "feature/1818", baseRef: "origin/main",
    baseSha: "4abcc59eb26217b4a2911edcf30e8386b59faed6", headSha: "7d59fb97d04130eb72da6982d583e2020e2692a9",
    commitsBehind: 0, durationMs: 420_486, outputPath: "x.log", outputBytes: 1,
    baselineFailures: null, baselineSkipReason: null, baselineOutputPath: null,
    rerunFailures: null, rerunSkipReason: null, rerunOutputPath: null,
    selection: { mode: "full", reason: "every run" },
    ...over,
  };
  return serializeGateRunMeta(report, { PYRY_BIN: "/usr/local/bin/pyry" }, new Date("2026-10-07T02:32:35Z"));
}

describe("gate report: the latest live gate run, test by test", () => {
  const STAMP = "2026-10-07T02-23-21-880Z";
  const liveLog = `${STAMP}_real-claude-gate_#${ISSUE}.log`;

  test("desktop #1818: every test is listed with status, attempts, duration and daemon revision, though nothing names it", () => {
    const dir = logsDir({ [liveLog]: DESKTOP_1818, [gateRunMetaPath(liveLog)]: liveMeta() });
    const text = gateReportSection({
      issueNumber: ISSUE, logsDir: dir, env: env({ PYRY_REAL_CLAUDE_GATE_FORMAT: "playwright-json" }),
      namingText: "Inline permission cards with navigation-retained session grants.",
    });
    assert.match(text, /- No test in these runs is named in the issue body or the plan\./, "the old section alone left the agent with nothing");
    assert.match(text, /Latest real-claude gate run, every test \(output 2026-10-07T02-23-21-880Z, playwright-json\):/);
    assert.match(text, /- Tested: `feature\/1818` at `7d59fb97d041` merged with `origin\/main` at `4abcc59eb262`; full suite; exit 0 in 7m 0s\./);
    assert.match(text, /- Daemon revision: `0\.37\.0`, from the `daemon-revision` annotations of 2 of 4 tests\. `PYRY_BIN` was `\/usr\/local\/bin\/pyry`\./);
    assert.match(text, /- Counts: 3 executed, 3 passed \(1 of them flaky\), 0 failed, 1 skipped\./);
    assert.ok(text.includes("  - `real-claude-permission-modal.spec.ts › real claude session checkbox grants repeated Bash use only in the current session`: passed, 1 attempt, 37.2 s, daemon 0.37.0"), text);
    assert.ok(text.includes("  - `real-claude-permission-mode.spec.ts › operator bypass stays confirmed through a no-op write`: flaky, passed on attempt 2 of 2, 20.3 s, daemon 0.37.0"), text);
    assert.ok(text.includes("  - `real-claude-system-prompt.spec.ts › real claude picks up a saved channel system prompt at Reset session`: skipped: needs a saved channel"), text);
    assert.ok(text.includes("  - `real-claude-attachment.spec.ts › an attached image reaches claude, which describes it back (#1055 AC4)`: passed, 1 attempt, 12.7 s"), text);
    assert.match(text, /----- END GATE REPORT -----$/, "inside the fenced data block");
  });

  test("no run record beside the output: the section says the tested commits are not known here", () => {
    const dir = logsDir({ [liveLog]: DESKTOP_1818 });
    const text = gateReportSection({ issueNumber: ISSUE, logsDir: dir, env: env({ PYRY_REAL_CLAUDE_GATE_FORMAT: "playwright-json" }), namingText: "" });
    assert.match(text, /- Tested: no run record was kept beside this output/);
    assert.match(text, /- Daemon revision: `0\.37\.0`/);
  });

  test("an unreadable output or an unknown format gives no per-test results", () => {
    const dir = logsDir({ [liveLog]: "not json at all" });
    const text = gateReportSection({ issueNumber: ISSUE, logsDir: dir, env: env({ PYRY_REAL_CLAUDE_GATE_FORMAT: "playwright-json" }), namingText: "" });
    assert.match(text, /- The output is unreadable, so there are no per-test results\./);
    assert.doesNotMatch(text, /- Results:/);
    const unknown = gateReportSection({ issueNumber: ISSUE, logsDir: dir, env: env({ PYRY_REAL_CLAUDE_GATE_FORMAT: "tap" }), namingText: "" });
    assert.match(unknown, /- No known format is configured for the live gate, so there are no per-test results\./);
  });

  /** `go test -json` events with Elapsed, one package. */
  const goEvents = (events: Array<[string, string, number?]>) => events.map(([action, test, elapsed]) =>
    JSON.stringify({ Action: action, Package: "github.com/pyrycode/pyrycode/internal/e2e/realclaude", Test: test, ...(elapsed !== undefined ? { Elapsed: elapsed } : {}) })).join("\n");

  test("Go: the daemon revision is the tested tree, subtests are listed by name, and a re-run that passed says so", () => {
    const raw = goEvents([
      ["run", "TestInteractiveStreamDormantResetAfterRestart"], ["fail", "TestInteractiveStreamDormantResetAfterRestart", 6.02],
      ["run", "TestReset/handoff"], ["pass", "TestReset/handoff", 2.5], ["pass", "TestReset", 2.5],
      ["run", "TestCodexQuestionLive"], ["skip", "TestCodexQuestionLive", 0],
    ]);
    const dir = logsDir({
      [liveLog]: raw,
      [gateRunMetaPath(liveLog)]: liveMeta({ branchName: "feature/2905", command: "go test -json ./internal/e2e/realclaude/...", rerunFailures: [] }),
    });
    const text = gateReportSection({ issueNumber: ISSUE, logsDir: dir, env: env({ PYRY_REAL_CLAUDE_GATE_FORMAT: "go-json" }), namingText: "" });
    assert.match(text, /- Daemon revision: the Go live suite builds the daemon from the tested tree, so it is the tested commits above\./);
    assert.match(text, /- Counts: 2 executed, 1 passed \(0 of them flaky\), 1 failed, 1 skipped\./);
    assert.match(text, /- Same-tree re-run: the dispatcher re-ran the 1 failed test\(s\) on the same merged tree; 1 passed there\./);
    assert.ok(text.includes("  - `TestInteractiveStreamDormantResetAfterRestart`: failed, then passed on the dispatcher's same-tree re-run, 6.0 s"), text);
    assert.ok(text.includes("  - `TestReset/handoff`: passed, 2.5 s"), text);
    assert.match(text, /  - `TestCodexQuestionLive`: skipped: no reason recorded/);
  });

  test(`Go over ${MAX_LIVE_TESTS} tests: only failures, skips and the named test function are listed, and the rest are counted`, () => {
    const events: Array<[string, string, number?]> = [];
    for (let i = 0; i < 200; i++) events.push(["run", `TestBulk${i}`], ["pass", `TestBulk${i}`, 0.1]);
    events.push(["run", "TestNamedThing/case_a"], ["pass", "TestNamedThing/case_a", 1], ["pass", "TestNamedThing", 1]);
    events.push(["run", "TestSkips"], ["skip", "TestSkips", 0]);
    const dir = logsDir({ [liveLog]: goEvents(events), [gateRunMetaPath(liveLog)]: liveMeta() });
    const text = gateReportSection({
      issueNumber: ISSUE, logsDir: dir, env: env({ PYRY_REAL_CLAUDE_GATE_FORMAT: "go-json" }),
      namingText: "Acceptance: TestNamedThing passes live.",
    });
    const listed = text.split("\n").filter((l) => l.startsWith("  - `"));
    assert.deepEqual(listed.map((l) => l.split("`")[1]), ["TestSkips", "TestNamedThing/case_a"], "no padding with unnamed passes");
    assert.match(text, /- Results: the run has 202 tests, over 150, so only failures, flakes, skips and the tests/);
    assert.match(text, /  - 200 more tests are not listed\. Every one of them passed\./);
  });

  test("JUnit: statuses from the tally, no daemon annotation", () => {
    const lines = liveGateLines({ stamp: STAMP, format: "junit-xml", raw: JUNIT, meta: null }, "");
    const text = lines.join("\n");
    assert.match(text, /- Daemon revision: no `daemon-revision` annotation in this run\./);
    assert.match(text, /- Counts: 2 executed, 1 passed \(0 of them flaky\), 1 failed, 1 skipped\./);
    assert.match(text, /`app\.ChatScreenTest#showsError`: failed/);
    assert.match(text, /`app\.ChatScreenTest#scrollsUp`: skipped: flaky on CI/);
  });
});

describe("parseGateTestDetails", () => {
  test("agrees with the tally's statuses for each format and is null for an unreadable artifact", () => {
    const pw = parseGateTestDetails(DESKTOP_1818, "playwright-json")!;
    assert.deepEqual(pw.map((d) => d.status), ["passed", "passed", "flaky", "skipped"]);
    assert.deepEqual(pw[1].daemonRevisions, ["0.37.0"]);
    assert.equal(pw[2].attempts, 2);
    const go = parseGateTestDetails(GO_NEW, "go-json")!;
    assert.deepEqual(go.map((d) => [d.name.split(".").pop(), d.status]), [["TestSessionCrash", "failed"], ["TestSessionResume", "passed"]]);
    assert.equal(parseGateTestDetails("garbage", "go-json"), null);
    assert.equal(parseGateTestDetails("garbage", "playwright-json"), null);
  });
});
