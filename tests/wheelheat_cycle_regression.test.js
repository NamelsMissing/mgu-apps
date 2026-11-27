'use strict';
// 0.5.6 regression tests for vehicle-cycle detection. Offline only: these
// do not prove the MGU behaviour (os.uptime, autostart) on a real car.
const test = require('node:test');
const assert = require('node:assert/strict');
const Cycle = require('../apps/g21_wheelheat/cycle_policy');

const M = 60000, H = 60 * M;
const NOW = Date.UTC(2026, 10, 27, 14, 53, 51);
// Drive-ready heartbeat of yesterday evening's drive.
const lastDrive = { onAt: NOW - 20 * H, eligibleOnAt: 0, aliveAt: NOW - 19 * H };
const mk = (saved, reason, uptimeMs, opts = {}) => new Cycle.VehicleCycle(saved, opts.off || 10, !!opts.test,
    { startReason: reason, uptimeMs: () => (typeof uptimeMs === 'function' ? uptimeMs() : uptimeMs),
        processStartedAt: opts.processStartedAt || NOW - 3000 });

test('27 Nov log: ENTRY_POINT after a night parked, OFF never observed -> new cycle', () => {
    const c = mk(lastDrive, 'ENTRY_POINT', 90 * 1000);
    const r = c.observe(10, NOW);
    assert.equal(r.transition, 'on');
    assert(c.canStart(), c.reason);
    assert.match(c.reason, /NEW VEHICLE CYCLE: C: MGU boot gap/);
    assert(c.parkedMs >= 18 * H);
    assert.doesNotMatch(c.reason, /waiting for reliable cycle evidence/);
});

test('26 Nov log: AUTOSTART, first sample already drive-ready, no OFF recorded -> new cycle', () => {
    const c = mk(lastDrive, 'AUTOSTART', 40 * 1000);
    c.observe(10, NOW);
    assert(c.canStart(), c.reason);
});

test('AUTOSTART without MGU uptime still uses the process gap (D)', () => {
    const c = mk(lastDrive, 'AUTOSTART', null);
    c.observe(10, NOW);
    assert(c.canStart(), c.reason);
    assert.match(c.evidence, /^D/);
});

test('MGU wakes on unlock: OFF (Wohnen) seen after boot counts the time before the boot', () => {
    const c = mk(lastDrive, 'AUTOSTART', 20 * 1000);
    c.observe(5, NOW - 60000);
    c.observe(8, NOW);
    assert(c.canStart(), c.reason);
    assert(c.parkedMs > 18 * H, 'not just the 60 s since the wake');
});

test('MGU starts only after ignition ON and provider arrives late: periodic evaluation resolves', () => {
    let up = null;
    const c = mk(lastDrive, 'ENTRY_POINT', () => up);
    c.observe(10, NOW);
    assert(!c.canStart());
    assert.match(c.reason, /MGU uptime unavailable/);
    up = 60 * 1000;
    assert(c.evaluate(NOW + 5000), 'state changes without a new VehicleCondition event');
    assert(c.canStart(), c.reason);
});

test('MGU restart during the same drive does not start again', () => {
    const first = mk(lastDrive, 'AUTOSTART', 60 * 1000);
    first.observe(10, NOW);
    assert(first.canStart());
    first.channels['Steering wheel'] = 'confirmed';
    first.heartbeat(NOW + 20 * M);
    // MGU reboots 20 min into the drive (40 s down).
    const again = mk(first.snapshot(), 'AUTOSTART', 30 * 1000, { processStartedAt: NOW + 20 * M + 40000 });
    again.observe(10, NOW + 20 * M + 70000);
    assert(!again.canStart(), again.reason);
    assert.match(again.reason, /SAME JOURNEY/);
});

test('app restart inside the start window resumes only missing channels', () => {
    const first = mk(lastDrive, 'AUTOSTART', 60 * 1000);
    first.observe(10, NOW);
    first.channels['Steering wheel'] = 'sent';
    const resumed = mk(first.snapshot(), 'ENTRY_POINT', 120 * 1000);
    resumed.observe(10, NOW + 30000);
    assert(resumed.canStart());
    assert.equal(resumed.onAt, first.onAt);
    assert.equal(resumed.channels['Steering wheel'], 'sent', 'reserved channel stays reserved');
});

test('manual opening of the app late in a drive does not heat', () => {
    // MGU has been up for 40 minutes; app was not running before.
    const c = mk(lastDrive, 'ENTRY_POINT', 40 * M);
    c.observe(10, NOW);
    assert(!c.canStart());
    assert.match(c.missing, /MGU already running 40.0 min/);
});

