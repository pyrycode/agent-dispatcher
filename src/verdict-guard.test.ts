import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  countVerdictsSince,
  extractMustFixKeys,
  findRepeatedMustFix,
  parseVerdictArtifacts,
  pickVerdictPr,
  shouldFlagMissingVerdict,
} from "./verdict-guard.js";

describe("verdict guard — a verifier that ends without ruling is an error, not a pass (2026-09-22)", () => {
  const T0 = Date.parse("2026-09-22T13:28:52Z"); // the run's start

  test("parseVerdictArtifacts reads review submissions and comment creations, tolerating absent keys", () => {
    const both = parseVerdictArtifacts(JSON.stringify({
      reviews: [{ submittedAt: "2026-09-22T13:40:00Z", state: "APPROVED" }],
      comments: [{ createdAt: "2026-09-22T13:41:00Z" }],
    }));
    assert.deepStrictEqual(both.map((a) => a.at), ["2026-09-22T13:40:00Z", "2026-09-22T13:41:00Z"]);
    assert.deepStrictEqual(parseVerdictArtifacts("{}"), []);
    assert.deepStrictEqual(parseVerdictArtifacts(JSON.stringify({ reviews: [{}], comments: [] })), []);
    assert.throws(() => parseVerdictArtifacts("not json"));
  });

  test("countVerdictsSince counts only what was posted at or after the run started", () => {
    const artifacts = [
      { at: "2026-09-22T13:00:00Z" }, // an earlier run's review
      { at: "2026-09-22T13:28:52Z" }, // exactly at start counts
      { at: "2026-09-22T13:40:23Z" },
      { at: "garbage" },
    ];
    assert.equal(countVerdictsSince(artifacts, T0), 2);
    assert.equal(countVerdictsSince([], T0), 0);
  });

  test("shouldFlagMissingVerdict fires only for a verdict agent with nothing posted and no rework label", () => {
    const verifier = { requiresVerdict: true };
    assert.equal(shouldFlagMissingVerdict(verifier, ["bug"], 0), true, "the #782 shape");
    assert.equal(shouldFlagMissingVerdict(verifier, ["bug"], 1), false, "a review after start is a verdict");
    assert.equal(shouldFlagMissingVerdict(verifier, ["needs-rework:builder"], 0), false, "a FAIL routes by label and needs no review to be honest");
    assert.equal(shouldFlagMissingVerdict(verifier, ["bug"], -1), false, "a failed lookup stays quiet, like the empty-branch guard on git errors");
    assert.equal(shouldFlagMissingVerdict({}, ["bug"], 0), false, "agents without the flag are untouched");
    assert.equal(shouldFlagMissingVerdict({ requiresVerdict: false }, [], 0), false);
  });

  test("pickVerdictPr prefers the non-draft pull request, falls back to the first, null when none", () => {
    assert.equal(pickVerdictPr(JSON.stringify([{ number: 10, isDraft: true }, { number: 11, isDraft: false }])), 11);
    assert.equal(pickVerdictPr(JSON.stringify([{ number: 10, isDraft: true }])), 10);
    assert.equal(pickVerdictPr("[]"), null);
    assert.equal(pickVerdictPr(""), null);
  });
});

