'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const appDir=path.resolve(__dirname,'../apps/light_flasher');
const app=require('../apps/light_flasher/app.json');
const {Diag,replyTo}=require('../apps/light_flasher/tasu');

function loadBaseline(){
 const dir=process.env.LIGHT_FLASHER_BASELINE_DIR;
 const result={};
 for(const name of ['main','manual-flash','lever-trigger']){
  result[name]=fs.readFileSync(path.join(dir,name+'.js'),'utf8');
 }
 return result;
}

function rig({baseline,phase=0,rtt=120,heldWrite=false,loss,refused,background=true}={}){
 let now=10000,seq=0,visible=background?'HIDDEN':'MAIN',light,availability,visibility,appStart,journal=false;
 const calls=[],timers=new Map(),clicks={},files={},writes=[];
 const wall=class extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
 const defaults=Object.fromEntries(app.settings.map(s=>[s.key,s.default]));
 Object.assign(defaults,{manualFlash:true,leverTrigger:true,leverBackground:background});
 const timer=(fn,ms=0,repeat=false)=>{
  const id=++seq;timers.set(id,{fn,at:now+ms,ms:repeat?ms:0});return id;
 };
 const fsMock={
  readFileSync:()=>{throw Object.assign(Error('not found'),{code:'ENOENT'});},
  writeFileSync(file,body){if(file.endsWith('manual-flash-pending.json'))journal=true;files[file]=body;},
  renameSync(from,to){files[to]=files[from];delete files[from];},
  writeFile(file,body,cb){files[file]=body;if(heldWrite)writes.push(cb);else timer(cb);},
  rename(from,to,cb){fsMock.renameSync(from,to);timer(cb);},
  existsSync:file=>file.endsWith('manual-flash-pending.json')&&journal,
  unlinkSync(){journal=false;},
 };
 const diag={available:true,async physical(addr,sid,data,timeout,accept,options){
  if(options.beforeDispatch)options.beforeDispatch();
  calls.push({at:now,addr,sid,data});
  await new Promise(resolve=>timer(resolve,rtt));
  if(loss===calls.length){diag.available=false;return null;}
  if(refused===calls.length)return null;
  let ans;
  if(sid===0x22)ans=data[0]===0xF1?[0x62,0xF1,0x50,0x0F,0x26,addr===0x43?0xC0:0xD0]:[0x62,0xD6,0xDB,...Array(75).fill(0)];
  else if(sid===0x10)ans=[0x50,data[0]];
  else ans=[0x71,...data.slice(0,3)];
  if(options.onReply)options.onReply(ans);
  return ans;
 }};
 const ctx={
  app:{startReason:'autostart'},dataDir:'/data',signals:{},log:{warn(){},info(){}},
  settings:{get:key=>defaults[key],onChange(){}},
  ui:{isVisible:name=>visible===name,text(){},onVisible:fn=>{visibility=fn;},onClick:(id,fn)=>{clicks[id]=fn;}},
 };
 const load=(name,source)=>{
  const module={exports:{}};
  vm.runInNewContext(source,{
   module,Date:wall,process:{pid:1,on(){}},
   setImmediate:fn=>timer(fn),setTimeout:timer,clearTimeout:id=>timers.delete(id),
   setInterval:(fn,ms)=>{const id=timer(fn,ms,true);timers.get(id).at+=phase;return id;},
   require(id){
    if(id==='fs')return fsMock;
    if(id==='./kit/mgu')return {run:app=>{appStart=app.start(ctx);}};
    if(id==='./guard')return class{
     reason(){return null;} recoveryReason(){return null;} snapshot(){return {};}
     async init(signals,log,fn,up){this.speedSub={available:true};light=fn;availability=value=>{this.speedSub.available=value;if(up)up(value);};}
    };
    if(id==='./probe')return {Reader:class{constructor(){this.diag=diag;this.trace=[];}async init(){}},Capture:class{status(){}stop(){}snapshot(){return {};}}};
    if(id==='./start-latency')return {...require(path.join(appDir,id)),monotonicMs:()=>now};
    if(baseline&&baseline[id.slice(2)])return load(id.slice(2),baseline[id.slice(2)]);
    if(id==='./manual-flash')return load('manual-flash',fs.readFileSync(path.join(appDir,'manual-flash.js'),'utf8'));
    return id.startsWith('./')?require(path.join(appDir,id)):require(id);
   },
  },{filename:name+'.js'});
  return module.exports;
 };
 load('main',baseline?baseline.main:fs.readFileSync(path.join(appDir,'main.js'),'utf8'));
 const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
 const go=async target=>{
  await appStart;
  await flush();
  while(true){
   const entry=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
   if(!entry||entry[1].at>target)break;
   const [id,t]=entry;now=t.at;timers.delete(id);
   if(t.ms){t.at+=t.ms;timers.set(id,t);}
   t.fn();await flush();
  }
  now=target;
 };
 return {go,light:value=>light({statusMainBeam_headlightFlasher:value}),availability:value=>availability(value),
  calls,files,writes,clicks,isLocked:()=>journal,flush,show:value=>{visible=value;visibility();}};
}
const start=calls=>calls.find(c=>c.sid===0x31&&c.data[0]===1);
const report=r=>JSON.parse(Object.entries(r.files).find(([file])=>file.includes('-run-v'))[1]);
const releaseAt=11437;
async function pulse(r,hold=237){
 await r.go(10000);r.light('AUS');
 await r.go(releaseAt-hold);r.light('EIN');
 await r.go(releaseAt);r.light('AUS');
}

