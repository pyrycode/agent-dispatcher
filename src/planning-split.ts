import type { DatabaseSync } from 'node:sqlite';
import { OwnershipRefusal, type FleetStore } from './fleet-store.js';
import type { WorkflowItem } from './workflow-store.js';
import { scrubCredentials } from './agent-runtime.js';

export interface PlanningActor { machine: string; session: string; runId: string }
export interface PlanningSplit {
  commandId: string; revision: number; summary: string;
  children: Array<{ number: number; revision: number; dependsOn: number[] }>;
  dependents: Array<{ ticket: string; revision: number; children: number[] }>;
}
export interface PlanningSplitResult { parent: WorkflowItem; children: string[] }
const reference = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
function shape(value: any, fields: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k)))
    throw new OwnershipRefusal('Invalid split request fields');
}
export function planningSplitRequest(value: unknown): PlanningSplit {
  const v = value as PlanningSplit;
  shape(v, ['commandId', 'revision', 'summary', 'children', 'dependents']);
  if (typeof v.commandId !== 'string' || !/^[\w.:@-]{1,128}$/.test(v.commandId) || !positive(v.revision)
      || typeof v.summary !== 'string' || !v.summary.trim() || v.summary.length > 4000 || scrubCredentials(v.summary) !== v.summary)
    throw new OwnershipRefusal('Split requires a command identity, revision and content-free summary');
  if (!Array.isArray(v.children) || v.children.length < 2 || v.children.length > 100
      || !Array.isArray(v.dependents) || v.dependents.length > 100)
    throw new OwnershipRefusal('Split requires all children and dependents (at most 100 each)');
  const earlier = new Set<number>();
  for (const child of v.children) {
    shape(child, ['number', 'revision', 'dependsOn']);
    if (!positive(child.number) || !positive(child.revision) || earlier.has(child.number)
        || !Array.isArray(child.dependsOn) || new Set(child.dependsOn).size !== child.dependsOn.length
        || child.dependsOn.some(n => !earlier.has(n))) throw new OwnershipRefusal('Children must be unique and depend only on earlier children');
    earlier.add(child.number);
  }
  const dependents = new Set<string>();
  for (const dependent of v.dependents) {
    shape(dependent, ['ticket', 'revision', 'children']);
    if (!reference.test(dependent.ticket) || !positive(dependent.revision) || dependents.has(dependent.ticket)
        || !Array.isArray(dependent.children) || !dependent.children.length
        || new Set(dependent.children).size !== dependent.children.length || dependent.children.some(n => !earlier.has(n)))
      throw new OwnershipRefusal('Every dependent needs its existing ticket, revision and required children');
    dependents.add(dependent.ticket);
  }
  // Stable request identity independent of JSON property order.
  return { commandId: v.commandId, revision: v.revision, summary: v.summary,
    children: v.children.map(c => ({ number: c.number, revision: c.revision, dependsOn: [...c.dependsOn] })),
    dependents: v.dependents.map(d => ({ ticket: d.ticket, revision: d.revision, children: [...d.children] })) };
}

