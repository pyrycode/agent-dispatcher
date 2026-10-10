import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubBroker } from "./github-broker.js";
import { serveGitHubBridge, startGitHubBridge } from "./github-bridge.js";
import { FleetStore } from "./fleet-store.js";
import { FleetClient, JsonClient, serveFleet } from "./fleet-http.js";
import { MachineManager, serveManager } from "./machine-manager.js";
import { configureGitHubTransport, githubFetch, freshGitHubRead, githubPauseMs } from "./github-transport.js";

const close = (server: Server) => new Promise<void>(r => server.close(() => r()));
function socketRequest(socket: string, path: string, host = "api.github.com") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: socket, path, headers: { Host: host, Authorization: "Bearer local-secret" } }, res => {
      let body = ""; res.on("data", c => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject); req.end();
  });
}

test("two computers and native gh share one upstream without forwarding worker credentials", async t => {
  const dir = mkdtempSync("/tmp/gh-broker-");
  const calls: { path: string; authorization: string | null }[] = [];
  const broker = new GitHubBroker({ token: "central-secret", projects: ["org/core", "org/desktop"], fetcher: async (input, init) => {
    calls.push({ path: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return new Response('{"number":1}', { headers: { "content-type": "application/json" } });
  } });
  const store = new FleetStore(":memory:", { mac: { heavyLimit: 1, combinedLimit: 1 }, linux: { heavyLimit: 1, combinedLimit: 2 } });
  const fleet = await serveFleet(store, { mac: "mac", linux: "linux" }, "operator", 0, "127.0.0.1", broker);
  const address = fleet.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const managers: Server[] = [];
  for (const machine of ["mac", "linux"]) {
    const manager = new MachineManager({ machine, heavyLimit: 1, combinedLimit: machine === "mac" ? 1 : 2, projects: ["org/core", "org/desktop"] }, new FleetClient(url, machine));
    managers.push(await serveManager(manager, { "org/core": "core", "org/desktop": "desktop" }, "manager-op", join(dir, `${machine}.sock`)));
  }
  const local = new JsonClient(`unix://${join(dir, "mac.sock")}`, "core");
  const remote = new JsonClient(`unix://${join(dir, "linux.sock")}`, "core");
  const api = { method: "GET", path: "/repos/org/core/issues/1", headers: { authorization: "worker-secret" } };
  await Promise.all([local.call("/github", api), remote.call("/github", api)]);
  assert.equal(calls.length, 1); assert.equal(calls[0].authorization, "Bearer central-secret");
  await assert.rejects(local.call("/github", { method: "POST", path: "/repos/org/desktop/issues/1/comments", body: "{}" }), /not allowed/);
  const socket = join(dir, "github.sock");
  const bridge = await serveGitHubBridge(socket, req => local.call("/github", req));
  t.after(async () => { await close(bridge); for (const server of managers) await close(server); await close(fleet); store.close(); rmSync(dir, { recursive: true }); });
  assert.equal((await socketRequest(socket, api.path)).status, 200);
  assert.equal((await socketRequest(socket, api.path, "evil.test")).status, 403);
  assert.equal(calls.length, 1);
  if (spawnSync("gh", ["--version"]).status === 0) {
    writeFileSync(join(dir, "config.yml"), `http_unix_socket: ${JSON.stringify(socket)}\n`);
    const result = await promisify(execFile)("gh", ["api", api.path], { env: { ...process.env, GH_CONFIG_DIR: dir, GH_TOKEN: "worker-secret", GH_HOST: "github.com" } });
    assert.equal(JSON.parse(result.stdout).number, 1);
    const before = calls.length;
    await promisify(execFile)("gh", ["api", api.path], { env: { ...process.env, GH_CONFIG_DIR: dir, GH_TOKEN: "worker-secret", GH_HOST: "github.com" } });
    assert.equal(calls.length, before);
  }
  const beforeWrite = calls.length;
  await local.call("/github", { ...api, method: "PATCH", body: '{"title":"changed"}' });
  await remote.call("/github", api); assert.equal(calls.length, beforeWrite + 2);
  const stats: any = await new JsonClient(url, "operator").call("/github/status");
  assert.equal(stats.upstream, calls.length); assert.ok(stats.hits >= 2);
  await assert.rejects(new JsonClient(url, "mac").call("/github/status"), /404/);
  configureGitHubTransport(`unix://${join(dir, "mac.sock")}`, "core");
  const native = await githubFetch(`https://api.github.com${api.path}`);
  assert.equal(native.status, 200); assert.equal(calls.length, beforeWrite + 2);
  await freshGitHubRead(() => githubFetch(`https://api.github.com${api.path}`)); assert.equal(calls.length, beforeWrite + 3);
  const env = { ...process.env, PYRY_SHARED_GITHUB: "1", PYRY_MANAGER_URL: `unix://${join(dir, "mac.sock")}`, PYRY_MANAGER_TOKEN: "core", GH_CONFIG_DIR: dir };
  const child = await startGitHubBridge(env); assert.ok(child?.pid);
  t.after(async () => { child!.kill(); rmSync(env.GH_CONFIG_DIR!, { recursive: true }); });
  const forwarded = await socketRequest(join(env.GH_CONFIG_DIR!, "api.sock"), api.path);
  assert.equal(forwarded.status, 200);
});

test("an unavailable service fails closed and quota pauses are bounded", async t => {
  const dir = mkdtempSync("/tmp/gh-offline-"); const socket = join(dir, "api.sock");
  const bridge = await serveGitHubBridge(socket, async () => { throw new Error("service down"); });
  t.after(async () => { await close(bridge); rmSync(dir, { recursive: true }); });
  assert.equal((await socketRequest(socket, "/repos/org/core/issues/1")).status, 503);
  assert.equal(githubPauseMs(new Error("ordinary test failure")), null);
  assert.equal(githubPauseMs(new Error("Shared GitHub unavailable")), 60_000);
  assert.equal(githubPauseMs(Object.assign(new Error("API rate limit exceeded"), { headers: { "x-ratelimit-reset": "1000" } }), 100), 60_000);
});
