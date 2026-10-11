import type { GitHubBroker } from "./github-broker.js";

export interface DesiredRevision { consumer: string; dispatcher: string }
/** The claim server looks up consumer main once per fleet, not once per dispatcher. */
export class FleetUpdates {
  private revisions: Record<string, DesiredRevision> = {};
  private checked = 0;
  constructor(private broker: GitHubBroker, private consumers: Record<string, string>, private dispatcherRepo: string, private now = Date.now) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(dispatcherRepo) || Object.entries(consumers).some(([project, repo]) => !/^[\w.-]+\/[\w.-]+$/.test(project) || !/^[\w.-]+\/[\w.-]+$/.test(repo))) throw new Error("Invalid consumer update policy");
  }
  snapshot(): Record<string, DesiredRevision> { return this.now() - this.checked < 900_000 ? structuredClone(this.revisions) : {}; }
  async refresh(): Promise<void> {
    const next: Record<string, DesiredRevision> = {};
    for (const [project, repo] of Object.entries(this.consumers)) {
      const head = await this.broker.request(project, { method: "GET", path: `/repos/${repo}/git/ref/heads/main` });
      if (head.status !== 200) throw new Error("Consumer update lookup unavailable");
      const consumer = JSON.parse(head.body).object?.sha;
      if (!/^[a-f0-9]{40}$/.test(consumer ?? "")) throw new Error("Invalid consumer main revision");
      const submodule = await this.broker.request(project, { method: "GET", path: `/repos/${repo}/contents/dispatcher?ref=${consumer}` });
      if (submodule.status !== 200) throw new Error("Consumer dispatcher pin unavailable");
      const value = JSON.parse(submodule.body);
      if (!/^[a-f0-9]{40}$/.test(value.sha ?? "") || ![`https://github.com/${this.dispatcherRepo}`, `https://github.com/${this.dispatcherRepo}.git`].includes(value.submodule_git_url)) throw new Error("Unexpected dispatcher submodule destination");
      next[project] = { consumer, dispatcher: value.sha };
    }
    this.revisions = next; this.checked = this.now();
  }
}
