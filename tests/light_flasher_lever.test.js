'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LeverTrigger, LeverObservation } = require('../apps/light_flasher/lever-trigger');

// Simulated clock; feed(status) means a fresh signal arrived now.
function rig(opts) {
    let t = 1000;
    const lt = new LeverTrigger(() => t, opts);
    lt.setEnabled(true);
    const api = {
        lt,
        advance(ms, status, allowed = true) {
            let fired = 0;
            const end = t + ms;
            while (t < end) { t = Math.min(end, t + 50); if (lt.update(status, t, allowed)) fired++; }
            return fired;
        },
        now: () => t,
    };
    return api;
}

test('short pull after stable OFF fires once after release settles', () => {
    const r = rig();
    assert.equal(r.advance(1200, 'AUS'), 0);
    assert.equal(r.lt.state, 'armed');
    assert.equal(r.advance(300, 'EIN'), 0);
    assert.equal(r.advance(300, 'AUS'), 0, 'not before settle time');
    assert.equal(r.advance(300, 'AUS'), 1);
    assert.equal(r.advance(2000, 'AUS'), 0, 'fires only once per pulse');
    assert.equal(r.lt.triggers, 1);
});

test('sustained high beam never fires', () => {
    const r = rig();
    r.advance(1200, 'AUS');
    assert.equal(r.advance(4000, 'EIN'), 0);
    assert.equal(r.advance(2000, 'AUS'), 0, 'switching off after hold only re-arms');
    assert.equal(r.lt.rejected, 1);
    assert.equal(r.lt.state, 'armed');
});

test('pull without stable OFF phase is ignored', () => {
    const r = rig();
    r.advance(500, 'AUS');
    r.advance(200, 'EIN');
    assert.equal(r.advance(1000, 'AUS'), 0);
});

test('double pull before settle is rejected, not doubled', () => {
    const r = rig();
    r.advance(1200, 'AUS');
    r.advance(200, 'EIN');
    r.advance(100, 'AUS');
    r.advance(200, 'EIN');
    assert.equal(r.advance(2000, 'AUS'), 0);
    assert.equal(r.lt.triggers, 0);
});

test('guard loss during pulse cancels the trigger', () => {
    const r = rig();
    r.advance(1200, 'AUS');
    r.advance(200, 'EIN');
    r.advance(100, 'AUS', false);
    assert.equal(r.advance(1100, 'AUS'), 0, 'needs a fresh stable OFF and a new pulse');
    assert.equal(r.lt.state, 'armed');
});

test('stale or unknown status resets', () => {
    const r = rig();
    r.advance(1200, 'AUS');
    r.advance(200, 'EIN');
    // receive time far in the past
    assert.equal(r.lt.update('AUS', r.now() - 5000, true), false);
    assert.equal(r.lt.state, 'waitOff');
    assert.equal(r.lt.update(undefined, r.now(), true), false);
    assert.equal(r.lt.state, 'waitOff');
});

test('no trigger while running and during cooldown', () => {
    const r = rig();
    r.advance(1200, 'AUS'); r.advance(200, 'EIN');
    assert.equal(r.advance(600, 'AUS'), 1);
    r.lt.runStarted();
    r.advance(1200, 'AUS'); assert.equal(r.advance(200, 'EIN'), 0); assert.equal(r.advance(600, 'AUS'), 0);
    r.lt.runEnded();
    r.advance(1200, 'AUS'); r.advance(200, 'EIN');
    assert.equal(r.advance(600, 'AUS'), 0, 'cooldown 5 s blocks');
    r.advance(4000, 'AUS');
    r.advance(1200, 'AUS'); r.advance(200, 'EIN');
    assert.equal(r.advance(600, 'AUS'), 1, 're-armed after cooldown');
});

test('disabled detector never fires', () => {
    const r = rig();
    r.lt.setEnabled(false);
    r.advance(1200, 'AUS'); r.advance(200, 'EIN');
    assert.equal(r.advance(600, 'AUS'), 0);
    assert.equal(r.lt.snapshot().state, 'disabled');
});

test('main wires lever only through the guarded flash path', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../apps/light_flasher/main.js'), 'utf8');
    const allowed = src.match(/const leverAllowed=\(\)=>([^;]+);/)[1];
    for (const term of ["settings.get('manualFlash')===true", "settings.get('leverTrigger')===true", 'leverScreenOk()', '!guard.recoveryReason()', '!flash.running', '!flash.cleanupUnconfirmed'])
        assert.ok(allowed.includes(term), 'leverAllowed lacks ' + term);
    assert.match(src, /startFlash\('lever'\)/);
    assert.match(src, /flash\.run\(\{\.\.\.cfg,fast:settings\.get\('fastTest'\)===true\},runAllowed,update\)/);
    assert.match(src, /const runAllowed=source==='lever'\?/);
    // Background runs keep the full P/stationary/OEM-off guard, but never with diagnostics open.
    const bg = src.match(/const backgroundRunAllowed=\(\)=>([^;]+);/)[1];
    for (const term of ["settings.get('manualFlash')===true", "settings.get('leverTrigger')===true", 'leverBackground()', "!menuVisible()", '!guard.recoveryReason()', "lastCombined==='AUS'", 'Date.now()-lastLightAt<=2500'])
        assert.ok(bg.includes(term), 'backgroundRunAllowed lacks ' + term);
    const screen = src.match(/const leverScreenOk=\(\)=>([^;]+);/)[1];
    assert.equal(screen, "ui.isVisible('MAIN')||(leverBackground()&&!menuVisible())");
    const app = require('../apps/light_flasher/app.json');
    for (const key of ['leverTrigger', 'leverBackground', 'manualFlash'])
        assert.equal(app.settings.find((x) => x.key === key).default, false, key + ' must default OFF');
    assert.equal(app.mguAppStartType, 'autostart');
});

