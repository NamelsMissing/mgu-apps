'use strict';
const P = require('./protocol');
const Headlamps = require('./headlamps');
const DiagnosticOutputs = require('./diagnostic-outputs');
const F = require('./flm-control');

// One serialized conversation. Stop sets the cancellation flag immediately;
// a possibly accepted in-flight command must finish before stop is sent.
// No interval callback can queue another lamp command behind Stop.
class Engine {
    constructor(o) {
        this.link = o.link; this.guard = o.guard; this.journal = o.journal;
        this.now = o.now || Date.now; this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.changed = o.changed || (() => {}); this.log = o.log;
        this.state = 'IDLE'; this.note = 'Ready'; this.mask = [0, 0];
        this.sent = 0; this.stepMs = 0; this.run = null; this.cancel = false;
        this.releaseConfirmed = false; this.stopRequested = false; this.outputSamples = []; this.originalFault = null;
        this.control = { route: 'digital', lights: null, outputId: null, side: null, channel: null };
        this.stopConfirmed = false; this.headlamps = []; this.cleanup = {};
    }
    status() {
        return { state: this.state, note: this.note, mask: this.mask.slice(), sent: this.sent,
            stepMs: this.stepMs, releaseConfirmed: this.releaseConfirmed, stopConfirmed: this.stopConfirmed,
            control: Object.assign({}, this.control), cleanup: Object.assign({}, this.cleanup),
            remainingSeconds: this.deadline ? Math.max(0, Math.ceil((this.deadline - this.now()) / 1000)) : 0 };
    }
    update(state, note) { this.state = state; this.note = note; this.changed(); }
    async sampleOutputs(label) {
        const read = this.control.route === 'timed' ? this.link.readFunctionStatus : this.link.readOutputs;
        if (!read) return;
        try {
            const reply = await read.call(this.link);
            this.outputSamples.push({ label, reply: P.hex(reply), summary: this.control.route === 'single'
                ? P.singleOutputSummary(reply, this.control.outputId) : P.statusSummary(reply, this.control.lights) });
        }
        catch (e) { this.outputSamples.push({ label, error: String(e.message || e) }); }
        this.changed();
    }
    async acknowledgeNormalLights() {
        if (this.run || this.guard.reason()) throw new Error('Stop show and select P at standstill first');
        let done;
        this.run = new Promise((r) => { done = r; });
        try {
            await this.link.identify();
            if (this.guard.reason()) throw new Error(this.guard.reason());
            await this.link.defaultSession();
            if (this.journal.pending()) this.journal.clear();
            this.releaseConfirmed = false; this.stopConfirmed = false;
            this.update('IDLE', 'Saved stop lock cleared after user light check; physical lamp control remains unverified');
        } catch (e) { this.update('ERROR', String(e.message || e)); }
        finally { this.run = null; done(); }
    }
    async inspectHeadlamps() {
        if (this.run) return this.run;
        const why = this.guard.reason();
        if (why) { this.update('BLOCKED', why); return; }
        let done;
        this.run = new Promise((r) => { done = r; });
        this.update('CHECKING', 'Reading headlamp identities and LED mapping');
        try {
            this.headlamps = await Headlamps.read(this.link);
            this.update(this.journal.pending() ? 'BLOCKED' : 'IDLE', 'Headlamp read complete - see Diagnostics');
        } catch (e) { this.update('ERROR', String(e.message || e)); }
        finally { this.run = null; done(); }
    }
    async identify() {
        if (this.run) return;
        this.update('CHECKING', 'Reading BDC identity');
        let resolve;
        this.run = new Promise((r) => { resolve = r; });
        try {
            await this.link.identify();
            this.update(this.journal.pending() ? 'BLOCKED' : 'IDLE', this.journal.pending()
                ? 'BDC identified; saved stop lock is still pending' : 'BDC_G05 identified; physical lamp effect not verified');
        }
        catch (e) { this.update('ERROR', String(e.message || e)); }
        finally { this.run = null; resolve(); }
    }
    start(config) {
        if (this.run) return this.run;
        // Revalidate at the command boundary, including settings loaded from disk.
        try { config = P.settings((k) => ({ route: config.route, timedPattern: config.pattern,
            pattern: config.pattern, lights: config.lights, tempo: config.tempo, duration: config.seconds })[k]); }
        catch (e) { this.update('ERROR', e.message); return Promise.resolve(); }
        return this._start(config);
    }
    testFunction(lights) {
        try { P.timedControl(lights, 2000); }
        catch (e) { this.update('ERROR', e.message); return Promise.resolve(); }
        return this._start({ route: 'timed', pattern: 'test', lights, tempo: 2000, seconds: 2, test: true });
    }
    testOutput(id) {
        try { DiagnosticOutputs.get(id); }
        catch (e) { this.update('ERROR', e.message); return Promise.resolve(); }
        // One short pulse. There is no continuous ON or adjustable duration.
        return this._start({ route: 'single', outputId: id, seconds: 1, tempo: 750 });
    }
    testFlm(side, channel, pwm = F.DEFAULT_PWM, seconds = F.DEFAULT_SECONDS) {
        try { F.moduleFor(side); F.start(channel, pwm, seconds); }
        catch (e) { this.update('ERROR', e.message); return Promise.resolve(); }
        return this._start({ route: 'flm', side, channel, pwm, seconds, tempo: seconds * 1000 });
    }
    _start(config) {
        const reason = this.guard.reason();
        if (this.run) return this.run;
        if (reason) { this.update('BLOCKED', reason); return Promise.resolve(); }
        if (this.journal.pending()) { this.update('ERROR', 'Saved stop lock pending - use STOP or Diagnostics'); return Promise.resolve(); }
        this.cancel = false; this.stopRequested = false; this.stopReason = null; this.releaseConfirmed = false;
        this.stopConfirmed = false; this.control = { route: config.route || 'digital',
            lights: config.lights || null, outputId: config.route === 'single' ? config.outputId : null,
            side: config.route === 'flm' ? config.side : null,
            channel: config.route === 'flm' ? config.channel : null,
            pwm: config.route === 'flm' ? config.pwm : null,
            seconds: config.route === 'flm' ? config.seconds : null };
        this.sent = 0; this.stepMs = 0; this.mask = [0, 0]; this.outputSamples = []; this.originalFault = null; this.cleanup = {};
        this.update('STARTING', config.route === 'flm' ? 'Checking BDC and FLM02 identity' : 'Checking BDC_G05');
        let resolve;
        this.run = new Promise((r) => { resolve = r; });
        this._play(config).then(() => { this.run = null; resolve(); }, (e) => {
            this.update('ERROR', String(e.message || e)); this.run = null; resolve();
        });
        return this.run;
    }
    allowed() {
        if (this.cancel) return false;
        const why = this.guard.reason();
        if (why) { this.cancel = true; this.stopRequested = true; this.stopReason = why; return false; }
        return true;
    }
    async _play(c) {
        let dirty = false, fault = null;
        try {
            await this.link.identify();
            if (!this.allowed()) return;
            if (c.route === 'flm') { await this.link.identifyFlm(c.side); if (!this.allowed()) return; }
            // A durable marker is written BEFORE any request that can change the
            // session/lamps. If persistence fails, no control request is sent.
            this.journal.mark(this.link.index, this.control); dirty = true;
            if (c.route === 'flm') await this.link.flmSession(c.side);
            else { await this.link.session(); await this.sampleOutputs('Before control'); }
            let afterSampled = false;
            if (!this.allowed()) return;
            if (c.route === 'flm') { await this._flmPulse(c); return; }
            if (c.route === 'timed') { await this._timedLoop(c); return; }
            if (c.route === 'single') { await this._singlePulse(c); return; }
            const pair = P.PAIRS[c.lights], pattern = P.PATTERNS[c.pattern].steps;
            const outputs = [pair.left, pair.right];
            let previous = [null, null], step = 0, keepAt = this.now(), lastStep = null;
            this.deadline = this.now() + c.seconds * 1000;
            this.update('RUNNING', P.PATTERNS[c.pattern].name + ' - ' + pair.name);
            while (this.allowed() && this.now() < this.deadline) {
                const begin = this.now(), mask = pattern[step % pattern.length];
                // Switch old lights off before switching new ones on. Each
                // request requires a matching positive BDC response.
                const order = [0, 1].filter((i) => mask[i] === 0).concat([0, 1].filter((i) => mask[i] === 1));
                for (const i of order) {
                    if (!this.allowed() || this.now() >= this.deadline) break;
                    if (previous[i] !== mask[i]) {
                        await this.link.set(outputs[i], mask[i]); this.sent++;
                        previous[i] = mask[i]; this.mask[i] = mask[i]; this.changed();
                        if (mask[i] === 1 && !afterSampled) { afterSampled = true; await this.sampleOutputs('After first ON, output ' + outputs[i]); }
                    }
                }
                if (!this.allowed() || this.now() >= this.deadline) break;
                if (this.now() - keepAt >= 1000) { await this.link.keepalive(); keepAt = this.now(); }
                if (lastStep !== null) this.stepMs = this.now() - lastStep;
                lastStep = this.now(); step++;
                // Slow round trips slow the pattern. Never catch up by flooding
                // TASU, and never overlap with tester-present or cleanup.
                const wait = Math.max(0, c.tempo - (this.now() - begin));
                for (let slept = 0; slept < wait && !this.cancel; slept += 25) await this.sleep(Math.min(25, wait - slept));
            }
        } catch (e) { fault = String(e.message || e); this.originalFault = fault; }
        finally {
            this.deadline = 0;
            if (dirty) {
                const released = await this._release();
                if (released) this.update(fault ? 'ERROR' : 'IDLE', fault || this.stopReason
                    || (c.route === 'timed' ? 'Timed function stopped; physical effect not verified'
                        : c.route === 'flm' ? 'FLM StopRoutine acknowledged; physical lamp state not verified'
                        : 'BDC IO return acknowledged; physical effect not verified'));
            } else this.update(fault ? 'ERROR' : 'IDLE', fault || this.stopReason || 'Stopped before lamp control');
            this.stopReason = null;
        }
    }
    async _singlePulse(c) {
        const output = DiagnosticOutputs.get(c.outputId);
        if (!this.allowed()) return;
        this.deadline = this.now() + c.tempo;
        this.update('RUNNING', 'Single light: ' + output.label + ' / ' + output.prg);
        await this.link.set(output.id, 1); this.sent++;
        // Deliberately no readback while ON: diagnostic reads could delay OFF.
        for (let elapsed = 0; elapsed < c.tempo && this.allowed(); elapsed += 25) {
            await this.sleep(Math.min(25, c.tempo - elapsed));
        }
        // The finally path always attempts OFF, OEM release and default session.
    }
    async _flmPulse(c) {
        if (!this.allowed()) return;
        this.deadline = this.now() + c.seconds * 1000;
        this.update('RUNNING', 'Experimental ' + c.side + ' FLM02 channel ' + c.channel +
            ' / ' + c.pwm + '% / ' + c.seconds + 's (not verified)');
        await this.link.flmStart(c.side, c.channel, c.pwm, c.seconds); this.sent++;
        // ECU time remains bounded; OEM StopRoutine is requested in finally.
        for (let elapsed = 0; elapsed < c.seconds * 1000 && this.allowed(); elapsed += 25)
            await this.sleep(Math.min(25, c.seconds * 1000 - elapsed));
    }
    async _timedLoop(c) {
        const pat = P.pattern(c), fn = P.FUNCTIONS[c.lights];
        this.deadline = this.now() + c.seconds * 1000;
        let step = 0, keepAt = this.now(), afterSampled = false, lastStep = null;
        this.update('RUNNING', pat.name + ' - ' + fn.name);
        while (this.allowed() && this.now() < this.deadline) {
            const begin = this.now(), on = pat.steps[step % pat.steps.length][0] === 1;
            // Request a finite ECU activation time: normal pulses <= 500 ms,
            // the deliberate single-test button <= 2 s. Physical behavior still
            // requires vehicle verification. Never a permanent duration value.
            const ms = on ? Math.min(c.tempo, Math.floor((this.deadline - begin) / 10) * 10) : 0;
            if (on && ms <= 0) break;
            await this.link.timed(c.lights, ms); this.sent++;
            this.mask = on ? [1, 1] : [0, 0]; this.changed();
            if (on && !afterSampled && this.allowed()) { afterSampled = true; await this.sampleOutputs('After first timed ON'); }
            if (!this.allowed() || this.now() >= this.deadline) break;
            if (this.now() - keepAt >= 1000) { await this.link.keepalive(); keepAt = this.now(); }
            if (lastStep !== null) this.stepMs = this.now() - lastStep;
            lastStep = this.now(); step++;
            const wait = Math.max(0, c.tempo - (this.now() - begin));
            for (let slept = 0; slept < wait && !this.cancel; slept += 25) await this.sleep(Math.min(25, wait - slept));
        }
    }
    stop(reason) {
        this.cancel = true; this.stopRequested = true; this.stopReason = reason || 'Stop requested';
        const wasChecking = this.state === 'CHECKING';
        if (this.run) return this.run.then(() => {
            // identify() may have been running; a recovery marker still needs
            // cleaning even when that operation sent no lamp controls itself.
            if (wasChecking && this.journal.pending()) return this.stop(reason);
        });
        if (!this.journal.pending()) { this.update('IDLE', 'No active lamp override from this app'); return Promise.resolve(); }
        let resolve;
        this.run = new Promise((r) => { resolve = r; });
        this._recover().then(() => { this.run = null; resolve(); }, (e) => {
            this.update('ERROR', String(e.message || e)); this.run = null; resolve();
        });
        return this.run;
    }
    async _recover() {
        try {
            await this.link.identify();
            const saved = this.journal.value;
            if (saved) {
                if (saved.corrupted || (saved.route && ['timed', 'digital', 'single', 'flm'].indexOf(saved.route) < 0)) throw new Error('Invalid recovery record; check normal lights first');
                if (saved.route === 'timed') P.timedControl(saved.lights, 0);
                if (saved.route === 'single') DiagnosticOutputs.get(saved.outputId);
                if (saved.route === 'flm') {
                    F.moduleFor(saved.side); F.channelNumber(saved.channel);
                    await this.link.identifyFlm(saved.side);
                }
                this.control = { route: saved.route || 'digital', lights: saved.lights || null,
                    outputId: saved.route === 'single' ? saved.outputId : null,
                    side: saved.route === 'flm' ? saved.side : null,
                    channel: saved.route === 'flm' ? saved.channel : null,
                    pwm: saved.route === 'flm' ? saved.pwm || null : null,
                    seconds: saved.route === 'flm' ? saved.seconds || null : null };
            }
            if (await this._release()) this.update('IDLE', this.control.route === 'timed' ? 'Timed stop acknowledged' : 'OEM IO return acknowledged');
        } catch (e) { this.update('ERROR', 'Saved stop lock pending: ' + String(e.message || e)); }
    }
    async _release() {
        this.update('STOPPING', 'Sending stop and default-session requests');
        let error = null, released = false, offConfirmed = false, defaultConfirmed = false;
        // Always attempt the session return even if the stop request times out. A positive
        // session reply alone is not presented as proof of physical lamp state.
        if (this.control.route === 'single') {
            try { await this.link.set(this.control.outputId, 0); offConfirmed = true;
                await this.sampleOutputs('After individual OFF (not physical restoration)');
            } catch (e) { error = 'Individual OFF: ' + (e.message || String(e)); }
        }
        try {
            if (this.control.route === 'flm') await this.link.flmStop(this.control.side);
            else if (this.control.route === 'timed') await this.link.timed(this.control.lights, 0);
            else await this.link.release();
            released = true;
        } catch (e) { error = error || e.message || String(e); }
        try {
            if (this.control.route === 'flm') await this.link.flmDefaultSession(this.control.side);
            else await this.link.defaultSession();
            defaultConfirmed = true;
        } catch (e) { error = error || e.message || String(e); }
        this.cleanup = { individualOffAcknowledged: this.control.route === 'single' ? offConfirmed : null,
            oemReleaseAcknowledged: released, defaultSessionAcknowledged: defaultConfirmed,
            releaseError: error ? String(error) : null };
        this.mask = [0, 0]; this.stopConfirmed = released && !error;
        this.releaseConfirmed = this.control.route !== 'timed' && this.control.route !== 'flm' && released && !error;
        if (!error && released) {
            try { this.journal.clear(); } catch (e) { error = 'Could not clear recovery marker: ' + e.message; }
        }
        if (error) { this.update('ERROR', (this.originalFault ? 'Start/show: ' + this.originalFault + ' | ' : '')
            + (this.control.route === 'timed' ? 'Timed stop pending: '
                : this.control.route === 'flm' ? 'FLM StopRoutine pending: ' : 'OEM release pending (NRC22 needs manual normal-lights check): ') + error); return false; }
        return true;
    }
}
module.exports = Engine;
