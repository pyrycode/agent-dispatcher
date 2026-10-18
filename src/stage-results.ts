import { decideGateVerdict, decideBaselineAdjustedVerdict, decideInheritedAdvance } from "./pipeline-decisions.js";
import { gateRunFloor, type GateRunReport } from "./gate-output.js";
import type { TestEvidenceRule } from "./gate-test-evidence.js";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WorkflowItem, WorkflowChange } from "./workflow-store.js";
import { parseVerdictHandoff, type VerdictHandoff } from "./verdict-handoff.js";
/** Requirements are frozen before execution. Results and display publication are independent. */
export interface StagePlan {
    version: 1;
    kind: "verifier" | "live-gate";
    candidate: string;
    checks: string[];
    artifacts: string[];
    requiredTests?: string[];
    minExecuted?: number;
    testEvidence?: TestEvidenceRule[];
    inheritedAdvance?: boolean;
}
export interface StageCheck {
    name: string;
    outcome: "passed" | "failed" | "unavailable";
    evidence: string;
}
export interface StageFile {
    name: string;
    text: string;
}
export interface StageSubmission {
    version: 1;
    candidate: string;
    checks: StageCheck[];
    files: StageFile[];
    verdict?: VerdictHandoff;
    pullRequest?: number;
}
export interface StageAcceptance {
    state: "accepted" | "waiting" | "rework";
    reason: string;
    change: WorkflowChange;
}
export interface StageRecord {
    ticket: string;
    runId: string;
    basis: string;
    artifactsRequired: boolean;
    liveGateRequired: boolean;
    plan: StagePlan;
    result?: StageSubmission;
    submissionHash?: string;
    evidence?: {
        runId: string;
        digest: string;
    };
    acceptance?: StageAcceptance;
}
/** Only semantic requirements, dependencies and operator holds invalidate a run, not its own wip labels. */
export function stageBasis(item: WorkflowItem): string {
    return createHash("sha256").update(JSON.stringify([item.body, item.state, item.status, item.labels.includes("needs-live-artifacts"), item.labels.includes("needs-real-claude"),
        item.blockedBy.map(b => [b.url, b.number, b.state]).sort(),
        item.labels.filter(l => /^(requires:|needs-human:|held:)/.test(l) && l !== "needs-human:sizing").sort(),
    ])).digest("hex");
}
function words(value: unknown): value is string[] {
    return Array.isArray(value) && value.length <= 100 && value.every(s => typeof s === "string" && s.length > 0 && s.length <= 4000) && new Set(value).size === value.length;
}
function path(name: string): boolean { return /^[\w./-]+$/.test(name) && !name.startsWith("/") && !name.split("/").some(s => !s || s === "." || s === ".."); }
export function validateStagePlan(plan: StagePlan): void {
    if (!plan || JSON.stringify(plan).length > 128 * 1024 || plan.version !== 1 || !["verifier", "live-gate"].includes(plan.kind) || !/^[a-f0-9]{40}$/.test(plan.candidate)
        || !words(plan.checks) || !words(plan.artifacts) || plan.artifacts.some(n => !path(n))
        || plan.requiredTests !== undefined && !words(plan.requiredTests)
        || plan.minExecuted !== undefined && (!Number.isSafeInteger(plan.minExecuted) || plan.minExecuted < 1))
        throw new Error("Invalid stage plan");
}
export function decideStageResult(plan: StagePlan, result: StageSubmission, artifactsRequired: boolean, liveGateRequired = false): StageAcceptance {
    validateStagePlan(plan);
    if (!result || result.version !== 1 || result.candidate !== plan.candidate || !Array.isArray(result.checks) || !Array.isArray(result.files)
        || JSON.stringify(result).length > 1024 * 1024 || result.checks.length > 100 || result.files.length > 100)
        throw new Error("Invalid stage result");
    if (new Set(result.checks.map(c => c.name)).size !== result.checks.length || new Set(result.files.map(f => f.name)).size !== result.files.length
        || result.checks.some(c => !plan.checks.includes(c.name) || !["passed", "failed", "unavailable"].includes(c.outcome) || typeof c.evidence !== "string" || !c.evidence.trim())
        || result.files.some(f => !path(f.name) || typeof f.text !== "string" || !f.text.trim()))
        throw new Error("Invalid stage evidence");
    const waiting = (reason: string): StageAcceptance => ({ state: "waiting", reason, change: { addLabels: ["held:stage-result"], removeLabels: ["done:verifier"] } });
    const missing = plan.checks.filter(n => !result.checks.some(c => c.name === n && c.outcome === "passed"));
    if (plan.kind === "verifier") {
        const v = result.verdict;
        const parsed = v && parseVerdictHandoff(`decision: ${v.decision}\ncommit: ${v.commit}\nlabels: ${v.labels?.join(" ")}\n---\n${v.body}`);
        if (!parsed || !parsed.ok || parsed.handoff.commit !== plan.candidate || !Number.isSafeInteger(result.pullRequest) || result.pullRequest! < 1)
            return waiting("A complete verdict for the exact candidate is required");
        if (v!.decision === "FAIL")
            return { state: "rework", reason: "Verifier requested rework", change: { addLabels: v!.labels, removeLabels: ["done:verifier", "held:stage-result"] } };
        if (missing.length)
            return waiting(`Required checks incomplete: ${missing.join(", ")}`);
        return { state: "accepted", reason: "Checks and exact-candidate verdict accepted", change: { status: liveGateRequired ? "Inbox" : "In Documentation", addLabels: ["done:verifier"], removeLabels: ["held:stage-result", "error:verifier", "pending-verdict:verifier"] } };
    }
    if (missing.length)
        return waiting(`Required checks incomplete: ${missing.join(", ")}`);
    const receipt = JSON.parse(result.checks.find(c => c.name === "live-acceptance")?.evidence ?? "null") as {
        report: GateRunReport;
        verdict: string;
        acceptedInherited?: Array<{
            name: string;
            issue: number;
        }>;
    } | null;
    if (!receipt?.report || receipt.report.headSha !== plan.candidate)
        return waiting("Live test evidence must identify the exact candidate");
    const report = receipt.report;
    const raw = decideGateVerdict({ ...report, minExecuted: gateRunFloor(report, plan.minExecuted ?? 1), requiredTests: plan.requiredTests ?? [], testEvidence: plan.testEvidence ?? [] });
    const adjusted = decideBaselineAdjustedVerdict({ verdict: raw.verdict, reason: raw.reason, branchFailures: report.tally?.failedNames ?? [], baselineFailures: report.baselineFailures, rerunFailures: report.rerunFailures });
    if (!["pass", "flaky-pass"].includes(adjusted.verdict)) {
        const inherited = decideInheritedAdvance({ enabled: plan.inheritedAdvance === true, adjusted, raw, tally: report.tally, format: report.outputFormat, rerunFailures: report.rerunFailures, baselineFailures: report.baselineFailures, requiredTests: plan.requiredTests ?? [], testEvidence: plan.testEvidence ?? [] });
        if (!inherited.eligible || adjusted.preExisting.some(name => !receipt.acceptedInherited?.some(t => t.name === name)))
            return waiting(`Live acceptance remains incomplete: ${raw.reason}`);
    }
    if (artifactsRequired && plan.artifacts.length === 0)
        return waiting("Required capture outputs have not been declared in the stage plan");
    const absent = plan.artifacts.filter(n => !result.files.some(f => f.name === n));
    if (absent.length)
        return waiting(`Required capture outputs missing: ${absent.join(", ")}`);
    return { state: "accepted", reason: "Required checks and capture outputs accepted", change: artifactsRequired
            ? { status: "In Development", addLabels: ["needs-rework:builder"], removeLabels: ["held:stage-result"] }
            : { status: "In Documentation", removeLabels: ["held:stage-result", "needs-real-claude", "done:verifier"] } };
}
/** The same database transaction stores the result and its workflow change. */
export class StageResults {
    constructor(private readonly db: DatabaseSync) {
        db.exec(`CREATE TABLE IF NOT EXISTS fleet_stage_results (run_id TEXT PRIMARY KEY, ticket TEXT NOT NULL, record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_stage_publications (run_id TEXT PRIMARY KEY, ticket TEXT NOT NULL, pr INTEGER NOT NULL, body TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0) STRICT`);
    }
    get(runId: string): StageRecord | undefined {
        const row = this.db.prepare("SELECT record FROM fleet_stage_results WHERE run_id=?").get(runId);
        return row ? JSON.parse(String(row.record)) : undefined;
    }
    begin(ticket: string, runId: string, item: WorkflowItem, plan: StagePlan): StageRecord {
        validateStagePlan(plan);
        const record: StageRecord = { ticket, runId, basis: stageBasis(item), artifactsRequired: item.labels.includes("needs-live-artifacts"), liveGateRequired: item.labels.includes("needs-real-claude"), plan };
        const old = this.get(runId);
        if (old) {
            if (JSON.stringify({ ...old, result: undefined, submissionHash: undefined, evidence: undefined, acceptance: undefined }) !== JSON.stringify(record))
                throw new Error("Stage plan identity reused with different requirements");
            return old;
        }
        this.db.prepare("INSERT INTO fleet_stage_results VALUES (?,?,?)").run(runId, ticket, JSON.stringify(record));
        return record;
    }
    complete(runId: string, item: WorkflowItem, result: StageSubmission, apply: (change: WorkflowChange) => void, retain?: (files: StageFile[]) => {
        runId: string;
        digest: string;
    }): StageRecord {
        const old = this.get(runId);
        if (!old)
            throw new Error("Stage requirements must be recorded before execution");
        if (old.result) {
            if (old.submissionHash !== createHash("sha256").update(JSON.stringify(result)).digest("hex"))
                throw new Error("Stage result identity reused with different evidence");
            return old;
        }
        if (old.basis !== stageBasis(item))
            throw new Error("Stage requirements changed during execution");
        const pass = result.verdict?.decision !== "FAIL";
        if (pass && (item.blockedBy.some(b => b.state === "OPEN") || item.labels.some(l => /^(error:|needs-rework:|held:|needs-human:)/.test(l) && l !== "needs-human:sizing")))
            throw new Error("Current stage holds forbid acceptance");
        const acceptance = decideStageResult(old.plan, result, old.artifactsRequired, old.liveGateRequired);
        if (result.files.length && !retain)
            throw new Error("Durable shared evidence storage is required for capture acceptance");
        const evidence = result.files.length ? retain!(result.files) : undefined;
        const record: StageRecord = { ...old, result: { ...result, files: [] }, submissionHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"), ...(evidence ? { evidence } : {}), acceptance };
        apply(acceptance.change);
        this.db.prepare("UPDATE fleet_stage_results SET record=? WHERE run_id=?").run(JSON.stringify(record), runId);
        if (old.plan.kind === "verifier" && result.verdict && acceptance.state !== "waiting") {
            this.db.prepare("INSERT INTO fleet_stage_publications (run_id,ticket,pr,body) VALUES (?,?,?,?)").run(runId, old.ticket, result.pullRequest!, result.verdict.body);
        }
        return record;
    }
    endWithoutResult(runId: string, item: WorkflowItem, apply: (change: WorkflowChange) => void): void {
        const record = this.get(runId);
        if (!record || record.result)
            return;
        const result: StageSubmission = { version: 1, candidate: record.plan.candidate, checks: [], files: [] };
        const routed = item.labels.some(l => /^(error:|needs-rework:|held:)/.test(l));
        const acceptance: StageAcceptance = { state: "waiting", reason: "Execution ended without a complete accepted stage result", change: routed ? {} : { addLabels: ["held:stage-result"], removeLabels: ["done:verifier"] } };
        apply(acceptance.change);
        this.db.prepare("UPDATE fleet_stage_results SET record=? WHERE run_id=?").run(JSON.stringify({ ...record, result, acceptance, submissionHash: createHash("sha256").update(JSON.stringify(result)).digest("hex") }), runId);
    }
    records(ticket: string): StageRecord[] {
        const records: StageRecord[] = [];
        let bytes = 0;
        for (const row of this.db.prepare("SELECT record FROM fleet_stage_results WHERE ticket=? ORDER BY rowid DESC LIMIT 5").all(ticket)) {
            bytes += Buffer.byteLength(String(row.record));
            if (bytes > 1536 * 1024)
                break;
            records.push(JSON.parse(String(row.record)));
        }
        return records;
    }
    summaries(project: string): Array<{
        ticket: string;
        runId: string;
        state: string;
        reason: string;
        candidate: string;
    }> {
        return this.db.prepare("SELECT record FROM fleet_stage_results WHERE ticket LIKE ? ORDER BY rowid DESC LIMIT 100").all(project + "#%").map(row => {
            const r = JSON.parse(String(row.record)) as StageRecord;
            return { ticket: r.ticket, runId: r.runId, state: r.acceptance?.state ?? "planned", reason: r.acceptance?.reason ?? "Execution pending", candidate: r.plan.candidate };
        });
    }
    publications(): Array<{
        runId: string;
        ticket: string;
        pr: number;
        body: string;
    }> {
        return this.db.prepare("SELECT * FROM fleet_stage_publications WHERE published=0 LIMIT 20").all().map(r => ({ runId: String(r.run_id), ticket: String(r.ticket), pr: Number(r.pr), body: String(r.body) }));
    }
    published(runId: string): void { this.db.prepare("UPDATE fleet_stage_publications SET published=1 WHERE run_id=?").run(runId); }
}
