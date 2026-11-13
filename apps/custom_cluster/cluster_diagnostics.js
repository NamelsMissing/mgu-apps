'use strict';
/*
 * Offline diagnostics inspired by the Cluster Layouts QR log workflow.
 * No phone network, remote commands, BMW ECU writes or daemon patching.
 * Multi-page QR codes contain a zlib-compressed diagnostic text; the matching
 * tools/decode_custom_cluster_logs.py reassembles scanned CCLOG1 strings.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const qrcode = require('./qr_vendor');
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

const CHUNK = 280;
const MEDIA_ROOTS = ['/media', '/run/media'];
// These are the only files the app is allowed to delete. USB exports, system
// journals and data from other apps are deliberately outside this scope.
const LOCAL_EXPORT = /^cluster-diagnostics-\d{4}-\d{2}-\d{2}T[\d-]+Z\.txt$/;

// Unlike QR snapshots this log begins at app startup, before any panel test.
// Limit its size and keep it within the app's private data directory.
const SESSION_EXPORT = /^cluster-session-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}\.txt$/;
const MAX_SESSION_BYTES = 1024 * 1024;
function startJournal(ctx) {
    let file = null, bytes = 0, error = '';
    function openNew() {
        file = null;
        error = '';
        bytes = 0;
        try {
            if (!ctx || !ctx.dataDir || !path.isAbsolute(ctx.dataDir)) {
                error = 'No absolute app dataDir supplied by MGU runtime';
                return;
            }
            const dir = path.join(ctx.dataDir, 'exports');
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const st = fs.lstatSync(dir);
            if (!st.isDirectory() || st.isSymbolicLink()) {
                error = 'App export directory is not a regular folder';
                return;
            }
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const suffix = crypto.randomBytes(4).toString('hex');
            const name = 'cluster-session-' + stamp + '-' + suffix + '.txt';
            file = path.join(dir, name);
            const header = 'CUSTOM CLUSTER AUTO SESSION LOG\nCreated: ' +
                new Date().toISOString() + '\nVersion: ' +
                (ctx.spec && ctx.spec.version || 'unknown') + '\n' +
                'This file contains diagnostic events, not proof of visible KOMBI pixels.\n\n';
            fs.writeFileSync(file, header, { flag: 'wx', mode: 0o600 });
            bytes = Buffer.byteLength(header);
        } catch (e) { file = null; error = String(e.code || e.message || e); }
    }
    const journal = {
        get path() { return file; },
        get error() { return error; },
        write(event) {
            if (!file || bytes >= MAX_SESSION_BYTES) {
                if (bytes >= MAX_SESSION_BYTES) error = 'Auto log reached 1 MiB limit';
                return false;
            }
            const line = new Date().toISOString() + ' ' +
                String(event).replace(/[\r\n]+/g, ' ').slice(0, 1800) + '\n';
            try {
                fs.appendFileSync(file, line, 'utf8');
                bytes += Buffer.byteLength(line);
                return true;
            } catch (e) { error = String(e.code || e.message || e); return false; }
        },
        reset() { openNew(); },
    };
    openNew();
    return journal;
}

function snapshot(ctx, cluster, wazeStatus, phoneStatus, hmiEvents) {
    const data = [
        'CUSTOM CLUSTER DIAGNOSTICS v1',
        'Created: ' + new Date().toISOString(),
        'App version: ' + (ctx.spec && ctx.spec.version || 'unknown'),
        'Gear and real vehicle values only (not a measured GPU image).',
        '',
        '=== CLUSTER STATE ===',
        JSON.stringify(cluster.status(), null, 2),
        '',
        '=== WAZE CONTROL ===',
        String(wazeStatus || ''),
        '',
        '=== PHONE EVENT ===',
        String(phoneStatus || ''),
        '',
        '=== HMI NAVIGATION (last 40 events) ===',
        String(hmiEvents || '(no UI events recorded)'),
        '',
        '=== RENDERER SLOT AND LAYER STATUS ===',
        cluster.rendererStatus() || '(no renderer status response yet)',
        '',
        '=== PANEL TEST EVENT HISTORY ===',
        typeof cluster.history === 'function' ? cluster.history() : '(history unavailable)',
    ];
    return data.join('\n') + '\n';
}

function save(ctx, data) {
    const result = [];
    const filename = 'cluster-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
    const tryWrite = (dir) => {
        try {
            fs.writeFileSync(path.join(dir, filename), data, 'utf8');
            result.push(path.join(dir, filename));
        } catch (_) { /* read-only USB or no permission: use the offline QR */ }
    };
    try {
        const directory = path.join(ctx.dataDir, 'exports');
        try { fs.mkdirSync(directory, { recursive: true }); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
        tryWrite(directory);
    } catch (_) { /* QR works without writable storage */ }
    MEDIA_ROOTS.forEach((root) => {
        let names;
        try { names = fs.readdirSync(root); } catch (_) { return; }
        names.forEach((name) => {
            const p = path.join(root, name);
            try {
                if (fs.statSync(p).isDirectory()) tryWrite(p);
            } catch (_) { /* not a writable USB mount */ }
        });
    });
    return result;
}

