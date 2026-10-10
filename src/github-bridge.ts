import { createServer, type Server } from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, symlinkSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonClient, listen } from "./fleet-http.js";
import type { GitHubRequest, GitHubResponse } from "./github-broker.js";
import { configureGitHubTransport } from "./github-transport.js";

/** gh's documented http_unix_socket keeps commands/files on the worker. */
export async function serveGitHubBridge(socket: string, request: (req: GitHubRequest) => Promise<GitHubResponse>): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== "api.github.com") { res.writeHead(403); res.end('{"message":"GitHub API host required"}'); return; }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error("Request too large"); chunks.push(Buffer.from(chunk)); }
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name, value]) => name !== "authorization" && typeof value === "string")) as Record<string, string>;
      const result = await request({ method: req.method ?? "GET", path: req.url ?? "/", headers,
        ...(body ? { body } : {}),
        // PR state/head/merge checks need fresh evidence, including CLI reads.
        fresh: /\/pulls(?:\/|\?)|\bpullRequest\s*\(/.test((req.url ?? "") + body),
      });
      res.writeHead(result.status, result.headers); res.end(result.body);
    } catch {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"message":"Shared GitHub unavailable; no direct fallback was attempted"}');
    }
  });
  server.requestTimeout = 30_000;
  return listen(server, socket);
}

/** Separate process: synchronous gh calls must not block their own proxy. */
export function configureGitHubCLI(directory: string, socket: string, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const original = env.GH_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh");
  if (directory === original) throw new Error("Shared GitHub requires a separate CLI configuration");
  if (existsSync(join(original, "hosts.yml")) && !existsSync(join(directory, "hosts.yml"))) symlinkSync(join(original, "hosts.yml"), join(directory, "hosts.yml"));
  const prior = existsSync(join(original, "config.yml")) ? readFileSync(join(original, "config.yml"), "utf8").replace(/^http_unix_socket:.*\n?/gm, "") : "";
  writeFileSync(join(directory, "config.yml"), `${prior}\nhttp_unix_socket: ${JSON.stringify(socket)}\n`, { mode: 0o600 });
}

export async function startGitHubBridge(env: NodeJS.ProcessEnv): Promise<ChildProcess | undefined> {
  if (env.PYRY_SHARED_GITHUB !== "1") return;
  if (!env.PYRY_MANAGER_URL || !env.PYRY_MANAGER_TOKEN) throw new Error("Shared GitHub requires managed dispatch");
  const directory = mkdtempSync(join(tmpdir(), "pyry-github-"));
  const socket = join(directory, "api.sock");
  // Preserve the credential lookup and Git protocol without copying secrets.
  configureGitHubCLI(directory, socket, env);
  const child = fork(fileURLToPath(new URL("./github-bridge-bin.ts", import.meta.url)), [], {
    execArgv: ["--import", import.meta.resolve("tsx")], env: { PATH: env.PATH, HOME: env.HOME }, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Shared GitHub bridge startup timed out")); }, 10_000);
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Shared GitHub bridge exited before startup")); });
    child.once("message", message => { clearTimeout(timer); if (message === "ready") resolve(); else reject(new Error("Shared GitHub bridge startup failed")); });
    child.send({ socket, url: env.PYRY_MANAGER_URL, token: env.PYRY_MANAGER_TOKEN });
  });
  env.GH_CONFIG_DIR = directory;
  configureGitHubTransport(env.PYRY_MANAGER_URL, env.PYRY_MANAGER_TOKEN);
  child.unref(); child.disconnect();
  process.once("exit", () => child.kill());
  return child;
}

export async function runGitHubBridge(config: { socket: string; url: string; token: string }): Promise<Server> {
  const client = new JsonClient(config.url, config.token);
  return serveGitHubBridge(config.socket, request => client.call("/github", request));
}
