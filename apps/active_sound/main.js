'use strict';
/*
 * Active Sound - active sound design for iDrive 7 (MGU).
 *
 * The real engine speed and torque drive a virtual engine: 21 synthesized engine sounds
 * (inline-6, V8, V10, V12, rotary, boxer, six diesels, electric, turbine ...), each tunable
 * (pops, bangs, bass, rasp, turbo, blow-off, engine brake ...). The sound is made
 * where a speaker can be reached:
 *   - Phone (default): the phone page (QR code) synthesizes the sound and plays it; with
 *     CarPlay or Bluetooth audio it comes out of the car speakers.
 *   - Head unit: live PCM through the Equalizer DSP into aplay / ffmpeg (default ALSA device),
 *     only where those players exist; BMW audio routing is never changed.
 * Read-only vehicle signals; nothing is written to the car.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const E = require('./engines');
const M = require('./mapping');
const { LivePlayer, exportDrive } = require('./player');
const { WebServer } = require('./web-server');
const { makeUi, PAGE, W, H } = require('./ui');

const OUTPUTS = ['phone', 'car', 'both'];
const VOLUME_STEP = 0.05;
const CONFIG_FILE = 'active-sound.json';

function loadConfig(dir, log) {
    const cfg = { profile: E.DEFAULT, on: false, volume: 0.6, output: 'phone',
        realRedline: M.DEFAULTS.realRedline, maxTorque: M.DEFAULTS.maxTorque, tune: {} };
    try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8'));
        if (v && typeof v === 'object') {
            if (typeof v.profile === 'string' && E.PROFILES.some((p) => p.id === v.profile)) cfg.profile = v.profile;
            if (typeof v.on === 'boolean') cfg.on = v.on;
            if (typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1) cfg.volume = v.volume;
            if (OUTPUTS.indexOf(v.output) >= 0) cfg.output = v.output;
            if (M.REAL_REDLINES.indexOf(v.realRedline) >= 0) cfg.realRedline = v.realRedline;
            if (M.MAX_TORQUES.indexOf(v.maxTorque) >= 0) cfg.maxTorque = v.maxTorque;
            if (v.tune && typeof v.tune === 'object') {
                E.PROFILES.forEach((p) => {
                    const t = E.cleanTune(p, v.tune[p.id]);
                    if (Object.keys(t).length) cfg.tune[p.id] = t;
                });
            }
        }
    } catch (e) { if (e.code !== 'ENOENT') log.warn('config: ' + e.message); }
    return cfg;
}
function saveConfig(dir, cfg, log) {
    const file = path.join(dir, CONFIG_FILE), tmp = file + '.tmp-' + process.pid;
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(cfg)); fs.renameSync(tmp, file); }
    catch (e) { log.warn('config save: ' + e.message); }
}

mgu.run({
    async start(ctx) {
        const log = ctx.log;
        const cfg = loadConfig(ctx.dataDir, log);
        const car = new Car(ctx, ['rpm', 'speed', 'torque', 'accel'], { pollMs: 3000 });
        const ui = makeUi(G);
        let page = PAGE.SOUND, notice = null, noticeAt = 0, dirty = true;
        let target = { running: false, rpm: 0, load: 0, reason: 'Starting', demo: false };
        let exporting = false, exportText = '';
        let huRetryAt = 0, huStopAt = 0;

        const say = (text) => { notice = text; noticeAt = Date.now(); dirty = true; };
        const profile = () => E.get(cfg.profile);
        const tuneOf = (id) => cfg.tune[id || cfg.profile] || {};
        const save = () => { saveConfig(ctx.dataDir, cfg, log); dirty = true; };
        const wantsHu = () => cfg.output === 'car' || cfg.output === 'both';
        // demo data (no car answering) only makes a sound when the user asked for demo data
        const demoAudible = () => ctx.settings.get('demo') === 'on';
        const sounding = () => cfg.on && target.running && (!target.demo || demoAudible());

        const player = new LivePlayer({ profile: profile(), tune: tuneOf(), log, onState: (s) => {
            if (s.status === 'error') say('Head unit audio: ' + s.detail);
            log.info('head unit audio ' + s.status + (s.detail ? ': ' + s.detail : ''));
            dirty = true;
        } });
        const huBackend = player.backend();
        log.info('Active Sound: head unit player ' + (huBackend ? huBackend.name + ' ' + huBackend.bin : 'not found (aplay/ffmpeg missing)'));

        const actions = {
            toggle: () => { cfg.on = !cfg.on; save(); say(cfg.on ? 'Sound on: ' + profile().name : 'Sound off'); },
            pick: (id) => {
                if (!E.PROFILES.some((p) => p.id === id)) throw new Error('Unknown engine');
                if (cfg.profile === id) return;
                cfg.profile = id; player.setProfile(profile(), tuneOf()); save(); say(profile().name);
            },
            /** Set tuning values for the current engine: { key: 0..2 }. */
            tune: (values) => {
                const p = profile(), merged = Object.assign({}, tuneOf(), values);
                const t = E.cleanTune(p, merged);
                if (Object.keys(t).length) cfg.tune[p.id] = t; else delete cfg.tune[p.id];
                player.setTune(t); save();
            },
            tuneStep: (key, d) => {
                const cur = tuneOf()[key] === undefined ? 1 : tuneOf()[key];
                actions.tune({ [key]: Math.max(0, Math.min(E.TUNE_MAX, cur + d * E.TUNE_STEP)) });
            },
            tuneReset: () => { delete cfg.tune[cfg.profile]; player.setTune(null); save(); say(profile().name + ': tuning reset'); },
            next: () => actions.pick(E.step(cfg.profile, 1)),
            prev: () => actions.pick(E.step(cfg.profile, -1)),
            volume: (v) => { cfg.volume = Math.round(Math.max(0, Math.min(1, v)) * 20) / 20; save(); },
            volUp: () => actions.volume(cfg.volume + VOLUME_STEP),
            volDown: () => actions.volume(cfg.volume - VOLUME_STEP),
            nextOutput: () => { cfg.output = OUTPUTS[(OUTPUTS.indexOf(cfg.output) + 1) % OUTPUTS.length]; huRetryAt = 0; save(); },
            nextRedline: () => { cfg.realRedline = M.nextIn(M.REAL_REDLINES, cfg.realRedline, 1); save(); },
            nextTorque: () => { cfg.maxTorque = M.nextIn(M.MAX_TORQUES, cfg.maxTorque, 1); save(); },
            exportWav: () => {
                if (exporting) return;
                exporting = true; exportText = ''; dirty = true;
                const p = profile();
                exportDrive(p, ctx.dataDir, tuneOf(p.id)).then((r) => {
                    exportText = path.basename(r.file) + ' (' + Math.round(r.bytes / 1048576 * 10) / 10 + ' MB)';
                    log.info('WAV export ' + r.file + ' ' + r.bytes + ' bytes');
                    say('Saved ' + path.basename(r.file));
                }, (e) => { exportText = 'Export failed: ' + e.message; log.warn('WAV export: ' + e.stack); })
                    .then(() => { exporting = false; dirty = true; });
            },
        };
        const safe = (fn) => () => { try { fn(); } catch (e) { say(String(e.message || e)); } dirty = true; };
        const a = {};
        Object.keys(actions).forEach((k) => { a[k] = safe(actions[k]); });
        a.pick = (id) => safe(() => actions.pick(id))();
        a.tuneStep = (key, d) => safe(() => actions.tuneStep(key, d))();

        // ---- phone link
        const server = new WebServer({
            state: () => {
                const d = car.data();
                return { ok: true, on: cfg.on, profile: cfg.profile, volume: cfg.volume, tune: tuneOf(),
                    rpm: Math.round(target.rpm), load: Math.round(target.load * 1000) / 1000,
                    running: target.running && (!target.demo || demoAudible()), demo: !!target.demo,
                    reason: target.reason, realRpm: typeof d.rpm === 'number' ? Math.round(d.rpm) : null,
                    speed: typeof d.speed === 'number' ? Math.round(d.speed) : null };
            },
            set: (body) => {
                if (typeof body.profile === 'string') actions.pick(body.profile);
                if (body.tuneReset === true) actions.tuneReset();
                if (body.tune && typeof body.tune === 'object' && !Array.isArray(body.tune)) actions.tune(body.tune);
                if (typeof body.volume === 'number' && isFinite(body.volume)) actions.volume(body.volume);
                if (typeof body.on === 'boolean' && body.on !== cfg.on) { cfg.on = body.on; save(); say(cfg.on ? 'Sound on (phone)' : 'Sound off (phone)'); }
                return { ok: true, on: cfg.on, profile: cfg.profile, volume: cfg.volume, tune: tuneOf() };
            },
        }, log);
        try { server.start(); } catch (e) { log.warn('phone server: ' + e.message); }

        // ---- 20 Hz: car -> virtual engine -> head unit player
        let lastPhone = false;
        setInterval(() => {
            const d = car.data(), was = target.running;
            target = M.map(d, profile(), cfg);
            if (was !== target.running) dirty = true;
            const on = sounding();
            player.set(target.rpm, target.load, on, cfg.volume);
            const now = Date.now();
            if (wantsHu() && on && !d.demo) {
                huStopAt = 0;
                if (!player.playing() && now >= huRetryAt) { huRetryAt = now + 15000; player.start(); }
            } else if (player.playing()) {
                if (!huStopAt) huStopAt = now + 800;              // let the fade-out play
                else if (now >= huStopAt) { huStopAt = 0; player.stop(); }
            }
            const ph = server.phoneConnected();
            if (ph !== lastPhone) { lastPhone = ph; dirty = true; say(ph ? 'Phone connected' : 'Phone disconnected'); }
        }, 50);
        setInterval(() => server.poll(), 1000);

        function rows() {
            const d = car.data(), r = [];
            const real = target.running
                ? Math.round(d.rpm) + ' rpm  -  ' + (typeof d.speed === 'number' ? Math.round(d.speed) : '--') + ' km/h  -  ' +
                  (target.loadSource === 'torque' ? Math.round(d.torque) + ' Nm' : target.loadSource === 'accel' ? 'load from accel.' : 'no torque signal')
                : target.reason;
            r.push({ name: target.demo ? 'Car (DEMO data)' : 'Car', value: real, state: target.running ? (target.demo ? 'warn' : 'ok') : 'off' });
            r.push({ name: 'Sound', value: !cfg.on ? 'Off' : sounding() ? 'On - following the engine' : target.demo ? 'On - silent with demo data' : 'On - waiting for the engine',
                state: !cfg.on ? 'off' : sounding() ? 'ok' : 'warn' });
            const ph = server.phoneConnected();
            r.push({ name: 'Phone', value: cfg.output === 'car' ? 'Not used (output: head unit)' : ph ? 'Connected - sound plays on the phone' : 'Not linked - see PHONE',
                state: cfg.output === 'car' ? 'off' : ph ? 'ok' : 'warn' });
            r.push({ name: 'Head unit audio', value: !wantsHu() ? 'Not used (output: phone)' : !huBackend ? 'Unavailable: no aplay / ffmpeg' :
                player.playing() ? 'Playing via ' + huBackend.name + ' (speakers not confirmed)' : player.detail || 'Ready (' + huBackend.name + ')',
                state: !wantsHu() ? 'off' : !huBackend || player.status === 'error' ? 'bad' : player.playing() ? 'ok' : 'warn' });
            return r;
        }
        function viewModel() {
            if (notice && Date.now() - noticeAt > 4000) notice = null;
            return {
                page, profile: profile(), on: cfg.on, volume: cfg.volume, cfg, tune: tuneOf(),
                rpm: target.rpm, load: target.load, running: target.running, demo: target.demo,
                audible: sounding(), rows: rows(), notice,
                huAvailable: !!huBackend, huBackend: huBackend ? huBackend.name : '',
                exporting, exportText,
                phone: { link: server.url(), listening: server.listening, error: server.error, net: server.net,
                    port: server.port, connected: server.phoneConnected() },
            };
        }

        const open = (i) => { page = i; notice = null; dirty = true; };
        if (typeof ctx.onTab === 'function') ctx.onTab((i) => { if (i >= 0 && i < 5) open(i); });
        ctx.ui.onClick('BTN_TOGGLE', a.toggle);
        ctx.ui.onClick('BTN_NEXT', a.next);
        ctx.ui.onClick('BTN_PREV', a.prev);
        ctx.ui.onClick('BTN_VOLUP', a.volUp);
        ctx.ui.onClick('BTN_VOLDN', a.volDown);
        ctx.ui.onClick('BTN_PAGE', () => open((page + 1) % 5));
        ctx.ui.onClick('BTN_EXPORT', a.exportWav);
        ctx.ui.onClick('BTN_TUNE_RESET', a.tuneReset);

        let lastDraw = 0;
        ctx.loop('MAIN', 15, () => {
            const now = Date.now();
            const animate = page === PAGE.SOUND && target.running;
            if (!animate && !dirty && now - lastDraw < 1000) return undefined;
            dirty = false; lastDraw = now;
            return ctx.ui.image('MAIN_GFX', ui.draw(ctx.canvas(W, H), ctx.theme(), viewModel(), a));
        });
        log.info('Active Sound started: ' + cfg.profile + ', sound ' + (cfg.on ? 'on' : 'off') + ', output ' + cfg.output);
    },
});
