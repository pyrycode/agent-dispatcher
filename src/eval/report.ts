// Eval report CLI: parse the run-log corpus, join it to GitHub
// outcomes, backtest review verdicts, and re-measure the developer
// no-op rate on wall clock.
//
//   pnpm eval:report -- --agents-repo <path> [--gh-repo owner/name]
//                       [--cache-dir .eval-cache] [--json out.json]
//
// Default output is a readable markdown summary on stdout; --json also
// writes the full structured data. Progress goes to stderr so stdout
// stays clean.
//
// Context for the no-op section: a prior analysis claimed ~30% of
// developer runs finish under 60 seconds as no-ops — but it read the
// USAGE Duration field, which is claude's self-reported model time, not
// wall clock. This report computes both, from the same corpus, so the
// claim is tested against its own methodology and against the corrected
// one.
//
// The pure computation and rendering functions live here (exported for
// tests); `main` at the bottom is the only IO and runs when the file is
// executed directly.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { loadRuns, type ExclusionReason, type ParsedRun } from "./log-parser.js";
import { fetchTicketOutcomes, type TicketOutcome } from "./github-outcomes.js";
import { backtestReviews, type BacktestReport, type ReviewInput } from "./review-backtest.js";

export interface CliArgs {
  agentsRepo: string;
  ghRepo: string;
  cacheDir: string;
  jsonPath: string | null;
}

const USAGE = `usage: tsx src/eval/report.ts --agents-repo <path> [--gh-repo owner/name] [--cache-dir dir] [--json out.json]`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { agentsRepo: "", ghRepo: "pyrycode/pyrycode", cacheDir: ".eval-cache", jsonPath: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
      return v;
    };
    if (flag === "--") continue;
    if (flag === "--agents-repo") args.agentsRepo = value();
    else if (flag === "--gh-repo") args.ghRepo = value();
    else if (flag === "--cache-dir") args.cacheDir = value();
    else if (flag === "--json") args.jsonPath = value();
    else throw new Error(`unknown flag: ${flag}\n${USAGE}`);
  }
  if (!args.agentsRepo) throw new Error(`--agents-repo is required\n${USAGE}`);
  return args;
}

/** Percentile over a pre-sorted ascending list; even-count medians
 *  average the two middle values, matching the usual definition. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (p === 50 && sorted.length % 2 === 0) {
    return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/** A run that finished on its own: it has a USAGE section. Salvaged
 *  runs kept their usage and count; killed/error runs do not "finish". */
function finishedRuns(runs: ParsedRun[]): ParsedRun[] {
  return runs.filter((r) => r.usage !== null);
}

export interface AgentWallStats {
  agent: string;
  finished: number;
  under60Share: number;
  under90Share: number;
  medianWallS: number;
  p90WallS: number;
  under60ShareModel: number;
  medianModelS: number;
  p90ModelS: number;
}

export function summarizeWallClock(runs: ParsedRun[]): AgentWallStats[] {
  const byAgent = new Map<string, ParsedRun[]>();
  for (const run of finishedRuns(runs)) {
    const list = byAgent.get(run.agent) ?? [];
    list.push(run);
    byAgent.set(run.agent, list);
  }
  return [...byAgent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, agentRuns]) => {
      const wall = agentRuns.map((r) => r.wallClockSeconds).sort((a, b) => a - b);
      const model = agentRuns.map((r) => r.usage!.durationSeconds).sort((a, b) => a - b);
      const share = (values: number[], limit: number) => values.filter((v) => v < limit).length / values.length;
      return {
        agent,
        finished: agentRuns.length,
        under60Share: share(wall, 60),
        under90Share: share(wall, 90),
        medianWallS: percentile(wall, 50),
        p90WallS: percentile(wall, 90),
        under60ShareModel: share(model, 60),
        medianModelS: percentile(model, 50),
        p90ModelS: percentile(model, 90),
      };
    });
}

/** Output substrings that read as "I had nothing to do" — the
 *  waiting-pattern tells the no-op re-measurement counts. */
export const WAITING_TELLS: readonly string[] = [
  "wait for the batch",
  "already committed",
  "already complete",
  "no changes needed",
  "nothing to do",
];

export function detectWaitingTells(output: string): string[] {
  const lower = output.toLowerCase();
  return WAITING_TELLS.filter((tell) => lower.includes(tell));
}

export interface NoopStats {
  agent: string;
  finished: number;
  under60Wall: number;
  under60WallShare: number;
  under90Wall: number;
  under90WallShare: number;
  under60Model: number;
  under60ModelShare: number;
  withTells: number;
  withTellsShare: number;
  under60WallOrTells: number;
  tellCounts: { tell: string; count: number }[];
}

