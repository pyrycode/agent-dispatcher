import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FleetStore} from './fleet-store.js';
import {serveFleet,JsonClient} from './fleet-http.js';
import {LOCAL_TASK_LIMIT} from './operation-reports.js';

const limits={box:{heavyLimit:1,combinedLimit:2},mac:{heavyLimit:1,combinedLimit:2}};
const revision='9950e6fbd28aac7ec3f6772e2deeebbcf83b52a2';
const MIN=60_000;

/** A store whose clock the test moves, with a running repair task on mac. */
function setup(options:{orphanedTaskMs?:number}={}) {
 let clock=1_000_000_000;
 const store=new FleetStore(':memory:',limits,{now:()=>clock,...options});
 store.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
 const task=store.tasks.request('org/core#3247',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision,reason:'failed check'});
 store.taskStart('mac',task.id,'native');
 const advance=(ms:number)=>{clock+=ms;};
 /** Both computers report; mac lists the given receipts. Pass undefined for an old supervisor. */
 const report=(mac:string[]|undefined,box:string[]|undefined=[])=>{
  store.operations.record('mac',{operations:[],...(mac?{localTasks:mac}:{})});
  store.operations.record('box',{operations:[],...(box?{localTasks:box}:{})});
  // The service observes after every report it accepts.
  store.orphans.observe();
 };
 /** The operator cancels the reservation, leaving the central record behind. */
 const cancelReservation=()=>store.finish('mac','native',`task-${task.id}`,false);
 return {store,task,advance,report,cancelReservation,now:()=>clock};
}

test('a reserved task is never reported, whatever the receipts say',()=>{
 const {store,advance,report}=setup();
 report([]);advance(3*60*MIN);report([]);
 assert.deepEqual(store.orphans.list(),[]);
});

test('a cancelled reservation with no receipt is reported after the limit, not before',()=>{
 const {store,task,advance,report,cancelReservation,now}=setup();
 cancelReservation();report([]);
 assert.equal(store.tasks.get(task.id).state,'running');
 assert.deepEqual(store.orphans.list(),[]);
 advance(59*MIN);report([]);
 assert.deepEqual(store.orphans.list(),[]);
 const first=now()-59*MIN;
 advance(2*MIN);report([]);
 const [item]=store.orphans.list();
 assert.equal(item.kind,'orphaned-task');
 assert.equal(item.task,task.id);
 assert.equal(item.ticket,'org/core#3247');
 assert.equal(item.machine,'mac');
 assert.equal(item.state,'running');
 assert.equal(item.since,first/1000);
 assert.match(item.reason,/Nothing was closed or released/);
 // Reporting changes nothing about the task.
 assert.equal(store.tasks.get(task.id).state,'running');
});

test('a task in attention is reported too, and closing it clears the item',()=>{
 const {store,task,advance,report,cancelReservation}=setup();
 store.tasks.uncertain(task.id,'mac','native','worker state unclear');
 cancelReservation();report([]);advance(61*MIN);report([]);
 assert.equal(store.orphans.list()[0].state,'attention');
 store.tasks.complete(task.id,'mac','native',{outcome:'failed',summary:'closed by hand',files:{}});
 assert.deepEqual(store.orphans.list(),[]);
});

test('a receipt on any computer holds the task, and losing it starts the clock over',()=>{
 const {store,task,advance,report,cancelReservation}=setup();
 cancelReservation();
 report([task.id]);advance(2*60*MIN);report([task.id]);
 assert.deepEqual(store.orphans.list(),[]);
 report([]);advance(30*MIN);report([]);
 assert.deepEqual(store.orphans.list(),[]);
 advance(31*MIN);report([]);
 assert.equal(store.orphans.list().length,1);
 // A receipt reappearing, even listed by the other computer, clears it.
 report([],[task.id]);
 assert.deepEqual(store.orphans.list(),[]);
});

