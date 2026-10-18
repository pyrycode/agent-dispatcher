#!/usr/bin/env python3
"""Budget Go's disposable build cache only under a supervisor's exclusive lease.

There is no destructive CLI. The supervisor provides fresh authority and the
existing durable command runner. This module never releases a storage lease.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

CACHE_README = 'This directory holds cached build artifacts from the Go build system.\n'
GO_TOOLS = {'go', 'compile', 'link', 'asm', 'cgo', 'gccgo', 'gofmt'}
BUCKET = re.compile(r'[a-f0-9]{2}')
ENTRY = re.compile(r'([a-f0-9]{64})-([ad])')


def process_inventory():
    """Read names and start identities, never arguments or environments."""
    try:
        output = subprocess.check_output(['ps', '-axo', 'pid=,lstart=,stat=,comm='], text=True, timeout=10)
        result = []
        for line in output.splitlines():
            parts = line.split(None, 7)
            if len(parts) != 8:
                return None
            result.append({'pid': int(parts[0]), 'identity': ' '.join(parts[1:6]),
                           'state': parts[6], 'executable': parts[7]})
        return result if any(row['pid'] == os.getpid() for row in result) else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _canonical(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Cache and receipt paths must be absolute and canonical')
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if current.is_symlink():
            raise ValueError('Symlink paths cannot authorise cache cleanup')
    return path


def _config(value, apply):
    config = dict(value)
    config['cache'] = _canonical(config['cache'])
    if config['cache'] == Path(config['cache'].anchor):
        raise ValueError('A filesystem root is not a build cache')
    if not Path(config['go']).is_absolute():
        raise ValueError('The approved Go executable must be absolute')
    for name, minimum in [('maxBytes', 1), ('reserveBytes', 0)]:
        if type(config.get(name)) is not int or config[name] < minimum:
            raise ValueError(name + ' must be explicitly configured in bytes')
    timeout = config.get('timeoutSeconds')
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('timeoutSeconds must be explicitly configured')
    if apply and not config.get('receipt'):
        raise ValueError('Apply requires a durable receipt outside the cache')
    if config.get('receipt'):
        config['receipt'] = _canonical(config['receipt'])
        if config['receipt'] == config['cache'] or config['cache'] in config['receipt'].parents:
            raise ValueError('The durable receipt must be outside the cache')
    return config


def _fingerprint(paths, root):
    """No symlink traversal, including in preserved fuzz corpora and evidence."""
    inventory = []
    for path in sorted(paths):
        info = path.lstat()
        inventory.append([str(path.relative_to(root)), info.st_mode, info.st_size,
                          info.st_mtime_ns, os.readlink(path) if stat.S_ISLNK(info.st_mode) else None])
        if stat.S_ISDIR(info.st_mode):
            inventory.append(_fingerprint(list(path.iterdir()), root))
    return hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()


def inspect_cache(cache, disk_usage=shutil.disk_usage):
    """Recognise only Go's published disk cache namespace. Unknown data stays."""
    info = cache.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('Configured cache is not a real directory')
    readme = cache / 'README'
    if not readme.is_file() or readme.is_symlink() or not readme.read_text().startswith(CACHE_README):
        raise ValueError('Configured directory has no Go build-cache identity')
    # go clean -cache also removes this legacy access log. Its contents are not
    # disposable build artifacts that this manager can classify with certainty.
    if (cache / 'log.txt').exists() or (cache / 'log.txt').is_symlink():
        raise ValueError('Legacy cache log is retained for separate evidence assessment')
    compiled = 0
    files = 0
    executables = []
    retained = []
    signatures = []
    for bucket in sorted(cache.iterdir()):
        if not BUCKET.fullmatch(bucket.name):
            retained.append(bucket)
            continue
        bucket_info = bucket.lstat()
        if not stat.S_ISDIR(bucket_info.st_mode):
            raise ValueError('A Go cache bucket is not a real directory')
        for entry in sorted(bucket.iterdir()):
            match = ENTRY.fullmatch(entry.name)
            entry_info = entry.lstat()
            if not match or match[1][:2] != bucket.name or stat.S_ISLNK(entry_info.st_mode):
                raise ValueError('Unknown or symlinked content in a compiled-cache bucket')
            targets = [entry]
            if stat.S_ISDIR(entry_info.st_mode):
                targets = list(entry.iterdir())
                if match[2] != 'd' or len(targets) != 1:
                    raise ValueError('Unrecognised executable cache entry')
                binary = targets[0]
                binary_info = binary.lstat()
                if not stat.S_ISREG(binary_info.st_mode) or not binary_info.st_mode & 0o111:
                    raise ValueError('Unrecognised executable cache payload')
                executables.append(binary.name)
            for target in targets:
                target_info = target.lstat()
                if not stat.S_ISREG(target_info.st_mode):
                    raise ValueError('Unknown filesystem entry in compiled cache')
                if match[2] == 'a':
                    with target.open('rb') as source:
                        if source.read(3) != b'v1 ':
                            raise ValueError('Unrecognised Go cache action record')
                compiled += target_info.st_size
                files += 1
                signatures.append([str(target.relative_to(cache)), target_info.st_dev, target_info.st_ino,
                                   target_info.st_size, target_info.st_mtime_ns])
    return {'compiledBytes': compiled, 'compiledFiles': files, 'freeBytes': disk_usage(cache).free,
            'retainedPaths': [path.name for path in retained], 'retainedFingerprint': _fingerprint(retained, cache),
            'candidateFingerprint': hashlib.sha256(json.dumps(signatures).encode()).hexdigest(),
            'executableNames': executables}


