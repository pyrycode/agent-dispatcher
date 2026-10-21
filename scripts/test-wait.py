#!/usr/bin/env python3
"""Direct, per-spawn shared-admission wait reports and remaining work budget."""
import json
import os
from pathlib import Path
import time
import uuid


class AdmissionWait:
    def __init__(self):
        folder = os.environ.get('PYRY_TEST_WAIT_DIRECTORY')
        self.path = Path(folder) / ('wait-' + uuid.uuid4().hex + '.json') if folder else None
        self.started = None
        self.last_write = 0

    def heartbeat(self, finished=False):
        if self.path is None:
            return
        now = time.time_ns() // 1000000
        if not finished and now - self.last_write < 1000:
            return
        if self.started is None:
            self.started = now
        record = {'startedAt': self.started, 'lastSeenAt': now}
        if finished:
            record['endedAt'] = now
        pending = self.path.with_suffix('.tmp')
        try:
            pending.write_text(json.dumps(record))
            pending.replace(self.path)
        except FileNotFoundError:
            # The owning runner ended and removed its private telemetry. This
            # must not change admission, child cleanup or any test result.
            self.path = None
        self.last_write = now

    def finish(self):
        if self.started is not None:
            self.heartbeat(finished=True)


if __name__ == '__main__':
    folder = os.environ.get('PYRY_TEST_WAIT_DIRECTORY')
    if not folder:
        raise SystemExit('No dispatcher work budget is attached to this command.')
    record = json.loads((Path(folder) / 'budget.json').read_text())
    print(json.dumps(record))
