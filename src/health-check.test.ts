import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  checksForLiveGate,
  checksForRole,
  compareVersions,
  dropStillHeld,
  HEALTH_HOLD_LABEL,
  HealthChecker,
  healthEnvForAgent,
  holdUnhealthyCandidates,
  judgeHealthCheck,
  liveGateHealthFailures,
  newHealthNoticeState,
  parseHealthCacheMs,
  parseHealthChecks,
  runHealthCommand,
  type CommandOutcome,
  type CommandRunner,
} from "./health-check.js";

const ok: CommandOutcome = { exitCode: 0, stdout: "", stderr: "", timedOut: false, spawnError: null };
const fail = (stderr = "", exitCode = 1): CommandOutcome => ({ exitCode, stdout: "", stderr, timedOut: false, spawnError: null });

/** A runner that answers by command and records every call. */
function fakeRunner(answers: Record<string, CommandOutcome | ((env: NodeJS.ProcessEnv) => CommandOutcome)>) {
  const calls: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
  const run: CommandRunner = async ({ command, env }) => {
    calls.push({ command, env });
    const a = answers[command];
    if (a === undefined) throw new Error(`unexpected command ${command}`);
    return typeof a === "function" ? a(env) : a;
  };
  return { run, calls };
}

function fakeClient() {
  const labels: Array<[number, string]> = [];
  const removed: Array<[number, string]> = [];
  const comments: Array<[number, string]> = [];
  return {
    labels, removed, comments,
    async addLabel(n: number, l: string) { labels.push([n, l]); },
    async removeLabel(n: number, l: string) { removed.push([n, l]); },
    async addComment(n: number, b: string) { comments.push([n, b]); },
  };
}

const candidate = (role: string, issueNumber: number, labels: string[] = []) => ({
  agent: { name: role },
  item: { issueNumber, labels },
});

