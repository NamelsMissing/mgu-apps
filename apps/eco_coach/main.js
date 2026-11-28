'use strict';
/**
 * Eco Coach - analyses your driving for fuel, learns your car's consumption by speed, gear, slope,
 * temperature, engine warmth, driving mode and A/C, and runs an interactive consumption test that finds
 * at which speed, in which gear and with which acceleration / roll-out your car uses the least fuel.
 * Diesel and petrol.
 *
 * Reads only: car signals over SOME/IP, and (for the fuel figure's reference) OBD service 01 / UDS 0x22
 * from the engine unit. Nothing is written, coded or actuated.
 *
 * model.js     the analysis (classes of driving, trips and score, steady stretches, the consumption model)
 * testplan.js  the interactive test
 * fuel.js      fuel types and fuel-flow sources
 * demo.js      a simulated car for demo data
 * ui.js        the pages
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');
const F = require('./fuel');
const M = require('./model');
const P = require('./testplan');
const Demo = require('./demo');
const UI = require('./ui');
const D = require('./decode');

const W = 1600, H = 520;
const V2 = 'de.bmw.infotainment.vehicle.Vehicle2', CDS = 'de.bmw.infotainment.vehicle.CDS', CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
const FES = 'de.bmw.infotainment.drivingexcitement.FES', PEDAL = 'de.bmw.powertrain.AcceleratorPedal';
const VI = 'de.bmw.infrastructure.VehicleInformation', ENV = 'de.bmw.infrastructure.EnvironmentalInformation';
const KOMBI = 'de.bmw.infotainment.KombiIF', CLIMA = 'de.bmw.infotainment.climate.climatemaster.ClimateMaster';
const TRIP_END_S = 300;             // engine off this long ends a trip
const MAX_SAMPLES = 3000, MAX_TRIPS = 40;
const isNum = M.isNum;

const MODE_NAMES = { eco: 'ECO PRO', comfort: 'Comfort', sport: 'Sport' };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const DATA = path.join(ctx.dataDir, 'eco_coach.json');
        const t0 = Date.now();
        let page = 0;

        /* ---------- stored data ---------- */
        const empty = () => ({ v: 1, fuelDetected: null, fuelK: null, trips: [], samples: [], test: null });
        let store = empty();
        try {
            const s = JSON.parse(fs.readFileSync(DATA, 'utf8'));
            if (s && typeof s === 'object') store = Object.assign(empty(), s);
            if (!Array.isArray(store.trips)) store.trips = [];
            if (!Array.isArray(store.samples)) store.samples = [];
        } catch (e) { /* first start */ }
        let dirty = false;
        function save() {
            if (!dirty) return;
            const tmp = DATA + '.tmp-' + process.pid;
            try {
                store.test = plan.toJSON();
                store.fuelK = flow.k;
                fs.mkdirSync(ctx.dataDir, { recursive: true });
                fs.writeFileSync(tmp, JSON.stringify(store));
                fs.renameSync(tmp, DATA);
                dirty = false;
            } catch (e) { log.warn('save: ' + e); }
        }

        const fuel = () => F.resolveFuel(settings.get('fuelType'), store.fuelDetected);
        const flow = new F.Flow(store.fuelK);
        const testOpts = () => ({ speeds: settings.get('testTop') === 150 ? [50, 70, 90, 110, 130, 150] : [50, 70, 90, 110, 130], winS: settings.get('testWindow') || 20 });
        let plan = new P.TestPlan(Object.assign(testOpts(), store.test || {}));
        let model = M.fit(store.samples.concat(P.samples(plan)));
        let gears = M.gearTable(store.samples.concat(P.samples(plan)), model);
        let modelDirty = false;

        /* ---------- the car's signals ---------- */
        const car = { v: null, vT: 0, vSum: 0, vN: 0, rpm: null, rpmT: 0, coolant: null, running: null, aLong: null, aSum: 0, aN: 0,
            pedal: null, gear: null, stage: null, mode: null, outside: null, ac: null, tank: null, odo: null, seen: false, fuelSeen: false };
        const sub = (iface, handlers, opts) => ctx.signals.watch(iface, '1', handlers, log, opts)
            .then((s) => { if (s.error) log.warn(iface + ': ' + s.error); }).catch((e) => log.warn(iface + ': ' + e));
        sub(V2, { statusCarSpeed2: (v) => {
            const x = D.speedKmh(v && v.speedVehicleCentreOfGravity);
            if (x !== null) { car.v = x; car.vT = Date.now(); car.vSum += x; car.vN++; car.seen = true; }
        } }, { pollMs: 2000 });
        sub(CDS, {
            statusEngineSpeed2: (v) => { const r = D.rpm(v && v.actualValueRPMEngineCrankshaft); if (r !== null) { car.rpm = r; car.rpmT = Date.now(); } },
            statusEngineTemperature: (v) => { const c = D.temp48(v && v.temperatureEngineDrive); if (c !== null) car.coolant = c; },
            statusEngineStatus: (v) => { const s = v && v.statusEngineRunDrive; car.running = s === 'MOTOR_LAEUFT' || s === 2 ? true : s === 'MOTOR_AUS' || s === 0 ? false : car.running; },
        });
        sub(CDS2, {
            statusInjectionVolume: (v) => { const x = v && v.injectionVolumeFuelEngine; if (typeof x === 'number') { flow.feed(x, Date.now()); car.fuelSeen = true; } },
            statusLongitudinalAccelerationMassCenter: (v) => {
                const a = D.accelMs2(v && v.longitudinalAccelerationCentreOfGravity);
                if (a !== null) { car.aLong = a; car.aSum += a; car.aN++; }
            },
        });
        sub(FES, { statusFESVehicleDynamicSwitchHMI: (v) => { car.mode = D.modeOf(v && v.actualValueModeDrivingExperience); } });
        sub(PEDAL, { AngleAcceleratorPedal: (v) => { car.pedal = D.pedalPct(v && v.actualValueAngleAcceleratorPedal); } });
        sub(VI, {
            statusGearboxDrive: (v) => { if (!v) return; const st = D.stageOf(v.statusActualStageDrive); if (st) car.stage = st; car.gear = st === 'D' ? D.gearOf(v.statusActualGearDrive) : null; },
            DataPowerTrain2: (v) => { const s = D.selectionOf(v && v.statusGearSelectionDrive); if (s) { car.stage = s.stage; car.gear = s.gear; } },
        });
        sub(ENV, { ExteriorTemperature: (v) => { const x = D.outsideC(v && v.temperatureExterior); if (x !== null) car.outside = x; } });
        sub(KOMBI, { statusRangeTankStatus: (v) => {
            if (!v) return;
            if (typeof v.fluidLevelFuelTank === 'number' && v.fluidLevelFuelTank < 255) car.tank = v.fluidLevelFuelTank;
            if (typeof v.mileageKilometre === 'number' && v.mileageKilometre < 16777215) car.odo = v.mileageKilometre;
        } }, { pollMs: 10000 });
        let acLogged = false;
        sub(CLIMA, { statusAirCondAC: (v) => {
            if (!acLogged) { acLogged = true; log.info('A/C status (first, for calibration): ' + JSON.stringify(v)); }
            car.ac = D.acOf(v);
        } });

        /* ---------- the reference fuel figure from the engine unit (read only) ---------- */
        let diag = null, reader = null, ref = null, refState = 'not asked yet', refFails = 0, refBusy = false, refNext = Date.now() + 4000;
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        async function refLoop() {
            if (refBusy || Date.now() < refNext) return;
            refBusy = true;
            try {
                const engineOn = engineRuns();
                const need = !flow.k || plan.active || !car.fuelSeen || settings.get('fuelSource') === 'diag';
                if (!engineOn || !need) { refNext = Date.now() + (engineOn ? 10000 : 5000); if (engineOn && flow.k) refState = 'car signal calibrated'; return; }
                if (!diag) {
                    refState = 'connecting';
                    diag = new Diag(ctx.signals, log); diag.quiet = true;
                    await diag.init();
                    if (diag.p) reader = new DidReader(diag, { ecu: 0x12 });
                }
                if (!diag.p || !diag.available) { refState = 'diagnostic link unavailable'; refNext = Date.now() + 15000; return; }
                if (!store.fuelDetected) {
                    const code = await reader.read(F.FUEL_TYPE);
                    const ft = F.fuelTypeFromObd(code);
                    if (ft) { store.fuelDetected = ft; dirty = true; log.info('fuel type from the engine unit: ' + ft + ' (PID 51 = ' + code + ')'); }
                    await pause(150);
                }
                const val = await reader.value('fuelRate', F.FUEL_RATE);
                if (val === null) {
                    refFails++;
                    refState = 'engine unit gives no fuel rate';
                    if (refFails === 3 && !reader.located) await locateEngine();
                    refNext = Date.now() + (refFails > 8 ? 60000 : 2000);
                    if (refFails === 9) log.warn('no fuel rate from the engine unit: ' + JSON.stringify(reader.raws));
                    return;
                }
                const c = F.FUEL_RATE[reader.pick.fuelRate || 0], lph = F.toLph(c, val, fuel());
                if (refFails || !ref) log.info('fuel rate from the engine unit: ' + (c.obd ? 'OBD ' + c.obd : 'DID ' + c.did) + ' = ' + lph.toFixed(2) + ' l/h');
                refFails = 0;
                ref = { lph, t: Date.now() };
                refState = 'engine unit ' + (c.obd ? 'PID ' + c.obd : 'DID ' + c.did);
                if (flow.learn(lph, Date.now())) { dirty = true; log.info('fuel signal scale learned: ' + flow.k.toPrecision(4) + ' l/h per count/s (spread ' + flow.spread.toFixed(2) + ')'); }
                refNext = Date.now() + 1000;
            } catch (e) {
                refState = 'diagnostic error';
                log.warn('fuel reference: ' + e);
                refNext = Date.now() + 15000;
            } finally { refBusy = false; }
        }
        /** The engine unit's address: the one answering OBD 01 0C (one functional request, read only). */
        async function locateEngine() {
            reader.located = true;
            try {
                const found = await diag.functional(0x01, [0x0C], { idleMs: 1500, maxMs: 9000 });
                const engines = [];
                for (const [addr, uds] of found) if (uds && uds[0] === 0x41 && uds[1] === 0x0C) engines.push(addr);
                if (engines.length === 1 && engines[0] !== reader.ecu) { reader.ecu = engines[0]; log.info('engine unit at 0x' + engines[0].toString(16)); }
            } catch (e) { log.warn('engine unit search: ' + e); }
        }
        const engineRuns = () => (Date.now() - car.rpmT < 3000 && car.rpm > 400) || car.running === true;

        /** The fuel flow now: { lph, src } */
        function fuelNow(now) {
            if (settings.get('fuelSource') !== 'diag' && flow.k && car.fuelSeen) { const l = flow.lph(now); if (l !== null) return { lph: l, src: 'signal' }; }
            if (ref && now - ref.t < 2500) return { lph: ref.lph, src: 'diag' };
            return { lph: null, src: null };
        }

        /* ---------- demo ---------- */
        let demo = null;            // { store, plan, model, gears, drv, trip, coll }
        const demoWanted = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !car.seen && Date.now() - t0 > 8000);
        function demoStart() {
            const s = Demo.seed(fuel().id), p = new P.TestPlan(Object.assign(testOpts(), s.test, { active: false }));
            const smp = s.samples, md = M.fit(smp);
            const rand = Demo.rng(99);
            const program = Demo.dailyProgram(rand, 9, 0.6);
            demo = { store: { trips: s.trips.slice().reverse().map((x, i) => Object.assign(x, { t0: Date.now() - (i + 1) * 86400000 })), samples: smp },
                plan: p, model: md, gears: M.gearTable(smp, md), drv: new Demo.Driver(new Demo.SimCar(fuel().id), program, 5),
                trip: null, coll: new M.CruiseCollector(), program };
            log.info('demo data on');
        }

        /* ---------- one tick a second ---------- */
        let trip = null, coll = new M.CruiseCollector(), offFor = 0, lastV = null, lastT = 0, slopeAvg = null, lphAvg = [], measuring = null, last = null;
        function endTrip(why) {
            if (!trip) return;
            if (trip.km >= 0.5) {
                const sm = trip.summary(fuel());
                sm.tips = trip.tips(model, fuel());
                sm.price = settings.get('fuelPrice');
                store.trips.unshift(sm);
                store.trips = store.trips.slice(0, MAX_TRIPS);
                dirty = true;
                log.info('trip ended (' + why + '): ' + sm.km + ' km, ' + sm.l100 + ' l/100 km, score ' + sm.score);
            }
            trip = null;
            save();
        }
        function realTick(now) {
            const dt = lastT ? Math.min(5, (now - lastT) / 1000) : 1;
            lastT = now;
            const fresh = now - car.vT < 3000;
            const v = car.vN ? car.vSum / car.vN : fresh ? car.v : null;
            const aMeas = car.aN ? car.aSum / car.aN : null;
            car.vSum = 0; car.vN = 0; car.aSum = 0; car.aN = 0;
            const on = engineRuns();
            if (v === null && !on) { lastV = null; return null; }
            const acc = isNum(v) && isNum(lastV) ? (v - lastV) / 3.6 / dt : 0;
            lastV = v;
            // the road's slope: what the acceleration sensor feels beyond the change of speed is gravity
            let slope = null;
            if (isNum(aMeas) && isNum(v) && v > 20) {
                const s = D.slopeOf(aMeas, acc);
                slopeAvg = slopeAvg === null ? s : slopeAvg + (s - slopeAvg) * 0.25;
                slope = slopeAvg;
            }
            const fl = fuelNow(now);
            return { t: now, dt, v: v || 0, acc, lph: on ? fl.lph : (isNum(v) && v > 3 ? fl.lph : null), src: fl.src,
                gear: car.gear, stage: car.stage, pedal: car.pedal, rpm: on ? car.rpm : 0, coolant: car.coolant, outside: car.outside,
                mode: car.mode, slope, ac: car.ac, engineOn: on };
        }
        function tick() {
            const now = Date.now();
            if (demoWanted()) {
                if (!demo) demoStart();
                let k = demo.drv.tick(1);
                if (!k) { demo.drv = new Demo.Driver(new Demo.SimCar(fuel().id), demo.program, (now % 1000) + 1); k = demo.drv.tick(1); }
                k.t = now; k.src = 'demo';
                feed(k, demo, true);
                return;
            }
            if (demo) { demo = null; log.info('demo data off'); }
            refLoop();
            const k = realTick(now);
            if (!k) {
                if (trip && ++offFor >= TRIP_END_S) endTrip('engine off');
                return;
            }
            feed(k, null, false);
        }
        /** the same analysis for the car and for the demo (d = the demo's own store) */
        function feed(k, d, isDemo) {
            const f = fuel(), cls = M.classify(k);
            if (isDemo) {
                if (!d.trip && k.engineOn) d.trip = new M.Trip(k.t, f);
                if (d.trip) d.trip.add(k, cls, f);
                const s = d.coll.feed(k, cls);
                if (s) d.store.samples.push(s);
                measuring = d.plan.feed(k);
            } else {
                if (k.engineOn) offFor = 0; else offFor++;
                if (!trip && k.engineOn && k.v > 0) trip = new M.Trip(k.t, f);
                if (trip) trip.add(k, cls, f);
                if (trip && offFor >= TRIP_END_S) endTrip('engine off');
                const s = coll.feed(k, cls);
                if (s) { store.samples.push(s); store.samples = store.samples.slice(-MAX_SAMPLES); dirty = true; modelDirty = true; }
                const before = plan.last;
                measuring = plan.feed(k);
                if (plan.last !== before) { dirty = true; modelDirty = true; if (plan.last) log.info('test ' + plan.last.id + ': ' + (plan.last.ok ? 'measured ' + JSON.stringify(plan.last.r) : plan.last.why)); }
            }
            last = k;
            lphAvg.push(k.lph);
            if (lphAvg.length > 3) lphAvg.shift();
        }
        setInterval(() => { try { tick(); } catch (e) { log.error('tick', e); } }, 1000);
        setInterval(() => {
            if (modelDirty) {
                modelDirty = false;
                const all = store.samples.concat(P.samples(plan));
                model = M.fit(all); gears = M.gearTable(all, model);
            }
            save();
        }, 60000);
        if (typeof ctx.onShutdown === 'function') ctx.onShutdown(async () => { endTrip('shutdown'); save(); });

        /* ---------- controls ---------- */
        const moving = () => last && last.v > 3;
        const ctl = {
            start: () => {
                const p = demo ? demo.plan : plan;
                if (moving() && !demo) return;
                p.start(); if (!demo) { dirty = true; save(); }
            },
            stop: () => { const p = demo ? demo.plan : plan; p.stop(); if (!demo) { dirty = true; save(); } },
            clear: () => {
                const p = demo ? demo.plan : plan;
                p.clear();
                if (!demo) { dirty = true; modelDirty = true; save(); }
            },
        };
        let clearArmed = 0;
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % UI.TABS.length; });
        ui.onClick('BTN_TEST', () => { const p = demo ? demo.plan : plan; if (p.active) ctl.stop(); else ctl.start(); page = 3; });
        ui.onClick('BTN_CLEAR', () => { if (Date.now() - clearArmed < 5000) { clearArmed = 0; ctl.clear(); } else clearArmed = Date.now(); page = 3; });
        if (typeof ctx.onTab === 'function') ctx.onTab((i) => { if (Number.isInteger(i) && i >= 0 && i < UI.TABS.length) page = i; });
        settings.onChange((key) => {
            if (key === 'testTop' || key === 'testWindow') {
                const saved = plan.toJSON();
                plan = new P.TestPlan(Object.assign(testOpts(), saved));
                dirty = true;
            }
        });

        /* ---------- the view ---------- */
        const price = () => settings.get('fuelPrice') || 1.75, currency = 'EUR';
        function when(t) {
            const d = new Date(t);
            return d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 16);
        }
        function coachLines(k, mdl, gt, p) {
            const out = [];
            if (!k) return out;
            if (k.v > 40 && mdl && mdl.ok) {
                const band = gt.find((g) => g.band === Math.round(k.v / 10) * 10);
                if (band && isNum(k.gear) && band.best !== k.gear) {
                    const cur = band.gears.find((g) => g.gear === k.gear), best = band.gears.find((g) => g.gear === band.best);
                    if (cur && best && cur.l100 > best.l100 * 1.03) out.push('Gear ' + band.best + ' instead of ' + k.gear + ' uses about ' + ((cur.l100 - best.l100) / cur.l100 * 100).toFixed(0) + ' % less here');
                }
                if (k.v > 125) {
                    const a = mdl.l100(k.v), b = mdl.l100(120);
                    if (isNum(a) && isNum(b) && a > b) out.push('120 instead of ' + Math.round(k.v) + ' km/h: ' + (a - b).toFixed(1) + ' l/100 km less');
                }
            }
            const fnd = P.findings(p, mdl);
            if (k.acc > M.LIMITS.hardAcc && fnd.accel.length > 1) {
                const best = fnd.accel.filter((r) => isNum(r.mlEq)).sort((x, y) => x.mlEq - y.mlEq)[0];
                if (best) out.push(best.style + ' acceleration was the most economical in your test');
            }
            if (!(k.v > 3) && k.engineOn && isNum(k.lph)) out.push('Idling: ' + k.lph.toFixed(2) + ' l/h - auto start-stop saves it');
            if (isNum(k.coolant) && k.coolant < M.LIMITS.coldEngine && k.engineOn) out.push('Engine cold (' + Math.round(k.coolant) + ' °C): drive off gently instead of idling to warm up');
            if (k.mode === 'sport' && mdl && mdl.coef && mdl.coef.sport !== undefined) out.push('Sport mode costs fuel: ECO PRO or Comfort for cruising');
            return out;
        }
        function view() {
            const d = demo, st = d ? d.store : store, p = d ? d.plan : plan, mdl = d ? d.model : model, gt = d ? d.gears : gears;
            const cur = d ? d.trip : trip, k = last, f = fuel();
            const lphs = lphAvg.filter(isNum), lph = lphs.length ? M.mean(lphs) : null;
            const sm = cur ? cur.summary(f) : null;
            if (sm) sm.cost = isNum(sm.litres) ? sm.litres * price() : null;
            const sweet = mdl.sweetSpot();
            // speed map
            const smp = st.samples.concat(P.samples(p));
            const bins = {};
            smp.filter((s) => s.src !== 'test').forEach((s) => { const b = Math.round(s.v / 10) * 10; (bins[b] = bins[b] || []).push(s.l100); });
            const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
            const binPts = Object.keys(bins).map(Number).sort((a, b) => a - b).filter((b) => bins[b].length >= 5).map((b) => [b, median(bins[b])]);
            const testPts = P.samples(p).map((s) => [s.v, s.l100]);
            // test page
            const prog = p.progress(), nx = p.next(k ? k.v : 0);
            const rows = [];
            for (const v of p.speeds) rows.push({ name: v + ' km/h', cells: [{ short: 'own gear', count: p.count('c' + v + 'a'), need: p.need }, { short: 'gear lower', count: p.count('c' + v + 'l'), need: p.need }] });
            if (p.modeSeen) rows.push({ name: '100 km/h', cells: [{ short: 'ECO PRO', count: p.count('m100eco'), need: p.need }, { short: 'Comfort', count: p.count('m100comfort'), need: p.need }] });
            rows.push({ name: '35-75 km/h', cells: P.STYLE.map((s) => ({ short: s[1], count: p.count(s[0]), need: p.need })) });
            rows.push({ name: '95-65 km/h', cells: [{ short: 'Neutral', count: p.count('kSail'), need: p.need }, { short: 'In gear', count: p.count('kOverrun'), need: p.need }] });
            const lastRes = p.last && Date.now() - p.last.at < 120000 ? {
                ok: p.last.ok, text: (p.cell(p.last.id) ? p.cell(p.last.id).label : p.last.id) + (p.last.ok ? (p.last.r && isNum(p.last.r.l100) ? ': ' + p.last.r.l100.toFixed(1) + ' l/100 km' : p.last.r && isNum(p.last.r.ml) ? ': ' + p.last.r.ml.toFixed(0) + ' ml' : '') : ' - ' + p.last.why),
            } : null;
            // findings
            const fnd = P.findings(p, mdl), found = [];
            const low = fnd.speeds.filter((s) => isNum(s.lowPct));
            if (low.length) found.push('One gear lower costs ' + low.map((s) => (s.lowPct >= 0 ? '+' : '') + s.lowPct.toFixed(0) + ' % at ' + s.v).join(', ') + ' km/h.');
            const auto = fnd.speeds.filter((s) => isNum(s.auto));
            if (auto.length >= 2) found.push('Steady in your own gear: ' + auto.map((s) => s.v + ': ' + s.auto.toFixed(1)).join('  ') + ' l/100 km.');
            const acc = fnd.accel.filter((r) => isNum(r.mlEq));
            if (acc.length >= 2) {
                const best = acc.slice().sort((a, b) => a.mlEq - b.mlEq)[0];
                found.push('Accelerating ' + P.ACCEL.from + '-' + P.ACCEL.to + ' km/h (same distance): ' + acc.map((r) => r.style.toLowerCase() + ' ' + r.mlEq.toFixed(0) + ' ml').join(', ') + ' - ' + best.style.toLowerCase() + ' is best.');
            }
            const co = fnd.coast.filter((r) => isNum(r.mlEq));
            if (co.length >= 2) {
                const best = co.slice().sort((a, b) => a.mlEq - b.mlEq)[0];
                found.push('Rolling out from ' + P.COAST.from + ' km/h (same distance): ' + co.map((r) => r.how.toLowerCase() + ' ' + r.mlEq.toFixed(0) + ' ml').join(', ') + ' - ' + best.how.toLowerCase() + ' is best.');
            }
            if (fnd.mode && isNum(fnd.mode.pct)) found.push('ECO PRO against Comfort at 100 km/h: ' + (fnd.mode.pct >= 0 ? '+' : '') + fnd.mode.pct.toFixed(1) + ' %.');
            if (sweet) found.push('Least fuel per km at ' + sweet.v + ' km/h (' + sweet.l100.toFixed(1) + ' l/100 km)' + (sweet.inside ? '.' : ', at the edge of what you drove.'));
            // source
            const src = d ? 'demo' : k && k.src, srcText = d ? 'Demo data - simulated car, not your figures' : src === 'signal' ? 'Fuel: car signal (scale learned)' :
                src === 'diag' ? 'Fuel: ' + refState : 'Fuel: no figure yet - ' + refState;
            const tripsList = st.trips.map((x) => Object.assign({ when: when(x.t0), cost: isNum(x.litres) ? x.litres * (x.price || price()) : null }, x));
            const tot = st.trips.reduce((a, x) => ({ km: a.km + (x.km || 0), l: a.l + (x.litres || 0), s: a.s + (x.score || 0) * (x.km || 0) }), { km: 0, l: 0, s: 0 });
            return {
                demo: !!d, currency, sourceText: srcText, sourceOk: !!(src && src !== 'demo') || !!d,
                trip: sm, now: { moving: !!(k && k.v > 5), v: k ? k.v : null, gear: k && k.gear, mode: k && MODE_NAMES[k.mode],
                    lph, l100: k && k.v > 5 && isNum(lph) ? lph / k.v * 100 : null, cruise: k && M.classify(k) === 'cruise',
                    typical: k && k.v > 25 && mdl.ok ? mdl.l100(k.v, { outside: k.outside, slope: 0, mode: k.mode || 'comfort', coolant: k.coolant, ac: k.ac === true }) : null },
                coach: settings.get('coach') === false ? [] : coachLines(k, mdl, gt, p),
                trips: tripsList, lastTrip: tripsList[0] || null, partMax: { accel: 30, anticipation: 25, gear: 25, idle: 10, speed: 10 },
                tripTotals: st.trips.length ? st.trips.length + ' trips, ' + Math.round(tot.km) + ' km, ' + (tot.km ? (tot.l / tot.km * 100).toFixed(1) : '--') + ' l/100 km, mean score ' + (tot.km ? Math.round(tot.s / tot.km) : '--') + '   (' + f.name + ')' : '',
                curve: mdl.curve(30, 160, 5), bins: binPts, testPts, sweet: sweet, gears: gt,
                modelText: mdl.ok ? mdl.n + ' samples, R2 ' + (isNum(mdl.r2) ? mdl.r2.toFixed(2) : '--') + ', ' + f.name : 'Model: ' + mdl.n + ' samples, needs 20 at 3 speeds',
                test: { active: p.active, complete: p.complete(), any: Object.keys(p.results).length > 0, canStart: !!d || !moving(),
                    next: nx ? nx.text : null, measuring, last: lastRes, done: prog.done, of: prog.of, rows },
                effects: mdl.effects(), found,
            };
        }
        function render() {
            const v = view(), t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            UI.draw(cv, t, page, v, ctl);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, render);
        render().catch((e) => log.warn('first frame: ' + e));
        log.info('Eco Coach started: ' + store.samples.length + ' samples, ' + store.trips.length + ' trips, fuel ' + fuel().id + (flow.k ? ', fuel signal scale ' + flow.k.toPrecision(4) : ''));
    },
});
