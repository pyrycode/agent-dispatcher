import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
import hashlib
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('build_cache', Path(__file__).with_name('fleet-build-cache.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        (self.cache / 'README').write_text(m.CACHE_README)
        self.entry = self.data(b'compiled output')
        self.bucket = self.entry.parent
        self.fuzz = self.cache / 'fuzz/pkg/FuzzName'
        self.fuzz.mkdir(parents=True)
        (self.fuzz / 'failed-input').write_bytes(b'go test fuzz v1\nstring("failure")\n')
        (self.cache / 'retained-evidence').mkdir()
        (self.cache / 'retained-evidence/failure.log').write_text('original failed build')
        self.source = self.root / 'source.go'
        self.source.write_text('package main\n')
        self.config = {'cache': str(self.cache), 'maxBytes': 1, 'reserveBytes': 0,
                       'timeoutSeconds': 60, 'receipt': str(self.root / 'receipt.json')}
        self.proof = {'allowed': True, 'exclusive': True, 'lease': str(uuid.uuid4()),
                      'custody': 'drained', 'admissionHeld': True}

    def data(self, value):
        digest = hashlib.sha256(value).hexdigest()
        bucket = self.cache / digest[:2]
        bucket.mkdir(exist_ok=True)
        entry = bucket / (digest + '-d')
        entry.write_bytes(value)
        return entry

    def manage(self, **extra):
        return m.manage_cache(self.config, lambda: dict(self.proof), process_inventory=lambda: [], **extra)

    def test_threshold_dry_run_and_apply_use_the_same_leaf_verified_backend_without_child_commands(self):
        before = (self.fuzz / 'failed-input').read_bytes()
        dry = self.manage()
        self.assertEqual(dry['phase'], 'planned')
        self.assertTrue(self.entry.exists())
        with patch.object(m.subprocess, 'run', side_effect=AssertionError('No external cleaner may run')):
            done = self.manage(apply=True)
        self.assertEqual(done['phase'], 'complete', done)
        self.assertEqual(done['trimResult']['backend'], 'descriptor-relative')
        self.assertEqual(done['trimResult']['filesRemoved'], 1)
        self.assertEqual(done['trimResult']['reclaimedBytes'], len(b'compiled output'))
        self.assertEqual((self.fuzz / 'failed-input').read_bytes(), before)
        self.assertEqual(self.source.read_text(), 'package main\n')
        self.assertEqual((self.cache / 'retained-evidence/failure.log').read_text(), 'original failed build')
        self.assertEqual(done['before']['retainedFingerprint'], done['after']['retainedFingerprint'])
        self.assertEqual(json.loads(Path(self.config['receipt']).read_text())['phase'], 'complete')

    def test_under_budget_does_not_trim_after_each_ticket_and_repeat_is_idempotent(self):
        self.config['maxBytes'] = 10**9
        self.assertEqual(self.manage(apply=True)['phase'], 'within-budget')
        self.config['maxBytes'] = 1
        self.assertEqual(self.manage(apply=True)['phase'], 'complete')
        self.assertEqual(self.manage(apply=True)['phase'], 'within-budget')

    def test_low_free_space_is_a_separate_explicit_trigger(self):
        self.config['maxBytes'] = 10**9
        self.config['reserveBytes'] = 100
        result = m.manage_cache(self.config, lambda: dict(self.proof), process_inventory=lambda: [],
                                disk_usage=lambda path: shutil._ntuple_diskusage(1000, 950, 50))
        self.assertEqual(result['phase'], 'planned')
        self.assertIn('free-space-reserve', result['triggers'])

    def test_active_uncertain_and_lost_lease_refuse_without_touching_cache(self):
        for change in [{'allowed': False}, {'custody': 'uncertain'}, {'admissionHeld': False}, {'exclusive': False}]:
            proof = {**self.proof, **change}
            result = m.manage_cache(self.config, lambda: proof, apply=True, process_inventory=lambda: [])
            self.assertEqual(result['phase'], 'refused')
        for census in [None, [{'pid': 999, 'executable': '/usr/bin/go', 'state': 'S'}]]:
            result = m.manage_cache(self.config, lambda: self.proof, apply=True, process_inventory=lambda: census)
            self.assertEqual(result['phase'], 'refused')
        proofs = iter([self.proof, {**self.proof, 'lease': str(uuid.uuid4())}])
        result = m.manage_cache(self.config, lambda: next(proofs), apply=True, process_inventory=lambda: [])
        self.assertEqual(result['phase'], 'refused')
        self.assertTrue(self.entry.exists())

    def test_symlink_and_unrecognized_candidate_content_refuse(self):
        self.entry.unlink()
        self.entry.symlink_to(self.source)
        self.assertEqual(self.manage(apply=True)['phase'], 'refused')
        self.assertEqual(self.source.read_text(), 'package main\n')
        self.entry.unlink()
        (self.bucket / 'failed-build.log').write_text('failure')
        self.assertEqual(self.manage(apply=True)['phase'], 'refused')

    def test_a_writer_appearing_between_plan_and_apply_prevents_deletion(self):
        calls = []
        def guard():
            calls.append(True)
            if len(calls) == 2:
                self.entry.write_bytes(b'new compiled output after planning')
            return self.proof
        result = m.manage_cache(self.config, guard, apply=True, process_inventory=lambda: [])
        self.assertEqual(result['phase'], 'refused')
        self.assertEqual(self.entry.read_bytes(), b'new compiled output after planning')

    def test_symlink_cache_root_and_legacy_log_are_preserved(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.cache, target_is_directory=True)
        self.config['cache'] = str(alias)
        self.assertEqual(self.manage(apply=True)['phase'], 'refused')
        self.config['cache'] = str(self.cache)
        (self.cache / 'log.txt').write_text('unclassified retained log')
        self.assertEqual(self.manage(apply=True)['phase'], 'complete')
        self.assertFalse(self.entry.exists())
        self.assertEqual((self.cache / 'log.txt').read_text(), 'unclassified retained log')

    def test_actual_partial_unlink_failure_retains_uncertain_receipt_and_blocks_unchanged_retry(self):
        other = self.data(b'another compiled output')
        original_unlink = os.unlink
        removals = []
        def interrupted(path, **kwargs):
            if removals:
                raise OSError('Fixture interruption after a real cache leaf was removed')
            original_unlink(path, **kwargs)
            removals.append(path)
        with patch.object(m.os, 'unlink', side_effect=interrupted):
            result = self.manage(apply=True)
        self.assertEqual(result['phase'], 'uncertain')
        self.assertFalse(result['releaseSafe'])
        self.assertEqual(sum(path.exists() for path in [self.entry, other]), 1)
        self.assertEqual(json.loads(Path(self.config['receipt']).read_text())['phase'], 'uncertain')
        self.assertEqual(self.manage(apply=True)['phase'], 'uncertain')
        self.assertEqual(sum(path.exists() for path in [self.entry, other]), 1)

    def test_saved_cleaning_receipt_never_becomes_permission_to_replay_after_process_restart(self):
        Path(self.config['receipt']).write_text(json.dumps({'phase': 'cleaning', 'releaseSafe': False,
                                                          'proof': self.proof, 'before': {'compiledBytes': 15}}))
        result = self.manage(apply=True)
        self.assertEqual(result['phase'], 'uncertain')
        self.assertFalse(result['releaseSafe'])
        self.assertTrue(self.entry.exists())

    def test_new_unknown_failure_inside_bucket_after_final_scan_survives_without_a_recursive_cleaner(self):
        late = self.bucket / 'unique-failed-investigation.log'
        original_unlink = os.unlink
        def append_evidence_then_unlink(path, **kwargs):
            late.write_bytes(b'new unique evidence after all preflight checks')
            return original_unlink(path, **kwargs)
        with patch.object(m.os, 'unlink', side_effect=append_evidence_then_unlink):
            result = self.manage(apply=True)
        self.assertEqual(late.read_bytes(), b'new unique evidence after all preflight checks')
        self.assertEqual(result['phase'], 'uncertain')
        self.assertFalse(result['releaseSafe'])
        self.assertEqual((self.fuzz / 'failed-input').read_bytes(), b'go test fuzz v1\nstring("failure")\n')

    def test_corrupted_hash_named_data_and_invalid_action_records_are_kept_on_every_platform(self):
        corrupt = self.entry
        corrupt.write_bytes(b'unique corrupted cache evidence with a wrong content hash')
        action = self.bucket / (self.bucket.name + '2' * 62 + '-a')
        action.write_bytes(b'v1 invalid action record retained for investigation')
        good = self.data(b'ordinary reproducible output')
        result = self.manage(apply=True)
        self.assertEqual(result['phase'], 'failed')
        self.assertFalse(result['budgetMet'])
        self.assertTrue(corrupt.exists())
        self.assertTrue(action.exists())
        self.assertFalse(good.exists())
        self.assertIn(str(corrupt.relative_to(self.cache)), result['trimResult']['preservedEntries'])
        self.assertIn(str(action.relative_to(self.cache)), result['trimResult']['preservedEntries'])

    def test_cache_root_swap_cannot_redirect_deletion_to_outside_evidence(self):
        outside = self.root / 'outside'
        (outside / 'bb').mkdir(parents=True)
        evidence = outside / 'bb/unique-failure.log'
        evidence.write_text('failed evidence must remain')
        original = self.root / 'original-cache'
        guards = []
        def guard():
            guards.append(True)
            if len(guards) == 3:
                self.cache.rename(original)
                self.cache.symlink_to(outside, target_is_directory=True)
            return self.proof
        done = m.manage_cache(self.config, guard, apply=True, process_inventory=lambda: [])
        self.assertEqual(done['phase'], 'uncertain')
        self.assertFalse(done['releaseSafe'])
        self.assertEqual(evidence.read_text(), 'failed evidence must remain')
        self.assertEqual((original / 'fuzz/pkg/FuzzName/failed-input').read_bytes(),
                         b'go test fuzz v1\nstring("failure")\n')
        self.assertTrue((original / self.bucket.name).exists())

    def test_real_cached_executable_process_prevents_cleanup(self):
        if m.process_inventory() is None:
            self.skipTest('native process census unavailable')
        self.entry.unlink()
        self.entry.mkdir()
        program = self.entry / 'cache-sleeper'
        shutil.copyfile('/bin/sleep', program)
        program.chmod(0o700)
        child = subprocess.Popen([str(program), '30'])
        try:
            result = m.manage_cache(self.config, lambda: self.proof, apply=True)
            self.assertEqual(result['phase'], 'refused')
            self.assertTrue(program.exists())
        finally:
            child.terminate()
            child.wait(timeout=5)

    def test_hardlinks_and_executable_directories_are_preserved_on_every_platform(self):
        linked = self.root / 'linked-source'
        os.link(self.entry, linked)
        binary = self.bucket / (self.bucket.name + '3' * 62 + '-d')
        binary.mkdir()
        payload = binary / 'dormant-binary'
        payload.write_bytes(b'cached executable retained')
        payload.chmod(0o700)
        result = self.manage(apply=True)
        self.assertEqual(result['phase'], 'failed')
        self.assertFalse(result['budgetMet'])
        self.assertEqual(linked.read_bytes(), b'compiled output')
        self.assertTrue(self.entry.exists())
        self.assertTrue(payload.exists())

    def test_unmet_free_space_reserve_is_not_reported_complete(self):
        self.config['maxBytes'] = 10**9
        self.config['reserveBytes'] = 100
        result = m.manage_cache(self.config, lambda: self.proof, apply=True,
                                process_inventory=lambda: [], disk_usage=lambda path: shutil._ntuple_diskusage(1000, 950, 50))
        self.assertEqual(result['phase'], 'failed')
        self.assertTrue(result['budgetMet'])
        self.assertFalse(result['reserveMet'])

    def test_versioned_action_record_must_name_its_own_action_hash(self):
        action_hash = 'a' * 64
        bucket = self.cache / 'aa'
        bucket.mkdir(exist_ok=True)
        correct = bucket / (action_hash + '-a')
        correct.write_bytes(f'v1 {action_hash} {"b"*64} {14:20d} {123:20d}\n'.encode())
        wrong = bucket / ('a' * 63 + 'b-a')
        wrong.write_bytes(f'v1 {action_hash} {"b"*64} {14:20d} {123:20d}\n'.encode())
        result = self.manage(apply=True)
        self.assertEqual(result['phase'], 'failed')
        self.assertFalse(correct.exists())
        self.assertTrue(wrong.exists())
        self.assertIn(str(wrong.relative_to(self.cache)), result['trimResult']['preservedEntries'])


if __name__ == '__main__':
    unittest.main()
