'use strict';
// Plays a show plan (effects.js) or a single lamp test over every route in one serialized
// diagnostic conversation. Safety, in this order:
//   1. P + standstill (guard) before and between every request; losing it stops the show;
//   2. BDC_G05 and each headlamp module identified before anything else;
//   3. recovery marker written before the first session or lamp request;
//   4. every lamp has a finite ECU time (FLM seconds, D542 duration) and an explicit OFF/STOP;
//   5. at the end (also after STOP or an error) every touched unit gets its stop and the
//      default session; the marker is removed only when all of them acknowledged.
// Acknowledgements are protocol answers, not light measurements.
const F = require('./flm-control');
const P = require('./protocol');
const R = require('./rlm-control');

const KEEPALIVE_MS = 2000;
const MIN_ACKNOWLEDGED_STEP_MS = 150;

class Runner {
    constructor(o) {
        this.link = o.link; this.guard = o.guard; this.journal = o.journal; this.log = o.log || console;
        this.now = o.now || Date.now; this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.changed = o.changed || (() => {});
        this.state = 'IDLE'; this.note = 'Ready'; this.run = null; this.cancel = false;
        this.active = new Set(); this.sent = 0; this.progress = null; this.cleanup = null;
        this.lastError = null; this.stopReason = null; this.title = '';
        this.commOff = o.commOff || (() => false);   // test option from the settings
    }
    status() {
        return { state: this.state, note: this.note, active: Array.from(this.active), sent: this.sent,
            progress: this.progress ? Object.assign({}, this.progress) : null, title: this.title,
            busy: !!this.run, recoveryPending: this.journal.pending(), cleanup: this.cleanup, lastError: this.lastError };
    }
    update(state, note) { this.state = state; this.note = note; this.changed(); }
    allowed() {
        if (this.cancel) return false;
        const why = this.guard.reason();
        if (why) { this.cancel = true; this.stopReason = why; return false; }
        return true;
    }
    async wait(ms) {
        for (let t = 0; t < ms && this.allowed();) {
            const d = Math.min(25, ms - t);
            await this.sleep(d); t += d;
        }
    }
    /** Run fn exclusively (one diagnostic conversation at a time). */
    exclusive(state, note, fn) {
        if (this.run) return Promise.reject(new Error('Busy: stop the running show first'));
        this.cancel = false; this.stopReason = null;
        this.update(state, note);
        const job = (async () => fn())();
        this.run = job.then(() => {}, () => {}).then(() => { this.run = null; this.changed(); });
        return job;
    }

    /** Light one lamp for a short test. lamp: catalog entry. */
    test(lamp, opts) {
        const o = opts || {};
        const ms = [500, 1000, 2000].indexOf(o.ms) >= 0 ? o.ms : 1000;
        const pwm = F.PWM_OPTIONS.indexOf(o.pwm) >= 0 ? o.pwm : F.DEFAULT_PWM;
        return this.play({ name: 'Test: ' + lamp.label, steps: [{ on: [lamp.id], ms }], gapMs: 0, cycles: 1, pwm, bodyIndex: o.bodyIndex },
            { [lamp.id]: lamp });
    }

