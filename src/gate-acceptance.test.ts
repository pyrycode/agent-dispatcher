import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateRunFloor, gateRunRequiredTests, parseGateOutput, parseGateTestDetails, requiredLiveTests, type GateRunReport } from "./gate-output.js";
import { decideGateVerdict, decideGateOutcome, classifyBlockedRun } from "./pipeline-decisions.js";
import { buildGateReportSection, liveGateLines, parseGateRunMeta, serializeGateRunMeta } from "./gate-report.js";

// Reduced retained 2026-10-11 #1809 report: preserve titles, outcomes,
// attempts and Luna evidence; omit host paths, console output and unrelated attachments.
const raw = readFileSync(new URL("./fixtures/desktop-1809-live-report.json", import.meta.url), "utf8");
const luna = "real-claude-codex-channel.spec.ts › real GPT-6 Luna channel replies with Low effort from creation";
const decide = (output = raw, requiredTests = [luna]) => decideGateVerdict({
  runError: null, timedOut: false, exitCode: 0, minExecuted: 10,
  tally: parseGateOutput(output, "playwright-json"), requiredTests,
});

const revision = { name: "daemon-revision", contentType: "text/plain", body: Buffer.from("0.37.0").toString("base64") };
const model = { agent: "codex", value: "gpt-6-luna", display_name: "GPT-6 Luna", effort_levels: ["low"] };
const row = { name: "published-model-row", contentType: "application/json", body: Buffer.from(JSON.stringify({
  serverId: "test-server", conversationId: "test-channel", model, models: [model],
})).toString("base64") };
const annotation = { type: "daemon-revision", description: "0.37.0" };
// Synthetic passing attempts are parser fixtures, never live acceptance.
const attempt = () => ({ status: "passed", duration: 12_000, annotations: [annotation], attachments: [revision, row] });
function withLuna(test: Record<string, unknown>): string {
  const doc = JSON.parse(raw);
  const suite = doc.suites.find((s: any) => s.title === "real-claude-codex-channel.spec.ts");
  suite.specs[0].tests = [test];
  return JSON.stringify(doc);
}
function withoutLuna(): string {
  const doc = JSON.parse(raw);
  doc.suites = doc.suites.filter((s: any) => s.title !== "real-claude-codex-channel.spec.ts");
  return JSON.stringify(doc);
}
function colonLuna(output = raw): string {
  const doc = JSON.parse(output);
  const suite = doc.suites.find((s: any) => s.title === "real-claude-codex-channel.spec.ts");
  suite.specs[0].title = "real codex: GPT-6 Luna replies";
  for (const test of suite.specs[0].tests) {
    if (test.status === "skipped") test.annotations = [{ type: "skip", description: "sign-in prerequisite: PYRY_CODEX_CAPTURE_HOME is unset: no live evidence" }];
  }
  return JSON.stringify(doc);
}
const passing = (results = [attempt()]) => withLuna({ status: "expected", annotations: [annotation], results });

test("tagged build prose preserves required Luna judgment and same-attempt evidence", () => {
  for (const output of [raw, passing(), passing([{ ...attempt(), attachments: [] }]),
    withLuna({ status: "unexpected", results: [{ status: "failed" }] })]) {
    const logged = `[INFO] build starting\n${output}`;
    assert.deepEqual(parseGateOutput(logged, "playwright-json"), parseGateOutput(output, "playwright-json"));
    assert.deepEqual(decide(logged), decide(output));
  }
});

function report(output = raw, selection?: GateRunReport["selection"]): GateRunReport {
  return {
    outputFormat: "playwright-json", requiredTests: [luna], selection, tally: parseGateOutput(output, "playwright-json"),
    runError: null, timedOut: false, exitCode: 0, command: "playwright test --reporter=json",
    branchName: "feature/1809", headSha: "a".repeat(40), baseRef: "origin/main", baseSha: "b".repeat(40),
    commitsBehind: 0, durationMs: 10, outputPath: "1809.log", outputBytes: output.length,
    baselineFailures: null, baselineSkipReason: null, baselineOutputPath: null,
    rerunFailures: null, rerunSkipReason: null, rerunOutputPath: null,
  };
}

