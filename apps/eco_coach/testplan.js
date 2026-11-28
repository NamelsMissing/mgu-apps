'use strict';
/**
 * testplan.js - the interactive consumption test. Pure module: main.js feeds it the same 1 Hz ticks as
 * the analysis (model.js), the offline tests feed it a simulated drive.
 *
 * The test is a set of cells the driver fills in any order while driving normally; nothing has to be
 * pressed while driving. Every second the plan looks at what the car is doing and measures the cell that
 * fits it:
 *   cruise  c<speed>a / c<speed>l   steady at 50 70 90 110 130 (150) km/h in the gearbox's own gear (a) and
 *                                   one gear lower (l): what speed and gear cost
 *   mode    m100eco / m100comfort   steady at 100 km/h in ECO PRO and in Comfort
 *   accel   aGentle aMedium aBrisk  from 35 up to 75 km/h, sorted by the mean acceleration
 *   coast   kSail kOverrun          from 95 down to 65 km/h without the pedal, in neutral / coasting (sail) or
 *                                   in gear with the fuel cut-off (overrun)
 * A steady window counts when, for winS seconds (after 3 s to settle): the speed stays within ±4 km/h of
 * the target with a standard deviation under 1.5 km/h, no gear change, a fuel figure every second, the
 * engine warm, and the road within ±3 % (when the slope is known). Drive each cell in both directions of
 * the same road where you can: the model takes the slope out, both directions take out the wind.
 */
const { round, mean, isNum, LIMITS } = require('./model');

const ACCEL = { from: 35, to: 75, maxS: 45 };
const COAST = { from: 95, to: 65, maxS: 90 };
const STYLE = [['aGentle', 'Gentle', 0, 1.0], ['aMedium', 'Medium', 1.0, 2.0], ['aBrisk', 'Brisk', 2.0, 99]];
const SETTLE_S = 3;

/** The cells of a plan: speeds = target cruise speeds. */
function cells(speeds, withMode) {
    const out = [];
    for (const v of speeds) {
        out.push({ id: 'c' + v + 'a', kind: 'cruise', v, variant: 'auto', label: v + ' km/h, own gear' });
        out.push({ id: 'c' + v + 'l', kind: 'cruise', v, variant: 'low', label: v + ' km/h, one gear lower' });
    }
    if (withMode !== false) {
        out.push({ id: 'm100eco', kind: 'mode', v: 100, mode: 'eco', label: '100 km/h in ECO PRO' });
        out.push({ id: 'm100comfort', kind: 'mode', v: 100, mode: 'comfort', label: '100 km/h in Comfort' });
    }
    STYLE.forEach(([id, name]) => out.push({ id, kind: 'accel', style: name.toLowerCase(), label: name + ' acceleration ' + ACCEL.from + '-' + ACCEL.to }));
    out.push({ id: 'kSail', kind: 'coast', how: 'sail', label: 'Coast in neutral ' + COAST.from + '-' + COAST.to });
    out.push({ id: 'kOverrun', kind: 'coast', how: 'overrun', label: 'Roll in gear (fuel cut-off)' });
    return out;
}

class TestPlan {
    /**
     * opts = { speeds: [50, 70, 90, 110, 130], winS: 20, need: 2, results (saved), autoGear (saved) }
     */
    constructor(opts) {
        opts = opts || {};
        this.speeds = opts.speeds || [50, 70, 90, 110, 130];
        this.winS = opts.winS || 20;
        this.need = opts.need || 2;
        this.cells = cells(this.speeds, opts.withMode);
        this.results = opts.results && typeof opts.results === 'object' ? opts.results : {};
        this.autoGear = opts.autoGear && typeof opts.autoGear === 'object' ? opts.autoGear : {};
        this.active = !!opts.active;
        this.win = null; this.accel = null; this.coast = null; this.last = null; this.prev = null;
        this.modeSeen = false;
    }
    start() { this.active = true; this.win = null; this.accel = null; this.coast = null; this.last = null; }
    stop() { this.active = false; this.win = null; this.accel = null; this.coast = null; }
    clear() { this.results = {}; this.autoGear = {}; this.last = null; this.win = null; }

