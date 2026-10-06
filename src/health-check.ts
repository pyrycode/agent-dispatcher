// --------- Pre-dispatch health check (agent-dispatcher#131) ---------
//
// Before an agent spawns, run the fork's cheap checks of what that run needs:
// a GitHub login, the Figma MCP tools, the live-test Claude login and the
// test daemon's version. When one fails, the ticket is held for the cycle
// with `held:health-check` and one comment. It is not an agent error, not a
// rework, and no retry or family dispatch is counted. Later cycles re-check
// it and dispatch it once the checks pass.
//
// Why: between 2026-10-01 and 2026-10-05 these causes errored more than
// twenty runs, each after the agent had spent its budget finding out.
// Desktop builders on pyrybox lost `GH_TOKEN` through the builder's shell
// allowlist (#1727, #1735, #1746, #1748). Figma tools were unavailable on 10
// mobile runs and desktop #1696, #1745 and #1735. The live-test login was
// missing on 3 mobile runs. Desktop #1694 failed its live gate on a stale
// test daemon.
//
// Each check is a shell command chosen by the fork. Exit 0 means healthy.
// An unset command is off, so a fork with no settings behaves as before.
// The command's standard output is never posted or logged, since a login
// check may print a secret. Only the exit status and a scrubbed first line
// of standard error are, apart from the daemon check's version number.

import { spawn } from "node:child_process";
import { agentSpawnEnv, scrubCredentials } from "./agent-runtime.js";
import { builderLiveInheritedNames, codexChildEnv, resolveAgentShellEnv, type AgentRunner } from "./agent-runner.js";

export type HealthCheckName = "github" | "figma" | "live-login" | "daemon";
export type HealthScope = "shell" | "process";

export interface HealthCheck {
  name: HealthCheckName;
  /** What the check proves, for comments and logs. */
  title: string;
  /** The env setting holding the command. */
  setting: string;
  command: string;
  /** Roles whose dispatch it guards. */
  roles: ReadonlySet<string> | "all";
  /** Also guards the dispatcher's own live gate. */
  liveGate: boolean;
  /** Whose environment it runs in: the agent's tool commands, or the agent
   *  process itself, which is what connects to MCP servers. */
  scope: HealthScope;
  /** Daemon only: the lowest version the command may report. */
  minVersion?: string;
}

/**
 * The label on a held ticket. Not a block label: while its checks still fail
 * `dropStillHeld` leaves it out of selection, and once they pass it is
 * selected as usual and the label comes off.
 */
export const HEALTH_HOLD_LABEL = "held:health-check";

/** How long one check may run. A hung `gh` or `op` must not stall the cycle. */
export const HEALTH_CHECK_TIMEOUT_MS = 60_000;

/** Default cache window, `PYRY_HEALTH_CACHE_MS`. */
export const DEFAULT_HEALTH_CACHE_MS = 5 * 60_000;

const DEFINITIONS: ReadonlyArray<{
  name: HealthCheckName; title: string; prefix: string; defaultRoles: string[] | "all"; liveGate: boolean; scope: HealthScope;
}> = [
  { name: "github", title: "GitHub login", prefix: "PYRY_HEALTH_GITHUB", defaultRoles: "all", liveGate: false, scope: "shell" },
  { name: "figma", title: "Figma MCP tools", prefix: "PYRY_HEALTH_FIGMA", defaultRoles: ["builder", "verifier"], liveGate: false, scope: "process" },
  { name: "live-login", title: "Live-test Claude login", prefix: "PYRY_HEALTH_LIVE_LOGIN", defaultRoles: ["builder"], liveGate: true, scope: "shell" },
  { name: "daemon", title: "Test daemon version", prefix: "PYRY_HEALTH_DAEMON", defaultRoles: ["builder", "verifier"], liveGate: true, scope: "shell" },
];

function parseRoles(raw: string | undefined, fallback: string[] | "all"): ReadonlySet<string> | "all" {
  const names = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  if (names.length === 0) return fallback === "all" ? "all" : new Set(fallback);
  if (names.some((n) => n === "all" || n === "*")) return "all";
  return new Set(names);
}

/**
 * The fork's checks, from `PYRY_HEALTH_<CHECK>_CMD` and
 * `PYRY_HEALTH_<CHECK>_ROLES`, plus `PYRY_HEALTH_DAEMON_MIN_VERSION`. A
 * blank or unset command leaves that check off.
 */
