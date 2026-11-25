'use strict';
// Behavior tests against a deterministic audio provider. No vehicle is contacted.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../../apps/equalizer/controls');
const { Audio, COMMAND, CAREQ, checked } = require('../../apps/equalizer/audio');
const { Storage } = require('../../apps/equalizer/storage');
const log = { warn() {}, info() {} };
let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
const point = (value, key) => ({ kind: 'system', entity: 0, key: key === undefined ? 30 : key, value });
function binding(id, key, lo, center, hi) {
    return C.learn(id || 'bass', [[point(center || 0, key)], [point(lo === undefined ? -12 : lo, key)], [point(hi || 12, key)], [point(center || 0, key)]], {});
}
function provider() {
    const state = { system: { 30: 0, 31: 0 }, sink: { 8: -2 }, car: { 9: 0 }, writes: [], failOn: null, clampOn: null, timeoutAfterWrite: null };
    const sig = {
        proxy: async (iface, instance) => ({ iface, instance }), on: async () => {}, watch: async () => ({}),
        call: async (p, method, args) => {
            const ok = (extra) => Object.assign({ amError: 0 }, extra);
            if (method === 'getListSystemProperties') return ok({ listSystemProperties: Object.keys(state.system).map((k) => ({ type: Number(k), value: state.system[k] })) });
            if (method === 'getListMainConnections') return ok({ listConnections: [] });
            if (method === 'getListMainSources') return ok({ listMainSources: [] });
            if (method === 'getListMainSinks') return ok({ listMainSinks: [{ sinkID: 7, name: 'Entertainment' }] });
            if (method === 'getListMainSinkSoundProperties') return ok({ listSoundProperties: Object.keys(state.sink).map((k) => ({ type: Number(k), value: state.sink[k] })) });
            if (method === 'getAllEQData') return Number(p.instance) === 1 ? ok({ eqDataSetArray: Object.keys(state.car).map((k) => ({ key: Number(k), data: state.car[k] })) }) : { amError: 8 };
            if (method === 'getEQData') return ok({ eqData: state.car[args.eqKey] });
            const prop = method === 'setEQData' ? { type: args.eqKey, value: args.eqData } : args.property || args.soundProperty;
            const map = method === 'setEQData' ? state.car : method === 'setSystemProperty' ? state.system : state.sink;
            state.writes.push({ method, args });
            if (state.failOn === prop.type && prop.value !== 0) return { amError: 2 };
            map[prop.type] = state.clampOn === prop.type && prop.value !== 0 ? prop.value - 1 : prop.value;
            if (state.timeoutAfterWrite === prop.type && prop.value !== 0) throw new Error('timeout');
            return ok({});
        },
    };
    return { state, sig };
}
async function main() {
    await test('learning requires one stable key across center/minimum/maximum/center', () => {
        const b = binding(); assert(C.validBinding(b)); assert.equal(b.key, 30); assert.equal(b.low, -12); assert.equal(b.high, 12);
        assert.throws(() => C.learn('bass', [[point(0)], [point(-12)], [point(12)], [point(1)]], {}), /Kein passender/);
        assert.throws(() => C.learn('bass', [[point(0)], [], [point(12)], [point(0)]], {}), /Werteliste/);
    });
    await test('ambiguous, duplicate and missing keys never become writable', () => {
        const shots = [0, -12, 12, 0].map((v) => [point(v), point(v, 31)]);
        assert.throws(() => C.learn('bass', shots, {}), /Mehrere/);
        assert.throws(() => C.learn('treble', [0, -12, 12, 0].map((v) => [point(v)]), { bass: binding() }), /bereits/);
        assert.throws(() => C.index([point(0), point(1)]), /doppelte/);
    });
    await test('inverted/asymmetric OEM ranges round-trip and remain within measured limits', () => {
        const b = binding('balance', 30, 120, 50, -20);
        assert.equal(b.direction, -1); assert.equal(C.rawFromNormalized(b, 1), -20); assert.equal(C.rawFromNormalized(b, -1), 120);
        [-1, -0.5, 0, 0.5, 1].forEach((n) => assert(Math.abs(C.normalized(b, C.rawFromNormalized(b, n)) - n) < 0.015));
        assert.equal(C.rawFromNormalized(b, 100), -20); assert.equal(C.normalized(b, 9999), null);
    });
    await test('built-in presets use learned controls and preserve balance/fader', () => {
        const bs = { bass: binding(), balance: binding('balance', 32), fader: binding('fader', 33) };
        assert.deepEqual(Object.keys(C.preset('bass', bs)), ['bass']); assert(C.preset('bass', bs).bass > 0);
    });
    await test('textual E_OK is a success, other named AudioManager errors still fail', async () => {
        assert.strictEqual(checked({ amError: 'E_OK' }).amError, 'E_OK');
        assert.throws(() => checked({ amError: 'E_NOT_POSSIBLE' }), /E_NOT_POSSIBLE/);
        const p = provider(), oldCall = p.sig.call;
        p.sig.call = async (...args) => {
            const reply = await oldCall(...args);
            if (reply.amError === 0) reply.amError = 'E_OK';
            return reply;
        };
        const a = new Audio(p.sig, log); await a.connect();
        const s = await a.snapshot();
        assert.equal(s.points.length, 4);
        assert(!s.errors.some((e) => /E_OK/.test(e)));
    });
    await test('discovery uses actual schema and starts without any write', async () => {
        const p = provider(), a = new Audio(p.sig, log); await a.connect();
        const s = await a.snapshot(); assert.equal(s.points.length, 4); assert.equal(p.state.writes.length, 0);
        assert(a.command.iface === COMMAND && a.car[1].iface === CAREQ); assert(s.errors.some((e) => /car:2/.test(e)));
    });
    await test('apply validates all targets, writes, and verifies the complete profile', async () => {
        const p = provider(), a = new Audio(p.sig, log); await a.connect();
        const b = { bass: binding(), treble: binding('treble', 31) };
        const result = await a.apply(b, { bass: 4, treble: -2 }, { bass: 0, treble: 0 });
        assert.equal(result.count, 2); assert.equal(p.state.system[30], 4); assert.equal(p.state.system[31], -2);
        assert.equal(a.writing, false);
    });
    await test('external changes and out-of-range values are rejected before writes', async () => {
        const p = provider(), a = new Audio(p.sig, log); await a.connect();
        await assert.rejects(a.apply({ bass: binding() }, { bass: 13 }, { bass: 0 }), /Ungültige/);
        p.state.system[30] = 1;
        await assert.rejects(a.apply({ bass: binding() }, { bass: 4 }, { bass: 0 }), /außerhalb/);
        assert.equal(p.state.writes.length, 0);
    });
    await test('provider rejection rolls back earlier changes and reports failure', async () => {
        const p = provider(), a = new Audio(p.sig, log); await a.connect(); p.state.failOn = 31;
        await assert.rejects(a.apply({ bass: binding(), treble: binding('treble', 31) }, { bass: 4, treble: 3 }, { bass: 0, treble: 0 }), /wiederhergestellt/);
        assert.equal(p.state.system[30], 0); assert.equal(p.state.system[31], 0);
    });
    await test('silent clamping and timeout-after-write trigger read-back-aware rollback', async () => {
        for (const option of ['clampOn', 'timeoutAfterWrite']) {
            const p = provider(), a = new Audio(p.sig, log); await a.connect(); p.state[option] = 30;
            await assert.rejects(a.apply({ bass: binding() }, { bass: 4 }, { bass: 0 }), /wiederhergestellt/);
            assert.equal(p.state.system[30], 0);
        }
    });
    await test('all three write adapters preserve exact parameter names', async () => {
        const p = provider(), a = new Audio(p.sig, log); await a.connect();
        const car = Object.assign(binding('eq100', 9), { kind: 'car', entity: 1, id: 'car:1:9' });
        const sink = Object.assign(binding('treble', 8), { kind: 'sink', entity: 7, id: 'sink:7:8' });
        await a.apply({ eq100: car, treble: sink }, { eq100: 2, treble: -1 }, { eq100: 0, treble: -2 });
        assert.deepEqual(p.state.writes[0], { method: 'setEQData', args: { eqData: 2, eqKey: 9 } });
        assert.deepEqual(p.state.writes[1], { method: 'setMainSinkSoundProperty', args: { sinkID: 7, soundProperty: { type: 8, value: -1 } } });
    });
    await test('failed restoration is explicitly reported rather than presented as restored', async () => {
        const p = provider(), call = p.sig.call;
        p.sig.call = async (px, method, args) => method === 'setSystemProperty' && args.property.type === 30 && args.property.value === 0
            ? { amError: 7 } : call(px, method, args);
        const a = new Audio(p.sig, log); await a.connect(); p.state.failOn = 31;
        await assert.rejects(a.apply({ bass: binding(), treble: binding('treble', 31) }, { bass: 4, treble: 3 }, { bass: 0, treble: 0 }),
            (e) => /Wiederherstellung unbestätigt/.test(e.message) && e.rollbackFailed.indexOf('bass') >= 0);
        assert.equal(p.state.system[30], 4);
    });
    await test('missing native audio services produce offline state without crash or writes', async () => {
        const a = new Audio({ proxy: async () => { throw new Error('missing'); } }, log); await a.connect();
        assert.equal((await a.snapshot()).points.length, 0); assert.equal(a.errors.length, 3);
    });
    await test('calibration/profile persistence survives restart and recovers from corrupt primary', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-eq-'));
        try {
            let s = new Storage(dir, log); s.update((v) => { v.bindings.bass = binding(); });
            s.update((v) => { v.profiles['1'] = { values: { bass: 2 }, bindingIds: { bass: 'measured' } }; });
            s = new Storage(dir, log); assert.equal(s.state.profiles['1'].values.bass, 2);
            fs.writeFileSync(s.file, '{broken'); s = new Storage(dir, log); assert(s.state.bindings.bass); assert(!s.state.profiles['1']);
            s.update((v) => { v.learning = { control: 'bass', shots: [[point(0)]] }; });
            assert.equal(new Storage(dir, log).state.learning.shots.length, 1);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    console.log(count + ' tests passed');
}
module.exports = { provider, binding };
if (require.main === module) main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
