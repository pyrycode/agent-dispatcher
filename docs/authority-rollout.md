# Apply authority restrictions one repository at a time

Assumption awaiting Juhana: use a restricted Mac fleet account. Until isolation is
demonstrated, unattended Mac work is limited to fixed native recipes. The proposed
claims configuration sets unattendedPolicy to native-only. Central admission then
refuses every agent role even if an old manager advertises it. Existing grants
remain held and replayable until their processes stop. No service is changed here.

The isolated value permits ordinary admission after human verification. It is a
policy statement, not proof of operating-system isolation. An absent value retains
compatibility during migration. Never switch it just to clear a refusal.

## Protect main

Pilot agent-dispatcher first. Repeat on pyrycode, pyrycode-agents and every product
and agents repository used by the fleet. These are proposed administrator actions,
not actions performed by this patch.

1. As Juhana, open the repository Settings, Rules, Rulesets. Create an active
   branch ruleset named Human reviewed main. Target refs/heads/main. Leave the
   bypass list empty, including administrators and automation accounts.
2. Enable Restrict deletions, Block force pushes and Require a pull request before
   merging. Require one approval. Dismiss stale approvals. Require approval of
   the most recent reviewable push and code-owner review. Require conversation
   resolution. Disable automatic merging for fleet and agents repositories.
3. Create a second active branch ruleset named Main update owners. Target
   refs/heads/main. Enable only Restrict updates. Its bypass list contains only
   the protected human administrator role, for pull requests only. The agent
   identity has Write access and is absent from that role and every bypass list.
   Keep the first ruleset's bypass list empty. This restricts merge execution
   without exempting the human from review requirements. Test an agent merge
   attempt after approval as well as before approval. Both must refuse.
4. This fleet patch provides CODEOWNERS with ilmoniemi owning every file. The Core
   agents companion does the same. In each remaining repository add a
   trusted-maintainer-owned CODEOWNERS file covering .github/, dispatcher/,
   bin/, container/, gate configuration and runtime configuration. Assign Juhana's
   account as owner. For product repositories also cover Makefile, test runners,
   test acceptance rules and workflow configuration. Protect CODEOWNERS itself.
5. Require the exact currently successful check contexts shown on a reviewed PR.
   Select their trusted GitHub App as source. Do not invent a status name or add
   a required context that is not produced. If there is no trusted CI, establish
   it in a separate reviewed change before relying on status checks. Pin actions
   by commit. Do not run privileged pull_request_target jobs on ticket code.
6. Test with a disposable PR. An agent author cannot push main, merge, change
   rules, forge the trusted check or approve its own latest push. A second human
   can review and merge. Keep an administrator recovery procedure outside agent
   storage. Record the ruleset ID and final JSON in the private rollout record.

The ruleset API also supports this configuration. Use the reviewed UI values and
read back the stored rule before rollout. See [GitHub ruleset creation](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset).
The owner is the authenticated human account ilmoniemi. No repository settings
are changed. See [GitHub update restrictions](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#restrict-updates).
Keep the two bypass lists separate. Record and test both stored rulesets.

The current implementation PRs use ilmoniemi as their GitHub author. Requiring
ilmoniemi as code owner cannot produce a self-approval. Before activating the rule,
complete the separately approved bootstrap merges or arrange a second qualified
human reviewer. Future PRs use the dedicated agent author. Never give the agent a
bypass to solve this bootstrap problem.

## Separate execution and publication identities

1. Create a dedicated agent identity with access only to its assigned repositories.
   Grant read and feature-branch submission rights. It must have no administrator,
   bypass, deployment or secret-management rights. Repository write alone can
   still merge without enforced branch rules. Complete protection first.
2. Keep the controller's workflow publication credential in a dedicated service
   identity. Keep Juhana's merge and release credentials outside agent-readable
   processes, home directories, keychains, mounted files and password-manager
   environments. A different variable or token in the same account is insufficient.
3. Give the execution account only its provider login, machine grant credential
   through the existing manager and feature-branch identity. The managed GitHub
   bridge remains the only workflow write path. Test refusal of settings, direct
   main writes, merge and release. Prefer its own restricted credential store.
   If an environment login is required, load PYRY_AGENT_GITHUB_TOKEN through the
   existing secret mechanism. It becomes the child GH_TOKEN. A broad parent
   GH_TOKEN never passes through. Do not print credential values during checks.
4. Under the execution account attempt to read the controller's home, environment,
   secret files and process details. Every privileged value must be inaccessible.
   Use a harmless sentinel for this test. Do not copy real secrets into fixtures.
5. Keep gate policy and acceptance configuration in the protected controller
   checkout. Ticket authors cannot change required gates, approved exceptions or
   acceptance rules. Review changes to product Makefiles and test launchers before
   using them as trusted acceptance. An outside path alone is insufficient if the
   execution account can write it.

Install the restricted credential path before activating the agent environment
change. Missing login may hold publishing health checks. Do not restore a broad
parent token to bypass the hold.

The code removes common broad GitHub, release and operator variables from child
environments. It does not isolate same-account processes or the credential store.
Do not claim the authority boundary is complete until the account checks pass.

## Restricted Mac account

1. Through macOS System Settings create a standard account named pyry-fleet. Do
   not grant administrator rights. Do not sign it into Juhana's Apple or browser
   accounts. Install a fresh provider login only for the fleet's assigned work.
2. Give it its own checkout, home, keychain, launch agents and test-daemon data.
   Deny access to Juhana's home, SSH keys, browser data and merge credentials.
   Keep the trusted controller and gate policy owned by the protected account.
3. Verify native emulator or desktop permissions interactively with Juhana.
   Check unattended startup and child cleanup in that account. Test a harmless
   sentinel in the personal account remains unreadable.
4. Keep native-only admission until all these checks pass. Then propose one
   isolated native run and record the evidence. Juhana approves the change to
   isolated separately. A failure returns new admission to native-only without
   releasing active work. Do not use heartbeat expiry to recover a lost account.

## Order and rollback

Apply automatic repair removal first. Review and apply branch protection next.
Provision the account and credentials outside this coding session. Roll out the
central native restriction before managers or credentials move. Run one feature
branch from submission to human merge. Rotate old credentials only after the new
path is proven. Keep native-only or saved drains as rollback. Do not reintroduce
personal credentials into the execution account to restore throughput.
