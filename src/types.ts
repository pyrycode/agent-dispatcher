export interface ProjectConfig {
  owner: string;
  repo: string;
  projectNumber: number;
  token: string;
  ownerType: "user" | "organization";
}

/** Minimal blocker info — issue number + open/closed state. */
export interface BlockerInfo {
  number: number;
  state: "OPEN" | "CLOSED";
}

export interface ProjectItem {
  id: string;           // Project item ID (for GraphQL mutations)
  issueId: string;      // Issue node ID
  issueNumber: number;
  title: string;
  body: string;
  status: string;
  labels: string[];
  url: string;
  /** Issues that block this one (GitHub native `addBlockedBy` relationship).
   *  Empty when the ticket has no dependencies. The dispatcher skips
   *  dispatch on tickets where any entry is `OPEN`. */
  blockedBy: BlockerInfo[];
  /** Issue number of this issue's parent in GitHub's sub-issue hierarchy
   *  (the PO's split lineage), or null when the ticket has no parent.
   *  Read by the family circuit breaker to resolve a ticket's family
   *  ROOT without walking descendants. */
  parentNumber: number | null;
  /** The parent's own parent, or null. The PO's split-depth cap keeps
   *  chains at most 3 deep (grandchild), so two levels fully resolve any
   *  ticket's root: `grandparentNumber ?? parentNumber ?? issueNumber`
   *  (see `resolveFamilyRoot` in pipeline-decisions.ts). */
  grandparentNumber: number | null;
}

export interface AgentConfig {
  name: string;
  column: string;
  claudeMdPath: string;
  description: string;
  /**
   * True if this agent runs in a git worktree branched from main and
   * produces commits the dispatcher should push to a feature branch.
   * False for agents that only modify external state (issues, PRs,
   * project board) — currently only PO.
   *
   * Adding a new agent forces an explicit decision here; missing the
   * field is a typecheck error, not a silent default. Predicate is
   * `shouldUseWorktree()` in lib.ts (also keys the post-run push and
   * the safety-net commit).
   */
  usesWorktree: boolean;
  /**
   * True if this agent is expected to produce commits during a normal
   * successful run (architect writes specs, developer writes code,
   * documentation writes docs). False for agents whose output is
   * GitHub-side only — comments on the issue (PO) or comments on the
   * PR (code-review).
   *
   * Distinct from `usesWorktree`: code-review uses a worktree (it reads
   * code locally) but never commits. The empty-branch guard fires only
   * on agents where `producesCommits === true && commitsAhead === 0`
   * after a successful run — surfaces silent failures where the agent
   * exited cleanly without doing the work (relay #5: architect refused
   * without spec, developer refused without spec, code-review couldn't
   * apply needs-rework labels because they didn't exist in the repo —
   * board marched to Done with feature/5 unchanged from main).
   *
   * Predicate is `shouldProduceCommits()` in lib.ts. The guard itself
   * is in dispatch.ts after the post-run push, before the post-success
   * labeling block.
   */
  producesCommits: boolean;
  /**
   * True if this agent must run serially — at most one instance running
   * AND at most one item picked per cycle, regardless of `maxConcurrent`.
   *
   * Applies to agents that touch centralized cross-cutting files every
   * ticket would also touch (e.g. documentation writing into
   * `docs/knowledge/INDEX.md`, `docs/PROJECT-MEMORY.md`). Two such
   * agents running in parallel produce add/add or edit/edit conflicts
   * on the same lines that auto-merge can't resolve — surfaced
   * 2026-05-10 when documentation on #1 and #2 both wrote to
   * `docs/knowledge/INDEX.md` independently and the second PR ended up
   * `mergeStateStatus=DIRTY` after the first merged.
   *
   * File-overlap detection (architect's `4e44a6f` style) doesn't help
   * here — these files are touched by EVERY ticket by design.
   * Serialization is the right shape.
   *
   * Default `false` (omit). Predicate is `selectDispatches`'s
   * serial-agent branch — counts in-flight `wip:<agent>` across the
   * whole snapshot and skips picking a second item when one is
   * already in flight or already picked this cycle.
   */
  serial?: boolean;
  /**
   * Per-agent `claude --model` override. Omit to inherit the pipeline
   * default (`opus`). Set on stages that don't need the top model —
   * e.g. QA runs mechanical gates and documentation synthesizes prose,
   * both on `claude-sonnet-5`. Resolved in `prepareAgentSpawn`
   * (dispatch.ts) as `agent.model ?? "opus"`.
   */
  model?: string;
  /**
   * Per-agent `claude --effort` (thinking level) override. Omit to
   * inherit the pipeline default (`xhigh`). One of pyry's accepted
   * values: `low | medium | high | xhigh | max`. Resolved in
   * `prepareAgentSpawn` as `agent.effort ?? "xhigh"`.
   */
  effort?: string;
  /**
   * Per-agent `claude --max-turns` override. Omit to use the name-keyed
   * tiers in `maxTurnsFor` (agent-runtime.ts). Declared by stage-set
   * agents (stage-sets.ts) whose budgets don't map onto the classic
   * names — the builder set's `builder` (200) and `verifier` (150). No
   * classic agent sets this, so classic budgets are untouched.
   */
  maxTurns?: number;
  /**
   * Per-agent wall-clock timeout override (ms). Omit to use the
   * name-keyed tiers in `timeoutFor`. The override is flat — the
   * label-conditional bump (security-sensitive architect) applies only
   * on the name-keyed path. Declared by the builder set's `builder` and
   * `verifier` (both 40min).
   */
  timeoutMs?: number;
}

