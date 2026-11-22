'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ManualFlash=require('../apps/light_flasher/manual-flash');
const Guard=require('../apps/light_flasher/guard');
const Release=require('../apps/light_flasher/release-status');
function rig(opts={}){
 let marked=true,t=1000;
 const calls=[],journal={exists:()=>marked,clear:()=>{if(opts.diskError)throw Error('disk error');marked=false}};
 const diag={available:true,async physical(addr,sid,data){
  calls.push([addr,sid,...data]);t+=100;
  if(sid===0x22&&data[0]===0xF1)return [0x62,0xF1,0x50,0x0F,0x26,opts.badIdentity?0:addr===0x43?0xC0:0xD0];
  if(sid===0x22&&data[0]===0xD6){const b=Array(75).fill(0);if(opts.lit)b[35]=60;return [0x62,0xD6,0xDB,...b]}
  if(sid===0x10)return opts.defaultFail&&data[0]===1?null:[0x50,data[0]];
  if(sid===0x31&&data[0]===2)return opts.stopFail? [0x7F,0x31,0x24]:[0x71,2,0xA5,0x4B];
  throw Error('unexpected command');
 }};
 const f=new ManualFlash(diag,{warn(){}},async()=>{},()=>t,journal);
 return {f,calls,journal};
}
test('recovery confirms both sides, clears marker and never starts lamps',async()=>{
 const r=rig();await r.f.recover(()=>true);assert.equal(r.f.cleanupUnconfirmed,false);assert.equal(r.journal.exists(),false);
 assert.equal(r.calls.filter(x=>x[1]===0x31&&x[2]===2).length,2);
 assert.ok(!r.calls.some(x=>x[1]===0x31&&x[2]===1));
 assert.equal(Release.summarize(r.f.trace,false).acknowledged,true);
});
for(const name of ['stopFail','defaultFail','badIdentity','lit','diskError']){
 test('recovery fails closed: '+name,async()=>{const r=rig({[name]:true});await assert.rejects(r.f.recover(()=>true));assert.equal(r.f.cleanupUnconfirmed,true);assert.equal(r.journal.exists(),true);if(name==='badIdentity')assert.ok(r.calls.every(x=>x[1]===0x22));});
}
test('guard denied: no diagnostic commands',async()=>{const r=rig();await assert.rejects(r.f.recover(()=>false));assert.equal(r.calls.length,0);assert.equal(r.journal.exists(),true)});
test('guard lost mid-recovery: returns touched ECU to default then remains locked',async()=>{const r=rig();await assert.rejects(r.f.recover(()=>r.calls.length<3));assert.ok(r.calls.some(x=>x[1]===0x10&&x[2]===1));assert.equal(r.journal.exists(),true)});
test('current guard reports motion and gear but does not enforce stationary/P',()=>{
 const g=new Guard(()=>1000);
 g.feedSpeed({speedVehicleCentreOfGravity:64});g.feedStage({statusActualStageDrive:'D'});
 assert.equal(g.recoveryReason(),null);
 assert.equal(g.snapshot().speedKmh,1);
 assert.equal(g.snapshot().stage,'D');
});
test('final successful STOP supersedes earlier failure',()=>{const trace=[{side:'left',tx:'1003',rx:'5003'},{side:'left',tx:'3101A54B',rx:'7101A54B'},{side:'left',tx:'3102A54B',rx:'TIMEOUT',error:'timeout'},{side:'left',tx:'3102A54B',rx:'7102A54B'},{side:'left',tx:'1001',rx:'5001'}];assert.equal(Release.summarize(trace,false).acknowledged,true)});

test('recovery requires current OFF, a live provider and TASU',()=>{
 const src=require('fs').readFileSync(require('path').join(__dirname,'../apps/light_flasher/main.js'),'utf8');
 assert.match(src,/const recoveryReady=\(\)=>!closing&&!guard.recoveryReason\(\)&&reader.diag.available&&lightProviderAvailable\(\)&&lastCombined==='AUS'/);
 assert.match(src,/const allowed=\(\)=>recoveryReady\(\)&&\(automatic\|\|ui.isVisible\('MAIN'\)\)/);
});
