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

Each transition is gated by a `ready:<agent>` label, advanced automatically when the previous agent finishes. Failures route via `needs-rework:<agent>` (back to that agent) or `error:<agent>` (held for human triage).

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
