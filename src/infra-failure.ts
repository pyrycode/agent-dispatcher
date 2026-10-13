// --------- Infrastructure-shaped live gate failures ---------
//
// The rework breaker and the retired family breaker count attempts. Neither
// asks WHY a run failed. This module does, for the live gate's first pass,
// and only well enough to answer one question: did the shared environment
// fail, rather than the branch?
//
// Why: on 2026-10-13 pyrycode-mobile #2138's live gate on HP ran 65 tests,
// one passed and 64 failed. Every failure was a connection, readiness or
// daemon-unavailable wait. The same suite had passed 65 of 65 on that branch
// four hours earlier. The production relay was refusing HP's public address:
// 42 connection-cap and 35 rate-limit rejections in four minutes, against a
// default of eight live WebSocket connections per source. The dispatcher then
// started a full same-tree re-run, which only fed the same refusals, and only
// a manual stop ended it. A re-run and a base comparison answer "flake or
// regression?", and neither answer means anything while the relay refuses
// the host.
//
// All pure. dispatch.ts reads the files and acts; reconcile.ts applies the
// verdict. The signatures below are copied from real gate output (HP mobile
// gate logs of 2026-10-10 to 2026-10-13) and from the relay's own rejection
// code, not guessed.

import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { GateOutputFormat, GateTally } from "./gate-output.js";

/** Default state file name for the host pause, in the dispatcher's logs dir. */
export const INFRA_PAUSE_STATE_FILE = "live-gate-infra-pause.json";

export interface InfraBreakerConfig {
  /** `PYRY_INFRA_BREAKER`; `0` turns detection off. On by default. */
  enabled: boolean;
  /** `PYRY_INFRA_BREAKER_MIN_FAILED`: fewer failures than this never trip. */
  minFailed: number;
  /** `PYRY_INFRA_BREAKER_MIN_FAILED_SHARE`: failed / executed must reach this. */
  minFailedShare: number;
  /** `PYRY_INFRA_BREAKER_WAIT_SHARE`: connection-or-wait failures / failed must reach this. */
  waitShare: number;
  /** `PYRY_INFRA_BREAKER_MIN_SIGNATURES`: explicit infrastructure evidence needed. */
  minSignatures: number;
  /**
   * `PYRY_INFRA_COOLDOWN_MS`: how long this dispatcher's live gate pauses
   * after a trip. `0` classifies and halts but never pauses. Capped at
   * `MAX_INFRA_COOLDOWN_MS`.
   */
  cooldownMs: number;
  /** `PYRY_INFRA_BASE_CHECK_TESTS`: failing tests the shape path re-runs on the base to confirm. */
  baseCheckTests: number;
  /** `PYRY_INFRA_BASE_CHECK_TIMEOUT_MS`: wall clock for that base check, at most the gate's own. */
  baseCheckTimeoutMs: number;
}

/** The longest pause a setting or a state file can ask for: one day. */
export const MAX_INFRA_COOLDOWN_MS = 24 * 60 * 60_000;

export const DEFAULT_INFRA_BREAKER_CONFIG: InfraBreakerConfig = {
  enabled: true,
  minFailed: 5,
  minFailedShare: 0.5,
  waitShare: 0.8,
  minSignatures: 3,
  cooldownMs: 30 * 60_000,
  baseCheckTests: 3,
  baseCheckTimeoutMs: 15 * 60_000,
};

/**
 * Read the breaker settings. Garbage, zero or out-of-range values keep the
 * default, except the cooldown, where `0` turns the pause off and anything
 * over a day is capped at a day.
 */
