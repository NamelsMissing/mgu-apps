'use strict';

// One running game: frame pacing, pause / resume, overload protection and battery saves.
// Pure logic with an injectable clock, so it is tested on the PC without a head unit.
const FRAME_MS = 1000 / 60;          // NES, SNES and Game Boy all run about 60 video frames a second
const MAX_CATCH_UP = 2;              // emulated frames per screen frame when the renderer falls behind
const AUTOSAVE_MS = 20000;
const OVERLOAD_MS = 45;              // average JS time per emulated frame that the MGU cannot sustain
const OVERLOAD_WINDOW = 90;          // emulated frames the average is taken over
const STALL_MS = 1500;               // a single frame this slow pauses at once

class Session {
    /**
     * game: a core (tick, stop, optional sram, draw for Pong); kind/name: what it is;
     * options: {now, store(kind, name, bytes), log}
     */
    constructor(game, kind, name, options) {
        const o = options || {};
        this.game = game; this.kind = kind; this.name = name;
        this.now = o.now || Date.now; this.storeSave = o.store || null; this.log = o.log || null;
        this.audio = o.audio || null;
        this.frameMs = game.frameMs || FRAME_MS;
        this.paused = false; this.reason = '';
        this.last = 0; this.carry = 0;
        this.samples = []; this.frames = 0;
        this.lastSaveAt = this.now();
        this.frame = null; this.fresh = false;
        this.stopped = false;
    }
    /** Cores call this with each finished picture; the newest one is shown. */
    paint(pixels, width, height) {
        this.frame = {pixels, width, height};
        this.fresh = true;
    }
    /** The newest picture once (null when nothing new was drawn since the last call). */
    take() {
        if (!this.fresh) return null;
        this.fresh = false;
        return this.frame;
    }
    get arcade() { return typeof this.game.draw === 'function'; }

    /** Pause (reason: 'user', 'overload', 'error'); keeps the game and saves its battery RAM. */
    pause(reason, detail) {
        if (this.stopped) return;
        if (!this.paused) this.save();
        this.paused = true; this.reason = reason || 'user'; this.detail = detail || '';
        this.last = 0; this.carry = 0;
    }
    resume() {
        if (this.stopped) return;
        this.paused = false; this.reason = ''; this.detail = '';
        this.samples = []; this.last = 0; this.carry = 0;
    }
    hold() { this.last = 0; this.carry = 0; }
    toggle() { if (this.paused) this.resume(); else this.pause('user'); }

    /**
     * Advance the game to `now`. allowed: parked, screen shown and in front. Returns the number
     * of emulated frames run (0 while paused, held or not yet due).
     */
    step(pads, allowed) {
        if (this.stopped || this.paused || !allowed) { this.hold(); return 0; }
        const now = this.now();
        if (!this.last) { this.last = now - this.frameMs; }
        const elapsed = now - this.last;
        this.last = now;
        if (this.arcade) {
            // Pong moves by time: one tick per screen frame, scaled to 60 Hz steps.
            this.run(() => this.game.tick(pads, Math.max(0.5, Math.min(2, elapsed / FRAME_MS))));
            return 1;
        }
        const due = Math.max(0, elapsed) / this.frameMs + this.carry + 1e-6;
        const count = Math.min(MAX_CATCH_UP, Math.floor(due));
        this.carry = due >= MAX_CATCH_UP + 1 ? 0 : due - count;      // too far behind: drop the rest
        let advanced = 0;
        for (let i = 0; i < count && !this.paused; i++) {
            this.run(() => {
                this.game.tick(pads, 1);
                if (this.game.getAudioSamples) {
                    const block = this.game.getAudioSamples();
                    if (this.audio && block) this.audio(block);
                }
            });
            if (!this.paused) advanced++;
        }
        if (!this.paused && now - this.lastSaveAt >= AUTOSAVE_MS) this.save();
        return advanced;
    }
    run(fn) {
        const t0 = this.now();
        try { fn(); }
        catch (e) {
            this.pause('error', e && e.message || String(e));
            if (this.log) this.log.warn('[GameStation] emulator error: ' + this.detail);
            return;
        }
        const spent = this.now() - t0;
        this.frames++;
        if (spent >= STALL_MS) { this.pause('overload', 'one frame took ' + Math.round(spent) + ' ms'); return; }
        this.samples.push(spent);
        if (this.samples.length > OVERLOAD_WINDOW) this.samples.shift();
        if (this.samples.length === OVERLOAD_WINDOW && this.average() > OVERLOAD_MS)
            this.pause('overload', Math.round(this.average()) + ' ms per frame');
    }
    average() {
        if (!this.samples.length) return 0;
        return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    }
    /** Write the battery RAM if the game has one and it changed. Returns true when written. */
    save() {
        this.lastSaveAt = this.now();
        if (!this.storeSave || !this.game || typeof this.game.sram !== 'function') return false;
        try {
            const bytes = this.game.sram();
            return !!(bytes && this.storeSave(this.kind, this.name, bytes));
        } catch (e) {
            if (this.log) this.log.warn('[GameStation] save failed: ' + e.message);
            return false;
        }
    }
    stop() {
        if (this.stopped) return;
        this.save();
        this.stopped = true;
        try { if (this.game && this.game.stop) this.game.stop(); }
        catch (e) { if (this.log) this.log.warn('[GameStation] stop: ' + e.message); }
        this.game = null; this.frame = null;
    }
}

module.exports = {Session, FRAME_MS, MAX_CATCH_UP, AUTOSAVE_MS, OVERLOAD_MS, OVERLOAD_WINDOW};
