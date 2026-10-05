import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseGateOutput } from "./gate-output.js";
import {
  attributableFailures,
  buildBaselineRecordComment,
  parseVerifierGateFormats,
  splitBySweep,
  unlistedBaselineEntries,
  type BaselineEntry,
} from "./verifier-gate-baseline.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("PYRY_VERIFIER_GATE_FORMATS", () => {
  test("unset or empty reads no format, so every gate behaves as before", () => {
    assert.equal(parseVerifierGateFormats(undefined).formats.size, 0);
    assert.equal(parseVerifierGateFormats("  ").formats.size, 0);
    assert.deepEqual(parseVerifierGateFormats("").errors, []);
  });

  test("a format string or an object with a baseline template, keyed by the trimmed gate command", () => {
    const { formats, errors } = parseVerifierGateFormats(JSON.stringify({
      " python3 gate.py ui ": { format: "junit-xml", baseline: " python3 gate.py ui --tests {{TESTS}} " },
      "go test -json ./...": "go-json",
    }));
    assert.deepEqual(errors, []);
    assert.deepEqual(formats.get("python3 gate.py ui"), {
      format: "junit-xml", baselineCommand: "python3 gate.py ui --tests {{TESTS}}",
    });
    assert.deepEqual(formats.get("go test -json ./..."), { format: "go-json", baselineCommand: null });
  });

  test("anything unreadable is skipped with a log line, never guessed", () => {
    assert.equal(parseVerifierGateFormats("{not json").formats.size, 0);
    assert.equal(parseVerifierGateFormats("{not json").errors.length, 1);
    assert.equal(parseVerifierGateFormats('["junit-xml"]').errors.length, 1);
    const { formats, errors } = parseVerifierGateFormats(JSON.stringify({
      "a": "tap", "b": { format: "junit-xml", baseline: 3 }, "c": { baseline: "x {{TESTS}}" }, "d": "junit-xml",
    }));
    assert.deepEqual([...formats.keys()], ["d"]);
    assert.equal(errors.length, 3);
  });
});

describe("attributableFailures", () => {
  const junit = (cases: string, suiteAttrs = "") =>
    parseGateOutput(`<testsuite name="ui"${suiteAttrs}>${cases}</testsuite>`, "junit-xml");

  test("the named failures of a readable run", () => {
    const tally = junit('<testcase classname="p.A" name="x"><failure/></testcase><testcase classname="p.A" name="y"/>');
    assert.deepEqual(attributableFailures(tally), ["p.A#x"]);
  });

  test("nothing to attribute: unreadable output, no named failure, or a broken suite", () => {
    assert.equal(attributableFailures(parseGateOutput("BUILD FAILED", "junit-xml")), null);
    assert.equal(attributableFailures(junit('<testcase classname="p.A" name="y"/>')), null);
    // A suite error with no failing case of its own: a crashed runner.
    assert.equal(
      attributableFailures(junit('<testcase classname="p.A" name="x"><failure/></testcase>', ' errors="2"')),
      null,
    );
  });

  test("Go: a package failure is covered by a named failure inside it, not by one elsewhere", () => {
    const ev = (o: object) => JSON.stringify(o);
    const covered = parseGateOutput([
      ev({ Action: "run", Package: "ex/a", Test: "TestX" }),
      ev({ Action: "fail", Package: "ex/a", Test: "TestX" }),
      ev({ Action: "fail", Package: "ex/a" }),
    ].join("\n"), "go-json");
    assert.deepEqual(attributableFailures(covered), ["ex/a.TestX"]);
    const buildBroke = parseGateOutput([
      ev({ Action: "run", Package: "ex/a", Test: "TestX" }),
      ev({ Action: "fail", Package: "ex/a", Test: "TestX" }),
      ev({ Action: "fail", Package: "ex/a" }),
      ev({ Action: "fail", Package: "ex/b" }),
    ].join("\n"), "go-json");
    assert.equal(attributableFailures(buildBroke), null);
  });
});

describe("splitBySweep", () => {
  const sweep = { sha: A, names: ["p.A#x", "p.A#z"] };

  test("a sweep on an ancestor commit sets its names aside", () => {
    assert.deepEqual(splitBySweep(["p.A#x", "p.A#y"], sweep, true), { baseline: ["p.A#x"], remaining: ["p.A#y"] });
  });

  test("a sweep that is not an ancestor, unknown ancestry, or no sweep uses nothing", () => {
    for (const [s, ancestor] of [[sweep, false], [sweep, null], [null, true]] as const) {
      assert.deepEqual(splitBySweep(["p.A#x"], s, ancestor), { baseline: [], remaining: ["p.A#x"] });
    }
  });
});

describe("recording baseline names on the main-failure ticket", () => {
  const entry = (name: string, source: BaselineEntry["source"] = "main-sweep"): BaselineEntry => ({ name, source, sha: A });

  test("a name the ticket already lists in backticks is not recorded again, and each name appears once", () => {
    const fresh = unlistedBaselineEntries(
      [entry("p.A#x"), entry("p.A#y", "base-commit"), entry("p.A#y"), entry("p.A#xx")],
      ["## Failing tests\n\n- `p.A#x`", "unrelated p.A#xx without backticks"],
    );
    assert.deepEqual(fresh.map((e) => e.name), ["p.A#y", "p.A#xx"]);
    assert.equal(fresh[0]!.source, "base-commit", "the first entry for a name wins");
  });

  test("the comment names the gated ticket, its commit and why each test was set aside", () => {
    const body = buildBaselineRecordComment({
      gatedIssue: 1747,
      commit: B,
      entries: [
        { gate: "python3 gate.py ui", entry: entry("p.A#x") },
        { gate: "python3 gate.py ui", entry: { name: "p.A#y", source: "base-commit", sha: B } },
      ],
    });
    assert.match(body, /## Main failures seen by #1747/);
    assert.ok(body.includes(`merged commit \`${B}\``));
    assert.match(body, /- `p\.A#x` \(failed in the main sweep on `aaaaaaaaaaaa`\), gate `python3 gate\.py ui`/);
    assert.match(body, /- `p\.A#y` \(failed when re-run alone on the base commit `bbbbbbbbbbbb`\)/);
  });
});
