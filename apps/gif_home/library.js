'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decode, LIMIT } = require('./gif');

const MODES = ['single', 'selected', 'group', 'sequential', 'all'];
const ID = /^[a-f0-9]{32}$/;
const MIGRATION_ID = '00000000000000000000000000000000';
const newId = () => crypto.randomBytes(16).toString('hex');
const MAX_FILES = 64;
const QUOTA = 96 * 1024 * 1024;
const copy = value => JSON.parse(JSON.stringify(value));

function atomic(file, data) {
    const tmp = file + '.' + newId() + '.tmp';
    try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
        // Some OAP filesystems reject directory fsync. The file is already
        // published after rename, so an unsupported directory flush must
        // never be mistaken for a failed transaction.
        try {
            const dir = fs.openSync(path.dirname(file), 'r');
            try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        } catch (_) {}
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

function name(value, gif) {
    const clean = String(value || '').replace(/[\/\\<>:"|?*\u0000-\u001f\u007f]/g, '_').trim().slice(0, 100);
    if (!clean) throw new Error('A name is required');
    return gif && !/\.gif$/i.test(clean) ? clean + '.gif' : clean;
}

function validate(s, presets) {
    const ids = new Set(presets);
    const validIds = list => Array.isArray(list) && list.every(id => ids.has(id)) &&
        new Set(list).size === list.length;
    const positive = v => Number.isSafeInteger(v) && v > 0;
    if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
        !Array.isArray(s.files) || s.files.length > MAX_FILES || !Array.isArray(s.groups) || s.groups.length > MAX_FILES) return false;
    for (const f of s.files) {
        if (!f || !ID.test(f.id) || ids.has(f.id) || typeof f.name !== 'string' || !f.name || f.name.length > 104 ||
            !positive(f.bytes) || f.bytes > LIMIT.bytes || !positive(f.width) || f.width > LIMIT.width ||
            !positive(f.height) || f.height > LIMIT.height || !positive(f.frames) || f.frames > LIMIT.frames ||
            !positive(f.duration)) return false;
        ids.add(f.id);
    }
    const groups = new Set();
    for (const g of s.groups) {
        if (!g || !ID.test(g.id) || groups.has(g.id) || typeof g.name !== 'string' ||
            !g.name || g.name.length > 100 || !validIds(g.ids)) return false;
        groups.add(g.id);
    }
    const p = s.playback;
    return s.files.reduce((sum, f) => sum + f.bytes, 0) <= QUOTA && p && MODES.includes(p.mode) &&
        validIds(p.selected) && ids.has(p.single) && (p.group === null || groups.has(p.group)) &&
        Number.isInteger(p.seconds) && p.seconds >= 0 && p.seconds <= 3600 && typeof p.paused === 'boolean';
}

class Library {
    constructor(dir, presets, legacy, report) {
        this.dir = path.join(dir, 'gifs');
        this.file = path.join(dir, 'library.json');
        this.presets = presets;
        this.report = report;
        this.error = '';
        this.state = { version: 1, revision: 0, files: [], groups: [],
            playback: { mode: 'single', selected: [], single: presets.includes(legacy.source) ? legacy.source : presets[0],
                group: null, seconds: 0, paused: !!legacy.paused } };
        try {
            if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { mode: 0o700 });
            if (fs.existsSync(this.file)) {
                if (fs.statSync(this.file).size > 256 * 1024) throw new Error('Metadata exceeds limit');
                const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                if (!validate(saved, presets)) throw new Error('Invalid metadata');
                this.state = saved;
            } else {
                if (fs.readdirSync(this.dir).some(file => /^[a-f0-9]{32}\.gif$/.test(file) &&
                    file !== MIGRATION_ID + '.gif'))
                    throw new Error('Missing metadata for existing GIFs');
                const old = path.join(dir, 'custom.gif');
                if (fs.existsSync(old)) {
                    if (fs.statSync(old).size <= LIMIT.bytes) {
                        try {
                            this.add(fs.readFileSync(old), 'custom.gif', ['custom', 'auto', undefined].includes(legacy.source), MIGRATION_ID);
                            report('Migrated custom.gif');
                        } catch (e) {
                            if (e.code) throw e;
                            report('Legacy GIF rejected: ' + e.message);
                        }
                    } else report('Legacy GIF exceeds size limit');
                }
                if (!fs.existsSync(this.file)) this.commit(copy(this.state));
            }
            // Unreferenced blobs are left only by an interrupted transaction.
            const kept = new Set(this.state.files.map(f => f.id + '.gif'));
            fs.readdirSync(this.dir).forEach(file => {
                if (/^[a-f0-9]{32}\.gif(?:\.[a-f0-9]{32}\.tmp)?$/.test(file) && !kept.has(file)) {
                    try { fs.unlinkSync(path.join(this.dir, file)); }
                    catch (_) { report('Could not remove an orphaned GIF'); }
                }
            });
        } catch (_) {
            this.error = 'Library storage or metadata unreadable. Existing data preserved. Restore library.json before editing.';
            report(this.error);
        }
    }

    fileFor(id) {
        if (typeof id !== 'string' || !ID.test(id)) throw new Error('Unknown GIF');
        return path.join(this.dir, id + '.gif');
    }

    read(id) {
        const entry = this.state.files.find(f => f.id === id);
        if (!entry) throw new Error('Unknown GIF');
        const file = this.fileFor(id), stat = fs.statSync(file);
        if (!stat.isFile() || stat.size !== entry.bytes) throw new Error('GIF file size changed');
        return fs.readFileSync(file);
    }

    commit(next) {
        if (this.error) throw new Error(this.error);
        if (!validate(next, this.presets)) throw new Error('Invalid library or playback settings');
        next.revision++;
        atomic(this.file, JSON.stringify(next));
        this.state = next;
    }

    add(bytes, filename, activate, migratedId) {
        if (this.error) throw new Error(this.error);
        const next = copy(this.state);
        if (next.files.length >= MAX_FILES || next.files.reduce((sum, f) => sum + f.bytes, bytes.length) > QUOTA)
            throw new Error('Library limit reached (64 GIFs or 96 MiB)');
        const label = name(filename || 'Animation.gif', true);
        const gif = decode(bytes);
        const id = migratedId || newId();
        next.files.push({ id, name: label, bytes: bytes.length, width: gif.width, height: gif.height,
            frames: gif.frames.length, duration: gif.duration });
        if (activate) next.playback.single = id;
        const file = this.fileFor(id);
        atomic(file, bytes);
        try { this.commit(next); }
        catch (e) { try { fs.unlinkSync(file); } catch (_) {} throw e; }
        this.report('Upload validated and stored: ' + id + ' (' + bytes.length + ' bytes)');
        return id;
    }

    change(action, checkRevision) {
        if (!action || typeof action !== 'object') throw new Error('Invalid action');
        if (checkRevision && action.revision !== this.state.revision) {
            const error = new Error('Library changed. Refresh and retry.');
            error.status = 409;
            throw error;
        }
        const next = copy(this.state), p = next.playback;
        const file = next.files.find(f => f.id === action.id);
        const group = next.groups.find(g => g.id === action.id);
        let deleted = [];
        switch (action.type) {
        case 'rename':
            if (!file) throw new Error('Unknown GIF');
            file.name = name(action.name, true);
            break;
        case 'delete':
            if (action.confirm !== true || !Array.isArray(action.ids) || !action.ids.length ||
                !action.ids.every(id => next.files.some(f => f.id === id))) throw new Error('Confirm deletion of uploaded GIFs');
            deleted = Array.from(new Set(action.ids));
            next.files = next.files.filter(f => !deleted.includes(f.id));
            next.groups.forEach(g => { g.ids = g.ids.filter(id => !deleted.includes(id)); });
            p.selected = p.selected.filter(id => !deleted.includes(id));
            if (deleted.includes(p.single)) p.single = next.files.length ? next.files[0].id : this.presets[0];
            break;
        case 'createGroup':
            next.groups.push({ id: newId(), name: name(action.name), ids: [] });
            break;
        case 'renameGroup':
            if (!group) throw new Error('Unknown group');
            group.name = name(action.name);
            break;
        case 'deleteGroup':
            if (!group || action.confirm !== true) throw new Error('Confirm group deletion');
            next.groups = next.groups.filter(g => g !== group);
            if (p.group === group.id) p.group = null;
            break;
        case 'members':
            if (!group || !Array.isArray(action.ids) || typeof action.add !== 'boolean') throw new Error('Invalid group membership');
            group.ids = action.add ? Array.from(new Set(group.ids.concat(action.ids))) :
                group.ids.filter(id => !action.ids.includes(id));
            break;
        case 'activate':
            p.single = action.id;
            p.mode = 'single';
            break;
        case 'playback':
            ['mode', 'single', 'group', 'seconds', 'paused', 'selected'].forEach(key => {
                if (Object.prototype.hasOwnProperty.call(action, key)) p[key] = action[key];
            });
            break;
        default: throw new Error('Unknown action');
        }
        this.commit(next);
        deleted.forEach(id => {
            try { fs.unlinkSync(this.fileFor(id)); }
            catch (e) { if (e.code !== 'ENOENT') this.report('GIF file cleanup pending: ' + id); }
        });
        this.report('Library change: ' + action.type);
    }
}

module.exports = { Library, MODES, atomic };
