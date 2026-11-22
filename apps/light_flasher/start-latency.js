'use strict';

function monotonicMs() {
 const time=process.hrtime();
 return time[0]*1000+time[1]/1e6;
}

class StartLatency {
 constructor(now,lever={}){
  this.now=now;this.events=[];this.times={...lever};this.spans={};this.failure=null;
  this.origin=lever.oemOnReceivedMs===undefined?now():lever.oemOnReceivedMs;
  for(const name of Object.keys(lever))this.mark(name,undefined,lever[name]);
 }
 mark(name,detail,at=this.now()){
  if(this.times[name]===undefined)this.times[name]=at;
  this.events.push({name,ms:at-this.origin,...detail});
 }
 interval(name,start,end,side){
  const a=this.events.find(e=>e.name===start&&e.side===side);
  const b=this.events.find(e=>e.name===end&&e.side===side);
  if(a&&b)this.spans[name+(side?'.'+side:'')]=Math.round((b.ms-a.ms)*1000)/1000;
 }
 snapshot(){
  const d=(a,b)=>this.times[a]===undefined||this.times[b]===undefined?null:Math.round((this.times[b]-this.times[a])*1000)/1000;
  for(const side of ['left','right']){
   this.interval('identityMs','identityBeginMs','identityEndMs',side);
   this.interval('d6dbMs','d6dbBeginMs','d6dbEndMs',side);
   this.interval('sessionQueueMs','sessionRequestedMs','sessionDispatchedMs',side);
   this.interval('sessionResponseMs','sessionDispatchedMs','sessionConfirmedMs',side);
  }
  this.interval('journalMs','journalBeginMs','journalEndMs');
  const milestonesMs={};
  for(const name of Object.keys(this.times))milestonesMs[name]=this.times[name]-this.origin;
  return {
   clock:'monotonic ms',origin:'OEM ON reception or button attempt',opticalLedOnMs:null,
   milestonesMs,
   events:this.events.slice(),phaseDurationsMs:{...this.spans},failure:this.failure,
   holdMs:d('oemOnReceivedMs','oemOffReceivedMs'),
   releaseToValidMs:d('oemOffReceivedMs','pulseValidMs'),
   offConfirmationMs:d('pulseValidMs','offConfirmedMs'),
   releaseToTriggerMs:d('oemOffReceivedMs','triggerMs'),
   triggerToRequestMs:d('triggerMs','startRequestedMs'),
   triggerToFirstUdsStartMs:d('triggerMs','firstUdsStartDispatchedMs'),
   releaseToFirstUdsStartMs:d('oemOffReceivedMs','firstUdsStartDispatchedMs'),
   requestToFirstUdsStartMs:d('startRequestedMs','firstUdsStartDispatchedMs'),
   releaseToPositiveReplyMs:d('oemOffReceivedMs','firstPositiveStartReplyMs'),
   startReplyMs:d('firstUdsStartDispatchedMs','firstPositiveStartReplyMs'),
  };
 }
}
module.exports={monotonicMs,StartLatency};
