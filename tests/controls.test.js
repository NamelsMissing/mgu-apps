'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../apps/g21_ambient/logic');
const B = require('../apps/g21_wheelheat/logic');
const { ComfortAuto } = require('../apps/g21_wheelheat/comfort_auto');

test('RAM payload values, RGB matching and FDL slot 11 stay bounded', () => {
    assert.deepEqual(A.encode({ id: 0, on: 1, brightness: 100,
        red: 254, green: 0, blue: 45, seconds: 254 }),
    [0xE3, 0x11, 0, 1, 100, 254, 0, 45, 254]);
    assert.throws(() => A.encode({ id: 255, on: 1, brightness: 100,
        red: 10, green: 10, blue: 10, seconds: 5 }), RangeError);
    assert.deepEqual(A.exactColor([193, 79, 157]).rgb, [193, 79, 157]);
    assert.equal(A.slot11Plan([178, 102, 224]).newProfile, null,
        'no unverified free FDL index should be invented');
    assert.deepEqual(A.slot11RestorePlan().profile, [5, 0]);
});

test('BDC command bytes, temperature conversion and one-cycle timer', () => {
    assert.deepEqual(B.heating(240), [0xD0, 0x74, 240]);
    assert.deepEqual(B.seat('driver', 3, 240), [0xE4, 0x32, 3, 240]);
    assert.equal(B.exteriorTemp(96), 8);
    assert.equal(B.exteriorTemp(255), null);
    const cfg = { autoEnabled: true, belowTemp: 8, coldDwell: 0,
        wheelAuto: true, wheelMins: 3, seatDriver: false, seatPassenger: false };
    const planner = new ComfortAuto();
    const intents = planner.step({now: 100000, tempC: 5, tempAt: 100000, cfg});
    assert.deepEqual(intents.map(x => x.type), ['ON']);
    planner.acknowledge(intents[0], true, 100000);
    assert.deepEqual(planner.step({now: 280000, tempC: 5, tempAt: 100000, cfg})
        .map(x => x.type), ['OFF']);
});
