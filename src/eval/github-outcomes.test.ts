// Unit tests for the GitHub outcome extractor's pure parts, plus the
// cache-first fetch orchestration against fully faked deps. No network,
// no filesystem. Run with:
//
//   pnpm exec tsx --test src/eval/github-outcomes.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildBatchQuery,
  buildTimelinePageQuery,
  cacheFilePath,
  fetchTicketOutcomes,
  isRateLimitError,
  parseIssueNode,
  reduceScopeTickets,
  splitRepo,
  type FetchDeps,
} from "./github-outcomes.js";

const NODE_1260 = {
  number: 1260,
  state: "CLOSED",
  closedAt: "2026-08-06T15:27:40Z",
  parent: { number: 1241, parent: { number: 1227 } },
  closedByPullRequestsReferences: {
    nodes: [
      { number: 1265, merged: true, mergedAt: "2026-08-06T15:27:39Z", additions: 3084, deletions: 7, changedFiles: 6 },
    ],
  },
  timelineItems: {
    totalCount: 5,
    pageInfo: { hasNextPage: false, endCursor: "abc" },
    nodes: [
      { __typename: "LabeledEvent", createdAt: "2026-08-02T18:13:42Z", label: { name: "size:s" } },
      { __typename: "ProjectV2ItemStatusChangedEvent", createdAt: "2026-08-02T18:14:13Z", previousStatus: "", status: "Backlog" },
      { __typename: "LabeledEvent", createdAt: "2026-08-02T18:18:22Z", label: { name: "wip:po" } },
      { __typename: "UnlabeledEvent", createdAt: "2026-08-02T18:24:57Z", label: { name: "wip:po" } },
      { __typename: "ProjectV2ItemStatusChangedEvent", createdAt: "2026-08-02T18:49:03Z", previousStatus: "In Architecture", status: "In Development" },
    ],
  },
};

describe("splitRepo", () => {
  test("splits owner/name", () => {
    assert.deepEqual(splitRepo("pyrycode/pyrycode"), { owner: "pyrycode", repo: "pyrycode" });
  });

  test("throws on a shape that is not owner/name", () => {
    assert.throws(() => splitRepo("nonsense"));
  });
});

