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

### Worktree isolation

Each dispatch creates a fresh `git worktree` under `.<target>-worktrees/<agent>-<issue#>/`. Concurrent dispatches don't interfere; failures leave the worktree as evidence for triage; `git worktree remove --force` cleans up.

### Salvage

When an agent hits `max_turns` mid-dispatch, the dispatcher tries two recovery paths before flagging the run as errored:

1. **PR-already-exists** — if the agent opened a non-draft PR before timing out, treat the run as success.
2. **Safer-salvage** — if the worktree has uncommitted changes that pass `go vet` + `go build` (or the consumer's configured salvage gates), open a draft PR with `error:max_turns_salvaged` and let the next dispatch continue from there.

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
| `SALVAGE_GATES` | `go vet ./...; go build ./...` | `;`-delimited shell commands that gate the safer-salvage path on `max_turns`. Each runs in the agent's worktree; all must exit 0 for the dispatcher to commit + push uncommitted work as a draft PR. Set to `""` to skip gating entirely. Override per ecosystem (e.g. `cargo check --all-targets; cargo test --no-run` for Rust). |
| `DISCORD_WEBHOOK_URL` | — | Notify on dispatch start/end |
| `PYRY_LOG_RETENTION_DAYS` | `30` | Rotate logs older than N days; `0` disables |
| `OWNER_TYPE` | `user` | `user` or `organization` for GitHub Project owner |
| `PYRY_REAL_CLAUDE_GATE_CMD` | — | Shell command that runs the fork's live-claude suite. **Empty disables the gate entirely** and gated tickets park for an operator. See below. |
| `PYRY_REAL_CLAUDE_GATE_FORMAT` | `go-json` | How to read what the command wrote: `go-json` or `playwright-json` |
| `PYRY_REAL_CLAUDE_GATE_TIMEOUT_MS` | `1800000` | Outer wall clock for one gate run. Must exceed the command's own inner timeout. |
| `PYRY_REAL_CLAUDE_GATE_MIN_EXECUTED` | `1` | Floor for the executed-test guard. Set near the suite's real count. |

> **Load order.** `dotenv` now loads the fork's `.env` before any module-top constant reads `process.env`, so every variable in this table works from the file. Before 2026-08-07 the load sat below several of those reads, and `TARGET_REPO_PATH`, `TARGET_DEFAULT_BRANCH`, `SALVAGE_GATES` and `PYRY_AUTOCURATE_MEMORY` were silently file-blind — each fork's launcher pre-exported `TARGET_REPO_PATH` to work around it. Values a launcher exports, or that `op run --env-file` injects, still take precedence over the file.

### Real-claude gate

Some tickets can only be accepted by running against real claude rather than the pipeline's fakes. The PO marks them `needs-real-claude` during refinement. After code review such a ticket is parked in Inbox, and if this fork sets `PYRY_REAL_CLAUDE_GATE_CMD` the dispatcher then runs the suite itself, once per cycle, before it picks any other ticket.

**What it does per run.** Fetches, resolves the branch from `origin` only, records how many commits behind the base branch it is, probes for conflicts with `git merge-tree --write-tree` before touching the disk, creates a **detached** worktree at the head commit, merges the base branch into it, runs the command, then judges by reading the output file back off disk. The worktree is removed either way. Both log files end in `.log`, so the existing rotation sweeps them.

**Outcomes.**

| Verdict | Board | Labels | Discord |
|---|---|---|---|
| pass | → In Documentation | removes `needs-real-claude` | no |
| fail | → In Development | adds `needs-rework:developer`, **keeps** `needs-real-claude` | no |
| nothing executed | stays in Inbox | adds `error:real-claude-gate` | yes |
| no usable result | stays in Inbox | adds `error:real-claude-gate` | yes |

A failure keeps `needs-real-claude` so the ticket must pass the gate again after the fix; `runReworkRouting` strips the stale `done:*` trail and brings its three-strike breaker along. Environment failures park rather than routing to the developer agent, which could not fix a missing credential and would burn three spawns discovering that. The `error:` prefix already excludes a ticket from the WIP count and from gate re-selection, so the park is self-limiting.

**The command must emit per-test JSON.** For Go that means:

```sh
PYRY_REAL_CLAUDE_GATE_CMD='go test -tags e2e_realclaude -timeout 20m -json ./internal/e2e/realclaude/...'
PYRY_REAL_CLAUDE_GATE_MIN_EXECUTED=150
```

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
```

307 tests; runs under Node 25 with TypeScript 6 + tsx.

## Status

Pre-1.0. Default branch + salvage gates are now config-driven via env vars (`TARGET_DEFAULT_BRANCH`, `SALVAGE_GATES`). The 5-agent pipeline (PO / architect / developer / code-review / documentation) is still hardcoded — making it overridable via an `agents-config.json` in each consumer's agents repo is the next planned change, deferred until a consumer with a different pipeline shape actually shows up (per "evidence-based fix selection" — don't build for hypothetical needs).

## License

Apache-2.0.
