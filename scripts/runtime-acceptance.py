#!/usr/bin/env python3
"""Run protected disposable startup and native readiness checks with no credential output."""
import argparse
from datetime import datetime
import json
import importlib.util
from pathlib import Path
import tempfile
from zoneinfo import ZoneInfo

spec = importlib.util.spec_from_file_location('fleet_acceptance_support', Path(__file__).with_name('fleet-support.py'))
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)


def supervised(command, cwd, timeout, reports=None):
    if not isinstance(command, list) or not command or any(not isinstance(arg, str) or not arg or '\x00' in arg for arg in command):
        raise ValueError('Use an explicit command argument list')
    directory = Path(reports) if reports else Path(tempfile.mkdtemp(prefix='fleet-acceptance-'))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_mode & 0o077:
        raise ValueError('Acceptance receipts must be private')
    code = support.execute(command, cwd, directory / 'execution.log', timeout=timeout, cleanup_timeout=2)
    return code == 0 and support.command_custody(directory) == 'drained'


def accept(config):
    cwd = Path(config['directory']).resolve(strict=True)
    timeout = config.get('timeoutSeconds', 30)
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 120:
        raise ValueError('Acceptance timeout must be above zero and at most 120 seconds')
    reports = Path(tempfile.mkdtemp(prefix='fleet-acceptance-'))
    startup = supervised(config['disposableStartup'], cwd, timeout, reports / 'startup')
    platform = startup and supervised(config['platformProbe'], cwd, timeout, reports / 'platform')
    return {'checkedAt': datetime.now(ZoneInfo('Europe/Helsinki')).isoformat(), 'startupPassed': startup,
            'platformPassed': platform, 'accepted': startup and platform,
            'receiptsDirectory': str(reports),
            'scope': 'Configured disposable runtime only. Native rollout still requires approval.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config')
    args = parser.parse_args()
    try:
        result = accept(json.loads(Path(args.config).read_text()))
        print(json.dumps(result))
        raise SystemExit(0 if result['accepted'] else 1)
    except Exception:
        raise SystemExit('Runtime acceptance refused. Inspect the protected configuration.') from None
