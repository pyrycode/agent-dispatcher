# Runtime records and coherent off-machine backups

Assumption awaiting Juhana: start with asynchronous backups every five minutes.
This accepts a loss window. A missed transfer, controller outage or slow copy can
make the recoverable point older. HP never acknowledges individual grants or
results. The acceptable loss window and off-machine storage remain his decisions.

## Per-run record

The existing agents repository holds defaults, computer overrides and the resolved
runtime record. Point PYRY_RUNTIME_RECORD_FILE at that protected installed record.
The evidence writer validates and freezes it at dispatcher startup. Every later
run bundle carries the same immutable identifiers until the next checked restart.
Invalid configured records refuse startup. Older unconfigured workers omit the
record and remain visibly unknown rather than claiming acceptance.

The record contains agents and testDaemon source revisions as 40-character Git
SHAs. It contains image, tools and gates as SHA-256 identifiers. Hash the exact
image identity, version inventory and resolved gate configuration. Preserve those
inventories in the release record. Native computers use a digest of their approved
native installation inventory in the image field. Do not substitute latest or
unknown. A hash is provenance, not proof of a secure runtime.

## Coherent snapshot

Configure backup.directory as a private local spool through an approved controller
release. The protected operator command is `pnpm fleet backup CONFIG`. It calls
one synchronous callback in the existing controller, the sole writer of the
claims and evidence databases. It snapshots both without yielding between them.
No server request, retention sweep or task publication can interleave. It checks
both databases and seals their hashes and sizes in one private manifest. Failed
snapshots remain in private .pending directories and cannot be copied as sealed
backups. No active run or saved control is changed.

This snapshot pauses the controller event loop while SQLite copies and checks the
data. Measure duration with a realistically sized evidence store before enabling
the timer. A slow snapshot is a rollout blocker. The off-machine transfer is
asynchronous. Do not trade coherent copies for two unrelated database snapshots.
Only this controller may write the live databases. An external writer invalidates
that invariant and must be removed before enabling this procedure.

## Ready-to-apply five-minute copy procedure

These are proposed operator actions. No directory, timer, SSH connection or live
configuration is created in this session.

1. Juhana approves HP storage at /home/pyry/fleet-backups/pyrybox. Provision a
   dedicated backup identity through the existing authentication mechanism. Give
   it create-only access to that destination. Do not share the fleet operator
   credential with HP. Use private directories and encrypted storage. Confirm
   available space and retention with Juhana before scheduling.
2. Configure pyrybox's private spool as
   /home/pyry/pyrycode-runtime/fleet/backup-spool. Add only backup.directory to the
   controller configuration through the guarded release. Do not restart from this
   document. Run the command through the existing protected operator helper.
3. An existing service scheduler invokes the protected backup command every five
   minutes with a single-instance lock. Use OnCalendar=*-*-* *:0/5:00 Europe/Helsinki and
   Persistent=true for an approved systemd timer. The expression was checked
   locally with systemd-analyze calendar. Its job first creates one sealed
   snapshot. Read its directory from the JSON result. Accept only a direct
   non-symlink fleet-* child of the configured spool with manifest.json present.
4. Copy that whole directory to a new private .incoming directory on HP with
   rsync --archive --protect-args. Do not use --delete. Verify every manifest hash
   there. Rename .incoming to the sealed directory name only after verification.
   A transfer error retains both the local snapshot and the incomplete remote
   copy. It never changes fleet admission or deletes an earlier recovery point.
5. Run the isolated restore checker on HP after a copy and at least daily. Use
   `python3 scripts/fleet-restore-check.py SEALED NEW_ISOLATED_DIRECTORY`. It checks
   full database integrity, evidence-to-run references and every committed file's
   chunk and whole-file hash. It creates a hold before copying. A failed check
   leaves any copied data held. Its report contains counts and Helsinki time.
6. The claims entrypoint refuses an authority beside RESTORE_HOLD.json. Never
   remove that hold to run a test. A real restore requires stopping and accounting
   for every old worker first, then an approved reconciliation and a fresh private
   configuration. Never start a second authority against the same boards.
7. Check latest successful off-machine restore age in the existing attention
   procedure. A point older than the approved loss window needs human attention.
   Select retention only after a successful restore. Never prune the only checked
   recovery point. No new backup daemon or dashboard is needed.

## Runtime acceptance before release completion

Run `python3 scripts/runtime-acceptance.py PROTECTED_CONFIG` through existing
exclusive admission in the actual execution account. The configuration requires
a directory, disposableStartup and platformProbe as explicit argument arrays.
There is no live startup default. The startup command must use disposable manager,
controller, work and evidence paths with network access limited to loopback.
It must test unattended authentication and the installed launcher. The platform
command must check the exact required daemon or emulator revision from the record.
The runner reuses the existing native-command supervisor and its saved process
identities. It keeps command output and custody receipts private. Its result
reports only statuses, receipt location and Helsinki time. Unconfirmed cleanup
cannot pass. It never restarts a live service.

Linux acceptance does not establish native Mac readiness. Keep the Mac native-only
until its restricted account and platform checks pass. Capture the bounded result
through existing run evidence. Guarded release completion follows successful
acceptance and exact controller acknowledgements. On failure keep the release
pending and new admission drained. Do not move pins or targets from this job.

Scheduling reference: [systemd calendar syntax](https://github.com/systemd/systemd/blob/main/man/systemd.time.xml) and [timer persistence](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml).
