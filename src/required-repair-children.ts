import type { DatabaseSync } from 'node:sqlite';
import { OwnershipRefusal, type FleetStore } from './fleet-store.js';
import type { PlanningActor } from './planning-split.js';
import { scrubCredentials } from './agent-runtime.js';

interface Ownership { machine: string; generation: string }
interface Fence { revision: number; ownership: Ownership | null }
export interface RequiredRepairDeclaration extends Fence {
  commandId: string; summary: string;
  children: Array<Fence & { number: number }>;
  repairs: number[];
}
export type RepairActor = PlanningActor | 'operator';
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
function fields(v: any, keys: string[]) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k)))
    throw new OwnershipRefusal('Invalid required repair declaration fields');
}
function fence(v: Fence): Fence {
  if (!positive(v.revision)) throw new OwnershipRefusal('Exact workflow revision required');
  if (v.ownership !== null) {
    fields(v.ownership, ['machine', 'generation']);
    if (!v.ownership.machine || typeof v.ownership.machine !== 'string' || !v.ownership.generation || typeof v.ownership.generation !== 'string')
      throw new OwnershipRefusal('Exact ownership or null required');
  }
  return { revision: v.revision, ownership: v.ownership && { machine: v.ownership.machine, generation: v.ownership.generation } };
}
export function requiredRepairDeclaration(value: unknown): RequiredRepairDeclaration {
  const v = value as RequiredRepairDeclaration;
  fields(v, ['commandId', 'summary', 'revision', 'ownership', 'children', 'repairs']);
  if (typeof v.commandId !== 'string' || !/^[\w.:@-]{1,128}$/.test(v.commandId)
      || typeof v.summary !== 'string' || !v.summary.trim() || v.summary.length > 4000 || scrubCredentials(v.summary) !== v.summary)
    throw new OwnershipRefusal('Required repair declaration needs an identity and content-free summary');
  if (!Array.isArray(v.children) || !v.children.length || v.children.length > 100 || !Array.isArray(v.repairs) || !v.repairs.length)
    throw new OwnershipRefusal('Complete child inventory and named required repairs required');
  const numbers = new Set<number>();
  const children = v.children.map(c => {
    fields(c, ['number', 'revision', 'ownership']);
    if (!positive(c.number) || numbers.has(c.number)) throw new OwnershipRefusal('Unique child numbers required');
    numbers.add(c.number);
    return { number: c.number, ...fence(c) };
  });
  if (new Set(v.repairs).size !== v.repairs.length || v.repairs.some(n => !numbers.has(n)))
    throw new OwnershipRefusal('Repairs must name unique inventoried children');
  return { commandId: v.commandId, summary: v.summary, ...fence(v), children, repairs: [...v.repairs] };
}

