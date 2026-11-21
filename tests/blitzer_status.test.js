'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { StatusLine, MAP_RECT } = require('../apps/blitzer_status/status_line');
const { PhoneBridge, HOLD_MS } = require('../apps/blitzer_status/phone_bridge');

const log = { info() {}, warn() {} };

class FakeRenderer extends EventEmitter {
    constructor() { super(); this.ready = false; this.calls = []; }
    connect() {}
    close() { this.calls.push(['close']); }
    effect(options) { this.calls.push(['effect', options]); return 1; }
    uniform(ref, name, values) { this.calls.push(['uniform', ref, name, values]); }
    set(ref, options) { this.calls.push(['set', ref, options]); }
    drop(ref) { this.calls.push(['drop', ref]); }
}

const renderer = new FakeRenderer();
const line = new StatusLine(log, renderer);
line.update('opened');
assert.strictEqual(renderer.calls.length, 0, 'waits for the renderer');
renderer.ready = true;
line.update('unknown');
assert.strictEqual(renderer.calls.length, 0, 'no recent report means no line');
line.update('opened');
const [[operation, effect], [, , , openedColor]] = renderer.calls;
assert.strictEqual(operation, 'effect');
assert.strictEqual(effect.target, 'map');
assert.strictEqual(effect.klass, 'overlay');
assert.strictEqual(effect.contend, false, 'never takes the map slot');
assert.strictEqual(effect.guide_hold, false, 'keeps turn guidance');
assert.strictEqual(effect.visible, false, 'invisible until the color is set');
assert.deepStrictEqual([effect.x, effect.y, effect.w, effect.h],
    [MAP_RECT.x, MAP_RECT.y, MAP_RECT.w, MAP_RECT.h]);
assert.ok(effect.x + effect.w <= 1088 && effect.y + effect.h <= 480, 'inside the map window');
assert.ok(effect.y >= 424, 'below lyric text');
assert.ok(openedColor[1] > openedColor[0], 'opened is green');
assert.deepStrictEqual(renderer.calls[2], ['set', 1, { visible: true }]);
line.update('opened');
assert.strictEqual(renderer.calls.length, 3, 'same event sends nothing');
line.update('closed');
assert.deepStrictEqual(renderer.calls[3].slice(0, 3), ['uniform', 1, 'u_color']);
assert.ok(renderer.calls[3][3][0] > renderer.calls[3][3][1], 'closed is red');
line.update('unknown');
assert.deepStrictEqual(renderer.calls[4], ['drop', 1], 'expiry or disabling removes the line');
line.update('closed');
renderer.ready = false;
renderer.emit('disconnected');
assert.deepStrictEqual(renderer.calls[8], ['drop', 1], 'disconnect clears the renderer replay');
renderer.ready = true;
line.update('closed');
assert.strictEqual(renderer.calls[9][0], 'effect', 'reconnect draws the latest report');
line.close();
assert.deepStrictEqual(renderer.calls.slice(-2), [['drop', 1], ['close']]);

