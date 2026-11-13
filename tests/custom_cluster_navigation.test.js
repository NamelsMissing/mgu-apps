'use strict';
// Regression: secondary RHMI states and an internal in-page router must not
// both own navigation. Keep a single MAIN state and reset on fresh entry.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'apps', 'custom_cluster');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
const icon = fs.readFileSync(path.join(root, 'icon.png'));
const referenceIcon = fs.readFileSync(path.join(__dirname, '..', 'apps', 'g21_wheelheat', 'icon.png'));
assert.strictEqual(icon.subarray(1, 4).toString('ascii'), 'PNG', 'Custom Cluster must ship a PNG icon');
assert.strictEqual(icon.readUInt32BE(16), referenceIcon.readUInt32BE(16), 'BMW app icon width must match peer apps');
assert.strictEqual(icon.readUInt32BE(20), referenceIcon.readUInt32BE(20), 'BMW app icon height must match peer apps');
assert.strictEqual(icon.readUInt32BE(16), 140, 'ID7 installed-app tile should be 140px');
assert.deepStrictEqual(spec.screens.map((s) => s.name), ['MAIN']);
for (const screen of spec.screens) {
    const ids = screen.buttons.map((b) => b[0]);
    assert.strictEqual(ids.length, new Set(ids).size, screen.name + ' duplicate buttons');
}

const clicks = new Map(), pages = [], loops = [], events = [];
const labels = new Map(), renders = new Map(), drawn = [];
let reportCount = 0, cleared = 0, clearedMemory = 0;
const ui = {
    onClick: (name, fn) => clicks.set(name, fn),
    onVisible: (fn) => events.push(fn),
    open: (name) => { pages.push(name); return Promise.resolve(); },
    text: (name, value) => { labels.set(name, value); return Promise.resolve(); },
    image: (name) => { drawn.push('image:' + name); return Promise.resolve(); },
};
const values = { layout: 'g80', panelTestMode: 'probe', panelTarget: 'panel',
    accent: 'm', colorMode: 'palette', colorBrightness: 100, cycleSeconds: 20,
    sixwbTheme: 'comfort', sixwbColorSource: 'original',
    phoneBridge: false, wazeMap: 'auto', phoneBadge: false };
const ctx = {
    dataDir: '/tmp', spec, ui,
    settings: { get: (key) => values[key], onChange() {} },
    log: { info() {}, warn() {} },
    loop: (name, fps, fn) => { loops.push(name); renders.set(name, fn); },
    canvas: () => ({ clear() { return this; }, text(value) { drawn.push(String(value)); return this; } }),
    theme: () => ({ bg: '#000', text: '#fff', dim: '#bbb', warn: '#e80' }),
};
const cluster = {
    settings() {}, sample() {}, observeVehicle() {}, apply() {}, pollStatus() {}, badge() {}, close() {},
    clearHistory() { clearedMemory++; },
    setTraceSink() {},
    armPanel() { return false; },
    rendererStatus() { return ''; },
    status() { return { disarmReason: 'Selector N - P required', testGuard: 'Selector N - P required',
        rendererBackend: 'id7', ready: true, rendererTargets: 'panel:1920x720', panelActive: false,
        panelTarget: 'panel', activeTestMode: '', panelLayer: 'inactive', panelTargetState: 'idle',
        panelTargetReason: '', lastRefusal: '', gearPosition: 'N', speedKmh: 0, engineRpm: 780,
        sampleAgeSeconds: 65 }; },
};
class FakeCar { onSample() {} data() { return { stage: 'N' }; } }
class FakeCluster { constructor() { return cluster; } }
class FakePhone { setEnabled() {} reported() { return 'none'; } stop() {} }
class FakeWaze { constructor() { this.status = 'auto'; } setChoice() {} }
const report = () => { reportCount++; return { id: 'test', pages: ['page1', 'page2'], storedAt: [] }; };
const deps = {
    './kit/mgu': { run: ({ start }) => start(ctx) },
    './kit/car': FakeCar,
    './kit/gauges': { frame() {} },
    './cluster_layers.js': { ClusterLayers: FakeCluster },
    './phone_bridge.js': { PhoneBridge: FakePhone },
    './waze_control.js': { WazeControl: FakeWaze },
    './g80_preview.js': { drawG80Preview() {} },
    './sixwb_preview.js': { draw6WBPreview() {} },
    './cluster_colors.js': { resolveColor() { return []; }, resolve6WBColor() { return []; }, colorHex() { return ''; } },
    './kit/canvas': { withAlpha() { return ''; } },
    './cluster_diagnostics.js': { report, matrix: (data) => data, draw() {},
        startJournal() { return { path: '/tmp/mock-cluster-session.txt', write() { return true; },
            reset() {} }; },
        clearSaved() { cleared++; return { deleted: 2, errors: [], usbPreserved: true }; } },
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    require: (name) => { assert.ok(deps[name], 'unexpected dependency ' + name); return deps[name]; },
    process: { once() {} }, setInterval: () => 1, clearInterval() {},
    Date, Math, console,
}, { filename: 'custom_cluster/main.js' });
assert.deepStrictEqual(loops, ['MAIN']);
for (const screen of spec.screens) for (const [id] of screen.buttons)
    if (id !== 'BTN_SETTINGS') assert.ok(clicks.has(id), 'button handler missing: ' + id);

