'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {BmwColors, selection, slotOf, statusSlot} = require('../apps/g21_ambient/bmw_colors');

const status = n => ({statusMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_' + n});
const log = () => ({rows: [], add(...args) { this.rows.push(args); }});
function harness() {
    const events = {}, writes = [], recorder = log();
    const signals = {
        async watch(name, _instance, handlers) {
            events[name] = handlers;
            return {proxy: {name}, error: null};
        },
        async set(proxy, field, value) {
            writes.push({proxy, field, value});
        },
    };
    const bmw = new BmwColors(signals, recorder, {warn() {}, info() {}});
    return {bmw, signals, events, writes, recorder};
}
const comfort = 'de.bmw.infotainment.misc.ComfortFunctionIuK';
const profile = 'de.bmw.body.interiorillumination.AmbientLight';

test('OEM slot request writes only BMW menu choice and preserves other fields', () => {
    assert.equal(slotOf('FARBAUSWAHL_3'), 3);
    assert.equal(slotOf(11), 11);
    assert.equal(slotOf('FARBAUSWAHL_13'), null);
    assert.equal(slotOf('invalid'), null);
    assert.equal(statusSlot(status(4)), 4);
    const v = selection(3);
    assert.deepEqual(Object.keys(v).sort(), [
        'controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting',
        'controlDynamicAmbienteInteriorLighting',
        'controlDynamicInteriorLighting',
        'controlHueInteriorLighting',
        'controlHueValueLayer1IndividualGroup',
        'controlHueValueLayer2IndividualGroup',
        'controlHueValueLayer3IndividualGroup',
        'controlMenuAmbientePanoramicRoofInteriorLighting',
        'controlModeAmbientePanoramicRoofInteriorLighting',
    ].sort());
    assert.equal(v.controlMenuAmbientePanoramicRoofInteriorLighting, 'FARBAUSWAHL_3');
    assert.equal(v.controlModeAmbientePanoramicRoofInteriorLighting, 'SIGNAL_UNBEFUELLT');
    assert.equal(v.controlHueInteriorLighting, 4095);
    assert.equal(v.controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting, 255);
    assert.throws(() => selection(0), RangeError);
    assert.throws(() => selection(13), RangeError);
});
test('BMW menu selection reports active slot without writing until user action', async () => {
    const {bmw,events,writes} = harness();
    await bmw.start();
    assert(bmw.available);
    assert(!bmw.ready, 'cannot write without an observed original BMW status');
    events[comfort].statusAmbientLightInteriorColour(status(2));
    events[profile].currentInteriorLightProfile({currentLightProfileId:'COLOUR2'});
    assert.equal(bmw.profile, 'COLOUR2');
    assert.equal(bmw.slot, 2);
    assert(bmw.ready);
    assert.equal(writes.length, 0);
    const r = await bmw.setSlot(4);
    assert.equal(r.sent, true);
    assert.equal(r.acknowledged, true);
    assert.equal(r.readback, false, 'setter ACK is not the same as a readback');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].field, 'ambientLightInteriorColour');
    assert.equal(writes[0].value.controlMenuAmbientePanoramicRoofInteriorLighting,'FARBAUSWAHL_4');
    events[comfort].statusAmbientLightInteriorColour(status(4));
    assert.equal(bmw.slot, 4);
    assert.equal(bmw.last.readback, true);
});
test('unavailable or old status leaves vehicle untouched', async () => {
    const {bmw,events,writes} = harness();
    await bmw.start();
    const noStatus = await bmw.setSlot(3);
    assert.equal(noStatus.sent, false);
    events[comfort].statusAmbientLightInteriorColour(status(1));
    bmw.observedAt -= 60000;
    assert.equal(bmw.statusFresh, false);
    const stale = await bmw.setSlot(3);
    assert.equal(stale.sent, false);
    assert.equal(writes.length, 0);
});
test('wrong slot and unchanged slot never send BMW setters', async () => {
    const {bmw,events,writes} = harness();
    await bmw.start();
    events[comfort].statusAmbientLightInteriorColour(status(5));
    assert.equal((await bmw.setSlot(5)).sent, false);
    assert.equal((await bmw.setSlot(0)).sent, false);
    assert.equal((await bmw.setSlot(13)).sent, false);
    assert.equal(writes.length, 0);
});
test('rejected SOME/IP setter is not reported as an accepted vehicle color change', async () => {
    const {bmw,signals,events} = harness();
    await bmw.start();
    events[comfort].statusAmbientLightInteriorColour(status(1));
    signals.set = async () => {throw Error('Request rejected');};
    const r = await bmw.setSlot(2);
    assert.equal(r.acknowledged, false);
    assert.equal(r.readback, false);
    assert.match(r.text, /rejected/i);
    assert.equal(bmw.slot, 1);
    assert.equal(bmw.busy, false);
});
test('rapid subsequent setters are refused; queued/broadcast writes do not exist', async () => {
    const {bmw,events,writes} = harness();
    await bmw.start();
    events[comfort].statusAmbientLightInteriorColour(status(1));
    await bmw.setSlot(2);
    const r = await bmw.setSlot(3);
    assert.equal(r.sent,false);
    assert.match(r.text, /wait 1.5 seconds/);
    assert.equal(writes.length, 1);
});
test('BMW interface unavailable, optional profile absent: safe preview/read only', async () => {
    const recorder = log(), signals = {watch: async () => ({error:'not installed',proxy:null}), set: async () => {throw Error('should not run');}};
    const bmw = new BmwColors(signals,recorder,{warn() {}});
    await bmw.start();
    assert.equal(bmw.available,false);
    const r = await bmw.setSlot(6);
    assert.equal(r.sent,false);
    assert.match(r.text,/unavailable/);
    assert(bmw.report().error);
});
