# Guarded controller releases

Approve the exact reviewed commit before using this procedure. It changes the
controller target. It never merges code, advances a consumer pin, restarts a
service or edits an operator drain.

1. Roll out the automatic repair restriction first. Retire the hand-written
   target setters. They bypass the release checks.
2. Add `releaseBackups` to the protected claims configuration. Use a dedicated
   private directory: `/home/pyry/pyrycode-runtime/fleet/release-backups`.
   This configuration change and its rollout require Juhana's separate approval.
3. Read `operator.sh control` and `operator.sh release`. Resolve any unfinished
   release before preparing another one. Preserve the reported desired target.
4. Save the following request privately. Replace the two revisions with full
   commit hashes. Use null only when the current target is absent.

```json
{
  "commandId": "approved-controller-release-1",
  "revision": "REVIEWED_FULL_COMMIT_HASH",
  "expected": "CURRENT_FULL_TARGET_HASH",
  "reason": "Juhana approved this exact reviewed release"
}
```

5. Run `operator.sh release set REQUEST.json`. The service makes a consistent
   private database backup, checks its integrity, compares the expected target
   and records the release with its target change in one transaction.
   A stale target, another pending release or backup failure refuses selection.
   A retry with the same request returns the saved result.
6. Use the existing supervised rollout. Keep saved computer and project drains
   and stops. Run the selected runtime's acceptance check on one Linux worker,
   then proceed one computer at a time. Confirm the Mac after its next connection.
7. Read the release and controller reports. Once the central service and every
   configured controller report that exact source, run
   `operator.sh release complete COMMAND_ID`. This permits the next release.
   Source acknowledgement does not replace runtime acceptance.

A failed rollout stays pending. Keep admissions held while diagnosing it.
Do not edit the target directly to escape the pending release. A rollback needs
its own reviewed plan and Juhana's approval. Never restore the pre-release
backup over newer workflow history.

The command-line drain now requires `--machine MACHINE` or `--all-machines`.
Both use saved central state. The old manager endpoint and rollback mirrors stay
until all managers have migrated and a rollback window has passed. Removing them
is deferred because this session cannot establish migration by changing the live
fleet. Confirm all four saved documents before retiring those paths.

Queued task cancellation is covered by the earlier repair-restriction change.
No live configuration, target, service or pin was changed by this pull request.

The package-level drain entry also refuses. Its former local process signal does
not save fleet intent. Use the protected central command with a machine selection.
