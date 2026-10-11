import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceRecord } from "./recovery-facts.js";
import { githubFetch } from "./github-transport.js";
import { scrubCredentials } from "./agent-runtime.js";

const cached = new Map<string, { stamp: string; record: EvidenceRecord }>();
/** Inventory only. No authored text, raw stderr, credentials or payloads leave this computer. */
export function recoveryInventory(logs: string, project: string, machine: string, issues: number[]): EvidenceRecord[] {
  const wanted = new Set(issues);
  const names = readdirSync(logs).filter(n => /_#\d+\.(?:log|stderr\.log|meta\.json)$/.test(n) && !n.includes("_recovery_"));
  const byIssue = new Map<number, string[]>();
  for (const name of names) {
    const issue = Number(name.match(/_#(\d+)\./)![1]);
    if (wanted.has(issue)) byIssue.set(issue, [...byIssue.get(issue) ?? [], name]);
  }
  const records: EvidenceRecord[] = [];
  for (const [issue, files] of byIssue) for (const source of files.sort().slice(-6)) {
    const path = join(logs, source); const s = statSync(path);
    if (!s.isFile() || s.size > 64 * 1024 * 1024) continue;
    const stamp = `${s.size}/${s.mtimeMs}`; let record = cached.get(path)?.stamp === stamp ? cached.get(path)!.record : undefined;
    if (!record) {
      const bytes = readFileSync(path);
      let outcome: EvidenceRecord["outcome"] = "unknown";
      // Only classify terminal envelopes. Free text and a zero process exit are not a pass.
      for (const line of bytes.toString("utf8").slice(-24000).split("\n").reverse()) {
        try {
          const value = JSON.parse(line);
          if (value.status === "completed" || value.status === "blocked") { outcome = value.status; break; }
          if (value.is_error === true || value.type === "turn.failed") { outcome = "errored"; break; }
        } catch { /* ordinary log line */ }
      }
      record = { ticket: `${project}#${issue}`, machine, source, digest: createHash("sha256").update(bytes).digest("hex"),
        bytes: s.size, modified: s.mtimeMs, outcome };
      cached.set(path, { stamp, record });
    }
    records.push(record);
  }
  if (cached.size > 10000) cached.clear();
  return records;
}

export function relatedTickets(project: string, texts: string[], blockerUrls: string[], allowed: string[]): string[] {
  const found = new Set<string>();
  for (const text of [...texts, ...blockerUrls]) {
    for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)/g)) {
      if (allowed.includes(match[1])) found.add(`${match[1]}#${match[2]}`);
    }
    for (const match of text.matchAll(/(?:^|\s)#([1-9]\d*)\b/g)) found.add(`${project}#${match[1]}`);
  }
  return [...found].slice(0, 8);
}

/** Fixed GitHub destinations, bounded newest comments, read-only through the existing broker. */
export async function relatedEvidence(tickets: string[], token: string) {
  return Promise.all(tickets.map(async ticket => {
    const [repo, number] = ticket.split("#");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(number)) throw new Error("Invalid related ticket");
    const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
    const base = `https://api.github.com/repos/${repo}/issues/${number}`;
    const issue = await githubFetch(base, { headers, signal: AbortSignal.timeout(30_000) });
    if (!issue.ok) return { ticket, unavailable: issue.status };
    const value = await issue.json() as any;
    const first = await githubFetch(`${base}/comments?per_page=100`, { headers, signal: AbortSignal.timeout(30_000) });
    let comments: any[] = [];
    if (first.ok) {
      const last = first.headers.get("link")?.match(/<([^>]+)>; rel="last"/)?.[1];
      // Never follow an arbitrary URL from evidence or a redirect.
      if (last?.startsWith(`${base}/comments?`) && !last.includes("#")) {
        const response = await githubFetch(last, { headers, signal: AbortSignal.timeout(30_000) });
        if (response.ok) comments = await response.json() as any[];
      } else comments = await first.json() as any[];
    }
    return { ticket, title: value.title, state: value.state, body: scrubCredentials(String(value.body ?? "").slice(-8000)),
      comments: comments.slice(-8).map(c => ({ url: c.html_url, updated: c.updated_at, body: scrubCredentials(String(c.body ?? "").slice(-6000)) })) };
  }));
}
