"""No-progress watchdog for reservations and heavy places on one computer.

It reads the existing state: native task receipts and their task folders, the
manager's runs and queue, and the supervisor's own operation records. It never
signals a process and never starts one. Its only automatic action is to finish
a native task whose worker has finished, has been proven drained by the
supervisor's own custody check, and whose completion the control service has
answered with the same definite refusal on every pass for longer than the
limit. That releases the reservation as failed, only while the service still
holds the task as running or in attention, and keeps every file. Everything
else becomes an attention item.
"""
import copy
import json
import os
import re
import time
from pathlib import Path

DEFAULTS = {
    # A task whose launch was requested but never confirmed.
    'launchSeconds': 600,
    # Result written, but its completion or publication preparation is refused.
    'finalizingSeconds': 600,
    # And the same definite refusal on at least this many consecutive passes.
    'refusedPasses': 5,
    # Publication prepared or started and not finished.
    'publishingSeconds': 600,
    # A task the supervisor has already put in attention, still holding its place.
    'attentionSeconds': 1800,
    # A grant deferred because its container was updating, still not started.
    'deferredSeconds': 3600,
    # A running native task: its recipe's own time limits plus this margin.
    'runningMarginSeconds': 900,
    'recipeBudgetSeconds': {
        'platform-probe': 300,
        # Two go test commands of up to an hour each, plus the checkout.
        'memory-runtime-smoke': 8400,
        # One capture command of up to an hour, plus two checkouts.
        'android-tool-then-text': 6000,
        # The repair program's own limit.
        'dispatcher-repair': 5400,
    },
    'defaultRecipeBudgetSeconds': 7200,
    # A dispatcher run that has written none of its logs for this long. Above a
    # live gate's own limits, whose legs can each run 30 minutes.
    'dispatcherSilenceSeconds': 7200,
    'roleSilenceSeconds': {},
    # A heavy job waiting for capacity this long while every holder is idle.
    'starvationSeconds': 3600,
    # A holder counts as idle when it has shown no progress for this long.
    'holderIdleSeconds': 1800,
    # Finish a finished-but-refused task as failed. False reports it instead.
    'finalize': True,
    # How long a release or finalization stays in the report as a notice.
    'noticeSeconds': 24 * 3600,
}

# Files the supervisor writes into a task folder. They are not worker progress.
SUPERVISOR_FILES = {'task.json', 'paths.json', 'worker.py', 'artifact-result.json'}
NOTICE_KINDS = {'native-task-interrupted': 'released', 'native-task-finalized': 'finalized'}
ORDER = ['finalize-refused', 'starvation', 'stalled', 'finalized', 'released', 'error']
MAX_ITEMS = 20
# A file time this far ahead of the clock is not evidence of anything.
FUTURE_MARGIN = 60


# Refusals by these operations repeat until the record changes. Publication
# itself is never one: a refused or lost publish can still be merging.
FINALIZE_OPERATIONS = {'prepare-repair', 'artifacts-begin', 'artifacts-put', 'artifacts-commit'}
# The service answers a failed completion it already holds differently with this.
RESULT_CHANGED = 'Completed task result changed'


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and value >= 0


def settings(config):
    """Configured limits, each checked against its default's type. Returns the
    settings and the names of rejected entries, which fall back to the default."""
    value = copy.deepcopy(DEFAULTS)
    rejected = []
    supplied = config.get('watchdog')
    if supplied is None:
        return value, rejected
    if not isinstance(supplied, dict):
        return value, ['watchdog']
    for key, item in supplied.items():
        default = DEFAULTS.get(key)
        if default is None:
            rejected.append(key)
        elif isinstance(default, bool):
            if isinstance(item, bool):
                value[key] = item
            else:
                rejected.append(key)
        elif isinstance(default, dict):
            if isinstance(item, dict) and all(isinstance(k, str) and number(v) for k, v in item.items()):
                value[key].update(item)
            else:
                rejected.append(key)
        elif number(item):
            value[key] = item
        else:
            rejected.append(key)
    return value, rejected


def refusal_text(refusal):
    return ('The service refused ' + str(refusal.get('operation')) + ' with ' + str(refusal.get('status')) + ': '
            + str(refusal.get('detail', ''))[:300])


def utc(seconds):
    return time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime(seconds))


def atomic(path, value):
    temporary = path.with_suffix('.new')
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(path)


