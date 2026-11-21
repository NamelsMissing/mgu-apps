'use strict';
// Automatic KOMBI display (setting kombiAuto): parked only, no menu, no request loops.
const assert = require('assert');
const EventEmitter = require('events');
const { ClusterLayers } = require('../apps/custom_cluster/cluster_layers');

class FakeRenderer extends EventEmitter {
    constructor() { super(); this.backend = 'id7'; this.targets = 'map:1088x480,panel:1920x720';
        this.effects = []; this.drops = []; this.sets = []; this.statusCalls = 0; }
    connect() { this.emit('ready'); } close() {}
    effect(o) { this.effects.push(o); return this.effects.length; }
    image(o) { this.effects.push(o); return this.effects.length; }
    pixels() { return true; } uniform() {}
    set(ref, o) { this.sets.push([ref, o]); } drop(ref) { this.drops.push(ref); }
    status() { this.statusCalls++; }
}
const IDLE = 'target panel: slot 0x203 scene 0x10004f8 1920x720: idle; scene published\nslot 0x203 status 1: 0x10004f8 class 0 map 0';
const opts = (more) => Object.assign({ layout: 'g80', panelTestMode: 'probe', panelTarget: 'panel', accent: 'm',
    sixwbTheme: 'comfort', sixwbColorSource: 'original', colorMode: 'palette', colorBrightness: 100,
    wazeMap: 'auto', enablePanelTests: false, kombiAuto: 'parked' }, more || {});
const real = Date.now;
let clock = real();
Date.now = () => clock;
const log = { info() {}, warn() {} };
const panelLayers = (f) => f.effects.filter((e) => e.target === 'panel');

try {
    const fake = new FakeRenderer(), c = new ClusterLayers(log, null, fake);
    const parked = () => c.sample({ speed: 0, rpm: 790, stage: 'P', gear: 0 });
    const step = (ms, sampler) => { clock += ms; (sampler || parked)(); c.autoTick(); c.apply(); };

    // switched off: never requests anything, even with experimental tests disabled
    c.settings(opts({ kombiAuto: 'off' }));
    for (let i = 0; i < 40; i++) step(250);
    assert.strictEqual(panelLayers(fake).length, 0, 'off by default');
    assert.strictEqual(c.status().autoMode, 'off');

    // on, but the manual test switch stays off: automatic display is its own opt-in
    c.settings(opts());
    clock += 1000;
    c.sample({ speed: 0, rpm: 790, stage: 'D', gear: 3 }); c.autoTick();
    assert.strictEqual(panelLayers(fake).length, 0, 'not in D');
    assert.ok(/Selector D/.test(c.status().autoReason));
    parked(); c.autoTick();
    assert.strictEqual(panelLayers(fake).length, 0, 'not immediately');
    step(2000);
    assert.strictEqual(panelLayers(fake).length, 0, 'parked for only 2 s');
    step(1500);
    assert.ok(panelLayers(fake).length > 0, 'requested after 3 s parked');
    assert.strictEqual(c.status().panelActive, true);
    assert.strictEqual(c.status().autoRun, true);
    assert.ok(panelLayers(fake).every((e) => e.x + e.w <= 416 && e.contend === false), 'never over the map aperture');

    // stays up far beyond the 12 s test window while parked, without new requests
    const created = fake.effects.length;
    for (let i = 0; i < 400; i++) step(250); // 100 s
    assert.strictEqual(c.status().panelActive, true, 'kept while parked');
    assert.strictEqual(fake.effects.length, created, 'no re-creation while it is shown');

    // pulling away releases it through the normal guard
    c.sample({ speed: 12, rpm: 1500, stage: 'D', gear: 1 }); c.autoTick(); c.apply();
    assert.strictEqual(c.status().panelActive, false, 'driving: released at once');
    assert.ok(fake.drops.length >= created);
    clock += 250; c.sample({ speed: 12, rpm: 1500, stage: 'D', gear: 1 }); c.autoTick();
    assert.strictEqual(c.status().autoRun, false);

    // parked again: waits for BMW's release confirmation before it asks again
    for (let i = 0; i < 20; i++) step(250);
    assert.strictEqual(c.status().panelActive, false, 'no request before the slot release is confirmed');
    assert.ok(/release/.test(c.status().autoReason), c.status().autoReason);
    fake.emit('target', 'panel', 'idle', 'none', '');
    fake.emit('status', IDLE);
    for (let i = 0; i < 20; i++) step(250);
    assert.strictEqual(c.status().panelActive, true, 'shown again after the release is confirmed');

    // the user stops it (Test KOMBI button): it stays off until the next parking
    c.armPanel();
    assert.strictEqual(c.status().panelActive, false);
    fake.emit('target', 'panel', 'idle', 'none', ''); fake.emit('status', IDLE);
    const afterStop = fake.effects.length;
    for (let i = 0; i < 60; i++) step(250);
    assert.strictEqual(fake.effects.length, afterStop, 'no loop after a stop');
    assert.ok(/paused/.test(c.status().autoReason));
    c.sample({ speed: 20, rpm: 1800, stage: 'D', gear: 2 }); c.autoTick();
    fake.emit('status', IDLE); // the renderer answers the periodic status request
    for (let i = 0; i < 24; i++) step(250);
    assert.strictEqual(c.status().panelActive, true, 'next parking: automatic display resumes');

    // switching the setting off removes it
    c.settings(opts({ kombiAuto: 'off' }));
    c.autoTick();
    assert.strictEqual(c.status().panelActive, false);

    // BMW original layout: nothing to show
    const stock = new ClusterLayers(log, null, new FakeRenderer());
    stock.settings(opts({ layout: 'stock' }));
    clock += 1000; stock.sample({ speed: 0, rpm: 790, stage: 'P', gear: 0 });
    for (let i = 0; i < 30; i++) { clock += 250; stock.sample({ speed: 0, rpm: 790, stage: 'P', gear: 0 }); stock.autoTick(); }
    assert.strictEqual(stock.status().panelActive, false);

    // stale vehicle data: never shown
    const stale = new ClusterLayers(log, null, new FakeRenderer());
    stale.settings(opts());
    stale.sample({ speed: 0, rpm: 790, stage: 'P', gear: 0 });
    clock += 60000; stale.autoTick();
    assert.strictEqual(stale.status().panelActive, false, 'stale speed/RPM is not "parked"');
    console.log('custom-cluster automatic KOMBI (parked only) tests passed');
} finally { Date.now = real; }
