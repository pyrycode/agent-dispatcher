// Flaky-test tickets: one Backlog ticket per test that a gate saw fail and
// then pass on a same-tree re-run, filed on the test's SECOND such sighting.
//
// The re-run lets a ticket through when its failures were flakes, which is
// right for the ticket and wrong for the suite: before it, a wrongly blamed
// builder at least looked into the failure and sometimes filed a bug. With
// the re-run nobody is blamed, so nothing gets filed, and a flake leaves only
// a Discord ping and a line on an unrelated ticket. pyrycode-mobile's silent
// second-client bug went untracked for a whole day that way (2026-09-24).
//
// Filing on the first sighting went too far the other way. From 2026-10-05 to
// 2026-10-15 pyrycode-desktop got 26 flaky tickets from its verifier gates,
// most of them contention flakes that never came back, and they used about
// 10 of its 62 agent hours. So the rules since 2026-10-15:
//
// 1. Every sighting is recorded in the claim service (flaky-sightings.ts),
//    shared across computers. A ticket is filed only when the same test has
//    flaked twice inside 14 days, on any computer or the same one. The first
//    sighting is named on the gated ticket's evidence or in the verifier's
//    note, so nothing is silently dropped.
// 2. A run with more than three failing tests, or with any failure that
//    failed again on the re-run, gets at most one ticket naming its flaky
//    tests: that many at once points at the machine or the display, not at
//    each test. None at all when a failure that failed again is the branch's
//    own, which its verifier or rework handles; those flakes are recorded but
//    not counted. None either when the live gate already filed the run's
//    shared live failure ticket, which is then the run's one ticket.
// 3. A test whose ticket closed in the last 30 days gets that ticket reopened
//    into Backlog with a comment, instead of a new one. Desktop's receipt
//    saturation test was filed three times (#1861, #1918, #1978) because
//    only open tickets were matched.
//
// Each later flake of a tracked test adds a comment to its open ticket, so a
// ticket builds up a count and a list of runs instead of a pile of duplicates.
//
// The verifier gates re-run a red gate's failures the same way (#133) and
// record their flakes on the same per-test tickets. A verifier gate run has
// no GateRunReport, so it brings its own run lines.

import type { GateRunReport } from "./gate-output.js";
import { osName, osRequirementToDrop, seenOnLabel } from "./ticket-requirements.js";
import {
  FLAKY_SIGHTING_WINDOW_DAYS,
  FLAKY_SIGHTINGS_TO_FILE,
  flakySightingId,
  type FlakySighting,
  type FlakySightingCount,
  type FlakySightingOutcome,
  type FlakySightingStore,
} from "./flaky-sightings.js";

export const FLAKY_TEST_LABEL = "flaky-test";
export const FLAKY_TEST_COLUMN = "Backlog";

/**
 * More failing tests than this in one gate run, and the run files at most one
 * ticket naming them all. Counts every failing test, not only the flaky ones.
 */
export const FLAKY_RUN_TEST_LIMIT = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A tracker closed this recently is reopened instead of filed again. */
export const FLAKY_REOPEN_WINDOW_DAYS = 30;
export const FLAKY_REOPEN_WINDOW_MS = FLAKY_REOPEN_WINDOW_DAYS * DAY_MS;

/**
 * Labels a closed ticket keeps that would mislead the pipeline once it is
 * open again: `merged` makes the auto-merge skip it in Done, and the stage
 * markers are the ones a merge strips (`recordMergedIssue`), plus a
 * `needs-human:` hold, which admission refuses and which the close answered.
 * Content labels, requirements and the claim display stay.
 */
export function staleLabelsOnReopen(labels: readonly string[]): string[] {
  return labels.filter((l) => l === "merged" || /^(done:|wip:|needs-rework:|needs-human:|error:|pending-done:|pending-verdict:|merge-attempt:)/.test(l));
}

/** A tracker ticket closed inside the reopen window. */
export interface ClosedTracker {
  number: number;
  nodeId?: string;
  title?: string;
  body: string;
  labels?: string[];
  /** ISO timestamp. */
  closedAt: string;
  /** GitHub's close reason: `completed`, `not_planned`, `duplicate`, or absent. */
  stateReason?: string | null;
}

/** Which tests a tracker write is for, so the claim service can check the ticket names them. */
export interface TrackerRef {
  kind: "flaky" | "inherited";
  tests: string[];
  /** Also move it to the top of Backlog. */
  top?: boolean;
  /** The same write from the same gate run always carries the same key, so judging a run twice writes once. */
  key?: string;
}

