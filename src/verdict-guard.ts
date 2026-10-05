// Verdict guard: an agent whose whole job is a verdict must have posted one.
//
// The builder set's verifier records its decision on the pull request, a
// review or a comment headed "Verifier Review", and routes a FAIL by adding
// `needs-rework:builder`. The dispatcher reads labels, not prose, so a run
// that exits cleanly with no rework label is a PASS by construction. On
// 2026-09-22 Mobile #782's verifier identified a regression, started a
// baseline run in the background to prove it, wrote that it was waiting for
// the result, and ended its turn. No review, no label, clean exit: the
// dispatcher applied `done:verifier`, documentation ran, and only a hand
// intervention kept a red UI suite off main.
//
// This guard is the code-level net for that shape, the same fabric as the
// empty-branch guard for commit-producing agents: after a clean run of an
// agent marked `requiresVerdict`, the ticket's pull request must carry a
// review or a comment posted after the run started, unless the run routed
// the ticket with a rework label. Otherwise the run is an error, not a
// pass, and the ticket parks with `error:<agent>` for a person to look at.
//
// The same artifacts feed the rework breaker's repeat rule (agent-dispatcher
// #122): the `[MUST FIX]` findings of the newest FAIL verdict and the one
// before it, compared by their `path → Symbol` keys. See
// `findRepeatedMustFix`.
//
// Pure helpers here; the I/O (the `gh` calls) stays in dispatch.ts.

export interface VerdictArtifact {
  /** ISO-8601 timestamp of the review's submission or the comment's creation. */
  at: string;
  /** The review's or comment's text, empty when the payload carried none. */
  body?: string;
}

/**
 * Parse `gh pr view <n> --json reviews,comments` output into timestamps and
 * bodies. Tolerates either key being absent. Throws on malformed JSON so the
 * caller can decide to skip the guard rather than flag a run on a parse
 * failure.
 */
export function parseVerdictArtifacts(json: string): VerdictArtifact[] {
  const data = JSON.parse(json) as {
    reviews?: Array<{ submittedAt?: string; body?: string }>;
    comments?: Array<{ createdAt?: string; body?: string }>;
  };
  const out: VerdictArtifact[] = [];
  for (const r of data.reviews ?? []) if (r.submittedAt) out.push({ at: r.submittedAt, body: r.body ?? "" });
  for (const c of data.comments ?? []) if (c.createdAt) out.push({ at: c.createdAt, body: c.body ?? "" });
  return out;
}

/** A verifier verdict that failed the PR: headed "Verifier Review" and ruling FAIL. */
function isFailVerdict(body: string): boolean {
  return /^##\s+Verifier Review\b/m.test(body) && /\*\*Decision:\s*FAIL\*\*/i.test(body);
}

/** `- [MUST FIX] `path` → `Symbol`: …`, arrow as `→` or `->`, symbol quoted or bare. */
const MUST_FIX_KEY = /\[MUST FIX\]\s*`([^`]+)`\s*(?:→|->)\s*(?:`([^`]+)`|([^\s:`]+))/;

/**
 * The `path → Symbol` keys of a verdict's `[MUST FIX]` findings, in order,
 * without duplicates. The verifier prompt asks for the symbol rather than
 * the line because the builder's next push shifts line numbers, so a finding
 * with no symbol (a line-number finding, free text) yields no key.
 */
export function extractMustFixKeys(body: string): string[] {
  const keys = new Set<string>();
  for (const line of body.split("\n")) {
    const m = MUST_FIX_KEY.exec(line);
    if (m) keys.add(`${m[1].trim()} → ${(m[2] ?? m[3]).trim()}`);
  }
  return [...keys];
}

/**
 * The `[MUST FIX]` keys the newest FAIL verdict shares with the FAIL verdict
 * before it: the verifier raising the same finding after the builder said it
 * was fixed. Reviews and comments both count, ordered by time; PASS verdicts
 * and other comments are skipped. A verdict posted twice word for word, as a
 * review and a comment, is one round. Empty when there are fewer than two
 * FAIL verdicts or either has no parseable key, so the caller falls back to
 * the count rule.
 */
export function findRepeatedMustFix(artifacts: readonly VerdictArtifact[]): string[] {
  const fails = artifacts
    .filter((a) => a.body && isFailVerdict(a.body) && Number.isFinite(Date.parse(a.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((a) => a.body!.trim());
  const [newest, previous] = [...new Set(fails)];
  if (previous === undefined) return [];
  const prior = new Set(extractMustFixKeys(previous));
  return extractMustFixKeys(newest).filter((k) => prior.has(k));
}

/** How many artifacts were posted at or after the run started. */
export function countVerdictsSince(artifacts: readonly VerdictArtifact[], startedAtMs: number): number {
  let n = 0;
  for (const a of artifacts) {
    const t = Date.parse(a.at);
    if (Number.isFinite(t) && t >= startedAtMs) n++;
  }
  return n;
}

/**
 * The guard's decision. Flags only when the agent requires a verdict, the
 * run left no rework label (a FAIL routes by label and needs no review to
 * be honest), and nothing was posted on the pull request since the run
 * began. A negative count means the lookup failed; the guard then stays
 * quiet, matching the empty-branch guard's stance on git errors.
 */
export function shouldFlagMissingVerdict(
  agent: { requiresVerdict?: boolean },
  postLabels: readonly string[],
  verdictsSinceStart: number,
): boolean {
  if (!agent.requiresVerdict) return false;
  if (verdictsSinceStart !== 0) return false;
  if (postLabels.some((l) => l.startsWith("needs-rework:"))) return false;
  return true;
}

/**
 * Pick the pull request the verdict should be on, from
 * `gh pr list --head feature/<n> --state open --json number,isDraft`
 * output: the non-draft one when both exist, else the first. Null when
 * there is none, in which case the guard has nothing to check.
 */
export function pickVerdictPr(json: string): number | null {
  const prs = (JSON.parse(json || "[]") as Array<{ number: number; isDraft?: boolean }>);
  const ready = prs.find((p) => p.isDraft === false);
  const chosen = ready ?? prs[0];
  return chosen ? chosen.number : null;
}
