'use strict';
/**
 * model.js - the analysis behind Eco Coach. Pure module (no kit, no car): main.js feeds it one tick a
 * second, the offline tests feed it simulated drives.
 *
 * tick = { t (ms), dt (s), v (km/h, mean of the second), acc (m/s², dv/dt), lph (l/h or null), gear (1..10 or
 *          null), stage ('P' 'R' 'N' 'D' or null), pedal (% or null), rpm, coolant (°C), outside (°C),
 *          mode ('eco' 'comfort' 'sport' or null), slope (fraction, + = uphill, or null), ac (bool or null),
 *          engineOn (bool) }
 *
 *   classify(tick)        -> 'off' 'idle' 'cruise' 'accel' 'coast' 'brake' 'transient'
 *   Trip                  distance, fuel, time and fuel per class, hard events; score() and tips()
 *   CruiseCollector       steady stretches (8..20 s) -> map samples { v, lph, l100, gear, slope, ... }
 *   fit(samples)          consumption model lph = f(speed, slope, temperature, engine warm, mode, A/C)
 *                         by weighted ridge least squares; curve(), sweetSpot(), effects()
 *   gearTable(samples)    the most economical gear per 10 km/h band (slope-corrected)
 */

const G0 = 9.80665;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const LIMITS = {
    idleKmh: 3,           // below: standing
    cruiseAcc: 0.25,      // m/s²: steady within
    accelAcc: 0.35,       // m/s²: accelerating from
    hardAcc: 1.8,         // m/s²: a hard acceleration
    hardBrake: -1.8,      // m/s²: a hard brake (late anticipation)
    coldEngine: 70,       // °C coolant: engine still cold below
    refOutside: 15,       // °C: the model's reference outside temperature
};

/** One tick's driving state. */
function classify(k) {
    if (!k.engineOn && !(k.v > LIMITS.idleKmh)) return 'off';
    if (!(k.v > LIMITS.idleKmh)) return 'idle';
    const a = isNum(k.acc) ? k.acc : 0;
    if (a <= LIMITS.hardBrake) return 'brake';
    if (a < -LIMITS.cruiseAcc && (k.pedal === null || k.pedal === undefined || k.pedal < 2)) return 'coast';
    if (a > LIMITS.accelAcc) return 'accel';
    if (Math.abs(a) <= LIMITS.cruiseAcc) return 'cruise';
    return 'transient';
}

/* ---------------- trips ---------------- */

class Trip {
    constructor(t0, fuel) {
        this.t0 = t0; this.t1 = t0; this.fuelType = fuel ? fuel.id : null;
        this.km = 0; this.kmFuel = 0; this.litres = 0; this.secs = 0; this.secsFuel = 0;
        this.time = {}; this.fuelBy = {}; this.km130 = 0; this.vmax = 0;
        this.hardAccel = 0; this.hardBrake = 0; this._hardA = false; this._hardB = false;
        this.highRpmSecs = 0; this.cruiseSecs = 0; this.coldSecs = 0; this.decelSecs = 0;
        this.outside = []; this.startOdo = null;
    }
    add(k, cls, fuel) {
        const dt = isNum(k.dt) ? clamp(k.dt, 0, 5) : 1, km = (k.v || 0) * dt / 3600;
        this.t1 = k.t; this.secs += dt; this.km += km; this.vmax = Math.max(this.vmax, k.v || 0);
        if (k.v > 130) this.km130 += km;
        this.time[cls] = (this.time[cls] || 0) + dt;
        if (isNum(k.lph)) {
            const l = k.lph * dt / 3600;
            this.litres += l; this.kmFuel += km; this.secsFuel += dt;
            this.fuelBy[cls] = (this.fuelBy[cls] || 0) + l;
        }
        const hardA = cls === 'accel' && k.acc >= LIMITS.hardAcc, hardB = cls === 'brake';
        if (hardA && !this._hardA) this.hardAccel++;
        if (hardB && !this._hardB) this.hardBrake++;
        this._hardA = hardA; this._hardB = hardB;
        if (isNum(k.acc) && k.acc < -0.3 && k.v > LIMITS.idleKmh) this.decelSecs += dt;
        if (cls === 'cruise' && k.v > 40) {
            this.cruiseSecs += dt;
            const limit = (fuel && fuel.efficientRpm) || 2200;
            if (isNum(k.rpm) && k.rpm > limit) this.highRpmSecs += dt;
        }
        if (isNum(k.coolant) && k.coolant < LIMITS.coldEngine && k.engineOn) this.coldSecs += dt;
        if (isNum(k.outside) && this.outside.length < 400) this.outside.push(k.outside);
    }
    /** l/100 km over the distance with a known fuel figure (null: too little of it) */
    l100() { return this.kmFuel > 0.3 ? this.litres / this.kmFuel * 100 : null; }
    /** share of the drive with a fuel figure (0..1) */
    coverage() { return this.secs ? this.secsFuel / this.secs : 0; }
    drivingSecs() { return this.secs - (this.time.off || 0); }

