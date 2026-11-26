'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Cycle = require('../apps/g21_wheelheat/cycle_policy');
const { ComfortAuto } = require('../apps/g21_wheelheat/comfort_auto');

const M = 60000;
const start = 1000000000;

test('vehicle OFF time is a minimum parked duration, NEVER a drive-time repeat', () => {
    const c = new Cycle.VehicleCycle({}, 30, false);
    assert.equal(c.canStart(), false);
    assert.equal(c.observe(5, start).transition, 'off');
    c.observe(7, start + 20 * M);
    assert.equal(c.canStart(), false, '20 parked minutes not sufficient');
    assert.equal(c.observe(10, start + 50 * M).changed, false);
    assert.equal(c.canStart(), false, '30 more minutes driving must NOT re-arm');
    c.observe(5, start + 60 * M);
    c.observe(10, start + 70 * M);
    assert.equal(c.canStart(), false, '10 minutes parked not sufficient');
    c.observe(5, start + 80 * M);
    c.observe(7, start + 110 * M);
    assert.equal(c.canStart(), true, '30 minutes parked permits next cold ignition');
    assert.equal(c.consume(), true);
    assert.equal(c.canStart(), false, 'one cycle only per ignition');
    c.observe(10, start + 400 * M);
    assert.equal(c.canStart(), false, 'hours driving do not repeat');
});

test('manual cancel blocks this ignition but not a later eligible ignition', () => {
    const c = new Cycle.VehicleCycle({}, 30, false);
    c.observe(5, start);
    c.observe(7, start + 31 * M);
    assert.equal(c.canStart(), true);
    assert.equal(c.cancel(), true);
    assert.equal(c.mayContinue(), false);
    assert.equal(c.canStart(), false);
    const sameDrive = new Cycle.VehicleCycle(c.snapshot(), 30, false);
    sameDrive.observe(10, start + 33 * M);
    assert.equal(sameDrive.canStart(), false, 'restarting OAP does not undo cancel');
    c.observe(5, start + 40 * M);
    c.observe(7, start + 69 * M);
    assert.equal(c.canStart(), false);
    c.observe(5, start + 70 * M);
    c.observe(10, start + 100 * M);
    assert.equal(c.canStart(), true, 'new session after full OFF duration');
});

test('headunit restart, unknown signal, ambiguous readiness and missing OFF fail closed', () => {
    const c = new Cycle.VehicleCycle({}, 30, false);
    assert.equal(c.observe(10, start).transition, 'on');
    assert.equal(c.canStart(), false, 'ON alone is not evidence of parking');
    c.observe(5, start + 1 * M);
    c.observe(7, start + 35 * M);
    assert.equal(c.canStart(), true);
    const saved = c.snapshot();
    const restart = new Cycle.VehicleCycle(saved, 30, false);
    restart.observe(10, start + 36 * M);
    assert.equal(restart.canStart(), false, 'reopening GUI is not new ignition');
    c.observe(12, start + 36 * M);
    assert.equal(c.mode, 'unknown');
    assert.equal(c.canStart(), false);
    assert.equal(c.offAt, saved.offAt, 'readiness ending is not vehicle OFF');
    assert.equal(Cycle.condition(0), 'unknown');
    assert.equal(Cycle.condition('FAHREN'), 'on');
    assert.equal(Cycle.condition('WOHNEN'), 'off');
    const lateGuiOpen = new Cycle.VehicleCycle({ offAt: start, onAt: start - M }, 30, false);
    lateGuiOpen.observe(10, start + 100 * M);
    assert.equal(lateGuiOpen.canStart(), false,
        'old OFF plus late manual app launch must not look like 100 minutes parked');
});

test('one-shot test can bypass parking time but still needs an ON observation', () => {
    const c = new Cycle.VehicleCycle({}, 30, true);
    assert.equal(c.canStart(), false);
    c.observe(7, start);
    assert.equal(c.canStart(), true);
    assert.equal(c.consume(), true);
    assert.equal(c.canStart(), false);
    const restarted = new Cycle.VehicleCycle(c.snapshot(), 30, false);
    restarted.observe(7, start + M);
    assert.equal(restarted.canStart(), false);
});

test('STOP clears timers and does not emit another extension', () => {
    const c = new ComfortAuto();
    const cfg = { autoEnabled: true, belowTemp: 10, coldDwell: 0,
        wheelAuto: true, wheelMins: 10, seatDriver: true,
        seatPassenger: false, seatLevel: 3, seatMins: 10 };
    c.step({ now: start, tempC: 0, tempAt: start, cfg });
    assert.equal(c.active.size, 2);
    assert.deepEqual(c.cancel().sort(), ['Driver seat', 'Steering wheel']);
    assert.equal(c.active.size, 0);
    assert.deepEqual(c.step({ now: start + 240000, tempC: 0,
        tempAt: start, cfg }), [], 'no automatic restart/extension after cancel');
});

test('parked AUTOSTART assigns a cycle on the first ON and resumes the same session after a crash', () => {
    const times = { onAt: start - 30 * M, offAt: start - 15 * M, usedOnAt: start - 30 * M };
    const c = new Cycle.VehicleCycle(times, 10, false, true);
    assert(c.observe(10, start).changed);
    assert(c.canStart());
    assert.match(c.source, /persisted vehicle OFF/);
    c.channels['Driver seat'] = 'sent';
    const resumed = new Cycle.VehicleCycle(c.snapshot(), 10, false, true);
    resumed.observe(10, start + 30000);
    assert.equal(resumed.onAt, start);
    assert.equal(resumed.channels['Driver seat'], 'sent');
    assert(resumed.canStart(), 'other channels can still start within the original window');
    assert.equal(resumed.observe(8, start + 40000).changed, false, 'start-stop leaves the session intact');
    assert.equal(resumed.observe(undefined, start + 45000).changed, false);
    assert.equal(resumed.observe(10, start + 46000).changed, false);
    const late = new Cycle.VehicleCycle(resumed.snapshot(), 10, false, true);
    late.observe(10, start + 3 * M);
    assert(!late.canStart());
});

test('a manual launch, ambiguous wake, corrupt record or short stop cannot supply a cold start', () => {
    for (const [saved, autostart] of [
        [{ onAt: start - 30 * M, offAt: start - 15 * M }, false],
        [{ offAt: 'invalid', onAt: 'invalid' }, true],
        [{ offAt: start + M }, true],
        [{ offAt: start - M }, true],
        [{ offAt: start - 20 * M, lastActivationAt: start - M }, true],
    ]) {
        const c = new Cycle.VehicleCycle(saved, 10, false, autostart);
        c.observe(10, start);
        assert(!c.canStart());
    }
    const c = new Cycle.VehicleCycle({}, 10, false, true);
    c.observe(undefined, start);
    assert(!c.canStart());
    assert(!Cycle.driveReady(7));
    assert(!Cycle.driveReady('WOHNEN'));
    c.observe(5, start + M);
    c.observe(10, start + 11 * M);
    assert(c.canStart());
});
