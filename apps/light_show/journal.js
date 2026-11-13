'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const F = require('./flm-control');

class Journal {
    constructor(dir) {
        this.file = path.join(dir, 'light-show-recovery.json'); this.value = null;
        try { this.value = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') this.value = { corrupted: true }; }
    }
    pending() { return !!this.value; }
    mark(index, control) {
        if (index !== P.INDEX) throw new Error('BDC_G05 identity required');
        const route = control && control.route || 'digital';
        if (['timed', 'digital', 'single', 'flm'].indexOf(route) < 0 || (route === 'timed'
            && !Object.prototype.hasOwnProperty.call(P.FUNCTIONS, control.lights))
            || (route === 'single' && !Number.isInteger(control.outputId))) throw new Error('Invalid recovery context');
        if (route === 'single') P.control(control.outputId, 0);
        if (route === 'flm') { F.moduleFor(control.side); F.start(control.channel, control.pwm, control.seconds); }
        const value = { index, address: P.ADDRESS, at: new Date().toISOString(), route,
            lights: control && control.lights || null,
            outputId: route === 'single' ? control.outputId : null,
            side: route === 'flm' ? control.side : null,
            channel: route === 'flm' ? control.channel : null,
            pwm: route === 'flm' ? control.pwm : null,
            seconds: route === 'flm' ? control.seconds : null };
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(value));
        fs.renameSync(this.file + '.tmp', this.file); this.value = value;
    }
    clear() { fs.unlinkSync(this.file); this.value = null; }
}
module.exports = Journal;
