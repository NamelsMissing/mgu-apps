'use strict';
/*
 * Small JSON file next to the app data that tells, over SSH, whether the app process
 * runs without its window being open (autostart): when it started, why, when the menu
 * was first opened, and what the background features are doing. Local only, written
 * atomically, only when something changed (at most once per second), never read back.
 */
const fs = require('fs');
const path = require('path');

class BackgroundStatus {
    constructor(options) {
        this.dir = options.dir;
        this.file = path.join(options.dir, options.file);
        this.version = options.version;
        this.startReason = String((options.startReason) || 'unknown');
        this.now = options.now || Date.now;
        this.startedAt = this.now();
        this.firstVisibleAt = null;
        this.visibleBeforeOpen = 0;
        this.last = '';
        this.lastWriteAt = 0;
        this.error = '';
    }
    /** The window of the app was shown for the first time. */
    seen() { if (this.firstVisibleAt === null) this.firstVisibleAt = this.now(); }
    update(details) {
        const body = JSON.stringify(details || {});
        const now = this.now();
        if (body === this.last || now - this.lastWriteAt < 1000) return false;
        try {
            const doc = {
                version: this.version, pid: process.pid, startReason: this.startReason,
                startedAt: new Date(this.startedAt).toISOString(),
                firstMainVisibleAt: this.firstVisibleAt === null ? null : new Date(this.firstVisibleAt).toISOString(),
                windowOpenedYet: this.firstVisibleAt !== null,
                writtenAt: new Date(now).toISOString(), details: details || {}
            };
            fs.writeFileSync(this.file + '.tmp', JSON.stringify(doc, null, 2));
            fs.renameSync(this.file + '.tmp', this.file);
            this.last = body; this.lastWriteAt = now; this.error = '';
            return true;
        } catch (e) {
            this.error = String(e && e.message || e);
            this.lastWriteAt = now;
            return false;
        }
    }
}
module.exports = { BackgroundStatus };
