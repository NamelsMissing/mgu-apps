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
        this.state = this.journal.pending() ? 'RECOVERY REQUIRED' : 'IDLE';
        this.note = this.journal.pending() ? 'STOP to verify and release the saved control units' : 'Ready';
        this.run = null; this.stopTask = null; this.lastStop = null; this.cancel = false;
        this.active = new Set(); this.sent = 0; this.progress = null; this.cleanup = null;
        this.lastError = null; this.stopReason = null; this.title = '';
        this.commOff = o.commOff || (() => false);   // test option from the settings
    }
    status() {
        return { state: this.state, note: this.note, active: Array.from(this.active), sent: this.sent,
            progress: this.progress ? Object.assign({}, this.progress) : null, title: this.title,
            busy: !!this.run, recoveryPending: this.journal.pending(), cleanup: this.cleanup, lastError: this.lastError, lastStop: this.lastStop };
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
        const finish = () => { this.run = null; this.changed(); };
        this.run = Promise.resolve().then(fn).then((result) => { finish(); return result; },
            (error) => { finish(); throw error; });
        return this.run;
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
        if (this.journal.pending()) return Promise.resolve({ ok: false, error: this.note });
        const why = this.guard.reason();
        if (why) { this.update('BLOCKED', why); return Promise.resolve({ ok: false, error: why }); }
        let lamps;
        try { lamps = Runner.lampsOf(plan, byId); }
        catch (e) { this.update('ERROR', e.message); return Promise.resolve({ ok: false, error: e.message }); }
        this.title = plan.name || 'Show';
        this.sent = 0; this.cleanup = null; this.lastError = null; this.active.clear();
        return this.exclusive('STARTING', 'Checking the control units', () => this._execute(plan, byId, lamps))
            .catch((e) => {
                const error = String(e.message || e);
                if (this.journal.pending()) return this.releaseFailed([error]);
                this.update('ERROR', error);
                return { ok: false, error };
            });
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
        const pendingOff = new Set(), offErrors = new Map();
        let dirty = false, fault = null;
        try {
            if (!this.allowed()) return this._finish(false, null);
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
            if (this.allowed()) this.update('RUNNING', plan.name || 'Show');
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
                        catch (e) {
                            offErrors.set(Runner.offKey(l), e);
                            failure = failure || e;
                        }
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
                await this._release(touched, remaining, offErrors);
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
        return { ok, error: this.journal.pending() ? this.note : fault || this.stopReason || null, sent: this.sent };
    }
    unitKey(l) { return l.route === 'flm' ? l.side : l.route === 'rlm' ? 'rlm' + l.address : 'bdc'; }
    async _on(l, ms, pwm) {
        if (l.route === 'rlm') return this.link.rlmSet(l.address, l.kind, l.item, ms, pwm);
        if (l.route === 'flm') return this.link.flmStart(l.side, l.channel, pwm, Math.min(3, Math.max(1, Math.ceil(ms / 1000))));
        if (l.route === 'fn') return this.link.timed(l.key, Math.min(P.MAX_TIMED_MS, Math.max(100, Math.round(ms / 10) * 10)));
        return this.link.set(l.output, 1);
    }
    async _off(l) {
        if (l.route === 'rlm') return this.link.rlmSet(l.address, l.kind, l.item, 0, 60);
        if (l.route === 'flm') return this.link.flmStop(l.side);
        if (l.route === 'fn') return this.link.timed(l.key, 0);
        return this.link.set(l.output, 0);
    }
    static offKey(l) {
        if (l.route === 'flm') return 'FLM ' + l.side + ' STOP';
        if (l.route === 'fn') return 'BDC 0x40 ' + l.key + ' off';
        if (l.route === 'out') return 'BDC 0x40 output ' + l.output + ' off';
        return 'RLM 0x' + l.address.toString(16).toUpperCase() + ' ' + l.kind + ' ' + (l.kind === 'grp' ? 0 : l.item) + ' off';
    }
    releaseSteps(control) {
        const steps = [];
        const add = (unit, name, run) => steps.push({ unit, name, run });
        for (const side of control.flmSides) add(side, Runner.offKey({ route: 'flm', side }), () => this.link.flmStop(side));
        for (const key of control.fns) add('bdc', Runner.offKey({ route: 'fn', key }), () => this.link.timed(key, 0));
        for (const output of control.outputs) add('bdc', Runner.offKey({ route: 'out', output }), () => this.link.set(output, 0));
        for (const r of control.rlm) {
            for (const item of r.kind === 'grp' ? [0] : r.items) {
                add(r.address, Runner.offKey({ route: 'rlm', address: r.address, kind: r.kind, item }),
                    () => this.link.rlmSet(r.address, r.kind, item, 0, 60));
            }
        }
        return steps;
    }
    sessionSteps(control) {
        const steps = control.flmSides.map((side) => ({
            unit: side, name: 'FLM ' + side + ' default session', run: () => this.link.flmDefaultSession(side),
        }));
        for (const unit of Runner.rlmAddresses(control)) steps.push({
            unit, name: 'RLM 0x' + unit.toString(16).toUpperCase() + ' default session', run: () => this.link.rlmDefaultSession(unit),
        });
        if (control.bdcSession) steps.push({ unit: 'bdc', name: 'BDC 0x40 default session', run: () => this.link.defaultSession() });
        return steps;
    }
    report(step, outcome) {
        if (this.link.record) this.link.record({ step, outcome });
    }
    async _release(control, remaining = null, attempted = new Map(), recovery = false) {
        this.update('STOPPING', 'Switching off and releasing the control units');
        const confirmed = this.journal.confirmed(), errors = new Map(), unavailable = new Set();
        const offs = this.releaseSteps(control), defaults = this.sessionSteps(control);
        const comm = control.commOff.map((side) => ({
            unit: side, name: 'FLM ' + side + ' communication on', run: () => this.link.flmCommunication(side, true),
        }));
        const required = offs.concat(comm, defaults);
        const locator = 'BDC 0x40 locator off', locatorExpiry = 'BDC 0x40 locator timer elapsed';
        const resolved = (name) => confirmed.has(name) || (name === locator && confirmed.has(locatorExpiry));
        const result = (name, error) => {
            if (error) errors.set(name, error);
            else { confirmed.add(name); errors.delete(name); }
            this.report(name, error ? error.message || String(error) : 'Confirmed');
        };
        const perform = async (step) => {
            if (resolved(step.name) || unavailable.has(step.unit)) return;
            try { await step.run(); result(step.name); }
            catch (e) { result(step.name, e); }
        };

        if (remaining) {
            const pending = new Set(this.releaseSteps(remaining).map((s) => s.name));
            for (const step of offs) if (!pending.has(step.name)) {
                confirmed.add(step.name);
                this.report(step.name, 'Acknowledged during run or never dispatched');
            }
        }

        const eligibleSavedLocator = () => this.journal.value.version === 2 && this.link.index === P.INDEX
            && this.journal.value.locatorOffRejected !== false;
        if (recovery) {
            const units = new Set(required.filter((s) => !resolved(s.name)).map((s) => s.unit));
            if (units.size) {
                const expected = this.journal.value && this.journal.value.index;
                try { await this.link.identify(expected); this.report('BDC 0x40 identity', 'Confirmed'); }
                catch (e) { return this.releaseFailed(['BDC 0x40 identity: ' + (e.message || e)]); }
            }
            for (const unit of units) {
                if (unit === 'bdc') continue;
                try {
                    if (typeof unit === 'number') await this.link.identifyRlm(unit);
                    else await this.link.identifyFlm(unit);
                } catch (e) {
                    unavailable.add(unit);
                    const name = typeof unit === 'number' ? 'rear light 0x' + unit.toString(16) : unit + ' headlamp';
                    result(name + ' identity', e);
                }
            }
            // The persisted journal records intent. An extended session from a past run may have expired.
            // BDC_G05 locator is timed. After restart we can avoid re-entering extended session for it alone.
            for (const step of defaults) {
                const pendingOffs = offs.filter((off) => off.unit === step.unit && !resolved(off.name));
                if (!pendingOffs.length || unavailable.has(step.unit)) continue;
                if (step.unit === 'bdc' && eligibleSavedLocator()
                    && pendingOffs.every((off) => off.name === locator)) continue;
                const name = step.name.replace('default session', 'extended session for pending OFF');
                confirmed.delete(step.name);
                try {
                    this.journal.checkpoint(confirmed);
                    const why = this.guard.reason();
                    if (why) throw new Error(why);
                    if (step.unit === 'bdc') await this.link.session();
                    else if (typeof step.unit === 'number') await this.link.rlmSession(step.unit);
                    else await this.link.flmSession(step.unit);
                    this.report(name, 'Confirmed');
                } catch (e) {
                    result(name, e);
                    pendingOffs.forEach((off) => attempted.set(off.name, e));
                }
            }
        }
        const waitForLocator = recovery && eligibleSavedLocator() && !resolved(locator)
            && offs.some((s) => s.name === locator)
            && !offs.some((s) => s.unit === 'bdc' && s.name !== locator && !resolved(s.name));
        if (waitForLocator) confirmed.delete('BDC 0x40 default session');
        for (const step of offs) {
            if (resolved(step.name) || (waitForLocator && step.name === locator)) continue;
            if (attempted.has(step.name)) result(step.name, attempted.get(step.name));
            else await perform(step);
        }
        for (const step of comm) await perform(step);
        for (const step of defaults) await perform(step);
        for (const step of comm) {
            if (confirmed.has('FLM ' + step.unit + ' default session') && !confirmed.has(step.name)) result(step.name);
        }

        const refusal = errors.get(locator);
        const rejectedOff = refusal && refusal.address === P.ADDRESS && refusal.sid === 0x2E && refusal.nrc === 0x35;
        if (this.link.index === P.INDEX && (waitForLocator || rejectedOff) && confirmed.has('BDC 0x40 default session')) {
            // D542 is WriteDataByIdentifier with a bounded time field. A default-session reply
            // alone says nothing about its effect. Allow a full app-limited duration after 50 01.
            this.update('STOPPING', 'BDC 0x40 locator: waiting for the bounded control time to elapse');
            await this.sleep(P.MAX_TIMED_MS);
            confirmed.add(locatorExpiry);
            errors.delete(locator);
            this.report(locator, 'Resolved by confirmed default session and elapsed D542 timer; OFF not acknowledged');
        }

        const pending = required.filter((s) => !resolved(s.name));
        const messages = Array.from(errors, ([name, e]) => name + ': ' + (e.message || e));
        for (const step of pending) if (!errors.has(step.name)) messages.push(step.name + ': unconfirmed');
        this.cleanup = { locatorOffRejected: !!rejectedOff, confirmed: Array.from(confirmed), pending: pending.map((s) => s.name), errors: messages };
        try {
            if (pending.length) this.journal.checkpoint(confirmed, rejectedOff ? true : undefined);
            else {
                try { this.journal.clear(); }
                catch (e) { this.journal.checkpoint(confirmed, rejectedOff ? true : undefined); throw e; }
            }
        } catch (e) { messages.push('Recovery file: ' + e.message); }
        if (messages.length) return this.releaseFailed(messages);
        this.report('Recovery', 'All required steps resolved');
        return { ok: true };
    }

    releaseFailed(errors) {
        const message = 'Release not confirmed: ' + errors.join('; ');
        this.lastError = message;
        this.report('Recovery', message);
        this.update('ERROR', message);
        return { ok: false, error: message };
    }

    /** Share one STOP result across the HMI, phone and startup recovery. */
    stop(reason) {
        if (this.stopTask) return this.stopTask;
        let work;
        if (this.run) {
            this.cancel = true;
            this.stopReason = reason || 'STOP pressed';
            const run = this.run;
            work = run.then(() => this.journal.pending()
                ? { ok: false, error: this.note } : { ok: true, message: 'No control left to release' });
            if (this.state !== 'SCANNING') this.update('STOPPING', 'Stopping and verifying release');
        } else if (this.journal.pending()) {
            work = this.exclusive('STOPPING', 'Releasing a previous run', () => this._recover());
        } else {
            work = Promise.resolve({ ok: true, message: 'Nothing to stop' });
        }
        this.stopTask = work.catch((e) => this.releaseFailed([String(e.message || e)])).then((result) => {
            this.lastStop = Object.assign({ at: new Date().toISOString() }, result);
            this.stopTask = null;
            this.changed();
            return this.lastStop;
        });
        return this.stopTask;
    }
    async _recover() {
        const control = this.journal.control();
        if (!control) return this.releaseFailed(['Recovery file unreadable; technical release cannot be verified']);
        const why = this.guard.reason();
        if (why) return this.releaseFailed([why]);
        const result = await this._release(control, null, new Map(), true);
        if (result.ok) {
            this.lastError = null;
            this.update('IDLE', 'Previous run released');
        }
        return result;
    }
}
module.exports = Runner;
