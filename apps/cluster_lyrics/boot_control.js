'use strict';
/*
 * The app process is installed as an MGU autostart app. This small controller
 * decides whether its cluster layer should start immediately with the process,
 * or only after the user explicitly enables it in this session.
 *
 * Both settings are saved by the MGU kit. "autoStartOnBoot" affects the NEXT
 * app-process launch, not the current playing song or the current display.
 */
class BootControl {
    constructor(settings) {
        this.settings = settings;
        this.startedAutomatically = !!settings.get('kombiOn') && this.autostartEnabled();
        this.sessionEnabled = this.startedAutomatically;
    }
    autostartEnabled() { return this.settings.get('autoStartOnBoot') !== false; }
    active() { return this.sessionEnabled && !!this.settings.get('kombiOn'); }
    onSettingsChanged(key) {
        // An explicit user change to the master cluster setting takes effect
        // now. Altering the startup preference only changes the next boot.
        if (key === 'kombiOn') this.sessionEnabled = !!this.settings.get('kombiOn');
    }
    toggle() {
        const next = !this.active();
        this.sessionEnabled = next;
        this.settings.set('kombiOn', next);
        return next;
    }
}
module.exports = { BootControl };