test('adjustable pulse range accepts only observed durations within bounds',()=>{
 for(const [duration,expected] of [[500,0],[1000,1],[1250,1],[1500,1],[1750,0]]){
  const r=rig();assert.equal(r.lt.setRange(1000,1500),true);r.advance(1200,'AUS');r.advance(duration,'EIN');assert.equal(r.advance(600,'AUS'),expected);
 }
});
test('late OFF transition exceeding max is rejected even without intermediate ON tick',()=>{
 let t=1000;const lt=new LeverTrigger(()=>t);lt.setEnabled(true);lt.update('AUS',t,true);t+=1000;lt.update('AUS',t,true);t+=50;lt.update('EIN',t,true);t+=1600;lt.update('AUS',t,true);t+=500;assert.equal(lt.update('AUS',t,true),false);assert.equal(lt.rejected,1);
});
test('invalid bounds disable trigger and range changes reset incomplete pulses',()=>{
 const r=rig();assert.equal(r.lt.setRange(1500,1000),false);r.advance(1200,'AUS');r.advance(1000,'EIN');assert.equal(r.advance(600,'AUS'),0);
 assert.equal(r.lt.setRange(500,1500),true);r.advance(1200,'AUS');r.advance(750,'EIN');r.lt.setRange(250,1250);assert.equal(r.advance(600,'AUS'),0);
});
test('persisted timing options and passive tracking are wired',()=>{
 const app=require('../apps/light_flasher/app.json');const src=require('fs').readFileSync(require('path').join(__dirname,'../apps/light_flasher/main.js'),'utf8');
 assert.equal(app.settings.find(s=>s.key==='leverMinMs').default,'0');assert.equal(app.settings.find(s=>s.key==='leverMaxMs').default,'1500');
 assert.ok(src.includes('monitor.setEnabled(true)'));assert.ok(src.includes("lever.setRange(settings.get('leverMinMs'),settings.get('leverMaxMs'))"));
 assert.ok(src.includes('limits:lv.limits,rangeValid:lv.rangeValid'));assert.ok(src.includes("source==='lever'?()=>lever.rangeValid"));
});

test('equal hold limits require the exact received pulse duration', () => {
    for (const [pulseMs, expected] of [[499, false], [500, true], [501, false]]) {
        let now = 1000;
        const trigger = new LeverTrigger(() => now);
        assert.equal(trigger.setRange(500, 500), true);
        trigger.setEnabled(true);
        trigger.update('AUS', now, true);
        now += 1000;
        trigger.update('AUS', now, true);
        now += 100;
        const pulledAt = now;
        trigger.update('EIN', pulledAt, true);
        now += pulseMs + 15;
        const releasedAt = pulledAt + pulseMs;
        assert.equal(trigger.update('AUS', releasedAt, true), false);
        assert.equal(trigger.snapshot().lastPulseMs, pulseMs);
        assert.equal(trigger.snapshot().events.find(e => e.kind === 'release').onMs, pulseMs);
        now = releasedAt + 399;
        assert.equal(trigger.update('AUS', releasedAt, true), false);
        now++;
        assert.equal(trigger.update('AUS', releasedAt, true), expected);
    }
});

test('a long hold still logs its actual release duration', () => {
    const r = rig();
    r.lt.setRange(250, 750);
    r.advance(1200, 'AUS');
    r.advance(1000, 'EIN');
    assert.equal(r.advance(600, 'AUS'), 0);
    assert.equal(r.lt.snapshot().lastPulseMs, 1000);
    assert.deepEqual(r.lt.snapshot().events.map(e => e.kind), ['pull', 'release', 'rejected']);
});

