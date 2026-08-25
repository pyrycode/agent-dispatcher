// Unit tests for the transient-error auto-retry layer (agent-dispatcher#25).
// Pure decision functions only; the dispatch.ts wiring is covered by the
// integration tests. node:test + assert to match the repo convention.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyAgentError,
  backoffDelayMs,
  isRetryEligible,
  extractErrorRetryCount,
  isRetryWaiting,
  seededRng,
  countPipelineInFlight,
  decideDoneCleanup,
  RETRY_ALLOWLIST,
  RETRY_BASE_MS,
  RETRY_MAX_ATTEMPTS,
  ERROR_RETRY_COUNT_PREFIX,
} from "./pipeline-decisions.js";

const MIN = 60_000;

describe("classifyAgentError", () => {
  test("matches transient transport/API signatures from the allowlist", () => {
    const cases: { text: string; sig: string }[] = [
      { text: "Agent error (error): socket connection was closed unexpectedly", sig: "socket closed" },
      { text: "TypeError: fetch failed", sig: "fetch failed" },
      { text: "read ECONNRESET", sig: "connection reset" },
      { text: "API Error: 500 Internal Server Error", sig: "API 5xx" },
      { text: 'API Error: 529 {"type":"overloaded_error"}', sig: "overloaded" },
      { text: "Request failed with status 429 Too Many Requests", sig: "rate limit (429)" },
      { text: "posix_spawn: cannot fork", sig: "cannot fork" },
      { text: "Agent spawn failed after 4 attempts (errno: EAGAIN)", sig: "host pressure (EAGAIN)" },
    ];
    for (const c of cases) {
      const r = classifyAgentError(c.text);
      assert.equal(r.transient, true, c.text);
      assert.equal(r.signature, c.sig, c.text);
    }
  });

  test("idle_stall (pyry watchdog, pyrycode#360) classifies transient", () => {
    // The dispatcher throws `Agent error (idle_stall): <output>` and the
    // streamrunner's synthetic result embeds the phrase again in `output`.
    const realistic = "Agent error (idle_stall): idle_stall: no stream activity for 240s while awaiting assistant turn";
    const r = classifyAgentError(realistic);
    assert.equal(r.transient, true);
    assert.equal(r.signature, "idle stream stall");
  });

  test("shared-login auth 401 (Please run /login) classifies transient", () => {
    // The exact string that parked 26 tui-driver tickets on 2026-07-03 when
    // the shared macOS keychain Claude login's token refresh failed for ~20
    // min and then self-healed. Both phrasings of the same failure match.
    const observed = "Agent error (): Please run /login · API Error: 401 Invalid authentication credentials";
    const r = classifyAgentError(observed);
    assert.equal(r.transient, true);
    assert.equal(r.signature, "auth token (401)");
    assert.equal(classifyAgentError("API Error: 401 Invalid authentication credentials").transient, true);
    assert.equal(classifyAgentError("Please run /login").transient, true);
  });

  test("a bare 529 (no overloaded_error text) still classifies transient", () => {
    const r = classifyAgentError("API Error: 529 Service Overloaded");
    assert.equal(r.transient, true);
    assert.equal(r.signature, "overloaded (529)");
  });

  test("is case-insensitive", () => {
    assert.equal(classifyAgentError("FETCH FAILED").transient, true);
    assert.equal(classifyAgentError("OvErLoAdEd_ErRoR").transient, true);
  });

  test("does NOT match the never-auto-retry / non-transient strings", () => {
    const nonMatching = [
      "Agent error (max_turns): no output",
      "Agent timed out after 600s",
      "Local `feature/5` has commits not present on origin/feature/5",
      "400 thinking/redacted_thinking blocks cannot be modified",
      "go test ./... FAILED: 3 tests failing",
      "some unrelated build error",
    ];
    for (const text of nonMatching) {
      const r = classifyAgentError(text);
      assert.equal(r.transient, false, text);
      assert.equal(r.signature, "", text);
    }
  });

  test("treats null/undefined/empty as non-transient", () => {
    assert.equal(classifyAgentError(null).transient, false);
    assert.equal(classifyAgentError(undefined).transient, false);
    assert.equal(classifyAgentError("").transient, false);
  });

  test("every allowlist entry is itself classified transient (self-consistency)", () => {
    for (const entry of RETRY_ALLOWLIST) {
      assert.equal(classifyAgentError(entry.match).transient, true, entry.match);
    }
  });

  // ---- structural arm: terminal_reason === "api_error" -------------------
  // The two real strings that parked pyrycode#1731 and #1747 on 2026-08-24.
  // Both are server-side failures the WORDING list has never seen; both
  // carried `terminal_reason: "api_error"` on the result frame.

  const OBSERVED_403 =
    "Agent error (api_error): subtype=success api_error_status=403 stop_reason=stop_sequence. " +
    "Ran 4m 29s (timeout 20min). Last agent text (not the failure cause): " +
    "Failed to authenticate. API Error: 403 Unable to verify organization membership.";

  const OBSERVED_MID_RESPONSE =
    "Agent error (api_error): subtype=success stop_reason=stop_sequence. " +
    "Ran 4m 38s (timeout 20min). Last agent text (not the failure cause): " +
    "API Error: Server error mid-response. The response above may be incomplete.";

  test("the wording list alone is blind to both 2026-08-24 failures", () => {
    // Establishes WHY the structural arm is needed: with no terminal_reason
    // supplied these park, which is exactly what happened on the day.
    for (const text of [OBSERVED_403, OBSERVED_MID_RESPONSE]) {
      assert.equal(classifyAgentError(text).transient, false, text);
    }
  });

  test("terminal_reason api_error classifies transient whatever the wording", () => {
    for (const text of [OBSERVED_403, OBSERVED_MID_RESPONSE]) {
      const r = classifyAgentError(text, { terminalReason: "api_error" });
      assert.equal(r.transient, true, text);
      assert.equal(r.signature, "API error (server-side)", text);
    }
  });

  test("terminal_reason api_error covers a wording nobody has seen yet", () => {
    const r = classifyAgentError(
      "Agent error (api_error): API Error: 418 I am a teapot",
      { terminalReason: "api_error" },
    );
    assert.equal(r.transient, true);
    assert.equal(r.signature, "API error (server-side)");
  });

  test("the never-retry reasons stay non-transient", () => {
    // `completed` is where the deterministic 400 thinking/redacted_thinking
    // harness bug surfaces (3 instances, 2026-05-28, relay board) — retrying
    // it burns the full backoff and parks anyway.
    const thinkingBlocks =
      "Agent error (completed): API Error: 400 messages.1.content.11: `thinking` or " +
      "`redacted_thinking` blocks in the latest assistant message cannot be modified.";
    assert.equal(classifyAgentError(thinkingBlocks, { terminalReason: "completed" }).transient, false);
    assert.equal(
      classifyAgentError("Agent error (timeout): agent killed after 25min", { terminalReason: "timeout" }).transient,
      false,
    );
  });

  test("a never-retry reason overrides an allowlist match in the narration", () => {
    // Guard, not an observed case: no timeout/completed failure in the log
    // corpus matches the allowlist today. It exists so an agent narrating
    // "fetch failed" before a wall-clock kill can't buy itself a re-run.
    const r = classifyAgentError(
      "Agent error (timeout): Last agent text (not the failure cause): TypeError: fetch failed",
      { terminalReason: "timeout" },
    );
    assert.equal(r.transient, false);
    assert.equal(r.signature, "");
  });

  test("the structural arm tolerates a missing / odd terminal_reason", () => {
    // Absent, null and empty all fall through to the wording list unchanged.
    assert.equal(classifyAgentError("TypeError: fetch failed", {}).transient, true);
    assert.equal(classifyAgentError("TypeError: fetch failed", { terminalReason: null }).transient, true);
    assert.equal(classifyAgentError("TypeError: fetch failed", { terminalReason: "" }).transient, true);
    // Case and stray whitespace off the result frame still match.
    assert.equal(classifyAgentError("", { terminalReason: " API_ERROR " }).transient, true);
    // A reason with no error text at all is still classifiable.
    assert.equal(classifyAgentError(null, { terminalReason: "api_error" }).transient, true);
  });
});

