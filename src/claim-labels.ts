import type { Claim } from "./fleet-store.js";

const PREFIX = "claim:";
interface LabelledIssue { number: number; labels: string[] }
interface ClaimLabelApi {
  listLabels(project: string): Promise<string[]>;
  listIssues(project: string, label: string): Promise<LabelledIssue[]>;
  createLabel(project: string, label: string): Promise<void>;
  addLabel(project: string, issue: number, label: string): Promise<void>;
  removeLabel(project: string, issue: number, label: string): Promise<void>;
}
interface SyncResult { added: number; removed: number; errors: string[] }

/** One central display-only writer. It never changes claims or grants. */
export class ClaimLabelMirror {
  private pending: Promise<SyncResult> | undefined;
  constructor(private readonly projects: string[], private readonly claims: () => readonly Claim[], private readonly api: ClaimLabelApi) {
    if (!Array.isArray(projects) || projects.some(p => typeof p !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(p)) || new Set(projects).size !== projects.length) throw new Error("Invalid claim-label projects");
  }
  sync(): Promise<SyncResult> {
    if (!this.pending) this.pending = this.syncOnce().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async syncOnce(): Promise<SyncResult> {
    const result: SyncResult = { added: 0, removed: 0, errors: [] };
    for (const project of this.projects) {
      try {
        const catalog = new Set((await this.api.listLabels(project)).filter(l => l.startsWith(PREFIX)));
        const actual = new Map<number, string[]>();
        // Query every existing claim label, including retired machine names.
        // This recovers freed tickets after a restart without a local cache.
        for (const label of catalog) for (const issue of await this.api.listIssues(project, label)) actual.set(issue.number, issue.labels);
        const numbers = new Set(actual.keys());
        for (const claim of this.claims()) {
          if (!claim.ticket.startsWith(`${project}#`)) continue;
          const number = claim.ticket.slice(project.length + 1);
          if (/^[1-9]\d*$/.test(number)) numbers.add(Number(number));
        }
        for (const number of numbers) {
          // GitHub reads can take time. Use the current owner, including frees
          // made during this pass. A concurrent change converges next pass.
          const owner = this.claims().find(c => c.ticket === `${project}#${number}`);
          const wanted = owner ? `${PREFIX}${owner.machine}` : undefined;
          const labels = (actual.get(number) ?? []).filter(l => l.startsWith(PREFIX));
          if (wanted && !labels.includes(wanted)) {
            if (!catalog.has(wanted)) { await this.api.createLabel(project, wanted); catalog.add(wanted); }
            await this.api.addLabel(project, number, wanted);
            result.added++;
          }
          for (const label of labels) if (label !== wanted) {
            await this.api.removeLabel(project, number, label);
            result.removed++;
          }
        }
      } catch (error) {
        result.errors.push(`${project}: ${error instanceof Error ? error.message : "label sync failed"}`);
      }
    }
    return result;
  }
}

/** Uses the existing dispatcher token, with only narrow claim-label mutations. */
export class GitHubClaimLabels implements ClaimLabelApi {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    if (!token) throw new Error("Missing GitHub claim-label credential");
  }
  private async request(path: string, method = "GET", body?: unknown): Promise<Response> {
    const response = await this.fetcher(`https://api.github.com/repos/${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok && !(method === "DELETE" && response.status === 404)) throw new Error(`GitHub label request failed: HTTP ${response.status}`);
    return response;
  }
  private async list(path: string): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const response = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error("Invalid GitHub label listing");
      out.push(...items);
      if (!/rel="next"/.test(response.headers.get("link") ?? "")) return out;
    }
  }
  async listLabels(project: string): Promise<string[]> {
    return (await this.list(`${project}/labels`)).map(l => l.name);
  }
  async listIssues(project: string, label: string): Promise<LabelledIssue[]> {
    return (await this.list(`${project}/issues?state=all&labels=${encodeURIComponent(label)}`))
      .filter(i => !i.pull_request).map(i => ({ number: i.number, labels: i.labels.map((l: any) => typeof l === "string" ? l : l.name) }));
  }
  async createLabel(project: string, label: string): Promise<void> {
    try {
      await this.request(`${project}/labels`, "POST", { name: label, color: "1D76DB", description: "Computer owning this ticket. Managed by the fleet claim service." });
    } catch (error) {
      // Another writer may have created the same label. Verify it exists;
      // failures still reach the next periodic retry without touching claims.
      await this.request(`${project}/labels/${encodeURIComponent(label)}`).catch(() => { throw error; });
    }
  }
  async addLabel(project: string, issue: number, label: string): Promise<void> {
    await this.request(`${project}/issues/${issue}/labels`, "POST", { labels: [label] });
  }
  async removeLabel(project: string, issue: number, label: string): Promise<void> {
    await this.request(`${project}/issues/${issue}/labels/${encodeURIComponent(label)}`, "DELETE");
  }
}

/** Visibility failures never prevent the authority from serving work. */
export function startClaimLabelSync(config: { tokenEnv: string; projects: string[] } | undefined, claims: () => readonly Claim[], env = process.env): () => void {
  if (!config) return () => {};
  try {
    const mirror = new ClaimLabelMirror(config.projects, claims, new GitHubClaimLabels(env[config.tokenEnv] ?? ""));
    const tick = () => void mirror.sync().then(result => {
      if (result.added || result.removed) console.log(`Claim labels: added ${result.added}, removed ${result.removed}`);
      for (const error of result.errors) console.warn(`Claim label sync will retry: ${error}`);
    }).catch(() => console.warn("Claim label sync will retry"));
    tick();
    const timer = setInterval(tick, 60_000);
    timer.unref();
    return () => clearInterval(timer);
  } catch (error) {
    console.warn(`Claim labels disabled: ${error instanceof Error ? error.message : "invalid configuration"}`);
    return () => {};
  }
}
