import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaimLabelMirror, GitHubClaimLabels, startClaimLabelSync } from "./claim-labels.js";
import { FleetStore, type Claim } from "./fleet-store.js";

const claim = (n: number | string, machine = "pyrybox", project = "org/core"): Claim => ({ ticket: `${project}#${n}`, machine, generation: "generation", created: 1 });
function fixture() {
  let claims: Claim[] = [claim(1)];
  const issues = new Map<string, Map<number, string[]>>([["org/core", new Map()]]);
  const catalogs = new Map<string, Set<string>>([["org/core", new Set()]]);
  const writes: string[] = [];
  const api = {
    listLabels: async (repo: string) => [...(catalogs.get(repo) ?? [])],
    listIssues: async (repo: string, label: string) => [...(issues.get(repo) ?? [])].filter(([, labels]) => labels.includes(label)).map(([number, labels]) => ({ number, labels: [...labels] })),
    createLabel: async (repo: string, label: string) => { catalogs.get(repo)!.add(label); },
    addLabel: async (repo: string, n: number, label: string) => { writes.push(`add ${repo}#${n} ${label}`); const map = issues.get(repo)!; map.set(n, [...(map.get(n) ?? []), label]); },
    removeLabel: async (repo: string, n: number, label: string) => { writes.push(`remove ${repo}#${n} ${label}`); const map = issues.get(repo)!; map.set(n, map.get(n)!.filter(l => l !== label)); },
  };
  return { issues, catalogs, api, writes, read: () => claims, set: (c: Claim[]) => { claims = c; } };
}

test("backfills claim labels, skips internal jobs and leaves unrelated labels intact", async () => {
  const f = fixture();
  f.set([claim(1), claim(2, "macbook"), claim("@reconcile"), claim(9, "pyrybox", "org/other")]);
  f.issues.get("org/core")!.set(1, ["priority:high", "wip:builder"]);
  const mirror = new ClaimLabelMirror(["org/core"], f.read, f.api);
  assert.deepEqual(await mirror.sync(), { added: 2, removed: 0, errors: [] });
  assert.deepEqual(f.issues.get("org/core")!.get(1), ["priority:high", "wip:builder", "claim:pyrybox"]);
  assert.deepEqual(await mirror.sync(), { added: 0, removed: 0, errors: [] });
  assert.equal(f.writes.length, 2);
});

test("manual release and reassignment reconcile after a publisher restart", async () => {
  const f = fixture();
  await new ClaimLabelMirror(["org/core"], f.read, f.api).sync();
  f.set([]);
  assert.deepEqual(await new ClaimLabelMirror(["org/core"], f.read, f.api).sync(), { added: 0, removed: 1, errors: [] });
  f.set([claim(1)]);
  await new ClaimLabelMirror(["org/core"], f.read, f.api).sync();
  f.set([claim(1, "macbook")]);
  await new ClaimLabelMirror(["org/core"], f.read, f.api).sync();
  assert.deepEqual(f.issues.get("org/core")!.get(1), ["claim:macbook"]);
});

test("offline claims remain visible and manual label edits never change ownership", async () => {
  const f = fixture();
  f.catalogs.get("org/core")!.add("claim:wrong-host");
  f.issues.get("org/core")!.set(1, ["claim:wrong-host", "error:builder"]);
  const original = structuredClone(f.read());
  await new ClaimLabelMirror(["org/core"], f.read, f.api).sync();
  assert.deepEqual(f.read(), original);
  assert.deepEqual(f.issues.get("org/core")!.get(1), ["error:builder", "claim:pyrybox"]);
});

test("GitHub failures preserve claims and retry on the next pass", async () => {
  const f = fixture();
  const add = f.api.addLabel;
  f.api.addLabel = async () => { throw new Error("GitHub unavailable"); };
  const mirror = new ClaimLabelMirror(["org/core"], f.read, f.api);
  assert.equal((await mirror.sync()).errors.length, 1);
  assert.deepEqual(f.read(), [claim(1)]);
  f.api.addLabel = add;
  assert.equal((await mirror.sync()).added, 1);
});

