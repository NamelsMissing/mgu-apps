'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
    if (request === './kit/diag' && parent && parent.filename.endsWith('/g21_ambient/safe_diag.js'))
        return require.resolve('../kit/runtime/diag');
    return originalResolve.call(this, request, parent, ...rest);
};
const {SafeDiag} = require('../apps/g21_ambient/safe_diag');
Module._resolveFilename = originalResolve;
const {encodeBdc, discoveredTargets} = require('../apps/g21_ambient/bdc_control');

function records(bus = 1, nad = 3) {
    return [{status: 'Changed', color: true,
        from: {bus, nad, valid: true, location: 5, rgbw: [20, 20, 20, 0]},
        to: {bus, nad, valid: true, location: 5, rgbw: [50, 10, 90, 0]}}];
}
function harness(response) {
    const requests = [];
    const ctl = new SafeDiag({signals: {}, log: {info() {}, warn() {}}, spec: {version: '0.4.5'}});
    ctl.diag.p = {};
    ctl.diag.available = true;
    ctl.diag.physicalTracked = async (target, service, payload, options) => {
        options.onSend();
        requests.push([target, service].concat(payload));
        return response;
    };
    ctl.updateSpeed(0);
    ctl.wizard = {step: 4, physical: 'Yes', observedAt: Date.now(),
        comparison: {at: Date.now(), revision: ctl.connectionRevision, rows: records()}};
    return {ctl, requests};
}
test('two documented BDC write DIDs encode exactly seven arguments', () => {
    const color = {on: 1, rgb: [10, 20, 30]};
    assert.deepEqual(encodeBdc(1, 3, color, 80, 5), [0xDA, 0x5E, 3, 1, 80, 10, 20, 30, 5]);
    assert.deepEqual(encodeBdc(2, 5, color, 80, 5).slice(0, 2), [0xE3, 0xD1]);
    assert.throws(() => encodeBdc(1, 0, color, 80, 5), /NAD/);
    assert.throws(() => encodeBdc(1, 3, color, 80, 30), /duration/);
    assert.throws(() => encodeBdc(1, 3, {on: 1, rgb: [255, 0, 0]}, 80, 5), /RGB/);
});
test('targets require valid changed RGB, never FF sentinel values', () => {
    assert.deepEqual(discoveredTargets(records()), [{bus: 1, nad: 3, location: 5}]);
    assert.deepEqual(discoveredTargets([{...records()[0], to: {...records()[0].to, rgbw: [255, 10, 90, 0]}}]), []);
    assert.deepEqual(discoveredTargets([{...records()[0], status: 'Unchanged'}]), []);
});
test('guarded BDC write sends one 2E DA5E only on second confirmation', async () => {
    const {ctl, requests} = harness([0x6E, 0xDA, 0x5E]);
    await ctl.applyBdc({on: 1, rgb: [10, 20, 30]}, 80, 5, () => true);
    assert.equal(ctl.bdcConfirming, true);
    assert.equal(requests.length, 0);
    await ctl.applyBdc({on: 1, rgb: [10, 20, 30]}, 80, 5, () => true);
    assert.deepEqual(requests, [[0x40, 0x2E, 0xDA, 0x5E, 3, 1, 80, 10, 20, 30, 5]]);
    assert.equal(ctl.lastBdcWrite.acknowledged, true);
    assert.equal(ctl.lastBdcWrite.physical, 'Not checked');
    ctl.markBdcPhysical('Yes');
    assert.equal(ctl.lastBdcWrite.physical, 'Yes');
});
test('NRC 31 blocks another write without trying another ECU/DID', async () => {
    const {ctl, requests} = harness([0x7F, 0x2E, 0x31]);
    const go = () => ctl.applyBdc({on: 1, rgb: [10, 20, 30]}, 80, 5, () => true);
    await go(); await go();
    assert.equal(ctl.lastBdcWrite.acknowledged, false);
    ctl.lastBdcWriteAt -= 3000;
    await go(); await go();
    assert.equal(requests.length, 1);
    assert.match(ctl.info, /rejected/);
});
test('missing visual confirmation or fresh speed-0 blocks vehicle writes', async () => {
    const {ctl, requests} = harness([0x6E, 0xDA, 0x5E]);
    ctl.wizard.physical = 'No';
    await ctl.applyBdc({on: 1, rgb: [1, 2, 3]}, 50, 5, () => true);
    assert.equal(requests.length, 0);
    ctl.wizard.physical = 'Yes';
    ctl.updateSpeed(10);
    await ctl.applyBdc({on: 1, rgb: [1, 2, 3]}, 50, 5, () => true);
    assert.equal(requests.length, 0);
});

