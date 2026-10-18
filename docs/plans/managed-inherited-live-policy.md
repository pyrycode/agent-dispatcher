# Managed live inherited-failure policy

## Observed defect

The live executor freezes `inheritedAdvance` using an exact `=== "1"` check,
while the established `inheritedAdvanceEnabled` policy defaults on and accepts
all values except `0`, `false`, `off` and `no`. Core #3603's current immutable
LIVE record froze false with the setting absent despite its startup banner
reporting inherited advancement enabled. Existing records remain unchanged.

## Change

Use the canonical policy reader when the managed executor constructs its stage
plan. No configuration, acceptance requirement, gate ordering, workflow mutation
or permission boundary changes. Only newly admitted plans use the correction.

## Verification and security

Before implementation, exercise `runRealClaudeGateSuite` inside actual managed
admission and inspect the plan frozen by the workflow authority for unset,
enabled and disabled settings. Prove through the same frozen plan that declared
unrelated failures can follow the existing policy while a failed mandatory named
test still cannot be accepted. Authoritative OPEN-tracker validation remains a
separate, unchanged FleetStore guard. Retain RED then GREEN results, run the relevant
existing gate/stage tests and TypeScript checking. Independent review precedes
publication; complete dispatcher checks and rollout remain separately owned.

This reuses the existing boolean policy, never ticket text as authorisation.
Required-test, evidence, candidate, ownership and original-failure guards remain.
No credentials or private test contents enter the regression or diagnostics.

## Verification record

The real managed endpoint regression first failed for unset and `on`; the other
three settings passed. After the one-expression correction all five passed
(six test events including their parent, zero failed or skipped). Existing gate
executor checks passed 56/56 and stage/inherited-ticket checks passed 65/65;
TypeScript checking passed. These synthetic checks are not live product proof.
