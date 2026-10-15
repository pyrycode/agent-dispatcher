// Confirmed failures on main belong to separate fix tickets. Link them before
// leaving the original at its live gate, so even an exhausted rework budget waits.
// Failures new in one run share one ticket: tests that break together on one base
// commit usually share a cause, and one ticket per test fixed it twice (#107).
import { shortTestName, failureTicketLabels, dropStaleOsRequirement, type FlakyRunContext, type FlakyTicketClient } from "./flaky-tickets.js";
import { osName } from "./ticket-requirements.js";

export interface InheritedTicketClient extends InheritedTrackingClient {
  /** Links two issues and reads the relationship back before resolving. */
  addBlocker(issueNumber: number, blockerNumber: number): Promise<void>;
}
/** Enough to find, file and place trackers, for a caller that never links a blocker. */
export interface InheritedTrackingClient extends FlakyTicketClient {
  listOpenIssuesWithLabel(label: string): Promise<{ number: number; nodeId: string; title?: string; body: string; labels?: string[] }[]>;
  getItemStatus(issueNumber: number): Promise<string | null>;
  moveItemToTop(itemId: string): Promise<void>;
}
/**
 * A pre-verifier gate's baseline failures. Each name failed in the gate and
 * also failed on main: in the latest main sweep on an ancestor commit, or
 * when re-run alone on the base commit.
 */
export interface VerifierGateInheritedContext {
  gatedIssue: number;
  at: string;
  gatedBody?: string;
  verifierGate: {
    /** The gate command, as configured. */
    gate: string;
    /** The gated worktree's merged HEAD, or null when it could not be read. */
    commit: string | null;
    /** The gate's own stdout log. */
    outputPath: string;
    /** Where each name failed on main, one line per name. */
    onMain: ReadonlyMap<string, string>;
  };
}
export type InheritedRunContext = FlakyRunContext | VerifierGateInheritedContext;
export interface InheritedTicketResult {
  blockers: { name: string; issue: number }[];
  untracked: string[];
  /** The gated ticket itself is already the fix owner for these tests. */
  owned?: string[];
  /**
   * Advance mode only, and only when the advance holds: every name has an
   * open tracking ticket that names it exactly, and no blocker was added.
   * Absent whenever the result fell back to blockers.
   */
  tracked?: { name: string; issue: number }[];
  /** Advance mode: why the result fell back to blockers. */
  fallbackReason?: string;
}
export interface InheritedTicketOptions {
  /**
   * Try to let the gated ticket advance: find or file a tracker for every
   * name, and add no blocker when each one names its test exactly. Any gap
   * falls back to the blockers of the default mode.
   */
  advance?: boolean;
  /**
   * Advance mode only. False links no blocker when the advance does not
   * hold: every name without an accepted tracker comes back as untracked,
   * with the reason in `fallbackReason`. The pre-verifier gate uses this,
   * since its fallback is a red gate, never a wait.
   */
  addBlockers?: boolean;
}
type OpenIssue = { number: number; nodeId: string; title?: string; body: string; labels?: string[] };

