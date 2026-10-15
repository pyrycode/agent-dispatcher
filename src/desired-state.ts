/**
 * Central desired state for each computer and each board (project) on it.
 *
 * The claims database holds what the operator wants: whether a computer or
 * board takes work, and whether a board's dispatcher runs. Managers fetch it
 * through their own outbound connection, keep the last copy in their private
 * configuration and apply it before they grant anything. The claim service
 * enforces the work state at admission as well, so a manager that is old or
 * behind cannot start work on a drained board. Supervisors read the run state
 * from their local manager and stop or start the dispatcher unit.
 *
 * Work states, from least to most restrictive:
 * - taking: normal admission.
 * - tickets-drained: no new tickets. Tickets this computer already owns keep
 *   going through every stage, and board housekeeping and support tasks still
 *   run. This is the older `drain-project` behaviour, kept so the persistent
 *   project drains could be imported unchanged.
 * - drained: no new grants at all on that computer or board. Running work
 *   finishes; its later stages wait.
 *
 * A board whose run state is `stopped` is treated as drained too, so a
 * dispatcher that starts anyway (a reboot starts its unit) gets no work
 * before its supervisor stops it again.
 */
import type { DatabaseSync } from "node:sqlite";
import { scrubCredentials } from "./agent-runtime.js";

export type WorkState = "taking" | "tickets-drained" | "drained";
export type RunState = "running" | "stopped";
export const WORK_STATES: readonly WorkState[] = ["taking", "tickets-drained", "drained"];
export const RUN_STATES: readonly RunState[] = ["running", "stopped"];
/** The project name of a computer-wide entry. Never a repository name. */
export const MACHINE_SCOPE = "*";
const PROJECT = /^[\w.-]+\/[\w.-]+$/;

export interface DesiredEntry {
  /** A repository, or MACHINE_SCOPE for the whole computer. */
  project: string;
  work?: WorkState;
  /** Boards only. Absent: the supervisor keeps its older behaviour for this board. */
  run?: RunState;
  /** The computer's document revision at which this entry last changed. */
  revision: number;
  /** Claim service time of the last change, in milliseconds. */
  updated: number;
  actor: string;
  reason?: string;
}
/** Everything one computer must apply. The revision rises with every change. */
export interface DesiredDocument { machine: string; revision: number; entries: DesiredEntry[] }

const RANK: Record<WorkState, number> = { taking: 0, "tickets-drained": 1, drained: 2 };
export function stricter(a: WorkState | undefined, b: WorkState | undefined): WorkState {
  const x = a ?? "taking", y = b ?? "taking";
  return RANK[x] >= RANK[y] ? x : y;
}
/**
 * The work state that applies to one board: the stricter of the computer's
 * entry and the board's own, and drained while the board is meant to be
 * stopped. A board entry saying `taking` cannot lift a computer-wide drain.
 */
export function effectiveWork(entries: readonly DesiredEntry[], project: string): WorkState {
  const machine = entries.find(e => e.project === MACHINE_SCOPE);
  const board = entries.find(e => e.project === project);
  return stricter(stricter(machine?.work, board?.work), board?.run === "stopped" ? "drained" : undefined);
}
export function desiredRun(entries: readonly DesiredEntry[], project: string): RunState | undefined {
  return entries.find(e => e.project === project)?.run;
}

/** The parts of an offer or start request the work state looks at. */
export interface AdmissionSubject { project: string; ticket: string; role: string; supportTaskId?: string; parentTicket?: string }
/**
 * Why this work state refuses the subject, or undefined when it admits it.
 * `ownsTicket` says whether this computer already holds the ticket's claim.
 * A support task is charged to the project of the ticket it serves as well
 * as the project it was offered under, so a drain of either holds it.
 */
