// Verdict handoff: the dispatcher posts a finished verdict itself when the
// agent's own GitHub write failed (agent-dispatcher#118).
//
// 2026-10-03, Mobile #1677, PR #1680: the Codex verifier finished its review
// with PASS and no findings, but posting the verdict comment failed with
// GitHub HTTP 503 and a GraphQL timeout. It saved the verdict to a body file
// and ended `blocked`. The error path parked the ticket as `error:verifier`,
// a person posted the saved file by hand and swapped the label about nine
// hours later. The PR head had not moved, so nothing about the review was
// stale: a GitHub outage of minutes became a nine-hour park.
//
// So the finished verdict is a dispatcher-owned handoff. Each verdict run is
// told a file outside its worktree, and the role prompt writes the final
// verdict there before posting it:
//
//   decision: PASS | FAIL
//   commit: <full SHA of the reviewed PR head>
//   labels: <labels the verdict adds, e.g. needs-rework:builder; optional>
//   ---
//   <the verdict comment body, exactly as it would be posted>
//
// When the run then errors or blocks on a GitHub publication failure, the
// verdict guard finds nothing posted since the run began, the file is
// complete, and the PR head still equals the reviewed commit, the dispatcher
// posts the body and applies the labels, and the run continues as a normal
// success. If GitHub is still refusing writes the ticket carries
// `pending-verdict:<agent>` and the next cycle tries again instead of
// parking. Anything else parks exactly as before.
//
// Pure helpers here; the I/O (file reads, `gh` calls, labels) stays in
// dispatch.ts.

/** A complete handoff, ready to publish. */
export interface VerdictHandoff {
  decision: "PASS" | "FAIL";
  /** Lower-case 40-character SHA of the PR head the review judged. */
  commit: string;
  /** Labels the verdict adds to the ticket. A FAIL carries a rework label. */
  labels: string[];
  /** The verdict comment body. */
  body: string;
}

export type HandoffParse = { ok: true; handoff: VerdictHandoff } | { ok: false; reason: string };

/** Label prefixes that are dispatcher state, never an agent's to set by proxy. */
const REFUSED_LABEL_PREFIXES = [
  "done:", "wip:", "error:", "pending-done:", "pending-verdict:",
  "rework-count:", "rework-other:", "error-retry-count:", "merge-attempt:",
];
const LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9:._\/-]*$/;

/**
 * Parse a handoff file. Strict on purpose: the dispatcher posts this on the
 * agent's behalf, so anything short of a finished verdict is `ok: false`
 * and the run parks as it always did. The header ends at the first line
 * that is exactly `---`; everything after it is the body, verbatim apart
 * from surrounding blank lines.
 */
export function parseVerdictHandoff(text: string): HandoffParse {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sep = lines.findIndex((l) => l.trim() === "---");
  if (sep < 0) return { ok: false, reason: "no `---` line ends the header" };

  const header = new Map<string, string>();
  for (const line of lines.slice(0, sep)) {
    if (line.trim() === "") continue;
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) return { ok: false, reason: `unreadable header line: ${line.slice(0, 80)}` };
    header.set(m[1]!.toLowerCase(), m[2]!);
  }

  const decision = (header.get("decision") ?? "").toUpperCase();
  if (decision !== "PASS" && decision !== "FAIL") return { ok: false, reason: "decision is not PASS or FAIL" };

  const commit = (header.get("commit") ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) return { ok: false, reason: "commit is not a full 40-character SHA" };

  const labels = (header.get("labels") ?? "").split(/[\s,]+/).filter((l) => l !== "");
  for (const label of labels) {
    if (!LABEL_SHAPE.test(label)) return { ok: false, reason: `label ${JSON.stringify(label)} is not a label name` };
    if (REFUSED_LABEL_PREFIXES.some((p) => label.startsWith(p))) {
      return { ok: false, reason: `label ${label} is dispatcher state` };
    }
  }
  const reworks = labels.filter((l) => l.startsWith("needs-rework:"));
  if (decision === "FAIL" && reworks.length === 0) return { ok: false, reason: "a FAIL names no needs-rework label" };
  if (decision === "PASS" && reworks.length > 0) return { ok: false, reason: "a PASS names a needs-rework label" };

  const body = lines.slice(sep + 1).join("\n").trim();
  if (body === "") return { ok: false, reason: "the body is empty" };

  return { ok: true, handoff: { decision, commit, labels, body } };
}

