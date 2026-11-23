'use strict';

const {spawn, execFile} = require('child_process');
const fs = require('fs');
const path = require('path');

const RATE = 48000;
const BUFFER_MS = 64;
const STOP_MS = 120;
const MAX_ATTEMPTS = 4;
const HELPER = '/var/opt/mgu-gamestation-audio/current/mgu-gamestation-audio';
const MAX_PENDING = RATE * 4 / 25;
const {readFrontSource} = require('./audio_route');

class PcmConverter {
    constructor() { this.reset(); }
    reset() { this.rate = 0; this.position = 0; this.left = 0; this.right = 0; }
    convert(block, volume) {
        const left = block.left, right = block.right || left, rate = block.rate;
        if (!left || !left.length || left.length !== right.length || left.length > 4096 ||
            !Number.isFinite(rate) || rate < 8000 || rate > 192000) throw new Error('Invalid emulator PCM block');
        if (this.rate !== rate) {
            this.rate = rate; this.position = 0; this.left = left[0]; this.right = right[0];
        }
        // Some cores assemble a variable number of PCM samples per video frame.
        // Export exactly that frame's duration without joining stale blocks.
        if (block.frameSamples) return this.convertFrame(left, right, block.frameSamples, volume);
        const step = rate / RATE;
        const out = Buffer.allocUnsafe(Math.ceil((left.length - this.position + 1) / step) * 4);
        let offset = 0;
        const quantize = x => clip(x * volume);
        while (this.position <= left.length - 1) {
            const index = Math.floor(this.position), fraction = this.position - index;
            const l = index < 0 ? this.left : left[index], r = index < 0 ? this.right : right[index];
            const next = Math.min(left.length - 1, index + 1);
            out.writeInt16LE(quantize(l + (left[next] - l) * fraction), offset);
            out.writeInt16LE(quantize(r + (right[next] - r) * fraction), offset + 2);
            offset += 4;
            this.position += step;
        }
        this.position -= left.length;
        this.left = left[left.length - 1];
        this.right = right[right.length - 1];
        return out.slice(0, offset);
    }
    convertFrame(left, right, count, volume) {
        if (!Number.isInteger(count) || count < 1 || count > 1920) throw new Error('Invalid frame PCM duration');
        const out = Buffer.allocUnsafe(count * 4), step = left.length / count;
        for (let i = 0; i < count; i++) {
            const next = (i + 1) * step - 1;
            const index = Math.min(left.length - 1, Math.floor(next)), fraction = next - index;
            const l = index < 0 ? this.left : left[index], r = index < 0 ? this.right : right[index];
            const following = Math.min(left.length - 1, index + 1);
            out.writeInt16LE(clip((l + (left[following] - l) * fraction) * volume), 4 * i);
            out.writeInt16LE(clip((r + (right[following] - r) * fraction) * volume), 4 * i + 2);
        }
        this.left = left[left.length - 1];
        this.right = right[right.length - 1];
        return out;
    }
}

function clip(sample) { return Math.round(Math.max(-1, Math.min(1, sample)) * 32767) || 0; }

function readDevice(dir) {
    try {
        const file = path.join(dir, 'audio-device.txt');
        if (fs.statSync(file).size > 180) return '';
        const value = fs.readFileSync(file, 'utf8').trim();
        return /^[a-zA-Z0-9][a-zA-Z0-9_.,:+-]{0,159}$/.test(value) ? value : '';
    } catch (_) { return ''; }
}

