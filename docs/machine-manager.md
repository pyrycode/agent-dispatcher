# Multi-computer dispatch

Managed mode adds one manager per physical computer and one shared claim service. The existing project dispatchers still own their stages, blockers, tool environments and agent runs. This is opt-in. Do not run an independent dispatcher against a board that managed computers share.

The claim service uses SQLite on its own local disk. It grants a ticket and the computer's capacity in one transaction. There is no distributed database, heartbeat expiry or automatic failover. A service outage prevents new starts. An existing run can finish, but its reservation remains until the finish is acknowledged.

## Central fleet runner

The central operator can choose Codex or Claude for every managed development
role across all computers. Use the existing operator configuration and its
central operator credential:

```sh
pnpm fleet runner /path/to/operator.json codex
pnpm fleet runner /path/to/operator.json claude
pnpm fleet runner /path/to/operator.json
```

The final command reads the current choice. The existing `operator.sh` wrapper
also accepts `runner codex`, `runner claude`, and `runner` when it forwards
commands to this entry point. `runner local` restores local runner files and
environment settings. A fresh installation has no central override.

The setting is saved in the claims database and takes effect on new admitted
runs without a dispatcher restart. It overrides local files, role entries and
launch-time runner choices for refinement, building, verification,
documentation, recovery and the classic roles. Existing model defaults and
per-role Claude model choices remain unchanged.

Deploy this feature to the claim service and every participating dispatcher
before enabling the override. Older dispatchers do not use the central choice.

Each grant saves its runner and the setting revision. An already admitted run
keeps that choice through preliminary source review, final review and any
resumed session. A switch neither interrupts workers nor transfers a session
between providers. Retrying a lost admission response returns the original
choice. Status reports the current setting and each grant's saved choice.

Both providers must already be installed and authenticated on the computers
that will use them. A missing provider or failed login blocks that work through
the existing checks. It never silently substitutes the other provider. Product
tests that deliberately exercise real Claude continue to exercise Claude.

Only the central operator credential can change this setting. Machine and
project credentials can read it and receive grants, but cannot override it.
The existing admission and status channels distribute the choice. No new
monitoring or reporting process is added.

## Scheduling

Each manager configuration lists projects in priority order. It first considers runnable locally claimed recovery and repair work, then locally claimed ordinary work, then unclaimed recovery and repair work, then unclaimed ordinary work. Recovery includes assessments and tickets labelled `orchestrator:recovery-priority`, or its old name `orchestrator:fixing`. Routine dependency assessments and quiet Inbox readiness checks form a final idle-only group, after all actionable ticket offers regardless of ownership. They run only when the local computer has no active ticket reservation and selects no ready ticket stage. Actual stage errors and assigned repairs retain the existing recovery order. Within the claimed groups, oldest claim comes next. Within the unclaimed groups, project order comes next. The dispatcher's ticket priority labels and stage order break ties. The manager rereads offers and reservations before every admission. An owned offer that cannot fit the remaining capacity does not prevent fitting unclaimed work from starting. Running work is never pre-empted. A blocked or errored ticket stays owned but is absent from ordinary eligible offers, so other work can proceed. Strict project priority can starve a lower project if higher projects always have eligible work.

A dispatcher can explicitly cancel a reservation it never started, for example after a board stage changes. That cancellation releases a new ticket claim only if no actual or uncertain run has used that ownership generation. Completed, failed and blocked implementation keeps its claim. A confirmed assessment-only wait releases its claim with an authority receipt for the exact owner and generation. Offline reservations still require manual release. A cancelled offer therefore cannot gain priority over work that is ready to run.

Before forgetting an outdated stage offer, the dispatcher atomically replaces its queue and waits for in-flight admission to settle. Surviving offers remain available with their original identities throughout. It cancels the exact retired reservation only if it never launched. Every dispatcher sync also reconciles hidden reservations from its current live session that never launched and have no matching offer. Local runs remain recorded until all tracked child groups exit and completion is acknowledged. Reservations from an older session remain uncertain. Removing a stale stage offer can therefore release unused capacity without interrupting work or changing an established ticket owner.

With recovery enabled, an ordinary worker reads fresh ticket status, labels and blockers when its children have exited. It publishes a prospective recovery offer before finishing. The claim authority records any resulting incident in the same transaction that frees the slot. Prospective offers require a current queued incident before admission. Completion retries recover the original result without duplicating the incident or retiring other tickets' incidents. Failed reads or uncertain acknowledgements keep the reservation until the handoff is confirmed. The five-minute recovery check remains the fallback for external board changes. Historical review counts cannot start another assessment while an assigned repair is proceeding, but a new stage error can.

Upgrade the claim authority and all three machine managers before upgrading the worker pins. Older workers remain compatible throughout that order.

Production managers default to `ticketLimit: 2`, shared across all their projects. Active ticket reservations and locally owned tickets with actionable offers count. Waiting idle-only assessment offers do not count. Blocked, errored and completed claims without offers keep their ownership but do not count. Existing ownership can continue above the limit. Internal maintenance jobs do not count. Light roles remain free of resource limits, but cannot acquire extra tickets past the claim budget. Status reports the configured limit and runnable ticket count.

Each role is `heavy`, `medium` or `light`. Build agents default to medium, including the classic developer role. Refinement and documentation agents default to light. Verifiers and unknown roles default to heavy. Documentation keeps its separate one-at-a-time restriction per project board across computers. Explicit role configuration can override these defaults.