test("rechecks ownership after reading GitHub and never overlaps sync passes", async () => {
  const f = fixture();
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  let calls = 0;
  f.api.listLabels = async () => { calls++; await barrier; return []; };
  const mirror = new ClaimLabelMirror(["org/core"], f.read, f.api);
  const first = mirror.sync(), second = mirror.sync();
  f.set([]);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(f.writes, []);
});

test("REST label listing follows pagination and label edits are narrow", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (new URL(url).searchParams.get("page") === "1") return new Response(JSON.stringify([{ name: "claim:pyrybox" }]), { headers: { link: '<https://api.github.com/next>; rel="next"' } });
    if (new URL(url).searchParams.get("page") === "2") return new Response(JSON.stringify([{ name: "claim:macbook" }]));
    return new Response("{}");
  }) as typeof fetch;
  const api = new GitHubClaimLabels("test-token", fetcher);
  assert.deepEqual(await api.listLabels("org/core"), ["claim:pyrybox", "claim:macbook"]);
  await api.addLabel("org/core", 1, "claim:pyrybox");
  await api.removeLabel("org/core", 1, "claim:macbook");
  assert.deepEqual(calls[2].body, { labels: ["claim:pyrybox"] });
  assert.equal(calls[2].method, "POST");
  assert.equal(calls[3].method, "DELETE");
  assert.ok(calls[3].url.endsWith("/labels/claim%3Amacbook"));
  assert.ok(calls.every(c => c.url.startsWith("https://api.github.com/repos/org/core/")));
});

test("durable ownership survives completion and restart, then manual free removes its label", async () => {
  const f = fixture();
  const store = new FleetStore(":memory:", { pyrybox: { heavyLimit: 1, combinedLimit: 2 } });
  try {
    store.start({ id: "run", machine: "pyrybox", session: "s", project: "org/core", ticket: "org/core#1", role: "builder", resource: "medium", locks: [] });
    await new ClaimLabelMirror(["org/core"], () => store.snapshot().claims, f.api).sync();
    store.finish("pyrybox", "s", "run");
    await new ClaimLabelMirror(["org/core"], () => store.snapshot().claims, f.api).sync();
    assert.deepEqual(f.issues.get("org/core")!.get(1), ["claim:pyrybox"]);
    store.free("org/core#1", store.snapshot().claims[0].generation, true);
    await new ClaimLabelMirror(["org/core"], () => store.snapshot().claims, f.api).sync();
    assert.deepEqual(f.issues.get("org/core")!.get(1), []);
  } finally { store.close(); }
});

test("one unavailable repository does not stop labels for another repository", async () => {
  const f = fixture();
  const list = f.api.listLabels;
  f.api.listLabels = async repo => { if (repo === "org/broken") throw new Error("unavailable"); return list(repo); };
  const result = await new ClaimLabelMirror(["org/broken", "org/core"], f.read, f.api).sync();
  assert.equal(result.errors.length, 1);
  assert.equal(result.added, 1);
});

test("closed issues are included and pull requests are never treated as claimed tickets", async () => {
  const api = new GitHubClaimLabels("test-token", (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("state"), "all");
    assert.equal(url.searchParams.get("labels"), "claim:pyrybox");
    return new Response(JSON.stringify([
      { number: 1, state: "closed", labels: [{ name: "claim:pyrybox" }] },
      { number: 2, pull_request: {}, labels: [{ name: "claim:pyrybox" }] },
    ]));
  }) as typeof fetch);
  assert.deepEqual(await api.listIssues("org/core", "claim:pyrybox"), [{ number: 1, labels: ["claim:pyrybox"] }]);
});

test("disabled or misconfigured visibility never prevents the claim service from starting", t => {
  t.mock.method(console, "warn", () => {});
  assert.doesNotThrow(() => startClaimLabelSync(undefined, () => [])());
  assert.doesNotThrow(() => startClaimLabelSync({ projects: ["org/core"], tokenEnv: "MISSING" }, () => [], {})());
});
