import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('supervisor',Path(__file__).with_name('fleet-supervisor.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
PROJECT='org/core'

class CredentialRefreshSignalTests(unittest.TestCase):
    def test_verified_control_update_reloads_supervisor_source(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/'fleet-supervisor.py').write_bytes(Path(__file__).with_name('fleet-supervisor.py').read_bytes())
            (root/'fleet-native.py').write_text('''from pathlib import Path
class NativeAdapter:
    def __init__(self, config): self.marker=Path(config['marker']); self.reloaded=self.marker.exists()
    def desired(self): return {}
    def attention(self): return {'reloaded': self.reloaded}
    def publish_attention(self): pass
''')
            (root/'fleet-control.py').write_text('''def sync_control(adapter, config):
    if adapter.reloaded: return False
    adapter.marker.write_text('verified')
    return True
''')
            report=root/'report.json'
            config=root/'config.json'
            config.write_text(json.dumps({'stateDirectory':str(root/'state'),'reportFile':str(report),'projects':{},'control':{'enabled':True},'marker':str(root/'marker')}))
            config.chmod(0o600)
            result=subprocess.run([sys.executable,str(root/'fleet-supervisor.py'),str(config),'--once'],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertTrue(json.loads(report.read_text()).get('reloaded'),report.read_text())

    def test_signal_refreshes_without_restarting_supervisor(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/'fleet-supervisor.py').write_bytes(Path(__file__).with_name('fleet-supervisor.py').read_bytes())
            (root/'fleet-native.py').write_text('''class NativeAdapter:
    def __init__(self, config): self.refreshes=0
    def desired(self): return {}
    def refresh_credentials(self): self.refreshes+=1
    def attention(self): return {'refreshes': self.refreshes}
    def publish_attention(self): pass
''')
            report=root/'report.json'
            config=root/'config.json'
            config.write_text(json.dumps({'stateDirectory':str(root/'state'),'reportFile':str(report),'projects':{},'intervalSeconds':0.02}))
            config.chmod(0o600)
            process=subprocess.Popen([sys.executable,str(root/'fleet-supervisor.py'),str(config)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            try:
                deadline=time.monotonic()+5
                while not report.exists() and time.monotonic()<deadline: time.sleep(0.02)
                self.assertTrue(report.exists())
                process.send_signal(signal.SIGHUP)
                while time.monotonic()<deadline:
                    if json.loads(report.read_text()).get('refreshes')==1: break
                    time.sleep(0.02)
                self.assertEqual(json.loads(report.read_text())['refreshes'],1)
                self.assertIsNone(process.poll())
            finally:
                process.terminate();process.wait(timeout=5);process.stderr.close()

class Adapter:
    def __init__(self):
        self.current={'identity':{'pid':20,'start':'birth'},'generation':'old','healthy':True,'stopped':False,'childrenStopped':False}
        self.calls=[]
        self.state={'machine':'mac','draining':False,'drainingProjects':['other/repo'],'claims':[{'ticket':PROJECT+'#1','machine':'mac','generation':'owner'},{'ticket':PROJECT+'#@reconcile','machine':'mac','generation':'temporary'}],'runs':[]}
    def observe(self,p):return self.current.copy()
    def preflight(self,p,d):return True
    def status(self):return self.state
    def drain(self,p,i):self.calls.append('drain')
    def update(self,p,d):self.calls.append('update')
    def start(self,p):self.calls.append('start');self.current={'identity':{'pid':21},'generation':'new','healthy':True,'stopped':False,'childrenStopped':False}
    def verify(self,p,d):return self.current['generation']==d and self.current['healthy']

class Tests(unittest.TestCase):
    def setUp(self):self.directory=Path(tempfile.mkdtemp());self.adapter=Adapter();self.worker=module.Supervisor(self.directory,self.adapter,lambda:1000)
    def receipt(self):return self.directory/'org_core.json'
    def test_external_native_helper_does_not_hold_a_drained_product_worker(self):
        self.worker.tick(PROJECT,'new')
        self.adapter.current.update(stopped=True,childrenStopped=True)
        self.adapter.state['runs']=[{'machine':'mac','project':PROJECT,'supportTaskId':'native'}]
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.assertEqual(self.adapter.calls,['drain','update','start'])
    def test_container_helper_finishes_before_first_drain_signal(self):
        self.adapter.helpers_active=lambda project:True
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'waiting-for-native-task')
        self.assertEqual(self.adapter.calls,[])
        self.adapter.helpers_active=lambda project:False
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'draining')
        self.adapter.current.update(stopped=True,childrenStopped=True)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.assertEqual(self.adapter.calls,['drain','update','start'])
    def test_confirmed_assessment_release_is_not_lost_delivery_work(self):
        self.worker.tick(PROJECT,'new')
        self.adapter.current.update(stopped=True,childrenStopped=True)
        self.adapter.state['claims']=[]
        self.adapter.state['releasedAssessmentClaims']=[{'ticket':PROJECT+'#1','machine':'mac','generation':'owner'}]
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
    def test_release_proof_must_match_the_saved_owner_and_generation(self):
        for machine,generation in [('other','owner'),('mac','other')]:
            self.setUp()
            self.worker.tick(PROJECT,'new')
            self.adapter.current.update(stopped=True,childrenStopped=True)
            self.adapter.state['claims']=[]
            self.adapter.state['releasedAssessmentClaims']=[{'ticket':PROJECT+'#1','machine':machine,'generation':generation}]
            self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
    def test_one_signal_children_and_ownership(self):
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'draining')
        self.worker=module.Supervisor(self.directory,self.adapter,lambda:1100)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'draining')
        self.assertEqual(self.adapter.calls,['drain'])
        self.adapter.current.update(stopped=True,childrenStopped=False)
        self.worker.tick(PROJECT,'new');self.assertEqual(self.adapter.calls,['drain'])
        self.adapter.current.update(childrenStopped=True)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.assertEqual(self.adapter.calls,['drain','update','start'])
        self.worker.tick(PROJECT,'new');self.assertEqual(self.adapter.calls,['drain','update','start'])
    def test_uncertain_signal_is_never_repeated(self):
        self.worker.tick(PROJECT,'new')
        state=json.loads(self.receipt().read_text());state['phase']='drain-requested';module.atomic(self.receipt(),state)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
        self.assertEqual(self.adapter.calls,['drain'])
    def test_uncertain_start_is_never_repeated(self):
        self.worker.tick(PROJECT,'new')
        state=json.loads(self.receipt().read_text());state['phase']='start-requested';module.atomic(self.receipt(),state)
        self.adapter.current.update(stopped=True,childrenStopped=True)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
        self.assertEqual(self.adapter.calls,['drain'])
    def test_missing_preflight_does_not_drain(self):
        self.adapter.preflight=lambda p,d:False
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'preflight-failed');self.assertEqual(self.adapter.calls,[])
    def test_repeated_health_failure_does_not_restart_again(self):
        self.worker.tick(PROJECT,'new');self.adapter.current.update(stopped=True,childrenStopped=True)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.adapter.current.update(healthy=False)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
        self.assertEqual(self.adapter.calls,['drain','update','start'])
    def test_startup_probe_can_wait_without_repeating_the_start(self):
        self.worker.tick(PROJECT,'new');self.adapter.current.update(stopped=True,childrenStopped=True)
        self.adapter.verify=lambda p,d: (_ for _ in ()).throw(RuntimeError('Startup lock not written yet'))
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'verifying')
        observe=self.adapter.observe
        self.adapter.observe=lambda p: (_ for _ in ()).throw(RuntimeError('Workload warming up'))
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'verifying')
        self.adapter.observe=observe;self.adapter.verify=lambda p,d:True
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.assertEqual(self.adapter.calls,['drain','update','start'])
    def test_stopped_service_is_preserved(self):
        self.adapter.current.update(stopped=True,childrenStopped=True)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'stopped');self.assertEqual(self.adapter.calls,[])
    def test_retained_run_does_not_start(self):
        self.worker.tick(PROJECT,'new');self.adapter.current.update(stopped=True,childrenStopped=True)
        self.adapter.state['runs']=[{'machine':'mac','project':PROJECT}]
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention');self.assertEqual(self.adapter.calls,['drain'])
    def test_temporary_coordination_claim_is_not_ticket_ownership(self):
        self.worker.tick(PROJECT,'new');self.adapter.current.update(stopped=True,childrenStopped=True)
        self.adapter.state['claims']=self.adapter.state['claims'][:1]
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
    def test_policy_change_stays_pending(self):
        self.worker.tick(PROJECT,'new');self.adapter.current.update(stopped=True,childrenStopped=True)
        self.adapter.state['drainingProjects']=[]
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention');self.assertNotIn('start',self.adapter.calls)
    def test_changed_pid_before_drain_is_preserved(self):
        self.adapter.preflight=lambda p,d:self.adapter.current.update(identity={'pid':22}) or True
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'changed-before-drain');self.assertEqual(self.adapter.calls,[])

if __name__=='__main__':unittest.main()