    count(id) { return (this.results[id] || []).length; }
    done(id) { return this.count(id) >= this.need; }
    cell(id) { return this.cells.find((c) => c.id === id); }
    /** the cells that can be measured in this car (mode cells only once a driving mode came) */
    usable() { return this.cells.filter((c) => c.kind !== 'mode' || this.modeSeen); }
    progress() { const u = this.usable(); return { done: u.filter((c) => this.done(c.id)).length, of: u.length }; }
    complete() { return this.usable().every((c) => this.done(c.id)); }

    _add(id, r) { (this.results[id] = this.results[id] || []).push(r); this.last = { id, ok: true, at: r.at, r }; }
    _fail(id, why, at) { this.last = { id, ok: false, why, at }; }

    /** The next thing to drive: { text, cell } (null when everything is done). */
    next(v) {
        const open = this.usable().filter((c) => !this.done(c.id));
        if (!open.length) return null;
        const cruise = open.filter((c) => c.kind === 'cruise' || c.kind === 'mode');
        if (cruise.length) {
            // the one closest to the speed now, the own gear before the lower one
            const now = isNum(v) ? v : 0;
            cruise.sort((a, b) => Math.abs(a.v - now) - Math.abs(b.v - now) || (a.variant === 'low') - (b.variant === 'low'));
            const c = cruise[0];
            let how = 'cruise control, ';
            if (c.kind === 'mode') how += c.mode === 'eco' ? 'ECO PRO' : 'Comfort';
            else if (c.variant === 'low') how += isNum(this.autoGear[c.v]) ? 'gear ' + (this.autoGear[c.v] - 1) + ' (M/S, paddles)' : 'first in D, then one gear lower';
            else how += 'D';
            return { text: 'Hold ' + c.v + ' km/h - ' + how, cell: c };
        }
        const c = open[0];
        if (c.kind === 'accel') return { text: 'From ' + ACCEL.from + ' km/h or less, accelerate ' + c.style + ' to ' + ACCEL.to + ' km/h', cell: c };
        return { text: 'At ' + COAST.from + '+ km/h lift off and roll to ' + COAST.to + ' km/h ' + (c.how === 'sail' ? 'in N / coasting' : 'in gear'), cell: c };
    }

    /** One tick (model.js format). Returns what is being measured now: { kind, id, label, progress } or null. */
    feed(k) {
        if (k.mode) this.modeSeen = true;
        const prev = this.prev;
        this.prev = k;
        if (!this.active) return null;
        const open = (kind) => this.cells.some((c) => c.kind === kind && !this.done(c.id));
        const a = this._cruise(k), b = open('accel') ? this._accel(k, prev) : null, c = open('coast') ? this._coast(k, prev) : null;
        if (!open('accel')) this.accel = null;
        if (!open('coast')) this.coast = null;
        return a || b || c || null;
    }

