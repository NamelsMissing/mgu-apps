'use strict';
/*
 * web-page.js - the phone page of Active Sound.
 *
 * The phone synthesizes the engine sound itself (same engines.js + synth.js as the head unit,
 * in an AudioWorklet, ScriptProcessor as fallback) and plays it. With CarPlay or Bluetooth
 * audio active, the car's speakers play it. The page polls the car's virtual rpm / load ~16x
 * a second; without fresh data for 1.5 s the sound fades out (never a hanging drone).
 *
 * build({ mode: 'car' })   page served by the app (token in the URL, /api/state, /api/set)
 * build({ mode: 'demo' })  standalone page: hold GAS / auto drive, no car needed
 * worklet()                the AudioWorklet module served at /worklet.js
 */
const fs = require('fs');
const path = require('path');

function source(name) { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }

function worklet() {
    return source('engines.js') + '\n' + source('synth.js') + '\n' + WORKLET;
}

const WORKLET = `
class ActiveSoundProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.synth = new ActiveSoundSynth.EngineSynth(sampleRate, ActiveSoundEngines.get('${'inline6'}'), 99);
        this.port.onmessage = (e) => {
            const m = e.data || {};
            if (m.type === 'profile') this.synth.setProfile(ActiveSoundEngines.get(m.id), m.tune || null);
            else if (m.type === 'tune') this.synth.setTune(m.tune || null);
            else if (m.type === 'set') this.synth.set(m.rpm, m.load, m.on, m.volume);
        };
    }
    process(inputs, outputs) {
        const o = outputs[0];
        if (o && o[0]) this.synth.render(o[0], o[1] || null, o[0].length);
        return true;
    }
}
registerProcessor('active-sound', ActiveSoundProcessor);
`;

const CSS = `
*{box-sizing:border-box}html,body{margin:0;background:#05070b;color:#eef2f8;font:16px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
main{max-width:560px;margin:0 auto;padding:14px 14px 40px}
header{display:flex;align-items:center;justify-content:space-between;margin:4px 2px 12px}
h1{font-size:15px;letter-spacing:3px;margin:0;font-weight:800}
h1 b{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:2px;vertical-align:1px}
.chip{font-size:12px;font-weight:700;letter-spacing:1px;padding:5px 10px;border-radius:99px;background:#1b2330;color:#9aa6b8}
.chip.ok{background:#0f3b2c;color:#4be3a6}.chip.warn{background:#3d2a08;color:#ffb83d}.chip.bad{background:#3d0d10;color:#ff6b72}
.card{background:linear-gradient(180deg,#121924,#0b1018);border:1px solid #1f2a39;border-radius:18px;padding:14px;margin-bottom:12px}
canvas{display:block;width:100%;height:auto}
.big{width:100%;border:0;border-radius:16px;padding:18px;font-size:18px;font-weight:800;letter-spacing:2px;color:#fff;background:#e1001a}
.big.off{background:#1d2633;color:#c9d3e0}
.row{display:flex;gap:10px;align-items:center}.row>*{flex:1}
.lbl{font-size:12px;letter-spacing:2px;color:#8794a7;font-weight:700;margin:2px 0 10px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.eng{border:1px solid #233043;background:#0e141d;color:#e8edf5;border-radius:14px;padding:11px 12px;text-align:left}
.eng b{display:block;font-size:15px}.eng span{font-size:12px;color:#8592a5}
.eng.on{border-color:#e1001a;background:#2a0b10}
input[type=range]{width:100%;accent-color:#e1001a;height:34px}
.gas{user-select:none;-webkit-user-select:none;touch-action:none;height:170px;font-size:20px}
.pedal{position:relative;height:170px;border-radius:16px;background:#1d2633;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;display:flex;align-items:center;justify-content:center;text-align:center}
.pedal span{position:relative;font-weight:800;letter-spacing:2px;font-size:20px}.pedal small{font-size:11px;letter-spacing:0;font-weight:600;color:#c9d3e0}
#pedalfill{position:absolute;left:0;right:0;bottom:0;height:0;background:linear-gradient(0deg,#e1001a,#ff5a3c)}
.note{font-size:13px;color:#8592a5;margin:8px 2px}
.err{color:#ff8a8f}
.tune{display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center;margin-bottom:6px}
.tune b{font-size:14px}.tune i{font-style:normal;font-size:13px;color:#c9d3e0;font-weight:700;min-width:44px;text-align:right}
.tune small{grid-column:1/3;font-size:12px;color:#8592a5;margin-top:-4px}
.tune input{grid-column:1/3;height:30px}
.small{border:1px solid #233043;background:#0e141d;color:#e8edf5;border-radius:12px;padding:10px 14px;font-weight:700}
`;

