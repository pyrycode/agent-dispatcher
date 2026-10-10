// Confirmed failures on main belong to separate fix tickets. Link them before
// leaving the original at its live gate, so even an exhausted rework budget waits.
// Failures new in one run share one ticket: tests that break together on one base
// commit usually share a cause, and one ticket per test fixed it twice (#107).
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
type OpenIssue = { number: number; nodeId: string; title?: string; body: string };

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
function evidence(names: readonly string[], ctx: FlakyRunContext): string {
  const r = ctx.report;
  const subject = names.length === 1
    ? `\`${names[0]}\` failed on both the gated branch and the base commit.`
    : [`These ${names.length} tests failed on both the gated branch and the base commit:`, ...names.map(n => `- \`${n}\``)].join("\n");
  return [
    subject,
    `- Found while testing #${ctx.gatedIssue} at ${ctx.at}`,
    `- Branch \`${r.branchName}\` at \`${r.headSha}\``,
    `- Base \`${r.baseRef}\` at \`${r.baseSha}\``,
    `- Branch report: \`${r.outputPath}\``,
    `- Base report: \`${r.baselineOutputPath ?? "unavailable"}\``,
  ].join("\n");
}
function fixTicket(names: readonly string[], ctx: FlakyRunContext): { title: string; body: string } {
  if (names.length === 1) {
    const [name] = names;
    const body = ["## User Story", "",
      `As a maintainer, I want \`${name}\` to pass on main so unrelated tickets can complete their live checks.`,
      "", "## Context", "", evidence(names, ctx), "", "## Acceptance Criteria", "",
      "- [ ] Diagnose the shared failure from the branch and base reports.",
      "- [ ] Repair the test or product without weakening the assertion or skipping the test.",
      "- [ ] The named live test passes on the repaired main branch.", "", inheritedMarker(name)].join("\n");
    return { title: `fix shared live failure: ${shortTestName(name)}`, body };
  }
  // One marker per test, so a later run that sees any of them again finds this ticket.
  const body = ["## User Story", "",
    `As a maintainer, I want these ${names.length} tests to pass on main so unrelated tickets can complete their live checks.`,
    "", "## Context", "", evidence(names, ctx), "",
    "They started failing together on one base commit, so they most likely share one cause.",
    "", "## Acceptance Criteria", "",
    "- [ ] Diagnose what the failures share from the branch and base reports before repairing any of them. Split a test off only when its cause turns out to be independent.",
    "- [ ] Repair the tests or product without weakening an assertion or skipping a test.",
    "- [ ] Every named live test passes on the repaired main branch.", "", ...names.map(inheritedMarker)].join("\n");
  return { title: `fix shared live failures: ${names.length} tests fail on main`, body };
}

/** Search first. A failed board/link write remains untracked and is retried on
 * the same open issue on the next attempt. Never report an unconfirmed blocker. */
export async function recordInheritedTests(
  client: InheritedTicketClient, failures: readonly string[], ctx: FlakyRunContext,
): Promise<InheritedTicketResult> {
  const result: InheritedTicketResult = { blockers: [], untracked: [], owned: [] };
  const names = [...new Set(failures)];
  if (names.length === 0) return result;
  let open: OpenIssue[];
  try {
    open = await client.listOpenIssuesWithLabel("bug");
  } catch (error) {
    console.warn(`   ⚠️ Could not search inherited live failures: ${error}`);
    return { blockers: [], untracked: names };
  }
  const owner = open.find(i => i.number === ctx.gatedIssue);
  const candidates = open.filter(i => i.number !== ctx.gatedIssue).sort((a, b) => a.number - b.number);
  const groups = new Map<number, { issue: OpenIssue; names: string[]; created: boolean }>();
  const untrackedNow: string[] = [];
  for (const name of names) {
    // Exact markers win; quoted full names also find verifier/hand-filed bugs.
    const ownerMarked = owner?.body.split("\n").some(line => line.trim() === inheritedMarker(name));
    const issue = candidates.find(i => i.body.split("\n").some(line => line.trim() === inheritedMarker(name)))
      ?? candidates.find(i => matchesTrackingTicket(i, name));
    if (ownerMarked || (!issue && owner && matchesTrackingTicket(owner, name))) {
      result.owned!.push(name);
    } else if (issue) {
      const group = groups.get(issue.number) ?? { issue, names: [], created: false };
      group.names.push(name);
      groups.set(issue.number, group);
    } else {
      untrackedNow.push(name);
    }
  }
  if (untrackedNow.length > 0) {
    try {
      const { title, body } = fixTicket(untrackedNow, ctx);
      const created = await client.createIssue(title, body, ["bug", "priority:low"]);
      groups.set(created.number, { issue: { ...created, title, body }, names: untrackedNow, created: true });
    } catch (error) {
      console.warn(`   ⚠️ Could not file a fix ticket for ${untrackedNow.join(", ")}: ${error}`);
    }
  }
  const confirmed = new Map<string, number>();
  for (const { issue, names: groupNames, created } of groups.values()) {
    try {
      if (!created) await client.addComment(issue.number, `## Shared failure seen again\n\n${evidence(groupNames, ctx)}`);
      const status = await client.getItemStatus(issue.number);
      const itemId = await client.addItemToProject(issue.nodeId);
      const entersBacklog = status === null || status === "Inbox" || status === "Done";
      if (entersBacklog) await client.updateItemStatus(itemId, "Backlog");
      if (entersBacklog || status === "Backlog") await client.moveItemToTop(itemId);
      await client.addBlocker(ctx.gatedIssue, issue.number);
      for (const name of groupNames) confirmed.set(name, issue.number);
    } catch (error) {
      console.warn(`   ⚠️ Could not confirm a fix-ticket blocker for ${groupNames.join(", ")}: ${error}`);
    }
  }
  for (const name of names) {
    if (result.owned!.includes(name)) continue;
    const issue = confirmed.get(name);
    if (issue === undefined) result.untracked.push(name);
    else result.blockers.push({ name, issue });
  }
  return result;
}
