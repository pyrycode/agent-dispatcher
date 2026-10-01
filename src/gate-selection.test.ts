import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GATE_FULL_EVERY,
  decideGateSelection,
  parseGateFullState,
  parseLiveTestsSection,
  readGateSelectionConfig,
  type GateSelectionConfig,
} from "./gate-selection.js";
import { gateRunFloor, type GateRunReport } from "./gate-output.js";

const LIVE = "de.pyryco.mobile.e2e.InteractiveStreamE2ETest";
const config: GateSelectionConfig = {
  alwaysTests: [`${LIVE}#ping`],
  fullPaths: ["app/src/main/java/de/pyryco/mobile/data/network/"],
  fullEvery: 10,
};

const decide = (over: Partial<Parameters<typeof decideGateSelection>[0]> = {}) => decideGateSelection({
  config,
  section: { kind: "list", names: [`${LIVE}#rename`] },
  changedPaths: ["app/src/main/java/de/pyryco/mobile/ui/settings/Settings.kt"],
  mergesSinceFull: 2,
  format: "junit-xml",
  ...over,
});

describe("readGateSelectionConfig", () => {
  test("is off unless the switch is exactly 1", () => {
    assert.equal(readGateSelectionConfig({}), null);
    assert.equal(readGateSelectionConfig({ PYRY_REAL_CLAUDE_GATE_SELECT: "true" }), null);
  });

  test("reads the lists and the cadence", () => {
    const read = readGateSelectionConfig({
      PYRY_REAL_CLAUDE_GATE_SELECT: "1",
      PYRY_REAL_CLAUDE_GATE_ALWAYS_TESTS: " a.B#c , a.B#d ",
      PYRY_REAL_CLAUDE_GATE_FULL_PATHS: "src/net/,",
      PYRY_REAL_CLAUDE_GATE_FULL_EVERY: "7",
    });
    assert.deepEqual(read, { alwaysTests: ["a.B#c", "a.B#d"], fullPaths: ["src/net/"], fullEvery: 7 });
  });

  test("a missing or nonsensical cadence falls back to the default", () => {
    for (const every of [undefined, "0", "-3", "often"]) {
      const read = readGateSelectionConfig({ PYRY_REAL_CLAUDE_GATE_SELECT: "1", PYRY_REAL_CLAUDE_GATE_FULL_EVERY: every });
      assert.equal(read?.fullEvery, DEFAULT_GATE_FULL_EVERY);
    }
  });
});

describe("parseLiveTestsSection", () => {
  test("reads list items, backticks and commas, up to the next heading", () => {
    const body = [
      "## Summary",
      "Did a thing.",
      "",
      "## Live tests",
      "- `a.B#one`",
      "* a.B#two, a.B#three",
      "a.B#one",
      "",
      "## Testing",
      "- a.B#notThis",
    ].join("\n");
    assert.deepEqual(parseLiveTestsSection(body), { kind: "list", names: ["a.B#one", "a.B#two", "a.B#three"] });
  });

  test("no heading, or an empty section, reads as missing", () => {
    assert.deepEqual(parseLiveTestsSection("## Summary\nnothing"), { kind: "missing" });
    assert.deepEqual(parseLiveTestsSection("## Live tests\n\n## Testing\n- a.B#x"), { kind: "missing" });
  });

  test("`all` asks for the full suite", () => {
    assert.deepEqual(parseLiveTestsSection("## Live tests\n- a.B#x\n- all"), { kind: "all" });
  });
});

describe("decideGateSelection", () => {
  test("runs the named tests plus the always-run set", () => {
    const selection = decide();
    assert.equal(selection.mode, "selected");
    if (selection.mode !== "selected") return;
    assert.deepEqual(selection.tests, [`${LIVE}#ping`, `${LIVE}#rename`]);
    assert.equal(selection.filter, `'${LIVE}#ping,${LIVE}#rename'`);
  });

  test("does not run an always-run test twice when the pull request names it too", () => {
    const selection = decide({ section: { kind: "list", names: [`${LIVE}#ping`] } });
    assert.equal(selection.mode === "selected" && selection.tests.length, 1);
  });

  test("a change to a full path runs everything, and says which file", () => {
    const selection = decide({ changedPaths: ["app/src/main/java/de/pyryco/mobile/data/network/Relay.kt"] });
    assert.equal(selection.mode, "full");
    assert.match(selection.reason, /data\/network\/Relay\.kt/);
  });

  test("an unknown diff runs everything", () => {
    assert.equal(decide({ changedPaths: null }).mode, "full");
  });

  test("the backstop: no record, or enough merges since the last full pass, runs everything", () => {
    assert.equal(decide({ mergesSinceFull: null }).mode, "full");
    assert.equal(decide({ mergesSinceFull: 10 }).mode, "full");
    assert.equal(decide({ mergesSinceFull: 9 }).mode, "selected");
  });

  test("a missing list or `all` runs everything", () => {
    assert.equal(decide({ section: { kind: "missing" } }).mode, "full");
    assert.equal(decide({ section: { kind: "all" } }).mode, "full");
  });

  test("an always-run name cut at its # blames the fork's setting, not the pull request", () => {
    const selection = decide({ config: { ...config, alwaysTests: [LIVE] } });
    assert.equal(selection.mode, "full");
    assert.match(selection.reason, /PYRY_REAL_CLAUDE_GATE_ALWAYS_TESTS/);
  });

  test("a name the filter cannot carry runs everything rather than a partial list", () => {
    const selection = decide({ section: { kind: "list", names: [`${LIVE}#ok`, "rename the chat"] } });
    assert.equal(selection.mode, "full");
    assert.match(selection.reason, /no safe filter/);
  });
});

describe("parseGateFullState", () => {
  test("tolerates a missing or broken file", () => {
    assert.deepEqual(parseGateFullState(null), { lastFullPassSha: null });
    assert.deepEqual(parseGateFullState("{not json"), { lastFullPassSha: null });
    assert.deepEqual(parseGateFullState('{"lastFullPassSha":"abc"}'), { lastFullPassSha: "abc" });
  });
});

describe("gateRunFloor", () => {
  const report = (selection?: GateRunReport["selection"]) => ({ selection }) as GateRunReport;

  test("a selected run must execute every test it named", () => {
    assert.equal(gateRunFloor(report({ mode: "selected", tests: ["a", "b", "c"], filter: "x", reason: "r" }), 30), 3);
  });

  test("a full run, or no selection at all, keeps the fork's floor", () => {
    assert.equal(gateRunFloor(report({ mode: "full", reason: "r" }), 30), 30);
    assert.equal(gateRunFloor(report(), 30), 30);
  });
});
