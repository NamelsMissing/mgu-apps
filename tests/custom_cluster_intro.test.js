'use strict';
// 0.7.0: start-up intro, needle sweep, eased gauges, driving-mode colours, and
// coexistence with Cluster Lyrics (exclusive and "with Waze") on one renderer.
const assert = require('assert');
// The store build bundles kit/runtime as ./kit; map it for this test.
const Module = require('module');
const resolve0 = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === './kit/canvas' && parent && /custom_cluster/.test(parent.filename))
        return require.resolve('../kit/runtime/canvas.js');
    return resolve0.call(this, req, parent, ...rest);
};
const EventEmitter = require('events');
const path = require('path');
const { ClusterLayers } = require('../apps/custom_cluster/cluster_layers');
const Intro = require('../apps/custom_cluster/intro_shader');
const L = require('../apps/custom_cluster/layout_panels');
const { GaugeMotion, sweepValue } = require('../apps/custom_cluster/gauge_motion');
const { resolveColor, colorHex, followsDriveMode } = require('../apps/custom_cluster/cluster_colors');
const K = require(path.join(__dirname, '..', 'apps', 'cluster_lyrics', 'kombi.js'));

// One render service shared by every app: layers of all clients in one table.
const service = { layers: new Map(), log: [] };
let nextRef = 1;
class SharedRenderer extends EventEmitter {
    constructor(app) { super(); this.app = app || 'custom_cluster'; this.backend = 'id7';
        this.targets = 'map:1088x480,panel:1920x720'; this.ready = false; this.handlers = {}; this.mine = new Map(); }
    connect() { this.ready = true; this.emit('ready'); } close() {}
    _add(kind, o) { const r = nextRef++; const l = Object.assign({ kind, app: this.app, uniforms: {} }, o);
        this.mine.set(r, l); service.layers.set(this.app + ':' + r, l); return r; }
    effect(o) { return this._add('effect', o); }
    image(o) { return this._add('image', o); }
    pixels(r, rects, px) { const l = this.mine.get(r); if (!l) return false; l.uploads = (l.uploads || 0) + 1;
        if (!rects) assert.strictEqual(px.length, (l.iw || l.w) * (l.ih || l.h) * 4, 'payload size'); return true; }
    uniform(r, n, v) { const l = this.mine.get(r); if (l) { l.uniforms[n] = v.slice(); (l.history = l.history || []).push([n, v[0]]); } }
    set(r, o) { const l = this.mine.get(r); if (l) Object.assign(l, o); }
    drop(r) { this.mine.delete(r); service.layers.delete(this.app + ':' + r); }
    status() {}
}
// The lyrics client registers its handlers with on(); keep EventEmitter semantics.
const real = Date.now;
let clock = real();
Date.now = () => clock;
const log = { info() {}, warn() {} };
const settings = (more) => Object.assign({ layout: 'oem', panelTestMode: 'selected_layout', panelTarget: 'panel',
    accent: 'm', colorMode: 'palette', colorBrightness: 100, sixwbTheme: 'comfort', sixwbColorSource: 'original',
    enablePanelTests: true, kombiAuto: 'off', coverOriginal: true, intro: 'start', needleSweep: true }, more || {});
const ours = () => [...service.layers.values()].filter(l => l.app === 'custom_cluster');
const intros = () => ours().filter(l => l.w === Intro.RECT.w);
const steady = () => ours().filter(l => l.w !== Intro.RECT.w);
const parked = (c, rpm) => c.sample({ speed: 0, rpm: rpm || 790, stage: 'P', gear: 0, receivedAt: { speed: clock, rpm: clock } });
function run(c, ms, rpm) { const end = clock + ms; while (clock < end) { clock += 33; if (clock % 250 < 33) { parked(c, rpm); c.apply(); } c.tickAnimation(clock); } }

