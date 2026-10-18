import importlib.util
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fleet_storage', Path(__file__).with_name('fleet-storage.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fleet-storage-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repository = self.root / 'repository'
        self.repository.mkdir()
        self.run_git(self.repository, 'init', '-b', 'main')
        self.run_git(self.repository, 'config', 'user.email', 'storage@example.invalid')
        self.run_git(self.repository, 'config', 'user.name', 'Storage fixture')
        (self.repository / 'app').mkdir()
        (self.repository / 'app/build.gradle.kts').write_text('// tracked build configuration\n')
        (self.repository / 'source.txt').write_text('source remains intact\n')
        (self.repository / '.gitignore').write_text('/.codegraph/*.db\n/.codegraph/*.db-wal\n/.codegraph/*.db-shm\n/.codegraph/daemon.log\n/.codegraph/config.json\n/app/build/\n/evidence/\n')
        self.run_git(self.repository, 'add', '.')
        self.run_git(self.repository, 'commit', '-m', 'source fixture')
        self.worktree = self.root / 'builder-123'
        self.run_git(self.repository, 'worktree', 'add', '-b', 'feature/123', str(self.worktree))
        self.requests = []
        self.allowed = True
        self.exclusive = True
        self.processes = []
        def authority(request):
            self.requests.append(request)
            return {'allowed': self.allowed, 'exclusive': self.exclusive, 'lease': 'durable-lease', 'reason': 'Worker or unresolved feature holds cleanup'}
        self.authority = authority
        self.cleaner = module.FleetStorage(authority, lambda path: self.processes)

    def run_git(self, directory, *arguments):
        return subprocess.check_output(['git', '-C', str(directory), *arguments], stderr=subprocess.DEVNULL).decode().strip()

    def put(self, relative, content=b'generated compiler bytes'):
        path = self.worktree / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def clean(self, **options):
        return self.cleaner.cleanup(str(self.repository), str(self.worktree), 'org/app#123', **options)

    def refs(self):
        return self.run_git(self.repository, 'for-each-ref', '--format=%(refname) %(objectname)')

    def test_dry_run_never_needs_exclusive_lease_or_changes_contents(self):
        target = self.put('.codegraph/codegraph.db')
        self.exclusive = False
        before = self.refs()
        result = self.clean()
        self.assertEqual(result['state'], 'planned')
        self.assertIn('.codegraph/codegraph.db', result['planned'])
        self.assertEqual(result['reclaimedBytes'], 0)
        self.assertEqual(result['plannedBytes'], len(b'generated compiler bytes'))
        self.assertTrue(target.exists())
        self.assertEqual(self.refs(), before)

    def test_reclaims_only_ignored_compiler_products_and_keeps_all_local_evidence(self):
        graph = self.put('.codegraph/codegraph.db', b'graph bytes')
        compiled = self.put('app/build/tmp/kotlin-classes/debug/App.class', b'compiled bytes')
        evidence = [
            self.put('.codegraph/daemon.log', b'failed indexing diagnostic'),
            self.put('.codegraph/config.json', b'unique graph configuration'),
            self.put('app/build/reports/tests/testDebugUnitTest/failure.html', b'full failed test report'),
            self.put('app/build/intermediates/lint_partial_results/debug/lint-definite.xml', b'lint failure'),
            self.put('app/build/outputs/capture.png', b'unique failure capture'),
            self.put('evidence/full-session.jsonl', b'complete original failed session'),
        ]
        before = self.refs()
        result = self.clean(apply=True)
        self.assertEqual(result['state'], 'reclaimed')
        self.assertEqual(result['reclaimedBytes'], len(b'graph bytescompiled bytes'))
        self.assertFalse(graph.exists())
        self.assertFalse(compiled.exists())
        self.assertTrue(result['copyRetained'])
        self.assertTrue(all(path.exists() for path in evidence))
        self.assertEqual(evidence[-1].read_bytes(), b'complete original failed session')
        self.assertEqual(self.refs(), before)
        self.assertIn('unique local evidence', result['retainedReason'])
        repeated = self.clean(apply=True)
        self.assertEqual(repeated['reclaimedBytes'], 0)
        self.assertTrue(all(path.exists() for path in evidence))

    def test_even_a_clean_evidence_free_copy_keeps_every_branch_commit_and_source(self):
        (self.worktree / 'source.txt').write_text('local completed source\n')
        self.run_git(self.worktree, 'add', 'source.txt')
        self.run_git(self.worktree, 'commit', '-m', 'completed local commit')
        before = self.refs()
        head = self.run_git(self.worktree, 'rev-parse', 'HEAD')
        result = self.clean(apply=True)
        self.assertEqual(result['state'], 'unchanged')
        self.assertTrue(self.worktree.exists())
        self.assertTrue(result['copyRetained'])
        self.assertEqual(self.refs(), before)
        self.assertEqual(self.run_git(self.repository, 'cat-file', '-t', head), 'commit')
        self.assertEqual(self.run_git(self.repository, 'rev-parse', 'refs/heads/feature/123'), head)

    def test_dirty_source_holds_all_cleanup_without_discarding_edits(self):
        cache = self.put('.codegraph/codegraph.db')
        (self.worktree / 'source.txt').write_text('unfinished local fix')
        result = self.clean(apply=True)
        self.assertEqual(result['state'], 'held')
        self.assertTrue(cache.exists())
        self.assertEqual((self.worktree / 'source.txt').read_text(), 'unfinished local fix')

    def test_active_worker_unresolved_family_or_changed_authority_refuses_cleanup(self):
        cache = self.put('.codegraph/codegraph.db')
        self.allowed = False
        result = self.clean(apply=True)
        self.assertEqual(result['state'], 'held')
        self.assertTrue(cache.exists())
        self.assertIn('unresolved feature', result['held'][0]['reason'])

    def test_apply_requires_a_real_exclusive_lease(self):
        cache = self.put('.codegraph/codegraph.db')
        self.exclusive = False
        result = self.clean(apply=True)
        self.assertTrue(cache.exists())
        self.assertTrue(any('exclusive' in entry['reason'] for entry in result['held']))

    def test_a_real_process_in_the_working_copy_holds_cleanup(self):
        cache = self.put('.codegraph/codegraph.db')
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], cwd=self.worktree)
        self.addCleanup(lambda: child.wait() if child.poll() is not None else (child.terminate(), child.wait()))
        self.processes = [child.pid]
        result = self.clean(apply=True)
        self.assertTrue(cache.exists())
        self.assertTrue(any('Local processes' in entry['reason'] for entry in result['held']))

    def test_an_unavailable_process_census_or_authority_fails_closed(self):
        for callback in ('authority', 'processes_using_path'):
            with self.subTest(callback=callback):
                cache = self.put('.codegraph/codegraph.db')
                def unavailable(*args):
                    raise RuntimeError('snapshot failed')
                cleaner = module.FleetStorage(unavailable if callback == 'authority' else self.authority,
                                             unavailable if callback == 'processes_using_path' else lambda path: [])
                result = cleaner.cleanup(self.repository, self.worktree, 'org/app#123', apply=True)
                self.assertEqual(result['state'], 'held')
                self.assertTrue(cache.exists())

    def test_unknown_content_within_compiler_tree_holds_the_entire_target(self):
        compiled = self.put('app/build/tmp/kotlin-classes/debug/App.class')
        failure = self.put('app/build/tmp/kotlin-classes/debug/compiler-crash.json', b'unique compiler failure')
        result = self.clean(apply=True)
        self.assertTrue(compiled.exists())
        self.assertTrue(failure.exists())
        self.assertTrue(any('possible failure evidence' in entry['reason'] for entry in result['held']))

    def test_symbolic_links_never_follow_a_target_outside_the_copy(self):
        outside = self.root / 'original-evidence'
        outside.mkdir()
        (outside / 'failure.class').write_bytes(b'irreplaceable external evidence')
        (self.worktree / '.codegraph').symlink_to(outside, target_is_directory=True)
        result = self.clean(apply=True)
        self.assertTrue((outside / 'failure.class').exists())
        self.assertTrue((self.worktree / '.codegraph').is_symlink())
        self.assertEqual(result['reclaimedBytes'], 0)

    def test_symlink_swap_and_new_evidence_between_scan_and_delete_are_retained(self):
        for change in ('symlink', 'new-evidence'):
            with self.subTest(change=change):
                target = self.put('app/build/tmp/kotlin-classes/debug/App.class')
                folder = target.parents[1]
                outside = self.root / ('retained-' + change)
                changed = False
                def authority(request):
                    nonlocal changed
                    if request['operation'] == 'reclaim' and not changed:
                        changed = True
                        if change == 'symlink':
                            folder.rename(outside)
                            folder.symlink_to(outside, target_is_directory=True)
                        else:
                            self.put('app/build/tmp/kotlin-classes/new-failure.log', b'new unique evidence')
                    return {'allowed': True, 'exclusive': True, 'lease': 'durable-lease'}
                result = module.FleetStorage(authority, lambda path: []).cleanup(self.repository, self.worktree, 'org/app#123', apply=True)
                self.assertEqual(result['reclaimedBytes'], 0)
                self.assertTrue(any(entry['path'] == 'app/build/tmp/kotlin-classes' for entry in result['held']))
                if change == 'symlink':
                    self.assertTrue((outside / 'debug/App.class').exists())
                    folder.unlink()
                    outside.rename(folder)
                else:
                    self.assertTrue((folder / 'new-failure.log').exists())

    def test_hardlinked_compiler_product_does_not_destroy_other_evidence_link(self):
        external = self.root / 'preserved-evidence.class'
        external.write_bytes(b'preserved through external hard link')
        target = self.worktree / 'app/build/tmp/kotlin-classes/debug/App.class'
        target.parent.mkdir(parents=True)
        os.link(external, target)
        result = self.clean(apply=True)
        self.assertEqual(result['state'], 'reclaimed')
        self.assertFalse(target.exists())
        self.assertEqual(external.read_bytes(), b'preserved through external hard link')

    def test_primary_copy_wrong_ticket_and_locked_copy_are_never_cleaned(self):
        cache = self.put('.codegraph/codegraph.db')
        primary = self.cleaner.cleanup(self.repository, self.repository, 'org/app#123', apply=True)
        self.assertEqual(primary['state'], 'held')
        wrong = self.cleaner.cleanup(self.repository, self.worktree, 'org/app#999', apply=True)
        self.assertEqual(wrong['state'], 'held')
        self.run_git(self.repository, 'worktree', 'lock', str(self.worktree))
        locked = self.clean(apply=True)
        self.assertEqual(locked['state'], 'held')
        self.assertTrue(cache.exists())

    def test_authority_rechecked_immediately_before_reclaim_and_copy_removal(self):
        cache = self.put('.codegraph/codegraph.db')
        def authority(request):
            return {'allowed': request['operation'] == 'inspect', 'exclusive': True, 'lease': 'durable-lease', 'reason': 'New worker has started'}
        result = module.FleetStorage(authority, lambda path: []).cleanup(self.repository, self.worktree, 'org/app#123', apply=True)
        self.assertTrue(cache.exists())
        self.assertTrue(any('New worker' in entry['reason'] for entry in result['held']))

    def test_whole_copy_removal_is_never_requested_even_without_ignored_content(self):
        original_git = module.git
        def guarded_git(repository, *args, **kwargs):
            if args[:2] == ('worktree', 'remove'):
                self.fail('Whole-copy removal cannot preserve late ignored captures')
            return original_git(repository, *args, **kwargs)
        with patch.object(module, 'git', side_effect=guarded_git):
            result = self.clean(apply=True)
        self.assertTrue(result['copyRetained'])
        self.assertTrue(self.worktree.exists())

    def test_partial_unlink_failure_is_retry_safe_and_reports_reclaimed_bytes(self):
        first = self.put('app/build/tmp/kotlin-classes/debug/A.class', b'first')
        second = self.put('app/build/tmp/kotlin-classes/debug/B.class', b'second')
        real_unlink = os.unlink
        def fail_second(path, *args, **kwargs):
            if path == 'B.class':
                raise PermissionError('fixture filesystem failure')
            return real_unlink(path, *args, **kwargs)
        with patch.object(module.os, 'unlink', side_effect=fail_second):
            result = self.clean(apply=True)
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        self.assertEqual(result['reclaimedBytes'], 5)
        self.assertEqual(result['state'], 'reclaimed')
        self.assertEqual(result['filesRemoved'], 1)
        self.assertEqual(result['partial'], [{'path':'app/build/tmp/kotlin-classes', 'bytes':5, 'filesRemoved':1}])
        retry = self.clean(apply=True)
        self.assertFalse(second.exists())
        self.assertEqual(retry['reclaimedBytes'], 6)

    def test_tracked_compiler_outputs_are_never_deleted(self):
        self.run_git(self.worktree, 'rm', '.gitignore')
        target = self.put('app/build/tmp/kotlin-classes/debug/App.class', b'tracked output must remain')
        self.run_git(self.worktree, 'add', '.')
        self.run_git(self.worktree, 'commit', '-m', 'tracked generated fixture')
        (self.worktree / '.gitignore').write_text('/app/build/\n')
        self.run_git(self.worktree, 'add', '.gitignore')
        self.run_git(self.worktree, 'commit', '-m', 'ignore future products')
        result = self.clean(apply=True)
        self.assertTrue(target.exists())
        self.assertTrue(any('tracked files' in entry['reason'] for entry in result['held']))

    def test_two_local_cleanup_instances_cannot_delete_from_the_same_copy_concurrently(self):
        self.put('.codegraph/codegraph.db')
        entered = threading.Event()
        release = threading.Event()
        def first_authority(request):
            if request['operation'] == 'inspect':
                entered.set()
                release.wait(5)
            return {'allowed': True, 'exclusive': True, 'lease': 'durable-lease'}
        result = []
        worker = threading.Thread(target=lambda: result.append(module.FleetStorage(first_authority, lambda path: []).cleanup(self.repository, self.worktree, 'org/app#123', apply=True)))
        worker.start()
        self.assertTrue(entered.wait(5))
        try:
            second = self.clean(apply=True)
            self.assertEqual(second['state'], 'held')
            self.assertIn('Another local storage cleanup', second['held'][0]['reason'])
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result[0]['state'], 'reclaimed')

    def test_callback_failure_after_a_completed_target_keeps_partial_report_and_next_target(self):
        first = self.put('.codegraph/codegraph.db', b'first graph')
        second = self.put('app/build/tmp/kotlin-classes/debug/App.class', b'next compiler output')
        def authority(request):
            if request['operation'] == 'reclaim' and not first.exists():
                raise TimeoutError('fresh authority became unavailable')
            return {'allowed': True, 'exclusive': True, 'lease': 'durable-lease'}
        result = module.FleetStorage(authority, lambda path: []).cleanup(self.repository, self.worktree, 'org/app#123', apply=True)
        self.assertEqual(result['state'], 'reclaimed')
        self.assertEqual(result['reclaimedBytes'], len(b'first graph'))
        self.assertEqual(result['filesRemoved'], 1)
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        self.assertTrue(any('authority check is unavailable' in item['reason'] for item in result['held']))

    def test_a_changed_lease_refuses_later_deletion_without_releasing_either_claim(self):
        target = self.put('.codegraph/codegraph.db')
        def authority(request):
            return {'allowed': True, 'exclusive': True, 'lease': 'replacement-lease' if request['operation'] == 'reclaim' else 'original-lease'}
        result = module.FleetStorage(authority, lambda path: []).cleanup(self.repository, self.worktree, 'org/app#123', apply=True)
        self.assertTrue(target.exists())
        self.assertTrue(any('lease changed' in item['reason'] for item in result['held']))


if __name__ == '__main__':
    unittest.main()
