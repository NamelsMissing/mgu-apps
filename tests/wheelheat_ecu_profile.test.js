'use strict';
// Control-unit detection, routes, decoding and persistence (ecu_profile.js).
// All replies are simulated; nothing here proves behaviour on a real car.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../apps/g21_wheelheat/ecu_profile');
const Cycle = require('../apps/g21_wheelheat/cycle_policy');

// Simulated car: map "addr:did" -> raw UDS reply. Missing key = timeout.
// A value may be a function (call count) -> reply, for flaky ECUs.
function car(replies) {
    const calls = [];
    const counts = {};
    const probe = async (addr, did) => {
        calls.push([addr, did]);
        const key = addr.toString(16) + ':' + did.toString(16);
        counts[key] = (counts[key] || 0) + 1;
        let r = replies[key];
        if (typeof r === 'function') r = r(counts[key]);
        return r === undefined ? null : r;
    };
    return { probe, calls, counts };
}
const pos = (did, ...payload) => [0x62, did >> 8, did & 255, ...payload];
const nrc = code => [0x7F, 0x22, code];
const S = 1000;
const D701 = v => pos(0xD701, ...new Array(15).fill(0), v, ...new Array(9).fill(0));
const D8DB = (l, r, len) => pos(0xD8DB, ...Array.from({ length: len || 28 }, (_, i) => i === 19 ? l : i === 20 ? r : 0));

// G21 318d: no seat modules, seat heating via BDC.
const G21 = {
    '40:f150': pos(0xF150, 0x0F, 0x26, 0x80),
    '78:f150': pos(0xF150, 0x0F, 0x28, 0x30),
    '40:d074': pos(0xD074, 0, 0, 0, 1, 1),
    '40:e432': pos(0xE432, 0, 0, 20, 20, 0, 0, 0, 0, 0),
    '40:e430': pos(0xE430, 0, 0, 20, 20, 0, 0, 0, 0, 0),
    '40:e434': pos(0xE434, 1, 1, 0),
};
// G05 from issue #2: SM2 comfort seats, BDC seat DIDs answer NRC 0x22.
const G05 = {
    '40:f150': pos(0xF150, 0x0F, 0x26, 0x80),
    '6d:f150': pos(0xF150, 0x0F, 0x21, 0xF0),
    '6e:f150': pos(0xF150, 0x0F, 0x21, 0xF0),
    '78:f150': pos(0xF150, 0x0F, 0x28, 0x30),
    '6d:d701': D701(2), '6e:d701': D701(2),
    '40:d074': pos(0xD074, 1, 0, 0x44, 2, 1),
    '40:e432': nrc(0x22), '40:e430': nrc(0x22), '40:e434': nrc(0x22),
};
const routesOf = p => [p.routes.wheel.route, p.routes.driver.route, p.routes.passenger.route];

// Run detection like the app does: merge the previous profile of the same BDC.
async function runs(replies, times) {
    const c = car(replies);
    let p = null;
    for (const t of times) p = await E.detect(c.probe, { now: t, previous: p });
    return { p, c };
}

test('G21: seat modules must be confirmed absent before the BDC seat route is used', async () => {
    const c = car(G21);
    const first = await E.detect(c.probe, { now: 0 });
    assert.deepEqual(routesOf(first), ['bdc', 'unresolved', 'unresolved'], 'one silent run is no proof');
    assert.equal(first.complete, false);
    assert.equal(E.allows(first, 'Driver seat'), false);
    assert.equal(E.allows(first, 'Steering wheel'), true, 'wheel is not held back');
    const tooSoon = await E.detect(c.probe, { now: 5 * S, previous: first });
    assert.equal(tooSoon.routes.driver.route, 'unresolved', 'runs closer than 20 s count once');
    const second = await E.detect(c.probe, { now: 25 * S, previous: tooSoon });
    assert.deepEqual(routesOf(second), ['bdc', 'bdc', 'bdc']);
    assert.equal(second.complete, true);
    assert.equal(second.ecus.SMFA.presence, 'absent');
    assert.equal(E.allows(second, 'Driver seat'), true);
    // Confirmed absent modules are not polled again.
    const before = c.calls.length;
    await E.detect(c.probe, { now: 60 * S, previous: second });
    const again = c.calls.slice(before);
    assert(!again.some(([addr]) => addr === 0x6D || addr === 0x6E), 'no polling of absent seat modules');
});

