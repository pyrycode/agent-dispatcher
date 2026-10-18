# Periodic storage maintenance

The fleet supervisor calls `StorageSupervisor(adapter, config, config_path).tick()`.
The call reads one bounded result file and starts a background worker when due.
It performs no Git commands, network requests or filesystem traversal in the
native watchdog loop. The worker waits for a launch byte after recording its
process identity. EOF before that byte prevents maintenance from starting.

The worker holds an exclusive local maintenance lock. It reads authoritative
closed tickets through the protected operator. It inspects only registered Git
working copies under each configured target's dispatcher directory. A matching
role and ticket directory and `feature/N` branch are required. Manual directories,
detached copies and open tickets are excluded. Container-created Linux copies
whose registrations use container paths are reported held. Their registrations
are never rewritten to make host cleanup work.

Every copy remains on disk. Only proven disposable generated files are eligible.
Source, commits, branches, reviews, original logs and unique failure evidence stay.
A read-only audit happens first. Clean or held copies create no central lease.
For an eligible change, the worker acquires a durable central ticket lease and
rechecks its exact ticket, path and commit before every destructive authority
check. Changed workflow scope, ownership or controls stop cleanup. The protected
authority enforces closed leaf completion, holds, drains and absent workers.
The local process census additionally refuses active or uncertain users.

The Go cache has a separate machine lease. The worker must hold the existing
test-admission lock and confirm native descendant drainage before acquiring it.
An old receipt marked complete without explicit `drainConfirmed` remains held.
No completion state is invented to clear that hold. The cache module trims only
verified ordinary compiled artifacts through held directory descriptors. Fuzz
corpora, executable cache directories, unknown contents and failed evidence stay.
There is no full cache clear and no cleanup after each ticket.

All deletion is synchronous in the maintenance process. After a crash, a new
worker must acquire the same local lock before reconciling durable lease UUIDs
with the protected cancellation operation. This finishes the exact saved lease
or records a finished tombstone before a delayed acquisition can arrive. Lost
acquire and finish replies retain their journal until this settlement succeeds.
The operation never reacquires a different or newly unauthorised scope.
An old external-command
journal remains held for independent custody proof. Leases never expire while
deletion could still run. Releasing a storage lease does not alter operator holds,
worker reservations or project drains.

Optional supervisor configuration:

```json
{
  "storageMaintenance": {
    "enabled": true,
    "copyIntervalSeconds": 300,
    "cacheIntervalSeconds": 3600,
    "batch": 8,
    "testAdmissionLock": "/home/operator/.local/share/pyry-fleet/test-admission.lock",
    "goCache": {
      "enabled": true,
      "cache": "/home/operator/.cache/go-build",
      "maxBytes": 17179869184,
      "reserveBytes": 21474836480,
      "timeoutSeconds": 600
    }
  }
}
```

The default selective copy sweep is every 300 seconds with a batch of eight.
Persistent round-robin progress prevents held or unchanged early copies from
starving later copies. Newly eligible copies are prioritised. The cache check is
hourly when `goCache` is configured. Its default maximum is 16 GiB with a 20 GiB
free-space reserve. These configurable limits keep substantial warm cache while
leaving space for observed 15 to 22 GB checks. The exact existing admission lock
defaults to `PYRY_TEST_ADMISSION_LOCK`, then
`~/.local/share/pyry-fleet/test-admission.lock`. A missing lock refuses cache apply.

`python3 scripts/fleet-storage-maintenance.py CONFIG --audit` inspects without
cleanup or central lease mutation. `CONFIG --run --apply` performs a protected
catch-up pass. `CONFIG --run` is also read-only. Configuration must not be writable
by another user. Operational receipts live under `stateDirectory/storage`.
The main supervisor receives at most 20 bounded summaries from the latest pass.
Successful repeated clean audits reuse their progress and latest receipts.
Per-lease authority request files are reused across repeated guard checks.
Failed attempts and durable lease records are preserved for investigation.
