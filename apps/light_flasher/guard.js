'use strict';

// Gear enums differ between these two BMW signals. N_OR_P / NP never
// authorize a show. Quiet change-notified gear data stays valid only while
// its provider remains available; speed is read again every 500 ms.
class Guard {
    constructor(now, changed) {
        this.now = now || Date.now;
        this.changed = changed || (() => {});
        this.speed = null; this.speedAt = 0; this.stage = null;
        this.speedSub = null; this.gearSub = null;
    }
    feedSpeed(v) {
        const n = v && v.speedVehicleCentreOfGravity;
        this.speed = typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 65535 ? n / 64 : null;
        this.speedAt = this.now(); this.changed();
    }
    feedStage(v) {
        const x = v && v.statusActualStageDrive;
        this.stage = ({ P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' })[x] || null;
        this.changed();
    }
    feedSelection(v) {
        const x = v && v.statusGearSelectionDrive;
        const n = typeof x === 'number' ? x : ({ N: 1, R: 2, P: 3, NP: 4 })[x] || (/^_[1-9]$/.test(String(x)) ? 4 + Number(String(x).slice(1)) : 0);
        this.stage = n === 3 ? 'P' : n === 2 ? 'R' : n === 1 ? 'N' : n >= 5 && n <= 13 ? 'D' : null;
        this.changed();
    }
    async init(signals, log, lightStatus) {
        this.speedSub = await signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => this.feedSpeed(v),
            statusLightStatus: (v) => { if (typeof lightStatus === 'function') lightStatus(v); },
        }, log, { pollMs: 500 });
        this.gearSub = await signals.watch('de.bmw.infrastructure.VehicleInformation', '1', {
            statusGearboxDrive: (v) => this.feedStage(v),
            DataPowerTrain2: (v) => this.feedSelection(v),
        }, log);
        if (this.speedSub.proxy) await signals.onAvailable(this.speedSub.proxy, (up) => {
            if (!up) { this.speed = null; this.speedAt = 0; this.changed(); }
        });
        if (this.gearSub.proxy) await signals.onAvailable(this.gearSub.proxy, (up) => {
            if (!up) { this.stage = null; this.changed(); }
        });
        this.changed();
    }
    reason() {
        if (!this.speedSub || !this.speedSub.available || this.speed === null || this.now() - this.speedAt > 2500) return 'Waiting for current vehicle speed';
        if (this.speed > 0.1) return 'Vehicle must be stationary';
        if (!this.gearSub || !this.gearSub.available || this.stage !== 'P') return 'Select P (Park)';
        return null;
    }
    snapshot() {
        return { speedKmh: this.speed, speedAgeMs: this.speedAt ? this.now() - this.speedAt : null,
            stage: this.stage, speedProvider: !!(this.speedSub && this.speedSub.available),
            gearProvider: !!(this.gearSub && this.gearSub.available), blockedBy: this.reason() };
    }
}
module.exports = Guard;
