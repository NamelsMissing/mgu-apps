'use strict';
// Offline tests for Eco Coach: no vehicle, no BMW SDK. Run: node tests/eco_coach.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'eco_coach');
const F = require(path.join(APP, 'fuel'));
const D = require(path.join(APP, 'decode'));
const M = require(path.join(APP, 'model'));
const P = require(path.join(APP, 'testplan'));
const Demo = require(path.join(APP, 'demo'));

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('ok - ' + name); } catch (e) { console.error('FAIL - ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' not within ' + tol + ' of ' + b);

/* ---------- fuel ---------- */
test('fuel type from OBD PID 51', () => {
    assert.strictEqual(F.fuelTypeFromObd(0x04), 'diesel');
    assert.strictEqual(F.fuelTypeFromObd(0x13), 'diesel');
    assert.strictEqual(F.fuelTypeFromObd(0x01), 'petrol');
    assert.strictEqual(F.fuelTypeFromObd(0x08), null);
    assert.strictEqual(F.fuelTypeFromObd(undefined), null);
    assert.strictEqual(F.resolveFuel('auto', 'petrol').id, 'petrol');
    assert.strictEqual(F.resolveFuel('diesel', 'petrol').id, 'diesel');
    assert.strictEqual(F.resolveFuel('auto', null).id, 'diesel');
});
test('reference candidates are read-only and convert g/s with the density', () => {
    for (const c of F.FUEL_RATE) assert(c.obd || /^F4/.test(c.did), 'only OBD service 01 or its UDS F4xx mirror');
    const gps = F.FUEL_RATE.find((c) => c.kind === 'gps');
    near(F.toLph(gps, 1, F.FUELS.diesel), 3.6 / 0.832, 1e-9);
    near(F.toLph(F.FUEL_RATE[0], 6.5, F.FUELS.petrol), 6.5, 1e-9);
    assert.strictEqual(F.toLph(F.FUEL_RATE[0], null, F.FUELS.petrol), null);
});
test('fuel injection counter: rate, wrap, quiet = 0, learned scale', () => {
    const fl = new F.Flow();
    let raw = 65000, t = 0;
    for (let i = 0; i < 40; i++) { fl.feed(raw % 65536, t); raw += 50; t += 100; }   // 500 counts/s, wraps at 65536
    near(fl.rateAt(t - 100), 500, 1);
    assert.strictEqual(fl.lph(t - 100), null, 'no scale yet');
    for (let i = 0; i < 12; i++) { fl.feed(raw % 65536, t); raw += 50; t += 100; fl.learn(5.0 * (1 + (i % 3 - 1) * 0.02), t - 100); }
    assert(fl.k > 0, 'scale learned');
    near(fl.lph(t - 100), 5.0, 0.15);
    assert.strictEqual(fl.rateAt(t + 5000), 0, 'quiet counter = no flow');
    const noisy = new F.Flow(); noisy.rate = 100; noisy.rateT = 0; noisy.last = { raw: 0, t: 0 };
    for (let i = 0; i < 12; i++) noisy.learn(i % 2 ? 1 : 9, 0);
    assert.strictEqual(noisy.k, null, 'ratios that do not agree are not learned');
});

/* ---------- decode ---------- */
test('signal decoding', () => {
    near(D.speedKmh(6400), 100, 1e-9); assert.strictEqual(D.speedKmh(65535), null);
    near(D.rpm(8000), 2000, 1e-9); assert.strictEqual(D.temp48(255), null); near(D.temp48(138), 90, 1e-9);
    near(D.accelMs2(32500), 0, 1e-9); near(D.outsideC(110), 15, 1e-9);
    assert.strictEqual(D.pedalPct(5000), null); near(D.pedalPct(2000), 50, 1e-9);
    assert.strictEqual(D.gearOf('G8'), 8); assert.strictEqual(D.gearOf(10), 8); assert.strictEqual(D.gearOf('N_OR_P'), null);
    assert.deepStrictEqual(D.selectionOf('_6'), { stage: 'D', gear: 6 }); assert.deepStrictEqual(D.selectionOf(1), { stage: 'N', gear: null });
    assert.strictEqual(D.selectionOf(4), null);
    assert.strictEqual(D.modeOf('ECO_PRO_EFFICIENT'), 'eco'); assert.strictEqual(D.modeOf('SPORT_DYNAMIC'), 'sport');
    assert.strictEqual(D.modeOf(5), 'comfort'); assert.strictEqual(D.modeOf(0), null);
    assert.strictEqual(D.acOf({ statusAC: 'KLIMA_EIN' }), true); assert.strictEqual(D.acOf({ statusAC: 'AUS' }), false); assert.strictEqual(D.acOf({ x: 3 }), null);
    near(D.slopeOf(0.981, 0), 0.1, 1e-3); assert.strictEqual(D.slopeOf(5, 0), 0.12); assert.strictEqual(D.slopeOf(null, 0), null);
});

/* ---------- model ---------- */
test('classify driving states', () => {
    assert.strictEqual(M.classify({ v: 0, engineOn: false }), 'off');
    assert.strictEqual(M.classify({ v: 0, engineOn: true }), 'idle');
    assert.strictEqual(M.classify({ v: 80, acc: 0.1, engineOn: true }), 'cruise');
    assert.strictEqual(M.classify({ v: 50, acc: 1.2, engineOn: true }), 'accel');
    assert.strictEqual(M.classify({ v: 50, acc: -0.6, pedal: 0, engineOn: true }), 'coast');
    assert.strictEqual(M.classify({ v: 50, acc: -3, engineOn: true }), 'brake');
});
test('solve linear system', () => {
    const x = M.solve([[2, 1], [1, 3]], [3, 5]);
    near(x[0], 0.8, 1e-12); near(x[1], 1.4, 1e-12);
    assert.strictEqual(M.solve([[1, 2], [2, 4]], [1, 2]), null);
});
test('model recovers known consumption relations', () => {
    // synthetic: lph = 0.6 + 2.0 v' + 3.0 v'^3 (+ 4 % per 10 K below 15 °C, + 0.5 l/h A/C), v' = v / 100
    const rand = Demo.rng(42), S = [];
    for (let i = 0; i < 400; i++) {
        const v = 40 + rand() * 110, outside = rand() * 30, ac = rand() < 0.3, vv = v / 100;
        const cold = Math.max(0, 15 - outside) / 10 * (0.5 + vv);
        const lph = 0.6 + 2.0 * vv + 3.0 * vv * vv * vv + 0.25 * cold + (ac ? 0.5 : 0) + (rand() - 0.5) * 0.05;
        S.push({ v, lph, l100: lph / v * 100, outside, ac, coolant: 90, mode: 'comfort', slope: 0 });
    }
    const m = M.fit(S);
    assert(m.ok, 'model fitted');
    assert(m.r2 > 0.99, 'R² ' + m.r2);
    near(m.coef.base, 0.6, 0.08, 'base'); near(m.coef.air, 3.0, 0.2, 'air');
    near(m.coef.ac, 0.5, 0.05, 'A/C'); near(m.coef.cold, 0.25, 0.05, 'cold');
    assert(m.used.indexOf('slope') < 0, 'no slope in the data: not in the model');
    // the analytic minimum of l/100 = 100 (0.6/v + 0.02 + 3e-6 v²): v = (0.6 / 6e-6)^(1/3) = 46.4 km/h
    const sw = m.sweetSpot();
    near(sw.v, 46.4, 3, 'sweet spot');
    const eff = m.effects();
    assert(eff.find((e) => e.id === 'ac').pct > 0, 'A/C costs');
    assert(eff.find((e) => e.id === 'v110').pct > 0, 'faster costs');
});
test('too little data gives no model', () => {
    const m = M.fit([{ v: 50, lph: 3 }, { v: 60, lph: 3.5 }]);
    assert.strictEqual(m.ok, false); assert.strictEqual(m.l100(80), null); assert.deepStrictEqual(m.curve(30, 50), []);
    assert.strictEqual(m.sweetSpot(), null); assert.deepStrictEqual(m.effects(), []);
});
test('cruise collector cuts steady stretches', () => {
    const c = new M.CruiseCollector();
    const out = [];
    for (let i = 0; i < 45; i++) { const s = c.feed({ t: i * 1000, v: 90 + (i % 2) * 0.4, lph: 4.5, gear: 8, mode: 'comfort', outside: 10 }, 'cruise'); if (s) out.push(s); }
    const end = c.feed({ t: 46000, v: 60, lph: 0, gear: 8 }, 'coast');
    if (end) out.push(end);
    assert.strictEqual(out.length, 2, '20 s + 20 s (the last 5 s are too short)');
    near(out[0].l100, 5, 0.05);
    assert.strictEqual(out[0].gear, 8);
});
test('trip score and tips', () => {
    const fuel = F.FUELS.diesel;
    const calm = new M.Trip(0, fuel), rough = new M.Trip(0, fuel);
    for (let i = 0; i < 600; i++) calm.add({ t: i * 1000, dt: 1, v: 80, acc: 0, lph: 4, rpm: 1500, coolant: 90, engineOn: true }, 'cruise', fuel);
    for (let i = 0; i < 600; i++) {
        const k = i % 20 < 4 ? { v: 60, acc: 3, cls: 'accel' } : i % 20 < 6 ? { v: 60, acc: -3, cls: 'brake' } : i % 20 < 12 ? { v: 0, acc: 0, cls: 'idle' } : { v: 145, acc: 0, cls: 'cruise' };
        rough.add({ t: i * 1000, dt: 1, v: k.v, acc: k.acc, lph: 8, rpm: 3200, coolant: 90, engineOn: true }, k.cls, fuel);
    }
    const a = calm.score(), b = rough.score();
    assert(a.total >= 95, 'calm ' + a.total);
    assert(b.total < 40, 'rough ' + b.total);
    assert(rough.tips(null, fuel).length >= 2);
    near(calm.l100(), 5, 1e-6);
    const sm = calm.summary(fuel);
    near(sm.co2, sm.litres * 2.65, 0.1);
});

/* ---------- interactive test ---------- */
function drive(fuelType) {
    const plan = new P.TestPlan({ active: true });
    const car = new Demo.SimCar(fuelType), drv = new Demo.Driver(car, Demo.testProgram(plan.speeds), 3);
    for (let i = 0; i < 20000 && !drv.done; i++) plan.feed(drv.tick(1));
    return plan;
}
test('the simulated test drive fills the plan (diesel)', () => {
    const plan = drive('diesel');
    assert(plan.complete(), JSON.stringify(plan.progress()));
    assert.strictEqual(plan.autoGear[130], 8);
    const r = plan.results.c90a[0];
    assert(r.sd <= 1.5 && Math.abs(r.v - 90) <= 4, 'steady window');
});
test('the simulated test drive works for petrol', () => {
    const plan = drive('petrol');
    assert(plan.progress().done >= 12, JSON.stringify(plan.progress()));
});
test('findings: lower gear costs, comparable accelerations and roll-outs', () => {
    const plan = drive('diesel'), m = M.fit(P.samples(plan).concat(Demo.seed('diesel').samples));
    const f = P.findings(plan, m);
    const hi = f.speeds.find((s) => s.v === 130);
    assert(hi.lowPct > 0, 'a lower gear at 130 costs fuel');
    assert.strictEqual(f.accel.length, 3);
    const far = Math.max.apply(null, f.accel.map((x) => x.km));
    f.accel.forEach((x) => { assert(x.mlEq >= x.ml - 1e-9); if (x.km === far) near(x.mlEq, x.ml, 1e-9); });
    assert.strictEqual(f.coast.length, 2);
    const sail = f.coast.find((x) => /neutral/i.test(x.how)), cut = f.coast.find((x) => /gear/i.test(x.how));
    assert(cut.ml < 1, 'fuel cut-off burns nothing while rolling');
    assert(sail.km > cut.km, 'neutral rolls further');
    assert(f.mode && f.mode.eco > 0 && f.mode.comfort > 0);
});
test('a window is rejected when the speed wanders', () => {
    const plan = new P.TestPlan({ active: true, winS: 10 });
    for (let i = 0; i < 20; i++) plan.feed({ t: i * 1000, dt: 1, v: 90 + (i % 2 ? 3.5 : -3.5), acc: 0, lph: 4, gear: 8, coolant: 90, engineOn: true });
    assert.strictEqual(plan.count('c90a'), 0);
    assert(plan.last && !plan.last.ok && /steady/.test(plan.last.why));
});
test('inactive plan measures nothing; clear empties', () => {
    const plan = new P.TestPlan();
    for (let i = 0; i < 40; i++) plan.feed({ t: i * 1000, dt: 1, v: 70, acc: 0, lph: 3.5, gear: 7, coolant: 90, engineOn: true });
    assert.deepStrictEqual(plan.results, {});
    plan.start();
    for (let i = 0; i < 40; i++) plan.feed({ t: i * 1000, dt: 1, v: 70, acc: 0, lph: 3.5, gear: 7, coolant: 90, engineOn: true });
    assert.strictEqual(plan.count('c70a'), 1);
    const saved = JSON.parse(JSON.stringify(plan.toJSON()));
    assert.strictEqual(new P.TestPlan(saved).count('c70a'), 1, 'results survive a restart');
    plan.clear();
    assert.strictEqual(plan.count('c70a'), 0);
});
test('cruise control at 100+ is no roll-out', () => {
    const plan = new P.TestPlan({ active: true });
    for (let i = 0; i < 200; i++) plan.feed({ t: i * 1000, dt: 1, v: 110 + Math.sin(i) * 0.5, acc: Math.sin(i) * 0.08, pedal: 0, lph: 5, gear: 8, coolant: 90, engineOn: true });
    assert.strictEqual(plan.count('kSail') + plan.count('kOverrun'), 0);
    assert(!plan.last || plan.last.ok, 'no false failure: ' + JSON.stringify(plan.last));
});

/* ---------- demo + gear table ---------- */
test('demo seed: trips, a fitted model and a gear table, diesel and petrol', () => {
    for (const ft of ['diesel', 'petrol']) {
        const s = Demo.seed(ft);
        assert(s.trips.length >= 10 && s.samples.length > 500);
        const m = M.fit(s.samples);
        assert(m.ok && m.r2 > 0.9, ft + ' R² ' + m.r2);
        const d = m.l100(130) - m.l100(90);
        assert(d > 0.5, ft + ': faster costs more per km');
        assert(M.gearTable(s.samples, m).length >= 5);
        s.trips.forEach((x) => assert(x.score >= 0 && x.score <= 100));
    }
});

/* ---------- packaging ---------- */
test('app.json and the store catalog agree', () => {
    const app = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-repo.json'), 'utf8'));
    const c = repo.components.find((x) => x.id === 'eco_coach');
    assert(c, 'in mgu-repo.json');
    assert.strictEqual(c.version, app.version);
    assert.strictEqual(c.path, 'apps/eco_coach');
    assert(fs.existsSync(path.join(APP, c.icon)));
    const ids = repo.components.filter((x) => x.kind === 'app').map((x) => JSON.parse(fs.readFileSync(path.join(ROOT, x.path, 'app.json'), 'utf8')).loggingId);
    assert.strictEqual(new Set(ids).size, ids.length, 'unique loggingId');
    for (const f of ['main.js', 'ui.js', 'model.js', 'testplan.js', 'fuel.js', 'decode.js', 'demo.js', 'README.md']) assert(fs.existsSync(path.join(APP, f)), f);
    const src = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
    assert(!/\.set\(|setValue|0x2E|0x31|writeData/i.test(src.replace(/settings\.set|\.setMany/g, '')), 'no writes to the car');
});

console.log(passed + ' passed');
