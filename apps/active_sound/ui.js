'use strict';
/*
 * ui.js - everything Active Sound draws on the centre display (1600 x 520).
 * Pure drawing from a view model; main.js decides. Touch / iDrive targets are registered
 * through G.button / cv.target (left to right, top to bottom: the order the knob walks them).
 * ASCII only: the renderer's fonts have no arrows or umlauts.
 */
const qrcode = require('./qr_vendor');
const E = require('./engines');

const W = 1600, H = 520;
const TABS = ['Sound', 'Engines', 'Tune', 'Phone', 'Setup'];
const PAGE = { SOUND: 0, ENGINES: 1, TUNE: 2, PHONE: 3, SETUP: 4 };
const TOP = 52, EDGE = 24, FOOT_Y = 452, FOOT_H = 52;

function makeUi(G) {
    const withAlpha = G.withAlpha;
    const LIT = { literal: true };
    function ascii(v) { return String(v === undefined || v === null ? '' : v).replace(/[^\x20-\x7e]/g, '?'); }
    function fit(cv, value, size, width, opts) {
        const o = Object.assign({}, opts || {}, LIT);
        let s = ascii(value);
        if (cv.textWidth(s, size, o) <= width) return s;
        while (s.length > 1 && cv.textWidth(s + '...', size, o) > width) s = s.slice(0, -1);
        return s.trim() + '...';
    }
    function label(cv, text, x, y, size, color, width, opts) {
        const o = Object.assign({}, opts || {}, LIT);
        return cv.text(width ? fit(cv, text, size, width, o) : ascii(text), x, y, size, color, o);
    }
    function card(cv, x, y, w, h, fill) { cv.roundRect(x, y, w, h, 14, fill || withAlpha('#b4bccc', 0.07)); }
    function btn(cv, t, x, w, text, run, opts) { return G.button(cv, t, x, FOOT_Y, w, FOOT_H, text, run, Object.assign({ key: text }, opts || {})); }

    /* ---------------- Sound ---------------- */
    function tach(cv, t, vm, cx, cy, r) {
        const p = vm.profile, max = p.redline * 1.06;
        const ang = (v) => -135 + 270 * Math.max(0, Math.min(1, v / max));
        cv.arc(cx, cy, r - 18, r, -135, 135, t.track, { round: true });
        cv.arc(cx, cy, r - 18, r, ang(p.redline), 135, withAlpha(t.crit, 0.45), { round: true });
        const step = p.redline > 10000 ? 2000 : 1000;
        for (let v = 0; v <= max; v += step) {
            const a = ang(v) * Math.PI / 180, x0 = cx + Math.sin(a) * (r - 30), y0 = cy - Math.cos(a) * (r - 30);
            const x1 = cx + Math.sin(a) * (r - 44), y1 = cy - Math.cos(a) * (r - 44);
            cv.line(x0, y0, x1, y1, 3, v >= p.redline ? t.crit : t.tick);
            const lx = cx + Math.sin(a) * (r - 66), ly = cy - Math.cos(a) * (r - 66) + 7;
            if (v > 0) cv.text(String(v / 1000), lx, ly, 18, v >= p.redline ? t.crit : t.dim, { align: 'center', literal: true });
        }
        const live = vm.audible;
        if (vm.rpm > 1) cv.arc(cx, cy, r - 18, r, -135, ang(vm.rpm), vm.rpm >= p.redline * 0.97 ? t.crit : live ? t.accent2 : t.dim, { round: true });
        cv.text(vm.running ? String(Math.round(vm.rpm / 10) * 10) : '--', cx, cy + 12, 78, live ? t.text : t.dim, { align: 'center', font: 'bold', literal: true });
        cv.text('RPM', cx, cy + 48, 20, t.dim, { align: 'center', font: 'bold', spacing: 3, literal: true });
        // load bar
        const bw = 180, bx = cx - bw / 2, by = cy + 78;
        cv.roundRect(bx, by, bw, 12, 6, t.track);
        if (vm.running) cv.roundRect(bx, by, Math.max(12, bw * vm.load), 12, 6, t.sel || t.accent);
        cv.text('LOAD ' + (vm.running ? Math.round(vm.load * 100) + ' %' : '--'), cx, by + 40, 18, t.dim, { align: 'center', font: 'bold', spacing: 2, literal: true });
    }
    function statusRow(cv, t, x, y, w, name, value, state) {
        const c = state === 'ok' ? '#3ddc97' : state === 'warn' ? t.warn : state === 'bad' ? t.crit : t.dim;
        cv.circle(x + 8, y - 7, 6, c);
        label(cv, name, x + 26, y, 20, t.dim, 220);
        label(cv, value, x + 250, y, 21, t.text, w - 260);
    }
    function drawSound(cv, t, vm, a) {
        card(cv, EDGE, TOP, 600, FOOT_Y - TOP - 14);
        tach(cv, t, vm, EDGE + 300, TOP + 228, 196);
        const x = EDGE + 624, w = W - EDGE - x;
        card(cv, x, TOP, w, FOOT_Y - TOP - 14);
        label(cv, vm.profile.group.toUpperCase() + '  -  ' + E.spec(vm.profile).toUpperCase(), x + 28, TOP + 40, 16, t.dim, w - 56, { font: 'bold', spacing: 2 });
        label(cv, vm.profile.name, x + 28, TOP + 88, 42, t.text, w - 56, { font: 'bold' });
        label(cv, vm.profile.desc, x + 28, TOP + 126, 21, t.dim, w - 56);
        cv.fillRect(x + 28, TOP + 150, w - 56, 1, withAlpha('#ffffff', 0.12));
        const rows = vm.rows;
        rows.forEach((r, i) => statusRow(cv, t, x + 28, TOP + 194 + i * 46, w - 56, r.name, r.value, r.state));
        // footer
        let fx = EDGE;
        fx += btn(cv, t, fx, 300, vm.on ? 'Sound: on' : 'Sound: off', a.toggle, { primary: vm.on }) + 16;
        fx += btn(cv, t, fx, 170, '< Prev', a.prev) + 12;
        fx += btn(cv, t, fx, 170, 'Next >', a.next) + 28;
        fx += btn(cv, t, fx, 120, 'Vol -', a.volDown) + 12;
        if (cv.own) cv.text(Math.round(vm.volume * 100) + ' %', fx + 60, FOOT_Y + 35, 24, t.text, { align: 'center', font: 'bold', literal: true });
        fx += 132;
        btn(cv, t, fx, 120, 'Vol +', a.volUp);
        if (!cv.own) label(cv, 'Volume ' + Math.round(vm.volume * 100) + ' %', EDGE + 624 + 28, TOP + 376, 18, t.dim, 400);
    }

    /* ---------------- Engines ---------------- */
    function drawEngines(cv, t, vm, a) {
        const cols = 5, gap = 10, cw = (W - 2 * EDGE - (cols - 1) * gap) / cols, ch = 70;
        E.PROFILES.forEach((p, i) => {
            const c = i % cols, r = Math.floor(i / cols), x = EDGE + c * (cw + gap), y = TOP + r * (ch + 8);
            const on = p.id === vm.profile.id, S = t.sel || t.accent;
            cv.roundRect(x, y, cw, ch, 14, on ? withAlpha(S, 0.28) : withAlpha('#b4bccc', 0.07));
            if (on) cv.strokeRoundRect(x, y, cw, ch, 14, 2, S);
            const tuned = vm.cfg.tune && vm.cfg.tune[p.id];
            label(cv, p.name, x + 16, y + 31, 21, t.text, cw - 32, { font: 'bold' });
            label(cv, E.spec(p), x + 16, y + 57, 16, t.dim, tuned ? cw - 100 : cw - 32);
            if (tuned) label(cv, 'TUNED', x + cw - 16, y + 57, 14, t.accent2 || t.warn, 80, { align: 'right', font: 'bold', spacing: 1 });
            if (cv.target) cv.target(x, y, cw, ch, () => a.pick(p.id), 'ENG_' + p.id);
        });
        let fx = EDGE;
        fx += btn(cv, t, fx, 300, vm.on ? 'Sound: on' : 'Sound: off', a.toggle, { primary: vm.on }) + 16;
        fx += btn(cv, t, fx, 170, '< Prev', a.prev) + 12;
        btn(cv, t, fx, 170, 'Next >', a.next);
        label(cv, 'Tap an engine. It changes on the car and on a linked phone.', W - EDGE, FOOT_Y + 34, 18, t.dim, 760, { align: 'right' });
    }

    /* ---------------- Tune ---------------- */
    function pct(v) { return Math.round(v * 100) + ' %'; }
    function drawTune(cv, t, vm, a) {
        const keys = E.tuneKeys(vm.profile), tune = vm.tune || {}, S = t.sel || t.accent;
        const cols = 2, rowsPer = Math.ceil(keys.length / cols), gap = 16;
        const cw = (W - 2 * EDGE - gap) / cols, rh = Math.min(64, Math.floor((FOOT_Y - TOP - 12) / Math.max(1, rowsPer)));
        keys.forEach((c, i) => {
            const col = Math.floor(i / rowsPer), row = i % rowsPer;
            const x = EDGE + col * (cw + gap), y = TOP + row * rh, v = tune[c.key] === undefined ? 1 : tune[c.key];
            cv.roundRect(x, y, cw, rh - 8, 12, withAlpha('#b4bccc', 0.07));
            label(cv, c.name, x + 18, y + 25, 20, t.text, 230, { font: 'bold' });
            label(cv, c.desc, x + 18, y + 47, 14, t.dim, 300);
            // bar: 0..200 %, mark at 100 %
            const bx = x + 340, bw = cw - 340 - 210, by = y + 22;
            cv.roundRect(bx, by, bw, 12, 6, t.track);
            if (v > 0) cv.roundRect(bx, by, Math.max(12, bw * v / E.TUNE_MAX), 12, 6, v === 1 ? withAlpha(S, 0.6) : S);
            cv.fillRect(bx + bw / 2 - 1, by - 5, 2, 22, withAlpha('#ffffff', 0.5));
            label(cv, v === 0 ? 'Off' : pct(v), bx + bw / 2, by + 36, 14, v === 1 ? t.dim : t.text, 120, { align: 'center', font: 'bold' });
            G.button(cv, t, x + cw - 196, y + 6, 88, rh - 20, '-', () => a.tuneStep(c.key, -1), { key: 'T-' + c.key });
            G.button(cv, t, x + cw - 100, y + 6, 88, rh - 20, '+', () => a.tuneStep(c.key, 1), { key: 'T+' + c.key });
        });
        let fx = EDGE;
        fx += btn(cv, t, fx, 170, '< Prev', a.prev) + 12;
        fx += btn(cv, t, fx, 170, 'Next >', a.next) + 16;
        fx += btn(cv, t, fx, 220, 'Reset sound', a.tuneReset) + 24;
        label(cv, 'Tuning: ' + vm.profile.name + '  -  100 % = as designed, saved per engine', W - EDGE, FOOT_Y + 34, 18, t.dim, W - EDGE - fx, { align: 'right' });
    }

    /* ---------------- Phone ---------------- */
    function qr(cv, t, link, x, y, size) {
        let code = null;
        if (link) try { code = qrcode(0, 'M'); code.addData(link); code.make(); } catch (_) { code = null; }
        cv.roundRect(x, y, size, size, 14, code ? '#ffffff' : withAlpha('#000000', 0.45));
        if (!code) { cv.text('NO LINK', x + size / 2, y + size / 2, 22, t.warn, { align: 'center', font: 'bold', literal: true }); return; }
        const n = code.getModuleCount(), quiet = 3, cell = Math.floor(size / (n + quiet * 2)), span = cell * (n + quiet * 2);
        const ox = x + Math.floor((size - span) / 2), oy = y + Math.floor((size - span) / 2);
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
            if (code.isDark(r, c)) cv.fillRect(ox + (c + quiet) * cell, oy + (r + quiet) * cell, cell, cell, '#05070a');
    }
    function drawPhone(cv, t, vm) {
        const ph = vm.phone, size = 330;
        card(cv, EDGE, TOP, size + 48, FOOT_Y + FOOT_H - TOP);
        qr(cv, t, ph.listening ? ph.link : null, EDGE + 24, TOP + 22, size);
        label(cv, ph.listening ? 'Scan with the phone camera' : 'Phone server not running', EDGE + 24 + size / 2, TOP + size + 60, 18,
            ph.listening ? t.text : t.warn, size, { align: 'center' });
        const x = EDGE + size + 72, w = W - EDGE - x;
        card(cv, x, TOP, w, FOOT_Y + FOOT_H - TOP);
        label(cv, 'ENGINE SOUND FROM YOUR PHONE', x + 28, TOP + 40, 16, t.dim, w - 56, { font: 'bold', spacing: 2 });
        const steps = [
            { ok: ph.listening, text: ph.listening ? 'App listens on port ' + ph.port : 'Port ' + ph.port + ': ' + (ph.error || 'starting') },
            { ok: ph.net.ready, warn: !ph.net.known, text: ph.net.ready ? 'Car Wi-Fi port open (mgu-sound-net)' : ph.net.known ? 'Port helper: ' + (ph.net.error || 'waiting') : 'Port helper mgu-sound-net not running - install it in MGU Store' },
            { ok: ph.connected, warn: !ph.connected, text: ph.connected ? 'Phone connected' : 'Phone on the car Wi-Fi, scan the code, keep the page open' },
            { ok: ph.connected, warn: true, text: 'On the phone: tap START SOUND. CarPlay or Bluetooth audio plays it in the car' },
        ];
        steps.forEach((s, i) => {
            const y = TOP + 92 + i * 56, c = s.ok ? '#3ddc97' : s.warn ? t.warn : t.crit;
            cv.circle(x + 44, y - 8, 16, withAlpha(c, 0.18));
            cv.text(String(i + 1), x + 44, y, 20, c, { align: 'center', font: 'bold', literal: true });
            label(cv, s.text, x + 76, y, 22, s.ok ? t.text : t.dim, w - 110);
        });
        label(cv, ph.link, x + 28, TOP + 340, 18, t.dim, w - 56);
        label(cv, 'The phone makes the sound itself (same synthesizer). The car only sends rpm and load.', x + 28, TOP + 380, 18, t.dim, w - 56);
        label(cv, 'No data for 1.5 s: the phone fades out. Keep the volume moderate.', x + 28, TOP + 410, 18, t.dim, w - 56);
    }

    /* ---------------- Setup ---------------- */
    function setRow(cv, t, y, name, value, note, text, run, key, opts) {
        label(cv, name, EDGE + 28, y, 22, t.text, 300, { font: 'bold' });
        label(cv, value, EDGE + 340, y, 22, t.accent2 || t.text, 300, { font: 'bold' });
        label(cv, note, EDGE + 640, y, 18, t.dim, 640);
        G.button(cv, t, W - EDGE - 230, y - 33, 210, 46, text, run, Object.assign({ key }, opts || {}));
    }
    function drawSetup(cv, t, vm, a) {
        card(cv, EDGE, TOP, W - 2 * EDGE, FOOT_Y + FOOT_H - TOP);
        const c = vm.cfg, OUT = { phone: 'Phone', car: 'Head unit', both: 'Phone + head unit' };
        const R = (i) => TOP + 46 + i * 58;
        setRow(cv, t, R(0), 'Character', c.character === 'detailed' ? 'Detailed' : 'Subtle (factory ASD)',
            c.character === 'detailed' ? 'Full exhaust sound with crackle and rasp' : 'Low engine orders only, underneath, grows with load', 'Change', a.nextCharacter, 'S_CHAR');
        setRow(cv, t, R(1), 'Sound output', OUT[vm.output || c.output] || c.output,
            vm.huAvailable ? 'Head unit via ' + vm.huBackend + ' (only while no music plays there)' : 'Head unit needs the tool Active Sound PCM Output', 'Change', a.nextOutput, 'S_OUT');
        setRow(cv, t, R(2), 'Real redline', c.realRedline + ' rpm', 'Your engine\'s top rpm. 318d / diesel: 5000', 'Change', a.nextRedline, 'S_RED');
        setRow(cv, t, R(3), 'Max torque', c.maxTorque + ' Nm', 'Full load at this torque. 318d: 400 Nm', 'Change', a.nextTorque, 'S_TQ');
        setRow(cv, t, R(4), 'Demo drive WAV', vm.exporting ? 'Rendering...' : vm.exportText ? 'Saved' : '30 s, ' + vm.profile.short,
            vm.exportText || 'Writes active-sound-<engine>.wav to the app data folder', 'Export', a.exportWav, 'S_WAV', { busy: vm.exporting });
        const ht = vm.huTest || {};
        setRow(cv, t, R(5), 'Head unit test', ht.busy ? 'Checking...' : ht.text ? 'Done' : 'Read only',
            ht.text || 'Lists BMW media sources, checks which one Active Sound could use', 'Test', a.huTest, 'S_HUT', { busy: ht.busy });
        cv.fillRect(EDGE + 28, TOP + 410, W - 2 * EDGE - 56, 1, withAlpha('#ffffff', 0.12));
        label(cv, 'Load = torque / max torque. Engine off or no fresh rpm for 5 s: silence. Original synthesized sounds, no recordings.', EDGE + 28, TOP + 440, 17, t.dim, W - 2 * EDGE - 56);
    }

    function draw(cv, t, vm, a) {
        cv.clear(t.bg);
        if (vm.page === PAGE.SOUND) drawSound(cv, t, vm, a);
        else if (vm.page === PAGE.ENGINES) drawEngines(cv, t, vm, a);
        else if (vm.page === PAGE.TUNE) drawTune(cv, t, vm, a);
        else if (vm.page === PAGE.PHONE) drawPhone(cv, t, vm, a);
        else drawSetup(cv, t, vm, a);
        const badges = [vm.demo ? { text: 'DEMO', color: t.warn } : null, vm.audible ? { text: 'LIVE', color: '#3ddc97' } : null];
        G.frame(cv, t, TABS, vm.page, badges);
        if (vm.notice) {      // toast in the free part of the tab bar, between the tabs and the badges
            const cx = 1000, w = Math.min(640, cv.textWidth(ascii(vm.notice), 19, LIT) + 48);
            cv.roundRect(cx - w / 2, 3, w, 30, 15, withAlpha(t.sel || t.accent, 0.25));
            label(cv, vm.notice, cx, 24, 19, t.text, w - 32, { align: 'center' });
        }
        return cv;
    }
    return { draw, ascii };
}

module.exports = { makeUi, TABS, PAGE, W, H };
