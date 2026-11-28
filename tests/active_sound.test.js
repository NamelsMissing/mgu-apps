'use strict';
// Active Sound 0.3.1: engine profiles, per-sound tuning, exhaust pipes + stereo banks, vehicle model, synthesizer, car mapping, head-unit player, WAV export,
// phone server + page, firewall helper. PC only, no car.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const APP = path.join(__dirname, '../apps/active_sound');
const E = require(APP + '/engines');
const { EngineSynth, tuneProfile } = require(APP + '/synth');
const M = require(APP + '/mapping');
const { LivePlayer, renderDrive, exportDrive, driveStates } = require(APP + '/player');
const { VehicleSim, script } = require(APP + '/vehicle');
const { WebServer } = require(APP + '/web-server');
const pages = require(APP + '/web-page');
const NET = path.join(__dirname, '../native/sound-net');

const SR = 44100;
function render(id, rpm, load, seconds, on, tune, character) {
    const s = new EngineSynth(SR, E.get(id), 7, tune);
    s.setCharacter(character || 'detailed'); s.setProfile(E.get(id), tune);
    s.set(rpm, load, on === undefined ? true : on, 1);
    const n = Math.round(SR * seconds), b = new Float32Array(n);
    s.render(b, null, n);
    return b;
}
function rms(b, from) { let s = 0; for (let i = from || 0; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / (b.length - (from || 0))); }
function mag(b, f, from) {
    let re = 0, im = 0;
    for (let i = from; i < b.length; i++) { const a = 2 * Math.PI * f * i / SR; re += b[i] * Math.cos(a); im += b[i] * Math.sin(a); }
    return Math.hypot(re, im);
}

/* ---------- profiles ---------- */
{
    assert.ok(E.PROFILES.length >= 21, 'at least 21 engines');
    assert.ok(E.PROFILES.filter((p) => p.fuel === 'diesel').length >= 6, 'six diesels');
    const ids = new Set();
    for (const p of E.PROFILES) {
        assert.ok(!ids.has(p.id), 'unique id ' + p.id); ids.add(p.id);
        assert.ok(p.name && p.short && p.desc && p.group, p.id + ' texts');
        assert.ok(/^[\x20-\x7e]+$/.test(p.name + p.short + p.desc), p.id + ' ASCII only (car fonts)');
        assert.ok(p.redline > p.idle && p.redline <= 16000, p.id + ' range');
        if (p.kind === 'pulse') {
            assert.ok(p.cyl >= 1 && (p.cycle === 1 || p.cycle === 2), p.id + ' cylinders');
            if (p.fire) assert.strictEqual(p.fire.length, p.cyl, p.id + ' firing points');
            if (p.amp) assert.strictEqual(p.amp.length, p.cyl, p.id + ' amplitudes');
            assert.ok(p.body.length >= 2, p.id + ' resonators');
        } else assert.strictEqual(p.kind, 'tonal');
    }
    assert.strictEqual(E.step('inline6', 1), E.PROFILES[1].id);
    assert.strictEqual(E.step(E.PROFILES[0].id, -1), E.PROFILES[E.PROFILES.length - 1].id);
    assert.strictEqual(E.get('nope').id, E.PROFILES[0].id);
}

