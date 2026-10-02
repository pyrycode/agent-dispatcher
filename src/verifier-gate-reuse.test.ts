import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  decideVerifierGateReuse,
  hashGateList,
  parseVerifierGatePass,
  VERIFIER_GATE_REUSE_MAX_AGE_MS,
  verifierGatePassFileName,
  verifierGateReuseEnabled,
  type VerifierGatePass,
} from "./verifier-gate-reuse.js";

const COMMIT = "a".repeat(40);
const GATES = ["./gradlew check", "python3 scripts/android-test-gate.py ui"];
const NOW = Date.parse("2026-10-02T09:00:00.000Z");
const LOGS = ["/logs/verifier-gate_#1340_1.log", "/logs/verifier-gate_#1340_1.stderr.log"];

function pass(overrides: Partial<VerifierGatePass> = {}): VerifierGatePass {
  return {
    issueNumber: 1340,
    commit: COMMIT,
    gatesHash: hashGateList(GATES),
    gates: GATES,
    passedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    summary: GATES.map((g) => `✓ ${g} (exit 0)`),
    logPaths: LOGS,
    ...overrides,
  };
}

function decide(overrides: {
  pass?: VerifierGatePass | null;
  commit?: string;
  gatesHash?: string;
  nowMs?: number;
  existing?: readonly string[];
} = {}) {
  const existing = new Set(overrides.existing ?? LOGS);
  return decideVerifierGateReuse({
    pass: overrides.pass === undefined ? pass() : overrides.pass,
    issueNumber: 1340,
    commit: overrides.commit ?? COMMIT,
    gatesHash: overrides.gatesHash ?? hashGateList(GATES),
    nowMs: overrides.nowMs ?? NOW,
    logExists: (p) => existing.has(p),
  });
}

describe("verifier gate reuse — a pass on the same commit is not paid for twice (2026-10-02, #1340)", () => {
  test("matching issue, commit and gate list, under a day old, logs on disk → reuse", () => {
    const d = decide();
    assert.equal(d.reuse, true);
    if (d.reuse) assert.equal(d.pass.commit, COMMIT);
  });

  test("a different merged commit is a different tree to test → no reuse", () => {
    assert.deepEqual(decide({ commit: "b".repeat(40) }), { reuse: false, reason: "commit-changed" });
  });

  test("an unknown current commit never matches, even an empty recorded one", () => {
    assert.deepEqual(decide({ commit: "", pass: pass({ commit: "" }) }), { reuse: false, reason: "commit-changed" });
  });

  test("a different gate list, including the same gates in another order → no reuse", () => {
    assert.deepEqual(
      decide({ gatesHash: hashGateList([...GATES, "./gradlew assembleDebug"]) }),
      { reuse: false, reason: "gates-changed" },
    );
    assert.deepEqual(
      decide({ gatesHash: hashGateList([...GATES].reverse()) }),
      { reuse: false, reason: "gates-changed" },
    );
  });

  test("a pass 24 hours old or older is run again; just under 24 hours is still reused", () => {
    const at = (ageMs: number) => pass({ passedAt: new Date(NOW - ageMs).toISOString() });
    assert.deepEqual(decide({ pass: at(25 * 60 * 60 * 1000) }), { reuse: false, reason: "expired" });
    assert.deepEqual(decide({ pass: at(VERIFIER_GATE_REUSE_MAX_AGE_MS) }), { reuse: false, reason: "expired" });
    assert.equal(decide({ pass: at(VERIFIER_GATE_REUSE_MAX_AGE_MS - 1000) }).reuse, true);
  });

  test("a pass stamped in the future or with an unreadable time is not trusted", () => {
    assert.deepEqual(
      decide({ pass: pass({ passedAt: new Date(NOW + 60_000).toISOString() }) }),
      { reuse: false, reason: "expired" },
    );
    assert.deepEqual(decide({ pass: pass({ passedAt: "yesterday" }) }), { reuse: false, reason: "expired" });
  });

  test("a missing gate log means the evidence is gone → no reuse", () => {
    assert.deepEqual(decide({ existing: [LOGS[0]!] }), { reuse: false, reason: "log-missing" });
    assert.deepEqual(decide({ pass: pass({ logPaths: [] }) }), { reuse: false, reason: "log-missing" });
  });

  test("no record, or a record for another issue → no reuse", () => {
    assert.deepEqual(decide({ pass: null }), { reuse: false, reason: "no-record" });
    assert.deepEqual(decide({ pass: pass({ issueNumber: 1341 }) }), { reuse: false, reason: "other-issue" });
  });

  test("hashGateList is order-sensitive and cannot be fooled by a delimiter inside a command", () => {
    assert.equal(hashGateList(GATES), hashGateList([...GATES]));
    assert.notEqual(hashGateList(["a", "b"]), hashGateList(["b", "a"]));
    assert.notEqual(hashGateList(["a;b"]), hashGateList(["a", "b"]));
    assert.match(hashGateList(GATES), /^[0-9a-f]{64}$/);
  });

  test("parseVerifierGatePass round-trips a written pass and rejects anything else", () => {
    assert.deepEqual(parseVerifierGatePass(JSON.stringify(pass())), pass());
    assert.equal(parseVerifierGatePass("{not json"), null);
    assert.equal(parseVerifierGatePass(""), null);
    assert.equal(parseVerifierGatePass("null"), null);
    assert.equal(parseVerifierGatePass("[]"), null);
    const { logPaths: _dropped, ...noLogs } = pass();
    assert.equal(parseVerifierGatePass(JSON.stringify(noLogs)), null);
    assert.equal(parseVerifierGatePass(JSON.stringify({ ...pass(), commit: 7 })), null);
    assert.equal(parseVerifierGatePass(JSON.stringify({ ...pass(), summary: [1] })), null);
  });

  test("PYRY_VERIFIER_GATE_REUSE: on by default, exactly 0 turns it off", () => {
    assert.equal(verifierGateReuseEnabled({}), true);
    assert.equal(verifierGateReuseEnabled({ PYRY_VERIFIER_GATE_REUSE: "1" }), true);
    assert.equal(verifierGateReuseEnabled({ PYRY_VERIFIER_GATE_REUSE: "" }), true);
    assert.equal(verifierGateReuseEnabled({ PYRY_VERIFIER_GATE_REUSE: "0" }), false);
    assert.equal(verifierGateReuseEnabled({ PYRY_VERIFIER_GATE_REUSE: " 0 " }), false);
  });

  test("the pass file sits beside the gate logs, one per issue", () => {
    assert.equal(verifierGatePassFileName(1340), "verifier-gate_#1340.pass.json");
  });
});
