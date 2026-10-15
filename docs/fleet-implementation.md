# Fleet review implementation

## 1. Disable automatic fleet repair

The service refuses new dispatcher repair requests from agents and operators.
It omits old queued repairs and refuses their starts through both task and general
admission routes. A recovery proposal becomes a human escalation instead.
Ordinary product rework and native checks continue.

Automatic repair publication is retired. No endpoint merges a fleet repair,
changes the controller target or advances a consumer pin. The merge and pin publication
library has been deleted. Existing prepared patches and task artifacts
stay private and readable. Running repairs must finish or receive confirmed stop
handling. Their reservation is never released by a timeout.

Assumption: Juhana approves reviewed fleet fixes and each release separately.

After a separately approved controller rollout, list queued repairs and withdraw
only tasks which never started. Save one private request per task:

```json
{"id":"TASK_ID_FROM_QUEUE","reason":"Automatic fleet repair retired. Private evidence retained."}
```

Use the protected operator wrapper with `recovery-task cancel-queued REQUEST.json`.
The command is repeatable with the same task and reason. Running, publishing and
uncertain tasks are refused. Check their process records separately.
Remove `dispatcher-repair` from supervisor capability lists during the approved
configuration rollout. Do not remove retained state or patches.

Roll out the claim service first. Verify old queued repairs cannot start, a native
probe still runs, operator drains survive, and no target or consumer pin moved.
Then update managers, supervisors and dispatchers through the approved release.
Rollback must retain the repair restriction. An older unrestricted controller
needs an explicit maintenance hold before rollback.
