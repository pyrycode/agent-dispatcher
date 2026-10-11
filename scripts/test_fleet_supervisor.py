import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('supervisor',Path(__file__).with_name('fleet-supervisor.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
PROJECT='org/core'

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
