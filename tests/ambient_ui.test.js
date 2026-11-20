'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const app = require('../apps/g21_ambient/app.json');
const catalog = require('../mgu-repo.json');
const { Recorder } = require('../kit/runtime/record');
const { theme } = require('../kit/runtime/themes');
const { KEY } = require('../apps/g21_ambient/ambient_profiles');

let start;
const load = Module._load;
Module._load = function(request, parent, ...rest) {
    if (parent && parent.filename.includes('/g21_ambient/')) {
        if (request === './kit/mgu') return { run: app => { start = app.start; } };
        if (request === './kit/gauges') return require('../kit/runtime/gauges');
        if (request === './kit/diag') return require('../kit/runtime/diag');
    }
    return load.call(this, request, parent, ...rest);
};
try { require('../apps/g21_ambient/main'); }
finally { Module._load = load; }

async function screen(initial = {}) {
    const values = Object.fromEntries(app.settings.map(setting => [setting.key, setting.default]));
    Object.assign(values, initial);
    const actions = {}, feeds = {};
    let draw, canvas, tab, touch, onChange, writes = 0;
    await start({
        settings: {
            get: key => values[key],
            set(key, value) { this.setMany({ [key]: value }); },
            setMany(changes) {
                if (!Object.keys(changes).some(key => values[key] !== changes[key])) return;
                Object.assign(values, changes);
                writes++;
                if (onChange) onChange();
            },
            onChange: fn => { onChange = fn; },
        },
        signals: {
            watch: async (_iface, _instance, handlers) => { Object.assign(feeds, handlers); },
            proxy: async () => { throw new Error('Test without TASU'); },
        },
        log: { info() {}, warn() {} },
        ui: { onClick: (key, fn) => { actions[key] = fn; }, image: () => {} },
        canvas: (w, h) => {
            canvas = new Recorder(w, h);
            canvas.own = true;
            return canvas;
        },
        theme: () => theme(),
        loop: (_page, _fps, fn) => { draw = fn; },
        onTab: fn => { tab = fn; },
        onTouch: fn => { touch = fn; },
    });
    const targets = () => { draw(); return canvas.targets; };
    return { actions, feeds, targets, touch, tab, values, saves: () => writes,
        press(key) {
            const target = targets().find(target => target.key === key);
            assert(target, 'missing controller/touch target: ' + key);
            return target.run();
        },
    };
}

test('Store and runtime expose one global temporary output and an offline menu plan', () => {
    assert.equal(catalog.components.find(entry => entry.id === app.id).version, app.version);
    assert(!app.settings.some(setting => setting.key === 'linId'));
    assert.deepEqual(app.settings.find(setting => setting.key === 'applyTarget').options.map(option => option[0]),
        ['temporary', 'slot11']);
    assert(!app.screens[0].buttons.some(([id]) => /ZONE|BDC_RESET/.test(id)));
});

test('touch drag commits its endpoint and legacy BDC selection opens the global RAM test', async () => {
    const ui = await screen({ applyTarget: 'bdc', linId: 8 });
    assert.equal(ui.values.applyTarget, 'temporary');
    assert.deepEqual(ui.targets().map(target => target.key), ['ram', 'slot', 'apply']);
    const previous = ui.saves();
    ui.touch(1, 145, 289);
    ui.touch(2, 380, 289);
    ui.touch(3, 635, 289);
    assert.equal(ui.values.customRed, 254);
    assert.equal(ui.values.colorMode, 'custom');
    assert.equal(ui.saves() - previous, 2);
    ui.touch(1, 560, 425);
    ui.touch(3, 145, 425);
    assert.equal(ui.values.brightness, 0);
    ui.press('slot');
    await ui.press('apply');
    assert.equal(ui.values.applyTarget, 'slot11');
    assert(ui.targets().some(target => target.key === 'factory'));
});

test('favorites and follow-mode recall restore editor values including Off', async () => {
    const ui = await screen({ presetColor: '5', brightness: 75 });
    ui.tab(1);
    ui.press('favorite-2');
    ui.press('save-fav');
    assert.equal(JSON.parse(ui.values[KEY]).favorites[2].main.on, 0);
    ui.tab(0);
    ui.actions.BTN_COLOR();
    assert.equal(ui.values.presetColor, '0');
    ui.tab(1);
    ui.press('load-fav');
    assert.equal(ui.values.presetColor, '5');
    ui.tab(2);
    ui.press('mode-comfort');
    ui.press('save-mode');
    ui.tab(0);
    ui.actions.BTN_COLOR();
    ui.tab(2);
    ui.feeds.statusFESVehicleDynamicSwitchHMI({ actualValueModeDrivingExperience: 4 });
    ui.press('follow-mode');
    assert.equal(ui.values.presetColor, '5');
    ui.tab(3);
    assert.deepEqual(ui.targets().map(target => target.key), ['read-ram', 'read-bdc']);
    await ui.press('read-ram');
    await ui.press('read-bdc');
    ui.actions.BTN_PAGE();
    assert.deepEqual(ui.targets().map(target => target.key), ['ram', 'slot', 'apply']);
});
