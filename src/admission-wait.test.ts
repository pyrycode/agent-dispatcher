import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createAdmissionWaitTracker} from './admission-wait.js';
import {advanceRunClock,decideRunClock,initRunClock,runClockCreditMs,runClockDeadline} from './wait-credit.js';

test('a queued test keeps its working budget even beyond the old wall ceiling', t=>{
 const tracker=createAdmissionWaitTracker();t.after(()=>tracker.close());
 let clock=initRunClock({startedAt:1000,budgetMs:4000,ceilingFactor:2,graceMs:0});
 const report=(start:number,seen:number,end?:number)=>writeFileSync(join(tracker.directory,'wait-a.json'),JSON.stringify({startedAt:start,lastSeenAt:seen,...(end===undefined?{}:{endedAt:end})}));
 report(2000,12000);
 clock=tracker.advance(clock,12000);
 assert.equal(runClockCreditMs(clock),10000);
 assert.deepEqual(decideRunClock(clock,12000),{kind:'run',checkAt:15000,grace:false});
 report(2000,13000,13000);
 clock=tracker.advance(clock,14000);
 assert.equal(runClockDeadline(clock),16000);
 assert.equal(decideRunClock(clock,15999).kind,'run');
 assert.equal(decideRunClock(clock,16000).kind,'stop','the active work budget still ends');
});

test('parallel waits count once, stale waiters stop earning time, other runs cannot contribute',t=>{
 const tracker=createAdmissionWaitTracker();t.after(()=>tracker.close());
 const other=createAdmissionWaitTracker();t.after(()=>other.close());
 let clock=initRunClock({startedAt:1000,budgetMs:4000,ceilingFactor:2,graceMs:0});
 for(const name of ['a','b'])writeFileSync(join(tracker.directory,`wait-${name}.json`),JSON.stringify({startedAt:2000,lastSeenAt:3000}));
 writeFileSync(join(other.directory,'wait-c.json'),JSON.stringify({startedAt:1000,lastSeenAt:9000}));
 clock=tracker.advance(clock,3000);
 assert.equal(runClockCreditMs(clock),1000);
 clock=tracker.advance(clock,100000);
 const stoppedCredit=runClockCreditMs(clock);
 clock=tracker.advance(clock,200000);
 assert.equal(runClockCreditMs(clock),stoppedCredit);
 assert.equal(decideRunClock(clock,200000).kind,'stop');
});

test('malformed, future and pre-run records cannot extend a clock',t=>{
 const tracker=createAdmissionWaitTracker();t.after(()=>tracker.close());
 const fresh=initRunClock({startedAt:1000,budgetMs:4000,ceilingFactor:2,graceMs:0});
 writeFileSync(join(tracker.directory,'wait-broken.json'),'{');
 writeFileSync(join(tracker.directory,'wait-future.json'),JSON.stringify({startedAt:2000,lastSeenAt:99999}));
 writeFileSync(join(tracker.directory,'wait-old.json'),JSON.stringify({startedAt:0,lastSeenAt:500,endedAt:500}));
 const clock=tracker.advance(fresh,3000);
 assert.equal(runClockCreditMs(clock),0);
 assert.equal(runClockDeadline(clock),5000);
});

test('delayed shell output cannot credit a directly recorded admission wait twice',t=>{
 const tracker=createAdmissionWaitTracker();t.after(()=>tracker.close());
 let clock=initRunClock({startedAt:1000,budgetMs:4000,ceilingFactor:2,graceMs:0});
 clock=advanceRunClock(clock,{type:'item.started',item:{type:'command_execution',id:'go'}},2000);
 writeFileSync(join(tracker.directory,'wait-a.json'),JSON.stringify({startedAt:2000,lastSeenAt:12000,endedAt:12000}));
 clock=tracker.advance(clock,15000);
 clock=advanceRunClock(clock,{type:'item.completed',item:{type:'command_execution',id:'go',aggregated_output:'Test admission: acquired after 10s waiting'}},15000);
 assert.equal(runClockCreditMs(clock),10000);
});
