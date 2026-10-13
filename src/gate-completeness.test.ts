import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGateOutput, parseGateTestDetails } from "./gate-output.js";
import { buildGateReportSection, liveGateLines } from "./gate-report.js";
import { decideGateOutcome, decideGateVerdict } from "./pipeline-decisions.js";
import { completeGo, completeJUnit, completePlaywright, incompleteArtifacts, loggedArtifacts, loggedFailures, repeatedGo } from "./fixtures/gate-completeness.js";

const verdict = (raw: string, outputFormat: Parameters<typeof parseGateOutput>[1]) => decideGateVerdict({
  runError: null, timedOut: false, exitCode: 0, minExecuted: 10, tally: parseGateOutput(raw, outputFormat),
});

for (const artifact of [...loggedArtifacts, ...loggedFailures]) {
  test(`tagged logs retain complete parser identities: ${artifact.name}`, () => {
    const tally = parseGateOutput(artifact.raw, artifact.format);
    assert.equal(tally.completeParse, true);
    assert.deepEqual(tally.passedNames, parseGateOutput(artifact.green, artifact.format).passedNames);
    if ("failedName" in artifact) assert.deepEqual(tally.failedNames, [artifact.failedName]);
    assert.equal(parseGateTestDetails(artifact.raw, artifact.format)?.length, "failedName" in artifact ? 11 : 10);
  });
  test(`tagged logs retain verdict and routing: ${artifact.name}`, () => {
    const decision = verdict(artifact.raw, artifact.format);
    assert.equal(decision.verdict, "failedName" in artifact ? "fail" : "pass");
    assert.equal(decideGateOutcome(decision.verdict).toColumn, "failedName" in artifact ? "In Development" : "In Documentation");
  });
}

for (const artifact of incompleteArtifacts) {
  test(`completeness rejects ${artifact.name} without legacy requirements`, () => {
    const tally = parseGateOutput(artifact.raw, artifact.format);
    assert.equal(tally.completeParse, false);
    const decision = verdict(artifact.raw, artifact.format);
    assert.equal(decision.verdict, "unusable");
    assert.equal(decideGateOutcome(decision.verdict).toColumn, null);
    assert.ok(!decideGateOutcome(decision.verdict).removeLabels.includes("needs-real-claude"));
    assert.equal(parseGateTestDetails(artifact.raw, artifact.format), null);
    assert.match(liveGateLines({ stamp: "fixture", format: artifact.format, raw: artifact.raw, meta: null }, "").join("\n"), /needs-real-claude.*cannot advance/);
    const summary = buildGateReportSection({ pass: null, namingText: "", runs: [
      { label: "fixture", detail: "incomplete", format: artifact.format, raw: artifact.raw },
    ] });
    assert.match(summary, /incomplete.*no per-test counts/);
  });
}

test("malformed identities and nested records cannot disappear behind passing records", () => {
  for (const event of [
    { Action: "pass", Test: 42 }, { Action: "pass", Test: null }, { Action: "pass", Test: " " },
    { Action: "pass", Test: "TestLuna", Package: {} }, { Action: "output", Test: "TestLuna", Output: [] },
    { Action: "run" }, { Action: "future-outcome", Test: "TestLuna" },
  ]) assert.equal(verdict(`${completeGo}\n${JSON.stringify(event)}`, "go-json").verdict, "unusable");
  for (const suite of [null, [], { title: "GPT-6 Luna" }, { specs: {} }, { suites: {} }, { specs: [null] },
    { title: 42, specs: [] }, { title: "luna", specs: [{ title: "GPT-6 Luna", tests: {} }] },
    { title: "luna", specs: [{ title: "", tests: [{ status: "expected", results: [{ status: "passed" }] }] }] },
  ]) assert.equal(verdict(JSON.stringify({ suites: [...JSON.parse(completePlaywright).suites, suite] }), "playwright-json").verdict, "unusable");
  assert.equal(verdict(completeJUnit.replace('</testsuite>', '<testcase classname="fixture"/></testsuite>'), "junit-xml").verdict, "unusable");
});

test("old completeParse markers alone never establish acceptance", () => {
  const tally = JSON.parse(JSON.stringify(parseGateOutput(completeGo, "go-json")));
  delete tally.parserVersion;
  assert.equal(tally.completeParse, true);
  assert.equal(decideGateVerdict({ runError: null, timedOut: false, exitCode: 0, minExecuted: 10, tally }).verdict, "unusable");
});

test("complete single-format artifacts and supported build preambles remain usable", () => {
  for (const [format, raw] of [["go-json", completeGo], ["playwright-json", completePlaywright], ["junit-xml", completeJUnit]] as const) {
    assert.equal(parseGateOutput(raw, format).completeParse, true);
    assert.equal(verdict(raw, format).verdict, "pass");
    assert.equal(parseGateTestDetails(raw, format)?.length, 10);
  }
  assert.equal(verdict(`build log\n${completeGo}\nfinished`, "go-json").verdict, "pass");
  assert.equal(verdict(`Running 10 tests using 1 worker\n${completePlaywright}`, "playwright-json").verdict, "pass");
  assert.equal(verdict(`<!-- JUnit report -->\n${completeJUnit}`, "junit-xml").verdict, "pass");
});

