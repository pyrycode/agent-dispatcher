"""Trusted local adapters for configured Mac launchers and Linux container services."""
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

SAFE_ENV = {'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SHELL', 'PATH', 'JAVA_HOME', 'ANDROID_HOME'}

def execute(args, **kwargs):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=90, **kwargs)
    if result.returncode:
        raise RuntimeError('Configured workload command failed with exit ' + str(result.returncode))
    return result.stdout.strip()

def lock(path):
    return dict(line.split('=', 1) for line in Path(path).read_text().splitlines())

def process_env(pid):
    if sys.platform == 'darwin':
        raw = execute(['ps', 'eww', '-p', str(pid), '-o', 'command='])
        matches = list(re.finditer(r'(?:^| )([A-Za-z_][A-Za-z0-9_]*)=', raw))
        return {m.group(1): raw[m.end(): matches[i+1].start() if i+1 < len(matches) else len(raw)]
                for i, m in enumerate(matches)}
    return dict(item.split('=', 1) for item in (Path('/proc') / str(pid) / 'environ').read_bytes().decode().split('\0') if '=' in item)

def credential_tag(value, salt):
    return hmac.new(salt.encode(), value.encode(), hashlib.sha256).hexdigest()

def credential_probe(env, salt, project):
    if env.get('GH_TOKEN') and env.get('GITHUB_TOKEN') and env['GH_TOKEN'] != env['GITHUB_TOKEN']:
        return {'ok': False}
    token = env.get('GH_TOKEN') or env.get('GITHUB_TOKEN')
    if not token or token.startswith('op://'):
        return {'ok': False}
    try:
        def request(path):
            req = urllib.request.Request('https://api.github.com' + path, headers={'Authorization': 'Bearer ' + token,
                                        'Accept': 'application/vnd.github+json'})
            with urllib.request.urlopen(req, timeout=20) as response:
                return response.headers, json.load(response)
        headers, user = request('/user')
        scopes = set(s.strip() for s in headers.get('x-oauth-scopes', '').split(','))
        _, repo = request('/repos/' + project)
        return {'ok': {'repo', 'project', 'read:org'}.issubset(scopes) and repo.get('permissions', {}).get('push') is True,
                'credential': credential_tag(token, salt)}
    except Exception:
        return {'ok': False}

def reporting_gap(state, reporting, seconds, now=time.time):
    """A manager that restarted recently has not yet heard from its dispatchers."""
    started = state.get('managerStartedAt')
    return (reporting.get('health') == 'not-registered' and isinstance(started, (int, float))
            and now() * 1000 - started < seconds * 1000)