/** Narrow client for the filing; `GitHubProjectClient` satisfies it. */
export interface FlakyTicketClient {
  /** `labels` lets a later sighting on another system drop an operating-system requirement. */
  listOpenIssuesWithLabel(label: string): Promise<{ number: number; body: string; labels?: string[] }[]>;
  /** Tickets with `label` closed at or after `since`. Absent: nothing is reopened. */
  listRecentlyClosedIssuesWithLabel?(label: string, since: Date): Promise<ClosedTracker[]>;
  createIssue(title: string, body: string, labels?: string[]): Promise<{ number: number; nodeId: string; url: string }>;
  addItemToProject(issueNodeId: string): Promise<string>;
  updateItemStatus(itemId: string, newStatus: string): Promise<void>;
  addComment(issueNumber: number, body: string): Promise<void>;
  /** Drops a `requires:` label once a failure is seen on a second system. */
  removeLabel?(issueNumber: number, label: string): Promise<void>;
  /**
   * On a board the claim service owns: reopen a tracker the pipeline filed
   * into Backlog, drop its stale labels and add the comment, in one central
   * write (`/flaky/track`). Absent: the GitHub steps below.
   */
  reopenTracker?(issue: ClosedTracker, comment: string, ref: TrackerRef): Promise<void>;
  /** On a board the claim service owns: an occurrence comment on an open tracker. Absent: `addComment`. */
  commentOnTracker?(issueNumber: number, comment: string, ref: TrackerRef): Promise<void>;
  /** A plain GitHub reopen, for a board the claim service does not own. */
  reopenIssue?(issueNumber: number): Promise<void>;
  moveItemToTop?(itemId: string): Promise<void>;
}

export interface FlakyRunContext {
  /** The ticket whose gate run saw the flake. */
  gatedIssue: number;
  report: GateRunReport;
  /** ISO timestamp of the run, for the ticket text. */
  at: string;
  /** The gated ticket's own body, when known, so a fix ticket without the
   *  `bug` label or its marker is still seen naming its own test. */
  gatedBody?: string;
  /** What makes this gate run itself: the run's output path, unique per run. Absent: the output path and `at`. */
  runKey?: string;
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
  /** The gated ticket's own body, when known, so a fix ticket without the
   *  `bug` label or its marker is still seen naming its own test. */
  gatedBody?: string;
  /** What makes this gate run itself: a hash of its output, since the log path is reused. Absent: the output path and `at`. */
  runKey?: string;
}

/** Either gate's run: the real-claude gate's report, or a verifier gate's own lines. */
export type FlakyTicketContext = FlakyRunContext | VerifierGateFlakyContext;

/** How one gate run's failures split on its same-tree re-run. */
export interface FlakyRunShape {
  /** Every test that failed in the gate run, flaky or not. */
  failed: readonly string[];
  /** The tests that failed again on the re-run. */
  persistent: readonly string[];
  /** Some persistent failure is the gated branch's own: it neither failed in the main sweep nor on the base commit. */
  branchOwnsPersistent: boolean;
  /** The persistent failures already have this run's one ticket: the live gate's shared live failure ticket. */
  persistentTracked?: boolean;
}

/**
 * `quiet`: at most three failures and every one passed on the re-run, so each
 * flaky test is judged on its own. `burst`: more than three, every one passed
 * on the re-run, so the run files at most one ticket. `persistent`: some
 * failure failed again, so the run files at most one ticket, and none when
 * that failure is the branch's or already has this run's ticket.
 */
export type FlakyRunKind = "quiet" | "burst" | "persistent";

export function classifyFlakyRun(flaky: readonly string[], shape?: FlakyRunShape): FlakyRunKind {
  if ((shape?.persistent.length ?? 0) > 0) return "persistent";
  const failed = new Set([...(shape?.failed ?? []), ...flaky]);
  return failed.size > FLAKY_RUN_TEST_LIMIT ? "burst" : "quiet";
}

