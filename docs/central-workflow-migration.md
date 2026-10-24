# Move workflow facts centrally, one fact at a time

This is the Later migration plan. Code changes are deferred until the checked
handover and Linux pilot complete their seven-day measurement. Moving counters,
completion and advancement together would cross several unproven authority
boundaries. One useful isolated PR cannot safely remove those boundaries today.
No second scheduler, daemon, dashboard or authoritative store is introduced.

## Existing authority to preserve

The central workflow store owns ticket state and publication. The fleet store
owns grants, generations, locks and stopped completion. Provider pacing and
infrastructure recovery have their own records. GitHub labels and board columns
are displays. A fresh or missing heartbeat never frees an uncertain run.

## First code slice: typed rework counters

1. Add a versioned counter table beside the existing workflow record. Key rows by
   ticket, counter kind and stage. Begin with builder rework only. Keep the
   infrastructure retry allowance separate. Family budget remains explicit and
   separate from a child's local count. No daily reset is implied.
2. Change one existing central completion operation to increment that counter in
   the same transaction as its accepted failure outcome. Require run ID,
   generation, workflow revision and a unique completion ID. A replay returns the
   original result. A conflicting replay or stale generation refuses everything.
3. Import existing labels once through an audited operator migration. Read the
   source workflow revision and compare it when committing. Refuse ambiguous or
   contradictory values. Preserve a private before-and-after snapshot. Do not
   infer a zero count from an absent label on an unadopted ticket.
4. Publish counter labels from the typed value for compatibility. Stop accepting
   label changes as counter writes for adopted tickets. Old workers must refuse
   the new protocol until updated. They must never reset or double-increment it.
5. Shadow-compare the typed counter and displayed label for a week. Count missing,
   stale and conflicting displays through the existing attention path. The typed
   value is the sole scheduling input. Repair only the derived display.
6. Migrate verifier retries and family budgets in separate reviewed PRs. Keep
   each counter's meaning and reset rules in the schema and operator help. An
   infrastructure interruption never consumes code rework by accident.

Required tests cover duplicate completion, failure after commit before reply,
wrong generation, lost controller response, interrupted migration, old worker
refusal, family exhaustion and a display publication outage. Use realistic
unchanged-state fixtures. Re-run the full suite and isolated runtime acceptance.

## Completion before advancement

After counters, add one typed completion record bound to a run generation,
remote branch SHA, gate results, required evidence digest and settled verdict.
Publish labels from this record. Keep code outcome, useful output and stopped
process proof separate. A failed evidence upload is not successful handover.
The handover ledger and evidence pins must exist before using completion to move
a ticket to another computer.

Move one stage transition into the same central transaction. Preserve operator
holds and relevant-change reopening. Leave the worker responsible only for
executing its grant and submitting a result. The controller chooses the next
stage exactly once. A PR merge observation is an input to that operation, never
an independent worker transition.

## Remove compensation only after replacement

Retire the per-worker housekeeping grant after every transition it performs has
a central equivalent and rollback evidence. Then remove ticket-limit gaps,
review-queue compensation and historical claim-release sweeps individually. Keep
native readiness checks and active-run generation guards. Consolidate overlapping
stall detectors into one existing attention path over central state and local
process facts. Preserve useful summaries and named failure evidence. Remove
storage duplicates only after proving every required reader uses the retained
store. No universal transcript or media transfer is part of this work.

## Rollout and rollback

Order: strict handover, one-week Linux pilot, typed rework counter, other counters,
typed completion, one central transition, remaining transitions, compensation
removal. Each schema is additive until the rollback window closes.

Before each rollout save a coherent backup and the exact runtime record. Adopt
one project with a configuration flag. Compare shadow results before switching
scheduling reads. Rollback first stops new central transitions and drains new
admission. Finish or explicitly hold existing generations. Keep the typed records
and derive legacy displays from them. Never let an older worker become a second
counter writer. An irreversible schema removal requires its own reviewed PR and
Juhana's separately approved release.

## Acceptance of the migration

Record blocked-stage minutes, manual handbacks, duplicate transition refusals,
recovery calls and housekeeping admissions for a comparable week before and
after each step. Keep throughput and safety counts together. Do not count the
review's approximate 11000 daily reconciliation admissions as an achieved saving.
Delete a compensation only when its replacement handles restart, reply loss,
operator holds and uncertain processes without manual state editing.
