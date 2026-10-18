import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateRunFloor, gateRunRequiredTests, parseGateOutput, type GateRunReport } from "./gate-output.js";
import { inheritedLiveTestNames, inheritedMarker, liveTestsSectionError, parseLiveTestEntries, requiredLiveTestNames } from "./live-tests.js";
import { parseLiveTestsSection } from "./gate-selection.js";
import { decideGateOutcome, decideGateVerdict } from "./pipeline-decisions.js";
import { liveGateLines, parseGateRunMeta, serializeGateRunMeta } from "./gate-report.js";

// Reduced retained 2026-10-11 Desktop #1809 report: 26 passes, the Luna
// scenario skipped. Synthetic edits below are parser fixtures, not live proof.
const raw = readFileSync(new URL("./fixtures/desktop-1809-live-report.json", import.meta.url), "utf8");
const luna = "real-claude-codex-channel.spec.ts › real GPT-6 Luna channel replies with Low effort from creation";
const effort = "real-claude-effort-default.spec.ts › applied effort, confirmed preference, restart, chat recall and channel creation choice";
const decide = (output: string, requiredTests: string[], minExecuted = 10) => decideGateVerdict({
  runError: null, timedOut: false, exitCode: 0, minExecuted, tally: parseGateOutput(output, "playwright-json"), requiredTests,
});

// The two Mobile pull request bodies that would have parked under the
// recovery candidate's reader, quoted from their `## Live tests` sections.
const mobile1847 = "## Summary\nx\n\n## Live tests\n\nall\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n";
const mobile2132 = "## Live tests\n\nde.pyryco.mobile.e2e.InteractiveStreamE2ETest#interactiveTurn_backgroundAgent_followsBottomUntilFinished\n\n" +
  "Review: self-reviewed reply identity, fragment completeness, cancellation, private diagnostics and navigation assertions. " +
  "No production code changes or configured GitHub CI checks.";

test("names come only from a valid section; all, none and empty name nothing; footers end it", () => {
  assert.deepEqual(parseLiveTestEntries(mobile1847), { present: true, all: true, names: [], invalid: [] });
  assert.deepEqual(requiredLiveTestNames(mobile1847), []);
  assert.deepEqual(parseLiveTestsSection(mobile1847), { kind: "all" });

  const wrong = parseLiveTestEntries(mobile2132);
  assert.deepEqual(wrong.names, [], "an invalid section names no test, not even its valid line");
  assert.equal(wrong.invalid.length, 1);
  assert.match(wrong.invalid[0], /^Review: self-reviewed/);
  assert.deepEqual(requiredLiveTestNames(mobile2132), []);
  assert.deepEqual(parseLiveTestsSection(mobile2132), { kind: "missing" }, "an invalid section runs the full suite");

  for (const body of ["## Live tests\n", "## Live tests\n\nnone\n", "## Live tests\n- None\n## Testing\n- prose", "no section"]) {
    assert.deepEqual(requiredLiveTestNames(body), [], body);
    assert.equal(liveTestsSectionError(body), null, body);
  }
  // `all` beside names asks for the whole suite and names nothing.
  assert.deepEqual(requiredLiveTestNames(`## Live tests\n- all\n- \`${luna}\``), []);
});

test("valid names keep code-span commas and colons, plain words and › titles", () => {
  const colon = "required.spec.ts › preference: Low, confirmed: yes";
  const body = [
    "## Live tests",
    "<!-- one per line -->",
    `- \`${effort}\`, a.B#one`,
    `1. \`\`${colon}\`\``,
    "* p.TestRename/case:_one",
    "+ settings.spec.ts › toggles dark mode",
    `- \`${effort}\``,
    "",
    "---",
    "Review: this is after a thematic break, so it is not in the section",
    "",
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
  ].join("\n");
  const names = [effort, "a.B#one", colon, "p.TestRename/case:_one", "settings.spec.ts › toggles dark mode"];
  assert.deepEqual(parseLiveTestEntries(body), { present: true, all: false, names, invalid: [] });
  assert.deepEqual(requiredLiveTestNames(body), names);
  assert.deepEqual(parseLiveTestsSection(body), { kind: "list", names });
  assert.deepEqual(requiredLiveTestNames("## Live tests\n- p.TestOne\nCo-Authored-By: someone\n- p.TestTwo"), ["p.TestOne"]);
});

