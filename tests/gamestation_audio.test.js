'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const {PassThrough} = require('stream');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {spawn, spawnSync} = require('child_process');
const {AudioRoute, DEVICE} = require('../apps/mgu_gamestation/audio_route');
const {AudioOutput, PcmConverter, readFrontSource, HELPER} = require('../apps/mgu_gamestation/audio');

function checkPcm() {
    const pcm = new PcmConverter();
    const left = Float32Array.from([0, 0.5, -0.5, 0]);
    const right = Float32Array.from([0, 0, 0, 0]);
    const stereo = pcm.convert({rate: 48000, left, right}, 1);
    assert.strictEqual(stereo.length, 16);
    assert.strictEqual(stereo.readInt16LE(4), 16384);
    assert.strictEqual(stereo.readInt16LE(6), 0);
    assert.strictEqual(stereo.readInt16LE(8), -16383);
    pcm.reset();
    let samples = 0;
    for (let i = 0; i < 60; i++) {
        const block = pcm.convert({rate: 32000, left: new Float32Array(i % 3 === 0 ? 534 : 533).fill(1)}, 0.5);
        assert.strictEqual(block.readInt16LE(0), 16384);
        assert.strictEqual(block.readInt16LE(2), 16384);
        samples += block.length / 4;
    }
    assert.ok(Math.abs(samples - 48000) <= 1, 'resampling preserves long-term sample count');
    const pattern = Float32Array.from({length: 1600}, (_, i) => Math.sin(i / 19) * 0.95);
    const whole = new PcmConverter().convert({rate: 44100, left: pattern}, 1);
    const split = new PcmConverter();
    const segments = [pattern.subarray(0, 47), pattern.subarray(47, 546), pattern.subarray(546)];
    const stitched = Buffer.concat(segments.map(left => split.convert({rate:44100, left}, 1)));
    assert.strictEqual(whole.length, stitched.length, 'resampler retains phase across block lengths');
    for (let i = 0; i < whole.length; i += 2)
        assert.ok(Math.abs(whole.readInt16LE(i) - stitched.readInt16LE(i)) <= 1, 'split PCM matches a continuous stream');
    assert.throws(() => pcm.convert({rate: 100, left}, 1), /Invalid emulator PCM/);
    for (const count of [532, 580, 534]) {
        const timed = pcm.convert({rate: 32000, left: new Float32Array(count), frameSamples: 800}, 1);
        assert.strictEqual(timed.length, 3200, 'variable SNES DSP output stays aligned to a video frame');
    }
}

function checkOutput() {
    let clock = 1000, child, runs = 0, endpoint = '';
    const audio = new AudioOutput('/tmp', {readDevice: () => endpoint, now: () => clock, spawn(command, args) {
        assert.strictEqual(command, HELPER);
        assert.deepStrictEqual(args, ['test']);
        runs++;
        child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stderr = new PassThrough();
        child.stdout = new PassThrough();
        child.stdin.resume();
        child.kill = signal => {
            assert.strictEqual(signal, 'SIGTERM');
            child.onceKilled = true;
        };
        return child;
    }});
    const block = {rate: 48000, left: new Float32Array(800).fill(0.5)};
    audio.configure(true, 30);
    audio.setActive(true);
    audio.write(block);
    assert.strictEqual(runs, 0);
    assert.ok(/No explicit/.test(audio.diagnostics().error));
    audio.stop();
    endpoint = 'test';
    audio.setActive(true);
    audio.write(block);
    assert.strictEqual(runs, 1);
    child.stdout.write('{"bufferFrames":3072,"periodFrames":768,"pendingFrames":960,');
    child.stdout.write('"underruns":1,"droppedFrames":20}\n');
    assert.strictEqual(audio.diagnostics().underruns, 1);
    assert.strictEqual(audio.diagnostics().deviceMs, 20);
    assert.strictEqual(audio.diagnostics().bufferMs, 64);
    assert.strictEqual(audio.diagnostics().periodMs, 16);
    assert.strictEqual(audio.diagnostics().droppedFrames, 20);
    clock += 150;
    audio.write(block);
    assert.ok(child.onceKilled, 'flush audio on a stalled frame clock');
    assert.strictEqual(audio.diagnostics().overflows, 1);
    audio.write(block);
    assert.strictEqual(runs, 1, 'wait for old process to close');
    child.emit('close', null);
    audio.write(block);
    assert.strictEqual(runs, 2);
    audio.stop();
    assert.ok(child.onceKilled);
    child.emit('close', null);
    audio.write(block);
    assert.strictEqual(runs, 2, 'no output while paused or stopped');
    audio.setActive(true);
    audio.write(block);
    child.emit('error', new Error('no ALSA device'));
    child.emit('close', 1);
    audio.write(block);
    assert.strictEqual(runs, 3, 'no spawn storm for a missing device');
    assert.strictEqual(audio.diagnostics().error, 'no ALSA device');
    audio.configure(true, 0);
    audio.setActive(true);
    audio.write(block);
    assert.strictEqual(runs, 3, 'muted output leaves the device closed');
}

