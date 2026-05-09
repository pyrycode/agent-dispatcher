import { graphql } from "@octokit/graphql";
import type { ProjectConfig, ProjectItem } from "./types.js";

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  delayMs = 1000,
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (error) {
      if (attempt === retries) throw error;
      console.warn(`   ⚠️  fetch attempt ${attempt}/${retries} failed, retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
  throw new Error("fetchWithRetry: unreachable");
}

/**
 * GitHub Projects v2 client used by the dispatcher.
 *
 * **Item ordering:** every items() query orders by `POSITION` ascending
 * — top of column first. This is the user's manual board ordering and
 * doubles as the priority signal the dispatcher uses to pick which
 * Backlog ticket to advance next. Drag a ticket up the column to
 * prioritize it; drag down to defer.
 *
 * **Known limit:** every items() query uses `first: 100`, which is a
 * hard cap. If a single column ever exceeds 100 items (or
 * `getClosedItemsNotInDone` returns a project with 100+ closed items),
 * tickets beyond the page boundary go invisible to the dispatcher.
 * Pagination via `pageInfo.hasNextPage` + `endCursor` is the standard
 * fix when this becomes a real constraint. Today's pyrycode project is
 * well under the cap.
 */
/**
 * Internal item shape during the cache lifetime — same as `ProjectItem`
 * plus `state` (issue OPEN/CLOSED) so both `getItemsByStatus` (open
 * only) and `getClosedItemsNotInDone` (closed only) can filter from a
 * single cached fetch without re-querying.
 */
type RawItem = ProjectItem & { state: string | null };

/** Strip the cache-internal `state` field; callers see the public ProjectItem shape. */
function stripState(raw: RawItem): ProjectItem {
  const { state: _state, ...item } = raw;
  return item;
}

export class GitHubProjectClient {
  private gql: typeof graphql;
  private config: ProjectConfig;
  private projectId: string | null = null;
  private statusFieldId: string | null = null;
  private statusOptions: Map<string, string> = new Map();
  /**
   * Per-cycle cache of all project items.
   *
   * Both `getItemsByStatus` and `getClosedItemsNotInDone` issued
   * IDENTICAL GraphQL queries (full project items list with nested
   * labels/blockedBy/fieldValues) and then filtered client-side. Per
   * cycle the dispatcher called these ~14 times across runReworkRouting,
   * runAutoAdvance, runDoneCleanup, runClosedSweep, and the per-agent
   * dispatch loop — burning ~14 identical queries' worth of GraphQL
   * points every 60s. With this cache, one fetch per cycle serves all
   * sub-steps. The dispatcher calls `clearItemsCache()` at the top of
   * each poll cycle so the next fetch is fresh.
   *
   * **Consistency trade-off:** intra-cycle mutations (`addLabel`,
   * `removeLabel`, `updateItemStatus`) do NOT update the cached
   * snapshot — only `clearItemsCache()` does. Most mutations don't
   * matter for downstream sub-steps in the same cycle, so the cache
   * just serves the original snapshot.
   *
   * **Exception:** `runAutoAdvance` and `runReworkRouting` (in
   * `reconcile.ts`) call `clearItemsCache()` themselves after applying
   * any column- or label-changing mutation. Without this, the
   * per-agent dispatch loop later in the same cycle would read the
   * stale snapshot and skip the just-advanced ticket — silently
   * inverting `pollOrder`'s finish-first priority. The 2026-05-03 09:33
   * incident (PO dispatched on Backlog #132 instead of code-review on
   * the freshly-advanced #127) was exactly this. See
   * `reconcile.test.ts` for the regression test.
   */
  private allItemsCache: Promise<RawItem[]> | null = null;
  /**
   * Snapshot of the GitHub GraphQL rate-limit state from the most
   * recent successful fetch. Used by the dispatcher to log budget
   * consumption per cycle and to make defensive sleep decisions if
   * `remaining` gets dangerously low. Null until the first fetch.
   */
  private lastRateLimit: { remaining: number; resetAt: string; cost: number } | null = null;

  // Once-per-process flag for the items(first:100) saturation warning.
  // Prevents log spam on a saturated board (review #23).
  private warnedItemsSaturation: boolean = false;

  constructor(config: ProjectConfig) {
    this.config = config;
    this.gql = graphql.defaults({
      headers: { authorization: `token ${config.token}` },
    });
  }

  /**
   * Drop the cached project-items snapshot. Call at the top of each
   * poll cycle so the next `getItemsByStatus` / `getClosedItemsNotInDone`
   * call refetches. Without this the cache would persist across cycles
   * and the dispatcher would never see new tickets or state changes.
   */
  clearItemsCache(): void {
    this.allItemsCache = null;
  }

  /** Latest GraphQL rate-limit state, or null if no successful fetch yet. */
  getRateLimit(): { remaining: number; resetAt: string; cost: number } | null {
    return this.lastRateLimit;
  }

  /**
   * Look up a ticket's current project-board column by issue number.
   * Returns null if the ticket isn't in the project (or the fetch fails).
   *
   * Used by the dispatcher's post-success path to detect "agent moved
   * the ticket out of its dispatch column" (PO demoting to Inbox, PO
   * moving a split parent to Done). When that happens, the dispatcher
   * skips the `ready:<agent>` label so the board view doesn't show a
   * stale "ready" signal on a ticket the agent already routed away.
   *
   * `forceRefresh: true` clears the per-cycle cache before reading —
   * the agent's run could have moved the ticket since the cycle's
   * first fetch, so the cached snapshot would be stale.
   */
  async getItemStatus(issueNumber: number, options?: { forceRefresh?: boolean }): Promise<string | null> {
    if (options?.forceRefresh) this.clearItemsCache();
    const all = await this.getAllItems();
    const item = all.find(i => i.issueNumber === issueNumber);
    return item?.status ?? null;
  }

  /**
   * Fetch all project items from GraphQL once per cycle. Both public
   * methods filter from this. Stores the in-flight Promise so concurrent
   * calls within a cycle dedupe on the same request (Promise reuse).
   */
  private getAllItems(): Promise<RawItem[]> {
    if (!this.allItemsCache) {
      this.allItemsCache = this.fetchAllItems();
    }
    return this.allItemsCache;
  }

  private async fetchAllItems(): Promise<RawItem[]> {
    if (!this.projectId) throw new Error("Not initialized");

    // `rateLimit` adds visibility into our GraphQL budget — the dispatcher
    // logs `remaining` once per cycle so a slow leak (or a sudden burst)
    // is visible in normal operation, not just at the moment we hit the
    // 5000-points-per-hour ceiling. `cost` is what THIS query consumed.
    const result: any = await this.gql(`
      query($projectId: ID!) {
        rateLimit { remaining resetAt cost }
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, orderBy: { field: POSITION, direction: ASC }) {
              nodes {
                id
                fieldValueByName(name: "Status") {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                  }
                }
                content {
                  ... on Issue {
                    id
                    number
                    title
                    body
                    url
                    state
                    labels(first: 10) {
                      nodes { name }
                    }
                    blockedBy(first: 10) {
                      nodes { number state }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { projectId: this.projectId });

    if (result.rateLimit) {
      this.lastRateLimit = {
        remaining: result.rateLimit.remaining,
        resetAt: result.rateLimit.resetAt,
        cost: result.rateLimit.cost,
      };
    }

    // Saturation warning: the GraphQL query caps at 100 items. At pyrycode's
    // current board size this is fine, but a silent truncation at 100 would
    // first present as "some tickets stop dispatching" with no log signal.
    // Surface the cap before it bites — operator decides whether to add
    // pagination or rebuild the query for first(>100). (review #23)
    // Once per process — a saturated board prints one warn at startup, not
    // every poll cycle.
    const rawNodes: unknown[] = result.node.items.nodes ?? [];
    if (rawNodes.length === 100 && !this.warnedItemsSaturation) {
      this.warnedItemsSaturation = true;
      console.warn(`   ⚠️  GraphQL items(first:100) returned exactly 100 — board may be truncated. Add pagination if the board grows past this.`);
    }

    const items: RawItem[] = [];
    for (const node of result.node.items.nodes) {
      const itemStatus = node.fieldValueByName?.name;
      if (!node.content) continue;
      // Skip non-Issue content (PR fragment, DraftIssue) — number is
      // undefined on those so any downstream code keying on it would
      // silently misbehave.
      if (typeof node.content.number !== "number") continue;

      items.push({
        id: node.id,
        issueId: node.content.id,
        issueNumber: node.content.number,
        title: node.content.title,
        body: node.content.body ?? "",
        status: itemStatus ?? "no-status",
        state: node.content.state ?? null,
        labels: node.content.labels.nodes.map((l: any) => l.name),
        url: node.content.url,
        blockedBy: (node.content.blockedBy?.nodes ?? []).map((b: any) => ({
          number: b.number,
          state: b.state,
        })),
      });
    }
    return items;
  }

  async initialize(): Promise<void> {
    // Support both user and organization project owners
    const ownerField = this.config.ownerType === "organization" ? "organization" : "user";

    const result: any = await this.gql(`
      query($owner: String!, $number: Int!) {
        ${ownerField}(login: $owner) {
          projectV2(number: $number) {
            id
            fields(first: 30) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name }
                }
              }
            }
          }
        }
      }
    `, {
      owner: this.config.owner,
      number: this.config.projectNumber,
    });

    const project = result[ownerField].projectV2;
    this.projectId = project.id;

    const statusField = project.fields.nodes.find(
      (f: any) => f.name === "Status"
    );
    if (!statusField) throw new Error("Status field not found on project");

    this.statusFieldId = statusField.id;
    for (const opt of statusField.options) {
      this.statusOptions.set(opt.name, opt.id);
    }

    console.log(`Initialized: project=${this.projectId}`);
    console.log(`Status options: ${[...this.statusOptions.keys()].join(", ")}`);
  }

  /**
   * Return project items whose issue is CLOSED and whose status is NOT
   * "Done". Used by the closed-sweep step to keep the board tidy: tickets
   * closed by PO during a split (parent → children), tickets the user closed
   * manually (won't-fix, duplicates), or anything else closed-but-stranded
   * gets moved to Done.
   *
   * Distinct from `getItemsByStatus`, which deliberately excludes CLOSED
   * issues so the per-column dispatch loops never operate on them.
   */
  async getClosedItemsNotInDone(): Promise<ProjectItem[]> {
    const all = await this.getAllItems();
    return all
      .filter(item => item.state === "CLOSED" && item.status !== "Done")
      .map(stripState);
  }

  async getItemsByStatus(status: string): Promise<ProjectItem[]> {
    const all = await this.getAllItems();
    return all
      .filter(item => item.state !== "CLOSED" && item.status === status)
      .map(stripState);
  }

  async updateItemStatus(itemId: string, newStatus: string): Promise<void> {
    if (!this.projectId || !this.statusFieldId) {
      throw new Error("Not initialized");
    }

    const optionId = this.statusOptions.get(newStatus);
    if (!optionId) {
      throw new Error(
        `Unknown status "${newStatus}". Available: ${[...this.statusOptions.keys()].join(", ")}`
      );
    }

    await this.gql(`
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item { id }
        }
      }
    `, {
      projectId: this.projectId,
      itemId,
      fieldId: this.statusFieldId,
      optionId,
    });
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to add comment: ${response.statusText}`);
    }
  }

  async getIssueLabels(issueNumber: number): Promise<string[]> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/labels`,
      {
        headers: {
          Authorization: `token ${this.config.token}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get labels: ${response.statusText}`);
    }

    const labels: any[] = await response.json();
    return labels.map((l) => l.name);
  }

  /**
   * Create a new issue in the configured repo via the REST API.
   * Returns both the issue number (for human-facing links) and the
   * GraphQL node ID (needed for addItemToProject).
   */
  async createIssue(
    title: string,
    body: string,
    labels: string[] = [],
  ): Promise<{ number: number; nodeId: string; url: string }> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${this.config.token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ title, body, labels }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to create issue: ${response.status} ${response.statusText}`);
    }

    const issue: any = await response.json();
    return {
      number: issue.number,
      nodeId: issue.node_id,
      url: issue.html_url,
    };
  }

  /**
   * Add an existing issue (by GraphQL node ID) to the project. Returns the
   * project item ID so the caller can immediately set its status.
   *
   * The combination `createIssue` + `addItemToProject` + `updateItemStatus`
   * is the dispatchInbox flow: an issue lands in the project at the right
   * status with a single sequence of mutations and no null-status race.
   */
  async addItemToProject(issueNodeId: string): Promise<string> {
    if (!this.projectId) throw new Error("Not initialized");

    const result: any = await this.gql(`
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {
          projectId: $projectId
          contentId: $contentId
        }) {
          item { id }
        }
      }
    `, {
      projectId: this.projectId,
      contentId: issueNodeId,
    });

    return result.addProjectV2ItemById.item.id;
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/labels`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ labels: [label] }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to add label: ${response.statusText}`);
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `token ${this.config.token}`,
        },
      }
    );

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to remove label: ${response.statusText}`);
    }
  }
}
