import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ProjectItem } from "./types.js";

export type WorkflowItem = ProjectItem & {
  state: "OPEN" | "CLOSED";
  revision: number;
  position: number;
  positioned?: boolean;
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
const projectPattern = /^[\w.-]+\/[\w.-]+$/;

/** Workflow authority. GitHub observations never overwrite an adopted ticket's controls. */
export class WorkflowStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_projects (project TEXT PRIMARY KEY, config TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_migrations (project TEXT PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_tickets (
        ticket TEXT PRIMARY KEY, project TEXT NOT NULL, item TEXT NOT NULL,
        revision INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_commands (id TEXT PRIMARY KEY, ticket TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_events (id INTEGER PRIMARY KEY, ticket TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, change TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workflow_comments (id TEXT PRIMARY KEY, ticket TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0) STRICT;`);
    db.exec(`CREATE INDEX IF NOT EXISTS workflow_item_id ON workflow_tickets(json_extract(item,'$.id'));
      CREATE INDEX IF NOT EXISTS workflow_issue_id ON workflow_tickets(json_extract(item,'$.issueId'));
      CREATE INDEX IF NOT EXISTS workflow_parent ON workflow_tickets(project,json_extract(item,'$.parentNumber'));
      CREATE INDEX IF NOT EXISTS workflow_order ON workflow_tickets(project,position);`);
  }
  projects(): WorkflowProject[] {
    return this.db
      .prepare("SELECT config FROM workflow_projects ORDER BY project")
      .all()
      .map((r) => JSON.parse(String(r.config)));
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
    if (!projectPattern.test(project))
      throw new Error("Invalid workflow project");
    this.db
      .prepare("INSERT OR IGNORE INTO workflow_migrations VALUES (?)")
      .run(project);
  }
  activate(project: string): void {
    if (!this.enabled(project))
      throw new Error("Import the workflow before activation");
    this.db
      .prepare("DELETE FROM workflow_migrations WHERE project=?")
      .run(project);
  }
  cancelPreparation(project: string): void {
    if (this.enabled(project))
      throw new Error("Imported workflow cannot revert to GitHub authority");
    this.db
      .prepare("DELETE FROM workflow_migrations WHERE project=?")
      .run(project);
  }
  transaction<T>(work: () => T): T {
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
  /** Content refresh may discover new issues. Their initial workflow is always Inbox. */
  observe(project: string, items: WorkflowItem[]): void {
    const config = this.config(project);
    if (!config) throw new Error("Workflow not enabled");
    this.transaction(() => {
      for (const observed of items) {
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
          const content = {
            ...current,
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
          };
          const changed = JSON.stringify(content) !== JSON.stringify(current);
          // A human edited the display. Republish authority; never import that edit.
          const dependencies = (bs: ProjectItem["blockedBy"]) =>
            bs.map((b) => b.url ?? `${project}#${b.number}`).sort();
          const drift =
            JSON.stringify(dependencies(observed.blockedBy)) !==
              JSON.stringify(dependencies(current.blockedBy)) ||
            observed.status !== current.status ||
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
