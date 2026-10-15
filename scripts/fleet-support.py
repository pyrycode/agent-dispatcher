#!/usr/bin/env python3
"""Existing fleet supervisor's admitted native work. Requests cannot supply shell commands."""
import hashlib
import base64
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from contextlib import contextmanager

RECIPES={'platform-probe','memory-runtime-smoke','android-tool-then-text','dispatcher-repair','desktop-fake-suite'}
DESKTOP_PROJECT='pyrycode/pyrycode-desktop'
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


def collect_desktop_report(payload,evidence,attachments,worktree,directory):
    """Match gate-output.ts aggregate/attempt contract, retaining readable rejected records."""
    terminal=('passed','failed','timedOut','skipped','interrupted')
    errors=evidence['errors'];counts=evidence['counts']
    def reject(message):errors.append(message)
    def rows(record,key):
        value=record.get(key,[])
        if not isinstance(value,list):
            reject('Desktop report has malformed '+key);return []
        return value
    if not isinstance(payload,dict):
        reject('Desktop report is not an object');return
    evidence['configuration']=payload.get('config')
    if not isinstance(evidence['configuration'],dict):reject('Desktop report has no configuration')
    if 'suites' not in payload:reject('Desktop report has no suites')
    for error in rows(payload,'errors'):
        reject(error if isinstance(error,dict) else 'Desktop report has malformed global error')
    def visit(suite,titles=()):
        if not isinstance(suite,dict):
            reject('Desktop report has malformed suite');return
        title=suite.get('title','')
        if not isinstance(title,str):reject('Desktop suite has malformed title');title=''
        if 'specs' not in suite and 'suites' not in suite:reject('Desktop suite has no children')
        parents=(*titles,title)
        for spec in rows(suite,'specs'):
            if not isinstance(spec,dict):
                reject('Desktop report has malformed spec');continue
            title=spec.get('title')
            if not isinstance(title,str) or not title.strip():reject('Desktop spec has no title');title='(unnamed)'
            tests=rows(spec,'tests')
            if not tests:reject('Desktop spec has no tests')
            for test in tests:
                if not isinstance(test,dict):
                    reject('Desktop report has malformed test');continue
                status=test.get('status');attempts=rows(test,'results')
                # Count readable aggregate outcomes even when child evidence is
                # rejected. A skipped aggregate can legitimately have no attempts.
                if status=='skipped':counts['skipped']+=1
                elif status in ('expected','flaky','unexpected'):
                    counts['executed']+=1;counts['failed' if status=='unexpected' else 'passed']+=1
                counts['retries']+=max(0,len(attempts)-1)
                expected=test.get('expectedStatus','passed')
                last=attempts[-1].get('status') if attempts and isinstance(attempts[-1],dict) else None
                valid=(status in ('expected','flaky','unexpected','skipped') and isinstance(test.get('results'),list)
                       and all(isinstance(a,dict) and a.get('status') in terminal for a in attempts)
                       and expected in terminal)
                if status=='skipped':valid=valid and (not attempts or last=='skipped')
                else:valid=valid and last is not None and last!='skipped' and (last!=expected if status=='unexpected' else last==expected)
                if not valid:reject('Desktop test has malformed or inconsistent results')
                annotations=test.get('annotations',[])
                row={'name':' › '.join(p for p in (*parents,title) if p),'project':test.get('projectName'),
                     'status':status,'expectedStatus':test.get('expectedStatus'),
                     'skipReasons':[a.get('description','unspecified') for a in annotations
                                    if isinstance(a,dict) and a.get('type') in ('skip','fixme')] if isinstance(annotations,list) else [],
                     'attempts':[]}
                if status=='skipped' and not row['skipReasons']:row['skipReasons']=['No skip reason reported']
                evidence['tests'].append(row)
                # Validation must not stop attachment recovery in this attempt,
                # later tests/projects, or later nested suites.
                for attempt in attempts:
                    if not isinstance(attempt,dict):continue
                    item={'status':attempt.get('status'),'retry':attempt.get('retry',0),'attachments':[]}
                    row['attempts'].append(item)
                    for attachment in rows(attempt,'attachments'):
                        if not isinstance(attachment,dict):reject('Desktop attempt has malformed attachment');continue
                        name=attachment.get('name')
                        if not isinstance(name,str) or not name.startswith('fake-daemon-setup'):continue
                        try:
                            if 'body' in attachment:data=base64.b64decode(attachment['body'],validate=True).decode('utf-8')
                            else:
                                path=Path(attachment['path'])
                                if not path.is_absolute():path=worktree/path
                                path=path.resolve(strict=True)
                                if directory.resolve() not in path.parents:raise RuntimeError('Desktop setup attachment escapes private capture directory')
                                if path.stat().st_size>ARTIFACT_BYTES:raise RuntimeError('Desktop setup attachment exceeds artifact bounds')
                                data=path.read_bytes().decode('utf-8')
                            ordinal=len(attachments)
                            attachments.append({'name':name,'test':row['name'],'project':row['project'],'retry':item['retry'],'body':data})
                            item['attachments'].append({'name':name,'file':'desktop/fake-daemon-setup.json','index':ordinal})
                        except (OSError,ValueError,KeyError,TypeError,RuntimeError) as error:reject(str(error))
        for child in rows(suite,'suites'):visit(child,parents)
    for suite in rows(payload,'suites'):visit(suite)