class NativeAdapter:
    def __init__(self, config):
        self.config = config
        directory = Path(config['stateDirectory'])
        salt = directory / 'credential-salt'
        if not salt.exists():
            with salt.open('x') as stream:
                os.chmod(salt, 0o600); stream.write(secrets.token_hex(32))
        self.salt = salt.read_text()
        self.loaded_control_revision = execute(['git','-C',config['control']['repository'],'rev-parse','HEAD']) if config.get('control') else None
        self.local = {}
        self.expected_cache = {}

    def operator_command(self, *arguments):
        # Configured commands run with the supervisor's own startup credentials.
        # No credential values are persisted, printed or borrowed from another process.
        if 'operatorCommand' not in self.config:
            return [self.config['operator'], *arguments]
        return [*self.config['operatorCommand'], arguments[0], self.config['operatorConfig'], *arguments[1:]]

    def operator(self, command):
        return json.loads(execute(self.operator_command(command)))

    def status(self): return self.operator('status')
    def attention(self): return self.operator('attention')
    def publish_attention(self): execute(self.operator_command('report-attention', self.config['reportFile']))

    def expected(self, project, refresh=False):
        now = time.monotonic()
        cached = self.expected_cache.get(project)
        if cached:
            failed = isinstance(cached[1], Exception) or not cached[1].get('ok')
            if failed and now - cached[0] < self.config.get('credentialRetrySeconds', 3600):
                if isinstance(cached[1], Exception):
                    raise RuntimeError('Configured credential lookup is waiting before retrying')
                return cached[1]
            if not failed and not refresh:
                return cached[1]
        try:
            value = self.read_expected(project)
        except Exception:
            self.expected_cache[project] = (now, RuntimeError('Configured credential lookup unavailable'))
            raise
        self.expected_cache[project] = (now, value)
        return value

    def refresh_credentials(self):
        """An operator can request a new lookup after changing a credential."""
        self.expected_cache.clear()

    def read_expected(self, project):
        cfg = self.config['projects'][project]
        if self.config['platform'] == 'mac':
            child = [cfg['access'], 'op', 'run', '--env-file=' + cfg['agents'] + '/.env']
            if cfg.get('githubOnlyProbe'):
                child.append('--only-vars=GITHUB_TOKEN')
            child += ['--', self.config['python'], str(Path(__file__).resolve()), 'probe']
            env = {k: v for k, v in os.environ.items() if k in SAFE_ENV}
            env['PYRY_AUTOMATION_ACCESS'] = cfg['access']
            return json.loads(execute(child, env=env, input=json.dumps({'salt': self.salt, 'project': project})))
        # Canonical protected container secret, not an agent settings file or a running process.
        values = json.loads(execute(['podman', 'secret', 'inspect', '--showsecret', cfg['githubSecret']]))
        token = values[0].get('SecretData') if len(values) == 1 else None
        return credential_probe({'GITHUB_TOKEN': token} if isinstance(token, str) else {}, self.salt, project)

    def desired(self):
        revisions = self.operator('desired')
        result = {}
        for project in self.config['projects']:
            try:
                expected = self.expected(project)
            except Exception:
                continue
            if expected.get('ok') and project in revisions:
                desired = {**revisions[project], 'credential': expected['credential']}
                result[project] = desired
                self.local[project] = desired
        return result

    def container_probe(self, project):
        cfg = self.config['projects'][project]
        # Only configured container destinations. Code executes inside its process namespace.
        payload = Path(__file__).read_text()
        payload = payload[:payload.rindex("\nif __name__ == '__main__':")]
        payload += '\n' + '''cfg = json.loads(sys.stdin.readline())
f = lock(cfg['lock']); pid = int(f['PID'])
assert f['AGENTS_REPO_PATH'] == cfg['agents']
assert b'src/dispatch-bin.ts' in (Path('/proc')/str(pid)/'cmdline').read_bytes().split(b'\\0')
env = process_env(pid)
assert env.get('AGENTS_REPO_PATH') == cfg['agents']
receipt = json.loads((Path(cfg['agents']) / 'logs/runtime.json').read_text()) if (Path(cfg['agents']) / 'logs/runtime.json').exists() else {}
if receipt.get('pid') != pid: receipt = {}
healthpath = Path(cfg['agents']) / 'logs/runtime-health.json'
health = json.loads(healthpath.read_text()) if healthpath.exists() else {}
if health.get('pid') != pid: health = {}
print(json.dumps({'startupHealthy': health.get('passed'), 'runtime': receipt, 'pid': pid, 'start': (Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()[19], **credential_probe(env,cfg['salt'],cfg['project'])}))
'''
        # Script and configuration travel through stdin. Credentials remain inside the container.
        import base64
        source = base64.b64encode(payload.encode()).decode()
        command = ["python3", "-c", "import base64;exec(base64.b64decode('" + source + "'))"]
        return json.loads(execute(['podman', 'exec', '-i', cfg['container'], *command], input=json.dumps({
            'lock': cfg['containerTarget'] + '/.dispatcher.lock', 'agents': cfg['containerAgents'],
            'salt': self.salt, 'project': project}) + '\n'))

    def observe(self, project):
        cfg = self.config['projects'][project]
        if self.config['platform'] == 'linux':
            service = subprocess.run(['systemctl', '--user', 'is-active', cfg['service']], capture_output=True, text=True).stdout.strip()
            running = subprocess.run(['podman', 'inspect', cfg['container'], '--format', '{{.State.Running}}'], capture_output=True, text=True)
            if service != 'active':
                return {'stopped': service == 'inactive', 'childrenStopped': running.returncode != 0 or running.stdout.strip() == 'false'}
            probe = self.container_probe(project)
            container_id = execute(['podman', 'inspect', cfg['container'], '--format', '{{.Id}}'])
            identity = {'container': container_id, 'pid': probe['pid'], 'start': probe['start']}
        else:
            try:
                fields = lock(Path(cfg['target']) / '.dispatcher.lock'); pid = int(fields['PID'])
                os.kill(pid, 0)
            except (FileNotFoundError, ProcessLookupError):
                # A process group can survive its dispatcher. Retain evidence until every child exits.
                saved = self.identity_from_receipt(project)
                group = saved.get('pid')
                groups = execute(['ps', '-axo', 'pgid=']).split()
                receipt = Path(self.config['stateDirectory']) / (project.replace('/', '_') + '.json')
                previous = json.loads(receipt.read_text()) if receipt.exists() else {}
                known = [group, *previous.get('childGroups', [])]
                return {'stopped': True, 'childrenStopped': not any(str(g) in groups for g in known if g)}
            env = process_env(pid)
            if env.get('AGENTS_REPO_PATH') != cfg['agents'] or fields.get('AGENTS_REPO_PATH') != cfg['agents']:
                raise RuntimeError('Dispatcher workload identity changed')
            args = execute(['ps', '-p', str(pid), '-o', 'command='])
            if 'src/dispatch-bin.ts' not in args or execute(['ps', '-p', str(pid), '-o', 'pgid=']) != str(pid):
                raise RuntimeError('Dispatcher process identity changed')
            identity = {'pid': pid, 'start': execute(['ps', '-p', str(pid), '-o', 'lstart='])}
            probe = credential_probe(env, self.salt, project)
        if self.config['platform'] == 'linux':
            runtime = probe.get('runtime', {})
            startup_healthy = probe.get('startupHealthy')
        else:
            receipt = Path(cfg['agents']) / 'logs/runtime.json'
            runtime = json.loads(receipt.read_text()) if receipt.exists() else {}
            if runtime.get('pid') != identity['pid']: runtime = {}
            healthpath = Path(cfg['agents']) / 'logs/runtime-health.json'
            health = json.loads(healthpath.read_text()) if healthpath.exists() else {}
            startup_healthy = health.get('pid') == identity['pid'] and health.get('passed') is True
        consumer = runtime.get('consumer')
        dispatcher = runtime.get('dispatcher')
        groups = []
        if self.config['platform'] == 'mac':
            rows = [tuple(map(int, row.split())) for row in execute(['ps', '-axo', 'pid=,ppid=,pgid=']).splitlines() if len(row.split()) == 3]
            children = {identity['pid']}
            while True:
                next_children = children | {pid for pid, parent, _ in rows if parent in children}
                if next_children == children: break
                children = next_children
            groups = sorted({group for pid, _, group in rows if pid in children})
        state = self.status()
        reporting = next((p for p in state['projects'] if p['project'] == project), {})
        return {'identity': identity, 'childGroups': groups, 'stopped': False, 'childrenStopped': False,
                'healthy': probe.get('ok') and reporting.get('health') == 'reporting' and startup_healthy,
                'reportingGap': reporting_gap(state, reporting, self.config.get('reportingGapSeconds', 300)),
                'generation': {'consumer': consumer, 'dispatcher': dispatcher, 'credential': probe.get('credential')}}

    def identity_from_receipt(self, project):
        path = Path(self.config['stateDirectory']) / (project.replace('/', '_') + '.json')
        return json.loads(path.read_text()).get('identity', {}) if path.exists() else {}

    def helpers_active(self, project):
        if self.config['platform'] != 'linux': return False
        container=self.config['projects'][project]['container']
        state=self.status()
        for run in state['runs']:
            if run['machine']!=state['machine'] or not run.get('supportTaskId'): continue
            tasks=Path(self.config['stateDirectory'])/'tasks'
            receipt=tasks/(run['supportTaskId']+'.receipt.json')
            if not receipt.is_file():
                # A grant the native task pass deferred was never launched, and
                # is not launched while its container's operation is open.
                deferred=tasks/(run['supportTaskId']+'.deferred.json')
                try:saved=json.loads(deferred.read_text()) if deferred.is_file() else None
                except ValueError:saved=None
                if isinstance(saved,dict) and saved.get('session')==run.get('session') and saved.get('runId')==run.get('id'):continue
                # Admission can precede its saved launch receipt. Unknown placement
                # cannot authorise stopping a container that might own the worker.
                return True
            saved=json.loads(receipt.read_text())
            if 'container' not in saved or saved['container']==container: return True
        return False

    def preflight(self, project, desired):
        cfg = self.config['projects'][project]
        expected = self.expected(project, refresh=True)
        if not expected.get('ok') or expected.get('credential') != desired['credential']: return False
        for repo in [cfg['agents'], str(Path(cfg['agents']) / 'dispatcher')]:
            if execute(['git', '-C', repo, 'status', '--porcelain', '--untracked-files=no']): return False
        return execute(['git', '-C', cfg['agents'], 'branch', '--show-current']) == 'main'

    def drain(self, project, identity):
        if self.observe(project).get('identity') != identity:
            raise RuntimeError('Dispatcher changed before signalling')
        cfg = self.config['projects'][project]
        if self.config['platform'] == 'linux':
            self.retain_publish_files(project)
            execute(['podman', 'exec', cfg['container'], 'kill', '-TERM', str(identity['pid'])])
        else: os.kill(identity['pid'], signal.SIGTERM)

    def update(self, project, desired):
        cfg = self.config['projects'][project]
        if not self.preflight(project, desired): raise RuntimeError('Update preflight no longer passes')
        # Fast-forward to exactly the queued consumer revision. Pulling main
        # could land on a newer revision than the target when main moves
        # before the desired versions are refreshed.
        execute(['git', '-C', cfg['agents'], 'fetch', '--quiet'])
        execute(['git', '-C', cfg['agents'], 'merge', '--ff-only', '--quiet', desired['consumer']])
        if execute(['git', '-C', cfg['agents'], 'rev-parse', 'HEAD']) != desired['consumer']:
            raise RuntimeError('Consumer checkout does not match the queued update')
        execute(['git', '-C', cfg['agents'], 'submodule', 'update', '--init', 'dispatcher'])
        if execute(['git', '-C', Path(cfg['agents']) / 'dispatcher', 'rev-parse', 'HEAD']) != desired['dispatcher']:
            raise RuntimeError('Dispatcher pin does not match the queued update')

    def retain_publish_files(self, project):
        cfg = self.config['projects'][project]
        if self.config['platform'] != 'linux' or not cfg.get('publishStorage'): return
        # Mounted handoffs are already durable. Never copy over a writer's live
        # file. Legacy installations get a private backup before their first drain.
        if self.publish_mounted(project):return
        destination=Path(cfg['publishStorage']).resolve()
        backup=Path(tempfile.mkdtemp(prefix='publish-before-restart-',dir=self.config['stateDirectory']))
        snapshot=backup/'container';snapshot.mkdir(mode=0o700)
        execute(['podman','cp',cfg['container']+':/Users/juhanailmoniemi/.codex/publish/.',snapshot])
        destination.mkdir(parents=True,exist_ok=True,mode=0o700)
        for source in snapshot.rglob('*'):
            relative=source.relative_to(snapshot);target=destination/relative
            if source.is_symlink() or target.is_symlink() or any(p.is_symlink() for p in target.parents):
                raise RuntimeError('Publish storage contains a symbolic link; snapshot retained for inspection')
            if source.is_dir():target.mkdir(parents=True,exist_ok=True,mode=0o700);continue
            if not source.is_file():raise RuntimeError('Publish storage contains a non-regular file')
            target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            if target.is_file() and target.read_bytes()!=source.read_bytes():
                saved=backup/'previous'/relative;saved.parent.mkdir(parents=True,exist_ok=True,mode=0o700);shutil.copy2(target,saved)
            shutil.copy2(source,target);target.chmod(0o600)

    def publish_mounted(self,project):
        cfg=self.config['projects'][project]
        mounts=json.loads(execute(['podman','inspect',cfg['container'],'--format','{{json .Mounts}}']))
        return any(m.get('Destination')=='/Users/juhanailmoniemi/.codex/publish'
                   and Path(m.get('Source','')).resolve()==Path(cfg['publishStorage']).resolve() for m in mounts)

    def start(self, project):
        cfg = self.config['projects'][project]
        if self.config['platform'] == 'linux': execute(['systemctl', '--user', 'start', cfg['service']])
        else:
            env = {k: v for k, v in os.environ.items() if k in SAFE_ENV}
            # launchd's service PATH omits per-user CLI installations.
            user_bin = str(Path.home() / '.local' / 'bin')
            paths = env.get('PATH', os.defpath).split(os.pathsep)
            if user_bin not in paths:
                paths.append(user_bin)
            env['PATH'] = os.pathsep.join(paths)
            env.update(PYRY_AUTOMATION_ACCESS=cfg['access'], PYRY_SKIP_QMD_REFRESH='1', PYRY_SUPERVISED='1')
            with (Path(self.config['stateDirectory']) / (project.replace('/', '_') + '.startup.log')).open('ab') as output:
                subprocess.Popen([str(Path(cfg['agents']) / 'bin/pyry-start'), '--managed', '--runner', cfg.get('runner', 'codex')],
                                 cwd=cfg['agents'], env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)

    def verify(self, project, desired):
        observed = self.observe(project)
        return observed.get('generation') == desired and observed.get('healthy') is True and (
            self.config['platform']!='linux' or not self.config['projects'][project].get('publishStorage') or self.publish_mounted(project))

if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] != 'probe': raise SystemExit('Credential probe only')
    request = json.loads(sys.stdin.read())
    print(json.dumps(credential_probe(os.environ, request['salt'], request['project'])))
