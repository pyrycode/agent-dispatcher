# Predictable test execution

Offline verifier gates, their baselines and main sweeps omit live provider logins.
The real gate keeps its explicit test login. Offline subprocesses get fresh empty
Codex and Claude configuration directories. Existing fixture cleanup still keeps
gate-generated test data out of automatic commits.

This prevents accidental login inheritance. It does not isolate a test from its
operating-system account. The authority and restricted-account rollout must
establish that boundary separately.

## Interactive suites and idle cache limits

After separately approving the controller rollout, configure a private local
interactive-tests JSON file from the example. Name the existing machine credential
through its environment variable. Keep the value in the configured account helper.
Never put a credential value in the JSON or a command argument.

Run a suite from its checkout through the approved credential helper and the
shared entry point. The helper supplies the existing machine credential.

```sh
node --import tsx src/fleet-bin.ts tests INTERACTIVE_CONFIG PROJECT -- pnpm test
```

The new command requires a controller that advertises exclusive test admission.
It refuses a drained or busy host. The reservation prevents other host work
until the existing process-group check confirms the test children stopped.
Its private receipt and output paths remain available if the command fails.
An interrupted or unreachable owner is never released by a timer.

An optional idleCache record limits a dedicated Go build cache by bytes. The
example uses 10 GiB. Cleanup runs before the suite while the host reservation is
exclusive. It checks the Go cache README and never follows a cache symlink.
A failed cleanup prevents the suite. To perform only this maintenance, use the
same command with `true` as the local command.

Automatic periodic cleanup is deferred until interactive builds all use admission.
The review found unmanaged suites outside admission. A scheduler's idle snapshot
cannot prove those builds stopped. Adding a second background scheduler now would
recreate the overlap this change removes. The admitted maintenance command is the
safe operation to connect to an existing idle maintenance trigger after that check.

## Computer configuration

The tracked test-computer-overrides example records Fractal's two-worker policy.
During the approved configuration rollout, set the Desktop Playwright gate on
build-fractal-2 to two workers in both its main and baseline command. Keep other
computers' declared counts. Record the effective setting with each run.

Keep a projectHeavyLimits entry of 1 for pyrycode/pyrycode-mobile in both the
central machine record and local manager record. Keep one display per Desktop
run through its existing display launcher. The controlled clipboard comparison
justifies that isolation; it does not prove an overall flake-rate improvement.

Retain Juhana's one-code-building-agent limit. New test admission does not raise
provider or worker limits. The tracked runtime configuration follow-up moves
these reviewed values into the existing agents repositories. No live settings,
services, caches, targets or pins were changed in this pull request.
