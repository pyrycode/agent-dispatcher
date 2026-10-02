// Integration tests for the transient-error auto-retry wiring
// (agent-dispatcher#25): handleDispatchError's schedule-vs-park decision and
// holdBackoffWaiters' poll-loop gate. Self-contained — builds its own minimal
// DispatchClient mock + DispatchContext from exported types, so it doesn't
// depend on dispatch.test.ts's harness. node:test to match the repo.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  handleDispatchError,
  holdBackoffWaiters,
  DEFAULT_DEPS,
  type DispatchClient,
  type DispatchContext,
  type StreamResult,
} from "./dispatch.js";
import { ResourceExhaustedError } from "./agent-runtime.js";
import { CodexStreamAdapter } from "./agent-runner.js";
import { AGENTS, type ProjectItem } from "./types.js";

const RETRY_MARKER = "<!-- pyry-auto-retry -->";

class FakeClient implements DispatchClient {
  addLabelCalls: { issueNumber: number; label: string }[] = [];
  removeLabelCalls: { issueNumber: number; label: string }[] = [];
  comments: { issueNumber: number; body: string }[] = [];
  getLatestRetryAtCalls: number[] = [];
  retryAtByIssue = new Map<number, Date | null>();
  failRetryAt: Error | null = null;
  // Simulate a transient GitHub failure on the counter-label write.
  failAddLabel: Error | null = null;
  // Simulate a transient GitHub failure on the marker-comment write. Set
  // alongside failAddLabel to model an outage taking BOTH durable writes.
  failAddComment: Error | null = null;
  // Marker comments already on the issue before this run (durable prior
  // attempts that the counter label never persisted).
  markerCountByIssue = new Map<number, number>();

  async addLabel(issueNumber: number, label: string) {
    if (this.failAddLabel && label.startsWith("error-retry-count:")) throw this.failAddLabel;
    this.addLabelCalls.push({ issueNumber, label });
  }
  async removeLabel(issueNumber: number, label: string) { this.removeLabelCalls.push({ issueNumber, label }); }
  async addComment(issueNumber: number, body: string) {
    if (this.failAddComment) throw this.failAddComment;
    this.comments.push({ issueNumber, body });
  }
  async getIssueLabels() { return []; }
  async getOpenBlockers() { return []; }
  async getItemStatus() { return null; }
  async getItemsByStatus() { return []; }
  async getClosedItemsNotInDone() { return []; }
  async getAllProjectItems() { return []; }
  async getStrandedWipMarkers() { return { observedAt: null, sweptAt: null }; }
  clearItemsCache() { /* no-op */ }
  async updateItemStatus() { /* no-op */ }
  async closeIssue() { /* no-op */ }
  async getLatestRetryAt(issueNumber: number) {
    this.getLatestRetryAtCalls.push(issueNumber);
    if (this.failRetryAt) throw this.failRetryAt;
    return this.retryAtByIssue.get(issueNumber) ?? null;
  }
  async countRetryMarkers(issueNumber: number) {
    const posted = this.comments.filter((c) => c.issueNumber === issueNumber && c.body.includes(RETRY_MARKER)).length;
    return (this.markerCountByIssue.get(issueNumber) ?? 0) + posted;
  }
  async getFamilyDispatchState(_issueNumber: number) {
    return { markerCount: 0, breakerCommented: false };
  }
  async getIssueCommentBodies(issueNumber: number) {
    return this.comments.filter((c) => c.issueNumber === issueNumber).map((c) => c.body);
  }
  labels() { return this.addLabelCalls.map((c) => c.label); }
}

function makeItem(over: Partial<ProjectItem> & { issueNumber: number }): ProjectItem {
  return {
    id: over.id ?? `it-${over.issueNumber}`,
    issueId: over.issueId ?? `node-${over.issueNumber}`,
    issueNumber: over.issueNumber,
    title: over.title ?? "test ticket",
    body: over.body ?? "",
    status: over.status ?? "In Development",
    labels: over.labels ?? [],
    url: over.url ?? "https://example.com/1",
    blockedBy: over.blockedBy ?? [],
    parentNumber: over.parentNumber ?? null,
    grandparentNumber: over.grandparentNumber ?? null,
  };
}

