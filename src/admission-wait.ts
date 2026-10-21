import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergeIntervals,runClockCreditMs,runClockDeadline,type Interval,type RunClock} from './wait-credit.js';

// Waiters refresh once a second. A killed waiter must stop earning time even
// when it cannot publish its final report. Only this spawn's private files count.
const HEARTBEAT_LIFETIME_MS=3000;

export function createAdmissionWaitTracker() {
 const directory=mkdtempSync(join(tmpdir(),'pyry-test-wait-'));
 let closed=false;
 let waiting=false;
 return {directory,get waiting(){return waiting;},advance(clock:RunClock,now:number):RunClock {
  if(closed)return clock;
  waiting=false;
  const spans:Interval[]=[];
  for(const name of readdirSync(directory)) {
   if(!/^wait-[\w-]+\.json$/.test(name))continue;
   try {
    const {startedAt,lastSeenAt,endedAt}=JSON.parse(readFileSync(join(directory,name),'utf8'));
    if(!Number.isFinite(startedAt)||!Number.isFinite(lastSeenAt)||startedAt>lastSeenAt||lastSeenAt>now)continue;
    if(endedAt!==undefined&&(!Number.isFinite(endedAt)||endedAt!==lastSeenAt))continue;
    const end=endedAt??(now-lastSeenAt<=HEARTBEAT_LIFETIME_MS?now:lastSeenAt);
    if(endedAt===undefined && now-lastSeenAt<=HEARTBEAT_LIFETIME_MS)waiting=true;
    spans.push([Math.max(clock.startedAt,startedAt),end]);
   }catch {/* An incomplete or invalid report earns no time. */}
  }
  const admissionCredited=mergeIntervals([...(clock.admissionCredited??[]),...spans]);
  const next={...clock,admissionCredited,credited:mergeIntervals([...clock.credited,...admissionCredited])};
  const status={budgetMs:clock.budgetMs,waitCreditMs:runClockCreditMs(next),remainingMs:Math.max(0,runClockDeadline(next)-now),updatedAt:now};
  const pending=join(directory,'budget.tmp');
  writeFileSync(pending,JSON.stringify(status),{mode:0o600});renameSync(pending,join(directory,'budget.json'));
  return next;
 },close:()=>{if(!closed){closed=true;rmSync(directory,{recursive:true,force:true});}}};
}
