import { graphql } from "@octokit/graphql";
import type { ProjectConfig, ProjectItem } from "./types.js";
import {
  AUTO_RETRY_COMMENT_MARKER,
  STRANDED_WIP_OBSERVED_MARKER,
  STRANDED_WIP_SWEPT_MARKER,
  tallyFamilyComments,
} from "./pipeline-decisions.js";

/**
 * Newest createdAt among an issue's comments carrying `marker`, or null
 * when none does.
 *
 * Scans for the max rather than trusting sort order — robust regardless of
 * how GitHub paginates or orders the page.
 */
function latestMarkerAt(comments: any[], marker: string): Date | null {
  let latest: Date | null = null;
  for (const c of comments) {
    if (typeof c?.body !== "string" || !c.body.includes(marker)) continue;
    const created = c.created_at ? new Date(c.created_at) : null;
    if (created && !isNaN(created.getTime())) {
      if (latest === null || created.getTime() > latest.getTime()) latest = created;
    }
  }
  return latest;
}

/** Transient GitHub responses worth another attempt for an IDEMPOTENT
 *  request: server-side 5xx and secondary-rate-limit 429. `fetch()` only
 *  throws on a network-level failure, so without opting in a 502/429 falls
 *  straight through to the caller's `!response.ok` throw. Only idempotent
 *  callers (label add/remove) opt in — retrying a non-idempotent POST like
 *  addComment could double-post if the first try actually landed server-side
 *  under a transient 5xx. */
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  delayMs = 1000,
  retryOnStatus = false,
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (retryOnStatus && !response.ok && RETRYABLE_HTTP_STATUS.has(response.status) && attempt < retries) {
        console.warn(`   ⚠️  fetch got ${response.status} (attempt ${attempt}/${retries}), retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs *= 2;
        continue;
      }
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
 * **Pagination:** `fetchAllItems` loops on `pageInfo.hasNextPage` +
 * `endCursor` until the project is fully drained. Pre-2026-05-09 the
 * fetch used `items(first: 100)` with no continuation, silently
 * truncating boards past 100 entries. Surfaced as pyrycode #203
 * (board grew to 105 items, last 5 went invisible to the dispatcher).
 * Loop is bounded by `MAX_PAGES` to avoid runaway iteration on a
 * future bug; today's pyrycode is 2 pages.
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

/**
 * Map an item's Issue content node onto the parent-chain fields the family
 * circuit breaker reads (`parentNumber` / `grandparentNumber`). Pure — the
 * only piece of the GraphQL mapping with branching worth unit-testing.
 *
 * A parent node without a usable number (PR fragment, inaccessible issue)
 * counts as no parent, and a grandparent hanging off an unresolved parent
 * is unreachable by definition — both collapse to null rather than
 * inventing a chain link.
 */
export function mapParentChain(
  content:
    | { parent?: { number?: number | null; parent?: { number?: number | null } | null } | null }
    | null
    | undefined,
): { parentNumber: number | null; grandparentNumber: number | null } {
  const parent = content?.parent ?? null;
  const parentNumber = typeof parent?.number === "number" ? parent.number : null;
  const grandparentNumber =
    parentNumber !== null && typeof parent?.parent?.number === "number"
      ? parent.parent.number
      : null;
  return { parentNumber, grandparentNumber };
}

// The issue fields every board read selects. Shared by the board listing and
// the open-issue read below so the two produce identical items.
const ISSUE_FIELDS = `
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
                      parent {
                        number
                        parent { number }
                      }
                      subIssuesSummary { total completed }`;

/** Map one board item's id, Status name and Issue content onto a cache item. */
function toRawItem(itemId: string, status: string | null | undefined, content: any): RawItem {
  return {
    id: itemId,
    issueId: content.id,
    issueNumber: content.number,
    title: content.title,
    body: content.body ?? "",
    status: status ?? "no-status",
    state: content.state ?? null,
    labels: content.labels.nodes.map((l: any) => l.name),
    url: content.url,
    blockedBy: (content.blockedBy?.nodes ?? []).map((b: any) => ({
      number: b.number,
      state: b.state,
    })),
    ...mapParentChain(content),
    ...(content.subIssuesSummary
      ? { subIssues: { total: content.subIssuesSummary.total, completed: content.subIssuesSummary.completed } }
      : {}),
  };
}

/** Where the board listing and the open-issue read disagreed in one fetch. */
export interface ListingGaps {
  /** Open issues on the board that the listing did not return at all. */
  missing: number[];
  /** Open issues the listing placed in a different column than the issue itself reports. */
  moved: { issueNumber: number; listed: string; actual: string }[];
}

/**
 * Combine the board listing with the open-issue read.
 *
 * The board listing (`ProjectV2.items`) is the only source of column
 * ORDER, which is the operator's priority signal, but GitHub serves it
 * from a search index that can lag. During GitHub's 2026-09-23 incident
 * ("stale Project search results") it left out every card added for
 * hours, so the dispatcher could not see new tickets at all. The
 * open-issue read (`Repository.issues` with each issue's own board item)
 * is current.
 *
 * So: every open issue the read returns replaces its listing entry in
 * place, keeping the listing's position but taking the read's column,
 * labels and blockers. Open issues the listing lacks go after every
 * listed item, lowest number first, which puts each at the bottom of its
 * column. Listing items the read does not cover (closed issues, other
 * repositories' issues) pass through unchanged. When the listing is
 * healthy the result is the listing, and both gap lists are empty.
 */
export function mergeListingWithOpenIssues<T extends { issueNumber: number; status: string }>(
  listing: readonly T[],
  openIssues: readonly T[],
): { items: T[]; gaps: ListingGaps } {
  const fresh = new Map(openIssues.map((i) => [i.issueNumber, i] as const));
  const listed = new Set<number>();
  const moved: ListingGaps["moved"] = [];
  const items = listing.map((item) => {
    const current = fresh.get(item.issueNumber);
    if (!current) return item;
    listed.add(item.issueNumber);
    if (current.status !== item.status) {
      moved.push({ issueNumber: item.issueNumber, listed: item.status, actual: current.status });
    }
    return current;
  });
  const unlisted = openIssues
    .filter((i) => !listed.has(i.issueNumber))
    .sort((a, b) => a.issueNumber - b.issueNumber);
  return {
    items: [...items, ...unlisted],
    gaps: { missing: unlisted.map((i) => i.issueNumber), moved },
  };
}

/**
 * Edge-triggered report of a stale board listing: one warning and one
 * notification when gaps first appear, a short line each cycle while they
 * last, and one line when the listing catches up. Pure; the caller holds
 * `active` between fetches.
 */
export function decideListingGapReport(
  active: boolean,
  gaps: ListingGaps,
  repo: string,
): { active: boolean; notify?: string; log?: string } {
  const count = gaps.missing.length + gaps.moved.length;
  if (count === 0) {
    return active ? { active: false, log: "   ✅ Board listing caught up with the issues." } : { active: false };
  }
  if (active) {
    return { active: true, log: `   ℹ️  Board listing still stale: ${gaps.missing.length} missing, ${gaps.moved.length} in another column. Using the issues.` };
  }
  const list = (nums: number[]) =>
    nums.slice(0, 10).map((n) => `#${n}`).join(", ") + (nums.length > 10 ? ` and ${nums.length - 10} more` : "");
  const parts: string[] = [];
  if (gaps.missing.length > 0) parts.push(`${gaps.missing.length} open ticket(s) missing from it (${list(gaps.missing)})`);
  if (gaps.moved.length > 0) parts.push(`${gaps.moved.length} shown in the wrong column (${list(gaps.moved.map((m) => m.issueNumber))})`);
  return {
    active: true,
    notify: `⚠️ **${repo}**: GitHub's board listing is stale: ${parts.join("; ")}. The dispatcher is reading columns from the issues instead; new tickets go to the bottom of their column until the listing catches up.`,
  };
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
  /** Whether the last fetch found the board listing stale; see `decideListingGapReport`. */
  private listingGapActive = false;
  /** Called once when the board listing goes stale, with a message for the operator. */
  private listingGapHandler: ((message: string) => void) | null = null;

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

  /** Receive a one-off message when the board listing and the issues start to disagree. */
  setListingGapHandler(handler: (message: string) => void): void {
    this.listingGapHandler = handler;
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
   * skips the `done:<agent>` label so the board view doesn't show a
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

  // Hard cap on pagination iterations. 50 pages × 100 items = 5000
  // items. A real project that big is a different operational regime
  // anyway; better to surface a runaway loop (e.g. a future GraphQL
  // bug echoing the same `endCursor` forever) than to silently consume
  // GraphQL points indefinitely.
  private static readonly MAX_PAGES = 50;

  private async fetchAllItems(): Promise<RawItem[]> {
    if (!this.projectId) throw new Error("Not initialized");

    // Paginate via `pageInfo.hasNextPage` + `endCursor`. Pre-2026-05-09
    // this was a single `items(first: 100)` call with no continuation,
    // silently truncating boards past 100 (pyrycode #203 lineage).
    //
    // `rateLimit` is queried on EACH page so the dispatcher's per-cycle
    // log reflects total cost across pages, not just the first; without
    // this, a 3-page fetch would log only page 1's cost and the operator
    // would see understated budget consumption.
    const items: RawItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let totalCost = 0;
    do {
      if (pages >= GitHubProjectClient.MAX_PAGES) {
        throw new Error(
          `fetchAllItems exceeded ${GitHubProjectClient.MAX_PAGES} pages — ` +
          `runaway pagination? Aggregated ${items.length} items so far. ` +
          `If the project is genuinely this large, raise MAX_PAGES; ` +
          `otherwise check the endCursor logic for a loop.`,
        );
      }
      const result: any = await this.gql(`
        query($projectId: ID!, $cursor: String) {
          rateLimit { remaining resetAt cost }
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor, orderBy: { field: POSITION, direction: ASC }) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  fieldValueByName(name: "Status") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                    }
                  }
                  content {
                    ... on Issue {${ISSUE_FIELDS}
                    }
                  }
                }
              }
            }
          }
        }
      `, { projectId: this.projectId, cursor });
      pages++;

      if (result.rateLimit) {
        totalCost += result.rateLimit.cost ?? 0;
        // Capture the most recent remaining/resetAt; sum the cost
        // across pages for accurate per-cycle budget logging.
        this.lastRateLimit = {
          remaining: result.rateLimit.remaining,
          resetAt: result.rateLimit.resetAt,
          cost: totalCost,
        };
      }

      for (const node of result.node.items.nodes) {
        const itemStatus = node.fieldValueByName?.name;
        if (!node.content) continue;
        // Skip non-Issue content (PR fragment, DraftIssue) — number is
        // undefined on those so any downstream code keying on it would
        // silently misbehave.
        if (typeof node.content.number !== "number") continue;

        items.push(toRawItem(node.id, itemStatus, node.content));
      }

      const pageInfo = result.node.items.pageInfo;
      cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor !== null);

    const openIssues = await this.fetchOpenIssueItems();
    if (!openIssues) return items;
    const { items: merged, gaps } = mergeListingWithOpenIssues(items, openIssues);
    const report = decideListingGapReport(this.listingGapActive, gaps, this.config.repo);
    this.listingGapActive = report.active;
    if (report.log) console.log(report.log);
    if (report.notify) {
      console.warn(`   ${report.notify}`);
      this.listingGapHandler?.(report.notify);
    }
    return merged;
  }

  /**
   * Every OPEN issue in the configured repository that has an item on
   * this board, with that item's id and column. Read from the issues
   * rather than the board listing, so it is current even while GitHub's
   * project index lags; see `mergeListingWithOpenIssues`. About 2 GraphQL
   * points a page of 100 open issues. Returns null on any failure, and the
   * caller falls back to the listing alone, which is the behaviour before
   * this read existed.
   */
  private async fetchOpenIssueItems(): Promise<RawItem[] | null> {
    const items: RawItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    try {
      do {
        if (pages >= GitHubProjectClient.MAX_PAGES) {
          throw new Error(`more than ${GitHubProjectClient.MAX_PAGES} pages of open issues`);
        }
        const result: any = await this.gql(`
          query($owner: String!, $repo: String!, $cursor: String) {
            rateLimit { remaining resetAt cost }
            repository(owner: $owner, name: $repo) {
              issues(states: OPEN, first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {${ISSUE_FIELDS}
                  projectItems(first: 10) {
                    nodes {
                      id
                      project { id }
                      fieldValueByName(name: "Status") {
                        ... on ProjectV2ItemFieldSingleSelectValue {
                          name
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `, { owner: this.config.owner, repo: this.config.repo, cursor });
        pages++;
        if (result.rateLimit && this.lastRateLimit) {
          this.lastRateLimit = {
            remaining: result.rateLimit.remaining,
            resetAt: result.rateLimit.resetAt,
            cost: this.lastRateLimit.cost + (result.rateLimit.cost ?? 0),
          };
        }
        for (const issue of result.repository.issues.nodes) {
          const onBoard = (issue.projectItems?.nodes ?? []).find((pi: any) => pi?.project?.id === this.projectId);
          if (!onBoard) continue;
          items.push(toRawItem(onBoard.id, onBoard.fieldValueByName?.name, issue));
        }
        const pageInfo = result.repository.issues.pageInfo;
        cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
      } while (cursor !== null);
    } catch (e: any) {
      console.warn(`   ⚠️  Open-issue read failed, using the board listing alone this cycle: ${e?.message ?? e}`);
      return null;
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
   * Every item on the board — all columns, closed issues included — from
   * the same per-cycle cached fetch the status-filtered reads use.
   *
   * The family circuit breaker needs a label lookup for family ROOTS,
   * and a split family's root usually sits CLOSED in Done — visible to
   * neither `getItemsByStatus` (open only) nor `getClosedItemsNotInDone`
   * (closed outside Done only). This is the one reader that sees the
   * whole board. Costs nothing extra: same snapshot, same cache.
   */
  async getAllProjectItems(): Promise<ProjectItem[]> {
    const all = await this.getAllItems();
    return all.map(stripState);
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

  /** Close an issue as completed. Used by `runParentClose`. */
  async closeIssue(issueNumber: number): Promise<void> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `token ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to close issue: ${response.statusText}`);
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

  async getOpenBlockers(issueNumber: number): Promise<number[]> {
    const result: any = await this.gql(`
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            blockedBy(first: 100) { nodes { number state } pageInfo { hasNextPage } }
          }
        }
      }
    `, { owner: this.config.owner, repo: this.config.repo, number: issueNumber });
    const blockers = result.repository?.issue?.blockedBy;
    if (!blockers || blockers.pageInfo?.hasNextPage) {
      throw new Error(`Could not read every blocker for #${issueNumber}`);
    }
    return blockers.nodes.filter((b: { state: string }) => b.state === "OPEN")
      .map((b: { number: number }) => b.number);
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
   * Every open issue carrying `label`, with its body, across all pages.
   * Pull requests share the issues endpoint and are dropped.
   */
  async listOpenIssuesWithLabel(label: string): Promise<{ number: number; body: string }[]> {
    const found: { number: number; body: string }[] = [];
    for (let page = 1; ; page++) {
      const response = await fetchWithRetry(
        `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues` +
          `?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `token ${this.config.token}`,
            Accept: "application/vnd.github+json",
          },
        },
        3,
        1000,
        true, // a read is idempotent — retry transient GitHub 5xx/429
      );
      if (!response.ok) {
        throw new Error(`Failed to list issues labelled ${label}: ${response.status} ${response.statusText}`);
      }
      const batch: any[] = (await response.json()) as any[];
      for (const issue of batch) {
        if (issue.pull_request) continue;
        found.push({ number: issue.number, body: issue.body ?? "" });
      }
      if (batch.length < 100) return found;
    }
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
      },
      3,
      1000,
      true, // adding a label is idempotent — retry transient GitHub 5xx/429
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
      },
      3,
      1000,
      true, // removing a label is idempotent (404-tolerant) — retry transient GitHub 5xx/429
    );

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to remove label: ${response.statusText}`);
    }
  }

  /**
   * The createdAt of the most recent dispatcher auto-retry comment on an
   * issue — the marker-tagged comment posted on each transient-error retry
   * (agent-dispatcher#25). This is the board-encoded "last failure time"
   * the poll loop uses to compute backoff eligibility, so the schedule
   * survives the frequent dispatcher restarts.
   *
   * Returns null when the issue's comments contain NO marker comment
   * (schedule lost / never posted → the caller treats the ticket as
   * immediately eligible rather than trapping it forever). THROWS on fetch
   * failure (fetchWithRetry exhausted) so the caller can hold the ticket a
   * cycle instead of hammering a degraded API.
   *
   * Scans for the max createdAt among marker comments rather than trusting
   * sort order — robust regardless of how GitHub paginates/orders. One page
   * (100) is far more than any ticket accrues in practice.
   */
  async getLatestRetryAt(issueNumber: number): Promise<Date | null> {
    return latestMarkerAt(await this.fetchIssueComments(issueNumber), AUTO_RETRY_COMMENT_MARKER);
  }

  /**
   * One page of an issue's comments. Shared by the three marker readers
   * below (auto-retry time, auto-retry count, stranded-`wip:` markers) so
   * they can't drift apart. THROWS on fetch failure (fetchWithRetry
   * exhausted); each caller decides what a failed read means for it.
   *
   * One page (100) is far more than any ticket accrues in practice.
   */
  private async fetchIssueComments(issueNumber: number): Promise<any[]> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/comments?per_page=100`,
      {
        headers: {
          Authorization: `token ${this.config.token}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch comments: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * The two stranded-`wip:` sweep markers on an issue, newest of each kind,
   * from one comments fetch. `observedAt` is when the sweep first saw a
   * `wip:` label it believes nothing is running; `sweptAt` is when it last
   * acted on one. The sweep compares them: a swept marker at or newer than
   * the observed one means the observation has already been spent, so the
   * clock restarts rather than firing again on a fresh dispatch.
   *
   * THROWS on fetch failure — the sweep skips that ticket for the cycle
   * rather than stripping a label it could not justify.
   */
  async getStrandedWipMarkers(issueNumber: number): Promise<{ observedAt: Date | null; sweptAt: Date | null }> {
    const comments = await this.fetchIssueComments(issueNumber);
    return {
      observedAt: latestMarkerAt(comments, STRANDED_WIP_OBSERVED_MARKER),
      sweptAt: latestMarkerAt(comments, STRANDED_WIP_SWEPT_MARKER),
    };
  }

  /**
   * How many dispatcher auto-retry marker comments an issue carries. This is
   * the durable attempt count the retry scheduler falls back to when the
   * `error-retry-count:N` label failed to persist — otherwise a repeated
   * label-write failure would reset the attempt to 1 each time and the cap
   * could never trip. THROWS on fetch failure; the caller treats an unread
   * count as 0 and proceeds.
   */
  async countRetryMarkers(issueNumber: number): Promise<number> {
    const comments = await this.fetchIssueComments(issueNumber);
    let count = 0;
    for (const c of comments) {
      if (typeof c?.body === "string" && c.body.includes(AUTO_RETRY_COMMENT_MARKER)) count++;
    }
    return count;
  }

  /**
   * The family circuit breaker's durable state on a family ROOT issue,
   * read from its comments in one fetch:
   *
   *   - `markerCount` — how many family-dispatch marker comments the root
   *     carries SINCE THE LATEST RESET comment. One marker is posted per
   *     dispatch of any family member, so the count IS the family's
   *     dispatch tally (comments are durable; labels can fail to write
   *     silently — the transient-retry code learned this). An operator
   *     posting the reset marker zeroes the tally for that family alone.
   *   - `breakerCommented` — whether the trip explanation has been posted
   *     since the latest reset, so a family that stays tripped explains
   *     itself exactly once per runaway, and a resumed family that runs
   *     away again explains itself again.
   *
   * The fold itself is `tallyFamilyComments` (pipeline-decisions.ts) —
   * pure and shared with the test mock, so the two never disagree.
   *
   * One page (100 comments) mirrors `countRetryMarkers`; a root that
   * accrues more than 100 comments under-counts and trips late rather
   * than crashing. THROWS on fetch failure — the caller
   * (`runFamilyBreaker`) fails open for the cycle, falling back to the
   * convenience label.
   */
  async getFamilyDispatchState(
    issueNumber: number,
  ): Promise<{ markerCount: number; breakerCommented: boolean }> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/comments?per_page=100`,
      {
        headers: {
          Authorization: `token ${this.config.token}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch comments: ${response.statusText}`);
    }

    const comments: any[] = await response.json();
    return tallyFamilyComments(comments);
  }
}