/** Remove only this app's dated .txt exports inside its private data folder. */
function clearSaved(ctx) {
    const result = { deleted: 0, errors: [], usbPreserved: true };
    if (!ctx || typeof ctx.dataDir !== 'string' || !path.isAbsolute(ctx.dataDir)) {
        result.errors.push('App data directory unavailable');
        return result;
    }
    const directory = path.join(ctx.dataDir, 'exports');
    let entries;
    try {
        const st = fs.lstatSync(directory);
        if (!st.isDirectory() || st.isSymbolicLink()) {
            result.errors.push('Export directory is not a regular directory');
            return result;
        }
        entries = fs.readdirSync(directory);
    } catch (e) {
        if (e.code !== 'ENOENT') result.errors.push('Cannot inspect exports: ' + e.code);
        return result;
    }
    entries.forEach((name) => {
        if (!LOCAL_EXPORT.test(name) && !SESSION_EXPORT.test(name)) return;
        const target = path.join(directory, name);
        try {
            // Never follow links, even if their names match a diagnostic file.
            if (fs.lstatSync(target).isFile()) {
                fs.unlinkSync(target);
                result.deleted++;
            }
        } catch (e) { result.errors.push(name + ': ' + e.code); }
    });
    return result;
}

function report(ctx, cluster, wazeStatus, phoneStatus, hmiEvents) {
    const full = snapshot(ctx, cluster, wazeStatus, phoneStatus, hmiEvents);
    const packed = zlib.deflateSync(Buffer.from(full, 'utf8')).toString('base64');
    const id = crypto.createHash('sha256').update(full).digest('hex').slice(0, 10);
    const count = Math.max(1, Math.ceil(packed.length / CHUNK));
    const pages = [];
    for (let i = 0; i < count; i++)
        pages.push('CCLOG1 ' + id + ' ' + (i + 1) + '/' + count + ' ' + packed.slice(i * CHUNK, (i + 1) * CHUNK));
    return { id, pages, totalBytes: Buffer.byteLength(full, 'utf8'),
        storedAt: save(ctx, full), createdAt: Date.now() };
}

function matrix(content) {
    const qr = qrcode(0, 'M');
    qr.addData(content);
    qr.make();
    return qr;
}

function draw(cv, qr, x, y, maxSize) {
    const n = qr.getModuleCount(), quiet = 4;
    const pixel = Math.floor(maxSize / (n + quiet * 2));
    if (pixel < 2) throw new RangeError('QR modules too dense');
    const side = pixel * (n + quiet * 2);
    const left = x + Math.floor((maxSize - side) / 2);
    const top = y + Math.floor((maxSize - side) / 2);
    cv.fillRect(left, top, side, side, '#ffffff');
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++)
        if (qr.isDark(row, col)) cv.fillRect(left + (col + quiet) * pixel,
            top + (row + quiet) * pixel, pixel, pixel, '#000000');
}

module.exports = { report, matrix, draw, snapshot, save, clearSaved, startJournal };
