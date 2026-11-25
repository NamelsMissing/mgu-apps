'use strict';
// Offline end-to-end runs of the real main.js with simulated cars and mocked
// timers (no vehicle access). Nothing here proves behaviour on a real car.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('module');
const realDiag = require('../kit/runtime/diag');
const { frame } = require('../kit/runtime/gauges');
const { Display } = require('../kit/runtime/display');

const APP = path.join(__dirname, '../apps/g21_wheelheat');
const pos = (did, ...p) => [0x62, did >> 8, did & 255, ...p];
const nrc = c => [0x7F, 0x22, c];
const D701 = v => pos(0xD701, ...new Array(15).fill(0), v, ...new Array(9).fill(0));
const D8DB = (l, r) => pos(0xD8DB, ...Array.from({ length: 28 }, (_, i) => i === 19 ? l : i === 20 ? r : 0));
const T0 = Date.UTC(2026, 10, 18, 6, 0, 0);

const G21 = {
    '40:f150': pos(0xF150, 0x0F, 0x26, 0x80), '78:f150': pos(0xF150, 0x0F, 0x28, 0x30),
    '40:d074': pos(0xD074, 0, 0, 0, 1, 1),
    '40:e432': pos(0xE432, 0, 0, 20, 20, 0, 0, 0, 0, 0), '40:e430': pos(0xE430, 0, 0, 20, 20, 0, 0, 0, 0, 0),
    '40:e434': pos(0xE434, 1, 1, 0), '78:d8db': D8DB(0, 0),
};
const G05 = {
    '40:f150': pos(0xF150, 0x0F, 0x26, 0x80), '6d:f150': pos(0xF150, 0x0F, 0x21, 0xF0),
    '6e:f150': pos(0xF150, 0x0F, 0x21, 0xF0), '78:f150': pos(0xF150, 0x0F, 0x28, 0x30),
    '6d:d701': D701(2), '6e:d701': D701(2),
    '40:d074': pos(0xD074, 0, 0, 0, 1, 1), '40:e432': nrc(0x22), '40:e430': nrc(0x22), '40:e434': nrc(0x22),
    '6d:d714': pos(0xD714, 2, 31, 40, 29, 35, 0, 0, 0), '6e:d714': pos(0xD714, 0, 12, 0, 11, 0, 0, 0, 0),
    '78:d8db': D8DB(2, 0),
};