async function checkSource() {
    const methods = [];
    const data = {
        getListMainSources: {listMainSources: [{sourceID: 5, name: 'CarPlayMedia'}, {sourceID: 6, name: 'Radio'}]},
        getListMainSinks: {listMainSinks: [{sinkID: 9, name: 'MediaSink_Front'}]},
        getListMainConnections: {listConnections: [{sourceID: 5, sinkID: 9, connectionState: 2},
            {sourceID: 6, sinkID: 9, connectionState: 'CS_DISCONNECTED'}]},
    };
    const route = await readFrontSource({
        proxy: async (type, instance) => {
            assert.strictEqual(type, 'org.genivi.am.commandinterface.CommandControl');
            assert.strictEqual(instance, '1');
            return {};
        },
        call: async (_, name) => {
            methods.push(name);
            assert.ok(data[name], 'AudioManager stays read-only');
            return Object.assign({amError: 'E_OK'}, data[name]);
        },
    });
    assert.strictEqual(route, 'CarPlayMedia');
    assert.deepStrictEqual(methods, Object.keys(data));
}
function audioManager() {
    const a = {methods: [], links: [], source: 'GameStationMedia', state: 'CS_CONNECTED'};
    const availability = {availability: 'A_AVAILABLE'};
    a.signals = {
        proxy: async () => ({}),
        async call(_, method, args, timeout) {
            assert.ok(timeout <= 1800);
            a.methods.push(method);
            if (method === 'getListMainSources') return {amError: 0, listMainSources: [
                {sourceID: 88, name: a.source, availability}, {sourceID: 44, name: 'CarPlayMedia', availability},
            ]};
            if (method === 'getListMainSinks') return {amError: 0, listMainSinks: [{sinkID: 12, name: 'MediaSink_Front', availability}]};
            if (method === 'getListMainConnections') return {amError: 0, listConnections: a.links.slice()};
            if (method === 'connect') {
                assert.deepStrictEqual(args, {sourceID: 88, sinkID: 12});
                if (a.unknown) throw Error('timeout');
                a.links.push(Object.assign({mainConnectionID: 33, connectionState: a.state}, args));
                if (a.onConnect) a.onConnect();
                return {amError: 'E_OK', mainConnectionID: 33};
            }
            assert.strictEqual(method, 'disconnect');
            assert.deepStrictEqual(args, {mainConnectionID: 33});
            a.links = a.links.filter(link => link.mainConnectionID !== args.mainConnectionID);
            return {amError: 0};
        },
    };
    a.route = new AudioRoute(a.signals, {wait: async () => {}});
    a.probe = async device => {
        assert.strictEqual(device, DEVICE);
        a.methods.push('probe');
    };
    return a;
}
async function rejects(promise, pattern) {
    try { await promise; }
    catch (error) { assert.ok(pattern.test(error.message), error.message); return; }
    assert.fail('Expected rejection ' + pattern);
}
async function checkRouting() {
    const a = audioManager(), allowed = () => true;
    const foreign = {mainConnectionID: 21, sourceID: 44, sinkID: 12, connectionState: 'CS_CONNECTING'};
    a.links.push(foreign);
    await rejects(a.route.acquire(allowed, a.probe), /occupied/);
    assert.ok(!a.methods.includes('connect') && !a.methods.includes('probe'));
    a.links = [{sourceID: 44, sinkID: 12}];
    await rejects(a.route.acquire(allowed, a.probe), /unrecognized/);
    assert.ok(!a.methods.includes('connect'));
    a.links.length = 0;
    a.source = 'CarLifeMedia';
    await rejects(a.route.acquire(allowed, a.probe), /missing or ambiguous/);
    a.source = 'GameStationMedia';
    const unknown = audioManager();
    unknown.unknown = true;
    await rejects(unknown.route.acquire(allowed, unknown.probe), /unconfirmed/);
    await unknown.route.release();
    await rejects(unknown.route.acquire(allowed, unknown.probe), /restart/);
    assert.ok(!unknown.methods.includes('disconnect'), 'unconfirmed connect grants no ownership');
    assert.strictEqual(unknown.methods.filter(m => m === 'connect').length, 1);
    await rejects(a.route.acquire(allowed, async () => { throw Error('ALSA probe refused'); }), /ALSA probe refused/);
    assert.strictEqual(a.links.length, 0);
    a.state = 'CS_CONNECTING';
    await rejects(a.route.acquire(allowed, a.probe), /timed out/);
    await a.route.release();
    a.state = 'CS_CONNECTED';
    assert.strictEqual(await a.route.acquire(allowed, a.probe), DEVICE);
    assert.strictEqual(a.route.info.state, 'Connected');
    assert.strictEqual(a.route.info.connectionID, 33);
    assert.ok(a.methods.lastIndexOf('probe') < a.methods.lastIndexOf('connect'));
    a.links.push(foreign);
    await rejects(a.route.check(), /Another BMW audio route/);
    await a.route.release();
    assert.deepStrictEqual(a.links, [foreign]);

    const reused = audioManager();
    await reused.route.acquire(allowed, reused.probe);
    reused.links = [{mainConnectionID: 33, sourceID: 44, sinkID: 12, connectionState: 2}];
    await reused.route.release();
    assert.ok(!reused.methods.includes('disconnect'));

    const interrupted = audioManager();
    let audio;
    interrupted.onConnect = () => audio.stop();
    audio = new AudioOutput('/tmp', {router: interrupted.route, probe: interrupted.probe,
        spawn() { assert.fail('Audio must not start after a cancelled route'); }});
    audio.configure(true, 30);
    audio.setActive(true);
    await audio.routeJob;
    assert.strictEqual(audio.acceptsPcm(), false);
    assert.deepStrictEqual(interrupted.links, []);
    assert.ok(interrupted.methods.includes('disconnect'));
}
async function checkRoutedOutput() {
    const a = audioManager(), children = [];
    let now = 100;
    const audio = new AudioOutput('/tmp', {router: a.route, probe: a.probe, now: () => now,
        spawn(_, args) {
            assert.deepStrictEqual(args, [DEVICE]);
            const child = new EventEmitter();
            child.stdin = new PassThrough();
            child.stderr = new PassThrough();
            child.stdout = new PassThrough();
            child.stdin.resume();
            child.kill = () => setImmediate(() => child.emit('close', 0));
            children.push(child);
            return child;
        },
    });
    const block = {rate: 48000, left: new Float32Array(800).fill(0.2)};
    audio.configure(true, 30);
    audio.setActive(true);
    assert.strictEqual(audio.write(block), false, 'no PCM while discovering');
    await audio.routeJob;
    assert.strictEqual(audio.write(block), false, 'no PCM before ALSA acknowledgement');
    const stats = {bufferFrames:3072, periodFrames:768, pendingFrames:0, underruns:0, droppedFrames:0, writtenFrames:0};
    children[0].stdout.write(JSON.stringify(stats) + '\n');
    assert.strictEqual(audio.write(block), true);
    assert.strictEqual(audio.diagnostics().queued, 800);
    children[0].emit('error', Error('ALSA temporarily unavailable'));
    await audio.routeJob;
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(a.links.length, 0);
    audio.setActive(true);
    assert.strictEqual(children.length, 1, 'no process spawn loop');
    now += 2000;
    audio.setActive(true);
    await audio.routeJob;
    audio.write(block);
    children[1].stdout.write(JSON.stringify(stats) + '\n');
    assert.strictEqual(audio.write(block), true);
    await audio.stop();
    assert.strictEqual(a.links.length, 0);
    assert.strictEqual(audio.write(block), false);
    audio.configure(true, 30, 'off');
    audio.setActive(true);
    assert.strictEqual(audio.acceptsPcm(), false);
}

