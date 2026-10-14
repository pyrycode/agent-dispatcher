/**
 * One colour per label family, so every pyrycode board reads the same way.
 * Scheme and reasoning: vault note "Label Colors" under the Pyrycode project.
 * Hex values avoid the mid-luminance band, so GitHub's black or white label
 * text stays readable in both themes. Unknown labels keep GitHub's grey.
 */
export const DEFAULT_LABEL_COLOR = "ededed";

const EXACT: Readonly<Record<string, string>> = {
  "security-sensitive": "24292F",
  merged: "0F5323",
  "merge-handoff": "BFD9F8",
  "flaky-test": "F2CC60",
  "trial:invariant-probes": "DDF4FF",
  "orchestrator:escalated": "073F3A",
};

const CLAIM: Readonly<Record<string, string>> = {
  pyrybox: "D0D7DE",
  macbook: "C4CBD3",
  "build-hp-1": "B8C0C9",
  "build-fractal-2": "ACB5BF",
};

const PRIORITY: Readonly<Record<string, string>> = { high: "5A32A3", normal: "A58BE0", low: "E4D9F7" };
const SIZE: Readonly<Record<string, string>> = { xs: "FAD4E8", s: "F29CC6", m: "B0246C", l: "7A1049" };

/** Greens run pale to dark in pipeline order: refine, architect, build, qa, review, docs. */
const DONE_STAGE: Readonly<Record<string, string>> = {
  po: "D3F0DB",
  refiner: "D3F0DB",
  architect: "A5DDB5",
  developer: "72C690",
  builder: "72C690",
  qa: "3CA862",
  "code-review": "1B7A3A",
  verifier: "1B7A3A",
  documentation: "14692D",
};

const COUNTER_PREFIXES = ["error-retry-count:", "rework-count:", "rework-other:", "family-dispatches:", "merge-attempt:"];

export function labelColor(name: string): string {
  if (EXACT[name]) return EXACT[name];
  if (COUNTER_PREFIXES.some((p) => name.startsWith(p))) return "E4E8EC";
  if (name.startsWith("error:")) return "B60205";
  if (name.startsWith("needs-rework:")) return "F5B17A";
  if (name.startsWith("needs-")) return "C2410C";
  if (name.startsWith("wip:")) return "0B5CAD";
  if (name.startsWith("pending-") || name.startsWith("ready:")) return "BFD9F8";
  if (name.startsWith("held:")) return "F2CC60";
  if (name.startsWith("orchestrator:")) return "0B6E65";
  if (name.startsWith("claim:")) return CLAIM[name.slice(6)] ?? "C4CBD3";
  if (name.startsWith("priority:")) return PRIORITY[name.slice(9)] ?? DEFAULT_LABEL_COLOR;
  if (name.startsWith("size:")) return SIZE[name.slice(5)] ?? DEFAULT_LABEL_COLOR;
  if (name.startsWith("done:")) return DONE_STAGE[name.slice(5)] ?? "A5DDB5";
  return DEFAULT_LABEL_COLOR;
}
