# Free space before new work

The Mac exhausted its data volume while workers were running on 2026-10-18.
New disk admission checks pause further compilation and tests before reserving
them. They preserve current workers, durable reservations, ownership, operator
holds, project drains and desired run settings.

Set the same explicit policy in the saved manager configuration and native
supervisor configuration. The production manager command passes this saved
field into its scheduler. The native supervisor reads its own field immediately
before launching a newly admitted task.

```json
{
  "diskAdmission": {
    "path": "/Users/operator",
    "minFreeBytes": 21474836480
  }
}
```

Use an existing directory on the filesystem holding the working copies and
build caches. The Mac deployment uses a 20 GiB start floor. The amount and path
are configurable. Other deployments retain previous behaviour when the policy
is absent. An invalid configured policy or an unreadable filesystem does not
authorise a new heavy start.

The manager reads available filesystem space before every new medium or heavy
reservation. Builder, developer and verification stages also require this check
when an older dispatcher describes them as light. Both ordinary scheduling and
target verification transfers apply the check. A concurrent tick shares the
same scheduling pass. Each subsequent candidate receives a new observation.
This does not reuse one free-space reading for a group of new starts.

Low or unconfirmed space appears as `waiting-storage` in the queue. The manager
reports the configured path, floor, observed available bytes and reason. Light
lifecycle work remains eligible. The fixed native platform probe is also light.
The manager and native launcher retry naturally on later polls. Heavy work can
start again once space reaches the configured floor. No operator control needs
to be cleared or rewritten.

A native grant may already exist when space drops. The supervisor retains that
grant and records a storage deferral before starting a worker. It rechecks before
a later launch. Receipt-backed workers continue through their existing observation
and publication flow. They are never stopped or released because space is low.

This is a start floor. Existing workers can continue writing after it is checked.
It neither reserves disk bytes nor guarantees that running work cannot fill the
volume. Reclaiming safely classified generated output is a separate maintenance
operation. Disk admission never deletes data or bypasses evidence holds.
