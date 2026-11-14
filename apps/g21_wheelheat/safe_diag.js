'use strict';

// WheelHeat BDC diagnostic gate. Automatic comfort commands may be sent
// while moving only with a recent speed signal and a positive BDC readback.
const { Diag, hex, NRC, replyTo } = require('./kit/diag');
class SafeDiag {
    constructor(ctx, target, probeDid) {
        this.ctx = ctx;
        this.target = target;
        this.probeDid = probeDid;
        this.diag = new Diag(ctx.signals, ctx.log);
        this.speed = null;
        this.speedAt = 0;
        this.readAt = 0;
        this.readText = 'not read yet';
        this.info = 'Live ECU commands disabled until explicitly enabled.';
        this.pending = null;
        this.busy = false;
        this.lastWriteAt = 0;
        this.lastWriteAttempted = false;
        this.lastNrc = null; // diagnostic reason from the latest attempted 0x2E write
        this.readbacks = Object.create(null); // actual 0x22 replies, NEVER app-command state
    }
    async init() {
        this.ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const raw = v && v.speedVehicleCentreOfGravity;
                if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw < 65535) {
                    this.speed = raw * 0.015625;
                    this.speedAt = Date.now();
                    if (this.speed > 0.5) this.pending = null;
                }
            },
        }, this.ctx.log, { pollMs: 2000 }).catch(e => this.ctx.log.warn('Vehicle speed: ' + e));
        await this.diag.init();
    }
    get online() { return !!(this.diag.p && this.diag.available); }
    get parked() { return this.speed !== null && this.speed <= 0.5 && Date.now() - this.speedAt < 5000; }
    get motionKnown() { return this.speed !== null && this.speed >= 0 && this.speed < 350 &&
        Date.now() - this.speedAt < 5000; }
    get verified() { return this.readAt > 0 && Date.now() - this.readAt < 60000; }
    get writeReady() {
        if (this.ctx.settings.get('autoEnabled') !== true) return 'Automatic heating disabled in Settings';
        if (!this.online) return 'TASU/ECU unavailable';
        if (!this.verified) return 'Read status first (max. 60s)';
        if (!this.parked) return 'Vehicle standstill not confirmed';
        if (Date.now() - this.lastWriteAt < 3000) return '3s cooldown active';
        return '';
    }
    get autoWriteReady() {
        if (this.ctx.settings.get('autoEnabled') !== true) return 'Automatic heating disabled in Settings';
        if (!this.online) return 'TASU/ECU unavailable';
        if (!this.motionKnown) return 'Vehicle speed unavailable or stale';
        if (!this.verified) return 'Read BDC status first';
        if (Date.now() - this.lastWriteAt < 3000) return '3s cooldown active';
        return '';
    }
    cancel() { this.pending = null; }
    async read(did) {
        this.cancel();
        if (this.busy) { this.info = 'Diagnostics busy'; return false; }
        if (!this.online) { this.info = 'TASU unavailable (expected in emulator)'; return false; }
        this.busy = true;
        const data = [did >> 8, did & 255];
        try {
            const u = await this.diag.physical(this.target, 0x22, data, 2300, replyTo(0x22, data), { maxRetries: 0 });
            if (u && u[0] === 0x62 && u[1] === data[0] && u[2] === data[1]) {
                if (did === this.probeDid) this.readAt = Date.now();
                this.readText = bytes(u);
                this.readbacks[did] = { ok: true, at: Date.now(), payload: Array.from(u).slice(3),
                    raw: bytes(u), error: '' };
                this.info = 'Read OK: 0x' + hex(did, 4) + ' (raw reply)';
                return true;
            } else {
                if (did === this.probeDid) this.readAt = 0;
                this.readText = u ? bytes(u) : 'Timeout';
                this.info = errorFor(u);
                this.readbacks[did] = { ok: false, at: Date.now(), raw: this.readText,
                    payload: null, error: this.info };
            }
        } catch (e) {
            if (did === this.probeDid) this.readAt = 0;
            this.info = 'Read error: ' + String(e.message || e);
            this.readbacks[did] = { ok: false, at: Date.now(), raw: '', payload: null, error: this.info };
        }
        finally { this.busy = false; }
        return false;
    }
    async write(data, label) {
        if (this.busy) { this.info = 'Diagnostics busy'; return; }
        const reason = this.writeReady;
        if (reason) { this.cancel(); this.info = reason; return; }
        const signature = bytes(data);
        if (!this.pending || this.pending.signature !== signature || Date.now() > this.pending.until) {
            this.pending = { signature, until: Date.now() + 8000 };
            this.info = 'Press SEND AGAIN to confirm: ' + label + ' (8s)';
            return;
        }
        this.cancel();
        this.busy = true;
        try {
            const u = await this.diag.physical(this.target, 0x2E, data, 2300, replyTo(0x2E, data), { maxRetries: 0 });
            if (u && u[0] === 0x6E && u[1] === data[0] && u[2] === data[1]) {
                this.info = 'ECU acknowledged 0x2E; vehicle effect UNVERIFIED';
                this.lastWriteAt = Date.now();
                this.readAt = 0;
            } else this.info = errorFor(u);
        } catch (e) { this.info = 'Write error: ' + String(e.message || e); }
        finally { this.busy = false; }
    }
    /** Automation-specific write: the Settings opt-in authorizes commands,
     * but each command STILL requires a fresh 22 read and fresh speed data.
     * Movement no longer blocks comfort heating; an ECU refusal still does.
     * No simulator or unknown-speed command is ever sent to the vehicle.
     * Returns true only on a positive 0x6E reply (not proof of physical heat).
     */
    async autoWrite(data, label) {
        // Never carry an older ECU NRC into a new attempt that is rejected
        // locally by the readiness gate (e.g. a stale speed signal).
        this.lastNrc = null;
        this.lastWriteAttempted = false;
        if (this.busy) { this.info = 'BDC busy'; return false; }
        const reason = this.autoWriteReady;
        if (reason) { this.info = reason; return false; }
        this.busy = true;
        this.info = 'Sending ' + label + ' to BDC ...';
        try {
            this.lastWriteAttempted = true;
            const u = await this.diag.physical(this.target, 0x2E, data, 2300,
                replyTo(0x2E, data), { maxRetries: 0 });
            if (u && u[0] === 0x6E && u[1] === data[0] && u[2] === data[1]) {
                this.info = label + ': BDC acknowledged (physical result unverified)';
                this.lastWriteAt = Date.now();
                this.readAt = 0;
                return true;
            }
            if (u && u[0] === 0x7F && u[1] === 0x2E) this.lastNrc = u[2];
            this.info = label + ': ' + errorFor(u);
        } catch (e) { this.info = label + ': ' + String(e.message || e); }
        finally { this.busy = false; }
        return false;
    }
}
function bytes(b) { return Array.from(b || []).map(n => hex(n)).join(' '); }
function errorFor(u) {
    if (!u) return 'No ECU response (timeout)';
    if (u[0] === 0x7F) return 'ECU rejected: NRC 0x' + hex(u[2]) + ' (' + (NRC[u[2]] || 'unknown') + ')';
    return 'Unexpected ECU reply: ' + bytes(u);
}
module.exports = { SafeDiag, bytes };
