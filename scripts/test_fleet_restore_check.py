import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('restore', Path(__file__).with_name('fleet-restore-check.py'))
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


class RestoreTests(unittest.TestCase):
    def source(self, root, missing_run=False):
        source = root / 'source'
        source.mkdir(mode=0o700)
        with sqlite3.connect(source / 'claims.sqlite') as db:
            db.execute('create table fleet_runs(id text,ticket text,finished integer)')
            if not missing_run:
                db.execute("insert into fleet_runs values('run','o/r#1',null)")
        with sqlite3.connect(source / 'evidence.sqlite') as db:
            db.execute('create table evidence_bundles(ticket text,run_id text,manifest text,committed integer)')
            db.execute('create table evidence_chunks(ticket text,run_id text,path text,part integer,data blob)')
            db.execute('insert into evidence_bundles values(?,?,?,?)', ('o/r#1', 'run', '{"files":[]}', 1))
        files = {name: {'bytes': (source / name).stat().st_size, 'sha256': restore.digest(source / name)} for name in ['claims.sqlite', 'evidence.sqlite']}
        (source / 'manifest.json').write_text(json.dumps({'version': 1, 'files': files}))
        return source

    def test_isolated_restore_never_enables_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = restore.restore_check(self.source(root), root / 'restored')
            self.assertFalse(result['admissionAllowed'])
            self.assertEqual(result['uncertainRuns'], 1)

    def test_missing_run_keeps_failed_copy_held(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                restore.restore_check(self.source(root, missing_run=True), root / 'restored')
            self.assertFalse(json.loads((root / 'restored/RESTORE_HOLD.json').read_text())['admissionAllowed'])

    def test_corruption_refuses_before_creating_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.source(root)
            (source / 'evidence.sqlite').write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                restore.restore_check(source, root / 'restored')
            self.assertFalse((root / 'restored').exists())
