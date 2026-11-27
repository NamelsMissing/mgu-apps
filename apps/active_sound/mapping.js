'use strict';
/*
 * mapping.js - from the real car to the virtual engine.
 *
 * Real engine speed (CDS statusEngineSpeed2) is mapped linearly from the car's own idle..redline
 * onto the profile's idle..redline, so a 318d at 4800 rpm sounds like a V10 at 8700. Electric
 * profiles ('speed') follow road speed instead. Load comes from the crankshaft torque
 * (FES statusActualValueTorque2) against the car's maximum torque; without torque it falls back
 * to the longitudinal acceleration.
 *
 * Silence rules (the sound must never hang on): no fresh rpm sample (older than STALE_MS) or
 * engine below RUNNING_RPM = off. Demo data (no car) is marked as such.
 */
const RUNNING_RPM = 350;
const STALE_MS = 5000;            // speed / rpm are notified on change and re-read every 3 s
const TORQUE_STALE_MS = 2500;
const EV_FULL_KMH = 200;
const REAL_REDLINES = [4500, 5000, 5500, 6000, 6500, 7000, 7500];
const MAX_TORQUES = [250, 300, 350, 400, 450, 500, 600, 700, 800];
const DEFAULTS = { realIdle: 750, realRedline: 5000, maxTorque: 400 };

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function fresh(d, key, now, maxAge) {
    if (d.demo) return d[key] !== undefined && d[key] !== null;
    const at = d.receivedAt && d.receivedAt[key];
    return typeof at === 'number' && now - at <= maxAge && at <= now + 1000;
}
function num(x) { return typeof x === 'number' && isFinite(x); }

/**
 * d: Car.data() ({ rpm, speed, torque, gLong, demo, receivedAt }); profile: engines.js entry;
 * cfg: { realIdle, realRedline, maxTorque }. Returns the targets for the synthesizer and why.
 */
function map(d, profile, cfg, now) {
    // the demo drive (kit sim.js) is a petrol car revving to ~7000 rpm with up to ~580 Nm
    const c = Object.assign({}, DEFAULTS, cfg || {}, d && d.demo ? { realIdle: 850, realRedline: 7000, maxTorque: 580 } : {});
    now = now || Date.now();
    const out = { running: false, rpm: 0, load: 0, n: 0, reason: '', demo: !!(d && d.demo), loadSource: 'none' };
    if (!d) { out.reason = 'No vehicle data yet'; return out; }
    const rpmOk = num(d.rpm) && fresh(d, 'rpm', now, STALE_MS);
    if (!rpmOk) { out.reason = 'Waiting for engine speed'; return out; }
    if (d.rpm < RUNNING_RPM) { out.reason = 'Engine off'; return out; }
    out.running = true;
    // load
    if (num(d.torque) && fresh(d, 'torque', now, TORQUE_STALE_MS)) {
        out.load = clamp(d.torque / Math.max(50, c.maxTorque), 0, 1);
        out.loadSource = 'torque';
    } else if (num(d.gLong) && fresh(d, 'gLong', now, TORQUE_STALE_MS)) {
        out.load = clamp(0.15 + d.gLong / 0.3, 0, 1);
        out.loadSource = 'accel';
    } else {
        out.load = 0.35;
        out.loadSource = 'fixed';
    }
    // engine speed
    if (profile.kind === 'tonal' && profile.source === 'speed') {
        const kmh = num(d.speed) && fresh(d, 'speed', now, STALE_MS) ? Math.max(0, d.speed) : 0;
        out.n = clamp(kmh / EV_FULL_KMH, 0, 1);
    } else {
        out.n = clamp((d.rpm - c.realIdle) / Math.max(500, c.realRedline - c.realIdle), 0, 1.02);
    }
    out.rpm = profile.idle + out.n * (profile.redline - profile.idle);
    return out;
}

function nextIn(list, value, d) {
    let i = list.indexOf(value);
    if (i < 0) i = 0;
    return list[(i + d + list.length) % list.length];
}

module.exports = { map, nextIn, RUNNING_RPM, STALE_MS, REAL_REDLINES, MAX_TORQUES, DEFAULTS, EV_FULL_KMH };