function makeCtx(
  item: ProjectItem,
  client: DispatchClient,
  discord: string[],
): DispatchContext {
  const agent = AGENTS.find((a) => a.name === "developer")!;
  return {
    agent,
    item,
    client,
    branchName: `feature/${item.issueNumber}`,
    worktreeDir: "/tmp/wt",
    useWorktree: true,
    agentCwd: "/tmp/wt",
    logFile: "/dev/null",
    startTime: 0,
    startTs: "00:00",
    deps: { ...DEFAULT_DEPS, notifyDiscord: async (m: string) => { discord.push(m); } },
  };
}

/** Minimal StreamResult carrying just the field the retry decision reads.
 *  handleDispatchError only touches `sessionId` and `terminalReason`. */
function makeStreamResult(terminalReason: string): StreamResult {
  return {
    output: "",
    sessionId: "unknown",
    isError: true,
    numTurns: 0,
    totalCostUsd: 0,
    durationMs: 0,
    usage: {},
    terminalReason,
    rawResult: {},
    hadPermissionDenial: false,
    stoppedAtDenial: false,
    deniedOpContent: null,
    lastAssistantText: null,
    timedOut: false,
  };
}

describe("handleDispatchError — transient auto-retry (agent-dispatcher#25)", () => {
  test("transient error → schedules a retry (counter + marker comment), no error: park, no manual-intervention alert", async () => {
    const client = new FakeClient();
    const discord: string[] = [];
    const ctx = makeCtx(makeItem({ issueNumber: 700 }), client, discord);
    await handleDispatchError(
      new Error("Agent error (error): socket connection was closed unexpectedly"),
      ctx,
      null,
    );
    assert.ok(client.labels().includes("error-retry-count:1"), "bumps the retry counter");
    assert.ok(!client.labels().includes("error:developer"), "must NOT park on the first transient failure");
    assert.ok(client.comments.some((c) => c.body.includes(RETRY_MARKER)), "posts the marker auto-retry comment");
    assert.ok(discord.some((m) => m.includes("auto-retry")), "notifies the scheduled retry");
    assert.ok(!discord.some((m) => m.includes("Manual intervention")), "no manual-intervention alert for a scheduled retry");
  });

  test("idle_stall (pyry watchdog, pyrycode#360) → schedules a retry, no error: park", async () => {
    const client = new FakeClient();
    const discord: string[] = [];
    const ctx = makeCtx(makeItem({ issueNumber: 706 }), client, discord);
    await handleDispatchError(
      new Error("Agent error (idle_stall): idle_stall: no stream activity for 240s while awaiting assistant turn"),
      ctx,
      null,
    );
    assert.ok(client.labels().includes("error-retry-count:1"), "bumps the retry counter");
    assert.ok(!client.labels().includes("error:developer"), "must NOT park a wedged stream on the first failure");
    assert.ok(client.comments.some((c) => c.body.includes(RETRY_MARKER)), "posts the marker auto-retry comment");
    assert.ok(discord.some((m) => m.includes("idle stream stall")), "names the idle-stall signature in the retry notice");
    assert.ok(!discord.some((m) => m.includes("Manual intervention")), "no manual-intervention alert for a scheduled retry");
  });

  test("transient error at the cap → parks with error:<agent> + exhaustion note", async () => {
    const client = new FakeClient();
    const discord: string[] = [];
    const ctx = makeCtx(makeItem({ issueNumber: 701, labels: ["error-retry-count:4"] }), client, discord);
    await handleDispatchError(new Error('API Error: 529 {"type":"overloaded_error"}'), ctx, null);
    assert.ok(client.labels().includes("error:developer"), "parks after the cap");
    assert.ok(client.comments.some((c) => c.body.includes("Transient retries exhausted")));
    assert.ok(!client.labels().includes("error-retry-count:5"), "does not bump past the cap");
  });

  // The structural arm: claude's own `terminal_reason` on the result frame,
  // not the wording. Both strings below are verbatim from the two runs that
  // parked pyrycode#1731 and #1747 on 2026-08-24 — neither matches any
  // RETRY_ALLOWLIST entry, and 15 of 79 such failures over the whole log
  // corpus parked a human on a wording the list had never seen.
  test("terminal_reason api_error → schedules a retry even though the wording matches nothing", async () => {
    for (const [issueNumber, message] of [
      [710, "Agent error (api_error): subtype=success api_error_status=403 stop_reason=stop_sequence. "
        + "Ran 4m 29s (timeout 20min). Last agent text (not the failure cause): "
        + "Failed to authenticate. API Error: 403 Unable to verify organization membership."],
      [711, "Agent error (api_error): subtype=success stop_reason=stop_sequence. "
        + "Ran 4m 38s (timeout 20min). Last agent text (not the failure cause): "
        + "API Error: Server error mid-response. The response above may be incomplete."],
    ] as [number, string][]) {
      const client = new FakeClient();
      const discord: string[] = [];
      const ctx = makeCtx(makeItem({ issueNumber }), client, discord);
      await handleDispatchError(new Error(message), ctx, makeStreamResult("api_error"));
      assert.ok(client.labels().includes("error-retry-count:1"), `#${issueNumber} bumps the retry counter`);
      assert.ok(!client.labels().includes("error:developer"), `#${issueNumber} must NOT park a server-side API failure`);
      assert.ok(client.comments.some((c) => c.body.includes(RETRY_MARKER)), `#${issueNumber} posts the marker comment`);
      assert.ok(discord.some((m) => m.includes("API error (server-side)")), `#${issueNumber} names the signature`);
      assert.ok(!discord.some((m) => m.includes("Manual intervention")), `#${issueNumber} raises no manual alert`);
    }
  });

  test("the same api_error failure still parks once the cap is reached", async () => {
    const client = new FakeClient();
    const discord: string[] = [];
    const ctx = makeCtx(makeItem({ issueNumber: 712, labels: ["error-retry-count:4"] }), client, discord);
    await handleDispatchError(
      new Error("Agent error (api_error): API Error: Server error mid-response."),
      ctx,
      makeStreamResult("api_error"),
    );
    assert.ok(client.labels().includes("error:developer"), "a persistent API outage still reaches a human");
    assert.ok(client.comments.some((c) => c.body.includes("Transient retries exhausted")));
  });

  test("terminal_reason timeout parks even when the narration matches the allowlist", async () => {
    // Guard against the structured reason widening into the deterministic
    // classes: a wall-clock kill must not buy a re-run because the agent
    // happened to narrate "fetch failed" before it died.
    const client = new FakeClient();
    const discord: string[] = [];
    const ctx = makeCtx(makeItem({ issueNumber: 713 }), client, discord);
    await handleDispatchError(
      new Error("Agent error (timeout): Last agent text (not the failure cause): TypeError: fetch failed"),
      ctx,
      makeStreamResult("timeout"),
    );
    assert.ok(client.labels().includes("error:developer"), "a wall-clock kill parks");
    assert.ok(!client.labels().some((l) => l.startsWith("error-retry-count:")), "and buys no retry");
  });

  test("non-transient error → parks immediately with error:<agent>, no retry counter", async () => {
    const client = new FakeClient();
    const discord: string[] = [];
    const ctx = makeCtx(makeItem({ issueNumber: 702 }), client, discord);
    await handleDispatchError(new Error("Agent error (max_turns): a real logic failure"), ctx, null);
    assert.ok(client.labels().includes("error:developer"));
    assert.ok(!client.labels().some((l) => l.startsWith("error-retry-count:")));
    assert.ok(discord.some((m) => m.includes("Manual intervention")));
  });

  test("ResourceExhaustedError (EAGAIN) is transient → schedules a retry, not an immediate resource_exhausted park", async () => {
    const client = new FakeClient();
    const ctx = makeCtx(makeItem({ issueNumber: 703 }), client, []);
    await handleDispatchError(new ResourceExhaustedError("EAGAIN", 5), ctx, null);
    assert.ok(client.labels().includes("error-retry-count:1"));
    assert.ok(!client.labels().includes("error:developer:resource_exhausted"), "no immediate resource_exhausted park");
  });

  test("ResourceExhaustedError parks with resource_exhausted once the cap is reached", async () => {
    const client = new FakeClient();
    const ctx = makeCtx(makeItem({ issueNumber: 704, labels: ["error-retry-count:4"] }), client, []);
    await handleDispatchError(new ResourceExhaustedError("EAGAIN", 5), ctx, null);
    assert.ok(client.labels().includes("error:developer:resource_exhausted"), "caps to resource_exhausted");
    const body = client.comments.map((c) => c.body).join("\n");
    assert.match(body, /Agent Spawn Failed/);
    assert.match(body, /EAGAIN/);
  });

  test("counter-label write failure → keeps the retry instead of parking (the #1093 bug: a bookkeeping write must not park a healthy ticket)", async () => {
    const client = new FakeClient();
    client.failAddLabel = new Error("502 Bad Gateway");
    const discord: string[] = [];
    const ctx = makeCtx(makeItem({ issueNumber: 710 }), client, discord);
    await handleDispatchError(
      new Error("Agent error (watchdog: PTY quiet for 30s): please run /login · API Error: 401 OAuth access token has expired"),
      ctx,
      null,
    );
    assert.ok(!client.labels().includes("error:developer"), "must NOT park when only the counter-label write failed");
    assert.ok(!client.labels().includes("error-retry-count:1"), "counter label did not persist (write threw)");
    assert.ok(client.comments.some((c) => c.body.includes(RETRY_MARKER)), "still posts the durable marker comment");
    assert.ok(discord.some((m) => m.includes("auto-retry")), "still notifies a scheduled retry, not a park");
    assert.ok(!discord.some((m) => m.includes("Manual intervention")), "no manual-intervention alert for a kept retry");
  });

  test("counter-label write keeps failing → still caps via the durable marker-comment count", async () => {
    const client = new FakeClient();
    client.failAddLabel = new Error("502 Bad Gateway");
    client.markerCountByIssue.set(711, 4); // 4 prior retries recorded ONLY as marker comments (labels never persisted)
    const discord: string[] = [];
    const ctx = makeCtx(makeItem({ issueNumber: 711 }), client, discord);
    await handleDispatchError(new Error("read ECONNRESET"), ctx, null);
    assert.ok(client.labels().includes("error:developer"), "parks at the cap even though the counter label never persisted");
    assert.ok(client.comments.some((c) => c.body.includes("Transient retries exhausted")), "notes the exhaustion");
  });

  test("BOTH durable writes fail → parks instead of scheduling a retry nothing recorded", async () => {
    // The 2026-09-08 stall. An outage takes the counter label AND the
    // marker comment, and the old code still returned a live attempt, so
    // handleDispatchError returned without parking. Nothing on the board
    // then said a retry was owed: the attempt count resets to 1 every
    // cycle, so the cap can never trip, holdBackoffWaiters has nothing to
    // hold, and the ticket re-runs back to back with no interval between
    // runs. Parking is the safe read of "we could not write this down".
    const client = new FakeClient();
    client.failAddLabel = new Error("502 Bad Gateway");
    client.failAddComment = new Error("502 Bad Gateway");
    const discord: string[] = [];
    const ctx = makeCtx(makeItem({ issueNumber: 712 }), client, discord);
    await handleDispatchError(new Error("read ECONNRESET"), ctx, null);

    assert.ok(client.labels().includes("error:developer"), "parks when the retry could not be recorded");
    assert.ok(!client.labels().includes("error-retry-count:1"), "no counter landed");
    assert.ok(!client.comments.some((c) => c.body.includes(RETRY_MARKER)), "no marker landed");
    assert.ok(!discord.some((m) => m.includes("auto-retry")), "must not claim a retry is scheduled");
    // Discord is a different service from the GitHub API and is usually
    // still up during one of these, so it is the alert that has to carry
    // the reason — the park's own label and comment may not land either.
    assert.ok(discord.some((m) => m.includes("could not be recorded")), "the alert says why it parked");
  });

  test("marker-comment write failure alone → keeps the retry (the counter label is record enough)", async () => {
    // The mirror of the #1093 case: either durable write landing on its
    // own is enough to keep a healthy ticket moving. Only losing BOTH is
    // a park.
    const client = new FakeClient();
    client.failAddComment = new Error("502 Bad Gateway");
    const discord: string[] = [];
    const ctx = makeCtx(makeItem({ issueNumber: 713 }), client, discord);
    await handleDispatchError(new Error("read ECONNRESET"), ctx, null);

    assert.ok(!client.labels().includes("error:developer"), "must NOT park when the counter landed");
    assert.ok(client.labels().includes("error-retry-count:1"));
    assert.ok(discord.some((m) => m.includes("auto-retry")));
  });

  test("scheduling a retry strips the stale counter before adding the next", async () => {
    const client = new FakeClient();
    const ctx = makeCtx(makeItem({ issueNumber: 705, labels: ["error-retry-count:1"] }), client, []);
    await handleDispatchError(new Error("read ECONNRESET"), ctx, null);
    assert.ok(client.removeLabelCalls.some((c) => c.label === "error-retry-count:1"));
    assert.ok(client.addLabelCalls.some((c) => c.label === "error-retry-count:2"));
  });
});

