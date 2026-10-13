import importlib.util
import io
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

def quiet(directory,clock):
    return module.Housekeeping(directory,clock,stream=io.StringIO())

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
        now=[1000];self.worker=module.Supervisor(self.directory,self.adapter,lambda:now[0],housekeeping=quiet(self.directory,lambda:now[0]),monotonic=lambda:now[0])
        self.worker.tick(PROJECT,'new');self.adapter.current.update(stopped=True,childrenStopped=True)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.adapter.current.update(healthy=False)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        now[0]+=module.DEFAULTS['healthFailureConfirmSeconds']
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

CONFIRM=module.DEFAULTS['healthFailureConfirmSeconds']
CLEAR=module.DEFAULTS['healthLatchClearSeconds']

class StaleStateTests(unittest.TestCase):
    """Modelled on the stale supervisor state cleared by hand on 2026-10-13."""
    def setUp(self):
        self.directory=Path(tempfile.mkdtemp());self.adapter=Adapter();self.now=[1000]
        self.worker=self.supervisor()
    def supervisor(self):
        clock=lambda:self.now[0]
        return module.Supervisor(self.directory,self.adapter,clock,housekeeping=quiet(self.directory,clock),monotonic=clock)
    def receipt(self):return self.directory/'org_core.json'
    def verified(self,desired='new'):
        self.worker.tick(PROJECT,desired);self.adapter.current.update(stopped=True,childrenStopped=True)
        self.assertEqual(self.worker.tick(PROJECT,desired)['phase'],'complete')
    def latch(self):
        self.verified()
        self.adapter.current.update(healthy=False)
        self.worker.tick(PROJECT,'new');self.now[0]+=CONFIRM
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
    def archives(self,kind):return sorted(self.directory.glob('auto-'+kind+'-*'))
    def log(self):return [json.loads(line) for line in (self.directory/'housekeeping.jsonl').read_text().splitlines()]

    def test_manager_restart_reporting_gap_is_not_a_health_failure(self):
        # pyrybox: manager restarted 17:14:53 for a controller update, Core latched 17:14:55.
        self.verified()
        self.adapter.current.update(healthy=False,reportingGap=True)
        for _ in range(4):
            self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete');self.now[0]+=CONFIRM
        self.adapter.current.update(healthy=True,reportingGap=False)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.assertEqual(self.adapter.calls,['drain','update','start'])
        self.assertEqual(json.loads(self.receipt().read_text())['phase'],'complete')

    def test_reporting_gap_without_a_receipt_does_not_restart_a_current_dispatcher(self):
        self.adapter.current.update(generation='new',healthy=False,reportingGap=True)
        for _ in range(3):
            result=self.worker.tick(PROJECT,'new');self.now[0]+=CONFIRM
            self.assertEqual(result['phase'],'current')
        self.assertEqual(self.adapter.calls,[])

    def test_short_reporting_blip_from_an_older_manager_does_not_latch(self):
        # A manager without its start time reports the gap as not-registered only.
        self.verified()
        self.adapter.current.update(healthy=False)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.now[0]+=120;self.adapter.current.update(healthy=True)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.now[0]+=CONFIRM;self.adapter.current.update(healthy=False)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.assertEqual(self.adapter.calls,['drain','update','start'])

    def test_genuine_repeated_health_failure_stays_latched_and_is_not_restarted(self):
        self.latch()
        # Short healthy spells do not clear it. The window starts over each time.
        for healthy in [False,True,False,True,False]:
            self.adapter.current.update(healthy=healthy);self.now[0]+=CLEAR//2
            self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
        self.worker=self.supervisor()
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
        self.assertEqual(self.adapter.calls,['drain','update','start'])
        self.assertEqual(self.archives('latch-cleared'),[])

    def test_latch_clears_after_sustained_health_and_unblocks_the_update(self):
        # Mac Core and Mobile: false latch on the old pins blocked the newer desired versions.
        self.latch()
        state=json.loads(self.receipt().read_text());state.pop('latch');module.atomic(self.receipt(),state)  # A record from before this change.
        self.adapter.current.update(healthy=True)
        for _ in range(3):
            self.assertEqual(self.worker.tick(PROJECT,'newer')['phase'],'attention');self.now[0]+=CLEAR//3
        result=self.worker.tick(PROJECT,'newer')
        self.assertEqual(result['phase'],'draining')
        self.assertIn('Health latch cleared automatically',result['reason'])
        self.assertEqual(self.adapter.calls,['drain','update','start','drain'])
        [folder]=self.archives('latch-cleared')
        self.assertEqual(json.loads((folder/'org_core.json').read_text())['reason'],module.HEALTH_LATCH_REASON)
        note=json.loads((folder/'archive.json').read_text())
        self.assertTrue(note['automatic']);self.assertIn('cleared automatically',note['reason'])
        self.assertEqual([e['kind'] for e in self.log()],['health-latch-cleared'])
        self.assertEqual(self.worker.housekeeping.recent()[0]['subject'],PROJECT)

    def test_paused_sampling_does_not_count_as_continuous_health(self):
        self.latch()
        self.adapter.current.update(healthy=True)
        self.worker.tick(PROJECT,'new');self.now[0]+=module.DEFAULTS['healthSampleGapSeconds']+1
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
        self.now[0]+=CLEAR-1
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')

    def test_cleared_latch_keeps_the_no_repeat_restart_window(self):
        self.latch()
        self.adapter.current.update(healthy=True)
        self.worker.tick(PROJECT,'new');self.now[0]+=CLEAR//2
        self.worker.tick(PROJECT,'new');self.now[0]+=CLEAR//2
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.adapter.current.update(healthy=False)
        self.worker.tick(PROJECT,'new');self.now[0]+=CONFIRM
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
        self.assertEqual(self.adapter.calls,['drain','update','start'])

    def open_record(self,phase,target='old-target',created=1000):
        module.atomic(self.receipt(),{'phase':phase,'project':PROJECT,'desired':target,'identity':{'pid':20,'start':'birth'},
            'childGroups':[],'created':created,'claims':{},'policy':['mac',False,['other/repo']]})

    def test_superseded_start_record_is_retired_without_the_six_hour_alert(self):
        # Fractal Relay: a 16:51 start record for older pins, after a later verified start.
        self.open_record('verifying')
        self.adapter.current={'identity':{'pid':30,'start':'later'},'generation':'new','healthy':True,'stopped':False,'childrenStopped':False}
        self.now[0]=1000+7*3600
        result=self.worker.tick(PROJECT,'new')
        self.assertEqual(result['phase'],'current')
        self.assertIn('Retired verifying record',result['reason'])
        self.assertFalse(self.receipt().exists())
        [folder]=self.archives('retired')
        self.assertEqual(json.loads((folder/'org_core.json').read_text())['desired'],'old-target')
        self.assertTrue(json.loads((folder/'archive.json').read_text())['automatic'])
        self.assertEqual([e['kind'] for e in self.log()],['operation-retired'])
        self.assertEqual(self.adapter.calls,[])

    def test_existing_six_hour_alert_for_superseded_pins_is_retired(self):
        self.open_record('attention');state=json.loads(self.receipt().read_text())
        state['reason']=module.SIX_HOUR_REASON;module.atomic(self.receipt(),state)
        self.adapter.current={'identity':{'pid':30,'start':'later'},'generation':'new','healthy':True,'stopped':False,'childrenStopped':False}
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'current')
        self.assertEqual(len(self.archives('retired')),1)

    def test_unfinished_record_still_alerts_when_not_superseded(self):
        self.open_record('verifying')
        self.adapter.current={'identity':{'pid':30,'start':'later'},'generation':'new','healthy':False,'stopped':False,'childrenStopped':False}
        self.now[0]=1000+7*3600
        result=self.worker.tick(PROJECT,'new')
        self.assertEqual(result['phase'],'attention');self.assertEqual(result['reason'],module.SIX_HOUR_REASON)
        self.assertEqual(self.archives('retired'),[])

    def test_drained_process_still_running_is_not_retired(self):
        self.open_record('draining',target='new')
        self.adapter.current={'identity':{'pid':20,'start':'birth'},'generation':'new','healthy':True,'stopped':False,'childrenStopped':False}
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'draining')
        self.assertTrue(self.receipt().exists());self.assertEqual(self.archives('retired'),[])

    def test_uncertain_drain_signal_is_never_retired(self):
        self.open_record('drain-requested')
        self.adapter.current={'identity':{'pid':30,'start':'later'},'generation':'new','healthy':True,'stopped':False,'childrenStopped':False}
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
        self.assertEqual(self.archives('retired'),[])

    def test_own_start_of_the_current_target_completes_with_its_checks(self):
        self.open_record('verifying',target='new')
        self.adapter.current={'identity':{'pid':30,'start':'later'},'generation':'new','healthy':True,'stopped':False,'childrenStopped':False}
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.assertEqual(self.archives('retired'),[])

