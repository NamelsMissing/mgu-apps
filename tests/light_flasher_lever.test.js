'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LeverTrigger } = require('../apps/light_flasher/lever-trigger');

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
    for (const term of ["settings.get('manualFlash')===true", "settings.get('leverTrigger')===true", 'leverScreenOk()', '!guard.reason()', '!flash.running', '!flash.cleanupUnconfirmed'])
        assert.ok(allowed.includes(term), 'leverAllowed lacks ' + term);
    assert.match(src, /startFlash\('lever'\)/);
    assert.match(src, /flash\.run\(\{\.\.\.cfg,fast:settings\.get\('fastTest'\)===true\},runAllowed,update\)/);
    assert.match(src, /const runAllowed=background\?backgroundRunAllowed:flashAllowed/);
    // Background runs keep the full P/stationary/OEM-off guard, but never with diagnostics open.
    const bg = src.match(/const backgroundRunAllowed=\(\)=>([^;]+);/)[1];
    for (const term of ["settings.get('manualFlash')===true", "settings.get('leverTrigger')===true", 'leverBackground()', "!menuVisible()", '!guard.reason()', "lastCombined==='AUS'", 'Date.now()-lastLightAt<=2500'])
        assert.ok(bg.includes(term), 'backgroundRunAllowed lacks ' + term);
    const screen = src.match(/const leverScreenOk=\(\)=>([^;]+);/)[1];
    assert.equal(screen, "ui.isVisible('MAIN')||(leverBackground()&&!menuVisible())");
    const app = require('../apps/light_flasher/app.json');
    for (const key of ['leverTrigger', 'leverBackground', 'manualFlash'])
        assert.equal(app.settings.find((x) => x.key === key).default, false, key + ' must default OFF');
    assert.equal(app.mguAppStartType, 'autostart');
});