def desktop_capture(task,paths,directory):
    """The checked Mac launcher accepts Desktop linked worktrees, never Core clones."""
    files={};attachments=[];log=directory/'execution.log';report=directory/'playwright.json';listing=directory/'playwright.list.log'
    worktree=directory/'desktop';revision=task['request']['revision']
    evidence={'revision':revision,'repository':DESKTOP_PROJECT,'config':'playwright.config.ts','configuration':None,
              'counts':{'executed':0,'passed':0,'failed':0,'skipped':0,'retries':0},'tests':[],'errors':[]}
    code=1
    try:
        if task['ticket'].split('#')[0]!=DESKTOP_PROJECT or not re.fullmatch('[a-f0-9]{40}',revision):
            raise RuntimeError('Desktop capture requires its own ticket and exact pushed revision')
        if worktree.exists() or report.exists() or listing.exists():raise RuntimeError('Desktop capture requires fresh evidence and checkout paths')
        def run(argv,cwd=directory,output=log,timeout=300):
            # Fake transport has no account login. Preserve only launch/runtime
            # settings, including the configured concurrency and CI retries.
            env={k:v for k,v in os.environ.items() if k in {'HOME','USER','LOGNAME','LANG','LC_ALL','LC_CTYPE','TMPDIR','SHELL','PATH','CI','PW_WORKERS'}}
            return execute(argv,cwd,output,env,timeout=timeout)
        # Fetch even if the commit exists locally: an unpushed candidate cannot
        # qualify. The configured Desktop remote supplies it, not the Core remote.
        # --refetch disables the local-object shortcut: ordinary fetch can
        # succeed for an unpushed object already present in this repository.
        for argv in (['git','-C',paths['desktop'],'fetch','--refetch','origin',revision],
                     ['git','-C',paths['desktop'],'worktree','add','--detach',str(worktree),revision]):
            if run(argv)!=0:raise RuntimeError('Desktop checkout setup failed; inspect execution.log')
        config=worktree/'playwright.config.ts';original=config.read_bytes().decode('utf-8')
        files['desktop/playwright.config.ts']=original
        evidence['configSha256']=hashlib.sha256(original.encode()).hexdigest()
        # The narrow launcher fixes the config filename and accepts no reporter
        # flags. Preserve its original settings by importing an exact copy beside
        # it, overriding only reporting. No selection, workers or retries change.
        saved=worktree/'playwright.fleet-original.config.ts'
        if saved.exists():raise RuntimeError('Desktop reporter config path already exists')
        saved.write_bytes(original.encode())
        config.write_text("import config from './playwright.fleet-original.config'\nexport default { ...config, reporter: [['list'], ['json', { outputFile: "+json.dumps(str(report))+" }]] }\n")
        for argv,timeout in ((['npm','ci'],600),(['npm','run','build'],600)):
            if run(argv,worktree,timeout=timeout)!=0:raise RuntimeError('Desktop install/build failed; inspect execution.log')
        # Prepare the Electron ABI only after host-Node install/build preparation.
        if run(['npm','run','rebuild:electron'],worktree,timeout=600)!=0:
            raise RuntimeError('Desktop Electron rebuild failed; inspect execution.log')
        # Use the same custody journal for every subprocess. The list reporter
        # writes into execution.log; retain its exact segment separately below.
        offset=log.stat().st_size if log.exists() else 0
        code=run([paths['desktopLauncher'],str(worktree)],worktree,timeout=3600)
        listing.write_bytes(log.read_bytes()[offset:] if log.exists() else b'')
        if not report.is_file():raise RuntimeError('Desktop capture has no JSON test evidence; inspect launcher output')
        files['desktop/playwright.json']=report.read_bytes().decode('utf-8')
        payload=json.loads(files['desktop/playwright.json'])
        collect_desktop_report(payload,evidence,attachments,worktree,directory)
        counts=evidence['counts']
        if counts['executed']==0:raise RuntimeError('Desktop capture executed zero tests')
        if counts['failed'] or evidence['errors']:code=1
    except (OSError,ValueError,KeyError,TypeError,RuntimeError) as error:
        code=1;evidence['errors'].append(str(error))
    # Even a rejected launcher or install failure returns fresh diagnostic
    # records. Missing evidence never becomes a passing native task.
    for name,path in [('execution.log',log),('playwright.list.log',listing),('playwright.json',report)]:
        if path.is_file():files['desktop/'+name]=path.read_bytes().decode('utf-8')
    files['desktop/capture.json']=json.dumps(evidence)
    # Hundreds of tests can each launch several paired daemons. A lossless
    # indexed bundle retains every attachment inside the ordinary file limit.
    files['desktop/fake-daemon-setup.json']=json.dumps(attachments)
    artifact_manifest(files)
    counts=evidence['counts']
    return {'outcome':'completed' if code==0 else 'failed','candidateRevision':revision,
            'summary':'Desktop fake suite: '+json.dumps(counts)+'. '+('Inspect the full capture before acceptance.' if code==0 else 'Capture failed; inspect returned diagnostics.'),'files':files}


