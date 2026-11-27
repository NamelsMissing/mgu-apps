'use strict';
/**
 * Smooth gauge motion for the parked KOMBI layouts (0.7.0).
 *
 * Live values arrive a few times a second; sending them straight to the
 * progress/needle uniform makes the scale jump. GaugeMotion eases each
 * channel towards its target by time (not by update count) and plays the
 * start-up sweep: every channel to full and back, like a BMW at ignition.
 * Only scalar uniforms are sent, never textures. tick() is driven by the
 * owner (about 30 Hz while a layout is shown) and by tests with a fake clock.
 */
const TAU_MS = 110;          // easing time constant
const EPS = 0.0015;          // smallest change worth a uniform message
const SWEEP_UP_MS = 700, SWEEP_DOWN_MS = 700;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x) => x * x * (3 - 2 * x);

/** Sweep envelope 0..1 at ms after its start; 0 outside the sweep. */
function sweepValue(ms) {
    if (!(ms >= 0) || ms >= SWEEP_UP_MS + SWEEP_DOWN_MS) return 0;
    return ms < SWEEP_UP_MS ? ease(ms / SWEEP_UP_MS) : ease(1 - (ms - SWEEP_UP_MS) / SWEEP_DOWN_MS);
}

class GaugeMotion {
    constructor(cr, now) {
        this.cr = cr;
        this.channels = [];
        this.sweepAt = 0;
        this.last = typeof now === "number" ? now : Date.now();
    }
    /** A channel starts at its live value; nothing is sent until it moves. */
    add(ref, fraction) {
        const f = clamp01(fraction);
        this.channels.push({ ref, target: f, shown: f, sent: f });
    }
    setTarget(ref, fraction) {
        const c = this.channels.find((x) => x.ref === ref);
        if (c && typeof fraction === 'number' && Number.isFinite(fraction)) c.target = clamp01(fraction);
    }
    /** Start the sweep at the given time (may be in the future, e.g. after the intro). */
    sweep(at) { this.sweepAt = at; }
    sweeping(now) { return !!this.sweepAt && now < this.sweepAt + SWEEP_UP_MS + SWEEP_DOWN_MS; }
    tick(now) {
        const dt = Math.max(0, Math.min(500, now - this.last));
        this.last = now;
        const k = 1 - Math.exp(-dt / TAU_MS);
        const s = this.sweepAt ? sweepValue(now - this.sweepAt) : 0;
        if (this.sweepAt && !this.sweeping(now)) this.sweepAt = 0;
        let moving = false;
        this.channels.forEach((c) => {
            c.shown += (c.target - c.shown) * k;
            if (Math.abs(c.target - c.shown) < EPS / 4) c.shown = c.target;
            const v = Math.max(c.shown, s);
            if (Math.abs(v - c.sent) >= EPS || (v === c.target && v !== c.sent && !s)) {
                c.sent = v;
                this.cr.uniform(c.ref, 'u_fraction', [Math.round(v * 10000) / 10000]);
            }
            if (c.shown !== c.target) moving = true;
        });
        return moving || this.sweeping(now);
    }
}
module.exports = { GaugeMotion, sweepValue, SWEEP_UP_MS, SWEEP_DOWN_MS, TAU_MS };