async function test() {
    await clicks.get('BTN_DIAG')();
    assert.strictEqual(labels.get('BTN_DIAG'), 'Back to cluster');
    await renders.get('MAIN')();
    assert.ok(drawn.some((x) => x.includes('Test guard: Selector N')), 'diagnostics drawn on MAIN');
    assert.ok(drawn.includes('image:MAIN_GFX'), 'must present on real MAIN image component');
    await clicks.get('BTN_DIAG')();
    assert.strictEqual(labels.get('BTN_DIAG'), 'Diagnostics');
    await clicks.get('BTN_QR')();
    assert.strictEqual(labels.get('BTN_QR'), 'Next QR page');
    await renders.get('MAIN')();
    assert.ok(drawn.some((x) => x.includes('Page 1 / 2')), 'QR image drawn on MAIN');
    assert.strictEqual(reportCount, 1);
    clicks.get('BTN_QR')();
    await renders.get('MAIN')();
    assert.ok(drawn.some((x) => x.includes('Page 2 / 2')), 'QR bar button cycles pages');
    clicks.get('BTN_QR')(); // wrap without closing the QR screen
    assert.strictEqual(reportCount, 1);
    await clicks.get('BTN_TEST')(); // back to cluster on QR page
    assert.strictEqual(labels.get('BTN_TEST'), 'Parked panel test');
    await clicks.get('BTN_QR')();
    assert.strictEqual(labels.get('BTN_QR'), 'Next QR page');
    assert.strictEqual(reportCount, 2);
    assert.strictEqual(labels.get('BTN_DIAG'), 'Delete logs');
    clicks.get('BTN_DIAG')();
    assert.strictEqual(labels.get('BTN_DIAG'), 'Confirm delete');
    assert.strictEqual(cleared, 0, 'first press cannot erase logs');
    clicks.get('BTN_DIAG')();
    assert.strictEqual(cleared, 1, 'confirmed press clears local exports');
    assert.strictEqual(clearedMemory, 1, 'confirmed press clears in-memory panel history');
    assert.strictEqual(labels.get('BTN_DIAG'), 'Delete logs');
    await renders.get('MAIN')();
    assert.ok(drawn.some((x) => x.includes('Deleted 2 local log file')), 'clear result visible');
    clicks.get('BTN_QR')();
    assert.strictEqual(reportCount, 3, 'new QR report still works after deletion');
    clicks.get('BTN_TEST')();
    clicks.get('BTN_DIAG')();
    assert.strictEqual(labels.get('BTN_DIAG'), 'Back to cluster');
    events[0]('MAIN', false);
    events[0]('MAIN', true); // Home/Settings/app tile returns to MAIN
    assert.strictEqual(labels.get('BTN_DIAG'), 'Diagnostics', 'fresh MAIN visibility must clear stale diagnostic view');
    assert.deepStrictEqual(pages, [], 'navigation must not call unreliable RHMI openState');
    assert.ok(events.length, 'HMI visibility should be logged');
    console.log('custom-cluster in-page HMI navigation and QR lifecycle tests passed');
}
test().catch((e) => { console.error(e); process.exitCode = 1; });
