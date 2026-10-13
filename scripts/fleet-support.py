#!/usr/bin/env python3
"""Existing fleet supervisor's admitted native work. Requests cannot supply shell commands."""
import hashlib
import base64
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
from contextlib import contextmanager

RECIPES={'platform-probe','memory-runtime-smoke','android-tool-then-text','dispatcher-repair'}
# Deterministic local failures of retained artifacts. Anything else is retried next pass.
UNRECOVERABLE_ARTIFACTS=('Capture returned no unique private recovery directory','Capture artifact escapes its private directory',
    'Capture artifacts exceed total bounds','Retained task receipt mismatch','Invalid artifact path','Task artifacts exceed total bounds')

def artifacts_unrecoverable(error):
    if isinstance(error,(FileNotFoundError,KeyError)):return True
    return type(error) is RuntimeError and str(error).startswith(UNRECOVERABLE_ARTIFACTS)
ARTIFACT_BYTES=64*1024*1024
ARTIFACT_FILES=1024
CHUNK_BYTES=256*1024

def capture_records(log):
    matches=re.findall(r'#2939 private recovery: (/[^\n]+)',log.read_text(errors='replace'))
    if len(matches)!=1:raise RuntimeError('Capture returned no unique private recovery directory')
    capture=Path(matches[0]).resolve(strict=True);files={};total=0
    for path in sorted(capture.rglob('*')):
        if path.is_file() and path.suffix in {'.json','.jsonl','.xml','.stdout','.stderr'} and not any('logcat' in part.lower() for part in path.relative_to(capture).parts):
            if capture not in path.resolve(strict=True).parents:raise RuntimeError('Capture artifact escapes its private directory')
            total+=path.stat().st_size
            if len(files)>=ARTIFACT_FILES or total>ARTIFACT_BYTES:raise RuntimeError('Capture artifacts exceed total bounds; private inventory retained')
            # Decode strictly and preserve CRLF and exact UTF-8 bytes.
            files['mobile/'+str(path.relative_to(capture))]=path.read_bytes().decode('utf-8')
    return files

def artifact_manifest(files):
    entries=[];total=0
    for name,content in sorted(files.items()):
        if not re.fullmatch(r'[\w./-]+',name,flags=re.ASCII) or len(name)>240 or name.startswith('/') or any(p in {'','.','..'} for p in name.split('/')) or name.split('/')[0].startswith('.fleet-task-'):
            raise RuntimeError('Invalid artifact path')
        data=content.encode('utf-8');total+=len(data)
        entries.append({'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),
                        'chunks':[hashlib.sha256(data[i:i+CHUNK_BYTES]).hexdigest() for i in range(0,len(data),CHUNK_BYTES)]})
    manifest={'version':1,'chunkBytes':CHUNK_BYTES,'totalBytes':total,'files':entries}
    if len(entries)>ARTIFACT_FILES or total>ARTIFACT_BYTES or len(json.dumps(manifest,separators=(',',':')))>1024*1024:raise RuntimeError('Task artifacts exceed total bounds')
    return manifest