/** A process per active playback interval. Closing it discards the pipe and PCM device queue. */
class AudioOutput {
    constructor(dataDir, options) {
        const opts = options || {};
        this.readDevice = opts.readDevice || (() => readDevice(dataDir));
        this.spawn = opts.spawn || spawn;
        this.command = opts.command || HELPER;
        this.probe = opts.probe || (device => new Promise((resolve, reject) => {
            execFile(this.command, ['--probe', device], {timeout: 1800, killSignal: 'SIGKILL', maxBuffer: 4096},
                (error, _, stderr) => error ? reject(new Error('ALSA endpoint: ' +
                    (String(stderr || '').trim().slice(-200) || error.message))) : resolve());
        }));
        this.now = opts.now || Date.now;
        this.onError = opts.onError || (() => {});
        this.converter = new PcmConverter();
        this.lastWrite = 0;
        this.child = null;
        this.closing = null;
        this.device = '';
        this.volume = 0;
        this.enabled = this.active = false;
        this.failed = false;
        this.dropped = this.underruns = this.deviceDrops = 0;
        this.closeTimer = null;
        this.error = '';
        this.router = opts.router || null;
        this.mode = this.router ? 'auto' : 'legacy';
        this.routeJob = null;
        this.generation = 0;
        this.retryAt = this.checkAt = this.failures = 0;
        this.received = this.queued = this.blocks = this.inputRate = this.written = 0;
        this.opened = false;
        this.readyTimer = null;
        this.waitForOpen = !!this.router;
        this.onState = opts.onState || (() => {});
    }
    configure(enabled, percent, mode) {
        const on = enabled === true, volume = Math.max(0, Math.min(1, Number(percent) / 100 || 0));
        const next = mode === 'off' || mode === 'legacy' ? mode : this.router ? 'auto' : 'legacy';
        if (this.enabled !== on || this.mode !== next || (this.volume > 0) !== (volume > 0)) this.stop();
        this.enabled = on;
        this.mode = next;
        this.volume = volume;
    }
    setActive(active) {
        const want = active && this.enabled && !!this.volume && this.mode !== 'off';
        if (!want) {
            if (this.active) this.stop();
            return;
        }
        if (!this.active) {
            this.active = true;
            this.device = this.mode === 'legacy' ? this.readDevice() : '';
            this.resetCounters();
            this.failed = false;
            this.retryAt = this.checkAt = this.failures = 0;
            this.error = this.mode === 'legacy' && !this.device ? 'No explicit ALSA device configured' : '';
        }
        if (this.router && this.mode === 'legacy' && this.failed && this.failures < MAX_ATTEMPTS && this.now() >= this.retryAt) this.failed = false;
        if (this.router) this.service();
    }
    resetCounters() {
        this.received = this.queued = this.blocks = this.inputRate = this.written = 0;
        this.opened = false;
    }
    failLater(message) {
        if (this.error !== message) this.onError(message);
        this.error = message;
        this.failed = true;
        this.retryAt = this.now() + Math.min(15000, 1000 * Math.pow(2, Math.min(4, this.failures++)));
    }
    routeInfo() {
        return this.router && this.mode === 'auto' ? this.router.info : {state: this.mode === 'legacy' ? 'Legacy direct PCM' : 'Off'};
    }
    service() {
        if (this.routeJob || this.closing || this.failures >= MAX_ATTEMPTS) return;
        const generation = this.generation;
        const valid = () => this.active && this.generation === generation;
        if (!this.active || this.mode !== 'auto') {
            if (this.router.owner && this.now() >= this.retryAt) this.runJob(() => this.router.release());
            return;
        }
        if (this.now() < this.retryAt || this.router.uncertain) return;
        if (this.device && this.now() < this.checkAt) return;
        this.runJob(async () => {
            if (this.device) {
                if (!await this.router.check()) throw new Error('BMW GameStation audio connection lost');
            } else {
                if (this.router.owner) await this.router.release();
                if (!valid()) return;
                const device = await this.router.acquire(valid, this.probe);
                if (!valid() || !device) return;
                this.device = device;
                this.failed = false;
                this.error = '';
                this.onState('BMW GameStation route connected');
            }
            this.checkAt = this.now() + 1500;
        });
    }
    runJob(work) {
        this.routeJob = Promise.resolve().then(work).catch(e => {
            this.device = '';
            this.router.info.state = 'Unavailable';
            this.closeChild();
            this.failLater(e.message);
            this.releaseAfterJob = true;
        }).then(async () => {
            if ((!this.active || this.mode !== 'auto' || this.releaseAfterJob) && this.router.owner) {
                try { await this.router.release(); }
                catch (e) { this.failLater(e.message); }
            }
            this.releaseAfterJob = false;
        }).then(() => { this.routeJob = null; });
        return this.routeJob;
    }
    acceptsPcm() {
        return this.active && !!this.device && this.enabled && !this.failed && !this.closing &&
            !(this.mode === 'legacy' && this.router && this.router.owner);
    }
    start() {
        const child = this.spawn(this.command, [this.device], {stdio: ['pipe', 'pipe', 'pipe']});
        this.child = child;
        child.pcmStats = null;
        if (this.waitForOpen) this.readyTimer = setTimeout(() => this.fail(child, 'ALSA setup timed out'), 2000);
        let report = '';
        child.on('error', e => this.fail(child, e.message));
        child.stdin.on('error', e => { if (e.code !== 'EPIPE') this.fail(child, e.message); });
        child.stdout.on('data', data => {
            if (this.child !== child && this.closing !== child) return;
            report += String(data);
            if (report.length > 4096) { report = ''; return; }
            const lines = report.split('\n');
            report = lines.pop();
            for (const line of lines) {
                try {
                    const stats = JSON.parse(line);
                    if (['bufferFrames', 'periodFrames', 'pendingFrames', 'underruns', 'droppedFrames']
                        .every(key => Number.isSafeInteger(stats[key]) && stats[key] >= 0)) {
                        if (!child.pcmStats && this.child === child) {
                            clearTimeout(this.readyTimer);
                            this.readyTimer = null;
                            this.opened = true;
                            this.failures = 0;
                            this.onState('ALSA device opened');
                        }
                        child.pcmStats = stats;
                    }
                } catch (_) { /* helper diagnostics only */ }
            }
        });
        child.stderr.on('data', data => {
            if (this.child !== child) return;
            const message = String(data).trim().slice(0, 240);
            if (message) child.pcmError = message;
        });
        child.once('close', code => {
            if (this.closing === child) {
                this.collect(child);
                clearTimeout(this.closeTimer);
                this.closing = this.closeTimer = null;
            }
            if (this.child === child) this.fail(child, child.pcmError || 'ALSA process ended (' + code + ')', true);
            if (this.router) this.service();
        });
        return child;
    }
    fail(child, message, closed) {
        if (this.child !== child) return;
        this.failLater(message);
        if (this.mode === 'auto') {
            this.device = '';
            this.releaseAfterJob = true;
        }
        this.closeChild(closed);
        if (this.mode === 'auto' && !this.routeJob) this.runJob(() => {});

    }
    write(block) {
        if (!block || !this.active) return false;
        this.received += block.left ? block.left.length : 0;
        this.inputRate = block.rate;
        if (!this.acceptsPcm()) return false;
        try {
            const now = this.now(), child = this.child || this.start();
            if (this.waitForOpen && !child.pcmStats) return false;
            const pending = child.stdin.writableLength === undefined ? child.stdin._writableState.length : child.stdin.writableLength;
            if (pending > 0 || this.lastWrite && (now - this.lastWrite > 120 || now < this.lastWrite)) {
                this.dropped++;
                this.converter.reset();
                // Cut a stalled stream at the source so its old samples cannot play on recovery.
                this.closeChild();
                return;
            }
            const pcm = this.converter.convert(block, this.volume);
            if (pcm.length > MAX_PENDING) { this.dropped++; this.converter.reset(); return; }
            if (pcm.length) {
                child.stdin.write(pcm);
                this.lastWrite = now;
                this.queued += pcm.length / 4;
                this.blocks++;
                return true;
            }
        } catch (e) {
            if (this.child) this.fail(this.child, e.message);
            else {
                this.failLater(e.message);
                if (this.mode === 'auto') {
                    this.device = '';
                    this.releaseAfterJob = true;
                    if (!this.routeJob) this.runJob(() => {});
                }
            }
        }
    }
    collect(child) {
        const stats = child.pcmStats;
        if (!stats) return;
        this.underruns += stats.underruns;
        this.deviceDrops += stats.droppedFrames;
        this.written += stats.writtenFrames || 0;
    }
    closeChild(closed) {
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
        if (this.child) {
            const child = this.child;
            this.child = null;
            if (closed) this.collect(child);
            else {
                this.closing = child;
                child.stdin.destroy();
                child.kill('SIGTERM');
                this.closeTimer = setTimeout(() => {
                    if (this.closing === child) child.kill('SIGKILL');
                }, STOP_MS);
                this.closeTimer.unref();
            }
        }
        this.converter.reset();
        this.lastWrite = 0;
    }
    stop() {
        this.active = false;
        this.generation++;
        if (this.routeJob) this.releaseAfterJob = true;
        this.device = '';
        this.closeChild();
        if (this.router && !this.routeJob && this.router.owner) this.runJob(() => this.router.release());
        return this.routeJob || Promise.resolve();
    }
    diagnostics() {
        const stream = this.child && this.child.stdin, stats = this.child && this.child.pcmStats;
        return {backend: 'Native ALSA / ' + this.mode, state: stats ? 'PCM' : this.child ? 'Opening' :
            this.enabled && this.mode !== 'off' ? 'idle' : 'off',
            device: this.device, rate: RATE, format: 'S16_LE stereo', targetMs: BUFFER_MS,
            pending: stream ? (stream.writableLength === undefined ? stream._writableState.length : stream.writableLength) : 0,
            deviceMs: stats ? stats.pendingFrames / (RATE / 1000) : null,
            bufferMs: stats ? stats.bufferFrames / (RATE / 1000) : null,
            periodMs: stats ? stats.periodFrames / (RATE / 1000) : null,
            underruns: this.underruns + (stats ? stats.underruns : 0),
            droppedFrames: this.deviceDrops + (stats ? stats.droppedFrames : 0),
            overflows: this.dropped, route: this.routeInfo(), error: this.error,
            opened: this.opened, received: this.received, queued: this.queued, blocks: this.blocks, inputRate: this.inputRate,
            written: this.written + (stats && stats.writtenFrames || 0)};
    }
}

module.exports = {AudioOutput, PcmConverter, readDevice, readFrontSource, HELPER};
