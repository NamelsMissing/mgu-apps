'use strict';

const {Diag, hex, NRC, replyTo} = require('./kit/diag');
const {ECU, DID, PROBE_DID, fromPreset} = require('./logic');
const {BUSES, decode, compare} = require('./lin');
const {SessionLog} = require('./session_log');

const BDC = 0x40;
const SPEED_FRESH_MS = 5000;
const IDENTITY_FRESH_MS = 60000;
const REPORT_FRESH_MS = 120000;
const QUIET_MS = 3000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bytes = data => data.map(n => hex(n)).join(' ');
const addr = target => '0x' + hex(target);
const timestamp = at => new Date(at).toISOString();
const recent = (at, limit) => Number.isFinite(at) && Date.now() >= at && Date.now() - at < limit;

const STATUS = Object.freeze({
    waiting: 'Waiting', running: 'Running', success: 'Success', negative: 'Negative Response',
    timeout: 'Timeout', transport: 'Transport Error', cancelled: 'Cancelled', invalid: 'Invalid Response',
});
function describe(record) {
    if (!record) return 'Not checked';
    if (record.nrc !== null) return bytes(record.rx) + ' · ' + (NRC[record.nrc] || 'unknown NRC');
    return record.error || record.status;
}
function safeError(error) {
    return String(error && error.message || error).replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, '[redacted]')
        .replace(/(?:\/[^\s:/]+){2,}/g, '[path]').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]');
}

