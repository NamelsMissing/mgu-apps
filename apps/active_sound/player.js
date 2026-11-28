'use strict';
/*
 * player.js - sound output on the head unit.
 *
 * LivePlayer: the synthesizer as a live PCM stream (44.1 kHz, S16LE stereo) through the
 * optional Equalizer DSP service into aplay, or ffmpeg with ALSA output, on the default ALSA
 * device. Same route as the Equalizer test music: no BMW / SmartX device is opened directly
 * and no audio routing is changed. Most MGUs ship without aplay and ffmpeg; then the player
 * reports "unavailable" and the phone route is the one that sounds.
 * Samples are paced by the clock (a fixed lead of ~120 ms), not by pipe back-pressure, so the
 * delay between pedal and sound stays bounded.
 *
 * Demo drive + WAV export: a scripted 24 s drive (idle, blips, three pulls with shifts, the
 * rev limiter, overrun) rendered to a stereo WAV file - to listen to a profile from a USB stick.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { EngineSynth } = require('./synth');

const RATE = 44100;
const LEAD_MS = 120;
const TICK_MS = 20;
const DRIVE_SECONDS = 24;

function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }
function ease(t) { t = Math.max(0, Math.min(1, t)); return 1 - Math.pow(1 - t, 1.6); }
/** Scripted drive: { n: 0..1 of the engine's range, load: 0..1 } at time t (s). */
function drive(t) {
    if (t < 2.5) return { n: 0, load: 0.05 };
    if (t < 3.2) return { n: lerp(0, 0.55, (t - 2.5) / 0.45), load: 1 };
    if (t < 4.2) return { n: lerp(0.55, 0, (t - 3.2) / 0.9), load: 0 };
    if (t < 4.6) return { n: lerp(0, 0.45, (t - 4.2) / 0.3), load: 1 };
    if (t < 6.5) return { n: lerp(0.45, 0, (t - 4.6) / 0.9), load: t < 5.6 ? 0 : 0.05 };
    if (t < 10) return { n: lerp(0.08, 0.85, ease((t - 6.5) / 3.5)), load: 1 };
    if (t < 10.35) return { n: lerp(0.85, 0.5, (t - 10) / 0.35), load: 0 };
    if (t < 14) return { n: lerp(0.5, 0.92, ease((t - 10.35) / 3.65)), load: 1 };
    if (t < 14.35) return { n: lerp(0.92, 0.6, (t - 14) / 0.35), load: 0 };
    if (t < 18) return { n: Math.min(1, lerp(0.6, 1.06, (t - 14.35) / 3.2)), load: 1 };
    if (t < 21) return { n: lerp(1, 0.25, (t - 18) / 3), load: 0 };
    return { n: lerp(0.25, 0, (t - 21) / 1.2), load: 0.05 };
}

function wavHeader(frames, channels, rate) {
    const bytes = frames * channels * 2, h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32);
    h.writeUInt16LE(16, 34); h.write('data', 36, 'ascii'); h.writeUInt32LE(bytes, 40);
    return h;
}

/**
 * Render the demo drive for a profile as WAV (stereo, 16 bit). Async in slices so the UI keeps
 * drawing on the head unit. opts: { seconds, rate, volume, tune }.
 */
function renderDrive(profile, opts) {
    const o = opts || {};
    const rate = o.rate || RATE, seconds = o.seconds || DRIVE_SECONDS;
    const synth = new EngineSynth(rate, profile, 1234, o.tune || null);
    const total = Math.round(seconds * rate), block = 441;
    const parts = [];
    let done = 0;
    return new Promise((resolve, reject) => {
        function slice() {
            try {
                const until = Math.min(total, done + rate);           // one second per slice
                while (done < until) {
                    const t = done / rate, d = drive(t);
                    const rpm = profile.idle + d.n * (profile.redline - profile.idle);
                    const fade = Math.min(1, (total - done) / (rate * 0.6));
                    synth.set(rpm, d.load, fade > 0.05, o.volume === undefined ? 0.85 : o.volume);
                    const n = Math.min(block, until - done);
                    parts.push(synth.renderS16(n));
                    done += n;
                }
                if (done >= total) {
                    const pcm = Buffer.concat(parts);
                    return resolve(Buffer.concat([wavHeader(total, 2, rate), pcm]));
                }
                setImmediate(slice);
            } catch (e) { reject(e); }
        }
        slice();
    });
}

/** Write the demo drive of a profile into dir, atomically. Resolves to the file path. */
async function exportDrive(profile, dir, tune) {
    const wav = await renderDrive(profile, { tune });
    const file = path.join(dir, 'active-sound-' + profile.id + '.wav');
    const tmp = file + '.tmp-' + process.pid;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, wav);
    fs.renameSync(tmp, file);
    return { file, bytes: wav.length, seconds: DRIVE_SECONDS };
}

