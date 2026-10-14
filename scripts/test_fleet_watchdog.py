import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

m = load('support', 'fleet-support.py')
w = load('watchdog', 'fleet-watchdog.py')

# The #3289 dispatcher repair task on pyrybox, 2026-10-14.
TASK = '58915c353ee70b722a335cd603c0d2c22439bc70bbdd083a50bc1da8b686d84e'
# The Desktop #1809 repair task left behind on 2026-10-13.
ORPHAN = '29219c8b8ff620429a99de07365c889b44ecc0c3bc1d75c99525f7feea9ab1d4'
FINISHED = 1791959507.0  # 09:31:47 EEST, when its result was written
# The real reply, as the operator command prints it on stderr.
DETAIL = '{"error":"Repair contains credential-shaped text; retain it privately"}'
REFUSAL = {'operation': 'prepare-repair', 'status': 409, 'detail': DETAIL}


def stamp(path, at):
    os.utime(path, (at, at))


class Fleet:
    """One computer: its supervisor's task receipts, task folders and manager state."""
    def __init__(self, d, now=FINISHED, **settings):
        self.d = Path(d)
        self.now = [now]
        self.state = {'machine': 'pyrybox', 'draining': False, 'heavyLimit': 1, 'runs': [], 'queue': []}
        fleet = self
        class Adapter:
            def status(self): return fleet.state
            def operator_command(self, *args): return ['operator', *args]
        self.adapter = Adapter()
        route = {'capability': 'dispatcher-repair', 'container': 'core', 'directory': d + '/work', 'containerDirectory': '/work', 'paths': {}}
        self.config = {'stateDirectory': d, 'projects': {'pyrycode/pyrycode': {'container': 'core', 'agents': d + '/agents'},
                                                        'pyrycode/pyrycode-desktop': {'container': 'desktop', 'agents': d + '/desktop-agents'}},
                       'recoveryTasks': {'dispatcher-repair:dispatcher-repair': route}}
        if settings:
            self.config['watchdog'] = settings
        self.support = m.SupportSupervisor(self.adapter, self.config)
        self.calls = []
        self.refuse = {}
        def rpc(op, body):
            self.calls.append((op, body))
            if op in self.refuse:
                value = self.refuse[op]
                raise m.rpc_failure(op, 1, value) if isinstance(value, str) else value
            return [] if op == 'schedule' else {'state': 'failed'} if op == 'complete' else {}
        self.support.rpc = rpc
        self.logged = []
        self.support.housekeeping = self.record
        self.watchdog = self.fresh()

    def record(self, kind, subject, reason, archive=None):
        entry = {'at': self.now[0], 'kind': kind, 'subject': subject, 'reason': reason}
        self.logged.append(entry)
        with (self.d / 'housekeeping.jsonl').open('a') as stream:
            stream.write(json.dumps(entry) + '\n')

    def fresh(self):
        """A new instance, as after the supervisor re-executes itself."""
        return w.Watchdog(self.adapter, self.config, self.support, self.record, clock=lambda: self.now[0], support_module=m)

    def task(self, task=TASK, ticket='pyrycode/pyrycode#3289', phase='running', result=True, created=FINISHED - 640, **extra):
        folder = self.d / 'work' / task
        folder.mkdir(parents=True)
        m.atomic(folder / 'task.json', {'id': task, 'ticket': ticket, 'request': {'recipe': 'dispatcher-repair'}})
        (folder / 'execution.log').write_text('repair started\n')
        stamp(folder / 'execution.log', created + 30)
        if result:
            m.atomic(folder / 'result.json', {'outcome': 'completed', 'summary': 'Dispatcher patch passed full checks and independent review.',
                                              'files': {'publication.json': json.dumps({'patch': 'reviewed'})}})
            (folder / 'publication.json').write_text('{"patch": "reviewed"}')
            stamp(folder / 'result.json', FINISHED); stamp(folder / 'publication.json', FINISHED)
        receipt = self.support.directory / (task + '.receipt.json')
        m.atomic(receipt, {'id': task, 'session': 'scheduler', 'phase': phase, 'result': str(folder / 'result.json'), 'created': created,
                           'container': 'core', 'directory': str(folder), 'containerDirectory': '/work/' + task, 'pid': 3412049,
                           'custody': {'root': {'pid': 3412049, 'identity': 'exec-client'}, 'owned': {}}, **extra})
        self.state['runs'].append({'id': 'run-' + task[:8], 'machine': 'pyrybox', 'project': 'pyrycode/pyrycode', 'ticket': 'pyrycode/pyrycode#@task-' + task,
                                   'role': 'recovery-task', 'resource': 'heavy', 'supportTaskId': task, 'parentTicket': ticket,
                                   'created': created * 1000, 'session': 'scheduler'})
        return folder, receipt

    def supervisor_pass(self, custody='drained', container=None):
        """The supervisor's native task pass, then its watchdog, as the service loop runs them."""
        # A live worker's launch process is in the census under its recorded identity.
        census = {3412049: {'pid': 3412049, 'ppid': 1, 'pgid': 3412049, 'sid': 3412049, 'identity': 'exec-client', 'state': 'S'}} if custody == 'alive' else {}
        with patch.object(m, 'process_snapshot', return_value=census), patch.object(m, 'observe_custody', return_value=custody), \
             patch.object(m, 'container_instance', return_value=container or {'running': True, 'startedAt': 0, 'id': 'i'}), \
             patch.object(self.support, 'route_ready', return_value=False):
            self.support.tick()
            return self.watchdog.tick(dict(self.support.refusals))

    def ops(self, name):
        return [body for op, body in self.calls if op == name]


