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
}

// 5-agent pipeline: PO → Architect → Developer → Code Review → Documentation
// Skipped: UX Designer (no UI), Security (local-only daemon), QA (Go tests handled by Developer + CI)
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
    description: "System Architect — defines Go interfaces, data flows, concurrency patterns",
    usesWorktree: true, // writes spec to docs/specs/architecture/
    producesCommits: true, // commits the spec
  },
  {
    name: "developer",
    column: "In Development",
    claudeMdPath: "developer/CLAUDE.md",
    description: "Developer — implements Go code with tests",
    usesWorktree: true, // writes Go code + tests
    producesCommits: true, // commits implementation + tests
  },
  {
    name: "code-review",
    column: "In Code Review",
    claudeMdPath: "code-review/CLAUDE.md",
    description: "Code Reviewer — reviews PRs for Go quality and correctness",
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
  },
];