    /**
     * Driving-style score 0..100 (higher = more economical), in parts that each show what to change:
     *   accel 30, anticipation 25, gear 25, idle 10, speed 10.
     */
    score() {
        const drive = Math.max(1, this.drivingSecs()), accelT = (this.time.accel || 0);
        const hardShare = accelT > 0 ? Math.min(1, this.hardAccel * 3 / Math.max(accelT, 3)) : 0;
        const brakeShare = this.decelSecs > 0 ? Math.min(1, (this.time.brake || 0) / this.decelSecs) : 0;
        const rpmShare = this.cruiseSecs > 0 ? this.highRpmSecs / this.cruiseSecs : 0;
        const idleShare = (this.time.idle || 0) / drive, fastShare = this.km > 0 ? this.km130 / this.km : 0;
        const parts = {
            accel: 30 * (1 - Math.min(1, hardShare * 2.5)),
            anticipation: 25 * (1 - Math.min(1, brakeShare * 3)),
            gear: 25 * (1 - Math.min(1, rpmShare * 2)),
            idle: 10 * (1 - Math.min(1, Math.max(0, idleShare - 0.05) * 4)),
            speed: 10 * (1 - Math.min(1, fastShare * 2)),
        };
        const total = Object.keys(parts).reduce((s, n) => s + parts[n], 0);
        return { total: Math.round(total), parts, max: { accel: 30, anticipation: 25, gear: 25, idle: 10, speed: 10 } };
    }

    /** Up to 3 concrete tips, the weakest part first; model (optional) adds what the speed cost. */
    tips(model, fuel) {
        const sc = this.score(), out = [];
        const weak = Object.keys(sc.parts).map((n) => ({ n, lost: sc.max[n] - sc.parts[n] })).filter((x) => x.lost >= 2)
            .sort((a, b) => b.lost - a.lost);
        const idleL = this.fuelBy.idle || 0;
        for (const w of weak) {
            if (w.n === 'accel') out.push(this.hardAccel + ' hard accelerations: build speed more gently, shift early');
            else if (w.n === 'anticipation') out.push(this.hardBrake + ' hard brakes: lift off earlier and let the car roll');
            else if (w.n === 'gear') out.push('High rpm while cruising: use a higher gear / ECO PRO');
            else if (w.n === 'idle') out.push(Math.round((this.time.idle || 0) / 60) + ' min idling' + (idleL > 0.05 ? ' cost ' + idleL.toFixed(2) + ' l' : '') + ': use auto start-stop');
            else if (w.n === 'speed') {
                let s = Math.round(this.km130) + ' km above 130 km/h';
                if (model && model.ok) {
                    const at = (v) => model.l100(v), fast = Math.min(160, Math.max(135, this.vmax * 0.9));
                    const extra = at(fast) - at(120);
                    if (isNum(extra) && extra > 0) s += ': about +' + extra.toFixed(1) + ' l/100 km against 120';
                }
                out.push(s);
            }
            if (out.length >= 3) break;
        }
        if (!out.length) out.push('Smooth drive: nothing to improve on this trip');
        return out;
    }