/** Explicit acceptance-preserving alternative to replacement finalization. */
export class RequiredRepairChildren {
  constructor(private db: DatabaseSync, private store: FleetStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_required_repair_declarations (
      id TEXT PRIMARY KEY, ticket TEXT NOT NULL, actor TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS fleet_required_repair_children (
      issue_id TEXT PRIMARY KEY, parent TEXT NOT NULL, declaration TEXT NOT NULL
    ) STRICT;`);
  }
  private ownership(ticket: string): Ownership | null {
    const row = this.db.prepare('SELECT machine,generation FROM fleet_claims WHERE ticket=?').get(ticket);
    return row ? { machine: String(row.machine), generation: String(row.generation) } : null;
  }
  inspect(ticket: string) {
    const { parent, children } = this.store.planningSplits.inspect(ticket), project = ticket.split('#')[0];
    return { revision: parent.revision, ownership: this.ownership(ticket),
      children: children.map(c => ({ number: c.issueNumber, revision: c.revision, ownership: this.ownership(`${project}#${c.issueNumber}`) })), repairs: [] as number[] };
  }
  saved(actor: RepairActor, ticket: string, request: RequiredRepairDeclaration): unknown | undefined {
    const row = this.db.prepare('SELECT * FROM fleet_required_repair_declarations WHERE id=?').get(request.commandId);
    if (!row) return;
    if (row.ticket !== ticket || row.actor !== JSON.stringify(actor) || row.request !== JSON.stringify(request))
      throw new OwnershipRefusal('Required repair command identity reused or owner changed');
    return JSON.parse(String(row.result));
  }
  declared(issueId: string, parent: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM fleet_required_repair_children WHERE issue_id=? AND parent=?').get(issueId, parent);
  }
  creatorActive(issueId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM fleet_required_repair_children c
      JOIN fleet_required_repair_declarations d ON d.id=c.declaration
      JOIN fleet_runs r ON r.id=json_extract(d.actor,'$.runId')
      WHERE c.issue_id=? AND r.finished IS NULL`).get(issueId);
  }
  hasParent(ticket: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM fleet_required_repair_children WHERE parent=?').get(ticket);
  }
  finalize(actor: RepairActor, ticket: string, input: unknown) {
    const request = requiredRepairDeclaration(input), saved = this.saved(actor, ticket, request);
    if (saved) return saved;
    if (actor !== 'operator') this.store.planningSplits.authorize(actor, ticket);
    const { parent, children } = this.store.planningSplits.inspect(ticket), project = ticket.split('#')[0];
    if (this.store.workflow.preparing(project)) throw new OwnershipRefusal('Workflow preparation is pending');
    if (parent.state !== 'OPEN') throw new OwnershipRefusal('Required repairs retain an open acceptance parent');
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(children.map(c => c.issueNumber).sort(), request.children.map(c => c.number).sort()))
      throw new OwnershipRefusal('Required repair child inventory changed or is incomplete');
    const held = this.db.prepare('SELECT issue_id FROM fleet_split_children WHERE parent=?').all(ticket);
    if (held.some(h => !children.some(c => c.issueId === h.issue_id)))
      throw new OwnershipRefusal('Creator child inventory includes an unlinked or unavailable issue');
    const affected = new Map([[ticket, parent], ...children.map(c => [`${project}#${c.issueNumber}`, c] as const)]);
    const fences = new Map<string, Fence>([[ticket, request], ...request.children.map(c => [`${project}#${c.number}`, c] as const)]);
    const allowedRun = actor === 'operator' ? undefined : actor.runId;
    if (this.store.snapshot().runs.some(r => r.id !== allowedRun && (affected.has(r.ticket) || !!r.parentTicket && affected.has(r.parentTicket))))
      throw new OwnershipRefusal('An affected ticket has an active run');
    if (children.some(c => this.db.prepare(`SELECT r.id FROM fleet_ticket_creators c JOIN fleet_runs r ON r.id=c.run_id
      WHERE c.issue_id=? AND r.finished IS NULL`).all(c.issueId).some(r => r.id !== allowedRun)))
      throw new OwnershipRefusal('An affected creator is still active');
    if (this.store.verifierHandoffs.pending().some(h => affected.has(h.ticket)))
      throw new OwnershipRefusal('An affected verifier handoff is pending');
    for (const [ref, item] of affected) {
      const expected = fences.get(ref)!;
      if (item.revision !== expected.revision || !same(this.ownership(ref), expected.ownership))
        throw new OwnershipRefusal('Required repair workflow or ownership changed; inspect again');
      const approval = this.store.approvals.get(ref);
      if (approval?.kind === 'rejected' && !approval.authorization) throw new OwnershipRefusal('Required repairs cannot override approval rejection');
      if (item.status === 'Halted' || item.labels.some(l => /^(held:|health-hold:|needs-human:|error:|needs-rework:|orchestrator:escalated)/.test(l)))
        throw new OwnershipRefusal('Required repairs preserve existing workflow holds');
      if (this.store.splits.pending(ref) || this.store.tasks.list(ref).some(t => t.artifactsPending || ['queued', 'running', 'publishing', 'attention'].includes(t.state)))
        throw new OwnershipRefusal('An affected recovery split or support task is pending');
    }
    const repairs = children.filter(c => request.repairs.includes(c.issueNumber));
    for (const child of repairs) {
      const ref = `${project}#${child.issueNumber}`;
      if (!held.some(h => h.issue_id === child.issueId)) throw new OwnershipRefusal('Required repair must have its planning creator hold');
      if (child.state !== 'OPEN' || !child.body.trim() || !['Inbox', 'Backlog', 'In Development'].includes(child.status)
          || child.status === 'In Development' && !child.labels.includes('done:refiner'))
        throw new OwnershipRefusal('Required repair must be open and awaiting refinement or implementation');
      if (!parent.blockedBy.some(b => b.state === 'OPEN' && (b.url ? b.url === child.url : b.number === child.issueNumber)))
        throw new OwnershipRefusal('Acceptance parent must retain every required repair as an open blocker');
      if (child.blockedBy.some(b => b.state === 'OPEN' && (b.url ? b.url === parent.url : b.number === parent.issueNumber)))
        throw new OwnershipRefusal('Required repair cannot wait on its acceptance parent');
      if (this.store.recoveryFeatureRoot(ref) !== this.store.recoveryFeatureRoot(ticket))
        throw new OwnershipRefusal('Required repair cannot change feature lineage');
      if (actor !== 'operator') this.store.authorizeWorkflow(actor.machine, actor.session, ref, actor.runId);
    }
    const result = { parent: ticket, repairs: repairs.map(c => `${project}#${c.issueNumber}`), acceptance: 'parent-remains-open' };
    for (const child of repairs) this.db.prepare('INSERT OR IGNORE INTO fleet_required_repair_children VALUES (?,?,?)').run(child.issueId, ticket, request.commandId);
    this.store.workflow.comment(ticket, `Required repairs: ${result.repairs.join(', ')}. The parent retains integration and acceptance. Normal child refinement, implementation, independent review and documentation remain required.\n\n${request.summary}`, `required-repairs:${request.commandId}`);
    this.db.prepare('INSERT INTO fleet_required_repair_declarations VALUES (?,?,?,?,?)').run(request.commandId, ticket, JSON.stringify(actor), JSON.stringify(request), JSON.stringify(result));
    return result;
  }
}
