import type { IncomingMessage, Server, ServerResponse } from "node:http";

/** Stop well inside systemd's 30 second stop timeout, which ends in SIGKILL. */
export const SHUTDOWN_DEADLINE_MS = 20_000;

export interface ServiceShutdownOptions {
  /** HTTP servers to stop. Requests they are already handling may finish. */
  servers: Server[];
  /** Timers and background loops to stop at once. */
  stop: Array<() => unknown>;
  /** Background work already running, such as a display publication pass. */
  pending?: () => Iterable<Promise<unknown>>;
  /** Runs once everything above finished or the deadline passed. */
  close: () => void;
  deadlineMs?: number;
  log?: (message: string) => void;
  exit?: (code: number) => void;
}

/**
 * Graceful stop for a long-running HTTP service.
 *
 * `server.close()` alone stops new connections but waits for every open one,
 * and a request waiting on GitHub can hold one far longer than systemd waits.
 * This stops new work, lets requests and background work already running
 * finish, closes the database, and exits by the deadline in any case.
 * A second signal joins the stop already in progress.
 */
export class ServiceShutdown {
  private stopping?: Promise<void>;
  private readonly active = new Set<ServerResponse>();
  private readonly options: Required<Omit<ServiceShutdownOptions, "pending">> & Pick<ServiceShutdownOptions, "pending">;

  constructor(options: ServiceShutdownOptions) {
    this.options = { deadlineMs: SHUTDOWN_DEADLINE_MS, log: message => console.log(message), exit: code => process.exit(code), ...options };
    for (const server of options.servers) this.track(server);
  }

  /** Answers new requests with 503 once stopping and records the ones running. */
  private track(server: Server): void {
    const handlers = server.listeners("request") as Array<(req: IncomingMessage, res: ServerResponse) => void>;
    server.removeAllListeners("request");
    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      if (this.stopping) {
        res.shouldKeepAlive = false;
        res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Service stopping" }));
        return;
      }
      this.active.add(res);
      res.once("close", () => this.active.delete(res));
      for (const handler of handlers) handler.call(server, req, res);
    });
  }

  stop(signal: string): Promise<void> {
    if (this.stopping) {
      this.options.log(`${signal} received again; shutdown already in progress`);
      return this.stopping;
    }
    this.stopping = this.run(signal);
    return this.stopping;
  }

  private async run(signal: string): Promise<void> {
    const { servers, stop, pending, close, deadlineMs, log, exit } = this.options;
    log(`${signal} received; stopping (${this.active.size} request(s) in progress)`);
    for (const action of stop) {
      try { action(); } catch (error) { log(`Stopping background work failed: ${message(error)}`); }
    }
    // Responses still to be written close their connection instead of
    // keeping it alive. close() drops the idle connections and the listener.
    for (const res of this.active) if (!res.headersSent) res.shouldKeepAlive = false;
    const closed = servers.map(server => new Promise<void>(resolve => server.close(() => resolve())));
    const background = [...(pending?.() ?? [])].map(work => work.catch(() => {}));
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      Promise.all([...closed, ...background]).then(() => "drained" as const),
      new Promise<"deadline">(resolve => { timer = setTimeout(() => resolve("deadline"), deadlineMs); }),
    ]);
    clearTimeout(timer);
    if (outcome === "deadline") {
      const requests = [...this.active].map(res => `${res.req.method} ${res.req.url}`);
      log(`Shutdown deadline of ${deadlineMs / 1000}s passed; still pending: ${requests.length ? requests.join(", ") : "no requests"}, background work may be unfinished`);
      for (const server of servers) server.closeAllConnections();
    }
    try { close(); } catch (error) { log(`Closing failed: ${message(error)}`); }
    log(outcome === "drained" ? "Stopped cleanly" : "Stopped at the deadline");
    exit(outcome === "drained" ? 0 : 1);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