// --- harness -------------------------------------------------------------
function boot(t, car, settingsOverride, dir) {
    dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'wheelheat-main-'));
    const requests = [];
    const counts = {};
    const settingsFile = path.join(dir, 'settings.json');
    const values = Object.assign({ autoEnabled: true, belowTemp: 8, minVehicleOffMins: 30,
        wheelAuto: true, wheelMins: 3, seatDriver: true, seatPassenger: true,
        seatLevel: 3, seatMins: 4, testNextStartup: true },
    fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {}, settingsOverride || {});
    const listeners = [];
    const save = () => fs.writeFileSync(settingsFile, JSON.stringify(values));
    save();
    const settings = {
        file: settingsFile, loadSource: 'test', saveError: null, values,
        get: k => values[k],
        set(k, v) { values[k] = v; save(); listeners.forEach(fn => fn(k, v)); },
        setMany(c) { Object.assign(values, c); save(); },
        onChange: fn => listeners.push(fn),
    };
    const watchers = {}, clicks = {};
    let render = null, selectTab = null;
    let wheelUntil = null;
    class FakeDiag {
        constructor() { this.p = {}; this.available = true; }
        async init() {}
        async physical(addr, sid, data) {
            const did = (data[0] << 8) | data[1];
            requests.push({ addr, sid, did, data: Array.from(data), at: Date.now() });
            if (sid === 0x22) {
                const key = addr.toString(16) + ':' + did.toString(16);
                counts[key] = (counts[key] || 0) + 1;
                const r = car[key];
                if (typeof r === 'function') return (await r(counts[key])) || null;
                if (key === '40:d074' && wheelUntil !== null && r && r[0] === 0x62) {
                    return Date.now() < wheelUntil ? pos(0xD074, 1, 0, 0x44, 2, 1) : pos(0xD074, 0, 0, 0, 1, 1);
                }
                return r === undefined ? null : r;
            }
            if (sid === 0x2E) {
                const reply = car.write ? await car.write(addr, data) : [0x6E, data[0], data[1]];
                if (addr === 0x40 && did === 0xD074 && reply && reply[0] === 0x6E)
                    wheelUntil = Date.now() + data[2] * 1000;
                return reply;
            }
            return null;
        }
    }
    const stubs = {
        './kit/mgu': { run: d => { stubs.def = d; } },
        './kit/gauges': { frame, panel() {} },
        './kit/diag': Object.assign({}, realDiag, { Diag: FakeDiag }),
    };
    const original = Module._load;
    Module._load = function (request, parent, ...rest) {
        if (parent && parent.filename && parent.filename.startsWith(APP) && stubs[request])
            return stubs[request];
        return original.call(this, request, parent, ...rest);
    };
    for (const k of Object.keys(require.cache)) if (k.startsWith(APP)) delete require.cache[k];
    try { require(path.join(APP, 'main.js')); } finally { Module._load = original; }
    const drawn = [];
    const cv = { chrome: {}, clear() { return cv; }, fillRect() {}, text(s) { drawn.push(String(s)); }, image() {} };
    const ctx = {
        settings, dataDir: dir, app: { startReason: 'TEST' }, spec: { id: 'g21_wheelheat', version: 'test' },
        log: { info() {}, warn() {}, error() {} },
        signals: { watch: async (iface, _v, handlers) => { watchers[iface] = handlers; return { available: true }; } },
        ui: { onClick: (id, fn) => { clicks[id] = fn; }, onVisible() {}, isVisible: () => false,
            image() {}, onTouch() {}, onTap() {} },
        onTab(fn) { selectTab = fn; },
        loop: (_name, _fps, fn) => { render = fn; }, theme: () => ({}), canvas: () => cv,
    };
    const started = stubs.def.start(ctx);
    const events = () => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, 'heating_events.json'), 'utf8')); }
        catch (_) { return []; }
    };
    const signal = (iface, name, value) => watchers[iface] && watchers[iface][name] && watchers[iface][name](value);
    const tick = async (ms, ...otherApps) => {
        for (let done = 0; done < ms; done += 250) {
            for (const update of [signal, ...otherApps.map(app => app.signal)])
                update('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', { speedVehicleCentreOfGravity: 0 });
            t.mock.timers.tick(250);
            for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));
        }
    };
    const drive = async (tempRaw) => {
        signal('de.bmw.infrastructure.VehicleCondition', 'VehicleCondition', { statusConditionVehicle: 10 });
        signal('de.bmw.infrastructure.EnvironmentalInformation', 'ExteriorTemperature', { temperatureExterior: tempRaw });
    };
    const screen = tab => {
        drawn.length = 0;
        render();
        return drawn.slice();
    };
    const writes = () => requests.filter(r => r.sid === 0x2E);
    return { dir, values, settings, requests, writes, clicks, events, tick, drive, signal, screen, started,
        header: () => cv.chrome.tabs, selectTab: i => selectTab(i), kinds: k => events().filter(e => e.kind === k) };
}
function withTimers(t) { t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 }); }
const wrote = (app, did) => app.writes().filter(w => w.did === did);
const seatWrites = (app, addr) => wrote(app, 0xD714).filter(w => w.addr === addr);
const smfaSettings = { smfaDriverAuto: true, seatLevel: 2, wheelAuto: false };
const smbfSettings = { smbfPassengerAuto: true, seatLevel: 2, wheelAuto: false };

function renewableSeats(initialLevel = 0) {
    const seats = new Map([
        [0x6D, { level: initialLevel, expiresAt: Infinity }],
        [0x6E, { level: 0, expiresAt: Infinity }],
    ]);
    const seatReply = addr => {
        const seat = seats.get(addr);
        return pos(0xD714, Date.now() < seat.expiresAt ? seat.level : 0, 25, 0, 28, 0, 0, 0, 0);
    };
    const car = Object.assign({}, G05, {
        '6d:d714': () => seatReply(0x6D),
        '6e:d714': () => seatReply(0x6E),
        write(addr, data) {
            if (seats.has(addr)) seats.set(addr, { level: data[2], expiresAt: Date.now() + 120000 });
            return [0x6E, data[0], data[1]];
        },
        manualLevel(level, addr = 0x6D) { seats.set(addr, { level, expiresAt: Infinity }); },
    });
    return car;
}

