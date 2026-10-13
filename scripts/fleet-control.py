#!/usr/bin/env python3
"""Update the configured fleet controllers before new consumer pins start workers."""
import json
import sqlite3
import subprocess
import time
from pathlib import Path


def command(args,cwd=None):
    return subprocess.check_output(args,cwd=cwd,text=True,stderr=subprocess.DEVNULL).strip()

def sync_control(adapter,config):
    settings=config.get('control')
    if not settings:return False
    target=adapter.operator('control');revision=target.get('desired')
    if not revision:return False
    repo=Path(settings['repository'])
    state=Path(config['stateDirectory'])/'control.json'
    old=json.loads(state.read_text()) if state.is_file() else {'revision':revision,'requested':[]}
    if old['revision']!=revision:old={'revision':revision,'requested':[]}
    def save():
        temporary=state.with_suffix('.new');temporary.write_text(json.dumps(old));temporary.chmod(0o600);temporary.replace(state)
    if command(['git','branch','--show-current'],repo)!='main' or command(['git','status','--porcelain','--untracked-files=no'],repo):
        raise RuntimeError('Controller checkout has local work or is not on main')
    current=command(['git','rev-parse','HEAD'],repo)
    if current!=revision:
        command(['git','fetch','origin','main'],repo)
        # The desired source must be on upstream main. Never switch or discard a live checkout.
        subprocess.run(['git','merge-base','--is-ancestor',revision,'origin/main'],cwd=repo,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if settings.get('database'):
            source=sqlite3.connect('file:'+settings['database']+'?mode=ro',uri=True)
            backup=sqlite3.connect(str(state.parent/('claims-before-control-'+revision+'.sqlite')))
            source.backup(backup);backup.close();source.close()
        dependencies=command(['git','diff','--name-only',current,revision,'--','package.json','pnpm-lock.yaml'],repo)
        command(['git','merge','--ff-only',revision],repo)
        if dependencies:command(settings.get('install',['pnpm','install','--frozen-lockfile']),repo)
    # Also retry installation after a failed install on an already updated
    # checkout. No controller receipt or consumer advancement precedes it.
    scanner_install=repo/'scripts/install-gitleaks.py'
    if scanner_install.is_file():command(['python3',str(scanner_install)],repo)
    for component in settings.get('components',[]):
        name=component['name']
        observed=adapter.operator('control') if name=='claims' else adapter.status()
        loaded=observed.get('centralLoaded') if name=='claims' else observed.get('controlRevision')
        if loaded==revision:continue
        if name=='manager' and adapter.operator('control').get('centralLoaded')!=revision:return False
        if name in old['requested']:
            # A fresh controller receipt confirms success. A missing receipt cannot authorise another signal.
            return False
        old['requested'].append(name);save()
        subprocess.run(component['restart'],check=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return False
    observed=adapter.status()
    if observed.get('controlRevision')!=revision:return False
    record=state.parent/'control-ready.json';record.write_text(json.dumps({'machine':observed['machine'],'revision':revision}));record.chmod(0o600)
    command(adapter.operator_command('control',str(record)))
    old['complete']=time.time();save()
    return getattr(adapter,'loaded_control_revision',revision)!=revision
