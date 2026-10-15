// A same-tree or base re-run runs a gate's failing tests under the gate's own
// worker count (gate-output.ts, rerunLoadArguments), since 2026-10-15.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBaselineCommand, buildBaselineFilter, namesPassedEveryTime, parseGateOutput, rerunLoadArguments } from "./gate-output.js";

const report = (config: unknown, statuses: Record<string, string[]>) => JSON.stringify({
  config,
  suites: [{ title: "flow.spec.ts", specs: Object.entries(statuses).map(([title, s]) => ({
    title, tests: s.map((st) => ({ status: st === "passed" ? "expected" : "unexpected", results: [{ status: st }] })),
  })) }],
});

test("a Playwright report carries the workers it ran with, the actual count first", () => {
  assert.equal(parseGateOutput(report({ workers: 3, metadata: { actualWorkers: 1 } }, { a: ["passed"] }), "playwright-json").workers, 1);
  assert.equal(parseGateOutput(report({ workers: 4 }, { a: ["passed"] }), "playwright-json").workers, 4);
  assert.equal(parseGateOutput(report({}, { a: ["passed"] }), "playwright-json").workers, undefined);
  assert.equal(parseGateOutput(report({ workers: "4" }, { a: ["passed"] }), "playwright-json").workers, undefined);
});

test("the load fills the gate's workers: the worker count, and repeats when fewer files failed", () => {
  assert.equal(rerunLoadArguments("playwright-json", ["flow.spec.ts › a"], 4), " --workers=4 --repeat-each=4");
  assert.equal(rerunLoadArguments("playwright-json", ["flow.spec.ts › a", "flow.spec.ts › b", "other.spec.ts › c"], 4), " --workers=4 --repeat-each=2");
  assert.equal(rerunLoadArguments("playwright-json", ["a.spec.ts › x", "b.spec.ts › x", "c.spec.ts › x", "d.spec.ts › x"], 4), " --workers=4");
  assert.equal(rerunLoadArguments("playwright-json", ["flow.spec.ts › a"], 1), "", "a one-worker gate re-runs as before");
  assert.equal(rerunLoadArguments("playwright-json", ["flow.spec.ts › a"], undefined), "");
  assert.equal(rerunLoadArguments("go-json", ["p.TestA"], 8), "", "Go reports no worker count");
  assert.equal(rerunLoadArguments("junit-xml", ["p.C#m"], 2), "");
});

test("the load follows the filter only where it stays inside the runner's own arguments", () => {
  const filter = buildBaselineFilter(["flow.spec.ts › a"], "playwright-json")!;
  const load = " --workers=4 --repeat-each=4";
  assert.equal(buildBaselineCommand("npm run build >&2 && npx playwright test --reporter=json -g {{TESTS}}", filter, load),
    `npm run build >&2 && npx playwright test --reporter=json -g ${filter}${load}`);
  assert.equal(buildBaselineCommand("npx playwright test --grep={{TESTS}} --project=parallel", filter, load),
    `npx playwright test --grep=${filter}${load} --project=parallel`);
  assert.equal(buildBaselineCommand("PW_GREP={{TESTS}} npm run e2e", filter, load), `PW_GREP=${filter} npm run e2e`, "an assignment would split");
  assert.equal(buildBaselineCommand("x -g {{TESTS}} && y -g {{TESTS}}", filter, load), `x -g ${filter} && y -g ${filter}`, "two placeholders: none");
  assert.equal(buildBaselineCommand("npx playwright test", filter, load), null);
});

test("a name passes a loaded re-run only when every copy passed", () => {
  const tally = parseGateOutput(report({ workers: 3 }, { a: ["passed", "failed", "passed"], b: ["passed", "passed", "passed"] }), "playwright-json");
  assert.deepEqual(namesPassedEveryTime(tally), ["flow.spec.ts › b"]);
});
