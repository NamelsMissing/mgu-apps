'use strict';
// Every exterior light Light Show can address, with its control route and where it sits on
// the car (for the 3D view and the phone page). Vehicle frame: x to the car's right,
// y up, z forward; metres, roughly a mid-size BMW.
//
// Routes:
//   flm - FLM_KANAL RoutineControl on the headlamp module (one LED channel per module at a time)
//   fn  - BDC timed light function D542 (both sides together, the ECU switches off by itself)
//   out - BDC IOControl E3B5 of one output (experimental: no visible effect on the tested G21)
const F = require('./flm-control');
const P = require('./protocol');
const DiagnosticOutputs = require('./diagnostic-outputs');
const Rl = require('./rlm-control');

const COLORS = Object.freeze({ white: '#eaf3ff', amber: '#ffae2e', red: '#ff3030', fog: '#fff1c4' });
const L = -1, R = 1;
const pt = (side, x, y, z) => [side * x, y, z];
const pair = (x, y, z) => [pt(L, x, y, z), pt(R, x, y, z)];

// Function lamps (route fn): BDC light functions D542. Which ones a car has depends on the BDC
// variant (protocol.js BODY_VARIANTS). 'side' tells the left/right effects where they belong.
const F_ = (key, label, short, color, points, group, side) => ({ key, label, short, color, points, group, side: side || 'both' });
const FRONT_L = [pt(L, 0.66, 0.74, 2.30)], FRONT_R = [pt(R, 0.66, 0.74, 2.30)];
const FUNCTIONS = Object.freeze([
    F_('high', 'High beam', 'HIGH', 'white', pair(0.62, 0.74, 2.30), 'front'),
    F_('low', 'Low beam', 'LOW', 'white', pair(0.58, 0.70, 2.30), 'front'),
    F_('drl', 'Daytime lights', 'DRL', 'white', pair(0.70, 0.78, 2.26), 'front'),
    F_('position', 'Side lights (front + rear)', 'POS', 'white', pair(0.72, 0.76, 2.24).concat(pair(0.70, 0.92, -2.30)), 'front'),
    F_('fog', 'Front fog lights', 'FOG', 'fog', pair(0.66, 0.34, 2.32), 'front'),
    F_('cornerLeft', 'Cornering light left', 'CRN L', 'white', [pt(L, 0.74, 0.66, 2.24)], 'front', 'left'),
    F_('cornerRight', 'Cornering light right', 'CRN R', 'white', [pt(R, 0.74, 0.66, 2.24)], 'front', 'right'),
    F_('indLeft', 'Indicators left', 'IND L', 'amber', [pt(L, 0.82, 0.72, 2.16), pt(L, 0.98, 1.02, 0.92), pt(L, 0.78, 0.90, -2.26)], 'side', 'left'),
    F_('indRight', 'Indicators right', 'IND R', 'amber', [pt(R, 0.82, 0.72, 2.16), pt(R, 0.98, 1.02, 0.92), pt(R, 0.78, 0.90, -2.26)], 'side', 'right'),
    F_('hazard', 'Hazard lights', 'HAZ', 'amber', pair(0.82, 0.72, 2.16).concat(pair(0.78, 0.90, -2.26)), 'side'),
    F_('parkLeft', 'Parking light left', 'PRK L', 'red', [pt(L, 0.72, 0.76, 2.24), pt(L, 0.70, 0.92, -2.30)], 'side', 'left'),
    F_('parkRight', 'Parking light right', 'PRK R', 'red', [pt(R, 0.72, 0.76, 2.24), pt(R, 0.70, 0.92, -2.30)], 'side', 'right'),
    F_('brake', 'Brake lights', 'BRK', 'red', pair(0.68, 0.86, -2.30).concat([[0, 1.38, -2.05]]), 'rear'),
    F_('rearFog', 'Rear fog light', 'RFOG', 'red', pair(0.55, 0.36, -2.36), 'rear'),
    F_('reverse', 'Reversing lights', 'REV', 'white', pair(0.42, 0.86, -2.33), 'rear'),
    F_('locator', 'Locator / functional lighting', 'LOC', 'white', pair(0.70, 0.78, 2.26).concat(pair(0.70, 0.92, -2.30)), 'side'),
    F_('grille', 'Illuminated kidney grille', 'GRL', 'white', [[0.14, 0.66, 2.38], [-0.14, 0.66, 2.38]], 'front'),
    F_('maneuver', 'Manoeuvring light', 'MAN', 'white', pair(0.96, 0.40, 1.60).concat(pair(0.96, 0.40, -1.60)), 'side'),
    F_('welcome', 'Welcome light', 'WEL', 'white', pair(0.70, 0.78, 2.26).concat(pair(0.70, 0.92, -2.30)), 'side'),
    F_('goodbye', 'Goodbye light', 'BYE', 'white', pair(0.70, 0.78, 2.26).concat(pair(0.70, 0.92, -2.30)), 'side'),
]);
// Rear light modules: position on the car per slot (1 = outer, 2 = inner / tailgate).
const RLM_PLACE = Object.freeze({ 0x17: [L, 0.74], 0x1A: [R, 0.74], 0x1C: [L, 0.46], 0x1E: [R, 0.46] });

