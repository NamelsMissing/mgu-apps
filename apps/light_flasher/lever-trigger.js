'use strict';
// Lever trigger: detects a short OEM flash pull (AUS -> EIN -> AUS) on the
// combined Vehicle2 signal statusMainBeam_headlightFlasher and requests ONE run of
// the existing guarded manual pattern after the lever is released.
//
// The combined signal cannot tell a flash pull from switching high beam on, so
// only a SHORT ON pulse after a stable OFF phase counts. Sustained high beam,
// stale/unknown status, guard loss, a running flash or the cooldown reset the
// detector. Nothing here sends requests; the caller decides whether to run.
const DEFAULTS=Object.freeze({
 armOffMs:1000,    // OFF must be stable this long before a pulse counts
 minOnMs:0,        // change-notified signal; very short pulses still count
 maxOnMs:1500,     // longer ON = sustained high beam, never a trigger
 settleOffMs:400,  // OFF after release must persist before firing
 cooldownMs:5000,  // after a run ends, before the detector re-arms
 staleMs:2500,     // same freshness limit as the manual flash guard
});
const MIN_CHOICES=Object.freeze([0,250,500,750,1000,1250,1500]);
const MAX_CHOICES=Object.freeze([250,500,750,1000,1250,1500,1750,2000]);
function pulseRange(min,max){
 const a=Number(min),b=Number(max);
 return min!==null&&min!==undefined&&min!==''&&max!==null&&max!==undefined&&max!==''&&MIN_CHOICES.includes(a)&&MAX_CHOICES.includes(b)&&a<=b?{minOnMs:a,maxOnMs:b}:null;
}
function currentLightStatus(status,statusAt,now,staleMs=DEFAULTS.staleMs){
 return (status==='EIN'||status==='AUS')&&Number.isFinite(statusAt)&&statusAt<=now&&now-statusAt<=staleMs;
}