function page(cfg) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#05070b"><title>Active Sound</title><style>${CSS}</style></head><body><main>
<header><h1><b style="background:#81c4ff"></b><b style="background:#16588e"></b><b style="background:#e7222e"></b> ACTIVE SOUND</h1><span id="chip" class="chip">-</span></header>
<div class="card"><canvas id="tach" width="1040" height="520"></canvas></div>
<div class="card">
  <button id="audio" class="big">TAP TO START SOUND</button>
  <p class="note" id="hint">${cfg.mode === 'demo'
        ? 'Demo with a simulated car (gears, weight, air resistance). Press the pedal (higher = more throttle), brake, or switch on auto drive.'
        : 'The phone makes the sound. With CarPlay or Bluetooth audio connected it plays through the car speakers. Keep this page open.'}</p>
</div>
${cfg.mode === 'demo' ? `<div class="card"><div class="row" style="align-items:stretch">
  <button id="brake" class="big off gas" style="flex:0 0 32%">BRAKE</button>
  <div id="pedal" class="pedal"><div id="pedalfill"></div><span>GAS<br><small>press higher = more throttle</small></span></div></div>
<div class="row" style="margin-top:10px"><button id="auto" class="big off">AUTO DRIVE: OFF</button></div></div>` : `<div class="card"><div class="row">
  <button id="power" class="big off">CAR SOUND: OFF</button></div><p class="note" id="carline">Connecting to the car...</p></div>`}
<div class="card"><div class="lbl">VOLUME <span id="volv"></span></div><input id="vol" type="range" min="0" max="100" step="5" value="50"></div>
<div class="card"><div class="lbl">ENGINE</div><div class="grid" id="engines"></div></div>
<div class="card"><div class="lbl">TUNE <span id="tunename"></span></div><div id="tune"></div>
  <button id="tunereset" class="small">Reset this sound</button></div>
<p class="note">Original synthesized sounds, no recordings. Keep the volume moderate: warning and navigation sounds must stay audible.</p>
</main>
<script>${source('engines.js')}</script>
<script>${source('synth.js')}</script>
<script>${source('vehicle.js')}</script>
<script>
(function () {
'use strict';
var MODE = ${JSON.stringify(cfg.mode)}, TOKEN = ${JSON.stringify(cfg.token || '')};
var E = ActiveSoundEngines;
var st = { tune: {}, on: MODE === 'demo', profile: E.DEFAULT, volume: 0.5, rpm: 0, load: 0, running: MODE === 'demo', demo: false, at: 0, reason: '' };
var ctx = null, node = null, local = null, enabled = false, lastErr = '', wake = null;
var $ = function (id) { return document.getElementById(id); };
function q(p) { return p + (p.indexOf('?') < 0 ? '?' : '&') + 't=' + encodeURIComponent(TOKEN); }

// ---------- audio
function post(m) {
    if (node) return node.port.postMessage(m);
    if (!local) return;
    if (m.type === 'profile') local.setProfile(E.get(m.id), m.tune || null);
    else if (m.type === 'tune') local.setTune(m.tune || null);
    else local.set(m.rpm, m.load, m.on, m.volume);
}
function fresh() { return MODE === 'demo' || Date.now() - st.at < 1500; }
function audible() { return enabled && st.on && st.running && fresh(); }
function push() { post({ type: 'set', rpm: st.rpm, load: st.load, on: audible(), volume: st.volume }); }
function startScript() {
    local = new ActiveSoundSynth.EngineSynth(ctx.sampleRate, E.get(st.profile), 99, st.tune);
    var sp = ctx.createScriptProcessor(1024, 0, 2);
    sp.onaudioprocess = function (e) { var b = e.outputBuffer; local.render(b.getChannelData(0), b.getChannelData(1), b.length); };
    sp.connect(ctx.destination);
}
function startAudio() {
    if (ctx) { ctx.resume(); enabled = !enabled; draw(); return; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { lastErr = 'This browser has no Web Audio.'; draw(); return; }
    ctx = new AC({ latencyHint: 'interactive' });
    enabled = true;
    var done = function () { post({ type: 'profile', id: st.profile, tune: st.tune }); push(); draw(); };
    var url = ${cfg.mode === 'demo' ? 'null' : "q('/worklet.js')"};
    var viaWorklet = function () {
        if (!ctx.audioWorklet) return Promise.reject(new Error('no AudioWorklet'));
        if (!url) {
            var code = [].map.call(document.querySelectorAll('script'), function (s) { return s.textContent; }).slice(0, 2).join('\\n') + ${JSON.stringify(WORKLET)};
            url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        }
        return ctx.audioWorklet.addModule(url).then(function () {
            node = new AudioWorkletNode(ctx, 'active-sound', { numberOfInputs: 0, outputChannelCount: [2] });
            node.connect(ctx.destination);
        });
    };
    viaWorklet().catch(function () { startScript(); }).then(done, function (e) { lastErr = String(e); draw(); });
    ctx.resume();
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { wake = w; }, function () {}); } catch (e) {}
}
document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && enabled && navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { wake = w; }, function () {});
});