// BDC outputs (route out): position and colour per output id.
const OUTPUT_PLACE = Object.freeze({
    0x01: [L, 0.60, 0.72, 2.30, 'white', 'front'], 0x02: [R, 0.60, 0.72, 2.30, 'white', 'front'],
    0x03: [L, 0.72, 0.78, 2.26, 'white', 'front'], 0x04: [R, 0.72, 0.78, 2.26, 'white', 'front'],
    0x07: [L, 0.66, 0.74, 2.30, 'white', 'front'], 0x08: [R, 0.66, 0.74, 2.30, 'white', 'front'],
    0x09: [L, 0.76, 0.76, 2.22, 'white', 'front'], 0x0A: [R, 0.76, 0.76, 2.22, 'white', 'front'],
    0x0B: [L, 0.66, 0.34, 2.32, 'fog', 'front'], 0x0C: [R, 0.66, 0.34, 2.32, 'fog', 'front'],
    0x0D: [L, 0.82, 0.72, 2.16, 'amber', 'front'], 0x0E: [R, 0.82, 0.72, 2.16, 'amber', 'front'],
    0x05: [L, 0.92, 0.62, 1.90, 'amber', 'side'], 0x06: [R, 0.92, 0.62, 1.90, 'amber', 'side'],
    0x10: [L, 0.98, 1.02, 0.92, 'amber', 'side'], 0x11: [R, 0.98, 1.02, 0.92, 'amber', 'side'],
    0x14: [L, 0.72, 0.92, -2.30, 'red', 'rear'], 0x15: [R, 0.72, 0.92, -2.30, 'red', 'rear'],
    0x16: [L, 0.50, 0.94, -2.33, 'red', 'rear'], 0x17: [R, 0.50, 0.94, -2.33, 'red', 'rear'],
    0x18: [L, 0.68, 0.86, -2.30, 'red', 'rear'], 0x19: [R, 0.68, 0.86, -2.30, 'red', 'rear'],
    0x23: [0, 0, 1.38, -2.05, 'red', 'rear'],
    0x1A: [L, 0.60, 0.98, -2.30, 'red', 'rear'], 0x1B: [R, 0.60, 0.98, -2.30, 'red', 'rear'],
    0x1C: [L, 0.55, 0.36, -2.36, 'red', 'rear'], 0x1D: [R, 0.55, 0.36, -2.36, 'red', 'rear'],
    0x1E: [L, 0.42, 0.86, -2.33, 'white', 'rear'], 0x1F: [R, 0.42, 0.86, -2.33, 'white', 'rear'],
    0x20: [L, 0.78, 0.90, -2.26, 'amber', 'rear'], 0x21: [R, 0.78, 0.90, -2.26, 'amber', 'rear'],
    0x22: [0, 0, 0.58, -2.38, 'white', 'rear'],
});

const GROUP_ORDER = Object.freeze({ front: 0, side: 1, rear: 2 });

