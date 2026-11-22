'use strict';
const DiagnosticOutputs = require('./diagnostic-outputs');

// Derived from the supplied BDC_G05.prg, revision 36.001. The START and
// RCTECU telegrams and the timed SG_FUNKTIONEN requests were captured from
// original PRG bytecode against a recording-only interface. This verifies
// encoding, not physical lamp operation. See protocol-evidence.json.
const MAX_TIMED_MS = 2000;
const ADDRESS = 0x40;
const INDEX = '0F2680';
const DID = [0xE3, 0xB5];
const FUNCTION_DID = [0xD5, 0x42];
// D542 LEUCHTEN_FUNKTION elements (TAB_LEUCHTEN_FUNKTION_ARG in BDC_G05.prg, TAB_LAMPEN_FUNKTION in
// BDC_G11.prg / BDC.prg; same ids where they overlap). ELEMENT s16, ZEIT s16 in 10 ms, 0 = off.
// Only exterior functions; interior, ESS, OVT, remote and special flashing are left out.
const FUNCTIONS = {
    position: { id: 0x01, name: 'Side lights (front and rear)' },
    low: { id: 0x03, name: 'Low beam' },
    drl: { id: 0x04, name: 'Daytime lights' },
    high: { id: 0x05, name: 'High beam' },
    indLeft: { id: 0x06, name: 'Indicator left' },
    indRight: { id: 0x07, name: 'Indicator right' },
    fog: { id: 0x08, name: 'Front fog lights' },
    cornerLeft: { id: 0x09, name: 'Cornering light left' },
    cornerRight: { id: 0x0A, name: 'Cornering light right' },
    brake: { id: 0x0C, name: 'Brake lights' },
    rearFog: { id: 0x0E, name: 'Rear fog light' },
    reverse: { id: 0x0F, name: 'Reversing lights' },
    parkLeft: { id: 0x10, name: 'Parking light left' },
    parkRight: { id: 0x11, name: 'Parking light right' },
    hazard: { id: 0x12, name: 'Hazard lights' },
    locator: { id: 0x15, name: 'Locator / functional lighting' },
    grille: { id: 0x16, name: 'Illuminated kidney grille' },
    maneuver: { id: 0x18, name: 'Manoeuvring light' },
    welcome: { id: 0x1D, name: 'Welcome light' },
    goodbye: { id: 0x1E, name: 'Goodbye light' },
};
// Body controllers at 0x40 and the D542 elements each PRG lists (0x16 means something else in
// BDC_G05: FOLLOW_ME_HOME, so 'grille' only for BDC_G11). E3B5 outputs only in BDC_G05.
const COMMON_FN = ['position', 'low', 'drl', 'high', 'indLeft', 'indRight', 'fog', 'cornerLeft', 'cornerRight',
    'brake', 'rearFog', 'reverse', 'parkLeft', 'parkRight', 'hazard'];
const BODY_VARIANTS = Object.freeze({
    '0F2680': Object.freeze({ name: 'BDC_G05', support: 'verified', outputs: true, functions: COMMON_FN.concat(['locator', 'maneuver', 'welcome', 'goodbye']) }),
    '0F2050': Object.freeze({ name: 'BDC_G11', support: 'prg', outputs: false, functions: COMMON_FN.concat(['locator', 'grille']) }),
    '0F19C0': Object.freeze({ name: 'BDC', support: 'prg', outputs: false, functions: COMMON_FN.slice() }),
});
function bodyVariant(index) { return Object.prototype.hasOwnProperty.call(BODY_VARIANTS, index) ? BODY_VARIANTS[index] : null; }

const PAIRS = {
    high: { name: 'High beam', left: 0x07, right: 0x08 },
    drl: { name: 'Daytime running lights', left: 0x03, right: 0x04 },
    position: { name: 'Position lights', left: 0x09, right: 0x0A },
    fog: { name: 'Front fog lights', left: 0x0B, right: 0x0C },
};
const OUTPUTS = Object.keys(PAIRS).reduce((a, k) => a.concat([PAIRS[k].left, PAIRS[k].right]), []);
const PATTERNS = {
    alternate: { name: 'Alternate', steps: [[1, 0], [0, 1]] },
    double: { name: 'Double flash', steps: [[1, 0], [0, 0], [1, 0], [0, 0], [0, 1], [0, 0], [0, 1], [0, 0]] },
    triple: { name: 'Triple flash', steps: [[1, 0], [0, 0], [1, 0], [0, 0], [1, 0], [0, 0], [0, 1], [0, 0], [0, 1], [0, 0], [0, 1], [0, 0]] },
    together: { name: 'Both together', steps: [[1, 1], [0, 0]] },
    cross: { name: 'Cross pulse', steps: [[1, 0], [0, 0], [0, 1], [0, 0], [1, 1], [0, 0], [1, 1], [0, 0]] },
    wave: { name: 'Left - both - right', steps: [[1, 0], [1, 1], [0, 1], [0, 0]] },
};
const BOTH_PATTERNS = {
    together: { name: 'Both together', steps: [[1, 1], [0, 0]] },
    double: { name: 'Double flash (both)', steps: [[1, 1], [0, 0], [1, 1], [0, 0], [0, 0], [0, 0]] },
    triple: { name: 'Triple flash (both)', steps: [[1, 1], [0, 0], [1, 1], [0, 0], [1, 1], [0, 0], [0, 0], [0, 0]] },
};
function pattern(c) {
    if (c.test) return { name: '2-second function test (both)', steps: [[1, 1]] };
    return c.route === 'timed' ? BOTH_PATTERNS[c.pattern] : PATTERNS[c.pattern];
}