// --- scenarios -----------------------------------------------------------
test('WheelHeat starts and navigates Comfort, Diagnostics, Log and native Settings', async t => {
    withTimers(t);
    const app = boot(t, G05, { autoEnabled: false, testNextStartup: false });
    await app.started;
    await app.tick(4000);
    const page = () => { app.screen(); return app.header().sel; };
    assert.equal(page(), 0);
    app.clicks.BTN_PAGE();
    assert.equal(page(), 1);
    app.clicks.BTN_PAGE();
    assert.equal(page(), 2);
    app.clicks.BTN_PAGE();
    assert.equal(page(), 0);

    const display = Object.assign(Object.create(Display.prototype), {
        own: () => true,
        screen: require(path.join(APP, 'app.json')).screens[0],
        tabInfo: app.header(),
        onTab: app.selectTab,
        log: { error: assert.fail },
        _click(id) {
            assert.equal(id, 'BTN_SETTINGS');
            this.sheet = { settings: true };
        },
        closeSheet() { this.sheet = null; },
    });
    assert.deepEqual(display._tabList().tabs, ['Comfort', 'Diagnostics', 'Log', 'Settings']);
    display._openTab(3);
    assert.equal(display._tabList().sel, 3);
    assert.equal(page(), 0, 'Settings is handled by the renderer');
    display._openTab(2);
    assert.equal(display.sheet, null);
    assert.equal(page(), 2);
    assert(app.screen().join('\n').includes('SWIPE UP/DOWN'));
    display._openTab(1);
    assert.equal(page(), 1);
    assert(app.screen().join('\n').includes('RE-DETECT ECUs'));
    display._openTab(0);
    assert.equal(page(), 0);
    app.selectTab(3);
    assert.equal(page(), 0, 'the app rejects an out-of-range page index');
});

test('G05: wheel automated, seats skipped, no seat write and no seat retries', async t => {
    withTimers(t);
    const app = boot(t, G05);
    await app.drive(93); // 6.5 C
    await app.tick(90000);
    assert(wrote(app, 0xD074).length >= 1, 'wheel ON via BDC');
    assert.equal(wrote(app, 0xE432).length + wrote(app, 0xE430).length, 0, 'no seat write');
    assert(!app.writes().some(w => w.addr !== 0x40), 'nothing written outside the BDC');
    assert.equal(app.kinds('START RETRY').filter(e => /seat/i.test(e.message)).length, 0);
    assert(app.kinds('SKIP').some(e => /Driver seat: seat-module/.test(e.message)));
    const profile = JSON.parse(app.values._ecuProfile);
    assert.equal(profile.routes.driver.route, 'seat-module');
    // Main screen: configured vs skipped vs confirmed.
    const main = app.screen().join('\n');
    assert.match(main, /Driver seat: skipped \(Seat module SMFA \(read-only\)\)/);
    assert.match(main, /Steering wheel: BDC ON +\| +6\.8 A/);
    // Diagnostics refresh: no BDC seat reads, module + IHKA once each.
    app.clicks.BTN_PAGE();
    const before = app.requests.length;
    app.clicks.BTN_ACTION();
    await app.tick(3000);
    const reads = app.requests.slice(before).filter(r => r.sid === 0x22);
    assert(!reads.some(r => r.did === 0xE432 || r.did === 0xE430), 'no pointless NRC 0x22 reads');
    assert.equal(reads.filter(r => r.did === 0xD8DB).length, 1, 'one shared IHKA snapshot');
    assert.equal(reads.filter(r => r.did === 0xD714).length, 2);
    const diag = app.screen().join('\n');
    assert.match(diag, /ON {2}\| {2}Level 2 {2}\(SMFA D714\)/);
    assert.match(diag, /OFF {2}\(SMBF D714\)/);
    assert.match(diag, /IHKA D8DB seat heat {2}left 2 {2}right 0/);
    assert.match(diag, /consistent: matches IHKA if driver sits left/);
    assert(app.kinds('READ SMFA').some(e =>
        /FAS_G11 22 D7 14 -> 62 D7 14 02 1F 28 1D 23 00 00 00 \[valid\] level=2/.test(e.message)));
    assert(app.kinds('READ IHKA').some(e =>
        /IHKA_G05 22 D8 DB -> 62 D8 DB( [0-9A-F]{2}){28} \[valid\] L=2 R=0/.test(e.message)));
    assert(!app.requests.some(r => r.did === 0xF190 || r.did === 0xF18C), 'no VIN / serial number');
});

