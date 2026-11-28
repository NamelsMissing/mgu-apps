'use strict';
/*
 * player.js - sound output on the head unit.
 *
 * LivePlayer: the synthesizer as a live PCM stream (48 kHz, S16LE stereo). Where aplay or ffmpeg
 * exist, into the default ALSA device (optionally through the Equalizer DSP). The MGU has neither:
 * there the native helper mgu-sound-pcm writes to the SmartX endpoint of a BMW media source that
 * hu_route.js connected to the front speakers (only while those are free).
 * Samples are paced by the clock (a fixed lead of ~120 ms), not by pipe back-pressure, so the
 * delay between pedal and sound stays bounded.
 *
 * Demo drive + WAV export: a scripted 30 s drive through the vehicle model (idle, a blip, a
 * full-throttle pull through the gears, overrun, cruise, kickdown, braking) rendered to a stereo
 * WAV file - to listen to a profile from a USB stick.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { EngineSynth } = require('./synth');
const { VehicleSim, script, DRIVE_SECONDS } = require('./vehicle');

const RATE = 48000;          // live output (the BMW media endpoints run at 48 kHz)
const EXPORT_RATE = 44100;   // WAV export
const LEAD_MS = 120;
const TICK_MS = 20;

/** Demo drive: the vehicle model driven by the scripted throttle / brake (vehicle.js). */
function driveStates(profile, seconds, dt) {
    const car = new VehicleSim(profile), out = [];
    for (let t = 0; t < seconds; t += dt) { const c = script(t); out.push(car.step(dt, c.u, c.b)); }
    return out;
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
    const rate = o.rate || EXPORT_RATE, seconds = o.seconds || DRIVE_SECONDS;
    const synth = new EngineSynth(rate, profile, 1234, o.tune || null);
    if (o.character) { synth.setCharacter(o.character); synth.setProfile(profile, o.tune || null); }
    const total = Math.round(seconds * rate), block = Math.round(rate / 100);
    const states = driveStates(profile, seconds + 0.02, 0.01);
    const parts = [];
    let done = 0;
    return new Promise((resolve, reject) => {
        function slice() {
            try {
                const until = Math.min(total, done + rate);           // one second per slice
                while (done < until) {
                    const d = states[Math.min(states.length - 1, Math.floor(done / block))];
                    const fade = Math.min(1, (total - done) / (rate * 0.6));
                    synth.set(d.rpm, d.load, fade > 0.05, o.volume === undefined ? 0.85 : o.volume);
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
async function exportDrive(profile, dir, tune, character) {
    const wav = await renderDrive(profile, { tune, character });
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

const HELPER = '/var/opt/mgu-sound-pcm/current/mgu-sound-pcm';

class LivePlayer {
    /**
     * opts: { profile, tune, spawn, execFile, find(name), helper, route (hu_route.js HuRoute), dspClient,
     * dspRuntime, log, onState }. Backends, first found wins: aplay, ffmpeg (default ALSA device), then
     * mgu-sound-pcm through a BMW media route (AudioManager) - the one an MGU without players can use.
     */
    constructor(opts) {
        const o = opts || {};
        this.spawn = o.spawn || cp.spawn;
        this.execFile = o.execFile || cp.execFile;
        this.find = o.find || findExecutable;
        this.helper = o.helper === undefined ? HELPER : o.helper;
        this.exists = o.exists || ((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch (_) { return false; } });
        this.route = o.route || null;
        this.dspClient = o.dspClient === undefined ? safeRequire('./kit/dsp-client') : o.dspClient;
        this.dspRuntime = o.dspRuntime;
        this.log = o.log || console;
        this.onState = o.onState || (() => {});
        this.synth = new EngineSynth(RATE, o.profile, 77, o.tune || null);
        this.run = null; this.gen = 0; this.stats = null;
        this.status = 'off'; this.detail = '';
    }
    backend() {
        const aplay = this.find('aplay');
        if (aplay) return { name: 'aplay', bin: aplay, args: ['-q', '-t', 'raw', '-f', 'S16_LE', '-c', '2', '-r', String(RATE), '--buffer-time=100000'] };
        const ffmpeg = this.find('ffmpeg');
        if (ffmpeg) return { name: 'ffmpeg', bin: ffmpeg, args: ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 's16le',
            '-ar', String(RATE), '-ac', '2', '-i', 'pipe:0', '-f', 'alsa', 'default'] };
        if (this.route && this.helper && this.exists(this.helper)) return { name: 'BMW media route', bin: this.helper, args: [], route: true, lead: 40, tick: 10 };
        return null;
    }
    /** helper --probe <device>: negotiates the format and closes without writing. */
    probe(device) {
        return new Promise((resolve, reject) => {
            this.execFile(this.helper, ['--probe', device], { timeout: 1800, killSignal: 'SIGKILL', maxBuffer: 4096 },
                (err, out, errText) => (err ? reject(new Error('endpoint ' + device + ': ' + (String(errText || '').trim().slice(-160) || err.message))) : resolve(String(out || ''))));
        });
    }
    available() { return !!this.backend(); }
    setProfile(profile, tune) { this.synth.setProfile(profile, tune); }
    setTune(tune) { this.synth.setTune(tune); }
    setCharacter(c) { this.synth.setCharacter(c); }
    set(rpm, load, on, volume) { this.synth.set(rpm, load, on, volume); }
    state(status, detail) {
        this.status = status; this.detail = detail || '';
        this.onState({ status, detail: this.detail });
    }
    playing() { return !!this.run; }
    start() {
        if (this.run) return true;
        const b = this.backend();
        if (!b) { this.state('unavailable', 'No audio player on this head unit: use the phone'); return false; }
        const run = { b, child: null, error: '', produced: 0, t0: 0, timer: null, sink: null, filter: null, gen: ++this.gen };
        this.run = run;
        if (!b.route) { this.spawnChild(run, b.args); return true; }
        this.state('connecting', 'Connecting a BMW media source to the front speakers');
        this.route.acquire(() => this.run === run, (d) => this.probe(d)).then((device) => {
            if (this.run !== run) { this.releaseRoute(); return; }
            if (!device) return this.fail(run, 'BMW media route not available');
            run.device = device;
            this.spawnChild(run, [device]);
        }, (e) => this.fail(run, String(e.message || e)));
        return true;
    }
    spawnChild(run, args) {
        const b = run.b;
        let child;
        try { child = this.spawn(b.bin, args, { stdio: ['pipe', b.route ? 'pipe' : 'ignore', 'pipe'] }); }
        catch (e) { return this.fail(run, b.name + ' did not start: ' + e.message); }
        run.child = child; run.sink = child.stdin; run.t0 = Date.now();
        if (!b.route && this.dspClient && this.dspClient.PcmFilter) {
            try {
                run.filter = new this.dspClient.PcmFilter({ sampleRate: RATE, channels: 2, source: 'active_sound',
                    runtime: this.dspRuntime, timeout: 400, onFallback: () => { /* plain PCM then */ } });
                run.filter.on('error', () => { /* falls back inside */ });
                run.filter.pipe(child.stdin);
                run.sink = run.filter;
            } catch (_) { run.filter = null; run.sink = child.stdin; }
        }
        this.state('playing', b.route ? 'Head unit: ' + (this.route.info.source || 'BMW media') + ' -> front speakers'
            : 'Sending to ' + b.name + ' (default ALSA device; car speakers not confirmed)');
        if (child.stdout) {
            let line = '';
            child.stdout.on('data', (d) => {
                line += d.toString('utf8');
                let k;
                while ((k = line.indexOf('\n')) >= 0) {
                    const one = line.slice(0, k); line = line.slice(k + 1);
                    try { this.stats = JSON.parse(one); } catch (_) { /* not a status line */ }
                }
                if (line.length > 2000) line = '';
            });
        }
        child.stderr.on('data', (d) => { if (run.error.length < 600) run.error += d.toString('utf8'); });
        child.on('error', (e) => this.fail(run, b.name + ': ' + e.message));
        child.stdin.on('error', (e) => this.fail(run, 'audio stream: ' + e.message));
        child.on('close', (code) => {
            if (this.run !== run) return;
            this.fail(run, b.name + ' stopped (code ' + code + ')' + (run.error ? ': ' + run.error.trim().slice(0, 160) : ''));
        });
        run.timer = setInterval(() => this.pump(run), b.tick || TICK_MS);
        this.pump(run);
    }
    pump(run) {
        if (this.run !== run || !run.sink) return;
        const due = Math.floor((Date.now() - run.t0 + (run.b.lead || LEAD_MS)) / 1000 * RATE);
        let want = due - run.produced;
        if (want > RATE / 4) { run.produced = due - RATE / 50; want = RATE / 50; }   // after a stall: resync, don't burst
        while (want > 0) {
            const n = Math.min(960, want);
            try { run.sink.write(this.synth.renderS16(n)); } catch (e) { return this.fail(run, 'audio stream: ' + e.message); }
            run.produced += n; want -= n;
        }
    }
    fail(run, msg) {
        if (this.run !== run) return;
        this.stop();
        this.state('error', msg);
    }
    releaseRoute() {
        if (!this.route || !this.route.owner) return;
        this.route.release().catch((e) => this.log.warn('[Active Sound] media route release: ' + (e.message || e)));
    }
    stop() {
        const run = this.run;
        if (!run) return;
        this.run = null;
        clearInterval(run.timer);
        if (run.filter) { try { run.filter.unpipe(); run.filter.destroy(); } catch (_) { /* gone */ } }
        if (run.child) {
            try { run.child.stdin.destroy(); } catch (_) { /* gone */ }
            try { run.child.kill('SIGTERM'); } catch (_) { /* gone */ }
        }
        if (run.b.route) this.releaseRoute();
        this.stats = null;
        this.state('off', '');
    }
}

function safeRequire(name) { try { return require(name); } catch (_) { return null; } }

module.exports = { HELPER, LivePlayer, renderDrive, exportDrive, driveStates, wavHeader, findExecutable, RATE, DRIVE_SECONDS };
