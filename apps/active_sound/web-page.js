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
            if (m.type === 'profile') this.synth.setProfile(ActiveSoundEngines.get(m.id));
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
.gas{user-select:none;-webkit-user-select:none;touch-action:none;height:120px;font-size:22px}
.note{font-size:13px;color:#8592a5;margin:8px 2px}
.err{color:#ff8a8f}
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
        ? 'Demo: hold GAS or switch on auto drive. Sound plays on this phone (and through the car with CarPlay or Bluetooth).'
        : 'The phone makes the sound. With CarPlay or Bluetooth audio connected it plays through the car speakers. Keep this page open.'}</p>
</div>
${cfg.mode === 'demo' ? `<div class="card"><div class="row"><button id="gas" class="big gas">GAS</button></div>
<div class="row" style="margin-top:10px"><button id="auto" class="big off">AUTO DRIVE: OFF</button></div></div>` : `<div class="card"><div class="row">
  <button id="power" class="big off">CAR SOUND: OFF</button></div><p class="note" id="carline">Connecting to the car...</p></div>`}
<div class="card"><div class="lbl">VOLUME <span id="volv"></span></div><input id="vol" type="range" min="0" max="100" step="5" value="50"></div>
<div class="card"><div class="lbl">ENGINE</div><div class="grid" id="engines"></div></div>
<p class="note">Original synthesized sounds, no recordings. Keep the volume moderate: warning and navigation sounds must stay audible.</p>
</main>
<script>${source('engines.js')}</script>
<script>${source('synth.js')}</script>
<script>
(function () {
'use strict';
var MODE = ${JSON.stringify(cfg.mode)}, TOKEN = ${JSON.stringify(cfg.token || '')};
var E = ActiveSoundEngines;
var st = { on: MODE === 'demo', profile: E.DEFAULT, volume: 0.5, rpm: 0, load: 0, running: MODE === 'demo', demo: false, at: 0, reason: '' };
var ctx = null, node = null, local = null, enabled = false, lastErr = '', wake = null;
var $ = function (id) { return document.getElementById(id); };
function q(p) { return p + (p.indexOf('?') < 0 ? '?' : '&') + 't=' + encodeURIComponent(TOKEN); }

// ---------- audio
function post(m) { if (node) node.port.postMessage(m); else if (local) { if (m.type === 'profile') local.setProfile(E.get(m.id)); else local.set(m.rpm, m.load, m.on, m.volume); } }
function fresh() { return MODE === 'demo' || Date.now() - st.at < 1500; }
function audible() { return enabled && st.on && st.running && fresh(); }
function push() { post({ type: 'set', rpm: st.rpm, load: st.load, on: audible(), volume: st.volume }); }
function startScript() {
    local = new ActiveSoundSynth.EngineSynth(ctx.sampleRate, E.get(st.profile), 99);
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
    var done = function () { post({ type: 'profile', id: st.profile }); push(); draw(); };
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
        if (v.profile !== st.profile) { st.profile = v.profile; post({ type: 'profile', id: st.profile }); buildEngines(); }
        st.on = !!v.on; st.volume = v.volume; st.rpm = v.rpm; st.load = v.load; st.running = !!v.running;
        st.demo = !!v.demo; st.reason = v.reason || ''; st.at = Date.now(); st.realRpm = v.realRpm; st.speed = v.speed;
        if (document.activeElement !== $('vol')) $('vol').value = Math.round(st.volume * 100);
        push();
    }, function () { busy = false; push(); });
}

// ---------- demo drive (no car)
var sim = { n: 0, gear: 1, gas: false, auto: false, t: 0, last: 0 };
function simStep(now) {
    var dt = Math.min(0.1, (now - (sim.last || now)) / 1000); sim.last = now; sim.t += dt;
    var gas = sim.gas;
    if (sim.auto) { var c = sim.t % 14; gas = (c > 1.5 && c < 8.5) || (c > 10 && c < 10.6); }
    if (gas) {
        sim.n += dt * (0.55 / sim.gear + 0.08);
        if (sim.n > 0.97 && sim.gear < 5 && !sim.gas) { sim.gear++; sim.n = 0.62; }
        if (sim.n > 1.02) sim.n = 1.02;
        st.load += (1 - st.load) * Math.min(1, dt * 12);
    } else {
        sim.n -= dt * (sim.gear > 1 ? 0.18 : 0.6);
        if (sim.n < 0.35 && sim.gear > 1) { sim.gear--; sim.n = 0.6; }
        if (sim.n < 0) { sim.n = 0; sim.gear = 1; }
        st.load += (0.02 - st.load) * Math.min(1, dt * 14);
    }
    var p = E.get(st.profile);
    st.rpm = p.idle + Math.max(0, sim.n) * (p.redline - p.idle);
    if (sim.n < 0.02 && !gas) st.rpm += Math.sin(now / 90) * 12;
    push();
}

// ---------- UI
function buildEngines() {
    var g = $('engines'); g.innerHTML = '';
    E.PROFILES.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'eng' + (p.id === st.profile ? ' on' : '');
        b.innerHTML = '<b></b><span></span>';
        b.firstChild.textContent = p.name; b.lastChild.textContent = E.spec(p);
        b.onclick = function () { st.profile = p.id; post({ type: 'profile', id: p.id }); push(); send({ profile: p.id }); buildEngines(); };
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
    g.font = '700 30px -apple-system,Segoe UI,Roboto,sans-serif'; g.fillStyle = '#8b97aa'; g.fillText('RPM  -  ' + p.name.toUpperCase(), cx, cy - 40);
    g.fillStyle = '#1b2431'; g.fillRect(cx - 200, cy - 14, 400, 12);
    g.fillStyle = '#e1001a'; g.fillRect(cx - 200, cy - 14, 400 * Math.max(0, Math.min(1, st.load)), 12);
    g.font = '700 22px -apple-system,Segoe UI,Roboto,sans-serif'; g.fillStyle = '#8b97aa'; g.fillText('LOAD', cx, cy + 24);
}

$('audio').onclick = startAudio;
$('vol').oninput = function () { st.volume = this.value / 100; push(); draw(); };
$('vol').onchange = function () { send({ volume: st.volume }); };
if ($('power')) $('power').onclick = function () { st.on = !st.on; push(); draw(); send({ on: st.on }); };
if ($('gas')) {
    var down = function (e) { e.preventDefault(); sim.gas = true; sim.auto = false; $('auto').textContent = 'AUTO DRIVE: OFF'; $('auto').className = 'big off'; if (!ctx) startAudio(); };
    var up = function (e) { e.preventDefault(); sim.gas = false; };
    ['pointerdown'].forEach(function (n) { $('gas').addEventListener(n, down); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (n) { $('gas').addEventListener(n, up); });
    $('auto').onclick = function () { sim.auto = !sim.auto; sim.t = 0; this.textContent = 'AUTO DRIVE: ' + (sim.auto ? 'ON' : 'OFF'); this.className = 'big' + (sim.auto ? '' : ' off'); if (!ctx) startAudio(); };
}
buildEngines(); draw(); tach();
setInterval(function () { if (MODE === 'demo') simStep(Date.now()); else poll(); }, 60);
setInterval(function () { if (MODE !== 'demo') push(); draw(); }, 250);
(function loop() { tach(); requestAnimationFrame(loop); })();
})();
</script></body></html>`;
}

function build(cfg) { return page(Object.assign({ mode: 'car', token: '' }, cfg || {})); }

module.exports = { build, worklet, WORKLET };
