#!/usr/bin/env python3
"""Local operator service. Fixed configured workload adapters, never model-authored commands."""
import argparse
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path

TERMINAL = {'complete', 'attention'}
HOUSEKEEPING_BYTES = 256 * 1024
# Host paths stay in the local log. Published reasons carry only their shape.
HOST_PATH = re.compile(r'(?<![\w:/])/(?:[\w.@+-]+/)*[\w.@+-]+')

def redact_paths(text):
    return HOST_PATH.sub('<path>', text)
HEALTH_LATCH_REASON = 'Health failed again after a verified restart. No repeat restart within twenty-four hours.'
SIX_HOUR_REASON = 'Operation exceeded six hours. No forced stop or second signal sent.'
# Configurable through the supervisor configuration file.
DEFAULTS = {
    # A health failure must persist this long before it latches or restarts.
    'healthFailureConfirmSeconds': 600,
    # A latched dispatcher must report healthy this long before the latch clears.
    'healthLatchClearSeconds': 1800,
    # A longer pause between healthy samples restarts the clear window.
    'healthSampleGapSeconds': 900,
}

def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.new')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
    temporary.replace(path)

def real_claims(state):
    return {c['ticket']: [c['machine'], c['generation']] for c in state['claims']
            if c['ticket'].rsplit('#', 1)[-1].isdigit()}

def policy(state):
    return [state['machine'], state.get('draining'), sorted(state.get('drainingProjects', []))]

class Housekeeping:
    """Durable record of automatic clears and retirements. Nothing disappears silently."""
    def __init__(self, directory, clock=time.time, stream=None):
        self.directory = Path(directory)
        self.path = self.directory / 'housekeeping.jsonl'
        self.clock = clock
        self.stream = stream if stream is not None else sys.stderr

    def record(self, kind, subject, reason, archive=None):
        entry = {'at': self.clock(), 'kind': kind, 'subject': subject, 'reason': reason}
        if archive:
            entry['archive'] = str(archive)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.exists() and self.path.stat().st_size > HOUSEKEEPING_BYTES:
            # One previous generation is kept. The archive folders remain the full record.
            os.replace(self.path, self.path.with_name(self.path.name + '.1'))
        with self.path.open('a') as stream:
            os.chmod(self.path, 0o600)
            stream.write(json.dumps(entry) + '\n')
        print('fleet-supervisor: ' + kind + ' ' + subject + ': ' + reason, file=self.stream, flush=True)
        return entry

    def recent(self, window=24 * 3600, limit=20):
        if not self.path.exists():
            return []
        cutoff = self.clock() - window
        entries = []
        with self.path.open('rb') as stream:
            size = stream.seek(0, os.SEEK_END)
            stream.seek(max(0, size - 64 * 1024))
            lines = stream.read().decode('utf-8', errors='replace').splitlines()
        if size > 64 * 1024:
            lines = lines[1:]  # The first line can be partial.
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            # Watchdog findings have their own list in the report and would crowd this one.
            if isinstance(entry, dict) and str(entry.get('kind', '')).startswith('watchdog-'):
                continue
            if isinstance(entry, dict) and isinstance(entry.get('at'), (int, float)) and entry['at'] >= cutoff:
                entries.append({k: redact_paths(entry[k]) if isinstance(entry[k], str) else entry[k]
                                for k in ('at', 'kind', 'subject', 'reason') if k in entry})
        return entries[-limit:]

    def archive(self, kind, name, note, move=(), copy=None):
        """The same shape as a manual archive: a dated folder, the record and archive.json."""
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(self.clock()))
        base = self.directory / ('auto-' + kind + '-' + name + '-' + stamp)
        folder, number = base, 1
        while folder.exists():
            number += 1
            folder = base.with_name(base.name + '-' + str(number))
        folder.mkdir(parents=True, mode=0o700)
        # The note is written first. A crash before the move leaves the record
        # live, and the next pass archives it again into a fresh folder.
        atomic(folder / 'archive.json', {'archivedAt': self.clock(), 'automatic': True, **note})
        for name_, value in (copy or {}).items():
            atomic(folder / name_, value)
        for path in move:
            os.replace(path, folder / Path(path).name)
        return folder


