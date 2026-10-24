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

A builder's pending retained-evidence investigation queues a recovery assessment whenever its ticket changes. A PASS that resolves it, or explicitly accepts its remaining evidence limits, names it in the verdict handoff with an `investigations:` header line holding its 64-character identity. Accepting that PASS settles the named request in the same transaction. The request, its failures, the verdict and the reason stay retained as history. An unnamed request stays pending for its ordinary assessment. A FAIL, a different candidate, an approval refusal or a hold accepts nothing. Admission already refuses the verifier while an assessment or its diagnostic holds the ticket. A status, label or focused pass never settles a request. Mobile #2526 showed the gap: its PASS named the request in prose only, and the move to documentation queued recovery instead.

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

### Recovering undeclared capture outputs

A live stage can finish its tests and retain captures while waiting because its
plan declared no required capture paths. An operator can return that exact wait
to ordinary builder work without changing its original plan, result or verdict:

```sh
operator.sh workflow declaration-repair owner/repo declaration-repair.json
```

```json
{
  "commandId": "declaration-repair-3620-1",
  "ticket": "owner/repo#3620",
  "revision": 12,
  "runId": "exact-ended-live-run",
  "candidate": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "pullRequest": 3621,
  "evidence": { "runId": "exact-ended-live-run", "digest": "RETAINED_BUNDLE_SHA256" },
  "captures": ["evidence/gate-runs/RUN/main/capture.jsonl"]
}
```

Read the current workflow revision, latest stage and retained bundle first. The
request binds to the open pull request and its published candidate. The source
execution must have ended normally with the same ticket ownership. Product runs
and queued, uncertain or running support work prevent the handoff. A newer stage,
changed requirements, another incomplete-result cause, missing or mismatched
capture bytes and an unresolved approval rejection also refuse it.

Raw gate bundles need their generated `run.json` inventory proving each selected
capture was retained whole. Logs, pointers, tails and redacted captures do not
qualify. A stage's own retained output reference is also supported. Existing
capture size and content bounds apply. The evidence remains pinned while the
ticket is open.

The handoff removes only the stage-result hold and completed builder/verifier
markers. It returns the ticket to In Development. Claims, retry counts, unrelated
holds, drains and approval history remain. Ordinary admission still checks those
controls. The builder corrects the PR declarations and commits the retained bytes.
Normal review and live acceptance must follow. This handoff grants neither.

Repeat an uncertain request with the same command identity and exact fields.
Its durable response survives service restart, later work and branch movement.
Changing a field under that identity is refused. Workflow and receipt storage
commit together. The original waiting result stays unchanged.

## Work eligibility

Scheduling, runnable-ticket counts, waiting-review counts and queue explanations share one eligibility decision. It applies served projects, ownership, full pauses, stopped-computer recovery holds, platform requirements and required repairs. A paused review keeps its ownership but does not consume another board's allowance. Actual running jobs still count toward capacity until their processes have stopped. Temporary capacity limits still protect running work.

## Rollout and rollback

Install the authority and publisher first. Update every manager next. Update the managed workers after their existing jobs finish. Preserve operator drains and stops throughout. Do not manually recreate an old run to claim acceptance under the new contract.

Keep the stage result and evidence tables during rollback. Retain accepted results and pending publication. Older worker runs can use the existing path. A run that already has a stage plan must settle through the matching result protocol or end explicitly as incomplete. Do not downgrade the authority while a contracted run is active.

Regression coverage includes the missing capture handoff from Core 3583, the edited review from Core 3584 and Fractal's paused Desktop review blocking Mobile. It also covers restarts, exact retries, changed requirements, failed storage, uncertain publication and shared capture retrieval.
