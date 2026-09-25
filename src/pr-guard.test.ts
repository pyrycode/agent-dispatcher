import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { countOpenPrs, shouldFlagMissingPr } from "./pr-guard.js";

describe("PR guard — a builder that ends without opening its PR is an error, not a pass (2026-09-24)", () => {
  test("countOpenPrs counts every open PR, drafts included, and reads empty output as none", () => {
    assert.equal(countOpenPrs(JSON.stringify([{ number: 10 }, { number: 11 }])), 2);
    assert.equal(countOpenPrs("[]"), 0);
    assert.equal(countOpenPrs(""), 0);
    assert.throws(() => countOpenPrs("not json"));
  });

  test("shouldFlagMissingPr fires only for a PR-opening agent with no open PR and no rework label", () => {
    const builder = { opensPr: true };
    assert.equal(shouldFlagMissingPr(builder, ["enhancement"], 0), true, "the #2569 shape");
    assert.equal(shouldFlagMissingPr(builder, ["enhancement"], 1), false, "an open PR is the handoff");
    assert.equal(shouldFlagMissingPr(builder, ["needs-rework:refiner"], 0), false, "a bail routes by label and owes no PR");
    assert.equal(shouldFlagMissingPr(builder, ["enhancement"], -1), false, "a failed lookup stays quiet, like the empty-branch guard on git errors");
    assert.equal(shouldFlagMissingPr({}, [], 0), false, "agents without the flag are untouched");
    assert.equal(shouldFlagMissingPr({ opensPr: false }, [], 0), false);
  });
});
