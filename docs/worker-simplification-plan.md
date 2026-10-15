# Reduce workers after reducing their responsibilities

This is the Later design and migration plan. Consolidating per-board workers now
would combine scheduling, reconciliation, authentication, evidence and native
process custody before those responsibilities shrink. The first safe slice is a
reviewable removal plan. No runtime process, legacy mirror or migration is deleted
without proof from the approved fleet rollout.

## Desired final responsibility

One existing worker per computer may eventually execute centrally granted jobs
for several projects. It still owns local child processes, work directories,
readiness and upload retries. The central service owns stage choice, workflow
facts, desired controls and assignment. Keep native project isolation and resource
limits inside the existing admission model. Do not replace either authority or
add a daemon to coordinate the migration.

## Prerequisites

- Complete strict handover with required evidence pins and exact remote commit
  checks. Finish the bounded Linux reassignment pilot and review a week's results.
- Move counter and completion facts centrally. Migrate each housekeeping
  transition before removing that worker path.
- Enforce execution-account isolation. Keep merge, release and gate policy outside
  agent-readable storage. A shared worker must not expand project credentials.
- Preserve per-project desired drains, stops, native requirements, displays and
  the Mobile heavy limit. A project pause cannot become a computer-wide restart.
- Prove coherent backup and held restore. Keep generation and stopped-process
  checks across controller and worker restarts.

## Inventory before deletion

Use the existing operation reports to record every configured manager,
supervisor and project worker with its runtime record. Name the owner of every
remaining transition, credential, evidence reader and child process. Retained
required artifacts cannot be replaced by a local pointer. List all compatibility
readers of the old in-memory drain, local drain files, legacy recovery labels and
old migration code. Unknown or offline readers block removal. Do not use a stale
heartbeat as evidence that a reader no longer exists.

## Small removals, each with its own PR

1. Retire the manager's old in-memory drain endpoint only after every manager
   acknowledges saved desired controls. Keep a rollback snapshot. Verify restart
   under every saved drain and stop leaves new admission blocked.
2. Remove duplicate local control writes only after every rollback version reads
   the central applied-state mirror. Preserve a single rollback representation
   until that window closes. Do not delete the mirror and its only reader in
   different releases without a compatibility plan.
3. Remove one old label migration after all configured projects have a recorded
   adoption revision, an exercised rollback and no old writer. Keep the private
   migration receipt. Do not replay a historical migration on current workflow.
4. Consolidate duplicate evidence copies only after all later roles use shared
   reads and required bundles are pinned. Preserve outboxes until uploads are
   acknowledged. Keep failure records needed for diagnosis and restore.
5. Remove a duplicated detector when the existing attention path covers its
   exact trigger, acknowledgement and relevant-change reopening. Test an
   uncertain native task and an unreachable computer before deleting it.

Record the last supported rollback revision for each removal. Record how controls
or evidence behaved before and after. A test of identical helper logic is insufficient.
Exercise the old reader against the new writer before its removal.

## Bounded worker consolidation

After the prerequisites, prototype one Linux computer with two low-risk projects
in a disposable runtime. Keep one project credential context per grant. A queued
job cannot inherit another project's environment, repository, token, display or
output directory. Keep one code-building agent and existing provider pacing.

Start with sequential execution. Preserve project drains during restart. Retain
active child groups and their reservations through a controller outage. Only
confirmed completion returns capacity. An unacknowledged result remains in the
existing outbox and does not execute again after restart.

Shadow the proposed worker against the old scheduling decisions without starting
second jobs. Then Juhana may approve replacing one stopped per-board worker at a
time. A single computer's success does not establish native Mac readiness. Do
not expand default concurrency to compensate for a consolidation failure.

## Rollback and decision criteria

Drain new work first. Confirm all old and new child groups stopped. Restore the
previous worker arrangement using the recorded runtime and saved desired state.
Keep unfinished generations held until accounted for. Never launch the old worker
beside an uncertain replacement. Reconcile final results before allowing a new
grant. No rollback changes a pin or target without a separately approved release.

Compare a week of restarts, blocked-stage minutes, manual handbacks, lost evidence,
resource pressure and useful completions. Consolidate only if it reduces overhead
without weakening project isolation or custody. Otherwise keep per-board workers
and retain the smaller simplifications. Fewer processes alone is not success.
