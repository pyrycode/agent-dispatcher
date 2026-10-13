import importlib.util
import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('install_gitleaks', Path(__file__).with_name('install-gitleaks.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(entries=None):
    binary = b'synthetic executable bytes, never executed'
    entries = entries or [('LICENSE', b'attribution'), ('README.md', b'upstream readme'), ('gitleaks', binary)]
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for entry in entries:
            if isinstance(entry, tarfile.TarInfo):
                archive.addfile(entry)
            else:
                name, content = entry
                member = tarfile.TarInfo(name)
                member.size = len(content)
                member.mode = 0o755 if name == 'gitleaks' else 0o644
                archive.addfile(member, io.BytesIO(content))
    data = output.getvalue()
    pin = {'archive': 'fixture.tar.gz', 'url': 'https://invalid.example/never-download',
           'archiveSha256': module.digest(data), 'binarySha256': module.digest(binary)}
    return data, pin, binary


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.network = patch.object(module.urllib.request, 'urlopen', side_effect=AssertionError('Network forbidden in installer tests'))
        self.network.start()
        self.addCleanup(self.network.stop)

    def test_offline_install_verifies_both_pins_and_reuses_without_changes(self):
        data, pin, binary = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'input.tar.gz'
            archive.write_bytes(data)
            pins = {'version': '8.30.1', 'platforms': {'linux-x64': pin}}
            executable = module.install(root, pins, 'linux-x64', archive, offline=True)
            self.assertEqual(executable.read_bytes(), binary)
            self.assertEqual(executable.stat().st_mode & 0o777, 0o700)
            before = executable.stat().st_mtime_ns
            archive.write_bytes(b'wrong supplied archive')
            with self.assertRaises(ValueError):
                module.install(root, pins, 'linux-x64', archive, offline=True)
            self.assertEqual(executable.stat().st_mtime_ns, before)
            archive.unlink()
            self.assertEqual(module.install(root, pins, 'linux-x64', offline=True), executable)
            self.assertEqual(executable.stat().st_mtime_ns, before)
            executable.unlink()
            self.assertEqual(module.install(root, pins, 'linux-x64', offline=True).read_bytes(), binary)

    def test_wrong_archive_and_wrong_executable_are_refused_before_installation(self):
        data, pin, _ = fixture()
        for bad_data, bad_pin in [(data + b'changed', pin), (data, {**pin, 'binarySha256': '0' * 64})]:
            with self.subTest(), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / 'input.tar.gz'
                archive.write_bytes(bad_data)
                pins = {'version': '8.30.1', 'platforms': {'linux-x64': bad_pin}}
                with self.assertRaises(ValueError):
                    module.install(root, pins, 'linux-x64', archive, offline=True)
                self.assertFalse((root / '.gitleaks-runtime/8.30.1/linux-x64/gitleaks').exists())

    def test_unexpected_paths_duplicates_and_nonregular_entries_are_refused(self):
        data, pin, binary = fixture()
        for name in ['../gitleaks', '/gitleaks', './gitleaks', 'bin/gitleaks']:
            with self.subTest(name=name):
                data, bad_pin, _ = fixture([('LICENSE', b''), ('README.md', b''), (name, binary)])
                with self.assertRaises(ValueError):
                    module.executable_from_archive(data, bad_pin)
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE]:
            with self.subTest(kind=kind):
                member = tarfile.TarInfo('gitleaks')
                member.type = kind
                member.linkname = '../outside'
                data, bad_pin, _ = fixture([('LICENSE', b''), ('README.md', b''), member])
                with self.assertRaises(ValueError):
                    module.executable_from_archive(data, bad_pin)
        for extra in [('gitleaks', binary), ('unexpected-executable', binary)]:
            data, bad_pin, _ = fixture([('LICENSE', b''), ('README.md', b''), ('gitleaks', binary), extra])
            with self.assertRaises(ValueError):
                module.executable_from_archive(data, bad_pin)

    def test_missing_or_changed_cache_fails_closed_offline(self):
        data, pin, _ = fixture()
        pins = {'version': '8.30.1', 'platforms': {'linux-x64': pin}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                module.install(root, pins, 'linux-x64', offline=True)
            archive = root / 'input.tar.gz'
            archive.write_bytes(data)
            executable = module.install(root, pins, 'linux-x64', archive, offline=True)
            executable.write_bytes(b'changed')
            with self.assertRaises(ValueError):
                module.install(root, pins, 'linux-x64', offline=True)
            executable.unlink()
            executable.symlink_to(archive)
            with self.assertRaises(OSError):
                module.install(root, pins, 'linux-x64', offline=True)
            executable.unlink()
            os.mkfifo(executable)
            with self.assertRaises(ValueError):
                module.install(root, pins, 'linux-x64', offline=True)

    def test_changed_cached_archive_and_linked_cache_directory_are_refused(self):
        data, pin, _ = fixture()
        pins = {'version': '8.30.1', 'platforms': {'linux-x64': pin}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'input.tar.gz'
            archive.write_bytes(data)
            executable = module.install(root, pins, 'linux-x64', archive, offline=True)
            (executable.parent / pin['archive']).write_bytes(b'changed')
            with self.assertRaises(ValueError):
                module.install(root, pins, 'linux-x64', offline=True)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'elsewhere').mkdir()
            (root / '.gitleaks-runtime').symlink_to(root / 'elsewhere', target_is_directory=True)
            with self.assertRaises(ValueError):
                module.install(root, pins, 'linux-x64', archive, offline=True)


if __name__ == '__main__':
    unittest.main()