test('Diagnostic Logs opens persisted events, pages, and exports a snapshot', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const vm = require('node:vm');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flasher-logs-'));
    try {
        const appDir = path.join(__dirname, '../apps/light_flasher');
        const events = Array.from({length: 6}, (_, i) => ({
            at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
            kind: 'release', onMs: 500 + i,
        }));
        fs.writeFileSync(path.join(dataDir, 'light-flasher-background.json'), JSON.stringify({lever: {events}}));
        fs.writeFileSync(path.join(dataDir, 'light-flasher-run-v0.1.20-20260101000000000-1-1.json'),
            JSON.stringify({flashAttempt: {endedAt: events[0].at, source: 'button', outcome: 'finished'}}));
        // A lexicographic sort by filename ranks v0.1.9 above v0.1.20.
        for (let i = 0; i < 10; i++) {
            fs.writeFileSync(path.join(dataDir, 'light-flasher-run-v0.1.9-2025123123595900' + i + '-1-1.json'),
                JSON.stringify({flashAttempt: {endedAt: '2025-12-31T23:59:59.000Z', source: 'lever', outcome: 'finished'}}));
        }
        const clicks = new Map();
        const labels = new Map();
        let visible = 'DIAGNOSTICS';
        let onVisible, receiveLight;
        const ui = {
            isVisible: name => name === visible,
            onClick: (id, callback) => clicks.set(id, callback),
            text: (id, value) => labels.set(id, value),
            onVisible: callback => { onVisible = callback; },
            open: name => { visible = name; onVisible(); },
        };
        const app = require('../apps/light_flasher/app.json');
        const defaults = Object.fromEntries(app.settings.map(setting => [setting.key, setting.default]));
        const ctx = {
            dataDir, ui, signals: {},
            settings: {get: key => defaults[key], onChange() {}},
            log: {info() {}, warn() {}},
        };
        let started;
        vm.runInNewContext(fs.readFileSync(path.join(appDir, 'main.js'), 'utf8'), {
            require: name => {
                if (name === './kit/mgu') return {run: app => { started = app.start(ctx); }};
                if (name === './guard') return class {
                    async init(signals, log, receive) { this.speedSub = {available: true}; receiveLight = receive; }
                    recoveryReason() { return 'Select P (Park)'; }
                    snapshot() { return {}; }
                };
                if (name === './probe') return {
                    Reader: class { constructor() { this.diag = {}; this.trace = []; } async init() {} },
                    Capture: class { status() {} stop() {} snapshot() { return {}; } },
                };
                return name.startsWith('./') ? require(path.join(appDir, name)) : require(name);
            },
            process: {pid: 1, on() {}},
            setInterval() {},
        });
        await started;
        assert.ok(app.screens.find(screen => screen.name === 'DIAGNOSTICS').items.some(item => item[1] === 'BTN_LOGS'));
        await clicks.get('BTN_LOGS')();
        assert.equal(visible, 'LOGS');
        assert.equal(labels.get('LOG_PATH'), dataDir);
        assert.equal(labels.get('LOG_POSITION'), 'Page 1 / 4');
        assert.match(labels.get('LOG_ROW_0'), /Lever release \| 505 ms/);
        await clicks.get('BTN_LOG_OLDER')();
        assert.equal(labels.get('LOG_POSITION'), 'Page 2 / 4');
        assert.match(labels.get('LOG_ROW_1'), /button \| finished .*light-flasher-run-/);
        await clicks.get('BTN_LOG_NEWER')();
        assert.equal(labels.get('LOG_POSITION'), 'Page 1 / 4');
        await clicks.get('BTN_LOG_SAVE')();
        assert.match(labels.get('LOG_FILES'), /Export saved/);
        const report = JSON.parse(fs.readFileSync(path.join(dataDir, 'light-flasher-diagnostics.json'), 'utf8'));
        assert.equal(report.leverTrigger.events.length, 6);
        await clicks.get('BTN_LOG_BACK')();
        assert.equal(visible, 'DIAGNOSTICS');
        const light = status => receiveLight({statusMainBeam_headlightFlasher: status});
        light('AUS');
        light('EIN');
        assert.match(labels.get('DIAG_LEVER'), /Pull detected/);
        light('AUS');
        assert.match(labels.get('DIAG_LEVER'), /Released.*Last measured pull: [0-9]+ ms/);
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('live measurement ignores repeated samples and requires both fresh edges', () => {
    const signal = new LeverObservation();
    signal.observe('EIN', 100);
    assert.equal(signal.snapshot(200, true).holdMs, null);
    signal.observe('AUS', 300);
    signal.observe('EIN', 500);
    signal.observe('EIN', 700);
    assert.equal(signal.snapshot(800, true).holdMs, 300);
    signal.observe('AUS', 1000);
    assert.equal(signal.snapshot(1000, true).lastHoldMs, 500);
    signal.observe('EIN', 1100);
    assert.equal(signal.snapshot(1200, false).status, null);
    signal.observe('AUS', 4000);
    assert.equal(signal.snapshot(4000, true).lastHoldMs, 500);
});

test('trigger accepts a pull just after stable OFF even before the next timer tick', () => {
    let now = 1000;
    const trigger = new LeverTrigger(() => now);
    trigger.setEnabled(true);
    trigger.update('AUS', now, true);
    now += 1001;
    assert.equal(trigger.update('EIN', now, true), false);
    now += 500;
    assert.equal(trigger.update('AUS', now, true), false);
    now += 400;
    assert.equal(trigger.update('AUS', now - 400, true), true);
});
