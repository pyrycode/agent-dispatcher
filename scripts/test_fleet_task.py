import base64
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('fleet_task',Path(__file__).with_name('fleet-task.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
spec=importlib.util.spec_from_file_location('fleet_support',Path(__file__).with_name('fleet-support.py'))
support=importlib.util.module_from_spec(spec);spec.loader.exec_module(support)

class RetrievalTests(unittest.TestCase):
 def fixture(self):
  # The two-byte character straddles the chunk boundary; exact CRLF follows it.
  data=('x'*(m.CHUNK_BYTES-1)+'é\r\n'+'y'*m.CHUNK_BYTES).encode()
  manifest=support.artifact_manifest({'mobile/child.stdout':data.decode(),'empty.json':''})
  manifest,digest=m.inventory(manifest)
  task={'id':'a'*64,'machine':'build-hp-1','session':'original','request':{'revision':'b'*40},
        'state':'failed','result':{'outcome':'failed','summary':'Original failure','files':{}},'artifacts':manifest}
  return task,data,digest
 def reply(self,task,data,digest,body):
  entry=next(e for e in task['artifacts']['files'] if e['path']==body['path']);part=body['part']
  chunk=data[part*m.CHUNK_BYTES:(part+1)*m.CHUNK_BYTES]
  return {**body,'bytes':len(chunk),'sha256':entry['chunks'][part],'data':base64.b64encode(chunk).decode()}
 def test_interrupted_retrieval_resumes_verified_parts_and_retains_complete_provenance(self):
  task,data,digest=self.fixture();calls=[]
  def interrupted(action,body):
   calls.append(body['part'])
   if body['part']==1:raise RuntimeError('Interrupted connection')
   return self.reply(task,data,digest,body)
  with tempfile.TemporaryDirectory() as d:
   Path(d,'mobile').mkdir();Path(d,'mobile/child.stdout.new').write_bytes(b'adjacent user work')
   with patch.object(m,'request',side_effect=interrupted):
    with self.assertRaisesRegex(RuntimeError,'Interrupted'):m.retrieve(task,d)
   self.assertFalse(Path(d,'mobile/child.stdout').exists())
   self.assertFalse(Path(d,'.fleet-task-manifest.json').exists())
   self.assertEqual(calls,[0,1]);calls.clear()
   def resumed(action,body):
    calls.append(body['part']);return self.reply(task,data,digest,body)
   with patch.object(m,'request',side_effect=resumed):m.retrieve(task,d)
   self.assertEqual(calls,[1,2]);self.assertEqual(Path(d,'mobile/child.stdout').read_bytes(),data)
   self.assertEqual(Path(d,'mobile/child.stdout.new').read_bytes(),b'adjacent user work')
   self.assertEqual(Path(d,'empty.json').read_bytes(),b'')
   provenance=json.loads(Path(d,'.fleet-task-manifest.json').read_text())
   self.assertEqual(provenance,{'task':task,'digest':digest})
   self.assertEqual(Path(d,'mobile/child.stdout').stat().st_mode&0o777,0o600)
   with patch.object(m,'request') as request:m.retrieve(task,d);request.assert_not_called()
   Path(d,'mobile/child.stdout').write_bytes(b'user work')
   with self.assertRaisesRegex(RuntimeError,'Existing artifact differs'):m.retrieve(task,d)
   self.assertEqual(Path(d,'mobile/child.stdout').read_bytes(),b'user work')
 def test_missing_corrupt_or_misidentified_chunks_never_publish_a_file(self):
  for mode in ['missing','corrupt','identity','hash']:
   with self.subTest(mode=mode),tempfile.TemporaryDirectory() as d:
    task,data,digest=self.fixture()
    def broken(action,body):
     if mode=='missing':raise RuntimeError('Artifact chunk missing')
     reply=self.reply(task,data,digest,body)
     if mode=='corrupt':reply['data']=base64.b64encode(b'bad').decode()
     if mode=='identity':reply['digest']='f'*64
     if mode=='hash':reply['sha256']='f'*64
     return reply
    with patch.object(m,'request',side_effect=broken),self.assertRaises(RuntimeError):m.retrieve(task,d)
    self.assertFalse(Path(d,'mobile/child.stdout').exists())
    self.assertFalse(Path(d,'.fleet-task-manifest.json').exists())
 def test_inventory_and_symlinks_cannot_escape_destination(self):
  task,data,digest=self.fixture()
  for path in ['../outside','/absolute','a//b','.fleet-task-cache/clobber']:
   with self.subTest(path=path):
    bad={**task['artifacts'],'files':[{**task['artifacts']['files'][1],'path':path}]}
    with self.assertRaisesRegex(RuntimeError,'path'):m.inventory(bad)
  with tempfile.TemporaryDirectory() as d,tempfile.TemporaryDirectory() as outside:
   Path(d,'mobile').symlink_to(outside)
   with patch.object(m,'request') as request,self.assertRaisesRegex(RuntimeError,'path'):
    m.retrieve(task,d)
   request.assert_not_called();self.assertFalse(Path(outside,'child.stdout').exists())
 def test_whole_file_hash_mismatch_is_not_hidden_by_valid_chunks(self):
  task,data,digest=self.fixture();task['artifacts']['files'][1]['sha256']='f'*64
  _,digest=m.inventory(task['artifacts'])
  with tempfile.TemporaryDirectory() as d,patch.object(m,'request',side_effect=lambda action,body:self.reply(task,data,digest,body)):
   with self.assertRaisesRegex(RuntimeError,'byte/hash'):m.retrieve(task,d)
   self.assertFalse(Path(d,'mobile/child.stdout').exists())
 def test_destination_created_during_download_keeps_user_content(self):
  task,data,digest=self.fixture()
  with tempfile.TemporaryDirectory() as d:
   target=Path(d,'mobile/child.stdout')
   def reply(action,body):
    target.parent.mkdir(exist_ok=True);target.write_bytes(b'new user work')
    return self.reply(task,data,digest,body)
   with patch.object(m,'request',side_effect=reply),self.assertRaisesRegex(RuntimeError,'Existing artifact differs'):m.retrieve(task,d)
   self.assertEqual(target.read_bytes(),b'new user work')
   self.assertFalse(Path(d,'.fleet-task-manifest.json').exists())
 def test_existing_provenance_is_preserved(self):
  task,data,digest=self.fixture()
  with tempfile.TemporaryDirectory() as d:
   provenance=Path(d,'.fleet-task-manifest.json');provenance.write_bytes(b'existing user provenance')
   with patch.object(m,'request',side_effect=lambda action,body:self.reply(task,data,digest,body)),self.assertRaisesRegex(RuntimeError,'Existing artifact differs'):
    m.retrieve(task,d)
   self.assertEqual(provenance.read_bytes(),b'existing user provenance')
 def test_await_waits_for_terminal_evidence_recovery_and_read_refuses_partial_output(self):
  task,_,_=self.fixture();pending={**task,'artifacts':None,'artifactsPending':True};output=io.StringIO()
  with patch.object(sys,'argv',['fleet-task.py','await',task['id']]),patch.object(m,'request',side_effect=[pending,task]) as request,patch.object(m.time,'sleep') as sleep,redirect_stdout(output):
   m.main()
  self.assertEqual(request.call_count,2);sleep.assert_called_once_with(5)
  self.assertEqual(json.loads(output.getvalue())['state'],'failed')
  with tempfile.TemporaryDirectory() as d,patch.object(sys,'argv',['fleet-task.py','read',task['id'],'--out',d]),patch.object(m,'request',return_value=pending):
   with self.assertRaisesRegex(RuntimeError,'still transferring'):m.main()
   self.assertEqual(list(Path(d).iterdir()),[])

if __name__=='__main__':unittest.main()
