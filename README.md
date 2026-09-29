# agent-dispatcher

Dispatch agent runs against a GitHub Project board. Label-driven state machine, worktree isolation, salvage on `max_turns`.

Built for [pyrycode](https://github.com/pyrycode); reused across multiple agents repos.

## What it does

The dispatcher polls a GitHub Project (v2) board, reads the current column + labels of each item, and decides whether to run an agent against it. Each agent is a `claude -p` invocation with a per-agent CLAUDE.md system prompt. Agents work in isolated `git worktree` checkouts, push to feature branches, and open pull requests.

The state machine is driven entirely by **labels** + **board column**. No queue, no scheduler, no daemon-side state — restart-safe by design.

### Pipeline (default)

```
Inbox → Backlog → In Architecture → In Development → In Code Review → In Documentation → Done
         (PO)      (architect)       (developer)      (code-review)    (documentation)
```

Each transition is gated by a `done:<agent>` label, advanced automatically when the previous agent finishes. Failures route via `needs-rework:<agent>` (back to that agent) or `error:<agent>` (held for human triage).

A `needs-rework:<agent>` naming an agent the active stage set does not run parks the ticket under `error:rework-target` with a comment listing the agents that exist. Without that, the label stays on, nothing moves, and the agent that applied it is re-dispatched every cycle: on 2026-09-06 a verifier on the builder set applied `needs-rework:po`, a role that set lacks, and ran again 27 seconds later.

### Worktree isolation

Each dispatch creates a fresh `git worktree` under `.<target>-worktrees/<agent>-<issue#>/`. Concurrent dispatches don't interfere; failures leave the worktree as evidence for triage; `git worktree remove --force` cleans up.

### Resume-in-place

Before any salvage, a run that exhausted its budget — the `max_turns` turn cap or the dispatcher's wall-clock timeout — gets up to `PYRY_RESUME_LEGS` continuation legs (default 1; `0` disables the feature and restores the pre-resume behaviour byte-for-byte). A continuation leg resumes the **same claude session** via `claude --resume <session-id>` with a fresh budget, inside the same dispatch and the same worktree, with every flag re-passed (they do not carry over on resume). Session ids are captured from the stream's init frame, so even a killed run that never emitted a result frame stays resumable. Most budget exhaustions are "ran out mid-task", not "stuck" — one fresh budget converts most of those human-triage interruptions into automatic completions. If the final leg is still exhausted, the salvage paths below run unchanged, keyed on the original run's result. Permission denials never resume; they keep their own salvage.

**Claude-binary bridge caveat:** continuation legs always spawn the `claude` CLI directly, regardless of `PYRY_USE_LEGACY_CLAUDE`, because the `pyry agent-run` wrapper has no resume support yet. This is a pilot bridge; it retires once the wrapper grows a `--resume` flag.

**Economics note:** graceful resumption changes the economics of ticket splitting — a ticket that would previously burn a human triage cycle on a budget miss now just costs a second leg, so oversized-but-coherent tickets get cheaper relative to eager splits. The refiner guides flip their split-leaning default separately once this is observed live.

### Salvage

When an agent exhausts its budget mid-dispatch (and any resume-in-place legs are spent), the dispatcher tries two recovery paths before flagging the run as errored:

1. **PR-already-exists** — if the agent opened a non-draft PR before timing out, treat the run as success.
2. **Safer-salvage** — if the worktree has uncommitted changes or committed branch changes relative to the default branch, run `go vet` + `go build` (or the consumer's configured salvage gates). When they pass, commit only outstanding edits, push and open a draft PR with `error:max_turns_salvaged`. A clean branch with no content change is not recoverable. The ticket stays blocked until human triage; recovery never marks the agent complete.

### Family circuit breaker

Every dispatch of a ticket increments a counter on its family ROOT (the top of its split lineage, resolved via the sub-issue parent chain) — a marker comment as the durable tally, mirrored by a `family-dispatches:N` label. Once a family consumes `PYRY_FAMILY_DISPATCH_LIMIT` dispatches (default 24, about four clean six-stage tickets), the breaker drops the family's candidates each cycle and parks the root under `error:family-breaker`, which vetoes every descendant at selection. Caps the runaway-split failure mode where a lineage keeps splitting and reworking past every per-ticket breaker (one such spiral burned ~213$ overnight across 11 descendants). Parking is silent beyond the board; tickets mid-run finish normally.

The breaker only drops candidates, and selection spends the whole `PYRY_MAX_CONCURRENT` budget before the drop happens, so the poll loop runs selection and the breaker as a loop (`selectPastParkedFamilies`): each pass's vetoed roots are fed back in as `excludedRoots` and the freed slots go to unrelated families. Without it, one parked lineage at the head of a column starves the entire board — which is exactly what happened on 2026-09-01, at concurrency 1, with 48 unrelated tickets queued behind three parked descendants of one root. The root's labels are also topped up with a direct issue read when the root is not on the board, because a closed root leaves the board whenever a crowded Done column is archived, and an unreadable label silently disables the selection-layer veto. To resume one family: post a comment containing `<!-- family-dispatch-reset -->` on the root (zeroes that family's tally — only dispatches after the latest reset count), then remove the `error:family-breaker` label. Raising `PYRY_FAMILY_DISPATCH_LIMIT` is the global fallback; it raises the budget for every family at once.

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
| `PYRY_POLL_INTERVAL_MS` | `60000` | How long the loop waits between board reads when no run settles first. Whole milliseconds, floor `10000`; anything else keeps the default. Only idle pickup latency changes: a dispatch or a settled run wakes the loop at once. Mobile runs `120000` since 2026-09-22 to ease the account-wide GitHub API limit. |
| `PYRY_VERIFIER_GATES` | `go vet ./...; go build ./...` | Builder stage set only: `;`-delimited deterministic gate commands the dispatcher itself runs in the ticket's worktree before spawning the verifier. Same parsing as `SALVAGE_GATES`; set to `""` to skip the pre-verifier gate step. A fork's `.env` sets the full list, e.g. `make check;make build`. Inert in the classic set. |
| `PYRY_VERIFIER_GATE_TIMEOUT_MS` | `600000` | Builder stage set only: wall clock for each `PYRY_VERIFIER_GATES` command. A gate that runs past it reads as red and the verifier spawns in triage mode. Raise it for a fork whose slowest gate needs longer; Desktop runs `1800000` since 2026-09-25 because its serial Playwright tier takes about 15 minutes. |
| `DISCORD_WEBHOOK_URL` | — | Notify on dispatch start/end |
| `PYRY_LOG_RETENTION_DAYS` | `30` | Rotate logs older than N days; `0` disables |
| `PYRY_RESUME_LEGS` | `1` | Resume-in-place: how many same-session continuation legs a budget-exhausted run gets before salvage. `0` disables the feature entirely (byte-identical pre-resume behaviour). See above. |
| `PYRY_BUDGET_SCALE` | `1` | Multiplier on every agent's turn cap and wall-clock timeout, for a fork whose tickets or model need a different budget without changing the others. Timeouts round to whole minutes. Unset, empty, non-numeric, zero or negative keeps `1`. Mobile runs `1.5` since 2026-09-23, after moving to Opus 5.5 and raising its ticket ceiling to 1600 lines. Printed in the startup banner. |
| `PYRY_FAMILY_DISPATCH_LIMIT` | `24` | Family circuit breaker: dispatch budget per ticket family before the whole lineage is parked under `error:family-breaker` on its root. Per-family resume via a reset comment on the root; this knob is the global fallback. See above. |
| `OWNER_TYPE` | `user` | `user` or `organization` for GitHub Project owner |
| `PYRY_REAL_CLAUDE_GATE_CMD` | — | Shell command that runs the fork's live-claude suite. **Empty disables the gate entirely** and gated tickets park for an operator. See below. |
| `PYRY_REAL_CLAUDE_GATE_FORMAT` | `go-json` | How to read what the command wrote: `go-json`, `playwright-json` or `junit-xml` |
| `PYRY_REAL_CLAUDE_GATE_TIMEOUT_MS` | `1800000` | Outer wall clock for one gate run. Must exceed the command's own inner timeout. |
| `PYRY_REAL_CLAUDE_GATE_MIN_EXECUTED` | `1` | Floor for the executed-test guard. Set near the suite's real count. |
| `PYRY_REAL_CLAUDE_GATE_BASELINE_CMD` | — | Base-commit re-run template with a `{{TESTS}}` placeholder. Runs only when the branch has named failures, so it costs seconds. Unset means failures are attributed to the branch. |
| `PYRY_MAIN_SWEEP_CMD` | — | Main sweep: an in-depth command, too slow for every verifier pass, run against main when the board is idle or every `PYRY_MAIN_SWEEP_EVERY` merges. Runs inline, never beside a verifier. A failure files one Backlog ticket. **Empty disables it.** State in `logs/main-sweep-state.json`. |
| `PYRY_MAIN_SWEEP_EVERY` | `5` | Merges since the last sweep that force one while the board is busy. |
| `PYRY_MAIN_SWEEP_TIMEOUT_MS` | `1800000` | Outer wall clock for one sweep. |
| `PYRY_MAIN_SWEEP_FORMAT` | — | Optional `go-json`, `playwright-json` or `junit-xml`, to name the failing tests in the ticket. Without it the exit code alone judges the run. |

> **Load order.** `dotenv` now loads the fork's `.env` before any module-top constant reads `process.env`, so every variable in this table works from the file. Before 2026-08-07 the load sat below several of those reads, and `TARGET_REPO_PATH`, `TARGET_DEFAULT_BRANCH`, `SALVAGE_GATES` and `PYRY_AUTOCURATE_MEMORY` were silently file-blind — each fork's launcher pre-exported `TARGET_REPO_PATH` to work around it. Values a launcher exports, or that `op run --env-file` injects, still take precedence over the file.

### Stage sets

`PYRY_STAGE_SET` selects which agent pipeline the dispatcher runs. It is resolved once at startup, printed in the startup banner, and an unknown value exits immediately with the valid names.

`PYRY_MAX_CONCURRENT` is a pool of seats, not a batch size. Since 2026-09-22 each run frees its seat the moment it settles and the loop wakes to fill it, so a short refiner run beside a long verifier run no longer leaves its seat idle until the verifier ends (measured on Mobile: 6m24s idle in a 12-minute cycle). Rework routing and column advances run on every pass as before, and skip any ticket that still carries a `wip:<agent>` label, because that agent owns the ticket until it exits. A drain waits for every run in flight.

**`classic`** (default, also when the variable is unset) — the six-agent relay exactly as documented everywhere else in this README: PO → Architect → Developer → QA → Code Review → Documentation, advancing Backlog → In Architecture → In Development → In QA → In Code Review → In Documentation → Done. With this set the dispatcher's behaviour is byte-identical to before stage sets existed; the identity is locked by tests against literal copies of the classic config.

**`builder`** — a collapsed four-role pipeline, currently piloted on one fork:

| Role | Column | Notes |
|---|---|---|
| `refiner` | Backlog | The PO contract under a new name (`refiner/CLAUDE.md`, no worktree). |
| `builder` | In Development | Absorbs architect + developer: gets the Agent sub-agent tool AND WebSearch, 200 turns, 40min. |
| `verifier` | In Code Review | Absorbs QA + code review: Agent tool, code-review budgets (150 turns, 40min). |
| `documentation` | In Documentation | Unchanged from classic (serial, sonnet). |

The advance chain is Backlog → In Development → In Code Review → In Documentation → Done. The In Architecture and In QA columns are simply absent: never polled, never advanced into. Rework labels route against the set's own roles (`needs-rework:builder`, `needs-rework:refiner`, …), so create those labels in the fork's repo.

**Pre-verifier gates (builder set only).** Before spawning the verifier on a ticket, the dispatcher runs the fork's deterministic gates itself — the `PYRY_VERIFIER_GATES` commands, each capped at `PYRY_VERIFIER_GATE_TIMEOUT_MS` (10 minutes by default), in the ticket's worktree. The deterministic layer decides only green vs red; the verifier spawns either way, and a `GATES` section in the dispatch log records each command's verdict:

- **All green** → the verifier's prompt gets a gates-passed note, so it spends its budget on judgment rather than re-verification.
- **Any red** → the verifier's prompt gets the failure context in **TRIAGE MODE**: the failing gate, its verdict (exit code / timeout / spawn error) and the tail of its output (capped at 4000 chars). The verifier then owns the baseline partition and the bounce-vs-advance call, exactly as QA does today — failures that already exist on the merge base get filed and advanced rather than bounced, and only regressions this ticket caused go back to the builder. The dispatcher deliberately applies no rework label on red: a deterministic bounce would loop forever on a pre-existing failure.

In the classic set this feature is entirely inert (locked by test): no gate runs, no env is read.

**Real-claude gate under stage sets.** The gate's trigger and rework labels derive from the active set: it fires on the set's final pre-documentation review signal (`done:code-review` in classic, `done:verifier` in builder) and routes genuine failures back with the set's own rework label (`needs-rework:developer` / `needs-rework:builder`). A `needs-real-claude` ticket on the builder fork therefore parks and executes through the gate exactly as it does under classic.

### Real-claude gate

Some tickets can only be accepted by running against real claude rather than the pipeline's fakes. The PO marks them `needs-real-claude` during refinement. After code review such a ticket is parked in Inbox, and if this fork sets `PYRY_REAL_CLAUDE_GATE_CMD` the dispatcher then runs the suite itself, once per cycle, before it picks any other ticket.

While that suite is running, the ticket carries `wip:real-claude-gate`. The dispatcher removes it when the run finishes, whether the result passes, fails, or needs human attention. A ticket with any `wip:` label is not selected for another gate run. The existing stranded-running-label sweep clears a marker left by an interrupted process after its safety delay.

**What it does per run.** Fetches, resolves the branch from `origin` only, records how many commits behind the base branch it is, probes for conflicts with `git merge-tree --write-tree` before touching the disk, creates a **detached** worktree at the head commit, merges the base branch into it, runs the command, then judges by reading the output file back off disk. The worktree is removed either way. Both log files end in `.log`, so the existing rotation sweeps them.

**Outcomes.**

| Verdict | Board | Labels | Discord |
|---|---|---|---|
| pass | → In Documentation | removes `needs-real-claude` | no |
| flaky: every failure passed on a same-tree re-run | → In Documentation | removes `needs-real-claude` | yes, naming the flaky tests |
| fail | → In Development | adds the set's fail rework label (`needs-rework:developer` classic, `needs-rework:builder` builder), **keeps** `needs-real-claude` | no |
| failures the branch inherited | → In Development | adds the set's fail rework label, **keeps** `needs-real-claude` | yes, naming the main-branch failures |
| nothing executed | stays in Inbox | adds `error:real-claude-gate` | yes |
| no usable result | stays in Inbox | adds `error:real-claude-gate` | yes |

**The same-tree re-run, and why it comes first.** A base comparison tells a regression from an inherited failure. It cannot tell either from a flake, because a flake passes on the base too and so reads as a regression. On 2026-09-06 pyrycode #2089, a finished ticket with a fifth-pass review PASS, failed one liveness test its diff never reaches; the test had passed the previous nineteen gate runs and passed three of three by hand minutes later, but it passed on the base, so the gate routed the ticket to rework and the three-strike breaker tripped. So when a run fails with named tests, the gate first re-runs **only those tests** in the same merged worktree, using the baseline command template. A test that passes there is set aside as flaky and never reaches the base; only tests that fail again are compared. When every failure was flaky the verdict is flaky-pass: the ticket advances exactly as on a pass, the flaky tests are named in the evidence comment, and Discord is pinged so the suite gets looked at. Only a test seen passing is excused; a name the re-run skipped or never reported stays failing, and a re-run that executes nothing proves nothing. Hangs the test binary's own `-timeout` killed are not re-tried, since a hang costs the whole timeout again; the panic names them, so they are counted as failures and compared against the base like any other.

**Every flaky test gets a ticket.** Letting a flake through is right for the ticket and leaves the suite's problem untracked: nobody is blamed, so nobody files anything. On pyrycode-mobile, 2026-09-24, a second-client bug behind several flakes went a whole day with no ticket that way. So after the gated ticket's own writes, each flaky test gets one open `flaky-test` ticket in Backlog, labelled `bug`. A hidden marker line in its body, `<!-- flaky-test: <full test name> -->`, lets later runs find it, and each later flake adds a comment instead of filing again, so the comments count the occurrences. Closing the ticket means the next flake files a fresh one. A run files at most five new tickets, since more flakes than that points at the environment; the rest are logged. To route an existing hand-filed ticket's flakes to it, add the label and the marker line to its body.

**The base comparison, and why it exists.** On the gate's first live run, 2026-08-07, a ticket came back with 519 passed and 2 failed. Both failures reproduced identically on clean `main` and neither touched the ticket's subject. The comparison records whether the ticket introduced a failure so rework does not misattribute it. Since 2026-09-28, a trustworthy red test run still routes to rework even when main is also red; `error:real-claude-gate` is reserved for a run the gate could not judge.

So when a run fails with named tests, the gate re-runs **only those tests** against the base commit alone, unmerged, in a second detached worktree. Tests red on both sides are reported as inherited in the evidence and Discord warning. The ticket goes to rework either way. Set it up as:

```sh
PYRY_REAL_CLAUDE_GATE_BASELINE_CMD='go test -tags e2e_realclaude -timeout 20m -json -run {{TESTS}} ./internal/e2e/realclaude/...'
```

Do not quote `{{TESTS}}` yourself; the substituted filter brings its own quoting. Two refusals are deliberate. A name containing anything outside a conservative character set refuses the whole filter rather than dropping that name, because a partial filter compares different test sets on the two sides. And a base run that executes nothing, the same false green the gate exists to reject, is discarded rather than treated as exoneration. In both cases `baselineFailures` stays null and the failures remain the branch's, since **a missing baseline is not an exoneration**.

A failure keeps `needs-real-claude` so the ticket must pass the gate again after the fix; `runReworkRouting` strips the stale `done:*` trail and brings its three-strike breaker along. Failures reproduced on main also route to rework, with the baseline result recorded so the agent knows the ticket branch did not introduce them. An environment failure or unusable report parks instead of routing to the developer agent, which could not fix a missing credential and would burn three spawns discovering that. The `error:` prefix excludes a parked ticket from the WIP count and from gate re-selection.

**The command must emit a per-test report.** For Go that means:

```sh
PYRY_REAL_CLAUDE_GATE_CMD='go test -tags e2e_realclaude -timeout 20m -json ./internal/e2e/realclaude/...'
PYRY_REAL_CLAUDE_GATE_MIN_EXECUTED=150
```

Android consumers can emit JUnit XML with `PYRY_REAL_CLAUDE_GATE_FORMAT=junit-xml`. The command must write only XML to stdout and send build logs to stderr. Both `<testsuite>` and `<testsuites>` roots are accepted. The reader counts named test cases, excludes skips, preserves failures across duplicate reports, and rejects malformed reports or missing cases advertised by the suite. Mobile's wrapper additionally requires freshly generated device reports and forces the test task to execute.

For `junit-xml` the `{{TESTS}}` filter is not a regex. It is a single-quoted, comma-separated `pkg.Class#method` list, the shape Android's instrumentation `class` argument takes, so the baseline command must hand it to a runner that selects tests by that list. A name that is not a plain class and method, such as a parameterised `method[0]`, refuses the whole filter.

The baseline command currently uses Go test filters. Leave it unset for JUnit consumers until their command supports that filtering contract. Without it, failed tests route to rework without automatic retry or base comparison.

A bare `make e2e-realclaude` target will **not** work. Without `-json` it prints nothing per-test on success, only a package summary, so executed tests cannot be counted — and the executed-test count is the whole guard. This is a contract, not a detail.

**Why the count, and not the exit code.** On 2026-07-22 a real-claude suite skipped every test, exited 0, and the code-review agent read that 0 as a pass; an unverified change shipped (pyrycode PR #1169 / #1168). A skip and a pass are indistinguishable to an exit code. So `decideGateVerdict` consults the exit status last and only to make a verdict worse: a zero exit can never turn a non-pass into a pass. Counting is also leaf-only — a parent test whose subtests all skipped reports `pass` for itself, and counting it would reopen the same hole one level up.

**Billing.** The spawn environment keeps `CLAUDE_CODE_OAUTH_TOKEN` and leaves `ANTHROPIC_API_KEY` unset, so runs bill against the subscription. Tests that need a metered key skip; the executed floor should be set with those skips already accounted for.

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
board processing. The installed Codex CLI must support `exec --json`,
`--approve-for-me`, and `--output-schema`. The integration was verified with CLI
0.153.4. Authenticate Codex on the dispatcher host before starting the queue.
Claude authentication is not reused.

Codex uses `gpt-6-sol` by default and inherits the operator's configured effort.
Optional `PYRY_CODEX_MODEL` and `PYRY_CODEX_EFFORT` select Codex-specific overrides;
Claude stage model names and effort overrides are never passed to Codex.
The optional role-risk policy below selects effort for both runners instead.
At startup the dispatcher pins the Codex executable from PATH. On macOS it also
checks the ChatGPT app bundle when the terminal PATH does not expose its CLI.
`PYRY_CODEX_BIN` overrides discovery. An invalid override or missing executable
stops startup before ticket selection or labels are changed.
The same stage set, ticket prompts, worktrees, deterministic gates and post-run
checks apply. Product tests that exercise real Claude continue to exercise Claude.

### Optional role and risk effort trial

Set `PYRY_EFFORT_POLICY=role-risk-v1` in one consumer's `.env` to opt its
four-role builder pipeline into task-dependent effort. It works with Claude and
Codex. Other consumers retain their settings. Model choices, turn limits,
timeouts and acceptance gates do not change. An explicit `PYRY_CODEX_EFFORT`
still overrides the trial for Codex. Leave that override unset to measure the policy.

| Role | Routine ticket | Elevated risk | No valid assessment |
| --- | --- | --- | --- |
| Refiner | medium | high | medium |
| Builder | medium | high | high |
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

A successful process must emit a completed turn and a valid final JSON outcome
with `status: completed`. A `blocked` outcome, missing outcome, failed turn,
nonzero exit or dispatcher timeout cannot advance a ticket. A blocked outcome
parks the ticket without automatic retry and preserves its worktree for recovery.
This avoids deleting edits after a required commit or external action is rejected.
The operator must inspect that worktree before re-queueing the ticket.

A builder may instead return `status: needs_refinement` for a planning problem.
The dispatcher posts its explanation on the assigned issue and adds
`needs-rework:refiner`. The existing rework router moves it back to refinement.
No implementation-complete label, automatic commit or push occurs. Its worktree
is retained. Other roles cannot use this outcome. A failed run or observed
approval rejection cannot use this route. Permission denials still require
operator review; the dispatcher does not retry the denied action.

A Codex builder may return `status: waiting_on_blocker` after linking an open
GitHub dependency. The dispatcher reads blockers afresh, posts the wait and
routes through `needs-rework:refiner`. The existing router leaves the ticket
in development without adding a rework count. A missing or closed blocker,
failed run, or approval rejection still becomes an agent error.

Codex has no Claude-style max-turn budget. The existing per-stage wall-clock
budget applies, with process-group termination and a two-second forced-stop grace
period. Codex does not enter the Claude continuation path. Timeout results retain
the thread ID and use the existing partial-work salvage path. Recovery messages
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

## Codex pipeline helpers

`codex-helpers/` holds the source of the fixed-destination GitHub helpers that
agents use to publish, and that Codex's rules approve by their installed path.
Edit them here and run `codex-helpers/install` on the dispatcher host; see
[codex-helpers/README.md](codex-helpers/README.md).

## Preserve local work during cleanup

The dispatcher uses ordinary Git worktree removal. Dirty or locked worktrees stay
at their existing paths. A retained worktree can block the next run of that branch;
resolve and commit its work before retrying. Startup never force-removes it.
Cleanup reports local changes in the main checkout without discarding tracked edits
or deleting untracked files. This also applies to live-gate and baseline worktrees.
A preserved path is evidence to inspect, not permission to force-delete it.

Live-gate, baseline and main-sweep worktrees have one exception to blocking.
A killed run leaves untracked captures, so its worktree survives removal.
Before the next run, the dispatcher moves such a leftover aside to a
`stale-<name>-<stamp>` sibling with `git worktree move`, keeping every file,
and then creates a fresh worktree. After a run, removal stays ordinary, so a
finished run's captures remain at their path for the implementation role.
