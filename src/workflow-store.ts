import { parseFeatureRoot } from "./feature-lineage.js";
import type { EvidenceSeen } from "./evidence-revision.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ProjectItem } from "./types.js";
import { ticketRequirements } from "./ticket-requirements.js";
import { RECOVERY_PRIORITY, RECOVERY_REPAIRING, LEGACY_RECOVERY_REPAIRING, LEGACY_RECOVERY_PRIORITY, WRITE_LEGACY_RECOVERY_PRIORITY, isRepairWip, hasRunningWip } from "./recovery-labels.js";

export type WorkflowItem = ProjectItem & {
  state: "OPEN" | "CLOSED";
  revision: number;
  position: number;
  positioned?: boolean;
  archived?: boolean;
};
export interface WorkflowProject {
  project: string;
  projectId: string;
  statusFieldId: string;
  options: Record<string, string>;
}
export interface WorkflowChange {
  status?: string;
  state?: "OPEN" | "CLOSED";
  addLabels?: string[];
  removeLabels?: string[];
  labels?: string[];
  blockedBy?: ProjectItem["blockedBy"];
  top?: boolean;
  afterItemId?: string;
}
export interface FiledTicket {
  ticket: string;
  issueNumber: number;
  url: string;
  revision: number;
  item: WorkflowItem;
}
const projectPattern = /^[\w.-]+\/[\w.-]+$/;

/**
 * Columns whose next stage is a review, with the done labels that mean that
 * review has already passed. "In Code Review" is the builder set's verifier
 * and the classic code-review; "In QA" is the classic qa.
 */
const REVIEW_COLUMNS: Record<string, readonly string[]> = {
  "In Code Review": ["done:verifier", "done:code-review"],
  "In QA": ["done:qa"],
};

/**
 * True when an open ticket waits for its review stage and nothing holds it:
 * no open blocker, no `error:` label, no rework on its way back
 * (`needs-rework:`), no operator hold (`needs-human:` except sizing), no
 * dispatcher hold (`held:`, such as the failed health check's
 * `held:health-check`), no running agent label, no passed review and no
 * review verdict waiting to be published (`pending-verdict:`,
 * `pending-done:`). The review queue limit counts these per owning computer. Added 2026-10-14:
 * build-fractal-2 owned six runnable tickets, three of them waiting for its
 * one heavy place, while build-hp-1 sat half idle.
 */
export function awaitsReview(item: Pick<WorkflowItem, "state" | "status" | "labels" | "blockedBy">): boolean {
  const passed = REVIEW_COLUMNS[item.status];
  return item.state === "OPEN" && passed !== undefined
    && !item.labels.some(l => passed.includes(l) || l.startsWith("error:") || l.startsWith("needs-rework:")
      || (l.startsWith("needs-human:") && l !== "needs-human:sizing") || l.startsWith("held:")
      || l.startsWith("pending-verdict:") || l.startsWith("pending-done:"))
    && !hasRunningWip(item.labels)
    && !item.blockedBy.some(b => b.state === "OPEN");
}

