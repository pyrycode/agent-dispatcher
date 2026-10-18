#!/usr/bin/env python3
"""Check an explicit free-space floor before new heavy native work starts."""
import os
from pathlib import Path


def available_bytes(path):
    observed = os.statvfs(path)
    if observed.f_bavail < 0 or observed.f_frsize <= 0:
        raise OSError('Available disk space is unknown')
    return observed.f_bavail * observed.f_frsize


def check(policy, probe=available_bytes):
    if policy is None:
        return {'state': 'disabled', 'allowed': True}
    result = {'state': 'waiting-storage', 'allowed': False, 'freeBytes': None,
              'reason': 'Available disk space could not be confirmed. New heavy work waits for a successful storage check.'}
    try:
        path = policy['path']
        minimum = policy['minFreeBytes']
        if not isinstance(path, str) or not Path(path).is_absolute() or '..' in Path(path).parts or '\0' in path:
            raise ValueError('Invalid disk admission path')
        if type(minimum) is not int or not 0 < minimum <= 9007199254740991 or set(policy) != {'path', 'minFreeBytes'}:
            raise ValueError('Invalid disk admission floor')
        result.update(path=path, minFreeBytes=minimum)
        free = probe(path)
        if type(free) is not int or free < 0:
            raise ValueError('Available disk space is unknown')
        allowed = free >= minimum
        result.update(state='ready' if allowed else 'waiting-storage', allowed=allowed, freeBytes=free)
        if allowed:
            result.pop('reason')
        else:
            result['reason'] = 'Free disk space is below the configured start floor. New heavy work waits for storage.'
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return result
