import {guardPinnedPublication,PublishedCandidateChanged} from './verifier-handoff-publication.js';
import {WorkflowGitHub} from "./workflow-github.js";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { chmodSync } from "node:fs";
import type { GitHubBroker, GitHubRequest, GitHubResponse } from "./github-broker.js";
import {publishRepair} from "./recovery-repair-publication.js";
import {loadRepairBase,RepairBaseUnavailable,RepairRefusal} from "./recovery-source-publication.js";
import { OwnershipRefusal, type Claim, type FleetStore, type FleetSnapshot, type StartRequest, type StartResult } from "./fleet-store.js";
import type { EvidenceStore } from "./evidence-store.js";

/** A non-2xx answer from the claim service or machine manager. The message format is unchanged. */
export class ServiceError extends Error {
  constructor(readonly status: number, readonly body: unknown, text: string) {
    super(`Service ${status}: ${text.slice(0, 500)}`);
    this.name = "ServiceError";
  }
}
/** The marked body of an ownership refusal (409), relayed unchanged by the manager and bridge. */
export interface OwnershipRefusalBody { error: string; refused: "ownership" }
/**
 * The refusal carried by `error`, or undefined. Only the claim service's
 * explicit marker counts: the generic 409 catch-all, a transport failure, and
 * any GitHub status are never treated as a refusal.
 */
export function ownershipRefusal(error: unknown): OwnershipRefusalBody | undefined {
  if (!(error instanceof ServiceError) || error.status !== 409) return undefined;
  const body = error.body as Partial<OwnershipRefusalBody> | null;
  return body && typeof body === "object" && body.refused === "ownership" && typeof body.error === "string"
    ? { error: body.error, refused: "ownership" } : undefined;
}

/**
 * The service, or the machine manager in front of it, does not know this
 * operation: it predates it. A manager relays a newer route to an older
 * claim service as a 409 that carries the service's 404.
 */
export function unknownOperation(error: unknown): boolean {
  if (!(error instanceof ServiceError)) return false;
  if (error.status === 404) return true;
  const text = typeof (error.body as any)?.error === "string" ? (error.body as any).error : "";
  return error.status === 409 && /Unknown operation|Service 404/.test(text);
}

