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
// before it, compared by their `path → Symbol` keys and then by their text
// (#130). See `findRepeatedMustFix`.
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

/** One `[MUST FIX]` finding: its `path → Symbol` key and the text after it. */
export interface MustFixFinding {
  key: string;
  text: string;
}

/**
 * A verdict's `[MUST FIX]` findings, in order, each with its `path → Symbol`
 * key and the rest of its line. The verifier prompt asks for the symbol
 * rather than the line because the builder's next push shifts line numbers,
 * so a finding with no symbol (a line-number finding, free text) is skipped.
 */
export function extractMustFixFindings(body: string): MustFixFinding[] {
  const out: MustFixFinding[] = [];
  for (const line of body.split("\n")) {
    const m = MUST_FIX_KEY.exec(line);
    if (m) out.push({ key: `${m[1].trim()} → ${(m[2] ?? m[3]).trim()}`, text: line.slice(m.index + m[0].length) });
  }
  return out;
}

/** The distinct `path → Symbol` keys of a verdict's `[MUST FIX]` findings, in order. */
export function extractMustFixKeys(body: string): string[] {
  return [...new Set(extractMustFixFindings(body).map((f) => f.key))];
}

/**
 * How alike two findings under the same key must read to count as one
 * finding raised again, on `findingTextSimilarity`'s 0 to 1 scale.
 *
 * The location alone is not enough: a large function collects unrelated
 * findings. Exact text is too much: the verifier rewords a finding it raises
 * again. Measured on the verbatim verdicts for mobile #1747 on
 * pyrycode-mobile PR #1755, 2026-10-05, all under `ThreadScreen.kt` →
 * `ThreadScreen`: the ordering defect raised at 10:18 and again at 12:42
 * ("the previously reported … defect remains") scores 0.56. The different
 * paste-callback defect at 14:05 scores 0.11 against 12:42 and 0.13 against
 * 10:18. Pinned by verdict-guard.test.ts.
 */
export const REPEAT_FINDING_SIMILARITY = 0.3;

/** Short words that carry no meaning for telling two findings apart. */
const FINDING_STOP_WORDS = new Set((
  "a an and are as at be been but by can for from has have in into is it its no not of on or so " +
  "than that the their then there these this those to was were which while with also only same each both " +
  "still after before"
).split(" "));

/**
 * A finding's text normalised to a set of word stems: lower case, links and
 * Markdown dropped, split on anything that is not a letter or digit, short
 * and stop words removed, and a plural `s` trimmed.
 */
function findingWords(text: string): Set<string> {
  const words = text.toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !FINDING_STOP_WORDS.has(w))
    .map((w) => w.replace(/s$/, ""));
  return new Set(words);
}

/**
 * Jaccard similarity of two findings' normalised word sets, 0 to 1. Two
 * texts with no words left after normalising, such as a bare key, read as
 * identical.
 */
