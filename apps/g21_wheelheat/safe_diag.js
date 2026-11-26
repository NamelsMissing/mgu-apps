'use strict';

// WheelHeat BDC diagnostic gate. Automatic comfort commands may be sent
// while moving only with a recent speed signal and a positive BDC readback.
const { Diag, hex, NRC, replyTo } = require('./kit/diag');
const E = require('./ecu_profile');
class SafeDiag {
    constructor(ctx, target, probeDid) {
        this.ctx = ctx;
        this.target = target;
        this.probeDid = probeDid;
        this.diag = new Diag(ctx.signals, ctx.log);
        this.speed = null;
        this.speedAt = 0;
        this.verifiedAt = Object.create(null);
        this.lastReadNrc = null;
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
        await this.retryConnection();
    }
    async retryConnection() {
        if (this.diag.p || this.connecting) return;
        this.connecting = true;
        try { await this.diag.init(); }
        catch (e) { this.info = 'TASU unavailable: ' + e; }
        finally { this.connecting = false; }
    }
    get online() { return !!(this.diag.p && this.diag.available); }
    get parked() { return this.speed !== null && this.speed <= 0.5 && Date.now() - this.speedAt < 5000; }
    get motionKnown() { return this.speed !== null && this.speed >= 0 && this.speed < 350 &&
        Date.now() - this.speedAt < 5000; }
    verifiedFor(did) {
        const at = this.verifiedAt[did];
        return Number.isFinite(at) && at > 0 && Date.now() >= at && Date.now() - at < 60000;
    }
    // Summary only; not a write authorization.
    get verified() { return Object.keys(this.verifiedAt).some(did => this.verifiedFor(did)); }
    invalidate(did) { delete this.verifiedAt[did]; }
    get readRetryable() {
        return [0x21, 0x22, 0x25].includes(this.lastReadNrc) ||
            /timeout|temporarily_not_accepted|busy|unavailable|no ecu response|cooldown/i.test(this.info);
    }
    writeReady(did) {
        if (this.ctx.settings.get('autoEnabled') !== true) return 'Automatic heating disabled in Settings';
        if (!this.online) return 'TASU/ECU unavailable';
        if (!this.verifiedFor(did)) return 'Read target DID first (max. 60s)';
        if (!this.parked) return 'Vehicle standstill not confirmed';
        if (Date.now() - this.lastWriteAt < 3000) return '3s cooldown active';
        return '';
    }
    autoWriteReady(did) {
        if (this.ctx.settings.get('autoEnabled') !== true) return 'Automatic heating disabled in Settings';
        if (!this.online) return 'TASU/ECU unavailable';
        if (!this.motionKnown) return 'Vehicle speed unavailable or stale';
        if (!this.verifiedFor(did)) return 'Read target BDC DID first';
        if (Date.now() - this.lastWriteAt < 3000) return '3s cooldown active';
        return '';
    }
    cancel() { this.pending = null; }
    async read(did, options) {
        this.cancel();
        this.lastReadNrc = null;
        if (this.busy) { this.info = 'Diagnostics busy'; return false; }
        if (!this.online) { this.invalidate(did); this.info = 'TASU unavailable (expected in emulator)'; return false; }
        this.invalidate(did);
        this.busy = true;
        const data = [did >> 8, did & 255];
        try {
            const u = await this.diag.physical(this.target, 0x22, data, 2300, replyTo(0x22, data),
                Object.assign({}, options, { maxRetries: 0 }));
            if (u && u.length > 3 && u[0] === 0x62 && u[1] === data[0] && u[2] === data[1]) {
                this.verifiedAt[did] = Date.now();
                this.readText = bytes(u);
                this.readbacks[did] = { ok: true, at: Date.now(), payload: Array.from(u).slice(3),
                    raw: bytes(u), error: '' };
                this.info = 'Read OK: 0x' + hex(did, 4) + ' (raw reply)';
                return true;
            } else {
                if (u && u[0] === 0x7F && u[1] === 0x22) this.lastReadNrc = u[2];
                this.readText = u ? bytes(u) : 'Timeout';
                this.info = errorFor(u);
                this.readbacks[did] = { ok: false, at: Date.now(), raw: this.readText,
                    payload: null, error: this.info, nrc: this.lastReadNrc };
            }
        } catch (e) {
            this.info = 'Read error: ' + String(e.message || e);
            this.readbacks[did] = { ok: false, at: Date.now(), raw: '', payload: null, error: this.info };
        }
        finally { this.busy = false; }
        return false;
    }
    /** Read-only identification probe of ANY address (control-unit
     * detection). Never marks a DID as verified, so it cannot authorize a
     * write. Resolves to the raw UDS reply, or null on timeout. */
    async probe(addr, did) {
        // Busy/offline is NOT a timeout: throw so detection never counts it
        // as evidence that a control unit is missing.
        if (!this.online) throw new Error('TASU offline');
        if (this.busy) throw new Error('diagnostic channel busy');
        this.busy = true;
        const data = [did >> 8, did & 255];
        try {
            // null = no reply within 1.5 s; transport errors are thrown.
            return await this.diag.physical(addr, 0x22, data, 1500, replyTo(0x22, data), { maxRetries: 0 });
        } finally { this.busy = false; }
    }
    async write(data, label) {
        if (this.busy) { this.info = 'Diagnostics busy'; return; }
        const did = (data[0] << 8) | data[1];
        const reason = this.writeReady(did);
        if (reason) { this.cancel(); this.info = reason; return; }
        const signature = bytes(data);
        if (!this.pending || this.pending.signature !== signature || Date.now() > this.pending.until) {
            this.pending = { signature, until: Date.now() + 8000 };
            this.info = 'Press SEND AGAIN to confirm: ' + label + ' (8s)';
            return;
        }
        this.cancel();
        this.busy = true;
        this.invalidate(did);
        try {
            const u = await this.diag.physical(this.target, 0x2E, data, 2300, replyTo(0x2E, data), { maxRetries: 0 });
            if (u && u[0] === 0x6E && u[1] === data[0] && u[2] === data[1]) {
                this.info = 'ECU acknowledged 0x2E; vehicle effect UNVERIFIED';
                this.lastWriteAt = Date.now();
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
    async autoWrite(data, label, beforeWrite = () => true) {
        // Never carry an older ECU NRC into a new attempt that is rejected
        // locally by the readiness gate (e.g. a stale speed signal).
        this.lastNrc = null;
        this.lastWriteAttempted = false;
        if (this.busy) { this.info = 'BDC busy'; return false; }
        const did = (data[0] << 8) | data[1];
        const reason = this.autoWriteReady(did);
        if (reason) { this.info = reason; return false; }
        this.busy = true;
        this.info = 'Sending ' + label + ' to BDC ...';
        try {
            if (!beforeWrite()) { this.info = "Could not persist command reservation"; return false; }
            this.lastWriteAttempted = true;
            this.invalidate(did);
            const u = await this.diag.physical(this.target, 0x2E, data, 2300,
                replyTo(0x2E, data), { maxRetries: 0 });
            if (u && u[0] === 0x6E && u[1] === data[0] && u[2] === data[1]) {
                this.info = label + ': BDC acknowledged (physical result unverified)';
                this.lastWriteAt = Date.now();
                return true;
            }
            if (u && u[0] === 0x7F && u[1] === 0x2E) this.lastNrc = u[2];
            this.info = label + ': ' + errorFor(u);
        } catch (e) { this.info = label + ': ' + String(e.message || e); }
        finally { this.busy = false; }
        return false;
    }

    /** Use the documented seat-module heating levels and OFF. Keep the live
     * identity, readback and write in one diagnostic operation. */
    async autoWriteSeatModule(side, action, expectedLevel, allowed, beforeWrite = () => true) {
        const module = E.SEAT_MODULES[side];
        const valid = action === 0 ? E.isModuleHeatLevel(expectedLevel) :
            E.isModuleHeatLevel(action) && (expectedLevel === 0 || expectedLevel === action);
        if (!module || !valid) throw new RangeError('Unsupported seat module, action or readback level');
        const starting = action !== 0 && expectedLevel === 0;
        const ready = () => this.online && this.motionKnown && allowed() &&
            (action === 0 || this.ctx.settings.get(module.enableSetting) === true &&
                this.ctx.settings.get('autoEnabled') === true) &&
            Date.now() - this.lastWriteAt >= 3000;
        if (this.busy || !ready()) return { state: 'blocked', detail: 'Diagnostic guards not ready' };

        this.busy = true;
        const options = { maxRetries: 0, callTimeoutMs: 2300, hardTimeoutMs: 3000 };
        const request = (sid, data) =>
            this.diag.physical(module.addr, sid, data, 1500, replyTo(sid, data), options);
        const did = [E.MODULE_DID.seat >> 8, E.MODULE_DID.seat & 255];
        let sentAt = null;
        try {
            const id = E.classify(E.ID_DID, await request(0x22, [E.ID_DID >> 8, E.ID_DID & 255]));
            if (id.state !== 'ok' || bytes(id.payload.slice(0, 3)).replace(/ /g, '') !== module.index)
                return { state: id.state === 'ok' ? 'unsupported' : 'unreadable',
                    detail: 'Live ' + module.sgbd + ' identification unavailable', nrc: id.nrc };
            if (starting) {
                const codedDid = E.MODULE_DID.coded;
                const coded = E.classify(codedDid, await request(0x22, [codedDid >> 8, codedDid & 255]));
                if (coded.state !== 'ok' || E.codedSeatHeating(coded.payload) !== '2-circuit')
                    return { state: coded.state === 'ok' ? 'unsupported' : 'unreadable',
                        detail: 'D701 does not confirm 2-circuit seat heating', nrc: coded.nrc };
            }
            if (!ready()) return { state: 'blocked', detail: 'Conditions changed during identification' };
            const reply = await request(0x22, did);
            const read = E.classify(E.MODULE_DID.seat, reply);
            const decoded = read.state === 'ok' ? E.decodeModuleSeat(read.payload) : null;
            if (!decoded || !decoded.complete || read.length !== E.D714_LENGTH)
                return { state: 'unreadable', detail: 'D714 ' + (read.state === 'ok' ?
                    'invalid seat readback ' + bytes(reply) : errorFor(reply)), nrc: read.nrc };
            if (decoded.level !== expectedLevel)
                return { state: 'different', level: decoded.level, detail: 'D714 reports level ' + decoded.level };
            if (!ready()) return { state: 'blocked', detail: 'Conditions changed during seat readback' };

            // Action byte and six zeros. The level-2 and OFF frames were
            // confirmed on the vehicle in #2.
            if (!beforeWrite()) return { state: "blocked", detail: "Could not persist command reservation" };
            sentAt = this.lastWriteAt = Date.now();
            const ack = await request(0x2E, [...did, action, 0, 0, 0, 0, 0, 0]);
            if (ack && ack[0] === 0x6E && ack[1] === did[0] && ack[2] === did[1])
                return { state: 'acknowledged', detail: bytes(ack), sentAt };
            const rejected = ack && ack[0] === 0x7F && ack[1] === 0x2E && ack.length >= 3;
            return { state: rejected ? 'rejected' : 'unconfirmed', detail: errorFor(ack),
                nrc: rejected ? ack[2] : null, sentAt };
        } catch (e) {
            return { state: sentAt === null ? 'unreadable' : 'unconfirmed',
                detail: String(e.message || e), sentAt };
        } finally {
            this.busy = false;
        }
    }
}
function bytes(b) { return Array.from(b || []).map(n => hex(n)).join(' '); }
function errorFor(u) {
    if (!u) return 'No ECU response (timeout)';
    if (u[0] === 0x7F) return 'ECU rejected: NRC 0x' + hex(u[2]) + ' (' + (u[2] === 0x25 ? 'no response from subnet component' : NRC[u[2]] || 'unknown') + ')';
    return 'Unexpected ECU reply: ' + bytes(u);
}
module.exports = { SafeDiag, bytes };