test("complete named failures still route to repair with ordinary diagnostics", () => {
  const failure = `${completeGo}\nbuild diagnostic\n` + [
    { Action: "run", Package: "fixture", Test: "TestFailure" },
    { Action: "fail", Package: "fixture", Test: "TestFailure" },
    { Action: "fail", Package: "fixture" },
  ].map(e => JSON.stringify(e)).join("\n");
  const decision = verdict(failure, "go-json");
  assert.equal(decision.verdict, "fail");
  assert.equal(decideGateOutcome(decision.verdict).toColumn, "In Development");
  assert.equal(parseGateOutput(`${completeGo}\n${JSON.stringify({ Action: "output", Package: "fixture", Output: "<!-- text printed by a test -->" })}`, "go-json").completeParse, true);
});


for (const statuses of [["pass", "fail"], ["fail", "pass"]] as const) {
  test(`complete count=2 occurrences retain the named failure: ${statuses.join(" then ")}`, () => {
    const raw = repeatedGo(statuses);
    const tally = parseGateOutput(raw, "go-json");
    assert.equal(tally.completeParse, true);
    assert.equal(tally.executed, 11);
    assert.equal(tally.passed, 10);
    assert.equal(tally.failed, 1);
    assert.deepEqual(tally.failedNames, ["fixture.TestRepeated/case:Low,confirmed"]);
    assert.ok(!tally.passedNames.includes("fixture.TestRepeated/case:Low,confirmed"));
    const decision = verdict(raw, "go-json");
    assert.equal(decision.verdict, "fail");
    assert.equal(decideGateOutcome(decision.verdict).toColumn, "In Development");
    assert.equal(parseGateTestDetails(raw, "go-json")?.find(t => t.name === tally.failedNames[0])?.status, "failed");
  });
}

test("repeated passes and skips count identities without inflating the floor", () => {
  const passes = repeatedGo(["pass", "pass"], 0);
  assert.equal(parseGateOutput(passes, "go-json").completeParse, true);
  assert.equal(parseGateOutput(passes, "go-json").executed, 1);
  assert.equal(decideGateVerdict({ runError: null, timedOut: false, exitCode: 0, minExecuted: 2,
    tally: parseGateOutput(passes, "go-json") }).verdict, "zero-executed");
  const skips = parseGateOutput(repeatedGo(["skip", "skip"], 0), "go-json");
  assert.equal(skips.completeParse, true);
  assert.equal(skips.executed, 0);
  assert.equal(skips.skipped, 1);
});

test("a new unfinished occurrence stays pending after an earlier terminal", () => {
  for (const action of ["run", "pause", "cont"]) {
    const raw = repeatedGo(["pass"]) + "\n" + JSON.stringify({ Action: action, Package: "fixture", Test: "TestRepeated/case:Low,confirmed" });
    assert.equal(parseGateOutput(raw, "go-json").completeParse, false);
    assert.equal(verdict(raw, "go-json").verdict, "unusable");
  }
  const overlapping = [
    { Action: "run", Package: "fixture", Test: "TestOverlap" },
    { Action: "run", Package: "fixture", Test: "TestOverlap" },
    { Action: "pass", Package: "fixture", Test: "TestOverlap" },
  ].map(e => JSON.stringify(e)).join("\n");
  assert.equal(parseGateOutput(overlapping, "go-json").completeParse, false);
});

test("subtests belong to their parent occurrence, including repeated all-skipped parents", () => {
  const raw = [
    ...["skip", "skip"].flatMap(Action => [
      { Action: "run", Package: "fixture", Test: "TestParent" },
      { Action: "run", Package: "fixture", Test: "TestParent/child" },
      { Action, Package: "fixture", Test: "TestParent/child" },
      { Action: "pass", Package: "fixture", Test: "TestParent" },
    ]),
    { Action: "run", Package: "fixture", Test: "TestParent" },
    { Action: "pass", Package: "fixture", Test: "TestParent" },
  ].map(e => JSON.stringify(e)).join("\n");
  const tally = parseGateOutput(raw, "go-json");
  assert.equal(tally.completeParse, true);
  assert.equal(tally.executed, 1, "only the final occurrence has a leaf parent");
  assert.equal(tally.skipped, 1);
  assert.deepEqual(tally.passedNames, ["fixture.TestParent"]);
});

test("duplicate terminals do not create new executions and conflicting duplicates stay unusable", () => {
  const raw = repeatedGo(["pass"], 0);
  const pass = JSON.stringify({ Action: "pass", Package: "fixture", Test: "TestRepeated/case:Low,confirmed" });
  const duplicate = parseGateOutput(raw + "\n" + pass, "go-json");
  assert.equal(duplicate.completeParse, true);
  assert.equal(duplicate.executed, 1);
  const conflicting = parseGateOutput(raw + "\n" + pass.replace('"pass"', '"fail"'), "go-json");
  assert.equal(conflicting.completeParse, false);
});
