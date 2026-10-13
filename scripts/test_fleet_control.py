import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('fleet_control', Path(__file__).with_name('fleet-control.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ControllerScannerInstallTests(unittest.TestCase):
    def fixture(self, directory, current):
        root = Path(directory)
        repo = root / 'controller'
        (repo / 'scripts').mkdir(parents=True)
        (repo / 'scripts/install-gitleaks.py').write_text('# fixture installer')
        state = root / 'state'
        state.mkdir()
        config = {'stateDirectory': str(state), 'control': {'repository': str(repo),
                  'components': [{'name': 'claims', 'restart': ['restart-configured-claims']}]}}
        adapter = Mock()
        adapter.operator.return_value = {'desired': 'new', 'centralLoaded': 'old'}
        adapter.status.return_value = {'machine': 'box', 'controlRevision': 'old'}
        calls = []

        def command(args, cwd=None):
            calls.append(args)
            if args == ['git', 'branch', '--show-current']: return 'main'
            if args == ['git', 'rev-parse', 'HEAD']: return current
            if args[:3] == ['git', 'diff', '--name-only']: return 'package.json'
            return ''

        return config, adapter, calls, command, repo

    def test_frozen_install_and_scanner_verification_precede_controller_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            config, adapter, calls, command, repo = self.fixture(directory, 'old')
            with patch.object(module, 'command', side_effect=command), patch.object(module.subprocess, 'run', side_effect=lambda args, **kwargs: calls.append(args)):
                self.assertFalse(module.sync_control(adapter, config))
            dependency = calls.index(['pnpm', 'install', '--frozen-lockfile'])
            scanner = calls.index(['python3', str(repo / 'scripts/install-gitleaks.py')])
            restart = calls.index(['restart-configured-claims'])
            self.assertLess(dependency, scanner)
            self.assertLess(scanner, restart)

    def test_scanner_failure_on_already_updated_checkout_does_not_restart_or_advance(self):
        with tempfile.TemporaryDirectory() as directory:
            config, adapter, calls, command, repo = self.fixture(directory, 'new')

            def failing(args, cwd=None):
                if args[0] == 'python3':
                    calls.append(args)
                    raise RuntimeError('Scanner install failed')
                return command(args, cwd)

            with patch.object(module, 'command', side_effect=failing), patch.object(module.subprocess, 'run') as run:
                with self.assertRaises(RuntimeError): module.sync_control(adapter, config)
                run.assert_not_called()
            self.assertIn(['python3', str(repo / 'scripts/install-gitleaks.py')], calls)
            self.assertFalse((Path(config['stateDirectory']) / 'control-ready.json').exists())
            self.assertFalse((Path(config['stateDirectory']) / 'control.json').exists())
            # The ordinary next cycle can retry installation before its one restart.
            with patch.object(module, 'command', side_effect=command), patch.object(module.subprocess, 'run') as run:
                self.assertFalse(module.sync_control(adapter, config))
                run.assert_called_once()
                self.assertEqual(run.call_args.args[0], ['restart-configured-claims'])


if __name__ == '__main__':
    unittest.main()
