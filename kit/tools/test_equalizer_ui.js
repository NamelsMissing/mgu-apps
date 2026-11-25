'use strict';
// End-to-end UI flow with the real app, persistence and a mock audio provider.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { headUnit } = require('./hu-stub');
const { provider } = require('./test_equalizer');
const { Storage } = require('../../apps/equalizer/storage');
const { Service } = require('../../native/equalizer-dsp/server');

async function main() {
    const root = path.resolve(__dirname, '../..'), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-ui-'));
    const out = path.resolve(root, '../qa/mapped'); fs.mkdirSync(out, { recursive: true });
    const p = provider(); let image;
    const dsp = new Service({ runtime: path.join(dataDir, 'unused-run'), stateFile: path.join(dataDir, 'dsp-state.json') });
    const hu = headUnit(path.join(root, 'dist/equalizer'), {
        dataDir, sets: {}, log: { info() {}, warn() {}, error(e) { throw e; } },
        image: async (name, cv) => { image = cv; },
    });
    hu.ui.text = async () => {};
    hu.ctx.signals = p.sig;
    // UI checks use the real configuration service with direct transport. The
    // separate DSP suite exercises the native Unix sockets in GitHub CI.
    hu.ctx.dspRequest = async (q) => q.op === 'status' ? dsp.status() : dsp.set(q.config, q.expectedRevision);
    const press = async (name) => { assert(hu.handlers[name], name); await hu.handlers[name]({ row: 0 }); };
    const state = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'equalizer-state.json'), 'utf8'));
    const shot = async (name) => {
        await hu.loopFn(); assert(image);
        fs.writeFileSync(path.join(out, name + '.png'), Buffer.isBuffer(image) ? image : image.png());
        (hu.display.pageTargets || []).forEach((q) => assert.equal(typeof q.run, 'function', 'controller target ' + q.key));
    };
    try {
        hu.start(); await new Promise((resolve) => setTimeout(resolve, 100));
        await press('BTN_REFRESH'); assert.equal(p.state.writes.length, 0);
        await press('BTN_PAGE'); await press('BTN_PAGE'); await press('BTN_PAGE');
        await press('BTN_APPLY'); assert.equal(state().learning.control, 'bass');
        // Regression: an unfinished OEM bass measurement must NOT disable software DSP.
        await press('BTN_PAGE'); await press('BTN_PAGE'); // setup -> diagnostics -> DSP
        await press('BTN_INC');
        assert.equal(dsp.config.bands[0].gainDb, 0, 'DSP changes remain staged');
        await press('BTN_APPLY');
        assert.equal(dsp.config.bands[0].gainDb, 0.5, 'DSP apply works during OEM learning');
        assert.equal(state().learning.control, 'bass', 'OEM learning must remain intact');
        await press('BTN_DEC'); await press('BTN_APPLY');
        assert.equal(dsp.config.bands[0].gainDb, 0, 'reset DSP gain before other tests');
        for (let i = 0; i < 3; i++) await press('BTN_PAGE'); // DSP -> tone -> profiles -> setup
        assert.equal(state().learning.shots.length, 0);
        await shot('setup-center');
        await press('BTN_APPLY'); assert.equal(state().learning.shots.length, 1);
        p.state.system[30] = -12; await press('BTN_APPLY');
        p.state.system[30] = 12; await press('BTN_APPLY');
        p.state.system[30] = 0; await press('BTN_APPLY');
        assert.equal(state().learning, null); assert.equal(state().bindings.bass.key, 30);
        assert.equal(p.state.writes.length, 0, 'calibration must never write');
        await press('BTN_PAGE'); await press('BTN_PAGE'); await press('BTN_PAGE');
        await shot('tone-live');
        await press('BTN_INC'); assert.equal(p.state.system[30], 0, 'edits are staged');
        await shot('tone-pending'); await press('BTN_APPLY'); assert.equal(p.state.system[30], 1);
        await press('BTN_PAGE');
        await press('BTN_NEXT'); await press('BTN_NEXT'); await press('BTN_NEXT');
        await press('BTN_DEC'); assert.equal(state().dspProfiles['1'].config.bands[0].gainDb, 0);
        await shot('profile-saved');
        await press('BTN_PROFILE_EDIT');
        await press('BTN_INC');
        await press('BTN_APPLY');
        assert.equal(state().dspProfiles['1'].name, 'Qrofil 1');
        assert.equal(new Storage(dataDir, { warn() {} }).state.dspProfiles['1'].name, 'Qrofil 1');
        const altered = JSON.parse(JSON.stringify(dsp.config)); altered.bands[0].gainDb = 6; dsp.set(altered, dsp.revision);
        p.state.system[30] = 0; await press('BTN_REFRESH'); await press('BTN_INC');
        assert.equal(dsp.config.bands[0].gainDb, 6, 'profile preview does not write');
        await press('BTN_APPLY'); assert.equal(dsp.config.bands[0].gainDb, 0); assert.equal(p.state.system[30], 0, 'DSP profile leaves native BMW values alone');
        await press('BTN_PROFILE_EDIT');
        await shot('profile-edit');
        const del = hu.display.pageTargets.find((q) => q.key === 'delete-profile');
        assert(del);
        await del.run();
        assert.equal(state().dspProfiles['1'], undefined);
        await press('BTN_PAGE'); await press('BTN_PAGE'); await press('BTN_PAGE');
        await press('BTN_INC'); assert.equal(dsp.config.bands[0].gainDb, 0);
        await press('BTN_APPLY'); assert.equal(dsp.config.bands[0].gainDb, 0.5);
        await shot('dsp-controls');
        // Immediate enable/disable must persist without separately pressing Apply.
        const on = hu.display.pageTargets.find((q) => q.key === 'dsp-on');
        const bypass = hu.display.pageTargets.find((q) => q.key === 'dsp-bypass');
        assert(on && bypass, 'dedicated DSP and bypass buttons');
        await on.run(); assert.equal(dsp.config.enabled, true, 'DSP ON must commit immediately');
        await bypass.run(); assert.equal(dsp.config.enabled, false, 'BYPASS must commit immediately');
        await on.run(); assert.equal(dsp.config.enabled, true, 'DSP ON direct re-activation');
        await press('BTN_APPLY'); assert.equal(dsp.config.enabled, true);
        await press('BTN_PARAM'); await press('BTN_INC'); await press('BTN_APPLY'); assert.equal(dsp.config.bands[0].frequencyHz, 110);
        await press('BTN_PARAM'); await press('BTN_INC'); await press('BTN_APPLY'); assert.equal(dsp.config.bands[0].q, 1.1);
        await press('BTN_PARAM'); await press('BTN_DEC'); await press('BTN_APPLY'); assert.equal(dsp.config.preampDb, -0.5);
        for (let i = 0; i < 4; i++) await press('BTN_PAGE');
        await press('BTN_APPLY');
        const diagnostic = JSON.parse(fs.readFileSync(path.join(dataDir, 'equalizer-diagnostics.json')));
        assert.equal(diagnostic.app, 'equalizer'); assert(!JSON.stringify(diagnostic).includes('VIN'));
        await shot('diagnostics');
        assert(new Storage(dataDir, { warn() {} }).state.bindings.bass);
        console.log('PASS UI: native setup, staged/native DSP edits, gain/frequency/Q/preamp, bypass, DSP profile save/load, export, controller targets and persistence');
        console.log('UI preview files: ' + out);
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}
main().then(() => process.exit(0), (e) => { console.error(e.stack); process.exit(1); });