    summary(fuel) {
        const sc = this.score(), l100 = this.l100();
        return {
            t0: this.t0, t1: this.t1, km: round(this.km, 1), litres: round(this.litres, 2), l100: l100 === null ? null : round(l100, 2),
            coverage: round(this.coverage(), 2), mins: Math.round(this.secs / 60), score: sc.total,
            parts: mapValues(sc.parts, (x) => round(x, 1)), hardAccel: this.hardAccel, hardBrake: this.hardBrake,
            idleMin: round((this.time.idle || 0) / 60, 1), idleL: round(this.fuelBy.idle || 0, 2), km130: round(this.km130, 1),
            co2: fuel ? round(this.litres * fuel.co2, 1) : null, outside: this.outside.length ? round(mean(this.outside), 1) : null,
            fuelType: this.fuelType,
        };
    }
}

function round(x, d) { if (!isNum(x)) return null; const f = Math.pow(10, d || 0); return Math.round(x * f) / f; }
function mapValues(o, fn) { const r = {}; Object.keys(o).forEach((k) => { r[k] = fn(o[k]); }); return r; }

/* ---------------- steady stretches -> map samples ---------------- */

/** One map sample from steady ticks (all with a fuel figure). */
function sampleFrom(ticks, src) {
    const v = mean(ticks.map((k) => k.v)), lph = mean(ticks.map((k) => k.lph));
    const pick = (f) => { const a = ticks.map(f).filter(isNum); return a.length ? mean(a) : null; };
    const last = ticks[ticks.length - 1];
    const sd = Math.sqrt(mean(ticks.map((k) => (k.v - v) * (k.v - v))));
    return {
        at: last.t, src: src || 'drive', n: ticks.length, v: round(v, 2), sd: round(sd, 2), lph: round(lph, 3),
        l100: round(lph / v * 100, 3), gear: last.gear || null, slope: round(pick((k) => k.slope), 4),
        outside: round(pick((k) => k.outside), 1), coolant: round(pick((k) => k.coolant), 0),
        mode: last.mode || null, ac: typeof last.ac === 'boolean' ? last.ac : null, rpm: round(pick((k) => k.rpm), 0),
    };
}

/**
 * Cuts the drive's steady stretches (cruise, same gear, speed within ±3 km/h, a fuel figure in every tick)
 * into map samples: one every maxS seconds, or the rest of a stretch of at least minS seconds when it ends.
 */
class CruiseCollector {
    constructor(opts) { this.minS = (opts && opts.minS) || 8; this.maxS = (opts && opts.maxS) || 20; this.run = []; }
    feed(k, cls) {
        const ok = cls === 'cruise' && isNum(k.lph) && k.v > 20;
        const first = this.run[0];
        const fits = ok && (!first || ((k.gear || null) === (first.gear || null) && Math.abs(k.v - first.v) <= 3 && (k.mode || null) === (first.mode || null)));
        let out = null;
        if (!fits) {
            if (this.run.length >= this.minS) out = sampleFrom(this.run, 'drive');
            this.run = ok ? [k] : [];
            return out;
        }
        this.run.push(k);
        if (this.run.length >= this.maxS) { out = sampleFrom(this.run, 'drive'); this.run = []; }
        return out;
    }
}

/* ---------------- the consumption model ---------------- */

/**
 * Features of a sample for lph: base (idle-like), speed (rolling + drivetrain), speed³ (air), the slope's
 * climbing power, the outside temperature below 15 °C (cold oil, denser air: grows with speed), a cold
 * engine, ECO PRO and Sport against Comfort, and the A/C.
 */
const FEATURES = [
    { id: 'base', f: () => 1, always: true },
    { id: 'speed', f: (s) => s.v / 100, always: true },
    { id: 'air', f: (s) => Math.pow(s.v / 100, 3), always: true },
    { id: 'slope', f: (s) => (s.v / 100) * (isNum(s.slope) ? s.slope * 100 : 0) },
    { id: 'cold', f: (s) => (isNum(s.outside) ? Math.max(0, LIMITS.refOutside - s.outside) / 10 : 0) * (0.5 + s.v / 100) },
    { id: 'engineCold', f: (s) => (isNum(s.coolant) && s.coolant < LIMITS.coldEngine ? 1 : 0) },
    { id: 'eco', f: (s) => (s.mode === 'eco' ? s.v / 100 : 0) },
    { id: 'sport', f: (s) => (s.mode === 'sport' ? s.v / 100 : 0) },
    { id: 'ac', f: (s) => (s.ac === true ? 1 : 0) },
];

