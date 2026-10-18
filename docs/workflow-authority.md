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

## Accepted stage results

Managed verifier and live acceptance work now record requirements and results through the central authority. GitHub verdict comments display accepted results. They do not establish completion. See [accepted stage results](stage-results.md) for evidence requirements, worker reads and rollout order.

## Writes and publication

A worker must own its active reservation to write. Each admitted worker gets a
GitHub bridge carrying its run identity. Existing agent `gh` label, stage, issue
state and dependency commands are translated into database changes. A
translated mutation answers with only the fields the caller selected, as GitHub
would. `gh` decodes GraphQL strictly, so one unrequested field makes it report
a failure for a change that was already saved. That happened to every status,
label, comment and close command in Mobile #1984's split on 2026-10-13. Finished
workers cannot publish a late verdict or change workflow. Cross-ticket writes
retain the existing ownership rules.

An active parent refiner or PO can transfer a cross-project prerequisite to a
split child. The dependent must already depend on that parent. The added blocker
must be an imported child of that same parent in the planner's project. The
operation adds the child and retains every existing blocker. Once that child edge
exists, the planner can post its handoff comment on the dependent through either
GraphQL or REST. A dependent with an active run refuses both operations, even on
the same computer. The dependent's ownership, stage, labels and holds stay intact.
Finished runs, other roles, unrelated tickets, dependency removals and general
foreign workflow edits remain refused. A permission refusal is reported to the
worker as an ownership refusal with its reason, rather than a service outage.

Finishing a run removes that role's running marker in the same transaction as
releasing its reservation. GitHub availability cannot leave a completed builder
marked as running. Uncertain workers keep their reservations.

Commands carry an identity and can require the revision the caller read. Changes,
audit events and pending display publication commit together. Every 30 seconds,
the central publisher batches up to ten changed tickets per project into one
GraphQL request. GitHub has no atomic update-all-tickets operation. Partial or
failed responses remain pending. Acknowledging an older revision cannot clear a
newer pending change. Projects retry independently.

Each ticket in a batch is acknowledged on its own. A GraphQL error tied to one
ticket's alias, or a failed position or dependency write, keeps only that ticket
pending. It then waits 30 seconds, doubling to at most 15 minutes, unless a newer
database revision arrives first. Waiting tickets do not take one of the ten batch
places. The log names the ticket, its revision and GitHub's error text. An error
GitHub does not tie to one alias, and a 5xx or 429 answer on any call, including
the shared budget's own pause, still hold the whole project batch without a
per-ticket backoff. A link GitHub calls already present is accepted only after a
fresh read shows it. If GitHub
refuses a dependency as a cycle because it still shows the reverse link, the
publisher removes that link when the blocker's own database record does not want
it. A cycle recorded in the database itself is reported and left for an operator.

A failure tracker is the one ticket a run may write without its claim. The
dispatcher's flaky-test and shared live failure tickets usually belong to the
computer that filed or fixed them, and a closed ticket keeps its claim, so an
occurrence comment or a reopen from another computer would be refused.
`/flaky/track` takes them instead. It needs an active run of the caller, a
ticket carrying `flaky-test` (or `bug` for a shared live failure) that names
one of the tests on its marker line, and no other run active on the ticket. A
reopen sets the ticket open, moves it to Backlog and drops `merged` and the
stage markers, with the comment, in one transaction. It is new work, so it
also releases the closed ticket's claim unless a support task is open on it.
See [flaky-tests.md](flaky-tests.md).

