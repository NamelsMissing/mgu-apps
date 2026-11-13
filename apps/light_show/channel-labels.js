'use strict';
// User-assigned lamp names live only in this app's writable data directory.
// Observed physical responses, not merely ECU ACKs, gate animation eligibility.
const fs = require('fs');
const path = require('path');
const PRESETS = Object.freeze(['Abblendlicht', 'Fernlicht', 'Tagfahrlicht',
    'Positionslicht', 'Blinker', 'Kurvenlicht', 'Akzentlicht', 'LED-Element']);
function key(side, channel) {
    if (['left', 'right'].indexOf(side) < 0 || !Number.isInteger(channel) || channel < 1 || channel > 15)
        throw new Error('Invalid FLM side/channel');
    return side + ':' + channel;
}
function safeName(str) {
    if (typeof str !== 'string') throw new Error('Name must be text');
    const value = str.trim().replace(/\s+/g, ' ');
    if (!value || value.length > 24 || !/^[a-zA-Z0-9ÄÖÜäöüß _-]+$/.test(value))
        throw new Error('Name must be 1-24 letters, digits, spaces or hyphens');
    return value;
}
function evidence(observations, side, channel) {
    const k = key(side, channel);
    const rows = (Array.isArray(observations) ? observations : []).filter((x) =>
        x && x.route === 'flm' && x.side + ':' + x.channel === k);
    const noise = rows.some((x) => x.result === 'unusual noise without visible light'
        || x.result === 'visible and unusual noise');
    if (noise) return 'noise';
    if (rows.some((x) => x.result === 'visible, no unusual noise' && x.cleanupConfirmed === true))
        return 'visible';
    return rows.some((x) => x.result === 'no visible effect, no noise') ? 'not-visible' : 'untested';
}
class ChannelLabels {
    constructor(dir) {
        this.file = path.join(dir, 'light-show-channel-names.json');
        this.map = {};
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const entries = saved && saved.names;
            if (entries && typeof entries === 'object' && !Array.isArray(entries))
                Object.keys(entries).forEach((k) => {
                    if (!/^(left|right):([1-9]|1[0-5])$/.test(k)) return;
                    try { this.map[k] = safeName(entries[k]); } catch (_) {}
                });
        } catch (e) { if (e.code !== 'ENOENT') this.loadError = String(e.message || e); }
    }
    label(side, channel) {
        return this.map[key(side, channel)] || (side === 'left' ? 'Links ' : 'Rechts ') + 'LED ' + channel;
    }
    name(side, channel) { return this.map[key(side, channel)] || ''; }
    set(side, channel, name) {
        const k = key(side, channel), next = Object.assign({}, this.map);
        if (name === '') delete next[k];
        else next[k] = safeName(name);
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, names: next }, null, 2));
        fs.renameSync(tmp, this.file);
        this.map = next;
    }
    status(observations, side, channel) { return evidence(observations, side, channel); }
    allowed(observations, side, channel) { return this.status(observations, side, channel) === 'visible'; }
    eligible(observations, side) {
        const ret = [];
        for (let c = 1; c <= 15; c++) if (this.allowed(observations, side, c)) ret.push(c);
        return ret;
    }
    snapshot(observations) {
        const ret = [];
        for (const side of ['left','right'])
            for (let c = 1; c <= 15; c++)
                ret.push({ side, channel: c, label: this.label(side,c),
                    status: this.status(observations,side,c), animationEligible: this.allowed(observations,side,c) });
        return ret;
    }
}
module.exports = { ChannelLabels, PRESETS, key, safeName, evidence };
