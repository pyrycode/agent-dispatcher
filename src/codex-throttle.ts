// Fleet-wide Codex rate-limit throttle, kept by the claim service.
//
// On 2026-10-14 Codex runs across the fleet failed with
// `exceeded retry limit, last status: 429 Too Many Requests` seconds into
// their first turn: pyrybox at 10:07:56, 15:34:56, 15:34:58, 15:36:42 and
// 16:06:51 EEST, Fractal at 11:07. The 15:34 cluster came when the
// dispatchers restarted together after a token rotation and started their
// Codex runs at the same moment. Each dispatcher retried on its own schedule,
// so nothing stopped the next start from meeting the same limit.
//
// The rule, decided by the owner. There is no fixed per-minute cap:
//   - Any Codex run anywhere reporting a 429 pauses NEW Codex admissions
//     fleet-wide for two minutes. Runs already admitted are untouched, and
//     work that runs no Codex agent (merges, live gates, housekeeping, Claude
//     roles) is admitted as usual.
//   - A 429 during a pause, or after it before any Codex run has started
//     cleanly, means the limit has not cleared: the next pause doubles,
//     2, 4, 8, 16 then 30 minutes, the ceiling.
//   - A Codex run admitted after the latest pause began that gets a model
//     response resets the backoff to two minutes.
//   - A 429 more than one ceiling after the last pause ended, with no clean
//     start in between because nothing started, counts as a fresh one.
//
// The state is one SQLite row, so a claim service restart keeps a pause. Each
// pause start and end is logged once and kept in a short event list.
//
// Start spacing, added the same evening. 429s kept coming with only three
// Codex runs in flight while the plan still showed two thirds left, which
// points at a tokens-per-minute limit rather than the plan's allowance. A
// Codex run's first turns are its largest requests, so several starting in
// the same minute is the burst that meets that limit. The claim service
// therefore admits at most one new Codex start per `startSpacingMs` across the
// fleet, default 20 seconds. A held offer is refused, not reserved, so it
// occupies no place, and non-Codex work is admitted as usual.
import type { DatabaseSync } from "node:sqlite";
import type { RunnerPolicy, StartRequest } from "./fleet-store.js";

export interface CodexThrottleConfig {
  /** First pause. Default two minutes. */
  baseMs: number;
  /** Longest pause. Default thirty minutes. */
  ceilingMs: number;
  /** False turns the throttle off: reports are recorded, nothing pauses. */
  enabled: boolean;
  /**
   * Least time between two Codex admissions anywhere in the fleet. Default 20
   * seconds; 0 turns spacing off. Independent of `enabled`.
   */
  startSpacingMs: number;
}
export const DEFAULT_CODEX_START_SPACING_MS = 20_000;
export const DEFAULT_CODEX_THROTTLE: CodexThrottleConfig = { baseMs: 2 * 60_000, ceilingMs: 30 * 60_000, enabled: true, startSpacingMs: DEFAULT_CODEX_START_SPACING_MS };

/** Read `codexThrottle` from the claim service configuration. */
export function readCodexThrottleConfig(raw: unknown): CodexThrottleConfig {
  if (raw === undefined) return DEFAULT_CODEX_THROTTLE;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("codexThrottle must be an object");
  const value = raw as Record<string, unknown>;
  const unknown = Object.keys(value).filter(k => !["baseSeconds", "ceilingSeconds", "enabled", "startSpacingSeconds"].includes(k));
  if (unknown.length) throw new Error(`codexThrottle has unknown settings: ${unknown.join(", ")}`);
  const seconds = (key: string, fallback: number): number => {
    const v = value[key];
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 10 || v > 24 * 3600) throw new Error(`codexThrottle.${key} must be a number of seconds between 10 and 86400`);
    return Math.round(v * 1000);
  };
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("codexThrottle.enabled must be true or false");
  const baseMs = seconds("baseSeconds", DEFAULT_CODEX_THROTTLE.baseMs);
  const ceilingMs = seconds("ceilingSeconds", DEFAULT_CODEX_THROTTLE.ceilingMs);
  if (ceilingMs < baseMs) throw new Error("codexThrottle.ceilingSeconds must be at least baseSeconds");
  const spacing = value.startSpacingSeconds;
  if (spacing !== undefined && (typeof spacing !== "number" || !Number.isFinite(spacing) || spacing < 0 || spacing > 300)) {
    throw new Error("codexThrottle.startSpacingSeconds must be a number of seconds between 0 and 300");
  }
  return { baseMs, ceilingMs, enabled: value.enabled !== false,
    startSpacingMs: spacing === undefined ? DEFAULT_CODEX_START_SPACING_MS : Math.round(spacing * 1000) };
}

