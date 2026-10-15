// The dispatcher's half of the shared evidence store (evidence-store.ts).
//
// When an agent run, a live gate run or a recovery assessment ends, pass or
// fail, the dispatcher gathers that run's evidence from its own disk: the
// agent log, verifier and live gate logs and stderr, gate run records, the
// verdict handoff, test reports and anything new in the ticket's evidence
// folder. Small text files go in whole, long logs as their tail, and large or
// binary files (emulator logs, videos, full logs) stay on this computer and
// appear in `pointers.json` with the computer, path, size and SHA-256. A
// `SHA256SUMS` file covers the bundle. Every text is redacted before it is
// written anywhere.
//
// The bundle is first written to an outbox on local disk, then uploaded in
// the background. An upload failure never fails the run: it is logged, the
// bundle stays in the outbox and the next flush retries it. A claim service
// or machine manager that predates the store answers "Unknown operation";
// that keeps the bundle too, so evidence written during a mixed-version
// rollout arrives once both sides are updated.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, readSync, closeSync, chmodSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { scrubCredentials } from "./agent-runtime.js";
import { ARTIFACT_LIMITS, artifactManifest, sha256, type ArtifactManifest } from "./recovery-artifacts.js";
import type { EvidenceKind, EvidenceMeta } from "./evidence-store.js";

const KIB = 1024, MIB = 1024 * KIB;
/** A tail read reaches this far back, so it can start at a line boundary. */
const TAIL_MARGIN = 64 * KIB;
/** The dispatcher's own run logs (`agentLogPath`), the only files that carry prompt sections. */
const AGENT_LOG = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_[\w-]+_#\d+\.(?:source\.)?log$/;

export interface RunEvidenceLimits {
  /** Bytes of file content in one bundle, generated files included. Under the store's 8 MiB default. */
  bundleBytes: number;
  /** A text file up to this size goes in whole. */
  wholeBytes: number;
  /** A structured report (JUnit XML, JSON) up to this size goes in whole. */
  reportBytes: number;
  /** A longer text file goes in as its last this many bytes. */
  tailBytes: number;
  /** Files carried in one bundle, generated ones included. */
  files: number;
  /** Large-file pointers in one bundle. */
  pointers: number;
  /** Files above this are pointed to without a hash: hashing them would hold the run. */
  hashBytes: number;
}
export const DEFAULT_RUN_EVIDENCE_LIMITS: RunEvidenceLimits = {
  bundleBytes: 7 * MIB,
  wholeBytes: 512 * KIB,
  reportBytes: 2 * MIB,
  tailBytes: 256 * KIB,
  files: 200,
  pointers: 300,
  hashBytes: 256 * MIB,
};

export interface EvidencePointer { machine: string; path: string; bytes: number; sha256: string | null; modified: number; reason: string }
export interface EvidenceBundle {
  version: 1;
  ticket: string;
  runId: string;
  meta: EvidenceMeta;
  files: Record<string, string>;
}
export interface RunEvidenceInput {
  issueNumber: number;
  runId: string;
  role: string;
  kind: EvidenceKind;
  outcome: string;
  startedAt: number;
  endedAt: number;
  /** The run's own dispatch log, when it has one. */
  logFile?: string;
  /** The verdict handoff file outside the logs folder. */
  verdictHandoffPath?: string;
}
export interface EvidenceConnection { call<T>(path: string, body?: unknown): Promise<T> }

const REDACTED = "[REDACTED]";
/**
 * Shapes the shared scrubber does not blank, for evidence only. Before this
 * store these logs stayed on their own computer; now every agent can read
 * them. Each pattern is linear: no unbounded run before a keyword.
 */