def native_recipe(task,paths,directory):
    request=task['request'];recipe=request['recipe'];files={};log=directory/'execution.log'
    if recipe not in RECIPES:raise RuntimeError('Unknown fixed recipe')
    if recipe=='platform-probe':
        details={'platform':platform.system(),'architecture':platform.machine(),'candidate_tests_executed':False}
        return {'outcome':'completed','summary':'Managed native execution route is available. This probe is not candidate test evidence.','files':{'platform.json':json.dumps(details)}}
    if recipe=='desktop-fake-suite':return desktop_capture(task,paths,directory)
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

class ReleasePassError(ArtifactPassError):
    """The authority refused or lost one proven-gone worker's release. Local to that record."""

class PublicationPassError(ArtifactPassError):
    """A finished repair's publication did not go through this pass. Local to that record."""

# A transient publication failure waits this long after its first failure,
# doubling each time up to the cap. A definitive refusal never retries.
PUBLICATION_RETRY_SECONDS=60
PUBLICATION_RETRY_CAP_SECONDS=1800
# After this many failures in a row the record is raised once for attention.
# It keeps retrying, because nothing proves the failure is permanent.
PUBLICATION_ATTENTION_FAILURES=6

def route_available(route):
    capability=route['capability']
    if capability=='desktop-fake-suite':
        if sys.platform!='darwin' or route.get('container'):return False
        paths=route.get('paths',{});repo=Path(paths.get('desktop',''));launcher=Path(paths.get('desktopLauncher',''))
        if not repo.is_absolute() or not launcher.is_absolute() or not launcher.is_file() or not os.access(launcher,os.X_OK):return False
        if not all((repo/name).exists() for name in ('.git','playwright.config.ts','package-lock.json')):return False
        if not all(shutil.which(tool) for tool in ('git','node','npm')):return False
        # A wrong source remote must not advertise a Desktop execution route.
        try:
            remote=subprocess.run(['git','-C',str(repo),'config','--get','remote.origin.url'],capture_output=True,text=True,timeout=15,env=clean_env())
            return remote.returncode==0 and remote.stdout.strip() in {'https://github.com/'+DESKTOP_PROJECT+'.git','https://github.com/'+DESKTOP_PROJECT,'git@github.com:'+DESKTOP_PROJECT+'.git'}
        except (OSError,subprocess.TimeoutExpired):return False
    required=['go'] if capability in {'linux-amd64','macos-arm64'} else ['go','java','adb'] if capability=='android-emulator' else ['node','pnpm','codex']
    probe="import shutil,sys; sys.exit(0 if all(shutil.which(x) for x in "+repr(required)+") else 1)"
    args=['podman','exec',route['container'],'python3','-c',probe] if route.get('container') else [sys.executable,'-c',probe]
    try:return subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15).returncode==0
    except (OSError,subprocess.TimeoutExpired):return False