test("prose, half code spans and unclosed spans are invalid lines with a clear message", () => {
  for (const line of [
    "This covers the reconnect path",
    "`a.spec.ts › one` and the other one",
    "`unclosed title",
    "p.TestOne, covers reconnects too",
  ]) {
    const body = `## Live tests\n- p.TestFine\n- ${line}`;
    assert.deepEqual(parseLiveTestEntries(body).invalid, [`- ${line}`], line);
    assert.deepEqual(requiredLiveTestNames(body), [], line);
    const message = liveTestsSectionError(body)!;
    assert.match(message, /lines that are not test names/);
    assert.ok(message.includes(line.replace(/`/g, "'")), message);
    assert.match(message, /backtick a title with spaces or commas/);
  }
});

test("suite totals cannot stand in for a skipped or absent required test", () => {
  const tally = parseGateOutput(raw, "playwright-json");
  assert.equal(tally.passed, 26);
  const skipped = decide(raw, [luna]);
  assert.equal(skipped.verdict, "unusable");
  assert.match(skipped.reason, /required live test .*Luna.* skipped/);
  const outcome = decideGateOutcome(skipped.verdict);
  assert.equal(outcome.toColumn, null);
  assert.ok(!outcome.removeLabels.includes("needs-real-claude"));
  assert.match(decide(raw, ["absent.spec.ts › required live scenario"]).reason, /has no passing execution/);
  assert.equal(decide(raw, [effort]).verdict, "pass", "a passing required test with commas in its title passes");
  assert.equal(decide(raw, []).verdict, "pass", "no named requirement, no named judgement");
});

test("a required Playwright test needs an actual passing attempt, not an expected-failure status", () => {
  const output = JSON.stringify({ suites: [{ title: "required.spec.ts", specs: [{ title: "generic live test", tests: [
    { status: "expected", expectedStatus: "failed", results: [{ status: "failed" }] },
  ] }] }] });
  assert.equal(decide(output, ["required.spec.ts › generic live test"], 1).verdict, "unusable");
  const flaky = JSON.stringify({ suites: [{ title: "required.spec.ts", specs: [{ title: "generic live test", tests: [
    { status: "flaky", results: [{ status: "failed" }, { status: "passed" }] },
  ] }] }] });
  assert.equal(decide(flaky, ["required.spec.ts › generic live test"], 1).verdict, "pass");
});

test("a named failure routes to repair; an absent name beside it does not", () => {
  const doc = JSON.parse(raw);
  doc.suites.find((s: any) => s.title === "real-claude-codex-channel.spec.ts").specs[0].tests = [{ status: "unexpected", results: [{ status: "failed" }] }];
  const failure = JSON.stringify(doc);
  const verdict = decide(failure, [luna]);
  assert.equal(verdict.verdict, "fail");
  assert.equal(decideGateOutcome(verdict.verdict).toColumn, "In Development");
  assert.equal(decide(failure, ["absent.spec.ts › required"]).verdict, "unusable");
});

test("required Go parents are judged by their executed leaves, including skips", () => {
  const output = ["one", "two"].map(leaf => JSON.stringify({ Action: "pass", Package: "p", Test: `TestRequired/${leaf}` })).join("\n");
  for (const name of ["p.TestRequired", "TestRequired"]) {
    const input = { runError: null, timedOut: false, exitCode: 0, minExecuted: 1, requiredTests: [name], tally: parseGateOutput(output, "go-json") };
    assert.equal(decideGateVerdict(input).verdict, "pass");
    const skipped = `${output}\n${JSON.stringify({ Action: "skip", Package: "p", Test: "TestRequired/three" })}`;
    assert.equal(decideGateVerdict({ ...input, tally: parseGateOutput(skipped, "go-json") }).verdict, "unusable");
  }
});

function report(output: string, selection?: GateRunReport["selection"], requiredTests = [luna]): GateRunReport {
  return {
    outputFormat: "playwright-json", requiredTests, selection, tally: parseGateOutput(output, "playwright-json"),
    runError: null, timedOut: false, exitCode: 0, command: "playwright test --reporter=json",
    branchName: "feature/1809", headSha: "a".repeat(40), baseRef: "origin/main", baseSha: "b".repeat(40),
    commitsBehind: 0, durationMs: 10, outputPath: "1809.log", outputBytes: output.length,
    baselineFailures: null, baselineSkipReason: null, baselineOutputPath: null,
    rerunFailures: null, rerunSkipReason: null, rerunOutputPath: null,
  };
}

test("requirements survive saved full and selected reports and their sidecar", () => {
  for (const selection of [undefined, { mode: "full" as const, reason: "shared path" },
    { mode: "selected" as const, tests: [luna], filter: "x", reason: "named" }]) {
    const saved = JSON.parse(JSON.stringify(report(raw, selection))) as GateRunReport;
    assert.equal(decideGateVerdict({ ...saved, minExecuted: gateRunFloor(saved, 10), requiredTests: gateRunRequiredTests(saved) }).verdict, "unusable");
    assert.deepEqual(parseGateRunMeta(serializeGateRunMeta(saved, {}, new Date("2026-10-11T13:20:00Z")))!.requiredTests, [luna]);
  }
  // Older reports and sidecars carried a selected run's names only as its selection.
  const legacy = report(raw, { mode: "selected", tests: ["absent.spec.ts › required"], filter: "x", reason: "named" });
  delete legacy.requiredTests;
  assert.equal(decideGateVerdict({ ...legacy, minExecuted: gateRunFloor(legacy, 10), requiredTests: gateRunRequiredTests(legacy) }).verdict, "unusable");
  const meta = parseGateRunMeta(JSON.stringify({ headSha: "a", baseSha: "b", selection: "selected", selectedTests: [luna], requiredTests: [] }))!;
  assert.deepEqual(meta.requiredTests, [luna]);
  assert.equal(parseGateRunMeta(JSON.stringify({ headSha: "a", baseSha: "b", requiredTests: [null] })), null, "a malformed requirement list is not trusted");
});

test("the documentation report says when a required test is missing", () => {
  const missing = liveGateLines({ stamp: "retained-1809", raw, format: "playwright-json",
    meta: parseGateRunMeta(serializeGateRunMeta(report(raw), {}, new Date()))! }, "").join("\n");
  assert.match(missing, /Required live tests: `real-claude-codex-channel\.spec\.ts › real GPT-6 Luna/);
  assert.match(missing, /Live acceptance remains missing: required live test .* skipped/);
  assert.match(missing, /needs-real-claude.*cannot advance to documentation/);
  const fine = liveGateLines({ stamp: "retained-1809", raw, format: "playwright-json",
    meta: parseGateRunMeta(serializeGateRunMeta(report(raw, undefined, [effort]), {}, new Date()))! }, "").join("\n");
  assert.match(fine, /Required live tests/);
  assert.doesNotMatch(fine, /Live acceptance remains missing/);
});

test("inherited live identities reuse canonical name parsing without interpreting prose or sentinel words", () => {
  const names = ["pkg.TestCapture", "a.B#method", "file.spec.ts › title, literal `code`", "all"];
  assert.deepEqual(inheritedLiveTestNames("prose pkg.TestOther\n" + names.map(inheritedMarker).join("\r\n") + "\n  " + inheritedMarker(" pkg.TestCapture ") + "  "), names);
  assert.deepEqual(inheritedLiveTestNames("## Live tests\n- pkg.TestOther\n<!-- inherited-live-test: -->"), []);
});
