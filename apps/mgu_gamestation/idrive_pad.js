'use strict';

// iDrive 7 FrontCCU / mgu-inputgate decoder, compatible with the MGU Node 8.
// All control events are local and read-only; this module never sends ECU writes.
const DEFLECTION = {
    MITTELSTELLUNG: 0, NORD_KURZ_GEDRUECKT: 1, NORD_LANG_GEDRUECKT: 2,
    OST_KURZ_GEDRUECKT: 4, OST_LANG_GEDRUECKT: 5,
    SUED_KURZ_GEDRUECKT: 7, SUED_LANG_GEDRUECKT: 8,
    WEST_KURZ_GEDRUECKT: 10, WEST_LANG_GEDRUECKT: 11,
    SIGNAL_UNGUELTIG: 15,
};
const PUSH = {
    KEINE_BETAETIGUNG: 0, DREHGEBER_KURZ_GEDRUECKT: 1,
    DREHGEBER_LANG_GEDRUECKT: 2, UNWIRKSAM: 3, SIGNAL_UNGUELTIG: 15,
};
const DIR = {1: 'up', 2: 'up', 4: 'right', 5: 'right',
    7: 'down', 8: 'down', 10: 'left', 11: 'left'};
const KEYS = ['a', 'b', 'c', 'x', 'y', 'l', 'r', 'start', 'select'];
const number = (v, names) => typeof v === 'number' ? v : names[v] === undefined ? 15 : names[v];

class IDrivePad {
    constructor(options) {
        const o = options || {};
        this.now = o.now || Date.now;
        this.turnClockwise = o.turnClockwise || 'b';
        this.turnCounterclockwise = o.turnCounterclockwise || 'x';
        this.enabled = false; this.pong = false;
        this.lastSeen = 0; this.pos = null; this.dir = null;
        this.pressed = false; this.pressedAt = 0; this.lastPressAt = -1e9;
        this.pulses = {};
    }
    configure(o) {
        if (!o) return;
        if (KEYS.indexOf(o.turnClockwise) >= 0) this.turnClockwise = o.turnClockwise;
        if (KEYS.indexOf(o.turnCounterclockwise) >= 0) this.turnCounterclockwise = o.turnCounterclockwise;
    }
    setEnabled(on) {
        if (this.enabled === !!on) return;
        this.enabled = !!on;
        this.dir = null;
        if (!this.enabled) {
            this.pulses = {};
            this.pressed = false;
            this.pressedAt = 0;
            this.lastPressAt = -1e9;
        }
    }
    setPong(on) { this.pong = !!on; }
    live() { return this.lastSeen !== 0 && this.now() - this.lastSeen < 1600; }
    pulse(key, duration) {
        const end = this.now() + duration;
        this.pulses[key] = Math.max(this.pulses[key] || 0, end);
    }
    raw(v) {
        if (!v) return;
        const pb = number(v.frontRotaryEncoderPushButton, PUSH);
        const df = number(v.frontRotaryEncoderDeflection, DEFLECTION);
        if (pb === 15 && df === 15) return;
        const now = this.now();
        this.lastSeen = now;
        const pos = v.frontRotaryEncoderOperation;
        if (typeof pos === 'number' && isFinite(pos) && pos >= 0 && pos <= 65535) {
            if (this.pos !== null) {
                const steps = ((pos - this.pos + 32768) & 0xffff) - 32768;
                if (this.enabled && steps !== 0 && Math.abs(steps) <= 64) {
                    // Pong: the physical knob moves the paddle. Consoles:
                    // each detent generates a momentary mapped button press.
                    const key = this.pong ? steps > 0 ? 'down' : 'up' :
                        steps > 0 ? this.turnClockwise : this.turnCounterclockwise;
                    this.pulse(key, Math.min(550, 130 + Math.abs(steps) * (this.pong ? 70 : 20)));
                }
            }
            this.pos = pos;
        }
        this.dir = DIR[df] || null;
        const down = pb === 1 || pb === 2;
        if (this.enabled && down && !this.pressed) {
            if (now - this.lastPressAt < 350) this.pulse('start', 200);
            this.lastPressAt = now;
            this.pressedAt = now;
        }
        if (this.enabled) this.pressed = down;
    }
    buttons() {
        if (!this.enabled || !this.live()) return {};
        const now = this.now(), keys = {};
        if (this.dir) keys[this.dir] = true;
        // The push button supports a held A. Long press switches to SELECT;
        // a fast double press also emits a short START, without synthetic ECU input.
        if (this.pressed) {
            if (now - this.pressedAt >= 650) keys.select = true;
            else keys.a = true;
        }
        Object.keys(this.pulses).forEach(key => {
            if (this.pulses[key] > now) keys[key] = true;
            else delete this.pulses[key];
        });
        return keys;
    }
    status() {
        return {live: this.live(), enabled: this.enabled, direction: this.dir,
            clockwise: this.turnClockwise, counterclockwise: this.turnCounterclockwise};
    }
}

function padsForMode(mode, local, phones) {
    const p = phones || [{}, {}];
    if (mode === 'idrive') return [local || {}, {}];
    if (mode === 'phone') return [p[0] || {}, {}];
    if (mode === 'hybrid') return [local || {}, p[1] || {}];
    return [p[0] || {}, p[1] || {}];
}

module.exports = {IDrivePad, DEFLECTION, PUSH, padsForMode};