test('G05: both seat modules, BDC seat NRC 0x22 -> wheel only', async () => {
    const { p } = await runs(G05, [0]);
    assert.equal(p.complete, true);
    assert.deepEqual(routesOf(p), ['bdc', 'seat-module', 'seat-module']);
    assert.equal(p.ecus.SMFA.sgbd, 'FAS_G11');
    assert.equal(p.ecus.SMBF.sgbd, 'BFS_G11');
    assert.equal(p.ecus.IHKA.sgbd, 'IHKA_G05');
    assert.equal(p.ecus.SMFA.seatHeatingCoded, '2-circuit');
    const cfg = { wheelAuto: true, seatDriver: true, seatPassenger: true };
    const notes = E.applyRoutes(cfg, p);
    assert.deepEqual(cfg, { wheelAuto: true, seatDriver: false, seatPassenger: false });
    assert.equal(notes.length, 2);
    assert.match(notes[0], /SMFA 0x6D installed/);
    assert.equal(E.readsBdcSeat(p, 'driver'), false, 'no pointless BDC seat read');
    assert.equal(E.readsBdcSeat(p, 'wheel'), true);
});

test('gateway NRC 25 needs two detection runs and valid BDC status before using BDC seats', async () => {
    const c = car(Object.assign({}, G21, {
        '6d:f150': nrc(0x25), '6e:f150': nrc(0x25), '40:e430': pos(0xE430, 0xff, 0xff),
    }));
    const first = await E.detect(c.probe, { now: 0 });
    assert.equal(first.ecus.SMFA.presence, 'unknown');
    assert.equal(first.ecus.SMFA.timeoutRuns, 1);
    const next = await E.detect(c.probe, { now: 25000, previous: first });
    assert.equal(next.routes.driver.route, 'bdc');
    assert.equal(next.routes.passenger.route, 'unresolved');
    assert.equal(next.ecus.SMBF.timeoutRuns, 0);
});

test('old gateway NRC 25 conflict is re-detected, an identified seat module is retained', async () => {
    const { p } = await runs(G21, [0, 25000]);
    p.ecus.SMFA = Object.assign({}, p.ecus.SMFA, { state: 'nrc', nrc: 0x25, presence: 'present', present: true });
    p.routes.driver = { route: 'conflict', allowsAuto: false };
    const migrated = E.load(E.serialize(p));
    assert.equal(migrated.complete, false);
    assert.equal(migrated.routes.driver.route, 'unresolved');
    assert.equal(migrated.ecus.SMFA.timeoutRuns, 0);
    assert.equal(migrated.routes.passenger.route, 'bdc');

    const first = (await runs(G05, [0])).p;
    const next = await E.detect(car(Object.assign({}, G05, {
        '6d:f150': nrc(0x25), '40:e432': G21['40:e432'],
    })).probe, { now: 25000, previous: first });
    assert.equal(next.ecus.SMFA.presence, 'present');
    assert.equal(next.ecus.SMFA.sgbd, 'FAS_G11');
    assert.equal(next.routes.driver.route, 'conflict');
});

test('reported fault: SMFA silent at first, answers later -> never stored as BDC route', async () => {
    const flaky = Object.assign({}, G05, { '6d:f150': n => n <= 2 ? undefined : G05['6d:f150'] });
    const c = car(flaky);
    const first = await E.detect(c.probe, { now: 0 });
    assert.equal(first.routes.driver.route, 'unresolved', 'previously bdc-unverified');
    assert.equal(first.routes.passenger.route, 'seat-module');
    assert.equal(first.complete, false, 'previously complete=true');
    assert.equal(E.reuseDecision(first, '0F2680').reuse, false, 'stored profile is not reused as final');
    assert.equal(E.reuseDecision(first, '0F2680').merge, true);
    const restored = E.load(E.serialize(first));
    const second = await E.detect(c.probe, { now: 40 * S, previous: restored });
    assert.equal(second.routes.driver.route, 'seat-module');
    assert.equal(second.complete, true);
});

test('only one seat module: each side is decided separately', async () => {
    const one = Object.assign({}, G05, { '40:e430': pos(0xE430, 0, 0, 20, 20, 0, 0, 0, 0, 0) });
    delete one['6e:f150'];
    delete one['6e:d701'];
    const { p } = await runs(one, [0, 30 * S]);
    assert.equal(p.routes.driver.route, 'seat-module');
    assert.equal(p.routes.passenger.route, 'bdc', 'SMBF absent after two runs, BDC E430 readable');
    assert.equal(E.allows(p, 'Driver seat'), false);
    assert.equal(E.allows(p, 'Passenger seat'), true);
});

