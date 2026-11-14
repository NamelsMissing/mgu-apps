'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { ClusterLayers } = require('../apps/custom_cluster/cluster_layers');
const QR = require('../apps/custom_cluster/cluster_diagnostics');

class FakeRenderer extends EventEmitter {
    constructor(targets) {
        super();
        this.backend = 'id7';
        this.targets = targets || 'map:1088x480,panel:1920x720';
        this.effects = [];
        this.drops = [];
        this.uniforms = [];
        this.sets = [];
        this.operations = [];
        this.statusRequests = 0;
    }
    connect() { this.emit('ready'); }
    close() {}
    effect(options) { this.effects.push(options); this.operations.push(['effect',this.effects.length]); return this.effects.length; }
    uniform(ref, name, value) { this.uniforms.push({ ref, name, value }); this.operations.push(['uniform',ref]); }
    set(ref, opts) { this.sets.push({ref,opts}); this.operations.push(['set',ref]); }
    drop(ref) { this.drops.push(ref); }
    status() { this.statusRequests++; }
}
const log = { info() {}, warn() {} };
const settings = (more) => Object.assign({
    layout: 'g80', panelTestMode: 'probe', panelTarget: 'panel',
    accent: 'm', sixwbTheme: 'comfort', sixwbColorSource: 'original',
    colorMode: 'palette', colorBrightness: 100,
    wazeMap: 'auto', phoneBadge: false,
}, more || {});

function parked(c) { c.sample({ speed: 0, rpm: 790, stage: 'P', gear: 0 }); }

const fake = new FakeRenderer();
const cluster = new ClusterLayers(log, null, fake);
cluster.settings(settings());
assert.strictEqual(cluster.status().ready, true);
assert.strictEqual(cluster.status().panelActive, false);
assert.ok(cluster.status().testGuard.includes('no complete sample'), 'reason distinguishes missing vehicle telemetry');
assert.strictEqual(cluster.armPanel(), false, 'no car signal should not activate panel');
assert.strictEqual(cluster.status().disarmReason, cluster.status().testGuard);
parked(cluster);
assert.ok(cluster.status().testGuard.startsWith('Ready:'), 'parked car with live data may test');
assert.strictEqual(cluster.armPanel(), true);
assert.strictEqual(cluster.status().panelActive, true);
assert.strictEqual(cluster.status().panelLayer, 'requesting', 'created does not mean shown');
assert.strictEqual(fake.effects[0].target, 'panel');
assert.strictEqual(fake.effects[0].klass, 'overlay');
assert.strictEqual(fake.effects[0].x, 86);
assert.strictEqual(fake.effects[0].w, 260, 'small marker, not whole panel');
assert.ok(fake.effects[0].x + fake.effects[0].w < 416,
    'the diagnostic effect never overlaps the native map aperture');
assert.strictEqual(fake.effects[0].contend, false);
assert.strictEqual(fake.effects[0].visible, false);
assert.strictEqual(fake.sets[0].opts.visible,true);
fake.emit('layer', 1, 'shown', '');
fake.emit('target', 'panel', 'mapped', 'custom_cluster', '');
fake.emit('status', 'slot 0x203 status 3: content class 2 map 1');
assert.ok(cluster.history().includes('during test: slot 0x203'),
    'record renderer slot state while a panel test is active');
assert.strictEqual(cluster.status().panelLayer, 'shown');
assert.strictEqual(cluster.status().panelTargetState, 'mapped (custom_cluster)');
assert.ok(cluster.rendererStatus().includes('0x203'));
assert.strictEqual(cluster.armPanel(), false, 'press again stops');
assert.deepStrictEqual(fake.drops, [1]);
assert.strictEqual(cluster.status().suspended, true, 'release stops recreation');
assert.ok(cluster.status().recoveryState.includes('unverified'), 'never claim stock media restored');
fake.emit('status', 'target panel slot 0x203 scene 0x01000400 1920x720: idle; scene published');
assert.ok(cluster.status().recoveryState.includes('BMW media NOT verified'));
assert.ok(cluster.history().includes('test ended: Stopped by user'));

cluster.settings(settings({ panelTestMode: 'design', panelTarget: 'panel201', layout: 'sixwb' }));
assert.strictEqual(cluster.armPanel(), false, 'unsupported slot must not be requested');
assert.ok(/not advertised/.test(cluster.status().disarmReason));
cluster.settings(settings({ panelTestMode: 'design', layout: 'sixwb' }));
assert.strictEqual(cluster.armPanel(), true);
assert.strictEqual(fake.effects.length,4,'three separate small layers');
assert.ok(fake.effects.slice(1).every(p=>p.x+p.w<416 && p.contend===false && p.visible===false),'small hidden non-contending effects outside map');
const testOps=fake.operations.slice(fake.operations.findIndex(o=>o[0]==='effect'&&o[1]===2));
assert.ok(testOps.slice(testOps.findIndex(o=>o[0]==='set')).every(o=>o[0]==='set'),'initialize all pieces before showing');
cluster.observeVehicle({ stage: 'N' });
assert.strictEqual(cluster.status().panelActive, false, 'leaving P drops full design');
assert.ok(cluster.status().testGuard.includes('Selector N'), 'guard identifies neutral instead of P');
assert.deepStrictEqual(fake.drops, [1, 2, 3, 4]);
fake.emit('status', 'slot 0x203 status 3: content class 2 map 1');

