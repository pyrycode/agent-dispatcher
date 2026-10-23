import { parseFeatureRoot } from "./feature-lineage.js";
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectItem } from './types.js';
import type { WorkflowItem } from './workflow-store.js';

export interface RecoverySplitEvidence {
  runId: string; digest: string; role: 'builder' | 'verifier' | 'recovery';
  findings: string[]; inspectedPaths: string[]; conclusion: string;
}
export interface RecoverySlice {
  key: string; title: string; body: string; outcome: string; checks: string[];
  kind: 'bug' | 'behaviour'; regression?: string; dependsOn: string[]; reuse: string[];
}
export interface RecoverySplitPlan {
  featureRoot: string; bodyHash: string; classification: 'accumulating-behaviours' | 'discovered-scope';
  justification: string; smallerResult: string; evidence: RecoverySplitEvidence[];
  findings: Array<{ id: string; description: string; child: string }>;
  requirements: Array<{ text: string; child: string }>;
  behaviours: Array<{ id: string; description: string; child: string; verification: string }>;
  children: RecoverySlice[];
}
export interface RecoverySplitRecord {
  id: string; ticket: string; plan: RecoverySplitPlan; scope: string;
  source: WorkflowItem; owners: Record<string, string | null>;
  affected: Record<string, string>; children: Record<string, string>;
  state: 'preparing' | 'complete';
}
const digest = /^[a-f0-9]{64}$/;
const key = /^[a-z][a-z0-9-]{0,39}$/;
const ref = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;
const text = (v: unknown, max = 6000): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
export const splitBodyHash = (body: string) => createHash('sha256').update(body).digest('hex');
const normal = (s: string) => s.replace(/\s+/g, ' ').trim();
export const splitItemBasis = (item: WorkflowItem) => splitBodyHash(JSON.stringify({body:item.body,state:item.state,status:item.status,labels:item.labels.filter(l => !['orchestrator:investigating','wip:recovery'].includes(l)).sort(),blockedBy:item.blockedBy.map(b=>b.url ?? b.number).sort(),position:item.position,root:item.featureRoot ?? null}));
export function splitRequirements(body: string): string[] {
  const requirements: string[] = [];
  let sectionDepth: number | undefined, fence: string | undefined;
  for (const line of body.split('\n')) {
    const boundary = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (boundary) { if (!fence) fence = boundary[1]; else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length) fence = undefined; continue; }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) { if (sectionDepth === undefined || heading[1].length <= sectionDepth) sectionDepth = /acceptance|requirements|security|documentation handoff/i.test(heading[2]) ? heading[1].length : undefined; continue; }
    const checkbox = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/);
    if (checkbox) requirements.push(normal(checkbox[1]));
    else if (line.trim() && (sectionDepth !== undefined || /\b(must|never|required|preserve|retain)\b/i.test(line))) requirements.push(normal(line));
  }
  return [...new Set(requirements)];
}
/** Only review/gate/security constraints may bind more than one behaviour slice. */
function sharedRequirements(body: string): Set<string> {
  const shared = new Set<string>();
  let sectionDepth: number | undefined, fence: string | undefined;
  for (const line of body.split('\n')) {
    const boundary = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (boundary) {if (!fence) fence=boundary[1];else if (boundary[1][0]===fence[0] && boundary[1].length>=fence.length) fence=undefined;continue;}
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      if (sectionDepth === undefined || heading[1].length <= sectionDepth) sectionDepth = /security review|documentation handoff|required gates|common constraints/i.test(heading[2]) ? heading[1].length : undefined;
      continue;
    }
    const value = normal(line.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, ''));
    if (value && (sectionDepth !== undefined || /\b(?:security review|acceptance gates?|live gates?|authentication checks)\b/i.test(value))) shared.add(value);
  }
  return shared;
}
export function renderRecoverySlice(plan: RecoverySplitPlan, parent: number, slice: RecoverySlice): string {
  return `${slice.body}\n\n## Observable result\n${slice.outcome}\n${plan.behaviours.filter(b=>b.child===slice.key).map(b=>b.description+'\nVerification: '+b.verification).join('\n')}\n\n## Required checks\n${slice.checks.map(c=>'- '+c).join('\n')}\n\n## Unresolved findings\n${plan.findings.filter(f=>f.child===slice.key).map(f=>f.id+': '+f.description).join('\n')}\n\nSplit from #${parent}\n\n<!-- ticket-scope-policy: behaviour-slices-v1 -->\n<!-- feature-root: ${plan.featureRoot} -->`;
}
/** The retained scope, rather than mutable titles or justifications, identifies a repeated split. */
export function recoverySplitScope(plan: RecoverySplitPlan): string {
  return splitBodyHash(JSON.stringify([
    [...new Set(plan.requirements.map(r => normal(r.text)))].sort(), plan.behaviours.map(b => normal(b.description)).sort(), plan.findings.map(f => normal(f.description)).sort(),
  ]));
}
export function validateRecoverySplit(value: unknown): RecoverySplitPlan {
  const p = value as RecoverySplitPlan;
  if (!p || JSON.stringify(p).length > 80000 || !ref.test(p.featureRoot) || !digest.test(p.bodyHash) || !['accumulating-behaviours', 'discovered-scope'].includes(p.classification)
    || !text(p.justification) || !text(p.smallerResult) || !Array.isArray(p.children) || p.children.length < 2 || p.children.length > 8
    || !Array.isArray(p.evidence) || p.evidence.length < 1 || p.evidence.length > 30
    || !Array.isArray(p.findings) || !p.findings.length || p.findings.length > 100
    || !Array.isArray(p.requirements) || !p.requirements.length || p.requirements.length > 100
    || !Array.isArray(p.behaviours) || p.behaviours.length < 2 || p.behaviours.length > 100) throw new Error('Invalid recovery split plan');
  for (const child of p.children) {
    const markedRoot = parseFeatureRoot(child.body, p.featureRoot.split('#')[0]);
    if (/<!-- ticket-scope-policy: (?!behaviour-slices-v1 -->)/.test(child.body)) throw new Error('Recovery children must preserve the admitted behaviour-slices policy');
    if (markedRoot && markedRoot !== p.featureRoot) throw new Error('Conflicting feature root in recovery child');
  }
  const preceding = new Set<string>();
  for (const child of p.children) {
    if (!child || !key.test(child.key) || preceding.has(child.key) || !text(child.title, 200) || !text(child.body, 50000)
      || !text(child.outcome) || !['bug', 'behaviour'].includes(child.kind)
      || !Array.isArray(child.checks) || !child.checks.length || child.checks.some(c => !text(c))
      || !Array.isArray(child.dependsOn) || child.dependsOn.some(k => !preceding.has(k))
      || !Array.isArray(child.reuse) || child.reuse.some(r => !text(r))
      || child.kind === 'bug' && (!text(child.regression) || !normal(child.body).includes(normal(child.regression!))))
      throw new Error('Each recovery child needs a useful behaviour, checks, ordered dependencies and its bug regression');
    preceding.add(child.key);
  }
  const ids = new Set<string>();
  for (const f of p.findings) {
    if (!f || !key.test(f.id) || ids.has(f.id) || !text(f.description) || !preceding.has(f.child)) throw new Error('Every unresolved finding needs one named child');
    ids.add(f.id);
  }
  const requirements = new Set<string>();
  for (const r of p.requirements) {
    const child = p.children.find(c => c.key === r?.child);
    if (!r || !text(r.text) || requirements.has(normal(r.text) + ':' + r.child) || !child || !normal(child.body).includes(normal(r.text)))
      throw new Error('Every acceptance requirement must survive in its assigned child');
    requirements.add(normal(r.text) + ':' + r.child);
  }
  const behaviours = new Set<string>();
  for (const b of p.behaviours) {
    if (!b || !key.test(b.id) || behaviours.has(normal(b.description)) || !text(b.description) || !text(b.verification) || !preceding.has(b.child))
      throw new Error('Invalid observable behaviour inventory');
    behaviours.add(normal(b.description));
  }
  for (const child of p.children) {
    for (const requirement of p.requirements) {
      if (!p.requirements.some(r => r.text === requirement.text && r.child === child.key) && normal(child.body).includes(normal(requirement.text)))
        throw new Error('A child body repeats scope allocated solely to another child');
    }
    const assigned = p.behaviours.filter(b => b.child === child.key);
    if (!assigned.length || assigned.length >= p.behaviours.length) throw new Error('Each result must contain a strict subset of observable behaviours');
    if (!p.findings.some(f => f.child === child.key)) throw new Error('A recovery child must be a smaller independently verifiable part of the retained scope');
  }
  const roles = new Set<string>();
  for (const e of p.evidence) {
    if (!e || !text(e.runId, 128) || !digest.test(e.digest) || !['builder', 'verifier', 'recovery'].includes(e.role)
      || !text(e.conclusion) || !Array.isArray(e.inspectedPaths) || !e.inspectedPaths.length || e.inspectedPaths.some(p => !text(p, 500)) || !Array.isArray(e.findings) || e.findings.some(id => !ids.has(id))) throw new Error('Invalid retained recovery split evidence');
    roles.add(e.role);
  }
  const requiredRoles = p.classification === 'discovered-scope' ? ['builder'] : ['builder', 'verifier', 'recovery'];
  if (requiredRoles.some(role => !roles.has(role)) || p.findings.some(f => !p.evidence.some(e => e.findings.includes(f.id))))
    throw new Error(`Inspect retained ${requiredRoles.join(', ')} evidence and account for every finding`);
  return structuredClone(p);
}
export function validateSplitAgainstTicket(plan: RecoverySplitPlan, item: ProjectItem, root: string): void {
  if (plan.bodyHash !== splitBodyHash(item.body)) throw new Error('Split scope changed; reassess retained evidence');
  if (plan.featureRoot !== root) throw new Error('Recovery split must retain the original feature root');
  const expected = [...new Set(splitRequirements(item.body))].sort();
  if (!expected.length || JSON.stringify(expected) !== JSON.stringify([...new Set(plan.requirements.map(r => normal(r.text)))].sort()))
    throw new Error('Recovery split must preserve every original acceptance requirement');
  const shared = sharedRequirements(item.body);
  const productRequirements = expected.filter(r=>!shared.has(r));
  for (const requirement of productRequirements) {
    if (plan.requirements.filter(r=>normal(r.text) === requirement).length !== 1) throw new Error('Observable acceptance scope cannot be duplicated across children');
  }
  const prior = (item as ProjectItem & {recoverySlice?:{behaviours:string[]}}).recoverySlice;
  if (prior && JSON.stringify([...prior.behaviours].sort()) !== JSON.stringify(plan.behaviours.map(b => normal(b.description)).sort()))
    throw new Error('A further recovery split must partition the immutable previously assigned behaviour scope');
  if (item.labels.some(l => l === 'error:infra' || /^(?:flaky-test|inherited-test-failure)$/.test(l))) throw new Error('Infrastructure and flaky-test failures require their own recovery');
  if (plan.classification === 'discovered-scope') {
    if (!item.labels.includes('error:builder:scope')) throw new Error('Discovered-scope split requires a retained builder scope handoff');
  } else if (!item.labels.some(l => /^rework-count:\d+$/.test(l) && Number(l.split(':')[1]) >= 2)) throw new Error('Recovery splitting requires repeated rework evidence');
}