Every physical computer has two shared limits: `heavyLimit` bounds heavy jobs, and `combinedLimit` bounds heavy plus medium jobs. Both are required positive integers. The combined limit must be at least the heavy limit. Light work consumes neither limit.

With heavy at 1 and combined at 2, the computer can run one verifier and one builder, or two builders. It cannot run two heavy jobs or three medium jobs. Jobs retain their resource class for their whole run; there is no mid-run upgrade or second reservation. Existing role restrictions such as serial documentation still apply across computers to protect shared files.

Each reservation covers setup, the agent, its pre-verifier tests, retries, cleanup and indexing. Heavy runs consume both counters. Medium runs consume only the combined counter. Merge work, standalone live gates and main checks are always heavy. Background children in the recorded process groups keep the reservation until they exit. Programs that deliberately detach into a different process group are outside that check. Do not use daemonised test runners for managed jobs.

Only admitted runs create claims. Writing follow-up tickets, comments or labels does not claim those tickets. This also prevents a drained computer from turning newly filed follow-ups into owned work.

Housekeeping is a short light job with a project lock. It can advance unclaimed work without retaining ownership of the backlog. New runs wait for that pass. Already running jobs retain their grants. Housekeeping cannot modify another computer's tickets or a ticket with an active run. Shared family marker comments and convenience counters remain cross-owner metadata. Those helpers cannot launch agents or advance ticket stages.

## Configure

Use Node 24 or newer with `node:sqlite`, and install the repository's existing dependencies. The service adds no package dependency. Keep its database on pyrybox's local persistent disk, outside Obsidian Sync and network filesystems.

The approved starting limits are included in `examples/fleet/claims.json` and the corresponding manager examples:

| Computer | Heavy limit | Heavy plus medium limit | Manager example |
| --- | ---: | ---: | --- |
| MacBook Air M4, 24 GB | 1 | 1 | `manager.json` |
| Pyrybox, four cores, 32 GB | 1 | 2 | `manager-pyrybox.json` |
| Dedicated six-core, 32 GB | 1 | 2 | `manager-six-core.json` |

The Mac runs either one builder or one verifier initially. The other computers can run one of each or two builders. The six-core machine's identifier is a placeholder until its permanent name is chosen. Project orders, addresses and paths are examples that still need configuration.

Use matching limits in the claim service and local manager. Both enforce them; a mismatch uses the lower effective value for each limit. A smaller limit never kills an existing run. Existing reservations, including those left after a crash, count towards both applicable limits. Older draft configurations without `combinedLimit` fail startup and must be updated. Use a stable unique machine name that survives container replacement.

Credential fields name environment variables. Supply values through the existing 1Password service-account launcher. Use distinct credentials for each machine, each local project and both operator interfaces. Do not give claim-server operator credentials to dispatchers or agents. The dispatcher removes its manager credential from agent environments.

Services bind to loopback by default. Expose the central claim service only through the private network and encrypted transport, such as an SSH tunnel or private-network HTTPS proxy. A plain HTTP connection on the public network is not supported.

For containers on Linux or macOS, the manager also accepts `socketPath` instead of a TCP listener. Dispatchers and the local status/drain client use `unix:///absolute/path/manager.sock` as their manager URL. Mount the containing private directory read-only into each project container and use separate project tokens. The socket has mode 0600, so the containers must use the host user's identity. Keep the directory itself in place across restarts. The supervising service must remove a stale socket after an unclean exit before restarting its sole owner. No host network port is needed. Pyrybox's opt-in units and rollout instructions live in `pyrycode-agents/container/managed/`.

`scripts/fleet-container-smoke.mjs` verifies the transport with temporary Podman containers and sleeping child jobs. Compile with `pnpm exec tsc` and run `node scripts/fleet-container-smoke.mjs host` on Linux. It never contacts GitHub or mounts production state. Set `FLEET_TEST_PEER=1` and `FLEET_TEST_PORT` to wait for the script's `peer URL` mode on a second computer through an SSH tunnel. The test covers both capacity limits, exclusive claims, the documentation lock, manager and container crashes, manual release and completion. Its fixed test credentials must never be used in deployed services.

From the shared engine checkout, with credentials already in the environment:

```sh
pnpm fleet claims /absolute/path/claims.json
pnpm fleet manager /absolute/path/manager.json
```

In each consumer's secret environment, set:

```dotenv
PYRY_MANAGED=1
PYRY_MANAGER_URL=http://127.0.0.1:7431
PYRY_MANAGER_TOKEN=op://your-configured-reference
PYRY_RESOURCE_CLASSES={"refiner":"light","builder":"medium","verifier":"heavy","documentation":"light"}
PYRY_AUTOCURATE_MEMORY=0
```

Medium is an admission class, not a CPU or memory quota. Build agents still need bounded test workers and focused checks; classify a build job as heavy before launch if it needs a full suite. This change does not alter test-runner worker counts. Review the actual role commands before classifying one as light. Documentation is light by default. Its serial restriction is independent of its resource class. Unknown role names default to heavy.

Start each updated consumer with `bin/pyry-start --managed`. The flag survives restart and takes effect after secret loading. A partial manager configuration fails closed. The old `PYRY_MAX_CONCURRENT` limit applies only to independent mode. Mobile skips its pre-launch Gradle formatting check in managed mode because it would run before admission. The builder and verifier retain their admitted checks.

