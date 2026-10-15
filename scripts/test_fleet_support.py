import importlib.util
import base64
import hashlib
import json
import tempfile
import unittest
import errno
import sys
import os
import signal
import time
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('support',Path(__file__).with_name('fleet-support.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NATIVE_CENSUS_AVAILABLE=m.process_snapshot() is not None


def artifact_reply(operation,body):
 if operation=='artifacts-begin':
  manifest=body['manifest']
  return {'digest':hashlib.sha256(json.dumps(manifest,separators=(',',':')).encode()).hexdigest(),
          'missing':{entry['path']:list(range(len(entry['chunks']))) for entry in manifest['files']}}
 return []

class SupportTests(unittest.TestCase):
 def test_android_bundle_over_four_mib_keeps_every_record_and_execution_outcome(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);capture=directory/'capture';capture.mkdir()
   driver=directory/'core/internal/e2e/realclaude/tool_then_text_mobile_capture.py'
   driver.parent.mkdir(parents=True);driver.write_text('approved driver')
   records={'shared-harness-redacted.json':'{}','driver.json':'{"exit_code":0}',
            'mobile.xml':'<testsuite tests="1" failures="0"/>',
            'child.stdout':'row\r\n'*(850000),'child.manifest.json':'{"dropped_rows":0,"tail_bytes":0}'}
   for name,data in records.items():(capture/name).write_bytes(data.encode())
   def execute(argv,cwd,log,env):
    log.write_text('#2939 private recovery: '+str(capture)+'\n');return 0
   with patch.object(m,'clone'),patch.object(m,'execute',side_effect=execute):
    result=m.native_recipe({'request':{'recipe':'android-tool-then-text','revision':'a'*40}},
       {'core':'core','mobile':'mobile','mobileAgents':'mobile-agents','coreAgents':'core-agents'},directory)
   self.assertGreater(sum(len(v.encode()) for v in records.values()),4*1024*1024)
   self.assertEqual(result['files'],{'mobile/'+name:data for name,data in records.items()})
   self.assertEqual(result['outcome'],'completed')
 def test_terminal_receipt_recovers_original_oversized_file_rich_bundle_without_execution(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);capture=directory/'original-capture';capture.mkdir()
   task_id='c02a547f02bb3c7548c17198150b7acc5e290ef937d1ef495d8a1651f454d58e'
   records={'shared-harness-redacted.json':'{"executed":1}', 'mobile.xml':'<testsuite tests="1" failures="1"/>',
            'driver.json':'{"exit_code":1}', 'child-0.stdout':'row\r\n'*850000,
            'child-0.manifest.json':'{"dropped_rows":3,"tail_bytes":11}'}
   for i in range(1,33):
    records[f'child-{i}.stdout']='event\r\n';records[f'child-{i}.manifest.json']='{"dropped_rows":0,"tail_bytes":0}'
   for name,content in records.items():(capture/name).write_bytes(content.encode())
   (capture/'execution-logcat.stdout').write_text('raw logcat stays private')
   (capture/'logcats').mkdir();(capture/'logcats'/'raw.stdout').write_text('nested raw logcat stays private')
   (directory/'execution.log').write_text('#2939 private recovery: '+str(capture)+'\n')
   m.atomic(directory/'task.json',{'id':task_id,'request':{'recipe':'android-tool-then-text','revision':'a'*40}})
   original={'outcome':'failed','summary':'Android capture completed. Artifact bundle exceeds transport size; its original private directory remains available.','files':{}}
   result=directory/'result.json';m.atomic(result,original)
   class Adapter:
    def status(self):return {'machine':'build-hp-1','draining':True}
   s=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'recoveryTasks':{'android-tool-then-text:android-emulator':{'capability':'android-emulator'}}})
   receipt=s.directory/(task_id+'.receipt.json');m.atomic(receipt,{'id':task_id,'session':'original-session','phase':'complete','result':str(result),'pid':123})
   retained={};manifests=[];commits=[];interrupt=[True]
   def rpc(op,body):
    if op=='capabilities':return {}
    self.assertEqual(body['machine'],'build-hp-1');self.assertEqual(body['session'],'original-session');self.assertEqual(body['id'],task_id)
    if op=='artifacts-begin':
     manifest=body['manifest'];manifests.append(manifest)
     digest=hashlib.sha256(json.dumps(manifest,separators=(',',':')).encode()).hexdigest()
     return {'digest':digest,'missing':{entry['path']:[i for i in range(len(entry['chunks'])) if (entry['path'],i) not in retained] for entry in manifest['files']}}
    if op=='artifacts-put':
     if body['part']==1 and interrupt[0]:interrupt[0]=False;raise RuntimeError('Lost connection')
     data=base64.b64decode(body['data']);self.assertLessEqual(len(data),m.CHUNK_BYTES)
     retained[body['path'],body['part']]=data;return {}
    if op=='artifacts-commit':commits.append(body);return {}
    self.fail('Unexpected operation '+op)
   s.rpc=rpc
   with patch.object(s,'route_ready',return_value=False),patch.object(m,'execute') as execute,patch.object(m,'clone') as clone,patch.object(m.subprocess,'Popen') as spawn:
    skipped=[e for e in s.tick() if e.get('phase')=='error']
    self.assertEqual([e['id'] for e in skipped],[task_id]);self.assertIn('Lost connection',skipped[0]['reason'])
    self.assertNotIn('artifactUnrecoverable',json.loads(receipt.read_text()))
    self.assertNotIn('artifactDigest',json.loads(receipt.read_text()))
    s.tick();s.tick();execute.assert_not_called();clone.assert_not_called();spawn.assert_not_called()
   self.assertEqual(manifests[0],manifests[1]);self.assertGreater(manifests[0]['totalBytes'],4*1024*1024)
   self.assertEqual(len(manifests[0]['files']),len(records));self.assertGreater(len(records),64)
   self.assertEqual(len(commits),1);self.assertEqual(commits[0]['result'],original)
   self.assertEqual(json.loads(result.read_text()),original)
   self.assertEqual(json.loads(receipt.read_text())['artifactDigest'],commits[0]['digest'])
   for entry in manifests[0]['files']:
    data=b''.join(retained[entry['path'],i] for i in range(len(entry['chunks'])))
    self.assertEqual(data,records[entry['path'].removeprefix('mobile/')].encode())
    self.assertEqual(hashlib.sha256(data).hexdigest(),entry['sha256']);self.assertEqual(len(data),entry['bytes'])
 def test_missing_capture_folder_marks_one_record_unrecoverable_and_the_pass_continues(self):
  # HP c02a547f: its capture folder lived in a recreated container's temporary space.
  with tempfile.TemporaryDirectory() as d:
   bad_id='c02a547f02bb3c7548c17198150b7acc5e290ef937d1ef495d8a1651f454d58e';good_id='f'*64
   class Adapter:
    def status(self):return {'machine':'build-hp-1','draining':False}
   s=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'recoveryTasks':{'android-tool-then-text:android-emulator':{'capability':'android-emulator'}}})
   logged=[];s.housekeeping=lambda kind,subject,reason:logged.append((kind,subject,reason))
   bad=Path(d)/'bad';bad.mkdir()
   (bad/'execution.log').write_text('#2939 private recovery: '+str(Path(d)/'pyry-2939-mobile-lzcyx2qe')+'\n')
   m.atomic(bad/'task.json',{'id':bad_id,'request':{'recipe':'android-tool-then-text','revision':'a'*40}})
   m.atomic(bad/'result.json',{'outcome':'failed','summary':'Android capture completed. Artifact bundle exceeds transport size; its original private directory remains available.','files':{}})
   good=Path(d)/'good';good.mkdir()
   m.atomic(good/'result.json',{'outcome':'completed','summary':'Probe.','files':{'platform.json':'{}'}})
   bad_receipt=s.directory/(bad_id+'.receipt.json');good_receipt=s.directory/(good_id+'.receipt.json')
   m.atomic(bad_receipt,{'id':bad_id,'session':'s1','phase':'complete','result':str(bad/'result.json'),'pid':1})
   m.atomic(good_receipt,{'id':good_id,'session':'s2','phase':'complete','result':str(good/'result.json'),'pid':2})
   calls=[]
   def rpc(op,body):
    calls.append((op,body.get('id')))
    return artifact_reply(op,body)
   s.rpc=rpc
   with patch.object(s,'route_ready',return_value=False):
    self.assertEqual(s.tick(),[])
    s.tick()
   saved=json.loads(bad_receipt.read_text())
   self.assertNotIn('artifactDigest',saved)
   self.assertIn('FileNotFoundError',saved['artifactUnrecoverable']['reason'])
   self.assertIn('artifactDigest',json.loads(good_receipt.read_text()))
   self.assertEqual([entry[:2] for entry in logged],[('native-task-unrecoverable',bad_id)])
   self.assertNotIn(bad_id,[task for op,task in calls if op.startswith('artifacts')])
   # The pass reached scheduling on both ticks.
   self.assertEqual([op for op,_ in calls].count('schedule'),2)
 def test_local_task_ids_lists_receipts_and_deferred_markers_only(self):
  with tempfile.TemporaryDirectory() as d:
   s,_,_=self.support_with(d,[('a'*64,'running'),('b'*64,'complete')])
   m.atomic(s.directory/(('c'*64)+'.deferred.json'),{'id':'c'*64})
   (s.directory/'scheduler-session.json').write_text('{}')
   (s.directory/'notatask.receipt.json').write_text('{}')
   (s.directory/(('d'*64)+'.new')).write_text('{}')
   self.assertEqual(s.local_task_ids(),['a'*64,'b'*64,'c'*64])
   for path in s.directory.iterdir():path.unlink()
   s.directory.rmdir()
   self.assertEqual(s.local_task_ids(),[])
 def support_with(self,d,receipts,draining=False):
  class Adapter:
   def status(self):return {'machine':'build-hp-1','draining':draining}
  s=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'recoveryTasks':{'probe:macos-arm64':{'capability':'macos-arm64'}}})
  logged=[];s.housekeeping=lambda kind,subject,reason:logged.append((kind,subject))
  calls=[];s.rpc=lambda op,body:calls.append(op) or artifact_reply(op,body)
  result=Path(d)/'result.json';m.atomic(result,{'outcome':'completed','summary':'Probe.','files':{'platform.json':'{}'}})
  for task,phase in receipts:m.atomic(s.directory/(task+'.receipt.json'),{'id':task,'session':'s','phase':phase,'result':str(result),'pid':1})
  return s,logged,calls
 def test_a_non_artifact_record_error_skips_scheduling_for_that_pass(self):
  with tempfile.TemporaryDirectory() as d:
   s,logged,calls=self.support_with(d,[('a','running')])
   with patch.object(s,'route_ready',return_value=False),patch.object(m,'process_snapshot',side_effect=RuntimeError('census unavailable')):
    [entry]=s.tick()
   self.assertEqual(entry['phase'],'error');self.assertIn('census unavailable',entry['reason'])
   self.assertNotIn('schedule',calls)
 def test_an_artifact_transfer_error_is_retried_and_scheduling_continues(self):
  with tempfile.TemporaryDirectory() as d:
   s,logged,calls=self.support_with(d,[('a','complete')])
   def rpc(op,body):
    calls.append(op)
    if op=='artifacts-begin':raise RuntimeError('Lost connection')
    return artifact_reply(op,body)
   s.rpc=rpc
   with patch.object(s,'route_ready',return_value=False):[entry]=s.tick()
   self.assertIn('Lost connection',entry['reason']);self.assertIn('schedule',calls)
   self.assertNotIn('artifactUnrecoverable',json.loads((s.directory/'a.receipt.json').read_text()))
 def test_only_known_local_artifact_failures_are_unrecoverable(self):
  for error,marked in [(PermissionError(13,'denied'),False),(OSError(5,'io'),False),(RuntimeError('other'),False),
                       (KeyError('id'),True),(FileNotFoundError(2,'gone'),True),(RuntimeError('Capture returned no unique private recovery directory'),True)]:
   with self.subTest(error=error),tempfile.TemporaryDirectory() as d:
    s,logged,calls=self.support_with(d,[('a','complete')])
    with patch.object(s,'route_ready',return_value=False),patch.object(s,'artifact_files',side_effect=error):
     entries=s.tick()
    saved=json.loads((s.directory/'a.receipt.json').read_text())
    self.assertEqual('artifactUnrecoverable' in saved,marked)
    self.assertEqual(entries,[] if marked else [entries[0]])
    self.assertIn('schedule',calls)
 def test_a_malformed_skip_record_is_treated_as_empty(self):
  for content in ['[1,2]','"text"','null','{broken']:
   with self.subTest(content=content),tempfile.TemporaryDirectory() as d:
    (Path(d)/'native-task-skips.json').write_text(content)
    s,logged,calls=self.support_with(d,[('a','complete')])
    self.assertEqual(s.reported_errors,{})
    with patch.object(s,'route_ready',return_value=False),patch.object(s,'artifact_files',side_effect=PermissionError(13,'denied')):s.tick()
    self.assertEqual(logged,[('native-task-skipped','a')])
 def test_a_supervisor_restart_does_not_log_the_same_skip_again(self):
  with tempfile.TemporaryDirectory() as d:
   s,logged,calls=self.support_with(d,[('a','complete')])
   with patch.object(s,'route_ready',return_value=False),patch.object(s,'artifact_files',side_effect=PermissionError(13,'denied')):s.tick();s.tick()
   restarted,relogged,_=self.support_with(d,[])
   with patch.object(restarted,'route_ready',return_value=False),patch.object(restarted,'artifact_files',side_effect=PermissionError(13,'denied')):restarted.tick()
   self.assertEqual(logged,[('native-task-skipped','a')]);self.assertEqual(relogged,[])
 def test_capture_inventory_keeps_more_than_64_files_and_refuses_escaping_symlinks(self):
  with tempfile.TemporaryDirectory() as d,tempfile.TemporaryDirectory() as outside:
   capture=Path(d)/'capture';capture.mkdir();log=Path(d)/'execution.log';log.write_text('#2939 private recovery: '+str(capture)+'\n')
   for i in range(65):(capture/f'child-{i}.stdout').write_bytes(b'event\r\n')
   self.assertEqual(len(m.capture_records(log)),65)
   escaped=Path(outside)/'escaped.stdout';escaped.write_text('private')
   (capture/'escaped.stdout').symlink_to(escaped)
   with self.assertRaisesRegex(RuntimeError,'escapes'):m.capture_records(log)
 def test_manifest_explicit_total_bounds_and_path_validation(self):
  with self.assertRaisesRegex(RuntimeError,'bounds'):m.artifact_manifest({f'f-{i}':'' for i in range(m.ARTIFACT_FILES+1)})
  with patch.object(m,'ARTIFACT_BYTES',3),self.assertRaisesRegex(RuntimeError,'bounds'):m.artifact_manifest({'file':'four'})
  for path in ['../outside','/absolute','a//b','.fleet-task-cache/overwrite']:
   with self.subTest(path=path),self.assertRaisesRegex(RuntimeError,'path'):m.artifact_manifest({path:'data'})
 def test_cleanup_observes_grandchild_before_poll_reaps_its_group_leader(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  grandchild={'pid':125,'identity':'grandchild','pgid':123,'sid':123,'ppid':1,'state':'S'}
  class Child:
   pid=123
   reaped=False
   def poll(self):self.reaped=True;return 0
  child=Child();censuses=[];signals=[];drained=[]
  def snapshot():
   censuses.append(True)
   if len(censuses)==1:return {123:root}
   if drained:return {}
   return {125:grandchild} if child.reaped else {123:{**root,'state':'Z'},125:grandchild}
  def send(pid,sig):
   signals.append(sig)
   if sig==signal.SIGTERM:drained.append(True)
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log'
   with patch.object(m.subprocess,'Popen',return_value=child),patch.object(m,'process_snapshot',side_effect=snapshot),patch.object(m.os,'killpg',side_effect=send):
    self.assertEqual(m.execute(['fixture'],directory,log,cleanup_timeout=.01),0)
   self.assertEqual(signals,[0,signal.SIGTERM])
   record=json.loads(m.custody_file(log).read_text())['commands'][0]
   self.assertEqual(record['owned']['125'],'grandchild')
   self.assertEqual(record['phase'],'drained')
 def test_successful_parent_exit_denied_probe_uses_independent_custody(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  grandchild={'pid':125,'identity':'grandchild','pgid':125,'sid':125,'ppid':1,'state':'S'}
  class Child:
   pid=123
   def poll(self):return 0
   def wait(self,timeout=None):return 0
  for snapshot,expected in [({},0),({125:grandchild},1),(None,1)]:
   with self.subTest(snapshot=snapshot),tempfile.TemporaryDirectory() as d:
    directory=Path(d);log=directory/'execution.log';calls=[]
    def spawn(*args,**kwargs):
     self.assertTrue(kwargs['start_new_session'])
     kwargs['stdout'].write(b'available report');kwargs['stdout'].flush()
     return Child()
    def denied(pid,sig):
     calls.append(sig)
     if sig==0:raise PermissionError(errno.EPERM,'fixture denied probe')
     raise ProcessLookupError(errno.ESRCH,'fixture parent already exited')
    # Record the descendant before it leaves its parent's session.
    initial={123:root,125:{**grandchild,'pgid':123,'sid':123,'ppid':123}}
    census=iter([initial,initial,initial])
    with patch.object(m.subprocess,'Popen',side_effect=spawn),patch.object(m,'process_snapshot',side_effect=lambda:next(census,snapshot)),patch.object(m.os,'killpg',side_effect=denied):
     self.assertEqual(m.execute(['fixture'],directory,log),expected)
    self.assertEqual(calls,[0], 'denial must not trigger retries or cleanup signals')
    self.assertEqual(log.read_text(),'available report')
    saved=json.loads(log.with_suffix('.custody.json').read_text())['commands'][0]
    self.assertTrue(saved['denied'])
    self.assertEqual(saved['owned']['125'],'grandchild')
    self.assertEqual(saved['phase'],'drained' if expected==0 else 'alive' if snapshot else 'uncertain')
 def test_timeout_and_repeated_cancellation_with_denied_probe_retain_identity_and_handlers(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  class Child:
   pid=123
   def poll(self):return None
  handlers={sig:signal.getsignal(sig) for sig in (signal.SIGTERM,signal.SIGINT)}
  for cancel in (False,True):
   with self.subTest(cancel=cancel),tempfile.TemporaryDirectory() as d:
    directory=Path(d);log=directory/'execution.log';clock=[0]
    def sleep(delay):
     clock[0]+=delay
     if cancel:
      for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGTERM):signal.getsignal(sig)(sig,None)
    with patch.object(m.subprocess,'Popen',return_value=Child()),patch.object(m,'process_snapshot',return_value={123:root}),patch.object(m.time,'monotonic',side_effect=lambda:clock[0]),patch.object(m.time,'sleep',side_effect=sleep),patch.object(m.os,'killpg',side_effect=PermissionError(errno.EPERM,'fixture')) as send:
     self.assertEqual(m.execute(['fixture'],directory,log,timeout=.1),1)
     self.assertEqual(send.call_count,1);self.assertEqual(send.call_args.args,(123,0))
     with patch.object(m.subprocess,'Popen') as again:
      self.assertEqual(m.execute(['fixture'],directory,log),1);again.assert_not_called()
     self.assertEqual(send.call_count,1)
    saved=json.loads(m.custody_file(log).read_text())['commands'][0]
    self.assertEqual(saved['owned']['123'],'root');self.assertTrue(saved['denied'])
    self.assertEqual(saved['phase'],'alive')
    self.assertEqual({sig:signal.getsignal(sig) for sig in handlers},handlers)
 def test_timeout_and_cancellation_cleanup_is_bounded_and_preserves_reports(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  handlers={sig:signal.getsignal(sig) for sig in (signal.SIGTERM,signal.SIGINT)}
  for cancel in (False,True):
   for denied in (False,True):
    with self.subTest(cancel=cancel,denied=denied),tempfile.TemporaryDirectory() as d:
     directory=Path(d);log=directory/'execution.log';clock=[0];drained=[];calls=[]
     class Child:
      pid=123
      def poll(self):return 0 if drained else None
     def sleep(delay):
      clock[0]+=delay
      if cancel:
       for sig in (signal.SIGTERM,signal.SIGINT):signal.getsignal(sig)(sig,None)
     def send(pid,sig):
      calls.append(sig)
      if sig==signal.SIGTERM:
       if denied:raise PermissionError(errno.EPERM,'fixture denied cleanup')
       drained.append(True)
     def spawn(*args,**kwargs):
      kwargs['stdout'].write(b'counted report');kwargs['stdout'].flush();return Child()
     with patch.object(m.subprocess,'Popen',side_effect=spawn),patch.object(m,'process_snapshot',side_effect=lambda:{} if drained else {123:root}),patch.object(m.time,'monotonic',side_effect=lambda:clock[0]),patch.object(m.time,'sleep',side_effect=sleep),patch.object(m.os,'killpg',side_effect=send):
      self.assertEqual(m.execute(['fixture'],directory,log,timeout=.1,cleanup_timeout=.1),1)
     self.assertEqual(calls,[0,signal.SIGTERM]);self.assertEqual(log.read_text(),'counted report')
     record=json.loads(m.custody_file(log).read_text())['commands'][0]
     self.assertEqual(record['phase'],'alive' if denied else 'drained')
     self.assertEqual(record['denied'],denied)
     self.assertEqual({sig:signal.getsignal(sig) for sig in handlers},handlers)
 def test_census_without_its_own_process_cannot_prove_absence(self):
  with patch.object(m.sys,'platform','darwin'),patch.object(m.subprocess,'check_output',return_value=''):
   self.assertIsNone(m.process_snapshot())
  # A partial ps view containing an unrelated process is also insufficient.
  with patch.object(m.sys,'platform','darwin'),patch.object(m.subprocess,'check_output',return_value='123 1 123 Tue Oct 13 01:58:00 2026 S\n'),patch.object(m.os,'getpid',return_value=999):
   self.assertIsNone(m.process_snapshot())
 def test_reassessment_persists_new_descendants_before_they_escape_and_reparent(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  descendant={'pid':125,'identity':'grandchild','pgid':123,'sid':123,'ppid':1,'state':'S'}
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);path=m.custody_file(directory/'execution.log')
   m.atomic(path,{'commands':[{'root':root,'owned':{'123':'root'},'phase':'uncertain','denied':True}]})
   with patch.object(m,'process_snapshot',return_value={123:{**root,'state':'Z'},125:descendant}):
    self.assertNotEqual(m.command_custody(directory),'drained')
   # It leaves the original session after being discovered by reassessment.
   with patch.object(m,'process_snapshot',return_value={125:{**descendant,'pgid':125,'sid':125}}):
    self.assertNotEqual(m.command_custody(directory),'drained')
   saved=json.loads(path.read_text())['commands'][0]
   self.assertEqual(saved['owned']['125'],'grandchild')
   self.assertTrue(saved['denied'])
   with patch.object(m,'process_snapshot',return_value={}):
    self.assertEqual(m.command_custody(directory),'drained')
 def test_supervisor_restart_tracks_identity_confirmed_live_worker_without_escalation(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  with tempfile.TemporaryDirectory() as d:
   class Adapter:
    def status(self):return {'machine':'mac','draining':True}
   supervisor=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'recoveryTasks':{'probe':{'capability':'macos-arm64'}}})
   receipt=supervisor.directory/'job.receipt.json'
   m.atomic(receipt,{'id':'job','session':'s','phase':'running','pid':123,'custody':{'root':root,'owned':{'123':'root'},'phase':'alive'},'result':str(Path(d)/'result.json')})
   calls=[];supervisor.rpc=lambda op,body:calls.append(op) or artifact_reply(op,body)
   with patch.object(m,'process_snapshot',return_value={123:root}):
    supervisor.tick();supervisor.tick()
   self.assertNotIn('uncertain',calls)
   self.assertNotIn('artifacts-commit',calls)
   self.assertEqual(json.loads(receipt.read_text())['phase'],'running')
 def test_supervisor_observes_worker_descendants_before_reaping_and_restart(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  descendant={'pid':125,'identity':'child','pgid':123,'sid':123,'ppid':1,'state':'S'}
  class Child:
   reaped=False
   def poll(self):self.reaped=True;return 0
  child=Child()
  with tempfile.TemporaryDirectory() as d:
   class Adapter:
    def status(self):return {'machine':'mac','draining':True}
   config={'stateDirectory':d,'recoveryTasks':{'probe':{'capability':'macos-arm64'}}}
   supervisor=m.SupportSupervisor(Adapter(),config);supervisor.children[123]=child
   result=Path(d)/'result.json';m.atomic(result,{'outcome':'failed','summary':'retained report','files':{}})
   m.atomic(Path(d)/'task.json',{'request':{'recipe':'platform-probe'}})
   receipt=supervisor.directory/'job.receipt.json'
   m.atomic(receipt,{'id':'job','session':'s','phase':'running','pid':123,'custody':{'root':root,'owned':{'123':'root'},'phase':'alive'},'result':str(result)})
   calls=[];supervisor.rpc=lambda op,body:calls.append(op) or artifact_reply(op,body)
   def snapshot():return {125:descendant} if child.reaped else {123:{**root,'state':'Z'},125:descendant}
   with patch.object(m,'process_snapshot',side_effect=snapshot):supervisor.tick()
   self.assertEqual(json.loads(receipt.read_text())['custody']['owned'].get('125'),'child')
   restarted=m.SupportSupervisor(Adapter(),config);restarted.rpc=supervisor.rpc
   with patch.object(m,'process_snapshot',return_value={125:{**descendant,'pgid':125,'sid':125}}):restarted.tick()
   self.assertNotIn('artifacts-commit',calls)
   with patch.object(m,'process_snapshot',return_value={}):restarted.tick()
   self.assertEqual(calls.count('artifacts-commit'),1)
 def test_refused_command_preserves_descendants_discovered_in_its_admission_check(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  descendant={'pid':125,'identity':'child','pgid':123,'sid':123,'ppid':1,'state':'S'}
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log';path=m.custody_file(log)
   m.atomic(path,{'commands':[{'root':root,'owned':{'123':'root'},'phase':'uncertain','denied':True}]})
   with patch.object(m,'process_snapshot',return_value={123:{**root,'state':'Z'},125:descendant}),patch.object(m.subprocess,'Popen') as spawn,patch.object(m.os,'killpg') as send:
    self.assertEqual(m.execute(['unused'],directory,log),1)
   spawn.assert_not_called();send.assert_not_called()
   self.assertEqual(json.loads(path.read_text())['commands'][0]['owned']['125'],'child')
   with patch.object(m,'process_snapshot',return_value={125:{**descendant,'pgid':125,'sid':125}}):
    self.assertEqual(m.command_custody(directory),'alive')
 def test_supervisor_root_exit_cannot_complete_with_surviving_worker_grandchild(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  grandchild={'pid':125,'identity':'grandchild','pgid':123,'sid':123,'ppid':1,'state':'S'}
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d)
   class Adapter:
    def status(self):return {'machine':'mac','draining':True}
   supervisor=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'recoveryTasks':{'probe':{'capability':'macos-arm64'}}})
   result=directory/'result.json';m.atomic(result,{'outcome':'completed','summary':'probe','files':{}})
   m.atomic(directory/'task.json',{'request':{'recipe':'platform-probe'}})
   receipt=supervisor.directory/'job.receipt.json'
   m.atomic(receipt,{'id':'job','session':'s','phase':'running','pid':123,'custody':{'root':root,'owned':{'123':'root'},'phase':'alive'},'result':str(result)})
   class Child:
    def poll(self):return 0
   supervisor.children[123]=Child()
   calls=[];supervisor.rpc=lambda op,body:calls.append(op) or artifact_reply(op,body)
   with patch.object(m,'process_snapshot',return_value={123:{**root,'state':'Z'},125:grandchild}):
    supervisor.tick();supervisor.tick()
   self.assertNotIn('artifacts-commit',calls)
   self.assertEqual(calls.count('uncertain'),1)
   # Also retain this newly seen child when it subsequently changes session.
   with patch.object(m,'process_snapshot',return_value={125:{**grandchild,'pgid':125,'sid':125}}):supervisor.tick()
   self.assertNotIn('artifacts-commit',calls)
   with patch.object(m,'process_snapshot',return_value={}):supervisor.tick()
   self.assertEqual(calls.count('artifacts-commit'),1)
 def test_final_worker_census_persists_new_descendants_even_when_already_in_attention(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  descendant={'pid':125,'identity':'child','pgid':123,'sid':123,'ppid':1,'state':'S'}
  with tempfile.TemporaryDirectory() as d:
   class Adapter:
    def status(self):return {'machine':'mac','draining':True}
   supervisor=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'recoveryTasks':{'probe':{'capability':'macos-arm64'}}})
   result=Path(d)/'result.json';m.atomic(result,{'outcome':'completed','summary':'probe','files':{}})
   receipt=supervisor.directory/'job.receipt.json'
   m.atomic(receipt,{'id':'job','session':'s','phase':'attention','pid':123,'custody':{'root':root,'owned':{'123':'root'},'phase':'uncertain'},'result':str(result)})
   calls=[];supervisor.rpc=lambda op,body:calls.append(op) or artifact_reply(op,body)
   with patch.object(m,'process_snapshot',side_effect=[{}, {123:{**root,'state':'Z'},125:descendant}]):supervisor.tick()
   self.assertEqual(json.loads(receipt.read_text())['custody']['owned']['125'],'child')
   with patch.object(m,'process_snapshot',return_value={125:{**descendant,'pgid':125,'sid':125}}):supervisor.tick()
   self.assertNotIn('artifacts-commit',calls)
 @unittest.skipUnless(NATIVE_CENSUS_AVAILABLE,'Native integration requires a census in the child PID namespace')
 def test_normal_exit_retains_output_and_private_identity_journal(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log'
   self.assertEqual(m.execute(['/bin/sh','-c','printf report'],directory,log),0)
   self.assertEqual(log.read_text(),'report')
   record=json.loads(m.custody_file(log).read_text())['commands'][0]
   self.assertEqual(record['phase'],'drained');self.assertTrue(record['root']['identity'])
   self.assertEqual(m.custody_file(log).stat().st_mode&0o777,0o600)
 @unittest.skipUnless(NATIVE_CENSUS_AVAILABLE,'Native integration requires a census in the child PID namespace')
 def test_normal_cleanup_drains_surviving_grandchild_after_leader_exit(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log'
   self.assertEqual(m.execute(['/bin/sh','-c','(sleep 5) & exit 0'],directory,log,cleanup_timeout=.2),0)
   commands=json.loads(m.custody_file(log).read_text())['commands']
   self.assertEqual(commands[0]['phase'],'drained')
   self.assertGreaterEqual(len(commands[0]['owned'])+len(commands[0].get('unproved',{})),2)
 @unittest.skipUnless(NATIVE_CENSUS_AVAILABLE,'Native integration requires a census in the child PID namespace')
 def test_denied_probe_retains_custody_reports_and_reservation_until_descendant_drains(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log';calls=[]
   def denial(pid,sig):
    calls.append(sig);raise PermissionError(errno.EPERM,'fixture')
   with patch.object(m.os,'killpg',side_effect=denial):
    self.assertEqual(m.execute(['/bin/sh','-c','printf report; (sleep .6) & exit 0'],directory,log),1)
    self.assertEqual(log.read_text(),'report');self.assertEqual(calls,[0])
    self.assertIn(m.command_custody(directory),('alive','uncertain'))
    with patch.object(m.subprocess,'Popen') as spawn:
     self.assertEqual(m.execute(['/bin/sh','-c','exit 0'],directory,log),1);spawn.assert_not_called()
   class Adapter:
    def status(self):return {'machine':'mac','draining':True}
   supervisor=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'recoveryTasks':{'probe':{'capability':'macos-arm64'}}})
   result=directory/'result.json';result.write_text(json.dumps({'outcome':'failed','summary':'cleanup uncertain','files':{'report.json':'available report'}}))
   # The fixture's leader has exited; its retained identity also stands in for the exited worker.
   custody=json.loads(m.custody_file(log).read_text())['commands'][0]
   receipt=supervisor.directory/'job.receipt.json'
   m.atomic(receipt,{'id':'job','session':'s','phase':'running','pid':custody['root']['pid'],'custody':custody,'result':str(result)})
   class Child:
    def poll(self):return 0
   supervisor.children[custody['root']['pid']]=Child()
   operations=[];supervisor.rpc=lambda op,body:operations.append((op,body)) or artifact_reply(op,body)
   supervisor.tick();supervisor.tick()
   self.assertEqual([op for op,body in operations].count('uncertain'),1)
   self.assertNotIn('artifacts-commit',[op for op,body in operations])
   self.assertEqual(json.loads(receipt.read_text())['phase'],'attention')
   time.sleep(.7)
   supervisor.tick()
   complete=[body for op,body in operations if op=='artifacts-commit']
   self.assertEqual(len(complete),1);self.assertEqual(complete[0]['result']['outcome'],'failed')
   self.assertEqual(complete[0]['result']['files'],{})
   uploaded=[body for op,body in operations if op=='artifacts-put']
   self.assertEqual(len(uploaded),1);self.assertEqual(uploaded[0]['path'],'report.json')
   self.assertEqual(base64.b64decode(uploaded[0]['data']),b'available report')
 @unittest.skipUnless(NATIVE_CENSUS_AVAILABLE,'Native integration requires a census in the child PID namespace')
 def test_denied_probe_without_independent_census_is_uncertain(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log';snapshot=m.process_snapshot
   with patch.object(m,'new_custody',side_effect=lambda pid: {'root':snapshot()[pid],'owned':{},'phase':'uncertain','denied':False}),patch.object(m,'process_snapshot',return_value=None),patch.object(m.os,'killpg',side_effect=PermissionError(errno.EPERM,'fixture')) as probe:
    self.assertEqual(m.execute(['/bin/sh','-c','exit 0'],directory,log),1)
   self.assertEqual(probe.call_count,1)
   self.assertEqual(json.loads(m.custody_file(log).read_text())['commands'][0]['phase'],'uncertain')
 @unittest.skipUnless(NATIVE_CENSUS_AVAILABLE,'Native integration requires a census in the child PID namespace')
 def test_timeout_cleans_group_and_restores_signal_handlers_without_passing(self):
  handlers={sig:signal.getsignal(sig) for sig in (signal.SIGTERM,signal.SIGINT)}
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log'
   self.assertEqual(m.execute(['/bin/sh','-c','trap "" TERM; sleep 5'],directory,log,timeout=.1,cleanup_timeout=.1),1)
   self.assertEqual(m.command_custody(directory),'drained')
  self.assertEqual({sig:signal.getsignal(sig) for sig in handlers},handlers)
 @unittest.skipUnless(NATIVE_CENSUS_AVAILABLE,'Native integration requires a census in the child PID namespace')
 def test_repeated_cancellation_sends_cleanup_once_and_restores_handlers(self):
  handlers={sig:signal.getsignal(sig) for sig in (signal.SIGTERM,signal.SIGINT)}
  sleep=time.sleep;killpg=os.killpg;calls=[];cancelled=[]
  def cancellation(delay):
   if not cancelled:
    cancelled.append(True)
    signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None)
    signal.getsignal(signal.SIGINT)(signal.SIGINT,None)
   sleep(delay)
  def send(pid,sig):calls.append(sig);return killpg(pid,sig)
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log'
   with patch.object(m.time,'sleep',side_effect=cancellation),patch.object(m.os,'killpg',side_effect=send):
    self.assertEqual(m.execute(['/bin/sh','-c','sleep 5'],directory,log,cleanup_timeout=.2),1)
   self.assertEqual(m.command_custody(directory),'drained')
  self.assertEqual(calls,[0,signal.SIGTERM])
  self.assertEqual({sig:signal.getsignal(sig) for sig in handlers},handlers)
 def test_reused_pid_or_failed_census_cannot_release_a_saved_worker(self):
  root={'pid':123,'identity':'original','pgid':123,'sid':123,'ppid':1,'state':'S'}
  record={'root':root,'owned':{'123':'original'},'phase':'uncertain'}
  self.assertEqual(m.observe_custody(record,{123:{**root,'identity':'reused'}}),'uncertain')
  self.assertEqual(m.observe_custody(record,None),'uncertain')
  self.assertEqual(m.observe_custody(record,{}),'drained')
 def test_group_number_alone_cannot_authorize_signalling_an_unrecorded_member(self):
  root={'pid':123,'identity':'original','pgid':123,'sid':123,'ppid':1,'state':'S'}
  member={'pid':125,'identity':'unproved','pgid':123,'sid':123,'ppid':1,'state':'S'}
  record={'root':root,'owned':{'123':'original'},'phase':'uncertain'}
  self.assertEqual(m.observe_custody(record,{125:member}),'uncertain')
  self.assertNotIn('125',record['owned'])
  # Retain its observed identity even if it leaves that unproved group later.
  self.assertEqual(m.observe_custody(record,{125:{**member,'pgid':125,'sid':125}}),'uncertain')
  self.assertEqual(m.observe_custody(record,{}),'drained')
 def test_cleanup_keeps_an_unproved_group_without_sending_a_signal(self):
  root={'pid':123,'identity':'original','pgid':123,'sid':123,'ppid':1,'state':'S'}
  member={'pid':125,'identity':'unproved','pgid':123,'sid':123,'ppid':1,'state':'S'}
  class Child:
   pid=123
   def poll(self):return 0
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log';clock=[0]
   def sleep(delay):clock[0]+=delay
   with patch.object(m.subprocess,'Popen',return_value=Child()),patch.object(m,'process_snapshot',return_value={125:member}),patch.object(m.time,'monotonic',side_effect=lambda:clock[0]),patch.object(m.time,'sleep',side_effect=sleep),patch.object(m.os,'killpg') as send:
    # The group leader disappears between recording its identity and cleanup.
    with patch.object(m,'new_custody',return_value={'root':root,'owned':{'123':'original'},'phase':'alive','denied':False}):
     self.assertEqual(m.execute(['fixture'],directory,log,cleanup_timeout=.01),1)
    self.assertEqual(send.call_args_list, [unittest.mock.call(123,0)])
    with patch.object(m.subprocess,'Popen') as again:
     self.assertEqual(m.execute(['fixture'],directory,log),1);again.assert_not_called()
    self.assertEqual(send.call_count,1)
   saved=json.loads(m.custody_file(log).read_text())['commands'][0]
   self.assertEqual(saved['unproved']['125'],'unproved');self.assertNotIn('125',saved['owned'])
 @unittest.skipUnless(NATIVE_CENSUS_AVAILABLE,'Native integration requires a census in the child PID namespace')
 def test_denied_cleanup_signal_keeps_reports_and_restores_handlers(self):
  handlers={sig:signal.getsignal(sig) for sig in (signal.SIGTERM,signal.SIGINT)}
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log';killpg=os.killpg;calls=[];children=[]
   spawn=m.subprocess.Popen
   def capture(*args,**kwargs):
    child=spawn(*args,**kwargs);children.append(child);return child
   def deny_cleanup(pid,sig):
    calls.append(sig)
    if sig!=0:raise PermissionError(errno.EPERM,'fixture denied cleanup')
    return killpg(pid,sig)
   with patch.object(m.os,'killpg',side_effect=deny_cleanup),patch.object(m.subprocess,'Popen',side_effect=capture):
    self.assertEqual(m.execute(['/bin/sh','-c','printf report; sleep .3'],directory,log,timeout=.05),1)
   self.assertEqual(calls,[0,signal.SIGTERM]);self.assertEqual(log.read_text(),'report')
   self.assertIn(m.command_custody(directory),('alive','uncertain'))
   time.sleep(.35)
   for child in children:child.wait(timeout=5)
   self.assertEqual(m.command_custody(directory),'drained')
  self.assertEqual({sig:signal.getsignal(sig) for sig in handlers},handlers)
 def test_incomplete_native_cleanup_preserves_counted_report_without_passing(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d)
   def incomplete(argv,cwd,log,env):
    (directory/'smoke.json').write_text('{"executed":2,"passed":2}');return 1
   with patch.object(m,'clone'),patch.object(m,'execute',side_effect=incomplete):
    result=m.native_recipe({'request':{'recipe':'memory-runtime-smoke','revision':'a'*40}},{'core':'core'},directory)
   self.assertEqual(result['outcome'],'failed')
   self.assertEqual(result['files']['smoke.json'],'{"executed":2,"passed":2}')
 def test_incomplete_repair_cleanup_cannot_publish_a_prepared_pass(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d)
   (directory/'repair-result.json').write_text(json.dumps({'outcome':'completed','summary':'checked candidate','files':{'publication.json':'prepared pass','test.diagnostic.log':'report'}}))
   with patch.object(m,'execute',return_value=1):
    result=m.native_recipe({'request':{'recipe':'dispatcher-repair'}},{'node':'node','tsx':'tsx','repairProgram':'program'},directory)
   self.assertEqual(result['outcome'],'failed')
   self.assertEqual(result['files'],{'test.diagnostic.log':'report'})
 def test_observed_descendant_remains_owned_after_escaping_group_and_reparenting(self):
  root={'pid':123,'identity':'root','pgid':123,'sid':123,'ppid':1,'state':'S'}
  child={'pid':124,'identity':'child','pgid':123,'sid':123,'ppid':123,'state':'S'}
  record={'root':root,'owned':{},'phase':'uncertain'}
  self.assertEqual(m.observe_custody(record,{123:root,124:child}),'alive')
  self.assertEqual(m.observe_custody(record,{124:{**child,'pgid':124,'sid':124,'ppid':1}}),'alive')
  self.assertEqual(m.observe_custody(record,{124:{**child,'identity':'reused','pgid':124,'sid':124,'ppid':1}}),'drained')
 @unittest.skipUnless(NATIVE_CENSUS_AVAILABLE,'Native integration requires a census in the child PID namespace')
 def test_successful_shell_with_denied_zero_probe_is_independently_drained(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);log=directory/'execution.log';probes=[];killpg=os.killpg
   def probe(pid,sig):
    probes.append(sig)
    if sig==0:raise PermissionError(errno.EPERM,'fixture denied zero probe')
    return killpg(pid,sig)
   with patch.object(m.os,'killpg',side_effect=probe):
    self.assertEqual(m.execute(['/bin/sh','-c','exit 0'],directory,log),0)
   self.assertEqual(probes,[0], 'a denied probe must never be retried or followed by signals')
   self.assertEqual(json.loads(log.with_suffix('.custody.json').read_text())['commands'][0]['phase'],'drained')
 def test_android_failure_returns_ordered_recorder_and_launcher_diagnostics(self):
  with tempfile.TemporaryDirectory() as d:
   directory=Path(d);capture=directory/'capture';capture.mkdir()
   driver=directory/'core/internal/e2e/realclaude/tool_then_text_mobile_capture.py'
   driver.parent.mkdir(parents=True);driver.write_text('approved driver')
   records={'daemon-1.stdout':'{"type":"stream_event","event":{"type":"message_start"}}\r\n{"type":"result"}\r\n',
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
   calls=[];s.rpc=lambda op,body:calls.append(op) or artifact_reply(op,body)
   class Child:
    def poll(self):return None
   s.children[123]=Child();s.tick()
   self.assertNotIn('artifacts-commit',calls)
   self.assertEqual(json.loads(receipt.read_text())['phase'],'running')
 def test_missing_terminal_result_escalates_without_repeating_the_worker(self):
  with tempfile.TemporaryDirectory() as d:
   class Adapter:
    def status(self):return {'machine':'mac','draining':False}
   s=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'recoveryTasks':{'platform-probe:macos-arm64':{'capability':'macos-arm64'}}})
   receipt=s.directory/'job.receipt.json';m.atomic(receipt,{'id':'job','session':'s','phase':'launch-requested','result':str(Path(d)/'absent')})
   calls=[];s.rpc=lambda op,body:calls.append(op) or artifact_reply(op,body)
   with patch.object(m,'route_available',return_value=True),patch.object(m.subprocess,'Popen') as spawn:s.tick();s.tick();spawn.assert_not_called()
   self.assertEqual(calls.count('uncertain'),1)
   self.assertEqual(json.loads(receipt.read_text())['phase'],'attention')
TASK='29219c8b8ff620429a99de07365c889b44ecc0c3bc1d75c99525f7feea9ab1d4'
nspec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('fleet-native.py'))
native=importlib.util.module_from_spec(nspec);nspec.loader.exec_module(native)