for (const level of [1, 2, 3]) {
    test('both seat modules renew level ' + level + ' for the configured duration and send guarded OFF', async t => {
        withTimers(t);
        const app = boot(t, renewableSeats(), Object.assign({}, smfaSettings, smbfSettings,
            { wheelAuto: true, seatLevel: level }));
        await app.drive(93);
        await app.tick(25000);
        const screen = app.screen().join('\n');
        assert.match(screen, /Driver seat: SMFA ACK/);
        assert.match(screen, /Passenger seat: SMBF ACK/);
        assert.match(screen, /Steering wheel: BDC ON +\| +6\.8 A/);
        await app.tick(300000);
        assert.deepEqual(wrote(app, 0xD074).map(w => w.data[2]), [180, 0]);
        assert.deepEqual(wrote(app, 0xE432).concat(wrote(app, 0xE430)), []);
        assert.equal(wrote(app, 0xD714).length, 10);
        for (const addr of [0x6D, 0x6E]) {
            const writes = seatWrites(app, addr);
            assert.deepEqual(writes.map(w => w.data[2]), [level, level, level, level, 0]);
            assert.deepEqual(writes.map(w => w.at - writes[0].at), [0, 60000, 120000, 180000, 240000]);
            for (const w of writes) {
                assert.deepEqual(w.data, [0xD7, 0x14, w.data[2], 0, 0, 0, 0, 0, 0]);
                const prior = app.requests[app.requests.indexOf(w) - 1];
                assert.deepEqual([prior.addr, prior.sid, prior.did], [addr, 0x22, 0xD714]);
            }
        }
    });
}

test('SMBF can run independently and requires its own opt-in, route and live verification', async t => {
    withTimers(t);
    const enabled = boot(t, renewableSeats(), smbfSettings);
    const cases = [
        [renewableSeats(), { smbfPassengerAuto: false, smfaDriverAuto: true }],
        [renewableSeats(), { seatPassenger: false }],
        [Object.assign(renewableSeats(), { '40:e430': G21['40:e430'] }), {}],
        [Object.assign(renewableSeats(), { '6e:f150': n => n === 1 ?
            G05['6e:f150'] : pos(0xF150, 0x0F, 0x2C, 0xB0) }), {}],
        [Object.assign(renewableSeats(), { '6e:d701': n => D701(n === 1 ? 2 : 0) }), {}],
        [Object.assign(renewableSeats(), { '6e:d714': G05['6d:d714'] }), {}],
    ];
    const blocked = cases.map(([car, cfg]) => boot(t, car, Object.assign({}, smbfSettings, cfg)));
    for (const app of [enabled, ...blocked]) await app.drive(93);
    await enabled.tick(20000, ...blocked);
    assert.deepEqual(enabled.writes().map(w => [w.addr, w.did, w.data[2]]), [[0x6E, 0xD714, 2]]);
    for (const app of blocked) assert.deepEqual(seatWrites(app, 0x6E), []);
    assert.deepEqual(seatWrites(blocked[0], 0x6D).map(w => w.data[2]), [2]);
});

test('STOP checks both active modules and leaves a manually changed passenger level alone', async t => {
    withTimers(t);
    const car = renewableSeats();
    const app = boot(t, car, Object.assign({}, smfaSettings, smbfSettings));
    await app.drive(93);
    await app.tick(25000);
    car.manualLevel(1, 0x6E);
    app.clicks.BTN_STOP();
    await app.tick(90000);
    assert.deepEqual(seatWrites(app, 0x6D).map(w => w.data[2]), [2, 0]);
    assert.deepEqual(seatWrites(app, 0x6E).map(w => w.data[2]), [2]);
    assert(app.kinds('SMBF DIFFERENT').some(e => /D714 reports level 1/.test(e.message)));
});

test('disabling SMBF stops the passenger seat while SMFA continues its schedule', async t => {
    withTimers(t);
    const app = boot(t, renewableSeats(), Object.assign({}, smfaSettings, smbfSettings));
    await app.drive(93);
    await app.tick(25000);
    app.settings.set('smbfPassengerAuto', false);
    await app.tick(90000);
    assert.deepEqual(seatWrites(app, 0x6D).map(w => w.data[2]), [2, 2]);
    assert.deepEqual(seatWrites(app, 0x6E).map(w => w.data[2]), [2, 0]);
});

test('a rejected SMBF renewal stops only the passenger cycle', async t => {
    withTimers(t);
    const car = renewableSeats();
    const write = car.write;
    let passengerStarts = 0;
    car.write = (addr, data) => {
        if (addr === 0x6E && data[2] !== 0 && ++passengerStarts > 1) return [0x7F, 0x2E, 0x22];
        return write(addr, data);
    };
    const app = boot(t, car, Object.assign({}, smfaSettings, smbfSettings));
    await app.drive(93);
    await app.tick(165000);
    assert.deepEqual(seatWrites(app, 0x6D).map(w => w.data[2]), [2, 2, 2]);
    assert.deepEqual(seatWrites(app, 0x6E).map(w => w.data[2]), [2, 2, 0]);
    assert(app.kinds('SMBF REJECTED').some(e => /Passenger seat EXTEND/.test(e.message)));
});

