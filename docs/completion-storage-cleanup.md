# Storage after ticket completion

Ticket closure previously removed workflow labels but did not catch up working
copies retained on other computers. A failed removal also preserved the whole
copy. The native supervisor now revisits registered dispatcher working copies
and selectively reclaims generated files from completed tickets.

The source copy and every branch remain. Cleanup does not run Git removal,
pruning, reset or clean commands. It never treats a central evidence summary
as an archive of all local evidence.

## Eligible content

Only ignored files in explicitly recognised generated locations can be removed.
These include the codegraph database and selected compiled Android classes,
archives and native objects. A generated location containing an unexpected file
is retained for inspection. The whole build directory is never a cleanup target.
Failure reports, transcripts, logcat, test results, configuration and unknown
files remain. Dirty source, hidden index flags, submodules, unfinished Git
operations and symlinks prevent the affected cleanup. Removing a generated
file's hardlink leaves its other links and their bytes intact. Cache budgeting
retains hardlinked entries altogether.

The central workflow must say both closed and Done. Any ticket hold, failed
stage, pending publication, affected worker or unfinished support task prevents
cleanup. Split parents are always retained. Closing a parent does not complete
the feature or authorise disposal of its evidence.

## Admission and custody

The protected operator acquires a durable storage lease before reclamation.
The claim service blocks new admissions for that ticket on every computer,
including native support tasks and verifier handoffs. Unrelated tickets remain
eligible. Existing owner generations, controls, holds and dependencies are not
changed.

Each lease binds the computer, ticket, canonical working-copy path and exact
commit. The local driver must compare those fields before treating a central
reply as authority. It also checks the registered copy, source state and local
process custody. Authority is checked again during deletion. Directory
descriptors and inode comparisons prevent a swapped path from redirecting
deletion into another directory.

An operator drain or ownership change invalidates a prior cleanup observation.
The lease remains until cleanup execution has certainly stopped. There is no
timeout that silently reopens admission while deletion might still be running.
Partial results retain the number of bytes already reclaimed and all evidence.

## Operator protocol

Use the installed protected operator wrapper. Worker credentials cannot use
these operations.

```sh
operator.sh storage list
operator.sh storage acquire /absolute/path/request.json
operator.sh storage verify /absolute/path/verification.json
operator.sh storage finish /absolute/path/completion.json
```

A ticket request contains `id`, `machine`, `kind: "ticket"`, `ticket`, `path`
and `head`. The identifier is a fresh UUID. A cache request uses `kind: "cache"`
and omits `ticket` and `head`. Verification contains the same `id` and `machine`.
Completion also contains `drained: true` and `result`, one of `complete`, `held`
or `aborted`.

These commands provide admission exclusion. They do not inspect the local
filesystem or delete files. Use the supervisor driver for the complete local
protocol. Do not manually finish a lease based solely on elapsed time or an
apparently absent parent process. Prove its saved child identity and descendants
have exited first. Retrying the same acquisition is safe. Changed request
contents are rejected. A completed identifier cannot acquire again. Retrying an
old completion cannot release a newer lease.

Machine-wide Go cache budgeting follows a stricter protocol documented in
[Go build-cache disk budget](build-cache-budget.md). It requires no active or
uncertain machine work and holds the existing shared test-admission lock.
An old native receipt lacking drainage proof is not a positive idle signal.

Storage observations appear alongside normal supervisor operation reports.
Malformed or unavailable storage observations cannot suppress existing control
and worker-custody reports. A maintenance failure is reported as held and does
not restart, release or resume a worker.

Container paths need their own proven route. A Git registration that names a
container path cannot be translated into a host path and then treated as an
ordinary local working copy. The initial driver reports those copies as held.
It leaves their source, evidence and container work untouched.

## Deployment

Deploy through the existing protected controller target. The supervisor and
claim service share this repository. Dispatcher consumers do not require a
new pin because cleanup does not change worker code. Preserve saved desired
controls and original active reservations when checking the rollout. Audit
local failure-evidence hashes and branches before and after the first apply.
