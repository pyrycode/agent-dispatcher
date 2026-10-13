import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseGateOutput } from "./gate-output.js";
import {
  DEFAULT_INFRA_BREAKER_CONFIG,
  activeInfraPause,
  classifyFailureMessage,
  classifyGateFailure,
  extractFailureMessages,
  findAdmissionRejections,
  findToolchainMismatch,
  nextInfraPause,
  readInfraBreakerConfig,
  type InfraBreakerConfig,
} from "./infra-failure.js";

// Real HP gate output, trimmed to the test section of the diagnostic log.
// #2138, 2026-10-13: 65 executed, 1 passed, 64 failed while the production
// relay refused HP's public address. #1896, 2026-10-10: 19 of 65 failed, a
// partial red run that must stay the branch's to explain.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const RUN_2138 = { stdout: fixture("mobile-2138-live-gate.xml"), stderr: fixture("mobile-2138-live-gate.stderr.txt") };
const RUN_1896 = { stdout: fixture("mobile-1896-live-gate.xml"), stderr: fixture("mobile-1896-live-gate.stderr.txt") };

function classify(run: { stdout: string; stderr: string }, config: InfraBreakerConfig = DEFAULT_INFRA_BREAKER_CONFIG) {
  const tally = parseGateOutput(run.stdout, "junit-xml");
  const messages = extractFailureMessages({ stdout: run.stdout, stderr: run.stderr, format: "junit-xml", failedNames: tally.failedNames });
  return { tally, messages, result: classifyGateFailure({ tally, messages, admission: findAdmissionRejections(`${run.stdout}\n${run.stderr}`), config }) };
}

describe("classifyGateFailure on real mobile gate output", () => {
  test("#2138: 64 of 65 failed on connection and readiness waits, so it is infrastructure", () => {
    const { tally, messages, result } = classify(RUN_2138);
    assert.equal(tally.executed, 65);
    assert.equal(tally.failed, 64);
    // The JUnit report has empty <failure /> elements; the text comes from Gradle's console.
    assert.equal(messages.size, 64, "every failing test's text is found in the diagnostic log");
    assert.equal(result.infra, true);
    assert.equal(result.connection, 8);
    assert.equal(result.wait, 56);
    assert.equal(result.other, 0);
    assert.ok(result.samples.some(s => s.includes("relay=Offline daemon=Down")), result.samples.join("\n"));
    assert.match(result.reason, /64 of 65 executed tests failed/);
  });

  test("#1896: 19 of 65 failed, which is not a mass failure, so it stays the branch's", () => {
    const { result } = classify(RUN_1896);
    assert.equal(result.infra, false);
    assert.equal(result.failed, 19);
    assert.match(result.reason, /not a mass failure/);
  });

  test("the same mass failure with assertion messages is not infrastructure", () => {
    const stderr = RUN_2138.stderr.replace(
      /^\t(?:kotlinx|java|androidx)\.[^\n]*$/gm,
      "\tjava.lang.AssertionError: expected the footer to show 12% context but it showed 0%",
    );
    const { result } = classify({ stdout: RUN_2138.stdout, stderr });
    assert.equal(result.infra, false);
    assert.equal(result.other, 64);
  });

  test("bare timeouts alone never trip it, since a hung app times out too", () => {
    const stderr = RUN_2138.stderr.replace(
      /^\t(?:kotlinx|java|androidx)\.[^\n]*$/gm,
      "\tkotlinx.coroutines.TimeoutCancellationException: Timed out waiting for 30000 ms",
    );
    const { result } = classify({ stdout: RUN_2138.stdout, stderr });
    assert.equal(result.wait, 64);
    assert.equal(result.connection, 0);
    assert.equal(result.infra, false);
    assert.match(result.reason, /not enough connection evidence/);
  });

  test("relay admission rejections in the output trip it on their own", () => {
    const stderr = RUN_2138.stderr.replace(
      /^\t(?:kotlinx|java|androidx)\.[^\n]*$/gm,
      "\tjava.lang.AssertionError: phone never opened its thread",
    ) + [
      "[e2e] daemon dial: failed to WebSocket dial: expected handshake response status code 101 but got 503",
      "[e2e] daemon dial: failed to WebSocket dial: expected handshake response status code 101 but got 429",
      "java.net.ProtocolException: Expected HTTP 101 response but was '503 Service Unavailable'",
    ].join("\n");
    const { result } = classify({ stdout: RUN_2138.stdout, stderr });
    assert.equal(result.connection, 0);
    assert.equal(result.admissionLines, 3);
    assert.equal(result.infra, true);
    assert.match(result.reason, /admission rejection/);
  });

  test("thresholds come from the environment", () => {
    const strict = readInfraBreakerConfig({ PYRY_INFRA_BREAKER_MIN_SIGNATURES: "9" });
    assert.equal(classify(RUN_2138, strict).result.infra, false, "8 connection failures fall short of 9");
    const loose = readInfraBreakerConfig({ PYRY_INFRA_BREAKER_MIN_FAILED_SHARE: "0.25", PYRY_INFRA_BREAKER_WAIT_SHARE: "0.8", PYRY_INFRA_BREAKER_MIN_SIGNATURES: "3" });
    assert.equal(classify(RUN_1896, loose).result.infra, true, "1896 is 29% failed and 16 of 19 waits");
    assert.equal(classify(RUN_2138, readInfraBreakerConfig({ PYRY_INFRA_BREAKER: "0" })).result.infra, false);
  });
});