export function readInfraBreakerConfig(env: NodeJS.ProcessEnv): InfraBreakerConfig {
  const d = DEFAULT_INFRA_BREAKER_CONFIG;
  const int = (name: string, fallback: number): number => {
    const n = Number((env[name] ?? "").trim());
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  };
  const share = (name: string, fallback: number): number => {
    const n = Number((env[name] ?? "").trim());
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
  };
  return {
    enabled: (env.PYRY_INFRA_BREAKER ?? "").trim() !== "0",
    minFailed: int("PYRY_INFRA_BREAKER_MIN_FAILED", d.minFailed),
    minFailedShare: share("PYRY_INFRA_BREAKER_MIN_FAILED_SHARE", d.minFailedShare),
    waitShare: share("PYRY_INFRA_BREAKER_WAIT_SHARE", d.waitShare),
    minSignatures: int("PYRY_INFRA_BREAKER_MIN_SIGNATURES", d.minSignatures),
    cooldownMs: (() => {
      const raw = (env.PYRY_INFRA_COOLDOWN_MS ?? "").trim();
      const n = Number(raw);
      if (raw === "" || !Number.isSafeInteger(n) || n < 0) return d.cooldownMs;
      return Math.min(n, MAX_INFRA_COOLDOWN_MS);
    })(),
    baseCheckTests: int("PYRY_INFRA_BASE_CHECK_TESTS", d.baseCheckTests),
    baseCheckTimeoutMs: int("PYRY_INFRA_BASE_CHECK_TIMEOUT_MS", d.baseCheckTimeoutMs),
  };
}

// --------- Signatures ---------

/**
 * A test failed because the phone, the daemon or a fixture never got a
 * working connection or never became ready. Checked before the generic
 * waits, because the mobile harness wraps these in a coroutine timeout:
 * `TimeoutCancellationException: java.lang.AssertionError: peer step ...
 * no open session: none settled yet; redialing` is a connection failure,
 * not a plain timeout.
 */
const CONNECTION_SIGNATURES: readonly RegExp[] = [
  // Mobile harness state dumps: `relay=Offline daemon=Down repository=false`.
  /\brelay=(?:Offline|Reconnecting|Connecting)\b/,
  /\bdaemon=Down\b/,
  /\brelay_connected=false\b/,
  // The peer client never opened a session.
  /\bno open session: none settled yet\b/,
  /\bconnection torn down before reply\b/,
  /\bconnection ended or is unavailable\b/,
  // Readiness waits: the phone's repository never loaded from the host.
  /\bnever listed (?:its conversation list|the harness's seeded channel)\b/,
  // A fixture daemon or harness step that could not start.
  /\bstage=FixtureSetup failed\b/,
  /\bfixture retained\/start failed\b/,
  // General transport failures, any runner.
  /\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN)\b/,
  /\bconnection refused\b/i,
  /\bconnection reset by peer\b/i,
  /\bdaemon (?:is )?(?:unavailable|not ready|not running)\b/i,
];

/**
 * The relay, or another shared service, refused admission. The relay answers
 * a WebSocket upgrade over its per-IP rate limit with `429 Too Many Requests`
 * and one over its per-source connection cap with `503 Service Unavailable`,
 * both with an empty body (pyrycode-relay ratelimit_middleware.go and
 * conncap.go), and closes a phone over the per-server cap with code 4429.
 * Clients print those as a failed handshake.
 */
const ADMISSION_SIGNATURES: readonly RegExp[] = [
  /\bexpected handshake response status code 101 but got (?:429|503)\b/i,
  /\bExpected HTTP 101 response but was '(?:429|503)\b/i,
  /\b429 Too Many Requests\b/i,
  /\b503 Service Unavailable\b/i,
  /\btoo many phones for server-id\b/i,
  /\b(?:status|code)[ =:]+4429\b/i,
  // No bare `rate_limited`: pyrycode's liveness test logs "rate_limited frame
  // TOLERATED (not a failure)" on passing runs.
  /\bconnection cap (?:reached|exceeded)\b/i,
];

/**
 * The host's toolchain does not match what the repository requires. No
 * change to the code under review can fix that on this host, and no re-run
 * will either. Seen on HP for pyrycode-relay #167's verifier on 2026-10-13:
 * `make check` stopped at `go vet` with the first line below.
 */
const TOOLCHAIN_SIGNATURES: readonly RegExp[] = [
  /\bgo: go\.mod requires go >= \S+ \(running go \S+; GOTOOLCHAIN=\S+\)/,
  /\bgo: download go\S+ for \S+: toolchain not available\b/,
  /\bERR_PNPM_UNSUPPORTED_ENGINE\b/,
  /\bThe engine "node" is incompatible with this module\b/,
  /\bAndroid Gradle plugin requires Java \d+ to run\b/,
];

