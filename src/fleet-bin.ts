// Explicit executable only. Importable libraries never start services or touch GitHub.
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FleetStore } from "./fleet-store.js";
import { FleetClient, JsonClient, serveFleet } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { startClaimLabelSync } from "./claim-labels.js";
import { persistProjectDrains } from "./fleet-config.js";

function secret(name: string): string {
  if (typeof name !== "string" || !name || !process.env[name]) throw new Error(`Missing credential environment variable: ${name}`);
  return process.env[name]!;
}
async function main(): Promise<void> {
  const [command, configPath, ...args] = process.argv.slice(2);
  if (!configPath || !["claims", "manager", "status", "drain", "drain-project", "resume-project", "free"].includes(command)) {
    throw new Error("Usage: fleet-bin.ts claims|manager|status|drain|drain-project|resume-project|free CONFIG [PROJECT | TICKET GENERATION --confirmed-stopped]");
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (command === "claims") {
    const database = resolve(config.database);
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
    const machines = Object.fromEntries(Object.entries(config.machines).map(([id, value]) => [id, secret((value as any).tokenEnv)]));
    const limits = Object.fromEntries(Object.entries(config.machines).map(([id, value]) => [id, { heavyLimit: (value as any).heavyLimit, combinedLimit: (value as any).combinedLimit }]));
    const store = new FleetStore(database, limits);
    const server = await serveFleet(store, machines, secret(config.operatorTokenEnv), config.port ?? 7430, config.host ?? "127.0.0.1");
    const stopLabels = startClaimLabelSync(config.githubLabels, () => store.snapshot().claims);
    const close = () => { stopLabels(); server.close(() => { store.close(); process.exit(0); }); };
    process.on("SIGTERM", close); process.on("SIGINT", close);
    console.log("Claim service listening", server.address());
    return;
  }
  if (command === "manager") {
    const claims = new FleetClient(config.claimsUrl, secret(config.claimsTokenEnv));
    const manager = new MachineManager({ machine: config.machine, heavyLimit: config.heavyLimit, combinedLimit: config.combinedLimit, ticketLimit: config.ticketLimit ?? 2, projects: config.projects.map((p: any) => p.repo), drainingProjects: config.drainingProjects }, claims);
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
    const client = new FleetClient(config.claimsUrl, secret(config.claimsOperatorTokenEnv));
    await client.free(args[0], args[1], true);
    console.log(`Freed ${args[0]}. Working copies and GitHub workflow state were preserved.`);
    return;
  }
  const managerUrl = config.managerUrl ?? (config.socketPath ? `unix://${resolve(config.socketPath)}` : undefined);
  if (!managerUrl) throw new Error("Operator configuration requires managerUrl or socketPath");
  const client = new JsonClient(managerUrl, secret(config.operatorTokenEnv));
  if (command === "drain") { await client.call("/drain", {}); console.log("Draining: no new grants. Existing grants remain reserved."); }
  else if (command === "drain-project" || command === "resume-project") {
    if (args.length !== 1) throw new Error(`${command} requires PROJECT`);
    const draining = command === "drain-project";
    await client.call("/project-drain", { project: args[0], draining });
    console.log(draining ? `Draining ${args[0]}: existing owned tickets continue; no new tickets or main sweeps. Saved across manager restarts.` : `Resumed ${args[0]}: new tickets are eligible again.`);
  }
  else console.log(JSON.stringify(await client.call("/state"), null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
