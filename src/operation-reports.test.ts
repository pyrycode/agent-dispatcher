import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {OperationReports} from './operation-reports.js';

test('malformed storage observations preserve control and worker custody reports',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const reports=new OperationReports(db,['mac'],()=>123);
    const operations=[{project:'org/product',phase:'draining'}];
    const localTasks=['a'.repeat(64)];
    for(const storageMaintenance of [undefined,null,'bad',{},[null,1,'bad']]) {
      reports.record('mac',{operations,localTasks,storageMaintenance});
      assert.deepEqual(reports.list(true),[{machine:'mac',received:123,operations,localTasks}]);
    }
  }finally{db.close();}
});

test('storage receipts are bounded, redact credentials and retain accurate byte counts',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const reports=new OperationReports(db,['mac']);
    const secret='ghp_'+'a'.repeat(36);
    reports.record('mac',{operations:[],storageMaintenance:Array.from({length:22},(_,i)=>({
      phase:'held',reason:secret,subject:'closed work',ticket:'org/product#7',
      reclaimedBytes:i,plannedBytes:i===21?-1:1024,privateField:'not published',
    }))});
    const report=reports.list()[0];
    assert.equal(report.storageMaintenance.length,20);
    assert.equal(report.storageMaintenance[0].reclaimedBytes,2);
    assert.equal(report.storageMaintenance.at(-1).reclaimedBytes,21);
    assert.equal(report.storageMaintenance.at(-1).plannedBytes,undefined);
    assert.equal(report.storageMaintenance[0].plannedBytes,1024);
    assert.equal(JSON.stringify(report).includes(secret),false);
    assert.equal(JSON.stringify(report).includes('privateField'),false);
  }finally{db.close();}
});
