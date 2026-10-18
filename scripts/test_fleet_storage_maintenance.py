import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage_maintenance', Path(__file__).with_name('fleet-storage-maintenance.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Adapter:
    def status(self):
        return {'machine': 'test-host', 'runs': []}


class Supervisor(m.StorageSupervisor):
    def __init__(self, config, path):
        super().__init__(Adapter(), config, path)
        self.calls, self.leases, self.workflow = [], {}, []

    def rpc(self, action, value=None, *, workflow=False):
        self.calls.append((action, value, workflow))
        if workflow:
            return {'enabled': True, 'items': self.workflow}
        if action == 'list':
            return list(self.leases.values())
        if action == 'acquire':
            lease = {**value, 'basis': 'unchanged', 'created': 1, 'finished': None}
            self.leases[value['id']] = lease
            return lease
        if action == 'verify':
            return self.leases[value['id']]
        if action == 'finish':
            lease = self.leases.pop(value['id'])
            return {**lease, 'finished': 2}
        if action == 'cancel':
            request = value['request']
            lease = self.leases.pop(request['id'], request)
            return {**lease, 'finished': 2}
        raise AssertionError(action)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='storage-driver-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.state = self.root / 'state'
        self.state.mkdir()
        self.config = {'stateDirectory': str(self.state), 'projects': {}, 'storageMaintenance': {}}
        self.config_path = self.root / 'config.json'
        m.atomic(self.config_path, self.config)
        self.supervisor = Supervisor(self.config, self.config_path)

    def git(self, directory, *args):
        return subprocess.check_output(['git', '-C', str(directory), *args], stderr=subprocess.DEVNULL).decode().strip()

    def repository(self):
        repo = self.root / 'repository'
        repo.mkdir()
        self.git(repo, 'init', '-b', 'main')
        self.git(repo, 'config', 'user.name', 'Storage test')
        self.git(repo, 'config', 'user.email', 'storage@example.invalid')
        (repo / '.gitignore').write_text('/.codegraph/*.db\n/evidence/\n')
        (repo / 'source.txt').write_text('source must remain')
        self.git(repo, 'add', '.')
        self.git(repo, 'commit', '-m', 'source')
        copy = self.root / '.pyrycode-worktrees/repository/builder-123'
        self.git(repo, 'worktree', 'add', '-b', 'feature/123', str(copy))
        graph = copy / '.codegraph/codegraph.db'
        graph.parent.mkdir()
        graph.write_bytes(b'reproducible generated graph')
        evidence = copy / 'evidence/failure.log'
        evidence.parent.mkdir()
        evidence.write_bytes(b'unique failure evidence')
        self.config['projects'] = {'org/app': {'target': str(repo)}}
        self.supervisor.workflow = [{'issueNumber': 123, 'state': 'CLOSED', 'status': 'Done'}]
        return repo, copy, graph, evidence

    def test_real_git_and_lsof_reclaim_generated_graph_and_preserve_source_evidence_refs(self):
        if not shutil.which('lsof') or m.load('fleet-support').process_snapshot() is None:
            self.skipTest('Complete native process inspection unavailable')
        repo, copy, graph, evidence = self.repository()
        if m.processes_using_path(str(copy)) is None:
            self.skipTest('lsof reports incomplete filesystem or process visibility')
        before = self.git(repo, 'show-ref')
        reports = self.supervisor.run(apply=True, cache=False)
        self.assertEqual(reports[0]['state'], 'reclaimed', reports)
        self.assertFalse(graph.exists())
        self.assertEqual(evidence.read_bytes(), b'unique failure evidence')
        self.assertEqual((copy / 'source.txt').read_text(), 'source must remain')
        self.assertEqual(self.git(repo, 'show-ref'), before)
        self.assertFalse(self.supervisor.leases)
        finish = [value for action, value, workflow in self.supervisor.calls if action == 'finish']
        self.assertEqual(finish[0]['result'], 'complete')
        count = len(list(self.supervisor.directory.glob('*.lease.json')))
        self.supervisor.run(apply=True, cache=False)
        self.assertEqual(len(list(self.supervisor.directory.glob('*.lease.json'))), count)

    def test_real_process_cwd_refuses_cleanup_before_acquiring_lease(self):
        if not shutil.which('lsof') or m.load('fleet-support').process_snapshot() is None:
            self.skipTest('Complete native process inspection unavailable')
        repo, copy, graph, evidence = self.repository()
        child = subprocess.Popen(['/bin/sleep', '30'], cwd=copy)
        try:
            reports = self.supervisor.run(apply=True, cache=False)
            self.assertEqual(reports[0]['state'], 'held', reports)
            self.assertTrue(graph.exists())
            self.assertFalse(any(call[0] == 'acquire' for call in self.supervisor.calls))
        finally:
            child.terminate()
            child.wait(timeout=5)

    def test_audit_has_no_central_mutations_or_deletions(self):
        repo, copy, graph, evidence = self.repository()
        with patch.object(m, 'processes_using_path', return_value=[]):
            reports = self.supervisor.run(apply=False, cache=False)
        self.assertEqual(reports[0]['state'], 'planned')
        self.assertTrue(graph.exists())
        self.assertFalse(any(call[0] in ('acquire', 'verify', 'finish') for call in self.supervisor.calls))
        self.assertFalse(list(self.supervisor.directory.glob('*.lease.json')))

    def test_a_held_compiler_target_does_not_block_independently_safe_graph_cleanup(self):
        repo, copy, graph, evidence = self.repository()
        (copy / 'app').mkdir()
        (copy / 'app/build.gradle.kts').write_text('// tracked build configuration\n')
        (copy / '.gitignore').write_text('/.codegraph/*.db\n/evidence/\n/app/build/\n')
        self.git(copy, 'add', 'app/build.gradle.kts', '.gitignore')
        self.git(copy, 'commit', '-m', 'android fixture')
        unknown = copy / 'app/build/tmp/kotlin-classes/debug/failed-evidence.txt'
        unknown.parent.mkdir(parents=True)
        unknown.write_bytes(b'preserve unknown evidence')
        with patch.object(m, 'processes_using_path', return_value=[]):
            result = self.supervisor.run(apply=True, cache=False)
        self.assertEqual(result[0]['state'], 'reclaimed', result)
        self.assertTrue(result[0]['held'])
        self.assertFalse(graph.exists())
        self.assertEqual(unknown.read_bytes(), b'preserve unknown evidence')
        self.assertTrue(evidence.exists())

    def test_registered_manual_and_wrong_branch_copies_are_excluded(self):
        repo, copy, graph, evidence = self.repository()
        self.git(repo, 'worktree', 'add', '-b', 'feature/456', str(self.root / 'manual-456'))
        self.git(repo, 'worktree', 'add', '-b', 'manual/789', str(copy.parent / 'builder-789'))
        self.supervisor.workflow += [{'issueNumber': number, 'state': 'CLOSED', 'status': 'Done'} for number in (456, 789)]
        self.assertEqual([item['ticket'] for item in self.supervisor.candidates()], ['org/app#123'])

    def test_exact_lease_scope_and_current_head_are_required(self):
        repo, copy, graph, evidence = self.repository()
        original = self.supervisor.verify
        def change_scope(saved):
            saved['request']['head'] = '0' * 40
            return original(saved)
        with patch.object(m, 'processes_using_path', return_value=[]), patch.object(self.supervisor, 'verify', side_effect=change_scope):
            reports = self.supervisor.run(apply=True, cache=False)
        self.assertEqual(reports[0]['state'], 'held')
        self.assertTrue(graph.exists())

    def test_lost_acquire_reply_is_durable_and_reconciled_by_exact_uuid(self):
        request = {'id': str(uuid.uuid4()), 'machine': 'test-host', 'kind': 'cache', 'path': str(self.root / 'cache')}
        rpc = self.supervisor.rpc
        def lost(action, value=None, **options):
            result = rpc(action, value, **options)
            if action == 'acquire':
                raise RuntimeError('reply lost')
            return result
        with patch.object(self.supervisor, 'rpc', side_effect=lost):
            with self.assertRaises(RuntimeError):
                self.supervisor.acquire(request)
        self.assertIn(request['id'], self.supervisor.leases)
        with m.locked(self.supervisor.directory / 'maintenance.lock'):
            self.supervisor.reconcile()
        self.assertFalse(self.supervisor.leases)
        self.assertEqual(m.read(self.supervisor.directory / (request['id'] + '.lease.json'))['phase'], 'finished')

    def test_round_robin_reaches_later_candidates_after_first_eight_are_held(self):
        items = [{'repository': '/repo', 'path': '/copies/builder-' + str(number).zfill(2), 'head': 'a' * 40,
                  'ticket': 'org/app#' + str(number)} for number in range(1, 21)]
        class Held:
            def __init__(self, *args):
                pass
            def cleanup(self, repo, path, ticket, **options):
                return {'path': path, 'ticket': ticket, 'plannedBytes': 0, 'state': 'held', 'held': ['retained']}
        core = type('Core', (), {'FleetStorage': Held})
        with patch.object(self.supervisor, 'candidates', return_value=items), patch.object(m, 'load', return_value=core):
            first = self.supervisor.copy_pass('test-host', True)
            second = self.supervisor.copy_pass('test-host', True)
            third = self.supervisor.copy_pass('test-host', True)
        self.assertEqual(first[0]['ticket'], 'org/app#1')
        self.assertEqual(second[0]['ticket'], 'org/app#9')
        self.assertEqual(third[0]['ticket'], 'org/app#17')

    def test_unknown_native_custody_holds_cache_without_central_acquire(self):
        tasks = self.state / 'tasks'
        tasks.mkdir()
        m.atomic(tasks / 'old.receipt.json', {'phase': 'complete'})
        admission = self.root / 'admission.lock'
        admission.touch()
        self.config['storageMaintenance'].update(goCache={'cache': str(self.root / 'cache'), 'go': '/trusted/go'}, testAdmissionLock=str(admission))
        result = self.supervisor.cache_pass('test-host', True)
        self.assertEqual(result['phase'], 'held')
        self.assertFalse(self.supervisor.calls)

    def test_existing_admission_lock_is_required_and_contended_lock_refuses(self):
        admission = self.root / 'admission.lock'
        self.config['storageMaintenance'].update(goCache={'cache': str(self.root / 'cache'), 'go': '/trusted/go'}, testAdmissionLock=str(admission))
        with self.assertRaises(FileNotFoundError):
            self.supervisor.cache_pass('test-host', True)
        admission.touch()
        with m.locked(admission):
            with self.assertRaises(BlockingIOError):
                self.supervisor.cache_pass('test-host', True)
        self.assertFalse(self.supervisor.calls)

    def test_tick_has_no_rpc_or_git_and_releases_probe_lock_before_launch(self):
        def start(mode, request, journal):
            with m.locked(self.supervisor.directory / 'maintenance.lock'):
                pass
            return type('Child', (), {'pid': 123, 'poll': lambda child: 0})()
        with patch.object(self.supervisor.adapter, 'status', side_effect=AssertionError('network in tick')), patch.object(m, 'launch', side_effect=start) as launch:
            result = self.supervisor.tick()
            self.assertEqual(result[0]['phase'], 'scheduled')
            self.assertEqual(self.supervisor.tick(), [])
            self.assertEqual(launch.call_count, 1)

    def test_launch_barrier_eof_exits_before_loading_configuration(self):
        request, journal = self.root / 'worker.json', self.root / 'worker.custody.json'
        m.atomic(request, {'config': '/missing/config', 'apply': True, 'copies': True, 'cache': True})
        result = subprocess.run([sys.executable, m.__file__, '--worker', str(request), str(journal)], input=b'', capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(journal.exists())
        self.assertEqual(m.read(journal)['phase'], 'waiting')

    def test_real_background_worker_acquires_lock_and_publishes_result(self):
        if m.load('fleet-support').process_snapshot() is None:
            self.skipTest('Complete native process inspection unavailable')
        operator = self.root / 'operator'
        operator.write_text('#!' + sys.executable + '\nimport json\nprint(json.dumps({"machine":"test-host","runs":[]}))\n')
        operator.chmod(0o700)
        self.config['operator'] = str(operator)
        m.atomic(self.config_path, self.config)
        result = self.supervisor.tick()
        self.assertEqual(result[0]['phase'], 'scheduled')
        deadline = time.monotonic() + 15
        while not (self.supervisor.directory / 'latest.json').exists() and time.monotonic() < deadline:
            time.sleep(.05)
        latest = m.read(self.supervisor.directory / 'latest.json')
        self.assertIsNotNone(latest, 'Worker must acquire the released maintenance lock')
        self.assertTrue(latest['apply'])
        self.assertEqual(latest['reports'][0]['phase'], 'disabled')
        journal = next(self.supervisor.directory.glob('*.worker-custody.json'))
        self.assertIsNotNone(m.read(journal)['custody']['root'])
        # Reap our test-launched worker without signalling any unrelated process.
        self.supervisor.children[0].wait(timeout=5)

    def test_tick_reports_bounded_results_without_scanning_or_rpc(self):
        m.atomic(self.supervisor.directory / 'latest.json', {'reports': [
            {'kind': 'closed-copy-storage', 'state': 'reclaimed', 'ticket': 'org/app#' + str(n),
             'reclaimedBytes': n, 'path': '/private/source', 'arbitrary': 'not exported'} for n in range(30)]})
        m.atomic(self.supervisor.schedule, {'copies': time.time(), 'cache': time.time()})
        result = self.supervisor.tick()
        self.assertEqual(len(result), 20)
        self.assertEqual(result[3]['reclaimedBytes'], 3)
        self.assertNotIn('path', result[0])
        self.assertNotIn('arbitrary', result[0])

    def test_repeated_authority_verify_reuses_saved_request_file(self):
        supervisor = m.StorageSupervisor(Adapter(), self.config, self.config_path)
        request = {'id': str(uuid.uuid4()), 'machine': 'test-host'}
        supervisor.adapter.operator_command = lambda *args: [sys.executable, '-c', 'print("{}")']
        for _ in range(5):
            supervisor.rpc('verify', request)
        self.assertEqual(len(list(supervisor.directory.glob('operator-*.json'))), 1)

    def test_linux_container_registrations_report_held_without_path_rewrites(self):
        self.config['projects'] = {'org/app': {'target': '/host/project', 'containerTarget': '/work/project'}}
        self.supervisor.workflow = [{'issueNumber': 123, 'state': 'CLOSED', 'status': 'Done'}]
        core = type('Core', (), {'registered_worktrees': lambda target: [
            {'worktree': '/work/.pyrycode-worktrees/project/builder-123', 'HEAD': 'a' * 40, 'branch': 'refs/heads/feature/123'}]})
        with patch.object(m, 'load', return_value=core):
            result = self.supervisor.copy_pass('test-host', True)
        self.assertEqual(result[0]['phase'], 'held')
        self.assertIn('container-local', result[0]['reason'])
        self.assertFalse(any(call[0] == 'acquire' for call in self.supervisor.calls))

    def test_lsof_warning_never_becomes_positive_absence(self):
        result = subprocess.CompletedProcess([], 1, stdout=b'', stderr=b'Output information may be incomplete')
        with patch.object(m.subprocess, 'run', return_value=result):
            self.assertIsNone(m.processes_using_path(str(self.root)))

    def test_complete_lsof_census_excludes_only_current_cleaner(self):
        result = subprocess.CompletedProcess([], 0, stdout=('p' + str(os.getpid()) + '\0\nf4\0\np98765\0\nf8\0\n').encode(), stderr=b'')
        support = type('Support', (), {'process_snapshot': lambda: {os.getpid(): {}}})
        with patch.object(m, 'load', return_value=support), patch.object(m.subprocess, 'run', return_value=result):
            self.assertEqual(m.processes_using_path(str(self.root)), [98765])

    def test_missing_acquire_is_settled_before_a_late_control_request_can_arrive(self):
        request = {'id': str(uuid.uuid4()), 'machine': 'test-host', 'kind': 'cache', 'path': str(self.root / 'cache')}
        path = self.supervisor.directory / (request['id'] + '.lease.json')
        m.atomic(path, {'request': request, 'phase': 'acquiring'})
        with m.locked(self.supervisor.directory / 'maintenance.lock'):
            self.supervisor.reconcile()
        actions = [action for action, value, workflow in self.supervisor.calls]
        self.assertEqual(actions, ['cancel'])
        self.assertEqual(m.read(path)['phase'], 'finished')

    def test_old_external_command_journal_is_not_cancelled_by_synchronous_recovery(self):
        request = {'id': str(uuid.uuid4()), 'machine': 'test-host', 'kind': 'cache', 'path': str(self.root / 'cache')}
        path = self.supervisor.directory / (request['id'] + '.lease.json')
        m.atomic(path, {'request': request, 'phase': 'command-pending', 'command': '/retained/unknown-command.json'})
        with m.locked(self.supervisor.directory / 'maintenance.lock'):
            with self.assertRaises(RuntimeError):
                self.supervisor.reconcile()
        self.assertFalse(self.supervisor.calls)
        self.assertEqual(m.read(path)['phase'], 'command-pending')

    def test_lost_finish_reply_reconciles_without_reacquiring_finished_scope(self):
        request = {'id': str(uuid.uuid4()), 'machine': 'test-host', 'kind': 'cache', 'path': str(self.root / 'cache')}
        path, saved = self.supervisor.acquire(request)
        rpc = self.supervisor.rpc
        def lose_finish(action, value=None, **options):
            result = rpc(action, value, **options)
            if action == 'finish':
                raise RuntimeError('finish reply lost')
            return result
        with patch.object(self.supervisor, 'rpc', side_effect=lose_finish):
            with self.assertRaises(RuntimeError):
                self.supervisor.finish(path, saved, 'held')
        self.assertFalse(self.supervisor.leases)
        with m.locked(self.supervisor.directory / 'maintenance.lock'):
            self.supervisor.reconcile()
        self.assertEqual(m.read(path)['phase'], 'finished')
        self.assertEqual(self.supervisor.calls[-1][0], 'cancel')

    def test_definitively_refused_acquire_can_be_cancelled_without_new_authorisation(self):
        request = {'id': str(uuid.uuid4()), 'machine': 'test-host', 'kind': 'ticket',
                   'path': str(self.root / 'copy'), 'head': 'a' * 40, 'ticket': 'org/app#123'}
        rpc = self.supervisor.rpc
        def refuse(action, value=None, **options):
            if action == 'acquire':
                raise RuntimeError('closed parent is held')
            return rpc(action, value, **options)
        with patch.object(self.supervisor, 'rpc', side_effect=refuse):
            with self.assertRaises(RuntimeError):
                self.supervisor.acquire(request)
            with m.locked(self.supervisor.directory / 'maintenance.lock'):
                self.supervisor.reconcile()
        self.assertEqual(m.read(self.supervisor.directory / (request['id'] + '.lease.json'))['phase'], 'finished')

    def cache(self):
        cache = self.root / 'go-cache'
        cache.mkdir()
        (cache / 'README').write_text(m.load('fleet-build-cache').CACHE_README)
        data = b'reproducible compiled cache output'
        digest = hashlib.sha256(data).hexdigest()
        target = cache / digest[:2] / (digest + '-d')
        target.parent.mkdir()
        target.write_bytes(data)
        evidence = cache / 'fuzz/FuzzName/failed-case'
        evidence.parent.mkdir(parents=True)
        evidence.write_bytes(b'go test fuzz v1\nstring("failure")\n')
        admission = self.root / 'admission.lock'
        admission.touch()
        self.config['storageMaintenance'].update(goCache={'cache': str(cache), 'maxBytes': 1,
            'reserveBytes': 0, 'timeoutSeconds': 30}, testAdmissionLock=str(admission))
        return cache, target, evidence, admission

    def test_real_synchronous_cache_apply_holds_admission_and_preserves_fuzz_evidence(self):
        if m.load('fleet-support').process_snapshot() is None:
            self.skipTest('Complete native process census unavailable')
        cache, target, evidence, admission = self.cache()
        original = self.supervisor.verify
        def verify(saved):
            with self.assertRaises(BlockingIOError):
                with m.locked(admission):
                    pass
            return original(saved)
        with patch.object(self.supervisor, 'verify', side_effect=verify):
            report = self.supervisor.cache_pass('test-host', True)
        self.assertEqual(report['phase'], 'complete', report)
        self.assertFalse(target.exists())
        self.assertEqual(evidence.read_bytes(), b'go test fuzz v1\nstring("failure")\n')
        self.assertFalse(self.supervisor.leases)
        self.assertEqual([value['result'] for action, value, workflow in self.supervisor.calls if action == 'finish'], ['complete'])

    def test_cache_audit_needs_no_lease_or_native_completion_claim(self):
        cache, target, evidence, admission = self.cache()
        report = self.supervisor.cache_pass('test-host', False)
        self.assertEqual(report['phase'], 'audit')
        self.assertGreater(report['observed']['compiledBytes'], 0)
        self.assertTrue(target.exists())
        self.assertFalse(self.supervisor.calls)

    def test_replaced_admission_lock_refuses_before_cache_mutation(self):
        if m.load('fleet-support').process_snapshot() is None:
            self.skipTest('Complete native process census unavailable')
        cache, target, evidence, admission = self.cache()
        original = self.supervisor.verify
        def replace(saved):
            admission.rename(admission.with_suffix('.original'))
            admission.touch()
            return original(saved)
        with patch.object(self.supervisor, 'verify', side_effect=replace):
            report = self.supervisor.cache_pass('test-host', True)
        self.assertEqual(report['phase'], 'refused', report)
        self.assertTrue(target.exists())
        self.assertTrue(evidence.exists())
        self.assertFalse(self.supervisor.leases)


if __name__ == '__main__':
    unittest.main()
