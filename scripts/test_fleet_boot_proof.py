import base64
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


boot = load('fleet-boot-proof')
native = load('fleet-support')
storage = load('fleet-storage-maintenance')
OLD = {'identity': '11111111-1111-4111-8111-111111111111', 'epoch': 10, 'host': 'a' * 64}
NEW = {'identity': '22222222-2222-4222-8222-222222222222', 'epoch': 200, 'host': 'a' * 64}
TASK = 'a' * 64


class BootProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='native-boot-proof-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'tasks').mkdir()
        (self.root / 'capture').mkdir()
        self.receipt = self.root / 'tasks' / (TASK + '.receipt.json')
        self.record = {'id': TASK, 'session': 'native-session', 'phase': 'complete',
                       'result': str(self.root / 'capture/result.json'), 'created': 1, 'pid': 100}
        self.receipt.write_text(json.dumps(self.record))
        self.original = self.receipt.read_bytes()

    def check(self, current=OLD, now=100, machine='macbook', prepare=True):
        return boot.check(self.receipt, machine, prepare=prepare, boot=current, now=now)

    def archive(self):
        return next((self.root / 'native-boot-proofs').glob('*.json'))

    def test_preboot_write_once_exact_bytes_only_prove_strictly_later_boot(self):
        self.assertIsNone(self.check())
        archive = self.archive()
        saved = archive.read_bytes()
        self.assertEqual(base64.b64decode(json.loads(saved)['originalBase64']), self.original)
        self.assertIsNone(self.check(now=110))
        self.assertEqual(archive.read_bytes(), saved)
        self.assertIn('cannot survive', self.check(NEW, 300, prepare=False))
        self.assertEqual(self.receipt.read_bytes(), self.original)
        self.assertEqual(archive.read_bytes(), saved)
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)

    def test_one_immutable_witness_is_bounded_across_hundred_changed_observations(self):
        self.check()
        archive = self.archive(); first = archive.read_bytes()
        for index in range(100):
            self.receipt.write_text(json.dumps({**self.record, 'progress': index}))
            self.assertIsNone(self.check(now=110 + index / 10))
        self.assertEqual(len(list((self.root / 'native-boot-proofs').glob('*'))), 1)
        self.assertEqual(archive.read_bytes(), first)
        self.assertEqual(base64.b64decode(json.loads(first)['originalBase64']), self.original)
        self.assertIsNone(self.check(NEW, 300))

    def test_old_receipt_first_seen_after_reboot_cannot_certify_itself(self):
        self.assertIsNone(self.check(NEW, 300))
        self.assertIsNone(self.check(NEW, 400, prepare=False))
        self.assertEqual(json.loads(self.archive().read_text())['savedEpoch'], 300)

    def test_same_boot_wrong_machine_rollback_or_boot_before_save_remain_held(self):
        self.check()
        for current, now, machine in [(OLD, 300, 'macbook'), (NEW, 300, 'other'),
                                      ({**NEW, 'epoch': 99}, 300, 'macbook'),
                                      ({**NEW, 'epoch': 9}, 300, 'macbook'),
                                      (NEW, 199, 'macbook'), (NEW, 90, 'macbook'), ({**NEW, 'host': 'b' * 64}, 300, 'macbook'),
                                      ({**NEW, 'identity': 'invalid'}, 300, 'macbook')]:
            with self.subTest(current=current, now=now, machine=machine):
                self.assertIsNone(self.check(current, now, machine, prepare=False))

    def test_changed_digest_or_canonical_path_cannot_reuse_old_archive(self):
        self.check()
        self.receipt.write_bytes(self.original + b' ')
        self.assertIsNone(self.check(NEW, 300, prepare=False))
        self.receipt.write_bytes(self.original)
        destination = self.root / 'other'; destination.mkdir()
        moved = destination / 'tasks'; moved.mkdir()
        copy = moved / self.receipt.name; copy.write_bytes(self.original)
        self.assertIsNone(boot.check(copy, 'macbook', boot=NEW, now=300, prepare=False))
        self.assertEqual(base64.b64decode(json.loads(self.archive().read_text())['originalBase64']), self.original)

    def test_symlink_archive_or_result_paths_and_corrupt_archive_hold(self):
        self.check()
        archive = self.archive(); saved = archive.read_bytes()
        archive.write_text('{incomplete')
        self.assertIsNone(self.check(NEW, 300, prepare=False))
        archive.write_bytes(saved)
        moved = self.root / 'original-archive'; archive.rename(moved); archive.symlink_to(moved)
        self.assertIsNone(self.check(NEW, 300, prepare=False))
        archive.unlink(); moved.rename(archive)
        capture = self.root / 'capture'; target = self.root / 'capture-original'; capture.rename(target); capture.symlink_to(target, target_is_directory=True)
        self.assertIsNone(self.check(NEW, 300, prepare=False))

    def test_missing_kernel_data_or_malformed_kernel_observation_holds(self):
        with patch.object(boot, 'kernel_boot', return_value=None):
            self.assertIsNone(boot.check(self.receipt, 'macbook'))
        self.assertFalse((self.root / 'native-boot-proofs').exists())
        with patch.object(boot.sys, 'platform', 'darwin'), patch.object(boot.subprocess, 'check_output', return_value='invalid'):
            self.assertIsNone(boot.kernel_boot())

    def test_kernel_observation_hashes_physical_host_without_retaining_identifier(self):
        outputs = ['{ sec = 10, usec = 0 }\n', OLD['identity'] + '\n',
                   '"IOPlatformUUID" = "33333333-3333-4333-8333-333333333333"']
        with patch.object(boot.sys, 'platform', 'darwin'), patch.object(boot.subprocess, 'check_output', side_effect=outputs):
            observed = boot.kernel_boot()
        self.assertEqual(observed['identity'], OLD['identity'])
        self.assertEqual(len(observed['host']), 64)
        self.assertNotIn('33333333', json.dumps(observed))

    def test_native_storage_guard_consumes_companion_without_changing_legacy_history(self):
        self.check()
        with patch.object(storage, 'load', return_value=SimpleNamespace(check=lambda path, machine, **kw: boot.check(path, machine, boot=NEW, now=300, **kw))):
            self.assertTrue(storage.native_drained(self.receipt.parent, 'macbook'))
            self.assertFalse(storage.native_drained(self.receipt.parent, 'wrong'))
        self.assertEqual(self.receipt.read_bytes(), self.original)

    def supervisor(self):
        supervisor = native.SupportSupervisor(SimpleNamespace(), {'stateDirectory': str(self.root)})
        calls = []
        supervisor.rpc = lambda operation, body: calls.append((operation, body))
        return supervisor, calls

    def attention(self):
        self.record.update(phase='attention', custody={'root': {'pid': 100, 'identity': 'old', 'pgid': 100, 'sid': None},
                                                       'owned': {'100': 'old'}, 'unproved': {}, 'phase': 'drained'})
        self.receipt.write_text(json.dumps(self.record))
        self.original = self.receipt.read_bytes()

    def test_attention_witness_follows_first_custody_update_and_can_prove_later_boot(self):
        self.attention()
        self.record['custody']['phase'] = 'alive'
        self.receipt.write_text(json.dumps(self.record))
        journal = {'commands': [{'root': {'pid': 101, 'identity': 'old-child', 'pgid': 101, 'sid': None},
                                  'owned': {'101': 'old-child'}, 'phase': 'alive'}]}
        (self.root / 'capture/execution.custody.json').write_text(json.dumps(journal))
        snapshot = {101: {'pid': 101, 'ppid': 1, 'pgid': 101, 'sid': None, 'identity': 'old-child', 'state': 'S'}}
        supervisor, calls = self.supervisor()
        with patch.object(supervisor, 'boot_proof', side_effect=lambda machine, path, **kw: boot.check(path, machine, boot=OLD, now=100, **kw)), \
                patch.object(native, 'process_snapshot', return_value=snapshot):
            supervisor.receipt_pass('macbook', self.receipt, [])
        self.assertEqual(calls, [])
        current = self.receipt.read_bytes()
        self.assertEqual(json.loads(current)['custody']['phase'], 'drained')
        self.assertEqual(base64.b64decode(json.loads(self.archive().read_text())['originalBase64']), current)
        self.assertIn('cannot survive', self.check(NEW, 300, prepare=False))

    def test_terminal_witness_follows_successful_artifact_recovery(self):
        (self.root / 'capture/result.json').write_text(json.dumps({'outcome': 'completed', 'summary': 'Old result', 'files': {}}))
        supervisor, calls = self.supervisor()
        with patch.object(supervisor, 'boot_proof', side_effect=lambda machine, path, **kw: boot.check(path, machine, boot=OLD, now=100, **kw)), \
                patch.object(supervisor, 'return_artifacts', return_value='retained-digest'):
            supervisor.receipt_pass('macbook', self.receipt, [])
        current = self.receipt.read_bytes()
        self.assertEqual(json.loads(current)['artifactDigest'], 'retained-digest')
        self.assertEqual(base64.b64decode(json.loads(self.archive().read_text())['originalBase64']), current)
        self.assertIn('cannot survive', self.check(NEW, 300, prepare=False))

    def test_transient_artifact_failure_does_not_bind_unstable_terminal_record(self):
        (self.root / 'capture/result.json').write_text(json.dumps({'outcome': 'completed', 'summary': 'Old result', 'files': {}}))
        supervisor, calls = self.supervisor()
        with patch.object(supervisor, 'boot_proof', side_effect=lambda machine, path, **kw: boot.check(path, machine, boot=OLD, now=100, **kw)), \
                patch.object(supervisor, 'return_artifacts', side_effect=RuntimeError('lost reply')):
            with self.assertRaises(native.ArtifactPassError):
                supervisor.receipt_pass('macbook', self.receipt, [])
        self.assertFalse((self.root / 'native-boot-proofs').exists())

    def test_copied_native_worker_runs_without_the_supervisor_only_boot_module(self):
        worker = self.root / 'worker.py'
        shutil.copyfile(Path(native.__file__), worker)
        (self.root / 'task.json').write_text(json.dumps({'request': {'recipe': 'platform-probe'}}))
        (self.root / 'paths.json').write_text('{}')
        result = subprocess.run([sys.executable, str(worker), '--worker', str(self.root)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.root / 'result.json').read_text())['outcome'], 'completed')
        self.assertFalse((self.root / 'fleet-boot-proof.py').exists())

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin kernel boot identity required')
    def test_real_native_kernel_observation_does_not_certify_current_boot(self):
        observed = boot.kernel_boot()
        if observed is None:
            self.skipTest('Kernel observation unavailable in this execution environment')
        self.assertIsNone(boot.check(self.receipt, 'macbook'))
        self.assertIsNone(boot.check(self.receipt, 'macbook', prepare=False))
        self.assertEqual(self.receipt.read_bytes(), self.original)

    def test_native_missing_result_settles_failed_only_after_worker_and_all_groups_drained(self):
        self.attention()
        journal = {'commands': [{'root': {'pid': 101, 'identity': 'old-child', 'pgid': 101, 'sid': None},
                                  'owned': {'101': 'old-child'}, 'phase': 'alive'}]}
        (self.root / 'capture/execution.custody.json').write_text(json.dumps(journal))
        supervisor, calls = self.supervisor()
        with patch.object(supervisor, 'boot_proof', side_effect=lambda machine, path, **kw: boot.check(path, machine, boot=OLD, now=100, **kw)), \
                patch.object(native, 'process_snapshot', return_value={}):
            supervisor.receipt_pass('macbook', self.receipt, [])
        self.assertEqual([op for op, body in calls], ['complete'])
        self.assertEqual(calls[0][1]['result']['outcome'], 'failed')
        self.assertIn('interrupted', calls[0][1]['result']['summary'])
        self.assertEqual(json.loads(self.receipt.read_text())['phase'], 'complete')
        self.assertFalse((self.root / 'native-boot-proofs').exists(), 'Tracked drained tasks do not create boot history')
        self.assertTrue((self.root / 'capture/execution.custody.json').exists())

    def test_missing_result_and_missing_command_journal_never_release(self):
        self.attention(); supervisor, calls = self.supervisor(); running = []
        with patch.object(supervisor, 'boot_proof', return_value=None), patch.object(native, 'process_snapshot', return_value={}):
            supervisor.receipt_pass('macbook', self.receipt, running)
        self.assertEqual(calls, [])
        self.assertEqual(running[0]['phase'], 'attention')

    def test_running_missing_result_without_command_proof_escalates_once(self):
        self.attention(); self.record['phase'] = 'running'
        self.receipt.write_text(json.dumps(self.record))
        supervisor, calls = self.supervisor()
        with patch.object(supervisor, 'boot_proof', return_value=None), patch.object(native, 'process_snapshot', return_value={}):
            supervisor.receipt_pass('macbook', self.receipt, [])
            supervisor.receipt_pass('macbook', self.receipt, [])
        self.assertEqual([operation for operation, body in calls], ['uncertain'])
        self.assertEqual(json.loads(self.receipt.read_text())['phase'], 'attention')

    def test_native_missing_result_lost_release_retries_identical_failed_result(self):
        self.attention()
        (self.root / 'capture/execution.custody.json').write_text(json.dumps({'commands': [
            {'root': {'pid': 101, 'identity': 'old-child', 'pgid': 101, 'sid': None},
             'owned': {'101': 'old-child'}, 'phase': 'alive'}]}))
        supervisor, calls = self.supervisor()
        def lost(operation, body):
            calls.append((operation, body))
            raise RuntimeError('lost response')
        supervisor.rpc = lost
        with patch.object(supervisor, 'boot_proof', return_value=None), patch.object(native, 'process_snapshot', return_value={}):
            with self.assertRaises(native.ReleasePassError):
                supervisor.receipt_pass('macbook', self.receipt, [])
            first = json.loads(self.receipt.read_text())['interrupted']['result']
            supervisor.rpc = lambda operation, body: calls.append((operation, body))
            supervisor.receipt_pass('macbook', self.receipt, [])
        self.assertEqual([body['result'] for operation, body in calls], [first, first])
        self.assertEqual(first['outcome'], 'failed')
        self.assertEqual(json.loads(self.receipt.read_text())['phase'], 'complete')

    def test_boot_proof_can_settle_missing_result_without_old_pid_inference(self):
        self.record['phase'] = 'attention'; self.receipt.write_text(json.dumps(self.record)); self.original = self.receipt.read_bytes()
        self.check(); supervisor, calls = self.supervisor()
        with patch.object(supervisor, 'boot_proof', side_effect=lambda machine, path, **kw: boot.check(path, machine, boot=NEW, now=300, **kw)), \
                patch.object(native, 'process_snapshot', side_effect=AssertionError('Boot proof needs no PID guess')):
            supervisor.receipt_pass('macbook', self.receipt, [])
        self.assertEqual(calls[0][1]['result']['outcome'], 'failed')
        self.assertTrue(json.loads(self.receipt.read_text())['drainConfirmed'])
        self.assertEqual(base64.b64decode(json.loads(self.archive().read_text())['originalBase64']), self.original)


if __name__ == '__main__':
    unittest.main()
