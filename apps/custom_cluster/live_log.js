'use strict';
// In-memory current-session console. It works even when the disk is read-only.
// Absolute line indices keep a historical page still as new events arrive.
class LiveLog {
    constructor(limit, width, rows) {
        this.limit = limit || 1200;
        this.width = width || 96;
        this.rows = rows || 15;
        this.clear();
    }
    clear() { this.lines = []; this.first = 0; this.end = null; this.startedAt = Date.now(); }
    append(message) {
        const stamp = new Date().toISOString().slice(11, 19);
        const raw = String(message || '').replace(/\r/g, '').split('\n');
        raw.forEach((line, i) => {
            const prefix = i ? '         ' : stamp + ' ';
            // Do not render terminal escapes or other control characters.
            let rest = prefix + line.replace(/[\x00-\x1f\x7f]/g, ' ');
            while (rest.length > this.width) {
                this.lines.push(rest.slice(0, this.width));
                rest = '         ' + rest.slice(this.width);
            }
            this.lines.push(rest);
        });
        const extra = this.lines.length - this.limit;
        if (extra > 0) { this.lines.splice(0, extra); this.first += extra; }
        if (this.end !== null) this.end = Math.max(Math.min(this.first + this.rows, this.first + this.lines.length), this.end);
    }
    latest() { this.end = null; }
    move(delta) {
        const total = this.first + this.lines.length;
        const minimum = Math.min(total, this.first + this.rows);
        const next = Math.max(minimum, Math.min(total, (this.end === null ? total : this.end) + delta));
        this.end = next === total ? null : next;
    }
    view() {
        const total = this.first + this.lines.length;
        const end = this.end === null ? total : Math.min(total, this.end);
        const start = Math.max(this.first, end - this.rows);
        return { lines: this.lines.slice(start - this.first, end - this.first),
            start: end > start ? start + 1 : 0, end, total,
            dropped: this.first, following: this.end === null };
    }
}
module.exports = { LiveLog };