def mtime(path):
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def worker_progress(directory, now):
    """The newest write by the worker itself: its logs, check results and result.
    A time in the future is ignored, so a skewed clock cannot defer a finding forever."""
    newest = None
    for folder in (directory, directory / 'logs'):
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            name = entry.name
            if name in SUPERVISOR_FILES or name.endswith('.custody.json') or name.endswith('.new'):
                continue
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
                stamp = entry.stat(follow_symlinks=False).st_mtime
            except OSError:
                continue
            if stamp > now + FUTURE_MARGIN:
                continue
            newest = stamp if newest is None else max(newest, stamp)
    return newest


def run_log_progress(logs, ticket, created, now):
    """The newest write to any dispatcher log naming this ticket since its run began."""
    number = ticket.rsplit('#', 1)[-1]
    if not number.isdigit():
        return None
    pattern = re.compile('#' + number + r'(?!\d)')
    newest = None
    try:
        entries = list(os.scandir(logs))
    except OSError:
        return None
    for entry in entries:
        if not pattern.search(entry.name):
            continue
        try:
            stamp = entry.stat(follow_symlinks=False).st_mtime
        except OSError:
            continue
        if stamp > now + FUTURE_MARGIN:
            continue
        # A log from an earlier run of the same ticket proves nothing about this one.
        if stamp >= created - 60:
            newest = stamp if newest is None else max(newest, stamp)
    return newest


