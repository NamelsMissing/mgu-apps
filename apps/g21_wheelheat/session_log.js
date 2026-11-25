'use strict';

const fs = require('fs');
const path = require('path');

const RAW_FILE_TAIL_BYTES = 64000;
const WARNING_RE = /SDK_(?:ERROR|WARN)|UNHANDLED REJECTION|\b(?:ERROR|FATAL)\b/i;
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
    return all.filter((e, index) => index === 0 || e.at !== all[index - 1].at ||
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

module.exports = { consoleLines, sessionWarnings };
