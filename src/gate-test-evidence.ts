// Per-fork live evidence for named tests.
//
// Some live tests prove something only through what they attach. Desktop's
// GPT-6 Luna channel scenario (pyrycode-desktop #1809) passes on its own
// assertions, but its acceptance also needs the daemon revision it ran
// against and the published model row the app chose, both attached to the
// passing attempt. Which tests need what is the fork's business, so the rules
// live in the fork's agents repo as `live-test-evidence.json` beside its role
// folders. A fork without the file gets no extra checks.
//
// File shape, an array of rules:
//
//   [{
//     "pattern": "\\bLuna\\b",            // regex, case-insensitive, on the test name
//     "requireWhenReported": true,        // a reported test that matches is required too
//     "sameAttemptDaemonRevision": true,  // daemon-revision annotation and attachment agree on the passing attempt
//     "attachments": ["published-model-row"],
//     "json": [{
//       "attachment": "published-model-row",
//       "nonEmpty": ["serverId", "conversationId", "model.value"],
//       "equals": { "model.agent": "codex", "model.display_name": "GPT-6 Luna" },
//       "notEquals": { "model.value": "default" },
//       "includes": { "model.effort_levels": "low" },
//       "listContains": { "models": "model" }
//     }]
//   }]
//
// Every check reads the final, actually passing attempt. A rule's test that
// fails in the full run still routes to repair, but a failure-only re-run
// cannot supply its evidence afterwards.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GateTestDetail } from "./gate-output.js";

export const TEST_EVIDENCE_FILE = "live-test-evidence.json";

export interface JsonAttachmentCheck {
  attachment: string;
  nonEmpty?: string[];
  equals?: Record<string, string | number | boolean>;
  notEquals?: Record<string, string | number | boolean>;
  includes?: Record<string, string | number | boolean>;
  /** The array at the key path holds an element carrying every field of the value at the other path. */
  listContains?: Record<string, string>;
}

export interface TestEvidenceRule {
  pattern: string;
  requireWhenReported?: boolean;
  sameAttemptDaemonRevision?: boolean;
  attachments?: string[];
  json?: JsonAttachmentCheck[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const scalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);
const scalarMap = (v: unknown) => isRecord(v) && Object.entries(v).every(([k, x]) => k !== "" && scalar(x));

/** Validate the file's text. Anything unexpected is an error, never ignored:
 *  a typo must not silently drop a fork's acceptance requirement. */
export function parseTestEvidenceRules(text: string): { rules: TestEvidenceRule[]; error: string | null } {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e: any) { return { rules: [], error: `${TEST_EVIDENCE_FILE} is not JSON: ${e?.message ?? e}` }; }
  if (!Array.isArray(doc)) return { rules: [], error: `${TEST_EVIDENCE_FILE} must be an array of rules` };
  const known = new Set(["pattern", "requireWhenReported", "sameAttemptDaemonRevision", "attachments", "json"]);
  const knownJson = new Set(["attachment", "nonEmpty", "equals", "notEquals", "includes", "listContains"]);
  for (const [i, rule] of doc.entries()) {
    const where = `${TEST_EVIDENCE_FILE} rule ${i + 1}`;
    if (!isRecord(rule)) return { rules: [], error: `${where} is not an object` };
    const unknown = Object.keys(rule).filter(k => !known.has(k));
    if (unknown.length) return { rules: [], error: `${where} has unknown keys: ${unknown.join(", ")}` };
    if (!nonEmptyString(rule.pattern)) return { rules: [], error: `${where} needs a pattern` };
    try { new RegExp(rule.pattern, "i"); } catch { return { rules: [], error: `${where} has an invalid pattern` }; }
    for (const flag of ["requireWhenReported", "sameAttemptDaemonRevision"] as const) {
      if (rule[flag] !== undefined && typeof rule[flag] !== "boolean") return { rules: [], error: `${where}: ${flag} must be true or false` };
    }
    if (rule.attachments !== undefined && !(Array.isArray(rule.attachments) && rule.attachments.every(nonEmptyString))) {
      return { rules: [], error: `${where}: attachments must be a list of names` };
    }
    if (rule.json !== undefined) {
      if (!Array.isArray(rule.json)) return { rules: [], error: `${where}: json must be a list` };
      for (const check of rule.json) {
        if (!isRecord(check) || !nonEmptyString(check.attachment)) return { rules: [], error: `${where}: each json check names an attachment` };
        const extra = Object.keys(check).filter(k => !knownJson.has(k));
        if (extra.length) return { rules: [], error: `${where}: json check has unknown keys: ${extra.join(", ")}` };
        if (check.nonEmpty !== undefined && !(Array.isArray(check.nonEmpty) && check.nonEmpty.every(nonEmptyString))) {
          return { rules: [], error: `${where}: nonEmpty must be a list of paths` };
        }
        for (const key of ["equals", "notEquals", "includes"] as const) {
          if (check[key] !== undefined && !scalarMap(check[key])) return { rules: [], error: `${where}: ${key} maps paths to plain values` };
        }
        if (check.listContains !== undefined && !(isRecord(check.listContains) && Object.values(check.listContains).every(nonEmptyString))) {
          return { rules: [], error: `${where}: listContains maps a list path to a value path` };
        }
      }
    }
  }
  return { rules: doc as TestEvidenceRule[], error: null };
}