try {
    // --- shader text: original, bounded, draws the layout's own contours
    const fs = Intro.introShader(L.outlines('oem'));
    assert.ok(/uniform float u_t;/.test(fs) && /uniform vec4 u_accent;/.test(fs));
    assert.strictEqual((fs.match(/  seg\(p,/g) || []).length, 2 * (L.path('oem', L.SIDES[0]).length - 1), 'one segment per contour edge');
    assert.ok(!/sampler2D|texture2D/.test(fs), 'no textures: nothing but our own procedural art');
    assert.ok(Intro.RECT.y >= 48 && Intro.RECT.y + Intro.RECT.h <= 600, 'telltale row and bottom strip stay free');
    assert.ok(L.outlines('classic').every(pts => pts.every(p => p[0] < 416 || p[0] > 1504)), 'contours in the side areas');

    // --- motion: eased by time, sweep to full and back
    {
        const sent = [];
        const m = new GaugeMotion({ uniform: (r, n, v) => sent.push(v[0]) }, 0);
        m.add(7, 0.2);
        m.setTarget(7, 0.6);
        m.tick(33);
        assert.ok(sent[0] > 0.2 && sent[0] < 0.6, 'eases, does not jump');
        for (let t = 66; t < 2000; t += 33) m.tick(t);
        assert.ok(Math.abs(sent[sent.length - 1] - 0.6) < 0.002, 'arrives');
        assert.strictEqual(sweepValue(700), 1);
        assert.strictEqual(sweepValue(1400), 0);
        sent.length = 0;
        m.sweep(3000);
        for (let t = 2000; t < 5000; t += 33) m.tick(t);
        assert.ok(Math.max(...sent) > 0.99, 'sweep reaches full scale');
        assert.ok(Math.abs(sent[sent.length - 1] - 0.6) < 0.002, 'and returns to the live value');
    }

    // --- Custom Cluster with Cluster Lyrics (exclusive) on the same renderer
    const lyrics = new K.KombiLyrics(log, { ClusterRender: SharedRenderer, now: () => clock, trace() {} });
    lyrics.cr.app = 'cluster_lyrics';
    lyrics.show({ title: 'Song', artist: 'Artist', current: 'Line one', next: 'Line two', gap: false });
    lyrics.start();
    const lyr = () => [...service.layers.values()].filter(l => l.app === 'cluster_lyrics');
    assert.ok(lyr().length >= 4 && lyr().every(l => l.target === 'map'), 'lyrics only in the map window');

    const c = new ClusterLayers(log, null, new SharedRenderer('custom_cluster'));
    c.settings(settings());
    parked(c);
    const armed = c.armPanel();
    assert.strictEqual(armed, true, 'parked test starts');
    assert.strictEqual(intros().length, 1, 'intro on the first show');
    assert.ok(c.status().introPlaying);
    const intro = intros()[0];
    assert.strictEqual(intro.z, 30, 'intro above the layout');
    assert.strictEqual(intro.contend, false);
    assert.strictEqual(intro.target, 'panel', 'never the map target: lyrics/Waze layers are untouched');
    assert.ok(steady().every(l => l.x + l.w <= 416 || l.x >= 1504), 'layout keeps the centre free');
    assert.ok(ours().every(l => l.visible === true), 'all shown after initialisation');
    run(c, 3000);
    assert.ok(intro.uniforms.u_t[0] > 2.5 && intro.uniforms.u_t[0] < 3.5, 'intro clock runs');
    assert.ok(lyr().every(l => l.visible === true), 'lyrics still shown while the intro plays');
    run(c, 5000);
    assert.strictEqual(intros().length, 0, 'intro layer dropped after 7.3 s');
    assert.strictEqual(c.status().panelActive, true, 'layout stays');
    const bands = steady().filter(l => l.kind === 'effect' && /u_fraction/.test(l.fs || ''));
    assert.strictEqual(bands.length, 2);
    bands.forEach(b => {
        const h = b.history.filter(x => x[0] === 'u_fraction').map(x => x[1]);
        assert.ok(Math.max(...h) > 0.99, 'needle sweep under the fading intro');
        assert.ok(h[h.length - 1] < 0.2, 'back to the live value');
    });
    // smooth: a jump in RPM arrives over several uniform messages
    const rpmBand = bands.find(b => b.x >= 1504), before = rpmBand.history.length;
    run(c, 600, 3000);
    const steps = rpmBand.history.slice(before).map(x => x[1]);
    assert.ok(steps.length >= 4 && Math.abs(steps[steps.length - 1] - 0.5) < 0.01, 'eased to 3000 rpm');

    // driving mode: colour follows Sport without rebuilding layers
    c.settings(settings({ colorMode: 'drive' }));
    parked(c);
    assert.strictEqual(c.status().panelActive, false, 'a settings change releases the test (as before)');
    clock += 1000;
    c.cr.emit('status', 'target panel: slot 0x203 scene 0x1 1920x720: idle; scene published\nslot 0x203 status 1: 0x1 class 0 map 0');
    parked(c);
    assert.strictEqual(c.armPanel(), true);
    assert.strictEqual(intros().length, 0, "'once per start': no second intro in the same process");
    const count = ours().length;
    c.setDriveMode('sport');
    assert.strictEqual(ours().length, count, 'recoloured in place');
    const sportHex = colorHex(resolveColor({ colorMode: 'drive', driveMode: 'sport' }));
    assert.ok(steady().some(l => l.uniforms.u_color && colorHex(l.uniforms.u_color) === sportHex), 'sport colour sent');
    assert.ok(followsDriveMode({ layout: 'sixwb', sixwbTheme: 'drive' }));
    assert.strictEqual(c.status().driveMode, 'sport');

    // leaving P during an intro drops everything, intro included
    c.restoreOriginal();
    c.settings(settings({ intro: 'always', colorMode: 'drive' }));
    clock += 1000;
    c.cr.emit('status', 'target panel: slot 0x203 scene 0x1 1920x720: idle; scene published\nslot 0x203 status 1: 0x1 class 0 map 0');
    parked(c);
    assert.strictEqual(c.armPanel(), true);
    assert.strictEqual(intros().length, 1, "'every time' plays again");
    c.sample({ speed: 0, rpm: 800, stage: 'D', gear: 1, receivedAt: { speed: clock, rpm: clock } });
    assert.strictEqual(ours().length, 0, 'leaving P releases layout and intro');
    assert.ok(lyr().length >= 4, 'lyrics layers untouched');

    // 6WB gets the intro and sweep too
    c.settings(settings({ layout: 'sixwb', intro: 'always' }));
    clock += 1000;
    c.cr.emit('status', 'target panel: slot 0x203 scene 0x1 1920x720: idle; scene published\nslot 0x203 status 1: 0x1 class 0 map 0');
    parked(c);
    assert.strictEqual(c.armPanel(), true);
    assert.strictEqual(intros().length, 1);
    c.restoreOriginal();

    // intro off
    c.settings(settings({ intro: 'off' }));
    clock += 1000;
    c.cr.emit('status', 'target panel: slot 0x203 scene 0x1 1920x720: idle; scene published\nslot 0x203 status 1: 0x1 class 0 map 0');
    parked(c);
    assert.strictEqual(c.armPanel(), true);
    assert.strictEqual(intros().length, 0, 'off');

    // --- lyrics "with Waze": transparent footer, guide_hold on, never contending, still beside our layout
    lyrics.configure({ layoutMode: 'withWaze' });
    lyrics.show({ title: 'Song', artist: 'Artist', current: 'Line three', next: 'Line four', gap: false });
    const footer = lyr();
    assert.strictEqual(footer.length, 1, 'one compact footer');
    assert.ok(footer.every(l => l.target === 'map' && l.contend === false && l.guide_hold === true && !l.exclusive),
        'Waze keeps its map; lyrics only add the footer');
    assert.ok(ours().every(l => l.target === 'panel' && l.contend === false));
    // Renderer limits: 64 layers per app, 96 together (Cluster Layouts README).
    assert.ok(ours().length + 1 <= 64, 'layout plus intro well inside the per-app limit');
    assert.ok(service.layers.size + 1 <= 96, 'plenty of room for Waze on cluster');
    c.close();
    console.log('Custom Cluster intro, sweep, motion, driving-mode colour and lyrics/Waze coexistence tests passed');
} finally {
    Date.now = real;
}
