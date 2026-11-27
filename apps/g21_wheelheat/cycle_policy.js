'use strict';

// Vehicle-cycle detection for AutoHeat.
//
// A new heating session needs positive evidence that the vehicle was parked.
// Unknown or missing vehicle states are never treated as ignition OFF, and a
// new MGU process alone is never proof of a new journey.
//
// Evidence, strongest first:
//   A  observed OFF -> drive-ready edge inside this process;
//   B  a persisted, observed vehicle OFF that is newer than every recorded ON,
//      on a fresh start (fresh MGU boot, or AUTOSTART process);
//   C  MGU boot gap: the last drive-ready heartbeat lies before the MGU boot,
//      the MGU was down for a while, and the MGU booted only recently;
//   D  AUTOSTART gap (when MGU uptime is unavailable): the previous process'
//      last drive-ready heartbeat lies well before this process started.
// The start reason (AUTOSTART / ENTRY_POINT) is diagnostic only for A-C.
// The MGU starts autostart apps with ENTRY_POINT when it restores the last
// used app, so ENTRY_POINT is not proof of a late manual launch.

const OFF_OPTIONS = [0, 10, 15, 20, 30, 45, 60, 90];
const HEARTBEAT_MS = 60000;            // persisted drive-ready heartbeat
const FRESH_START_MS = 15 * 60000;     // max MGU uptime / process age at first ON
const MIN_DOWN_MS = 120000;            // MGU/process must really have been down
const RESUME_MS = 120000;              // same as the AutoHeat start window
const PLAUSIBLE_CLOCK = 1.7e12;        // 2023-11; below: clock not yet synced
const FUTURE_LIMIT_MS = 24 * 3600000;

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

const iso = at => at ? new Date(at).toISOString().replace('.000Z', 'Z') : '-';
const mins = ms => ms >= 0 ? (ms / 60000).toFixed(1) + ' min' : '-';

class VehicleCycle {
    /**
     * @param saved      persisted snapshot (may be corrupt / from older versions)
     * @param offMinutes required parked minutes
     * @param testBypass one-shot test: skip only the parked-time requirement
     * @param opts       { startReason, uptimeMs(): number|null, processStartedAt }
     *                   A boolean is accepted for older callers (true = AUTOSTART).
     */
    constructor(saved, offMinutes, testBypass, opts) {
        if (typeof opts === 'boolean') opts = { startReason: opts ? 'AUTOSTART' : 'UNKNOWN' };
        opts = opts || {};
        const p = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
        this.startReason = String(opts.startReason || 'UNKNOWN');
        this.autostart = this.startReason === 'AUTOSTART';
        this.uptimeMs = typeof opts.uptimeMs === 'function' ? opts.uptimeMs : () => null;
        this.processStartedAt = validAt(opts.processStartedAt);
        this.loadNotes = [];
        const field = key => {
            const v = validAt(p[key]);
            if (p[key] !== undefined && p[key] !== null && !v) this.loadNotes.push(key + ' invalid');
            return v;
        };
        this.offAt = field('offAt');
        this.onAt = field('onAt');
        this.usedOnAt = field('usedOnAt');
        this.cancelledOnAt = field('cancelledOnAt');
        this.lastActivationAt = field('lastActivationAt');
        this.eligibleOnAt = field('eligibleOnAt');
        this.aliveAt = field('aliveAt');
        this.mode = 'unknown';
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
        // Last drive-ready time known BEFORE this process saw the vehicle.
        // Heartbeats of the current drive must not erase that evidence.
        this.priorOnAt = this.lastKnownOn();
        this.pendingSince = 0;      // first unresolved drive-ready sample
        this.firstOnUptime = null;  // MGU uptime at that sample
        this.resolved = false;
        this.evidence = 'none';
        this.missing = '';
        this.offStart = 0;
        this.parkedMs = -1;
        this.checks = [];
        this.evaluations = 0;
        this.reason = 'WAITING FOR VERIFIED IGNITION STATE';
    }

    lastKnownOn() {
        return Math.max(this.onAt, this.usedOnAt, this.cancelledOnAt,
            this.lastActivationAt, this.eligibleOnAt, this.aliveAt);
    }

    uptime() {
        let u;
        try { u = Number(this.uptimeMs()); } catch (_) { u = NaN; }
        return Number.isFinite(u) && u > 0 ? Math.round(u) : null;
    }