export function findingTextSimilarity(a: string, b: string): number {
  const wa = findingWords(a);
  const wb = findingWords(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/**
 * The `[MUST FIX]` keys the newest FAIL verdict shares with the FAIL verdict
 * before it, where the two findings under that key also read alike
 * (`REPEAT_FINDING_SIMILARITY`): the verifier raising the same finding after
 * the builder said it was fixed, not a new finding in the same function.
 * Reviews and comments both count, ordered by time; PASS verdicts and other
 * comments are skipped. A verdict posted twice word for word, as a review and
 * a comment, is one round. Empty when there are fewer than two FAIL verdicts
 * or either has no parseable key, so the caller falls back to the count rule.
 */
export function findRepeatedMustFix(artifacts: readonly VerdictArtifact[]): string[] {
  const [newest, previous] = failVerdictsNewestFirst(artifacts);
  if (previous === undefined) return [];
  const prior = extractMustFixFindings(previous).filter((f) => !isBranchInvariantKey(f.key));
  const repeated = extractMustFixFindings(newest).filter((f) =>
    !isBranchInvariantKey(f.key) &&
    prior.some((p) => p.key === f.key && findingTextSimilarity(p.text, f.text) >= REPEAT_FINDING_SIMILARITY));
  return [...new Set(repeated.map((f) => f.key))];
}

/** The distinct FAIL verdict bodies, newest first. */
function failVerdictsNewestFirst(artifacts: readonly VerdictArtifact[]): string[] {
  const fails = artifacts
    .filter((a) => a.body && isFailVerdict(a.body) && Number.isFinite(Date.parse(a.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((a) => a.body!.trim());
  return [...new Set(fails)];
}

/** The newest FAIL verdict's body, or null when the pull request has none. */
export function newestFailVerdict(artifacts: readonly VerdictArtifact[]): string | null {
  return failVerdictsNewestFirst(artifacts)[0] ?? null;
}

// Branch invariants: findings about the branch, not about any source.
//
// The verifier's pre-verify gate checks that current `origin/main` is an
// ancestor of the reviewed head. When main moves between the dispatcher's
// merge and that check, the verdict FAILs with one finding located at the
// branch itself, `feature/<n>` → "reviewed HEAD", "branch ancestry", "HEAD
// integration" and so on. Overnight 2026-10-06 to 2026-10-07 that happened on
// desktop #1731, #1779, #1818 and #1825: each cost a builder round that only
// merged main, and on #1825 the same finding in two FAILs running parked the
// ticket through the repeat rule although every code finding was fixed.
//
// A finding like that has no source symbol, and "the same finding again"
// says only that main moved again, which is not a loop the builder is in.
// So branch-located keys never count toward the repeat rule, and a FAIL whose
// only blocking findings are a stale base is settled by the dispatcher
// merging main itself (reconcile.ts), not by a builder round.

/** A ticket branch, `main` or `HEAD` as a finding's location, in any of the
 *  forms the verifier writes it. */
const BRANCH_LOCATION = /^(?:refs\/heads\/|origin\/)?(?:feature\/\d+|main|master|HEAD)$/;

/**
 * Whether a `path → Symbol` key from `extractMustFixFindings` is located at a
 * branch rather than a source file: `feature/1825 → reviewed`. Such a finding
 * is a branch invariant with no source symbol.
 */
export function isBranchInvariantKey(key: string): boolean {
  const path = key.split(" → ")[0].trim();
  return BRANCH_LOCATION.test(path);
}

/** `[MUST FIX]`, in the tag form the verifier writes. */
const MUST_FIX_TAG = /\[MUST FIX\]/i;

/**
 * Whether one verdict line is a `[MUST FIX]` finding that the branch lacks
 * current main. The location, the text between the tag and the first arrow,
 * must be a ticket branch (`feature/<n>`, with or without a `Git branch`
 * prefix), and the line must say main is missing: it names main together with
 * ancestry, containment or merging. A finding located at a source file never
 * qualifies, whatever it says about main.
 */
export function isStaleBaseFinding(line: string): boolean {
  const tag = MUST_FIX_TAG.exec(line);
  if (!tag) return false;
  const rest = line.slice(tag.index + tag[0].length);
  const arrow = rest.search(/→|->/);
  const location = arrow >= 0 ? rest.slice(0, arrow) : rest.slice(0, 120);
  if (!/`(?:refs\/heads\/|origin\/)?feature\/\d+`/.test(location)) return false;
  if (!/\b(?:origin\/)?main\b/i.test(rest)) return false;
  return /ancestor|contain|merge|behind|lacks|missing/i.test(rest);
}

/**
 * The verdict's `[MUST FIX]` lines, and whether every one is a stale base
 * finding. `staleBaseOnly` is false when there is no `[MUST FIX]` line at all,
 * so a FAIL with no tagged finding is never read as a stale base.
 */
export function staleBaseFindings(body: string): { mustFix: string[]; staleBaseOnly: boolean } {
  const mustFix = body.split("\n").filter((l) => MUST_FIX_TAG.test(l));
  return { mustFix, staleBaseOnly: mustFix.length > 0 && mustFix.every(isStaleBaseFinding) };
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
