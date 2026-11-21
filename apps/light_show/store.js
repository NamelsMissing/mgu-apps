'use strict';
// The app's own files: lamp names and test observations. Both stay in the app data folder;
// nothing is coded into a control unit. Older Light Show files (0.3.x) are read and converted.
const fs = require('fs');
const path = require('path');
const Lamps = require('./lamps');

const PRESETS = Object.freeze(['Low beam', 'High beam', 'Daytime light', 'Position light', 'Indicator',
    'Cornering light', 'Accent light', 'Laser', 'LED element']);
const RESULTS = Object.freeze({
    visible: 'visible, no unusual noise',
    noise: 'visible and unusual noise',
    none: 'no visible effect, no noise',
    silentNoise: 'unusual noise without visible light',
});

function writeAtomic(file, value) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 1));
    fs.renameSync(file + '.tmp', file);
}
function safeName(str) {
    if (typeof str !== 'string') throw new Error('Name must be text');
    const value = str.trim().replace(/\s+/g, ' ');
    if (!value || value.length > 24 || !/^[a-zA-Z0-9ÄÖÜäöüß _-]+$/.test(value))
        throw new Error('Name must be 1-24 letters, digits, spaces or hyphens');
    return value;
}
/** 'left:3' (0.3.x) -> 'flm:left:3'; new ids pass through when valid. */
function migrateKey(k) {
    const m = /^(left|right):([1-9]|1[0-5])$/.exec(k);
    if (m) return Lamps.flmId(m[1], Number(m[2]));
    return Lamps.parse(k) ? k : null;
}

class Names {
    constructor(dir) {
        this.file = path.join(dir, 'light-show-channel-names.json');
        this.map = {};
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const entries = saved && saved.names;
            if (entries && typeof entries === 'object' && !Array.isArray(entries))
                Object.keys(entries).forEach((k) => {
                    const id = migrateKey(k);
                    if (!id) return;
                    try { this.map[id] = safeName(entries[k]); } catch (_) { /* skip invalid */ }
                });
        } catch (e) { if (e.code !== 'ENOENT') this.loadError = String(e.message || e); }
    }
    name(id) { return this.map[id] || ''; }
    set(id, name) {
        if (!Lamps.parse(id)) throw new Error('Unknown lamp');
        const next = Object.assign({}, this.map);
        if (name === '' || name === null) delete next[id];
        else next[id] = safeName(name);
        writeAtomic(this.file, { version: 2, names: next });
        this.map = next;
    }
    /** Cycle through the preset names (for the car screen, which has no keyboard). */
    cycle(id) {
        const now = this.name(id), i = PRESETS.indexOf(now);
        this.set(id, i === PRESETS.length - 1 ? '' : PRESETS[i + 1]);
        return this.name(id);
    }
}

class Observations {
    constructor(dir, log) {
        this.file = path.join(dir, 'light-show-observations.json');
        this.list = [];
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (Array.isArray(raw)) this.list = raw.filter((x) => x && typeof x === 'object').map(Observations.migrate).filter(Boolean).slice(-300);
        } catch (e) { if (e.code !== 'ENOENT' && log) log.warn('Observation read: ' + e.message); }
    }
    static migrate(x) {
        if (x.lamp && Lamps.parse(x.lamp)) return x;
        if (x.route === 'flm' && (x.side === 'left' || x.side === 'right') && Number.isInteger(x.channel))
            return Object.assign({}, x, { lamp: Lamps.flmId(x.side, x.channel) });
        if (x.route === 'single' && Number.isInteger(x.outputId) && Lamps.parse('out:' + x.outputId))
            return Object.assign({}, x, { lamp: 'out:' + x.outputId });
        return null;
    }
    record(lamp, resultKey, cleanupConfirmed, extra) {
        if (!Lamps.parse(lamp)) throw new Error('Unknown lamp');
        if (!Object.prototype.hasOwnProperty.call(RESULTS, resultKey)) throw new Error('Unknown observation');
        const row = Object.assign({ at: new Date().toISOString(), lamp, result: RESULTS[resultKey],
            cleanupConfirmed: cleanupConfirmed === true }, extra || {});
        const next = this.list.concat([row]).slice(-300);
        writeAtomic(this.file, next);
        this.list = next;
        return row;
    }
    /** visible | noise | not-visible | untested (a noise report always wins). */
    status(lamp, moduleIndex) {
        const rows = this.list.filter((x) => x.lamp === lamp && (!moduleIndex || !x.moduleIndex || x.moduleIndex === moduleIndex));
        if (rows.some((x) => x.result === RESULTS.noise || x.result === RESULTS.silentNoise)) return 'noise';
        for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            if (row.result === RESULTS.none) return 'not-visible';
            if (row.result === RESULTS.visible && row.cleanupConfirmed === true) return 'visible';
        }
        return 'untested';
    }
    /** Only lamps confirmed visible without noise may take part in a show. */
    allowed(lamp) { return this.status(lamp) === 'visible'; }
    forget(lamp) {
        const next = this.list.filter((x) => x.lamp !== lamp);
        writeAtomic(this.file, next);
        this.list = next;
    }
}

function statusText(s) {
    return { visible: 'Ready for shows', noise: 'Excluded (noise)', 'not-visible': 'No visible effect', untested: 'Not tested' }[s] || s;
}

module.exports = { Names, Observations, PRESETS, RESULTS, safeName, statusText, migrateKey };