## Shared GitHub connection

The claim service can own the fleet's GitHub API connection too. Add `github` with `tokenEnv`, an explicit `projects` list, `cacheMs` and `readReserve` to its configuration. The example shares reads for two minutes and holds the last 200 requests or GraphQL points for writes. The claim-label publisher uses the same connection when enabled.

Set `PYRY_SHARED_GITHUB=1` in each managed dispatcher's environment. Its existing manager connection carries GitHub requests to the central service. Both the dispatcher client and agent `gh` commands use this path. An isolated child process serves the CLI's documented `http_unix_socket` option. This preserves synchronous CLI commands and file arguments. Agent environments receive only the private CLI configuration directory. They do not receive a manager credential or the central GitHub credential.

Identical in-flight reads across computers share one request. Successful reads are cached. Writes run in order and invalidate cached reads even when their result is uncertain. PR head and merge checks, ticket launch status, launch labels and blockers bypass the cache. A ticket-status check reads that ticket rather than the whole board.

The service tracks REST and GraphQL allowances separately. Quota exhaustion holds upstream requests until reset. Service failure never falls back to each computer calling GitHub directly. Dispatchers retry quota and connection failures without stopping existing agent runs. Managed REST and GraphQL responses with HTTP 5xx or 408 are converted to the same temporary-outage pause before response parsing. The polling loop retries automatically, including at startup. It checks again within a minute and honours shorter Retry-After delays. This does not replay uncertain comments or other mutations; interrupted agent publication can still need reconciliation or operator review. Existing local verdict and done handoffs retain results for later publication. The service does not automatically replay uncertain mutations.

Keep the existing local Git authentication for clone, fetch and push. Managed agents must use `gh` for GitHub API operations so they use the shared connection. A separately launched script, watcher, `curl` command or MCP connector does not inherit this route automatically. Configure those callers explicitly before claiming that all automated traffic is centralised.

The operator-authenticated claim-service endpoint `GET /github/status` reports upstream calls, cache hits, held requests, writes and the observed allowances. It never returns credentials or cached ticket content. Use these counters to verify savings after rollout.

For a watcher on the claim-service host, add `github.socketPath` and optionally `github.cliConfigDir`. The service creates an isolated CLI configuration for that private socket. Set the watcher's `GH_CONFIG_DIR` to that directory. Keep the directory private to the service user. The supervisor must remove the sole service's stale socket before restart, as with the manager socket. REST requests select a configured repository from their path. GraphQL requests use the first configured project as their access context. This socket is only for trusted host jobs; containers use their project-authenticated manager instead.

## Managed recovery

The orchestrator can assess errored tickets and repeated review rework. Enable
`PYRY_RECOVERY=1` in each managed project dispatcher after upgrading the central
claim service and its computer manager. Independent dispatch refuses this setting.
Leave the old board watcher in read-only mode. Do not enable its takeover scripts.

Each enabled dispatcher reports its open board snapshot every five minutes. It
reuses the ordinary board query and sends only ticket numbers, columns, labels
and blocker state. The central service records incidents in its existing SQLite
database. Repeated polls do not call a model. A resolved error that returns creates
a new incident. Rework counts of two or more request an assessment, not a repair.

A retained reservation with no workflow progress for three hours produces one
durable operator incident for that exact run. This includes cards returned to
Backlog. It does not launch another worker or release uncertain capacity. Fresh
workflow progress and a new reservation restart the grace period. The diagnostic
resolves when the owning session confirms that run ended. Ordinary unclaimed
Backlog waits remain quiet. A running label stranded in Backlog can also alert.

The owning computer offers an assessment as the `recovery` role. It uses normal
admission and a heavy reservation. Only one assessment runs across the fleet at
a time. Existing ownership, both capacity limits, project drains and full drains
apply. Runnable owned recovery and repair work precedes owned ordinary work. Both owned groups precede unclaimed recovery and ordinary work. Routine dependency assessments and quiet Inbox readiness checks are an exception: they run only when the local computer has no active ticket reservation and no ready ticket work was selected. These waiting checks do not count against the new-ticket limit. The central snapshot identifies them from their recorded incident reason, including offers from older workers. Actual errors, returned Inbox investigations and assigned repairs retain their existing recovery priority. A job that cannot fit the available capacity does not block a fitting job. Already reserved or running jobs are not interrupted. An unreachable owner or uncertain reservation is never released by recovery.
An unclaimed ticket can be assessed only after normal admission claims it.
A confirmed completed assessment that says `wait` releases that claim if its
ownership generation contains only completed read-only assessments or explicitly
unused reservations. Any implementation run, uncertain run or assigned repair
preserves ownership. Recorded decisions and run history remain available.
The authority records the exact released owner and ownership generation.
Restart verification accepts that receipt while preserving its check against
unexplained ownership changes.
An unchanged quiet Inbox wait does not repeat on the ordinary thirty-minute
retry timer. New workflow or evidence can make it eligible again. A ready Inbox
ticket returns to ordinary refinement and retains normal review and test gates.

