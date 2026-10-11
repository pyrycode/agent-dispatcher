import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetStore } from './fleet-store.js';
import { FleetClient, serveFleet } from './fleet-http.js';
import { MachineManager, serveManager } from './machine-manager.js';
import { ManagedDispatch } from './managed-dispatch.js';
import { scheduleMachine, type WorkOffer } from './machine-scheduler.js';
import { recoveryTrigger } from './fleet-recovery.js';
import type { ProjectItem } from './types.js';

const mobile = 'org/mobile', desktop = 'org/desktop';
const offer = (project: string, issue: number, role = 'recovery'): WorkOffer => ({ project, ticket: `${project}#${issue}`, role, resource: 'heavy', locks: [], key: `${issue}`, order: 0 });
const url = (s: any) => `http://127.0.0.1:${s.address().port}`;
const close = (s: any) => new Promise<void>(r => s.close(r));

for (const kind of ['dependency', 'inbox'] as const) {
  test(`central ${kind} assessment yields to ready work without new offer metadata`, async t => {
    const store = new FleetStore(':memory:', { hp: { heavyLimit: 1, combinedLimit: 2 } });
    const fleet = await serveFleet(store, { hp: 'machine' }, 'admin', 0);
    t.after(async () => { await close(fleet); store.close(); });
    const client = new FleetClient(url(fleet), 'machine');
    const check = offer(desktop, 1927), ready = { ...offer(mobile, 2009, 'builder'), resource: 'medium' as const };
    // Retain an older claim from a previous blocker assessment.
    const prior = { ...check, id: 'previous-check', machine: 'hp', session: 's' };
    store.start(prior); store.finish('hp', 's', prior.id);
    store.recoveryReport('hp', desktop, [{ ticket: check.ticket, status: kind === 'inbox' ? 'Inbox' : 'Backlog',
      blocked: kind === 'dependency', labels: [] }]);
    const manager = new MachineManager({ machine: 'hp', projects: [desktop, mobile], heavyLimit: 1, combinedLimit: 2, ticketLimit: 1 }, client);
    manager.offer(desktop, 'd', [check]); manager.offer(mobile, 'm', [ready]);
    await manager.tick();
    assert.deepEqual(store.snapshot().runs.map(r => r.ticket), [ready.ticket]);
    store.finish('hp', 'm', store.snapshot().runs[0].id);
    await manager.tick();
    assert.deepEqual(store.snapshot().runs.map(r => r.ticket), [check.ticket]);
  });
}

test('retiring one Mobile offer keeps 2009 visible ahead of Desktop 1927', async t => {
  const store = new FleetStore(':memory:', { hp: { heavyLimit: 1, combinedLimit: 1 } });
  const fleet = await serveFleet(store, { hp: 'machine' }, 'admin', 0);
  const manager = new MachineManager({ machine: 'hp', projects: [mobile, desktop], heavyLimit: 1, combinedLimit: 1 }, new FleetClient(url(fleet), 'machine'));
  const server = await serveManager(manager, { [mobile]: 'mobile', [desktop]: 'desktop' }, 'operator', 0);
  const worker = new ManagedDispatch(mobile, { PYRY_MANAGER_URL: url(server), PYRY_MANAGER_TOKEN: 'mobile' });
  t.after(async () => { await worker.stop(); await close(server); await close(fleet); store.close(); });
  await worker.sync(); worker.beginCycle();
  worker.offer(1869, 'builder', 'heavy'); worker.offer(2009, 'recovery', 'heavy'); await worker.endCycle();
  manager.offer(desktop, 'desktop-session', [offer(desktop, 1927)]);
  const original = worker.connection.call.bind(worker.connection);
  worker.connection.call = async <T>(path: string, body?: unknown): Promise<T> => {
    const result = await original<T>(path, body);
    if (path === '/withdraw' || path === '/replace') await manager.tick();
    return result;
  };
  worker.beginCycle(); worker.offer(2009, 'recovery', 'heavy'); await worker.endCycle();
  await manager.tick();
  assert.equal(store.snapshot().runs[0]?.ticket, `${mobile}#2009`);
});