class Watchdog:
    def __init__(self, adapter, config, support=None, housekeeping=None, clock=time.time, support_module=None):
        self.adapter = adapter
        self.config = config
        self.support = support
        self.housekeeping = housekeeping
        self.clock = clock
        self.module = support_module
        self.settings, self.rejected = settings(config)
        self.path = Path(config['stateDirectory']) / 'watchdog.json'

    # Persistent state: when each phase was first seen, how long each heavy job
    # has waited, and which findings were already written to housekeeping.
    def load(self):
        try:
            saved = json.loads(self.path.read_text())
        except (OSError, ValueError):
            saved = {}
        if not isinstance(saved, dict):
            saved = {}
        return {key: saved.get(key) if isinstance(saved.get(key), dict) else {} for key in ('phases', 'waits', 'raised', 'refusals')}

    def save(self, state):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_suffix('.new')
        temporary.write_text(json.dumps(state))
        temporary.chmod(0o600)
        temporary.replace(self.path)

    def phase_since(self, state, subject, phase, now):
        seen = state['phases'].get(subject)
        if not isinstance(seen, dict) or seen.get('phase') != phase or not isinstance(seen.get('since'), (int, float)):
            # A phase transition is progress.
            seen = {'phase': phase, 'since': now}
        state['phases'][subject] = seen
        return seen['since']

    def tick(self, refusals=None, operations=()):
        """Returns the watchdog items for the operation report.

        refusals maps a native task id to the definite service refusal its
        record met in this pass: operation, status and detail. It is None when
        the native task pass itself did not complete, and then nothing is
        finalized and no refusal count advances."""
        now = self.clock()
        state = self.load()
        if refusals is not None:
            self.count_refusals(state, refusals, now)
        status = self.adapter.status()
        machine = status.get('machine', '')
        runs = [r for r in status.get('runs', []) if isinstance(r, dict) and r.get('machine') == machine]
        items = []
        if self.rejected:
            items.append({'kind': 'error', 'subject': 'watchdog configuration', 'action': 'attention',
                          'reason': 'Watchdog settings ignored, defaults used instead: ' + ', '.join(sorted(map(str, self.rejected)))[:300] + '.'})
        seen = set()
        progress = {}
        tasks = self.native_tasks(state, now, refusals, machine, items, seen, progress)
        self.deferred_tasks(state, now, runs, items, seen, progress)
        self.dispatcher_runs(now, runs, items, progress)
        self.starvation(state, now, status, runs, operations, tasks, items, progress)
        state['phases'] = {k: v for k, v in state['phases'].items() if k in seen}
        self.notices(now, items)
        items = self.record(state, items)
        self.save(state)
        items.sort(key=lambda i: (ORDER.index(i['kind']) if i['kind'] in ORDER else len(ORDER), -i.get('since', 0)))
        return items[:MAX_ITEMS]

    # Native tasks: the receipts the supervisor keeps for every admitted helper.
    def count_refusals(self, state, refusals, now):
        """Consecutive passes with the same definite refusal, per record. Any
        other outcome, including a lost reply or a different refusal, restarts it."""
        counted = {}
        for task, refusal in refusals.items():
            if not isinstance(refusal, dict):
                continue
            status = refusal.get('status')
            if refusal.get('operation') not in FINALIZE_OPERATIONS or not isinstance(status, int) or not 400 <= status < 500:
                continue
            key = str(refusal['operation']) + '|' + str(status) + '|' + str(refusal.get('detail', ''))
            old = state['refusals'].get(task)
            if isinstance(old, dict) and old.get('key') == key and number(old.get('first')) and isinstance(old.get('passes'), int):
                counted[task] = {**old, 'passes': old['passes'] + 1}
            else:
                counted[task] = {'key': key, 'first': now, 'passes': 1}
        state['refusals'] = counted

    def native_tasks(self, state, now, refusals, machine, items, seen, progress):
        tasks = {}
        if not self.support:
            return tasks
        for receipt in sorted(self.support.directory.glob('*.receipt.json')):
            try:
                old = json.loads(receipt.read_text())
            except (OSError, ValueError):
                continue
            if not isinstance(old, dict) or old.get('phase') == 'complete' or not old.get('id'):
                continue
            task = old['id']
            seen.add(task)
            try:
                item = self.native_task(state, now, refusals, machine, receipt, old)
            except Exception as error:
                item = {'kind': 'error', 'subject': task, 'action': 'attention',
                        'reason': 'Watchdog could not assess this native task. ' + type(error).__name__ + ': ' + str(error)[:300]}
            info = item.pop('_info', None) if item else None
            if info:
                tasks[task] = info
                progress[task] = info['lastProgress']
            if item and item.get('kind'):
                items.append(item)
        return tasks

    def describe(self, old):
        directory = Path(old['directory']) if old.get('directory') else Path(old['result']).parent
        try:
            task = json.loads((directory / 'task.json').read_text())
        except (OSError, ValueError):
            task = {}
        request = task.get('request') if isinstance(task.get('request'), dict) else {}
        return directory, str(task.get('ticket', '')), str(request.get('recipe', ''))

    def native_task(self, state, now, refusals, machine, receipt, old):
        task = old['id']
        directory, ticket, recipe = self.describe(old)
        result = Path(old['result'])
        written = mtime(result) if result.is_file() else None

        phase = old.get('phase')
        if phase == 'launch-requested':
            watch, start, limit = 'launching', old.get('created', now), self.settings['launchSeconds']
        elif phase == 'publishing':
            watch, limit = 'publishing', self.settings['publishingSeconds']
            start = self.phase_since(state, task, watch, now)
        elif written is not None:
            # Finished: only completion, artifact return or publication preparation
            # remain. A result dated in the future counts from when it was first seen.
            watch, limit = 'finalizing', self.settings['finalizingSeconds']
            start = min(written, self.phase_since(state, task, watch, now))
        elif phase == 'attention':
            watch, limit = 'attention', self.settings['attentionSeconds']
            start = self.phase_since(state, task, watch, now)
        else:
            budgets = self.settings['recipeBudgetSeconds']
            budget = budgets.get(recipe, self.settings['defaultRecipeBudgetSeconds'])
            watch, start, limit = 'running', old.get('created', now), budget + self.settings['runningMarginSeconds']
        if watch not in ('publishing', 'attention'):
            self.phase_since(state, task, watch, now)
        start = start if isinstance(start, (int, float)) else now
        last = max(start, worker_progress(directory, now) or start)
        info = {'ticket': ticket, 'lastProgress': last, 'container': old.get('container'), 'phase': watch}
        # A running task is measured against its whole budget. Its own command
        # limits should have ended it by then, whatever it printed.
        stalled = now - (start if watch == 'running' else last) > limit
        if not stalled:
            return {'_info': {**info, 'stalled': False}}
        info['stalled'] = True
        worker = self.worker_state(old, written is not None)
        base = {'subject': task, 'ticket': ticket, 'phase': watch, 'since': start, 'lastProgress': last,
                'limitSeconds': int(limit), 'worker': worker, '_info': info}
        if old.get('finalizeAbandoned'):
            return {**base, 'kind': 'finalize-refused', 'action': 'attention', 'reason': old['finalizeAbandoned']}
        refused = state['refusals'].get(task) if refusals is not None else None
        current = (refusals or {}).get(task)
        ready = (isinstance(refused, dict) and refused.get('passes', 0) >= self.settings['refusedPasses']
                 and now - refused.get('first', now) > limit)
        if (watch == 'finalizing' and worker == 'finished' and phase in ('running', 'attention') and ready
                and self.settings['finalize'] is True):
            return {**base, **self.finalize(machine, receipt, old, ticket, written, refused, current)}
        return {**base, 'kind': 'stalled', 'action': 'attention', 'reason': self.explain(watch, worker, limit, refused, current, phase)}

    def worker_state(self, old, result_exists):
        """What is known about the worker, without signalling or reaping anything."""
        if old.get('drainConfirmed'):
            # Set only by the supervisor's full custody proof, after a result was written.
            return 'finished' if result_exists else 'uncertain'
        custody = old.get('custody')
        if not custody or not self.module:
            return 'uncertain'
        snapshot = self.module.process_snapshot()
        if snapshot is None:
            return 'uncertain'
        # A copy: the supervisor's own pass owns the saved custody journal.
        observed = self.module.observe_custody(copy.deepcopy(custody), snapshot)
        if observed != 'drained':
            return observed
        return 'exited' if result_exists else 'gone-unproven'

    def explain(self, watch, worker, limit, refused, current, phase):
        minutes = str(int(limit // 60)) + ' min'
        what = {
            'launching': 'Its launch was requested but never confirmed within ' + minutes + '.',
            'publishing': 'Its publication has not finished within ' + minutes + '.',
            'finalizing': 'It wrote its result, but completing the task has not succeeded within ' + minutes + '.',
            'attention': 'It has been in attention for over ' + minutes + ', still holding its reservation.',
            'running': 'It has run longer than its own time limit plus margin, ' + minutes + '.',
        }[watch]
        why = {
            'alive': ' Its worker is still alive, so nothing is released.',
            'uncertain': ' Whether its worker is gone cannot be established, so nothing is released.',
            'gone-unproven': ' The host side of its launch has exited without a result, but there is no proof the worker is gone, so nothing is released.',
            'exited': ' Its worker has exited, but full drainage is not yet confirmed, so nothing is released.',
            'finished': ' Its worker finished and drained.',
        }.get(worker, '')
        if watch == 'publishing':
            why += ' A publication may be in progress or merged, so it is never finished automatically.'
        elif watch == 'finalizing' and worker == 'finished' and phase not in ('running', 'attention'):
            why += ' Its record is not in a phase the watchdog finishes.'
        elif watch == 'finalizing' and worker == 'finished' and self.settings['finalize'] is not True:
            why += ' Automatic finishing is turned off.'
        elif watch == 'finalizing' and worker == 'finished':
            why += (' It is finished automatically only after the same definite service refusal on '
                    + str(self.settings['refusedPasses']) + ' consecutive passes over ' + str(int(limit // 60)) + ' min.')
        if current:
            why += ' This pass: ' + refusal_text(current)
        return what + why

    def finalize(self, machine, receipt, old, ticket, written, refused, current):
        """Finish a finished, drained task whose completion keeps being refused."""
        if not old.get('finalized'):
            detail = refusal_text(current) if current else refused['key']
            reason = ('Native task for ' + (ticket or 'an unknown ticket') + ' finished at ' + utc(min(written, self.clock()))
                      + ' and drained, but the control service refused it on ' + str(refused['passes'])
                      + ' consecutive passes since ' + utc(refused['first']) + '. ' + detail[:300])
            summary = ('Watchdog: ' + reason + ' Released as failed so its place is free. The result, logs and any prepared '
                       'publication are kept privately in task ' + old['id'][:12] + "'s folder on " + machine
                       + '. Nothing was published. Request the task again if it is still needed.')
            # Saved before the release, so a retry sends the identical result.
            old['finalized'] = {'at': self.clock(), 'reason': reason,
                                'result': {'outcome': 'failed', 'summary': summary[:15000], 'files': {}}}
            atomic(receipt, old)
        reason = old['finalized']['reason']
        try:
            # Conditional on the service still holding the task as running or in
            # attention. A task it holds as publishing is never failed here.
            self.support.rpc('complete', {'machine': machine, 'id': old['id'], 'session': old['session'],
                                          'result': old['finalized']['result'], 'expectStates': ['running', 'attention']})
        except Exception as error:
            text = str(error)
            if RESULT_CHANGED in text:
                # The service already holds another outcome. Retrying cannot help.
                old['finalizeAbandoned'] = ('The service already holds a different outcome for this task, so the watchdog '
                                            'stopped trying to release it. Reconcile the task and its reservation by hand. '
                                            + text[:300])
                atomic(receipt, old)
                return {'kind': 'finalize-refused', 'action': 'attention', 'reason': old['finalizeAbandoned']}
            return {'kind': 'finalize-refused', 'action': 'attention',
                    'reason': 'The watchdog tried to release this finished task as failed and the release was refused. '
                              + type(error).__name__ + ': ' + text[:300]}
        old['finalized']['released'] = True
        old['phase'] = 'complete'
        atomic(receipt, old)
        if self.housekeeping:
            self.housekeeping('native-task-finalized', old['id'], reason + ' Reservation released as failed; files kept.')
        return {'kind': 'finalized', 'action': 'released', 'reason': reason + ' Reservation released as failed; files kept.',
                '_info': None}

    def deferred_tasks(self, state, now, runs, items, seen, progress):
        """A deferred grant keeps its reservation without a worker."""
        if not self.support:
            return
        for marker in sorted(self.support.directory.glob('*.deferred.json')):
            try:
                saved = json.loads(marker.read_text())
            except (OSError, ValueError):
                continue
            if not isinstance(saved, dict):
                continue
            task = str(saved.get('id', ''))
            if (self.support.directory / (task + '.receipt.json')).exists():
                continue
            run = next((r for r in runs if r.get('supportTaskId') == task and r.get('id') == saved.get('runId')), None)
            if not run:
                continue
            key = task + ':deferred'
            seen.add(key)
            since = self.phase_since(state, key, 'deferred', now)
            progress[task] = since
            limit = self.settings['deferredSeconds']
            if now - since > limit:
                items.append({'kind': 'stalled', 'subject': task, 'ticket': str(run.get('parentTicket', '')), 'phase': 'deferred',
                              'since': since, 'lastProgress': since, 'limitSeconds': int(limit), 'worker': 'not-started',
                              'action': 'attention',
                              'reason': 'Its grant was deferred while its container was updating and it has not started within '
                                        + str(int(limit // 60)) + ' min. It keeps its reservation until the update completes.'})

    def dispatcher_runs(self, now, runs, items, progress):
        projects = self.config.get('projects', {})
        for run in runs:
            if run.get('supportTaskId') or run.get('resource') == 'light':
                continue
            cfg = projects.get(run.get('project'))
            created = run.get('created')
            if not isinstance(cfg, dict) or not cfg.get('agents') or not isinstance(created, (int, float)):
                continue
            created /= 1000
            ticket = str(run.get('ticket', ''))
            if not ticket.rsplit('#', 1)[-1].isdigit():
                # Shared jobs have no ticket log. Unknown progress is never called idle.
                continue
            last = max(created, run_log_progress(Path(cfg['agents']) / 'logs', ticket, created, now) or created)
            progress[run.get('id')] = last
            role = str(run.get('role', ''))
            limit = self.settings['roleSilenceSeconds'].get(role, self.settings['dispatcherSilenceSeconds'])
            if now - last > limit:
                items.append({'kind': 'stalled', 'subject': str(run.get('id', '')), 'ticket': ticket, 'phase': role,
                              'since': created, 'lastProgress': last, 'limitSeconds': int(limit), 'worker': 'dispatcher',
                              'action': 'attention',
                              'reason': 'Its ' + role + ' run has written none of its logs for over ' + str(int(limit // 60))
                                        + ' min. Its dispatcher owns the reservation, so nothing is released automatically.'})

    def holder(self, run, progress):
        last = progress.get(run.get('supportTaskId') or run.get('id'))
        ticket = str(run.get('parentTicket') or run.get('ticket', ''))
        label = ticket + (' native task' if run.get('supportTaskId') else ' ' + str(run.get('role', '')))
        return label, last

    def starvation(self, state, now, status, runs, operations, tasks, items, progress):
        idle_after = self.settings['holderIdleSeconds']
        limit = self.settings['starvationSeconds']
        heavy = [r for r in runs if r.get('resource') == 'heavy']
        holders = sorted(self.holder(r, progress) for r in heavy)
        full = isinstance(status.get('heavyLimit'), int) and len(heavy) >= status['heavyLimit']
        idle = bool(holders) and all(last is not None and now - last > idle_after for _, last in holders)
        waits = {}
        for offer in status.get('queue', []):
            if not isinstance(offer, dict) or offer.get('resource') != 'heavy' or offer.get('state') != 'waiting-for-capacity-or-lock':
                continue
            if not full:
                continue
            key = str(offer.get('ticket', '')) + ' ' + str(offer.get('role', ''))
            since = state['waits'].get(key)
            waits[key] = since if isinstance(since, (int, float)) else now
            if now - waits[key] > limit and idle:
                items.append({'kind': 'starvation', 'subject': key, 'ticket': str(offer.get('ticket', '')),
                              'phase': str(offer.get('role', '')), 'since': waits[key],
                              'lastProgress': max(last for _, last in holders), 'limitSeconds': int(limit),
                              'holder': '; '.join(label for label, _ in holders)[:200], 'action': 'attention',
                              'reason': 'A heavy ' + str(offer.get('role', '')) + ' job has waited for capacity for over '
                                        + str(int(limit // 60)) + ' min while every heavy place is held by work with no progress for over '
                                        + str(int(idle_after // 60)) + ' min: ' + '; '.join(label for label, _ in holders) + '.'})
        state['waits'] = waits
        # An update waiting for a native task that shows no progress.
        for op in operations or ():
            if not isinstance(op, dict) or op.get('phase') != 'waiting-for-native-task' or not isinstance(op.get('created'), (int, float)):
                continue
            if now - op['created'] <= limit:
                continue
            container = self.config.get('projects', {}).get(op.get('project'), {}).get('container')
            blocking = [(i['ticket'] or task, i['lastProgress']) for task, i in tasks.items()
                        if not container or not i.get('container') or i['container'] == container]
            if blocking and all(now - last > idle_after for _, last in blocking):
                names = ', '.join(t + ' native task' for t, _ in blocking)
                items.append({'kind': 'starvation', 'subject': 'update ' + str(op['project']), 'ticket': str(op['project']),
                              'phase': 'waiting-for-native-task', 'since': op['created'],
                              'lastProgress': max(last for _, last in blocking), 'limitSeconds': int(limit), 'holder': names[:200],
                              'action': 'attention',
                              'reason': 'The supervised update of ' + str(op['project']) + ' has waited for over ' + str(int(limit // 60))
                                        + ' min for native work with no progress for over ' + str(int(idle_after // 60)) + ' min: ' + names + '.'})

    def notices(self, now, items):
        """Recent automatic releases, so they reach the same report once."""
        path = Path(self.config['stateDirectory']) / 'housekeeping.jsonl'
        lines = []
        # The previous generation too: a rotation must not hide a release.
        for source in (path.with_name(path.name + '.1'), path):
            try:
                with source.open('rb') as stream:
                    size = stream.seek(0, os.SEEK_END)
                    stream.seek(max(0, size - 256 * 1024))
                    lines += stream.read().decode('utf-8', errors='replace').splitlines()
            except OSError:
                continue
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get('kind') not in NOTICE_KINDS or not isinstance(entry.get('at'), (int, float)):
                continue
            if now - entry['at'] > self.settings['noticeSeconds']:
                continue
            subject = str(entry.get('subject', ''))
            ticket = self.ticket_for(subject)
            items.append({'kind': NOTICE_KINDS[entry['kind']], 'subject': subject, 'ticket': ticket, 'since': entry['at'],
                          'action': 'released', 'reason': str(entry.get('reason', ''))[:1000]})
        # A finalization recorded in this pass also appears in housekeeping; keep one.
        unique = {}
        for item in items:
            unique.setdefault((item['kind'], item.get('subject')), item)
        items[:] = list(unique.values())

    def ticket_for(self, task):
        if not self.support or not re.fullmatch(r'[a-f0-9]{64}', task):
            return ''
        try:
            old = json.loads((self.support.directory / (task + '.receipt.json')).read_text())
            return self.describe(old)[1]
        except (OSError, ValueError, KeyError, TypeError):
            return ''

    def record(self, state, items):
        """Each new finding is written to housekeeping once. Notices already are."""
        raised = {}
        for item in items:
            if item['kind'] not in ('stalled', 'starvation', 'finalize-refused'):
                continue
            key = item['kind'] + ':' + str(item.get('subject'))
            # Progress that does not end the finding does not make it new.
            signature = str(item.get('phase')) + '|' + str(item.get('worker'))
            raised[key] = signature
            if state['raised'].get(key) != signature and self.housekeeping:
                self.housekeeping('watchdog-' + item['kind'], str(item.get('subject')),
                                  (item.get('ticket', '') + ': ' if item.get('ticket') else '') + item['reason'])
        state['raised'] = raised
        return items