export function parseHealthChecks(env: Readonly<Record<string, string | undefined>>): HealthCheck[] {
  const out: HealthCheck[] = [];
  for (const d of DEFINITIONS) {
    const command = env[`${d.prefix}_CMD`]?.trim();
    if (!command) continue;
    const check: HealthCheck = {
      name: d.name, title: d.title, setting: `${d.prefix}_CMD`, command,
      roles: parseRoles(env[`${d.prefix}_ROLES`], d.defaultRoles), liveGate: d.liveGate, scope: d.scope,
    };
    const min = d.name === "daemon" ? env.PYRY_HEALTH_DAEMON_MIN_VERSION?.trim() : undefined;
    if (min) check.minVersion = min;
    out.push(check);
  }
  return out;
}

/** `PYRY_HEALTH_CACHE_MS`: zero or more milliseconds, otherwise the default. */
export function parseHealthCacheMs(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_HEALTH_CACHE_MS;
  return Number(raw.trim());
}

export function checksForRole(checks: readonly HealthCheck[], role: string): HealthCheck[] {
  return checks.filter((c) => c.roles === "all" || c.roles.has(role));
}

export function checksForLiveGate(checks: readonly HealthCheck[]): HealthCheck[] {
  return checks.filter((c) => c.liveGate);
}

// --------- Running and judging one check ---------

export interface CommandOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

export type CommandRunner = (req: {
  command: string; env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number;
}) => Promise<CommandOutcome>;

/** The outcome of a check. `detail` is safe to post on the board. */
export interface HealthResult {
  ok: boolean;
  detail: string;
}

/** Numeric parts of the first version number in `text`, or null. */
export function parseVersion(text: string): number[] | null {
  const m = /\bv?(\d+(?:\.\d+)+)\b/.exec(text);
  return m ? m[1].split(".").map(Number) : null;
}

/** Negative, zero or positive as `a` is below, equal to or above `b`. Missing parts read as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [];
  const pb = parseVersion(b) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function firstStderrLine(stderr: string): string {
  const line = stderr.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return scrubCredentials(line).slice(0, 200).replace(/`/g, "'");
}

/** Decide one check from its command's outcome. Standard output is read only for a daemon version. */
export function judgeHealthCheck(check: HealthCheck, outcome: CommandOutcome): HealthResult {
  if (outcome.spawnError) return { ok: false, detail: `could not start: ${firstStderrLine(outcome.spawnError)}` };
  if (outcome.timedOut) return { ok: false, detail: `did not finish within ${HEALTH_CHECK_TIMEOUT_MS / 1000} seconds` };
  if (outcome.exitCode !== 0) {
    const why = firstStderrLine(outcome.stderr);
    return { ok: false, detail: `exited with status ${outcome.exitCode}${why ? `: \`${why}\`` : ""}` };
  }
  if (check.minVersion) {
    const found = parseVersion(outcome.stdout);
    if (!found) return { ok: false, detail: "printed no version number" };
    const version = found.join(".");
    if (compareVersions(version, check.minVersion) < 0) {
      return { ok: false, detail: `reports version ${version}, below the minimum ${check.minVersion} (\`PYRY_HEALTH_DAEMON_MIN_VERSION\`)` };
    }
    return { ok: true, detail: `version ${version}` };
  }
  return { ok: true, detail: "passed" };
}

/**
 * Default runner: `bash -c` in its own process group, killed as a group at
 * the timeout. Non-login on purpose, as for the gates: a login shell would
 * source the operator's profile and could add credentials the agent never
 * gets. Output is capped, since only a line or a version is read.
 */
export const runHealthCommand: CommandRunner = ({ command, env, cwd, timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn("bash", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e: any) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: String(e?.message ?? e) });
      return;
    }
    const cap = (acc: string, chunk: Buffer) => (acc.length < 8192 ? acc + chunk.toString("utf8") : acc);
    child.stdout?.on("data", (c: Buffer) => { stdout = cap(stdout, c); });
    child.stderr?.on("data", (c: Buffer) => { stderr = cap(stderr, c); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, timedOut: false, spawnError: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, stdout, stderr, timedOut, spawnError: null });
    });
  });

