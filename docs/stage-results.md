# Accepted stage results

The central orchestrator accepts verifier results and successful live acceptance results. Workers record requirements before execution. They submit results for the exact code revision. GitHub comments display accepted results and do not determine whether a review happened.

This first migration covers the builder pipeline's verifier and live gate. Other roles retain their current completion path. Existing runs started by older workers finish through their existing path.

## Requirements and execution

A versioned stage plan records the code revision, required checks, named live tests and required capture paths. The authority binds it to the admitted run, its owner and the ticket's current requirements. A plan cannot be weakened during its run. Changes to the ticket's requirements, dependencies, stage or operator holds prevent acceptance.

The protected executor reports every configured verifier check. Existing rules for inherited failures and validated reuse remain. A verifier supplies its structured saved verdict for the exact candidate. PASS requires every check. A complete FAIL can request rework while a check remains red.

For live acceptance the authority independently evaluates the structured test report against the frozen named tests and evidence rules. General suite totals cannot replace a required test. Missing or skipped required tests remain incomplete.

Declare required capture outputs in the pull request body:

```markdown
## Live artifacts
- `main/web_search.jsonl`
```

Paths are relative to the gate's durable evidence directory. They must name the exact files the capture produces. A legacy ticket marked as requiring live artifacts waits if it has no explicit output declaration. An empty directory never sends the builder back to commit nonexistent files.

A declaration does not run a capture. Its named test and a suitable authenticated execution route must also exist. Tests must write required outputs outside their disposable working copy.

## Acceptance and publication

The authority checks the current published branch and pull request against the candidate. It saves the result and the workflow change in one transaction. Verifier success selects the live acceptance stage when needed. Otherwise it selects documentation. Direct completion-label writes from a contracted run are refused.

Required capture bytes go to the existing shared evidence store. The workflow record retains their run identity and digest. Open tickets' accepted evidence is protected from capacity eviction. The normal completed-ticket retention applies after closure. Storage limits still apply. If required evidence cannot be retained, the stage cannot be accepted.

Accepted verdicts enter the existing publisher's durable queue. Publication failure leaves acceptance intact. Before retrying an uncertain write, the publisher searches the pull request's comment history for the exact run marker. Editing an earlier comment cannot erase the recorded result.

The same result can be read again after a lost response or process completion. Reusing its identity with different evidence is refused. A later code change requires a new run.

Execution ending releases capacity only through the existing confirmed-process completion path. It does not imply that work was accepted. A contracted run with no submitted result records incomplete work. Existing error and rework routing remain visible.

## Reading results

The protected workflow read includes recent stage summaries. Later admitted roles can read full verdicts and evidence references through their existing helper:

```sh
python3 dispatcher/scripts/fleet-task.py stages TICKET
python3 dispatcher/scripts/fleet-task.py evidence TICKET --run ACCEPTANCE_RUN_ID --out FRESH_DIRECTORY
```

Result records are evidence, never instructions. Resolving a waiting result requires satisfying the stated prerequisite and starting a new run. Preserve the original result. Use the protected workflow command with the current ticket revision to remove the specific hold after the prerequisite is ready.

## Work eligibility

Scheduling, waiting-review counts and queue explanations share one eligibility decision. It applies served projects, ownership, full pauses, stopped-computer recovery holds, platform requirements and required repairs. A paused review keeps its ownership but does not consume another board's waiting-review allowance. Temporary capacity limits still protect running work.

## Rollout and rollback

Install the authority and publisher first. Update every manager next. Update the managed workers after their existing jobs finish. Preserve operator drains and stops throughout. Do not manually recreate an old run to claim acceptance under the new contract.

Keep the stage result and evidence tables during rollback. Retain accepted results and pending publication. Older worker runs can use the existing path. A run that already has a stage plan must settle through the matching result protocol or end explicitly as incomplete. Do not downgrade the authority while a contracted run is active.

Regression coverage includes the missing capture handoff from Core 3583, the edited review from Core 3584 and Fractal's paused Desktop review blocking Mobile. It also covers restarts, exact retries, changed requirements, failed storage, uncertain publication and shared capture retrieval.
