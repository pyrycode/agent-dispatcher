"""Reclaim only dependency leaves proven by the task's locked installation.

Sources, linked Git registration, native receipts and all test evidence remain.
There is no destructive CLI and no recursive directory removal.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time
import fcntl

spec=importlib.util.spec_from_file_location('native_storage_primitives',Path(__file__).with_name('fleet-storage.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)

class NativeAuthorityHold(base.StorageHold):
    """A fresh refusal ends this entire attempt, even if it might later clear."""


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def file_hash(fd):
    result=hashlib.sha256()
    with os.fdopen(os.dup(fd),'rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):result.update(block)
    return result.hexdigest()


def reference_tree(worktree):
    """Called immediately after successful npm ci, before executing the suite."""
    worktree=Path(worktree)
    if worktree!=worktree.resolve(strict=True) or (worktree/'node_modules').is_symlink():raise RuntimeError('Installation root is not a real canonical directory')
    entries=[];pending=[worktree/'node_modules']
    while pending:
        path=pending.pop()
        for child in sorted(path.iterdir()):
            info=child.lstat();relative=str(child.relative_to(worktree))
            if stat.S_ISLNK(info.st_mode):entries.append({'path':relative,'kind':'symlink','target':os.readlink(child)})
            elif stat.S_ISDIR(info.st_mode):pending.append(child)
            elif stat.S_ISREG(info.st_mode):
                fd=os.open(child,os.O_RDONLY|os.O_NOFOLLOW)
                try:
                    before=os.fstat(fd);sha=file_hash(fd)
                    if base.identity(before)!=base.identity(os.fstat(fd)) or base.identity(before)!=base.identity(child.lstat()):raise RuntimeError('Dependency changed while recording install')
                    entries.append({'path':relative,'kind':'file','bytes':info.st_size,'sha256':sha,'executable':info.st_mode&0o111})
                finally:os.close(fd)
            else:raise RuntimeError('Installation contains an unsupported special file')
    return {'version':1,'lockSha256':hashlib.sha256((worktree/'package-lock.json').read_bytes()).hexdigest(),'entries':sorted(entries,key=lambda row:row['path'])}


def installation(task,worktree):
    reference=reference_tree(worktree)
    return {'version':1,'taskId':task['id'],'revision':task['request']['revision'],'origin':'npm-ci','reference':reference,'referenceDigest':digest(reference)}


class NativeDependencies(base.FleetStorage):
    def cleanup(self,repository,worktree,task,attestation,apply=False):
        report={'kind':'native-task-storage','taskId':task['id'],'ticket':task['ticket'],'state':'held','plannedBytes':0,'reclaimedBytes':0,'filesRemoved':0,'held':[],'copyRetained':True}
        self.reclaimed=0;self.files_removed=0;self.last_guard=0;self.lease=None;self.apply=apply
        self.worktree=Path(worktree);self.repository=Path(repository);self.task=task
        try:
            if self.worktree!=self.worktree.resolve(strict=True) or self.repository!=self.repository.resolve(strict=True):raise base.StorageHold('Native paths must be canonical and contain no symbolic links')
            self.root_fd=os.open(self.worktree,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:
                fcntl.flock(self.root_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.root_identity=base.directory_identity(os.fstat(self.root_fd))
                self.baseline=self._git_identity()
                reference=attestation['reference']
                if attestation.get('version')!=1 or attestation.get('taskId')!=task['id'] or attestation.get('revision')!=task['request']['revision'] or attestation.get('origin') not in ('npm-ci','locked-reference') or attestation.get('referenceDigest')!=digest(reference):raise base.StorageHold('Dependency installation attestation differs from this task')
                if reference.get('version')!=1 or reference.get('lockSha256')!=hashlib.sha256((self.worktree/'package-lock.json').read_bytes()).hexdigest():raise base.StorageHold('Locked dependency source changed')
                self.lock_sha256=reference['lockSha256'];self.reference_digest=attestation['referenceDigest'];self._guard('inspect')
                seen=set()
                for entry in reference['entries']:
                    relative=entry['path']
                    if not isinstance(relative,str) or not relative.startswith('node_modules/') or any(p in ('','..','.') for p in relative.split('/')) or '\0' in relative or relative in seen:raise base.StorageHold('Unsafe or duplicate dependency reference path')
                    seen.add(relative)
                    self._pulse()
                    try:
                        parent,name=self._parent_fd(relative)
                        try:
                            if os.fstat(parent).st_dev!=self.root_identity[0]:raise base.StorageHold('Dependency parent crosses a filesystem boundary')
                            try:info=os.stat(name,dir_fd=parent,follow_symlinks=False)
                            except FileNotFoundError:continue
                            if info.st_dev!=self.root_identity[0]:raise base.StorageHold('Dependency leaf crosses a filesystem boundary')
                            expected=base.identity(info)
                            if entry['kind']=='file':
                                if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size!=entry['bytes'] or info.st_mode&0o111!=entry['executable']:raise base.StorageHold('Modified dependency remains retained')
                                fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
                                try:
                                    if base.identity(os.fstat(fd))!=expected or file_hash(fd)!=entry['sha256'] or base.identity(os.fstat(fd))!=expected:raise base.StorageHold('Modified dependency remains retained')
                                finally:os.close(fd)
                            elif entry['kind']=='symlink':
                                if not stat.S_ISLNK(info.st_mode) or os.readlink(name,dir_fd=parent)!=entry['target']:raise base.StorageHold('Modified dependency link remains retained')
                            else:raise base.StorageHold('Unsupported dependency reference entry')
                            report['plannedBytes']+=info.st_size
                            if apply:
                                self._pulse()
                                if base.identity(os.stat(name,dir_fd=parent,follow_symlinks=False))!=expected:raise base.StorageHold('Dependency changed before removal')
                                os.unlink(name,dir_fd=parent)
                                report['reclaimedBytes']+=info.st_size;report['filesRemoved']+=1
                        finally:os.close(parent)
                    except NativeAuthorityHold:raise
                    except FileNotFoundError:continue
                    except (OSError,base.StorageHold) as error:
                        report['held'].append({'path':relative,'reason':str(error)})
                self._guard('reclaim' if apply else 'inspect')
            finally:os.close(self.root_fd)
            report['state']='reclaimed' if report['filesRemoved'] else 'held' if report['held'] else 'planned' if report['plannedBytes'] else 'unchanged'
        except Exception as error:report['held'].append({'reason':str(error)})
        if report['filesRemoved']:report['state']='reclaimed'
        return report

    def _git_identity(self):
        entry=next((r for r in base.registered_worktrees(self.repository) if Path(r['worktree'])==self.worktree),None)
        if not entry or 'detached' not in entry or 'locked' in entry or 'prunable' in entry or entry.get('HEAD')!=self.task['request']['revision']:raise base.StorageHold('Native capture must be its exact detached registered working copy')
        head=os.fsdecode(base.git(self.worktree,'rev-parse','HEAD')).strip()
        common=os.fsdecode(base.git(self.worktree,'rev-parse','--path-format=absolute','--git-common-dir')).strip()
        expected=os.fsdecode(base.git(self.repository,'rev-parse','--path-format=absolute','--git-common-dir')).strip()
        if head!=entry['HEAD'] or Path(common).resolve()!=Path(expected).resolve() or base.git(self.worktree,'ls-files','-z','--','node_modules'):raise base.StorageHold('Native capture source or dependency ownership changed')
        for name in base.OPERATIONS:
            location=Path(os.fsdecode(base.git(self.worktree,'rev-parse','--git-path',name)).strip())
            if os.path.lexists(location if location.is_absolute() else self.worktree/location):raise base.StorageHold('Git operation is still present')
        return {'head':head,'common':expected}

    def _guard(self,operation):
        try:self._guard_native(operation)
        except Exception as error:raise NativeAuthorityHold(str(error)) from error

    def _guard_native(self,operation):
        if base.directory_identity(os.stat(self.worktree,follow_symlinks=False))!=self.root_identity or self._git_identity()!=self.baseline:raise base.StorageHold('Native capture identity changed')
        if hashlib.sha256((self.worktree/'package-lock.json').read_bytes()).hexdigest()!=self.lock_sha256:raise base.StorageHold('Locked dependency source changed')
        try:decision=self.authority({'taskId':self.task['id'],'ticket':self.task['ticket'],'head':self.task['request']['revision'],'path':str(self.worktree),'referenceDigest':self.reference_digest,'operation':operation})
        except Exception as error:raise base.StorageHold('Fresh protected native storage authority is unavailable') from error
        if not isinstance(decision,dict) or decision.get('allowed') is not True or self.apply and decision.get('exclusive') is not True:raise base.StorageHold('Fresh protected native storage authority is unavailable')
        lease=decision.get('lease')
        if not isinstance(lease,str) or not lease or self.lease is not None and lease!=self.lease:raise base.StorageHold('Native storage lease changed')
        self.lease=lease
        if self.processes_using_path(str(self.worktree))!=[]:raise base.StorageHold('Native capture process custody is active or unavailable')
        self.last_guard=time.monotonic()