A pull request is not a workflow ticket. Comments on a PR go straight to GitHub,
both from agents through the bridge and from the dispatcher's
`addPullRequestComment`. The store never queues them, but it still checks
ownership: the dispatcher asks `/workflow/authorize` for the PR's ticket, which
refuses a finished run or lost ownership exactly as a ticket comment would.
With no admitted run, as in the pending-verdict sweep, the machine's claim on
the ticket decides. The central service must carry this route before managers
and dispatchers do; until then a PR comment fails closed and the verdict stays
pending. Until 2026-10-14 the dispatcher sent a saved verifier
verdict to the store as a ticket comment on the PR number, and the store refused
it as an unknown ticket (Mobile #2148, PR #2150). A saved verdict is idempotent
on its own terms: before posting, the dispatcher reads the PR back and skips the
post when its run marker or the same body is already there, including a copy a
human pasted by hand.

Result comments are saved before publication. The publisher uses a stable marker
to find an earlier successful POST after an uncertain response. Workflow counters
read saved history. Issue discussion remains available through GitHub. A five
minute content scan discovers issues and repairs display drift. Initial import
publication may take several cycles. Current changes take priority over history.
Archived GitHub cards stay archived. Their issue labels still update, but GitHub
refuses column and position changes while archived. Restoring a card allows the
next content scan to resume its column display updates. Archiving is a display
choice and does not change the database workflow or pause scheduling.
Position updates use the nearest preceding unarchived card, or the top when
there is none. Archived neighbours do not prevent dependency publication.

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
request. The controls also support `state`, `labels`, `blockedBy`, `top` and `afterItemId`.
Changing a status does not bypass dependency, review, ownership or admission checks.

### Approval review continuation

Approval outcomes belong to the claim database, separately from ticket prose and
GitHub labels. Only an admitted source run can report the dispatcher's observed
review failure or safety rejection. A safety rejection takes precedence over a
review outage. Replayed reports cannot change their kind. Finished runs cannot
report new outcomes. The next worker receives the saved distinction in its role
instructions. Normal approval checks remain required.

An unresolved safety rejection blocks new ordinary admission even when its error
label is removed. Recovery may still inspect it. After reviewing the saved stop,
an operator can authorise continuation from preserved work:

```sh
operator.sh workflow approval-authorize owner/repo decision.json
```

```json
{
  "commandId": "approval-decision-1947-1",
  "ticket": "owner/repo#1947",
  "runId": "exact-source-run-from-approvalState",
  "revision": 12,
  "reason": "Reviewed the recorded refusal and authorised continuation from the saved commit."
}
```

Read `approvalState` and the workflow revision with the protected workflow read
command first. The decision is operator-only and binds to that recorded run. It
atomically records permission, clears that role's error and escalation labels and
adds recovery priority. It preserves stage, ownership, retry counts, blockers and
other holds. An active worker or stale revision refuses the whole change. Repeat
an uncertain request with the same command identity and exact arguments. A fresh
safety rejection requires a fresh decision. Neither ticket text nor an old
decision can bypass a new approval check. Operator reasons remain audit data and
are never inserted as instructions in the worker prompt.

Deploy the claim service and every manager before advancing consumer dispatcher
pins. Workers running the older version produce no approval records. Historical
stops without such records still require ordinary operator investigation.

### Filing a ticket

An interactive session files a new ticket in one step:

```sh
node --import tsx src/fleet-bin.ts workflow OPERATOR_CONFIG file owner/repo request.json
```

```json
{
  "commandId": "a-unique-id-retained-for-retries",
  "title": "Show the relay state on the phone",
  "body": "Issue description in Markdown.",
  "labels": ["enhancement"],
  "workflow": {
    "stage": "Backlog",
    "labels": ["priority:high", "done:refiner"],
    "blockedBy": [2101, 2102]
  }
}
```

`commandId`, `title` and `body` are required. `labels` are GitHub content labels
and must not use the workflow prefixes `wip:`, `done:`, `error:`,
`needs-rework:`, `claim:` or `orchestrator:`. Those go in `workflow.labels`. The
`workflow` block is optional. Its stage defaults to Inbox. Each blocker is a
ticket number that the database already holds in the same project. The whole
request is checked before anything is written to GitHub.

The central service creates the issue with its own GitHub credential, adds it to
the board and registers it as the bridge does when a worker creates an issue.
It then applies the stage, workflow labels and blockers in one transaction and
saves the answer with it. The command prints the ticket, issue number, URL,
revision and the item as the database now holds it. GitHub's labels and column
follow through the publisher.

A failed filing is retried with the same request file. The same `commandId` with
the same request never creates a second issue. A finished filing answers with
its first result. If the issue was created but registration failed, the retry
reuses that issue. If GitHub's answer to the creation was lost, the retry finds
the issue by a hidden `<!-- orchestrator-filing:ID -->` line at the end of its
body. Reusing a `commandId` with a different request is refused. A retry also
converges when the content scan registered the issue in Inbox in between. It
refuses only when the ticket meanwhile has an active reservation.

## Recovery labels

Recovery priority and the repair run have separate labels since 2026-10-14.
`orchestrator:recovery-priority` gives an assigned repair recovery priority
through all later stages and waits. `wip:repair` shows only the
assigned repair run, from the handback until that run finishes. The
[machine manager](machine-manager.md) describes when each appears and goes.

The old `orchestrator:fixing` had both meanings. Every reader in this release
treats it as `orchestrator:recovery-priority`. The rename is rolled out in two
steps, because dispatchers of both versions run during a rollout and an older
dispatcher reads only the old name.

1. This release. Handbacks write both names and cleanup removes both. When the
   central service starts, it adds `orchestrator:recovery-priority` to every
   saved ticket that carries only `orchestrator:fixing`. Each such change is a
   workflow command by `migration:recovery-priority` in the ticket's history.
   A converged store changes nothing, so restarts are safe. A ticket handed back
   by an older dispatcher keeps only the old name until the next central start.
   It loses no priority, because every reader accepts either name.
2. Retirement, once every dispatcher and machine manager runs this release or
   later. Set `WRITE_LEGACY_RECOVERY_PRIORITY` in `src/recovery-labels.ts` to
   `false` and deploy. At its next start the central service removes
   `orchestrator:fixing` from every saved ticket, again once and recorded. When
   the boards show no `orchestrator:fixing`, delete the GitHub label in each
   repository, for example
   `gh label delete orchestrator:fixing -R pyrycode/pyrycode --yes`.

The publisher creates `orchestrator:recovery-priority` and `wip:repair`
on GitHub the first time a ticket needs them, each with its family colour from
`src/label-colors.ts` (`wip:repair` is the blue of every `wip:` label) and a short
description. A label that already exists keeps its colour and description.

The repair marker was named `orchestrator:repairing` for a day (PR 238) and was
renamed to `wip:repair`. Handbacks write only the new name. Every reader and the
cleanup take either, because a dispatcher from before the rename can still hand
back with the old one. When the central service starts, it replaces
`orchestrator:repairing` with `wip:repair` on every saved ticket, one recorded
workflow command by `migration:wip-repair` each. A converged store changes
nothing, so restarts are safe. The migration is not a new assignment: the
settling rule still dates the repair from the handback that wrote the old name.
Roll the central service out before any dispatcher: an old central refuses a stage run
on a ticket that carries any `wip:` label, `wip:repair` included, and would never settle
it. Rework routing waits only for a running agent label, so a leftover marker cannot
block a `needs-rework:` route, and the route strips it.
Once the boards show no `orchestrator:repairing`, delete the GitHub label in each
repository, for example
`gh label delete orchestrator:repairing -R pyrycode/pyrycode --yes`.

## Recovery and rollback

The database is now required for scheduling. If it is unavailable, workers fail
closed. Fix the central service instead of switching a worker back to GitHub.
Keep normal SQLite backups on the central machine. Never restore an old database
while workers are running. Never downgrade an imported project to an old dispatcher.

A rollback requires draining the project, saving the current database state,
finishing display publication and verifying an export against the database before
restoring the previous control path. There is deliberately no automatic fallback
or live unimport command that could create two authorities.

### Recovery splits after repeated rework

The recovery assessor can propose `action: "split"` after retained reviews show
new independently useful behaviours accumulating during repair. Two reworks
trigger assessment. They do not establish that splitting is justified. A
shrinking defect stays with its shared-cause repair. Infrastructure outages,
broken test preparation and flaky tests keep their existing recovery route.
The assessor must inspect substantive retained builder, verifier and recovery
artifacts. Bundle metadata and pointers alone cannot authorise a split.

The claim service owns the split. It can exceed the ordinary refiner depth
limit. The ordinary refiner limit remains unchanged. Each new child carries the `behaviour-slices-v1` policy marker and starts in
Backlog without completion labels and receives ordinary refinement, building,
security review, verification and required live gates.

The assessment prompt supplies `facts[].splitContext` with the exact body hash,
original feature root, original acceptance requirements and any immutable
previous behaviour allocation. It supplies verified bundle digests and the
substantive paths actually read. A split decision has this shape:

```json
{
  "action": "split",
  "reason": "Earlier repairs fixed host selection. Later reviews exposed independently useful history and task-menu results.",
  "split": {
    "featureRoot": "owner/repo#100",
    "bodyHash": "64-character hash supplied by splitContext",
    "classification": "accumulating-behaviours",
    "justification": "Explain why the retained failures justify another split.",
    "smallerResult": "Explain how each narrower result can merge and be checked while the app works.",
    "evidence": [
      { "runId": "builder-run", "digest": "verified bundle digest", "role": "builder", "findings": ["history"], "inspectedPaths": ["logs/builder.log"], "conclusion": "What the actual retained work proves." },
      { "runId": "verifier-run", "digest": "verified bundle digest", "role": "verifier", "findings": ["history", "menu"], "inspectedPaths": ["handoff/verifier-101.md"], "conclusion": "Which findings were fixed and which distinct behaviours remain." },
      { "runId": "earlier-recovery-run", "digest": "verified bundle digest", "role": "recovery", "findings": ["menu"], "inspectedPaths": ["logs/recovery.log"], "conclusion": "Compare earlier recovery with the latest failure." }
    ],
    "findings": [
      { "id": "history", "description": "Selected host history loses isolation.", "child": "history" },
      { "id": "menu", "description": "Background task menu is independently stale.", "child": "menu" }
    ],
    "behaviours": [
      { "id": "history", "description": "Selected host history stays isolated", "child": "history", "verification": "Cross-host history regression." },
      { "id": "menu", "description": "Background task menu updates independently", "child": "menu", "verification": "Background completion updates its menu." }
    ],
    "requirements": [
      { "text": "Selected host history stays isolated", "child": "history" },
      { "text": "Background task menu updates independently", "child": "menu" }
    ],
    "children": [
      { "key": "history", "title": "Preserve selected host history", "body": "## Acceptance Criteria\n- [ ] Selected host history stays isolated\nRegression: history cannot cross hosts", "outcome": "Selected host history stays isolated", "checks": ["History isolation regression fails before and passes after the fix."], "kind": "bug", "regression": "Regression: history cannot cross hosts", "dependsOn": [], "reuse": ["Preserved parent branch and exact candidate commit."] },
      { "key": "menu", "title": "Update background task menu", "body": "## Acceptance Criteria\n- [ ] Background task menu updates independently\nRegression: menu follows task completion", "outcome": "Background task menu updates independently", "checks": ["Background task completion updates the menu."], "kind": "bug", "regression": "Regression: menu follows task completion", "dependsOn": ["history"], "reuse": ["Preserved parent review and exact candidate commit."] }
    ]
  }
}
```

Replace the hash and digest descriptions with values supplied by the authority.
Use exact requirement text. Plain prose and nested acceptance clauses count,
as do security requirements and documentation handoffs. Every unresolved
finding names its child. Observable requirements belong to one child. Common
security reviews and acceptance gates can bind several children. The authority
rejects copied whole-scope child bodies and keeps a bug with its regression.
Each child must contain a strict subset of the source's observable behaviours.
An original criterion can cover several behaviours. Preserve that full criterion
in the final dependent child, which can check it after earlier siblings merge.
Earlier children still need their own useful outcome, finding and independent
proof. The criterion count never establishes the split boundary. File boundaries and line counts do not establish a useful result.

A later recovery split must partition the exact behaviour inventory assigned by
the previous recovery split. Rewording that inventory or supplying a new title
cannot obtain another split. Missing evidence or an indivisible result remains
unresolved for ordinary recovery. It never becomes permission to drop a
requirement. The source body, exact plan, evidence references and allocation
remain in the durable split record.

Before creating anything, the authority verifies every named artifact against
the retained bundle and run owner. It checks every complete rendered child
request. It captures the parent, descendants, dependents and their ownership.
Any affected active reservation or queued, running, publishing or unresolved
support task prevents the split. Holds, approval rejections and operator drains
remain effective. The split never releases claims or changes an existing
branch, commit or pull request.

Each child filing uses one durable identity. During creation it stays in Inbox
and depends on the open parent. The authority also refuses starts from partial
filing markers. It reads parentage before retrying a link after a lost answer.
It verifies the exact intended body, labels and lineage before binding a child.
All original parent evidence is pinned against expiry and capacity eviction.
An upload that cannot fit around pinned evidence is refused.

One final transaction activates every child, preserves causal blockers, orders
children after the parent and chains siblings. It adds child blockers to outside
dependents before closing the replaced parent. A newly discovered dependent is
safely enlisted under the same worker, ownership and hold checks. Existing
parent blockers remain as history. Closing the replaced parent records that
the original feature is incomplete. Feature completion requires the named leaf
results to merge and pass the full acceptance contract.

### Retrying a stopped recovery split

Use the protected operator wrapper with the original incident identity:

```sh
operator.sh workflow recovery-split owner/repo retry.json
```

```json
{ "id": "original-recovery-incident-uuid" }
```

The equivalent fleet command is:

```sh
node --import tsx src/fleet-bin.ts workflow OPERATOR_CONFIG recovery-split owner/repo retry.json
```

The request accepts only the retained incident id. It cannot replace the plan.
The protected route is `POST /recovery/split`. It requires the admitted recovery
actor or the operator credential. A worker cannot continue another worker's
assessment. The operator can continue the saved split after the assessment
worker has stopped. An identical completed retry returns the saved result.

A lost creation or linking answer is read back before another external write.
Existing children are reused. Partial children remain blocked until activation.
A prerequisite completing naturally does not invalidate a retry. Its current
state is inherited at activation. A newly added drain or hold refuses further
work. The same identity can continue after the operator lifts that control.

A changed source body, changed ownership or edited child cannot be silently
rebased. Preserve the record and failed evidence. Inspect the retained source,
plan, child filings and authoritative workflow before using ordinary protected
operator commands to resolve the change. Restore only the reviewed intended
scope when appropriate. Do not delete a requirement, dependent, hold or branch
to obtain a successful retry. Do not start another split under a new identity.
