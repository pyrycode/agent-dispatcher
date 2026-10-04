// Data shapes, artifact parsing, and evidence formatting for the
// dispatcher-executed real-claude gate.
//
// All pure: takes the raw bytes a gate command wrote, returns a tally;
// takes a finished run's facts, returns the comment body. The caller
// (`decideGateVerdict` in pipeline-decisions.ts) turns the tally into a
// verdict; the I/O lives in dispatch.ts (runs it) and reconcile.ts
// (applies it). Both of those import the report shape from here, which
// is why it lives in this file rather than in either of them.
//
// WHY THIS FILE EXISTS AT ALL. On 2026-07-22 a real-claude suite that
// SKIPPED every test still exited 0, the code-review agent read that 0
// as a pass, and an unverified change shipped (pyrycode PR #1169 /
// #1168). The fix is not "ask a human" — it is "count what actually
// ran". Everything here exists to make "0 tests executed" structurally
// distinguishable from "everything passed", which an exit code cannot
// express.
//
// Consequence for callers: the gate command MUST emit machine-readable
// per-test events. For Go that means `go test -json`; the bare
// `make e2e-realclaude` target prints only a package summary on
// success, so executed tests cannot be counted from it and the guard
// this file exists to support cannot be built. That is a contract, not
// a detail.

/** Artifact shapes the gate knows how to read. */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { GateSelection } from "./gate-selection.js";

export type GateOutputFormat = "go-json" | "playwright-json" | "junit-xml";

/** Every format the parser accepts, for env validation at the caller. */
export const GATE_OUTPUT_FORMATS: readonly GateOutputFormat[] = ["go-json", "playwright-json", "junit-xml"];

/**
 * Type guard for the env-configured format string. An unrecognised value
 * must not silently fall back to a default — a fork that typos the format
 * would then have its artifact parsed by the wrong reader, which reads as
 * "zero events" and parks. Loud beats silent, so the caller validates.
 */
export function isGateOutputFormat(value: string): value is GateOutputFormat {
  return (GATE_OUTPUT_FORMATS as readonly string[]).includes(value);
}

/** What the parser extracted from one gate run's artifact. */
export interface GateTally {
  /**
   * Leaf tests that actually ran a body: passed + failed. Skips are
   * deliberately NOT counted — a skip is the exact failure mode this
   * whole mechanism exists to catch, so it must never inflate the
   * number the floor is compared against.
   */
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Fully-qualified names of failed leaf tests, in encounter order. */
  failedNames: string[];
  /**
   * Fully-qualified names of passed leaf tests, in encounter order. The
   * same-tree re-run reads this to say which of the tests it was asked
   * about actually ran and passed; a name in neither list stays failing.
   */
  passedNames: string[];
  /**
   * The subset of `failedNames` that never reached a terminal event because
   * the test binary's OWN deadline fired first (`go test -timeout`). Go
   * reports that as a panic listing every test still running, and nothing
   * else in the stream names them. Counted as failed — a hang is a failure
   * with a name — and listed separately so the evidence comment can say so.
   */
  timedOutTests: string[];
  /** The deadline the binary reported when it fired, e.g. `20m0s`. */
  timedOutBudget?: string;
  /**
   * How long each entry of `timedOutTests` had been running when the
   * deadline fired, e.g. `5m50s`, keyed by the same qualified name. A test
   * that had most of the budget to itself hung; one killed seconds in was
   * squeezed by everything that ran before it.
   */
  timedOutRunningFor?: Record<string, string>;
  /** Reason text for each skip, in encounter order. Deduped downstream. */
  skipReasons: string[];
  /**
   * A suite/package reported failure. True for ordinary test failures too
   * (Go marks the package failed when any test in it fails), so this is
   * only INDEPENDENTLY informative when `failed === 0` — that combination
   * is a build error, a panic, or a harness crash, i.e. a failure with no
   * test to attribute it to.
   */
  packageFailed: boolean;
  /** Packages/suites that reported failure, in encounter order. */
  packageFailures: string[];
  /**
   * How many lines/documents parsed into recognisable events. Zero means
   * the artifact is unusable — there is nothing to judge, which is a very
   * different thing from "nothing failed".
   */
  recognizedLines: number;
}

function emptyTally(): GateTally {
  return {
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    failedNames: [],
    passedNames: [],
    timedOutTests: [],
    skipReasons: [],
    packageFailed: false,
    packageFailures: [],
    recognizedLines: 0,
  };
}

/**
 * The first line of the panic `go test` raises when its own `-timeout`
 * fires. What follows is `running tests:` and one indented line per test
 * still in flight, then a blank line and the goroutine dump.
 */
const GO_TIMEOUT_PANIC = /^\s*panic: test timed out after (\S+)/;

