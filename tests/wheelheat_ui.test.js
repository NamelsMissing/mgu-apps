'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../apps/g21_wheelheat/app.json');
const main = fs.readFileSync(path.join(__dirname, '../apps/g21_wheelheat/main.js'), 'utf8');

test('WheelHeat autostart uses a single explicit opt-in and honest diagnostic states', () => {
    assert.equal(app.version, '0.4.19');
    assert.equal(app.mguAppStartType, 'autostart');
    assert(!app.settings.some(s => s.key === 'liveControl'));
    assert.equal(app.settings.find(s => s.key === 'autoEnabled').default, false);
    assert(!('reset' in app.settings.find(s => s.key === 'autoEnabled')),
        'updates must preserve the previously saved consent');
    assert.match(main, /ctl\.autoWrite\(data/);
    assert.match(main, /HEATER STATUS SNAPSHOT/);
    assert(!main.includes('One automatic cycle'));
    assert(!main.includes('Last ECU action:'));
    assert(!main.includes('Live writes enabled'));
    assert.match(main, /decodeWheelReadback\(entry.payload\)/);
    assert.match(main, /decodeSeatReadback\(entry.payload\)/);
    assert.match(main, /B\.readbackLabel\(decoded, seat\)/);
    assert.doesNotMatch(main, /FLUCTUATING ECU READBACK|statusSamples/,
        'normal manual OFF/ON transitions must not be marked as unstable');
    assert.match(main, /ctx\.ui\.onClick\('BTN_STOP', stopAutoHeating\)/);
    assert.match(main, /ctx\.ui\.onVisible/);
    assert.match(main, /\[HEAT EVENT\]/);
    assert(app.screens[0].buttons.some(row => row[0] === 'BTN_STOP'));
    assert(app.screens[0].buttons.some(row => row[0] === 'BTN_LOG_UP'));
    assert(app.screens[0].buttons.some(row => row[0] === 'BTN_QR_REFRESH'));
    assert(app.settings.some(s => s.key === 'minVehicleOffMins'));
    assert(!app.settings.some(s => s.key === 'cycleRepeatMins'));
});
