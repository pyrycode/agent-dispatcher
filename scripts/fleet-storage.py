#!/usr/bin/env python3
"""Reclaim proven generated files from an idle, closed ticket's registered copy.

The caller owns the protected, durable storage lease. Its authority callback
must freshly confirm that lease, completion, ownership and absence of affected
workers/support tasks. Central evidence summaries never authorise deleting local
evidence. Unknown ignored files keep their working copy and explicit reason.
"""
import os
import fcntl
import threading
import re
import stat
import subprocess
import time
from pathlib import Path


class StorageHold(RuntimeError):
    pass


# These contain reproducible compiler products, not reports or failure captures.
# An unexpected file holds the entire target. In particular app/build itself is
# never a target: lint_partial_results, test-results, reports and outputs survive.
COMPILED_TREES = (
    'app/build/tmp/kotlin-classes',
    'app/build/intermediates/javac',
    'app/build/intermediates/dex',
    'app/build/intermediates/external_libs_dex',
    'app/build/intermediates/project_dex_archive',
    'app/build/intermediates/project_dex_archive_for_dexing',
    'app/build/intermediates/merged_native_libs',
    'app/build/intermediates/stripped_native_libs',
    'app/build/intermediates/compiled_local_resources',
)
COMPILED_SUFFIXES = ('.class', '.kotlin_module', '.dex', '.jar', '.so', '.o', '.a', '.flat')
GRAPH_FILES = ('.codegraph/codegraph.db', '.codegraph/codegraph.db-wal', '.codegraph/codegraph.db-shm')
OPERATIONS = ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge',
              'rebase-apply', 'sequencer', 'BISECT_START', 'index.lock', 'HEAD.lock', 'packed-refs.lock')


def git(repository, *arguments, input=None):
    env = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_LITERAL_PATHSPECS': '1'}
    result = subprocess.run(['git', '-C', str(repository), *arguments], input=input,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=60)
    if result.returncode:
        raise StorageHold('Git could not establish storage safety: ' + ' '.join(arguments[:2]))
    return result.stdout


def registered_worktrees(repository):
    """Read Git registration without pruning, fetching or changing any ref."""
    records = []
    for block in git(repository, 'worktree', 'list', '--porcelain', '-z').split(b'\0\0'):
        record = {}
        for field in block.split(b'\0'):
            if not field:
                continue
            key, _, value = os.fsdecode(field).partition(' ')
            record[key] = value if value else True
        if 'worktree' in record:
            records.append(record)
    return records


def identity(value):
    return value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def directory_identity(value):
    return value.st_dev, value.st_ino