async function checkNative() {
    if (process.env.GAMESTATION_NATIVE_AUDIO !== '1') return;
    const command = path.join(__dirname, '../native/gamestation-audio/mgu-gamestation-audio');
    assert.ok(fs.statSync(command).mode & 0o100);
    assert.strictEqual(spawnSync(command, ['default']).status, 2);
    assert.strictEqual(spawnSync(command, ['--probe', 'null']).status, 0);
    assert.strictEqual(spawnSync(command, ['smartx:CarPlayMain_CF_48_STEREO']).status, 2);
    assert.strictEqual(spawnSync(command, ['gamestation-missing-endpoint']).status, 1);
    let child;
    const audio = new AudioOutput('/tmp', {command, readDevice: () => 'null',
        spawn: (...args) => { child = spawn(...args); return child; }});
    audio.configure(true, 30);
    audio.setActive(true);
    const samples = Float32Array.from({length: 800}, (_, i) => 0.12 * Math.sin(i * Math.PI / 48));
    const silence = {rate: 48000, left: samples};
    audio.write(silence);
    assert.ok(child);
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
    try {
        for (let i = 0; i < 24; i++) {
            await new Promise(resolve => setTimeout(resolve, 16));
            audio.write(silence);
        }
        const d = audio.diagnostics();
        assert.strictEqual(d.state, 'PCM');
        assert.strictEqual(d.error, '');
        assert.ok(d.written > 0 && d.queued >= d.written);
        console.log('ALSA null:', d.bufferMs, 'ms buffer,', d.periodMs, 'ms period,', d.written, 'PCM frames accepted');
        assert.ok(d.bufferMs > d.periodMs && d.deviceMs >= 0);
    } finally { audio.stop(); }
    assert.deepStrictEqual(await closed, {code: 0, signal: null});

    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-alsa-'));
    const library = path.join(mockDir, 'libasound.so.2');
    try {
        const compile = spawnSync('cc', ['-shared', '-fPIC', '-Wall', '-Werror', '-o', library,
            path.join(__dirname, 'gamestation_alsa_mock.c')]);
        assert.strictEqual(compile.status, 0, String(compile.stderr));
        const mock = spawn(command, ['test'], {env: Object.assign({}, process.env, {LD_LIBRARY_PATH: mockDir})});
        const done = new Promise(resolve => mock.once('close', resolve));
        let reports = '';
        mock.stdout.on('data', data => { reports += data.toString(); });
        mock.stderr.resume();
        await new Promise(resolve => mock.stdout.once('data', resolve)); // device is open
        mock.stdin.write(Buffer.alloc(800 * 4));
        await new Promise(resolve => setTimeout(resolve, 40));
        mock.kill('SIGTERM');
        assert.strictEqual(await done, 0);
        const final = reports.trim().split('\n').map(JSON.parse).pop();
        assert.strictEqual(final.underruns, 1);
        assert.strictEqual(final.writtenFrames, 800, 'underrun recovery retries the current block once');
    } finally {
        if (fs.existsSync(library)) fs.unlinkSync(library);
        fs.rmdirSync(mockDir);
    }

    const idle = spawn(command, ['null']);
    idle.stdout.resume();
    idle.stderr.resume();
    const timeout = await new Promise(resolve => idle.once('close', resolve));
    assert.strictEqual(timeout, 1, 'device closes if the app stops supplying input');
    console.log('ok: native ALSA null negotiation, stream, graceful stop, timeout and missing/protected device');
}

checkPcm();
checkOutput();
checkSource().then(checkRouting).then(checkRoutedOutput).then(checkNative).then(
    () => console.log('ok: PCM resampling, mono/stereo, volume, pause, errors, bounded output and owned route lifecycle'),
    error => { console.error(error); process.exitCode = 1; });