function flmId(side, channel) { return 'flm:' + side + ':' + channel; }
function parse(id) {
    const s = String(id || '').split(':');
    if (s[0] === 'flm' && (s[1] === 'left' || s[1] === 'right') && /^([0-9]|1[0-7])$/.test(s[2]))
        return { route: 'flm', side: s[1], channel: Number(s[2]) };
    if (s[0] === 'fn' && s.length === 2 && FUNCTIONS.some((f) => f.key === s[1])) return { route: 'fn', key: s[1] };
    if (s[0] === 'rlm' && s.length === 3 && /^(17|1a|1c|1e)$/.test(s[1])) {
        const address = parseInt(s[1], 16), m = /^([fcg])(\d{1,2})$/.exec(s[2]);
        if (!m) return null;
        const item = Number(m[2]);
        if (m[1] === 'g' && item >= 0 && item <= Rl.GROUPS_RLM2) return { route: 'rlm', address, kind: 'grp', item };
        if (m[1] === 'f' && Rl.FUNCTIONS[item]) return { route: 'rlm', address, kind: 'fn', item };
        if (m[1] === 'c' && item >= 1 && item <= Rl.CHANNELS_RLM1) return { route: 'rlm', address, kind: 'ch', item };
        return null;
    }
    if (s[0] === 'out' && s.length === 2 && /^[0-9]{1,2}$/.test(s[1]) && DiagnosticOutputs.OUTPUTS[Number(s[1])])
        return { route: 'out', output: Number(s[1]) };
    return null;
}

/**
 * All lamps for this car. profile: ecu-scan profile (or null before the first scan),
 * names: Names store, options.allowExperimental: FLM02X / FLM2_1 opt-in.
 * Each lamp: {id, route, label, short, group, side, color, hex, points, available, why, ...}
 */
