#!/usr/bin/env python3
"""Verify and copy a sealed backup into a new isolated directory. Never start services."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
from zoneinfo import ZoneInfo


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def restore_check(source, destination):
    source, destination = Path(source).absolute(), Path(destination).absolute()
    if source.is_symlink() or destination.exists() or destination.is_symlink():
        raise ValueError('Use a sealed source and a new isolated destination')
    manifest_path = source / 'manifest.json'
    if manifest_path.is_symlink():
        raise ValueError('Manifest cannot be a link')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('version') != 1 or set(manifest.get('files', {})) != {'claims.sqlite', 'evidence.sqlite'}:
        raise ValueError('Invalid backup manifest')
    for name, expected in manifest['files'].items():
        path = source / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != expected['bytes'] or digest(path) != expected['sha256']:
            raise ValueError('Backup file integrity check failed')
    destination.mkdir(mode=0o700, parents=False)
    (destination / 'RESTORE_HOLD.json').write_text('{"admissionAllowed":false,"checkComplete":false}\n')
    (destination / 'RESTORE_HOLD.json').chmod(0o600)
    for name in ['claims.sqlite', 'evidence.sqlite']:
        shutil.copyfile(source / name, destination / name)
        (destination / name).chmod(0o600)
    databases = []
    try:
        for name in ['claims.sqlite', 'evidence.sqlite']:
            db = sqlite3.connect((destination / name).as_uri() + '?mode=ro', uri=True)
            databases.append(db)
            if db.execute('pragma integrity_check').fetchall() != [('ok',)]:
                raise ValueError('Restored database integrity check failed')
        claims, evidence = databases
        runs = {row[0]: row[1] for row in claims.execute('select id,ticket from fleet_runs')}
        bundles = 0
        for ticket, run_id, encoded, committed in evidence.execute('select ticket,run_id,manifest,committed from evidence_bundles'):
            if runs.get(run_id) != ticket:
                raise ValueError('Evidence refers to a missing run')
            if committed is None:
                continue
            bundle = json.loads(encoded)
            for item in bundle['files']:
                chunks = []
                for part, expected in enumerate(item['chunks']):
                    row = evidence.execute('select data from evidence_chunks where ticket=? and run_id=? and path=? and part=?', (ticket, run_id, item['path'], part)).fetchone()
                    if row is None or hashlib.sha256(row[0]).hexdigest() != expected:
                        raise ValueError('Required evidence chunk is missing or corrupt')
                    chunks.append(row[0])
                data = b''.join(chunks)
                if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                    raise ValueError('Restored evidence file is corrupt')
            bundles += 1
        uncertain = claims.execute('select count(*) from fleet_runs where finished is null').fetchone()[0]
        result = {'checkedAt': datetime.now(ZoneInfo('Europe/Helsinki')).isoformat(), 'bundles': bundles,
                  'uncertainRuns': uncertain, 'networkStarted': False, 'admissionAllowed': False, 'checkComplete': True}
        (destination / 'RESTORE_HOLD.json').write_text(json.dumps(result, indent=2) + '\n')
        (destination / 'RESTORE_HOLD.json').chmod(0o600)
        return result
    finally:
        for db in databases:
            db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('destination')
    args = parser.parse_args()
    try:
        print(json.dumps(restore_check(args.source, args.destination)))
    except Exception:
        raise SystemExit('Isolated restore check failed. Retain the private files for inspection.') from None