/** Called inside the FleetStore transaction, like recovery-split finalization. */
export class PlanningSplits {
  constructor(private db: DatabaseSync, private store: FleetStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_planning_splits (
      id TEXT PRIMARY KEY, ticket TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS fleet_split_children (issue_id TEXT PRIMARY KEY, parent TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS fleet_split_parent ON fleet_split_children(parent);`);
  }
  result(actor: PlanningActor, ticket: string, request: PlanningSplit): PlanningSplitResult | undefined {
    const row = this.db.prepare('SELECT * FROM fleet_planning_splits WHERE id=?').get(request.commandId);
    if (!row) return;
    if (row.ticket !== ticket || row.actor !== JSON.stringify(actor) || row.request !== JSON.stringify(request))
      throw new OwnershipRefusal('Split command identity reused or owner changed');
    return JSON.parse(String(row.result));
  }
  authorize(actor: PlanningActor, ticket: string): void {
    this.store.authorizeWorkflow(actor.machine, actor.session, ticket, actor.runId);
    const run = this.store.snapshot().runs.find(r => r.id === actor.runId);
    if (!run || run.ticket !== ticket || !['refiner', 'po'].includes(run.role))
      throw new OwnershipRefusal('Split finalization requires the active parent planning run');
  }
  inspect(ticket: string) {
    const parent = this.store.workflow.get(ticket), project = ticket.split('#')[0];
    const children = this.store.workflow.list(project).filter(i => i.parentNumber === parent.issueNumber);
    const dependents = this.store.workflow.projects().flatMap(p => this.store.workflow.list(p.project)
      .filter(i => i.state === 'OPEN' && !(p.project === project && i.parentNumber === parent.issueNumber)
        && i.blockedBy.some(b => b.url ? b.url === parent.url : p.project === project && b.number === parent.issueNumber))
      .map(i => ({ ticket: `${p.project}#${i.issueNumber}`, item: i })));
    return { parent, children, dependents };
  }
  /** New split children cannot escape after a creator crashes or finishes early. */
  holdChild(issueId: string, ticket: string) {
    this.db.prepare('INSERT OR IGNORE INTO fleet_split_children VALUES (?,?)').run(issueId, ticket);
  }
  childPending(item: WorkflowItem, project: string): boolean {
    const row = this.db.prepare('SELECT parent FROM fleet_split_children WHERE issue_id=? AND NOT EXISTS (SELECT 1 FROM fleet_planning_splits WHERE ticket=parent)').get(item.issueId);
    if (!row || `${project}#${item.parentNumber}` !== row.parent) return false;
    const parent = this.store.workflow.get(String(row.parent));
    if (this.store.requiredRepairChildren.declared(item.issueId, String(row.parent))
        && (item.state === 'CLOSED' || parent.blockedBy.some(b => b.state === 'OPEN'
          && (b.url ? b.url === item.url : b.number === item.issueNumber)))) return false;
    return parent.state === 'OPEN';
  }
  parentPending(ticket: string): boolean {
    const rows = this.db.prepare('SELECT issue_id FROM fleet_split_children WHERE parent=?').all(ticket);
    if (!rows.length) return false;
    const parent = this.store.workflow.get(ticket);
    return parent.state === 'OPEN' && rows.some(row => {
      const child = this.store.workflow.find(String(row.issue_id))?.item;
      return child && child.parentNumber === parent.issueNumber && this.childPending(child, ticket.split('#')[0]);
    });
  }
  finalize(actor: PlanningActor, ticket: string, input: unknown): PlanningSplitResult {
    const request = planningSplitRequest(input), saved = this.result(actor, ticket, request);
    if (saved) return saved;
    this.authorize(actor, ticket);
    if (this.store.requiredRepairChildren.hasParent(ticket)) throw new OwnershipRefusal('Required repair parent retains acceptance and cannot be replaced by this split');
    const { parent, children, dependents } = this.inspect(ticket), project = ticket.split('#')[0];
    if (parent.state !== 'OPEN' || parent.status !== 'Backlog' || parent.grandparentNumber)
      throw new OwnershipRefusal('Split requires an open planning parent within the split depth limit');
    const equal = (a: Array<string | number>, b: Array<string | number>) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    if (!equal(children.map(c => c.issueNumber), request.children.map(c => c.number))) throw new OwnershipRefusal('Split child inventory changed or is incomplete');
    if (!equal(dependents.map(d => d.ticket), request.dependents.map(d => d.ticket))) throw new OwnershipRefusal('Split dependent inventory changed or is incomplete');
    if (children.some(c => c.state !== 'OPEN' || !['Inbox', 'Backlog'].includes(c.status) || !c.body.trim()))
      throw new OwnershipRefusal('Every split child must be an open, unstarted issue with its own scope');
    const affected = new Map([[ticket, parent], ...children.map(c => [`${project}#${c.issueNumber}`, c] as const), ...dependents.map(d => [d.ticket, d.item] as const)]);
    const revisions = new Map([[ticket, request.revision], ...request.children.map(c => [`${project}#${c.number}`, c.revision] as const), ...request.dependents.map(d => [d.ticket, d.revision] as const)]);
    const runs = this.store.snapshot().runs;
    if (runs.some(r => r.id !== actor.runId && (affected.has(r.ticket) || !!r.parentTicket && affected.has(r.parentTicket))))
      throw new OwnershipRefusal('An affected ticket has an active run');
    if (this.store.verifierHandoffs.pending().some(h => affected.has(h.ticket))) throw new OwnershipRefusal('An affected verifier handoff is pending');
    for (const [ref, item] of affected) {
      if (item.revision !== revisions.get(ref)) throw new OwnershipRefusal('Split workflow changed; inspect revisions again');
      const approval = this.store.approvals.get(ref);
      if (approval?.kind === 'rejected' && !approval.authorization) throw new OwnershipRefusal('Split cannot override an approval rejection');
      if (item.status === 'Halted' || item.labels.some(l => /^(held:|health-hold:|needs-human:|error:|needs-rework:|orchestrator:escalated)/.test(l)))
        throw new OwnershipRefusal('Split preserves existing workflow holds');
      if (this.store.tasks.list(ref).some(t => ['queued', 'running', 'publishing', 'attention'].includes(t.state)))
        throw new OwnershipRefusal('An affected support task is pending');
    }
    // A declared handoff only adds prerequisites to an existing dependent. Its claim is unchanged.
    for (const child of children) this.store.authorizeWorkflow(actor.machine, actor.session, `${project}#${child.issueNumber}`, actor.runId);
    const root = this.store.recoveryFeatureRoot(ticket), actorId = `planning-split:${request.commandId}`;
    if (children.some(c => this.store.recoveryFeatureRoot(`${project}#${c.issueNumber}`) !== root))
      throw new OwnershipRefusal('Split cannot overwrite an existing child feature root or lineage');
    const byNumber = new Map(children.map(c => [c.issueNumber, c]));
    const blocker = (n: number) => { const c = byNumber.get(n)!; return { number: n, state: c.state, url: c.url }; };
    const inherit = parent.labels.filter(l => /^(priority:|requires:)/.test(l) || ['security-sensitive', 'bug', 'enhancement'].includes(l));
    let after = parent.id;
    for (const child of request.children) {
      const ref = `${project}#${child.number}`, current = byNumber.get(child.number)!;
      this.store.workflow.recoveryMetadata(ref, { featureRoot: root, grandparentNumber: parent.parentNumber }, actorId);
      this.store.workflow.change(ref, { status: 'Backlog', addLabels: inherit,
        removeLabels: current.labels.filter(l => l.startsWith('priority:') && !inherit.includes(l)),
        blockedBy: [...current.blockedBy.filter(b => b.url ? b.url !== parent.url : b.number !== parent.issueNumber),
          ...parent.blockedBy, ...child.dependsOn.map(blocker)], afterItemId: after }, actorId, `${actorId}:child:${child.number}`);
      after = current.id;
    }
    for (const dependent of request.dependents) {
      const item = affected.get(dependent.ticket)!;
      this.store.workflow.change(dependent.ticket, { blockedBy: [...item.blockedBy,
        ...dependent.children.filter(n => !item.blockedBy.some(b => b.url === byNumber.get(n)!.url)).map(blocker)] },
        actorId, `${actorId}:dependent:${dependent.ticket}`);
      this.store.workflow.comment(dependent.ticket, `Re-pointed from ${ticket} to ${dependent.children.map(n => `${project}#${n}`).join(', ')} as part of the parent's split. The original prerequisite now lives in those children.`, `${actorId}:handoff:${dependent.ticket}`);
    }
    this.store.workflow.recoveryMetadata(ticket, { featureRoot: root }, actorId);
    this.store.workflow.comment(ticket, `Replaced by ${request.children.map(c => `${project}#${c.number}`).join(', ')}.\n\n${request.summary}\n\nClosing records replacement, not feature delivery. All child acceptance and normal review remain required.`, `${actorId}:replacement`);
    const closed = this.store.workflow.change(ticket, { state: 'CLOSED', status: 'Done' }, actorId, `${actorId}:parent`);
    const result = { parent: closed, children: request.children.map(c => `${project}#${c.number}`) };
    this.db.prepare('INSERT INTO fleet_planning_splits VALUES (?,?,?,?,?)').run(request.commandId, ticket, JSON.stringify(actor), JSON.stringify(request), JSON.stringify(result));
    return result;
  }
}