/**
 * Roles that never start a model agent. An offer from a dispatcher that does
 * not state its runner is judged by role: anything else is an agent role and
 * follows the central runner choice.
 */
export const NON_AGENT_ROLES: ReadonlySet<string> = new Set(["merge", "reconcile", "codegraph", "main-sweep", "real-claude-gate"]);

/**
 * True when admitting this request would start a Codex agent.
 *
 * The central choice wins when one is set, as it does for the run itself.
 * Otherwise the dispatcher's own stated runner decides. A request with
 * neither is unknown and is never paused. A support task runs Codex only for
 * the `dispatcher-repair` recipe, and only under the central choice.
 */
export function startsCodex(req: Pick<StartRequest, "role" | "runner">, policy: RunnerPolicy | undefined, recipe?: string): boolean {
  if (req.role === "recovery-task") return recipe === "dispatcher-repair" && policy?.runner === "codex";
  if (req.runner === undefined && NON_AGENT_ROLES.has(req.role)) return false;
  return (policy?.runner ?? req.runner) === "codex";
}

export interface CodexReportSource { machine: string; project: string; ticket: string; role: string; runId: string; admittedAt: number }
export interface CodexPauseState {
  /** True while new Codex admissions are refused. */
  active: boolean;
  /** When the current or last pause began and ends, epoch ms. */
  since: number | null;
  until: number | null;
  /** Length of the current or last pause. */
  durationMs: number;
  /** Length the next pause will have if a 429 arrives before a clean start. */
  nextDurationMs: number;
  /** Pauses in a row with no clean start between them. */
  level: number;
  /** The current pause is the ceiling: the limit has not cleared through the whole backoff. */
  atCeiling: boolean;
  /** 429 reports received since the current or last pause began. */
  reports: number;
  /** The report that began the current or last pause. */
  cause: Omit<CodexReportSource, "admittedAt"> | null;
  lastCleanAt: number | null;
  remainingSeconds: number;
  enabled: boolean;
  /** In a report's answer only: 429s on the reported run's ticket since that ticket last started Codex cleanly. */
  ticketReports?: number;
}

/**
 * How many 429s in a row one ticket may wait out without counting against
 * it. A ticket that keeps meeting a 429 while other tickets start cleanly
 * has a limit of its own, such as an oversized request, and must not retry
 * uncounted forever, pausing the whole fleet each time. Past this it takes
 * the ordinary capped transient retry.
 */
export const CODEX_UNCOUNTED_PER_TICKET = 4;

/** True when a reported 429 may wait for the pause without counting against its ticket. */
export function rateLimitWaitsUncounted(state: CodexPauseState | null | undefined): boolean {
  return state?.active === true && (state.ticketReports ?? 1) <= CODEX_UNCOUNTED_PER_TICKET;
}
/** The fleet's Codex start spacing, as `operator.sh codex` and the snapshot show it. */
export interface CodexSpacingState {
  spacingSeconds: number;
  /** True while a new Codex start would be refused for spacing. */
  held: boolean;
  /** Time until the next Codex start may be admitted, rounded up. */
  remainingSeconds: number;
  lastStartAt: number | null;
  nextStartAt: number | null;
  /** The last admitted Codex start. */
  lastStart: { machine: string; ticket: string; role: string } | null;
  /** Codex starts refused for spacing since the last admitted one. */
  heldSinceLastStart: number;
  /** Codex starts admitted in the last hour, from the kept start history. */
  startsLastHour: number;
}
export interface CodexThrottleEvent { at: number; kind: "pause-started" | "pause-ended" | "rate-limited" | "reset" | "cleared"; detail: string }

