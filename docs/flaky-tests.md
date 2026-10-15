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
   ticket. A gate run judged twice is still one sighting: its id comes from
   the run itself, the live gate's output path or a hash of the verifier
   gate's output.
2. **A noisy run gets at most one ticket.** A run is noisy when it has more
   than three failing tests, or when any failure failed again on the re-run.
   Its flaky tests share at most one ticket, naming them all with a marker
   line for each, filed once one of them is on its second sighting. When only
   one of them is left to track, its ticket is the ordinary per-test one.
3. **Except when the run already explains itself.** A noisy run files no
   flaky ticket when a failure that failed again is the branch's own, which
   the verifier or rework handles; those flakes are recorded as not counting,
   because the branch may have caused them too. Nor when the live gate filed
   the run's shared live failure ticket for failures that also fail on main:
   that ticket is the run's one ticket, and the flakes are recorded and
   counted. In the verifier gate, failures that also fail on main are only
   noted on the main sweep's ticket, so the run may still file its one flaky
   ticket.
4. **A recently closed ticket is reopened instead of filed again.** When a
   test reaches its second sighting and a `flaky-test` ticket naming it on its
   marker line closed in the last 30 days, that ticket is reopened into
   Backlog with a comment, and nothing new is filed. The newest one wins when
   there are several. A ticket a person closed as not planned or as a
   duplicate is left alone: nothing is reopened or filed for that test until
   the 30 days have passed. On a board the claim service owns, the reopen is
   one central write (see below). Elsewhere it is GitHub's own steps: reopen,
   comment, drop the stale labels, move to Backlog. A reopen that fails for a
   passing reason files nothing beside the closed ticket; the next sighting
   tries again. One that can never succeed, because the claim service does not
   hold the ticket, it is not the pipeline's tracker there, it closed outside
   the window, or another computer owns it on a board the claim service does
   not own, files a new ticket instead.
5. **The re-run carries the gate's own load.** For Playwright, the gate's
   report says how many workers it ran with. With `fullyParallel: false` a
   spec file runs in one worker, so a re-run of one failing file used one.
   Now the verifier gate's same-tree re-run, and the base-commit re-run after
   it, ask for the gate's worker count, and when the failing tests sit in
   fewer spec files than that, they also run tests that passed in the gate
   from other spec files, one file per idle worker, until those last at least
   as long as the slowest failing test did. A load test is matched by its exact
   file, so it pulls in no other file's tests. Load tests decide nothing, and
   one that fails on the base is not a failure of main. Each failing test
   still runs exactly once, so the retry budget is unchanged. Copies of the
   failing test are not used: two copies of one test can collide on a
   resource the gate never shared. The live gate's re-runs ask for its worker
   count but carry no load tests, since each would be a real claude session and
   a failure that failed three times under load would file a shared live
   failure ticket on its first sighting; Desktop's live gate runs one worker
   anyway. A gate that ran one worker re-runs exactly as before. `--workers` is
   added only where the `{{TESTS}}` placeholder is the value of `-g` or
   `--grep`, so it always lands on the runner's own command line. Go JSON and
   JUnit XML report no worker count, so their re-runs are unchanged. In every
   format, a name that failed anywhere in the re-run, in another Playwright
   project or on another device, did not pass it.

An open ticket for a test still gets an occurrence comment each time the test
flakes, whatever its count, except in a run where the branch owns a failure
that failed again, so its comments are the occurrence count. A run's tests that share one open ticket get one
comment. A test whose ticket another run is filing or reopening right now is
left to that run: the claim service hands out the filing for ten minutes to
the first due sighting, so two verifiers that flake the same test at once on
one busy computer file once. Without the shared record, the dispatcher keeps
the same lease for its own runs.

## Where sightings live

Sightings are rows in the claim service's database, table
`fleet_flaky_sightings`, so every computer counts the same record. The
dispatcher sends them through its machine manager, as it does run evidence:
`POST /flaky/sightings`. The answer gives each sighting's count inside the
window, the earlier ones, which a new ticket's body lists, and, for a due
sighting, whether it holds the filing (`fleet_flaky_filing_leases`). A
sighting has a deterministic id, so a retry is recorded once. The service
keeps 90 days of sightings as history and prunes older ones.

The dispatcher also keeps its own copy in `logs/flaky-sightings.json`. When
the claim service or the manager predates the route, or cannot be reached,
the sighting stays there marked undelivered, and goes with the next sighting
that is sent, with its original time. Meanwhile the dispatcher counts only
what this computer saw itself. That can only undercount: a first sighting
never files a ticket because the shared record was unavailable, and two
sightings on this computer still file one. An undelivered sighting is kept for
30 days. An unreadable file is kept beside it and a new one started. An
unmanaged dispatcher has no claim service, and its file is the whole record.

## Tracker writes on a board the claim service owns

A flaky ticket usually belongs to another computer: the one that filed it,
or the one whose builder fixed it. A closed ticket keeps its claim. The
ordinary ownership check would refuse every other computer's comment or
reopen. So these go through `POST /flaky/track`, which is narrower instead:

- the caller must hold an active run;
- the ticket must carry `flaky-test`, or `bug` for a shared live failure
  ticket, and name one of the tests on its own marker line;
- no other run may be active on the ticket; the tracker's own run, such as
  its own verifier, may write it;
- a reopen needs the ticket closed, and inside the 30 days when its closing
  is recorded in the database; a comment needs it open.

A reopen sets the ticket open and in Backlog and drops `merged`, a
`needs-human:` hold and the stage markers a merge strips (`done:`, `wip:`,
`needs-rework:`, `error:`, `pending-done:`, `pending-verdict:`,
`merge-attempt:`), in the same transaction as the comment. It is new work, so
it also releases the closed ticket's claim, unless a support task is open on
it, and the next free computer that can run it takes it. Kept, the claim would
hold it for a computer that may be drained or gone. Each write carries a key
from the gate run, so the same run judged twice writes once.

On an owned board the closed tickets come from GitHub, which knows when and
why each closed, checked against the database, which knows whether it is
closed: one the database holds open is not reopened, and one the database has
closed that GitHub still shows open, because publication has not caught up,
counts as closed just now.

A claim service from before the route answers "Unknown operation": the
occurrence comment then falls back to the ordinary workflow comment, and a
reopen is not attempted, so nothing is filed beside the closed ticket either.

## Shared live failures

A shared live failure ("fix shared live failure", `src/inherited-tickets.ts`)
failed on the branch, again on the re-run and on the base commit. It is not in
doubt, and the gated ticket waits on its tracker, so it is still filed on its
first sighting, one ticket for all the run's new failures. Rule 4 applies to
it: a fix ticket naming the test on its marker line that closed in the last
30 days, and not as not planned or a duplicate, is reopened at the top of
Backlog and becomes the blocker. If the reopen fails, including on a claim
service from before the route, a new ticket is filed as before, because the
gated ticket needs a tracker to wait on.

## Known limits

- A burst that reopens one test's closed ticket names the run's other tests
  in the comment only. The ticket body keeps its own markers, so another of
  those tests that flakes later gets its own ticket.
- Two noisy runs that are due at the same moment for different tests can each
  file their one ticket.

## Rollout

The claim service and the machine managers need the routes before the
dispatchers can count centrally. Dispatchers that arrive first keep their
sightings locally and send them once the service has the route. A claim
service and managers from this release with older dispatchers change nothing:
older dispatchers never call the routes.