test('BDC seat readable AND seat module present -> conflict, no automatic seat', async () => {
    const both = Object.assign({}, G05, { '40:e432': G21['40:e432'] });
    const { p } = await runs(both, [0]);
    assert.equal(p.routes.driver.route, 'conflict');
    assert.equal(p.routes.passenger.route, 'seat-module');
    assert.equal(p.complete, true, 'contradiction is a final answer; RE-DETECT can repeat it');
    assert.equal(E.allows(p, 'Driver seat'), false);
    assert.equal(E.readsBdcSeat(p, 'driver'), true, 'conflict keeps both sources visible');
});

test('modules absent but BDC seat NRC: unresolved (0x22) or unavailable (0x31)', async () => {
    const r22 = await runs(Object.assign({}, G21, { '40:e432': nrc(0x22) }), [0, 30 * S]);
    assert.equal(r22.p.routes.driver.route, 'unresolved');
    assert.equal(r22.p.complete, false, 'retry later');
    const r31 = await runs(Object.assign({}, G21, { '40:e430': nrc(0x31) }), [0, 30 * S]);
    assert.equal(r31.p.routes.passenger.route, 'unavailable');
    assert.equal(r31.p.routes.driver.route, 'bdc');
});

test('BDC asleep: no heating DID read, nothing allowed for seats, no absence evidence', async () => {
    const c = car({});
    const p = await E.detect(c.probe, { now: 0 });
    assert.equal(p.complete, false);
    assert.equal(p.routes.driver.route, 'unknown');
    assert.equal(p.ecus.SMFA.timeoutRuns, 0, 'silence while the BDC is silent proves nothing');
    assert(!c.calls.some(([, did]) => did !== 0xF150));
    assert.equal(E.allows(p, 'Steering wheel'), true);
    assert.equal(E.allows(p, 'Driver seat'), false);
});

test('busy/offline probe errors are not counted as timeouts', async () => {
    const replies = Object.assign({}, G21);
    const probe = async (addr, did) => {
        if (addr === 0x6D || addr === 0x6E) throw new Error('diagnostic channel busy');
        return replies[addr.toString(16) + ':' + did.toString(16)] || null;
    };
    let p = await E.detect(probe, { now: 0 });
    p = await E.detect(probe, { now: 60 * S, previous: p });
    assert.equal(p.ecus.SMFA.presence, 'unknown');
    assert.equal(p.routes.driver.route, 'unresolved');
});

test('no profile yet: seats are never planned, wheel is', () => {
    const cfg = { wheelAuto: true, seatDriver: true, seatPassenger: true };
    const notes = E.applyRoutes(cfg, null);
    assert.deepEqual(cfg, { wheelAuto: true, seatDriver: false, seatPassenger: false });
    assert.match(notes[0], /not detected yet/);
});

test('detection only reads: service 0x22, known addresses, never VIN', async () => {
    const c = car(G05);
    await E.detect(c.probe, { now: 0 });
    assert(!c.calls.some(([, did]) => did === 0xF190 || did === 0xF18C), 'no VIN or serial number');
    assert(c.calls.every(([addr]) => [0x40, 0x6D, 0x6E, 0x78].includes(addr)));
});

test('stored profile: reuse, BDC change, unreachable BDC', async () => {
    const { p } = await runs(G05, [0]);
    const loaded = E.load(E.serialize(p));
    assert.deepEqual(loaded, p);
    assert.deepEqual([E.reuseDecision(loaded, '0F2680').reuse, E.reuseDecision(loaded, '0F2680').verified], [true, true]);
    assert.equal(E.reuseDecision(loaded, '0F2590').reuse, false, 'other car / BDC -> fresh detection');
    assert.equal(E.reuseDecision(loaded, '0F2590').merge, false);
    const offline = E.reuseDecision(loaded, null);
    assert.deepEqual([offline.reuse, offline.verified], [true, false]);
    assert.equal(E.reuseDecision(null, '0F2680').reuse, false);
    for (const raw of [undefined, '', '{', '{"schema":99}', JSON.stringify({ schema: 2, ecus: {} }), 42])
        assert.equal(E.load(raw), null);
});

