import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { StreamResult } from "./dispatch.js";
import { IDLE_STALL_REASON, idleStallMessage, scrubCredentials } from "./agent-runtime.js";

export type AgentRunner = "claude" | "codex";

/** A separate reader, with no shell, write, network or delegation tools. */
export function buildClaudeSourceReviewInvocation(opts: {
  root: string; model: string; effort: string; maxTurns: number; systemPromptFile: string;
}): { bin: string; args: string[] } {
  return { bin: "claude", args: [
    "-p", "--verbose", "--output-format", "stream-json",
    "--restricted", "--safe-mode", "--no-chrome", "--disable-slash-commands",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep",
    "--permission-mode", "dontAsk", "--add-dir", opts.root,
    "--model", opts.model, "--effort", opts.effort, "--max-turns", String(opts.maxTurns),
    "--append-system-prompt-file", opts.systemPromptFile,
    "--json-schema", JSON.stringify({ type: "object", properties: {
      status: { type: "string", enum: ["completed", "blocked"] }, summary: { type: "string" },
    }, required: ["status", "summary"], additionalProperties: false }),
  ] };
}

/** A typo must fail before the dispatcher starts changing the board. */
export function resolveAgentRunner(env: NodeJS.ProcessEnv): AgentRunner {
  const value = env.PYRY_AGENT_RUNNER ?? "claude";
  if (value === "claude" || value === "codex") return value;
  throw new Error(`Invalid PYRY_AGENT_RUNNER ${JSON.stringify(value)}; expected claude or codex`);
}

