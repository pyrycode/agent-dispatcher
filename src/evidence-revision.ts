import { createHash } from "node:crypto";

/**
 * Comments that never count as ticket evidence: recovery's own reports and
 * dispatch bookkeeping. Unchanged since the evidence revision was introduced,
 * so revisions computed before and after this module agree.
 */
export const RECOVERY_BOOKKEEPING_COMMENT = /^(<!-- (?:fleet-recovery|family-dispatch|stranded-wip|auto-retry|pyry-repair-start)|## Orchestrator recovery)/;
/**
 * Pipeline status notes whose meaning the ticket's labels already carry, such
 * as a scheduled automatic retry (`error-retry-count:`). They still enter the
 * revision when it is recomputed, but a new one alone is not new evidence.
 */
const STATUS_NOTE = /^<!-- pyry-auto-retry(?:-reset)? -->/;

export interface EvidenceComment { id: string; updatedAt: string; body?: string | null }
/** What the evidence revision was last computed from: the counted comments then visible. */
export type EvidenceSeen = Array<[string, string]>;

/**
 * The issue's evidence revision: its body and the comments that count, as
 * [id, updatedAt]. The read returns only the latest few comments, so each
 * new recovery report pushes the oldest counted comment out of view. That
 * shift is not new evidence, and on 2026-10-14 it alone started 28 of 154
 * recovery assessments. The revision is therefore recomputed only when there
 * is something new: a changed body, or a visible counted comment that was not
 * seen at the last computation or has been edited since. Otherwise the
 * previous revision stands.
 *
 * Deleting a comment is not new evidence on its own. With no record of what
 * was seen, as on the first read after this was introduced, the revision is
 * recomputed exactly as before, so an unchanged ticket keeps its revision.
 */
export function issueEvidence(body: string, comments: readonly EvidenceComment[] | undefined,
  previous?: { revision?: string; body?: string; seen?: EvidenceSeen }): { revision: string; seen: EvidenceSeen; recomputed: boolean } {
  const counted = (comments ?? []).filter(c => !RECOVERY_BOOKKEEPING_COMMENT.test(c.body ?? ""));
  const visible: EvidenceSeen = counted.filter(c => !STATUS_NOTE.test(c.body ?? "")).map(c => [c.id, c.updatedAt]);
  const known = previous?.seen;
  const fresh = !previous?.revision || !known || previous.body !== body
    || visible.some(([id, at]) => !known.some(([seenId, seenAt]) => seenId === id && seenAt === at));
  if (!fresh) return { revision: previous!.revision!, seen: known!, recomputed: false };
  return {
    revision: createHash("sha256").update(JSON.stringify([body, counted.map(c => [c.id, c.updatedAt])])).digest("hex"),
    seen: visible,
    recomputed: true,
  };
}