function findExecutable(name) {
    const dirs = String(process.env.PATH || '').split(':').filter(Boolean).concat(['/usr/bin', '/bin', '/usr/local/bin']);
    for (const d of dirs) {
        const p = path.join(d, name);
        try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* next */ }
    }
    return null;
}

class LivePlayer {
    /** opts: { profile, spawn, find(name), dspClient, dspRuntime, log, onState } */
    constructor(opts) {
        const o = opts || {};
        this.spawn = o.spawn || cp.spawn;
        this.find = o.find || findExecutable;
        this.dspClient = o.dspClient === undefined ? safeRequire('./kit/dsp-client') : o.dspClient;
        this.dspRuntime = o.dspRuntime;
        this.log = o.log || console;
        this.onState = o.onState || (() => {});
        this.synth = new EngineSynth(RATE, o.profile, 77, o.tune || null);
        this.run = null;
        this.status = 'off'; this.detail = '';
    }
    backend() {
        const aplay = this.find('aplay');
        if (aplay) return { name: 'aplay', bin: aplay, args: ['-q', '-t', 'raw', '-f', 'S16_LE', '-c', '2', '-r', String(RATE), '--buffer-time=100000'] };
        const ffmpeg = this.find('ffmpeg');
        if (ffmpeg) return { name: 'ffmpeg', bin: ffmpeg, args: ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 's16le',
            '-ar', String(RATE), '-ac', '2', '-i', 'pipe:0', '-f', 'alsa', 'default'] };
        return null;
    }
    available() { return !!this.backend(); }
    setProfile(profile, tune) { this.synth.setProfile(profile, tune); }
    setTune(tune) { this.synth.setTune(tune); }
    set(rpm, load, on, volume) { this.synth.set(rpm, load, on, volume); }
    state(status, detail) {
        this.status = status; this.detail = detail || '';
        this.onState({ status, detail: this.detail });
    }
    playing() { return !!this.run; }
    start() {
        if (this.run) return true;
        const b = this.backend();
        if (!b) { this.state('unavailable', 'No aplay or ffmpeg on this head unit: use the phone'); return false; }
        let child;
        try { child = this.spawn(b.bin, b.args, { stdio: ['pipe', 'ignore', 'pipe'] }); }
        catch (e) { this.state('error', b.name + ' did not start: ' + e.message); return false; }
        const run = { child, error: '', produced: 0, t0: Date.now(), timer: null, sink: child.stdin, filter: null };
        if (this.dspClient && this.dspClient.PcmFilter) {
            try {
                run.filter = new this.dspClient.PcmFilter({ sampleRate: RATE, channels: 2, source: 'active_sound',
                    runtime: this.dspRuntime, timeout: 400, onFallback: () => { /* plain PCM then */ } });
                run.filter.on('error', () => { /* falls back inside */ });
                run.filter.pipe(child.stdin);
                run.sink = run.filter;
            } catch (_) { run.filter = null; run.sink = child.stdin; }
        }
        this.run = run;
        this.state('playing', 'Sending to ' + b.name + ' (default ALSA device; car speakers not confirmed)');
        child.stderr.on('data', (d) => { if (run.error.length < 600) run.error += d.toString('utf8'); });
        child.on('error', (e) => this.fail(run, b.name + ': ' + e.message));
        child.stdin.on('error', (e) => this.fail(run, 'audio stream: ' + e.message));
        child.on('close', (code) => {
            if (this.run !== run) return;
            this.fail(run, b.name + ' stopped (code ' + code + ')' + (run.error ? ': ' + run.error.trim().slice(0, 160) : ''));
        });
        run.timer = setInterval(() => this.pump(run), TICK_MS);
        this.pump(run);
        return true;
    }
    pump(run) {
        if (this.run !== run) return;
        const due = Math.floor((Date.now() - run.t0 + LEAD_MS) / 1000 * RATE);
        let want = due - run.produced;
        if (want > RATE) { run.produced = due - RATE / 10; want = RATE / 10; }   // after a stall: resync, don't burst
        while (want > 0) {
            const n = Math.min(1024, want);
            try { run.sink.write(this.synth.renderS16(n)); } catch (e) { return this.fail(run, 'audio stream: ' + e.message); }
            run.produced += n; want -= n;
        }
    }
    fail(run, msg) {
        if (this.run !== run) return;
        this.stop();
        this.state('error', msg);
    }
    stop() {
        const run = this.run;
        if (!run) return;
        this.run = null;
        clearInterval(run.timer);
        if (run.filter) { try { run.filter.unpipe(); run.filter.destroy(); } catch (_) { /* gone */ } }
        try { run.child.stdin.destroy(); } catch (_) { /* gone */ }
        try { run.child.kill('SIGTERM'); } catch (_) { /* gone */ }
        this.state('off', '');
    }
}

function safeRequire(name) { try { return require(name); } catch (_) { return null; } }

module.exports = { LivePlayer, renderDrive, exportDrive, drive, wavHeader, findExecutable, RATE, DRIVE_SECONDS };
