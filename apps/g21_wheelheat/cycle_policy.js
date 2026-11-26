'use strict';

// Only vehicle OFF evidence can establish a new heating session.
// Unknown/missing vehicle states are deliberately not treated as ignition OFF.
const OFF_OPTIONS = [0, 10, 15, 20, 30, 45, 60, 90];

function minutes(value) {
    const n = Number(value);
    return OFF_OPTIONS.indexOf(n) >= 0 ? n : 30;
}

function condition(raw) {
    const named = {
        WOHNEN: 5, PRUEFEN_ANALYSE_DIAGNOSE: 7,
        FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10,
        FAHRBEREITSCHAFT_BEENDEN: 12,
    };
    const n = typeof raw === 'string' && named[raw.toUpperCase()] !== undefined ?
        named[raw.toUpperCase()] : Number(raw);
    if (!Number.isInteger(n)) return 'unknown';
    if (n >= 1 && n <= 5) return 'off';
    if (n === 7 || n === 8 || n === 10) return 'on';
    // 12 = ending driving readiness, but NOT proof ignition is already OFF.
    return n === 12 ? 'ending' : 'unknown';
}

function driveReady(raw) {
    return agrees(raw, 8, 'FAHRBEREITSCHAFT_HERSTELLEN') || agrees(raw, 10, 'FAHREN');
}

function agrees(raw, number, name) {
    return Number(raw) === number || String(raw).toUpperCase() === name;
}

function validAt(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

class VehicleCycle {
    constructor(saved, offMinutes, testBypass, autostart = false) {
        const p = saved || {};
        this.offAt = validAt(p.offAt);
        this.onAt = validAt(p.onAt);
        this.usedOnAt = validAt(p.usedOnAt);
        this.cancelledOnAt = validAt(p.cancelledOnAt);
        this.mode = 'unknown';
        this.autostart = autostart;
        this.lastActivationAt = validAt(p.lastActivationAt);
        this.eligibleOnAt = validAt(p.eligibleOnAt);
        this.source = 'unknown';
        this.channels = {};
        for (const name of ['Steering wheel', 'Driver seat', 'Passenger seat']) {
            const state = p.channels && p.channels[name];
            if (typeof state === 'string' && ['sent', 'confirmed', 'manual'].includes(state))
                this.channels[name] = state;
        }
        this.offMinutes = minutes(offMinutes);
        this.testBypass = !!testBypass;
        this.eligible = false;
        this.reason = 'WAITING FOR VERIFIED IGNITION STATE';
    }

    observe(raw, now) {
        const next = condition(raw);
        const t = validAt(now);
        if (!t) return { changed: false, transition: 'unknown', reason: this.reason };
        if (next === 'unknown' || next === 'ending') {
            // 12: readiness is ending. It is not yet a trustworthy OFF
            // timestamp, but issuing a new heat write is unsafe too.
            if (next === 'ending' && this.mode === 'on') {
                this.mode = 'unknown';
                this.eligible = false;
                this.eligibleOnAt = 0;
                this.reason = 'DRIVING READINESS ENDING: waiting for confirmed vehicle OFF';
                return { changed: true, transition: 'ending', reason: this.reason };
            }
            return { changed: false, transition: 'unknown', reason: this.reason };
        }
        if (next === this.mode) return { changed: false, transition: 'unchanged', reason: this.reason };

        const previous = this.mode;
        this.mode = next;
        if (next === 'off') {
            // On a process restart during one parking period keep the original
            // timestamp. Never treat a HU/app restart as a new ignition cycle.
            if (!this.offAt || this.onAt >= this.offAt || this.offAt > t) this.offAt = t;
            this.eligible = false;
            this.eligibleOnAt = 0;
            this.source = 'observed OFF';
            this.reason = 'VEHICLE OFF since ' + new Date(this.offAt).toISOString();
            return { changed: true, transition: 'off', reason: this.reason };
        }

        const lastSession = Math.max(this.onAt, this.usedOnAt, this.cancelledOnAt, this.lastActivationAt);
        const recordedOff = this.offAt > lastSession && this.offAt <= t;
        const parkedMs = recordedOff ? t - this.offAt : -1;
        const persistedStart = previous === 'unknown' && this.autostart && recordedOff &&
            parkedMs >= this.offMinutes * 60000;
        const testStart = this.testBypass && (previous === 'off' || !this.onAt);
        if (previous === 'off' || persistedStart || testStart) {
            this.source = previous === 'off' ? 'observed OFF → ON' :
                persistedStart ? 'persisted vehicle OFF + autostart ON' : 'one-shot test';
            this.onAt = t;
            this.channels = {};
            this.testBypass = false;
            this.eligible = parkedMs >= this.offMinutes * 60000 || testStart;
            this.eligibleOnAt = this.eligible ? t : 0;
            this.reason = this.eligible ? (testStart ? 'ONE-SHOT TEST: ' : 'NEW VEHICLE CYCLE: ') + this.source :
                'PARKING TIME NOT MET: ' + Math.floor(parkedMs / 60000) + 'm';
        } else {
            this.eligible = this.autostart && this.onAt > 0 && this.eligibleOnAt === this.onAt &&
                this.offAt < this.onAt && this.onAt <= t && t - this.onAt < 120000 &&
                this.cancelledOnAt !== this.onAt && this.usedOnAt !== this.onAt;
            this.source = this.eligible ? 'persistent active session' : 'unresolved ON session';
            this.reason = this.eligible ? 'EXISTING VEHICLE CYCLE: ' + this.source :
                'VEHICLE ON: waiting for reliable cycle evidence';
            // An ON sample must invalidate an unconsumed OFF timestamp even when blocked.
            if (recordedOff) { this.onAt = t; this.eligibleOnAt = 0; this.channels = {}; }
        }
        return { changed: true, transition: 'on', reason: this.reason };
    }

    /** Arm the one-shot test while the app is already running. It applies
     * to the next fresh OFF -> ON edge only. */
    armTest() {
        this.testBypass = true;
        return true;
    }

    canStart() {
        return this.mode === 'on' && this.eligible && this.usedOnAt !== this.onAt &&
            this.cancelledOnAt !== this.onAt;
    }

    mayContinue() {
        return this.mode === 'on' && this.cancelledOnAt !== this.onAt;
    }

    consume() {
        if (!this.canStart()) return false;
        this.usedOnAt = this.onAt;
        this.eligible = false;
        this.reason = 'AUTOMATIC CYCLE USED for this ignition; no repeat until next eligible start';
        return true;
    }

    cancel() {
        if (this.mode !== 'on' || !this.onAt) return false;
        this.cancelledOnAt = this.onAt;
        this.eligible = false;
        this.reason = 'MANUALLY CANCELLED for this ignition';
        return true;
    }

    snapshot() {
        return { offAt: this.offAt, onAt: this.onAt,
            usedOnAt: this.usedOnAt, cancelledOnAt: this.cancelledOnAt,
            eligibleOnAt: this.eligibleOnAt, channels: { ...this.channels } };
    }
}

module.exports = { OFF_OPTIONS, minutes, condition, driveReady, VehicleCycle };