export async function readJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function tokenMatches(header: string | undefined, secret: string): boolean {
  const a = Buffer.from(header ?? ""), b = Buffer.from(`Bearer ${secret}`);
  return secret.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
export async function listen(server: Server, port: number | string, host = "127.0.0.1"): Promise<Server> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const ready = () => { server.removeListener("error", reject); resolve(); };
    if (typeof port === "string") server.listen(port, ready);
    else server.listen(port, host, ready);
  });
  if (typeof port === "string") chmodSync(port, 0o600);
  return server;
}
export async function serveFleet(store: FleetStore, machines: Record<string, string>, admin: string, port: number, host = "127.0.0.1", github?: GitHubBroker, desired?: () => unknown, repairRepository?: string, repairConsumers?: Record<string,string>, controlRevision?: string, evidence?: EvidenceStore): Promise<Server> {
  const secrets = [...Object.values(machines), admin];
  if (secrets.some(s => !s) || new Set(secrets).size !== secrets.length) throw new Error("Fleet credentials must be non-empty and distinct");
  const workflowGitHub=github?new WorkflowGitHub(store,github):undefined;
  const repairWrites=new Map<string,Promise<unknown>>();
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const isAdmin = tokenMatches(req.headers.authorization, admin);
    const machine = Object.keys(machines).find(m => tokenMatches(req.headers.authorization, machines[m]));
    if (!isAdmin && !machine) return send(401, { error: "Authentication required" });
    try {
      if (req.method === "GET" && req.url === "/operations/desired") return send(200, desired?.() ?? {});
      if (req.method === "GET" && req.url === "/operations/control") return send(200,{desired:store.controlTarget(),centralLoaded:controlRevision});
      if (req.method === "GET" && req.url === "/operations/reports") return send(200, store.operations.list());
      // Desired against observed for every computer and board, with acknowledgements.
      if (req.method === "GET" && req.url === "/desired") return send(200, { machines: store.desired.report(store.operations.list()), attention: store.desired.attention(store.operations.list()) });
      if (req.method === "GET" && req.url === "/tasks/orphaned") return send(200, store.orphans.list());
      if (req.method === "GET" && req.url === "/state") return send(200, {...store.snapshot(), features:{recoveryTasks:true,...(evidence?{evidence:true}:{})},requiredRepairs:store.requiredRepairs(),openTaskTickets:store.openTaskTickets(),...(evidence?{evidenceStore:evidence.cachedUsage()}:{})});
      if (req.method === "GET" && req.url === "/runner") return send(200, store.runnerPolicy() ?? null);
      if (req.method === "GET" && req.url === "/codex") return send(200, { pause: store.codex.state(), spacing: store.codex.spacingState(), config: store.codex.config, events: store.codex.events(), recentStarts: store.codex.starts() });
      if (req.method === "GET" && req.url === "/recovery/state") return send(200, store.recovery.list());
      if (req.method === "GET" && req.url === "/github/status" && isAdmin) return send(200, github?.status() ?? { enabled: false });
      if (req.method !== "POST") return send(404, { error: "Unknown operation" });
      const body = await readJson(req, req.url?.startsWith("/workflow/") ? 32*1024*1024 : req.url?.startsWith("/tasks/") ? 8*1024*1024 : 1024*1024);
      if (req.url === '/machine-recovery/release') {
        if (!machine && !isAdmin) return send(403,{error:'Source supervisor credential required'});
        return send(200,store.recoverStoppedWorker(machine ?? body.machine,body));
      }
      if (req.url === '/machine-recovery/clear') {
        if (!isAdmin) return send(403,{error:'Operator credential required'});
        store.clearMachineRecoveries(body.machine,body.project,body.ids);
        return send(200,{ok:true});
      }
      if (req.url === '/machine-recovery/read') return send(200,store.machineRecoveries.list());
      if(req.url?.startsWith('/storage/')) {
        if(!isAdmin)return send(403,{error:'Protected operator credential required'});
        if(req.url==='/storage/list')return send(200,store.storage.active());
        if(req.url==='/storage/acquire')return send(200,store.acquireStorage(body));
        if(req.url==='/storage/attest')return send(200,store.attestStorage(body));
        if(req.url==='/storage/verify')return send(200,store.verifyStorage(body.id,body.machine));
        if(req.url==='/storage/finish')return send(200,store.finishStorage(body.id,body.machine,body.drained,body.result));
        if(req.url==='/storage/cancel')return send(200,store.cancelStorage(body.request,body.drained));
        return send(404,{error:'Unknown storage operation'});
      }
      // Shared run evidence (evidence-store.ts). Any fleet credential reads;
      // only the computer that ran a run uploads its bundle. A service without
      // the store answers like one that predates it.
      if(req.url?.startsWith('/verification-handoff/')) {
        if(req.url==='/verification-handoff/confirm') {
          if(!machine) return send(403,{error:'Machine credential required'});
          return send(200,store.confirmVerifierHandoff(machine,body.id,body.session,body.target,evidence));
        }
        if(!isAdmin)return send(403,{error:'Operator credential required'});
        if(req.url==='/verification-handoff/request')return send(200,store.requestVerifierHandoff(body));
        if(req.url==='/verification-handoff/cancel')return send(200,store.cancelVerifierHandoff(body.id));
        if(req.url==='/verification-handoff/read')return send(200,store.verifierHandoffs.get(body.id));
        return send(404,{error:'Unknown handoff operation'});
      }
      if(req.url?.startsWith('/evidence/')) {
        if(!evidence) return send(404,{error:'Unknown operation'});
        if(req.url==='/evidence/usage') return send(200,evidence.usage());
        if(req.url==='/evidence/list') return send(200,{bundles:evidence.list(body.ticket,body.runId)});
        if(req.url==='/evidence/chunk') return send(200,evidence.read(body.ticket,body.runId,body.digest,body.path,body.part));
        if(!machine) return send(403,{error:'Machine credential required'});
        const project=typeof body.project==='string'?body.project:undefined;
        if(req.url==='/evidence/begin') return send(200,evidence.begin(machine,project,body.ticket,body.runId,body.meta,body.manifest));
        if(req.url==='/evidence/put') {evidence.put(machine,project,body.ticket,body.runId,body.digest,body.path,body.part,body.data);return send(200,{ok:true});}
        if(req.url==='/evidence/commit') return send(200,evidence.commit(machine,project,body.ticket,body.runId,body.digest));
        return send(404,{error:'Unknown operation'});
      }
      if(req.url==='/operations/control-ready') {
        const actor=isAdmin?body.machine:machine;
        if(!actor) return send(403,{error:'Control worker required'});
        store.recordControlReady(actor,body.revision);return send(200,{ok:true});
      }
      if(req.url==='/operations/control-target') {
        if(!isAdmin)return send(403,{error:'Operator credential required'});
        if(!github || !repairRepository || !/^[a-f0-9]{40}$/.test(body.revision??'') || Object.keys(body).some(k=>k!=='revision')) throw new Error('Exact upstream controller revision required');
        const response=await github.request(repairRepository,{method:'GET',path:`/repos/${repairRepository}/compare/${body.revision}...main`,fresh:true});
        if(response.status!==200)throw new Error('Cannot verify the controller revision on upstream main');
        const comparison=JSON.parse(response.body);
        if(!['ahead','identical'].includes(comparison.status) || comparison.merge_base_commit?.sha!==body.revision)throw new Error('Controller revision must belong to upstream main');
        store.controlTarget(body.revision);return send(200,{desired:body.revision});
      }
      if (req.url === '/runner') {
        if (!isAdmin) return send(403, { error: 'Operator credential required' });
        return send(200, store.setRunner(body.runner));
      }
      if (req.url === '/codex/report') {
        if (!machine) return send(403, { error: 'Machine credential required' });
        return send(200, store.codexReport(machine, body.session, body.project, body.runId, body.event));
      }
      if (req.url === '/codex/clear') {
        if (!isAdmin) return send(403, { error: 'Operator credential required' });
        return send(200, store.clearCodexPause());
      }
      if (req.url === '/operations/report') {
        if (!isAdmin && body.machine !== machine) return send(403, {error:'Machine identity mismatch'});
        store.operations.record(isAdmin ? body.machine : machine!, body.report);
        // Starts the orphan clock between operator reads. A failure here must never refuse the report.
        try { store.orphans.observe(); } catch { /* observed again on the next report */ }
        return send(200, {ok:true});
      }
      // A manager's fetch of its own desired state, carrying what it has applied.
      // The machine credential names the computer, so it reads only its own.
      if (req.url === '/machines/desired') {
        if (!machine) return send(403, { error: 'Machine credential required' });
        return send(200, store.desiredPoll(machine, body));
      }
      // The operator's drain, resume, stop and start. Nothing else can be set.
      if (req.url === '/desired/set') {
        if (!isAdmin) return send(403, { error: 'Operator credential required' });
        return send(200, store.setDesired(body));
      }
      if (req.url === '/machines/capabilities') {
        const actor = isAdmin ? body.machine : machine;
        if (!actor || !Object.hasOwn(machines, actor)) return send(403,{error:'Unknown capability owner'});
        return send(200, store.reportMachineCapabilities(actor, body.capabilities, body.projects));
      }
      if (req.url === '/tasks/capabilities') {
        const actor = isAdmin ? body.machine : machine;
        if (!actor || !Object.hasOwn(machines, actor)) return send(403,{error:'Unknown capability owner'});
        store.tasks.report(actor,body.record); return send(200,{ok:true});
      }
      if(req.url==='/tasks/active') {
        const actor=isAdmin?body.machine:machine;
        return send(200,store.tasks.list().filter(t=>t.machine===actor&&t.session===body.session&&t.state==='running'));
      }
      if (req.url === '/tasks/queue') {
        const actor = isAdmin ? body.machine : machine;
        if (!actor) return send(403,{error:'Task worker required'});
        return send(200,store.tasks.list().filter(t => store.tasks.available(actor,t.id)));
      }
      if (req.url === '/tasks/uncertain') {
        const actor=isAdmin?body.machine:machine;
        if(!actor || typeof body.reason!=='string' || body.reason.length>2000) return send(403,{error:'Task owner required'});
        store.tasks.uncertain(body.id,actor,body.session,body.reason);return send(200,{ok:true});
      }
      if (req.url === '/tasks/start' || req.url === '/tasks/complete') {
        const actor = isAdmin ? body.machine : machine;
        if (!actor) return send(403,{error:'Task worker required'});
        // A publication write still running here may merge. Failing its task
        // now would release the place and discard a repair that is landing.
        if(req.url === '/tasks/complete' && body.result?.outcome === 'failed' && repairWrites.has(body.id)) return send(409,{error:'Repair publication in progress'});
        return send(200,req.url === '/tasks/start' ? store.taskStart(actor,body.id,body.session)
          : store.taskComplete(actor,body.id,body.session,body.result,body.expectStates));
      }
      if (req.url === '/tasks/request') {
        if (!machine) return send(403,{error:'Admitted source worker required'});
        return send(200,store.requestTask(machine,body.session,body.project,body.runId,body.request));
      }
      if(req.url==='/tasks/investigate') {
        if(!machine) return send(403,{error:'Admitted source worker required'});
        return send(200,store.requestInvestigation(machine,body.session,body.project,body.runId,body.request,evidence));
      }
      if (req.url === '/tasks/read') {
        if (!machine) return send(403,{error:'Admitted source worker required'});
        return send(200,store.readTask(machine,body.session,body.project,body.runId,body.id,body.format));
      }
      if(req.url==='/tasks/artifact') {
        if(!machine) return send(403,{error:'Admitted source worker required'});
        return send(200,store.readTaskArtifact(machine,body.session,body.project,body.runId,body.id,body.digest,body.path,body.part));
      }
      if(['/tasks/artifacts-begin','/tasks/artifacts-put','/tasks/artifacts-commit'].includes(req.url??'')) {
        const actor=isAdmin?body.machine:machine;
        if(!actor) return send(403,{error:'Task worker required'});
        if(req.url==='/tasks/artifacts-begin') return send(200,store.tasks.beginArtifacts(body.id,actor,body.session,body.manifest));
        if(req.url==='/tasks/artifacts-put') {
          store.tasks.putArtifact(body.id,actor,body.session,body.digest,body.path,body.part,body.data);return send(200,{ok:true});
        }
        const task=store.commitTaskArtifacts(actor,body.id,body.session,body.digest,body.result);
        return send(200,{...task,result:task.result?{...task.result,files:{}}:null});
      }
      if(req.url==='/tasks/prepare-repair') {
        if(!isAdmin&&!machine) return send(403,{error:'Configured repair executor required'});
        const actor=isAdmin?body.machine:machine!;
        // Credential shapes are judged on the lines the repair changes, so read
        // the base it was built on. Without GitHub every line counts as new.
        let base:Record<string,string|null>|undefined;
        let task;try{task=typeof body.id==='string'?store.tasks.get(body.id):undefined;}catch{task=undefined;}
        const files=body.publication?.files;
        if(github&&repairRepository&&task&&task.machine===actor&&task.session===body.session&&['running','attention'].includes(task.state)
          &&task.request.recipe==='dispatcher-repair'&&task.request.revision&&files&&typeof files==='object'&&!Array.isArray(files)&&Object.keys(files).length<=100)
          base=await loadRepairBase(github,repairRepository,task.request.revision,Object.keys(files));
        return send(200,store.prepareRepair(actor,body.id,body.session,body.publication,base));
      }
      if (req.url === '/tasks/publish-repair') {
        if ((!isAdmin&&!machine) || !github || !repairRepository) return send(403,{error:'Configured repair authority required'});
        const task=store.tasks.get(body.id);
        if(task.machine!==(isAdmin?body.machine:machine) || task.session!==body.session) return send(403,{error:'Task actor mismatch'});
        // Only a prepared repair publishes, so every published byte passed the source scan.
        if(task.state!=='publishing') return send(409,{error:'Repair must be prepared before publication'});
        let work=repairWrites.get(task.id);
        if(!work) {
          work=publishRepair(github,repairRepository,task,body.publication,repairConsumers,sha=>{store.controlTarget(sha);return store.controlsReady(sha,controlRevision);}).finally(()=>repairWrites.delete(task.id));
          repairWrites.set(task.id,work);
        }
        return send(200,await work);
      }
      if (req.url === '/tasks/cancel-queued') {
        if (!isAdmin) return send(403,{error:'Operator credential required'});
        return send(200,store.cancelQueuedTask(body.id,body.reason));
      }
      if (req.url === '/tasks/operator-request') {
        if (!isAdmin) return send(403,{error:'Operator credential required'});
        if (!/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(body.ticket)) throw new Error('Invalid source ticket');
        return send(200,store.tasks.request(body.ticket,body.request));
      }
      if (req.url === "/recovery/facts") return send(200, store.recoveryFacts(body.tickets,
        machine && body.runId ? {machine,session:body.session,project:body.project,runId:body.runId} : undefined));
      if (req.url === "/recovery/evidence") {
        if (!machine) return send(403, { error: "Machine credential required" });
        return send(200, store.recordEvidence(machine, body.project, body.records));
      }
      if (req.url === "/recovery/pause" || req.url === "/recovery/coordination") {
        if (!machine) return send(403, { error: "Machine credential required" });
        return send(200, req.url === "/recovery/pause"
          ? store.recordPause(machine, body.session, body.project, body.runId, body.record)
          : store.recordCoordination(machine, body.session, body.project, body.runId, body.record));
      }
      if (req.url === "/recovery/operator-coordination") {
        if (!isAdmin) return send(403, { error: "Operator credential required" });
        store.facts.coordinate(body.record); return send(200, { ok: true });
      }
      if (req.url === "/recovery/operator-pause") {
        if (!isAdmin) return send(403, { error: "Operator credential required" });
        store.facts.pause({ ...body.record, origin: "operator" }); return send(200, { ok: true });
      }
      if (req.url === "/recovery/report") {
        if (!machine) return send(403, { error: "Machine credential required" });
        return send(200, store.recoveryReport(machine, body.project, body.observations));
      }
      if (req.url === "/recovery/split") {
        if (!workflowGitHub || !evidence) throw new Error("Recovery split requires protected workflow and retained evidence stores");
        if (!isAdmin && !machine) return send(403,{error:"Recovery actor or operator required"});
        if (typeof body.id !== 'string' || Object.keys(body).some(k=>!['id','project','session','runId'].includes(k))) throw new Error('Recovery split accepts a retained incident identity, never a replacement plan');
        if (body.project && store.recovery.incident(body.id).ticket.split('#')[0] !== body.project) throw new Error('Recovery split project mismatch');
        const actor = isAdmin ? undefined : {machine:machine!,session:body.session,runId:body.runId};
        return send(200,await workflowGitHub.recoverySplit(body.id,evidence,actor));
      }
      if (["/recovery/begin", "/recovery/decide", "/recovery/complete"].includes(req.url ?? "")) {
        if (!machine) return send(403, { error: "Machine credential required" });
        return send(200, store.recoveryStep(machine, body.session, body.project, body.id, body.runId,
          req.url!.split("/")[2] as "begin" | "decide" | "complete", body.decision));
      }
      // Flaky-test sightings and tracker writes (flaky-sightings.ts). An older
      // service answers "Unknown operation", and the dispatcher then keeps the
      // sighting on its own disk and files nothing on a first sighting.
      if (req.url === "/flaky/sightings") {
        if (!machine) return send(403, { error: "Machine credential required" });
        return send(200, store.flakySightings(machine, body.project, body.sightings));
      }
      if (req.url === "/flaky/track") {
        if (!machine) return send(403, { error: "Machine credential required" });
        return send(200, store.flakyTrack(machine, body.session, body.project, body));
      }
      if (req.url?.startsWith('/workflow/')) {
        const project=body.project;
        if(typeof project!=='string' || !/^[\w.-]+\/[\w.-]+$/.test(project)) throw new Error('Workflow project required');
        if(req.url==='/workflow/read') return send(200,{enabled:store.workflow.enabled(project),preparing:store.workflow.preparing(project),config:store.workflow.config(project),items:store.workflow.list(project).map(item=>({...item,approvalState:store.approvals.get(`${project}#${item.issueNumber}`)})),stageResults:store.stages.summaries(project),pending:store.workflow.pending(10000,project).length});
        if(req.url==='/workflow/stage-read') {if(body.ticket?.split('#')[0]!==project)throw new Error('Workflow project mismatch');return send(200,{records:store.stages.records(body.ticket)});}
        if(req.url==='/workflow/approval-outcome') {
          if(!machine) return send(403,{error:'Machine credential required'});
          return send(200,store.recordApprovalOutcome(machine,body.session,project,body.runId,body.ticket,body.outcome));
        }
        if(req.url==='/workflow/approval-authorize') {
          if(!isAdmin) return send(403,{error:'Operator credential required'});
          if(body.ticket?.split('#')[0]!==project) throw new Error('Workflow project mismatch');
          return send(200,store.authorizeApproval(body.ticket,body.runId,body.commandId,body.reason,body.revision));
        }
        if(['/workflow/prepare','/workflow/activate','/workflow/cancel-preparation'].includes(req.url)) {
          if(!isAdmin)return send(403,{error:'Operator credential required'});
          if(req.url==='/workflow/prepare')store.workflow.prepare(project);
          else if(req.url==='/workflow/activate')store.workflow.activate(project);
          else store.workflow.cancelPreparation(project);
          return send(200,{ok:true,preparing:store.workflow.preparing(project)});
        }
        if(req.url==='/workflow/import') {
          if(!isAdmin) return send(403,{error:'Operator credential required'});
          if(body.config?.project!==project) throw new Error('Import project mismatch');
          store.workflow.import(body.config,body.items,body.comments);return send(200,{ok:true});
        }
        if(req.url==='/workflow/operator') {
          if(!isAdmin) return send(403,{error:'Operator credential required'});
          if(body.ticket?.split('#')[0]!==project) throw new Error('Workflow project mismatch');
          return send(200,store.workflowOperator(body.ticket,body.change,body.commandId,body.revision));
        }
        if(req.url==='/workflow/file') {
          if(!isAdmin) return send(403,{error:'Operator credential required'});
          if(!workflowGitHub) return send(403,{error:'Shared GitHub not configured'});
          return send(200,await workflowGitHub.file(project,body));
        }
        if(!machine) return send(403,{error:'Machine credential required'});
        if(body.ticket?.split('#')[0]!==project) throw new Error('Workflow project mismatch');
        if(req.url==='/workflow/stage-plan') return send(200,store.stagePlan(machine,body.session,body.ticket,body.runId,body.plan));
        if(req.url==='/workflow/stage-result') {
          if(store.stages.get(body.runId)?.result) return send(200,store.stageResult(machine,body.session,body.ticket,body.runId,body.result,evidence));
          store.authorizeWorkflow(machine,body.session,body.ticket,body.runId);
          if(!github) throw new Error('Stage acceptance requires published candidate verification');
          const [repo,number]=[body.ticket.split('#')[0],body.ticket.split('#')[1]];
          const response=await github.request(repo,{method:'GET',path:`/repos/${repo}/git/ref/heads/feature/${number}`,fresh:true});
          if(response.status!==200 || JSON.parse(response.body).object?.sha!==body.result?.candidate) throw new Error('Published stage candidate changed or unavailable');
          if(body.result?.verdict) {
            const pr=body.result.pullRequest;
            if(!Number.isSafeInteger(pr) || pr<1) throw new Error('Exact pull request required');
            const view=await github.request(repo,{method:'GET',path:`/repos/${repo}/pulls/${pr}`,fresh:true});
            const pull=view.status===200?JSON.parse(view.body):null;
            if(!pull || pull.state!=='open' || pull.head?.sha!==body.result.candidate || pull.head?.ref!==`feature/${number}` || pull.head?.repo?.full_name!==repo) throw new Error('Review pull request does not match the stage candidate');
          }
          return send(200,store.stageResult(machine,body.session,body.ticket,body.runId,body.result,evidence));
        }
        if(req.url==='/workflow/change') {
          store.authorizeWorkflow(machine,body.session,body.ticket,body.runId);
          if(body.change?.addLabels?.some((l:string)=>l.startsWith('done:')) || body.change?.labels?.some((l:string)=>l.startsWith('done:')) || ['In Documentation','Done'].includes(body.change?.status))await guardPinnedPublication(store,github,body.ticket);
          return send(200,store.workflowChange(machine,body.session,body.runId,body.ticket,body.change,body.commandId,body.revision));
        }
        if(req.url==='/workflow/comments') return send(200,store.workflow.comments(body.ticket));
        // Ownership for a write that does not go to the store, a PR comment:
        // the same refusal of a finished run or lost ownership that a ticket
        // comment gets from workflowComment.
        if(req.url==='/workflow/authorize') {
          store.authorizeWorkflow(machine,body.session,body.ticket,body.runId);await guardPinnedPublication(store,github,body.ticket);return send(200,{ok:true});
        }
        if(req.url==='/workflow/comment') {
          store.workflowComment(machine,body.session,body.runId,body.ticket,body.body,body.commandId);return send(200,{ok:true});
        }
        throw new Error('Unknown workflow operation');
      }
      if (req.url === "/github") {
        if (!machine || !github) return send(403, { error: "Shared GitHub not configured" });
        return send(200, await workflowGitHub!.request(body.project, body.request, body.request.actor ? {...body.request.actor,machine} : undefined));
      }
      if (req.url === "/start") {
        if (!machine || body.machine !== machine) return send(403, { error: "Machine identity mismatch" });
        return send(200, store.start(body));
      }
      if (req.url === "/finish") {
        if (!machine) return send(403, { error: "Machine credential required" });
        if(body.verificationAccepted!==undefined) {
          const run=store.snapshot().runs.find(r=>r.id===body.id && r.machine===machine && r.session===body.session);
          if(run) {
            try {await guardPinnedPublication(store,github,run.ticket);}
            catch(e) {
              store.invalidateVerificationCandidate(run.ticket,String(body.verificationAccepted));
              store.workflow.comment(run.ticket,e instanceof PublishedCandidateChanged?'Verification acceptance refused because the published candidate changed. A fresh review or repair is required.':'Verification acceptance refused because the published candidate could not be read. The run ended and released capacity. Its exact candidate remains required for a fresh review.','handoff-acceptance-'+run.id);
              body.verificationAccepted=undefined;body.completed=false;
              if(body.observation)body.observation={...body.observation,labels:store.workflow.get(run.ticket).labels};
            }
          }
        }
        const incidents = store.finish(machine, body.session, body.id, body.completed !== false, body.unused === true, body.observation, body.verificationAccepted);
        return send(200, { ok: true, incidents });
      }
      if (req.url === "/authorize") {
        if (!machine) return send(403, { error: "Machine credential required" });
        return send(200, store.authorize(machine, body.session, body.ticket, body.runId));
      }
      if (req.url === "/worktree/predecessor") {
        if (!machine) return send(403, { error: "Machine credential required" });
        return send(200, store.worktreePredecessor(machine, body.session, body.runId, body.priorId));
      }
      if (req.url === "/free") {
        if (!isAdmin) return send(403, { error: "Operator credential required" });
        store.free(body.ticket, body.generation, body.stopped);
        return send(200, { ok: true });
      }
      return send(404, { error: "Unknown operation" });
    } catch (error) {
      // A refused publication is final for those bytes; the caller ends the task.
      // An unreadable base is temporary; the caller retries later.
      if (error instanceof RepairRefusal) return send(422, { error: error.message, refused: true });
      if (error instanceof RepairBaseUnavailable) return send(503, { error: error.message });
      if (error instanceof OwnershipRefusal) return send(409, { error: error.message, refused: "ownership" } satisfies OwnershipRefusalBody);
      send(409, { error: error instanceof Error ? error.message : "Operation failed" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return listen(server, port, host);
}

export class JsonClient {
  private readonly socketPath?: string;
  constructor(readonly url: string, private readonly token: string) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || !token) throw new Error("Invalid service connection");
    if (parsed.protocol === "unix:") {
      const path = decodeURIComponent(parsed.pathname);
      if (parsed.host || parsed.search || parsed.hash || !path.startsWith("/") || path === "/" || path.includes("\0")) throw new Error("Invalid socket connection");
      this.socketPath = path;
    } else if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid service connection");
  }
  async call<T>(path: string, body?: unknown): Promise<T> {
    // Preparation reads the repair's base from GitHub and scans it twice.
    const timeoutMs = path === "/tasks/publish-repair" || path === "/tasks/prepare-repair" ? 120_000 : path === "/github" || path === "/workflow/file" || path === "/recovery/split" ? 60_000 : 10_000;
    if (this.socketPath) return new Promise<T>((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, path, method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs), agent: false,
      }, response => {
        void readJson(response, path.startsWith("/workflow/") ? 32*1024*1024 : path === "/github" ? 16 * 1024 * 1024 : path.startsWith("/tasks/") || path.startsWith("/evidence/") ? 8*1024*1024 : 1024 * 1024).then(value => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new ServiceError(response.statusCode ?? 0, value, JSON.stringify(value)));
          } else resolve(value as T);
        }, reject);
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const response = await fetch(new URL(path, this.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    });
    if (!response.ok) {
      const text = await response.text();
      let value: unknown;
      try { value = JSON.parse(text); } catch { value = undefined; }
      throw new ServiceError(response.status, value, text);
    }
    return await response.json() as T;
  }
}
export class FleetClient extends JsonClient {
  authorize(session: string, ticket: string, runId?: string): Promise<Claim> { return this.call("/authorize", { session, ticket, runId }); }
  github(project: string, request: GitHubRequest): Promise<GitHubResponse> { return this.call("/github", { project, request }); }
  snapshot(): Promise<FleetSnapshot> { return this.call("/state"); }
  start(req: StartRequest): Promise<StartResult> { return this.call("/start", req); }
  async finish(session: string, id: string, completed = true, unused = false): Promise<void> { await this.call("/finish", { session, id, completed, unused }); }
  async free(ticket: string, generation: string, stopped: boolean): Promise<void> {
    await this.call("/free", { ticket, generation, stopped });
  }
}
