#!/usr/bin/env python3
"""Periodic protected storage maintenance. Source copies and evidence stay.

The supervisor's tick only launches a worker. All Git, operator, process and
filesystem inspection runs outside the native watchdog loop. Sticky central
leases are released only after synchronous cleanup or proven command drainage.
"""
import argparse
import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def atomic(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + str(uuid.uuid4()) + '.new')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def read(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


def canonical(path):
    value = Path(path)
    if not value.is_absolute() or '..' in value.parts:
        raise ValueError('Storage paths must be canonical absolute paths')
    current = Path(value.anchor)
    for part in value.parts[1:]:
        current /= part
        if current.is_symlink():
            raise ValueError('Storage paths cannot contain symbolic links')
    return value


@contextlib.contextmanager
def locked(path, existing=False):
    path = canonical(path)
    flags = os.O_RDWR | os.O_NOFOLLOW
    descriptor = os.open(path, flags if existing else flags | os.O_CREAT, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RuntimeError('Storage lock is not a regular file')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if os.stat(path, follow_symlinks=False).st_ino != os.fstat(descriptor).st_ino:
            raise RuntimeError('Storage lock identity changed')
        yield descriptor
    finally:
        os.close(descriptor)


def processes_using_path(path):
    """lsof selects open descriptors and cwd by device/inode, without arguments."""
    support = load('fleet-support')
    if support.process_snapshot() is None:
        return None
    executable = shutil.which('lsof')
    if executable is None:
        return None
    result = subprocess.run([executable, '-nP', '-F0p', '+D', str(path)],
                            capture_output=True, timeout=60)
    if result.returncode not in (0, 1):
        return None
    if result.stderr.strip() and not load('fleet-path-custody').scoped_lsof_warning(result.stderr, path):
        return None
    try:
        fields = result.stdout.replace(b'\n', b'').split(b'\0')
        return sorted({int(field[1:]) for field in fields if field.startswith(b'p')} - {os.getpid()})
    except ValueError:
        return None


def native_drained(directory):
    """Legacy completion alone never proves that local native children exited."""
    support = load('fleet-support')
    for path in sorted(Path(directory).glob('*.receipt.json')):
        record = read(path)
        if record.get('drainConfirmed') is not True:
            return False
        # A positive final receipt is the existing native supervisor's durable
        # root plus descendant proof. Do not reinterpret older complete records.
    return True


def launch(mode, request, journal):
    """Child persists its own start identity before accepting the launch byte."""
    argv = [sys.executable, str(Path(__file__).resolve()), mode, str(request), str(journal)]
    child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        child.stdin.write(b'1')
        child.stdin.close()
    except BrokenPipeError:
        child.wait(timeout=5)
    return child


def barrier(journal):
    support = load('fleet-support')
    custody = support.new_custody(os.getpid())
    atomic(journal, {'custody': custody, 'phase': 'waiting'})
    if custody.get('root') is None or sys.stdin.buffer.read(1) != b'1':
        raise RuntimeError('Maintenance launch was not durably authorised')
    atomic(journal, {'custody': custody, 'phase': 'running'})


class StorageSupervisor:
    def __init__(self, adapter, config, config_path):
        self.adapter, self.config = adapter, config
        self.config_path = str(canonical(config_path))
        self.options = config.get('storageMaintenance', {})
        self.directory = canonical(Path(config['stateDirectory']) / 'storage')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.schedule = self.directory / 'schedule.json'
        self.children = []

    def rpc(self, action, value=None, *, workflow=False):
        if workflow:
            command = self.adapter.operator_command('workflow', 'read', action)
        elif value is None:
            command = self.adapter.operator_command('storage', action)
        else:
            identity = value.get('id') or value.get('request', {}).get('id')
            if not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9-]{36}', identity):
                raise ValueError('Storage operation requires a durable lease UUID')
            request = self.directory / ('operator-' + identity + '-' + action + '.json')
            atomic(request, value)
            command = self.adapter.operator_command('storage', action, str(request))
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=90)
        if result.returncode:
            raise RuntimeError('Protected storage authority refused ' + action)
        return json.loads(result.stdout)

    def tick(self):
        """Fast local scheduling. No Git, operator RPC, process walk or hashing."""
        if self.options.get('enabled', True) is not True:
            return []
        reports = self.latest()
        self.children = [child for child in self.children if child.poll() is None]
        try:
            with locked(self.directory / 'schedule.lock'):
                saved = read(self.schedule, {})
                now = time.time()
                copies = now - saved.get('copies', 0) >= self.options.get('copyIntervalSeconds', 300)
                cache = now - saved.get('cache', 0) >= self.options.get('cacheIntervalSeconds', 3600)
                if not copies and not cache:
                    return reports
                # A busy worker, including one with a live cleanup command,
                # retains this lock independently of supervisor restarts.
                with locked(self.directory / 'maintenance.lock'):
                    identity = str(uuid.uuid4())
                    request = self.directory / (identity + '.worker.json')
                    journal = self.directory / (identity + '.worker-custody.json')
                    atomic(request, {'config': self.config_path, 'copies': copies, 'cache': cache, 'apply': True})
                    saved.update({key: now for key, due in [('copies', copies), ('cache', cache)] if due})
                    atomic(self.schedule, saved)
                child = launch('--worker', request, journal)
                self.children.append(child)
                return reports + [{'kind': 'storage-maintenance', 'phase': 'scheduled', 'id': identity, 'pid': child.pid}]
        except BlockingIOError:
            return reports
        except Exception as error:
            return reports + [{'kind': 'storage-maintenance', 'phase': 'held', 'reason': str(error)}]

    def latest(self):
        path = self.directory / 'latest.json'
        try:
            with path.open('rb') as stream:
                content = stream.read(1024 * 1024 + 1)
            if len(content) > 1024 * 1024:
                raise ValueError('Storage report exceeds the parent read bound')
            saved = json.loads(content)
            result = []
            for item in saved.get('reports', [])[:20]:
                summary = {key: item[key] for key in ('kind', 'phase', 'state', 'ticket', 'reclaimedBytes', 'plannedBytes', 'reason') if key in item}
                summary['kind'] = summary.get('kind', 'closed-copy-storage')
                if item.get('held') and not summary.get('reason'):
                    summary['reason'] = str(item['held'][0].get('reason', 'Local evidence or process holds cleanup'))[:300]
                result.append(summary)
            return result
        except FileNotFoundError:
            return []
        except Exception:
            return [{'kind': 'storage-maintenance', 'phase': 'held', 'reason': 'Retained storage report could not be read'}]

    def acquire(self, request):
        saved = {'request': request, 'phase': 'acquiring'}
        path = self.directory / (request['id'] + '.lease.json')
        atomic(path, saved)  # A lost authority response can be reconciled by UUID.
        lease = self.rpc('acquire', request)
        self.matches(request, lease)
        saved.update(phase='acquired', lease=lease)
        atomic(path, saved)
        return path, saved

    @staticmethod
    def matches(request, lease, *, finished=False):
        keys = ('id', 'machine', 'kind', 'path', 'ticket', 'head')
        if not isinstance(lease, dict) or any(lease.get(key) != request.get(key) for key in keys) or (lease.get('finished') is None) == finished:
            raise RuntimeError('Protected storage lease identity differs from the local request')

    def verify(self, saved):
        request = saved['request']
        lease = self.rpc('verify', {key: request[key] for key in ('id', 'machine')})
        self.matches(request, lease)
        return lease

    def finish(self, path, saved, result):
        request = saved['request']
        lease = self.rpc('finish', {key: request[key] for key in ('id', 'machine')} | {'drained': True, 'result': result})
        self.matches(request, lease, finished=True)
        saved.update(phase='finished', result=result)
        atomic(path, saved)

    def reconcile(self):
        for path in sorted(self.directory.glob('*.lease.json')):
            saved = read(path)
            if saved.get('phase') == 'finished':
                continue
            request = saved['request']
            if saved.get('command'):
                # Never reinterpret a journal from an older external-command
                # implementation as synchronous work.
                raise RuntimeError('Retained external cleanup command needs independent custody proof')
            # Caller holds maintenance.lock. Both backends only unlink in this
            # process and never delegate deletion. Acquiring that lock proves an
            # earlier cleaner cannot still mutate, even after a crash.
            # cancel atomically finishes an existing lease or records a finished
            # tombstone for an acquire request that has not arrived yet. It also
            # handles a successful finish whose reply was lost.
            lease = self.rpc('cancel', {'request': request, 'drained': True})
            self.matches(request, lease, finished=True)
            saved.update(phase='finished', result='held')
            atomic(path, saved)

    def candidates(self):
        core = load('fleet-storage')
        candidates = []
        self.inventory_holds = []
        for project, settings in self.config.get('projects', {}).items():
            target = canonical(settings['target'])
            root = target.parent / '.pyrycode-worktrees' / target.name
            workflow = self.rpc(project, workflow=True)
            if workflow.get('enabled') is not True or not isinstance(workflow.get('items'), list):
                continue
            closed = {str(item['issueNumber']): item for item in workflow['items']
                      if item.get('state') == 'CLOSED' and item.get('status') == 'Done'}
            for record in core.registered_worktrees(target):
                path = canonical(record['worktree'])
                container = settings.get('containerTarget')
                if container and path.parent == Path(container).parent / '.pyrycode-worktrees' / Path(container).name and path.parent != root:
                    self.inventory_holds.append({'kind': 'closed-copy-storage', 'phase': 'held',
                        'reason': 'Container working-copy registrations require container-local inspection; host path translation is unsupported',
                        'project': project})
                    continue
                match = re.fullmatch(r'(?:builder|developer|architect|documentation|verifier|code-review|qa)-([1-9]\d*)', path.name)
                if path.parent != root or not match or match[1] not in closed or record.get('branch') != 'refs/heads/feature/' + match[1]:
                    continue
                if not re.fullmatch(r'[a-f0-9]{40}', str(record.get('HEAD', ''))):
                    continue
                candidates.append({'repository': str(target), 'path': str(path), 'head': record['HEAD'],
                                   'ticket': project + '#' + match[1]})
        return sorted(candidates, key=lambda value: value['path'])

    def copy_pass(self, machine, apply):
        candidates = self.candidates()
        progress_path = self.directory / 'copies.json'
        progress = read(progress_path, {'seen': [], 'cursor': ''})
        seen = set(progress['seen'])
        fresh = [item for item in candidates if item['path'] not in seen]
        old = [item for item in candidates if item['path'] in seen]
        cursor = progress.get('cursor', '')
        old = [item for item in old if item['path'] > cursor] + [item for item in old if item['path'] <= cursor]
        selected = (fresh + old)[:self.options.get('batch', 8)]
        reports = self.inventory_holds[:1] if getattr(self, 'inventory_holds', None) else []
        for item in selected:
            journal = saved = None
            try:
                def authority(current):
                    if any(current.get(key) != item[key] for key in ('ticket', 'path', 'head')):
                        return {'allowed': False, 'reason': 'Working-copy identity changed since inventory'}
                    if saved is not None:
                        self.verify(saved)
                    return {'allowed': True, 'exclusive': saved is not None,
                            'lease': saved['request']['id'] if saved is not None else 'audit:' + item['ticket']}
                cleaner = load('fleet-storage').FleetStorage(authority, processes_using_path)
                report = cleaner.cleanup(item['repository'], item['path'], item['ticket'])
                # A repeated clean audit creates no central lease or UUID files.
                # Apply recomputes the complete inventory under fresh authority.
                if apply and report['plannedBytes'] > 0 and report['state'] == 'planned':
                    request = {'id': str(uuid.uuid4()), 'machine': machine, 'kind': 'ticket',
                               **{key: item[key] for key in ('path', 'ticket', 'head')}}
                    journal, saved = self.acquire(request)
                    report = cleaner.cleanup(item['repository'], item['path'], item['ticket'], apply=True)
                reports.append(report)
                if saved is not None:
                    # The cleaner performs synchronous anchored unlinks. No child
                    # cleanup process can survive its return, including refusal.
                    self.finish(journal, saved, 'complete' if not report['held'] else 'held')
            except Exception as error:
                reports.append({'ticket': item['ticket'], 'path': item['path'], 'phase': 'held', 'reason': str(error)})
                if saved is not None:
                    try:
                        self.finish(journal, saved, 'held')
                    except Exception:
                        pass  # Durable UUID remains for reconciliation.
            finally:
                if apply:
                    seen.add(item['path'])
                    progress.update(seen=sorted(seen), cursor=item['path'])
                    atomic(progress_path, progress)
        return reports

    def cache_pass(self, machine, apply):
        options = self.options.get('goCache')
        if not options or options.get('enabled', True) is not True:
            return {'kind': 'go-build-cache', 'phase': 'disabled'}
        config = {'maxBytes': 16 * 1024 ** 3, 'reserveBytes': 20 * 1024 ** 3,
                  'timeoutSeconds': 600, **options}
        config['cache'] = str(canonical(config['cache']))
        config['receipt'] = str(self.directory / (str(uuid.uuid4()) + '.cache.json'))
        if not apply:
            return {'kind': 'go-build-cache', 'phase': 'audit', 'cache': config['cache'],
                    'budgets': {key: config[key] for key in ('maxBytes', 'reserveBytes')},
                    'observed': load('fleet-build-cache').inspect_cache(Path(config['cache']))}
        # Match the existing test-admission daemon's exact configured inode.
        admission = self.options.get('testAdmissionLock') or os.environ.get('PYRY_TEST_ADMISSION_LOCK') or str(Path.home() / '.local/share/pyry-fleet/test-admission.lock')
        with locked(admission, existing=True) as admission_fd:
            if not native_drained(Path(self.config['stateDirectory']) / 'tasks'):
                return {'kind': 'go-build-cache', 'phase': 'held', 'reason': 'Native descendant drainage is unconfirmed'}
            request = {'id': str(uuid.uuid4()), 'machine': machine, 'kind': 'cache', 'path': config['cache']}
            path, saved = self.acquire(request)
            saved.update(phase='synchronous-cleanup', receipt=config['receipt'])
            atomic(path, saved)
            def guard():
                def check_lock():
                    actual, held = os.stat(admission, follow_symlinks=False), os.fstat(admission_fd)
                    if (actual.st_dev, actual.st_ino) != (held.st_dev, held.st_ino):
                        raise RuntimeError('Test-admission lock identity changed')
                check_lock()
                self.verify(saved)
                if not native_drained(Path(self.config['stateDirectory']) / 'tasks'):
                    raise RuntimeError('Native descendant drainage is unconfirmed')
                check_lock()
                return {'allowed': True, 'exclusive': True, 'lease': request['id'],
                        'custody': 'drained', 'admissionHeld': True}
            report = load('fleet-build-cache').manage_cache(config, guard, apply=True)
            # All mutation is synchronous descriptor-relative unlink. Even an
            # uncertain filesystem receipt has no surviving deletion process.
            self.finish(path, saved, 'complete' if report['phase'] in ('complete', 'within-budget') else 'held')
            return report

    def run(self, *, apply=False, copies=True, cache=True):
        with locked(self.directory / 'maintenance.lock'):
            if apply:
                self.reconcile()
            status = self.adapter.status()
            machine = status.get('machine')
            if not isinstance(machine, str) or not machine or not isinstance(status.get('runs'), list):
                raise RuntimeError('Authoritative machine status is unavailable')
            reports = self.copy_pass(machine, apply) if copies else []
            if cache:
                try:
                    reports.append(self.cache_pass(machine, apply))
                except Exception as error:
                    reports.append({'kind': 'go-build-cache', 'phase': 'held', 'reason': str(error)})
            atomic(self.directory / 'latest.json', {'time': time.time(), 'apply': apply, 'reports': reports})
            return reports


def configured(path):
    path = canonical(path)
    if path.stat().st_mode & 0o022:
        raise RuntimeError('Supervisor configuration is writable by other users')
    config = read(path)
    return StorageSupervisor(load('fleet-native').NativeAdapter(config), config, path)


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        mode, request_path, journal = sys.argv[1:]
        barrier(journal)
        request = read(request_path)
        try:
            supervisor = configured(request['config'])
            supervisor.run(apply=request['apply'], copies=request['copies'], cache=request['cache'])
        except Exception as error:
            atomic(Path(request_path).parent / 'latest.json', {'time': time.time(), 'apply': request['apply'],
                'reports': [{'kind': 'storage-maintenance', 'phase': 'held', 'reason': str(error)[:300]}]})
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--run', action='store_true')
    group.add_argument('--audit', action='store_true')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply and not args.run:
        parser.error('--apply requires --run')
    print(json.dumps(configured(args.config).run(apply=args.apply), sort_keys=True))


if __name__ == '__main__':
    main()