test("retained #1809: 26 passes and exit 0 cannot accept the skipped required Luna test", () => {
  const tally = parseGateOutput(raw, "playwright-json");
  assert.equal(tally.passed, 26);
  assert.ok(tally.skipReasons.some(s => s.includes("PYRY_CODEX_CAPTURE_HOME is unset")));
  const verdict = decide();
  assert.equal(verdict.verdict, "unusable");
  assert.equal(decide(raw, []).verdict, "unusable", "legacy reports still expose the skipped Luna requirement");
  assert.match(verdict.reason, /Luna.*skipped/);
  const outcome = decideGateOutcome(verdict.verdict);
  assert.equal(outcome.toColumn, null);
  assert.ok(!outcome.removeLabels.includes("needs-real-claude"));
});

test("an absent explicit required live result cannot be replaced by suite totals", () => {
  assert.equal(decide(raw, ["absent.spec.ts › required live scenario"]).verdict, "unusable");
  assert.equal(decide(withoutLuna()).verdict, "unusable");
});

test("legacy skipped Luna titles containing a colon still expose missing acceptance", () => {
  const doc = JSON.parse(raw);
  const suite = doc.suites.find((s: any) => s.title === "real-claude-codex-channel.spec.ts");
  suite.specs[0].title = "real codex: GPT-6 Luna replies";
  const verdict = decide(JSON.stringify(doc), []);
  assert.equal(verdict.verdict, "unusable");
  assert.match(verdict.reason, /Luna.*skipped/);
});

test("legacy saved tally above floor cannot hide a colon-containing skipped Luna test", () => {
  const saved = JSON.parse(JSON.stringify(report(colonLuna()))) as GateRunReport;
  delete saved.requiredTests;
  delete saved.outputFormat;
  delete saved.tally!.testDetails;
  delete saved.tally!.skippedTests;
  assert.ok(saved.tally!.executed > 10);
  assert.ok(!("requiredTests" in saved));
  assert.ok(!("outputFormat" in saved));
  assert.ok(!("testDetails" in saved.tally!));
  assert.ok(!("skippedTests" in saved.tally!));
  const verdict = decideGateVerdict({ ...saved, minExecuted: 10 });
  assert.equal(verdict.verdict, "unusable");
});

test("a legacy full tally with zero skips cannot stand in for attempt evidence", () => {
  const doc = JSON.parse(withoutLuna());
  for (const suite of doc.suites) suite.specs = suite.specs.filter((s: any) => s.tests.every((t: any) => t.status !== "skipped"));
  const output = JSON.stringify(doc);
  const saved = JSON.parse(JSON.stringify(report(output, { mode: "full", reason: "all" }))) as GateRunReport;
  delete saved.requiredTests;
  delete saved.outputFormat;
  delete saved.tally!.testDetails;
  delete saved.tally!.skippedTests;
  assert.equal(saved.tally!.skipped, 0);
  assert.equal(decideGateVerdict({ ...saved, minExecuted: 10 }).verdict, "unusable");
});

test("structured skips survive saved full and selected reports without attempt details", () => {
  const name = "real-claude-codex-channel.spec.ts › real codex: GPT-6 Luna replies";
  for (const selection of [undefined, { mode: "full" as const, reason: "all" },
    { mode: "selected" as const, tests: [name], filter: "x", reason: "named" }]) {
    const saved = JSON.parse(JSON.stringify(report(colonLuna(), selection))) as GateRunReport;
    delete saved.requiredTests;
    delete saved.tally!.testDetails;
    assert.ok(saved.tally!.skippedTests!.some(t => t.name === name && t.reason.includes("unset:")));
    const verdict = decideGateVerdict({ ...saved, minExecuted: gateRunFloor(saved, 10), requiredTests: gateRunRequiredTests(saved) });
    assert.equal(verdict.verdict, "unusable");
    assert.match(verdict.reason, /real codex: GPT-6 Luna replies skipped/);
  }
  const text = buildGateReportSection({ pass: null, namingText: "real codex: GPT-6 Luna replies", runs: [
    { label: "saved gate", detail: "fixture", format: "playwright-json", raw: colonLuna() },
  ] });
  assert.match(text, /real codex: GPT-6 Luna replies.*saved gate skipped/);
});

