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

## Codex rate-limit pause

On 2026-10-14 Codex runs failed with `exceeded retry limit, last status: 429 Too Many Requests` seconds into their first turn: on pyrybox at 10:07, 15:34 (twice), 15:36 and 16:06 EEST, and on Fractal at 11:07. The 15:34 pair came when the dispatchers restarted together after a token rotation. Each dispatcher retried on its own schedule, so nothing stopped the next start from meeting the same limit.

The claim service now keeps one fleet-wide pause:

- When any Codex run anywhere reports a 429, new Codex runs are refused admission across the fleet for two minutes. The refusal reason is `codex-paused`. Runs already admitted carry on. Work that starts no Codex agent is admitted as usual: merges, live gates, main sweeps, housekeeping, codegraph refreshes and Claude runs.
- A 429 during a pause is counted but neither extends it nor doubles it twice, so one burst of simultaneous failures is one step. A 429 after a pause ends, before any Codex run has started cleanly, starts the next pause at double the length: 2, 4, 8, 16, then 30 minutes, the ceiling.
- A Codex run admitted after the latest pause began that gets any model response resets the backoff to two minutes. A run admitted before the pause says nothing about new starts and resets nothing.
- A 429 more than one ceiling after the last pause ended, with no Codex start in between, starts over at two minutes. The ceiling doubles as this quiet gap, so a larger configured ceiling stretches it too.
- The state is one row in the claims database, so a claim service restart keeps a pause.

A run counts as Codex when the central runner choice is `codex`. Without a central choice, the runner the dispatcher states on its agent offers decides; offers from older dispatchers, which state none, are not paused then. A local runner switch replaces an ungranted offer, since the runner is part of the admission request. A support task counts only for the `dispatcher-repair` recipe, and only at admission: the repair runs outside a dispatcher, so its own 429s are not reported. The machine manager passes over paused Codex offers so fitting non-Codex work can start; the claim service makes the final decision.

The dispatcher reports through its existing manager connection. Its Codex runner reads Codex's own failed-turn message (`last status: 429`, `429 Too Many Requests`, or `hit your usage limit`), never the agent's prose. A failed run is reported once it ends; a clean start is reported once per admitted run at its first completed item that is not an error. A ticket whose run hit the limit is not given an error label or an `error-retry-count`; it is offered again and admitted when the pause ends. That happens only when the claim service confirms a pause is in force, and for at most four 429s on one ticket while other Codex runs get through. A ticket that keeps meeting a 429 while others start cleanly has a limit of its own, such as an oversized request, so from the fifth it counts. A 429 counts towards that limit only if some Codex run started cleanly since the ticket's previous one, so an account-wide limit that stops every run never counts against a ticket; the ticket's own clean start resets it. If the report cannot be delivered, or the throttle is off, the failure also takes the ordinary capped transient retry. A recovery assessment whose Codex run hits the limit waits out the existing thirty-minute transport cooldown as an operational escalation instead of escalating to a person. The live gate's infrastructure breaker does not count a model provider's own 429 lines as relay admission rejections, so a Codex limit seen inside a live test cannot halt a ticket with `error:infra`.

### Codex start spacing

The 429s kept coming with only three Codex runs in flight while the plan still showed two thirds left, which points at a tokens-per-minute limit rather than the plan's allowance. A Codex run's opening turns are its largest requests, so several starting in the same minute is the burst that meets that limit. The claim service therefore admits at most one new Codex start every 20 seconds across the whole fleet:

- A Codex start inside the spacing is refused with the reason `codex-spaced`. Nothing is reserved for it, so it occupies no place, claim or lock, and the manager passes over Codex offers while the snapshot says the spacing holds, so fitting non-Codex work starts instead. The next Codex start goes to whichever manager asks first once the spacing has passed.
- Only an admitted Codex start begins the next spacing. A start refused for capacity, a lock or a pause does not. A lost-reply retry of an admitted start recovers its grant as usual.
- What counts as a Codex start is the same as for the pause above. Claude runs and work that starts no agent are never spaced.
- A start recorded in the future, as after the clock steps back, holds nothing.
- The spacing is enforced only by the claim service. An independent dispatcher with no claim service is not spaced.