describe("toolchain mismatch", () => {
  const LINE = "go: go.mod requires go >= 1.26.9 (running go 1.26.2; GOTOOLCHAIN=local)";

  test("one line is enough, with or without a tally", () => {
    const toolchain = findToolchainMismatch(`${LINE}\nmake: *** [Makefile:24: vet] Error 1`);
    assert.equal(toolchain.count, 1);
    const result = classifyGateFailure({
      tally: null, messages: new Map(), admission: { count: 0, samples: [] }, toolchain, config: DEFAULT_INFRA_BREAKER_CONFIG,
    });
    assert.equal(result.infra, true);
    assert.equal(result.toolchain, true);
    assert.match(result.reason, /requires go >= 1\.26\.9/);
  });

  test("other toolchain refusals are recognised, ordinary failures are not", () => {
    assert.equal(findToolchainMismatch(" ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)").count, 1);
    assert.equal(findToolchainMismatch("Android Gradle plugin requires Java 17 to run. You are currently using Java 11.").count, 1);
    assert.equal(findToolchainMismatch("--- FAIL: TestGoVersion (0.00s)\n    version_test.go:12: want go1.26.9").count, 0);
  });

  test("the breaker switch turns it off too", () => {
    const result = classifyGateFailure({
      tally: null, messages: new Map(), admission: { count: 0, samples: [] },
      toolchain: findToolchainMismatch(LINE), config: { ...DEFAULT_INFRA_BREAKER_CONFIG, enabled: false },
    });
    assert.equal(result.infra, false);
  });
});

describe("readInfraBreakerConfig", () => {
  test("defaults, and garbage keeps them", () => {
    assert.deepEqual(readInfraBreakerConfig({}), DEFAULT_INFRA_BREAKER_CONFIG);
    assert.deepEqual(readInfraBreakerConfig({
      PYRY_INFRA_BREAKER_MIN_FAILED: "-1",
      PYRY_INFRA_BREAKER_MIN_FAILED_SHARE: "1.5",
      PYRY_INFRA_BREAKER_WAIT_SHARE: "abc",
      PYRY_INFRA_BREAKER_MIN_SIGNATURES: "0",
      PYRY_INFRA_COOLDOWN_MS: "2.5",
    }), DEFAULT_INFRA_BREAKER_CONFIG);
  });

  test("valid values are used", () => {
    assert.deepEqual(readInfraBreakerConfig({
      PYRY_INFRA_BREAKER_MIN_FAILED: "10",
      PYRY_INFRA_BREAKER_MIN_FAILED_SHARE: "0.6",
      PYRY_INFRA_BREAKER_WAIT_SHARE: "0.9",
      PYRY_INFRA_BREAKER_MIN_SIGNATURES: "5",
      PYRY_INFRA_COOLDOWN_MS: "600000",
    }), { enabled: true, minFailed: 10, minFailedShare: 0.6, waitShare: 0.9, minSignatures: 5, cooldownMs: 600000 });
  });
});