export function computeNoopStats(runs: ParsedRun[], agent: string): NoopStats {
  const finished = finishedRuns(runs).filter((r) => r.agent === agent);
  const under60Wall = finished.filter((r) => r.wallClockSeconds < 60);
  const under90Wall = finished.filter((r) => r.wallClockSeconds < 90);
  const under60Model = finished.filter((r) => r.usage!.durationSeconds < 60);
  const tellCounts = WAITING_TELLS.map((tell) => ({
    tell,
    count: finished.filter((r) => r.output !== null && detectWaitingTells(r.output).includes(tell)).length,
  }));
  const withTells = finished.filter((r) => r.output !== null && detectWaitingTells(r.output).length > 0);
  const share = (n: number) => (finished.length === 0 ? 0 : n / finished.length);
  return {
    agent,
    finished: finished.length,
    under60Wall: under60Wall.length,
    under60WallShare: share(under60Wall.length),
    under90Wall: under90Wall.length,
    under90WallShare: share(under90Wall.length),
    under60Model: under60Model.length,
    under60ModelShare: share(under60Model.length),
    withTells: withTells.length,
    withTellsShare: share(withTells.length),
    under60WallOrTells: finished.filter(
      (r) => r.wallClockSeconds < 60 || (r.output !== null && detectWaitingTells(r.output).length > 0),
    ).length,
    tellCounts,
  };
}

