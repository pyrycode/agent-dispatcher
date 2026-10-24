import { readClaimsRetention, startClaimsMaintenance } from "./claims-history.js";
import {WorkflowGitHub} from "./workflow-github.js";
import {WorkflowPublisher} from "./workflow-publisher.js";
import {GitHubProjectClient} from "./github.js";
import {randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
// Explicit executable only. Importable libraries never start services or touch GitHub.
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FleetStore } from "./fleet-store.js";
import { FleetClient, JsonClient, serveFleet } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { startClaimLabelSync } from "./claim-labels.js";
import { GitHubBroker } from "./github-broker.js";
import { githubResponse } from "./github-transport.js";
import { configureGitHubCLI, serveGitHubBridge } from "./github-bridge.js";
import { FleetUpdates } from "./fleet-updates.js";
import { recoveryReport } from "./recovery-report.js";
import { persistProjectDrains, persistDesiredState } from "./fleet-config.js";
import { parseDesiredCommand } from "./desired-state.js";
import { ServiceShutdown, SHUTDOWN_DEADLINE_MS } from "./service-shutdown.js";
import { machineCapabilities, capabilityAttention, CAPABILITY_REPORT_INTERVAL_MS } from "./ticket-requirements.js";
import { readCodexThrottleConfig, codexPauseAttention, type CodexPauseState } from "./codex-throttle.js";
import { EvidenceStore, readEvidenceLimits, type EvidenceUsage } from "./evidence-store.js";

