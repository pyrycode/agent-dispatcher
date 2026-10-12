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
import { persistProjectDrains } from "./fleet-config.js";

function secret(name: string): string {
  if (typeof name !== "string" || !name || !process.env[name]) throw new Error(`Missing credential environment variable: ${name}`);
  return process.env[name]!;
}
async function main(): Promise<void> {
  const [command, configPath, ...args] = process.argv.slice(2);
  if (!configPath || !["workflow", "control", "recovery-task", "claims", "manager", "status", "runner", "desired", "attention", "report-attention", "pause", "coordination", "recovery", "drain", "drain-project", "resume-project", "free"].includes(command)) {
    throw new Error("Usage: fleet-bin.ts claims|manager|status|runner|recovery|drain|drain-project|resume-project|free CONFIG [claude|codex|local | PROJECT | TICKET GENERATION --confirmed-stopped]");
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if(command==='workflow') {
    const [action,project,file,boardNumber]=args;
    if(!['read','export','import','change','prepare','activate','cancel-preparation'].includes(action)||!project)throw new Error('workflow read|export|import|change|prepare|activate|cancel-preparation PROJECT [JSON_FILE]');
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
    console.log(JSON.stringify(await claims.call(action==='import'?'/workflow/import':'/workflow/operator', {...input,project,commandId:input.commandId??randomUUID()})));return;
  }
  if(command==='control') {
    const claims=new JsonClient(config.claimsUrl,secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    console.log(JSON.stringify(await claims.call(args.length?'/operations/control-ready':'/operations/control',args.length?JSON.parse(readFileSync(args[0],'utf8')):undefined)));
    return;
  }
  if (command === 'recovery-task') {
    if (args.length !== 2 || !['capabilities','queue','start','complete','operator-request','publish-repair','prepare-repair','uncertain','schedule'].includes(args[0])) throw new Error('Provide task operation and saved request JSON');
    const body = JSON.parse(readFileSync(args[1],'utf8'));
    if(args[0]==='schedule') {
      const local=new JsonClient(config.managerUrl??`unix://${resolve(config.socketPath)}`,secret(config.operatorTokenEnv));
      console.log(JSON.stringify(await local.call('/support-offers',body)));return;
    }
    const claims = new JsonClient(config.claimsUrl,secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    console.log(JSON.stringify(await claims.call('/tasks/'+args[0],body)));
    return;
  }
  if (command === 'runner') {
    if (args.length > 1 || (args.length === 1 && !['claude', 'codex', 'local'].includes(args[0]))) throw new Error('Runner accepts claude, codex or local; omit to show the current choice');
    const claims = new JsonClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv ?? config.claimsTokenEnv));
    console.log(JSON.stringify(await claims.call('/runner', args.length ? { runner: args[0] === 'local' ? null : args[0] } : undefined)));
    return;
  }
  if (command === "claims") {
    const database = resolve(config.database);
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
    const machines = Object.fromEntries(Object.entries(config.machines).map(([id, value]) => [id, secret((value as any).tokenEnv)]));
    const limits = Object.fromEntries(Object.entries(config.machines).map(([id, value]) => [id, { heavyLimit: (value as any).heavyLimit, combinedLimit: (value as any).combinedLimit }]));
    const store = new FleetStore(database, limits);
    const github = config.github ? new GitHubBroker({ ...config.github,
      projects: [...new Set([...config.github.projects, ...Object.values(config.updates?.consumers ?? {}), ...(config.updates?.dispatcherRepository ? [config.updates.dispatcherRepository] : [])])], token: secret(config.github.tokenEnv) }) : undefined;
    const updates = config.updates && github ? new FleetUpdates(github, config.updates.consumers, config.updates.dispatcherRepository) : undefined;
    const refresh = () => { void updates?.refresh().catch(() => console.warn("Consumer update lookup paused; running workers preserved")); };
    if (updates) { try { await updates.refresh(); } catch { /* retry without offering any update */ } }
    const updateTimer = updates ? setInterval(refresh, 300_000) : undefined;
    const server = await serveFleet(store, machines, secret(config.operatorTokenEnv), config.port ?? 7430, config.host ?? "127.0.0.1", github, () => updates?.snapshot() ?? {}, config.updates?.dispatcherRepository,config.updates?.consumers,execFileSync("git",["rev-parse","HEAD"],{cwd:resolve(fileURLToPath(new URL("..",import.meta.url))),encoding:"utf8"}).trim());
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
    const workflowTimer=workflowPublisher?setInterval(()=>{void workflowPublisher.tick().catch(e=>console.warn(e.message));},30_000):undefined;
    const stopLabels = startClaimLabelSync(config.githubLabels, () => store.snapshot().claims, process.env, labelFetch, () => store.recovery.escalatedTickets(), project=>store.workflow.enabled(project));
    const close = () => { if (updateTimer) clearInterval(updateTimer); if(workflowTimer)clearInterval(workflowTimer); stopLabels(); cli?.close(); server.close(() => { store.close(); process.exit(0); }); };
    process.on("SIGTERM", close); process.on("SIGINT", close);
    console.log("Claim service listening", server.address());
    return;
  }
  if (command === "manager") {
    const claims = new FleetClient(config.claimsUrl, secret(config.claimsTokenEnv));
    const manager = new MachineManager({ machine: config.machine, heavyLimit: config.heavyLimit, combinedLimit: config.combinedLimit, ticketLimit: config.ticketLimit ?? 2, controlRevision: execFileSync("git",["rev-parse","HEAD"],{cwd:resolve(fileURLToPath(new URL("..",import.meta.url))),encoding:"utf8"}).trim(), projects: config.projects.map((p: any) => p.repo), drainingProjects: config.drainingProjects }, claims);
    const tokens = Object.fromEntries(config.projects.map((p: any) => [p.repo, secret(p.tokenEnv)]));
    const endpoint = config.socketPath ? resolve(config.socketPath) : config.port ?? 7431;
    const server = await serveManager(manager, tokens, secret(config.operatorTokenEnv), endpoint, config.host ?? "127.0.0.1", projects => persistProjectDrains(configPath, projects));
    const timer = setInterval(() => { void manager.tick().catch(e => console.error("Scheduling paused:", e.message)); }, 1000);
    const close = () => { manager.draining = true; clearInterval(timer); server.close(() => process.exit(0)); };
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
    const [incidents, state, operations] = await Promise.all([claims.call<import("./fleet-recovery.js").RecoveryIncident[]>("/recovery/state"), client.call<any>("/state"),claims.call<any[]>('/operations/reports')]);
    console.log(JSON.stringify({...recoveryReport(incidents, state),operationReports:operations}, null, 2)); return;
  }
  if (command === "drain") { await client.call("/drain", {}); console.log("Draining: no new grants. Existing grants remain reserved."); }
  else if (command === "drain-project" || command === "resume-project") {
    if (args.length !== 1) throw new Error(`${command} requires PROJECT`);
    const draining = command === "drain-project";
    await client.call("/project-drain", { project: args[0], draining });
    console.log(draining ? `Draining ${args[0]}: existing owned tickets continue; no new tickets or main sweeps. Saved across manager restarts.` : `Resumed ${args[0]}: new tickets are eligible again.`);
  }
  else console.log(JSON.stringify(await client.call(command === "recovery" ? "/recovery/state" : "/state"), null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
