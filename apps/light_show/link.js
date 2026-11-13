'use strict';
const { Diag, replyTo, NRC } = require('./tasu');
const P = require('./protocol');
const F = require('./flm-control');

class Link {
    constructor(signals, log, changed) {
        this.diag = new Diag(signals, log); this.diag.quiet = true;
        this.log = log; this.changed = changed || (() => {});
        this.available = false; this.index = null; this.identifiedAt = 0;
        this.trace = []; this._busy = false;
        this.verifiedFlm = {};
    }
    async init() {
        await this.diag.init(); this.available = this.diag.available;
        this.diag.on('available', (up) => {
            this.available = !!up; this.index = null; this.identifiedAt = 0; this.verifiedFlm = {}; this.changed();
        });
        return this;
    }
    async request(sid, data, release, address) {
        address = address === undefined ? P.ADDRESS : address;
        if (address !== P.ADDRESS) {
            const validAddress = [0x43, 0x44].indexOf(address) >= 0;
            const readOnly = sid === 0x22 && ['F1 50', 'D9 FC'].indexOf(P.hex(data)) >= 0;
            const session = sid === 0x10 && (P.hex(data) === '03' || P.hex(data) === '01');
            const routine = sid === 0x31 && F.isPermittedRoutine(data);
            if (!validAddress || (!readOnly && !this.verifiedFlm[address]) || (!readOnly && !session && !routine))
                throw new Error('Unsupported FLM diagnostic request / module not identified');
        }
        if (this._busy) throw new Error('Diagnostic request already in flight');
        if (!this.available) throw new Error('No BDC diagnostic connection');
        this._busy = true;
        const record = { address, at: new Date().toISOString(), tx: P.hex([sid].concat(data)) };
        this.trace.push(record); if (this.trace.length > 80) this.trace.shift();
        const start = Date.now();
        try {
            const u = await this.diag.physical(address, sid, data, release ? 800 : 400, replyTo(sid, data), {
                maxRetries: 0, callTimeoutMs: 700, hardTimeoutMs: 1200, pendingTimeoutMs: 800,
            });
            record.ms = Date.now() - start; record.rx = u ? P.hex(u) : 'TIMEOUT';
            const controller = address === P.ADDRESS ? 'BDC' : 'FLM';
            if (!u || !u.length) throw new Error(controller + ' reply timed out');
            if (u[0] === 0x7F) throw new Error(controller + ' NRC ' + P.hex([u[2]]) + ': ' + (NRC[u[2]] || 'request refused'));
            if (!replyTo(sid, data)(u) || u[0] !== sid + 0x40) throw new Error('Unexpected ' + controller + ' reply');
            return u;
        } catch (e) {
            record.error = String(e.message || e); this.log.warn('Light Show ' + record.tx + ': ' + record.error); throw e;
        } finally { this._busy = false; }
    }
    async identify() {
        this.index = null;
        const u = await this.request(0x22, [0xF1, 0x50]);
        this.index = P.indexOf(u.slice(3)); this.identifiedAt = Date.now();
        if (this.index !== P.INDEX) throw new Error('BDC variant ' + (this.index || 'unknown') + ' is not supported (requires BDC_G05)');
        return this.index;
    }
    async identifyFlm(side) {
        const m = F.moduleFor(side);
        delete this.verifiedFlm[m.address];
        const u = await this.request(0x22, [0xF1, 0x50], false, m.address);
        const index = P.indexOf(u.slice(3));
        if (index !== m.index) throw new Error(m.name + ' variant ' + (index || 'unknown') + ' unsupported');
        this.verifiedFlm[m.address] = index;
        return index;
    }
    async flmSession(side) { return this.request(0x10, [0x03], false, F.moduleFor(side).address); }
    async flmStart(side, channel, pwm = F.DEFAULT_PWM, seconds = F.DEFAULT_SECONDS) {
        return this.request(0x31, F.start(channel, pwm, seconds), false, F.moduleFor(side).address);
    }
    async flmStop(side) { return this.request(0x31, F.stop(), true, F.moduleFor(side).address); }
    async flmDefaultSession(side) { return this.request(0x10, [0x01], true, F.moduleFor(side).address); }
    async readOutputs() { return this.request(0x22, [0xE3, 0xB9]); }
    async readFunctionStatus() { return this.request(0x22, P.FUNCTION_DID); }
    async timed(lights, ms) { return this.request(0x2E, P.timedControl(lights, ms), ms === 0); }
    async session() { return this.request(0x10, [0x03]); }
    async set(output, on) { return this.request(0x2F, P.control(output, on)); }
    async keepalive() { return this.request(0x3E, [0x00]); }
    async release() { return this.request(0x2F, P.release(), true); }
    async defaultSession() { return this.request(0x10, [0x01], true); }
}
module.exports = Link;
