import base64
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('fleet-native.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Tests(unittest.TestCase):
    def test_only_a_native_helpers_actual_container_delays_restart(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'tasks').mkdir()
            adapter=module.NativeAdapter({'stateDirectory':d,'platform':'linux','projects':{'org/core':{'container':'core'}}})
            adapter.status=lambda:{'machine':'box','runs':[{'machine':'box','supportTaskId':'helper'}]}
            receipt=root/'tasks/helper.receipt.json'
            receipt.write_text(json.dumps({'container':'mobile'}));self.assertFalse(adapter.helpers_active('org/core'))
            receipt.write_text(json.dumps({'container':'core'}));self.assertTrue(adapter.helpers_active('org/core'))
            adapter.config['platform']='mac';self.assertFalse(adapter.helpers_active('org/core'))

    def test_publish_snapshot_retains_late_verdict_and_archives_old_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);destination=root/'publish';destination.mkdir();(root/'state').mkdir()
            (destination/'verdict.md').write_text('older retained verdict')
            adapter=module.NativeAdapter({'stateDirectory':str(root/'state'),'platform':'linux','projects':{'org/core':{'container':'fixed','publishStorage':str(destination)}}})
            def copy(args,**kwargs):
                snapshot=Path(args[-1]);(snapshot/'verdict.md').write_text('completed before drain')
                return ''
            with patch.object(module,'execute',side_effect=copy):adapter.retain_publish_files('org/core')
            self.assertEqual((destination/'verdict.md').read_text(),'completed before drain')
            self.assertIn('older retained verdict',[p.read_text() for p in (root/'state').rglob('verdict.md')])

    def test_mac_start_finds_user_cli_with_service_path_and_keeps_secrets_out(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            user_bin = root / '.local' / 'bin'
            user_bin.mkdir(parents=True)
            claude = user_bin / 'claude'
            claude.write_text('#!/bin/sh\nexit 0\n')
            claude.chmod(0o755)
            adapter = module.NativeAdapter({'stateDirectory': str(root), 'platform': 'mac',
                'projects': {'org/mobile': {'agents': str(root / 'agents'), 'access': 'workload-access'}}})
            parent = {'HOME': str(root), 'PATH': '/usr/bin:/bin', 'OP_SERVICE_ACCOUNT_TOKEN': 'fixture-secret'}
            with patch.dict(os.environ, parent, clear=True), patch.object(module.subprocess, 'Popen') as launch:
                adapter.start('org/mobile')
            child = launch.call_args.kwargs['env']
            self.assertEqual(shutil.which('claude', path=child['PATH']), str(claude))
            self.assertIn('/usr/bin', child['PATH'].split(os.pathsep))
            self.assertNotIn('OP_SERVICE_ACCOUNT_TOKEN', child)
            self.assertEqual(child['PYRY_AUTOMATION_ACCESS'], 'workload-access')

    def test_linux_preflight_reads_canonical_container_secret(self):
        root=Path(tempfile.mkdtemp())
        adapter=module.NativeAdapter({'stateDirectory':str(root),'platform':'linux','projects':{'org/core':{'githubSecret':'canonical-secret'}}})
        calls=[]
        with patch.object(module,'execute',side_effect=lambda args,**kwargs:calls.append(args) or json.dumps([{'SecretData':'fixture-only'}])),patch.object(module,'credential_probe',side_effect=lambda env,salt,project:{'ok':env=={'GITHUB_TOKEN':'fixture-only'}}):
            self.assertTrue(adapter.expected('org/core')['ok'])
        self.assertEqual(calls,[['podman','secret','inspect','--showsecret','canonical-secret']])
    def test_container_probe_executes_complete_python_source(self):
        root=Path(tempfile.mkdtemp())
        adapter=module.NativeAdapter({'stateDirectory':str(root),'platform':'linux','projects':{'org/core':{'container':'fixed-container','containerTarget':'/work/core','containerAgents':'/work/core-agents'}}})
        captured=[]
        with patch.object(module,'execute',side_effect=lambda args,**kwargs:captured.append(args) or '{"pid":1}'):
            self.assertEqual(adapter.container_probe('org/core')['pid'],1)
        invocation=captured[0][-1]
        literal=invocation.split("base64.b64decode('",1)[1].split("')",1)[0]
        source=base64.b64decode(literal).decode()
        compile(source,'configured-container-probe','exec')

    def test_credential_shadow_fails_before_any_authentication(self):
        with patch.object(module.urllib.request,'urlopen',side_effect=AssertionError('No HTTP request allowed')):
            self.assertFalse(module.credential_probe({'GH_TOKEN':'first','GITHUB_TOKEN':'second'},'salt','org/core')['ok'])

class CredentialPollingTests(unittest.TestCase):
    def adapter(self):
        return module.NativeAdapter({'stateDirectory':tempfile.mkdtemp(),'operator':'legacy-wrapper','platform':'mac','projects':{}})
    def test_successful_lookup_is_reused_after_a_day_until_explicit_refresh(self):
        adapter=self.adapter()
        with patch.object(module.time,'monotonic',side_effect=[0,300,86401,86402]),patch.object(adapter,'read_expected',side_effect=[{'ok':True,'credential':'first'},{'ok':True,'credential':'rotated'}]) as read:
            self.assertEqual(adapter.expected('org/core')['credential'],'first')
            self.assertEqual(adapter.expected('org/core')['credential'],'first')
            self.assertEqual(adapter.expected('org/core')['credential'],'first')
            adapter.refresh_credentials()
            self.assertEqual(adapter.expected('org/core')['credential'],'rotated')
        self.assertEqual(read.call_count,2)
    def test_failed_lookup_waits_then_retries(self):
        adapter=self.adapter()
        with patch.object(module.time,'monotonic',side_effect=[0,300,3599,3600]),patch.object(adapter,'read_expected',side_effect=[RuntimeError('rate limited'),{'ok':True}]) as read:
            with self.assertRaises(RuntimeError):adapter.expected('org/core')
            with self.assertRaises(RuntimeError):adapter.expected('org/core')
            # An automatic preflight must not bypass failure backoff.
            with self.assertRaises(RuntimeError):adapter.expected('org/core',refresh=True)
            self.assertTrue(adapter.expected('org/core')['ok'])
        self.assertEqual(read.call_count,2)
    def test_rejected_authentication_waits_before_retry(self):
        adapter=self.adapter()
        with patch.object(module.time,'monotonic',side_effect=[0,300,3600]),patch.object(adapter,'read_expected',side_effect=[{'ok':False},{'ok':True}]) as read:
            self.assertFalse(adapter.expected('org/core')['ok'])
            self.assertFalse(adapter.expected('org/core',refresh=True)['ok'])
            self.assertTrue(adapter.expected('org/core')['ok'])
        self.assertEqual(read.call_count,2)
    def test_mac_probe_loads_only_github_credential(self):
        adapter=self.adapter();adapter.config.update(python='python3',projects={'org/core':{'agents':'/configured/agents','access':'dedicated-access','githubOnlyProbe':True}})
        with patch.object(module,'execute',return_value='{"ok":true}') as run:
            self.assertTrue(adapter.read_expected('org/core')['ok'])
        self.assertIn('--only-vars=GITHUB_TOKEN',run.call_args.args[0])
    def test_operation_preflight_rechecks_even_with_cached_credential(self):
        adapter=self.adapter();adapter.config['projects']={'org/core':{'agents':'/configured/agents'}}
        with patch.object(adapter,'read_expected',return_value={'ok':True,'credential':'first'}) as read,patch.object(module,'execute',side_effect=['','','main']):
            adapter.expected('org/core')
            self.assertTrue(adapter.preflight('org/core',{'credential':'first'}))
        self.assertEqual(read.call_count,2)
    def test_configured_control_command_avoids_reloading_operator_credentials(self):
        adapter=self.adapter();adapter.config['operatorCommand']=['node','fleet-bin'];adapter.config['operatorConfig']='/configured/operator.json'
        with patch.object(module,'execute',return_value='{}') as execute:
            adapter.status()
        self.assertEqual(execute.call_args.args[0],['node','fleet-bin','status','/configured/operator.json'])

if __name__=='__main__':unittest.main()