// Passive measurement for Diagnostics, independent of actuation eligibility.
class LeverObservation {
 constructor(){
  this.status=null;this.statusAt=null;this.pulledAt=null;this.lastHoldMs=null;
 }
 observe(status,at){
  if(!currentLightStatus(status,at,at)){
   this.status=null;this.statusAt=null;this.pulledAt=null;
   return;
  }
  const previous=currentLightStatus(this.status,this.statusAt,at)?this.status:null;
  if(status==='EIN'&&previous!=='EIN')this.pulledAt=previous==='AUS'?at:null;
  if(status==='AUS'){
   if(previous==='EIN'&&this.pulledAt!==null)this.lastHoldMs=at-this.pulledAt;
   this.pulledAt=null;
  }
  this.status=status;this.statusAt=at;
 }
 snapshot(now,available){
  const status=available&&currentLightStatus(this.status,this.statusAt,now)?this.status:null;
  return {status,holdMs:status==='EIN'&&this.pulledAt!==null?now-this.pulledAt:null,lastHoldMs:this.lastHoldMs};
 }
}
class LeverTrigger {
 constructor(now=Date.now,opts={},wallNow=now){
  this.now=now;this.wallNow=wallNow;this.milestones=null;this.lastSampleAt=null;this.opts={...DEFAULTS,...opts};this.rangeValid=true;
  this.enabled=false;this.state='disabled';this.offSince=null;this.lastOffAt=null;this.onSince=null;this.releasedAt=null;
  this.cooldownUntil=0;this.lastPulseMs=null;this.events=[];this.triggers=0;this.rejected=0;this.lastReason='Lever trigger off';
 }
 setRange(min,max){
  const range=pulseRange(min,max);
  if(!range){if(this.rangeValid){this.rangeValid=false;this.reset('Invalid lever pulse range');}return false;}
  if(!this.rangeValid||this.opts.minOnMs!==range.minOnMs||this.opts.maxOnMs!==range.maxOnMs){
   this.rangeValid=true;Object.assign(this.opts,range);this.reset('Timing changed; wait for stable OFF');
  }
  return true;
 }
 setEnabled(on){on=on===true;if(on!==this.enabled){this.enabled=on;this.reset(on?'Armed after stable OEM beam OFF':'Lever trigger off');}}
 reset(reason,recordCancellation=true){
  if(recordCancellation&&(this.state==='on'||this.state==='released'))this.record('cancelled',{why:reason,elapsedMs:this.now()-this.onSince});
  this.lastSampleAt=null;this.state=this.enabled?'waitOff':'disabled';this.offSince=null;this.lastOffAt=null;this.onSince=null;this.releasedAt=null;this.lastReason=reason;}
 record(kind,extra){this.events.push({at:new Date(this.wallNow()).toISOString(),kind,...extra});if(this.events.length>30)this.events.shift();}
 // Start of a run (lever or button): ignore everything until cooldown after it ends.
 runStarted(){this.reset('Flash running');this.cooldownUntil=Infinity;}
 runEnded(){this.cooldownUntil=this.now()+this.opts.cooldownMs;this.reset('Cooldown after flash');}
 // status: 'EIN' | 'AUS' | other; statusAt: receive time; allowed: trigger permitted
 // and nothing else running. Returns true exactly once per accepted pulse.
 update(status,statusAt,allowed,source){
  const t=this.now(),o=this.opts;
  if(!this.enabled){this.state='disabled';return false;}
  if(!this.rangeValid){this.reset('Invalid lever pulse range');return false;}
  if(!allowed){this.reset('Blocked: setting, screen, signal provider or another operation');return false;}
  if(t<this.cooldownUntil){this.reset('Cooldown after flash');return false;}
  if(!currentLightStatus(status,statusAt,t,o.staleMs)){this.reset('OEM light status unknown or stale');return false;}
  if(this.lastSampleAt!==null&&(statusAt<this.lastSampleAt||statusAt-this.lastSampleAt>o.staleMs)){
   this.reset('OEM light signal discontinuity');return false;
  }
  this.lastSampleAt=statusAt;
  switch(this.state){
   case 'waitOff':
    if(status==='AUS'){
     if(this.offSince===null||statusAt-this.lastOffAt>o.staleMs)this.offSince=t;
     this.lastOffAt=statusAt;
     if(t-this.offSince>=o.armOffMs){this.state='armed';this.lastReason='Armed: pull lever briefly';}
     return false;
    }
    if(this.offSince===null||statusAt-this.lastOffAt>o.staleMs||statusAt-this.offSince<o.armOffMs){
     this.offSince=null;this.lastReason='Waiting for OEM beam OFF';return false;
    }
    // A pull can arrive between the end of the stable OFF period and the next tick.
    // Fall through to start timing at the received ON edge.
   case 'armed':
    if(status==='EIN'){this.state='on';this.onSince=statusAt;this.milestones={oemOnReceivedMs:statusAt};this.record('pull',{receivedMs:statusAt,source});this.lastReason='Lever pulse seen';}
    return false;
   case 'on':
    if(status==='EIN'){
     if(t-this.onSince>o.maxOnMs)this.lastReason='Above maximum; waiting for release';
     return false;
    }
    this.lastPulseMs=statusAt-this.onSince;
    this.record('release',{onMs:this.lastPulseMs,receivedMs:statusAt,source});
    if(this.lastPulseMs>o.maxOnMs){this.rejected++;this.record('rejected',{onMs:this.lastPulseMs,why:'too long at release'});this.reset('Ignored: high beam held; re-arming',false);return false;}
    if(this.lastPulseMs<0||this.lastPulseMs<o.minOnMs){this.rejected++;this.record('rejected',{onMs:this.lastPulseMs,why:'too short'});this.state='armed';this.lastReason='Ignored: pulse below minimum';return false;}
    this.milestones.oemOffReceivedMs=statusAt;this.milestones.pulseValidMs=t;
    this.state='released';this.releasedAt=statusAt;this.lastReason='Released; confirming OFF';
    return false;
   case 'released':
    if(status==='EIN'){this.rejected++;this.record('rejected',{why:'second pulse before settle'});this.reset('Ignored: repeated pulse; re-arming',false);return false;}
    if(t-this.releasedAt<o.settleOffMs)return false;
    this.milestones.offConfirmedMs=t;this.milestones.triggerMs=this.now();
    this.triggers++;this.record('trigger',{onMs:this.lastPulseMs,elapsedMs:t-this.releasedAt});
    this.state='fired';this.lastReason='Triggered by lever pulse ('+this.lastPulseMs+' ms)';
    return true;
   case 'fired':
    return false; // waits for runStarted/runEnded or reset by the caller
   default:
    this.reset('Re-arming');return false;
  }
 }
 snapshot(){return {enabled:this.enabled,state:this.state,reason:this.lastReason,triggers:this.triggers,rejected:this.rejected,lastPulseMs:this.lastPulseMs,
   cooldownRemainingMs:Number.isFinite(this.cooldownUntil)?Math.max(0,this.cooldownUntil-this.now()):null,limits:{...this.opts},rangeValid:this.rangeValid,
   scope:'manual flash enabled; foreground or explicitly enabled background; short pull only',events:this.events.slice()};}
}
module.exports={LeverTrigger,LeverObservation,DEFAULTS,MIN_CHOICES,MAX_CHOICES,pulseRange};
