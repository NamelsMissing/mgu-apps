'use strict';

const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');

const RATE = 48000;
const BUFFER_MS = 64;
const STOP_MS = 120;
const HELPER = '/var/opt/mgu-gamestation-audio/current/mgu-gamestation-audio';
const MAX_PENDING = RATE * 4 / 25;
const COMMAND = 'org.genivi.am.commandinterface.CommandControl';

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
        this.route = 'Not queried';
    }
    configure(enabled, percent) {
        const on = enabled === true, volume = Math.max(0, Math.min(1, Number(percent) / 100 || 0));
        if (this.enabled !== on || this.volume !== volume) {
            this.stop();
            this.enabled = on;
            this.volume = volume;
        }
    }
    setActive(active) {
        if (this.active === active) return;
        if (!active) this.stop();
        else {
            this.active = true;
            this.failed = false;
            this.device = this.readDevice();
            this.error = this.enabled && !this.device ? 'No explicit ALSA device configured' : '';
        }
    }
    start() {
        const child = this.spawn(this.command, [this.device], {stdio: ['pipe', 'pipe', 'pipe']});
        this.child = child;
        child.pcmStats = null;
        let report = '';
        child.on('error', e => this.fail(child, e.message));
        child.stdin.on('error', e => { if (e.code !== 'EPIPE') this.fail(child, e.message); });
        child.stdout.on('data', data => {
            if (this.child !== child) return;
            report += String(data);
            if (report.length > 4096) { report = ''; return; }
            const lines = report.split('\n');
            report = lines.pop();
            for (const line of lines) {
                try {
                    const stats = JSON.parse(line);
                    if (['bufferFrames', 'periodFrames', 'pendingFrames', 'underruns', 'droppedFrames']
                        .every(key => Number.isSafeInteger(stats[key]) && stats[key] >= 0)) child.pcmStats = stats;
                } catch (_) { /* helper diagnostics only */ }
            }
        });
        child.stderr.on('data', data => {
            if (this.child !== child) return;
            const message = String(data).trim().slice(0, 240);
            if (message) this.error = message;
        });
        child.once('close', code => {
            if (this.closing === child) {
                clearTimeout(this.closeTimer);
                this.closing = this.closeTimer = null;
            }
            if (this.child === child) this.fail(child, this.error || 'ALSA process ended (' + code + ')', true);
        });
        return child;
    }
    fail(child, message, closed) {
        if (this.child !== child) return;
        this.failed = true;
        this.error = message;
        this.onError(message);
        this.closeChild(closed);
    }
    write(block) {
        if (!block || !this.active || !this.enabled || !this.volume || !this.device || this.failed || this.closing) return;
        try {
            const now = this.now(), child = this.child || this.start();
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
            if (pcm.length) { child.stdin.write(pcm); this.lastWrite = now; }
        } catch (e) {
            if (this.child) this.fail(this.child, e.message);
            else { this.failed = true; this.error = e.message; this.onError(e.message); }
        }
    }
    closeChild(closed) {
        if (this.child) {
            const child = this.child;
            this.child = null;
            if (child.pcmStats) {
                this.underruns += child.pcmStats.underruns;
                this.deviceDrops += child.pcmStats.droppedFrames;
            }
            if (!closed) {
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
        this.closeChild();
    }
    diagnostics() {
        const stream = this.child && this.child.stdin, stats = this.child && this.child.pcmStats;
        return {backend: 'Native ALSA', state: stats ? 'PCM' : this.child ? 'Opening' : this.enabled ? 'idle' : 'off',
            device: this.device, rate: RATE, format: 'S16_LE stereo', targetMs: BUFFER_MS,
            pending: stream ? (stream.writableLength === undefined ? stream._writableState.length : stream.writableLength) : 0,
            deviceMs: stats ? stats.pendingFrames / (RATE / 1000) : null,
            bufferMs: stats ? stats.bufferFrames / (RATE / 1000) : null,
            periodMs: stats ? stats.periodFrames / (RATE / 1000) : null,
            underruns: this.underruns + (stats ? stats.underruns : 0),
            droppedFrames: this.deviceDrops + (stats ? stats.droppedFrames : 0),
            overflows: this.dropped, route: this.route, error: this.error};
    }
}

async function readFrontSource(signals) {
    const proxy = await signals.proxy(COMMAND, '1');
    const list = async (method, keys) => {
        const result = await signals.call(proxy, method, {}, 1800);
        const key = result && (result.amError === 'E_OK' || result.amError === 0) &&
            keys.find(k => Array.isArray(result[k]));
        if (!key) throw new Error('AudioManager: ' + method);
        return result[key];
    };
    const sources = await list('getListMainSources', ['listMainSources']);
    const sinks = await list('getListMainSinks', ['listMainSinks']);
    const links = await list('getListMainConnections', ['listConnections', 'listMainConnections']);
    const front = sinks.filter(row => row.name === 'MediaSink_Front');
    if (front.length !== 1) return 'Front sink unavailable';
    return links.filter(row => row.sinkID === front[0].sinkID &&
        (row.connectionState === 'CS_CONNECTED' || row.connectionState === 2))
        .map(row => {
            const source = sources.find(s => s.sourceID === row.sourceID);
            return source ? source.name : String(row.sourceID);
        }).join(', ') || 'No active front route';
}

module.exports = {AudioOutput, PcmConverter, readDevice, readFrontSource, HELPER};