class ReviewFollowUpTests(StaleStateTests):
    def test_failure_timer_ends_when_an_update_completes(self):
        # Reviewer's sequence: an old confirmation must not latch a later verified restart.
        self.adapter.current.update(healthy=False)
        self.assertEqual(self.worker.tick(PROJECT,'old')['phase'],'current')
        self.now[0]=1060;self.adapter.current.update(healthy=True)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'draining')
        self.now[0]=1120;self.adapter.current.update(stopped=True,childrenStopped=True)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.now[0]=1700;self.adapter.current.update(healthy=False)
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')
        self.assertEqual(self.adapter.calls,['drain','update','start'])

    def test_a_healthy_sample_on_any_version_ends_the_confirmation(self):
        self.verified()
        self.adapter.current.update(healthy=False)
        self.worker.tick(PROJECT,'new')
        self.now[0]+=CONFIRM//2;self.adapter.current.update(healthy=True,generation='other')
        self.worker.tick(PROJECT,'new')
        self.now[0]+=CONFIRM//2;self.adapter.current.update(healthy=False,generation='new')
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'complete')

    def started_elsewhere(self):
        self.adapter.current={'identity':{'pid':30,'start':'later'},'generation':'new','healthy':True,'stopped':False,'childrenStopped':False}

    def test_retiring_an_own_start_record_still_compares_ownership(self):
        for phase in ['verifying','start-requested']:
            self.setUp()
            self.open_record(phase)
            state=json.loads(self.receipt().read_text());state['claims']={PROJECT+'#1':['mac','owner']};module.atomic(self.receipt(),state)
            self.adapter.state['claims']=[{'ticket':PROJECT+'#1','machine':'mac','generation':'other'}]
            self.started_elsewhere()
            result=self.worker.tick(PROJECT,'new')
            self.assertEqual(result['phase'],'attention');self.assertIn('ownership changed',result['reason'])
            self.assertEqual(json.loads(self.receipt().read_text())['attentionFrom'],phase)
            self.assertEqual(self.archives('retired'),[])

    def test_retiring_an_own_start_record_still_compares_drain_policy(self):
        self.open_record('verifying')
        self.adapter.state['drainingProjects']=[]
        self.started_elsewhere()
        result=self.worker.tick(PROJECT,'new')
        self.assertEqual(result['phase'],'attention');self.assertIn('drain policy changed',result['reason'])
        self.assertEqual(self.archives('retired'),[])

    def fractal_relay_record(self):
        # Fractal Relay: start record saved at 16:51 while the project was drained.
        self.open_record('verifying')
        state=json.loads(self.receipt().read_text());state['policy']=['mac',False,['other/repo',PROJECT]];module.atomic(self.receipt(),state)
        self.adapter.state['drainingProjects']=['other/repo']
        self.started_elsewhere()

    def test_operator_resume_after_the_record_does_not_block_retirement(self):
        self.fractal_relay_record()
        # The operator resume at 19:44, about three hours after the record.
        self.adapter.state['projectDrainChanges']=[{'project':PROJECT,'draining':False,'at':(1000+3*3600)*1000}]
        result=self.worker.tick(PROJECT,'new')
        self.assertEqual(result['phase'],'current');self.assertIn('Retired verifying record',result['reason'])
        self.assertEqual(len(self.archives('retired')),1)

    def test_policy_change_without_an_operator_record_stays_in_attention(self):
        for changes in [[],[{'project':PROJECT,'draining':False,'at':500*1000}],[{'project':PROJECT,'draining':True,'at':(1000+3600)*1000}],
                        [{'project':'other/repo','draining':False,'at':(1000+3600)*1000}]]:
            with self.subTest(changes=changes):
                self.setUp();self.fractal_relay_record()
                self.adapter.state['projectDrainChanges']=changes
                result=self.worker.tick(PROJECT,'new')
                self.assertEqual(result['phase'],'attention');self.assertIn('drain policy changed',result['reason'])
                self.assertEqual(self.archives('retired'),[])

    def test_recorded_resume_does_not_excuse_changed_ownership_or_machine_drain(self):
        self.fractal_relay_record()
        self.adapter.state['projectDrainChanges']=[{'project':PROJECT,'draining':False,'at':(1000+3600)*1000}]
        self.adapter.state['draining']=True
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'attention')
        self.setUp();self.fractal_relay_record()
        self.adapter.state['projectDrainChanges']=[{'project':PROJECT,'draining':False,'at':(1000+3600)*1000}]
        state=json.loads(self.receipt().read_text());state['claims']={PROJECT+'#1':['mac','owner']};module.atomic(self.receipt(),state)
        self.adapter.state['claims']=[{'ticket':PROJECT+'#1','machine':'mac','generation':'other'}]
        result=self.worker.tick(PROJECT,'new')
        self.assertEqual(result['phase'],'attention');self.assertIn('ownership changed',result['reason'])

    def test_claims_released_since_the_drain_do_not_block_retirement(self):
        self.open_record('verifying')
        state=json.loads(self.receipt().read_text())
        state['claims']={PROJECT+'#1':['mac','owner'],PROJECT+'#2':['mac','unused']};module.atomic(self.receipt(),state)
        # #1 kept its owner, #2 was a withdrawn unused reservation and is gone.
        self.adapter.state['claims']=[{'ticket':PROJECT+'#1','machine':'mac','generation':'owner'}]
        self.started_elsewhere()
        self.assertEqual(self.worker.tick(PROJECT,'new')['phase'],'current')
        self.assertEqual(len(self.archives('retired')),1)

    def test_a_claim_now_held_by_another_machine_blocks_retirement(self):
        self.open_record('verifying')
        state=json.loads(self.receipt().read_text());state['claims']={PROJECT+'#1':['mac','owner']};module.atomic(self.receipt(),state)
        self.adapter.state['claims']=[{'ticket':PROJECT+'#1','machine':'linux','generation':'owner'}]
        self.started_elsewhere()
        result=self.worker.tick(PROJECT,'new')
        self.assertEqual(result['phase'],'attention');self.assertIn('ownership changed',result['reason'])

    def test_legacy_six_hour_record_keeps_its_alert_when_ownership_changed(self):
        self.open_record('attention');state=json.loads(self.receipt().read_text())
        state['reason']=module.SIX_HOUR_REASON;state['claims']={PROJECT+'#1':['mac','owner']};module.atomic(self.receipt(),state)
        self.adapter.state['claims']=[{'ticket':PROJECT+'#1','machine':'linux','generation':'owner'}];self.started_elsewhere()
        result=self.worker.tick(PROJECT,'new')
        self.assertEqual(result['reason'],module.SIX_HOUR_REASON);self.assertEqual(self.archives('retired'),[])

    def test_recovered_waiting_record_says_the_dispatcher_recovered(self):
        module.atomic(self.receipt(),{'phase':'waiting-for-native-task','project':PROJECT,'desired':'new','created':1000})
        self.adapter.helpers_active=lambda project:True
        self.adapter.current.update(generation='new')
        result=self.worker.tick(PROJECT,'new')
        self.assertEqual(result['phase'],'current');self.assertIn('the dispatcher recovered',result['reason'])

    def test_housekeeping_log_is_bounded_and_published_without_host_paths(self):
        log=quiet(self.directory,lambda:self.now[0])
        log.record('native-task-skipped','task','FileNotFoundError: /tmp/pyry-2939-mobile-lzcyx2qe/x.json in org/core')
        self.assertEqual(log.recent()[0]['reason'],'FileNotFoundError: <path> in org/core')
        filler='x'*1000
        for _ in range(300):log.record('operation-retired',PROJECT,filler)
        self.assertLessEqual(log.path.stat().st_size,module.HOUSEKEEPING_BYTES+2000)
        self.assertTrue(log.path.with_name('housekeeping.jsonl.1').exists())
        self.assertEqual(len(log.recent()),20)

