# Flaky tests

A gate re-runs a red run's failing tests once in the same tree before it
blames anyone. A test that fails and then passes there is a flake: the gated
ticket is not blamed for it, and the dispatcher keeps track of it so the
suite gets fixed. This page is the rule for when that tracking files a
ticket. It covers both gates that re-run their failures: the verifier's
pre-spawn gates (`PYRY_VERIFIER_GATE_FORMATS` with a `baseline` template) and
the real-claude live gate (`PYRY_REAL_CLAUDE_GATE_BASELINE_CMD`), in every
format they read: Playwright JSON, Go JSON and JUnit XML. The code is
`src/flaky-tickets.ts` and `src/flaky-sightings.ts`.

## Why the rule changed on 2026-10-15

From 2026-10-05 the dispatcher filed a flaky-test ticket on a test's first
fail-then-pass, up to five per run. On pyrycode-desktop its verifier gates
filed 26 in ten days. Most were contention flakes that never came back, and
flaky tickets used 10.3 of Desktop's 62.3 agent hours from 2026-10-10. Three
things made it worse:

- The re-run of one or two failing tests used one worker, against the gate's
  three or four, so a failure caused by a busy display or CPU nearly always
  passed it.
- One run with 18 failures, 10 of them the branch's own selector race, filed
  five tickets (#2006 to #2010) for the eight that passed on re-run.
- Only open tickets were matched, so the receipt saturation test was filed
  three times (#1861, #1918, #1978).

## The rules

1. **A sighting is recorded every time; a ticket waits for the second.** Each
   flake is recorded as a sighting: the test, the project, the gated ticket
   and run, the computer and the time. A ticket is filed only when the same
   test has two counted sightings inside 14 days. The computer does not
   matter: two sightings on one computer count, and so do one on HP and one on
   Fractal. A test that flaked once two weeks ago and once today gets no
   ticket; the two are unrelated as far as anyone fixing it can tell. The
   first sighting is not silently dropped. It is named in the verifier's note
   and the gate log ("first sighting in 14 days, recorded; a ticket is filed
   if it flakes again"), and on the live gate's evidence comment on the gated
   ticket.
2. **More than three failures in one run get at most one ticket.** When a run
   has more than three failing tests and all of them passed on the re-run,
   the run files at most one ticket, naming every test, with a marker line for
   each. That many at once usually share one cause. The ticket is filed only
   once one of the tests is on its second sighting.
3. **A run where any failure persisted files no flaky ticket.** If any
   failure failed again on the re-run, the flakes in that run are recorded
   but no flaky ticket is filed, per test or for the run. The persistent
   failures are the branch's, which the verifier or rework handles, or
   main's, which have their own ticket. When one of them is the branch's own,
   its flakes are recorded as not counting, because the branch may have
   caused them too.
4. **A recently closed ticket is reopened instead of filed again.** When a
   test reaches its second sighting and a `flaky-test` ticket naming it on its
   marker line closed in the last 30 days, that ticket is reopened into
   Backlog with a comment, and nothing new is filed. The newest one wins when
   there are several. On a board the claim service owns, the reopen is one
   central write (see below). Elsewhere it is GitHub's own steps: reopen,
   comment, drop the stale labels, move to Backlog.
5. **The re-run carries the gate's own load.** For Playwright, the gate's
   report says how many workers it ran with. The same-tree re-run, and the
   base-commit re-run after it, ask for that worker count and repeat the
   failing spec files enough times to keep every worker busy, so a contention
   failure meets the same contention again. Each failing test still gets one
   re-run round. A test passes the re-run only if every copy passes. A gate
   that ran one worker re-runs exactly as before. The arguments are added only
   where the `{{TESTS}}` placeholder is the value of `-g` or `--grep`, so they
   always land on the runner's own command line. Go JSON and JUnit XML report
   no worker count, so their re-runs are unchanged.

An open ticket for a test still gets an occurrence comment each time the test
flakes in a run that is not rule 3's, whatever its count, so its comments are
the occurrence count. A run's tests that share one open ticket get one comment.

## Where sightings live

Sightings are rows in the claim service's database, table
`fleet_flaky_sightings`, so every computer counts the same record. The
dispatcher sends them through its machine manager, as it does run evidence:
`POST /flaky/sightings`. The answer gives each sighting's count inside the
window and the earlier ones, which the new ticket's body lists. A sighting
has a deterministic id, so a retry is recorded once. The service keeps 90 days
of sightings as history and prunes older ones.

The dispatcher also keeps its own copy in `logs/flaky-sightings.json`. When
the claim service or the manager predates the route, or cannot be reached,
the sighting stays there marked undelivered, and goes with the next sighting
that is sent, with its original time. Meanwhile the dispatcher counts only
what this computer saw itself. That can only undercount: a first sighting
never files a ticket because the shared record was unavailable, and two
sightings on this computer still file one. An undelivered sighting is kept for
30 days. An unmanaged dispatcher has no claim service, and its file is the
whole record.

## Tracker writes on a board the claim service owns

A flaky ticket usually belongs to another computer: the one that filed it,
or the one whose builder fixed it. A closed ticket keeps its claim. The
ordinary ownership check would refuse every other computer's comment or
reopen. So these go through `POST /flaky/track`, which is narrower instead:

- the caller must hold an active run;
- the ticket must carry `flaky-test`, or `bug` for a shared live failure
  ticket, and name one of the tests on its own marker line;
- no run may be active on the ticket itself;
- a reopen needs the ticket closed, and a comment needs it open.

A reopen sets the ticket open and in Backlog and drops `merged` and the stage
markers a merge strips (`done:`, `wip:`, `needs-rework:`, `error:`,
`pending-done:`, `pending-verdict:`, `merge-attempt:`), in the same
transaction as the comment. The claim is left as it was, so the computer that
owned the ticket runs it again. A retry with the same command id answers as
before. A claim service from before the route answers "Unknown operation":
the occurrence comment then falls back to the ordinary workflow comment, and a
reopen is not attempted, so nothing is filed beside the closed ticket either.
The next sighting tries again.

## Shared live failures

A shared live failure ("fix shared live failure", `src/inherited-tickets.ts`)
failed on the branch, again on the re-run and on the base commit. It is not in
doubt, and the gated ticket waits on its tracker, so it is still filed on its
first sighting, one ticket for all the run's new failures. Rule 4 applies to
it: a fix ticket naming the test on its marker line that closed in the last
30 days is reopened at the top of Backlog and becomes the blocker. If the
reopen fails, a new ticket is filed as before, because the gated ticket needs
a tracker to wait on.

## Rollout

The claim service and the machine managers need the routes before the
dispatchers can count centrally. Dispatchers that arrive first keep their
sightings locally and send them once the service has the route. A claim
service and managers from this release with older dispatchers change nothing:
older dispatchers never call the routes.