    observe(raw, now) {
        const next = condition(raw);
        const t = validAt(now);
        if (!t) return { changed: false, transition: 'unknown', reason: this.reason };
        if (next === 'unknown' || next === 'ending') {
            // 12: readiness is ending. It is not yet a trustworthy OFF
            // timestamp, but issuing a new heat write is unsafe too.
            if (next === 'ending' && this.mode === 'on') {
                // This drive is now prior evidence: a following drive-ready
                // without a real OFF is the same journey (start-stop, flicker).
                this.priorOnAt = Math.max(this.priorOnAt, this.lastKnownOn(), t);
                this.mode = 'unknown';
                this.eligible = false;
                this.eligibleOnAt = 0;
                this.resolved = false;
                this.pendingSince = 0;
                this.reason = 'DRIVING READINESS ENDING: waiting for confirmed vehicle OFF';
                return { changed: true, transition: 'ending', reason: this.reason };
            }
            return { changed: false, transition: 'unknown', reason: this.reason };
        }
        if (next === this.mode) return { changed: false, transition: 'unchanged', reason: this.reason };

        const previous = this.mode;
        this.mode = next;
        if (next === 'off') {
            // Whatever this process saw as drive-ready is now prior evidence.
            this.priorOnAt = Math.max(this.priorOnAt, this.lastKnownOn());
            // On a process restart during one parking period keep the original
            // timestamp. Never treat a HU/app restart as a new ignition cycle.
            if (!this.offAt || this.priorOnAt >= this.offAt || this.offAt > t) this.offAt = t;
            this.eligible = false;
            this.eligibleOnAt = 0;
            this.resolved = false;
            this.pendingSince = 0;
            this.source = 'observed OFF';
            this.reason = 'VEHICLE OFF since ' + iso(this.offAt);
            return { changed: true, transition: 'off', reason: this.reason };
        }
        this.pendingSince = t;
        this.firstOnUptime = this.uptime();
        this.sawOffEdge = previous === 'off';
        this.resolved = false;
        this.decide(t);
        return { changed: true, transition: 'on', reason: this.reason };
    }

    /** Re-evaluate an unresolved ON state without waiting for a signal change.
     * Returns true when the decision changed (caller persists). */
    evaluate(now) {
        const t = validAt(now);
        if (!t || this.mode !== 'on' || this.resolved || !this.pendingSince) return false;
        const before = this.reason + '|' + this.eligible;
        this.decide(t);
        return before !== this.reason + '|' + this.eligible;
    }

