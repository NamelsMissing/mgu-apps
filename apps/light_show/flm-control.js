'use strict';
// FLM_KANAL RID A54B: STOP captured from original BMW PRG offline;
// START argument structure is derived, not independently vehicle verified.
const MODULES = Object.freeze({
    left: Object.freeze({ address: 0x43, index: '0F26C0', name: 'FLM02_L' }),
    right: Object.freeze({ address: 0x44, index: '0F26D0', name: 'FLM02_R' }),
});
// Headlamp module variants at 0x43 / 0x44 (SGBD index from 22 F1 50, names from
// idrive7-apps sgbd_index.json). Only FLM02 has been driven in a car (G21, basic LED).
// FLM02X / FLM2_1 use the same FLM_KANAL routine according to the supplied BMW data.
// The physical channel mapping on adaptive LED and laser headlights still needs vehicle testing.
const VARIANTS = Object.freeze({
    left: Object.freeze({
        '0F26C0': Object.freeze({ name: 'FLM02_L', support: 'verified', channels: 15 }),
        '0F26C8': Object.freeze({ name: 'FLM02X_L', support: 'prg', channels: 17 }),
        '0F26CC': Object.freeze({ name: 'FLM2_1_L', support: 'prg', channels: 17 }),
        '0F2200': Object.freeze({ name: 'FLM01_L', support: 'unsupported' }),
        '0F2E30': Object.freeze({ name: 'FLM03_L', support: 'unsupported' }),
        '0F1B20': Object.freeze({ name: 'LHM2_L', support: 'unsupported' }),
        '0F1E20': Object.freeze({ name: 'FLE_L', support: 'unsupported' }),
        '0F1E28': Object.freeze({ name: 'FLE02_L', support: 'unsupported' }),
    }),
    right: Object.freeze({
        '0F26D0': Object.freeze({ name: 'FLM02_R', support: 'verified', channels: 15 }),
        '0F26D8': Object.freeze({ name: 'FLM02X_R', support: 'prg', channels: 17 }),
        '0F26DC': Object.freeze({ name: 'FLM2_1_R', support: 'prg', channels: 17 }),
        '0F2210': Object.freeze({ name: 'FLM01_R', support: 'unsupported' }),
        '0F2E40': Object.freeze({ name: 'FLM03_R', support: 'unsupported' }),
        '0F1B30': Object.freeze({ name: 'LHM2_R', support: 'unsupported' }),
        '0F1E30': Object.freeze({ name: 'FLE_R', support: 'unsupported' }),
        '0F1E38': Object.freeze({ name: 'FLE02_R', support: 'unsupported' }),
    }),
});
/** {name, support: verified|experimental|unsupported} for a side's identity, or null when unknown. */
function variant(side, index) {
    moduleFor(side);
    return Object.prototype.hasOwnProperty.call(VARIANTS[side], index) ? VARIANTS[side][index] : null;
}
/** May FLM_KANAL be sent to this identity? Experimental variants only with the opt-in. */
function usable(side, index, allowExperimental) {
    const v = variant(side, index);
    return !!v && (v.support === 'verified' || v.support === 'prg' || (v.support === 'experimental' && !!allowExperimental));
}
const PWM_OPTIONS = Object.freeze([20, 40, 60, 80, 100]);
const SECOND_OPTIONS = Object.freeze([1, 2, 3, 5]);
const DEFAULT_PWM = 60, DEFAULT_SECONDS = 2;
function moduleFor(side) {
    if (!Object.prototype.hasOwnProperty.call(MODULES, side)) throw new Error('Unsupported FLM side');
    return MODULES[side];
}
const MAX_CHANNEL = 17;
// Channel 0 = "alle" (every LED of the headlamp at once), as used by BimmerLight's ALL_LEFT/RIGHT.
function channelNumber(n) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_CHANNEL) throw new Error('Only FLM LED channels 0 (all) and 1-' + MAX_CHANNEL + ' are allowed');
    return n;
}
function settings(pwm, seconds) {
    if (!Number.isInteger(pwm) || !PWM_OPTIONS.includes(pwm)) throw new Error('FLM PWM must be 20/40/60/80/100');
    if (!Number.isInteger(seconds) || !SECOND_OPTIONS.includes(seconds)) throw new Error('FLM duration must be 1/2/3/5 s');
    return { pwm, seconds };
}
function start(channel, pwm = DEFAULT_PWM, seconds = DEFAULT_SECONDS) {
    const s = settings(pwm, seconds);
    return [0x01, 0xA5, 0x4B, channelNumber(channel), s.pwm, s.seconds];
}
function stop() { return [0x02, 0xA5, 0x4B]; }
// Test option (as BimmerLight does it): the headlamp module stops listening to normal bus
// messages while a show runs, so the car's own light requests cannot interfere.
// OFF = CommunicationControl disableRxAndEnableTx, normal messages (28 02 01);
// ON  = enableRxAndTx, normal + network management (28 00 03). Leaving the extended session
// (or its timeout) also restores normal communication (ISO 14229).
const COMM_OFF = Object.freeze([0x02, 0x01]);
const COMM_ON = Object.freeze([0x00, 0x03]);
function isPermittedCommunication(data) {
    return Array.isArray(data) && data.length === 2 &&
        ((data[0] === COMM_OFF[0] && data[1] === COMM_OFF[1]) || (data[0] === COMM_ON[0] && data[1] === COMM_ON[1]));
}
function isPermittedRoutine(data) {
    if (!Array.isArray(data)) return false;
    if (data.length === 3) return data.every((x, i) => x === stop()[i]);
    if (data.length !== 6) return false;
    try { return data.every((x, i) => x === start(data[3], data[4], data[5])[i]); }
    catch (_) { return false; }
}
module.exports = { MODULES, VARIANTS, variant, usable, PWM_OPTIONS, SECOND_OPTIONS, DEFAULT_PWM, DEFAULT_SECONDS,
    moduleFor, channelNumber, settings, start, stop, isPermittedRoutine, COMM_OFF, COMM_ON, isPermittedCommunication };
