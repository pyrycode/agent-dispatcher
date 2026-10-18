#!/usr/bin/env python3
"""Retain native receipt bytes before a future boot; never infer past drainage.

The single companion archive per task is write-once. A receipt first observed after a reboot
cannot certify itself: that archive belongs to the current boot and must wait
for another boot. This proves only old local processes cannot survive a reboot.
Reservations, task settlement, operator controls and storage leases remain
independent authority checks. No original receipt is rewritten by this module.
"""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid


_LIMIT = 1024 * 1024


def kernel_boot():
    """Read kernel identity, never a receipt timestamp or file modification time."""
    if sys.platform != 'darwin':
        return None
    try:
        epoch = subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.boottime'], text=True, timeout=5)
        match = re.fullmatch(r'\{ sec = (\d+), usec = (\d+) \}[^\n]*\n?', epoch)
        identity = subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], text=True, timeout=5).strip()
        if not match or int(match[2]) >= 1000000 or str(uuid.UUID(identity)).upper() != identity.upper():
            return None
        hardware = subprocess.check_output(['/usr/sbin/ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], text=True, timeout=5)
        hosts = re.findall(r'"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"', hardware)
        if len(hosts) != 1:
            return None
        host = hashlib.sha256(uuid.UUID(hosts[0]).bytes).hexdigest()
        return {'identity': identity.upper(), 'epoch': int(match[1]) + int(match[2]) / 1000000, 'host': host}
    except (OSError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
        return None


def _canonical(path, missing_leaf=False):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Native proof paths must be canonical and absolute')
    current = Path(path.anchor)
    for index, part in enumerate(path.parts[1:]):
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if missing_leaf and index == len(path.parts) - 2:
                continue
            raise
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('Native proof paths cannot contain symbolic links')
    return path


def _directory_fd(path):
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in _canonical(path).parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _read(path, limit=_LIMIT):
    path = _canonical(path)
    parent = _directory_fd(path.parent)
    try:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError('Invalid native proof record')
        with os.fdopen(os.dup(descriptor), 'rb') as stream:
            data = stream.read(limit + 1)
        after = os.fstat(descriptor)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if len(data) > limit or identity(before) != identity(after) or identity(before) != identity(path.lstat()):
            raise ValueError('Native proof record changed while reading')
        return data
    finally:
        os.close(descriptor)


def _valid_boot(value, now):
    return (isinstance(value, dict) and set(value) == {'identity', 'epoch', 'host'}
            and isinstance(value['host'], str) and re.fullmatch(r'[a-f0-9]{64}', value['host'])
            and isinstance(value['identity'], str)
            and str(uuid.UUID(value['identity'])).upper() == value['identity'].upper()
            and type(value['epoch']) in (int, float) and math.isfinite(value['epoch'])
            and 0 < value['epoch'] <= now)


def _basis(receipt, raw):
    record = json.loads(raw)
    task = record['id']
    if (not re.fullmatch(r'[a-f0-9]{64}', task) or receipt.name != task + '.receipt.json'
            or receipt.parent.name != 'tasks' or record.get('container')
            or not isinstance(record.get('session'), str) or not record['session']):
        raise ValueError('Not a retained local native task receipt')
    result = _canonical(record['result'], missing_leaf=True)
    directory = _canonical(record.get('directory', result.parent))
    if not directory.is_dir() or result.parent != directory:
        raise ValueError('Native task directory differs from its result path')
    return {'receipt': str(receipt), 'result': str(result), 'directory': str(directory),
            'task': task, 'sha256': hashlib.sha256(raw).hexdigest()}


def _archive(path, record):
    state = _directory_fd(path.parent.parent)
    parent = None
    descriptor = None
    try:
        try:
            os.mkdir(path.parent.name, mode=0o700, dir_fd=state)
        except FileExistsError:
            pass
        parent = os.open(path.parent.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=state)
        data = json.dumps(record, sort_keys=True).encode('utf-8')
        descriptor = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(os.dup(descriptor), 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(parent)
        os.fsync(state)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if parent is not None:
            os.close(parent)
        os.close(state)


def check(receipt, machine, *, prepare=True, boot=None, now=None):
    """Return a boot drainage proof or None, retaining exact history if requested.

    ``prepare=False`` is a read-only consumer. Preparation must happen before a
    future reboot. Missing/changed archives, same boot, rollback, symlinks and
    unavailable kernel observations remain unproved. Test injection is explicit;
    production callers always use the trusted live kernel and wall clock.
    """
    try:
        if not isinstance(machine, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', machine):
            return None
        now = time.time() if now is None else now
        if type(now) not in (int, float) or not math.isfinite(now) or now <= 0:
            return None
        boot = kernel_boot() if boot is None else boot
        if not _valid_boot(boot, now):
            return None
        receipt = _canonical(receipt)
        raw = _read(receipt)
        basis = _basis(receipt, raw)
        archive = receipt.parent.parent / 'native-boot-proofs' / (basis['task'] + '.json')
        if not archive.exists():
            if not prepare:
                return None
            record = {'version': 1, 'machine': machine, 'basis': basis, 'savedEpoch': now,
                      'boot': boot, 'originalBase64': base64.b64encode(raw).decode('ascii')}
            try:
                _archive(archive, record)
            except FileExistsError:
                pass  # Another observer owns the immutable first observation.
            return None
        record = json.loads(_read(archive, 2 * _LIMIT))
        if (record.get('version') != 1 or record.get('machine') != machine or record.get('basis') != basis
                or base64.b64decode(record['originalBase64'], validate=True) != raw
                or type(record['savedEpoch']) not in (int, float) or not math.isfinite(record['savedEpoch'])
                or not 0 < record['savedEpoch'] <= now or not _valid_boot(record['boot'], record['savedEpoch'])
                or record['boot']['host'] != boot['host']
                or record['boot']['identity'].upper() == boot['identity'].upper()
                or not record['boot']['epoch'] < boot['epoch'] or not record['savedEpoch'] < boot['epoch']):
            return None
        # Recheck exact bytes and canonical paths after the proof was inspected.
        if _read(receipt) != raw or _basis(receipt, raw) != basis:
            return None
        return ('Kernel boot changed after the retained receipt was archived. Its old local worker and descendants cannot survive that boot. '
                'Original receipt bytes remain in ' + str(archive) + '.')
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None