    decide(t) {
        this.evaluations++;
        const required = this.offMinutes * 60000;
        const upNow = this.uptime();
        const boot = upNow !== null && upNow <= t ? t - upNow : 0;
        // Uptime may become readable only after the first ON sample.
        let firstUp = this.firstOnUptime;
        if (firstUp === null && upNow !== null && this.pendingSince && upNow - (t - this.pendingSince) > 0)
            firstUp = this.firstOnUptime = upNow - (t - this.pendingSince);
        const freshBoot = boot > 0 && firstUp !== null && firstUp <= FRESH_START_MS;
        const age = this.processStartedAt && this.pendingSince >= this.processStartedAt ?
            this.pendingSince - this.processStartedAt : null;
        const freshProcess = this.autostart && (age === null || age <= FRESH_START_MS);
        const clockOk = t > PLAUSIBLE_CLOCK;
        const sane = v => v > 0 && v <= t && !(clockOk && v > t + FUTURE_LIMIT_MS);
        const prior = sane(this.priorOnAt) ? this.priorOnAt : 0;
        const checks = [];
        const candidates = [];

        // A: observed OFF -> ON in this process.
        if (this.sawOffEdge && sane(this.offAt)) {
            let start = this.offAt;
            // The OFF seen right after an MGU wake started before the boot.
            if (boot && this.aliveAt && prior && prior < boot && boot - prior >= MIN_DOWN_MS)
                start = Math.min(start, prior);
            candidates.push({ id: 'A', label: 'observed OFF -> ON', start });
            checks.push('A observed OFF->ON: yes');
        } else checks.push('A observed OFF->ON: no (' + (this.sawOffEdge ? 'OFF time invalid' : 'no OFF seen by this process') + ')');

        // B: persisted observed OFF, newer than every known ON.
        if (!this.offAt) checks.push('B persisted OFF: none recorded');
        else if (!sane(this.offAt)) checks.push('B persisted OFF: timestamp invalid ' + iso(this.offAt));
        else if (this.offAt <= prior) checks.push('B persisted OFF: older than last ON ' + iso(prior));
        else if (!freshBoot && !freshProcess)
            checks.push('B persisted OFF: start not fresh (' + this.freshText(firstUp, age) + ')');
        else {
            candidates.push({ id: 'B', label: 'persisted vehicle OFF ' + iso(this.offAt), start: this.offAt });
            checks.push('B persisted OFF: yes ' + iso(this.offAt));
        }

        // C: MGU boot gap after the last drive-ready heartbeat.
        if (upNow === null) checks.push('C MGU boot gap: MGU uptime unavailable');
        else if (!this.aliveAt) checks.push('C MGU boot gap: no drive-ready heartbeat recorded yet');
        else if (!prior) checks.push('C MGU boot gap: last ON invalid');
        else if (prior >= boot) checks.push('C MGU boot gap: last ON ' + iso(prior) + ' after MGU boot ' + iso(boot));
        else if (boot - prior < MIN_DOWN_MS) checks.push('C MGU boot gap: MGU down only ' + mins(boot - prior));
        else if (!freshBoot) checks.push('C MGU boot gap: MGU uptime ' + mins(firstUp) + ' at first ON > ' + mins(FRESH_START_MS));
        else {
            candidates.push({ id: 'C', label: 'MGU boot gap ' + mins(boot - prior), start: prior });
            checks.push('C MGU boot gap: yes, MGU down ' + mins(boot - prior));
        }

        // D: AUTOSTART process gap (only meaningful without MGU uptime).
        if (!this.autostart) checks.push('D autostart gap: start reason ' + this.startReason);
        else if (!this.aliveAt || !prior) checks.push('D autostart gap: no drive-ready heartbeat recorded yet');
        else if (!this.processStartedAt) checks.push('D autostart gap: process start time unknown');
        else if (this.processStartedAt - prior < MIN_DOWN_MS)
            checks.push('D autostart gap: previous process alive until ' + iso(prior));
        else if (age === null || age > FRESH_START_MS) checks.push('D autostart gap: process age ' + mins(age));
        else {
            candidates.push({ id: 'D', label: 'AUTOSTART gap ' + mins(this.processStartedAt - prior), start: prior });
            checks.push('D autostart gap: yes');
        }
        this.checks = checks;

        if (candidates.length || (this.testBypass && !this.onAt)) {
            const best = candidates.reduce((a, b) => (!a || b.start < a.start ? b : a), null);
            this.offStart = best ? best.start : 0;
            this.parkedMs = best ? t - best.start : -1;
            const testStart = this.testBypass;
            this.evidence = best ? best.id + ': ' + best.label : 'one-shot test';
            this.source = (testStart ? 'one-shot test / ' : '') + this.evidence;
            this.missing = '';
            this.onAt = t;
            this.channels = {};
            this.testBypass = false;
            this.resolved = true;
            this.eligible = testStart || this.parkedMs >= required;
            this.eligibleOnAt = this.eligible ? t : 0;
            this.reason = this.eligible ? (testStart ? 'ONE-SHOT TEST: ' : 'NEW VEHICLE CYCLE: ') + this.source :
                'PARKING TIME NOT MET: ' + Math.floor(this.parkedMs / 60000) + 'm of ' + this.offMinutes + 'm (' + this.evidence + ')';
            if (!this.eligible) this.missing = 'parked ' + mins(this.parkedMs) + ' < required ' + mins(required);
            return;
        }

        this.offStart = 0;
        this.parkedMs = -1;
        // Same session after an app/MGU restart: resume only inside the
        // original start window; persisted channel states prevent repeats.
        const resume = this.onAt > 0 && this.eligibleOnAt === this.onAt && this.offAt < this.onAt &&
            this.onAt <= t && t - this.onAt < RESUME_MS &&
            this.cancelledOnAt !== this.onAt && this.usedOnAt !== this.onAt;
        if (resume) {
            this.eligible = true;
            this.resolved = true;
            this.evidence = 'same session resumed';
            this.source = 'persistent active session';
            this.missing = '';
            this.reason = 'EXISTING VEHICLE CYCLE: ' + this.source;
            return;
        }
        // Recent drive-ready heartbeat: certainly the same journey.
        if (prior && t - prior < Math.max(required, MIN_DOWN_MS) && (!boot || prior >= boot - MIN_DOWN_MS)) {
            this.eligible = false;
            this.resolved = true;
            this.evidence = 'same journey';
            this.source = 'same journey (last ON ' + Math.round((t - prior) / 1000) + 's ago)';
            this.missing = '';
            this.reason = 'SAME JOURNEY: last drive-ready ' + Math.round((t - prior) / 1000) + 's ago; no new cycle';
            return;
        }
        this.eligible = false;
        this.evidence = 'none';
        this.source = 'unresolved ON session';
        const missing = [];
        if (upNow === null) missing.push('MGU uptime unavailable');
        else if (firstUp !== null && firstUp > FRESH_START_MS) missing.push('MGU already running ' + mins(firstUp));
        if (!this.aliveAt) missing.push('no drive-ready heartbeat from an earlier drive');
        if (!this.offAt) missing.push('no vehicle OFF ever observed');
        if (!clockOk) missing.push('MGU clock not plausible yet');
        this.missing = missing.join('; ') || 'no cycle evidence';
        this.reason = 'VEHICLE ON: cycle unknown - ' + this.missing;
    }

