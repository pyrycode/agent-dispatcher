/** Shared operator policy for every project and stage, adopted 2026-10-16. */
export const HOST_TESTING_POLICY = `
## Ticket testing operating system

Test on the operating system running this ticket. A Linux ticket requires Linux checks; a macOS ticket requires macOS checks. Do not require, request or wait for tests on the other operating system. This policy applies to every project and stage, including refinement, building, verification, documentation and recovery. It supersedes older ticket or repository wording requiring both operating systems.

Run the applicable shared tests and native checks on that operating system. Preserve required assertions, security checks, live acceptance and device checks. Record which operating system was tested. Report the other operating system as outside this ticket's verification scope, never as passed. Missing second-OS evidence is not a blocker or a reason to escalate, create a dependency, or order a remote native suite. Do not add emulation to recreate the omitted second-OS run.

A ticket that fixes a specific operating system still runs on that system through its existing requires:linux or requires:macos requirement. Reading earlier evidence from another computer remains allowed. Historical failed captures remain failed; this policy does not turn them into passes. Existing workers and reservations must still be proved stopped before release.
`;