test("legacy verdicts reparse raw evidence and refuse incomplete recovery", () => {
  for (const output of [colonLuna(), colonLuna(passing([{ ...attempt(), attachments: [] }])), colonLuna(passing())]) {
    const saved = JSON.parse(JSON.stringify(report(output))) as GateRunReport;
    delete saved.requiredTests;
    delete saved.tally!.testDetails;
    delete saved.tally!.skippedTests;
    const verdict = decideGateVerdict({ ...saved, minExecuted: 10, rawOutput: output });
    assert.equal(verdict.verdict, output === colonLuna(passing()) ? "pass" : "unusable");
    for (const rawOutput of [null, "truncated: {\"suites\": ["]) {
      assert.equal(decideGateVerdict({ ...saved, minExecuted: 10, rawOutput }).verdict, "unusable");
    }
    delete saved.outputFormat;
    assert.equal(decideGateVerdict({ ...saved, minExecuted: 10, rawOutput: output }).verdict, "unusable");
  }
});

test("incomplete skip identities stay unusable and skip reasons cannot invent requirements", () => {
  const doc = JSON.parse(raw);
  doc.suites.push({ title: "optional.spec.ts", specs: [{ title: "optional: case", tests: [{ status: "skipped" }] }] });
  const tally = parseGateOutput(JSON.stringify(doc), "playwright-json");
  const skips = tally.skippedTests!;
  assert.ok(skips.length > 1);
  for (const skippedTests of [[], skips.slice(1)]) {
    assert.equal(decideGateVerdict({ runError: null, timedOut: false, exitCode: 0, minExecuted: 10,
      tally: { ...tally, skippedTests } }).verdict, "unusable");
  }
  delete tally.skippedTests;
  delete tally.testDetails;
  assert.equal(decideGateVerdict({ runError: null, timedOut: false, exitCode: 0, minExecuted: 10, tally }).verdict, "unusable");
  const unrelated = `${Array.from({ length: 11 }, (_, i) => JSON.stringify({ Action: "pass", Test: `TestOther${i}` })).join("\n")}\n` +
    JSON.stringify({ Action: "output", Test: "TestOptional", Output: "reason: Luna is irrelevant here" }) + "\n" +
    JSON.stringify({ Action: "skip", Test: "TestOptional" });
  assert.equal(decideGateVerdict({ runError: null, timedOut: false, exitCode: 0, minExecuted: 10,
    tally: parseGateOutput(unrelated, "go-json") }).verdict, "pass");
});

test("Go and JUnit retain colon-containing skipped names and reasons", () => {
  for (const [format, output, name] of [
    ["go-json", [
      { Action: "output", Package: "p", Test: "TestOptional/case:_one", Output: "reason: unavailable: fixture" },
      { Action: "skip", Package: "p", Test: "TestOptional/case:_one" },
    ].map(e => JSON.stringify(e)).join("\n"), "p.TestOptional/case:_one"],
    ["junit-xml", '<testsuite name="fixture"><testcase classname="p.C" name="case: one"><skipped message="reason: unavailable: fixture"/></testcase></testsuite>', "p.C#case: one"],
  ] as const) {
    const saved = JSON.parse(JSON.stringify(parseGateOutput(output, format)));
    assert.deepEqual(saved.skippedTests, [{ name, reason: "reason: unavailable: fixture" }]);
    assert.deepEqual(parseGateTestDetails(output, format), [{ name, status: "skipped", skipReason: "reason: unavailable: fixture" }]);
  }
});

test("genuine named failures still route to repair, including Luna", () => {
  const failure = withLuna({ status: "unexpected", results: [{ status: "failed" }] });
  const verdict = decide(failure);
  assert.equal(verdict.verdict, "fail");
  assert.equal(decideGateOutcome(verdict.verdict).toColumn, "In Development");
  assert.deepEqual(decideGateOutcome(verdict.verdict).removeLabels, []);
  const missing = decide(failure, ["absent.spec.ts › required"]);
  assert.equal(missing.verdict, "unusable");
});

