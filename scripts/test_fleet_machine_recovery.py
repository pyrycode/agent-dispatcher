import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

m=load('fleet-machine-recovery')
s=load('fleet-supervisor')

class Tests(unittest.TestCase):
    def fixture(self,d):
        root=Path(d);target=root/'source';target.mkdir()
        subprocess.run(['git','init','-q',str(target)],check=True)
        subprocess.run(['git','-C',str(target),'-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-qm','initial'],check=True)
        tree=root/'builder-2245'
        subprocess.run(['git','-C',str(target),'worktree','add','-qb','feature/2245',str(tree)],check=True)
        (tree/'unfinished.txt').write_text('unique uncommitted source')
        (tree/'capture.png').write_bytes(b'unique evidence')
        agents=root/'agents';(agents/'logs').mkdir(parents=True)
        (agents/'logs'/'builder-2245.log').write_text('original failure details')
        cfg={'platform':'mac','stateDirectory':str(root/'state'),'projects':{'org/mobile':{'agents':str(agents),'target':str(target)}}}
        cfg['stateDirectory']=str(root/'state');Path(cfg['stateDirectory']).mkdir()
        worker={'id':'original-run','machine':'mac','project':'org/mobile','ticket':'org/mobile#2245','session':'original','generation':'g','role':'builder'}
        state={'machine':'mac','runs':[worker],'desiredState':{'known':True,'projects':{'org/mobile':{'run':'running','effectiveWork':'taking'}}}}
        class Adapter:
            def observe(self,project):return {'stopped':True,'childrenStopped':True}
            def operator_command(self,*args):return list(args)
            def identity_from_receipt(self,project):return {'pid':1,'start':'Sun Oct 18 01:00:00 2026'}
            def status(self):return state
        return root,tree,cfg,state,Adapter()

    def test_preserves_source_logs_and_captures_before_requesting_exact_recovery(self):
        with tempfile.TemporaryDirectory() as d:
            root,tree,cfg,state,adapter=self.fixture(d);calls=[]
            actual=m.run
            def run(args):
                calls.append(args)
                if args[0]=='workflow':return json.dumps({'items':[{'issueNumber':2245,'revision':4}]})
                if args[:2]==['machine-recovery','release']:
                    body=json.loads(Path(args[2]).read_text())
                    receipts=list((root/'state'/'machine-recovery').glob('stopped-*.json'))
                    self.assertTrue(receipts)
                    self.assertEqual(body['revision'],4)
                    self.assertEqual(body['proof'],'native-stopped')
                    self.assertEqual((tree/'unfinished.txt').read_text(),'unique uncommitted source')
                    return json.dumps({**body,'ticket':'org/mobile#2245','project':'org/mobile','created':1})
                return actual(args)
            with patch.object(m,'run',side_effect=run),patch.object(m,'stopped_proof',return_value='native-stopped'):
                result=m.tick(adapter,cfg,state)
            self.assertEqual(result[0]['action'],'released')
            self.assertEqual((tree/'capture.png').read_bytes(),b'unique evidence')
            self.assertEqual((root/'agents/logs/builder-2245.log').read_text(),'original failure details')
            receipt=next(p for p in (root/'state'/'machine-recovery').glob('stopped-*.json') if not p.name.endswith('.request.json'))
            saved=json.loads(receipt.read_text())
            self.assertTrue(saved['worktrees'][0]['dirty']);self.assertIn('released',saved)
            with patch.object(m,'run',side_effect=AssertionError('must not repeat release')):
                self.assertEqual(m.tick(adapter,cfg,state),[])

    def test_live_uncertain_deliberately_stopped_and_drained_workers_are_never_released(self):
        for kind in ['alive','children alive','stopped','drained','unknown','manager drained']:
            with self.subTest(kind),tempfile.TemporaryDirectory() as d:
                _,_,cfg,state,adapter=self.fixture(d)
                if kind=='alive':adapter.observe=lambda _: {'stopped':False,'childrenStopped':False}
                if kind=='children alive':adapter.observe=lambda _: {'stopped':True,'childrenStopped':False}
                if kind=='stopped':state['desiredState']['projects']['org/mobile']['run']='stopped'
                if kind=='drained':state['desiredState']['projects']['org/mobile']['effectiveWork']='drained'
                if kind=='unknown':state['desiredState']['known']=False
                if kind=='manager drained':state['draining']=True
                with patch.object(m,'run',side_effect=AssertionError('no recovery commands')):
                    self.assertEqual(m.tick(adapter,cfg,state),[])

    def test_lost_reply_is_reconciled_after_restart_without_touching_the_replacement(self):
        with tempfile.TemporaryDirectory() as d:
            root,_,cfg,state,adapter=self.fixture(d);actual=m.run;accepted=[]
            def run(args):
                if args[0]=='workflow':return json.dumps({'items':[{'issueNumber':2245,'revision':4}]})
                if args[:2]==['machine-recovery','read']:return json.dumps(accepted)
                if args[:2]==['machine-recovery','release']:
                    accepted.append(json.loads(Path(args[2]).read_text()))
                    raise RuntimeError('lost successful response')
                return actual(args)
            with patch.object(m,'run',side_effect=run),patch.object(m,'stopped_proof',return_value='native-stopped'):
                self.assertEqual(m.tick(adapter,cfg,state)[0]['action'],'attention')
                state['runs']=[{**state['runs'][0],'machine':'other','id':'replacement'}]
                self.assertEqual(m.tick(adapter,cfg,state),[])
            receipt=next(p for p in (root/'state/machine-recovery').glob('stopped-*.json') if not p.name.endswith('.request.json'))
            self.assertEqual(json.loads(receipt.read_text())['released'],accepted[0])

    def test_native_proof_requires_no_surviving_environment_or_open_paths(self):
        with tempfile.TemporaryDirectory() as d:
            root,tree,cfg,_,adapter=self.fixture(d)
            for ps,answer,expected in [
                (f'{os.getuid()} 1 idle-process\n',{'stopped':True},'native-stopped'),
                (f'{os.getuid()} 1 agent AGENTS_REPO_PATH={root}/agents\n',{'stopped':True},None),
                (f'{os.getuid()} 1 detached-worker {tree}\n',{'stopped':True},None),
                (f'{os.getuid()} 1 idle-process\n',{'stopped':False},None),
                ('unreadable census\n',{'stopped':True},None),
                ('',{'stopped':True},None),
            ]:
                def run(args):return ps if args[0]=='ps' else json.dumps(answer)
                with patch.object(m,'run',side_effect=run):
                    self.assertEqual(m.stopped_proof(adapter,cfg,'org/mobile',[{'path':str(tree)}]),expected)

    def test_process_census_distinguishes_older_readers_and_other_projects_from_surviving_workers(self):
        with tempfile.TemporaryDirectory() as d:
            root,tree,cfg,_,adapter=self.fixture(d)
            cfg['projects']['org/desktop']={'agents':str(root/'desktop-agents'),'target':str(root/'desktop')}
            for description,text,born,expected in [
                ('older reader',str(root/'source'),'Sat Oct 17 12:00:00 2026','native-stopped'),
                ('current worker','AGENTS_REPO_PATH='+str(root/'agents'),'Sun Oct 18 02:00:00 2026',None),
                ('foreign project','AGENTS_REPO_PATH='+str(root/'desktop-agents')+' DEPENDENCY='+str(root/'source'),'Sun Oct 18 02:00:00 2026','native-stopped'),
                ('prefix is another project',str(root/'source-mobile'),'Sun Oct 18 02:00:00 2026','native-stopped'),
            ]:
                def run(args):
                    if args[:2]==['ps','eww']:return str(os.getuid())+' 9 '+text+'\n'
                    if args[0]=='ps':return born
                    return json.dumps({'stopped':True})
                with self.subTest(description),patch.object(m,'run',side_effect=run):
                    self.assertEqual(m.stopped_proof(adapter,cfg,'org/mobile',[{'path':str(tree)}]),expected)

    def test_linux_inspect_error_running_and_stopping_are_uncertainty(self):
        with tempfile.TemporaryDirectory() as d:
            _,_,cfg,_,adapter=self.fixture(d);cfg['platform']='linux';cfg['projects']['org/mobile']['container']='mobile'
            for status,expected in [('exited 0','container-stopped'),('running 12',None),('stopping 12',None),('bad',None),('exited 12',None)]:
                with patch.object(m,'run',return_value=status):self.assertEqual(m.stopped_proof(adapter,cfg,'org/mobile',[]),expected)
            with patch.object(m,'run',side_effect=RuntimeError('unreachable')):
                self.assertRaises(RuntimeError,m.stopped_proof,adapter,cfg,'org/mobile',[])

    def test_recovery_source_hold_prevents_supervisor_restart_without_changing_operator_policy(self):
        with tempfile.TemporaryDirectory() as d:
            _,_,cfg,state,adapter=self.fixture(d)
            state['machineRecoveries']=[{'machine':'mac','project':'org/mobile','commandId':'proof'}]
            supervisor=s.Supervisor(cfg['stateDirectory'],adapter)
            self.assertEqual(supervisor.desired_run('org/mobile'),'stopped')
            self.assertEqual(state['desiredState']['projects']['org/mobile']['run'],'running')
            state['machineRecoveries'][0]['cleared']=1
            self.assertEqual(supervisor.desired_run('org/mobile'),'running')

if __name__=='__main__':unittest.main()
