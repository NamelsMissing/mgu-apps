'use strict';

const fs = require('fs');
const path = require('path');

const RAW_FILE_TAIL_BYTES = 64000;
const WARNING_RE = /SDK_(?:DEBUG|ERROR|WARN)|UNHANDLED REJECTION|\b(?:ERROR|FATAL)\b/i;
const isSdkDebug = message => /\bUSSO\b|UserManager|TokenImpl|AnalyticsService|APP_(?:START|MEMORY|CPU) discarded/i.test(message);
const IMPORTANT_RE = /REJECT|ERROR|BLOCK|FAILED|UNCONFIRMED|BUSY|VEHICLE ON|PROCESS START|UI OPEN/i;

function readTail(filename, maxBytes) {
    let fd;
    try {
        const stat = fs.statSync(filename);
        const size = Math.min(stat.size, maxBytes);
        if (!size) return '';
        const offset = stat.size - size;
        const buffer = Buffer.alloc(size);
        fd = fs.openSync(filename, 'r');
        const read = fs.readSync(fd, buffer, 0, size, offset);
        let result = buffer.toString('utf8', 0, read);
        if (offset > 0) result = result.slice(result.indexOf('\n') + 1);
        return result;
    } catch (_) { return ''; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}

function sessionWarnings(ctx, sinceAt, maxLines) {
    const wanted = Number.isFinite(sinceAt) ? sinceAt : Date.now();
    const id = String(ctx.spec && ctx.spec.id || 'g21_wheelheat');
    const all = [];
    for (const suffix of ['.log.1', '.log']) {
        const raw = readTail(path.join(ctx.dataDir, id + suffix), RAW_FILE_TAIL_BYTES);
        for (const line of raw.split(/\r?\n/)) {
            const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)\s+(.+)$/.exec(line);
            if (!match || !WARNING_RE.test(match[2])) continue;
            const at = Date.parse(match[1]);
            if (!Number.isFinite(at) || at < wanted) continue;
            all.push({ at, kind: 'SDK', message: match[2].slice(0, 270) });
        }
    }
    all.sort((a, b) => a.at - b.at);
    const debug = new Map();
    for (const e of all) {
        if (!isSdkDebug(e.message) && !e.message.startsWith('SDK_DEBUG '))
            continue;
        e.kind = 'SDK DEBUG';
        const previous = debug.get(e.message);
        if (previous) previous.count++;
        else debug.set(e.message, { event: e, count: 1 });
    }
    for (const { event, count } of debug.values())
        if (count > 1) event.message += ' (×' + count + ')';
    return all.filter(e => e.kind !== 'SDK DEBUG').concat(Array.from(debug.values(), d => d.event))
        .sort((a, b) => a.at - b.at).filter((e, index) => index === 0 || e.at !== all[index - 1].at ||
        e.message !== all[index - 1].message).slice(-Math.max(0, Math.min(300, maxLines || 80)));
}

function consoleLines(events, warnings, sinceAt) {
    const entries = (events || []).filter(e => e && Number.isFinite(e.at) && e.at >= sinceAt)
        .map(e => ({ at: e.at, kind: e.kind || 'INFO', message: String(e.message || '') }))
        .concat((warnings || []).filter(e => e.at >= sinceAt));
    entries.sort((a, b) => a.at - b.at);
    const lines = [];
    for (const e of entries) {
        const time = new Date(e.at).toISOString().slice(11, 19);
        const prefix = time + '  ' + String(e.kind).padEnd(13, ' ') + ' ';
        const width = Math.max(30, 132 - prefix.length);
        let rest = String(e.message).replace(/[\r\n]+/g, ' ');
        let first = true;
        do {
            const part = rest.slice(0, width);
            rest = rest.slice(width);
            lines.push({ text: (first ? prefix : ' '.repeat(prefix.length)) + part,
                error: IMPORTANT_RE.test(e.kind) || e.kind === 'SDK' });
            first = false;
        } while (rest);
    }
    return lines.slice(-800);
}

function filterEvents(events, filter) {
    const patterns = {
        AutoHeat: /^(AUTO|START|BACKGROUND|PLAN)/,
        Vehicle: /^VEHICLE/,
        Cycle: /CYCLE|SESSION|PROCESS START/,
        Commands: /COMMAND|ACK|REJECT|BLOCK|STOP/,
        ECU: /ECU|^READ|^SMFA|^SMBF|^SDK$/,
        Readback: /READBACK|^READ|STATUS|CONFIRMED|OVERRIDE/,
        'SDK debug': /^SDK/,
    };
    return events.filter(e => filter === 'SDK debug' ? patterns[filter].test(e.kind) :
        e.kind !== 'SDK DEBUG' && (!patterns[filter] || patterns[filter].test(e.kind)));
}

module.exports = { consoleLines, sessionWarnings, filterEvents, isSdkDebug };
