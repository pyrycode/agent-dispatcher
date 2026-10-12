#!/usr/bin/env python3
"""Native evidence for the current admitted builder. No fleet secret reaches this client."""
import argparse
import http.client
import json
import os
import socket
import time
from pathlib import Path

class Connection(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(20)
        self.sock.connect(os.environ['PYRY_TASK_SOCKET'])

def request(action,body):
    c=Connection('localhost',timeout=20)
    c.request('POST','/'+action,json.dumps(body),{'Content-Type':'application/json'})
    r=c.getresponse();data=json.loads(r.read());c.close()
    if r.status!=200:raise RuntimeError(data.get('error','Task unavailable'))
    return data

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['request','read','await'])
    p.add_argument('value');p.add_argument('--out');p.add_argument('--timeout',type=int,default=3600)
    a=p.parse_args()
    if a.action=='request':
        t=request('request',json.loads(Path(a.value).read_text()))
    else:
        end=time.monotonic()+a.timeout
        while True:
            t=request('read',{'id':a.value})
            if a.action!='await' or t['state'] in ['complete','failed']:break
            if time.monotonic()>=end:raise RuntimeError('Task remains queued or running; saved work is retained')
            time.sleep(5)
        if a.out and t.get('result'):
            root=Path(a.out).resolve();root.mkdir(parents=True,exist_ok=True)
            for name,content in t['result']['files'].items():
                target=(root/name).resolve()
                if root not in target.parents:raise RuntimeError('Invalid artifact path')
                target.parent.mkdir(parents=True,exist_ok=True)
                if target.exists() and target.read_text()!=content:raise RuntimeError('Existing artifact differs; choose a fresh destination')
                target.write_text(content);target.chmod(0o600)
    if t.get('result'):t['result']['files']=list(t['result']['files'])
    print(json.dumps(t))
if __name__=='__main__':main()
