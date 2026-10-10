import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubBroker, type GitHubRequest } from "./github-broker.js";

const request: GitHubRequest = { method: "POST", path: "/graphql", body: JSON.stringify({ query: "query { node(id: \"board\") { id } }" }) };
function response(body = "{}", remaining = 5000, reset = 200) {
  return new Response(body, { headers: { "content-type": "application/json", "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(reset) } });
}
test("computers share one in-flight board read and one cached response", async () => {
  let calls = 0, now = 0;
  const broker = new GitHubBroker({ token: "secret", projects: ["org/repo"], now: () => now,
    fetcher: async (_url, init) => { calls++; assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret"); return response('{"data":{"id":1}}'); } });
  const results = await Promise.all(Array.from({ length: 8 }, () => broker.request("org/repo", request)));
  assert.equal(calls, 1); assert.equal(results[0].body, results[7].body);
  await broker.request("org/repo", request); assert.equal(calls, 1);
  now = 120001; await broker.request("org/repo", request); assert.equal(calls, 2);
});
test("fresh checks and successful writes invalidate old board state", async () => {
  let calls = 0;
  const broker = new GitHubBroker({ token: "secret", projects: ["org/repo"], fetcher: async () => response(JSON.stringify({ n: ++calls })) });
  await broker.request("org/repo", request);
  await broker.request("org/repo", { ...request, fresh: true }); assert.equal(calls, 2);
  await broker.request("org/repo", { method: "POST", path: "/repos/org/repo/issues/1/comments", body: '{"body":"review"}' });
  await broker.request("org/repo", request); assert.equal(calls, 4);
});
test("a GitHub read that races a write cannot repopulate the cache", async () => {
  let release!: () => void, calls = 0;
  const broker = new GitHubBroker({ token: "secret", projects: ["org/repo"], fetcher: async () => {
    if (++calls === 1) await new Promise<void>(r => { release = r; });
    return response();
  } });
  const old = broker.request("org/repo", request);
  await new Promise(r => setImmediate(r));
  const write = broker.request("org/repo", { method: "PATCH", path: "/repos/org/repo/issues/1", body: '{"state":"closed"}' });
  release(); await Promise.all([old, write]);
  await broker.request("org/repo", request); assert.equal(calls, 3);
});
test("reserve the last points for results and stop requests until reset", async () => {
  let calls = 0, now = 100000;
  const broker = new GitHubBroker({ token: "secret", projects: ["org/repo"], now: () => now, fetcher: async () => response("{}", ++calls === 1 ? 100 : 0) });
  await broker.request("org/repo", request);
  assert.equal((await broker.request("org/repo", { ...request, fresh: true })).status, 429);
  assert.equal(calls, 1);
  const write = { method: "POST", path: "/graphql", body: '{"query":"mutation { addComment(input: {}) { clientMutationId } }"}' };
  await broker.request("org/repo", write); assert.equal(calls, 2);
  assert.equal((await broker.request("org/repo", write)).status, 429); assert.equal(calls, 2);
  now = 201000; await broker.request("org/repo", write); assert.equal(calls, 3);
});
test("upstream failures and GraphQL errors are never cached or retried as writes", async () => {
  let calls = 0;
  const broker = new GitHubBroker({ token: "secret", projects: ["org/repo"], fetcher: async () => { calls++; return new Response('{"errors":[{"message":"failed"}]}'); } });
  await broker.request("org/repo", request); await broker.request("org/repo", request); assert.equal(calls, 2);
  await broker.request("org/repo", { method: "POST", path: "/repos/org/repo/issues/1/comments", body: "{}" }); assert.equal(calls, 3);
});
test("reject foreign hosts, repos, path escapes and malformed requests before spending quota", async () => {
  let calls = 0;
  const broker = new GitHubBroker({ token: "secret", projects: ["org/repo"], fetcher: async () => { calls++; return response(); } });
  for (const path of ["https://evil.test/graphql", "//evil.test/x", "/repos/other/repo/issues", "/repos/org/repo/../../other", "/repos/org/repo/%2e%2e/issues"]) {
    await assert.rejects(broker.request("org/repo", { method: "GET", path }), /Invalid|allowed/);
  }
  await assert.rejects(broker.request("other/repo", request), /allowed/);
  assert.equal(calls, 0);
});
test("PR state checks bypass the shared cache even without a worker freshness flag", async () => {
  let calls = 0;
  const broker = new GitHubBroker({ token: "secret", projects: ["org/repo"], fetcher: async () => { calls++; return response(); } });
  const pr = { method: "GET", path: "/repos/org/repo/pulls/1" };
  await broker.request("org/repo", pr); await broker.request("org/repo", pr);
  const query = { method: "POST", path: "/graphql", body: JSON.stringify({ query: 'query { repository(owner: "org", name: "repo") { pullRequest(number: 1) { headRefOid } } }' }) };
  await broker.request("org/repo", query); await broker.request("org/repo", query);
  assert.equal(calls, 4);
});