class Child:
 pid=4242
 def poll(self):return None

class NativeTaskDuringDrainTests(unittest.TestCase):
 """Modelled on pyrybox Core, 2026-10-13: the #3247 repair task admitted 17:12 and the
 Desktop #1809 repair task admitted 22:48:43, both into the Core container while the
 supervisor drained it. Each worker died with the container and its reservation stayed."""
 def support(self,d,phase=None):
  route={'capability':'dispatcher-repair','container':'core','directory':d+'/work','containerDirectory':'/work','paths':{}}
  probe={'capability':'linux-amd64','container':'desktop','directory':d+'/work','containerDirectory':'/work','paths':{}}
  state={'machine':'pyrybox','draining':False,'runs':[]}
  class Adapter:
   def status(self):return state
   def operator_command(self,*args):return ['operator',*args]
  s=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'projects':{'org/core':{'container':'core'},'org/desktop':{'container':'desktop'}},
                                    'recoveryTasks':{'dispatcher-repair:dispatcher-repair':route,'platform-probe:linux-amd64':probe}})
  if phase:m.atomic(Path(d)/'org_core.json',{'phase':phase})
  logged=[];s.housekeeping=lambda kind,subject,reason:logged.append((kind,subject,reason))
  calls=[]
  grant={'task':{'id':TASK,'ticket':'org/desktop#1809','request':{'recipe':'dispatcher-repair','capability':'dispatcher-repair','reason':'r'}},
         'run':{'id':'run-1809','session':'scheduler','supportTaskId':TASK}}
  def rpc(op,body):
   calls.append((op,body))
   return [grant] if op=='schedule' else {}
  s.rpc=rpc
  return s,state,calls,logged,grant
 def adapter(self,d,state):
  a=native.NativeAdapter({'stateDirectory':d,'platform':'linux','projects':{'org/core':{'container':'core'}}})
  a.status=lambda:state
  return a

 def test_grant_into_a_draining_container_is_deferred_and_does_not_hold_the_drain(self):
  with tempfile.TemporaryDirectory() as d:
   s,state,calls,logged,grant=self.support(d,'draining')
   state['runs']=[{'machine':'pyrybox','supportTaskId':TASK,'id':'run-1809','session':'scheduler'}]
   with patch.object(m,'route_available',return_value=True),patch.object(m.subprocess,'Popen') as spawn:
    entries=s.tick();s.tick()
   spawn.assert_not_called()
   self.assertEqual([e['phase'] for e in entries],['deferred'])
   self.assertFalse((s.directory/(TASK+'.receipt.json')).exists())
   self.assertEqual([c[1]['record']['capabilities'] for c in calls if c[0]=='capabilities'],[['linux-amd64'],['linux-amd64']])
   self.assertEqual([k for k,_,_ in logged],['native-task-deferred'])
   # The supervisor's drain no longer waits for a task that was never started.
   self.assertFalse(self.adapter(d,state).helpers_active('org/core'))
   # A deferral for another run or session proves nothing about this reservation.
   state['runs']=[{'machine':'pyrybox','supportTaskId':TASK,'id':'run-other','session':'scheduler'}]
   self.assertTrue(self.adapter(d,state).helpers_active('org/core'))

 def test_deferred_task_starts_once_its_container_update_completes(self):
  with tempfile.TemporaryDirectory() as d:
   s,state,calls,logged,grant=self.support(d,'draining')
   with patch.object(m,'route_available',return_value=True),patch.object(m.subprocess,'Popen') as spawn:s.tick()
   m.atomic(Path(d)/'org_core.json',{'phase':'complete'})
   with patch.object(m,'route_available',return_value=True),patch.object(m.subprocess,'Popen',return_value=Child()) as spawn:
    entries=s.tick()
   self.assertEqual(spawn.call_count,1)
   self.assertEqual(spawn.call_args[0][0][:4],['podman','exec','core','python3'])
   self.assertEqual(entries[-1]['phase'],'running')
   self.assertFalse((s.directory/(TASK+'.deferred.json')).exists())
   state['runs']=[{'machine':'pyrybox','supportTaskId':TASK,'id':'run-1809','session':'scheduler'}]
   self.assertTrue(self.adapter(d,state).helpers_active('org/core'))

 def test_withhold_removes_only_the_draining_containers_capabilities(self):
  with tempfile.TemporaryDirectory() as d:
   s,state,calls,logged,grant=self.support(d)
   with patch.object(m,'route_available',return_value=True):
    s.withhold('org/core');s.withhold('org/unconfigured')
   self.assertEqual(calls,[('capabilities',{'machine':'pyrybox','record':{'capabilities':['linux-amd64'],'ready':True}})])
   with patch.object(m,'route_available',return_value=True):s.withhold('org/desktop')
   self.assertEqual(calls[-1][1]['record']['capabilities'],['dispatcher-repair'])

 def orphan(self,d,phase='running',wrote_at=None):
  s,state,calls,logged,grant=self.support(d)
  folder=Path(d)/'work'/TASK;folder.mkdir(parents=True)
  (folder/'execution.log').write_text('repair started\n')
  if wrote_at is not None:os.utime(folder/'execution.log',ns=(wrote_at,wrote_at))
  receipt=s.directory/(TASK+'.receipt.json')
  m.atomic(receipt,{'id':TASK,'session':'scheduler','phase':phase,'result':str(folder/'result.json'),'created':1,'container':'core',
                    'directory':str(folder),'containerDirectory':'/work/'+TASK,'pid':4242,'custody':{'root':{'pid':4242,'identity':'exec-client'},'owned':{}}})
  return s,calls,logged,receipt

 def pass_with(self,s,container,custody='drained'):
  with patch.object(m,'process_snapshot',return_value={}),patch.object(m,'observe_custody',return_value=custody),\
       patch.object(m,'container_instance',return_value=container),patch.object(s,'route_ready',return_value=False):
   return s.tick()

 def test_worker_in_a_stopped_container_releases_its_reservation_as_interrupted(self):
  # 22:49:52: the Core container exited and the #1809 worker died with it.
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt=self.orphan(d)
   self.assertEqual(self.pass_with(s,{'running':False}),[])
   [(op,body)]=[c for c in calls if c[0] in {'complete','uncertain'}]
   self.assertEqual(op,'complete');self.assertEqual((body['machine'],body['id'],body['session']),('pyrybox',TASK,'scheduler'))
   self.assertEqual(body['result']['outcome'],'failed');self.assertEqual(body['result']['files'],{})
   self.assertIn('not running',body['result']['summary']);self.assertIn('interrupted work, not completed and not unused',body['result']['summary'])
   saved=json.loads(receipt.read_text())
   self.assertEqual(saved['phase'],'complete');self.assertEqual(saved['interrupted']['result'],body['result'])
   self.assertEqual([k for k,_,_ in logged],['native-task-interrupted'])
   self.pass_with(s,{'running':False})
   self.assertEqual([c[0] for c in calls if c[0] in {'complete','uncertain'}],['complete'])

 def test_worker_in_a_container_restarted_after_its_last_write_is_interrupted(self):
  # 17:15:54: the Core container restarted after the #3247 worker last wrote at 17:12:37.
  with tempfile.TemporaryDirectory() as d:
   wrote=1791900757*10**9
   s,calls,logged,receipt=self.orphan(d,wrote_at=wrote)
   self.pass_with(s,{'running':True,'startedAt':wrote+197*10**9,'id':'new-instance'})
   self.assertEqual([c[0] for c in calls if c[0] in {'complete','uncertain'}],['complete'])
   self.assertIn('restarted after the worker last wrote',json.loads(receipt.read_text())['interrupted']['reason'])

 def test_already_escalated_orphan_is_released_once_its_container_is_gone(self):
  # The receipt state the #1809 task was left in overnight.
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt=self.orphan(d,phase='attention')
   self.pass_with(s,{'running':False})
   self.assertEqual([c[0] for c in calls if c[0] in {'complete','uncertain'}],['complete'])
   self.assertEqual(json.loads(receipt.read_text())['phase'],'complete')

 def test_no_release_without_proof_that_the_worker_is_gone(self):
  wrote=1791900757*10**9
  cases=[('worker may be in the running instance',{'running':True,'startedAt':wrote-10**9,'id':'i'},'drained',wrote),
         ('write within the clock margin',{'running':True,'startedAt':wrote+10**9,'id':'i'},'drained',wrote),
         ('podman state unknown',None,'drained',wrote),
         ('exec client still alive',{'running':False},'alive',wrote),
         ('exec client uncertain',{'running':False},'uncertain',wrote)]
  for name,container,custody,stamp in cases:
   with self.subTest(name),tempfile.TemporaryDirectory() as d:
    s,calls,logged,receipt=self.orphan(d,wrote_at=stamp)
    self.pass_with(s,container,custody)
    self.assertNotIn('complete',[c[0] for c in calls])
    self.assertNotEqual(json.loads(receipt.read_text())['phase'],'complete')

 def test_a_restarted_container_proves_nothing_when_the_worker_never_wrote(self):
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt=self.orphan(d)
   (Path(d)/'work'/TASK/'execution.log').unlink()
   self.pass_with(s,{'running':True,'startedAt':10**30,'id':'i'})
   self.assertEqual([c[0] for c in calls if c[0] in {'complete','uncertain'}],['uncertain'])

 def test_a_written_result_is_never_replaced_by_an_interruption(self):
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt=self.orphan(d)
   m.atomic(Path(d)/'work'/TASK/'result.json',{'outcome':'completed','summary':'Repair passed.','files':{}})
   with patch.object(s,'drained',return_value=False):self.pass_with(s,{'running':False})
   self.assertNotIn('complete',[c[0] for c in calls])

 def test_a_lost_release_reply_is_retried_with_the_identical_result(self):
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt=self.orphan(d)
   rpc=s.rpc
   def failing(op,body):
    if op=='complete':calls.append(('lost',body));raise RuntimeError('connection reset')
    return rpc(op,body)
   s.rpc=failing
   [entry]=self.pass_with(s,{'running':False})
   self.assertEqual(entry['phase'],'error')
   first=json.loads(receipt.read_text())['interrupted']
   s.rpc=rpc
   self.pass_with(s,{'running':True,'startedAt':0,'id':'later'})
   sent=[body['result'] for op,body in calls if op in {'lost','complete'}]
   self.assertEqual(sent,[first['result'],first['result']])
   self.assertEqual(json.loads(receipt.read_text())['phase'],'complete')

 def test_only_an_absent_or_fully_stopped_container_counts_as_not_running(self):
  class Done:
   def __init__(self,code):self.returncode=code
  cases=[(1,None,{'running':False}),(0,'exited 0 1791950665477082324 abc',{'running':False}),
         (0,'stopping 4242 1791950665477082324 abc',None),(0,'exited 4242 1791950665477082324 abc',None),
         (0,'running 4242 1791950665477082324 abc',{'running':True,'startedAt':1791950665477082324,'id':'abc'}),
         (0,'running 0 1791950665477082324 abc',None),(0,'garbled',None),(125,None,None)]
  for code,inspect,expected in cases:
   with self.subTest(code=code,inspect=inspect),patch.object(m.subprocess,'run',return_value=Done(code)),\
        patch.object(m.subprocess,'check_output',return_value=inspect or ''):
    self.assertEqual(m.container_instance('core'),expected)

 def test_a_refused_release_stays_local_to_its_record_and_scheduling_continues(self):
  for refusal in ['Completed task result changed','Task is not running','Task actor mismatch']:
   with self.subTest(refusal),tempfile.TemporaryDirectory() as d:
    s,calls,logged,receipt=self.orphan(d)
    rpc=s.rpc
    def refusing(op,body):
     if op=='complete':calls.append(('refused',body));raise RuntimeError(refusal)
     return rpc(op,body)
    s.rpc=refusing
    for _ in range(3):
     with patch.object(m,'process_snapshot',return_value={}),patch.object(m,'observe_custody',return_value='drained'),\
          patch.object(m,'container_instance',return_value={'running':False}),patch.object(m,'route_available',return_value=True),\
          patch.object(m.subprocess,'Popen',return_value=Child()):
      entries=s.tick()
     self.assertEqual(entries[0]['phase'],'error');self.assertIn(refusal,entries[0]['reason'])
    self.assertEqual([c[0] for c in calls].count('refused'),3)
    self.assertEqual([c[0] for c in calls].count('schedule'),3)
    saved=json.loads(receipt.read_text())
    self.assertEqual(saved['phase'],'attention');self.assertIn('interrupted',saved)
    self.assertEqual([k for k,_,_ in logged],['native-task-skipped'])

 def test_only_an_open_operation_defers_a_grant(self):
  latch={'phase':'attention','latch':'health','reason':'Health failed again after a verified restart. No repeat restart within twenty-four hours.'}
  legacy_latch={'phase':'attention','reason':latch['reason']}
  started={'phase':'attention','attentionFrom':'verifying','reason':'Existing ticket ownership changed. Inspect the retained comparison.'}
  stuck={'phase':'attention','attentionFrom':'draining','reason':'Operation exceeded six hours. No forced stop or second signal sent.'}
  uncertain={'phase':'attention','reason':'Drain acknowledgement uncertain. No second signal sent.'}
  cases=[({'phase':'complete'},True),(latch,True),(legacy_latch,True),(started,True),
         (stuck,False),(uncertain,False)]+[({'phase':phase},False) for phase in sorted(m.OPEN_PHASES)]
  for record,ready in cases:
   with self.subTest(record=record),tempfile.TemporaryDirectory() as d:
    s,state,calls,logged,grant=self.support(d)
    m.atomic(Path(d)/'org_core.json',record)
    with patch.object(m,'route_available',return_value=True),patch.object(m.subprocess,'Popen',return_value=Child()) as spawn:
     entries=s.tick()
    self.assertEqual(spawn.call_count,1 if ready else 0)
    self.assertEqual(entries[-1]['phase'],'running' if ready else 'deferred')

 def test_worker_marks_its_start_before_running_the_recipe(self):
  with tempfile.TemporaryDirectory() as d:
   folder=Path(d);m.atomic(folder/'task.json',{'request':{'recipe':'platform-probe'}});m.atomic(folder/'paths.json',{})
   import subprocess
   subprocess.run([sys.executable,str(Path(__file__).with_name('fleet-support.py')),'--worker',str(folder)],check=True,timeout=30)
   self.assertTrue((folder/'started.json').is_file())
   self.assertLessEqual((folder/'started.json').stat().st_mtime_ns,(folder/'result.json').stat().st_mtime_ns)