    /** plan: effects.plan() result (or a test plan); byId: lamp id -> catalog entry. */
    play(plan, byId) {
        if (this.run) return Promise.resolve({ ok: false, error: 'Busy' });
        const why = this.guard.reason();
        if (why) { this.update('BLOCKED', why); return Promise.resolve({ ok: false, error: why }); }
        if (this.journal.pending()) {
            this.update('ERROR', 'A previous run was not released yet - press STOP first');
            return Promise.resolve({ ok: false, error: 'Recovery pending' });
        }
        let lamps;
        try { lamps = Runner.lampsOf(plan, byId); }
        catch (e) { this.update('ERROR', e.message); return Promise.resolve({ ok: false, error: e.message }); }
        this.title = plan.name || 'Show';
        this.sent = 0; this.cleanup = null; this.lastError = null; this.active.clear();
        return this.exclusive('STARTING', 'Checking the control units', () => this._execute(plan, byId, lamps))
            .catch((e) => ({ ok: false, error: String(e.message || e) }));
    }
    static lampsOf(plan, byId) {
        if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) throw new Error('Empty show');
        const ids = new Set();
        plan.steps.forEach((s) => (s.on || []).forEach((id) => ids.add(id)));
        if (!ids.size) throw new Error('The show switches nothing on');
        const lamps = Array.from(ids).map((id) => {
            const l = byId[id];
            if (!l || !l.available) throw new Error('Lamp not available: ' + id);
            if (l.route === 'flm') { F.moduleFor(l.side); F.channelNumber(l.channel); }
            else if (l.route === 'fn') P.timedControl(l.key, 0);
            else if (l.route === 'out') P.control(l.output, 0);
            else if (l.route === 'rlm') { R.module(l.address); if (l.kind === 'grp') R.groupCode(l.item); else R.telegram(l.kind, l.item, 0, 60); }
            else throw new Error('Unknown route');
            return l;
        });
        plan.steps.forEach((s) => {
            const units = (s.on || []).map((id) => Runner.routineUnit(byId[id])).filter(Boolean);
            if (new Set(units).size !== units.length) throw new Error('Two channels of one module in one step');
            if (!Number.isInteger(s.ms) || s.ms < 100 || s.ms > 3000) throw new Error('Invalid step time');
        });
        return lamps;
    }
    /** Modules that run one routine at a time: FLM per side, RLM2 segment groups per module. */
    static routineUnit(l) {
        if (l.route === 'flm') return 'flm:' + l.side;
        if (l.route === 'rlm' && l.kind === 'grp') return 'rlm:' + l.address;
        return null;
    }
    static rlmAddresses(control) { return Array.from(new Set((control.rlm || []).map((r) => r.address))); }
    static touched(lamps) {
        return {
            flmSides: Array.from(new Set(lamps.filter((l) => l.route === 'flm').map((l) => l.side))),
            fns: Array.from(new Set(lamps.filter((l) => l.route === 'fn').map((l) => l.key))),
            outputs: Array.from(new Set(lamps.filter((l) => l.route === 'out').map((l) => l.output))),
            rlm: Array.from(new Set(lamps.filter((l) => l.route === 'rlm').map((l) => l.address + ':' + l.kind))).map((key) => {
                const [a, kind] = key.split(':'), address = Number(a);
                const ls = lamps.filter((l) => l.route === 'rlm' && l.address === address && l.kind === kind);
                return { address, kind, items: Array.from(new Set(ls.map((l) => l.item))) };
            }),
        };
    }

    async _execute(plan, byId, lamps) {
        const touched = Runner.touched(lamps);
        touched.commOff = this.commOff() ? touched.flmSides.slice() : [];
        touched.bdcSession = touched.fns.length > 0 || touched.outputs.length > 0;
        const pendingOff = new Set();
        let dirty = false, fault = null;
        try {
            await this.link.identify(plan.bodyIndex);
            if (!this.allowed()) return this._finish(false, null);
            for (const side of touched.flmSides) {
                await this.link.identifyFlm(side, lamps.find((l) => l.route === 'flm' && l.side === side).index);
                if (!this.allowed()) return this._finish(false, null);
            }
            for (const address of Runner.rlmAddresses(touched)) {
                const v = await this.link.identifyRlm(address, lamps.find((l) => l.route === 'rlm' && l.address === address).index);
                touched.rlm.filter((r) => r.address === address).forEach((r) => {
                    if (v.kinds.indexOf(r.kind) < 0) throw new Error(v.name + ' does not offer this kind of light');
                });
                if (!this.allowed()) return this._finish(false, null);
            }
            this.journal.mark(this.link.index, touched); dirty = true;
            if (touched.bdcSession && this.allowed()) await this.link.session();
            for (const side of touched.flmSides) if (this.allowed()) await this.link.flmSession(side);
            for (const side of touched.commOff) if (this.allowed()) await this.link.flmCommunication(side, false);
            for (const address of Runner.rlmAddresses(touched)) if (this.allowed()) await this.link.rlmSession(address);
            const last = {};
            const touch = (k) => { last[k] = this.now(); };
            if (touched.bdcSession) touch('bdc');
            touched.flmSides.forEach(touch);
            Runner.rlmAddresses(touched).forEach((a) => touch('rlm' + a));
            const cycles = plan.cycles || 1, total = plan.steps.length * cycles;
            this.progress = { step: 0, steps: total, cycle: 1, cycles, startedAt: this.now(), estimateMs: plan.estimateMs || null };
            this.update('RUNNING', plan.name || 'Show');
            let n = 0;
            for (let c = 0; c < cycles && this.allowed(); c++) {
                this.progress.cycle = c + 1;
                for (const step of plan.steps) {
                    if (!this.allowed()) break;
                    this.progress.step = ++n; this.changed();
                    const begin = this.now(), on = (step.on || []).map((id) => byId[id]);
                    let failure = null;
                    const started = [];
                    try {
                        for (const l of on) {
                            if (!this.allowed()) break;
                            started.push(l);            // record before sending: the ECU may act even if the reply is lost
                            pendingOff.add(l);
                            await this._on(l, step.ms, plan.pwm);
                            this.sent++; this.active.add(l.id); this.changed();
                            touch(this.unitKey(l));
                        }
                        const hold = started.length ? Math.max(step.ms - (this.now() - begin), Math.min(step.ms, MIN_ACKNOWLEDGED_STEP_MS)) : step.ms;
                        await this.wait(hold);
                    } catch (e) { failure = e; }
                    for (const l of started) {
                        try { await this._off(l); pendingOff.delete(l); touch(this.unitKey(l)); }
                        catch (e) { failure = failure || e; }
                        this.active.delete(l.id);
                    }
                    this.changed();
                    if (failure) throw failure;
                    for (const k of Object.keys(last)) {
                        if (this.now() - last[k] < KEEPALIVE_MS || !this.allowed()) continue;
                        if (k === 'bdc') await this.link.keepalive();
                        else if (k.indexOf('rlm') === 0) await this.link.rlmKeepalive(Number(k.slice(3)));
                        else await this.link.flmKeepalive(k);
                        touch(k);
                    }
                    if (plan.gapMs) await this.wait(plan.gapMs);
                }
            }
        } catch (e) { fault = String(e.message || e); this.lastError = fault; this.log.warn('Light Show run: ' + fault); }
        finally {
            this.active.clear();
            if (dirty) {
                const remaining = Runner.touched(Array.from(pendingOff));
                await this._release(touched, remaining);
            }
        }
        return this._finish(dirty, fault);
    }
    _finish(dirty, fault) {
        const ok = !fault && (!dirty || !this.journal.pending());
        if (this.journal.pending()) { /* _release already set ERROR */ }
        else if (fault) this.update('ERROR', fault);
        else this.update('IDLE', this.stopReason ? 'Stopped: ' + this.stopReason
            : dirty ? (this.title + ' finished - all units released') : 'Nothing was switched');
        this.progress = null; this.changed();
        return { ok, error: fault || this.stopReason || (this.journal.pending() ? this.note : null), sent: this.sent };
    }
    unitKey(l) { return l.route === 'flm' ? l.side : l.route === 'rlm' ? 'rlm' + l.address : 'bdc'; }
    async _on(l, ms, pwm) {
        if (l.route === 'rlm') return this.link.rlmSet(l.address, l.kind, l.item, ms, pwm);
        if (l.route === 'flm') return this.link.flmStart(l.side, l.channel, pwm, Math.min(3, Math.max(1, Math.ceil(ms / 1000))));
        if (l.route === 'fn') return this.link.timed(l.key, Math.min(2000, Math.max(100, Math.round(ms / 10) * 10)));
        return this.link.set(l.output, 1);
    }
    async _off(l) {
        if (l.route === 'rlm') return this.link.rlmSet(l.address, l.kind, l.item, 0, 60);
        if (l.route === 'flm') return this.link.flmStop(l.side);
        if (l.route === 'fn') return this.link.timed(l.key, 0);
        return this.link.set(l.output, 0);
    }
    /** Retry unfinished OFF requests, then restore every session. After restart, release the full marker. */
    async _release(control, remaining = control, errors = []) {
        this.update('STOPPING', 'Switching off and releasing the control units');
        const done = { flmStop: {}, fn: {}, out: {}, flmDefault: {}, bdcDefault: null };
        for (const side of remaining.flmSides) {
            try { await this.link.flmStop(side); done.flmStop[side] = true; }
            catch (e) { done.flmStop[side] = false; errors.push(side + ' headlamp STOP: ' + (e.message || e)); }
        }
        for (const k of remaining.fns) {
            try { await this.link.timed(k, 0); done.fn[k] = true; }
            catch (e) { done.fn[k] = false; errors.push('function ' + k + ' off: ' + (e.message || e)); }
        }
        for (const id of remaining.outputs) {
            try { await this.link.set(id, 0); done.out[id] = true; }
            catch (e) { done.out[id] = false; errors.push('output 0x' + id.toString(16) + ' off: ' + (e.message || e)); }
        }
        done.rlm = {};
        for (const r of remaining.rlm || []) {
            // a segment-group routine is stopped once per module; functions / channels one by one
            for (const item of r.kind === 'grp' ? [0] : r.items) {
                try { await this.link.rlmSet(r.address, r.kind, item, 0, 60); }
                catch (e) { errors.push('rear light 0x' + r.address.toString(16) + ' off: ' + (e.message || e)); }
            }
        }
        for (const address of Runner.rlmAddresses(control)) {
            try { await this.link.rlmDefaultSession(address); done.rlm[address] = true; }
            catch (e) { done.rlm[address] = false; errors.push('rear light 0x' + address.toString(16) + ' default session: ' + (e.message || e)); }
        }
        done.comm = {};
        const commErrors = {};
        for (const side of control.commOff || []) {
            try { await this.link.flmCommunication(side, true); done.comm[side] = true; }
            catch (e) { done.comm[side] = false; commErrors[side] = side + ' headlamp communication on: ' + (e.message || e); }
        }
        for (const side of control.flmSides) {
            try { await this.link.flmDefaultSession(side); done.flmDefault[side] = true; }
            catch (e) { done.flmDefault[side] = false; errors.push(side + ' headlamp default session: ' + (e.message || e)); }
        }
        // A refused "communication on" only counts when the default session was not confirmed
        // either: returning to the default session restores normal communication (ISO 14229).
        Object.keys(commErrors).forEach((side) => { if (!done.flmDefault[side]) errors.push(commErrors[side]); });
        // Leaving the extended session ends every IOControl the BDC still holds (ISO 14229).
        if (control.bdcSession) {
            try { await this.link.defaultSession(); done.bdcDefault = true; }
            catch (e) { done.bdcDefault = false; errors.push('BDC default session: ' + (e.message || e)); }
        }
        this.cleanup = Object.assign(done, { errors });
        if (!errors.length) {
            try { this.journal.clear(); }
            catch (e) { errors.push('Cannot remove the recovery file: ' + e.message); }
        }
        if (errors.length) { this.update('ERROR', 'Release not confirmed: ' + errors.join('; ') + ' - check the normal lights, then STOP again'); return false; }
        return true;
    }

    /** STOP: cancel a running show, or release what a crashed run left behind. */
    stop(reason) {
        this.cancel = true; this.stopReason = reason || 'STOP pressed';
        if (this.run) return this.run;
        if (!this.journal.pending()) { this.update('IDLE', 'Nothing to stop'); return Promise.resolve(); }
        return this.exclusive('STOPPING', 'Releasing a previous run', () => this._recover()).catch(() => {});
    }
    async _recover() {
        const control = this.journal.control();
        if (!control) { this.update('ERROR', 'Recovery file unreadable: check the normal lights, then confirm it in Vehicle'); return; }
        try { await this.link.identify(); }
        catch (e) { this.update('ERROR', 'Release pending: ' + (e.message || e)); return; }
        const errors = [], flmSides = [], rearAddresses = new Set();
        for (const side of control.flmSides) {
            try { await this.link.identifyFlm(side); flmSides.push(side); }
            catch (e) { errors.push(side + ' headlamp identity: ' + (e.message || e)); }
        }
        for (const address of Runner.rlmAddresses(control)) {
            try { await this.link.identifyRlm(address); rearAddresses.add(address); }
            catch (e) { errors.push('rear light 0x' + address.toString(16) + ' identity: ' + (e.message || e)); }
        }
        const reachable = Object.assign({}, control, { flmSides,
            commOff: control.commOff.filter((side) => flmSides.indexOf(side) >= 0),
            rlm: control.rlm.filter((r) => rearAddresses.has(r.address)),
        });
        if (await this._release(reachable, reachable, errors)) this.update('IDLE', 'Previous run released');
    }
    /** After the user checked all normal lights with the car's own switches. */
    acknowledgeNormalLights() {
        if (this.guard.reason()) return Promise.reject(new Error(this.guard.reason()));
        return this.exclusive('CHECKING', 'Clearing the saved stop lock', async () => {
            await this.link.identify();
            await this.link.defaultSession();
            this.journal.clear();
            this.update('IDLE', 'Stop lock cleared after your light check');
        }).catch((e) => { this.update('ERROR', String(e.message || e)); });
    }
}
module.exports = Runner;
