import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Claim, FleetStore, FleetSnapshot, StartRequest, StartResult } from "./fleet-store.js";

export async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function tokenMatches(header: string | undefined, secret: string): boolean {
  const a = Buffer.from(header ?? ""), b = Buffer.from(`Bearer ${secret}`);
  return secret.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
export async function listen(server: Server, port: number, host = "127.0.0.1"): Promise<Server> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
  });
  return server;
}
export async function serveFleet(store: FleetStore, machines: Record<string, string>, admin: string, port: number, host = "127.0.0.1"): Promise<Server> {
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
      if (req.method !== "POST") return send(404, { error: "Unknown operation" });
      const body = await readJson(req);
      if (req.url === "/start") {
        if (!machine || body.machine !== machine) return send(403, { error: "Machine identity mismatch" });
        return send(200, store.start(body));
      }
      if (req.url === "/finish") {
        if (!machine) return send(403, { error: "Machine credential required" });
        store.finish(machine, body.session, body.id, body.completed !== false);
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
  constructor(readonly url: string, private readonly token: string) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !token) throw new Error("Invalid service connection");
  }
  async call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (!response.ok) throw new Error(`Service ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return await response.json() as T;
  }
}
export class FleetClient extends JsonClient {
  authorize(session: string, ticket: string, runId?: string): Promise<Claim> { return this.call("/authorize", { session, ticket, runId }); }
  snapshot(): Promise<FleetSnapshot> { return this.call("/state"); }
  start(req: StartRequest): Promise<StartResult> { return this.call("/start", req); }
  async finish(session: string, id: string, completed = true): Promise<void> { await this.call("/finish", { session, id, completed }); }
  async free(ticket: string, generation: string, stopped: boolean): Promise<void> {
    await this.call("/free", { ticket, generation, stopped });
  }
}