test('SMFA stays read-only without opt-in, with invalid levels and on a conflicting route', async t => {
    withTimers(t);
    const cases = [
        [renewableSeats(), { smfaDriverAuto: false }],
        [renewableSeats(), { seatLevel: 0 }],
        [renewableSeats(), { seatLevel: 254 }],
        [Object.assign(renewableSeats(), { '40:e432': G21['40:e432'] }), {}],
        [Object.assign(renewableSeats(), { '6d:f150': pos(0xF150, 0x0F, 0x2C, 0xB0) }), {}],
    ];
    const apps = cases.map(([car, cfg]) => boot(t, car, Object.assign({}, smfaSettings, cfg)));
    for (const app of apps) await app.drive(93);
    await apps[0].tick(20000, ...apps.slice(1));
    for (const app of apps) assert.deepEqual(wrote(app, 0xD714), []);
});

test('SMFA needs a complete live OFF read and matching live coding before starting', async t => {
    withTimers(t);
    const apps = [
        renewableSeats(2),
        Object.assign(renewableSeats(), { '6d:d714': pos(0xD714, 0) }),
        Object.assign(renewableSeats(), { '6d:d701': n => D701(n === 1 ? 2 : 0) }),
    ].map(car => boot(t, car, smfaSettings));
    for (const app of apps) await app.drive(93);
    await apps[0].tick(20000, ...apps.slice(1));
    for (const app of apps) {
        assert.deepEqual(wrote(app, 0xD714), []);
        assert(app.kinds('START FAILED').some(e => /Driver seat/.test(e.message)));
    }
});

test('SMFA yields to a manual level change and leaves that level alone on STOP', async t => {
    withTimers(t);
    const car = renewableSeats();
    const app = boot(t, car, Object.assign({}, smfaSettings, { seatLevel: 1 }));
    await app.drive(93);
    await app.tick(20000);
    car.manualLevel(3);
    await app.tick(70000);
    app.clicks.BTN_STOP();
    await app.tick(300000);
    assert.deepEqual(wrote(app, 0xD714).map(w => w.data[2]), [1]);
    assert(app.kinds('SMFA DIFFERENT').some(e => /D714 reports level 3/.test(e.message)));
});

test('changing the configured SMFA level stops the acknowledged level for this ignition', async t => {
    withTimers(t);
    const app = boot(t, renewableSeats(), Object.assign({}, smfaSettings, { seatLevel: 3 }));
    await app.drive(93);
    await app.tick(20000);
    app.settings.set('seatLevel', 1);
    await app.tick(90000);
    assert.deepEqual(wrote(app, 0xD714).map(w => w.data[2]), [3, 0]);
});

test('disabling either SMFA or overall automation sends OFF for the app-owned activation', async t => {
    withTimers(t);
    const apps = ['smfaDriverAuto', 'autoEnabled', 'seatDriver'].map(key =>
        [key, boot(t, renewableSeats(), smfaSettings)]);
    for (const [, app] of apps) await app.drive(93);
    const [first, ...others] = apps.map(([, app]) => app);
    await first.tick(20000, ...others);
    for (const [key, app] of apps) app.settings.set(key, false);
    await first.tick(90000, ...others);
    for (const [, app] of apps) assert.deepEqual(wrote(app, 0xD714).map(w => w.data[2]), [2, 0]);
});

test('SMFA STOP during an in-flight ON handles the late ACK with a guarded OFF', async t => {
    withTimers(t);
    const car = renewableSeats();
    const write = car.write;
    let acknowledgeOn;
    car.write = (addr, data) => {
        const ack = write(addr, data);
        return data[2] === 2 ? new Promise(resolve => { acknowledgeOn = () => resolve(ack); }) : ack;
    };
    const app = boot(t, car, smfaSettings);
    await app.drive(93);
    await app.tick(20000);
    app.clicks.BTN_STOP();
    acknowledgeOn();
    await app.tick(90000);
    assert.deepEqual(wrote(app, 0xD714).map(w => w.data[2]), [2, 0]);
});