export interface FlakyTicketResult {
  /** New tickets: one per test, or one run ticket naming every test in a burst. */
  filed: { name: string; issue: number }[];
  /** An open ticket already tracked the test; it got an occurrence comment. */
  commented: { name: string; issue: number }[];
  /** A recently closed ticket was reopened into Backlog for the test. */
  reopened: { name: string; issue: number }[];
  /** First sighting inside the window: recorded, no ticket yet. */
  firstSightings: string[];
  /** Recorded only: a failure in the run that failed again is the branch's, or already has this run's ticket. */
  held: string[];
  /** Due, but another gate run holds the filing lease and is filing or reopening its ticket. */
  deferred?: string[];
  /** Due, but its ticket was closed by a person as not planned or a duplicate inside the reopen window. */
  declined?: { name: string; issue: number }[];
  /** Names with no ticket and no comment because a read or write failed. */
  untracked: string[];
  /** Where the sighting counts came from. `none` when nothing could be recorded. */
  sightingSource: "central" | "local" | "none";
  /** True when the sightings do not count toward a ticket (the branch owns a persistent failure). */
  uncounted?: boolean;
}

/** What the live gate already recorded before its evidence comment, and how the run split. */
export interface FlakyRunFacts {
  shape?: FlakyRunShape;
  /** Sightings recorded earlier in the same run, so they are not recorded twice. */
  sightings?: FlakySightingOutcome;
}

export interface FlakyFilingOptions extends FlakyRunFacts {
  /** The shared sighting record. Absent with no `sightings`: nothing is recorded and nothing filed. */
  store?: FlakySightingStore | null;
  platform?: string;
  now?: () => number;
}

/** The hidden line a ticket body carries so a later flake finds it. */
export function flakyMarker(name: string): string {
  return `<!-- flaky-test: ${name} -->`;
}

/** The ticket body names `name` on its own marker line. */
export function hasFlakyMarker(body: string, name: string): boolean {
  const marker = flakyMarker(name);
  return (body ?? "").split("\n").some((line) => line.trim() === marker);
}

/**
 * The open ticket for `name`, matched on the whole marker line. A substring
 * match on the title would let `test_a` claim `test_ab`'s ticket.
 */
export function findFlakyTicket(issues: readonly { number: number; body: string }[], name: string): number | null {
  const hit = issues.find((issue) => hasFlakyMarker(issue.body, name));
  return hit ? hit.number : null;
}

/** The part of a test name a person reads: the method after `#`, or the Go test after its package. */
export function shortTestName(name: string): string {
  const hash = name.lastIndexOf("#");
  if (hash >= 0) return name.slice(hash + 1);
  const go = name.match(/\.(Test|Benchmark|Example|Fuzz)/);
  return go?.index === undefined ? name : name.slice(go.index + 1);
}

function runLines(ctx: FlakyTicketContext, platform: string): string[] {
  if ("verifierGate" in ctx) {
    const g = ctx.verifierGate;
    const at = g.commit === null ? "in its merged worktree" : `on merged commit \`${g.commit.slice(0, 10)}\``;
    return [
      `- Verifier gate run for #${ctx.gatedIssue} at ${ctx.at}`,
      `- Seen on ${osName(platform)}`,
      `- Gate \`${g.gate}\` ${at}`,
      `- Full output: \`${g.outputPath}\`, re-run output: \`${g.rerunOutputPath}\``,
    ];
  }
  const r = ctx.report;
  return [
    `- Gate run for #${ctx.gatedIssue} at ${ctx.at}`,
    `- Seen on ${osName(platform)}`,
    `- Branch \`${r.branchName}\` at \`${r.headSha.slice(0, 10)}\`, merged with \`${r.baseRef}\` at \`${r.baseSha.slice(0, 10)}\``,
    `- Full output: \`${r.outputPath}\`` + (r.rerunOutputPath ? `, re-run output: \`${r.rerunOutputPath}\`` : ""),
  ];
}

type Earlier = FlakySightingCount["earlier"];

function earlierLines(earlier: Earlier | undefined): string[] {
  if (!earlier || earlier.length === 0) return [];
  return earlier.map((e) => `- ${e.gate === "live" ? "Live" : "Verifier"} gate for ${e.ticket} on ${e.machine} at ${new Date(e.at).toISOString()}`);
}

const OCCURRENCE_NOTE = "The dispatcher files a flaky-test ticket on a test's second fail-then-pass inside " +
  `${FLAKY_SIGHTING_WINDOW_DAYS} days, on any computer, and adds a comment here each time it flakes again, ` +
  "so the comments are the occurrence count.";

