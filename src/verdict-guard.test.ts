import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  countVerdictsSince,
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
