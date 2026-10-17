import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('support_mobile', Path(__file__).with_name('fleet-support.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SHA = 'a' * 40


class MobileCaptureTests(unittest.TestCase):
    def native_supervisor(self, directory, capability='mobile-android'):
        class Adapter:
            def status(self): return {'machine': 'fixture', 'draining': False}
        recipe = 'mobile-in-depth' if capability == 'mobile-android' else 'android-tool-then-text'
        route = {'capability': capability, 'container': 'android', 'directory': directory,
                 'containerDirectory': '/tasks', 'paths': {}}
        supervisor = m.SupportSupervisor(Adapter(), {'stateDirectory': directory, 'projects': {},
            'recoveryTasks': {recipe + ':' + capability: route}})
        grant = {'task': {'id': 'a' * 64, 'ticket': 'pyrycode/pyrycode-mobile#2179',
                         'request': {'recipe': recipe, 'capability': capability}},
                 'run': {'id': 'run', 'session': 'session'}}
        supervisor.rpc = lambda operation, body: [grant] if operation == 'schedule' else {}
        return supervisor, grant

    def test_android_service_is_prepared_before_task_custody_for_both_routes(self):
        for capability in ['mobile-android', 'android-emulator']:
            with self.subTest(capability=capability), tempfile.TemporaryDirectory() as d:
                supervisor, _ = self.native_supervisor(d, capability)
                events = []
                def prepare(argv, **kwargs):
                    events.append('service')
                    self.assertEqual(argv[:4], ['podman', 'exec', 'android', 'python3'])
                    self.assertIn('ANDROID_HOME', argv[-1])
                    self.assertIn('platform-tools', argv[-1])
                    self.assertIn('start-server', argv[-1])
                    self.assertLessEqual(kwargs['timeout'], 60)
                    return subprocess.CompletedProcess(argv, 0)
                class Child:
                    pid = 123
                def launch(*args, **kwargs):
                    events.append('task')
                    return Child()
                with patch.object(supervisor, 'route_ready', return_value=True), \
                     patch.object(m.subprocess, 'run', side_effect=prepare), \
                     patch.object(m.subprocess, 'Popen', side_effect=launch), \
                     patch.object(m, 'process_snapshot', return_value={}):
                    supervisor.tick()
                self.assertEqual(events, ['service', 'task'])

    def test_android_service_failure_finishes_without_launch_or_retained_capacity(self):
        for failure in [OSError('unavailable'), subprocess.TimeoutExpired('adb', 45),
                        subprocess.CalledProcessError(1, 'adb')]:
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as d:
                supervisor, grant = self.native_supervisor(d)
                with patch.object(supervisor, 'route_ready', return_value=True), \
                     patch.object(m.subprocess, 'run', side_effect=failure), \
                     patch.object(m.subprocess, 'Popen') as launch:
                    supervisor.tick()
                    receipt = supervisor.directory / (grant['task']['id'] + '.receipt.json')
                    saved = json.loads(receipt.read_text())
                    result = json.loads(Path(saved['result']).read_text())
                    self.assertTrue(saved['drainConfirmed'])
                    self.assertNotIn('pid', saved)
                    self.assertEqual(result['outcome'], 'failed')
                    self.assertIn('No task worker was started', result['summary'])
                    with patch.object(supervisor, 'return_artifacts', return_value='digest') as upload:
                        supervisor.tick()
                    upload.assert_called_once()
                    self.assertEqual(json.loads(receipt.read_text())['phase'], 'complete')
                    launch.assert_not_called()

    @unittest.skipUnless(m.process_snapshot() is not None, 'Requires native process census')
    def test_shared_android_service_survives_a_drained_task_without_becoming_its_descendant(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            adb = directory / 'sdk/platform-tools/adb'
            adb.parent.mkdir(parents=True)
            pid_file = directory / 'server.pid'
            adb.write_text('#!' + sys.executable + '\nimport pathlib,subprocess,sys\n'
                'child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"],'
                'stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\n'
                'pathlib.Path(' + repr(str(pid_file)) + ').write_text(str(child.pid))\n')
            adb.chmod(0o700)
            try:
                with patch.dict(os.environ, {'ANDROID_HOME': str(directory / 'sdk')}):
                    m.prepare_android_service({'capability': 'mobile-android'}, directory / 'service.log')
                pid = int(pid_file.read_text())
                log = directory / 'execution.log'
                self.assertEqual(m.execute([sys.executable, '-c', 'print("test completed")'], directory, log), 0)
                self.assertEqual(m.directory_custody(directory), 'drained')
                os.kill(pid, 0)
                journal = json.loads(m.custody_file(log).read_text())
                self.assertTrue(all(str(pid) not in record['owned'] for record in journal['commands']))
            finally:
                if pid_file.exists():
                    try: os.kill(int(pid_file.read_text()), signal.SIGTERM)
                    except ProcessLookupError: pass

    def test_mobile_route_waits_for_both_mounted_runner_updates(self):
        with tempfile.TemporaryDirectory() as d:
            route={'capability':'mobile-android','container':'native'}
            supervisor=m.SupportSupervisor(object(),{'stateDirectory':d,'projects':{},'recoveryTasks':{}})
            for project in ['pyrycode_pyrycode','pyrycode_pyrycode-mobile']:
                receipt=Path(d,project+'.json')
                receipt.write_text(json.dumps({'phase':'draining'}))
                with patch.object(m,'route_available',return_value=True):
                    self.assertFalse(supervisor.route_ready(route))
                receipt.write_text(json.dumps({'phase':'complete'}))
            with patch.object(m,'route_available',return_value=True):
                self.assertTrue(supervisor.route_ready(route))

    def run_capture(self, recipe, report=None, code=0):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        calls = []
        def clone(source, destination, revision=None, repository=None, deadline=None):
            calls.append(('clone', source, revision, repository))
            destination.mkdir()
        def execute(argv, cwd, log, env=None, timeout=3600):
            calls.append(('execute', argv, env, timeout))
            if 'rev-parse' in argv:
                with log.open('a') as output: output.write(SHA + '\n')
                return 0
            log.write_text('retained setup and execution diagnostic\n')
            output = env.get('PYRY_MOBILE_CAPTURE_STDOUT') if env else None
            if output:
                Path(output).write_text(report if report is not None else '<testsuite tests="1"><testcase classname="C" name="passes"/></testsuite>')
            return code
        paths = {'core': 'core', 'mobile': 'mobile', 'mobileAgents': 'agents', 'relay': 'relay'}
        with patch.object(m, 'clone', side_effect=clone), patch.object(m, 'execute', side_effect=execute):
            result = m.native_recipe({'ticket': 'pyrycode/pyrycode-mobile#2169', 'request': {
                'recipe': recipe, 'capability': 'mobile-android', 'revision': SHA}}, paths, directory)
        return result, calls

    def test_scripted_capture_uses_mobile_candidate_and_fixed_named_scenarios(self):
        result, calls = self.run_capture('mobile-scripted-evidence')
        self.assertEqual(calls[0], ('clone', 'mobile', SHA, 'pyrycode/pyrycode-mobile'))
        commands = [c[1] for c in calls if c[0] == 'execute' and 'scripted' in c[1]]
        self.assertEqual([c[-1] for c in commands], ['reply-suggestion', 'selection-copy'])
        self.assertEqual(result['outcome'], 'completed')
        self.assertEqual(result['candidateRevision'], SHA)
        self.assertIn('mobile/capture.json', result['files'])

    def test_in_depth_profile_is_fixed_and_bounded_including_preparation(self):
        result, calls = self.run_capture('mobile-in-depth')
        runs = [c for c in calls if c[0] == 'execute' and c[1][-1] == 'ui']
        self.assertEqual(len(runs), 1)
        self.assertEqual({k: runs[0][2][k] for k in ['UI_GATE_FULL', 'UI_DEVICE_ALL', 'UI_SHARDS']},
                         {'UI_GATE_FULL': '1', 'UI_DEVICE_ALL': '1', 'UI_SHARDS': '2'})
        self.assertLessEqual(runs[0][3], 1800)
        self.assertEqual(result['outcome'], 'completed')

    def test_zero_partial_failed_and_skipped_reports_cannot_pass(self):
        for report in ['<testsuite', '<testsuite tests="1" failures="1"><testcase classname="C" name="x"/></testsuite>',
                       '<testsuite tests="0"/>', '<testsuite tests="2"><testcase classname="C" name="x"/></testsuite>',
                       '<testsuite tests="1"><testcase classname="C" name="x"><skipped/></testcase></testsuite>',
                       '<testsuite tests="1"><testcase classname="C" name="x"><failure/></testcase></testsuite>']:
            with self.subTest(report=report):
                result, _ = self.run_capture('mobile-in-depth', report)
                self.assertEqual(result['outcome'], 'failed')
                self.assertIn('mobile/capture.json', result['files'])
                self.assertIn('mobile/execution.log', result['files'])

    def test_foreign_ticket_refuses_before_checkout(self):
        with tempfile.TemporaryDirectory() as d, patch.object(m, 'clone') as clone:
            result = m.native_recipe({'ticket': 'pyrycode/pyrycode#2169', 'request': {
                'recipe': 'mobile-in-depth', 'revision': SHA}}, {}, Path(d))
            self.assertEqual(result['outcome'], 'failed')
            clone.assert_not_called()

    def test_checkout_failure_returns_diagnostic_instead_of_empty_runtime_error(self):
        with tempfile.TemporaryDirectory() as d, patch.object(m, 'clone', side_effect=RuntimeError('checkout failed')):
            result = m.native_recipe({'ticket': 'pyrycode/pyrycode-mobile#2169', 'request': {
                'recipe': 'mobile-in-depth', 'revision': SHA}}, {'mobile':'mobile'}, Path(d))
            self.assertEqual(result['outcome'], 'failed')
            self.assertIn('checkout failed', result['files']['mobile/capture.json'])


# The candidate's forwarding path: the gate's APK build runs the checkout's
# compatibility wrapper, which forwards to agent-tool.py. The fixture copies
# only agent-tool.py's helper resolution, AGENTS_REPO_PATH or a sibling
# checkout, not its tool allowlist, test scope or admission.
CANDIDATE_WRAPPER = (
    'import os,sys\nfrom pathlib import Path\n'
    'os.execv(sys.executable,[sys.executable,str(Path(__file__).with_name("agent-tool.py")),Path(__file__).name,*sys.argv[1:]])\n')
CANDIDATE_AGENT_TOOL = (
    'import os,sys\nfrom pathlib import Path\n'
    'root=Path(__file__).resolve().parents[1]\n'
    'agents=Path(os.environ.get("AGENTS_REPO_PATH",root.parent/"pyrycode-mobile-agents"))\n'
    'script=agents/"scripts"/sys.argv[1]\n'
    'if not script.is_file():\n'
    '    sys.exit("Install pyrycode-mobile-agents beside this checkout or set AGENTS_REPO_PATH.")\n'
    'os.execv(sys.executable,[sys.executable,str(script),*sys.argv[2:]])\n')
# The agents gate builds APKs through the candidate before any device test.
AGENTS_GATE = (
    'import os,subprocess,sys\nfrom pathlib import Path\n'
    'root=Path(os.environ["PYRY_MOBILE_REPO"])\n'
    'build=subprocess.run([sys.executable,str(root/"scripts/gradle-gate.py"),":app:assembleDebug"],stdout=sys.stderr)\n'
    'if build.returncode:\n'
    '    print("no device test was started",file=sys.stderr);sys.exit(1)\n'
    'print(\'<testsuite tests="1"><testcase classname="C" name="passes"/></testsuite>\')\n')
AGENTS_GRADLE = 'import sys\nprint("configured agents gradle helper ran",file=sys.stderr)\n'


@unittest.skipUnless(m.process_snapshot() is not None, 'Requires native process census')
class MobileCaptureAgentsCheckoutTests(unittest.TestCase):
    """#294: the isolated candidate has no sibling agents checkout."""

    def repository(self, path, files):
        path.mkdir(parents=True)
        for name, content in files.items():
            (path / name).parent.mkdir(parents=True, exist_ok=True)
            (path / name).write_text(content)
        # Host git settings such as signing or template hooks cannot affect the fixture.
        env = {**{k: v for k, v in os.environ.items() if not k.startswith('GIT_')},
               'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
        git = ['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-C', str(path)]
        subprocess.run(['git', 'init', '-q', '--template=', '-b', 'main', str(path)], check=True, env=env)
        subprocess.run([*git, 'add', '-A'], check=True, env=env)
        subprocess.run([*git, 'commit', '-q', '-m', 'fixture'], check=True, env=env)
        return subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()

    def capture(self, recipe, agents_files, inherited=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        revision = self.repository(root / 'sources/mobile', {
            'scripts/gradle-gate.py': CANDIDATE_WRAPPER, 'scripts/agent-tool.py': CANDIDATE_AGENT_TOOL})
        self.repository(root / 'configured/mobile-agents', agents_files)
        for key in ['core', 'relay']:
            self.repository(root / 'sources' / key, {'README': key})
        directory = root / 'task'
        directory.mkdir()
        def clone(source, destination, revision=None, repository=None, deadline=None):
            # Local and offline. Only the network fetch of the real clone is replaced.
            subprocess.run(['git', 'clone', '-q', str(source), str(destination)], check=True)
            if revision:
                subprocess.run(['git', '-C', str(destination), 'switch', '-q', '--detach', revision], check=True)
        paths = {key: str(root / 'sources' / key) for key in ['mobile', 'core', 'relay']}
        paths['mobileAgents'] = str(root / 'configured/mobile-agents')
        environment = {k: v for k, v in os.environ.items() if k != 'AGENTS_REPO_PATH'}
        if inherited is not None:
            environment['AGENTS_REPO_PATH'] = inherited
        with patch.object(m, 'clone', side_effect=clone), patch.dict(os.environ, environment, clear=True):
            result = m.native_recipe({'ticket': 'pyrycode/pyrycode-mobile#2169', 'request': {
                'recipe': recipe, 'capability': 'mobile-android', 'revision': revision}}, paths, directory)
        self.assertFalse((directory / 'pyrycode-mobile-agents').exists())
        return result, json.loads(result['files']['mobile/capture.json'])

    def test_nested_candidate_build_finds_the_configured_agents_helper(self):
        agents = {'scripts/android-test-gate.py': AGENTS_GATE, 'scripts/gradle-gate.py': AGENTS_GRADLE}
        for recipe in sorted(m.MOBILE_RECIPES):
            for inherited in [None, '/nonexistent/inherited-agents']:
                with self.subTest(recipe=recipe, inherited=inherited):
                    result, evidence = self.capture(recipe, agents, inherited)
                    log = result['files']['mobile/execution.log']
                    self.assertNotIn('Install pyrycode-mobile-agents', log)
                    self.assertIn('configured agents gradle helper ran', log)
                    self.assertEqual(result['outcome'], 'completed', evidence['errors'])
                    self.assertTrue(evidence['complete'])
                    self.assertTrue(evidence['runs'])
                    for run in evidence['runs']:
                        self.assertEqual(run['counts'], {'executed': 1, 'passed': 1, 'failed': 0, 'skipped': 0})

    def test_missing_configured_helper_fails_and_keeps_the_preparation_diagnostic(self):
        result, evidence = self.capture('mobile-in-depth', {'scripts/android-test-gate.py': AGENTS_GATE})
        log = result['files']['mobile/execution.log']
        self.assertEqual(result['outcome'], 'failed')
        self.assertFalse(evidence['complete'])
        self.assertIn('Install pyrycode-mobile-agents beside this checkout or set AGENTS_REPO_PATH.', log)
        self.assertIn('no device test was started', log)
        self.assertEqual(result['files']['mobile/gate-0.xml'], '')
        self.assertIn('Malformed JUnit report', evidence['errors'])
        self.assertNotIn('counts', evidence['runs'][0])


if __name__ == '__main__':
    unittest.main()
