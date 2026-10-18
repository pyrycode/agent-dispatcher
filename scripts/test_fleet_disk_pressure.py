import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


disk = load('fleet-disk-pressure')
native = load('fleet-support')
TASK = 'a' * 64


class Child:
    pid = 4242
    def poll(self):
        return None


class DiskTests(unittest.TestCase):
    def test_below_unknown_equal_and_above_floor_are_distinguished(self):
        policy = {'path': '/known/local/data', 'minFreeBytes': 200}
        self.assertEqual(disk.check(policy, lambda path: 199)['state'], 'waiting-storage')
        for value in [200, 201]:
            self.assertEqual(disk.check(policy, lambda path: value)['state'], 'ready')
        for value in [None, -1, float('nan')]:
            self.assertFalse(disk.check(policy, lambda path: value)['allowed'])
        def unavailable(path):
            raise OSError('statvfs unavailable')
        self.assertIsNone(disk.check(policy, unavailable)['freeBytes'])

    def test_invalid_config_and_unreadable_filesystem_fail_closed_and_real_local_probe_works(self):
        for policy in [{'path': 'relative', 'minFreeBytes': 1}, {'path': '/data', 'minFreeBytes': 0},
                       {'path': '/data', 'minFreeBytes': True}, {'path': '/data/../other', 'minFreeBytes': 1}]:
            self.assertFalse(disk.check(policy)['allowed'])
        self.assertFalse(disk.check({'path': '/missing-disk-pressure-fixture', 'minFreeBytes': 1})['allowed'])
        free = disk.available_bytes(tempfile.gettempdir())
        self.assertGreaterEqual(free, 0)
        self.assertEqual(disk.check(None), {'state': 'disabled', 'allowed': True})


