#!/usr/bin/env python3
"""Existing fleet supervisor's admitted native work. Requests cannot supply shell commands."""
import hashlib
import json
import os
import platform
import re
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

RECIPES={'platform-probe','memory-runtime-smoke','android-tool-then-text','dispatcher-repair'}

def atomic(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_suffix('.new')
    temporary.write_text(json.dumps(value));temporary.chmod(0o600);temporary.replace(path)

def clean_env():
    # Trusted launchers retain their own authentication. Build/test processes cannot access fleet administrators.
    return {k:v for k,v in os.environ.items() if not k.startswith('FLEET_') and k not in {'GITHUB_TOKEN','GH_TOKEN','OP_SERVICE_ACCOUNT_TOKEN','PYRY_MANAGER_TOKEN','PYRY_MANAGER_URL','PYRY_DEV_AGENTS_TOKEN','PYRY_LIVE_CLAUDE_TOKEN','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'}}

def execute(argv,cwd,log,env=None,timeout=3600):
    """Only the new session created here can receive cleanup signals."""
    with log.open('ab') as out:
        child=subprocess.Popen(argv,cwd=cwd,env=env or clean_env(),stdin=subprocess.DEVNULL,stdout=out,stderr=out,start_new_session=True)
        try:
            code=child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid,signal.SIGTERM)
            try:code=child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid,signal.SIGKILL);code=child.wait()
        # Fixture children are owned by the isolated command group, even after their parent exits.
        try:os.killpg(child.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        end=time.monotonic()+15
        while time.monotonic()<end:
            try:os.killpg(child.pid,0)
            except ProcessLookupError:return code
            time.sleep(.1)
        try:os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        while True:
            try:os.killpg(child.pid,0)
            except ProcessLookupError:return code
            time.sleep(.2)

def clone(source,destination,revision=None):
    if destination.exists():raise RuntimeError('A task checkout already exists; it must not be overwritten')
    subprocess.run(['git','clone','--no-checkout',str(source),str(destination)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if revision:
        subprocess.run(['git','-C',str(destination),'remote','set-url','origin','https://github.com/pyrycode/pyrycode.git'],check=True)
        subprocess.run(['git','-C',str(destination),'fetch','origin',revision],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['git','-C',str(destination),'switch','--detach',revision],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    else:
        subprocess.run(['git','-C',str(destination),'switch','main'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


def native_recipe(task,paths,directory):
    request=task['request'];recipe=request['recipe'];files={};log=directory/'execution.log'
    if recipe not in RECIPES:raise RuntimeError('Unknown fixed recipe')
    if recipe=='platform-probe':
        details={'platform':platform.system(),'architecture':platform.machine(),'candidate_tests_executed':False}
        return {'outcome':'completed','summary':'Managed native execution route is available. This probe is not candidate test evidence.','files':{'platform.json':json.dumps(details)}}
    if recipe=='dispatcher-repair':
        code=execute([paths['node'], '--import', paths['tsx'], paths['repairProgram'],str(directory/'task.json')],directory,log,timeout=5400)
        record=directory/'repair-result.json'
        if not record.is_file():raise RuntimeError('Repair did not retain its independent review result')
        return json.loads(record.read_text())
    core=directory/'core'
    clone(paths['core'],core,request['revision'])
    env=clean_env()
    if recipe=='memory-runtime-smoke':
        record=directory/'smoke.json';env['PYRY_MEMORY_SMOKE_EVIDENCE']=str(record)
        code=execute(['go','test','-race','-count=1','./internal/memoryruntime'],core,log,env)
        if code==0:code=execute(['go','test','-tags','memory_runtime_smoke','-run','^TestSmoke$','-count=1','-v','./internal/memoryruntime'],core,log,env)
        if record.is_file():
            files['smoke.json']=record.read_text()
            counted=json.loads(files['smoke.json'])
            if not counted.get('executed') or counted.get('passed')!=counted.get('executed'):code=1
        elif code==0:code=1
        summary='Native package and installer smoke execution completed.' if code==0 else 'Native check failed. Exact candidate and private diagnostic log retained.'
    else:
        if os.environ.get('CLAUDE_CODE_OAUTH_TOKEN'):env['CLAUDE_CODE_OAUTH_TOKEN']=os.environ['CLAUDE_CODE_OAUTH_TOKEN']
        if os.environ.get('PYRY_LIVE_CLAUDE_TOKEN'):env['PYRY_LIVE_CLAUDE_TOKEN']=os.environ['PYRY_LIVE_CLAUDE_TOKEN']
        mobile=directory/'mobile';clone(paths['mobile'],mobile)
        driver=core/'internal/e2e/realclaude/tool_then_text_mobile_capture.py'
        if not driver.is_file():raise RuntimeError('The exact candidate does not supply the approved capture recipe')
        # No credentials are copied. Each configured admitted launcher owns its existing login.
        code=execute([sys.executable,str(driver),'--mobile',str(mobile),'--mobile-agents',paths['mobileAgents'],'--daemon-agents',paths['coreAgents']],core,log,env)
        text=log.read_text(errors='replace')
        matches=re.findall(r'#2939 private recovery: (/[^\n]+)',text)
        if len(matches)!=1:raise RuntimeError('Capture returned no unique private recovery directory')
        capture=Path(matches[0])
        # Include the ordered recorder input and launcher diagnostics on failures
        # as well as passes. The authority refuses credential-shaped content.
        for path in capture.rglob('*'):
            if path.is_file() and path.suffix in {'.json','.jsonl','.xml','.stdout','.stderr'}:
                files['mobile/'+str(path.relative_to(capture))]=path.read_text()
        summary='Android capture completed. Inspect counted XML and recorder admission before accepting evidence.' if code==0 else 'Android capture failed. Returned diagnostic records do not establish a passing method.'
    if sum(len(v.encode()) for v in files.values())>4*1024*1024:
        files={};summary+=' Artifact bundle exceeds transport size; its original private directory remains available.';code=1
    return {'outcome':'completed' if code==0 else 'failed','summary':summary,'files':files}

def route_available(route):
    capability=route['capability']
    required=['go'] if capability in {'linux-amd64','macos-arm64'} else ['go','java','adb'] if capability=='android-emulator' else ['node','pnpm','codex']
    probe="import shutil,sys; sys.exit(0 if all(shutil.which(x) for x in "+repr(required)+") else 1)"
    args=['podman','exec',route['container'],'python3','-c',probe] if route.get('container') else [sys.executable,'-c',probe]
    try:return subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15).returncode==0
    except (OSError,subprocess.TimeoutExpired):return False

class SupportSupervisor:
    def __init__(self,adapter,config):
        self.adapter=adapter;self.config=config;self.children={};self.directory=Path(config['stateDirectory'])/'tasks'
        self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)

    def rpc(self,operation,body):
        path=self.directory/(operation+'.request.json');atomic(path,body)
        output=subprocess.check_output(self.adapter.operator_command('recovery-task',operation,str(path)),text=True,timeout=150)
        return json.loads(output)

    def route_ready(self,route):
        if route.get('container'):
            for project,cfg in self.config.get('projects',{}).items():
                if cfg.get('container')!=route['container']:continue
                receipt=Path(self.config['stateDirectory'])/(project.replace('/','_')+'.json')
                if receipt.exists() and json.loads(receipt.read_text()).get('phase')!='complete':return False
        return route_available(route)

    def tick(self):
        routes=self.config.get('recoveryTasks',{})
        if not routes:return []
        state=self.adapter.status();machine=state['machine']
        session_file=self.directory/'scheduler-session.json'
        if not session_file.exists():atomic(session_file,{'session':uuid.uuid4().hex})
        scheduler_session=json.loads(session_file.read_text())['session']
        capabilities=sorted(set(route['capability'] for route in routes.values() if self.route_ready(route)))
        self.rpc('capabilities',{'machine':machine,'record':{'capabilities':capabilities,'ready':not state.get('draining',False)}})
        running=[]
        for receipt in self.directory.glob('*.receipt.json'):
            old=json.loads(receipt.read_text())
            if old['phase']=='complete':continue
            result=Path(old['result'])
            child=self.children.get(old.get('pid'))
            if child is not None:alive=child.poll() is None
            elif old.get('pid'):
                observed=subprocess.run(['ps','-p',str(old['pid']),'-o','stat='],capture_output=True,text=True).stdout.strip()
                alive=bool(observed) and not observed.startswith('Z')
            else:alive=False
            if result.is_file() and not alive:
                value=json.loads(result.read_text())
                publication=value.get('files',{}).pop('publication.json',None)
                if publication:
                    self.rpc('prepare-repair',{'machine':machine,'id':old['id'],'session':old['session'],'publication':json.loads(publication)})
                    old['phase']='publishing';atomic(receipt,old)
                    published=self.rpc('publish-repair',{'machine':machine,'id':old['id'],'session':old['session'],'publication':json.loads(publication)})
                    if published.get('pendingControl'):running.append(old);continue
                    value['summary']='Dispatcher repair '+published['url']+'. '+('Merged; supervised rollout is pending.' if published.get('merged') else published.get('reason','Review remains pending.'))
                    value['files']={'publication-result.json':json.dumps(published)}
                    if published.get('dispatcherSHA'):value['dispatcherRevision']=published['dispatcherSHA']
                self.rpc('complete' ,{'machine':machine,'id':old['id'],'session':old['session'],'result':value})
                old['phase']='complete';atomic(receipt,old)
            elif old['phase']=='attention':
                running.append(old)
            elif old['phase']=='launch-requested' or not alive:
                # Delivery could have happened before a crash. Never create another worker.
                old['phase']='attention';old['reason']='Task worker ended without confirmed terminal evidence; inspect the retained process and reservation';atomic(receipt,old)
                self.rpc('uncertain',{'machine':machine,'id':old['id'],'session':old['session'],'reason':old['reason']})
                running.append(old)
            else:running.append(old)
        if state.get('draining'):return running
        for grant in self.rpc('schedule',{'session':scheduler_session}):
            task=grant['task'];session=grant['run']['session']
            receipt=self.directory/(task['id']+'.receipt.json')
            if receipt.exists():continue
            route=routes.get(task['request']['recipe']+':'+task['request']['capability'])
            if not route:raise RuntimeError('The admitted task has no configured recipe route')
            admitted={'ok':True,'runnerPolicy':grant['run'].get('runnerPolicy'),'run':grant['run']}
            folder=Path(route['directory'])/task['id'];folder.mkdir(parents=True,exist_ok=True,mode=0o700)
            result=folder/'result.json';task['admission']=admitted
            atomic(folder/'task.json',task);atomic(folder/'paths.json',route['paths'])
            program=folder/'worker.py';program.write_text(Path(__file__).read_text());program.chmod(0o700)
            if route.get('container'):
                root=route['containerDirectory'].rstrip('/')+'/'+task['id']
                command=['podman','exec',route['container'],'python3',root+'/worker.py','--worker',root]
            else:command=[sys.executable,str(program),'--worker',str(folder)]
            saved={'id':task['id'],'session':session,'phase':'launch-requested','result':str(result),'created':time.time(),'container':route.get('container')}
            receipt=self.directory/(task['id']+'.receipt.json');atomic(receipt,saved)
            with (folder/'worker.log').open('ab') as output:
                child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=output,stderr=output,start_new_session=True,env=clean_env())
            self.children[child.pid]=child
            saved.update(phase='running',pid=child.pid);atomic(receipt,saved)
            return running+[saved]
        return []

def main():
    os.umask(0o077)
    if len(sys.argv)!=3 or sys.argv[1]!='--worker':raise SystemExit('Worker requires a saved private task directory')
    directory=Path(sys.argv[2])
    try:result=native_recipe(json.loads((directory/'task.json').read_text()),json.loads((directory/'paths.json').read_text()),directory)
    except Exception as error:result={'outcome':'failed','summary':'Native execution failed: '+type(error).__name__+'. Private logs retained.','files':{}}
    atomic(directory/'result.json',result)
if __name__=='__main__':main()
