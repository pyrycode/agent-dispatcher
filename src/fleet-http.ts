import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { chmodSync } from "node:fs";
import type { GitHubBroker, GitHubRequest, GitHubResponse } from "./github-broker.js";
import type { Claim, FleetStore, FleetSnapshot, StartRequest, StartResult } from "./fleet-store.js";

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
export async function serveFleet(store: FleetStore, machines: Record<string, string>, admin: string, port: number, host = "127.0.0.1", github?: GitHubBroker): Promise<Server> {
  const secrets = [...Object.values(machines), admin];
  if (secrets.some(s => !s) || new Set(secrets).size !== secrets.length) throw new Error("Fleet credentials must be non-empty and distinct");
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const isAdmin = tokenMatches(req.headers.authorization, admin);
    const machine = Object.keys(machines).find(m => tokenMatches(req.headers.authorization, machines[m]));
    if (!isAdmin && !machine) return send(401, { error: "Authentication required" });
    try {
      if (req.method === "GET" && req.url === "/state") return send(200, store.snapshot());
      if (req.method === "GET" && req.url === "/github/status" && isAdmin) return send(200, github?.status() ?? { enabled: false });
      if (req.method !== "POST") return send(404, { error: "Unknown operation" });
      const body = await readJson(req);
      if (req.url === "/github") {
        if (!machine || !github) return send(403, { error: "Shared GitHub not configured" });
        return send(200, await github.request(body.project, body.request));
      }
      if (req.url === "/start") {
        if (!machine || body.machine !== machine) return send(403, { error: "Machine identity mismatch" });
        return send(200, store.start(body));
      }
      if (req.url === "/finish") {
        if (!machine) return send(403, { error: "Machine credential required" });
        store.finish(machine, body.session, body.id, body.completed !== false, body.unused === true);
        return send(200, { ok: true });
      }
      if (req.url === "/authorize") {
        if (!machine) return send(403, { error: "Machine credential required" });
        return send(200, store.authorize(machine, body.session, body.ticket, body.runId));
      }
      if (req.url === "/free") {
        if (!isAdmin) return send(403, { error: "Operator credential required" });
        store.free(body.ticket, body.generation, body.stopped);
        return send(200, { ok: true });
      }
      return send(404, { error: "Unknown operation" });
    } catch (error) {
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
    const timeoutMs = path === "/github" ? 60_000 : 10_000;
    if (this.socketPath) return new Promise<T>((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, path, method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs), agent: false,
      }, response => {
        void readJson(response, path === "/github" ? 16 * 1024 * 1024 : 1024 * 1024).then(value => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Service ${response.statusCode}: ${JSON.stringify(value).slice(0, 500)}`));
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
    if (!response.ok) throw new Error(`Service ${response.status}: ${(await response.text()).slice(0, 500)}`);
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
