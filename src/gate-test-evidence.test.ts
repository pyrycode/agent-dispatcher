import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseGateOutput, parseGateTestDetails } from "./gate-output.js";
import { decideGateOutcome, decideGateVerdict } from "./pipeline-decisions.js";
import { liveGateLines, parseGateRunMeta, serializeGateRunMeta } from "./gate-report.js";
import { loadTestEvidenceRules, parseTestEvidenceRules, TEST_EVIDENCE_FILE, type TestEvidenceRule } from "./gate-test-evidence.js";

// Desktop's rule for its GPT-6 Luna channel scenario, as it ships in
// pyrycode-desktop-agents/live-test-evidence.json.
const desktopRulesText = readFileSync(new URL("./fixtures/desktop-live-test-evidence.json", import.meta.url), "utf8");
const parsed = parseTestEvidenceRules(desktopRulesText);
const rules: TestEvidenceRule[] = parsed.rules;

// Reduced retained 2026-10-11 Desktop #1809 report; the attempts below are
// synthetic parser fixtures, never live acceptance.
const raw = readFileSync(new URL("./fixtures/desktop-1809-live-report.json", import.meta.url), "utf8");
const luna = "real-claude-codex-channel.spec.ts › real GPT-6 Luna channel replies with Low effort from creation";
const decide = (output = raw, requiredTests: string[] = [luna], testEvidence: readonly TestEvidenceRule[] = rules) => decideGateVerdict({
  runError: null, timedOut: false, exitCode: 0, minExecuted: 10,
  tally: parseGateOutput(output, "playwright-json"), requiredTests, testEvidence,
});
const b64 = (text: string) => Buffer.from(text).toString("base64");
const revision = { name: "daemon-revision", contentType: "text/plain", body: b64("0.37.0") };
const model = { agent: "codex", value: "gpt-6-luna", display_name: "GPT-6 Luna", effort_levels: ["low"] };
const row = { name: "published-model-row", contentType: "application/json", body: b64(JSON.stringify({ serverId: "test-server", conversationId: "test-channel", model, models: [model] })) };
const annotation = { type: "daemon-revision", description: "0.37.0" };
const attempt = () => ({ status: "passed", duration: 12_000, annotations: [annotation], attachments: [revision, row] });
function withLuna(test: Record<string, unknown>): string {
  const doc = JSON.parse(raw);
  doc.suites.find((s: any) => s.title === "real-claude-codex-channel.spec.ts").specs[0].tests = [test];
  return JSON.stringify(doc);
}
const passing = (results: unknown[] = [attempt()]) => withLuna({ status: "expected", annotations: [annotation], results });

test("Desktop's rule file parses; malformed files are errors, a missing file means no rules", () => {
  assert.equal(parsed.error, null);
  assert.equal(rules.length, 1);
  for (const [text, message] of [
    ["not json", /not JSON/], ["{}", /array of rules/], ['[{"pattern":""}]', /needs a pattern/],
    ['[{"pattern":"("}]', /invalid pattern/], ['[{"pattern":"x","attachment":["typo"]}]', /unknown keys: attachment/],
    ['[{"pattern":"x","json":[{"attachment":"a","equal":{}}]}]', /unknown keys: equal/],
    ['[{"pattern":"x","requireWhenReported":"yes"}]', /true or false/],
    ['[{"pattern":"x","json":[{"attachment":"a","includes":{"p":[1]}}]}]', /plain values/],
  ] as const) assert.match(parseTestEvidenceRules(text).error ?? "", message, text);
  const missing = Object.assign(new Error("absent"), { code: "ENOENT" });
  assert.deepEqual(loadTestEvidenceRules("/agents", () => { throw missing; }), { rules: [], error: null });
  assert.match(loadTestEvidenceRules("/agents", () => "[").error ?? "", new RegExp(TEST_EVIDENCE_FILE));
  assert.deepEqual(loadTestEvidenceRules("/agents", path => { assert.equal(path, `/agents/${TEST_EVIDENCE_FILE}`); return desktopRulesText; }).rules, rules);
});

