'use strict';
// Active Sound 0.1: engine profiles, synthesizer, car mapping, head-unit player, WAV export,
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
const { EngineSynth } = require(APP + '/synth');
const M = require(APP + '/mapping');
const { LivePlayer, renderDrive, exportDrive, drive } = require(APP + '/player');
const { WebServer } = require(APP + '/web-server');
const pages = require(APP + '/web-page');
const NET = path.join(__dirname, '../native/sound-net');

const SR = 44100;
function render(id, rpm, load, seconds, on) {
    const s = new EngineSynth(SR, E.get(id), 7);
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
    assert.ok(E.PROFILES.length >= 16, 'at least 16 engines');
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
/* stereo + S16 */
{
    const s = new EngineSynth(SR, E.get('flat6'), 9); s.set(5000, 1, true, 1);
    const l = new Float32Array(512), r = new Float32Array(512); s.render(l, r, 512);
    assert.deepStrictEqual(Array.from(l), Array.from(r));
    const buf = s.renderS16(100); assert.strictEqual(buf.length, 400);
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
    assert.ok(spawned[0].args.indexOf('S16_LE') >= 0 && spawned[0].args.indexOf('44100') >= 0);
    setTimeout(() => {
        const b = spawned[0].c.bytes, expect = (300 + 120) / 1000 * 44100 * 4;
        assert.ok(b > expect * 0.6 && b < expect * 1.6, 'clock-paced output: ' + b + ' bytes');
        fake.stop(); assert.ok(!fake.playing());
    }, 300);
}

/* ---------- WAV export ---------- */
(async () => {
    assert.strictEqual(drive(0).n, 0); assert.strictEqual(drive(16).load, 1); assert.strictEqual(drive(19).load, 0);
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
    assert.strictEqual(scripts.length, 3);
    scripts.forEach((s) => new vm.Script(s));            // all of it parses
    assert.ok(html.indexOf('"abc"') > 0 && html.indexOf('/worklet.js') > 0);
    const demo = pages.build({ mode: 'demo' });
    assert.ok(demo.indexOf('id="gas"') > 0 && demo.indexOf('/api/') > 0 === true);
    // the worklet runs in a fake AudioWorkletGlobalScope and makes sound
    let Proc = null;
    const scope = { sampleRate: 48000, registerProcessor: (n, c) => { assert.strictEqual(n, 'active-sound'); Proc = c; },
        AudioWorkletProcessor: class { constructor() { this.port = {}; } }, Math, Float32Array };
    scope.globalThis = scope;
    vm.runInNewContext(pages.worklet(), scope);
    const proc = new Proc();
    proc.port.onmessage({ data: { type: 'profile', id: 'v10' } });
    proc.port.onmessage({ data: { type: 'set', rpm: 6000, load: 1, on: true, volume: 0.8 } });
    const out = [new Float32Array(128), new Float32Array(128)];
    let energy = 0;
    for (let i = 0; i < 400; i++) { assert.strictEqual(proc.process([], [out]), true); energy += out[0].reduce((a, v) => a + v * v, 0); }
    assert.ok(energy > 1, 'worklet output');

    /* ---------- phone server ---------- */
    let st = { on: false, profile: 'inline6', volume: 0.5 };
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
