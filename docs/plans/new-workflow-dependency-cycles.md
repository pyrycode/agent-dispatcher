# Reject new known dependency cycles

## Observed defect and scope

An inherited failure selected aggregate #3602 as the lowest-numbered exact
tracker and added #3603→#3602 although #3602 already depended on #3603/#3604.
Central workflow mutation checks blocker shape but not reachability; GitHub
publishing rejects the cycle only after authoritative state changes.

## Prospective change

Within the existing WorkflowStore.change transaction, validate only newly
added repository/issue dependency identities. Resolve identity by the existing
URL repository/fallback convention. Reject new self edges and edges whose
known blocker path reaches the source, using a visited set. Traverse recorded
relationships regardless of displayed open/closed state; stop at unknown nodes.
Throw before item, revision, event or command writes. Preserve old receipt
replay, legacy edges, removals and unrelated mutations. No schema, tracker
selection, publisher repair or gate acceptance change.

## Verification and security

Before implementation, reproduce #3602→#3603/#3604 then #3603→#3602 against
the real authority. Require atomic unchanged state/labels/status/revisions,
events, publication state and receipts on rejection. Cover valid dependencies,
new self/longer/cross-repository cycles, repository-qualified identities,
legacy-cycle removals/unrelated updates and exact command replay. Exercise
recordInheritedTests with real authority linking and normal gate reconciliation;
rejected links remain untracked and an owned failed required test stays failed.
Retain RED/GREEN, run focused checks and TypeScript checking, obtain independent
review, then C's exact-source dispatcher full suite before publication.

Security: no credentials, payload logging, network dependency or new authority.
Only new invalid dependency requests fail; no historical graph migration occurs.
Documentation handoff: the maintained authority rule belongs with workflow docs.
