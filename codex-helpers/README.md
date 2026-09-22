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

Edit `pipeline-action` here, never the installed copies; the next install
overwrites them. The source copy refuses to run.

## Test

```sh
pnpm test:helpers
```

The tests run against a rendered copy of each pipeline. The last test checks
Codex's installed rules: direct comment and label-edit commands stay unapproved
while the helper is allowed. It is skipped on a machine without Codex.

## GitHub budget

A column move reads the board and its Status options in one query costing 1
GraphQL point. Before 2026-09-22 each move listed every field on the board,
about 100 points, which made column moves the largest drain on the shared
hourly budget.
