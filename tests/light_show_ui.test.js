'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const APP = path.join(__dirname, '../apps/light_show');
const KIT = path.join(__dirname, '../kit/runtime');
const Scan = require(APP + '/ecu-scan');
const Journal = require(APP + '/journal');
const Lamps = require(APP + '/lamps');
const { Observations } = require(APP + '/store');
const { PAGE, LIGHTS_BOX, UNITS_BOX } = require(APP + '/ui');
const { Display } = require(KIT + '/display');
const { Canvas } = require(KIT + '/canvas');
const { Recorder, play } = require(KIT + '/record');
const { theme } = require(KIT + '/themes');
const spec = require(APP + '/app.json');
const noop = () => {};

function identities(count, missing) {
    const result = new Map([[0x17, '0F2C10'], [0x40, '0F2680'], [0x43, '0F26C0'], [0x44, '0F1234']]);
    for (let address = 0x80; result.size < count; address++) {
        result.set(address, missing && result.size === count - 1 ? null : '010203');
    }
    return result;
}

async function fixture(recovery) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'light-show-ui-'));
    if (recovery) {
        fs.writeFileSync(path.join(temp, 'light-show-recovery.json'), JSON.stringify({
            version: 2, index: '0F2680', at: '2026-11-22T15:51:45.826Z', flmSides: [],
            fns: ['locator'], outputs: [], bdcSession: true, rlm: [], commOff: [],
        }));
    }
    const observations = new Observations(temp);
    observations.record('flm:left:1', 'visible', true);
    observations.record('flm:left:2', 'none', true);
    observations.record('flm:left:3', 'noise', true);
    const seen = [], handlers = {}, visible = {}, errors = [];
    const log = { info: noop, warn: noop, error: (msg, err) => errors.push(String(err || msg)) };
    const saved = Scan.profile(identities(26, true), 'fixture');
    let nextScan = identities(80), app, loop, frame, soft, knob = 0, layout = 'full', serverActions;
    const values = {};
    const settings = { get: (key) => key === 'layout' ? layout : values[key], onChange: noop,
        set(key, value) { seen.push('setting:' + key); values[key] = value; } };
    const ui = { onVisible: noop, isVisible: (name) => name === 'MAIN', onClick: (id, fn) => { handlers[id] = fn; },
        visible: (id, on) => { visible[id] = on; }, close: noop,
        rhmi: { getByName: (id) => ({ emit: () => handlers[id] && handlers[id]() }) },
        image(name, recorder) { frame = recorder; return display.present(name, recorder, (n, cv) => { soft = cv; }); },
    };
    process.env.MGU_RENDERER = 'software';
    const display = new Display(ui, log, spec, settings, theme);
    delete process.env.MGU_RENDERER;
    const mocked = {
        './kit/mgu': { run: (impl) => { app = impl; } },
        './web-server': { WebServer: class {
            constructor(actions) { serverActions = actions; this.net = {}; }
            start() {} url() { return null; } phoneConnected() { return false; }
        } },
        './guard': class { async init() {} reason() { return null; } },
        './link': class {
            async init() { this.available = true; this.generation = 0; }
            async scan() { seen.push('scan'); return new Map(nextScan); }
            async readIdentity(address) { seen.push('identity:' + address); throw new Error('No identity in fixture'); }
            async identify(expected) {
                if (recovery) { assert.strictEqual(expected, '0F2680'); this.index = expected; return expected; }
                seen.push('control'); throw new Error('Unexpected light control');
            }
            async defaultSession() { return recovery(); }
        },
        './ecu-scan': Object.assign({}, Scan, { load: () => saved }),
    };
    const source = fs.readFileSync(APP + '/main.js', 'utf8');
    vm.runInNewContext(source, {
        require(file) {
            if (mocked[file]) return mocked[file];
            if (file.indexOf('./kit/') === 0) return require(path.join(KIT, file.slice(6)));
            return file[0] === '.' ? require(path.join(APP, file)) : require(file);
        },
        setInterval: noop,
    }, { filename: 'light_show/main.js' });
    await app.start({
        spec, ui, log, settings, display, dataDir: temp, theme, hideButton: (id) => display.hideButton(id),
        onLayout: (fn) => display.onLayout(fn), onTab(fn) { display.onTab = fn; },
        onScroll(fn) { display.onScroll = fn; }, sheet: (sh) => display.openSheet(sh),
        canvas(w, h) {
            const r = display.canvas(w, h);
            r.labels = []; r.detailTitle = null;
            r.text = function (text, x, y) {
                this.labels.push(String(text));
                if (x > LIGHTS_BOX.x + LIGHTS_BOX.w && y === 278) this.detailTitle = String(text);
                return Recorder.prototype.text.apply(this, arguments);
            };
            return r;
        },
        loop(name, fps, draw) { loop = draw; display.onTick(draw); },
    });
    function draw() { loop(); return frame; }
    function setLayout(mode, screen) {
        layout = mode;
        if (screen) {
            display.gpu = { screen, ready: true, touch: true, native: true,
                place: noop, grab: noop, claim: noop, frame: noop };
            display._place();
        } else {
            display.gpu = null; display.place = null; display._layoutChanged();
        }
        return draw();
    }
    function ccu(d, pressed, tilt) {
        knob += d;
        display._ccu({ frontRotaryEncoderOperation: knob, frontRotaryEncoderPushButton: pressed ? 1 : 0,
            frontRotaryEncoderDeflection: tilt || 0 });
        return draw();
    }
    function key(key) { return draw().targets.find((q) => q.key === key); }
    function tap(rect) {
        assert.ok(rect, 'tap target is drawn');
        const x = rect.x + rect.w / 2, y = rect.y + rect.h / 2;
        display._touch(1, x, y); display._touch(3, x, y);
        return draw();
    }
    function swipe(x, y, endX, endY) {
        display._touch(1, x, y);
        display._touch(2, endX, endY);
        display._touch(3, endX, endY);
        return draw();
    }
    function snapshot(name) {
        const out = process.env.LIGHT_SHOW_PREVIEW_DIR;
        if (!out) return;
        const f = draw(), canvas = !display.gpu ? soft : play(f.words(), new Canvas(f.w, f.h));
        fs.writeFileSync(path.join(out, name + '.png'), canvas.png());
    }
    return {
        display, seen, errors, handlers, visible, actions: serverActions, temp, draw, key, tap, swipe, ccu, setLayout, snapshot, saved,
        scan(next) { nextScan = next; return serverActions.scan(); },
        close() { display.closeSheet(); clearInterval(display.keepTimer); },
    };
}