function secret(name: string): string {
  if (typeof name !== "string" || !name || !process.env[name]) throw new Error(`Missing credential environment variable: ${name}`);
  return process.env[name]!;
}
/** Seconds a stop may wait for running requests. Must stay under systemd's TimeoutStopSec=30. */
function shutdownDeadline(seconds: unknown): number {
  if (seconds === undefined) return SHUTDOWN_DEADLINE_MS;
  if (typeof seconds !== "number" || !(seconds > 0 && seconds <= 25)) throw new Error("shutdownDeadlineSeconds must be a number above 0 and at most 25");
  return seconds * 1000;
}
async function main(): Promise<void> {
  const [command, configPath, ...args] = process.argv.slice(2);
  if (!configPath || !["storage", "machine-recovery", "handoff-verifier", "workflow", "control", "recovery-task", "claims", "manager", "status", "runner", "codex", "desired", "attention", "report-attention", "pause", "coordination", "recovery", "drain", "resume", "stop", "start", "desired-state", "drain-project", "resume-project", "free"].includes(command)) {
    throw new Error("Usage: fleet-bin.ts claims|manager|status|runner|codex|recovery|drain|resume|stop|start|desired-state|drain-project|resume-project|free CONFIG [claude|codex|local | PROJECT | --machine MACHINE|--all-machines [--project PROJECT] | TICKET GENERATION --confirmed-stopped]");
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if(command==='storage') {
    const [action,file]=args;
    if(!['list','acquire','verify','finish','cancel','attest'].includes(action)||action!=='list'&&!file)throw new Error('storage list|acquire|verify|finish|cancel|attest [SAVED_JSON_FILE]');
    const claims=new JsonClient(config.claimsUrl,secret(config.claimsOperatorTokenEnv??config.claimsTokenEnv));
    const input=action==='list'?{}:JSON.parse(readFileSync(file,'utf8'));
    console.log(JSON.stringify(await claims.call('/storage/'+action,input)));return;
  }
  if(command==='workflow') {
    const [action,project,file,boardNumber]=args;
    if(!['read','export','import','change','file','prepare','activate','cancel-preparation','approval-authorize','declaration-repair','required-repairs','retry-review','recovery-split'].includes(action)||!project)throw new Error('workflow read|export|import|change|file|prepare|activate|cancel-preparation|approval-authorize|declaration-repair|required-repairs|retry-review|recovery-split PROJECT [JSON_FILE]');
    if(action==='export') {
      if(!file)throw new Error('Export output path required');
      const entry=config.projects?.find((p:any)=>p.repo===project);
      const projectNumber=Number(boardNumber??entry?.projectNumber);
      if(!Number.isSafeInteger(projectNumber)||projectNumber<1)throw new Error('Export requires a project number as the final argument or in project configuration');
      const [owner,repo]=project.split('/');
      const client=new GitHubProjectClient({owner,repo,projectNumber,ownerType:entry?.ownerType??'organization',token:secret(config.githubTokenEnv??config.github?.tokenEnv??'GH_TOKEN')});
      await client.initialize();writeFileSync(file,JSON.stringify(await client.workflowExport()),{mode:0o600});return;
    }
    const claims=new JsonClient(config.claimsUrl,secret(config.claimsOperatorTokenEnv??config.claimsTokenEnv));
    if(['prepare','activate','cancel-preparation'].includes(action)) {console.log(JSON.stringify(await claims.call('/workflow/'+action,{project})));return;}
    if(action==='read') {console.log(JSON.stringify(await claims.call('/workflow/read',{project})));return;}
    if(!file)throw new Error('Saved workflow request required');
    const input=JSON.parse(readFileSync(file,'utf8'));
    if(action==='required-repairs') {
      console.log(JSON.stringify(await claims.call('/workflow/required-repairs',{...input,project})));return;
    }
    if(action==='recovery-split') {
      if(Object.keys(input).length!==1 || typeof input.id!=='string' || !/^[a-f0-9-]{36}$/.test(input.id)) throw new Error('Recovery split retry accepts only its retained incident id');
      console.log(JSON.stringify(await claims.call('/recovery/split',{id:input.id,project})));return;
    }
    if(action==='retry-review') {
      console.log(JSON.stringify(await claims.call('/workflow/retry-review',{...input,project})));return;
    }
    if(action==='declaration-repair') {
      console.log(JSON.stringify(await claims.call('/workflow/declaration-repair',{...input,project})));return;
    }
    if(action==='approval-authorize') {
      if(!input.commandId) throw new Error('Approval decision requires a commandId kept for retries');
      console.log(JSON.stringify(await claims.call('/workflow/approval-authorize',{...input,project})));return;
    }
    // A filing is retried by repeating the same commandId, so it never gets a random one.
    if(action==='file') {
      if(!input.commandId)throw new Error('Filing request requires a commandId kept for retries');
      console.log(JSON.stringify(await claims.call('/workflow/file',{...input,project})));return;
    }
    console.log(JSON.stringify(await claims.call(action==='import'?'/workflow/import':'/workflow/operator', {...input,project,commandId:input.commandId??randomUUID()})));return;
  }
  if(command==='control') {
    const claims=new JsonClient(config.claimsUrl,secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    if(args[0]==='target') {
      if(args.length!==2 || !/^[a-f0-9]{40}$/.test(args[1]))throw new Error('control target requires an exact upstream main revision');
      console.log(JSON.stringify(await claims.call('/operations/control-target',{revision:args[1]})));return;
    }
    console.log(JSON.stringify(await claims.call(args.length?'/operations/control-ready':'/operations/control',args.length?JSON.parse(readFileSync(args[0],'utf8')):undefined)));
    return;
  }
  if (command === 'recovery-task') {
    if (args.length !== 2 || !['capabilities','queue','start','complete','cancel-queued','operator-request','publish-repair','prepare-repair','uncertain','schedule','artifacts-begin','artifacts-put','artifacts-commit'].includes(args[0])) throw new Error('Provide task operation and saved request JSON');
    const body = JSON.parse(readFileSync(args[1],'utf8'));
    if(args[0]==='schedule') {
      const local=new JsonClient(config.managerUrl??`unix://${resolve(config.socketPath)}`,secret(config.operatorTokenEnv));
      console.log(JSON.stringify(await local.call('/support-offers',body)));return;
    }
    const claims = new JsonClient(config.claimsUrl,secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    console.log(JSON.stringify(await claims.call('/tasks/'+args[0],body)));
    return;
  }
  if (command === 'machine-recovery') {
    const action = args[0];
    if (action === 'inspect-paths') {
      if (args.length !== 2) throw new Error('Provide the saved local path list');
      const input = JSON.parse(readFileSync(args[1],'utf8'));
      const paths: unknown = Array.isArray(input) ? input : input.paths;
      const before = Array.isArray(input) ? undefined : input.dispatcherStarted;
      if (before !== undefined && (typeof before !== 'number' || !Number.isFinite(before) || before <= 0 || before > Date.now())) throw new Error('Invalid dispatcher process identity');
      if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !p.startsWith('/'))) throw new Error('Invalid local path list');
      process.env.DOTENV_CONFIG_QUIET = 'true';
      const {processesUsingPath} = await import('./dispatch.js');
      const {stoppedPathUsers} = await import('./machine-recovery.js');
      const stopped = stoppedPathUsers(paths as string[],before,processesUsingPath,pid => {
        const text = execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim();
        return Date.parse(text);
      });
      console.log(JSON.stringify({stopped}));
      return;
    }
    if (!['read','release','clear'].includes(action) || args.length !== (action === 'read' ? 1 : 2)) throw new Error('Usage: machine-recovery CONFIG read | release RECEIPT.json | clear DECISION.json');
    const client = new JsonClient(config.claimsUrl,secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    console.log(JSON.stringify(await client.call('/machine-recovery/'+action,action === 'read' ? {} : JSON.parse(readFileSync(args[1],'utf8')))));
    return;
  }
  if(command==='handoff-verifier') {
    if(args.length!==2 || !['request','read','cancel'].includes(args[0]))throw new Error('Usage: handoff-verifier CONFIG request REQUEST.json | read ID | cancel ID');
    const claims=new JsonClient(config.claimsUrl,secret(config.claimsOperatorTokenEnv??config.claimsTokenEnv));
    const body=args[0]==='request'?JSON.parse(readFileSync(args[1],'utf8')):{id:args[1]};
    console.log(JSON.stringify(await claims.call('/verification-handoff/'+args[0],body),null,2));return;
  }
  if (command === 'runner') {
    if (args.length > 1 || (args.length === 1 && !['claude', 'codex', 'local'].includes(args[0]))) throw new Error('Runner accepts claude, codex or local; omit to show the current choice');
    const claims = new JsonClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    console.log(JSON.stringify(await claims.call('/runner', args.length ? { runner: args[0] === 'local' ? null : args[0] } : undefined)));
    return;
  }
  if (command === 'codex') {
    if (args.length > 1 || (args.length === 1 && args[0] !== 'clear')) throw new Error('codex shows the fleet Codex rate-limit pause; codex clear ends it early and resets the backoff');
    const claims = new JsonClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    console.log(JSON.stringify(await claims.call(args.length ? '/codex/clear' : '/codex', args.length ? {} : undefined), null, 2));
    return;
  }
  if (command === "claims") {
    const stopDeadline = shutdownDeadline(config.shutdownDeadlineSeconds);
    const database = resolve(config.database);
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
    const machines = Object.fromEntries(Object.entries(config.machines).map(([id, value]) => [id, secret((value as any).tokenEnv)]));
    const limits = Object.fromEntries(Object.entries(config.machines).map(([id, value]) => [id, { heavyLimit: (value as any).heavyLimit, combinedLimit: (value as any).combinedLimit, ...((value as any).projectHeavyLimits !== undefined ? { projectHeavyLimits: (value as any).projectHeavyLimits } : {}) }]));
    // Unchanged settled waits are reassessed after this interval. Default 24 hours.
    const safetyHours = config.recovery?.safetyRecheckHours;
    if (safetyHours !== undefined && (typeof safetyHours !== "number" || !Number.isFinite(safetyHours))) throw new Error("recovery.safetyRecheckHours must be a number");
    // A running or attention task nothing holds is reported after this many minutes. Default 60.
    const orphanMinutes = config.recovery?.orphanedTaskMinutes;
    if (orphanMinutes !== undefined && (typeof orphanMinutes !== "number" || !Number.isFinite(orphanMinutes) || orphanMinutes < 1)) throw new Error("recovery.orphanedTaskMinutes must be a number of at least 1");
    // Quiet repeat assessments of one ticket: first after this many minutes,
    // doubling up to the ceiling in hours. Defaults 30 minutes and 4 hours.
    const reassessMinutes = config.recovery?.reassessBaseMinutes, reassessHours = config.recovery?.reassessCeilingHours;
    if (reassessMinutes !== undefined && (typeof reassessMinutes !== "number" || !Number.isFinite(reassessMinutes))) throw new Error("recovery.reassessBaseMinutes must be a number");
    if (reassessHours !== undefined && (typeof reassessHours !== "number" || !Number.isFinite(reassessHours))) throw new Error("recovery.reassessCeilingHours must be a number");
    const claimsRetention = readClaimsRetention(config.claimsHistory);
    const store = new FleetStore(database, limits, { ...(safetyHours === undefined ? {} : { safetyRecheckMs: Math.round(safetyHours * 3600_000) }),
      ...(orphanMinutes === undefined ? {} : { orphanedTaskMs: Math.round(orphanMinutes * 60_000) }),
      ...(reassessMinutes === undefined ? {} : { reassessBaseMs: Math.round(reassessMinutes * 60_000) }),
      ...(reassessHours === undefined ? {} : { reassessCeilingMs: Math.round(reassessHours * 3600_000) }),
      codexThrottle: readCodexThrottleConfig(config.codexThrottle) });
    const stopClaimsMaintenance = startClaimsMaintenance(store.history, claimsRetention);
    // Logs a Codex pause's end once, when it runs out, rather than at the next report.
    const codexTimer = setInterval(() => { try { store.codexTick(); } catch (e) { console.warn("Codex throttle tick failed:", (e as Error).message); } }, 5_000);
    // A claim held by a computer that cannot run its ticket's requirement is released, so a capable one can take the next stage.
    const releaseIncapable = () => {
      try { for (const c of store.releaseIncapableClaims()) console.log(`Released ${c.ticket} from ${c.machine}: it lacks a capability the ticket requires`); }
      catch (e) { console.warn("Capability claim release failed:", (e as Error).message); }
    };
    releaseIncapable();
    const capabilityTimer = setInterval(releaseIncapable, 15_000);
    const github = config.github ? new GitHubBroker({ ...config.github,
      projects: [...new Set([...config.github.projects, ...Object.values(config.updates?.consumers ?? {}), ...(config.updates?.dispatcherRepository ? [config.updates.dispatcherRepository] : [])])], token: secret(config.github.tokenEnv) }) : undefined;
    const updates = config.updates && github ? new FleetUpdates(github, config.updates.consumers, config.updates.dispatcherRepository) : undefined;
    const refresh = () => { void updates?.refresh().catch(() => console.warn("Consumer update lookup paused; running workers preserved")); };
    if (updates) { try { await updates.refresh(); } catch { /* retry without offering any update */ } }
    const updateTimer = updates ? setInterval(refresh, 300_000) : undefined;
    // Shared run evidence, in its own database beside the authority so the
    // authority's backups stay small. `evidence.enabled: false` turns it off.
    const evidence = config.evidence?.enabled === false ? undefined
      : new EvidenceStore(resolve(config.evidence?.database ?? resolve(dirname(database), "evidence.sqlite")), readEvidenceLimits(config.evidence), id => store.runOwner(id));
    const evidenceSweep = () => { try { const { deleted } = evidence!.sweep(ticket => store.ticketDone(ticket)); if (deleted) console.log(`Evidence retention removed ${deleted} bundle(s)`); } catch (e) { console.warn("Evidence retention failed:", (e as Error).message); } };
    if (evidence) evidenceSweep();
    const evidenceTimer = evidence ? setInterval(evidenceSweep, 3600_000) : undefined;
    // Freed pages go back to the disk 16 MiB a minute; see EvidenceStore.vacuumStep.
    const vacuumTimer = evidence ? setInterval(() => { try { evidence.vacuumStep(); } catch (e) { console.warn("Evidence vacuum failed:", (e as Error).message); } }, 60_000) : undefined;
    const server = await serveFleet(store, machines, secret(config.operatorTokenEnv), config.port ?? 7430, config.host ?? "127.0.0.1", github, () => updates?.snapshot() ?? {}, config.updates?.dispatcherRepository,config.updates?.consumers,execFileSync("git",["rev-parse","HEAD"],{cwd:resolve(fileURLToPath(new URL("..",import.meta.url))),encoding:"utf8"}).trim(), evidence);
    let cli: Awaited<ReturnType<typeof serveGitHubBridge>> | undefined;
    if (github && config.github.socketPath) {
      const socket = resolve(config.github.socketPath);
      configureGitHubCLI(resolve(config.github.cliConfigDir ?? dirname(socket)), socket);
      const workflowCLI=new WorkflowGitHub(store,github);
      cli = await serveGitHubBridge(socket, request => workflowCLI.request(request.path.match(/^\/repos\/([^/]+\/[^/?]+)/)?.[1] ?? config.github.projects[0], request));
    }
    const labelFetch: typeof fetch = github ? async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.origin !== "https://api.github.com") throw new Error("GitHub API host required");
      const project = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)/)?.[1];
      if (!project) throw new Error("Claim labels require a repository");
      return githubResponse(await github.request(project, { method: req.method, path: url.pathname + url.search,
        headers: { accept: req.headers.get("accept") ?? "application/vnd.github+json", "content-type": "application/json" },
        ...(!["GET", "HEAD"].includes(req.method) ? { body: await req.text() } : {}) }));
    } : fetch;
    const workflowPublisher=github?new WorkflowPublisher(store,github):undefined;
    const publishing=new Set<Promise<unknown>>();
    const workflowTimer=workflowPublisher?setInterval(()=>{
      const work=workflowPublisher.tick().catch(e=>console.warn(e.message)).finally(()=>publishing.delete(work));
      publishing.add(work);
    },30_000):undefined;
    const stopLabels = startClaimLabelSync(config.githubLabels, () => store.snapshot().claims, process.env, labelFetch, () => store.recovery.escalatedTickets(), project=>store.workflow.enabled(project));
    // A display pass writes the database after its GitHub calls, so it may finish.
    const shutdown = new ServiceShutdown({ servers: cli ? [server, cli] : [server],
      stop: [stopClaimsMaintenance, () => clearInterval(updateTimer), () => clearInterval(workflowTimer), () => clearInterval(codexTimer), () => clearInterval(capabilityTimer), () => clearInterval(evidenceTimer), () => clearInterval(vacuumTimer), stopLabels],
      pending: () => publishing, close: () => { store.close(); evidence?.close(); }, deadlineMs: stopDeadline });
    process.on("SIGTERM", () => void shutdown.stop("SIGTERM")); process.on("SIGINT", () => void shutdown.stop("SIGINT"));
    console.log("Claim service listening", server.address());
    return;
  }
  if (command === "manager") {
    const claims = new FleetClient(config.claimsUrl, secret(config.claimsTokenEnv));
    const manager = new MachineManager({ machine: config.machine, heavyLimit: config.heavyLimit, combinedLimit: config.combinedLimit, ...(config.diskAdmission!==undefined?{diskAdmission:config.diskAdmission}:{}), ...(config.projectHeavyLimits !== undefined ? { projectHeavyLimits: config.projectHeavyLimits } : {}), ticketLimit: config.ticketLimit ?? 2, ...(config.reviewQueueLimit != null ? { reviewQueueLimit: config.reviewQueueLimit } : {}), controlRevision: execFileSync("git",["rev-parse","HEAD"],{cwd:resolve(fileURLToPath(new URL("..",import.meta.url))),encoding:"utf8"}).trim(), capabilities: machineCapabilities(config.capabilities), projects: config.projects.map((p: any) => p.repo), drainingProjects: config.drainingProjects, projectDrainChanges: config.projectDrainChanges }, claims, Date.now,
      // Central desired state: the saved copy applies from the start, and with
      // none nothing is granted until the claim service has answered.
      { ...(config.desiredState ? { cached: config.desiredState } : {}), persist: update => persistDesiredState(configPath, update) });
    const tokens = Object.fromEntries(config.projects.map((p: any) => [p.repo, secret(p.tokenEnv)]));
    const endpoint = config.socketPath ? resolve(config.socketPath) : config.port ?? 7431;
    const server = await serveManager(manager, tokens, secret(config.operatorTokenEnv), endpoint, config.host ?? "127.0.0.1", (projects, changes) => persistProjectDrains(configPath, projects, changes));
    // Desired state comes over this manager's own outbound connection, so a
    // computer the claim service cannot reach, such as the Mac, still gets it.
    let desiredFailed = false;
    const fetchDesired = () => void manager.refreshDesired().then(() => {
      const status = manager.desiredStatus();
      if (status?.lastError && !desiredFailed) console.warn(`Desired state fetch failed (${status.mode}):`, status.lastError);
      else if (!status?.lastError && desiredFailed) console.log(`Desired state fetched again (${status?.mode}, revision ${status?.revision})`);
      desiredFailed = !!status?.lastError;
    });
    fetchDesired();
    const desiredTimer = setInterval(fetchDesired, 15_000);
    console.log("Desired state at start:", manager.desiredStatus()?.mode, manager.desiredKnown() ? "" : "(nothing is granted until the claim service answers)");
    const timer = setInterval(() => { void manager.tick().catch(e => console.error("Scheduling paused:", e.message)); }, 1000);
    // Logged once per change between failing and working, not every minute.
    let reportFailed = false;
    const report = () => void manager.reportCapabilities().then(() => {
      if (reportFailed) console.log("Capability report accepted again");
      reportFailed = false;
    }, (e: Error) => {
      if (!reportFailed) console.warn("Capability report failed; tickets with a requirement cannot start here:", e.message);
      reportFailed = true;
    });
    report();
    const capabilityTimer = setInterval(report, CAPABILITY_REPORT_INTERVAL_MS);
    console.log("Machine capabilities", (manager.config.capabilities ?? []).join(", ") || "none");
    const close = () => { manager.draining = true; clearInterval(timer); clearInterval(capabilityTimer); clearInterval(desiredTimer); server.close(() => process.exit(0)); };
    process.on("SIGTERM", close); process.on("SIGINT", close);
    console.log("Machine manager listening", server.address());
    return;
  }
  if (command === "free") {
    if (args.length !== 3 || args[2] !== "--confirmed-stopped") throw new Error("Free requires TICKET GENERATION --confirmed-stopped. Stop the old worker and its subprocesses first.");
    const client = new FleetClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    await client.free(args[0], args[1], true);
    console.log(`Freed ${args[0]}. Working copies and GitHub workflow state were preserved.`);
    return;
  }
  if (command === "pause" || command === "coordination") {
    if (args.length !== 1) throw new Error("Provide a saved JSON receipt file");
    const record = JSON.parse(readFileSync(args[0], "utf8"));
    const claims = new JsonClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    console.log(JSON.stringify(await claims.call(`/recovery/operator-${command}`, { record })));
    return;
  }
  if (command === "desired-state" || ["resume", "stop", "start"].includes(command) || (command === "drain" && args.length)) {
    const claims = new JsonClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    if (command === "desired-state") { if (args.length) throw new Error("desired-state takes no arguments"); console.log(JSON.stringify(await claims.call("/desired"), null, 2)); return; }
    const request = parseDesiredCommand(command, args)!;
    console.log(JSON.stringify(await claims.call("/desired/set", request), null, 2));
    return;
  }
  const managerUrl = config.managerUrl ?? (config.socketPath ? `unix://${resolve(config.socketPath)}` : undefined);
  if (!managerUrl) throw new Error("Operator configuration requires managerUrl or socketPath");
  const client = new JsonClient(managerUrl, secret(config.operatorTokenEnv));
  if (command === 'report-attention') {
    if (args.length !== 1) throw new Error('Provide the saved local supervisor report');
    const state = await client.call<any>('/state');
    const claims = new JsonClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    const report = JSON.parse(readFileSync(args[0], 'utf8'));
    await claims.call('/operations/report', {machine:state.machine,report:{...report,operations:report.operations ?? []}});
    return;
  }
  if (command === "desired") {
    const claims = new JsonClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    console.log(JSON.stringify(await claims.call("/operations/desired"))); return;
  }
  if (command === "attention") {
    const claims = new JsonClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    // A claims service that predates the route, or a failed read, must not hide the rest of the report,
    // and must not read as "no orphaned tasks": the list is null with the reason beside it.
    let orphanedError: string | undefined;
    const [incidents, state, operations, orphaned] = await Promise.all([claims.call<import("./fleet-recovery.js").RecoveryIncident[]>("/recovery/state"), client.call<any>("/state"),claims.call<any[]>('/operations/reports'),
      claims.call<any[]>('/tasks/orphaned').catch((error: Error) => { orphanedError = String(error.message).slice(0, 200); return null; })]);
    // A pause at the ceiling means the limit outlasted the whole backoff: someone should look at OpenAI usage.
    const codexPause = codexPauseAttention(state.codexPause as CodexPauseState | undefined);
    // A ticket whose requirement no reporting computer can satisfy would otherwise wait silently.
    const capabilityGaps = capabilityAttention(state);
    // Near the cap, the store is evicting evidence other computers may still need.
    const evidence = (state.evidenceStore ?? null) as EvidenceUsage | null;
    const evidenceStore = evidence?.nearCap ? { ...evidence, attention: `Shared evidence store at ${Math.round(evidence.usedRatio * 100)}% of its ${Math.round(evidence.limits.totalBytes / 1024 / 1024)} MiB cap; the oldest bundles are being evicted early` } : undefined;
    const desired = await fleetDesired(config);
    console.log(JSON.stringify({...recoveryReport(incidents, state),operationReports:operations,
      // Central drains and stops not yet applied, or failed.
      ...("fleetDesiredState" in desired ? { desiredState: desired.fleetDesiredState.attention } : { desiredState: null, desiredStateError: desired.fleetDesiredStateError }),orphanedTasks:orphaned,...(orphanedError ? {orphanedTasksError:orphanedError} : {}),...(codexPause ? {codexPause} : {}),...(capabilityGaps.length ? {capabilityGaps} : {}),...(evidenceStore ? {evidenceStore} : {})}, null, 2)); return;
  }
  if (command === "drain") {
    await client.call("/drain", {});
    console.log("Draining: no new grants. Existing grants remain reserved.");
    console.warn("This drain is in this manager's memory only: a manager restart, as on a controller rollout, lifts it, and its dispatchers exit. Use drain --machine MACHINE for a saved central drain.");
  }
  else if (command === "drain-project" || command === "resume-project") {
    if (args.length !== 1) throw new Error(`${command} requires PROJECT`);
    const draining = command === "drain-project";
    const state = await client.call<any>("/state");
    // A manager with central desired state takes the same change from the claim service.
    if (state.desiredState && state.desiredState.mode !== "unsupported") {
      const claims = new JsonClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
      console.log(JSON.stringify(await claims.call("/desired/set", { machines: [state.machine], project: args[0], change: { work: draining ? "tickets-drained" : "taking" } }), null, 2));
    } else await client.call("/project-drain", { project: args[0], draining });
    console.log(draining ? `Draining ${args[0]}: existing owned tickets continue; no new tickets or main sweeps. Saved across manager restarts.` : `Resumed ${args[0]}: new tickets are eligible again.`);
  }
  // status carries the shared evidence store's usage as evidenceStore, from the claim service's snapshot.
  else if (command === "recovery") console.log(JSON.stringify(await client.call("/recovery/state"), null, 2));
  else {
    // Desired against observed for every computer comes from the claim
    // service. Its failure never hides the local state, and is not "none".
    // `status --local`, which the supervisor reads many times a pass, skips it.
    if (args.length > 1 || (args.length === 1 && args[0] !== "--local")) throw new Error("status takes only --local");
    const [state, fleet] = await Promise.all([client.call<any>("/state"), args[0] === "--local" ? {} : fleetDesired(config)]);
    console.log(JSON.stringify({ ...state, ...fleet }, null, 2));
  }
}
/** The claim service's desired state report, or the reason it is unavailable. */
async function fleetDesired(config: any): Promise<{ fleetDesiredState: { machines: unknown[]; attention: unknown[] } } | { fleetDesiredStateError: string }> {
  try {
    if (!config.claimsUrl) return { fleetDesiredStateError: "No claimsUrl in this operator configuration" };
    const claims = new JsonClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    return { fleetDesiredState: await claims.call("/desired") };
  } catch (error) { return { fleetDesiredStateError: String((error as Error).message).slice(0, 300) }; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