/** Read the fork's rules from its agents repo. A missing file means none. */
export function loadTestEvidenceRules(agentsRepoRoot: string, read: (path: string) => string = p => readFileSync(p, "utf8")):
  { rules: TestEvidenceRule[]; error: string | null } {
  let text: string;
  try { text = read(resolve(agentsRepoRoot, TEST_EVIDENCE_FILE)); } catch (e: any) {
    return e?.code === "ENOENT" ? { rules: [], error: null } : { rules: [], error: `${TEST_EVIDENCE_FILE} could not be read: ${e?.message ?? e}` };
  }
  return parseTestEvidenceRules(text);
}

export function rulesFor(name: string, rules: readonly TestEvidenceRule[]): TestEvidenceRule[] {
  return rules.filter(rule => new RegExp(rule.pattern, "i").test(name));
}

/** Names in a report that a `requireWhenReported` rule makes required. */
export function reportedRequiredTests(names: readonly string[], rules: readonly TestEvidenceRule[]): string[] {
  const always = rules.filter(rule => rule.requireWhenReported);
  return [...new Set(names.filter(name => always.some(rule => new RegExp(rule.pattern, "i").test(name))))];
}

function at(doc: unknown, path: string): unknown {
  let value: unknown = doc;
  for (const key of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

/** `item` carries every field of `value` with the same contents. Arrays
 *  match element by element; extra fields on `item` are allowed. */
function covers(item: unknown, value: unknown): boolean {
  if (Array.isArray(value)) return Array.isArray(item) && item.length === value.length && value.every((v, i) => covers(item[i], v));
  if (isRecord(value)) return isRecord(item) && Object.entries(value).every(([k, v]) => covers(item[k], v));
  return item === value;
}

/** Why one passing attempt does not satisfy the rules, or null when it does. */
export function missingTestEvidence(detail: GateTestDetail, rules: readonly TestEvidenceRule[]): string | null {
  const attempt = detail.passingAttempt;
  if (!attempt) return "has no actual passing attempt";
  for (const rule of rules) {
    if (rule.sameAttemptDaemonRevision && !attempt.daemonRevision) {
      return `lacks a daemon-revision attachment matching its annotation on passing attempt ${attempt.attempt}`;
    }
    for (const name of rule.attachments ?? []) {
      if (!attempt.attachments?.[name]) return `lacks the ${name} attachment on passing attempt ${attempt.attempt}`;
    }
    for (const check of rule.json ?? []) {
      const text = attempt.attachments?.[check.attachment];
      if (!text) return `lacks the ${check.attachment} attachment on passing attempt ${attempt.attempt}`;
      let doc: unknown;
      try { doc = JSON.parse(text); } catch { return `has a ${check.attachment} attachment that is not JSON`; }
      const bad = (what: string) => `has a ${check.attachment} attachment whose ${what}`;
      for (const path of check.nonEmpty ?? []) if (!nonEmptyString(at(doc, path))) return bad(`${path} is empty`);
      for (const [path, value] of Object.entries(check.equals ?? {})) if (at(doc, path) !== value) return bad(`${path} is not ${JSON.stringify(value)}`);
      for (const [path, value] of Object.entries(check.notEquals ?? {})) if (at(doc, path) === value) return bad(`${path} is ${JSON.stringify(value)}`);
      for (const [path, value] of Object.entries(check.includes ?? {})) {
        const list = at(doc, path);
        if (!Array.isArray(list) || !list.includes(value)) return bad(`${path} does not include ${JSON.stringify(value)}`);
      }
      for (const [listPath, valuePath] of Object.entries(check.listContains ?? {})) {
        const list = at(doc, listPath), value = at(doc, valuePath);
        if (!Array.isArray(list) || value === undefined || !list.some(item => covers(item, value))) {
          return bad(`${listPath} does not contain its ${valuePath}`);
        }
      }
    }
  }
  return null;
}
