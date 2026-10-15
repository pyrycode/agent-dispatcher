import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('acceptance', Path(__file__).with_name('runtime-acceptance.py'))
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class AcceptanceTests(unittest.TestCase):
    def test_disposable_startup_and_platform_both_have_to_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            command = [sys.executable, '-c', 'raise SystemExit(0)']
            config = {'directory': directory, 'disposableStartup': command, 'platformProbe': command}
            self.assertTrue(acceptance.accept(config)['accepted'])
            self.assertFalse(acceptance.accept({**config, 'platformProbe': [sys.executable, '-c', 'raise SystemExit(1)']})['accepted'])

    def test_timeout_cleans_child_before_returning_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(acceptance.supervised([sys.executable, '-c', 'import time; time.sleep(60)'], directory, 0.05))

    def test_no_implicit_command_or_live_startup_default(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                acceptance.supervised('shell command', directory, 1)
            with self.assertRaises(KeyError):
                acceptance.accept({'directory': directory})