/** Solve A x = b (n x n) by Gaussian elimination with partial pivoting; null if singular. */
function solve(A, b) {
    const n = b.length, M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-12) return null;
        if (p !== c) { const tmp = M[p]; M[p] = M[c]; M[c] = tmp; }
        for (let r = c + 1; r < n; r++) {
            const f = M[r][c] / M[c][c];
            for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = M[r][n];
        for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
        x[r] = s / M[r][r];
    }
    return x;
}

/**
 * Fit the model to map samples. A factor is only in the model when enough samples show it both ways
 * (>= 12 with and >= 12 without, or a spread for the continuous ones). Test samples weigh 3, everyday 1.
 * Returns a Model (model.ok false: too little data, under 20 samples or under 3 speed bands of 10 km/h).
 */
function fit(samples, opts) {
    const minN = (opts && opts.minN) || 20;
    const S = (samples || []).filter((s) => isNum(s.v) && isNum(s.lph) && s.v > 15 && s.lph >= 0);
    const bands = new Set(S.map((s) => Math.round(s.v / 10)));
    if (S.length < minN || bands.size < 3) return new Model(null, [], S.length, bands.size);
    const use = FEATURES.filter((F) => {
        if (F.always) return true;
        const vals = S.map(F.f), nz = vals.filter((x) => Math.abs(x) > 1e-9).length;
        if (F.id === 'slope' || F.id === 'cold') {
            const m = mean(vals), sd = Math.sqrt(mean(vals.map((x) => (x - m) * (x - m))));
            return nz >= 12 && sd > (F.id === 'slope' ? 0.15 : 0.1);
        }
        return nz >= 12 && S.length - nz >= 12;
    });
    const n = use.length, A = [], b = new Array(n).fill(0);
    for (let i = 0; i < n; i++) A.push(new Array(n).fill(0));
    let wsum = 0;
    for (const s of S) {
        const w = s.src === 'test' ? 3 : 1, x = use.map((F) => F.f(s));
        wsum += w;
        for (let i = 0; i < n; i++) {
            b[i] += w * x[i] * s.lph;
            for (let j = 0; j < n; j++) A[i][j] += w * x[i] * x[j];
        }
    }
    // a little ridge on everything but the base so a factor seen rarely stays small
    for (let i = 1; i < n; i++) A[i][i] += 0.02 * wsum / S.length;
    const beta = solve(A, b);
    if (!beta || beta.some((x) => !isNum(x))) return new Model(null, [], S.length, bands.size);
    const coef = {};
    use.forEach((F, i) => { coef[F.id] = beta[i]; });
    // R²
    const ys = S.map((s) => s.lph), my = mean(ys);
    let ssr = 0, sst = 0;
    S.forEach((s) => { const p = predict(coef, s); ssr += (s.lph - p) * (s.lph - p); sst += (s.lph - my) * (s.lph - my); });
    const vs = S.map((s) => s.v);
    return new Model(coef, use.map((F) => F.id), S.length, bands.size, sst > 0 ? 1 - ssr / sst : null,
        [Math.min.apply(null, vs), Math.max.apply(null, vs)]);
}

function predict(coef, s) {
    let y = 0;
    for (const F of FEATURES) if (coef[F.id] !== undefined) y += coef[F.id] * F.f(s);
    return y;
}

/** The reference conditions: level road, 15 °C, warm engine, Comfort, A/C off. */
const REF = { slope: 0, outside: LIMITS.refOutside, coolant: 90, mode: 'comfort', ac: false };