test("without rules, shared code knows nothing about Luna", () => {
  // The retained #1809 run skipped Luna. With no fork rule and no named
  // requirement the gate judges totals only, as for any other project.
  assert.equal(decide(raw, [], []).verdict, "pass");
  assert.equal(decide(passing([{ ...attempt(), attachments: [] }]), [luna], []).verdict, "pass");
});

test("a reported Luna test is required by Desktop's rule even when no requirement was recorded", () => {
  const verdict = decide(raw, []);
  assert.equal(verdict.verdict, "unusable");
  assert.match(verdict.reason, /Luna.*skipped/);
  assert.equal(decideGateOutcome(verdict.verdict).toColumn, null);
  const doc = JSON.parse(raw);
  doc.suites.find((s: any) => s.title === "real-claude-codex-channel.spec.ts").specs[0].title = "real codex: GPT-6 Luna replies";
  assert.match(decide(JSON.stringify(doc), []).reason, /real codex: GPT-6 Luna replies skipped/);
});

test("Luna needs the daemon revision and the published model row on the passing attempt", () => {
  assert.equal(decide(passing()).verdict, "pass");
  for (const incomplete of [
    { ...attempt(), attachments: [] },
    { ...attempt(), attachments: [revision] },
    { ...attempt(), attachments: [row] },
    { ...attempt(), annotations: [] },
    { ...attempt(), annotations: [{ ...annotation, description: "different-revision" }] },
    { ...attempt(), attachments: [revision, { ...row, body: "" }] },
    { ...attempt(), attachments: [revision, { ...row, body: b64("{}") }] },
    { ...attempt(), attachments: [revision, { ...row, body: b64("not json") }] },
    { ...attempt(), attachments: [revision, { ...row, body: b64(JSON.stringify({ serverId: "s", conversationId: "c", model: { ...model, value: "default" }, models: [{ ...model, value: "default" }] })) }] },
    { ...attempt(), attachments: [revision, { ...row, body: b64(JSON.stringify({ serverId: "s", conversationId: "c", model: { ...model, agent: "claude" }, models: [{ ...model, agent: "claude" }] })) }] },
    { ...attempt(), status: "skipped" },
    { ...attempt(), status: "failed" },
  ]) assert.equal(decide(passing([incomplete])).verdict, "unusable", JSON.stringify(incomplete));
  assert.equal(decide(passing([])).verdict, "unusable");
  assert.match(decide(passing([{ ...attempt(), attachments: [revision] }])).reason, /lacks the published-model-row attachment on passing attempt 1/);
});

test("failed retries and test-level annotations cannot lend proof to a later pass", () => {
  const failed = { ...attempt(), status: "failed" };
  assert.equal(decide(passing([failed, { ...attempt(), annotations: [], attachments: [] }])).verdict, "unusable");
  assert.equal(decide(passing([failed, { ...attempt(), attachments: [row] }])).verdict, "unusable");
  assert.equal(decide(withLuna({ status: "flaky", results: [failed, attempt()] })).verdict, "pass");
});

test("the published row itself must offer Low effort, whatever the selected model says", () => {
  for (const effort_levels of [undefined, [], ["high"]]) {
    const attachment = { ...row, body: b64(JSON.stringify({ serverId: "test-server", conversationId: "test-channel", model, models: [{ ...model, effort_levels }] })) };
    assert.equal(decide(passing([{ ...attempt(), attachments: [revision, attachment] }])).verdict, "unusable", String(effort_levels));
  }
  const extra = { ...row, body: b64(JSON.stringify({ serverId: "s", conversationId: "c", model, models: [{ ...model, order: 3 }, { agent: "claude", value: "opus" }] })) };
  assert.equal(decide(passing([{ ...attempt(), attachments: [revision, extra] }])).verdict, "pass", "extra fields and other rows are fine");
});

