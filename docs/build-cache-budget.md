# Go build-cache disk budget

The native supervisor can reclaim disposable Go build artifacts when their
configured byte budget is exceeded or free space falls below a configured
reserve. This is periodic space management. It does not clear the cache after
each ticket.

The manager uses the supported `go clean -cache` command. The next build may
take longer because its compiled artifacts need rebuilding. It never invokes
`-modcache`, `-fuzzcache` or package cleanup.

## Exclusive authority

Import `scripts/fleet-build-cache.py` and call `manage_cache` from the protected
supervisor. There is no destructive command-line option. Its command line only
inspects a saved configuration.

The supervisor must hold its durable machine storage lease and the existing
shared native test-admission lock throughout the call. That lease blocks every
new local admission. It has no expiry while a destructive command may run.
An idle observation alone is insufficient.

The guard callback returns these checked fields:

| Field | Required value |
| --- | --- |
| `allowed` | `true` after fresh machine and local custody checks |
| `exclusive` | `true` for the caller's exclusive machine lease |
| `lease` | The same UUID throughout the operation |
| `custody` | `drained` for all earlier native commands |
| `admissionHeld` | `true` while the actual shared test lock remains held |

Missing process records, active Go tools, running cached executables, an active
worker or uncertain native descendants prevent cleanup. Old receipts with no
confirmed drainage do not establish safety. The manager checks the guard,
process inventory and cache inventory again immediately before execution.

## Configuration and receipts

All limits are explicit. There are no built-in byte budgets.

| Field | Meaning |
| --- | --- |
| `cache` | Canonical absolute path to the approved Go build cache |
| `go` | Absolute path to the approved Go executable |
| `maxBytes` | Positive maximum for compiled cache bytes |
| `reserveBytes` | Nonnegative minimum free bytes on that filesystem |
| `timeoutSeconds` | Positive timeout passed to the durable command runner |
| `receipt` | Absolute receipt file outside the cache, required for apply |

`manage_cache` receives the configuration, guard callback and `apply` flag.
Its `run_command` callback receives the fixed argument list plus `cwd`, `env`,
`timeout` and `journal`. The journal path is the receipt path followed by
`.command.json`.

The runner must save the child's process identity before permitting execution.
It must reuse the existing custody machinery after a timeout or interrupted
supervisor. It returns a numeric `returncode` and `custody: drained` only after
all its descendants have exited. Its saved journal must prevent an uncertain
command from being launched again.

The manager saves a receipt before calling the runner. An exception or missing
drainage produces an `uncertain` receipt with `releaseSafe: false`. An unfinished
receipt blocks another apply at that path. The manager never releases a lease.
The supervisor must reconcile the original command and recheck the lease before
admitting any more work.

Receipts contain the observed cache bytes, free space, configured limits,
trigger, fixed command and retained-file inventory fingerprints. `budgetMet`
and `reserveMet` remain separate. Preserved evidence can occupy space that this
manager is not authorised to reclaim.

## Preserved content and source evidence

The manager preserves the fuzz corpus, source trees, module downloads and
retained failed evidence. It recognises only Go's hexadecimal build-cache
buckets. Unknown files or symlinks inside those buckets prevent cleanup.
Cached executables use their own single-file output directories and count as
active users while running. A legacy `log.txt` also prevents cleanup because the
supported Go command would remove it.

The implementation was checked against the installed Go 1.26.2 source:

- `cmd/go/internal/clean/clean.go` removes the hexadecimal buckets and
  `log.txt` for `-cache`. Fuzz cleanup is a separate flag.
- `cmd/go/internal/cache/cache.go` defines action and output entries, including
  cached executable directories. Its cache interface requires used outputs to
  remain available until the Go process closes. Recorded use times can lag by
  an hour, so an age threshold alone cannot establish that an entry is idle.
- `cmd/go/internal/cache/default.go` writes the build-cache README that the
  manager checks before accepting a configured directory.

The focused tests use temporary caches. They include the installed Go cleaner,
a real cached process, interrupted command receipts, changed cache inventories,
symlinks and preservation of failed fuzz inputs and source files.