describe("pre-dispatch health check (agent-dispatcher#131)", () => {
  test("no settings means no checks, and the filter passes every candidate without running anything", async () => {
    const checks = parseHealthChecks({});
    assert.deepStrictEqual(checks, []);
    const { run, calls } = fakeRunner({});
    const client = fakeClient();
    const candidates = [candidate("builder", 1), candidate("verifier", 2)];
    const out = await holdUnhealthyCandidates({
      candidates, checks, checker: new HealthChecker({ run, cwd: "/repo", ttlMs: 60_000 }),
      envFor: (role) => ({ key: role, env: {} }), client, notify: async () => {}, state: newHealthNoticeState(),
    });
    assert.deepStrictEqual(out.dispatch, candidates);
    assert.deepStrictEqual(out.held, []);
    assert.equal(calls.length, 0);
    assert.equal(client.labels.length + client.comments.length + client.removed.length, 0);
  });

  test("each check reads its command and role list, with defaults per check", () => {
    const checks = parseHealthChecks({
      PYRY_HEALTH_GITHUB_CMD: "gh auth status",
      PYRY_HEALTH_FIGMA_CMD: "figma-check",
      PYRY_HEALTH_LIVE_LOGIN_CMD: "login-check",
      PYRY_HEALTH_DAEMON_CMD: "pyry --version",
      PYRY_HEALTH_DAEMON_MIN_VERSION: "0.33.0",
      PYRY_HEALTH_DAEMON_ROLES: "builder, verifier ,documentation",
    });
    assert.deepStrictEqual(checks.map((c) => c.name), ["github", "figma", "live-login", "daemon"]);
    assert.deepStrictEqual(checksForRole(checks, "refiner").map((c) => c.name), ["github"]);
    assert.deepStrictEqual(checksForRole(checks, "builder").map((c) => c.name), ["github", "figma", "live-login", "daemon"]);
    assert.deepStrictEqual(checksForRole(checks, "verifier").map((c) => c.name), ["github", "figma", "daemon"]);
    assert.deepStrictEqual(checksForRole(checks, "documentation").map((c) => c.name), ["github", "daemon"]);
    assert.deepStrictEqual(checksForLiveGate(checks).map((c) => c.name), ["live-login", "daemon"]);
    assert.equal(checks[3].minVersion, "0.33.0");
  });

  test("a blank command is off, and a role list of all or * covers every role", () => {
    const checks = parseHealthChecks({ PYRY_HEALTH_GITHUB_CMD: "  ", PYRY_HEALTH_FIGMA_CMD: "f", PYRY_HEALTH_FIGMA_ROLES: "all" });
    assert.deepStrictEqual(checks.map((c) => c.name), ["figma"]);
    assert.equal(checksForRole(checks, "refiner").length, 1);
    assert.equal(checksForRole(parseHealthChecks({ PYRY_HEALTH_FIGMA_CMD: "f", PYRY_HEALTH_FIGMA_ROLES: "*" }), "po").length, 1);
  });

  test("the cache window defaults to 5 minutes and rejects garbage", () => {
    assert.equal(parseHealthCacheMs(undefined), 300_000);
    assert.equal(parseHealthCacheMs("60000"), 60_000);
    assert.equal(parseHealthCacheMs("0"), 0);
    assert.equal(parseHealthCacheMs("soon"), 300_000);
    assert.equal(parseHealthCacheMs("-5"), 300_000);
  });

  test("a failing check holds only the roles it covers, labels the ticket and comments once, and counts nothing", async () => {
    const checks = parseHealthChecks({ PYRY_HEALTH_FIGMA_CMD: "figma-check" });
    const { run } = fakeRunner({ "figma-check": fail("figma: not connected") });
    const client = fakeClient();
    const notices: string[] = [];
    const out = await holdUnhealthyCandidates({
      candidates: [candidate("builder", 1727), candidate("documentation", 1730)],
      checks, checker: new HealthChecker({ run, cwd: "/repo", ttlMs: 60_000 }),
      envFor: (role) => ({ key: role, env: {} }), client, notify: async (m) => { notices.push(m); }, state: newHealthNoticeState(),
    });
    assert.deepStrictEqual(out.dispatch.map((c) => c.item.issueNumber), [1730]);
    assert.deepStrictEqual(out.held.map((c) => c.item.issueNumber), [1727]);
    assert.deepStrictEqual(client.labels, [[1727, HEALTH_HOLD_LABEL]]);
    assert.equal(client.comments.length, 1);
    const [issue, body] = client.comments[0];
    assert.equal(issue, 1727);
    assert.match(body, /Figma MCP tools/);
    assert.match(body, /PYRY_HEALTH_FIGMA_CMD/);
    assert.match(body, /figma: not connected/);
    assert.match(body, /not an agent error/);
    for (const [, l] of client.labels) assert.ok(!/^(error|rework-count|rework-other|error-retry-count|needs-rework)/.test(l), l);
    assert.equal(notices.length, 1, "one Discord message when the check starts failing");
  });

  test("a second failing cycle posts nothing new; a passing check removes the label and lets the ticket through", async () => {
    const checks = parseHealthChecks({ PYRY_HEALTH_GITHUB_CMD: "gh auth status" });
    let healthy = false;
    const { run } = fakeRunner({ "gh auth status": () => healthy ? ok : fail("You are not logged into any GitHub hosts.") });
    let t = 0;
    const checker = new HealthChecker({ run, cwd: "/repo", ttlMs: 1000, now: () => t });
    const client = fakeClient();
    const notices: string[] = [];
    const state = newHealthNoticeState();
    const cycle = (labels: string[]) => holdUnhealthyCandidates({
      candidates: [candidate("builder", 1748, labels)], checks, checker,
      envFor: (role) => ({ key: role, env: {} }), client, notify: async (m) => { notices.push(m); }, state,
    });

    let out = await cycle([]);
    assert.equal(out.held.length, 1);
    t = 5000;
    out = await cycle([HEALTH_HOLD_LABEL]);
    assert.equal(out.held.length, 1);
    assert.equal(client.comments.length, 1, "no second comment while the label is on");
    assert.equal(client.labels.length, 1, "no second label write");
    assert.equal(notices.length, 1, "no second Discord message");

    healthy = true;
    t = 10_000;
    out = await cycle([HEALTH_HOLD_LABEL]);
    assert.deepStrictEqual(out.dispatch.map((c) => c.item.issueNumber), [1748]);
    assert.deepStrictEqual(client.removed, [[1748, HEALTH_HOLD_LABEL]]);
    assert.equal(client.comments.length, 1);
    assert.equal(notices.length, 2, "one Discord message on recovery");
  });

  test("a label write that fails does not turn into a comment every cycle", async () => {
    const checks = parseHealthChecks({ PYRY_HEALTH_GITHUB_CMD: "gh auth status" });
    const { run } = fakeRunner({ "gh auth status": fail() });
    const client = { ...fakeClient(), async addLabel() { throw new Error("502"); } };
    const comments: number[] = [];
    client.addComment = async (n: number) => { comments.push(n); };
    const state = newHealthNoticeState();
    const checker = new HealthChecker({ run, cwd: "/repo", ttlMs: 0 });
    for (let i = 0; i < 3; i++) {
      await holdUnhealthyCandidates({
        candidates: [candidate("builder", 7)], checks, checker,
        envFor: (role) => ({ key: role, env: {} }), client, notify: async () => {}, state,
      });
    }
    assert.deepStrictEqual(comments, [7]);
  });

  test("results are cached per check and environment for the window, then run again", async () => {
    const checks = parseHealthChecks({ PYRY_HEALTH_GITHUB_CMD: "gh auth status" });
    const { run, calls } = fakeRunner({ "gh auth status": ok });
    let t = 0;
    const checker = new HealthChecker({ run, cwd: "/repo", ttlMs: 300_000, now: () => t });
    const [github] = checks;
    await checker.check(github, "builder", {});
    await checker.check(github, "builder", {});
    await checker.check(github, "verifier", {});
    assert.equal(calls.length, 2, "one run per environment inside the window");
    t = 299_999;
    await checker.check(github, "builder", {});
    assert.equal(calls.length, 2);
    t = 300_000;
    await checker.check(github, "builder", {});
    assert.equal(calls.length, 3, "re-run once the window has passed");
  });

  test("the daemon check compares the first version number with the minimum", () => {
    const [daemon] = parseHealthChecks({ PYRY_HEALTH_DAEMON_CMD: "pyry --version", PYRY_HEALTH_DAEMON_MIN_VERSION: "0.33.0" });
    const out = (stdout: string): CommandOutcome => ({ ...ok, stdout });
    assert.equal(judgeHealthCheck(daemon, out("pyry 0.33.0\n")).ok, true);
    assert.equal(judgeHealthCheck(daemon, out("pyry v0.34.1")).ok, true);
    const stale = judgeHealthCheck(daemon, out("pyry 0.32.9"));
    assert.equal(stale.ok, false);
    assert.match(stale.detail, /0\.32\.9.*0\.33\.0/);
    assert.equal(judgeHealthCheck(daemon, out("command not found")).ok, false);
    assert.equal(judgeHealthCheck(daemon, fail("no such file", 127)).ok, false);
    const noMin = parseHealthChecks({ PYRY_HEALTH_DAEMON_CMD: "pyry --version" })[0];
    assert.equal(judgeHealthCheck(noMin, out("anything")).ok, true, "without a minimum, exit 0 is enough");
    assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
  });

  test("a check's standard output never reaches the detail, and standard error is scrubbed and cut to one line", () => {
    const [login] = parseHealthChecks({ PYRY_HEALTH_LIVE_LOGIN_CMD: "op read x" });
    const r = judgeHealthCheck(login, {
      exitCode: 1, stdout: "sk-ant-oat01-SECRETSECRETSECRET", stderr: "[ERROR] item not found\nsecond line", timedOut: false, spawnError: null,
    });
    assert.equal(r.ok, false);
    assert.ok(!r.detail.includes("SECRET"));
    assert.match(r.detail, /item not found/);
    assert.ok(!r.detail.includes("second line"));
    assert.match(judgeHealthCheck(login, { ...ok, exitCode: null, timedOut: true }).detail, /did not finish/);
    assert.match(judgeHealthCheck(login, { ...ok, exitCode: null, spawnError: "ENOENT" }).detail, /could not start/);
  });

  test("a Codex builder with live tests is checked with only the names its tool commands inherit", async () => {
    const parent = {
      PATH: "/bin", HOME: "/home/a", GH_TOKEN: "gho_x", GITHUB_TOKEN: "dispatcher", PYRY_DEV_AGENTS_TOKEN: "restricted",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth", RANDOM_SETTING: "1", LC_ALL: "C",
    };
    const live = healthEnvForAgent(parent, "builder", "codex");
    assert.equal(live.env.GH_TOKEN, "gho_x");
    assert.equal(live.env.OP_SERVICE_ACCOUNT_TOKEN, "restricted");
    assert.equal(live.env.LC_ALL, "C");
    assert.equal(live.env.RANDOM_SETTING, undefined);
    assert.equal(live.env.GITHUB_TOKEN, undefined);
    assert.equal(live.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);

    const figma = healthEnvForAgent(parent, "builder", "codex", "process");
    assert.equal(figma.env.RANDOM_SETTING, "1", "the Codex process itself, which connects to Figma, keeps the full environment");
    assert.notEqual(figma.key, live.key);

    const verifier = healthEnvForAgent(parent, "verifier", "codex");
    assert.notEqual(verifier.key, live.key);
    assert.equal(verifier.env.RANDOM_SETTING, "1");
    assert.equal(verifier.env.OP_SERVICE_ACCOUNT_TOKEN, undefined);
    const claude = healthEnvForAgent(parent, "builder", "claude");
    assert.equal(claude.env.CLAUDE_CODE_OAUTH_TOKEN, "oauth");
    assert.equal(claude.env.GITHUB_TOKEN, undefined);

    // The 2026-10-05 pyrybox shape: GH_TOKEN missing from what the builder
    // inherits. The check sees what the agent would see, so it fails.
    const checks = parseHealthChecks({ PYRY_HEALTH_GITHUB_CMD: "gh auth status" });
    const { run } = fakeRunner({ "gh auth status": (env) => env.GH_TOKEN ? ok : fail("You are not logged into any GitHub hosts.") });
    const client = fakeClient();
    const noToken = { ...parent, GH_TOKEN: undefined };
    const out = await holdUnhealthyCandidates({
      candidates: [candidate("builder", 1746)], checks, checker: new HealthChecker({ run, cwd: "/repo", ttlMs: 0 }),
      envFor: (role) => healthEnvForAgent(noToken, role, "codex"), client, notify: async () => {}, state: newHealthNoticeState(),
    });
    assert.equal(out.held.length, 1);
  });

  test("a failing live-login or daemon check stops the live gate, with one Discord message until it recovers", async () => {
    const checks = parseHealthChecks({ PYRY_HEALTH_LIVE_LOGIN_CMD: "login-check", PYRY_HEALTH_GITHUB_CMD: "gh auth status" });
    let healthy = false;
    const { run, calls } = fakeRunner({ "login-check": () => healthy ? ok : fail("login unavailable") });
    const checker = new HealthChecker({ run, cwd: "/repo", ttlMs: 0 });
    const notices: string[] = [];
    const state = newHealthNoticeState();
    const gate = () => liveGateHealthFailures({ checks, checker, env: {}, notify: async (m) => { notices.push(m); }, state });
    assert.equal((await gate()).length, 1);
    assert.equal((await gate()).length, 1);
    assert.equal(notices.length, 1);
    assert.ok(calls.every((c) => c.command === "login-check"), "the GitHub check does not guard the live gate");
    healthy = true;
    assert.equal((await gate()).length, 0);
    assert.equal(notices.length, 2);
    assert.deepStrictEqual(await liveGateHealthFailures({ checks: [], checker, env: {}, notify: async () => {}, state }), []);
  });

  test("the default runner reports exit status and output, and stops a command at its timeout", async () => {
    const done = await runHealthCommand({ command: "echo out; echo err >&2; exit 3", env: process.env, cwd: process.cwd(), timeoutMs: 5000 });
    assert.deepStrictEqual({ code: done.exitCode, out: done.stdout.trim(), err: done.stderr.trim(), timedOut: done.timedOut }, { code: 3, out: "out", err: "err", timedOut: false });
    const started = Date.now();
    const hung = await runHealthCommand({ command: "sleep 30", env: process.env, cwd: process.cwd(), timeoutMs: 200 });
    assert.equal(hung.timedOut, true);
    assert.equal(hung.exitCode, null);
    assert.ok(Date.now() - started < 5000);
  });

  test("a ticket already held whose check still fails is left out of selection, so its seat goes to other work", async () => {
    const checks = parseHealthChecks({ PYRY_HEALTH_FIGMA_CMD: "figma-check" });
    let healthy = false;
    const { run } = fakeRunner({ "figma-check": () => healthy ? ok : fail() });
    const checker = new HealthChecker({ run, cwd: "/repo", ttlMs: 0 });
    const item = (issueNumber: number, labels: string[] = []) => ({ issueNumber, labels });
    const itemsByColumn = new Map([
      ["In Development", [item(1, [HEALTH_HOLD_LABEL]), item(2)]],
      ["In Documentation", [item(3, [HEALTH_HOLD_LABEL])]],
    ]);
    const pollOrder = [{ name: "documentation", column: "In Documentation" }, { name: "builder", column: "In Development" }];
    const args = { pollOrder, checks, checker, envFor: (role: string) => ({ key: role, env: {} }), notify: async () => {}, state: newHealthNoticeState() };
    let out = await dropStillHeld({ itemsByColumn, ...args });
    assert.deepStrictEqual(out.itemsByColumn.get("In Development")!.map((i) => i.issueNumber), [2],
      "the unlabelled ticket is left for selection, which holds and labels it");
    assert.deepStrictEqual(out.itemsByColumn.get("In Documentation")!.map((i) => i.issueNumber), [3],
      "the label alone does not hold a role the check does not cover");
    assert.equal(out.held, 1);
    healthy = true;
    out = await dropStillHeld({ itemsByColumn, ...args });
    assert.deepStrictEqual(out.itemsByColumn.get("In Development")!.map((i) => i.issueNumber), [1, 2]);
    assert.equal(out.held, 0);
    const none = await dropStillHeld({ itemsByColumn, ...args, checks: [] });
    assert.equal(none.itemsByColumn, itemsByColumn);
  });
});