/**
 * True when a failed or blocked run's text says a GitHub write failed: it
 * names GitHub, a write the verdict needs, and a failure. A rejected action
 * never counts. The dispatcher must not perform an action the approval
 * reviewer refused, and that rule has no exceptions.
 */
export function isVerdictPublishFailure(text: string, opts: { approvalRejected: boolean }): boolean {
  if (opts.approvalRejected) return false;
  if (/\bapproval\b|unacceptable risk|permission denied/i.test(text)) return false;
  const github = /github|graphql|\bgh\b|pipeline-action/i.test(text);
  const write = /\b(post|posting|posted|publish|publishing|comment|review|verdict|label)s?\b/i.test(text);
  const failure = /\bHTTP\s*5\d\d\b|\b50[0-4]\b|timed?\s?out|timeout|rate.?limit|unavailable|bad gateway|server error|connection (?:reset|refused)|ECONNRESET|ETIMEDOUT|\bfailed\b|\bfailure\b/i.test(text);
  return github && write && failure;
}

/** One review or comment on a pull request. */
export interface PrArtifact {
  /** ISO-8601 time of the review's submission or the comment's creation. */
  at: string;
  body: string;
}

export interface PrVerdictView {
  headOid: string;
  state: string;
  artifacts: PrArtifact[];
}

/** Parse `gh pr view <n> --json headRefOid,state,reviews,comments`. Throws on malformed JSON. */
export function parsePrVerdictView(json: string): PrVerdictView {
  const data = JSON.parse(json) as {
    headRefOid?: string;
    state?: string;
    reviews?: Array<{ submittedAt?: string; body?: string }>;
    comments?: Array<{ createdAt?: string; body?: string }>;
  };
  const artifacts: PrArtifact[] = [];
  for (const r of data.reviews ?? []) if (r.submittedAt) artifacts.push({ at: r.submittedAt, body: r.body ?? "" });
  for (const c of data.comments ?? []) if (c.createdAt) artifacts.push({ at: c.createdAt, body: c.body ?? "" });
  return { headOid: (data.headRefOid ?? "").toLowerCase(), state: (data.state ?? "OPEN").toUpperCase(), artifacts };
}

/**
 * Hidden line the dispatcher appends to a verdict it posts. It ties the
 * comment to one run, so a retry after a write that GitHub reported as
 * failed but actually stored can see it and not post the verdict twice.
 */
export function handoffMarker(opts: { agent: string; issueNumber: number; startedAtMs: number }): string {
  return `<!-- pyry-verdict-handoff agent=${opts.agent} issue=${opts.issueNumber} run=${opts.startedAtMs} -->`;
}

/**
 * True when this run's verdict is already on the PR: an artifact since the
 * run began that carries the run's marker, or the agent's own post of the
 * same body that landed late.
 */
export function verdictLanded(
  artifacts: readonly PrArtifact[],
  opts: { startedAtMs: number; marker: string; body: string },
): boolean {
  const body = opts.body.trim();
  return artifacts.some((a) => {
    const t = Date.parse(a.at);
    if (!Number.isFinite(t) || t < opts.startedAtMs) return false;
    return a.body.includes(opts.marker) || a.body.trim() === body;
  });
}

/** What the dispatcher found when it looked for the ticket's PR. */
export type VerdictPrLookup =
  | { kind: "found"; number: number; view: PrVerdictView }
  /** No open PR on the branch. */
  | { kind: "none" }
  /** GitHub could not be read. */
  | { kind: "unreadable" };

export type VerdictRecoveryDecision =
  | { kind: "publish"; pr: number }
  /** A later attempt found its own earlier post: apply the labels only. */
  | { kind: "already-posted"; pr: number }
  /** GitHub could not be read; keep the handoff and try next cycle. */
  | { kind: "wait" }
  | { kind: "park"; reason: string };

/**
 * Whether to publish a saved verdict. `firstAttempt` is the run's own
 * error path, where the verdict guard's rule applies: anything posted on
 * the PR since the run began means this is not the publication gap, so the
 * run parks as it always did. Later attempts, from the pending sweep, look
 * for their own marker instead, so an unrelated comment cannot hide the
 * verdict and a write that landed despite an error is not repeated.
 */
