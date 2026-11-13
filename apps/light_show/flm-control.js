'use strict';
// FLM_KANAL RID A54B: STOP captured from original BMW PRG offline;
// START argument structure is derived, not independently vehicle verified.
const MODULES = Object.freeze({
    left: Object.freeze({ address: 0x43, index: '0F26C0', name: 'FLM02_L' }),
    right: Object.freeze({ address: 0x44, index: '0F26D0', name: 'FLM02_R' }),
});
const PWM_OPTIONS = Object.freeze([20, 40, 60, 80, 100]);
const SECOND_OPTIONS = Object.freeze([1, 2, 3, 5]);
const DEFAULT_PWM = 60, DEFAULT_SECONDS = 2;
function moduleFor(side) {
    if (!Object.prototype.hasOwnProperty.call(MODULES, side)) throw new Error('Unsupported FLM side');
    return MODULES[side];
}
function channelNumber(n) {
    if (!Number.isInteger(n) || n < 1 || n > 15) throw new Error('Only FLM LED channels 1-15 are allowed');
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
function isPermittedRoutine(data) {
    if (!Array.isArray(data)) return false;
    if (data.length === 3) return data.every((x, i) => x === stop()[i]);
    if (data.length !== 6) return false;
    try { return data.every((x, i) => x === start(data[3], data[4], data[5])[i]); }
    catch (_) { return false; }
}
module.exports = { MODULES, PWM_OPTIONS, SECOND_OPTIONS, DEFAULT_PWM, DEFAULT_SECONDS,
    moduleFor, channelNumber, settings, start, stop, isPermittedRoutine };
