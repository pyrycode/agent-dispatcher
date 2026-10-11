import base64
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('fleet-native.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Tests(unittest.TestCase):
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

if __name__=='__main__':unittest.main()
