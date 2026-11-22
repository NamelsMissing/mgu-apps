'use strict';

// OEM BMW iDrive color selection. Separate from BDC RGB/LIN module writes.
// Reference: cauliflowermossgrape/idrive7-apps/apps/ambient_config/ambient.js.
// This selects existing FARBAUSWAHL slots; it cannot define arbitrary RGB.
const INTERFACE = 'de.bmw.infotainment.misc.ComfortFunctionIuK';
const PROFILE_INTERFACE = 'de.bmw.body.interiorillumination.AmbientLight';
const UNFILLED = 'SIGNAL_UNBEFUELLT';
const SLOT_MIN = 1, SLOT_MAX = 12, READ_FRESH_MS = 45000, MIN_GAP_MS = 1500;

function slotOf(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const m = /^FARBAUSWAHL_(\d+)$/.exec(String(raw));
    const n = m ? Number(m[1]) : Number(raw);
    return Number.isInteger(n) && n >= SLOT_MIN && n <= SLOT_MAX ? n : null;
}

function selection(n) {
    if (!Number.isInteger(n) || n < SLOT_MIN || n > SLOT_MAX)
        throw new RangeError('BMW slot must be 1..12');
    return {
        controlMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_' + n,
        controlModeAmbientePanoramicRoofInteriorLighting: UNFILLED,
        controlDynamicInteriorLighting: UNFILLED,
        controlDynamicAmbienteInteriorLighting: UNFILLED,
        controlHueInteriorLighting: 4095,
        controlHueValueLayer1IndividualGroup: 255,
        controlHueValueLayer2IndividualGroup: 255,
        controlHueValueLayer3IndividualGroup: 255,
        controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting: 255,
    };
}

function statusSlot(value) {
    return slotOf(value && value.statusMenuAmbientePanoramicRoofInteriorLighting);
}
function errorText(e) {
    const msg = String(e && e.message || e || 'Unknown error');
    return msg.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, '[redacted]')
        .replace(/(?:\/[\w.\-]+){2,}/g, '[path]')
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]').slice(0, 180);
}