def _proof(guard, previous=None):
    proof = guard()
    if not isinstance(proof, dict) or not all(proof.get(key) is True for key in ('allowed', 'exclusive', 'admissionHeld')) or proof.get('custody') != 'drained':
        raise ValueError('Exclusive storage lease, idle custody and held test admission are required')
    lease = str(uuid.UUID(proof.get('lease', '')))
    if previous and lease != previous['lease']:
        raise ValueError('Storage lease changed during cache cleanup')
    return {key: proof[key] for key in ('allowed', 'exclusive', 'admissionHeld', 'custody')} | {'lease': lease}


def _no_users(inventory, cache, executable_names):
    rows = inventory()
    if rows is None or not isinstance(rows, list):
        raise ValueError('Local process inventory is uncertain')
    for row in rows:
        if not isinstance(row, dict) or not all(key in row for key in ('pid', 'state', 'executable')):
            raise ValueError('Local process inventory is incomplete')
        if str(row['state']).startswith(('Z', 'X')):
            continue
        executable = row['executable']
        name = Path(executable).name
        # Linux comm may truncate a basename at 15 characters. Treat a match
        # with any cached executable as in use even if its path is unavailable.
        if name in GO_TOOLS or executable.startswith(str(cache) + '/') or any(name == candidate or name == candidate[:15] for candidate in executable_names):
            raise ValueError('A Go compiler or cached executable is still active')