test('a computer that is briefly offline is not evidence, and its return restarts the clock',()=>{
 const {store,advance,report,cancelReservation}=setup();
 cancelReservation();report([]);advance(50*MIN);report([]);
 assert.deepEqual(store.orphans.list(),[]);
 // mac stops reporting for 40 minutes while box keeps going.
 for(let i=0;i<8;i++){advance(5*MIN);store.operations.record('box',{operations:[],localTasks:[]});store.orphans.observe();}
 advance(30*MIN);store.operations.record('box',{operations:[],localTasks:[]});
 assert.deepEqual(store.orphans.list(),[]);
 // It comes back still without the receipt. One hour must pass again from here.
 report([]);advance(59*MIN);report([]);
 assert.deepEqual(store.orphans.list(),[]);
 advance(2*MIN);report([]);
 assert.equal(store.orphans.list().length,1);
});

test('a supervisor that does not list receipts, or has never reported, cannot make a task an orphan',()=>{
 const {store,advance,report,cancelReservation}=setup();
 cancelReservation();
 advance(5*60*MIN);
 assert.deepEqual(store.orphans.list(),[]);
 report(undefined);advance(5*60*MIN);report(undefined);
 assert.deepEqual(store.orphans.list(),[]);
});

test('a receipt list too long to keep is treated as unknown rather than truncated',()=>{
 const {store,advance,cancelReservation}=setup();
 cancelReservation();
 const many=Array.from({length:LOCAL_TASK_LIMIT+1},(_,i)=>i.toString(16).padStart(64,'0'));
 store.operations.record('mac',{operations:[],localTasks:many});
 assert.equal(store.operations.list(true).find(r=>r.machine==='mac')!.localTasks,undefined);
 advance(5*60*MIN);store.operations.record('mac',{operations:[],localTasks:many});
 assert.deepEqual(store.orphans.list(),[]);
});

test('the operator report leaves the receipt lists out',()=>{
 const {store}=setup();
 store.operations.record('mac',{operations:[],localTasks:['a'.repeat(64)]});
 assert.equal('localTasks' in store.operations.list().find(r=>r.machine==='mac')!,false);
});

test('a clock that steps backward cannot make an old report look fresh',()=>{
 const {store,advance,report,cancelReservation}=setup();
 cancelReservation();report([]);advance(-3*60*MIN);
 store.orphans.observe();advance(3*60*MIN+61*MIN);
 assert.deepEqual(store.orphans.list(),[]);
});

test('malformed receipt ids are dropped from the report',()=>{
 const {store}=setup();
 store.operations.record('mac',{operations:[],localTasks:['x',5,null,'a'.repeat(64),'a'.repeat(64)]});
 assert.deepEqual(store.operations.list(true).find(r=>r.machine==='mac')!.localTasks,['a'.repeat(64)]);
});

test('the limit is configurable and queued or finished tasks are never reported',()=>{
 const {store,task,advance,report,cancelReservation}=setup({orphanedTaskMs:10*MIN});
 store.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
 const queued=store.tasks.request('org/core#9',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision,reason:'other'});
 cancelReservation();report([]);advance(11*MIN);report([]);
 const items=store.orphans.list();
 assert.deepEqual(items.map(i=>i.task),[task.id]);
 assert.equal(store.tasks.get(queued.id).state,'queued');
 assert.throws(()=>new FleetStore(':memory:',limits,{orphanedTaskMs:1000}));
});

test('over HTTP the report carries receipts and /tasks/orphaned lists the item',async t=>{
 let clock=2_000_000_000;
 const store=new FleetStore(':memory:',limits,{now:()=>clock,orphanedTaskMs:5*MIN}),server=await serveFleet(store,{box:'b',mac:'m'},'a',0);
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const url='http://127.0.0.1:'+address.port,mac=new JsonClient(url,'m'),admin=new JsonClient(url,'a');
 store.tasks.report('mac',{capabilities:['dispatcher-repair'],ready:true});
 const task=store.tasks.request('org/core#3247',{recipe:'dispatcher-repair',capability:'dispatcher-repair',revision,reason:'failed check'});
 store.taskStart('mac',task.id,'native');
 store.finish('mac','native',`task-${task.id}`,false);
 await mac.call('/operations/report',{machine:'mac',report:{operations:[],localTasks:[]}});
 assert.deepEqual(await admin.call('/tasks/orphaned'),[]);
 clock+=6*MIN;
 await mac.call('/operations/report',{machine:'mac',report:{operations:[],localTasks:[]}});
 const items=await admin.call<any[]>('/tasks/orphaned');
 assert.equal(items.length,1);
 assert.equal(items[0].kind,'orphaned-task');
 assert.equal(items[0].since,2_000_000);
});
