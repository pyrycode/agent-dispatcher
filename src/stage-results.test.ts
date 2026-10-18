import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore, type StartRequest } from "./fleet-store.js";
import type { WorkflowItem } from "./workflow-store.js";
import { decideStageResult, type StagePlan, type StageSubmission } from "./stage-results.js";
import { retainedStageFiles, declaredStageArtifacts } from "./stage-result-files.js";
import { inheritedMarker } from "./inherited-tickets.js";
import { GATE_PARSER_VERSION, parseGateOutput } from "./gate-output.js";
const project = "org/core", ticket = project + "#3584", sha = "a".repeat(40);
const config = { project, projectId: "P", statusFieldId: "S", options: { Backlog: "b", Inbox: "i", "In Development": "d", "In Code Review": "v", "In Documentation": "doc", Done: "done" } };
const item = (labels: string[] = []): WorkflowItem => ({ id: "P3584", issueId: "I3584", issueNumber: 3584, title: "Review", body: "Required behaviour", url: "https://github.com/org/core/issues/3584", status: "In Code Review", state: "OPEN", revision: 1, position: 1, labels, blockedBy: [], parentNumber: null, grandparentNumber: null });
const plan: StagePlan = { version: 1, kind: "verifier", candidate: sha, checks: ["unit", "types"], artifacts: [] };
const result = (): StageSubmission => ({ version: 1, candidate: sha, checks: plan.checks.map(name => ({ name, outcome: "passed", evidence: "Protected executor: completed with exit zero" })), files: [], pullRequest: 3590, verdict: { commit: sha, decision: "PASS", labels: [], body: "## Verifier Review\nDecision: PASS\nReviewed exact candidate." } });
const run = (id = "review"): StartRequest => ({ workflowVersion: 1, id, machine: "mac", session: "s", project, ticket, role: "verifier", resource: "light", locks: [] });
function fixture(labels: string[] = [], database = ":memory:") {
    const store = new FleetStore(database, { mac: { heavyLimit: 1, combinedLimit: 2 } });
    store.workflow.import(config, [item(labels)]);
    assert.equal(store.start(run()).ok, true);
    store.stagePlan("mac", "s", ticket, "review", plan);
    return store;
}
test("3584: accepted structured verdict advances without reading any GitHub comment", () => {
    const store = fixture();
    try {
        const accepted = store.stageResult("mac", "s", ticket, "review", result());
        assert.equal(accepted.acceptance?.state, "accepted");
        assert.equal(store.workflow.get(ticket).status, "In Documentation");
        assert.equal(store.stages.publications().length, 1, "publication is pending independently of acceptance");
        assert.equal(store.snapshot().runs.length, 1, "acceptance does not claim the process stopped");
        store.finish("mac", "s", "review");
        assert.equal(store.snapshot().runs.length, 0);
        assert.deepEqual(store.stageResult("mac", "s", ticket, "review", result()), accepted, "lost response can be recovered after finish");
        assert.equal(store.stages.publications().length, 1, "retry cannot duplicate publication");
        assert.throws(() => store.stageResult("mac", "s", ticket, "review", { ...result(), candidate: "b".repeat(40) }), /identity reused/);
    }
    finally {
        store.close();
    }
});
test("required live acceptance is centrally selected after verification", () => {
    const store = fixture(["needs-real-claude"]);
    try {
        store.stageResult("mac", "s", ticket, "review", result());
        assert.equal(store.workflow.get(ticket).status, "Inbox");
        assert.ok(store.workflow.get(ticket).labels.includes("done:verifier"));
    }
    finally {
        store.close();
    }
});
test("incomplete checks wait, release worker capacity normally, and cannot become success by exit code", () => {
    const store = fixture();
    try {
        const accepted = store.stageResult("mac", "s", ticket, "review", { ...result(), checks: result().checks.slice(0, 1) });
        assert.equal(accepted.acceptance?.state, "waiting");
        assert.equal(store.workflow.get(ticket).status, "In Code Review");
        assert.ok(store.workflow.get(ticket).labels.includes("held:stage-result"));
        store.finish("mac", "s", "review");
        assert.equal(store.snapshot().runs.length, 0);
        assert.equal(store.stages.publications().length, 0);
    }
    finally {
        store.close();
    }
});
test("current requirements and exact candidate remain mandatory", () => {
    const store = fixture();
    try {
        assert.throws(() => store.stageResult("mac", "s", ticket, "review", { ...result(), candidate: "b".repeat(40) }), /Invalid stage result/);
        store.workflow.change(ticket, { addLabels: ["needs-human:operator-hold"] }, "operator", "hold");
        assert.throws(() => store.stageResult("mac", "s", ticket, "review", result()), /requirements changed/);
        assert.equal(store.stages.get("review")?.result, undefined);
    }
    finally {
        store.close();
    }
});
test("old label and stage writes cannot bypass a contracted result", () => {
    const store = fixture();
    try {
        for (const change of [{ addLabels: ["done:verifier"] }, { status: "In Documentation" }])
            assert.throws(() => store.workflowChange("mac", "s", "review", ticket, change, "bypass"), /structured result/);
        assert.throws(() => store.stageResult("other", "s", ticket, "review", result()), /owner mismatch/);
        store.finish("mac", "s", "review");
        assert.throws(() => store.stageResult("mac", "s", ticket, "review", result()), /finished|ownership|identity reused/);
    }
    finally {
        store.close();
    }
});
test("stage plan cannot change after execution starts, and result survives a database restart", t => {
    const dir = mkdtempSync(join(tmpdir(), "stage-restart-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const db = join(dir, "fleet.sqlite");
    let store = fixture([], db);
    assert.throws(() => store.stagePlan("mac", "s", ticket, "review", { ...plan, checks: [] }), /identity reused/);
    const accepted = store.stageResult("mac", "s", ticket, "review", result());
    store.close();
    store = new FleetStore(db, { mac: { heavyLimit: 1, combinedLimit: 2 } });
    try {
        assert.deepEqual(store.stages.get("review"), accepted);
        assert.equal(store.stages.publications().length, 1);
    }
    finally {
        store.close();
    }
});
function liveResult(): StageSubmission {
    return { version: 1, candidate: sha, files: [], checks: [{ name: "live-acceptance", outcome: "passed", evidence: JSON.stringify({ verdict: "pass", report: { headSha: sha, outputFormat: "go-json", command: "go test -json ./...", runError: null, timedOut: false, exitCode: 0, tally: { parserVersion: GATE_PARSER_VERSION, completeParse: true, recognizedLines: 10, executed: 1, passed: 1, failed: 0, skipped: 0, passedNames: ["pkg.TestCapture"], failedNames: [], skippedTests: [], packageFailed: false, packageFailures: [], timedOutTests: [] }, rerunFailures: null, baselineFailures: null } }) }] };
}
test("3583: general suite success cannot order a commit of absent or undeclared capture files", () => {
    const capture: StagePlan = { version: 1, kind: "live-gate", candidate: sha, checks: ["live-acceptance"], artifacts: ["main/web_search.jsonl"], minExecuted: 1, requiredTests: ["TestCapture"] };
    for (const p of [capture, { ...capture, artifacts: [] }]) {
        const accepted = decideStageResult(p, liveResult(), true);
        assert.equal(accepted.state, "waiting");
        assert.ok(!accepted.change.addLabels?.includes("needs-rework:builder"));
    }
    const accepted = decideStageResult(capture, { ...liveResult(), files: [{ name: "main/web_search.jsonl", text: '{"method":"item/completed"}\n' }] }, true);
    assert.equal(accepted.state, "accepted");
    assert.equal(accepted.change.status, "In Development");
    const skipped = liveResult();
    const evidence = JSON.parse(skipped.checks[0].evidence);
    evidence.report.tally.passedNames = ["pkg.TestUnrelated"];
    skipped.checks[0].evidence = JSON.stringify(evidence);
    assert.equal(decideStageResult(capture, { ...skipped, files: [{ name: "main/web_search.jsonl", text: "capture" }] }, true).state, "waiting", "a file cannot replace execution of the named capture");
});
test("exact capture bytes are retained; missing files, links and undeclared files cannot supply evidence", t => {
    const dir = mkdtempSync(join(tmpdir(), "stage-files-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "main"));
    writeFileSync(join(dir, "main", "capture.jsonl"), '{}\n');
    writeFileSync(join(dir, "main", "unrelated.json"), '{}');
    assert.deepEqual(retainedStageFiles(dir, ["main/capture.jsonl", "main/missing.jsonl"]), [{ name: "main/capture.jsonl", text: '{}\n' }]);
    assert.deepEqual(retainedStageFiles(dir), []);
    symlinkSync(join(dir, "main", "capture.jsonl"), join(dir, "linked.jsonl"));
    assert.throws(() => retainedStageFiles(dir, ["linked.jsonl"]), /links/);
    assert.throws(() => retainedStageFiles(dir, ["../outside"]), /Invalid/);
    assert.deepEqual(declaredStageArtifacts("## Live artifacts\n- `main/capture.jsonl`\n\n## Notes\nOther"), ["main/capture.jsonl"]);
    assert.throws(() => declaredStageArtifacts("## Live artifacts\nCommit any files"), /exact relative/);
});
test("central result and workflow change roll back together when the destination is unavailable", () => {
    const store = fixture();
    try {
        const db = (store as any).db;
        db.exec(`CREATE TRIGGER reject_stage BEFORE UPDATE ON fleet_stage_results BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`);
        assert.throws(() => store.stageResult("mac", "s", ticket, "review", result()), /storage failure/);
        assert.equal(store.workflow.get(ticket).status, "In Code Review");
        assert.equal(store.stages.get("review")?.result, undefined);
        assert.equal(store.stages.publications().length, 0);
    }
    finally {
        store.close();
    }
});
test("HTTP authority verifies the published candidate, preserves exact retries and refuses other actors", async (t) => {
    const { serveFleet, JsonClient } = await import("./fleet-http.js");
    const { GitHubBroker } = await import("./github-broker.js");
    const store = fixture();
    t.after(() => store.close());
    let head = "b".repeat(40);
    const github = new GitHubBroker({ token: "test", projects: [project], fetcher: async (input) => new Response(JSON.stringify(String(input).includes("/pulls/")
            ? { state: "open", head: { sha: head, ref: "feature/3584", repo: { full_name: project } } } : { object: { sha: head } })) });
    const server = await serveFleet(store, { mac: "machine", other: "other-machine" }, "operator", 0, "127.0.0.1", github);
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address() as {
        port: number;
    };
    const connection = new JsonClient(`http://127.0.0.1:${address.port}`, "machine");
    const input = { project, ticket, runId: "review", session: "s", result: result() };
    await assert.rejects(connection.call("/workflow/stage-result", input), /candidate changed/);
    assert.equal(store.stages.get("review")?.result, undefined);
    head = sha;
    const accepted = await connection.call("/workflow/stage-result", input);
    store.finish("mac", "s", "review");
    head = "c".repeat(40);
    assert.deepEqual(await connection.call("/workflow/stage-result", input), accepted, "exact result survives a lost response, finished run and later branch movement");
    await assert.rejects(new JsonClient(`http://127.0.0.1:${address.port}`, "other-machine").call("/workflow/stage-result", input), /owner mismatch/);
    await assert.rejects(new JsonClient(`http://127.0.0.1:${address.port}`, "operator").call("/workflow/stage-result", input), /Machine credential/);
});
test("uncertain PR publication is retried without duplicate comments or changing accepted state", async () => {
    const { WorkflowPublisher } = await import("./workflow-publisher.js");
    const { GitHubBroker } = await import("./github-broker.js");
    const store = fixture();
    try {
        store.stageResult("mac", "s", ticket, "review", result());
        const comments: Array<{
            body: string;
        }> = [];
        let posts = 0;
        const github = new GitHubBroker({ token: "test", projects: [project], fetcher: async (_input, init) => {
                if (init?.method === "POST") {
                    posts++;
                    comments.push(JSON.parse(String(init.body)));
                    throw new Error("Response lost after GitHub stored the comment");
                }
                return new Response(JSON.stringify(comments));
            } });
        await assert.rejects(new WorkflowPublisher(store, github).publishStageResults(), /publication remains pending/);
        assert.equal(store.stages.publications().length, 1);
        await new WorkflowPublisher(store, github).publishStageResults();
        assert.equal(posts, 1);
        assert.equal(store.stages.publications().length, 0);
        assert.equal(store.workflow.get(ticket).status, "In Documentation");
    }
    finally {
        store.close();
    }
});
test("accepted captures use the existing shared evidence path and are not duplicated in workflow records", async () => {
    const { EvidenceStore, DEFAULT_EVIDENCE_LIMITS } = await import("./evidence-store.js");
    const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } });
    const evidence = new EvidenceStore(":memory:", DEFAULT_EVIDENCE_LIMITS, id => store.runOwner(id));
    try {
        store.workflow.import(config, [{ ...item(["needs-live-artifacts", "needs-real-claude"]), status: "Inbox" }]);
        assert.equal(store.start({ ...run("capture"), role: "real-claude-gate" }).ok, true);
        store.stagePlan("mac", "s", ticket, "capture", { version: 1, kind: "live-gate", candidate: sha, checks: ["live-acceptance"], artifacts: ["main/web_search.jsonl"], requiredTests: ["TestCapture"], minExecuted: 1 });
        const accepted = store.stageResult("mac", "s", ticket, "capture", { ...liveResult(), files: [{ name: "main/web_search.jsonl", text: '{"observed":"pair"}\n' }] }, evidence);
        assert.equal(accepted.acceptance?.state, "accepted");
        assert.deepEqual(accepted.result?.files, [], "workflow history stores evidence references");
        const bundle = evidence.list(ticket, accepted.evidence!.runId)[0];
        assert.equal(bundle.manifest.files[0].path, "main/web_search.jsonl");
        const chunk = evidence.read(ticket, bundle.runId, bundle.digest, "main/web_search.jsonl", 0);
        assert.equal(Buffer.from(chunk.data, "base64").toString(), '{"observed":"pair"}\n');
        store.finish("mac", "s", "capture");
        assert.equal(store.snapshot().runs.length, 0);
    }
    finally {
        evidence.close();
        store.close();
    }
});
test("execution completion without a submitted result never implies accepted work", () => {
    const store = fixture();
    try {
        store.finish("mac", "s", "review");
        assert.equal(store.snapshot().runs.length, 0);
        assert.equal(store.stages.get("review")?.acceptance?.state, "waiting");
        assert.ok(store.workflow.get(ticket).labels.includes("held:stage-result"));
        assert.equal(store.workflow.get(ticket).status, "In Code Review");
    }
    finally {
        store.close();
    }
});
test("a lost acceptance response is recovered by immutable identity before executor error handling", async () => {
    const { workflowClient } = await import("./workflow-client.js");
    const store = fixture();
    try {
        const connection = { call: async (path: string, body: any) => {
                if (path === "/workflow/stage-result") {
                    store.stageResult("mac", "s", ticket, "review", body.result);
                    throw new Error("Response lost");
                }
                if (path === "/workflow/stage-read")
                    return { records: store.stages.records(ticket) };
                throw new Error(path);
            } };
        const client = workflowClient({ completeStage: async (_number: number, _result: StageSubmission) => ({}) }, connection as any, project, () => true, () => ({ session: "s", runId: "review" }));
        const accepted: any = await client.completeStage(3584, result());
        assert.equal(accepted.acceptance.state, "accepted");
        assert.throws(() => store.workflowChange("mac", "s", "review", ticket, { addLabels: ["error:verifier"] }, "late-error"), /cannot be overwritten/);
        store.workflow.change(ticket, { addLabels: ["needs-human:operator-hold"] }, "operator", "later-hold");
        assert.deepEqual(store.stageResult("mac", "s", ticket, "review", result()), accepted, "an old receipt remains readable without clearing a later hold");
        assert.ok(store.workflow.get(ticket).labels.includes("needs-human:operator-hold"));
    }
    finally {
        store.close();
    }
});

// Synthetic protocol records exercise central acceptance, not a live execution claim.
for (const named of ["passed", "missing", "skipped"] as const) {
  for (const legacy of [false, true]) {
    test(`central inherited-live marker requires actual named ${named} evidence despite ${legacy ? "pre-upgrade" : "worker-omitted"} plan`, () => {
      const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } });
      try {
        store.workflow.import(config, [{ ...item(["needs-real-claude"]), status: "Inbox", body: inheritedMarker("pkg.TestCapture") }]);
        assert.equal(store.start({ ...run("live"), role: "real-claude-gate" }).ok, true);
        const omitted: StagePlan = { version: 1, kind: "live-gate", candidate: sha, checks: ["live-acceptance"], artifacts: [], requiredTests: [], minExecuted: 1 };
        store.stagePlan("mac", "s", ticket, "live", omitted);
        if (legacy) {
          const record = store.stages.get("live")!;
          delete record.inheritedRequiredTests;
          // A disposable fixture models a frozen record from an old authority.
          (store as any).db.prepare("UPDATE fleet_stage_results SET record=? WHERE run_id='live'").run(JSON.stringify(record));
          assert.deepEqual(store.stagePlan("mac", "s", ticket, "live", omitted), record, "legacy begin retry preserves the frozen record");
          assert.equal(store.stages.get("live")?.inheritedRequiredTests, undefined);
        } else {
          assert.deepEqual(store.stages.get("live")?.inheritedRequiredTests, ["pkg.TestCapture"]);
          assert.deepEqual(store.stages.get("live")?.plan, omitted, "the submitted plan is preserved");
          assert.deepEqual(store.stagePlan("mac", "s", ticket, "live", omitted), store.stages.get("live"), "old worker retry normalizes idempotently");
        }
        const events = [
          { Action: "run", Package: "pkg", Test: "TestUnrelated" }, { Action: "pass", Package: "pkg", Test: "TestUnrelated" },
          ...(named === "missing" ? [] : [{ Action: "run", Package: "pkg", Test: "TestCapture" }, { Action: named === "passed" ? "pass" : "skip", Package: "pkg", Test: "TestCapture" }]),
          { Action: "pass", Package: "pkg" },
        ].map(e => JSON.stringify(e)).join("\n") + "\n";
        const submission = liveResult();
        const evidence = JSON.parse(submission.checks[0].evidence);
        evidence.report.tally = parseGateOutput(events, "go-json");
        submission.checks[0].evidence = JSON.stringify(evidence);
        assert.throws(() => store.stageResult("mac", "s", ticket, "live", { ...submission, candidate: "b".repeat(40) }), /Invalid stage result/);
        assert.equal(store.stages.get("live")?.result, undefined, "wrong candidate cannot retain a result");
        const accepted = store.stageResult("mac", "s", ticket, "live", submission);
        assert.equal(accepted.acceptance?.state, named === "passed" ? "accepted" : "waiting");
        assert.deepEqual(accepted.inheritedRequiredTests, ["pkg.TestCapture"]);
        assert.deepEqual(accepted.plan, omitted, "central enforcement does not rewrite the claimed plan");
        store.workflow.observe(project, [{ ...store.workflow.get(ticket), body: inheritedMarker("pkg.TestNewRequirement") }]);
        assert.deepEqual(store.stageResult("mac", "s", ticket, "live", submission), accepted, "saved exact-result retry is never reinterpreted after ticket edits");
      } finally { store.close(); }
    });
  }
}