/** Resolve once at startup, before any ticket is selected or labelled. */
export function resolveCodexExecutable(env: NodeJS.ProcessEnv, options: {
  platform?: string;
  isExecutable?: (path: string) => boolean;
} = {}): string {
  const isExecutable = options.isExecutable ?? ((path: string) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
  const fromPath = (name: string) => (env.PATH ?? "").split(delimiter)
    .filter(Boolean).map(dir => resolve(dir, name)).find(isExecutable);
  const configured = env.PYRY_CODEX_BIN;
  if (configured) {
    const candidate = configured.includes("/") ? resolve(configured) : fromPath(configured);
    if (candidate && isExecutable(candidate)) return candidate;
    throw new Error("PYRY_CODEX_BIN does not identify an executable Codex CLI. Fix it before starting the dispatcher.");
  }
  const found = fromPath("codex");
  if (found) return found;
  if ((options.platform ?? process.platform) === "darwin") {
    for (const bundle of ["/Applications/ChatGPT.app/Contents/Resources/codex", resolve(homedir(), "Applications/ChatGPT.app/Contents/Resources/codex")]) {
      if (isExecutable(bundle)) return bundle;
    }
  }
  throw new Error("Codex executable not found. Install Codex or set PYRY_CODEX_BIN to its absolute executable path before starting the dispatcher.");
}

/**
 * Why a name in `PYRY_AGENT_SHELL_ENV` is refused, or null when it may pass.
 *
 * The list exists to hand Codex tool commands a few non-secret settings,
 * such as `ANDROID_HOME`, that the user's `inherit = "core"` shell policy
 * drops. A secret must never ride along by mistake, so any name that looks
 * like one is refused outright, whatever its value. The name also becomes a
 * bare key in a Codex `-c` override, so it must be a plain upper-case
 * variable name.
 */
export function agentShellEnvNameProblem(name: string): string | null {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return "it is not an upper-case variable name";
  if (/^OP_/i.test(name) || /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE/i.test(name)) {
    return "it looks like a secret";
  }
  return null;
}

/** Names already warned about, so a refused name warns once per process. */
const warnedAgentShellEnvNames = new Set<string>();

/**
 * The fork's `PYRY_AGENT_SHELL_ENV` allowlist resolved against `env`: each
 * listed name that passes `agentShellEnvNameProblem` and has a non-blank
 * value. Comma- or space-separated, duplicates ignored. Unset or empty
 * yields nothing, which leaves the Codex invocation exactly as before.
 *
 * Pass the environment the Codex child actually gets (`codexChildEnv`), so a
 * variable the dispatcher deliberately withholds from Codex stays withheld.
 */
export function resolveAgentShellEnv(env: NodeJS.ProcessEnv, opts: {
  warn?: (message: string) => void;
  warned?: Set<string>;
} = {}): Record<string, string> {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const warned = opts.warned ?? warnedAgentShellEnvNames;
  const out: Record<string, string> = {};
  for (const name of new Set((env.PYRY_AGENT_SHELL_ENV ?? "").split(/[\s,]+/).filter(Boolean))) {
    const problem = agentShellEnvNameProblem(name);
    if (problem) {
      if (!warned.has(name)) {
        warned.add(name);
        warn(`   ⚠️  PYRY_AGENT_SHELL_ENV: skipping ${JSON.stringify(name)} because ${problem}. Codex commands will not see it.`);
      }
      continue;
    }
    const value = env[name];
    if (value === undefined || value.trim() === "") continue;
    out[name] = value;
  }
  return out;
}

/**
 * The only names a Codex builder with live tests inherits into its tool
 * commands (`shell_environment_policy.include_only`). `LC_*` is a pattern.
 * Shared with the pre-dispatch health check, so a name dropped here fails
 * the check in the same way it fails the run (agent-dispatcher#131).
 */
export function builderLiveInheritedNames(shellEnvNames: readonly string[]): string[] {
  return [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_*", "TERM", "TMPDIR", "TMP", "TEMP",
    "GH_TOKEN", "DISPLAY", "PLAYWRIGHT_BROWSERS_PATH",
    "AGENTS_REPO_PATH", ...shellEnvNames, "OP_SERVICE_ACCOUNT_TOKEN",
  ];
}

export function buildCodexInvocation(opts: {
  cwd: string; role: string; model: string; effort: string; bin?: string; agentsRepoPath?: string; sourceReview?: boolean;
  /** Non-secret settings for tool commands, from `resolveAgentShellEnv`. */
  shellEnv?: Readonly<Record<string, string>>;
  /** Names-only inheritance for the builder's restricted live-test account. */
  builderLiveTests?: boolean;
}): { bin: string; args: string[] } {
  // The read-only source reviewer runs with --ignore-user-config, so the
  // user's core-only shell policy does not apply to it and it builds
  // nothing. It gets no extra settings.
  const shellEnv = opts.sourceReview ? [] : Object.entries(opts.shellEnv ?? {})
    .filter(([name]) => !(name === "AGENTS_REPO_PATH" && opts.agentsRepoPath));
  return {
    bin: opts.bin || "codex",
    args: [
      "exec", "--json",
      // Preliminary review runs from an empty temporary directory, so no
      // project config can restore MCP access. Auth still uses CODEX_HOME.
      // Read-only shell + no network/approval + no connector/plugin tools
      // makes publishing a verdict impossible until the final phase.
      ...(opts.sourceReview ? [
        "--ignore-user-config", "--sandbox", "read-only", "--skip-git-repo-check",
        "-c", 'approval_policy="never"',
        "-c", "features.apps=false", "-c", "features.plugins=false",
        "-c", "features.multi_agent=false", "-c", "features.browser_use=false",
        "-c", "features.browser_use_external=false", "-c", 'web_search="disabled"',
      ] : ["--approve-for-me"]),
      "--output-schema", fileURLToPath(new URL("../codex-result.schema.json", import.meta.url)),
      "--cd", opts.cwd,
      // Add role instructions without replacing Codex's built-in instructions.
      "-c", `developer_instructions=${JSON.stringify(opts.role)}`,
      "-c", 'project_doc_fallback_filenames=["CLAUDE.md"]',
      // Meshy is for interactive art work; its launcher asks 1Password on every start.
      ...(!opts.sourceReview ? ["-c", "mcp_servers.meshy.enabled=false"] : []),
      // Core shell inheritance drops custom variables. Supply only this
      // non-secret path so role checklists remain readable from tool commands.
      ...(opts.agentsRepoPath ? ["-c", `shell_environment_policy.set.AGENTS_REPO_PATH=${JSON.stringify(opts.agentsRepoPath)}`] : []),
      // The fork's PYRY_AGENT_SHELL_ENV allowlist, the same way: named,
      // non-secret settings such as ANDROID_HOME, never the whole env.
      ...shellEnv.flatMap(([name, value]) => ["-c", `shell_environment_policy.set.${name}=${JSON.stringify(value)}`]),
      // A value in `set` would put the secret in argv and logs. Inherit only
      // core shell names, existing container publishing/display settings,
      // explicit non-secret settings and the restricted account. GH_TOKEN
      // already belongs to agent environments; GITHUB_TOKEN and Automation
      // were removed by the spawn scrubber before this point.
      ...(!opts.sourceReview && opts.builderLiveTests ? [
        "-c", 'shell_environment_policy.inherit="all"',
        "-c", "shell_environment_policy.ignore_default_excludes=true",
        "-c", `shell_environment_policy.include_only=${JSON.stringify(builderLiveInheritedNames(shellEnv.map(([name]) => name)))}`,
      ] : []),
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(opts.effort)}`] : []),
      "-",
    ],
  };
}

/**
 * Codex's own words when its automatic approval reviewer rejected an action.
 * codex-rs renders every rejection as "This action was rejected due to
 * unacceptable risk.\nReason: ..." (`render_guardian_rejection` in
 * prompts/src/guardian_instructions.rs), so the sentence starts a line of
 * Codex's message. Tested only on `codexRefusalText` and
 * `codexRouterMessages`, never on a command's output or the agent's summary.
 */
const APPROVAL_REJECTED = /^This action was rejected due to unacceptable risk/m;

/**
 * Codex's own words when its automatic approval reviewer could not decide,
 * as opposed to rejecting. Seen on the `codex_core::tools::router` ERROR line
 * on stderr, pyrycode-mobile 2026-10-05: #1582 (the reviewer's model was at
 * capacity) and #1655 (the review missed its deadline), and in an MCP item's
 * error on #1783. Each phrase starts a line of Codex's message
 * (ext/guardian-reviewer/src/completion.rs, prompts/src/model_messages/guardian.rs).
 * Tested on the same Codex-only text as `APPROVAL_REJECTED`.
 */
const APPROVAL_REVIEW_FAILED = /^(?:Automatic approval review failed|The action was not executed because automatic approval review could not be completed|The automatic permission approval review did not finish before its deadline)/m;

/**
 * The text Codex itself wrote about an action it refused, from one completed
 * item, or "". Never a command's output or a tool's successful result: the
 * agent controls those. On pyrycode-desktop #1726, 2026-10-05, a verifier
 * grepped a dispatcher source file that contains the rejection sentence, and
 * the dispatcher parked a passing run as rejected.
 *
 * - `command_execution`: only a `declined` item. codex-rs gives a refused
 *   tool call that status with the refusal as its output
 *   (core/src/tools/events.rs). In codex-cli 0.159.2 a refused shell command's
 *   item is `"aggregated_output":"","status":"declined"`, and the reason is
 *   only on stderr, as on mobile #1766; see `codexRouterMessages`.
 * - `mcp_tool_call`: only a `failed` item. Codex puts its refusal in
 *   `error.message` (mobile #1783). A bundled tool that relays the reviewer,
 *   such as browser use, puts it in the failed result's text.
 */
export function codexRefusalText(item: Record<string, any> | null | undefined): string {
  if (item?.type === "command_execution") {
    return item.status === "declined" && typeof item.aggregated_output === "string" ? item.aggregated_output : "";
  }
  if (item?.type === "mcp_tool_call" && item.status === "failed") {
    const parts: string[] = [];
    if (typeof item.error?.message === "string") parts.push(item.error.message);
    if (Array.isArray(item.result?.content)) {
      for (const c of item.result.content) if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Codex's own message from each `codex_core::tools::router` ERROR line on
 * stderr: the text after `error=`, or after `Rejected(\"` when the error
 * wraps a refusal. A shell command refusal looks like this, from mobile #1766
 * with codex-cli 0.159.2:
 *
 *   2026-10-05T08:41:42.974936Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\"This action was rejected due to unacceptable risk.\\nReason: ...
 *
 * Codex escapes line breaks there, so each message is one line, and the
 * patterns above match only at its start. Other stderr text never counts.
 */
export function codexRouterMessages(stderr: string): string[] {
  const messages: string[] = [];
  for (const m of stderr.matchAll(/ERROR codex_core::tools::router: error=(.*)/g)) {
    const refusal = /^[^"]*"Rejected\(\\"(.*)/.exec(m[1]);
    messages.push(refusal ? refusal[1] : m[1]);
  }
  return messages;
}

/** Longest failed MCP call text the run log keeps. */
export const MCP_FAILURE_LOG_CAP = 4000;

/**
 * The run-log line for a Codex MCP tool call that did not succeed, or null.
 *
 * The run log keeps a 300-character preview of each Codex event, and an MCP
 * item's outcome comes after its arguments, so a failed call's reason never
 * reached the log. On pyrycode-mobile #1783, 2026-10-05, a `codegraph_context`
 * call was refused because Codex's approval reviewer was at capacity; Codex
 * wrote nothing on stderr, and the log cut the item off inside its arguments.
 * Only the agent's paraphrase survived. Two failure shapes, both seen live
 * with codex-cli 0.159.2:
 *
 *   Codex refused or could not run the call:
 *   {"type":"mcp_tool_call",...,"result":null,"error":{"message":"Automatic approval review failed: ..."},"status":"failed"}
 *
 *   The tool ran and reported an error:
 *   {"type":"mcp_tool_call",...,"result":{"content":[{"type":"text","text":"Error: ..."}],"structured_content":null},"error":null,"status":"failed"}
 *
 * The adapter's own classification reads the whole item and needs none of this.
 */
export function failedMcpCallLogLine(item: Record<string, any> | null | undefined): string | null {
  if (item?.type !== "mcp_tool_call") return null;
  const errorMessage = typeof item.error?.message === "string" ? item.error.message : "";
  if (item.status !== "failed" && errorMessage === "") return null;
  const resultText = Array.isArray(item.result?.content)
    ? item.result.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n")
    : "";
  const reason = (errorMessage || resultText || "no error message or result text").replace(/\s*\n\s*/g, " ⏎ ").trim();
  const capped = reason.length > MCP_FAILURE_LOG_CAP ? `${reason.slice(0, MCP_FAILURE_LOG_CAP)}…(truncated)` : reason;
  const source = errorMessage ? "Codex" : "the tool";
  return `MCP tool call failed, reported by ${source}: ${String(item.server ?? "?")}.${String(item.tool ?? "?")}: ${scrubCredentials(capped)}`;
}

/** Native Codex JSONL is not Claude stream-json. A process exit alone is not success. */
export class CodexStreamAdapter {
  private sessionId = "";
  private lastText = "";
  private errorText = "";
  private failed = false;
  private approvalRejected = false;
  private approvalReviewFailed = false;
  private completed = false;
  private turns = 0;
  private usage: Record<string, unknown> = {};

  accept(event: Record<string, any>): void {
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") this.sessionId = event.thread_id;
        break;
      case "item.completed":
        // Tool denial evidence is sticky. A later outcome must not route the
        // rejected action through the dispatcher instead. Only Codex's own
        // refusal text counts, never what a command printed.
        {
          const refusal = codexRefusalText(event.item);
          if (APPROVAL_REJECTED.test(refusal)) this.approvalRejected = true;
          if (APPROVAL_REVIEW_FAILED.test(refusal)) this.approvalReviewFailed = true;
        }
        if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
          this.lastText = event.item.text;
        }
        break;
      case "turn.started":
        this.completed = false;
        break;
      case "turn.completed": {
        this.completed = true;
        this.turns++;
        const u = event.usage ?? {};
        this.usage = {
          input_tokens: u.input_tokens ?? 0,
          cache_read_input_tokens: u.cached_input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
        };
        break;
      }
      case "turn.failed":
        this.failed = true;
        this.errorText = typeof event.error?.message === "string" ? event.error.message : "Codex turn failed";
        break;
      case "error":
        // Reconnect diagnostics can precede a successful turn. Do not poison it.
        if (typeof event.message === "string") this.errorText = event.message;
        break;
    }
  }

  /**
   * `idleStallMs` is the idle threshold when the dispatcher's idle watchdog
   * stopped the run, else 0. A stall is reported as `idle_stall`, which
   * retries as transient, except that a blocked outcome or rejected action
   * still wins: those must never retry by themselves.
   */
  finish(code: number | null, timedOut: boolean, durationMs: number, stderr = "", idleStallMs = 0): StreamResult {
    const idleStalled = idleStallMs > 0;
    let outcome: { status: "completed" | "blocked" | "needs_refinement" | "waiting_on_blocker"; summary: string } | undefined;
    try {
      const parsed = JSON.parse(this.lastText);
      if ((parsed.status === "completed" || parsed.status === "blocked" || parsed.status === "needs_refinement" || parsed.status === "waiting_on_blocker") && typeof parsed.summary === "string" && parsed.summary.trim()) outcome = parsed;
    } catch { /* Missing or malformed task outcome fails closed. */ }
    for (const message of codexRouterMessages(stderr)) {
      if (APPROVAL_REJECTED.test(message)) this.approvalRejected = true;
      if (APPROVAL_REVIEW_FAILED.test(message)) this.approvalReviewFailed = true;
    }
    const blocked = this.approvalRejected || outcome?.status === "blocked";
    const isError = timedOut || idleStalled || code !== 0 || this.failed || !this.completed || !outcome || blocked;
    // Codex reports this temporary access-check outage as a generic failed turn.
    // Map the observed server failure to the existing capped API retry path.
    // A disconnect alone can also mean permanent model denial, so keep it narrow.
    // "Selected model is at capacity" is the same kind of temporary outage:
    // five pyrycode-mobile tickets parked on it on 2026-10-05, and a plain
    // retry minutes later cleared it (#120). Anchored to the full message.
    const temporaryModelAccessFailure = this.failed && (
      /^stream disconnected before completion: Unable to verify model access right now\.\s*Please retry\.?$/i.test(this.errorText.trim())
      || /^Selected model is at capacity\.\s*Please try a different model\.?$/i.test(this.errorText.trim()));
    // The stall is the cause even when the wall clock also fired meanwhile.
    const terminalReason = blocked ? "codex_blocked" : idleStalled ? IDLE_STALL_REASON : timedOut ? "timeout"
      : isError ? (temporaryModelAccessFailure ? "api_error" : "codex_error")
      : outcome?.status === "needs_refinement" ? "needs_refinement"
      : outcome?.status === "waiting_on_blocker" ? "waiting_on_blocker" : "stop";
    // Stderr reaches the ticket through this text, so scrub it like the
    // claude runner's no-result tail (shared helper, 2026-10-02).
    const failure = blocked ? (this.approvalRejected ? "Automatic approval review rejected an action. Operator review required." : outcome!.summary)
      : idleStalled ? idleStallMessage(idleStallMs)
      : scrubCredentials(this.errorText || stderr.trim()) || `Codex exited with code ${code} without a successful completed task outcome`;
    return {
      runner: "codex", costKnown: false,
      output: isError ? failure : outcome!.summary,
      sessionId: this.sessionId, isError, numTurns: this.turns,
      // Numeric compatibility for existing consumers. costKnown=false makes
      // all human-facing cost reports say unavailable, not a measured zero.
      totalCostUsd: 0, durationMs, usage: this.usage, terminalReason,
      rawResult: { is_error: isError, subtype: isError ? terminalReason : "success", result: isError ? failure : outcome!.summary },
      hadPermissionDenial: this.approvalRejected, approvalReviewFailed: this.approvalReviewFailed,
      stoppedAtDenial: false, deniedOpContent: null,
      lastAssistantText: this.lastText || null, timedOut,
    };
  }
}

export function formatRunCost(result: StreamResult, digits = 2): string {
  return result.costKnown === false ? "cost unavailable" : `$${result.totalCostUsd.toFixed(digits)}`;
}

export function resumeCommand(result: Pick<StreamResult, "runner" | "sessionId">): string {
  return result.runner === "codex" ? `codex resume ${result.sessionId}` : `claude --resume ${result.sessionId}`;
}

/** Claude's own runtime masks these credentials from tools; Codex must not inherit them. */
export function codexChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith("ANTHROPIC_") && !key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_CONFIG_DIR"));
}

export const CODEX_ROLE_GUIDANCE = `
This dispatch uses Codex. Apply the role instructions above with these runtime adaptations:
- The Codex model defaults to GPT-6 Sol, with optional dispatcher model and effort overrides. Effort otherwise comes from Codex configuration. Claude model names and max-turn counts do not apply. The dispatcher enforces a wall-clock budget. There is no automatic continuation for Codex.
- Use available Codex tools. Claude MCP names and tool allowlists do not configure Codex. If a named search tool is unavailable, use repository files and command-line search.
- Stay within this role's allowed files and assigned ticket. Git commits, pushes, and GitHub changes explicitly required by the assigned role are part of the task. Do not change unrelated tickets, host credentials, or sandbox policy.
- Ordinary sandbox restrictions can be escalated through automatic approval review. If the reviewer rejects a necessary action, stop and report status blocked. Do not work around rejection.
- Builder only: when planning finds a scope, sizing, overlap or missing-information problem requiring refinement, return status needs_refinement with a self-contained explanation and any split proposal or blocker issue numbers. Do not post the routing comment or apply needs-rework:refiner yourself. The dispatcher owns this handoff for the assigned issue. Do not use it for permission denials, failed tools, or documentation work owned by the later documentation stage. After a reviewer rejection, status blocked is mandatory.
- Builder only: when an open GitHub blocked-by dependency prevents work, including rework on a PR whose gate is red on main, link the blocking issue and return status waiting_on_blocker. The dispatcher verifies the open dependency and parks the ticket without an error or rework count. Do not use this outcome for permission denials, missing access, or a failure that this ticket caused.
- Report status completed when this role's assigned work and role-owned checks are done. Explicitly hand off work owned by later stages, including documentation and dispatcher-owned live tests. Pending later-stage work alone is not a blocker and must never be reported as already passed. A builder awaiting live artifacts must follow the role's needs-live-artifacts handoff, identify the exact remaining files/checks in its PR and summary, and finish its implementation stage. On the return from the live gate, committing those artifacts is the builder's own work and cannot be deferred again.
- Missing access or incomplete work required by the current role, and every rejected necessary action, still mean status blocked. Never relabel a permission denial as a later-stage handoff. Return the required JSON outcome with a concise summary.
`;
