# Codex pipeline helpers

`pipeline-action` publishes to GitHub for one pipeline at a fixed destination:
pushes of the ticket branch, issue and pull request text, reviews, comments,
label edits, board membership, column moves and ordering, and ticket
relationships. Codex's rules on the dispatcher host approve it by its installed
path, and each fork's working-practice doc tells agents on either runner to use it.

It is installed once per pipeline:

| Pipeline | Repository | Board |
|---|---|---|
| `pyrycode` | pyrycode/pyrycode | 1 |
| `pyrycode-desktop` | pyrycode/pyrycode-desktop | 7 |
| `pyrycode-mobile` | pyrycode/pyrycode-mobile | 5 |

## Install

```sh
codex-helpers/install              # all three
codex-helpers/install pyrycode     # one
```

Each copy goes to `~/.codex/bin/<pipeline>-pipeline-action` with its pipeline
and home folder written in, so it reads nothing from the environment at run
time. The copies live outside every agent's working folder so agents cannot
edit an approved helper. The install runs the tests first and installs nothing
if they fail. It replaces each file in one step, so a running agent never reads
a half-written helper.

Trusted container provisioning can call `install_helpers(pipelines, compat_home,
destination)` from this installer to retain the fixed documented home while
installing into `/opt/codex-helpers`. It runs the same tests and atomic replacement
as the ordinary CLI. Workers still cannot edit their installed helpers.

Edit `pipeline-action` here, never the installed copies; the next install
overwrites them. The source copy refuses to run.

## Workflow actions need the bridge

Board membership, column moves, ordering and blockers are orchestrator
workflow. `board-add`, `board-status`, `board-after`, `add-blocker` and
`remove-blocker` run only when `gh` is
configured with the managed GitHub bridge's socket, as it is in every admitted
worker. Anywhere else they would edit the GitHub display directly, and
reconciliation would overwrite the change. Operators use the protected
operator command instead. Sub-issue links are GitHub content the orchestrator
reads back, so `add-child` and `remove-child` run anywhere.

## Test

```sh
pnpm test:helpers
```

The tests run against a rendered copy of each pipeline. The last test checks
Codex's installed pipeline rules, when present for the configured helper home:
direct comment and label-edit commands stay unapproved while the helper is
allowed. It is skipped without Codex or without that pipeline's rules. A build
host's unrelated board-watch policy is not a pipeline runner policy.

## GitHub budget

A column move reads the board and its Status options in one query costing 1
GraphQL point. Before 2026-09-22 each move listed every field on the board,
about 100 points, which made column moves the largest drain on the shared
hourly budget.

## Replacement split finalization

`split-inspect PARENT` returns a fresh complete family/revision template through
the managed bridge. Save it in the approved publishing directory, add a unique
`commandId` and `summary`, declare each child's earlier `dependsOn` prerequisites
and each existing dependent's required `children`, then run
`split-finalize PARENT ABSOLUTE_JSON_FILE`. Children stay in Inbox until that
single transaction activates them and closes the replaced parent. Retain the
same file/identity for an uncertain retry. A new inspection is required after
scope or workflow changes. These actions refuse an absent bridge, foreign run,
missing/truncated inventory, active affected work or an unresolved approval hold.

For a required repair that leaves its acceptance parent open, use
`required-repairs-inspect PARENT` and
`required-repairs-finalize PARENT ABSOLUTE_JSON_FILE`. Retain the complete
inspection inventory and ownership/revision fences, add `commandId` and
`summary`, and set `repairs` to the reviewed child numbers. Every named child
must remain an open blocker of its parent. The declaration only classifies the
planning hold; the creator must finish and all normal stage gates still apply.
See `docs/workflow-authority.md` for the protected finished-creator operator path.