function settings(get) {
    // Legacy callers without a route keep the old encoder. The app schema
    // explicitly defaults to timed; upgrading saved settings inherits that.
    const route = get('route') || 'digital';
    const chosen = route === 'timed' ? get('timedPattern') : get('pattern'), lights = get('lights');
    const tempo = Number(get('tempo')), seconds = Number(get('duration'));
    if (['timed', 'digital'].indexOf(route) < 0
        || !Object.prototype.hasOwnProperty.call(route === 'timed' ? BOTH_PATTERNS : PATTERNS, chosen)
        || !Object.prototype.hasOwnProperty.call(PAIRS, lights) || [100, 150, 200, 300, 500].indexOf(tempo) < 0
        || [5, 15, 30, 60].indexOf(seconds) < 0) throw new Error('Invalid show settings - choose the values again');
    return { route, pattern: chosen, lights, tempo, seconds };
}
function timedControl(lights, durationMs) {
    if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, lights) || !Number.isInteger(durationMs)
        || durationMs < 0 || durationMs > MAX_TIMED_MS || durationMs % 10) throw new Error('Invalid timed light function');
    const ticks = durationMs / 10;
    // ARG_0xD542_D: ELEMENT s16 high byte first, ZEIT s16 = seconds * 100.
    // No persistent duration, IO control parameter or enable mask is used.
    return FUNCTION_DID.concat([0, FUNCTIONS[lights].id, ticks >> 8, ticks & 255]);
}
function statusSummary(reply, lights) {
    if (!Array.isArray(reply) || reply[0] !== 0x62 || !Object.prototype.hasOwnProperty.call(PAIRS, lights)) return 'status unavailable';
    const value = (i) => reply.length > 3 + i ? (reply[3 + i] === 0 ? '0' : reply[3 + i] === 1 ? '1' : 'unknown') : 'missing';
    if (reply[1] === 0xE3 && reply[2] === 0xB9) {
        const p = PAIRS[lights];
        return 'BDC output L=' + value(p.left) + ' R=' + value(p.right) + ' (not an LED measurement)';
    }
    if (reply[1] === 0xD5 && reply[2] === 0x42) return 'BDC light function=' + value(FUNCTIONS[lights].id) + ' (not an LED measurement)';
    return 'unexpected status identifier';
}
function control(output, on) {
    if ((OUTPUTS.indexOf(output) < 0 && !DiagnosticOutputs.OUTPUTS[output])
        || !Number.isInteger(output) || (on !== 0 && on !== 1)) throw new Error('Unsupported light command');
    // C0 is the control-enable mask generated by STEUERN_IO for its two
    // arguments. It is part of the UDS payload, not a frame checksum.
    return DID.concat([0x03, output, on, 0xC0]);
}
function singleOutputSummary(reply, id) {
    DiagnosticOutputs.get(id);
    if (!Array.isArray(reply) || reply[0] !== 0x62 || reply[1] !== 0xE3 || reply[2] !== 0xB9)
        return 'BDC output readback unavailable';
    if (reply.length <= 3 + id) return 'BDC output ' + id + ' is outside the returned status; no lamp measurement';
    const byte = reply[3 + id];
    return 'BDC output ' + id + '=' + (byte === 0 || byte === 1 ? byte : 'unknown') + ' (not a lamp measurement)';
}
function release() { return DID.concat([0x00, 0xFF]); }
function indexOf(data) {
    if (!Array.isArray(data) || data.length !== 3) return null;
    return data.map((v) => ('0' + v.toString(16)).slice(-2)).join('').toUpperCase();
}
function hex(data) { return data.map((v) => ('0' + v.toString(16)).slice(-2)).join(' ').toUpperCase(); }

module.exports = { MAX_TIMED_MS, ADDRESS, INDEX, DID, FUNCTION_DID, FUNCTIONS, BODY_VARIANTS, bodyVariant, PAIRS, PATTERNS, BOTH_PATTERNS,
    pattern, settings, timedControl, statusSummary, singleOutputSummary, control, release, indexOf, hex };