/** Runs checks and keeps each result for the cache window, per check and environment. */
export class HealthChecker {
  private readonly cache = new Map<string, { at: number; result: HealthResult }>();
  private readonly run: CommandRunner;
  private readonly cwd: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { run?: CommandRunner; cwd: string; ttlMs: number; now?: () => number }) {
    this.run = opts.run ?? runHealthCommand;
    this.cwd = opts.cwd;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  async check(check: HealthCheck, envKey: string, env: NodeJS.ProcessEnv): Promise<HealthResult> {
    const key = `${check.name}|${envKey}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.result;
    let result: HealthResult;
    try {
      result = judgeHealthCheck(check, await this.run({ command: check.command, env, cwd: this.cwd, timeoutMs: HEALTH_CHECK_TIMEOUT_MS }));
    } catch (e: any) {
      result = { ok: false, detail: `could not start: ${firstStderrLine(String(e?.message ?? e))}` };
    }
    this.cache.set(key, { at: this.now(), result });
    return result;
  }
}

// --------- The environment a check runs in ---------

function pickNames(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const exact = new Set(names.filter((n) => !n.endsWith("*")));
  const prefixes = names.filter((n) => n.endsWith("*")).map((n) => n.slice(0, -1));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (exact.has(k) || prefixes.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

/**
 * The environment a check runs in for this role, and a cache key for it.
 * The scrubbed spawn environment for the role; for Codex, without the Claude
 * settings. For a Codex builder with live tests, a `shell` check sees only
 * the names its tool commands inherit plus the fork's non-secret settings,
 * so a name dropped from that list fails the check the way it failed the
 * 2026-10-05 runs. A `process` check, such as Figma, sees what the Codex
 * process gets, since the process is what connects to MCP servers. Codex's
 * own user-level shell policy is not modelled.
 */
export function healthEnvForAgent(
  parent: NodeJS.ProcessEnv,
  role: string,
  runner: AgentRunner,
  scope: HealthScope = "shell",
): { key: string; env: NodeJS.ProcessEnv } {
  const env = agentSpawnEnv(parent, role);
  if (runner !== "codex") return { key: `${role}:claude`, env };
  const child = codexChildEnv(env);
  if (scope === "process" || !(role === "builder" && child.OP_SERVICE_ACCOUNT_TOKEN?.trim())) return { key: `${role}:codex`, env: child };
  const shellEnv = resolveAgentShellEnv(child, { warn: () => {} });
  const narrowed = { ...pickNames(child, builderLiveInheritedNames(Object.keys(shellEnv))), ...shellEnv };
  return { key: `${role}:codex-live`, env: narrowed };
}

// --------- Holding tickets and telling people once ---------

/** What has been announced, so a failing check is not repeated every cycle. */
export interface HealthNoticeState {
  /** `check|envKey` pairs announced as failing on Discord. */
  failing: Set<string>;
  /** Tickets commented on this process, in case the label write failed. */
  commented: Set<number>;
}

export function newHealthNoticeState(): HealthNoticeState {
  return { failing: new Set(), commented: new Set() };
}

interface Failure { check: HealthCheck; result: HealthResult }

/** Picks the environment, and its cache key, for one check. */
export type HealthEnvFor = (role: string, check: HealthCheck) => { key: string; env: NodeJS.ProcessEnv };

async function runChecks(
  checks: readonly HealthCheck[],
  checker: HealthChecker,
  envFor: (check: HealthCheck) => { key: string; env: NodeJS.ProcessEnv },
  who: string,
  notify: (message: string) => Promise<void>,
  state: HealthNoticeState,
  /** The caller logs failures itself, as the startup check does. */
  quiet = false,
): Promise<Failure[]> {
  const failures: Failure[] = [];
  for (const check of checks) {
    const { key: envKey, env } = envFor(check);
    const result = await checker.check(check, envKey, env);
    const key = `${check.name}|${envKey}`;
    if (!result.ok) {
      failures.push({ check, result });
      if (!state.failing.has(key)) {
        state.failing.add(key);
        if (!quiet) console.warn(`   🩺 Health check failed for ${who}: ${check.title} (${check.setting}) ${result.detail}`);
        await notifySafely(notify,
          `🩺 **${process.env.GITHUB_REPO ?? "dispatcher"}**: ${check.title} check failed for ${who}: ${result.detail}. ` +
          `Those runs are held, not errored, until it passes (\`${check.setting}\`).`);
      }
    } else if (state.failing.delete(key)) {
      console.log(`   🩺 Health check passes again for ${who}: ${check.title}`);
      await notifySafely(notify, `🩺 **${process.env.GITHUB_REPO ?? "dispatcher"}**: ${check.title} check passes again for ${who}. Held runs resume.`);
    }
  }
  return failures;
}

