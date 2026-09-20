import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGateOutput, isGateOutputFormat } from "./gate-output.js";

describe("Android JUnit gate reports", () => {
  it("accepts the explicit format and counts bodies rather than suite summaries", () => {
    assert.equal(isGateOutputFormat("junit-xml"), true);
    const result = parseGateOutput(`<testsuites><testsuite name="phone" tests="4" failures="1" errors="1" skipped="1">
      <testcase classname="mobile.Screen" name="works"/>
      <testcase classname="mobile.Screen" name="breaks"><failure message="wrong screen"/></testcase>
      <testcase classname="mobile.Screen" name="crashes"><error message="device crashed"/></testcase>
      <testcase classname="mobile.Screen" name="ignored"><skipped message="manual control"/></testcase>
    </testsuite></testsuites>`, "junit-xml");
    assert.equal(result.executed, 3);
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 2);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.failedNames, ["mobile.Screen#breaks", "mobile.Screen#crashes"]);
    assert.match(result.skipReasons[0], /manual control/);
  });
  it("keeps an entirely skipped suite below the execution floor", () => {
    const result = parseGateOutput('<testsuite tests="1"><testcase classname="C" name="test"><skipped/></testcase></testsuite>', "junit-xml");
    assert.equal(result.executed, 0);
    assert.equal(result.skipped, 1);
    assert.ok(result.recognizedLines > 0);
  });
  it("rejects malformed, truncated, unrelated and entity-bearing reports", () => {
    for (const raw of ["", "BUILD SUCCESSFUL", '<testsuite><testcase name="ok"/>', '<anything/>', '<!DOCTYPE x [<!ENTITY e "test">]><testsuite/>']) {
      assert.equal(parseGateOutput(raw, "junit-xml").recognizedLines, 0);
    }
  });
  it("does not hide runner failures or missing testcase records behind passing cases", () => {
    for (const raw of [
      '<testsuite tests="2"><testcase classname="C" name="ok"/></testsuite>',
      '<testsuite tests="1" errors="1"><testcase classname="C" name="ok"/></testsuite>',
      '<testsuite tests="0" errors="1"/>',
      '<testsuite tests="1" skipped="1"><testcase classname="C" name="ok"/></testsuite>',
      '<testsuite><testcase classname="C" name="ok"/><error message="runner died"/></testsuite>',
    ]) assert.equal(parseGateOutput(raw, "junit-xml").packageFailed, true);
  });
  it("reads nested suite totals without inventing runner failures", () => {
    const result = parseGateOutput('<testsuites tests="1" failures="1"><testsuite tests="1" failures="1"><testcase classname="C" name="broken"><failure/></testcase></testsuite></testsuites>', "junit-xml");
    assert.equal(result.failed, 1);
    assert.equal(result.packageFailed, false);
  });
  it("counts duplicate reports once and retains a failing attempt", () => {
    const result = parseGateOutput('<testsuites><testsuite><testcase classname="C" name="test"><failure/></testcase></testsuite><testsuite><testcase classname="C" name="test"/></testsuite></testsuites>', "junit-xml");
    assert.equal(result.executed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.passed, 0);
  });
});