describe("buildBatchQuery", () => {
  const query = buildBatchQuery("pyrycode", "pyrycode", [1260, 1266]);

  test("aliases each issue by number", () => {
    assert.match(query, /i1260: issue\(number: 1260\)/);
    assert.match(query, /i1266: issue\(number: 1266\)/);
  });

  test("asks for the three timeline item types with a full page", () => {
    assert.match(query, /itemTypes: \[LABELED_EVENT, UNLABELED_EVENT, PROJECT_V2_ITEM_STATUS_CHANGED_EVENT\]/);
    assert.match(query, /timelineItems\(first: 100/);
    assert.match(query, /pageInfo \{ hasNextPage endCursor \}/);
  });

  test("asks for closing PRs including closed ones, and the parent chain", () => {
    assert.match(query, /closedByPullRequestsReferences\(includeClosedPrs: true/);
    assert.match(query, /parent \{ number parent \{ number \} \}/);
  });

  test("rejects a non-numeric ticket instead of interpolating it", () => {
    assert.throws(() => buildBatchQuery("pyrycode", "pyrycode", [1260.5]));
    assert.throws(() => buildBatchQuery("pyrycode", "pyrycode", [Number.NaN]));
  });
});

describe("buildTimelinePageQuery", () => {
  test("continues one issue's timeline from a cursor", () => {
    const query = buildTimelinePageQuery("pyrycode", "pyrycode", 1260, "abc");
    assert.match(query, /issue\(number: 1260\)/);
    assert.match(query, /after: "abc"/);
  });

  test("rejects a cursor that could escape its quotes", () => {
    assert.throws(() => buildTimelinePageQuery("pyrycode", "pyrycode", 1260, 'x" ) { evil'));
  });
});

describe("parseIssueNode", () => {
  test("parses a full node into a ticket outcome", () => {
    const got = parseIssueNode(1260, NODE_1260);
    assert.equal(got.number, 1260);
    assert.equal(got.state, "CLOSED");
    assert.equal(got.closedAt, "2026-08-06T15:27:40Z");
    assert.deepEqual(got.parentChain, [1241, 1227]);
    assert.deepEqual(got.closingPrs, [
      { number: 1265, merged: true, mergedAt: "2026-08-06T15:27:39Z", additions: 3084, deletions: 7, changedFiles: 6 },
    ]);
    assert.deepEqual(got.labelEvents, [
      { type: "labeled", label: "size:s", at: "2026-08-02T18:13:42Z" },
      { type: "labeled", label: "wip:po", at: "2026-08-02T18:18:22Z" },
      { type: "unlabeled", label: "wip:po", at: "2026-08-02T18:24:57Z" },
    ]);
    assert.deepEqual(got.statusMoves, [
      { previousStatus: "", status: "Backlog", at: "2026-08-02T18:14:13Z" },
      { previousStatus: "In Architecture", status: "In Development", at: "2026-08-02T18:49:03Z" },
    ]);
    assert.equal(got.timelineTotal, 5);
    assert.equal(got.timelineIncomplete, false);
  });

  test("a null node is a missing ticket", () => {
    const got = parseIssueNode(999, null);
    assert.equal(got.state, "MISSING");
    assert.deepEqual(got.labelEvents, []);
    assert.deepEqual(got.parentChain, []);
  });

  test("an unfinished timeline page is flagged, not silently truncated", () => {
    const node = structuredClone(NODE_1260);
    node.timelineItems.pageInfo.hasNextPage = true;
    assert.equal(parseIssueNode(1260, node).timelineIncomplete, true);
  });

  test("a parentless issue has an empty chain", () => {
    const node = { ...structuredClone(NODE_1260), parent: null };
    assert.deepEqual(parseIssueNode(1260, node).parentChain, []);
  });
});

describe("cacheFilePath", () => {
  test("one JSON file per ticket under the cache dir", () => {
    assert.equal(cacheFilePath("/repo/.eval-cache", 1260), "/repo/.eval-cache/issue-1260.json");
  });
});

describe("isRateLimitError", () => {
  test("recognises rate-limit shapes", () => {
    assert.equal(isRateLimitError(new Error("HTTP 403: API rate limit exceeded")), true);
    assert.equal(isRateLimitError(new Error("was submitted too quickly: RATE_LIMITED")), true);
    assert.equal(isRateLimitError(new Error("HTTP 429")), true);
    assert.equal(isRateLimitError(new Error("connection refused")), false);
  });
});

describe("reduceScopeTickets", () => {
  test("keeps the most recent N tickets by number", () => {
    assert.deepEqual(reduceScopeTickets([5, 90, 12, 40], 2), [90, 40]);
  });

  test("leaves a small list alone", () => {
    assert.deepEqual(reduceScopeTickets([5, 12], 200), [5, 12]);
  });
});

function makeDeps(overrides: Partial<FetchDeps> & { responses?: string[] }): {
  deps: FetchDeps;
  calls: { args: string[][]; written: Map<string, string>; slept: number[] };
} {
  const written = new Map<string, string>();
  const args: string[][] = [];
  const slept: number[] = [];
  const responses = overrides.responses ?? [];
  const deps: FetchDeps = {
    execFile: async (_cmd, callArgs) => {
      args.push(callArgs);
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected network call");
      return { stdout: next };
    },
    readFile: () => null,
    writeFile: (path, content) => {
      written.set(path, content);
    },
    mkdir: () => {},
    sleep: async (ms) => {
      slept.push(ms);
    },
    log: () => {},
    ...overrides,
  };
  delete (deps as unknown as Record<string, unknown>).responses;
  return { deps, calls: { args, written, slept } };
}

function graphqlResponse(nodesByAlias: Record<string, unknown>): string {
  return JSON.stringify({ data: { repository: nodesByAlias, rateLimit: { cost: 1, remaining: 4000 } } });
}

describe("fetchTicketOutcomes", () => {
  test("hits the cache and makes zero network calls when everything is cached", async () => {
    const { deps, calls } = makeDeps({
      readFile: (path) => (path.endsWith("issue-1260.json") ? JSON.stringify(NODE_1260) : null),
    });
    const { outcomes, networkCalls } = await fetchTicketOutcomes(
      { repo: "pyrycode/pyrycode", tickets: [1260], cacheDir: "/c" },
      deps,
    );
    assert.equal(networkCalls, 0);
    assert.equal(calls.args.length, 0);
    assert.equal(outcomes.get(1260)?.state, "CLOSED");
  });

  test("fetches cache misses in one batched call and writes each raw node to the cache", async () => {
    const { deps, calls } = makeDeps({
      responses: [graphqlResponse({ i1260: NODE_1260, i999: null })],
    });
    const { outcomes, networkCalls } = await fetchTicketOutcomes(
      { repo: "pyrycode/pyrycode", tickets: [1260, 999], cacheDir: "/c" },
      deps,
    );
    assert.equal(networkCalls, 1);
    assert.equal(calls.args.length, 1);
    // argv-only: gh api graphql -f query=... — no shell anywhere.
    assert.equal(calls.args[0][0], "api");
    assert.equal(calls.args[0][1], "graphql");
    assert.equal(outcomes.get(1260)?.state, "CLOSED");
    assert.equal(outcomes.get(999)?.state, "MISSING");
    assert.equal(calls.written.has("/c/issue-1260.json"), true);
    assert.equal(calls.written.has("/c/issue-999.json"), true);
    assert.deepEqual(JSON.parse(calls.written.get("/c/issue-1260.json")!), NODE_1260);
  });

  test("follows timeline pagination before caching, so the cache holds the merged node", async () => {
    const page1 = structuredClone(NODE_1260);
    page1.timelineItems.pageInfo.hasNextPage = true;
    page1.timelineItems.pageInfo.endCursor = "cur1";
    const page2 = {
      data: {
        repository: {
          issue: {
            timelineItems: {
              pageInfo: { hasNextPage: false, endCursor: "cur2" },
              nodes: [
                { __typename: "LabeledEvent", createdAt: "2026-08-07T00:00:00Z", label: { name: "needs-rework:developer" } },
              ],
            },
          },
        },
        rateLimit: { cost: 1, remaining: 4000 },
      },
    };
    const { deps, calls } = makeDeps({
      responses: [graphqlResponse({ i1260: page1 }), JSON.stringify(page2)],
    });
    const { outcomes, networkCalls } = await fetchTicketOutcomes(
      { repo: "pyrycode/pyrycode", tickets: [1260], cacheDir: "/c" },
      deps,
    );
    assert.equal(networkCalls, 2);
    const outcome = outcomes.get(1260)!;
    assert.equal(outcome.timelineIncomplete, false);
    assert.equal(outcome.labelEvents.at(-1)?.label, "needs-rework:developer");
    const cached = JSON.parse(calls.written.get("/c/issue-1260.json")!);
    assert.equal(cached.timelineItems.nodes.length, 6);
    assert.equal(cached.timelineItems.pageInfo.hasNextPage, false);
  });

  test("backs off and retries once on a rate limit", async () => {
    const { deps, calls } = makeDeps({});
    let attempt = 0;
    deps.execFile = async (_cmd, callArgs) => {
      calls.args.push(callArgs);
      attempt++;
      if (attempt === 1) throw new Error("HTTP 403: API rate limit exceeded");
      return { stdout: graphqlResponse({ i1260: NODE_1260 }) };
    };
    const { outcomes } = await fetchTicketOutcomes(
      { repo: "pyrycode/pyrycode", tickets: [1260], cacheDir: "/c" },
      deps,
    );
    assert.equal(calls.slept.length, 1);
    assert.equal(outcomes.get(1260)?.state, "CLOSED");
  });

  test("reduces scope to the most recent 200 tickets on a persistent rate limit", async () => {
    const tickets = Array.from({ length: 300 }, (_, i) => i + 1); // 1..300
    const { deps, calls } = makeDeps({});
    let failures = 0;
    deps.execFile = async (_cmd, callArgs) => {
      calls.args.push(callArgs);
      if (failures < 2) {
        failures++;
        throw new Error("HTTP 403: API rate limit exceeded");
      }
      // Answer whatever aliases were asked for with nulls (missing) —
      // scope is what this test measures, not parsing.
      const q = callArgs[callArgs.indexOf("-f") + 1];
      const aliases = [...q.matchAll(/i(\d+): issue/g)].map((m) => Number(m[1]));
      return { stdout: graphqlResponse(Object.fromEntries(aliases.map((n) => [`i${n}`, null]))) };
    };
    const { outcomes, reducedScope } = await fetchTicketOutcomes(
      { repo: "pyrycode/pyrycode", tickets, cacheDir: "/c" },
      deps,
    );
    assert.equal(reducedScope, true);
    // Only the most recent 200 got fetched; 1..100 were dropped.
    assert.equal(outcomes.size, 200);
    assert.equal(outcomes.has(100), false);
    assert.equal(outcomes.has(300), true);
  });
});
