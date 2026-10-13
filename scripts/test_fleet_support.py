import importlib.util
import base64
import hashlib
import json
import tempfile
import unittest
import errno
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
    with self.assertRaisesRegex(RuntimeError,'Lost connection'):s.tick()
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
if __name__=='__main__':unittest.main()