export function workRefusal(work: (project: string) => WorkState, subject: AdmissionSubject, ownsTicket: boolean): "drained" | "tickets-drained" | undefined {
  const projects = [...new Set([subject.project, subject.parentTicket?.split("#")[0]].filter((p): p is string => !!p))];
  const states = projects.map(work);
  if (states.includes("drained")) return "drained";
  if (!states.includes("tickets-drained")) return undefined;
  const support = subject.role === "recovery-task" && !!subject.supportTaskId;
  const reconcile = subject.role === "reconcile" && subject.ticket === `${subject.project}#@reconcile`;
  const owned = /#[1-9]\d*$/.test(subject.ticket) && ownsTicket;
  return support || reconcile || owned ? undefined : "tickets-drained";
}

/** Validates a document received from the claim service. Throws on anything unexpected. */
export function validateDocument(value: unknown, machine: string): DesiredDocument {
  const doc = value as DesiredDocument;
  if (!doc || typeof doc !== "object" || doc.machine !== machine || !Number.isSafeInteger(doc.revision) || doc.revision < 0 || !Array.isArray(doc.entries) || doc.entries.length > 100) {
    throw new Error("Invalid desired state document");
  }
  const seen = new Set<string>();
  for (const e of doc.entries) {
    if (!e || typeof e.project !== "string" || (e.project !== MACHINE_SCOPE && !PROJECT.test(e.project)) || seen.has(e.project)
      || (e.work !== undefined && !WORK_STATES.includes(e.work)) || (e.run !== undefined && !RUN_STATES.includes(e.run))
      || (e.project === MACHINE_SCOPE && e.run !== undefined) || !Number.isSafeInteger(e.revision) || !Number.isFinite(e.updated)) {
      throw new Error("Invalid desired state entry");
    }
    seen.add(e.project);
  }
  return doc;
}

/** The fixed operator change set. Nothing else can be requested. */
export interface DesiredChange { work?: WorkState; run?: RunState }
export interface DesiredCommand { machines: string[] | "all"; project?: string; change: DesiredChange; reason?: string;
  /** A drain command never loosens a stricter drain unless this is set. */
  loosen?: boolean }

/**
 * Parse `drain|resume|stop|start` operator arguments. Returns undefined for a
 * bare `drain`, which keeps its older meaning: the local manager's in-memory
 * drain.
 */
export function parseDesiredCommand(command: string, args: readonly string[]): DesiredCommand | undefined {
  if (command === "drain" && args.length === 0) return undefined;
  const usage = `Usage: ${command} --machine MACHINE | --all-machines${command === "stop" || command === "start" ? " --project PROJECT" : " [--project PROJECT]"}${command === "drain" ? " [--tickets] [--loosen]" : ""} [--reason TEXT]`;
  let machine: string | undefined, all = false, project: string | undefined, tickets = false, reason: string | undefined, loosen = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = () => { const v = args[++i]; if (v === undefined || v.startsWith("--")) throw new Error(usage); return v; };
    if (flag === "--machine" && machine === undefined) machine = value();
    else if (flag === "--all-machines" && !all) all = true;
    else if (flag === "--project" && project === undefined) project = value();
    else if (flag === "--tickets" && command === "drain" && !tickets) tickets = true;
    else if (flag === "--reason" && reason === undefined) reason = value();
    else if (flag === "--loosen" && command === "drain" && !loosen) loosen = true;
    else throw new Error(usage);
  }
  if ((machine === undefined) === !all) throw new Error(usage);
  if ((command === "stop" || command === "start") && project === undefined) throw new Error(usage);
  if (project !== undefined && !PROJECT.test(project)) throw new Error("Project must be owner/repo");
  const change: DesiredChange = command === "drain" ? { work: tickets ? "tickets-drained" : "drained" }
    : command === "resume" ? { work: "taking" }
    : command === "stop" ? { run: "stopped" }
    : command === "start" ? { run: "running" } : (() => { throw new Error(usage); })();
  return { machines: all ? "all" : [machine!], ...(project ? { project } : {}), change, ...(reason ? { reason } : {}), ...(loosen ? { loosen } : {}) };
}

