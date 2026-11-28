'use strict';
/**
 * demo.js - a simulated car and driver for Eco Coach's demo data (bench, preview) and the offline tests.
 * Pure module. The car is a 1.75 t estate with an 8-speed automatic; its fuel comes from a simple physical
 * model (rolling, air, climbing, inertia, an engine efficiency map, fuel cut-off on overrun, idle in neutral),
 * so the analysis finds the same kind of relations it finds in a real car - but these are not real figures.
 *
 *   const car = new SimCar('diesel'); const drv = new Driver(car, program, seed);
 *   drv.tick(1) -> a model.js tick
 *   seed('diesel') -> { samples, trips, test: { results, autoGear } }   about 6 h of simulated driving, ~1 s CPU
 */
const { FUELS } = require('./fuel');
const M = require('./model');
const { TestPlan, samples: testSamples } = require('./testplan');

const G0 = 9.80665;
const RATIOS = [5.0, 3.2, 2.143, 1.72, 1.314, 1.0, 0.822, 0.64], FINAL = 2.81, WHEEL = 2.03;

function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rpmAt = (kmh, gear) => kmh / 3.6 / WHEEL * 60 * RATIOS[gear - 1] * FINAL;

class SimCar {
    constructor(fuelType) {
        this.fuel = FUELS[fuelType] || FUELS.diesel;
        this.diesel = this.fuel.id === 'diesel';
        this.mass = 1750; this.crr = 0.011; this.cda = 0.62; this.rho = 1.2; this.eta = 0.9;
        this.v = 0; this.dist = 0; this.coolant = 20; this.gear = 1; this.outside = 15; this.dir = 1;
    }
    slope() { return this.dir * 0.012 * Math.sin(this.dist / 1700 * 2 * Math.PI); }
    /** the gear the gearbox picks: the highest one above the shift speed for the demand */
    autoGear(kmh, demand, mode) {
        const base = this.diesel ? 1200 : 1450, up = mode === 'eco' ? -120 : mode === 'sport' ? 500 : 0;
        const want = base + up + demand * (this.diesel ? 1400 : 2600);
        for (let g = 8; g >= 1; g--) if (rpmAt(kmh, g) >= want) return g;
        return 1;
    }
    /**
     * One step of dt s with the wanted acceleration a (m/s²): { lph, rpm, pedal, gear, stage }. how: 'drive'
     * (gearbox's own gear), 'low' (one lower), 'sail' (neutral), 'brake' (a < 0 with the brakes, fuel cut-off).
     */
    step(dt, a, how, mode, ac) {
        const v = this.v / 3.6, sl = this.slope();
        const resist = this.mass * G0 * (this.crr + sl) + 0.5 * this.rho * this.cda * v * v;
        let lph, pedal = 0, stage = 'D';
        const coldF = 1 + 0.025 * Math.max(0, 15 - this.outside) + (this.coolant < 70 ? 0.12 : 0);
        if (how === 'sail') {
            a = -resist / this.mass;
            stage = 'N';
        }
        let gear = how === 'sail' ? this.gear : this.autoGear(this.v, Math.max(0, Math.min(1, a / 3)), mode);
        if (how === 'low' && gear > 1) gear--;
        if (this.v < 8) gear = 1;
        const rpm = how === 'sail' || this.v < 3 ? 800 : Math.max(800, rpmAt(this.v, gear));
        const pWheel = (this.mass * a + resist) * v / 1000;          // kW
        const idle = this.fuel.idleLph * coldF * (ac ? 1.25 : 1);
        if (how === 'sail' || this.v < 3) lph = idle;
        else if (pWheel <= 0 || how === 'brake') lph = rpm > 1000 ? 0 : idle;     // overrun: fuel cut-off
        else {
            const pEng = pWheel / this.eta + 0.5 + (ac ? 1.6 : 0);
            const pMax = (this.diesel ? 140 : 135) * Math.max(0.25, Math.min(1, rpm / (this.diesel ? 3800 : 5000)));
            const load = Math.min(1, pEng / pMax);
            const best = this.diesel ? 205 : 235, opt = this.diesel ? 1800 : 2600;
            const bsfc = best * (1 + 1.1 * Math.pow(1 - load, 2.2)) * (1 + 0.12 * Math.pow((rpm - opt) / 1500, 2));
            const friction = idle * 0.6 * Math.pow(rpm / 800, 0.9) * coldF;
            lph = friction + pEng * bsfc / (this.fuel.density * 1000);
            pedal = Math.round(Math.min(100, load * 100));
        }
        this.v = Math.max(0, this.v + a * dt * 3.6);
        this.dist += this.v / 3.6 * dt;
        this.gear = gear;
        this.coolant = Math.min(90, this.coolant + (this.v > 3 ? 0.45 : 0.15) * dt * (lph > 0 ? 1 : 0.4));
        return { lph, rpm, pedal, gear: stage === 'N' ? null : gear, stage, slope: sl, acc: a };
    }
}

