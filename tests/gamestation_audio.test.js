'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const {PassThrough} = require('stream');
const fs = require('fs');
const path = require('path');
const {spawn, spawnSync} = require('child_process');
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
async function checkNative() {
    if (process.env.GAMESTATION_NATIVE_AUDIO !== '1') return;
    const command = path.join(__dirname, '../native/gamestation-audio/mgu-gamestation-audio');
    assert.ok(fs.statSync(command).mode & 0o100);
    assert.strictEqual(spawnSync(command, ['default']).status, 2);
    assert.strictEqual(spawnSync(command, ['smartx:CarPlayMain_CF_48_STEREO']).status, 2);
    assert.strictEqual(spawnSync(command, ['gamestation-missing-endpoint']).status, 1);
    let child;
    const audio = new AudioOutput('/tmp', {command, readDevice: () => 'null',
        spawn: (...args) => { child = spawn(...args); return child; }});
    audio.configure(true, 30);
    audio.setActive(true);
    const silence = {rate: 48000, left: new Float32Array(800)};
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
        assert.ok(d.bufferMs > d.periodMs && d.deviceMs >= 0);
    } finally { audio.stop(); }
    assert.deepStrictEqual(await closed, {code: 0, signal: null});

    const idle = spawn(command, ['null']);
    idle.stdout.resume();
    idle.stderr.resume();
    const timeout = await new Promise(resolve => idle.once('close', resolve));
    assert.strictEqual(timeout, 1, 'device closes if the app stops supplying input');
    console.log('ok: native ALSA null negotiation, stream, graceful stop, timeout and missing/protected device');
}

checkPcm();
checkOutput();
checkSource().then(checkNative).then(
    () => console.log('ok: PCM resampling, mono/stereo, volume, pause, errors, bounded output and read-only route'),
    error => { console.error(error); process.exitCode = 1; });