// ---- phone bridge: token route, retry, loopback-only health, stale state
function get(host, port, p) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: host, port, path: p }, (res) => {
            let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
        }).on('error', reject);
    });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function bridgeTest() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blitzer-phone-'));
    let t = 1000000, changes = 0, addr = null;
    const port = 38000 + (process.pid % 1000);
    const b = new PhoneBridge(dir, log, () => { changes++; }, {
        now: () => t, port, address: undefined, resolveAddress: () => addr, netStatusPort: 0 });
    assert.strictEqual(b.reported(), 'unknown');
    b.setEnabled(true);
    assert.strictEqual(b.listening(), false, 'no Wi-Fi address: waits instead of binding everywhere');
    assert.strictEqual(b.url('on'), null);
    await wait(60);
    assert.strictEqual((await get('127.0.0.1', port, '/.mgu-cluster-health')).status, 503, 'not listening -> not healthy');
    addr = '127.0.0.2';
    t += 6000; b.tick(); await wait(80);
    assert.strictEqual(b.listening(), true, 'retry finds the address later');
    const h = await get('127.0.0.1', port, '/.mgu-cluster-health');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.headers['x-mgu-custom-cluster'], '1');
    assert.strictEqual((await get('127.0.0.2', port, '/.mgu-cluster-health')).status, 404, 'health answers loopback only (phone side never sees it)');
    const base = '/s/' + b.token + '/';
    assert.strictEqual((await get('127.0.0.2', port, '/s/wrong/on')).status, 404);
    assert.strictEqual((await get('127.0.0.2', port, base + 'x')).status, 404);
    assert.strictEqual((await get('127.0.0.2', port, base + 'on')).body, 'OK');
    assert.strictEqual(b.reported(), 'opened');
    assert.strictEqual((await get('127.0.0.2', port, base + 'off')).status, 200);
    assert.strictEqual(b.reported(), 'closed');
    assert.strictEqual(changes >= 2, true);
    assert.strictEqual(b.url('off'), 'http://127.0.0.2:' + port + base + 'off');
    t += HOLD_MS + 1000;
    assert.strictEqual(b.reported(), 'unknown', 'an event from long ago says nothing');
    b.stop();
    await wait(60);
    assert.strictEqual(b.listening(), false);
    await assert.rejects(get('127.0.0.1', port, '/.mgu-cluster-health'), 'health endpoint gone when disabled');
    const again = new PhoneBridge(dir, log, null, { port, resolveAddress: () => null, netStatusPort: 0 });
    assert.strictEqual(again.token, b.token, 'token survives restarts');
}
async function appTest() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blitzer-app-'));
    const entry = path.resolve(__dirname, '../apps/blitzer_status/main.js');
    const load = createRequire(entry);
    const spec = load('./app.json');
    const appRenderer = new FakeRenderer();
    appRenderer.ready = true;
    const values = { phoneBridge: true, phoneBadge: true };
    const text = [];
    let bridge, start, render, tick, change, cleanup, switchLink;
    const host = '127.0.0.2';
    const port = 40000 + (process.pid % 1000);
    const deps = {
        './kit/mgu': { run(app) { start = app.start; } },
        './kit/gauges': { frame() {} },
        './phone_bridge': { PhoneBridge: class extends PhoneBridge {
            constructor(dataDir, appLog, notify) {
                super(dataDir, appLog, notify, { address: host, port, netStatusPort: 0 });
                bridge = this;
            }
        } },
        './status_line': { StatusLine: class extends StatusLine {
            constructor(appLog) { super(appLog, appRenderer); }
        } }
    };
    vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
        require: (id) => deps[id] || load(id),
        process: { once(event, fn) { if (event === 'exit') cleanup = fn; } },
        setInterval(fn) { tick = fn; return 1; },
        clearInterval() {}
    }, { filename: entry });
    try {
        await start({
            spec, dataDir: dir, log, app: { startReason: 'autostart' },
            settings: { get: (key) => values[key], onChange(fn) { change = fn; } },
            ui: { onVisible() {}, onClick(id, fn) { switchLink = fn; }, text() {}, image() {} },
            loop(name, fps, fn) { render = fn; },
            canvas() { return { clear() { return this; }, fillRect() {}, text(value) { text.push(value); } }; },
            theme() { return {}; }
        });
        const status = JSON.parse(fs.readFileSync(path.join(dir, 'blitzer-status-background.json'), 'utf8'));
        assert.strictEqual(status.startReason, 'autostart');
        assert.strictEqual(status.windowOpenedYet, false);
        if (!bridge.listening()) await new Promise(resolve => bridge.server.once('listening', resolve));
        const route = '/s/' + bridge.token + '/';
        assert.strictEqual((await get(host, port, route + 'on')).status, 200);
        assert.strictEqual(appRenderer.calls[0][0], 'effect', 'open event draws before any HMI render');
        assert.strictEqual((await get(host, port, route + 'off')).status, 200);
        assert.strictEqual(appRenderer.calls[3][0], 'uniform', 'close event recolors in the background');
        await render();
        assert.ok(text.includes('Closed') && text.includes(bridge.url('on')));
        switchLink();
        await render();
        assert.ok(text.includes(bridge.url('off')), 'second QR link uses the close route');
        values.phoneBadge = false;
        change();
        assert.strictEqual(appRenderer.calls[4][0], 'drop', 'disabling the overlay drops its layer');
        values.phoneBridge = false;
        change();
        tick();
        assert.strictEqual(bridge.listening(), false, 'disabling the link stops the listener');
    } finally {
        if (cleanup) cleanup();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

bridgeTest().then(appTest).then(() => console.log('Blitzer Status background, status line and link tests passed'),
    (e) => { console.error(e); process.exitCode = 1; });
