'use strict';
// 0.7.1 centre-screen main page: live KOMBI miniature + status cards render for
// every layout and state, stay inside the page, and reuse cached faces.
const assert = require('assert');
const Module = require('module');
const resolve0 = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    const map = { './kit/canvas': 'canvas', './kit/gauges': 'gauges' }[req];
    if (map && parent && /custom_cluster/.test(parent.filename)) return require.resolve('../kit/runtime/' + map + '.js');
    return resolve0.call(this, req, parent, ...rest);
};
const { Canvas } = require('../kit/runtime/canvas.js');
const G = require('../kit/runtime/gauges.js');
const T = require('../kit/runtime/themes.js');
const P = require('../apps/custom_cluster/main_page.js');

const base = { ready: true, parked: true, live: true, gearLabel: 'P', speedKmh: 0, engineRpm: 790, sampleAgeSeconds: 1,
    testGuard: 'Ready: real speed/RPM, stopped, selector P', autoMode: 'off', secondsLeft: 0, panelTargetState: 'idle' };
const states = {
    idle: {}, test: { panelActive: true, secondsLeft: 7 }, auto: { panelActive: true, autoRun: true },
    intro: { panelActive: true, introPlaying: true },
    driving: { parked: false, gearLabel: 'D', speedKmh: 52, engineRpm: 1900, testGuard: 'Selector D - P required' },
    offline: { ready: false, live: false, sampleAgeSeconds: null, speedKmh: null, engineRpm: null, gearLabel: null },
};
const sum = (cv, x, y, w, h) => { let s = 0; for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) s += cv.d[(j * cv.w + i) * 4]; return s; };
for (const layout of ['stock', 'sixwb', 'oem', 'g80', 'sport', 'classic', 'minimal']) {
    for (const [name, extra] of Object.entries(states)) {
        const st = Object.assign({}, base, extra);
        const t = T.theme('m_tricolour'), cv = new Canvas(1600, 520).clear(t.bg);
        P.renderMainPage(cv, t, G, { st, layout, accentHex: '#4db8ff', data: { speed: st.speedKmh, rpm: st.engineRpm, stage: st.gearLabel, oil: 90, coolant: 88 },
            waze: 'Waze: unchanged', driveMode: 'Comfort', intro: 'once per start · sweep', testNotice: 'Select a layout', sixwbTheme: 'comfort' }, Canvas);
        assert.ok(sum(cv, P.MINI.x, P.MINI.y, P.MINI.w, P.MINI.h) > 0, layout + '/' + name + ': miniature drawn');
        assert.ok(sum(cv, 1100, 52, 476, 400) > 0, layout + '/' + name + ': status cards drawn');
    }
}
// Faces are cached: a second frame is much cheaper than the first.
const t = T.theme(), st = Object.assign({}, base), m = { st, layout: 'classic', accentHex: '#ff3344', data: { speed: 0, rpm: 800 },
    waze: '', driveMode: 'Sport', intro: 'off', testNotice: '', sixwbTheme: 'sport' };
let t0 = Date.now(); P.renderMainPage(new Canvas(1600, 520), t, G, m, Canvas); const first = Date.now() - t0;
t0 = Date.now(); P.renderMainPage(new Canvas(1600, 520), t, G, m, Canvas); const again = Date.now() - t0;
assert.ok(again <= first + 5, 'cached faces');
assert.ok(again < 250, 'a 2 Hz page frame stays cheap (' + again + ' ms)');
console.log('Custom Cluster main page tests passed');