const EVENTS_KEPT = 200;

export class CodexThrottle {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now,
    readonly config: CodexThrottleConfig = DEFAULT_CODEX_THROTTLE, private readonly log: (line: string) => void = line => console.log(line)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_codex_throttle (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        level INTEGER NOT NULL, since INTEGER, until INTEGER, duration INTEGER NOT NULL,
        ended INTEGER NOT NULL, reports INTEGER NOT NULL, cause TEXT, last_clean INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_codex_ticket_reports (
        ticket TEXT PRIMARY KEY, reports INTEGER NOT NULL, updated INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_codex_throttle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_codex_starts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, machine TEXT NOT NULL, ticket TEXT NOT NULL, role TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fleet_codex_spacing (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), held INTEGER NOT NULL
      ) STRICT;
    `);
  }

  private lastStart(): { at: number; machine: string; ticket: string; role: string } | undefined {
    const r = this.db.prepare("SELECT at,machine,ticket,role FROM fleet_codex_starts ORDER BY id DESC LIMIT 1").get();
    return r ? { at: Number(r.at), machine: String(r.machine), ticket: String(r.ticket), role: String(r.role) } : undefined;
  }
  /**
   * Milliseconds until the next Codex start may be admitted, or 0. A start
   * recorded in the future, as after the clock steps back, holds nothing, so
   * spacing can never stall Codex until the clock catches up.
   */
  spacingWaitMs(t = this.now()): number {
    const spacing = this.config.startSpacingMs;
    const last = this.lastStart();
    if (!spacing || !last || last.at > t) return 0;
    return Math.max(0, last.at + spacing - t);
  }
  /** A Codex start refused for spacing. Counted for status only, never logged one by one. */
  spacingHeld(): void {
    this.db.prepare("INSERT INTO fleet_codex_spacing VALUES (1,1) ON CONFLICT(singleton) DO UPDATE SET held=held+1").run();
  }
  /** A Codex start was admitted. Called inside the admitting transaction. */
  started(source: { machine: string; ticket: string; role: string }, t = this.now()): void {
    this.db.prepare("INSERT INTO fleet_codex_starts (at,machine,ticket,role) VALUES (?,?,?,?)").run(t, source.machine, source.ticket, source.role);
    this.db.prepare("DELETE FROM fleet_codex_starts WHERE id <= (SELECT max(id) FROM fleet_codex_starts) - ?").run(EVENTS_KEPT);
    this.db.prepare("INSERT INTO fleet_codex_spacing VALUES (1,0) ON CONFLICT(singleton) DO UPDATE SET held=0").run();
  }
  spacingState(t = this.now()): CodexSpacingState {
    const last = this.lastStart();
    const wait = this.spacingWaitMs(t);
    const held = this.db.prepare("SELECT held FROM fleet_codex_spacing WHERE singleton=1").get();
    return {
      spacingSeconds: this.config.startSpacingMs / 1000, held: wait > 0, remainingSeconds: Math.ceil(wait / 1000),
      lastStartAt: last?.at ?? null, nextStartAt: last && this.config.startSpacingMs ? t + wait : null,
      lastStart: last ? { machine: last.machine, ticket: last.ticket, role: last.role } : null,
      heldSinceLastStart: held ? Number(held.held) : 0,
      startsLastHour: Number(this.db.prepare("SELECT count(*) AS n FROM fleet_codex_starts WHERE at > ?").get(t - 3600_000)!.n),
    };
  }
  /** Recent admitted Codex starts, newest first. */
  starts(limit = 20): Array<{ at: number; machine: string; ticket: string; role: string }> {
    return this.db.prepare("SELECT at,machine,ticket,role FROM fleet_codex_starts ORDER BY id DESC LIMIT ?").all(limit)
      .map(r => ({ at: Number(r.at), machine: String(r.machine), ticket: String(r.ticket), role: String(r.role) }));
  }

  private row(): { level: number; since: number | null; until: number | null; duration: number; ended: boolean; reports: number; cause: CodexPauseState["cause"]; lastClean: number | null } | undefined {
    const r = this.db.prepare("SELECT * FROM fleet_codex_throttle WHERE singleton=1").get();
    if (!r) return undefined;
    return { level: Number(r.level), since: r.since === null ? null : Number(r.since), until: r.until === null ? null : Number(r.until),
      duration: Number(r.duration), ended: Number(r.ended) === 1, reports: Number(r.reports), cause: r.cause ? JSON.parse(String(r.cause)) : null,
      lastClean: r.last_clean === null ? null : Number(r.last_clean) };
  }
  private save(r: NonNullable<ReturnType<CodexThrottle["row"]>>): void {
    this.db.prepare(`INSERT INTO fleet_codex_throttle VALUES (1,?,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
      level=excluded.level,since=excluded.since,until=excluded.until,duration=excluded.duration,ended=excluded.ended,
      reports=excluded.reports,cause=excluded.cause,last_clean=excluded.last_clean`)
      .run(r.level, r.since, r.until, r.duration, r.ended ? 1 : 0, r.reports, r.cause ? JSON.stringify(r.cause) : null, r.lastClean);
  }
  private event(kind: CodexThrottleEvent["kind"], detail: string, at: number): void {
    this.db.prepare("INSERT INTO fleet_codex_throttle_events (at,kind,detail) VALUES (?,?,?)").run(at, kind, detail);
    this.db.prepare("DELETE FROM fleet_codex_throttle_events WHERE id <= (SELECT max(id) FROM fleet_codex_throttle_events) - ?").run(EVENTS_KEPT);
    this.log(`Codex throttle: ${kind}: ${detail}`);
  }
  /** Pause length for a level: base doubled per level, never above the ceiling. */
  durationFor(level: number): number {
    return Math.min(this.config.ceilingMs, this.config.baseMs * 2 ** Math.min(Math.max(0, level), 30));
  }
  /** The level a 429 at `t` pauses at, after any reset for a long quiet gap. */
  private levelAt(r: ReturnType<CodexThrottle["row"]>, t: number): number {
    if (!r) return 0;
    if (r.until !== null && t - r.until > this.config.ceilingMs) return 0;
    return r.level;
  }

  paused(t = this.now()): boolean {
    if (!this.config.enabled) return false;
    const r = this.row();
    return !!r && r.until !== null && t < r.until;
  }

  /** Log a pause that has run out, once, even across restarts. Called on a timer and before each change. */
  tick(t = this.now()): void {
    const r = this.row();
    if (!r || r.ended || r.until === null || t < r.until) return;
    r.ended = true;
    this.save(r);
    this.event("pause-ended", `New Codex runs admitted again after a ${minutes(r.duration)} pause (${r.reports} rate-limit report${r.reports === 1 ? "" : "s"}). The next 429 before a clean start pauses ${minutes(this.durationFor(r.level))}.`, r.until);
  }

  /** A Codex run hit a rate limit. Returns the state after it. */
  rateLimited(source: CodexReportSource): CodexPauseState {
    const t = this.now();
    this.tick(t);
    this.db.prepare("DELETE FROM fleet_codex_ticket_reports WHERE updated < ?").run(t - 7 * 86400_000);
    const r = this.row();
    // A 429 counts towards the ticket's own run only when some Codex run got
    // through since its previous one. During an account-wide limit nothing
    // starts cleanly anywhere, and no ticket should pay for that.
    const previous = this.db.prepare("SELECT reports,updated FROM fleet_codex_ticket_reports WHERE ticket=?").get(source.ticket);
    const ticketReports = !previous ? 1
      : r?.lastClean != null && r.lastClean > Number(previous.updated) ? Number(previous.reports) + 1 : Number(previous.reports);
    this.db.prepare(`INSERT INTO fleet_codex_ticket_reports VALUES (?,?,?)
      ON CONFLICT(ticket) DO UPDATE SET reports=excluded.reports, updated=excluded.updated`).run(source.ticket, ticketReports, t);
    const where = `${source.role} on ${source.ticket} (${source.machine})`;
    const counted = ticketReports > CODEX_UNCOUNTED_PER_TICKET ? ` That is ${ticketReports} 429s in a row on this ticket, so this one counts against it.` : "";
    if (r && r.until !== null && t < r.until) {
      r.reports++;
      this.save(r);
      this.event("rate-limited", `429 from ${where} during the current pause; the next pause is ${minutes(this.durationFor(r.level))}.${counted}`, t);
      return { ...this.state(t), ticketReports };
    }
    if (!this.config.enabled) {
      this.event("rate-limited", `429 from ${where}; the throttle is off, so nothing paused.`, t);
      return { ...this.state(t), ticketReports };
    }
    const level = this.levelAt(r, t);
    const duration = this.durationFor(level);
    const { admittedAt: _admitted, ...cause } = source;
    this.save({ level: Math.min(level + 1, 30), since: t, until: t + duration, duration, ended: false, reports: 1, cause, lastClean: r?.lastClean ?? null });
    this.event("pause-started", `429 from ${where}. New Codex runs are paused fleet-wide for ${minutes(duration)}, until ${new Date(t + duration).toISOString()}${duration >= this.config.ceilingMs ? "; this is the ceiling" : ""}.${counted}`, t);
    return { ...this.state(t), ticketReports };
  }

  /**
   * A Codex run got a model response. Only a run admitted after the latest
   * pause began proves the limit has cleared; an older run that kept going
   * says nothing about new starts.
   */
  clean(source: CodexReportSource): CodexPauseState {
    const t = this.now();
    this.tick(t);
    // The ticket itself got through, so its own run of 429s is over.
    this.db.prepare("DELETE FROM fleet_codex_ticket_reports WHERE ticket=?").run(source.ticket);
    const r = this.row();
    if (!r) return this.state(t);
    // Any clean start shows Codex is getting through, which the per-ticket count reads.
    r.lastClean = t;
    // A run admitted in the pause's first millisecond was admitted before it:
    // from then on Codex admissions are refused until the pause ends.
    if (r.level === 0 || (r.until !== null && t < r.until) || (r.since !== null && source.admittedAt <= r.since)) { this.save(r); return this.state(t); }
    r.level = 0;
    this.save(r);
    this.event("reset", `${source.role} on ${source.ticket} (${source.machine}) started Codex cleanly; the next pause is back to ${minutes(this.durationFor(0))}.`, t);
    return this.state(t);
  }

  /** Operator: end the current pause and reset the backoff. */
  clear(): CodexPauseState {
    const t = this.now();
    this.tick(t);
    const r = this.row();
    if (r) {
      const wasActive = r.until !== null && t < r.until;
      this.save({ ...r, level: 0, until: wasActive ? t : r.until, duration: wasActive ? t - (r.since ?? t) : r.duration, ended: true });
      this.event("cleared", wasActive ? "Operator ended the pause and reset the backoff." : "Operator reset the backoff.", t);
    }
    return this.state(t);
  }

  state(t = this.now()): CodexPauseState {
    const r = this.row();
    const active = this.config.enabled && !!r && r.until !== null && t < r.until;
    return {
      active, since: r?.since ?? null, until: r?.until ?? null, durationMs: r?.duration ?? 0,
      nextDurationMs: this.durationFor(this.levelAt(r, t)), level: r ? this.levelAt(r, t) : 0,
      atCeiling: active && r!.duration >= this.config.ceilingMs, reports: r?.reports ?? 0, cause: r?.cause ?? null,
      lastCleanAt: r?.lastClean ?? null, remainingSeconds: active ? Math.ceil((r!.until! - t) / 1000) : 0, enabled: this.config.enabled,
    };
  }
  /** Compact state for the fleet snapshot, or undefined before the first report. */
  snapshot(t = this.now()): CodexPauseState | undefined {
    return this.row() ? this.state(t) : undefined;
  }
  events(limit = 50): CodexThrottleEvent[] {
    return this.db.prepare("SELECT at,kind,detail FROM fleet_codex_throttle_events ORDER BY id DESC LIMIT ?").all(limit)
      .map(e => ({ at: Number(e.at), kind: e.kind as CodexThrottleEvent["kind"], detail: String(e.detail) }));
  }
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  return Number.isInteger(m) ? `${m} min` : `${Math.round(ms / 1000)} s`;
}

/** The attention item for a pause that has reached the ceiling, or null. */
export function codexPauseAttention(state: CodexPauseState | undefined | null): { kind: "codex-paused"; since: number | null; until: number | null; durationMs: number; reports: number; reason: string } | null {
  if (!state?.active || !state.atCeiling) return null;
  return { kind: "codex-paused", since: state.since, until: state.until, durationMs: state.durationMs, reports: state.reports,
    reason: `Codex rate limits have not cleared through the whole backoff: new Codex runs are paused fleet-wide for ${minutes(state.durationMs)}, `
      + `the ceiling. Check OpenAI usage for the account. Running work is untouched; \`operator.sh codex clear\` ends the pause early.` };
}

/** Default spread of a dispatcher's first Codex start after it starts. */
export const DEFAULT_CODEX_START_JITTER_MS = 60_000;

/**
 * `PYRY_CODEX_START_JITTER_MS`: the longest random wait before a dispatcher's
 * first Codex start after a restart. A fleet-wide restart, such as the
 * 2026-10-14 token rotation, otherwise starts every Codex run in the same
 * second. Unset means one minute; `0` turns it off; garbage keeps the
 * default; anything above five minutes is held at five.
 */
export function codexStartJitterMaxMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CODEX_START_JITTER_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CODEX_START_JITTER_MS;
  return Math.min(Math.round(n), 5 * 60_000);
}

