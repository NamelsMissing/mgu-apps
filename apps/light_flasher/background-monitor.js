'use strict';
// Background observation of the already subscribed OEM light signal.
// No TASU access, writes, actuator calls, trigger/hold detection or extra polling.
class Monitor {
 constructor(now=Date.now,startReason='unknown'){
  this.now=now;this.startedAt=now();this.startReason=String(startReason||'unknown');
  this.enabled=false;this.firstVisibleAt=null;this.last=null;this.events=[];this.observedBeforeOpen=0;
 }
 setEnabled(on){on=on===true;if(this.enabled!==on){this.enabled=on;this.last=null;this.events=[];this.observedBeforeOpen=0;}}
 seeMain(){if(this.firstVisibleAt===null)this.firstVisibleAt=this.now();}
 observe(v,signalAvailable,mainVisible){
  if(!this.enabled||!signalAvailable){this.last=null;return;}
  const s=v&&v.statusMainBeam_headlightFlasher;
  if(s!=='EIN'&&s!=='AUS'){this.last=null;return;}
  if(s===this.last)return;
  this.last=s;
  if(this.firstVisibleAt===null&&!mainVisible)this.observedBeforeOpen++;
  this.events.push({at:new Date(this.now()).toISOString(),combinedSignal:s,mainVisible:!!mainVisible});
  if(this.events.length>40)this.events.shift();
 }
 snapshot(){return {mode:'passive only',scope:'valid light signal, independent of gear or speed',enabled:this.enabled,startedAt:new Date(this.startedAt).toISOString(),
   startReason:this.startReason,firstMainVisibleAt:this.firstVisibleAt===null?null:new Date(this.firstVisibleAt).toISOString(),
   observedBeforeOpen:this.observedBeforeOpen,lastCombinedSignal:this.last,events:this.events.slice(),
   automaticActuation:false,leverDistinction:false};}
}
module.exports=Monitor;
