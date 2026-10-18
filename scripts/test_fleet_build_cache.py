import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
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
        self.bucket = self.cache / 'aa'
        self.bucket.mkdir()
        self.entry = self.bucket / ('aa' + '1' * 62 + '-d')
        self.entry.write_bytes(b'compiled output')
        self.fuzz = self.cache / 'fuzz/pkg/FuzzName'
        self.fuzz.mkdir(parents=True)
        (self.fuzz / 'failed-input').write_bytes(b'go test fuzz v1\nstring("failure")\n')
        (self.cache / 'retained-evidence').mkdir()
        (self.cache / 'retained-evidence/failure.log').write_text('original failed build')
        self.source = self.root / 'source.go'
        self.source.write_text('package main\n')
        self.config = {'cache': str(self.cache), 'go': '/trusted/go', 'maxBytes': 1,
                       'reserveBytes': 0, 'timeoutSeconds': 60, 'receipt': str(self.root / 'receipt.json')}
        self.proof = {'allowed': True, 'exclusive': True, 'lease': str(uuid.uuid4()),
                      'custody': 'drained', 'admissionHeld': True}
        self.calls = []

    def run_clean(self, argv, **options):
        self.calls.append((argv, options))
        shutil.rmtree(self.bucket)
        return {'returncode': 0, 'custody': 'drained', 'pid': 123, 'identity': 'recorded-start'}

    def manage(self, **extra):
        return m.manage_cache(self.config, lambda: dict(self.proof), process_inventory=lambda: [],
                              run_command=self.run_clean, **extra)

    def test_threshold_dry_run_and_apply_only_use_supported_build_cache_command(self):
        before = (self.fuzz / 'failed-input').read_bytes()
        dry = self.manage()
        self.assertEqual(dry['phase'], 'planned')
        self.assertTrue(self.entry.exists())
        self.assertEqual(self.calls, [])
        done = self.manage(apply=True)
        self.assertEqual(done['phase'], 'complete')
        self.assertEqual(self.calls[0][0], ['/trusted/go', 'clean', '-cache'])
        self.assertEqual(self.calls[0][1]['env']['GOCACHE'], str(self.cache))
        self.assertEqual((self.fuzz / 'failed-input').read_bytes(), before)
        self.assertEqual(self.source.read_text(), 'package main\n')
        self.assertEqual((self.cache / 'retained-evidence/failure.log').read_text(), 'original failed build')
        self.assertEqual(done['before']['retainedFingerprint'], done['after']['retainedFingerprint'])
        self.assertEqual(json.loads(Path(self.config['receipt']).read_text())['phase'], 'complete')

    def test_under_budget_does_not_clear_after_each_ticket_and_repeat_is_idempotent(self):
        self.config['maxBytes'] = 10**9
        self.assertEqual(self.manage(apply=True)['phase'], 'within-budget')
        self.config['maxBytes'] = 1
        self.assertEqual(self.manage(apply=True)['phase'], 'complete')
        self.assertEqual(self.manage(apply=True)['phase'], 'within-budget')
        self.assertEqual(len(self.calls), 1)

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
            result = m.manage_cache(self.config, lambda: proof, apply=True,
                                   process_inventory=lambda: [], run_command=self.run_clean)
            self.assertEqual(result['phase'], 'refused')
        for census in [None, [{'pid': 999, 'executable': '/usr/bin/go', 'state': 'S'}]]:
            result = m.manage_cache(self.config, lambda: self.proof, apply=True,
                                   process_inventory=lambda: census, run_command=self.run_clean)
            self.assertEqual(result['phase'], 'refused')
        proofs = iter([self.proof, {**self.proof, 'lease': str(uuid.uuid4())}])
        result = m.manage_cache(self.config, lambda: next(proofs), apply=True,
                               process_inventory=lambda: [], run_command=self.run_clean)
        self.assertEqual(result['phase'], 'refused')
        self.assertTrue(self.entry.exists())
        self.assertEqual(self.calls, [])

    def test_symlink_and_unrecognized_candidate_content_refuse(self):
        self.entry.unlink()
        self.entry.symlink_to(self.source)
        self.assertEqual(self.manage(apply=True)['phase'], 'refused')
        self.assertEqual(self.source.read_text(), 'package main\n')
        self.entry.unlink()
        (self.bucket / 'failed-build.log').write_text('failure')
        self.assertEqual(self.manage(apply=True)['phase'], 'refused')
        self.assertEqual(self.calls, [])

    def test_a_writer_appearing_between_plan_and_apply_prevents_deletion(self):
        calls = []
        def guard():
            calls.append(True)
            if len(calls) == 2:
                self.entry.write_bytes(b'new compiled output after planning')
            return self.proof
        result = m.manage_cache(self.config, guard, apply=True, process_inventory=lambda: [],
                               run_command=self.run_clean)
        self.assertEqual(result['phase'], 'refused')
        self.assertEqual(self.entry.read_bytes(), b'new compiled output after planning')
        self.assertEqual(self.calls, [])

    def test_symlink_cache_root_and_legacy_log_are_preserved(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.cache, target_is_directory=True)
        self.config['cache'] = str(alias)
        self.assertEqual(self.manage(apply=True)['phase'], 'refused')
        self.config['cache'] = str(self.cache)
        (self.cache / 'log.txt').write_text('unclassified retained log')
        self.assertEqual(self.manage(apply=True)['phase'], 'refused')
        self.assertTrue(self.entry.exists())

    def test_runner_error_or_unconfirmed_drain_retains_uncertain_receipt(self):
        def broken(argv, **kwargs):
            raise TimeoutError('command may still have descendants')
        result = m.manage_cache(self.config, lambda: self.proof, apply=True,
                               process_inventory=lambda: [], run_command=broken)
        self.assertEqual(result['phase'], 'uncertain')
        self.assertFalse(result['releaseSafe'])
        self.assertEqual(json.loads(Path(self.config['receipt']).read_text())['phase'], 'uncertain')
        self.assertEqual(self.manage(apply=True)['phase'], 'uncertain')
        self.assertEqual(self.calls, [])

    def test_unconfirmed_runner_and_missing_runner_never_claim_safe_release(self):
        result = m.manage_cache(self.config, lambda: self.proof, apply=True, process_inventory=lambda: [])
        self.assertEqual(result['phase'], 'refused')
        self.assertTrue(self.entry.exists())
        result = m.manage_cache(self.config, lambda: self.proof, apply=True, process_inventory=lambda: [],
                               run_command=lambda *args, **kwargs: {'returncode': 0, 'custody': 'uncertain'})
        self.assertEqual(result['phase'], 'uncertain')
        self.assertFalse(result['releaseSafe'])

    def test_real_go_clean_preserves_fuzz_failed_evidence_and_source(self):
        executable = shutil.which('go')
        if not executable:
            self.skipTest('Go is unavailable')
        self.config['go'] = executable
        seen = []
        def run(argv, **options):
            seen.append(options)
            self.assertNotIn('FLEET_OPERATOR_TOKEN', options['env'])
            self.assertNotIn('GH_TOKEN', options['env'])
            result = subprocess.run(argv, cwd=options['cwd'], env=options['env'], timeout=options['timeout'],
                                    capture_output=True, check=False)
            return {'returncode': result.returncode, 'custody': 'drained'}
        before = (self.fuzz / 'failed-input').read_bytes()
        with patch.dict(os.environ, {'FLEET_OPERATOR_TOKEN': 'test-only', 'GH_TOKEN': 'test-only'}):
            done = m.manage_cache(self.config, lambda: self.proof, apply=True,
                                  process_inventory=lambda: [], run_command=run)
        self.assertEqual(done['phase'], 'complete', done)
        self.assertEqual(done['after']['compiledBytes'], 0)
        self.assertEqual((self.fuzz / 'failed-input').read_bytes(), before)
        self.assertEqual(self.source.read_text(), 'package main\n')
        self.assertEqual((self.cache / 'retained-evidence/failure.log').read_text(), 'original failed build')
        self.assertEqual(len(seen), 1)

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
            result = m.manage_cache(self.config, lambda: self.proof, apply=True, run_command=self.run_clean)
            self.assertEqual(result['phase'], 'refused')
            self.assertTrue(program.exists())
            self.assertEqual(self.calls, [])
        finally:
            child.terminate()
            child.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
