// A same-tree or base re-run runs a gate's failing tests under the gate's own
// worker count (gate-output.ts, rerunLoad), since 2026-10-15.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBaselineCommand, buildBaselineFilter, namesPassedEveryTime, parseGateOutput, rerunLoad, rerunLoadArguments } from "./gate-output.js";

/** A Playwright JSON report: file → test → [status, duration ms]. */
const report = (config: unknown, files: Record<string, Record<string, [string, number]>>) => JSON.stringify({
  config,
  suites: Object.entries(files).map(([file, tests]) => ({ title: file, specs: Object.entries(tests).map(([title, [st, duration]]) => ({
    title, tests: [{ status: st === "passed" ? "expected" : "unexpected", results: [{ status: st, duration }] }],
  })) })),
});
const gate = (workers: number) => parseGateOutput(report({ workers, metadata: { actualWorkers: workers } }, {
  "flow.spec.ts": { a: ["failed", 3000], b: ["passed", 1000] },
  "quick.spec.ts": { q1: ["passed", 400], q2: ["passed", 400], q3: ["passed", 4000], q4: ["passed", 400] },
  "slow.spec.ts": { s1: ["passed", 9000], s2: ["passed", 9000] },
  "third.spec.ts": { t1: ["failed", 100] },
  "fourth.spec.ts": { f1: ["passed", 5000] },
}), "playwright-json");

test("a Playwright report carries the workers it ran with, the actual count first", () => {
  assert.equal(parseGateOutput(report({ workers: 3, metadata: { actualWorkers: 1 } }, { "x.spec.ts": { a: ["passed", 1] } }), "playwright-json").workers, 1);
  assert.equal(parseGateOutput(report({ workers: 4 }, { "x.spec.ts": { a: ["passed", 1] } }), "playwright-json").workers, 4);
  assert.equal(parseGateOutput(report({}, { "x.spec.ts": { a: ["passed", 1] } }), "playwright-json").workers, undefined);
  assert.equal(parseGateOutput(report({ workers: "4" }, { "x.spec.ts": { a: ["passed", 1] } }), "playwright-json").workers, undefined);
});

test("idle workers get passing tests from other files, each file until it outlasts the slowest failing test", () => {
  const load = rerunLoad("playwright-json", gate(4), ["flow.spec.ts › a"])!;
  assert.equal(load.workers, 4);
  assert.deepEqual(load.tests, [
    "quick.spec.ts › q1", "quick.spec.ts › q2", "quick.spec.ts › q3", // 4800 ms, past a's 3000
    "slow.spec.ts › s1", // 9000 ms
    "fourth.spec.ts › f1", // third.spec.ts failed in the gate, so it carries no passing test
  ], "three idle workers, three files, and never a test from the failing file or a failed one");
  assert.ok(!load.tests.some((t) => t.startsWith("flow.spec.ts")), "never more of the failing file, which runs in one worker anyway");
});

test("no load tests once the failing files fill the workers, and none at all for one worker or other formats", () => {
  assert.deepEqual(rerunLoad("playwright-json", gate(2), ["flow.spec.ts › a", "third.spec.ts › t1"]), { workers: 2, tests: [] });
  assert.equal(rerunLoad("playwright-json", gate(1), ["flow.spec.ts › a"]), null, "a one-worker gate re-runs as before");
  assert.equal(rerunLoad("playwright-json", { workers: undefined }, ["flow.spec.ts › a"]), null);
  assert.equal(rerunLoad("go-json", { workers: 8 }, ["p.TestA"]), null, "Go reports no worker count");
  assert.equal(rerunLoad("junit-xml", { workers: 2 }, ["p.C#m"]), null);
  assert.equal(rerunLoadArguments(null), "");
  assert.equal(rerunLoadArguments({ workers: 4, tests: [] }), " --workers=4");
});

test("the worker count follows the filter only where it stays inside the runner's own arguments", () => {
  const filter = buildBaselineFilter(["flow.spec.ts › a"], "playwright-json")!;
  const load = " --workers=4";
  assert.equal(buildBaselineCommand("npm run build >&2 && npx playwright test --reporter=json -g {{TESTS}}", filter, load),
    `npm run build >&2 && npx playwright test --reporter=json -g ${filter}${load}`);
  assert.equal(buildBaselineCommand("npx playwright test --grep={{TESTS}} --project=parallel", filter, load),
    `npx playwright test --grep=${filter}${load} --project=parallel`);
  assert.equal(buildBaselineCommand("PW_GREP={{TESTS}} npm run e2e", filter, load), `PW_GREP=${filter} npm run e2e`, "an assignment would split");
  assert.equal(buildBaselineCommand("x -g {{TESTS}} && y -g {{TESTS}}", filter, load), `x -g ${filter} && y -g ${filter}`, "two placeholders: none");
  assert.equal(buildBaselineCommand("npx playwright test", filter, load), null);
});

test("a load test's file is anchored, so it pulls in no other file's tests", () => {
  const filter = buildBaselineFilter(["flow.spec.ts › a"], "playwright-json", ["a.spec.ts › x"])!;
  assert.equal(filter, "'(flow\\.spec\\.ts.*a|(?:^|[ /])a\\.spec\\.ts(?: |$).*x)'");
  const re = new RegExp(filter.slice(1, -1), "i");
  assert.ok(re.test("parallel a.spec.ts x"));
  assert.ok(re.test(" e2e/a.spec.ts suite x"), "a file in a folder");
  assert.ok(!re.test("parallel data.spec.ts x"), "a longer file name is another file");
  assert.equal(buildBaselineFilter(["flow.spec.ts › a"], "playwright-json", ["bad.spec.ts › it's"]), null, "an unsafe load name refuses the loaded filter");
});

test("a name that also failed in another project did not pass", () => {
  const tally = { passedNames: ["flow.spec.ts › a", "flow.spec.ts › b"], failedNames: ["flow.spec.ts › a"] };
  assert.deepEqual(namesPassedEveryTime(tally), ["flow.spec.ts › b"]);
});