/** One entry of that `running tests:` list: `\t\tTestFoo/case (2m59s)`. */
const GO_RUNNING_TEST_LINE = /^\s+((?:Test|Benchmark|Example|Fuzz)\S*) \(([^)]*)\)\s*$/;

/**
 * Parse a gate command's raw output into a tally.
 *
 * Never throws. A malformed artifact comes back as a tally with
 * `recognizedLines === 0`, which the verdict function reads as unusable.
 * Throwing here would turn a bad artifact into a dispatcher crash, and a
 * crashed dispatcher parks nothing at all.
 */
export function parseGateOutput(raw: string, format: GateOutputFormat): GateTally {
  if (format === "playwright-json") return parsePlaywrightJson(raw);
  if (format === "junit-xml") return parseJUnitXml(raw);
  return parseGoJson(raw);
}

// Android/Gradle emits JUnit XML. The consumer wrapper joins only fresh
// reports under <testsuites> and writes build logs to stderr. Count leaf
// cases, never the advertised suite total: skipped tests are not execution.
function parseJUnitXml(raw: string): GateTally {
  const tally = emptyTally();
  if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true) return tally;
  let doc: any;
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseTagValue: false,
      isArray: name => ["testsuite", "testcase", "failure", "error", "skipped"].includes(name),
    }).parse(raw);
  } catch { return tally; }
  if (!doc || (!doc.testsuite && !doc.testsuites)) return tally;
  tally.recognizedLines = 1;
  type Result = { status: "passed" | "failed" | "skipped"; reason: string };
  const cases = new Map<string, Result>();
  const brokenSuite = (name: string) => {
    tally.packageFailed = true;
    if (!tally.packageFailures.includes(name)) tally.packageFailures.push(name);
  };
  const walk = (suite: any): { count: number; failed: number; skipped: number } => {
    if (!suite || typeof suite !== "object") return { count: 0, failed: 0, skipped: 0 };
    const suiteName = String(suite["@_name"] || "JUnit runner");
    const leaves = Array.isArray(suite.testcase) ? suite.testcase : [];
    let reportedFailures = 0;
    let reportedSkips = 0;
    for (const test of leaves) {
      const method = test?.["@_name"];
      if (typeof method !== "string" || !method.trim()) { brokenSuite(suiteName); continue; }
      const name = `${test["@_classname"] || suiteName}#${method}`;
      const failed = test.failure !== undefined || test.error !== undefined;
      if (failed) reportedFailures++;
      const status = failed ? "failed" : test.skipped !== undefined ? "skipped" : "passed";
      if (status === "skipped") reportedSkips++;
      const skip = test.skipped?.[0];
      const reason = typeof skip === "string" ? skip : String(skip?.["@_message"] || skip?.["#text"] || "no reason recorded");
      const previous = cases.get(name);
      // Duplicate artifacts/retries must neither inflate the floor nor erase red.
      if (!previous || status === "failed" || (previous.status === "skipped" && status === "passed")) {
        cases.set(name, { status, reason });
      }
    }
    let count = leaves.length;
    for (const child of [...(suite.testsuite ?? []), ...(suite.testsuites ? [suite.testsuites] : [])]) {
      const nested = walk(child);
      count += nested.count; reportedFailures += nested.failed; reportedSkips += nested.skipped;
    }
    if (suite.error !== undefined || suite.failure !== undefined) brokenSuite(suiteName);
    const declared = suite["@_tests"];
    if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) !== count)) brokenSuite(suiteName);
    // A runner error can appear only in the summary, with no failing testcase.
    const failures = Number(suite["@_failures"] ?? 0) + Number(suite["@_errors"] ?? 0);
    const skips = Number(suite["@_skipped"] ?? 0);
    if (!Number.isFinite(failures) || failures > reportedFailures || !Number.isFinite(skips) || skips > reportedSkips) brokenSuite(suiteName);
    return { count, failed: reportedFailures, skipped: reportedSkips };
  };
  if (doc.testsuites) walk(doc.testsuites);
  for (const suite of doc.testsuite ?? []) walk(suite);
  for (const [name, result] of cases) {
    if (result.status === "skipped") {
      tally.skipped++;
      tally.skipReasons.push(`${name}: ${result.reason}`);
    } else {
      tally.executed++;
      if (result.status === "failed") { tally.failed++; tally.failedNames.push(name); }
      else { tally.passed++; tally.passedNames.push(name); }
    }
  }
  return tally;
}

// --------- Go: `go test -json` ---------

/** One `go test -json` event. Every field is optional in practice. */
interface GoTestEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Output?: string;
}