test('the manager reranks new offers between admissions', async t => {
  const store = new FleetStore(':memory:', { hp: { heavyLimit: 1, combinedLimit: 2 } }); t.after(() => store.close());
  const starts: string[] = [];
  const manager = new MachineManager({ machine: 'hp', projects: [mobile, desktop], heavyLimit: 1, combinedLimit: 2 }, {
    snapshot: async () => store.snapshot(), finish: async (s, id) => { store.finish('hp', s, id); },
    start: async req => {
      starts.push(req.ticket); const result = store.start(req);
      if (starts.length === 1) manager.offer(mobile, 'm', [{ ...offer(mobile, 2009), recoveryError: true }]);
      return result;
    },
  });
  manager.offer(desktop, 'd', [{ ...offer(desktop, 1, 'documentation'), resource: 'light', recovery: true, order: -1 }, offer(desktop, 1927)]);
  await manager.tick();
  assert.deepEqual(starts, [`${desktop}#1`, `${mobile}#2009`]);
});

test('an actual error outranks an older dependency assessment', () => {
  const dependency = offer(desktop, 1927), error = { ...offer(mobile, 2009), recoveryError: true };
  const selected = scheduleMachine({ machine: 'hp', projects: [desktop, mobile], heavyLimit: 1, combinedLimit: 1,
    offers: [dependency, error], state: { runs: [], claims: [dependency, error].map((o, i) => ({ ticket: o.ticket, machine: 'hp', generation: 'g', created: i + 1 })) } });
  assert.equal(selected[0].ticket, error.ticket);
  assert.equal(recoveryTrigger({ ticket: error.ticket, status: 'In Build', blocked: true, labels: ['error:builder'] })?.reason, 'error:builder');
});

test('completion queues a fresh error before the next admission, without retiring other incidents', async t => {
  const store = new FleetStore(':memory:', { hp: { heavyLimit: 1, combinedLimit: 1 } });
  const fleet = await serveFleet(store, { hp: 'machine' }, 'admin', 0);
  const client = new FleetClient(url(fleet), 'machine');
  const manager = new MachineManager({ machine: 'hp', projects: [mobile, desktop], heavyLimit: 1, combinedLimit: 1 }, client);
  const server = await serveManager(manager, { [mobile]: 'mobile', [desktop]: 'desktop' }, 'operator', 0);
  const worker = new ManagedDispatch(mobile, { PYRY_MANAGER_URL: url(server), PYRY_MANAGER_TOKEN: 'mobile' });
  t.after(async () => { await worker.stop(); await close(server); await close(fleet); store.close(); });
  const other = store.recoveryReport('hp', mobile, [{ ticket: `${mobile}#2055`, status: 'In Build', blocked: false, labels: ['error:builder'] }])[0];
  await worker.sync(); worker.beginCycle(); const build = worker.offer(2009, 'builder', 'heavy'); await worker.endCycle(); await manager.tick(); await worker.sync();
  manager.offer(desktop, 'd', [offer(desktop, 1927)]);
  const call = client.call.bind(client); let lost = false;
  client.call = async <T>(path: string, body?: unknown): Promise<T> => {
    const result = await call<T>(path, body);
    if (path === '/finish' && (body as any)?.observation) {
      assert.equal(store.recovery.list(mobile).find(i => i.ticket === `${mobile}#2009` && i.current)?.state, 'queued');
      await manager.tick();
      assert.equal(store.snapshot().runs[0]?.ticket, `${mobile}#2009`);
      if (!lost) { lost = true; throw new Error('lost finish acknowledgement'); }
    }
    return result;
  };
  let notified = false;
  await worker.run(build, async () => {}, {
    observe: async () => ({ issueNumber: 2009, status: 'In Build', labels: ['error:builder'], blockedBy: [] } as unknown as ProjectItem),
    onRecovery: incidents => { notified = incidents.some(i => i.ticket === `${mobile}#2009` && i.state === 'queued'); },
  });
  assert.equal(notified, true); assert.equal(lost, true);
  assert.equal(store.recovery.list(mobile).find(i => i.id === other.id)?.current, true);
  assert.equal(store.recovery.list(mobile).filter(i => i.ticket === `${mobile}#2009`).length, 1, 'lost replies cannot duplicate the incident');
});