test("operator Codex sign-in provisioning takes precedence over a missing variable retry", () => {
  const summary = "PYRY_CODEX_CAPTURE_HOME is unset. A separately provisioned Codex sign-in is required; the operator must provision the dedicated home. Live Luna acceptance is missing.";
  assert.equal(classifyBlockedRun(summary).transient, false);
  assert.equal(classifyBlockedRun(summary, { approvalReviewFailed: true }).transient, false);
  assert.equal(classifyBlockedRun("ANDROID_HOME is missing from the dispatcher environment").transient, true);
  assert.equal(classifyBlockedRun("ANDROID_HOME is missing; permission denied").transient, false);
  assert.equal(classifyBlockedRun("ANDROID_HOME is missing", { approvalRejected: true, approvalReviewFailed: true }).transient, false);
  assert.equal(classifyBlockedRun("Approval reviewer failed; operator review suggested.", { approvalReviewFailed: true }).transient, true);
  for (const summary of [
    "Codex sign-in is already provisioned. ANDROID_HOME is missing from the dispatcher environment.",
    "Using an already provisioned operator Codex sign-in; ANDROID_HOME is missing.",
    "The provisioned Codex login works. ANDROID_HOME is missing.",
    "Codex sign-in is already provisioned but ANDROID_HOME is missing from the dispatcher environment.",
  ]) {
    assert.equal(classifyBlockedRun(summary).transient, true, summary);
    assert.equal(classifyBlockedRun(summary, { approvalReviewFailed: true }).transient, true, summary);
  }
  for (const summary of [
    "ANDROID_HOME is missing; Codex sign-in required.",
    "ANDROID_HOME is missing; missing dedicated Codex credentials.",
    "ANDROID_HOME is missing; authentication must be provisioned.",
  ]) assert.equal(classifyBlockedRun(summary, { approvalReviewFailed: true }).transient, false, summary);
});

test("Luna requires execution and both nonempty attachments on the passing attempt", () => {
  assert.equal(decide(passing()).verdict, "pass");
  for (const incomplete of [
    { ...attempt(), attachments: [] },
    { ...attempt(), attachments: [revision] },
    { ...attempt(), attachments: [row] },
    { ...attempt(), annotations: [] },
    { ...attempt(), annotations: [{ ...annotation, description: "different-revision" }] },
    { ...attempt(), attachments: [revision, { ...row, body: "" }] },
    { ...attempt(), attachments: [revision, { ...row, body: Buffer.from("{}").toString("base64") }] },
    { ...attempt(), status: "skipped" },
    { ...attempt(), status: "failed" },
  ]) assert.equal(decide(passing([incomplete])).verdict, "unusable", JSON.stringify(incomplete));
  assert.equal(decide(passing([])).verdict, "unusable");
});

test("failed retries and aggregate annotations cannot lend proof to a later pass", () => {
  const failed = { ...attempt(), status: "failed" };
  assert.equal(decide(passing([failed, { ...attempt(), annotations: [], attachments: [] }])).verdict, "unusable");
  assert.equal(decide(passing([failed, { ...attempt(), attachments: [row] }])).verdict, "unusable");
  assert.equal(decide(withLuna({ status: "flaky", results: [failed, attempt()] })).verdict, "pass");
});

test("the published Luna row itself must offer Low effort", () => {
  for (const effort_levels of [undefined, [], ["high"]]) {
    const attachment = { ...row, body: Buffer.from(JSON.stringify({
      serverId: "test-server", conversationId: "test-channel", model,
      models: [{ ...model, effort_levels }],
    })).toString("base64") };
    assert.equal(decide(passing([{ ...attempt(), attachments: [revision, attachment] }])).verdict, "unusable");
  }
});

test("required generic Playwright tests need an actual passing attempt, not expected-failure status", () => {
  const name = "required.spec.ts › generic live test";
  const output = JSON.stringify({ suites: [{ title: "required.spec.ts", specs: [{ title: "generic live test", tests: [
    { status: "expected", results: [{ status: "failed" }] },
  ] }] }] });
  assert.equal(decideGateVerdict({ runError: null, timedOut: false, exitCode: 0, minExecuted: 1,
    tally: parseGateOutput(output, "playwright-json"), requiredTests: [name] }).verdict, "unusable");
});

