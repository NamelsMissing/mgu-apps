'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BmwMusic, PLAYER } = require('../apps/equalizer/bmw_music');
const { ORIGINAL, PROCESSED } = require('../apps/equalizer/music_export');

const car = { sourceID: 87, sinkID: 7, mainConnectionID: 4, connectionState: 'CS_CONNECTED' };
const own = { sourceID: 21, sinkID: 7, mainConnectionID: 9, connectionState: 'CS_CONNECTED' };
const newcomer = { sourceID: 190, sinkID: 7, mainConnectionID: 19, connectionState: 'CS_CONNECTED' };
const ok = { amError: 'E_OK' }, ent = { EntError: 'OK' };

async function test(opts, verify) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-bmw-'));
    const calls = [], states = [];
    let links = [car], elapsed = 0, event;
    if (opts.foreign) links = [own];
    const signals = {
        async proxy(name, instance) {
            if (name !== PLAYER) { assert.equal(instance, '1'); return 'command'; }
            assert.equal(instance, 'OapGenericMedia');
            return { async getValue(name) {
                assert.equal(name, 'currentItemTime');
                if (opts.drop) links = [newcomer];
                if (!opts.stall) elapsed += 8000;
                return { elapsed, total: 32000 };
            } };
        },
        async on(p, name, fn) { assert.equal(name, 'playbackErrorEvent'); event = fn; },
        async call(p, name, args) {
            calls.push([name, args]);
            if (name === 'getListMainConnections') return { amError: 'E_OK', listConnections: links.slice() };
            if (name === 'getListMainSources') return {
                amError: 'E_OK', listMainSources: [
                    { name: 'CarPlayMedia', sourceID: car.sourceID },
                    { name: 'OAPGenericMedia', sourceID: own.sourceID }
                ]
            };
            if (name === 'getListMainSinks') return {
                amError: 'E_OK', listMainSinks: [{ name: 'MediaSink_Front', sinkID: own.sinkID }]
            };
            if (name === 'connect') {
                assert.equal(args.sinkID, own.sinkID);
                if (args.sourceID === car.sourceID) {
                    links = [car];
                    return { amError: 'E_OK', mainConnectionID: car.mainConnectionID };
                }
                assert.equal(args.sourceID, own.sourceID);
                if (opts.already) return { amError: 'E_ALREADY_EXISTS', mainConnectionID: own.mainConnectionID };
                if (opts.timeout) throw new Error('timeout');
                links = [own];
                if (opts.stopDuringConnect) music.stop();
                return { amError: 'E_OK', mainConnectionID: own.mainConnectionID };
            }
            if (name === 'disconnect') {
                assert.equal(args.mainConnectionID, own.mainConnectionID);
                links = opts.replaced ? [newcomer] : opts.autoRestore ? [car] : [];
                return ok;
            }
            if (name === 'playFile') {
                assert.equal(path.basename(args.path), opts.filtered ? PROCESSED : ORIGINAL);
                assert.equal(fs.statSync(args.path).mode & 0o777, 0o644);
                assert.equal(fs.statSync(path.dirname(args.path)).mode & 0o777, 0o711);
                const other = path.join(path.dirname(args.path), opts.filtered ? ORIGINAL : PROCESSED);
                assert.equal(fs.statSync(other).mode & 0o777, 0o600);
                if (opts.playerError) event();
                return opts.reject ? { EntError: 'NOT_SUPPORTED' } : ent;
            }
            if (name === 'sendButtonEvent') { assert.equal(args.button, 'STOP'); return ent; }
            throw new Error('Unexpected method ' + name);
        }
    };
    const music = new BmwMusic(signals, {
        tmp, canRun: () => !opts.moving, onState: (s) => states.push(s), wait: () => Promise.resolve(),
        async prepare(dir) {
            if (opts.prepareError) throw new Error('DSP offline');
            const original = path.join(dir, ORIGINAL), processed = path.join(dir, PROCESSED);
            fs.writeFileSync(original, 'A', { mode: 0o600 });
            fs.writeFileSync(processed, 'B', { mode: 0o600 });
            return { original, processed };
        }
    });
    try {
        const playback = music.start(opts.filtered);
        if (!opts.moving) assert.strictEqual(music.start(!opts.filtered), playback);
        await playback;
        assert.strictEqual(music.active, null);
        assert.deepStrictEqual(fs.readdirSync(tmp), []);
        verify({ calls, states, links });
    } finally { fs.rmdirSync(tmp); }
}
const methods = (calls) => calls.filter(([name]) => /^(connect|disconnect|playFile|sendButtonEvent)$/.test(name)).map(([name]) => name);

async function main() {
    for (const opts of [{}, { filtered: true }, { autoRestore: true }]) {
        await test(opts, ({ calls, states, links }) => {
            assert.deepStrictEqual(methods(calls), ['connect', 'playFile', 'sendButtonEvent', 'sendButtonEvent',
                'disconnect'].concat(opts.autoRestore ? [] : ['connect']));
            assert.deepStrictEqual(links, [car]);
            assert(states.some((s) => s.status === 'playing' && /unbestätigt/.test(s.detail)));
            assert.equal(states.pop().status, 'finished');
        });
    }
    for (const opts of [{ reject: true }, { playerError: true }, { stall: true }, { stopDuringConnect: true }]) {
        await test(opts, ({ calls, states, links }) => {
            assert.deepStrictEqual(links, [car]);
            assert(calls.some(([name]) => name === 'disconnect'));
            assert.equal(states.pop().status, opts.stopDuringConnect ? 'stopped' : 'error');
            assert.equal(calls.some(([name]) => name === 'playFile'), !opts.stopDuringConnect);
        });
    }
    await test({ replaced: true }, ({ calls, links }) => {
        assert.equal(methods(calls).filter((n) => n === 'connect').length, 1);
        assert.deepStrictEqual(links, [newcomer]);
    });
    await test({ drop: true }, ({ calls, links, states }) => {
        assert.deepStrictEqual(methods(calls), ['connect', 'playFile']);
        assert.deepStrictEqual(links, [newcomer]);
        assert.equal(states.pop().status, 'error');
    });
    for (const opts of [{ foreign: true }, { moving: true }, { prepareError: true }, { already: true }, { timeout: true }]) {
        await test(opts, ({ calls, states }) => {
            assert.deepStrictEqual(methods(calls), opts.already || opts.timeout ? ['connect'] : []);
            assert.equal(states.pop().status, 'error');
        });
    }
    console.log('PASS BMW WAV selection, permissions, lifecycle, cancellation, failure, previous source and foreign connection isolation');
}
main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
