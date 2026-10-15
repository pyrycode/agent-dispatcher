import { test } from "node:test";
import assert from "node:assert/strict";
import { labelColor, DEFAULT_LABEL_COLOR } from "./label-colors.js";

function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("one colour per family", () => {
  assert.equal(labelColor("error:builder"), labelColor("error:verifier:permission_denied"));
  assert.equal(labelColor("rework-count:3"), labelColor("family-dispatches:12"));
  assert.notEqual(labelColor("done:refiner"), labelColor("done:documentation"));
  assert.equal(labelColor("something-new"), DEFAULT_LABEL_COLOR);
});

test("every colour reads in black or white text", () => {
  const names = ["error:x", "needs-human:x", "needs-rework:x", "wip:x", "pending-done:x", "held:x", "orchestrator:fixing",
    "orchestrator:escalated", "claim:pyrybox", "claim:build-fractal-2", "priority:high", "priority:normal", "priority:low",
    "size:xs", "size:s", "size:m", "size:l", "done:po", "done:architect", "done:developer", "done:qa", "done:verifier",
    "done:documentation", "merged", "security-sensitive", "rework-count:1", "requires:macos"];
  for (const n of names) {
    const l = luminance(labelColor(n));
    const best = Math.max(1.05 / (l + 0.05), (l + 0.05) / 0.05);
    assert.ok(best >= 5, `${n} contrast ${best.toFixed(1)}`);
  }
});

test("odd names get a valid colour", () => {
  for (const n of ["constructor", "toString", "__proto__", "claim:constructor", "done:valueOf", "size:hasOwnProperty",
    "priority:__proto__", "trial:other", "bug", "emoji \u{1F525}", "a,b/c d", ""]) {
    assert.match(labelColor(n), /^[0-9A-Fa-f]{6}$/, n);
  }
  assert.equal(labelColor("trial:anything"), "DDF4FF");
  assert.equal(labelColor("constructor"), DEFAULT_LABEL_COLOR);
});

test("addLabel reads the label list once and creates only labels that are missing", async () => {
  const { GitHubProjectClient } = await import("./github.js");
  const realFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === "GET") return new Response(JSON.stringify([{ name: "wip:builder", color: "123456" }]), { status: 200 });
    return new Response("{}", { status: url.endsWith("/labels") ? 201 : 200 });
  }) as typeof fetch;
  try {
    const client = new GitHubProjectClient({ owner: "o", repo: "r", projectNumber: 1, ownerType: "organization", token: "t" } as any);
    await client.addLabel(1, "wip:builder");
    await client.addLabel(2, "WIP:Builder");
    await client.addLabel(1, "error:builder");
    await Promise.all([client.addLabel(3, "done:qa"), client.addLabel(4, "done:qa")]);
    await client.addLabel(5, "error:builder");
    const lists = calls.filter((c) => c.method === "GET");
    const creates = calls.filter((c) => c.method === "POST" && c.url.endsWith("/repos/o/r/labels"));
    const adds = calls.filter((c) => c.method === "POST" && c.url.includes("/issues/"));
    assert.equal(lists.length, 1);
    assert.deepEqual(creates.map((c) => c.body), [{ name: "error:builder", color: "B60205" }, { name: "done:qa", color: "3CA862" }]);
    assert.equal(adds.length, 6);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createIssue creates a missing label in its colour before filing", async () => {
  const { GitHubProjectClient } = await import("./github.js");
  const realFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === "GET") return new Response(JSON.stringify([{ name: "bug", color: "d73a4a" }]), { status: 200 });
    if (url.endsWith("/issues")) return new Response(JSON.stringify({ number: 7, node_id: "n7", html_url: "u" }), { status: 201 });
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  try {
    const client = new GitHubProjectClient({ owner: "o", repo: "r", projectNumber: 1, ownerType: "organization", token: "t" } as any);
    assert.deepEqual(await client.createIssue("t", "b", ["bug", "requires:linux"]), { number: 7, nodeId: "n7", url: "u" });
    const creates = calls.filter((c) => c.method === "POST" && c.url.endsWith("/repos/o/r/labels"));
    assert.deepEqual(creates.map((c) => c.body), [{ name: "requires:linux", color: "5C3D1E" }]);
    const issue = calls.findIndex((c) => c.url.endsWith("/repos/o/r/issues"));
    assert.ok(issue > calls.indexOf(creates[0]), "the label exists before the issue names it");
    assert.deepEqual(calls[issue].body.labels, ["bug", "requires:linux"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
