import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request, Agent, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ServiceShutdown } from "./service-shutdown.js";

type Reply = { status: number; body: string; connection?: string };
function call(port: number, path: string, agent: Agent, method = "GET", body?: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, agent, headers }, res => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, connection: res.headers.connection }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
async function listening(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test("a stop drains a running write, drops an idle keep-alive connection, stops timers and closes the database", async t => {
  const dir = mkdtempSync(join(tmpdir(), "shutdown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE writes (id TEXT PRIMARY KEY)");
  const github = deferred(), entered = deferred();
  const server = createServer(async (req, res) => {
    if (req.url === "/slow-write") {
      entered.resolve();
      await github.promise;
      db.prepare("INSERT INTO writes (id) VALUES (?)").run("after-github");
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
  });
  const port = await listening(server);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  const exits: number[] = [], logs: string[] = [];
  let closes = 0;
  const shutdown = new ServiceShutdown({ servers: [server], stop: [() => clearInterval(timer)], close: () => { closes++; db.close(); }, deadlineMs: 5_000, log: m => logs.push(m), exit: code => exits.push(code) });
  const keepAlive = new Agent({ keepAlive: true });
  t.after(() => keepAlive.destroy());
  assert.equal((await call(port, "/idle", keepAlive)).status, 200, "leaves an idle keep-alive connection open");
  const slow = call(port, "/slow-write", new Agent({ keepAlive: true }), "POST", "{}");
  await entered.promise;
  const started = Date.now();
  const stopped = shutdown.stop("SIGTERM");
  const again = shutdown.stop("SIGTERM");
  const tickCount = ticks;
  await new Promise(r => setTimeout(r, 50));
  assert.equal(ticks, tickCount, "timers stop at once");
  assert.equal(closes, 0, "the database stays open while a write is running");
  assert.deepEqual(exits, []);
  github.resolve();
  const reply = await slow;
  await Promise.all([stopped, again]);
  assert.equal(reply.status, 200, "the running request gets its answer");
  assert.equal(reply.connection, "close");
  assert.ok(Date.now() - started < 2_000, "exits promptly once the write finished");
  assert.deepEqual(exits, [0]);
  assert.equal(closes, 1, "a second signal does not close twice");
  assert.equal(db.isOpen, false, "the database is closed");
  assert.ok(logs.some(m => m.includes("already in progress")));
  const reopened = new DatabaseSync(join(dir, "state.sqlite"));
  assert.deepEqual(reopened.prepare("SELECT id FROM writes").all().map(r => r.id), ["after-github"], "the running write was committed");
  reopened.close();
});

test("background work already running finishes before the database closes", async () => {
  const hold = deferred(), entered = deferred(), publication = deferred();
  const server = createServer(async (req, res) => {
    if (req.url === "/hold") { entered.resolve(); await hold.promise; }
    res.writeHead(200); res.end("{}");
  });
  const port = await listening(server);
  const order: string[] = [];
  const background = publication.promise.then(() => { order.push("published"); });
  const exits: number[] = [];
  const shutdown = new ServiceShutdown({ servers: [server], stop: [], pending: () => [background], close: () => order.push("closed"), deadlineMs: 5_000, log: () => {}, exit: code => exits.push(code) });
  const held = call(port, "/hold", new Agent());
  await entered.promise;
  const stopped = shutdown.stop("SIGINT");
  hold.resolve();
  await held;
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(order, [], "waits for the running publication");
  publication.resolve();
  await stopped;
  assert.deepEqual(order, ["published", "closed"]);
  assert.deepEqual(exits, [0]);
});

test("a request already on a connection when the stop begins gets 503", async t => {
  const server = createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
  const port = await listening(server);
  const exits: number[] = [];
  const shutdown = new ServiceShutdown({ servers: [server], stop: [], close: () => {}, deadlineMs: 5_000, log: () => {}, exit: code => exits.push(code) });
  // Hold a raw connection whose request arrives after the stop began.
  const { connect } = await import("node:net");
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  await new Promise<void>(r => socket.once("connect", () => r()));
  socket.write("GET /late HTTP/1.1\r\nHost: x\r\n");
  await new Promise(r => setTimeout(r, 50));
  const stopped = shutdown.stop("SIGTERM");
  let text = "";
  socket.on("data", chunk => { text += chunk; });
  socket.write("\r\n");
  await stopped;
  await new Promise(r => setTimeout(r, 20));
  assert.match(text, /^HTTP\/1\.1 503/);
  assert.match(text, /Service stopping/);
  assert.deepEqual(exits, [0]);
});

test("a request that never finishes is cut at the deadline, named in the log, and the database still closes", async t => {
  const entered = deferred();
  const server = createServer(async (_req, _res) => { entered.resolve(); await new Promise(() => {}); });
  const port = await listening(server);
  const exits: number[] = [], logs: string[] = [];
  let closed = false;
  const shutdown = new ServiceShutdown({ servers: [server], stop: [], close: () => { closed = true; }, deadlineMs: 300, log: m => logs.push(m), exit: code => exits.push(code) });
  const hung = call(port, "/github", new Agent(), "POST", "{}").catch(error => error);
  await entered.promise;
  const started = Date.now();
  await shutdown.stop("SIGTERM");
  assert.ok(Date.now() - started < 1_500);
  assert.deepEqual(exits, [1]);
  assert.ok(closed);
  assert.ok(logs.some(m => m.includes("still pending: POST /github")), logs.join("\n"));
  assert.ok((await hung) instanceof Error, "the hung connection is cut");
});

test("the claim service exits on SIGTERM while a GitHub request hangs and a keep-alive connection is open", { timeout: 30_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "claims-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // GitHub never answers, as during its 504 outage, until the broker's own 25 second abort.
  writeFileSync(join(dir, "hang-github.mjs"), `const real = globalThis.fetch;
globalThis.fetch = (input, init) => String(input).startsWith("https://api.github.com") ? new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal.reason))) : real(input, init);\n`);
  writeFileSync(join(dir, "claims.json"), JSON.stringify({ database: join(dir, "claims.sqlite"), host: "127.0.0.1", port: 0, operatorTokenEnv: "TEST_OPERATOR", shutdownDeadlineSeconds: 2,
    github: { tokenEnv: "TEST_GITHUB", projects: ["owner/repo"] }, machines: { box: { heavyLimit: 1, combinedLimit: 1, tokenEnv: "TEST_MACHINE" } } }));
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["--no-warnings", "--import", "tsx", "--import", join(dir, "hang-github.mjs"), "src/fleet-bin.ts", "claims", join(dir, "claims.json")],
    { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, TEST_OPERATOR: "operator-secret", TEST_GITHUB: "github-secret", TEST_MACHINE: "machine-secret" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => child.once("exit", (code, signal) => r({ code, signal })));
  const port = await new Promise<number>((resolve, reject) => {
    const check = () => { const m = output.match(/port: (\d+)/); if (m) resolve(Number(m[1])); };
    child.stdout.on("data", check);
    void exited.then(() => reject(new Error(`service exited early: ${output}`)));
  });
  const keepAlive = new Agent({ keepAlive: true });
  t.after(() => keepAlive.destroy());
  const auth = { authorization: "Bearer machine-secret", "content-type": "application/json" };
  assert.equal((await call(port, "/runner", keepAlive, "GET", undefined, auth)).status, 200);
  const hung = call(port, "/github", new Agent(), "POST", JSON.stringify({ project: "owner/repo", request: { method: "GET", path: "/repos/owner/repo/issues/1", headers: {} } }), auth).catch(error => error);
  await new Promise(r => setTimeout(r, 300));
  const started = Date.now();
  child.kill("SIGTERM");
  const result = await exited;
  const elapsed = Date.now() - started;
  await hung;
  assert.ok(elapsed < 8_000, `took ${elapsed}ms to stop; output:\n${output}`);
  assert.equal(result.signal, null, "exits by itself, not by a signal");
  assert.equal(result.code, 1, "reports that the deadline cut a request");
  assert.match(output, /still pending: POST \/github/);
  const db = new DatabaseSync(join(dir, "claims.sqlite"));
  assert.ok(db.prepare("PRAGMA integrity_check").get()?.integrity_check === "ok");
  db.close();
});
