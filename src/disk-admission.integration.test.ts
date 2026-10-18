import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {FleetStore} from './fleet-store.js';
import {JsonClient,serveFleet} from './fleet-http.js';

test('saved production manager configuration reaches actual CLI admission and preserves existing grants',async t=>{
  // Keep Darwin's Unix socket paths short without assuming its temp root on Linux.
  const directory=mkdtempSync(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'disk-admission-cli-'));
  const store=new FleetStore(':memory:',{mac:{heavyLimit:3,combinedLimit:5}});
  const authority=await serveFleet(store,{mac:'fixture-machine'},'fixture-central',0);
  const address=authority.address();assert.ok(address&&typeof address!=='string');
  const source=fileURLToPath(new URL('../',import.meta.url));
  const old={id:'existing',machine:'mac',session:'old',project:'org/core',ticket:'org/core#9',role:'builder',resource:'medium' as const,locks:[]};
  assert.equal(store.start(old).ok,true);
  const before=structuredClone(store.snapshot());
  t.after(async()=>{await new Promise<void>(resolve=>authority.close(()=>resolve()));store.close();rmSync(directory,{recursive:true});});
  for(const [index,policy] of [{path:'/missing-disk-admission-cli-fixture',minFreeBytes:200},{path:directory,minFreeBytes:1}].entries()) {
    const configPath=join(directory,'manager-'+index+'.json'),socket=join(directory,'manager-'+index+'.sock');
    writeFileSync(configPath,JSON.stringify({machine:'mac',heavyLimit:3,combinedLimit:5,ticketLimit:5,
      claimsUrl:'http://127.0.0.1:'+address.port,claimsTokenEnv:'DISK_TEST_MACHINE_TOKEN',operatorTokenEnv:'DISK_TEST_OPERATOR_TOKEN',socketPath:socket,
      diskAdmission:policy,projects:[{repo:'org/core',tokenEnv:'DISK_TEST_PROJECT_TOKEN'}]}),{mode:0o600});
    const child=spawn(process.execPath,['--import','tsx','src/fleet-bin.ts','manager',configPath],{cwd:source,
      env:{PATH:process.env.PATH,HOME:process.env.HOME,DISK_TEST_MACHINE_TOKEN:'fixture-machine',DISK_TEST_OPERATOR_TOKEN:'fixture-operator',DISK_TEST_PROJECT_TOKEN:'fixture-project'},
      stdio:['ignore','pipe','pipe']});
    let diagnostics='';child.stdout.on('data',data=>{diagnostics+=data;});child.stderr.on('data',data=>{diagnostics+=data;});
    const exited=once(child,'exit');
    const client=new JsonClient('unix://'+socket,'fixture-project');
    try {
      const deadline=Date.now()+15000;
      let ready=false;
      while(Date.now()<deadline) {
        try {const status:any=await client.call('/state');if(status.desiredState?.mode==='central'){ready=true;break;}}catch{}
        if(child.exitCode!==null)throw new Error('Fixture manager exited: '+diagnostics);
        await new Promise(resolve=>setTimeout(resolve,30));
      }
      assert.ok(ready,diagnostics);
      await client.call('/offers',{session:'new',offers:[{project:'org/core',ticket:'org/core#1',role:'builder',resource:'medium',key:'build',order:0,locks:[]}]});
      let status:any;
      while(Date.now()<deadline) {
        status=await client.call('/state');
        if(index===0&&status.queue[0]?.state==='waiting-storage'||index===1&&store.snapshot().runs.length===2)break;
        await new Promise(resolve=>setTimeout(resolve,30));
      }
      assert.deepEqual(status.diskAdmission.path,policy.path);
      if(index===0) {
        assert.equal(status.diskAdmission.state,'waiting-storage');
        assert.deepEqual(structuredClone(store.snapshot().runs),before.runs);
        assert.deepEqual(structuredClone(store.snapshot().claims),before.claims);
      } else assert.equal(store.snapshot().runs.length,2);
      assert.ok(store.snapshot().runs.some(run=>run.id==='existing'));
      assert.deepEqual(JSON.parse(readFileSync(configPath,'utf8')).diskAdmission,policy,'desired-state persistence retains the saved admission floor');
    } finally {
      if(child.exitCode===null)child.kill('SIGTERM');
      await exited;
    }
  }
});
