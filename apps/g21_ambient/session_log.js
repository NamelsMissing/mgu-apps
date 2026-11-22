'use strict';

const LIMIT = 640;
const BUDGET = 98304;
const VISIBLE = 13;
const WIDTH = 120;

function linesFor(entry) {
    const time = new Date(entry.at).toISOString().slice(11, 23);
    const prefix = '[' + time + '] ' + entry.kind + ' ';
    return entry.message.split(/\r?\n/).reduce((lines, message) => {
        let lead = lines.length ? ' '.repeat(prefix.length) : prefix;
        do {
            const width = WIDTH - lead.length;
            let end = message.length;
            if (end > width) {
                const space = message.lastIndexOf(' ', width);
                end = space > 0 ? space : width;
            }
            lines.push({level: entry.level, text: lead + message.slice(0, end)});
            message = message.slice(end).replace(/^ /, '');
            lead = ' '.repeat(prefix.length);
        } while (message);
        return lines;
    }, []);
}

class SessionLog {
    constructor() {
        this.startedAt = Date.now();
        this.entries = [];
        this.bytes = 0;
        this.firstLine = 0;
        this.total = 0;
        this.dropped = 0;
        this.clearedAt = null;
        this.anchor = null;
    }
    add(kind, message, level = 'info') {
        const entry = {at: Date.now(), kind, message: String(message == null ? '' : message), level};
        const size = Buffer.byteLength(entry.message, 'utf8');
        if (size > BUDGET) { this.dropped++; return; }
        entry.lines = linesFor(entry);
        entry.size = size;
        this.entries.push(entry);
        this.bytes += size;
        this.total += entry.lines.length;
        while (this.entries.length > LIMIT || this.bytes > BUDGET) {
            const old = this.entries.shift();
            this.firstLine += old.lines.length;
            this.total -= old.lines.length;
            this.bytes -= old.size;
            this.dropped++;
        }
    }
    get end() { return this.firstLine + Math.max(0, this.total - VISIBLE); }
    get start() { return this.anchor === null ? this.end : Math.max(this.firstLine, Math.min(this.end, this.anchor)); }
    move(delta) {
        const old = this.start;
        const start = Math.max(this.firstLine, Math.min(this.end, old + delta));
        this.anchor = start === this.end ? null : start;
        return start !== old;
    }
    latest() { this.anchor = null; }
    clear() {
        this.entries.length = 0;
        this.firstLine = 0;
        this.total = 0;
        this.bytes = 0;
        this.dropped = 0;
        this.clearedAt = Date.now();
        this.latest();
    }
    page() {
        const start = this.start - this.firstLine;
        let index = 0;
        const lines = [];
        for (const entry of this.entries) {
            if (index + entry.lines.length > start)
                lines.push(...entry.lines.slice(Math.max(0, start - index), start + VISIBLE - index));
            index += entry.lines.length;
            if (lines.length >= VISIBLE) break;
        }
        return {start, total: this.total, lines};
    }
    export() { return this.entries.map(({at, kind, message, level}) => ({at, kind, message, level})); }
}

module.exports = {SessionLog, LIMIT, BUDGET, VISIBLE, linesFor};