/** Only used by the claim authority, in the same transactions as workflow writes. */
export class RecoverySplits {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_recovery_splits (
      id TEXT PRIMARY KEY, ticket TEXT NOT NULL UNIQUE, plan TEXT NOT NULL, scope TEXT NOT NULL,
      affected TEXT NOT NULL, children TEXT NOT NULL, state TEXT NOT NULL, source TEXT NOT NULL, owners TEXT NOT NULL
    ) STRICT;`);
  }
  get(id: string): RecoverySplitRecord | undefined {
    const row = this.db.prepare('SELECT * FROM fleet_recovery_splits WHERE id=?').get(id);
    return row ? { id: String(row.id), ticket: String(row.ticket), plan: JSON.parse(String(row.plan)), scope: String(row.scope),
      source: JSON.parse(String(row.source)), owners: JSON.parse(String(row.owners)), affected: JSON.parse(String(row.affected)), children: JSON.parse(String(row.children)), state: row.state as RecoverySplitRecord['state'] } : undefined;
  }
  pending(ticket: string): boolean {
    return this.db.prepare("SELECT affected,children FROM fleet_recovery_splits WHERE state='preparing'").all()
      .some(r => Object.hasOwn(JSON.parse(String(r.affected)), ticket) || Object.values(JSON.parse(String(r.children))).includes(ticket));
  }
  prepare(id: string, ticket: string, plan: RecoverySplitPlan, affected: WorkflowItem[], project: string, owners: Record<string,string|null>): RecoverySplitRecord {
    const old = this.get(id);
    if (old) {
      if (old.ticket !== ticket || JSON.stringify(old.plan) !== JSON.stringify(plan)) throw new Error('Recovery split identity reused');
      return old;
    }
    const scope = recoverySplitScope(plan);
    if (this.db.prepare('SELECT 1 FROM fleet_recovery_splits WHERE ticket=? OR (json_extract(plan,\'$.featureRoot\')=? AND scope=?)').get(ticket, plan.featureRoot, scope))
      throw new Error('This unchanged scope already has a recovery split');
    this.db.prepare("INSERT INTO fleet_recovery_splits VALUES (?,?,?,?,?,?,'preparing',?,?)")
      .run(id, ticket, JSON.stringify(plan), scope, JSON.stringify(Object.fromEntries(affected.map(i => [`${i.url.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] ?? project}#${i.issueNumber}`, splitItemBasis(i)]))), '{}',JSON.stringify(affected.find(i => i.url === `https://github.com/${ticket.replace('#','/issues/')}`)),JSON.stringify(owners));
    return this.get(id)!;
  }
  child(id: string, key: string, ticket: string): void {
    const record = this.get(id)!;
    if (record.children[key] && record.children[key] !== ticket) throw new Error('Recovery child identity changed');
    record.children[key] = ticket;
    this.db.prepare('UPDATE fleet_recovery_splits SET children=? WHERE id=?').run(JSON.stringify(record.children), id);
  }
  enlist(id: string, ticket: string, basis: string, owner: string|null): void {
    const record = this.get(id)!;
    record.affected[ticket] = basis; record.owners[ticket] = owner;
    this.db.prepare('UPDATE fleet_recovery_splits SET affected=?,owners=? WHERE id=?').run(JSON.stringify(record.affected),JSON.stringify(record.owners),id);
  }
  bindChild(id: string, ticket: string, basis: string): void {
    const record = this.get(id)!;
    record.affected[ticket] = basis; record.owners[ticket] = null;
    this.db.prepare('UPDATE fleet_recovery_splits SET affected=?,owners=? WHERE id=?').run(JSON.stringify(record.affected),JSON.stringify(record.owners),id);
  }
  complete(id: string): void { this.db.prepare("UPDATE fleet_recovery_splits SET state='complete' WHERE id=?").run(id); }
}