/**
 * Parse `go test -json` output (one JSON object per line).
 *
 * Two rules carry the weight here.
 *
 * **Non-JSON lines are ignored, not fatal.** A build error, a panic
 * trace, or a stray `fmt.Println` from a test interleaves raw text into
 * the stream. Treating that as a parse failure would discard a run that
 * is otherwise fully readable — and, worse, would turn a genuine test
 * failure into an "unusable" park, hiding the failure from the developer
 * agent that should be fixing it.
 *
 * **Counting is leaf-only.** A test counts only when no event names a
 * subtest beneath it. Without this, a parent whose subtests all skipped
 * still reports `pass` for itself (its body ran; the subtests declined),
 * so it would add 1 to `executed` and a suite that verified nothing
 * would clear a floor of 1. That is the false-green hole reopened, one
 * level up.
 */
function parseGoJson(raw: string): GateTally {
  const tally = emptyTally();

  // Pass 1: collect events, and learn which test names have children.
  const events: GoTestEvent[] = [];
  const namesByPackage = new Map<string, Set<string>>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed[0] !== "{") continue;
    let event: GoTestEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // interleaved non-JSON — expected, not exceptional
    }
    if (typeof event !== "object" || event === null || typeof event.Action !== "string") continue;
    events.push(event);
    tally.recognizedLines++;
    if (typeof event.Test === "string" && event.Test !== "") {
      const pkg = event.Package ?? "";
      let names = namesByPackage.get(pkg);
      if (!names) { names = new Set(); namesByPackage.set(pkg, names); }
      names.add(event.Test);
    }
  }

  // A test is a parent when another name in the SAME package sits beneath
  // it. Scoping by package matters: two packages routinely share a test
  // name, and a subtest in one would otherwise mask a leaf in the other.
  const hasChildren = (pkg: string, test: string): boolean => {
    const names = namesByPackage.get(pkg);
    if (!names) return false;
    const prefix = `${test}/`;
    for (const name of names) {
      if (name.startsWith(prefix)) return true;
    }
    return false;
  };

  // Pass 2: tally terminal events. `seen` guards against a duplicated
  // terminal event double-counting a test.
  const seen = new Set<string>();
  // Last few output lines per test, so a skip can report WHY it skipped.
  // Bounded at 3 lines per in-flight test and dropped at the terminal
  // event, so a long run cannot grow this without bound.
  const outputTail = new Map<string, string[]>();

  // Tests still running when `go test`'s own deadline fired. They get no
  // terminal event, so without this the run reads as a package failure with
  // no test to attribute. On 2026-09-06 (pyrycode #2089) that happened over
  // one hung offline test the panic had named in full. The budget and each
  // test's running time are kept too: they are what tells a hang from a
  // suite that outran its budget, which the verdict treats differently.
  let inTimeoutList = false;
  const timedOut: { pkg: string; test: string; runningFor: string }[] = [];

  for (const event of events) {
    const pkg = event.Package ?? "";
    const test = event.Test ?? "";
    const key = `${pkg}\t${test}`;

    if (event.Action === "output") {
      const text = event.Output ?? "";
      const panic = text.match(GO_TIMEOUT_PANIC);
      if (panic) {
        inTimeoutList = true;
        tally.timedOutBudget = panic[1];
      } else if (inTimeoutList) {
        const match = text.match(GO_RUNNING_TEST_LINE);
        if (match) {
          timedOut.push({ pkg, test: match[1], runningFor: match[2] });
        } else if (!text.startsWith("\t")) {
          inTimeoutList = false; // blank line, then the goroutine dump
        }
      }
    }

    if (test === "") {
      // Package-level event.
      if (event.Action === "fail") {
        tally.packageFailed = true;
        if (!tally.packageFailures.includes(pkg)) tally.packageFailures.push(pkg);
      }
      continue;
    }

    if (event.Action === "output") {
      const text = (event.Output ?? "").replace(/\n+$/, "");
      if (text.trim() === "") continue;
      const tail = outputTail.get(key) ?? [];
      tail.push(text);
      if (tail.length > 3) tail.shift();
      outputTail.set(key, tail);
      continue;
    }

    const isTerminal = event.Action === "pass" || event.Action === "fail" || event.Action === "skip";
    if (!isTerminal) continue;

    const tail = outputTail.get(key) ?? [];
    outputTail.delete(key);

    // Parents are reported for completeness by `go test` but verify
    // nothing themselves; only leaves count.
    if (hasChildren(pkg, test)) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    const qualified = pkg === "" ? test : `${pkg}.${test}`;
    if (event.Action === "pass") {
      tally.passed++;
      tally.executed++;
      tally.passedNames.push(qualified);
    } else if (event.Action === "fail") {
      tally.failed++;
      tally.executed++;
      tally.failedNames.push(qualified);
    } else {
      tally.skipped++;
      tally.skipReasons.push(`${qualified}: ${extractSkipReason(tail)}`);
    }
  }

  // A hung test ran a body and never finished: failed, executed, and named.
  // Same leaf-only and seen-once rules as a terminal event, so a parent
  // listed alongside its hung subtest is not a second failure.
  for (const { pkg, test, runningFor } of timedOut) {
    const key = `${pkg}\t${test}`;
    if (hasChildren(pkg, test) || seen.has(key)) continue;
    seen.add(key);
    const qualified = pkg === "" ? test : `${pkg}.${test}`;
    tally.failed++;
    tally.executed++;
    tally.failedNames.push(qualified);
    tally.timedOutTests.push(qualified);
    (tally.timedOutRunningFor ??= {})[qualified] = runningFor;
  }

  return tally;
}

