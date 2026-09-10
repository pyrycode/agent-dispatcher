import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { StreamResult } from "./dispatch.js";

export type AgentRunner = "claude" | "codex";

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
  cwd: string; role: string; model: string; effort: string; bin?: string;
}): { bin: string; args: string[] } {
  return {
    bin: opts.bin || "codex",
    args: [
      "exec", "--json", "--approve-for-me",
      "--output-schema", fileURLToPath(new URL("../codex-result.schema.json", import.meta.url)),
      "--cd", opts.cwd,
      // Add role instructions without replacing Codex's built-in instructions.
      "-c", `developer_instructions=${JSON.stringify(opts.role)}`,
      "-c", 'project_doc_fallback_filenames=["CLAUDE.md"]',
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
  private completed = false;
  private turns = 0;
  private usage: Record<string, unknown> = {};

  accept(event: Record<string, any>): void {
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") this.sessionId = event.thread_id;
        break;
      case "item.completed":
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
    let outcome: { status: "completed" | "blocked"; summary: string } | undefined;
    try {
      const parsed = JSON.parse(this.lastText);
      if ((parsed.status === "completed" || parsed.status === "blocked") && typeof parsed.summary === "string" && parsed.summary.trim()) outcome = parsed;
    } catch { /* Missing or malformed task outcome fails closed. */ }
    const blocked = outcome?.status === "blocked";
    const isError = timedOut || code !== 0 || this.failed || !this.completed || !outcome || blocked;
    const terminalReason = blocked ? "codex_blocked" : timedOut ? "timeout" : isError ? "codex_error" : "stop";
    const failure = blocked ? outcome!.summary : this.errorText || stderr.trim() || `Codex exited with code ${code} without a successful completed task outcome`;
    return {
      runner: "codex", costKnown: false,
      output: isError ? failure : outcome!.summary,
      sessionId: this.sessionId, isError, numTurns: this.turns,
      // Numeric compatibility for existing consumers. costKnown=false makes
      // all human-facing cost reports say unavailable, not a measured zero.
      totalCostUsd: 0, durationMs, usage: this.usage, terminalReason,
      rawResult: { is_error: isError, subtype: isError ? terminalReason : "success", result: isError ? failure : outcome!.summary },
      hadPermissionDenial: false, deniedOpContent: null,
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
- The selected Codex model and effort come from Codex configuration. Claude model names and max-turn counts do not apply. The dispatcher enforces a wall-clock budget. There is no automatic continuation for Codex.
- Use available Codex tools. Claude MCP names and tool allowlists do not configure Codex. If a named search tool is unavailable, use repository files and command-line search.
- Stay within this role's allowed files and assigned ticket. Git commits, pushes, and GitHub changes explicitly required by the assigned role are part of the task. Do not change unrelated tickets, host credentials, or sandbox policy.
- Ordinary sandbox restrictions can be escalated through automatic approval review. If the reviewer rejects a necessary action, stop and report status blocked. Do not work around rejection.
- Report status completed only after the assigned work and required checks are done. Missing access, incomplete work, or a rejected necessary action means status blocked. Return the required JSON outcome with a concise summary.
`;
