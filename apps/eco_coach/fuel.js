'use strict';
/**
 * fuel.js - fuel types and the fuel-flow sources of Eco Coach (diesel and petrol). The Flow class follows the
 * fuel signal of idrive7-apps' Live Data (MIT, see THIRD_PARTY_NOTICES.md).
 *
 * Pure module: no kit, no car. Used by main.js and by the offline tests.
 *
 * Where the fuel figure comes from, in this order:
 *   1. 'signal'  the car's own fuel injection signal (CDS2.statusInjectionVolume), a 16 bit counter of injected
 *                fuel that the car sends the head unit by itself. Its scale is not published, so it is learned
 *                (Flow.learn) from a reference figure read from the engine unit, then kept in data/.
 *   2. 'diag'    the reference figure itself, read with OBD service 01 / UDS 0x22 (read only) from the engine
 *                unit (DDE or DME): engine fuel rate, standard PIDs that both fuel types may answer.
 * No figure (neither answers) = no consumption is shown; nothing is estimated from engine speed or torque.
 */

const FUELS = {
    // density kg/l (EN 590 / EN 228 typical), CO2 kg per litre burnt, the warm engine's idle consumption for the demo
    diesel: { id: 'diesel', name: 'Diesel', density: 0.832, co2: 2.65, idleLph: 0.55, efficientRpm: 2000 },
    petrol: { id: 'petrol', name: 'Petrol', density: 0.745, co2: 2.37, idleLph: 0.75, efficientRpm: 2500 },
};

/** OBD-II PID 01 51 (fuel type, SAE J1979 table) -> 'diesel' / 'petrol' / null (other or unknown). */
function fuelTypeFromObd(code) {
    if (typeof code !== 'number') return null;
    if ([0x04, 0x13, 0x17].indexOf(code) >= 0) return 'diesel';            // diesel, hybrid diesel, bi-fuel running diesel
    if ([0x01, 0x03, 0x09, 0x0A, 0x11, 0x12].indexOf(code) >= 0) return 'petrol';   // gasoline, ethanol, bi-fuel, hybrid
    return null;
}

/** The fuel type in use: the setting wins, else what the engine unit said, else diesel (the developer's G21). */
function resolveFuel(setting, detected) {
    if (setting === 'diesel' || setting === 'petrol') return FUELS[setting];
    return FUELS[detected] || FUELS.diesel;
}

/**
 * Reference fuel-rate candidates (kit/dids.js DidReader format), tried in this order by the engine unit at
 * the engine's address (0x12 on G-series DDE and DME). kind 'lph' = litres an hour; 'gps' = grams a second
 * (converted with the fuel's density). Only service 01 and 0x22 are used: reading only.
 */
const FUEL_RATE = [
    { kind: 'lph', obd: '5E', bytes: 2, factor: 0.05, min: 0, max: 120, timeoutMs: 1500 },        // engine fuel rate, l/h
    { kind: 'lph', did: 'F45E', bytes: 2, factor: 0.05, min: 0, max: 120, timeoutMs: 1500 },      // the same over UDS
    { kind: 'gps', obd: '9D', bytes: 2, factor: 0.02, min: 0, max: 30, timeoutMs: 1500 },         // OBFCM engine fuel rate, g/s
    { kind: 'gps', did: 'F49D', bytes: 2, factor: 0.02, min: 0, max: 30, timeoutMs: 1500 },
];
const FUEL_TYPE = { obd: '51', bytes: 1, min: 0, max: 0x20, timeoutMs: 1500 };

/** A reference reading in l/h from candidate c and its raw value. */
function toLph(c, value, fuel) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    return c.kind === 'gps' ? value * 3.6 / fuel.density : value;
}

/**
 * The fuel injection signal as a flow: the 16 bit counter (it wraps) turned into counts a second over at
 * least one second; l/h = rate x k. k is learned from the reference: learn(lph, now) while both are known,
 * the median of the last ratios once their quartiles agree within 30 %.
 */
class Flow {
    constructor(k) {
        this.k = typeof k === 'number' && k > 0 ? k : null;
        this.last = null; this.acc = 0; this.accT = 0; this.rate = null; this.rateT = 0;
        this.ratios = []; this.spread = null;
    }
    feed(raw, t) {
        if (typeof raw !== 'number' || !isFinite(raw)) return;
        if (this.last && t > this.last.t) {
            const d = (raw - this.last.raw + 65536) % 65536, dt = t - this.last.t;
            if (dt > 5000 || d > 40000) { this.acc = 0; this.accT = 0; }       // a gap or a reset: start over
            else {
                this.acc += d; this.accT += dt;
                if (this.accT >= 1000) { this.rate = this.acc / this.accT * 1000; this.rateT = t; this.acc = 0; this.accT = 0; }
            }
        }
        this.last = { raw, t };
    }
    /**
     * counts a second now; 0 once nothing new came for 3 s (engine off or fuel cut-off: a car may send the
     * field only when it changes)
     */
    rateAt(now) {
        if (!this.last) return null;
        if (now - this.last.t > 3000) return 0;
        return this.rate;
    }
    lph(now) { const r = this.rateAt(now); return r === null || !this.k ? null : r * this.k; }
    /** Learn k from a reference l/h at about the same time; true when k changed by more than 2 %. */
    learn(lph, now) {
        const r = this.rateAt(now);
        if (!(r > 0) || !(lph > 0.4) || now - this.rateT > 1500) return false;
        this.ratios.push(lph / r);
        if (this.ratios.length > 30) this.ratios.shift();
        if (this.ratios.length < 10) return false;
        const s = this.ratios.slice().sort((a, b) => a - b), q1 = s[Math.floor(s.length / 4)], q3 = s[Math.floor(s.length * 3 / 4)];
        this.spread = q3 / q1;
        if (this.spread > 1.3) return false;
        const k = s[Math.floor(s.length / 2)], old = this.k;
        this.k = k;
        return !old || Math.abs(k - old) / old > 0.02;
    }
}

module.exports = { FUELS, FUEL_RATE, FUEL_TYPE, fuelTypeFromObd, resolveFuel, toLph, Flow };