class SafeDiag {
    constructor(ctx) {
        this.ctx = ctx;
        this.diag = new Diag(ctx.signals, ctx.log);
        this.diag.quiet = true;
        this.log = new SessionLog();
        this.log.add('APP START', 'Ambient Lighting ' + ((ctx.spec && ctx.spec.version) || ''));
        this.connectionRevision = 0;
        this.connected = null;
        this.speed = null;
        this.speedAt = null;
        this.speedRevision = null;
        this.readAt = null;
        this.identity = null;
        this.identityAt = null;
        this.ram = null;
        this.bdc = BUSES.map(() => ({read: null, valid: null}));
        this.session = null;
        this.nextSession = 0;
        this.operation = null;
        this.pending = null;
        this.lastWrite = null;
        this.lastWriteAt = null;
        this.lastError = null;
        this.lastSuccess = {};
        this.quietUntil = new Map();
        this.reference = null;
        this.comparison = null;
        this.comparisonAttempt = null;
        this.wizard = {step: 0, physical: 'Not checked'};
        this.info = 'Select a color and press Apply twice at standstill.';
    }
    async init() {
        this.diag.on('available', available => this.connectionChanged(available));
        if (!this.ctx.signals.hasNative || this.ctx.signals.hasNative()) this.ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: v => this.updateSpeed(v && v.speedVehicleCentreOfGravity),
        }, this.ctx.log, {pollMs: 2000}).catch(e => this.log.add('SPEED', safeError(e), 'warning'));
        await this.diag.init();
        if (this.diag.error) {
            this.lastError = {at: Date.now(), text: safeError(this.diag.error)};
            this.log.add('TASU ERROR', this.lastError.text, 'error');
        } else if (this.connected === null) this.connectionChanged(this.online);
    }
    connectionChanged(available) {
        if (available === this.connected) return;
        this.connected = available;
        if (available) { this.log.add('TASU CONNECTED', '', 'success'); return; }
        this.log.add('TASU DISCONNECTED', '', 'warning');
        this.connectionRevision++;
        this.readAt = null;
        this.cancel();
        this.abort('TASU disconnected');
    }
    get online() { return !!(this.diag.p && this.diag.available); }
    get busy() { return this.operation !== null; }
    get speedAge() { return this.speedAt === null ? null : Math.max(0, Date.now() - this.speedAt); }
    get speedFresh() {
        return this.speed !== null && this.speedRevision === this.connectionRevision && recent(this.speedAt, SPEED_FRESH_MS);
    }
    get parked() { return this.speedFresh && this.speed === 0; }
    get verified() { return this.online && recent(this.readAt, IDENTITY_FRESH_MS); }
    get confirming() { return !!this.pending && this.verified && !this.writeReady && Date.now() < this.pending.until; }
    get writeReady() {
        if (!this.online) return 'TASU unavailable';
        if (!this.parked) return 'Vehicle standstill not confirmed';
        if (Date.now() < (this.quietUntil.get(ECU) || 0)) return 'Waiting for old RAM replies to expire';
        if (this.lastWriteAt !== null && Date.now() - this.lastWriteAt < 3000) return 'Wait 3 seconds after the last request';
        return '';
    }
    get ramStatus() {
        if (!this.ram) return 'Not checked';
        if (this.ram.identity === '0F 25 90') return 'RAM01 identified · ' + this.ram.identity;
        return this.ram.identity ? 'Unknown variant · ' + this.ram.identity : this.ram.detail || describe(this.ram);
    }
    fresh(result) {
        return !!result && this.online && result.revision === this.connectionRevision && recent(result.at, REPORT_FRESH_MS);
    }
    updateSpeed(raw) {
        if (!this.parked) this.cancel();
        const valid = Number.isInteger(raw) && raw >= 0 && raw < 65535;
        this.speed = valid ? raw / 64 : null;
        this.speedAt = valid ? Date.now() : null;
        this.speedRevision = valid ? this.connectionRevision : null;
        if (!this.parked) this.cancel();
    }
    cancel() { this.pending = null; }
    abort(reason = 'Cancelled by operator') {
        this.cancel();
        const op = this.operation;
        if (!op || op.cancelled) return;
        op.cancelled = reason;
        if (op.stop) op.stop();
    }
    async run(name, steps) {
        if (this.busy) return null;
        this.cancel();
        const op = {id: ++this.nextSession, name, at: Date.now(), stage: 'Waiting', status: STATUS.waiting, stop: null, cancelled: null};
        this.operation = op;
        this.session = op;
        this.log.add('SESSION START', '#' + op.id + ' · ' + name);
        try {
            op.status = STATUS.running;
            const result = await steps(op);
            op.status = op.cancelled ? STATUS.cancelled : result;
            return op.status;
        } catch (error) {
            op.status = STATUS.transport;
            this.lastError = {at: Date.now(), text: safeError(error)};
            this.log.add('ERROR', this.lastError.text, 'error');
            return op.status;
        } finally {
            op.endAt = Date.now();
            const level = op.status === STATUS.success ? 'success' : 'warning';
            this.log.add('SESSION END', '#' + op.id + ' · ' + op.status +
                (op.cancelled ? ' · ' + op.cancelled : ''), level);
            this.operation = null;
        }
    }
    async request(op, target, sid, payload, label) {
        const delay = (this.quietUntil.get(target) || 0) - Date.now();
        if (delay > 0 && sid === 0x22 && this.online && !op.cancelled) {
            op.stage = 'Waiting for late replies · ' + label;
            await new Promise(resolve => {
                const timer = setTimeout(resolve, delay);
                op.stop = () => { clearTimeout(timer); resolve(); };
            });
            op.stop = null;
        }
        op.stage = label;
        const rec = {
            at: Date.now(), session: op.id, revision: this.connectionRevision, target, sid,
            did: payload[0] * 256 + payload[1], tx: [sid].concat(payload), rx: null, nrc: null, ms: 0,
            status: STATUS.waiting, error: null, sent: false,
        };
        if (op.cancelled) rec.status = STATUS.cancelled;
        else if (!this.online) { rec.status = STATUS.transport; rec.error = 'TASU unavailable'; }
        else {
            rec.status = STATUS.running;
            try {
                const reply = await this.diag.physicalTracked(target, sid, payload, {
                    onSend: () => {
                        rec.sent = true;
                        this.log.add('TX', addr(target) + ': ' + bytes(rec.tx) + ' · ' + label);
                    },
                    setCancel: fn => { op.stop = fn; },
                    onPending: frame => this.log.add('RX PENDING', addr(target) + ': ' + bytes(frame), 'warning'),
                    timeoutMs: target === BDC ? 4000 : 2300, callTimeoutMs: 3000,
                    pendingTimeoutMs: 4000, hardTimeoutMs: 7000,
                });
                const valid = reply && replyTo(sid, payload)(reply);
                if (op.cancelled || !this.online || this.connectionRevision !== rec.revision) rec.status = STATUS.cancelled;
                else if (!valid) rec.status = STATUS.timeout;
                else {
                    rec.rx = reply.slice();
                    rec.nrc = rec.rx[0] === 0x7F ? rec.rx[2] : null;
                    rec.status = rec.nrc === null ? STATUS.success : STATUS.negative;
                }
            } catch (error) {
                rec.status = op.cancelled || (error && error.code === 'CANCELLED') ? STATUS.cancelled : STATUS.transport;
                rec.error = safeError(error);
            }
        }
        rec.ms = Math.max(0, Date.now() - rec.at);
        if (rec.status === STATUS.success) this.lastSuccess[target] = rec.at;
        if (rec.status === STATUS.transport || rec.status === STATUS.timeout) this.lastError = {at: Date.now(), text: describe(rec)};
        if (rec.sent && [STATUS.cancelled, STATUS.timeout, STATUS.transport].includes(rec.status))
            this.quietUntil.set(target, Date.now() + QUIET_MS);
        if (rec.rx) this.log.add('RX', addr(target) + ': ' + bytes(rec.rx) + ' · ' + rec.ms + ' ms',
            rec.nrc === null ? 'success' : 'error');
        this.log.add(rec.status === STATUS.negative ? 'NRC' : 'RESULT',
            label + ' · ' + describe(rec) + ' · ' + rec.ms + ' ms',
            rec.status === STATUS.success ? 'success' : 'warning');
        return rec;
    }
    async probeRam(op) {
        this.readAt = null;
        const rec = await this.request(op, ECU, 0x22, [PROBE_DID >> 8, PROBE_DID & 255], 'RAM01 identity');
        if (rec.status === STATUS.success && rec.rx.length === 6) {
            rec.identity = bytes(rec.rx.slice(3));
            this.identity = rec.identity;
            this.identityAt = rec.at;
            if (rec.identity === '0F 25 90') this.readAt = Date.now();
        } else if (rec.status === STATUS.success) {
            rec.detail = 'Invalid identity length';
            this.log.add('RAM01 IDENTITY', rec.detail, 'warning');
        }
        this.ram = rec;
        if (rec.status === STATUS.success)
            this.log.add('RAM01 IDENTITY', this.ramStatus, this.verified ? 'success' : 'warning');
        return rec.detail ? STATUS.invalid : rec.status;
    }
    readRam() { return this.run('RAM01 identity', op => this.probeRam(op)); }
    async sampleBdc(op, buses = [0, 1]) {
        const snapshot = {at: Date.now(), revision: this.connectionRevision, records: [], complete: true};
        let status = STATUS.success;
        for (const i of buses) {
            const did = BUSES[i], label = 'BDC LIN ' + (i + 1);
            if (op.cancelled) return {status: STATUS.cancelled, snapshot: null};
            let rec = await this.request(op, BDC, 0x22, [did >> 8, did & 255], label);
            if (rec.nrc === 0x21 && !op.cancelled) {
                this.log.add('READ RETRY', label + ' · NRC 21 · one retry', 'warning');
                await sleep(500);
                if (!op.cancelled) rec = await this.request(op, BDC, 0x22, [did >> 8, did & 255], label + ' retry');
            }
            const decoded = rec.status === STATUS.success ? decode(i + 1, rec.rx.slice(3)) : null;
            this.bdc[i].read = rec;
            rec.decoded = !!decoded;
            if (decoded) {
                this.bdc[i].valid = {at: rec.at, revision: rec.revision, data: decoded};
                snapshot.records.push(...decoded.records);
                this.log.add('LIN RECORDS', label + ' · ' + decoded.valid + ' valid / ' + decoded.empty + ' empty', 'success');
            } else {
                snapshot.complete = false;
                if (status === STATUS.success) status = rec.status === STATUS.success ? STATUS.invalid : rec.status;
                if (rec.status === STATUS.success) this.log.add('LIN FORMAT', label + ' · incomplete or unknown layout', 'warning');
            }
        }
        return {status, snapshot};
    }
    readBdc(index) {
        const single = index === 0 || index === 1;
        const name = single ? 'BDC LIN ' + (index + 1) : 'BDC LIN status';
        return this.run(name, async op => (await this.sampleBdc(op, single ? [index] : undefined)).status);
    }
    saveReference(snapshot) {
        if (!snapshot || !snapshot.complete) {
            this.log.add('LIN REFERENCE', 'Incomplete capture. Last complete reference retained.', 'warning');
            return false;
        }
        this.reference = snapshot;
        this.comparison = null;
        this.comparisonAttempt = null;
        this.log.add('LIN REFERENCE', 'Both buses captured · ' + snapshot.records.length + ' populated records', 'success');
        return true;
    }
    captureReference() {
        return this.run('Capture LIN reference', async op => {
            const result = await this.sampleBdc(op);
            if (!op.cancelled) this.saveReference(result.snapshot);
            return result.status;
        });
    }
    startDiagnostics(wizard = false) {
        return this.run(wizard ? 'Guided test · baseline' : 'Read-only diagnostics', async op => {
            if (wizard) this.wizard = {step: 1, physical: 'Not checked'};
            const ram = await this.probeRam(op);
            const bdc = await this.sampleBdc(op);
            if (wizard && !op.cancelled && this.saveReference(bdc.snapshot)) {
                this.wizard.step = 2;
                this.wizard.reference = this.reference;
                this.log.add('GUIDED TEST', 'Change color in the original BMW menu.');
            }
            return bdc.status === STATUS.success ? ram : bdc.status;
        });
    }
    compareReference(guided = false) {
        const reference = guided ? this.wizard.reference : this.reference;
        if (guided && this.wizard.step !== 2 && this.wizard.step !== 3) return null;
        return this.run('Compare LIN', async op => {
            if (!reference || reference.revision !== this.connectionRevision || !this.online) {
                this.log.add('LIN COMPARE', 'Capture a fresh reference for this connection.', 'warning');
                return STATUS.cancelled;
            }
            if (guided) this.wizard.step = 3;
            this.comparisonAttempt = {at: Date.now(), status: STATUS.running};
            const result = await this.sampleBdc(op), current = result.snapshot;
            this.comparisonAttempt.status = op.cancelled ? STATUS.cancelled : result.status;
            if (op.cancelled) return STATUS.cancelled;
            if (!current || !current.complete) {
                this.log.add('LIN COMPARE', 'Incomplete reading. Last complete comparison retained.', 'warning');
            } else {
                const rows = compare(reference.records, current.records);
                this.comparison = {at: current.at, revision: current.revision, referenceAt: reference.at, rows};
                const count = status => rows.filter(row => row.status === status).length;
                this.log.add('LIN COMPARE', ['Changed', 'Unchanged', 'Added', 'Missing', 'Replaced', 'Invalid', 'Duplicate']
                    .map(label => label + ' ' + count(label)).join(' · '), 'success');
                for (const row of rows) {
                    const frame = record => record ? record.rgbw.join('/') + ' bright ' + record.brightness : 'missing';
                    this.log.add('LIN ' + row.status.toUpperCase(), row.key + ' · ' +
                        (row.color ? 'RGBW changed · ' : '') + (row.brightness ? 'brightness changed · ' : '') +
                        frame(row.from) + ' -> ' + frame(row.to));
                }
                if (guided) {
                    this.wizard.step = 4;
                    this.wizard.comparison = this.comparison;
                }
            }
            return result.status;
        });
    }
    markPhysical(answer) {
        if (this.wizard.step !== 4 || !['Yes', 'No', 'Not checked'].includes(answer)) return;
        this.wizard.physical = answer;
        this.wizard.observedAt = Date.now();
        this.log.add('PHYSICAL RESULT', 'BMW-menu visual check: ' + answer, answer === 'Yes' ? 'success' : 'info');
    }
    async apply(color, brightness, seconds, isCurrent) {
        if (this.busy) { this.info = 'Diagnostics busy'; return; }
        const blocked = this.writeReady;
        if (blocked) {
            this.cancel(); this.info = blocked;
            this.log.add('RAM TEST BLOCKED', blocked, 'warning');
            return;
        }
        if (!isCurrent()) { this.cancel(); return; }
        const data = fromPreset(color, brightness, seconds);
        const signature = bytes(data);
        if (!this.verified || !this.confirming || this.pending.signature !== signature) {
            this.cancel();
            if (!this.verified) {
                this.info = 'Checking RAM01…';
                await this.readRam();
                if (!this.verified) { this.info = this.ramStatus; return; }
            }
            if (!isCurrent() || this.writeReady) { this.info = this.writeReady || 'Selection changed. Press Apply again.'; return; }
            this.pending = {signature, until: Date.now() + 8000};
            this.info = 'Press APPLY again within 8 seconds to send the RAM test.';
            this.log.add('RAM TEST ARMED', 'Manual confirmation required · ' + bytes([0x2E].concat(data)));
            return;
        }
        this.cancel();
        this.readAt = null;
        this.lastWriteAt = Date.now();
        await this.run('RAM01 manual color test', async op => {
            const rec = await this.request(op, ECU, 0x2E, data, 'RAM01 E311');
            rec.parameters = {nad: data[2], on: data[3], brightness: data[4], rgb: data.slice(5, 8), seconds: data[8]};
            rec.acknowledged = rec.status === STATUS.success && rec.rx.length === 3;
            rec.text = rec.acknowledged ? '6E E3 11 · acknowledged. Check the lights.' :
                rec.status === STATUS.success ? 'Invalid write acknowledgment length' : describe(rec);
            rec.physical = 'Not checked';
            this.lastWrite = rec;
            this.info = rec.text;
            this.log.add('RAM WRITE', rec.text + ' · Physical result: not checked', rec.acknowledged ? 'success' : 'error');
            return rec.status === STATUS.success && !rec.acknowledged ? STATUS.invalid : rec.status;
        });
    }
    report(version) {
        const session = this.session;
        return {
            version, exportedAt: timestamp(Date.now()), startedAt: timestamp(this.log.startedAt),
            session: session && {id: session.id, name: session.name, at: session.at,
                endAt: session.endAt, stage: session.stage, status: session.status},
            connection: {tasu: this.online, revision: this.connectionRevision},
            ram: this.ram, ramIdentity: this.identity, ramIdentityAt: this.identityAt,
            bdc: this.bdc, reference: this.reference, comparison: this.comparison,
            comparisonAttempt: this.comparisonAttempt,
            lastWrite: this.lastWrite, lastError: this.lastError, lastSuccess: this.lastSuccess,
            visual: {step: this.wizard.step, result: this.wizard.physical,
                referenceAt: this.wizard.reference && this.wizard.reference.at, observedAt: this.wizard.observedAt,
                comparison: this.wizard.comparison},
            logDropped: this.log.dropped, logClearedAt: this.log.clearedAt, log: this.log.export(),
        };
    }
}

module.exports = {SafeDiag, STATUS, bytes, describe};
