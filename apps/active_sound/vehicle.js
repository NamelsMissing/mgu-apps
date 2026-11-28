/*
 * vehicle.js - a small longitudinal car model for the demo drive (phone page, WAV export).
 *
 * In the car Active Sound follows the real engine; without a car this model makes the virtual
 * engine behave like it is pulling a vehicle: torque curve, turbo lag, gears with an automatic
 * shift logic (torque cut while shifting, kickdown), clutch slip at launch, inertia, air and
 * rolling resistance, engine braking on overrun, brakes, rev limiter.
 * ES2015 only, shared by Node and the browser (module.exports or global ActiveSoundVehicle).
 *
 *   var car = new VehicleSim(profile);
 *   var s = car.step(dt, throttle 0..1, brake 0..1);   // { rpm, load, kmh, gear, shifting, limiter }
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ActiveSoundVehicle = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
    'use strict';
    function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
    var G = 9.81, RHO = 1.2, ETA = 0.9;
    // kW, kg, top speed km/h, gears, shift time s, CdA m2, wheel radius m
    var GROUP = {
        Race: { kw: 420, kg: 1450, vmax: 310, gears: 7, shift: 0.1, cda: 0.62 },
        Sport: { kw: 280, kg: 1650, vmax: 270, gears: 8, shift: 0.18, cda: 0.66 },
        Classic: { kw: 300, kg: 1750, vmax: 250, gears: 6, shift: 0.3, cda: 0.75 },
        Luxury: { kw: 450, kg: 1950, vmax: 300, gears: 8, shift: 0.2, cda: 0.68 },
        Diesel: { kw: 140, kg: 1650, vmax: 225, gears: 8, shift: 0.25, cda: 0.66 },
        Electric: { kw: 300, kg: 2100, vmax: 200, gears: 1, shift: 0, cda: 0.6 },
    };
    var OWN = {
        vtwin: { kw: 70, kg: 340, vmax: 190, gears: 6, shift: 0.15, cda: 0.5, wheel: 0.32 },
        diesel_v6: { kw: 210, kg: 1950 }, diesel_v8: { kw: 300, kg: 2350, vmax: 250 },
        diesel_pickup: { kw: 330, kg: 3300, vmax: 180, gears: 6, cda: 1.1, shift: 0.35 },
        diesel_truck: { kw: 380, kg: 18000, vmax: 105, gears: 12, cda: 6, shift: 0.7, wheel: 0.52, crr: 0.006 },
        f1_v6: { kw: 740, kg: 800, vmax: 340, gears: 8, shift: 0.04, cda: 1.1 },
        turbine: { kw: 400, kg: 1800, vmax: 280, gears: 1 },
        v8_muscle: { kw: 520, kg: 1850, vmax: 290 },
    };
    function settings(p) {
        var g = GROUP[p.group] || GROUP.Sport, o = OWN[p.id] || {}, s = {}, k;
        for (k in g) s[k] = g[k];
        for (k in o) s[k] = o[k];
        if (!s.wheel) s.wheel = 0.33;
        if (!s.crr) s.crr = 0.012;
        return s;
    }
    /** Full-load torque shape over n = 0 (idle) .. 1 (redline). */
    function shape(p, n) {
        if (p.fuel === 'diesel') return n < 0.3 ? 0.55 + 1.5 * n : n < 0.7 ? 1 : 1 - (n - 0.7) * 1.1;
        if (p.turbo) return n < 0.2 ? 0.5 + 2.5 * n : n < 0.75 ? 1 : 1 - (n - 0.75) * 1.2;
        return n < 0.8 ? 0.6 + 0.5 * n : 1 - (n - 0.8);
    }

    function VehicleSim(profile) {
        var p = profile, s = settings(p);
        this.p = p; this.s = s;
        this.range = Math.max(500, p.redline - p.idle);
        this.electric = p.kind === 'tonal' && p.source === 'speed';
        this.turbine = p.kind === 'tonal' && !this.electric;
        var w88 = (p.idle + 0.88 * this.range) * Math.PI / 30;
        this.tPeak = s.kw * 1000 / (w88 * shape(p, 0.88));
        // gears: geometric spread, top gear 1.0; final drive puts top gear at redline ~5 % above vmax
        var n = Math.max(1, s.gears), spread = n === 1 ? 1 : n <= 6 ? 4.8 : n <= 8 ? 6.2 : 13;
        this.ratios = [];
        for (var i = 0; i < n; i++) this.ratios.push(n === 1 ? 1 : Math.pow(spread, (n - 1 - i) / (n - 1)));
        var wheelRpmTop = s.vmax * 1.05 / 3.6 / (2 * Math.PI * s.wheel) * 60;
        this.final = p.redline * 0.97 / wheelRpmTop;
        this.reset();
    }
    var V = VehicleSim.prototype;
    V.reset = function () {
        this.v = 0; this.gear = 1; this.rpm = this.p.idle; this.boost = 0; this.u = 0;
        this.shiftLeft = 0; this.shiftFrom = 0; this.shiftTo = 0; this.lastShift = -9; this.t = 0; this.cut = false; this.spool = 0;
    };
    V.ratio = function (g) { return this.ratios[(g || this.gear) - 1] * this.final; };
    V.wheelRpm = function (g) { return this.v / (2 * Math.PI * this.s.wheel) * 60 * this.ratio(g); };
    V.kmh = function () { return this.v * 3.6; };
    V.shiftTo_ = function (g) {
        this.shiftFrom = this.rpm; this.shiftTo = g; this.shiftLeft = this.s.shift; this.lastShift = this.t;
        if (!this.s.shift) this.gear = g;
    };

    /** Advance by dt seconds (keep dt <= 0.02 s). */
    V.step = function (dt, throttle, brake) {
        var p = this.p, s = this.s, idle = p.idle, red = p.redline;
        this.t += dt;
        this.u += (clamp(throttle || 0, 0, 1) - this.u) * Math.min(1, dt / 0.12);    // pedal + throttle body
        var u = this.u, b = clamp(brake || 0, 0, 1);
        var mass = s.kg, res = 0.5 * RHO * s.cda * this.v * this.v + (this.v > 0.05 ? s.crr * mass * G : 0);
        var fBrake = b * mass * G * 0.9, out = { limiter: false, shifting: false };

        if (this.electric || this.turbine) {
            var power = s.kw * 1000;
            if (this.turbine) {               // spool lags the throttle, power follows the spool
                this.spool += ((0.08 + 0.92 * u) - this.spool) * Math.min(1, dt / (u > this.spool ? 1.4 : 0.9));
                power *= Math.max(0, (this.spool - 0.15) / 0.85) * u;
            } else power *= this.kmh() < s.vmax ? u : 0;
            var f = power / Math.max(this.v, 14);
            this.v = Math.max(0, this.v + (f - res - fBrake) / (mass * 1.05) * dt);
            var nn = this.turbine ? this.spool : Math.min(1, this.kmh() / 200);
            this.rpm = idle + nn * this.range;
            out.rpm = this.rpm; out.load = u; out.kmh = this.kmh(); out.gear = 1;
            return out;
        }

        // ---- gearbox logic
        if (this.shiftLeft > 0) {
            this.shiftLeft -= dt;
            out.shifting = true;
            var target = Math.max(idle, this.wheelRpm(this.shiftTo));
            this.rpm += (target - this.rpm) * Math.min(1, dt / Math.max(0.03, this.shiftLeft + dt));
            if (this.shiftLeft <= 0) { this.gear = this.shiftTo; this.shiftLeft = 0; this.lastShift = this.t; }
        } else if (this.t - this.lastShift > 0.5) {
            var n = (this.rpm - idle) / this.range;
            // sport logic: short shifts when cruising, hold the gear on overrun (pops, engine brake)
            var up = u < 0.05 ? 0.9 : 0.42 + 0.53 * u;
            if (this.gear < this.ratios.length && n > up && this.wheelRpm(this.gear + 1) > idle * 1.1) this.shiftTo_(this.gear + 1);
            else if (this.gear > 1 && (n < 0.12 || (u > 0.85 && n < 0.5 && this.wheelRpm(this.gear - 1) < red * 0.88)) && this.wheelRpm(this.gear - 1) < red * 0.92)
                this.shiftTo_(this.gear - 1);                              // coast-down or kickdown
        }

        // ---- engine torque (turbo lag, limiter, friction)
        var nE = clamp((this.rpm - idle) / this.range, 0, 1.05);
        if (p.turbo) this.boost += ((nE > 0.12 ? u : 0) - this.boost) * Math.min(1, dt / (u > this.boost ? 0.6 : 0.25));
        var boostF = p.turbo ? 0.55 + 0.45 * this.boost : 1;
        if (this.rpm >= red) this.cut = true; else if (this.rpm < red - 0.04 * this.range) this.cut = false;
        var drive = this.cut || out.shifting ? 0 : u * this.tPeak * shape(p, nE) * boostF;
        var tq = drive - this.tPeak * (0.05 + 0.08 * nE);              // friction / pumping = engine braking
        out.limiter = this.cut && u > 0.5;

        // ---- clutch: slips below the gear's engaged speed (launch, crawling)
        var wheel = this.wheelRpm();
        var launch = idle + u * 0.32 * this.range;
        var slipping = this.gear === 1 && wheel < launch;
        var fDrive = 0;
        if (out.shifting) fDrive = 0;
        else if (slipping) {
            // clutch holds the engine near the launch rpm and passes the engine torque
            var want = Math.max(idle, launch);
            this.rpm += (want - this.rpm) * Math.min(1, dt / 0.18);
            fDrive = u > 0.02 ? Math.max(0, drive) * this.ratio() * ETA / s.wheel : 0;
        } else {
            this.rpm = Math.max(idle, wheel);
            if (this.rpm > red * 1.02) this.rpm = red * 1.02;
            fDrive = tq * this.ratio() * ETA / s.wheel;
        }
        var inertia = mass * (1.04 + 0.0018 * this.ratio() * this.ratio() / 10);
        this.v = Math.max(0, this.v + (fDrive - res - (this.v > 0 ? fBrake : 0)) / inertia * dt);
        if (this.v === 0 && !slipping && this.gear === 1) this.rpm = Math.max(idle, this.rpm);

        out.rpm = this.cut && u > 0.5 ? red : this.rpm;
        out.load = out.shifting ? 0 : out.limiter ? u : tq > 0 ? clamp(u * boostF, 0, 1) : 0;
        out.kmh = this.kmh(); out.gear = this.gear;
        return out;
    };

    /**
     * Scripted demo drive: throttle and brake over time (s). Idle, a blip, a full-throttle pull
     * through the gears, overrun, part-throttle cruise, kickdown, braking, idle.
     */
    var DRIVE_SECONDS = 30;
    function script(t) {
        if (t < 2) return { u: 0, b: 0 };
        if (t < 2.35) return { u: 0.7, b: 0 };
        if (t < 3.6) return { u: 0, b: 0 };
        if (t < 12.5) return { u: 1, b: 0 };
        if (t < 15.5) return { u: 0, b: 0 };
        if (t < 20) return { u: 0.28, b: 0 };
        if (t < 23.5) return { u: 1, b: 0 };
        if (t < 27.5) return { u: 0, b: 0.45 };
        return { u: 0, b: 1 };
    }

    return { VehicleSim: VehicleSim, settings: settings, shape: shape, script: script, DRIVE_SECONDS: DRIVE_SECONDS };
});