Set `"codexThrottle": {"startSpacingSeconds": 20}` in the claim service configuration, between 0 and 300; 0 turns spacing off. It is independent of `enabled`. `operator.sh codex` shows `spacing`: `spacingSeconds`, `held`, `remainingSeconds`, `lastStartAt`, `nextStartAt`, `lastStart`, `heldSinceLastStart` and `startsLastHour`, plus `recentStarts`, the last twenty admitted Codex starts. `operator.sh status` carries `codexSpacing` only while a start would be held, and a queued offer held by it shows the state `codex-spaced`.

After a restart, and again when it sees a pause end, each dispatcher holds its Codex offers back for a random time of up to a minute (`PYRY_CODEX_START_JITTER_MS`), so a fleet-wide restart or the end of a pause does not send every Codex start to OpenAI in the same second. Holding the offer rather than the run means the wait occupies no place; an independent dispatcher waits just before the spawn instead. A run already admitted never waits.

Visibility:

- `operator.sh status` carries `codexPause` once any pause has begun (never with the throttle off): `active`, `since`, `until`, `remainingSeconds`, `durationMs`, `nextDurationMs`, `level`, `atCeiling`, `reports` and the `cause` that began the pause. A queued offer held by it shows the state `codex-paused`.
- `operator.sh attention` carries a `codexPause` item while a pause at the ceiling is active, which means the limit outlasted the whole backoff. Check the account's usage with OpenAI.
- `operator.sh codex` shows the state, the configuration and the last fifty events. `operator.sh codex clear` ends a pause early and resets the backoff; it needs the operator credential.
- The claim service logs each pause start and end once, as `Codex throttle: pause-started: ...` and `Codex throttle: pause-ended: ...`, along with 429s during a pause, resets and operator clears. The last 200 events stay in the database.

Optional claim service configuration: `"codexThrottle": {"baseSeconds": 120, "ceilingSeconds": 1800, "enabled": true}`. `enabled: false` records reports and pauses nothing, so dispatchers fall back to the counted transient retry.

Upgrade order is the usual one: claim service and machine managers, then dispatchers. A controller alone already pauses Codex admissions under the central `codex` choice; it learns of a 429 only from updated dispatchers.

## Scheduling

Each manager configuration lists projects in priority order. It first considers runnable locally claimed recovery and repair work, then locally claimed ordinary work, then unclaimed recovery and repair work, then unclaimed ordinary work. Recovery includes assessments and tickets labelled `orchestrator:recovery-priority`, or its old name `orchestrator:fixing`. Routine dependency assessments and quiet Inbox readiness checks form a final idle-only group, after all actionable ticket offers regardless of ownership. They run only when the local computer has no active ticket reservation and selects no ready ticket stage. Actual stage errors and assigned repairs retain the existing recovery order. Within the claimed groups, oldest claim comes next. Within the unclaimed groups, project order comes next. The dispatcher's ticket priority labels and stage order break ties. The manager rereads offers and reservations before every admission. An owned offer that cannot fit the remaining capacity does not prevent fitting unclaimed work from starting. Running work is never pre-empted. A blocked or errored ticket stays owned but is absent from ordinary eligible offers, so other work can proceed. Strict project priority can starve a lower project if higher projects always have eligible work.

A dispatcher can explicitly cancel a reservation it never started, for example after a board stage changes. That cancellation releases a new ticket claim only if no actual or uncertain run has used that ownership generation. Completed, failed and blocked implementation keeps its claim. A confirmed assessment-only wait releases its claim with an authority receipt for the exact owner and generation. Offline reservations still require manual release. A cancelled offer therefore cannot gain priority over work that is ready to run.