// ---------- car link
function send(body) {
    if (MODE === 'demo') return;
    fetch(q('/api/set'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(function () {});
}
var busy = false;
function poll() {
    if (MODE === 'demo' || busy) return;
    busy = true;
    fetch(q('/api/state'), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
        busy = false;
        if (!v || !v.ok) return;
        var tj = JSON.stringify(v.tune || {});
        if (v.profile !== st.profile) { st.profile = v.profile; st.tune = v.tune || {}; post({ type: 'profile', id: st.profile, tune: st.tune }); buildEngines(); buildTune(); }
        else if (tj !== JSON.stringify(st.tune) && Date.now() - tuneTouched > 1500) { st.tune = v.tune || {}; post({ type: 'tune', tune: st.tune }); buildTune(); }
        st.on = !!v.on; st.volume = v.volume; st.rpm = v.rpm; st.load = v.load; st.running = !!v.running;
        st.demo = !!v.demo; st.reason = v.reason || ''; st.at = Date.now(); st.realRpm = v.realRpm; st.speed = v.speed;
        if (document.activeElement !== $('vol')) $('vol').value = Math.round(st.volume * 100);
        push();
    }, function () { busy = false; push(); });
}

// ---------- demo drive (no car): vehicle model with gears, inertia, resistance (vehicle.js)
var sim = { gas: 0, brake: 0, auto: false, t: 0, last: 0, car: null };
function simCar() {
    var p = E.get(st.profile);
    if (sim.car && sim.car.p === p) return sim.car;
    var old = sim.car, car = new ActiveSoundVehicle.VehicleSim(p);
    if (old && car.ratios.length > 1) {          // keep the speed, pick a sensible gear
        car.v = old.v;
        for (var g = car.ratios.length; g >= 1; g--) if (car.wheelRpm(g) > p.idle * 1.3 || g === 1) { car.gear = g; break; }
    } else if (old) car.v = old.v;
    sim.car = car;
    return car;
}
function simStep(now) {
    var dt = Math.min(0.1, (now - (sim.last || now)) / 1000); sim.last = now;
    var car = simCar(), u = sim.gas, b = sim.brake, out = null;
    for (var left = dt; left > 1e-6; left -= 0.01) {
        var h = Math.min(0.01, left);
        sim.t += h;
        if (sim.auto) { var c = ActiveSoundVehicle.script(sim.t % ActiveSoundVehicle.DRIVE_SECONDS); u = c.u; b = c.b; }
        out = car.step(h, u, b);
    }
    if (!out) return;
    st.rpm = out.rpm; st.load = out.load; st.gear = out.gear; st.kmh = out.kmh; st.pedal = u;
    if (out.rpm < E.get(st.profile).idle * 1.02 && out.kmh < 1) st.rpm += Math.sin(now / 90) * 10;   // idle wobble
    push();
}

// ---------- tuning (per engine; on the car page saved in the car)
var tuneTouched = 0, demoTunes = {};
function pct(v) { return v === 0 ? 'Off' : Math.round(v * 100) + ' %'; }
function buildTune() {
    var box = $('tune'), p = E.get(st.profile); box.innerHTML = '';
    $('tunename').textContent = '- ' + p.name.toUpperCase();
    E.tuneKeys(p).forEach(function (c) {
        var v = st.tune[c.key] === undefined ? 1 : st.tune[c.key];
        var row = document.createElement('div'); row.className = 'tune';
        row.innerHTML = '<b></b><i></i><small></small><input type="range" min="0" max="' + E.TUNE_MAX + '" step="' + E.TUNE_STEP + '">';
        row.children[0].textContent = c.name; row.children[1].textContent = pct(v); row.children[2].textContent = c.desc;
        var r = row.children[3]; r.value = v;
        r.oninput = function () {
            var x = Number(r.value); tuneTouched = Date.now();
            st.tune = E.cleanTune(p, Object.assign({}, st.tune, (function () { var o = {}; o[c.key] = x; return o; })()));
            row.children[1].textContent = pct(x); post({ type: 'tune', tune: st.tune });
        };
        r.onchange = function () { var o = {}; o[c.key] = Number(r.value); send({ tune: o }); };
        box.appendChild(row);
    });
}
$('tunereset').onclick = function () { st.tune = {}; tuneTouched = Date.now(); post({ type: 'tune', tune: st.tune }); buildTune(); send({ tuneReset: true }); };

// ---------- UI
function buildEngines() {
    var g = $('engines'); g.innerHTML = '';
    E.PROFILES.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'eng' + (p.id === st.profile ? ' on' : '');
        b.innerHTML = '<b></b><span></span>';
        b.firstChild.textContent = p.name; b.lastChild.textContent = E.spec(p);
        b.onclick = function () {
            if (MODE === 'demo') { demoTunes[st.profile] = st.tune; st.tune = demoTunes[p.id] || {}; } else st.tune = {};
            st.profile = p.id; post({ type: 'profile', id: p.id, tune: st.tune }); push(); send({ profile: p.id }); buildEngines(); buildTune();
        };
        g.appendChild(b);
    });
}
function draw() {
    var a = $('audio'); a.textContent = !ctx ? 'TAP TO START SOUND' : enabled ? 'PHONE SOUND: ON' : 'PHONE SOUND: OFF';
    a.className = 'big' + (enabled ? '' : ' off');
    if ($('power')) { $('power').textContent = 'CAR SOUND: ' + (st.on ? 'ON' : 'OFF'); $('power').className = 'big' + (st.on ? '' : ' off'); }
    $('volv').textContent = Math.round(st.volume * 100) + ' %';
    var chip = $('chip'), ok = fresh();
    if (lastErr) { chip.textContent = 'ERROR'; chip.className = 'chip bad'; $('hint').innerHTML = '<span class="err"></span>'; $('hint').firstChild.textContent = lastErr; }
    else if (MODE === 'demo') { chip.textContent = 'DEMO'; chip.className = 'chip warn'; }
    else if (!ok) { chip.textContent = 'NO CAR'; chip.className = 'chip bad'; }
    else if (st.demo) { chip.textContent = 'CAR DEMO DATA'; chip.className = 'chip warn'; }
    else if (!st.running) { chip.textContent = 'ENGINE OFF'; chip.className = 'chip'; }
    else { chip.textContent = audible() ? 'LIVE' : 'READY'; chip.className = 'chip ok'; }
    if ($('carline')) $('carline').textContent = !ok ? 'No answer from the car. Same Wi-Fi as the car? Scan the QR code again.'
        : st.running ? 'Engine ' + Math.round(st.realRpm || 0) + ' rpm, ' + Math.round(st.speed || 0) + ' km/h' + (st.demo ? ' (demo data: car not answering)' : '')
        : (st.reason || 'Engine off');
}
function tach() {
    var c = $('tach'), g = c.getContext('2d'), W = c.width, H = c.height, p = E.get(st.profile);
    g.clearRect(0, 0, W, H);
    var cx = W / 2, cy = H * 0.86, r = H * 0.72, a0 = Math.PI * 1.05, a1 = Math.PI * 1.95;
    var max = p.redline * 1.06, frac = function (v) { return Math.max(0, Math.min(1, v / max)); };
    g.lineCap = 'round';
    g.lineWidth = 26; g.strokeStyle = '#1b2431'; g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
    g.strokeStyle = '#5a1018'; g.beginPath(); g.arc(cx, cy, r, a0 + (a1 - a0) * frac(p.redline), a1); g.stroke();
    var on = audible() || MODE === 'demo';
    g.strokeStyle = st.rpm >= p.redline * 0.97 ? '#ff2b3a' : '#e8eef7';
    if (st.rpm > 0) { g.beginPath(); g.arc(cx, cy, r, a0, a0 + (a1 - a0) * frac(st.rpm)); g.stroke(); }
    g.fillStyle = on ? '#ffffff' : '#7d889a'; g.textAlign = 'center';
    g.font = '800 120px -apple-system,Segoe UI,Roboto,sans-serif'; g.fillText(Math.round(st.rpm / 10) * 10, cx, cy - 92);
    g.font = '700 30px -apple-system,Segoe UI,Roboto,sans-serif'; g.fillStyle = '#8b97aa';
    g.fillText(MODE === 'demo' && st.kmh !== undefined ? (p.kind === 'tonal' ? '' : 'GEAR ' + st.gear + '  -  ') + Math.round(st.kmh) + ' KM/H  -  ' + p.short
        : 'RPM  -  ' + p.name.toUpperCase(), cx, cy - 40);
    g.fillStyle = '#1b2431'; g.fillRect(cx - 200, cy - 14, 400, 12);
    g.fillStyle = '#e1001a'; g.fillRect(cx - 200, cy - 14, 400 * Math.max(0, Math.min(1, st.load)), 12);
    g.font = '700 22px -apple-system,Segoe UI,Roboto,sans-serif'; g.fillStyle = '#8b97aa'; g.fillText('LOAD', cx, cy + 24);
}