    freshText(firstUp, age) {
        return 'MGU uptime ' + (firstUp === null ? 'unknown' : mins(firstUp)) +
            ', start ' + this.startReason + (age === null ? '' : ', process age ' + mins(age));
    }

    /** Persist a drive-ready heartbeat at most once per HEARTBEAT_MS. */
    heartbeat(now) {
        const t = validAt(now);
        if (!t || this.mode !== 'on' || (this.aliveAt && this.aliveAt <= t && t - this.aliveAt < HEARTBEAT_MS))
            return false;
        this.aliveAt = t;
        return true;
    }

    /** Arm the one-shot test while the app is already running. It applies
     * to the next fresh drive-ready decision only. */
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
        this.resolved = true;
        this.reason = 'MANUALLY CANCELLED for this ignition';
        return true;
    }

    /** Human-readable runtime facts for the diagnostics screen and log. */
    diagnostics(now) {
        const up = this.uptime();
        const state = this.mode !== 'on' ? 'UNKNOWN (vehicle ' + this.mode + ')' :
            this.cancelledOnAt && this.cancelledOnAt === this.onAt ? 'CANCELLED THIS DRIVE' :
            this.eligible ? 'NEW CYCLE CONFIRMED' :
            this.evidence === 'same journey' || this.evidence === 'same session resumed' ? 'SAME JOURNEY' :
            this.parkedMs >= 0 ? 'NEW CYCLE, PARKING TOO SHORT' : 'UNKNOWN';
        return {
            state,
            evidence: this.evidence,
            missing: this.missing || '-',
            checks: this.checks.slice(),
            mguUptime: up === null ? 'unavailable' : mins(up) + ' (boot ' + iso(now - up) + ')',
            firstOnUptime: this.firstOnUptime === null ? '-' : mins(this.firstOnUptime),
            lastOff: iso(this.offAt),
            lastOn: iso(this.priorOnAt),
            heartbeat: iso(this.aliveAt),
            offDuration: this.parkedMs >= 0 ? mins(this.parkedMs) : 'unknown',
            required: this.offMinutes + ' min',
            cycleId: iso(this.onAt),
            lastHeating: iso(this.lastActivationAt),
            nextEvaluation: this.mode === 'on' && !this.resolved ? 'every 1 s until resolved' :
                this.mode === 'on' ? 'resolved for this drive' : 'on next drive-ready signal',
            loadNotes: this.loadNotes.join(', ') || 'none',
        };
    }

    snapshot() {
        return { v: 2, offAt: this.offAt, onAt: this.onAt,
            usedOnAt: this.usedOnAt, cancelledOnAt: this.cancelledOnAt,
            eligibleOnAt: this.eligibleOnAt, aliveAt: this.aliveAt,
            channels: { ...this.channels } };
    }
}

module.exports = { OFF_OPTIONS, HEARTBEAT_MS, FRESH_START_MS, MIN_DOWN_MS,
    minutes, condition, driveReady, VehicleCycle };
