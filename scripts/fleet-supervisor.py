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
# Records written before an undelivered or unconfirmed stop signal had its own
# handling. They are now waited out like any drain: no second signal is sent.
UNCERTAIN_SIGNAL_REASONS = ('Drain acknowledgement uncertain. No second signal sent.',
                            'Drain delivery uncertain after supervisor restart. Inspect before retrying.')
# A stop signal that keeps failing before delivery goes to attention after this many passes.
SIGNAL_RETRIES = 3
# After an unconfirmed signal, a dispatcher that is gone may have been stopped
# by hand. Without an explicit run state it is never started automatically.
EXITED_UNCONFIRMED_REASON = ('The dispatcher exited after a stop signal whose delivery was unconfirmed, so it may have been stopped by hand. '
                             'Not started automatically: operator.sh start --machine THIS_COMPUTER --project PROJECT starts it on the desired versions, '
                             'and operator.sh stop keeps it stopped.')
UNCONFIRMED_NOTE = ('Stop signal delivery is unconfirmed. Waiting for the dispatcher to exit; '
                    'no second signal is sent, and the six-hour limit still applies.')
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
        # Consecutive stop signals that were certainly not sent, per board. In
        # memory: a supervisor restart allows another few tries.
        self.signal_failures = {}
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

    def desired_run(self, project):
        """The board's central run state, read from the local manager.

        'running' or 'stopped' as the operator set it, 'unknown' while the
        manager has no desired state yet, or None for a board, manager or claim
        service without one, which keeps the older behaviour: a stopped
        dispatcher stays stopped and a running one is updated."""
        try:
            state = self.adapter.status()
        except Exception:
            return 'unknown'
        desired = state.get('desiredState') if isinstance(state, dict) else None
        if not isinstance(desired, dict):
            return None
        if desired.get('known') is not True:
            return 'unknown'
        entry = (desired.get('projects') or {}).get(project)
        run = entry.get('run') if isinstance(entry, dict) else None
        return run if run in ('running', 'stopped') else None

    def retire_receipt(self, project, receipt, state, reason):
        folder = self.housekeeping.archive('retired', project.replace('/', '_'),
                                           {'reason': reason, 'project': project, 'phase': state.get('phase')}, move=[receipt])
        self.housekeeping.record('operation-retired', project, reason, folder)
        self.notices[project].append(reason)

    def recheck_attention(self, project, desired, receipt, state):
        """Only a health latch, a six-hour record or an unconfirmed signal can resolve without a person."""
        quiet = health_latched(state) or state.get('reason') in (SIX_HOUR_REASON, EXITED_UNCONFIRMED_REASON, *UNCERTAIN_SIGNAL_REASONS)
        if state.get('reason') == EXITED_UNCONFIRMED_REASON and self.desired_run(project) == 'running':
            # The operator's start answers the question: continue to update and start.
            resumed = {k: v for k, v in state.items() if k not in {'reason', 'attentionFrom'}}
            resumed.update(phase='draining', timerFrom=self.clock())
            atomic(receipt, resumed)
            return resumed
        if quiet and self.desired_run(project) == 'stopped':
            # The operator wants this board stopped. Once it is, nothing will
            # be signalled or restarted, so the record has nothing left to guard.
            try:
                observed = self.adapter.observe(project)
            except Exception:
                observed = {}
            if observed.get('stopped') and observed.get('childrenStopped'):
                self.retire_receipt(project, receipt, state, 'Retired ' + ('a health latch' if health_latched(state) else 'an attention record')
                                    + ': the board is stopped as desired, so nothing is restarted.')
                return None
            if health_latched(state) and not observed.get('stopped') and observed.get('identity'):
                # A latch only prevents restarts. Stopping the unhealthy dispatcher is what the operator asked for.
                self.retire_receipt(project, receipt, state, 'Retired a health latch to stop the board as desired.')
                return None
        if state.get('reason') in UNCERTAIN_SIGNAL_REASONS and state.get('identity'):
            # Waiting for the signalled process to exit replaces inspection. It
            # sends nothing: if the signal never arrived, the six-hour limit
            # reports it, counted from now.
            converted = {k: v for k, v in state.items() if k not in {'reason', 'attentionFrom'}}
            converted.update(phase='draining', signalUncertain=True, timerFrom=self.clock())
            atomic(receipt, converted)
            self.housekeeping.record('operation-retired', project, 'Unconfirmed stop signal record now waits for the dispatcher to exit. No second signal is sent.')
            return converted
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
        if state.get('intent') == 'stop':
            # A healthy dispatcher is exactly what a desired stop waits on, not a later start.
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

    def begin_drain(self, project, desired, observed, receipt, intent):
        """One graceful stop signal, for an update or for a desired stop.

        The record is written before the signal, so a crash never causes a
        second one."""
        if not observed.get('identity'):
            # A unit that is neither running nor stopped, such as a failed one, has no process to signal.
            return {'phase': 'attention', 'project': project, 'reason': 'Dispatcher service is neither running nor stopped. Nothing was signalled.'}
        helpers_active = getattr(self.adapter, 'helpers_active', lambda project: False)
        if helpers_active(project):
            state = {'phase': 'waiting-for-native-task', 'project': project, 'desired': desired, 'intent': intent, 'created': self.clock()}
            atomic(receipt, state)
            return state
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
                state = {'phase': 'waiting-for-native-task', 'project': project, 'desired': desired, 'intent': intent, 'created': self.clock()}
                atomic(receipt, state)
                return state
        state = {'phase': 'drain-requested', 'project': project, 'desired': desired, 'intent': intent,
                 'identity': observed['identity'], 'childGroups': observed.get('childGroups', []), 'created': self.clock(),
                 'claims': real_claims(before), 'policy': policy(before)}
        # Write BEFORE signalling. If the host dies here, the next pass waits
        # for the process to exit instead of signalling again.
        atomic(receipt, state)
        self.unhealthy_since.pop(project, None)
        try:
            self.adapter.drain(project, observed['identity'])
        except Exception as error:
            return self.signal_failed(project, receipt, state, error)
        self.signal_failures.pop(project, None)
        state['phase'] = 'draining'
        atomic(receipt, state)
        if intent == 'stop':
            self.notices[project].append('Stopping as desired once its running jobs finish.')
        return state

    def signal_failed(self, project, receipt, state, error):
        """Tell a signal that was never sent from one whose delivery is unknown."""
        try:
            after = self.adapter.observe(project)
        except Exception:
            after = None
        not_sent = getattr(error, 'signal_not_sent', False)
        if after is not None and after.get('stopped'):
            if not_sent:
                # It stopped before any signal of ours, so it may have been stopped
                # by hand. The next pass decides from the run state, as for any stopped board.
                receipt.unlink(missing_ok=True)
                return {'phase': 'stopped', 'project': project, 'reason': 'The dispatcher stopped before the stop signal was sent.'}
            # Gone, perhaps by our signal. Without an explicit run state it is not started again.
            state['phase'] = 'draining'
            state['signalUncertain'] = True
            atomic(receipt, state)
            return state
        if not_sent:
            # Nothing was signalled, so a later pass may try again, a bounded number of times.
            receipt.unlink(missing_ok=True)
            # Consecutive means within the hour: an unrelated failure days later starts again at one.
            count, last = self.signal_failures.get(project, (0, None))
            failures = (count if last is not None and self.clock() - last < 3600 else 0) + 1
            self.signal_failures[project] = (failures, self.clock())
            reason = 'Stop signal not sent: ' + redact_paths(str(error))[:200] + '. Nothing was signalled'
            if failures >= SIGNAL_RETRIES:
                self.signal_failures.pop(project, None)
                held = {**{k: v for k, v in state.items() if k != 'phase'}, 'phase': 'attention', 'attentionFrom': 'signal-failed',
                        'reason': reason + ' on ' + str(failures) + ' passes in a row. Inspect before retrying; archive this record to try again.'}
                atomic(receipt, held)
                return held
            return {'phase': 'signal-failed', 'project': project, 'reason': reason + '; the next pass tries again.'}
        state['phase'] = 'draining'
        state['signalUncertain'] = True
        atomic(receipt, state)
        self.notices[project].append(UNCONFIRMED_NOTE)
        return state

    def install_stopped(self, project, desired, observed):
        """A board stopped as desired gets the desired versions installed, not started."""
        result = {'phase': 'stopped', 'project': project, 'reason': 'Stopped as desired.'}
        installed = getattr(self.adapter, 'installed', None)
        if not installed or not observed.get('childrenStopped') or not isinstance(desired, dict):
            return result
        try:
            if installed(project) == {'consumer': desired.get('consumer'), 'dispatcher': desired.get('dispatcher')}:
                return result
            if not self.adapter.preflight(project, desired):
                result['reason'] += ' The new version waits: its update preflight does not pass.'
                return result
            self.adapter.update(project, desired)
            result['reason'] += ' Installed the desired versions; they load when it next starts.'
        except Exception as error:
            result['reason'] += ' The new version waits: ' + type(error).__name__ + '.'
        return result

    def start_stopped(self, project, desired, observed, receipt):
        """Start a stopped board the operator wants running, on the desired versions."""
        if not observed.get('childrenStopped'):
            return {'phase': 'stopped', 'project': project, 'reason': 'Waiting for the previous dispatcher\'s processes to exit before starting.'}
        before = self.adapter.status()
        if before.get('draining'):
            # A bare in-memory drain makes dispatchers exit; one started now would exit again.
            return {'phase': 'stopped', 'project': project, 'reason': 'Not starting: this computer\'s manager holds an in-memory drain, which makes dispatchers exit.'}
        if any(r['project'] == project and r['machine'] == before['machine'] and not r.get('supportTaskId') for r in before['runs']):
            # The same check as after an update drain. A new session never adopts these.
            return {'phase': 'stopped', 'project': project, 'reason': 'Not starting: a worker reservation of an earlier session remains. Check its worker, then free it.'}
        if not self.adapter.preflight(project, desired):
            return {'phase': 'preflight-failed', 'project': project}
        self.adapter.update(project, desired)
        state = {'phase': 'start-requested', 'project': project, 'desired': desired, 'intent': 'start', 'created': self.clock(),
                 'claims': real_claims(before), 'policy': policy(before)}
        # A crash after this write must not issue another start.
        atomic(receipt, state)
        try:
            self.adapter.start(project)
        except Exception:
            state['attentionFrom'] = 'start-requested'
            state['phase'] = 'attention'
            state['reason'] = 'Start delivery uncertain. Inspect before another start.'
            atomic(receipt, state)
            return state
        state['phase'] = 'verifying'
        atomic(receipt, state)
        return state

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
        run = self.desired_run(project)
        # Checked before the six-hour limit: a superseded record raises no alert.
        outcome = self.superseded(project, desired, state, observed) if state else None
        if outcome == 'attention':
            return state
        if outcome == 'retired':
            state = None
        if state and state['phase']=='waiting-for-native-task':
            if helpers_active(project): return state
            state=None
        if state and state['phase'] == 'complete' and run == 'stopped':
            # A deliberately stopped board is not a health failure. Its verified
            # record is archived once it is stopped; while it still runs, the
            # stop below replaces it.
            if observed.get('stopped'):
                self.retire_receipt(project, receipt, state, 'Retired the verified record: the board is stopped as desired.')
            state = None
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
            if observed.get('stopped'):
                self.unhealthy_since.pop(project, None)
                if run == 'running':
                    return self.start_stopped(project, desired, observed, receipt)
                if run == 'stopped':
                    return self.install_stopped(project, desired, observed)
                # Without a central run state, a service left stopped stays stopped.
                return {'phase': 'stopped', 'project': project}
            if run == 'stopped':
                return self.begin_drain(project, desired, observed, receipt, 'stop')
            if observed.get('generation') == desired and observed.get('healthy'):
                self.unhealthy_since.pop(project, None)
                return {'phase': 'current', 'project': project}
            if observed.get('generation') == desired:
                # A restart for health alone needs a confirmed, real failure.
                if observed.get('reportingGap'):
                    return {'phase': 'current', 'project': project, 'reason': 'Waiting for dispatcher reporting after a manager restart.'}
                if not self.unhealthy_confirmed(project):
                    return {'phase': 'current', 'project': project, 'reason': 'Health check failing. Confirming before any restart.'}
            if run == 'unknown':
                # Desired state may say stopped. Nothing is drained for an update until it is known.
                return {'phase': 'current', 'project': project, 'reason': 'Waiting for this computer\'s desired state before updating.'}
            if helpers_active(project):
                state={'phase':'waiting-for-native-task','project':project,'desired':desired,'created':self.clock()}
                atomic(receipt,state)
                return state
            if not self.adapter.preflight(project, desired):
                return {'phase': 'preflight-failed', 'project': project}
            return self.begin_drain(project, desired, observed, receipt, 'update')
        try:
            if state['phase'] == 'drain-requested':
                # The supervisor stopped between saving the record and the signal
                # acknowledgement. Wait for the process to exit; never signal twice.
                state['phase'] = 'draining'
                state['signalUncertain'] = True
                state['timerFrom'] = self.clock()
                atomic(receipt, state)
            if self.clock() - state.get('timerFrom', state['created']) > 6 * 3600:
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
                def waiting():
                    if state.get('signalUncertain'):
                        self.notices[project].append(UNCONFIRMED_NOTE)
                    if state.get('intent') == 'stop' or run == 'stopped':
                        self.notices[project].append('Stopping as desired once its running jobs finish.')
                    return state
                if helpers_active(project): return waiting()
                if not observed.get('stopped'):
                    groups = sorted(set(state.get('childGroups', []) + observed.get('childGroups', [])))
                    if groups != state.get('childGroups', []):
                        state['childGroups'] = groups; atomic(receipt, state)
                    return waiting()
                if not observed.get('childrenStopped'):
                    return waiting()
                if run == 'unknown':
                    self.notices[project].append('Stopped. Waiting for this computer\'s desired state before starting it again.')
                    return state
                if run == 'stopped' or (state.get('intent') == 'stop' and run != 'running'):
                    # Leave it stopped. A drain for an update still installs the
                    # new version, which loads when the board next starts.
                    result = self.install_stopped(project, desired, observed)
                    receipt.unlink(missing_ok=True)
                    return result
                if state.get('signalUncertain') and run != 'running':
                    raise RuntimeError(EXITED_UNCONFIRMED_REASON)
                before = self.adapter.status()
                if any(r['project'] == project and r['machine'] == before['machine'] and not r.get('supportTaskId') for r in before['runs']):
                    raise RuntimeError('Worker reservation remains. Ownership was preserved.')
                if policy(before) != state['policy'] and not self.recorded_policy_change(state, before):
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
                if policy(after) != state['policy'] and not self.recorded_policy_change(state, after):
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