test('autostart timer fires once at the confirmation deadline even with a held diagnostic write',async()=>{
 const r=rig({heldWrite:true});await pulse(r,7);
 r.light('AUS');
 await r.go(releaseAt+399);
 assert.equal(r.calls.length,0);
 await r.go(releaseAt+400+6*120);
 assert.equal(start(r.calls).at-releaseAt,1120);
 assert.equal(r.writes.length,1);
 await r.go(releaseAt+5100);
 const details=report(r).startLatency;
 assert.equal(details.holdMs,7);
 assert.equal(details.releaseToTriggerMs,400);
 assert.equal(details.releaseToFirstUdsStartMs,1120);
 assert.equal(details.releaseToPositiveReplyMs,1240);
 assert.equal(details.phaseDurationsMs['identityMs.left'],120);
 assert.equal(details.phaseDurationsMs['d6dbMs.right'],120);
 assert.equal(details.opticalLedOnMs,null);
});

test('provider loss during settle, reconnect while ON, and sustained ON cannot start a run',async()=>{
 for(const mode of ['loss','reconnect','held','contradictory']){
  const r=rig();
  if(mode==='held'){
   await r.go(10000);r.light('AUS');
   await r.go(11200);r.light('EIN');
   await r.go(13200);r.light('AUS');
  }else{
   await pulse(r);
   await r.go(releaseAt+100);
   if(mode==='contradictory')r.light('EIN');
   else r.availability(false);
   if(mode==='reconnect'){r.availability(true);r.light('EIN');}
   await r.go(releaseAt+200);r.light('AUS');
  }
  await r.go(15000);
  assert.equal(r.calls.length,0,mode);
 }
});

test('button wins against a pending lever; cancel during preparation leaves no START',async()=>{
 const r=rig({background:false});await pulse(r);
 await r.go(releaseAt+50);
 r.clicks.BTN_FLASH();await r.flush();
 assert.equal(r.calls.length,1);
 r.clicks.BTN_FLASH_STOP();await r.flush();
 await r.go(releaseAt+1300);
 assert.equal(r.calls.length,1);
 assert.equal(r.isLocked(),false);
 assert.match(report(r).startLatency.failure,/Cancelled/);
});
test('loss in preflight and missing START reply preserve cleanup semantics',async()=>{
 const loss=rig({loss:3});await pulse(loss);await loss.go(releaseAt+1600);
 assert.equal(start(loss.calls),undefined);
 assert.equal(loss.isLocked(),false);
 const timeout=rig({refused:7});await pulse(timeout);await timeout.go(releaseAt+2000);
 assert.ok(start(timeout.calls));
 assert.ok(timeout.calls.some(c=>c.sid===0x31&&c.data[0]===2));
 assert.equal(timeout.calls.filter(c=>c.sid===0x10&&c.data[0]===1).length,2);
 assert.equal(timeout.isLocked(),false);
 assert.match(report(timeout).startLatency.failure,/TIMEOUT/);
});