async function notifySafely(notify: (message: string) => Promise<void>, message: string): Promise<void> {
  try { await notify(message); } catch (e: any) { console.warn(`   ⚠️  Discord notify failed for a health check: ${e?.message ?? e}`); }
}

function holdComment(role: string, failures: readonly Failure[], recheckMs: number): string {
  const minutes = Math.max(1, Math.round(recheckMs / 60_000));
  return `## ⏸️ Dispatch held: health check failed\n\n` +
    `The dispatcher did not start the **${role}** on this ticket, because a check of what that run needs failed:\n\n` +
    failures.map((f) => `- **${f.check.title}** (\`${f.check.setting}\`): ${f.result.detail}`).join("\n") + `\n\n` +
    `This is not an agent error and not a rework. Nothing was counted against the ticket. ` +
    `The dispatcher checks again on a later cycle, at most every ${minutes} minute${minutes === 1 ? "" : "s"}, ` +
    `and starts the agent once every check passes. It then removes \`${HEALTH_HOLD_LABEL}\`. ` +
    `Fix the environment on the dispatcher host; there is nothing to change on this ticket.`;
}

/**
 * Split this cycle's candidates into those to dispatch and those to hold.
 * A held ticket gets `held:health-check` and one comment, the first time.
 * A ticket that passes again loses the label. Nothing else on the ticket
 * changes, so no error, rework or retry is recorded.
 */
export async function holdUnhealthyCandidates<C extends { agent: { name: string }; item: { issueNumber: number; labels: readonly string[] } }>(opts: {
  candidates: readonly C[];
  checks: readonly HealthCheck[];
  checker: HealthChecker;
  envFor: HealthEnvFor;
  client: {
    addLabel(issueNumber: number, label: string): Promise<void>;
    removeLabel(issueNumber: number, label: string): Promise<void>;
    addComment(issueNumber: number, body: string): Promise<void>;
  };
  notify: (message: string) => Promise<void>;
  state: HealthNoticeState;
  recheckMs?: number;
}): Promise<{ dispatch: C[]; held: C[] }> {
  if (opts.checks.length === 0) return { dispatch: [...opts.candidates], held: [] };
  const dispatch: C[] = [];
  const held: C[] = [];
  for (const c of opts.candidates) {
    const role = c.agent.name;
    const checks = checksForRole(opts.checks, role);
    const issue = c.item.issueNumber;
    const labelled = c.item.labels.includes(HEALTH_HOLD_LABEL);
    const failures = await runChecks(checks, opts.checker, (check) => opts.envFor(role, check), `${role} runs`, opts.notify, opts.state);
    if (failures.length === 0) {
      opts.state.commented.delete(issue);
      if (labelled) {
        try { await opts.client.removeLabel(issue, HEALTH_HOLD_LABEL); } catch (e: any) {
          console.warn(`   ⚠️  Could not remove ${HEALTH_HOLD_LABEL} from #${issue}: ${e?.message ?? e}`);
        }
      }
      dispatch.push(c);
      continue;
    }
    held.push(c);
    console.log(`   ⏸️  Holding ${role}#${issue}: ${failures.map((f) => f.check.title).join(", ")} failed`);
    if (labelled || opts.state.commented.has(issue)) continue;
    opts.state.commented.add(issue);
    try { await opts.client.addLabel(issue, HEALTH_HOLD_LABEL); } catch (e: any) {
      console.warn(`   ⚠️  Could not add ${HEALTH_HOLD_LABEL} to #${issue}: ${e?.message ?? e}`);
    }
    try { await opts.client.addComment(issue, holdComment(role, failures, opts.recheckMs ?? DEFAULT_HEALTH_CACHE_MS)); } catch (e: any) {
      console.warn(`   ⚠️  Could not comment the health hold on #${issue}: ${e?.message ?? e}`);
    }
  }
  return { dispatch, held };
}

/**
 * Leave out of selection the tickets already held whose checks still fail
 * (cached), so a held ticket does not take a seat from other work every
 * cycle. Only labelled tickets are looked at: a newly failing ticket is
 * selected, then held and labelled by `holdUnhealthyCandidates`. Returns
 * the same map when nothing is left out.
 */
