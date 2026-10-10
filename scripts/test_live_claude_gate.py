import importlib.util
import json
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('live_gate',Path(__file__).with_name('live-claude-gate.py'))
gate=importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

class LiveCountsTest(unittest.TestCase):
    def test_go_counts_leaf_tests_and_fails_zero_or_failed(self):
        events=[{'Action':'pass','Test':'TestOne','Package':'live'}, {'Action':'skip','Test':'TestSkip','Package':'live'}, {'Action':'pass','Package':'live'}]
        self.assertEqual(gate.test_counts('go','\n'.join(json.dumps(e) for e in events)),(1,1))
        self.assertEqual(gate.test_counts('go',json.dumps({'Action':'fail','Test':'TestOne','Package':'live'})),(1,0))
        self.assertEqual(gate.test_counts('go',''),(0,0))
        nested=events+[{'Action':'pass','Test':'TestOne/sub','Package':'live'}]
        self.assertEqual(gate.test_counts('go','\n'.join(json.dumps(e) for e in nested)),(1,1))

    def test_playwright_counts_actual_results_not_skips(self):
        report={'suites':[{'specs':[{'tests':[{'results':[{'status':'passed'}]},{'results':[{'status':'skipped'}]},{'results':[{'status':'failed'}]}]}]}]}
        self.assertEqual(gate.test_counts('desktop',json.dumps(report)),(2,1))
        self.assertEqual(gate.test_counts('desktop',json.dumps({'suites':[]})),(0,0))

import contextlib
import io
import os
import subprocess
import sys
from unittest.mock import Mock,patch

class LiveLauncherTest(unittest.TestCase):
    def test_login_survives_a_vault_rename(self):
        def renamed_account(argv, **kwargs):
            # The fixture account has one vault, now named SV - Dev agents.
            if any("op://Dev agents/" in arg for arg in argv):
                return Mock(returncode=1, stdout="", stderr="old vault missing")
            self.assertEqual(argv, ["op", "read", "--no-newline", "op://kmzgpgsyeesea3pkiuk2ul2phq/Claude long term token/password"])
            self.assertEqual(kwargs["env"]["OP_BIOMETRIC_UNLOCK_ENABLED"], "false")
            return Mock(returncode=0, stdout="renamed-vault-login\n")
        with patch.object(gate.subprocess, "run", side_effect=renamed_account):
            child = gate.live_claude_environment({"OP_SERVICE_ACCOUNT_TOKEN": "restricted-fixture"})
        self.assertEqual(child["CLAUDE_CODE_OAUTH_TOKEN"], "renamed-vault-login")
        self.assertNotIn("OP_SERVICE_ACCOUNT_TOKEN", child)

    def test_fetch_failure_stops_before_test_and_prints_no_secret(self):
        output=io.StringIO()
        with patch.dict(os.environ,{'OP_SERVICE_ACCOUNT_TOKEN':'restricted-fixture'},clear=True), patch.object(sys,'argv',['gate','go','--tests','^TestOne$']), patch.object(gate.subprocess,'run',return_value=Mock(returncode=1,stdout='',stderr='restricted-fixture')) as run, contextlib.redirect_stderr(output):
            self.assertEqual(gate.main(),2)
        self.assertEqual(run.call_count,1)
        self.assertIn('environment error',output.getvalue())
        self.assertNotIn('restricted-fixture',output.getvalue())

    def test_child_gets_login_only_and_counted_pass_redacts_both_credentials(self):
        output=io.StringIO()
        results=[Mock(returncode=0,stdout='login-fixture'),Mock(returncode=0,stdout='{"loggedIn":true}'),Mock(returncode=0,stdout='{"Action":"pass","Test":"TestOne","Package":"live"}\n',stderr='restricted-fixture login-fixture')]
        with patch.dict(os.environ,{'OP_SERVICE_ACCOUNT_TOKEN':'restricted-fixture','OP_SESSION_personal':'personal-fixture'},clear=True), patch.object(sys,'argv',['gate','go','--tests','^TestOne$']), patch.object(gate.subprocess,'run',side_effect=results) as run, contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(gate.main(),0)
        child=run.call_args.kwargs['env']
        self.assertEqual(child['CLAUDE_CODE_OAUTH_TOKEN'],'login-fixture')
        self.assertNotIn('OP_SERVICE_ACCOUNT_TOKEN',child)
        self.assertNotIn('OP_SESSION_personal',child)
        self.assertNotIn('restricted-fixture',output.getvalue())
        self.assertNotIn('login-fixture',output.getvalue())
        self.assertIn('1 executed; 1 passed',output.getvalue())

    def test_zero_execution_is_failure_even_with_successful_child(self):
        output=io.StringIO()
        with patch.dict(os.environ,{'CLAUDE_CODE_OAUTH_TOKEN':'login-fixture'},clear=True), patch.object(sys,'argv',['gate','desktop','--spec','e2e/real-name.spec.ts','--tests','one title']), patch.object(gate.subprocess,'run',side_effect=[Mock(returncode=0,stdout='{"loggedIn":true}'),Mock(returncode=0,stdout='{"suites":[]}',stderr='')]), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(gate.main(),1)
        self.assertIn('0 executed; 0 passed',output.getvalue())