class FleetStorage:
    def __init__(self, authority, processes_using_path):
        self._mutex = threading.Lock()
        self.authority = authority
        self.processes_using_path = processes_using_path

    def cleanup(self, repository, worktree, ticket, phase='catch-up', apply=False):
        """Audit by default; apply only under the caller's exclusive storage lease."""
        with self._mutex:
            return self._cleanup(repository, worktree, ticket, phase, apply)

    def _cleanup(self, repository, worktree, ticket, phase, apply):
        """Audit by default. The callback receives one request dictionary.

        Request: ticket, path, head, phase, operation, lease. inspect is read-only;
        reclaim additionally requires exclusive:true in the response.
        The same nonempty lease token must remain valid throughout an apply.
        Caller releases its lease only after this method returns or raises.
        """
        report = {'state': 'held', 'ticket': ticket, 'path': str(worktree), 'head': None,
                  'branch': None, 'reclaimedBytes': 0, 'plannedBytes': 0, 'targets': [], 'removed': [], 'planned': [],
                  'held': [], 'partial': [], 'filesRemoved': 0, 'copyRetained': True,
                  'retainedReason': 'Source copies, branch references and all unknown or unique local evidence are retained'}
        self.lease = None
        self.reclaimed = 0
        self.files_removed = 0
        self.last_guard = time.monotonic()
        self.apply = apply
        self.ticket = ticket
        self.phase = phase
        if phase not in ('completion', 'catch-up'):
            report['held'].append({'path': str(worktree), 'reason': 'Unknown cleanup phase'})
            return report
        try:
            self.repository = Path(repository).resolve(strict=True)
            supplied = Path(worktree)
            if supplied.is_symlink():
                raise StorageHold('Working-copy path is a symbolic link')
            self.worktree = supplied.resolve(strict=True)
            report['path'] = str(self.worktree)
            match = re.fullmatch(r'[\w.-]+/[\w.-]+#([1-9]\d*)', ticket)
            if not match:
                raise StorageHold('A complete ticket identity is required')
            self.expected_branch = 'refs/heads/feature/' + match[1]
            self.root_fd = os.open(self.worktree, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                try:
                    fcntl.flock(self.root_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as error:
                    raise StorageHold('Another local storage cleanup holds this working copy') from error
                self.root_identity = directory_identity(os.fstat(self.root_fd))
                self.baseline = self._git_identity()
                report['head'], report['branch'] = self.baseline['head'], self.baseline['branch']
                self._guard('inspect')
                targets = list(GRAPH_FILES)
                if self._tracked('app/build.gradle.kts') or self._tracked('app/build.gradle'):
                    targets += list(COMPILED_TREES)
                for relative in targets:
                    try:
                        snapshot = self._snapshot(relative)
                        if snapshot is None:
                            continue
                        self._prove_generated(relative, snapshot)
                        target_bytes = sum(details[1][3] for details in snapshot.values() if details[0] == 'file')
                        target_files = sum(details[0] == 'file' for details in snapshot.values())
                        report['planned'].append(relative)
                        report['plannedBytes'] += target_bytes
                        report['targets'].append({'path': relative, 'bytes': target_bytes, 'files': target_files})
                        if not apply:
                            continue
                        self._guard('reclaim')
                        if self._snapshot(relative) != snapshot:
                            raise StorageHold('Generated target changed after inspection')
                        self.current_target = relative
                        self._remove(relative, snapshot)
                        report['reclaimedBytes'] = self.reclaimed
                        report['filesRemoved'] = self.files_removed
                        report['removed'].append(relative)
                    except (StorageHold, OSError) as error:
                        previous_bytes = report['reclaimedBytes']
                        previous_files = report['filesRemoved']
                        report['reclaimedBytes'] = self.reclaimed
                        if self.reclaimed > previous_bytes or self.files_removed > previous_files:
                            report['partial'].append({'path': relative, 'bytes': self.reclaimed - previous_bytes, 'filesRemoved': self.files_removed - previous_files})
                        report['filesRemoved'] = self.files_removed
                        report['held'].append({'path': relative, 'reason': str(error)})
            finally:
                os.close(self.root_fd)
            report['state'] = ('removed' if not report['copyRetained'] else
                               'reclaimed' if report['removed'] or self.files_removed else
                               'planned' if not apply and report['planned'] else
                               'held' if report['held'] else 'unchanged')
        except (StorageHold, OSError, subprocess.SubprocessError, ValueError) as error:
            report['held'].append({'path': str(worktree), 'reason': str(error)})
        return report

    def _tracked(self, relative):
        return bool(git(self.worktree, 'ls-files', '-z', '--', relative))

    def _git_identity(self):
        entries = registered_worktrees(self.repository)
        entry = next((r for r in entries if Path(r['worktree']) == self.worktree), None)
        if not entry or self.worktree == self.repository or self.worktree == Path(entries[0]['worktree']):
            raise StorageHold('Only a registered non-primary working copy may be cleaned')
        if 'locked' in entry or 'prunable' in entry:
            raise StorageHold('Working copy is locked or registration is uncertain')
        common = Path(os.fsdecode(git(self.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')).strip()).resolve()
        expected_common = Path(os.fsdecode(git(self.repository, 'rev-parse', '--path-format=absolute', '--git-common-dir')).strip()).resolve()
        if common != expected_common:
            raise StorageHold('Working copy belongs to another repository')
        branch = os.fsdecode(git(self.worktree, 'symbolic-ref', '--quiet', 'HEAD')).strip()
        if branch != self.expected_branch or entry.get('branch') != branch:
            raise StorageHold('Working-copy branch does not match its ticket')
        head = os.fsdecode(git(self.worktree, 'rev-parse', 'HEAD')).strip()
        if entry.get('HEAD') != head or os.fsdecode(git(self.repository, 'rev-parse', branch)).strip() != head:
            raise StorageHold('Working-copy commit and retained branch do not agree')
        status = git(self.worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
        if status:
            raise StorageHold('Working copy has local edits or untracked content')
        hidden = git(self.worktree, 'ls-files', '-v', '-z').split(b'\0')
        if any(line and (line[:1] == b'S' or line[:1].islower()) for line in hidden):
            raise StorageHold('Tracked edits may be hidden by index flags')
        if self._tracked('.gitmodules'):
            raise StorageHold('Submodule contents require separate preservation')
        for name in OPERATIONS:
            location = os.fsdecode(git(self.worktree, 'rev-parse', '--git-path', name)).strip()
            location = Path(location) if os.path.isabs(location) else self.worktree / location
            if os.path.lexists(location):
                raise StorageHold('Git operation or lock is still present: ' + name)
        return {'head': head, 'branch': branch, 'common': str(common)}

    def _guard(self, operation):
        if directory_identity(os.stat(self.worktree, follow_symlinks=False)) != self.root_identity:
            raise StorageHold('Working-copy path changed during cleanup')
        if self._git_identity() != self.baseline:
            raise StorageHold('Working-copy Git identity changed during cleanup')
        request = {'ticket': self.ticket, 'path': str(self.worktree), 'head': self.baseline['head'],
                   'phase': self.phase, 'operation': operation, 'lease': self.lease}
        try:
            decision = self.authority(request)
        except Exception as error:
            raise StorageHold('Fresh authority check is unavailable') from error
        if not isinstance(decision, dict) or decision.get('allowed') is not True:
            raise StorageHold(decision.get('reason', 'Authority refused cleanup') if isinstance(decision, dict) else 'Authority response is unavailable')
        lease = decision.get('lease')
        if not isinstance(lease, str) or not lease or self.lease is not None and lease != self.lease:
            raise StorageHold('Storage lease changed or is unavailable')
        if operation != 'inspect' and decision.get('exclusive') is not True:
            raise StorageHold('Destructive cleanup requires the exclusive protected storage lease')
        self.lease = lease
        try:
            processes = self.processes_using_path(str(self.worktree))
        except Exception as error:
            raise StorageHold('Local process census is unavailable') from error
        if not isinstance(processes, list) or any(not isinstance(pid, int) or pid <= 0 for pid in processes):
            raise StorageHold('Local process census is unavailable')
        if processes:
            raise StorageHold('Local processes still use the working copy')
        self.last_guard = time.monotonic()

    def _pulse(self):
        if self.apply and time.monotonic() - self.last_guard >= 2:
            self._guard('reclaim')

    def _parent_fd(self, relative):
        parts = Path(relative).parts
        if not parts or any(p in ('..', '.') for p in parts) or os.path.isabs(relative):
            raise StorageHold('Unsafe generated path')
        fd = os.dup(self.root_fd)
        try:
            for part in parts[:-1]:
                following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = following
            return fd, parts[-1]
        except BaseException:
            os.close(fd)
            raise

    def _snapshot(self, relative):
        try:
            parent, name = self._parent_fd(relative)
        except FileNotFoundError:
            return None
        try:
            try:
                value = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return None
            snapshot = {}
            self._walk(parent, name, '', snapshot)
            return snapshot
        finally:
            os.close(parent)

    def _walk(self, parent, name, relative, output):
        self._pulse()
        value = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if value.st_dev != self.root_identity[0]:
            raise StorageHold('Generated target crosses a filesystem boundary')
        if stat.S_ISREG(value.st_mode):
            output[relative] = ('file', identity(value))
            return
        if not stat.S_ISDIR(value.st_mode):
            raise StorageHold('Generated target contains a symbolic link or special file')
        output[relative] = ('directory', directory_identity(value))
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            if directory_identity(os.fstat(fd)) != directory_identity(value):
                raise StorageHold('Generated directory changed during inspection')
            for child in sorted(os.listdir(fd)):
                self._walk(fd, child, f'{relative}/{child}' if relative else child, output)
        finally:
            os.close(fd)

    def _prove_generated(self, relative, snapshot):
        if self._tracked(relative):
            raise StorageHold('Generated target contains tracked files')
        leaves = [path for path, (kind, _) in snapshot.items() if kind == 'file']
        if relative not in GRAPH_FILES and any(not path.endswith(COMPILED_SUFFIXES) for path in leaves):
            raise StorageHold('Target contains unknown content or possible failure evidence')
        paths = [relative + ('/' + leaf if leaf else '') for leaf in leaves] or [relative]
        values = [os.fsencode(path) for path in paths]
        process = subprocess.run(['git', '-C', str(self.worktree), 'check-ignore', '--no-index', '-z', '--stdin'],
                                 input=b'\0'.join(values) + b'\0', stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        if process.returncode not in (0, 1) or set(process.stdout.split(b'\0')) - {b''} != set(values):
            raise StorageHold('Every generated file must be positively ignored by Git')

    def _remove(self, relative, snapshot):
        parent, name = self._parent_fd(relative)
        try:
            return self._remove_entry(parent, name, '', snapshot)
        finally:
            os.close(parent)

    def _remove_entry(self, parent, name, relative, snapshot):
        self._pulse()
        expected = snapshot[relative]
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if expected[0] == 'file':
            if identity(current) != expected[1] or not stat.S_ISREG(current.st_mode):
                raise StorageHold('Generated file changed before removal')
            os.unlink(name, dir_fd=parent)
            self.reclaimed += current.st_size
            self.files_removed += 1
            return current.st_size
        if not stat.S_ISDIR(current.st_mode) or directory_identity(current) != expected[1]:
            raise StorageHold('Generated directory changed before removal')
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            prefix = relative + '/' if relative else ''
            expected_names = {p[len(prefix):].split('/')[0] for p in snapshot if p.startswith(prefix) and p != relative}
            if set(os.listdir(fd)) != expected_names:
                raise StorageHold('Generated directory contents changed before removal')
            reclaimed = 0
            for child in sorted(expected_names):
                reclaimed += self._remove_entry(fd, child, prefix + child, snapshot)
            os.rmdir(name, dir_fd=parent)
            return reclaimed
        finally:
            os.close(fd)

