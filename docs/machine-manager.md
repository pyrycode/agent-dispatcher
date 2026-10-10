# Multi-computer dispatch

Managed mode adds one manager per physical computer and one shared claim service. The existing project dispatchers still own their stages, blockers, tool environments and agent runs. This is opt-in. Do not run an independent dispatcher against a board that managed computers share.

The claim service uses SQLite on its own local disk. It grants a ticket and the computer's capacity in one transaction. There is no broker, distributed database, heartbeat expiry or automatic failover. A service outage prevents new starts. An existing run can finish, but its reservation remains until the finish is acknowledged.

## Scheduling

Each manager configuration lists projects in priority order. It considers runnable locally claimed tickets first, oldest claim first. It then considers unclaimed tickets in project order. Within that ordering it uses the dispatcher's ticket priority labels and stage order. Running work is never pre-empted. A blocked or errored ticket stays owned but is absent from eligible offers, so other work can proceed. Strict project priority can starve a lower project if higher projects always have eligible work.

A dispatcher can explicitly cancel a reservation it never started, for example after a board stage changes. That cancellation releases a new ticket claim only if no actual or uncertain run has used that ownership generation. Completed, failed and blocked work keeps its claim. Offline reservations still require manual release. A cancelled offer therefore cannot gain priority over work that is ready to run.

Each role is `heavy`, `medium` or `light`. Build agents default to medium, including the classic developer role. Refinement and documentation agents default to light. Verifiers and unknown roles default to heavy. Documentation keeps its separate one-at-a-time restriction per project board across computers. Explicit role configuration can override these defaults.

Every physical computer has two shared limits: `heavyLimit` bounds heavy jobs, and `combinedLimit` bounds heavy plus medium jobs. Both are required positive integers. The combined limit must be at least the heavy limit. Light work consumes neither limit.

With heavy at 1 and combined at 2, the computer can run one verifier and one builder, or two builders. It cannot run two heavy jobs or three medium jobs. Jobs retain their resource class for their whole run; there is no mid-run upgrade or second reservation. Existing role restrictions such as serial documentation still apply across computers to protect shared files.

Each reservation covers setup, the agent, its pre-verifier tests, retries, cleanup and indexing. Heavy runs consume both counters. Medium runs consume only the combined counter. Merge work, standalone live gates and main checks are always heavy. Background children in the recorded process groups keep the reservation until they exit. Programs that deliberately detach into a different process group are outside that check. Do not use daemonised test runners for managed jobs.

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
pnpm fleet free /absolute/private/path/operator.json \
  'pyrycode/pyrycode#123' CURRENT_GENERATION --confirmed-stopped
```

Status includes durable owners, active reservations, both capacity limits, project order, last reports and the eligible queue. A claim with no offer can be blocked, errored, completed or waiting for its dispatcher. GitHub remains the source for the detailed workflow reason. A reservation records permission to run, not proof that its process is still alive.

Drain stops new grants. Dispatchers finish their current jobs and stop. Stop the service after draining, then restart it to resume. The drain flag is local process state; a manager restart resumes admission. Never configure an external watchdog to restart a deliberately drained manager.

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