/* ---------- synthesizer: every profile, finite, bounded, similar loudness ---------- */
{
    const levels = [];
    for (const p of E.PROFILES) {
        for (const pt of [[0, 0.05], [0.5, 1], [1.02, 1], [0.6, 0]]) {
            const b = render(p.id, p.idle + pt[0] * (p.redline - p.idle), pt[1], 0.4);
            let peak = 0;
            for (const v of b) { assert.ok(isFinite(v), p.id + ' finite'); peak = Math.max(peak, Math.abs(v)); }
            assert.ok(peak <= 0.95, p.id + ' peak ' + peak);
            if (pt[0] === 0.5) levels.push(rms(b, SR * 0.15));
        }
    }
    const lo = Math.min.apply(null, levels), hi = Math.max.apply(null, levels);
    assert.ok(lo > 0.03 && hi / lo < 3, 'profiles at similar loudness: ' + lo.toFixed(3) + '..' + hi.toFixed(3));
}
/* firing frequency is the strongest line (four-stroke: rpm/120 x cylinders; rotary: rpm/60 x rotors) */
{
    for (const id of ['inline4', 'inline6', 'v8_cross', 'v12', 'rotary', 'vtwin']) {
        const p = E.get(id), b = render(id, 3000, 0.7, 1), fire = 3000 / 60 / p.cycle * p.cyl;
        const at = mag(b, fire, SR / 2);
        for (const off of [0.7, 1.3, 1.5]) assert.ok(at > mag(b, fire * off, SR / 2), id + ' firing line at ' + fire + ' Hz');
    }
}
/* switched off: fades to silence; deterministic per seed */
{
    const s = new EngineSynth(SR, E.get('v8_cross'), 3);
    s.set(3000, 0.6, true, 1);
    const a = new Float32Array(SR); s.render(a, null, SR);
    s.set(3000, 0.6, false, 1);
    const b = new Float32Array(SR * 2); s.render(b, null, b.length);
    assert.ok(rms(a, SR / 2) > 0.02);
    assert.ok(rms(b.subarray(SR * 1.5)) < 1e-4, 'silent after fade');
    assert.deepStrictEqual(Array.from(render('inline6', 4000, 0.5, 0.05)), Array.from(render('inline6', 4000, 0.5, 0.05)));
    const st = new EngineSynth(SR, E.get('inline6'), 1); st.set(0, 0, false, 1);
    const z = new Float32Array(1000); st.render(z, null, 1000);
    assert.ok(z.every((v) => v === 0), 'no output without engine');
}
/* ---------- tuning ---------- */
{
    // metadata and cleaning
    const truck = E.get('diesel_truck'), v8 = E.get('v8_cross'), ev = E.get('ev_pulse');
    assert.ok(E.tuneKeys(truck).some((c) => c.key === 'brake'), 'diesel has engine brake');
    assert.ok(!E.tuneKeys(v8).some((c) => c.key === 'brake'), 'petrol has no engine brake');
    assert.deepStrictEqual(E.tuneKeys(ev).map((c) => c.key), ['bass', 'rasp', 'whine']);
    assert.ok(E.TUNE.every((c) => /^[\x20-\x7e]+$/.test(c.name + c.desc)), 'tune texts ASCII');
    assert.deepStrictEqual(E.cleanTune(v8, { pops: 1.6, brake: 2, x: 1, bass: 1, rasp: -3, turbo: 9, lope: 'a' }), { pops: 1.5, rasp: 0, turbo: 2 });
    // effective profile: 0 removes, >1 adds a missing feature, 1 = as designed
    assert.deepStrictEqual(tuneProfile(v8, {}).body, v8.body);
    assert.strictEqual(tuneProfile(v8, { pops: 0 }).pops, 0);
    assert.ok(tuneProfile(E.get('diesel4'), { pops: 2 }).pops > 0.5, 'pops added to a diesel');
    assert.ok(tuneProfile(E.get('v8_flat'), { turbo: 2 }).turbo.gain > 0, 'turbo added');
    assert.strictEqual(tuneProfile(v8, { brake: 2 }).jake, 0, 'no engine brake on petrol');
    assert.ok(tuneProfile(E.get('diesel4'), { brake: 2 }).jake > 0.5);
    // level matching ignores tuning; the tuning is audible
    const plain = new EngineSynth(SR, v8, 1), loud = new EngineSynth(SR, v8, 1, { bass: 2 });
    assert.strictEqual(plain.norm, loud.norm, 'tuning is not normalised away');
    const coast = (id, tune, character) => {        // pull to 80 %, then lift off: overrun energy
        const p = E.get(id), s = new EngineSynth(SR, p, 11, tune), b = new Float32Array(SR);
        if (character) { s.setCharacter(character); s.setProfile(p, tune); }
        s.set(p.idle + 0.8 * (p.redline - p.idle), 1, true, 1); s.render(b, null, SR);
        s.set(p.idle + 0.3 * (p.redline - p.idle), 0, true, 1); s.render(b, null, SR);
        return rms(b, SR * 0.1);
    };
    for (const ch of ['detailed', 'subtle']) {
    const popsOff = coast('v8_cross', { pops: 0, bangs: 0 }, ch), popsMax = coast('v8_cross', { pops: 2, bangs: 2 }, ch);
    assert.ok(popsMax > popsOff * 1.5, ch + ': pops & bangs louder on overrun: ' + popsOff.toFixed(4) + ' -> ' + popsMax.toFixed(4));
    const brakeOff = coast('diesel_truck', { brake: 0 }, ch), brakeOn = coast('diesel_truck', null, ch);
    assert.ok(brakeOn > brakeOff * 1.5, ch + ': engine brake bark: ' + brakeOff.toFixed(4) + ' -> ' + brakeOn.toFixed(4));
    }
    // every profile stays finite and bounded at the extremes of every control
    for (const p of E.PROFILES) for (const ext of [0, 2]) {
        const t = {}; E.tuneKeys(p).forEach((c) => { t[c.key] = ext; });
        for (const b of [render(p.id, p.redline * 1.02, 1, 0.25, true, t), render(p.id, p.idle, 0, 0.25, true, t)]) {
            for (const v of b) { assert.ok(isFinite(v) && Math.abs(v) <= 0.95, p.id + ' tune ' + ext); }
        }
    }
    // live change keeps the filter state (no reset)
    const live = new EngineSynth(SR, truck, 2); live.set(1500, 0.5, true, 1);
    const pre = new Float32Array(2000); live.render(pre, null, 2000);
    const y1 = live.body[0].f.y1; live.setTune({ bass: 1.5 }); assert.strictEqual(live.body[0].f.y1, y1);
    assert.ok(live.body[0].g !== truck.body[0][2]);
}
/* stereo: inline engines mono, V / boxer engines two banks (correlated, not identical) + S16 */
{
    const st = (id) => { const s = new EngineSynth(SR, E.get(id), 9); s.setCharacter('detailed'); s.setProfile(E.get(id)); s.set(4000, 0.8, true, 1);
        const l = new Float32Array(SR / 2), r = new Float32Array(SR / 2); s.render(l, r, l.length); return [l, r]; };
    let [l, r] = st('inline6');
    assert.deepStrictEqual(Array.from(l), Array.from(r), 'inline-6 is mono');
    [l, r] = st('v8_cross');
    let lr = 0, ll = 0, rr = 0, diff = 0;
    for (let i = SR / 10; i < l.length; i++) { lr += l[i] * r[i]; ll += l[i] * l[i]; rr += r[i] * r[i]; diff += Math.abs(l[i] - r[i]); }
    const corr = lr / Math.sqrt(ll * rr);
    assert.ok(diff > 1 && corr > 0.6 && corr < 0.995, 'V8 banks in stereo, correlation ' + corr.toFixed(3));
    assert.ok(E.get('v8_cross').bank.length === 8 && E.get('flat6').banks === 2 && !E.get('inline6').banks);
    const s = new EngineSynth(SR, E.get('flat6'), 9); s.set(5000, 1, true, 1);
    const buf = s.renderS16(100); assert.strictEqual(buf.length, 400);
}
/* voicing: idle and cruise are not just a low hum (the 'electric fart' of 0.3.0), level gap to full load ~10-16 dB */
{
    const share = (b, f0) => {      // energy share above f0 via a crude DFT on 0.25 s
        const N = 11025, seg = b.subarray(b.length - N); let hi = 0, all = 0;
        for (let k = 2; k < 2000; k += 2) { const f = k * SR / N; let re = 0, im = 0;
            for (let i = 0; i < N; i += 2) { const a = 2 * Math.PI * k * i / N; re += seg[i] * Math.cos(a); im += seg[i] * Math.sin(a); }
            const pw = re * re + im * im; all += pw; if (f >= f0) hi += pw; }
        return hi / all;
    };
    for (const id of ['diesel6', 'v8_cross', 'inline4']) {
        const p = E.get(id);
        const idle = render(id, p.idle, 0.05, 1), cruise = render(id, p.idle + 0.25 * (p.redline - p.idle), 0.25, 1);
        const full = render(id, p.idle + 0.6 * (p.redline - p.idle), 1, 1);
        assert.ok(share(idle, 200) > 0.2, id + ' idle has content above 200 Hz: ' + share(idle, 200).toFixed(2));
        assert.ok(share(cruise, 200) > 0.15, id + ' cruise above 200 Hz: ' + share(cruise, 200).toFixed(2));
        const gap = 20 * Math.log10(rms(full, SR / 2) / rms(idle, SR / 2));
        assert.ok(gap > 8 && gap < 18, id + ' idle -> full load ' + gap.toFixed(1) + ' dB');
    }
    // small speaker: almost nothing below 120 Hz, still clearly audible
    const s = new EngineSynth(SR, E.get('diesel6'), 3); s.setCharacter('detailed'); s.setProfile(E.get('diesel6')); s.setSpeaker('small'); s.set(1200, 0.25, true, 1);
    const b = new Float32Array(SR); s.render(b, null, SR);
    assert.ok(share(b, 120) > 0.85 && rms(b, SR / 2) > 0.02, 'phone speaker mode: ' + share(b, 120).toFixed(2));
}
/* subtle (factory-ASD) character, the default: almost nothing above 500 Hz, quiet at idle and cruise, mono */
{
    const sub = (id, n, load) => { const p = E.get(id), s = new EngineSynth(SR, p, 5); assert.ok(s.subtle, 'subtle is the default');
        s.set(p.idle + n * (p.redline - p.idle), load, true, 1); const l = new Float32Array(SR), r = new Float32Array(SR); s.render(l, r, SR); return [l, r]; };
    for (const id of ['diesel6', 'v8_cross', 'inline4']) {
        const [idle] = sub(id, 0.03, 0.05), [cruise] = sub(id, 0.2, 0.25), [full, fullR] = sub(id, 0.6, 1);
        const N = 4096, seg = full.subarray(SR - N); let hi = 0, all = 0;
        for (let k = 1; k < 300; k++) { let re = 0, im = 0; for (let i = 0; i < N; i++) { const a = 2 * Math.PI * k * i / N; re += seg[i] * Math.cos(a); im += seg[i] * Math.sin(a); }
            const pw = re * re + im * im; all += pw; if (k * SR / N > 600) hi += pw; }
        assert.ok(hi / all < 0.03, id + ' subtle: energy above 600 Hz ' + (100 * hi / all).toFixed(1) + ' %');
        const db = (a, b) => 20 * Math.log10(rms(a, SR / 2) / rms(b, SR / 2));
        assert.ok(db(full, idle) > 16 && db(full, cruise) > 9 && db(full, cruise) < 18, id + ' subtle levels: idle -' + db(full, idle).toFixed(1) + ' dB, cruise -' + db(full, cruise).toFixed(1) + ' dB');
        assert.deepStrictEqual(Array.from(full.subarray(SR - 64)), Array.from(fullR.subarray(SR - 64)), 'subtle is mono');
    }
}
/* exhaust pipe: gets hot under load (resonance moves up), resonance control works */
{
    const s = new EngineSynth(SR, E.get('inline6'), 4); s.set(5000, 1, true, 1);
    const d0 = s.pipes[0].d, b = new Float32Array(SR * 3); s.render(b, null, b.length);
    assert.ok(s.heat > 0.6 && s.pipes[0].d < d0 * 0.9, 'hot exhaust shortens the delay: ' + d0.toFixed(0) + ' -> ' + s.pipes[0].d.toFixed(0));
    assert.strictEqual(tuneProfile(E.get('inline6'), { pipe: 0 }).pipeRefl, 0);
    assert.strictEqual(tuneProfile(E.get('inline6'), { pipe: 2 }).pipeRefl, 1);
}
/* vehicle model: plausible acceleration, gears, limiter, overrun, brakes */
{
    const run = (id, seconds, u, b) => { const c = new VehicleSim(E.get(id)); let last; for (let t = 0; t < seconds; t += 0.01) last = c.step(0.01, u, b); return { c, last }; };
    const t100 = (id) => { const c = new VehicleSim(E.get(id)); for (let t = 0; t < 90; t += 0.01) if (c.step(0.01, 1, 0).kmh >= 100) return t; return 99; };
    const i6 = t100('inline6'), d4 = t100('diesel4'), truck = t100('diesel_truck');
    assert.ok(i6 > 3 && i6 < 7, '0-100 inline-6 ' + i6.toFixed(1));
    assert.ok(d4 > 6 && d4 < 11, '0-100 diesel-4 ' + d4.toFixed(1));
    assert.ok(truck > 20, '0-100 truck ' + truck.toFixed(1));
    const full = run('inline6', 12, 1, 0).last;
    assert.ok(full.gear >= 4 && full.kmh > 150 && full.rpm <= E.get('inline6').redline * 1.02, 'pull through the gears');
    const idle = run('diesel4', 3, 0, 0).last;
    assert.ok(idle.kmh < 0.1 && Math.abs(idle.rpm - E.get('diesel4').idle) < 1 && idle.load === 0, 'idle at standstill');
    // overrun: throttle closed at speed -> load 0, rpm above idle, car slows (engine braking)
    const c = new VehicleSim(E.get('v8_cross')); for (let t = 0; t < 8; t += 0.01) c.step(0.01, 1, 0);
    const v0 = c.kmh(); let o; for (let t = 0; t < 2; t += 0.01) o = c.step(0.01, 0, 0);
    assert.ok(o.load === 0 && o.rpm > E.get('v8_cross').idle * 2 && o.kmh < v0, 'overrun');
    for (let t = 0; t < 15; t += 0.01) o = c.step(0.01, 0, 1);
    assert.ok(o.kmh < 1, 'brakes stop the car');
    // shifting cuts the load (bangs / blow-off on upshifts); limiter reports the redline
    const states = driveStates(E.get('inline6'), 13, 0.01);
    assert.ok(states.some((x) => x.shifting && x.load === 0), 'upshift torque cut');
    const ev = run('ev_pulse', 30, 1, 0).last; assert.ok(ev.kmh <= 205 && ev.gear === 1, 'EV single gear, top speed');
    assert.deepStrictEqual(script(5), { u: 1, b: 0 });
    for (const p of E.PROFILES) {
        for (const x of driveStates(p, 30, 0.02)) assert.ok(isFinite(x.rpm) && isFinite(x.kmh) && x.load >= 0 && x.load <= 1, p.id + ' drive finite');
    }
}

