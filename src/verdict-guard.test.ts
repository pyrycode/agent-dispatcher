import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  countVerdictsSince,
  extractMustFixFindings,
  extractMustFixKeys,
  findRepeatedMustFix,
  findingTextSimilarity,
  REPEAT_FINDING_SIMILARITY,
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

describe("repeated verifier finding compares the finding text, not only its location (agent-dispatcher#130)", () => {
  // Verbatim verifier comments for mobile #1747 on pyrycode/pyrycode-mobile#1755.
  // 10:18 and 12:42 raise the same mixed-route ordering defect in
  // `ThreadScreen.kt` → `ThreadScreen`; 12:42 says it "remains". 14:05 raises
  // a different defect, the paste callback, under the same location key. The
  // location-only rule parked #1747 at 14:05.
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/mobile-1755-verdicts.json", import.meta.url), "utf8")) as {
    comments: Array<{ createdAt: string; body: string }>;
  };
  const at = (time: string) => {
    const c = fixture.comments.find((x) => x.createdAt === `2026-10-05T${time}Z`);
    assert.ok(c, `fixture has the ${time} verdict`);
    return c!;
  };
  const threadScreen = "app/src/main/java/de/pyryco/mobile/ui/conversations/thread/ThreadScreen.kt → ThreadScreen";
  const artifactsOf = (...times: string[]) => parseVerdictArtifacts(JSON.stringify({ comments: times.map(at) }));

  test("#1747 negative: 12:42 and 14:05 share the ThreadScreen key but raise different defects, so nothing repeats", () => {
    assert.ok(extractMustFixKeys(at("12:42:48").body).includes(threadScreen));
    assert.ok(extractMustFixKeys(at("14:05:22").body).includes(threadScreen), "the location-only rule saw a repeat here");
    assert.deepStrictEqual(findRepeatedMustFix(artifactsOf("12:42:48", "14:05:22")), []);
  });

  test("#1747 positive: 10:18 and 12:42 raise the same ordering defect in reworded text, so it repeats", () => {
    assert.deepStrictEqual(findRepeatedMustFix(artifactsOf("10:18:57", "12:42:48")), [threadScreen]);
  });

  test("the threshold sits between the measured #1755 pairs", () => {
    const finding = (time: string) => extractMustFixFindings(at(time).body).find((f) => f.key === threadScreen)!.text;
    const repeat = findingTextSimilarity(finding("10:18:57"), finding("12:42:48"));
    const different = findingTextSimilarity(finding("12:42:48"), finding("14:05:22"));
    assert.ok(repeat >= REPEAT_FINDING_SIMILARITY, `true repeat scored ${repeat}`);
    assert.ok(different < REPEAT_FINDING_SIMILARITY, `different finding scored ${different}`);
  });

  test("same key with unrelated text is not a repeat; identical text under the same key still is", () => {
    const verdict = (finding: string) => `## Verifier Review: #1\n\n**Decision: FAIL**\n\n### Findings\n- ${finding}\n`;
    const a = "[MUST FIX] `app/src/Screen.kt` → `Screen`: the retry button stays enabled while a request is in flight, so a double tap sends two requests";
    const b = "[MUST FIX] `app/src/Screen.kt` → `Screen`: the header title uses a hardcoded colour instead of the theme token";
    const comments = (first: string, second: string) => parseVerdictArtifacts(JSON.stringify({ comments: [
      { createdAt: "2026-10-05T09:00:00Z", body: verdict(first) },
      { createdAt: "2026-10-05T10:00:00Z", body: verdict(second) },
    ] }));
    assert.deepStrictEqual(findRepeatedMustFix(comments(a, b)), []);
    assert.deepStrictEqual(findRepeatedMustFix(comments(a, a.replace("so a double tap", "so a double-tap"))), ["app/src/Screen.kt → Screen"]);
  });

  test("extractMustFixFindings keeps each finding's text after the key, and a key with several findings keeps them all", () => {
    const body = "- [MUST FIX] `a.kt` → `A`: first defect\n- [MUST FIX] `a.kt` → `A`, `helper`: second defect\n- [SHOULD FIX] `b.kt` → `B`: skipped";
    assert.deepStrictEqual(extractMustFixFindings(body), [
      { key: "a.kt → A", text: ": first defect" },
      { key: "a.kt → A", text: ", `helper`: second defect" },
    ]);
    assert.deepStrictEqual(extractMustFixKeys(body), ["a.kt → A"]);
  });
});
