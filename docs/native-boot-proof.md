# Native task drainage after a future reboot

Some retained native task receipts predate descendant tracking. Their completed
status does not prove that their child processes stopped. The storage guard
continues to hold those records during the same boot.

The supervisor can retain one write-once companion witness for each such task
before a future reboot. The archive is
`stateDirectory/native-boot-proofs/<task-id>.json`. It contains the exact original
receipt bytes, their SHA-256, the configured machine, canonical receipt and task
paths, the observation time, and the kernel boot identity and time. A hash of
the Mac's hardware identity binds it to the same physical computer. The hardware
identifier itself is not retained.

The first witness is never replaced. Repeated observations cannot grow a history
per task. If the receipt later changes, its old witness no longer proves that
record. It remains held for operator assessment.

A proof is accepted only when the same physical Mac has a different kernel boot
identity and its new boot started strictly after the witness was saved. The
receipt bytes, configured machine and canonical paths must still match exactly.
A receipt first observed after a reboot cannot certify itself. Missing kernel
data, the same boot, a backward clock, changed records, corrupt archives and
symbolic links leave drainage unproved.

Terminal records are witnessed after any successful artifact recovery updates.
An attention record with no result is witnessed only after its ordinary custody
observation cannot establish drainage. Ordinary tracked tasks which settle
through existing descendant tracking do not create boot witnesses.

`fleet-boot-proof.py` exposes `check(receipt, machine, prepare=False)` for read-only
consumers. Preparation is performed by the native supervisor. It does not change
the original receipt. Kernel observations come from macOS `kern.boottime`,
`kern.bootsessionuuid` and `IOPlatformUUID`. There is no reboot command or cache
deletion in this helper.

For a native task with no result, a positive existing worker and command-group
drainage proof, or a valid companion boot proof, allows the existing interruption
operation to report a failed task. Its original files remain. A lost response
retries the same saved failed result. This never turns a missing result into a
pass.

The storage guard can consume a companion proof without rewriting old terminal
history. Central machine idleness, active task reservations, operator holds,
drains, process inventory and the exclusive storage lease remain separate
requirements. A reboot proof does not release claims or authorise cleanup by
itself. Deployment does not restart the Mac.