class SupervisorReportTests(unittest.TestCase):
    def test_failed_native_task_pass_still_publishes_operations(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name in ['fleet-supervisor.py']:
                (root/name).write_bytes(Path(__file__).with_name(name).read_bytes())
            (root/'fleet-native.py').write_text('''class NativeAdapter:
    def __init__(self, config): pass
    def desired(self): return {}
    def attention(self): return {}
    def publish_attention(self): pass
''')
            (root/'fleet-support.py').write_text('''class SupportSupervisor:
    def __init__(self, adapter, config): pass
    def tick(self): raise FileNotFoundError('/tmp/pyry-2939-mobile-lzcyx2qe')
''')
            state=root/'state';state.mkdir()
            (state/'housekeeping.jsonl').write_text(json.dumps({'at':time.time(),'kind':'operation-retired','subject':PROJECT,'reason':'Retired verifying record','archive':'x'})+'\n')
            report=root/'report.json'
            config=root/'config.json'
            config.write_text(json.dumps({'stateDirectory':str(state),'reportFile':str(report),'projects':{PROJECT:{}},'recoveryTasks':{'probe':{}}}))
            config.chmod(0o600)
            result=subprocess.run([sys.executable,str(root/'fleet-supervisor.py'),str(config),'--once'],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            published=json.loads(report.read_text())
            self.assertEqual([o['project'] for o in published['operations']],[PROJECT])
            self.assertEqual(published['service'],'attention')
            self.assertIn('Native task pass failed. FileNotFoundError',published['reason'])
            self.assertEqual(published['housekeeping'],[{k:v for k,v in json.loads((state/'housekeeping.jsonl').read_text()).items() if k!='archive'}])

if __name__=='__main__':unittest.main()
