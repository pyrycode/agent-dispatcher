import { githubFetch, freshGitHubRead } from "./github-transport.js";
import type { CoordinationRecord } from "./recovery-facts.js";

const ticket = (value: string) => {
  const match = value.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
  if (!match) throw new Error("Invalid coordination ticket");
  return { repo: match[1], number: match[2] };
};
/** Both snapshots must be complete and current. An absent branch is never proof of no overlap. */
export function coordinationCanRelease(record: CoordinationRecord | undefined, left: string[] | null, right: string[] | null): boolean {
  return !!record?.paths.length && !!left?.length && !!right?.length && !left.some(p => right.includes(p));
}
async function changedFiles(ref: string, token: string): Promise<string[] | null> {
  const { repo, number } = ticket(ref);
  const owner = repo.split("/")[0];
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
  const response = await githubFetch(`https://api.github.com/repos/${repo}/pulls?state=open&head=${encodeURIComponent(owner + ":feature/" + number)}&per_page=100`, { headers });
  if (!response.ok || response.headers.get("link")?.includes('rel="next"')) return null;
  const prs = await response.json() as any[];
  if (prs.length !== 1 || prs[0].head?.ref !== `feature/${number}` || prs[0].head?.repo?.full_name !== repo) return null;
  const files = await githubFetch(`https://api.github.com/repos/${repo}/pulls/${prs[0].number}/files?per_page=100`, { headers });
  if (!files.ok || files.headers.get("link")?.includes('rel="next"')) return null;
  return (await files.json() as any[]).flatMap(f => typeof f.filename === "string" ? [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])] : []);
}
export async function verifyCoordination(record: CoordinationRecord | undefined, token: string): Promise<boolean> {
  if (!record) return false;
  return freshGitHubRead(async () => {
    const [left, right] = await Promise.all([changedFiles(record.ticket, token), changedFiles(record.blocker, token)]);
    return coordinationCanRelease(record, left, right);
  });
}
