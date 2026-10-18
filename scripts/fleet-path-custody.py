#!/usr/bin/env python3
"""Prove that one Darwin lsof mount warning cannot affect a local APFS search.

This does not silence lsof, inspect remote files, or establish process custody
by itself. The caller still requires a successful complete process census and
lsof result. It can accept only this exact warning after checking its scope.

Primary source: Apple lsof dialects/darwin/libproc/dmnt.c readmnt() uses
getmntinfo(MNT_NOWAIT), emits this three-line warning for one failed mount stat,
and substitutes that entry's f_fsid[0]. dfile.c enter_vnode_info() obtains file
device/inode independently from libproc and uses them for is_file_named().
https://github.com/apple-oss-distributions/lsof/blob/main/lsof/dialects/darwin/libproc/dmnt.c
https://github.com/apple-oss-distributions/lsof/blob/main/lsof/dialects/darwin/libproc/dfile.c
The installed lsof4.91 manual specifies that +D without -x never follows
symbolic links or crosses descendant mount points. No -w or -t is permitted.

Darwin getfsstat64(MNT_NOWAIT) supplies the same kernel-retained mount entries
as getmntinfo, using caller-owned memory without touching the warned mount.
The installed getfsstat/getmntinfo manuals document this and the latter's
static-buffer hazard. statfs64 layout is from the Darwin SDK sys/mount.h.
Unknown warnings, remote/non-APFS targets and changing identities fail closed.
"""
import ctypes
import os
from pathlib import Path
import re
import stat
import sys


class _Statfs64(ctypes.Structure):
    _fields_ = [
        ('bsize', ctypes.c_uint32), ('iosize', ctypes.c_int32),
        ('blocks', ctypes.c_uint64), ('bfree', ctypes.c_uint64),
        ('bavail', ctypes.c_uint64), ('files', ctypes.c_uint64),
        ('ffree', ctypes.c_uint64), ('fsid', ctypes.c_int32 * 2),
        ('owner', ctypes.c_uint32), ('type', ctypes.c_uint32),
        ('flags', ctypes.c_uint32), ('subtype', ctypes.c_uint32),
        ('fstype', ctypes.c_char * 16), ('mount', ctypes.c_char * 1024),
        ('source', ctypes.c_char * 1024), ('flags_ext', ctypes.c_uint32),
        ('reserved', ctypes.c_uint32 * 7),
    ]


_LOCAL = 0x1000
_NOWAIT = 2
_WARNING = re.compile(
    rb'lsof: WARNING: can\'t stat\(\) smbfs file system (/[^\n]+)\n'
    rb'      Output information may be incomplete\.\n'
    rb'      assuming "dev=([0-9a-f]+)" from mount table\n?\Z')


def _entry(record):
    return (tuple(record.fsid), record.fstype.decode('utf-8'),
            record.mount.decode('utf-8'), record.source.decode('utf-8'),
            record.flags, record.flags_ext)


def _library():
    library = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    library.getfsstat64.argtypes = [ctypes.POINTER(_Statfs64), ctypes.c_int, ctypes.c_int]
    library.getfsstat64.restype = ctypes.c_int
    library.fstatfs64.argtypes = [ctypes.c_int, ctypes.POINTER(_Statfs64)]
    library.fstatfs64.restype = ctypes.c_int
    return library


def _mount_snapshot(library):
    count = library.getfsstat64(None, 0, _NOWAIT)
    if not 0 < count < 10000:
        raise ValueError('Mount census unavailable')
    # Room for a concurrent addition, which the second snapshot will detect.
    records = (_Statfs64 * (count + 1))()
    actual = library.getfsstat64(records, ctypes.sizeof(records), _NOWAIT)
    if not 0 < actual < len(records):
        raise ValueError('Mount census changed or unavailable')
    entries = tuple(sorted(_entry(records[index]) for index in range(actual)))
    if len({item[2] for item in entries}) != len(entries):
        raise ValueError('Mount paths are ambiguous')
    return entries


def _target_filesystem(library, descriptor):
    record = _Statfs64()
    if library.fstatfs64(descriptor, ctypes.byref(record)) != 0:
        raise ValueError('Target filesystem unavailable')
    return _entry(record)


def _canonical(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Target is not canonical')
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if current.is_symlink():
            raise ValueError('Target has a symbolic link')
    return path


def _disjoint(first, second):
    first, second = Path(first), Path(second)
    return first != second and first not in second.parents and second not in first.parents


def _matches(warning, path, device, filesystem, mounts):
    warning_path = os.fsdecode(warning[1])
    if '\\' in warning_path or any(ord(char) < 32 for char in warning_path):
        return False
    if str(Path(warning_path)) != warning_path or '..' in Path(warning_path).parts:
        return False
    warning_device = int(warning[2], 16)
    fsid, fstype, mount_path, _, flags, _ = filesystem
    if fstype != 'apfs' or not flags & _LOCAL or fsid[0] & 0xffffffff != device:
        return False
    if filesystem not in mounts or warning_device == device:
        return False
    matches = [item for item in mounts if item[2] == warning_path]
    if len(matches) != 1:
        return False
    warned = matches[0]
    if warned[1] != 'smbfs' or warned[4] & _LOCAL or warned[0][0] & 0xffffffff != warning_device:
        return False
    return _disjoint(warning_path, path) and _disjoint(warning_path, mount_path)


def scoped_lsof_warning(stderr, path):
    """Return True only for one proven unrelated SMB mount warning on Darwin.

    Empty stderr is handled normally by the caller and is not a warning proof.
    Every exception or incomplete native observation returns False.
    """
    if sys.platform != 'darwin' or not isinstance(stderr, bytes):
        return False
    warning = _WARNING.fullmatch(stderr)
    if warning is None:
        return False
    descriptor = None
    try:
        path = _canonical(path)
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        identity = os.fstat(descriptor)
        if not stat.S_ISDIR(identity.st_mode):
            return False
        library = _library()
        mounts = _mount_snapshot(library)
        filesystem = _target_filesystem(library, descriptor)
        if not _matches(warning, path, identity.st_dev, filesystem, mounts):
            return False
        current = os.stat(_canonical(path), follow_symlinks=False)
        return ((current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino)
                and _target_filesystem(library, descriptor) == filesystem
                and _mount_snapshot(library) == mounts)
    except (OSError, ValueError, TypeError, AttributeError, UnicodeError):
        return False
    finally:
        if descriptor is not None:
            os.close(descriptor)