export interface CorpusSummary {
  runs: number;
  byStatus: { success: number; failed: number; salvaged: number };
  excludedByReason: Record<ExclusionReason, number>;
  distinctTickets: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

export interface ReportData {
  logsDir: string;
  ghRepo: string;
  corpus: CorpusSummary;
  wallClock: AgentWallStats[];
  noop: NoopStats;
  /** The prior analysis's claim this report re-measures. */
  priorClaimUnder60Share: number;
  backtest: BacktestReport;
  fetch: { networkCalls: number; reducedScope: boolean; missingTickets: number; incompleteTimelines: number };
}

const pct = (share: number) => `${(100 * share).toFixed(1)}%`;
const secs = (s: number) => `${Math.round(s)}s`;

export function renderMarkdown(data: ReportData): string {
  const { corpus, noop, backtest } = data;
  const lines: string[] = [];
  lines.push(`# Dispatcher eval report`);
  lines.push("");
  lines.push(`Logs: \`${data.logsDir}\` · GitHub: \`${data.ghRepo}\``);
  lines.push("");

  lines.push(`## Corpus`);
  lines.push("");
  const excluded = Object.entries(corpus.excludedByReason)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  lines.push(`- ${corpus.runs} runs across ${corpus.distinctTickets} tickets (${corpus.firstRunAt ?? "?"} → ${corpus.lastRunAt ?? "?"})`);
  lines.push(`- status: ${corpus.byStatus.success} success, ${corpus.byStatus.failed} failed, ${corpus.byStatus.salvaged} salvaged`);
  lines.push(`- excluded: ${excluded || "none"}`);
  lines.push("");

  lines.push(`## Wall clock per agent (finished runs)`);
  lines.push("");
  lines.push(`| agent | n | <60s | <90s | median | p90 | model median | model <60s |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const s of data.wallClock) {
    lines.push(
      `| ${s.agent} | ${s.finished} | ${pct(s.under60Share)} | ${pct(s.under90Share)} | ${secs(s.medianWallS)} | ${secs(s.p90WallS)} | ${secs(s.medianModelS)} | ${pct(s.under60ShareModel)} |`,
    );
  }
  lines.push("");

  lines.push(`## Developer no-op rate, remeasured`);
  lines.push("");
  lines.push(`Prior claim: ~${pct(data.priorClaimUnder60Share)} of developer runs finish under 60s as no-ops (measured on the model-reported Duration field).`);
  lines.push("");
  lines.push(`- finished developer runs: ${noop.finished}`);
  lines.push(`- under 60s by wall clock: ${noop.under60Wall} (${pct(noop.under60WallShare)})`);
  lines.push(`- under 90s by wall clock: ${noop.under90Wall} (${pct(noop.under90WallShare)})`);
  lines.push(`- under 60s by the prior methodology (model-reported): ${noop.under60Model} (${pct(noop.under60ModelShare)})`);
  lines.push(`- waiting-pattern tells in OUTPUT: ${noop.withTells} (${pct(noop.withTellsShare)})`);
  for (const t of noop.tellCounts.filter((t) => t.count > 0)) {
    lines.push(`  - "${t.tell}": ${t.count}`);
  }
  lines.push(`- under 60s wall OR tells: ${noop.under60WallOrTells}`);
  lines.push("");

  lines.push(`## Review-verdict backtest`);
  lines.push("");
  lines.push(`- reviews with output: ${backtest.reviewsTotal} (${backtest.byVerdict.PASS} PASS, ${backtest.byVerdict.FAIL} FAIL, ${backtest.byVerdict.UNKNOWN} unknown verdict)`);
  lines.push(`- PASS then bounced anyway (missed-defect proxy): ${backtest.passThenBounced.length}`);
  lines.push(`- PASS and stayed clean: ${backtest.passCleanCount}`);
  lines.push(`- FAIL (caught before shipping): ${backtest.failCount}, of which ${backtest.failThenBounced} show the rework on the timeline`);
  lines.push(`- reviews without a fetched ticket outcome: ${backtest.withoutOutcome}`);
  lines.push("");
  lines.push(`| MUST FIX count | reviews | later bounced | bounce rate |`);
  lines.push(`|---|---|---|---|`);
  for (const b of backtest.mustFixBuckets) {
    const rate = b.reviews === 0 ? "-" : pct(b.bounced / b.reviews);
    lines.push(`| ${b.bucket} | ${b.reviews} | ${b.bounced} | ${rate} |`);
  }
  lines.push("");
  if (backtest.passThenBounced.length > 0) {
    lines.push(`### Passed clean, bounced later`);
    lines.push("");
    lines.push(`| ticket | review ended | bounce signal | bounced at |`);
    lines.push(`|---|---|---|---|`);
    for (const row of backtest.passThenBounced) {
      lines.push(`| #${row.ticket} | ${row.endAt} | ${row.bounce.signal} | ${row.bounce.at} |`);
    }
    lines.push("");
  }

  lines.push(`## Fetch`);
  lines.push("");
  lines.push(
    `- ${data.fetch.networkCalls} network calls this run${data.fetch.reducedScope ? " (scope reduced to the most recent 200 tickets after rate limiting)" : ""}`,
  );
  lines.push(`- tickets missing on GitHub: ${data.fetch.missingTickets}; timelines cut off by pagination caps: ${data.fetch.incompleteTimelines}`);
  lines.push("");
  return lines.join("\n");
}

export function summarizeCorpus(runs: ParsedRun[], excludedByReason: Record<ExclusionReason, number>): CorpusSummary {
  const byStatus = { success: 0, failed: 0, salvaged: 0 };
  for (const run of runs) byStatus[run.status]++;
  const stamps = runs.map((r) => r.fileTimestamp).sort();
  return {
    runs: runs.length,
    byStatus,
    excludedByReason,
    distinctTickets: new Set(runs.map((r) => r.ticket)).size,
    firstRunAt: stamps[0] ?? null,
    lastRunAt: stamps[stamps.length - 1] ?? null,
  };
}

/** Successful code-review runs joined into backtest inputs. The end
 *  timestamp is the USAGE header — the moment the verdict existed. */
export function reviewInputs(runs: ParsedRun[]): ReviewInput[] {
  return runs
    .filter((r) => r.agent === "code-review" && r.output !== null && r.usage !== null)
    .map((r) => ({
      ticket: r.ticket,
      file: r.file,
      endAt: r.sections.find((s) => s.name === "USAGE")?.timestamp ?? r.sections[r.sections.length - 1].timestamp,
      output: r.output!,
    }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logsDir = existsSync(`${args.agentsRepo}/logs`) ? `${args.agentsRepo}/logs` : args.agentsRepo;
  const log = (message: string) => process.stderr.write(`${message}\n`);

  log(`Parsing logs from ${logsDir} (read-only)`);
  const { runs, excluded } = loadRuns(logsDir, {
    readdirSync: (dir) => readdirSync(dir),
    readFileSync: (path) => readFileSync(path, "utf8"),
  });
  const excludedByReason: Record<ExclusionReason, number> = {
    filename: 0,
    "test-ticket": 0,
    "mock-prompt": 0,
    "no-dispatch": 0,
  };
  for (const e of excluded) excludedByReason[e.reason]++;
  log(`   ${runs.length} runs parsed, ${excluded.length} files excluded`);

  const tickets = [...new Set(runs.map((r) => r.ticket))].sort((a, b) => a - b);
  log(`Fetching outcomes for ${tickets.length} tickets from ${args.ghRepo} (cache: ${args.cacheDir})`);
  const execFile = promisify(execFileCb);
  const fetchResult = await fetchTicketOutcomes(
    { repo: args.ghRepo, tickets, cacheDir: args.cacheDir },
    {
      execFile: async (cmd, argv) => {
        const { stdout } = await execFile(cmd, argv, { maxBuffer: 64 * 1024 * 1024 });
        return { stdout };
      },
      readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      writeFile: (path, content) => writeFileSync(path, content),
      mkdir: (path) => mkdirSync(path, { recursive: true }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log,
    },
  );
  log(`   ${fetchResult.networkCalls} network calls`);

  const outcomes: Map<number, TicketOutcome> = fetchResult.outcomes;
  const missingTickets = [...outcomes.values()].filter((o) => o.state === "MISSING").length;
  const incompleteTimelines = [...outcomes.values()].filter((o) => o.timelineIncomplete).length;

  const data: ReportData = {
    logsDir,
    ghRepo: args.ghRepo,
    corpus: summarizeCorpus(runs, excludedByReason),
    wallClock: summarizeWallClock(runs),
    noop: computeNoopStats(runs, "developer"),
    priorClaimUnder60Share: 0.3,
    backtest: backtestReviews(reviewInputs(runs), outcomes),
    fetch: {
      networkCalls: fetchResult.networkCalls,
      reducedScope: fetchResult.reducedScope,
      missingTickets,
      incompleteTimelines,
    },
  };

  process.stdout.write(renderMarkdown(data));
  if (args.jsonPath) {
    writeFileSync(args.jsonPath, JSON.stringify({ ...data, outcomes: [...outcomes.values()] }, null, 2));
    log(`Wrote ${args.jsonPath}`);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