describe("repeated verifier finding — the rework breaker's repeat rule (agent-dispatcher#122)", () => {
  /** A verdict comment in the shape the verifier prompt requires. */
  const verdict = (decision: "PASS" | "FAIL", findings: string[]) =>
    `## Verifier Review: #1782\n\n**Decision: ${decision}**\n**Gates:** green\n\n### Findings\n` +
    findings.map((f) => `- ${f}`).join("\n") +
    `\n\n### Summary\nSee findings.`;
  const row = "[MUST FIX] `app/src/main/java/de/pyryco/mobile/ui/ChannelListScreen.kt` → `ChannelRow`: hardcoded colour";
  const vm = "[MUST FIX] `app/src/main/java/de/pyryco/mobile/ui/ChannelListViewModel.kt` → `ChannelListViewModel.load`: ordering";

  test("parseVerdictArtifacts carries each review's and comment's body", () => {
    const parsed = parseVerdictArtifacts(JSON.stringify({
      reviews: [{ submittedAt: "2026-10-04T10:00:00Z", body: "review text" }],
      comments: [{ createdAt: "2026-10-04T11:00:00Z", body: "comment text" }, { createdAt: "2026-10-04T12:00:00Z" }],
    }));
    assert.deepStrictEqual(parsed.map((a) => a.body), ["review text", "comment text", ""]);
  });

  test("extractMustFixKeys reads `path → Symbol` from MUST FIX lines only", () => {
    const body = verdict("FAIL", [
      row,
      vm,
      "[MUST FIX] `app/build.gradle.kts` -> `android`: plain arrow, bare-word symbols are read too",
      "[MUST FIX] `app/src/Foo.kt` → Bar: unquoted symbol",
      "[MUST FIX] `app/src/Foo.kt:120`: a line-number finding has no symbol, so no key",
      "[SHOULD FIX] `app/src/Theme.kt` → `Theme`: not a must-fix",
      "[NIT] `app/src/Theme.kt`: typo",
    ]);
    assert.deepStrictEqual(extractMustFixKeys(body), [
      "app/src/main/java/de/pyryco/mobile/ui/ChannelListScreen.kt → ChannelRow",
      "app/src/main/java/de/pyryco/mobile/ui/ChannelListViewModel.kt → ChannelListViewModel.load",
      "app/build.gradle.kts → android",
      "app/src/Foo.kt → Bar",
    ]);
    assert.deepStrictEqual(extractMustFixKeys("free text with no findings"), []);
  });

  test("a key in both the newest FAIL and the FAIL before it is a repeat", () => {
    const artifacts = parseVerdictArtifacts(JSON.stringify({
      comments: [
        { createdAt: "2026-10-04T08:00:00Z", body: verdict("FAIL", [vm]) },
        { createdAt: "2026-10-04T09:00:00Z", body: verdict("FAIL", [row, vm]) },
        { createdAt: "2026-10-04T10:00:00Z", body: verdict("FAIL", [row]) },
      ],
    }));
    assert.deepStrictEqual(findRepeatedMustFix(artifacts), ["app/src/main/java/de/pyryco/mobile/ui/ChannelListScreen.kt → ChannelRow"],
      "only the newest two FAILs are compared, so the older vm finding is not reported");
  });

  test("the #1782 shape: each round names different defects, so nothing repeats", () => {
    const artifacts = parseVerdictArtifacts(JSON.stringify({
      comments: [
        { createdAt: "2026-10-04T08:00:00Z", body: verdict("FAIL", [vm]) },
        { createdAt: "2026-10-04T09:00:00Z", body: verdict("FAIL", [row]) },
      ],
    }));
    assert.deepStrictEqual(findRepeatedMustFix(artifacts), []);
  });

  test("reviews and comments both count, ordered by time, and PASS verdicts and other comments are skipped", () => {
    const artifacts = parseVerdictArtifacts(JSON.stringify({
      reviews: [{ submittedAt: "2026-10-04T08:00:00Z", body: verdict("FAIL", [row]) }],
      comments: [
        { createdAt: "2026-10-04T10:00:00Z", body: verdict("FAIL", [row, vm]) },
        { createdAt: "2026-10-04T09:00:00Z", body: verdict("PASS", [vm]) },
        { createdAt: "2026-10-04T09:30:00Z", body: `${row}\n**Decision: FAIL**\nnot headed as a verifier review` },
      ],
    }));
    assert.deepStrictEqual(findRepeatedMustFix(artifacts), ["app/src/main/java/de/pyryco/mobile/ui/ChannelListScreen.kt → ChannelRow"]);
  });

  test("one verdict posted twice, as a review and a comment, is one round, not a repeat", () => {
    const body = verdict("FAIL", [row]);
    const artifacts = parseVerdictArtifacts(JSON.stringify({
      reviews: [{ submittedAt: "2026-10-04T10:00:00Z", body }],
      comments: [{ createdAt: "2026-10-04T10:00:05Z", body }],
    }));
    assert.deepStrictEqual(findRepeatedMustFix(artifacts), []);
  });

  test("fewer than two FAIL verdicts, or a FAIL with no parseable keys, is never a repeat", () => {
    const one = parseVerdictArtifacts(JSON.stringify({ comments: [{ createdAt: "2026-10-04T10:00:00Z", body: verdict("FAIL", [row]) }] }));
    assert.deepStrictEqual(findRepeatedMustFix(one), []);
    assert.deepStrictEqual(findRepeatedMustFix([]), []);
    const unkeyed = parseVerdictArtifacts(JSON.stringify({
      comments: [
        { createdAt: "2026-10-04T09:00:00Z", body: verdict("FAIL", ["[MUST FIX] the suite is red"]) },
        { createdAt: "2026-10-04T10:00:00Z", body: verdict("FAIL", ["[MUST FIX] the suite is red again"]) },
      ],
    }));
    assert.deepStrictEqual(findRepeatedMustFix(unkeyed), []);
  });
});