describe("holdBackoffWaiters — poll-loop backoff gate (agent-dispatcher#25)", () => {
  const NOW = 10_000_000;

  test("holds a ticket inside its window; keeps an elapsed retry and a normal ticket", async () => {
    const client = new FakeClient();
    const waiting = makeItem({ issueNumber: 201, labels: ["error-retry-count:1"] });
    const elapsed = makeItem({ issueNumber: 202, labels: ["error-retry-count:1"] });
    const normal = makeItem({ issueNumber: 203, labels: [] });
    client.retryAtByIssue.set(201, new Date(NOW));            // just failed → any positive backoff holds it
    client.retryAtByIssue.set(202, new Date(NOW - 6 * 60_000)); // 6min ago → past attempt-1 max (5min) for any jitter
    const byCol = new Map<string, ProjectItem[]>([["In Development", [waiting, elapsed, normal]]]);
    await holdBackoffWaiters(byCol, client, NOW);
    assert.deepEqual(
      byCol.get("In Development")!.map((i) => i.issueNumber).sort((a, b) => a - b),
      [202, 203],
    );
  });

  test("leaves a parked ticket (error:) in place and does not fetch its comments", async () => {
    const client = new FakeClient();
    const parked = makeItem({ issueNumber: 210, labels: ["error-retry-count:4", "error:developer"] });
    const byCol = new Map<string, ProjectItem[]>([["In Development", [parked]]]);
    await holdBackoffWaiters(byCol, client, NOW);
    assert.deepEqual(byCol.get("In Development")!.map((i) => i.issueNumber), [210]);
    assert.equal(client.getLatestRetryAtCalls.length, 0);
  });

  test("missing marker comment (null) → treated as eligible so a lost schedule never traps the ticket", async () => {
    const client = new FakeClient();
    const item = makeItem({ issueNumber: 220, labels: ["error-retry-count:2"] });
    client.retryAtByIssue.set(220, null);
    const byCol = new Map<string, ProjectItem[]>([["In QA", [item]]]);
    await holdBackoffWaiters(byCol, client, NOW);
    assert.deepEqual(byCol.get("In QA")!.map((i) => i.issueNumber), [220]);
  });

  test("comment-fetch failure → holds the ticket this cycle (no blind retry during an outage)", async () => {
    const client = new FakeClient();
    client.failRetryAt = new Error("503 Service Unavailable");
    const item = makeItem({ issueNumber: 230, labels: ["error-retry-count:1"] });
    const byCol = new Map<string, ProjectItem[]>([["In QA", [item]]]);
    await holdBackoffWaiters(byCol, client, NOW);
    assert.deepEqual(byCol.get("In QA")!.map((i) => i.issueNumber), []);
  });
});


