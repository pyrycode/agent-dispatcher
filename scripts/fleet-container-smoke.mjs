#!/usr/bin/env node
// Run on Linux after `pnpm exec tsc`. Uses only dist's native-Node fleet modules.
// No GitHub access, production credentials, checkouts or running services.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { FleetStore } from '../dist/fleet-store.js';
import { FleetClient, JsonClient, serveFleet } from '../dist/fleet-http.js';
import { ManagedDispatch, trackManagedChild } from '../dist/managed-dispatch.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const image = process.env.FLEET_TEST_IMAGE || 'localhost/pyrycode-agent-runtime:latest';
const write = (file, value) => { writeFileSync(`${file}.tmp`, JSON.stringify(value)); renameSync(`${file}.tmp`, file); };
const read = file => JSON.parse(readFileSync(file, 'utf8'));
async function until(check, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(100); }
  throw new Error(`Timed out: ${message}`);
}
const offer = (issue, role, resource) => ({ issue, role, resource });

async function worker(project, token) {
  const managed = new ManagedDispatch(project, { PYRY_MANAGER_URL: 'unix:///manager/manager.sock', PYRY_MANAGER_TOKEN: token });
  const active = new Map();
  const completed = new Set();
  const errors = [];
  for (;;) {
    try {
      managed.beginCycle();
      for (const job of read('/control/offers.json')) {
        if (completed.has(job.issue)) continue;
        const locks = job.role === 'documentation' ? [`${project}:role:documentation`] : [];
        const pending = managed.offer(job.issue, job.role, job.resource, locks);
        if (managed.ready(pending) && !active.has(job.issue)) {
          active.set(job.issue, null);
          void managed.run(pending, async () => {
            const release = `/control/release-${job.issue}`;
            const child = spawn(process.execPath, ['-e',
              'const fs=require("node:fs");setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0)},100)', release],
            { detached: true, stdio: 'ignore' });
            trackManagedChild(child.pid);
            active.set(job.issue, child.pid);
            await once(child, 'exit');
          }).then(() => { active.delete(job.issue); completed.add(job.issue); }, error => { errors.push(error.message); active.delete(job.issue); });
        }
      }
      await managed.endCycle();
    } catch { /* Manager restart must leave running children and grants intact. */ }
    write('/control/state.json', { session: managed.session, active: [...active], completed: [...completed], errors });
    await sleep(100);
  }
}

async function peer(url) {
  const client = new FleetClient(url, 'peer-smoke-only');
  const req = (id, issue, role = 'refiner') => ({ id, machine: 'peer', session: 'peer-session', project: 'smoke/core', ticket: `smoke/core#${issue}`, role,
    resource: 'light', locks: role === 'documentation' ? ['smoke/core:role:documentation'] : [] });
  assert.deepEqual(await client.start(req('foreign', 1)), { ok: false, reason: 'foreign-claim' });
  assert.deepEqual(await client.start(req('docs', 4, 'documentation')), { ok: false, reason: 'locked' });
  assert.equal((await client.start(req('peer-light', 991))).ok, true);
  await client.finish('peer-session', 'peer-light');
  assert.equal((await client.start(req('race-ready', 990))).ok, true);
  const raced = await client.start(req('peer-race', 900));
  assert.ok(raced.ok || raced.reason === 'foreign-claim');
  assert.equal((await client.start(req('peer-done', 999))).ok, true);
  console.log('PASS physical peer: exclusive ticket, global documentation lock, independent machine capacity and ticket race');
}