class FinishedButRefused(unittest.TestCase):
    """#3289: finished and drained at 09:31:47, then every pass's prepare-repair was refused with 409."""
    def test_released_as_failed_after_the_limit_with_every_file_kept(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task(drainConfirmed=True)
            f.refuse['prepare-repair'] = 'Service 409: ' + DETAIL
            # One pass a minute, as the supervisor runs. The first refusal at +60 s.
            for minute in range(1, 11):
                f.now[0] = FINISHED + 60 * minute
                self.assertEqual(f.supervisor_pass(), [], minute)
            # Past the limit from the result, but not yet from the first refusal: reported only.
            f.now[0] = FINISHED + 60 * 11
            [stalled] = f.supervisor_pass()
            self.assertEqual((stalled['kind'], stalled['worker']), ('stalled', 'finished'))
            self.assertIn('The service refused prepare-repair with 409', stalled['reason'])
            self.assertEqual(f.ops('complete'), [])
            f.now[0] = FINISHED + 60 * 11 + 1
            [item] = f.supervisor_pass()
            [body] = f.ops('complete')
            self.assertEqual(body['expectStates'], ['running', 'attention'])
            self.assertEqual((body['machine'], body['id'], body['session']), ('pyrybox', TASK, 'scheduler'))
            self.assertEqual(body['result']['outcome'], 'failed'); self.assertEqual(body['result']['files'], {})
            for text in ('pyrycode/pyrycode#3289', '2026-10-14 06:31:47Z', 'credential-shaped text', 'prepare-repair with 409',
                         'task 58915c353ee7', 'Nothing was published', '12 consecutive passes'):
                self.assertIn(text, body['result']['summary'])
            self.assertNotIn(d, body['result']['summary'])
            saved = json.loads(receipt.read_text())
            self.assertEqual(saved['phase'], 'complete'); self.assertEqual(saved['finalized']['result'], body['result'])
            self.assertEqual((item['kind'], item['action'], item['ticket'], item['phase'], item['worker']),
                             ('finalized', 'released', 'pyrycode/pyrycode#3289', 'finalizing', 'finished'))
            self.assertEqual([e['kind'] for e in f.logged], ['native-task-skipped', 'watchdog-stalled', 'native-task-finalized'])
            for name in ('result.json', 'publication.json', 'execution.log', 'task.json'):
                self.assertTrue((folder / name).is_file(), name)
            # The ordinary pass leaves a finalized record alone: no publication, no artifact return.
            f.state['runs'] = []
            f.calls.clear()
            f.now[0] += 60
            [notice] = f.supervisor_pass()
            self.assertEqual([op for op, _ in f.calls], ['capabilities', 'schedule'])
            self.assertEqual((notice['kind'], notice['ticket']), ('finalized', 'pyrycode/pyrycode#3289'))

    def refused_passes(self, f, refusals, passes=12, start=FINISHED + 60):
        """One watchdog pass a minute with the given refusals. Returns the last items."""
        items = []
        for minute in range(passes):
            f.now[0] = start + 60 * minute
            items = f.watchdog.tick(refusals(minute) if callable(refusals) else refusals)
        return items

    def test_never_finished_automatically_unless_every_condition_holds(self):
        timeout = m.rpc_failure('prepare-repair', 1, 'Error: The operation was aborted due to timeout\nNode.js v24.13.0')
        lost = m.rpc_failure('prepare-repair', 1, 'TypeError: fetch failed')
        cases = [
            ('a publication may be in progress', {'phase': 'publishing', 'drainConfirmed': True}, {TASK: REFUSAL}, {}),
            ('drainage not proven by the supervisor', {}, {TASK: REFUSAL}, {}),
            ('the native task pass itself failed', {'drainConfirmed': True}, None, {}),
            ('no refusal', {'drainConfirmed': True}, {}, {}),
            ('a refusal of publication itself', {'drainConfirmed': True}, {TASK: {**REFUSAL, 'operation': 'publish-repair'}}, {}),
            ('a server error, not a refusal', {'drainConfirmed': True}, {TASK: {**REFUSAL, 'status': 500}}, {}),
            ('automatic finishing turned off', {'drainConfirmed': True}, {TASK: REFUSAL}, {'finalize': False}),
            ('a single refusal among lost replies', {'drainConfirmed': True}, lambda minute: {TASK: REFUSAL} if minute == 11 else {}, {}),
            ('refusals that keep changing', {'drainConfirmed': True}, lambda minute: {TASK: {**REFUSAL, 'detail': str(minute % 2)}}, {}),
        ]
        for name, receipt_fields, refusals, settings in cases:
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                f = Fleet(d, **settings)
                fields = dict(receipt_fields)
                folder, receipt = f.task(phase=fields.pop('phase', 'running'), **fields)
                with patch.object(m, 'process_snapshot', return_value={}), patch.object(m, 'observe_custody', return_value='alive'):
                    items = self.refused_passes(f, refusals, passes=60)
                self.assertEqual(f.ops('complete'), [])
                self.assertNotEqual(json.loads(receipt.read_text())['phase'], 'complete')
                [item] = items
                self.assertEqual((item['kind'], item['action']), ('stalled', 'attention'))
                self.assertIn('pyrycode/pyrycode#3289', item['ticket'])
        # Timeouts, lost connections and local crashes are never refusals.
        for error in (timeout, lost):
            self.assertIsNone(m.service_refusal(error))
            self.assertIn('without a service reply', str(error)); self.assertNotIn('Node.js', str(error))

    def test_a_first_refusal_after_a_long_gap_still_waits_the_full_limit(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            f.task(drainConfirmed=True)
            # Hours of lost replies, then refusals start: the result is old, the refusals are not.
            items = self.refused_passes(f, {TASK: REFUSAL}, passes=10, start=FINISHED + 3 * 3600)
            self.assertEqual(f.ops('complete'), [])
            self.assertEqual(items[0]['kind'], 'stalled')
            self.refused_passes(f, {TASK: REFUSAL}, passes=2, start=f.now[0] + 60)
            self.assertEqual(len(f.ops('complete')), 1)

    def test_finishing_waits_for_the_limit_from_the_result_and_later_worker_writes(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task(drainConfirmed=True)
            (folder / 'reviewer.log').write_text('late write'); stamp(folder / 'reviewer.log', FINISHED + 900)
            # Supervisor-written files are not worker progress.
            for name in ('artifact-result.json', 'execution.custody.json'):
                (folder / name).write_text('{}'); stamp(folder / name, FINISHED + 1490)
            # Files are written as time passes here, so none counts as dated in the future.
            with patch.object(w, 'FUTURE_MARGIN', 10 ** 6):
                self.refused_passes(f, {TASK: REFUSAL}, passes=25)
            self.assertEqual(f.ops('complete'), [])
            self.refused_passes(f, {TASK: REFUSAL}, passes=1, start=FINISHED + 1501)
            self.assertEqual(len(f.ops('complete')), 1)

    def test_a_result_dated_in_the_future_counts_as_now(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task(drainConfirmed=True)
            stamp(folder / 'result.json', FINISHED + 10 ** 7)
            # Counted from the first pass that saw it, at +60 s, not deferred by the future date.
            self.assertEqual(self.refused_passes(f, {TASK: REFUSAL}, passes=11), [])
            [item] = self.refused_passes(f, {TASK: REFUSAL}, passes=1, start=f.now[0] + 60)
            self.assertEqual((item['kind'], item['since']), ('finalized', FINISHED + 60))
            self.assertIn('finished at 2026-10-14 06:43:47Z', item['reason'])

    def test_a_refused_release_is_reported_and_retried_with_the_identical_result(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task(drainConfirmed=True)
            f.refuse['complete'] = 'Service 409: {"error":"Task state is publishing, not running or attention"}'
            [item] = self.refused_passes(f, {TASK: REFUSAL})
            self.assertEqual((item['kind'], item['action']), ('finalize-refused', 'attention'))
            self.assertIn('Task state is publishing', item['reason'])
            self.assertEqual(json.loads(receipt.read_text())['phase'], 'running')
            first = json.loads(receipt.read_text())['finalized']['result']
            del f.refuse['complete']
            self.refused_passes(f, {TASK: REFUSAL}, passes=1, start=f.now[0] + 60)
            self.assertEqual([b['result'] for b in f.ops('complete')], [first, first])
            self.assertEqual(json.loads(receipt.read_text())['finalized']['released'], True)
            self.assertEqual([e['kind'] for e in f.logged][-2:], ['watchdog-finalize-refused', 'native-task-finalized'])

    def test_a_release_the_service_does_not_confirm_is_not_taken_as_one(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task(drainConfirmed=True)
            rpc = f.support.rpc
            f.support.rpc = lambda op, body: {'ok': True} if op == 'complete' else rpc(op, body)
            [item] = self.refused_passes(f, {TASK: REFUSAL})
            self.assertEqual(item['kind'], 'finalize-refused'); self.assertIn('did not confirm', item['reason'])
            self.assertEqual(json.loads(receipt.read_text())['phase'], 'running')

    def test_a_different_outcome_already_held_stops_the_retries(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task(drainConfirmed=True)
            f.refuse['complete'] = 'Service 409: {"error":"Completed task result changed"}'
            [item] = self.refused_passes(f, {TASK: REFUSAL}, passes=20)
            self.assertEqual(len(f.ops('complete')), 1)
            self.assertEqual(item['kind'], 'finalize-refused'); self.assertIn('Reconcile the task', item['reason'])
            self.assertEqual(json.loads(receipt.read_text())['phase'], 'running')

    def test_an_exited_worker_without_the_supervisors_drain_proof_is_never_finished(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task()
            with patch.object(m, 'process_snapshot', return_value={}), patch.object(m, 'observe_custody', return_value='drained'):
                [item] = self.refused_passes(f, {TASK: REFUSAL}, passes=60)
            self.assertEqual((item['kind'], item['worker']), ('stalled', 'exited'))
            self.assertIn('full drainage is not yet confirmed', item['reason'])
            self.assertEqual(f.ops('complete'), [])

    def test_the_ordinary_pass_refusal_is_typed_from_the_real_operator_output(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task(drainConfirmed=True)
            operator = Path(d) / 'operator'
            operator.write_text('#!/bin/sh\necho \'Service 409: {"error":"Repair contains credential-shaped text; retain it privately"}\' >&2\nexit 1\n')
            operator.chmod(0o700)
            f.adapter.operator_command = lambda *args: [str(operator), *args]
            del f.support.rpc
            running = []
            # The record-local pass error keeps the typed refusal as its cause.
            with patch.object(m, 'process_snapshot', return_value={}), self.assertRaises(m.PublicationPassError) as caught:
                f.support.receipt_pass('pyrybox', receipt, running)
            refusal = m.service_refusal(caught.exception)
            self.assertEqual((refusal.operation, refusal.status), ('prepare-repair', 409))
            self.assertEqual(refusal.detail, DETAIL)

class DeadOrSilentWorkers(unittest.TestCase):
    """#3247 and #1809: repair workers that died, and live workers that went quiet."""
    def test_a_worker_gone_without_proof_is_reported_and_never_released(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task(task=ORPHAN, ticket='pyrycode/pyrycode-desktop#1809', result=False, created=FINISHED - 7000)
            # The container restarted before the worker last wrote, so it proves nothing.
            container = {'running': True, 'startedAt': 0, 'id': 'same-instance'}
            # The existing pass escalates it as uncertain. The watchdog reports it once it holds its place too long.
            self.assertEqual(f.supervisor_pass(custody='drained', container=container), [])
            self.assertEqual(len(f.ops('uncertain')), 1)
            f.now[0] += 1801
            [item] = f.supervisor_pass(custody='drained', container=container)
            self.assertEqual((item['kind'], item['worker'], item['phase'], item['action']), ('stalled', 'gone-unproven', 'attention', 'attention'))
            self.assertIn('no proof the worker is gone', item['reason'])
            self.assertEqual(f.ops('complete'), [])
            self.assertEqual(json.loads(receipt.read_text())['phase'], 'attention')

    def test_a_worker_proven_gone_is_released_by_the_existing_path_and_reported_once(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task(task=ORPHAN, ticket='pyrycode/pyrycode-desktop#1809', result=False, created=FINISHED - 7000)
            [item] = f.supervisor_pass(container={'running': False})
            self.assertEqual(len(f.ops('complete')), 1)
            self.assertEqual((item['kind'], item['ticket'], item['action']), ('released', 'pyrycode/pyrycode-desktop#1809', 'released'))
            self.assertEqual([e['kind'] for e in f.logged], ['native-task-interrupted'])
            f.now[0] += f.watchdog.settings['noticeSeconds'] + 1
            self.assertEqual(f.supervisor_pass(container={'running': False}), [])

    def test_an_alive_worker_past_its_budget_is_attention_only(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            folder, receipt = f.task(result=False, created=FINISHED - 5400 - 900 - 1)
            [item] = f.supervisor_pass(custody='alive')
            self.assertEqual((item['kind'], item['worker'], item['limitSeconds']), ('stalled', 'alive', 6300))
            self.assertIn('still alive', item['reason'])
            self.assertEqual(f.ops('complete'), []); self.assertEqual(f.ops('uncertain'), [])
            f.now[0] -= 2
            self.assertEqual(f.supervisor_pass(custody='alive'), [])

    def test_a_finding_is_recorded_once_and_its_text_is_stable_across_passes_and_restarts(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            f.task(phase='publishing', drainConfirmed=True)
            f.now[0] = FINISHED + 60
            self.assertEqual(f.watchdog.tick({}), [])
            f.now[0] = FINISHED + 661
            first = f.watchdog.tick({})
            f.watchdog = f.fresh()
            f.now[0] += 600
            self.assertEqual(f.watchdog.tick({}), first)
            self.assertEqual(first[0]['since'], FINISHED + 60)
            self.assertIn('publication may be in progress', first[0]['reason'])
            self.assertEqual([e['kind'] for e in f.logged], ['watchdog-stalled'])

    def test_a_deferred_grant_that_never_starts_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            m.atomic(f.support.directory / (ORPHAN + '.deferred.json'), {'id': ORPHAN, 'session': 'scheduler', 'runId': 'run-1809', 'container': 'core'})
            f.state['runs'].append({'id': 'run-1809', 'machine': 'pyrybox', 'supportTaskId': ORPHAN, 'parentTicket': 'pyrycode/pyrycode-desktop#1809',
                                    'resource': 'heavy', 'created': FINISHED * 1000})
            self.assertEqual(f.watchdog.tick({}), [])
            f.now[0] += 3601
            [item] = f.watchdog.tick({})
            self.assertEqual((item['phase'], item['worker'], item['ticket']), ('deferred', 'not-started', 'pyrycode/pyrycode-desktop#1809'))


class DispatcherRunsAndStarvation(unittest.TestCase):
    def dispatcher_run(self, f, ticket='pyrycode/pyrycode#3324', role='builder', created=FINISHED - 9000, log_at=None, project='pyrycode/pyrycode'):
        logs = Path(f.config['projects'][project]['agents']) / 'logs'; logs.mkdir(parents=True, exist_ok=True)
        number = ticket.rsplit('#', 1)[1]
        log = logs / ('2026-10-14T07-18-49-658Z_' + role + '_#' + number + '.log'); log.write_text('working')
        stamp(log, log_at if log_at is not None else created + 60)
        f.state['runs'].append({'id': 'run-' + number, 'machine': 'pyrybox', 'project': project, 'ticket': ticket, 'role': role,
                                'resource': 'heavy', 'created': created * 1000})
        return log

    def test_a_silent_dispatcher_run_is_attention_only(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            log = self.dispatcher_run(f)
            logs = log.parent
            # Another ticket whose number starts the same, and this ticket's earlier run, are not this run's progress.
            (logs / 'x_builder_#33240.log').write_text('other'); (logs / 'old_builder_#3324.log').write_text('old')
            stamp(logs / 'old_builder_#3324.log', FINISHED - 9000)
            [item] = f.watchdog.tick({})
            self.assertEqual((item['kind'], item['worker'], item['phase'], item['ticket']), ('stalled', 'dispatcher', 'builder', 'pyrycode/pyrycode#3324'))
            self.assertEqual(item['lastProgress'], FINISHED - 9000 + 60)
            self.assertIn('nothing is released', item['reason'])
            stamp(log, FINISHED - 100)
            self.assertEqual(f.watchdog.tick({}), [])
            self.assertEqual(f.calls, [])

    def test_a_heavy_job_starved_by_an_idle_holder_names_both(self):
        # 10:26: Desktop #1809's live gate queued behind pyrybox's only heavy place.
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            log = self.dispatcher_run(f, created=FINISHED - 4000, log_at=FINISHED - 2000)
            f.state['queue'] = [{'ticket': 'pyrycode/pyrycode-desktop#1809', 'role': 'real-claude-gate', 'resource': 'heavy', 'state': 'waiting-for-capacity-or-lock'},
                                {'ticket': 'pyrycode/pyrycode#9', 'role': 'refiner', 'resource': 'light', 'state': 'waiting-for-capacity-or-lock'}]
            f.watchdog.settings['dispatcherSilenceSeconds'] = 10 ** 6
            self.assertEqual(f.watchdog.tick({}), [])
            f.watchdog = f.fresh(); f.watchdog.settings['dispatcherSilenceSeconds'] = 10 ** 6
            f.now[0] += 3000
            self.assertEqual(f.watchdog.tick({}), [])
            f.now[0] += 601
            [item] = f.watchdog.tick({})
            self.assertEqual((item['kind'], item['ticket'], item['phase']), ('starvation', 'pyrycode/pyrycode-desktop#1809', 'real-claude-gate'))
            self.assertEqual(item['holder'], 'pyrycode/pyrycode#3324 builder')
            self.assertEqual(item['since'], FINISHED); self.assertEqual(item['lastProgress'], FINISHED - 2000)
            # Progress by the holder ends the finding. So does free capacity.
            stamp(log, f.now[0] - 10)
            self.assertEqual(f.watchdog.tick({}), [])

    def test_free_capacity_restarts_the_wait(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            self.dispatcher_run(f, log_at=FINISHED - 5000)
            f.watchdog.settings['dispatcherSilenceSeconds'] = 10 ** 6
            f.state['queue'] = [{'ticket': 'org/x#1', 'role': 'builder', 'resource': 'heavy', 'state': 'waiting-for-capacity-or-lock'}]
            f.watchdog.tick({})
            f.state['heavyLimit'] = 2
            f.now[0] += 3000; f.watchdog.tick({})
            f.state['heavyLimit'] = 1
            f.now[0] += 1000
            self.assertEqual(f.watchdog.tick({}), [])

    def test_an_update_waiting_for_an_idle_native_task_names_both(self):
        # pyrybox Core waited in waiting-for-native-task from 09:20 behind the #3289 task.
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            f.task(phase='publishing', drainConfirmed=True)
            operations = [{'project': 'pyrycode/pyrycode', 'phase': 'waiting-for-native-task', 'created': FINISHED},
                          {'project': 'pyrycode/pyrycode-desktop', 'phase': 'complete'}]
            f.watchdog.settings['publishingSeconds'] = 10 ** 6
            f.watchdog.tick({}, operations)
            f.now[0] += 3000
            self.assertEqual(f.watchdog.tick({}, operations), [])
            f.now[0] += 1000
            [item] = f.watchdog.tick({}, operations)
            self.assertEqual((item['kind'], item['subject'], item['holder']), ('starvation', 'update pyrycode/pyrycode', 'pyrycode/pyrycode#3289 native task'))

    def test_shared_jobs_and_light_runs_are_never_called_idle(self):
        with tempfile.TemporaryDirectory() as d:
            f = Fleet(d)
            f.state['runs'] = [{'id': 'r', 'machine': 'pyrybox', 'project': 'pyrycode/pyrycode', 'ticket': 'pyrycode/pyrycode#@reconcile', 'role': 'reconcile',
                                'resource': 'heavy', 'created': 0},
                               {'id': 'l', 'machine': 'pyrybox', 'project': 'pyrycode/pyrycode', 'ticket': 'pyrycode/pyrycode#5', 'role': 'refiner',
                                'resource': 'light', 'created': 0},
                               {'id': 'o', 'machine': 'build-hp-1', 'project': 'pyrycode/pyrycode', 'ticket': 'pyrycode/pyrycode#6', 'role': 'builder',
                                'resource': 'heavy', 'created': 0}]
            f.state['queue'] = [{'ticket': 'org/x#1', 'role': 'builder', 'resource': 'heavy', 'state': 'waiting-for-capacity-or-lock'}]
            f.watchdog.tick({}); f.now[0] += 10 ** 5
            self.assertEqual(f.watchdog.tick({}), [])


class SupervisorWiring(unittest.TestCase):
    def run_once(self, adapter_source):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ['fleet-supervisor.py', 'fleet-watchdog.py']:
                (root / name).write_bytes(Path(__file__).with_name(name).read_bytes())
            (root / 'fleet-native.py').write_text(adapter_source)
            report = root / 'report.json'; config = root / 'config.json'
            config.write_text(json.dumps({'stateDirectory': str(root / 'state'), 'reportFile': str(report), 'projects': {}}))
            config.chmod(0o600)
            result = subprocess.run([sys.executable, str(root / 'fleet-supervisor.py'), str(config), '--once'], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(report.read_text())

    def test_the_operation_report_carries_the_watchdog_list(self):
        published = self.run_once('''class NativeAdapter:
    def __init__(self, config): pass
    def desired(self): return {}
    def status(self): return {'machine': 'pyrybox', 'runs': [], 'queue': [], 'heavyLimit': 1}
    def attention(self): return {}
    def publish_attention(self): pass
''')
        self.assertEqual(published['watchdog'], [])
        self.assertNotIn('service', published)

    def test_a_failing_watchdog_pass_never_costs_the_report(self):
        published = self.run_once('''class NativeAdapter:
    def __init__(self, config): pass
    def desired(self): return {}
    def status(self): raise RuntimeError('manager unavailable at /private/socket')
    def attention(self): return {}
    def publish_attention(self): pass
''')
        [item] = published['watchdog']
        self.assertEqual((item['kind'], item['action']), ('error', 'attention'))
        self.assertIn('manager unavailable at <path>', item['reason'])
        self.assertEqual(published['operations'], [])


class SupervisorFailures(unittest.TestCase):
    def run_once(self, settings, watchdog_source=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'fleet-supervisor.py').write_bytes(Path(__file__).with_name('fleet-supervisor.py').read_bytes())
            (root / 'fleet-watchdog.py').write_text(watchdog_source or Path(__file__).with_name('fleet-watchdog.py').read_text())
            (root / 'fleet-native.py').write_text('''class NativeAdapter:
    def __init__(self, config): pass
    def desired(self): return {}
    def status(self): return {'machine': 'pyrybox', 'runs': [], 'queue': [], 'heavyLimit': 1}
    def attention(self): return {}
    def publish_attention(self): pass
''')
            state = root / 'state'; state.mkdir()
            (state / 'housekeeping.jsonl').write_text(''.join(json.dumps({'at': time.time(), 'kind': k, 'subject': 's', 'reason': 'r'}) + '\n'
                                                            for k in ['watchdog-stalled'] * 30 + ['operation-retired']))
            report = root / 'report.json'; config = root / 'config.json'
            config.write_text(json.dumps({'stateDirectory': str(state), 'reportFile': str(report), 'projects': {}, **settings}))
            config.chmod(0o600)
            result = subprocess.run([sys.executable, str(root / 'fleet-supervisor.py'), str(config), '--once'], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(report.read_text())

    def test_bad_settings_fall_back_to_defaults_and_say_so(self):
        published = self.run_once({'watchdog': {'finalize': 'yes', 'starvationSeconds': -5, 'recipeBudgetSeconds': {'x': 'y'}, 'launchSeconds': 30}})
        [item] = published['watchdog']
        self.assertEqual(item['kind'], 'error')
        self.assertIn('finalize, recipeBudgetSeconds, starvationSeconds', item['reason'])
        value, rejected = w.settings({'watchdog': {'launchSeconds': 30, 'finalize': 1}})
        self.assertEqual((value['launchSeconds'], value['finalize'], rejected), (30, True, ['finalize']))

    def test_a_watchdog_that_cannot_load_never_stops_the_supervisor(self):
        published = self.run_once({}, watchdog_source='raise ImportError("broken at /private/x")\n')
        [item] = published['watchdog']
        self.assertEqual(item['kind'], 'error')
        self.assertIn('Watchdog could not start. ImportError: broken at <path>', item['reason'])

    def test_watchdog_findings_do_not_crowd_the_housekeeping_list(self):
        published = self.run_once({})
        self.assertEqual([h['kind'] for h in published['housekeeping']], ['operation-retired'])


if __name__ == '__main__':
    unittest.main()