/** Workflow authority. GitHub observations never overwrite an adopted ticket's controls. */
export class WorkflowStore {
  private readonly labelTickets = new Map<string, { version: number; tickets: string[] }>();
  private reviewTickets: { version: number; tickets: string[] } | undefined;
  private requirementTickets: { version: number; tickets: Record<string, string[]> } | undefined;
  // Publisher-local incidents need freshness even when accepted metadata is unchanged.
  private readonly archiveObservations = new Map<string, { archived: boolean }>();
  archiveObservation(ticket: string): { readonly archived: boolean } | undefined {
    return this.archiveObservations.get(ticket);
  }
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_projects (project TEXT PRIMARY KEY, config TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_migrations (project TEXT PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_tickets (
        ticket TEXT PRIMARY KEY, project TEXT NOT NULL, item TEXT NOT NULL,
        revision INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_commands (id TEXT PRIMARY KEY, ticket TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_events (id INTEGER PRIMARY KEY, ticket TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, change TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_comments (id TEXT PRIMARY KEY, ticket TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_filings (id TEXT PRIMARY KEY, project TEXT NOT NULL, request TEXT NOT NULL, started_at INTEGER NOT NULL, issue_id TEXT, result TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_evidence_seen (ticket TEXT PRIMARY KEY, seen TEXT NOT NULL) STRICT;`);
    db.exec(`CREATE INDEX IF NOT EXISTS workflow_item_id ON workflow_tickets(json_extract(item,'$.id'));
      CREATE INDEX IF NOT EXISTS workflow_issue_id ON workflow_tickets(json_extract(item,'$.issueId'));
      CREATE INDEX IF NOT EXISTS workflow_parent ON workflow_tickets(project,json_extract(item,'$.parentNumber'));
      CREATE INDEX IF NOT EXISTS workflow_order ON workflow_tickets(project,position);
      CREATE INDEX IF NOT EXISTS workflow_status ON workflow_tickets(json_extract(item,'$.status'));`);
    this.migrateRecoveryPriority();
    this.migrateRepairing();
  }
  /**
   * Renames the saved repair marker `orchestrator:repairing` to `wip:repair`.
   * Idempotent: a converged store changes nothing. Each change is a recorded
   * workflow command. Unlike the priority rename the old name is removed at
   * once: a dispatcher that reads only the old name loses nothing, because the
   * marker only ever ends a run's bookkeeping and the store settles it too.
   */
  migrateRepairing(): number {
    let changed = 0;
    const rows = this.db
      .prepare(
        "SELECT ticket FROM workflow_tickets WHERE EXISTS (SELECT 1 FROM json_each(item,'$.labels') WHERE value=?) ORDER BY ticket",
      )
      .all(LEGACY_RECOVERY_REPAIRING);
    for (const row of rows) {
      const ticket = String(row.ticket),
        item = this.get(ticket);
      this.change(
        ticket,
        {
          addLabels: item.labels.includes(RECOVERY_REPAIRING) ? [] : [RECOVERY_REPAIRING],
          removeLabels: [LEGACY_RECOVERY_REPAIRING],
        },
        "migration:wip-repair",
        `migration:wip-repair:${ticket}:${item.revision}`,
        item.revision,
      );
      changed++;
    }
    return changed;
  }
  /**
   * Renames the saved recovery priority label once. Idempotent: a converged
   * store changes nothing. Each change is a recorded workflow command.
   * While old dispatchers may run, the old name stays beside the new one.
   */
  migrateRecoveryPriority(retireLegacy = !WRITE_LEGACY_RECOVERY_PRIORITY): number {
    let changed = 0;
    const rows = this.db
      .prepare(
        "SELECT ticket FROM workflow_tickets WHERE EXISTS (SELECT 1 FROM json_each(item,'$.labels') WHERE value=?) ORDER BY ticket",
      )
      .all(LEGACY_RECOVERY_PRIORITY);
    for (const row of rows) {
      const ticket = String(row.ticket),
        item = this.get(ticket);
      const addLabels = item.labels.includes(RECOVERY_PRIORITY)
        ? []
        : [RECOVERY_PRIORITY];
      const removeLabels = retireLegacy ? [LEGACY_RECOVERY_PRIORITY] : [];
      if (!addLabels.length && !removeLabels.length) continue;
      this.change(
        ticket,
        { addLabels, removeLabels },
        "migration:recovery-priority",
        `migration:recovery-priority:${ticket}:${item.revision}`,
        item.revision,
      );
      changed++;
    }
    return changed;
  }
  /**
   * The repair run marker ends when the run the handback assigned has
   * finished, whatever its outcome. That run is the first stage run to mark
   * the ticket running after the marker was added. Removing it here, with no
   * active run on the ticket, covers an interrupted run, a crashed worker
   * released by an operator and a dispatcher that does not remove it itself.
   */
  settleRepairing(project: string): string[] {
    const settled: string[] = [];
    for (const item of this.list(project)) {
      const ticket = `${project}#${item.issueNumber}`;
      const markers = item.labels.filter(isRepairWip);
      if (
        !markers.length ||
        this.db
          .prepare("SELECT 1 FROM fleet_runs WHERE ticket=? AND finished IS NULL")
          .get(ticket)
      )
        continue;
      const adds = (change: string, label: (l: string) => boolean) => {
        try {
          const c = JSON.parse(change);
          return [...(c?.addLabels ?? []), ...(c?.labels ?? [])].some(
            (l: unknown) => typeof l === "string" && label(l),
          );
        } catch {
          return false;
        }
      };
      const rows = this.db
        .prepare("SELECT change, actor FROM workflow_events WHERE ticket=? ORDER BY id")
        .all(ticket);
      const events = rows.map((e) => String(e.change));
      // The rename migration re-adds the marker under its new name. It is not
      // an assignment: the handback that wrote the old name still is.
      let assigned = -1;
      events.forEach((e, i) => {
        if (rows[i].actor !== "migration:wip-repair" && adds(e, isRepairWip)) assigned = i;
      });
      // The run's own label is a wip: label other than the marker.
      if (
        assigned < 0 ||
        !events
          .slice(assigned + 1)
          .some((e) => adds(e, (l) => l.startsWith("wip:") && !isRepairWip(l)))
      )
        continue;
      this.change(
        ticket,
        { removeLabels: markers },
        "authority",
        `repairing:${ticket}:${item.revision}`,
        item.revision,
      );
      settled.push(ticket);
    }
    return settled;
  }
  projects(): WorkflowProject[] {
    return this.db
      .prepare("SELECT config FROM workflow_projects ORDER BY project")
      .all()
      .map((r) => JSON.parse(String(r.config)));
  }
  /**
   * Open tickets of adopted projects that carry this label, in ticket order.
   * Every scheduler snapshot asks, and the scan parses every saved ticket, so
   * the answer is kept until the data can have changed. Every ticket write runs
   * in transaction(), which drops it; a commit by another connection moves
   * data_version. Inside a transaction, which may still roll back, it is
   * neither read nor kept.
   */
  openTicketsWithLabel(label: string): string[] {
    const inTransaction = (this.db as { isTransaction?: boolean }).isTransaction !== false;
    const version = Number(this.db.prepare("PRAGMA data_version").get()?.data_version);
    const kept = inTransaction ? undefined : this.labelTickets.get(label);
    if (kept && kept.version === version) return [...kept.tickets];
    const tickets = this.db
      .prepare(
        `SELECT ticket FROM workflow_tickets
         WHERE project IN (SELECT project FROM workflow_projects)
           AND json_extract(item,'$.state') IS NOT 'CLOSED'
           AND EXISTS (SELECT 1 FROM json_each(item,'$.labels') WHERE value=?)
         ORDER BY ticket`,
      )
      .all(label)
      .map((r) => String(r.ticket));
    if (!inTransaction) this.labelTickets.set(label, { version, tickets });
    return [...tickets];
  }
  /**
   * Open tickets of adopted projects with a `requires:` label, mapped to the
   * capabilities they require (see ticket-requirements.ts). Kept like
   * openTicketsWithLabel, since every scheduler snapshot asks.
   */
  openTicketRequirements(): Record<string, string[]> {
    const inTransaction = (this.db as { isTransaction?: boolean }).isTransaction !== false;
    const version = Number(this.db.prepare("PRAGMA data_version").get()?.data_version);
    const kept = inTransaction ? undefined : this.requirementTickets;
    if (kept && kept.version === version) return structuredClone(kept.tickets);
    const tickets: Record<string, string[]> = {};
    for (const row of this.db
      .prepare(
        `SELECT ticket,item FROM workflow_tickets
         WHERE project IN (SELECT project FROM workflow_projects)
           AND json_extract(item,'$.state') IS NOT 'CLOSED'
           AND EXISTS (SELECT 1 FROM json_each(item,'$.labels') WHERE value LIKE 'requires:%')
         ORDER BY ticket`,
      )
      .all()) {
      const required = ticketRequirements(JSON.parse(String(row.item)).labels ?? []);
      if (required.length) tickets[String(row.ticket)] = required;
    }
    if (!inTransaction) this.requirementTickets = { version, tickets };
    return structuredClone(tickets);
  }
  /**
   * Open tickets of adopted projects that wait for review, see awaitsReview,
   * in ticket order, whoever owns them. A project still preparing is left
   * out, since the authority starts nothing there. Kept like openTicketsWithLabel, since
   * every scheduler snapshot asks; a blocker's state is a ticket row too, so
   * data_version covers it.
   */
  reviewReadyTickets(): string[] {
    const inTransaction = (this.db as { isTransaction?: boolean }).isTransaction !== false;
    const version = Number(this.db.prepare("PRAGMA data_version").get()?.data_version);
    const kept = inTransaction ? undefined : this.reviewTickets;
    if (kept && kept.version === version) return [...kept.tickets];
    const columns = Object.keys(REVIEW_COLUMNS);
    const tickets = this.db
      .prepare(
        `SELECT * FROM workflow_tickets
         WHERE project IN (SELECT project FROM workflow_projects)
           AND project NOT IN (SELECT project FROM workflow_migrations)
           AND json_extract(item,'$.state') IS NOT 'CLOSED'
           AND json_extract(item,'$.status') IN (${columns.map(() => "?").join(",")})
         ORDER BY ticket`,
      )
      .all(...columns)
      .filter((r) => awaitsReview(this.decode(r)))
      .map((r) => String(r.ticket));
    if (!inTransaction) this.reviewTickets = { version, tickets };
    return [...tickets];
  }
  config(project: string): WorkflowProject | undefined {
    return this.projects().find((p) => p.project === project);
  }
  enabled(project: string): boolean {
    return !!this.config(project);
  }
  preparing(project: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM workflow_migrations WHERE project=?")
      .get(project);
  }
  prepare(project: string): void {
    this.reviewTickets = undefined;
    this.requirementTickets = undefined;
    if (!projectPattern.test(project))
      throw new Error("Invalid workflow project");
    this.db
      .prepare("INSERT OR IGNORE INTO workflow_migrations VALUES (?)")
      .run(project);
  }
  activate(project: string): void {
    this.reviewTickets = undefined;
    this.requirementTickets = undefined;
    if (!this.enabled(project))
      throw new Error("Import the workflow before activation");
    this.db
      .prepare("DELETE FROM workflow_migrations WHERE project=?")
      .run(project);
  }
  cancelPreparation(project: string): void {
    this.reviewTickets = undefined;
    this.requirementTickets = undefined;
    if (this.enabled(project))
      throw new Error("Imported workflow cannot revert to GitHub authority");
    this.db
      .prepare("DELETE FROM workflow_migrations WHERE project=?")
      .run(project);
  }
  transaction<T>(work: () => T): T {
    this.labelTickets.clear();
    this.reviewTickets = undefined;
    this.requirementTickets = undefined;
    this.db.exec("SAVEPOINT workflow");
    try {
      const value = work();
      this.db.exec("RELEASE workflow");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK TO workflow; RELEASE workflow");
      throw e;
    }
  }
  import(
    config: WorkflowProject,
    items: WorkflowItem[],
    comments: Record<
      string,
      Array<{ id: string; body: string; created_at: string }>
    > = {},
  ): void {
    if (
      !config ||
      !projectPattern.test(config.project) ||
      !config.projectId ||
      !config.statusFieldId ||
      !config.options?.Inbox ||
      !config.options?.Done
    )
      throw new Error("Invalid workflow project");
    if (this.enabled(config.project))
      throw new Error("Workflow already imported; use commands to change it");
    if (
      this.db
        .prepare(
          "SELECT 1 FROM fleet_runs WHERE finished IS NULL AND json_extract(request,'$.project')=?",
        )
        .get(config.project)
    )
      throw new Error("Drain all project runs before importing workflow");
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO workflow_projects VALUES (?,?)")
        .run(config.project, JSON.stringify(config));
      for (const [index, item] of items.entries()) {
        this.validate(item, config);
        const ticket = `${config.project}#${item.issueNumber}`;
        // Preserve uncertain running markers on import. They require explicit operator resolution.
        this.db
          .prepare("INSERT INTO workflow_tickets VALUES (?,?,?,1,0,?)")
          .run(ticket, config.project, JSON.stringify(item), index);
        for (const c of comments[String(item.issueNumber)] ?? []) {
          if (
            !c.id ||
            typeof c.body !== "string" ||
            !Number.isFinite(Date.parse(c.created_at))
          )
            throw new Error("Invalid imported comment");
          this.db
            .prepare("INSERT INTO workflow_comments VALUES (?,?,?,?,1)")
            .run(c.id, ticket, c.body, c.created_at);
        }
      }
      this.event(config.project, "operator", "import");
    });
  }
  private validate(
    item: ProjectItem & { state?: string },
    config: WorkflowProject,
  ): void {
    if (
      !Number.isSafeInteger(item.issueNumber) ||
      item.issueNumber < 1 ||
      !item.id ||
      !item.issueId ||
      !Object.hasOwn(config.options, item.status) ||
      !Array.isArray(item.labels) ||
      item.labels.some((l) => typeof l !== "string" || !l) ||
      !Array.isArray(item.blockedBy) ||
      !["OPEN", "CLOSED"].includes(item.state ?? "")
    )
      throw new Error("Invalid workflow ticket");
  }
  list(project: string): WorkflowItem[] {
    return this.db
      .prepare(
        "SELECT * FROM workflow_tickets WHERE project=? ORDER BY position,ticket",
      )
      .all(project)
      .map((r) => this.decode(r));
  }
  private decode(row: any): WorkflowItem {
    const item = JSON.parse(String(row.item));
    item.blockedBy = item.blockedBy.map((b: any) => {
      const project =
        b.url?.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] ??
        String(row.project);
      const blocker = this.db
        .prepare(
          "SELECT json_extract(item,'$.state') AS state FROM workflow_tickets WHERE ticket=?",
        )
        .get(`${project}#${b.number}`);
      return { ...b, state: blocker?.state ?? b.state };
    });
    if (item.subIssues?.total) {
      const children = this.db
        .prepare(
          "SELECT json_extract(item,'$.state') AS state FROM workflow_tickets WHERE project=? AND json_extract(item,'$.parentNumber')=?",
        )
        .all(String(row.project), item.issueNumber);
      if (children.length >= item.subIssues.total)
        item.subIssues = {
          total: children.length,
          completed: children.filter((c) => c.state === "CLOSED").length,
        };
    }
    return {
      ...item,
      revision: Number(row.revision),
      position: Number(row.position),
    };
  }
  get(ticket: string): WorkflowItem {
    const row = this.db
      .prepare("SELECT * FROM workflow_tickets WHERE ticket=?")
      .get(ticket);
    if (!row) throw new Error("Unknown workflow ticket");
    return this.decode(row);
  }
  find(id: string): { ticket: string; item: WorkflowItem } | undefined {
    if (!id) return undefined;
    const row = this.db
      .prepare(
        "SELECT * FROM workflow_tickets WHERE json_extract(item,'$.id')=? OR json_extract(item,'$.issueId')=?",
      )
      .get(id, id);
    return row
      ? { ticket: String(row.ticket), item: this.decode(row) }
      : undefined;
  }
  /**
   * The counted comments the ticket's evidence revision was last computed
   * from, kept beside the item so recording them never changes the item's
   * revision. See issueEvidence.
   */
  evidenceSeen(ticket: string): EvidenceSeen | undefined {
    const row = this.db.prepare("SELECT seen FROM workflow_evidence_seen WHERE ticket=?").get(ticket);
    return row ? JSON.parse(String(row.seen)) : undefined;
  }
  /** Content refresh may discover new issues. Their initial workflow is always Inbox. */
  observe(project: string, items: Array<WorkflowItem & { evidenceSeen?: EvidenceSeen }>): void {
    const config = this.config(project);
    if (!config) throw new Error("Workflow not enabled");
    this.transaction(() => {
      for (const { evidenceSeen, ...observed } of items) {
        if (evidenceSeen) this.db.prepare("INSERT INTO workflow_evidence_seen VALUES (?,?) ON CONFLICT(ticket) DO UPDATE SET seen=excluded.seen")
          .run(`${project}#${observed.issueNumber}`, JSON.stringify(evidenceSeen));
        this.validate(
          { ...observed, status: observed.status || "Inbox" },
          config,
        );
        const ticket = `${project}#${observed.issueNumber}`;
        const prior = this.db
          .prepare("SELECT * FROM workflow_tickets WHERE ticket=?")
          .get(ticket);
        if (!prior) {
          // A newly discovered closed issue is history, not a new job.
          const item = {
            ...observed,
            featureRoot: parseFeatureRoot(observed.body, project),
            status: observed.state === "CLOSED" ? "Done" : "Inbox",
            labels: observed.labels.filter(
              (l) =>
                !/^(wip:|done:|error:|needs-rework:|claim:|orchestrator:)/.test(
                  l,
                ),
            ),
          };
          const position = Number(
            this.db
              .prepare(
                "SELECT coalesce(max(position),0)+1 AS p FROM workflow_tickets WHERE project=?",
              )
              .get(project)!.p,
          );
          this.db
            .prepare("INSERT INTO workflow_tickets VALUES (?,?,?,1,0,?)")
            .run(ticket, project, JSON.stringify(item), position);
        } else {
          const current = this.decode(prior);
          const observedRoot = parseFeatureRoot(observed.body, project);
          if (observedRoot && current.featureRoot && observedRoot !== current.featureRoot) throw new Error("Feature root cannot change");
          const content = {
            ...current,
            featureRoot: current.featureRoot ?? observedRoot,
            id: observed.id,
            issueId: observed.issueId,
            title: observed.title,
            body: observed.body,
            url: observed.url,
            parentNumber: observed.parentNumber,
            grandparentNumber: observed.grandparentNumber,
            subIssues: observed.subIssues,
            evidenceRevision:
              observed.evidenceRevision ?? current.evidenceRevision,
            archived: observed.archived ?? current.archived,
          };
          const changed = JSON.stringify(content) !== JSON.stringify(current);
          // A human edited the display. Republish authority; never import that edit.
          const dependencies = (bs: ProjectItem["blockedBy"]) =>
            bs.map((b) => b.url ?? `${project}#${b.number}`).sort();
          const drift =
            JSON.stringify(dependencies(observed.blockedBy)) !==
              JSON.stringify(dependencies(current.blockedBy)) ||
            (!content.archived && observed.status !== current.status) ||
            observed.state !== current.state ||
            JSON.stringify([...observed.labels].sort()) !==
              JSON.stringify([...current.labels].sort());
          if (changed || drift)
            this.db
              .prepare(
                "UPDATE workflow_tickets SET item=?,revision=revision+1 WHERE ticket=?",
              )
              .run(JSON.stringify(content), ticket);
        }
      }
    });
    // Publish freshness only after the entire observation transaction succeeded.
    for (const item of items)
      if (typeof item.archived === "boolean")
        this.archiveObservations.set(`${project}#${item.issueNumber}`, {
          archived: item.archived,
        });
  }
  change(
    ticket: string,
    change: WorkflowChange,
    actor: string,
    commandId: string,
    expectedRevision?: number,
  ): WorkflowItem {
    if (
      !commandId ||
      commandId.length > 200 ||
      !change ||
      Object.keys(change).some(
        (k) =>
          ![
            "status",
            "state",
            "labels",
            "addLabels",
            "removeLabels",
            "blockedBy",
            "top",
            "afterItemId",
          ].includes(k),
      )
    )
      throw new Error("Invalid workflow command");
    const request = JSON.stringify({ ticket, change, actor, expectedRevision });
    return this.transaction(() => {
      const replay = this.db
        .prepare("SELECT * FROM workflow_commands WHERE id=?")
        .get(commandId);
      if (replay) {
        if (replay.request !== request)
          throw new Error("Workflow command identity reused");
        return JSON.parse(String(replay.result));
      }
      const item = this.get(ticket),
        config = this.config(ticket.split("#")[0])!;
      if (expectedRevision !== undefined && item.revision !== expectedRevision)
        throw new Error("Workflow changed; read again before editing");
      if (
        change.status !== undefined &&
        !Object.hasOwn(config.options, change.status)
      )
        throw new Error("Unknown workflow stage");
      if (
        change.state !== undefined &&
        !["OPEN", "CLOSED"].includes(change.state)
      )
        throw new Error("Invalid issue state");
      for (const labels of [
        change.labels,
        change.addLabels,
        change.removeLabels,
      ])
        if (
          labels !== undefined &&
          (!Array.isArray(labels) ||
            labels.some((l) => typeof l !== "string" || !l || l.length > 100))
        )
          throw new Error("Invalid labels");
      if (
        change.blockedBy !== undefined &&
        (!Array.isArray(change.blockedBy) ||
          change.blockedBy.some(
            (b) =>
              !Number.isSafeInteger(b.number) ||
              b.number <= 0 ||
              !["OPEN", "CLOSED"].includes(b.state),
          ))
      )
        throw new Error("Invalid blockers");
      if (change.blockedBy !== undefined) {
        const reference = (project: string, blocker: ProjectItem["blockedBy"][number]) =>
          `${blocker.url?.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] ?? project}#${blocker.number}`;
        const previous = new Set(item.blockedBy.map(b => reference(config.project, b)));
        const known = this.db.prepare("SELECT project,item FROM workflow_tickets WHERE ticket=?");
        for (const blocker of change.blockedBy) {
          const target = reference(config.project, blocker);
          if (previous.has(target)) continue;
          const pending = [target], visited = new Set<string>();
          while (pending.length) {
            const current = pending.pop()!;
            if (current === ticket) throw new Error("Workflow dependency would create a cycle");
            if (visited.has(current)) continue;
            visited.add(current);
            const row = known.get(current);
            if (!row) continue;
            const dependencies: ProjectItem["blockedBy"] = JSON.parse(String(row.item)).blockedBy;
            for (const dependency of dependencies)
              pending.push(reference(String(row.project), dependency));
          }
        }
      }
      const labels = new Set(change.labels ?? item.labels);
      for (const label of change.removeLabels ?? []) labels.delete(label);
      for (const label of change.addLabels ?? []) labels.add(label);
      const updated = {
        ...item,
        status: change.status ?? item.status,
        state: change.state ?? item.state,
        labels: [...labels],
        blockedBy: change.blockedBy ?? item.blockedBy,
        revision: item.revision + 1,
      };
      if (change.top && change.afterItemId)
        throw new Error("Choose top or a preceding item");
      if (change.afterItemId !== undefined) {
        const ordered = this.list(config.project).filter(
          (i) => i.issueNumber !== item.issueNumber,
        );
        const index = ordered.findIndex((i) => i.id === change.afterItemId);
        if (index < 0)
          throw new Error(
            "Preceding item must be another ticket in this project",
          );
        updated.position =
          (ordered[index].position +
            (ordered[index + 1]?.position ?? ordered[index].position + 2)) /
          2;
        updated.positioned = true;
      }
      if (change.top) {
        updated.position = Number(
          this.db
            .prepare(
              "SELECT min(position)-1 AS p FROM workflow_tickets WHERE project=?",
            )
            .get(config.project)!.p,
        );
        updated.positioned = true;
      }
      this.db
        .prepare(
          "UPDATE workflow_tickets SET item=?,revision=?,position=? WHERE ticket=?",
        )
        .run(
          JSON.stringify(updated),
          updated.revision,
          updated.position,
          ticket,
        );
      this.event(ticket, actor, JSON.stringify(change));
      this.db
        .prepare("INSERT INTO workflow_commands VALUES (?,?,?,?)")
        .run(commandId, ticket, request, JSON.stringify(updated));
      return updated;
    });
  }
  /**
   * An operator filing outlives a failed attempt. The row is written before
   * GitHub is asked to create anything, so a retry knows whether to look for
   * an issue that may already exist.
   */
  beginFiling(
    id: string,
    project: string,
    request: string,
  ): { fresh: boolean; startedAt: number; issueId?: string; result?: FiledTicket } {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM workflow_filings WHERE id=?")
        .get(id);
      if (row) {
        if (row.project !== project || row.request !== request)
          throw new Error("Workflow command identity reused");
        return {
          fresh: false,
          startedAt: Number(row.started_at),
          ...(row.issue_id ? { issueId: String(row.issue_id) } : {}),
          ...(row.result ? { result: JSON.parse(String(row.result)) } : {}),
        };
      }
      const startedAt = Date.now();
      this.db
        .prepare(
          "INSERT INTO workflow_filings VALUES (?,?,?,?,NULL,NULL)",
        )
        .run(id, project, request, startedAt);
      return { fresh: true, startedAt };
    });
  }
  filingMatches(id: string, issueId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM workflow_filings WHERE id=? AND issue_id=?').get(id,issueId);
  }
  filingCreated(id: string, issueId: string): void {
    this.db
      .prepare(
        "UPDATE workflow_filings SET issue_id=? WHERE id=? AND issue_id IS NULL",
      )
      .run(issueId, id);
  }
  /** Applies the intended workflow and saves the answer in one transaction. */
  completeFiling(
    id: string,
    ticket: string,
    change: WorkflowChange,
  ): FiledTicket {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT result FROM workflow_filings WHERE id=?")
        .get(id);
      if (!row) throw new Error("Unknown workflow filing");
      if (row.result) return JSON.parse(String(row.result));
      const item = this.change(
        ticket,
        change,
        "operator",
        "file:" + id,
        this.get(ticket).revision,
      );
      const result: FiledTicket = {
        ticket,
        issueNumber: item.issueNumber,
        url: item.url,
        revision: item.revision,
        item,
      };
      this.db
        .prepare("UPDATE workflow_filings SET result=? WHERE id=?")
        .run(JSON.stringify(result), id);
      return result;
    });
  }
  /** Lineage and scope are claim-authority metadata, never an arbitrary workflow command. */
  recoveryMetadata(ticket: string, fields: Record<string, unknown>, actor = 'recovery-split'): void {
    const item = this.get(ticket);
    this.db.prepare("UPDATE workflow_tickets SET item=?,revision=revision+1 WHERE ticket=?")
      .run(JSON.stringify({...item,...fields}), ticket);
    this.event(ticket, actor, JSON.stringify(fields));
  }
  finish(ticket: string, role: string, runId: string): void {
    if (
      !this.enabled(ticket.split("#")[0]) ||
      !this.db
        .prepare("SELECT 1 FROM workflow_tickets WHERE ticket=?")
        .get(ticket)
    )
      return;
    this.change(
      ticket,
      { removeLabels: [`wip:${role}`] },
      "run:" + runId,
      "finish:" + runId,
    );
  }
  comments(ticket: string) {
    return this.db
      .prepare(
        "SELECT id,body,created_at FROM workflow_comments WHERE ticket=? ORDER BY created_at,rowid",
      )
      .all(ticket) as unknown as Array<{
      id: string;
      body: string;
      created_at: string;
    }>;
  }
  unpublishedComments(ticket: string) {
    return this.db
      .prepare(
        "SELECT id,body,created_at FROM workflow_comments WHERE ticket=? AND published=0 ORDER BY created_at,rowid",
      )
      .all(ticket) as unknown as Array<{
      id: string;
      body: string;
      created_at: string;
    }>;
  }
  comment(ticket: string, body: string, id: string = randomUUID()): void {
    this.get(ticket);
    if (typeof body !== "string" || body.length > 100_000)
      throw new Error("Invalid workflow comment");
    const old = this.db
      .prepare("SELECT ticket,body FROM workflow_comments WHERE id=?")
      .get(id);
    if (old && (old.ticket !== ticket || old.body !== body))
      throw new Error("Comment identity reused");
    this.db
      .prepare("INSERT OR IGNORE INTO workflow_comments VALUES (?,?,?,?,0)")
      .run(id, ticket, body, new Date().toISOString());
  }
  pending(
    limit = 20,
    project?: string,
  ): Array<{ ticket: string; item: WorkflowItem }> {
    return this.db
      .prepare(
        "SELECT * FROM workflow_tickets WHERE revision>published AND (? IS NULL OR project=?) ORDER BY revision DESC,rowid LIMIT ?",
      )
      .all(project ?? null, project ?? null, limit)
      .map((r) => ({ ticket: String(r.ticket), item: this.decode(r) }));
  }
  published(ticket: string, revision: number): void {
    this.db
      .prepare(
        "UPDATE workflow_tickets SET published=max(published,?) WHERE ticket=? AND revision>=?",
      )
      .run(revision, ticket, revision);
  }
  pendingComments() {
    return this.db
      .prepare(
        "SELECT * FROM workflow_comments WHERE published=0 ORDER BY rowid LIMIT 10",
      )
      .all() as unknown as Array<{ id: string; ticket: string; body: string }>;
  }
  commentPublished(id: string) {
    this.db
      .prepare("UPDATE workflow_comments SET published=1 WHERE id=?")
      .run(id);
  }
  private event(ticket: string, actor: string, change: string): void {
    this.db
      .prepare(
        "INSERT INTO workflow_events(ticket,actor,at,change) VALUES (?,?,?,?)",
      )
      .run(ticket, actor, Date.now(), change);
  }
}
