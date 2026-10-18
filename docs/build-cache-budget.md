# Go build-cache disk budget

The native supervisor can reclaim disposable Go build artifacts when their
configured byte budget is exceeded or free space falls below a configured
reserve. This is periodic space management. It does not clear the cache after
each ticket.

Linux and macOS use the same descriptor-relative trimming code. It removes
only the oldest individually verified ordinary cache files until the budget and
free-space reserve are met. It never runs `go clean` or recursively removes a
cache bucket. A failure capture appearing after inspection therefore remains.

Each data file must match the SHA-256 named in its filename. Action records must
match Go's versioned format and their own action identity. Corrupt or unknown
records, executable output directories and hardlinked artifacts remain. The
next build may take longer because removed products need rebuilding. Source,
module downloads and fuzz inputs are outside this cleanup.

## Exclusive authority

Import `scripts/fleet-build-cache.py` and call `manage_cache` from the protected
supervisor. There is no destructive command-line option. Its command line only
inspects a saved configuration.

The supervisor must hold its durable machine storage lease and the existing
shared native test-admission lock throughout the call. That lease blocks every
new local admission. It has no expiry while cleanup may be changing cache files.
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
confirmed idle custody do not establish safety. The manager checks the guard,
process inventory and cache inventory again immediately before execution.

## Configuration and receipts

All limits are explicit. There are no built-in byte budgets.

| Field | Meaning |
| --- | --- |
| `cache` | Canonical absolute path to the approved Go build cache |
| `maxBytes` | Positive maximum for compiled cache bytes |
| `reserveBytes` | Nonnegative minimum free bytes on that filesystem |
| `timeoutSeconds` | Positive maximum duration of the synchronous trim |
| `receipt` | Absolute receipt file outside the cache, required for apply |

`manage_cache` receives the configuration, guard callback and `apply` flag.
It has no command-runner callback. No external cleaner or child process runs.

The manager opens the inspected cache directory and checks its device and inode.
A local directory lock prevents concurrent cache managers. Both platforms open
buckets relative to the same held root. Each ordinary file's identity is checked
before and after verifying its content. Deletion names only that file through
its held bucket descriptor. A root rename or symlink replacement cannot redirect
deletion into another directory. New files are never swept up by a recursive
removal.

The manager saves a `cleaning` receipt before changing files. Fresh authority,
process checks and the configured duration bound are checked during a long trim.
An exception or interruption produces an `uncertain` receipt with
`releaseSafe: false`. An unfinished receipt blocks another apply at that path.
The manager never releases a lease. The supervisor must verify that the original
cleanup process is stopped and reassess retained custody before releasing the
lease or allowing another attempt. A process restart never treats the old
receipt as permission to repeat deletion.

Receipts contain the observed cache bytes, free space, configured limits,
trigger, synchronous operation and retained-file inventory fingerprints. `budgetMet`
and `reserveMet` remain separate. Preserved evidence can occupy space that this
manager is not authorised to reclaim.

## Preserved content and source evidence

The manager preserves the fuzz corpus, source trees, module downloads and
retained failed evidence. It recognises only Go's hexadecimal build-cache
buckets. Unknown files or symlinks inside those buckets prevent cleanup.
Cached executables use their own single-file output directories and count as
active users while running. A legacy `log.txt` remains as evidence and does not become a deletion target.

The implementation was checked against the installed Go 1.26.2 source:

- `cmd/go/internal/clean/clean.go` removes the hexadecimal buckets and
  `log.txt` for `-cache`. Fuzz cleanup is a separate flag.
- `cmd/go/internal/cache/cache.go` defines action and output entries, including
  cached executable directories. Its cache interface requires used outputs to
  remain available until the Go process closes. Recorded use times can lag by
  an hour, so an age threshold alone cannot establish that an entry is idle.
- `cmd/go/internal/cache/default.go` writes the build-cache README that the
  manager checks before accepting a configured directory.

The focused tests use temporary caches on both operating systems. They include
late failure evidence inside a cache bucket, corrupt hash-named data, invalid
action records, a real cached process, actual partial deletion interruption,
restart receipts, changed inventories, symlinks and preserved fuzz inputs.
