'use strict';

// BDC_G05.prg: LENKRADHEIZUNG 0xD074, LENKRADHEIZUNG_LED 0xD071.
const ECU = 0x40;
const DID_HEAT = 0xD074;
const DID_LED = 0xD071;
const DID_SEAT_DRIVER = 0xE432;
const DID_SEAT_PASSENGER = 0xE430;
const TIMES = [0, 30, 60, 120, 180, 240, 255];
function uint(name, value, max) {
    if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new RangeError(name + ' must be an integer between 0 and ' + max);
    }
    return value;
}
function heating(seconds) { return [DID_HEAT >> 8, DID_HEAT & 255, uint('SECONDS', seconds, 255)]; }
function led(action) { return [DID_LED >> 8, DID_LED & 255, uint('ACTION', action, 1)]; }
function seat(side, level, seconds) {
    const did = side === 'driver' ? DID_SEAT_DRIVER : side === 'passenger' ? DID_SEAT_PASSENGER : null;
    if (!did) throw new RangeError('Unknown seat side');
    return [did >> 8, did & 255, uint('LEVEL', level, 3), uint('SECONDS', seconds, 255)];
}
function exteriorTemp(raw) {
    return Number.isInteger(raw) && raw >= 0 && raw < 255 ? raw * 0.5 - 40 : null;
}
/** Source selection for the OFFLINE preview. Simulated values never reach ECU writes. */
function temperatureInput(realValue, realAt, simulationEnabled, simulationC, now) {
    if (simulationEnabled) {
        const value = Number(simulationC);
        if (!Number.isFinite(value) || value < -40 || value > 60) {
            return { value: null, at: 0, source: 'INVALID TEST VALUE' };
        }
        return { value, at: now, source: 'SIMULATION' };
    }
    return { value: realValue, at: realAt, source: 'MGU' };
}
/** BDC_G05.prg RES_0xD074_D: ON, LED, current in 0.1 A,
 * actuator state, coded flag. Byte positions refer to the payload following
 * UDS 62 D0 74. Unknown/truncated values are never guessed as OFF. */
function decodeWheelReadback(payload) {
    if (!Array.isArray(payload) || payload.length < 2 ||
        (payload[0] !== 0 && payload[0] !== 1) ||
        (payload[1] !== 0 && payload[1] !== 1)) return null;
    return { on: payload[0] === 1, led: payload[1] === 1,
        currentAmps: payload.length > 2 ? payload[2] / 10 : null,
        actuator: payload.length > 3 ? payload[3] : null,
        coded: payload.length > 4 ? payload[4] === 1 : null };
}
/** BDC_G05.prg RES_0xE432_D / RES_0xE430_D:
 * status, level, seat cushion/back temperatures, reduction, emergency,
 * timeout, two reserved bytes. */
function decodeSeatReadback(payload) {
    if (!Array.isArray(payload) || payload.length < 2 ||
        (payload[0] !== 0 && payload[0] !== 1) ||
        ![0, 1, 2, 3].includes(payload[1])) return null;
    const signed = n => n > 127 ? n - 256 : n;
    const temp = n => n === 87 ? null : signed(n);
    return { on: payload[0] === 1, level: payload[1],
        cushionC: payload.length > 2 ? temp(payload[2]) : null,
        backC: payload.length > 3 ? temp(payload[3]) : null,
        consumptionReduced: payload.length > 4 ? payload[4] === 1 : null,
        emergency: payload.length > 5 ? payload[5] === 1 : null,
        timedOut: payload.length > 6 ? payload[6] === 1 : null };
}
/** Display only the latest decoded ECU state. Manual state transitions should
 * not be mistaken for readback instability. Raw replies remain in the log. */
function readbackLabel(decoded, seat) {
    if (!decoded) return null;
    if (seat) return decoded.on ? 'ON  |  Level ' + decoded.level : 'OFF (BDC report)';
    return decoded.on ? 'ON  |  LED ' + (decoded.led ? 'ON' : 'OFF') : 'OFF (BDC report)';
}
module.exports = { ECU, DID_HEAT, DID_LED, DID_SEAT_DRIVER, DID_SEAT_PASSENGER,
    TIMES, heating, led, seat, exteriorTemp, temperatureInput,
    decodeWheelReadback, decodeSeatReadback, readbackLabel };
