'use strict';
// Only a bounded explicit parked test, never automatic, no OEM suppression.
const {replyTo}=require('./tasu');
const {config}=require('./flash-config');
const Feedback=require('./feedback');
const units=Object.freeze([{address:0x43,index:'0F26C0',side:'left'},{address:0x44,index:'0F26D0',side:'right'}]);
const hex=b=>Array.from(b||[]).map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join('');
// Channel 8 = high beam LEDs; PWM 60 %, ECU timeout 1 s. Fast test: PWM 0 instead of STOP.
const ON=Object.freeze([0x01,0xA5,0x4B,8,60,1]),OFF_PWM0=Object.freeze([0x01,0xA5,0x4B,8,0,1]);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class ManualFlash {
 constructor(diag,log,sleep=wait,now=Date.now,journal=null){this.diag=diag;this.log=log;this.sleep=sleep;this.now=now;this.journal=journal;this.running=false;this.cancelled=false;this.trace=[];this.status='Idle';this.cleanupUnconfirmed=!!(journal&&journal.exists());this.config=null;this.stepsCompleted=0;this.elapsedMs=0;this.fast=null;}
 cancel(){this.cancelled=true;}
 // Explicit recovery only: never send routine START or PWM commands.
 async recover(allowed,changed=()=>{}){
  if(this.running)throw Error('Another operation in progress');
  if(!this.cleanupUnconfirmed&&!(this.journal&&this.journal.exists()))return;
  this.cleanupUnconfirmed=true;
  if(!allowed()||!this.diag.available)throw Error('Park in P, stationary, switch OEM high beam OFF and wait for TASU');
  this.running=true;this.cancelled=false;this.trace=[];this.config=null;this.fast=null;this.stepsCompleted=0;this.elapsedMs=0;
  this.status='Recovering normal lamp control';
  const began=this.now(),touched=[],errors=[];
  const check=()=>{if(this.cancelled||!allowed()||!this.diag.available)throw Error('Recovery cancelled or parked/OEM-light guard changed')};
  const send=async(m,sid,data,cleanup=false)=>{
   if(!cleanup)check();
   const at=this.now(),rec={at:new Date().toISOString(),side:m.side,tx:hex([sid,...data]),elapsedMs:at-began};this.trace.push(rec);
   try{
    if(!this.diag.available)throw Error('TASU unavailable');
    const u=await this.diag.physical(m.address,sid,data,1500,replyTo(sid,data),{maxRetries:0,callTimeoutMs:1500,hardTimeoutMs:2400,pendingTimeoutMs:1500});
    rec.rx=u?hex(u):'TIMEOUT';
    if(!u||u[0]!==sid+0x40||!replyTo(sid,data)(u))throw Error(m.side+' '+rec.tx+' reply '+rec.rx);
    return u;
   }catch(e){rec.error=String(e.message||e);throw e}
   finally{rec.requestMs=Math.max(0,this.now()-at);}
  };
  const record=e=>{const msg=String(e.message||e);errors.push(msg);this.log.warn(msg)};
  try{
   changed();
   // Validate both identities before changing either session.
   for(const m of units){const u=await send(m,0x22,[0xF1,0x50]);if(hex(u.slice(3))!==m.index)throw Error('Unsupported '+m.side+' FLM identity');}
   try{
    for(const m of units){
     check();touched.push(m);
     try{
      await send(m,0x10,[0x03]);await send(m,0x31,[0x02,0xA5,0x4B]);
     }catch(e){record(e)}
    }
   }finally{
    // Always attempt default session for any possibly changed ECU.
    for(const m of touched){try{await send(m,0x10,[0x01],true)}catch(e){record(e)}}
   }
   if(errors.length)throw Error('STOP/default session not confirmed');
   for(const m of units){
    const raw=await send(m,0x22,[0xD6,0xDB]);
    const ch=Feedback.decode(Array.from(raw).map(x=>x.toString(16).padStart(2,'0')).join(' '));
    if(!ch||ch[7].pwmPercent!==0||ch[7].currentMa!==0)throw Error(m.side+' high beam OFF not confirmed');
   }
   check();
   if(this.journal&&this.journal.exists())this.journal.clear();
   this.cleanupUnconfirmed=false;
  }catch(e){record(e)}
  finally{
   this.elapsedMs=this.now()-began;this.running=false;
   this.status=this.cleanupUnconfirmed?'LOCKED: recovery not confirmed; '+errors.join(' | '):'Recovery acknowledged; verify normal lamps';
   changed();
  }
  if(this.cleanupUnconfirmed)throw Error(this.status);
 }
 async run(requested,allowed,changed=()=>{}){
  if(this.running)throw Error('Flash already running');
  if(this.cleanupUnconfirmed||(this.journal&&this.journal.exists()))throw Error('Previous cleanup unconfirmed: verify normal lights; locked pending service inspection');
  if(!allowed()||!this.diag.available)throw Error('Enable parked flash, select P and switch OEM high beam OFF');
  const cfg=config(requested.pattern,requested.intervalMs,requested.durationMs);
  const fast=requested.fast===true;
  this.config={...cfg,mode:fast?'fast-test':'standard'};this.stepsCompleted=0;this.elapsedMs=0;
  this.fast=fast?{offMethod:'FLM_KANAL PWM 0 (31 01 A5 4B 08 00 01)',fixedGapMs:0,offVerified:{left:null,right:null},offRequests:0}:null;
  this.running=true;this.cancelled=false;this.trace=[];this.status='Checking FLM identities and high beam OFF';changed();
  let began=null,deadline=Infinity,marked=false,error=null;
  const touched=[],affected=new Set();
  const check=()=>{if(this.cancelled||!allowed()||!this.diag.available)throw Error('Cancelled or park/OEM-light guard changed')};
  const send=async(m,sid,data,cleanup=false)=>{
   if(!cleanup)check();
   const sentAt=this.now();
   const rec={at:new Date().toISOString(),side:m.side,tx:hex([sid,...data]),elapsedMs:began===null?null:sentAt-began};this.trace.push(rec);
   try{
    if(!this.diag.available)throw Error('TASU unavailable');
    const u=await this.diag.physical(m.address,sid,data,800,replyTo(sid,data),{maxRetries:0,callTimeoutMs:1000,hardTimeoutMs:1800,pendingTimeoutMs:1000});
    rec.rx=u?hex(u):'TIMEOUT';
    if(!u||u[0]!==sid+0x40||!replyTo(sid,data)(u))throw Error('FLM '+m.side+' '+rec.tx+' reply '+rec.rx);
    return u;
   }catch(e){rec.error=String(e.message||e);throw e}
   finally{rec.requestMs=Math.max(0,this.now()-sentAt);}
  };
  const delay=async(ms,limit=Infinity)=>{const until=Math.min(this.now()+ms,limit);while(this.now()<until){check();await this.sleep(Math.min(50,until-this.now()))}};
  const cleanup=async(m,sid,data)=>{try{await send(m,sid,data,true);return true}catch(e){this.cleanupUnconfirmed=true;this.log.warn(String(e));return false}};
  try{
   for(const m of units){
    const u=await send(m,0x22,[0xF1,0x50]);if(hex(u.slice(3))!==m.index)throw Error('Unsupported '+m.side+' FLM identity');
    const raw=await send(m,0x22,[0xD6,0xDB]);const channels=Feedback.decode(Array.from(raw).map(x=>x.toString(16).padStart(2,'0')).join(' '));
    if(!channels||channels[7].pwmPercent!==0||channels[7].currentMa!==0)throw Error(m.side+' high beam OFF not confirmed');
   }
   check();if(this.journal){this.journal.mark();marked=true;}
   for(const m of units){check();touched.push(m);await send(m,0x10,[0x03]);}
   began=this.now();deadline=began+cfg.durationMs;
   // Fast test: no STOP and no fixed dark gap between pulses. A side is switched off
   // by restarting the routine with PWM 0; the first OFF per side is read back via
   // D6DB and must show channel 8 at 0 % / 0 mA, otherwise the run stops (STOP).
   // Every side stays in `affected`, so the final cleanup always sends STOP + 10 01.
   if(fast){
    const verifyOff=async m=>{
     const raw=await send(m,0x22,[0xD6,0xDB]);const ch=Feedback.decode(Array.from(raw).map(x=>x.toString(16).padStart(2,'0')).join(' '));
     const ok=!!ch&&ch[7].pwmPercent===0&&ch[7].currentMa===0;this.fast.offVerified[m.side]=ok;changed();
     if(!ok)throw Error(m.side+': PWM 0 not confirmed as OFF (D6DB channel 8 '+(ch?ch[7].pwmPercent+' % / '+ch[7].currentMa+' mA':'unreadable')+'); fast test unusable');
    };
    for(let i=0;i<100&&this.now()<deadline;i++){
     check();const step=cfg.steps[i%cfg.steps.length];const started=[];const stepAt=this.now();
     this.status='FAST TEST '+cfg.label+' | step '+(i+1)+' | '+step.join(' + ');changed();
     for(const side of step){
      check();if(this.now()>=deadline)break;
      const m=units.find(x=>x.side===side);started.push(m);affected.add(m);
      await send(m,0x31,ON);
     }
     if(started.length)await delay(Math.max(0,cfg.intervalMs-(this.now()-stepAt)),deadline);
     for(const m of started){
      await send(m,0x31,OFF_PWM0,true);this.fast.offRequests++;
      if(this.fast.offVerified[m.side]===null)await verifyOff(m);
     }
     if(started.length===step.length)this.stepsCompleted++;
    }
   }else
   for(let i=0;i<50&&this.now()<deadline;i++){
    check();const step=cfg.steps[i%cfg.steps.length];const started=[];const stepAt=this.now();
    this.status='Pattern '+cfg.label+' | step '+(i+1)+' | '+step.join(' + ');changed();
    try{
     for(const side of step){
      check();if(this.now()>=deadline)break;
      const m=units.find(x=>x.side===side);started.push(m);affected.add(m);
      await send(m,0x31,ON);
     }
     // ECU timeout is one second regardless of host scheduling. Settings are
     // requested step time, not a guarantee of physical pulse width.
     if(started.length)await delay(Math.max(0,cfg.intervalMs-(this.now()-stepAt)),deadline);
    }finally{
     for(const m of started){if(await cleanup(m,0x31,[0x02,0xA5,0x4B]))affected.delete(m);}
    }
    if(this.cleanupUnconfirmed)throw Error('STOP not confirmed; no further pulses');
    if(started.length===step.length)this.stepsCompleted++;
    // A real dark gap between repeated same-side pulses; no new pulse before STOP.
    if(this.now()<deadline)await delay(150,deadline);
   }
  }catch(e){error=e}
  finally{
   // A successful final STOP supersedes a failed intermediate STOP.
   if(marked||touched.length)this.cleanupUnconfirmed=false;
   for(const m of affected)await cleanup(m,0x31,[0x02,0xA5,0x4B]);
   for(const m of touched)await cleanup(m,0x10,[0x01]);
   if(marked&&!this.cleanupUnconfirmed){try{this.journal.clear()}catch(e){this.cleanupUnconfirmed=true;error=error||e}}
   this.elapsedMs=began===null?0:this.now()-began;
   this.running=false;
   this.status=this.cleanupUnconfirmed?'LOCKED: cleanup not confirmed; check normal lamps':
    error?'Stopped: '+String(error.message||error):'Pattern finished; '+this.stepsCompleted+' steps; verify normal lamps';
   changed();
  }
  if(error)throw error;
  if(this.cleanupUnconfirmed)throw Error('Cleanup not confirmed; no further flash allowed');
 }
}
module.exports=ManualFlash;