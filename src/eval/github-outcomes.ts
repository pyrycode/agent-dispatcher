// GitHub outcome extractor for the offline eval harness.
//
// For each ticket, pulls the signals the evals join against: label
// events with timestamps from the issue timeline (labeled/unlabeled —
// including transient done:*/needs-rework:*/wip:* labels, which persist
// in the timeline after removal), project column moves
// (ProjectV2ItemStatusChangedEvent), the parent chain, and closing PRs
// with merge state and diff size.
//
// All network access goes through `gh` via an injected execFile —
// argv-only, no shell interpolation anywhere. Every raw issue node is
// cached as JSON under the cache dir (default .eval-cache/), so a rerun
// hits the cache and makes zero network calls. GraphQL stays batched:
// one aliased query per BATCH_SIZE tickets, well under 1000 points for
// a few hundred tickets.
//
// Pure functions do all the parsing; `fetchTicketOutcomes` is the one
// orchestrator with side effects, and every side effect it performs is
// an injected dep.

export interface LabelEvent {
  type: "labeled" | "unlabeled";
  label: string;
  at: string;
}

export interface StatusMove {
  previousStatus: string;
  status: string;
  at: string;
}

export interface ClosingPr {
  number: number;
  merged: boolean;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface TicketOutcome {
  number: number;
  /** MISSING: the issue does not exist in the repo (or is invisible). */
  state: "OPEN" | "CLOSED" | "MISSING";
  closedAt: string | null;
  /** [parent, grandparent], as far as the ticket has them. */
  parentChain: number[];
  labelEvents: LabelEvent[];
  statusMoves: StatusMove[];
  closingPrs: ClosingPr[];
  timelineTotal: number;
  /** True when pagination stopped before draining the timeline. */
  timelineIncomplete: boolean;
}

/** Tickets per aliased GraphQL query. 20 keeps each response modest and
 *  the whole corpus at a handful of calls. */
const BATCH_SIZE = 20;

/** Follow-up timeline pages fetched per ticket before giving up and
 *  flagging `timelineIncomplete`. 5 pages = 500 filtered events. */
const MAX_TIMELINE_PAGES = 5;

const SCOPE_REDUCTION_CAP = 200;

const RATE_LIMIT_BACKOFF_MS = 30_000;

export function splitRepo(slug: string): { owner: string; repo: string } {
  const m = slug.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error(`repo must be owner/name, got: ${slug}`);
  return { owner: m[1], repo: m[2] };
}

function assertTicketNumber(n: number): void {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`not a ticket number: ${n}`);
}

/** GraphQL string literal with escaping — used for the identifiers that
 *  end up inside quotes. Everything else interpolated into a query is a
 *  validated integer. */
function gqlString(value: string): string {
  if (!/^[\w./=+-]*$/.test(value)) throw new Error(`refusing to interpolate into GraphQL: ${value}`);
  return `"${value}"`;
}

const TIMELINE_FIELDS = `totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on LabeledEvent { createdAt label { name } }
          ... on UnlabeledEvent { createdAt label { name } }
          ... on ProjectV2ItemStatusChangedEvent { createdAt previousStatus status }
        }`;

function issueFields(timelineArgs: string): string {
  return `number
      state
      closedAt
      parent { number parent { number } }
      closedByPullRequestsReferences(includeClosedPrs: true, first: 20) {
        nodes { number merged mergedAt additions deletions changedFiles }
      }
      timelineItems(${timelineArgs}) {
        ${TIMELINE_FIELDS}
      }`;
}

const TIMELINE_ARGS = "first: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]";

/** One aliased query for a batch of tickets. */
export function buildBatchQuery(owner: string, repo: string, numbers: number[]): string {
  for (const n of numbers) assertTicketNumber(n);
  const aliases = numbers
    .map((n) => `i${n}: issue(number: ${n}) {\n      ${issueFields(TIMELINE_ARGS)}\n    }`)
    .join("\n    ");
  return `query {
  repository(owner: ${gqlString(owner)}, name: ${gqlString(repo)}) {
    ${aliases}
  }
  rateLimit { cost remaining }
}`;
}

/** Continuation query for one ticket's timeline. */
export function buildTimelinePageQuery(owner: string, repo: string, number: number, cursor: string): string {
  assertTicketNumber(number);
  return `query {
  repository(owner: ${gqlString(owner)}, name: ${gqlString(repo)}) {
    issue(number: ${number}) {
      timelineItems(${TIMELINE_ARGS}, after: ${gqlString(cursor)}) {
        ${TIMELINE_FIELDS}
      }
    }
  }
  rateLimit { cost remaining }
}`;
}