/* ---------- mapping ---------- */
{
    const now = 1e12, at = { rpm: now - 100, speed: now - 100, torque: now - 100 };
    const i6 = E.get('inline6'), ev = E.get('ev_pulse');
    let m = M.map({ rpm: 750, speed: 0, torque: 40, receivedAt: at }, i6, {}, now);
    assert.ok(m.running && m.rpm === i6.idle && Math.abs(m.load - 0.1) < 1e-9 && m.loadSource === 'torque');
    m = M.map({ rpm: 5000, speed: 120, torque: 400, receivedAt: at }, i6, { realRedline: 5000, maxTorque: 400 }, now);
    assert.strictEqual(m.rpm, i6.redline); assert.strictEqual(m.load, 1);
    m = M.map({ rpm: 2875, speed: 100, receivedAt: at }, ev, {}, now);
    assert.strictEqual(m.rpm, ev.redline * 0.5, 'electric follows speed');
    m = M.map({ rpm: 2000, speed: 50, torque: 200, receivedAt: { rpm: now - 6000 } }, i6, {}, now);
    assert.ok(!m.running && /Waiting/.test(m.reason), 'stale rpm = silence');
    m = M.map({ rpm: 0, receivedAt: at }, i6, {}, now);
    assert.ok(!m.running && m.reason === 'Engine off', 'auto start/stop = silence');
    m = M.map({ rpm: 2000, gLong: 0.15, receivedAt: { rpm: now, gLong: now } }, i6, {}, now);
    assert.strictEqual(m.loadSource, 'accel'); assert.ok(Math.abs(m.load - 0.65) < 1e-9);
    m = M.map({ rpm: 2000, demo: true }, i6, {}, now);
    assert.ok(m.running && m.demo);
    assert.strictEqual(M.nextIn(M.REAL_REDLINES, 7500, 1), 4500);
}

