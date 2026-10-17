#!/usr/bin/env python3
"""Typed Go entry for an admitted Core builder's ordinary PATH commands."""
import importlib.util
import os
from pathlib import Path
import sys


def main():
    root, binary, *args = sys.argv[1:]
    spec = importlib.util.spec_from_file_location('pyry_go_selection', Path(__file__).with_name('test-selection.py'))
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    try:
        folder = policy.context_directory(Path(root))
        if not folder.exists() or not folder.with_name('pyry-test-managed').exists():
            raise policy.PolicyError('Managed test context was deleted; no Go command was admitted')
        policy.check(Path(root), 'go', args)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    command = [binary, *args]
    effective = args[2:] if args[:1] == ['-C'] else args[1:] if args and args[0].startswith('-C=') else args
    admission = Path(root) / 'scripts/test-admission.py'
    if effective[:1] == ['test'] and admission.exists():
        command = [sys.executable, str(admission), '--', *command]
    os.execv(command[0], command)


if __name__ == '__main__':
    main()