export type AckState = "applied" | "pending" | "failed";
export interface Ack { state: AckState; reason?: string }

/** A manager's report of what it has applied, sent with every fetch. */
export interface DesiredPoll {
  projects: string[];
  /** The document revision the manager has saved and applies. Null before its first one. */
  appliedRevision: number | null;
  /** The latest document it could not apply, and why. */
  applyError?: { revision: number; reason: string };
  /** Saved project drains from before central desired state, sent until they are imported. */
  localDrains?: string[];
  /**
   * The entries of the document the manager applies. When the claims
   * database is behind the applied revision, as after a restore, the claim
   * service merges them back in, never loosening anything, before any
   * revision moves past the applied one.
   */
  savedEntries?: Array<{ project: string; work?: WorkState; run?: RunState }>;
}

/** How long a change may stay unacknowledged before attention reports it. */
export const ACK_GRACE_MS = 2 * 60_000;
/** A manager that has not fetched for this long is reported as not polling. */
export const POLL_STALE_MS = 3 * 60_000;

/**
 * Table definitions. A rollout may create them ahead of the claim service,
 * to seed today's in-memory drains before managers restart; see
 * docs/machine-manager.md, "Central desired state".
 */
export const DESIRED_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS fleet_desired_state (
    machine TEXT NOT NULL, project TEXT NOT NULL,
    work TEXT CHECK(work IS NULL OR work IN ('taking','tickets-drained','drained')),
    run TEXT CHECK(run IS NULL OR run IN ('running','stopped')),
    revision INTEGER NOT NULL, updated INTEGER NOT NULL, actor TEXT NOT NULL, reason TEXT,
    PRIMARY KEY(machine, project)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS fleet_desired_revisions (machine TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS fleet_desired_polls (
    machine TEXT PRIMARY KEY, projects TEXT NOT NULL, applied INTEGER, apply_error TEXT, polled INTEGER NOT NULL
  ) STRICT;`;

interface OperationReport { machine: string; received: number; operations?: Array<{ project: string; phase: string; reason?: string }>; service?: string; reason?: string }

export class DesiredStateStore {
  constructor(private readonly db: DatabaseSync, private readonly machines: readonly string[], private readonly now: () => number,
    /** Projects a computer reported serving some other way, such as its capability report. */
    private readonly reportedProjects: (machine: string) => string[] | undefined = () => undefined) {
    db.exec(DESIRED_STATE_SCHEMA);
  }
  private known(machine: string): void {
    if (!this.machines.includes(machine)) throw new Error(`Unknown machine ${String(machine).slice(0, 100)}`);
  }
  entries(machine: string): DesiredEntry[] {
    return this.db.prepare("SELECT * FROM fleet_desired_state WHERE machine=? ORDER BY project").all(machine).map(r => ({
      project: String(r.project), ...(r.work !== null ? { work: r.work as WorkState } : {}), ...(r.run !== null ? { run: r.run as RunState } : {}),
      revision: Number(r.revision), updated: Number(r.updated), actor: String(r.actor), ...(r.reason !== null ? { reason: String(r.reason) } : {}),
    }));
  }
  document(machine: string): DesiredDocument {
    this.known(machine);
    const revision = Number(this.db.prepare("SELECT revision FROM fleet_desired_revisions WHERE machine=?").get(machine)?.revision ?? 0);
    return { machine, revision, entries: this.entries(machine) };
  }
  /** The work state the claim service enforces for one board. */
  work(machine: string, project: string): WorkState { return effectiveWork(this.entries(machine), project); }
  /** Projects the computer's manager last said it serves, from a desired state fetch or a capability report. */
  served(machine: string): string[] | undefined {
    const row = this.db.prepare("SELECT projects FROM fleet_desired_polls WHERE machine=?").get(machine);
    return row ? JSON.parse(String(row.projects)) as string[] : this.reportedProjects(machine);
  }
  private storedRevision(machine: string): number {
    return Number(this.db.prepare("SELECT revision FROM fleet_desired_revisions WHERE machine=?").get(machine)?.revision ?? 0);
  }
  /** The revision the computer's manager last said it applied, or 0. */
  private appliedRevision(machine: string): number {
    return Number(this.db.prepare("SELECT applied FROM fleet_desired_polls WHERE machine=?").get(machine)?.applied ?? 0);
  }
  private write(machine: string, project: string, change: DesiredChange, actor: string, reason?: string): DesiredEntry | undefined {
    const old = this.entries(machine).find(e => e.project === project);
    const work = change.work ?? old?.work, run = change.run ?? old?.run;
    if (old && old.work === work && old.run === run) return undefined;
    // Past what the manager last applied as well: after a database restore the
    // stored revision is behind it, and the manager keeps its saved document
    // until a change moves past it.
    const applied = Number(this.db.prepare("SELECT applied FROM fleet_desired_polls WHERE machine=?").get(machine)?.applied ?? 0);
    const revision = Math.max(Number(this.db.prepare("SELECT revision FROM fleet_desired_revisions WHERE machine=?").get(machine)?.revision ?? 0), applied) + 1;
    const updated = this.now();
    this.db.prepare("INSERT INTO fleet_desired_revisions VALUES (?,?) ON CONFLICT(machine) DO UPDATE SET revision=excluded.revision").run(machine, revision);
    this.db.prepare(`INSERT INTO fleet_desired_state VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(machine,project) DO UPDATE SET
      work=excluded.work,run=excluded.run,revision=excluded.revision,updated=excluded.updated,actor=excluded.actor,reason=excluded.reason`)
      .run(machine, project, work ?? null, run ?? null, revision, updated, actor, reason ?? null);
    return { project, ...(work ? { work } : {}), ...(run ? { run } : {}), revision, updated, actor, ...(reason ? { reason } : {}) };
  }
  /**
   * The operator's change. Only the fixed work and run values, only for
   * configured computers and for projects the computer's manager reported
   * serving. With `all`, computers that do not serve the project are skipped.
   * The caller holds the operator credential and a transaction.
   */
  set(command: DesiredCommand): { changed: Array<DesiredEntry & { machine: string }>; unchanged: string[]; skipped: string[]; notes: string[] } {
    const change = command?.change ?? {};
    if (Object.keys(change).some(k => k !== "work" && k !== "run") || (change.work === undefined) === (change.run === undefined)
      || (change.work !== undefined && !WORK_STATES.includes(change.work)) || (change.run !== undefined && !RUN_STATES.includes(change.run))) throw new Error("Change must set exactly one work or run state");
    const project = command.project;
    if (project !== undefined && (typeof project !== "string" || !PROJECT.test(project))) throw new Error("Project must be owner/repo");
    if (change.run !== undefined && project === undefined) throw new Error("Stop and start name a project");
    if (command.reason !== undefined && (typeof command.reason !== "string" || command.reason.length > 300)) throw new Error("Reason must be text of at most 300 characters");
    const reason = command.reason === undefined ? undefined : scrubCredentials(command.reason);
    const all = command.machines === "all";
    const targets = all ? [...this.machines] : command.machines;
    if (!Array.isArray(targets) || !targets.length || targets.length > 50) throw new Error("Name a machine or all machines");
    for (const m of targets) this.known(m);
    const changed: Array<DesiredEntry & { machine: string }> = [], unchanged: string[] = [], skipped: string[] = [], notes: string[] = [];
    const behindNote = (m: string) => `${m}: its manager applied a newer desired state than this database holds, as after a restore. Its next fetch, within 15 seconds, merges that state back in; retry then.`;
    const behind = targets.filter(m => this.appliedRevision(m) > this.storedRevision(m));
    if (behind.length && !all) throw new Error(behind.map(behindNote).join(" "));
    for (const machine of targets) {
      if (behind.includes(machine)) { skipped.push(machine); notes.push(behindNote(machine)); continue; }
      if (project !== undefined) {
        const served = this.served(machine);
        if (!served?.includes(project)) {
          if (all) { skipped.push(machine); continue; }
          throw new Error(served ? `${machine} does not serve ${project}` : `${machine} has not reported the projects it serves; update its manager first`);
        }
      }
      const current = this.entries(machine).find(e => e.project === (project ?? MACHINE_SCOPE));
      if (change.work !== undefined && change.work !== "taking" && !command.loosen && stricter(current?.work, change.work) !== change.work) {
        // drain --tickets, or the older drain-project, on a fully drained board would let owned work run again.
        unchanged.push(machine);
        notes.push(`${machine}${project ? ` ${project}` : ""} is already ${current!.work}, which is stricter; add --loosen to change it to ${change.work}`);
        continue;
      }
      const entry = this.write(machine, project ?? MACHINE_SCOPE, change, "operator", reason);
      if (entry) changed.push({ machine, ...entry }); else unchanged.push(machine);
      if (project === undefined && change.work === "taking") {
        const held = this.entries(machine).filter(e => e.project !== MACHINE_SCOPE && (e.work === "drained" || e.work === "tickets-drained" || e.run === "stopped"));
        if (held.length) notes.push(`${machine} still holds back ${held.map(e => `${e.project} (${e.run === "stopped" ? "stopped" : e.work})`).join(", ")} by their own entries`);
      }
      if (project !== undefined && change.work === "taking" && this.entries(machine).find(e => e.project === MACHINE_SCOPE)?.work === "drained") notes.push(`${machine} is still drained computer-wide; resume --machine ${machine} lifts that`);
      if (project !== undefined && change.work === "taking" && desiredRun(this.entries(machine), project) === "stopped") notes.push(`${machine} ${project} is still stopped, which holds new work; start lifts that`);
      if (!this.db.prepare("SELECT 1 FROM fleet_desired_polls WHERE machine=?").get(machine)) notes.push(`${machine}'s manager has not fetched desired state yet; the claim service enforces the work state meanwhile, and a stop or start waits for its manager and supervisor to be updated`);
    }
    if (all && project !== undefined && !changed.length && !unchanged.length && !behind.length) throw new Error(`No computer reported serving ${project}`);
    return { changed, unchanged, skipped, notes };
  }
  /**
   * A manager's fetch. Records what it serves and what it applied, imports
   * saved project drains from before this change, and returns its document.
   * An import never loosens anything: a project the computer had drained
   * locally becomes at least tickets-drained centrally.
   */
  poll(machine: string, poll: DesiredPoll): DesiredDocument {
    this.known(machine);
    const projects = poll?.projects;
    if (!Array.isArray(projects) || projects.length > 50 || projects.some(p => typeof p !== "string" || !PROJECT.test(p))) throw new Error("Invalid served projects");
    if (poll.appliedRevision !== null && (!Number.isSafeInteger(poll.appliedRevision) || poll.appliedRevision < 0)) throw new Error("Invalid applied revision");
    const error = poll.applyError;
    if (error !== undefined && (!error || !Number.isSafeInteger(error.revision) || typeof error.reason !== "string")) throw new Error("Invalid apply error");
    const local = poll.localDrains;
    if (local !== undefined && (!Array.isArray(local) || local.some(p => !projects.includes(p)))) throw new Error("Saved drains must name served projects");
    const saved = poll.savedEntries;
    if (saved !== undefined && (!Array.isArray(saved) || saved.length > 100 || saved.some(e => !e || typeof e.project !== "string"
      || (e.project !== MACHINE_SCOPE && !PROJECT.test(e.project)) || (e.work !== undefined && !WORK_STATES.includes(e.work))
      || (e.run !== undefined && (!RUN_STATES.includes(e.run) || e.project === MACHINE_SCOPE))))) throw new Error("Invalid saved entries");
    const served = [...new Set(projects)].sort();
    this.db.prepare(`INSERT INTO fleet_desired_polls VALUES (?,?,?,?,?) ON CONFLICT(machine) DO UPDATE SET
      projects=excluded.projects,applied=excluded.applied,apply_error=excluded.apply_error,polled=excluded.polled`)
      .run(machine, JSON.stringify(served), poll.appliedRevision, error ? JSON.stringify({ revision: error.revision, reason: scrubCredentials(error.reason.slice(0, 500)) }) : null, this.now());
    if (poll.appliedRevision !== null && poll.appliedRevision > this.storedRevision(machine)) {
      // This database is behind what the manager applies, as after a restore.
      // Without the manager's copy nothing may move past its revision, so the
      // older document stays refused and nothing is imported yet.
      if (!saved) return this.document(machine);
      // A board the computer no longer serves is skipped, never a reason to refuse the fetch.
      for (const e of saved.filter(e => e.project === MACHINE_SCOPE || projects.includes(e.project))) {
        const current = this.entries(machine).find(c => c.project === e.project);
        const work = stricter(e.work, current?.work);
        const run = e.run === "stopped" || current?.run === "stopped" ? "stopped" : current?.run;
        if (work !== (current?.work ?? "taking") || run !== current?.run) {
          this.write(machine, e.project, { ...(work !== (current?.work ?? "taking") ? { work } : {}), ...(run !== current?.run ? { run } : {}) }, "restore-merge", "Merged back from this computer's saved state after the claims database went back");
        }
      }
      // At least as strict as what the manager holds, so it may now apply it.
      if (this.storedRevision(machine) <= poll.appliedRevision) this.db.prepare("INSERT INTO fleet_desired_revisions VALUES (?,?) ON CONFLICT(machine) DO UPDATE SET revision=excluded.revision").run(machine, poll.appliedRevision + 1);
    }
    for (const project of new Set(local ?? [])) {
      const board = this.entries(machine).find(e => e.project === project);
      if (stricter(board?.work, "tickets-drained") !== (board?.work ?? "taking")) {
        this.write(machine, project, { work: "tickets-drained" }, "import", "Imported from this computer's saved project drain");
      }
    }
    return this.document(machine);
  }
  /** Desired against observed, for every configured computer and board. */
  report(operations: readonly OperationReport[]) {
    const now = this.now();
    return this.machines.map(machine => {
      const doc = this.document(machine);
      const row = this.db.prepare("SELECT * FROM fleet_desired_polls WHERE machine=?").get(machine);
      const poll = row ? { polled: Number(row.polled), applied: row.applied === null ? null : Number(row.applied),
        applyError: row.apply_error === null ? undefined : JSON.parse(String(row.apply_error)) as { revision: number; reason: string } } : undefined;
      const served = this.served(machine) ?? [];
      const report = operations.find(o => o.machine === machine);
      const workAck = (entry: DesiredEntry): Ack => {
        if (!poll) return { state: "pending", reason: "Its manager has never fetched desired state (an older manager, or offline). The claim service refuses its new grants for drained boards meanwhile." };
        // A failed latest apply comes first: after a restore the applied revision can be ahead of this entry.
        if (poll.applyError && poll.applyError.revision >= entry.revision) return { state: "failed", reason: poll.applyError.reason };
        if (poll.applied !== null && poll.applied > doc.revision) return { state: "failed", reason: `Its manager applied revision ${poll.applied}, ahead of this database's ${doc.revision}, as after a restore; its next fetch merges it back` };
        if (poll.applied !== null && poll.applied >= entry.revision) return { state: "applied" };
        return { state: "pending", reason: now - poll.polled > POLL_STALE_MS ? `Its manager has not fetched desired state for ${Math.round((now - poll.polled) / 60_000)} minutes` : "Waiting for its manager's next fetch" };
      };
      const runAck = (entry: DesiredEntry): Ack | undefined => {
        if (!entry.run) return undefined;
        const op = report?.operations?.find(o => o.project === entry.project);
        if (!op) return { state: "pending", reason: report ? "Its supervisor does not report this board" : "No supervisor report from this computer" };
        const fresh = report!.received >= entry.updated;
        if (entry.run === "stopped") {
          if (op.phase === "stopped") return { state: "applied", ...(op.reason ? { reason: op.reason } : {}) };
          if (fresh && ["attention", "preflight-failed", "changed-before-drain", "signal-failed"].includes(op.phase)) return { state: "failed", reason: op.reason ?? op.phase };
          if (["drain-requested", "draining", "waiting-for-native-task"].includes(op.phase)) return { state: "pending", reason: op.reason ?? "Stopping once its running jobs finish" };
          return { state: "pending", reason: fresh ? `Dispatcher still running (${op.phase}); its supervisor has not begun the stop` : "Waiting for its supervisor's next report" };
        }
        if (op.phase === "current" || op.phase === "complete") return { state: "applied" };
        if (fresh && ["attention", "preflight-failed", "signal-failed"].includes(op.phase)) return { state: "failed", reason: op.reason ?? op.phase };
        if (op.phase === "start-requested" || op.phase === "verifying") return { state: "pending", reason: "Starting" };
        return { state: "pending", reason: fresh ? `Its supervisor reports ${op.phase}${op.reason ? `: ${op.reason}` : ""}` : "Waiting for its supervisor's next report" };
      };
      const machineEntry = doc.entries.find(e => e.project === MACHINE_SCOPE);
      const boards = [...new Set([...served, ...doc.entries.filter(e => e.project !== MACHINE_SCOPE).map(e => e.project)])].sort().map(project => {
        const entry = doc.entries.find(e => e.project === project);
        const op = report?.operations?.find(o => o.project === project);
        return { project, served: served.includes(project), desired: { work: entry?.work ?? null, run: entry?.run ?? null }, effectiveWork: effectiveWork(doc.entries, project),
          observed: { supervisorPhase: op?.phase ?? null, ...(op?.reason ? { supervisorReason: op.reason } : {}) },
          ...(entry ? { changed: entry.updated, actor: entry.actor, ...(entry.reason ? { reason: entry.reason } : {}), ack: { work: workAck(entry), ...(entry.run ? { run: runAck(entry) } : {}) } } : {}) };
      });
      return { machine, revision: doc.revision, manager: poll ? { polled: poll.polled, appliedRevision: poll.applied, ...(poll.applyError ? { applyError: poll.applyError } : {}) } : null,
        supervisorReport: report ? report.received : null,
        machineWide: { work: machineEntry?.work ?? "taking", ...(machineEntry ? { changed: machineEntry.updated, actor: machineEntry.actor, ...(machineEntry.reason ? { reason: machineEntry.reason } : {}), ack: workAck(machineEntry) } : {}) },
        boards };
    });
  }
  /** Changes not yet applied after the grace period, and failures, for the attention report. */
  attention(operations: readonly OperationReport[]) {
    const now = this.now();
    const items: Array<{ machine: string; project: string; kind: "work" | "run"; desired: string; state: AckState; since: number; reason: string }> = [];
    for (const m of this.report(operations)) {
      const consider = (project: string, kind: "work" | "run", desired: string | null | undefined, ack: Ack | undefined, since: number | undefined) => {
        if (!ack || !desired || since === undefined || ack.state === "applied") return;
        if (ack.state === "pending" && now - since < ACK_GRACE_MS) return;
        items.push({ machine: m.machine, project, kind, desired, state: ack.state, since, reason: ack.reason ?? ack.state });
      };
      const mw = m.machineWide as { work: string; changed?: number; ack?: Ack };
      consider(MACHINE_SCOPE, "work", mw.work, mw.ack, mw.changed);
      for (const b of m.boards as Array<{ project: string; desired: { work: string | null; run: string | null }; changed?: number; ack?: { work: Ack; run?: Ack } }>) {
        consider(b.project, "work", b.desired.work, b.ack?.work, b.changed);
        consider(b.project, "run", b.desired.run, b.ack?.run, b.changed);
      }
    }
    return items;
  }
}