describe("classifyFailureMessage", () => {
  test("a connection failure wrapped in a timeout is a connection failure", () => {
    assert.equal(classifyFailureMessage("kotlinx.coroutines.TimeoutCancellationException: java.lang.AssertionError: peer step 'open host-isolation peer on A' timed out; no open session: none settled yet; redialing"), "connection");
    assert.equal(classifyFailureMessage("java.lang.IllegalStateException: connection torn down before reply"), "connection");
    assert.equal(classifyFailureMessage("java.lang.AssertionError: the phone's live repository never listed its conversation list within 60000 ms"), "connection");
    assert.equal(classifyFailureMessage("Error: connect ECONNREFUSED 127.0.0.1:7432"), "connection");
  });

  test("bare timeouts are waits, everything else is other", () => {
    assert.equal(classifyFailureMessage("androidx.compose.ui.test.ComposeTimeoutException: Condition still not satisfied after 60000 ms"), "wait");
    assert.equal(classifyFailureMessage("TimeoutError: locator.click: Timeout 5000ms exceeded."), "wait");
    assert.equal(classifyFailureMessage("java.lang.AssertionError: No node found that matches Text contains 'main1_continues'"), "other");
    assert.equal(classifyFailureMessage("java.lang.AssertionError: no FCM token stored"), "other");
  });
});

describe("extractFailureMessages for other formats", () => {
  test("go-json takes the failing test's own output", () => {
    const stdout = [
      { Action: "run", Package: "p", Test: "TestA" },
      { Action: "output", Package: "p", Test: "TestA", Output: "    e2e_test.go:40: dial relay: connection refused\n" },
      { Action: "fail", Package: "p", Test: "TestA" },
    ].map(e => JSON.stringify(e)).join("\n");
    const messages = extractFailureMessages({ stdout, stderr: "", format: "go-json", failedNames: ["p.TestA"] });
    assert.equal(classifyFailureMessage(messages.get("p.TestA") ?? ""), "connection");
  });

  test("playwright-json takes each result's error message", () => {
    const stdout = JSON.stringify({ suites: [{ title: "chat.spec.ts", specs: [{ title: "sends", tests: [{ status: "unexpected", results: [{ error: { message: "Error: daemon unavailable" } }] }] }] }] });
    const messages = extractFailureMessages({ stdout, stderr: "", format: "playwright-json", failedNames: ["chat.spec.ts › sends"] });
    assert.equal(messages.get("chat.spec.ts › sends"), "Error: daemon unavailable");
  });

  test("junit failure messages in the XML are used when present", () => {
    const stdout = `<testsuite name="S" tests="1" failures="1"><testcase classname="a.B" name="m"><failure message="relay=Offline daemon=Down" /></testcase></testsuite>`;
    const messages = extractFailureMessages({ stdout, stderr: "", format: "junit-xml", failedNames: ["a.B#m"] });
    assert.equal(classifyFailureMessage(messages.get("a.B#m") ?? ""), "connection");
  });
});

describe("live gate pause state", () => {
  const T0 = Date.parse("2026-10-13T15:48:00.000Z");

  test("a pause is active until it ends, and an unreadable file is no pause", () => {
    const state = nextInfraPause({ existing: null, nowMs: T0, cooldownMs: 30 * 60_000, issueNumber: 2138, reason: "r" });
    assert.equal(state.pausedUntil, "2026-10-13T16:18:00.000Z");
    const raw = JSON.stringify(state);
    assert.equal(activeInfraPause(raw, T0 + 60_000)?.issueNumber, 2138);
    assert.equal(activeInfraPause(raw, T0 + 30 * 60_000), null);
    assert.equal(activeInfraPause("not json", T0), null);
    assert.equal(activeInfraPause(null, T0), null);
  });

  test("a second trip extends the pause but never shortens it", () => {
    const first = JSON.stringify(nextInfraPause({ existing: null, nowMs: T0, cooldownMs: 60 * 60_000, issueNumber: 1, reason: "a" }));
    const shorter = nextInfraPause({ existing: first, nowMs: T0 + 60_000, cooldownMs: 5 * 60_000, issueNumber: 2, reason: "b" });
    assert.equal(shorter.issueNumber, 1, "the longer pause stands");
    const longer = nextInfraPause({ existing: first, nowMs: T0 + 59 * 60_000, cooldownMs: 30 * 60_000, issueNumber: 2, reason: "b" });
    assert.equal(longer.issueNumber, 2);
    assert.equal(longer.pausedUntil, new Date(T0 + 89 * 60_000).toISOString());
  });
});