def atomic(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_suffix('.new')
    temporary.write_text(json.dumps(value));temporary.chmod(0o600);temporary.replace(path)

def clean_env():
    # Trusted launchers retain their own authentication. Build/test processes cannot access fleet administrators.
    return {k:v for k,v in os.environ.items() if not k.startswith('FLEET_') and k not in {'GITHUB_TOKEN','GH_TOKEN','OP_SERVICE_ACCOUNT_TOKEN','PYRY_MANAGER_TOKEN','PYRY_MANAGER_URL','PYRY_DEV_AGENTS_TOKEN','PYRY_LIVE_CLAUDE_TOKEN','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'}}

def process_snapshot():
    """Read identities, never commands/environments. Failure is uncertainty, not absence."""
    try:
        records={}
        if sys.platform.startswith('linux'):
            # A procfs mounted from another PID namespace cannot prove our child's absence.
            if int(Path('/proc/self/stat').read_text().split(' ',1)[0])!=os.getpid():return None
            boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            for path in Path('/proc').iterdir():
                if not path.name.isdigit():continue
                try:
                    fields=(path/'stat').read_text().rsplit(')',1)[1].split()
                except FileNotFoundError:continue
                pid=int(path.name)
                records[pid]={'pid':pid,'ppid':int(fields[1]),'pgid':int(fields[2]),'sid':int(fields[3]),
                              'identity':boot+':'+fields[19],'state':fields[0]}
        else:
            output=subprocess.check_output(['ps','-axo','pid=,ppid=,pgid=,lstart=,stat='],text=True,timeout=5)
            for line in output.splitlines():
                fields=line.split()
                if len(fields)!=9:raise ValueError('Incomplete process census')
                pid=int(fields[0])
                records[pid]={'pid':pid,'ppid':int(fields[1]),'pgid':int(fields[2]),'sid':None,
                              'identity':' '.join(fields[3:8]),'state':fields[8]}
        if os.getpid() not in records:return None
        return records
    except (OSError,ValueError,IndexError,subprocess.SubprocessError):return None

def observe_custody(record,snapshot):
    """Keep observed descendants across reparenting and reject PID/group reuse."""
    if snapshot is None or not record.get('root'):return 'uncertain'
    root=record['root'];pid=root['pid'];current=snapshot.get(pid)
    if current and current['identity']!=root['identity']:return 'uncertain'
    owned=record.setdefault('owned',{})
    unproved=record.setdefault('unproved',{})
    parents={pid} if current else set()
    for key,identity in owned.items():
        row=snapshot.get(int(key))
        if row and row['identity']==identity:parents.add(row['pid'])
    # A group number can be reused after its last member exits. Only a matching
    # recorded identity anchors ownership and permits discovering group members.
    group={p for p,row in snapshot.items() if row['pgid']==pid or (root.get('sid')==pid and row.get('sid')==pid)}
    anchored=bool(group&parents)
    members=parents|(group if anchored else set())
    while True:
        descendants={p for p,row in snapshot.items() if row['ppid'] in members}
        expanded=members|descendants
        if expanded==members:break
        members=expanded
    for p in members:
        if p in snapshot:
            owned[str(p)]=snapshot[p]['identity'];unproved.pop(str(p),None)
    # Unanchored members cannot receive signals. Preserve their identity across
    # reparenting too: disappearance from the old group alone proves no drainage.
    possible={int(key) for key,identity in unproved.items() if int(key) in snapshot and snapshot[int(key)]['identity']==identity}
    if not anchored:possible.update(group)
    while True:
        expanded=possible|{p for p,row in snapshot.items() if row['ppid'] in possible}
        if expanded==possible:break
        possible=expanded
    for p in possible-members:unproved[str(p)]=snapshot[p]['identity']
    alive=any(p in snapshot and snapshot[p]['identity']==identity and not snapshot[p]['state'].startswith(('Z','X'))
              for key,identity in owned.items() for p in [int(key)])
    unknown=any(p in snapshot and snapshot[p]['identity']==identity and not snapshot[p]['state'].startswith(('Z','X'))
                for key,identity in unproved.items() for p in [int(key)])
    return 'alive' if alive else 'uncertain' if unknown else 'drained'

def new_custody(pid):
    snapshot=process_snapshot()
    root=snapshot.get(pid) if snapshot is not None else None
    record={'root':root,'owned':{},'phase':'uncertain','denied':False}
    observe_custody(record,snapshot)
    return record

def custody_file(log):return log.with_suffix('.custody.json')

def poll_with_custody(child,observe):
    # WNOWAIT leaves an exited leader in the census until its descendants have
    # been recorded. This closes the exit window between a census and poll().
    if getattr(child,'pid',None) and hasattr(os,'waitid') and hasattr(os,'WNOWAIT'):
        try:
            if os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:return None
        except OSError:
            # Already-reaped children and unavailable waitid still require the
            # independent identity census; this error never proves drainage.
            pass
    observe()
    return child.poll()

def reassess_commands(journal,snapshot):
    states=[]
    for record in journal['commands']:
        state=observe_custody(record,snapshot) if record['phase']!='drained' else 'drained'
        record['phase']=state;states.append(state)
    return states

def command_custody(directory):
    """Reassess and retain command identities after worker exit, without signalling."""
    path=custody_file(directory/'execution.log')
    if not path.is_file():return 'uncertain'
    try:
        journal=json.loads(path.read_text())
        states=reassess_commands(journal,process_snapshot())
        # Reassessment can discover descendants that later leave the original session.
        # Their identities must survive the next supervisor poll/restart.
        atomic(path,journal)
        return 'alive' if 'alive' in states else 'drained' if states and all(state=='drained' for state in states) else 'uncertain'
    except (OSError,ValueError,KeyError,TypeError):return 'uncertain'

def directory_custody(directory):
    if custody_file(directory/'execution.log').is_file():return command_custody(directory)
    # Only this fixed recipe creates no command workers.
    try:return 'drained' if json.loads((directory/'task.json').read_text())['request']['recipe']=='platform-probe' else 'uncertain'
    except (OSError,ValueError,KeyError,TypeError):return 'uncertain'

@contextmanager
def cancellation_guard():
    cancelled=[];handlers={}
    def cancel(sig,frame):
        if not cancelled:cancelled.append(sig)
    try:
        for sig in (signal.SIGTERM,signal.SIGINT):
            handlers[sig]=signal.getsignal(sig);signal.signal(sig,cancel)
        yield cancelled
    finally:
        for sig,handler in handlers.items():signal.signal(sig,handler)

def execute(argv,cwd,log,env=None,timeout=3600,*,cleanup_timeout=15):
    """Only this new group receives signals. Denial stops signalling, but not report collection."""
    path=custody_file(log)
    journal=json.loads(path.read_text()) if path.is_file() else {'commands':[]}
    if journal['commands']:
        states=reassess_commands(journal,process_snapshot())
        atomic(path,journal)
        if any(state!='drained' for state in states):return 1
    with cancellation_guard() as cancelled,log.open('ab') as out:
        # Retain uncertain launch intent before spawning. A crash between Popen
        # and recording the identity cannot authorize another command.
        record={'root':None,'owned':{},'phase':'uncertain','denied':False}
        journal['commands'].append(record);atomic(path,journal)
        try:
            child=subprocess.Popen(argv,cwd=cwd,env=env if env is not None else clean_env(),stdin=subprocess.DEVNULL,stdout=out,stderr=out,start_new_session=True)
        except OSError:
            # Popen reaps an exec-failed child before raising. No worker launched.
            record['phase']='drained';atomic(path,journal)
            raise
        record.update(new_custody(child.pid))
        def save():atomic(path,journal)
        def observe():
            state=observe_custody(record,process_snapshot());record['phase']=state
            save();return state
        def group_signal(sig):
            if record['denied']:return False
            if sig!=0:
                snapshot=process_snapshot()
                if observe_custody(record,snapshot)!='alive':return False
                if not any(row['pgid']==child.pid and record['owned'].get(str(pid))==row['identity'] for pid,row in snapshot.items()):return False
            try:os.killpg(child.pid,sig);return True
            except ProcessLookupError:return False
            except OSError:
                record['denied']=True;record['reason']='Group signal/probe denied or unavailable';save();return False
        try:
            save()
            deadline=time.monotonic()+timeout
            timed_out=False
            # poll() reaps an exited leader. Census first so its identity still
            # anchors ownership of grandchildren born just before it exited.
            while True:
                observe()
                code=poll_with_custody(child,observe)
                if code is not None or cancelled:break
                if time.monotonic()>=deadline:timed_out=True;break
                time.sleep(.05)
            # Probe once even after a successful leader exit: EPERM needs independent drainage evidence.
            group_signal(0)
            state=observe()
            if state!='drained' and not record['denied']:
                # Do not signal a group whose ownership cannot be independently established.
                if state=='alive':group_signal(signal.SIGTERM)
                end=time.monotonic()+cleanup_timeout
                while state!='drained' and not record['denied'] and time.monotonic()<end:
                    time.sleep(.05);poll_with_custody(child,observe);state=observe()
                if state=='alive' and not record['denied']:group_signal(signal.SIGKILL)
                end=time.monotonic()+cleanup_timeout
                while state!='drained' and not record['denied'] and time.monotonic()<end:
                    time.sleep(.05);poll_with_custody(child,observe);state=observe()
            record['phase']=state;save()
            code=poll_with_custody(child,observe) if code is None else code
            return code if state=='drained' and not timed_out and not cancelled and code is not None else 1
        finally:
            # Persist custody even if a non-signal failure interrupts report collection.
            save()

def clone(source,destination,revision=None):
    if destination.exists():raise RuntimeError('A task checkout already exists; it must not be overwritten')
    log=destination.parent/'execution.log'
    def git(*args):
        if execute(['git',*args],destination.parent,log,timeout=300)!=0:
            raise RuntimeError('Checkout setup failed or has incomplete custody; private logs retained')
    git('clone','--no-checkout',str(source),str(destination))
    if revision:
        git('-C',str(destination),'remote','set-url','origin','https://github.com/pyrycode/pyrycode.git')
        git('-C',str(destination),'fetch','origin',revision)
        git('-C',str(destination),'switch','--detach',revision)
    else:
        git('-C',str(destination),'switch','main')


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
        result=json.loads(record.read_text())
        if code!=0:
            result['outcome']='failed';result['files'].pop('publication.json',None)
            result['summary']='Repair command did not complete with confirmed drainage. '+result['summary']
        return result
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
        # Include the ordered recorder input and launcher diagnostics on failures
        # as well as passes. The authority refuses credential-shaped content.
        files=capture_records(log)
        summary='Android capture completed. Inspect counted XML and recorder admission before accepting evidence.' if code==0 else 'Android capture failed. Returned diagnostic records do not establish a passing method.'
    artifact_manifest(files)
    return {'outcome':'completed' if code==0 else 'failed','summary':summary,'files':files}

class ArtifactPassError(Exception):
    """A completed record's artifact recovery failed. No worker or host state is involved."""
    def __init__(self,error):super().__init__(type(error).__name__+': '+str(error));self.error=error

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
        # Optional callable(kind, subject, reason) for automatic state changes.
        self.housekeeping=None
        # Persisted so a supervisor re-exec does not log the same skip again.
        self.skips_file=Path(config['stateDirectory'])/'native-task-skips.json'
        try:self.reported_errors=json.loads(self.skips_file.read_text())
        except (OSError,ValueError):self.reported_errors={}
        if not isinstance(self.reported_errors,dict):self.reported_errors={}
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

    def drained(self,old,receipt):
        if old.get('drainConfirmed'):return True
        custody=old.get('custody')
        if not custody:return False
        custody['phase']=observe_custody(custody,process_snapshot())
        # This final census may discover a child absent from the earlier tick census.
        atomic(receipt,old)
        if custody['phase']!='drained':return False
        # A session leader's exit says nothing about its separately launched command groups.
        if old.get('container'):
            root=old.get('containerDirectory')
            if not root:return False
            try:
                result=subprocess.check_output(['podman','exec',old['container'],'python3',root+'/worker.py','--custody',root],text=True,timeout=15)
                drained=json.loads(result).get('phase')=='drained'
            except (OSError,ValueError,subprocess.SubprocessError):return False
        else:
            directory=Path(old.get('directory',str(Path(old['result']).parent)))
            drained=directory_custody(directory)=='drained'
        if drained:
            # Completion and publication can be retried after a restart. Once
            # every group drained, PID reuse cannot revoke that proof.
            old['drainConfirmed']=True;atomic(receipt,old)
        return drained

    def artifact_files(self,receipt,value):
        """Local inputs only. A failure here repeats on every pass."""
        files=value.get('files',{})
        # The old helper discarded oversized capture records but retained their
        # directory in its private execution log. Recover that saved execution.
        if not files and 'Artifact bundle exceeds transport size;' in value['summary']:
            directory=Path(receipt['result']).parent
            task=json.loads((directory/'task.json').read_text())
            if task['id']!=receipt['id'] or task['request']['recipe']!='android-tool-then-text':raise RuntimeError('Retained task receipt mismatch')
            files=capture_records(directory/'execution.log')
        artifact_manifest(files)
        return files

    def return_artifacts(self,machine,receipt,value,files=None):
        if files is None:files=self.artifact_files(receipt,value)
        manifest=artifact_manifest(files)
        identity={'machine':machine,'id':receipt['id'],'session':receipt['session']}
        transfer=self.rpc('artifacts-begin',{**identity,'manifest':manifest})
        digest=hashlib.sha256(json.dumps(manifest,separators=(',',':')).encode()).hexdigest()
        if transfer['digest']!=digest:raise RuntimeError('Artifact manifest hash mismatch')
        # The authority records each acknowledged part. An interrupted supervisor
        # restart asks for missing parts and never repeats the native execution.
        for entry in manifest['files']:
            data=files[entry['path']].encode()
            for part in transfer['missing'][entry['path']]:
                self.rpc('artifacts-put',{**identity,'digest':digest,'path':entry['path'],'part':part,
                    'data':base64.b64encode(data[part*CHUNK_BYTES:(part+1)*CHUNK_BYTES]).decode('ascii')})
        self.rpc('artifacts-commit',{**identity,'digest':digest,'result':{**value,'files':{}}})
        return digest

    def receipt_pass(self,machine,receipt,running):
        old=json.loads(receipt.read_text())
        if old['phase']=='complete' and (old.get('artifactDigest') or old.get('artifactUnrecoverable')):return
        result=Path(old['result'])
        if old['phase']=='complete' and not result.is_file():return
        if old['phase']=='complete':
            # This trusted supervisor receipt records the prior terminal
            # acknowledgement. Recover bytes only, without launching or
            # signalling workers or changing the already released outcome.
            try:
                value=json.loads(Path(old.get('artifactResult',str(result))).read_text())
                if 'publication.json' in value.get('files',{}):return
                files=self.artifact_files(old,value)
            except Exception as error:
                if not artifacts_unrecoverable(error):raise ArtifactPassError(error) from error
                # The retained inputs are gone or invalid, for example a capture
                # folder in a recreated container's temporary space. The outcome
                # was already acknowledged, so only the artifacts are lost.
                reason='Retained artifacts unrecoverable. '+type(error).__name__+': '+str(error)[:300]
                old['artifactUnrecoverable']={'at':time.time(),'reason':reason};atomic(receipt,old)
                if self.housekeeping:self.housekeeping('native-task-unrecoverable',old['id'],reason)
                return
            try:old['artifactDigest']=self.return_artifacts(machine,old,value,files)
            except Exception as error:raise ArtifactPassError(error) from error
            atomic(receipt,old)
            return
        child=self.children.get(old.get('pid'))
        custody=old.get('custody')
        def observe_worker():
            nonlocal snapshot,custody_state
            if old.get('drainConfirmed'):
                custody_state='drained';return
            snapshot=process_snapshot()
            custody_state=observe_custody(custody,snapshot) if custody else 'uncertain'
            if custody:
                custody['phase']=custody_state
                atomic(receipt,old)
        snapshot=None;custody_state='uncertain'
        observe_worker()
        # Preserve the leader as an ownership anchor until its descendants
        # have been recorded; poll() can reap it immediately.
        root_alive=not old.get('drainConfirmed') and child is not None and poll_with_custody(child,observe_worker) is None
        root=custody.get('root') if custody else None
        observed=snapshot.get(old.get('pid')) if snapshot is not None else None
        worker_alive=root_alive or bool(child is None and root and observed and
            observed['identity']==root['identity'] and not observed['state'].startswith(('Z','X')))
        alive=root_alive or custody_state!='drained'
        if result.is_file() and not alive and self.drained(old,receipt):
            value=json.loads(Path(old.get('artifactResult',str(result))).read_text())
            publication=value.get('files',{}).pop('publication.json',None)
            if publication:
                self.rpc('prepare-repair',{'machine':machine,'id':old['id'],'session':old['session'],'publication':json.loads(publication)})
                old['phase']='publishing';atomic(receipt,old)
                published=self.rpc('publish-repair',{'machine':machine,'id':old['id'],'session':old['session'],'publication':json.loads(publication)})
                if published.get('pendingControl'):running.append(old);return
                value['summary']='Dispatcher repair '+published['url']+'. '+('Merged; supervised rollout is pending.' if published.get('merged') else published.get('reason','Review remains pending.'))
                value['files']={'publication-result.json':json.dumps(published)}
                if published.get('dispatcherSHA'):value['dispatcherRevision']=published['dispatcherSHA']
                # A later publication retry can return different consumer
                # receipts. Freeze the exact upload before its first part,
                # so a lost acknowledgement never changes its manifest.
                artifact_result=result.with_name('artifact-result.json')
                atomic(artifact_result,value)
                old['artifactResult']=str(artifact_result);atomic(receipt,old)
            old['artifactDigest']=self.return_artifacts(machine,old,value)
            old['phase']='complete';atomic(receipt,old)
        elif old['phase']=='attention':
            running.append(old)
        elif old['phase']=='launch-requested' or not worker_alive:
            # Delivery could have happened before a crash. Never create another worker.
            old['phase']='attention';old['reason']='Task worker or descendants have no confirmed drainage; inspect the retained process and reservation';atomic(receipt,old)
            self.rpc('uncertain',{'machine':machine,'id':old['id'],'session':old['session'],'reason':old['reason']})
            running.append(old)
        else:running.append(old)

    def tick(self):
        routes=self.config.get('recoveryTasks',{})
        if not routes:return []
        state=self.adapter.status();machine=state['machine']
        session_file=self.directory/'scheduler-session.json'
        if not session_file.exists():atomic(session_file,{'session':uuid.uuid4().hex})
        scheduler_session=json.loads(session_file.read_text())['session']
        capabilities=sorted(set(route['capability'] for route in routes.values() if self.route_ready(route)))
        self.rpc('capabilities',{'machine':machine,'record':{'capabilities':capabilities,'ready':not state.get('draining',False)}})
        running=[];host_uncertain=False;errors={}
        for receipt in sorted(self.directory.glob('*.receipt.json')):
            task=receipt.name[:-len('.receipt.json')]
            # One bad record must not stop the pass, later records or the operation report.
            try:self.receipt_pass(machine,receipt,running)
            except Exception as error:
                detail=str(error) if isinstance(error,ArtifactPassError) else type(error).__name__+': '+str(error)
                reason='Native task record skipped this pass. '+detail[:300]
                running.append({'id':task,'phase':'error','reason':reason})
                errors[task]=reason
                # Only a completed record's artifact transfer is known to be local
                # to that record. Anything else may be host-wide, such as an
                # unavailable process census, so no new worker starts this pass.
                if not isinstance(error,ArtifactPassError):host_uncertain=True
                # Logged once per distinct failure, not on every pass.
                if self.reported_errors.get(task)!=reason and self.housekeeping:
                    self.housekeeping('native-task-skipped',task,reason)
        if errors!=self.reported_errors:
            self.reported_errors=errors;atomic(self.skips_file,errors)
        if state.get('draining') or host_uncertain:return running
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
            saved={'id':task['id'],'session':session,'phase':'launch-requested','result':str(result),'created':time.time(),'container':route.get('container'),'directory':str(folder)}
            if route.get('container'):saved['containerDirectory']=root
            receipt=self.directory/(task['id']+'.receipt.json');atomic(receipt,saved)
            with (folder/'worker.log').open('ab') as output:
                child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=output,stderr=output,start_new_session=True,env=clean_env())
            self.children[child.pid]=child
            saved.update(phase='running',pid=child.pid,custody=new_custody(child.pid));atomic(receipt,saved)
            return running+[saved]
        return running

def main():
    os.umask(0o077)
    if len(sys.argv)!=3 or sys.argv[1] not in {'--worker','--custody'}:raise SystemExit('Worker requires a saved private task directory')
    directory=Path(sys.argv[2])
    if sys.argv[1]=='--custody':
        print(json.dumps({'phase':directory_custody(directory)}));return
    try:result=native_recipe(json.loads((directory/'task.json').read_text()),json.loads((directory/'paths.json').read_text()),directory)
    except Exception as error:result={'outcome':'failed','summary':'Native execution failed: '+type(error).__name__+'. Private logs retained.','files':{}}
    atomic(directory/'result.json',result)
if __name__=='__main__':main()
