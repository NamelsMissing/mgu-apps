/*
 * engines.js - the engine sound profiles of Active Sound.
 *
 * Shared by the head unit (Node 8) and the phone page (browser, AudioWorklet): plain
 * data, no syntax newer than ES2015, exported as module.exports or the global
 * ActiveSoundEngines.
 *
 * All profiles are original synthesis settings (generic engine layouts, no recordings,
 * no samples, no brand names). Combustion profiles ('pulse'):
 *   cyl / cycle   cylinders; crankshaft revolutions per working cycle (2 = four-stroke,
 *                 1 = rotary: each rotor fires once per eccentric-shaft revolution)
 *   fire          firing points as a fraction of the cycle (default: evenly spaced)
 *   amp           relative strength per firing (bank / header differences = burble)
 *   idle, redline virtual engine range in rpm
 *   body          exhaust resonances [Hz, Q, gain]
 *   decay         grit envelope of one firing in seconds
 *   grit, rough   noise in each pulse; random pulse-to-pulse variation (strongest at idle)
 *   thump         low-pass "pressure" share of the pulse
 *   orders        smooth harmonic layer [engine order per revolution, gain]
 *   intake        intake roar with throttle
 *   turbo         { whistle Hz at full boost, gain, bov = blow-off on lift }
 *   blower        { ratio x crank speed, gain } supercharger / e-motor whine
 *   knock         short high click per firing (diesel clatter, air-cooled twins)
 *   pops          overrun crackle
 *   tone, bright  cabin low-pass: base Hz and extra Hz with load x rpm
 * Tonal profiles ('tonal', electric / turbine): layers [ratio x rpm/60 Hz, gain],
 * fm (vibrato depth), whine { f0, f1 Hz, gain }, noise { gain, f0, f1 Hz, q }.
 * source: 'rpm' follows the real engine speed, 'speed' the road speed (electric).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ActiveSoundEngines = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
    'use strict';
    var PROFILES = [
        { id: 'inline6', name: 'Inline-6 Turbo', short: 'I6 TURBO', kind: 'pulse', group: 'Sport',
            desc: 'Smooth straight six, single turbo, crisp throttle and a soft whistle.',
            cyl: 6, cycle: 2, amp: [1, 0.96, 1, 0.97, 0.99, 0.95], idle: 750, redline: 7000,
            body: [[110, 3, 1], [230, 4, 0.7], [520, 5, 0.35], [1250, 3, 0.12]], decay: 0.006, grit: 0.25, rough: 0.12,
            thump: 0.9, orders: [[3, 0.5], [6, 0.25], [1.5, 0.12], [9, 0.08]], intake: 0.25,
            turbo: { whistle: 4200, gain: 0.07, bov: 0.1 }, pops: 0.5, tone: 900, bright: 2600 },
        { id: 'v8_cross', name: 'V8 Biturbo', short: 'V8 BITURBO', kind: 'pulse', group: 'Sport',
            desc: 'Cross-plane V8: deep burble at idle, thunder under load, two turbos.',
            cyl: 8, cycle: 2, amp: [1, 0.78, 1, 0.78, 0.78, 1, 0.78, 1], idle: 650, redline: 7200,
            body: [[85, 2.5, 1], [180, 3, 0.75], [380, 4, 0.4], [900, 3, 0.12]], decay: 0.009, grit: 0.3, rough: 0.18,
            thump: 1.1, orders: [[4, 0.5], [2, 0.3], [1, 0.15], [8, 0.15], [0.5, 0.1]], intake: 0.3,
            turbo: { whistle: 3600, gain: 0.05, bov: 0.12 }, pops: 0.8, tone: 700, bright: 2200 },
        { id: 'v8_muscle', name: 'V8 Muscle', short: 'V8 MUSCLE', kind: 'pulse', group: 'Classic',
            desc: 'Big-block V8 with a lumpy cam and supercharger whine.',
            cyl: 8, cycle: 2, amp: [1, 0.65, 1, 0.7, 0.68, 1, 0.66, 1], idle: 750, redline: 6200,
            body: [[65, 2, 1], [140, 2.5, 0.8], [300, 3, 0.4], [700, 3, 0.12]], decay: 0.012, grit: 0.35, rough: 0.45,
            thump: 1.3, orders: [[4, 0.45], [2, 0.35], [0.5, 0.2], [1, 0.2]], intake: 0.45,
            blower: { ratio: 60, gain: 0.025 }, pops: 0.6, tone: 650, bright: 1800 },
        { id: 'v8_flat', name: 'V8 Flat-Plane', short: 'V8 FLAT', kind: 'pulse', group: 'Race',
            desc: 'High-revving flat-plane V8, hard edged and bright up to 9000 rpm.',
            cyl: 8, cycle: 2, amp: [1, 0.92, 1, 0.92, 1, 0.92, 1, 0.92], idle: 900, redline: 9000,
            body: [[150, 3, 1], [320, 4, 0.7], [700, 4, 0.4], [1600, 3, 0.2]], decay: 0.005, grit: 0.3, rough: 0.08,
            thump: 0.7, orders: [[4, 0.5], [8, 0.25], [2, 0.1]], intake: 0.35, pops: 0.5, tone: 1300, bright: 3500 },
        { id: 'v10', name: 'V10 Racing', short: 'V10', kind: 'pulse', group: 'Race',
            desc: 'Naturally aspirated V10: a howl that climbs to 8700 rpm.',
            cyl: 10, cycle: 2, amp: [1, 0.93, 1, 0.93, 1, 0.93, 1, 0.93, 1, 0.93], idle: 1000, redline: 8700,
            body: [[170, 3, 1], [360, 4, 0.65], [780, 4, 0.4], [1800, 3, 0.2]], decay: 0.0045, grit: 0.25, rough: 0.06,
            thump: 0.6, orders: [[5, 0.5], [10, 0.25], [2.5, 0.15]], intake: 0.4, pops: 0.4, tone: 1500, bright: 4000 },
        { id: 'v12', name: 'V12 GT', short: 'V12', kind: 'pulse', group: 'Luxury',
            desc: 'Silky V12: layered, smooth and effortless.',
            cyl: 12, cycle: 2, idle: 700, redline: 8500,
            body: [[140, 2.5, 1], [300, 3, 0.6], [650, 3.5, 0.35], [1500, 3, 0.2]], decay: 0.005, grit: 0.15, rough: 0.04,
            thump: 0.7, orders: [[6, 0.6], [12, 0.25], [3, 0.12], [1.5, 0.05]], intake: 0.3, pops: 0.25, tone: 1200, bright: 3500 },
        { id: 'inline4', name: 'Inline-4 Turbo', short: 'I4 TURBO', kind: 'pulse', group: 'Sport',
            desc: 'Punchy four with a big turbo: whistle and blow-off valve.',
            cyl: 4, cycle: 2, amp: [1, 0.97, 1, 0.98], idle: 800, redline: 6800,
            body: [[120, 3, 1], [260, 4, 0.6], [600, 4, 0.3], [1400, 3, 0.15]], decay: 0.006, grit: 0.3, rough: 0.1,
            thump: 0.9, orders: [[2, 0.5], [4, 0.25], [1, 0.1]], intake: 0.35,
            turbo: { whistle: 5200, gain: 0.09, bov: 0.15 }, pops: 0.6, tone: 1000, bright: 2800 },
        { id: 'inline5', name: 'Inline-5 Turbo', short: 'I5 TURBO', kind: 'pulse', group: 'Sport',
            desc: 'Five cylinders: the uneven warble of a rally legend.',
            cyl: 5, cycle: 2, amp: [1, 0.88, 0.96, 0.86, 0.94], idle: 800, redline: 7000,
            body: [[100, 3, 1], [210, 3.5, 0.7], [470, 4, 0.35], [1100, 3, 0.15]], decay: 0.007, grit: 0.3, rough: 0.1,
            thump: 1, orders: [[2.5, 0.5], [5, 0.25], [1.25, 0.12], [0.5, 0.08]], intake: 0.35,
            turbo: { whistle: 4600, gain: 0.08, bov: 0.14 }, pops: 0.7, tone: 950, bright: 2600 },
        { id: 'flat6', name: 'Flat-6 NA', short: 'FLAT-6', kind: 'pulse', group: 'Race',
            desc: 'Naturally aspirated boxer six, raspy intake, screams to 9000 rpm.',
            cyl: 6, cycle: 2, amp: [1, 0.9, 1, 0.9, 1, 0.9], idle: 850, redline: 9000,
            body: [[130, 3, 1], [280, 4, 0.7], [640, 4.5, 0.45], [1500, 3, 0.25]], decay: 0.005, grit: 0.35, rough: 0.07,
            thump: 0.7, orders: [[3, 0.5], [6, 0.3], [1.5, 0.1]], intake: 0.5, pops: 0.4, tone: 1400, bright: 3800 },
        { id: 'flat4', name: 'Flat-4 Rumble', short: 'FLAT-4', kind: 'pulse', group: 'Classic',
            desc: 'Boxer four with unequal-length headers: the off-beat rumble.',
            cyl: 4, cycle: 2, fire: [0, 0.27, 0.5, 0.79], amp: [1, 0.82, 1, 0.8], idle: 800, redline: 6800,
            body: [[90, 2.5, 1], [190, 3, 0.7], [420, 4, 0.3], [950, 3, 0.1]], decay: 0.008, grit: 0.3, rough: 0.15,
            thump: 1.1, orders: [[2, 0.4], [1, 0.3], [0.5, 0.15]], intake: 0.35,
            turbo: { whistle: 4000, gain: 0.08, bov: 0.16 }, pops: 0.6, tone: 850, bright: 2200 },
        { id: 'rotary', name: 'Twin Rotor', short: 'ROTARY', kind: 'pulse', group: 'Race',
            desc: 'Two-rotor rotary: buzzing, high revs, lots of crackle.',
            cyl: 2, cycle: 1, amp: [1, 0.95], idle: 900, redline: 9000,
            body: [[180, 2, 1], [400, 3, 0.7], [900, 3, 0.5], [2000, 2.5, 0.3]], decay: 0.003, grit: 0.55, rough: 0.1,
            thump: 0.6, orders: [[2, 0.4], [4, 0.3], [6, 0.2], [8, 0.1]], intake: 0.3,
            turbo: { whistle: 4800, gain: 0.06, bov: 0.12 }, pops: 1, tone: 1500, bright: 3500 },
        { id: 'f1_v6', name: 'Formula V6 Hybrid', short: 'F-V6 HYBRID', kind: 'pulse', group: 'Race',
            desc: 'Race V6 turbo hybrid: 15000 rpm, turbo and e-motor whine.',
            cyl: 6, cycle: 2, amp: [1, 0.95, 1, 0.95, 1, 0.95], idle: 4000, redline: 15000,
            body: [[300, 3, 1], [650, 4, 0.6], [1400, 4, 0.35], [2800, 3, 0.2]], decay: 0.0025, grit: 0.3, rough: 0.03,
            thump: 0.4, orders: [[3, 0.5], [6, 0.25], [1.5, 0.1]], intake: 0.3,
            turbo: { whistle: 7000, gain: 0.07, bov: 0 }, blower: { ratio: 14, gain: 0.03 }, pops: 0.3, tone: 2000, bright: 5000 },
        { id: 'diesel6', name: 'Diesel Inline-6', short: 'DIESEL I6', kind: 'pulse', group: 'Torque',
            desc: 'Big diesel six: clatter at idle, deep turbo torque.',
            cyl: 6, cycle: 2, amp: [1, 0.95, 1, 0.96, 0.98, 0.94], idle: 650, redline: 4600,
            body: [[75, 2.5, 1], [160, 3, 0.6], [350, 3.5, 0.3], [800, 3, 0.08]], decay: 0.01, grit: 0.4, rough: 0.1,
            thump: 1.1, orders: [[3, 0.5], [1.5, 0.25], [6, 0.1]], intake: 0.5, knock: 0.5,
            turbo: { whistle: 3200, gain: 0.09, bov: 0.05 }, pops: 0, tone: 650, bright: 1500 },
        { id: 'vtwin', name: 'V-Twin', short: 'V-TWIN', kind: 'pulse', group: 'Classic',
            desc: 'Big 45-degree V-twin: the off-beat potato rhythm.',
            cyl: 2, cycle: 2, fire: [0, 0.4375], amp: [1, 0.9], idle: 900, redline: 5800,
            body: [[70, 2, 1], [150, 2.5, 0.8], [330, 3, 0.4], [800, 3, 0.1]], decay: 0.012, grit: 0.35, rough: 0.25,
            thump: 1.3, orders: [[1, 0.4], [0.5, 0.35], [2, 0.2]], intake: 0.4, knock: 0.15, pops: 0.7, tone: 700, bright: 1800 },
        { id: 'ev_pulse', name: 'EV Pulse', short: 'EV PULSE', kind: 'tonal', group: 'Electric', source: 'speed',
            desc: 'Electric drive: rising chord that follows road speed.',
            idle: 0, redline: 12000,
            layers: [[0.5, 0.3], [1, 0.5], [1.5, 0.25], [2, 0.3], [3, 0.12]], fm: 0.004,
            whine: { f0: 400, f1: 3200, gain: 0.05 }, noise: { gain: 0.05, f0: 200, f1: 1200, q: 0.7 },
            hum: 55, tone: 2500, bright: 3500 },
        { id: 'turbine', name: 'Jet Turbine', short: 'TURBINE', kind: 'tonal', group: 'Electric', source: 'rpm',
            desc: 'Gas-turbine spool: rising whine over a rush of air.',
            idle: 2000, redline: 12000,
            layers: [[8.6, 0.15], [13.2, 0.1], [0.5, 0.25], [1, 0.12]], fm: 0.002,
            whine: { f0: 1800, f1: 6500, gain: 0.08 }, noise: { gain: 0.6, f0: 150, f1: 2500, q: 0.5 },
            hum: 40, tone: 2200, bright: 4000 },
    ];
    var BY_ID = {};
    PROFILES.forEach(function (p) { BY_ID[p.id] = p; });
    function get(id) { return BY_ID[id] || PROFILES[0]; }
    function index(id) { for (var i = 0; i < PROFILES.length; i++) if (PROFILES[i].id === id) return i; return 0; }
    function step(id, d) { var i = index(id), n = PROFILES.length; return PROFILES[((i + d) % n + n) % n].id; }
    /** Short technical line for lists: "6 cyl - 7000 rpm". */
    function spec(p) {
        if (p.kind === 'tonal') return (p.source === 'speed' ? 'follows speed' : 'follows rpm') + ' - ' + p.group.toLowerCase();
        return (p.cycle === 1 ? p.cyl + ' rotors' : p.cyl + ' cyl') + ' - ' + p.redline + ' rpm';
    }
    return { PROFILES: PROFILES, DEFAULT: 'inline6', get: get, index: index, step: step, spec: spec };
});