export function decideVerdictRecovery(opts: {
  handoff: HandoffParse | null;
  pr: VerdictPrLookup;
  startedAtMs: number;
  firstAttempt: boolean;
  marker: string;
}): VerdictRecoveryDecision {
  if (opts.handoff === null) return { kind: "park", reason: "no verdict handoff file" };
  if (!opts.handoff.ok) return { kind: "park", reason: `verdict handoff incomplete: ${opts.handoff.reason}` };
  const handoff = opts.handoff.handoff;
  if (opts.pr.kind === "unreadable") return { kind: "wait" };
  if (opts.pr.kind === "none") return { kind: "park", reason: "no open pull request to post the verdict on" };
  const { number, view } = opts.pr;
  if (view.state !== "OPEN") return { kind: "park", reason: `pull request #${number} is ${view.state.toLowerCase()}` };
  if (view.headOid !== handoff.commit) {
    return { kind: "park", reason: `PR #${number} head moved from the reviewed commit ${handoff.commit.slice(0, 12)} to ${view.headOid.slice(0, 12) || "unknown"}` };
  }
  if (opts.firstAttempt) {
    const since = view.artifacts.filter((a) => {
      const t = Date.parse(a.at);
      return Number.isFinite(t) && t >= opts.startedAtMs;
    });
    if (since.length > 0) return { kind: "park", reason: `PR #${number} already has a review or comment from this run` };
    return { kind: "publish", pr: number };
  }
  if (verdictLanded(view.artifacts, { startedAtMs: opts.startedAtMs, marker: opts.marker, body: handoff.body })) {
    return { kind: "already-posted", pr: number };
  }
  return { kind: "publish", pr: number };
}

/** The label that holds a ticket while its saved verdict waits for GitHub. */
export const PENDING_VERDICT_PREFIX = "pending-verdict:";

/** What the dispatcher keeps between cycles for a pending verdict. */
export interface PendingVerdictState {
  agent: string;
  issueNumber: number;
  pr: number | null;
  startedAtMs: number;
  handoff: VerdictHandoff;
}

export function serializePendingVerdictState(state: PendingVerdictState): string {
  return JSON.stringify(state, null, 2) + "\n";
}

/** Null for anything that is not a complete state; the sweep then parks. */
export function parsePendingVerdictState(json: string): PendingVerdictState | null {
  let raw: any;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.agent !== "string" || !Number.isInteger(raw.issueNumber) || !Number.isFinite(raw.startedAtMs)) return null;
  if (raw.pr !== null && !Number.isInteger(raw.pr)) return null;
  const h = raw.handoff;
  if (!h || typeof h.body !== "string" || typeof h.commit !== "string" || !Array.isArray(h.labels)) return null;
  // Re-validate through the parser so a hand-edited state file cannot carry
  // anything a handoff file could not.
  const reparsed = parseVerdictHandoff(`decision: ${h.decision}\ncommit: ${h.commit}\nlabels: ${h.labels.join(" ")}\n---\n${h.body}`);
  if (!reparsed.ok) return null;
  return { agent: raw.agent, issueNumber: raw.issueNumber, pr: raw.pr, startedAtMs: raw.startedAtMs, handoff: reparsed.handoff };
}

/** Prompt note naming the handoff file. Runner-agnostic: both runners read the prompt. */
export function verdictHandoffNote(path: string): string {
  return [
    "",
    "",
    "## Verdict handoff",
    "",
    `Before you post your verdict, write it to \`${path}\` in this exact shape:`,
    "",
    "```",
    "decision: PASS or FAIL",
    "commit: <full 40-character SHA of the PR head you reviewed>",
    "labels: <labels your verdict adds, such as needs-rework:builder on a FAIL; leave empty on a PASS>",
    "---",
    "<the verdict comment body, exactly as you will post it>",
    "```",
    "",
    "Then post the verdict and apply its labels as usual. If GitHub refuses the post, do not retry in a loop: leave the handoff file in place and end with status blocked, saying the GitHub write failed. The dispatcher posts the saved verdict itself when the PR head still matches the commit.",
  ].join("\n");
}