test('experimental mode can select only a fresh valid BDC read slot even with 255 RGB sentinels', async () => {
    const {ctl, requests} = harness([0x6E, 0xDA, 0x5E]);
    ctl.wizard.physical = 'No';
    ctl.bdc[0].read = {at: Date.now(), revision: ctl.connectionRevision, decoded: true};
    ctl.bdc[0].valid = {at: Date.now(), revision: ctl.connectionRevision,
        data: {records: [
            {bus: 1, nad: 1, location: 5, rgbw: [255, 255, 255, 3], valid: true},
            {bus: 1, nad: 2, location: 255, rgbw: [255, 255, 255, 3], valid: false},
        ]}};
    assert.equal(ctl.bdcTestTargets.length, 0, 'must default to verified-only mode');
    await ctl.applyBdc({on: 1, rgb: [22, 33, 44]}, 50, 2, () => true);
    assert.equal(requests.length, 0, 'no command before opt-in');
    ctl.setExperimentalLin(true);
    assert.equal(ctl.bdcCandidates.length, 1);
    assert.deepEqual(ctl.bdcCandidates.map(x => [x.bus, x.nad]), [[1, 1]]);
    assert.match(ctl.bdcGuidance, /not verified/i);
    assert.equal(ctl.selectBdcTarget(1, 2), false, 'invalid location excluded');
    assert.equal(ctl.selectBdcTarget(1, 1), true);
    assert.match(ctl.info, /EXPERIMENTAL/);
    await ctl.applyBdc({on: 1, rgb: [22, 33, 44]}, 50, 2, () => true);
    assert.equal(requests.length, 0, 'first press only arms');
    await ctl.applyBdc({on: 1, rgb: [22, 33, 44]}, 50, 2, () => true);
    assert.deepEqual(requests, [[0x40, 0x2E, 0xDA, 0x5E, 1, 1, 50, 22, 33, 44, 2]]);
    assert.equal(ctl.lastBdcWrite.experimental, true);
    ctl.setExperimentalLin(false);
    assert.equal(ctl.bdcTestTargets.length, 0);
    ctl.lastBdcWriteAt -= 3000;
    await ctl.applyBdc({on: 1, rgb: [22, 33, 44]}, 50, 2, () => true);
    assert.equal(requests.length, 1, 'disabling experimental mode must prevent another write');
});

test('expired BDC record and lost standstill prohibit experimental writes', async () => {
    const {ctl, requests} = harness([0x6E, 0xDA, 0x5E]);
    ctl.wizard.physical = 'No';
    ctl.bdc[0].read = {at: Date.now(), revision: ctl.connectionRevision, decoded: true};
    ctl.bdc[0].valid = {at: Date.now(), revision: ctl.connectionRevision,
        data: {records: [{bus: 1, nad: 2, location: 5, rgbw: [255, 255, 255, 3], valid: true}]}};
    ctl.setExperimentalLin(true);
    assert.equal(ctl.selectBdcTarget(1, 2), true);
    ctl.updateSpeed(64); // 1 km/h, must not permit tests
    await ctl.applyBdc({on: 1, rgb: [1, 2, 3]}, 40, 2, () => true);
    assert.equal(requests.length, 0);
    ctl.updateSpeed(0);
    ctl.bdc[0].read.at -= 180000;
    assert.equal(ctl.bdcTestTargets.length, 0);
    await ctl.applyBdc({on: 1, rgb: [1, 2, 3]}, 40, 2, () => true);
    assert.equal(requests.length, 0);
});
