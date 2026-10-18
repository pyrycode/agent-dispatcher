import ctypes
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('path_custody', Path(__file__).with_name('fleet-path-custody.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ProofTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='path-custody-')
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name).resolve()
        self.device = self.path.stat().st_dev
        self.warned_path = '/Volumes/.timemachine/host/session/timemachine'
        self.warning_device = self.device + 1
        self.warning = ("lsof: WARNING: can't stat() smbfs file system " + self.warned_path + '\n'
                        '      Output information may be incomplete.\n'
                        '      assuming "dev=' + format(self.warning_device, 'x') + '" from mount table\n').encode()
        self.target = ((self.device, 26), 'apfs', '/System/Volumes/Data', '/dev/disk3s5', m._LOCAL, 0)
        self.remote = ((self.warning_device, 30), 'smbfs', self.warned_path, '//host/backup', 0, 0)
        self.mounts = (self.target, self.remote)

    def proof(self, *, warning=None, target=None, snapshots=None, path=None):
        with patch.object(m.sys, 'platform', 'darwin'), patch.object(m, '_library', return_value=object()), \
                patch.object(m, '_target_filesystem', return_value=target or self.target), \
                patch.object(m, '_mount_snapshot', side_effect=snapshots or [self.mounts, self.mounts]):
            return m.scoped_lsof_warning(self.warning if warning is None else warning, self.path if path is None else path)

    def test_exact_remote_warning_with_independent_local_device_is_proven(self):
        self.assertTrue(self.proof())

    def test_empty_truncated_duplicate_or_other_warning_holds(self):
        for warning in (b'', self.warning.split(b'      assuming')[0], self.warning * 2,
                        self.warning + b'lsof: PID 1: permission denied\n',
                        self.warning.replace(b'smbfs', b'apfs'), self.warning.replace(b'      ', b' ')):
            with self.subTest(warning=warning):
                self.assertFalse(self.proof(warning=warning))

    def test_warning_device_collision_missing_mount_or_changed_snapshot_holds(self):
        collision = self.warning.replace(format(self.warning_device, 'x').encode(), format(self.device, 'x').encode())
        self.assertFalse(self.proof(warning=collision))
        self.assertFalse(self.proof(snapshots=[(self.target,), (self.target,)]))
        self.assertFalse(self.proof(snapshots=[self.mounts, (self.target,)]))
        wrong = (self.remote[0], 'apfs', *self.remote[2:])
        self.assertFalse(self.proof(snapshots=[(self.target, wrong)] * 2))

    def test_nonlocal_or_non_apfs_target_holds(self):
        for target in ((self.target[0], 'smbfs', *self.target[2:]),
                       (*self.target[:4], 0, 0), ((self.device + 3, 26), *self.target[1:])):
            with self.subTest(target=target):
                self.assertFalse(self.proof(target=target))

    def test_warning_mount_under_target_or_above_target_holds(self):
        for mount in (str(self.path), str(self.path / 'remote'), str(self.path.parent)):
            warning = self.warning.replace(self.warned_path.encode(), mount.encode())
            remote = (self.remote[0], self.remote[1], mount, *self.remote[3:])
            self.assertFalse(self.proof(warning=warning, snapshots=[(self.target, remote)] * 2))

    def test_symlink_target_and_parent_and_root_replacement_hold(self):
        link = self.path / 'alias'
        link.symlink_to(self.path, target_is_directory=True)
        self.assertFalse(self.proof(path=link))
        self.assertFalse(self.proof(path=link / 'nested'))
        original = m._target_filesystem
        def replace_root(*args):
            self.path.rename(self.path.with_name(self.path.name + '-original'))
            self.path.mkdir()
            self.addCleanup(shutil.rmtree, self.path.with_name(self.path.name + '-original'))
            return self.target
        with patch.object(m, '_target_filesystem', side_effect=replace_root), \
                patch.object(m, '_mount_snapshot', return_value=self.mounts), \
                patch.object(m, '_library', return_value=object()), patch.object(m.sys, 'platform', 'darwin'):
            self.assertFalse(m.scoped_lsof_warning(self.warning, self.path))

    def test_native_snapshot_error_and_wrong_platform_hold(self):
        with patch.object(m.sys, 'platform', 'darwin'), patch.object(m, '_library', side_effect=OSError('unavailable')):
            self.assertFalse(m.scoped_lsof_warning(self.warning, self.path))
        with patch.object(m.sys, 'platform', 'linux'):
            self.assertFalse(m.scoped_lsof_warning(self.warning, self.path))

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin native kernel APIs required')
    def test_native_real_mount_layout_and_fsid_match_stat(self):
        library = m._library()
        descriptor = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            target = m._target_filesystem(library, descriptor)
        finally:
            os.close(descriptor)
        self.assertEqual(ctypes.sizeof(m._Statfs64), 2168)
        self.assertEqual(target[0][0] & 0xffffffff, self.device)
        self.assertIn(target, m._mount_snapshot(library))
        self.assertEqual(target[1], 'apfs')
        self.assertTrue(target[4] & m._LOCAL)

    @unittest.skipUnless(sys.platform == 'darwin' and shutil.which('lsof'), 'Darwin lsof required')
    def test_native_empty_open_file_and_cwd_under_observed_smb_warning(self):
        def census():
            result = subprocess.run(['lsof', '-nP', '-F0p', '+D', str(self.path)], capture_output=True, timeout=60)
            self.assertIn(result.returncode, (0, 1), result.stderr)
            # This is an integration test for the warning actually present on
            # this Mac. Absence of the warning is not evidence for this case.
            if not result.stderr:
                self.skipTest('This Mac has no unrelated SMB warning to validate')
            self.assertTrue(m.scoped_lsof_warning(result.stderr, self.path), result.stderr)
            fields = result.stdout.replace(b'\n', b'').split(b'\0')
            return {int(field[1:]) for field in fields if field.startswith(b'p')}
        self.assertEqual(census(), set())
        file = self.path / 'unique-failure.log'
        file.write_bytes(b'evidence remains after process census')
        script = 'import os,sys; f=open(sys.argv[1]); print("ready",flush=True); sys.stdin.buffer.read(1)'
        child = subprocess.Popen([sys.executable, '-c', script, str(file)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(), b'ready\n')
            self.assertIn(child.pid, census())
        finally:
            child.stdin.close()
            child.wait(timeout=5)
            child.stdout.close()
        child = subprocess.Popen(['/bin/sleep', '30'], cwd=self.path)
        try:
            self.assertIn(child.pid, census())
        finally:
            child.terminate()
            child.wait(timeout=5)
        self.assertEqual(census(), set())
        self.assertEqual(file.read_bytes(), b'evidence remains after process census')


if __name__ == '__main__':
    unittest.main()
