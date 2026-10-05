import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  answeredFindingNumbers,
  extractVerdictFindings,
  REWORK_FINDINGS_HEADING,
  reworkFindingsNote,
  decideVerdictRecovery,
  handoffMarker,
  isVerdictPublishFailure,
  parseLastVerdict,
  parsePendingVerdictState,
  parsePrVerdictView,
  parseVerdictHandoff,
  REREVIEW_HEADING,
  reReviewNote,
  serializeLastVerdict,
  serializePendingVerdictState,
  verdictLanded,
  type VerdictHandoff,
} from "./verdict-handoff.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

function handoffText(opts: { decision?: string; commit?: string; labels?: string; body?: string } = {}): string {
  const lines = [
    `decision: ${opts.decision ?? "PASS"}`,
    `commit: ${opts.commit ?? SHA}`,
  ];
  if (opts.labels !== undefined) lines.push(`labels: ${opts.labels}`);
  return lines.join("\n") + "\n---\n" + (opts.body ?? "## Verifier Review: #1677\n\n**Decision: PASS**\n\nNo findings.\n");
}

describe("parseVerdictHandoff", () => {
  test("a complete PASS handoff parses with no labels", () => {
    const r = parseVerdictHandoff(handoffText());
    assert.ok(r.ok);
    assert.equal(r.handoff.decision, "PASS");
    assert.equal(r.handoff.commit, SHA);
    assert.deepEqual(r.handoff.labels, []);
    assert.match(r.handoff.body, /^## Verifier Review: #1677/);
  });

  test("a FAIL handoff carries its rework label, comma or space separated", () => {
    for (const labels of ["needs-rework:builder, needs-real-claude", "needs-rework:builder needs-real-claude"]) {
      const r = parseVerdictHandoff(handoffText({ decision: "FAIL", labels }));
      assert.ok(r.ok, labels);
      assert.deepEqual(r.handoff.labels, ["needs-rework:builder", "needs-real-claude"]);
    }
  });

  test("decision is case-insensitive and the commit is normalised to lower case", () => {
    const r = parseVerdictHandoff(handoffText({ decision: "pass", commit: SHA.toUpperCase() }));
    assert.ok(r.ok);
    assert.equal(r.handoff.decision, "PASS");
    assert.equal(r.handoff.commit, SHA);
  });

  test("an empty or missing file is incomplete", () => {
    assert.equal(parseVerdictHandoff("").ok, false);
    assert.equal(parseVerdictHandoff("   \n").ok, false);
  });

  test("a header with no separator, or an empty body, is incomplete", () => {
    assert.equal(parseVerdictHandoff(`decision: PASS\ncommit: ${SHA}\n`).ok, false);
    assert.equal(parseVerdictHandoff(handoffText({ body: "  \n" })).ok, false);
  });

  test("a missing or unknown decision is incomplete", () => {
    assert.equal(parseVerdictHandoff(`commit: ${SHA}\n---\nbody`).ok, false);
    assert.equal(parseVerdictHandoff(handoffText({ decision: "MAYBE" })).ok, false);
  });

  test("a short or non-hex commit is incomplete", () => {
    assert.equal(parseVerdictHandoff(handoffText({ commit: "abc1234" })).ok, false);
    assert.equal(parseVerdictHandoff(handoffText({ commit: "HEAD" })).ok, false);
  });

  test("FAIL without a rework label, or PASS with one, is incomplete", () => {
    assert.equal(parseVerdictHandoff(handoffText({ decision: "FAIL" })).ok, false);
    assert.equal(parseVerdictHandoff(handoffText({ decision: "PASS", labels: "needs-rework:builder" })).ok, false);
  });

  test("dispatcher-owned state labels are refused", () => {
    for (const label of ["done:verifier", "error:verifier", "wip:verifier", "pending-done:verifier", "pending-verdict:verifier", "rework-count:2"]) {
      const r = parseVerdictHandoff(handoffText({ labels: label }));
      assert.equal(r.ok, false, label);
    }
  });

  test("a body that contains its own --- lines keeps them; only the first separator splits", () => {
    const r = parseVerdictHandoff(handoffText({ body: "## Verifier Review\n\n---\n\nmore" }));
    assert.ok(r.ok);
    assert.equal(r.handoff.body, "## Verifier Review\n\n---\n\nmore");
  });
});

describe("isVerdictPublishFailure", () => {
  const incident = "Codex task blocked: Review finished with PASS and no findings, but publishing the verdict comment failed with GitHub HTTP 503 and a GraphQL timeout. The full verdict is saved to ~/.codex/publish/pyrycode-mobile/verifier-1680-20261004/review.md.";

  test("the 2026-10-03 mobile #1677 block is a publish failure", () => {
    assert.equal(isVerdictPublishFailure(incident, { approvalRejected: false }), true);
  });

  test("other GitHub write failures count too", () => {
    for (const text of [
      "Codex task blocked: gh pr comment failed: HTTP 502 Bad Gateway",
      "Codex task blocked: posting the review timed out against api.github.com",
      "Codex task blocked: pipeline-action pr-comment failed with a secondary rate limit",
    ]) assert.equal(isVerdictPublishFailure(text, { approvalRejected: false }), true, text);
  });

  test("a block about anything else is not", () => {
    for (const text of [
      "Codex task blocked: Required Figma tools are unavailable.",
      "Codex task blocked: the emulator would not boot, so the review could not finish.",
      "Agent error (timeout). Ran 40m 0s (timeout 40min).",
      "Codex task blocked: GitHub says the branch is behind main; a human decision is needed.",
    ]) assert.equal(isVerdictPublishFailure(text, { approvalRejected: false }), false, text);
  });

  test("an approval rejection never counts, whatever the text says", () => {
    assert.equal(isVerdictPublishFailure(incident, { approvalRejected: true }), false);
    assert.equal(isVerdictPublishFailure("Codex task blocked: Automatic approval review rejected posting the comment to GitHub after HTTP 503.", { approvalRejected: false }), false);
  });
});

describe("parsePrVerdictView + verdictLanded", () => {
  const view = (comments: Array<{ createdAt: string; body: string }>, reviews: Array<{ submittedAt: string; body: string }> = []) =>
    JSON.stringify({ headRefOid: SHA, state: "OPEN", comments, reviews });

  test("reads the head, the state and every artifact with its body", () => {
    const v = parsePrVerdictView(view([{ createdAt: "2026-10-03T10:00:00Z", body: "hi" }], [{ submittedAt: "2026-10-03T11:00:00Z", body: "lgtm" }]));
    assert.equal(v.headOid, SHA);
    assert.equal(v.state, "OPEN");
    assert.deepEqual(v.artifacts.map(a => a.body), ["lgtm", "hi"]);
  });

  test("an artifact carrying this run's marker has landed; another run's marker has not", () => {
    const start = Date.parse("2026-10-03T09:00:00Z");
    const handoff: VerdictHandoff = { decision: "PASS", commit: SHA, labels: [], body: "## Verifier Review" };
    const mine = handoffMarker({ agent: "verifier", issueNumber: 1677, startedAtMs: start });
    const old = handoffMarker({ agent: "verifier", issueNumber: 1677, startedAtMs: start - 1 });
    const v = (body: string) => parsePrVerdictView(view([{ createdAt: "2026-10-03T10:00:00Z", body }]));
    assert.equal(verdictLanded(v(`x\n${mine}`).artifacts, { startedAtMs: start, marker: mine, body: handoff.body }), true);
    assert.equal(verdictLanded(v(`x\n${old}`).artifacts, { startedAtMs: start, marker: mine, body: handoff.body }), false);
  });

  test("the agent's own late post of the same body counts as landed", () => {
    const start = Date.parse("2026-10-03T09:00:00Z");
    const v = parsePrVerdictView(view([{ createdAt: "2026-10-03T10:00:00Z", body: "## Verifier Review\n" }]));
    assert.equal(verdictLanded(v.artifacts, { startedAtMs: start, marker: "<!-- m -->", body: "## Verifier Review" }), true);
  });

  test("a matching body from before the run does not count", () => {
    const start = Date.parse("2026-10-03T11:00:00Z");
    const v = parsePrVerdictView(view([{ createdAt: "2026-10-03T10:00:00Z", body: "## Verifier Review" }]));
    assert.equal(verdictLanded(v.artifacts, { startedAtMs: start, marker: "<!-- m -->", body: "## Verifier Review" }), false);
  });
});

describe("decideVerdictRecovery", () => {
  const start = Date.parse("2026-10-03T09:00:00Z");
  const good = parseVerdictHandoff(handoffText());
  const pr = (headOid: string, artifacts: Array<{ at: string; body: string }> = []) =>
    ({ kind: "found" as const, number: 1680, view: { headOid, state: "OPEN", artifacts } });

  test("a complete handoff on an unchanged head with no verdict since the start publishes", () => {
    const d = decideVerdictRecovery({ handoff: good, pr: pr(SHA), startedAtMs: start, firstAttempt: true, marker: "<!-- m -->" });
    assert.deepEqual(d, { kind: "publish", pr: 1680 });
  });

  test("a moved head parks", () => {
    const d = decideVerdictRecovery({ handoff: good, pr: pr(OTHER), startedAtMs: start, firstAttempt: true, marker: "<!-- m -->" });
    assert.equal(d.kind, "park");
    assert.match((d as { reason: string }).reason, /head/);
  });

  test("a missing or incomplete handoff parks", () => {
    for (const handoff of [null, parseVerdictHandoff("decision: PASS\n---\nbody")]) {
      const d = decideVerdictRecovery({ handoff, pr: pr(SHA), startedAtMs: start, firstAttempt: true, marker: "<!-- m -->" });
      assert.equal(d.kind, "park");
    }
  });

  test("no open PR, or a closed one, parks", () => {
    assert.equal(decideVerdictRecovery({ handoff: good, pr: { kind: "none" }, startedAtMs: start, firstAttempt: true, marker: "m" }).kind, "park");
    assert.equal(decideVerdictRecovery({ handoff: good, pr: { kind: "found", number: 1680, view: { headOid: SHA, state: "MERGED", artifacts: [] } }, startedAtMs: start, firstAttempt: false, marker: "m" }).kind, "park");
  });

  test("a PR that cannot be read waits for the next cycle", () => {
    assert.deepEqual(decideVerdictRecovery({ handoff: good, pr: { kind: "unreadable" }, startedAtMs: start, firstAttempt: true, marker: "m" }), { kind: "wait" });
  });

  test("first attempt: any verdict since the start means this is not the publish gap, so it parks", () => {
    const d = decideVerdictRecovery({ handoff: good, pr: pr(SHA, [{ at: "2026-10-03T10:00:00Z", body: "something" }]), startedAtMs: start, firstAttempt: true, marker: "<!-- m -->" });
    assert.equal(d.kind, "park");
  });

  test("a later attempt: our marker already on the PR skips the post, never a duplicate", () => {
    const d = decideVerdictRecovery({ handoff: good, pr: pr(SHA, [{ at: "2026-10-03T10:00:00Z", body: "body\n<!-- m -->" }]), startedAtMs: start, firstAttempt: false, marker: "<!-- m -->" });
    assert.deepEqual(d, { kind: "already-posted", pr: 1680 });
  });

  test("a later attempt: an unrelated comment since the start does not stop the post", () => {
    const d = decideVerdictRecovery({ handoff: good, pr: pr(SHA, [{ at: "2026-10-03T10:00:00Z", body: "a human note" }]), startedAtMs: start, firstAttempt: false, marker: "<!-- m -->" });
    assert.deepEqual(d, { kind: "publish", pr: 1680 });
  });
});

describe("pending verdict state", () => {
  test("round-trips, and a damaged file reads as null", () => {
    const handoff: VerdictHandoff = { decision: "FAIL", commit: SHA, labels: ["needs-rework:builder"], body: "## Verifier Review" };
    const state = { agent: "verifier", issueNumber: 1677, pr: 1680, startedAtMs: 123, handoff };
    assert.deepEqual(parsePendingVerdictState(serializePendingVerdictState(state)), state);
    assert.equal(parsePendingVerdictState("{"), null);
    assert.equal(parsePendingVerdictState(JSON.stringify({ ...state, handoff: { ...handoff, decision: "MAYBE" } })), null);
    assert.equal(parsePendingVerdictState(JSON.stringify({ ...state, pr: "x" })), null);
  });
});

describe("last verdict (#135)", () => {
  const handoff: VerdictHandoff = { decision: "FAIL", commit: SHA, labels: ["needs-rework:builder"], body: "## Verifier Review\n\n1. Missing null check in Foo.kt" };

  test("round-trips with its record time, and a damaged file reads as null", () => {
    const text = serializeLastVerdict(handoff, "2026-10-05T10:00:00.000Z");
    assert.deepEqual(parseLastVerdict(text), { ...handoff, recordedAt: "2026-10-05T10:00:00.000Z" });
    assert.equal(parseLastVerdict("{"), null);
    assert.equal(parseLastVerdict(""), null);
    assert.equal(parseLastVerdict(JSON.stringify({ ...JSON.parse(text), commit: "abc" })), null);
    assert.equal(parseLastVerdict(JSON.stringify({ ...JSON.parse(text), recordedAt: 5 })), null);
  });
});

describe("reReviewNote (#135)", () => {
  const body = "## Verifier Review\n\n1. Missing null check in Foo.kt";

  test("a narrow change carries the findings as data, both commits and the patch", () => {
    const note = reReviewNote({ body, reviewed: SHA, head: OTHER, patch: "commit abc\n+fixed()", stat: null });
    assert.ok(note.includes(REREVIEW_HEADING));
    assert.match(note, /----- BEGIN PREVIOUS VERDICT -----\n## Verifier Review\n\n1\. Missing null check in Foo\.kt\n----- END PREVIOUS VERDICT -----/);
    assert.ok(note.includes(SHA) && note.includes(OTHER));
    assert.match(note, /----- BEGIN COMMITS -----\ncommit abc\n\+fixed\(\)\n----- END COMMITS -----/);
    assert.match(note, /Check that each finding in the previous verdict is fixed/);
    assert.match(note, /Review the commits since the reviewed commit/);
    assert.match(note, /only when the change is broad/);
    assert.doesNotMatch(note, /The change is broad/);
  });

  test("a broad change gives the stat and the broad-change line instead of the patch", () => {
    const note = reReviewNote({ body, reviewed: SHA, head: OTHER, patch: null, stat: "abc fix\n Foo.kt | 3 ++-" });
    assert.match(note, /The change is broad, so a full review of the whole diff applies/);
    assert.match(note, /Foo\.kt \| 3 \+\+-/);
    assert.doesNotMatch(note, /BEGIN COMMITS/);
    assert.match(note, /BEGIN PREVIOUS VERDICT/);
  });

  test("an empty patch says there are no new commits", () => {
    const note = reReviewNote({ body, reviewed: SHA, head: SHA, patch: "", stat: null });
    assert.match(note, /No commits other than merges since the reviewed commit/);
  });
});

describe("builder answers to a verifier FAIL (#1747)", () => {
  // The three verifier comments on pyrycode-mobile PR #1755 for #1747, verbatim.
  const verdicts = (JSON.parse(readFileSync(new URL("./fixtures/mobile-1755-verdicts.json", import.meta.url), "utf8")) as {
    comments: { createdAt: string; body: string }[];
  }).comments;
  const at = (time: string) => verdicts.find((c) => c.createdAt.includes(time))!.body;

  test("a real verdict's MUST FIX and SHOULD FIX findings, in order, without the NIT", () => {
    const first = extractVerdictFindings(at("10:18"));
    assert.equal(first.length, 4);
    assert.match(first[0]!, /^\[MUST FIX\] `app\/src\/main\/java\/de\/pyryco\/mobile\/ui\/conversations\/thread\/ThreadScreen\.kt` → `ThreadScreen`/);
    assert.match(first[3]!, /^\[SHOULD FIX\] .*MarkdownReaderScreenTest\.kt/);
    // The 14:05 verdict is the one whose paste route the builder never answered.
    const last = extractVerdictFindings(at("14:05"));
    assert.equal(last.length, 1, "the NIT is not asked for");
    assert.match(last[0]!, /^\[MUST FIX\] .*ThreadScreen\.kt/);
  });

  test("an indented continuation stays with its finding; a blank line, a heading or the next item ends it", () => {
    const body = [
      "### Findings",
      "- [MUST FIX] `A.kt` → `a`: first line",
      "  second line of the same finding",
      "- [NIT] `B.kt`: not asked for",
      "  its continuation is dropped too",
      "* [should fix] `C.kt` → `c`: lower case tag",
      "",
      "### Summary",
      "- [MUST FIX] `D.kt` → `d`: after a heading",
    ].join("\n");
    assert.deepEqual(extractVerdictFindings(body), [
      "[MUST FIX] `A.kt` → `a`: first line\nsecond line of the same finding",
      "[should fix] `C.kt` → `c`: lower case tag",
      "[MUST FIX] `D.kt` → `d`: after a heading",
    ]);
    assert.deepEqual(extractVerdictFindings("## Verifier Review\n\n1. Missing null check"), []);
  });

  test("the builder's section numbers the findings and names the answers file and both answer forms", () => {
    const note = reworkFindingsNote({ body: at("10:18"), reviewed: SHA, answersPath: "/p/rework-answers-1747-0123.md" });
    assert.ok(note.includes(REWORK_FINDINGS_HEADING));
    assert.ok(note.includes(SHA));
    assert.match(note, /Its 4 findings are numbered below/);
    assert.match(note, /write your answers to `\/p\/rework-answers-1747-0123\.md`/);
    assert.match(note, /Fixed in <short SHA>/);
    assert.match(note, /Not fixed: <the reason>/);
    assert.match(note, /final summary, under `Verifier findings`/);
    assert.match(note, /----- BEGIN FINDINGS -----\n1\. \[MUST FIX\][\s\S]*\n2\. \[MUST FIX\][\s\S]*\n3\. \[MUST FIX\][\s\S]*\n4\. \[SHOULD FIX\][\s\S]*----- END FINDINGS -----/);
  });

  test("a verdict without tagged findings is given whole, and the builder numbers them", () => {
    const body = "## Verifier Review\n\nThe gate is red: `FooTest` fails.";
    const note = reworkFindingsNote({ body, reviewed: SHA, answersPath: "/p/a.md" });
    assert.match(note, /number them yourself/);
    assert.match(note, /----- BEGIN FINDINGS -----\n## Verifier Review\n\nThe gate is red: `FooTest` fails\.\n----- END FINDINGS -----/);
  });

  test("answered numbers are read from numbered lines only", () => {
    const answers = "1. Fixed in abc1234: queued the paste error\n- 3) Not fixed: out of scope, filed #1800\nSome prose 2. not an answer\n4.";
    assert.deepEqual([...answeredFindingNumbers(answers)].sort(), [1, 3]);
  });

  test("the re-review puts the builder's answers before the previous verdict and names unanswered findings", () => {
    const note = reReviewNote({
      body: at("10:18"), reviewed: SHA, head: OTHER, patch: "+x", stat: null,
      answers: { text: "1. Fixed in abc1234: one queue\n2. Not fixed: the gate failure is inherited, see #1809\n", findings: 4 },
    });
    assert.match(note, /1\. Read the builder's answers below first/);
    assert.match(note, /----- BEGIN BUILDER ANSWERS -----\n1\. Fixed in abc1234: one queue\n2\. Not fixed: the gate failure is inherited, see #1809\n----- END BUILDER ANSWERS -----/);
    assert.match(note, /It gave no answer to findings 3, 4\./);
    assert.ok(note.indexOf("BEGIN BUILDER ANSWERS") < note.indexOf("BEGIN PREVIOUS VERDICT"));
  });

  test("the re-review says when the builder left no answers", () => {
    for (const text of [null, "", "  \n"]) {
      const note = reReviewNote({ body: "b", reviewed: SHA, head: OTHER, patch: "", stat: null, answers: { text, findings: 2 } });
      assert.match(note, /The builder left no answers to these findings\. Check every one yourself\./);
      assert.doesNotMatch(note, /BEGIN BUILDER ANSWERS/);
    }
  });

  test("every finding answered names none as missing", () => {
    const note = reReviewNote({ body: "b", reviewed: SHA, head: OTHER, patch: "", stat: null, answers: { text: "1. Fixed in a: x\n2. Fixed in b: y", findings: 2 } });
    assert.doesNotMatch(note, /gave no answer/);
  });
});
