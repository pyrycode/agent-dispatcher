// Run-log parser for the offline eval harness.
//
// Input: the dispatcher's per-run log files, named
// `<ISO8601-with-dashes>Z_<agent>_#<ticket>.log`. Each file is a series of
// plain-text sections delimited by 60-`=` lines with a `NAME — <ISO>` header
// line between them: DISPATCH, PROMPT, SYSTEM PROMPT, then raw stream lines
// prefixed `[HH:MM:SS]`, then on success `OUTPUT (success)` and `USAGE`.
// Failed or killed runs simply lack OUTPUT/USAGE — absence IS the failure
// signal; there is no status field. Salvage paths add SALVAGED /
// SAFER_SALVAGE / SAFER_SALVAGE_SKIPPED / ERROR sections.
//
// Everything here is pure except `loadRuns`, which walks a directory
// through injected fs deps. The logs directory is treated as strictly
// read-only: this module never writes anywhere.

export interface RunUsage {
  turns: number;
  /** Model-reported duration from the USAGE line — claude's own clock,
   *  not wall clock. Kept separate from `wallClockSeconds` on purpose:
   *  comparing the two is one of the eval's jobs. */
  durationSeconds: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
  sessionId: string;
}

export interface SectionStamp {
  name: string;
  /** ISO timestamp from the section header line. */
  timestamp: string;
}

export type RunStatus = "success" | "failed" | "salvaged";

export interface DispatchInfo {
  ticketTitle: string;
  branch: string;
  worktree: string;
  maxTurns: number;
  timeoutMinutes: number;
}

export interface ParsedRun {
  /** Log file basename. */
  file: string;
  agent: string;
  ticket: number;
  /** Timestamp encoded in the filename (log file creation). */
  fileTimestamp: string;
  sections: SectionStamp[];
  dispatch: DispatchInfo;
  status: RunStatus;
  /** Body of the OUTPUT (success) section, when present. */
  output: string | null;
  /** Body of the ERROR section, when present. */
  errorText: string | null;
  usage: RunUsage | null;
  /** Wall-clock duration: first section header timestamp to the last
   *  timestamped evidence in the file. See `wallClockEndSource`. */
  wallClockSeconds: number;
  /** Where the wall-clock end marker came from: the USAGE header, the
   *  ERROR header, the last `[HH:MM:SS]` stream line (killed runs), or
   *  the last section header when no stream line exists. */
  wallClockEndSource: "usage" | "error" | "stream" | "section";
}

export type ExclusionReason = "filename" | "test-ticket" | "mock-prompt" | "no-dispatch";

export interface ExcludedLog {
  file: string;
  reason: ExclusionReason;
}

export type ParseResult = { kind: "run"; run: ParsedRun } | { kind: "excluded"; file: string; reason: ExclusionReason };

const DELIMITER = "=".repeat(60);

/** `NAME — <ISO>` between two delimiter lines. Name is anything without
 *  a leading lowercase letter in practice, but the sandwich of delimiter
 *  lines is what actually authenticates a header — the pattern alone is
 *  too easy to fake from inside a PROMPT body. */
const SECTION_HEADER = /^(.+?) — (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)$/;

const FILE_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)_#(\d+)\.log$/;

const STREAM_LINE = /^\[(\d{2}):(\d{2}):(\d{2})\] /;

const USAGE_LINE =
  /^Turns: (\d+) \| Duration: (\d+)s \| Input tokens: (\d+) \| Output tokens: (\d+) \| Cache read: (\d+) \| Cache creation: (\d+) \| Cost: \$([\d.]+) \| Session: (\S+)$/;

/** Filename-level triage. `real-claude-gate` runs are a different schema
 *  entirely (raw go test output), `.stderr.log` files are the spawn's
 *  stderr channel, and anything that is not a `.log` is not a run. */
export function classifyLogFileName(name: string): "run" | "excluded" {
  if (!name.endsWith(".log")) return "excluded";
  if (name.endsWith(".stderr.log")) return "excluded";
  if (name.includes("real-claude-gate")) return "excluded";
  if (parseFileName(name) === null) return "excluded";
  return "run";
}

