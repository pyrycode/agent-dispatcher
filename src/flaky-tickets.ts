// Flaky-test tickets: one open Backlog ticket per test the real-claude gate
// saw fail and then pass on a same-tree re-run.
//
// The re-run lets a ticket through when its failures were flakes, which is
// right for the ticket and wrong for the suite: before it, a wrongly blamed
// builder at least looked into the failure and sometimes filed a bug. With
// the re-run nobody is blamed, so nothing gets filed, and a flake leaves only
// a Discord ping and a line on an unrelated ticket. pyrycode-mobile's silent
// second-client bug went untracked for a whole day that way (2026-09-24).
//
// So each flaky test gets a ticket the first time, found again later by a
// marker in its body, and each later flake adds a comment to it. The ticket
// builds up a count and a list of runs instead of a pile of duplicates.
//
// The verifier gates re-run a red gate's failures the same way (#133) and
// record their flakes on the same per-test tickets. A verifier gate run has
// no GateRunReport, so it brings its own run lines.

import type { GateRunReport } from "./gate-output.js";

export const FLAKY_TEST_LABEL = "flaky-test";
export const FLAKY_TEST_COLUMN = "Backlog";

/**
 * New tickets one gate run may file. More flakes than this in one run points
 * at the environment rather than at tests, and a dozen tickets for one outage
 * is noise. Tests over the cap still get a comment when they already have a
 * ticket; the rest are named in the log and on the gated ticket's evidence.
 */
export const MAX_NEW_FLAKY_TICKETS_PER_RUN = 5;

/** Narrow client for the filing; `GitHubProjectClient` satisfies it. */
export interface FlakyTicketClient {
  listOpenIssuesWithLabel(label: string): Promise<{ number: number; body: string }[]>;
  createIssue(title: string, body: string, labels?: string[]): Promise<{ number: number; nodeId: string; url: string }>;
  addItemToProject(issueNodeId: string): Promise<string>;
  updateItemStatus(itemId: string, newStatus: string): Promise<void>;
  addComment(issueNumber: number, body: string): Promise<void>;
}

export interface FlakyRunContext {
  /** The ticket whose gate run saw the flake. */
  gatedIssue: number;
  report: GateRunReport;
  /** ISO timestamp of the run, for the ticket text. */
  at: string;
}

/** A pre-verifier gate run that saw a flake. */
export interface VerifierGateRun {
  /** The gate command, as configured. */
  gate: string;
  /** The gated worktree's merged HEAD, or null when it could not be read. */
  commit: string | null;
  /** The gate's own stdout log. */
  outputPath: string;
  /** The same-tree re-run's stdout log. */
  rerunOutputPath: string;
}

export interface VerifierGateFlakyContext {
  /** The ticket whose verifier gate saw the flake. */
  gatedIssue: number;
  verifierGate: VerifierGateRun;
  /** ISO timestamp of the run, for the ticket text. */
  at: string;
}

/** Either gate's run: the real-claude gate's report, or a verifier gate's own lines. */
export type FlakyTicketContext = FlakyRunContext | VerifierGateFlakyContext;

export interface FlakyTicketResult {
  filed: { name: string; issue: number }[];
  commented: { name: string; issue: number }[];
  /** Names with no ticket and no comment: over the cap, or a write failed. */
  untracked: string[];
}

/** The hidden line a ticket body carries so a later flake finds it. */
export function flakyMarker(name: string): string {
  return `<!-- flaky-test: ${name} -->`;
}

/**
 * The open ticket for `name`, matched on the whole marker line. A substring
 * match on the title would let `test_a` claim `test_ab`'s ticket.
 */
export function findFlakyTicket(issues: readonly { number: number; body: string }[], name: string): number | null {
  const marker = flakyMarker(name);
  const hit = issues.find(issue => (issue.body ?? "").split("\n").some(line => line.trim() === marker));
  return hit ? hit.number : null;
}

/** The part of a test name a person reads: the method after `#`, or the Go test after its package. */
export function shortTestName(name: string): string {
  const hash = name.lastIndexOf("#");
  if (hash >= 0) return name.slice(hash + 1);
  const go = name.match(/\.(Test|Benchmark|Example|Fuzz)/);
  return go?.index === undefined ? name : name.slice(go.index + 1);
}

