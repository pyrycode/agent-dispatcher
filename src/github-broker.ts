/** One upstream connection and read cache for every managed computer. */
export interface GitHubRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  fresh?: boolean;
}
export interface GitHubResponse { status: number; headers: Record<string, string>; body: string }
interface Budget { remaining: number; reset: number; heldUntil?: number }
const REQUEST_HEADERS = ["accept", "content-type", "x-github-api-version"];
const RESPONSE_HEADERS = ["content-type", "link", "etag", "last-modified", "retry-after", "x-ratelimit-resource", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-used", "x-oauth-scopes", "x-accepted-oauth-scopes"];

export function githubRead(request: GitHubRequest): boolean {
  if (["GET", "HEAD"].includes(request.method)) return true;
  if (request.path !== "/graphql" || request.method !== "POST") return false;
  const body = JSON.parse(request.body ?? "{}");
  if (typeof body.query !== "string") throw new Error("Invalid GraphQL request");
  // Unknown/multi-operation documents are conservative writes. Quoted text
  // cannot turn a mutation into a cacheable read.
  const document = body.query.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n]*/g, " ").trim();
  return /^(?:query\b|\{)/.test(document) && !/\bmutation\b|\bsubscription\b/.test(document);
}

export class GitHubBroker {
  private readonly cache = new Map<string, { result: GitHubResponse; expires: number }>();
  private readonly pending = new Map<string, Promise<GitHubResponse>>();
  private readonly budgets = new Map<string, Budget>();
  private generation = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly stats = { upstream: 0, hits: 0, held: 0, writes: 0 };
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  constructor(private readonly config: {
    token: string; projects: string[]; cacheMs?: number; readReserve?: number;
    fetcher?: typeof fetch; now?: () => number;
  }) {
    if (!config.token || !config.projects.length || config.projects.some(p => !/^[\w.-]+\/[\w.-]+$/.test(p))) throw new Error("Invalid GitHub broker configuration");
    this.now = config.now ?? Date.now; this.fetcher = config.fetcher ?? fetch;
  }
  status() { return { ...this.stats, cacheEntries: this.cache.size, budgets: Object.fromEntries(this.budgets) }; }
  async request(project: string, request: GitHubRequest): Promise<GitHubResponse> {
    this.validate(project, request);
    const read = githubRead(request);
    const headers = new Headers(request.headers);
    const key = JSON.stringify([project, request.method, request.path, request.body ?? "", headers.get("accept") ?? "", headers.get("x-github-api-version") ?? ""]);
    if (!read) {
      // A write is never retried by this service. Serialise mutations, then
      // invalidate even on an uncertain failure. No stale read survives it.
      this.generation++; this.cache.clear();
      const work = this.writes.then(() => this.upstream(request, false));
      this.writes = work.catch(() => {});
      try { return await work; }
      finally { this.generation++; this.cache.clear(); }
    }
    await this.writes;
    const generation = this.generation;
    const cached = this.cache.get(key);
    const fresh = request.fresh || /\/pulls(?:\/|\?)|\bpullRequest\s*\(/.test(request.path + (request.body ?? ""));
    if (!fresh && cached && cached.expires > this.now()) { this.stats.hits++; return structuredClone(cached.result); }
    const pendingKey = `${generation}:${key}`;
    const existing = this.pending.get(pendingKey);
    if (existing) { this.stats.hits++; return structuredClone(await existing); }
    const work = this.upstream(request, true).then(result => {
      let errors = false;
      if (request.path === "/graphql") { try { errors = !!JSON.parse(result.body).errors?.length; } catch { errors = true; } }
      if (generation === this.generation && result.status >= 200 && result.status < 300 && !errors && result.body.length < 1024 * 1024) {
        if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { result, expires: this.now() + (this.config.cacheMs ?? 120_000) });
      }
      return result;
    }).finally(() => { this.pending.delete(pendingKey); });
    this.pending.set(pendingKey, work);
    return structuredClone(await work);
  }
  private validate(project: string, req: GitHubRequest): void {
    if (!this.config.projects.includes(project)) throw new Error("Repository not allowed");
    if (!req || !["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"].includes(req.method) || typeof req.path !== "string" ||
        !req.path.startsWith("/") || req.path.startsWith("//") || /[\\\r\n\0#]/.test(req.path) ||
        req.body !== undefined && (typeof req.body !== "string" || req.body.length > 1024 * 1024)) throw new Error("Invalid GitHub request");
    let path: string;
    try { path = decodeURIComponent(req.path.split("?")[0]); } catch { throw new Error("Invalid GitHub path"); }
    if (path.split("/").some(p => p === "." || p === "..") || /[%\\]/.test(path)) throw new Error("Invalid GitHub path");
    const repo = path.match(/^\/repos\/([^/]+\/[^/]+)(?:\/|$)/)?.[1];
    // Cross-project blocker/source reads are allowed among configured repos.
    // Writes are restricted to the authenticated local project's repository.
    if (repo ? !(githubRead(req) ? this.config.projects.includes(repo) : repo === project)
      : !["/graphql", "/user", "/rate_limit"].includes(path) && !(path === "/" && ["GET", "HEAD"].includes(req.method)) && !/^\/orgs\/[^/]+(?:\/memberships\/[^/]+)?$/.test(path)) throw new Error("GitHub endpoint not allowed");
  }
  private async upstream(req: GitHubRequest, read: boolean): Promise<GitHubResponse> {
    const resource = req.path === "/graphql" ? "graphql" : "core";
    const budget = this.budgets.get(resource);
    const held = budget && ((budget.heldUntil ?? 0) > this.now() || budget.reset > this.now() && budget.remaining <= (read ? this.config.readReserve ?? 200 : 0));
    if (held) {
      this.stats.held++;
      return { status: 429, headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Math.max(budget.reset, budget.heldUntil ?? 0) / 1000)) }, body: JSON.stringify({ message: "API rate limit exceeded: shared GitHub connection paused; result writes retain the reserved allowance" }) };
    }
    const incoming = new Headers(req.headers);
    const headers = new Headers({ authorization: `Bearer ${this.config.token}` });
    for (const name of REQUEST_HEADERS) if (incoming.has(name)) headers.set(name, incoming.get(name)!);
    this.stats.upstream++; if (!read) this.stats.writes++;
    const result = await this.fetcher(`https://api.github.com${req.path}`, {
      method: req.method, headers, ...(req.body !== undefined ? { body: req.body } : {}), redirect: "error", signal: AbortSignal.timeout(25_000),
    });
    const remaining = Number(result.headers.get("x-ratelimit-remaining"));
    const reset = Number(result.headers.get("x-ratelimit-reset")) * 1000;
    const bucket = result.headers.get("x-ratelimit-resource") ?? resource;
    if (result.headers.has("x-ratelimit-remaining") && Number.isFinite(remaining) && reset > 0) {
      const prior = this.budgets.get(bucket);
      // Concurrent reads can arrive out of order. Never restore spent points
      // within the same reset window from an older response.
      this.budgets.set(bucket, { remaining: prior?.reset === reset ? Math.min(prior.remaining, remaining) : remaining, reset });
    }
    if (result.status === 429 || result.status === 403 && result.headers.has("retry-after")) {
      const seconds = Number(result.headers.get("retry-after")) || 60;
      const prior = this.budgets.get(resource) ?? { remaining: 5000, reset: this.now() };
      this.budgets.set(resource, { ...prior, heldUntil: this.now() + seconds * 1000 });
    }
    const out: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) if (result.headers.has(name)) out[name] = result.headers.get(name)!;
    return { status: result.status, headers: out, body: await result.text() };
  }
}