    /* ---- steady speed ---- */
    _target(k) {
        const targets = this.speeds.slice();
        if (this.modeSeen) targets.push(100);
        let best = null;
        for (const v of targets) if (Math.abs(k.v - v) <= 4 && (best === null || Math.abs(k.v - v) < Math.abs(k.v - best))) best = v;
        return best;
    }
    _cellFor(target, k) {
        if (target === 100 && this.speeds.indexOf(100) < 0) {
            const id = k.mode === 'eco' ? 'm100eco' : k.mode === 'comfort' ? 'm100comfort' : null;
            return id && !this.done(id) ? id : null;
        }
        // the gearbox's own gear at this speed: the first window in D sets it (the driver starts in D)
        const own = this.autoGear[target];
        let variant = 'auto';
        if (isNum(own) && isNum(k.gear)) {
            if (k.gear === own - 1) variant = 'low';
            else if (k.gear !== own) return null;            // another gear: not a cell of the plan
        }
        const id = 'c' + target + (variant === 'low' ? 'l' : 'a');
        return this.done(id) ? null : id;
    }
    _cruise(k) {
        const target = this._target(k);
        const steady = target !== null && Math.abs(k.acc || 0) <= 0.3 && isNum(k.lph) &&
            !(isNum(k.coolant) && k.coolant < LIMITS.coldEngine) && !(isNum(k.slope) && Math.abs(k.slope) > 0.03);
        const id = steady ? this._cellFor(target, k) : null;
        const w = this.win;
        if (w && (!id || id !== w.id || (k.gear || null) !== w.gear)) {
            if (w.ticks.length >= SETTLE_S + this.winS * 0.5) this._fail(w.id, this._why(k, target, w), k.t);
            this.win = null;
        }
        if (!id) return null;
        if (!this.win) this.win = { id, target, gear: k.gear || null, ticks: [] };
        this.win.ticks.push(k);
        const n = this.win.ticks.length - SETTLE_S;
        if (n >= this.winS) {
            const ticks = this.win.ticks.slice(SETTLE_S), v = mean(ticks.map((x) => x.v));
            const sd = Math.sqrt(mean(ticks.map((x) => (x.v - v) * (x.v - v))));
            const cid = this.win.id;
            this.win = null;
            if (sd > 1.5) { this._fail(cid, 'speed not steady (±' + sd.toFixed(1) + ' km/h)', k.t); return null; }
            const lph = mean(ticks.map((x) => x.lph)), sl = ticks.map((x) => x.slope).filter(isNum);
            const r = { at: k.t, v: round(v, 2), sd: round(sd, 2), lph: round(lph, 3), l100: round(lph / v * 100, 3), gear: k.gear || null,
                slope: sl.length ? round(mean(sl), 4) : null, outside: isNum(k.outside) ? k.outside : null, coolant: isNum(k.coolant) ? k.coolant : null,
                mode: k.mode || null, ac: typeof k.ac === 'boolean' ? k.ac : null, rpm: isNum(k.rpm) ? Math.round(k.rpm) : null, n: ticks.length };
            if (cid[0] === 'c' && cid.slice(-1) === 'a' && isNum(k.gear) && !isNum(this.autoGear[target])) this.autoGear[target] = k.gear;
            this._add(cid, r);
            return null;
        }
        const c = this.cell(this.win.id);
        return { kind: 'cruise', id: this.win.id, label: c ? c.label : this.win.id, progress: Math.max(0, n) / this.winS, settling: n < 0 };
    }
    _why(k, target, w) {
        if (target === null) return 'speed left ' + w.target + ' ±4 km/h';
        if ((k.gear || null) !== w.gear) return 'gear changed';
        if (!isNum(k.lph)) return 'no fuel figure';
        if (isNum(k.slope) && Math.abs(k.slope) > 0.03) return 'road too steep';
        return 'not steady';
    }