test("selected and full saved reports preserve the same required Luna acceptance", () => {
  for (const selection of [undefined, { mode: "full" as const, reason: "shared path" },
    { mode: "selected" as const, tests: [luna], filter: "x", reason: "named" }]) {
    for (const output of [raw, passing()]) {
      const saved = JSON.parse(JSON.stringify(report(output, selection))) as GateRunReport;
      const verdict = decideGateVerdict({ ...saved, minExecuted: gateRunFloor(saved, 10), requiredTests: gateRunRequiredTests(saved) });
      assert.equal(verdict.verdict, output === raw ? "unusable" : "pass");
      const meta = parseGateRunMeta(serializeGateRunMeta(saved, {}, new Date("2026-10-11T13:20:00Z")))!;
      assert.deepEqual(meta.requiredTests, [luna]);
    }
  }
  const legacy = report(passing());
  delete legacy.tally!.testDetails;
  assert.equal(decideGateVerdict({ ...legacy, minExecuted: 10 }).verdict, "unusable", "a legacy tally cannot supply missing Luna attachments");
});

test("selected-run counts cannot substitute unrelated passes for the named test", () => {
  const saved = report(withoutLuna());
  delete saved.requiredTests; // Legacy reports carried only selected names.
  saved.selection = { mode: "selected", tests: ["absent.spec.ts › required"], filter: "x", reason: "named" };
  assert.equal(decideGateVerdict({ ...saved, minExecuted: gateRunFloor(saved, 10), requiredTests: gateRunRequiredTests(saved) }).verdict, "unusable");
  const meta = parseGateRunMeta(JSON.stringify({ headSha: "a", baseSha: "b", selection: "selected", selectedTests: [luna], requiredTests: [] }))!;
  assert.deepEqual(meta.requiredTests, [luna]);
});

test("documentation summaries expose skipped, absent and incomplete live acceptance", () => {
  for (const output of [raw, passing([{ ...attempt(), attachments: [] }])]) {
    const meta = parseGateRunMeta(serializeGateRunMeta(report(output), {}, new Date()))!;
    const text = liveGateLines({ stamp: "retained-1809", raw: output, format: "playwright-json", meta }, "").join("\n");
    assert.match(text, /Live acceptance remains missing/);
    assert.match(text, /needs-real-claude.*cannot advance to documentation/);
  }
  const absent = report();
  absent.requiredTests = ["absent.spec.ts › required"];
  const meta = parseGateRunMeta(serializeGateRunMeta(absent, {}, new Date()))!;
  assert.match(liveGateLines({ stamp: "saved", raw, format: "playwright-json", meta }, "").join("\n"), /required.*has no passing execution/);
  const validMeta = parseGateRunMeta(serializeGateRunMeta(report(passing()), {}, new Date()))!;
  const text = liveGateLines({ stamp: "valid", raw: passing(), format: "playwright-json", meta: validMeta }, "").join("\n");
  assert.doesNotMatch(text, /Live acceptance remains missing/);
  assert.match(text, /published-model-row on passing attempt 1/);
});

test("explicit requirements survive a PR requesting all tests", () => {
  assert.deepEqual(requiredLiveTests(`## Live tests\n- all\n- \`${luna}\`\n## Testing\n- unrelated`), [luna]);
});

test("required Go parents are judged by their executed leaves, including skips", () => {
  const output = ["one", "two"].map(leaf => JSON.stringify({ Action: "pass", Package: "p", Test: `TestRequired/${leaf}` })).join("\n");
  for (const name of ["p.TestRequired", "TestRequired"]) {
    const input = { runError: null, timedOut: false, exitCode: 0, minExecuted: 1,
      requiredTests: [name], tally: parseGateOutput(output, "go-json") };
    assert.equal(decideGateVerdict(input).verdict, "pass");
    const skipped = `${output}\n${JSON.stringify({ Action: "skip", Package: "p", Test: "TestRequired/three" })}`;
    assert.equal(decideGateVerdict({ ...input, tally: parseGateOutput(skipped, "go-json") }).verdict, "unusable");
  }
});
