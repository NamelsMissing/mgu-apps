/*
 * synth.js - real-time engine sound synthesis for Active Sound.
 *
 * Runs on the head unit (Node 8, PCM for ALSA / WAV export) and on the phone (AudioWorklet
 * or ScriptProcessor). Same code, same sound. ES2015 only, no dependencies.
 *
 *   var s = new EngineSynth(44100, profile, seed);
 *   s.set(rpm, load, on, volume);   // targets; smoothed per sample
 *   s.render(left, right, n);       // fills two Float32Arrays (or one, mono) with n samples
 *
 * Combustion model: a crank phase runs at rpm; every firing point it crosses sends one
 * impulse (cylinder strength x load x random variation) into a bank of exhaust resonators
 * plus a low "thump" filter; a harmonic layer of engine orders keeps high rpm smooth.
 * Extras: intake roar, turbo spool + whistle + blow-off, supercharger / e-motor whine,
 * diesel knock, overrun crackle, rev limiter. Everything ends in a cabin low-pass, DC block,
 * level normalisation per profile and a soft clipper (never above 0.95 full scale).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ActiveSoundSynth = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
    'use strict';
    var TAU = Math.PI * 2;
    var TARGET_RMS = 0.16;            // per-profile loudness at the calibration point
    var CONTROL = 32;                 // samples between filter coefficient updates

    /** RBJ biquad (direct form I). */
    function Biquad() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.reset(); }
    Biquad.prototype.reset = function () { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; };
    Biquad.prototype._set = function (b0, b1, b2, a0, a1, a2) {
        this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    };
    Biquad.prototype.bandpass = function (f, q, sr) {        // constant 0 dB peak gain
        f = Math.max(10, Math.min(f, sr * 0.45));
        var w = TAU * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
        this._set(al, 0, -al, 1 + al, -2 * c, 1 - al); return this;
    };
    Biquad.prototype.lowpass = function (f, q, sr) {
        f = Math.max(10, Math.min(f, sr * 0.45));
        var w = TAU * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
        this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); return this;
    };
    Biquad.prototype.highpass = function (f, q, sr) {
        f = Math.max(10, Math.min(f, sr * 0.45));
        var w = TAU * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
        this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); return this;
    };
    Biquad.prototype.run = function (x) {
        var y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
        this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
        return y;
    };

    function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
    function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

    function EngineSynth(sampleRate, profile, seed) {
        this.sr = sampleRate || 44100;
        this.seed = (seed >>> 0) || 0x9e3779b9;
        this.rnd = this.seed;
        // smoothing coefficients (per sample)
        var k = function (seconds, sr) { return 1 - Math.exp(-1 / (sr * seconds)); };
        this.kRpm = k(0.07, this.sr); this.kUp = k(0.05, this.sr); this.kDown = k(0.12, this.sr);
        this.kGate = k(0.25, this.sr); this.kGateOff = k(0.12, this.sr); this.kVol = k(0.08, this.sr);
        this.kSpoolUp = k(0.7, this.sr); this.kSpoolDown = k(0.25, this.sr);
        this.tRpm = 0; this.tLoad = 0; this.tOn = 0; this.tVol = 0.5;
        this.vol = 0.5;
        this.setProfile(profile);
    }
    var P = EngineSynth.prototype;

    P.random = function () {                       // xorshift32 in [0, 1)
        var x = this.rnd;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        this.rnd = x >>> 0;
        return this.rnd / 4294967296;
    };
    P.noise = function () { return this.random() * 2 - 1; };

    /** Targets from the car (or the demo): virtual rpm, load 0..1, sound on, volume 0..1. */
    P.set = function (rpm, load, on, volume) {
        this.tRpm = isFinite(rpm) ? clamp(rpm, 0, 20000) : 0;
        this.tLoad = isFinite(load) ? clamp(load, 0, 1) : 0;
        this.tOn = on ? 1 : 0;
        if (volume !== undefined && isFinite(volume)) this.tVol = clamp(volume, 0, 1);
    };

    P.setProfile = function (profile) {
        if (!profile) throw new Error('no profile');
        this.p = profile;
        this._build();
        this.norm = 1;
        this._calibrate();
        this._resetState(true);
    };

    P._build = function () {
        var p = this.p, sr = this.sr, i;
        this.tonal = p.kind === 'tonal';
        var n = this.tonal ? 0 : p.cyl;
        var fire = [];
        for (i = 0; i < n; i++) {
            var at = p.fire && p.fire[i] !== undefined ? p.fire[i] : i / n;
            fire.push({ at: ((at % 1) + 1) % 1, amp: p.amp && p.amp[i] !== undefined ? p.amp[i] : 1 });
        }
        fire.sort(function (a, b) { return a.at - b.at; });
        this.fireAt = fire.map(function (f) { return f.at; });
        this.fireAmp = fire.map(function (f) { return f.amp; });
        this.body = (p.body || []).map(function (b) { return { f: new Biquad().bandpass(b[0], b[1], sr), g: b[2] }; });
        this.thumpF = new Biquad();
        this.thumpF2 = new Biquad();
        this.intakeF = new Biquad();
        this.bovF = new Biquad().bandpass(2300, 1.4, sr);
        this.knockF = new Biquad().bandpass(2800, 1.6, sr);
        this.popF = new Biquad().lowpass(1700, 0.9, sr);
        this.noiseF = new Biquad();
        this.toneF = new Biquad();
        this.toneF2 = new Biquad();
        this.dcF = new Biquad().highpass(28, 0.7, sr);
        this.orders = (p.orders || []).map(function (o) { return { o: o[0], g: o[1] }; });
        this.layers = (p.layers || []).map(function (l) { return { r: l[0], g: l[1], ph: 0, ph2: 0 }; });
    };

    P._resetState = function (hard) {
        this.th = 0; this.base = 0; this.fi = 0;
        this.nextAt = this.fireAt.length ? this.fireAt[0] : 1e9;
        this.phRev = 0; this.phWhine = 0; this.phBlow = 0; this.phHum = 0; this.phTurbo = 0; this.phFm = 0;
        this.carry = 0; this.env = 0; this.knockEnv = 0; this.popEnv = 0; this.bovEnv = 0;
        this.boost = 0; this.loadHist = 0; this.lastRpm = 0;
        this.ctl = 0;
        this.body.forEach(function (b) { b.f.reset(); });
        [this.thumpF, this.thumpF2, this.intakeF, this.bovF, this.knockF, this.popF, this.noiseF,
            this.toneF, this.toneF2, this.dcF].forEach(function (f) { f.reset(); });
        this.layers.forEach(function (l) { l.ph = 0; l.ph2 = 0; });
        if (hard) { this.rpm = this.tRpm; this.load = this.tLoad; this.gate = this.tOn; this.vol = this.tVol; }
    };

    /** Level matching between profiles: render a mid-range pull and scale to TARGET_RMS. */
    P._calibrate = function () {
        var p = this.p, keep = { rpm: this.tRpm, load: this.tLoad, on: this.tOn, vol: this.tVol };
        var rpm = p.idle + 0.55 * (p.redline - p.idle);
        this.tRpm = rpm; this.tLoad = 0.7; this.tOn = 1; this.tVol = 1;
        this._resetState(true);
        this.calibrating = true;
        var n = Math.round(this.sr * 0.35), skip = Math.round(this.sr * 0.1), sum = 0, buf = new Float32Array(n);
        this._renderRaw(buf, n);
        for (var i = skip; i < n; i++) sum += buf[i] * buf[i];
        var rms = Math.sqrt(sum / (n - skip));
        this.norm = rms > 1e-6 ? TARGET_RMS / rms : 1;
        this.calibrating = false;
        this.rnd = this.seed;
        this.tRpm = keep.rpm; this.tLoad = keep.load; this.tOn = keep.on; this.tVol = keep.vol;
    };

    /** Coefficients that follow rpm / load, updated every CONTROL samples. */
    P._control = function () {
        var p = this.p, sr = this.sr, rpmN = this.rpmN;
        var fFire = this.tonal ? 0 : this.rpm / 60 / p.cycle * p.cyl;
        this.thumpF.lowpass(clamp(fFire * 1.6 + 45, 50, 900), 1.2, sr);
        this.thumpF2.lowpass(clamp(fFire * 2.5 + 80, 80, 1400), 0.7, sr);
        this.intakeF.bandpass(350 + 1600 * rpmN, 0.8, sr);
        var cut = p.tone * (0.65 + 0.35 * this.load) + p.bright * rpmN * (0.3 + 0.7 * this.load);
        this.toneF.lowpass(cut, 0.6, sr);
        this.toneF2.lowpass(cut * 1.4, 0.6, sr);
        if (this.tonal && p.noise) this.noiseF.bandpass(p.noise.f0 + (p.noise.f1 - p.noise.f0) * rpmN, p.noise.q, sr);
    };

    P._fire = function (i, frac) {
        var p = this.p;
        if (this.limiter && this.random() < 0.55) { this.popEnv = Math.max(this.popEnv, 0.35 * (p.pops || 0)); return; }
        var idleness = 1 - this.rpmN;
        var rough = (p.rough || 0) * (0.3 + 0.7 * idleness * idleness);
        var lvl = this.fireAmp[i] * (1 + rough * this.noise()) * (0.3 + 0.7 * this.load) * (0.6 + 0.4 * this.rpmN);
        // linear split of the impulse between this and the next sample (sub-sample timing)
        this.imp += lvl * (1 - frac);
        this.carry += lvl * frac;
        if (lvl > this.env) this.env = lvl;
        if (p.knock) this.knockEnv = Math.max(this.knockEnv, lvl * (1.1 - 0.6 * this.load));
        // overrun: throttle closed, rpm falling from higher up -> unburnt fuel pops
        if (p.pops && this.load < 0.08 && this.rpmN > 0.3 && this.falling && this.random() < 0.06 * p.pops) {
            this.popEnv = Math.max(this.popEnv, (0.5 + 0.5 * this.random()) * p.pops);
        }
    };

    P._renderRaw = function (outL, n, outR) {
        var p = this.p, sr = this.sr, i, k;
        var decay = Math.exp(-1 / (sr * (p.decay || 0.006)));
        var knockDecay = Math.exp(-1 / (sr * 0.0018));
        var popDecay = Math.exp(-1 / (sr * 0.022));
        var bovDecay = Math.exp(-1 / (sr * 0.35));
        var span = Math.max(1, p.redline - p.idle);
        for (var s = 0; s < n; s++) {
            // ---- smoothing of the targets
            this.rpm += (this.tRpm - this.rpm) * this.kRpm;
            this.load += (this.tLoad - this.load) * (this.tLoad > this.load ? this.kUp : this.kDown);
            this.gate += (this.tOn - this.gate) * (this.tOn ? this.kGate : this.kGateOff);
            if (!this.tOn && this.gate < 1e-3) this.gate = 0;
            this.vol += (this.tVol - this.vol) * this.kVol;
            this.rpmN = clamp((this.rpm - p.idle) / span, 0, 1);
            if ((this.ctl++ & (CONTROL - 1)) === 0) {
                this.falling = this.rpm < this.lastRpm - 0.5;
                this.lastRpm = this.rpm;
                this.limiter = !this.tonal && this.tRpm >= p.redline * 0.995 && this.load > 0.5;
                // blow-off: boost was up and the throttle closed quickly
                if (p.turbo && p.turbo.bov && this.boost > 0.45 && this.loadHist - this.load > 0.25) {
                    this.bovEnv = Math.max(this.bovEnv, this.boost);
                    this.boost *= 0.5;
                }
                this.loadHist += (this.load - this.loadHist) * 0.08;
                this._control();
            }
            var x = 0;
            if (this.gate === 0 && this.tOn === 0) { outL[s] = 0; if (outR) outR[s] = 0; continue; }
            var rpmHz = this.rpm / 60;

            if (!this.tonal) {
                // ---- firing pulses
                this.imp = this.carry; this.carry = 0;
                if (this.rpm > 60) {
                    var dth = rpmHz / p.cycle / sr, th = this.th + dth;
                    while (th >= this.nextAt) {
                        this._fire(this.fi, clamp((th - this.nextAt) / dth, 0, 1));
                        this.fi++;
                        if (this.fi >= this.fireAt.length) { this.fi = 0; this.base += 1; }
                        this.nextAt = this.base + this.fireAt[this.fi];
                    }
                    if (th >= 1) { th -= 1; this.base -= 1; this.nextAt -= 1; }
                    this.th = th;
                }
                this.env *= decay;
                var exc = this.imp + this.env * (p.grit || 0) * this.noise() * 0.6;
                var body = 0;
                for (k = 0; k < this.body.length; k++) body += this.body[k].f.run(exc) * this.body[k].g;
                var thump = this.thumpF2.run(this.thumpF.run(this.imp)) * (p.thump || 0) * 6;
                x = body * 3 + thump;
                // ---- harmonic layer (engine orders)
                this.phRev += rpmHz / sr; if (this.phRev >= 64) this.phRev -= 64;
                var h = 0;
                for (k = 0; k < this.orders.length; k++) h += Math.sin(TAU * this.phRev * this.orders[k].o) * this.orders[k].g;
                x += h * 0.22 * (0.35 + 0.65 * this.load) * (0.5 + 0.5 * this.rpmN);
                // ---- knock / clatter
                if (p.knock) { this.knockEnv *= knockDecay; x += this.knockF.run(this.noise() * this.knockEnv) * p.knock * 2.5; }
                // ---- overrun crackle
                if (this.popEnv > 1e-3) {
                    this.popEnv *= popDecay;
                    x += this.popF.run(this.noise() * this.popEnv) * 1.6 + (this.random() < 0.002 ? this.popEnv * 1.5 : 0);
                }
            } else {
                // ---- tonal (electric / turbine)
                var fm = 1 + (p.fm || 0) * Math.sin(TAU * this.phFm);
                this.phFm += 5.3 / sr; if (this.phFm >= 1) this.phFm -= 1;
                var bright = 0.25 + 0.75 * this.load;
                for (k = 0; k < this.layers.length; k++) {
                    var L = this.layers[k], f = rpmHz * L.r * fm;
                    L.ph += f / sr; if (L.ph >= 1) L.ph -= 1;
                    L.ph2 += f * 2.003 / sr; if (L.ph2 >= 1) L.ph2 -= 1;
                    x += (Math.sin(TAU * L.ph) + 0.35 * bright * Math.sin(TAU * L.ph2)) * L.g;
                }
                x *= 0.5 * (0.15 + 0.85 * smoothstep(0, 0.06, this.rpm / Math.max(1, p.redline)));
                if (p.noise) x += this.noiseF.run(this.noise()) * p.noise.gain * (0.2 + 0.8 * this.rpmN) * (0.5 + 0.5 * this.load);
                if (p.hum) {
                    this.phHum += p.hum / sr; if (this.phHum >= 1) this.phHum -= 1;
                    x += Math.sin(TAU * this.phHum) * 0.12 * (0.3 + 0.7 * this.load);
                }
            }
            // ---- intake roar
            if (p.intake) x += this.intakeF.run(this.noise()) * p.intake * this.load * (0.3 + 0.7 * this.rpmN) * 0.9;
            // ---- turbo spool, whistle, blow-off
            if (p.turbo) {
                var want = Math.pow(this.load, 1.5) * smoothstep(0.12, 0.45, this.rpmN);
                this.boost += (want - this.boost) * (want > this.boost ? this.kSpoolUp : this.kSpoolDown);
                var wf = p.turbo.whistle * (0.3 + 0.7 * this.boost);
                this.phTurbo += wf / sr; if (this.phTurbo >= 1) this.phTurbo -= 1;
                x += Math.sin(TAU * this.phTurbo) * p.turbo.gain * this.boost * this.boost * 1.5;
                if (this.bovEnv > 1e-3) { this.bovEnv *= bovDecay; x += this.bovF.run(this.noise()) * this.bovEnv * p.turbo.bov * 4; }
            }
            // ---- supercharger / e-motor whine
            if (p.blower) {
                this.phBlow += rpmHz * p.blower.ratio / sr; if (this.phBlow >= 1) this.phBlow -= 1;
                x += Math.sin(TAU * this.phBlow) * p.blower.gain * (0.3 + 0.7 * this.load) * (0.2 + 0.8 * this.rpmN);
            }
            if (p.whine) {
                var whf = p.whine.f0 + (p.whine.f1 - p.whine.f0) * this.rpmN;
                this.phWhine += whf / sr; if (this.phWhine >= 1) this.phWhine -= 1;
                x += Math.sin(TAU * this.phWhine) * p.whine.gain * (0.3 + 0.7 * this.load) * smoothstep(0, 0.1, this.rpmN + 0.02);
            }
            // ---- cabin tone, DC block, level
            x = this.toneF2.run(this.toneF.run(x));
            x = this.dcF.run(x) * this.norm;
            if (!this.calibrating) {
                x *= this.gate * this.vol * this.vol * (0.55 + 0.45 * this.load);
                x = x > 0 ? x / (1 + x * 0.6) : x / (1 - x * 0.6);   // gentle soft clip
                x = clamp(x, -0.95, 0.95);
            }
            outL[s] = x;
            if (outR) outR[s] = x;
        }
    };

    /** Fill left (and right) with n samples. */
    P.render = function (left, right, n) {
        n = n === undefined ? left.length : n;
        this._renderRaw(left, n, right || null);
        return n;
    };
    /** n samples as interleaved signed 16-bit little-endian stereo (Node Buffer). */
    P.renderS16 = function (n) {
        var mono = this._scratch && this._scratch.length >= n ? this._scratch : (this._scratch = new Float32Array(n));
        this._renderRaw(mono, n);
        var out = Buffer.allocUnsafe(n * 4);
        for (var i = 0; i < n; i++) {
            var v = Math.round(mono[i] * 32767);
            out.writeInt16LE(v, i * 4);
            out.writeInt16LE(v, i * 4 + 2);
        }
        return out;
    };
    /** Smoothed state for displays. */
    P.state = function () {
        return { rpm: this.rpm, load: this.load, gate: this.gate, boost: this.boost || 0, limiter: !!this.limiter };
    };

    return { EngineSynth: EngineSynth, Biquad: Biquad, TARGET_RMS: TARGET_RMS };
});
