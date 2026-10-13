"""Regressions from the retained #1947 independent review."""
import importlib.util
import hashlib
import json
import subprocess
import errno
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('fleet-support.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def artifact_reply(operation,body):
    if operation=='artifacts-begin':
        manifest=body['manifest']
        return {'digest':hashlib.sha256(json.dumps(manifest,separators=(',',':')).encode()).hexdigest(),
                'missing':{entry['path']:list(range(len(entry['chunks']))) for entry in manifest['files']}}
    return []


class SetupCustodyTests(unittest.TestCase):
    def test_successful_parent_exit_then_denied_probe_is_not_a_missing_process(self):
        root = {'pid': 123, 'identity': 'root', 'pgid': 123, 'sid': 123, 'ppid': 1, 'state': 'S'}
        class Child:
            pid = 123
            reaped = False
            def poll(self): self.reaped = True; return 0
            def wait(self, timeout=None): self.reaped = True; return 0
        child = Child()
        signals = []
        def send(pid, sig):
            signals.append(sig)
            if sig == 0: raise PermissionError(errno.EPERM, 'fixture denied probe')
            raise ProcessLookupError
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            with patch.object(m.subprocess, 'Popen', return_value=child), \
                 patch.object(m, 'process_snapshot', create=True, side_effect=lambda: {} if child.reaped else {123: root}), \
                 patch.object(m.os, 'killpg', side_effect=send):
                self.assertEqual(m.execute(['fixture'], directory, directory / 'execution.log'), 0)
            self.assertEqual(signals, [0], 'denied probes must never cause another signal')

    def test_failed_clone_and_fetch_leave_confirmed_command_custody(self):
        root = {'pid': 123, 'identity': 'root', 'pgid': 123, 'sid': 123, 'ppid': 1, 'state': 'Z'}
        for failed_step in (1, 3):
            with self.subTest(failed_step=failed_step), tempfile.TemporaryDirectory() as d:
                directory = Path(d)
                m.atomic(directory / 'task.json', {'request': {'recipe': 'memory-runtime-smoke'}})
                calls = []

                class Child:
                    pid = 123
                    def __init__(self, code): self.returncode = code
                    def poll(self): return self.returncode
                    def wait(self, timeout=None): return self.returncode
                    def communicate(self, input=None, timeout=None): return b'', b''
                    def __enter__(self): return self
                    def __exit__(self, *args): pass

                def spawn(argv, **kwargs):
                    calls.append(argv)
                    child = Child(1 if len(calls) == failed_step else 0)
                    child.args = argv
                    return child

                with patch.object(m.subprocess, 'Popen', side_effect=spawn), \
                     patch.object(m, 'process_snapshot', return_value={123: root}), \
                     patch.object(m.os, 'killpg', side_effect=ProcessLookupError):
                    with self.assertRaises((RuntimeError, subprocess.SubprocessError)):
                        m.clone('source', directory / 'core', 'a' * 40)
                    self.assertEqual(m.directory_custody(directory), 'drained')
                commands = json.loads(m.custody_file(directory / 'execution.log').read_text())['commands']
                self.assertEqual(len(commands), failed_step)
                self.assertTrue(all(c['phase'] == 'drained' for c in commands))
                # A setup failure must return its failed result through normal
                # completion once the worker and every setup command drain.
                class Adapter:
                    def status(self): return {'machine': 'mac', 'draining': True}
                supervisor = m.SupportSupervisor(Adapter(), {'stateDirectory': d, 'recoveryTasks': {'native': {'capability': 'macos-arm64'}}})
                result = directory / 'result.json'
                value = {'outcome': 'failed', 'summary': 'Checkout setup failed', 'files': {}}
                m.atomic(result, value)
                receipt = supervisor.directory / 'job.receipt.json'
                m.atomic(receipt, {'id': 'job', 'session': 's', 'phase': 'attention', 'pid': 123,
                                  'custody': {'root': root, 'owned': {'123': 'root'}, 'phase': 'uncertain'}, 'result': str(result)})
                operations = []
                supervisor.rpc = lambda op, body: operations.append((op, body)) or artifact_reply(op,body)
                with patch.object(m, 'process_snapshot', return_value={}): supervisor.tick()
                complete = [body for op, body in operations if op == 'artifacts-commit']
                self.assertEqual(complete, [{'machine': 'mac', 'id': 'job', 'session': 's', 'digest':artifact_reply('artifacts-begin',{'manifest':m.artifact_manifest({})})['digest'], 'result': value}])
                self.assertEqual(json.loads(receipt.read_text())['phase'], 'complete')

    def test_setup_launch_failure_records_that_no_process_was_started(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            m.atomic(directory / 'task.json', {'request': {'recipe': 'memory-runtime-smoke'}})
            with patch.object(m.subprocess, 'Popen', side_effect=FileNotFoundError):
                with self.assertRaises((RuntimeError, OSError)):
                    m.clone('source', directory / 'core')
            self.assertEqual(m.directory_custody(directory), 'drained')

    def test_publication_retry_retains_confirmed_drainage_across_restart_and_pid_reuse(self):
        root = {'pid': 123, 'identity': 'original', 'pgid': 123, 'sid': 123, 'ppid': 1, 'state': 'S'}
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            class Adapter:
                def status(self): return {'machine': 'mac', 'draining': True}
            config = {'stateDirectory': d, 'recoveryTasks': {'repair': {'capability': 'dispatcher-repair'}}}
            supervisor = m.SupportSupervisor(Adapter(), config)
            result = directory / 'result.json'
            m.atomic(result, {'outcome': 'completed', 'summary': 'checked repair', 'files': {'publication.json': '{"review":"PASS"}'}})
            m.atomic(m.custody_file(directory / 'execution.log'), {'commands': [{'root': root, 'owned': {'123': 'original'}, 'phase': 'drained'}]})
            receipt = supervisor.directory / 'job.receipt.json'
            m.atomic(receipt, {'id': 'job', 'session': 's', 'phase': 'running', 'pid': 123,
                              'custody': {'root': root, 'owned': {'123': 'original'}, 'phase': 'alive'}, 'result': str(result)})
            operations = []; interrupted = [True]; manifests = []
            def rpc(op, body):
                operations.append(op)
                if op == 'publish-repair':
                    return {'pendingControl': True} if operations.count(op) == 1 else {'url': 'https://github.com/org/dispatcher/pull/1', 'merged': True}
                if op == 'artifacts-begin': manifests.append(body['manifest'])
                if op == 'artifacts-put' and interrupted[0]:
                    interrupted[0] = False
                    raise RuntimeError('Interrupted artifact upload')
                return artifact_reply(op,body)
            supervisor.rpc = rpc
            with patch.object(m, 'process_snapshot', return_value={}): supervisor.tick()
            self.assertEqual(json.loads(receipt.read_text())['phase'], 'publishing')
            restarted = m.SupportSupervisor(Adapter(), config)
            restarted.rpc = rpc
            # An unrelated process now owns the old PID; it must never receive
            # signals or invalidate drainage already proved before publication.
            with patch.object(m, 'process_snapshot', return_value={123: {**root, 'identity': 'unrelated'}}), \
                 patch.object(m.os, 'killpg') as send:
                # The interrupted record is skipped and reported; the pass continues.
                skipped = [e for e in restarted.tick() if e.get('phase') == 'error']
                self.assertEqual([e['id'] for e in skipped], ['job'])
                self.assertIn('Interrupted artifact upload', skipped[0]['reason'])
                resumed = m.SupportSupervisor(Adapter(), config); resumed.rpc = rpc
                resumed.tick()
                send.assert_not_called()
            self.assertNotIn('uncertain', operations)
            self.assertEqual(operations.count('publish-repair'), 2)
            self.assertEqual(manifests[0], manifests[1])
            self.assertEqual(operations.count('artifacts-commit'), 1)
            self.assertEqual(json.loads(receipt.read_text())['phase'], 'complete')


if __name__ == '__main__': unittest.main()