/** Toolchain-mismatch lines anywhere in a run's output, deduplicated, at most `limit`. */
export function findToolchainMismatch(text: string, limit = 3): { count: number; samples: string[] } {
  return findLines(text, TOOLCHAIN_SIGNATURES, limit);
}

/**
 * A test timed out waiting with no more said. Alone this proves nothing: an
 * app that hangs on a regression produces the same line. It counts towards
 * the shape only beside explicit connection evidence.
 */
const WAIT_SIGNATURES: readonly RegExp[] = [
  /\bTimeoutCancellationException: Timed out waiting for \d+ ?ms\b/,
  /\bComposeTimeoutException: Condition still not satisfied after \d+ ?ms\b/,
  /\bTimeout \d+ms exceeded\b/,
  /\bcontext deadline exceeded\b/,
  /\btimed out waiting for\b/i,
];

export type FailureShape = "connection" | "wait" | "other";

/** Classify one failing test by its failure text. */
export function classifyFailureMessage(message: string): FailureShape {
  if (ADMISSION_SIGNATURES.some(re => re.test(message))) return "connection";
  if (CONNECTION_SIGNATURES.some(re => re.test(message))) return "connection";
  if (WAIT_SIGNATURES.some(re => re.test(message))) return "wait";
  return "other";
}

const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Admission-rejection lines anywhere in the run's output, deduplicated, at most `limit`. */
export function findAdmissionRejections(text: string, limit = 5): { count: number; samples: string[] } {
  return findLines(text, ADMISSION_SIGNATURES, limit);
}

function findLines(text: string, signatures: readonly RegExp[], limit: number): { count: number; samples: string[] } {
  let count = 0;
  const samples: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(ANSI_ESCAPE, "").trim();
    if (line === "" || !signatures.some(re => re.test(line))) continue;
    count++;
    const short = line.length > 200 ? line.slice(0, 200) + "…" : line;
    if (samples.length < limit && !samples.includes(short)) samples.push(short);
  }
  return { count, samples };
}

// --------- Failure text per test ---------

/**
 * The failure text of each failing test, keyed by the same qualified name the
 * tally uses. Never throws; a test with no text found is simply absent, and
 * counts as `other` downstream, which keeps the breaker from tripping on what
 * it cannot see.
 */
export function extractFailureMessages(opts: {
  stdout: string;
  stderr: string;
  format: GateOutputFormat;
  failedNames: readonly string[];
}): Map<string, string> {
  const wanted = new Set(opts.failedNames);
  const out = new Map<string, string>();
  const add = (name: string, text: string) => {
    if (!wanted.has(name) || text.trim() === "") return;
    out.set(name, out.has(name) ? `${out.get(name)}\n${text}` : text);
  };
  try {
    if (opts.format === "junit-xml") {
      junitMessages(opts.stdout, add);
      gradleConsoleMessages(opts.stderr, add);
    } else if (opts.format === "go-json") {
      goMessages(opts.stdout, add);
    } else {
      playwrightMessages(opts.stdout, add);
    }
  } catch {
    // Partial results are still useful; a parse problem must not throw.
  }
  return out;
}

function junitMessages(raw: string, add: (name: string, text: string) => void): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true) return;
  const doc = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    isArray: name => ["testsuite", "testcase", "failure", "error"].includes(name),
  }).parse(raw);
  const walk = (suite: any) => {
    if (!suite || typeof suite !== "object") return;
    const suiteName = String(suite["@_name"] || "JUnit runner");
    for (const test of Array.isArray(suite.testcase) ? suite.testcase : []) {
      const method = test?.["@_name"];
      if (typeof method !== "string") continue;
      const name = `${test["@_classname"] || suiteName}#${method}`;
      for (const f of [...(test.failure ?? []), ...(test.error ?? [])]) {
        const text = typeof f === "string" ? f : [f?.["@_type"], f?.["@_message"], f?.["#text"]].filter(Boolean).join(": ");
        add(name, String(text ?? ""));
      }
    }
    for (const child of [...(suite.testsuite ?? []), ...(suite.testsuites ? [suite.testsuites] : [])]) walk(child);
  };
  if (doc?.testsuites) walk(doc.testsuites);
  for (const suite of doc?.testsuite ?? []) walk(suite);
}