describe("backoffDelayMs", () => {
  test("returns the nominal 5/10/20/40-min schedule at full jitter (rng=1)", () => {
    const rng = () => 1;
    assert.equal(backoffDelayMs(1, { rng }), 5 * MIN);
    assert.equal(backoffDelayMs(2, { rng }), 10 * MIN);
    assert.equal(backoffDelayMs(3, { rng }), 20 * MIN);
    assert.equal(backoffDelayMs(4, { rng }), 40 * MIN);
  });

  test("doubles per attempt; cap-boundary attempt = RETRY_MAX_ATTEMPTS", () => {
    const atCap = backoffDelayMs(RETRY_MAX_ATTEMPTS, { rng: () => 1 });
    assert.equal(atCap, RETRY_BASE_MS * 2 ** (RETRY_MAX_ATTEMPTS - 1));
    assert.equal(atCap, 40 * MIN);
  });

  test("full jitter floors at 0 (rng=0) and scales linearly (rng=0.5)", () => {
    assert.equal(backoffDelayMs(3, { rng: () => 0 }), 0);
    assert.equal(backoffDelayMs(3, { rng: () => 0.5 }), 10 * MIN);
  });

  test("never exceeds the nominal for any rng in [0,1]", () => {
    for (const r of [0, 0.13, 0.5, 0.87, 1]) {
      assert.ok(backoffDelayMs(2, { rng: () => r }) <= 10 * MIN);
    }
  });

  test("clamps out-of-range / non-finite rng output", () => {
    assert.equal(backoffDelayMs(1, { rng: () => 2 }), 5 * MIN); // clamps to 1
    assert.equal(backoffDelayMs(1, { rng: () => -1 }), 0); // clamps to 0
    assert.equal(backoffDelayMs(1, { rng: () => NaN }), 0);
  });

  test("returns 0 for non-positive attempts", () => {
    assert.equal(backoffDelayMs(0, { rng: () => 1 }), 0);
    assert.equal(backoffDelayMs(-3, { rng: () => 1 }), 0);
  });

  test("honours an injected baseMs", () => {
    assert.equal(backoffDelayMs(1, { rng: () => 1, baseMs: 1000 }), 1000);
    assert.equal(backoffDelayMs(3, { rng: () => 1, baseMs: 1000 }), 4000);
  });
});

