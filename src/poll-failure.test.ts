// A failed poll must not stop the dispatcher. Each test below rebuilds one
// error shape that reached the poll loop on 2026-10-12..14 and stopped a
// dispatcher for good (the fleet supervisor treats a stopped dispatcher as
// stopped on purpose), then checks the loop now retries it. Errors that make
// continuing unsafe still stop the process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { graphql } from "@octokit/graphql";
import { GitHubProjectClient } from "./github.js";
import { JsonClient } from "./fleet-http.js";
import { workflowClient } from "./workflow-client.js";
import {
  GitHubNoDataError,
  decidePollFailure,
  newPollOutage,
  pollRecovered,
  transientPollFailure,
} from "./poll-failure.js";

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}`, server };
}

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try { await work(); } catch (error) { return error; }
  throw new Error("expected the call to fail");
}

function boardClient(fetch: typeof globalThis.fetch): GitHubProjectClient {
  const client = new GitHubProjectClient({ owner: "pyrycode", repo: "pyrycode", projectNumber: 1, ownerType: "organization", token: "test" });
  (client as any).projectId = "PROJECT";
  (client as any).gql = graphql.defaults({ headers: { authorization: "token test" }, request: { fetch } });
  return client;
}

// Core, 2026-10-12: "TypeError: Cannot read properties of undefined (reading
// 'rateLimit') at GitHubProjectClient.fetchAllItems". GitHub answered 200
// with a body that had no data.
test("a GitHub reply without data is a typed outage error, and the poll retries it", async () => {
  const client = boardClient(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  const error = await caught(() => client.getItemsByStatus("Backlog"));
  assert.ok(!(error instanceof TypeError), `expected a typed error, got ${String(error)}`);
  assert.ok(error instanceof GitHubNoDataError);
  assert.match((error as Error).message, /no data/i);
  const decision = decidePollFailure(error, newPollOutage(), 0);
  assert.equal(decision.kind, "retry");
});

test("a reply with data but no project items is the same typed outage error", async () => {
  const client = boardClient(async () => new Response(JSON.stringify({ data: { rateLimit: { remaining: 1, resetAt: "x", cost: 1 }, node: null } }),
    { status: 200, headers: { "content-type": "application/json" } }));
  assert.ok(await caught(() => client.getItemsByStatus("Backlog")) instanceof GitHubNoDataError);
});

// Relay and Mobile: the claim service on pyrybox restarted. The local
// machine manager answered every workflow read with its catch-all 409.
test("the machine manager's 409 for an unreachable claim service is retried", async (t) => {
  const { url, server } = await serve((req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "fetch failed" }));
  });
  t.after(() => server.close());
  const client = workflowClient({}, new JsonClient(url, "token"), "pyrycode/pyrycode-relay", () => true, () => ({ session: "s" }));
  const error = await caught(() => (client as any).getItemsByStatus("In Development"));
  assert.match((error as Error).message, /^Service 409: \{"error":"fetch failed"\}$/);
  const decision = decidePollFailure(error, newPollOutage(), 0);
  assert.equal(decision.kind, "retry");
  if (decision.kind === "retry") assert.match(decision.log, /claim service/);
});

// Mobile: "[DOMException [TimeoutError]: The operation was aborted due to timeout]".
test("a request that times out is retried", async (t) => {
  const { url, server } = await serve(() => { /* never answers */ });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const error = await caught(() => fetch(url, { signal: AbortSignal.timeout(30) }));
  assert.equal((error as Error).name, "TimeoutError");
  assert.equal(decidePollFailure(error, newPollOutage(), 0).kind, "retry");
});

test("other outage shapes are retried: refused connection, missing manager socket, GitHub 5xx, nested 5xx", async (t) => {
  const { url, server } = await serve((_req, res) => { res.writeHead(502); res.end("bad gateway"); });
  t.after(() => server.close());
  const closed = await serve(() => {});
  const closedUrl = closed.url;
  await new Promise<void>((r) => closed.server.close(() => r()));

  const refused = await caught(() => fetch(closedUrl));
  assert.ok(transientPollFailure(refused), "connection refused");

  const socket = await caught(() => new JsonClient("unix:///nonexistent/pyry-manager.sock", "token").call("/state"));
  assert.ok(transientPollFailure(socket), `missing manager socket: ${String(socket)}`);

  const github502 = await caught(() => (boardClient(async () => new Response("bad gateway", { status: 502 })) as any).getItemsByStatus("Backlog"));
  assert.equal((github502 as any).status, 502);
  assert.ok(transientPollFailure(github502), `GitHub 502: ${String(github502)}`);

  const manager503 = await caught(() => new JsonClient(url, "token").call("/state"));
  assert.ok(transientPollFailure(manager503), "manager 5xx");
  assert.ok(transientPollFailure(new Error('Service 409: {"error":"Service 503: upstream down"}')), "central 5xx relayed by the manager");
  assert.ok(transientPollFailure(new Error('Service 409: {"error":"The operation was aborted due to timeout"}')), "central timeout relayed by the manager");
});

test("errors that make continuing unsafe still stop the dispatcher", () => {
  const fatal: unknown[] = [
    new TypeError("Cannot read properties of undefined (reading 'labels')"),
    new Error('Service 409: {"error":"Run grant no longer active"}'),
    new Error('Service 409: {"error":"Ticket is owned by another machine"}'),
    new Error('Service 403: {"error":"Machine credential required"}'),
    new Error("Managed dispatch requires PYRY_AUTOCURATE_MEMORY=0"),
    new Error("PYRY_RECOVERY requires managed dispatch"),
    new Error("Not initialized"),
    "a thrown string",
  ];
  for (const error of fatal) {
    assert.equal(transientPollFailure(error), null, String(error));
    assert.equal(decidePollFailure(error, newPollOutage(), 0).kind, "fatal", String(error));
  }
});

test("the shared GitHub and rate-limit pause keeps its own wait and is not counted as an outage", () => {
  const outage = newPollOutage();
  const decision = decidePollFailure(new Error("Shared GitHub unavailable; no direct fallback was attempted"), outage, 0);
  assert.deepEqual(decision, { kind: "pause", waitMs: 60_000 });
  assert.equal(outage.failures, 0);
});

test("retries back off up to a minute, notify once after ten minutes, and announce the recovery", () => {
  const outage = newPollOutage();
  const error = new Error('Service 409: {"error":"fetch failed"}');
  const waits: number[] = [];
  const notices: string[] = [];
  let now = 1_000_000;
  for (let i = 0; i < 20; i++) {
    const d = decidePollFailure(error, outage, now);
    assert.equal(d.kind, "retry");
    if (d.kind !== "retry") return;
    waits.push(d.waitMs);
    if (d.notify) notices.push(d.notify);
    now += d.waitMs;
  }
  assert.deepEqual(waits.slice(0, 6), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  assert.ok(waits.every((w) => w <= 60_000));
  assert.equal(notices.length, 1, "one notice for one outage");
  assert.match(notices[0], /running agent runs continue/i);
  const recovered = pollRecovered(outage, now);
  assert.ok(recovered?.notify && /recovered/i.test(recovered.notify));
  assert.equal(outage.failures, 0);
  assert.equal(pollRecovered(outage, now + 1), null, "nothing to announce on an ordinary cycle");
});

test("a short outage that was never notified ends without a notice", () => {
  const outage = newPollOutage();
  decidePollFailure(new Error("fetch failed"), outage, 0);
  const recovered = pollRecovered(outage, 5_000);
  assert.match(recovered?.log ?? "", /recovered after 1 failed poll/);
  assert.equal(recovered?.notify, null);
  assert.equal(outage.failures, 0);
});

test("the poll loop retries transient failures and rethrows only fatal ones (source tripwire)", () => {
  const src = readFileSync(fileURLToPath(new URL("./dispatch.ts", import.meta.url)), "utf8");
  const loop = src.slice(src.indexOf("export async function pollLoop("), src.indexOf("export async function dispatchInbox("));
  assert.match(loop, /const failure = decidePollFailure\(error, pollOutage, Date\.now\(\)\);\s*if \(failure\.kind === "fatal"\) throw error;/);
  assert.match(loop, /if \(githubPauseMs\(e\) !== null \|\| transientPollFailure\(e\) !== null\) throw e;/,
    "a transient pre-fetch failure skips the rest of the cycle instead of running upkeep on a failed read");
  assert.match(loop, /const recovered = pollRecovered\(pollOutage, Date\.now\(\)\);/);
  // A failed cycle must not reach endCycle: that would retire every offer the
  // cycle did not get to make, and cancel granted runs that have not started.
  const endCycle = loop.indexOf("if (managed) await managed.endCycle();");
  const catchAt = loop.lastIndexOf("} catch (error) {");
  assert.ok(endCycle > 0 && catchAt > endCycle, "endCycle only runs on the success path");
});