/** No Codex run starts before this time, epoch ms. Process-wide: one dispatcher per process. */
let codexStartNotBefore = 0;
/** Set by the first arming, at dispatcher startup. Library use and tests never spread. */
let codexSpreadArmed = false;

/**
 * Pick a random time, up to `PYRY_CODEX_START_JITTER_MS` from now, before
 * which this dispatcher starts no Codex run. Armed at dispatcher startup and
 * again when a fleet pause ends, the two moments every dispatcher would
 * otherwise start Codex together. Each dispatcher draws its own.
 */
export function armCodexStartJitter(env: NodeJS.ProcessEnv = process.env, now = Date.now(), rng: () => number = Math.random): number {
  const delay = Math.floor(Math.min(1, Math.max(0, rng())) * codexStartJitterMaxMs(env.PYRY_CODEX_START_JITTER_MS));
  codexStartNotBefore = now + delay;
  codexSpreadArmed = true;
  return delay;
}
/** Re-arm after a fleet pause ends, only in a dispatcher that armed at startup. */
export function rearmCodexStartJitter(env: NodeJS.ProcessEnv = process.env): void {
  if (codexSpreadArmed) armCodexStartJitter(env);
}
/** Milliseconds this dispatcher still holds Codex starts for, or 0. */
export function codexStartHoldMs(now = Date.now()): number {
  return Math.max(0, codexStartNotBefore - now);
}