test('SMFA never retries an unconfirmed ON and stops after a rejected renewal', async t => {
    withTimers(t);
    const unknown = renewableSeats();
    const unknownWrite = unknown.write;
    unknown.write = (addr, data) => { unknownWrite(addr, data); return null; };
    const rejected = renewableSeats();
    const write = rejected.write;
    let onCount = 0;
    rejected.write = (addr, data) => data[2] === 2 && ++onCount > 1 ? [0x7F, 0x2E, 0x22] : write(addr, data);
    const app = boot(t, unknown, smfaSettings);
    const second = boot(t, rejected, smfaSettings);
    await app.drive(93);
    await second.drive(93);
    await app.tick(300000, second);
    assert.deepEqual(wrote(app, 0xD714).map(w => w.data[2]), [2]);
    assert.deepEqual(wrote(second, 0xD714).map(w => w.data[2]), [2, 2, 0]);
});

test('SMFA stops managing the seat when ignition ends or a suspension outlasts the ECU timer', async t => {
    withTimers(t);
    const car = renewableSeats();
    const app = boot(t, car, smfaSettings);
    const shutdown = boot(t, renewableSeats(), smfaSettings);
    await app.drive(93);
    await shutdown.drive(93);
    await app.tick(20000, shutdown);
    shutdown.signal('de.bmw.infrastructure.VehicleCondition', 'VehicleCondition', { statusConditionVehicle: 12 });
    t.mock.timers.setTime(Date.now() + 125000);
    car.manualLevel(2);
    await app.tick(150000, shutdown);
    assert.deepEqual(wrote(app, 0xD714).map(w => w.data[2]), [2]);
    assert.deepEqual(wrote(shutdown, 0xD714).map(w => w.data[2]), [2]);
});

test('SMFA silent at first, answers later: no seat write, route settles to seat-module', async t => {
    withTimers(t);
    const flaky = Object.assign({}, G05, { '6d:f150': n => n <= 2 ? undefined : G05['6d:f150'] });
    const app = boot(t, flaky);
    await app.drive(93);
    await app.tick(5000);
    let p = JSON.parse(app.values._ecuProfile);
    assert.equal(p.routes.driver.route, 'unresolved');
    assert.equal(p.complete, false);
    await app.tick(85000);
    p = JSON.parse(app.values._ecuProfile);
    assert.equal(p.routes.driver.route, 'seat-module', 'detected on the retry');
    assert.equal(p.complete, true);
    assert.equal(wrote(app, 0xE432).length, 0, 'driver seat never written while unresolved');
    assert(wrote(app, 0xD074).length >= 1, 'wheel not blocked');
});

test('G21 without seat modules: BDC seat heating still works after absence is confirmed', async t => {
    withTimers(t);
    const app = boot(t, G21);
    await app.drive(93);
    await app.tick(90000);
    const p = JSON.parse(app.values._ecuProfile);
    assert.deepEqual([p.routes.driver.route, p.routes.passenger.route], ['bdc', 'bdc']);
    assert(app.kinds('AUTO').some(e => /WAITING FOR CONTROL-UNIT DETECTION/.test(e.message)));
    assert(wrote(app, 0xD074).length >= 1);
    assert(wrote(app, 0xE432).length >= 1, 'driver seat ON via BDC');
    assert(wrote(app, 0xE430).length >= 1, 'passenger seat ON via BDC');
    const on = wrote(app, 0xE432)[0];
    assert.deepEqual(on.data.slice(0, 3), [0xE4, 0x32, 3], 'level 3 as configured');
    // Next start (own data dir with the saved settings, so the first
    // instance's still-running timers cannot interfere): profile reused
    // after one BDC identification read.
    const nextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wheelheat-main-'));
    fs.copyFileSync(path.join(app.dir, 'settings.json'), path.join(nextDir, 'settings.json'));
    const second = boot(t, G21, { testNextStartup: false }, nextDir);
    await second.tick(5000);
    const ids = second.requests.filter(r => r.did === 0xF150);
    assert.deepEqual(ids.map(r => r.addr), [0x40], 'only the BDC is re-identified');
    assert(second.kinds('ECU PROFILE').some(e => /BDC identity matches stored profile/.test(e.message)));
});

test('G21 seats can start after late detection in the same ignition while the wheel starts first', async t => {
    withTimers(t);
    const car = Object.assign({}, G21, {
        '6d:f150': nrc(0x25), '6e:f150': nrc(0x25),
        '40:e432': n => n <= 2 ? nrc(0x22) : G21['40:e432'],
    });
    const app = boot(t, car);
    await app.drive(93);
    await app.tick(35000);
    assert.equal(wrote(app, 0xD074).length, 1);
    assert.equal(wrote(app, 0xE432).length, 0);
    assert.equal(wrote(app, 0xE430).length, 1);
    assert.match(app.screen().join('\n'), /Driver seat: waiting for control unit/);
    // The first valid driver-seat response provides one run of absence evidence.
    await app.tick(65000);
    assert.equal(wrote(app, 0xE432).length, 1);
    assert.equal(wrote(app, 0xE430).length, 1);
    assert(wrote(app, 0xE432)[0].at > wrote(app, 0xE430)[0].at);
    assert.equal(wrote(app, 0xD714).length, 0);
});