export function inheritedMarker(name: string): string {
  return `<!-- inherited-live-test: ${name} -->`;
}
function hasMarker(issue: { body: string }, name: string): boolean {
  return issue.body.split("\n").some(line => line.trim() === inheritedMarker(name));
}
/** The ticket names this exact test, not just a method of the same name. */
function namesExactly(issue: { title?: string; body: string }, name: string): boolean {
  if (hasMarker(issue, name) || issue.body.includes(`\`${name}\``)) return true;
  // The whole name, not the start of a longer one: `C#bar` is not `C#barBaz`.
  // A full stop ending the sentence still counts.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$#./])${escaped}(?![\\w$#/]|\\.[\\w$#])`).test(issue.title ?? "");
}
function matchesTrackingTicket(issue: { title?: string; body: string }, name: string): boolean {
  if (issue.body.includes(`\`${name}\``)) return true;
  // Verifier tracking tickets may name only the method in the title.
  const title = issue.title ?? "";
  const words = title.toLowerCase().split(/[^a-z0-9_]+/);
  return /pre-existing|unmasked|drift|flaky|tracking|regression|bug|failure|broken|intermittent/i.test(title)
    && words.includes(shortTestName(name).toLowerCase());
}
function evidence(names: readonly string[], ctx: InheritedRunContext, platform: string): string {
  if ("verifierGate" in ctx) {
    const g = ctx.verifierGate;
    const subject = names.length === 1
      ? `\`${names[0]}\` failed in a pre-verifier gate and also fails on main.`
      : [`These ${names.length} tests failed in a pre-verifier gate and also fail on main:`, ...names.map(n => `- \`${n}\``)].join("\n");
    return [
      subject,
      `- Found while verifying #${ctx.gatedIssue} at ${ctx.at}`,
      `- Seen on ${osName(platform)}`,
      `- Gate \`${g.gate}\``,
      `- Gated worktree at \`${g.commit ?? "unknown"}\``,
      `- Gate output: \`${g.outputPath}\``,
      ...names.map(n => `- On main: ${g.onMain.get(n) ?? `\`${n}\` failed on main`}`),
    ].join("\n");
  }
  const r = ctx.report;
  const subject = names.length === 1
    ? `\`${names[0]}\` failed on both the gated branch and the base commit.`
    : [`These ${names.length} tests failed on both the gated branch and the base commit:`, ...names.map(n => `- \`${n}\``)].join("\n");
  return [
    subject,
    `- Found while testing #${ctx.gatedIssue} at ${ctx.at}`,
    `- Seen on ${osName(platform)}`,
    `- Branch \`${r.branchName}\` at \`${r.headSha}\``,
    `- Base \`${r.baseRef}\` at \`${r.baseSha}\``,
    `- Branch report: \`${r.outputPath}\``,
    `- Base report: \`${r.baselineOutputPath ?? "unavailable"}\``,
  ].join("\n");
}
function fixTicket(names: readonly string[], ctx: InheritedRunContext, platform: string): { title: string; body: string } {
  if (names.length === 1) {
    const [name] = names;
    const body = ["## User Story", "",
      `As a maintainer, I want \`${name}\` to pass on main so unrelated tickets can complete their live checks.`,
      "", "## Context", "", evidence(names, ctx, platform), "", "## Acceptance Criteria", "",
      "- [ ] Diagnose the shared failure from the branch and base reports.",
      "- [ ] Repair the test or product without weakening the assertion or skipping the test.",
      "- [ ] The named live test passes on the repaired main branch.", "", inheritedMarker(name)].join("\n");
    return { title: `fix shared live failure: ${shortTestName(name)}`, body };
  }
  // One marker per test, so a later run that sees any of them again finds this ticket.
  const body = ["## User Story", "",
    `As a maintainer, I want these ${names.length} tests to pass on main so unrelated tickets can complete their live checks.`,
    "", "## Context", "", evidence(names, ctx, platform), "",
    "They started failing together on one base commit, so they most likely share one cause.",
    "", "## Acceptance Criteria", "",
    "- [ ] Diagnose what the failures share from the branch and base reports before repairing any of them. Split a test off only when its cause turns out to be independent.",
    "- [ ] Repair the tests or product without weakening an assertion or skipping a test.",
    "- [ ] Every named live test passes on the repaired main branch.", "", ...names.map(inheritedMarker)].join("\n");
  return { title: `fix shared live failures: ${names.length} tests fail on main`, body };
}

/** Search first. A failed board/link write remains untracked and is retried on
 * the same open issue on the next attempt. Never report an unconfirmed blocker. */
export function recordInheritedTests(
  client: InheritedTicketClient, failures: readonly string[], ctx: FlakyRunContext,
  options: InheritedTicketOptions = {},
  platform: string = process.platform,
): Promise<InheritedTicketResult> {
  return recordInherited(client, failures, ctx, options, platform);
}

/**
 * Find or file a tracker for every name, as the live gate's advance mode
 * does, and never link a blocker. `tracked` is set only when every name has
 * an open tracker naming it exactly; otherwise `fallbackReason` says why.
 */
export function trackInheritedTests(
  client: InheritedTrackingClient, failures: readonly string[], ctx: VerifierGateInheritedContext,
  platform: string = process.platform,
): Promise<InheritedTicketResult> {
  return recordInherited(client, failures, ctx, { advance: true, addBlockers: false }, platform);
}

async function recordInherited(
  client: InheritedTrackingClient & { addBlocker?: InheritedTicketClient["addBlocker"] },
  failures: readonly string[], ctx: InheritedRunContext,
  options: InheritedTicketOptions,
  platform: string,
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
  // Names whose tracker matched only by the method name in its title.
  const looselyTracked = new Set<string>();
  for (const name of names) {
    // Exact markers win, then tickets naming the full test, so a loose title
    // match on a same-named method elsewhere is the last resort.
    const ownerMarked = owner !== undefined && hasMarker(owner, name);
    const issue = candidates.find(i => hasMarker(i, name))
      ?? candidates.find(i => namesExactly(i, name))
      ?? candidates.find(i => matchesTrackingTicket(i, name));
    if (issue && !namesExactly(issue, name)) looselyTracked.add(name);
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
      const { title, body } = fixTicket(untrackedNow, ctx, platform);
      const labels = failureTicketLabels(["bug", "priority:low"], platform);
      const created = await client.createIssue(title, body, labels);
      groups.set(created.number, { issue: { ...created, title, body, labels }, names: untrackedNow, created: true });
    } catch (error) {
      console.warn(`   ⚠️ Could not file a fix ticket for ${untrackedNow.join(", ")}: ${error}`);
    }
  }
  // Record the sighting and keep each tracker on the board first. A ticket
  // whose tracker could not be confirmed here never advances.
  const placed: { issue: OpenIssue; names: string[] }[] = [];
  for (const { issue, names: groupNames, created } of groups.values()) {
    try {
      if (!created) {
        await client.addComment(issue.number, `## Shared failure seen again\n\n${evidence(groupNames, ctx, platform)}`);
        // Only a ticket the pipeline filed for these tests: a person's own
        // bug ticket matched by name keeps the requirement they chose.
        if (groupNames.some(name => hasMarker(issue, name))) await dropStaleOsRequirement(client, issue, platform);
      }
      const status = await client.getItemStatus(issue.number);
      const itemId = await client.addItemToProject(issue.nodeId);
      const entersBacklog = status === null || status === "Inbox" || status === "Done";
      if (entersBacklog) await client.updateItemStatus(itemId, "Backlog");
      if (entersBacklog || status === "Backlog") await client.moveItemToTop(itemId);
      placed.push({ issue, names: groupNames });
    } catch (error) {
      console.warn(`   ⚠️ Could not confirm a fix ticket for ${groupNames.join(", ")}: ${error}`);
    }
  }
  if (options.advance) {
    const placedNames = new Map(placed.flatMap(g => g.names.map(name => [name, g.issue.number] as const)));
    const selfNamed = ctx.gatedBody === undefined ? [] : names.filter(n => namesExactly({ body: ctx.gatedBody! }, n));
    const gap = (result.owned!.length > 0 && `this ticket owns the fix for ${result.owned!.join(", ")}`)
      || (selfNamed.length > 0 && `this ticket names ${selfNamed.join(", ")} itself, so it may be the fix`)
      || names.filter(n => !result.owned!.includes(n) && !placedNames.has(n)).map(n => `${n} has no confirmed tracking ticket`)[0]
      || [...looselyTracked].map(n => `${n} is tracked on #${placedNames.get(n)} only by its method name; if it is the same test, add ${inheritedMarker(n)} to that ticket's body`)[0];
    if (!gap) {
      return { blockers: [], untracked: [], owned: [], tracked: names.map(name => ({ name, issue: placedNames.get(name)! })) };
    }
    result.fallbackReason = gap;
  }
  if (options.addBlockers === false || !client.addBlocker) {
    result.untracked = names.filter(n => !result.owned!.includes(n));
    return result;
  }
  const confirmed = new Map<string, number>();
  for (const { issue, names: groupNames } of placed) {
    try {
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
