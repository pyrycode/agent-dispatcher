#!/usr/bin/env bash
# Install the dispatcher's dependencies for a launcher that runs unattended.
#
# Launchers call this from `bin/pyry-start` instead of `pnpm install --silent`.
# That line runs under `set -e` with no terminal attached, and on 2026-10-13
# it stopped a dispatcher container with status 1 and no message, 139 times
# over, on pyrybox's Desktop pipeline. Commit 9851390 had moved the pnpm store
# into the checkout (`.npmrc`, `store-dir=.pnpm-store`). An existing
# node_modules still pointed at the old store, so pnpm wanted to ask before
# removing it, could not ask without a terminal, and `--silent` hid why.
#
# Here the install is unattended (CI=true, stdin closed), the lockfile is
# frozen, the store switch is accepted (also `confirmModulesPurge: false` in
# pnpm-workspace.yaml), and a failure prints pnpm's own output and one line
# saying what failed. HP and Fractal's container entrypoints already install
# with `CI=true pnpm --dir <dispatcher> install` before `pyry-start`; this is
# the same approach inside the dispatcher.
set -uo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log() { echo "[dispatcher install] $*" >&2; }

output="$(CI=true pnpm --dir "$dir" install --frozen-lockfile --reporter=append-only </dev/null 2>&1)"
status=$?
if [ "$status" -ne 0 ]; then
  printf '%s\n' "$output" >&2
  log "pnpm install failed with status $status in $dir; the dispatcher cannot start until it succeeds"
  exit "$status"
fi
