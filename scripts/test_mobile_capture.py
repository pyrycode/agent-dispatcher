import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('support_mobile', Path(__file__).with_name('fleet-support.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SHA = 'a' * 40


class MobileCaptureTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