test('0.5.1 profile migration: silent seat module is no longer trusted', () => {
    // As stored by 0.5.1 on a car where SMFA happened to be silent.
    const v1 = { schema: 1, detectedAt: 1000, appVersion: '0.5.1', complete: true,
        ecus: { BDC: { addr: 0x40, present: true, state: 'ok', index: '0F2680', nrc: null },
            SMFA: { addr: 0x6D, present: false, state: 'timeout', index: null, nrc: null },
            SMBF: { addr: 0x6E, present: true, state: 'ok', index: '0F21F0', nrc: null, seatHeatingCoded: '2-circuit' },
            IHKA: { addr: 0x78, present: true, state: 'ok', index: '0F2830', nrc: null } },
        reads: { wheel: { state: 'ok', payload: [0, 0, 0, 1, 1] }, driver: { state: 'nrc', nrc: 0x22 },
            passenger: { state: 'nrc', nrc: 0x22 }, seatCoded: { state: 'nrc', nrc: 0x22 } },
        routes: { wheel: { route: 'bdc' }, driver: { route: 'bdc-unverified' }, passenger: { route: 'seat-module' } } };
    const m = E.load(JSON.stringify(v1));
    assert.equal(m.schema, 2);
    assert.equal(m.migratedFrom, 1);
    assert.equal(m.complete, false, 'always re-detected');
    assert.equal(m.routes.driver.route, 'unresolved');
    assert.equal(m.routes.passenger.route, 'seat-module');
    assert.equal(m.ecus.SMFA.timeoutRuns, 1, 'old silence counts as one run only');
    assert.equal(E.allows(m, 'Driver seat'), false);
    assert.equal(E.reuseDecision(m, '0F2680').merge, true);
});

test('D714 decoding: valid, partial, invalid and unknown variant', () => {
    assert.deepEqual(E.decodeModuleSeat([2, 31, 40, 29, 35, 0, 0, 0]),
        { level: 2, cushionC: 31, cushionPwm: 40, backC: 29, backPwm: 35, complete: true, issues: [] });
    const partial = E.decodeModuleSeat([1, 0x80, 255, 0xD0, 120]);
    assert.equal(partial.level, 1);
    assert.equal(partial.complete, false);
    assert.deepEqual([partial.cushionC, partial.cushionPwm, partial.backC, partial.backPwm], [null, null, null, null]);
    assert.deepEqual(partial.issues, ['cushion temp invalid', 'cushion PWM invalid', 'back temp implausible',
        'back PWM implausible', 'short reply 5/8 bytes']);
    assert.equal(E.decodeModuleSeat([255, 0, 0, 0, 0, 0, 0, 0]), null, '255 = invalid level');
    assert.equal(E.decodeModuleSeat([]), null);
    assert.equal(E.decodeModuleSeat([-40 & 255, 0, 0, 0, 0, 0, 0, 0]), null, 'level out of range');
});

test('D8DB decoding: bytes 19/20, invalid values, short reply', () => {
    assert.deepEqual(E.decodeIhkaSeats(D8DB(2, 0).slice(3)), { left: 2, right: 0, complete: true, issues: [] });
    const half = E.decodeIhkaSeats(D8DB(3, 255).slice(3));
    assert.deepEqual([half.left, half.right, half.complete], [3, null, false]);
    const short = E.decodeIhkaSeats(D8DB(1, 1, 21).slice(3));
    assert.deepEqual([short.left, short.complete, short.issues[0]], [1, false, 'short reply 21/28 bytes']);
    assert.equal(E.decodeIhkaSeats(D8DB(1, 1, 20).slice(3)), null, 'bytes 19/20 missing');
    assert.equal(E.decodeIhkaSeats(D8DB(255, 255).slice(3)), null);
});

