#!/usr/bin/env python3
"""Offline one-time incremental-vacuum conversion. Keep the consistent backup."""
from contextlib import closing
import argparse
import json
import os
import sqlite3
from pathlib import Path


def convert(path, backup, service_stopped=False):
    if service_stopped is not True:
        raise ValueError('Stop the claim service and settle its workers before conversion')
    path, backup = Path(path).resolve(), Path(backup).absolute()
    if not path.is_file() or path == backup:
        raise ValueError('Existing database and separate unused backup path required')
    with closing(sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, timeout=5)) as source:
        if source.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Database integrity check failed; no conversion attempted')
        if source.execute('SELECT count(*) FROM fleet_runs WHERE finished IS NULL').fetchone()[0]:
            raise ValueError('Unsettled run records remain; do not release them for conversion')
        # Exclusive creation protects an existing backup, including symlinks.
        descriptor = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        with closing(sqlite3.connect(backup)) as saved:
            # SQLite backup includes committed WAL data. A main-file copy does not.
            source.backup(saved)
            if saved.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Backup integrity check failed; no conversion attempted')
        def disk_bytes():
            wal = Path(str(path) + '-wal')
            return path.stat().st_size + (wal.stat().st_size if wal.exists() else 0)
        before = disk_bytes()
        source.execute('PRAGMA auto_vacuum=INCREMENTAL')
        source.execute('VACUUM')
        source.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        if source.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or source.execute('PRAGMA auto_vacuum').fetchone()[0] != 2:
            raise ValueError('Conversion verification failed; retain the backup for recovery')
        return {'beforeBytes': before, 'afterBytes': disk_bytes(), 'backup': str(backup), 'integrity': 'ok'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    parser.add_argument('backup', type=Path)
    parser.add_argument('--service-stopped', action='store_true')
    args = parser.parse_args()
    print(json.dumps(convert(args.database, args.backup, args.service_stopped)))


if __name__ == '__main__':
    main()