/**
 * Pull a human-readable skip reason out of a test's trailing output.
 *
 * `go test` writes the reason as an ordinary output line just before the
 * `--- SKIP:` marker, so the last line that is not a framework marker is
 * the reason. Falls back to a placeholder rather than an empty string —
 * "no reason given" is itself worth seeing in an evidence comment.
 */
function extractSkipReason(tail: readonly string[]): string {
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i].trim();
    if (line === "") continue;
    if (line.startsWith("=== ") || line.startsWith("--- ")) continue;
    return line.length > 200 ? line.slice(0, 200) + "…" : line;
  }
  return "no reason recorded";
}

// --------- Playwright: `--reporter=json` ---------

/**
 * Parse Playwright's JSON reporter output.
 *
 * Unlike `go test -json` this is ONE document, not a stream of lines, so
 * the "ignore non-JSON lines" rule takes a different shape: the parser
 * tries the whole artifact, and on failure retries from the first line
 * that opens an object, which strips any preamble the runner printed
 * before the report.
 *
 * Outcome is read from each test's aggregate `status` rather than its
 * individual `results[]`, so a retried test counts once, not once per
 * attempt. `flaky` counts as executed and passed — it did run and it did
 * end green; treating a flake as a failure would route a ticket to the
 * developer agent over test infrastructure it cannot fix.
 */
function parsePlaywrightJson(raw: string): GateTally {
  const tally = emptyTally();

  const doc = parseLooseJsonDocument(raw);
  if (doc === null || typeof doc !== "object") return tally;

  const suites = (doc as any).suites;
  if (!Array.isArray(suites)) return tally;
  tally.recognizedLines = 1;

  // Top-level `errors` is where Playwright reports a failure with no test
  // to hang it on: a config error, a global-setup throw, a worker crash.
  const errors = (doc as any).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    tally.packageFailed = true;
    tally.packageFailures.push("playwright (global errors)");
  }

  const walk = (suite: any, trail: string[]): void => {
    if (!suite || typeof suite !== "object") return;
    const title = typeof suite.title === "string" && suite.title !== "" ? suite.title : null;
    const nextTrail = title ? [...trail, title] : trail;

    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        if (!spec || typeof spec !== "object") continue;
        const specTitle = typeof spec.title === "string" ? spec.title : "(unnamed)";
        const name = [...nextTrail, specTitle].join(" › ");
        const tests = Array.isArray(spec.tests) ? spec.tests : [];
        for (const test of tests) {
          if (!test || typeof test !== "object") continue;
          tally.recognizedLines++;
          const status = typeof test.status === "string" ? test.status : "";
          if (status === "skipped") {
            tally.skipped++;
            tally.skipReasons.push(`${name}: ${extractPlaywrightSkipReason(test)}`);
          } else if (status === "unexpected") {
            tally.failed++;
            tally.executed++;
            tally.failedNames.push(name);
          } else if (status === "expected" || status === "flaky") {
            tally.passed++;
            tally.executed++;
            tally.passedNames.push(name);
          }
          // Any other status is left uncounted on purpose: an unknown
          // outcome must not become an executed test, because executed
          // tests are what clear the floor.
        }
      }
    }

    if (Array.isArray(suite.suites)) {
      for (const child of suite.suites) walk(child, nextTrail);
    }
  };

  for (const suite of suites) walk(suite, []);
  return tally;
}

function extractPlaywrightSkipReason(test: any): string {
  const annotations = Array.isArray(test.annotations) ? test.annotations : [];
  for (const annotation of annotations) {
    if (annotation && annotation.type === "skip" && typeof annotation.description === "string") {
      return annotation.description;
    }
  }
  return "no reason recorded";
}

// --------- Baseline re-run filter ---------

