'use strict';

// Everything GameStation keeps on disk, in the app's own data folder:
//   roms/<console>/<file>         games imported from a phone
//   saves/<console>/<file>.sav    battery RAM (in-game saves) per game
//   gamestation-state.json        the last game played (for "Continue")
// Node 8: no recursive mkdir, no fs.promises. Writes go to a temp file first.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {consoles: CONSOLES, extensions: EXTENSIONS, MAX_ROM, maxRom, byId, validRom} = require('./core_registry');

const MAX_STATE = 24 * 1024;
const MAX_SAVE = 256 * 1024;

function mkdir(p) { try { fs.mkdirSync(p); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
/** A file name that is safe on the head unit's file system (no folders, no hidden files). */
function safeName(name) {
    return String(name || '').replace(/[^a-zA-Z0-9_. ()\-[\]!&',+]/g, '_').replace(/^[.\s]+/, '').slice(0, 90).trim();
}
/** A stored file name: no folders, not hidden (older versions kept names a little differently). */
function plain(name) {
    name = String(name || '');
    return !!name && name.length <= 120 && !/[\/\\\0]/.test(name) && name[0] !== '.';
}
function allowed(kind, name) {
    return !!EXTENSIONS[kind] && EXTENSIONS[kind].some(ext => String(name).toLowerCase().endsWith(ext));
}
/** Title shown for a ROM file: no extension, underscores as spaces. */
function title(name) {
    return String(name).replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || String(name);
}
function writeAtomic(file, data, createOnly) {
    const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
        fs.writeFileSync(tmp, data, {flag: 'wx', mode: 0o600});
        if (createOnly) fs.linkSync(tmp, file);
        else fs.renameSync(tmp, file);
    } finally {
        try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
}

function checkDisc(file, name) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (stat.isFile() && stat.size <= maxRom('ps1')) {
            const header = Buffer.alloc(16);
            if (name.toLowerCase().endsWith('.chd')) {
                if (fs.readSync(fd, header, 0, 16, 0) === 16 &&
                    header.toString('ascii', 0, 8) === 'MComprHD' &&
                    header.readUInt32BE(8) === 124 && header.readUInt32BE(12) === 5 && stat.size > 124) return;
            } else if (stat.size % 2048 === 0 && fs.readSync(fd, header, 0, 7, 16 * 2048) === 7 &&
                header.toString('ascii', 1, 6) === 'CD001' && header[6] === 1) return;
        }
        const error = new Error('Use a PlayStation CHD v5 or a 2048-byte-sector ISO image.');
        error.code = 'INVALID_DISC';
        throw error;
    } finally {
        fs.closeSync(fd);
    }
}

class Library {
    constructor(dataDir) {
        this.dir = dataDir;
        this.stateFile = path.join(dataDir, 'gamestation-state.json');
        this.state = this.readState();
    }
    romDir(kind) { return path.join(this.dir, 'roms', kind); }
    saveFile(kind, name) { return path.join(this.dir, 'saves', kind, safeName(name) + '.sav'); }

    /** Games of one console, sorted by title: [{kind, name, title, size, saved}]. */
    list(kind) {
        if (!EXTENSIONS[kind]) return [];
        let names = [];
        try { names = fs.readdirSync(this.romDir(kind)); } catch (_) { return []; }
        return names.filter(n => allowed(kind, n) && plain(n)).map(name => {
            let size = 0, saved = false;
            try {
                const stat = fs.lstatSync(path.join(this.romDir(kind), name));
                if (!stat.isFile() || stat.size > maxRom(kind)) return null;
                size = stat.size;
            } catch (_) { return null; }
            try { saved = fs.statSync(this.saveFile(kind, name)).size > 0; } catch (_) { saved = false; }
            return {kind, name, title: title(name), size, saved};
        }).filter(Boolean).sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    }
    counts() {
        const out = {};
        CONSOLES.forEach(k => { out[k] = this.list(k).length; });
        return out;
    }
    has(kind, name) {
        if (!allowed(kind, name) || !plain(name)) return false;
        try {
            const stat = fs.lstatSync(path.join(this.romDir(kind), name));
            return stat.isFile() && stat.size <= maxRom(kind);
        } catch (_) { return false; }
    }
    read(kind, name) {
        if (!this.has(kind, name)) throw new Error('Game not found');
        const file = path.resolve(this.romDir(kind), name);
        if (byId[kind].disc) {
            checkDisc(file, name);
            return file;
        }
        const bytes = fs.readFileSync(file);
        if (!validRom(kind, name, bytes)) throw new Error('Invalid ROM file');
        return bytes;
    }
    /** Store an imported ROM. replace: overwrite a file of the same name. Returns the stored name. */
    add(kind, name, bytes, replace) {
        const clean = safeName(name);
        if (!clean || !allowed(kind, clean)) throw new Error('Unsupported file name');
        if (!validRom(kind, clean, bytes)) throw new Error('Invalid ROM file');
        mkdir(path.join(this.dir, 'roms')); mkdir(this.romDir(kind));
        const file = path.join(this.romDir(kind), clean);
        writeAtomic(file, bytes, !replace);
        return clean;
    }
    /** Stream a single-file disc to a private temporary file in its destination directory. */
    stageDisc(kind, name, replace) {
        if (!byId[kind] || !byId[kind].disc || !plain(name) || !allowed(kind, name))
            throw new Error('Unsupported disc image name');
        mkdir(path.join(this.dir, 'roms'));
        mkdir(this.romDir(kind));
        const file = path.join(this.romDir(kind), name);
        const tmp = path.join(this.romDir(kind), '.upload-' + crypto.randomBytes(12).toString('hex'));
        const fd = fs.openSync(tmp, 'wx', 0o600);
        const stream = fs.createWriteStream(tmp, {fd});
        return {
            stream,
            publish() {
                checkDisc(tmp, name);
                if (replace) fs.renameSync(tmp, file);
                else fs.linkSync(tmp, file);
            },
            discard() {
                stream.destroy();
                try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            }
        };
    }
    /** Delete a ROM while keeping battery RAM and states. Returns false when it did not exist. */
    remove(kind, name) {
        if (!this.has(kind, name)) return false;
        fs.unlinkSync(path.join(this.romDir(kind), name));
        if (this.state.last && this.state.last.kind === kind && this.state.last.name === name) {
            this.state.last = null; this.writeState();
        }
        return true;
    }

    /* ---------------- battery saves ---------------- */
    loadSave(kind, name) {
        try {
            const bytes = fs.readFileSync(this.saveFile(kind, name));
            return bytes.length && bytes.length <= MAX_SAVE ? bytes : null;
        } catch (_) { return null; }
    }
    /** Write a save when it differs from what is on disk. Returns true when written. */
    store(kind, name, bytes) {
        if (!bytes || !bytes.length || bytes.length > MAX_SAVE || !allowed(kind, name)) return false;
        const old = this.loadSave(kind, name);
        if (old && old.equals(bytes)) return false;
        mkdir(path.join(this.dir, 'saves')); mkdir(path.join(this.dir, 'saves', kind));
        writeAtomic(this.saveFile(kind, name), bytes);
        return true;
    }

    statePath(kind, hash, slot) {
        if (!byId[kind] || !byId[kind].states || !/^[0-9a-f]{64}$/.test(hash) || ![1, 2, 3].includes(slot))
            throw new Error('Invalid save slot');
        return path.join(this.dir, 'states', kind, hash + '.' + slot + '.json');
    }
    storeState(kind, hash, slot, state) {
        const file = this.statePath(kind, hash, slot);
        const checksum = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
        const data = JSON.stringify({version: 1, kind, hash, checksum, state});
        if (Buffer.byteLength(data) > MAX_STATE) throw new Error('Save state too large');
        mkdir(path.join(this.dir, 'states')); mkdir(path.dirname(file));
        writeAtomic(file, data);
    }
    loadState(kind, hash, slot) {
        const file = this.statePath(kind, hash, slot);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_STATE) throw new Error('Invalid save state file');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data || data.version !== 1 || data.kind !== kind || data.hash !== hash || !data.state)
            throw new Error('Incompatible save state');
        if (data.checksum !== crypto.createHash('sha256').update(JSON.stringify(data.state)).digest('hex'))
            throw new Error('Save state checksum mismatch');
        return data.state;
    }

    /* ---------------- last game ---------------- */
    readState() {
        try {
            const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
            return s && typeof s === 'object' ? s : {};
        } catch (_) { return {}; }
    }
    writeState() {
        try { writeAtomic(this.stateFile, JSON.stringify(this.state)); } catch (_) { /* best effort */ }
    }
    remember(kind, name) {
        this.state.last = {kind, name, at: Date.now()};
        this.writeState();
    }
    /** The last game, if it still exists: {kind, name, title} or null. Arcade counts too. */
    last() {
        const l = this.state.last;
        if (!l) return null;
        if (l.kind === 'arcade') return {kind: 'arcade', name: 'pong', title: 'Pong'};
        return this.has(l.kind, l.name) ? {kind: l.kind, name: l.name, title: title(l.name)} : null;
    }
}

module.exports = {Library, CONSOLES, EXTENSIONS, MAX_ROM, safeName, allowed, title};