class BmwColors {
    constructor(signals, sessionLog, log) {
        this.signals = signals;
        this.log = sessionLog;
        this.systemLog = log;
        this.proxy = null;
        this.observedAt = null;
        this.slot = null;
        this.profile = null;
        this.profileAt = null;
        this.brightness = null;
        this.brightnessAt = null;
        this.available = false;
        this.busy = false;
        this.error = null;
        this.last = null;
        this.previous = null;
        this.lastWriteAt = null;
        this.started = false;
    }
    get statusFresh() {
        return this.observedAt !== null && Date.now() - this.observedAt <= READ_FRESH_MS;
    }
    get ready() { return this.available && this.proxy && this.statusFresh && !this.busy; }
    get message() {
        if (this.busy) return 'BMW interface: request running';
        if (!this.available) return 'ComfortFunctionIuK not available; BMW slot test is read-only.';
        if (!this.statusFresh) return 'Awaiting recent BMW color status; change the color in the BMW menu.';
        return 'Current BMW slot ' + this.slot + ' · select another slot below.';
    }
    observe(value) {
        const n = statusSlot(value);
        if (n === null) {
            this.log.add('BMW COLOR STATUS', 'Unknown/unsupported slot in BMW status', 'warning');
            return;
        }
        const changed = n !== this.slot;
        this.slot = n;
        this.observedAt = Date.now();
        if (changed) this.log.add('BMW COLOR STATUS', 'Original BMW menu slot ' + n, 'success');
        if (this.last && this.last.sent && this.last.target === n &&
            this.observedAt >= this.last.at) {
            this.last.readback = true;
            this.last.readbackAt = this.observedAt;
        }
    }
    readProfile(value) {
        const v = value && value.currentLightProfileId;
        if (v === undefined || v === null) return;
        this.profile = String(v).slice(0, 72);
        this.profileAt = Date.now();
        this.log.add('BMW PROFILE STATUS', 'Profile ' + this.profile);
    }
    readBrightness(value) {
        // Do not interpret unknown struct layouts as a vehicle brightness percentage.
        this.brightness = typeof value === 'number' ? value :
            value && Number.isFinite(value.brightnessAmbientLight) ? value.brightnessAmbientLight : null;
        this.brightnessAt = Date.now();
    }
    async start() {
        if (this.started) return;
        this.started = true;
        try {
            const sub = await this.signals.watch(INTERFACE, '1', {
                statusAmbientLightInteriorColour: value => this.observe(value),
            }, this.systemLog, {pollMs: 5000});
            this.proxy = sub && sub.proxy || null;
            this.available = !!this.proxy && !sub.error;
            if (!this.available) {
                this.error = errorText(sub && sub.error || 'BMW interface not present');
                this.log.add('BMW COLORS', this.error, 'warning');
            } else {
                this.log.add('BMW COLORS', 'ComfortFunctionIuK proxy ready; waiting for live status');
            }
        } catch (e) {
            this.available = false;
            this.error = errorText(e);
            this.log.add('BMW COLORS', this.error, 'warning');
        }
        // Optional supplementary status; unsupported vehicles may not expose B09E.
        try {
            const p = await this.signals.watch(PROFILE_INTERFACE, '1', {
                currentInteriorLightProfile: value => this.readProfile(value),
                brightnessAmbientLight: value => this.readBrightness(value),
            }, this.systemLog, {pollMs: 7000});
            if (p && p.error) this.log.add('BMW PROFILE', 'Optional service: ' + errorText(p.error), 'warning');
        } catch (e) {
            this.log.add('BMW PROFILE', 'Optional service unavailable: ' + errorText(e), 'warning');
        }
    }
    async setSlot(n) {
        if (!Number.isInteger(n) || n < SLOT_MIN || n > SLOT_MAX)
            return this._blocked('Invalid BMW slot (1..12)');
        if (!this.available || !this.proxy) return this._blocked('BMW color setter unavailable');
        if (!this.statusFresh) return this._blocked('No fresh original BMW color status. Select a color in BMW menu first.');
        if (this.busy) return this._blocked('BMW color request already running');
        if (this.lastWriteAt !== null && Date.now() - this.lastWriteAt < MIN_GAP_MS)
            return this._blocked('BMW color request cooldown: wait 1.5 seconds');
        if (n === this.slot) {
            this.last = {at: Date.now(), target: n, sent: false, acknowledged: false, readback: true,
                text: 'BMW slot ' + n + ' already selected; no write sent'};
            return this.last;
        }
        this.busy = true;
        this.previous = this.slot;
        this.lastWriteAt = Date.now();
        const r = {at: this.lastWriteAt, target: n, previous: this.slot, sent: true,
            acknowledged: false, readback: false, text: 'Sending BMW slot ' + n};
        this.last = r;
        this.log.add('BMW COLOR TX', 'ComfortFunctionIuK: select BMW menu slot ' + n);
        try {
            await this.signals.set(this.proxy, 'ambientLightInteriorColour', selection(n), 5000);
            r.acknowledged = true;
            r.text = r.readback ? 'BMW slot ' + n + ': setter accepted and status matched' :
                'BMW slot ' + n + ': setter accepted; waiting for live status';
            this.log.add('BMW COLOR ACK', r.text, 'success');
            this.error = null;
        } catch (e) {
            r.acknowledged = false;
            r.readback = false;
            this.error = errorText(e);
            r.text = 'BMW setter rejected/failed: ' + this.error;
            this.log.add('BMW COLOR ERROR', r.text, 'warning');
        } finally {
            this.busy = false;
        }
        return r;
    }
    _blocked(reason) {
        this.last = {at: Date.now(), sent: false, acknowledged: false, readback: false, text: reason};
        this.log.add('BMW COLOR BLOCKED', reason, 'warning');
        return this.last;
    }
    report() {
        return {
            interface: INTERFACE, available: this.available, statusFresh: this.statusFresh,
            currentSlot: this.slot, observedAt: this.observedAt,
            profile: this.profile, profileAt: this.profileAt,
            brightness: this.brightness, brightnessAt: this.brightnessAt,
            last: this.last ? Object.assign({}, this.last) : null,
            error: this.error,
        };
    }
}

module.exports = { BmwColors, selection, slotOf, statusSlot, INTERFACE, PROFILE_INTERFACE, MIN_GAP_MS };
