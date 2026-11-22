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

async function screen(initial = {}, own = true) {
    const values = Object.fromEntries(app.settings.map(setting => [setting.key, setting.default]));
    Object.assign(values, initial);
    const actions = {}, feeds = {}, hidden = [];
    let draw, canvas, tab, touch, scroll, onChange, editor, writes = 0;
    let drawn = [];
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
            canvas.own = own;
            drawn = [];
            const paint = canvas.text.bind(canvas);
            canvas.text = (value, ...args) => { drawn.push(String(value)); return paint(value, ...args); };
            return canvas;
        },
        theme: () => theme(),
        loop: (_page, _fps, fn) => { draw = fn; },
        onTab: fn => { tab = fn; },
        onTouch: fn => { touch = fn; },
        ...(initial.useScroll ? {onScroll: fn => { scroll = fn; }} : {}),
        hideButton: id => hidden.push(id),
        sheet: sheet => { if (own) editor = sheet; return own; },
    });
    const targets = () => { draw(); return canvas.targets; };
    return { actions, feeds, targets, touch, scroll, tab, values, hidden, drawn() { draw(); return drawn; }, editor: () => editor, saves: () => writes,
        press(key) {
            const target = targets().find(target => target.key === key);
            assert(target, 'missing controller/touch target: ' + key);
            return target.run();
        },
    };
}

test('only the native fallback navigation and Settings are built into the main screen', async () => {
    assert.equal(catalog.components.find(entry => entry.id === app.id).version, app.version);
    assert(!app.settings.some(setting => ['linId', 'applyTarget'].includes(setting.key)));
    assert.deepEqual(app.screens[0].buttons.map(([id]) => id),
        ['BTN_PAGE', 'BTN_PREV', 'BTN_NEXT', 'BTN_ACTION', 'BTN_SETTINGS']);
    const ui = await screen();
    assert.deepEqual(ui.hidden, ['BTN_PAGE', 'BTN_PREV', 'BTN_NEXT', 'BTN_ACTION']);
});

test('color has direct presets, touch sliders and exact controller editing', async () => {
    const ui = await screen({ applyTarget: 'slot11' });
    assert(ui.targets().some(target => target.key === 'apply'));
    assert(!ui.targets().some(target => /plan/i.test(target.key)));
    ui.press('preset-1');
    assert.equal(ui.values.presetColor, '1');
    const previous = ui.saves();
    ui.touch(1, 155, 315);
    ui.touch(2, 380, 315);
    ui.touch(3, 600, 315);
    assert.equal(ui.values.customRed, 254);
    assert.equal(ui.values.colorMode, 'custom');
    assert.equal(ui.saves() - previous, 1);
    ui.touch(1, 550, 455);
    ui.touch(3, 155, 455);
    assert.equal(ui.values.brightness, 0);
    ui.press('customRed');
    ui.editor().move(-9);
    assert.equal(ui.values.customRed, 254);
    assert.equal(ui.editor().back(), 'close');
    assert.equal(ui.values.customRed, 254);
    ui.press('customRed');
    ui.editor().move(-5);
    assert.equal(ui.editor().press(), 'close');
    assert.equal(ui.values.customRed, 249);
});

test('the native fallback selects presets, edits a value and cancels on page change', async () => {
    const ui = await screen({}, false);
    const { BTN_NEXT: next, BTN_PREV: previous, BTN_ACTION: select, BTN_PAGE: page } = ui.actions;
    assert.deepEqual(ui.targets(), []);
    next();
    select();
    assert.equal(ui.values.presetColor, '1');
    for (let i = 0; i < 5; i++) next();
    select();
    next();
    next();
    previous();
    assert.equal(ui.values.colorMode, 'preset');
    select();
    assert.equal(ui.values.customRed, 1);
    select();
    next();
    page();
    ui.targets();
    assert.equal(ui.values.customRed, 1);
    assert.deepEqual(ui.targets(), []);
});

test('favorites and follow-mode recall restore editor values including Off', async () => {
    const ui = await screen({ presetColor: '5', brightness: 75 });
    ui.tab(1);
    ui.press('favorite-2');
    assert(!ui.targets().some(target => target.key === 'load-fav'));
    ui.press('save-fav');
    assert.equal(JSON.parse(ui.values[KEY]).favorites[2].main.on, 0);
    ui.tab(0);
    ui.press('preset-0');
    assert.equal(ui.values.presetColor, '0');
    ui.tab(1);
    ui.press('load-fav');
    assert.equal(ui.values.presetColor, '5');
    ui.tab(2);
    ui.press('mode-comfort');
    ui.press('save-mode');
    ui.tab(0);
    ui.press('preset-0');
    ui.tab(2);
    ui.feeds.statusFESVehicleDynamicSwitchHMI({ actualValueModeDrivingExperience: 4 });
    ui.press('follow-mode');
    assert.equal(ui.values.presetColor, '5');
});

test('diagnostic views remain separate and Menu 11 remains offline', async () => {
    const ui = await screen();
    ui.tab(3);
    assert(ui.targets().some(target => target.key === 'diagnostics-start'));
    await ui.press('diagnostics-start');
    assert(ui.drawn().some(line => line.includes('TASU unavailable')));
    ui.press('diag-ram');
    await ui.press('read-ram');
    ui.press('diag-lin1');
    await ui.press('read-bdc');
    ui.press('lin-raw');
    assert(ui.drawn().includes('No response captured'));
    ui.press('diag-plan');
    ui.press('current-plan');
    assert(ui.drawn().some(line => line.includes('mapping unverified')));
    ui.press('factory-plan');
    assert(ui.drawn().some(line => line.includes('Factory profile')));
    assert.equal(ui.saves(), 0);
});

test('live log scrolls by targets, touch and renderer controller hook; QR exports open', async () => {
    for (const useScroll of [false, true]) {
        const ui = await screen({useScroll});
        ui.tab(3);
        for (let i = 0; i < 12; i++) await ui.press('diagnostics-start');
        ui.tab(4);
        const footer = () => ui.drawn().find(line => line.includes('lines') && line.includes('Swipe'));
        const latest = footer();
        ui.press('BTN_LOG_UP');
        const older = footer();
        assert.notEqual(older, latest);
        ui.press('BTN_LOG_DOWN');
        assert.equal(footer(), latest);
        if (useScroll) ui.scroll(-70);
        else { ui.touch(1, 900, 245); ui.touch(2, 900, 330); ui.touch(3, 900, 330); }
        assert.notEqual(footer(), latest);
        ui.press('BTN_LOG_LATEST');
        assert.equal(footer(), latest);
        ui.press('log-export');
        assert(ui.drawn().some(line => line.includes('QR 1 /')));
        ui.press('qr-json');
        assert(ui.drawn().some(line => line.includes('JSON')));
        ui.press('qr-back');
        ui.press('log-clear');
        assert.match(footer(), /0–0 \/ 0/);
    }
});
