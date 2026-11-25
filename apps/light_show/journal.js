'use strict';
// Recovery marker. Written BEFORE the first request that can change a session or a lamp and
// removed only after every touched unit acknowledged its stop and default session. If the app
// dies in between, the next start (or STOP) knows exactly what to release.
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const F = require('./flm-control');
const DiagnosticOutputs = require('./diagnostic-outputs');
const R = require('./rlm-control');

function clean(control) {
    const c = control || {};
    const flmSides = Array.from(new Set(c.flmSides || []));
    flmSides.forEach((side) => F.moduleFor(side));
    const fns = Array.from(new Set(c.fns || []));
    fns.forEach((k) => { if (!Object.prototype.hasOwnProperty.call(P.FUNCTIONS, k)) throw new Error('Invalid recovery light function'); });
    const outputs = Array.from(new Set(c.outputs || []));
    outputs.forEach((id) => DiagnosticOutputs.get(id));
    const rlm = (c.rlm || []).map((r) => {
        R.module(r.address);
        if (['fn', 'ch', 'grp'].indexOf(r.kind) < 0) throw new Error('Invalid recovery rear light route');
        const items = Array.from(new Set(r.items || []));
        items.forEach((i) => (r.kind === 'grp' ? R.groupCode(i) : R.telegram(r.kind, i, 0, 60)));
        return { address: r.address, kind: r.kind, items };
    });
    const commOff = Array.from(new Set(c.commOff || []));
    commOff.forEach((side) => { if (flmSides.indexOf(side) < 0) throw new Error('Invalid recovery communication entry'); });
    const bdcSession = !!c.bdcSession || fns.length > 0 || outputs.length > 0;
    if (!flmSides.length && !bdcSession && !rlm.length) throw new Error('Nothing to recover');
    return { flmSides, fns, outputs, bdcSession, rlm, commOff };
}

/** Light Show 0.3.x markers -> the 0.4 form. */
function migrate(v) {
    if (!v || typeof v !== 'object' || v.corrupted) return null;
    if (v.version === 2) return P.bodyVariant(v.index) ? v : null;
    if (v.version !== undefined && v.version !== 1) return null;
    const r = v.route || 'digital';
    if (r === 'flm') return { flmSides: [v.side] };
    if (r === 'flm_show') return { flmSides: Array.isArray(v.sides) ? v.sides : [] };
    if (r === 'timed') return { fns: [v.lights], bdcSession: true };
    if (r === 'single') return { outputs: [v.outputId], bdcSession: true };
    if (r === 'digital' && P.PAIRS[v.lights]) return { outputs: [P.PAIRS[v.lights].left, P.PAIRS[v.lights].right], bdcSession: true };
    return null;
}

class Journal {
    constructor(dir) {
        this.file = path.join(dir, 'light-show-recovery.json'); this.value = null;
        try { this.value = JSON.parse(fs.readFileSync(this.file, 'utf8')) || { corrupted: true }; }
        catch (e) { if (e.code !== 'ENOENT') this.value = { corrupted: true }; }
    }
    pending() { return !!this.value; }
    /** What must be released, or null when the marker cannot be read. */
    control() {
        try { const m = migrate(this.value); return m ? clean(m) : null; }
        catch (_) { return null; }
    }
    mark(index, control) {
        if (!P.bodyVariant(index)) throw new Error('Supported body controller identity required');
        const value = Object.assign({ version: 2, index, at: new Date().toISOString(), locatorOffRejected: false }, clean(control));
        this.write(value);
    }
    confirmed() {
        const steps = this.value && this.value.confirmed;
        return new Set(Array.isArray(steps) ? steps : []);
    }
    checkpoint(steps, locatorOffRejected = this.value && this.value.locatorOffRejected) {
        const control = this.control();
        if (!control) throw new Error('Recovery marker cannot be updated');
        this.write(Object.assign({}, this.value, { confirmed: Array.from(steps), locatorOffRejected }));
    }
    write(value) {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(value));
        fs.renameSync(this.file + '.tmp', this.file); this.value = value;
    }
    clear() {
        try { fs.unlinkSync(this.file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        this.value = null;
    }
}
module.exports = Journal;
module.exports.migrate = migrate;
module.exports.clean = clean;