if __name__=='__main__':unittest.main()

REPAIR='58915c353ee70b722a335cd603c0d2c22439bc70bbdd083a50bc1da8b686d84e'
REFUSED='Service 422: {"error":"Repair contains credential-shaped text; retain it privately","refused":true}\n'

class PublicationRefusalTests(unittest.TestCase):
 """Modelled on pyrybox, 2026-10-14: the pyrycode/pyrycode#3289 dispatcher repair passed
 full checks and independent review at 09:31:47, then the authority refused its
 publication as credential-shaped on every pass. Nothing ended the task, so it held
 pyrybox's only heavy place for about three hours."""
 def support(self,d,replies):
  state={'machine':'pyrybox','draining':False,'runs':[]}
  class Adapter:
   def status(self):return state
   def operator_command(self,*args):return ['operator',*args]
  route={'capability':'dispatcher-repair','container':'core','directory':d+'/work','containerDirectory':'/work','paths':{}}
  s=m.SupportSupervisor(Adapter(),{'stateDirectory':d,'projects':{'org/core':{'container':'core'}},
                                    'recoveryTasks':{'dispatcher-repair:dispatcher-repair':route}})
  logged=[];s.housekeeping=lambda kind,subject,reason:logged.append((kind,subject,reason))
  calls=[]
  def rpc(op,body):
   calls.append((op,body))
   reply=replies.get(op)
   if isinstance(reply,list):reply=reply.pop(0) if reply else None
   if isinstance(reply,Exception):raise reply
   if callable(reply):return reply(op,body)
   return [] if op=='schedule' else reply if reply is not None else {}
  s.rpc=rpc
  work=Path(d)/'work'/REPAIR;work.mkdir(parents=True)
  publication=json.dumps({'files':{'src/dispatch.ts':'patched'},'message':'Fix dispatcher recovery for pyrycode/pyrycode#3289','review':'PASS','checksPassed':True})
  (work/'publication.json').write_text(publication)
  (work/'result.json').write_text(json.dumps({'outcome':'completed','summary':'Dispatcher patch passed full checks and independent review. Publication is prepared for the existing fleet authority.','files':{'publication.json':publication}}))
  receipt=s.directory/(REPAIR+'.receipt.json')
  # The exact receipt shape on pyrybox: worker exited normally and drained.
  m.atomic(receipt,{'id':REPAIR,'session':'d140fab3c09646489abec737e2abade7','phase':'running','result':str(work/'result.json'),
                    'container':'core','directory':str(work),'containerDirectory':'/work/'+REPAIR,'pid':3412049,
                    'custody':{'root':{'pid':3412049,'identity':'x'},'owned':{},'phase':'drained'},'drainConfirmed':True})
  return s,calls,logged,receipt,work

 def test_refused_publication_ends_the_task_as_failed_once_and_keeps_the_patch(self):
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt,work=self.support(d,{'prepare-repair':m.rpc_failure('prepare-repair',1,REFUSED)})
   first=s.tick();second=s.tick()
   ops=[op for op,_ in calls]
   self.assertEqual(ops.count('prepare-repair'),1,'a definitive refusal is never asked again')
   self.assertNotIn('publish-repair',ops)
   completes=[body for op,body in calls if op=='complete']
   self.assertEqual(len(completes),1)
   result=completes[0]['result']
   self.assertEqual(result['outcome'],'failed');self.assertEqual(result['files'],{})
   self.assertIn('Repair contains credential-shaped text; retain it privately',result['summary'])
   self.assertIn(str(work),result['summary'])
   saved=json.loads(receipt.read_text())
   self.assertEqual(saved['phase'],'complete')
   self.assertEqual(saved['publicationRefused']['result'],result)
   # The reviewed patch stays on the host; nothing returned it to the authority.
   self.assertTrue((work/'publication.json').is_file())
   self.assertNotIn('artifacts-begin',ops)
   self.assertEqual([k for k,_,_ in logged],['native-task-publication-refused'])
   self.assertIn('reservation released',logged[0][2])
   # Record-local: new work is still offered on this host, and nothing stays running.
   self.assertEqual(ops.count('schedule'),2)
   self.assertEqual(first,[]);self.assertEqual(second,[])

 def test_retired_publication_settles_only_the_drained_worker_and_keeps_its_patch(self):
  with tempfile.TemporaryDirectory() as d:
   error=m.rpc_failure('publish-repair',1,'Service 410: {"error":"Automatic repair publication is retired"}')
   s,calls,logged,receipt,work=self.support(d,{'publish-repair':error})
   s.tick();s.tick()
   self.assertEqual([op for op,_ in calls].count('publish-repair'),1)
   result=next(body['result'] for op,body in calls if op=='complete')
   self.assertEqual(result['outcome'],'failed')
   self.assertIn('reviewed manual pull request',result['summary'])
   self.assertTrue((work/'publication.json').is_file())
   self.assertEqual(json.loads(receipt.read_text())['phase'],'complete')

 def test_a_lost_release_retries_the_saved_result_without_asking_again(self):
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt,work=self.support(d,{'prepare-repair':m.rpc_failure('prepare-repair',1,REFUSED),
                                              'complete':[m.rpc_failure('complete',1,'fetch failed'),{}]})
   entries=s.tick()
   self.assertEqual([e['phase'] for e in entries],['error'])
   self.assertIn('call complete failed without a service reply',entries[0]['reason'])
   self.assertEqual(json.loads(receipt.read_text())['phase'],'running')
   self.assertIn('schedule',[op for op,_ in calls],'a release failure is local to the record')
   s.tick()
   completes=[body['result'] for op,body in calls if op=='complete']
   self.assertEqual(len(completes),2);self.assertEqual(completes[0],completes[1])
   self.assertEqual([op for op,_ in calls].count('prepare-repair'),1)
   self.assertEqual(json.loads(receipt.read_text())['phase'],'complete')
   self.assertEqual([k for k,_,_ in logged],['native-task-skipped','native-task-publication-refused'])

 def test_temporary_publication_failures_back_off_and_keep_the_reservation(self):
  with tempfile.TemporaryDirectory() as d:
   published={'url':'https://github.com/org/agent-dispatcher/pull/9','merged':True,'dispatcherSHA':'b'*40}
   s,calls,logged,receipt,work=self.support(d,{
    'prepare-repair':[m.rpc_failure('prepare-repair',1,'Service 503: {"error":"Repair base sources unavailable: HTTP 502"}'),
                      m.rpc_failure('prepare-repair',1,'Error: fetch failed'),{},{}],
    'publish-repair':published,
    'artifacts-begin':artifact_reply,'artifacts-put':{},'artifacts-commit':{}})
   now=1_000_000.0
   with patch.object(m.time,'time',return_value=now):entries=s.tick()
   self.assertEqual([e['phase'] for e in entries],['error'])
   saved=json.loads(receipt.read_text())
   self.assertEqual(saved['phase'],'running');self.assertNotIn('publicationRefused',saved)
   self.assertEqual(saved['publicationRetry']['failures'],1);self.assertEqual(saved['publicationRetry']['next'],now+60)
   self.assertIn('schedule',[op for op,_ in calls])
   # Within the wait nothing is asked, and the report says when the next attempt is.
   with patch.object(m.time,'time',return_value=now+30):entries=s.tick()
   self.assertEqual([op for op,_ in calls].count('prepare-repair'),1)
   self.assertEqual([(e['phase'],e['next']) for e in entries],[('publication-retry',now+60)])
   self.assertEqual(len(logged),1);self.assertIn(REPAIR,s.reported_errors)
   # A failure with no service reply is retried too, after twice the wait.
   with patch.object(m.time,'time',return_value=now+61):s.tick()
   saved=json.loads(receipt.read_text())
   self.assertEqual(saved['publicationRetry']['failures'],2);self.assertEqual(saved['publicationRetry']['next'],now+61+120)
   self.assertNotIn('complete',[op for op,_ in calls])
   with patch.object(m.time,'time',return_value=now+200):s.tick()
   saved=json.loads(receipt.read_text())
   self.assertEqual(saved['phase'],'complete');self.assertNotIn('publicationRetry',saved)
   self.assertEqual([op for op,_ in calls].count('publish-repair'),1)
   # Each distinct failure is logged once, not again after each wait. Nothing was refused.
   self.assertEqual([k for k,_,_ in logged],['native-task-skipped','native-task-skipped'])
   self.assertIn('Service 503',logged[0][2]);self.assertIn('without a service reply',logged[1][2])

 def test_retry_wait_is_capped(self):
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt,work=self.support(d,{})
   old=json.loads(receipt.read_text());old['publicationRetry']={'failures':12,'next':0}
   with patch.object(m.time,'time',return_value=5000.0),self.assertRaises(m.PublicationPassError):
    s.publication_retry(receipt,old,m.rpc_failure('publish-repair',1,'Service 503: {"error":"unavailable"}'))
   self.assertEqual(json.loads(receipt.read_text())['publicationRetry']['next'],5000.0+1800)

 def test_operator_errors_are_classified_from_the_service_line(self):
  refused=m.rpc_failure('prepare-repair',1,'(node:1) warning\n'+REFUSED)
  self.assertIsInstance(refused,m.ServiceRefusal)
  self.assertEqual((refused.status,refused.refused),(422,True))
  self.assertEqual(refused.message,'Repair contains credential-shaped text; retain it privately')
  for detail,status in [('Service 409: {"error":"Prepared repair changed"}',409),('Service 422: {"error":"x"}',422),
                        ('Service 503: {"error":"Repair base sources unavailable"}',503)]:
   error=m.rpc_failure('prepare-repair',1,detail)
   self.assertEqual(error.status,status);self.assertFalse(error.refused,detail)
  for detail in ['fetch failed','']:self.assertNotIsInstance(m.rpc_failure('prepare-repair',1,detail),m.ServiceRefusal)

 def test_a_definite_refusal_other_than_422_is_asked_again_each_pass(self):
  # Left to the watchdog, which counts the same refusal on consecutive passes.
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt,work=self.support(d,{'prepare-repair':m.rpc_failure('prepare-repair',1,'Service 409: {"error":"Repair actor mismatch"}')})
   s.tick();s.tick()
   self.assertEqual([op for op,_ in calls].count('prepare-repair'),2)
   self.assertNotIn('publicationRetry',json.loads(receipt.read_text()))
   self.assertEqual(s.refusals[REPAIR]['status'],409)
   self.assertNotIn('complete',[op for op,_ in calls])

 def test_repeated_temporary_failures_are_raised_for_attention_once(self):
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt,work=self.support(d,{'prepare-repair':m.rpc_failure('prepare-repair',1,'Service 503: {"error":"Repair base sources unavailable: HTTP 502"}')})
   now=1_000_000.0
   for i in range(8):
    old=json.loads(receipt.read_text());retry=old.get('publicationRetry')
    if retry:now=retry['next']+1
    with patch.object(m.time,'time',return_value=now):s.tick()
   self.assertEqual([k for k,_,_ in logged].count('native-task-publication-stuck'),1)
   self.assertEqual(json.loads(receipt.read_text())['publicationRetry']['failures'],8)
   self.assertNotIn('complete',[op for op,_ in calls],'a failure that may clear never ends the task')
   with patch.object(m.time,'time',return_value=now+1):entries=s.tick()
   self.assertEqual(entries[0]['phase'],'attention')

 def test_service_line_is_found_when_the_operator_writes_after_it(self):
  error=m.rpc_failure('prepare-repair',1,REFUSED+'    at main (fleet-bin.ts:1)\nNode.js v24.13.0\n')
  self.assertTrue(error.refused)
  with tempfile.TemporaryDirectory() as d:
   s,calls,logged,receipt,work=self.support(d,{});del s.rpc
   class Done:returncode=1;stdout='';stderr=REFUSED
   with patch.object(m.subprocess,'run',return_value=Done()),patch.object(m.sys,'stderr') as stream:
    with self.assertRaises(m.ServiceRefusal):s.rpc('prepare-repair',{})
   stream.write.assert_called_with(REFUSED)