// 6-agent pipeline: PO → Architect → Developer → QA → Code Review → Documentation
// QA added 2026-05-22 to separate mechanical gates (go test/vet/build + baseline-comparison
// routing) from judgment-heavy code-review (idiom, concurrency, spec-vs-PR diff). Placed
// BEFORE code-review so red-test runs cost only a QA spawn + rework cycle without burning
// code-review tokens on code about to be rejected.
// Skipped: UX Designer (no UI), Security (local-only daemon).
export const AGENTS: AgentConfig[] = [
  {
    name: "po",
    column: "Backlog",
    claudeMdPath: "po/CLAUDE.md",
    description: "Product Owner — creates structured issues",
    usesWorktree: false, // operates on issue body via gh, no commits
    producesCommits: false, // GH-side only (issue body, comments, labels)
  },
  {
    name: "architect",
    column: "In Architecture",
    claudeMdPath: "architect/CLAUDE.md",
    description: "System Architect — defines interfaces, data flows, concurrency patterns",
    usesWorktree: true, // writes spec to docs/specs/architecture/
    producesCommits: true, // commits the spec
  },
  {
    name: "developer",
    column: "In Development",
    claudeMdPath: "developer/CLAUDE.md",
    description: "Developer — implements code with tests",
    usesWorktree: true, // writes Go code + tests
    producesCommits: true, // commits implementation + tests
  },
  {
    name: "qa",
    column: "In QA",
    claudeMdPath: "qa/CLAUDE.md",
    description: "QA — runs mechanical gates (tests/vet/build) and triages failures against baseline",
    usesWorktree: true, // checks out feature branch to run tests against
    producesCommits: false, // PR comments + labels only; never writes code
    model: "claude-sonnet-5", // mechanical gate work, not top-model reasoning (2026-07-08)
    effort: "high",
  },
  {
    name: "code-review",
    column: "In Code Review",
    claudeMdPath: "code-review/CLAUDE.md",
    description: "Code Reviewer — reviews PRs for quality and correctness (assumes green tests from QA)",
    usesWorktree: true, // reads code locally to review
    producesCommits: false, // PR comments only via `gh pr review`
  },
  {
    name: "documentation",
    column: "In Documentation",
    claudeMdPath: "documentation/CLAUDE.md",
    description: "Documentation Agent — synthesizes project knowledge base",
    usesWorktree: true, // writes to docs/
    producesCommits: true, // commits doc updates
    serial: true, // writes to centralized docs/knowledge/INDEX.md + docs/PROJECT-MEMORY.md;
                  // two parallel docs runs produce add/add merge conflicts (2026-05-10)
    model: "claude-sonnet-5", // prose synthesis, not top-model reasoning (2026-07-08)
    effort: "high",
  },
];