/**
 * Strip the package qualifier `parseGoJson` adds, leaving the bare test
 * name a test runner's filter understands. `pkg/path.TestFoo/sub` becomes
 * `TestFoo/sub`.
 *
 * Splits at the first dot that introduces a Go test-function prefix rather
 * than at the first or last dot, because BOTH of those are wrong on real
 * input. Package paths carry dots (`github.com/...`, and a final segment
 * can too, as in `gopkg.in/yaml.v2`), so the first dot lands inside the
 * package. And a test name can carry a dot of its own, so the last dot
 * lands inside the name: `pkg.Test-a.b` yields `b`, silently turning one
 * test into a filter for a different one. Go requires these four prefixes,
 * which makes the boundary unambiguous.
 *
 * Returns the input unchanged when no prefix is found, which covers an
 * already-bare name and any non-Go format.
 */
export function stripPackageQualifier(qualifiedName: string): string {
  const boundary = qualifiedName.match(/\.(Test|Benchmark|Example|Fuzz)/);
  if (boundary?.index === undefined) return qualifiedName;
  return qualifiedName.slice(boundary.index + 1);
}

/**
 * Build a shell-safe, anchored filter matching exactly the given failed
 * tests, for re-running them against the base commit.
 *
 * Returns null when there is nothing safe to run. That is a refusal, not a
 * fallback: an empty or unbuildable filter would make the runner re-run the
 * WHOLE suite against the base, turning a seconds-long check into a second
 * five-minute run, and a filter that silently dropped a name would compare
 * different test sets and call a real regression pre-existing.
 *
 * Names are rejected rather than escaped when they contain anything outside
 * a conservative set. Go subtest names can carry arbitrary text with spaces
 * mapped to underscores, so a name is not guaranteed to be an identifier,
 * and quoting arbitrary text into a regex inside a shell command is exactly
 * the kind of two-layer escaping that goes wrong quietly. If any name is
 * unsafe the whole filter is refused, so the comparison is never partial.
 *
 * A subtest is filtered by its TOP-LEVEL test. `go test -run` splits the
 * pattern on `/` and matches each level separately, so an alternation that
 * contains a slash — `^(TestA/sub|TestB)$` — is split into `^(TestA` and
 * `sub|TestB)$`, two broken regexps, and the run refuses to start. Running
 * the whole parent re-runs sibling subtests too, which costs a little and
 * changes nothing: results are still compared by full leaf name.
 *
 * JUnit XML names are `pkg.Class#method`, which is not a regex filter at
 * all. Android instrumentation selects tests with a comma-separated
 * `Class#method` list, so that format gets one, built by
 * `buildJUnitBaselineFilter`. A Go-style regex handed to it would match
 * nothing, the re-run would execute nothing, and every failure would stay
 * the branch's: the loop that sent pyrycode-mobile #1016 back three times.
 */
