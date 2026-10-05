import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGateReportSection, gateReportSection, isNamedIn, testMethod } from "./gate-report.js";
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