const signalCheck = new ClusterLayers(log, null, new FakeRenderer());
signalCheck.settings(settings());
signalCheck.sample({ speed: 0, rpm: 790, stage: 'P', receivedAt: {
    speed: Date.now() - 190000, rpm: Date.now() } });
assert.strictEqual(signalCheck.armPanel(), false, 'stale speed with fresh RPM must not pass');
signalCheck.sample({ speed: 0, rpm: 790, stage: 'P', receivedAt: {
    speed: Date.now(), rpm: Date.now() } });
assert.strictEqual(signalCheck.armPanel(), true, 'two fresh getter responses enable parked probe');
signalCheck.restoreOriginal();
assert.strictEqual(signalCheck.status().panelActive, false);
signalCheck.close();

const altRenderer = new FakeRenderer('panel:1920x720, panel201:1920x720, panel202:1920x720');
const altCluster = new ClusterLayers(log, null, altRenderer);
altCluster.settings(settings({ panelTarget: 'panel201', panelTestMode: 'probe' }));
parked(altCluster);
assert.strictEqual(altCluster.armPanel(), true, 'advertised alternative slot may be tested in P');
assert.strictEqual(altRenderer.effects[0].target, 'panel201');
altCluster.close();

// A physical P report must never be mislabelled N simply because the engine
// and speed notifications have gone quiet. The full-panel guard still blocks.
const staleCluster = new ClusterLayers(log, null, new FakeRenderer());
staleCluster.settings(settings());
parked(staleCluster);
staleCluster.lastSample = Date.now() - 31000;
assert.strictEqual(staleCluster.status().gearPosition, 'P');
assert.strictEqual(staleCluster.status().gearP, true);
assert.strictEqual(staleCluster.status().live, false);
assert.strictEqual(staleCluster.status().parked, false);
assert.ok(staleCluster.status().sampleAgeSeconds >= 31);
assert.ok(staleCluster.status().testGuard.includes('stale'));
assert.strictEqual(staleCluster.armPanel(), false, 'stale telemetry never enables a panel test');
staleCluster.close();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-qr-test-'));
const ctx = { dataDir: tempDir, spec: { version: '0.6.2' } };
const journal = QR.startJournal(ctx);
assert.ok(journal.path && fs.existsSync(journal.path), 'open app creates a text log without QR');
assert.ok(/cluster-session-.*\.txt$/.test(journal.path));
assert.ok(journal.write('test panel event'), 'session appends a renderer event');
assert.ok(fs.readFileSync(journal.path, 'utf8').includes('test panel event'));
const previousJournal = journal.path;
const nextJournal = QR.startJournal(ctx);
assert.ok(!fs.existsSync(previousJournal),'old automatic session removed on start');
assert.ok(fs.existsSync(nextJournal.path),'new session exists');
const oldJournal = nextJournal.path;
const testReport = QR.report(ctx, cluster, 'auto', 'none');
assert.ok(testReport.pages.length > 0);
const payloads = testReport.pages.map((page, idx) => {
    const m = /^CCLOG1 ([a-f0-9]{10}) (\d+)\/(\d+) ([A-Za-z0-9+/=]+)$/.exec(page);
    assert.ok(m, 'header is machine readable');
    assert.strictEqual(Number(m[2]), idx + 1);
    assert.strictEqual(Number(m[3]), testReport.pages.length);
    return m[4];
});
const decoded = zlib.inflateSync(Buffer.from(payloads.join(''), 'base64')).toString('utf8');
assert.ok(decoded.includes('CUSTOM CLUSTER DIAGNOSTICS'));
assert.ok(decoded.includes('slot 0x203'));
assert.ok(decoded.includes('PANEL TEST EVENT HISTORY'));
assert.ok(decoded.includes('test ended: Stopped by user'));
assert.ok(QR.matrix(testReport.pages[0]).getModuleCount() > 0);
assert.strictEqual(testReport.storedAt.length > 0, true);
const exportDir = path.join(tempDir, 'exports');
const unrelated = path.join(exportDir, 'keep-other-app.log');
fs.writeFileSync(unrelated, 'must survive');
const lookalike = path.join(exportDir, 'cluster-diagnostics-custom.txt');
fs.writeFileSync(lookalike, 'must survive');
const targetOutside = path.join(tempDir, 'keep-original.txt');
fs.writeFileSync(targetOutside, 'outside');
const symlink = path.join(exportDir, 'cluster-diagnostics-2026-11-10T10-20-30-000Z.txt');
fs.symlinkSync(targetOutside, symlink);
const erased = QR.clearSaved(ctx);
assert.strictEqual(erased.deleted, 2, 'only this app\'s QR export and session log are deleted');
assert.strictEqual(erased.errors.length, 0);
assert.ok(!fs.existsSync(oldJournal), 'session log deleted');
assert.ok(fs.existsSync(unrelated), 'other apps\' files remain');
assert.ok(fs.existsSync(lookalike), 'a similar but non-app filename remains');
assert.ok(fs.existsSync(targetOutside), 'external targets remain');
assert.ok(fs.lstatSync(symlink).isSymbolicLink(), 'do not follow or delete symlinks');
assert.strictEqual(QR.clearSaved(ctx).deleted, 0, 'repeated delete is safe');
journal.reset();
assert.ok(journal.path && fs.existsSync(journal.path), 'journal resets after clearing logs');
cluster.clearHistory();
assert.strictEqual(cluster.history(), '(no panel events yet)', 'clear removes in-memory history only');
cluster.close();
console.log('custom-cluster staged render and QR diagnostics tests passed');