describe("isRetryEligible", () => {
  const rng = () => 1; // nominal delay
  const base = 1_000_000;

  test("is false before the backoff window elapses", () => {
    assert.equal(isRetryEligible(base, 1, base + 4 * MIN, { rng }), false);
  });

  test("is true at and after the deadline", () => {
    assert.equal(isRetryEligible(base, 1, base + 5 * MIN, { rng }), true);
    assert.equal(isRetryEligible(base, 1, base + 6 * MIN, { rng }), true);
  });

  test("accepts Date inputs", () => {
    assert.equal(isRetryEligible(new Date(base), 1, new Date(base + 5 * MIN), { rng }), true);
  });

  test("uses the per-attempt delay (longer windows for later attempts)", () => {
    assert.equal(isRetryEligible(base, 4, base + 30 * MIN, { rng }), false);
    assert.equal(isRetryEligible(base, 4, base + 40 * MIN, { rng }), true);
  });
});

describe("seededRng", () => {
  test("is deterministic for the same (issueNumber, attempt)", () => {
    const a = seededRng(42, 2);
    const b = seededRng(42, 2);
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  });

  test("makes backoffDelayMs stable across re-derivation (no cross-poll drift)", () => {
    const d1 = backoffDelayMs(2, { rng: seededRng(123, 2) });
    const d2 = backoffDelayMs(2, { rng: seededRng(123, 2) });
    assert.equal(d1, d2);
  });

  test("decorrelates different tickets", () => {
    const d1 = backoffDelayMs(2, { rng: seededRng(1, 2) });
    const d2 = backoffDelayMs(2, { rng: seededRng(2, 2) });
    assert.notEqual(d1, d2);
  });

  test("first draw decorrelates across consecutive issue numbers (regression: weak seed avalanche)", () => {
    // backoffDelayMs draws ONCE, so the first draw must already decorrelate.
    // A lightly-mixed mulberry32 seed collapses consecutive issue numbers to
    // an identical first value — the splitmix32 finalizer in seededRng fixes
    // that. Consecutive numbers are the realistic case (a burst errors many
    // tickets near-simultaneously and we don't want lockstep retries).
    const delays = [201, 202, 203, 204, 205].map(
      (iss) => backoffDelayMs(1, { rng: seededRng(iss, 1) }),
    );
    assert.equal(new Set(delays).size, delays.length, `expected distinct delays, got ${delays.join(",")}`);
  });

  test("yields values in [0,1)", () => {
    const r = seededRng(7, 3);
    for (let i = 0; i < 50; i++) {
      const v = r();
      assert.ok(v >= 0 && v < 1, `value out of range: ${v}`);
    }
  });
});

