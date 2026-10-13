#!/usr/bin/env python3
"""Native evidence for the current admitted builder. No fleet secret reaches this client."""
import argparse
import base64
import hashlib
import http.client
import json
import os
import re
import socket
import tempfile
import time
from pathlib import Path

CHUNK_BYTES=256*1024
MAX_BYTES=64*1024*1024
MAX_FILES=1024
HASH=re.compile(r'[a-f0-9]{64}')

def sha(data):return hashlib.sha256(data).hexdigest()

def inventory(value):
    if not isinstance(value,dict) or value.get('version')!=1 or value.get('chunkBytes')!=CHUNK_BYTES or set(value)!={'version','chunkBytes','totalBytes','files'}:
        raise RuntimeError('Invalid artifact manifest')
    files=value['files']
    if not isinstance(files,list) or len(files)>MAX_FILES or len(json.dumps(value,separators=(',',':')))>1024*1024:raise RuntimeError('Invalid artifact inventory')
    entries=[];paths=set();total=0
    for entry in files:
        name=entry.get('path') if isinstance(entry,dict) else None
        if not isinstance(name,str) or len(name)>240 or not re.fullmatch(r'[\w./-]+',name,flags=re.ASCII) or name.startswith('/') or any(p in {'','.','..'} for p in name.split('/')) or name.split('/')[0].startswith('.fleet-task-') or name in paths:
            raise RuntimeError('Invalid artifact path')
        size=entry.get('bytes');chunks=entry.get('chunks')
        if type(size) is not int or not 0<=size<=MAX_BYTES or not isinstance(entry.get('sha256'),str) or not HASH.fullmatch(entry['sha256']) or not isinstance(chunks,list) or len(chunks)!=(size+CHUNK_BYTES-1)//CHUNK_BYTES or any(not isinstance(h,str) or not HASH.fullmatch(h) for h in chunks) or set(entry)!={'path','bytes','sha256','chunks'}:
            raise RuntimeError('Invalid artifact byte/hash inventory')
        paths.add(name);total+=size
        entries.append({'path':name,'bytes':size,'sha256':entry['sha256'],'chunks':chunks})
    if total>MAX_BYTES or type(value['totalBytes']) is not int or value['totalBytes']!=total:raise RuntimeError('Artifact total bounds or byte count mismatch')
    for name in paths:
        parts=name.split('/')[:-1]
        while parts:
            if '/'.join(parts) in paths:raise RuntimeError('Conflicting artifact paths')
            parts.pop()
    manifest={'version':1,'chunkBytes':CHUNK_BYTES,'totalBytes':total,'files':sorted(entries,key=lambda e:e['path'])}
    return manifest,sha(json.dumps(manifest,separators=(',',':')).encode())

def contained(root,name):
    target=(root/name).resolve()
    if root not in target.parents:raise RuntimeError('Invalid artifact path')
    return target

def private_write(target,data,replace=True):
    target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    # A unique, exclusive temporary file cannot overwrite adjacent user work.
    with tempfile.NamedTemporaryFile(dir=target.parent,prefix='.fleet-task-',delete=False) as output:
        temporary=Path(output.name);os.fchmod(output.fileno(),0o600);output.write(data)
    try:
        if replace:temporary.replace(target)
        else:
            try:os.link(temporary,target)
            except FileExistsError:
                if target.read_bytes()!=data:raise RuntimeError('Existing artifact differs; choose a fresh destination')
                target.chmod(0o600)
    finally:temporary.unlink(missing_ok=True)

def retrieve(task,destination):
    manifest,digest=inventory(task['artifacts'])
    if not re.fullmatch(r'[a-f0-9]{64}',task['id']):raise RuntimeError('Invalid artifact task identity')
    root=Path(destination).resolve();root.mkdir(parents=True,exist_ok=True,mode=0o700)
    for ordinal,entry in enumerate(manifest['files']):
        target=contained(root,entry['path'])
        if target.exists():
            data=target.read_bytes()
            if len(data)!=entry['bytes'] or sha(data)!=entry['sha256']:raise RuntimeError('Existing artifact differs; choose a fresh destination')
            target.chmod(0o600)
            continue
        parts=[]
        for part,expected in enumerate(entry['chunks']):
            size=min(CHUNK_BYTES,entry['bytes']-part*CHUNK_BYTES)
            cached=contained(root,f'.fleet-task-cache/{task["id"]}/{digest}/{ordinal}/{part}')
            data=cached.read_bytes() if cached.is_file() else None
            if data is None or len(data)!=size or sha(data)!=expected:
                reply=request('artifact',{'id':task['id'],'digest':digest,'path':entry['path'],'part':part})
                if reply.get('digest')!=digest or reply.get('path')!=entry['path'] or reply.get('part')!=part or reply.get('sha256')!=expected or reply.get('bytes')!=size:
                    raise RuntimeError('Artifact chunk identity or hash mismatch')
                data=base64.b64decode(reply['data'],validate=True)
                if len(data)!=size or sha(data)!=expected:raise RuntimeError('Artifact chunk byte/hash mismatch')
                private_write(cached,data)
            parts.append(data)
        data=b''.join(parts)
        if len(data)!=entry['bytes'] or sha(data)!=entry['sha256']:raise RuntimeError('Artifact byte/hash mismatch')
        data.decode('utf-8') # The contract carries exact UTF-8 text, including CRLF.
        private_write(target,data,replace=False)
    # Retain complete inventory and authority provenance alongside the evidence.
    private_write(contained(root,'.fleet-task-manifest.json'),json.dumps({'task':task,'digest':digest},separators=(',',':')).encode(),replace=False)

class Connection(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(20)
        self.sock.connect(os.environ['PYRY_TASK_SOCKET'])

def request(action,body):
    c=Connection('localhost',timeout=20)
    c.request('POST','/'+action,json.dumps(body),{'Content-Type':'application/json'})
    r=c.getresponse();encoded=r.read(2*1024*1024+1);c.close()
    if len(encoded)>2*1024*1024:raise RuntimeError('Task response exceeds transport bounds')
    data=json.loads(encoded)
    if r.status!=200:raise RuntimeError(data.get('error','Task unavailable'))
    return data

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['request','read','await'])
    p.add_argument('value');p.add_argument('--out');p.add_argument('--timeout',type=int,default=3600)
    a=p.parse_args()
    if a.action=='request':
        t=request('request',{'request':json.loads(Path(a.value).read_text())})
    else:
        end=time.monotonic()+a.timeout
        while True:
            t=request('read',{'id':a.value,'format':'manifest-v1'})
            if a.action!='await' or t['state'] in ['complete','failed'] and not t.get('artifactsPending'):break
            if time.monotonic()>=end:raise RuntimeError('Task remains queued or running; saved work is retained')
            time.sleep(5)
        if t['id']!=a.value:raise RuntimeError('Task read identity mismatch')
        if a.out and t.get('artifactsPending'):raise RuntimeError('Task artifacts are still transferring; retry the same read')
        if a.out and t.get('artifacts'):retrieve(t,a.out)
    if t.get('result'):t['result']['files']=[e['path'] for e in t.get('artifacts',{}).get('files',[])]
    print(json.dumps(t))
if __name__=='__main__':main()
