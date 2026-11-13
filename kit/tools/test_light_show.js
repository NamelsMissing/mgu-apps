'use strict';
// Actuator-facing tests: independent PRG reference telegrams, abort ordering,
// timeouts, invalid vehicle state, persistence and recovery. No vehicle I/O.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const app = path.join(root, 'apps', 'light_show');
const P = require(path.join(app, 'protocol'));
const Guard = require(path.join(app, 'guard'));
const Journal = require(path.join(app, 'journal'));
const Engine = require(path.join(app, 'engine'));
const DiagnosticOutputs = require(path.join(app, 'diagnostic-outputs'));
const F = require(path.join(app, 'flm-control'));
// Test the transport as packaged, including the project's actual TASU frame
// decoder and reply correlator (build.py light_show before running this file).
const Link = require(path.join(root, 'dist', 'light_show', 'source', 'javascript', 'link'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const cfg = { pattern: 'double', lights: 'high', tempo: 100, seconds: 5 };
const tick = () => new Promise((r) => setImmediate(r));

function rig(o) {
    o = o || {}; let clock = 10000, pending = !!o.pending;
    const calls = [], state = { block: null };
    const journal = { value: o.record || null, pending: () => pending,
        mark: (index, control) => { calls.push('mark'); if (o.writeFail) throw Error('disk full'); assert.strictEqual(index, P.INDEX);
            journal.value = Object.assign({ index }, control); pending = true; },
        clear: () => { calls.push('clear'); pending = false; journal.value = null; } };
    const link = {
        index: P.INDEX, available: true,
        identify: async () => { calls.push('identify'); if (o.badIdentity) throw Error('Unsupported BDC'); },
        session: async () => { calls.push('session'); if (o.sessionFail) throw Error('session refused'); },
        set: async (output, on) => {
            calls.push(['set', output, on]); if (o.onSet) await o.onSet(output, on, r);
            if (o.setFail) throw Error('NRC 31');
        },
        timed: async (lights, ms) => {
            calls.push(['timed', lights, ms]); if (o.onTimed) await o.onTimed(lights, ms, r);
            if (o.timedFail || (ms === 0 && o.timedStopFail)) throw Error('timed NRC 22');
        },
        keepalive: async () => { calls.push('keepalive'); if (o.keepFail) throw Error('keepalive timed out'); },
        release: async () => { calls.push('release'); if (o.releaseFail) throw Error('release timed out'); },
        defaultSession: async () => { calls.push('default'); if (o.defaultFail) throw Error('default timed out'); },
        identifyFlm: async (side) => { calls.push(['flmIdentify', side]); if (o.badFlmIdentity) throw Error('Unsupported FLM'); },
        flmSession: async (side) => { calls.push(['flmSession', side]); if (o.flmSessionFail) throw Error('FLM session refused'); },
        flmStart: async (side, channel, pwm, seconds) => {
            calls.push(['flmStart', side, channel, pwm, seconds]); if (o.onFlmStart) await o.onFlmStart(side, channel, r);
            if (o.flmStartFail) throw Error('FLM start refused');
        },
        flmStop: async (side) => { calls.push(['flmStop', side]); if (o.flmStopFail) throw Error('FLM stop refused'); },
        flmDefaultSession: async (side) => { calls.push(['flmDefault', side]); if (o.defaultFail) throw Error('FLM default refused'); },
    };
    const engine = new Engine({ link, journal, guard: { reason: () => state.block }, now: () => clock,
        sleep: async (ms) => { clock += ms; if (o.onSleep) await o.onSleep(r); }, changed: () => {}, log: { info() {}, warn() {} } });
    const r = { engine, calls, link, state, journal, now: () => clock, advance: (ms) => { clock += ms; } }; return r;
}
function controls(r) { return r.calls.filter(Array.isArray); }

test('All 16 lamp commands and OEM release match the original PRG bytecode', () => {
    const e = require(path.join(app, 'protocol-evidence.json'));
    assert.strictEqual(e.captured.length, 17);
    for (const r of e.captured) {
        const actual = r.release ? [0x2F].concat(P.release())
            : [0x2F].concat(P.control(P.PAIRS[r.pair][/_L$/.test(r.output) ? 'left' : 'right'], r.on));
        assert.deepStrictEqual(actual, r.uds, r.output || 'OEM');
    }
    assert.deepStrictEqual(P.release(), [0xE3, 0xB5, 0, 0xFF]);
});
test('Unsupported light outputs and corrupt persisted settings are rejected', () => {
    [0xFE, 0x24, -1, 999].forEach((v) => assert.throws(() => P.control(v, 1)));
    assert.throws(() => P.control(7, 2));
    assert.throws(() => P.settings((k) => ({ pattern: 'double', lights: 'high', tempo: 1, duration: 5 })[k]));
});
test('Vehicle gate rejects missing, stale, invalid speed and N_OR_P', () => {
    let clock = 10000; const g = new Guard(() => clock);
    g.speedSub = { available: true }; g.gearSub = { available: true };
    assert(g.reason()); g.feedSpeed({ speedVehicleCentreOfGravity: 0 }); g.feedStage({ statusActualStageDrive: 1 });
    assert.strictEqual(g.reason(), null);
    g.feedSelection({ statusGearSelectionDrive: 4 }); assert(g.reason());
    g.feedSelection({ statusGearSelectionDrive: 'P' }); assert.strictEqual(g.reason(), null);
    g.feedSpeed({ speedVehicleCentreOfGravity: 64 }); assert.strictEqual(g.reason(), 'Vehicle must be stationary');
    g.feedSpeed({ speedVehicleCentreOfGravity: 65535 }); assert(g.reason());
    g.feedSpeed({ speedVehicleCentreOfGravity: 0 }); clock += 2501; assert(g.reason());
    g.feedSpeed({ speedVehicleCentreOfGravity: 0 }); g.gearSub.available = false; assert(g.reason());
});
test('Quiet gear notifications are retained while their provider stays available', () => {
    let clock = 10000; const g = new Guard(() => clock);
    g.speedSub = g.gearSub = { available: true };
    g.feedStage({ statusActualStageDrive: 'P' }); clock += 120000;
    g.feedSpeed({ speedVehicleCentreOfGravity: 0 }); assert.strictEqual(g.reason(), null);
    for (const v of ['NP', 4, 'INVALID', null]) { g.feedSelection({ statusGearSelectionDrive: v }); assert(g.reason()); }
});
test('Blocked start sends no diagnostics or actuator requests', async () => {
    const r = rig(); r.state.block = 'Select P'; await r.engine.start(cfg);
    assert.deepStrictEqual(r.calls, []); assert.strictEqual(r.engine.state, 'BLOCKED');
});
test('Unknown BDC identity sends no session or actuator requests', async () => {
    const r = rig({ badIdentity: true }); await r.engine.start(cfg);
    assert.deepStrictEqual(r.calls, ['identify']); assert.strictEqual(r.engine.state, 'ERROR');
});
test('A failed recovery journal write prevents all session and lamp changes', async () => {
    const r = rig({ writeFail: true }); await r.engine.start(cfg);
    assert.deepStrictEqual(r.calls, ['identify', 'mark']); assert.strictEqual(r.engine.state, 'ERROR');
});
test('Show completes in finite time, serializes keepalive and releases OEM before clearing journal', async () => {
    const r = rig(); await r.engine.start(cfg);
    assert(controls(r).length > 10); assert(r.calls.includes('keepalive'));
    assert.deepStrictEqual(r.calls.slice(-3), ['release', 'default', 'clear']);
    assert.strictEqual(r.journal.pending(), false); assert.strictEqual(r.engine.releaseConfirmed, true);
});
test('Six patterns only touch the selected pair and all finish with OEM release', async () => {
    for (const pattern of Object.keys(P.PATTERNS)) for (const lights of Object.keys(P.PAIRS)) {
        const r = rig(); await r.engine.start(Object.assign({}, cfg, { pattern, lights }));
        assert(controls(r).every((v) => [P.PAIRS[lights].left, P.PAIRS[lights].right].includes(v[1])));
        assert.deepStrictEqual(r.calls.slice(-3), ['release', 'default', 'clear']);
    }
});
test('STOP waits for the in-flight command, then releases before any new lamp command', async () => {
    let unlock, entered; const reached = new Promise((r) => { entered = r; });
    const r = rig({ onSet: () => new Promise((resolve) => { unlock = resolve; entered(); }) });
    const show = r.engine.start(cfg); await reached;
    const stopped = r.engine.stop('User stop'); await tick(); assert(!r.calls.includes('release'));
    unlock(); await stopped; await show;
    assert.strictEqual(controls(r).length, 1); assert.deepStrictEqual(r.calls.slice(-3), ['release', 'default', 'clear']);
});
test('P loss while a command is in flight prevents another ON and still releases', async () => {
    const r = rig({ onSet: async (output, on, r) => { r.state.block = 'Select P'; } });
    await r.engine.start(cfg); assert.strictEqual(controls(r).length, 1);
    assert.deepStrictEqual(r.calls.slice(-3), ['release', 'default', 'clear']);
});
test('Rejected lamp request is never retried and is followed by OEM release', async () => {
    const r = rig({ setFail: true }); await r.engine.start(cfg);
    assert.strictEqual(controls(r).length, 1); assert.strictEqual(r.engine.state, 'ERROR');
    assert.deepStrictEqual(r.calls.slice(-3), ['release', 'default', 'clear']);
});
test('Session refusal still attempts release and default-session return', async () => {
    const r = rig({ sessionFail: true }); await r.engine.start(cfg);
    assert.strictEqual(controls(r).length, 0); assert.deepStrictEqual(r.calls.slice(-3), ['release', 'default', 'clear']);
});
test('Keepalive failure stops the sequence and releases OEM', async () => {
    const r = rig({ keepFail: true }); await r.engine.start(cfg);
    assert(r.calls.includes('keepalive')); assert.strictEqual(r.engine.state, 'ERROR');
    assert.deepStrictEqual(r.calls.slice(-3), ['release', 'default', 'clear']);
});
test('Failed release keeps recovery pending, attempts default session and does not retry forever', async () => {
    const r = rig({ releaseFail: true, onSleep: async (r) => { r.engine.stop(); } });
    await r.engine.start(cfg); assert.strictEqual(r.calls.filter((v) => v === 'release').length, 1);
    assert.strictEqual(r.journal.pending(), true); assert.strictEqual(r.engine.releaseConfirmed, false);
    assert(r.calls.includes('default')); assert.strictEqual(r.engine.state, 'ERROR');
});
test('Default-session timeout keeps the recovery marker even when OEM acknowledged', async () => {
    const r = rig({ defaultFail: true }); await r.engine.start(cfg);
    assert.strictEqual(r.journal.pending(), true); assert.strictEqual(r.engine.state, 'ERROR');
});
test('Duplicate Start does not create a second conversation', async () => {
    let unlock; const r = rig({ onSet: () => new Promise((resolve) => { unlock = resolve; }) });
    const a = r.engine.start(cfg); const b = r.engine.start(cfg); assert.strictEqual(a, b);
    await tick(); r.engine.stop(); unlock(); await a;
    assert.strictEqual(r.calls.filter((v) => v === 'session').length, 1);
});
test('A pending marker blocks Start; explicit recovery re-identifies and only releases', async () => {
    const r = rig({ pending: true }); await r.engine.start(cfg); assert.deepStrictEqual(r.calls, []);
    await r.engine.stop(); assert.deepStrictEqual(r.calls, ['identify', 'release', 'default', 'clear']);
    assert.strictEqual(r.journal.pending(), false);
});
test('Slow diagnostics slow the pattern without queuing stale commands after duration expires', async () => {
    const r = rig({ onSet: async (output, on, r) => { r.advance(3000); } });
    await r.engine.start(cfg); assert.strictEqual(controls(r).length, 2);
    assert.deepStrictEqual(r.calls.slice(-3), ['release', 'default', 'clear']);
});
test('Real journal survives a process restart and corrupt records remain pending', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-show-'));
    try {
        const a = new Journal(dir); assert.strictEqual(a.pending(), false); a.mark(P.INDEX);
        const b = new Journal(dir); assert.strictEqual(b.pending(), true); b.clear();
        fs.writeFileSync(a.file, '{broken'); assert.strictEqual(new Journal(dir).pending(), true);
        assert.throws(() => new Journal(dir).mark('UNKNOWN'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function tasu(respond) {
    let receive; const requests = [];
    const emit = (ecu, uds) => receive({ errorCode: 0, udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)) });
    const signals = {
        proxy: async () => ({}), on: async (p, name, fn) => { receive = fn; },
        onAvailable: async (p, fn) => fn(true),
        call: async (p, name, args) => { requests.push(args); return respond(args, emit); },
    };
    const link = await new Link(signals, { info() {}, warn() {} }).init();
    return { link, requests };
}
test('Real TASU decoding ignores other ECUs and other DIDs before identifying BDC_G05', async () => {
    const r = await tasu((args, emit) => {
        emit(0x12, [0x62, 0xF1, 0x50, 0, 0, 0]);
        emit(0x40, [0x62, 0xF1, 0x90, 0, 0, 0]);
        setImmediate(() => emit(0x40, [0x62, 0xF1, 0x50, 0x0F, 0x26, 0x80]));
        return 'NO_ERROR';
    });
    await r.link.identify(); assert.strictEqual(r.link.index, P.INDEX);
    assert.strictEqual(r.requests[0].targetAddress, 0x40);
    assert.strictEqual(r.requests[0].serviceID, 0x22);
});
test('Real TASU transport rejects a different BDC variant and sends only the identity read', async () => {
    const r = await tasu((args, emit) => {
        setImmediate(() => emit(0x40, [0x62, 0xF1, 0x50, 0x0F, 0x22, 0x00])); return 'NO_ERROR';
    });
    await assert.rejects(r.link.identify(), /not supported/); assert.strictEqual(r.requests.length, 1);
});
test('Real TASU transport sends the PRG control-enable mask and surfaces BDC NRC31', async () => {
    const r = await tasu((args, emit) => { setImmediate(() => emit(0x40, [0x7F, 0x2F, 0x31])); return 'NO_ERROR'; });
    await assert.rejects(r.link.set(7, 1), /NRC 31/);
    assert.deepStrictEqual(Array.from(r.requests[0].udsData), [0xE3, 0xB5, 3, 7, 1, 0xC0]);
    assert.strictEqual(r.requests.length, 1);
});
test('Busy TASU verdict is surfaced without retrying or flooding the shared transport', async () => {
    const r = await tasu(() => 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED');
    await assert.rejects(r.link.request(0x2F, P.release()), /transport refused/); assert.strictEqual(r.requests.length, 1);
});

test('Manual normal-light acknowledgement clears only after identity and default-session success', async () => {
    const r = rig({ pending: true }); await r.engine.acknowledgeNormalLights();
    assert.deepStrictEqual(r.calls, ['identify', 'default', 'clear']);
    assert.strictEqual(r.engine.releaseConfirmed, false);
});
test('Manual acknowledgement cannot clear the lock while moving or on failed session return', async () => {
    const r = rig({ pending: true }); r.state.block = 'Moving';
    await assert.rejects(r.engine.acknowledgeNormalLights()); assert.deepStrictEqual(r.calls, []);
    const f = rig({ pending: true, defaultFail: true }); await f.engine.acknowledgeNormalLights();
    assert.strictEqual(f.journal.pending(), true); assert(!f.calls.includes('clear'));
});
test('Output snapshots are read only and their failure does not become physical success', async () => {
    const r = rig(); r.link.readOutputs = async () => { throw Error('read refused'); };
    await r.engine.start(cfg); assert.strictEqual(r.engine.outputSamples.length, 2);
    assert(r.engine.outputSamples.every((x) => x.error === 'read refused'));
    assert.strictEqual(r.engine.state, 'IDLE');
});
test('Original actuator error survives a failed cleanup', async () => {
    const r = rig({ setFail: true, releaseFail: true }); await r.engine.start(cfg);
    assert.strictEqual(r.engine.originalFault, 'NRC 31');
    assert(r.engine.note.includes('NRC 31')); assert(r.engine.note.includes('release timed out'));
});

const timedCfg = Object.assign({}, cfg, { route: 'timed' });
test('All 28 timed function telegrams match the independently executed PRG bytecode', () => {
    const rows = require(path.join(app, 'protocol-evidence.json')).timedFunction.captured;
    assert.strictEqual(rows.length, 28);
    for (const row of rows) assert.deepStrictEqual([0x2E].concat(P.timedControl(row.lights, row.durationMs)), row.uds);
    for (const ms of [-10, 1, 100.5, 2010, 327000, NaN, Infinity, '100']) assert.throws(() => P.timedControl('high', ms));
    for (const lights of ['constructor', '__proto__', 'brake', null]) assert.throws(() => P.timedControl(lights, 2000));
});
test('Timed settings use their own patterns and reject inherited object keys', () => {
    const values = { route: 'timed', timedPattern: 'triple', pattern: 'alternate', lights: 'high', tempo: '150', duration: '15' };
    assert.strictEqual(P.settings((k) => values[k]).pattern, 'triple');
    for (const change of [{ route: 'other' }, { timedPattern: 'alternate' }, { timedPattern: 'constructor' }, { lights: 'toString' }]) {
        const v = Object.assign({}, values, change); assert.throws(() => P.settings((k) => v[k]));
    }
    const spec = require(path.join(app, 'app.json'));
    assert.deepStrictEqual(spec.settings.map((s) => s.key), ['flmPwm', 'flmSeconds']);
});
test('Two-second function test sends one finite ON and its own stop without legacy IO commands', async () => {
    const r = rig(); const began = r.now(); await r.engine.testFunction('high');
    assert.deepStrictEqual(controls(r), [['timed', 'high', 2000], ['timed', 'high', 0]]);
    assert.deepStrictEqual(r.calls.slice(-3), [['timed', 'high', 0], 'default', 'clear']);
    assert.strictEqual(r.now() - began, 2000); assert(!r.calls.includes('release'));
    assert.strictEqual(r.engine.stopConfirmed, true); assert.strictEqual(r.engine.releaseConfirmed, false);
    assert(r.engine.note.includes('not verified'));
});
test('Every timed pattern uses finite pulses for the chosen function and stops within its deadline', async () => {
    for (const pattern of Object.keys(P.BOTH_PATTERNS)) for (const lights of Object.keys(P.FUNCTIONS)) {
        const r = rig(); const began = r.now(); await r.engine.start(Object.assign({}, timedCfg, { pattern, lights, tempo: 500 }));
        const cmds = controls(r); assert(cmds.length > 2);
        assert(cmds.every((c) => c[0] === 'timed' && c[1] === lights && (c[2] === 0 || c[2] === 500)));
        assert.strictEqual(r.now() - began, 5000); assert(!r.calls.includes('release'));
        assert.deepStrictEqual(r.calls.slice(-3), [['timed', lights, 0], 'default', 'clear']);
    }
});
test('Timed STOP waits for the in-flight ON and sends no later ON or legacy fallback', async () => {
    let unlock, entered; const reached = new Promise((r) => { entered = r; });
    const r = rig({ onTimed: (lights, ms) => ms ? new Promise((resolve) => { unlock = resolve; entered(); }) : undefined });
    const show = r.engine.start(timedCfg); await reached;
    const stopped = r.engine.stop(); await tick(); assert.strictEqual(controls(r).length, 1);
    unlock(); await show; await stopped;
    assert.deepStrictEqual(controls(r), [['timed', 'high', 100], ['timed', 'high', 0]]);
    assert.deepStrictEqual(r.calls.slice(-3), [['timed', 'high', 0], 'default', 'clear']);
});
test('Timed guard loss prevents further ON requests, and a blocked function test sends nothing', async () => {
    const r = rig({ onTimed: (lights, ms, r) => { if (ms) r.state.block = 'Select P'; } });
    await r.engine.start(timedCfg);
    assert.deepStrictEqual(controls(r), [['timed', 'high', 100], ['timed', 'high', 0]]);
    const blocked = rig(); blocked.state.block = 'Moving'; await blocked.engine.testFunction('high');
    assert.deepStrictEqual(blocked.calls, []);
});
test('Slow timed transport does not enqueue stale pulses or extend activation times', async () => {
    const r = rig({ onTimed: (lights, ms, r) => { if (ms) r.advance(3000); } });
    await r.engine.start(timedCfg);
    assert.deepStrictEqual(controls(r), [['timed', 'high', 100], ['timed', 'high', 0], ['timed', 'high', 100], ['timed', 'high', 0]]);
});
test('Rejected timed ON is not retried and cleanup never switches to the legacy IO protocol', async () => {
    const r = rig({ timedFail: true }); await r.engine.testFunction('high');
    assert.deepStrictEqual(controls(r), [['timed', 'high', 2000], ['timed', 'high', 0]]);
    assert.strictEqual(r.journal.pending(), true); assert.strictEqual(r.engine.state, 'ERROR');
    assert.strictEqual(r.engine.stopConfirmed, false); assert(!r.calls.includes('release')); assert(r.calls.includes('default'));
});
test('Rejected timed stop keeps its route-specific recovery lock despite a positive default session', async () => {
    const r = rig({ timedStopFail: true }); await r.engine.testFunction('drl');
    assert.strictEqual(r.journal.pending(), true); assert.strictEqual(r.journal.value.route, 'timed');
    assert.strictEqual(r.journal.value.lights, 'drl'); assert.strictEqual(r.engine.stopConfirmed, false);
    assert(r.engine.note.includes('Timed stop pending')); assert(r.calls.includes('default'));
});
test('Persisted timed recovery stops the saved function; a legacy marker still uses legacy return', async () => {
    for (const record of [{ route: 'timed', lights: 'fog' }, { index: P.INDEX }]) {
        const r = rig({ pending: true, record });
        await r.engine.testFunction('high'); assert.deepStrictEqual(r.calls, []);
        await r.engine.stop();
        assert.deepStrictEqual(r.calls, ['identify', record.route === 'timed' ? ['timed', 'fog', 0] : 'release', 'default', 'clear']);
    }
    for (const record of [{ corrupted: true }, { route: 'timed', lights: 'constructor' }, { route: 'unknown' }]) {
        const r = rig({ pending: true, record }); await r.engine.stop();
        assert.deepStrictEqual(r.calls, ['identify']); assert.strictEqual(r.journal.pending(), true);
    }
});
test('Real recovery journal retains the function across restart and rejects an invalid context', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-show-timed-'));
    try {
        const a = new Journal(dir); a.mark(P.INDEX, { route: 'timed', lights: 'drl' });
        const b = new Journal(dir); assert.strictEqual(b.value.route, 'timed'); assert.strictEqual(b.value.lights, 'drl');
        assert.throws(() => b.mark(P.INDEX, { route: 'timed', lights: 'constructor' }));
        b.clear(); assert.strictEqual(new Journal(dir).pending(), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Readback summaries decode PRG field offsets and never describe an LED measurement', () => {
    const output = [0x62, 0xE3, 0xB9].concat(new Array(9).fill(0)); output[3 + 7] = 1;
    assert.strictEqual(P.statusSummary(output, 'high'), 'BDC output L=1 R=0 (not an LED measurement)');
    const fn = [0x62, 0xD5, 0x42].concat(new Array(9).fill(0)); fn[3 + 5] = 1;
    assert.strictEqual(P.statusSummary(fn, 'high'), 'BDC light function=1 (not an LED measurement)');
    assert(P.statusSummary([0x62, 0xD5, 0x42], 'high').includes('missing'));
    assert.strictEqual(P.statusSummary(fn, 'constructor'), 'status unavailable');
});
test('Real TASU transport sends timed function and zero-duration stop with matching service responses', async () => {
    const r = await tasu((args, emit) => { setImmediate(() => emit(0x40, [0x6E, 0xD5, 0x42])); return 'NO_ERROR'; });
    await r.link.timed('high', 2000); await r.link.timed('high', 0);
    assert(r.requests.every((x) => x.targetAddress === 0x40 && x.serviceID === 0x2E));
    assert.deepStrictEqual(Array.from(r.requests[0].udsData), [0xD5, 0x42, 0, 5, 0, 200]);
    assert.deepStrictEqual(Array.from(r.requests[1].udsData), [0xD5, 0x42, 0, 5, 0, 0]);
});

test('Headlamp inspection only reads identities and known-variant mapping, preserving raw codes', async () => {
    const Headlamps = require(path.join(app, 'headlamps')); const calls = [];
    const rows = await Headlamps.read({ request: async (sid, data, release, address) => {
        calls.push([sid, data, address]);
        if (data[0] === 0xF1) return [0x62, 0xF1, 0x50, 0x0F, 0x26, address === 0x43 ? 0xC0 : 0xD0];
        return [0x62, 0xD9, 0xFC].concat(Array.from({ length: 14 }, (_, i) => i));
    } });
    assert.strictEqual(calls.length, 4); assert(calls.every((c) => c[0] === 0x22));
    assert.strictEqual(rows[0].highBeamRaw, '04 05 06 07 08 09 0A 0B 0C 0D');
    assert.strictEqual(rows[1].name, 'FLM02_R');
});
test('Unknown headlamp identities receive no mapping read or control command', async () => {
    const Headlamps = require(path.join(app, 'headlamps')); const calls = [];
    const rows = await Headlamps.read({ request: async (sid, data, release, address) => {
        calls.push([sid, data, address]); return [0x62, 0xF1, 0x50, 0, 0, 1];
    } });
    assert.strictEqual(calls.length, 2); assert(calls.every((c) => c[0] === 0x22 && c[1][0] === 0xF1));
    assert(rows.every((r) => !r.highBeamRaw && r.note.includes('not yet mapped')));
});
test('Headlamp transport rejects actuator requests and targets reads to the selected module', async () => {
    const r = await tasu((args, emit) => {
        setImmediate(() => emit(args.targetAddress, [0x62, 0xF1, 0x50, 0x0F, 0x26, 0xC0])); return 'NO_ERROR';
    });
    await assert.rejects(r.link.request(0x2E, [0xD5, 0x42], false, 0x43), /Unsupported FLM diagnostic/);
    assert.strictEqual(r.requests.length, 0);
    await r.link.request(0x22, [0xF1, 0x50], false, 0x43);
    assert.strictEqual(r.requests[0].targetAddress, 0x43);
});
test('Headlamp inspection is blocked while moving and preserves a pending recovery marker', async () => {
    const r = rig({ pending: true }); r.state.block = 'Moving'; await r.engine.inspectHeadlamps();
    assert.deepStrictEqual(r.calls, []); assert.strictEqual(r.journal.pending(), true);
    r.state.block = null; r.link.request = async () => [0x62, 0xF1, 0x50, 0, 0, 1];
    await r.engine.inspectHeadlamps(); assert.strictEqual(r.engine.headlamps.length, 2);
    assert.strictEqual(r.journal.pending(), true); assert.strictEqual(r.engine.state, 'BLOCKED');
    assert.deepStrictEqual(r.calls, []);
});

test('All 32 exterior BDC outputs are listed once, excluding unrestricted and cabin outputs', () => {
    const all = DiagnosticOutputs.GROUPS.flatMap((g) => g.lights);
    assert.strictEqual(all.length, 32);
    assert.strictEqual(new Set(all.map((x) => x[0])).size, 32);
    assert.deepStrictEqual([0x18, 0x19, 0x23].map((id) => DiagnosticOutputs.get(id).prg), ['BL_L', 'BL_R', 'BL_M']);
    assert.deepStrictEqual([0x0D, 0x10, 0x20].map((id) => DiagnosticOutputs.get(id).prg), ['FRA_V_L', 'FRA_Z_L', 'FRA_H_L']);
    for (const id of [0xFE, 0x26, 0x27, 0x36, 0x40, 0x00]) {
        assert.throws(() => DiagnosticOutputs.get(id));
        assert.throws(() => P.control(id, 1));
    }
    for (const [id] of all) assert.deepStrictEqual(P.control(id, 1), [0xE3, 0xB5, 3, id, 1, 0xC0]);
});
test('Hidden legacy diagnostic-output mapping remains in protocol for older recovery records', () => {
    const spec = require(path.join(app, 'app.json'));
    const buttons = spec.screens.flatMap((s) => s.items || []).map((x) => x[1]);
    assert(!spec.screens.some((s) => s.name.startsWith('OUTPUT_') && s.name !== 'OUTPUT_OBSERVE'));
    assert.strictEqual(buttons.filter((x) => x && x.startsWith('BTN_LAMP_')).length, 0);
    assert.strictEqual(DiagnosticOutputs.GROUPS.flatMap((g) => g.lights).length, 32);
});
test('Single-light test has one 750-ms ON, individual OFF, OEM release, then default session', async () => {
    for (const id of [0x07, 0x0D, 0x18, 0x19, 0x23, 0x20, 0x22]) {
        const r = rig(); const began = r.now();
        await r.engine.testOutput(id);
        assert.strictEqual(r.now() - began, 750);
        assert.deepStrictEqual(controls(r), [['set', id, 1], ['set', id, 0]]);
        assert.deepStrictEqual(r.calls.slice(-4), [['set', id, 0], 'release', 'default', 'clear']);
        assert.strictEqual(r.journal.pending(), false);
        assert.strictEqual(r.engine.control.outputId, id);
    }
});
test('Single-light STOP cancels waiting without another ON and still attempts OFF and OEM release', async () => {
    let stopNow = false; const r = rig({ onSleep: async () => { if (!stopNow) { stopNow = true; r.engine.stop('STOP pressed'); } } });
    await r.engine.testOutput(0x23);
    assert.deepStrictEqual(controls(r), [['set', 0x23, 1], ['set', 0x23, 0]]);
    assert.deepStrictEqual(r.calls.slice(-4), [['set', 0x23, 0], 'release', 'default', 'clear']);
});
test('A failed individual OFF or legacy OEM return retains the lock for manual light checking', async () => {
    const offFailed = rig({ onSet: (id, on) => { if (!on) throw Error('OFF refused'); } });
    await offFailed.engine.testOutput(0x18);
    assert.strictEqual(offFailed.journal.pending(), true);
    assert.strictEqual(offFailed.engine.state, 'ERROR');
    assert(offFailed.calls.includes('release'));
    assert(offFailed.calls.includes('default'));
    const rejectedReturn = rig({ releaseFail: true });
    await rejectedReturn.engine.testOutput(0x07);
    assert.deepStrictEqual(controls(rejectedReturn), [['set', 7, 1], ['set', 7, 0]]);
    assert.strictEqual(rejectedReturn.journal.pending(), true);
    assert.strictEqual(rejectedReturn.engine.stopConfirmed, false);
});
test('Persisted single-output recovery only performs OFF, release and default session', async () => {
    const r = rig({ pending: true, record: { route: 'single', outputId: 0x23 } });
    await r.engine.testOutput(0x07); assert.deepStrictEqual(r.calls, []);
    await r.engine.stop();
    assert.deepStrictEqual(r.calls, ['identify', ['set', 0x23, 0], 'release', 'default', 'clear']);
    const corrupted = rig({ pending: true, record: { route: 'single', outputId: 0xFE } });
    await corrupted.engine.stop();
    assert.deepStrictEqual(corrupted.calls, ['identify']);
    assert.strictEqual(corrupted.journal.pending(), true);
});
test('Single-output tests are rejected in movement and do not accept arbitrary identifiers', async () => {
    const r = rig(); r.state.block = 'Vehicle must be stationary';
    await r.engine.testOutput(0x18); assert.deepStrictEqual(r.calls, []);
    const b = rig(); await b.engine.testOutput(0xFE);
    assert.deepStrictEqual(b.calls, []);
    assert.strictEqual(b.engine.state, 'ERROR');
});
test('Real TASU transport serializes third-brake-light control via BDC, not a guessed FLM address', async () => {
    const r = await tasu((args, emit) => { setImmediate(() => emit(0x40, [0x6F, 0xE3, 0xB5, 0x03])); return 'NO_ERROR'; });
    await r.link.set(0x23, 1); await r.link.set(0x23, 0);
    assert(r.requests.every((x) => x.targetAddress === 0x40 && x.serviceID === 0x2F));
    assert.deepStrictEqual(Array.from(r.requests[0].udsData), [0xE3, 0xB5, 3, 0x23, 1, 0xC0]);
});

test('FLM02 OEM routine uses only the bounded channel START candidate and captured StopRoutine', () => {
    const spec = require(path.join(app, 'app.json'));
    assert.strictEqual(spec.version, '0.3.2');
    assert.deepStrictEqual(F.start(7), [0x01, 0xA5, 0x4B, 0x07, 60, 2]);
    assert.deepStrictEqual(F.start(7, 100, 5), [0x01, 0xA5, 0x4B, 0x07, 100, 5]);
    assert.strictEqual(F.isPermittedRoutine(F.start(7, 100, 5)), true);
    assert.deepStrictEqual(F.stop(), [0x02, 0xA5, 0x4B]);
    assert(F.isPermittedRoutine(F.start(15)) && F.isPermittedRoutine(F.stop()));
    for (const ch of [0, -1, 16, 255, '7', 0.5]) assert.throws(() => F.start(ch));
    for (const bytes of [[1, 0xA5, 0x4B, 7, 20, 255], [1, 0xA5, 0x4B, 0, 20, 1],
        [1, 0xA5, 0x4B, 7, 101, 1], [2, 0xA5, 0x4B, 7], [1, 0xD9, 0xFD]])
        assert.strictEqual(F.isPermittedRoutine(bytes), false);
});
test('FLM channel menu exposes exactly 15 individually selectable channels and both sides', () => {
    const spec = require(path.join(app, 'app.json'));
    const flm = spec.screens.find((s) => s.name === 'FLM_CHANNELS');
    assert(flm);
    const ids = flm.items.map((i) => i[1]).filter((s) => s && s.startsWith('BTN_FLM_CH_'));
    assert.strictEqual(ids.length, 15); assert.strictEqual(new Set(ids).size, 15);
    assert(spec.screens.find((s) => s.name === 'FLM_INDEX').items.some((i) => i[1] === 'BTN_FLM_LEFT'));
});
test('FLM test validates BDC and headlamp identity before saving recovery or sending any control', async () => {
    const badBdc = rig({ badIdentity: true }); await badBdc.engine.testFlm('left', 7);
    assert.deepStrictEqual(badBdc.calls, ['identify']);
    const badFlm = rig({ badFlmIdentity: true }); await badFlm.engine.testFlm('right', 8);
    assert.deepStrictEqual(badFlm.calls, ['identify', ['flmIdentify', 'right']]);
    const badChannel = rig(); await badChannel.engine.testFlm('left', 0);
    assert.deepStrictEqual(badChannel.calls, []);
});
test('Two-second FLM LED pulse stops with OEM StopRoutine, returns default and clears saved lock', async () => {
    for (const side of ['left', 'right']) {
        const r = rig(); const began = r.now(); await r.engine.testFlm(side, 7);
        assert.strictEqual(r.now() - began, 2000);
        assert.deepStrictEqual(r.calls, ['identify', ['flmIdentify', side], 'mark',
            ['flmSession', side], ['flmStart', side, 7, 60, 2], ['flmStop', side], ['flmDefault', side], 'clear']);
        assert.strictEqual(r.journal.pending(), false);
        assert.strictEqual(r.engine.stopConfirmed, true); assert.strictEqual(r.engine.releaseConfirmed, false);
        assert(!r.calls.includes('release') && !r.calls.includes('session'));
    }
});
test('FLM STOP while pulse is in flight waits then requests only OEM stop and default', async () => {
    let unlock, entered; const reached = new Promise((r) => { entered = r; });
    const r = rig({ onFlmStart: () => new Promise((resolve) => { unlock = resolve; entered(); }) });
    const started = r.engine.testFlm('left', 3); await reached;
    const stop = r.engine.stop('STOP pressed'); await tick();
    assert(!r.calls.some((c) => Array.isArray(c) && c[0] === 'flmStop'));
    unlock(); await Promise.all([started, stop]);
    assert.deepStrictEqual(r.calls.slice(-3), [['flmStop', 'left'], ['flmDefault', 'left'], 'clear']);
    assert.strictEqual(r.journal.pending(), false);
});
test('FLM rejected START still attempts StopRoutine and does not switch to BDC fallback', async () => {
    const r = rig({ flmStartFail: true }); await r.engine.testFlm('right', 12);
    assert.deepStrictEqual(r.calls.slice(-3), [['flmStop', 'right'], ['flmDefault', 'right'], 'clear']);
    assert.strictEqual(r.engine.state, 'ERROR');
    assert(!r.calls.includes('release'));
});
test('FLM failed StopRoutine retains recovery lock and recovery retries its own OEM stop only', async () => {
    const r = rig({ flmStopFail: true }); await r.engine.testFlm('left', 5);
    assert.strictEqual(r.journal.pending(), true);
    assert.strictEqual(r.engine.stopConfirmed, false);
    assert(r.engine.note.includes('FLM StopRoutine pending'));
    const recovery = rig({ pending: true, record: { route: 'flm', side: 'right', channel: 9 } });
    await recovery.engine.stop();
    assert.deepStrictEqual(recovery.calls, ['identify', ['flmIdentify', 'right'], ['flmStop', 'right'],
        ['flmDefault', 'right'], 'clear']);
});
test('Real TASU FLM transport requires verified module and refuses unbounded actuator requests', async () => {
    const r = await tasu((args, emit) => {
        let reply;
        const d = Array.from(args.udsData);
        if (args.serviceID === 0x22) reply = [0x62, 0xF1, 0x50, 0x0F, 0x26, 0xC0];
        else if (args.serviceID === 0x10) reply = [0x50, d[0]];
        else reply = [0x71, d[0], 0xA5, 0x4B];
        setImmediate(() => emit(args.targetAddress, reply)); return 'NO_ERROR';
    });
    await assert.rejects(r.link.flmStart('left', 7), /not identified/);
    assert.strictEqual(r.requests.length, 0);
    await r.link.identifyFlm('left'); await r.link.flmSession('left');
    await r.link.flmStart('left', 7); await r.link.flmStop('left'); await r.link.flmDefaultSession('left');
    assert(r.requests.every((r) => r.targetAddress === 0x43));
    assert.deepStrictEqual(r.requests.map((r) => r.serviceID), [0x22, 0x10, 0x31, 0x31, 0x10]);
    assert.deepStrictEqual(Array.from(r.requests[2].udsData), F.start(7));
    assert.deepStrictEqual(Array.from(r.requests[3].udsData), F.stop());
    await assert.rejects(r.link.request(0x31, [1, 0xA5, 0x4B, 7, 20, 255], false, 0x43), /Unsupported FLM diagnostic/);
});



test('FLM02 playlist and inline name/test controls are reachable without BDC light actions', () => {
    const spec=require(path.join(app,'app.json'));
    const ids=spec.screens.flatMap(s=>s.items.map(row=>row[1]));
    assert.strictEqual(new Set(ids).size,ids.length,'unique BMW RHMI component IDs');
    for(const no of ['BTN_START','BTN_FUNCTION_TEST','BTN_OUTPUTS','BTN_IDENTIFY','BTN_CUSTOM_1'])
        assert(!ids.includes(no),no);
    for(const yes of ['BTN_SHOW_SETUP','BTN_SHOW_PATTERN','BTN_SHOW_START','BTN_SHOW_PREVIEW',
        'BTN_SHOW_POOL','BTN_POOL_LEFT','BTN_POOL_RIGHT','BTN_POOL_CH_0F','BTN_POOL_ADD_PAUSE',
        'BTN_LABEL_HOME','BTN_LABEL_TEST','BTN_LABEL_STOP','BTN_LABEL_SAVE','BTN_EXPORT'])
        assert(ids.includes(yes),yes);
    assert.deepStrictEqual(spec.settings.map(s=>s.key),['flmPwm','flmSeconds']);
});
test('FLM02 show permits up to 30 distinct observed channels, preserves order, rejects noise and has 200ms timing',()=>{
    const {makePlan,DEFAULT,PULSE,GAP,fromOld,ShowConfig}=require(path.join(app,'flm-show'));
    const {ChannelLabels}=require(path.join(app,'channel-labels'));
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'light-show-playlist-'));
    try{
        const names=new ChannelLabels(dir),obs=[];
        for(const side of ['left','right'])for(let ch=1;ch<=15;ch++)
            obs.push({route:'flm',side,channel:ch,result:'visible, no unusual noise',cleanupConfirmed:true});
        obs.push({route:'flm',side:'right',channel:13,
            result:'unusual noise without visible light',cleanupConfirmed:true});
        names.set('left',7,'Fernlicht');
        assert.strictEqual(new ChannelLabels(dir).label('left',7),'Fernlicht');
        assert.strictEqual(names.allowed(obs,'right',13),false);
        assert(PULSE.includes(200)&&GAP.includes(100));
        const c=new ShowConfig(dir);
        c.set({playlist:['L7','R8','L5','OFF'],pattern:'custom',pulseMs:200,gapMs:100,cycles:1});
        let plan=c.plan(names,obs);
        assert.strictEqual(plan.pulseMs,200);
        assert.deepStrictEqual(plan.steps,[{left:7,right:null},{left:null,right:8},{left:5,right:null},{left:null,right:null}]);
        assert.throws(()=>makePlan({...c.state,playlist:['L7','R13']},names,obs),/not marked visible/);
        assert.throws(()=>makePlan({...c.state,playlist:['L7','L7']},names,obs),/duplicate/);
        assert.throws(()=>makePlan({...c.state,pattern:'triple',cycles:3,pulseMs:3000,
            playlist:['L7','R8','L5','L1','R1','L8','R5','R7','L3','R3','L4','R4']},names,obs),/too long/);
        c.toggle('L1',names,obs);assert(c.state.playlist.includes('L1'));
        c.toggle('L1',names,obs);assert(!c.state.playlist.includes('L1'));
        c.appendOff();assert.strictEqual(c.state.playlist.at(-1),'OFF');
        c.undo();assert.strictEqual(c.state.playlist.at(-1),'OFF');
        const all=[];
        for(const side of ['L','R'])for(let ch=1;ch<=15;ch++)
            if(!(side==='R'&&ch===13))all.push(side+ch);
        const thirty=all.concat(['R13']);
        assert.throws(()=>makePlan({...DEFAULT,playlist:thirty},names,obs),/not marked visible/);
        assert.strictEqual(makePlan({...DEFAULT,playlist:all,pulseMs:200,gapMs:100,cycles:1},
            names,obs).steps.length,29);
        const noNoise=obs.filter(x=>!(x.side==='right'&&x.channel===13&&x.result==='unusual noise without visible light'));
        assert.strictEqual(makePlan({...DEFAULT,playlist:thirty,pulseMs:200,gapMs:100,cycles:1},
            names,noNoise).steps.length,30);
        const migrated=fromOld({pattern:'alternate',left:7,right:8,pwm:60,seconds:1,
            gapMs:500,cycles:2,custom:['L5','R5','L7','R8']});
        assert.deepStrictEqual(migrated.playlist,['L5','R5','L7','R8']);
        assert.strictEqual(migrated.pulseMs,1000);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('200 ms FLM02 show requests finite ECU timeout and an early, serialized STOP',async()=>{
    const r=rig();
    await r.engine.playFlmShow({route:'flm_show',pattern:'custom',pwm:100,pulseMs:200,gapMs:100,
        steps:[{left:7,right:null},{left:null,right:8},{left:5,right:null}]});
    const starts=r.calls.filter(x=>Array.isArray(x)&&x[0]==='flmStart');
    assert.deepStrictEqual(starts,[['flmStart','left',7,100,1],
        ['flmStart','right',8,100,1],['flmStart','left',5,100,1]]);
    assert.strictEqual(r.now()-10000,900,'three 200ms windows plus dark gaps');
    const idx=r.calls.findIndex(x=>Array.isArray(x)&&x[0]==='flmStart');
    assert.deepStrictEqual(r.calls[idx+1],['flmStop','left']);
    assert(!r.calls.includes('release') && !r.calls.includes('session'));
    assert.strictEqual(r.journal.pending(),false);
});
test('FLM02 animation uses no BDC control, stops both sides and clears journal only after successful cleanup',async()=>{
    const r=rig();
    await r.engine.playFlmShow({route:'flm_show',pattern:'together',pwm:60,seconds:1,gapMs:500,
        steps:[{left:7,right:8},{left:1,right:5}]});
    const diagnostic = r.calls.filter(x=>Array.isArray(x));
    assert(diagnostic.some(x=>x[0]==='flmStart'&&x[1]==='left'&&x[2]===7));
    assert(diagnostic.some(x=>x[0]==='flmStart'&&x[1]==='right'&&x[2]===8));
    assert(!r.calls.includes('session')&&!r.calls.includes('release')&&!diagnostic.some(x=>x[0]==='set'));
    assert.deepStrictEqual(r.calls.slice(-5),[['flmStop','left'],['flmStop','right'],
        ['flmDefault','left'],['flmDefault','right'],'clear']);
    assert.strictEqual(r.journal.pending(),false);
});
test('Interrupted FLM02 two-sided sequence recovers both ECUs in the saved journal',async()=>{
    const r=rig({flmStopFail:true});await r.engine.playFlmShow({
        route:'flm_show',pattern:'alternate',pwm:60,seconds:1,gapMs:500,steps:[{left:7,right:null},{left:null,right:8}]
    });
    assert.strictEqual(r.journal.pending(),true);
    assert.strictEqual(r.engine.stopConfirmed,false);
    const recovery=rig({pending:true,record:{route:'flm_show',sides:['left','right'],pwm:60,seconds:1}});
    await recovery.engine.stop();
    assert.deepStrictEqual(recovery.calls,['identify',['flmIdentify','left'],['flmIdentify','right'],
        ['flmStop','left'],['flmStop','right'],['flmDefault','left'],['flmDefault','right'],'clear']);
});


test('OEM dark-stage is a user-guided read-only lighting preparation flow',()=>{
    const spec=require(path.join(app,'app.json'));
    const screen=spec.screens.find(s=>s.name==='DARK_PREP');
    assert(screen,'DARK_PREP missing');
    const ids=spec.screens.flatMap(s=>(s.items||[]).map(i=>i[1]));
    assert.strictEqual(ids.length,new Set(ids).size,'duplicate RHMI identifiers');
    assert(ids.includes('BTN_DARK_MAIN')&&ids.includes('BTN_DARK_SHOW'));
    assert(ids.includes('BTN_DARK_VERIFY_P')&&ids.includes('BTN_DARK_CONTINUE'));
    assert(ids.includes('BTN_DARK_IDENTIFY')&&ids.includes('BTN_DARK_BACK'));
    assert(!screen.items.some(i=>/turn all lights off automatically|force lights off/i.test(String(i[2]))));
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log('PASS ' + name); }
        catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
    }
    console.log((tests.length - failed) + '/' + tests.length + ' Light Show tests passed');
    process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