test('a repair in progress does not requeue historical review counts', () => {
  const observation = { ticket: `${mobile}#2009`, status: 'In Build', blocked: false, labels: ['rework-count:2', 'orchestrator:fixing'] };
  assert.equal(recoveryTrigger(observation), null);
  assert.equal(recoveryTrigger({ ...observation, labels: [...observation.labels, 'error:builder'] })?.reason, 'error:builder');
});

test('a prospective recovery cannot reserve capacity without a queued incident', t => {
  const store = new FleetStore(':memory:', { hp: { heavyLimit: 1, combinedLimit: 1 } }); t.after(() => store.close());
  const job = { ...offer(mobile, 2009), id: 'prospective', machine: 'hp', session: 's', requiresRecovery: true };
  assert.deepEqual(store.start(job), { ok: false, reason: 'locked' });
  assert.deepEqual(store.snapshot(), { claims: [], runs: [] });
  store.recoveryReport('hp', mobile, [{ ticket: job.ticket, status: 'In Build', blocked: false, labels: ['error:builder'] }]);
  assert.equal(store.start(job).ok, true);
});

test('a mismatched completion observation cannot free a reservation or create an incident', t => {
  const store = new FleetStore(':memory:', { hp: { heavyLimit: 1, combinedLimit: 1 } }); t.after(() => store.close());
  const job = { ...offer(mobile, 2009, 'builder'), id: 'builder', machine: 'hp', session: 's' };
  store.start(job); const before = store.snapshot();
  assert.throws(() => store.finish('hp', 's', job.id, true, false, { ticket: `${mobile}#2055`, status: 'In Build', blocked: false, labels: ['error:builder'] }), /mismatch/);
  assert.deepEqual(store.snapshot(), before); assert.deepEqual(store.recovery.list(), []);
});

for (const outcome of ['pipeline-pause', 'operator-hold', 'healthy'] as const) {
  test(`completion consults central recovery facts for ${outcome}`, async t => {
    const store = new FleetStore(':memory:', { hp: { heavyLimit: 1, combinedLimit: 1 } });
    const fleet = await serveFleet(store, { hp: 'machine' }, 'admin', 0);
    const client = new FleetClient(url(fleet), 'machine');
    const manager = new MachineManager({ machine: 'hp', projects: [desktop, mobile], heavyLimit: 1, combinedLimit: 1 }, client);
    const server = await serveManager(manager, { [mobile]: 'mobile', [desktop]: 'desktop' }, 'operator', 0);
    const worker = new ManagedDispatch(mobile, { PYRY_MANAGER_URL: url(server), PYRY_MANAGER_TOKEN: 'mobile' });
    t.after(async () => { await worker.stop(); await close(server); await close(fleet); store.close(); });
    await worker.sync(); worker.beginCycle(); const build = worker.offer(2009, 'builder', 'heavy'); await worker.endCycle(); await manager.tick(); await worker.sync();
    manager.offer(desktop, 'd', [offer(desktop, 1927)]);
    const call = client.call.bind(client);
    let admitted: string | undefined;
    client.call = async <T>(path: string, body?: unknown): Promise<T> => {
      const result = await call<T>(path, body);
      if (path === '/finish' && (body as any)?.observation) {
        await manager.tick();
        admitted = store.snapshot().runs[0]?.ticket;
      }
      return result;
    };
    await worker.run(build, async () => {
      if (outcome !== 'healthy') store.facts.pause({ ticket: `${mobile}#2009`, origin: outcome === 'pipeline-pause' ? 'pipeline' : 'operator',
        actor: 'builder', reason: 'Prerequisite needs assessment', missing: 'Read completion evidence', resumeOn: 'Prerequisite verified', resumeStatus: 'In Build', revision: 'r' });
    }, {
      // The ticket read does not include the separately recorded pause origin.
      observe: async () => ({ issueNumber: 2009, status: outcome === 'healthy' ? 'In Build' : 'Halted', labels: [], blockedBy: [] } as unknown as ProjectItem),
      onRecovery: () => {},
    });
    assert.equal(admitted, outcome === 'pipeline-pause' ? `${mobile}#2009` : `${desktop}#1927`);
  });
}