/**
 * Runs a program of steps for a SimCar and returns 1 Hz ticks.
 * step = { cruise: km/h, secs, how: 'drive'|'low', cc: true (cruise control: pedal 0 on screen) }
 *      | { to: km/h, a: m/s² }  (accelerate or brake to a speed)  | { coast: km/h, sail: bool }
 *      | { idle: secs } | { off: secs } | { turn: true } (other direction) | { mode, ac, outside }
 */
class Driver {
    constructor(car, program, seed) {
        this.car = car; this.prog = program.slice(); this.i = 0; this.left = null; this.t = Date.UTC(2026, 10, 1, 8);
        this.rand = rng(seed || 1); this.mode = 'comfort'; this.ac = false; this.on = true; this.lastV = 0;
    }
    get done() { return this.i >= this.prog.length; }
    tick(dt) {
        dt = dt || 1;
        const car = this.car, s = this.prog[this.i];
        let a = 0, how = 'drive', pedalZero = false;
        if (!s) return null;
        if (s.mode !== undefined || s.ac !== undefined || s.outside !== undefined || s.turn) {
            if (s.mode) this.mode = s.mode;
            if (s.ac !== undefined) this.ac = s.ac;
            if (s.outside !== undefined) car.outside = s.outside;
            if (s.turn) car.dir = -car.dir;
            if (s.cool) car.coolant = car.outside;
            this.i++;
            return this.tick(dt);
        }
        this.on = true;
        if (s.cruise !== undefined) {
            if (this.left === null) this.left = s.secs;
            const err = s.cruise - car.v;
            a = Math.max(-1, Math.min(1, err * 0.35)) + (this.rand() - 0.5) * 0.12;
            how = s.how || 'drive'; pedalZero = s.cc !== false;
            if (--this.left <= 0) { this.i++; this.left = null; }
        } else if (s.to !== undefined) {
            const up = s.to > car.v;
            a = up ? s.a : -Math.abs(s.a);
            how = up ? 'drive' : 'brake';
            if ((up && car.v + a * dt * 3.6 >= s.to) || (!up && car.v + a * dt * 3.6 <= s.to)) { a = (s.to - car.v) / 3.6 / dt; this.i++; }
        } else if (s.coast !== undefined) {
            how = s.sail ? 'sail' : 'brake';
            const resist = car.mass * G0 * (car.crr + car.slope()) + 0.5 * car.rho * car.cda * Math.pow(car.v / 3.6, 2);
            // in gear the engine brakes too (drag of a turning engine without fuel)
            a = -(resist / car.mass) - (s.sail ? 0 : 0.35);
            if (car.v + a * dt * 3.6 <= s.coast) this.i++;
        } else if (s.idle !== undefined || s.off !== undefined) {
            if (this.left === null) this.left = s.idle !== undefined ? s.idle : s.off;
            a = car.v > 0 ? -car.v / 3.6 / dt : 0;
            this.on = s.idle !== undefined;
            if (--this.left <= 0) { this.i++; this.left = null; }
        }
        const r = car.step(dt, a, how, this.mode, this.ac);
        this.t += dt * 1000;
        const v = car.v + (this.rand() - 0.5) * 0.4;
        const tick = {
            t: this.t, dt, v: Math.max(0, v), acc: r.acc, lph: this.on ? r.lph * (1 + (this.rand() - 0.5) * 0.04) : null,
            gear: this.on ? r.gear : null, stage: this.on ? r.stage : 'P', pedal: pedalZero ? 0 : r.pedal, rpm: this.on ? r.rpm : 0,
            coolant: Math.round(car.coolant), outside: car.outside, mode: this.mode, slope: r.slope, ac: this.ac, engineOn: this.on,
        };
        this.lastV = car.v;
        return tick;
    }
}

