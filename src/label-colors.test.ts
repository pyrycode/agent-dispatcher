import { test } from "node:test";
import assert from "node:assert/strict";
import { labelColor, DEFAULT_LABEL_COLOR } from "./label-colors.js";

function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("one colour per family", () => {
  assert.equal(labelColor("error:builder"), labelColor("error:verifier:permission_denied"));
  assert.equal(labelColor("rework-count:3"), labelColor("family-dispatches:12"));
  assert.notEqual(labelColor("done:refiner"), labelColor("done:documentation"));
  assert.equal(labelColor("something-new"), DEFAULT_LABEL_COLOR);
});

test("every colour reads in black or white text", () => {
  const names = ["error:x", "needs-human:x", "needs-rework:x", "wip:x", "pending-done:x", "held:x", "orchestrator:fixing",
    "orchestrator:escalated", "claim:pyrybox", "claim:build-fractal-2", "priority:high", "priority:normal", "priority:low",
    "size:xs", "size:s", "size:m", "size:l", "done:po", "done:architect", "done:developer", "done:qa", "done:verifier",
    "done:documentation", "merged", "security-sensitive", "rework-count:1"];
  for (const n of names) {
    const l = luminance(labelColor(n));
    const best = Math.max(1.05 / (l + 0.05), (l + 0.05) / 0.05);
    assert.ok(best >= 5, `${n} contrast ${best.toFixed(1)}`);
  }
});
