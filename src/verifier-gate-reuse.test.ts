import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  decideDocsOnlyGateReuse,
  decideVerifierGateReuse,
  hashGateList,
  matchesDocsPath,
  parseVerifierDocsGates,
  parseVerifierDocsPaths,
  parseVerifierGatePass,
  VERIFIER_GATE_REUSE_MAX_AGE_MS,
  verifierGatePassFileName,
  verifierGateReuseEnabled,
  type VerifierGatePass,
} from "./verifier-gate-reuse.js";

const COMMIT = "a".repeat(40);
const TREE = "e".repeat(40);
const GATES = ["./gradlew check", "python3 scripts/android-test-gate.py ui"];
const NOW = Date.parse("2026-10-02T09:00:00.000Z");
const LOGS = ["/logs/verifier-gate_#1340_1.log", "/logs/verifier-gate_#1340_1.stderr.log"];

function pass(overrides: Partial<VerifierGatePass> = {}): VerifierGatePass {
  return {
    issueNumber: 1340,
    commit: COMMIT,
    tree: TREE,
    gatesHash: hashGateList(GATES),
    gates: GATES,
    passedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    summary: GATES.map((g) => `✓ ${g} (exit 0)`),
    logPaths: LOGS,
    ...overrides,
  };
}

function decide(overrides: {
  pass?: VerifierGatePass | null;
  tree?: string;
  gatesHash?: string;
  nowMs?: number;
  existing?: readonly string[];
} = {}) {
  const existing = new Set(overrides.existing ?? LOGS);
  return decideVerifierGateReuse({
    pass: overrides.pass === undefined ? pass() : overrides.pass,
    issueNumber: 1340,
    tree: overrides.tree ?? TREE,
    gatesHash: overrides.gatesHash ?? hashGateList(GATES),
    nowMs: overrides.nowMs ?? NOW,
    logExists: (p) => existing.has(p),
  });
}

describe("verifier gate reuse — a pass on the same files is not paid for twice (2026-10-02, #1340)", () => {
  test("matching issue, tree and gate list, under a day old, logs on disk → reuse", () => {
    const d = decide();
    assert.equal(d.reuse, true);
    if (d.reuse) assert.equal(d.pass.commit, COMMIT, "the recorded commit comes back for the note");
  });

  test("a re-made merge commit over the same files still reuses: the commit is not part of the key", () => {
    // The decision never sees the current commit at all; a record naming
    // another commit with the same tree is a match.
    const d = decide({ pass: pass({ commit: "b".repeat(40) }) });
    assert.equal(d.reuse, true);
    if (d.reuse) assert.equal(d.pass.commit, "b".repeat(40));
  });

  test("a different merged tree is different files to test → no reuse", () => {
    assert.deepEqual(decide({ tree: "f".repeat(40) }), { reuse: false, reason: "tree-changed" });
  });

  test("an unknown current tree never matches, even an empty recorded one", () => {
    assert.deepEqual(decide({ tree: "", pass: pass({ tree: "" }) }), { reuse: false, reason: "tree-changed" });
  });

  test("a different gate list, including the same gates in another order → no reuse", () => {
    assert.deepEqual(
      decide({ gatesHash: hashGateList([...GATES, "./gradlew assembleDebug"]) }),
      { reuse: false, reason: "gates-changed" },
    );
    assert.deepEqual(
      decide({ gatesHash: hashGateList([...GATES].reverse()) }),
      { reuse: false, reason: "gates-changed" },
    );
  });

  test("a pass 24 hours old or older is run again; just under 24 hours is still reused", () => {
    const at = (ageMs: number) => pass({ passedAt: new Date(NOW - ageMs).toISOString() });
    assert.deepEqual(decide({ pass: at(25 * 60 * 60 * 1000) }), { reuse: false, reason: "expired" });
    assert.deepEqual(decide({ pass: at(VERIFIER_GATE_REUSE_MAX_AGE_MS) }), { reuse: false, reason: "expired" });
    assert.equal(decide({ pass: at(VERIFIER_GATE_REUSE_MAX_AGE_MS - 1000) }).reuse, true);
  });

  test("a pass stamped in the future or with an unreadable time is not trusted", () => {
    assert.deepEqual(
      decide({ pass: pass({ passedAt: new Date(NOW + 60_000).toISOString() }) }),
      { reuse: false, reason: "expired" },
    );
    assert.deepEqual(decide({ pass: pass({ passedAt: "yesterday" }) }), { reuse: false, reason: "expired" });
  });

  test("a missing gate log means the evidence is gone → no reuse", () => {
    assert.deepEqual(decide({ existing: [LOGS[0]!] }), { reuse: false, reason: "log-missing" });
    assert.deepEqual(decide({ pass: pass({ logPaths: [] }) }), { reuse: false, reason: "log-missing" });
  });

  test("no record, or a record for another issue → no reuse", () => {
    assert.deepEqual(decide({ pass: null }), { reuse: false, reason: "no-record" });
    assert.deepEqual(decide({ pass: pass({ issueNumber: 1341 }) }), { reuse: false, reason: "other-issue" });
  });

  test("hashGateList is order-sensitive and cannot be fooled by a delimiter inside a command", () => {
    assert.equal(hashGateList(GATES), hashGateList([...GATES]));
    assert.notEqual(hashGateList(["a", "b"]), hashGateList(["b", "a"]));
    assert.notEqual(hashGateList(["a;b"]), hashGateList(["a", "b"]));
    assert.match(hashGateList(GATES), /^[0-9a-f]{64}$/);
  });

  test("parseVerifierGatePass round-trips a written pass and rejects anything else", () => {
    assert.deepEqual(parseVerifierGatePass(JSON.stringify(pass())), pass());
    assert.equal(parseVerifierGatePass("{not json"), null);
    assert.equal(parseVerifierGatePass(""), null);
    assert.equal(parseVerifierGatePass("null"), null);
    assert.equal(parseVerifierGatePass("[]"), null);
    const { logPaths: _dropped, ...noLogs } = pass();
    assert.equal(parseVerifierGatePass(JSON.stringify(noLogs)), null);
    assert.equal(parseVerifierGatePass(JSON.stringify({ ...pass(), commit: 7 })), null);
    const { tree: _noTree, ...treeless } = pass();
    assert.equal(parseVerifierGatePass(JSON.stringify(treeless)), null, "a record without a tree cannot be matched");
    assert.equal(parseVerifierGatePass(JSON.stringify({ ...pass(), summary: [1] })), null);
  });

  test("PYRY_VERIFIER_GATE_REUSE: on by default, exactly 0 turns it off", () => {
    assert.equal(verifierGateReuseEnabled({}), true);
    assert.equal(verifierGateReuseEnabled({ PYRY_VERIFIER_GATE_REUSE: "1" }), true);
    assert.equal(verifierGateReuseEnabled({ PYRY_VERIFIER_GATE_REUSE: "" }), true);
    assert.equal(verifierGateReuseEnabled({ PYRY_VERIFIER_GATE_REUSE: "0" }), false);
    assert.equal(verifierGateReuseEnabled({ PYRY_VERIFIER_GATE_REUSE: " 0 " }), false);
  });

  test("the pass file sits beside the gate logs, one per issue", () => {
    assert.equal(verifierGatePassFileName(1340), "verifier-gate_#1340.pass.json");
  });
});

