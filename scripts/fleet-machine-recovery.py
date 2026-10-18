"""Retry ordinary ticket stages elsewhere only after the local dispatcher drained.

Original directories are retained in place. The authority holds the entire
source project until an operator reconciles them. No source files, branches,
captures or logs are removed or rewritten. No process is signalled here.
"""
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path

ROLES = {'builder', 'developer', 'architect', 'refiner', 'po', 'verifier', 'code-review', 'qa', 'documentation'}


def run(args):
    return subprocess.check_output([str(a) for a in args], stderr=subprocess.DEVNULL, text=True, timeout=90)


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.new')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def worktrees(target, number, container_target=None):
    def host_path(value):
        if container_target:
            prefix = str(Path(container_target).parent) + '/'
            if value.startswith(prefix):
                return str(Path(target).parent / value[len(prefix):])
        return value

    found = []
    for block in run(['git', '-C', target, 'worktree', 'list', '--porcelain']).split('\n\n'):
        fields = dict(line.split(' ', 1) for line in block.splitlines() if ' ' in line)
        registered = fields.get('worktree')
        path = host_path(registered) if registered else None
        if not path:
            continue
        if fields.get('branch') == 'refs/heads/feature/' + number or re.search(r'-' + number + r'(?:-|$)', Path(path).name):
            # Readability matters. A missing or unreadable retained tree cannot
            # be declared preserved. Status contents remain local, never sent.
            # Container-created worktree .git files carry container paths.
            # Supply the mapped metadata path without changing either file.
            gitfile = Path(path) / '.git'
            metadata = gitfile.read_text().strip() if gitfile.is_file() else ''
            git = ['git', '-C', path]
            if metadata.startswith('gitdir: '):
                directory = metadata[len('gitdir: '):]
                git += ['--git-dir', host_path(directory), '--work-tree', path]
            status = run([*git, '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
            found.append({'path': path, 'head': run([*git, 'rev-parse', 'HEAD']).strip(),
                          'branch': fields.get('branch'), 'statusDigest': hashlib.sha256(status.encode()).hexdigest(),
                          'dirty': bool(status)})
    return found


def stopped_proof(adapter, config, project, trees):
    observed = adapter.observe(project)
    if observed.get('stopped') is not True or observed.get('childrenStopped') is not True:
        return None
    cfg = config['projects'][project]
    if config['platform'] == 'linux':
        # An inspect error is uncertainty, never a stopped container.
        fields = run(['podman', 'inspect', cfg['container'], '--format', '{{.State.Status}} {{.State.Pid}}']).split()
        return 'container-stopped' if len(fields) == 2 and fields[0] in {'exited', 'stopped', 'created', 'configured'} and fields[1] == '0' else None
    if config['platform'] != 'mac':
        return None
    # The stopped root alone is insufficient: detached agents can survive it.
    # Inspect all local process environments privately and check every retained
    # tree for open paths through the existing strict filesystem observer.
    roots = [cfg['agents'], cfg['target'], *[t['path'] for t in trees]]
    identity = adapter.identity_from_receipt(project)
    def birth(text):
        return time.mktime(time.strptime(text.strip(), '%a %b %d %H:%M:%S %Y')) * 1000
    try:
        started = birth(identity.get('start', ''))
        if not 0 < started <= time.time() * 1000:
            return None
        rows = run(['ps', 'eww', '-axo', 'uid=,pid=,command=']).splitlines()
        if not rows:
            return None
        patterns = [re.compile(re.escape(root) + r'(?=/|\s|$)') for root in roots]
        foreign = [re.compile(r'(?:^| )AGENTS_REPO_PATH=' + re.escape(other['agents']) + r'(?= |$)')
                   for name, other in config['projects'].items() if name != project and other.get('agents')]
        for row in rows:
            fields = row.strip().split(None, 2)
            if len(fields) < 3 or not fields[0].isdigit() or not fields[1].isdigit():
                return None
            if int(fields[0]) != os.getuid() or not any(p.search(fields[2]) for p in patterns):
                continue
            # Only processes born with this dispatcher can be its children.
            # Other configured projects can carry shared dependency paths.
            if birth(run(['ps', '-p', fields[1], '-o', 'lstart='])) < started:
                continue
            if any(p.search(fields[2]) for p in foreign):
                continue
            return None
    except (ValueError, TypeError, OverflowError, subprocess.SubprocessError):
        return None
    check = Path(config['stateDirectory']) / 'machine-recovery' / 'paths.json'
    atomic(check, {'paths': roots, 'dispatcherStarted': started})
    answer = json.loads(run(adapter.operator_command('machine-recovery', 'inspect-paths', str(check))))
    return 'native-stopped' if answer == {'stopped': True} else None


def tick(adapter, config, status, housekeeping=None):
    items = []
    machine = status.get('machine')
    desired = status.get('desiredState') or {}
    if desired.get('known') is not True or status.get('draining'):
        return items
    # Reconcile an accepted release whose local acknowledgement could not be
    # written, including after a restart when the original run is absent.
    accepted = None
    for receipt in (Path(config['stateDirectory']) / 'machine-recovery').glob('stopped-*.json'):
        if receipt.name.endswith('.request.json'):
            continue
        try:
            saved = json.loads(receipt.read_text())
            if saved.get('request') and not saved.get('released'):
                if accepted is None:
                    accepted = json.loads(run(adapter.operator_command('machine-recovery', 'read')))
                match = next((r for r in accepted if r.get('commandId') == saved['request']['commandId']), None)
                if match:
                    saved['released'] = match
                    atomic(receipt, saved)
        except Exception:
            return [{'kind': 'error', 'subject': 'machine-recovery', 'action': 'attention', 'reason': 'Awaiting recovery acknowledgement reconciliation. Original files and reservations remain protected.'}]
    for worker in status.get('runs', []):
        project = worker.get('project')
        if worker.get('machine') != machine or worker.get('role') not in ROLES or worker.get('supportTaskId'):
            continue
        policy = desired.get('projects', {}).get(project, {})
        if policy.get('run') != 'running' or policy.get('effectiveWork', policy.get('work')) != 'taking':
            continue
        if project not in config.get('projects', {}) or not re.fullmatch(r'[\w.-]+/[\w.-]+#[1-9]\d*', worker.get('ticket', '')):
            continue
        identity = 'stopped-' + hashlib.sha256(worker['id'].encode()).hexdigest()
        receipt = Path(config['stateDirectory']) / 'machine-recovery' / (identity + '.json')
        try:
            cfg = config['projects'][project]
            # Avoid worktree and process scans for live dispatchers.
            observed = adapter.observe(project)
            if observed.get('stopped') is not True or observed.get('childrenStopped') is not True:
                continue
            if receipt.exists():
                saved = json.loads(receipt.read_text())
                if saved.get('released'):
                    continue
            else:
                trees = worktrees(cfg['target'], worker['ticket'].rsplit('#', 1)[1], cfg.get('containerTarget'))
                if not Path(cfg['agents'], 'logs').is_dir():
                    raise RuntimeError('Retained worker logs are unavailable')
                saved = {'worker': worker, 'worktrees': trees, 'logs': str(Path(cfg['agents']) / 'logs'),
                         'target': cfg['target'], 'retainedInPlace': True}
                atomic(receipt, saved)
            proof = stopped_proof(adapter, config, project, saved['worktrees'])
            if not proof:
                continue
            # Fetch fresh authoritative workflow before forming the exact request.
            # A request already sent is retried byte-for-byte after lost replies.
            if not saved.get('released'):
                workflow = json.loads(run(adapter.operator_command('workflow', 'read', project)))
                values = workflow.get('items', []) if isinstance(workflow, dict) else workflow
                item = next((i for i in values if i.get('issueNumber') == int(worker['ticket'].rsplit('#', 1)[1])), None)
                if not item:
                    raise RuntimeError('Authoritative ticket snapshot is unavailable')
                digest = saved.get('request', {}).get('retainedDigest') or hashlib.sha256(json.dumps(saved, sort_keys=True).encode()).hexdigest()
                saved['request'] = {'commandId': identity, 'machine': machine, 'runId': worker['id'],
                                    'session': worker['session'], 'generation': worker['generation'],
                                    'revision': item['revision'], 'proof': proof, 'retainedDigest': digest}
                atomic(receipt, saved)
            request = receipt.with_suffix('.request.json')
            atomic(request, saved['request'])
            result = json.loads(run(adapter.operator_command('machine-recovery', 'release', str(request))))
            if result.get('commandId') != identity or result.get('runId') != worker['id']:
                raise RuntimeError('Authority did not confirm this exact recovery')
            saved['released'] = result
            atomic(receipt, saved)
            reason = 'Stopped dispatcher and child processes confirmed. Original files retained. Another capable computer may retry the stage. Source project held for inspection.'
            if housekeeping:
                housekeeping('machine-worker-recovered', worker['ticket'], reason)
            items.append({'kind': 'released', 'subject': worker['id'], 'ticket': worker['ticket'], 'action': 'released', 'reason': reason})
        except Exception as error:
            # Never publish arbitrary command output or process environments.
            items.append({'kind': 'error', 'subject': worker.get('id', ''), 'ticket': worker['ticket'], 'action': 'attention',
                          'reason': 'Stopped-worker recovery awaits confirmed process proof, retained work and current authority. ' + type(error).__name__})
    return items