const EVIDENCE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private keys, whole block.
  // Bounded, so a header without its end costs 16 KiB rather than the rest of the file.
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,16384}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|[\s\S]{0,16384})/g, `-----${REDACTED} PRIVATE KEY-----`],
  // HTTP basic and other authorization schemes, cookies.
  [/\b(Authorization|Proxy-Authorization)(\\*["']?[ \t]{0,16}[:=][ \t]{0,16}\\*["']?[ \t]{0,16})(?:Basic|Digest|Token|Negotiate|AWS4-HMAC-SHA256)\s+[^\s"'\\]{6,}/gi, `$1$2${REDACTED}`],
  [/\b((?:Set-)?Cookie\\*["']?\s*[:=]\s*\\*["']?)[^\r\n"\\]{8,}/gi, `$1${REDACTED}`],
  // Provider keys without an assignment: OpenAI, AWS access key ids, Slack, Google, Stripe.
  [/\b(?:sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{32,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|(?:sk|rk)_live_[A-Za-z0-9]{16,})/g, REDACTED],
  // `--token VALUE`, `--api-key VALUE`, `--password VALUE`.
  [/(--?(?:[a-z0-9]+-)?(?:token|api-?key|key|secret|password|passwd|pass|auth)(?:[ \t]+|=))(?!-)[^\s"']{8,}/gi, `$1${REDACTED}`],
  // A name holding a credential word anywhere: KEYSTORE_BASE64=..., SIGNING_KEY_PASSWORD=..., DB_PASSWD=...
  [/\b([A-Z0-9_]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)[A-Z0-9_]{0,64}\s*=\s*["']?)[^\s"']{8,}/g, `$1${REDACTED}`],
  // Signed URL parameters.
  [/([?&](?:sig|signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential|token|access_token|code)=)[^&\s"']{8,}/gi, `$1${REDACTED}`],
];

/** Redact until nothing changes: one pass can expose a new match at a cut edge. */
export function redact(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i++) {
    let next = scrubCredentials(out);
    for (const [pattern, replacement] of EVIDENCE_PATTERNS) next = next.replace(pattern, replacement);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Drop the partial first line of text that starts mid-file, so a credential
 * the cut fell inside, or the name that marks one, never survives without
 * the context that identifies it. Only whole lines are kept. Null when
 * there is no line boundary at all: such a file is pointed to, not cut.
 */
function fromLineStart(bytes: Buffer): Buffer | null {
  const newline = bytes.indexOf(0x0a);
  return newline < 0 ? null : bytes.subarray(newline + 1);
}

/**
 * Text that starts mid-file may hold the end of a private key whose header
 * fell before the cut, which no pattern can recognise: everything up to that
 * key's end marker goes.
 */
export function dropOrphanKeyTail(text: string): string {
  const head = text.slice(0, 64 * 1024);
  const end = head.search(/-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/);
  if (end < 0 || /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/.test(head.slice(0, end))) return text;
  const close = text.indexOf("-----", text.indexOf("PRIVATE KEY", end)) + 5;
  return `-----${REDACTED} PRIVATE KEY-----` + text.slice(close);
}

/** The last `max` bytes of already redacted `text`, whole lines only, redacted again. Null without a line boundary. */
function tailText(text: string, max: number): string | null {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  const lines = fromLineStart(bytes.subarray(bytes.length - max));
  return lines === null ? null : redact(dropOrphanKeyTail(lines.toString("utf8")));
}

/**
 * The prompt and system prompt the dispatcher writes into an agent's log.
 * They are instructions, not evidence, and stay on this computer. The agent's
 * stream that follows them, timestamped `[hh:mm:ss]`, is kept.
 */
export function stripPromptSections(text: string): string {
  if (!text.includes("PROMPT — ")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  const rule = "=".repeat(60);
  let inPrompt = false, skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === rule && i + 2 < lines.length && lines[i + 2] === rule && / — \d{4}-\d{2}-\d{2}T/.test(lines[i + 1])) {
      if (inPrompt && skipped) out.push(`[${skipped} prompt line(s) omitted from shared evidence]`);
      inPrompt = /PROMPT — /.test(lines[i + 1]);
      skipped = 0;
      out.push(line, lines[i + 1], lines[i + 2]);
      i += 2;
      continue;
    }
    if (inPrompt && /^\[\d{2}:\d{2}:\d{2}\] /.test(line)) {
      if (skipped) out.push(`[${skipped} prompt line(s) omitted from shared evidence]`);
      inPrompt = false; skipped = 0;
    }
    if (inPrompt) { skipped++; continue; }
    out.push(line);
  }
  if (inPrompt && skipped) out.push(`[${skipped} prompt line(s) omitted from shared evidence]`);
  return out.join("\n");
}

function readTail(path: string, size: number, max: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const length = Math.min(size, max);
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, Math.max(0, size - length));
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, reject) => {
    createReadStream(path).on("data", chunk => hash.update(chunk)).on("end", () => resolveHash()).on("error", reject);
  });
  return hash.digest("hex");
}

/** A bundle path: the store accepts `[\w./-]` only. */
export function bundlePath(prefix: string, name: string): string {
  const safe = name.split("/").map(p => p.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_")).filter(Boolean).join("/");
  const path = `${prefix}/${safe}`;
  return path.length <= 230 ? path : `${prefix}/${createHash("sha256").update(name).digest("hex").slice(0, 16)}-${safe.slice(-120).replace(/^[./]+/, "")}`;
}

/** Files under `root` modified at or after `since`, without following links. */
function walk(root: string, since: number, maxEntries = 4000): string[] {
  const out: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let seen = 0;
  while (stack.length && seen < maxEntries) {
    const { path, depth } = stack.pop()!;
    let st;
    try { st = lstatSync(path); } catch { continue; }
    seen++;
    if (st.isDirectory()) {
      if (depth >= 8) continue;
      let names: string[] = [];
      try { names = readdirSync(path); } catch { continue; }
      for (const name of names.sort()) stack.push({ path: resolve(path, name), depth: depth + 1 });
    } else if (st.isFile() && st.mtimeMs >= since) out.push(path);
  }
  return out;
}

/** Never carried: prompts, state files and anything that is not this run's output. */
const SKIPPED = /\.(?:prompt|system)\.txt$|^managed-worktree-|^verdict-pending-|^runtime(?:-health)?\.json$|\.lock$/;
/** Files in the logs folder that belong to ticket `n`. */
export function ticketLogName(name: string, n: number, role: string): boolean {
  if (SKIPPED.test(name)) return false;
  const tag = new RegExp(`(?:_#${n}(?=[._]|$)|#${n}_)`);
  return tag.test(name) || name === `verdict-last-${role}-${n}.json`;
}

function priority(path: string): number {
  const name = basename(path);
  if (path.startsWith("handoff/")) return 0;
  if (/\.meta\.(?:json|log)$|\.pass\.json$|^verdict-last-/.test(name)) return 1;
  if (/\.xml$/i.test(name)) return 2;
  if (/stderr/.test(name)) return 3;
  if (path.startsWith("logs/") && /_(?:verifier-gate|real-claude-gate)|^verifier-gate_/.test(name)) return 4;
  if (path.startsWith("logs/")) return 5;
  return 6;
}

/**
 * Gather one run's bundle from this computer's disk. Never throws for one
 * unreadable file; it is pointed to, or left out when it cannot be read at all.
 */
export async function collectRunEvidence(opts: RunEvidenceInput & {
  project: string; machine: string; logsDir: string; dispatcherRevision?: string;
  limits?: RunEvidenceLimits; now?: () => number;
}): Promise<EvidenceBundle> {
  const limits = opts.limits ?? DEFAULT_RUN_EVIDENCE_LIMITS;
  const since = opts.startedAt - 5_000;
  const candidates = new Map<string, string>(); // absolute path -> wanted bundle path
  let names: string[] = [];
  try { names = readdirSync(opts.logsDir); } catch { /* no logs folder */ }
  for (const name of names) {
    if (!ticketLogName(name, opts.issueNumber, opts.role)) continue;
    const path = resolve(opts.logsDir, name);
    try { const st = lstatSync(path); if (!st.isFile() || st.mtimeMs < since) continue; } catch { continue; }
    candidates.set(path, bundlePath("logs", name));
  }
  if (opts.logFile && existsSync(opts.logFile)) candidates.set(resolve(opts.logFile), bundlePath("logs", basename(opts.logFile)));
  if (opts.verdictHandoffPath) {
    try { if (lstatSync(opts.verdictHandoffPath).isFile() && statSync(opts.verdictHandoffPath).mtimeMs >= since) candidates.set(resolve(opts.verdictHandoffPath), bundlePath("handoff", basename(opts.verdictHandoffPath))); } catch { /* none written */ }
  }
  const ticketEvidence = resolve(opts.logsDir, "evidence", String(opts.issueNumber));
  for (const path of walk(ticketEvidence, since)) candidates.set(path, bundlePath("evidence", relative(ticketEvidence, path)));

  const files: Record<string, string> = {};
  const pointers: EvidencePointer[] = [];
  const index: Array<{ path: string; source: string; bytes: number; included: "whole" | "tail" | "pointer" }> = [];
  let omitted = 0;
  // The index is bounded like the pointers, so run.json stays small.
  const note = (path: string, source: string, bytes: number, included: "whole" | "tail" | "pointer") => {
    if (index.length < limits.files + limits.pointers) index.push({ path, source, bytes, included }); else omitted++;
  };
  // Two sources can sanitise to one name, or one name can be another's folder.
  const used = new Set<string>(["run.json", "pointers.json", "SHA256SUMS"]);
  const claim = (wanted: string): string => {
    let path = wanted;
    const clash = (p: string) => used.has(p) || [...used].some(u => u.startsWith(p + "/") || p.startsWith(u + "/"));
    // On a clash, flatten into the top folder (logs, evidence, handoff), which is never a file.
    const top = wanted.split("/")[0], hash = createHash("sha256").update(wanted).digest("hex").slice(0, 8);
    for (let n = 1; clash(path) && n < 10_000; n++) path = `${top}/${n}-${hash}-${basename(wanted).slice(-180)}`;
    used.add(path);
    return path;
  };
  // Room for run.json, pointers.json and SHA256SUMS, each bounded above.
  let budget = limits.bundleBytes - 512 * KIB;
  const ordered = [...candidates.entries()].map(([source, path]) => [path, source] as const)
    .sort((a, b) => priority(a[0]) - priority(b[0]) || a[0].localeCompare(b[0]));
  const point = async (source: string, size: number, modified: number, reason: string) => {
    if (pointers.length >= limits.pointers) return;
    let digest: string | null = null;
    if (size <= limits.hashBytes) { try { digest = await hashFile(source); } catch { digest = null; } }
    pointers.push({ machine: opts.machine, path: source, bytes: size, sha256: digest, modified, reason });
  };
  for (const [path, source] of ordered) {
    let st;
    try { st = statSync(source); } catch { continue; }
    const size = st.size, modified = Math.round(st.mtimeMs);
    const report = /\.(?:xml|json)$/i.test(source);
    const whole = size <= (report ? limits.reportBytes : limits.wholeBytes);
    let raw: Buffer;
    try { raw = whole ? readFileSync(source) : readTail(source, size, limits.tailBytes + TAIL_MARGIN); } catch { await point(source, size, modified, "unreadable"); note(path, source, size, "pointer"); continue; }
    if (raw.subarray(0, 8192).includes(0)) { await point(source, size, modified, "binary"); note(path, source, size, "pointer"); continue; }
    // A tail read starts mid-file: begin at a line start before redacting, so
    // a credential the read cut into is dropped rather than kept without the
    // prefix that identifies it. Then redact, then cut again at a line start.
    const lines = whole ? raw : fromLineStart(raw);
    const agentLog = AGENT_LOG.test(basename(source));
    const decoded = lines === null ? null : (agentLog ? stripPromptSections : (t: string) => t)(whole ? lines.toString("utf8") : dropOrphanKeyTail(lines.toString("utf8")));
    const text = decoded === null ? null : whole ? redact(decoded) : tailText(redact(decoded), limits.tailBytes);
    if (text === null) { await point(source, size, modified, "one long line: no safe place to cut a tail"); note(path, source, size, "pointer"); continue; }
    const bytes = Buffer.byteLength(text);
    if (bytes > budget || Object.keys(files).length >= limits.files - 3) {
      await point(source, size, modified, "over the bundle budget");
      note(path, source, size, "pointer");
      continue;
    }
    const target = claim(whole ? path : `${path}.tail`);
    files[target] = text;
    budget -= bytes;
    note(target, source, size, whole ? "whole" : "tail");
    if (!whole) await point(source, size, modified, `longer than ${Math.round(limits.tailBytes / KIB)} KiB; the bundle holds the tail`);
  }
  const ticket = `${opts.project}#${opts.issueNumber}`;
  const meta: EvidenceMeta = { kind: opts.kind, role: opts.role, outcome: opts.outcome, startedAt: Math.round(opts.startedAt), endedAt: Math.round(opts.endedAt),
    ...(opts.dispatcherRevision && /^[a-f0-9]{40}$/.test(opts.dispatcherRevision) ? { dispatcherRevision: opts.dispatcherRevision } : {}) };
  files["run.json"] = redact(JSON.stringify({ ticket, runId: opts.runId, machine: opts.machine, ...meta,
    files: index.map(i => ({ path: i.path, source: i.source, bytes: i.bytes, included: i.included })), ...(omitted ? { omittedFiles: omitted } : {}) }));
  files["pointers.json"] = redact(JSON.stringify(pointers));
  files["SHA256SUMS"] = Object.keys(files).sort().map(p => `${sha256(Buffer.from(files[p]))}  ${p}`).join("\n") + "\n";
  return { version: 1, ticket, runId: opts.runId, meta, files };
}

/** Upload one bundle: begin, the missing chunks, commit. Throws on any failure. */
export async function uploadEvidenceBundle(connection: EvidenceConnection, bundle: EvidenceBundle): Promise<{ digest: string }> {
  let manifest: ArtifactManifest;
  // A bundle this computer cannot even describe never becomes valid by waiting.
  try { manifest = artifactManifest(bundle.files); }
  catch (error) { throw new Error(`Invalid evidence bundle: ${error instanceof Error ? error.message : error}`); }
  const begun = await connection.call<{ digest: string; committed: boolean; missing: Record<string, number[]> }>("/evidence/begin",
    { ticket: bundle.ticket, runId: bundle.runId, meta: bundle.meta, manifest });
  if (!begun.committed) {
    for (const file of manifest.files) {
      const data = Buffer.from(bundle.files[file.path]);
      for (const part of begun.missing[file.path] ?? []) {
        await connection.call("/evidence/put", { ticket: bundle.ticket, runId: bundle.runId, digest: begun.digest, path: file.path, part,
          data: data.subarray(part * ARTIFACT_LIMITS.chunkBytes, (part + 1) * ARTIFACT_LIMITS.chunkBytes).toString("base64") });
      }
    }
    await connection.call("/evidence/commit", { ticket: bundle.ticket, runId: bundle.runId, digest: begun.digest });
  }
  return { digest: begun.digest };
}

/** A refusal no retry can change: the bundle itself is wrong. Anything else is retried. */
export function permanentEvidenceRefusal(message: string): boolean {
  if (message.startsWith("Invalid evidence bundle:")) return true;
  return /Service (?:409|422)/.test(message) && /Invalid evidence|exceeds the per-bundle cap|too many files|already committed|credential-shaped|Evidence run owner mismatch|Evidence project mismatch|Invalid artifact|not exact UTF-8/.test(message);
}

export interface OutboxLimits { files: number; bytes: number; ageMs: number }
/** Per dispatcher: five project dispatchers on one computer keep at most 640 MiB waiting. */
export const DEFAULT_OUTBOX_LIMITS: OutboxLimits = { files: 500, bytes: 128 * MIB, ageMs: 7 * 24 * 60 * 60 * 1000 };

/**
 * One dispatcher's evidence: record a run into the outbox, then upload in the
 * background. Every method logs and returns; none throws.
 */
export class RunEvidence {
  private flushing: Promise<void> | undefined;
  private lastFlush = 0;
  private quietUntil = 0;
  private warned = 0;
  readonly outbox: string;
  constructor(private readonly opts: {
    connection: EvidenceConnection; project: string; logsDir: string; machine: () => string | undefined;
    dispatcherRevision?: string; limits?: RunEvidenceLimits; outbox?: string; outboxLimits?: OutboxLimits;
    now?: () => number; log?: (message: string) => void;
    /** The claim service's per-bundle cap, from its snapshot. A bundle is sized under it. */
    storeBundleBytes?: () => number | undefined;
  }) {
    this.outbox = opts.outbox ?? resolve(opts.logsDir, "evidence-outbox");
  }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private log(message: string): void { (this.opts.log ?? console.warn)(message); }

  /** Gather and spool one run's bundle, then start an upload. Resolves when the bundle is safe on local disk. */
  async record(input: RunEvidenceInput): Promise<string | null> {
    try {
      const limits = { ...(this.opts.limits ?? DEFAULT_RUN_EVIDENCE_LIMITS) };
      const cap = this.opts.storeBundleBytes?.();
      if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) limits.bundleBytes = Math.min(limits.bundleBytes, cap - 64 * KIB);
      const bundle = await collectRunEvidence({ ...input, project: this.opts.project, machine: this.opts.machine() ?? "unknown", logsDir: this.opts.logsDir,
        dispatcherRevision: this.opts.dispatcherRevision, limits });
      mkdirSync(this.outbox, { recursive: true, mode: 0o700 });
      chmodSync(this.outbox, 0o700);
      const name = `${String(input.endedAt).padStart(14, "0")}-${input.issueNumber}-${createHash("sha256").update(input.runId).digest("hex").slice(0, 16)}.json`;
      const target = resolve(this.outbox, name), temporary = `${target}.tmp`;
      writeFileSync(temporary, JSON.stringify(bundle), { mode: 0o600 });
      renameSync(temporary, target);
      this.prune();
      void this.flush(true);
      return target;
    } catch (error) {
      this.log(`   ⚠️  Run evidence for #${input.issueNumber} (${input.role}) not recorded: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }
  /** Bundles waiting in the outbox, oldest first. */
  pending(): string[] {
    try { return readdirSync(this.outbox).filter(n => n.endsWith(".json")).sort().map(n => resolve(this.outbox, n)); } catch { return []; }
  }
  private prune(): void {
    const limits = this.opts.outboxLimits ?? DEFAULT_OUTBOX_LIMITS;
    // A spool write a crash interrupted.
    try {
      for (const name of readdirSync(this.outbox)) {
        if (!name.endsWith(".tmp")) continue;
        const path = resolve(this.outbox, name);
        try { if (this.now() - statSync(path).mtimeMs > 3600_000) unlinkSync(path); } catch { /* next time */ }
      }
    } catch { /* no outbox yet */ }
    const entries = this.pending().map(path => { try { const st = statSync(path); return { path, bytes: st.size, mtime: st.mtimeMs }; } catch { return null; } })
      .filter((e): e is { path: string; bytes: number; mtime: number } => e !== null);
    let total = entries.reduce((n, e) => n + e.bytes, 0), count = entries.length;
    for (const e of entries) {
      if (count <= limits.files && total <= limits.bytes && this.now() - e.mtime <= limits.ageMs) continue;
      try { unlinkSync(e.path); count--; total -= e.bytes; this.log(`   ⚠️  Run evidence outbox full or stale: dropped ${basename(e.path)} without uploading it`); } catch { /* retried next time */ }
    }
  }
  /** Retry the outbox now and then: at most once a minute unless forced. */
  maybeFlush(): void {
    if (this.now() - this.lastFlush < 60_000 || this.now() < this.quietUntil) return;
    void this.flush();
  }
  /** Upload waiting bundles oldest first; stop at the first one the service cannot take now. */
  flush(force = false): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!force && this.now() < this.quietUntil) return Promise.resolve();
    this.lastFlush = this.now();
    this.flushing = (async () => {
      for (const path of this.pending()) {
        let bundle: EvidenceBundle;
        try { bundle = JSON.parse(readFileSync(path, "utf8")); }
        catch { try { unlinkSync(path); } catch {} continue; }
        try {
          await uploadEvidenceBundle(this.opts.connection, bundle);
          try { unlinkSync(path); } catch {}
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (permanentEvidenceRefusal(message)) {
            this.log(`   ⚠️  Run evidence for ${bundle.ticket} refused, dropped: ${message.slice(0, 300)}`);
            try { unlinkSync(path); } catch {}
            continue;
          }
          // A service or manager that predates the store, or one that is down:
          // keep everything and wait before asking again.
          this.quietUntil = this.now() + (/Unknown operation|Service 404/.test(message) ? 10 * 60_000 : 60_000);
          if (this.now() - this.warned >= 10 * 60_000) {
            this.warned = this.now();
            this.log(`   ⚠️  Run evidence upload waiting (${this.pending().length} bundle(s) kept for retry): ${message.slice(0, 300)}`);
          }
          break;
        }
      }
    })().catch(error => { this.log(`   ⚠️  Run evidence flush failed: ${error instanceof Error ? error.message : error}`); })
      .finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
}

// --------- Reading the store ---------

export interface EvidenceListing {
  bundles: Array<{ ticket: string; runId: string; machine: string; role: string; meta: EvidenceMeta; created: number; committed: number; digest: string; totalBytes: number; manifest: ArtifactManifest }>;
}

/** Read one whole file of a committed bundle, verified chunk by chunk and in full. */
export async function readEvidenceFile(connection: EvidenceConnection, bundle: EvidenceListing["bundles"][number], path: string, fromPart = 0): Promise<string> {
  const file = bundle.manifest.files.find(f => f.path === path);
  if (!file) throw new Error("No such evidence file");
  const parts: Buffer[] = [];
  for (let part = Math.max(0, fromPart); part < file.chunks.length; part++) {
    const reply = await connection.call<{ digest: string; path: string; part: number; sha256: string; data: string }>("/evidence/chunk",
      { ticket: bundle.ticket, runId: bundle.runId, digest: bundle.digest, path, part });
    const data = Buffer.from(reply.data, "base64");
    if (reply.digest !== bundle.digest || reply.path !== path || reply.part !== part || sha256(data) !== file.chunks[part]) throw new Error("Evidence chunk identity or hash mismatch");
    parts.push(data);
  }
  const data = Buffer.concat(parts);
  if (fromPart === 0 && sha256(data) !== file.sha256) throw new Error("Evidence file hash mismatch");
  return data.toString("utf8");
}

/**
 * Bounded excerpts of a ticket's newest bundles for a recovery assessment:
 * each bundle's metadata and file list, then the tails of its most telling
 * files in priority order, until the character budget is spent. Untrusted
 * evidence, like every other input to the assessment. Null when the store
 * cannot be read.
 */
export async function evidenceExcerpts(connection: EvidenceConnection, ticket: string, budget = { bundles: 6, characters: 48_000, perFile: 12_000 }, deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs;
  let listing: EvidenceListing;
  try { listing = await connection.call<EvidenceListing>("/evidence/list", { ticket }); } catch { return null; }
  let remaining = budget.characters;
  const out = [];
  for (const bundle of listing.bundles.slice(0, budget.bundles)) {
    const excerpts: Record<string, string> = {};
    const files = bundle.manifest.files.filter(f => f.path !== "SHA256SUMS")
      .sort((a, b) => priority(a.path) - priority(b.path) || (a.path === "run.json" ? -1 : 0));
    let reads = 0;
    for (const file of files) {
      // Eight reads a bundle bound the calls; the character budget bounds the size.
      // The assessment holds its place while this runs, so it stops at a deadline too.
      if (remaining <= 0 || reads >= 8 || file.path === "run.json" || Date.now() >= deadline) continue;
      if (priority(file.path) > 5 && !/\.(?:log|tail|txt|json|xml)$/.test(file.path)) continue;
      try {
        reads++;
        // The last chunk, and the one before when the last is too short for an excerpt.
        const last = file.chunks.length - 1, lastBytes = file.bytes - Math.max(0, last) * ARTIFACT_LIMITS.chunkBytes;
        const text = await readEvidenceFile(connection, bundle, file.path, Math.max(0, lastBytes < budget.perFile ? last - 1 : last));
        const excerpt = text.slice(-Math.min(budget.perFile, remaining));
        if (!excerpt.trim()) continue;
        excerpts[file.path] = redact(excerpt);
        remaining -= excerpt.length;
      } catch { excerpts[file.path] = "unreadable"; }
    }
    out.push({ runId: bundle.runId, machine: bundle.machine, role: bundle.role, meta: bundle.meta, created: bundle.created,
      fileCount: bundle.manifest.files.length, files: bundle.manifest.files.slice(0, 60).map(f => ({ path: f.path, bytes: f.bytes })), excerpts });
  }
  return { ticket, bundleCount: listing.bundles.length, bundles: out };
}