describe("Codex temporary model-access failure, desktop #1351", () => {
  const message = "stream disconnected before completion: Unable to verify model access right now. Please retry.";

  function failedRun(options: { message?: string; blocked?: boolean; timedOut?: boolean } = {}) {
    const adapter = new CodexStreamAdapter();
    adapter.accept({ type: "thread.started", thread_id: "desktop-1351" });
    adapter.accept({ type: "turn.started" });
    adapter.accept({ type: "error", message: `Reconnecting... 5/5 (${message})` });
    if (options.blocked) adapter.accept({ type: "item.completed", item: {
      type: "command_execution", aggregated_output: "This action was rejected due to unacceptable risk",
    } });
    adapter.accept({ type: "turn.failed", error: { message: options.message ?? message } });
    return adapter.finish(1, options.timedOut ?? false, 43000);
  }

  test("recorded terminal failure schedules a delayed ticket retry", async () => {
    const result = failedRun();
    const client = new FakeClient();
    const discord: string[] = [];
    await handleDispatchError(new Error(result.output), makeCtx(makeItem({ issueNumber: 1351 }), client, discord), result);
    assert.equal(result.isError, true);
    assert.equal(result.output, message);
    assert.ok(client.labels().includes("error-retry-count:1"));
    assert.ok(!client.labels().includes("error:developer"));
    assert.ok(client.comments.some(c => c.body.includes(RETRY_MARKER)));
    assert.ok(discord.some(m => m.includes("auto-retry 1/4")));
  });

  test("persistent model-access failure still parks at the existing retry cap", async () => {
    const result = failedRun();
    const client = new FakeClient();
    await handleDispatchError(new Error(result.output), makeCtx(makeItem({ issueNumber: 1351, labels: ["error-retry-count:4"] }), client, []), result);
    assert.ok(client.labels().includes("error:developer"));
    assert.ok(client.comments.some(c => c.body.includes("Transient retries exhausted")));
    assert.ok(!client.labels().some(l => l.startsWith("error-retry-count:")));
  });

  for (const [name, options] of [
    ["approval rejection", { blocked: true }],
    ["timeout", { timedOut: true }],
    ["permanent model denial", { message: "stream disconnected before completion: You do not have access to this model." }],
    ["unrecognised failure", { message: "Codex turn failed" }],
  ] as const) {
    test(`${name} stays parked despite earlier reconnect diagnostics`, async () => {
      const result = failedRun(options);
      const client = new FakeClient();
      await handleDispatchError(new Error(result.output), makeCtx(makeItem({ issueNumber: 1351 }), client, []), result);
      assert.ok(client.labels().includes("error:developer"));
      assert.ok(!client.labels().some(l => l.startsWith("error-retry-count:")));
    });
  }

  test("successful reconnect does not become a failed run", () => {
    const adapter = new CodexStreamAdapter();
    adapter.accept({ type: "error", message });
    adapter.accept({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ status: "completed", summary: "Finished" }) } });
    adapter.accept({ type: "turn.completed", usage: {} });
    assert.equal(adapter.finish(0, false, 43000).isError, false);
  });
});
