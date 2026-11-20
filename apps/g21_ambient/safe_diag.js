'use strict';

const { Diag, hex, NRC, replyTo } = require('./kit/diag');
const { ECU, DID, PROBE_DID, fromPreset } = require('./logic');

const READ_OPTIONS = { maxRetries: 0, callTimeoutMs: 3000, pendingTimeoutMs: 4000, hardTimeoutMs: 7000 };
const BDC = 0x40;
const BDC_DIDS = [0xDA5F, 0xE3D1];
const writeDID = [DID >> 8, DID & 255];
const probeDID = [PROBE_DID >> 8, PROBE_DID & 255];

function bytes(data) { return data.map(n => hex(n)).join(' '); }
function resultText(reply) {
    if (!reply) return 'No ECU response (timeout)';
    if (reply[0] === 0x7F && reply.length >= 3) {
        return bytes(reply.slice(0, 3)) + ' · ' + (NRC[reply[2]] || 'unknown NRC');
    }
    return 'Unexpected reply: ' + bytes(reply.slice(0, 8));
}

class SafeDiag {
    constructor(ctx) {
        this.ctx = ctx;
        this.diag = new Diag(ctx.signals, ctx.log);
        this.speed = null;
        this.speedAt = 0;
        this.readAt = null;
        this.identity = null;
        this.ramStatus = 'Identity not read';
        this.bdcStatus = BDC_DIDS.map(() => 'Not checked');
        this.lastWrite = null;
        this.lastWriteAt = null;
        this.pending = null;
        this.busy = false;
        this.connectionRevision = 0;
        this.info = 'Select a color and press APPLY twice at standstill.';
    }
    async init() {
        this.ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: v => this.updateSpeed(v && v.speedVehicleCentreOfGravity),
        }, this.ctx.log, { pollMs: 2000 }).catch(e => this.ctx.log.warn('Vehicle speed: ' + e));
        this.diag.on('available', available => {
            if (!available) {
                this.connectionRevision++;
                this.cancel();
                this.readAt = null;
                this.identity = null;
                this.ramStatus = 'TASU connection interrupted';
            }
        });
        await this.diag.init();
    }
    updateSpeed(raw) {
        const valid = Number.isInteger(raw) && raw >= 0 && raw < 65535;
        if (!this.parked) this.cancel();
        this.speed = valid ? raw * 0.015625 : null;
        this.speedAt = Date.now();
        if (!this.parked) this.cancel();
    }
    get online() { return !!(this.diag.p && this.diag.available); }
    get speedFresh() { return this.speed !== null && Date.now() - this.speedAt < 5000; }
    get parked() { return this.speedFresh && this.speed === 0; }
    get verified() { return this.readAt !== null && Date.now() - this.readAt < 60000; }
    get confirming() { return !!this.pending && this.verified && !this.writeReady && Date.now() < this.pending.until; }
    get writeReady() {
        if (!this.online) return 'TASU unavailable';
        if (!this.parked) return 'Vehicle standstill not confirmed';
        if (this.lastWriteAt !== null && Date.now() - this.lastWriteAt < 3000) return 'Wait 3 seconds after the last request';
        return '';
    }
    cancel() { this.pending = null; }
    async readData(target, did, timeout) {
        const request = [did >> 8, did & 255];
        return this.diag.physical(target, 0x22, request, timeout, replyTo(0x22, request), READ_OPTIONS);
    }
    async probeRam() {
        this.readAt = null;
        this.identity = null;
        this.ramStatus = 'Checking RAM01…';
        const revision = this.connectionRevision;
        try {
            const reply = await this.readData(ECU, PROBE_DID, 2300);
            if (!this.online || this.connectionRevision !== revision) {
                this.ramStatus = 'TASU connection interrupted';
                return;
            }
            if (!reply || reply[0] !== 0x62 || reply[1] !== probeDID[0] || reply[2] !== probeDID[1] || reply.length !== 6) {
                this.ramStatus = resultText(reply);
                return;
            }
            this.identity = bytes(reply.slice(3, 6));
            this.ramStatus = 'SGBD ' + this.identity + ' · unknown RAM variant';
            if (this.identity === '0F 25 90') {
                this.readAt = Date.now();
                this.ramStatus = 'RAM01 identified · 0F 25 90';
            }
        } catch (e) { this.ramStatus = 'RAM read failed: ' + String(e.message || e); }
    }
    async readRam() {
        this.cancel();
        if (this.busy) return;
        if (!this.online) { this.ramStatus = 'TASU unavailable'; return; }
        this.busy = true;
        try { await this.probeRam(); }
        finally { this.busy = false; }
    }
    async readBdc() {
        this.cancel();
        if (this.busy) return;
        if (!this.online) { this.bdcStatus = BDC_DIDS.map(() => 'TASU unavailable'); return; }
        this.busy = true;
        this.bdcStatus = BDC_DIDS.map(() => 'Waiting…');
        try {
            for (let i = 0; i < BDC_DIDS.length; i++) {
                const did = BDC_DIDS[i];
                if (!this.online) { this.bdcStatus[i] = 'TASU unavailable'; continue; }
                this.bdcStatus[i] = 'Reading…';
                try {
                    let reply = await this.readData(BDC, did, 4000);
                    if (this.online && reply && reply[0] === 0x7F && reply[1] === 0x22 && reply[2] === 0x21) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                        if (this.online) reply = await this.readData(BDC, did, 4000);
                    }
                    const positive = reply && reply[0] === 0x62 && reply[1] === (did >> 8) &&
                        reply[2] === (did & 255) && reply.length > 3;
                    if (!this.online) this.bdcStatus[i] = 'TASU unavailable';
                    else if (positive) this.bdcStatus[i] = 'Positive reply · data length ' + (reply.length - 3);
                    else this.bdcStatus[i] = resultText(reply);
                } catch (e) { this.bdcStatus[i] = 'Read failed: ' + String(e.message || e); }
                this.ctx.log.info('[AMBIENT BDC ' + hex(did, 4) + '] ' + this.bdcStatus[i]);
            }
        } finally { this.busy = false; }
    }
    async apply(color, brightness, seconds, isCurrent) {
        if (this.busy) { this.info = 'Diagnostics busy'; return; }
        const blocked = this.writeReady;
        if (blocked) { this.cancel(); this.info = blocked; return; }
        if (!isCurrent()) { this.cancel(); return; }
        const data = fromPreset(color, brightness, seconds);
        const signature = bytes(data);
        if (!this.verified || !this.confirming || this.pending.signature !== signature) {
            this.cancel();
            if (!this.verified) {
                this.info = 'Checking RAM01…';
                this.busy = true;
                try { await this.probeRam(); }
                finally { this.busy = false; }
                if (!this.verified) { this.info = this.ramStatus; return; }
            }
            if (!isCurrent()) { this.info = 'Selection changed. Press APPLY to start again.'; return; }
            const reason = this.writeReady;
            if (reason) { this.info = reason; return; }
            this.pending = { signature, until: Date.now() + 8000 };
            this.info = 'Press APPLY again within 8 seconds to send the RAM test.';
            return;
        }
        this.cancel();
        this.readAt = null;
        this.lastWriteAt = Date.now();
        this.busy = true;
        try {
            const reply = await this.diag.physical(ECU, 0x2E, data, 2300, replyTo(0x2E, writeDID), READ_OPTIONS);
            const acknowledged = !!(reply && reply[0] === 0x6E && reply[1] === writeDID[0] && reply[2] === writeDID[1]);
            this.lastWrite = {
                acknowledged,
                text: acknowledged ? '6E E3 11 · acknowledged. Check the lights.' : resultText(reply),
            };
        } catch (e) { this.lastWrite = { acknowledged: false, text: 'Write failed: ' + String(e.message || e) }; }
        finally {
            this.busy = false;
            this.info = this.lastWrite.text;
            this.ctx.log.info('[AMBIENT RAM E311] ' + this.info);
        }
    }
}

module.exports = { SafeDiag };
