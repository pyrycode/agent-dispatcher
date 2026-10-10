import type { AgentRunner } from "./agent-runner.js";
import type { AgentConfig, ProjectItem } from "./types.js";

export function validateEffortPolicy(value: string | undefined, stageSet: string): void {
  if (!value || value === "off") return;
  if (value !== "role-risk-v1") throw new Error("Invalid PYRY_EFFORT_POLICY; expected off or role-risk-v1");
  if (stageSet !== "builder") throw new Error("PYRY_EFFORT_POLICY=role-risk-v1 requires PYRY_STAGE_SET=builder");
}

// Only an explicit, unambiguous assessment permits reduced build effort.
// Older tickets and skipped refinements remain high until assessed.
function assessedRisk(body: string): "routine" | "elevated" | "unknown" {
  const lines = body.split(/\r?\n/);
  const sections: string[][] = [];
  let section: string[] | undefined;
  let fence: string | undefined;
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (/^#{1,6}[ \t]/.test(line)) {
      section = undefined;
      if (/^## Effort assessment[ \t]*$/.test(line)) {
        section = [];
        sections.push(section);
      }
    } else section?.push(line);
  }
  if (sections.length !== 1) return "unknown";
  const risks = sections[0].filter(line => /^Risk:/.test(line));
  if (risks.length !== 1 || !sections[0].some(line => /^Reason:[ \t]*\S/.test(line))) return "unknown";
  const risk = risks[0].slice(5).trim();
  return risk === "routine" || risk === "elevated" ? risk : "unknown";
}

/**
 * The builder's effort is fixed, with either runner: high on a normal run,
 * xhigh on its rework after a verifier FAIL, the run that gets the FAIL's
 * findings to answer. It beats PYRY_CODEX_EFFORT, role-risk-v1 and the
 * agent's own setting, which still apply to every other role. Chosen by the
 * owner on 2026-10-05, in place of switching the rework to another runner:
 * the builder keeps the runner and model in settings and thinks harder on
 * the run that has real bugs to fix.
 */
function builderEffortReason(opts: { runner: AgentRunner; env: NodeJS.ProcessEnv; policy: string; reworkAfterFail: boolean }): string {
  const ignored: string[] = [];
  if (opts.runner === "codex" && opts.env.PYRY_CODEX_EFFORT) ignored.push(`PYRY_CODEX_EFFORT=${opts.env.PYRY_CODEX_EFFORT}`);
  if (opts.policy !== "off") ignored.push(opts.policy);
  return (opts.reworkAfterFail ? "builder rework after a verifier FAIL" : "builder, not a rework after a verifier FAIL")
    + (ignored.length ? `; overrides ${ignored.join(" and ")}` : "");
}

export function resolveEffort(opts: {
  agent: AgentConfig;
  item: Pick<ProjectItem, "body" | "labels">;
  runner: AgentRunner;
  env: NodeJS.ProcessEnv;
  stageSet: string;
  /** The builder's rework after a verifier FAIL (`prepareReworkFindingsNote` in dispatch.ts). */
  reworkAfterFail?: boolean;
}): { effort: string; policy: string; reason: string } {
  const { agent, item, runner, env, stageSet } = opts;
  validateEffortPolicy(env.PYRY_EFFORT_POLICY, stageSet);
  const policy = env.PYRY_EFFORT_POLICY === "role-risk-v1" ? "role-risk-v1" : "off";
  if ((agent.name === "builder" || agent.name === "developer") && item.labels.includes("orchestrator:fixing")) {
    return { effort: "xhigh", policy, reason: "orchestrator recovery repair" };
  }
  if (agent.name === "builder") {
    const reworkAfterFail = opts.reworkAfterFail === true;
    return { effort: reworkAfterFail ? "xhigh" : "high", policy, reason: builderEffortReason({ runner, env, policy, reworkAfterFail }) };
  }
  if (runner === "codex" && env.PYRY_CODEX_EFFORT) {
    return { effort: env.PYRY_CODEX_EFFORT, policy, reason: "explicit PYRY_CODEX_EFFORT override" };
  }
  if (policy === "off") {
    return { effort: runner === "codex" ? env.PYRY_CODEX_EFFORT ?? "" : agent.effort ?? "high",
      policy, reason: runner === "codex" ? "inherited Codex setting" : "configured Claude role/default" };
  }
  const security = item.labels.includes("security-sensitive");
  const risk = security ? "elevated" : assessedRisk(item.body);
  const reason = security ? "security-sensitive label" : `ticket assessment: ${risk}`;
  switch (agent.name) {
    case "refiner": return { effort: risk === "elevated" ? "high" : "medium", policy, reason };
    case "verifier": return { effort: "high", policy, reason: `independent verification; ${reason}` };
    case "documentation": return { effort: risk === "routine" ? "low" : "medium", policy, reason };
    default: throw new Error(`No role-risk-v1 effort policy for ${agent.name}`);
  }
}