export async function dropStillHeld<I extends { issueNumber: number; labels: readonly string[] }>(opts: {
  itemsByColumn: ReadonlyMap<string, readonly I[]>;
  pollOrder: ReadonlyArray<{ name: string; column: string }>;
  checks: readonly HealthCheck[];
  checker: HealthChecker;
  envFor: HealthEnvFor;
  notify: (message: string) => Promise<void>;
  state: HealthNoticeState;
}): Promise<{ itemsByColumn: ReadonlyMap<string, readonly I[]>; held: number }> {
  if (opts.checks.length === 0) return { itemsByColumn: opts.itemsByColumn, held: 0 };
  const out = new Map(opts.itemsByColumn);
  let held = 0;
  for (const agent of opts.pollOrder) {
    const items = opts.itemsByColumn.get(agent.column) ?? [];
    if (!items.some((i) => i.labels.includes(HEALTH_HOLD_LABEL))) continue;
    const checks = checksForRole(opts.checks, agent.name);
    if (checks.length === 0) continue;
    const failures = await runChecks(checks, opts.checker, (check) => opts.envFor(agent.name, check), `${agent.name} runs`, opts.notify, opts.state);
    if (failures.length === 0) continue;
    const kept = items.filter((i) => !i.labels.includes(HEALTH_HOLD_LABEL));
    held += items.length - kept.length;
    out.set(agent.column, kept);
  }
  return { itemsByColumn: held > 0 ? out : opts.itemsByColumn, held };
}

/**
 * The checks that guard the dispatcher's own live gate, run in the gate's
 * environment. Returns the failures; the caller skips the gate for the cycle
 * when there are any. Announced once on Discord until they pass.
 */
export async function liveGateHealthFailures(opts: {
  checks: readonly HealthCheck[];
  checker: HealthChecker;
  env: NodeJS.ProcessEnv;
  notify: (message: string) => Promise<void>;
  state: HealthNoticeState;
}): Promise<Array<{ check: HealthCheck; result: HealthResult }>> {
  const checks = checksForLiveGate(opts.checks);
  if (checks.length === 0) return [];
  return runChecks(checks, opts.checker, () => ({ key: "live-gate", env: opts.env }), "the live gate", opts.notify, opts.state);
}

/**
 * Run every configured check once at startup and say whether they passed:
 * one pass line naming the checks, or one failure line per failing check
 * naming it, its setting and the runs it holds. Before this, a pass was
 * silent and a failure showed only once a ticket was held. Each check runs
 * for every role it guards in `roles`, in that role's environment, and for
 * the live gate when `liveGateEnv` is given. The results are cached, so the
 * first cycle reuses them, and a failure is announced on Discord once, as
 * the loop would.
 */
export async function startupHealthCheck(opts: {
  checks: readonly HealthCheck[];
  checker: HealthChecker;
  roles: readonly string[];
  envFor: HealthEnvFor;
  /** The live gate's environment, or null when the fork has no live gate. */
  liveGateEnv: NodeJS.ProcessEnv | null;
  notify: (message: string) => Promise<void>;
  state: HealthNoticeState;
  log?: (line: string) => void;
}): Promise<{ passed: boolean; failures: Array<Failure & { who: string }> }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (opts.checks.length === 0) return { passed: true, failures: [] };
  const failures: Array<Failure & { who: string }> = [];
  const ran = new Set<HealthCheckName>();
  const runFor = async (checks: readonly HealthCheck[], who: string, envFor: (check: HealthCheck) => { key: string; env: NodeJS.ProcessEnv }) => {
    for (const f of await runChecks(checks, opts.checker, envFor, who, opts.notify, opts.state, true)) failures.push({ ...f, who });
    for (const c of checks) ran.add(c.name);
  };
  for (const role of opts.roles) {
    const checks = checksForRole(opts.checks, role);
    if (checks.length > 0) await runFor(checks, `${role} runs`, (check) => opts.envFor(role, check));
  }
  if (opts.liveGateEnv !== null) {
    const env = opts.liveGateEnv;
    const checks = checksForLiveGate(opts.checks);
    if (checks.length > 0) await runFor(checks, "the live gate", () => ({ key: "live-gate", env }));
  }
  if (failures.length === 0) {
    const titles = opts.checks.filter((c) => ran.has(c.name)).map((c) => c.title);
    if (titles.length > 0) log(`   🩺 Startup health check passed: ${titles.join(", ")}`);
    return { passed: true, failures };
  }
  for (const f of failures) {
    log(`   🩺 Startup health check failed: ${f.check.title} (${f.check.setting}) for ${f.who}: ${f.result.detail}. ${f.who === "the live gate" ? "The live gate is skipped" : "Those runs are held"} until it passes.`);
  }
  return { passed: false, failures };
}
