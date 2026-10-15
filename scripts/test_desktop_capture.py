"""The Desktop route must never send its revision to the Core checkout."""
import base64
import copy
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('fleet-support.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
SHA = 'e8281ae46204e6286702bff791188b2b437b79f5'


def report():
    return {'config': {'workers': 4, 'projects': [{'name': 'clipboard', 'workers': 1}, {'name': 'parallel'}]},
            'suites': [{'title': 'file.spec.ts', 'specs': [{'title': 'paired', 'tests': [
                {'projectName': 'parallel', 'status': 'expected', 'expectedStatus': 'passed', 'annotations': [], 'results': [
                    {'status': 'passed', 'retry': 0, 'attachments': []}]}]}]}], 'errors': []}


class DesktopCaptureTests(unittest.TestCase):
    def capture(self, directory, payload, exit_code=0, setup_code=0, rebuild_code=0):
        calls = []
        paths = {'desktop': '/configured/desktop', 'desktopLauncher': '/configured/desktop-test'}
        config = "export default { workers: 4, projects: [{name: 'clipboard', workers: 1}, {name: 'parallel'}] }\n"
        def execute(argv, cwd, log, env=None, **kwargs):
            calls.append((argv, Path(cwd), env))
            with log.open('a') as output: output.write('fresh command diagnostic\n')
            if 'worktree' in argv:
                worktree = directory / 'desktop'; worktree.mkdir()
                (worktree / 'playwright.config.ts').write_text(config)
            if argv == ['npm', 'run', 'rebuild:electron']:
                with log.open('a') as output: output.write('rebuild stdout diagnostic\nrebuild stderr diagnostic\n')
                return rebuild_code
            if argv[0] == paths['desktopLauncher']:
                if payload is not None:
                    (directory / 'playwright.json').write_text(json.dumps(payload))
                with log.open('a') as output: output.write('fresh full-suite list log\n')
                return exit_code
            return setup_code if argv[0] == 'npm' else 0
        with patch.object(m, 'execute', side_effect=execute), patch.object(m, 'clone') as clone:
            result = m.native_recipe({'ticket': 'pyrycode/pyrycode-desktop#1983', 'request': {
                'recipe': 'desktop-fake-suite', 'capability': 'desktop-fake-suite', 'revision': SHA}}, paths, directory)
            clone.assert_not_called()
        return result, calls, config

    def test_complete_suite_uses_configured_desktop_revision_and_managed_launcher(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            result, calls, config = self.capture(directory, report())
            self.assertEqual(result['outcome'], 'completed')
            self.assertEqual(calls[0][0], ['git', '-C', '/configured/desktop', 'fetch', '--refetch', 'origin', SHA])
            self.assertEqual(calls[1][0], ['git', '-C', '/configured/desktop', 'worktree', 'add', '--detach', str(directory/'desktop'), SHA])
            self.assertEqual([c[0] for c in calls[2:]], [['npm', 'ci'], ['npm', 'run', 'build'],
                ['npm', 'run', 'rebuild:electron'], ['/configured/desktop-test', str(directory/'desktop')]])
            self.assertTrue(all(c[1] == directory/'desktop' for c in calls[2:]))
            self.assertEqual(result['files']['desktop/playwright.config.ts'], config)
            evidence = json.loads(result['files']['desktop/capture.json'])
            self.assertEqual(evidence['revision'], SHA)
            self.assertEqual(evidence['configuration']['workers'], 4)
            self.assertEqual(evidence['configuration']['projects'][0]['workers'], 1)
            self.assertEqual(evidence['counts'], {'executed': 1, 'passed': 1, 'failed': 0, 'skipped': 0, 'retries': 0})
            self.assertIn('fresh full-suite', result['files']['desktop/playwright.list.log'])
            wrapper = (directory/'desktop/playwright.config.ts').read_text()
            self.assertIn('...config', wrapper)
            self.assertNotIn('workers:', wrapper)

    def test_fake_children_receive_runtime_settings_without_credentials_or_git_overrides(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {
            'GH_TOKEN': 'private', 'GITHUB_TOKEN': 'private', 'OP_SERVICE_ACCOUNT_TOKEN': 'private',
            'CLAUDE_CODE_OAUTH_TOKEN': 'private', 'FLEET_ADMIN_TOKEN': 'private', 'PYRY_MANAGER_TOKEN': 'private',
            'PYRY_LIVE_CLAUDE_TOKEN': 'private', 'GIT_DIR': '/other/repository', 'PW_WORKERS': '4', 'CI': 'true'}):
            _, calls, _ = self.capture(Path(d), report())
            for _, _, env in calls:
                self.assertEqual(env['PW_WORKERS'], '4'); self.assertEqual(env['CI'], 'true')
                self.assertNotIn('private', env.values()); self.assertNotIn('GIT_DIR', env)

    def test_real_git_keeps_source_checkout_and_uses_only_a_pushed_revision(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);remote=root/'remote.git';source=root/'source';directory=root/'capture';directory.mkdir()
            env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
            def git(*args):
                return subprocess.check_output(['git',*map(str,args)],env=env,stderr=subprocess.DEVNULL,text=True).strip()
            git('init','--bare',remote);git('init',source)
            git('-C',source,'config','user.name','Fixture');git('-C',source,'config','user.email','fixture@example.test')
            (source/'playwright.config.ts').write_text('export default {workers:4}\n')
            git('-C',source,'add','.');git('-C',source,'commit','-m','configured suite')
            revision=git('-C',source,'rev-parse','HEAD');git('-C',source,'remote','add','origin',remote);git('-C',source,'push','origin','HEAD')
            branch=git('-C',source,'branch','--show-current');calls=[]
            def execute(argv,cwd,log,env=None,**kwargs):
                calls.append(argv)
                if argv[0]=='git':return subprocess.run(argv,cwd=cwd,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode
                if argv[0]=='launcher':
                    worktree=Path(argv[1]);self.assertEqual(git('-C',worktree,'rev-parse','HEAD'),revision)
                    self.assertEqual(git('-C',worktree,'rev-parse','--path-format=absolute','--git-common-dir'),str(source/'.git'))
                    (directory/'playwright.json').write_text(json.dumps(report()))
                with log.open('a') as output:output.write('fresh diagnostic\n')
                return 0
            task={'ticket':'pyrycode/pyrycode-desktop#1983','request':{'recipe':'desktop-fake-suite','revision':revision}}
            paths={'desktop':str(source),'desktopLauncher':'launcher'}
            with patch.object(m,'execute',side_effect=execute):result=m.native_recipe(task,paths,directory)
            self.assertEqual(result['outcome'],'completed')
            self.assertEqual(git('-C',source,'branch','--show-current'),branch)
            self.assertEqual(git('-C',source,'status','--porcelain'),'')
            (source/'unpublished').touch();git('-C',source,'add','.');git('-C',source,'commit','-m','unpublished')
            task['request']['revision']=git('-C',source,'rev-parse','HEAD');failed=root/'failed';failed.mkdir();calls.clear()
            with patch.object(m,'execute',side_effect=execute):result=m.native_recipe(task,paths,failed)
            self.assertEqual(result['outcome'],'failed');self.assertEqual(len(calls),1)
            self.assertEqual(calls[0][-2:],['origin',task['request']['revision']])

    def test_failure_retains_every_setup_attachment_skip_reason_and_retry(self):
        payload = report(); test = payload['suites'][0]['specs'][0]['tests'][0]
        test['status'] = 'unexpected'
        test['results'] = [{'status': 'failed', 'retry': 0, 'attachments': [
            {'name': 'fake-daemon-setup', 'body': base64.b64encode(b'{"stage":"dial"}').decode()}]},
            {'status': 'failed', 'retry': 1, 'attachments': [{'name': 'fake-daemon-setup', 'path': 'setup.json'}]}]
        skipped = copy.deepcopy(test); skipped['status'] = 'skipped'; skipped['results'] = [{'status': 'skipped', 'retry': 0}]
        skipped['annotations'] = [{'type': 'skip', 'description': 'configured skip reason'}]
        payload['suites'][0]['specs'][0]['tests'].append(skipped)
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d); (directory/'setup.json').write_text('{"stage":"listen"}')
            test['results'][1]['attachments'][0]['path'] = str(directory/'setup.json')
            result, _, _ = self.capture(directory, payload, exit_code=1)
            self.assertEqual(result['outcome'], 'failed')
            evidence = json.loads(result['files']['desktop/capture.json'])
            self.assertEqual(evidence['counts'], {'executed': 1, 'passed': 0, 'failed': 1, 'skipped': 1, 'retries': 1})
            self.assertIn('configured skip reason', json.dumps(evidence['tests']))
            attachments = json.loads(result['files']['desktop/fake-daemon-setup.json'])
            self.assertEqual(len(attachments), 2)
            self.assertEqual({a['body'] for a in attachments}, {'{"stage":"dial"}', '{"stage":"listen"}'})
            self.assertIn('desktop/playwright.json', result['files'])
            self.assertIn('desktop/playwright.list.log', result['files'])

    def test_nested_projects_follow_aggregate_outcomes_and_both_skip_representations(self):
        payload = report()
        def test(status, attempts, **fields):
            return {'projectName': 'parallel', 'status': status, 'expectedStatus': 'passed',
                    'results': [{'status': value, 'retry': i} for i, value in enumerate(attempts)], **fields}
        payload['suites'][0]['suites'] = [{'title': 'nested', 'specs': [
            {'title': 'same title across projects', 'tests': [
                test('expected', ['passed']), test('expected', ['failed'], expectedStatus='failed', projectName='clipboard'),
                test('flaky', ['failed', 'passed']),
                test('skipped', [], annotations=[{'type': 'skip', 'description': 'not on this platform'}]),
                test('skipped', ['skipped'], annotations=[{'type': 'fixme', 'description': 'tracked setup issue'}])]}]}]
        with tempfile.TemporaryDirectory() as d:
            result, _, _ = self.capture(Path(d), payload)
        self.assertEqual(result['outcome'], 'completed')
        capture = json.loads(result['files']['desktop/capture.json'])
        self.assertEqual(capture['counts'], {'executed': 4, 'passed': 4, 'failed': 0, 'skipped': 2, 'retries': 1})
        self.assertEqual(capture['errors'], [])
        self.assertEqual(capture['tests'][2]['project'], 'clipboard')
        self.assertEqual(capture['tests'][4]['skipReasons'], ['not on this platform'])
        self.assertEqual(capture['tests'][5]['skipReasons'], ['tracked setup issue'])
        failed = copy.deepcopy(payload)
        failed['suites'][0]['suites'][0]['specs'][0]['tests'].append(test('unexpected', ['failed', 'timedOut']))
        with tempfile.TemporaryDirectory() as d:
            result, _, _ = self.capture(Path(d), failed, exit_code=1)
        self.assertEqual(result['outcome'], 'failed')
        self.assertEqual(json.loads(result['files']['desktop/capture.json'])['counts'],
                         {'executed': 5, 'passed': 4, 'failed': 1, 'skipped': 2, 'retries': 2})

    def test_rejected_records_keep_counts_and_attachments_on_both_sides(self):
        # The collector must keep walking after invalid tests, attempts and suites.
        malformed = [None, [], {'status': 'unknown', 'results': []},
                     {'status': 'expected', 'results': []}, {'status': 'expected', 'results': 'unfinished'},
                     {'status': 'expected', 'results': [None, {'status': 'passed'}]},
                     {'status': 'expected', 'results': [{'status': 'running'}, {'status': 'passed'}]},
                     {'status': 'expected', 'results': [{'status': 'failed'}]},
                     {'status': 'unexpected', 'results': [{'status': 'passed'}]},
                     {'status': 'flaky', 'results': [{'status': 'failed'}]},
                     {'status': 'skipped', 'results': [{'status': 'passed'}]},
                     {'status': 'expected', 'expectedStatus': 'unknown', 'results': [{'status': 'passed'}]}]
        for bad in malformed:
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as d:
                payload = report(); tests = payload['suites'][0]['specs'][0]['tests']
                def attached(label):
                    item = copy.deepcopy(tests[0])
                    item['results'][0]['attachments'] = [{'name': 'fake-daemon-setup',
                        'body': base64.b64encode(json.dumps({'stage': label}).encode()).decode()}]
                    return item
                before, after = attached('before'), attached('after')
                bad = copy.deepcopy(bad)
                labels = ['before', 'after']
                if isinstance(bad, dict) and isinstance(bad.get('results'), list):
                    attempt = next((a for a in bad['results'] if isinstance(a, dict)), None)
                    if attempt is not None:
                        attempt['attachments'] = attached('rejected')['results'][0]['attachments']
                        labels = ['before', 'rejected', 'after']
                tests[:] = [before, bad, after]
                payload['suites'].extend([None, {'title': 'later.spec.ts', 'specs': [{'title': 'later', 'tests': [attached('later')]}]}])
                result, _, _ = self.capture(Path(d), payload)
                self.assertEqual(result['outcome'], 'failed')
                capture = json.loads(result['files']['desktop/capture.json'])
                self.assertGreaterEqual(capture['counts']['passed'], 3)
                self.assertTrue(capture['errors'])
                attachments = json.loads(result['files']['desktop/fake-daemon-setup.json'])
                self.assertEqual([json.loads(a['body'])['stage'] for a in attachments], [*labels, 'later'])

    def test_unreadable_setup_attachment_fails_capture_without_losing_later_attachments(self):
        for broken in ({'body': 'invalid base64!'}, {'path': 'missing.json'}, {}):
            with self.subTest(broken=broken), tempfile.TemporaryDirectory() as d:
                payload = report()
                payload['suites'][0]['specs'][0]['tests'][0]['results'][0]['attachments'] = [
                    {'name': 'fake-daemon-setup', 'body': base64.b64encode(b'{"stage":"before"}').decode()},
                    {'name': 'fake-daemon-setup', **broken},
                    {'name': 'fake-daemon-setup', 'body': base64.b64encode(b'{"stage":"after"}').decode()}]
                result, _, _ = self.capture(Path(d), payload)
                self.assertEqual(result['outcome'], 'failed')
                capture = json.loads(result['files']['desktop/capture.json'])
                self.assertEqual(capture['counts'], {'executed': 1, 'passed': 1, 'failed': 0, 'skipped': 0, 'retries': 0})
                self.assertTrue(capture['errors'])
                attachments = json.loads(result['files']['desktop/fake-daemon-setup.json'])
                self.assertEqual([json.loads(a['body'])['stage'] for a in attachments], ['before', 'after'])

    def test_global_and_structural_errors_cannot_pass_with_readable_test_counts(self):
        cases = [{'errors': [{'message': 'global setup failed'}]}, {'errors': {}},
                 {'suites': 'unfinished'}, {'suites': [None]}]
        for fields in cases:
            with self.subTest(fields=fields), tempfile.TemporaryDirectory() as d:
                payload = {**report(), **fields}
                result, _, _ = self.capture(Path(d), payload)
                self.assertEqual(result['outcome'], 'failed')
                self.assertTrue(json.loads(result['files']['desktop/capture.json'])['errors'])

    def test_missing_empty_and_all_skipped_results_never_pass(self):
        empty = report(); empty['suites'] = []
        skipped = report(); skipped['suites'][0]['specs'][0]['tests'][0].update(status='skipped', results=[])
        for payload in (None, empty, skipped):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as d:
                result, _, _ = self.capture(Path(d), payload)
                self.assertEqual(result['outcome'], 'failed')
                self.assertIn('desktop/capture.json', result['files'])

    def test_more_than_1024_setup_attachments_fit_the_ordinary_inventory(self):
        payload=report();payload['suites'][0]['specs'][0]['tests'][0]['results'][0]['attachments']=[
            {'name':f'fake-daemon-setup-{i}', 'body':base64.b64encode(b'{"outcome":"opened"}').decode()} for i in range(1100)]
        with tempfile.TemporaryDirectory() as d:
            result,_,_=self.capture(Path(d),payload)
            self.assertEqual(result['outcome'],'completed')
            self.assertEqual(len(json.loads(result['files']['desktop/fake-daemon-setup.json'])),1100)
            self.assertLess(len(result['files']),m.ARTIFACT_FILES)

    def test_launcher_and_install_failures_return_fresh_diagnostics(self):
        for exit_code, setup_code in [(2, 0), (0, 1)]:
            with self.subTest(exit_code=exit_code, setup_code=setup_code), tempfile.TemporaryDirectory() as d:
                result, calls, _ = self.capture(Path(d), None, exit_code, setup_code)
                self.assertEqual(result['outcome'], 'failed')
                self.assertIn('desktop/capture.json', result['files'])
                self.assertIn('desktop/execution.log', result['files'])
                if setup_code:
                    self.assertNotIn('/configured/desktop-test', [c[0][0] for c in calls])

    def test_electron_rebuild_failure_prevents_launch_and_retains_diagnostics(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            result, calls, config = self.capture(directory, report(), rebuild_code=7)
            self.assertEqual(result['outcome'], 'failed')
            self.assertEqual([c[0] for c in calls[2:]], [
                ['npm', 'ci'], ['npm', 'run', 'build'], ['npm', 'run', 'rebuild:electron']])
            self.assertEqual(result['candidateRevision'], SHA)
            self.assertEqual(result['files']['desktop/playwright.config.ts'], config)
            self.assertIn('rebuild stdout diagnostic', result['files']['desktop/execution.log'])
            self.assertIn('rebuild stderr diagnostic', result['files']['desktop/execution.log'])
            evidence = json.loads(result['files']['desktop/capture.json'])
            self.assertEqual(evidence['revision'], SHA)
            self.assertEqual(evidence['counts'], {'executed': 0, 'passed': 0, 'failed': 0, 'skipped': 0, 'retries': 0})
            self.assertIn('Desktop Electron rebuild failed; inspect execution.log', evidence['errors'])
            self.assertEqual(json.loads(result['files']['desktop/fake-daemon-setup.json']), [])
            self.assertNotIn('desktop/playwright.json', result['files'])
            self.assertNotIn('desktop/playwright.list.log', result['files'])

    def test_desktop_readiness_requires_the_specific_mac_route(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); repo = root/'desktop'; repo.mkdir()
            (repo/'.git').mkdir(); (repo/'playwright.config.ts').touch(); (repo/'package-lock.json').touch()
            launcher = root/'desktop-test'; launcher.write_text('#!/bin/sh\n'); launcher.chmod(0o700)
            route = {'capability': 'desktop-fake-suite', 'paths': {'desktop': str(repo), 'desktopLauncher': str(launcher)}}
            with patch.object(m.sys, 'platform', 'darwin'), patch.object(m.shutil, 'which', return_value='/tool'), patch.object(m.subprocess, 'run') as run:
                run.return_value.returncode = 0
                run.return_value.stdout = 'https://github.com/pyrycode/pyrycode-desktop.git\n'
                self.assertTrue(m.route_available(route))
                run.return_value.stdout = 'https://github.com/pyrycode/pyrycode.git\n'
                self.assertFalse(m.route_available(route))
                run.return_value.stdout = 'https://github.com/pyrycode/pyrycode-desktop.git\n'
                self.assertFalse(m.route_available({**route, 'container': 'core'}))
                launcher.unlink(); self.assertFalse(m.route_available(route))
            with patch.object(m.sys, 'platform', 'linux'):
                self.assertFalse(m.route_available(route))

    def test_supervisor_routes_from_the_configured_mac_desktop_project(self):
        with tempfile.TemporaryDirectory() as d:
            config = {'platform': 'mac', 'stateDirectory': d, 'projects': {'pyrycode/pyrycode-desktop': {
                'target': '/configured/desktop', 'fakeTestLauncher': '/configured/desktop-test'}}}
            supervisor = m.SupportSupervisor(object(), config)
            route = config['recoveryTasks']['desktop-fake-suite:desktop-fake-suite']
            self.assertEqual(route['paths'], {'desktop': '/configured/desktop', 'desktopLauncher': '/configured/desktop-test'})
            with patch.object(m, 'route_available', return_value=False):
                self.assertNotIn('desktop-fake-suite', supervisor.capability_record({})['capabilities'])
            with patch.object(m, 'route_available', return_value=True):
                self.assertIn('desktop-fake-suite', supervisor.capability_record({})['capabilities'])
            del config['projects']['pyrycode/pyrycode-desktop']['fakeTestLauncher']
            m.SupportSupervisor(object(), config)
            self.assertEqual(config['recoveryTasks']['desktop-fake-suite:desktop-fake-suite']['paths']['desktopLauncher'],
                             str(Path.home()/'.codex/bin/pyrycode-desktop-test'))


if __name__ == '__main__': unittest.main()
