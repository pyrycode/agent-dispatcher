import { AsyncLocalStorage } from "node:async_hooks";
import { JsonClient } from "./fleet-http.js";
import type { GitHubRequest, GitHubResponse } from "./github-broker.js";

const fresh = new AsyncLocalStorage<boolean>();
let connection: JsonClient | undefined;
export function configureGitHubTransport(url: string, token: string): void { connection = new JsonClient(url, token); }
export function freshGitHubRead<T>(work: () => Promise<T>): Promise<T> { return fresh.run(true, work); }
export function githubResponse(result: GitHubResponse): Response {
  return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status,
    ...(result.status === 429 ? { statusText: "API rate limit exceeded" } : {}), headers: result.headers });
}
export const githubFetch: typeof fetch = async (input, init) => {
  if (!connection) return fetch(input, init);
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== "https://api.github.com") throw new Error("Shared GitHub transport refuses another upstream host");
  const envelope: GitHubRequest = { method: req.method, path: url.pathname + url.search,
    headers: Object.fromEntries(req.headers),
    ...(!["GET", "HEAD"].includes(req.method) ? { body: await req.text() } : {}), fresh: fresh.getStore() === true };
  // The central service owns the upstream credential. Never send a local
  // GitHub token to the manager or include it in a shared cache key.
  delete envelope.headers!.authorization;
  try { return githubResponse(await connection.call<GitHubResponse>("/github", envelope)); }
  catch { throw new Error("Shared GitHub unavailable; no direct fallback was attempted"); }
};

export function githubPauseMs(error: unknown, now = Date.now()): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/API rate limit|shared GitHub|Shared GitHub/.test(message)) return null;
  const headers = (error as any)?.headers ?? (error as any)?.response?.headers;
  const reset = Number(headers?.["x-ratelimit-reset"]) * 1000;
  // Recheck at least once a minute so signals and completed runs are handled.
  return Number.isFinite(reset) && reset > now ? Math.min(60_000, Math.max(1000, reset - now + 5000)) : 60_000;
}