describe("verifier gate reuse — a docs-only change since the green run (#134)", () => {
  const NEW_TREE = "f".repeat(40);
  const DOCS_GATE = "python3 scripts/docs-guard.py";
  const ALL = [...GATES, DOCS_GATE];
  const full = (overrides: Partial<VerifierGatePass> = {}) => pass({
    gatesHash: hashGateList(ALL),
    gates: ALL,
    summary: ALL.map((g) => `✓ ${g} (exit 0)`),
    ...overrides,
  });

  function decideDocs(overrides: {
    pass?: VerifierGatePass | null;
    tree?: string;
    gatesHash?: string;
    nowMs?: number;
    existing?: readonly string[];
    files?: string[] | null;
    docsPaths?: string[];
    docsGates?: string[];
  } = {}) {
    const existing = new Set(overrides.existing ?? LOGS);
    const asked: string[] = [];
    const decision = decideDocsOnlyGateReuse({
      pass: overrides.pass === undefined ? full() : overrides.pass,
      issueNumber: 1340,
      tree: overrides.tree ?? NEW_TREE,
      gates: ALL,
      gatesHash: overrides.gatesHash ?? hashGateList(ALL),
      nowMs: overrides.nowMs ?? NOW,
      logExists: (p) => existing.has(p),
      docsPaths: overrides.docsPaths ?? ["docs/**"],
      docsGates: overrides.docsGates ?? [],
      changedFiles: (from) => {
        asked.push(from);
        return overrides.files === undefined ? ["docs/specs/architecture/1340.md"] : overrides.files;
      },
    });
    return { decision, asked };
  }

  test("only files under docs/ changed → reuse, nothing reruns without docs gates, the files come back", () => {
    const { decision, asked } = decideDocs({ files: ["docs/specs/architecture/1340.md", "docs/knowledge/INDEX.md"] });
    assert.deepEqual(asked, [COMMIT], "the diff base is the commit the pass ran on");
    assert.equal(decision.reuse, true);
    if (decision.reuse) {
      assert.deepEqual(decision.files, ["docs/specs/architecture/1340.md", "docs/knowledge/INDEX.md"]);
      assert.deepEqual(decision.rerun, []);
      assert.equal(decision.pass.commit, COMMIT);
    }
  });

  test("the documentation gates in the gate list rerun, in gate-list order; one not in the list is ignored", () => {
    const { decision } = decideDocs({ docsGates: ["not a gate", DOCS_GATE] });
    assert.equal(decision.reuse, true);
    if (decision.reuse) assert.deepEqual(decision.rerun, [DOCS_GATE]);
  });

  test("one changed path outside the documentation globs → no reuse", () => {
    assert.deepEqual(
      decideDocs({ files: ["docs/specs/architecture/1340.md", "app/src/main/Foo.kt"] }).decision,
      { reuse: false, reason: "code-changed" },
    );
  });

  test("a failed or empty diff → no reuse", () => {
    assert.deepEqual(decideDocs({ files: null }).decision, { reuse: false, reason: "diff-failed" });
    assert.deepEqual(decideDocs({ files: [] }).decision, { reuse: false, reason: "diff-failed" });
  });

  test("the same tree is the exact match's business, not this one's", () => {
    const { decision, asked } = decideDocs({ tree: TREE });
    assert.deepEqual(decision, { reuse: false, reason: "same-tree" });
    assert.deepEqual(asked, []);
  });

  test("expired, changed gate list, missing log or no record → no reuse, and git is not asked", () => {
    const old = full({ passedAt: new Date(NOW - VERIFIER_GATE_REUSE_MAX_AGE_MS).toISOString() });
    for (const [overrides, reason] of [
      [{ pass: old }, "expired"],
      [{ gatesHash: hashGateList(GATES) }, "gates-changed"],
      [{ existing: [LOGS[0]!] }, "log-missing"],
      [{ pass: null }, "no-record"],
      [{ pass: full({ issueNumber: 1341 }) }, "other-issue"],
    ] as const) {
      const { decision, asked } = decideDocs(overrides);
      assert.deepEqual(decision, { reuse: false, reason });
      assert.deepEqual(asked, [], `no diff for ${reason}`);
    }
  });

  test("an unknown current tree never reuses", () => {
    assert.deepEqual(decideDocs({ tree: "" }).decision, { reuse: false, reason: "tree-changed" });
  });

  test("an empty documentation glob list counts nothing as documentation", () => {
    assert.deepEqual(decideDocs({ docsPaths: [] }).decision, { reuse: false, reason: "code-changed" });
  });

  test("matchesDocsPath: ** spans folders, * stays inside one", () => {
    assert.equal(matchesDocsPath("docs/a.md", ["docs/**"]), true);
    assert.equal(matchesDocsPath("docs/specs/architecture/1340.md", ["docs/**"]), true);
    assert.equal(matchesDocsPath("src/docs/a.md", ["docs/**"]), false);
    assert.equal(matchesDocsPath("docsx/a.md", ["docs/**"]), false);
    assert.equal(matchesDocsPath("docs/a.md", ["docs/*"]), true);
    assert.equal(matchesDocsPath("docs/specs/a.md", ["docs/*"]), false);
    assert.equal(matchesDocsPath("README.md", ["*.md"]), true);
    assert.equal(matchesDocsPath("app/README.md", ["*.md"]), false);
    assert.equal(matchesDocsPath("app/README.md", ["**/*.md"]), true);
    assert.equal(matchesDocsPath("README.md", ["**/*.md"]), true);
    assert.equal(matchesDocsPath("CHANGELOG.md", ["docs/**", "CHANGELOG.md"]), true);
    assert.equal(matchesDocsPath("docs/a+b(1).md", ["docs/a+b(1).md"]), true, "regex characters are literal");
    assert.equal(matchesDocsPath("docs/aXb.md", ["docs/a.b.md"]), false);
  });

  test("PYRY_VERIFIER_DOCS_PATHS: docs/** by default, comma-separated globs when set", () => {
    assert.deepEqual(parseVerifierDocsPaths(undefined), ["docs/**"]);
    assert.deepEqual(parseVerifierDocsPaths("docs/**, *.md ,,"), ["docs/**", "*.md"]);
    assert.deepEqual(parseVerifierDocsPaths(""), []);
  });

  test("PYRY_VERIFIER_DOCS_GATES: none by default, ;-separated gate commands when set", () => {
    assert.deepEqual(parseVerifierDocsGates(undefined), []);
    assert.deepEqual(parseVerifierDocsGates(""), []);
    assert.deepEqual(parseVerifierDocsGates(" python3 scripts/docs-guard.py ; make lint-docs;"), [
      "python3 scripts/docs-guard.py",
      "make lint-docs",
    ]);
  });
});
