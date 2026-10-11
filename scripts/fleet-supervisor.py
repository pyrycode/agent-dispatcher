#!/usr/bin/env python3
"""Local operator service. Fixed configured workload adapters, never model-authored commands."""
import argparse
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
import secrets
import subprocess
import time
from pathlib import Path

TERMINAL = {'complete', 'attention'}

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

class Supervisor:
    """A restart survives this supervisor crashing. An uncertain signal is never repeated."""
    def __init__(self, directory, adapter, clock=time.time):
        self.directory = Path(directory)
        self.adapter = adapter
        self.clock = clock

    def tick(self, project, desired):
        receipt = self.directory / (project.replace('/', '_') + '.json')
        state = json.loads(receipt.read_text()) if receipt.exists() else None
        if state and state['phase'] == 'attention':
            return state
        observed = self.adapter.observe(project)
        if state and state['phase'] == 'complete':
            if observed.get('generation') == desired and observed.get('healthy'):
                return state
            if state['desired'] == desired and self.clock() - state['verified'] < 24 * 3600:
                state['phase'] = 'attention'
                state['reason'] = 'Health failed again after a verified restart. No repeat restart within twenty-four hours.'
                atomic(receipt, state)
                return state
            state = None
        if not state:
            # A service intentionally left stopped stays stopped.
            if observed.get('stopped'):
                return {'phase': 'stopped', 'project': project}
            if observed.get('generation') == desired and observed.get('healthy'):
                return {'phase': 'current', 'project': project}
            if not self.adapter.preflight(project, desired):
                return {'phase': 'preflight-failed', 'project': project}
            before = self.adapter.status()
            current = self.adapter.observe(project)
            if current.get('identity') != observed.get('identity'):
                return {'phase': 'changed-before-drain', 'project': project}
            state = {'phase': 'drain-requested', 'project': project, 'desired': desired,
                     'identity': observed['identity'], 'childGroups': observed.get('childGroups', []), 'created': self.clock(),
                     'claims': real_claims(before), 'policy': policy(before)}
            # Write BEFORE signalling. If the host dies here, inspection replaces a second signal.
            atomic(receipt, state)
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
                raise RuntimeError('Operation exceeded six hours. No forced stop or second signal sent.')
            if state['desired'] != desired:
                # Finish exactly the pinned operation. New revisions wait for its verified completion.
                desired = state['desired']
            if state['phase'] == 'draining':
                if not observed.get('stopped'):
                    groups = sorted(set(state.get('childGroups', []) + observed.get('childGroups', [])))
                    if groups != state.get('childGroups', []):
                        state['childGroups'] = groups; atomic(receipt, state)
                    return state
                if not observed.get('childrenStopped'):
                    return state
                before = self.adapter.status()
                if any(r['project'] == project and r['machine'] == before['machine'] for r in before['runs']):
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
                if not self.adapter.verify(project, desired):
                    return state
                after = self.adapter.status()
                current = real_claims(after)
                if any(current.get(ticket) != owner for ticket, owner in state['claims'].items()):
                    raise RuntimeError('Existing ticket ownership changed. Inspect the retained comparison.')
                if policy(after) != state['policy']:
                    raise RuntimeError('Operator drain policy changed during verification.')
                state['phase'] = 'complete'
                state['verified'] = self.clock()
                atomic(receipt, state)
        except Exception as error:
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
        supervisor = Supervisor(state, adapter)
        while True:
            results = []
            try:
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
                attention = adapter.attention()
                attention['operations'] = results
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
