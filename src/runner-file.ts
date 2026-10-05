import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAgentRunner, type AgentRunner } from "./agent-runner.js";

/**
 * The runner file: an optional JSON file, read before every agent spawn, that
 * chooses Claude or Codex without a restart. A restart drains first, and a
 * drain can wait most of an hour for running agents; Claude and Codex
 * allowances also run out at different times. So the choice is live.
 *
 *   {"runner": "codex", "roles": {"verifier": "claude"}, "rework": {"builder": "claude"}}
 *
 * Every key is optional. A role entry beats `runner`, and `runner` beats
 * PYRY_AGENT_RUNNER, which stays the fallback when the file is absent.
 *
 * A `rework` entry beats them all, but only for the builder's rework after
 * a verifier FAIL: the run that gets the FAIL's findings to answer (see
 * `prepareReworkFindingsNote` in dispatch.ts). A first attempt, or a rework
 * for any other reason, ignores it. On mobile #1786 on 2026-10-05 the Codex
 * builder could not fix three real bugs the verifier found, which a Claude
 * pass then fixed at once.
 *
 * Default path: <agents repo>/runner.json. PYRY_RUNNER_FILE overrides it; an
 * empty value turns the file off.
 *
 * A resumed run keeps the runner its session started on, because the choice
 * is made once per spawn and carried in the spawn's config.
 */
export type RunnerFile = { runner?: AgentRunner; roles?: Record<string, AgentRunner>; rework?: Record<string, AgentRunner> };

/** What the dispatcher knows about this spawn beyond the role. */
export type SpawnKind = { reworkAfterFail?: boolean };

const isRunner = (value: unknown): value is AgentRunner => value === "claude" || value === "codex";

function parseRoleMap(key: "roles" | "rework", value: unknown): Record<string, AgentRunner> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`runner file: "${key}" must be an object of role name to runner`);
  const roles: Record<string, AgentRunner> = {};
  for (const [role, runner] of Object.entries(value)) {
    if (!isRunner(runner)) throw new Error(`runner file: ${key === "roles" ? "role" : "rework role"} "${role}" must be "claude" or "codex", got ${JSON.stringify(runner)}`);
    roles[role] = runner;
  }
  return roles;
}

/** Strict, so a misspelt key cannot silently leave the previous runner in place. */
export function parseRunnerFile(text: string): RunnerFile {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("runner file is not valid JSON"); }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("runner file must be a JSON object");
  const file: RunnerFile = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "runner") {
      if (!isRunner(value)) throw new Error(`runner file: "runner" must be "claude" or "codex", got ${JSON.stringify(value)}`);
      file.runner = value;
    } else if (key === "roles" || key === "rework") {
      file[key] = parseRoleMap(key, value);
    } else {
      throw new Error(`runner file: unknown key "${key}"; expected "runner", "roles" and "rework"`);
    }
  }
  return file;
}

export function runnerFilePath(env: NodeJS.ProcessEnv, agentsRepoRoot: string): string | null {
  const configured = env.PYRY_RUNNER_FILE;
  if (configured === "") return null;
  return resolve(agentsRepoRoot, configured ?? "runner.json");
}

/** Every runner the file and the fallback could pick, so startup can check each is installed. */
export function runnersInUse(file: RunnerFile | null, fallback: AgentRunner): Set<AgentRunner> {
  const all = new Set<AgentRunner>([file?.runner ?? fallback]);
  for (const runner of Object.values(file?.roles ?? {})) all.add(runner);
  for (const runner of Object.values(file?.rework ?? {})) all.add(runner);
  return all;
}

type ReadOutcome = { kind: "absent" } | { kind: "ok"; file: RunnerFile } | { kind: "invalid"; error: string };

function readRunnerFile(path: string | null, read: (path: string) => string): ReadOutcome {
  if (!path) return { kind: "absent" };
  let text: string;
  try { text = read(path); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", error: `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  try { return { kind: "ok", file: parseRunnerFile(text) }; } catch (e) {
    return { kind: "invalid", error: `${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** For startup: a broken file fails fast, before the board is touched. */
export function loadRunnerFileStrict(path: string | null, read = (p: string) => readFileSync(p, "utf8")): RunnerFile | null {
  const outcome = readRunnerFile(path, read);
  if (outcome.kind === "invalid") throw new Error(outcome.error);
  return outcome.kind === "ok" ? outcome.file : null;
}

/**
 * The per-spawn choice. A file that turns broken while the dispatcher runs
 * must not stop the board, so the last valid file stays in force and the
 * problem is logged once per distinct error. A deleted file is deliberate:
 * the env fallback applies again.
 */
export function createRunnerSelector(opts: {
  /** A function is called per spawn, so PYRY_RUNNER_FILE is read live too. */
  path: string | null | (() => string | null);
  env: NodeJS.ProcessEnv;
  read?: (path: string) => string;
  warn?: (message: string) => void;
}): (role: string, kind?: SpawnKind) => AgentRunner {
  const read = opts.read ?? ((p: string) => readFileSync(p, "utf8"));
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  let lastGood: RunnerFile | null = null;
  let lastError = "";
  return (role: string, kind: SpawnKind = {}) => {
    const fallback = resolveAgentRunner(opts.env);
    const outcome = readRunnerFile(typeof opts.path === "function" ? opts.path() : opts.path, read);
    let file: RunnerFile | null;
    if (outcome.kind === "invalid") {
      if (outcome.error !== lastError) {
        warn(`⚠️  Runner file ignored, ${lastGood ? "keeping the last valid one" : `using PYRY_AGENT_RUNNER (${fallback})`}: ${outcome.error}`);
        lastError = outcome.error;
      }
      file = lastGood;
    } else {
      lastError = "";
      file = outcome.kind === "ok" ? outcome.file : null;
      lastGood = file;
    }
    return (kind.reworkAfterFail ? file?.rework?.[role] : undefined) ?? file?.roles?.[role] ?? file?.runner ?? fallback;
  };
}