test('wheel ACK with two OFF reads recovers once and keeps the original OFF time', async t => {
    withTimers(t);
    let starts = 0;
    const car = Object.assign({}, G21, {
        '40:d074': () => starts >= 2 ? pos(0xD074, 1, 0, 0x44, 2, 1) : G21['40:d074'],
        write(_addr, data) {
            if (data[0] === 0xD0 && data[1] === 0x74 && data[2] > 0) starts++;
            return [0x6E, data[0], data[1]];
        },
    });
    const app = boot(t, car, { seatDriver: false, seatPassenger: false });
    await app.drive(93);
    await app.tick(30000);
    const [first, retry] = wrote(app, 0xD074);
    assert.equal(starts, 2);
    assert.equal(first.data[2], 180);
    assert.equal(retry.data[2], 180 - Math.floor((retry.at - first.at) / 1000));
    assert.equal(app.kinds('WHEEL RECOVERY').length, 1);
    assert.match(app.screen().join('\n'), /Steering wheel: BDC ON +\| +6\.8 A/);
    await app.tick(180000);
    const writes = wrote(app, 0xD074);
    assert.equal(writes.length, 3);
    assert.equal(writes[2].data[2], 0);
    assert.equal(writes[2].at - first.at, 180000);
});

test('wheel ON with zero current is reported as such and does not trigger recovery', async t => {
    withTimers(t);
    const car = Object.assign({}, G21, { '40:d074': () => pos(0xD074, 1, 3, 0, 2, 1) });
    const app = boot(t, car, { seatDriver: false, seatPassenger: false });
    await app.drive(93);
    await app.tick(32000);
    assert.equal(wrote(app, 0xD074).length, 1);
    assert.equal(app.kinds('WHEEL RECOVERY').length, 0);
    assert.match(app.screen().join('\n'), /Steering wheel: BDC ON +\| +0\.0 A/);
});

test('wheel monitoring respects a later manual off and never repeats a failed recovery', async t => {
    withTimers(t);
    let manuallyOff = false;
    const manual = boot(t, Object.assign({}, G21, {
        '40:d074': n => n > 2 && !manuallyOff ? pos(0xD074, 1, 0, 0x44, 2, 1) : G21['40:d074'],
    }), { seatDriver: false, seatPassenger: false });
    const neverStarts = boot(t, Object.assign({}, G21, {
        '40:d074': () => G21['40:d074'],
    }), { seatDriver: false, seatPassenger: false });
    await manual.drive(93);
    await neverStarts.drive(93);
    await manual.tick(30000, neverStarts);
    assert.match(manual.screen().join('\n'), /Steering wheel: BDC ON/);
    manuallyOff = true;
    await manual.tick(60000, neverStarts);
    assert.equal(wrote(manual, 0xD074).length, 1);
    assert.equal(wrote(neverStarts, 0xD074).length, 2);
    assert.match(manual.screen().join('\n'), /Steering wheel: BDC OFF +\| +0\.0 A/);
});

test('only SMFA installed: passenger via BDC, driver skipped', async t => {
    withTimers(t);
    const car = Object.assign({}, G05, { '40:e430': G21['40:e430'] });
    delete car['6e:f150'];
    const app = boot(t, car);
    await app.drive(93);
    await app.tick(90000);
    assert.equal(wrote(app, 0xE432).length, 0);
    assert(wrote(app, 0xE430).length >= 1);
});

test('BDC seat readable AND seat module present: conflict, no seat write', async t => {
    withTimers(t);
    const car = Object.assign({}, G05, { '40:e432': G21['40:e432'], '40:e430': G21['40:e430'] });
    const app = boot(t, car);
    await app.drive(93);
    await app.tick(90000);
    const p = JSON.parse(app.values._ecuProfile);
    assert.deepEqual([p.routes.driver.route, p.routes.passenger.route], ['conflict', 'conflict']);
    assert.equal(wrote(app, 0xE432).length + wrote(app, 0xE430).length, 0);
    assert(wrote(app, 0xD074).length >= 1);
});