export function buildFlakyTestIssue(name: string, ctx: FlakyTicketContext, platform: string = process.platform, earlier?: Earlier): { title: string; body: string } {
  const verifier = "verifierGate" in ctx;
  const seen = earlierLines(earlier);
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
      " " + OCCURRENCE_NOTE,
    "",
    "This sighting:",
    "",
    ...runLines(ctx, platform),
    ...(seen.length > 0 ? ["", `Earlier sightings in the last ${FLAKY_SIGHTING_WINDOW_DAYS} days:`, "", ...seen] : []),
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

/**
 * One ticket for a gate run in which more than three tests failed and all of
 * them passed on the re-run. One marker per test, so a later flake of any of
 * them comments here instead of filing its own.
 */
export function buildFlakyRunIssue(
  names: readonly string[],
  ctx: FlakyTicketContext,
  platform: string = process.platform,
  earlierByName: ReadonlyMap<string, Earlier> = new Map(),
  shape?: FlakyRunShape,
): { title: string; body: string } {
  const verifier = "verifierGate" in ctx;
  const seenBefore = names.filter((n) => (earlierByName.get(n)?.length ?? 0) > 0);
  const persistent = [...new Set(shape?.persistent ?? [])];
  const why = persistent.length > 0
    ? [
      `In the same run ${persistent.length} other test(s) failed again on the re-run and fail on main too, so they ` +
        "are main's, not this ticket's: " + persistent.map((n) => `\`${n}\``).join(", ") + ". A run that unsettled " +
        "usually shares one cause, so the dispatcher filed one ticket for its flakes instead of one per test. " + OCCURRENCE_NOTE,
    ]
    : [
      `More than ${FLAKY_RUN_TEST_LIMIT} failures in one run usually share one cause, such as a contended machine or ` +
        "display, so the dispatcher filed one ticket for the run instead of one per test. " + OCCURRENCE_NOTE,
    ];
  const body = [
    "## User Story",
    "",
    `As the maintainer, I want the ${names.length} tests below to stop failing together in the ` +
      `${verifier ? "verifier gates" : "live gate"}, so that one shared cause stops costing re-runs.`,
    "",
    "## Context",
    "",
    `One ${verifier ? "verifier gate" : "live gate"} run saw these ${names.length} tests fail, then pass when re-run ` +
      "in the same tree under the gate's own worker count:",
    "",
    ...names.map((n) => `- \`${n}\`` + (seenBefore.includes(n) ? " (also flaked earlier, see below)" : "")),
    "",
    ...why,
    "",
    "This run:",
    "",
    ...runLines(ctx, platform),
    ...seenBefore.flatMap((n) => ["", `Earlier sightings of \`${n}\`:`, "", ...earlierLines(earlierByName.get(n))]),
    "",
    "## Acceptance Criteria",
    "",
    "- [ ] What the failures share is found from the logs before any one test is changed. A test is split off " +
      "into its own ticket only when its cause turns out to be independent.",
    "- [ ] The shared cause is fixed, in the tests, the harness or the product, so the failures stop. If it is " +
      "in another repo, a ticket there is filed and linked, and this one is blocked by it.",
    "",
    ...names.map(flakyMarker),
  ].join("\n");
  return { title: `flaky ${verifier ? "" : "live "}tests: ${names.length} failed together in one gate run`, body };
}

function nameList(names: readonly string[]): string {
  return names.length === 1 ? `\`${names[0]}\`` : names.map((n) => `\`${n}\``).join(", ");
}

export function buildFlakyRecurrenceComment(names: string | readonly string[], ctx: FlakyTicketContext, platform: string = process.platform): string {
  const list = typeof names === "string" ? [names] : names;
  return [
    `## Flaked again`,
    "",
    `${nameList(list)} failed once and passed on the same-tree re-run.`,
    "",
    ...runLines(ctx, platform),
  ].join("\n");
}

/** The comment a reopened tracker gets. */
export function buildFlakyReopenComment(
  names: readonly string[],
  ctx: FlakyTicketContext,
  closedAt: string,
  platform: string = process.platform,
  earlierByName: ReadonlyMap<string, Earlier> = new Map(),
): string {
  const seen = names.flatMap((n) => earlierLines(earlierByName.get(n)).map((l) => `${l} (\`${shortTestName(n)}\`)`));
  return [
    "## Flaked again after this ticket closed",
    "",
    `${nameList(names)} failed once and passed on the same-tree re-run. This ticket closed at ${closedAt}, ` +
      `within ${FLAKY_REOPEN_WINDOW_DAYS} days, so the dispatcher reopened it into Backlog instead of filing a ` +
      "new one. Whatever fixed it before did not hold, or fixed a different cause.",
    "",
    ...runLines(ctx, platform),
    ...(seen.length > 0 ? ["", `Earlier sightings in the last ${FLAKY_SIGHTING_WINDOW_DAYS} days:`, "", ...seen] : []),
  ].join("\n");
}

/**
 * The labels a new failure ticket starts with: its own, plus the
 * `requires:` label for the system the failure was seen on, so its fix runs
 * where the failure can be reproduced. Seen on one system only, by
 * definition, since one run filed it.
 */
export function failureTicketLabels(labels: readonly string[], platform: string = process.platform): string[] {
  const seenOn = seenOnLabel(platform);
  return seenOn ? [...labels, seenOn] : [...labels];
}

/**
 * A failure tracked on `issue` was seen again on `platform`. When the
 * ticket requires another operating system, the failure is no longer
 * specific to it, so the requirement goes. Never throws.
 */
export async function dropStaleOsRequirement(
  client: { removeLabel?(issueNumber: number, label: string): Promise<void> },
  issue: { number: number; labels?: string[] },
  platform: string = process.platform,
): Promise<string | undefined> {
  const drop = osRequirementToDrop(issue.labels ?? [], platform);
  if (!drop || !client.removeLabel) return undefined;
  try {
    await client.removeLabel(issue.number, drop);
    issue.labels = (issue.labels ?? []).filter(l => l !== drop);
    console.log(`   🌐 #${issue.number} failed on ${osName(platform)} too, so it no longer needs ${drop}`);
    return drop;
  } catch (e: any) {
    console.warn(`   ⚠️  Could not remove ${drop} from #${issue.number}: ${e?.message ?? e}`);
    return undefined;
  }
}

/** An occurrence comment on an open tracker, through the claim service where it owns the board. */
export async function commentOnTracker(client: FlakyTicketClient, issue: number, comment: string, ref: TrackerRef): Promise<void> {
  if (client.commentOnTracker) return client.commentOnTracker(issue, comment, ref);
  return client.addComment(issue, comment);
}

/**
 * Reopen a recently closed tracker into Backlog with a comment. Where the
 * claim service owns the board this is one central write that checks the
 * ticket names these tests. Elsewhere it is the GitHub steps in order:
 * reopen, comment, drop stale labels, place in Backlog. Throws when it
 * cannot reopen at all; the caller then files nothing new.
 */
export async function reopenTracker(client: FlakyTicketClient, issue: ClosedTracker, comment: string, ref: TrackerRef): Promise<void> {
  if (client.reopenTracker) return client.reopenTracker(issue, comment, ref);
  if (!client.reopenIssue) throw new Error("this client cannot reopen a ticket");
  await client.reopenIssue(issue.number);
  await client.addComment(issue.number, comment);
  for (const label of staleLabelsOnReopen(issue.labels ?? [])) {
    try { await client.removeLabel?.(issue.number, label); } catch (e: any) {
      console.warn(`   ⚠️  Could not remove ${label} from reopened #${issue.number}: ${e?.message ?? e}`);
    }
  }
  if (issue.nodeId) {
    const itemId = await client.addItemToProject(issue.nodeId);
    await client.updateItemStatus(itemId, FLAKY_TEST_COLUMN);
    if (ref.top) await client.moveItemToTop?.(itemId);
  }
}

/** The latest closed tracker naming `name` on its marker line, if any. */
function latestClosed(closed: readonly ClosedTracker[], matches: (body: string) => boolean): ClosedTracker | undefined {
  return [...closed].filter((c) => matches(c.body)).sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))[0];
}
export function latestClosedFlakyTicket(closed: readonly ClosedTracker[], name: string): ClosedTracker | undefined {
  return latestClosed(closed, (body) => hasFlakyMarker(body, name));
}