test('seat sources: full replies, one shared D8DB, comparison without handedness guess', async () => {
    const replies = Object.assign({}, G05, {
        '6d:d714': pos(0xD714, 2, 31, 40, 29, 35, 0, 0, 0),
        '6e:d714': pos(0xD714, 0, 12, 0, 11, 0, 0, 0, 0),
        '78:d8db': D8DB(2, 0),
    });
    const c = car(replies);
    const p = await E.detect(c.probe, { now: 0 });
    const before = c.calls.length;
    const s = await E.readSeatSources(c.probe, p);
    const calls = c.calls.slice(before);
    assert.equal(calls.filter(([, did]) => did === 0xD8DB).length, 1, 'one D8DB for both seats');
    assert.equal(s.SMFA.raw, '62 D7 14 02 1F 28 1D 23 00 00 00', 'complete UDS reply incl. 62 + DID');
    assert.equal(s.SMFA.validity, 'valid');
    assert.equal(s.SMFA.addr, 0x6D);
    assert.equal(s.SMFA.index, '0F21F0');
    assert.equal(s.IHKA.length, 28);
    assert.equal(s.IHKA.raw.split(' ').length, 31);
    assert.deepEqual(s.comparison, { verdict: 'consistent', detail: 'matches IHKA if driver sits left' });
    const line = E.measurementLine('SMFA', s.SMFA);
    assert.match(line, /SMFA 0x6D FAS_G11 22 D7 14 -> 62 D7 14 02 1F 28 1D 23 00 00 00 \[valid\] level=2/);
    // Swapped -> right-hand drive fits; different -> differs.
    const swapped = E.compareSources({ SMFA: s.SMFA, SMBF: s.SMBF,
        IHKA: Object.assign({}, s.IHKA, { decoded: { left: 0, right: 2 } }) });
    assert.equal(swapped.detail, 'matches IHKA if driver sits right');
    const off = E.compareSources({ SMFA: s.SMFA, SMBF: s.SMBF,
        IHKA: Object.assign({}, s.IHKA, { decoded: { left: 3, right: 3 } }) });
    assert.equal(off.verdict, 'differs');
});

test('seat sources: NRC, timeout and unknown variants are kept raw, never decoded', async () => {
    const replies = Object.assign({}, G05, {
        '6d:f150': pos(0xF150, 0x0F, 0x99, 0x99), // unknown seat module index
        '78:f150': pos(0xF150, 0x0F, 0x77, 0x77), // unknown IHKA index
        '6d:d714': pos(0xD714, 2, 0, 0, 0, 0, 0, 0, 0),
        '6e:d714': nrc(0x31),
        '78:d8db': D8DB(1, 1),
    });
    const c = car(replies);
    const p = await E.detect(c.probe, { now: 0 });
    assert.equal(p.ecus.SMFA.sgbd, null);
    assert.equal(p.ecus.SMFA.index, '0F9999');
    assert.equal(p.ecus.SMFA.seatHeatingCoded, null);
    const s = await E.readSeatSources(c.probe, p);
    assert.equal(s.SMFA.decoded, null);
    assert.equal(s.SMFA.validity, 'raw-only (layout unknown)');
    assert.equal(s.SMFA.raw, '62 D7 14 02 00 00 00 00 00 00 00');
    assert.equal(s.SMBF.state, 'nrc');
    assert.match(E.measurementLine('SMBF', s.SMBF), /7F 22 31 \(NRC 0x31\) \[nrc\]/);
    assert.equal(s.IHKA.decoded, null, 'D8DB of an unknown IHKA is captured but not interpreted');
    assert.equal(s.IHKA.state, 'ok');
    assert.match(E.measurementLine('IHKA', s.IHKA), /idx 0F7777 22 D8 DB -> 62 D8 DB/);
    assert.equal(s.comparison.verdict, 'not comparable');
    const silent = await E.readSeatSources(car(Object.assign({}, replies, { '6d:d714': undefined })).probe, p);
    assert.match(E.measurementLine('SMFA', silent.SMFA), /NO REPLY \(timeout\) \[timeout\]/);
});

test('one-shot parking test can be armed at runtime and applies to one ignition only', () => {
    const M = 60000, t0 = 1e9;
    const c = new Cycle.VehicleCycle({}, 30, false);
    c.observe(10, t0);
    c.observe(5, t0 + M);
    assert.equal(c.armTest(), true);
    c.observe(10, t0 + 7 * M);
    assert.equal(c.canStart(), true, 'issue #2: 6 min parked must pass when armed');
    assert.match(c.reason, /ONE-SHOT TEST/);
    assert.equal(c.testBypass, false, 'consumed on that ignition');
    c.consume();
    c.observe(5, t0 + 8 * M);
    c.observe(10, t0 + 10 * M);
    assert.equal(c.canStart(), false, 'next short stop is blocked again');
});
