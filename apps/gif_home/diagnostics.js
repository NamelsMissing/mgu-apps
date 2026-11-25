'use strict';
const fs = require('fs');
const path = require('path');
const { atomic } = require('./library');

function diagnostics(dir, log) {
    const file = path.join(dir, 'diagnostics.json');
    let entries = [], timer = null;
    try {
        if (fs.statSync(file).size < 65536) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Array.isArray(data)) entries = data.filter(e => e && typeof e.message === 'string' &&
                typeof e.time === 'string').slice(-140);
        }
    } catch (_) {}
    function flush() {
        timer = null;
        try { atomic(file, JSON.stringify(entries)); }
        catch (_) { log.warn('GIF Home diagnostics could not be written'); }
    }
    function record(message) {
        const clean = String(message).replace(/[a-f0-9]{48}/gi, '[redacted]').slice(0, 120);
        entries.push({ time: new Date().toISOString(), message: clean });
        entries = entries.slice(-140);
        if (!timer) timer = setTimeout(flush, 3000);
    }
    return { record, entries: () => entries.slice(), clear() {
        entries = [];
        if (timer) clearTimeout(timer);
        flush();
    } };
}

module.exports = { diagnostics };