/**
 * Android Gradle's console, which the mobile wrapper sends to stderr. Its
 * JUnit XML carries empty `<failure />` elements, so this is where the text
 * is. Two shapes, both seen on 2026-10-13:
 *
 *   pkg.Class > method[device] FAILED        (live progress, then an indented message)
 *   Execute pkg.Class.method: FAILED         (end-of-run summary, then the message)
 */
function gradleConsoleMessages(raw: string, add: (name: string, text: string) => void): void {
  const lines = raw.split("\n").map(l => l.replace(ANSI_ESCAPE, ""));
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const live = lines[i].match(/^(\S+) > (\S+?)\[[^\]]*\]\s+FAILED\s*$/);
    const summary = live ? null : lines[i].match(/^Execute (\S+)\.([^.\s:]+): FAILED\s*$/);
    const m = live ?? summary;
    if (!m) continue;
    const name = `${m[1]}#${m[2]}`;
    if (seen.has(name)) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const text = lines[j].trim();
      if (text === "" || text.startsWith("at ")) continue;
      seen.add(name);
      add(name, text);
      break;
    }
  }
}

function goMessages(raw: string, add: (name: string, text: string) => void): void {
  const tails = new Map<string, string[]>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let e: any;
    try { e = JSON.parse(trimmed); } catch { continue; }
    if (!e || typeof e.Test !== "string" || e.Test === "" || e.Action !== "output") continue;
    const key = e.Package ? `${e.Package}.${e.Test}` : e.Test;
    const tail = tails.get(key) ?? [];
    tail.push(String(e.Output ?? "").trimEnd());
    if (tail.length > 20) tail.shift();
    tails.set(key, tail);
  }
  for (const [name, tail] of tails) add(name, tail.join("\n"));
}

function playwrightMessages(raw: string, add: (name: string, text: string) => void): void {
  const start = raw.indexOf("{");
  if (start < 0) return;
  const doc = JSON.parse(raw.slice(start));
  const walk = (suite: any, trail: string[]) => {
    if (!suite || typeof suite !== "object") return;
    const next = typeof suite.title === "string" && suite.title !== "" ? [...trail, suite.title] : trail;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      const name = [...next, typeof spec?.title === "string" ? spec.title : "(unnamed)"].join(" › ");
      for (const test of Array.isArray(spec?.tests) ? spec.tests : []) {
        for (const result of Array.isArray(test?.results) ? test.results : []) {
          const errors = [result?.error, ...(Array.isArray(result?.errors) ? result.errors : [])];
          for (const err of errors) if (err?.message) add(name, String(err.message).replace(ANSI_ESCAPE, ""));
        }
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child, next);
  };
  for (const suite of Array.isArray(doc?.suites) ? doc.suites : []) walk(suite, []);
}

// --------- The decision ---------

export interface InfraFailureClassification {
  /** True when the run should halt as an infrastructure failure. */
  infra: boolean;
  /** One line for logs, the alert and the evidence comment. */
  reason: string;
  executed: number;
  failed: number;
  /** Failing tests whose text names a connection, readiness or admission failure. */
  connection: number;
  /** Failing tests whose text is a bare timeout. */
  wait: number;
  /** Everything else, including failing tests with no text found. */
  other: number;
  /** Admission-rejection lines anywhere in the output. */
  admissionLines: number;
  /** Up to five example lines, for a human to check the call. */
  samples: string[];
  /** True when the cause is a toolchain mismatch rather than a connection failure. */
  toolchain?: boolean;
  /**
   * Which rule fired. `shape` is provisional until a short base run confirms
   * it (`confirmInfraOnBase`); the other two decide on the spot.
   */
  path?: "admission" | "shape" | "toolchain";
  /** Connection-shaped failing tests, in report order, for the base check to sample. */
  connectionTests?: string[];
  /** The shape path's base check, once it ran or was skipped. */
  baseCheck?: { tests: string[]; failedOnBase: string[] | null; confirmed: boolean; note: string; outputPath: string | null };
  /** Set by the runner once the host pause is written; null when it could not be. */
  pausedUntil?: string | null;
}