Before forgetting an outdated stage offer, the dispatcher atomically replaces its queue and waits for in-flight admission to settle. Surviving offers remain available with their original identities throughout. It cancels the exact retired reservation only if it never launched. Every dispatcher sync also reconciles hidden reservations from its current live session that never launched and have no matching offer. Local runs remain recorded until all tracked child groups exit and completion is acknowledged. Reservations from an older session remain uncertain. Removing a stale stage offer can therefore release unused capacity without interrupting work or changing an established ticket owner.

With recovery enabled, an ordinary worker reads fresh ticket status, labels and blockers when its children have exited. It publishes a prospective recovery offer before finishing. The claim authority records any resulting incident in the same transaction that frees the slot. Prospective offers require a current queued incident before admission. Completion retries recover the original result without duplicating the incident or retiring other tickets' incidents. Failed reads or uncertain acknowledgements keep the reservation until the handoff is confirmed. The five-minute recovery check remains the fallback for external board changes. Historical review counts cannot start another assessment while an assigned repair is proceeding, but a new stage error can.

Upgrade the claim authority and all three machine managers before upgrading the worker pins. Older workers remain compatible throughout that order.

Production managers default to `ticketLimit: 2`, shared across all their projects. Active ticket reservations and locally owned tickets with actionable offers count. Waiting idle-only assessment offers do not count. Blocked, errored and completed claims without offers keep their ownership but do not count. Existing ownership can continue above the limit. Internal maintenance jobs do not count. Light roles remain free of resource limits, but cannot acquire extra tickets past the claim budget. Status reports the configured limit and runnable ticket count.

A computer also takes no new ticket while too many of its own tickets wait for review. Since 2026-10-14, a manager admits no offer for a ticket that no computer owns yet, at any stage, builder, refiner or recovery check alike, while the number of its review-ready tickets is at least its `reviewQueueLimit`. A review-ready ticket is one this computer owns, in any of its projects, that sits in a review column (`In Code Review` for the verifier and the classic code-review, `In QA` for the classic qa), has no open blocker, no `error:` label, no `needs-rework:` label, no operator hold (`needs-human:` other than sizing), no dispatcher hold (`held:`, such as `held:health-check`), no running `wip:` label, no `done:` label for that review and no review verdict waiting to publish (`pending-verdict:`, `pending-done:`), has no open support task, has no reservation running, including a support task that serves it, and whose review (`verifier`, `qa` or `code-review`) its dispatcher currently offers to this manager with every required repair ready. The offer test fails open: a review the dispatcher holds back, for a failed health check, backoff, a stopped dispatcher or a project the manager no longer serves, cannot hold new work. A review refused for capacity or a lock still counts. Work on owned tickets is never held: verifiers, rework builders, documentation and recovery of owned tickets continue as before, and a verifier that starts takes its ticket out of the queue, which can free a new ticket in the same pass. Housekeeping and other shared jobs are not tickets and are not held.

`reviewQueueLimit` is an optional manager setting. Absent, it equals `heavyLimit`, since a review takes a heavy place: 1 on pyrybox, build-fractal-2 and the MacBook, 2 on build-hp-1. `0` turns the hold off. A negative or fractional value fails startup. The motivation was build-fractal-2 owning six runnable tickets, three of them waiting for its one heavy place, while build-hp-1 sat half idle.

The claim service names the review-ready tickets of adopted projects, whoever owns them, in its snapshot as `reviewReadyTickets`, read from the workflow store through an index on status; the manager keeps its own owned tickets that no run holds and whose review it is offered. The manager enforces the hold, as it does the ticket limit; the claim service does not refuse a start for it. Status shows `reviewQueue`: `limit`, the waiting `tickets` and `full`, and a held offer's queue state is `review-queue-full`. Projects not adopted into the workflow store are not counted. A claim service from before this change sends no list: status then shows `tickets: null` and nothing is held. An older manager ignores the list. Either mix behaves as before the change, so the order of upgrade does not matter.

### Ticket requirements

