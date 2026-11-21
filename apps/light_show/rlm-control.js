'use strict';
// Rear light modules (separate tail-light control units on newer G-series, e.g. OLED / LCI
// tail lights). Telegrams from the supplied BMW PRGs; not yet tested in a car.
//
// RLM2_1L/1R/2L/2R (RLM2_*.prg): RLM_LICHTFUNKTIONEN, 2E A8 3B <function> <seconds>,
//   seconds 0 = off, 1..254 = on for that time, 255 = permanent (never used here).
// RLM_1L/1R/2L/2R (RLM_*.prg): RLM_KANAL, 2E D6 DA <channel 1-8> <seconds> <PWM %>,
//   seconds 0 = off. Channel 0 (all) is not used.
// RLM2_*: RLM_KANAL routine 31 01 A5 56 <group> <PWM> <current mA, 2 bytes> <seconds>, stop 31 02 A5 56.
//   Only the 16 segment groups (0x60-0x6F) and "all channels" (0x70), with 100 mA - the values
//   BimmerLight's mapping uses for these modules. One routine per module at a time.

const MODULES = Object.freeze({
    0x17: Object.freeze({ slot: '1L', side: 'left', position: 'outer' }),
    0x1A: Object.freeze({ slot: '1R', side: 'right', position: 'outer' }),
    0x1C: Object.freeze({ slot: '2L', side: 'left', position: 'inner' }),
    0x1E: Object.freeze({ slot: '2R', side: 'right', position: 'inner' }),
});
const VARIANTS = Object.freeze({
    0x17: { '0F2C10': 'RLM2_1L', '0F23C0': 'RLM_1L' },
    0x1A: { '0F2C20': 'RLM2_1R', '0F23D0': 'RLM_1R' },
    0x1C: { '0F2C30': 'RLM2_2L', '0F23E0': 'RLM_2L' },
    0x1E: { '0F2C40': 'RLM2_2R', '0F23F0': 'RLM_2R' },
});
// TAB_RLM_LICHTFUNKTIONEN (0x07 "remote lamp" left out)
const FUNCTIONS = Object.freeze({
    0x00: { key: 'pos', name: 'tail / position light', color: 'red' },
    0x01: { key: 'fog', name: 'rear fog light', color: 'red' },
    0x02: { key: 'brake', name: 'brake light', color: 'red' },
    0x03: { key: 'ind', name: 'indicator', color: 'amber' },
    0x04: { key: 'rev', name: 'reversing light', color: 'white' },
    0x05: { key: 'marker', name: 'side marker', color: 'amber' },
    0x06: { key: 'side', name: 'side light', color: 'red' },
    0x08: { key: 'park', name: 'parking light', color: 'red' },
    0x09: { key: 'plate', name: 'licence plate light', color: 'white' },
});
const CHANNELS_RLM1 = 8;
const GROUPS_RLM2 = 16;
const GROUP_CURRENT_MA = 100;
/** group 1-16 -> 0x60-0x6F, 0 -> 0x70 (all channels) */
function groupCode(g) {
    if (!Number.isInteger(g) || g < 0 || g > GROUPS_RLM2) throw new Error('Rear light group must be 0 (all) or 1-16');
    return g === 0 ? 0x70 : 0x5F + g;
}
function groupStart(group, ms, pwm) {
    const p = PWM.indexOf(pwm) >= 0 ? pwm : 60;
    return [0x01, 0xA5, 0x56, groupCode(group), p, (GROUP_CURRENT_MA >> 8) & 0xFF, GROUP_CURRENT_MA & 0xFF, seconds(ms)];
}
function groupStop() { return [0x02, 0xA5, 0x56]; }
/** Is this 31 request one of ours? */
function permittedRoutine(data) {
    if (!Array.isArray(data)) return false;
    if (data.length === 3) return data[0] === 0x02 && data[1] === 0xA5 && data[2] === 0x56;
    if (data.length !== 8 || data[0] !== 0x01 || data[1] !== 0xA5 || data[2] !== 0x56) return false;
    return data[3] >= 0x60 && data[3] <= 0x70 && PWM.indexOf(data[4]) >= 0 && data[5] === 0x00 && data[6] === GROUP_CURRENT_MA
        && data[7] >= 1 && data[7] <= 5;
}
const PWM = Object.freeze([20, 40, 60, 80, 100]);

function moduleAt(address) {
    if (!Object.prototype.hasOwnProperty.call(MODULES, address)) throw new Error('No rear light module at 0x' + Number(address).toString(16));
    return MODULES[address];
}
/** {name, kinds: ['fn', 'grp'] (RLM2) | ['ch'] (RLM_1)} or null */
function variant(address, index) {
    moduleAt(address);
    const name = Object.prototype.hasOwnProperty.call(VARIANTS[address], index) && VARIANTS[address][index];
    if (!name) return null;
    return { name, kinds: name.indexOf('RLM2_') === 0 ? ['fn', 'grp'] : ['ch'] };
}
function seconds(ms) { return Math.min(5, Math.max(1, Math.ceil(ms / 1000))); }

/** Telegram (data after the service byte 2E) for kind/item on (ms > 0) or off (ms 0). */
function telegram(kind, item, ms, pwm) {
    const t = ms > 0 ? seconds(ms) : 0;
    if (kind === 'fn') {
        if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, item)) throw new Error('Unknown rear light function');
        return [0xA8, 0x3B, item, t];
    }
    if (kind === 'ch') {
        if (!Number.isInteger(item) || item < 1 || item > CHANNELS_RLM1) throw new Error('Rear light channel must be 1-8');
        const p = PWM.indexOf(pwm) >= 0 ? pwm : 60;
        return [0xD6, 0xDA, item, t, p];
    }
    throw new Error('Unknown rear light route');
}
/** Is this 2E request one of ours (for the link whitelist)? */
function permitted(data, kinds = ['fn', 'ch']) {
    if (!Array.isArray(data) || !Number.isInteger(data[3]) || data[3] < 0 || data[3] > 5) return false;
    if (kinds.indexOf('fn') >= 0 && data.length === 4 && data[0] === 0xA8 && data[1] === 0x3B)
        return Object.prototype.hasOwnProperty.call(FUNCTIONS, data[2]);
    if (kinds.indexOf('ch') >= 0 && data.length === 5 && data[0] === 0xD6 && data[1] === 0xDA)
        return Number.isInteger(data[2]) && data[2] >= 1 && data[2] <= CHANNELS_RLM1 && PWM.indexOf(data[4]) >= 0;
    return false;
}

module.exports = { MODULES, VARIANTS, FUNCTIONS, CHANNELS_RLM1, GROUPS_RLM2, GROUP_CURRENT_MA, module: moduleAt, variant, telegram, permitted,
    permittedRoutine, groupCode, groupStart, groupStop, seconds };
