'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ComfortAuto } = require('../apps/g21_wheelheat/comfort_auto');
const cfg = {autoEnabled:true, belowTemp:10, coldDwell:0, wheelAuto:true, wheelMins:3,
    seatDriver:true, seatPassenger:false, seatLevel:3, seatMins:4, startUntil:220000};
const step = (p,t,c=cfg) => p.step({now:t,tempC:-1,tempAt:t,cfg:c});
test('failed preflight retries only the failed heater; duration starts at ACK', () => {
    const p = new ComfortAuto();
    const [wheel,seat] = step(p,100000);
    p.acknowledge(wheel,true,101000);
    p.acknowledge(seat,false,102000,true);
    assert.equal(p.remaining('Driver seat',102000),0);
    assert.equal(step(p,109999).length,0);
    const [again] = step(p,110000);
    assert.equal(again.device,'Driver seat');
    assert.equal(again.attempt,2);
    p.acknowledge(again,true,111000);
    assert.equal(p.remaining('Driver seat',111000),240);
    assert.equal(p.remaining('Steering wheel',111000),170);
    assert.equal(step(p,120000).length,0);
});
test('transient failures expire and never re-arm during a long drive', () => {
    const p = new ComfortAuto();
    const [wheel,seat] = step(p,100000);
    p.acknowledge(wheel,false,101000,true);
    p.acknowledge(seat,false,101000,true);
    assert.equal(step(p,220000).length,0);
    assert.equal(p.active.size,0);
    assert.equal(step(p,999999).length,0);
});
test('unconfirmed writes and permanent errors never retry', () => {
    const p = new ComfortAuto();
    for(const i of step(p,100000)) p.acknowledge(i,false,101000,false);
    assert.equal(step(p,110000).length,0);
    assert.equal(p.active.size,0);
});
test('STOP cancels pending starts including late acknowledgements', () => {
    const p = new ComfortAuto();
    const intents=step(p,100000);
    p.cancel();
    p.acknowledge(intents[0],true,101000);
    assert.equal(p.active.size,0);
    assert.equal(step(p,110000).length,0);
});
test('attempt count bounded even before deadline', () => {
    const p = new ComfortAuto();
    let count=0;
    for(let t=100000;t<220000;t+=8000) {
        for(const i of step(p,t)) {count++;p.acknowledge(i,false,t,true);}
    }
    assert.equal(count,16);
    assert.equal(p.active.size,0);
});
test('new ignition after cancellation can re-arm', () => {
    const p=new ComfortAuto();
    step(p,100000);p.cancel();assert.equal(p.rearm(),true);
    assert.equal(step(p,400000,{...cfg,startUntil:520000}).length,2);
});
test('disabled setting cancels pending start without OFF write', () => {
    const p=new ComfortAuto();
    for(const i of step(p,100000)) p.acknowledge(i,false,101000,true);
    assert.equal(step(p,110000,{...cfg,autoEnabled:false}).length,0);
    assert.equal(p.active.size,0);
});
