# Builder test scope

Builders run affected tests, classes, packages or one scripted scenario. The dispatcher owns complete acceptance and release suites. Ticket wording cannot grant a builder a complete suite. A named Core regression remains available even when it is expensive.

The shared selection policy runs before managed host or device admission. Mobile checks both its product forwarding path and canonical helpers. Its raw Gradle wrapper checks selection before Java starts. Newly admitted Core Codex builders also receive a typed Go launcher on their managed command path. Their generated invocation sets `allow_login_shell=false`, so default shell tools preserve that path and explicit `login=true` tool requests are refused. Claude builders use the explicitly guarded product admission launcher. Its raw Bash path has not been established as guarded. Explicit absolute Go binaries, edited paths or launchers, manually nested login shells and arbitrary unmanaged shell paths are outside this managed-entrypoint guarantee. This is an execution policy, not a sandbox security boundary.

The policy reads a dispatcher-created binding in Git worktree metadata and queries the run's private socket. The socket supplies the frozen role. Editable role environment variables cannot authorise a full suite. A marked worktree with missing, deleted, foreign or stale context fails before tests are admitted. Automatic verifier and release coverage remains available.

## Request a wider investigation

Start with the named failure and the relevant cold state, preceding test sequence or machine load. A focused pass after a complete-gate failure does not establish that unrelated tests must repeat.

Read the retained evidence through the existing client:

```bash
python3 "$AGENTS_REPO_PATH/dispatcher/scripts/fleet-task.py" evidence owner/repo#123 --run RUN_ID
```

The listing supplies the verified bundle digest and file paths. Write a request JSON file with these fields:

| Field | Meaning |
| --- | --- |
| `revision` | Exact 40-character candidate revision. |
| `failedTests` | One to sixteen failed test identities. |
| `evidence` | One to eight references, each with `runId`, bundle `digest` and manifest `path`. |
| `scope` | `kind` and `selectors`. Kinds are `tests`, `class`, `package`, `sequence` or `suite`. A suite has an empty selector list. Other kinds need explicit selectors. |
| `narrowerInsufficient` | What the narrower run could not establish and why the requested scope would help. |

The complete JSON is limited to 8192 bytes. References must name nonempty files in committed evidence bundles for this ticket. This verifies their provenance. Recovery still reads the files and judges what they prove. A local path or a free-text reason alone is insufficient.

```bash
python3 "$AGENTS_REPO_PATH/dispatcher/scripts/fleet-task.py" investigate --request-file REQUEST.json
```

The reply is `assessment-queued`, an investigation `id` and `executed: 0`. Repeating the same request from the same admitted run returns the same acknowledgement. No tests have run. No native task or permission to execute a complete suite has been created. Ticket stages, holds and ownership stay unchanged.

The assessment becomes eligible after the requesting source worker ends. It uses the existing recovery process and sees the request with its retained evidence. Recovery chooses the smallest useful diagnostic. A complete native recipe requires an explanation grounded in that evidence. Direct builder requests for `mobile-in-depth` are refused both at the socket and at the central authority. Other existing diagnostic recipes retain their current ownership.

Record the request as pending evidence in the builder handoff. An acknowledgement or a focused pass cannot satisfy unexecuted complete acceptance. Keep explicit live requirements and complete verifier and release checks intact.

## Rollout

Deploy the shared controller first. Install the consumer launchers and shared pin next. Verify the active workers before merging the product forwarding hooks. Current legacy workers without a Git metadata binding can finish without calling a new endpoint. That compatibility path leaves them outside the new policy until their supervised update. A marked worktree never takes that fallback.

The raw Mobile Gradle hook adds selection checking only. It does not add managed host admission or process cleanup. Builders continue to use the managed Gradle helper.
