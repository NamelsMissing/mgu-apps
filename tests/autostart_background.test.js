'use strict';
// Autostart of dashboard apps: manifest, safe defaults, status file.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const app = (id) => JSON.parse(read('apps/' + id + '/app.json'));
const setting = (spec, key) => spec.settings.find((s) => s.key === key);

for (const id of ['custom_cluster', 'cluster_lyrics', 'blitzer_status']) {
    assert.strictEqual(app(id).mguAppStartType, 'autostart', id + ' starts with the car');
    assert.ok(new RegExp('AUTOSTART_APPS = \\([^)]*"' + id + '"').test(read('tools/build_wheelheat_autostart.py')), id + ' is on the build list');
    assert.ok(fs.existsSync(path.join(root, 'apps', id, 'background_status.js')));
}
// Starting with the car must change nothing visible by itself.
const cc = app('custom_cluster'), cl = app('cluster_lyrics'), bs = app('blitzer_status');
assert.strictEqual(setting(cc, 'kombiAuto').default, 'off');
assert.strictEqual(setting(cc, 'layout').default, 'stock');
assert.strictEqual(setting(cc, 'enablePanelTests').default, false);
for (const key of ['phoneBridge', 'phoneBadge']) {
    assert.strictEqual(setting(cc, key), undefined, key + ' moved out of Custom Cluster');
    assert.strictEqual(setting(bs, key).default, false);
}
assert.strictEqual(setting(cl, 'kombiOn').default, false);
assert.deepStrictEqual(setting(cc, 'kombiAuto').options.map((o) => o[0]), ['off', 'parked']);
assert.strictEqual(setting(cc, 'gearDisplay').default, 'gear');
assert.deepStrictEqual(setting(cc, 'gearDisplay').options.map((o) => o[0]), ['selector', 'gear', 'gear_estimate']);

const { BackgroundStatus } = require('../apps/custom_cluster/background_status');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
let t = 5000000;
const b = new BackgroundStatus({ dir, file: 'x-background.json', version: '9.9.9', startReason: 'autostart', now: () => t });
assert.strictEqual(b.update({ a: 1 }), true);
let doc = JSON.parse(fs.readFileSync(path.join(dir, 'x-background.json'), 'utf8'));
assert.strictEqual(doc.startReason, 'autostart');
assert.strictEqual(doc.windowOpenedYet, false, 'shows that it ran before the menu was opened');
assert.strictEqual(doc.pid, process.pid);
assert.strictEqual(b.update({ a: 1 }), false, 'unchanged: no write');
t += 500; assert.strictEqual(b.update({ a: 2 }), false, 'at most once per second');
t += 600; b.seen(); assert.strictEqual(b.update({ a: 2 }), true);
doc = JSON.parse(fs.readFileSync(path.join(dir, 'x-background.json'), 'utf8'));
assert.strictEqual(doc.windowOpenedYet, true);
assert.deepStrictEqual(doc.details, { a: 2 });
assert.ok(!fs.existsSync(path.join(dir, 'x-background.json.tmp')));
const bad = new BackgroundStatus({ dir: path.join(dir, 'missing'), file: 'x.json', version: '1' });
assert.strictEqual(bad.update({ a: 1 }), false, 'a write error never throws');
assert.ok(bad.error);
assert.strictEqual(fs.readFileSync(path.join(root, 'apps/custom_cluster/background_status.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'apps/cluster_lyrics/background_status.js'), 'utf8'), 'both copies identical');
console.log('autostart / background status tests passed');