# File timestamps can trail the real write by one clock tick. A worker write
# counts as older than a container start only with this margin.
INSTANCE_MARGIN_NS=2_000_000_000

def container_instance(container):
    """The container's current instance. {'running': False} only when it is absent,
    or stopped with no process. Its start time and id when running. None for any
    other state, such as stopping, or when podman cannot say."""
    try:
        exists=subprocess.run(['podman','container','exists',container],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15).returncode
        if exists==1:return {'running':False}
        if exists!=0:return None
        fields=subprocess.check_output(['podman','inspect',container,'--format','{{.State.Status}} {{.State.Pid}} {{.State.StartedAt.UnixNano}} {{.Id}}'],
                                       stdin=subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True,timeout=15).split()
    except (OSError,subprocess.SubprocessError):return None
    if len(fields)!=4 or not fields[1].isdigit() or not fields[2].isdigit():return None
    status,pid=fields[0],int(fields[1])
    # A stopping container can still hold processes, so it proves nothing.
    if status in {'exited','stopped','created','configured'} and pid==0:return {'running':False}
    if status=='running' and pid>0:return {'running':True,'startedAt':int(fields[2]),'id':fields[3]}
    return None

def worker_gone_with_container(old):
    """Proof that a container task's worker no longer exists, or None.

    Every process started in a container ends when that container instance
    stops. The worker is gone when its container is not running, or when the
    worker wrote its own files before the running instance started, which
    places it in an earlier instance. Files the host also writes never count."""
    container=old.get('container')
    if not container or not old.get('directory'):return None
    instance=container_instance(container)
    if instance is None:return None
    if not instance['running']:
        return 'Its container '+container+' is not running, and no process started in it survives a stop.'
    directory=Path(old['directory'])
    written=[]
    for name in ('started.json','execution.log'):
        try:written.append((directory/name).stat().st_mtime_ns)
        except FileNotFoundError:continue
        except OSError:return None
    if written and min(written)<instance['startedAt']-INSTANCE_MARGIN_NS:
        return 'Its container '+container+' restarted after the worker last wrote, so the worker ran in an instance that has stopped.'
    return None

OPEN_PHASES={'drain-requested','draining','start-requested','verifying','waiting-for-native-task'}

def operation_open(record):
    """Whether a supervisor record means the container may be draining or updating.

    A health latch, or attention after a start was issued, leaves the dispatcher
    running with nothing draining. Any other attention record may hold an
    undelivered or stuck drain, so it stays open."""
    phase=record.get('phase')
    if phase in OPEN_PHASES:return True
    if phase!='attention':return False
    if record.get('latch')=='health' or str(record.get('reason','')).startswith('Health failed again after a verified restart'):return False
    return record.get('attentionFrom') not in {'start-requested','verifying'}

class ServiceRefusal(RuntimeError):
    """The control service answered and refused the operation. Not a lost reply."""
    def __init__(self,operation,status,detail):
        super().__init__('Control service refused '+operation+': Service '+str(status)+': '+detail)
        self.operation=operation;self.status=status;self.detail=detail
        try:body=json.loads(detail)
        except ValueError:body=None
        # The service's own message, and whether it refused the submitted bytes
        # themselves (422 with refused), which no retry can change.
        self.message=(body.get('error') if isinstance(body,dict) and isinstance(body.get('error'),str) else detail)[:300] or 'no detail'
        self.refused=status==422 and isinstance(body,dict) and body.get('refused') is True

SERVICE_REPLY=re.compile(r'^Service (\d{3}): (.*)$')

def rpc_failure(operation,code,stderr):
    """A typed error from the operator command's output.

    The command prints only the error message, but an uncaught crash adds a
    stack and a runtime version line, so the service's reply is searched for.
    Timeouts, connection failures and local crashes are never refusals."""
    lines=[line.strip() for line in (stderr or '').splitlines() if line.strip()]
    for line in reversed(lines):
        match=SERVICE_REPLY.match(line)
        if match:return ServiceRefusal(operation,int(match.group(1)),match.group(2)[:300])
    detail=next((line for line in reversed(lines) if not line.startswith('Node.js v') and not line.startswith('at ')),'exit '+str(code))
    return RuntimeError('Control service call '+operation+' failed without a service reply: '+detail[:300])

