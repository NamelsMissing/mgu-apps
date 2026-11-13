'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../apps/g21_wheelheat/logic');

test('BDC_G05 D074 steering-wheel state uses ECU readback payload', () => {
    assert.deepEqual(B.decodeWheelReadback([1, 1, 37, 0, 1]), {
        on: true, led: true, currentAmps: 3.7, actuator: 0, coded: true,
    });
    assert.equal(B.decodeWheelReadback([0, 0]).on, false);
    assert.equal(B.decodeWheelReadback([0xff, 0xff]), null);
    assert.equal(B.decodeWheelReadback([]), null);
});

test('BDC_G05 E432/E430 seat state and level use ECU result fields', () => {
    assert.deepEqual(B.decodeSeatReadback([1, 2, 37, 87, 0, 0, 0, 0xfd, 0xfd]), {
        on: true, level: 2, cushionC: 37, backC: null,
        consumptionReduced: false, emergency: false, timedOut: false,
    });
    assert.equal(B.decodeSeatReadback([0, 0]).on, false);
    assert.equal(B.decodeSeatReadback([1, 0xff]), null);
    assert.equal(B.decodeSeatReadback([0x7f, 0]), null);
});

test('G05 manual steering wheel OFF/ON transitions display the latest BDC state', () => {
    const replies = [
        [0x62, 0xD0, 0x74, 0x00, 0x00, 0x00, 0x01, 0x01],
        [0x62, 0xD0, 0x74, 0x01, 0x00, 0x44, 0x02, 0x01],
        [0x62, 0xD0, 0x74, 0x01, 0x00, 0x43, 0x02, 0x01],
        [0x62, 0xD0, 0x74, 0x00, 0x00, 0x00, 0x01, 0x01],
    ];
    assert.deepEqual(replies.map(raw =>
        B.readbackLabel(B.decodeWheelReadback(raw.slice(3)), false)), [
        'OFF (BDC report)', 'ON  |  LED OFF', 'ON  |  LED OFF', 'OFF (BDC report)',
    ]);
    assert.equal(B.readbackLabel({ on: true, level: 3 }, true), 'ON  |  Level 3');
    assert.equal(B.readbackLabel(null, false), null);
});
