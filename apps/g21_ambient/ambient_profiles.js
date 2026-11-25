'use strict';

const KEY = 'ambientProfilesV1';
const MODES = ['sport', 'comfort', 'eco', 'adaptive'];

function cleanSnapshot(value) {
    const main = value && value.main;
    if (!main || !Array.isArray(main.rgb) || main.rgb.length !== 3) return null;
    const rgb = Array.from(main.rgb);
    if (rgb.some(n => !Number.isInteger(n) || n < 0 || n > 254)) return null;
    const brightness = Number.isFinite(main.brightness)
        ? Math.max(0, Math.min(100, Math.round(main.brightness))) : 50;
    return { main: { rgb, brightness, on: main.on === 0 ? 0 : 1 } };
}

function modeFromSignal(value) {
    const raw = value && value.actualValueModeDrivingExperience;
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const name = String(raw).trim().toUpperCase(), code = Number(name);
    if (name.indexOf('SPORT') >= 0 || name.indexOf('BOOST') >= 0 || [1, 2, 3, 15, 16, 23, 28].includes(code)) return 'sport';
    if (name.indexOf('ECO') >= 0 || [7, 8, 9].includes(code)) return 'eco';
    if (name.indexOf('ADAPT') >= 0 || code === 10) return 'adaptive';
    if (name.indexOf('COMFORT') >= 0 || [4, 5, 6].includes(code)) return 'comfort';
    return null;
}

class AmbientProfiles {
    constructor(settings) {
        this.settings = settings;
        this.data = { favorites: Array(6).fill(null), modes: {}, follow: false };
        try {
            const old = JSON.parse(settings.get(KEY) || '{}');
            if (!old || typeof old !== 'object' || Array.isArray(old)) return;
            if (Array.isArray(old.favorites)) {
                this.data.favorites = this.data.favorites.map((_, i) => cleanSnapshot(old.favorites[i]));
            }
            if (old.modes && typeof old.modes === 'object') {
                MODES.forEach(mode => {
                    const look = cleanSnapshot(old.modes[mode]);
                    if (look) this.data.modes[mode] = look;
                });
            }
            this.data.follow = old.follow === true;
        } catch (_) { /* Use empty profiles if the saved JSON is unreadable. */ }
    }
    save() { this.settings.set(KEY, JSON.stringify(this.data)); }
    snapshot(color, brightness) {
        const clean = cleanSnapshot({ main: { rgb: color.rgb, on: color.on, brightness } });
        if (!clean) throw new TypeError('invalid active colours');
        return clean;
    }
    saveFavorite(index, snapshot) {
        if (!Number.isInteger(index) || index < 0 || index >= 6) throw new RangeError('favorite index');
        const clean = cleanSnapshot(snapshot);
        if (!clean) throw new TypeError('invalid snapshot');
        this.data.favorites[index] = clean;
        this.save();
    }
    loadFavorite(index) { return cleanSnapshot(this.data.favorites[index]); }
    clearFavorite(index) {
        if (!Number.isInteger(index) || index < 0 || index >= 6) throw new RangeError('favorite index');
        this.data.favorites[index] = null;
        this.save();
    }
    saveMode(mode, snapshot) {
        if (!MODES.includes(mode)) throw new RangeError('unknown mode');
        const clean = cleanSnapshot(snapshot);
        if (!clean) throw new TypeError('invalid snapshot');
        this.data.modes[mode] = clean;
        this.save();
    }
    clearMode(mode) {
        if (!MODES.includes(mode)) throw new RangeError('unknown mode');
        delete this.data.modes[mode];
        this.save();
    }
    mode(mode) { return MODES.includes(mode) ? cleanSnapshot(this.data.modes[mode]) : null; }
    toggleFollow() { this.data.follow = !this.data.follow; this.save(); return this.data.follow; }
}

module.exports = { AmbientProfiles, MODES, KEY, cleanSnapshot, modeFromSignal };