function emptyResult(): FlakyTicketResult {
  return { filed: [], commented: [], reopened: [], firstSightings: [], held: [], untracked: [], sightingSource: "none" };
}

function outputPathOf(ctx: FlakyTicketContext): string {
  return "verifierGate" in ctx ? ctx.verifierGate.outputPath : ctx.report.outputPath;
}

/** One gate run's identity, the same however often the run is judged. */
function runKeyOf(ctx: FlakyTicketContext): string {
  return ctx.runKey ?? `${outputPathOf(ctx)}@${ctx.at}`;
}

/** The idempotency key for one tracker write from one gate run. */
export function trackerKey(ctx: FlakyTicketContext, issue: number, write: string): string {
  return flakySightingId(["tracker", "verifierGate" in ctx ? "verifier" : "live", ctx.gatedIssue, runKeyOf(ctx), issue], write).slice(0, 48);
}

/** Closed by a person who decided against tracking it. */
function declinedClose(c: ClosedTracker): boolean {
  return c.stateReason === "not_planned" || c.stateReason === "duplicate";
}

/**
 * Record one sighting per flaky name. Never throws: a store that cannot be
 * reached answers with this computer's own counts, and a missing store with
 * none at all, which files nothing.
 */
export async function recordFlakySightings(
  store: FlakySightingStore | null | undefined,
  flaky: readonly string[],
  ctx: FlakyTicketContext,
  shape?: FlakyRunShape,
  now: () => number = Date.now,
): Promise<FlakySightingOutcome | undefined> {
  const names = [...new Set(flaky)];
  if (!store || names.length === 0) return undefined;
  const gate = "verifierGate" in ctx ? "verifier" : "live";
  const parsed = Date.parse(ctx.at);
  const at = Number.isFinite(parsed) ? parsed : now();
  const counts = !(shape?.branchOwnsPersistent ?? false);
  const sightings: FlakySighting[] = names.map((test) => ({
    id: flakySightingId([gate, ctx.gatedIssue, runKeyOf(ctx)], test),
    test, ticket: ctx.gatedIssue, gate, counts, at,
  }));
  return store.record(sightings);
}