def _write(path, receipt):
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(receipt, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def manage_cache(config, guard, apply=False, *, run_command=None, process_inventory=process_inventory,
                 disk_usage=shutil.disk_usage):
    """Use only with a sticky lease and a durable runner supplied by supervisor.

    run_command(argv, *, cwd, env, timeout, journal) must persist child identity
    before execution. It returns returncode and custody='drained'. An exception,
    unknown drainage or unfinished prior journal retains the lease for recovery.
    """
    receipt = {'version': 1, 'kind': 'go-build-cache', 'apply': apply, 'phase': 'refused', 'releaseSafe': False}
    path = None
    launched = False
    try:
        config = _config(config, apply)
        cache, path = config['cache'], config.get('receipt')
        receipt.update(cache=str(cache), budgets={key: config[key] for key in ('maxBytes', 'reserveBytes')})
        if apply and path.exists():
            prior = json.loads(path.read_text())
            if prior.get('phase') in ('cleaning', 'uncertain'):
                return {**prior, 'phase': 'uncertain', 'releaseSafe': False,
                        'reason': 'Retained cleanup command requires custody reassessment before another attempt'}
        proof = _proof(guard)
        receipt['proof'] = proof
        before = inspect_cache(cache, disk_usage)
        receipt['before'] = before
        receipt['budgetMet'] = before['compiledBytes'] <= config['maxBytes']
        receipt['reserveMet'] = before['freeBytes'] >= config['reserveBytes']
        _no_users(process_inventory, cache, before['executableNames'])
        triggers = []
        if before['compiledBytes'] > config['maxBytes']:
            triggers.append('cache-budget')
        if before['freeBytes'] < config['reserveBytes'] and before['compiledBytes']:
            triggers.append('free-space-reserve')
        receipt['triggers'] = triggers
        if not triggers:
            receipt.update(phase='within-budget', releaseSafe=True)
        elif not apply:
            receipt.update(phase='planned', releaseSafe=True, command=[config['go'], 'clean', '-cache'])
        else:
            if run_command is None:
                raise ValueError('Apply requires the supervisor durable command runner')
            _proof(guard, proof)
            _no_users(process_inventory, cache, before['executableNames'])
            current = inspect_cache(cache, disk_usage)
            if current['candidateFingerprint'] != before['candidateFingerprint'] or current['retainedFingerprint'] != before['retainedFingerprint']:
                raise ValueError('Cache changed after planning; retain it for reassessment')
            receipt.update(phase='cleaning', command=[config['go'], 'clean', '-cache'])
            _write(path, receipt)
            env = {key: value for key, value in os.environ.items()
                   if key in ('PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'GOPATH', 'GOMODCACHE', 'GOROOT')}
            env.update(GOCACHE=str(cache), GOTOOLCHAIN='local', GOENV='off')
            launched = True
            result = run_command(receipt['command'], cwd=str(cache.parent), env=env,
                                 timeout=config['timeoutSeconds'], journal=str(path) + '.command.json')
            receipt['commandResult'] = result
            if not isinstance(result, dict) or result.get('custody') != 'drained' or type(result.get('returncode')) is not int:
                raise RuntimeError('Cleanup command drainage is unconfirmed')
            _proof(guard, proof)
            after = inspect_cache(cache, disk_usage)
            _no_users(process_inventory, cache, after['executableNames'])
            receipt['after'] = after
            if after['retainedFingerprint'] != before['retainedFingerprint']:
                raise RuntimeError('Retained cache evidence changed; preserve the storage lease for inspection')
            receipt['budgetMet'] = after['compiledBytes'] <= config['maxBytes']
            receipt.update(phase='complete' if result['returncode'] == 0 and receipt['budgetMet'] else 'failed', releaseSafe=True)
            receipt['reserveMet'] = after['freeBytes'] >= config['reserveBytes']
        _write(path, receipt)
    except Exception as error:
        receipt.update(phase='uncertain' if launched else 'refused', reason=f'{type(error).__name__}: {error}', releaseSafe=False)
        _write(path, receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description='Inspect a configured Go cache without deleting files')
    parser.add_argument('--config', required=True, help='Saved cache path and explicit byte budgets')
    args = parser.parse_args()
    config = _config(json.loads(Path(args.config).read_text()), False)
    print(json.dumps({'version': 1, 'kind': 'go-build-cache', 'phase': 'read-only',
                      'cache': str(config['cache']), 'budgets': {key: config[key] for key in ('maxBytes', 'reserveBytes')},
                      'observed': inspect_cache(config['cache']),
                      'authority': 'Apply is available only through the protected supervisor with its lease and command runner'}, sort_keys=True))


if __name__ == '__main__':
    main()