test('detection failing (BDC identity silent): no seat ON, wheel still allowed', async t => {
    withTimers(t);
    const car = Object.assign({}, G21);
    delete car['40:f150'];
    const app = boot(t, car);
    await app.drive(93);
    await app.tick(100000);
    assert.equal(app.values._ecuProfile, undefined, 'nothing stored');
    assert.equal(wrote(app, 0xE432).length + wrote(app, 0xE430).length, 0, 'no unsafe seat ON');
    assert(wrote(app, 0xD074).length >= 1, 'wheel through the normal BDC readback gate');
});

test('0.5.1 profile migration: stale "bdc-unverified" seat is re-detected, never written', async t => {
    withTimers(t);
    const v1 = { schema: 1, detectedAt: T0 - 86400000, appVersion: '0.5.1', complete: true,
        ecus: { BDC: { addr: 0x40, present: true, state: 'ok', index: '0F2680', nrc: null },
            SMFA: { addr: 0x6D, present: false, state: 'timeout', index: null, nrc: null },
            SMBF: { addr: 0x6E, present: true, state: 'ok', index: '0F21F0', nrc: null },
            IHKA: { addr: 0x78, present: true, state: 'ok', index: '0F2830', nrc: null } },
        reads: { wheel: { state: 'ok', payload: [0, 0, 0, 1, 1] }, driver: { state: 'nrc', nrc: 0x22 },
            passenger: { state: 'nrc', nrc: 0x22 }, seatCoded: { state: 'nrc', nrc: 0x22 } },
        routes: { wheel: { route: 'bdc' }, driver: { route: 'bdc-unverified' }, passenger: { route: 'seat-module' } } };
    const app = boot(t, G05, { _ecuProfile: JSON.stringify(v1) });
    await app.drive(93);
    await app.tick(90000);
    assert(app.kinds('ECU PROFILE').some(e => /migrated 0.5.1 profile/.test(e.message)));
    const p = JSON.parse(app.values._ecuProfile);
    assert.equal(p.schema, 2);
    assert.equal(p.routes.driver.route, 'seat-module');
    assert.equal(wrote(app, 0xE432).length, 0);
});

test('manual RE-DETECT ECUs runs a fresh detection', async t => {
    withTimers(t);
    const app = boot(t, G05, { testNextStartup: false });
    await app.tick(5000);
    const before = app.requests.filter(r => r.did === 0xF150).length;
    app.clicks.BTN_DETECT();
    await app.tick(5000);
    const after = app.requests.filter(r => r.did === 0xF150).length;
    assert(after - before >= 4, 'all candidates identified again');
    assert(app.kinds('ECU PROFILE').some(e => /manual re-detection requested/.test(e.message)));
});

test('unknown/invalid sources are never shown as OFF', async t => {
    withTimers(t);
    const car = Object.assign({}, G05, { '6d:d714': pos(0xD714, 255, 0, 0, 0, 0, 0, 0, 0),
        '78:d8db': undefined, '6e:d714': nrc(0x31) });
    const app = boot(t, car, { testNextStartup: false });
    await app.tick(5000);
    app.clicks.BTN_PAGE();
    app.clicks.BTN_ACTION();
    await app.tick(3000);
    const diag = app.screen();
    const driver = diag[diag.indexOf('Driver seat') + 1];
    const passenger = diag[diag.indexOf('Passenger seat') + 1];
    assert.doesNotMatch(driver, /OFF/);
    assert.doesNotMatch(passenger, /OFF/);
    assert.match(passenger, /Unavailable \(SMBF NRC 31\)/);
    assert(diag.some(s => /IHKA D8DB: no reply/.test(s)));
});

test('route changes during an active seat session: no EXTEND, own ON undone via BDC OFF', async t => {
    withTimers(t);
    const car = Object.assign({}, G21);
    const app = boot(t, car, { seatMins: 10, seatPassenger: false });
    await app.drive(93);
    await app.tick(60000);
    const ons = wrote(app, 0xE432);
    assert.equal(ons.length, 1, 'driver seat ON acknowledged');
    // A seat module appears (e.g. detection was wrong); user re-detects.
    car['6d:f150'] = G05['6d:f150'];
    car['6d:d701'] = G05['6d:d701'];
    app.clicks.BTN_DETECT();
    await app.tick(15000);
    assert(app.kinds('ROUTE CHANGED').some(e => /Driver seat: .*BDC OFF queued/.test(e.message)));
    const after = wrote(app, 0xE432).slice(1);
    assert(after.length >= 1, 'OFF sent');
    assert(after.every(w => w.data[2] === 0 && w.data[3] === 0), 'only OFF (level 0), never EXTEND');
    await app.tick(300000);
    assert(wrote(app, 0xE432).slice(1).every(w => w.data[2] === 0));
});