test("ordinary verifier plans do not acquire inherited live test requirements", () => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } });
  try {
    store.workflow.import(config, [{ ...item(["needs-real-claude"]), body: inheritedMarker("pkg.TestCapture") }]);
    assert.equal(store.start(run()).ok, true);
    const saved = store.stagePlan("mac", "s", ticket, "review", plan);
    assert.deepEqual(saved.plan, plan);
    assert.equal(store.stageResult("mac", "s", ticket, "review", result()).acceptance?.state, "accepted");
  } finally { store.close(); }
});

test("a changed ticket basis still refuses a legacy live result rather than reinterpreting requirements", () => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } });
  try {
    const original = { ...item(["needs-real-claude"]), status: "Inbox", body: inheritedMarker("pkg.TestCapture") };
    store.workflow.import(config, [original]);
    assert.equal(store.start({ ...run("live"), role: "real-claude-gate" }).ok, true);
    store.stagePlan("mac", "s", ticket, "live", { version: 1, kind: "live-gate", candidate: sha, checks: ["live-acceptance"], artifacts: [] });
    const legacy = store.stages.get("live")!;
    delete legacy.inheritedRequiredTests;
    (store as any).db.prepare("UPDATE fleet_stage_results SET record=? WHERE run_id='live'").run(JSON.stringify(legacy));
    store.workflow.observe(project, [{ ...store.workflow.get(ticket), body: inheritedMarker("pkg.TestOther") }]);
    assert.throws(() => store.stageResult("mac", "s", ticket, "live", liveResult()), /requirements changed/);
    assert.equal(store.stages.get("live")?.result, undefined);
  } finally { store.close(); }
});

test("live plans without inherited markers preserve their existing requirements and acceptance", () => {
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 2 } });
  try {
    store.workflow.import(config, [{ ...item(["needs-real-claude"]), status: "Inbox" }]);
    assert.equal(store.start({ ...run("live"), role: "real-claude-gate" }).ok, true);
    const declared: StagePlan = { version: 1, kind: "live-gate", candidate: sha, checks: ["live-acceptance"], artifacts: [], requiredTests: ["pkg.TestCapture"] };
    const saved = store.stagePlan("mac", "s", ticket, "live", declared);
    assert.deepEqual(saved.plan, declared);
    assert.equal(saved.inheritedRequiredTests, undefined);
    assert.equal(store.stageResult("mac", "s", ticket, "live", liveResult()).acceptance?.state, "accepted");
  } finally { store.close(); }
});