export function parseFileName(name: string): { timestamp: string; agent: string; ticket: number } | null {
  const m = name.match(FILE_NAME);
  if (!m) return null;
  return {
    timestamp: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`,
    agent: m[6],
    ticket: Number(m[7]),
  };
}

export function parseUsageLine(line: string): RunUsage | null {
  const m = line.match(USAGE_LINE);
  if (!m) return null;
  return {
    turns: Number(m[1]),
    durationSeconds: Number(m[2]),
    inputTokens: Number(m[3]),
    outputTokens: Number(m[4]),
    cacheRead: Number(m[5]),
    cacheCreation: Number(m[6]),
    costUsd: Number(m[7]),
    sessionId: m[8],
  };
}

interface RawSection {
  name: string;
  timestamp: string;
  body: string;
}

/** Split a log into delimited sections. A section starts at a
 *  delimiter/header/delimiter triple; its body runs to the next triple. */
function splitSections(content: string): RawSection[] {
  const lines = content.split("\n");
  const sections: RawSection[] = [];
  let current: { name: string; timestamp: string; bodyStart: number } | null = null;

  const close = (endExclusive: number) => {
    if (!current) return;
    sections.push({
      name: current.name,
      timestamp: current.timestamp,
      body: lines.slice(current.bodyStart, endExclusive).join("\n"),
    });
    current = null;
  };

  for (let i = 0; i + 2 < lines.length + 1; i++) {
    if (lines[i] !== DELIMITER) continue;
    const header = lines[i + 1]?.match(SECTION_HEADER);
    if (!header || lines[i + 2] !== DELIMITER) continue;
    close(i);
    current = { name: header[1], timestamp: header[2], bodyStart: i + 3 };
    i += 2;
  }
  close(lines.length);
  return sections;
}

function seconds(h: number, m: number, s: number): number {
  return h * 3600 + m * 60 + s;
}

const DAY = 24 * 3600;

function mod24(sec: number): number {
  return ((sec % DAY) + DAY) % DAY;
}

/** Resolve the last `[HH:MM:SS]` stream line to an absolute time.
 *
 *  Stream lines carry local clock times with no date, while section
 *  headers are UTC — so the UTC offset must be derived, and midnight
 *  rollover handled. The derivation: the first stream line lands seconds
 *  after its section's header was written, so
 *  `first stream clock − header clock ≈ utc offset + spawn delay`;
 *  rounding to the nearest 15 minutes (all real offsets are multiples)
 *  absorbs the delay. The end is then `header + elapsed`, where elapsed
 *  is mod-24h from the header clock to the last stream clock in local
 *  time. Mod-24 arithmetic handles midnight without trusting any
 *  intermediate line, and is exact because no run lives 24 hours. */
function resolveStreamEnd(anchorIso: string, streamClocks: number[]): number | null {
  if (streamClocks.length === 0) return null;
  const anchorMs = Date.parse(anchorIso);
  const anchorClock = mod24(Math.floor(anchorMs / 1000) % DAY);
  const offsetRaw = mod24(streamClocks[0] - anchorClock);
  const offset = Math.round(offsetRaw / 900) * 900;
  const elapsed = mod24(streamClocks[streamClocks.length - 1] - offset - anchorClock);
  return anchorMs + elapsed * 1000;
}

export function parseRunLog(fileName: string, content: string): ParseResult {
  const fromName = parseFileName(fileName);
  if (fromName === null || classifyLogFileName(fileName) === "excluded") {
    return { kind: "excluded", file: fileName, reason: "filename" };
  }

  const sections = splitSections(content);
  const dispatch = sections.find((s) => s.name === "DISPATCH");
  if (!dispatch) return { kind: "excluded", file: fileName, reason: "no-dispatch" };

  const field = (name: string): string => {
    const m = dispatch.body.match(new RegExp(`^${name}: (.*)$`, "m"));
    return m ? m[1] : "";
  };

  const ticketLine = field("Ticket");
  if (ticketLine.includes("Test ticket")) {
    return { kind: "excluded", file: fileName, reason: "test-ticket" };
  }
  const ticketMatch = ticketLine.match(/^#(\d+)(?: — (.*))?$/);

  // A second pollution signature: the dispatcher's test suite also
  // writes mock logs whose titles look plausible ("Test feature",
  // "Override") but whose PROMPT body is literally "## Mock prompt #N".
  const prompt = sections.find((s) => s.name === "PROMPT");
  if (prompt && /^## Mock prompt\b/m.test(prompt.body)) {
    return { kind: "excluded", file: fileName, reason: "mock-prompt" };
  }

  const output = sections.find((s) => s.name === "OUTPUT (success)") ?? null;
  const error = sections.find((s) => s.name === "ERROR") ?? null;
  const usageSection = sections.find((s) => s.name === "USAGE") ?? null;
  const salvaged = sections.some((s) => s.name === "SALVAGED" || s.name === "SAFER_SALVAGE");

  let usage: RunUsage | null = null;
  if (usageSection) {
    for (const line of usageSection.body.split("\n")) {
      usage = parseUsageLine(line.trim());
      if (usage) break;
    }
  }

  const status: RunStatus = salvaged ? "salvaged" : usage !== null ? "success" : "failed";

  // Wall clock. Start: first section header. End: the USAGE/ERROR header
  // when the run reached one; otherwise the last stream line (killed
  // runs); otherwise the last section header. Stream lines are read only
  // from the SYSTEM PROMPT section's body — the PROMPT body quotes issue
  // text that can contain `[HH:MM:SS]`-shaped lines, and trusting those
  // would corrupt the estimate.
  const startMs = Date.parse(sections[0].timestamp);
  const terminal = usageSection ?? error;
  let endMs: number;
  let endSource: ParsedRun["wallClockEndSource"];
  if (terminal) {
    endMs = Date.parse(terminal.timestamp);
    endSource = terminal === usageSection ? "usage" : "error";
  } else {
    const systemPrompt = sections.find((s) => s.name === "SYSTEM PROMPT");
    const streamClocks: number[] = [];
    if (systemPrompt) {
      for (const line of systemPrompt.body.split("\n")) {
        const m = line.match(STREAM_LINE);
        if (m) streamClocks.push(seconds(Number(m[1]), Number(m[2]), Number(m[3])));
      }
    }
    const streamEnd = systemPrompt ? resolveStreamEnd(systemPrompt.timestamp, streamClocks) : null;
    if (streamEnd !== null) {
      endMs = streamEnd;
      endSource = "stream";
    } else {
      endMs = Date.parse(sections[sections.length - 1].timestamp);
      endSource = "section";
    }
  }

  const run: ParsedRun = {
    file: fileName,
    agent: field("Agent") || fromName.agent,
    ticket: ticketMatch ? Number(ticketMatch[1]) : fromName.ticket,
    fileTimestamp: fromName.timestamp,
    sections: sections.map(({ name, timestamp }) => ({ name, timestamp })),
    dispatch: {
      ticketTitle: ticketMatch?.[2] ?? "",
      branch: field("Branch"),
      worktree: field("Worktree"),
      maxTurns: Number(field("Max turns")) || 0,
      timeoutMinutes: Number(field("Timeout").replace(/min$/, "")) || 0,
    },
    status,
    output: output ? output.body : null,
    errorText: error ? error.body : null,
    usage,
    wallClockSeconds: (endMs - startMs) / 1000,
    wallClockEndSource: endSource,
  };
  return { kind: "run", run };
}

export interface LoadDeps {
  readdirSync: (dir: string) => string[];
  readFileSync: (path: string) => string;
}

export interface LoadedCorpus {
  runs: ParsedRun[];
  excluded: ExcludedLog[];
}

/** Walk a logs directory (read-only) and parse every run log in it.
 *  Deps are injected so tests never touch a real filesystem. */
export function loadRuns(dir: string, deps: LoadDeps): LoadedCorpus {
  const runs: ParsedRun[] = [];
  const excluded: ExcludedLog[] = [];
  for (const name of [...deps.readdirSync(dir)].sort()) {
    if (classifyLogFileName(name) === "excluded") {
      excluded.push({ file: name, reason: "filename" });
      continue;
    }
    const result = parseRunLog(name, deps.readFileSync(`${dir}/${name}`));
    if (result.kind === "run") runs.push(result.run);
    else excluded.push({ file: result.file, reason: result.reason });
  }
  return { runs, excluded };
}
