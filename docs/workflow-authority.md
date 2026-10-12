# Orchestrator workflow authority

After a project is imported, the central SQLite database owns its stage, labels,
issue lifecycle, dependencies, priority and workflow history. Dispatchers read
that database through their machine manager. GitHub labels and board columns
are an eventually updated display. Editing them in GitHub cannot schedule work
or clear a hold. The publisher restores the database values.

GitHub still stores issue descriptions, discussion, pull requests and code.
Newly discovered issues enter Inbox. Existing ticket descriptions and family
relationships are refreshed from GitHub. PR merge evidence records completion
in the database. Authenticated operator commands are the way to change workflow.

## Writes and publication

A worker must own its active reservation to write. Each admitted worker gets a
GitHub bridge carrying its run identity. Existing agent `gh` label, stage, issue
state and dependency commands are translated into database changes. Finished
workers cannot publish a late verdict or change workflow. Cross-ticket writes
retain the existing ownership rules.

Finishing a run removes that role's running marker in the same transaction as
releasing its reservation. GitHub availability cannot leave a completed builder
marked as running. Uncertain workers keep their reservations.

Commands carry an identity and can require the revision the caller read. Changes,
audit events and pending display publication commit together. Every 30 seconds,
the central publisher batches up to ten changed tickets per project into one
GraphQL request. GitHub has no atomic update-all-tickets operation. Partial or
failed responses remain pending. Acknowledging an older revision cannot clear a
newer pending change. Projects retry independently.

Result comments are saved before publication. The publisher uses a stable marker
to find an earlier successful POST after an uncertain response. Workflow counters
read saved history. Issue discussion remains available through GitHub. A five
minute content scan discovers issues and repairs display drift. Initial import
publication may take several cycles. Current changes take priority over history.

## Migration

Use the existing protected operator and GitHub logins. Never place credentials in
request files or command arguments.

1. Merge and install the new controller source and its locked dependencies. Update
   the central service and every machine manager before advancing consumer pins.
   Before import, the new code retains the old project behaviour.
2. Save the current claims, reservations and drain policies. Prepare each project through the central migration command. This blocks new
   admission across all computers without changing their saved drain policies.
   Let all workers and their child processes finish. Preserve intentionally stopped services.
3. Verify every participating dispatcher loaded the new source and the shared
   GitHub bridge is enabled. An imported project rejects old worker admission.
4. Back up the SQLite database. Export each board after draining. The export
   refuses incomplete issue metadata or comment history. Inspect its holds,
   running markers, stages, blockers and counters. Resolve uncertain markers only
   from worker evidence. Do not blanket-clear them.
5. Import the saved export with the operator credential. Import is transactional,
   refuses active project reservations and refuses a second import. Re-read the
   project and compare ticket counts and workflow fields with the saved export.
6. Activate each imported project. Existing project drain policies remain intact. Confirm database-driven
   admission and GitHub display convergence. Keep the migration snapshots private.

The argument order is command, configuration, action, project, then file:

```sh
node --import tsx src/fleet-bin.ts workflow OPERATOR_CONFIG prepare owner/repo
node --import tsx src/fleet-bin.ts workflow EXPORT_CONFIG export owner/repo snapshot.json 5
node --import tsx src/fleet-bin.ts workflow OPERATOR_CONFIG import owner/repo snapshot.json
node --import tsx src/fleet-bin.ts workflow OPERATOR_CONFIG read owner/repo
node --import tsx src/fleet-bin.ts workflow OPERATOR_CONFIG activate owner/repo
node --import tsx src/fleet-bin.ts workflow OPERATOR_CONFIG change owner/repo change.json
```

`cancel-preparation` releases the migration admission hold only before import.
After import, use `activate` with compatible workers.

The export config supplies `githubTokenEnv` or `github.tokenEnv`. The optional
final export argument is the GitHub project number. It can instead come from
`projects[].projectNumber`. The operator config supplies `claimsUrl` and
`claimsOperatorTokenEnv` or `claimsTokenEnv`.

An operator change uses the revision returned by `read`:

```json
{
  "commandId": "a-unique-id-retained-for-retries",
  "ticket": "owner/repo#1947",
  "revision": 12,
  "change": {
    "status": "In Development",
    "removeLabels": ["needs-rework:builder"],
    "addLabels": ["priority:high"]
  }
}
```

A stale revision or active reservation rejects the command. Read again and
resolve the actual state. Reuse the same command identity only for the exact same
request. The controls also support `state`, `labels`, `blockedBy` and `top`.
Changing a status does not bypass dependency, review, ownership or admission checks.

## Recovery and rollback

The database is now required for scheduling. If it is unavailable, workers fail
closed. Fix the central service instead of switching a worker back to GitHub.
Keep normal SQLite backups on the central machine. Never restore an old database
while workers are running. Never downgrade an imported project to an old dispatcher.

A rollback requires draining the project, saving the current database state,
finishing display publication and verifying an export against the database before
restoring the previous control path. There is deliberately no automatic fallback
or live unimport command that could create two authorities.
