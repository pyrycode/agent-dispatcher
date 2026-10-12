import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('support',Path(__file__).with_name('fleet-support.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class SupportTests(unittest.TestCase):
 def test_android_failure_returns_ordered_recorder_and_launcher_diagnostics(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);capture=directory/'capture';capture.mkdir()
   driver=directory/'core/internal/e2e/realclaude/tool_then_text_mobile_capture.py'
   driver.parent.mkdir(parents=True);driver.write_text('approved driver')
   records={'daemon-1.stdout':'{"type":"stream_event","event":{"type":"message_start"}}\n{"type":"result"}\n',
            'daemon-1.manifest.json':'{"dropped_rows":0}',
            'driver.json':'{"exit_code":1}',
            'mobile.xml':'<testsuite tests="1" failures="1"/>',
            'launcher.stderr':'x86_64 emulation currently requires hardware acceleration!\n',
            'launcher.stdout':'counted diagnostic output\n'}
   for name,data in records.items():(capture/name).write_text(data)
   (capture/'unrelated.bin').write_bytes(b'not portable evidence')
   def execute(argv,cwd,log,env):
    log.write_text('#2939 private recovery: '+str(capture)+'\n');return 1
   with patch.object(m,'clone'),patch.object(m,'execute',side_effect=execute):
    result=m.native_recipe({'request':{'recipe':'android-tool-then-text','revision':'a'*40}},
       {'core':'core','mobile':'mobile','mobileAgents':'mobile-agents','coreAgents':'core-agents'},directory)
   self.assertEqual(result['outcome'],'failed')
   self.assertEqual(result['files'],{'mobile/'+name:data for name,data in records.items()})
   self.assertIn('do not establish a passing method',result['summary'])
 def test_updating_container_admits_no_new_native_helpers(self):
  with tempfile.TemporaryDirectory() as d:
   class Adapter:pass
   route={'capability':'android-emulator','container':'mobile'}
   s=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'projects':{'org/mobile':{'container':'mobile'}},'recoveryTasks':{}})
   Path(d,'org_mobile.json').write_text(json.dumps({'phase':'draining'}))
   with patch.object(m,'route_available',return_value=True):self.assertFalse(s.route_ready(route))
   Path(d,'org_mobile.json').write_text(json.dumps({'phase':'complete'}))
   with patch.object(m,'route_available',return_value=True):self.assertTrue(s.route_ready(route))
 def test_probe_never_claims_candidate_execution(self):
  with tempfile.TemporaryDirectory() as d:
   result=m.native_recipe({'request':{'recipe':'platform-probe'}},{},Path(d))
   self.assertEqual(result['outcome'],'completed')
   self.assertFalse(json.loads(result['files']['platform.json'])['candidate_tests_executed'])
 def test_arbitrary_recipe_has_no_command_execution(self):
  with tempfile.TemporaryDirectory() as d,patch.object(m.subprocess,'Popen') as spawn:
   with self.assertRaises(RuntimeError):m.native_recipe({'request':{'recipe':'arbitrary-shell','command':'touch bad'}},{},Path(d))
   spawn.assert_not_called()
 def test_native_tests_do_not_receive_fleet_credentials(self):
  with patch.dict(m.os.environ,{'FLEET_ADMIN':'private','GITHUB_TOKEN':'private','PYRY_MANAGER_TOKEN':'private','PATH':'path'}):
   env=m.clean_env()
   self.assertNotIn('FLEET_ADMIN',env);self.assertNotIn('GITHUB_TOKEN',env);self.assertNotIn('PYRY_MANAGER_TOKEN',env)
   self.assertEqual(env['PATH'],'path')
 def test_result_does_not_release_admission_while_worker_is_alive(self):
  with tempfile.TemporaryDirectory() as d:
   class Adapter:
    def status(self):return {'machine':'mac','draining':False}
   s=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'recoveryTasks':{'platform-probe:macos-arm64':{'capability':'macos-arm64'}}})
   result=Path(d)/'result.json';result.write_text(json.dumps({'outcome':'completed','summary':'probe','files':{}}))
   receipt=s.directory/'job.receipt.json';m.atomic(receipt,{'id':'job','session':'s','phase':'running','pid':123,'result':str(result)})
   calls=[];s.rpc=lambda op,body:calls.append(op) or []
   class Child:
    def poll(self):return None
   s.children[123]=Child();s.tick()
   self.assertNotIn('complete',calls)
   self.assertEqual(json.loads(receipt.read_text())['phase'],'running')
 def test_missing_terminal_result_escalates_without_repeating_the_worker(self):
  with tempfile.TemporaryDirectory() as d:
   class Adapter:
    def status(self):return {'machine':'mac','draining':False}
   s=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'recoveryTasks':{'platform-probe:macos-arm64':{'capability':'macos-arm64'}}})
   receipt=s.directory/'job.receipt.json';m.atomic(receipt,{'id':'job','session':'s','phase':'launch-requested','result':str(Path(d)/'absent')})
   calls=[];s.rpc=lambda op,body:calls.append(op) or []
   with patch.object(m,'route_available',return_value=True),patch.object(m.subprocess,'Popen') as spawn:s.tick();s.tick();spawn.assert_not_called()
   self.assertEqual(calls.count('uncertain'),1)
   self.assertEqual(json.loads(receipt.read_text())['phase'],'attention')
if __name__=='__main__':unittest.main()
