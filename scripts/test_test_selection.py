import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('test_selection', Path(__file__).with_name('test-selection.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

DESIGN_CAPTURE_TESTS = ('de.pyryco.mobile.design.ListDesignCaptureTest#listFramesAt412By892,'
                        'de.pyryco.mobile.design.ListDesignCaptureTest#listFramesAt320By700LargeText')
INSTRUMENTATION_CLASS = '-Pandroid.testInstrumentationRunnerArguments.class'


class SelectionTests(unittest.TestCase):
    def test_api35_design_capture_and_existing_instrumentation_routes_are_focused(self):
        policy.selection('android', ['ui', '--tests', DESIGN_CAPTURE_TESTS])
        for task in ['pixel8Api35DebugAndroidTest', 'pixel2Api33AtdDebugAndroidTest',
                     'connectedDebugAndroidTest', 'connectedAndroidTest']:
            with self.subTest(task=task):
                policy.selection('gradle', [':app:' + task, INSTRUMENTATION_CLASS + '=' + DESIGN_CAPTURE_TESTS])

    def test_api35_design_capture_rejects_unbounded_or_overridden_selections(self):
        task = ':app:pixel8Api35DebugAndroidTest'
        invalid = ['', '*', 'de.pyryco.mobile.design.*',
                   'de.pyryco.mobile.design.ListDesignCaptureTest#*',
                   'de.pyryco.mobile.design.ListDesignCaptureTest#',
                   DESIGN_CAPTURE_TESTS + ',de.pyryco.mobile.OtherTest#other',
                   DESIGN_CAPTURE_TESTS + ',',
                   'ListDesignCaptureTest#listFramesAt412By892']
        for selector in invalid:
            for kind, args in [('android', ['ui', '--tests', selector]),
                               ('gradle', [task, INSTRUMENTATION_CLASS + '=' + selector])]:
                with self.subTest(kind=kind, selector=selector), self.assertRaises(policy.PolicyError):
                    policy.selection(kind, args)
        for kind, args in [
            ('android', ['ui']), ('android', ['ui', '--tests']),
            ('android', ['ui', '--tests', DESIGN_CAPTURE_TESTS, '--tests=*']),
            ('android', ['ui', '--tests=' + DESIGN_CAPTURE_TESTS, '--tests', '*']),
            ('gradle', [task]), ('gradle', [task, INSTRUMENTATION_CLASS]),
            ('gradle', [task, INSTRUMENTATION_CLASS + '=' + DESIGN_CAPTURE_TESTS, INSTRUMENTATION_CLASS + '=*']),
            ('gradle', [task, INSTRUMENTATION_CLASS + '=' + DESIGN_CAPTURE_TESTS, INSTRUMENTATION_CLASS, '*']),
            ('gradle', [task, INSTRUMENTATION_CLASS + '=' + DESIGN_CAPTURE_TESTS, ':app:check']),
            ('gradle', [task, INSTRUMENTATION_CLASS + '=' + DESIGN_CAPTURE_TESTS, ':app:testDebugUnitTest']),
            ('gradle', [task, INSTRUMENTATION_CLASS + '=' + DESIGN_CAPTURE_TESTS, ':app:allDevicesDebugAndroidTest']),
            ('gradle', [':app:pixel8Api35Setup']),
            ('gradle', [':app:pixel8Api35DebugAndroidTestAll', INSTRUMENTATION_CLASS + '=' + DESIGN_CAPTURE_TESTS]),
        ]:
            with self.subTest(kind=kind, args=args), self.assertRaises(policy.PolicyError):
                policy.selection(kind, args)

    def test_api35_launcher_arguments_use_frozen_builder_context(self):
        # pyrycode-mobile-agents android-test-gate.py emits assembly, then this
        # UI command; managed_ui_environment skips ATD image setup for API35.
        nested = [':app:pixel8Api35DebugAndroidTest', '--rerun',
                  INSTRUMENTATION_CLASS + '=' + DESIGN_CAPTURE_TESTS,
                  '-Pandroid.testInstrumentationRunnerArguments.notPackage=de.pyryco.mobile.e2e',
                  '-Pandroid.experimental.androidTest.numManagedDeviceShards=1',
                  '-Pandroid.testInstrumentationRunnerArguments.disableAnimations=true', '--console=plain']
        commands = [('android', ['ui', '--tests', DESIGN_CAPTURE_TESTS]),
                    ('gradle', [':app:assembleDebug', ':app:assembleDebugAndroidTest', '--console=plain']),
                    ('gradle', nested)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            folder = root / '.git/pyry-test-context'
            folder.mkdir(parents=True)
            record = {'version': 1, 'root': str(root), 'runId': 'capture-run',
                      'project': 'pyrycode/pyrycode-mobile', 'socket': '/owned/context.sock'}
            (folder / 'context.json').write_text(json.dumps(record))
            reply = {'version': 1, 'runId': record['runId'], 'project': record['project'],
                     'role': 'builder', 'origin': 'agent'}
            with patch.object(policy.Path, 'cwd', return_value=root), \
                 patch.dict(os.environ, {'CLAUDE_CODE_ENTRYPOINT': 'verifier', 'PYRY_TASK_SOCKET': '/forged/socket'}):
                with patch.object(policy, 'socket_context', return_value=reply) as context:
                    for kind, args in commands:
                        with self.subTest(kind=kind, args=args):
                            policy.check(root, kind, args)
                    self.assertEqual(context.call_count, len(commands))
                    context.assert_called_with(record['socket'])
                    for kind, args in [('android', ['ui']), ('gradle', [nested[0]]),
                                       ('gradle', [*nested, ':app:check'])]:
                        with self.subTest(kind=kind, args=args), self.assertRaises(policy.PolicyError):
                            policy.check(root, kind, args)
                for response in [{'return_value': {**reply, 'runId': 'foreign-run'}},
                                 {'side_effect': OSError('context unavailable')}]:
                    with patch.object(policy, 'socket_context', **response):
                        for kind, args in commands:
                            with self.subTest(kind=kind, response=response), self.assertRaises(policy.PolicyError):
                                policy.check(root, kind, args)

    def test_desktop_unit_selection_is_exact_and_bounded(self):
        for args in [
            ['--files-json', '["src/main/store.test.ts"]'],
            ['--tests-json', '["src/main/store.test.ts#outer comma, apostrophe\u0027s case"]'],
        ]:
            policy.selection('desktop-unit', args)
        for args in [[], ['--files-json', '["src"]'],
                     ['--files-json', '["../other.test.ts"]'],
                     ['--files-json', '["src/*.test.ts"]'],
                     ['--files-json', '["src/a.test.ts", "src/b.test.ts"]'],
                     ['--tests-json', '["src/a.test.ts#"]'],
                     ['--files-json', '["src/a.test.ts"]', '--all'],
                     ['--files-json', '["src/a.test.ts"]', ';', 'npm', 'test'],
                     ['--files-json', '["src/a.test.ts"]', '--files-json', '["src/b.test.ts"]']]:
            with self.subTest(args=args), self.assertRaises(policy.PolicyError):
                policy.selection('desktop-unit', args)

    def test_managed_emulator_setup_is_an_exact_non_test_task(self):
        policy.gradle_selection([':app:pixel2Api33AtdSetup', '--rerun', '--console=plain'])
        for args in [
            [':app:pixel2Api33AtdSetupAll'],
            [':app:OtherSetup'], [':app:p2A33AtdSetup'],
            [':app:pixel2Api33AtdDebugAndroidTest', '--rerun', '--console=plain'],
            [':app:pixel2Api33AtdSetup', ':app:check'],
            [':app:pixel2Api33AtdSetup', ':app:testDebugUnitTest', '--tests', '*'],
        ]:
            with self.subTest(args=args), self.assertRaises(policy.PolicyError):
                policy.gradle_selection(args)

    def test_go_full_and_effective_catch_all_requests_are_refused(self):
        commands = [
            ['test', './...'], ['test', '-run', '.', './internal/thread'],
            ['test', '-run', 'Test', './internal/thread'],
            ['test', '-run', '^.*$', './internal/thread'],
            ['test', '-run', '^TestX$', '-run', '.', './internal/thread'],
            ['test', '-run', '^TestX$', './internal/thread', '-args', '-test.run', '.'],
            ['test', '-run', '^$', '-bench', '.', './internal/thread'],
            ['test', '-fuzz', '.', './internal/thread'],
            ['test', '-list=', './...'], ['test', '-c', '-c=false', './...'],
            ['test', '-benchmem', './...'],
            ['test', '-bench', '^BenchmarkExport$', './...'],
            ['test', '-list', '.', './...', '-args', '-test.list='],
            ['test', 'github.com/pyrycode/pyrycode/...'],
            ['test', '/private/product/...'], ['test', '././...'],
            ['test', './internal/thread', './cmd/pyry'],
            ['-C', '.', 'test', './...'], ['-C=.', 'test', './...'],
        ]
        for command in commands:
            with self.subTest(command=command), self.assertRaises(policy.PolicyError):
                policy.go_selection(command)

    def test_go_affected_packages_named_tests_build_and_listing_remain_available(self):
        for command in [
            ['test', './internal/thread'], ['test', '-race', './internal/thread/...'],
            ['test', '-run', '^(TestX|TestY)$', './...'],
            ['test', '-run', '^TestX/subcase$', './internal/thread'],
            ['test', '-run', '^$', '-bench', '^BenchmarkExport$', './internal/thread'],
            ['test', '-run', '^$', '-bench', '^BenchmarkExport$', './...'],
            ['test', '-run', '^$', './...'],
            ['test', '-c', './...'], ['test', '-list', '.', './...'],
            ['build', './...'], ['vet', './...'],
        ]:
            with self.subTest(command=command):
                policy.go_selection(command)

    def test_mobile_focused_calls_and_compilation_are_separate_from_full_suites(self):
        for kind, args in [
            ('android', ['ui', '--tests', 'de.pyryco.mobile.ScreenTest']),
            ('android', ['ui', '--tests', 'de.pyryco.mobile.recording.RecordedMobileSuiteTest#oneScenario']),
            ('android', ['ui', '--tests', 'de.pyryco.mobile.ScreenTest#first,de.pyryco.mobile.ScreenTest#second']),
            ('android', ['scripted', 'reply-suggestion']),
            ('jvm', ['--tests-json', json.dumps(['de.pyryco.mobile.ModelTest#comma, and space'])]),
            ('jvm', ['--classes', 'de.pyryco.mobile.ModelTest']),
            ('android', ['--help']), ('jvm', ['--help']),
            ('gradle', [':app:testDebugUnitTest', '--tests', 'de.pyryco.mobile.ModelTest']),
            ('gradle', [':app:assembleDebug', ':app:assembleDebugAndroidTest', '--console=plain']),
            ('gradle', [':app:pixel2Api33AtdDebugAndroidTest', '-Pandroid.testInstrumentationRunnerArguments.class=de.pyryco.mobile.ScreenTest']),
            ('gradle', [':app:compileDebugUnitTestKotlin', ':app:lintDebug', ':app:spotlessCheck']),
            ('gradle', [':app:spotlessApply']),
            ('gradle', [':app:compileDebugKotlin', '--console', 'plain', '--max-workers', '2', '-P', 'example=value']),
            ('gradle', [':app:testDebugUnitTest', '--tests', "de.pyryco.mobile.ModelTest.comma, and space", '--tests', "de.pyryco.mobile.ModelTest.apostrophe's name"]),
        ]:
            with self.subTest(kind=kind, args=args):
                policy.selection(kind, args)
        for kind, args in [
            ('android', ['ui']), ('android', ['ui', '--full']),
            ('android', ['ui', '--tests', '*']), ('android', ['scripted-all']),
            ('android', ['ui', '--tests', 'de.pyryco.mobile.FirstTest,de.pyryco.mobile.SecondTest']),
            ('jvm', []), ('jvm', ['--classes', '*']),
            ('jvm', ['--tests-json', '["de.pyryco.mobile.ModelTest#*"]']),
            ('gradle', [':app:testDebugUnitTest']),
            ('gradle', [':app:testDebugUnitTest', '--tests', '*']),
            ('gradle', [':app:check']), ('gradle', [':app:build']),
            ('gradle', [':app:tDUt']),
            ('gradle', [':app:testDebugUnitTest', '--tests', 'de.pyryco.mobile.*']),
            ('android', ['ui', '--tests', 'de.pyryco.mobile.recording.RecordedMobileSuiteTest']),
        ]:
            with self.subTest(kind=kind, args=args), self.assertRaises(policy.PolicyError):
                policy.selection(kind, args)

    def test_scripted_subset_uses_exact_methods_without_opening_the_full_suite(self):
        first = 'de.pyryco.mobile.e2e.DeterministicInteractiveStreamE2ETest#interactiveTurn_directShareShortcut_stagesBeforeExplicitSend'
        second = 'de.pyryco.mobile.e2e.DeterministicInteractiveStreamE2ETest#interactiveTurn_seededChannel_streamsScriptedPingReplyIntoThread'
        for args in [['scripted-all', '--tests', first + ',' + second],
                     ['scripted-all', '--tests=' + first]]:
            policy.selection('android', args)
        for args in [
            ['scripted-all'], ['scripted-all', '--tests', ''],
            ['scripted-all', '--tests', first.split('#')[0]],
            ['scripted-all', '--tests', first + '*'],
            ['scripted-all', '--tests', first + '#extra'],
            ['scripted-all', '--tests', first + ' invalid'],
            ['scripted-all', '--tests', first + 'x' * 8192],
            ['scripted-all', '--tests', first + ',de.pyryco.mobile.OtherTest#method'],
            ['scripted-all', '--tests', first, '--tests', second],
            ['scripted-all', '--tests=' + first, '--tests=' + second],
            ['scripted-all', '--tests', first + ','],
            ['scripted-all', '--tests', ','.join([first] * 65)],
        ]:
            with self.subTest(args=args), self.assertRaises(policy.PolicyError):
                policy.selection('android', args)

    def test_frozen_context_overrides_role_env_and_verifier_keeps_full_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.enterContext(patch.object(policy.Path, 'cwd', return_value=root))
            git = root / '.git'
            git.mkdir()
            folder = git / 'pyry-test-context'
            folder.mkdir()
            record = {'version': 1, 'root': str(root), 'runId': 'run-one', 'project': 'pyrycode/pyrycode', 'socket': '/owned/context.sock'}
            (folder / 'context.json').write_text(json.dumps(record))
            reply = {'version': 1, 'runId': 'run-one', 'project': record['project'], 'role': 'builder', 'origin': 'agent'}
            with patch.object(policy, 'socket_context', return_value=reply), patch.dict(os.environ, {'CLAUDE_CODE_ENTRYPOINT': 'verifier', 'PYRY_TASK_SOCKET': '/forged/socket'}):
                with self.assertRaises(policy.PolicyError):
                    policy.check(root, 'go', ['test', './...'])
                policy.check(root, 'go', ['test', './internal/thread'])
                policy.check(root, 'android', ['scripted-all', '--tests', 'de.pyryco.mobile.e2e.DeterministicInteractiveStreamE2ETest#interactiveTurn_directShareShortcut_stagesBeforeExplicitSend,de.pyryco.mobile.e2e.DeterministicInteractiveStreamE2ETest#interactiveTurn_seededChannel_streamsScriptedPingReplyIntoThread'])
                with self.assertRaises(policy.PolicyError):
                    policy.check(root, 'android', ['scripted-all'])
                policy.check(root, 'gradle', [':app:pixel2Api33AtdSetup', '--rerun', '--console=plain'])
                with self.assertRaises(policy.PolicyError):
                    policy.check(root, 'gradle', [':app:pixel2Api33AtdDebugAndroidTest'])
                with self.assertRaises(policy.PolicyError):
                    policy.check(root, 'desktop-unit', [])
                policy.check(root, 'desktop-unit', ['--files-json', '["src/a.test.ts"]'])
            with patch.object(policy, 'socket_context', return_value={**reply, 'role': 'verifier'}):
                policy.check(root, 'go', ['test', './...'])
                policy.check(root, 'desktop-unit', [])
                policy.check(root, 'android', ['scripted-all'])
            with patch.object(policy, 'socket_context', side_effect=OSError('gone')):
                with self.assertRaises(policy.PolicyError):
                    policy.check(root, 'go', ['test', './internal/thread'])
            for change in [{'root': str(root / 'foreign')}, {'runId': 'other-run'}]:
                with self.subTest(change=change), patch.object(policy, 'socket_context', return_value={**reply, **change}), self.assertRaises(policy.PolicyError):
                    if 'root' in change:
                        (folder / 'context.json').write_text(json.dumps({**record, **change}))
                    policy.check(root, 'go', ['test', './...'])
                (folder / 'context.json').write_text(json.dumps(record))
            (folder / 'context.json').unlink()
            with self.assertRaises(policy.PolicyError):
                policy.check(root, 'go', ['test', './...'])

    def test_unmarked_operator_and_legacy_workers_keep_existing_behavior(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.dict(os.environ, {'PYRY_TASK_SOCKET': '/legacy/api.sock'}):
                policy.check(root, 'go', ['test', './...'])

    def test_deleted_metadata_and_changed_cwd_or_go_directory_cannot_claim_another_worktree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            actual, foreign = root / 'actual', root / 'foreign'
            for product in [actual, foreign]:
                (product / '.git').mkdir(parents=True)
            folder = actual / '.git/pyry-test-context'
            folder.mkdir()
            record = {'version': 1, 'root': str(actual), 'runId': 'run-one', 'project': 'pyrycode/pyrycode', 'socket': '/owned/context.sock'}
            (folder / 'context.json').write_text(json.dumps(record))
            reply = {'version': 1, 'runId': 'run-one', 'project': record['project'], 'role': 'builder', 'origin': 'agent'}
            with patch.object(policy, 'socket_context', return_value=reply):
                with patch.object(policy.Path, 'cwd', return_value=actual):
                    for args in [['-C', str(foreign), 'test', './internal/thread'], ['-C=' + str(foreign), 'test', './internal/thread']]:
                        with self.subTest(args=args), self.assertRaises(policy.PolicyError):
                            policy.check(actual, 'go', args)
                    policy.check(actual, 'go', ['-C', str(actual), 'test', './internal/thread'])
                    policy.check(actual, 'go', ['-C', str(foreign), 'build', './...'])
                    with self.assertRaises(policy.PolicyError):
                        policy.check(actual, 'go', ['-C', str(actual), 'test', './internal/thread'], {'GOFLAGS': '-run=.'})
                with patch.object(policy.Path, 'cwd', return_value=actual), self.assertRaises(policy.PolicyError):
                    policy.check(foreign, 'android', ['ui'])
                with patch.object(policy.Path, 'cwd', return_value=foreign), self.assertRaises(policy.PolicyError):
                    policy.check(actual, 'go', ['test', './internal/thread'])
                with patch.object(policy.Path, 'cwd', return_value=foreign):
                    policy.check(actual, 'go', ['build', './...'])
                    policy.check(actual, 'go', ['-C', str(actual), 'test', './internal/thread'])
            (folder / 'context.json').unlink()
            folder.rmdir()
            (actual / '.git/pyry-test-managed').touch()
            with patch.object(policy.Path, 'cwd', return_value=actual), self.assertRaises(policy.PolicyError):
                policy.check(actual, 'go', ['test', './internal/thread'])


if __name__ == '__main__':
    unittest.main()