/** The test, driven the way a driver would: every cell, both directions. */
function testProgram(speeds) {
    const p = [{ outside: 12, mode: 'comfort', ac: false }, { cruise: 50, secs: 420 }];     // warm up
    for (const v of speeds) {
        p.push({ to: v, a: 1.2 });
        for (const dir of [0, 1]) {
            p.push({ cruise: v, secs: 32 }, { cruise: v, secs: 30, how: 'low' }, { turn: true });
        }
    }
    p.push({ to: 100, a: 1 }, { mode: 'eco' }, { cruise: 100, secs: 30 }, { turn: true }, { cruise: 100, secs: 30 },
        { mode: 'comfort' }, { cruise: 100, secs: 30 }, { turn: true }, { cruise: 100, secs: 30 });
    for (const a of [0.7, 0.7, 1.5, 1.5, 2.8, 2.8]) p.push({ to: 30, a: 2 }, { cruise: 30, secs: 4, cc: false }, { to: 80, a });
    for (const sail of [true, true, false, false]) p.push({ to: 100, a: 1.2 }, { cruise: 100, secs: 3, cc: false }, { coast: 62, sail }, { cruise: 62, secs: 4, cc: false });
    p.push({ to: 0, a: 2 }, { off: 600 });
    return p;
}

/** An everyday drive: town, country road and motorway at the given outside temperature. */
function dailyProgram(rand, outside, hurry) {
    const p = [{ outside, ac: outside > 22, mode: rand() < 0.3 ? 'eco' : rand() < 0.2 ? 'sport' : 'comfort', cool: true }];
    for (let i = 0; i < 6; i++) p.push({ to: 30 + rand() * 25, a: 0.8 + rand() * 1.6 * hurry }, { cruise: 45, secs: 40 + rand() * 60, cc: false }, { to: 0, a: 1 + rand() * 2 * hurry }, { idle: 10 + rand() * 40 });
    p.push({ to: 80 + rand() * 20, a: 1 + rand() * hurry }, { cruise: 85 + rand() * 15, secs: 300 + rand() * 300 });
    const fast = 110 + rand() * 30 + hurry * 15;
    p.push({ to: fast, a: 1 + hurry }, { cruise: fast, secs: 600 + rand() * 600 }, { cruise: 120 + rand() * 10, secs: 300 });
    p.push({ coast: 70, sail: rand() < 0.4 }, { to: 0, a: 1.5 + hurry }, { off: 600 });
    return p;
}

/** Run a program through the analysis; returns { trips, samples, plan }. */
function run(fuelType, program, seedNo, plan, into) {
    const fuel = FUELS[fuelType] || FUELS.diesel, car = new SimCar(fuelType), drv = new Driver(car, program, seedNo);
    const coll = new M.CruiseCollector(), out = into || { trips: [], samples: [] };
    let trip = null, offFor = 0;
    for (let guard = 0; !drv.done && guard < 200000; guard++) {
        const k = drv.tick(1);
        if (!k) break;
        const cls = M.classify(k);
        if (k.engineOn) {
            offFor = 0;
            if (!trip) trip = new M.Trip(k.t, fuel);
        } else offFor++;
        if (trip) trip.add(k, cls, fuel);
        if (trip && offFor >= 300) { out.trips.push(trip.summary(fuel)); trip = null; }
        const s = coll.feed(k, cls);
        if (s) out.samples.push(s);
        if (plan) plan.feed(k);
    }
    if (trip) out.trips.push(trip.summary(fuel));
    return out;
}

/** About 6 h of demo driving: the test, then ten everyday drives from 0 to 28 °C. */
function seed(fuelType) {
    const rand = rng(7), plan = new TestPlan({ active: true });
    const out = run(fuelType, testProgram(plan.speeds), 3, plan);
    for (let d = 0; d < 10; d++) run(fuelType, dailyProgram(rand, Math.round(rand() * 28), d % 3 === 0 ? 0.9 : 0.3), 11 + d, null, out);
    plan.stop();
    out.test = plan.toJSON();
    out.samples = out.samples.concat(testSamples(plan));
    return out;
}

module.exports = { SimCar, Driver, testProgram, dailyProgram, run, seed, rng, rpmAt };