test('TASU BUSY with no retries and missing ECU reply are observable',async()=>{
 let verdict='APP_REQUEST_TEMPORARILY_NOT_ACCEPTED',calls=0;
 const diag=new Diag({call(p,method,params,ms,dispatch){calls++;dispatch();return Promise.resolve(verdict);}}, {info(){},warn(){}});
 diag.p={};
 const opts={maxRetries:0,beforeDispatch(){},hardTimeoutMs:20};
 await assert.rejects(diag.physical(0x43,0x10,[3],2,replyTo(0x10,[3]),opts),/transport refused/);
 assert.equal(calls,1);
 verdict='NO_ERROR';
 assert.equal(await diag.physical(0x43,0x10,[3],2,replyTo(0x10,[3]),opts),null);
 assert.equal(diag.listenerCount('frame'),0);
});

test('compare old and new at identical timer phases and simulated TASU RTTs',{
 skip:!process.env.LIGHT_FLASHER_BASELINE_DIR&&'Set LIGHT_FLASHER_BASELINE_DIR to the baseline app directory'
},async()=>{
 const baseline=loadBaseline();
 for(const rtt of [40,120,240]){
  const rows=[];
  for(const source of [baseline,null]){
   const values=[];
   for(let phase=0;phase<250;phase+=5){
    const r=rig({baseline:source,phase,rtt});
    await pulse(r);
    await r.go(releaseAt+4800);
    values.push(start(r.calls).at-releaseAt);
   }
   values.sort((a,b)=>a-b);
   const [median,p95,max]=[(values[24]+values[25])/2,values[47],values[49]];
   rows.push({median,p95,max});
  }
  assert.ok(rows[0].p95>rows[1].p95);
  console.log(JSON.stringify({rtt,baseline:rows[0],optimized:rows[1]}));
 }
});

test('lost ECU access after session entry latches the cleanup lock',async()=>{
 const r=rig({loss:6,background:false});
 await pulse(r);
 await r.go(releaseAt+1800);
 assert.equal(start(r.calls),undefined);
 assert.equal(r.isLocked(),true);
 const count=r.calls.length;
 await r.clicks.BTN_FLASH();
 assert.equal(r.calls.length,count);
});

test('signal watcher coalesces reads and ignores results overtaken by notifications or reconnect',async()=>{
 const source=fs.readFileSync(path.join(appDir,'../../kit/runtime/signals.js'),'utf8');
 let available, notification, poll;
 const getters=[],updates=[];
 const proxy={
  init:async()=>{},isAvailable:()=>false,
  subscribeToAvailability(fn){available=fn;},
  subscribe(opts){notification=opts.onReceive;},
  getValue(){return new Promise(resolve=>getters.push(resolve));},
 };
 const module={exports:{}};
 vm.runInNewContext(source,{
  module,__dirname:path.join(appDir,'../../kit/runtime'),setImmediate,
  setInterval(fn){poll=fn;},
  require(name){
   if(name==='someip')return {buildProxy:async()=>proxy};
   if(name==='fs')return {readFileSync:()=>JSON.stringify({fields:{statusLightStatus:{getter:true}}})};
   return require(name);
  },
 });
 await module.exports.watch('test','1',{statusLightStatus:(v,meta)=>updates.push([v,meta.source])},null,{pollMs:500});
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 available(true);poll();await flush();
 assert.equal(getters.length,1);
 notification('EIN');getters.shift()('AUS');await flush();
 assert.deepEqual(updates,[['EIN','notification']]);
 poll();await flush();
 available(false);available(true);await flush();
 assert.equal(getters.length,1);
 getters.shift()('AUS');await flush();assert.equal(updates.length,1);
 poll();await flush();getters.shift()('AUS');await flush();
 assert.deepEqual(updates,[['EIN','notification'],['AUS','poll']]);
});