/**
 * Decide whether a failed first pass is the environment's failure.
 *
 * Every path needs a mass failure first: at least `minFailed` tests, and at
 * least `minFailedShare` of those executed. A handful of red tests is the
 * branch's to explain, whatever they say. The failing tests must also be
 * connection-shaped: connection failures plus bare timeouts at least
 * `waitShare` of all failures. Bare timeouts alone never count, because an
 * app hung by a regression times out too. Then either of two:
 *
 * 1. **Admission.** At least one failing test names a connection failure,
 *    and the output holds at least `minSignatures` admission-rejection lines
 *    (429, 503, the relay's 4429 close). Decided on the spot.
 * 2. **Shape.** At least `minSignatures` failing tests name a connection,
 *    readiness or daemon-unavailable failure. **Provisional**: a branch that
 *    breaks daemon startup or the relay client fails in exactly this shape
 *    (pyrycode's `realclaude: daemon not ready`, mobile's `relay=Offline`).
 *    The runner confirms it by re-running a few of the failing tests on the
 *    base commit; only failures that reproduce there are the environment's.
 *
 * A toolchain mismatch line decides on its own, before any of that.
 */
export function classifyGateFailure(opts: {
  tally: Pick<GateTally, "executed" | "failed" | "failedNames"> | null;
  messages: ReadonlyMap<string, string>;
  admission: { count: number; samples: string[] };
  /** Toolchain-mismatch lines in the output. Optional for older callers. */
  toolchain?: { count: number; samples: string[] };
  config: InfraBreakerConfig;
}): InfraFailureClassification {
  const { tally, config } = opts;
  const base: InfraFailureClassification = {
    infra: false, reason: "", executed: tally?.executed ?? 0, failed: tally?.failed ?? 0,
    connection: 0, wait: 0, other: 0, admissionLines: opts.admission.count, samples: [],
  };
  if (!config.enabled) return { ...base, reason: "infrastructure breaker is off" };
  // A toolchain mismatch needs no mass failure: one line names the cause,
  // and whatever else failed ran on the wrong toolchain.
  if (opts.toolchain && opts.toolchain.count > 0) {
    return {
      ...base, infra: true, toolchain: true, path: "toolchain", samples: opts.toolchain.samples,
      reason: `the host's toolchain does not match what the repository requires: ${opts.toolchain.samples[0]}`,
    };
  }
  if (tally === null || tally.failed === 0) return { ...base, reason: "nothing failed" };

  const samples: string[] = [...opts.admission.samples];
  const connectionTests: string[] = [];
  for (const name of tally.failedNames) {
    const text = opts.messages.get(name);
    const shape = text === undefined ? "other" : classifyFailureMessage(text);
    base[shape]++;
    if (shape === "connection") connectionTests.push(name);
    if (shape === "connection" && samples.length < 5) {
      const first = text!.split("\n").find(l => CONNECTION_SIGNATURES.some(re => re.test(l)) || ADMISSION_SIGNATURES.some(re => re.test(l))) ?? text!;
      const line = first.trim();
      const short = line.length > 200 ? line.slice(0, 200) + "…" : line;
      if (!samples.includes(short)) samples.push(short);
    }
  }
  base.samples = samples;
  base.connectionTests = connectionTests;

  const share = tally.executed > 0 ? tally.failed / tally.executed : 0;
  const counts = `${tally.failed} of ${tally.executed} executed tests failed: ${base.connection} on connection, readiness or admission, ` +
    `${base.wait} on a bare timeout, ${base.other} otherwise`;
  if (tally.failed < config.minFailed || share < config.minFailedShare) {
    return { ...base, reason: `${counts}; not a mass failure (needs at least ${config.minFailed} failed and ${Math.round(config.minFailedShare * 100)}% of executed)` };
  }
  const waitShare = (base.connection + base.wait) / tally.failed;
  if (waitShare < config.waitShare) {
    return { ...base, reason: `${counts}; under ${Math.round(config.waitShare * 100)}% connection or timeout waits, so the failures are not connection-shaped` };
  }
  if (base.connection >= 1 && opts.admission.count >= config.minSignatures) {
    return {
      ...base, infra: true, path: "admission",
      reason: `${counts}, and the output holds ${opts.admission.count} admission rejection line(s) from a shared service, such as the relay's connection cap or rate limit`,
    };
  }
  if (base.connection >= config.minSignatures) {
    return {
      ...base, infra: true, path: "shape",
      reason: `${counts}. ${Math.round(waitShare * 100)}% of the failures are connection, readiness or timeout waits, ` +
        `which is the shape of a shared environment failure rather than of this branch`,
    };
  }
  return { ...base, reason: `${counts}; not enough connection evidence to blame the environment` };
}

