"""scripts/install-deps.sh and the store switch that stopped pyrybox's Desktop
dispatcher on 2026-10-13. Real pnpm, offline: the test package depends only
on a local folder, so nothing is downloaded."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PNPM = shutil.which('pnpm')


@unittest.skipIf(PNPM is None, 'pnpm is not installed')
class InstallDepsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = self.tmp / 'dispatcher'
        (self.root / 'scripts').mkdir(parents=True)
        shutil.copy(REPO / 'scripts' / 'install-deps.sh', self.root / 'scripts' / 'install-deps.sh')
        shutil.copy(REPO / 'pnpm-workspace.yaml', self.root / 'pnpm-workspace.yaml')
        (self.root / 'dep').mkdir()
        (self.root / 'dep' / 'package.json').write_text(json.dumps({'name': 'local-dep', 'version': '1.0.0'}))
        (self.root / 'package.json').write_text(json.dumps(
            {'name': 'fixture', 'version': '1.0.0', 'private': True, 'dependencies': {'local-dep': 'file:./dep'}}))
        self.env = {k: v for k, v in os.environ.items() if k != 'CI'}
        # The layout before 9851390: node_modules built against a store elsewhere.
        self.run_ok([PNPM, 'install', '--store-dir', str(self.tmp / 'old-store')])
        (self.root / '.npmrc').write_text('store-dir=.pnpm-store\n')

    def run_ok(self, cmd):
        result = self.run_cmd(cmd)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def run_cmd(self, cmd):
        return subprocess.run(cmd, cwd=self.root, env=self.env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=120)

    def store_dir(self):
        return (self.root / 'node_modules' / '.modules.yaml').read_text()

    def test_script_switches_the_store_unattended(self):
        result = self.run_ok(['bash', str(self.root / 'scripts' / 'install-deps.sh')])
        self.assertIn(str(self.root / '.pnpm-store'), self.store_dir())
        self.assertEqual(result.stderr, '', 'a clean install stays quiet in the log')

    def test_existing_silent_launcher_line_survives_the_switch(self):
        # Launchers not yet moved to the script still run this exact line.
        self.run_ok([PNPM, 'install', '--silent'])
        self.assertIn(str(self.root / '.pnpm-store'), self.store_dir())

    def test_without_the_workspace_setting_the_silent_line_fails_with_no_message(self):
        # The 2026-10-13 failure, reproduced, so the setting is shown to matter.
        text = (self.root / 'pnpm-workspace.yaml').read_text().replace('confirmModulesPurge: false', '')
        (self.root / 'pnpm-workspace.yaml').write_text(text)
        result = self.run_cmd([PNPM, 'install', '--silent'])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout + result.stderr, '')

    def test_a_failure_is_visible_and_keeps_its_status(self):
        # A frozen lockfile refuses a package.json that no longer matches it.
        manifest = json.loads((self.root / 'package.json').read_text())
        manifest['dependencies']['other-dep'] = 'file:./dep'
        (self.root / 'package.json').write_text(json.dumps(manifest))
        result = self.run_cmd(['bash', str(self.root / 'scripts' / 'install-deps.sh')])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ERR_PNPM_OUTDATED_LOCKFILE', result.stderr)
        self.assertIn('[dispatcher install] pnpm install failed with status', result.stderr)


class WorkspaceSettingTests(unittest.TestCase):
    def test_store_switch_needs_no_confirmation(self):
        self.assertIn('\nconfirmModulesPurge: false\n', (REPO / 'pnpm-workspace.yaml').read_text())


if __name__ == '__main__':
    unittest.main()
