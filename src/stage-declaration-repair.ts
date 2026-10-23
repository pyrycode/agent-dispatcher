/** An operator handoff repairs declarations, never the immutable acceptance verdict. */
import type { DatabaseSync } from 'node:sqlite';
import type { EvidenceStore } from './evidence-store.js';
import type { WorkflowItem } from './workflow-store.js';
import type { StageRecord } from './stage-results.js';
import { validateArtifactPath, sha256 } from './recovery-artifacts.js';
import { scrubCredentials } from './agent-runtime.js';

export interface DeclarationRepairRequest {
 commandId: string;
 ticket: string;
 revision: number;
 runId: string;
 candidate: string;
 pullRequest: number;
 evidence: { runId: string; digest: string };
 captures: string[];
}
export function declarationRepairRequest(value: DeclarationRepairRequest): DeclarationRepairRequest {
 if (!value || Object.keys(value).some(k => !['commandId', 'ticket', 'revision', 'runId', 'candidate', 'pullRequest', 'evidence', 'captures'].includes(k))
  || typeof value.commandId !== 'string' || !/^[\w.:-]{1,160}$/.test(value.commandId)
  || typeof value.ticket !== 'string' || !/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(value.ticket)
  || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.pullRequest) || value.pullRequest < 1
  || typeof value.runId !== 'string' || !/^[\w.:@-]{1,128}$/.test(value.runId)
  || typeof value.candidate !== 'string' || !/^[a-f0-9]{40}$/.test(value.candidate)
  || !value.evidence || Object.keys(value.evidence).some(k => !['runId', 'digest'].includes(k))
  || typeof value.evidence.runId !== 'string' || !/^[\w.:@-]{1,128}$/.test(value.evidence.runId)
  || typeof value.evidence.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.evidence.digest)
  || !Array.isArray(value.captures) || !value.captures.length || value.captures.length > 100
  || new Set(value.captures).size !== value.captures.length) throw new Error('Invalid declaration repair request');
 for (const path of value.captures) validateArtifactPath(path);
 return { commandId: value.commandId, ticket: value.ticket, revision: value.revision, runId: value.runId, candidate: value.candidate,
  pullRequest: value.pullRequest, evidence: { runId: value.evidence.runId, digest: value.evidence.digest }, captures: [...value.captures].sort() };
}
export class DeclarationRepairs {
 constructor(private db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS fleet_declaration_repairs (id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL) STRICT');
 }
 saved(input: DeclarationRepairRequest): WorkflowItem | undefined {
  const old = this.db.prepare('SELECT request,result FROM fleet_declaration_repairs WHERE id=?').get(input.commandId);
  if (!old) return;
  if (old.request !== JSON.stringify(input)) throw new Error('Declaration repair command identity reused');
  return JSON.parse(String(old.result));
 }
 save(input: DeclarationRepairRequest, result: WorkflowItem): WorkflowItem {
  this.db.prepare('INSERT INTO fleet_declaration_repairs VALUES (?,?,?)').run(input.commandId, JSON.stringify(input), JSON.stringify(result));
  return result;
 }
}
/** Read actual complete capture files. A log, pointer or truncated tail is not a capture. */
export function declarationCaptureFiles(input: DeclarationRepairRequest, stage: StageRecord, machine: string, evidence: EvidenceStore | undefined): void {
 if (!evidence) throw new Error('Retained capture evidence is unavailable');
 const bundle = evidence.list(input.ticket, input.evidence.runId).find(b => b.digest === input.evidence.digest);
 const acceptedOutput = stage.evidence?.runId === input.evidence.runId && stage.evidence.digest === input.evidence.digest;
 if (!bundle || bundle.machine !== machine || bundle.meta.kind !== 'gate' || bundle.role !== 'real-claude-gate'
  || bundle.meta.role !== 'real-claude-gate' || bundle.meta.candidateRevision !== input.candidate
  || !acceptedOutput && bundle.runId !== input.runId) throw new Error('Retained capture provenance does not match the source run');
 let bytes = 0;
 const read = (name: string) => {
  const file = bundle.manifest.files.find(f => f.path === name);
  if (!file || file.bytes < 1 || (bytes += file.bytes) > 768 * 1024) throw new Error('Retained capture is missing or exceeds result bounds');
  const data = Buffer.concat(file.chunks.map((_, part) => Buffer.from(evidence.read(input.ticket, bundle.runId, bundle.digest, name, part).data, 'base64')));
  const text = data.toString('utf8');
  if (data.length !== file.bytes || sha256(data) !== file.sha256 || !text.trim() || !Buffer.from(text).equals(data) || scrubCredentials(text) !== text
   || text.includes('[REDACTED]')) throw new Error('Retained capture must contain complete unscrubbed UTF8 bytes');
  return {text, bytes: data.length};
 };
 const inventory = acceptedOutput ? undefined : JSON.parse(read('run.json').text);
 if (!acceptedOutput && (!inventory || inventory.ticket !== input.ticket || inventory.runId !== input.runId || inventory.machine !== machine
  || inventory.candidateRevision !== input.candidate || !Array.isArray(inventory.files))) throw new Error('Retained capture inventory does not match the source run');
 for (const name of input.captures) {
  if (!acceptedOutput && (!/^evidence\/gate-runs\/[^/]+\/main\/.+/.test(name) || name.endsWith('.tail'))) throw new Error('A retained gate capture path is required');
  const file = read(name);
  if (inventory && !inventory.files.some((f: any) => f.path === name && f.included === 'whole' && f.bytes === file.bytes))
   throw new Error('Retained capture inventory must identify complete capture bytes');
 }
}