// --------- Host pause ---------

export interface InfraPauseState {
  pausedAt: string;
  pausedUntil: string;
  issueNumber: number;
  reason: string;
}

export function serializeInfraPause(state: InfraPauseState): string {
  return JSON.stringify(state, null, 2) + "\n";
}

/**
 * The pause in force at `nowMs`, or null. An unreadable file is no pause, and
 * so is one ending later than `maxAheadMs` from now: no trip can have written
 * it under the current settings, so it is a stale or hand-edited file, and
 * honouring it could stop the live gate for days.
 */
export function activeInfraPause(raw: string | null, nowMs: number, maxAheadMs: number = MAX_INFRA_COOLDOWN_MS): InfraPauseState | null {
  if (raw === null) return null;
  try {
    const s = JSON.parse(raw);
    const until = Date.parse(s?.pausedUntil);
    if (!Number.isFinite(until) || until <= nowMs || until > nowMs + maxAheadMs) return null;
    return {
      pausedAt: String(s.pausedAt ?? ""),
      pausedUntil: new Date(until).toISOString(),
      issueNumber: Number.isSafeInteger(s.issueNumber) ? s.issueNumber : 0,
      reason: String(s.reason ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * The pause to write after a trip. An existing later pause is kept, so a
 * second trip never shortens the first, unless it ends beyond this trip's
 * own cooldown from now, which no trip under these settings could have
 * written. The cooldown is clamped to `MAX_INFRA_COOLDOWN_MS`.
 */
export function nextInfraPause(opts: {
  existing: string | null;
  nowMs: number;
  cooldownMs: number;
  issueNumber: number;
  reason: string;
}): InfraPauseState {
  const cooldownMs = Math.max(0, Math.min(opts.cooldownMs, MAX_INFRA_COOLDOWN_MS));
  const until = opts.nowMs + cooldownMs;
  const current = activeInfraPause(opts.existing, opts.nowMs, cooldownMs);
  if (current && Date.parse(current.pausedUntil) >= until) return current;
  return {
    pausedAt: new Date(opts.nowMs).toISOString(),
    pausedUntil: new Date(until).toISOString(),
    issueNumber: opts.issueNumber,
    reason: opts.reason,
  };
}

// --------- Confirming the shape path on the base ---------

/** Which failing tests the shape path's base check re-runs. */
/**
 * Which failing tests the shape path's base check re-runs. Tests known to
 * exist on the base come first, then unknown ones, then tests the branch
 * added: a new connection test cannot fail on a base that lacks it, so
 * sampling one would defeat the confirmation. `existsOnBase` answers true,
 * false or null (unknown); at most `maxLookups` candidates are looked up.
 */
export function pickBaseCheckTests(
  c: InfraFailureClassification,
  limit: number,
  existsOnBase?: (name: string) => boolean | null,
  maxLookups = 20,
): string[] {
  const n = Math.max(1, limit);
  const candidates = c.connectionTests ?? [];
  if (!existsOnBase) return candidates.slice(0, n);
  const known: string[] = [], unknown: string[] = [], absent: string[] = [];
  candidates.forEach((name, i) => {
    const found = i < maxLookups ? existsOnBase(name) : null;
    (found === true ? known : found === false ? absent : unknown).push(name);
  });
  return [...known, ...unknown, ...absent].slice(0, n);
}

/**
 * The identifier to search the base's source for: the method of a JUnit
 * `Class#method`, the top-level Go test function, or the last Playwright
 * title. Null when no safe plain identifier can be found.
 */
export function testSourceTerm(name: string, format: GateOutputFormat): string | null {
  let term: string | undefined;
  if (format === "junit-xml") term = name.split("#").pop()?.replace(/\[.*$/, "");
  else if (format === "go-json") term = name.match(/(?:^|[./])((?:Test|Benchmark|Example|Fuzz)\w*)(?:\/|$)/)?.[1];
  else term = name.split(" › ").pop();
  term = term?.trim();
  return term && term.length >= 3 && !/[\x00-\x1f]/.test(term) ? term : null;
}

/**
 * Judge the shape path's base check. The environment is to blame only when
 * every sampled test also fails on the base commit and none of those base
 * failures reads as an ordinary assertion. A sampled test that passes on the
 * base means the branch broke it, which is a regression, not an outage. A
 * base check that could not run confirms nothing.
 */
export function judgeBaseCheck(opts: {
  tests: readonly string[];
  failedOnBase: readonly string[] | null;
  baseMessages: ReadonlyMap<string, string>;
  skipReason: string | null;
}): { confirmed: boolean; note: string } {
  if (opts.failedOnBase === null) {
    return { confirmed: false, note: `the base check could not run (${opts.skipReason ?? "unknown reason"}), so nothing confirms an environment failure` };
  }
  const failed = new Set(opts.failedOnBase);
  const passed = opts.tests.filter(name => !failed.has(name));
  if (passed.length > 0) {
    return { confirmed: false, note: `${passed.length} of ${opts.tests.length} sampled test(s) passed on the base commit, so the branch broke them` };
  }
  const asserted = opts.tests.filter(name => {
    const text = opts.baseMessages.get(name);
    return text !== undefined && classifyFailureMessage(text) === "other";
  });
  if (asserted.length > 0) {
    return { confirmed: false, note: `${asserted.length} sampled test(s) failed on the base commit with an ordinary assertion, not a connection failure` };
  }
  return { confirmed: true, note: `all ${opts.tests.length} sampled test(s) fail on the base commit the same way` };
}

// --------- Toolchain changes on the branch ---------

/** Files whose change moves the toolchain a repository asks for. */
const TOOLCHAIN_FILES = /(?:^|\/)(?:\.go-version|\.tool-versions|\.nvmrc|\.node-version|\.java-version|rust-toolchain(?:\.toml)?|gradle-wrapper\.properties)$/;
/** In these files only some lines name a toolchain; the diff is checked for them. */
const TOOLCHAIN_LINE_FILES = /(?:^|\/)(?:package\.json|libs\.versions\.toml)$/;
const TOOLCHAIN_DIFF_LINE = /^[+-]\s*"?(?:engines|packageManager|node|pnpm|npm|agp|androidGradlePlugin|android-gradle-plugin|jvmTarget|jdk|java)"?\s*[:=]/;
/**
 * In go.mod and go.work only the `go` and `toolchain` directives move the
 * toolchain. A branch that adds a require line on a main whose `go` line is
 * already above the host did not cause the mismatch, and must not be sent
 * back for something it cannot fix.
 */
const GO_DIRECTIVE_FILES = /(?:^|\/)go\.(?:mod|work)$/;
const GO_DIRECTIVE_LINE = /^[+-]\s*(?:go|toolchain)\s+\S+\s*(?:\/\/.*)?$/;

/**
 * The branch's own files that change the toolchain the repository requires,
 * or an empty list. `diffOf` returns the branch's diff of one file. A branch
 * that bumped `go.mod` and then met an older toolchain on the host broke
 * the check itself: that is rework, not infrastructure.
 */
export function branchToolchainChanges(changedPaths: readonly string[], diffOf: (path: string) => string): string[] {
  const out: string[] = [];
  for (const path of changedPaths) {
    if (TOOLCHAIN_FILES.test(path)) { out.push(path); continue; }
    const lineRule = GO_DIRECTIVE_FILES.test(path) ? GO_DIRECTIVE_LINE : TOOLCHAIN_LINE_FILES.test(path) ? TOOLCHAIN_DIFF_LINE : null;
    if (lineRule === null) continue;
    let diff = "";
    try { diff = diffOf(path); } catch {}
    if (diff.split("\n").some(line => !line.startsWith("+++") && !line.startsWith("---") && lineRule.test(line))) out.push(path);
  }
  return out;
}