    /* ---- acceleration 35 -> 75 ---- */
    _accel(k, prev) {
        let r = this.accel;
        if (!r) {
            if (prev && prev.v <= ACCEL.from && k.v > prev.v + 0.5 && (k.acc || 0) > 0.3) {
                r = this.accel = { t0: k.t, v0: prev.v, fuel: 0, km: 0, secs: 0, known: 0, ticks: 0, slow: 0 };
            } else return null;
        }
        r.ticks++; r.secs += k.dt || 1; r.km += k.v * (k.dt || 1) / 3600;
        if (isNum(k.lph)) { r.fuel += k.lph * (k.dt || 1) / 3600; r.known++; }
        if ((k.acc || 0) < 0.1) r.slow++; else r.slow = 0;
        if (r.slow >= 3 || r.secs > ACCEL.maxS) { this.accel = null; if (k.v > ACCEL.to - 15) this._fail('accel', 'acceleration stopped before ' + ACCEL.to + ' km/h', k.t); return null; }
        if (k.v >= ACCEL.to) {
            this.accel = null;
            if (r.known < r.ticks * 0.9) { this._fail('accel', 'no fuel figure', k.t); return null; }
            const accel = (k.v - r.v0) / 3.6 / r.secs;
            const st = STYLE.find((s) => accel >= s[2] && accel < s[3]);
            const res = { at: k.t, v0: round(r.v0, 1), v1: round(k.v, 1), secs: round(r.secs, 1), km: round(r.km, 4), ml: round(r.fuel * 1000, 1), accel: round(accel, 2) };
            if (this.done(st[0])) { this.last = { id: st[0], ok: true, at: k.t, r: res, extra: true }; return null; }
            this._add(st[0], res);
            return null;
        }
        return { kind: 'accel', id: 'accel', label: 'Acceleration ' + Math.round(r.v0) + ' -> ' + ACCEL.to + ' km/h', progress: Math.max(0, (k.v - r.v0) / (ACCEL.to - r.v0)) };
    }

    /* ---- roll-out 95 -> 65 ---- */
    _coast(k, prev) {
        let r = this.coast;
        const pedalOff = k.pedal === null || k.pedal === undefined || k.pedal < 2;
        if (!r) {
            if (prev && k.v >= COAST.from - 2 && pedalOff && (k.acc || 0) < -0.05 && k.v < prev.v) {
                r = this.coast = { t0: k.t, v0: k.v, fuel: 0, km: 0, secs: 0, known: 0, ticks: 0, sail: 0, gear: 0, push: 0 };
            } else return null;
        }
        r.ticks++; r.secs += k.dt || 1; r.km += k.v * (k.dt || 1) / 3600;
        if (isNum(k.lph)) { r.fuel += k.lph * (k.dt || 1) / 3600; r.known++; }
        // neutral or sailing: the selector in N, or the engine at idle speed while rolling fast
        if (k.stage === 'N' || (isNum(k.rpm) && k.rpm < 1100 && k.v > 50)) r.sail++; else r.gear++;
        // a roll-out slows down all the time (air and rolling resistance, at least ~0.15 m/s²); the pedal
        // pressed or no more slowing for 3 s ends it (cruise control holding a speed is no roll-out)
        if (!pedalOff) r.push += 2; else if ((k.acc || 0) > -0.05) r.push++; else r.push = 0;
        if (r.push >= 3 || r.secs > COAST.maxS || (k.acc || 0) <= LIMITS.hardBrake) {
            this.coast = null;
            if (r.v0 - k.v > 10) this._fail('coast', (k.acc || 0) <= LIMITS.hardBrake ? 'braked' : 'pedal pressed or speed held before ' + COAST.to + ' km/h', k.t);
            return null;
        }
        if (k.v <= COAST.to) {
            this.coast = null;
            if (r.known < r.ticks * 0.9) { this._fail('coast', 'no fuel figure', k.t); return null; }
            const id = r.sail > r.gear ? 'kSail' : 'kOverrun';
            const res = { at: k.t, v0: round(r.v0, 1), v1: round(k.v, 1), secs: round(r.secs, 1), km: round(r.km, 4), ml: round(r.fuel * 1000, 1) };
            if (this.done(id)) { this.last = { id, ok: true, at: k.t, r: res, extra: true }; return null; }
            this._add(id, res);
            return null;
        }
        return { kind: 'coast', id: 'coast', label: 'Rolling ' + Math.round(r.v0) + ' -> ' + COAST.to + ' km/h', progress: Math.max(0, (r.v0 - k.v) / (r.v0 - COAST.to)) };
    }

    toJSON() { return { results: this.results, autoGear: this.autoGear, active: this.active }; }
}

/* ---------------- what the test found ---------------- */