Since 2026-10-15 a ticket can say where it must run. A `requires:macos`, `requires:linux` or `requires:android-device` label holds every stage of the ticket, refiner, builder, verifier, documentation, merge and recovery assessment alike, to a computer that advertises the capability. A ticket with no `requires:` label runs anywhere, as before. Several labels must all be met by one computer. An unknown name such as `requires:gpu` is kept as a requirement no computer meets, so the ticket waits visibly instead of running anywhere. Shared jobs (`@reconcile`, main sweeps, codegraph) and support tasks are not ticket stages and carry no requirement; a support task keeps its own platform route. The motivation was pyrycode-desktop #1983, a mute test that failed only on macOS while a Linux builder that could not reproduce it owned the ticket.

A manager advertises its operating system automatically, `macos` on macOS and `linux` on Linux, and its hardware from the optional `capabilities` list in its configuration, for example `"capabilities": ["android-device"]` on the Mac with the physical phone attached. The list may name only hardware; naming an operating system or an unknown capability fails startup. Status shows the result as `capabilities`, and startup logs it. The manager reports the list to the claim service at startup and every minute (`POST /machines/capabilities`, machine credential; the credential names the computer).

The claim service enforces the requirement at admission: it refuses a start whose computer's last report lacks a required capability with the reason `incapable`, before ownership, capacity and locks, and reserves nothing. It reads the labels from the workflow store, so only adopted projects carry requirements. A computer that never reported, such as one still on an older manager, advertises nothing and runs only tickets without a requirement. Admission uses the last report whatever its age, since a computer's capabilities do not change while it is away. The manager passes over such offers too, so other work starts in their place.

Existing ownership cannot trap a ticket. Every 15 seconds the claim service releases each claim whose owner lacks a capability its open ticket now requires, when no run holds the ticket, for example after `requires:macos` is added to a ticket a Linux builder owns. The release is recorded with the assessment releases (`releasedAssessmentClaims`), so a supervised update reads the disappearing claim as a release rather than an ownership change. Branches, working copies and GitHub state are untouched, as with `free`. The next stage is then taken like any unowned ticket by a computer that can run it; refinement and recovery assessments still start no claim, so ownership moves at the next builder. A running stage keeps its claim until it ends. A closed ticket keeps its claim.

