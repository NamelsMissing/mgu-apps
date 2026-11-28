'use strict';
/**
 * decode.js - turns the car's SOME/IP values into what Eco Coach needs. Pure module (offline tests).
 * Scalings as in the kit's car.js (BMW's own TypeConverters) and the idrive7-apps Live Data catalogue.
 */

const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10 };
/** statusGearboxDrive.statusActualGearDrive: names or wire numbers (G1 = 3 ... G10 = 12) -> 1..10 or null */
const gearOf = (x) => (typeof x === 'number' ? (x >= 3 && x <= 12 ? x - 2 : null) : GEARS[x] || null);
/** statusGearboxDrive.statusActualStageDrive: names or wire numbers (P = 1, R = 2, N = 3, D = 4) */
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
const stageOf = (x) => STAGES[x] || null;

/** DataPowerTrain2.statusGearSelectionDrive: names or wire numbers (N = 1, R = 2, P = 3, NP = 4, _1 = 5 ... _9 = 13) */
function selectionOf(x) {
    const n = typeof x === 'number' ? x : { N: 1, R: 2, P: 3, NP: 4 }[x] || (/^_\d$/.test(String(x)) ? 4 + Number(String(x).slice(1)) : 0);
    if (n === 1) return { stage: 'N', gear: null };
    if (n === 2) return { stage: 'R', gear: null };
    if (n === 3) return { stage: 'P', gear: null };
    if (n >= 5 && n <= 13) return { stage: 'D', gear: n - 4 };
    return null;                                                    // N or P not told apart, initialising, invalid
}

/** FES driving experience switch (names, or numbers 1..10 as in Live Data) -> 'eco' / 'comfort' / 'sport' / null */
function modeOf(x) {
    if (typeof x === 'number') return x >= 1 && x <= 3 ? 'sport' : x >= 4 && x <= 6 ? 'comfort' : x >= 7 && x <= 9 ? 'eco' : x === 10 ? 'comfort' : null;
    const s = String(x || '').toUpperCase();
    if (/ECO/.test(s)) return 'eco';
    if (/SPORT/.test(s)) return 'sport';
    if (/COMFORT|KOMFORT|ADAPTIV/.test(s)) return 'comfort';
    return null;
}

/**
 * A/C on? from ClimateMaster.statusAirCondAC, whose layout is not documented here: only clear on / off
 * words count (EIN / AUS, ON / OFF, AKTIV / INAKTIV); numbers stay unknown (null). The first value is logged
 * so the field can be checked in the car.
 */
function acOf(v) {
    const vals = v && typeof v === 'object' ? Object.keys(v).map((k) => v[k]) : [v];
    for (const x of vals) {
        const s = String(x).toUpperCase();
        if (/(^|_)(AUS|OFF|INAKTIV|INACTIVE|DEAKTIVIERT)($|_)/.test(s)) return false;
        if (/(^|_)(EIN|ON|AKTIV|ACTIVE|AKTIVIERT)($|_)/.test(s)) return true;
    }
    return null;
}

/** raw -> value with an invalid marker: { k, o, bad } */
function scaled(raw, k, o, bad) {
    if (typeof raw !== 'number' || !isFinite(raw) || (bad !== undefined && raw === bad)) return null;
    return raw * k + (o || 0);
}
const speedKmh = (raw) => scaled(raw, 0.015625, 0, 65535);
const rpm = (raw) => scaled(raw, 0.25, 0, 65535);
const temp48 = (raw) => scaled(raw, 1, -48, 255);
const accelMs2 = (raw) => scaled(raw, 0.002, -65, 65535);
const outsideC = (raw) => scaled(raw, 0.5, -40, 255);
function pedalPct(raw) { const x = scaled(raw, 0.025, 0); return x === null || x < -2 || x > 102 ? null : Math.max(0, x); }

/**
 * The road's slope from the acceleration sensor: it feels the change of speed plus the part of gravity
 * along the car, so (measured - dv/dt) / g = sin(slope). Clamped to ±12 %. Checked in the car: on a level
 * road both directions should give about 0; a sensor that already takes gravity out gives 0 everywhere,
 * and the model then simply leaves the slope out.
 */
function slopeOf(aMeasured, aSpeed) {
    if (typeof aMeasured !== 'number' || typeof aSpeed !== 'number') return null;
    return Math.max(-0.12, Math.min(0.12, (aMeasured - aSpeed) / 9.80665));
}

module.exports = { gearOf, stageOf, selectionOf, modeOf, acOf, speedKmh, rpm, temp48, accelMs2, outsideC, pedalPct, slopeOf };