describe("extractErrorRetryCount", () => {
  test("returns 0 when no counter label is present", () => {
    assert.equal(extractErrorRetryCount([]), 0);
    assert.equal(extractErrorRetryCount(["error:developer", "size:s"]), 0);
  });

  test("reads the counter value", () => {
    assert.equal(extractErrorRetryCount([`${ERROR_RETRY_COUNT_PREFIX}3`]), 3);
  });

  test("returns the max when multiple counters co-exist", () => {
    assert.equal(extractErrorRetryCount([
      `${ERROR_RETRY_COUNT_PREFIX}1`,
      `${ERROR_RETRY_COUNT_PREFIX}4`,
      `${ERROR_RETRY_COUNT_PREFIX}2`,
    ]), 4);
  });

  test("tolerates malformed / negative tails as 0", () => {
    assert.equal(extractErrorRetryCount([`${ERROR_RETRY_COUNT_PREFIX}abc`]), 0);
    assert.equal(extractErrorRetryCount([`${ERROR_RETRY_COUNT_PREFIX}`]), 0);
    assert.equal(extractErrorRetryCount([`${ERROR_RETRY_COUNT_PREFIX}-2`]), 0);
  });

  test("does not collide with the error: pipeline prefix", () => {
    assert.equal(`${ERROR_RETRY_COUNT_PREFIX}2`.startsWith("error:"), false);
  });
});

describe("isRetryWaiting", () => {
  test("is true when a counter is present and the ticket is not running", () => {
    assert.equal(isRetryWaiting([`${ERROR_RETRY_COUNT_PREFIX}1`]), true);
  });

  test("is false when the retry is actively running (wip present)", () => {
    assert.equal(isRetryWaiting([`${ERROR_RETRY_COUNT_PREFIX}1`, "wip:developer"]), false);
  });

  test("is false with no counter", () => {
    assert.equal(isRetryWaiting(["wip:developer"]), false);
    assert.equal(isRetryWaiting([]), false);
  });
});

describe("countPipelineInFlight (retry-waiting exclusion)", () => {
  test("excludes a waiting retry but counts a running one", () => {
    const items = [
      { issueNumber: 1, labels: ["wip:developer"] }, // running normal → counts
      { issueNumber: 2, labels: [`${ERROR_RETRY_COUNT_PREFIX}1`] }, // waiting retry → excluded
      { issueNumber: 3, labels: [`${ERROR_RETRY_COUNT_PREFIX}2`, "wip:qa"] }, // re-dispatched retry → counts
      { issueNumber: 4, labels: ["error:developer"] }, // parked → excluded (existing rule)
      { issueNumber: 5, labels: [] }, // just-arrived → counts (existing rule)
    ];
    assert.equal(countPipelineInFlight(items), 3); // #1, #3, #5
  });
});

describe("decideDoneCleanup (strips error-retry-count)", () => {
  test("strips the retry counter on terminal tickets", () => {
    const cleanups = decideDoneCleanup([
      { id: "i1", issueNumber: 10, labels: [`${ERROR_RETRY_COUNT_PREFIX}2`, "done:developer", "size:s"] },
    ]);
    assert.equal(cleanups.length, 1);
    assert.ok(cleanups[0].labelsToStrip.includes(`${ERROR_RETRY_COUNT_PREFIX}2`));
    assert.ok(cleanups[0].labelsToStrip.includes("done:developer"));
    assert.ok(!cleanups[0].labelsToStrip.includes("size:s"));
  });
});