class NativeTests(unittest.TestCase):
    def fixture(self, directory, recipe='dispatcher-repair'):
        state = {'machine': 'mac', 'runs': [{'id': 'run-a', 'machine': 'mac', 'session': 'scheduler', 'supportTaskId': TASK}], 'draining': False}
        class Adapter:
            def status(self):
                return state
        route = {'capability': 'test-capability', 'directory': directory + '/native', 'paths': {}}
        config = {'stateDirectory': directory, 'diskAdmission': {'path': directory, 'minFreeBytes': 200},
                  'recoveryTasks': {recipe + ':test-capability': route}}
        supervisor = native.SupportSupervisor(Adapter(), config)
        grants = [{'task': {'id': TASK, 'ticket': 'org/app#1', 'request': {'recipe': recipe, 'capability': 'test-capability'}},
                   'run': {'id': 'run-a', 'session': 'scheduler', 'supportTaskId': TASK}}]
        calls = []
        def rpc(operation, body):
            calls.append((operation, body))
            return grants if operation == 'schedule' else {}
        supervisor.rpc = rpc
        return supervisor, state, config, grants, calls

    def test_low_or_unknown_space_defers_admitted_native_task_without_releasing_or_launching_it(self):
        for pressure in [{'state': 'waiting-storage', 'allowed': False, 'freeBytes': 199, 'minFreeBytes': 200, 'reason': 'Below configured floor'},
                         {'state': 'waiting-storage', 'allowed': False, 'freeBytes': None, 'minFreeBytes': 200, 'reason': 'Space unknown'}]:
            with self.subTest(pressure=pressure), tempfile.TemporaryDirectory() as directory:
                supervisor, state, config, grants, calls = self.fixture(directory)
                before = json.dumps(state, sort_keys=True)
                with patch.object(supervisor, 'route_ready', return_value=True), patch.object(supervisor, 'disk_admission', return_value=pressure), patch.object(native.subprocess, 'Popen') as spawn:
                    first = supervisor.tick()
                    supervisor.tick()
                spawn.assert_not_called()
                self.assertEqual(first[0]['phase'], 'waiting-storage')
                self.assertFalse((supervisor.directory / (TASK + '.receipt.json')).exists())
                self.assertEqual(json.dumps(state, sort_keys=True), before)
                self.assertFalse(any(operation in ('complete', 'release', 'finish') for operation, body in calls))

    def test_task_resumes_above_floor_and_next_launch_rechecks_instead_of_reusing_one_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            supervisor, state, config, grants, calls = self.fixture(directory)
            second = json.loads(json.dumps(grants[0]))
            second['task']['id'] = 'b' * 64
            second['run']['id'] = 'run-b'
            second['run']['supportTaskId'] = 'b' * 64
            grants.append(second)
            free = [199]
            def pressure():
                return disk.check(config['diskAdmission'], lambda path: free[0])
            with patch.object(supervisor, 'route_ready', return_value=True), patch.object(supervisor, 'disk_admission', side_effect=pressure) as probe, \
                 patch.object(native.subprocess, 'Popen', return_value=Child()) as spawn, patch.object(native, 'new_custody', return_value={'root': {'pid': 4242}}), \
                 patch.object(supervisor, 'receipt_pass'):
                self.assertEqual(supervisor.tick()[0]['phase'], 'waiting-storage')
                free[0] = 200
                self.assertEqual(supervisor.tick()[-1]['phase'], 'running')
                free[0] = 199
                self.assertEqual(supervisor.tick()[-1]['phase'], 'waiting-storage')
                self.assertEqual(spawn.call_count, 1)
                self.assertGreaterEqual(probe.call_count, 3)
            self.assertFalse((supervisor.directory / (TASK + '.deferred.json')).exists())
            self.assertEqual(json.loads((supervisor.directory / (TASK + '.receipt.json')).read_text())['phase'], 'running')
            self.assertFalse((supervisor.directory / ('b' * 64 + '.receipt.json')).exists())

    def test_existing_worker_receipt_is_observed_without_any_disk_probe_or_relaunch(self):
        with tempfile.TemporaryDirectory() as directory:
            supervisor, state, config, grants, calls = self.fixture(directory)
            receipt = supervisor.directory / (TASK + '.receipt.json')
            native.atomic(receipt, {'id': TASK, 'phase': 'running', 'pid': 101, 'session': 'scheduler'})
            before = receipt.read_bytes()
            with patch.object(supervisor, 'route_ready', return_value=True), patch.object(supervisor, 'receipt_pass') as observe, \
                 patch.object(supervisor, 'disk_admission', side_effect=AssertionError('Existing worker must stay admitted')), patch.object(native.subprocess, 'Popen') as spawn:
                supervisor.tick()
            self.assertEqual(observe.call_count, 1)
            spawn.assert_not_called()
            self.assertEqual(receipt.read_bytes(), before)

    def test_saved_supervisor_policy_reaches_real_native_filesystem_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            initial, state, config, grants, calls = self.fixture(directory)
            config['diskAdmission']['minFreeBytes'] = 9007199254740991
            path = Path(directory) / 'supervisor.json'
            path.write_text(json.dumps(config))
            supervisor = native.SupportSupervisor(initial.adapter, json.loads(path.read_text()))
            supervisor.rpc = initial.rpc
            with patch.object(supervisor, 'route_ready', return_value=True), patch.object(native.subprocess, 'Popen') as spawn:
                result = supervisor.tick()
            self.assertEqual(result[0]['phase'], 'waiting-storage')
            self.assertEqual(result[0]['minFreeBytes'], 9007199254740991)
            self.assertIsInstance(result[0]['freeBytes'], int)
            spawn.assert_not_called()

    def test_fixed_light_platform_probe_does_not_consume_a_heavy_storage_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            supervisor, state, config, grants, calls = self.fixture(directory, 'platform-probe')
            with patch.object(supervisor, 'route_ready', return_value=True), patch.object(supervisor, 'disk_admission', side_effect=AssertionError('Fixed light probe needs no heavy slot')), \
                 patch.object(native.subprocess, 'Popen', return_value=Child()) as spawn, patch.object(native, 'new_custody', return_value={'root': {'pid': 4242}}):
                result = supervisor.tick()
            self.assertEqual(spawn.call_count, 1)
            self.assertEqual(result[-1]['phase'], 'running')


if __name__ == '__main__':
    unittest.main()