function catalog(profile, names, options) {
    const o = options || {}, routes = profile && profile.routes;
    const out = [];
    const why = (support) => !routes ? 'Vehicle not scanned yet: happens by itself once parked in P'
        : support === 'verified' || support === 'prg' ? '' : support === 'experimental' ? (o.allowExperimental ? '' : 'Experimental module: enable in Vehicle')
        : support === 'blocked' ? 'No supported body controller found' : support === 'absent' ? 'No identity returned in the scan'
        : 'Module variant not supported';
    for (const side of ['left', 'right']) {
        const support = routes ? routes.flm[side] : null, s = side === 'left' ? L : R;
        const fv = profile && profile.flm && profile.flm[side].index ? F.variant(side, profile.flm[side].index) : null;
        for (let c = 0; c <= (fv ? fv.channels : 15); c++) {
            const id = flmId(side, c), name = names ? names.name(id) : '';
            const sideName = side === 'left' ? 'Left' : 'Right';
            out.push({ id, route: 'flm', side, channel: c, group: 'front', color: 'white', hex: COLORS.white,
                label: name || (c === 0 ? sideName + ' headlamp, all LEDs' : sideName + ' headlamp LED ' + c),
                short: (side === 'left' ? 'L' : 'R') + (c === 0 ? '*' : c), named: !!name,
                points: c === 0 ? [pt(s, 0.56, 0.72, 2.28), pt(s, 0.66, 0.74, 2.27), pt(s, 0.74, 0.76, 2.24)]
                    : [pt(s, 0.50 + c * 0.017, 0.70 + (c % 3) * 0.022, 2.28 - c * 0.006)],
                module: fv ? fv.name : F.MODULES[side].name, index: profile && profile.flm[side].index,
                available: !why(support), why: why(support), support });
        }
    }
    const fnSupport = routes ? routes.fn : null, fnList = profile && profile.bdc && profile.bdc.functions;
    const bodyName = (profile && profile.bdc && profile.bdc.name) || 'BDC';
    for (const f of FUNCTIONS) {
        const id = 'fn:' + f.key;
        if (fnList && fnList.length && fnList.indexOf(f.key) < 0) continue;
        out.push({ id, route: 'fn', key: f.key, side: f.side, group: f.group, color: f.color, hex: COLORS[f.color],
            label: (names && names.name(id)) || f.label, short: f.short, points: f.points,
            module: bodyName + ' light function', available: !why(fnSupport), why: why(fnSupport), support: fnSupport });
    }
    const outSupport = routes ? routes.out : null;
    if (profile && profile.bdc && profile.bdc.present && !profile.bdc.outputs) return out.concat(rlmLamps(profile, names));
    for (const group of DiagnosticOutputs.GROUPS) for (const [idNum, label, prg] of group.lights) {
        const p = OUTPUT_PLACE[idNum];
        if (!p) continue;
        const id = 'out:' + idNum, color = p[4];
        out.push({ id, route: 'out', output: idNum, prg, group: p[5],
            side: p[0] === L ? 'left' : p[0] === R ? 'right' : 'centre', color, hex: COLORS[color],
            label: (names && names.name(id)) || label, short: prg, points: [pt(p[0] || 1, p[0] ? p[1] : 0, p[2], p[3])],
            module: 'BDC_G05 E3B5', available: !why(outSupport === 'experimental' ? 'verified' : outSupport),
            why: why(outSupport === 'experimental' ? 'verified' : outSupport), support: outSupport, experimental: true });
    }
    return out.concat(rlmLamps(profile, names));
}
function rlmLamps(profile, names) {
    const out = [];
    for (const r of (profile && profile.rlm) || []) {
        const place = RLM_PLACE[r.address], hx = r.address.toString(16);
        const sideName = r.side === 'left' ? 'Left' : 'Right', part = Rl.MODULES[r.address].position === 'outer' ? 'outer' : 'inner';
        const entries = [];
        (r.kinds || []).forEach((kind) => {
            if (kind === 'fn') Object.keys(Rl.FUNCTIONS).map(Number).forEach((item) => entries.push([kind, item]));
            if (kind === 'ch') for (let i = 1; i <= Rl.CHANNELS_RLM1; i++) entries.push([kind, i]);
            if (kind === 'grp') for (let i = 0; i <= Rl.GROUPS_RLM2; i++) entries.push([kind, i]);
        });
        for (const [kind, item] of entries) {
            const fn = kind === 'fn' ? Rl.FUNCTIONS[item] : null, color = fn ? fn.color : 'red';
            const id = 'rlm:' + hx + ':' + { fn: 'f', ch: 'c', grp: 'g' }[kind] + item;
            const what = fn ? fn.name : kind === 'grp' ? (item === 0 ? 'all segments' : 'segment ' + item) : 'LED ' + item;
            const spread = kind === 'grp' && item > 0 ? (item - 8.5) * 0.012 : kind === 'ch' ? item * 0.012 : 0;
            out.push({ id, route: 'rlm', address: r.address, kind, item, group: 'rear', side: r.side, color, hex: COLORS[color],
                label: (names && names.name(id)) || sideName + ' ' + part + ' tail light ' + what,
                short: (r.side === 'left' ? 'L' : 'R') + (part === 'outer' ? 'o' : 'i') + (fn ? fn.key : kind === 'grp' ? 'g' + item : item),
                points: [pt(place[0], place[1] + spread, 0.90 - (fn ? item * 0.01 : 0), -2.30)],
                module: r.name, index: r.index, available: r.support === 'prg', why: r.support === 'prg' ? '' : 'Rear light module not supported',
                support: r.support });
        }
    }
    return out;
}

/** Order lamps front to rear, left to right (for waves and the lists). */
function spatialOrder(lamps) {
    return lamps.slice().sort((a, b) => (GROUP_ORDER[a.group] - GROUP_ORDER[b.group])
        || (centroid(b)[2] - centroid(a)[2]) || (centroid(a)[0] - centroid(b)[0]));
}
function centroid(l) {
    const p = l.points, n = p.length;
    return [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n, p.reduce((s, q) => s + q[2], 0) / n];
}
/** Which side a lamp counts for in left/right effects ('both' and 'centre' are neither). */
function sideOf(l) { return l.side === 'left' || l.side === 'right' ? l.side : null; }

module.exports = { catalog, parse, flmId, spatialOrder, centroid, sideOf, FUNCTIONS, OUTPUT_PLACE, COLORS, GROUP_ORDER };
// fn keys must exist in the BDC function table.
FUNCTIONS.forEach((f) => { if (!P.FUNCTIONS[f.key]) throw new Error('Unknown BDC light function ' + f.key); });