function countsByName(outcome: FlakySightingOutcome | undefined): Map<string, FlakySightingCount> {
  const out = new Map<string, FlakySightingCount>();
  for (const c of outcome?.counts.values() ?? []) out.set(c.test, c);
  return out;
}

/**
 * Record each flake's sighting, then file, reopen or comment by the rules in
 * the header. Never throws: a board write that fails leaves the name in
 * `untracked`, and the gate's own verdict and moves have already happened by
 * the time this runs.
 */
export async function recordFlakyTests(
  client: FlakyTicketClient,
  flaky: readonly string[],
  ctx: FlakyTicketContext,
  options: FlakyFilingOptions = {},
): Promise<FlakyTicketResult> {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const result = emptyResult();
  const names = [...new Set(flaky)];
  if (names.length === 0) return result;

  const kind = classifyFlakyRun(names, options.shape);
  const outcome = options.sightings ?? await recordFlakySightings(options.store, names, ctx, options.shape, now);
  result.sightingSource = outcome?.source ?? "none";
  if (options.shape?.branchOwnsPersistent) result.uncounted = true;
  const counts = countsByName(outcome);
  const earlierByName = new Map([...counts].map(([n, c]) => [n, c.earlier] as const));

  // The branch's own failure may explain the flakes: no ticket and no comment.
  if (kind === "persistent" && options.shape?.branchOwnsPersistent) {
    result.held.push(...names);
    return result;
  }

  let open: { number: number; body: string; labels?: string[] }[];
  try {
    open = await client.listOpenIssuesWithLabel(FLAKY_TEST_LABEL);
  } catch (e: any) {
    // Without the list every flake would look new. No list, no writes.
    console.warn(`   ⚠️  Flaky tickets: could not list open ${FLAKY_TEST_LABEL} tickets: ${e?.message ?? e}`);
    result.untracked.push(...names);
    return result;
  }

  // An open ticket gets one occurrence comment for all of its tests in this run.
  const byTicket = new Map<number, string[]>();
  const untracked: string[] = [];
  for (const name of names) {
    const existing = findFlakyTicket(open, name);
    if (existing === null) untracked.push(name);
    else byTicket.set(existing, [...(byTicket.get(existing) ?? []), name]);
  }
  for (const [issue, group] of byTicket) {
    try {
      await commentOnTracker(client, issue, buildFlakyRecurrenceComment(group, ctx, platform),
        { kind: "flaky", tests: group, key: trackerKey(ctx, issue, "comment") });
      result.commented.push(...group.map((name) => ({ name, issue })));
      await dropStaleOsRequirement(client, open.find((i) => i.number === issue)!, platform);
    } catch (e: any) {
      console.warn(`   ⚠️  Flaky tickets: could not comment on #${issue}: ${e?.message ?? e}`);
      result.untracked.push(...group);
    }
  }

  // The live gate's shared live failure ticket is already the run's one
  // ticket. Open trackers still got their occurrence comments above.
  if (kind === "persistent" && options.shape?.persistentTracked) {
    result.held.push(...untracked);
    return result;
  }

  // Due: the second counted sighting in the window, and no other run holding the filing lease.
  const seenTwice = untracked.filter((n) => (counts.get(n)?.count ?? 0) >= FLAKY_SIGHTINGS_TO_FILE);
  const deferred = seenTwice.filter((n) => counts.get(n)?.file === false);
  const due = seenTwice.filter((n) => !deferred.includes(n));
  if (deferred.length > 0) result.deferred = deferred;
  const notDue = untracked.filter((n) => !seenTwice.includes(n));
  if (due.length === 0) {
    result.firstSightings.push(...notDue);
    return result;
  }

  let closed: ClosedTracker[] = [];
  if (client.listRecentlyClosedIssuesWithLabel) {
    try {
      closed = await client.listRecentlyClosedIssuesWithLabel(FLAKY_TEST_LABEL, new Date(now() - FLAKY_REOPEN_WINDOW_MS));
    } catch (e: any) {
      // A closed ticket for one of these may exist, and filing beside it is the duplicate this avoids.
      console.warn(`   ⚠️  Flaky tickets: could not list recently closed ${FLAKY_TEST_LABEL} tickets, so nothing is filed this run: ${e?.message ?? e}`);
      result.untracked.push(...due);
      result.firstSightings.push(...notDue);
      return result;
    }
  }

  const reopen = async (prior: ClosedTracker, group: readonly string[], tracked: readonly string[]): Promise<boolean> => {
    try {
      await reopenTracker(client, prior, buildFlakyReopenComment(group, ctx, prior.closedAt, platform, earlierByName), {
        kind: "flaky", tests: [...tracked], key: trackerKey(ctx, prior.number, "reopen"),
      });
      result.reopened.push(...group.map((name) => ({ name, issue: prior.number })));
      open.push({ number: prior.number, body: prior.body, labels: prior.labels });
      return true;
    } catch (e: any) {
      // Not filed beside it either: the next sighting tries the reopen again.
      console.warn(`   ⚠️  Flaky tickets: could not reopen #${prior.number} for ${group.join(", ")}: ${e?.message ?? e}`);
      result.untracked.push(...group);
      return false;
    }
  };

  const file = async (title: string, body: string, group: readonly string[]): Promise<void> => {
    try {
      const labels = failureTicketLabels(["bug", FLAKY_TEST_LABEL, "priority:low"], platform);
      const issue = await client.createIssue(title, body, labels);
      result.filed.push(...group.map((name) => ({ name, issue: issue.number })));
      // Recorded before the board writes: the ticket exists either way, and
      // listing it as untracked would invite a second one.
      open.push({ number: issue.number, body, labels });
      const itemId = await client.addItemToProject(issue.nodeId);
      await client.updateItemStatus(itemId, FLAKY_TEST_COLUMN);
    } catch (e: any) {
      console.warn(`   ⚠️  Flaky tickets: could not file or place a ticket for ${group.join(", ")}: ${e?.message ?? e}`);
      for (const name of group) if (!result.filed.some((f) => f.name === name)) result.untracked.push(name);
    }
  };

  // A person closed it as not planned or a duplicate: that decision stands for the window.
  const priorFor = (name: string): ClosedTracker | "declined" | undefined => {
    const prior = latestClosedFlakyTicket(closed, name);
    if (prior && declinedClose(prior)) {
      result.declined = [...(result.declined ?? []), { name, issue: prior.number }];
      return "declined";
    }
    return prior;
  };

  // One test per ticket: a quiet run, or a noisy one with a single test left to track.
  const runLevel = kind !== "quiet" && untracked.filter((n) => !deferred.includes(n)).length > 1;
  if (!runLevel) {
    result.firstSightings.push(...notDue);
    // Two tests that share one closed ticket reopen it once.
    const byPrior = new Map<number, { prior: ClosedTracker; names: string[] }>();
    for (const name of due) {
      const prior = priorFor(name);
      if (prior === "declined") continue;
      if (!prior) {
        const { title, body } = buildFlakyTestIssue(name, ctx, platform, counts.get(name)?.earlier);
        await file(title, body, [name]);
        continue;
      }
      const group = byPrior.get(prior.number) ?? { prior, names: [] };
      group.names.push(name);
      byPrior.set(prior.number, group);
    }
    for (const { prior, names: group } of byPrior.values()) await reopen(prior, group, group);
    return result;
  }

  // A noisy run: at most one ticket for the whole run, naming every test it has to track.
  const priors = new Map(due.map((n) => [n, priorFor(n)] as const));
  const declined = new Set(due.filter((n) => priors.get(n) === "declined"));
  const stillDue = due.filter((n) => !declined.has(n));
  const tracking = untracked.filter((n) => !deferred.includes(n) && !declined.has(n));
  if (stillDue.length === 0) {
    result.firstSightings.push(...notDue);
    return result;
  }
  const prior = stillDue.map((n) => priors.get(n)).filter((c): c is ClosedTracker => c !== undefined && c !== "declined")
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))[0];
  if (prior) {
    await reopen(prior, tracking, tracking.filter((n) => hasFlakyMarker(prior.body, n)));
    return result;
  }
  const { title, body } = tracking.length === 1
    ? buildFlakyTestIssue(tracking[0]!, ctx, platform, counts.get(tracking[0]!)?.earlier)
    : buildFlakyRunIssue(tracking, ctx, platform, earlierByName, options.shape);
  await file(title, body, tracking);
  return result;
}

