// Confirmed failures on main belong to separate fix tickets. Link them before
// leaving the original at its live gate, so even an exhausted rework budget waits.
import { shortTestName, type FlakyRunContext, type FlakyTicketClient } from "./flaky-tickets.js";

export interface InheritedTicketClient extends FlakyTicketClient {
  listOpenIssuesWithLabel(label: string): Promise<{ number: number; nodeId: string; title?: string; body: string }[]>;
  getItemStatus(issueNumber: number): Promise<string | null>;
  moveItemToTop(itemId: string): Promise<void>;
  /** Links two issues and reads the relationship back before resolving. */
  addBlocker(issueNumber: number, blockerNumber: number): Promise<void>;
}
export interface InheritedTicketResult {
  blockers: { name: string; issue: number }[];
  untracked: string[];
  /** The gated ticket itself is already the fix owner for these tests. */
  owned?: string[];
}
export function inheritedMarker(name: string): string {
  return `<!-- inherited-live-test: ${name} -->`;
}
function matchesTrackingTicket(issue: { title?: string; body: string }, name: string): boolean {
  if (issue.body.includes(`\`${name}\``)) return true;
  // Verifier tracking tickets may name only the method in the title.
  const title = issue.title ?? "";
  const words = title.toLowerCase().split(/[^a-z0-9_]+/);
  return /pre-existing|unmasked|drift|flaky|tracking|regression|bug|failure|broken|intermittent/i.test(title)
    && words.includes(shortTestName(name).toLowerCase());
}
function evidence(name: string, ctx: FlakyRunContext): string {
  const r = ctx.report;
  return [
    `\`${name}\` failed on both the gated branch and the base commit.`,
    `- Found while testing #${ctx.gatedIssue} at ${ctx.at}`,
    `- Branch \`${r.branchName}\` at \`${r.headSha}\``,
    `- Base \`${r.baseRef}\` at \`${r.baseSha}\``,
    `- Branch report: \`${r.outputPath}\``,
    `- Base report: \`${r.baselineOutputPath ?? "unavailable"}\``,
  ].join("\n");
}

/** Search first. A failed board/link write remains untracked and is retried on
 * the same open issue on the next attempt. Never report an unconfirmed blocker. */
export async function recordInheritedTests(
  client: InheritedTicketClient, failures: readonly string[], ctx: FlakyRunContext,
): Promise<InheritedTicketResult> {
  const result: InheritedTicketResult = { blockers: [], untracked: [], owned: [] };
  const names = [...new Set(failures)];
  if (names.length === 0) return result;
  let open: { number: number; nodeId: string; title?: string; body: string }[];
  try {
    open = await client.listOpenIssuesWithLabel("bug");
  } catch (error) {
    console.warn(`   ⚠️ Could not search inherited live failures: ${error}`);
    return { blockers: [], untracked: names };
  }
  for (const name of names) {
    try {
      // Exact markers win; quoted full names also find verifier/hand-filed bugs.
      const owner = open.find(i => i.number === ctx.gatedIssue);
      const ownerMarked = owner?.body.split("\n").some(line => line.trim() === inheritedMarker(name));
      const candidates = open.filter(i => i.number !== ctx.gatedIssue).sort((a, b) => a.number - b.number);
      let issue = candidates.find(i => i.body.split("\n").some(line => line.trim() === inheritedMarker(name)))
        ?? candidates.find(i => matchesTrackingTicket(i, name));
      if (ownerMarked || (!issue && owner && matchesTrackingTicket(owner, name))) {
        result.owned!.push(name);
        continue;
      }
      if (!issue) {
        const body = ["## User Story", "",
          `As a maintainer, I want \`${name}\` to pass on main so unrelated tickets can complete their live checks.`,
          "", "## Context", "", evidence(name, ctx), "", "## Acceptance Criteria", "",
          "- [ ] Diagnose the shared failure from the branch and base reports.",
          "- [ ] Repair the test or product without weakening the assertion or skipping the test.",
          "- [ ] The named live test passes on the repaired main branch.", "", inheritedMarker(name)].join("\n");
        const created = await client.createIssue(`fix shared live failure: ${shortTestName(name)}`, body, ["bug"]);
        issue = { ...created, body };
        open.push(issue);
      } else {
        await client.addComment(issue.number, `## Shared failure seen again\n\n${evidence(name, ctx)}`);
      }
      const status = await client.getItemStatus(issue.number);
      const itemId = await client.addItemToProject(issue.nodeId);
      const entersBacklog = status === null || status === "Inbox" || status === "Done";
      if (entersBacklog) await client.updateItemStatus(itemId, "Backlog");
      if (entersBacklog || status === "Backlog") await client.moveItemToTop(itemId);
      await client.addBlocker(ctx.gatedIssue, issue.number);
      result.blockers.push({ name, issue: issue.number });
    } catch (error) {
      console.warn(`   ⚠️ Could not confirm a fix-ticket blocker for ${name}: ${error}`);
      result.untracked.push(name);
    }
  }
  return result;
}