def service_refusal(error):
    """The service refusal behind a record's failure, or None."""
    while error is not None:
        if isinstance(error,ServiceRefusal):return error
        error=error.__cause__
    return None

class SupportSupervisor:
    def __init__(self,adapter,config):
        desktop=config.get('projects',{}).get(DESKTOP_PROJECT,{})
        if config.get('platform')=='mac' and desktop.get('target'):
            config.setdefault('recoveryTasks',{})['desktop-fake-suite:desktop-fake-suite']={
                'capability':'desktop-fake-suite','directory':str(Path(config['stateDirectory'])/'desktop-captures'),
                'paths':{'desktop':desktop['target'],'desktopLauncher':desktop.get('fakeTestLauncher',str(Path.home()/'.codex/bin/pyrycode-desktop-test'))}}
        self.adapter=adapter;self.config=config;self.children={};self.directory=Path(config['stateDirectory'])/'tasks'
        # Optional callable(kind, subject, reason) for automatic state changes.
        self.housekeeping=None
        # Persisted so a supervisor re-exec does not log the same skip again.
        self.skips_file=Path(config['stateDirectory'])/'native-task-skips.json'
        try:self.reported_errors=json.loads(self.skips_file.read_text())
        except (OSError,ValueError):self.reported_errors={}
        if not isinstance(self.reported_errors,dict):self.reported_errors={}
        self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.refusals={}

    def rpc(self,operation,body):
        path=self.directory/(operation+'.request.json');atomic(path,body)
        done=subprocess.run(self.adapter.operator_command('recovery-task',operation,str(path)),stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=150)
        # Diagnostics still reach the journal as before.
        if done.stderr:sys.stderr.write(done.stderr);sys.stderr.flush()
        if done.returncode:raise rpc_failure(operation,done.returncode,done.stderr)
        return json.loads(done.stdout)

    def capability_record(self,state,withheld=()):
        routes=self.config.get('recoveryTasks',{})
        capabilities=sorted(set(route['capability'] for route in routes.values()
                                if not (route.get('container') and route['container'] in withheld) and self.route_ready(route)))
        return {'capabilities':capabilities,'ready':not state.get('draining',False)}

    def withhold(self,project):
        """Report capabilities without this project's container before its drain signal.

        The authority admits a task only against a fresh capability record, so
        once this report is accepted no new task can be admitted into the
        container. Its later records come from the open operation receipt."""
        container=self.config.get('projects',{}).get(project,{}).get('container')
        if not container or not any(r.get('container')==container for r in self.config.get('recoveryTasks',{}).values()):return
        state=self.adapter.status()
        self.rpc('capabilities',{'machine':state['machine'],'record':self.capability_record(state,{container})})

    def route_ready(self,route):
        if route.get('container'):
            for project,cfg in self.config.get('projects',{}).items():
                if cfg.get('container')!=route['container']:continue
                receipt=Path(self.config['stateDirectory'])/(project.replace('/','_')+'.json')
                if receipt.exists() and operation_open(json.loads(receipt.read_text())):return False
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
        if old['phase']=='complete' and (old.get('artifactDigest') or old.get('artifactUnrecoverable') or old.get('interrupted')
                                         or old.get('publicationRefused') or (old.get('finalized') or {}).get('released')):return
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
        snapshot=None;custody_state='uncertain';proof=None
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
                if old.get('publicationRefused'):return self.refuse_publication(machine,receipt,old)
                retry=old.get('publicationRetry')
                if retry and retry.get('next',0)>time.time():
                    running.append({'id':old['id'],'phase':'attention' if retry.get('attention') else 'publication-retry',
                                    'reason':retry.get('reason'),'next':retry['next'],'failures':retry.get('failures')});return
                try:
                    self.rpc('prepare-repair',{'machine':machine,'id':old['id'],'session':old['session'],'publication':json.loads(publication)})
                    old['phase']='publishing';atomic(receipt,old)
                    published=self.rpc('publish-repair',{'machine':machine,'id':old['id'],'session':old['session'],'publication':json.loads(publication)})
                except ServiceRefusal as error:
                    # The authority refused these exact bytes. A retry is refused
                    # again, so the task ends here and its reservation is released.
                    if error.operation=='prepare-repair' and error.refused:
                        old['publicationRefused']={'at':time.time(),'reason':error.message}
                        return self.refuse_publication(machine,receipt,old)
                    # Any other 4xx is asked again every pass, so the watchdog can
                    # count the same definite refusal on consecutive passes.
                    if 400<=error.status<500:raise PublicationPassError(error) from error
                    self.publication_retry(receipt,old,error)
                except (RuntimeError,OSError,subprocess.SubprocessError,ValueError) as error:
                    # 5xx, no reply, a timeout or a local failure may clear.
                    self.publication_retry(receipt,old,error)
                old.pop('publicationRetry',None)
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
        elif old['phase'] in {'running','attention'} and not alive and not result.is_file() and (old.get('interrupted') or (proof:=worker_gone_with_container(old))):
            self.interrupt(machine,receipt,old,proof)
        elif old['phase']=='attention':
            running.append(old)
        elif old['phase']=='launch-requested' or not worker_alive:
            # Delivery could have happened before a crash. Never create another worker.
            old['phase']='attention';old['reason']='Task worker or descendants have no confirmed drainage; inspect the retained process and reservation';atomic(receipt,old)
            self.rpc('uncertain',{'machine':machine,'id':old['id'],'session':old['session'],'reason':old['reason']})
            running.append(old)
        else:running.append(old)

    def publication_retry(self,receipt,old,error):
        """Wait before the next attempt at a temporary publication failure.

        Service errors, timeouts and network failures can clear. The record keeps
        its reservation and stays in the report with the next attempt time."""
        failures=old.get('publicationRetry',{}).get('failures',0)+1
        delay=min(PUBLICATION_RETRY_SECONDS*2**(failures-1),PUBLICATION_RETRY_CAP_SECONDS)
        detail=str(error) if isinstance(error,ServiceRefusal) else type(error).__name__+': '+str(error)
        raised=old.get('publicationRetry',{}).get('attention',False)
        old['publicationRetry']={'failures':failures,'next':time.time()+delay,'reason':detail[:300],'attention':raised or failures>=PUBLICATION_ATTENTION_FAILURES}
        atomic(receipt,old)
        if failures>=PUBLICATION_ATTENTION_FAILURES and not raised and self.housekeeping:
            self.housekeeping('native-task-publication-stuck',old['id'],
                              'Repair publication failed '+str(failures)+' times in a row'+
                              (', after preparation released its reservation. ' if old.get('phase')=='publishing' else ' and still holds its reservation. ')+'Last: '+detail[:300])
        raise PublicationPassError(error) from error

    def refuse_publication(self,machine,receipt,old):
        """End a finished repair the authority will not publish, as failed work.

        The reviewed patch stays on this host only. Releasing the task frees its
        reservation, so a refused publication never holds a place indefinitely."""
        refused=old['publicationRefused']
        if 'result' not in refused:
            retained=str(Path(old.get('directory') or Path(old['result']).parent))
            summary=('Repair publication refused: '+refused['reason']+' The repair finished, but it was not published. '
                     'Its reviewed patch is retained privately on this host in '+retained+' (publication.json). '
                     'Fix the cause of the refusal, then republish it or request the repair again.')
            # Saved before the release, so a retry sends the identical result.
            refused['retained']=retained
            refused['result']={'outcome':'failed','summary':summary,'files':{}}
            atomic(receipt,old)
        try:self.rpc('complete',{'machine':machine,'id':old['id'],'session':old['session'],'result':refused['result']})
        except Exception as error:
            # Retried each pass with the saved result. The refusal itself never retries.
            raise PublicationPassError(error) from error
        old['phase']='complete';old.pop('publicationRetry',None);atomic(receipt,old)
        if self.housekeeping:
            self.housekeeping('native-task-publication-refused',old['id'],
                              'Repair publication refused: '+refused['reason']+' Task ended as failed and its reservation released. Reviewed patch retained privately in '+refused['retained']+'.')

    def interrupt(self,machine,receipt,old,proof=None):
        """Release the reservation of a worker proven gone, as failed interrupted work."""
        if not old.get('interrupted'):
            summary=('Native task worker was interrupted before it wrote a result. '+proof
                     +' The reservation was released as interrupted work, not completed and not unused. Request the task again if it is still needed.')
            # Saved before the release, so a retry sends the identical result.
            old['interrupted']={'at':time.time(),'reason':proof,'result':{'outcome':'failed','summary':summary,'files':{}}}
            atomic(receipt,old)
        try:self.rpc('complete',{'machine':machine,'id':old['id'],'session':old['session'],'result':old['interrupted']['result']})
        except Exception as error:
            # A refusal or a lost reply concerns this record only. The saved
            # result is retried each pass, and the record stays in attention.
            if old['phase']!='attention':
                old['phase']='attention';old['reason']='Release of a worker proven gone was not accepted; inspect the task and reservation'
                atomic(receipt,old)
            raise ReleasePassError(error) from error
        old['phase']='complete';atomic(receipt,old)
        if self.housekeeping:self.housekeeping('native-task-interrupted',old['id'],old['interrupted']['reason']+' Reservation released as interrupted work.')

    def local_task_ids(self):
        """Ids of the native tasks this computer still holds a launch receipt or a
        deferred marker for. None when the folder cannot be read, which the control
        service treats as unknown rather than as no tasks."""
        try:
            names=[p.name for p in self.directory.iterdir()]
        except FileNotFoundError:
            names=[]
        except OSError:
            return None
        ids=set()
        for name in names:
            for suffix in ('.receipt.json','.deferred.json'):
                if name.endswith(suffix) and re.fullmatch(r'[a-f0-9]{64}',name[:-len(suffix)]):ids.add(name[:-len(suffix)])
        return sorted(ids)

    def tick(self):
        routes=self.config.get('recoveryTasks',{})
        if not routes:return []
        state=self.adapter.status();machine=state['machine']
        session_file=self.directory/'scheduler-session.json'
        if not session_file.exists():atomic(session_file,{'session':uuid.uuid4().hex})
        scheduler_session=json.loads(session_file.read_text())['session']
        self.rpc('capabilities',{'machine':machine,'record':self.capability_record(state)})
        running=[];host_uncertain=False;errors={}
        # This pass's definite service refusals per record, for the watchdog.
        self.refusals={}
        for receipt in sorted(self.directory.glob('*.receipt.json')):
            task=receipt.name[:-len('.receipt.json')]
            # One bad record must not stop the pass, later records or the operation report.
            try:
                self.receipt_pass(machine,receipt,running)
                # Waiting out a publication retry keeps the failure it waits on,
                # so the same failure is not logged again after each wait.
                if running and running[-1].get('id')==task and 'next' in running[-1] and task in self.reported_errors:
                    errors[task]=self.reported_errors[task]
            except Exception as error:
                detail=str(error) if isinstance(error,ArtifactPassError) else type(error).__name__+': '+str(error)
                reason='Native task record skipped this pass. '+detail[:300]
                running.append({'id':task,'phase':'error','reason':reason})
                errors[task]=reason
                refusal=service_refusal(error)
                if refusal:self.refusals[task]={'operation':refusal.operation,'status':refusal.status,'detail':refusal.detail}
                # Only a completed record's artifact transfer, or the release of a
                # worker already proven gone, is known to be local to that record.
                # Anything else may be host-wide, such as an
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
            deferred=self.directory/(task['id']+'.deferred.json')
            if not self.route_ready(route):
                # Admitted just before its container's operation opened. Never
                # start it into a container that is draining or updating. The
                # reservation stays held and the task starts once the update
                # completes. The drain does not wait for a task never started.
                marker={'id':task['id'],'session':session,'runId':grant['run'].get('id'),'container':route.get('container')}
                try:saved=json.loads(deferred.read_text()) if deferred.is_file() else None
                except ValueError:saved=None
                if saved!=marker:
                    atomic(deferred,marker)
                    if self.housekeeping:self.housekeeping('native-task-deferred',task['id'],'Admitted while its container was draining or updating. It starts after the update completes.')
                running.append({'id':task['id'],'phase':'deferred','reason':'Waiting for its container operation to complete before starting.'})
                continue
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
            # The launch receipt exists first, so a drain sees this task as active.
            deferred.unlink(missing_ok=True)
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
    # Written only by the worker, inside its container. Its time places the
    # worker in one container instance for the supervisor's interruption proof.
    atomic(directory/'started.json',{'pid':os.getpid()})
    try:result=native_recipe(json.loads((directory/'task.json').read_text()),json.loads((directory/'paths.json').read_text()),directory)
    except Exception as error:result={'outcome':'failed','summary':'Native execution failed: '+type(error).__name__+'. Private logs retained.','files':{}}
    atomic(directory/'result.json',result)
if __name__=='__main__':main()