/**
 * One line per flaky test saying what became of its sighting, for the
 * verifier's note, the gated ticket's evidence and the log. A first sighting
 * is named here so it is never silently dropped.
 */
export function flakyTrackingNotes(result: FlakyTicketResult): Map<string, string> {
  const notes = new Map<string, string>();
  const local = result.sightingSource === "local"
    ? " (counted on this computer only, because the shared record could not be reached)" : "";
  const recorded = result.sightingSource === "none" ? "not recorded, because no sighting record is configured" : `recorded${local}`;
  for (const { name, issue } of result.filed) notes.set(name, `filed #${issue}`);
  for (const { name, issue } of result.reopened) notes.set(name, `reopened #${issue}`);
  for (const { name, issue } of result.commented) notes.set(name, `flaked again, recorded on #${issue}`);
  for (const name of result.firstSightings) {
    notes.set(name, result.sightingSource === "none"
      ? "not recorded, because no sighting record is configured, so no ticket was filed"
      : `first sighting in ${FLAKY_SIGHTING_WINDOW_DAYS} days, recorded${local}; a ticket is filed if it flakes again`);
  }
  for (const name of result.held) {
    notes.set(name, result.uncounted
      ? `${recorded} and not counted: this branch's own failure in the same run may explain it`
      : `${recorded}; no flaky ticket, because the run's failures that failed again already have its one ticket`);
  }
  for (const name of result.deferred ?? []) notes.set(name, "seen again; another gate run is filing or reopening its ticket");
  for (const { name, issue } of result.declined ?? []) {
    notes.set(name, `seen again, but #${issue} was closed as not planned or a duplicate in the last ${FLAKY_REOPEN_WINDOW_DAYS} days, so nothing is filed`);
  }
  for (const name of result.untracked) notes.set(name, "not tracked this run because a ticket read or write failed, see the dispatcher log");
  return notes;
}

