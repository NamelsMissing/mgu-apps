'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./controls');

function fresh() { return { schema: 1, bindings: {}, profiles: {}, dspProfiles: {}, learning: null }; }
function validate(s) {
    if (!s || s.schema !== 1 || !s.bindings || !s.profiles) throw new Error('Unbekanntes Speicherformat.');
    if (!s.dspProfiles) s.dspProfiles = {};
    Object.keys(s.dspProfiles).forEach((slot) => {
        const p = s.dspProfiles[slot];
        if (!/^[123]$/.test(slot) || !p || !p.config || !Array.isArray(p.config.bands) || p.config.bands.length !== 7) throw new Error('Ungültiges DSP-Profil.');
        if (p.name !== undefined && (typeof p.name !== 'string' || !/^[A-Za-z0-9 _-]{1,18}$/.test(p.name) || !p.name.trim()))
            throw new Error('Ungültiger DSP-Profilname.');
    });
    const ids = {};
    Object.keys(s.bindings).forEach((key) => {
        const b = s.bindings[key];
        if (!C.validBinding(b) || b.control !== key || ids[b.id]) throw new Error('Ungültige gespeicherte Zuordnung.');
        ids[b.id] = true;
    });
    Object.keys(s.profiles).forEach((slot) => {
        const p = s.profiles[slot];
        if (!/^[123]$/.test(slot) || !p || !p.values || !p.bindingIds) throw new Error('Ungültiges Profil.');
        Object.keys(p.values).forEach((key) => {
            if (!C.rawValue(p.values[key]) || !C.CONTROLS.some((c) => c.id === key) || typeof p.bindingIds[key] !== 'string') throw new Error('Ungültiger Profilwert.');
        });
    });
    if (s.learning) {
        if (!C.CONTROLS.some((c) => c.id === s.learning.control) || !Array.isArray(s.learning.shots) || s.learning.shots.length > 3) throw new Error('Ungültige Einrichtung.');
        s.learning.shots.forEach(C.index);
    }
    return s;
}
class Storage {
    constructor(dir, log, version) {
        this.file = path.join(dir, 'equalizer-state.json'); this.log = log; this.version = version; this.state = fresh(); this.error = null;
        for (const file of [this.file, this.file + '.bak']) {
            try { this.state = validate(JSON.parse(fs.readFileSync(file, 'utf8'))); return; }
            catch (e) { if (e.code !== 'ENOENT') { this.error = String(e.message || e); log.warn('Equalizer-Speicher: ' + this.error); } }
        }
    }
    save(next) {
        validate(next);
        const temp = this.file + '.tmp';
        try {
            const fd = fs.openSync(temp, 'w', 0o600);
            try { fs.writeFileSync(fd, JSON.stringify(next, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            // The backup is always a validated previous state, even after recovery.
            fs.writeFileSync(this.file + '.bak.tmp', JSON.stringify(this.state, null, 1), { mode: 0o600 });
            fs.renameSync(this.file + '.bak.tmp', this.file + '.bak');
            fs.renameSync(temp, this.file);
            this.state = next; this.error = null;
        } catch (e) { this.error = String(e.message || e); throw new Error('Speichern fehlgeschlagen: ' + this.error); }
    }
    update(fn) { const next = JSON.parse(JSON.stringify(this.state)); fn(next); this.save(next); }
    export(data) {
        const file = path.join(path.dirname(this.file), 'equalizer-diagnostics.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify(Object.assign({ app: 'equalizer', version: this.version, created: new Date().toISOString() }, data), null, 2), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file); return file;
    }
}
module.exports = { Storage, fresh, validate };
