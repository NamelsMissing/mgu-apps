'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../apps/g21_wheelheat/app.json');
const main = fs.readFileSync(path.join(__dirname, '../apps/g21_wheelheat/main.js'), 'utf8');

test('WheelHeat autostart and experimental seat-module control are opt-in', () => {
    const catalogEntry = require('../mgu-repo.json').components.find(entry => entry.id === app.id);
    assert.equal(app.version, catalogEntry.version);
    assert.equal(app.mguAppStartType, 'autostart');
    assert(!app.settings.some(s => s.key === 'liveControl'));
    assert.equal(app.settings.find(s => s.key === 'autoEnabled').default, false);
    assert.equal(app.settings.find(s => s.key === 'smfaDriverAuto').default, false);
    assert.equal(app.settings.find(s => s.key === 'smbfPassengerAuto').default, false);
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
    assert(app.screens[0].buttons.some(row => row[0] === 'BTN_SETTINGS'));
    assert(!app.screens[0].buttons.some(row => /QR/i.test(row.join(' '))));
    assert(app.settings.some(s => s.key === 'minVehicleOffMins'));
    assert(!app.settings.some(s => s.key === 'cycleRepeatMins'));
    assert(app.screens[0].buttons.some(row => row[0] === 'BTN_DETECT'), 're-detect button');
    assert.match(main, /E\.applyRoutes\(cfg, ecuProfile\)/, 'planner drops channels the car cannot heat via BDC');
    assert.match(main, /cycle\.armTest\(\)/, 'one-shot test can be armed while running');
});

test('packaged app only requires files the store build ships', () => {
    // kit/tools/build.py copies only top-level *.js (+ LICENSE/NOTICE etc.)
    // of the app folder into javascript/ and the kit into javascript/kit/.
    // A require of app.json crashed 0.5.0/0.5.1 at load time on the car.
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '../apps/g21_wheelheat');
    const shipped = new Set(fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => f === 'main.js' ? 'app.js' : f));
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of src.matchAll(/require\((['"])\.\/([^'"]+)\1\)/g)) {
            const target = m[2];
            if (target.startsWith('kit/')) continue;
            const file = target.endsWith('.js') ? target : target + (target.includes('.') ? '' : '.js');
            assert(shipped.has(file), f + ' requires ./' + target + ', which the build does not ship');
        }
    }
});