export function cacheFilePath(cacheDir: string, number: number): string {
  return `${cacheDir}/issue-${number}.json`;
}

interface RawTimelineNode {
  __typename: string;
  createdAt?: string;
  label?: { name: string };
  previousStatus?: string;
  status?: string;
}

interface RawIssueNode {
  number?: number;
  state?: string;
  closedAt?: string | null;
  parent?: { number: number; parent?: { number: number } | null } | null;
  closedByPullRequestsReferences?: { nodes?: (ClosingPr | null)[] };
  timelineItems?: {
    totalCount?: number;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    nodes?: (RawTimelineNode | null)[];
  };
}

/** Parse one cached/fetched raw issue node. `null` means the issue was
 *  not found — kept as a MISSING outcome so reruns do not refetch it. */
export function parseIssueNode(number: number, node: RawIssueNode | null): TicketOutcome {
  if (node === null) {
    return {
      number,
      state: "MISSING",
      closedAt: null,
      parentChain: [],
      labelEvents: [],
      statusMoves: [],
      closingPrs: [],
      timelineTotal: 0,
      timelineIncomplete: false,
    };
  }
  const labelEvents: LabelEvent[] = [];
  const statusMoves: StatusMove[] = [];
  for (const item of node.timelineItems?.nodes ?? []) {
    if (!item) continue;
    if (item.__typename === "LabeledEvent" && item.label && item.createdAt) {
      labelEvents.push({ type: "labeled", label: item.label.name, at: item.createdAt });
    } else if (item.__typename === "UnlabeledEvent" && item.label && item.createdAt) {
      labelEvents.push({ type: "unlabeled", label: item.label.name, at: item.createdAt });
    } else if (item.__typename === "ProjectV2ItemStatusChangedEvent" && item.createdAt) {
      statusMoves.push({
        previousStatus: item.previousStatus ?? "",
        status: item.status ?? "",
        at: item.createdAt,
      });
    }
  }
  labelEvents.sort((a, b) => a.at.localeCompare(b.at));
  statusMoves.sort((a, b) => a.at.localeCompare(b.at));
  const parentChain: number[] = [];
  if (node.parent) {
    parentChain.push(node.parent.number);
    if (node.parent.parent) parentChain.push(node.parent.parent.number);
  }
  return {
    number,
    state: node.state === "CLOSED" ? "CLOSED" : "OPEN",
    closedAt: node.closedAt ?? null,
    parentChain,
    labelEvents,
    statusMoves,
    closingPrs: (node.closedByPullRequestsReferences?.nodes ?? []).filter((pr): pr is ClosingPr => pr !== null),
    timelineTotal: node.timelineItems?.totalCount ?? 0,
    timelineIncomplete: node.timelineItems?.pageInfo?.hasNextPage === true,
  };
}

