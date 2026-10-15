# Scoped inherited-failure exceptions

The existing second-sighting flake rule, recent-tracker reopen and noisy-run
grouping stay in place. A tracker alone no longer excuses an inherited failure.

Both verifier and live-gate acceptance require an approved exception outside the
ticket checkout. The branch and exact baseline must contain the same nonempty
failure diagnostic. Test names alone cannot establish this. Missing baseline
reports, changed assertions, an expired exception or a changed environment keep
the gate red. Required acceptance cases still run and pass before this path.

Trackers are still reused or filed as one shared problem. An unapproved failure
parks without adding a dependency chain. It is not converted into product rework.
A sweep with only test names cannot supply the required diagnostic comparison.

## Protected policy

Store gate-exceptions.json in the protected agents repository or set
PYRY_GATE_EXCEPTIONS_FILE to a protected file outside product checkouts.
Start with an empty policy:

```json
{"version":1,"exceptions":[]}
```

After Juhana approves one retained failure, add one record with these exact fields:

- project: the repository.
- gate: the exact configured command.
- test: the complete test identity.
- tracker: the existing open shared-failure ticket number.
- signature: SHA-256 of the retained nonempty diagnostic.
- environment: the gate environment fingerprint.
- approvedBy: Juhana.
- approvedAt and expiresAt: ISO times with Helsinki's current offset.
- allowedPaths: exact files or directory prefixes for unrelated changes.

The expiry cannot exceed seven days from approval. No wildcard or whole-repository
scope is accepted. Security-sensitive tickets, security failures and security-related changed paths cannot
use an automatic exception. A ticket which names or owns the failed test still
keeps responsibility for its repair.

The signature and environment helpers are exported from src/gate-exceptions.ts
for the protected operator's preparation. They emit hashes rather than diagnostic
text. Preserve both raw reports and the exact baseline revision with the approval.
Review paths by behaviour as well as file overlap. A protocol or fixture migration
is part of that change's acceptance. The 262 failures from Desktop 1908 cannot be
waived as inherited noise. That ticket is refused explicitly even if a policy
record would otherwise match.

Roll out this policy together with approved narrow records for any currently
accepted failures. Missing policy fails closed. Confirm the same known failure
advances within scope, a changed assertion blocks and an expired record blocks.
Use the Core gate-tier follow-up so a red early tier never hides later checks.
No repository settings, live exception records or workflow state changed here.