class Model {
    constructor(coef, used, n, bands, r2, range) {
        this.coef = coef; this.used = used; this.n = n; this.bands = bands; this.r2 = isNum(r2) ? r2 : null;
        this.range = range || null; this.ok = !!coef;
    }
    lph(v, cond) { return this.ok ? Math.max(0, predict(this.coef, Object.assign({}, REF, cond || {}, { v }))) : null; }
    l100(v, cond) { const l = this.lph(v, cond); return l === null || !(v > 0) ? null : l / v * 100; }
    /** [[v, l/100]] from lo to hi km/h */
    curve(lo, hi, step, cond) {
        if (!this.ok) return [];
        const out = [];
        for (let v = lo; v <= hi + 1e-9; v += step || 5) out.push([v, this.l100(v, cond)]);
        return out;
    }
    /**
     * The speed with the least fuel per km (reference conditions), within the measured speed range (±10 km/h,
     * at least 40 km/h): { v, l100, inside } or null.
     */
    sweetSpot(cond) {
        if (!this.ok || !this.range) return null;
        const lo = Math.max(40, Math.floor(this.range[0] - 10)), hi = Math.ceil(this.range[1] + 10);
        let best = null;
        for (let v = lo; v <= hi; v++) { const c = this.l100(v, cond); if (isNum(c) && (!best || c < best.l100)) best = { v, l100: c }; }
        if (best) best.inside = best.v > lo && best.v < hi;
        return best;
    }
    /**
     * What each factor costs at 100 km/h (and per +10 km/h at 100 and 130), in % against the reference:
     * [{ id, label, pct, l100 }]. Only factors the model has.
     */
    effects() {
        if (!this.ok) return [];
        const base = this.l100(100), out = [];
        const add = (id, label, val) => { if (isNum(val) && base > 0) out.push({ id, label, l100: val - base, pct: (val - base) / base * 100 }); };
        add('v110', '110 instead of 100 km/h', this.l100(110));
        const b130 = this.l100(130), b140 = this.l100(140);
        if (isNum(b130) && isNum(b140) && b130 > 0) out.push({ id: 'v140', label: '140 instead of 130 km/h', l100: b140 - b130, pct: (b140 - b130) / b130 * 100 });
        if (this.coef.cold !== undefined) add('cold', '10 °C colder (5 instead of 15 °C)', this.l100(100, { outside: 5 }));
        if (this.coef.slope !== undefined) add('slope', '1 % uphill', this.l100(100, { slope: 0.01 }));
        if (this.coef.engineCold !== undefined) add('engineCold', 'Cold engine (< 70 °C)', this.l100(100, { coolant: 50 }));
        if (this.coef.eco !== undefined) add('eco', 'ECO PRO instead of Comfort', this.l100(100, { mode: 'eco' }));
        if (this.coef.sport !== undefined) add('sport', 'Sport instead of Comfort', this.l100(100, { mode: 'sport' }));
        if (this.coef.ac !== undefined) add('ac', 'A/C on', this.l100(100, { ac: true }));
        return out;
    }
    toJSON() { return { coef: this.coef, used: this.used, n: this.n, bands: this.bands, r2: this.r2, range: this.range }; }
}

/**
 * The most economical gear per 10 km/h band: { band (km/h, centre), gears: [{ gear, l100, n }], best, saving
 * (% of the most-used gear) }; l/100 km corrected to a level road with the model's slope term, where it has one.
 */
function gearTable(samples, model, minN) {
    minN = minN || 3;
    const bands = {};
    for (const s of samples || []) {
        if (!isNum(s.gear) || !isNum(s.l100) || !(s.v > 25)) continue;
        let c = s.l100;
        if (model && model.ok && model.coef.slope !== undefined && isNum(s.slope)) {
            const flat = model.l100(s.v, { slope: 0 }), tilted = model.l100(s.v, { slope: s.slope });
            if (isNum(flat) && isNum(tilted)) c -= tilted - flat;
        }
        const band = Math.round(s.v / 10) * 10;
        const g = (bands[band] = bands[band] || {});
        (g[s.gear] = g[s.gear] || []).push(c);
    }
    return Object.keys(bands).map(Number).sort((a, b) => a - b).map((band) => {
        const gears = Object.keys(bands[band]).map(Number).map((gear) => ({ gear, n: bands[band][gear].length, l100: mean(bands[band][gear]) }))
            .filter((g) => g.n >= minN).sort((a, b) => a.gear - b.gear);
        if (!gears.length) return null;
        const best = gears.reduce((a, b) => (b.l100 < a.l100 ? b : a));
        const most = gears.reduce((a, b) => (b.n > a.n ? b : a));
        return { band, gears, best: best.gear, saving: most.l100 > 0 ? (most.l100 - best.l100) / most.l100 * 100 : 0, usual: most.gear };
    }).filter(Boolean);
}

module.exports = { G0, LIMITS, FEATURES, REF, classify, Trip, CruiseCollector, sampleFrom, fit, solve, predict, Model, gearTable, mean, round, isNum };
