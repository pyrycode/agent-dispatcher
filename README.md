# agent-dispatcher

Dispatch agent runs through the shared orchestrator, with GitHub boards displaying workflow progress. Worktree isolation and recovery preserve unfinished work.

Built for [pyrycode](https://github.com/pyrycode); reused across multiple agents repos.

## What it does

The dispatcher polls a GitHub Project (v2) board, reads the current column + labels of each item, and decides whether to run an agent against it. Each agent is a `claude -p` invocation with a per-agent CLAUDE.md system prompt. Agents work in isolated `git worktree` checkouts, push to feature branches, and open pull requests.

Managed projects can adopt the central SQLite workflow authority. After import, stage and label decisions read the database. GitHub labels and columns are display only. Existing unmanaged and not-yet-imported projects retain their current behaviour. See [workflow authority and migration](docs/workflow-authority.md).

### Pipeline (default)

```
Inbox → Backlog → In Architecture → In Development → In Code Review → In Documentation → Done
         (PO)      (architect)       (developer)      (code-review)    (documentation)
```

Each transition is gated by a `done:<agent>` label, advanced automatically when the previous agent finishes. Failures route via `needs-rework:<agent>` (back to that agent) or `error:<agent>` (held for human triage).

A `needs-rework:<agent>` naming an agent the active stage set does not run parks the ticket under `error:rework-target` with a comment listing the agents that exist. Without that, the label stays on, nothing moves, and the agent that applied it is re-dispatched every cycle: on 2026-09-06 a verifier on the builder set applied `needs-rework:po`, a role that set lacks, and ran again 27 seconds later.

### Ticket priority

Priority labels decide which eligible ticket starts next, across all active
columns and within each column:

1. `priority:high`
2. `priority:normal`
3. No recognised priority label
4. `priority:low`

Equal priorities keep the existing order: later pipeline columns first, then
card position within the column. A high-priority Backlog ticket starts before
an unmarked ticket waiting in Development. Ready Backlog tickets use the same
priority order when competing for a free seat to enter the pipeline.

Priority does not interrupt running agents or bypass blockers, error holds,
manual gates or per-agent concurrency limits. Inbox stays parked.
Labels apply to the ticket itself. If several recognised priority labels are
present, the highest wins.

Run-generated repair work defaults to low priority in Backlog. The dispatcher
applies `priority:low` when creating flaky-test tickets, shared live-failure
fixes and main-sweep failure tickets. Agent prompts give the same default for
new bug, test-failure and maintenance follow-ups. Reusing a ticket preserves
its priority. Split children continuing the assigned work retain their parent's
priority. An operator can raise a generated ticket's priority afterwards.

### Worktree isolation

Each dispatch creates a fresh `git worktree` under `.<target>-worktrees/<agent>-<issue#>/`. Concurrent dispatches don't interfere; failures leave the worktree as evidence for triage; `git worktree remove --force` cleans up.

**Reusing the agent's own preserved worktree.** A run that stops with work left in its worktree keeps it: a blocked Codex run is preserved for recovery, and cleanup never force-removes a dirty tree. When the same agent is dispatched on the same ticket again, the dispatcher continues in that worktree instead of failing to create a new one, if all of these hold:

- after the normal cleanup, the only worktree with `feature/<n>` checked out is this agent's own path, `<agent>-<n>`;
- it is on that branch, not locked, and has no merge, rebase, cherry-pick or revert in progress;
- it has uncommitted changes, or local commits origin lacks.

Uncommitted changes are committed as one `wip(<agent>): partial work from an interrupted run (#<n>)` commit. Then the normal pre-run merge of the default branch and the normal run follow. One comment on the ticket names the commit. The commit is not pushed on its own; the run's normal pushes carry it. In every other case the dispatch fails as before and the comment names the worktree that holds the branch: another role's worktree, a person's checkout, a different branch or an unfinished merge or rebase. Reuse happens only when something else dispatches the ticket again, such as a person removing `error:<agent>` or an automatic retry. It never re-dispatches a parked ticket by itself. Added after pyrycode-mobile #1603 and #1727 on 2026-10-05, where a person had to commit the leftovers before the next run could start.

### Resume-in-place

Before any salvage, a run that exhausted its budget — the `max_turns` turn cap or the dispatcher's wall-clock timeout — gets up to `PYRY_RESUME_LEGS` continuation legs (default 1; `0` disables the feature and restores the pre-resume behaviour byte-for-byte). A continuation leg resumes the **same claude session** via `claude --resume <session-id>` with a fresh budget, inside the same dispatch and the same worktree, with every flag re-passed (they do not carry over on resume). Session ids are captured from the stream's init frame, so even a killed run that never emitted a result frame stays resumable. Most budget exhaustions are "ran out mid-task", not "stuck" — one fresh budget converts most of those human-triage interruptions into automatic completions. If the final leg is still exhausted, the salvage paths below run unchanged, keyed on the original run's result. Permission denials never resume; they keep their own salvage. Each leg has its own wall clock and earns its own wait credit for the device and build places, and the merged result adds the legs' credit together.

A Codex run stopped by its wall clock gets the same continuation legs under the same rules: it resumes its own thread through `codex exec resume <thread-id>` with every flag re-passed and the same continuation prompt, and keeps its wait credit for the device and build places on each leg. A run never switches runner on continuation. A blocked Codex run, an idle stall or a Codex error never resumes.

**Claude-binary bridge caveat:** continuation legs always spawn the `claude` CLI directly, regardless of `PYRY_USE_LEGACY_CLAUDE`, because the `pyry agent-run` wrapper has no resume support yet. This is a pilot bridge; it retires once the wrapper grows a `--resume` flag.

**Economics note:** graceful resumption changes the economics of ticket splitting — a ticket that would previously burn a human triage cycle on a budget miss now just costs a second leg, so oversized-but-coherent tickets get cheaper relative to eager splits. The refiner guides flip their split-leaning default separately once this is observed live.

### Salvage

When a run fails, the dispatcher tries these recovery paths before flagging it as errored. The first two apply only when the agent exhausted its budget mid-dispatch and any resume-in-place legs are spent:

1. **PR-already-exists** — if the agent opened a non-draft PR before timing out, treat the run as success.
2. **Safer-salvage** — if the worktree has uncommitted changes or committed branch changes relative to the default branch, run `go vet` + `go build` (or the consumer's configured salvage gates). When they pass, commit only outstanding edits, push and open a draft PR with `error:max_turns_salvaged`. A clean branch with no content change is not recoverable. The ticket stays blocked until human triage; recovery never marks the agent complete.
3. **Partial-work salvage** — any other failed run: stopped by the wall clock or the idle watchdog, a crash with no result, an error result, or a budget the draft-PR path could not save. Only stages that own commits on the branch qualify (architect, developer, builder, documentation; never verifier, code-review, qa or the refiner). If the worktree has uncommitted changes or local commits origin lacks, and no merge is unfinished, the dispatcher commits them as `wip(<agent>): partial work from a timed-out run (#<n>)`, or "a stalled run" or "a run that ended in an error", pushes to the branch and comments on the ticket, before the worktree is removed. It opens no PR; the comment names the branch's PR when there is one. The failure is then handled as before: a stall or transient error retries, anything else parks under `error:<agent>`, but the next run starts from the pushed work. If the push fails, the comment names the worktree and it is kept. A permission denial, a blocked Codex run, a refinement or blocker-wait outcome, and a spawn that never started are never salvaged. Added after pyrycode-mobile #1430 and #1332 lost finished documentation edits to timeouts on 2026-10-01 and 2026-10-02. Widened to crashes, errors and branches without a PR on 2026-10-06 (#18): a crashed run's unpushed commits used to stop the next dispatch until a person pushed them, as on pyrycode-mobile #1340.

**What the error comment shows.** The `Agent Error` comment on the ticket holds the dispatcher's error line, the last 1500 characters of the CLI's stderr after a crash, and the agent's own last output: its last 12 text messages and tool calls, newest last, up to 2000 characters. A tool call is one line, such as `[Bash] ./gradlew check` under Claude or `[shell] ...` under Codex, noted when it starts, so a run killed inside a long command shows which one. Tool results are not kept. The text is scrubbed of credentials first. The draft-PR salvage body's "Last messages from the agent" block uses the same output; it was empty on every salvage before 2026-10-06, because it read the result frame's text, which a `max_turns` result does not carry (#16). After resume legs, the output is the last leg's. The agent's words stay out of the error message itself, which the transient-retry classifier reads.

### Family dispatch history

Every dispatched ticket increments a count on its family root. Marker comments retain the history and `family-dispatches:N` mirrors it on the board. Counts never stop the root or its descendants. The former family dispatch limit has been removed. Existing `error:family-breaker` labels and older parent-hold reports do not prevent selection or trigger recovery escalation. Done cleanup removes the retired label.

The old `PYRY_FAMILY_DISPATCH_LIMIT` setting has no effect. No reset comment or extra family budget is needed to continue work. Ordinary stage errors, review rework checks, explicit human holds, causal dependencies, active-worker protection and computer capacity remain enforced. `family-reset` remains a legacy history-management command; it is not needed to resume dispatch.

## Install

Currently consumed via `git submodule` from each agents repo. (Future: npm package once external adopters appear.)

```sh
cd <your-agents-repo>
git submodule add https://github.com/pyrycode/agent-dispatcher dispatcher
cd dispatcher && pnpm install
```

The agents repo provides:
- per-agent CLAUDE.md prompts (`architect/CLAUDE.md`, `developer/CLAUDE.md`, etc.)
- `.env` with `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `PROJECT_NUMBER`, `TARGET_REPO_PATH`, `AGENTS_REPO_PATH`
- `bin/pyry-start` (or equivalent) to launch the dispatcher

A launcher should install dependencies with `dispatcher/scripts/install-deps.sh`, not `pnpm install --silent`. The script installs unattended with a frozen lockfile, accepts a move of the pnpm store, stays quiet when nothing failed, and prints pnpm's output plus one line naming the failure when something did. On 2026-10-13, after `.npmrc` moved the store into the checkout, pyrybox's Desktop dispatcher exited with status 1 and no message 139 times: pnpm wanted to ask before removing a `node_modules` built against the old store, had no terminal to ask, and `--silent` hid it. `confirmModulesPurge: false` in `pnpm-workspace.yaml` also lets the old `pnpm install --silent` line through that switch, for launchers not yet changed.

## Updating the shared dispatcher

Make shared source changes in this repository. Test and publish the merged
revision here before updating the consumer repositories. Local fixes found in a
consumer's `dispatcher/` submodule must be reconciled here first.

The five maintained consumers are `pyrycode-agents`, `pyrycode-desktop-agents`,
`pyrycode-mobile-agents`, `pyrycode-relay-agents` and `tui-driver-agents` in the
`pyrycode` GitHub organisation. The paused v2 consumer is excluded.

For each consumer, inspect and preserve local changes, fetch the published
revision, update the `dispatcher` submodule and commit that pointer in the
consumer repository. Verify the published pointer matches the shared revision.
Install dependencies if they changed. A running dispatcher loads source at
startup, so report restart status separately from repository propagation.

## Required environment variables

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | PAT or OAuth token with `repo` + `project` scopes |
| `GITHUB_OWNER` | Repo owner (org or user) — e.g. `pyrycode` |
| `GITHUB_REPO` | Repo name — e.g. `pyrycode` |
| `PROJECT_NUMBER` | GitHub Project (v2) number |
| `AGENTS_REPO_PATH` | Absolute path to the agents repo (where per-agent CLAUDE.md prompts live) |
| `TARGET_REPO_PATH` | Absolute path to the target repo (where code is checked out and worktrees created) |

Optional:

| Variable | Default | Description |
|---|---|---|
| `TARGET_DEFAULT_BRANCH` | `main` | Default branch of the target repo. Set to `master` or your trunk-based branch name as needed. Threaded through `git checkout`, `git rev-list --count`, merge targets, and the empty-branch guard. |
| `SALVAGE_GATES` | `go vet ./...; go build ./...` | `;`-delimited shell commands that gate the safer-salvage path on `max_turns`. Each runs in the agent's worktree; all must exit 0 for the dispatcher to preserve committed or uncommitted branch work as a draft PR. Set to `""` to skip gating entirely. Override per ecosystem (e.g. `cargo check --all-targets; cargo test --no-run` for Rust). |
| `PYRY_STAGE_SET` | `classic` | Which agent pipeline this fork runs: `classic` (the six-agent relay, byte-identical default) or `builder` (collapsed four-role pipeline, piloted on one fork). Unknown values fail fast at startup. See below. |
| `PYRY_BUILDER_TIMEOUT_MINUTES` | unset | Absolute wall-clock limit for the builder only, after the general budget scale. Whole minutes from 1 to 240. Other roles and turn budgets are unchanged. Mobile sets 70 in its launcher. |
| `PYRY_VERIFIER_SERIAL` | `1` | Builder set only. The verifier runs one at a time by default, because its pre-spawn gates are host-level work (emulators, a relay and a daemon on one machine) that two verifiers would contend for. The exact string `0` lets verifiers run concurrently for a fork that wants to try it. Printed in the startup banner. |
| `PYRY_VERIFIER_MAX` | — | With `PYRY_VERIFIER_SERIAL=0`, caps concurrent verifiers at this number, 2 or more. Unset leaves them limited only by `PYRY_MAX_CONCURRENT`. Printed in the startup banner. |
| `PYRY_POLL_INTERVAL_MS` | `60000` | How long the loop waits between board reads when no run settles first. Whole milliseconds, floor `10000`; anything else keeps the default. Only idle pickup latency changes: a dispatch or a settled run wakes the loop at once. Mobile runs `120000` since 2026-09-22 to ease the account-wide GitHub API limit. |
| `PYRY_VERIFIER_GATES` | `go vet ./...; go build ./...` | Builder stage set only: `;`-delimited deterministic gate commands the dispatcher itself runs in the ticket's worktree before spawning the verifier. Same parsing as `SALVAGE_GATES`; set to `""` to skip the pre-verifier gate step. A fork's `.env` sets the full list, e.g. `make check;make build`. Inert in the classic set. |
| `PYRY_VERIFIER_PARALLEL_REVIEW` | `0` | Exact `1` opts a Claude or Codex verifier into preliminary source review alongside its deterministic gates. Both must finish before the final verifier can triage and publish. Other roles, classic and empty gate lists keep sequential behaviour. See below. |
| `PYRY_VERIFIER_GATE_TIMEOUT_MS` | `1200000` | Builder stage set only: wall clock for each `PYRY_VERIFIER_GATES` command, extended by any time the command spends waiting for the Android device or a Gradle build place, up to `PYRY_TIMEOUT_CEILING_FACTOR` times this value. A gate that runs past it reads as red and the verifier spawns in triage mode. Raise it for a fork whose slowest gate needs longer; Desktop runs `1800000` since 2026-09-25 because its serial Playwright tier takes about 15 minutes. |
| `PYRY_VERIFIER_GATE_REUSE` | `1` | Builder stage set only. When every verifier gate passes, the dispatcher records the pass in `logs/verifier-gate_#<issue>.pass.json`, keyed by the tree of the merged commit the gates ran on, meaning its files, and the ordered gate list. The commit is recorded too, for the note and the log. The next verifier dispatch for that issue reuses it instead of running the gates, when both match, the pass is under 24 hours old and its gate logs still exist. A run with any red, timed-out or unspawnable gate is never recorded. The exact string `0` turns reuse off. |
| `PYRY_VERIFIER_DOCS_PATHS` | `docs/**` | Builder stage set only. Comma-separated path globs that count as documentation for docs-only gate reuse. `**` spans folders and `*` stays inside one. When the recorded pass is on other files, the dispatcher lists the files changed since the pass's commit. If every one matches these globs, the code gates are reused and only `PYRY_VERIFIER_DOCS_GATES` run. The age limit, gate list and log checks still apply. Any other changed file, a commit git cannot find, or a git error runs every gate. The default covers the plan under `docs/specs/architecture/`. Set to `""` to count nothing as documentation. `PYRY_VERIFIER_GATE_REUSE=0` turns this off too. |
| `PYRY_VERIFIER_DOCS_GATES` | — | Builder stage set only. `;`-separated gate commands, written exactly as in `PYRY_VERIFIER_GATES`, that still run on a docs-only change, for example the fork's docs guard. Unset means none, so a docs-only change runs no gate. A command not in `PYRY_VERIFIER_GATES` is ignored. When they pass, a pass is recorded for the new files, so a retry on them is an exact match. A red one sends the verifier into triage mode as usual and records nothing. |
| `PYRY_VERIFIER_GATE_FORMATS` | — | Builder stage set only. Opt-in, per gate: a JSON object keyed by a gate command exactly as written in `PYRY_VERIFIER_GATES`. Each value is a format, `go-json`, `playwright-json` or `junit-xml`, or an object `{"format": "...", "baseline": "... {{TESTS}}"}`. When that gate goes red, the dispatcher reads its failing test names from its stdout before spawning the verifier. With a `baseline` template it re-runs them once in the same worktree, and sets aside the ones that pass there as flaky and the ones that already fail on main. See "Failures already on main" below. A gate missing from the object, and unset, empty or unreadable JSON, keep today's behaviour exactly. Mobile's UI gate, for example: `{"ANDROID_GATE_WAIT_SECONDS=2700 python3 scripts/android-test-gate.py ui": "junit-xml"}`. That gate has no `baseline` because Mobile's gate script accepts `--tests` only in `live` mode, as of 2026-10-05. Until it accepts `ui --tests`, its failures are not re-run and only the main sweep can set them aside. A baseline command that fails without naming its tests leaves every failure with the ticket. |
| `PYRY_VERIFIER_GATE_INHERITED_ADVANCE` | on | Builder stage set only. On, a failure that a gate in `PYRY_VERIFIER_GATE_FORMATS` sets aside because it also fails on main counts only when an open ticket tracks it, found or filed as for the live gate, and then the gate counts as green and the ticket gains no blocker. `0`, `false`, `off` or `no` keeps the earlier set-aside, which needs no tracker. See "Tracked inherited failures" below. |
| `DISCORD_WEBHOOK_URL` | — | Notify on dispatch start/end |
| `PYRY_SKIP_QMD_REFRESH` | — | Exact `1` skips the `qmd update && qmd embed` run before each worktree agent spawn and logs one line instead. Only for a fork whose host keeps the index fresh another way; pyrybox's pyrycode container sets it because a timer reindexes there whenever main moves, and the per-spawn run hit its 120 s limit on every spawn. Unset keeps the per-spawn refresh. |
| `PYRY_LOG_RETENTION_DAYS` | `30` | Rotate logs older than N days; `0` disables |
| `PYRY_RESUME_LEGS` | `1` | Resume-in-place: how many same-session continuation legs a budget-exhausted run gets before salvage. `0` disables the feature entirely (byte-identical pre-resume behaviour). See above. |
| `PYRY_AGENT_IDLE_TIMEOUT_MINUTES` | `10` | Both runners: kill a run whose stream has been silent this long while no tool call is outstanding, and fail it with `idle_stall`, which retries with backoff like any transient error. A running tool, such as a long Gradle test run, never trips it; the wall clock still bounds that. For Codex, a tool call is any item between its `item.started` and `item.completed` events, except a to-do list. Fractions allowed; `0` disables. Added after pyrycode-mobile #1430 sat silent for twenty minutes inside one assistant turn on 2026-10-02, and extended to Codex on 2026-10-04. See "Time limits and waiting". |
| `PYRY_TIMEOUT_GRACE_MINUTES` | `20` | Both runners: when a run's budget is spent while a command it started earlier is still running, wait up to this long for that command to finish before stopping the run, so any wait it reports can be credited. Commands started after the deadline hold nothing. Fractions allowed; `0` disables; garbage keeps the default. See "Time limits and waiting". |
| `PYRY_TIMEOUT_CEILING_FACTOR` | `2` | Hard ceiling, as a multiple of the normal budget, that wait credit and grace can never take an agent run or a dispatcher-run gate past. `1` turns all extension off, which is the behaviour before 2026-10-04. Below 1, empty or garbage keeps `2`. See "Time limits and waiting". |
| `PYRY_BUDGET_SCALE` | `1` | Multiplier on every agent's turn cap and wall-clock timeout, for a fork whose tickets or model need a different budget without changing the others. Timeouts round to whole minutes. Unset, empty, non-numeric, zero or negative keeps `1`. Mobile runs `1.5` since 2026-09-23, after moving to Opus 5.5 and raising its ticket ceiling to 1600 lines. Printed in the startup banner. |
| `PYRY_REQUIRED_ENV` | — | Comma- or space-separated names of environment variables this fork cannot work without, such as `ANDROID_HOME`. Checked every cycle against the dispatcher's own environment. While one is unset or blank, no agent is dispatched and neither the live gate nor the main sweep starts, a warning is logged and one Discord message is sent. Board upkeep, rework routing and merges carry on. Restart the dispatcher with the variable set to resume. Unset requires nothing. Added after mobile #1631 parked on 2026-10-03, when a restart lost `ANDROID_HOME` and the builder found Gradle could not locate the SDK. Printed in the startup banner. |
| `PYRY_AGENT_SHELL_ENV` | — | Codex runner only. Comma- or space-separated names of non-secret settings that Codex agents' shell commands should see, such as `ANDROID_HOME`. The user's Codex config inherits only core variables into tool commands, so without this a builder cannot see what the fork's `.env` supplies. Each listed name that is set and not blank in the environment Codex gets is passed as its own `-c shell_environment_policy.set.NAME=...` override, the same way `AGENTS_REPO_PATH` is. A name that looks secret, containing `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `AUTH` or `PRIVATE` or starting with `OP_` in any case, or that is not an upper-case variable name, is skipped with one warning per dispatcher process. The read-only preliminary source review gets none of them: it ignores the user config, so the core-only policy does not apply to it, and it builds nothing. Unset passes nothing. The Claude runner needs nothing, since its shells inherit the environment. Printed in the startup banner. Mobile #1631 parked on 2026-10-03 on "ANDROID_HOME is missing from the dispatcher environment". |
| `PYRY_HEALTH_GITHUB_CMD` | — | Pre-dispatch health check: a shell command proving the agent can reach GitHub, such as `gh auth status --hostname github.com`. Exit 0 passes. Runs before every role's dispatch, in the environment the agent's tool commands get. Unset is off. See [Health check before dispatch](#health-check-before-dispatch). |
| `PYRY_HEALTH_FIGMA_CMD` | — | Pre-dispatch health check for the Figma MCP tools, run in the agent process's environment. Guards `PYRY_HEALTH_FIGMA_ROLES`, default `builder,verifier`. Unset is off. |
| `PYRY_HEALTH_LIVE_LOGIN_CMD` | — | Pre-dispatch health check for the live-test Claude login. Guards `PYRY_HEALTH_LIVE_LOGIN_ROLES`, default `builder`, and the dispatcher's own live gate. Unset is off. |
| `PYRY_HEALTH_DAEMON_CMD` | — | Pre-dispatch health check for the test daemon, usually printing its version. Guards `PYRY_HEALTH_DAEMON_ROLES`, default `builder,verifier`, and the live gate. With `PYRY_HEALTH_DAEMON_MIN_VERSION` set, the first version number the command prints must be at least that. Unset is off. |
| `PYRY_HEALTH_<CHECK>_ROLES` | per check | Comma- or space-separated roles a check guards, overriding its default. `all` or `*` means every role. `<CHECK>` is `GITHUB`, `FIGMA`, `LIVE_LOGIN` or `DAEMON`. GitHub defaults to every role. |
| `PYRY_HEALTH_CACHE_MS` | `300000` | How long a health check result is kept, per check and environment, so a two-minute poll does not run `gh` or `op` every cycle. `0` re-runs every cycle. Garbage keeps the default. |
| `PYRY_BUILDER_REWORK_CAP` | `6` | Rework breaker: how many times a ticket can be sent back to the code owner, `needs-rework:builder` in the builder set, before the next route parks it under `error:rework-loop`. Reworks routed to any other agent count on a separate `rework-other:N` label that never parks. On a verifier route to the builder, a `[MUST FIX]` finding with the same `path → Symbol` in the last two FAIL verdicts parks at once, whatever the count, when the two findings also read alike: their normalised word sets must overlap by at least 0.3 Jaccard similarity, so a different defect in the same function is not a repeat (agent-dispatcher#130); the parking comment says which rule fired. A finding located at a branch (`feature/<n>`, `main` or `HEAD`) rather than a source file has no source symbol and never counts as a repeat: on 2026-10-07 the same "merge current main" finding in two FAILs running parked desktop #1825 with every code finding fixed. A blocker wait and a stale base FAIL settled by the dispatcher count nothing. Zero, negative or garbage keeps `6`. Was a flat 3 on every rework route until 2026-10-05 (agent-dispatcher#122). Printed in the startup banner. |
| `OWNER_TYPE` | `user` | `user` or `organization` for GitHub Project owner |
| `PYRY_REAL_CLAUDE_GATE_CMD` | — | Shell command that runs the fork's live-claude suite. **Empty disables the gate entirely** and gated tickets park for an operator. See below. |
| `PYRY_REAL_CLAUDE_GATE_FORMAT` | `go-json` | How to read what the command wrote: `go-json`, `playwright-json` or `junit-xml` |
| `PYRY_REAL_CLAUDE_GATE_TIMEOUT_MS` | `1800000` | Outer wall clock for one gate run. Must exceed the command's own inner timeout. Extended by waiting for the Android device or a build place, like the verifier gates. |
| `PYRY_REAL_CLAUDE_GATE_MIN_EXECUTED` | `1` | Floor for the executed-test guard. Set near the suite's real count. |
| `PYRY_REAL_CLAUDE_GATE_INHERITED_ADVANCE` | on | `0`, `false`, `off` or `no` parks every inherited failure behind its fix ticket. On, a run whose only failures are inherited, re-run confirmed and tracked advances to documentation. See "Advancing past a tracked inherited failure". |
| `PYRY_REAL_CLAUDE_GATE_BASELINE_CMD` | — | Base-commit re-run template with a `{{TESTS}}` placeholder. Runs only when the branch has named failures, so it costs seconds. Unset means failures are attributed to the branch. |
| `PYRY_REAL_CLAUDE_GATE_BACKGROUND` | — | `1` runs the gate beside the poll loop. Only verifiers and the main sweep wait for it; builders, refiners and documentation keep working. Unset keeps the gate running alone. See below. |
| `PYRY_REAL_CLAUDE_GATE_HOLD_VERIFIERS` | `1` | `0` lets a background gate run beside verifiers too. Only for forks whose device runs queue on a host-wide hold, with `PYRY_VERIFIER_GATE_TIMEOUT_MS` long enough to cover that wait. The main sweep still never overlaps the gate. |
| `PYRY_REAL_CLAUDE_GATE_SELECT` | — | `1` runs only the live tests the pull request names, plus the always-run set, instead of the whole suite. Needs the baseline template. See "Per-ticket selection" below. |
| `PYRY_REAL_CLAUDE_GATE_ALWAYS_TESTS` | unset | Comma-separated qualified test names every live gate run must execute and pass, selection on or off; a selected run also includes them. See "Required named tests" below. |
| `PYRY_REAL_CLAUDE_GATE_FULL_PATHS` | — | Comma-separated path prefixes. A branch changing any of them runs the whole suite. |
| `PYRY_REAL_CLAUDE_GATE_FULL_EVERY` | `10` | Merges on the base since the last clean full run that force the whole suite again. State in `logs/real-claude-gate-full-state.json`. |
| `PYRY_GATE_EVIDENCE_KEEP` | `5` | Raw evidence folders kept per ticket. Every live gate run gets a fresh owner-only folder, `logs/evidence/<issue>/gate-runs/<stamp>/`, with one subfolder per part of the run (`main`, `rerun`, `base`, `infra-check`), and the command for each part receives its subfolder as `PYRY_GATE_EVIDENCE_DIR`. The gate worktree is removed after the run, so a fork's gate script writes captures it wants kept there. The evidence comment and the documentation agent's gate report name the folder. Folders older than `PYRY_GATE_EVIDENCE_DAYS`, beyond this count per ticket, or over `PYRY_GATE_EVIDENCE_MAX_MB` in total (oldest first) are removed when a new run starts. Nothing else under `logs/evidence/` is touched. Garbage keeps the default. |
| `PYRY_GATE_EVIDENCE_DAYS` | `30` | Age limit for live gate evidence folders, matching the dispatch log retention. |
| `PYRY_GATE_EVIDENCE_MAX_MB` | `2048` | Total size limit for live gate evidence folders on this dispatcher. |
| `PYRY_INFRA_BREAKER` | on | `0` turns off the live gate's infrastructure breaker. See "Infrastructure-shaped failures" below. |
| `PYRY_INFRA_BREAKER_MIN_FAILED` | `5` | Infrastructure breaker: fewer failed tests than this never trip it. |
| `PYRY_INFRA_BREAKER_MIN_FAILED_SHARE` | `0.5` | Infrastructure breaker: failed tests as a share of executed tests must reach this. |
| `PYRY_INFRA_BREAKER_WAIT_SHARE` | `0.8` | Infrastructure breaker: connection failures plus bare timeouts, as a share of failed tests, must reach this. |
| `PYRY_INFRA_BREAKER_MIN_SIGNATURES` | `3` | Infrastructure breaker: how many failing tests must name a connection, readiness or daemon failure, or how many admission rejection lines the output must hold. |
| `PYRY_INFRA_COOLDOWN_MS` | `1800000` | How long the live gate pauses after an infrastructure-shaped failure. `0` halts tickets but never pauses. Capped at one day; a pause file ending later than one cooldown from now is ignored. |
| `PYRY_INFRA_BASE_CHECK_TESTS` | `3` | How many connection-shaped failing tests the shape rule re-runs on the base commit before blaming the environment. |
| `PYRY_INFRA_BASE_CHECK_TIMEOUT_MS` | `900000` | Wall clock for that base check, never more than `PYRY_REAL_CLAUDE_GATE_TIMEOUT_MS`. |
| `PYRY_INFRA_PAUSE_FILE` | `logs/live-gate-infra-pause.json` | Where the pause is kept. Point every dispatcher on one computer at the same writable path to pause their live gates together. |
| `PYRY_CODEX_START_JITTER_MS` | `60000` | After a dispatcher starts, and in managed mode again when a fleet Codex pause ends, its Codex runs wait a random time up to this long, so a fleet-wide restart or the end of a pause does not start every Codex run in the same second. A managed dispatcher holds its Codex offers back meanwhile, so the wait holds no place. `0` turns it off; held at five minutes. See [Codex rate-limit pause](docs/machine-manager.md#codex-rate-limit-pause). |
| `PYRY_MAIN_SWEEP_CMD` | — | Main sweep: an in-depth command, too slow for every verifier pass, run against main when the board is idle or every `PYRY_MAIN_SWEEP_EVERY` merges. Runs inline, never beside a verifier. A failure files one Backlog ticket labelled `bug` and `priority:low`. While that ticket is open, a later failure comments the new failing set on it whenever the set differs from the last one recorded, and posts nothing when it is the same. **Empty disables it.** State in `logs/main-sweep-state.json`, including the main commit of the last sweep and the tests it failed. |
| `PYRY_MAIN_SWEEP_EVERY` | `5` | Merges since the last sweep that force one while the board is busy. |
| `PYRY_MAIN_SWEEP_TIMEOUT_MS` | `1800000` | Outer wall clock for one sweep. Extended by waiting for the Android device or a build place, like the verifier gates. |
| `PYRY_MAIN_SWEEP_FORMAT` | — | Optional `go-json`, `playwright-json` or `junit-xml`, to name the failing tests in the ticket. Without it the exit code alone judges the run. |

> **Load order.** `dotenv` now loads the fork's `.env` before any module-top constant reads `process.env`, so every variable in this table works from the file. Before 2026-08-07 the load sat below several of those reads, and `TARGET_REPO_PATH`, `TARGET_DEFAULT_BRANCH`, `SALVAGE_GATES` and `PYRY_AUTOCURATE_MEMORY` were silently file-blind — each fork's launcher pre-exported `TARGET_REPO_PATH` to work around it. Values a launcher exports, or that `op run --env-file` injects, still take precedence over the file.

### Stage sets

`PYRY_STAGE_SET` selects which agent pipeline the dispatcher runs. It is resolved once at startup, printed in the startup banner, and an unknown value exits immediately with the valid names.

`PYRY_MAX_CONCURRENT` is a pool of seats, not a batch size. Since 2026-09-22 each run frees its seat the moment it settles and the loop wakes to fill it, so a short refiner run beside a long verifier run no longer leaves its seat idle until the verifier ends (measured on Mobile: 6m24s idle in a 12-minute cycle). Rework routing and column advances run on every pass as before, and skip any ticket that still carries a `wip:<agent>` label, because that agent owns the ticket until it exits. A drain waits for every run in flight, and once the stop signal arrives nothing new starts: no agent run, no live gate run and no main sweep. A signal that lands while a ticket's running label is being written undoes that claim, so the ticket keeps the labels it had.

**`classic`** (default, also when the variable is unset) — the six-agent relay exactly as documented everywhere else in this README: PO → Architect → Developer → QA → Code Review → Documentation, advancing Backlog → In Architecture → In Development → In QA → In Code Review → In Documentation → Done. With this set the dispatcher's behaviour is byte-identical to before stage sets existed; the identity is locked by tests against literal copies of the classic config.

**`builder`** — a collapsed four-role pipeline, currently piloted on one fork:

| Role | Column | Notes |
|---|---|---|
| `refiner` | Backlog | The PO contract under a new name (`refiner/CLAUDE.md`, no worktree). |
| `builder` | In Development | Absorbs architect + developer: gets the Agent sub-agent tool AND WebSearch, 200 turns, 40min. |
| `verifier` | In Code Review | Absorbs QA + code review: Agent tool, code-review budgets (150 turns, 40min). |
| `documentation` | In Documentation | Unchanged from classic (serial, sonnet). |

The advance chain is Backlog → In Development → In Code Review → In Documentation → Done. The In Architecture and In QA columns are simply absent: never polled, never advanced into. Rework labels route against the set's own roles (`needs-rework:builder`, `needs-rework:refiner`, …), so create those labels in the fork's repo.

**Pre-verifier gates (builder set only).** Before spawning the verifier on a ticket, the dispatcher runs the fork's deterministic gates itself — the `PYRY_VERIFIER_GATES` commands, each capped at `PYRY_VERIFIER_GATE_TIMEOUT_MS` (20 minutes by default), in the ticket's worktree. The deterministic layer decides only green vs red; the verifier spawns either way, and a `GATES` section in the dispatch log records each command's verdict:

- **All green** → the verifier's prompt gets a gates-passed note, so it spends its budget on judgment rather than re-verification.
- **Any red** → the verifier's prompt gets the failure context in **TRIAGE MODE**: the failing gate, its verdict (exit code / timeout / spawn error) and the tail of its output (capped at 4000 chars). The verifier then owns the baseline partition and the bounce-vs-advance call, exactly as QA does today — failures that already exist on the merge base get filed and advanced rather than bounced, and only regressions this ticket caused go back to the builder. The dispatcher deliberately applies no rework label on red: a deterministic bounce would loop forever on a pre-existing failure.
- **Already green on these files** → when every gate passed on the same merged tree with the same gate list in the last 24 hours, the gates do not run again. Matching on the tree rather than the commit means a merge of main that was made again, with a new SHA over the same files, still counts. The verifier gets the gates-passed note saying the results were reused from that run and which commit it ran on, and the `GATES` section repeats the recorded verdicts. This saves a retry after a verifier crash from paying for the gates twice; on Mobile one pass takes 11 to 22 minutes. `PYRY_VERIFIER_GATE_REUSE=0` turns it off.
- **Only documentation changed since a green run** → when the recorded pass is on other files but every file changed since its commit matches `PYRY_VERIFIER_DOCS_PATHS`, the code gates are reused and only the `PYRY_VERIFIER_DOCS_GATES` run. The note lists the changed files and tells the verifier to check only those against the open findings, not to review the code again. A rework that only fixes the plan no longer pays for every gate.
- **Failures already on main** → for a red gate listed in `PYRY_VERIFIER_GATE_FORMATS`, the dispatcher first reads the failing test names from the gate's output. When the gate has a `baseline` template, those names are re-run once in the same worktree with the same filter, as the real-claude gate's same-tree re-run does, under the gate's own worker count for Playwright. A name seen passing every time there is flaky. Its sighting is recorded and tracked by the same rules as the real-claude gate's ([docs/flaky-tests.md](docs/flaky-tests.md)), after the checks against main below, and the verifier's note lists it as not this ticket's, with what became of the sighting. A re-run that cannot build a filter, times out, executes nothing or cannot be read excuses nothing. The names that remain go on to the checks against main. A name that also failed in the latest main sweep is a baseline failure, but only when that sweep ran on a main commit the branch's merged tree contains; a newer sweep, an unknown commit or no recorded sweep is not used. When the gate has a `baseline` template, the remaining names are re-run alone on the main commit merged into the worktree, as the real-claude gate's base re-run does, and the ones that fail there are baseline too. Baseline names are listed in the verifier's note as not this ticket's and recorded on the main sweep's open ticket, with the gated ticket and its commit; a name that ticket already lists is not recorded again. When no failure remains, because each was flaky or baseline, the gate counts as green for the verdict: the verifier gets the gates-passed note with the flaky and baseline lists, the gates after it still run, and the run is not recorded for reuse. A red whose output does not name every failure, such as a build error, stays red. Added after pyrycode-mobile #1747 failed four verifier passes on 2026-10-04 and 2026-10-05 over device tests that failed only under full-suite load, which a focused re-run on main could not reproduce. The same-tree re-run was added after flakes caused 10 verifier FAILs on pyrycode-mobile and 3 on pyrycode-desktop in the week to 2026-10-05.
- **Tracked inherited failures** → with `PYRY_VERIFIER_GATE_INHERITED_ADVANCE` on, the default, a failure set aside as baseline above counts only when it is inherited and tracked, the same rule the live gate uses ("Advancing past a tracked inherited failure"). When the gate has a `baseline` template, the main sweep is not used for this: every remaining name is re-run alone on the base commit, as the live gate's base comparison is, since a sweep may predate a fix on main the branch has merged. A gate without a template, such as Mobile's UI gate, still relies on the ancestor main sweep, the same evidence as the earlier set-aside; a tracker filed on the spot does not strengthen it. Each baseline name needs an open `bug` ticket that names it exactly: the hidden marker, the full name quoted in the body, or the whole name in the title. The main sweep's own ticket counts when its body names the test. One with no tracker gets one filed through the live gate's filing path, with the marker and the gate's evidence, at the top of Backlog, and counts once that ticket is confirmed. A tracker off the board, or in Inbox or Done, goes to the top of Backlog; one already in Backlog keeps its place, and no tracker gets a comment per sighting, since the gates run on every verifier dispatch. A gate that stays red for a failure of the ticket's own leaves the trackers alone, and so does a ticket that owns or names the test or a tracker matched only loosely. When every baseline name is tracked, the gate counts as green and the gates after it still run. The verifier's note says the gates are green except those inherited failures, tracked in the named tickets, and tells it to judge the ticket's own change, list each failure with its tracker in its verdict and pull request comment, and not add a blocker or route them to the builder. The dispatcher links no blocker either. Anything short of that keeps the gate red exactly as without a baseline reading, and the note says why: a name with no confirmed tracker, a tracker matched only by its method name, a gated ticket that owns the fix or names the test itself, incomplete gate output, a test killed by the binary's own deadline, a Go panic or data race, a failed Go package with no failing test of exactly its own, a stop-on-first-failure flag (Go `-failfast` in any true spelling, Playwright `-x` or a nonzero `--max-failures`), or a `go-json` or `playwright-json` gate that is not one direct test run: a single command with no `;`, `&&`, `||` or pipe. Held names are listed with the reason, and the verifier is told the run cannot publish PASS and to name the reason so an operator can resolve it. A Playwright `maxFailures` in its config file, or a `-failfast` in `go env GOFLAGS`, cannot be seen and is the fork's to avoid. Before turning this on for a fork whose formatted gate is a compound command, split the gate: such a gate counted as green on main when all its failures were baseline, and now stays red. That last rule is how later checks keep running. A compound command such as `make check` stops at its first red step, so accepting its red would skip the steps after it. List each step as its own gate instead, for example `make vet;go test -race -json ./...;make staticcheck;make e2e;make build` with a `go-json` format and a `go test -race -json -run {{TESTS}} ./...` baseline on the test gate. A `junit-xml` gate is a wrapper script the dispatcher cannot read and is trusted to be one test run. A base re-run that cannot complete excuses nothing, as before. Matching is by name only. Added after pyrycode #3382 on 2026-10-15: four macOS gate repairs that also failed on unchanged main, #3393, #3399, #3418 and #3415, were each added as its blocker in turn though none was its change.

**Main merged again right before the gates.** The setup merge of main happens minutes before the gates run, because the spawn preparation (code index refresh, docs index) sits in between and the poll loop keeps merging finished tickets meanwhile. So for the gated agents only, the dispatcher updates main and, when main moved since setup, merges it into the worktree again just before the first gate, and pushes the merge at once. In the parallel review this happens before the source review starts too. The verifier's prompt gets a `## Base branch` note naming the merged main commit and saying that main moving during the review is not a finding. A conflict on this second merge is aborted and the gates judge the setup merge as before. Added after desktop #1731, #1779, #1818 and #1825 each lost a builder round on 2026-10-06 and 2026-10-07 to a FAIL whose only finding was that `origin/main` was not an ancestor of the reviewed head; on #1825 the setup merge and the auto-merge of another ticket were four seconds apart.

**A stale base FAIL costs no builder round.** When the newest FAIL verdict's only `[MUST FIX]` findings say the branch lacks current main (located at the ticket branch, `feature/<n>`, rather than a source file), the rework router does not send the ticket to the builder. The dispatcher merges `origin/main` into the pushed branch itself, in a detached worktree of its own, and pushes the merge. The ticket keeps its column, the trigger label is stripped, the rework count is unchanged, and the verifier reviews again; the stale base findings are answered in the rework answers file so the re-review knows why they are fixed. A branch that already contains main is settled the same way without a merge. When main conflicts with the branch, the ticket goes to the builder as a merge handoff, which counts nothing. A merge that cannot be tried (a fetch or push failure, or a local branch with commits origin lacks) routes the FAIL as an ordinary rework. Each attempt posts a comment with a hidden marker, and after 3 attempts on one ticket a stale base FAIL routes as an ordinary rework, under the hard cap.

In the classic set this feature is entirely inert (locked by test): no gate runs, no env is read.

**Gate report for the documentation agent.** The documentation agent's prompt gets a `## Gate report` section built from the dispatcher's own logs. It lists the ticket's recorded verifier gate pass, with its time, commit and each gate's line. It gives the executed, passed, failed and skipped counts of every verifier gate with a format in `PYRY_VERIFIER_GATE_FORMATS`, and of the newest real-claude gate output, read with `PYRY_REAL_CLAUDE_GATE_FORMAT`. For each test the issue body or the plan names, it gives the result in each of those runs: passed, failed, skipped or not run. A test counts as named when its method, the part after `#`, the last ` › ` segment or the last Go name segment, appears there as a whole word. A `Class#method` or Go `TestName` the text mentions is listed even when no log has it. A run whose log is missing or unreadable, or that has no format, is listed with no per-test counts, never as passed. With nothing to report the section says so in one line. No other agent gets it. Added after 11 of 15 pyrycode-mobile documentation send-backs in the week to 2026-10-05 asked for evidence the agent could not see (#136).

The newest real-claude gate run is also reported test by test: every test with its status (passed, failed, flaky or skipped with its reason), attempts and duration where the format reports them, and its `daemon-revision` annotations on Playwright. A header gives the tested branch head and main commit and how the run ended, read from a run record the dispatcher keeps beside each live gate output as `<stamp>_real-claude-gate_#<N>.meta.log`, and the daemon revision: the distinct `daemon-revision` annotation values and `PYRY_BIN` for Playwright, and for the Go suite, which builds the daemon from the tested tree, the tested commits. A failure that passed on the dispatcher's same-tree re-run says so. A suite of over 150 tests, such as the Go live suite, lists only its failures, flakes, skips and the tests the issue, the plan or the verifier's last verdict names, and counts the rest. Tests named in the verifier's last verdict, whose documentation handoff often names them, count as named in the section above too. Added after the desktop documentation agent parked five tickets overnight on 2026-10-06 (#1658, #1729, #1731, #1817, #1818) asking for named live results and the daemon revision, which an operator then posted from the gate log by hand.

**Parallel source review.** With `PYRY_VERIFIER_PARALLEL_REVIEW=1`, a Claude or Codex
verifier starts its complete source review while the configured gates run. This
preliminary phase uses an empty temporary working directory and ignores user
configuration. Codex has read-only local shell access with no approvals, network,
plugins, apps or browser access. Agent delegation is prohibited. It reads the ticket's worktree by
absolute path. It cannot publish reviews, mutate labels or run builds and devices.
Standard Codex authentication still comes from `CODEX_HOME`.

Claude runs the CLI directly with restricted and safe modes. Its only source
tools are Read, Glob and Grep. StructuredOutput returns the report. Shell, write,
network, MCP, Chrome and delegation tools are absent. Only the source worktree
is added as a readable directory. The dispatcher supplies the complete merge-base
diff and the review criteria. OAuth and normal Claude authentication remain
available. The installed Claude CLI must support these flags; an unsupported
CLI fails the review rather than falling back to an unrestricted process.

Both runners get the same brief. It defines the review as done when every changed
section has been judged with enough surrounding code, and treats a file it could
not read completely as a remaining check for the final verifier rather than a
reason to stop. The criteria come from `verifier/review-criteria.md` in the agents
repo when the fork provides one. Otherwise the whole verifier role file is
appended, which also carries triage and publishing duties this phase cannot
perform.

After both phases settle, a normal verifier receives the complete source findings
and green or red gate evidence. It validates findings, finishes deferred Figma and
live-evidence checks, performs any red-gate triage, then publishes the verdict.

**Verdict handoff.** A run that rules on a PR, an agent marked `requiresVerdict`,
is told a handoff file in its prompt. It writes its finished verdict there before
posting: a header with `decision: PASS` or `FAIL`, `commit:` with the full SHA of the
PR head it reviewed, `labels:` with the labels the verdict adds, then a `---` line
and the comment body. The file lives in `<home>/.codex/publish/<repository>/verdict-handoff/`,
beside the GitHub body files both runners already write, or in `PYRY_VERDICT_HANDOFF_DIR`.
`<home>` is the home folder written into the repository's installed pipeline helper,
`<home>/.codex/bin/<repository>-pipeline-action`, because the helper accepts body files
only under that home. The dispatcher looks for the helper in its own home first, then
in every folder under `/Users`, and uses its own home when there is none. It never lists
`/home`: on macOS that is an autofs mount that does not answer, and listing it froze the
dispatcher at its first verifier on 2026-10-06. In
the pyrycode-agents container the dispatcher runs as `/home/agent`, but the helpers were
installed on the Mac with `/Users/juhanailmoniemi`. Until 2026-10-05 the handoff went
under `/home/agent`, and on pyrycode-desktop #1721 the helper refused to post the
verifier's verdict from there.
The dispatcher empties it before each run. When the run then fails or blocks because a
GitHub write failed, nothing was posted on the PR since the run began, the file is
complete and the PR head still equals the reviewed commit, the dispatcher posts the
body, applies the labels and finishes the run as a success. A FAIL routes back to the
builder as a normal rework. If GitHub still refuses the write, the ticket gets
`pending-verdict:<agent>`, which stops a re-dispatch, and each cycle tries again;
a write GitHub reported as failed but stored is recognised by a hidden marker line
and never posted twice. A moved head, a missing or incomplete file, a closed PR, an
approval rejection or a block about anything else parks as before. Mobile #1677
spent nine hours parked on a GitHub outage of minutes before this.

**Re-review after FAIL.** After a verdict run that ends with a complete handoff
file, or a saved verdict the dispatcher posts itself, the dispatcher keeps the
verdict in its logs folder as `verdict-last-<agent>-<issue>.json`. An incomplete or
missing file leaves the previous one in place. When the stage set's verifier is
dispatched again, the last verdict is a FAIL and its reviewed commit is an ancestor
of `origin/feature/<issue>`, the prompt gets a `## Re-review after FAIL` section. It
holds the previous verdict, fenced as data, the reviewed commit, the branch head and
`git log -p --no-merges` between them, so merges from main add nothing. The
verifier checks each prior finding, reviews the new commits, and reviews the rest of
the diff only when the change is broad. Over 60000 characters of patch, the section
gives the per-commit file stat instead and says a full review applies. A PASS, a
reviewed commit that is not an ancestor, as after a force-push, a missing file or a
git error gives no section and a full review. With parallel review on, the source
reviewer gets the same section and the same narrowed brief.

**The builder answers each finding.** When the PR-opening agent is dispatched on a
reworked ticket and the verdict agent's last verdict is a FAIL on an ancestor of
`origin/feature/<issue>`, its prompt gets a `## Verifier findings to answer`
section. It lists the verdict's `[MUST FIX]` and `[SHOULD FIX]` findings as a
numbered list, or the whole verdict when it has no tagged findings, and names an
answers file, `rework-answers-<issue>-<commit>.md` beside the verdict handoff. The
dispatcher empties that file first. The builder writes one line per finding,
`<n>. Fixed in <sha>: ...` or `<n>. Not fixed: <reason>`, and repeats the list in
its final summary. The next re-review section shows those answers before the
previous verdict, names any finding left unanswered, and tells the verifier to read
them first and check each claim. Mobile #1747 on 2026-10-05 got the same finding
twice with no word from the builder on it.

The two model phases share the verifier's wall-clock budget, but gate time is not
charged to it. The final verifier gets the budget the source review left, and
never less than half of it, however long the gates took. Each gate stays bounded
by `PYRY_VERIFIER_GATE_TIMEOUT_MS`.
A failed or blocked preliminary review parks the dispatch as an error; an
existing PR cannot salvage it into a pass. Both model phases share the original
verifier wall-clock budget. Claude also shares its turn limit across both phases.
Parallel review does not grant the single-phase automatic continuation budget.
Their usage is combined. Source-review output has
its own `.source.log`; the main log records the report and final input.

**When a verifier runs out of time.** A verifier run that ends because its wall
clock or its turn limit ran out, after any continuation leg, parks under
`error:verifier` with one comment that says what happened, in place of the
generic agent error. It names the part that ran out and the budget it had: the
review, or with review overlap the source review or the final review. It gives
how long the gates took, which is never charged to the review, and whether a
green run of every gate is recorded for the next run to reuse, and until when.
It carries the finished source review's report, cut at 20000 characters. Discord
gets one line. The ticket still parks, because a review that ran out of its own
time usually runs out again on a re-run. Added after mobile #1619 lost two
verifier runs on 2026-10-03 to gates that took the whole hour. Each time a person
read the logs to learn the gates were green and reusable, then cleared the label.

The verifier serial switch still covers the entire dispatch, so this option does
not overlap two emulator suites. A separate concurrency cap of two permits a
builder or refiner beside the verifier. Other consumers remain sequential unless
they explicitly enable this option.

**Real-claude gate under stage sets.** The gate's trigger and rework labels derive from the active set: it fires on the set's final pre-documentation review signal (`done:code-review` in classic, `done:verifier` in builder) and routes genuine failures back with the set's own rework label (`needs-rework:developer` / `needs-rework:builder`). A `needs-real-claude` ticket on the builder fork therefore parks and executes through the gate exactly as it does under classic.

### Real-claude gate

`PYRY_REAL_CLAUDE_GATE_ENABLED=0` retires this consumer's label gate as well as
execution: labelled reviewed tickets follow normal advancement, no ticket parks
for a live gate, and no live runner or live-only health check starts even if a
stale command remains configured. Only explicit `0` opts out; the default
retains the existing guard. Clearing `PYRY_REAL_CLAUDE_GATE_CMD` alone still parks
labelled tickets for an operator. Desktop enforces retirement in its startup
preload because its normal application suite now runs captured client replay.
Other consumers keep this gate. Existing running markers, errors, rework and
native blockers remain safety holds; retirement does not clear them or assert
that explicit live acceptance has passed. Reassess parked tickets through the
orchestrator with their acceptance criteria preserved.

Some tickets can only be accepted by running against real claude rather than the pipeline's fakes. The PO marks them `needs-real-claude` during refinement. After code review such a ticket is parked in Inbox, and if this fork sets `PYRY_REAL_CLAUDE_GATE_CMD` the dispatcher then runs the suite itself, once per cycle, before it picks any other ticket.

**Running alone, or in the background.** By default the gate runs alone: once a ticket is waiting, nothing new is dispatched until every agent run has finished, and the loop then waits for the suite. On mobile that cost up to 81 minutes of drain before one gate and about nine minutes of a stalled board during each. With `PYRY_REAL_CLAUDE_GATE_BACKGROUND=1` the gate waits only for running verifiers and the main sweep, then runs beside the loop. While it waits or runs, new verifiers and the main sweep are held back, because their device runs share the emulator and would hit their own time limits queued behind the suite. Everything else keeps dispatching, merging and advancing. With `PYRY_REAL_CLAUDE_GATE_HOLD_VERIFIERS=0` verifiers are not held either: the gate no longer waits out a verifier's whole run, most of which is review with the emulator idle, and the two queue on the device hold only for their emulator work. Turn it on only where the suite tolerates other work on the host. Mobile can, because its test script holds the emulator host-wide, so a builder's device run queues instead of colliding.

While that suite is running, the ticket carries `wip:real-claude-gate`. The dispatcher removes it when the run finishes, whether the result passes, fails, or needs human attention. A ticket with any `wip:` label is not selected for another gate run. The existing stranded-running-label sweep clears a marker left by an interrupted process after its safety delay.

**What it does per run.** Fetches, resolves the branch from `origin` only, records how many commits behind the base branch it is, probes for conflicts with `git merge-tree --write-tree`, creates a **detached** worktree at the head commit, merges the base branch into it, runs the command, then judges by reading the output file back off disk. The worktree is removed either way. Both log files end in `.log`, so the existing rotation sweeps them.

**When the branch conflicts with the base.** The gate merges with the same diff3 markers as the dispatcher's other merges. A conflict where both sides only added imports is settled in the gate's own worktree by the import-only resolver, and the suite runs on the result. That resolution is never pushed: the next stage's own merge settles the same conflict the same way, and the evidence comment names the files. Any other conflict goes to the ticket's code owner exactly as a conflicting final merge does. The ticket moves to the owner's column, In Development, with `merge-handoff` and `needs-rework:<owner>`. The rework router then clears the trail and counts no rework. `needs-real-claude` stays on, so after the owner settles the merge and the review stages pass, the gate runs again. Gate and final-merge handoffs share one budget of `FINAL_MERGE_HANDOFF_MAX` routes, two, counted by the same hidden comment marker. A conflict after that parks as before. Before 2026-10-04 every conflict parked: mobile #1337 twice on 2026-10-01, and #1631 on 2026-10-04 over two changes that each added one argument to the same call. Each waited hours for a person to merge main.

**Outcomes.**

| Verdict | Board | Labels | Discord |
|---|---|---|---|
| pass | → In Documentation | removes `needs-real-claude` | no |
| flaky: every failure passed on a same-tree re-run | → In Documentation | removes `needs-real-claude` | yes, naming the flaky tests |
| fail | → In Development | adds the set's fail rework label (`needs-rework:developer` classic, `needs-rework:builder` builder), **keeps** `needs-real-claude` | no |
| failures the branch inherited, each tracked, required tests green | → In Documentation, no blocker | removes `needs-real-claude` | yes, naming the tracking tickets |
| failures the branch inherited, anything else | stays in Inbox behind separate fix tickets | **keeps** `needs-real-claude`, no rework label or counter change | yes, naming the fix tickets |
| branch conflicts with the base, imports only | settled in the gate's worktree, then judged like any other run | as for that run's verdict | as for that run's verdict |
| branch conflicts with the base, anything else | → In Development, for the code owner to finish the merge | adds `merge-handoff` and the owner's `needs-rework:<owner>`, **keeps** `needs-real-claude`, no rework counted | yes |
| branch conflicts again after two merge handoffs | stays in Inbox | adds `error:real-claude-gate` | yes |
| nothing executed | stays in Inbox | adds `error:real-claude-gate` | yes |
| no usable result | stays in Inbox | adds `error:real-claude-gate` | yes |
| failed in an infrastructure shape | stays in Inbox, no re-run or base comparison, live gate paused | adds `error:infra`, **keeps** `needs-real-claude`, no rework counted | yes, naming the pause |

**Infrastructure-shaped failures.** On 2026-10-13 pyrycode-mobile #2138's live gate on HP ran 65 tests: one passed and 64 failed, nearly all on phone reconnection, daemon-unavailable and readiness waits. The same suite had passed 65 of 65 on that branch four hours earlier. The production relay was refusing HP's public address, with 42 connection-cap and 35 rate-limit rejections in four minutes. The dispatcher still started a full same-tree re-run, which met the same refusals, and only a person stopped it. So after the first pass, before any re-run, the gate classifies each failing test by its failure text: a connection, readiness, daemon or admission failure; a bare timeout; or anything else. The text comes from the report and, for Android, from Gradle's console in the diagnostic log, because the JUnit report carries empty failure elements. A run is infrastructure-shaped only when it is a mass failure, at least `PYRY_INFRA_BREAKER_MIN_FAILED` tests and `PYRY_INFRA_BREAKER_MIN_FAILED_SHARE` of those executed, and the failures themselves are connection-shaped: connection failures plus bare timeouts make up `PYRY_INFRA_BREAKER_WAIT_SHARE` of them. Bare timeouts alone never trip it, since an app hung by a regression times out too. Then one of two rules decides. With at least one connection failure and `PYRY_INFRA_BREAKER_MIN_SIGNATURES` admission rejection lines in the output (the relay answers 429 or 503 at the WebSocket upgrade), it is decided on the spot. With that many failing tests naming a connection failure, it is only provisional, because a branch that breaks daemon startup or the relay client fails in the same shape (pyrycode's `realclaude: daemon not ready`, mobile's `relay=Offline`). The gate then re-runs `PYRY_INFRA_BASE_CHECK_TESTS` of those tests on the base commit, bounded by `PYRY_INFRA_BASE_CHECK_TIMEOUT_MS`, and blames the environment only when every one fails there with a connection or timeout failure. A test that passes on the base, or a base check that cannot run, sends the run down the normal re-run and base comparison path. Such a run skips the re-run and the base comparison, halts the ticket in Inbox with `error:infra`, posts an evidence comment that attributes nothing to the branch, and alerts. No rework label is added, so the rework count does not move. The dispatcher then starts no live gate run until `PYRY_INFRA_COOLDOWN_MS` has passed, recorded in `PYRY_INFRA_PAUSE_FILE` so the pause survives a restart; delete the file to end it early. A toolchain the host lacks, such as `go: go.mod requires go >= 1.26.9 (running go 1.26.2; GOTOOLCHAIN=local)`, halts the same way from a single line, with no mass failure needed, but never pauses the gate, since it is fixed on the host rather than waited out. When the branch itself changes the requirement (`go.mod`, `.nvmrc`, `engines` or `packageManager` in `package.json`, and similar), the mismatch is the branch's: it goes to rework, not `error:infra`. The same toolchain check runs on the verifier's pre-spawn gates (`PYRY_VERIFIER_GATES`): a red gate with a toolchain mismatch is not re-run or compared with main, the verifier is not started, and the ticket gets `error:infra`, a comment and an alert, with no rework. If the branch changed the toolchain requirement, the verifier triages it as an ordinary red gate instead. Each ticket that meets the same host mismatch halts separately, so one bad toolchain can halt several tickets before it is fixed. pyrycode-relay #167's verifier met exactly this on HP on 2026-10-13. `error:infra` blocks every stage until a person removes it. Against HP's mobile gate logs of 2026-10-10 to 2026-10-13, the classification (before the base check) trips on #2138, #2104, #2057 and #2009, and not on #1896, #1977 or #1869.

**The same-tree re-run, and why it comes first.** A base comparison tells a regression from an inherited failure. It cannot tell either from a flake, because a flake passes on the base too and so reads as a regression. On 2026-09-06 pyrycode #2089, a finished ticket with a fifth-pass review PASS, failed one liveness test its diff never reaches; the test had passed the previous nineteen gate runs and passed three of three by hand minutes later, but it passed on the base, so the gate routed the ticket to rework and the three-strike breaker tripped. So when a run fails with named tests, the gate first re-runs **only those tests** in the same merged worktree, using the baseline command template. For Playwright the re-run, and the base comparison after it, ask for the gate's own worker count. The verifier gates also fill idle workers with tests that passed in the gate from other spec files, so a failure caused by contention meets the same contention again; those tests decide nothing, and each failing test still runs once. The live gate adds no such tests, since each would be a real claude session. A test that passes there is set aside as flaky and never reaches the base; only tests that fail again are compared. When every failure was flaky the verdict is flaky-pass: the ticket advances exactly as on a pass, the flaky tests are named in the evidence comment, and Discord is pinged so the suite gets looked at. Only a test seen passing is excused; a name the re-run skipped or never reported stays failing, and a re-run that executes nothing proves nothing. Hangs the test binary's own `-timeout` killed are not re-tried, since a hang costs the whole timeout again; the panic names them, so they are counted as failures and compared against the base like any other.

**A flaky test gets a ticket on its second sighting.** Letting a flake through is right for the ticket and leaves the suite's problem untracked: nobody is blamed, so nobody files anything. On pyrycode-mobile, 2026-09-24, a second-client bug behind several flakes went a whole day with no ticket that way. Filing on every first flake went too far the other way: on pyrycode-desktop it filed 26 tickets in ten days, mostly contention flakes that never came back. So since 2026-10-15 every flake is recorded as a sighting in the claim service, shared across computers, and a `flaky-test` ticket in Backlog, labelled `bug` and `priority:low`, is filed only when the same test flakes a second time inside 14 days, on any computer. The first sighting is named on the evidence comment instead. A run with more than three failing tests, or with a failure that failed again, files at most one ticket naming its flaky tests, and none when that failure is the branch's own or already has the run's shared live failure ticket. A ticket for the test that closed in the last 30 days is reopened into Backlog instead of filed again. A hidden marker line in the body, `<!-- flaky-test: <full test name> -->`, lets later runs find the ticket, and each later flake adds a comment instead of filing again, so the comments count the occurrences. To route an existing hand-filed ticket's flakes to it, add the label and the marker line to its body. The whole rule, including the fallback when the claim service predates it, is in [docs/flaky-tests.md](docs/flaky-tests.md).

**Shared live failures get fix tickets before the original waits.** The dispatcher searches open bug tickets by an exact hidden marker, the quoted full test name or the existing verifier tracking-title convention, excluding the gated ticket from blocker candidates. A new fix ticket includes the branch and baseline revisions and report paths. It is added to the top of Backlog with `bug` and `priority:low`, so it leads other low-priority Backlog work while higher-priority eligible tickets still go first. An existing ticket keeps its active status; an unplaced, Inbox or reopened Done ticket enters Backlog. Existing Backlog fixes are moved to the top as well, while fixes already in development or later keep their position. The dispatcher confirms both dependency endpoints are open issues and reads the link back. A failure to search, place or confirm the dependency parks the original with a gate error for recovery and consumes no retry. Existing issues are reused after partial board writes. A fix ticket naming the test on its marker line that closed in the last 30 days is reopened at the top of Backlog and becomes the blocker, instead of a new ticket being filed; if the reopen fails, a new one is filed as before.

The original keeps its review and live-test requirement in Inbox. No builder rework label is added, so the ticket-wide retry limit cannot stop this wait. Fresh blockers are checked before another expensive run. Once the fixes close, it re-runs against current main and advances only on a passing live result. Mixed failures still send the original to its builder for the branch regressions while shared failures get separate tracking. A fix ticket that owns the failing test stays responsible for its own repair instead of spawning another copy of itself. The existing intermittent-failure route remains separate and unchanged.

**Advancing past a tracked inherited failure.** On 2026-10-14 pyrycode-desktop #1809 ran 27 live tests: 26 passed, and the one that failed also failed on main and was already tracked on #1947. The gate parked the ticket behind #1947 and a person moved it on by hand, as for every ticket whose run touched that test. So the gate now advances such a ticket to In Documentation, as on a pass, when all of this holds. Every failing test either passed on the same-tree re-run, a flake excused as on a flaky pass, or failed again there and fails on the base commit, matched by exact name. No suite-level failure is left unexplained: a Go package failure counts only when one of that package's own tests failed, and any other format's suite-level failure parks. A Go panic or data race parks too, because the tests after a panic never ran on either tree, so a regression there would be invisible. No required live test, from `PYRY_REAL_CLAUDE_GATE_ALWAYS_TESTS`, the pull request or a `requireWhenReported` evidence rule, is among the failures, and every one passed with its configured evidence, so a skipped or evidence-less required test parks as before. Each inherited test has an open tracking ticket that names it exactly: the hidden marker, the full test name quoted in the body, or the full name in the title. One that does not exist is filed the usual way, with the marker, at the top of Backlog. No blocker is added, so the ticket does not wait for the fix. The executed floor, the infrastructure classification and skips-are-not-passes all apply first, unchanged. Anything short of all this parks exactly as before, and the evidence comment says which condition failed. A tracker found only by the method name in its title is treated as a gap rather than filed again, so the ticket parks behind it and the comment asks for the marker. On an advance the evidence comment lists each accepted failure with its tracker, plus a hidden `real-claude-gate-accepted-inherited` marker per test, and the run record beside the gate output gains `acceptedInherited`, which the documentation stage's gate report shows instead of a bare red test. A gated ticket whose own body names an inherited test parks too, since it may be that test's fix. Matching is by name only: a branch that breaks an already-red test in a new way advances, and the tracker's own gate run meets the new break. `PYRY_REAL_CLAUDE_GATE_INHERITED_ADVANCE=0` turns it off for a fork.

**The base comparison, and why it exists.** On the gate's first live run, 2026-08-07, a ticket came back with 519 passed and 2 failed. Both failures reproduced identically on clean `main` and neither touched the ticket's subject. The comparison records whether the ticket introduced a failure so rework does not misattribute it. A confirmed inherited failure creates or reuses a separate fix ticket and blocks the original at its live gate. An inherited failure already owned by the gated fix ticket remains that ticket's ordinary rework. Missing baseline evidence still routes to rework. A failure to establish the fix-ticket dependency parks with `error:real-claude-gate` for recovery.

So when a run fails with named tests, the gate re-runs **only those tests** against the base commit alone, unmerged, in a second detached worktree. Tests red on both sides are reported as inherited in the evidence and Discord warning. Branch regressions go to rework. Confirmed inherited failures wait on separate fixes. Set it up as:

```sh
PYRY_REAL_CLAUDE_GATE_BASELINE_CMD='go test -tags e2e_realclaude -timeout 20m -json -run {{TESTS}} ./internal/e2e/realclaude/...'
```

Do not quote `{{TESTS}}` yourself; the substituted filter brings its own quoting. Two refusals are deliberate. A name containing anything outside a conservative character set refuses the whole filter rather than dropping that name, because a partial filter compares different test sets on the two sides. And a base run that executes nothing, the same false green the gate exists to reject, is discarded rather than treated as exoneration. In both cases `baselineFailures` stays null and the failures remain the branch's, since **a missing baseline is not an exoneration**.

A failure keeps `needs-real-claude` so the ticket must pass the gate again after the fix; `runReworkRouting` strips the stale `done:*` trail and brings its three-strike breaker along. Failures reproduced on main are linked to separate fix tickets before the original waits at its gate. Waiting preserves the retry count even when it is already at the limit. Once every blocker closes, the live runner fetches current main, merges it into its test worktree, and tests again. An environment failure or unusable report parks instead of routing to the developer agent, which could not fix a missing credential and would burn three spawns discovering that. The `error:` prefix excludes a parked ticket from the WIP count and from gate re-selection.

**Per-ticket selection.** Off by default; `PYRY_REAL_CLAUDE_GATE_SELECT=1` turns it on. The gate then runs the live tests the ticket's open pull request lists under a `## Live tests` heading, one qualified name per line, plus the fork's always-run set. The selected command is the baseline template with that list in place of `{{TESTS}}`, and the run must execute every test it named, so a misspelt name cannot pass by running nothing. Mobile's whole live suite took about eight and a half minutes per ticket, most of it on flows the ticket never touched.

Every doubt resolves to the whole suite: the branch changes a `PYRY_REAL_CLAUDE_GATE_FULL_PATHS` prefix, its changed files cannot be listed, the pull request has no list or asks for `all`, or a name cannot go into a safe filter. A backstop covers the tickets that break a flow they did not name: once `PYRY_REAL_CLAUDE_GATE_FULL_EVERY` merges have landed on the base since the last clean full run, or none is on record, the next gated ticket runs the whole suite. Only a clean full run resets the count, so while main is red every gated ticket keeps running the whole suite. The evidence comment says which kind of run it was and why.

**Required named tests.** Every name the pull request lists under `## Live tests` and every name in the always-run set, `PYRY_REAL_CLAUDE_GATE_ALWAYS_TESTS`, must execute and pass, in a full run as well as a selected one. A skipped or absent named test leaves the run unusable, whatever the suite totals say; a named failure routes to repair. Each line of the section must be a test name: a backticked title (commas and colons are kept), a single word such as `pkg.TestName` or `a.b.Class#method`, or a Playwright title joined with ` › `. `all` or `none`, or an empty section, names no required test. The section ends at the next heading, a `---` line or a generated footer. A line of prose makes the whole section invalid: it names nothing, the gate runs the full suite, and the verifier's pre-spawn checks report it as a red gate with the offending lines, so the builder fixes the pull request body instead of the run parking on a requirement nobody meant. If the pull request cannot be read, the gate runs the full suite with only the fork's required names.

**Live evidence per named test.** A fork can require more than a pass for some live tests: put a `live-test-evidence.json` at the root of its agents repo, beside the role folders. Each rule names a test-name `pattern` (a case-insensitive regex) and what the final, actually passing attempt must carry: inline `attachments` by name, a `daemon-revision` attachment that agrees with the attempt's annotation (`sameAttemptDaemonRevision`), and checks on a JSON attachment's fields (`nonEmpty`, `equals`, `notEquals`, `includes`, `listContains`). `requireWhenReported` makes any reported test that matches required even when the pull request does not list it. A matching test that fails still routes to repair, but a failure-only re-run cannot supply its evidence. The format and an example are in `src/gate-test-evidence.ts`. No file means no extra checks; an invalid file turns the live gate off with an error rather than judging without the rules. Desktop uses it for the GPT-6 Luna channel scenario.

**The command must emit a per-test report.** For Go that means:

```sh
PYRY_REAL_CLAUDE_GATE_CMD='go test -tags e2e_realclaude -timeout 20m -json ./internal/e2e/realclaude/...'
PYRY_REAL_CLAUDE_GATE_MIN_EXECUTED=150
```

Android consumers can emit JUnit XML with `PYRY_REAL_CLAUDE_GATE_FORMAT=junit-xml`. The command must write only XML to stdout and send build logs to stderr. Both `<testsuite>` and `<testsuites>` roots are accepted. The reader counts named test cases, excludes skips, preserves failures across duplicate reports, and rejects malformed reports or missing cases advertised by the suite. Mobile's wrapper additionally requires freshly generated device reports and forces the test task to execute.

For `junit-xml` the `{{TESTS}}` filter is not a regex. It is a single-quoted, comma-separated `pkg.Class#method` list, the shape Android's instrumentation `class` argument takes, so the baseline command must hand it to a runner that selects tests by that list. A name that is not a plain class and method, such as a parameterised `method[0]`, refuses the whole filter.

For `playwright-json` the filter is a single-quoted regex for Playwright's `-g`, such as `npx playwright test --reporter=json -g {{TESTS}}`. The reader names a test by its file, describe titles and test title joined with ` › `. Playwright matches `-g` against the same path joined by spaces, with the project name and tags in between, so each part is escaped and the parts are joined with `.*`. Matching more than the named tests only re-runs extra tests, since results are compared by full name. A name holding a single quote or a control character, such as a newline, refuses the whole filter. Before 2026-10-05 the Go rule refused every Playwright name, because of the space and the `›`, so pyrycode-desktop's live gate never re-ran or compared a failure (agent-dispatcher#132).

The baseline command currently uses Go test filters. Leave it unset for JUnit consumers until their command supports that filtering contract. Without it, failed tests route to rework without automatic retry or base comparison.

A bare `make e2e-realclaude` target will **not** work. Without `-json` it prints nothing per-test on success, only a package summary, so executed tests cannot be counted — and the executed-test count is the whole guard. This is a contract, not a detail.

**Why the count, and not the exit code.** On 2026-07-22 a real-claude suite skipped every test, exited 0, and the code-review agent read that 0 as a pass; an unverified change shipped (pyrycode PR #1169 / #1168). A skip and a pass are indistinguishable to an exit code. So `decideGateVerdict` consults the exit status last and only to make a verdict worse: a zero exit can never turn a non-pass into a pass. Counting is also leaf-only — a parent test whose subtests all skipped reports `pass` for itself, and counting it would reopen the same hole one level up.

**Billing.** The spawn environment keeps `CLAUDE_CODE_OAUTH_TOKEN` and leaves `ANTHROPIC_API_KEY` unset, so runs bill against the subscription. Tests that need a metered key skip; the executed floor should be set with those skips already accounted for.

**Codex test login.** `PYRY_CODEX_CAPTURE_BIN` and `PYRY_CODEX_CAPTURE_HOME` reach only the live gate: its own run, its same-tree rerun, its base-commit checks and its health checks. The pre-verifier gates, their baselines and the main sweep run without them, so an ordinary `make check` never starts live Codex. A fork's `.env` keeps both variables for the live gate. On 2026-10-15 the Mac's verifier `make check` ran Core's untagged `TestCaptureLive` with them, spent Codex allowance and rewrote six `testdata/capture` fixtures (pyrycode #3385 and #3389).

**Fixtures a gate rewrites.** The pre-verifier gate step compares the worktree's `testdata/` files before and after the gates. A file the gates changed is put back when it was clean before (a tracked file returns to HEAD, a new one is removed), and every changed path stays out of the run's safety-net commit and partial-work salvage. The ticket gets a `Gate rewrote test fixtures` comment and the dispatch log a `GATE FIXTURES` section. A test that writes its fixtures on an ordinary run is a defect in that test.

## Layout

```
src/
├── dispatch-bin.ts         # Entry point — argv + env validation, calls dispatch.ts
├── dispatch.ts             # Library — pollLoop, dispatchInbox, dispatchToAgent
├── lib.ts                  # Barrel re-export from the split modules
├── pipeline-decisions.ts   # Pure: label/column state machine
├── blockers.ts             # Pure: blocker / dependency rules
├── dispatch-selection.ts   # Pure: which item to dispatch next
├── worktree.ts             # Pure: worktree + branch + path resolution
├── agent-runtime.ts        # Pure: agent config, max_turns, env scrubbing
├── reconcile.ts            # Auto-advance + rework routing reconcilers
├── github.ts               # GitHub Project (v2) GraphQL client
├── types.ts                # AGENTS const, AgentConfig, ProjectItem
├── lib.test.ts             # ~232 pure-logic tests
├── dispatch.test.ts        # ~70 phase-function integration tests (DI-mocked)
└── reconcile.test.ts       # ~5 reconciler tests
codex-helpers/               # GitHub publishing helpers Codex's rules approve; see its README
```

307 tests; runs under Node 25 with TypeScript 6 + tsx.

## Status

Pre-1.0. Default branch + salvage gates are now config-driven via env vars (`TARGET_DEFAULT_BRANCH`, `SALVAGE_GATES`). The 5-agent pipeline (PO / architect / developer / code-review / documentation) is still hardcoded — making it overridable via an `agents-config.json` in each consumer's agents repo is the next planned change, deferred until a consumer with a different pipeline shape actually shows up (per "evidence-based fix selection" — don't build for hypothetical needs).

## License

Apache-2.0.

## Shared project knowledge

Set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in a consumer's launch environment to
use repository documentation instead of Claude's local memory. This disables
Claude auto memory and makes dispatcher memory maintenance a no-op without
reading the memory directory. The returned lesson floor is zero, so the
auto-curation watermark cannot fire. Leave the flag unset for consumers that
still use the existing memory workflow. The flag survives the child environment
scrub. Configure interactive Claude sessions with `autoMemoryEnabled: false`
in their project settings too.

Role prompts should route new lessons through ticket comments and pull-request
notes into the existing documentation stage. Do not move the private memory
directory into the repository or inject the entire archive into each run.

## Selectable agent runner

Claude remains the default, including the existing `pyry agent-run` wrapper and
`PYRY_USE_LEGACY_CLAUDE` rollback. Set the following in the consumer agents repo's
`.env` to select Codex for all pipeline stages:

```dotenv
PYRY_AGENT_RUNNER=codex
```

Unset it or set `claude` to return to Claude. Unknown values fail startup before
board processing.

### Runner file: switch without a restart

For managed dispatch, the central operator can select one runner for the entire
fleet. See [Central fleet runner](docs/machine-manager.md#central-fleet-runner).
That choice overrides the local file and its role entries. When the central
choice is unset, the local rules below continue to apply.

A restart drains first, and a drain can wait most of an hour for running agents.
So the runner can also come from a JSON file that the dispatcher reads again
before every agent spawn:

```json
{"runner": "codex", "roles": {"verifier": "claude"}}
```

- **Keys:** both are optional. A role entry beats `runner`, and `runner` beats
  `PYRY_AGENT_RUNNER`, which stays the fallback when the file is absent.
- **No runner switch on rework:** a `rework` key, which briefly picked another
  runner for the builder's rework after a verifier FAIL, is now read and ignored,
  so an old file still loads. The builder keeps the runner and model in settings
  and that rework runs at a higher effort instead: see
  [Builder effort](#builder-effort).
- **Location:** `<agents repo>/runner.json` by default. `PYRY_RUNNER_FILE` points
  elsewhere, and an empty value turns the file off.
- **Startup:** a broken file fails startup, like a bad `PYRY_AGENT_RUNNER`. Codex
  is pinned at startup when any entry selects it, or at first use otherwise.
- **While running:** a file that turns broken keeps the last valid one in force
  and logs one warning per distinct error. Deleting the file returns to the
  fallback.
- **Resumed runs:** a resumed run keeps the runner its session started on.
- **Logs:** each spawn's DISPATCH block records the runner it used. The installed Codex CLI must support `exec --json`,
`--approve-for-me`, and `--output-schema`. The integration was verified with CLI
0.153.4. Authenticate Codex on the dispatcher host before starting the queue.
Claude authentication is not reused.

Codex uses `gpt-6.1-sol` by default and inherits the operator's configured effort.
Optional `PYRY_CODEX_MODEL` and `PYRY_CODEX_EFFORT` select Codex-specific overrides;
Claude stage model names and effort overrides are never passed to Codex.
The optional role-risk policy below selects effort for both runners instead.
The builder is the exception to both: see [Builder effort](#builder-effort).
At startup the dispatcher pins the Codex executable from PATH. On macOS it also
checks the ChatGPT app bundle when the terminal PATH does not expose its CLI.
`PYRY_CODEX_BIN` overrides discovery. An invalid override or missing executable
stops startup before ticket selection or labels are changed.
The same stage set, ticket prompts, worktrees, deterministic gates and post-run
checks apply. Product tests that exercise real Claude continue to exercise Claude.

### Builder effort

The builder runs at `high` effort, and at `xhigh` on its rework after a verifier
FAIL: the run that gets the FAIL's findings to answer. This holds for Claude and
Codex alike, and beats `PYRY_CODEX_EFFORT`, the role-risk policy below and any
effort set on the agent, which all still apply to the other roles. A rework for
any other reason, such as a PASS last verdict or a FAIL on a commit the branch no
longer has, stays at `high`. The DISPATCH log's effort reason says which case
applied and names any setting it overrode. `gpt-6.1-sol` accepts `xhigh`, checked
on Codex CLI 0.159.2 on 2026-10-05. Chosen on 2026-10-05 in place of switching the
rework to another runner, after the Codex builder on mobile #1786 could not fix
three real bugs the verifier found.

### Optional role and risk effort trial

Set `PYRY_EFFORT_POLICY=role-risk-v1` in one consumer's `.env` to opt its
four-role builder pipeline into task-dependent effort. It works with Claude and
Codex. Other consumers retain their settings. Model choices, turn limits,
timeouts and acceptance gates do not change. An explicit `PYRY_CODEX_EFFORT`
still overrides the trial for Codex. Leave that override unset to measure the policy.
The builder is outside the trial: see [Builder effort](#builder-effort).

| Role | Routine ticket | Elevated risk | No valid assessment |
| --- | --- | --- | --- |
| Refiner | medium | high | medium |
| Verifier | high | high | high |
| Documentation | low | medium | medium |

The consumer's refiner must add exactly one section to the issue body:

```markdown
## Effort assessment
Risk: routine
Reason: Explicit requirements and a local change with straightforward checks.
```

Use `Risk: elevated` for security, concurrency, persistence or migrations,
cross-component contracts, unclear behaviour and difficult bug investigations.
Choose from the actual work, not the line count or size label. An existing
`security-sensitive` label always overrides a routine assessment. Missing,
malformed or duplicate assessments are unknown. Code-fenced examples are ignored.
Assess split children separately before marking them refined. A ticket that skips
refinement keeps conservative effort until someone assesses it. No extra model
call, automatic ticket rewrite or label is needed to select effort.

The policy is chosen before each role starts. A running role's effort stays fixed,
including any continuation. A rework label alone does not raise effort: use the
failure evidence to update the assessment if the work proves harder than expected.
An environment problem still needs an environment fix.

Each DISPATCH log records runner, model, policy, selected effort and selection
reason alongside the existing token, duration and outcome records. Compare total
tokens across all attempts of completed tickets, plus rework and escaped defects.
Compare Claude and Codex separately with models held constant. This trial does not
claim a measured saving. Set `PYRY_EFFORT_POLICY=off` or remove it and restart to
restore previous effort selection. Unknown policy names or use with the classic
stage set fail startup before board processing.

The runner adds the role instructions to Codex's built-in instructions and loads
`CLAUDE.md` as a project-instruction fallback. Its task prompt travels on stdin.
`--approve-for-me` selects workspace-write sandboxing and automatic approval
review. It cannot be combined with `--sandbox`. No sandbox bypass or blanket
network access is enabled. Claude tool allowlists are not translated into Codex
permissions. Codex uses its own configured tools, sandbox and reviewer; role
instructions still restrict the scope of the task. Missing search tools fall back
to repository and command-line search. Claude credentials are stripped from the
Codex child environment in addition to the existing dispatcher-secret scrub.

Each Codex launch explicitly sets `AGENTS_REPO_PATH` in its shell environment
configuration when the dispatcher supplies that path. This keeps role checklists
readable when the user's shell policy inherits only core variables. The override
carries only this non-secret path and leaves the user's inheritance policy intact.
`PYRY_AGENT_SHELL_ENV` adds further named, non-secret settings the same way, for
example `ANDROID_HOME,JAVA_HOME` so Gradle commands find the SDK and JDK without
the agent spelling them out inline. Secret-looking names are refused.

A successful process must emit a completed turn and a valid final JSON outcome
with `status: completed`. A `blocked` outcome, missing outcome, failed turn,
nonzero exit or dispatcher timeout cannot advance a ticket. A blocked outcome
preserves its worktree for recovery and is never salvaged. This avoids deleting
edits after a required commit or external action is rejected.

Most blocked outcomes park the ticket at once, and the operator must inspect that
worktree before re-queueing it. One kind retries instead: a summary saying a
required tool, MCP server or environment variable was missing or unavailable.
Such a block takes the same transient auto-retry as a dropped connection, with
the same 5, 10, 20 and 40 minute backoff and the same four-retry cap, then parks
with `error:<agent>` as before. The match covers the observed summaries:
"Required Figma tools are unavailable in this session" on mobile #1646 and
"Required Figma tools `get_design_context` and `get_screenshot` are unavailable"
on #1668, both of which cleared on their own, and "ANDROID_HOME is missing from
the dispatcher environment" on #1631. Checked against all 23 distinct blocked
summaries in the Mobile, Desktop and pyrycode logs, it matched five: these three
and two of the same kind. It matched none of the eighteen that need a person. A summary naming an approval, a human,
a maintainer, a decision or a denied permission always parks, and so does any run
where the approval reviewer rejected an action. The retry never discards or
salvages the blocked run's work: when that run left uncommitted edits or unpushed
commits, the retry continues from them in the same worktree (see "Reusing the
agent's own preserved worktree" above).

A missing MCP server is retried sooner, inside the same dispatch, on either
runner. Two cases count. Codex refuses to start because a server marked
`required = true` failed to connect. Or the agent ends its output with the
fixed stop line `TOOL_UNAVAILABLE: <server or plugin name>`, which each agents
repo's `docs/working-practice.md` tells it to print when a tool it needs from
an MCP server or plugin is missing or will not connect. Under Codex the line
ends the blocked summary. Only the last non-blank line counts, and never on a
timed-out run or a permission denial. Either case gets up to 3 more tries, 15
seconds apart. If the stop line survives the last try, the ticket parks with
`error:<agent>` and a comment naming the server, with no backoff retry. Added
after 11 Pyrycode Mobile runs from 3 to 6 October 2026 started without the
Figma plugin's tools while Codex printed nothing, and each agent stopped as
blocked within a minute.

A block after Codex's approval reviewer failed to decide also retries, on the same
backoff and cap. Codex says so in its own output, on stderr or in a tool item:
"automatic approval review could not be completed. This is a review failure, not a
determination that the action is unsafe" when the reviewer's model was at capacity
(mobile #1582), or "The automatic permission approval review did not finish before
its deadline" (mobile #1655). The dispatcher matches only that Codex output, never
the agent's summary, which always mentions the approval. A genuine rejection, "This
action was rejected due to unacceptable risk", still parks, even beside a reviewer
failure.

"Codex output" means only the text Codex itself writes about a refused action: the
message on a `codex_core::tools::router` ERROR line on stderr, the output of a
`declined` command item, and the error or result text of a `failed` MCP call. Each
phrase must start a line of that text. A command's output never counts, whatever it
printed. Until 2026-10-05 every tool item was searched, so on pyrycode-desktop #1726
a verifier that grepped a dispatcher source file containing the sentence was parked
as rejected after a passing review. In codex-cli 0.159.2 a refused shell command's
item carries no text at all; the reason is only on stderr, as on mobile #1766.

This covers MCP tool calls too. Codex writes nothing on stderr when it refuses an
MCP call; the reason is in the `mcp_tool_call` item's `error.message`, which the
match reads like any other tool item, as on mobile #1783's `codegraph_context`
call. The run log keeps only a 300-character preview of each event, which cut
that reason off, so a failed MCP call now also gets its own log line with Codex's
error, or the tool's own error text, in full up to 4000 characters.

A Codex turn that fails with "Selected model is at capacity. Please try a different
model." takes the capped API retry, like "Unable to verify model access right
now". Five mobile tickets parked on it on 2026-10-05.

A builder may instead return `status: needs_refinement` for a planning problem.
The dispatcher posts its explanation on the assigned issue and adds
`needs-rework:refiner`. The existing rework router moves it back to refinement.
No implementation-complete label, automatic commit or push occurs. Its worktree
is retained. Other roles cannot use this outcome. A failed run or observed
approval rejection cannot use this route. Permission denials still require
operator review; the dispatcher does not retry the denied action.

A Codex builder may return `status: waiting_on_blocker` after linking an open
GitHub dependency. The dispatcher reads blockers afresh, posts the wait and
adds `needs-rework:builder`. The router treats a rework label that routes a
ticket back to the column it already sits in, while the ticket has an open
blocker, as a wait: it strips the usual state labels, leaves the ticket in
development, counts no rework and skips the loop breaker. Until 2026-10-07 that
route counted as a builder rework, so desktop #1738 and #1766 each gained a
rework count with no review failed. A missing or closed blocker, failed run, or
approval rejection still becomes an agent error.

Codex has no Claude-style max-turn budget. The existing per-stage wall-clock
budget applies, with process-group termination and a two-second forced-stop grace
period. A timed-out Codex run gets the same continuation legs as Claude, resuming
its own thread (see Resume-in-place). If the continuation also runs out, the
result retains the thread ID and uses the existing partial-work salvage path. Recovery messages
point to `codex resume`. Transient process-spawn retry remains bounded as before;
other failures use the existing error classification without pretending all Codex
failures are Claude API errors.

A failed Codex turn reporting “Unable to verify model access right now. Please
retry.” after a stream disconnect uses the existing delayed API retry schedule.
This covers the temporary access-check outage observed on Desktop ticket 1351.
The four-retry cap still applies. A disconnect by itself does not qualify.
Permanent model denials, approval blocks and timeouts still require review.

Logs include native Codex progress, thread ID, token usage and completed Codex
turns. Those turns are not comparable with Claude's model-turn count. Monetary
cost is reported as unavailable because Codex JSON does not provide a measured
USD cost.

Verification includes subprocess fixtures for streaming, failures and teardown,
and a disposable real Codex run that added a failing regression test, fixed it,
passed the tests and committed locally. It does not establish that every project
role or an entire live-board ticket has been exercised. Selecting a runner does
not provide a single-ticket mode; the normal launcher processes the board.


### Live artifact handoff

Codex's `completed` outcome completes the assigned role, not all later pipeline stages.
Missing role-owned work and permission denials still stop as `blocked`.

A capture ticket carries both `needs-real-claude` and `needs-live-artifacts` before
its first review. The implementation role lists pending capture files and coupled
reader changes in its PR. After review, the dispatcher runs the live gate. A pass
or flaky pass with the artifact marker returns to implementation using the active
stage set's rework label. It preserves both markers and posts the durable output
path. Failure and unavailable-evidence routing remain unchanged.

The implementation role commits the exact usable records and matching changes,
checks and pushes them, then removes only `needs-live-artifacts`. Existing rework
routing clears prior approvals. Review and the live gate run again before the
ordinary documentation handoff. A green disposable checkout alone cannot complete
a capture ticket. This workflow does not give agents Claude credentials.

## Time limits and waiting

A time limit should stop work that has stalled, not work that is queued behind
another ticket or slowed by a busy host. Two host-wide queues sit in front of
pipeline work on the mobile host: the Android device hold in the product's
`scripts/android-test-gate.py`, and the pipeline Gradle build places in
`~/.gradle/init.d/pyry-build-slots.gradle`. Both print what they are doing, and
the dispatcher reads those lines:

- `Android gate: device held by ...; waiting up to Ns`, then
  `Android gate: device free after Ns waiting` or
  `Android gate: device busy, not a test result: gave up after Ns; ...`.
- `Pyrycode build slots: all N places are taken by other pipeline builds; waiting (M min so far).`
  once a minute, then `Pyrycode build slots: got a place after N s.` or
  `Pyrycode build slots: no place after 20 minutes; building without one.`

Only lines that start with these exact words count, so a search hit on the
scripts' own source does not.

**Gates the dispatcher runs.** The verifier gates, the real-claude gate and the
main sweep are read as they run. While a gate's output shows it waiting, its
deadline moves with the wait. An open device wait counts up to its printed limit
and an open build-place wait up to shortly after its last once-a-minute note, so
a waiter that dies without a final line stops earning time on its own.

**Codex agent runs.** `codex exec --json` reports a command's output only when
the command finishes, as `aggregated_output` on its `item.completed` event, so a
wait is credited once some command's output shows its final line. Builders
often redirect a gate's output to a file and read it with `tail`, so the line
may arrive later, in a short command. Each distinct line is credited once, and
only for the part of its reported wait during which one of the run's own
commands was running, within that many seconds before the line was seen.
Reading an old log, or a wait behind a detached background process, earns
little or nothing. Mobile #1646's builder was killed at 70 minutes on
2026-10-04, two minutes after updating its pull request and before it could
report, having spent more than half an hour waiting for the device. Replayed
against its log, this credits the last of those waits, 500 seconds, which moves
the deadline eight minutes later. The earlier waits never printed a final line
the run read back, so they earn nothing.

When the budget is spent while a command started earlier is still running, the
run gets up to `PYRY_TIMEOUT_GRACE_MINUTES` for that command to finish. Once
every such command has finished the deadline applies again, with whatever credit
they brought. A command whose output was redirected shows nothing when it ends,
so a grace like that usually ends with the stop.

**Idle Codex runs.** The idle watchdog now covers Codex too. Across 672 Codex
runs in the mobile logs, two went over ten minutes silent with nothing
outstanding: builder #626 on 2026-09-20, silent for 30 minutes until its wall
clock ended it, and verifier #1291 on 2026-09-30, 10.3 minutes while Codex
retried a slow model stream and then finished. The default catches the first 20
minutes sooner and would have stopped the second 16 seconds early. That run
would have retried, which is cheap next to a run that never comes back.

**Hard ceiling.** Nothing runs past `PYRY_TIMEOUT_CEILING_FACTOR` times its
normal budget, twice by default, so a hung run still ends. With mobile's
settings, a 60-minute verifier gate can wait the full 45 minutes for the device
and still have its hour, inside a 120-minute ceiling.

**Claude agent runs.** Claude runs earn the same credit, grace and ceiling,
from their shell commands. The stream shows a shell command as a `Bash` tool
call and its output as the matching tool result, once the command ends, so a
Bash call counts as a running command from the call to its result, and the
result's text is read like a Codex command's output. Other tools' results are
never read. Claude's shell caps a foreground command at ten minutes and moves
it to the background past that, or at once when asked; the call's result then
returns early and stops counting, so a wait behind a backgrounded command earns
little or nothing. Until 2026-10-06 Claude kept a plain wall clock, because no
Claude fork ran these queues. Since 2026-10-05 mobile's builder reworks after a
failed review run on Claude, and they run the device gate in the foreground.

The stranded running-label sweep is unchanged: it never
touches a run this dispatcher has in flight, however long it takes.

## Health check before dispatch

A fork can name cheap commands that prove an agent run has what it needs.
The dispatcher runs them after it selects a ticket, before any `wip:` label,
family dispatch count or worktree. Exit 0 passes. A check whose command is
unset is off, so a fork with no `PYRY_HEALTH_*` settings behaves as before.
Added after 2026-10-01 to 2026-10-05, when a lost GitHub login, unavailable
Figma tools, a missing live-test login and a stale test daemon errored more
than twenty runs, each after the agent had spent its budget finding out
(agent-dispatcher#131).

- **Hold, not error.** A failed check leaves the ticket where it is and adds
  `held:health-check`. No `error:` label, rework count, retry count or family
  dispatch is recorded. One comment names the failed check and its exit
  status. One Discord message goes out when a check starts failing, and one
  when it passes again.
- **Checked at startup.** The dispatcher runs every check once before its
  first cycle, for each role it guards and for the live gate. It logs one
  `Startup health check passed` line naming the checks, or one
  `Startup health check failed` line per failing check, naming the check,
  its setting and the runs it holds. The first cycle reuses those results.
- **Re-checked on later cycles.** While the check still fails, the held
  ticket is left out of selection so other work gets its seat. Once it
  passes, the label comes off and the agent starts.
- **The agent's environment.** Checks run in the scrubbed environment the
  agent gets, from the target repo. For a Codex builder with live tests, a
  GitHub, live-login or daemon check sees only the names that builder's
  tool commands inherit, so a dropped `GH_TOKEN` fails the check as it
  failed desktop #1727. The Figma check sees the Codex process's own
  environment, since the process is what connects to MCP servers.
- **The live gate.** A failing live-login or daemon check skips the
  dispatcher's live gate for the cycle. It runs in the gate's environment.
- **Secrets.** A check's standard output is never posted or logged. Only
  the exit status and a scrubbed first line of standard error are, apart
  from the daemon check's version number.
- **Cost.** Each result is kept for `PYRY_HEALTH_CACHE_MS`, five minutes by
  default, per check and environment. A command is stopped after 60 seconds.

Mobile, Codex runner, in `.env`. Mobile's live gate builds its own daemon,
so it has no daemon check:

```sh
PYRY_HEALTH_GITHUB_CMD="gh auth status --hostname github.com"
PYRY_HEALTH_FIGMA_CMD="codex mcp list | grep -Eq '^figma[[:space:]].*[[:space:]]enabled[[:space:]]+OAuth'"
PYRY_HEALTH_LIVE_LOGIN_CMD='[ -n "$PYRY_LIVE_CLAUDE_TOKEN" ] || [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || op read --no-newline "op://kmzgpgsyeesea3pkiuk2ul2phq/Claude long term token/password" >/dev/null'
```

Desktop, Codex runner. The daemon path is the same file as `PYRY_BIN`:

```sh
PYRY_HEALTH_GITHUB_CMD="gh auth status --hostname github.com"
PYRY_HEALTH_FIGMA_CMD="codex mcp list | grep -Eq '^figma[[:space:]].*[[:space:]]enabled[[:space:]]+OAuth'"
PYRY_HEALTH_LIVE_LOGIN_CMD='[ -n "$PYRY_LIVE_CLAUDE_TOKEN" ] || [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || op read --no-newline "op://kmzgpgsyeesea3pkiuk2ul2phq/Claude long term token/password" >/dev/null'
PYRY_HEALTH_DAEMON_CMD="/absolute/path/to/pyrycode-desktop-tests/pyry --version"
PYRY_HEALTH_DAEMON_MIN_VERSION=0.33.0
```

The live-login command passes in the gate's environment, which carries the
fork's `CLAUDE_CODE_OAUTH_TOKEN`, and in a builder's, which carries the
builder-only `PYRY_LIVE_CLAUDE_TOKEN` loaded from protected startup credentials.
If no local login was supplied, the restricted Dev Agents account remains a
fallback. The Figma command proves that Codex
has a Figma login configured. It cannot prove the server answers, which
would need a model run. A daemon version only changes on a release; to
require a particular pyrycode commit instead, make the daemon command fail
unless that commit is an ancestor of the binary's `vcs.revision` from
`go version -m`.

## Codex pipeline helpers

`codex-helpers/` holds the source of the fixed-destination GitHub helpers that
agents use to publish, and that Codex's rules approve by their installed path.
Edit them here and run `codex-helpers/install` on the dispatcher host; see
[codex-helpers/README.md](codex-helpers/README.md).

## Preserve local work during cleanup

The dispatcher uses ordinary Git worktree removal. Dirty or locked worktrees stay
at their existing paths. A retained worktree can block the next run of that branch;
resolve and commit its work before retrying. The exception is the same agent's own
worktree for the same ticket, which the next run continues in (see "Worktree isolation"). Startup never force-removes it.
Cleanup reports local changes in the main checkout without discarding tracked edits
or deleting untracked files. This also applies to live-gate and baseline worktrees.
A preserved path is evidence to inspect, not permission to force-delete it.

Live-gate, baseline and main-sweep worktrees have one exception to blocking.
A killed run leaves untracked captures, so its worktree survives removal.
Before the next run, the dispatcher moves such a leftover aside to a
`stale-<name>-<stamp>` sibling with `git worktree move`, keeping every file,
and then creates a fresh worktree. After a run, removal stays ordinary, so a
finished run's captures remain at their path for the implementation role.

## Recovering a ticket by hand

`scripts/recover-ticket.py` makes a manual recovery repeatable. It needs Python 3
and a `gh` login with the `project` scope. Every mutating subcommand takes
`--dry-run` and prints exactly what it would do; run that first.

```bash
R=dispatcher/scripts/recover-ticket.py
python3 $R halt pyrycode 3022                 # card to Halted, refused while a wip: label is present
python3 $R export pyrycode 3022               # patch of unpushed and uncommitted work, read only
python3 $R clean-local pyrycode 3022 --dry-run
python3 $R handback pyrycode 3022 --column Backlog --remove-label error:builder --dry-run
python3 $R port pyrycode 3023 --from feature/3023-dispatch-base --dry-run
python3 $R family-reset pyrycode 2959 --require-progress-hours 24 --min-gap-hours 24 --dry-run
python3 $R clear-wip pyrycode 3023 --label wip:builder --min-age-minutes 110 --dry-run
```

- `halt` moves the card to Halted, which the dispatcher never reads.
- `export` reads each `<role>-<N>` worktree (in place, or already moved into
  the recovery folder, or any `--worktree`) and writes
  `recover-<repo>-<N>-<name>.patch` plus an `.untracked.txt` list. The patch is
  everything since the worktree's merge base with `origin/feature/<N>` (or
  `origin/main` when that branch does not exist), committed or not. A worktree
  stopped in the middle of a merge, rebase, cherry-pick or revert is refused:
  its HEAD and index are a half-made state. It also lists every local
  `feature/<N>` and `feature/<N>-<suffix>` branch with its commits ahead of
  `origin/main` and writes one `recover-<repo>-<N>-branch-<name>.patch` each,
  since side branches such as `feature/3023-dispatch-base` are where a hand
  recovery leaves the real work. A patch over `--max-patch-mb` (default 2) is
  not written and is named in a warning; #3023's first export was an 11.8 MB
  half merge of another ticket's lineage. Exit 2 when anything was refused or
  capped.
- `clean-local` clears the two states that park the next stage after a hand
  recovery pushed a fresh `feature/<N>`. A local `feature/<N>` that differs
  from origin and cannot fast-forward ("Local and origin have DIVERGED") is
  renamed to `preserved/<N>-<stamp>`. The refiner, builder, verifier and
  documentation worktrees of the ticket ("already exists") are moved, folder
  and `.git/worktrees` admin dir both, into
  `<root>/.pyrycode-recovery/<repo>/<N>-<stamp>/`, with a `RECOVERY.txt`.
  Live-gate worktrees are left to the gate. It refuses while a `wip:` label is
  present or the ticket's agent log changed in the last 10 minutes.
- `handback` checks that origin has `feature/<N>`, runs `clean-local`, edits
  the labels, sets the column and reads the card back. It warns when the
  column and labels would auto-advance or a label still blocks dispatch.
  `--column keep` leaves the card in its column, for clearing a stale local
  state plus its `error:<role>` label.
- `port` takes the commits in `origin/main..<--from>` whose subject names
  `(#N)`, the pipeline's commit convention, so another ticket's lineage stays
  out (`--all-commits` takes every non-merge commit). It makes a `--shared`
  scratch clone of the dispatcher's checkout, branches `feature/<N>` from a
  fresh `origin/main`, cherry-picks with `-x`, runs the repo's `checks` from
  `recover-ticket.json` (Go: `go vet ./...` and `make build`; desktop:
  `npm ci` and `npm run typecheck`; other repos: none, said so), and pushes a
  new `feature/<N>`. If origin already has a different `feature/<N>` it stops
  and never forces. `--dry-run` does the clone, picks and checks for real in a
  temporary folder it removes, and pushes nothing. Hand back with `handback`.
- `family-reset` posts the `<!-- family-dispatch-reset -->` comment on a
  family root and removes `error:family-breaker`. `--require-progress-hours`
  refuses unless a child or grandchild moved column or closed that recently;
  `--min-gap-hours` refuses a second reset within that window.
- `clear-wip` removes a `wip:<role>` label only when the label was added, and
  no agent log of the ticket written, at least `--min-age-minutes` ago. Use
  the dispatcher's own "Stranded-wip gate" time from its start log.

Commits made by the script (only `port`, in its scratch clone) need an
identity. Fresh clones and the dispatcher's checkout on the pyrybox host have
none, so `port` sets a repo-local `user.name` and `user.email` in its clone
when they are missing: `git_identity` in `recover-ticket.json`, the identity
of the dispatcher's own commits, or `--git-name` and `--git-email`. It never
writes the dispatcher's checkout config, which the containers share.

Nothing is deleted, force pushed or pruned. Never run `git worktree prune`
from the pyrybox host: the containers write `/work/Projects/...` paths into
every worktree, so the host sees them all as prunable and a prune drops the
worktrees of runs in flight. The script maps those paths to the host itself.

Board, project, field and column ids are read live from the board number. The
repo to board map, the agent roles and the root candidates live in
`scripts/recover-ticket.json`. The checkout root is `--root`, else
`$RECOVER_TICKET_ROOT`, else the first that exists of `/work/Projects`,
`/home/pyry/pyrycode-runtime/work/Projects` and `~/Workspace/Projects`. The
dispatcher's checkout is `<root>/<repo>` unless `--checkout` says otherwise.
Tests: `python3 -m unittest discover -s scripts -p 'test_*.py'`.

## Builder live-test account

`PYRY_DEV_AGENTS_TOKEN` is an optional `op://Automation/xcl7xsu5ppbww3m5gav7wmbt6e/credential` reference resolved at dispatcher start. It must identify the separate service account that can read only the Dev agents vault. Never configure it with the Automation account token.

The spawn scrubber removes both account variables and any inherited live-test alias. For builders alone, it copies the protected startup `CLAUDE_CODE_OAUTH_TOKEN` into `PYRY_LIVE_CLAUDE_TOKEN`. This builder-only name survives Codex's Claude credential scrubber. It also maps the restricted account to `OP_SERVICE_ACCOUNT_TOKEN` as a fallback when the actual login is absent. Other Codex roles receive neither account nor the live-test alias. The non-secret `PYRY_AGENT_SHELL_ENV` filter still refuses secret names. Codex builders inherit through a names-only shell allowlist, never through a secret value in arguments. That list preserves the container's existing `GH_TOKEN` publishing login and its `DISPLAY` and `PLAYWRIGHT_BROWSERS_PATH` settings for Desktop tests. It does not pass `GITHUB_TOKEN` or the Automation account.

Mobile's `scripts/android-test-gate.py live --tests "Class#method"` fetches its own child login. Go and Desktop repairs use `python3 "$AGENTS_REPO_PATH/dispatcher/scripts/live-claude-gate.py" go --tests "^TestName$"` or `desktop --spec e2e/real-name.spec.ts --tests "test title"`. Run from the product worktree. Build Desktop first. The shared Go and Desktop launcher uses the loaded live-test alias before any online lookup. It fetches `op://kmzgpgsyeesea3pkiuk2ul2phq/Claude long term token/password` only when a local login is absent. Launchers remove account credentials and the alias from test children. Update the configured live-login health command to check the alias before its online fallback. Missing access is an environment error. A zero-test run fails. Record the executed and passed counts. Full-suite runs remain dispatcher work.

## Full-duration process proofs

`pnpm test` runs policy tests and ordinary fake-process integration tests.
`pnpm run test:slow` includes 13 real-clock timeout, termination and wait-credit proofs.
The longer tier retains its existing timing margins for loaded hosts.
Both tiers limit simultaneous test files to four workers so fake child startup
does not compete with every test file at once.
Run it after changes to runner timeouts, process termination or wait-credit accounting.
The consumer launcher exposes it as `bin/pyry-test --slow`.

## Multiple computers

Optional [managed dispatch](docs/machine-manager.md) shares heavy capacity across projects on each computer and reserves tickets across computers. The guide covers configuration, Linux and macOS services, draining and manual ticket release.

A Codex run that OpenAI refuses with a rate limit (429) pauses new Codex starts across the whole fleet, doubling while the limit lasts. While the claim service confirms that pause, the ticket is not errored and its retry count does not move, for up to four 429s on one ticket while other Codex runs get through; otherwise the ordinary capped transient retry applies. See [Codex rate-limit pause](docs/machine-manager.md#codex-rate-limit-pause).

### Incomplete verification

A configured execution floor applies before failure attribution. A partial full
run cannot become a pass by rerunning only its failed tests.

An unexcused red pre-verifier gate still starts a reviewer for diagnosis. The
reviewer can route demonstrated regressions to rework. It cannot advance the
ticket, including through saved-verdict recovery. The dispatcher removes any
ready label and parks the review with its error label unless rework was requested.
After fixing the gate or its environment, remove that error label to rerun the
configured checks. Existing machine-checked flaky and baseline assessments still
continue through the remaining gates before review.

### Managed Mobile candidate checks

Mobile tickets can request `mobile-scripted-evidence` or `mobile-in-depth` with capability `mobile-android` and a full pushed Mobile revision. The first runs the existing reply-suggestion and selection-copy scripted checks. The second runs the existing complete UI profile with `UI_GATE_FULL=1 UI_DEVICE_ALL=1 UI_SHARDS=2`. Its 1800-second budget includes checkout, preparation and device admission. Neither uses Claude or the production daemon.

These routes fetch the candidate from the Mobile remote. Supporting agents, daemon and relay revisions are recorded separately. Results include the selected commands, elapsed phases, counted XML and retained failure diagnostics. The authority rejects missing, zero-test, failed, incomplete, wrong-revision or wrong-profile success claims. A returned diagnostic does not establish that a product defect is repaired.

Linux supervisors derive these fixed routes from their configured Android runtime. They advertise `mobile-android` only after checking the configured Mobile source, SDK, acceleration and required tools. Existing Core capture remains available separately. Deployment must update the authority before supervisors advertise the new capability.

For a manually reviewed dispatcher release, the protected operator accepts `control target FULL_REVISION`. Only the central operator credential can select it. The service checks that the revision belongs to upstream main before saving the existing controller target. Supervisors then use their existing backup, fast-forward, graceful restart and readiness procedure. This does not change ticket state or loosen drains. The central authority must first load the new source so it recognises the command and capability.