def health_latched(state):
    return state.get('latch') == 'health' or state.get('reason') == HEALTH_LATCH_REASON

class Supervisor:
    """A restart survives this supervisor crashing. An uncertain signal is never repeated."""
    def __init__(self, directory, adapter, clock=time.time, settings=None, housekeeping=None, monotonic=time.monotonic):
        self.directory = Path(directory)
        self.adapter = adapter
        self.clock = clock
        self.settings = {**DEFAULTS, **{k: v for k, v in (settings or {}).items() if k in DEFAULTS}}
        self.housekeeping = housekeeping or Housekeeping(self.directory, clock)
        # In memory on purpose: a supervisor restart restarts the confirmation,
        # which only delays action on a failing dispatcher.
        self.unhealthy_since = {}
        self.monotonic = monotonic
        self.notices = {}
        # Optional callable(project). Withdraws native task admission for the
        # project's container before a drain signal. Set by the service.
        self.withhold = None

    def tick(self, project, desired):
        self.notices[project] = []
        result = self.step(project, desired)
        notes = self.notices.pop(project, [])
        if notes:
            result = {**result, 'reason': ' '.join(([result['reason']] if result.get('reason') else []) + notes)}
        return result

    def unhealthy_confirmed(self, project):
        now = self.monotonic()
        since = self.unhealthy_since.setdefault(project, now)
        return now - since >= self.settings['healthFailureConfirmSeconds']

    def recheck_attention(self, project, desired, receipt, state):
        """Only a health latch or a six-hour record can resolve without a person."""
        if health_latched(state):
            return self.watch_latch(project, desired, receipt, state)
        if state.get('reason') == SIX_HOUR_REASON and state.get('desired') != desired:
            try:
                observed = self.adapter.observe(project)
            except Exception:
                return state
            if self.superseded(project, desired, state, observed) == 'retired':
                return None
        return state

    def watch_latch(self, project, desired, receipt, state):
        try:
            observed = self.adapter.observe(project)
        except Exception:
            observed = {}
        now = self.clock()
        # Healthy on any version. A latch set on versions that have since been
        # superseded must still be able to clear, or the dispatcher can never be
        # updated: an outdated latched dispatcher is never drained. A dispatcher
        # that keeps failing never holds the window, so it is never restarted.
        good = not observed.get('stopped') and observed.get('healthy') is True
        seen = state.get('healthySeen')
        if not good or (seen is not None and now - seen > self.settings['healthSampleGapSeconds']):
            if 'healthySince' in state or 'healthySeen' in state:
                state.pop('healthySince', None); state.pop('healthySeen', None)
                atomic(receipt, state)
            if not good:
                return state
        state.setdefault('healthySince', now)
        state['healthySeen'] = now
        held = now - state['healthySince']
        if held < self.settings['healthLatchClearSeconds']:
            atomic(receipt, state)
            return state
        generation = observed.get('generation')
        on = ('the desired versions' if generation == desired else 'the verified versions' if generation == state.get('desired')
              else 'versions that are neither the verified nor the desired ones')
        reason = ('Health latch cleared automatically after ' + str(int(held)) + ' s of continuous healthy reporting on '
                  + on + '. No restart was issued.')
        if generation not in (desired, state.get('desired')):
            reason += ' The dispatcher can now be updated to the desired versions.'
        folder = self.housekeeping.archive('latch-cleared', project.replace('/', '_'),
                                           {'reason': reason, 'project': project, 'phase': 'attention'},
                                           copy={receipt.name: state})
        # The record returns to its verified state, so the twenty-four hour
        # no-repeat-restart window still applies if health fails again.
        cleared = {k: v for k, v in state.items() if k not in {'reason', 'latch', 'healthySince', 'healthySeen', 'attentionFrom'}}
        cleared['phase'] = 'complete'
        cleared['latchCleared'] = now
        if generation not in (desired, state.get('desired')):
            # The record now describes what was seen healthy. It no longer
            # matches the desired target, so the next step is an ordinary
            # supervised update: one drain, one start, verified. A failure
            # after that latches again and is never restarted.
            cleared['latchedDesired'] = state.get('desired')
            cleared['desired'] = generation
        atomic(receipt, cleared)
        self.housekeeping.record('health-latch-cleared', project, reason, folder)
        self.unhealthy_since.pop(project, None)
        self.notices[project].append(reason)
        return cleared

    def ownership_problem(self, state):
        """The verifying branch's comparison, for retiring a superseded record.

        Ownership must match exactly. A drain policy difference is accepted only
        where a recorded operator drain or resume command, made after the record
        was saved, explains each changed project."""
        after = self.adapter.status()
        current = real_claims(after)
        releases = {(c['ticket'], c['machine'], c['generation']) for c in after.get('releasedAssessmentClaims', [])}
        # A claim that no longer exists was released or withdrawn. Only a claim now
        # held by another machine or generation is an ownership change.
        if any(ticket in current and current[ticket] != owner and (ticket, *owner) not in releases
               for ticket, owner in state['claims'].items()):
            return 'Existing ticket ownership changed. Inspect the retained comparison.'
        if policy(after) != state['policy'] and not self.recorded_policy_change(state, after):
            return 'Operator drain policy changed during verification.'
        return None

    def recorded_policy_change(self, state, after):
        saved, current = state['policy'], policy(after)
        if saved[:2] != current[:2]:
            # Machine and machine-wide drain have no recorded operator command.
            return False
        created = state.get('created')
        if not isinstance(created, (int, float)):
            return False
        changes = [c for c in after.get('projectDrainChanges', []) if isinstance(c, dict)
                   and isinstance(c.get('at'), (int, float)) and c['at'] > created * 1000]
        for project in set(saved[2]) ^ set(current[2]):
            recorded = [c for c in changes if c.get('project') == project]
            if not recorded or recorded[-1].get('draining') is not (project in current[2]):
                return False
        return True

    def superseded(self, project, desired, state, observed):
        """Retire a record a later verified start has made obsolete.

        Returns 'retired', 'attention' when the record's own checks fail, or None."""
        phase = state['phase']
        # A six-hour record written before attentionFrom existed may come from a start.
        origin = state.get('attentionFrom') or (None if phase == 'attention' else phase)
        if phase == 'attention':
            # Six-hour records only. Ownership checks never ran on the pinned target.
            if state.get('reason') != SIX_HOUR_REASON or state.get('desired') == desired:
                return None
        elif phase in {'start-requested', 'verifying'}:
            # The supervisor's own start of the current target completes normally, with its checks.
            if state.get('desired') == desired:
                return None
        elif phase not in {'draining', 'waiting-for-native-task'}:
            # drain-requested and every other phase still need inspection.
            return None
        if observed.get('stopped') or observed.get('generation') != desired or observed.get('healthy') is not True:
            return None
        # The process the record drained or started must be gone.
        if state.get('identity') and observed.get('identity') == state['identity']:
            return None
        try:
            if not self.adapter.verify(project, desired):
                return None
        except Exception:
            return None
        receipt = self.directory / (project.replace('/', '_') + '.json')
        if origin in {'start-requested', 'verifying', None} and 'claims' in state and 'policy' in state:
            # The supervisor may have started this process itself. Retiring must
            # not skip the ownership comparison its verification would have made.
            problem = self.ownership_problem(state)
            if problem:
                if phase != 'attention':
                    state['attentionFrom'] = phase
                    state['phase'] = 'attention'
                    state['reason'] = problem
                    atomic(receipt, state)
                return 'attention'
        created = state.get('created')
        when = time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime(created)) if isinstance(created, (int, float)) else 'unknown time'
        if not state.get('identity'):
            ending = ': the dispatcher recovered and is verified healthy on the desired versions.'
        elif state.get('desired') != desired:
            ending = ': the dispatcher is verified healthy on the desired versions, past the record\'s target.'
        else:
            ending = ': the dispatcher is verified healthy on the desired versions after a later start.'
        reason = 'Retired ' + phase + ' record from ' + when + ' automatically' + ending
        folder = self.housekeeping.archive('retired', project.replace('/', '_'),
                                           {'reason': reason, 'project': project, 'phase': phase}, move=[receipt])
        self.housekeeping.record('operation-retired', project, reason, folder)
        self.notices[project].append(reason)
        return 'retired'

    def step(self, project, desired):
        receipt = self.directory / (project.replace('/', '_') + '.json')
        state = json.loads(receipt.read_text()) if receipt.exists() else None
        helpers_active=getattr(self.adapter,'helpers_active',lambda project:False)
        if state and state['phase'] == 'attention':
            state = self.recheck_attention(project, desired, receipt, state)
            if state and state['phase'] == 'attention':
                return state
        try:
            observed = self.adapter.observe(project)
        except Exception:
            if state and state['phase'] in {'start-requested', 'verifying'} and self.clock() - state['created'] < 6 * 3600:
                return state
            raise
        # Any healthy sample ends a failure confirmation, whatever version it runs.
        if observed.get('healthy') is True:
            self.unhealthy_since.pop(project, None)
        # Checked before the six-hour limit: a superseded record raises no alert.
        outcome = self.superseded(project, desired, state, observed) if state else None
        if outcome == 'attention':
            return state
        if outcome == 'retired':
            state = None
        if state and state['phase']=='waiting-for-native-task':
            if helpers_active(project): return state
            state=None
        if state and state['phase'] == 'complete':
            if observed.get('generation') == desired and observed.get('healthy'):
                self.unhealthy_since.pop(project, None)
                return state
            # A manager or controller restart on this host empties its reporting
            # table. That gap is not a health failure.
            if observed.get('reportingGap'):
                return state
            if state['desired'] == desired and self.clock() - state['verified'] < 24 * 3600:
                if not self.unhealthy_confirmed(project):
                    return state
                state['phase'] = 'attention'
                state['latch'] = 'health'
                state['reason'] = HEALTH_LATCH_REASON
                atomic(receipt, state)
                return state
            state = None
        if not state:
            # A service intentionally left stopped stays stopped.
            if observed.get('stopped'):
                self.unhealthy_since.pop(project, None)
                return {'phase': 'stopped', 'project': project}
            if observed.get('generation') == desired and observed.get('healthy'):
                self.unhealthy_since.pop(project, None)
                return {'phase': 'current', 'project': project}
            if observed.get('generation') == desired:
                # A restart for health alone needs a confirmed, real failure.
                if observed.get('reportingGap'):
                    return {'phase': 'current', 'project': project, 'reason': 'Waiting for dispatcher reporting after a manager restart.'}
                if not self.unhealthy_confirmed(project):
                    return {'phase': 'current', 'project': project, 'reason': 'Health check failing. Confirming before any restart.'}
            if helpers_active(project):
                state={'phase':'waiting-for-native-task','project':project,'desired':desired,'created':self.clock()}
                atomic(receipt,state)
                return state
            if not self.adapter.preflight(project, desired):
                return {'phase': 'preflight-failed', 'project': project}
            before = self.adapter.status()
            current = self.adapter.observe(project)
            if current.get('identity') != observed.get('identity'):
                return {'phase': 'changed-before-drain', 'project': project}
            # Stop new native task admissions into this container first, then
            # look again. A task admitted before the withdrawal is visible now,
            # and the drain waits for it instead of stopping its container.
            if self.withhold:
                self.withhold(project)
                if helpers_active(project):
                    state = {'phase': 'waiting-for-native-task', 'project': project, 'desired': desired, 'created': self.clock()}
                    atomic(receipt, state)
                    return state
            state = {'phase': 'drain-requested', 'project': project, 'desired': desired,
                     'identity': observed['identity'], 'childGroups': observed.get('childGroups', []), 'created': self.clock(),
                     'claims': real_claims(before), 'policy': policy(before)}
            # Write BEFORE signalling. If the host dies here, inspection replaces a second signal.
            atomic(receipt, state)
            self.unhealthy_since.pop(project, None)
            try:
                self.adapter.drain(project, observed['identity'])
                state['phase'] = 'draining'
                atomic(receipt, state)
            except Exception:
                state['phase'] = 'attention'
                state['reason'] = 'Drain acknowledgement uncertain. No second signal sent.'
                atomic(receipt, state)
            return state
        try:
            if state['phase'] == 'drain-requested':
                raise RuntimeError('Drain delivery uncertain after supervisor restart. Inspect before retrying.')
            if self.clock() - state['created'] > 6 * 3600:
                raise RuntimeError(SIX_HOUR_REASON)
            if state['desired'] != desired:
                if state['phase'] == 'draining':
                    # Nothing has been updated or started yet. Continue the same
                    # operation toward the newest target: one drain, one update,
                    # one start. Ownership and drain policy are still compared
                    # against the saved record before the update and after the start.
                    state.setdefault('retargeted', []).append({'from': state['desired'], 'at': self.clock()})
                    state['retargeted'] = state['retargeted'][-20:]
                    state['desired'] = desired
                    atomic(receipt, state)
                    self.notices[project].append('Desired versions changed while draining. The same drain now updates to the newest desired versions.')
                else:
                    # A start was already issued. Finish exactly the pinned
                    # operation; new revisions wait for its verified completion.
                    desired = state['desired']
            if state['phase'] == 'draining':
                if helpers_active(project): return state
                if not observed.get('stopped'):
                    groups = sorted(set(state.get('childGroups', []) + observed.get('childGroups', [])))
                    if groups != state.get('childGroups', []):
                        state['childGroups'] = groups; atomic(receipt, state)
                    return state
                if not observed.get('childrenStopped'):
                    return state
                before = self.adapter.status()
                if any(r['project'] == project and r['machine'] == before['machine'] and not r.get('supportTaskId') for r in before['runs']):
                    raise RuntimeError('Worker reservation remains. Ownership was preserved.')
                if policy(before) != state['policy']:
                    raise RuntimeError('Operator drain policy changed during operation.')
                self.adapter.update(project, desired)
                # A crash after this write must not issue another start.
                state['phase'] = 'start-requested'
                atomic(receipt, state)
                self.adapter.start(project)
                state['phase'] = 'verifying'
                atomic(receipt, state)
            elif state['phase'] == 'start-requested':
                if observed.get('stopped'):
                    raise RuntimeError('Start delivery uncertain. Inspect before another start.')
                state['phase'] = 'verifying'
            if state['phase'] == 'verifying':
                try:
                    ready = self.adapter.verify(project, desired)
                except Exception:
                    # The service can be active before the new workload lock exists.
                    # Keep the already acknowledged start and wait for its receipt.
                    return state
                if not ready:
                    return state
                after = self.adapter.status()
                current = real_claims(after)
                releases = {(c['ticket'], c['machine'], c['generation']) for c in after.get('releasedAssessmentClaims', [])}
                if any(current.get(ticket) != owner and (ticket, *owner) not in releases for ticket, owner in state['claims'].items()):
                    raise RuntimeError('Existing ticket ownership changed. Inspect the retained comparison.')
                if policy(after) != state['policy']:
                    raise RuntimeError('Operator drain policy changed during verification.')
                state['phase'] = 'complete'
                state['verified'] = self.clock()
                atomic(receipt, state)
                self.unhealthy_since.pop(project, None)
        except Exception as error:
            state['attentionFrom'] = state['phase']
            state['phase'] = 'attention'
            state['reason'] = str(error)
            atomic(receipt, state)
        return state


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config')
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    path = Path(args.config)
    if path.stat().st_mode & 0o022:
        raise RuntimeError('Supervisor configuration must not be writable by other users')
    config = json.loads(path.read_text())
    state = Path(config['stateDirectory'])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'supervisor.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        spec = importlib.util.spec_from_file_location('fleet_native', Path(__file__).with_name('fleet-native.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        adapter = module.NativeAdapter(config)
        housekeeping = Housekeeping(state)
        supervisor = Supervisor(state, adapter, settings=config, housekeeping=housekeeping)
        support = None
        support_module = None
        control_module = None
        if config.get('recoveryTasks') or (config.get('platform') == 'mac' and
                config.get('projects', {}).get('pyrycode/pyrycode-desktop', {}).get('target')):
            support_spec = importlib.util.spec_from_file_location('fleet_support', Path(__file__).with_name('fleet-support.py'))
            support_module = importlib.util.module_from_spec(support_spec); support_spec.loader.exec_module(support_module)
            support = support_module.SupportSupervisor(adapter, config)
            support.housekeeping = housekeeping.record
            supervisor.withhold = getattr(support, 'withhold', None)
        watchdog = None
        watchdog_failure = None
        watchdog_source = Path(__file__).with_name('fleet-watchdog.py')
        if watchdog_source.is_file():
            # A watchdog that cannot load is reported every pass. It never stops the supervisor.
            try:
                watchdog_spec = importlib.util.spec_from_file_location('fleet_watchdog', watchdog_source)
                watchdog_module = importlib.util.module_from_spec(watchdog_spec); watchdog_spec.loader.exec_module(watchdog_module)
                watchdog = watchdog_module.Watchdog(adapter, config, support, housekeeping.record, support_module=support_module)
            except Exception as error:
                watchdog_failure = 'Watchdog could not start. ' + type(error).__name__ + ': ' + redact_paths(str(error))[:300]
        if config.get('control'):
            control_spec = importlib.util.spec_from_file_location('fleet_control', Path(__file__).with_name('fleet-control.py'))
            control_module = importlib.util.module_from_spec(control_spec); control_spec.loader.exec_module(control_module)
        # SIGHUP requests a fresh credential lookup, without stopping dispatchers.
        refresh_requested = False
        def request_refresh(signum, frame):
            nonlocal refresh_requested
            refresh_requested = True
        signal.signal(signal.SIGHUP, request_refresh)
        while True:
            results = []
            try:
                if refresh_requested:
                    adapter.refresh_credentials()
                    refresh_requested = False
                if control_module and control_module.sync_control(adapter,config):
                    # Re-read the verified supervisor source without terminating any worker process.
                    os.execv(sys.executable,[sys.executable,*sys.argv])
                desired = adapter.desired()
                for project in config['projects']:
                    try:
                        if project in desired:
                            results.append(supervisor.tick(project, desired[project]))
                        else:
                            results.append({'phase': 'attention', 'project': project,
                                            'reason': 'Configured credential or desired source lookup unavailable. No stop signal sent.'})
                    except Exception as error:
                        results.append({'phase': 'attention', 'project': project,
                                        'reason': 'Configured workload observation failed. ' + type(error).__name__})
                support_failure = None
                try:
                    support_results = support.tick() if support else []
                except Exception as error:
                    # The native-task pass must not hide the operation report.
                    support_results = []
                    support_failure = 'Native task pass failed. ' + type(error).__name__ + ': ' + redact_paths(str(error))[:300]
                watch = None
                if watchdog_failure:
                    watch = [{'kind': 'error', 'subject': 'watchdog', 'action': 'attention', 'reason': watchdog_failure}]
                elif watchdog:
                    # This pass's definite service refusals per record. A failed
                    # pass gives none, and then nothing is finished automatically.
                    refusals = dict(getattr(support, 'refusals', {})) if support and support_failure is None else None
                    try:
                        watch = watchdog.tick(refusals, results)
                    except Exception as error:
                        watch = [{'kind': 'error', 'subject': 'watchdog', 'action': 'attention',
                                  'reason': 'Watchdog pass failed. ' + type(error).__name__ + ': ' + redact_paths(str(error))[:300]}]
                attention = adapter.attention()
                attention["recoveryTasks"] = support_results
                if watch is not None:
                    attention['watchdog'] = [{k: redact_paths(v) if isinstance(v, str) else v for k, v in item.items()} for item in watch]
                attention['operations'] = results
                if support and hasattr(support, 'local_task_ids'):
                    # What this computer still holds, so the control service can tell a
                    # task nobody holds from one whose machine is only quiet. It must
                    # never cost the rest of the report.
                    try:
                        local = support.local_task_ids()
                    except Exception:
                        local = None
                    if local is not None:
                        attention['localTasks'] = local
                attention['housekeeping'] = housekeeping.recent()
                if support_failure:
                    attention['service'] = 'attention'
                    attention['reason'] = support_failure
                atomic(Path(config['reportFile']), attention)
                adapter.publish_attention()
            except Exception as error:
                # Do not print arbitrary subprocess output, credentials or authored evidence.
                atomic(Path(config['reportFile']), {'generatedAt': time.time(), 'service': 'attention',
                       'reason': 'Fleet supervisor could not reach its configured control service. ' + type(error).__name__ + ': ' + str(error)[:300]})
                try:
                    adapter.publish_attention()
                except Exception:
                    pass
            if args.once:
                return
            time.sleep(config.get('intervalSeconds', 60))

if __name__ == '__main__':
    os.umask(0o077)
    main()