/**
 * The paragraph the live gate's evidence comment carries about its flakes,
 * written from the sightings alone, before any ticket is filed.
 */
export function describeFlakySightings(
  flaky: readonly string[],
  outcome: FlakySightingOutcome | undefined,
  shape?: FlakyRunShape,
): string {
  const names = [...new Set(flaky)];
  if (names.length === 0) return "";
  const kind = classifyFlakyRun(names, shape);
  if (outcome === undefined) {
    return "These sightings could not be recorded, so no flaky-test ticket is filed from this run.";
  }
  const local = outcome.source === "local"
    ? " The shared record could not be reached, so the counts are this computer's own; the sightings are sent later." : "";
  if (kind === "persistent" && shape?.branchOwnsPersistent) {
    return "Recorded as sightings that do not count toward a ticket: this branch's own failure in the same run may explain them." + local;
  }
  if (kind === "persistent" && shape?.persistentTracked) {
    return "Recorded as sightings, with no flaky-test ticket: the failures that failed again fail on main, and their " +
      "shared live failure ticket is this run's one ticket." + local;
  }
  const counts = countsByName(outcome);
  const lines = names.map((n) => {
    const count = counts.get(n)?.count ?? 0;
    return count >= FLAKY_SIGHTINGS_TO_FILE
      ? `- \`${n}\`: seen ${count} times in ${FLAKY_SIGHTING_WINDOW_DAYS} days, so it is due for a flaky-test ticket`
      : `- \`${n}\`: first sighting in ${FLAKY_SIGHTING_WINDOW_DAYS} days, recorded`;
  });
  return [
    `Flaky-test tracking: a test with an open flaky-test ticket gets a comment on it; otherwise a ticket is filed, or a ` +
      `recently closed one reopened, on its second sighting in ${FLAKY_SIGHTING_WINDOW_DAYS} days, on any computer, ` +
      "after this comment." +
      (kind !== "quiet" ? " This run's flakes share at most one ticket." : "") + local,
    "",
    ...lines,
  ].join("\n");
}