function clippedPlayback() {
    const r = new Recorder(12, 12);
    r.clear('#000000').clip(3, 3, 6, 6);
    r.roundRect(0, 0, 12, 12, 0, '#ffffff');
    r.fillRect(0, 0, 12, 5, '#ff0000').noclip();
    r.fillRect(0, 10, 12, 2, '#00ff00');
    const cv = play(r.words(), new Canvas(12, 12));
    const pixel = (x, y) => Array.from(cv.d.subarray((y * 12 + x) * 4, (y * 12 + x) * 4 + 4));
    assert.deepStrictEqual(pixel(5, 0), [0, 0, 0, 255]);
    assert.deepStrictEqual(pixel(2, 4), [0, 0, 0, 255]);
    assert.deepStrictEqual(pixel(3, 4), [255, 0, 0, 255]);
    assert.deepStrictEqual(pixel(8, 8), [255, 255, 255, 255]);
    assert.deepStrictEqual(pixel(9, 8), [0, 0, 0, 255]);
    assert.deepStrictEqual(pixel(5, 10), [0, 255, 0, 255]);
}

(async () => {
    clippedPlayback();
    const h = await fixture();
    const d = h.display;
    const lx = LIGHTS_BOX.x + 50, ly = LIGHTS_BOX.y, ux = UNITS_BOX.x + 40, uy = UNITS_BOX.y;
    try {
        h.setLayout('full', { w: 1920, h: 720 });
        assert.ok(d.own());
        h.tap(d.tabs.find((tab) => tab.i === PAGE.LIGHTS));
        assert.ok(h.draw().labels.includes('AVAILABILITY / CONTROLLABLE'));
        assert.ok(h.draw().scroll.items.length > 40);
        assert.ok(h.draw().scroll.bar);
        h.snapshot('full-lights');
        const selected = 'flm:left:2';
        h.tap(h.key(selected));
        assert.ok(h.draw().labels.includes('Left headlamp LED 2'));
        h.swipe(lx, ly + LIGHTS_BOX.rowHeight + 3, lx, ly - 65);
        assert.ok(h.draw().scroll.bar.y > ly, 'a swipe starting in the gap between rows scrolls');
        h.swipe(lx, ly + 20, lx, ly + 220);
        assert.strictEqual(h.draw().scroll.bar.y, ly);
        h.swipe(lx + 520, ly + 250, lx + 600, ly + 75); // begin on a row in the other column
        assert.ok(h.draw().scroll.bar.y > ly);
        assert.ok(h.draw().labels.includes('Left headlamp LED 2'), 'swipe never selects a row');
        const scrolledLights = h.draw();
        for (const target of scrolledLights.targets.filter((q) => scrolledLights.scroll.items.includes(q.key))) {
            assert.ok(target.y >= ly && target.y + target.h <= ly + LIGHTS_BOX.h);
        }
        const retainedLightOffset = h.draw().scroll.bar.y;
        h.swipe(lx + LIGHTS_BOX.w, ly + 260, lx, ly + 150); // start inside the detail column
        assert.strictEqual(h.draw().scroll.bar.y, retainedLightOffset);
        h.tap(h.key('FILTER_position'));
        assert.ok(d.sheet);
        h.tap(d.sheetTargets[3]); // sheet hit targets are added from right to left
        await Promise.resolve();
        assert.strictEqual(d.sheet, null);
        assert.ok(h.draw().labels.includes('POSITION / FRONT'));
        assert.strictEqual(h.draw().scroll.bar.y, ly, 'filter resets the list to the top');
        assert.ok(h.draw().labels.includes('Left headlamp LED 2'), 'matching selection is retained');

        h.tap(h.key('FILTER_status'));
        assert.ok(d.sheet);
        h.tap(d.sheetTargets[4]); // Visible
        await Promise.resolve();
        assert.deepStrictEqual(h.draw().scroll.items, ['flm:left:1']);
        assert.strictEqual(h.draw().scroll.bar, null);
        h.tap(h.key('FILTER_position'));
        h.tap(d.sheetTargets[1]); // Rear
        await Promise.resolve();
        assert.ok(h.draw().labels.includes('No lights match the selected filters.'));
        assert.ok(!h.key('TEST'));
        h.tap(h.key('FILTER_RESET'));
        assert.ok(h.draw().labels.includes('AVAILABILITY / ALL'));
        assert.ok(h.draw().scroll.items.includes('flm:right:1'), 'unsupported lamps remain listed when requested');
        assert.deepStrictEqual(h.seen, [], 'all filter, selection and scroll actions are local');

        const lights = h.draw().scroll.items;
        h.ccu(0);
        d._focus(d._ring().find((p) => p.k === 'tgt:FILTER_position'));
        h.ccu(0, false, 1);
        assert.ok(d.focusKey.indexOf('tab:') === 0, 'tilting up from filters reaches the tab bar');
        h.ccu(0);
        d._focus(d._ring().find((p) => p.k === 'tgt:FILTER_status'));
        h.ccu(1);
        assert.strictEqual(d.focusKey, 'tgt:' + lights[0]);
        for (let i = 1; i < lights.length; i++) h.ccu(1);
        assert.strictEqual(d.focusKey, 'tgt:' + lights[lights.length - 1]);
        assert.ok(h.key(lights[lights.length - 1]), 'turning to the last light reveals its target');
        h.ccu(0, true); h.ccu(0, false);
        assert.strictEqual(h.draw().detailTitle, Lamps.catalog(h.saved).find((l) => l.id === lights[lights.length - 1]).label,
            'pressing the knob selects the focused light in the details');
        h.ccu(1);
        assert.ok(['tgt:TEST', 'tgt:TOGGLE', 'tgt:RENAME', 'bar:BTN_START'].includes(d.focusKey), 'turning past the list reaches fixed controls');

        const lastLightBar = h.draw().scroll.bar.y;
        d._touch(1, lx, ly + 250);
        h.ccu(0, false);
        d._openTab(PAGE.VEHICLE);
        h.draw();
        d._touch(2, ux, uy + 25); d._touch(3, ux, uy + 25);
        assert.strictEqual(h.draw().scroll.bar.y, uy, 'old gestures never scroll another tab');
        assert.ok(h.draw().labels.includes(h.saved.units[0].addressHex));
        const switchBefore = h.key('COMM');
        const displayed = new Set(h.draw().labels.filter((label) => label.indexOf('0x') === 0));
        for (let i = 0; i < 12; i++) {
            h.swipe(ux, uy + 174, ux, uy + 16).labels.filter((label) => label.indexOf('0x') === 0).forEach((label) => displayed.add(label));
        }
        assert.deepStrictEqual(Array.from(displayed), h.saved.units.map((u) => u.addressHex), 'all identities appear in scan order');
        const last = h.saved.units[h.saved.units.length - 1];
        assert.ok(h.draw().labels.includes(last.addressHex));
        assert.ok(h.draw().labels.includes('No identity'));
        const bottom = h.draw().scroll.bar.y;
        h.swipe(ux, uy + 170, ux, uy + 25);
        assert.strictEqual(h.draw().scroll.bar.y, bottom);
        assert.deepStrictEqual(h.key('COMM').y, switchBefore.y);
        h.snapshot('full-vehicle-bottom');
        h.swipe(switchBefore.x + 15, switchBefore.y + 40, switchBefore.x + 15, switchBefore.y + 10);
        assert.deepStrictEqual(h.seen, [], 'swiping on a fixed interactive control never activates it');
        for (let i = 0; i < 12; i++) h.swipe(ux, uy + 16, ux, uy + 174);
        assert.strictEqual(h.draw().scroll.bar.y, uy);
        d._focus(d._ring().find((p) => p.scroll));
        for (let i = 0; i < 10 && d.focusKey === 'scroll'; i++) h.ccu(1);
        assert.ok(h.draw().labels.includes(last.addressHex));
        assert.strictEqual(d.focusKey, 'tgt:COMM', 'at the end the controller moves to fixed controls');

        d._openTab(PAGE.LIGHTS); h.draw();
        assert.strictEqual(h.draw().scroll.bar.y, lastLightBar, 'tab keeps its own offset');
        d._openTab(PAGE.VEHICLE); h.draw();
        await h.scan(identities(80));
        h.draw();
        h.swipe(ux, uy + 180, ux, uy - 2000);
        const many = Array.from(identities(80).keys()).pop();
        const hex = (address) => '0x' + address.toString(16).toUpperCase();
        assert.ok(h.draw().labels.includes(hex(many)), 'all 80 units are reachable after a scan');
        await h.scan(new Map([[0x17, '0F2C10'], [0x40, '0F2680'], [0x43, '0F26C0'], [0x44, '0F1234'],
            ...h.saved.units.filter((u) => u.light && u.index).map((u) => [u.address, u.index])]));
        h.draw();
        assert.strictEqual(h.draw().scroll.bar, null, 'smaller results clamp offset and hide the thumb');
        assert.ok(!d._ring().some((p) => p.scroll), 'a fully visible unit list does not consume knob focus');
        assert.ok(h.draw().labels.includes('0x17'));
        assert.ok(h.seen.every((event) => event === 'scan' || event.indexOf('identity:') === 0));

        h.setLayout('standard', { w: 1920, h: 720 });
        assert.strictEqual(d.place.full, false);
        assert.ok(h.visible.BTN_FOCUS_NEXT);
        h.tap(d.tabs.find((tab) => tab.i === PAGE.LIGHTS));
        h.tap(h.key('FILTER_availability'));
        assert.ok(h.key('FILTER_OPTION_unavailable'), 'standard uses the compact in-page filter picker');
        h.tap(h.key('FILTER_OPTION_controllable'));
        assert.ok(h.draw().labels.includes('AVAILABILITY / CONTROLLABLE'));
        h.swipe(lx, ly + 230, lx, ly + 50);
        assert.ok(h.draw().scroll.bar.y > ly, 'standard renderer uses the same bounded touch');
        h.snapshot('standard-lights');
        h.setLayout('full', { w: 1280, h: 480 });
        assert.strictEqual(d.place.full, false, 'smaller display uses the framework standard placement');
        h.snapshot('small-display-lights');

        h.setLayout('standard', null);
        assert.ok(h.visible.BTN_FOCUS_NEXT);
        h.handlers.BTN_FOCUS_SELECT();
        assert.strictEqual(d.pageFocusKey, 'tgt:FILTER_position');
        assert.ok(!h.key('FILTER_OPTION_front'), 'activating without focus cannot open a control');
        for (let i = 0; i < 25; i++) { h.handlers.BTN_FOCUS_NEXT(); h.draw(); }
        const nativeKey = d.pageFocusKey.slice(4);
        assert.ok(h.key(nativeKey), 'native HMI focus buttons reveal later list items in software');
        h.handlers.BTN_FOCUS_SELECT(); h.draw();
        assert.strictEqual(h.draw().detailTitle, Lamps.catalog(h.saved).find((l) => l.id === nativeKey).label);
        h.snapshot('software-lights');
        assert.deepStrictEqual(h.errors, []);
        console.log('ok: actual Light Show UI with Display/Recorder, bounded touch, iDrive, scans and native fallback');
    } finally {
        h.close();
    }
    let rejectDefault;
    const recovery = await fixture(() => new Promise((resolve, reject) => { rejectDefault = reject; }));
    try {
        recovery.setLayout('full', { w: 1920, h: 720 });
        while (!rejectDefault) await new Promise((resolve) => setImmediate(resolve));
        const request = recovery.actions.stop();
        assert.strictEqual(recovery.actions.stop(), request);
        assert.strictEqual(recovery.actions.state().runner.state, 'STOPPING');
        rejectDefault(new Error('0x40 SID 0x10 NRC 0x22 (conditions not correct)'));
        const outcome = await request;
        assert.ok(!outcome.ok);
        assert.ok(/BDC 0x40 default session/.test(outcome.error));
        assert.ok(new Journal(recovery.temp).pending());
        const view = recovery.draw();
        assert.ok(view.labels.includes('ERROR'));
        assert.ok(!view.labels.includes('READY'));
        recovery.tap(recovery.key('DIAG_SHOW'));
        assert.ok(recovery.draw().labels.some((label) => label.includes('NRC 0x22')));
        assert.ok(/Last STOP.*Release not confirmed/.test(recovery.actions.diagnostics().text));
        assert.ok(!require(APP + '/web-page').includes('A previous run is not released yet: press STOP.'));
    } finally {
        recovery.close();
    }
})().catch((e) => { console.error(e); process.exitCode = 1; });