/**
 * mean of a result field over a cell's windows; for l/100 km with a model that knows the slope, each window
 * is first taken to a level road (what the slope added, by the model, taken off)
 */
function cellMean(results, id, f, model) {
    const a = (results[id] || []).map((r) => {
        let x = r[f];
        if (f === 'l100' && isNum(x) && model && model.ok && model.coef.slope !== undefined && isNum(r.slope)) {
            const flat = model.l100(r.v, { slope: 0 }), tilted = model.l100(r.v, { slope: r.slope });
            if (isNum(flat) && isNum(tilted)) x -= tilted - flat;
        }
        return x;
    }).filter(isNum);
    return a.length ? mean(a) : null;
}

/**
 * The findings: {
 *   speeds: [{ v, auto, low, lowPct, gearAuto }]   l/100 km at each speed, own gear and one lower (% more)
 *   accel:  [{ style, ml, secs, km, mlEq, secsEq }]   fuel and time to reach 75 km/h, made comparable: every run
 *                                                    taken to the same distance (the rest at cruise to 75 km/h)
 *   coast:  [{ how, ml, km, mlEq }]                 the same for the roll-out (the rest at 65 km/h)
 *   mode:   { eco, comfort, pct }
 * }; model (optional, model.js) gives the cruise consumption used to make runs comparable.
 */
function findings(plan, model) {
    const R = plan.results, out = { speeds: [], accel: [], coast: [], mode: null };
    for (const v of plan.speeds) {
        const auto = cellMean(R, 'c' + v + 'a', 'l100', model), low = cellMean(R, 'c' + v + 'l', 'l100', model);
        if (auto === null && low === null) continue;
        out.speeds.push({ v, auto, low, lowPct: auto && low ? (low - auto) / auto * 100 : null, gearAuto: plan.autoGear[v] || null });
    }
    const cruiseAt = (v) => {
        if (model && model.ok) return model.l100(v);
        const near = out.speeds.filter((s) => isNum(s.auto)).sort((a, b) => Math.abs(a.v - v) - Math.abs(b.v - v))[0];
        return near ? near.auto : null;
    };
    const runs = (ids, key) => ids.map(([id, name]) => {
        const a = R[id] || [];
        if (!a.length) return null;
        return { [key]: name, n: a.length, ml: mean(a.map((r) => r.ml)), secs: mean(a.map((r) => r.secs)), km: mean(a.map((r) => r.km)) };
    }).filter(Boolean);
    const equalise = (list, v) => {
        if (!list.length) return list;
        const far = Math.max.apply(null, list.map((r) => r.km)), c = cruiseAt(v);
        list.forEach((r) => {
            const rest = far - r.km;
            r.mlEq = isNum(c) ? r.ml + rest * c / 100 * 1000 : null;
            r.secsEq = r.secs + rest / v * 3600;
        });
        return list;
    };
    out.accel = equalise(runs(STYLE.map((s) => [s[0], s[1]]), 'style'), ACCEL.to);
    out.coast = equalise(runs([['kSail', 'Neutral / coasting'], ['kOverrun', 'In gear (cut-off)']], 'how'), COAST.to);
    const eco = cellMean(R, 'm100eco', 'l100', model), comfort = cellMean(R, 'm100comfort', 'l100', model);
    if (eco !== null || comfort !== null) out.mode = { eco, comfort, pct: eco && comfort ? (eco - comfort) / comfort * 100 : null };
    return out;
}

/** Map samples (model.js) from the test's steady windows. */
function samples(plan) {
    const out = [];
    Object.keys(plan.results).forEach((id) => {
        if (id[0] !== 'c' && id[0] !== 'm') return;
        (plan.results[id] || []).forEach((r) => out.push(Object.assign({ src: 'test', cell: id }, r)));
    });
    return out;
}

module.exports = { TestPlan, cells, findings, samples, ACCEL, COAST, STYLE };