async function host() {
  const dir = mkdtempSync('/tmp/pyry-fleet-smoke-');
  const socketDir = join(dir, 'socket'); mkdirSync(socketDir, { mode: 0o700 });
  const socket = join(socketDir, 'manager.sock');
  const store = new FleetStore(join(dir, 'claims.sqlite'), { box: { heavyLimit: 1, combinedLimit: 2 }, peer: { heavyLimit: 1, combinedLimit: 2 } });
  const claimsServer = await serveFleet(store, { box: 'box-smoke-only', peer: 'peer-smoke-only' }, 'operator-smoke-only', process.env.FLEET_TEST_PORT ? Number(process.env.FLEET_TEST_PORT) : 0);
  const claimsUrl = `http://127.0.0.1:${claimsServer.address().port}`;
  const admin = new FleetClient(claimsUrl, 'operator-smoke-only');
  const managerConfig = join(dir, 'manager.json');
  write(managerConfig, { machine: 'box', heavyLimit: 1, combinedLimit: 2, claimsUrl, claimsTokenEnv: 'TEST_BOX_TOKEN', socketPath: socket,
    operatorTokenEnv: 'TEST_OPERATOR_TOKEN', projects: [{ repo: 'smoke/core', tokenEnv: 'TEST_CORE_TOKEN' }, { repo: 'smoke/desktop', tokenEnv: 'TEST_DESKTOP_TOKEN' }] });
  const managerEnv = { ...process.env, TEST_BOX_TOKEN: 'box-smoke-only', TEST_OPERATOR_TOKEN: 'local-smoke-only', TEST_CORE_TOKEN: 'core-smoke-only', TEST_DESKTOP_TOKEN: 'desktop-smoke-only' };
  const client = new JsonClient(`unix://${socket}`, 'local-smoke-only');
  let manager;
  const containers = [];
  const podman = (...args) => execFileSync('podman', args, { encoding: 'utf8', timeout: 30000 });
  const runState = name => read(join(dir, name, 'state.json'));
  const setOffers = (name, jobs) => write(join(dir, name, 'offers.json'), jobs);
  const running = (name, issue) => existsSync(join(dir, name, 'state.json')) && runState(name).active.some(([n, pid]) => n === issue && pid);
  const release = (name, issue) => write(join(dir, name, `release-${issue}`), true);
  const startManager = async () => {
    // Matches the systemd service's stale-socket removal without replacing the directory.
    if (existsSync(socket)) unlinkSync(socket);
    manager = spawn(process.execPath, [join(root, 'dist/fleet-bin.js'), 'manager', managerConfig], { env: managerEnv, stdio: ['ignore', 'ignore', 'inherit'] });
    await until(async () => { try { await client.call('/state'); return true; } catch { return false; } }, 'manager socket');
  };
  const startWorker = (name, project, token, jobs) => {
    const control = join(dir, name); mkdirSync(control); setOffers(name, jobs);
    const container = `${dir.split('/').at(-1)}-${name}`; containers.push(container);
    podman('run', '-d', '--name', container, '--init', '--userns=keep-id', '--user', `${process.getuid()}:${process.getgid()}`,
      '--network=none', '--read-only', '--cap-drop=all', '--memory=128m', '--cpus=0.25', '--pids-limit=64', '--tmpfs=/tmp',
      '-v', `${root}:/test:ro`, '-v', `${socketDir}:/manager:ro`, '-v', `${control}:/control:rw`,
      '--entrypoint=node', image, '/test/scripts/fleet-container-smoke.mjs', 'worker', project, token);
    return container;
  };
  try {
    await startManager();
    const core = startWorker('core', 'smoke/core', 'core-smoke-only', [offer(1, 'verifier', 'heavy'), offer(3, 'documentation', 'light')]);
    await until(() => running('core', 1) && running('core', 3), 'core heavy and documentation');
    startWorker('desktop', 'smoke/desktop', 'desktop-smoke-only', [offer(1, 'builder', 'medium'), offer(2, 'builder', 'medium'), offer(3, 'refiner', 'light')]);
    await until(() => running('desktop', 1) && running('desktop', 3), 'desktop medium and light alongside core');
    assert.equal(running('desktop', 2), false);
    assert.equal(store.snapshot().runs.filter(r => r.resource !== 'light').length, 2);
    console.log('PASS two isolated containers: one heavy plus one medium; light agents also run');

    // Optional real second-computer check through a private SSH tunnel.
    if (process.env.FLEET_TEST_PEER === '1') {
      console.log(`PEER_READY port=${claimsServer.address().port}`);
      await until(() => store.snapshot().claims.some(c => c.ticket === 'smoke/core#990'), 'physical peer', 120000);
      store.start({ id: 'box-race', machine: 'box', session: 'box-race', project: 'smoke/core', ticket: 'smoke/core#900', role: 'refiner', resource: 'light', locks: [] });
      await until(() => store.snapshot().claims.some(c => c.ticket === 'smoke/core#999'), 'physical peer assertions');
      assert.equal(store.snapshot().runs.filter(r => r.ticket === 'smoke/core#900').length, 1);
      console.log('PASS physical peer contention observed by Linux authority');
    } else await peer(claimsUrl);

    const original = store.snapshot().runs;
    const exit = once(manager, 'exit'); manager.kill('SIGKILL'); await exit;
    await startManager();
    await sleep(1500);
    assert.deepEqual(store.snapshot().runs, original);
    assert.equal(running('core', 1), true);
    assert.equal(running('desktop', 1), true);
    console.log('PASS manager crash: mounted directory reconnects; original reservations and children survive');

    // Killing the whole container cannot automatically release its reservations.
    const lostSession = runState('core').session;
    podman('kill', '--signal=KILL', core);
    assert.equal(podman('inspect', '--format', '{{.State.Running}}', core).trim(), 'false');
    assert.equal(store.snapshot().runs.filter(r => r.session === lostSession).length, 2);
    await sleep(1200);
    assert.equal(running('desktop', 2), false);
    console.log('PASS container crash: tickets stay reserved and capacity is not reused');

    // A replacement dispatcher cannot adopt the dead session's grants. Restart
    // the manager to discard stale offers, just as the documented recovery does.
    const managerExit = once(manager, 'exit'); manager.kill('SIGTERM'); await managerExit; await startManager();
    startWorker('replacement', 'smoke/core', 'core-smoke-only', [offer(1, 'verifier', 'heavy')]);
    await until(() => existsSync(join(dir, 'replacement/state.json')), 'replacement dispatcher');
    await sleep(1200); assert.equal(running('replacement', 1), false);
    // Stop replacement before freeing so it cannot immediately reclaim #1.
    podman('kill', '--signal=KILL', containers.at(-1));
    const managerExit2 = once(manager, 'exit'); manager.kill('SIGTERM'); await managerExit2; await startManager();
    for (const issue of [1, 3]) {
      const claim = store.snapshot().claims.find(c => c.ticket === `smoke/core#${issue}`);
      await assert.rejects(admin.free(claim.ticket, claim.generation, false));
      await admin.free(claim.ticket, claim.generation, true);
    }
    await until(() => running('desktop', 2), 'manual free permits second medium');
    assert.equal(store.snapshot().runs.filter(r => r.machine === 'box' && r.resource === 'medium').length, 2);
    console.log('PASS explicit manual free: two mediums run; replacement never adopts an old grant');

    for (const issue of [1, 2, 3]) release('desktop', issue);
    await until(() => store.snapshot().runs.every(r => r.project !== 'smoke/desktop'), 'child exits release reservations');
    assert.deepEqual(runState('desktop').errors, []);
    console.log('PASS container child completion releases capacity');
  } finally {
    // Only uniquely named test containers are removed. Keep logs/database for review.
    for (const container of containers) { try { podman('rm', '-f', container); } catch {} }
    if (manager && manager.exitCode === null && manager.signalCode === null) {
      const stopped = once(manager, 'exit'); manager.kill('SIGTERM'); await stopped;
    }
    await new Promise(r => claimsServer.close(r)); store.close();
    console.log(`Test evidence: ${dir}`);
  }
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'worker') await worker(...args);
else if (mode === 'peer') await peer(args[0]);
else if (mode === 'host') await host();
else throw new Error('Usage: fleet-container-smoke.mjs host | peer URL | worker PROJECT TOKEN');