The assessment follows the central runner choice when configured. Otherwise, it
uses the project's configured runner and optional `recovery` role override. Codex inherits the configured model.
Claude uses Sonnet. Both investigate with extra-high effort, independently of
lower ordinary role settings. It uses the existing restricted source
reader, with a thirty-minute limit and eighty Claude turns. The prompt contains the
ticket, its last twelve comments and the tails of its last two agent logs. Local
source reads are allowed; publishing, file edits, tests and delegation are not.
A failed reader or invalid response escalates, without a less restricted fallback.

The four possible decisions are:

- `wait`: review is making progress or no intervention is needed. Record the
  assessment and allow the ordinary workflow to continue. The wait is settled
  against what it depends on and is not reassessed on a timer. See
  [Settled waits](#settled-waits). Running workers and deliberate holds still
  prevent reassessment.
- `retry`: remove the error on the current failed stage. Code restricts this to
  a recognised stage with no completion label. Existing automatic backoff keeps
  its own budget and is not assessed by this path.
- `rework`: leave a concrete repair brief and return unfinished code to its
  builder or developer. Remove obsolete downstream completion and rework labels.
  Keep the rework count, claim, required live gate and earlier planning evidence.
  The normal code agent receives the brief, reserves capacity separately, makes
  the repair with extra-high effort and returns through the usual review and
  testing stages. The configured runner and model are retained.
- `escalate`: record the reason for operator intervention. No workflow state is
  changed.

The issue receives `orchestrator:investigating` while its admitted assessment runs.
It is removed when the assessment ends.

A handback that assigns a repair receives `orchestrator:recovery-priority`. These
are retry, rework, resume, refine, unblock and coordinate. The label stays through
the repair pipeline, including waits between stages. It gives each later stage
recovery priority and gives the builder or developer extra-high effort. It is
removed when the ticket reaches Done, is Halted, gets an operator hold or another
error, or a later assessment escalates. Until 2026-10-14 this label was called
`orchestrator:fixing`; see [Recovery labels](workflow-authority.md#recovery-labels)
for the rename.

`orchestrator:repairing` shows the assigned repair run itself. Retry, rework,
resume and refine receive it with the handback, because each assigns an
ordinary stage run: the failed stage, the builder or developer, the recorded
stage, or the refiner. It stays while the ticket waits for that run and while
the run works. It is removed when that first run finishes, whatever its
outcome, and on every condition that removes recovery priority. Unblock and
coordinate assign no stage run, so they get priority without this label.

Owned, idle-ticket reconciliation removes stale labels after an interrupted
run or failed cleanup. It removes a repairing label left without recovery
priority. For an imported project, the central store also removes a repairing
label once the assigned run has marked the ticket running and no run remains
active on it. That covers a crashed worker after the operator releases it.
Existing ticket ownership is checked before each write. The publisher creates
the two new labels on GitHub on first use, in one bright shared colour with a
description.

The model only proposes a decision. The wrapper checks current open issue state
before and after assessment, and validates the proposed handback. It cannot
override Halted or needs-human holds, open blockers, running labels, permission
denials or family breakers. It cannot accept a failed live gate, reset rework
counts, mark code reviewed, merge a pull request or restart a dispatcher.

The `needs-human:sizing` label is an informational review marker, not an operator
hold. It does not prevent recovery or remove an assigned repair's priority.
Assessments must investigate available source and logs before escalating missing
evidence. Repository defects in build or test infrastructure can return to the
normal code agent; uncertain workers and denied permissions still need an operator.

There is no fleet-wide daily assessment or repair quota. Normal heavy admission
and one assessment at a time bound investigation concurrency. Each ticket can
receive three automatic repair or retry handbacks per rolling twenty-four hours.
Budget exhaustion escalates that ticket without preventing unrelated recoveries.
Real escalations and completed handbacks are not replayed on a timer. Wait decisions
and operational escalations are settled, as described below. Normal review can still
advance, and a changed rework count creates a new assessment. Previously exhausted fleet quotas and incorrectly
held sizing markers become eligible again. Genuine escalations and interrupted
handbacks remain held for inspection.

### Settled waits

A `wait` decision, or an `escalate` decision with category `operational`, records a
settlement in `fleet_recovery_settlement`. It stores the incident's ticket
fingerprint and the state of everything the decision waits on, with a digest. The
incident is assessed again only when one of these changes:

- the ticket fingerprint: stage, recovery labels, body, non-recovery comments,
  blockers and their state, retained logs, the ticket's own recovery task results,
  or its pause record. A human comment or an operator pause lands here.
- a named recovery task leaves the queued, running or publishing phase. Tasks come
  from the decision's optional `waitFor.tasks`, and from 64-hex identifiers in the
  reason that match a real recovery task.
- a ticket named in `waitFor.tickets` changes stage or leaves the open board.
- the ticket's coordination records, including an operator `coordination` receipt.
- for operational escalations, a capability becomes ready on some computer.
- an explicit code deadline: the repair budget expiry, or the thirty-minute cooldown
  that code sets after a transient GitHub transport failure. An assessment cannot
  request that cooldown.
- the safety interval, 24 hours by default, so nothing is forgotten. Set
  `recovery.safetyRecheckHours` in the claim service configuration to change it,
  between one hour and thirty days.

The cause that reopened a settlement is stored in its `reopened` column and shown in
`/recovery/state`. Incidents settled before this policy are recorded against the
state at the first report after deployment, so the deployment itself does not
trigger assessments. Waits for idle dependency and Inbox checks keep their earlier
rule: only a ticket change reopens them.

The decision and repair budget are stored before GitHub writes. A process that
stops during assessment or handback keeps its reservation. Once that exact run
has been finished through normal shutdown or operator recovery, an incomplete
incident escalates instead of replaying writes. `complete` in the incident list
means the decision was applied, not that the subsequent repair passed verification.

Inspect incident history with:

```sh
pnpm fleet recovery /absolute/private/path/operator.json
```

The manager also exposes it at `GET /recovery/state`. Ordinary status identifies
missing or stale dispatcher reports and reservations older than three hours.
These are requests to check real worker progress, not proof a process crashed.
Running labels without reservations are flagged after three hours. Open work
columns with no workflow progress are flagged after a day. Expected blocker waits
are excluded. Explicit holds and stalled-work alerts are recorded without AI.
Alerts and non-wait decisions use the dispatcher's existing notification route.

Upgrade order: claim service, computer managers, then project dispatchers. Enable
the flag for one project first and inspect its incident history and next recovery
handback. Turning the flag off stops new recovery offers; it does not release
existing reservations or interrupt a running assessment. Keep the old watcher
read-only until all projects are reporting through this path.

## Services on Linux and macOS

Use a systemd user service on Linux and a launchd user agent on macOS. Templates are provided. Replace every absolute placeholder before installation. Keep the manager outside project containers. There is exactly one manager for the host, even when projects use different containers or Node versions.

Create a private executable launcher at the path named in the template. Give it an explicit PATH for the credential helper and Node. Its final command is:

```sh
exec /absolute/path/to/automation-access op run \
  --env-file=/absolute/private/path/fleet.env -- \
  /absolute/path/to/node --import tsx \
  /absolute/path/to/agent-dispatcher/src/fleet-bin.ts \
  manager /absolute/private/path/manager.json
```

The service working directory must contain the installed `tsx` dependency. For the central claim service use the same pattern with `claims`, a separate configuration and a separate service name. The templates do not install themselves or change running dispatchers.

## Status, drain and manual recovery

### Visible GitHub claims

The claim service can mirror ownership to issue labels such as `claim:pyrybox` and `claim:macbook`. Enable `githubLabels` in its configuration with a `tokenEnv` credential name and an explicit `projects` repository list, as shown in `examples/fleet/claims.json`. Supply a GitHub token with issue-label read and write access for those repositories through the existing private environment file or secret launcher. The default service without this section makes no GitHub calls.

One central publisher checks on startup and every minute. It creates missing label definitions, backfills existing claims, replaces old owner labels after transfer and removes labels after manual release or cancellation of unused reservations. It includes closed tickets because their claims persist. Offline and blocked tickets retain their labels. Internal maintenance reservations are excluded.

The `claim:` prefix is reserved for this display. GitHub labels never grant or transfer ownership; manual changes are corrected from the claim database. The publisher only adds or removes individual claim labels, leaving other issue labels intact. GitHub outages retry on later passes without affecting claims, capacity or dispatch. Label visibility is eventually consistent and can lag changes by one minute plus API time. Only the claim service needs this configuration; project dispatchers need no label-specific change or restart.

### Operator commands

```sh
pnpm fleet status /absolute/private/path/operator.json
pnpm fleet drain /absolute/private/path/operator.json
pnpm fleet drain-project /absolute/private/path/operator.json pyrycode/pyrycode-mobile
pnpm fleet resume-project /absolute/private/path/operator.json pyrycode/pyrycode-mobile
pnpm fleet free /absolute/private/path/operator.json \
  'pyrycode/pyrycode#123' CURRENT_GENERATION --confirmed-stopped
```

Status includes durable owners, active reservations, both capacity limits, project order, project drain policies, last reports and the eligible queue. A claim with no offer can be blocked, errored, completed or waiting for its dispatcher. GitHub remains the source for the detailed workflow reason. A reservation records permission to run, not proof that its process is still alive.

`drain` stops all new grants on the computer. Existing grants can finish, but subsequent stages of those tickets cannot start. The drain flag is local process state; a manager restart resumes admission. Never configure an external watchdog to restart a deliberately drained manager.

`drain-project` stops new ticket claims for one project on this computer. Tickets already owned by it can continue through build, verification, documentation, final checks and merge. Blocked or errored tickets retain their claims and continue when runnable. Other projects remain eligible under the shared limits. Reconciliation remains allowed so board updates can finish; background main sweeps are held back. This command waits for any start already sent to the claim service before acknowledging the change. It does not stop running agents or release tickets to another computer.

The project policy is saved atomically in the manager's private configuration as `drainingProjects`, an optional list of configured repository names. It survives service and computer restarts until `resume-project` removes it. Keep the project dispatcher running while draining; removing its configuration or stopping its service would prevent later stages from finishing. Once the owned tickets are done, it remains idle for new tickets. Previously owned tickets keep their owner when reopened, just as they do outside drain mode. Free their claims manually to transfer them.

The operator client can use a separate `managerUrl` configuration, or the manager configuration's `socketPath` when run from the manager's working directory. Only the operator credential can change a project policy. The manager must be able to write its own configuration directory. If saving fails, the command reports an error and leaves admission unchanged.

Tickets remain owned between stages and while offline. Normal completion retains ownership too, so reopening a ticket keeps its previous computer. Use `free` to transfer it. The command requires the current generation from status and explicit confirmation that the old dispatcher, watcher and subprocesses are stopped or disabled. It does not delete working copies, clear error labels, move board items or kill remote processes. Freeing is deliberately manual.

A dispatcher crash leaves all its active reservations occupied. After checking that its children have stopped, free those tickets individually and restart. A clean manager restart preserves grants for the same still-running dispatcher sessions. A new dispatcher session never adopts an old session's live grant. If a grant response is lost, retry uses the same identifier and recovers the existing reservation.

Back up SQLite using its online backup facilities, or stop the claim service and copy the database together with any WAL state. Restoring an older database requires stopping every worker and reconciling ownership before any start. Never bring up a second independent claim database against the same boards.

## Rollout

1. Use the approved machine limits. Choose project order and confirm role classifications. Configure service credentials and transport.
2. Drain every old dispatcher and stop automatic watcher takeover on those boards. Preserve worktrees and active ticket state. Watchers can remain in read-only alert mode. Independent takeover and manually launched agents do not participate in this manager and must remain disabled while the board is shared.
3. Start the claim service and one manager. Start its updated consumers. Existing unclaimed board state is reconciled under a project lock before selection.
4. Verify status and logs with a small heavy limit. Drain and restart the manager. Check that active grants stay reserved and completed jobs free capacity.
5. Add a second computer. Confirm that both can process different tickets and cannot run the same ticket. Test manual recovery on a stopped test worker before increasing capacity.

All supervisors and launch commands must use the shared path. This does not limit arbitrary tests a person starts in a terminal. Linux service installation and macOS service installation need validation on their target computers before production activation.

## Recovery without board supervision

Recovery now watches changed issue evidence and dependency revisions as well as errors and repeated rework. Blocked issues receive an assessment. An unchanged dependency wait does not repeat that assessment on a timer. Changed evidence can reopen an escalation after a thirty minute cooldown. Workflow changes remain eligible immediately. Inbox items with no progress for a day also enter assessment. A pipeline Inbox item needing live evidence can enter immediately. Evidence refinement returns to the normal planning stage with its portable proof brief.

A parked stage error enters assessment even when ordinary transient retries have already run out. A retry count without a stage error still belongs to the ordinary retry wait. Health holds retain their existing recovery. Active workers, human holds and capacity limits remain respected.

If investigation finds a cleared failure cause or a concrete relevant repair, its `retry`, `rework`, `refine` or `resume` decision supplies a `retryReset` explanation. Code requires this finding before handing off a ticket with ordinary retry counts. It saves the explanation in the durable decision and issue comment, then removes those counts before clearing the stage error. Waiting, escalation and closure proposals leave counts intact. The separate three-repairs-per-day recovery budget and review rework counters remain unchanged. Family dispatch counts no longer hold work.

The recorded handoff also starts a new comment-history retry budget. When a counter label cannot be read or written, only retry comments after the newest recorded reset count. The latest retry time follows the same boundary, including comments beyond the first page. Existing comments remain preserved.

The claim database records pause origin, actor, reason, missing prerequisite, reopening condition and previous stage. A pipeline pause can resume after assessment and fresh safety checks. A human hold stays in place. Older Halted cards with unknown origin receive a read-only provenance assessment only when normal work is unavailable. That assessment cannot reopen them. A confirmed assessment releases an investigation-only claim while retaining the escalation and its evidence. Ownership remains when the claim generation has real implementation, an assigned recovery repair or uncertain work. Saved support tasks preserve that assignment even if a later pause replaces the incident decision. Previously queued support tasks remain paused throughout provenance assessment. Moving an old card is never taken as proof that a person intended it to resume.

Each computer inventories the retained logs needed by its open issues and their related ticket references. The shared inventory contains source name, computer, size, modification time, outcome and digest. It contains no log text. The assessor reads bounded local log and stderr tails and recent comments on related tickets through the shared GitHub connection. It uses remote inventory entries to find retained evidence or specify a portable reproduction for the ordinary code agent. Isolated tests retain ordinary admission and live-test credentials. An inaccessible artifact is not proof that no failure occurred.

Native blockers remain causal unless their coordination purpose was explicitly recorded. Automatic removal also requires fresh, complete pull request file lists with no overlap. Missing branches, incomplete listings and a model's unsupported description do not authorise removal. Record an existing coordination relation with `operator.sh coordination RECEIPT.json`. A receipt contains `ticket`, `blocker`, `paths` and `reason`. It does not modify the relation itself.

`operator.sh attention` returns one fleet decision report. It excludes resolved history and separates active recovery, explicit human holds, missing computers and decisions. A `propose-close` assessment appears there with its evidence and limits. It never closes an issue or claims a repair was verified. A person can approve that decision without opening a board. Three automatic repair assignments per ticket per rolling day still apply. Resuming a pipeline pause and removing coordination blockers share that budget.

### Local update and credential supervisor

The claim service can look up consumer main and its dispatcher submodule pin once every five minutes for the fleet. Enable `updates` in its protected configuration:

```json
{"updates":{"dispatcherRepository":"pyrycode/agent-dispatcher","consumers":{
  "pyrycode/pyrycode":"pyrycode/pyrycode-agents",
  "pyrycode/pyrycode-mobile":"pyrycode/pyrycode-mobile-agents",
  "pyrycode/pyrycode-desktop":"pyrycode/pyrycode-desktop-agents",
  "pyrycode/pyrycode-relay":"pyrycode/pyrycode-relay-agents"
}}}
```

`operator.sh desired` returns that manifest. A lookup failure offers no new update once the last successful manifest is fifteen minutes old. The submodule destination must match the configured shared dispatcher repository.

Run `python3 scripts/fleet-supervisor.py CONFIG.json` as a local service. Its protected configuration names the existing operator wrapper, state directory, report file, Python executable, platform and project adapters. Mac adapters name the agents checkout, target checkout, canonical workload access helper and runner. Linux adapters name those checkouts, container paths, the container and service names, and the protected GitHub container secret. See `examples/fleet/supervisor.json`.

The supervisor compares the source recorded at dispatcher startup with the desired pins. Updating a checkout cannot falsely attest that its old process loaded new code. It also compares the actual running GitHub credential with the configured workload credential using a local salted fingerprint. It verifies authentication and repository access before draining and after restart. Credential values are never recorded in reports or receipts. Linux credential provisioning remains the operator credential loader's responsibility. Updating a remote password-manager item without provisioning that secret does not update a container.

Successful configured-credential reads stay in memory for the supervisor's lifetime. Ordinary monitoring does not reread the password manager. Failed lookups and rejected authentication retry after an hour, configurable through `credentialRetrySeconds`. A real update preflight reads the configured credential again, while respecting failure backoff. After rotating or provisioning a credential, send SIGHUP to the supervisor for an explicit refresh. This leaves running dispatchers and saved restart receipts intact. For Mac workload SDK helpers, set each project's `githubOnlyProbe` to true after installing support for `--only-vars`. The probe then loads only `GITHUB_TOKEN`. Other launchers keep their existing invocation.

A durable receipt is written before one graceful stop signal. Existing jobs finish. The supervisor waits for the old process and child groups or container to stop and for reservations to finish. It fetches and fast-forwards main to exactly the desired consumer revision, updates the pinned submodule and starts through the existing launcher. If the desired versions change while the operation is still draining, the same operation retargets to the newest versions: one drain, one update, one start. Once a start has been issued, the operation finishes on its pinned target and a newer target waits for the next operation. It then checks the loaded source, credentials, startup checks, manager reporting, drain policies and every existing real ticket owner. Stopped services stay stopped. Dirty checkouts, retained reservations and changes to operator policies stop the operation for inspection.

A crash after an uncertain stop or start acknowledgement never causes another signal or start. That operation appears in the consolidated report. Inspection is required before clearing its receipt. No branch, local work, claim or retry counter is reset.

A health failure after a verified restart latches only once it has lasted `healthFailureConfirmSeconds` (default 600). The same confirmation applies before a restart for health alone. A manager reports its start time, and a dispatcher it has not yet heard from within `reportingGapSeconds` (default 300) of that start is a reporting gap, not a failure. A manager or controller restart therefore neither latches nor restarts a dispatcher. A latched dispatcher that then reports healthy, on any version, for `healthLatchClearSeconds` (default 1800) clears automatically. Samples more than `healthSampleGapSeconds` (default 900) apart restart that window. Healthy on its verified or desired versions, the record returns to its verified state, so a failure within twenty-four hours latches again rather than restarting. Healthy on other versions, such as a latch set on versions that have since been superseded, the record keeps the versions it was seen healthy on, and the next pass updates it to the desired versions through an ordinary operation. A failure after that update latches again and is not restarted. A dispatcher that keeps failing never holds the window, so it stays latched and is never restarted.

An open `draining`, `start-requested`, `verifying` or `waiting-for-native-task` record, or a six-hour alert, is retired when a later start has superseded it: the dispatcher is verified healthy on the current desired versions and the process the record drained or started is gone. The supervisor's own start of the current target still completes through its ownership checks. A start or verifying record for an earlier target, or a six-hour record that may come from one, is retired only after the same ticket ownership and drain policy comparison; a mismatch leaves it in attention. Ownership must match exactly. A project drain difference is accepted only where an operator `drain-project` or `resume-project` command made after the record was saved explains it. The manager records those commands, with their time, in its configuration as `projectDrainChanges` and reports them in its status. Any other policy difference, including a machine-wide drain, still needs inspection. An uncertain drain signal is never retired. Any healthy sample, on any version, ends a pending failure confirmation, as do a new drain and a verified completion. The native-task pass handles each task record separately. A completed record whose retained artifacts are gone (a missing file, a missing field or a known capture inventory failure) is marked unrecoverable and skipped. Any other failing record is skipped for that pass and reported. A failure outside a completed record's artifact transfer can be host-wide, so that pass starts no new worker. A failure of the whole pass still publishes the operation report, with the failure as its service reason.

Every automatic clear, retirement and skipped record is appended to `housekeeping.jsonl` in the state directory and logged. The file rotates to one previous generation at 256 KiB, and a skip is logged again only when its reason changes, across supervisor restarts too. Published reasons replace host paths with `<path>`. Retirements move the record, and clears copy it, into a dated `auto-<kind>-<project>-<time>` folder with an `archive.json` note, the same shape as a manual archive. The last day's entries are published in the operation report's `housekeeping` list.

Supervisor operation summaries are published to the existing claim authority. Only the authenticated computer can submit its summary. Reports contain phases and reasons, without commands, credentials or ownership records. The existing five-minute board-watch timer reads the consolidated decision report and uses its existing Pyrycode-client delivery path. No Codex reporting heartbeat is needed.

## Executable recovery work

An admitted recovery can return `coordinate` with a fixed `task` request instead
of escalating an available platform to a person. Admitted builders and developers
can request the same native checks through `scripts/fleet-task.py`. Each run gets
a private socket. The parent supplies the ticket and run identity. The child
receives no fleet credential and cannot read another ticket's artifacts.

The existing local supervisor advertises its configured capabilities after
checking the required executables. Records expire after three minutes for new
admission. An expired record never releases an existing worker or ownership.
The supervisor submits helpers to its existing machine manager. A helper uses
its parent's existing claim age and recovery priority on every configured computer.
This prevents a remote check from being treated as new unclaimed work. Active
workers keep their reservations. Native execution uses heavy capacity. Platform-route probes are light and cannot claim
that candidate tests passed. Helpers do not transfer or claim their product ticket.

Native host helpers do not hold unrelated product restart reservations. A helper
inside a container must finish before that container receives its drain signal.
Once an update is waiting or draining, its container route admits no new helpers.
The existing supervisor retains this wait and sends only its ordinary first stop.
Before that stop, the supervisor reports the container's capabilities withdrawn
and checks for helpers again, so a task admitted in between is waited for.
A grant that still arrives while its container's operation is open is deferred:
it keeps its reservation, is not started and does not hold the drain. It starts
once the update completes.

A helper whose worker is proven gone releases its reservation as failed,
interrupted work, never as completed or unused. The proof needs the host side
of the launch gone, no result written, and either the container absent or fully
stopped with no process, or the worker's own files written before the running
container instance started. A stopping container, an unknown container state
or a worker that never wrote proves nothing, and the record stays in attention.

The fixed recipes are `platform-probe`, `memory-runtime-smoke`,
`android-tool-then-text` and `dispatcher-repair`. Executed recipes require an exact
candidate revision. There is no model-supplied shell command. Requests are stable
within the admitted source run or recovery incident. A lost acknowledgement does
not launch another worker. Private text artifacts are limited to 4 MiB, reject
path traversal and credential-shaped content, and return through the source's
admitted writer. A failed check returns diagnostic evidence, never a passing gate.

A coordinating incident waits while its helper is queued, running or publishing.
The terminal result queues a new assessment without the usual evidence cooldown.
A real operator hold or denied permission stops new helper admission. A worker
that disappears without a terminal result escalates its source and retains the
uncertain reservation. The supervisor never repeats an uncertain launch.

Dispatcher repair uses the central run's saved Codex or Claude choice. Its fixed
parent creates an isolated branch, runs the full shared suite and helper checks,
then obtains an independent source review. Models cannot publish or deploy. The
parent submits the exact checked files through the configured GitHub connection.
Fresh PR and main reads, a stable task marker and a fixed new branch prevent
replacement of unrelated work or duplicate publication. No force update is used.
A moved base requires fresh checks. The merged tree must match the reviewed tree.

Verified controller source is loaded before consumer pins advance. Each supervisor
updates only a clean main controller checkout through a fast-forward. It backs up
the central database and reloads only its configured controller services. Running
product workers finish through their normal supervised updates. The helper's
compute reservation ends before publication and rollout waits. The source ticket
cannot start on a dispatcher that has not loaded the recorded repair. Existing
intentionally stopped services and project drains remain intact.

A `human` escalation remains held for an actual decision, denied permission or
uncertain worker. An `operational` escalation rechecks after a bounded delay.
Repair-budget exhaustion records its next available time and rechecks then.
This uses the existing recovery cycle and supervisor. No new reporter or cron is
created.

## Escalation visibility

The central claim-label publisher also maintains `orchestrator:escalated` from
current recovery incidents. It backfills existing escalations after startup and
removes the label when an incident resumes or resolves. History cannot keep it
on a ticket. GitHub failures retry on the existing minute cycle. Label changes
never grant ownership, reset a counter or authorise a retry.

Container deployments must bind the configured pipeline publish directory to
persistent private storage. For the installed Mac-path helpers this is
`/Users/juhanailmoniemi/.codex/publish`. Pending verdicts are also kept in the
persistent agents logs. GitHub HTTP 429 publication failures now use the normal
pending-verdict sweep. If a saved review cannot be recovered, a fresh ordinary
verifier must recreate its own judgment and required checks.

## Reassessing existing escalations

After a worker loads assessment policy version 1, the existing recovery cycle revisits its old unclassified escalations once. The claim database saves that policy version per incident, so restarting does not repeat the migration. Controller-first rollout waits for the updated worker observation before queuing this work. The policy version does not change a ticket's workflow fingerprint.

The fresh assessment uses current native execution capabilities. Classified human decisions, known operator pauses, denied permissions, running work and possibly applied repair handbacks stay protected. Fresh escalations always carry a category. Ordinary errored tickets remain eligible for diagnosis even with exhausted transient retries. Unknown-pause provenance checks share the existing idle assessment lane with dependency and Inbox checks. No new reporter or scheduler is created.

## Workflow authority

Imported projects use the central database for workflow decisions. See [workflow authority](workflow-authority.md) for migration, operator commands, compatibility and display publication. Update controllers and consumers before import. Preserve existing project drains and ticket reservations.