export function isRateLimitError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}` : String(error);
  return /rate limit|RATE_LIMITED|HTTP 429|secondary rate/i.test(text);
}

/** The most recent `cap` tickets by number — the fallback scope when
 *  the API keeps rate-limiting a full-corpus fetch. */
export function reduceScopeTickets(tickets: number[], cap: number): number[] {
  if (tickets.length <= cap) return [...tickets];
  return [...tickets].sort((a, b) => b - a).slice(0, cap);
}

export interface FetchDeps {
  /** Run `gh` with argv only. Must reject on nonzero exit; the rejection
   *  should carry stdout/stderr when available (node's execFile does). */
  execFile: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  /** Returns file content, or null when absent. */
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  mkdir: (path: string) => void;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export interface FetchOptions {
  /** owner/name slug, e.g. pyrycode/pyrycode. */
  repo: string;
  tickets: number[];
  cacheDir: string;
}

export interface FetchResult {
  outcomes: Map<number, TicketOutcome>;
  networkCalls: number;
  /** True when a persistent rate limit forced the most-recent-200 fallback. */
  reducedScope: boolean;
}

interface GraphQLEnvelope {
  data?: {
    repository?: Record<string, RawIssueNode | null> & { issue?: RawIssueNode | null };
    rateLimit?: { cost: number; remaining: number };
  };
}

async function runGraphQL(deps: FetchDeps, query: string): Promise<GraphQLEnvelope> {
  // gh exits nonzero when the response carries GraphQL errors (e.g. a
  // missing issue alias) while still printing the body with the partial
  // data. Parse stdout either way; only a body with no data is a failure.
  let stdout: string;
  try {
    ({ stdout } = await deps.execFile("gh", ["api", "graphql", "-f", `query=${query}`]));
  } catch (error) {
    const failed = error as { stdout?: string };
    if (typeof failed.stdout === "string" && failed.stdout.length > 0) {
      try {
        const body = JSON.parse(failed.stdout) as GraphQLEnvelope;
        if (body.data) return body;
      } catch {
        // fall through to rethrow the original error
      }
    }
    throw error;
  }
  return JSON.parse(stdout) as GraphQLEnvelope;
}

/** One GraphQL call with rate-limit handling: back off once and retry;
 *  a second rate limit escalates to the caller for scope reduction. */
async function runWithBackoff(deps: FetchDeps, query: string): Promise<GraphQLEnvelope> {
  try {
    return await runGraphQL(deps, query);
  } catch (error) {
    if (!isRateLimitError(error)) throw error;
    deps.log(`   rate limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s before one retry`);
    await deps.sleep(RATE_LIMIT_BACKOFF_MS);
    return await runGraphQL(deps, query);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Drain one ticket's remaining timeline pages into its raw node, so
 *  the cached node is complete. Mutates and returns the node. */
async function drainTimeline(
  deps: FetchDeps,
  owner: string,
  repo: string,
  number: number,
  node: RawIssueNode,
  countCall: () => void,
): Promise<RawIssueNode> {
  let pages = 0;
  while (node.timelineItems?.pageInfo?.hasNextPage && node.timelineItems.pageInfo.endCursor && pages < MAX_TIMELINE_PAGES) {
    const query = buildTimelinePageQuery(owner, repo, number, node.timelineItems.pageInfo.endCursor);
    countCall();
    const body = await runWithBackoff(deps, query);
    const page = body.data?.repository?.issue?.timelineItems;
    if (!page) break;
    node.timelineItems.nodes = [...(node.timelineItems.nodes ?? []), ...(page.nodes ?? [])];
    node.timelineItems.pageInfo = page.pageInfo ?? { hasNextPage: false, endCursor: null };
    pages++;
  }
  return node;
}

/** Cache-first outcome fetch. Reruns with a warm cache make zero
 *  network calls; cold tickets are fetched in aliased batches. */
export async function fetchTicketOutcomes(options: FetchOptions, deps: FetchDeps): Promise<FetchResult> {
  const { owner, repo } = splitRepo(options.repo);
  const outcomes = new Map<number, TicketOutcome>();
  let networkCalls = 0;
  let reducedScope = false;
  const countCall = () => {
    networkCalls++;
  };

  deps.mkdir(options.cacheDir);

  let misses: number[] = [];
  for (const ticket of options.tickets) {
    const cached = deps.readFile(cacheFilePath(options.cacheDir, ticket));
    if (cached !== null) {
      outcomes.set(ticket, parseIssueNode(ticket, JSON.parse(cached) as RawIssueNode | null));
    } else {
      misses.push(ticket);
    }
  }
  if (misses.length > 0) {
    deps.log(`   ${outcomes.size} tickets cached, fetching ${misses.length} from GitHub`);
  }

  let batches = chunk(misses, BATCH_SIZE);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    let body: GraphQLEnvelope;
    countCall();
    try {
      body = await runWithBackoff(deps, buildBatchQuery(owner, repo, batch));
    } catch (error) {
      if (!isRateLimitError(error) || reducedScope) throw error;
      // Persistent rate limit: reduce scope to the most recent 200
      // tickets not yet fetched, drop the rest, and continue.
      reducedScope = true;
      const remaining = batches.slice(b).flat();
      const kept = reduceScopeTickets(remaining, SCOPE_REDUCTION_CAP);
      deps.log(`   still rate limited — reducing scope to the ${kept.length} most recent tickets (dropping ${remaining.length - kept.length})`);
      batches = [...batches.slice(0, b), ...chunk(kept, BATCH_SIZE)];
      b--;
      continue;
    }
    const repository = body.data?.repository ?? {};
    for (const ticket of batch) {
      const raw = (repository[`i${ticket}`] ?? null) as RawIssueNode | null;
      const complete = raw === null ? null : await drainTimeline(deps, owner, repo, ticket, raw, countCall);
      deps.writeFile(cacheFilePath(options.cacheDir, ticket), JSON.stringify(complete));
      outcomes.set(ticket, parseIssueNode(ticket, complete));
    }
    const remaining = body.data?.rateLimit?.remaining;
    if (remaining !== undefined && remaining < 200) {
      deps.log(`   rateLimit.remaining=${remaining} — pausing ${RATE_LIMIT_BACKOFF_MS / 1000}s`);
      await deps.sleep(RATE_LIMIT_BACKOFF_MS);
    }
  }

  return { outcomes, networkCalls, reducedScope };
}