The snapshot carries `ticketRequirements` (open tickets with a requirement), `machineCapabilities` (each computer's last report and its time) and `noCapableMachine`: requirements that no computer with a report from the last three minutes can meet, each with the capabilities no such computer offers at all. In the manager's status queue an offer this computer cannot run shows `missing-capability` when another computer can, and `no-capable-machine` when none can. `operator.sh attention` lists the latter under `capabilityGaps`, with a reason that names a computer that offered it earlier, so its manager can be checked, or says that none does. An older claim service sends none of these fields and enforces nothing; an older manager sends no report. A requirement therefore takes effect only once the claim service and the managers that should run the ticket have this change.

The pipeline adds requirements itself when it files a failure ticket from one run. A new flaky-test ticket, a new shared live failure ticket ("fix shared live failure") and a new main sweep failure ticket record `Seen on macOS` or `Seen on Linux` and carry `requires:` for that system, since one run saw the failure on one system. A main sweep that could not start says nothing about where tests fail and gets no requirement. When a later sighting on the other system is recorded on a flaky-test ticket, or on a shared live failure ticket that carries the pipeline's marker for the test, the operating-system requirement is removed, because the failure is no longer specific to one system. A person's own bug ticket matched only by the test's name keeps the requirement chosen for it, and hardware requirements are never removed automatically. `createIssue` now creates missing labels in their family colour before filing, so `requires:` labels appear in their dark brown (`5C3D1E`) rather than GitHub's grey.

Each role is `heavy`, `medium` or `light`. Build agents default to medium, including the classic developer role. Refinement and documentation agents default to light. Verifiers and unknown roles default to heavy. Documentation keeps its separate one-at-a-time restriction per project board across computers. Explicit role configuration can override these defaults.

Every physical computer has two shared limits: `heavyLimit` bounds heavy jobs, and `combinedLimit` bounds heavy plus medium jobs. Both are required positive integers. The combined limit must be at least the heavy limit. Light work consumes neither limit.

With heavy at 1 and combined at 2, the computer can run one verifier and one builder, or two builders. It cannot run two heavy jobs or three medium jobs. Jobs retain their resource class for their whole run; there is no mid-run upgrade or second reservation. Existing role restrictions such as serial documentation still apply across computers to protect shared files.

A role restriction has a scope. Unmarked restrictions count every computer, which is the default and what older workers get. The builder set's verifier is marked `roleLimitScope: "machine"` since 2026-10-14: its restriction protects the host, where its gates use the emulator and start a relay and a daemon, so it counts only the computer the run would start on. Two verifiers of one project can run on two computers at once, never two on one computer. A fork that sets `PYRY_VERIFIER_SERIAL=0` gets no scope: its `PYRY_VERIFIER_MAX` number stays a total across computers. Documentation stays fleet-wide, because its conflict is the shared `docs/knowledge/INDEX.md`. A machine-scoped offer carries no role lock, since locks are fleet-wide. The scope takes effect only where the claim service, the local manager and the project's dispatcher all have this change; an older component counts the whole fleet, which is the previous behaviour.

A computer can also cap one project's heavy jobs below its heavy limit with the optional `projectHeavyLimits` map, keyed by repository, for example `{"pyrycode/pyrycode-mobile": 1}`. A project absent from the map has no extra limit. A support task is charged to the project of the ticket it serves. Set the same map in the claim service's entry for the computer and in its local manager configuration, as for the other limits; each enforces its own copy. The manager rejects a key for a project it does not serve. Added 2026-10-14 for build-hp-1, where one Mobile verifier used 17 to 22 GB of 31 GB, so it can run two heavy jobs but not two Mobile ones.

Each reservation covers setup, the agent, its pre-verifier tests, retries, cleanup and indexing. Heavy runs consume both counters. Medium runs consume only the combined counter. Standalone live gates and main checks are always heavy. Merge work is light, so a ticket that reaches Done merges without waiting for a heavy or combined place. The merge itself is a few GitHub calls and a pull of main. The codegraph refresh a merge needs is CPU work, so it is not part of the merge: the dispatcher runs it afterwards as its own medium job, `@codegraph-<computer>`, charged against that computer's combined limit, one at a time per computer and project. It stays single by ownership, not capacity: only the ticket's claiming computer is granted the merge, the claim service admits one unfinished run per ticket, and the project's merge lock admits one merge per board across all computers. Before 2026-10-14 merges were heavy, and pyrycode-mobile #1977 waited 13 minutes in Done behind an unrelated repair task. Background children in the recorded process groups keep the reservation until they exit. Programs that deliberately detach into a different process group are outside that check. Do not use daemonised test runners for managed jobs.

Only admitted runs create claims. Writing follow-up tickets, comments or labels does not claim those tickets. This also prevents a drained computer from turning newly filed follow-ups into owned work.

Recovery assessments and refinement (`recovery`, `refiner`, and `po` in the classic stage set) start no ownership either, since 2026-10-14. A refiner writes the issue body, comments and labels on GitHub and leaves no branch, worktree or local evidence that a later stage needs. Ownership therefore starts with the first stage that makes local work: the builder, or the architect and developer in the classic set. These runs still hold their reservation, locks and run generation while they run, so the ticket cannot run twice, and a ticket the computer already owns keeps its claim unchanged. Such a run counts against the new-ticket limit while it runs. Once it finishes, the ticket is free for any computer.

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
a new incident. Rework counts of two or more request an assessment, not a repair,
while the ticket is still in its rework loop. Once review passes, shown by
`done:verifier` or `done:code-review` or a move to In Documentation, the count is
history: no incident opens and a queued one resolves. A later stage sending the
work back to the builder or developer starts a new round and is assessed again.

A retained reservation with no workflow progress for three hours produces one
durable operator incident for that exact run. This includes cards returned to
Backlog. It does not launch another worker or release uncertain capacity. Fresh
workflow progress and a new reservation restart the grace period. The diagnostic
resolves when the owning session confirms that run ended. Ordinary unclaimed
Backlog waits remain quiet. A running label stranded in Backlog can also alert.

The owning computer, or for an unclaimed ticket any computer that observes it, offers an assessment as the `recovery` role. It uses normal
admission and a heavy reservation. Only one assessment runs across the fleet at
a time. Existing ownership, both capacity limits, project drains and full drains
apply. A `priority:high` ticket whose next stage is the verifier (role `verifier`, which only the builder stage set has) goes first: it precedes recovery checks, assigned repair stages (`orchestrator:recovery-priority`), recovery errors and support tasks, owned or not, and therefore all other waiting work. Several such verifiers keep the order below among themselves. A verifier without `priority:high` keeps its usual place. The central snapshot lists the open `priority:high` tickets of adopted workflow projects as `priorityHighTickets`, read from the workflow store, so this also ranks offers from older workers. It changes ranking only. Running work is not interrupted, and locks, ownership, project drains and the heavy, combined, new-ticket and role limits still apply, so a verifier that does not fit leaves the place to the next job that does. Runnable owned recovery and repair work precedes owned ordinary work. Both owned groups precede unclaimed recovery and ordinary work. Routine dependency assessments and quiet Inbox readiness checks are an exception: they run only when the local computer has no active ticket reservation and no ready ticket work was selected. These waiting checks do not count against the new-ticket limit. The central snapshot identifies them from their recorded incident reason, including offers from older workers. Actual errors, returned Inbox investigations and assigned repairs retain their existing recovery priority. A job that cannot fit the available capacity does not block a fitting job. Already reserved or running jobs are not interrupted. An unreachable owner or uncertain reservation is never released by recovery.
Since 2026-10-14 an assessment starts no ticket ownership. On an unclaimed
ticket it is admitted with its own run generation and heavy reservation, which
keep the ticket exclusive while it runs: no other run starts, and only the
assessment's own run can write the ticket. Completion leaves the ticket
unclaimed, whatever the decision. Before this, every admitted assessment
claimed the ticket, so a computer that assessed a blocked ticket became its
permanent owner, and when the blockers closed it held more runnable tickets
than the claim budget allows. A decision that orders work, such as rework,
refinement or a retry, leaves that work to normal admission, which claims the
ticket for whichever computer starts it. A coordinated repair task is queued
centrally and runs on any computer with its capability, as before. An
assessment of a ticket its computer already owns runs under that claim and
leaves it unchanged; an assessment cannot run on a ticket another computer owns.
The assessment's evidence inventory is shared through the authority, but its
log excerpts are read from the assessing computer. The run that hit an error
publishes its follow-up assessment offer before freeing its place. On an
unclaimed ticket, such as one whose refiner failed, another computer can still
win that assessment; it then sees the GitHub comments and the evidence
inventory, but not the failed run's log excerpts. A coordinated repair task
whose ticket is unclaimed ranks with unclaimed work, not owned work. Only the
computer running a job raises the three-hour retained-reservation alert for it.
A Backlog ticket counts as started for the 24-hour no-progress check when it
is owned, has a running label or the repair marker, carries recovery priority,
or has finished refinement (`done:refiner` or `done:po`). An ordinary Backlog
wait stays quiet.
An earlier claim whose ownership generation contains only completed read-only
assessments or explicitly unused reservations is still released when a
confirmed completed assessment says `wait`. Any implementation run, uncertain
run or assigned repair preserves ownership. Recorded decisions and run history
remain available. The authority records the exact released owner and ownership
generation. Restart verification accepts that receipt while preserving its
check against unexplained ownership changes. The operator can end a stuck
assessment on an unclaimed ticket with `free TICKET GENERATION
--confirmed-stopped`, using the run generation from status.
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

`wip:repair` shows the assigned repair run itself. It was called
`orchestrator:repairing` for its first day (2026-10-14) and is a `wip:` label so
that every tool that reads `wip:` as "busy" shows it: takeover and halt refuse
the ticket, and the board watch counts it. Retry, rework, resume and refine
receive it with the handback, because each assigns an ordinary stage run: the
failed stage, the builder or developer, the recorded stage, or the refiner. It
stays while the ticket waits for that run and while the run works. It is removed
when that first run finishes, whatever its outcome, and on every condition that
removes recovery priority. Unblock and coordinate assign no stage run, so they
get priority without this label.

Two rules separate the repair marker from an agent's own `wip:<agent>` label.
The central admission check refuses a stage run on a ticket with any `wip:`
label except `wip:repair`, because the run it is waiting for is the assigned
repair. And the marker is never a running agent: the stranded-label sweep
ignores a ticket that carries only the marker (a repair waiting for a slot is
not stranded) and strips the marker together with a stranded `wip:<agent>`
label, never while that agent's run is in flight. Recovery treats a ticket with
only the marker as assessable, so a repair that never starts can reopen after
the usual 24 hours; a real running label still blocks assessment.

When the assigned run starts, the dispatcher posts one comment on the ticket
that begins `<!-- pyry-repair-start -->`. It names the stage and the computer
running it, which is the dispatcher's own machine name and not necessarily the
computer that holds the ticket's claim label. Evidence hashing skips the comment.

Owned, idle-ticket reconciliation removes stale labels after an interrupted
run or failed cleanup. It removes a repair marker left without recovery
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

### Quiet repeat assessments

A repeat assessment whose ticket stage, recovery labels, blocked state and pause
record are what the last assessment saw, so that only comments, the body, logs,
recovery task results, coordination or a dependency moved, is spaced out. The first
such repeat waits 30 minutes after the last decision, the same as the earlier
evidence cooldown. Each further one in a row doubles that, to 1, 2 and then 4 hours,
the ceiling. A result the last decision waited for, the recovery task it coordinated
or a dependency it named, is read at once the first time, and its repeats follow the
same doubling, so a loop of failing repairs slows down instead of running every hour.
An escalation to a person keeps the flat 30 minutes, so a reply by comment is read
promptly.

Never held: any change to the stage, the recovery labels, whether the ticket is
blocked or its pause record, which includes every new stage error; anything after an
applied repair (`retry`, `rework`, `resume`, `refine`, `unblock`); a manual trigger
such as a `needs-human:` hold or a denied permission, which escalates at once as
before; and a code deadline or the safety interval, also when evidence moved
meanwhile. A deadline or safety reassessment keeps the count of quiet repeats; any
other non-quiet assessment starts it again. `/recovery/state` shows a current
assessed incident's `cadence`: `quietRepeats` and `nextQuietReassessAt`. Set
`recovery.reassessBaseMinutes` (5 to 1440) and `recovery.reassessCeilingHours` (up
to 168) in the claim service configuration to change the spacing.

Measured on 2026-10-14: 154 recovery assessments in one day against 36 builder
runs. 25 were the overnight unchanged-wait loop settled above. 28 were started by
nothing but the comment read: the publisher reads an issue's latest eight
comments, so each recovery report pushed an older comment out of view and moved the
evidence revision, and pyrycode#3268 was escalated to a person five times that way.
The evidence revision is now recomputed only when the body changes or a counted
comment appears or is edited; a comment leaving the read is not new evidence, and
nor is an automatic-retry status note, whose labels already carry the change. The
comments it was computed from are kept beside the ticket, in
`workflow_evidence_seen`, so recording them never changes the ticket's revision. A
deleted comment alone does not move the revision. With nothing recorded, as on the
first read after an upgrade, the revision is computed exactly as before, so the
upgrade itself starts no assessments.

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

Recovery now watches changed issue evidence and dependency revisions as well as errors and repeated rework. Blocked issues receive an assessment. An unchanged dependency wait does not repeat that assessment on a timer. Changed evidence can reopen an escalation after a thirty minute cooldown, doubling to four hours while only evidence keeps changing (see Quiet repeat assessments). Workflow changes remain eligible immediately. Inbox items with no progress for a day also enter assessment. A pipeline Inbox item needing live evidence can enter immediately. Evidence refinement returns to the normal planning stage with its portable proof brief.

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

### No-progress watchdog

Each supervisor pass also runs `scripts/fleet-watchdog.py` over the places held
on its own computer. It never signals, starts or reaps a process. It measures
each holder against a limit for its phase, set under `watchdog` in the
supervisor configuration:

- A native task running: its recipe's own time limits plus 15 minutes.
- A native task that wrote its result, while its completion or publication
  preparation is refused: 10 minutes after its last worker write.
- A native task publishing: 10 minutes after the phase was first seen.
- A native task in attention: 30 minutes. A deferred grant: 60 minutes.
- A dispatcher run: two hours with none of its ticket's logs written.

Progress is a phase change or a write by the worker itself: its logs, check
results, result or publication. Files the supervisor writes, such as the custody
journal, do not count, and neither does a file dated more than a minute ahead of
the clock. A result dated in the future counts from when it was first seen.

Its one automatic action is to finish a native task as failed when every one of
these holds: the record is `running` or in `attention`, never `publishing`; its
result is written; the supervisor's own custody proof has confirmed its worker
drained; the control service answered `prepare-repair` or an artifact transfer
with the same 4xx refusal on at least five consecutive passes over more than ten
minutes; and ten minutes have passed since the worker's last write. A timeout, a
lost connection, a local crash or a refusal that changes restarts the count. The
release is conditional: the service accepts it only while it holds the task as
running or in attention, and refuses any failed completion while a publication
for that task is still being written. A service that already holds another
outcome stops the retries and leaves one item for an operator. The summary names
the refusal and the task whose private folder keeps the result, logs and any
prepared publication. Nothing is published. Anything else past its limit,
including a live worker, a worker whose absence is not proven and every
dispatcher run, becomes an attention item and nothing is released.

Limits come from `watchdog` in the supervisor configuration. A value of the wrong
type falls back to its default and is reported. A watchdog that fails to load or
to run is reported as an `error` item; the supervisor and its report carry on.

A heavy job waiting for capacity for 60 minutes while every heavy place is held
by work with no progress for 30 minutes produces a starvation item naming both.
So does a supervised update waiting that long for native work with no progress.

The findings are published as the operation report's `watchdog` list, which
`operator.sh attention` returns under each computer in `operationReports`.
Each item has `kind` (`stalled`, `starvation`, `finalize-refused`, `finalized`,
`released` or `error`), `action`, `reason`, and where known `subject`, `ticket`,
`phase`, `worker`, `holder`, `since`, `lastProgress` and `limitSeconds`. Times are
Unix seconds. Releases by the dead-worker path and by the watchdog stay listed as
notices for a day. Each new finding and each release is also written to
`housekeeping.jsonl` once. Findings stay out of the report's `housekeeping` list,
which keeps its room for clears, retirements and releases.

#### Central tasks nobody holds

The watchdog reads only the local receipts, so a central task record left
`running` or `attention` after its receipt was moved away or lost, and its
reservation cancelled, had no detector. The claims service now lists those.
Each supervisor report carries `localTasks`, the ids of the receipts and deferred
markers in its `tasks` folder. A task is held when a reservation for it is open
or any computer lists it. A task that is running or in attention and held by
nothing for 60 minutes is returned by `GET /tasks/orphaned`, and
`operator.sh attention` carries the list as `orphanedTasks`.

Each item has `kind` `orphaned-task`, `task`, `ticket`, `machine`, `state`,
`since` (Unix seconds, when it was first seen unheld) and `reason`. It is
attention only: nothing is closed or released. The record has to be closed by
hand, for example with `recovery-task complete`, after checking the computer.

The evidence has to be positive. The task's own computer must have reported in the
last 15 minutes with a `localTasks` list, so a computer that is briefly offline,
or still on a supervisor that does not send the list, reports nothing. The clock
restarts whenever the condition stops holding. If the claims service cannot answer, `orphanedTasks` is `null` with `orphanedTasksError` beside it, which a reader must treat as unknown rather than as none. The receipt lists themselves stay out of the operator report. The limit is
`recovery.orphanedTaskMinutes` in the claims configuration, default 60.

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