/* ---------- head-unit player (fake aplay) ---------- */
{
    const none = new LivePlayer({ profile: E.get('inline6'), find: () => null, dspClient: null });
    assert.strictEqual(none.start(), false); assert.strictEqual(none.status, 'unavailable');
    const spawned = [];
    const fake = new LivePlayer({ profile: E.get('inline6'), dspClient: null, find: (n) => n === 'aplay' ? '/usr/bin/aplay' : null,
        spawn: (bin, args) => {
            const c = new EventEmitter(); c.stdin = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => c.emit('close', 0);
            c.bytes = 0; c.stdin.on('data', (d) => { c.bytes += d.length; }); spawned.push({ bin, args, c }); return c;
        } });
    fake.set(3000, 0.5, true, 0.5);
    assert.ok(fake.start());
    assert.strictEqual(spawned[0].bin, '/usr/bin/aplay');
    assert.ok(spawned[0].args.indexOf('S16_LE') >= 0 && spawned[0].args.indexOf('48000') >= 0);
    setTimeout(() => {
        const b = spawned[0].c.bytes, expect = (300 + 120) / 1000 * 48000 * 4;
        assert.ok(b > expect * 0.6 && b < expect * 1.6, 'clock-paced output: ' + b + ' bytes');
        fake.stop(); assert.ok(!fake.playing());
    }, 300);
}

