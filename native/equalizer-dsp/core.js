'use strict';
// Peaking biquad coefficients: RBJ / W3C Audio EQ Cookbook.
// https://www.w3.org/TR/audio-eq-cookbook/
const FREQUENCIES = [100, 200, 500, 1000, 2000, 5000, 10000];
const clone = (v) => JSON.parse(JSON.stringify(v));
const finite = (n) => typeof n === 'number' && isFinite(n);
function defaults() {
    return { enabled: false, preampDb: 0, autoHeadroom: true,
        bands: FREQUENCIES.map((frequencyHz) => ({ frequencyHz, gainDb: 0, q: 1 })) };
}
function validate(v) {
    if (!v || typeof v.enabled !== 'boolean' || typeof v.autoHeadroom !== 'boolean'
        || !finite(v.preampDb) || v.preampDb < -24 || v.preampDb > 0 || !Array.isArray(v.bands) || v.bands.length !== 7) throw new Error('Invalid DSP configuration');
    return { enabled: v.enabled, preampDb: v.preampDb, autoHeadroom: v.autoHeadroom, bands: v.bands.map((b) => {
        if (!b || !finite(b.frequencyHz) || b.frequencyHz < 20 || b.frequencyHz > 20000
            || !finite(b.gainDb) || b.gainDb < -12 || b.gainDb > 12 || !finite(b.q) || b.q < 0.3 || b.q > 6) throw new Error('Invalid DSP band');
        return { frequencyHz: b.frequencyHz, gainDb: b.gainDb, q: b.q };
    }) };
}
function peaking(rate, hz, gain, q) {
    if (!finite(rate) || rate < 44100 || rate > 192000 || !finite(hz) || hz <= 0 || hz >= rate / 2
        || !finite(gain) || !finite(q) || q <= 0) throw new Error('Invalid filter parameters');
    const w = 2 * Math.PI * hz / rate, A = Math.pow(10, gain / 40), alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha / A;
    return { b0: (1 + alpha * A) / a0, b1: -2 * Math.cos(w) / a0, b2: (1 - alpha * A) / a0,
        a1: -2 * Math.cos(w) / a0, a2: (1 - alpha / A) / a0 };
}
function headroom(v) {
    // Sum of each positive bell gain bounds the stationary cascade response.
    // Sample saturation below also bounds transient peaks; it is counted, not hidden.
    return v.preampDb - (v.autoHeadroom ? v.bands.reduce((n, b) => n + Math.max(0, b.gainDb), 0) : 0);
}
function magnitude(c, rate, hz) {
    const w = 2 * Math.PI * hz / rate, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    return Math.sqrt((Math.pow(c.b0 + c.b1 * c1 + c.b2 * c2, 2) + Math.pow(c.b1 * s1 + c.b2 * s2, 2))
        / (Math.pow(1 + c.a1 * c1 + c.a2 * c2, 2) + Math.pow(c.a1 * s1 + c.a2 * s2, 2)));
}
class Bank {
    constructor(config, rate, channels) {
        this.config = config; this.enabled = config.enabled; this.gain = Math.pow(10, headroom(config) / 20);
        this.coefficients = config.bands.map((b) => peaking(rate, b.frequencyHz, b.gainDb, b.q));
        this.z1 = new Float64Array(channels * 7); this.z2 = new Float64Array(channels * 7);
    }
    sample(x, channel) {
        if (!this.enabled) return x;
        x *= this.gain;
        for (let i = 0; i < 7; i++) {
            const k = channel * 7 + i, c = this.coefficients[i];
            const y = c.b0 * x + this.z1[k];
            this.z1[k] = c.b1 * x - c.a1 * y + this.z2[k];
            this.z2[k] = c.b2 * x - c.a2 * y;
            // Suppress denormals during long silence on low-power x86 CPUs.
            if (Math.abs(this.z1[k]) < 1e-30) this.z1[k] = 0;
            if (Math.abs(this.z2[k]) < 1e-30) this.z2[k] = 0;
            x = y;
        }
        return x;
    }
}
class Processor {
    constructor(rate, channels, config) {
        if ([44100, 48000, 88200, 96000].indexOf(rate) < 0 || [1, 2].indexOf(channels) < 0) throw new Error('Unsupported PCM format');
        this.rate = rate; this.channels = channels; this.current = new Bank(validate(config || defaults()), rate, channels);
        this.previous = null; this.queued = null; this.fade = 0; this.fadeFrames = Math.round(rate * 0.025);
        this.history = new Float64Array(2048 * channels); this.historyFrames = 0; this.historyPos = 0;
        this.frames = 0; this.filteredFrames = 0; this.clipped = 0; this.peakIn = 0; this.peakOut = 0;
    }
    configure(config) {
        const next = validate(config);
        if (this.previous) { this.queued = next; return; }
        this.beginTransition(next);
    }
    beginTransition(config) {
        const next = new Bank(config, this.rate, this.channels);
        // Warm the new filters with the actual recent input before a 25 ms crossfade.
        const used = Math.min(2048, this.historyFrames), start = (this.historyPos - used + 2048) % 2048;
        for (let i = 0; i < used; i++) for (let ch = 0; ch < this.channels; ch++) next.sample(this.history[((start + i) % 2048) * this.channels + ch], ch);
        this.previous = this.current; this.current = next; this.fade = this.fadeFrames;
    }
    process(input) {
        if (!Buffer.isBuffer(input) || input.length % (this.channels * 2) || input.length > 16384) throw new Error('Unaligned or oversized PCM block');
        const output = Buffer.allocUnsafe(input.length), frames = input.length / (this.channels * 2);
        for (let frame = 0; frame < frames; frame++) {
            if (this.current.enabled || (this.previous && this.previous.enabled)) this.filteredFrames++;
            const mix = this.previous ? 1 - this.fade / this.fadeFrames : 1;
            for (let ch = 0; ch < this.channels; ch++) {
                const offset = (frame * this.channels + ch) * 2, x = input.readInt16LE(offset) / 32768;
                this.history[this.historyPos * this.channels + ch] = x;
                let y = this.current.sample(x, ch);
                if (this.previous) y = (1 - mix) * this.previous.sample(x, ch) + mix * y;
                this.peakIn = Math.max(this.peakIn, Math.abs(x));
                if (!isFinite(y)) throw new Error('Non-finite DSP output');
                let raw = Math.round(y * 32768);
                if (raw > 32767 || raw < -32768) { this.clipped++; raw = Math.max(-32768, Math.min(32767, raw)); }
                this.peakOut = Math.max(this.peakOut, Math.abs(raw / 32768));
                output.writeInt16LE(raw, offset);
            }
            this.historyPos = (this.historyPos + 1) % 2048; this.historyFrames++;
            if (this.previous && --this.fade <= 0) {
                this.previous = null;
                if (this.queued) {
                    const config = this.queued; this.queued = null;
                    this.beginTransition(config);
                }
            }
        }
        this.frames += frames; return output;
    }
    stats() { return { sampleRate: this.rate, channels: this.channels, format: 's16le', frames: this.frames, filteredFrames: this.filteredFrames, clippedSamples: this.clipped,
        peakIn: this.peakIn, peakOut: this.peakOut, enabled: this.current.enabled, effectivePreampDb: headroom(this.current.config) }; }
}
module.exports = { FREQUENCIES, clone, defaults, validate, peaking, magnitude, headroom, Processor };