export function buildBaselineFilter(
  qualifiedFailedNames: readonly string[],
  format: GateOutputFormat = "go-json",
): string | null {
  if (format === "junit-xml") return buildJUnitBaselineFilter(qualifiedFailedNames);
  const safe = /^[A-Za-z0-9_/#.\-]+$/;
  const bare: string[] = [];
  for (const qualified of qualifiedFailedNames) {
    const name = stripPackageQualifier(qualified);
    if (name === "" || !safe.test(name)) return null;
    const top = name.split("/")[0];
    if (top === "") return null;
    if (!bare.includes(top)) bare.push(top);
  }
  if (bare.length === 0) return null;
  // Escape the regex metacharacters the safe set still allows.
  const escaped = bare.map(n => n.replace(/[.\-]/g, m => `\\${m}`));
  // Single-quoted so the shell passes it through untouched. The safe set
  // excludes a single quote, so this cannot be broken out of.
  return `'^(${escaped.join("|")})$'`;
}

/**
 * The JUnit side of `buildBaselineFilter`: a single-quoted, comma-separated
 * `pkg.Class#method` list, the shape Android's instrumentation `class`
 * argument takes. Same refusal rule as the Go filter: one name outside a
 * plain class and method shape refuses the whole list, so a parameterised
 * `method[0]` or a backticked Kotlin name with spaces never yields a partial
 * comparison.
 */
function buildJUnitBaselineFilter(qualifiedFailedNames: readonly string[]): string | null {
  const shape = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*#[A-Za-z_][A-Za-z0-9_]*$/;
  const names: string[] = [];
  for (const name of qualifiedFailedNames) {
    // `$` is legal in a class name and inert inside single quotes.
    if (!shape.test(name)) return null;
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return null;
  return `'${names.join(",")}'`;
}

/** Placeholder a baseline command template must carry. */
export const BASELINE_TESTS_PLACEHOLDER = "{{TESTS}}";

/**
 * Substitute a test filter into a baseline command template.
 *
 * Looks trivial and is not. `String.replaceAll` with a STRING replacement
 * interprets `$'`, `$&` and `` $` `` as substitution patterns, and a filter
 * built by `buildBaselineFilter` ends in `)$'` — a regex anchor followed by
 * the closing shell quote. As a string replacement that `$'` expands to
 * "everything after the match", so the command comes out as
 * `-run '^(TestA|TestB) ./path ./path` with the quote never closed.
 *
 * Observed live on 2026-08-07: bash rejected it with "unexpected EOF while
 * looking for matching `'`", the base run wrote a zero-byte artifact, and
 * the comparison reported itself unavailable — so the branch was blamed for
 * failures it had not caused, which is the exact bug the baseline exists to
 * fix, reintroduced one layer down.
 *
 * A replacer function disables pattern expansion, which is the whole point
 * of this wrapper. Returns null when the template has no placeholder, since
 * substituting nothing would silently re-run the entire suite.
 */
export function buildBaselineCommand(template: string, filter: string): string | null {
  if (!template.includes(BASELINE_TESTS_PLACEHOLDER)) return null;
  return template.replaceAll(BASELINE_TESTS_PLACEHOLDER, () => filter);
}

// --------- The finished-run report ---------

/**
 * Everything one gate run produced. Built by the runner in dispatch.ts,
 * consumed by `runRealClaudeGateExecution` in reconcile.ts.
 *
 * Deliberately holds facts, not conclusions: no `passed` boolean lives
 * here. The verdict is `decideGateVerdict`'s alone, so there is exactly
 * one place where "did this pass?" is decided and exactly one place to
 * read when auditing that decision.
 */
export interface GateRunReport {
  /** Non-null when the run could not be started or completed at all. */
  runError: string | null;
  timedOut: boolean;
  exitCode: number | null;
  /** Parsed artifact, read back FROM DISK. Null when nothing was readable. */
  tally: GateTally | null;
  /** The shell command that was run, verbatim. */
  command: string;
  /** Feature branch the ticket's work sits on. */
  branchName: string;
  /** The default branch the feature branch was merged with for the run. */
  baseRef: string;
  baseSha: string;
  headSha: string;
  /**
   * How many commits the feature branch was behind the base before the
   * merge. Null when it could not be computed. This number is in every
   * evidence comment so the "ran against merged state" claim is auditable
   * rather than asserted: it was 29 on 2026-08-05 and 127 on 2026-08-06,
   * so it moves fast enough to matter.
   */
  commitsBehind: number | null;
  durationMs: number;
  /** Where the judged bytes live on the dispatcher host. */
  outputPath: string;
  outputBytes: number;
  /** Build and device diagnostics, kept separately from the machine-readable report. */
  stderrPath?: string;
  /**
   * Which of the branch's failing tests also fail on the base commit.
   *
   * Null means no baseline was run: the branch had no failures, the fork
   * configured no baseline command, or the baseline itself could not run.
   * Null is deliberately NOT the same as an empty array. Empty means the
   * baseline ran and every failure is new; null means nothing is known,
   * and the two must not collapse, because one of them exonerates a branch
   * and the other does not.
   */
  baselineFailures: string[] | null;
  /** Why no baseline ran, for the evidence comment. Null when one did. */
  baselineSkipReason: string | null;
  /** Where the baseline's own bytes live, when it ran. */
  baselineOutputPath: string | null;
  /**
   * Which of the branch's failing tests failed AGAIN when re-run on the same
   * merged tree, before any base comparison.
   *
   * Null means no re-run happened: nothing failed, no baseline command is
   * configured (the re-run reuses its template), or the re-run could not
   * run. Same null-versus-empty discipline as `baselineFailures`: empty
   * means every failure passed on the second try and is nondeterministic,
   * null means nothing is known and every failure stays on the hook. A
   * flake that passes on the base commit looks exactly like a regression to
   * the base comparison alone, which is how pyrycode #2089 tripped the
   * rework breaker on 2026-09-06 over a test its branch never reaches.
   */
  rerunFailures: string[] | null;
  /** Why no re-run happened, for the evidence comment. Null when one did. */
  rerunSkipReason: string | null;
  /** Where the re-run's own bytes live, when it ran. */
  rerunOutputPath: string | null;
  /**
   * Whether this run was the full suite or the tests the pull request named,
   * and why. Absent when the fork has selection off, so every run is full.
   */
  selection?: GateSelection;
  /**
   * Set when the branch conflicts with the base and the import-only resolver
   * could not settle it, so nothing ran. `paths` lists the conflicted files,
   * empty when git could not name them. `runError` is set as well, so any
   * reader that does not know this field still parks the ticket as before.
   * The execution step hands such a ticket to its code owner to finish the
   * merge (see merge-handoff.ts) instead of parking it.
   */
  mergeConflict?: { paths: string[] };
  /**
   * Files where the branch and the base both added imports at the same spot,
   * which the import-only resolver (merge-resolve.ts) settled in the gate's
   * own merge before the run. Absent or empty when the merge was clean.
   */
  importResolvedPaths?: string[];
}

/**
 * The executed-test floor for one run. A selected run must execute every
 * test it asked for; anything fewer means a named test never ran.
 */
export function gateRunFloor(report: GateRunReport, forkFloor: number): number {
  return report.selection?.mode === "selected" ? report.selection.tests.length : forkFloor;
}

/**
 * Build the evidence comment for a finished gate run.
 *
 * The audience is a human deciding whether to trust the verdict, so every
 * claim the gate makes is shown with the number behind it: what ran, what
 * it ran against, how far behind the base branch it was, how many tests
 * actually executed, and where the full output is. Skips are listed rather
 * than summarised — a skip is not a pass, and the 2026-07-22 incident
 * turned entirely on nobody reading the skip reasons.
 */
export function formatGateEvidenceComment(opts: {
  verdict: string;
  reason: string;
  report: GateRunReport;
  minExecuted: number;
  /** What the dispatcher did to the board as a result. */
  action: string;
  /** Failures the branch introduced, per the base comparison. */
  introduced?: readonly string[];
  /** Failures that also fail on the base commit. */
  preExisting?: readonly string[];
  /** Failures that passed when re-run on the same merged tree. */
  flaky?: readonly string[];
}): string {
  const { report } = opts;
  const heading: Record<string, string> = {
    pass: "✅ Real-claude gate — PASS",
    "flaky-pass": "⚠️ Real-claude gate — PASS, AFTER A RE-RUN",
    fail: "❌ Real-claude gate — FAIL",
    "zero-executed": "🚨 Real-claude gate — NOTHING EXECUTED",
    unusable: "🚨 Real-claude gate — NO USABLE RESULT",
    "inherited-failure": "⚠️ Real-claude gate — FAILURES THIS BRANCH DID NOT CAUSE",
  };

  const lines: string[] = [];
  lines.push(`## ${heading[opts.verdict] ?? `Real-claude gate — ${opts.verdict}`}`);
  lines.push("");
  lines.push(`The dispatcher ran the live-claude suite itself. **${opts.reason}.**`);
  lines.push("");

  lines.push("**What ran**");
  lines.push("```");
  lines.push(report.command);
  lines.push("```");
  lines.push("");
  if (report.selection) {
    lines.push(
      report.selection.mode === "selected"
        ? `Selected run: ${report.selection.reason}.`
        : `Full suite: ${report.selection.reason}.`,
    );
    lines.push("");
  }

  lines.push("**What it ran against**");
  lines.push(`- Branch \`${report.branchName}\` at \`${shortSha(report.headSha)}\``);
  lines.push(`- Merged with \`${report.baseRef}\` at \`${shortSha(report.baseSha)}\` in a detached worktree`);
  lines.push(
    report.commitsBehind === null
      ? `- Commits behind \`${report.baseRef}\` before the merge: could not be computed`
      : `- The branch was **${report.commitsBehind} commit(s) behind** \`${report.baseRef}\` before the merge`,
  );
  if ((report.importResolvedPaths?.length ?? 0) > 0) {
    lines.push(
      `- The merge conflicted only where both sides added imports, in ${report.importResolvedPaths!.map(p => `\`${p}\``).join(", ")}. ` +
      `The run kept both sets in sorted order, as the dispatcher's own merges do`,
    );
  }
  lines.push(
    `- Exit status \`${report.exitCode ?? "none"}\`` +
    (report.timedOut ? " (killed by the outer timeout)" : "") +
    `, wall clock ${(report.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push("");

  if (report.runError) {
    lines.push("**Run error**");
    lines.push("```");
    lines.push(report.runError.slice(0, 1500));
    lines.push("```");
    lines.push("");
  }

  const tally = report.tally;
  if (tally) {
    lines.push("**Result**");
    lines.push("");
    lines.push("| executed | passed | failed | skipped |");
    lines.push("|---:|---:|---:|---:|");
    lines.push(`| ${tally.executed} | ${tally.passed} | ${tally.failed} | ${tally.skipped} |`);
    lines.push("");
    lines.push(
      `Executed counts leaf tests that ran a body: passed plus failed, skips excluded. ` +
      (report.selection?.mode === "selected"
        ? `The floor for this selected run is ${report.selection.tests.length}, one per named test.`
        : `The floor for this fork is ${Math.max(1, opts.minExecuted)}.`),
    );
    lines.push("");

    const flaky = opts.flaky ?? [];
    if (flaky.length > 0) {
      lines.push(
        `**Failed once, then passed when re-run on the same merged tree (${flaky.length})** — ` +
        `nondeterministic, so not attributed to this branch:`,
      );
      lines.push("");
      for (const name of flaky.slice(0, 25)) lines.push(`- \`${name}\``);
      if (flaky.length > 25) lines.push(`- …and ${flaky.length - 25} more, see the re-run output`);
      lines.push("");
      lines.push(
        `Re-run output: \`${report.rerunOutputPath ?? "(none)"}\`. A test on this list is a flake in the suite ` +
        `until someone shows otherwise; it is named here so it can be tracked rather than forgotten.`,
      );
      lines.push("");
    }

    const flakySet = new Set(flaky);
    const remaining = tally.failedNames.filter(name => !flakySet.has(name));
    if (remaining.length > 0) {
      const introduced = opts.introduced ?? [];
      const preExisting = opts.preExisting ?? [];
      const compared = report.baselineFailures !== null;

      if (compared && preExisting.length > 0) {
        lines.push(`**Already failing on \`${report.baseRef}\` (${preExisting.length})** — not caused by this branch:`);
        lines.push("");
        for (const name of preExisting.slice(0, 25)) lines.push(`- \`${name}\``);
        lines.push("");
      }

      const own = compared ? introduced : remaining;
      if (own.length > 0) {
        lines.push(
          compared
            ? `**Failing here but passing on \`${report.baseRef}\` (${own.length})** — introduced by this branch:`
            : `**Failed (${own.length})**`,
        );
        lines.push("");
        for (const name of own.slice(0, 25)) lines.push(`- \`${name}\``);
        if (own.length > 25) lines.push(`- …and ${own.length - 25} more, see the full output`);
        lines.push("");
      }

      lines.push(
        compared
          ? `The failing tests were re-run against \`${report.baseRef}\` alone, unmerged, to separate what this ` +
            `branch broke from what it inherited. Base output: \`${report.baselineOutputPath}\`.`
          : `**No base comparison was made**, so these failures are attributed to this branch by default. ` +
            `Reason: ${report.baselineSkipReason ?? "unknown"}.`,
      );
      lines.push("");
      if (report.rerunFailures === null && report.rerunSkipReason !== null) {
        lines.push(`**No same-tree re-run was made** either, so a flake could not be told from a regression. ` +
          `Reason: ${report.rerunSkipReason}.`);
        lines.push("");
      }
    }

    if (tally.timedOutTests.length > 0) {
      const budget = tally.timedOutBudget ? ` (${tally.timedOutBudget})` : "";
      lines.push(
        `**Still running when the test binary's own timeout${budget} fired (${tally.timedOutTests.length})** — ` +
        `the suite outran its budget. A test that had most of the budget to itself hung; one killed seconds ` +
        `in was squeezed by everything that ran before it, and is not the regression:`,
      );
      lines.push("");
      for (const name of tally.timedOutTests.slice(0, 15)) {
        const ran = tally.timedOutRunningFor?.[name];
        lines.push(ran ? `- \`${name}\` — running for ${ran}` : `- \`${name}\``);
      }
      lines.push("");
    }

    if (tally.packageFailures.length > 0 && tally.failed === 0) {
      lines.push("**Suite-level failure with no failing test** — a build error, a panic, or a harness crash:");
      lines.push("");
      for (const pkg of tally.packageFailures.slice(0, 15)) lines.push(`- \`${pkg}\``);
      lines.push("");
    }

    if (tally.skipReasons.length > 0) {
      lines.push(`**Skipped (${tally.skipped})** — listed, not counted, because a skip is not a pass:`);
      lines.push("");
      for (const reason of tally.skipReasons.slice(0, 25)) lines.push(`- ${reason}`);
      if (tally.skipReasons.length > 25) {
        lines.push(`- …and ${tally.skipReasons.length - 25} more, see the full output`);
      }
      lines.push("");
    }
  } else {
    lines.push("**Result**");
    lines.push("");
    lines.push("No readable test artifact. Nothing was judged, which is not the same as nothing failing.");
    lines.push("");
  }

  lines.push(`**What the dispatcher did:** ${opts.action}`);
  lines.push("");
  lines.push(`Test report: \`${report.outputPath}\` (${formatBytes(report.outputBytes)}) on the dispatcher host.`);
  if (report.stderrPath) lines.push(`Diagnostic log: \`${report.stderrPath}\` on the dispatcher host.`);

  return lines.join("\n");
}

function shortSha(sha: string): string {
  return sha && sha.length > 10 ? sha.slice(0, 10) : (sha || "unknown");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Parse a JSON document that may be preceded by non-JSON preamble.
 * Returns null when nothing parses. Never throws.
 */
function parseLooseJsonDocument(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to the preamble-stripping retry.
  }
  const lines = trimmed.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("{")) {
      try {
        return JSON.parse(lines.slice(i).join("\n"));
      } catch {
        return null;
      }
    }
  }
  return null;
}