/* ---------- head unit: BMW media route (fake AudioManager) + route backend ---------- */
const { HuRoute, endpoint } = require(APP + '/hu_route');
function fakeAm(opts) {
    const o = Object.assign({ sources: ['CarPlayMedia', 'CarLifeMedia'], frontBusy: false }, opts || {});
    const st = { calls: [], links: [] };
    const src = o.sources.map((name, i) => ({ name, sourceID: 260 + i, availability: { availability: 'A_AVAILABLE' } }));
    const sinks = [{ name: 'MediaSink_Front', sinkID: 1024, availability: 1 }, { name: 'NaviSink', sinkID: 1030, availability: 1 }];
    if (o.frontBusy) st.links.push({ mainConnectionID: 7, sourceID: 260, sinkID: 1024, connectionState: 'CS_CONNECTED' });
    st.signals = {
        proxy: () => 'P',
        call: async (proxy, m, args) => {
            st.calls.push(m);
            if (m === 'getListMainSources') return { amError: 'E_OK', listMainSources: src };
            if (m === 'getListMainSinks') return { amError: 'E_OK', listMainSinks: sinks };
            if (m === 'getListMainConnections') return { amError: 'E_OK', listMainConnections: st.links.slice() };
            if (m === 'connect') { st.links.push({ mainConnectionID: 42, sourceID: args.sourceID, sinkID: args.sinkID, connectionState: 2 }); return { amError: 'E_OK', mainConnectionID: 42 }; }
            if (m === 'disconnect') { st.links = st.links.filter((c) => c.mainConnectionID !== args.mainConnectionID); return { amError: 0 }; }
            throw new Error('unexpected ' + m);
        },
    };
    return st;
}
(async () => {
    assert.strictEqual(endpoint('CarLifeMedia'), 'plug:smartx:CarLifeMedia_CF_48_STEREO');
    // discovery is read only and names the usable candidate
    let am = fakeAm();
    const r = await new HuRoute(am.signals, { wait: async () => {} }).discover(async () => {});
    assert.strictEqual(r.chosen, 'CarLifeMedia');
    assert.deepStrictEqual(r.candidates.map((c) => c.present), [false, false, true]);
    assert.ok(!am.calls.includes('connect') && !am.calls.includes('disconnect'), 'discover never connects');
    // busy front speakers (music): refuse, never touch the foreign connection
    am = fakeAm({ frontBusy: true });
    await assert.rejects(new HuRoute(am.signals, { wait: async () => {} }).acquire(() => true, async () => {}), /busy/);
    assert.ok(!am.calls.includes('connect') && am.links.length === 1);
    // free: connect, then release exactly our own connection
    am = fakeAm();
    const route = new HuRoute(am.signals, { wait: async () => {} });
    assert.strictEqual(await route.acquire(() => true, async () => {}), 'plug:smartx:CarLifeMedia_CF_48_STEREO');
    assert.deepStrictEqual(am.links.map((c) => [c.sourceID, c.sinkID]), [[261, 1024]]);
    await route.release();
    assert.strictEqual(am.links.length, 0); assert.strictEqual(route.owner, null);
    // no candidate present
    am = fakeAm({ sources: ['CarPlayMedia', 'TunerMedia'] });
    await assert.rejects(new HuRoute(am.signals, { wait: async () => {} }).acquire(() => true, async () => {}), /No free BMW media source/);
    // live player over the route: helper gets the endpoint, stop releases the route
    am = fakeAm();
    const spawned = [];
    const pl = new LivePlayer({ profile: E.get('diesel6'), dspClient: null, find: () => null, helper: '/x/mgu-sound-pcm', exists: () => true,
        route: new HuRoute(am.signals, { wait: async () => {} }),
        execFile: (bin, args, opts, cb) => { assert.strictEqual(args[0], '--probe'); cb(null, '{}', ''); },
        spawn: (bin, args) => { const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
            c.kill = () => c.emit('close', 0); c.bytes = 0; c.stdin.on('data', (d) => { c.bytes += d.length; }); spawned.push({ bin, args, c }); return c; } });
    assert.strictEqual(pl.backend().route, true);
    pl.set(1500, 0.5, true, 0.5); assert.ok(pl.start());
    await new Promise((res) => setTimeout(res, 250));
    assert.deepStrictEqual(spawned.map((x) => [x.bin, x.args[0]]), [['/x/mgu-sound-pcm', 'plug:smartx:CarLifeMedia_CF_48_STEREO']]);
    assert.ok(spawned[0].c.bytes > 0.1 * 48000 * 4 && spawned[0].c.bytes < 0.5 * 48000 * 4, 'paced, short lead: ' + spawned[0].c.bytes);
    spawned[0].c.stdout.write('{"writtenFrames":4800,"droppedFrames":0}\n');
    await new Promise((res) => setImmediate(res));
    assert.strictEqual(pl.stats.writtenFrames, 4800);
    pl.stop();
    await new Promise((res) => setTimeout(res, 20));
    assert.strictEqual(am.links.length, 0, 'route released on stop');
    // the native helper: glibc <= 2.17, refuses anything but a SmartX media endpoint
    const helper = path.join(__dirname, '../native/sound-pcm/mgu-sound-pcm');
    assert.ok(fs.statSync(helper).mode & 0o111, 'helper executable');
    const cp = require('child_process');
    try {
        const vers = cp.execFileSync('objdump', ['-T', helper], { encoding: 'utf8' }).match(/GLIBC_[0-9.]+/g) || [];
        vers.forEach((v) => { const n = v.slice(6).split('.').map(Number); assert.ok(n[0] < 2 || (n[0] === 2 && (n[1] || 0) <= 17), 'helper needs ' + v); });
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (process.platform === 'linux' && process.arch === 'x64') {
        for (const d of ['default', 'hw:0', 'plughw:0,0', 'smartx:CarPlayMain_CF_48_STEREO', 'smartx:NaviAnnouncement_CF_48_STEREO', 'smartx:x:y_CF_48_STEREO']) {
            const res = cp.spawnSync(helper, ['--probe', d], { encoding: 'utf8' });
            assert.strictEqual(res.status, 2, d + ' refused');
        }
    }
})().catch((e) => { console.error(e); process.exit(1); });

/* ---------- WAV export ---------- */
(async () => {
    const wav = await renderDrive(E.get('v12'), { seconds: 2 });
    assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF'); assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
    assert.strictEqual(wav.readUInt16LE(22), 2); assert.strictEqual(wav.readUInt32LE(24), 44100);
    assert.strictEqual(wav.readUInt32LE(40), 2 * 44100 * 4); assert.strictEqual(wav.length, 44 + 2 * 44100 * 4);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-sound-'));
    const r = await exportDrive(E.get('rotary'), dir);
    assert.strictEqual(path.basename(r.file), 'active-sound-rotary.wav');
    assert.ok(fs.statSync(r.file).size === r.bytes && r.bytes > 4e6);
    assert.deepStrictEqual(fs.readdirSync(dir), ['active-sound-rotary.wav'], 'no temp file left');

    /* ---------- phone page + worklet ---------- */
    const html = pages.build({ mode: 'car', token: 'abc' });
    const scripts = html.split('<script>').slice(1).map((s) => s.split('</script>')[0]);
    assert.strictEqual(scripts.length, 4);
    scripts.forEach((s) => new vm.Script(s));            // all of it parses
    assert.ok(html.indexOf('"abc"') > 0 && html.indexOf('/worklet.js') > 0);
    const demo = pages.build({ mode: 'demo' });
    assert.ok(demo.indexOf('id="pedal"') > 0 && demo.indexOf('id="brake"') > 0 && demo.indexOf('id="tune"') > 0);
    // the worklet runs in a fake AudioWorkletGlobalScope and makes sound
    let Proc = null;
    const scope = { sampleRate: 48000, registerProcessor: (n, c) => { assert.strictEqual(n, 'active-sound'); Proc = c; },
        AudioWorkletProcessor: class { constructor() { this.port = {}; } }, Math, Float32Array };
    scope.globalThis = scope;
    vm.runInNewContext(pages.worklet(), scope);
    const proc = new Proc();
    proc.port.onmessage({ data: { type: 'profile', id: 'v10', tune: { rasp: 1.5 } } });
    proc.port.onmessage({ data: { type: 'tune', tune: { pops: 2 } } });
    assert.deepStrictEqual(proc.synth.tune, { pops: 2 });
    proc.port.onmessage({ data: { type: 'set', rpm: 6000, load: 1, on: true, volume: 0.8 } });
    const out = [new Float32Array(128), new Float32Array(128)];
    let energy = 0;
    for (let i = 0; i < 400; i++) { assert.strictEqual(proc.process([], [out]), true); energy += out[0].reduce((a, v) => a + v * v, 0); }
    assert.ok(energy > 1, 'worklet output');

    /* ---------- phone server ---------- */
    let st = { on: false, profile: 'inline6', volume: 0.5, tune: {} };
    const server = new WebServer({ state: () => Object.assign({ ok: true, rpm: 1000, load: 0.2, running: true }, st),
        set: (b) => { Object.assign(st, b); return { ok: true }; } }, { warn() {} }, { token: 'tok', port: 0, netStatusPort: 1 });
    server.start();
    await new Promise((res) => server.http.on('listening', res));
    const port = server.http.address().port;
    const req = (method, p, body) => new Promise((res, rej) => {
        const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'Content-Type': 'application/json' } }, (x) => {
            let d = ''; x.on('data', (c) => { d += c; }); x.on('end', () => res({ status: x.statusCode, body: d, headers: x.headers }));
        });
        r.on('error', rej); if (body) r.write(body); r.end();
    });
    assert.strictEqual((await req('GET', '/api/state')).status, 403, 'token required');
    assert.strictEqual((await req('GET', '/?t=bad')).status, 403);
    const health = await req('GET', '/.mgu-active-sound-health');
    assert.strictEqual(health.status, 200); assert.strictEqual(health.headers['x-mgu-active-sound'], '1');
    const page = await req('GET', '/?t=tok');
    assert.ok(page.status === 200 && page.body.indexOf('ACTIVE SOUND') > 0);
    const w = await req('GET', '/worklet.js?t=tok');
    assert.ok(w.status === 200 && /javascript/.test(w.headers['content-type']) && w.body.indexOf('registerProcessor') > 0);
    assert.strictEqual(JSON.parse((await req('GET', '/api/state?t=tok')).body).rpm, 1000);
    assert.strictEqual((await req('POST', '/api/set?t=tok', JSON.stringify({ on: true, profile: 'v12' }))).status, 200);
    assert.ok(st.on && st.profile === 'v12');
    assert.strictEqual((await req('POST', '/api/set?t=tok', JSON.stringify({ tune: { pops: 2 } }))).status, 200);
    assert.deepStrictEqual(st.tune, { pops: 2 });
    assert.strictEqual((await req('POST', '/api/set?t=tok', '[1]')).status, 400);
    assert.strictEqual((await req('POST', '/api/set?t=tok', 'x'.repeat(5000))).status, 413);
    assert.ok(server.phoneConnected());
    server.stop();

    /* ---------- firewall helper ---------- */
    const { makeFirewall, PORT, TAG } = require(NET + '/firewall');
    assert.strictEqual(PORT, 18885); assert.strictEqual(TAG, 'mgu-sound-net');
    const rows = ['iifname "wlan_bridge" tcp dport 18890 accept comment "mgu-phone-bridge" # handle 1'];
    const calls = [];
    const fw = makeFirewall({ run: (args) => {
        calls.push(args.join(' '));
        if (args[0] === '-a') return Promise.resolve(rows.join('\n'));
        if (args[0] === 'insert') rows.unshift('iifname "wlan_bridge" tcp dport 18885 accept comment "mgu-sound-net" # handle 7');
        if (args[0] === 'delete') rows.splice(rows.findIndex((r) => r.indexOf('handle ' + args[args.length - 1]) >= 0), 1);
        return Promise.resolve('');
    } });
    assert.strictEqual(await fw.ensure(), 'added');
    assert.strictEqual(await fw.ensure(), 'kept');
    await fw.close();
    assert.deepStrictEqual(rows, ['iifname "wlan_bridge" tcp dport 18890 accept comment "mgu-phone-bridge" # handle 1'], 'other tools untouched');
    const comp = JSON.parse(fs.readFileSync(NET + '/component.json', 'utf8'));
    assert.strictEqual(comp.id, 'mgu-sound-net');

    /* ---------- manifest, store, Node 8 syntax ---------- */
    const app = JSON.parse(fs.readFileSync(APP + '/app.json', 'utf8'));
    // every BMW bar button is drawn on the page: main.js hides all of them (the bar covered the footer in the car)
    const mainSrc = fs.readFileSync(APP + '/main.js', 'utf8');
    const hidden = (mainSrc.match(/\[('BTN_[A-Z_]+',?\s*)+\]\.forEach\(\(id\) => ctx\.hideButton\(id\)\)/) || [''])[0];
    for (const [id] of app.screens[0].buttons) assert.ok(hidden.indexOf("'" + id + "'") >= 0, id + ' hidden from the BMW bar');
    const repo = JSON.parse(fs.readFileSync(path.join(__dirname, '../mgu-repo.json'), 'utf8'));
    const entry = repo.components.find((c) => c.id === 'active_sound');
    assert.ok(entry && entry.version === app.version && entry.requires['mgu-sound-net'] === comp.version);
    assert.ok(repo.components.find((c) => c.id === 'mgu-sound-net' && c.version === comp.version && c.path === 'native/sound-net'));
    for (const f of fs.readdirSync(APP).filter((f) => /\.js$/.test(f) && f !== 'qr_vendor.js')) {
        const src = fs.readFileSync(path.join(APP, f), 'utf8');
        assert.ok(!/\?\.[a-zA-Z_(\[]|\?\?/.test(src), f + ': no ?. or ?? (head unit runs Node 8)');
    }
    console.log('active_sound tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
