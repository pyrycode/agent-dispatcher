import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { StreamResult } from "./dispatch.js";

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

export function buildCodexInvocation(opts: {
  cwd: string; role: string; model: string; effort: string; bin?: string; agentsRepoPath?: string; sourceReview?: boolean;
}): { bin: string; args: string[] } {
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
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(opts.effort)}`] : []),
      "-",
    ],
  };
}

/** Native Codex JSONL is not Claude stream-json. A process exit alone is not success. */
export class CodexStreamAdapter {
  private sessionId = "";
  private lastText = "";
  private errorText = "";
  private failed = false;
  private approvalRejected = false;
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
        // rejected action through the dispatcher instead.
        if (event.item?.type !== "agent_message" && /This action was rejected due to unacceptable risk/.test(JSON.stringify(event.item ?? {}))) {
          this.approvalRejected = true;
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

  finish(code: number | null, timedOut: boolean, durationMs: number, stderr = ""): StreamResult {
    let outcome: { status: "completed" | "blocked" | "needs_refinement" | "waiting_on_blocker"; summary: string } | undefined;
    try {
      const parsed = JSON.parse(this.lastText);
      if ((parsed.status === "completed" || parsed.status === "blocked" || parsed.status === "needs_refinement" || parsed.status === "waiting_on_blocker") && typeof parsed.summary === "string" && parsed.summary.trim()) outcome = parsed;
    } catch { /* Missing or malformed task outcome fails closed. */ }
    this.approvalRejected ||= /This action was rejected due to unacceptable risk/.test(stderr);
    const blocked = this.approvalRejected || outcome?.status === "blocked";
    const isError = timedOut || code !== 0 || this.failed || !this.completed || !outcome || blocked;
    // Codex reports this temporary access-check outage as a generic failed turn.
    // Map the observed server failure to the existing capped API retry path.
    // A disconnect alone can also mean permanent model denial, so keep it narrow.
    const temporaryModelAccessFailure = this.failed && /^stream disconnected before completion: Unable to verify model access right now\.\s*Please retry\.?$/i.test(this.errorText.trim());
    const terminalReason = blocked ? "codex_blocked" : timedOut ? "timeout"
      : isError ? (temporaryModelAccessFailure ? "api_error" : "codex_error")
      : outcome?.status === "needs_refinement" ? "needs_refinement"
      : outcome?.status === "waiting_on_blocker" ? "waiting_on_blocker" : "stop";
    const failure = blocked ? (this.approvalRejected ? "Automatic approval review rejected an action. Operator review required." : outcome!.summary) : this.errorText || stderr.trim() || `Codex exited with code ${code} without a successful completed task outcome`;
    return {
      runner: "codex", costKnown: false,
      output: isError ? failure : outcome!.summary,
      sessionId: this.sessionId, isError, numTurns: this.turns,
      // Numeric compatibility for existing consumers. costKnown=false makes
      // all human-facing cost reports say unavailable, not a measured zero.
      totalCostUsd: 0, durationMs, usage: this.usage, terminalReason,
      rawResult: { is_error: isError, subtype: isError ? terminalReason : "success", result: isError ? failure : outcome!.summary },
      hadPermissionDenial: this.approvalRejected, stoppedAtDenial: false, deniedOpContent: null,
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
