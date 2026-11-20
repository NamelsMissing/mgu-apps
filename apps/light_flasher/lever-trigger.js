'use strict';
// Parked lever trigger: detects a short OEM flash pull (AUS -> EIN -> AUS) on the
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
 return min!==null&&min!==undefined&&min!==''&&max!==null&&max!==undefined&&max!==''&&MIN_CHOICES.includes(a)&&MAX_CHOICES.includes(b)&&a<b?{minOnMs:a,maxOnMs:b}:null;
}
class LeverTrigger {
 constructor(now=Date.now,opts={}){
  this.now=now;this.opts={...DEFAULTS,...opts};this.rangeValid=true;
  this.enabled=false;this.state='disabled';this.offSince=null;this.onSince=null;this.releasedAt=null;
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
 reset(reason){this.state=this.enabled?'waitOff':'disabled';this.offSince=null;this.onSince=null;this.releasedAt=null;this.lastReason=reason;}
 record(kind,extra){this.events.push({at:new Date(this.now()).toISOString(),kind,...extra});if(this.events.length>30)this.events.shift();}
 // Start of a run (lever or button): ignore everything until cooldown after it ends.
 runStarted(){this.reset('Flash running');this.cooldownUntil=Infinity;}
 runEnded(){this.cooldownUntil=this.now()+this.opts.cooldownMs;this.reset('Cooldown after flash');}
 // status: 'EIN' | 'AUS' | other; statusAt: receive time; allowed: parked guard ok
 // and nothing else running. Returns true exactly once per accepted pulse.
 update(status,statusAt,allowed){
  const t=this.now(),o=this.opts;
  if(!this.enabled){this.state='disabled';return false;}
  if(!this.rangeValid){this.reset('Invalid lever pulse range');return false;}
  if(!allowed){this.reset('Blocked: parked guard, setting or another operation');return false;}
  if(t<this.cooldownUntil){this.reset('Cooldown after flash');return false;}
  if((status!=='EIN'&&status!=='AUS')||!Number.isFinite(statusAt)||t-statusAt>o.staleMs){this.reset('OEM light status unknown or stale');return false;}
  switch(this.state){
   case 'waitOff':
    if(status==='AUS'){if(this.offSince===null)this.offSince=t;if(t-this.offSince>=o.armOffMs){this.state='armed';this.lastReason='Armed: pull lever briefly';}}
    else{this.offSince=null;this.lastReason='Waiting for OEM beam OFF';}
    return false;
   case 'armed':
    if(status==='EIN'){this.state='on';this.onSince=t;this.lastReason='Lever pulse seen';}
    return false;
   case 'on':
    if(status==='EIN'){
     if(t-this.onSince>o.maxOnMs){this.rejected++;this.record('rejected',{onMs:t-this.onSince,why:'held too long / steady high beam'});this.reset('Ignored: high beam held; switch OFF to re-arm');}
     return false;
    }
    this.lastPulseMs=t-this.onSince;
    if(this.lastPulseMs>o.maxOnMs){this.rejected++;this.record('rejected',{onMs:this.lastPulseMs,why:'too long at release'});this.reset('Ignored: high beam held; re-arming');return false;}
    if(this.lastPulseMs<o.minOnMs){this.rejected++;this.record('rejected',{onMs:this.lastPulseMs,why:'too short'});this.state='armed';return false;}
    this.state='released';this.releasedAt=t;this.lastReason='Released; confirming OFF';
    return false;
   case 'released':
    if(status==='EIN'){this.rejected++;this.record('rejected',{why:'second pulse before settle'});this.reset('Ignored: repeated pulse; re-arming');return false;}
    if(t-this.releasedAt<o.settleOffMs)return false;
    this.triggers++;this.record('trigger',{onMs:this.lastPulseMs});
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
   scope:'P, stationary, manual flash enabled; foreground or explicitly enabled background; short pull only',events:this.events.slice()};}
}
module.exports={LeverTrigger,DEFAULTS,MIN_CHOICES,MAX_CHOICES,pulseRange};
