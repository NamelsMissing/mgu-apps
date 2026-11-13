'use strict';
// The BMW may publish speed/RPM only when they change. This test verifies
// read-only getter polling is strictly opt-in and separately time-stamped.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'kit', 'runtime', 'car.js'), 'utf8');
const mod = { exports: {} };
class Sim { sample() { return { speed: 0, rpm: 0 }; } }
vm.runInNewContext(source, {
    module: mod,
    require(n) {
        assert.strictEqual(n, './sim');
        return Sim;
    },
    setInterval() { return 1; },
    Date, Math, Object, Number, isFinite, Promise, console,
}, { filename: 'kit/runtime/car.js' });
const Car = mod.exports;
function context(calls) {
    return {
        spec: { config: {} },
        log: { info() {}, warn() {} },
        settings: { get() { return 'off'; } },
        signals: { watch(iface, instance, handlers, log, opts) {
            calls.push({ iface, handlers, opts });
            return Promise.resolve({ available: true });
        } },
    };
}

const watches = [];
const car = new Car(context(watches), ['rpm', 'speed', 'gear'], { pollMs: 5000 });
const cds = watches.find(x => x.iface === 'de.bmw.infotainment.vehicle.CDS');
const vehicle = watches.find(x => x.iface === 'de.bmw.infotainment.vehicle.Vehicle2');
const gearbox = watches.find(x => x.iface === 'de.bmw.infrastructure.VehicleInformation');
assert.strictEqual(cds.opts.pollMs, 5000, 'RPM getter poll');
assert.strictEqual(vehicle.opts.pollMs, 5000, 'speed getter poll');
assert.strictEqual(gearbox.opts, undefined, 'never poll gearbox');
const received = [];
car.onSample(d => received.push(d));
cds.handlers.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 3160 });
vehicle.handlers.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
gearbox.handlers.statusGearboxDrive({ statusActualGearDrive: 2, statusActualStageDrive: 1 });
assert.strictEqual(car.data().stage, 'P');
assert.strictEqual(car.data().rpm, 790);
assert.strictEqual(car.data().speed, 0);
assert.ok(received.length >= 2);
assert.ok(received[received.length - 1].receivedAt.speed > 0);
assert.ok(received[received.length - 1].receivedAt.rpm > 0);
const baseline = [];
new Car(context(baseline), ['rpm', 'speed']);
assert.ok(baseline.every(x => x.opts === undefined), 'all existing apps remain event-only');
console.log('custom-cluster read-only stationary getter polling tests passed');