test("a genuine Luna failure routes to repair but records that a re-run cannot supply its evidence", () => {
  const failure = decide(withLuna({ status: "unexpected", results: [{ status: "failed" }] }));
  assert.equal(failure.verdict, "fail");
  assert.match(failure.missingLiveAcceptance ?? "", /Luna.*configured live evidence/);
  const plain = decide(withLuna({ status: "unexpected", results: [{ status: "failed" }] }), [luna], []);
  assert.equal(plain.missingLiveAcceptance, undefined, "only a test with configured evidence carries it");
});

test("other projects' tests are untouched by Desktop's rule", () => {
  const go = Array.from({ length: 10 }, (_, i) => JSON.stringify({ Action: "pass", Package: "p", Test: `TestOther${i}` })).join("\n");
  assert.equal(decideGateVerdict({ runError: null, timedOut: false, exitCode: 0, minExecuted: 10, tally: parseGateOutput(go, "go-json"), testEvidence: rules }).verdict, "pass");
});

test("the passing attempt keeps its inline attachments, within the cap", () => {
  const details = parseGateTestDetails(passing(), "playwright-json")!;
  const detail = details.find(d => d.name === luna)!;
  assert.equal(detail.passingAttempt?.daemonRevision, "0.37.0");
  assert.equal(detail.passingAttempt?.attachments?.["daemon-revision"], "0.37.0");
  assert.equal(JSON.parse(detail.passingAttempt!.attachments!["published-model-row"]).model.display_name, "GPT-6 Luna");
  const huge = parseGateTestDetails(passing([{ ...attempt(), attachments: [revision, { ...row, body: b64("x".repeat(70_000)) }] }]), "playwright-json")!;
  assert.equal(huge.find(d => d.name === luna)!.passingAttempt?.attachments?.["published-model-row"], undefined);
});

test("the documentation report applies the rules and names the evidence it saw", () => {
  const report = (output: string) => ({
    outputFormat: "playwright-json" as const, requiredTests: [luna], tally: parseGateOutput(output, "playwright-json"),
    runError: null, timedOut: false, exitCode: 0, command: "playwright test --reporter=json",
    branchName: "feature/1809", headSha: "a".repeat(40), baseRef: "origin/main", baseSha: "b".repeat(40),
    commitsBehind: 0, durationMs: 10, outputPath: "1809.log", outputBytes: output.length,
    baselineFailures: null, baselineSkipReason: null, baselineOutputPath: null,
    rerunFailures: null, rerunSkipReason: null, rerunOutputPath: null,
  });
  const incomplete = passing([{ ...attempt(), attachments: [] }]);
  const missing = liveGateLines({ stamp: "x", raw: incomplete, format: "playwright-json",
    meta: parseGateRunMeta(serializeGateRunMeta(report(incomplete), {}, new Date()))! }, "", rules).join("\n");
  assert.match(missing, /Live acceptance remains missing: required live test .*Luna.* lacks/);
  const valid = liveGateLines({ stamp: "x", raw: passing(), format: "playwright-json",
    meta: parseGateRunMeta(serializeGateRunMeta(report(passing()), {}, new Date()))! }, "", rules).join("\n");
  assert.doesNotMatch(valid, /Live acceptance remains missing/);
  assert.match(valid, /daemon-revision, published-model-row on passing attempt 1/);
  // Without rules, the report does not invent a requirement from a skipped Luna test.
  const legacy = liveGateLines({ stamp: "x", raw, format: "playwright-json", meta: null }, "", []).join("\n");
  assert.doesNotMatch(legacy, /Live acceptance remains missing/);
  assert.match(liveGateLines({ stamp: "x", raw, format: "playwright-json", meta: null }, "", rules).join("\n"), /Live acceptance remains missing: required live test .*Luna.* skipped/);
});
