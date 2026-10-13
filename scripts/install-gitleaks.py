#!/usr/bin/env python3
"""Install the reviewed Gitleaks runtime; never called during publication."""
import argparse
import hashlib
import io
import json
import os
import platform
import stat
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 64 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            raise ValueError('Invalid Gitleaks cache entry')
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('Invalid Gitleaks cache entry')
    return data


def executable_from_archive(data, pin):
    if digest(data) != pin['archiveSha256']:
        raise ValueError('Gitleaks archive integrity check failed')
    # Never extract paths. Accept the exact release layout, then read only the
    # single expected regular executable into memory. Links/duplicates fail.
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        if sorted(member.name for member in members) != ['LICENSE', 'README.md', 'gitleaks']:
            raise ValueError('Unexpected Gitleaks archive entries')
        if any(not member.isfile() or member.size > MAX_BYTES for member in members):
            raise ValueError('Invalid Gitleaks archive entry')
        member = next(member for member in members if member.name == 'gitleaks')
        with archive.extractfile(member) as stream:
            binary = stream.read(MAX_BYTES + 1)
    if digest(binary) != pin['binarySha256']:
        raise ValueError('Gitleaks executable integrity check failed')
    return binary


def atomic_write(path, data, mode):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def install(root, pins, target, archive=None, offline=False):
    pin = pins['platforms'][target]
    folder = root
    for part in ('.gitleaks-runtime', pins['version'], target):
        folder = folder / part
        folder.mkdir(mode=0o700, exist_ok=True)
        if folder.is_symlink() or not folder.is_dir():
            raise ValueError('Invalid Gitleaks cache directory')
    cached_archive = folder / pin['archive']
    executable = folder / 'gitleaks'
    # An explicitly supplied archive is checked even when the executable is
    # already cached. A corrupt install input must never look successful.
    supplied = read_regular(archive) if archive is not None else None
    if supplied is not None:
        executable_from_archive(supplied, pin)
    if executable.exists() or executable.is_symlink():
        binary = read_regular(executable)
        if digest(binary) != pin['binarySha256']:
            raise ValueError('Gitleaks executable integrity check failed')
        if cached_archive.exists() or cached_archive.is_symlink():
            executable_from_archive(read_regular(cached_archive), pin)
        executable.chmod(0o700)
        return executable
    if supplied is not None:
        data = supplied
    elif cached_archive.exists() or cached_archive.is_symlink():
        data = read_regular(cached_archive)
    elif offline:
        raise ValueError('Pinned Gitleaks archive unavailable offline')
    else:
        with urllib.request.urlopen(pin['url'], timeout=30) as response:
            data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError('Invalid Gitleaks archive size')
    binary = executable_from_archive(data, pin)
    atomic_write(cached_archive, data, 0o600)
    atomic_write(executable, binary, 0o700)
    return executable


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, help='Use a previously downloaded pinned archive')
    parser.add_argument('--offline', action='store_true', help='Refuse any network download')
    args = parser.parse_args()
    pins = json.loads((ROOT / 'scripts/gitleaks-runtime-pin.json').read_text())
    arch = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    target = sys.platform + '-' + str(arch)
    if target not in pins['platforms']:
        raise ValueError('Unsupported Gitleaks runtime platform')
    install(ROOT, pins, target, args.archive, args.offline)
    print('Gitleaks ' + pins['version'] + ' archive/executable pins verified (' + target + ')')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('Pinned Gitleaks installation failed; verify the reviewed archive and cache')