$('audio').onclick = startAudio;
$('vol').oninput = function () { st.volume = this.value / 100; push(); draw(); };
$('vol').onchange = function () { send({ volume: st.volume }); };
if ($('power')) $('power').onclick = function () { st.on = !st.on; push(); draw(); send({ on: st.on }); };
if ($('pedal')) {
    var stopAuto = function () { sim.auto = false; $('auto').textContent = 'AUTO DRIVE: OFF'; $('auto').className = 'big off'; };
    var pedal = $('pedal'), pid = null;
    var setGas = function (e) {
        var r = pedal.getBoundingClientRect();
        sim.gas = Math.max(0.1, Math.min(1, (r.bottom - e.clientY) / r.height * 1.15));
        $('pedalfill').style.height = Math.round(sim.gas * 100) + '%';
    };
    pedal.addEventListener('pointerdown', function (e) {
        e.preventDefault(); pid = e.pointerId; try { pedal.setPointerCapture(pid); } catch (x) {}
        stopAuto(); setGas(e); if (!ctx) startAudio();
    });
    pedal.addEventListener('pointermove', function (e) { if (e.pointerId === pid) setGas(e); });
    ['pointerup', 'pointercancel'].forEach(function (n) { pedal.addEventListener(n, function (e) {
        if (e.pointerId !== pid) return; pid = null; sim.gas = 0; $('pedalfill').style.height = '0';
    }); });
    $('brake').addEventListener('pointerdown', function (e) { e.preventDefault(); stopAuto(); sim.brake = 1; $('brake').className = 'big gas'; if (!ctx) startAudio(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (n) { $('brake').addEventListener(n, function () { sim.brake = 0; $('brake').className = 'big off gas'; }); });
    $('auto').onclick = function () { sim.auto = !sim.auto; sim.t = 0; this.textContent = 'AUTO DRIVE: ' + (sim.auto ? 'ON' : 'OFF'); this.className = 'big' + (sim.auto ? '' : ' off'); if (!ctx) startAudio(); };
}
buildEngines(); buildTune(); draw(); tach();
setInterval(function () { if (MODE === 'demo') simStep(Date.now()); else poll(); }, MODE === 'demo' ? 30 : 60);
setInterval(function () { if (MODE !== 'demo') push(); draw(); }, 250);
(function loop() { tach(); requestAnimationFrame(loop); })();
})();
</script></body></html>`;
}

function build(cfg) { return page(Object.assign({ mode: 'car', token: '' }, cfg || {})); }

module.exports = { build, worklet, WORKLET };