test('ENTRY_POINT and AUTOSTART are treated the same when uptime proves a fresh boot', () => {
    for (const reason of ['ENTRY_POINT', 'AUTOSTART', 'UNKNOWN']) {
        const c = mk(lastDrive, reason, 50 * 1000);
        c.observe(10, NOW);
        assert(c.canStart(), reason + ': ' + c.reason);
    }
});

test('engine start-stop and readiness flicker do not create a new cycle', () => {
    const c = mk(lastDrive, 'AUTOSTART', 30 * 1000);
    c.observe(10, NOW);
    assert(c.consume());
    assert.equal(c.observe(8, NOW + M).changed, false);
    assert.equal(c.observe(undefined, NOW + 2 * M).changed, false);
    c.observe(12, NOW + 3 * M);
    c.observe(10, NOW + 3 * M + 5000);
    assert(!c.canStart(), 'readiness 12 is not OFF');
});

test('corrupt or outdated persisted data never blocks forever and never fakes a cycle', () => {
    const bad = mk({ offAt: 'x', onAt: -5, aliveAt: 1.5, channels: 'nope' }, 'ENTRY_POINT', 30 * 1000);
    assert.match(bad.loadNotes.join(), /offAt invalid/);
    bad.observe(10, NOW);
    assert(!bad.canStart(), 'no history is not proof of parking');
    assert.match(bad.missing, /no drive-ready heartbeat/);
    // Older (0.5.5) journal without heartbeat but with an observed OFF.
    const legacy = mk({ onAt: NOW - 20 * H, offAt: NOW - 19 * H }, 'ENTRY_POINT', 30 * 1000);
    legacy.observe(10, NOW);
    assert(legacy.canStart(), legacy.reason);
    // A future timestamp from a broken clock does not pin the state.
    const future = mk({ ...lastDrive, offAt: NOW + 400 * H }, 'ENTRY_POINT', 30 * 1000);
    future.observe(10, NOW);
    assert(future.canStart(), future.reason);
    assert.equal(mk(null, 'X', null).offAt, 0);
    assert.equal(mk([1, 2], 'X', null).offAt, 0);
});

test('a heartbeat during the drive does not erase the evidence of the current decision', () => {
    let up = null;
    const c = mk(lastDrive, 'ENTRY_POINT', () => up);
    c.observe(10, NOW);
    assert(c.heartbeat(NOW + 1000));
    up = 70 * 1000;
    c.evaluate(NOW + 2000);
    assert(c.canStart(), c.reason);
});

test('manual cancel survives restarts; parking too short stays blocked; missing info is reported', () => {
    const c = mk(lastDrive, 'AUTOSTART', 30 * 1000);
    c.observe(10, NOW);
    assert(c.cancel());
    const restarted = mk(c.snapshot(), 'AUTOSTART', 60 * 1000);
    restarted.observe(10, NOW + 30000);
    assert(!restarted.canStart());
    assert(!restarted.mayContinue());
    // Parked 5 minutes with MGU fully down.
    const shortStop = mk({ onAt: NOW - H, aliveAt: NOW - 5 * M }, 'AUTOSTART', 30 * 1000);
    shortStop.observe(10, NOW);
    assert(!shortStop.canStart());
    assert.match(shortStop.reason, /PARKING TIME NOT MET/);
    // Persistently unknown: no uptime, no heartbeat, not AUTOSTART.
    const unknown = mk({}, 'ENTRY_POINT', null);
    unknown.observe(10, NOW);
    for (let i = 1; i < 5; i++) unknown.evaluate(NOW + i * 1000);
    assert(!unknown.canStart());
    const d = unknown.diagnostics(NOW + 5000);
    assert.equal(d.state, 'UNKNOWN');
    assert.match(d.missing, /MGU uptime unavailable/);
    assert.match(d.missing, /no vehicle OFF ever observed/);
    assert.equal(d.nextEvaluation, 'every 1 s until resolved');
});

test('heartbeat is written at most once per minute and only while drive-ready', () => {
    const c = mk({}, 'AUTOSTART', null);
    assert(!c.heartbeat(NOW));
    c.observe(10, NOW);
    assert(c.heartbeat(NOW));
    assert(!c.heartbeat(NOW + 30000));
    assert(c.heartbeat(NOW + Cycle.HEARTBEAT_MS));
    assert.equal(c.snapshot().aliveAt, NOW + Cycle.HEARTBEAT_MS);
});