function runLines(ctx: FlakyTicketContext): string[] {
  if ("verifierGate" in ctx) {
    const g = ctx.verifierGate;
    const at = g.commit === null ? "in its merged worktree" : `on merged commit \`${g.commit.slice(0, 10)}\``;
    return [
      `- Verifier gate run for #${ctx.gatedIssue} at ${ctx.at}`,
      `- Gate \`${g.gate}\` ${at}`,
      `- Full output: \`${g.outputPath}\`, re-run output: \`${g.rerunOutputPath}\``,
    ];
  }
  const r = ctx.report;
  return [
    `- Gate run for #${ctx.gatedIssue} at ${ctx.at}`,
    `- Branch \`${r.branchName}\` at \`${r.headSha.slice(0, 10)}\`, merged with \`${r.baseRef}\` at \`${r.baseSha.slice(0, 10)}\``,
    `- Full output: \`${r.outputPath}\`` + (r.rerunOutputPath ? `, re-run output: \`${r.rerunOutputPath}\`` : ""),
  ];
}

export function buildFlakyTestIssue(name: string, ctx: FlakyTicketContext): { title: string; body: string } {
  const verifier = "verifierGate" in ctx;
  const body = [
    "## User Story",
    "",
    `As the maintainer, I want \`${name}\` to pass reliably in the ${verifier ? "verifier gates" : "live gate"}, ` +
      "so that its flakes stop costing re-runs and cannot hide a real failure.",
    "",
    "## Context",
    "",
    (verifier
      ? `A verifier gate saw this test fail, then pass when re-run in the same worktree. The gated ticket was ` +
        "not blamed for it, because the failure was not its branch's."
      : "The real-claude gate saw this test fail, then pass when re-run on the same merged tree. The gated ticket " +
        "went through, because the failure was not its branch's.") +
      " The dispatcher filed this ticket and adds a " +
      "comment here each time the test flakes again, so the comments are the occurrence count.",
    "",
    "First seen:",
    "",
    ...runLines(ctx),
    "",
    "## Acceptance Criteria",
    "",
    "- [ ] The cause of the intermittent failure is found and stated on this ticket, with the log evidence.",
    "- [ ] The test or the product is fixed so the failure stops. If the cause is in another repo, a ticket " +
      "there is filed and linked, and this one is blocked by it.",
    "",
    flakyMarker(name),
  ].join("\n");
  return { title: `flaky ${verifier ? "" : "live "}test: ${shortTestName(name)}`, body };
}

export function buildFlakyRecurrenceComment(name: string, ctx: FlakyTicketContext): string {
  return [
    `## Flaked again`,
    "",
    `\`${name}\` failed once and passed on the same-tree re-run.`,
    "",
    ...runLines(ctx),
  ].join("\n");
}

/**
 * File or update one ticket per flaky test. Never throws: a board write that
 * fails leaves the name in `untracked`, and the gate's own verdict and moves
 * have already happened by the time this runs.
 */
export async function recordFlakyTests(
  client: FlakyTicketClient,
  flaky: readonly string[],
  ctx: FlakyTicketContext,
): Promise<FlakyTicketResult> {
  const result: FlakyTicketResult = { filed: [], commented: [], untracked: [] };
  const names = [...new Set(flaky)];
  if (names.length === 0) return result;

  let open: { number: number; body: string }[];
  try {
    open = await client.listOpenIssuesWithLabel(FLAKY_TEST_LABEL);
  } catch (e: any) {
    // Without the list every flake would look new. No list, no writes.
    console.warn(`   ⚠️  Flaky tickets: could not list open ${FLAKY_TEST_LABEL} tickets: ${e?.message ?? e}`);
    result.untracked.push(...names);
    return result;
  }

  for (const name of names) {
    const existing = findFlakyTicket(open, name);
    if (existing !== null) {
      try {
        await client.addComment(existing, buildFlakyRecurrenceComment(name, ctx));
        result.commented.push({ name, issue: existing });
      } catch (e: any) {
        console.warn(`   ⚠️  Flaky tickets: could not comment on #${existing}: ${e?.message ?? e}`);
        result.untracked.push(name);
      }
      continue;
    }
    if (result.filed.length >= MAX_NEW_FLAKY_TICKETS_PER_RUN) {
      result.untracked.push(name);
      continue;
    }
    try {
      const { title, body } = buildFlakyTestIssue(name, ctx);
      const issue = await client.createIssue(title, body, ["bug", FLAKY_TEST_LABEL]);
      result.filed.push({ name, issue: issue.number });
      // Recorded before the board writes: the ticket exists either way, and
      // listing it as untracked would invite a second one.
      open.push({ number: issue.number, body });
      const itemId = await client.addItemToProject(issue.nodeId);
      await client.updateItemStatus(itemId, FLAKY_TEST_COLUMN);
    } catch (e: any) {
      console.warn(`   ⚠️  Flaky tickets: could not file or place a ticket for ${name}: ${e?.message ?? e}`);
      if (!result.filed.some(f => f.name === name)) result.untracked.push(name);
    }
  }
  return result;
}
